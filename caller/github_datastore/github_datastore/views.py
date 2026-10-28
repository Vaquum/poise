from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from .db import DEFAULT_DB


Output = Literal["json", "csv"]


def pr(
    *,
    db_path: str | Path = DEFAULT_DB,
    output: Output = "json",
    repo: str | None = None,
    status: str | None = None,
    author: str | None = None,
    number: int | None = None,
    updated_since_datetime: str | None = None,
    created_since_datetime: str | None = None,
    created_at_datetime: str | None = None,
    limit: int | None = None,
) -> str:
    return _select(
        db_path,
        "prs",
        output,
        {
            "repo": repo,
            "status": status,
            "author": author,
            "number": number,
            "updated_since_datetime": updated_since_datetime,
            "created_since_datetime": _created_since(created_since_datetime, created_at_datetime),
            "limit": limit,
        },
    )


def issue(
    *,
    db_path: str | Path = DEFAULT_DB,
    output: Output = "json",
    repo: str | None = None,
    status: str | None = None,
    author: str | None = None,
    number: int | None = None,
    updated_since_datetime: str | None = None,
    created_since_datetime: str | None = None,
    created_at_datetime: str | None = None,
    limit: int | None = None,
    label: str | None = None,
    after_repo: str | None = None,
    after_number: int | None = None,
) -> str:
    return _select(
        db_path,
        "issues",
        output,
        {
            "repo": repo,
            "status": status,
            "author": author,
            "number": number,
            "updated_since_datetime": updated_since_datetime,
            "created_since_datetime": _created_since(created_since_datetime, created_at_datetime),
            "limit": limit,
            "label": label,
            "after_repo": after_repo,
            "after_number": after_number,
        },
    )


def user(
    *,
    db_path: str | Path = DEFAULT_DB,
    output: Output = "json",
    username: str | None = None,
    item_type: Literal["issue", "pr"] | None = None,
    repo: str | None = None,
    status: str | None = None,
    author: str | None = None,
    number: int | None = None,
    updated_since_datetime: str | None = None,
    created_since_datetime: str | None = None,
    created_at_datetime: str | None = None,
    limit: int | None = None,
) -> str:
    return _select(
        db_path,
        "user_items",
        output,
        {
            "username": username,
            "item_type": item_type,
            "repo": repo,
            "status": status,
            "author": author,
            "number": number,
            "updated_since_datetime": updated_since_datetime,
            "created_since_datetime": _created_since(created_since_datetime, created_at_datetime),
            "limit": limit,
        },
    )


