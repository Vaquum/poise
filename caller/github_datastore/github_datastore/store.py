from __future__ import annotations

import json
import logging
import math
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import closing
from pathlib import Path
from typing import Any, Callable, Iterator

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
    prune_missing_pulls,
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
from .github_api import (
    ITEM_GRAPH_BATCH_SIZE,
    GitHubApiError,
    GitHubOrgReader,
    GitHubRateLimitError,
    ItemGraphError,
    PartialItemInventory,
    PartialRepositoryInventory,
    PullReconciliation,
    datastore_github_client,
    parse_graphql_datetime,
)


logger = logging.getLogger(__name__)


FULL_BUILD_COMPLETE_KEY = "full_build_complete"
FULL_BUILD_MARKERS_INITIALIZED_KEY = "full_build_markers_v1_initialized"
FULL_BUILD_RETRY_KEY = "full_build_retry_required"
ITEM_SYNC_ERRORS = "item-sync-errors"
INVENTORY_RETRY_KEY = "item_inventory_retry"
INITIALIZATION_KEY = "initialization_v1"
RECONCILE_PROGRESS_KEY = "reconcile_progress_v1"


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
    with closing(connect(db_path)) as conn, datastore_github_client() as client:
        reader = GitHubOrgReader(client)
        run_started = utc_now()
        init_db(conn)
        prior = (
            initialization_to_resume(conn, org, include_repos, exclude_repos)
            if resume else None
        )
        repo_inventory = reader.list_org_repos(org)
        all_repos = readable_repositories(conn, org, repo_inventory)
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
            if not isinstance(repo_inventory, PartialRepositoryInventory):
                prune_repos(conn, [int(repo["id"]) for repo in repos])
            users = list_users(conn)

        # Re-list on every attempt: a saved expansion is reusable only when its
        # current identity and timestamp still match. This also removes deletions.
        for repo in repos:
            repo_id = int(repo["id"])
            inventory = list_repo_items(reader, repo)
            all_issues = readable_items(conn, repo, inventory)
            issues = items_requiring_full_refresh(conn, repo_id, repo["full_name"], all_issues)
            if not isinstance(inventory, PartialItemInventory):
                with conn:
                    prune_items_for_repo(conn, repo_id, [int(issue["id"]) for issue in all_issues])
                    clear_inventory_retry(conn, repo_id)
            store_available_items(conn, reader, repo, issues, workers, users)
            with conn:
                mark_full_build_completed(conn, repo_id)

        # A long or interrupted build can outlive its first enumerations. Catch
        # up from the original start before publishing completion or freshness.
        catchup_started = utc_now()
        changed = changed_items_for_repos(reader, conn, repos, state["started_at"])
        for repo in repos:
            issues = items_requiring_full_refresh(
                conn, int(repo["id"]), repo["full_name"], readable_items(conn, repo, changed[repo["full_name"]])
            )
            store_available_items(conn, reader, repo, issues, workers, users)

        with conn:
            assert_no_duplicate_items(conn)
            state["status"] = "complete"
            set_state(conn, "org", INITIALIZATION_KEY, json.dumps(state, sort_keys=True))
            set_state(conn, "org", "last_full_build_at", utc_now())
            set_state(conn, "org", "last_sync_at", catchup_started)


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
            "repos", "items", "sync_state", "timestamp_regressions", "events", "comments", "reviews",
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


def list_repo_items(reader: GitHubOrgReader, repo: dict[str, Any]) -> list[dict[str, Any]] | PartialItemInventory:
    try:
        if repo.get("has_issues"):
            return reader.list_repo_issues(repo["full_name"])
        return reader.list_repo_issues(repo["full_name"], include_issues=False)
    except GitHubRateLimitError:
        raise
    except (GitHubApiError, KeyError, ValueError, TypeError, AttributeError) as error:
        return PartialItemInventory([], [f"Could not list {repo['full_name']}: {error}"], {})


