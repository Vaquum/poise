from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime

import pytest

from github_datastore.cli import main
from github_datastore.health import health


def test_health_reports_fresh_sync(tmp_path):
    db_path = tmp_path / "github.sqlite"
    _state(db_path, "2026-07-17T07:59:00Z", "2026-07-17T08:00:00Z")

    result = health(
        db_path,
        max_age_seconds=120,
        now=datetime(2026, 7, 17, 8, 1, tzinfo=UTC),
    )

    assert result["action"] == "health"
    assert result["healthy"] is True
    assert result["status"] == "healthy"
    assert result["age_seconds"] == 60


def test_health_reports_stale_sync(tmp_path):
    db_path = tmp_path / "github.sqlite"
    _state(db_path, "2026-07-17T07:55:00Z", "2026-07-17T07:56:00Z")

    result = health(
        db_path,
        max_age_seconds=120,
        now=datetime(2026, 7, 17, 8, 1, tzinfo=UTC),
    )

    assert result["healthy"] is False
    assert result["status"] == "stale"
    assert result["age_seconds"] == 300


def test_stale_health_cli_keeps_json_and_explains_refusal_on_stderr(tmp_path, capsys):
    db_path = tmp_path / "github.sqlite"
    _state(db_path, "2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z")

    with pytest.raises(SystemExit) as error:
        main(["--db", str(db_path), "health", "--max-age-seconds", "120"])

    assert error.value.code == 1
    output = capsys.readouterr()
    result = json.loads(output.out)
    assert result["status"] == "stale"
    assert result["healthy"] is False
    assert output.err == (
        f"datastore health stale: last successful sync {result['last_success_at']}; "
        f"age {result['age_seconds']}s exceeds maximum {result['max_age_seconds']}s\n"
    )


def test_health_fails_without_sync_state(tmp_path):
    db_path = tmp_path / "github.sqlite"
    sqlite3.connect(db_path).close()

    with pytest.raises(RuntimeError, match="query failed"):
        health(db_path)


def _state(db_path, value: str, updated_at: str) -> None:
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """CREATE TABLE sync_state (
                 scope TEXT NOT NULL,
                 key TEXT NOT NULL,
                 value TEXT NOT NULL,
                 updated_at TEXT NOT NULL,
                 PRIMARY KEY(scope, key)
               )"""
        )
        conn.execute(
            "INSERT INTO sync_state VALUES ('org', 'last_sync_at', ?, ?)",
            (value, updated_at),
        )