def pr_reviews(
    *,
    db_path: str | Path = DEFAULT_DB,
    output: Output = "json",
    repo: str | None = None,
    number: int | None = None,
    review_after: int = 0,
    comment_after: int = 0,
    page_size: int | None = None,
) -> str:
    """One pull request's reviews and review threads as the datastore has
    them: local rows only, the sync owns freshness. A PR the datastore has
    never seen reads as found=false, never as an error. Truncated reads set
    truncated=true and must not establish completion."""
    if output != "json":
        raise ValueError("pr-reviews renders json only")
    if not repo or number is None:
        raise ValueError("pr-reviews needs a repo and a number")
    if review_after < 0 or comment_after < 0 or (page_size is not None and not 1 <= page_size <= 200):
        raise ValueError("pr-reviews needs a nonnegative review cursor and page-size between 1 and 200")
    conn = _read_connect(db_path)
    try:
        conn.execute("BEGIN")
        item = conn.execute(
            "SELECT item_id FROM items WHERE repo_full_name = ? COLLATE NOCASE AND number = ? AND item_type = 'pr'",
            (repo, number),
        ).fetchone()
        if item is None:
            return json.dumps({"repo": repo, "number": number, "found": False, "reviews": [], "threads": []})
        item_id = item["item_id"]
        if page_size is not None:
            return _pr_reviews_page(conn, repo, number, item_id, review_after, comment_after, page_size)
        reviews = [
            {"node_id": row["node_id"], "author": row["author_login"], "state": row["state"],
             "submitted_at": row["submitted_at"]}
            for row in conn.execute(
                "SELECT node_id, author_login, state, submitted_at FROM reviews WHERE item_id = ? ORDER BY review_id LIMIT 201",
                (item_id,),
            )
        ]
        comments = conn.execute(
            """SELECT node_id, author_login, updated_at, thread_node_id, thread_resolved, thread_outdated
               FROM review_comments WHERE item_id = ? ORDER BY comment_id LIMIT 1001""",
            (item_id,),
        ).fetchall()
        truncated = len(reviews) > 200 or len(comments) > 1000
        threads: list[dict[str, Any]] = []
        by_thread: dict[str, dict[str, Any]] = {}
        for row in comments[:1000]:
            entry = {"node_id": row["node_id"], "author": row["author_login"], "updated_at": row["updated_at"]}
            key = row["thread_node_id"]
            if key is None:
                # Pre-thread-identity rows: each comment stands alone with
                # unknown resolution, which reads as unresolved, never silent.
                threads.append({"thread_node_id": None, "resolved": None, "outdated": None, "comments": [entry]})
                continue
            thread = by_thread.get(key)
            if thread is None:
                thread = {"thread_node_id": key, "resolved": _flag(row["thread_resolved"]),
                          "outdated": _flag(row["thread_outdated"]), "comments": []}
                by_thread[key] = thread
                threads.append(thread)
            thread["comments"].append(entry)
        return json.dumps({"repo": repo, "number": number, "found": True, "truncated": truncated,
                           "reviews": reviews[:200], "threads": threads}, ensure_ascii=False)
    except sqlite3.Error as exc:
        raise RuntimeError(f"view query failed: pr-reviews: {exc}") from exc
    finally:
        conn.close()


def _pr_reviews_page(
    conn: sqlite3.Connection, repo: str, number: int, item_id: int,
    review_after: int, comment_after: int, page_size: int,
) -> str:
    # Each lane cycles independently: newly appended feedback cannot pin an
    # older thread's resolution/reopen state behind a permanent prefix.
    reviews = conn.execute(
        """SELECT review_id, node_id, author_login, state, submitted_at, body FROM reviews
           WHERE item_id = ? AND review_id > ? ORDER BY review_id LIMIT ?""",
        (item_id, review_after, page_size + 1),
    ).fetchall()
    # Page raw IDs before looking up latest thread summaries. Work is bounded
    # even when a single thread has arbitrarily many comments; repeated thread
    # summaries across pages are deduplicated by the consumer's identity state.
    comments = conn.execute(
        """SELECT comment_id, node_id, author_login, body, COALESCE(thread_node_id, node_id) AS identity
           FROM review_comments WHERE item_id = ? AND comment_id > ?
           ORDER BY comment_id LIMIT ?""", (item_id, comment_after, page_size + 1),
    ).fetchall()
    threads = [conn.execute(
        """SELECT node_id, author_login, updated_at, body, thread_node_id, thread_resolved, thread_outdated
           FROM review_comments INDEXED BY idx_review_threads_page
           WHERE item_id = ? AND COALESCE(thread_node_id, node_id) = ?
           ORDER BY comment_id DESC LIMIT 1""", (item_id, identity),
    ).fetchone() for identity in dict.fromkeys(row["identity"] for row in comments[:page_size])]
    latest_by_identity = {row["thread_node_id"] or row["node_id"]: row for row in threads}
    has_unresolved = conn.execute(
        """SELECT 1 FROM review_comments INDEXED BY idx_review_unresolved WHERE item_id = ? AND thread_resolved = 0
           UNION ALL SELECT 1 FROM review_comments INDEXED BY idx_review_unresolved WHERE item_id = ? AND thread_resolved IS NULL LIMIT 1""",
        (item_id, item_id),
    ).fetchone() is not None
    more_reviews, more_comments = len(reviews) > page_size, len(comments) > page_size
    return json.dumps({
        "repo": repo, "number": number, "found": True,
        "truncated": more_reviews or more_comments, "has_unresolved": has_unresolved,
        "page": {
            "review_after": review_after, "comment_after": comment_after,
            "next_review_after": reviews[page_size - 1]["review_id"] if more_reviews else 0,
            "next_comment_after": comments[page_size - 1]["comment_id"] if more_comments else 0,
        },
        "comments": [{"id": row["node_id"], "author": row["author_login"], "thread": row["identity"],
                      "resolved": _flag(latest_by_identity[row["identity"]]["thread_resolved"]),
                      "revision": hashlib.sha256((row["body"] or "").encode()).hexdigest()}
                     for row in comments[:page_size]],
        "reviews": [{"node_id": row["node_id"], "author": row["author_login"],
                     "state": row["state"], "submitted_at": row["submitted_at"],
                     "revision": hashlib.sha256((row["body"] or "").encode()).hexdigest()}
                    for row in reviews[:page_size]],
        "threads": [{"thread_node_id": row["thread_node_id"],
                     "resolved": _flag(row["thread_resolved"]), "outdated": _flag(row["thread_outdated"]),
                     "comments": [{"node_id": row["node_id"], "author": row["author_login"],
                                   "updated_at": row["updated_at"],
                                   "revision": hashlib.sha256((row["body"] or "").encode()).hexdigest()}]} for row in threads],
    }, ensure_ascii=False)


