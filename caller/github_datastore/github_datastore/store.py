from __future__ import annotations

import json
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Iterator

from . import views
from .db import (
    add_user,
    assert_no_duplicate_items,
    clear_index,
    connect,
    get_state,
    init_db,
    list_users,
    prune_items_for_repo,
    prune_repos,
    replace_associations,
    replace_child_rows,
    refresh_fts,
    set_state,
    upsert_expanded_item,
    upsert_repo,
    utc_now,
)
from .extract import extract_associations
from .github_api import GitHubClient, GitHubOrgReader, parse_graphql_datetime


FULL_BUILD_COMPLETE_KEY = "full_build_complete"
FULL_BUILD_MARKERS_INITIALIZED_KEY = "full_build_markers_v1_initialized"
FULL_BUILD_RETRY_KEY = "full_build_retry_required"
INITIALIZATION_KEY = "initialization_v1"


def init_org(
    org: str,
    db_path: str | Path,
    workers: int = 8,
    include_repos: list[str] | None = None,
    exclude_repos: list[str] | None = None,
    resume: bool = False,
) -> None:
    if workers <= 0:
        raise ValueError("workers must be positive")
    validate_repo_filter(include_repos, exclude_repos)
    conn = connect(db_path)
    reader = GitHubOrgReader(GitHubClient())
    run_started = utc_now()
    try:
        init_db(conn)
        prior = (
            initialization_to_resume(conn, org, include_repos, exclude_repos)
            if resume else None
        )
        all_repos = reader.list_org_repos(org)
        if prior and get_state(conn, "org", INITIALIZATION_KEY) is None:
            verify_legacy_initialization_filter(conn, all_repos, prior)
        repos = (
            apply_sync_repo_filter(conn, all_repos, None, None)
            if prior else apply_repo_filter(all_repos, include_repos, exclude_repos)
        )
        if not repos:
            raise RuntimeError(f"org has no visible repos: {org}")

        state = {
            "status": "building",
            "started_at": prior["started_at"] if prior and prior["status"] == "building" else run_started,
            "filter": initialization_filter(include_repos, exclude_repos),
            "filter_repo_ids": (
                prior["filter_repo_ids"] if prior
                else repo_filter_ids(all_repos, include_repos or exclude_repos)
                if include_repos or exclude_repos else []
            ),
        }
        with conn:
            if not prior:
                clear_index(conn)
                set_state(conn, "org", "login", org)
                store_repo_filter(conn, include_repos, exclude_repos, all_repos)
            # A partial initialization must never appear healthy, including when
            # resuming a completed staging database after publication failed.
            conn.execute(
                "DELETE FROM sync_state WHERE scope = 'org' AND key IN (?, ?)",
                ("last_sync_at", "last_full_build_at"),
            )
            set_state(conn, "org", INITIALIZATION_KEY, json.dumps(state, sort_keys=True))
            set_state(conn, "org", FULL_BUILD_MARKERS_INITIALIZED_KEY, "1")
            for repo in repos:
                upsert_repo(conn, repo)
                clear_full_build_marker(conn, int(repo["id"]))
            prune_repos(conn, [int(repo["id"]) for repo in repos])
            users = list_users(conn)

        # Re-list on every attempt: a saved expansion is reusable only when its
        # current identity and timestamp still match. This also removes deletions.
        for repo in repos:
            repo_id = int(repo["id"])
            if not repo.get("has_issues"):
                with conn:
                    prune_items_for_repo(conn, repo_id, [])
                continue
            all_issues = reader.list_repo_issues(repo["full_name"])
            issues = items_requiring_full_refresh(conn, repo_id, repo["full_name"], all_issues)
            with conn:
                prune_items_for_repo(conn, repo_id, [int(issue["id"]) for issue in all_issues])
            for expanded in iter_expanded(reader, repo, issues, workers):
                store_expanded(conn, expanded, users)
            with conn:
                mark_full_build_completed(conn, repo_id)

        # A long or interrupted build can outlive its first enumerations. Catch
        # up from the original start before publishing completion or freshness.
        catchup_started = utc_now()
        active_repos = [repo for repo in repos if repo.get("has_issues")]
        changed = changed_items_for_repos(reader, conn, active_repos, state["started_at"])
        for repo in active_repos:
            issues = items_requiring_full_refresh(
                conn, int(repo["id"]), repo["full_name"], changed[repo["full_name"]]
            )
            for expanded in iter_expanded(reader, repo, issues, workers):
                store_expanded(conn, expanded, users)

        with conn:
            assert_no_duplicate_items(conn)
            state["status"] = "complete"
            set_state(conn, "org", INITIALIZATION_KEY, json.dumps(state, sort_keys=True))
            set_state(conn, "org", "last_full_build_at", utc_now())
            set_state(conn, "org", "last_sync_at", catchup_started)
    finally:
        conn.close()