def readable_repositories(
    conn: sqlite3.Connection, owner: str, inventory: list[dict[str, Any]] | PartialRepositoryInventory,
) -> list[dict[str, Any]]:
    if not isinstance(inventory, PartialRepositoryInventory):
        return inventory
    logger.warning("Incomplete repository inventory for %s (%d invalid rows): %s",
                   owner, len(inventory.problems), "; ".join(reason[:500] for reason in inventory.problems[:8]))
    visible = {repo["id"] for repo in inventory.repos}
    with conn:
        for (repo_id,) in conn.execute("SELECT repo_id FROM repos"):
            if repo_id not in visible:
                set_state(conn, repo_state_scope(repo_id), INVENTORY_RETRY_KEY,
                          f"Incomplete repository inventory for {owner}; check the next full item listing")
    return inventory.repos


def readable_items(
    conn: sqlite3.Connection, repo: dict[str, Any], inventory: list[dict[str, Any]] | PartialItemInventory,
) -> list[dict[str, Any]]:
    if not isinstance(inventory, PartialItemInventory):
        return inventory
    problems = [reason[:500] for reason in inventory.problems[:8]]
    logger.warning("Incomplete item inventory for %s (%d invalid rows): %s",
                   repo["full_name"], len(inventory.problems), "; ".join(problems))
    repo_id = int(repo["id"])
    with conn:
        set_state(conn, repo_state_scope(repo_id), INVENTORY_RETRY_KEY, json.dumps(problems))
        for number, reason in inventory.unreadable.items():
            row = conn.execute("SELECT item_id, item_type, updated_at FROM items WHERE repo_id = ? AND number = ?",
                               (repo_id, number)).fetchone()
            if row is not None:
                item = {"id": row["item_id"], "number": number, "updated_at": row["updated_at"], "item_kind": row["item_type"]}
                set_state(conn, ITEM_SYNC_ERRORS, str(row["item_id"]), json.dumps({
                    "repo_id": repo_id, "item": item, "reason": reason[:500],
                }))
    return inventory.items


def clear_inventory_retry(conn: sqlite3.Connection, repo_id: int) -> None:
    conn.execute("DELETE FROM sync_state WHERE scope = ? AND key = ?", (repo_state_scope(repo_id), INVENTORY_RETRY_KEY))


def changed_items_for_repos(
    reader: GitHubOrgReader,
    conn: sqlite3.Connection,
    repos: list[dict[str, Any]],
    since: str | None,
) -> dict[str, list[dict[str, Any]] | PartialItemInventory]:
    changed = {}
    reconciliations = []
    # Keep each batch's connection set uniform; disabled Issues never exclude PRs.
    for include_issues in (True, False):
        batch = [repo for repo in repos if bool(repo.get("has_issues")) == include_issues]
        if not batch:
            continue
        names = [repo["full_name"] for repo in batch]
        options = {} if include_issues else {"include_issues": False}
        result = reader.list_repos_changed_items(
            names, since,
            {repo["full_name"]: stored_pr_updated_at_by_id(conn, int(repo["id"])) for repo in batch},
            **options,
        )
        if set(result) != set(names):
            raise RuntimeError("changed-item batch does not cover the requested repositories")
        for repo in batch:
            name = repo["full_name"]
            items = result[name]
            if isinstance(items, PullReconciliation):
                reconciliations.append((int(repo["id"]), items.missing_ids))
                changed[name] = items.items
            else:
                changed[name] = items
    with conn:
        for repo_id, missing_ids in reconciliations:
            prune_missing_pulls(conn, repo_id, missing_ids)
    return changed


def build_user(username: str, db_path: str | Path) -> None:
    if not username.strip():
        raise ValueError("username is required")
    conn = connect(db_path)
    try:
        init_db(conn)
        rows = conn.execute("SELECT item_id, expanded_json FROM items ORDER BY repo_full_name, number").fetchall()
        if not rows:
            raise RuntimeError("no indexed items; run init-org first")
        with conn:
            add_user(conn, username)
            for row in rows:
                try:
                    expanded = json.loads(row["expanded_json"])
                    associations = extract_associations(expanded, username)
                except (ValueError, TypeError, KeyError, AttributeError) as error:
                    logger.warning("Could not index %s associations for item %s: %s", username, row["item_id"], error)
                    continue
                replace_associations(conn, int(row["item_id"]), username, associations)
            assert_no_duplicate_items(conn)
    finally:
        conn.close()


class ReconciliationDeadline(Exception):
    pass


