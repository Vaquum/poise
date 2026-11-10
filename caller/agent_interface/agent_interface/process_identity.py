"""Local process identity, independent of command names and wall-clock time.

A pidfd is opened before inspecting the numeric PID. Signals use that handle
only; the supervisor's SIGTERM handler owns its provider shutdown. Loss of the
supervisor is never evidence that its descendants or disk were reclaimed.
"""
from __future__ import annotations

import errno
import json
import os
import select
import signal
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

_OWNER_NONCE = uuid4().hex


def _start(pid: int) -> str:
    fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    value = fields[19]
    if not value.isdigit():
        raise ValueError("process start ticks are invalid")
    return value


def epoch() -> dict:
    namespace = Path("/proc/self/ns/pid").stat()
    boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    if not boot:
        raise ValueError("boot identity is empty")
    return {"boot": boot, "init_start": _start(1), "namespace_dev": namespace.st_dev,
            "namespace_ino": namespace.st_ino}


def capture(pid: int, *, native: bool = False) -> str:
    # Older reapers reject this version instead of acting on a native Call
    # registered while both releases still share the workspace store.
    version = 2 if native else 1
    try:
        value = {"version": version, "pid": pid, "start": _start(pid), "epoch": epoch()}
    except (OSError, ValueError, IndexError) as error:
        # Local development without /proc may still run behaviors, but cannot
        # later authorize a signal or recovery from a numeric PID alone.
        value = {"version": version, "pid": pid, "unverified": str(error)[:500]}
    return json.dumps({**value, "owner_nonce": _OWNER_NONCE}, separators=(",", ":"))


def owns_registration(encoded: str | None) -> bool:
    """Only the process which won track() may write its normal release.

    A later CLI can reuse its numeric PID, including on development platforms
    without /proc. The per-process nonce was committed by that original claim.
    """
    try:
        value = json.loads(encoded or "null")
    except (ValueError, TypeError):
        return False
    if not isinstance(value, dict) or value.get("pid") != os.getpid() or value.get("owner_nonce") != _OWNER_NONCE:
        return False
    if "unverified" in value:
        return True
    try:
        return state(encoded, os.getpid()) == "alive"
    except RuntimeError:
        return False


def decode(encoded: str | None, pid: int) -> dict:
    try:
        value = json.loads(encoded or "null")
    except ValueError as error:
        raise RuntimeError("recorded process identity is unreadable; no signal authorized") from error
    if not isinstance(value, dict) or value.get("version") not in (1, 2) or value.get("pid") != pid \
            or not isinstance(value.get("start"), str) or not value["start"].isdigit() \
            or not isinstance(value.get("epoch"), dict):
        raise RuntimeError("call lacks a verified process identity; no signal authorized")
    return value


def state(encoded: str | None, pid: int, same_epoch: bool = False) -> str:
    """Observe a local identity. A required but different epoch is unobservable."""
    value = decode(encoded, pid)
    try:
        current_epoch = epoch()
    except (OSError, ValueError, IndexError) as error:
        raise RuntimeError(f"process epoch cannot be verified: {error}") from error
    if value["epoch"] != current_epoch:
        return "unobservable" if same_epoch else "different"
    try:
        return "alive" if value["start"] == _start(pid) else "different"
    except FileNotFoundError:
        return "gone"
    except (OSError, ValueError, IndexError) as error:
        raise RuntimeError(f"process identity cannot be verified: {error}") from error


class PinnedProcess:
    def __init__(self, fd: int):
        self.fd = fd

    def signal(self, signum: int) -> None:
        try:
            signal.pidfd_send_signal(self.fd, signum)
        except ProcessLookupError:
            return

    def wait(self, seconds: float) -> bool:
        poll = select.poll()
        poll.register(self.fd, select.POLLIN)
        return bool(poll.poll(max(0, int(seconds * 1000))))


@contextmanager
def pinned(encoded: str | None, pid: int):
    decode(encoded, pid)
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        raise RuntimeError("safe local Stop requires pidfd support; no signal authorized on this platform")
    try:
        fd = os.pidfd_open(pid)
    except ProcessLookupError:
        if state(encoded, pid) == "different":
            raise RuntimeError(f"pid {pid} belongs to another process or epoch; no signal authorized") from None
        yield None
        return
    except OSError as error:
        detail = "pidfd is unsupported" if error.errno == errno.ENOSYS else str(error)
        raise RuntimeError(f"safe local Stop cannot pin its process: {detail}") from error
    try:
        observed = state(encoded, pid)
        if observed == "different":
            raise RuntimeError(f"pid {pid} belongs to another process or epoch; no signal authorized")
        yield PinnedProcess(fd) if observed == "alive" else None
    finally:
        os.close(fd)
