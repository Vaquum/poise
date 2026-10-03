"""Bounded, best-effort observations; never a source of review authority."""
from __future__ import annotations

from contextvars import ContextVar
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import sys
from threading import Event, Lock, Thread
from time import time, monotonic

HEARTBEAT_SECONDS = 5
HISTORY_LIMIT = 20
REASONING_LIMIT = 64 * 1024
MINUTE_SECONDS = 60
REASONING_WARNING = "Provider reasoning could not be saved; activity updates continue."
_current: ContextVar[Progress | None] = ContextVar("review_progress", default=None)


def stamp(value: float | None = None) -> str:
    return datetime.fromtimestamp(time() if value is None else value, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def stage(phase: str, message: str, *, timeout: float | None = None) -> None:
    current = _current.get()
    if current:
        current.stage(phase, message, timeout=timeout)


def provider_event(phase: str | None = None, message: str | None = None, reasoning: str | None = None) -> None:
    current = _current.get()
    if current:
        with current.lock:
            current.state["last_provider_event_at"] = stamp()
            if phase == "reasoning":
                current.reasoning_events += 1
                current.state["last_reasoning_at"] = stamp()
            if reasoning:
                current.reasoning_text = (current.reasoning_text + reasoning)[-REASONING_LIMIT:]
                current.observed_reasoning_chars += len(reasoning)
            if phase:
                current._stage(phase, message or phase)


def warning() -> None:
    current = _current.get()
    if current:
        with current.lock:
            message = "Some provider progress events could not be read."
            if current.state["warning"] != message:
                current.state["warning"] = message
                current._event(message)


def terminal(status: str) -> str | None:
    current = _current.get()
    if not current:
        return None
    current.flush()
    # Commit terminal observations in the same UPDATE as the actual outcome.
    # Until then the heartbeat continues to describe the last observed stage.
    with current.lock:
        now = stamp()
        snapshot = {**current.state, "phase": status, "phase_started_at": now,
                    "heartbeat_at": now, "deadline_at": None,
                    "events": [*current.state["events"], {"at": now, "message": f"Run {status}"}][-HISTORY_LIMIT:]}
        current.finished = True
        return json.dumps(snapshot, separators=(",", ":"))


def decode(raw: str | None) -> dict | None:
    try:
        value = json.loads(raw) if raw else None
        return value if isinstance(value, dict) else None
    except (TypeError, ValueError):
        return None


class Progress:
    def __init__(self, database: Path, call_id: str, phase: str = "preflight", message: str = "Checking PR state"):
        self.database, self.call_id = database, call_id
        self.lock = Lock()
        self.write_lock = Lock()
        self.stop = Event()
        self.finished = False
        self.warned = False
        self.reasoning_events = 0
        self.minute_at = monotonic()
        self.reasoning_text = ""
        self.observed_reasoning_chars = 0
        self.reasoning_path = database.parent / "reasoning" / f"{call_id}.txt"
        now = stamp()
        self.state = {
            "version": 1, "phase": phase, "phase_started_at": now,
            "heartbeat_at": now, "last_provider_event_at": None,
            "deadline_at": None, "warning": None,
            "last_reasoning_at": None, "reasoning_chars": 0, "reasoning_available": False,
            "events": [{"at": now, "message": message}],
        }

    def __enter__(self):
        self.token = _current.set(self)
        self.flush()
        self.thread = Thread(target=self._heartbeat, name="review-progress", daemon=True)
        self.thread.start()
        return self

    def __exit__(self, exc_type, *_):
        self.stop.set()
        self.thread.join(timeout=1)
        if not self.finished:
            self.stage("interrupted" if exc_type else "finished", "Worker interrupted" if exc_type else "Worker finished")
            self.flush()
        _current.reset(self.token)

    def _event(self, message: str) -> None:
        self.state["events"].append({"at": stamp(), "message": message[:160]})
        del self.state["events"][:-HISTORY_LIMIT]

    def _stage(self, phase: str, message: str) -> None:
        if self.state["phase"] != phase:
            self.state["phase"] = phase
            self.state["phase_started_at"] = stamp()
        if self.state["events"][-1]["message"] != message:
            self._event(message)

    def stage(self, phase: str, message: str, *, timeout: float | None = None) -> None:
        with self.lock:
            self._stage(phase, message)
            self.state["deadline_at"] = stamp(time() + timeout) if timeout is not None else None

    def _heartbeat(self) -> None:
        while not self.stop.wait(HEARTBEAT_SECONDS):
            self.flush()

    def flush(self) -> None:
        # A busy/broken observer must not delay or fail a GitHub operation.
        # If writes fail, the saved heartbeat ages visibly in Poise.
        try:
            with self.write_lock:
                with self.lock:
                    now = monotonic()
                    if now - self.minute_at >= MINUTE_SECONDS and not self.finished:
                        message = (f"Past minute: new reasoning activity ({self.reasoning_events} events)"
                                   if self.reasoning_events else "Past minute: no new reasoning activity")
                        self._event(message)
                        self.minute_at = now
                        self.reasoning_events = 0
                    if self.observed_reasoning_chars != self.state["reasoning_chars"]:
                        try:
                            self.reasoning_path.parent.mkdir(parents=True, exist_ok=True)
                            temporary = self.reasoning_path.with_suffix(".tmp")
                            temporary.write_text(self.reasoning_text, encoding="utf-8")
                            temporary.replace(self.reasoning_path)
                        except (OSError, UnicodeError):
                            if self.state["warning"] is None:
                                self.state["warning"] = REASONING_WARNING
                        else:
                            self.state["reasoning_chars"] = self.observed_reasoning_chars
                            self.state["reasoning_available"] = True
                            if self.state["warning"] == REASONING_WARNING:
                                self.state["warning"] = None
                    snapshot = {**self.state, "heartbeat_at": stamp()}
                    encoded = json.dumps(snapshot, separators=(",", ":"))
                connection = sqlite3.connect(self.database, timeout=0.1)
                try:
                    with connection:
                        connection.execute("update calls set progress=? where id=? and ended_at is null", (encoded, self.call_id))
                finally:
                    connection.close()
        except (OSError, sqlite3.Error):
            if not self.warned:
                print("[agent-interface] Progress recording unavailable; review execution continues.", file=sys.stderr)
                self.warned = True
