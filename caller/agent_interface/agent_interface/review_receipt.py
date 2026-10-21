"""The review a governed run submitted, by the id GitHub returned for it.

Every github-interface submission answers with a review_id. The structured
runner sees that reply directly; a Claude review submits through bash_guard,
which writes the reply to the receipt file the run watches. Recorded on the
call row the moment it is known, so a sibling review of the same PR — the
reviewers Poise runs in parallel — can tell this run's review from its own.
"""
from __future__ import annotations

import ast
import json
import re
import sqlite3
from contextvars import ContextVar
from pathlib import Path

SUBMISSIONS = {"requested_changes", "reviewed_clean", "approved_pr"}
_current: ContextVar[dict | None] = ContextVar("review_receipt", default=None)
_call: ContextVar[tuple[Path, str] | None] = ContextVar("review_receipt_call", default=None)
_failure: ContextVar[str | None] = ContextVar("review_submission_failure", default=None)
_QUOTA_HEADERS = {"x-ratelimit-resource", "x-ratelimit-limit", "x-ratelimit-remaining",
                  "x-ratelimit-used", "x-ratelimit-reset", "retry-after"}


class SubmissionError(RuntimeError):
    """An observed transient GitHub command failure, not a verdict defect."""


def _quota_failure(tail: str) -> str | None:
    match = re.match(r" (\{[^\n{}]{1,2048}\})(?: body=|\Z)", tail)
    if not match:
        return None
    try:
        node = ast.parse(match[1], mode="eval").body
    except (SyntaxError, ValueError):
        return None
    if not isinstance(node, ast.Dict) or not 1 <= len(node.keys) <= len(_QUOTA_HEADERS):
        return None
    headers = {}
    for key, value in zip(node.keys, node.values):
        if not (isinstance(key, ast.Constant) and isinstance(key.value, str)
                and isinstance(value, ast.Constant) and isinstance(value.value, str)):
            return None
        if key.value not in _QUOTA_HEADERS or key.value in headers:
            return None
        pattern = r"core" if key.value == "x-ratelimit-resource" else r"[0-9]{1,20}"
        if not re.fullmatch(pattern, value.value):
            return None
        headers[key.value] = value.value
    if headers.get("x-ratelimit-resource") != "core" or headers.get("x-ratelimit-remaining") != "0":
        return None
    return f"error: GitHub 403 rate-limit: {headers}"


def record_failure(text: str) -> str | None:
    # Only controller-observed command errors qualify. Provider prose never
    # calls this path, and validation/authentication failures remain held.
    observed = re.search(r"(?:^|\n)(?:error: )?GitHub (\d{3})( rate-limit)?:", text)
    if not observed:
        return None
    status = observed[1]
    if status == "403":
        message = _quota_failure(text[observed.end():].rstrip()) if observed[2] else None
    elif status in {"408", "429"} or status.startswith("5"):
        message = text[observed.start():].strip()[:4096]
    else:
        message = None
    if message is not None:
        _failure.set(message)
        return message
    return None


def failure() -> str | None:
    return _failure.get()


def bind(database: Path, call_id: str) -> None:
    _call.set((database, call_id))
    _current.set(None)
    _failure.set(None)


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


def _comments(text: str) -> str | None:
    """The inline comments a change request posted, as GitHub's reply counted them."""
    try:
        count = json.loads(text).get("comments")
    except (ValueError, AttributeError):
        return None
    return str(count) if isinstance(count, int) and not isinstance(count, bool) and count >= 0 else None


def record(text: str) -> dict | None:
    receipt = parse(text)
    if receipt is None:
        return None
    _current.set(receipt)
    bound = _call.get()
    if bound:
        database, call_id = bound
        with sqlite3.connect(database, timeout=30) as conn:
            conn.execute("update calls set review_id=?, review_comments=? where id=?",
                         (str(receipt["review_id"]), _comments(text), call_id))
    return receipt


def record_file(path: str | Path) -> dict | None:
    if _current.get() is not None:
        return _current.get()
    try:
        record_failure(Path(str(path) + ".failure").read_text())
    except OSError:
        pass
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
