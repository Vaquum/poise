from __future__ import annotations

import json
import hashlib
import os
import sqlite3
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def default_db() -> str:
    """Without --db the database lives in the user's data directory."""
    data = os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share"
    return str(Path(data) / "github-datastore" / "github_datastore.sqlite")


DEFAULT_DB = default_db()
VIEW_SCHEMA_VERSION = 1
VIEW_NAMES = frozenset({"user_associations", "prs", "issues", "user_items"})


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def connect(path: str | Path = DEFAULT_DB) -> sqlite3.Connection:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=60)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 60000")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    return conn


SCHEMA = """
CREATE TABLE IF NOT EXISTS repos (
    repo_id INTEGER PRIMARY KEY,
    node_id TEXT NOT NULL UNIQUE,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    full_name TEXT NOT NULL UNIQUE,
    private INTEGER NOT NULL,
    archived INTEGER NOT NULL,
    has_issues INTEGER NOT NULL,
    raw_json TEXT NOT NULL,
    synced_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
    item_id INTEGER PRIMARY KEY,
    node_id TEXT NOT NULL UNIQUE,
    repo_id INTEGER NOT NULL REFERENCES repos(repo_id) ON DELETE CASCADE,
    repo_full_name TEXT NOT NULL,
    number INTEGER NOT NULL,
    item_type TEXT NOT NULL CHECK (item_type IN ('issue', 'pr')),
    state TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    author_login TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    closed_at TEXT,
    raw_json TEXT NOT NULL,
    expanded_json TEXT NOT NULL,
    synced_at TEXT NOT NULL,
    UNIQUE(repo_id, number)
);

CREATE TABLE IF NOT EXISTS events (
    event_key TEXT NOT NULL,
    item_id INTEGER NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
    event_id INTEGER,
    node_id TEXT,
    event_type TEXT NOT NULL,
    actor_login TEXT,
    created_at TEXT,
    raw_json TEXT NOT NULL,
    PRIMARY KEY(item_id, event_key)
);

CREATE TABLE IF NOT EXISTS comments (
    comment_id INTEGER PRIMARY KEY,
    node_id TEXT NOT NULL UNIQUE,
    item_id INTEGER NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
    author_login TEXT,
    body TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
    review_id INTEGER PRIMARY KEY,
    node_id TEXT NOT NULL UNIQUE,
    item_id INTEGER NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
    author_login TEXT,
    state TEXT NOT NULL,
    body TEXT,
    commit_id TEXT,
    submitted_at TEXT,
    raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_comments (
    comment_id INTEGER PRIMARY KEY,
    node_id TEXT NOT NULL UNIQUE,
    item_id INTEGER NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
    author_login TEXT,
    body TEXT,
    path TEXT,
    position INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    raw_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pr_commits (
    item_id INTEGER NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
    commit_sha TEXT NOT NULL,
    author_login TEXT,
    committer_login TEXT,
    author_name TEXT,
    committer_name TEXT,
    raw_json TEXT NOT NULL,
    PRIMARY KEY(item_id, commit_sha)
);

CREATE TABLE IF NOT EXISTS associations (
    username TEXT NOT NULL,
    item_id INTEGER NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
    association_type TEXT NOT NULL,
    evidence_kind TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    evidence_field TEXT NOT NULL,
    evidence_text TEXT,
    created_at TEXT,
    PRIMARY KEY(username, item_id, association_type, evidence_kind, evidence_id, evidence_field)
);

CREATE TABLE IF NOT EXISTS sync_state (
    scope TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(scope, key)
);

CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    added_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS item_fts USING fts5(
    item_id UNINDEXED,
    repo_full_name,
    number UNINDEXED,
    item_type,
    title,
    body,
    comments,
    reviews,
    events
);
CREATE INDEX IF NOT EXISTS idx_items_repo_updated ON items(repo_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_items_repo_number ON items(repo_id, number);
CREATE INDEX IF NOT EXISTS idx_associations_username ON associations(username);
CREATE INDEX IF NOT EXISTS idx_associations_item ON associations(item_id);
CREATE INDEX IF NOT EXISTS idx_events_item ON events(item_id);
CREATE INDEX IF NOT EXISTS idx_comments_item ON comments(item_id);
CREATE INDEX IF NOT EXISTS idx_reviews_item ON reviews(item_id);
CREATE INDEX IF NOT EXISTS idx_review_comments_item ON review_comments(item_id);
CREATE INDEX IF NOT EXISTS idx_pr_commits_item ON pr_commits(item_id);
"""