DEPENDS_ON_HEADER = re.compile(r"^\s*depends\s+on\s*:(.*)$", re.IGNORECASE)
DEPENDS_ON_ITEM = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+(.*)$")
GITHUB_URL_REF = re.compile(
    r"https?://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/(?:issues|pull)/([1-9][0-9]*)\b",
    re.IGNORECASE,
)
REPO_NUM_REF = re.compile(r"\b([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)#([1-9][0-9]*)\b")
BARE_NUM_REF = re.compile(r"(?<![\w/#])#([1-9][0-9]*)\b")
CLOSES_REF = re.compile(
    r"\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)"
    r"\s+(?:"
    r"https?://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/(?:issues|pull)/([1-9][0-9]*)\b"
    r"|([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)#([1-9][0-9]*)\b"
    r"|#([1-9][0-9]*)\b"
    r")",
    re.IGNORECASE,
)

DEPENDENTS_SCAN_LIMIT = 1000
DEPENDENTS_MATCH_LIMIT = 50
CLOSED_MATCH_LIMIT = 100
PR_CLOSING_SCAN_LIMIT = 500


def _extract_refs(text: str, default_repo: str) -> list[tuple[str, int]]:
    """(lowercase repo, number) refs in `text`: URLs, then repo#num, then bare #num."""
    refs: list[tuple[str, int]] = []
    for match in GITHUB_URL_REF.finditer(text):
        refs.append((match.group(1).lower(), int(match.group(2))))
    scrubbed = GITHUB_URL_REF.sub(" ", text)
    for match in REPO_NUM_REF.finditer(scrubbed):
        refs.append((match.group(1).lower(), int(match.group(2))))
    scrubbed = REPO_NUM_REF.sub(" ", scrubbed)
    for match in BARE_NUM_REF.finditer(scrubbed):
        refs.append((default_repo.lower(), int(match.group(1))))
    return refs


def parse_depends_on(body: str | None, default_repo: str) -> set[tuple[str, int]]:
    """Refs a body lists under Depends on: headers, inline or as list items.

    Each header consumes the rest of its line plus following list items; the
    first non-item line ends it, so a later Unlocks: list never leaks in."""
    refs: set[tuple[str, int]] = set()
    if not body:
        return refs
    lines = body.splitlines()
    index = 0
    while index < len(lines):
        header = DEPENDS_ON_HEADER.match(lines[index])
        if not header:
            index += 1
            continue
        refs.update(_extract_refs(header.group(1), default_repo))
        index += 1
        while index < len(lines):
            item = DEPENDS_ON_ITEM.match(lines[index])
            if not item:
                break
            refs.update(_extract_refs(item.group(1), default_repo))
            index += 1
    return refs