def initialization_filter(
    include_repos: list[str] | None, exclude_repos: list[str] | None
) -> dict[str, Any]:
    mode = "include" if include_repos else "exclude" if exclude_repos else "all"
    return {"mode": mode, "values": sorted(set(normalize_repo_names(include_repos or exclude_repos or [])))}


def initialization_to_resume(
    conn: sqlite3.Connection,
    org: str,
    include_repos: list[str] | None,
    exclude_repos: list[str] | None,
) -> dict[str, Any] | None:
    stored_org = get_state(conn, "org", "login")
    if stored_org is None:
        data_tables = (
            "repos", "items", "sync_state", "events", "comments", "reviews",
            "review_comments", "pr_commits", "associations", "item_fts", "users",
        )
        if any(conn.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone() for table in data_tables):
            raise RuntimeError("cannot resume initialization: database has data without an owner")
        return None
    if stored_org.casefold() != org.casefold():
        raise RuntimeError(f"cannot resume initialization for {org}: database belongs to {stored_org}")
    raw = get_state(conn, "org", INITIALIZATION_KEY)
    stored_ids = get_state(conn, "repo_filter", "repo_ids")
    filter_ids = initialization_filter_ids(stored_ids)
    legacy = raw is None
    try:
        # Old initializers persisted expansions and per-repo markers before
        # failing, but no org completion timestamps. Adopt only that state.
        state = json.loads(raw) if raw is not None else {
            "status": "building",
            "started_at": utc_now(),
            "filter": initialization_filter(include_repos, exclude_repos),
            "filter_repo_ids": filter_ids,
        }
    except (TypeError, ValueError) as error:
        raise RuntimeError("invalid initialization resume state") from error
    if (
        not isinstance(state, dict)
        or set(state) != {"status", "started_at", "filter", "filter_repo_ids"}
        or not isinstance(state["status"], str)
        or state["status"] not in {"building", "complete"}
        or not isinstance(state["started_at"], str)
    ):
        raise RuntimeError("missing or invalid initialization resume state")
    parse_graphql_datetime(state["started_at"], "initialization start")
    expected_filter = initialization_filter(include_repos, exclude_repos)
    if state["filter"] != expected_filter:
        raise RuntimeError("cannot resume initialization with a different repo filter")
    checkpoint_ids = state["filter_repo_ids"]
    if (
        not isinstance(checkpoint_ids, list)
        or any(type(repo_id) is not int or repo_id <= 0 for repo_id in checkpoint_ids)
        or checkpoint_ids != sorted(set(checkpoint_ids))
        or checkpoint_ids != filter_ids
    ):
        raise RuntimeError("initialization repo filter ids do not match the checkpoint")
    stored_mode = get_state(conn, "repo_filter", "mode")
    stored_values = get_state(conn, "repo_filter", "values")
    if expected_filter["mode"] == "all":
        valid_filter = stored_mode is None and stored_values is None and stored_ids is None
    else:
        valid_filter = (
            stored_mode == expected_filter["mode"]
            and stored_values is not None
            and sorted(set(stored_values.split(","))) == expected_filter["values"]
            and bool(filter_ids)
        )
    if not valid_filter:
        raise RuntimeError("invalid stored initialization repo filter")
    marker = get_state(conn, "org", FULL_BUILD_MARKERS_INITIALIZED_KEY)
    if marker != "1" and not (legacy and marker is None):
        raise RuntimeError("invalid initialization full-build marker state")
    for key in ("last_sync_at", "last_full_build_at"):
        value = get_state(conn, "org", key)
        if state["status"] == "building" and value is not None:
            raise RuntimeError("incomplete initialization has completion timestamps")
        if state["status"] == "complete":
            parse_graphql_datetime(value, f"completed initialization {key}")
    for repo in conn.execute("SELECT repo_id, owner, full_name, has_issues FROM repos"):
        if repo["owner"].casefold() != org.casefold() or repo["full_name"].split("/", 1)[0].casefold() != org.casefold():
            raise RuntimeError("initialization database contains a different repository owner")
        complete = full_build_completed(conn, int(repo["repo_id"]))
        if state["status"] == "complete" and repo["has_issues"] and not complete:
            raise RuntimeError("completed initialization has an incomplete repository")
        if full_build_retry_required(conn, int(repo["repo_id"])):
            raise RuntimeError("initialization has pending reconciliation state")
    if conn.execute("PRAGMA foreign_key_check").fetchone() is not None:
        raise RuntimeError("initialization database has broken foreign keys")
    for item in conn.execute("SELECT * FROM items"):
        try:
            expanded = json.loads(item["expanded_json"])
            identity_matches = (
                expanded["repo"]["id"] == item["repo_id"]
                and expanded["repo"]["full_name"] == item["repo_full_name"]
                and expanded["repo"]["owner"]["login"].casefold() == org.casefold()
                and expanded["issue"]["id"] == item["item_id"]
                and expanded["issue"]["node_id"] == item["node_id"]
                and expanded["issue"]["number"] == item["number"]
                and expanded["issue"]["updated_at"] == item["updated_at"]
                and ("pr" if expanded["is_pr"] else "issue") == item["item_type"]
            )
        except (ValueError, TypeError, KeyError, AttributeError) as error:
            raise RuntimeError(f"invalid stored expansion for item {item['item_id']}") from error
        if not identity_matches:
            raise RuntimeError(f"stored expansion identity mismatch for item {item['item_id']}")
        parse_graphql_datetime(item["updated_at"], f"stored item {item['item_id']}")
    return state


