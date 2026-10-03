"""One deadline for a governed review, including its single recovery attempt."""
from contextvars import ContextVar
from time import monotonic

# ceil(1.1 * 1283.6625320911407): longest of 962 completed calls on 2026-09-13.
REVIEW_TIMEOUT_SECONDS = 1413
REVIEW_POLICY = "bounded-v1"
FINAL_CHECK_SECONDS = 15
OUTPUT_TOKENS = 64000
_current = ContextVar("review_budget", default=None)


class ReviewLimitError(RuntimeError):
    def __init__(self, message, code="model_output_limit"):
        super().__init__(message)
        self.code = code


def timeout(cap, *, reserve=0):
    budget = _current.get()
    remaining = min(cap, budget.deadline - monotonic() - reserve) if budget else cap
    if remaining <= 0:
        raise ReviewLimitError("Review reached its total time limit; needs attention", "review_budget_exhausted")
    return remaining


def packet_cache():
    budget = _current.get()
    return budget.packets if budget else None


class ReviewBudget:
    def __init__(self, seconds=REVIEW_TIMEOUT_SECONDS, cap=REVIEW_TIMEOUT_SECONDS):
        self.deadline = monotonic() + min(seconds, cap)
        self.packets = {}

    def __enter__(self):
        self.token = _current.set(self)
        return self

    def __exit__(self, *_):
        _current.reset(self.token)
