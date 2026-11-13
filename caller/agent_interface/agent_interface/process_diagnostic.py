"""Read only the versioned, redacted diagnostic envelope from github-interface."""
import errno
import json
import math
import os
import re
import subprocess
from datetime import datetime, timezone

PREFIX = "caller_diagnostic: "
CONTEXT_FIELDS = ("event_time", "executable", "resolved_executable", "cwd", "pid", "exit_code", "signal", "timeout_seconds", "errno",
                  "elapsed_ms", "message", "workspace", "container", "release", "repository", "pr", "expected_head", "observed_head",
                  "base_sha", "merge_base_sha", "call_id", "correlation_id", "reviewer", "behavior", "submission", "refusal")
FILESYSTEM_FIELDS = ("path", "free_bytes", "total_bytes", "free_inodes", "total_inodes", "measured_at", "measurement_error")


def diagnostic_from_stderr(stderr: str, phase: str) -> dict | None:
    for line in stderr.splitlines():
        if not line.startswith(PREFIX):
            continue
        if len(line.encode()) > 128 * 1024:
            return None
        try:
            value = json.loads(line[len(PREFIX):])
        except (ValueError, RecursionError):
            return None
        if (not isinstance(value, dict) or type(value.get("version")) is not int or value.get("version") != 1
                or value.get("source") != "caller" or value.get("severity") != "error"
                or not isinstance(value.get("operation"), str) or not isinstance(value.get("stderr"), str)
                or value.get("message") is not None and not isinstance(value["message"], str)
                or value.get("outcome") is not None and not isinstance(value["outcome"], str)
                or value.get("stderr_truncated") is not None and type(value["stderr_truncated"]) is not bool):
            return None
        filesystem = value.get("filesystem")
        if filesystem is not None and not isinstance(filesystem, dict):
            return None
        try:
            for row, keys in ((value, CONTEXT_FIELDS), (filesystem or {}, FILESYSTEM_FIELDS)):
                if any(item is not None and not isinstance(item, str)
                       and not (type(item) in (int, float) and math.isfinite(item))
                       for item in (row.get(key) for key in keys)):
                    return None
        except OverflowError:
            return None
        fields = ("version", "source", "severity", "operation", "outcome", "stderr", "stderr_truncated", *CONTEXT_FIELDS)
        return {**{key: value[key] for key in fields if key in value}, "phase": phase,
                "filesystem": {key: filesystem[key] for key in FILESYSTEM_FIELDS if key in filesystem} if filesystem is not None else None}
    return None


def diagnostic_envelope(*, operation: str, phase: str, outcome: str, stderr: str = "",
                        stderr_truncated: bool = False, **extra) -> dict:
    """Complete Caller process-diagnostic envelope: version, source and
    severity plus string operation/phase/outcome/stderr and a truncation
    flag, the exact shape server/process-diagnostic.ts validates. Callers
    add their own evidence as extra fields."""
    return {"version": 1, "source": "caller", "severity": "error", "operation": operation,
            "phase": phase, "outcome": outcome, "stderr": stderr,
            "stderr_truncated": stderr_truncated, **extra}


def diagnostic_message(value: dict) -> str:
    return (f"review git {value['operation']} {value['outcome']} "
            f"(exit {value.get('exit_code')}, signal {value.get('signal')}, errno {value.get('errno')}): "
            + (value.get("stderr") or value.get("message") or "no stderr was provided; cause unknown"))


def escaped_failure(error: BaseException | None, phase: str, exit_code: int | None = None) -> dict:
    """Project exception metadata only: exception text can contain prompts/argv.

    Cleanup can wrap or replace the initiating exception. Follow its original
    context, with a bound for cyclic/oversized exception chains.
    """
    seen = set()
    for _ in range(16):
        if error is None or id(error) in seen:
            break
        seen.add(id(error))
        original = error.exceptions[0] if isinstance(error, BaseExceptionGroup) else error.__cause__ or error.__context__
        if original is None or id(original) in seen:
            break
        error = original
    operation = "call.execute"
    trace = error.__traceback__ if error is not None else None
    while trace is not None:
        module = trace.tb_frame.f_globals.get("__name__", "")
        if module == "agent_interface" or module.startswith("agent_interface."):
            operation = f"{module}.{trace.tb_frame.f_code.co_name}"[:160]
        trace = trace.tb_next
    number = error.errno if isinstance(error, OSError) and type(error.errno) is int else None
    if isinstance(error, subprocess.CalledProcessError):
        exit_code = error.returncode if type(error.returncode) is int else None
    cause = re.sub(r"[^A-Za-z0-9_]", "", type(error).__name__)[:80] if error is not None else "unknown"
    if number is not None:
        cause += f" ({errno.errorcode.get(number, 'unknown errno')})"
    return diagnostic_envelope(operation=operation, phase=phase,
                               outcome="timed_out" if isinstance(error, subprocess.TimeoutExpired) else "exception" if error else "unknown",
                               message=cause if error else "Inner Caller ended without retained failure evidence; cause unknown",
                               event_time=datetime.now(timezone.utc).isoformat(), errno=number,
                               exit_code=exit_code if exit_code is not None and exit_code >= 0 else None,
                               signal=-exit_code if exit_code is not None and exit_code < 0 else None,
                               timeout_seconds=error.timeout if isinstance(error, subprocess.TimeoutExpired) and type(error.timeout) in (int, float) else None)


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
