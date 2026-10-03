from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

STATE_DIR = Path(
    os.getenv(
        "CALLER_PR_STOP_GATE_STATE_DIR",
        Path.home() / ".local" / "state" / "caller" / "pr-stop-gate",
    )
)
COMPLETION_CLAIM = re.compile(
    r"\b(?:"
    r"(?:pr|pull request|merge button|everything|all checks|ci) (?:is|are) (?:now |fully )?green"
    r"|green and ready (?:to|for) merge"
    r"|ready (?:to|for) merge"
    r"|production[- ]ready"
    r"|all (?:required )?checks (?:are )?(?:green|passing)"
    r")\b",
    re.IGNORECASE,
)
NEGATED_COMPLETION = re.compile(
    r"\b(?:not|isn't|is not|aren't|are not|never) (?:yet )?(?:green|ready|passing)\b",
    re.IGNORECASE,
)
BASH_MUTATION = re.compile(
    r"(?:"
    r"\bgit(?:\s+-C\s+(?:\"[^\"]+\"|'[^']+'|[^\s;&|]+))?\s+"
    r"(?:add|commit|push|merge|rebase|cherry-pick)\b"
    r"|\bgh\s+pr\s+(?:create|edit|merge)\b"
    r"|\b(?:rm|mv|cp|mkdir|touch|tee)\b"
    r"|\bsed\s+-i\b"
    r"|\bperl\s+-pi\b"
    r")",
    re.IGNORECASE,
)
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"}
MATCHER = "Bash|Edit|Write|MultiEdit|NotebookEdit|apply_patch"
SHELL_CWD = re.compile(
    r"(?:^|[;&|]\s*)cd\s+(?P<path>\"[^\"]+\"|'[^']+'|[^\s;&|]+)",
    re.MULTILINE,
)
GIT_CWD = re.compile(
    r"\bgit\s+-C\s+(?P<path>\"[^\"]+\"|'[^']+'|[^\s;&|]+)",
    re.MULTILINE,
)


def run() -> None:
    event: dict[str, Any] = {}
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("hook input must be an object")
        event = payload
        output = handle(event)
    except Exception as error:
        output = (
            None
            if event.get("stop_hook_active") is True
            else _block(f"PR readiness gate degraded: {error}. Do not report green.")
        )
    if output:
        print(json.dumps(output))


def handle(event: dict[str, Any]) -> dict[str, Any] | None:
    name = str(event.get("hook_event_name") or "")
    session_id = str(event.get("session_id") or "").strip()
    cwd = str(event.get("cwd") or os.getcwd())
    if name == "PostToolUse":
        if session_id and _is_mutation(event):
            _mark(session_id, cwd, event)
        return None
    if name != "Stop":
        return None

    active = bool(session_id and _marker(session_id).exists())
    message = str(event.get("last_assistant_message") or "")
    if not active and not _claims_completion(message):
        return None
    reviewer = _reviewer()
    # Pull requests are read as CALLER_GITHUB_READER when set, otherwise as
    # the reviewer, which can read every pull request it approves.
    reader = ["--token-user", os.getenv("CALLER_GITHUB_READER", "").strip() or reviewer]

    currents: list[tuple[dict[str, Any], str]] = []
    errors: list[RuntimeError | OSError] = []
    seen = set()
    for candidate in _tracked_cwds(session_id, cwd):
        try:
            current = _interface(["--current-pr", *reader], candidate)
        except (RuntimeError, OSError) as error:
            if _benign_candidate_failure(error, candidate):
                continue
            errors.append(error)
            continue
        repository = str(current.get("repository") or "")
        if not current.get("found") or not _in_scope(repository):
            continue
        key = (repository.lower(), int(current["pull_number"]))
        if key not in seen:
            seen.add(key)
            currents.append((current, candidate))

    if not currents:
        if active and errors and event.get("stop_hook_active") is not True:
            raise errors[0]
        return None

    blocked = []
    readiness_errors: list[RuntimeError | OSError] = []
    for current, candidate in currents:
        try:
            readiness = _interface(
                [
                    "--pr-readiness",
                    f"#{current['pull_number']}",
                    "--username",
                    reviewer,
                    "--expected-head",
                    str(current["head_sha"]),
                    *reader,
                ],
                candidate,
            )
        except (RuntimeError, OSError) as error:
            readiness_errors.append(error)
            continue
        if readiness.get("green") is True:
            continue
        blockers = ", ".join(str(item) for item in readiness.get("blockers") or [])
        blocked.append(
            f"PR {current['repository']}#{current['pull_number']} is not green on "
            f"head {current['head_sha']}: {blockers or 'readiness unknown'}"
        )

    if not blocked and readiness_errors:
        if event.get("stop_hook_active") is True:
            return None
        raise readiness_errors[0]

    if not blocked:
        if session_id:
            _marker(session_id).unlink(missing_ok=True)
        return None

    reason = (
        "; ".join(blocked) + ". "
        "Continue until Caller reports green. Fix actionable blockers or wait for the existing "
        "automated review/approval flow, then recheck. Do not manually trigger review or approval, "
        "and do not report green."
    )
    return _block(reason)


