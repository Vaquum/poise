"""Serialize review cancellation against an in-flight GitHub submission."""
from contextlib import contextmanager
import fcntl


class SubmissionSeal:
    """The one terminal write a guarded review may make, then no more."""

    def __init__(self, gate):
        self._gate = gate

    def seal(self):
        if self._gate is None:
            return
        self._gate.seek(0, 2)
        self._gate.write("submitted\n")
        self._gate.flush()

    def mark_uncertain(self):
        # A transient GitHub answer may have accepted the write: further
        # terminal commands stay blocked until the run reconciles, so an
        # uncertain first POST cannot be followed by a proven second one.
        if self._gate is None:
            return
        self._gate.seek(0, 2)
        self._gate.write("uncertain\n")
        self._gate.flush()


@contextmanager
def submission_gate(path: str | None):
    if not path:
        yield SubmissionSeal(None)
        return
    # Never recreate a missing gate: the owning review may have finished.
    with open(path, "r+") as gate:
        fcntl.flock(gate, fcntl.LOCK_EX)
        state = gate.read()
        if state:
            if "submitted" in state:
                raise RuntimeError("review already submitted; duplicate submission blocked")
            if "uncertain" in state:
                raise RuntimeError("prior review submission is uncertain; blocked until reconciled")
            raise RuntimeError("review was superseded; submission blocked")

        yield SubmissionSeal(gate)


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
