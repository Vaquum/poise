from __future__ import annotations

import os
import subprocess
from pathlib import Path

from .chat import STALE_SESSION, get_session, run_session, set_session, stable_uuid
from .model_catalog import CATALOG

VOICE_GUIDE_ENV = "AGENT_INTERFACE_VOICE_GUIDE"


def voice_guide(path: str | None = None) -> Path | None:
    """The voice guide to write in: `path`, else AGENT_INTERFACE_VOICE_GUIDE.
    None when neither names one; the content is then written without one."""
    raw = (path or os.getenv(VOICE_GUIDE_ENV, "")).strip()
    return Path(raw).expanduser() if raw else None


def voice(guide: Path) -> str:
    text = guide.read_text(encoding="utf-8").strip()
    if not text:
        raise ValueError(f"voice guide is empty: {guide}")
    return text


def prompt(topic: str, note: str = "", guide: str = "") -> str:
    voice_section = f"Voice:\n{guide}\n\n" if guide else ""
    return f"{voice_section}Topic:\n{topic}\n\n{note}\n\nReturn only the authored content."


def run(topic: str, pwd: str | None = None, session_id: str | None = None, note: str = "", timeout_s: int = 3600,
        guide: Path | None = None) -> str:
    text = voice(guide) if guide else ""
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
        "Author content in the provided voice. Use no tools." if text else "Author the content. Use no tools.",
        prompt(topic, note, text),
    ]

    def invoke(args: list[str]) -> subprocess.CompletedProcess:
        return subprocess.run(args, text=True, capture_output=True, cwd=pwd or "/tmp", timeout=timeout_s)

    done = run_session(invoke, args, session_id, session_model, STALE_SESSION["claude"]) if session_id else invoke(args)
    if done.returncode:
        raise RuntimeError((done.stderr or done.stdout).strip() or f"agent exited {done.returncode}")
    if session_id:
        set_session(session_id, session_model, provider)
    return done.stdout.strip()