VIEW_SCHEMA = """
CREATE VIEW user_associations AS
SELECT
    a.username,
    i.item_id,
    i.repo_full_name,
    i.number,
    i.item_type,
    i.state,
    i.title,
    i.updated_at,
    a.association_type,
    a.evidence_kind,
    a.evidence_id,
    a.evidence_field,
    a.evidence_text,
    a.created_at
FROM associations a
JOIN items i ON i.item_id = a.item_id;

CREATE VIEW prs AS
SELECT
    i.item_id AS pr_ref,
    i.repo_full_name AS repo,
    i.number,
    i.state AS status,
    i.author_login AS author,
    CAST(json_extract(i.expanded_json, '$.pull.graphql.isDraft') AS INTEGER) AS draft,
    coalesce(
        json_extract(i.expanded_json, '$.pull.assignees[0].login'),
        json_extract(i.expanded_json, '$.issue.assignees[0].login')
    ) AS owner_login,
    coalesce(
        json_extract(i.expanded_json, '$.pull.assignees[0].avatar_url'),
        json_extract(i.expanded_json, '$.pull.assignees[0].avatarUrl'),
        json_extract(i.expanded_json, '$.issue.assignees[0].avatar_url'),
        json_extract(i.expanded_json, '$.issue.assignees[0].avatarUrl')
    ) AS owner_avatar,
    i.updated_at,
    i.created_at,
    i.closed_at,
    CAST((julianday('now') - julianday(i.updated_at)) * 24 * 60 AS INTEGER) AS updated_minutes_ago,
    CAST((julianday('now') - julianday(i.created_at)) * 24 * 60 AS INTEGER) AS opened_minutes_ago,
    i.title,
    'https://github.com/' || i.repo_full_name || '/pull/' || i.number AS url,
    i.item_id AS diff_ref,
    i.item_id AS payload_ref,
    (SELECT count(*) FROM comments c WHERE c.item_id = i.item_id) AS comments_count,
    (SELECT count(*) FROM review_comments rc WHERE rc.item_id = i.item_id) AS review_comments_count,
    (SELECT count(*) FROM pr_commits pc WHERE pc.item_id = i.item_id) AS commits_count
FROM items i
WHERE i.item_type = 'pr';

CREATE VIEW issues AS
SELECT
    i.item_id AS issue_ref,
    i.repo_full_name AS repo,
    i.number,
    i.state AS status,
    i.author_login AS author,
    json_extract(i.expanded_json, '$.issue.assignees[0].login') AS owner_login,
    coalesce(
        json_extract(i.expanded_json, '$.issue.assignees[0].avatar_url'),
        json_extract(i.expanded_json, '$.issue.assignees[0].avatarUrl')
    ) AS owner_avatar,
    i.updated_at,
    i.created_at,
    i.closed_at,
    CAST((julianday('now') - julianday(i.updated_at)) * 24 * 60 AS INTEGER) AS updated_minutes_ago,
    CAST((julianday('now') - julianday(i.created_at)) * 24 * 60 AS INTEGER) AS opened_minutes_ago,
    i.title,
    'https://github.com/' || i.repo_full_name || '/issues/' || i.number AS url,
    i.item_id AS payload_ref,
    (SELECT count(*) FROM comments c WHERE c.item_id = i.item_id) AS comments_count
FROM items i
WHERE i.item_type = 'issue';

CREATE VIEW user_items AS
SELECT
    a.username,
    i.item_type,
    i.item_id AS item_ref,
    i.repo_full_name AS repo,
    i.number,
    i.state AS status,
    i.author_login AS author,
    CASE
        WHEN i.item_type = 'pr' THEN coalesce(
            json_extract(i.expanded_json, '$.pull.assignees[0].login'),
            json_extract(i.expanded_json, '$.issue.assignees[0].login')
        )
        ELSE json_extract(i.expanded_json, '$.issue.assignees[0].login')
    END AS owner_login,
    CASE
        WHEN i.item_type = 'pr' THEN coalesce(
            json_extract(i.expanded_json, '$.pull.assignees[0].avatar_url'),
            json_extract(i.expanded_json, '$.pull.assignees[0].avatarUrl'),
            json_extract(i.expanded_json, '$.issue.assignees[0].avatar_url'),
            json_extract(i.expanded_json, '$.issue.assignees[0].avatarUrl')
        )
        ELSE coalesce(
            json_extract(i.expanded_json, '$.issue.assignees[0].avatar_url'),
            json_extract(i.expanded_json, '$.issue.assignees[0].avatarUrl')
        )
    END AS owner_avatar,
    i.updated_at,
    i.created_at,
    i.closed_at,
    i.title,
    CASE
        WHEN i.item_type = 'pr' THEN 'https://github.com/' || i.repo_full_name || '/pull/' || i.number
        ELSE 'https://github.com/' || i.repo_full_name || '/issues/' || i.number
    END AS url,
    group_concat(DISTINCT a.association_type) AS reasons,
    count(*) AS evidence_count,
    CAST((julianday('now') - julianday(i.updated_at)) * 24 * 60 AS INTEGER) AS updated_minutes_ago
FROM associations a
JOIN items i ON i.item_id = a.item_id
GROUP BY
    a.username,
    i.item_id,
    i.item_type,
    i.repo_full_name,
    i.number,
    i.state,
    i.author_login,
    i.updated_at,
    i.created_at,
    i.closed_at,
    i.title;
"""


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    migrate_events_key(conn)
    version = int(conn.execute("PRAGMA user_version").fetchone()[0])
    views = {
        str(row["name"])
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'view'")
    }
    if version != VIEW_SCHEMA_VERSION or not VIEW_NAMES.issubset(views):
        recreate_views(conn)
        conn.execute(f"PRAGMA user_version = {VIEW_SCHEMA_VERSION}")