def parse_closes(body: str | None, default_repo: str) -> set[tuple[str, int]]:
    """Refs one closing keyword directly introduces: the fallback for pull
    requests last synced before closing references were tracked."""
    refs: set[tuple[str, int]] = set()
    if not body:
        return refs
    for match in CLOSES_REF.finditer(body):
        if match.group(1):
            refs.add((match.group(1).lower(), int(match.group(2))))
        elif match.group(3):
            refs.add((match.group(3).lower(), int(match.group(4))))
        else:
            refs.add((default_repo.lower(), int(match.group(5))))
    return refs


def _connection_nodes(value: Any) -> tuple[list[dict[str, Any]] | None, bool]:
    """(nodes, truncated) for a stored blockedBy/closingIssuesReferences
    connection. Absent reads as no edges: the sync owns freshness."""
    if value is None:
        return [], False
    if not isinstance(value, dict) or not isinstance(value.get("nodes"), list):
        return None, True
    page = value.get("pageInfo")
    truncated = isinstance(page, dict) and page.get("hasNextPage") is True
    nodes: list[dict[str, Any]] = []
    for node in value["nodes"]:
        if not isinstance(node, dict):
            return None, True
        nodes.append(node)
    return nodes, truncated


def _node_ref(node: dict[str, Any]) -> tuple[str, int] | None:
    number = node.get("number")
    repository = node.get("repository")
    repo = repository.get("nameWithOwner") if isinstance(repository, dict) else None
    if type(number) is not int or number <= 0 or not isinstance(repo, str) or not repo:
        return None
    return (repo.lower(), number)


def _head_ref(graphql: Any) -> tuple[str | None, str | None]:
    """(head branch, head repository) for a pull request, when the stored
    read tracked them. Rows synced before the sync fetched head refs, or
    with malformed stored values, report (None, None): consumers skip
    branch matching for them without doubting their closing refs."""
    if not isinstance(graphql, dict):
        return (None, None)
    ref = graphql.get("headRefName")
    repo_node = graphql.get("headRepository")
    repo = repo_node.get("nameWithOwner") if isinstance(repo_node, dict) else None
    ref = ref if isinstance(ref, str) and ref else None
    repo = repo if isinstance(repo, str) and repo else None
    return (ref, repo)


def _closing_refs(graphql: Any, body: str | None, repo: str) -> tuple[list[tuple[str, int, str | None]], str, bool]:
    """((repo, number, title) refs, provenance, truncated) for a pull request.

    GitHub's closing references when the stored read tracked them, else the
    body's closing keywords. A malformed stored connection falls back to the
    body and marks the read truncated."""
    stored = graphql.get("closingIssuesReferences") if isinstance(graphql, dict) else None
    if stored is None:
        return [(r, n, None) for r, n in sorted(parse_closes(body, repo))], "body-keywords", False
    nodes, truncated = _connection_nodes(stored)
    if nodes is None:
        return [(r, n, None) for r, n in sorted(parse_closes(body, repo))], "body-keywords", True
    refs: list[tuple[str, int, str | None]] = []
    for node in nodes:
        ref = _node_ref(node)
        if ref is None:
            return [(r, n, None) for r, n in sorted(parse_closes(body, repo))], "body-keywords", True
        title = node.get("title")
        refs.append((ref[0], ref[1], title if isinstance(title, str) and title else None))
    return sorted(refs), "closing-references", truncated


