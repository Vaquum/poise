from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def health(
    db_path: str | Path,
    max_age_seconds: int = 120,
    now: datetime | None = None,
) -> dict[str, Any]:
    if max_age_seconds <= 0:
        raise ValueError("max-age-seconds must be positive")
    checked = (now or datetime.now(UTC)).astimezone(UTC)
    if checked.tzinfo is None:
        raise ValueError("health clock must include timezone")

    path = Path(db_path).resolve()
    uri = path.as_uri() + "?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True)
    except sqlite3.Error as error:
        raise RuntimeError(f"datastore health could not open {path}: {error}") from error
    try:
        row = conn.execute(
            """SELECT value, updated_at
               FROM sync_state
               WHERE scope = 'org' AND key = 'last_sync_at'"""
        ).fetchone()
    except sqlite3.Error as error:
        raise RuntimeError(f"datastore health query failed: {error}") from error
    finally:
        conn.close()

    if row is None:
        raise RuntimeError("datastore health has no org.last_sync_at state")
    last_sync_at = _timestamp(str(row[0]), "last_sync_at")
    last_success_at = _timestamp(str(row[1]), "last_success_at")
    age_seconds = max(0, int((checked - last_success_at).total_seconds()))
    healthy = age_seconds <= max_age_seconds
    return {
        "action": "health",
        "status": "healthy" if healthy else "stale",
        "healthy": healthy,
        "database": str(path),
        "max_age_seconds": max_age_seconds,
        "age_seconds": age_seconds,
        "last_sync_at": _iso(last_sync_at),
        "last_success_at": _iso(last_success_at),
        "checked_at": _iso(checked),
    }


def _timestamp(value: str, field: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise RuntimeError(f"datastore health has invalid {field}") from error
    if parsed.tzinfo is None:
        raise RuntimeError(f"datastore health has timezone-free {field}")
    return parsed.astimezone(UTC)


def _iso(value: datetime) -> str:
    return value.replace(microsecond=0).isoformat().replace("+00:00", "Z")
