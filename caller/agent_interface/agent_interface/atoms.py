from __future__ import annotations

from . import progress, review_budget
from .provider_progress import claude_error, claude_result

import os
import re
import subprocess
from urllib.parse import urlparse

from .claude_acl import env as claude_env
from .claude_acl import settings, tools_arg
from .model_catalog import CATALOG

STRUCTURED_POLICY = (
    "Review the supplied immutable PR packet and return the required JSON verdict. "
    "Do not call tools or run commands. Caller will submit the verdict through github-interface. "
    "Use request_changes with all blocking inline findings, reviewed_clean for a clean initial "
    "review, or approve for a follow-up when all requested changes are addressed and there "
    "are no new blocking issues. The action enum limits the verdicts allowed for this run. "
    "When the rules below say to call a command, express that decision in the JSON instead."
)

DEFAULT_P = 2
MAX_GOVERNED_PROMPT_BYTES = 1_500_000
SHA_RE = re.compile(r"[0-9a-f]{40}")
USERNAME_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?")
SOURCE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}")
CORRELATION_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")


class AgentPreflightError(RuntimeError):
    def __init__(self, message: str, code: str | None = None):
        super().__init__(message)
        self.code = code


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


def repo_name(pr: str, pwd: str | None = None) -> str:
    path = urlparse(str(pr)).path.strip("/").split("/")
    if len(path) >= 4 and path[2] == "pull":
        return f"{path[0]}/{path[1]}"
    if pwd:
        remote = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            cwd=pwd,
            text=True,
            capture_output=True,
        )
        if remote.returncode == 0:
            raw = remote.stdout.strip().removesuffix(".git")
            remote_path = (
                raw.rsplit(":", 1)[-1]
                if "@" in raw and ":" in raw
                else urlparse(raw).path.strip("/")
            )
            parts = remote_path.split("/")
            if len(parts) >= 2 and parts[-2] and parts[-1]:
                return f"{parts[-2]}/{parts[-1]}"
    raise ValueError("repository cannot be determined from PR URL or working directory")


def actor(value: str) -> str:
    actor_name = str(value).strip()
    if not USERNAME_RE.fullmatch(actor_name):
        raise ValueError("actor must be a GitHub username")
    return actor_name


def expected_head(value: str) -> str:
    head = str(value).strip().lower()
    if not SHA_RE.fullmatch(head):
        raise ValueError("expected-head must be a 40-character commit SHA")
    return head


def source(value: str) -> str:
    source_name = str(value).strip()
    if not SOURCE_RE.fullmatch(source_name):
        raise ValueError("source must be a stable 1-128 character identifier")
    return source_name


def correlation_id(value: str) -> str:
    correlation = str(value).strip()
    if not CORRELATION_RE.fullmatch(correlation):
        raise ValueError("correlation-id must be a stable 1-128 character identifier")
    return correlation


def packet(
    pwd: str,
    pr: str,
    actor_name: str,
    head: str,
    p: str | None = None,
) -> str:
    cache = review_budget.packet_cache()
    key = (pwd, pr, actor_name, head, p)
    if cache is not None and key in cache:
        return cache[key]
    limit = review_budget.timeout(600)
    progress.stage("preparing_packet", "Preparing PR packet", timeout=limit)
    args = [
        os.getenv("GITHUB_INTERFACE_CLI", "github-interface"),
        "--pr-review",
        pr_ref(pr),
        "--expected-head",
        expected_head(head),
        "--token-user",
        actor(actor_name),
    ]
    if p:
        args.extend(["--p", _priority(p)])
    try:
        done = subprocess.run(args, cwd=pwd, text=True, capture_output=True, timeout=limit)
    except (OSError, subprocess.TimeoutExpired) as error:
        review_budget.timeout(1)
        raise AgentPreflightError(str(error)) from error
    if done.returncode:
        error = (done.stderr or done.stdout).strip() or f"github-interface exited {done.returncode}"
        code = "review_packet_too_large" if error.startswith("error: review_packet_too_large:") else None
        raise AgentPreflightError(error, code)
    if cache is not None:
        cache[key] = done.stdout
    return done.stdout


