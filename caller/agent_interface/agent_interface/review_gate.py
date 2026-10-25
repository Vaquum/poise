"""Serialize review cancellation against an in-flight GitHub submission."""
from contextlib import contextmanager
import fcntl


@contextmanager
def submission_gate(path: str | None):
    if not path:
        yield lambda: None
        return
    # Never recreate a missing gate: the owning review may have finished.
    with open(path, "r+") as gate:
        fcntl.flock(gate, fcntl.LOCK_EX)
        state = gate.read()
        if state:
            if "submitted" in state:
                raise RuntimeError("review already submitted; duplicate submission blocked")
            raise RuntimeError("review was superseded; submission blocked")

        def seal():
            gate.seek(0, 2)
            gate.write("submitted\n")
            gate.flush()

        yield seal


def cancel_when_idle(path: str) -> bool:
    with open(path, "r+") as gate:
        try:
            fcntl.flock(gate, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        if "submitted" in gate.read():
            # A sealed submission already posted: cancellation stops the
            # remaining provider work, never the posted action itself.
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
