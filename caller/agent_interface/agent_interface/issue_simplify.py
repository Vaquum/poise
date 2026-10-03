from __future__ import annotations

import os
import shlex
import subprocess
from pathlib import Path
from urllib.parse import urlparse

from .claude_acl import env as claude_env
from .claude_acl import settings, tools_arg
from .model_catalog import CATALOG

SYSTEM = "Analyze an issue and post one simplifying issue comment. Use only permitted github-interface commands."
POLICY = (
    "Read the issue, then post one concise comment answering: what this issue gets wrong; "
    "what is unclear and must be answered; how to radically simplify while keeping the same value."
)


def pr_number(issue: str) -> str:
    raw = str(issue).strip().rstrip("/")
    if "/issues/" in raw:
        raw = raw.rsplit("/issues/", 1)[1].split("/", 1)[0]
    raw = raw.lstrip("#")
    if not raw.isdigit() or int(raw) < 1:
        raise ValueError("issue must be a number, #number, or GitHub issue URL")
    return raw


def issue_ref(issue: str) -> str:
    return f"#{pr_number(issue)}"


def repo_name(issue: str, pwd: str | None = None) -> str | None:
    path = urlparse(str(issue)).path.strip("/").split("/")
    if len(path) >= 4 and path[2] == "issues":
        return f"{path[0]}/{path[1]}"
    if pwd:
        remote = subprocess.run(["git", "remote", "get-url", "origin"], cwd=pwd, text=True, capture_output=True)
        if remote.returncode == 0:
            raw = remote.stdout.strip().removesuffix(".git")
            parts = (raw.rsplit(":", 1)[-1] if "@" in raw and ":" in raw else urlparse(raw).path.strip("/")).split("/")
            if len(parts) >= 2:
                return f"{parts[-2]}/{parts[-1]}"
    return Path(pwd).name if pwd else None


def command(issue: str) -> str:
    return f"github-interface --read-issue {shlex.quote(issue_ref(issue))}"


def allowed(issue: str) -> list[str]:
    n = shlex.quote(issue_ref(issue))
    return [
        f"Bash(github-interface --read-issue {n})",
        f"Bash(github-interface --comment-issue {n} --body *)",
    ]


def prompt(cmd: str, tools: list[str], note: str = "") -> str:
    return f"{POLICY}\n\nStart with:\n{cmd}\n\nAllowed:\n" + "\n".join(tools) + f"\n\n{note}"


def run(pwd: str, pr: str, note: str = "", timeout_s: int = 3600, p: str | None = None) -> str:
    cmd = command(pr)
    tools = allowed(pr)
    model = CATALOG.behavior("issue_simplify")
    done = subprocess.run(
        [
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
        ],
        text=True,
        capture_output=True,
        cwd=pwd,
        timeout=timeout_s,
        env=claude_env(tools),
    )
    if done.returncode:
        raise RuntimeError((done.stderr or done.stdout).strip() or f"agent exited {done.returncode}")
    return done.stdout.strip()