def store_available_items(
    conn: sqlite3.Connection, reader: GitHubOrgReader, repo: dict[str, Any],
    items: list[dict[str, Any]], workers: int, users: list[str],
    *, observe: Callable[[int | None], None] = lambda _item_id: None,
) -> None:
    by_number = {item["number"]: item for item in items}

    def retain_failure(number: int | str, error: Exception) -> None:
        logger.warning("Could not sync %s#%s; keeping the last snapshot: %s", repo["full_name"], number, error)
        item = by_number.get(number)
        if item is not None:
            with conn:
                set_state(conn, ITEM_SYNC_ERRORS, str(item["id"]), json.dumps({
                    "repo_id": int(repo["id"]), "item": item, "reason": str(error)[:500],
                }))
        observe(None)

    with closing(iter_expanded(reader, repo, items, workers, on_item_error=retain_failure)) as expansions:
        for expanded in expansions:
            try:
                item_id = store_expanded(conn, expanded, users)
            except (GitHubApiError, ValueError, TypeError, KeyError, AttributeError, sqlite3.IntegrityError) as error:
                issue = expanded.get("issue") if isinstance(expanded, dict) else None
                number = issue.get("number", "unknown") if isinstance(issue, dict) else "unknown"
                retain_failure(number, error)
                continue
            observe(item_id)