def recreate_views(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        DROP VIEW IF EXISTS user_items;
        DROP VIEW IF EXISTS issues;
        DROP VIEW IF EXISTS prs;
        DROP VIEW IF EXISTS user_associations;
        """
    )
    conn.executescript(VIEW_SCHEMA)


def migrate_events_key(conn: sqlite3.Connection) -> None:
    rows = conn.execute("PRAGMA table_info(events)").fetchall()
    pk_cols = [row["name"] for row in sorted(rows, key=lambda row: row["pk"]) if row["pk"]]
    if pk_cols == ["event_key"]:
        conn.execute("DROP TABLE events")
        conn.execute(
            """
            CREATE TABLE events (
                event_key TEXT NOT NULL,
                item_id INTEGER NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
                event_id INTEGER,
                node_id TEXT,
                event_type TEXT NOT NULL,
                actor_login TEXT,
                created_at TEXT,
                raw_json TEXT NOT NULL,
                PRIMARY KEY(item_id, event_key)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_events_item ON events(item_id)")


def set_state(conn: sqlite3.Connection, scope: str, key: str, value: str) -> None:
    conn.execute(
        """
        INSERT INTO sync_state(scope, key, value, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(scope, key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        """,
        (scope, key, value, utc_now()),
    )


def get_state(conn: sqlite3.Connection, scope: str, key: str) -> str | None:
    row = conn.execute(
        "SELECT value FROM sync_state WHERE scope = ? AND key = ?", (scope, key)
    ).fetchone()
    return None if row is None else str(row["value"])


def add_user(conn: sqlite3.Connection, username: str) -> None:
    conn.execute(
        """
        INSERT INTO users(username, added_at)
        VALUES (?, ?)
        ON CONFLICT(username) DO NOTHING
        """,
        (username, utc_now()),
    )


def list_users(conn: sqlite3.Connection) -> list[str]:
    return [str(row["username"]) for row in conn.execute("SELECT username FROM users ORDER BY username")]


def clear_index(conn: sqlite3.Connection) -> None:
    conn.execute("DELETE FROM item_fts")
    for table in (
        "associations",
        "pr_commits",
        "review_comments",
        "reviews",
        "comments",
        "events",
        "items",
        "repos",
        "sync_state",
    ):
        conn.execute(f"DELETE FROM {table}")


def prune_repos(conn: sqlite3.Connection, visible_repo_ids: list[int]) -> None:
    if not visible_repo_ids:
        raise ValueError("visible_repo_ids is empty")
    placeholders = ",".join("?" for _ in visible_repo_ids)
    conn.execute(
        f"""
        DELETE FROM item_fts
        WHERE item_id IN (
            SELECT item_id FROM items WHERE repo_id NOT IN ({placeholders})
        )
        """,
        visible_repo_ids,
    )
    conn.execute(f"DELETE FROM repos WHERE repo_id NOT IN ({placeholders})", visible_repo_ids)


def prune_items_for_repo(conn: sqlite3.Connection, repo_id: int, visible_item_ids: list[int]) -> None:
    if visible_item_ids:
        placeholders = ",".join("?" for _ in visible_item_ids)
        params: list[int] = [repo_id, *visible_item_ids]
        conn.execute(
            f"""
            DELETE FROM item_fts
            WHERE item_id IN (
                SELECT item_id FROM items
                WHERE repo_id = ? AND item_id NOT IN ({placeholders})
            )
            """,
            params,
        )
        conn.execute(
            f"DELETE FROM items WHERE repo_id = ? AND item_id NOT IN ({placeholders})",
            params,
        )
    else:
        conn.execute(
            "DELETE FROM item_fts WHERE item_id IN (SELECT item_id FROM items WHERE repo_id = ?)",
            (repo_id,),
        )
        conn.execute("DELETE FROM items WHERE repo_id = ?", (repo_id,))


def require(value: Any, label: str) -> Any:
    if value is None or value == "":
        raise ValueError(f"missing required value: {label}")
    return value


def login(value: dict[str, Any] | None) -> str | None:
    if value is None:
        return None
    raw = value.get("login")
    return None if raw is None else str(raw)


def stable_key(kind: str, value: dict[str, Any]) -> str:
    if value.get("node_id"):
        return f"{kind}:node:{value['node_id']}"
    if value.get("id") is not None:
        return f"{kind}:id:{value['id']}"
    if kind == "commit" and value.get("sha"):
        return f"{kind}:sha:{value['sha']}"
    if kind == "event":
        digest = hashlib.sha256(dumps(value).encode("utf-8")).hexdigest()
        return f"{kind}:hash:{digest}"
    raise ValueError(f"{kind} object lacks node_id/id")


def upsert_repo(conn: sqlite3.Connection, repo: dict[str, Any]) -> None:
    repo_id = int(require(repo.get("id"), "repo.id"))
    owner = require(repo.get("owner"), "repo.owner")
    conn.execute(
        """
        INSERT INTO repos(repo_id, node_id, owner, name, full_name, private, archived,
                          has_issues, raw_json, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(repo_id) DO UPDATE SET
            node_id = excluded.node_id,
            owner = excluded.owner,
            name = excluded.name,
            full_name = excluded.full_name,
            private = excluded.private,
            archived = excluded.archived,
            has_issues = excluded.has_issues,
            raw_json = excluded.raw_json,
            synced_at = excluded.synced_at
        """,
        (
            repo_id,
            require(repo.get("node_id"), "repo.node_id"),
            require(owner.get("login"), "repo.owner.login"),
            require(repo.get("name"), "repo.name"),
            require(repo.get("full_name"), "repo.full_name"),
            int(bool(repo.get("private"))),
            int(bool(repo.get("archived"))),
            int(bool(repo.get("has_issues"))),
            dumps(repo),
            utc_now(),
        ),
    )


def upsert_expanded_item(conn: sqlite3.Connection, expanded: dict[str, Any]) -> int:
    issue = expanded["issue"]
    repo = expanded["repo"]
    item_type = "pr" if expanded["is_pr"] else "issue"
    item_id = int(require(issue.get("id"), "issue.id"))
    repo_id = int(require(repo.get("id"), "repo.id"))
    conn.execute(
        """
        INSERT INTO items(item_id, node_id, repo_id, repo_full_name, number, item_type,
                          state, title, body, author_login, created_at, updated_at,
                          closed_at, raw_json, expanded_json, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET
            node_id = excluded.node_id,
            repo_id = excluded.repo_id,
            repo_full_name = excluded.repo_full_name,
            number = excluded.number,
            item_type = excluded.item_type,
            state = excluded.state,
            title = excluded.title,
            body = excluded.body,
            author_login = excluded.author_login,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            closed_at = excluded.closed_at,
            raw_json = excluded.raw_json,
            expanded_json = excluded.expanded_json,
            synced_at = excluded.synced_at
        """,
        (
            item_id,
            require(issue.get("node_id"), "issue.node_id"),
            repo_id,
            require(repo.get("full_name"), "repo.full_name"),
            int(require(issue.get("number"), "issue.number")),
            item_type,
            require(issue.get("state"), "issue.state"),
            require(issue.get("title"), "issue.title"),
            issue.get("body"),
            login(issue.get("user")),
            require(issue.get("created_at"), "issue.created_at"),
            require(issue.get("updated_at"), "issue.updated_at"),
            issue.get("closed_at"),
            dumps(issue),
            dumps(expanded),
            utc_now(),
        ),
    )
    return item_id


def replace_child_rows(conn: sqlite3.Connection, item_id: int, expanded: dict[str, Any]) -> None:
    for table in ("events", "comments", "reviews", "review_comments", "pr_commits"):
        conn.execute(f"DELETE FROM {table} WHERE item_id = ?", (item_id,))

    for event in expanded["timeline"]:
        conn.execute(
            """
            INSERT INTO events(event_key, item_id, event_id, node_id, event_type,
                               actor_login, created_at, raw_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                stable_key("event", event),
                item_id,
                event.get("id"),
                event.get("node_id"),
                require(event.get("event"), "event.event"),
                login(event.get("actor")),
                event.get("created_at"),
                dumps(event),
            ),
        )

    for comment in expanded["comments"]:
        conn.execute(
            """
            INSERT INTO comments(comment_id, node_id, item_id, author_login, body,
                                 created_at, updated_at, raw_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                int(require(comment.get("id"), "comment.id")),
                require(comment.get("node_id"), "comment.node_id"),
                item_id,
                login(comment.get("user")),
                comment.get("body"),
                require(comment.get("created_at"), "comment.created_at"),
                require(comment.get("updated_at"), "comment.updated_at"),
                dumps(comment),
            ),
        )

    for review in expanded["reviews"]:
        conn.execute(
            """
            INSERT INTO reviews(review_id, node_id, item_id, author_login, state, body,
                                commit_id, submitted_at, raw_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                int(require(review.get("id"), "review.id")),
                require(review.get("node_id"), "review.node_id"),
                item_id,
                login(review.get("user")),
                require(review.get("state"), "review.state"),
                review.get("body"),
                review.get("commit_id"),
                review.get("submitted_at"),
                dumps(review),
            ),
        )

    for comment in expanded["review_comments"]:
        conn.execute(
            """
            INSERT INTO review_comments(comment_id, node_id, item_id, author_login, body,
                                        path, position, created_at, updated_at, raw_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                int(require(comment.get("id"), "review_comment.id")),
                require(comment.get("node_id"), "review_comment.node_id"),
                item_id,
                login(comment.get("user")),
                comment.get("body"),
                comment.get("path"),
                comment.get("position"),
                require(comment.get("created_at"), "review_comment.created_at"),
                require(comment.get("updated_at"), "review_comment.updated_at"),
                dumps(comment),
            ),
        )

    for commit in expanded["commits"]:
        author = commit.get("author") or {}
        committer = commit.get("committer") or {}
        raw_commit = commit.get("commit") or {}
        raw_author = raw_commit.get("author") or {}
        raw_committer = raw_commit.get("committer") or {}
        conn.execute(
            """
            INSERT INTO pr_commits(item_id, commit_sha, author_login, committer_login,
                                   author_name, committer_name, raw_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                item_id,
                require(commit.get("sha"), "commit.sha"),
                login(author),
                login(committer),
                raw_author.get("name"),
                raw_committer.get("name"),
                dumps(commit),
            ),
        )


def replace_associations(
    conn: sqlite3.Connection, item_id: int, username: str, associations: Iterable[dict[str, Any]]
) -> None:
    conn.execute(
        "DELETE FROM associations WHERE item_id = ? AND lower(username) = lower(?)",
        (item_id, username),
    )
    for assoc in associations:
        conn.execute(
            """
            INSERT INTO associations(username, item_id, association_type, evidence_kind,
                                     evidence_id, evidence_field, evidence_text, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                username,
                item_id,
                require(assoc.get("association_type"), "association.association_type"),
                require(assoc.get("evidence_kind"), "association.evidence_kind"),
                require(assoc.get("evidence_id"), "association.evidence_id"),
                require(assoc.get("evidence_field"), "association.evidence_field"),
                assoc.get("evidence_text"),
                assoc.get("created_at"),
            ),
        )


def refresh_fts(conn: sqlite3.Connection, item_id: int, expanded: dict[str, Any]) -> None:
    issue = expanded["issue"]
    conn.execute("DELETE FROM item_fts WHERE item_id = ?", (item_id,))
    conn.execute(
        """
        INSERT INTO item_fts(item_id, repo_full_name, number, item_type, title, body,
                             comments, reviews, events)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            item_id,
            expanded["repo"]["full_name"],
            issue["number"],
            "pr" if expanded["is_pr"] else "issue",
            issue.get("title") or "",
            issue.get("body") or "",
            "\n".join((c.get("body") or "") for c in expanded["comments"]),
            "\n".join((r.get("body") or "") for r in expanded["reviews"])
            + "\n"
            + "\n".join((c.get("body") or "") for c in expanded["review_comments"]),
            "\n".join(
                f"{e.get('event','')} {login(e.get('actor')) or ''}" for e in expanded["timeline"]
            ),
        ),
    )


def assert_no_duplicate_items(conn: sqlite3.Connection) -> None:
    duplicates = conn.execute(
        """
        SELECT repo_id, number, count(*) AS count
        FROM items
        GROUP BY repo_id, number
        HAVING count(*) > 1
        """
    ).fetchall()
    if duplicates:
        raise RuntimeError(f"duplicate canonical item keys: {[dict(row) for row in duplicates]}")