def pr_dependents(
    *,
    db_path: str | Path = DEFAULT_DB,
    output: Output = "json",
    repo: str | None = None,
    number: int | None = None,
) -> str:
    """A pull request's closed issues and their open dependents as the
    datastore has them: local rows only, the sync owns freshness. A PR the
    datastore has never seen reads as found=false, never as an error. An
    open issue counts as dependent when GitHub lists the closed issue in its
    blockedBy, or its body lists it under Depends on:. `truncated` means a
    cap or a malformed stored connection hid entries; absence from the lists
    then proves nothing."""
    if output != "json":
        raise ValueError("pr-dependents renders json only")
    if not repo or number is None:
        raise ValueError("pr-dependents needs a repo and a number")
    conn = _read_connect(db_path)
    try:
        conn.execute("BEGIN")
        row = conn.execute(
            """SELECT title, body, expanded_json FROM items
               WHERE repo_full_name = ? COLLATE NOCASE AND number = ? AND item_type = 'pr'""",
            (repo, number),
        ).fetchone()
        if row is None:
            return json.dumps({"repo": repo, "number": number, "found": False, "title": None,
                               "closed": [], "closes_via": None, "dependents": [], "truncated": False})
        try:
            expanded = json.loads(row["expanded_json"])
        except ValueError:
            expanded = None
        pull = expanded.get("pull") if isinstance(expanded, dict) else None
        graphql = pull.get("graphql") if isinstance(pull, dict) else None
        closing, closes_via, truncated = _closing_refs(graphql, row["body"], repo)
        if len(closing) > CLOSED_MATCH_LIMIT:
            truncated = True
            closing = closing[:CLOSED_MATCH_LIMIT]
        closed: list[dict[str, Any]] = []
        for ref_repo, ref_number, ref_title in closing:
            issue = conn.execute(
                """SELECT repo_full_name, title, state FROM items
                   WHERE repo_full_name = ? COLLATE NOCASE AND number = ? AND item_type = 'issue'""",
                (ref_repo, ref_number),
            ).fetchone()
            display_repo = issue["repo_full_name"] if issue else ref_repo
            closed.append({
                "repo": display_repo,
                "number": ref_number,
                "title": issue["title"] if issue else (ref_title or f"{display_repo}#{ref_number}"),
                "url": f"https://github.com/{display_repo}/issues/{ref_number}",
                "state": issue["state"] if issue else None,
            })
        dependents: list[dict[str, Any]] = []
        if closing:
            targets = {(ref_repo, ref_number) for ref_repo, ref_number, _ in closing}
            scanned = conn.execute(
                """SELECT repo_full_name, number, title, body,
                          json_extract(expanded_json, '$.issue.graphql.blockedBy') AS blocked_by
                   FROM items
                   WHERE repo_full_name = ? COLLATE NOCASE AND item_type = 'issue' AND state = 'open'
                   ORDER BY number LIMIT ?""",
                (repo, DEPENDENTS_SCAN_LIMIT + 1),
            ).fetchall()
            if len(scanned) > DEPENDENTS_SCAN_LIMIT:
                truncated = True
                scanned = scanned[:DEPENDENTS_SCAN_LIMIT]
            for candidate in scanned:
                raw_blocked_by = candidate["blocked_by"]
                if raw_blocked_by is None:
                    blocked_by = None
                elif not isinstance(raw_blocked_by, str):
                    blocked_by = False
                else:
                    try:
                        blocked_by = json.loads(raw_blocked_by)
                    except ValueError:
                        blocked_by = False
                nodes, connections_truncated = _connection_nodes(blocked_by)
                if nodes is None:
                    truncated = True
                    blocked: set[tuple[str, int]] = set()
                else:
                    if connections_truncated:
                        truncated = True
                    blocked = set()
                    for node in nodes:
                        ref = _node_ref(node)
                        if ref is None:
                            truncated = True
                            blocked = set()
                            break
                        blocked.add(ref)
                depends = parse_depends_on(candidate["body"], candidate["repo_full_name"])
                via = [name for name, hits in (("blocked-by", blocked), ("depends-on", depends)) if hits & targets]
                if not via:
                    continue
                dependents.append({
                    "repo": candidate["repo_full_name"],
                    "number": candidate["number"],
                    "title": candidate["title"],
                    "url": f"https://github.com/{candidate['repo_full_name']}/issues/{candidate['number']}",
                    "via": via,
                })
            if len(dependents) > DEPENDENTS_MATCH_LIMIT:
                truncated = True
                dependents = dependents[:DEPENDENTS_MATCH_LIMIT]
        return json.dumps({"repo": repo, "number": number, "found": True, "title": row["title"],
                           "closed": closed, "closes_via": closes_via,
                           "dependents": dependents, "truncated": truncated}, ensure_ascii=False)
    except sqlite3.Error as exc:
        raise RuntimeError(f"view query failed: pr-dependents: {exc}") from exc
    finally:
        conn.close()