def sync_once(
    db_path: str | Path,
    workers: int = 8,
    include_repos: list[str] | None = None,
    exclude_repos: list[str] | None = None,
    reconcile: bool = False,
    reconcile_sleep: float = 0.0,
    reconcile_max_seconds: float | None = None,
) -> bool:
    if workers <= 0:
        raise ValueError("workers must be positive")
    if reconcile_sleep < 0:
        raise ValueError("reconcile sleep cannot be negative")
    if reconcile_max_seconds is not None and (
        not reconcile or not math.isfinite(reconcile_max_seconds) or reconcile_max_seconds <= 0
    ):
        raise ValueError("reconcile-max-seconds requires reconcile and a positive finite duration")
    deadline = time.monotonic() + reconcile_max_seconds if reconcile_max_seconds is not None else None
    validate_repo_filter(include_repos, exclude_repos)
    with closing(connect(db_path)) as conn, datastore_github_client() as client:
        reader = GitHubOrgReader(client)
        run_started = utc_now()
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
            # Existing snapshots predate label capture. Reuse the normal
            # full-enumeration/checkpoint path to refresh old issues,
            # even when their GitHub updatedAt has not changed.
            for row in conn.execute("SELECT DISTINCT repo_id FROM items WHERE item_type='issue' "
                                    "AND coalesce(json_type(expanded_json,'$.issue.labels'),'missing') != 'array'"):
                clear_full_build_marker(conn, int(row["repo_id"]))
        since = get_state(conn, "org", "last_sync_at")
        repo_inventory = reader.list_org_repos(org)
        repos = readable_repositories(conn, org, repo_inventory)
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
                    prior_repo is None
                    or prior_repo[0] != bool(repo.get("has_issues"))
                    or prior_repo[1] != repo["full_name"]
                ):
                    clear_full_build_marker(conn, repo_id)
                upsert_repo(conn, repo)
            if not isinstance(repo_inventory, PartialRepositoryInventory):
                prune_repos(conn, [int(repo["id"]) for repo in repos])

        if reconcile:
            raw_progress = get_state(conn, "org", RECONCILE_PROGRESS_KEY)
            progress = json.loads(raw_progress) if raw_progress is not None else {
                "started_at": run_started, "repos": {}, "remaining": [],
            }
            if (
                not isinstance(progress, dict)
                or set(progress) != {"started_at", "repos", "remaining"}
                or not isinstance(progress["started_at"], str)
                or not isinstance(progress["repos"], dict)
                or not isinstance(progress["remaining"], list)
                or any(not isinstance(key, str) or not isinstance(value, str) for key, value in progress["repos"].items())
                or any(not isinstance(value, str) or value not in progress["repos"] for value in progress["remaining"])
            ):
                raise RuntimeError("invalid reconciliation progress")
            current = {str(repo["id"]): json.dumps([repo["full_name"], bool(repo.get("has_issues"))]) for repo in repos}
            remaining = set(progress["remaining"]) & current.keys()
            remaining.update(key for key, name in current.items() if progress["repos"].get(key) != name)
            progress["repos"] = current
            progress["remaining"] = sorted(remaining)
            with conn:
                set_state(conn, "org", RECONCILE_PROGRESS_KEY, json.dumps(progress, sort_keys=True))
            repos = [repo for repo in repos if str(repo["id"]) in remaining]

        incremental_repos = [
            repo for repo in repos
            if not reconcile
            and full_build_completed(conn, int(repo["id"]))
            and not full_build_retry_required(conn, int(repo["id"]))
            and not get_state(conn, repo_state_scope(int(repo["id"])), INVENTORY_RETRY_KEY)
        ]
        changed = changed_items_for_repos(reader, conn, incremental_repos, since)
        pending: dict[int, dict[int, dict[str, Any]]] = {}
        for row in conn.execute("SELECT key, value FROM sync_state WHERE scope = ?", (ITEM_SYNC_ERRORS,)):
            try:
                saved = json.loads(row["value"])
                item = saved["item"]
                item_id = int(row["key"])
                if int(item["id"]) != item_id or type(item["number"]) is not int or item["item_kind"] not in ("pr", "issue"):
                    raise ValueError("saved retry has an invalid item identity")
                pending.setdefault(int(saved["repo_id"]), {})[item_id] = item
            except (ValueError, TypeError, KeyError) as error:
                logger.warning("Could not read sync retry for item %s: %s", row["key"], error)

        for repo in repos:
            repo_id = int(repo["id"])
            retries = pending.get(repo_id, {})
            prior_repo = known_repos.get(repo_id)
            retry_full_build = full_build_retry_required(conn, repo_id)
            requires_initial_full = (
                prior_repo is None
                or prior_repo[1] != repo["full_name"]
                or not full_build_completed(conn, repo_id)
            )
            retry_inventory = get_state(conn, repo_state_scope(repo_id), INVENTORY_RETRY_KEY) is not None
            full_enumeration = reconcile or retry_full_build or requires_initial_full or retry_inventory
            if full_enumeration:
                if not reconcile:
                    with conn:
                        clear_full_build_marker(conn, repo_id)
                inventory = list_repo_items(reader, repo)
                all_issues = readable_items(conn, repo, inventory)
                refresh = (
                    all_issues
                    if reconcile or retry_full_build
                    else items_requiring_full_refresh(
                        conn, repo_id, repo["full_name"], all_issues
                    )
                )
                issues = {int(issue["id"]): issue for issue in refresh}
                versions_in_repo = {int(issue["id"]): issue for issue in all_issues}
                for item_id in retries:
                    if item_id in versions_in_repo:
                        issues[item_id] = versions_in_repo[item_id]
                if not isinstance(inventory, PartialItemInventory):
                    with conn:
                        prune_items_for_repo(
                            conn, repo_id, [int(issue["id"]) for issue in all_issues]
                        )
                        for missing_id in retries.keys() - versions_in_repo.keys():
                            conn.execute("DELETE FROM sync_state WHERE scope = ? AND key = ?", (ITEM_SYNC_ERRORS, str(missing_id)))
                # Each expansion and its source version survive a killed CLI.
                # A new enumeration still discovers transfers, removals and edits.
                checkpoint_scope = f"full-refresh:{repo_id}"
                versions = {
                    int(issue["id"]): json.dumps([
                        repo["full_name"], issue["number"], issue["item_kind"], issue["updated_at"],
                    ]) for issue in issues.values()
                }
                stored_versions = {
                    int(row["item_id"]): json.dumps([
                        row["repo_full_name"], row["number"], row["item_type"], row["updated_at"],
                    ]) for row in conn.execute(
                        "SELECT item_id, repo_full_name, number, item_type, updated_at FROM items WHERE repo_id = ?",
                        (repo_id,),
                    )
                }
                items = [issue for item_id, issue in issues.items() if item_id in retries or stored_versions.get(item_id) != versions[item_id] or
                         get_state(conn, checkpoint_scope, str(item_id)) != versions[item_id]]
            else:
                by_number = {item["number"]: item for item in retries.values()}
                inventory = changed[repo["full_name"]]
                available = readable_items(conn, repo, inventory)
                if isinstance(inventory, PartialItemInventory):
                    available = items_requiring_full_refresh(conn, repo_id, repo["full_name"], available)
                    for number in inventory.unreadable:
                        by_number.pop(number, None)
                by_number.update({item["number"]: item for item in available})
                items = list(by_number.values())
            outstanding = len(items)

            def checked_attempt(item_id: int | None) -> None:
                nonlocal outstanding
                if full_enumeration and item_id is not None:
                    with conn:
                        set_state(conn, checkpoint_scope, str(item_id), versions[item_id])
                outstanding -= 1
                if reconcile_sleep:
                    time.sleep(reconcile_sleep)
                if deadline is not None and outstanding and time.monotonic() >= deadline:
                    raise ReconciliationDeadline()

            try:
                store_available_items(conn, reader, repo, items, workers, users, observe=checked_attempt)
            except ReconciliationDeadline:
                return False
            if full_enumeration:
                with conn:
                    mark_full_build_completed(conn, repo_id)
                    if not isinstance(inventory, PartialItemInventory):
                        clear_inventory_retry(conn, repo_id)
                    conn.execute("DELETE FROM sync_state WHERE scope = ?", (checkpoint_scope,))
                    if reconcile:
                        progress["remaining"].remove(str(repo_id))
                        set_state(conn, "org", RECONCILE_PROGRESS_KEY, json.dumps(progress, sort_keys=True))
            if reconcile and deadline is not None and progress["remaining"] and time.monotonic() >= deadline:
                return False

        with conn:
            if reconcile:
                set_state(conn, "org", "last_reconcile_at", progress["started_at"])
                conn.execute("DELETE FROM sync_state WHERE scope = 'org' AND key = ?", (RECONCILE_PROGRESS_KEY,))
            else:
                set_state(conn, "org", "last_sync_at", run_started)
            assert_no_duplicate_items(conn)
        return True


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
            SELECT item_id, node_id, repo_full_name, number, item_type, state, updated_at, expanded_json
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
        try:
            stored_at = parse_graphql_datetime(row["updated_at"], f"stored item {item_id}")
            expanded = json.loads(row["expanded_json"])
            stored_repo = expanded["repo"]
            stored_issue = expanded["issue"]
            if (stored_repo["id"] != repo_id or stored_repo["full_name"] != row["repo_full_name"]
                or stored_repo["owner"]["login"].casefold() != row["repo_full_name"].split("/", 1)[0].casefold()
                or stored_issue["id"] != item_id or stored_issue["node_id"] != row["node_id"]
                or stored_issue["number"] != row["number"] or stored_issue["updated_at"] != row["updated_at"]
                or ("pr" if expanded["is_pr"] else "issue") != row["item_type"]):
                raise ValueError("stored expansion identity mismatch")
            issue_labels = row["item_type"] != "issue" or isinstance(stored_issue.get("labels"), list)
        except (GitHubApiError, ValueError, TypeError, KeyError, AttributeError) as error:
            logger.warning("Refreshing unreadable saved item %s#%s: %s", repo_full_name, item["number"], error)
            refresh.append(item)
            continue
        if (
            current_at != stored_at
            or int(row["number"]) != int(item["number"])
            or str(row["item_type"]) != item["item_kind"]
            or str(row["repo_full_name"]) != repo_full_name
            or not issue_labels
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
    reconcile_max_seconds: float | None = None,
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
            reconcile_max_seconds=reconcile_max_seconds,
        )
        time.sleep(interval_seconds)