def initialization_filter_ids(raw: str | None) -> list[int]:
    if raw is None:
        return []
    try:
        parts = raw.split(",")
        repo_ids = [int(value) for value in parts]
    except ValueError as error:
        raise RuntimeError("invalid stored initialization repo ids") from error
    if (
        any(repo_id <= 0 for repo_id in repo_ids)
        or [str(repo_id) for repo_id in repo_ids] != parts
        or repo_ids != sorted(set(repo_ids))
    ):
        raise RuntimeError("invalid stored initialization repo ids")
    return repo_ids


def verify_legacy_initialization_filter(
    conn: sqlite3.Connection,
    repos: list[dict[str, Any]],
    state: dict[str, Any],
) -> None:
    if state["filter"]["mode"] == "all":
        return
    # A legacy checkpoint did not bind the filter's IDs. Require evidence
    # connecting its declared names to those IDs before trusting either value.
    identities = list(repos)
    identities.extend(
        {"id": int(row["repo_id"]), "name": row["name"], "full_name": row["full_name"]}
        for row in conn.execute("SELECT repo_id, name, full_name FROM repos")
    )
    resolved_ids = repo_filter_ids(identities, state["filter"]["values"])
    if resolved_ids != state["filter_repo_ids"]:
        raise RuntimeError("legacy initialization repo filter identities do not match stored ids")


