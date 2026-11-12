"""One bounded maintenance pass over original native resource receipts.

Claims coordinate cleaners only. This module cannot launch a behavior, repeat
publication, or turn process/path absence into resource-release evidence.
"""
from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path
from time import monotonic, time
from uuid import uuid4

from . import native_namespace, process_identity, resource_ownership as ownership

MAX_CALLS = 16
PASS_SECONDS = 15


def _failure_wait(previous: dict) -> dict:
    failures = previous.get("failures", 0)
    if type(failures) is not int or not 0 <= failures <= 1000:
        raise RuntimeError("native cleanup failure count is invalid")
    failures = min(1000, failures + 1)
    delay = min(600, 60 * 2 ** min(4, max(0, failures - 3)))
    return {"failures": failures, "next_attempt_at": time() + delay}


def _claim(database: Path, call_id: str) -> tuple[str | None, str | None]:
    with ownership._database(database) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("begin immediate")
        row = conn.execute("select pid,process_identity,resources_settled_at,resource_cleanup from calls where id=? "
                           "and source='poise:behavior-chain'", (call_id,)).fetchone()
        if row is None:
            raise RuntimeError("native cleanup Call is unavailable")
        # The candidate list can predate another worker's settlement or retry.
        if row["resources_settled_at"] is not None and row["resource_cleanup"] is None:
            return None, None
        previous = json.loads(row["resource_cleanup"] or "{}")
        if not isinstance(previous, dict) or len(json.dumps(previous).encode()) > 8192:
            raise RuntimeError("native cleanup claim is invalid")
        next_attempt = previous.get("next_attempt_at")
        if next_attempt is not None and next_attempt > time():
            return None, None
        reason = None
        try:
            if previous.get("owner") is not None:
                cleaner = json.loads(previous["owner"])
                state = process_identity.state(previous["owner"], cleaner["pid"])
                if state == "alive":
                    reason = "original cleanup worker still owns its claim"
                elif state == "different" and cleaner.get("epoch") != process_identity.epoch():
                    reason = "cleanup owner belongs to another workspace epoch; original termination proof is unavailable"
            if reason is None:
                state = process_identity.state(row["process_identity"], int(row["pid"]))
                if state == "alive":
                    reason = "original Caller still owns its normal cleanup"
                elif state == "different" and json.loads(row["process_identity"]).get("epoch") != process_identity.epoch():
                    reason = "original Caller belongs to another workspace epoch; original termination proof is unavailable"
        except (OSError, RuntimeError, ValueError, TypeError, KeyError) as error:
            reason = f"cleanup ownership cannot be verified: {error}"
        if reason:
            retry = {"next_attempt_at": time() + 60} if reason in {
                "original cleanup worker still owns its claim", "original Caller still owns its normal cleanup"} else _failure_wait(previous)
            previous.update(attempt_at=time(), last_error=reason[:2000], **retry)
            conn.execute("update calls set resource_cleanup=? where id=?", (json.dumps(previous), call_id))
            return None, reason
        token = uuid4().hex
        claim = {"token": token, "owner": process_identity.capture(os.getpid()), "attempt_at": time(),
                 "failures": previous.get("failures", 0)}
        conn.execute("update calls set resource_cleanup=? where id=?", (json.dumps(claim), call_id))
        return token, None


def _current(conn: sqlite3.Connection, call_id: str, token: str) -> dict:
    row = conn.execute("select resource_cleanup from calls where id=?", (call_id,)).fetchone()
    claim = json.loads(row[0] or "null") if row else None
    if not isinstance(claim, dict) or claim.get("token") != token \
            or not process_identity.owns_registration(claim.get("owner")):
        raise RuntimeError("native cleanup no longer owns its claim")
    return claim


def _wait(database: Path, call_id: str, token: str, reason: str) -> None:
    with ownership._database(database) as conn:
        conn.execute("begin immediate")
        claim = _current(conn, call_id, token)
        conn.execute("update calls set resource_cleanup=? where id=?",
                     (json.dumps({"attempt_at": claim["attempt_at"], "last_error": reason[:2000], **_failure_wait(claim)}), call_id))