def store_expanded(
    conn: sqlite3.Connection, expanded: dict[str, Any], users: list[str] | None = None
) -> int:
    issue = expanded["issue"]
    with conn:
        previous = conn.execute(
            "SELECT updated_at, expanded_json FROM items WHERE item_id = ?",
            (int(issue["id"]),),
        ).fetchone()
        received_at = parse_graphql_datetime(issue["updated_at"], f"item {issue['id']}")
        regressed = False
        if previous is not None:
            try:
                regressed = received_at < parse_graphql_datetime(previous["updated_at"], f"stored item {issue['id']}")
            except GitHubApiError as error:
                logger.warning("Replacing invalid timestamp for %s#%s: %s", expanded["repo"]["full_name"], issue["number"], error)
        if regressed:
            # Keep the complete prior graph atomically with its replacement: a
            # timestamp alone cannot distinguish clock correction from old content.
            conn.execute(
                """INSERT INTO timestamp_regressions(
                    item_id, repo_full_name, stored_updated_at, received_updated_at,
                    previous_expanded_json, recorded_at
                ) VALUES (?, ?, ?, ?, ?, ?)""",
                (int(issue["id"]), expanded["repo"]["full_name"], previous["updated_at"],
                 issue["updated_at"], previous["expanded_json"], utc_now()),
            )
        item_id = upsert_expanded_item(conn, expanded)
        replace_child_rows(conn, item_id, expanded)
        refresh_fts(conn, item_id, expanded)
        for username in users or list_users(conn):
            associations = extract_associations(expanded, username)
            replace_associations(conn, item_id, username, associations)
        conn.execute("DELETE FROM sync_state WHERE scope = ? AND key = ?", (ITEM_SYNC_ERRORS, str(item_id)))
    if regressed:
        logger.warning(
            "item timestamp moved backward for %s: %s (%s -> %s); "
            "accepted fresh GraphQL data; previous graph preserved in timestamp_regressions",
            expanded["repo"]["full_name"], item_id, previous["updated_at"], issue["updated_at"],
        )
    return item_id