def install() -> dict[str, Any]:
    sibling = Path(sys.executable).with_name("github-interface")
    interface = str(sibling) if sibling.exists() else shutil.which("github-interface")
    if not interface:
        raise RuntimeError("github-interface executable is not installed")
    scope = os.getenv("CALLER_PR_GATE_SCOPE", "").strip()
    scope_env = f" CALLER_PR_GATE_SCOPE={shlex.quote(scope)}" if scope else ""
    # The hook runs in every agent session on the machine, whose environment
    # does not carry Poise's accounts: they are fixed into the command.
    accounts_env = f" CALLER_PR_REVIEWER={shlex.quote(_reviewer())}"
    reader = os.getenv("CALLER_GITHUB_READER", "").strip()
    if reader:
        accounts_env += f" CALLER_GITHUB_READER={shlex.quote(reader)}"
    command = (
        f"GITHUB_INTERFACE_CLI={shlex.quote(interface)}{scope_env}{accounts_env} "
        f"{shlex.quote(str(Path(sys.executable)))} "
        f"{shlex.quote(str(Path(__file__).resolve()))}"
    )
    paths = [
        Path(os.getenv("CLAUDE_SETTINGS_PATH", Path.home() / ".claude" / "settings.json")),
        Path(os.getenv("CODEX_HOOKS_PATH", Path.home() / ".codex" / "hooks.json")),
    ]
    commands = [
        f"/usr/bin/env CALLER_HOOK_CLIENT=claude {command}",
        f"/usr/bin/env CALLER_HOOK_CLIENT=codex {command}",
    ]
    changed = [_install_file(path, hook_command) for path, hook_command in zip(paths, commands)]
    return {
        "action": "install_pr_stop_gate",
        "commands": {"claude": commands[0], "codex": commands[1]},
        "claude": {"path": str(paths[0]), "changed": changed[0]},
        "codex": {"path": str(paths[1]), "changed": changed[1], "trust_required": True},
    }


def _install_file(path: Path, command: str) -> bool:
    document = json.loads(path.read_text()) if path.exists() else {}
    hooks = document.setdefault("hooks", {})
    changed = False
    for event, matcher in (("PostToolUse", MATCHER), ("Stop", None)):
        groups = hooks.setdefault(event, [])
        existing = _gate_hook(groups)
        if existing:
            group, hook = existing
            if hook.get("command") != command or hook.get("timeout") != 120:
                hook.update({"command": command, "timeout": 120})
                changed = True
            if matcher and group.get("matcher") != matcher:
                group["matcher"] = matcher
                changed = True
            continue
        group: dict[str, Any] = {
            "hooks": [
                {
                    "type": "command",
                    "command": command,
                    "timeout": 120,
                }
            ]
        }
        if matcher:
            group["matcher"] = matcher
        groups.append(group)
        changed = True
    if changed:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(json.dumps(document, indent=2) + "\n")
        temporary.replace(path)
    return changed


def _gate_hook(groups: list[Any]) -> tuple[dict[str, Any], dict[str, Any]] | None:
    for group in groups:
        if not isinstance(group, dict):
            continue
        for hook in group.get("hooks", []):
            if not isinstance(hook, dict):
                continue
            command = str(hook.get("command") or "")
            if "--pr-stop-gate" in command or "pr_stop_gate.py" in command:
                return group, hook
    return None


def _is_mutation(event: dict[str, Any]) -> bool:
    tool = str(event.get("tool_name") or "")
    if tool in EDIT_TOOLS:
        return True
    if tool != "Bash":
        return False
    tool_input = event.get("tool_input") or {}
    command = str(tool_input.get("command") or tool_input.get("cmd") or "")
    return bool(BASH_MUTATION.search(command))


def _claims_completion(message: str) -> bool:
    return not NEGATED_COMPLETION.search(message) and bool(COMPLETION_CLAIM.search(message))


