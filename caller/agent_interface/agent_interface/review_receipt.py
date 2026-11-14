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
import time
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

if __package__:
    from . import caller_store
else:
    import caller_store

SUBMISSIONS = {"requested_changes", "reviewed_clean", "approved_pr"}
_current: ContextVar[dict | None] = ContextVar("review_receipt", default=None)
_call: ContextVar[tuple[Path, str] | None] = ContextVar("review_receipt_call", default=None)
_failure: ContextVar[str | None] = ContextVar("review_submission_failure", default=None)
_conflict: ContextVar[dict | None] = ContextVar("review_receipt_conflict", default=None)
_blocked: ContextVar[str | None] = ContextVar("review_submission_blocked", default=None)
_refused: ContextVar[dict | None] = ContextVar("review_submission_refused", default=None)
# A transport error carries no status: the write may have landed before the
# response was lost, so publication is uncertain, never a refused submission.
_TRANSPORT_ERRORS = ("TimeoutException", "ReadTimeout", "WriteTimeout", "ConnectTimeout", "PoolTimeout",
                     "ConnectError", "ReadError", "WriteError", "CloseError",
                     "RemoteProtocolError", "LocalProtocolError")
_QUOTA_HEADERS = {"x-ratelimit-resource", "x-ratelimit-limit", "x-ratelimit-remaining",
                  "x-ratelimit-used", "x-ratelimit-reset", "retry-after"}


