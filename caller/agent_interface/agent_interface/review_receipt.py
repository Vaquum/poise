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
import os
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

SUBMISSIONS = {"requested_changes", "reviewed_clean", "approved_pr"}
_current: ContextVar[dict | None] = ContextVar("review_receipt", default=None)
_call: ContextVar[tuple[Path, str] | None] = ContextVar("review_receipt_call", default=None)
_failure: ContextVar[str | None] = ContextVar("review_submission_failure", default=None)
_blocked: ContextVar[str | None] = ContextVar("review_submission_blocked", default=None)
_refused: ContextVar[dict | None] = ContextVar("review_submission_refused", default=None)
# A transport error carries no status: the write may have landed before the
# response was lost, so publication is uncertain, never a refused submission.
_TRANSPORT_ERRORS = ("TimeoutException", "ReadTimeout", "WriteTimeout", "ConnectTimeout", "PoolTimeout",
                     "ConnectError", "ReadError", "WriteError", "CloseError",
                     "RemoteProtocolError", "LocalProtocolError")
_QUOTA_HEADERS = {"x-ratelimit-resource", "x-ratelimit-limit", "x-ratelimit-remaining",
                  "x-ratelimit-used", "x-ratelimit-reset", "retry-after"}


@contextmanager
def invocation_environment(database: Path, call_id: str, managed: bool, *, initialize: bool = True):
    keys = {"AGENT_INTERFACE_RECEIPT_DB": str(database), "AGENT_INTERFACE_RECEIPT_CALL": call_id}
    previous = {key: os.environ.get(key) for key in keys}
    try:
        for key, value in keys.items():
            if managed:
                os.environ[key] = value
            else:
                os.environ.pop(key, None)
        if managed and initialize:
            with sqlite3.connect(database, timeout=30) as conn:
                conn.execute("update calls set artifact=? where id=? and status='running'", (json.dumps({"phase": "reviewing"}), call_id))
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def begin_submission(body: str, head: str) -> str:
    """Cross-process native receipt: reserve the one review write before POST.
    An unacknowledged request retains its identity in GitHub's review body."""
    database = os.environ.get("AGENT_INTERFACE_RECEIPT_DB")
    call_id = os.environ.get("AGENT_INTERFACE_RECEIPT_CALL")
    if not database and not call_id:
        return body
    if not database or not call_id or not re.fullmatch(r"[0-9a-f]{32}", call_id):
        raise RuntimeError("managed review submission lacks its native receipt binding")
    with sqlite3.connect(database, timeout=30) as conn:
        changed = conn.execute("update calls set artifact=json_patch(artifact,?) where id=? and status='running' and source='poise:behavior-chain' "
                               "and coalesce(error_code,'') not in ('stopping','stopped') and json_extract(artifact,'$.phase')='reviewing'",
                               (json.dumps({"phase": "submitting_review", "expected_head": head}), call_id)).rowcount
        if changed != 1:
            raise RuntimeError("managed review does not own an unsubmitted native action receipt")
    return f"{body}\n\n<!-- poise-invocation {call_id} -->".strip()


def work_publication(head: str, *, start_replies: bool = False) -> None:
    """Checkpoint a pushed head, then reserve its planned replies before POST.

    Only a recorded unattempted reply batch can resume after worker settlement.
    A lost POST remains uncertain instead of authorizing another write.
    """
    database, call_id = os.environ.get("AGENT_INTERFACE_RECEIPT_DB"), os.environ.get("AGENT_INTERFACE_RECEIPT_CALL")
    if not database and not call_id:
        return
    if not database or not call_id or not re.fullmatch(r"[0-9a-f]{32}", call_id) or not re.fullmatch(r"[0-9a-f]{40}", head):
        raise RuntimeError("managed work publication lacks its native receipt binding")
    with sqlite3.connect(database, timeout=30) as conn:
        conn.execute("begin immediate")
        row = conn.execute("select artifact,status,resources_settled_at from calls where id=? and source='poise:behavior-chain' "
                           "and behavior in ('implement_issue','repair_pr') and action_plan is not null "
                           "and coalesce(error_code,'') not in ('stopping','stopped')", (call_id,)).fetchone()
        artifact = json.loads(row[0]) if row and row[0] else {}
        if not row or artifact.get("phase") != "publishing" or not artifact.get("plan_sha"):
            raise RuntimeError("work publication lacks its original native action plan")
        if start_replies:
            if row[1] not in {"running", "failed"} or (row[1] == "failed" and row[2] is None) \
                    or artifact.get("publication_head") != head or artifact.get("replies_started") is not False:
                raise RuntimeError("planned replies are already attempted or lack settled native ownership")
            artifact["replies_started"] = True
        else:
            if row[1] != "running" or ("publication_head" in artifact and artifact["publication_head"] != head):
                raise RuntimeError("work publication head conflicts with its original native receipt")
            artifact.setdefault("publication_head", head)
            artifact.setdefault("replies_started", False)
        conn.execute("update calls set artifact=? where id=?", (json.dumps(artifact), call_id))


