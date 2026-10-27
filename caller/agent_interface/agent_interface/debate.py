from __future__ import annotations

import json
import os
import subprocess

from .model_catalog import CATALOG


def session(debate_id: str, role: str) -> str:
    return f"debate-{debate_id}-{role}"


def allowed(debate_id: str) -> list[str]:
    return [
        f"Bash(agent-interface --chat * --model {m} --session {session(debate_id, m)} --pwd /tmp --no-tools)"
        for m in CATALOG.debate_participants
    ]


def command_templates(debate_id: str) -> str:
    return "\n".join(
        f"agent-interface --chat '<prompt>' --model {m} --session {session(debate_id, m)} --pwd /tmp --no-tools"
        for m in CATALOG.debate_participants
    )


def prompt(topic: str, debate_id: str, rounds: int) -> str:
    return f"""You are the debate moderator.

Topic:
{topic}

Rounds:
{rounds}

Allowed commands:
{command_templates(debate_id)}

Rules:
- Use only the allowed agent-interface commands.
- For each round, call every debater once.
- Every debater prompt must include the topic and full debate transcript so far.
- After the final round, return the synthesis.
- Report agreement, disagreement, unclear areas, and what all participants missed."""


def run(topic: str, debate_id: str, rounds: int = 1, timeout_s: int = 3600) -> str:
    if rounds < 1:
        raise ValueError("rounds must be >= 1")
    moderator = CATALOG.behaviors["debate_moderator"]
    args = [
        os.getenv("AGENT_INTERFACE_CLI", "agent-interface"),
        "--chat",
        prompt(topic, debate_id, rounds),
        "--model",
        moderator,
        "--session",
        session(debate_id, "moderator"),
        "--pwd",
        "/tmp",
    ]
    for tool in allowed(debate_id):
        args += ["--allow-command", tool]
    done = subprocess.run(args, text=True, capture_output=True, cwd="/tmp", timeout=timeout_s)
    if done.returncode:
        raise RuntimeError((done.stderr or done.stdout).strip() or f"moderator exited {done.returncode}")
    try:
        data = json.loads(done.stdout)
        response = data.get("response", done.stdout.strip())
    except json.JSONDecodeError:
        response = done.stdout.strip()
    return json.dumps({"response": response, "moderator_allowed": allowed(debate_id), "debater_allowed": []}, indent=2)