def _settle_process(database: Path, call_id: str) -> dict:
    with ownership._database(database) as conn:
        value = ownership.read(conn, call_id)
        row = conn.execute("select namespace_control from calls where id=?", (call_id,)).fetchone()
    namespace = value["namespace"]
    before_go = namespace["state"] == "requested"
    if namespace["state"] == "not_started":
        return value
    if namespace["state"] == "requested":
        private = json.loads(row[0] or "null")
        if not isinstance(private, dict) or native_namespace.control_address() != private.get("address"):
            raise RuntimeError("original native cleanup controller is unavailable")
        key = {name: private[name] for name in ("callId", "correlation", "token")}
        observed = native_namespace.control_request(private["address"], "read", **key)
        if observed.get("callId") != call_id or observed.get("correlation") != namespace["correlation"]:
            raise RuntimeError("native cleanup observed another Call")
        ownership.register_namespace(database, call_id,
                                     {"controller": private["address"], **key, "binding": observed["binding"]})
        with ownership._database(database) as conn:
            value = ownership.read(conn, call_id)
    scope = ownership.original_scope(database, call_id, value)
    ownership.settle_namespace(database, call_id, scope)
    if before_go:
        # GO follows the durable active commit. A retained original empty
        # witness plus the still-requested claim proves this body never ran.
        with ownership._database(database) as conn:
            conn.execute("begin immediate")
            current = ownership.read(conn, call_id)
            row = conn.execute("select action_plan,response_path,artifact,status from calls where id=?", (call_id,)).fetchone()
            if current["roots"] or any(row[index] is not None for index in range(3)) or row[3] != "failed":
                raise RuntimeError("pre-GO recovery conflicts with native execution evidence")
            current["namespace"]["no_effect"] = "verified-pre-go"
            ownership._write(conn, call_id, current)
            conn.execute("update calls set action='not_started',outcome='preflight_failed' where id=?", (call_id,))
    with ownership._database(database) as conn:
        value = ownership.read(conn, call_id)
    if value.get("process_pending"):
        if not scope.read()["empty"]:
            raise RuntimeError("original native namespace is not empty")
        ownership.process_check(database, call_id, complete=True)
    return value


def _complete(database: Path, call_id: str, token: str) -> bool:
    from . import mark_managed_no_write
    with ownership._database(database) as conn:
        conn.execute("begin immediate")
        _current(conn, call_id, token)
        value = ownership.read(conn, call_id)
        if not ownership.released(value):
            return False
        row = conn.execute("select status from calls where id=?", (call_id,)).fetchone()
        if row[0] == "running":
            raise RuntimeError("native cleanup requires the original terminal outcome")
        conn.execute("update calls set resources_settled_at=? where id=? and resources_settled_at is null", (time(), call_id))
        mark_managed_no_write(conn, call_id)
    if value["namespace"]["state"] == "settled":
        ownership.original_scope(database, call_id, value).retire()
    with ownership._database(database) as conn:
        conn.execute("begin immediate")
        _current(conn, call_id, token)
        conn.execute("update calls set resource_cleanup=null where id=?", (call_id,))
    return True


def recover(database: Path, *, limit: int = MAX_CALLS, seconds: int = PASS_SECONDS, dry_run: bool = False) -> dict:
    if type(limit) is not int or not 1 <= limit <= MAX_CALLS or type(seconds) is not int or not 1 <= seconds <= PASS_SECONDS:
        raise ValueError("native cleanup requires at most 16 Calls and 15 seconds")
    deadline = monotonic() + seconds
    report = {"version": 1, "examined": 0, "released": [], "held": []}
    with ownership._database(database) as conn:
        rows = conn.execute("select id from calls where source='poise:behavior-chain' "
                            "and json_valid(resource_ownership) and json_extract(resource_ownership,'$.version')=2 "
                            "and (resources_settled_at is null or resource_cleanup is not null) "
                            "and coalesce(json_extract(resource_cleanup,'$.next_attempt_at'),0) <= ? "
                            "order by coalesce(json_extract(resource_cleanup,'$.next_attempt_at'),0),"
                            "coalesce(json_extract(resource_cleanup,'$.attempt_at'),0),started_at,id limit ?", (time(), limit)).fetchall()
    for (call_id,) in rows:
        if monotonic() >= deadline:
            break
        token = None
        try:
            if dry_run:
                with ownership._database(database) as conn:
                    ownership.read(conn, call_id)
                report["held"].append({"callId": call_id, "reason": "dry run retains original native resource ownership"})
                continue
            token, reason = _claim(database, call_id)
            if token is None:
                if reason is not None:
                    report["held"].append({"callId": call_id, "reason": reason})
                continue
            with ownership._database(database) as conn:
                value = ownership.read(conn, call_id)
                completed = conn.execute("select resources_settled_at from calls where id=?", (call_id,)).fetchone()[0] is not None
            if not completed:
                if not ownership.released(value):
                    _settle_process(database, call_id)
                    ownership.cleanup_remaining(database, call_id, claim=token, deadline=deadline)
                    ownership.acknowledge_recovery(database, call_id)
            if _complete(database, call_id, token):
                report["released"].append(call_id)
            else:
                reason = "original native resources still lack complete positive reclamation proof"
                _wait(database, call_id, token, reason)
                report["held"].append({"callId": call_id, "reason": reason})
        except (OSError, RuntimeError, ValueError, TypeError, KeyError) as error:
            reason = str(error)[:2000]
            if token is not None:
                _wait(database, call_id, token, reason)
                with ownership._database(database) as conn:
                    pending = conn.execute("select resources_settled_at from calls where id=?", (call_id,)).fetchone()[0] is None
                if pending:
                    try:
                        ownership.failure(database, call_id, reason)
                    except (OSError, RuntimeError, ValueError, TypeError, KeyError) as diagnostic_error:
                        reason = f"{reason}; cleanup diagnostic could not be recorded: {diagnostic_error}"
            report["held"].append({"callId": call_id, "reason": reason})
    report["examined"] = len(report["released"]) + len(report["held"])
    return report
