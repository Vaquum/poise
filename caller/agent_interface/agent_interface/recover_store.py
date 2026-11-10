"""Operator-only activation of a verified Caller recovery in its original workspace."""
from __future__ import annotations

import argparse
from contextlib import closing
from hashlib import file_digest
import json
import os
from pathlib import Path
import sqlite3
import stat
from urllib.request import ProxyHandler, build_opener

if __package__:
    from . import caller_store
else:
    import caller_store


def _sha256(path: Path) -> str:
    if not stat.S_ISREG(path.lstat().st_mode):
        raise RuntimeError(f"Recovery file is not regular: {path.name}")
    with path.open("rb") as source:
        return file_digest(source, "sha256").hexdigest()


def _sqlite(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=0)
    connection.text_factory = bytes
    return connection


def _schema(database: sqlite3.Connection) -> list[tuple]:
    return database.execute("select type,name,sql from sqlite_schema where sql is not null order by type,name").fetchall()


def _integrity(database: sqlite3.Connection) -> None:
    if database.execute("pragma integrity_check").fetchall() != [(b"ok",)] \
            or database.execute("pragma foreign_key_check").fetchone() is not None:
        raise RuntimeError("Caller recovery database failed integrity checks")


def _column_types(database: sqlite3.Connection, table: str) -> str:
    names = ['"' + column[1].decode().replace('"', '""') + '"' for column in database.execute(f"pragma table_info({table})")]
    return ",".join(f"typeof({name})" for name in names)


def _same_contents(current: sqlite3.Connection, candidate: sqlite3.Connection, manifest: dict) -> None:
    schema = _schema(current)
    other_tables = ("diagnostic_calls", "diagnostic_stream", "chat_sessions", "sqlite_sequence")
    if schema != _schema(candidate) or {name for kind, name, _ in schema if kind == b"table"} != {
        name.encode() for name in ("calls", *other_tables)
    }:
        raise RuntimeError("Caller recovery schema differs from the original")
    for table in other_tables:
        query = f"select rowid,*,{_column_types(current, table)} from {table} order by rowid"
        if current.execute(query).fetchall() != candidate.execute(query).fetchall():
            raise RuntimeError(f"Caller recovery {table} changed since staging")
    keys = "select rowid,id from calls indexed by sqlite_autoindex_calls_1 order by rowid"
    original = current.execute(keys).fetchall()
    omitted = {row["rowid"]: row for row in manifest["unreadable_omitted"]}
    expected = [(rowid, call_id) for rowid, call_id in original if rowid not in omitted]
    if len(original) != manifest["source_rows"] or len(expected) != manifest["candidate_rows"] \
            or len(original) - len(expected) != len(omitted) or candidate.execute(keys).fetchall() != expected \
            or original[-1:] != expected[-1:]:
        raise RuntimeError("Caller recovery Call identities changed since staging")
    statuses = dict(current.execute("select rowid,status from calls indexed by calls_status_started"))
    sessions = dict(current.execute("select rowid,session_id from calls indexed by calls_session_behavior"))
    correlations = dict(current.execute(
        "select rowid,correlation_id from calls indexed by calls_correlation_id_unique where correlation_id is not null"
    ))
    if b"running" in statuses.values():
        raise RuntimeError("Caller still records running work")
    read = f"select *,{_column_types(current, 'calls')} from calls not indexed where rowid=?"
    for rowid, call_id in original:
        excluded = omitted.get(rowid)
        try:
            row = current.execute(read, (rowid,)).fetchone()
        except sqlite3.DatabaseError as error:
            if excluded is None or getattr(error, "sqlite_errorcode", 0) & 255 != sqlite3.SQLITE_CORRUPT \
                    or excluded["code"] != "SQLITE_CORRUPT" or call_id != excluded["call_id"].encode() \
                    or correlations.get(rowid) != excluded["correlation_id"].encode() or not correlations.get(rowid) \
                    or statuses.get(rowid) != excluded["status"].encode() or statuses[rowid] not in (b"completed", b"failed") \
                    or sessions.get(rowid):
                raise RuntimeError("Caller recovery omission lacks matching original evidence") from error
            continue
        if row is None or excluded is not None or candidate.execute(read, (rowid,)).fetchone() != row:
            raise RuntimeError(f"Caller recovery Call at row {rowid} changed since staging")