def changed_items_for_repos(
    reader: GitHubOrgReader,
    conn: sqlite3.Connection,
    repos: list[dict[str, Any]],
    since: str | None,
) -> dict[str, list[dict[str, Any]]]:
    if not repos:
        return {}
    names = [repo["full_name"] for repo in repos]
    changed = reader.list_repos_changed_items(
        names,
        since,
        {repo["full_name"]: stored_pr_updated_at_by_id(conn, int(repo["id"])) for repo in repos},
    )
    if set(changed) != set(names):
        raise RuntimeError("changed-item batch does not cover the requested repositories")
    return changed


def build_user(username: str, db_path: str | Path) -> None:
    conn = connect(db_path)
    try:
        init_db(conn)
        rows = conn.execute("SELECT item_id, expanded_json FROM items ORDER BY repo_full_name, number").fetchall()
        if not rows:
            raise RuntimeError("no indexed items; run init-org first")
        with conn:
            add_user(conn, username)
            for row in rows:
                expanded = json.loads(row["expanded_json"])
                associations = extract_associations(expanded, username)
                replace_associations(conn, int(row["item_id"]), username, associations)
            assert_no_duplicate_items(conn)
    finally:
        conn.close()


def sync_once(
    db_path: str | Path,
    workers: int = 8,
    include_repos: list[str] | None = None,
    exclude_repos: list[str] | None = None,
    reconcile: bool = False,
    reconcile_sleep: float = 0.0,
) -> None:
    if workers <= 0:
        raise ValueError("workers must be positive")
    if reconcile_sleep < 0:
        raise ValueError("reconcile sleep cannot be negative")
    validate_repo_filter(include_repos, exclude_repos)
    conn = connect(db_path)
    reader = GitHubOrgReader(GitHubClient())
    run_started = utc_now()
    try:
        init_db(conn)
        org = get_state(conn, "org", "login")
        if not org:
            raise RuntimeError("org is not initialized; run init-org first")
        initialization = get_state(conn, "org", INITIALIZATION_KEY)
        if initialization is not None:
            try:
                initialization_status = json.loads(initialization)["status"]
            except (ValueError, TypeError, KeyError) as error:
                raise RuntimeError("invalid initialization state") from error
            if initialization_status != "complete":
                raise RuntimeError("initialization is incomplete; run init-org --resume first")
        with conn:
            initialize_full_build_markers(conn)
        since = get_state(conn, "org", "last_sync_at")
        repos = reader.list_org_repos(org)
        repos = apply_sync_repo_filter(conn, repos, include_repos, exclude_repos)
        users = list_users(conn)
        known_repos = {
            int(row["repo_id"]): (bool(row["has_issues"]), str(row["full_name"]))
            for row in conn.execute("SELECT repo_id, has_issues, full_name FROM repos")
        }

        with conn:
            for repo in repos:
                repo_id = int(repo["id"])
                prior_repo = known_repos.get(repo_id)
                if (
                    repo.get("has_issues")
                    and (
                        prior_repo is None
                        or not prior_repo[0]
                        or prior_repo[1] != repo["full_name"]
                    )
                ):
                    clear_full_build_marker(conn, repo_id)
                upsert_repo(conn, repo)
            prune_repos(conn, [int(repo["id"]) for repo in repos])
            if reconcile:
                for repo in repos:
                    if repo.get("has_issues"):
                        repo_id = int(repo["id"])
                        clear_full_build_marker(conn, repo_id)
                        mark_full_build_retry(conn, repo_id)

        incremental_repos = [
            repo for repo in repos
            if repo.get("has_issues")
            and not reconcile
            and full_build_completed(conn, int(repo["id"]))
            and not full_build_retry_required(conn, int(repo["id"]))
        ]
        changed = changed_items_for_repos(reader, conn, incremental_repos, since)

        for repo in repos:
            repo_id = int(repo["id"])
            prior_repo = known_repos.get(repo_id)
            if not repo.get("has_issues"):
                with conn:
                    prune_items_for_repo(conn, repo_id, [])
                    clear_full_build_marker(conn, repo_id)
                    clear_full_build_retry(conn, repo_id)
                continue
            retry_full_build = full_build_retry_required(conn, repo_id)
            requires_initial_full = (
                prior_repo is None
                or not prior_repo[0]
                or prior_repo[1] != repo["full_name"]
                or not full_build_completed(conn, repo_id)
            )
            full_enumeration = reconcile or retry_full_build or requires_initial_full
            if full_enumeration:
                with conn:
                    clear_full_build_marker(conn, repo_id)
                all_issues = reader.list_repo_issues(repo["full_name"])
                issues = (
                    all_issues
                    if reconcile or retry_full_build
                    else items_requiring_full_refresh(
                        conn, repo_id, repo["full_name"], all_issues
                    )
                )
                with conn:
                    prune_items_for_repo(
                        conn, repo_id, [int(issue["id"]) for issue in all_issues]
                    )
            else:
                issues = changed[repo["full_name"]]
            for expanded in iter_expanded(reader, repo, issues, workers):
                store_expanded(conn, expanded, users)
                if reconcile_sleep:
                    time.sleep(reconcile_sleep)
            if full_enumeration:
                with conn:
                    mark_full_build_completed(conn, repo_id)

        with conn:
            if reconcile:
                set_state(conn, "org", "last_reconcile_at", run_started)
            else:
                set_state(conn, "org", "last_sync_at", run_started)
            assert_no_duplicate_items(conn)
    finally:
        conn.close()