def pr_closing(
    *,
    db_path: str | Path = DEFAULT_DB,
    output: Output = "json",
    repo: str | None = None,
    limit: int | None = None,
    after_number: int | None = None,
    after_repo: str | None = None,
) -> str:
    """Open pull requests and the issues each closes, as the datastore has
    them: local rows only, the sync owns freshness. Each entry carries
    GitHub's closing references when the stored read tracked them, else the
    body's closing keywords, the same provenance pr-dependents reports per
    pull request. `closing_truncated` marks a pull request whose own closing
    list is incomplete; matching on it would misbind, so consumers must skip
    it. `truncated` means a cap or a malformed stored connection hid entries;
    absence from the list then proves nothing. `more` means further pull
    requests follow: pass the last returned cursor back until it clears, the
    number as `after_number` with the same `repo`, or the pair as
    `after_repo`/`after_number` for an unscoped list. A bare `after_number`
    needs `repo`, since numbers order only within one repository. `head_ref`
    and `head_repo` name the pull request's head branch and its repository
    for branch matching; both are null when the stored read predates head
    tracking or kept malformed values."""
    if output != "json":
        raise ValueError("pr-closing renders json only")
    if limit is not None and limit <= 0:
        raise ValueError("limit must be positive")
    if after_repo is not None and (repo is not None or after_number is None):
        raise ValueError("after_repo pages an unscoped list and needs after_number")
    if after_number is not None and (after_number <= 0 or (repo is None and after_repo is None)):
        raise ValueError("after_number needs a repo and a positive number")
    cap = min(limit, PR_CLOSING_SCAN_LIMIT) if limit is not None else PR_CLOSING_SCAN_LIMIT
    sql = """SELECT repo_full_name, number, body, expanded_json FROM items
             WHERE item_type = 'pr' AND state = 'open'"""
    params: list[Any] = []
    if repo is not None:
        sql += " AND repo_full_name = ? COLLATE NOCASE"
        params.append(repo)
    if after_repo is not None and after_number is not None:
        sql += " AND (repo_full_name > ? OR (repo_full_name = ? AND number > ?))"
        params.extend([after_repo, after_repo, after_number])
    elif after_number is not None:
        sql += " AND number > ?"
        params.append(after_number)
    sql += " ORDER BY repo_full_name ASC, number ASC LIMIT ?"
    params.append(cap + 1)
    conn = _read_connect(db_path)
    try:
        conn.execute("BEGIN")
        rows = conn.execute(sql, params).fetchall()
        more = len(rows) > cap
        truncated = more
        prs: list[dict[str, Any]] = []
        for row in rows[:cap]:
            try:
                expanded = json.loads(row["expanded_json"])
            except ValueError:
                expanded = None
            pull = expanded.get("pull") if isinstance(expanded, dict) else None
            graphql = pull.get("graphql") if isinstance(pull, dict) else None
            head_ref = _head_ref(graphql)
            closing, closes_via, refs_truncated = _closing_refs(graphql, row["body"], row["repo_full_name"])
            closing_truncated = refs_truncated or len(closing) > CLOSED_MATCH_LIMIT
            if closing_truncated:
                truncated = True
                closing = closing[:CLOSED_MATCH_LIMIT]
            prs.append({
                "repo": row["repo_full_name"],
                "number": row["number"],
                "url": f"https://github.com/{row['repo_full_name']}/pull/{row['number']}",
                "closing": [{"repo": ref_repo, "number": ref_number} for ref_repo, ref_number, _ in closing],
                "closes_via": closes_via,
                "closing_truncated": closing_truncated,
                "head_ref": head_ref[0],
                "head_repo": head_ref[1],
            })
        return json.dumps({"prs": prs, "truncated": truncated, "more": more}, ensure_ascii=False)
    except sqlite3.Error as exc:
        raise RuntimeError(f"view query failed: pr-closing: {exc}") from exc
    finally:
        conn.close()


