from __future__ import annotations

import csv
import hashlib
import io
import json
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
        """SELECT comment_id, node_id, body, COALESCE(thread_node_id, node_id) AS identity
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
        "comments": [{"id": row["node_id"], "thread": row["identity"],
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


def _flag(value: Any) -> bool | None:
    return None if value is None else bool(value)


def _select(db_path: str | Path, view_name: str, output: Output, filters: dict[str, Any]) -> str:
    if view_name not in {"prs", "issues", "user_items"}:
        raise ValueError(f"unknown view: {view_name}")
    limit = filters.pop("limit")
    where, params = _where(filters)
    sql = f"SELECT * FROM {view_name}"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY updated_at DESC, repo ASC, number ASC"
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