def stored_pr_updated_at_by_id(conn: sqlite3.Connection, repo_id: int) -> dict[int, str]:
    rows = conn.execute(
        "SELECT item_id, updated_at FROM items WHERE repo_id = ? AND item_type = 'pr'",
        (repo_id,),
    ).fetchall()
    return {int(row["item_id"]): str(row["updated_at"]) for row in rows}


def items_requiring_full_refresh(
    conn: sqlite3.Connection,
    repo_id: int,
    repo_full_name: str,
    items: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    stored = {
        int(row["item_id"]): row
        for row in conn.execute(
            """
            SELECT item_id, repo_full_name, number, item_type, updated_at
            FROM items
            WHERE repo_id = ?
            """,
            (repo_id,),
        )
    }
    refresh: list[dict[str, Any]] = []
    for item in items:
        item_id = int(item["id"])
        row = stored.get(item_id)
        if row is None:
            refresh.append(item)
            continue
        current_at = parse_graphql_datetime(
            item.get("updated_at"), f"item {item_id} for {repo_full_name}"
        )
        stored_at = parse_graphql_datetime(
            row["updated_at"], f"stored item {item_id} for {repo_full_name}"
        )
        if current_at < stored_at:
            raise RuntimeError(
                f"item timestamp moved backward for {repo_full_name}: {item_id}"
            )
        if (
            current_at > stored_at
            or int(row["number"]) != int(item["number"])
            or str(row["item_type"]) != item["item_kind"]
            or str(row["repo_full_name"]) != repo_full_name
        ):
            refresh.append(item)
    return refresh


def repo_state_scope(repo_id: int) -> str:
    return f"repo:{repo_id}"


def full_build_completed(conn: sqlite3.Connection, repo_id: int) -> bool:
    value = get_state(conn, repo_state_scope(repo_id), FULL_BUILD_COMPLETE_KEY)
    if value is None:
        return False
    if value != "1":
        raise RuntimeError(f"invalid full-build marker for repo {repo_id}: {value!r}")
    return True


def mark_full_build_completed(conn: sqlite3.Connection, repo_id: int) -> None:
    set_state(conn, repo_state_scope(repo_id), FULL_BUILD_COMPLETE_KEY, "1")
    clear_full_build_retry(conn, repo_id)


def clear_full_build_marker(conn: sqlite3.Connection, repo_id: int) -> None:
    conn.execute(
        "DELETE FROM sync_state WHERE scope = ? AND key = ?",
        (repo_state_scope(repo_id), FULL_BUILD_COMPLETE_KEY),
    )


def full_build_retry_required(conn: sqlite3.Connection, repo_id: int) -> bool:
    value = get_state(conn, repo_state_scope(repo_id), FULL_BUILD_RETRY_KEY)
    if value is None:
        return False
    if value != "1":
        raise RuntimeError(f"invalid full-build retry state for repo {repo_id}: {value!r}")
    return True


def mark_full_build_retry(conn: sqlite3.Connection, repo_id: int) -> None:
    set_state(conn, repo_state_scope(repo_id), FULL_BUILD_RETRY_KEY, "1")


def clear_full_build_retry(conn: sqlite3.Connection, repo_id: int) -> None:
    conn.execute(
        "DELETE FROM sync_state WHERE scope = ? AND key = ?",
        (repo_state_scope(repo_id), FULL_BUILD_RETRY_KEY),
    )


def initialize_full_build_markers(conn: sqlite3.Connection) -> None:
    value = get_state(conn, "org", FULL_BUILD_MARKERS_INITIALIZED_KEY)
    if value is not None:
        if value != "1":
            raise RuntimeError(f"invalid full-build marker migration state: {value!r}")
        return

    set_state(conn, "org", FULL_BUILD_MARKERS_INITIALIZED_KEY, "1")


def sync_loop(
    db_path: str | Path,
    interval_seconds: int,
    workers: int = 8,
    include_repos: list[str] | None = None,
    exclude_repos: list[str] | None = None,
    reconcile: bool = False,
    reconcile_sleep: float = 0.0,
) -> None:
    if interval_seconds <= 0:
        raise ValueError("interval must be positive")
    while True:
        sync_once(
            db_path,
            workers=workers,
            include_repos=include_repos,
            exclude_repos=exclude_repos,
            reconcile=reconcile,
            reconcile_sleep=reconcile_sleep,
        )
        time.sleep(interval_seconds)


def store_expanded(
    conn: sqlite3.Connection, expanded: dict[str, Any], users: list[str] | None = None
) -> int:
    with conn:
        item_id = upsert_expanded_item(conn, expanded)
        replace_child_rows(conn, item_id, expanded)
        refresh_fts(conn, item_id, expanded)
        for username in users or list_users(conn):
            associations = extract_associations(expanded, username)
            replace_associations(conn, item_id, username, associations)
    return item_id


def iter_expanded(
    reader: GitHubOrgReader, repo: dict[str, Any], issues: list[dict[str, Any]], workers: int
) -> Iterator[dict[str, Any]]:
    if workers == 1 or len(issues) <= 1:
        for issue in issues:
            yield reader.expand_issue_or_pr(repo, issue)
        return

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(reader.expand_issue_or_pr, repo, issue): issue["number"] for issue in issues
        }
        try:
            for future in as_completed(futures):
                yield future.result()
        finally:
            # Stop queued work immediately after a quota failure (or a consumer
            # error); the context manager waits only for already-running calls.
            for future in futures:
                future.cancel()