def prepare_response(packet: str, model: str, review_scope: str = "") -> None:
    """Pin controller-owned context before invoking the configured reviewer."""
    from hashlib import sha256
    bound = _call.get()
    if bound is None:
        return
    value = json.loads(packet)
    pull = value["pull"]
    context = sha256(json.dumps([pull["base"]["sha"], pull["title"], pull.get("body") or ""],
                               ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    candidates = set(value.get("verification_candidates", []))
    fixes = {str(thread["root_comment_id"]): {"id": thread["id"], "revision": thread["repair_answer"]["revision"]}
             for thread in value.get("review_threads", []) if thread.get("root_comment_id") in candidates}
    database, call_id = bound
    with caller_store.connect(database, timeout=30) as conn:
        conn.execute("update calls set artifact=json_set(coalesce(artifact,'{}'),'$.review_context',json(?),'$.review_scope',?,"
                     "'$.verification_candidates',json(?)) where id=? and status='running'",
                     (json.dumps({"repository": value["repository"], "pull_number": value["pull_number"],
                                  "head_sha": value["head_sha"], "context_sha": context, "model": model}),
                      review_scope or None, json.dumps(fixes), call_id))


def verified_fix_ids(assessment: dict) -> list[int]:
    roots = assessment.get("verified_fixes", [])
    if not isinstance(roots, list) or len(roots) > 100 or any(type(root) is not int or root <= 0 for root in roots) \
            or len(set(roots)) != len(roots):
        raise ValueError("verified_fixes must list up to 100 distinct root comment IDs")
    return roots


def complete_response(assessment: dict, head: str) -> dict | None:
    """Retain the actual response and time before the terminal command runs."""
    if not isinstance(assessment, dict) or set(assessment) - {"verified_fixes"} != {"verdict", "reviewed_context", "limitations"}:
        raise ValueError("review response requires a substantive assessment")
    roots = verified_fix_ids(assessment)
    assessment = {key: value for key, value in assessment.items() if key != "verified_fixes"}
    for key, minimum in (("verdict", 20), ("reviewed_context", 20), ("limitations", 4)):
        if not isinstance(assessment[key], str) or not minimum <= len(assessment[key].strip()) <= 4000:
            raise ValueError(f"invalid review assessment {key}")
    if assessment["verdict"].strip() == "Reviewed: no blocking findings.":
        raise ValueError("fixed acknowledgement is not a substantive assessment")
    bound = _call.get()
    database = os.environ.get("AGENT_INTERFACE_RECEIPT_DB")
    call_id = os.environ.get("AGENT_INTERFACE_RECEIPT_CALL")
    if not database or not call_id:
        if bound is None:
            return None
        database, call_id = bound
    with caller_store.connect(database, timeout=30) as conn:
        conn.execute("begin immediate")
        row = conn.execute("select artifact,actor,status,behavior from calls where id=?", (call_id,)).fetchone()
        if not row or row[2] != "running":
            raise RuntimeError("review response lacks its running native invocation")
        artifact = json.loads(row[0] or "{}")
        context = artifact.get("review_context")
        if not context or context["head_sha"] != head:
            raise RuntimeError("review response lacks its pinned review context")
        candidates = artifact.get("verification_candidates", {})
        if roots and (row[3] not in {"pr_review", "pr_approve"} or any(str(root) not in candidates for root in roots)):
            raise ValueError("verified fix must name an answered thread in the original review packet")
        verified = {str(root): candidates[str(root)] for root in roots}
        prior = artifact.get("review_response")
        if prior is not None:
            if prior["assessment"] == assessment and prior.get("verified_fixes", {}) == verified \
                    and all(prior.get(key) == value for key, value in context.items()):
                return prior
            if artifact.get("phase") != "reviewing":
                raise RuntimeError("native reviewer already submitted a different response")
        response = {**context, "reviewer": row[1], "invocation_id": call_id,
                    "completed_at": int(time.time() * 1000), "assessment": assessment,
                    **({"verified_fixes": verified} if verified else {})}
        conn.execute("update calls set artifact=json_set(artifact,'$.review_response',json(?)) where id=?",
                     (json.dumps(response), call_id))
        if prior is not None:
            conn.execute("update calls set artifact=json_set(artifact,'$.previous_review_response',json(?)) where id=?",
                         (json.dumps(prior), call_id))
        return response


def retained_response() -> dict:
    database, call_id = os.environ.get("AGENT_INTERFACE_RECEIPT_DB"), os.environ.get("AGENT_INTERFACE_RECEIPT_CALL")
    if not database or not call_id:
        raise RuntimeError("review response lacks its native invocation")
    with caller_store.connect(database, timeout=30) as conn:
        row = conn.execute("select artifact from calls where id=? and status='running'", (call_id,)).fetchone()
    response = json.loads(row[0] or "{}").get("review_response") if row else None
    if not response:
        raise RuntimeError("reviewer has not retained a substantive response")
    return response


def retain_verdict(verdict: dict, head: str) -> None:
    """Keep complete findings outside the bounded artifact before finalization."""
    bound = _call.get()
    if bound is None:
        return
    response = complete_response(verdict["assessment"], head)
    database, call_id = bound
    if response is None or response["invocation_id"] != call_id:
        raise RuntimeError("review findings lack their original native invocation")
    from . import RESPONSES
    path = caller_store.response_name(RESPONSES / f"{call_id}.txt")
    with caller_store.connect(database, timeout=30) as conn:
        conn.execute("begin immediate")
        row = conn.execute("select status,artifact from calls where id=?", (call_id,)).fetchone()
        if not row or row[0] != "running" or json.loads(row[1])["phase"] != "reviewing":
            raise RuntimeError("review findings no longer own an unsubmitted native invocation")
        caller_store.write_response_text(Path(path), RESPONSES, json.dumps(verdict, ensure_ascii=False))
        conn.execute("update calls set response_path=? where id=?", (path, call_id))


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
            with caller_store.connect(database, timeout=30) as conn:
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
    with caller_store.connect(database, timeout=30) as conn:
        changed = conn.execute("update calls set artifact=json_patch(artifact,?) where id=? and status='running' and behavior in ('pr_review','pr_approve') "
                               "and coalesce(error_code,'') not in ('stopping','stopped') and json_extract(artifact,'$.phase')='reviewing' "
                               "and json_extract(artifact,'$.review_response.head_sha')=? "
                               "and json_extract(artifact,'$.review_response.completed_at') <= ?",
                               (json.dumps({"phase": "submitting_review", "expected_head": head}), call_id, head, int(time.time() * 1000))).rowcount
        if changed != 1:
            raise RuntimeError("managed review does not own an unsubmitted native action receipt")
        scope = conn.execute("select json_extract(artifact,'$.review_scope') from calls where id=?", (call_id,)).fetchone()[0]
    if scope:
        # Keep the retained assessment intact, including its response marker.
        # The visible policy is supplied by Poise, not by a model echo.
        visible, separator, response = body.partition('\n\n<!-- poise-review-response ')
        body = f"{visible.replace(scope, '').strip()}\n\n{scope}{separator}{response}"
    return f"{body}\n\n<!-- poise-invocation {call_id} -->".strip()


def checkpoint_verified_resolution(response: dict, review_id: int | None, thread_id: str, *, resolved: bool = False) -> None:
    """Record each attempt and its response within the original review Call."""
    database, call_id = os.environ.get("AGENT_INTERFACE_RECEIPT_DB"), os.environ.get("AGENT_INTERFACE_RECEIPT_CALL")
    if not database or not call_id or response["invocation_id"] != call_id or type(review_id) is not int or review_id <= 0:
        raise RuntimeError("verified resolution lacks its original review")
    with caller_store.connect(database, timeout=30) as conn:
        conn.execute("begin immediate")
        row = conn.execute("select artifact from calls where id=? and status='running' and behavior in ('pr_review','pr_approve') "
                           "and coalesce(error_code,'') not in ('stopping','stopped')", (call_id,)).fetchone()
        artifact = json.loads(row[0]) if row and row[0] else {}
        if artifact.get("phase") != "submitting_review" or artifact.get("review_response") != response \
                or thread_id not in {fix["id"] for fix in response["verified_fixes"].values()}:
            raise RuntimeError("verified resolution differs from its original review")
        progress = artifact.get("verified_resolution", {"review_id": review_id, "threads": {}})
        threads = progress["threads"]
        if progress["review_id"] != review_id or threads.get(thread_id) != ("attempted" if resolved else None) \
                or not resolved and "attempted" in threads.values():
            raise RuntimeError("verified resolution cannot replay an attempted thread")
        threads[thread_id] = "resolved" if resolved else "attempted"
        conn.execute("update calls set artifact=json_set(artifact,'$.verified_resolution',json(?)) where id=?",
                     (json.dumps(progress), call_id))


def work_publication(head: str, *, start_replies: bool = False) -> None:
    """Record write intent before push, then reserve planned replies before POST.

    Only a recorded unattempted reply batch can resume after worker settlement.
    A lost POST remains uncertain instead of authorizing another write.
    """
    from . import native_namespace, resource_ownership
    database, call_id = os.environ.get("AGENT_INTERFACE_RECEIPT_DB"), os.environ.get("AGENT_INTERFACE_RECEIPT_CALL")
    if not database and not call_id:
        return
    if not database or not call_id or not re.fullmatch(r"[0-9a-f]{32}", call_id) or not re.fullmatch(r"[0-9a-f]{40}", head):
        raise RuntimeError("managed work publication lacks its native receipt binding")
    with caller_store.connect(database, timeout=30) as conn:
        conn.execute("begin immediate")
        row = conn.execute("select artifact,status,resources_settled_at,resource_ownership from calls where id=? and source='poise:behavior-chain' "
                           "and behavior in ('implement_issue','repair_pr') and action_plan is not null "
                           "and coalesce(error_code,'') not in ('stopping','stopped')", (call_id,)).fetchone()
        artifact = json.loads(row[0]) if row and row[0] else {}
        if not row or artifact.get("phase") not in {"preparing_publication", "publishing"} or not artifact.get("plan_sha"):
            raise RuntimeError("work publication lacks its original native action plan")
        if start_replies:
            ownership = json.loads(row[3]) if row[3] else None
            if row[1] == "running" and ownership and ownership.get("version") == 2:
                scope = native_namespace.active()
                if scope is None:
                    # github-interface is an executed child, so it cannot
                    # inherit Caller's in-memory scope. Verify its original
                    # kernel boundary and that only this helper remains.
                    refusal = "planned replies lack their original idle native helper"
                    try:
                        scope = resource_ownership.original_scope(Path(database), call_id, ownership)
                        helper = os.getpid()
                        if helper <= 2:
                            raise RuntimeError(f"{refusal}: helper_pid")
                        if os.getppid() != 2:
                            raise RuntimeError(f"{refusal}: helper_parent")
                        if os.readlink("/proc/self/ns/pid") != scope.binding["namespace"]:
                            raise RuntimeError(f"{refusal}: helper_namespace")
                        expected = {1, 2, helper}
                        deadline = time.monotonic() + native_namespace.SETTLE_SECONDS
                        while True:
                            remaining = deadline - time.monotonic()
                            if remaining <= 0:
                                raise RuntimeError(f"{refusal}: namespace_busy")
                            members = set(scope.read(timeout_seconds=min(native_namespace.CONTROL_SECONDS, remaining))["pids"])
                            if time.monotonic() > deadline:
                                raise RuntimeError(f"{refusal}: namespace_read_timeout")
                            if members == expected:
                                break
                            if not expected.issubset(members):
                                raise RuntimeError(f"{refusal}: namespace_members")
                            time.sleep(min(0.005, max(0, deadline - time.monotonic())))
                    except TimeoutError as error:
                        raise RuntimeError(f"{refusal}: namespace_read_timeout") from error
                    except OSError as error:
                        raise RuntimeError(f"{refusal}: namespace_read_io") from error
                elif scope.key["callId"] != call_id:
                    raise RuntimeError("planned replies lack their original active native ownership")
                else:
                    scope.require_idle()
            if artifact.get("phase") != "publishing" or row[1] not in {"running", "failed"} or (row[1] == "failed" and not resource_ownership.publication_released(row[2], row[3], artifact)) \
                    or (row[1] == "running" and (not resource_ownership.healthy(ownership)
                                                or artifact.get("resource_error"))) \
                    or artifact.get("publication_head") != head or artifact.get("replies_started") is not False:
                raise RuntimeError("planned replies are already attempted or lack settled native ownership")
            artifact["replies_started"] = True
        else:
            if row[1] != "running" or ("publication_head" in artifact and artifact["publication_head"] != head):
                raise RuntimeError("work publication head conflicts with its original native receipt")
            artifact["phase"] = "publishing"
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
    from . import issue_review, native_namespace, resource_ownership
    root = resource_ownership.allocate(Path(database), call_id, root)
    with caller_store.connect(database, timeout=30) as conn:
        conn.execute("update calls set artifact=json_set(coalesce(artifact,'{}'),'$.resource_root',?) where id=?", (str(root), call_id))
    try:
        yield
    finally:
        resource_ownership.process_check(Path(database), call_id)
        scope = native_namespace.active()
        if scope is not None:
            if scope.key["callId"] != call_id:
                raise RuntimeError("managed resource scope differs from its original Call")
            scope.require_idle()
        elif issue_review._cwd_pids(root, require_complete=True) != []:
            resource_ownership.failure(Path(database), call_id, "resources_unknown", root)
            with caller_store.connect(database, timeout=30) as conn:
                conn.execute("update calls set artifact=json_set(coalesce(artifact,'{}'),'$.resource_error','resources_unknown') where id=?", (call_id,))
            raise RuntimeError("managed behavior resources could not be proven released")
        resource_ownership.process_check(Path(database), call_id, complete=True)


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
    _conflict.set(None)
    _blocked.set(None)
    _refused.set(None)


def get() -> dict | None:
    return _current.get()


def conflict() -> dict | None:
    """Two distinct accepted receipts for this call, when record saw both."""
    return _conflict.get()


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
    head_sha = reply.get("head_sha")
    # A receipt without the head it posted on cannot be checked against the
    # expected head later; it is not positive ownership evidence.
    if not isinstance(head_sha, str) or not re.fullmatch(r"[0-9a-fA-F]{40}", head_sha):
        return None
    receipt = {"action": reply["action"], "review_id": review_id, "head_sha": head_sha.lower()}
    if isinstance(reply.get("review_response"), dict):
        response = reply["review_response"]
        if response.get("head_sha") != head_sha.lower():
            return None
        receipt["review_response"] = response
        receipt["submitted_at"] = reply.get("submitted_at")
    return receipt


def _comments(text: str) -> str | None:
    """The inline comments a change request posted, as GitHub's reply counted them."""
    try:
        count = json.loads(text).get("comments")
    except (ValueError, AttributeError):
        return None
    return str(count) if isinstance(count, int) and not isinstance(count, bool) and count >= 0 else None


def _note_conflict(first: dict, second: dict) -> None:
    if _conflict.get() is None:
        _conflict.set({"first": first, "second": second})


def record(text: str) -> dict | None:
    receipt = parse(text)
    if receipt is None:
        return None
    kept = _current.get()
    if kept is not None and (kept["review_id"] != receipt["review_id"] or kept["action"] != receipt["action"]):
        # A second accepted reply for this call is this call's own double
        # write, positive same-call evidence: the first write keeps the row,
        # and the pair stays visible for the duplicate check instead of the
        # scalar being overwritten with the latest id.
        _note_conflict(kept, receipt)
        return kept
    bound = _call.get()
    if bound:
        database, call_id = bound
        with caller_store.connect(database, timeout=30) as conn:
            row = conn.execute("select review_id from calls where id=?", (call_id,)).fetchone()
            if row is not None and row[0] is not None and str(row[0]) != str(receipt["review_id"]):
                try:
                    first_id: int | str = int(row[0])
                except (TypeError, ValueError):
                    first_id = row[0]
                _note_conflict({"review_id": first_id, "action": None, "head_sha": None}, receipt)
                _current.set(receipt)
                return receipt
            conn.execute("update calls set review_id=?, review_comments=? where id=?",
                         (str(receipt["review_id"]), _comments(text), call_id))
            if os.environ.get("AGENT_INTERFACE_RECEIPT_CALL") == call_id:
                conn.execute("update calls set artifact=json_patch(artifact,?) where id=? and status='running'",
                             (json.dumps({"phase": "review_submitted", **receipt}), call_id))
    _current.set(receipt)
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


def sibling_ids(database: Path, call_id: str, repo: str, pr_number: str) -> set[int]:
    """Review ids other runs recorded for this PR — theirs, never this run's."""
    with caller_store.connect(database, timeout=30) as conn:
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
