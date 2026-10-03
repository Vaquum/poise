"""Serialize review cancellation against an in-flight GitHub submission."""
from contextlib import contextmanager
import fcntl


@contextmanager
def submission_gate(path: str | None):
    if not path:
        yield
        return
    # Never recreate a missing gate: the owning review may have finished.
    with open(path, "r+") as gate:
        fcntl.flock(gate, fcntl.LOCK_EX)
        if gate.read():
            raise RuntimeError("review was superseded; submission blocked")
        yield


def cancel_when_idle(path: str) -> bool:
    with open(path, "r+") as gate:
        try:
            fcntl.flock(gate, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        gate.write("cancelled\n")
        gate.flush()
        return True


def submission_active(path: str) -> bool:
    with open(path, "r") as gate:
        try:
            fcntl.flock(gate, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        return False