def validate_repo_filter(
    include_repos: list[str] | None, exclude_repos: list[str] | None
) -> None:
    if include_repos and exclude_repos:
        raise ValueError("include-repos and exclude-repos are mutually exclusive")


def apply_repo_filter(
    repos: list[dict[str, Any]],
    include_repos: list[str] | None,
    exclude_repos: list[str] | None,
) -> list[dict[str, Any]]:
    validate_repo_filter(include_repos, exclude_repos)
    if not include_repos and not exclude_repos:
        return repos
    index = repo_filter_index(repos)
    selected = normalize_repo_names(include_repos or exclude_repos or [])
    unknown = sorted(name for name in selected if name not in index)
    if unknown:
        raise RuntimeError(f"repo filter references unknown repos: {', '.join(unknown)}")
    if include_repos:
        return [repo for repo in repos if repo_key(repo) in selected or repo_full_key(repo) in selected]
    return [repo for repo in repos if repo_key(repo) not in selected and repo_full_key(repo) not in selected]


def store_repo_filter(
    conn: sqlite3.Connection,
    include_repos: list[str] | None,
    exclude_repos: list[str] | None,
    repos: list[dict[str, Any]],
) -> None:
    if include_repos:
        set_state(conn, "repo_filter", "mode", "include")
        set_state(conn, "repo_filter", "values", ",".join(normalize_repo_names(include_repos)))
        repo_ids = repo_filter_ids(repos, include_repos)
        set_state(conn, "repo_filter", "repo_ids", ",".join(str(repo_id) for repo_id in repo_ids))
    elif exclude_repos:
        set_state(conn, "repo_filter", "mode", "exclude")
        set_state(conn, "repo_filter", "values", ",".join(normalize_repo_names(exclude_repos)))
        repo_ids = repo_filter_ids(repos, exclude_repos)
        set_state(conn, "repo_filter", "repo_ids", ",".join(str(repo_id) for repo_id in repo_ids))