def _flag(value: Any) -> bool | None:
    return None if value is None else bool(value)


def _select(db_path: str | Path, view_name: str, output: Output, filters: dict[str, Any]) -> str:
    if view_name not in {"prs", "issues", "user_items"}:
        raise ValueError(f"unknown view: {view_name}")
    limit = filters.pop("limit")
    where, params = _where(filters)
    after_repo, after_number = filters.get("after_repo"), filters.get("after_number")
    if after_repo is not None or after_number is not None:
        if view_name != "issues" or not isinstance(after_repo, str) or not isinstance(after_number, int) or after_number < 0:
            raise ValueError("issue pagination needs after_repo and a nonnegative after_number")
        where.append("(repo > ? OR (repo = ? AND number > ?))")
        params.extend([after_repo, after_repo, after_number])
    label = filters.get("label")
    if label is not None:
        if view_name != "issues" or not isinstance(label, str) or not label.strip():
            raise ValueError("issue label must be a nonempty string")
        where.append("""EXISTS (SELECT 1 FROM items chain_issue,
          json_each(chain_issue.expanded_json, '$.issue.labels') chain_label
          WHERE chain_issue.item_id = issues.payload_ref
            AND json_extract(chain_label.value, '$.name') = ? COLLATE NOCASE)""")
        params.append(label)
    sql = f"SELECT * FROM {view_name}"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY repo ASC, number ASC" if after_repo is not None else " ORDER BY updated_at DESC, repo ASC, number ASC"
    if limit is not None:
        if limit <= 0:
            raise ValueError("limit must be positive")
        sql += " LIMIT ?"
        params.append(limit)

    conn = _read_connect(db_path)
    try:
        rows = conn.execute(sql, params).fetchall()
        columns = [column[0] for column in conn.execute(f"SELECT * FROM {view_name} LIMIT 0").description]
        return _render(rows, columns, output)
    except sqlite3.Error as exc:
        raise RuntimeError(f"view query failed: {view_name}: {exc}") from exc
    finally:
        conn.close()


def _read_connect(db_path: str | Path) -> sqlite3.Connection:
    uri = Path(db_path).resolve().as_uri() + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _where(filters: dict[str, Any]) -> tuple[list[str], list[Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    for column in ("username", "item_type", "repo", "status", "author", "number"):
        value = filters.get(column)
        if value is not None:
            # Repository names keep GitHub's case in storage while callers
            # pass them normalized: match case-insensitively so a mixed-case
            # repo's rows are found, like pr-reviews already does.
            clauses.append(f"{column} = ? COLLATE NOCASE" if column == "repo" else f"{column} = ?")
            params.append(value)
    updated_since = filters.get("updated_since_datetime")
    if updated_since is not None:
        clauses.append("updated_at >= ?")
        params.append(_normalize_datetime(updated_since))
    created_since = filters.get("created_since_datetime")
    if created_since is not None:
        clauses.append("created_at >= ?")
        params.append(_normalize_datetime(created_since))
    return clauses, params


def _render(rows: list[sqlite3.Row], columns: list[str], output: Output) -> str:
    if output == "json":
        return json.dumps([dict(row) for row in rows], ensure_ascii=False)
    if output == "csv":
        stream = io.StringIO()
        writer = csv.DictWriter(stream, fieldnames=columns, lineterminator="\n")
        writer.writeheader()
        writer.writerows(dict(row) for row in rows)
        return stream.getvalue()
    raise ValueError("output must be json or csv")


def _created_since(
    created_since_datetime: str | None, created_at_datetime: str | None
) -> str | None:
    if created_since_datetime and created_at_datetime:
        raise ValueError("use either created_since_datetime or created_at_datetime")
    return created_since_datetime or created_at_datetime


def _normalize_datetime(value: str) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("datetime must include timezone")
    return parsed.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