def iter_expanded(
    reader: GitHubOrgReader, repo: dict[str, Any], issues: list[dict[str, Any]], workers: int,
    *, on_item_error: Callable[[int, ItemGraphError], None] | None = None,
) -> Iterator[dict[str, Any]]:
    first_error: Exception | None = None

    def failed(number: int, error: Exception) -> None:
        nonlocal first_error
        if isinstance(error, ItemGraphError) and on_item_error is not None:
            on_item_error(number, error)
        else:
            logger.warning("Could not expand %s#%s: %s", repo["full_name"], number, error)
            if first_error is None:
                first_error = error

    for offset in range(0, len(issues), ITEM_GRAPH_BATCH_SIZE):
        batch = issues[offset:offset + ITEM_GRAPH_BATCH_SIZE]
        graphs = reader.fetch_initial_item_graphs(repo, batch)

        def expand(issue: dict[str, Any]) -> dict[str, Any]:
            number = issue["number"]
            graph = graphs.get(number)
            if isinstance(graph, ItemGraphError):
                raise graph
            if graph is None:
                raise ItemGraphError("GitHub omitted this item's graph")
            return reader.expand_item_graph(repo, issue, graph)

        if workers == 1 or len(batch) == 1:
            for issue in batch:
                try:
                    expanded = expand(issue)
                except GitHubRateLimitError:
                    raise
                except Exception as error:
                    failed(issue["number"], error)
                    continue
                yield expanded
            continue
        pool = ThreadPoolExecutor(max_workers=workers)
        futures, processed = {}, set()
        rate_error = None
        try:
            futures = {
                pool.submit(expand, issue): issue["number"]
                for issue in batch
            }
            for future in as_completed(futures):
                processed.add(future)
                try:
                    expanded = future.result()
                except GitHubRateLimitError as error:
                    rate_error = error
                    pool.shutdown(wait=False, cancel_futures=True)
                    break
                except Exception as error:
                    failed(futures[future], error)
                    continue
                yield expanded
            if rate_error is not None:
                for future in as_completed([f for f in futures if f not in processed and not f.cancelled()]):
                    processed.add(future)
                    try:
                        expanded = future.result()
                    except Exception as error:
                        failed(futures[future], error)
                        continue
                    yield expanded
                raise rate_error
        finally:
            pool.shutdown(wait=True, cancel_futures=True)
            if rate_error is not None:
                raise rate_error
            # A consumer ending at a deadline can still encounter a quota
            # failure from a worker it did not get to consume.
            for future in futures:
                if future not in processed and not future.cancelled():
                    error = future.exception()
                    if isinstance(error, GitHubRateLimitError):
                        raise error
    if first_error is not None:
        raise first_error


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