def apply_sync_repo_filter(
    conn: sqlite3.Connection,
    repos: list[dict[str, Any]],
    include_repos: list[str] | None,
    exclude_repos: list[str] | None,
) -> list[dict[str, Any]]:
    if include_repos or exclude_repos:
        return apply_repo_filter(repos, include_repos, exclude_repos)
    mode = get_state(conn, "repo_filter", "mode")
    values = get_state(conn, "repo_filter", "values")
    if mode is None and values is None:
        return repos
    if mode not in {"include", "exclude"} or not values:
        raise RuntimeError(f"invalid stored repo filter: mode={mode!r}, values={values!r}")

    raw_repo_ids = get_state(conn, "repo_filter", "repo_ids")
    if raw_repo_ids is None:
        legacy_repos = list(repos)
        legacy_repos.extend(
            {
                "id": int(row["repo_id"]),
                "name": str(row["name"]),
                "full_name": str(row["full_name"]),
            }
            for row in conn.execute("SELECT repo_id, name, full_name FROM repos")
        )
        selected_ids = repo_filter_ids(legacy_repos, values.split(","))
        set_state(
            conn,
            "repo_filter",
            "repo_ids",
            ",".join(str(repo_id) for repo_id in selected_ids),
        )
    else:
        try:
            selected_ids = sorted({int(value) for value in raw_repo_ids.split(",") if value})
        except ValueError as error:
            raise RuntimeError(f"invalid stored repo ids: {raw_repo_ids!r}") from error
        if not selected_ids or any(repo_id <= 0 for repo_id in selected_ids):
            raise RuntimeError(f"invalid stored repo ids: {raw_repo_ids!r}")

    visible_ids = {int(repo["id"]) for repo in repos}
    unavailable = sorted(set(selected_ids) - visible_ids)
    if unavailable:
        raise RuntimeError(f"repo filter references unavailable repo ids: {unavailable}")
    if mode == "include":
        return [repo for repo in repos if int(repo["id"]) in selected_ids]
    return [repo for repo in repos if int(repo["id"]) not in selected_ids]


def repo_filter_ids(repos: list[dict[str, Any]], selected_repos: list[str]) -> list[int]:
    index: dict[str, int] = {}
    for repo in repos:
        repo_id = int(repo["id"])
        for key in (repo_key(repo), repo_full_key(repo)):
            prior_id = index.get(key)
            if prior_id is not None and prior_id != repo_id:
                raise RuntimeError(f"ambiguous repo filter name: {key}")
            index[key] = repo_id
    selected = normalize_repo_names(selected_repos)
    unknown = sorted(name for name in selected if name not in index)
    if unknown:
        raise RuntimeError(f"repo filter references unknown repos: {', '.join(unknown)}")
    return sorted({index[name] for name in selected})


def repo_filter_index(repos: list[dict[str, Any]]) -> set[str]:
    keys: set[str] = set()
    for repo in repos:
        keys.add(repo_key(repo))
        keys.add(repo_full_key(repo))
    return keys


def normalize_repo_names(repos: list[str]) -> list[str]:
    return [repo.strip().lower() for repo in repos if repo.strip()]


def repo_key(repo: dict[str, Any]) -> str:
    return str(repo["name"]).lower()


def repo_full_key(repo: dict[str, Any]) -> str:
    return str(repo["full_name"]).lower()
