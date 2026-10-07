from __future__ import annotations

import json
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
from .review_watch import ReviewSuperseded
from .review_watch import _interrupted as review_watch_interrupted

__version__ = "0.3.0"

DATA_DIR = Path(os.getenv("AGENT_INTERFACE_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
DB = DATA_DIR / "calls.sqlite3"
RESPONSES = DATA_DIR / "responses"


def db():
    conn = sqlite3.connect(DB, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    RESPONSES.mkdir(parents=True, exist_ok=True)
    with db() as conn:
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
        status = conn.execute("select status from calls where id=?", (id_,)).fetchone()["status"]
    return {"id": id_, "stopped": changed == 1, "status": status, "error_code": "stopped" if changed == 1 else None}


def finish(
    id_: str,
    status: str,
    response: str = "",
    error: str = "",
    outcome: str | None = None,
    head_sha: str | None = None,
    action: str | None = None,
    error_code: str | None = None,
) -> float:
    path = str((RESPONSES / f"{id_}.txt").resolve()) if response else None
    if response:
        Path(path).write_text(response)
    ended_at = time()
    with db() as conn:
        conn.execute(
            "update calls set status=?, ended_at=?, response_path=?, error=?, outcome=?, head_sha=?, action=?, error_code=?, progress=coalesce(?, progress) where id=?",
            (status, ended_at, path, error, outcome, head_sha, action, error_code, progress.terminal(status), id_),
        )
    return ended_at


def logs():
    with db() as conn:
        rows = conn.execute(
            """select id, model, prompt, started_at, ended_at, status,
                      response_path, error, pr_id, repo, actor, behavior,
                      session_id, outcome, head_sha, expected_head, source,
                      correlation_id, action, error_code, progress, review_policy, recovery_model,
                      review_id, runner, receipts
               from calls order by started_at"""
        ).fetchall()
    return [
        {
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
            "progress": progress.decode(r["progress"]),
            "review_policy": r["review_policy"],
            "recovery_model": r["recovery_model"],
            "review_id": int(r["review_id"]) if r["review_id"] and str(r["review_id"]).isdigit() else None,
            "response": Path(r["response_path"]).stem[:8] if r["response_path"] else None,
            "error": r["error"],
            "runner": r["runner"],
            "receipts": _receipts(r["receipts"]),
        }
        for r in rows
    ]


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


def run_issue_review(
    issue: str,
    actor: str,
    source: str,
    correlation_id: str,
    model: str,
    recovery_model: str | None = None,
    note: str = "",
    timeout_s: int = issue_review.TIMEOUT_SECONDS,
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
        finish(id_, "failed", response=response, error=str(error), error_code=code,
               outcome="preflight_failed" if preflight else None, action="not_started" if preflight else None)
        print(json.dumps({**stamp_, "model": name, "error": str(error), "error_code": code}, indent=2))
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
                issue_review.mark_reviewed(data, actor, _issue_review_targets, _running_issue_reviews(id_))
            except review_budget.ReviewLimitError as e:
                fail(e, e.code)
            except Exception as e:
                fail(e, getattr(e, "code", None), preflight=True)
            try:
                name, (posts, ignored) = _issue_review_with_recovery(spec, recovery, repo, number, data, actor, note, run_dir, id_)
            except review_budget.ReviewLimitError as e:
                fail(e, e.code)
            except atoms.AgentPreflightError as e:
                fail(e, e.code, preflight=True)
            except issue_review.InvalidReview as e:
                fail(e, e.code)
            except Exception as e:
                fail(e)
            try:
                receipts = issue_review.post(posts, actor, id_, name, record)
            except Exception as e:
                fail(e, "posting_failed")
            response = issue_review.summary(posts, receipts, ignored)
            ended_at = finish(id_, "completed", response=response, outcome="commented", action="commented")
            print(json.dumps({**stamp_, "model": name, "receipts": receipts, "completed_at": utc_stamp(ended_at),
                              "action": "commented", "outcome": "commented"}, indent=2))
    finally:
        signal.signal(signal.SIGTERM, previous_sigterm)
        shutil.rmtree(run_dir, ignore_errors=True)


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
    )


def run_fix_failing_ci(pr: str, pwd: str | None = None, note: str = "", timeout_s: int = 3600):
    return run_legacy_behavior(fix_failing_ci, "fix_failing_ci", pr, pwd, note, timeout_s)


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
):
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
    with review_budget.ReviewBudget(timeout_s), progress.Progress(DB, id_):
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
        try:
            try:
                response, recovered_result = _run_review_with_recovery(mod, behavior, review_pr, pwd, actor, expected_head, note, timeout_s, p, spec, recovery, before, id_)
            except ReviewSuperseded as cancelled:
                response = str(cancelled)
                result = {"action": None, "outcome": "superseded", "head_sha": cancelled.head_sha}
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
            ended_at = finish(
                id_,
                status,
                response=response,
                outcome=result["outcome"],
                head_sha=result["head_sha"],
                action=result["action"],
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
                **result,
            }, indent=2))
        except review_budget.ReviewLimitError as e:
            finish(id_, "failed", response=response, error=str(e), error_code=e.code)
            print(json.dumps({"id": id_, "error": str(e), "error_code": e.code}))
            raise SystemExit(1)
        except atoms.AgentPreflightError as e:
            finish(
                id_,
                "failed",
                response=response,
                error=str(e),
                outcome="preflight_failed",
                action="not_started",
                error_code=e.code,
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


def _run_review_with_recovery(mod, behavior, pr, pwd, actor, head, note, seconds, p, spec, recovery, before, call_id):
    try:
        return mod.run(pwd, pr, actor, head, note, seconds, p, model=spec.identity), None
    except (review_budget.ReviewLimitError, subprocess.TimeoutExpired) as error:
        failure = error if isinstance(error, review_budget.ReviewLimitError) else review_budget.ReviewLimitError(
            "Review reached its total time limit; needs attention", "review_budget_exhausted")
        progress.stage("verifying", "Checking GitHub after interrupted review")
        try:
            facts = review_facts(mod, pr, pwd, actor, head, 0)
            receipt = review_receipt.get()
            # A completed or superseded action wins over a later CLI failure.
            if facts["head_sha"] != head or facts["state"] != "OPEN" or facts["draft"]:
                return str(failure), behavior_outcome(mod, behavior, pr, pwd, actor, head, before, facts, receipt=receipt, call_id=call_id)
            own = own_reviews(before, facts, receipt, call_id)
            if own is None:
                counts = ("reviewer_change_requests_since", "reviewer_approvals_since", "reviewer_comments_since")
                if any(_count(facts, key) != _count(before, key) for key in counts):
                    return str(failure), behavior_outcome(mod, behavior, pr, pwd, actor, head, before, facts)
            elif receipt is not None or own:
                return str(failure), behavior_outcome(mod, behavior, pr, pwd, actor, head, before, facts, receipt=receipt, call_id=call_id)
            # Require positive no-action proof, including pending reviews.
            if _count(facts, "reviewer_pending_reviews") != 0:
                raise RuntimeError("a pending GitHub review requires reconciliation")
            if own is None and (_count(facts, "reviewer_reviews_since") != _count(before, "reviewer_reviews_since")
                    or facts.get("reviewer_latest_any_review_id") != before.get("reviewer_latest_any_review_id")):
                raise RuntimeError("review activity changed without matching counters")
        except Exception as verification:
            raise review_budget.ReviewLimitError(
                f"{failure}; could not prove a safe recovery: {verification}", failure.code) from verification
        # Only a Claude output limit is recoverable, and only by a different model.
        if failure.code != "model_output_limit" or spec.provider != "claude" or recovery.identity == spec.identity:
            raise failure
        review_budget.timeout(seconds, reserve=review_budget.FINAL_CHECK_SECONDS)
        # Durable before launch; a process restart cannot silently repeat it.
        with db() as conn:
            changed = conn.execute("update calls set recovery_model=? where id=? and recovery_model is null and ended_at is null",
                                   (recovery.identity, call_id)).rowcount
        if changed != 1:
            raise review_budget.ReviewLimitError("Recovery was already attempted; needs attention", "review_recovery_failed")
        progress.stage("recovering", f"Output limit reached; recovering once with {recovery.identity}")
        try:
            response = mod.run(pwd, pr, actor, head, note, seconds, p, model=recovery.identity)
            return response, None
        except ReviewSuperseded:
            raise
        except Exception as recovery_error:
            # A submission may have succeeded before its response was lost.
            # Adopt only a terminal outcome verified from GitHub, never text.
            try:
                result = behavior_outcome(mod, behavior, pr, pwd, actor, head, before)
            except Exception:
                pass
            else:
                return str(recovery_error), result
            raise review_budget.ReviewLimitError(
                f"{recovery.identity} recovery failed; needs attention: {recovery_error}", "review_recovery_failed") from recovery_error


# A sibling that submitted a moment ago may not have recorded its review id
# yet; an unclaimed review is looked at again after this long before it is
# taken for this run's own.
SIBLING_GRACE_SECONDS = 2.0
RECEIPT_STATES = {"requested_changes": "CHANGES_REQUESTED", "reviewed_clean": "COMMENTED", "approved_pr": "APPROVED"}


def _review_items(facts: dict) -> list[dict] | None:
    items = facts.get("reviewer_reviews_since_items")
    if not isinstance(items, list):
        return None
    for item in items:
        if not isinstance(item, dict) or isinstance(item.get("id"), bool) or not isinstance(item.get("id"), int):
            raise RuntimeError("github-interface review outcome returned invalid reviewer_reviews_since_items")
    return items


def own_reviews(before: dict, facts: dict, receipt: dict | None, call_id: str | None) -> list[dict] | None:
    """The reviews this run posted: the receipted one, or without a receipt the
    new ones no sibling run claims. None when github-interface predates
    per-review ids; the activity counters decide then."""
    after = _review_items(facts)
    earlier = _review_items(before)
    if after is None or earlier is None:
        return None
    seen = {item["id"] for item in earlier}
    new = [item for item in after if item["id"] not in seen]
    if receipt is not None:
        return [item for item in new if item["id"] == receipt["review_id"]]
    if not new or not call_id:
        return new
    repo, number = str(facts.get("repository") or ""), str(facts.get("pull_number") or "")
    own = [item for item in new if item["id"] not in review_receipt.sibling_ids(DB, call_id, repo, number)]
    if own:
        sleep(SIBLING_GRACE_SECONDS)
        own = [item for item in new if item["id"] not in review_receipt.sibling_ids(DB, call_id, repo, number)]
    return own


def _own_outcome(behavior: str, own: list[dict], expected_head: str, receipt: dict | None) -> dict[str, str | None]:
    if len(own) != 1:
        kind = "review behavior must produce exactly one atomic clean or change-request review" if behavior == "pr_review" \
            else "approval behavior must produce exactly one atomic approval or change-request review"
        raise review_budget.ReviewLimitError(kind, "review_contract_violation")
    review = own[0]
    state = review.get("state")
    if receipt is not None and RECEIPT_STATES.get(receipt["action"]) != state:
        raise RuntimeError("submitted review does not match its receipt")
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
) -> dict[str, str | None]:
    if facts is None:
        facts = review_facts(mod, pr, pwd, actor, expected_head, 0)
    actual_head = str(facts["head_sha"]).lower()
    if (
        facts["state"] != "OPEN"
        or facts["draft"] is True
        or actual_head != expected_head
    ):
        return {
            "action": None,
            "outcome": "superseded",
            "head_sha": actual_head,
        }
    if behavior not in {"pr_review", "pr_approve"}:
        raise RuntimeError(f"unsupported governed behavior: {behavior}")
    own = own_reviews(before, facts, receipt, call_id)
    if own is not None:
        return _own_outcome(behavior, own, expected_head, receipt)
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
    if change_requests < 0 or approvals < 0 or comments < 0:
        raise RuntimeError("review activity counters moved backwards")
    previous_review_id = str(before.get("reviewer_latest_review_id") or "")
    previous_any_review_id = str(before.get("reviewer_latest_any_review_id") or "")

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
            return {
                "action": "reviewed_clean",
                "outcome": "clean",
                "head_sha": expected_head,
            }
        _validate_latest_review(
            facts,
            "CHANGES_REQUESTED",
            expected_head,
            previous_review_id,
        )
        return {
            "action": "requested_changes",
            "outcome": "changes_requested",
            "head_sha": expected_head,
        }

    if behavior != "pr_approve":
        raise RuntimeError(f"unsupported governed behavior: {behavior}")
    if (change_requests, approvals) not in {(1, 0), (0, 1)}:
        raise RuntimeError(
            "approval behavior must produce exactly one atomic approval or change-request review"
        )
    if approvals:
        _validate_latest_review(facts, "APPROVED", expected_head, previous_review_id)
        return {
            "action": "approved",
            "outcome": "approved",
            "head_sha": expected_head,
        }
    _validate_latest_review(
        facts,
        "CHANGES_REQUESTED",
        expected_head,
        previous_review_id,
    )
    return {
        "action": "requested_changes",
        "outcome": "changes_requested",
        "head_sha": expected_head,
    }


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
  --refresh-models
  --logs
  --stop CALL_ID
  --read-response HASH
  --read-reasoning HASH
  --chat MESSAGE --model MODEL [--session ID] [--pwd DIR]
  --pr-review PR --actor USER --expected-head SHA --source SOURCE --correlation-id ID [--pwd DIR] [--p P] [--note TEXT] [--model MODEL] [--recovery-model MODEL]
  --pr-approve PR --actor USER --expected-head SHA --source SOURCE --correlation-id ID [--pwd DIR] [--p P] [--note TEXT] [--model MODEL] [--recovery-model MODEL]
  --fix-failing-ci PR [--pwd DIR]
  --issue-simplify ISSUE [--pwd DIR]
  --issue-review OWNER/REPO#N --model MODEL --actor USER --source SOURCE --correlation-id ID [--recovery-model MODEL] [--note TEXT]
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


def main():
    if len(sys.argv) == 1:
        usage(error="first argument must be a behavior switch")
    if sys.argv[1:] in (["--help"], ["-h"]) or sys.argv[-1] in ("--help", "-h"):
        usage(0)
    if sys.argv[1:] == ["--models"]:
        print(json.dumps({**CATALOG.export(), "policy": review_budget.REVIEW_POLICY}, indent=2))
        return
    if sys.argv[1:] == ["--refresh-models"]:
        from . import catalog_refresh
        print(json.dumps(catalog_refresh.refresh(), indent=2))
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
    if sys.argv[1:] == ["--logs"]:
        print(json.dumps(logs(), indent=2))
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
        )
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
