from __future__ import annotations

import os
import shlex
import subprocess
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

from . import checkout_lock
from .claude_acl import env as claude_env
from .claude_acl import settings, tools_arg
from .model_catalog import CATALOG

SYSTEM = "Fix failing PR CI by editing tests only. Use only permitted github-interface commands."
POLICY = (
    "List failing CI, read the relevant log, checkout PR head, inspect tests through github-interface, "
    "write only tests through github-interface, review git diff limited to tests, then commit-work. "
    "Do not use native file tools. Do not edit package code."
)


def pr_number(pr: str) -> str:
    raw = str(pr).strip().rstrip("/")
    if "/pull/" in raw:
        raw = raw.rsplit("/pull/", 1)[1].split("/", 1)[0]
    raw = raw.lstrip("#")
    if not raw.isdigit() or int(raw) < 1:
        raise ValueError("pr must be a number, #number, or GitHub PR URL")
    return raw


def pr_ref(pr: str) -> str:
    return f"#{pr_number(pr)}"


def repo_name(pr: str, pwd: str | None = None) -> str | None:
    path = urlparse(str(pr)).path.strip("/").split("/")
    if len(path) >= 4 and path[2] == "pull":
        return f"{path[0]}/{path[1]}"
    if pwd:
        remote = subprocess.run(["git", "remote", "get-url", "origin"], cwd=pwd, text=True, capture_output=True)
        if remote.returncode == 0:
            raw = remote.stdout.strip().removesuffix(".git")
            parts = (raw.rsplit(":", 1)[-1] if "@" in raw and ":" in raw else urlparse(raw).path.strip("/")).split("/")
            if len(parts) >= 2:
                return f"{parts[-2]}/{parts[-1]}"
    return Path(pwd).name if pwd else None


def command(pr: str) -> str:
    return f"github-interface --list-failing-ci {shlex.quote(pr_ref(pr))}"


def allowed(pr: str) -> list[str]:
    n = shlex.quote(pr_ref(pr))
    return [
        f"Bash(github-interface --list-failing-ci {n})",
        "Bash(github-interface --read-failing-ci-log *)",
        f"Bash(github-interface --checkout-pr-head {n})",
        "Bash(github-interface --list-test-files)",
        "Bash(github-interface --read-file *)",
        "Bash(github-interface --write-file * --content *)",
        "Bash(git diff -- tests)",
        f"Bash(github-interface --commit-work {n} --message *)",
    ]


def prompt(cmd: str, tools: list[str], note: str = "") -> str:
    return f"{POLICY}\n\nStart with:\n{cmd}\n\nAllowed:\n" + "\n".join(tools) + f"\n\n{note}"


def run(
    pwd: str,
    pr: str,
    note: str = "",
    timeout_s: int = 3600,
    p: str | None = None,
    call_id: str | None = None,
    lock_wait_s: float = checkout_lock.ACQUIRE_WAIT_SECONDS,
) -> str:
    cmd = command(pr)
    tools = allowed(pr)
    model = CATALOG.behavior("fix_failing_ci")
    args = [
        os.getenv("CLAUDE_CLI", "claude"),
        "--print",
        "--model",
        model.selector,
        "--effort",
        model.effort,
        "--permission-mode",
        "dontAsk",
        "--setting-sources",
        "",
        "--tools",
        tools_arg(tools),
        "--no-session-persistence",
        "--allowedTools",
        *tools,
        "--settings",
        settings(tools),
        "--system-prompt",
        SYSTEM,
        prompt(cmd, tools, note),
    ]
    # The agent checks out and commits in this checkout, so it shares Poise's
    # per-checkout lease: taken before anything can write, held through the
    # whole worker group, released after it has settled.
    owner = call_id or uuid4().hex
    lease = checkout_lock.Lease(pwd, owner, f"fix-failing-ci {repo_name(pr, pwd)}#{pr_number(pr)} (call {owner[:8]})")
    with checkout_lock.interruptible():
        lease.acquire(lock_wait_s)
        try:
            done = checkout_lock.run_gated(lease, args, cwd=pwd, env=claude_env(tools), timeout=timeout_s)
        finally:
            if lease.held:
                lease.release()
    if done.returncode:
        raise RuntimeError((done.stderr or done.stdout).strip() or f"agent exited {done.returncode}")
    return done.stdout.strip()
