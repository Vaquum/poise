from __future__ import annotations

import json
import hashlib
import os
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from time import sleep, time
from uuid import uuid4

from . import (
    atoms,
    atomic_work,
    author_content,
    chat,
    debate,
    fix_failing_ci,
    issue_review,
    issue_simplify,
    pr_approve,
    pr_review,
    pr_stop_gate,
    progress,
    review_budget,
    review_receipt,
)
from .model_catalog import CATALOG, ModelCatalogError
from .process_diagnostic import diagnostic_envelope
from .review_watch import ReviewSuperseded
from .review_watch import _interrupted as review_watch_interrupted

__version__ = "0.3.0"

DATA_DIR = Path(os.getenv("AGENT_INTERFACE_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
DB = DATA_DIR / "calls.sqlite3"
RESPONSES = DATA_DIR / "responses"
LOG_OWNER_SQL = "lower(substr(repo || '/',1,instr(repo || '/','/')-1))"


def db():
    conn = sqlite3.connect(DB, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    RESPONSES.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        # WAL first, outside any transaction: readers stop blocking writers'
        # commits and commits stop blocking readers. The mode persists in the
        # file, so old releases keep working and repeats cost nothing. A live
        # workspace may hold the lock; retry, then fail naming the file.
        for _ in range(50):
            try:
                mode = conn.execute("pragma journal_mode=WAL").fetchone()[0]
            except sqlite3.OperationalError as e:
                if "locked" not in str(e).lower():
                    raise
                sleep(0.1)
                continue
            if str(mode).lower() != "wal":
                raise RuntimeError(f"calls database {DB} did not switch to WAL (journal_mode={mode})")
            break
        else:
            raise RuntimeError(f"calls database {DB} is locked; could not switch to WAL")
        conn.execute(
            "create table if not exists calls (id text primary key, model text, prompt text, started_at real, ended_at real, status text, response_path text, error text)"
        )
        cols = {r["name"] for r in conn.execute("pragma table_info(calls)")}
        for col in (
            "pr_id",
            "repo",
            "actor",
            "behavior",
            "session_id",
            "outcome",
            "head_sha",
            "expected_head",
            "source",
            "correlation_id",
            "action",
            "error_code",
            "progress",
            "review_policy",
            "recovery_model",
            "pid",
            "review_id",
            "runner",
            "receipts",
            "review_comments",
            "diagnostic",
            "artifact",
            "resources_settled_at",
            "issue_revision",
            "action_plan",
        ):
            if col not in cols:
                try:
                    conn.execute(f"alter table calls add column {col} text")
                except sqlite3.OperationalError as e:
                    if "duplicate column" not in str(e):
                        raise
        duplicates = conn.execute(
            """select correlation_id, count(*) as uses
               from calls
               where correlation_id is not null
               group by correlation_id
               having count(*) > 1"""
        ).fetchall()
        if duplicates:
            raise RuntimeError(
                "calls contains duplicate correlation ids: "
                + ", ".join(f"{row['correlation_id']} ({row['uses']})" for row in duplicates)
            )
        conn.execute(
            """create unique index if not exists calls_correlation_id_unique
               on calls(correlation_id)
               where correlation_id is not null"""
        )

        conn.executescript("""
            create table if not exists diagnostic_calls (
                seq integer primary key autoincrement, call_id text not null unique
            );
            create index if not exists calls_diagnostic_pending on calls(ended_at,id)
                where status != 'running' and (coalesce(error,'') != '' or error_code is not null or diagnostic is not null);
            create index if not exists calls_status_started on calls(status, started_at);
            create index if not exists calls_behavior_owner_started on calls(
                behavior, source, lower(substr(repo || '/',1,instr(repo || '/','/')-1)), started_at desc, id desc
            ) where repo is not null and repo != '' and pr_id is not null and pr_id != '';
            create index if not exists calls_owner on calls(
                lower(substr(repo || '/',1,instr(repo || '/','/')-1))
            );
            create index if not exists calls_session_behavior on calls(session_id, behavior);
            create trigger if not exists calls_diagnostic_insert after insert on calls
            when new.status != 'running' and (coalesce(new.error,'') != '' or new.error_code is not null or new.diagnostic is not null)
            begin insert or ignore into diagnostic_calls(call_id) values(new.id); end;
            create trigger if not exists calls_diagnostic_update after update of status,error,error_code,diagnostic on calls
            when new.status != 'running' and (coalesce(new.error,'') != '' or new.error_code is not null or new.diagnostic is not null)
            begin insert or ignore into diagnostic_calls(call_id) values(new.id); end;
        """)
        conn.execute("create table if not exists diagnostic_stream (id integer primary key check(id=1), generation text not null)")
        if conn.execute("select 1 from diagnostic_stream where id=1").fetchone() is None:
            conn.execute("insert or ignore into diagnostic_stream values(1,?)", (uuid4().hex,))


init_db()


def model_name(model: str) -> str:
    return CATALOG.resolve(model).identity


def elapsed(start: float, end: float | None = None) -> str:
    sec = int((end or time()) - start)
    if sec < 60:
        return f"{sec}s"
    if sec < 3600:
        return f"{sec // 60}m {sec % 60}s"
    return f"{sec // 3600}h {(sec % 3600) // 60}m"


def stamp(ts: float) -> str:
    return datetime.fromtimestamp(ts).isoformat(timespec="seconds")


def utc_stamp(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def actor_name() -> str | None:
    value = os.getenv("AGENT_INTERFACE_ACTOR", "").strip()
    return atoms.actor(value) if value else None


def track(
    model: str,
    prompt: str,
    pr_id: str | None = None,
    repo: str | None = None,
    actor: str | None = None,
    behavior: str | None = None,
    session_id: str | None = None,
    expected_head: str | None = None,
    source: str | None = None,
    correlation_id: str | None = None,
    runner: str | None = None,
) -> str:
    """A row runs in this process unless `runner` names who runs it instead;
    such a row records no pid, because there is no local process to signal."""
    id_ = uuid4().hex
    with db() as conn:
        conn.execute(
            """insert into calls (
                 id, model, prompt, started_at, status, pr_id, repo, actor,
                 behavior, session_id, expected_head, source, correlation_id, pid, runner
               ) values (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                id_,
                model,
                prompt,
                time(),
                pr_id,
                repo,
                actor,
                behavior,
                session_id,
                expected_head,
                source,
                correlation_id,
                None if runner else str(os.getpid()),
                runner,
            ),
        )
    return id_


# ── --record-turn ──────────────────────────────────────────────────────
# A Chat turn runs in Poise's own runtime; Caller keeps the calls row so Swarm
# lists it with its model, elapsed time and outcome. The row is marked with a
# runner because it has no local process: never signalled, never taken for an
# orphaned worker, closed only by `finish`.
EXTERNAL_RUNNER = "external"
TURN_STATUSES = ("completed", "failed", "cancelled")
TURN_FAILED_ERROR = "Turn failed"
REPO_RE = re.compile(r"[^/\s]+/[^/\s]+")


def record_turn_start(
    model: str,
    session_id: str,
    source: str,
    repo: str | None = None,
    pr: str | None = None,
    correlation_id: str | None = None,
) -> str:
    """One `behavior=chat` row for an externally run turn; prints nothing,
    launches nothing. With a correlation id the same turn started twice yields
    the same id, and a different turn under that id is refused."""
    session_id = str(session_id).strip()
    if not atoms.CORRELATION_RE.fullmatch(session_id):
        raise ValueError("session must be a stable 1-128 character identifier")
    if repo is not None and not REPO_RE.fullmatch(repo.strip()):
        raise ValueError("repo must look like owner/name")
    turn = {
        "model": CATALOG.resolve(model).identity,
        "session_id": session_id,
        "source": atoms.source(source),
        "repo": repo.strip() if repo else None,
        "pr_id": atoms.pr_number(pr) if pr else None,
    }
    if turn["pr_id"] and not turn["repo"]:
        raise ValueError("--pr requires --repo")
    correlation = atoms.correlation_id(correlation_id) if correlation_id else None
    try:
        return track(
            turn["model"],
            "",
            turn["pr_id"],
            turn["repo"],
            actor_name(),
            "chat",
            turn["session_id"],
            source=turn["source"],
            correlation_id=correlation,
            runner=EXTERNAL_RUNNER,
        )
    except sqlite3.IntegrityError:
        if correlation is None:
            raise
    with db() as conn:
        row = conn.execute(
            "select id, runner, model, session_id, source, repo, pr_id from calls where correlation_id=?",
            (correlation,),
        ).fetchone()
    if row is None or row["runner"] != EXTERNAL_RUNNER or any(row[key] != value for key, value in turn.items()):
        raise ValueError(f"correlation id {correlation} already records a different call")
    return row["id"]


def record_turn_finish(id_: str, status: str, error: str | None = None) -> dict:
    """Close an externally run turn. Repeating the same outcome returns the
    stored record; a different outcome is refused, never overwritten."""
    if status not in TURN_STATUSES:
        raise ValueError("status must be one of " + ", ".join(TURN_STATUSES))
    if error and status == "completed":
        raise ValueError("--error is only recorded for a failed or cancelled turn")
    text = error or (TURN_FAILED_ERROR if status == "failed" else "")
    with db() as conn:
        conn.execute(
            "update calls set status=?, ended_at=?, error=? where id=? and runner=? and status='running'",
            (status, time(), text, id_, EXTERNAL_RUNNER),
        )
        row = conn.execute("select runner, status, started_at, ended_at, error from calls where id=?", (id_,)).fetchone()
    if row is None:
        raise ValueError("unknown call id")
    if row["runner"] != EXTERNAL_RUNNER:
        raise ValueError(f"call {id_} is not an externally recorded turn")
    if row["status"] != status:
        raise ValueError(f"call {id_} already finished as {row['status']}")
    return {
        "id": id_,
        "status": row["status"],
        "started_at": utc_stamp(row["started_at"]),
        "completed_at": utc_stamp(row["ended_at"]),
        "time_elapsed": elapsed(row["started_at"], row["ended_at"]),
        "error": row["error"] or None,
    }


# ── --stop ─────────────────────────────────────────────────────────────
# A running call is this process and whatever provider CLI it started, all in
# one process group when the caller detached us (Poise does). Governed reviews
# start their provider in its own session and stop it themselves on SIGTERM.
STOP_GRACE_SECONDS = 5.0
# What the recorded pid must be running before it is signalled; a pid can be
# reused by an unrelated process once the call's process has died.
STOP_COMMAND_MARK = "agent-interface"


def process_command(pid: int) -> str | None:
    done = subprocess.run(["ps", "-o", "command=", "-p", str(pid)], text=True, capture_output=True)
    if done.returncode:
        return None
    return done.stdout.strip() or None


def signal_group(pid: int, signum: int) -> None:
    try:
        os.killpg(os.getpgid(pid), signum)
    except ProcessLookupError:
        return
    except PermissionError:
        os.kill(pid, signum)


def wait_gone(pid: int, seconds: float) -> bool:
    deadline = time() + seconds
    while time() < deadline:
        if process_command(pid) is None:
            return True
        sleep(0.1)
    return process_command(pid) is None


def stop_call(id_: str) -> dict:
    with db() as conn:
        row = conn.execute("select id, status, pid, runner, source from calls where id=?", (id_,)).fetchone()
    if row is None:
        raise ValueError("unknown call id")
    if row["status"] != "running":
        return {"id": id_, "stopped": False, "status": row["status"]}
    if row["runner"] == EXTERNAL_RUNNER:
        raise RuntimeError(
            f"this turn is managed externally (source {row['source']}); "
            "stop it through Poise, which routes Swarm Stop to its runtime"
        )
    if not row["pid"]:
        raise RuntimeError("this call recorded no process id; it started before stop support")
    pid = int(row["pid"])
    command = process_command(pid)
    if command is not None and STOP_COMMAND_MARK not in command:
        raise RuntimeError(f"pid {pid} now belongs to another process; the call is not running")
    # Marked first, so a call that ends meanwhile reads as stopped, never as interrupted.
    with db() as conn:
        conn.execute("update calls set error_code='stopping' where id=? and status='running'", (id_,))
    if command is not None:
        signal_group(pid, signal.SIGTERM)
        if not wait_gone(pid, STOP_GRACE_SECONDS):
            signal_group(pid, signal.SIGKILL)
            wait_gone(pid, 2.0)
    # The process may have finished its own row in the grace period.
    with db() as conn:
        changed = conn.execute(
            "update calls set status='failed', ended_at=?, error='Stopped by user', error_code='stopped', progress=coalesce(?, progress) where id=? and status='running'",
            (time(), progress.terminal("failed"), id_),
        ).rowcount
        after = conn.execute("select status, error_code from calls where id=?", (id_,)).fetchone()
    stopped = changed == 1 or (after["status"] == "failed" and after["error_code"] == "stopped")
    return {"id": id_, "stopped": stopped, "status": after["status"], "error_code": "stopped" if stopped else None}


def finish(
    id_: str,
    status: str,
    response: str = "",
    error: str = "",
    outcome: str | None = None,
    head_sha: str | None = None,
    action: str | None = None,
    error_code: str | None = None,
    diagnostic: dict | None = None,
) -> float:
    # First terminal writer wins: a worker finishing after stop/reap must not
    # overwrite stopped/interrupted. The loser keeps its response file out of
    # the row and reports the existing state.
    path = str((RESPONSES / f"{id_}.txt").resolve()) if response else None
    ended_at = time()
    with db() as conn:
        changed = conn.execute(
            "update calls set status=?, ended_at=?, response_path=?, error=?, outcome=?, head_sha=?, action=?, error_code=?, diagnostic=?, progress=coalesce(?, progress) where id=? and status='running'",
            (status, ended_at, path, error, outcome, head_sha, action, error_code, json.dumps({**diagnostic, "call_id": id_}) if diagnostic else None, progress.terminal(status), id_),
        ).rowcount
        if changed != 1:
            row = conn.execute("select ended_at from calls where id=?", (id_,)).fetchone()
            if row is not None and row["ended_at"] is not None:
                print(f"call {id_} already finished; keeping its terminal state", file=sys.stderr)
                return float(row["ended_at"])
    if response and changed == 1:
        try:
            Path(path).write_text(response)
        except OSError as persist_error:
            # The row is terminal; a response persistence failure must not
            # reopen it. Clear the dangling path and retain the cause.
            with db() as conn:
                conn.execute("update calls set response_path=null, diagnostic=coalesce(diagnostic, ?) where id=?",
                             (json.dumps(diagnostic_envelope(operation="call.finalize", phase="response_persist",
                                                             outcome="persist_failed",
                                                             stderr=str(persist_error)[:500], call_id=id_)), id_))
    return ended_at


INTERRUPTED_ERROR = "The agent process ended without recording a result"
# A call still running this long after it started, with its agent-interface
# process gone, is over: no review or reply runs anywhere near this long, and
# its providers, which outlive their supervisor in sessions of their own, have
# long finished too.
ORPHAN_AFTER_SECONDS = 6 * 3600


def init_started_at() -> float | None:
    """When this PID namespace's init started: the container's start inside
    one, the boot outside. None where /proc does not say."""
    try:
        fields = Path("/proc/1/stat").read_text().rsplit(")", 1)[1].split()
        ticks = int(fields[19])
        btime = next(int(line.split()[1]) for line in Path("/proc/stat").read_text().splitlines() if line.startswith("btime "))
        return btime + ticks / os.sysconf("SC_CLK_TCK")
    except (OSError, ValueError, IndexError, StopIteration):
        return None


def reap_interrupted() -> int:
    """Marks a running call failed once nothing of it can still run, so what
    launched it tries again rather than reading it as running for good: it
    started before this container's init did, so a restart ended all its
    processes; or its agent-interface process has been gone after
    ORPHAN_AFTER_SECONDS. A supervisor gone sooner is not enough, since its
    providers may live on and still post. A call being stopped reads as
    stopped, as stop_call would have recorded it; any other as interrupted.
    Calls Poise runs itself record no pid and are left to it."""
    init = init_started_at()
    now = time()
    with db() as conn:
        rows = conn.execute(
            "select id, pid, started_at, source, artifact from calls where runner is null and pid is not null "
            "and (status='running' or (source='poise:behavior-chain' and resources_settled_at is null))"
        ).fetchall()
    ended = []
    for row in rows:
        started = float(row["started_at"] or 0)
        if init is None or started >= init:
            if row["source"] != "poise:behavior-chain" and now - started < ORPHAN_AFTER_SECONDS:
                continue
            try:
                pid = int(row["pid"])
            except (TypeError, ValueError):
                continue
            command = process_command(pid)
            if command is not None and STOP_COMMAND_MARK in command:
                continue
            if row["source"] == "poise:behavior-chain":
                # A missing parent alone cannot prove detached provider
                # descendants stopped. Retain ownership without proof.
                try:
                    root = json.loads(row["artifact"] or "{}").get("resource_root")
                except (ValueError, AttributeError):
                    continue
                if not root or issue_review._cwd_pids(Path(root), require_complete=True) != []:
                    continue
        ended.append(row["id"])
    count = 0
    with db() as conn:
        if init is not None:
            # A restarted PID namespace ended every old worker, including
            # calls Stop had already made terminal before the crash.
            old = conn.execute("select id from calls where source='poise:behavior-chain' and status!='running' "
                               "and resources_settled_at is null and started_at < ?", (init,)).fetchall()
            for row in old:
                conn.execute("update calls set resources_settled_at=? where id=?", (now, row["id"]))
                mark_managed_no_write(conn, row["id"])
        for id_ in ended:
            # Whether it is being stopped is read by the update itself: stop_call
            # may have marked it, and ended its worker, since the select above.
            count += conn.execute(
                "update calls set status='failed', ended_at=?, "
                "error=case when error_code='stopping' then 'Stopped by user' else ? end, "
                "error_code=case when error_code='stopping' then 'stopped' else 'interrupted' end, "
                "resources_settled_at=case when source='poise:behavior-chain' then ? else resources_settled_at end, "
                "progress=coalesce(?, progress) where id=? and status='running'",
                (now, INTERRUPTED_ERROR, now, progress.terminal("failed"), id_),
            ).rowcount
            conn.execute("update calls set resources_settled_at=? where id=? and source='poise:behavior-chain' and resources_settled_at is null", (now, id_))
            mark_managed_no_write(conn, id_)
    return count


LOG_ROW_COLUMNS = """id, model, prompt, started_at, ended_at, status,
    response_path, error, pr_id, repo, actor, behavior,
    session_id, outcome, head_sha, expected_head, source,
    correlation_id, action, error_code, progress, review_policy, recovery_model,
    review_id, runner, receipts, review_comments, diagnostic, artifact, resources_settled_at, issue_revision"""


def _log_row(r) -> dict:
    return {
        "id": r["id"],
        "pr_id": r["pr_id"],
        "repo": r["repo"],
        "actor": r["actor"],
        "behavior": r["behavior"],
        "session_id": r["session_id"],
        "model": r["model"],
        "prompt": r["prompt"],
        "started_at": stamp(r["started_at"]),
        "started_at_precise": utc_stamp(r["started_at"]),
        "completed_at": utc_stamp(r["ended_at"]) if r["ended_at"] else None,
        "time_elapsed": elapsed(r["started_at"], r["ended_at"]),
        "status": r["status"],
        "outcome": r["outcome"],
        "head_sha": r["head_sha"],
        "expected_head": r["expected_head"],
        "source": r["source"],
        "correlation_id": r["correlation_id"],
        "action": r["action"],
        "error_code": r["error_code"],
        "diagnostic": json.loads(r["diagnostic"]) if r["diagnostic"] else None,
        "progress": progress.decode(r["progress"]),
        "review_policy": r["review_policy"],
        "recovery_model": r["recovery_model"],
        "review_id": int(r["review_id"]) if r["review_id"] and str(r["review_id"]).isdigit() else None,
        # The inline comments a change request posted, as GitHub's reply counted them.
        "review_comments": int(r["review_comments"]) if r["review_comments"] and str(r["review_comments"]).isdigit() else None,
        "response": Path(r["response_path"]).stem[:8] if r["response_path"] else None,
        "error": r["error"],
        "runner": r["runner"],
        "receipts": _receipts(r["receipts"]),
        "artifact": json.loads(r["artifact"]) if r["artifact"] else None,
        "resources_settled_at": utc_stamp(float(r["resources_settled_at"])) if r["resources_settled_at"] else None,
        "issue_revision": r["issue_revision"],
    }


def logs(status: str | None = None):
    """Every retained call, oldest first; with status, only the running ones.

    The running-only read is indexed on (status, started_at), so retained
    history does not raise its cost. Use logs_page for bounded history."""
    if status is not None and status != "running":
        raise ValueError("logs status filter must be running")
    reap_interrupted()
    with db() as conn:
        rows = conn.execute(
            f"select {LOG_ROW_COLUMNS} from calls"
            + (" where status='running'" if status else "")
            + " order by started_at"
        ).fetchall()
    return [_log_row(r) for r in rows]


LOGS_PAGE_LIMIT_MAX = 1000
LOGS_LATEST_QUERY = f"""select {LOG_ROW_COLUMNS} from calls
    where behavior=? and source=? and {LOG_OWNER_SQL}=?
      and repo is not null and repo != '' and pr_id is not null and pr_id != ''
    order by started_at desc, id desc limit 1"""


def logs_watermark() -> str:
    """The insertion boundary before a launch, including an empty database."""
    with db() as conn:
        return str(conn.execute("select coalesce(max(rowid),0) from calls").fetchone()[0])


def logs_selected(selection: object) -> list[dict]:
    """Exact latest-trigger and call-id reads; absence is checked at the source.

    Each latest needle seeks one indexed row; each id seeks the primary key.
    Missing kinds and old incidents never require walking retained history.
    """
    if not isinstance(selection, dict) or set(selection) not in ({"latest", "ids"}, {"latest", "ids", "correlations"}):
        raise ValueError("logs selection requires latest and ids, with optional correlations")
    latest, ids = selection["latest"], selection["ids"]
    correlations = selection.get("correlations", [])
    if not isinstance(correlations, list) or len(correlations) > 256 or any(
        not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}", value) for value in correlations
    ):
        raise ValueError("logs selection permits at most 256 safe correlation identities")
    if not isinstance(latest, list) or len(latest) > 256 or not isinstance(ids, list) or len(ids) > 1000:
        raise ValueError("logs selection permits at most 256 latest needles and 1000 ids")
    for needle in latest:
        if not isinstance(needle, dict) or set(needle) != {"behavior", "source", "owner"} \
                or any(not isinstance(needle[key], str) or not needle[key] or len(needle[key]) > 128 for key in needle):
            raise ValueError("logs latest needle requires behavior, source and owner")
    if any(not isinstance(id_, str) or not re.fullmatch(r"[0-9a-f]{32}", id_) for id_ in ids):
        raise ValueError("logs selection requires full call ids")
    reap_interrupted()
    found: dict[str, sqlite3.Row] = {}
    with db() as conn:
        # One read transaction keeps the selectors on the same database snapshot.
        conn.execute("begin")
        for needle in latest:
            row = conn.execute(LOGS_LATEST_QUERY,
                               (needle["behavior"], needle["source"], needle["owner"].lower())).fetchone()
            if row is not None:
                found[row["id"]] = row
        for id_ in ids:
            row = conn.execute(f"select {LOG_ROW_COLUMNS} from calls where id=?", (id_,)).fetchone()
            if row is not None:
                found[row["id"]] = row
        for correlation in correlations:
            row = conn.execute(f"select {LOG_ROW_COLUMNS} from calls where correlation_id=?", (correlation,)).fetchone()
            if row is not None:
                found[row["id"]] = row
    rows = sorted(found.values(), key=lambda row: (row["started_at"], row["id"]))
    return [_log_row(row) for row in rows]


def logs_session_since(after: str, session: str, behavior: str, prompt: str) -> list[dict]:
    """At most two exact launch candidates, including already terminal calls."""
    if not re.fullmatch(r"0|[1-9][0-9]*", after) or int(after) > 2**63 - 1:
        raise ValueError("logs insertion boundary is invalid")
    if not session or not behavior:
        raise ValueError("logs session and behavior are required")
    reap_interrupted()
    with db() as conn:
        rows = conn.execute(f"""select {LOG_ROW_COLUMNS} from calls
            where session_id=? and behavior=? and rowid>? and prompt=?
            order by rowid limit 2""", (session, behavior, int(after), prompt)).fetchall()
    return [_log_row(row) for row in rows]


LOGS_SEARCH_MAX = 2048
LOGS_SEARCH_SQL = """lower(
    coalesce(id,'') || ' ' || coalesce(model,'') || ' ' || coalesce(recovery_model,'')
    || ' ' || coalesce(behavior,'') || ' ' || coalesce(prompt,'') || ' ' || coalesce(status,'')
    || ' ' || coalesce(actor,'') || ' ' || coalesce(repo,'') || ' ' || coalesce(pr_id,'')
    || ' ' || coalesce(repo,'') || '#' || coalesce(pr_id,'')
    || ' ' || '#' || coalesce(pr_id,'')
    || ' ' || coalesce(session_id,'') || ' ' || coalesce(outcome,'') || ' ' || coalesce(error,'')
) like '%' || ? || '%' escape '\\'"""


def logs_page(limit: int, cursor: str | None = None, org: str | None = None, search: str | None = None) -> dict:
    """One bounded newest-first history page; rows stay oldest-first in it.

    Pages walk back by insertion order (rowid), so concurrent appends never
    shift them. The cursor is the next page's exclusive rowid bound, opaque
    to callers. Each page costs its own rows, never the retained history.
    Org narrows to one owner (case-insensitive); search matches the same
    fields Swarm filters on (case-insensitive substring). Total counts all
    matching rows without loading them."""
    if type(limit) is not int or not 1 <= limit <= LOGS_PAGE_LIMIT_MAX:
        raise ValueError(f"logs page limit must be 1..{LOGS_PAGE_LIMIT_MAX}")
    bound: int | None = None
    if cursor is not None:
        if not re.fullmatch(r"[1-9][0-9]*", cursor):
            raise ValueError("logs page cursor is invalid")
        bound = int(cursor)
    if org is not None:
        if not isinstance(org, str) or not 1 <= len(org) <= 128 or "\x00" in org or "/" in org:
            raise ValueError("logs page org is invalid")
        org = org.lower()
    if search is not None:
        if not isinstance(search, str) or not 1 <= len(search) <= LOGS_SEARCH_MAX:
            raise ValueError(f"logs page search must be 1..{LOGS_SEARCH_MAX} characters")
        search = search.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    reap_interrupted()
    filters: list[str] = []
    params: list[object] = []
    if org is not None:
        filters.append(f"{LOG_OWNER_SQL}=?")
        params.append(org)
    if search is not None:
        filters.append(LOGS_SEARCH_SQL)
        params.append(search)
    where = f" where {' and '.join(filters)}" if filters else ""
    with db() as conn:
        total = conn.execute(f"select count(*) from calls{where}", params).fetchone()[0]
        page_where = where + (" and" if where else " where") + " rowid < ?" if bound is not None else where
        page_params = [*params, bound] if bound is not None else params
        rows = conn.execute(
            f"select rowid, {LOG_ROW_COLUMNS} from calls{page_where}"
            + " order by rowid desc limit ?",
            (*page_params, limit + 1),
        ).fetchall()
    page = rows[:limit]
    oldest = page[-1]["rowid"] if page else None
    return {
        "rows": [_log_row(r) for r in reversed(page)],
        "nextCursor": str(oldest) if len(rows) > limit and oldest is not None else None,
        "total": total,
    }


def diagnostics(after: int = 0, limit: int = 3) -> dict:
    """Bounded metadata-only read; completion sequence includes late-finishing calls.

    The owner consumes this internal stream and applies the canonical Logging
    redactor before persistence. It never opens response/reasoning artifacts.
    """
    if type(after) is not int or after < 0 or type(limit) is not int or not 1 <= limit <= 10:
        raise ValueError("diagnostics requires a nonnegative cursor and limit 1..10")
    fields = ("id", "model", "status", "pr_id", "repo", "actor", "behavior", "outcome", "head_sha",
              "expected_head", "source", "correlation_id", "action", "error_code")
    with db() as conn:
        stream_id = conn.execute("select generation from diagnostic_stream where id=1").fetchone()[0]
        if not isinstance(stream_id, str) or not re.fullmatch(r"[a-f0-9]{32}", stream_id):
            raise RuntimeError("Caller diagnostic stream identity is invalid")
        conn.execute("""insert or ignore into diagnostic_calls(call_id)
            select c.id from calls c left join diagnostic_calls d on d.call_id=c.id
            where d.call_id is null and c.status != 'running'
              and (coalesce(c.error,'') != '' or c.error_code is not null or c.diagnostic is not null)
            order by c.ended_at,c.id limit 100""")
        backfill = conn.execute("""select exists(select 1 from calls c left join diagnostic_calls d on d.call_id=c.id
            where d.call_id is null and c.status != 'running'
              and (coalesce(c.error,'') != '' or c.error_code is not null or c.diagnostic is not null))""").fetchone()[0]
        columns = ",".join(f"substr(c.{field},1,512) as {field}" for field in fields)
        rows = conn.execute(f"""select d.seq,{columns},c.started_at,c.ended_at,
            substr(c.error,1,8192) as error,substr(c.diagnostic,1,65536) as diagnostic
            from diagnostic_calls d join calls c on c.id=d.call_id
            where d.seq>? order by d.seq limit ?""", (after, limit + 1)).fetchall()
    events = []
    for row in rows[:limit]:
        entry = {field: row[field] for field in fields}
        entry.update(seq=row["seq"], error=row["error"], started_at_precise=utc_stamp(row["started_at"]),
                     completed_at=utc_stamp(row["ended_at"]) if row["ended_at"] else None)
        try:
            raw = row["diagnostic"]
            evidence = json.loads(raw) if raw is not None else None
            if raw is not None and (not isinstance(evidence, dict) or isinstance(evidence.get("version"), bool) or evidence.get("version") != 1):
                raise ValueError("diagnostic must be a supported version 1 object")
            # Python's decoder accepts NaN/Infinity and overflowing exponents.
            # The stream must remain finite JSON for its JavaScript consumer.
            json.dumps(evidence, allow_nan=False)
            entry["diagnostic"] = evidence
        except (ValueError, TypeError, RecursionError):
            entry["diagnostic"] = None
            entry["evidence_unavailable"] = "Stored process diagnostic is malformed, unsupported, non-finite or exceeds bounded decoding limits"
        if len(json.dumps(entry, allow_nan=False).encode()) > 64 * 1024:
            entry["diagnostic"] = None
            entry["error"] = (row["error"] or "")[:2048]
            entry["evidence_unavailable"] = "Stored process diagnostic exceeds the bounded metadata envelope"
        events.append(entry)
    return {"version": 1, "streamId": stream_id, "events": events, "cursor": events[-1]["seq"] if events else after,
            "hasMore": len(rows) > limit, "backfillPending": bool(backfill)}


def _receipts(raw: str | None) -> list | None:
    # None: the run never started posting. A list, even an empty one: it did,
    # and these are the comments it knows it posted.
    try:
        value = json.loads(raw) if raw else None
    except ValueError:
        return []
    return value if isinstance(value, list) else None


def read_response(short: str):
    with db() as conn:
        rows = conn.execute("select response_path from calls where response_path is not null and id like ?", (short + "%",)).fetchall()
    if len(rows) != 1:
        raise SystemExit(f"response hash matched {len(rows)} rows")
    path = Path(rows[0]["response_path"])
    print((path if path.is_absolute() else DATA_DIR.parent / path).read_text())


def run_pr_review(
    pr: str,
    actor: str,
    expected_head: str,
    source: str,
    correlation_id: str,
    pwd: str | None = None,
    note: str = "",
    timeout_s: int = review_budget.REVIEW_TIMEOUT_SECONDS,
    p: str | None = None,
    model: str | None = None,
    recovery_model: str | None = None,
):
    return run_governed_behavior(
        pr_review,
        "pr_review",
        pr,
        actor,
        expected_head,
        source,
        correlation_id,
        pwd,
        note,
        timeout_s,
        p,
        model,
        recovery_model,
    )


def record_cleanup_failure(call_id: str) -> None:
    """A run directory that survived deletion keeps its resources unsettled:
    the failure is durable and visible, and the still-present directory stays
    retryable by the next sweep without repeating any external action."""
    try:
        with db() as conn:
            conn.execute("update calls set artifact=json_set(coalesce(artifact,'{}'),'$.resource_error','cleanup_failed') where id=?",
                         (call_id,))
    except Exception as error:
        print(f"call {call_id} cleanup failed and its record could not be updated: {error}", file=sys.stderr)


def run_issue_review(
    issue: str,
    actor: str,
    source: str,
    correlation_id: str,
    model: str,
    recovery_model: str | None = None,
    note: str = "",
    timeout_s: int = issue_review.TIMEOUT_SECONDS,
    expected_issue_revision: str | None = None,
):
    spec = CATALOG.issue_review_model(model)
    recovery = CATALOG.issue_review_model(recovery_model) if recovery_model else None
    repo, number = issue_review.parse(issue)
    actor = atoms.actor(actor)
    source = atoms.source(source)
    correlation_id = atoms.correlation_id(correlation_id)
    id_ = track(spec.identity, note, str(number), repo, actor, "issue_review", source=source, correlation_id=correlation_id)
    run_dir = issue_review.WORK_ROOT / id_
    issue_review.sweep()
    stamp_ = {"id": id_, "behavior": "issue_review", "issue": issue_review.ref(repo, number), "actor": actor,
              "source": source, "correlation_id": correlation_id}
    response = ""

    def fail(error: BaseException, code: str | None = None, preflight: bool = False):
        diagnostic = getattr(error, "diagnostic", None)
        if isinstance(diagnostic, dict):
            diagnostic = {**diagnostic, "call_id": id_, "correlation_id": correlation_id,
                          "repository": repo, "issue": number, "reviewer": actor, "behavior": "issue_review"}
        finish(id_, "failed", response=response, error=str(error)[:2000], error_code=code,
               outcome="preflight_failed" if preflight else None, action="not_started" if preflight else None,
               diagnostic=diagnostic)
        print(json.dumps({**stamp_, "model": name, "error": str(error)[:2000],
                          "error_code": code, "diagnostic": diagnostic}, indent=2))
        raise SystemExit(1)

    def record(receipts: list[dict]) -> None:
        with db() as conn:
            conn.execute("update calls set receipts=? where id=? and ended_at is null", (json.dumps(receipts), id_))

    name = spec.identity
    previous_sigterm = signal.signal(signal.SIGTERM, review_watch_interrupted)
    try:
        with review_budget.ReviewBudget(timeout_s, cap=issue_review.TIMEOUT_SECONDS), \
                progress.Progress(DB, id_, "preparing_issue", "Reading the issue and its sub-issues"):
            # Issue reviews post as the configured agent account; a different
            # actor would find out only after its first comment went out.
            agent = os.getenv("GITHUB_INTERFACE_AGENT_USER", "").strip()
            if not agent:
                fail(ValueError("GITHUB_INTERFACE_AGENT_USER is not set; it names the agent account issue reviews post as"),
                     "agent_account_missing", preflight=True)
            if actor.lower() != agent.lower():
                fail(ValueError(f"issue comments are posted as the agent account {agent}; --actor {actor} cannot post them"),
                     "actor_mismatch", preflight=True)
            try:
                data = issue_review.packet(repo, number, actor)
                observed_revision = issue_review.revision(data["issue"])
                if expected_issue_revision and observed_revision != expected_issue_revision:
                    fail(ValueError("seed issue changed before review"), "issue_revision_changed", preflight=True)
                with db() as conn:
                    conn.execute("update calls set issue_revision=? where id=? and ended_at is null", (observed_revision, id_))
                issue_review.mark_reviewed(data, actor, _issue_review_targets, _running_issue_reviews(id_))
            except review_budget.ReviewLimitError as e:
                if e.diagnostic is None:
                    e.diagnostic = diagnostic_envelope(operation="issue.prepare", phase="preparing_issue",
                                                       outcome="timed_out")
                fail(e, e.code)
            except subprocess.TimeoutExpired as e:
                fail(review_budget.ReviewLimitError(
                    "Issue review preparation reached its time limit; needs attention",
                    "review_budget_exhausted",
                    diagnostic_envelope(operation="issue.prepare", phase="preparing_issue",
                                        outcome="timed_out")), "review_budget_exhausted")
            except Exception as e:
                fail(e, getattr(e, "code", None), preflight=True)
            try:
                with review_receipt.invocation_environment(DB, id_, source == 'poise:behavior-chain'), review_receipt.managed_resources(run_dir):
                    name, (posts, ignored) = _issue_review_with_recovery(spec, recovery, repo, number, data, actor, note, run_dir, id_)
            except review_budget.ReviewLimitError as e:
                fail(e, e.code)
            except atoms.AgentPreflightError as e:
                fail(e, e.code, preflight=True)
            except issue_review.InvalidReview as e:
                fail(e, e.code)
            except issue_review.ProviderFailure as e:
                fail(e, e.code)
            except subprocess.TimeoutExpired as e:
                fail(review_budget.ReviewLimitError(
                    "Issue review reached its time limit; needs attention",
                    "review_budget_exhausted"), "review_budget_exhausted")
            except Exception as e:
                fail(e)
            # A revision-bound request promises the author a readback of the
            # requested document: child-only output cannot fulfill it.
            if expected_issue_revision and not any(isinstance(post, dict)
                    and str(post.get("issue") or "").lower() == issue_review.ref(repo, number).lower()
                    for post in posts):
                fail(issue_review.InvalidReview("the review has no comment for the requested issue"),
                     issue_review.InvalidReview.code)
            try:
                if expected_issue_revision and issue_review.revision(issue_review._issue(repo, number, actor)) != observed_revision:
                    fail(ValueError("seed issue changed during review; no comments posted"), "issue_revision_changed", preflight=True)
                if source == "poise:behavior-chain":
                    digest = persist_action_plan(id_, {"kind": "issue_review", "posts": posts, "model": name, "issue_revision": observed_revision})
                    with db() as conn:
                        conn.execute("update calls set artifact=? where id=? and status='running'",
                                     (json.dumps({"phase": "posting_issue_reviews", "plan_sha": digest}), id_))
                receipts = issue_review.post(posts, actor, id_, name, record, observed_revision)
            except subprocess.TimeoutExpired as e:
                fail(review_budget.ReviewLimitError(
                    "Issue review posting reached its time limit; uncertain publication, reconcile before retry",
                    "posting_failed"), "posting_failed")
            except Exception as e:
                fail(e, "posting_failed")
            response = issue_review.summary(posts, receipts, ignored)
            ended_at = finish(id_, "completed", response=response, outcome="commented", action="commented")
            print(json.dumps({**stamp_, "model": name, "receipts": receipts, "completed_at": utc_stamp(ended_at),
                              "action": "commented", "outcome": "commented"}, indent=2))
    except BaseException as terminal:
        # A signal (or a finalization failure) must still leave one durable
        # terminal state, never a row stuck running. fail() already finished;
        # its SystemExit(1) passes through untouched.
        if not (isinstance(terminal, SystemExit) and terminal.code == 1):
            try:
                with db() as conn:
                    row = conn.execute("select status, error_code from calls where id=?", (id_,)).fetchone()
                if row is not None and row["status"] == "running":
                    stopping = row["error_code"] == "stopping"
                    finish(id_, "failed", response=response,
                           error="Stopped by user" if stopping else INTERRUPTED_ERROR,
                           error_code="stopped" if stopping else "interrupted")
                    print(json.dumps({**stamp_, "model": name,
                                      "error": "Stopped by user" if stopping else INTERRUPTED_ERROR,
                                      "error_code": "stopped" if stopping else "interrupted"}, indent=2))
            except Exception:
                pass
        raise
    finally:
        signal.signal(signal.SIGTERM, previous_sigterm)
        if not issue_review.cleanup(run_dir):
            record_cleanup_failure(id_)


def _issue_review_targets(call_ids: list[str]) -> dict[str, str]:
    """The issue each of these issue reviews was of."""
    with db() as conn:
        rows = conn.execute(
            f"select id, repo, pr_id from calls where behavior='issue_review' and id in ({','.join('?' * len(call_ids))})",
            call_ids,
        ).fetchall()
    return {row["id"]: issue_review.ref(row["repo"], int(row["pr_id"])) for row in rows if row["repo"] and str(row["pr_id"] or "").isdigit()}


def _running_issue_reviews(call_id: str) -> frozenset[str]:
    """The issues, lowercased, that another issue review is running on now. A
    row left running by a run that died long ago does not count."""
    with db() as conn:
        rows = conn.execute(
            "select repo, pr_id from calls where behavior='issue_review' and ended_at is null and id != ? and started_at > ?",
            (call_id, time() - 2 * issue_review.TIMEOUT_SECONDS),
        ).fetchall()
    return frozenset(issue_review.ref(row["repo"], int(row["pr_id"])).lower()
                     for row in rows if row["repo"] and str(row["pr_id"] or "").isdigit())


def _issue_review_with_recovery(spec, recovery, repo, number, data, actor, note, run_dir, call_id):
    try:
        return spec.identity, issue_review.review(spec, repo, number, data, actor, note, run_dir / "attempt-1")
    except review_budget.ReviewLimitError as failure:
        # Only a Claude output limit is recoverable, only once, only by a
        # different model — and nothing has been posted yet at this point.
        if failure.code != "model_output_limit" or spec.provider != "claude" or recovery is None or recovery.identity == spec.identity:
            raise
        with db() as conn:
            changed = conn.execute("update calls set recovery_model=? where id=? and recovery_model is null and ended_at is null",
                                   (recovery.identity, call_id)).rowcount
        if changed != 1:
            raise review_budget.ReviewLimitError("Recovery was already attempted; needs attention", "review_recovery_failed")
        progress.stage("recovering", f"Output limit reached; recovering once with {recovery.identity}")
        try:
            return recovery.identity, issue_review.review(recovery, repo, number, data, actor, note, run_dir / "attempt-2")
        except Exception as error:
            raise review_budget.ReviewLimitError(
                f"{recovery.identity} recovery failed; needs attention: {error}", "review_recovery_failed") from error


def run_pr_approve(
    pr: str,
    actor: str,
    expected_head: str,
    source: str,
    correlation_id: str,
    pwd: str | None = None,
    note: str = "",
    timeout_s: int = review_budget.REVIEW_TIMEOUT_SECONDS,
    p: str | None = None,
    model: str | None = None,
    recovery_model: str | None = None,
    capped: bool = False,
    review_round: int | None = None,
    review_cap: int | None = None,
):
    return run_governed_behavior(
        pr_approve,
        "pr_approve",
        pr,
        actor,
        expected_head,
        source,
        correlation_id,
        pwd,
        note,
        timeout_s,
        p,
        model,
        recovery_model,
        capped,
        review_round,
        review_cap,
    )


def run_fix_failing_ci(pr: str, pwd: str | None = None, note: str = "", timeout_s: int = 3600):
    return run_legacy_behavior(fix_failing_ci, "fix_failing_ci", pr, pwd, note, timeout_s)


def persist_action_plan(call_id: str, plan: dict) -> str:
    encoded = json.dumps(plan, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode()) > issue_review.MAX_PACKET_BYTES:
        raise ValueError("native publication plan exceeds its durable byte bound")
    with db() as conn:
        row = conn.execute("select action_plan, status from calls where id=?", (call_id,)).fetchone()
        if row is None or row["status"] != "running" or (row["action_plan"] is not None and row["action_plan"] != encoded):
            raise ValueError("native publication plan conflicts with its original durable record")
        conn.execute("update calls set action_plan=? where id=?", (encoded, call_id))
    return hashlib.sha256(encoded.encode()).hexdigest()


def read_action_plan(call_id: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{32}", call_id):
        raise ValueError("action-plan requires a complete native call id")
    with db() as conn:
        row = conn.execute("select action_plan from calls where id=?", (call_id,)).fetchone()
    if row is None or row["action_plan"] is None:
        raise ValueError("native call has no durable publication plan")
    encoded = row["action_plan"]
    return {"id": call_id, "sha": hashlib.sha256(encoded.encode()).hexdigest(), "plan": json.loads(encoded)}


def complete_atomic_publication(call_id: str, digest: str, head: str) -> dict:
    """Finish only the original repair's provably unattempted reply batch."""
    plan = read_action_plan(call_id)
    with db() as conn:
        row = conn.execute("select * from calls where id=?", (call_id,)).fetchone()
    artifact = json.loads(row["artifact"] or "{}") if row else {}
    prepared = artifact.get("prepared") or {}
    if not row or row["source"] != "poise:behavior-chain" or row["behavior"] != "repair_pr" \
            or row["status"] != "failed" or row["error_code"] in {"stopping", "stopped"} \
            or row["resources_settled_at"] is None or artifact.get("resource_error") \
            or plan["sha"] != digest or artifact.get("plan_sha") != digest or plan["plan"].get("kind") != "atomic_work" \
            or artifact.get("phase") != "publishing" or artifact.get("publication_head") != head \
            or artifact.get("replies_started") is not False or not re.fullmatch(r"[0-9a-f]{40}", head):
        raise ValueError("repair publication lacks its original unattempted, resource-settled receipt")
    if prepared.get("repository") != row["repo"] or str(prepared.get("pull_number")) != row["pr_id"] \
            or prepared.get("actor") != row["actor"]:
        raise ValueError("repair publication target differs from its original native Call")
    publication = plan["plan"]["publication"]
    with review_receipt.invocation_environment(DB, call_id, True, initialize=False):
        return issue_review.interface("--issue-work", str(prepared["issue_number"]), "--repository", row["repo"],
                                      "--mode", "complete", "--branch", prepared["branch"], "--pull-number", str(prepared["pull_number"]),
                                      "--expected-head", head, "--invocation-id", call_id, "--token-user", row["actor"],
                                      "--title", publication["title"], "--body", publication["body"],
                                      "--replies-json", json.dumps(publication.get("replies", [])), seconds=25)


def mark_managed_no_write(conn: sqlite3.Connection, call_id: str) -> None:
    # These durable phases precede the controlled GitHub publication path.
    # An admitted/submitting request is deliberately excluded even when its
    # response was lost. Resource settlement is an independent prerequisite.
    conn.execute("update calls set action='not_started', outcome='preflight_failed', head_sha=null "
                 "where id=? and source='poise:behavior-chain' and status='failed' and resources_settled_at is not null and "
                 "json_valid(artifact) and (json_extract(artifact,'$.phase') in ('preparing','prepared','executing','reviewing') "
                 "or (action_plan is null and behavior in ('issue_review','implement_issue','repair_pr')))",
                 (call_id,))


def run_atomic_work(issue: str, actor: str, source: str, correlation_id: str, model: str,
                    branch: str, pull: int | None = None, expected_head: str | None = None, note: str = "", merge_base: bool = False,
                    expected_issue_revision: str | None = None):
    spec = CATALOG.issue_review_model(model)
    repo, number = issue_review.parse(issue)
    actor, source, correlation_id = atoms.actor(actor), atoms.source(source), atoms.correlation_id(correlation_id)
    behavior = "repair_pr" if pull is not None else "implement_issue"
    id_ = track(spec.identity, note, str(pull if pull is not None else number), repo, actor, behavior,
                expected_head=expected_head, source=source, correlation_id=correlation_id)
    run_dir = issue_review.WORK_ROOT.parent / "atomic-work" / id_
    issue_review.sweep()
    artifact = {"phase": "preparing"}

    def record(value: dict) -> None:
        nonlocal artifact
        if "publication" in value:
            digest = persist_action_plan(id_, {"kind": "atomic_work", "publication": value["publication"]})
            artifact = {key: item for key, item in value.items() if key != "publication"}
            artifact["plan_sha"] = digest
        else:
            artifact = value
        artifact["resource_root"] = str(run_dir)
        encoded = json.dumps(artifact)
        if len(encoded.encode()) > 128 * 1024:
            raise ValueError("atomic behavior receipt is oversized")
        with db() as conn:
            if conn.execute("update calls set artifact=? where id=? and status='running'", (encoded, id_)).rowcount != 1:
                raise RuntimeError("atomic behavior no longer owns its durable call")

    previous_sigterm = signal.signal(signal.SIGTERM, review_watch_interrupted)
    try:
        with review_budget.ReviewBudget(issue_review.TIMEOUT_SECONDS, cap=issue_review.TIMEOUT_SECONDS), \
                progress.Progress(DB, id_, "preparing_issue", "Preparing an atomic behavior"), \
                review_receipt.invocation_environment(DB, id_, source == 'poise:behavior-chain'):
            record(artifact)
            with review_receipt.managed_resources(run_dir):
                result = atomic_work.run(spec, repo, number, branch, actor, run_dir, id_, record, pull, expected_head, note, merge_base, expected_issue_revision)
            outcome = result.get("outcome")
            if outcome not in {"published", "no_changes", "superseded"}:
                raise RuntimeError("atomic behavior returned no publication outcome")
            status = "superseded" if outcome == "superseded" else "completed"
            finish(id_, status, response=json.dumps(result), outcome=outcome, head_sha=result.get("head_sha"),
                   action=None if outcome == "superseded" else outcome)
            print(json.dumps({"id": id_, "behavior": behavior, "actor": actor, "source": source,
                              "correlation_id": correlation_id, "model": spec.identity, "artifact": artifact, **result}))
    except BaseException as error:
        if isinstance(error, atomic_work.checkout_lock.WorkerOrphaned):
            record({**artifact, "phase": "resources_unknown"})
        with db() as conn:
            row = conn.execute("select error_code from calls where id=?", (id_,)).fetchone()
        stopped = row is not None and row["error_code"] in {"stopping", "stopped"}
        no_publication = artifact.get("phase") in {"preparing", "prepared", "executing"}
        finish(id_, "failed", error="Stopped by user" if stopped else str(error)[:2000] or INTERRUPTED_ERROR,
               error_code="stopped" if stopped else "interrupted" if not isinstance(error, Exception) else getattr(error, "code", "atomic_work_failed"),
               action="not_started" if no_publication else None,
               outcome="preflight_failed" if no_publication else None)
        raise
    finally:
        signal.signal(signal.SIGTERM, previous_sigterm)
        if not issue_review.cleanup(run_dir):
            record_cleanup_failure(id_)


def run_issue_simplify(issue: str, pwd: str | None = None, note: str = "", timeout_s: int = 3600):
    return run_legacy_behavior(issue_simplify, "issue_simplify", issue, pwd, note, timeout_s)


def run_author_content(topic: str, pwd: str | None = None, session_id: str | None = None, note: str = "", timeout_s: int = 3600,
                       voice_guide: str | None = None):
    name = CATALOG.behavior("author_content").identity
    id_ = track(name, topic, actor=actor_name(), behavior="author_content", session_id=session_id)
    guide = author_content.voice_guide(voice_guide)
    if guide is None:
        print(f"author-content: no voice guide (--voice-guide or {author_content.VOICE_GUIDE_ENV}); writing without one", file=sys.stderr)
    stamp_ = {"id": id_, "model": name, "session_id": session_id, "voice_guide": str(guide) if guide else None}
    try:
        response = author_content.run(topic, pwd, session_id, note, timeout_s, guide)
        finish(id_, "completed", response=response)
        print(json.dumps({**stamp_, "response": response}, indent=2))
        return response
    except Exception as e:
        finish(id_, "failed", error=str(e))
        print(json.dumps({**stamp_, "error": str(e)}, indent=2))
        raise SystemExit(1)


def run_debate(topic: str, rounds: int = 1, timeout_s: int = 3600):
    name = CATALOG.behavior("debate_moderator").identity
    id_ = track(name, topic, actor=actor_name(), behavior="debate")
    try:
        response = debate.run(topic, id_[:8], rounds, timeout_s)
        finish(id_, "completed", response=response)
        print(json.dumps({"id": id_, "model": name, "rounds": rounds, "response": response}, indent=2))
        return response
    except Exception as e:
        finish(id_, "failed", error=str(e))
        print(json.dumps({"id": id_, "model": name, "rounds": rounds, "error": str(e)}, indent=2))
        raise SystemExit(1)


def run_chat(
    model: str,
    session_id: str | None,
    prompt: str,
    pwd: str | None = None,
    timeout_s: int = 3600,
    no_tools: bool = False,
    allowed_tools: list[str] | None = None,
    conda_env: str | None = None,
    pip_upgrade: str | None = None,
):
    name = CATALOG.resolve(model).identity
    pwd = pwd or (chat.workdir(name, session_id) if session_id else None)
    id_ = track(name, prompt, behavior="chat", session_id=session_id)
    try:
        for i in range(6):
            try:
                response = chat.run(pwd, name, session_id, prompt, timeout_s, no_tools, allowed_tools, conda_env, pip_upgrade)
                break
            except Exception as e:
                if i == 5 or "Provider Error" not in str(e):
                    raise
                sleep(5)
        finish(id_, "completed", response=response)
        print(json.dumps({"id": id_, "model": name, "session_id": session_id, "response": response}, indent=2))
        return response
    except Exception as e:
        finish(id_, "failed", error=str(e))
        print(json.dumps({"id": id_, "model": name, "session_id": session_id, "error": str(e)}, indent=2))
        raise SystemExit(1)


def run_record_turn(subcommand: str):
    try:
        if subcommand == "start":
            print(record_turn_start(
                required_flag("--model"),
                required_flag("--session"),
                required_flag("--source"),
                flag_value("--repo"),
                flag_value("--pr"),
                flag_value("--correlation-id"),
            ))
            return
        if subcommand == "finish":
            call_id = sys.argv[3] if len(sys.argv) > 3 else ""
            if not re.fullmatch(r"[0-9a-f]{32}", call_id):
                usage(error="finish requires a full call id")
            print(json.dumps(record_turn_finish(call_id, required_flag("--status"), flag_value("--error"))))
            return
    except (ValueError, ModelCatalogError) as e:
        print(f"error: {e}", file=sys.stderr)
        raise SystemExit(1)
    usage(error="--record-turn takes start or finish")


def run_legacy_behavior(
    mod,
    behavior: str,
    pr: str,
    pwd: str | None = None,
    note: str = "",
    timeout_s: int = 3600,
    p: str | None = None,
):
    name = CATALOG.behavior(behavior).identity
    pwd = pwd or os.getcwd()
    id_ = track(name, note, mod.pr_number(pr), mod.repo_name(pr, pwd), actor_name(), behavior)
    response = ""
    # fix-failing-ci names its checkout lease after the call it runs for.
    extra = {"call_id": id_} if behavior == "fix_failing_ci" else {}
    try:
        response = mod.run(pwd, pr, note, timeout_s, p, **extra)
        ended_at = finish(id_, "completed", response=response)
        print(json.dumps({
            "id": id_,
            "model": name,
            "response": response,
            "completed_at": utc_stamp(ended_at),
        }, indent=2))
    except Exception as e:
        finish(id_, "failed", response=response, error=str(e))
        print(json.dumps({"id": id_, "model": name, "error": str(e)}, indent=2))
        raise SystemExit(1)


def run_governed_behavior(
    mod,
    behavior: str,
    pr: str,
    actor: str,
    expected_head: str,
    source: str,
    correlation_id: str,
    pwd: str | None = None,
    note: str = "",
    timeout_s: int = review_budget.REVIEW_TIMEOUT_SECONDS,
    p: str | None = None,
    model: str | None = None,
    recovery_model: str | None = None,
    capped: bool = False,
    review_round: int | None = None,
    review_cap: int | None = None,
):
    if capped and (behavior != "pr_approve" or review_round is None or review_cap is None):
        raise ValueError("a capped round needs pr_approve with its round and cap numbers")
    spec = CATALOG.review_model(behavior, model)
    recovery = CATALOG.review_model(behavior, recovery_model or CATALOG.behaviors["review_recovery"])
    name = spec.identity
    pwd = pwd or os.getcwd()
    actor = atoms.actor(actor)
    expected_head = atoms.expected_head(expected_head)
    source = atoms.source(source)
    correlation_id = atoms.correlation_id(correlation_id)
    repo = mod.repo_name(pr, pwd)
    review_pr = f"https://github.com/{repo}/pull/{mod.pr_number(pr)}"
    id_ = track(
        name,
        note,
        mod.pr_number(pr),
        repo,
        actor,
        behavior,
        expected_head=expected_head,
        source=source,
        correlation_id=correlation_id,
    )
    with db() as conn:
        conn.execute("update calls set review_policy=? where id=?", (review_budget.REVIEW_POLICY, id_))
    review_receipt.bind(DB, id_)
    with review_budget.ReviewBudget(timeout_s), progress.Progress(DB, id_), \
            review_receipt.invocation_environment(DB, id_, source == 'poise:behavior-chain'):
        response = ""
        try:
            before = review_facts(mod, pr, pwd, actor, expected_head, 0)
        except Exception as e:
            finish(
                id_,
                "failed",
                error=str(e),
                outcome="preflight_failed",
                action="not_started",
            )
            print(json.dumps({
                "id": id_,
                "model": name,
                "behavior": behavior,
                "actor": actor,
                "source": source,
                "correlation_id": correlation_id,
                "expected_head": expected_head,
                "action": "not_started",
                "outcome": "preflight_failed",
                "error": str(e),
            }, indent=2))
            raise SystemExit(1)
        if before.get("state") in CLOSED_TARGET_STATES:
            # The target already closed before the provider ran: the round is
            # obsolete, not failed. Settle without spending the review budget.
            closed = _closed_target_result(
                facts=before,
                evidence=_closed_target_evidence(before, before, None, id_),
                attribution="target already closed at preparation; provider never ran",
                phase="preparing",
            )
            closed["diagnostic"] = _caller_context(
                closed["diagnostic"], id_, correlation_id, repo, mod.pr_number(pr),
                actor, behavior, expected_head)
            ended_at = finish(
                id_,
                "superseded",
                response=closed["error"],
                error=closed["error"],
                outcome=closed["outcome"],
                head_sha=closed["head_sha"],
                action=closed["action"],
                error_code=closed["error_code"],
                diagnostic=closed["diagnostic"],
            )
            print(json.dumps({
                "id": id_,
                "model": name,
                "behavior": behavior,
                "actor": actor,
                "source": source,
                "correlation_id": correlation_id,
                "response": closed["error"],
                "completed_at": utc_stamp(ended_at),
                "budget": review_budget.usage(),
                **closed,
            }, indent=2))
            return
        try:
            try:
                response, recovered_result = _run_review_with_recovery(mod, behavior, review_pr, pwd, actor, expected_head, note, timeout_s, p, spec, recovery, before, id_,
                                                                       capped=capped, review_round=review_round, review_cap=review_cap)
            except ReviewSuperseded as cancelled:
                response = str(cancelled)
                prior = getattr(cancelled, "prior_error", None)
                if prior:
                    response = f"{response}; prior: {prior}"
                cancelled_receipt = review_receipt.get()
                if cancelled_receipt is None:
                    result = {"action": None, "outcome": "superseded", "head_sha": cancelled.head_sha}
                else:
                    # The provider submitted before the cancellation landed:
                    # verify the posted review instead of retracting it.
                    progress.stage("verifying", "Verifying GitHub outcome after cancellation")
                    result = behavior_outcome(mod, behavior, pr, pwd, actor, expected_head, before,
                                              receipt=cancelled_receipt, call_id=id_, prior_error=response)
            else:
                progress.stage("verifying", "Verifying GitHub outcome")
                result = recovered_result or behavior_outcome(
                    mod,
                    behavior,
                    pr,
                    pwd,
                    actor,
                    expected_head,
                    before,
                    receipt=review_receipt.get(),
                    call_id=id_,
                )
            status = "superseded" if result["outcome"] == "superseded" else "completed"
            if "diagnostic" in result:
                # A close-settled round keeps its original failure and its
                # publication evidence on the row; Poise releases the
                # superseded claim while the audit trail stays complete.
                result = {**result, "diagnostic": _caller_context(
                    result["diagnostic"], id_, correlation_id, repo, mod.pr_number(pr),
                    actor, behavior, expected_head)}
            ended_at = finish(
                id_,
                status,
                response=response,
                error=result.get("error") or "",
                outcome=result["outcome"],
                head_sha=result["head_sha"],
                action=result["action"],
                error_code=result.get("error_code"),
                diagnostic=result.get("diagnostic"),
            )
            print(json.dumps({
                "id": id_,
                "model": name,
                "behavior": behavior,
                "actor": actor,
                "source": source,
                "correlation_id": correlation_id,
                "response": response,
                "completed_at": utc_stamp(ended_at),
                "budget": review_budget.usage(),
                **result,
            }, indent=2))
        except review_receipt.SubmissionError as e:
            # Publication may have been accepted before its response failed.
            # Leave action unknown; Poise verifies live receipts before retry.
            finish(id_, "failed", response=response, error=str(e), error_code="review_submission_failed")
            print(json.dumps({"id": id_, "error": str(e), "error_code": "review_submission_failed"}))
            raise SystemExit(1)
        except review_budget.ReviewLimitError as e:
            diagnostic = {**e.diagnostic, "call_id": id_, "correlation_id": correlation_id,
                          "repository": repo, "pr": mod.pr_number(pr), "reviewer": actor, "behavior": behavior,
                          "expected_head": expected_head} if e.diagnostic else None
            finish(id_, "failed", response=response, error=str(e), error_code=e.code, diagnostic=diagnostic)
            print(json.dumps({"id": id_, "error": str(e), "error_code": e.code, "diagnostic": diagnostic}))
            raise SystemExit(1)
        except atoms.AgentPreflightError as e:
            diagnostic = {**e.diagnostic, "call_id": id_, "correlation_id": correlation_id,
                          "repository": repo, "pr": mod.pr_number(pr), "reviewer": actor, "behavior": behavior,
                          "expected_head": expected_head} if e.diagnostic else None
            finish(
                id_,
                "failed",
                response=response,
                error=str(e),
                outcome="preflight_failed",
                action="not_started",
                error_code=e.code,
                diagnostic=diagnostic,
            )
            print(json.dumps({
                "id": id_,
                "model": name,
                "behavior": behavior,
                "actor": actor,
                "source": source,
                "correlation_id": correlation_id,
                "expected_head": expected_head,
                "action": "not_started",
                "outcome": "preflight_failed",
                "error": str(e),
                "error_code": e.code,
                "diagnostic": diagnostic,
            }, indent=2))
            raise SystemExit(1)
        except Exception as e:
            finish(id_, "failed", response=response, error=str(e))
            print(json.dumps({
                "id": id_,
                "model": name,
                "behavior": behavior,
                "actor": actor,
                "source": source,
                "correlation_id": correlation_id,
                "expected_head": expected_head,
                "error": str(e),
            }, indent=2))
            raise SystemExit(1)
        except BaseException as terminal:
            if not (isinstance(terminal, SystemExit) and terminal.code == 1):
                try:
                    with db() as conn:
                        row = conn.execute("select status, error_code from calls where id=?", (id_,)).fetchone()
                    if row is not None and row["status"] == "running":
                        stopping = row["error_code"] == "stopping"
                        finish(id_, "failed", response=response,
                               error="Stopped by user" if stopping else INTERRUPTED_ERROR,
                               error_code="stopped" if stopping else "interrupted")
                        print(json.dumps({"id": id_,
                                          "error": "Stopped by user" if stopping else INTERRUPTED_ERROR,
                                          "error_code": "stopped" if stopping else "interrupted"}))
                except Exception:
                    pass
            raise


def _proven_no_action(failure: review_budget.ReviewLimitError) -> bool:
    """Failures that prove this run posted no review: the approval guard's
    pre-POST refusal, a refused or no-op submission, or a verdict that never
    reached submission. Anything found afterward is another request's, never
    this run's recovery. Output-limit failures keep their recovery path: a
    different model still re-runs them."""
    if failure.code == "model_output_limit":
        return False
    if failure.code == "approval_blocked_unresolved_conversations":
        return True
    return (failure.diagnostic or {}).get("submission") in {"none", "rejected", "noop"}


def _repeat_only_refusal(failure: BaseException) -> bool:
    """A verdict GitHub refused only because every finding restated an
    already-published body. Proven no-action with nothing delivered, typed
    on the diagnostic so recovery never reads prose."""
    diagnostic = getattr(failure, "diagnostic", None)
    return (isinstance(failure, review_budget.ReviewLimitError)
            and failure.code == "review_contract_violation"
            and isinstance(diagnostic, dict)
            and diagnostic.get("refusal") == "repeat_only")


def _run_review_with_recovery(mod, behavior, pr, pwd, actor, head, note, seconds, p, spec, recovery, before, call_id,
                              capped=False, review_round=None, review_cap=None):
    # Only pr_approve runs capped rounds; pr_review neither accepts nor needs them.
    cap_kwargs = {"capped": capped, "review_round": review_round, "review_cap": review_cap} if behavior == "pr_approve" else {}
    try:
        return mod.run(pwd, pr, actor, head, note, seconds, p, model=spec.identity, **cap_kwargs), None
    except (review_budget.ReviewLimitError, subprocess.TimeoutExpired, review_receipt.SubmissionError) as error:
        if isinstance(error, review_budget.ReviewLimitError):
            failure = error
        elif isinstance(error, subprocess.TimeoutExpired):
            failure = review_budget.ReviewLimitError(
                "Review reached its total time limit; needs attention", "review_budget_exhausted")
        else:
            # An uncertain write: verify against GitHub below and adopt a
            # receipted landed review, but never auto-retry the write itself.
            # An unreceipted review stays unattributed and holds.
            failure = review_budget.ReviewLimitError(
                str(error), "review_submission_failed",
                diagnostic_envelope(operation="provider.review", phase="submitting", outcome="exit",
                                    stderr=str(error)[:500], submission="uncertain"))
        progress.stage("verifying", "Checking GitHub after interrupted review")
        try:
            facts = review_facts(mod, pr, pwd, actor, head, 0)
            receipt = review_receipt.get()
            proven = receipt is None and _proven_no_action(failure)
            # A repeat-only refusal is proven no-action, but its recovery
            # submits anew: it still needs the quiet-inventory proof below,
            # so a pending review cannot turn the re-verdict into a duplicate.
            # Adoption stays skipped — nothing found can be this run's.
            repeat_only = _repeat_only_refusal(failure)
            # A completed or superseded action wins over a later CLI failure.
            if facts["head_sha"] != head or facts["state"] != "OPEN" or facts["draft"]:
                return str(failure), behavior_outcome(mod, behavior, pr, pwd, actor, head, before, facts,
                                                       receipt=receipt, call_id=call_id, prior_error=str(failure),
                                                       prior_code=failure.code, proven_no_action=proven)
            if not proven or repeat_only:
                own = own_reviews(before, facts, receipt, call_id, proven_no_action=proven)
                if not proven:
                    if own is None:
                        counts = ("reviewer_change_requests_since", "reviewer_approvals_since", "reviewer_comments_since")
                        if any(_count(facts, key) != _count(before, key) for key in counts):
                            return str(failure), behavior_outcome(mod, behavior, pr, pwd, actor, head, before, facts,
                                                                  receipt=receipt, call_id=call_id, prior_error=str(failure))
                    elif receipt is not None or own:
                        return str(failure), behavior_outcome(mod, behavior, pr, pwd, actor, head, before, facts,
                                                               receipt=receipt, call_id=call_id, prior_error=str(failure))
                # Require positive no-action proof, including pending reviews.
                if _count(facts, "reviewer_pending_reviews") != 0:
                    raise RuntimeError("a pending GitHub review requires reconciliation")
                if repeat_only and own:
                    # Another request's review is already published on this
                    # head: no re-verdict, so this run cannot publish a second
                    # review the final verification would reject as duplicate.
                    raise RuntimeError("another review is already published on this head; no re-verdict was attempted")
                if own is None and (_count(facts, "reviewer_reviews_since") != _count(before, "reviewer_reviews_since")
                        or facts.get("reviewer_latest_any_review_id") != before.get("reviewer_latest_any_review_id")):
                    raise RuntimeError("review activity changed without matching counters")
            # A proven no-action run posted nothing: a later review is another
            # request's, never this run's recovery. The failure stands verbatim.
        except review_budget.ReviewLimitError as typed:
            if typed.code == "approval_dismissed_stale":
                # A stale-dismissed approval reconciles as a typed release
                # even when the provider failed first: the current head still
                # needs a fresh evaluation, not a hold.
                raise
            raise review_budget.ReviewLimitError(
                f"{failure}; could not prove a safe recovery: {typed}", failure.code, failure.diagnostic) from typed
        except Exception as verification:
            raise review_budget.ReviewLimitError(
                f"{failure}; could not prove a safe recovery: {verification}", failure.code, failure.diagnostic) from verification
        # A Claude output limit and a repeat-only publication refusal are
        # recoverable, each once, by a different model. Live GitHub inventory
        # above proved the failed attempt posted nothing, so the re-verdict is
        # a new verdict on the same head, never a replay of an uncertain write.
        output_limit = failure.code == "model_output_limit" and spec.provider == "claude"
        if (not repeat_only and not output_limit) or recovery.identity == spec.identity:
            raise failure
        review_budget.timeout(seconds, reserve=review_budget.FINAL_CHECK_SECONDS)
        # Durable before launch; a process restart cannot silently repeat it.
        with db() as conn:
            changed = conn.execute("update calls set recovery_model=? where id=? and recovery_model is null and ended_at is null",
                                   (recovery.identity, call_id)).rowcount
        if changed != 1:
            raise review_budget.ReviewLimitError("Recovery was already attempted; needs attention", "review_recovery_failed")
        progress.stage("recovering", f"Repeat-only refusal; re-verdicting once with {recovery.identity}"
                       if repeat_only else f"Output limit reached; recovering once with {recovery.identity}")
        try:
            response = mod.run(pwd, pr, actor, head, note, seconds, p, model=recovery.identity, **cap_kwargs)
            if repeat_only:
                # The re-verdict delivered; the response keeps the refused
                # first attempt beside it, so the refusal is never mistaken
                # for the delivered verdict.
                response = f"{failure}\n{response}"
            return response, None
        except ReviewSuperseded as superseded:
            if repeat_only:
                superseded.prior_error = str(failure)
            raise
        except Exception as recovery_error:
            # A submission may have succeeded before its response was lost.
            # Adopt only a terminal outcome verified from GitHub, never text,
            # with exact ownership so a sibling's review cannot settle this run.
            try:
                result = behavior_outcome(mod, behavior, pr, pwd, actor, head, before,
                                          receipt=review_receipt.get(), call_id=call_id)
            except Exception:
                pass
            else:
                if repeat_only:
                    return f"{failure}\n{recovery_error}", result
                return str(recovery_error), result
            message = f"{recovery.identity} recovery failed; needs attention: {recovery_error}"
            if repeat_only:
                message = f"{message}; prior: {failure}"
            raise review_budget.ReviewLimitError(message, "review_recovery_failed") from recovery_error


# A sibling that submitted a moment ago may not have recorded its review id
# yet; a sibling claim is looked for again after this long before the extra
# review is left unattributed. Claims only ever exclude; they never adopt.
SIBLING_GRACE_SECONDS = 2.0
# The run cannot prove what it published, or another run published what this
# run cannot distinguish from its own uncertain write. Held, never retried.
REVIEW_PUBLICATION_UNCERTAIN_CODE = "review_publication_uncertain"
RECEIPT_STATES = {"requested_changes": "CHANGES_REQUESTED", "reviewed_clean": "COMMENTED", "approved_pr": "APPROVED"}
# A pull request in either state is gone for review purposes: the round the
# run prepared is obsolete, whatever the provider did or did not submit.
CLOSED_TARGET_STATES = {"CLOSED", "MERGED"}
REVIEW_TARGET_CLOSED_CODE = "review_target_closed"


def _review_items(facts: dict) -> list[dict] | None:
    items = facts.get("reviewer_reviews_since_items")
    if not isinstance(items, list):
        return None
    for item in items:
        if not isinstance(item, dict) or isinstance(item.get("id"), bool) or not isinstance(item.get("id"), int):
            raise RuntimeError("github-interface review outcome returned invalid reviewer_reviews_since_items")
    return items


def _receipt_conflict_error() -> review_budget.ReviewLimitError | None:
    """This call's genuine double write, when it recorded two accepted replies.

    Two POST replies observed by this same call are positive same-call
    evidence no inventory coincidence can supply. Both identities stay in the
    error; unrelated runs are unaffected."""
    pair = review_receipt.conflict()
    if pair is None:
        return None
    first, second = pair["first"], pair["second"]
    if first.get("review_id") == second.get("review_id"):
        return review_budget.ReviewLimitError(
            f"review behavior recorded contradictory receipts for review {first.get('review_id')}; needs attention",
            "review_contract_violation")
    return review_budget.ReviewLimitError(
        f"review behavior produced duplicate GitHub reviews {first.get('review_id')} and {second.get('review_id')}; needs attention",
        "review_contract_violation")


def _unattributed_error(unclaimed: list[dict]) -> review_budget.ReviewLimitError:
    shown = ",".join(str(item["id"]) for item in sorted(unclaimed, key=lambda item: item["id"])[:10])
    extra = f",+{len(unclaimed) - 10} more" if len(unclaimed) > 10 else ""
    return review_budget.ReviewLimitError(
        f"review publication is uncertain: {len(unclaimed)} new same-account review(s) [{shown}{extra}] "
        f"cannot be attributed to this run; needs attention",
        REVIEW_PUBLICATION_UNCERTAIN_CODE)


def _unclaimed_ids(before_new: list[dict], exclude: set[int], repo: str, number: str, call_id: str) -> list[dict]:
    found = [item for item in before_new if item["id"] not in exclude
             and item["id"] not in review_receipt.sibling_ids(DB, call_id, repo, number)]
    if found:
        sleep(SIBLING_GRACE_SECONDS)
        found = [item for item in before_new if item["id"] not in exclude
                 and item["id"] not in review_receipt.sibling_ids(DB, call_id, repo, number)]
    return found


def own_reviews(before: dict, facts: dict, receipt: dict | None, call_id: str | None,
                proven_no_action: bool = False) -> list[dict] | None:
    """The reviews this run posted, by positive per-call evidence only.

    With a receipt, the receipted review: this run's own POST reply named it.
    Any other new review stays unattributed — an independent writer using the
    account need not have a local sibling row, so elimination proves nothing,
    and a sibling delayed past the grace must never settle the wrong run.
    Without a receipt nothing is attributable. None when github-interface
    predates per-review ids; the counters decide then, and they can only
    supersede or hold, never adopt. With proven_no_action the caller proved
    this run posted nothing, so unclaimed reviews are returned as-is instead
    of raising: they are definitively another request's. Callers must never
    adopt them — behavior_outcome clears attribution under proof, and the
    recovery path uses them only for its already-published guard."""
    after = _review_items(facts)
    earlier = _review_items(before)
    if after is None or earlier is None:
        return None
    seen = {item["id"] for item in earlier}
    new = [item for item in after if item["id"] not in seen]
    if receipt is not None:
        if call_id:
            duplicate = _receipt_conflict_error()
            if duplicate is not None:
                raise duplicate
            repo, number = str(facts.get("repository") or ""), str(facts.get("pull_number") or "")
            if receipt["review_id"] in review_receipt.sibling_ids(DB, call_id, repo, number):
                raise review_budget.ReviewLimitError(
                    f"review {receipt['review_id']} is claimed by another run; ownership conflicts, needs attention",
                    "review_contract_violation")
        own = [item for item in new if item["id"] == receipt["review_id"]]
        if call_id and len(new) > len(own):
            repo, number = str(facts.get("repository") or ""), str(facts.get("pull_number") or "")
            extra = _unclaimed_ids(new, {receipt["review_id"]}, repo, number, call_id)
            if extra and review_receipt.failure():
                # The receipted write stands on its own reply, but this run
                # also saw a transient submission answer: the extra may be the
                # uncertain write's, or an independent writer's. Retain that
                # uncertainty instead of declaring either provenance as fact.
                raise _unattributed_error(extra)
        return own
    if not new:
        return new
    if not call_id:
        return []
    repo, number = str(facts.get("repository") or ""), str(facts.get("pull_number") or "")
    unclaimed = _unclaimed_ids(new, set(), repo, number, call_id)
    if unclaimed:
        if proven_no_action:
            return unclaimed
        raise _unattributed_error(unclaimed)
    return []


def _own_outcome(behavior: str, own: list[dict], expected_head: str, receipt: dict | None) -> dict[str, str | None]:
    if len(own) != 1:
        if not own and receipt is None and review_receipt.failure():
            raise review_receipt.SubmissionError(review_receipt.failure())
        if not own and receipt is None and behavior == "pr_approve" and review_receipt.blocked():
            raise review_budget.ReviewLimitError(
                f"approval blocked by unresolved review conversations: {review_receipt.blocked()}",
                "approval_blocked_unresolved_conversations")
        kind = "review behavior must produce exactly one atomic clean or change-request review" if behavior == "pr_review" \
            else "approval behavior must produce exactly one atomic approval or change-request review"
        raise review_budget.ReviewLimitError(kind, "review_contract_violation")
    review = own[0]
    state = review.get("state")
    if receipt is not None and RECEIPT_STATES.get(receipt["action"]) != state:
        if state == "DISMISSED" and receipt["action"] in ("requested_changes", "reviewed_clean"):
            # The verdict posted, then someone dismissed it before
            # verification: the round completed, so its original kind stands.
            state = RECEIPT_STATES[receipt["action"]]
        elif state == "DISMISSED" and receipt["action"] == "approved_pr":
            # A dismissed approval confers no approval authority and is not
            # a change request either: fail loudly instead of reconciling it.
            raise RuntimeError("submitted approval was dismissed before verification")
        else:
            raise RuntimeError("submitted review does not match its receipt")
    if receipt is not None and str(receipt.get("head_sha") or "").lower() != expected_head:
        # The reply's own head disagrees with the expected one: a receipt for
        # another head cannot adopt a review on this one.
        raise RuntimeError("submitted review receipt does not match the expected head")
    if str(review.get("commit") or "").lower() != expected_head:
        raise RuntimeError("terminal review is not attached to the expected head")
    _parse_time(str(review.get("submitted_at") or ""), "submitted_at")
    if behavior == "pr_review":
        if state == "APPROVED":
            raise RuntimeError("review behavior produced an unexpected approval")
        if state == "COMMENTED":
            return {"action": "reviewed_clean", "outcome": "clean", "head_sha": expected_head}
    elif state == "APPROVED":
        return {"action": "approved", "outcome": "approved", "head_sha": expected_head}
    if state == "CHANGES_REQUESTED":
        return {"action": "requested_changes", "outcome": "changes_requested", "head_sha": expected_head}
    raise RuntimeError("latest review state does not match the terminal behavior action")


def _closed_target_evidence(before: dict, facts: dict, receipt: dict | None, call_id: str | None) -> str:
    """Who may have published what, for a close-settled round.

    The shared reviewer identity alone never attributes a review: the run's
    own receipt, its siblings' claimed ids and the remaining unclaimed
    reviews are listed side by side instead. Bounded, and never raises — a
    broken inventory reads as unknown, never as proof of no action.
    """
    try:
        after = _review_items(facts)
        earlier = _review_items(before)
    except RuntimeError:
        return "review inventory malformed; publication state unknown"
    if after is None or earlier is None:
        return f"review inventory unavailable; publication state unknown; receipt={receipt!r}"[:1000]
    seen = {item["id"] for item in earlier}
    fresh = [(item["id"], item.get("state")) for item in after if item["id"] not in seen]
    try:
        siblings = review_receipt.sibling_ids(
            DB, call_id, str(facts.get("repository") or ""), str(facts.get("pull_number") or "")) if call_id else set()
    except Exception:
        siblings = None
    receipted = receipt.get("review_id") if receipt else None

    def listed(entries: list[str]) -> str:
        shown = ",".join(entries[:10])
        return shown + (f",+{len(entries) - 10} more" if len(entries) > 10 else "")

    unclaimed = [f"{review_id}/{state}" for review_id, state in fresh
                 if review_id != receipted and (siblings is None or review_id not in siblings)]
    own = "none" if receipt is None else f"id={receipted} action={receipt.get('action')}"
    claimed = "unknown" if siblings is None else f"[{listed(sorted(str(i) for i in siblings))}]"
    return f"receipt={own}; new_unclaimed=[{listed(unclaimed)}]; sibling_claimed={claimed}"[:1000]


def _closed_target_result(*, facts: dict, evidence: str, attribution: str,
                          prior_error: str | None = None, phase: str = "verifying") -> dict:
    """The terminal disposition for work a closed target made obsolete.

    Superseded, never clean: the round cannot complete on a closed pull
    request. The original failure, the attribution gap and the ownership
    inventory stay on the row, so the settle neither hides what went wrong
    nor claims an unknown worker stopped; a superseded outcome authorizes
    no replay.
    """
    state = facts["state"]
    actual = str(facts["head_sha"]).lower()
    note = "; ".join(part for part in (
        (prior_error or "")[:500],
        f"target {state}",
        attribution[:500],
        evidence[:500],
    ) if part)
    return {
        "action": None,
        "outcome": "superseded",
        "head_sha": actual,
        "error": note,
        "error_code": REVIEW_TARGET_CLOSED_CODE,
        "diagnostic": diagnostic_envelope(
            operation="review.verify", phase=phase, outcome="target_closed",
            stderr=note[:500], message=evidence[:1000], observed_head=actual),
    }


def _moved_target_result(actual_head: str, prior_error: str | None, prior_code: str | None) -> dict:
    """The terminal disposition for work a moved target made obsolete.

    Nothing was posted and the head moved on: a clean supersede. When a
    failure preceded it, the original disposition stays on the row instead
    of a bare supersede losing what the run was waiting on or hit.
    """
    result: dict = {"action": None, "outcome": "superseded", "head_sha": actual_head}
    if prior_error is not None:
        result["error"] = prior_error
        if prior_code is not None:
            result["error_code"] = prior_code
    return result


def _caller_context(envelope: dict, call_id: str, correlation_id: str, repo: str, pr_number: str,
                    reviewer: str, behavior: str, expected_head: str) -> dict:
    """The durable launch identity a close-settled diagnostic carries, the
    same context the failure paths attach."""
    return {**envelope, "call_id": call_id, "correlation_id": correlation_id,
            "repository": repo, "pr": pr_number, "reviewer": reviewer,
            "behavior": behavior, "expected_head": expected_head}


def behavior_outcome(
    mod,
    behavior: str,
    pr: str,
    pwd: str,
    actor: str,
    expected_head: str,
    before: dict,
    facts: dict | None = None,
    receipt: dict | None = None,
    call_id: str | None = None,
    prior_error: str | None = None,
    prior_code: str | None = None,
    proven_no_action: bool = False,
) -> dict:
    if facts is None:
        facts = review_facts(mod, pr, pwd, actor, expected_head, 0)
    if behavior not in {"pr_review", "pr_approve"}:
        raise RuntimeError(f"unsupported governed behavior: {behavior}")
    actual_head = str(facts["head_sha"]).lower()
    stale = facts["state"] != "OPEN" or facts["draft"] is True or actual_head != expected_head
    closed = facts["state"] in CLOSED_TARGET_STATES

    def settled(attribution: str) -> dict:
        return _closed_target_result(
            facts=facts,
            evidence=_closed_target_evidence(before, facts, receipt, call_id),
            attribution=attribution,
            prior_error=prior_error,
        )

    try:
        own = own_reviews(before, facts, receipt, call_id, proven_no_action=proven_no_action)
    except review_budget.ReviewLimitError as duplicates:
        # Two reviews under the shared identity with no attributable owner.
        # On an open target that ambiguity holds; on a confirmed-closed one
        # the round is over and the evidence settles with it.
        if not closed:
            raise
        return settled(str(duplicates))
    if proven_no_action and receipt is None and own is not None:
        # Proven no-action without a receipt: no new review can be this
        # run's, so attribution stays empty. A later review is another
        # request's — settlement keeps this run's own disposition instead
        # of adopting it.
        own = []
    if own is not None:
        try:
            if len(own) == 1:
                if (receipt is not None and receipt.get("action") == "approved_pr"
                        and own[0].get("state") == "DISMISSED" and stale):
                    # GitHub dismissed the posted approval as stale after the
                    # target moved: no approval authority, but the current head
                    # needs a fresh evaluation, not a hold. Poise releases this
                    # typed failure like a supersede.
                    raise review_budget.ReviewLimitError(
                        "submitted approval was dismissed as stale after the target moved",
                        "approval_dismissed_stale")
                # A posted review wins over a target that went stale after the
                # submission: the round completed on the expected head.
                return _own_outcome(behavior, own, expected_head, receipt)
            if stale and not own and receipt is None:
                if closed:
                    # Nothing posted and the target closed: the round is
                    # obsolete, with its no-action evidence retained.
                    return settled("no review attributable to this run was posted")
                # Nothing posted and the target moved on: a clean supersede
                # that keeps the preceding failure's disposition, if any.
                return _moved_target_result(actual_head, prior_error, prior_code)
            return _own_outcome(behavior, own, expected_head, receipt)
        except (review_budget.ReviewLimitError, RuntimeError) as unattributed:
            if not closed or str(unattributed).startswith("github-interface review outcome returned "):
                raise
            return settled(str(unattributed))
    if closed:
        return settled("legacy counters cannot attribute publication to this run")
    # Without per-review ids a moved head cannot be attributed to a posted
    # review, so the legacy counter path keeps its supersede-first rule.
    if stale:
        return _moved_target_result(actual_head, prior_error, prior_code)
    change_requests = _count(facts, "reviewer_change_requests_since") - _count(
        before,
        "reviewer_change_requests_since",
    )
    approvals = _count(facts, "reviewer_approvals_since") - _count(
        before,
        "reviewer_approvals_since",
    )
    comments = _count(facts, "reviewer_comments_since") - _count(
        before,
        "reviewer_comments_since",
    )
    if not any((change_requests, approvals, comments)) and receipt is None and review_receipt.failure():
        raise review_receipt.SubmissionError(review_receipt.failure())
    if not any((change_requests, approvals, comments)) and receipt is None and behavior == "pr_approve" \
            and review_receipt.blocked():
        raise review_budget.ReviewLimitError(
            f"approval blocked by unresolved review conversations: {review_receipt.blocked()}",
            "approval_blocked_unresolved_conversations")
    if change_requests < 0 or approvals < 0 or comments < 0:
        raise RuntimeError("review activity counters moved backwards")
    previous_review_id = str(before.get("reviewer_latest_review_id") or "")
    previous_any_review_id = str(before.get("reviewer_latest_any_review_id") or "")

    # Without per-review ids the counters cannot tell this run's review from a
    # sibling's or an independent writer's: aggregate progress validates the
    # shape of what happened, but never adopts a publication from it.
    unattributed = review_budget.ReviewLimitError(
        "review publication cannot be attributed without per-review inventory; needs attention",
        REVIEW_PUBLICATION_UNCERTAIN_CODE)
    if behavior == "pr_review":
        if approvals:
            raise RuntimeError("review behavior produced an unexpected approval")
        if (change_requests, comments) not in {(1, 0), (0, 1)}:
            raise RuntimeError(
                "review behavior must produce exactly one atomic clean or change-request review"
            )
        if comments:
            _validate_latest_review(
                facts,
                "COMMENTED",
                expected_head,
                previous_any_review_id,
                "reviewer_latest_any",
            )
            raise unattributed
        _validate_latest_review(
            facts,
            "CHANGES_REQUESTED",
            expected_head,
            previous_review_id,
        )
        raise unattributed

    if behavior != "pr_approve":
        raise RuntimeError(f"unsupported governed behavior: {behavior}")
    if (change_requests, approvals) not in {(1, 0), (0, 1)}:
        raise RuntimeError(
            "approval behavior must produce exactly one atomic approval or change-request review"
        )
    if approvals:
        _validate_latest_review(facts, "APPROVED", expected_head, previous_review_id)
        raise unattributed
    _validate_latest_review(
        facts,
        "CHANGES_REQUESTED",
        expected_head,
        previous_review_id,
    )
    raise unattributed


def review_facts(
    mod,
    pr: str,
    pwd: str,
    actor: str,
    expected_head: str,
    since: float,
) -> dict:
    repo = mod.repo_name(pr, pwd)
    done = subprocess.run(
        [
            os.getenv("GITHUB_INTERFACE_CLI", "github-interface"),
            "--review-activity-since",
            f"#{mod.pr_number(pr)}",
            "--username",
            actor,
            "--since",
            utc_stamp(since),
            "--token-user",
            actor,
        ],
        text=True,
        capture_output=True,
        cwd=pwd,
        timeout=review_budget.timeout(60),
    )
    if done.returncode:
        raise RuntimeError(
            (done.stderr or done.stdout).strip()
            or f"github-interface review outcome exited {done.returncode}"
        )
    try:
        facts = json.loads(done.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("github-interface review outcome returned invalid JSON") from error
    _validate_outcome_facts(facts, mod.pr_number(pr), repo, actor, expected_head)
    return facts


def _validate_outcome_facts(
    facts: object,
    pr_number: str,
    repo: str,
    actor: str,
    expected_head: str,
) -> None:
    if not isinstance(facts, dict):
        raise RuntimeError("github-interface review outcome returned a non-object")
    expected = {
        "action": "review_activity_since",
        "repository": repo,
        "pull_number": int(pr_number),
    }
    for field, value in expected.items():
        if facts.get(field) != value:
            raise RuntimeError(f"github-interface review outcome returned invalid {field}")
    if str(facts.get("username") or "").lower() != actor.lower():
        raise RuntimeError("github-interface review outcome returned the wrong actor")
    if facts.get("state") not in {"OPEN", "CLOSED", "MERGED"}:
        raise RuntimeError("github-interface review outcome returned invalid state")
    if not isinstance(facts.get("draft"), bool):
        raise RuntimeError("github-interface review outcome returned invalid draft")
    if not atoms.SHA_RE.fullmatch(str(facts.get("head_sha") or "").lower()):
        raise RuntimeError("github-interface review outcome returned invalid head_sha")


def _validate_latest_review(
    facts: dict,
    expected_state: str,
    expected_head: str,
    previous_review_id: str,
    prefix: str = "reviewer_latest",
) -> None:
    if facts.get(f"{prefix}_state") != expected_state:
        raise RuntimeError("latest review state does not match the terminal behavior action")
    if str(facts.get(f"{prefix}_commit") or "").lower() != expected_head:
        raise RuntimeError("terminal review is not attached to the expected head")
    review_id = str(facts.get(f"{prefix}_review_id") or "")
    if not review_id:
        raise RuntimeError("terminal review has no review id")
    if review_id == previous_review_id:
        raise RuntimeError("terminal review id did not advance during the behavior")
    _parse_time(
        str(facts.get(f"{prefix}_submitted_at") or ""),
        f"{prefix}_submitted_at",
    )


def _count(facts: dict, field: str) -> int:
    value = facts.get(field)
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise RuntimeError(f"github-interface review outcome returned invalid {field}")
    return value


def _parse_time(value: str, field: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise RuntimeError(f"github-interface review outcome returned invalid {field}") from error
    if parsed.tzinfo is None:
        raise RuntimeError(f"github-interface review outcome returned timezone-free {field}")
    return parsed


HELP = """usage: agent-interface BEHAVIOR ...

behaviors:
  --models
  --refresh-models [--families claude,codex]
  --logs [--status running] [--limit 1..1000] [--cursor CURSOR] [--org OWNER] [--search TEXT]
  --logs --select '{"latest":[{"behavior":"...","source":"...","owner":"..."}],"ids":["CALL_ID"]}'
  --logs --watermark
  --logs --after WATERMARK --session SESSION --behavior BEHAVIOR --prompt TEXT
  --diagnostics [after-sequence] [limit-1..10]
  --stop CALL_ID
  --read-response HASH
  --read-reasoning HASH
  --chat MESSAGE --model MODEL [--session ID] [--pwd DIR]
  --pr-review PR --actor USER --expected-head SHA --source SOURCE --correlation-id ID [--pwd DIR] [--p P] [--note TEXT] [--model MODEL] [--recovery-model MODEL]
  --pr-approve PR --actor USER --expected-head SHA --source SOURCE --correlation-id ID [--pwd DIR] [--p P] [--note TEXT] [--model MODEL] [--recovery-model MODEL] [--review-cap-reached --review-round N --review-cap N]
  --fix-failing-ci PR [--pwd DIR]
  --issue-simplify ISSUE [--pwd DIR]
  --issue-review OWNER/REPO#N --model MODEL --actor USER --source SOURCE --correlation-id ID [--recovery-model MODEL] [--expected-issue-revision SHA256] [--note TEXT]
  --atomic-work OWNER/REPO#N --model MODEL --actor USER --source SOURCE --correlation-id ID --branch BRANCH [--pull-number N --expected-head SHA] [--merge-base] [--expected-issue-revision SHA256] [--note TEXT]
  --read-action-plan CALL_ID
  --complete-atomic-publication CALL_ID PLAN_SHA HEAD_SHA
  --author-content TOPIC [--session-id ID] [--pwd DIR] [--voice-guide PATH]
  --debate TOPIC [--rounds N]
  --record-turn start --model MODEL --session ID --source SOURCE [--repo OWNER/NAME --pr N] [--correlation-id ID]
  --record-turn finish CALL_ID --status completed|failed|cancelled [--error TEXT]
  --pr-stop-gate
  --install-pr-stop-gate

help:
  agent-interface BEHAVIOR --help"""


def usage(code: int = 2, error: str | None = None):
    out = sys.stdout if code == 0 else sys.stderr
    if error:
        print(f"error: {error}\n", file=out)
    print(HELP, file=out)
    raise SystemExit(code)


def flag_value(flag: str) -> str | None:
    if flag not in sys.argv:
        return None
    i = sys.argv.index(flag) + 1
    if i >= len(sys.argv) or sys.argv[i].startswith("--"):
        usage()
    return sys.argv[i]


def flag_values(flag: str) -> list[str]:
    values = []
    for i, arg in enumerate(sys.argv):
        if arg == flag and i + 1 < len(sys.argv) and not sys.argv[i + 1].startswith("--"):
            values.append(sys.argv[i + 1])
    return values


def required_flag(flag: str) -> str:
    value = flag_value(flag)
    if not value:
        usage(error=f"{flag} is required")
    return value


def _review_cap_number(flag: str, capped: bool) -> int | None:
    value = flag_value(flag)
    if value is None:
        return None
    if not capped:
        usage(error=f"{flag} needs --review-cap-reached")
    if not value.isdigit() or int(value) < 1:
        usage(error=f"{flag} must be a positive integer")
    return int(value)


def main():
    try:
        _main()
    except Exception as error:
        # An accepted managed invocation also gets a durable no-effect receipt
        # if model/catalog preparation failed before its usual track() call.
        # The same unique correlation still arbitrates racing CLI starts.
        if flag_value("--source") == "poise:behavior-chain" and flag_value("--correlation-id"):
            correlation = atoms.correlation_id(flag_value("--correlation-id"))
            with db() as conn:
                existing = conn.execute("select id from calls where correlation_id=?", (correlation,)).fetchone()
            if existing is None:
                behavior = {"--issue-review": "issue_review", "--atomic-work": "repair_pr" if flag_value("--pull-number") else "implement_issue",
                            "--pr-review": "pr_review", "--pr-approve": "pr_approve"}.get(sys.argv[1])
                if behavior:
                    if behavior in {"issue_review", "implement_issue", "repair_pr"}:
                        repository, number = issue_review.parse(sys.argv[2])
                        if behavior == 'repair_pr':
                            number = int(required_flag('--pull-number'))
                    else:
                        repository, number = atoms.repo_name(sys.argv[2], flag_value("--pwd")), int(atoms.pr_number(sys.argv[2]))
                    id_ = track(required_flag("--model"), "", str(number), repository, atoms.actor(required_flag("--actor")), behavior,
                                expected_head=flag_value("--expected-head"), source="poise:behavior-chain", correlation_id=correlation)
                    finish(id_, "failed", error=str(error)[:2000], outcome="preflight_failed", action="not_started", error_code="launch_preflight_failed")
        raise
    finally:
        # The managed behavior wrapper has returned through provider/group,
        # checkout-lease and artifact cleanup. A turn result alone never
        # authorizes the chain's next invocation.
        if flag_value("--source") == "poise:behavior-chain" and flag_value("--correlation-id"):
            with db() as conn:
                conn.execute("update calls set resources_settled_at=? where correlation_id=? and pid=? and status != 'running' "
                             "and coalesce(json_extract(artifact, '$.phase'), '') != 'resources_unknown' "
                             "and json_extract(artifact, '$.resource_error') is null",
                             (time(), flag_value("--correlation-id"), str(os.getpid())))
                row = conn.execute("select id from calls where correlation_id=? and pid=?", (flag_value("--correlation-id"), str(os.getpid()))).fetchone()
                if row is not None:
                    mark_managed_no_write(conn, row["id"])


def _main():
    if len(sys.argv) == 1:
        usage(error="first argument must be a behavior switch")
    if sys.argv[1:] in (["--help"], ["-h"]) or sys.argv[-1] in ("--help", "-h"):
        usage(0)
    if sys.argv[1:] == ["--models"]:
        print(json.dumps({**CATALOG.export(), "policy": review_budget.REVIEW_POLICY}, indent=2))
        return
    if len(sys.argv) >= 2 and sys.argv[1] == "--refresh-models":
        from . import catalog_refresh
        rest = sys.argv[2:]
        if not rest:
            print(json.dumps(catalog_refresh.refresh(), indent=2))
            return
        # Absent selection probes every family; an explicit selection probes
        # only it, and an explicit empty selection probes nothing.
        if len(rest) != 2 or rest[0] != "--families":
            usage(error="--refresh-models takes only --families <a,b>")
        names = [] if rest[1] == "" else rest[1].split(",")
        unknown = [name for name in names if name not in catalog_refresh.FAMILIES]
        if unknown:
            usage(error=f"unknown model family {unknown[0]}")
        print(json.dumps(catalog_refresh.refresh(families=names), indent=2))
        return
    if len(sys.argv) == 3 and sys.argv[1] == "--read-action-plan":
        print(json.dumps(read_action_plan(sys.argv[2]), ensure_ascii=False))
        return
    if len(sys.argv) == 5 and sys.argv[1] == "--complete-atomic-publication":
        print(json.dumps(complete_atomic_publication(*sys.argv[2:]), ensure_ascii=False))
        return
    if len(sys.argv) == 3 and sys.argv[1] == "--stop":
        call_id = sys.argv[2]
        if not re.fullmatch(r"[0-9a-f]{32}", call_id):
            raise ValueError("stop requires a full call id")
        print(json.dumps(stop_call(call_id)))
        return
    if len(sys.argv) == 3 and sys.argv[1] == "--read-reasoning":
        call_id = sys.argv[2]
        if not re.fullmatch(r"[0-9a-f]{32}", call_id):
            raise ValueError("reasoning requires a full call id")
        with db() as conn:
            if not conn.execute("select 1 from calls where id=?", (call_id,)).fetchone():
                raise ValueError("unknown call id")
        path = DB.parent / "reasoning" / f"{call_id}.txt"
        print(path.read_text(encoding="utf-8") if path.exists() else "")
        return
    if len(sys.argv) in (2, 3, 4) and sys.argv[1] == "--diagnostics":
        after = int(sys.argv[2]) if len(sys.argv) >= 3 else 0
        limit = int(sys.argv[3]) if len(sys.argv) == 4 else 3
        print(json.dumps(diagnostics(after, limit), allow_nan=False))
        return
    if len(sys.argv) >= 2 and sys.argv[1] == "--logs":
        if sys.argv[2:] == ["--watermark"]:
            print(json.dumps({"cursor": logs_watermark()}))
            return
        if len(sys.argv) == 4 and sys.argv[2] == "--select":
            try:
                selection = json.loads(sys.argv[3])
                selected = logs_selected(selection)
            except (ValueError, TypeError) as error:
                usage(error=str(error))
            print(json.dumps(selected, separators=(",", ":")))
            return
        seen: dict[str, str] = {}
        rest = sys.argv[2:]
        i = 0
        while i < len(rest):
            flag = rest[i]
            if flag not in ("--status", "--limit", "--cursor", "--org", "--search", "--after", "--session", "--behavior", "--prompt") or flag in seen or i + 1 >= len(rest):
                usage()
            seen[flag] = rest[i + 1]
            i += 2
        session_flags = {"--after", "--session", "--behavior", "--prompt"}
        if session_flags.intersection(seen):
            if set(seen) != session_flags:
                usage(error="session log reads require after, session, behavior and prompt only")
            try:
                selected = logs_session_since(seen["--after"], seen["--session"], seen["--behavior"], seen["--prompt"])
            except ValueError as error:
                usage(error=str(error))
            print(json.dumps(selected, separators=(",", ":")))
            return
        if "--status" in seen and ("--limit" in seen or "--cursor" in seen or "--org" in seen or "--search" in seen):
            usage(error="--status running cannot combine with --limit, --cursor, --org or --search")
        if "--cursor" in seen and "--limit" not in seen:
            usage(error="--cursor requires --limit")
        if ("--org" in seen or "--search" in seen) and "--limit" not in seen:
            usage(error="--org and --search require --limit")
        if "--limit" in seen:
            try:
                limit = int(seen["--limit"])
            except ValueError:
                usage(error="--limit must be an integer")
            try:
                payload: object = logs_page(limit, seen.get("--cursor"), seen.get("--org"), seen.get("--search"))
            except ValueError as error:
                usage(error=str(error))
        else:
            status = seen.get("--status")
            if status is not None and status != "running":
                usage(error="--status must be running")
            payload = logs(status=status)
        print(json.dumps(payload, separators=(",", ":")))
        return
    if sys.argv[1:] == ["--pr-stop-gate"]:
        pr_stop_gate.run()
        return
    if sys.argv[1:] == ["--install-pr-stop-gate"]:
        print(json.dumps(pr_stop_gate.install(), indent=2))
        return
    if len(sys.argv) == 3 and sys.argv[1] == "--read-response":
        read_response(sys.argv[2])
        return
    if len(sys.argv) >= 3 and sys.argv[1] == "--record-turn":
        run_record_turn(sys.argv[2])
        return
    if len(sys.argv) >= 3 and sys.argv[1] == "--chat":
        model = flag_value("--model")
        session_id = flag_value("--session")
        if not model:
            usage()
        run_chat(
            model,
            session_id,
            sys.argv[2],
            flag_value("--pwd"),
            no_tools="--no-tools" in sys.argv,
            allowed_tools=flag_values("--allow-command"),
            conda_env=flag_value("--conda-env"),
            pip_upgrade=flag_value("--pip-upgrade"),
        )
        return
    if len(sys.argv) >= 3 and sys.argv[1] == "--pr-review":
        run_pr_review(
            sys.argv[2],
            required_flag("--actor"),
            required_flag("--expected-head"),
            required_flag("--source"),
            required_flag("--correlation-id"),
            flag_value("--pwd"),
            note=flag_value("--note") or "",
            p=flag_value("--p"),
            model=flag_value("--model"),
            recovery_model=flag_value("--recovery-model"),
        )
        return
    if len(sys.argv) >= 3 and sys.argv[1] == "--pr-approve":
        capped = "--review-cap-reached" in sys.argv
        review_round = _review_cap_number("--review-round", capped)
        review_cap = _review_cap_number("--review-cap", capped)
        if capped and (review_round is None or review_cap is None):
            usage(error="--review-cap-reached needs --review-round N and --review-cap N")
        run_pr_approve(
            sys.argv[2],
            required_flag("--actor"),
            required_flag("--expected-head"),
            required_flag("--source"),
            required_flag("--correlation-id"),
            flag_value("--pwd"),
            note=flag_value("--note") or "",
            p=flag_value("--p"),
            model=flag_value("--model"),
            recovery_model=flag_value("--recovery-model"),
            capped=capped,
            review_round=review_round,
            review_cap=review_cap,
        )
        return
    if len(sys.argv) >= 3 and sys.argv[1] == "--fix-failing-ci":
        run_fix_failing_ci(sys.argv[2], flag_value("--pwd"))
        return
    if len(sys.argv) >= 3 and sys.argv[1] == "--issue-review":
        run_issue_review(
            sys.argv[2],
            required_flag("--actor"),
            required_flag("--source"),
            required_flag("--correlation-id"),
            required_flag("--model"),
            flag_value("--recovery-model"),
            note=flag_value("--note") or "",
            expected_issue_revision=flag_value("--expected-issue-revision"),
        )
        return
    if len(sys.argv) >= 3 and sys.argv[1] == "--atomic-work":
        pull = flag_value("--pull-number")
        run_atomic_work(sys.argv[2], required_flag("--actor"), required_flag("--source"), required_flag("--correlation-id"),
                        required_flag("--model"), required_flag("--branch"), int(pull) if pull else None,
                        flag_value("--expected-head"), flag_value("--note") or "", "--merge-base" in sys.argv,
                        flag_value("--expected-issue-revision"))
        return
    if len(sys.argv) >= 3 and sys.argv[1] == "--issue-simplify":
        run_issue_simplify(sys.argv[2], flag_value("--pwd"))
        return
    if len(sys.argv) >= 3 and sys.argv[1] == "--author-content":
        run_author_content(sys.argv[2], flag_value("--pwd"), flag_value("--session") or flag_value("--session-id"),
                           voice_guide=flag_value("--voice-guide"))
        return
    if len(sys.argv) >= 3 and sys.argv[1] == "--debate":
        run_debate(sys.argv[2], int(flag_value("--rounds") or "1"))
        return
    usage(error="first argument must be a behavior switch")
