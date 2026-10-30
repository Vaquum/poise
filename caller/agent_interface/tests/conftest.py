"""Reset per-run Caller state between tests.

Structured runs record their GitHub receipt through ContextVars bound by the
governed runner. Tests calling the runner directly must not inherit a previous
test's bound database, which its TemporaryDirectory cleanup already deleted.
"""
import pytest

from agent_interface import review_receipt


@pytest.fixture(autouse=True)
def _clear_review_receipt():
    review_receipt._call.set(None)
    review_receipt._current.set(None)
    review_receipt._failure.set(None)
    review_receipt._conflict.set(None)
    yield
    review_receipt._call.set(None)
    review_receipt._current.set(None)
    review_receipt._failure.set(None)
    review_receipt._conflict.set(None)