def _in_scope(repository: str) -> bool:
    configured = os.getenv("CALLER_PR_GATE_SCOPE", "").strip()
    if not configured:
        return True
    value = repository.lower()
    for item in configured.split(","):
        pattern = item.strip().lower()
        if pattern.endswith("/*") and value.startswith(pattern[:-1]):
            return True
        if value == pattern:
            return True
    return False


def _interface(args: list[str], cwd: str) -> dict[str, Any]:
    command = [os.getenv("GITHUB_INTERFACE_CLI", "github-interface"), *args]
    result = subprocess.run(
        command,
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if result.returncode:
        raise RuntimeError(
            (result.stderr or result.stdout).strip()
            or f"github-interface exited {result.returncode}"
        )
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("github-interface returned invalid JSON") from error
    if not isinstance(payload, dict):
        raise RuntimeError("github-interface returned a non-object")
    return payload


def _reviewer() -> str:
    """The account whose approval the gate waits for: the agent account."""
    reviewer = os.getenv("CALLER_PR_REVIEWER", "").strip() or os.getenv("GITHUB_INTERFACE_AGENT_USER", "").strip()
    if not reviewer:
        raise RuntimeError("no reviewer: set GITHUB_INTERFACE_AGENT_USER (or CALLER_PR_REVIEWER) to the agent account that approves pull requests")
    return reviewer


def _mark(session_id: str, cwd: str, event: dict[str, Any]) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    marker = _marker(session_id)
    previous: list[str] = []
    if marker.exists():
        try:
            stored = json.loads(marker.read_text())
            previous = [str(item) for item in stored.get("candidate_cwds") or []]
            if stored.get("cwd"):
                previous.append(str(stored["cwd"]))
        except (json.JSONDecodeError, OSError, TypeError):
            previous = []
    candidates = _git_work_tree_cwds([*_mutation_cwds(event, cwd), cwd, *previous])[:16]
    marker.write_text(json.dumps({"candidate_cwds": candidates}) + "\n")


def _tracked_cwds(session_id: str, cwd: str) -> list[str]:
    candidates = [cwd]
    marker = _marker(session_id) if session_id else None
    if marker and marker.exists():
        try:
            stored = json.loads(marker.read_text())
            candidates.extend(str(item) for item in stored.get("candidate_cwds") or [])
            if stored.get("cwd"):
                candidates.append(str(stored["cwd"]))
        except (json.JSONDecodeError, OSError, TypeError):
            pass
    return _git_work_tree_cwds(candidates)


def _mutation_cwds(event: dict[str, Any], cwd: str) -> list[str]:
    tool = str(event.get("tool_name") or "")
    tool_input = event.get("tool_input") or {}
    if tool == "Bash":
        command = str(tool_input.get("command") or tool_input.get("cmd") or "")
        return [
            path
            for match in [*SHELL_CWD.finditer(command), *GIT_CWD.finditer(command)]
            if (path := _normalize_path(match.group("path"), cwd))
        ]
    paths = []
    for key in ("file_path", "path", "notebook_path"):
        raw = str(tool_input.get(key) or "").strip()
        if not raw:
            continue
        path = Path(raw).expanduser()
        if not path.is_absolute():
            path = Path(cwd) / path
        paths.append(str(path.parent.resolve()))
    return paths


def _normalize_path(raw: str, cwd: str) -> str | None:
    try:
        parts = shlex.split(raw)
    except ValueError:
        return None
    if len(parts) != 1:
        return None
    value = parts[0].replace("$HOME", str(Path.home()))
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = Path(cwd) / path
    return str(path.resolve())


def _git_work_tree_cwds(values: list[str]) -> list[str]:
    candidates = []
    for value in _unique(values):
        path = Path(value).expanduser()
        if not path.is_dir():
            continue
        resolved = path.resolve()
        if any((parent / ".git").exists() for parent in (resolved, *resolved.parents)):
            candidates.append(str(resolved))
    return candidates


def _benign_candidate_failure(error: RuntimeError | OSError, candidate: str) -> bool:
    if isinstance(error, FileNotFoundError):
        return not Path(candidate).is_dir()
    return "not a git repository" in str(error).lower()


def _unique(values: list[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))


def _marker(session_id: str) -> Path:
    key = hashlib.sha256(session_id.encode()).hexdigest()
    return STATE_DIR / f"{key}.json"


def _block(reason: str) -> dict[str, Any]:
    if os.getenv("CALLER_HOOK_CLIENT", "").lower() == "codex":
        return {"continue": False, "stopReason": reason, "systemMessage": reason}
    return {"decision": "block", "reason": reason}


if __name__ == "__main__":
    run()
