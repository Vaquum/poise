from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import tempfile
import uuid
from pathlib import Path
from time import time

from .claude_acl import env as claude_env
from .claude_acl import settings, tools_arg
from .model_catalog import CATALOG

DATA_DIR = Path(os.getenv("AGENT_INTERFACE_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
DB = DATA_DIR / "calls.sqlite3"


def model_name(model: str) -> str:
    return CATALOG.resolve(model).identity


def safe(value: str) -> str:
    return "".join(c if c.isalnum() or c in "._-" else "_" for c in value) or "session"


def workdir(model: str, session_id: str) -> str:
    path = Path(os.getenv("TMPDIR", "/tmp")) / "agent-interface-chat" / safe(model_name(model)) / safe(session_id)
    path.mkdir(parents=True, exist_ok=True)
    return str(path)


def db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute(
        "create table if not exists chat_sessions (session_id text, model text, provider_session text, created_at real, updated_at real, primary key (session_id, model))"
    )
    return conn


def get_session(session_id: str, model: str) -> str | None:
    with db() as conn:
        row = conn.execute("select provider_session from chat_sessions where session_id=? and model=?", (session_id, model)).fetchone()
    return row["provider_session"] if row else None


def set_session(session_id: str, model: str, provider_session: str):
    now = time()
    with db() as conn:
        conn.execute(
            "insert into chat_sessions values (?, ?, ?, ?, ?) on conflict(session_id, model) do update set provider_session=excluded.provider_session, updated_at=excluded.updated_at",
            (session_id, model, provider_session, now, now),
        )


def forget_session(session_id: str, model: str):
    with db() as conn:
        conn.execute("delete from chat_sessions where session_id=? and model=?", (session_id, model))


# Claude Code deletes transcripts it has not touched for cleanupPeriodDays and
# Grok Build can lose a session server-side, so a stored provider session can
# stop existing. When resuming reports that, forget the mapping and start over
# under the same stable id instead of failing every turn from then on.
STALE_SESSION = {
    "claude": "No conversation found with session ID",
    "grok": "Failed to restore session from remote",
}


def run_session(call, args: list[str], session_id: str, model: str, stale: str) -> subprocess.CompletedProcess:
    done = call(args)
    if done.returncode and "--resume" in args and stale in done.stderr + done.stdout:
        forget_session(session_id, model)
        args[args.index("--resume")] = "--session-id"
        done = call(args)
    return done


def stable_uuid(session_id: str, model: str) -> str:
    try:
        return str(uuid.UUID(session_id))
    except ValueError:
        return str(uuid.uuid5(uuid.NAMESPACE_URL, f"agent-interface:{model}:{session_id}"))


def find_id(obj):
    if isinstance(obj, dict):
        kind = str(obj.get("type", obj.get("event", ""))).lower()
        if any(x in kind for x in ("session", "conversation", "thread")):
            for key in ("id", "uuid"):
                if isinstance(obj.get(key), str) and obj[key]:
                    return obj[key]
        for key in ("session_id", "sessionId", "conversation_id", "conversationId", "thread_id", "threadId"):
            if key in obj and isinstance(obj[key], str) and obj[key]:
                return obj[key]
        for value in obj.values():
            found = find_id(value)
            if found:
                return found
    if isinstance(obj, list):
        for value in obj:
            found = find_id(value)
            if found:
                return found
    return None


def codex_session(stdout: str) -> str | None:
    for line in stdout.splitlines():
        try:
            found = find_id(json.loads(line))
        except json.JSONDecodeError:
            continue
        if found:
            return found
    return None


def antigravity_reply(stdout: str) -> dict:
    try:
        reply = json.loads(stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"agy returned no JSON reply: {stdout.strip()[:200]}") from error
    if reply.get("status") != "SUCCESS" or not isinstance(reply.get("response"), str) or not reply.get("conversation_id"):
        raise RuntimeError(reply.get("error") or f"agy reply status {reply.get('status')!r}")
    return reply


def claude_access(args: list[str], no_tools: bool, allowed_tools: list[str] | None):
    if allowed_tools:
        args += [
            "--permission-mode",
            "dontAsk",
            "--setting-sources",
            "",
            "--tools",
            tools_arg(allowed_tools),
            "--allowedTools",
            *allowed_tools,
            "--settings",
            settings(allowed_tools),
        ]
    elif no_tools:
        args += ["--permission-mode", "dontAsk", "--setting-sources", "", "--tools", ""]
    else:
        args += ["--permission-mode", "bypassPermissions"]


def run(
    pwd: str | None,
    model: str,
    session_id: str | None,
    prompt: str,
    timeout_s: int = 3600,
    no_tools: bool = False,
    allowed_tools: list[str] | None = None,
    conda_env: str | None = None,
    pip_upgrade: str | None = None,
) -> str:
    spec = CATALOG.resolve(model)
    name = spec.identity
    if allowed_tools and not spec.supports_allowed_tools:
        raise RuntimeError(
            f"allowed tool restrictions are not enforceable for model {name}"
        )
    tmp = tempfile.TemporaryDirectory(prefix="agent-interface-chat-") if not pwd and not session_id else None
    cwd = os.path.abspath(pwd or (workdir(name, session_id) if session_id else tmp.name))
    provider = get_session(session_id, name) if session_id else None
    last = tempfile.NamedTemporaryFile(delete=False)
    last.close()
    try:
        if spec.provider == "claude" and not session_id:
            args = [
                os.getenv("CLAUDE_CLI", "claude"),
                "--print",
                "--model",
                spec.selector,
                "--effort",
                spec.effort,
                "--no-session-persistence",
            ]
            claude_access(args, no_tools, allowed_tools)
            args.append(prompt)
        elif spec.provider == "claude":
            provider = provider or stable_uuid(session_id, name)
            args = [
                os.getenv("CLAUDE_CLI", "claude"),
                "--print",
                "--model",
                spec.selector,
                "--effort",
                spec.effort,
            ]
            claude_access(args, no_tools, allowed_tools)
            args += ["--resume" if get_session(session_id, name) else "--session-id", provider, prompt]
        elif spec.provider == "codex":
            base = [
                os.getenv("CODEX_CLI", "codex"),
                "exec",
                "--model",
                spec.selector,
                "-c",
                f'model_reasoning_effort="{spec.effort}"',
                "--skip-git-repo-check",
                "--json",
                "--output-last-message",
                last.name,
            ]
            base += ["--sandbox", "read-only"] if no_tools else ["--dangerously-bypass-approvals-and-sandbox"]
            if not session_id:
                base.append("--ephemeral")
            args = base + (["resume", provider, prompt] if provider else ["--cd", cwd, prompt])
        elif spec.provider == "grok":
            args = [
                os.getenv("GROK_CLI", "grok"),
                "-p",
                prompt,
                "-m",
                spec.selector,
                "--effort",
                spec.effort,
                "--output-format",
                "plain",
                "--cwd",
                cwd,
            ]
            args += ["--permission-mode", "dontAsk", "--tools", ""] if no_tools else ["--permission-mode", "bypassPermissions"]
            if session_id:
                provider = provider or stable_uuid(session_id, name)
                args += ["--resume" if get_session(session_id, name) else "--session-id", provider]
        elif spec.provider == "antigravity":
            # agy names the conversation itself and silently starts a new one
            # when the stored id is gone; the id in its reply is recorded below.
            args = [
                os.getenv("ANTIGRAVITY_CLI", "agy"),
                "--print",
                prompt,
                "--model",
                spec.selector,
                "--effort",
                spec.effort,
                "--output-format",
                "json",
            ]
            args += ["--mode", "plan"] if no_tools else ["--dangerously-skip-permissions"]
            if provider:
                args += ["--conversation", provider]
        elif spec.provider == "muse":
            # The same --session-id both starts and continues a session.
            args = [
                os.getenv("MUSE_CLI", "muse"),
                "exec",
                "--model",
                spec.selector,
                "--reasoning-effort",
                spec.effort,
            ]
            args += ["--disable-shell", "--disable-write"] if no_tools else ["--yolo"]
            if session_id:
                provider = provider or stable_uuid(session_id, name)
                args += ["--session-id", provider]
            args.append(prompt)
        else:
            raise RuntimeError(f"unknown provider {spec.provider!r} for model {name}")
        def invoke(args: list[str]) -> subprocess.CompletedProcess:
            run_args = args
            if conda_env:
                script = (
                    'source "$(conda info --base)/etc/profile.d/conda.sh" && '
                    'conda activate "$1" && '
                    'if [ -n "$2" ]; then python -m pip install -U "$2" > limen-install.log 2>&1 || { cat limen-install.log >&2; exit 1; }; fi && '
                    'shift 2 && exec "$@"'
                )
                run_args = ["bash", "-lc", script, "agent-interface-env", conda_env, pip_upgrade or "", *args]
            return subprocess.run(
                run_args,
                input="" if spec.provider == "codex" else None,
                text=True,
                capture_output=True,
                cwd=cwd,
                timeout=timeout_s,
                env=claude_env(allowed_tools) if allowed_tools else None,
            )

        stale = STALE_SESSION.get(spec.provider)
        done = run_session(invoke, args, session_id, name, stale) if session_id and stale else invoke(args)
        if done.returncode:
            raise RuntimeError((done.stderr or done.stdout).strip() or f"agent exited {done.returncode}")
        response = (Path(last.name).read_text().strip() or done.stdout.strip()).strip()
        if session_id and spec.provider == "codex" and not provider:
            provider = codex_session(done.stdout)
            if not provider:
                raise RuntimeError("codex session id not found")
        if spec.provider == "antigravity":
            reply = antigravity_reply(done.stdout)
            provider, response = reply["conversation_id"], reply["response"].strip()
        if session_id:
            set_session(session_id, name, provider)
        return response
    finally:
        Path(last.name).unlink(missing_ok=True)
        if tmp:
            tmp.cleanup()
