from __future__ import annotations

import json
import os
from pathlib import Path


def tools_arg(rules: list[str]) -> str:
    return ",".join(sorted({rule.split("(", 1)[0] for rule in rules}))


def settings(rules: list[str], review_gate: str | None = None, output_tokens: int | None = None, review_receipt: str | None = None) -> str:
    config = {"permissions": {"allow": rules}, "defaultMode": "dontAsk"}
    if review_gate:
        config["env"] = {"AGENT_INTERFACE_REVIEW_GATE": review_gate}
    if review_receipt:
        config.setdefault("env", {})["AGENT_INTERFACE_REVIEW_RECEIPT"] = review_receipt
    if output_tokens is not None:
        config.setdefault("env", {})["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = str(output_tokens)
    return json.dumps(config)


def bash_patterns(rules: list[str]) -> list[str]:
    return [rule[5:-1] for rule in rules if rule.startswith("Bash(") and rule.endswith(")")]


def env(rules: list[str]) -> dict[str, str]:
    e = os.environ.copy()
    patterns = bash_patterns(rules)
    if patterns:
        guard = Path(__file__).with_name("bash_guard.py")
        guard.chmod(guard.stat().st_mode | 0o111)
        e["AGENT_INTERFACE_BASH_ALLOW"] = json.dumps(patterns)
        e["CLAUDE_CODE_SHELL_PREFIX"] = str(guard)
    return e
