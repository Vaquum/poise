"""Read only the versioned, redacted diagnostic envelope from github-interface."""
import json
import os
import subprocess
from datetime import datetime, timezone

PREFIX = "caller_diagnostic: "


def diagnostic_from_stderr(stderr: str, phase: str) -> dict | None:
    for line in stderr.splitlines():
        if not line.startswith(PREFIX):
            continue
        value = json.loads(line[len(PREFIX):])
        if (not isinstance(value, dict) or value.get("version") != 1
                or value.get("source") != "caller" or value.get("severity") != "error"
                or not isinstance(value.get("operation"), str) or not isinstance(value.get("stderr"), str)
                or len(line.encode()) > 128 * 1024):
            raise ValueError("invalid Caller process diagnostic")
        return {**value, "phase": phase}
    return None


def diagnostic_message(value: dict) -> str:
    return (f"review git {value['operation']} {value['outcome']} "
            f"(exit {value.get('exit_code')}, signal {value.get('signal')}, errno {value.get('errno')}): "
            + (value.get("stderr") or value.get("message") or "no stderr was provided; cause unknown"))


def command_failure(error: BaseException, phase: str, cwd: str, timeout: float) -> dict:
    # TimeoutExpired's output/stderr may include arbitrary child content. Only
    # github-interface's explicit diagnostic envelope is admitted as evidence.
    home = os.environ.get("HOME")
    path = "~" + cwd[len(home):] if home and cwd.startswith(home + os.sep) else cwd
    return {"version": 1, "source": "caller", "severity": "error", "operation": "github-interface",
            "phase": phase, "event_time": datetime.now(timezone.utc).isoformat(), "cwd": path,
            "outcome": "timed_out" if isinstance(error, subprocess.TimeoutExpired) else "missing_executable" if isinstance(error, FileNotFoundError) else "spawn_error",
            "stderr": "", "stderr_truncated": False, "exit_code": None, "signal": None,
            "errno": error.errno if isinstance(error, OSError) else None, "timeout_seconds": timeout,
            "elapsed_ms": None, "filesystem": None}