def _activate(current: sqlite3.Connection, candidate: sqlite3.Connection, manifest: dict) -> None:
    current.text_factory = bytes
    candidate.execute("begin")
    _integrity(candidate)
    if current.execute("pragma locking_mode=exclusive").fetchone() != (b"exclusive",):
        raise RuntimeError("Caller recovery could not establish exclusive locking")
    current.execute("begin immediate")
    _same_contents(current, candidate, manifest)
    if not current.in_transaction:
        raise RuntimeError("Caller recovery lost the original write lock")
    current.rollback()

    def refuse_busy(status: int, _remaining: int, _total: int) -> None:
        if status in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
            raise RuntimeError("Caller recovery backup is busy")

    # Exclusive locking retains the original lock between the proof and backup.
    candidate.backup(current, progress=refuse_busy)
    _integrity(current)


def _service_ready(port: str, release: str) -> None:
    local = build_opener(ProxyHandler({}))
    root = f"http://127.0.0.1:{int(port)}"
    with local.open(root + "/api/service/health", timeout=5) as reply:
        health = json.load(reply)
    if health.get("ok") is not True or health.get("release") != release or health.get("switching") is not None \
            or health.get("draining") is not True or health.get("activeChatTurns") != 0 \
            or health.get("runningCallerCalls") != 0 or type(health.get("unsettledNativeCalls")) is not int \
            or health.get("backgroundWork") != health["unsettledNativeCalls"]:
        raise RuntimeError("Caller recovery requires the active release drained with no writers in flight")
    with local.open(root + "/api/behavior-chains?state=active", timeout=5) as reply:
        chain = json.load(reply)
    if chain.get("capacity", {}).get("enabled") is not False or chain.get("settings", {}).get("enabled") is not False:
        raise RuntimeError("Caller recovery requires paused behavior admissions")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("staging", type=Path)
    parser.add_argument("--service-pid", type=int, required=True)
    parser.add_argument("--apply-manifest", required=True, help="SHA-256 of the reviewed verification.json")
    args = parser.parse_args()
    environment = dict(item.split(b"=", 1) for item in Path(f"/proc/{args.service_pid}/environ").read_bytes().split(b"\0") if b"=" in item)
    config = {name: environment[name.encode()].decode() for name in (
        "AGENT_INTERFACE_ROOT", "AGENT_INTERFACE_DATA_DIR", "POISE_NATIVE_CONTROL", "POISE_RELEASE", "POISE_PORT"
    )}
    if Path(__file__).resolve().parents[1] != Path(config["AGENT_INTERFACE_ROOT"]).resolve(strict=True):
        raise RuntimeError("Recovery must run from the active workspace release")
    data = Path(config["AGENT_INTERFACE_DATA_DIR"])
    root = (data.parent / "incident-recovery").resolve(strict=True)
    stage = args.staging.resolve(strict=True)
    if not stage.is_relative_to(root) or stage.stat().st_uid != os.getuid() or stage.stat().st_mode & 0o077:
        raise RuntimeError("Caller recovery requires private incident staging")
    manifest_path = stage / "verification.json"
    if _sha256(manifest_path) != args.apply_manifest:
        raise RuntimeError("Caller recovery manifest digest differs")
    manifest = json.loads(manifest_path.read_bytes())
    source = manifest["source_sha256"]
    if set(source) not in ({"calls.sqlite3"}, {"calls.sqlite3", "calls.sqlite3-wal", "calls.sqlite3-shm"}):
        raise RuntimeError("Caller recovery archive companions are incomplete")
    for name, checksum in source.items():
        if _sha256(stage / ("source-" + name)) != checksum:
            raise RuntimeError(f"Caller recovery archive digest differs: {name}")
    candidate = stage / "recovered.sqlite3"
    if _sha256(candidate) != manifest["candidate_sha256"] or any(
        Path(f"{candidate}{suffix}").exists() for suffix in ("-wal", "-shm", "-journal")
    ):
        raise RuntimeError("Caller recovery candidate digest or companions differ")
    os.environ["POISE_NATIVE_CONTROL"] = config["POISE_NATIVE_CONTROL"]
    if caller_store._store() is None:
        raise RuntimeError("Caller recovery lacks the original live supervisor")
    caller_store.require_current_path(data)
    original = data / "calls.sqlite3"
    identity = original.lstat()
    if [identity.st_dev, identity.st_ino] != manifest["source_metadata"]["calls.sqlite3"][:2]:
        raise RuntimeError("Caller recovery archive is from a different original store")
    _service_ready(config["POISE_PORT"], config["POISE_RELEASE"])
    with closing(_sqlite(candidate)) as recovered, closing(caller_store.connect(original, timeout=0)) as current:
        _activate(current, recovered, manifest)
    caller_store.require_current_path(data)
    restored = original.lstat()
    if (restored.st_dev, restored.st_ino) != (identity.st_dev, identity.st_ino):
        raise RuntimeError("Caller recovery original store identity changed")
    print(json.dumps({"restored": manifest["candidate_rows"], "archivedUnreadable": len(manifest["unreadable_omitted"])}))


if __name__ == "__main__":
    main()
