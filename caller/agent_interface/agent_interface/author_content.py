from __future__ import annotations

import os
import subprocess

from .chat import STALE_SESSION, get_session, run_session, set_session, stable_uuid
from .model_catalog import CATALOG

VOICE_REF = "4e8bada538c46c817fed4d51a1b4282379e6d540"
VOICE_PATH = "Voice-Addendum.md"
VOICE_PERMALINK = f"https://github.com/Vaquum/design-system/blob/{VOICE_REF}/{VOICE_PATH}"
SYSTEM = "Author content in the provided voice. Use no tools."


def voice() -> str:
    done = subprocess.run(
        [
            "gh",
            "api",
            "-H",
            "Accept: application/vnd.github.raw",
            f"repos/Vaquum/design-system/contents/{VOICE_PATH}?ref={VOICE_REF}",
        ],
        text=True,
        capture_output=True,
        timeout=30,
    )
    if done.returncode:
        raise RuntimeError((done.stderr or done.stdout).strip() or f"voice fetch exited {done.returncode}")
    return done.stdout.strip()


def prompt(topic: str, note: str = "") -> str:
    return f"Voice source: {VOICE_PERMALINK}\n\nVoice:\n{voice()}\n\nTopic:\n{topic}\n\n{note}\n\nReturn only the authored content."


def run(topic: str, pwd: str | None = None, session_id: str | None = None, note: str = "", timeout_s: int = 3600) -> str:
    model = CATALOG.behavior("author_content")
    session_model = f"{model.identity}:author-content"
    provider = get_session(session_id, session_model) if session_id else None
    provider = provider or (stable_uuid(session_id, session_model) if session_id else None)
    session_args = (["--resume" if get_session(session_id, session_model) else "--session-id", provider] if session_id else ["--no-session-persistence"])
    args = [
        os.getenv("CLAUDE_CLI", "claude"),
        "--print",
        "--model",
        model.selector,
        "--effort",
        model.effort,
        "--permission-mode",
        "dontAsk",
        *session_args,
        "--tools",
        "",
        "--system-prompt",
        SYSTEM,
        prompt(topic, note),
    ]

    def invoke(args: list[str]) -> subprocess.CompletedProcess:
        return subprocess.run(args, text=True, capture_output=True, cwd=pwd or "/tmp", timeout=timeout_s)

    done = run_session(invoke, args, session_id, session_model, STALE_SESSION["claude"]) if session_id else invoke(args)
    if done.returncode:
        raise RuntimeError((done.stderr or done.stdout).strip() or f"agent exited {done.returncode}")
    if session_id:
        set_session(session_id, session_model, provider)
    return done.stdout.strip()