def fixed_mutation_args(actor_name: str, head: str) -> str:
    return (
        f"--expected-head {expected_head(head)} "
        f"--token-user {actor(actor_name)}"
    )


def prompt(
    policy: str,
    severity: tuple[str, ...],
    rules: tuple[str, ...],
    body: str,
    tools: list[str],
    note: str = "",
    p: str | None = None,
) -> str:
    level = int(_priority(p or f"p{DEFAULT_P}").removeprefix("p"))
    levels = "/".join(f"p{number}" for number in range(level + 1))
    legend = "\n".join(f"- {line}" for line in severity[: level + 1])
    ruleblock = "\n".join(f"- {line.format(levels=levels)}" for line in rules)
    memories = f"Memories from the past:\n{note}\n\n" if note.strip() else ""
    return (
        f"{memories}{policy}\n\nSeverity:\n{legend}\n\nRules:\n{ruleblock}"
        f"\n\nPR packet:\n{body}\n\nAllowed:\n" + "\n".join(tools)
    )


def run_agent(
    pwd: str,
    system: str,
    text: str,
    tools: list[str],
    behavior: str,
    timeout_s: int = 3600,
    *,
    model: str | None = None,
    pr: str = "",
    actor_name: str = "",
    head: str = "",
    repository=None,
) -> str:
    prompt_bytes = len(text.encode("utf-8"))
    if prompt_bytes > MAX_GOVERNED_PROMPT_BYTES:
        raise AgentPreflightError(
            "PR packet is too large for a reliable atomic review: "
            f"{prompt_bytes} bytes exceeds {MAX_GOVERNED_PROMPT_BYTES} after data exclusions; "
            "reduce the remaining review input",
            "review_packet_too_large",
        )
    spec = CATALOG.review_model(behavior, model)
    if spec.provider != "claude":
        from .structured_review import run
        return run(pwd, system, text, spec, behavior, pr, actor_name, head, timeout_s, repository=repository)
    from .review_watch import ReviewWatch
    with ReviewWatch(pwd, pr, actor_name, head) as watch:
        done = watch.run(
            [
                os.getenv("CLAUDE_CLI", "claude"),
                "--print",
                "--output-format", "stream-json", "--verbose", "--include-partial-messages",
                "--thinking-display", "summarized",
                "--model",
                spec.selector,
                "--effort",
                spec.effort,
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
                settings(tools, review_gate=watch.gate_path, output_tokens=review_budget.OUTPUT_TOKENS,
                         review_receipt=watch.receipt_path, review_root=str(repository.root) if repository else None),
                "--system-prompt",
                system,
            ],
            input=text,
            cwd=str(repository.root) if repository else pwd,
            timeout=review_budget.timeout(timeout_s, reserve=review_budget.FINAL_CHECK_SECONDS),
            env={**claude_env(tools), **({"GITHUB_INTERFACE_REVIEW_ROOT": str(repository.root)} if repository else {})},
            provider="claude",
        )
    result = claude_result(done.stdout)
    if done.returncode:
        error = (result or done.stderr or claude_error(done.stdout)).strip() or f"agent exited {done.returncode}"
        if "safeguards flagged this message" in error:
            raise AgentPreflightError(error, "review_provider_blocked")
        if "Prompt is too long" in error:
            raise AgentPreflightError(error, "review_packet_too_large")
        if "output token maximum" in error or "context window limit" in error:
            raise review_budget.ReviewLimitError(error)
        raise RuntimeError(error)
    return result


def _priority(value: str) -> str:
    text = str(value).strip().lower()
    if not re.fullmatch(r"p[0-9]+", text):
        raise ValueError("p must look like p2")
    return text