@contextmanager
def managed_resources(root: Path):
    """Managed handoffs require resource settlement as well as a verdict."""
    database, call_id = os.environ.get("AGENT_INTERFACE_RECEIPT_DB"), os.environ.get("AGENT_INTERFACE_RECEIPT_CALL")
    if not database or not call_id:
        yield
        return
    from . import issue_review
    with sqlite3.connect(database, timeout=30) as conn:
        conn.execute("update calls set artifact=json_set(coalesce(artifact,'{}'),'$.resource_root',?) where id=?", (str(root), call_id))
    try:
        yield
    finally:
        issue_review.stop_leftovers(root)
        if issue_review._cwd_pids(root, require_complete=True) != []:
            with sqlite3.connect(database, timeout=30) as conn:
                conn.execute("update calls set artifact=json_set(coalesce(artifact,'{}'),'$.resource_error','resources_unknown') where id=?", (call_id,))
            raise RuntimeError("managed behavior resources could not be proven released")


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
        return record_transport_failure(text)
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


def record_transport_failure(text: str) -> str | None:
    """A controller-observed transport error during the submission command.

    Timeouts and connection errors name no status: the write may already be
    accepted, so the failure is transient and reconciled from live receipts,
    never tagged a refused submission.
    """
    found = None
    for match in re.finditer(r"httpx\.(?:_[a-z_]+\.)?(?:" + "|".join(_TRANSPORT_ERRORS) + r")\b", text):
        found = match
    if found is None:
        return None
    message = text[found.start():].strip()[:4096]
    _failure.set(message)
    return message


def failure() -> str | None:
    return _failure.get()


def blocked_refusal(text: str) -> str | None:
    """The approval guard's pre-POST refusal line, when the command output holds one.

    Pure evidence for both submission runners: the structured runner raises it
    directly, and the Claude guard persists it beside the receipt for the run
    to settle as a blocked approval instead of a failed verdict.
    """
    found = re.search(r"(?:error: )?\d+ unresolved review conversation\(s\) from other reviewers remain", text)
    if found is None:
        return None
    return " ".join(found.group(0).split())[:500]


def blocked() -> str | None:
    return _blocked.get()


def parse_no_review(text: str) -> dict | None:
    """A duplicate-only publication refusal: the skipped entries and whether
    every one restated an already-published body. None for anything else,
    including malformed replies. Shared by both submission runners so the
    repeat-only rule cannot drift between them."""
    try:
        reply = json.loads(text)
    except ValueError:
        return None
    if not isinstance(reply, dict) or reply.get("action") != "no_review":
        return None
    skipped = reply.get("skipped", [])
    repeat_only = (isinstance(skipped, list) and len(skipped) > 0 and all(
        isinstance(entry, dict) and entry.get("reason") == "repeat" for entry in skipped))
    return {"skipped": skipped, "repeat_only": repeat_only}


def refused() -> dict | None:
    """The no_review reply details the guard persisted for this run, if any."""
    return _refused.get()


def bind(database: Path, call_id: str) -> None:
    _call.set((database, call_id))
    _current.set(None)
    _failure.set(None)
    _blocked.set(None)
    _refused.set(None)


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
            if os.environ.get("AGENT_INTERFACE_RECEIPT_CALL") == call_id:
                conn.execute("update calls set artifact=json_patch(artifact,?) where id=? and status='running'",
                             (json.dumps({"phase": "review_submitted", **receipt}), call_id))
    return receipt


def record_file(path: str | Path) -> dict | None:
    if _current.get() is not None:
        return _current.get()
    try:
        record_failure(Path(str(path) + ".failure").read_text())
    except OSError:
        pass
    try:
        refused = blocked_refusal(Path(str(path) + ".blocked").read_text())
    except OSError:
        pass
    else:
        if refused is not None:
            _blocked.set(refused)
    try:
        details = parse_no_review(Path(str(path) + ".refused").read_text())
    except OSError:
        pass
    else:
        if details is not None:
            _refused.set(details)
    try:
        text = Path(path).read_text()
    except OSError:
        return None
    return record(text) if text.strip() else None


def concurrent_unclaimed_run_exists(database: Path, call_id: str, repo: str, pr_number: str) -> bool:
    """A sibling PR run that may have submitted without recording its review id.

    True when another pr_review/pr_approve run by the same actor on this target is still running,
    or ended after this run started without a recorded review id and without
    provable no-action preflight state. An unclaimed extra review is then
    unattributed: this run cannot tell its own second write from the sibling's
    invisible one, so it must not be blamed for a duplicate.
    """
    with sqlite3.connect(database, timeout=30) as conn:
        mine = conn.execute("select started_at, actor from calls where id=?", (call_id,)).fetchone()
        if mine is None or mine[0] is None:
            return True
        started, actor = mine
        row = conn.execute(
            "select 1 from calls where id != ? and repo = ? and pr_id = ? "
            "and actor IS ? COLLATE NOCASE "
            "and behavior in ('pr_review', 'pr_approve') and review_id is null "
            "and (outcome is null or action is null "
            "or outcome != 'preflight_failed' or action != 'not_started') "
            "and (status = 'running' or ended_at > ?) limit 1",
            (call_id, repo, pr_number, actor, started)).fetchone()
    return row is not None


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
