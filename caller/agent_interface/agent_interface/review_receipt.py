"""The review a governed run submitted, by the id GitHub returned for it.

Every github-interface submission answers with a review_id. The structured
runner sees that reply directly; a Claude review submits through bash_guard,
which writes the reply to the receipt file the run watches. Recorded on the
call row the moment it is known, so a sibling review of the same PR — the
reviewers Poise runs in parallel — can tell this run's review from its own.
"""
from __future__ import annotations

import json
import sqlite3
from contextvars import ContextVar
from pathlib import Path

SUBMISSIONS = {"requested_changes", "reviewed_clean", "approved_pr"}
_current: ContextVar[dict | None] = ContextVar("review_receipt", default=None)
_call: ContextVar[tuple[Path, str] | None] = ContextVar("review_receipt_call", default=None)


def bind(database: Path, call_id: str) -> None:
    _call.set((database, call_id))
    _current.set(None)


def get() -> dict | None:
    return _current.get()


def parse(text: str) -> dict | None:
    try:
        reply = json.loads(text)
    except ValueError:
        return None
    if not isinstance(reply, dict) or reply.get("action") not in SUBMISSIONS:
        return None
    review_id = reply.get("review_id")
    if isinstance(review_id, bool) or not isinstance(review_id, int):
        return None
    return {"action": reply["action"], "review_id": review_id, "head_sha": reply.get("head_sha")}


def record(text: str) -> dict | None:
    receipt = parse(text)
    if receipt is None:
        return None
    _current.set(receipt)
    bound = _call.get()
    if bound:
        database, call_id = bound
        with sqlite3.connect(database, timeout=30) as conn:
            conn.execute("update calls set review_id=? where id=?", (str(receipt["review_id"]), call_id))
    return receipt


def record_file(path: str | Path) -> dict | None:
    if _current.get() is not None:
        return _current.get()
    try:
        text = Path(path).read_text()
    except OSError:
        return None
    return record(text) if text.strip() else None


def sibling_ids(database: Path, call_id: str, repo: str, pr_number: str) -> set[int]:
    """Review ids other runs recorded for this PR — theirs, never this run's."""
    with sqlite3.connect(database, timeout=30) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "select review_id from calls where review_id is not null and id != ? and repo = ? and pr_id = ?",
            (call_id, repo, pr_number),
        ).fetchall()
    found = set()
    for row in rows:
        try:
            found.add(int(row["review_id"]))
        except (TypeError, ValueError):
            continue
    return found
