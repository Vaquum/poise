"""Real Caller completion with isolated provider, GitHub and resource witnesses."""
import io
import json
import sys
import tempfile
from contextlib import nullcontext, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import agent_interface as api
from agent_interface import pr_approve, pr_review, review_budget, review_receipt, structured_review
from agent_interface.model_catalog import CATALOG
from agent_interface.process_diagnostic import diagnostic_envelope

data = json.load(sys.stdin)
argv, mode = data["argv"], data["mode"]
head = argv[argv.index("--expected-head") + 1]
actor = argv[argv.index("--actor") + 1]
behavior = "pr_review" if argv[0] == "--pr-review" else "pr_approve"
clock = data["now"] / 1000
posts = []
reads = 0
assessment = {"verdict": "Inspected the affected behavior and found no blocking defects.",
              "reviewed_context": "Read the pinned diff and its affected callers.", "limitations": "Isolated regression fixture."}
packet = json.dumps({"repository": "example/repo", "pull_number": 21, "head_sha": head,
                     "coverage": "complete", "files": [],
                     "pull": {"base": {"sha": "b" * 40}, "title": "Candidate", "body": ""}})


def command(args, **kwargs):
    global reads
    if args[1] in {"--reviewed-clean", "--approve-pr"}:
        response = review_receipt.retained_response()
        body = review_receipt.begin_submission(assessment["verdict"], head)
        posts.append({"id": 91, "invocation": response["invocation_id"], "head": head,
                      "state": "COMMENTED" if behavior == "pr_review" else "APPROVED",
                      "response": response, "submittedAt": data["now"] + 1000, "body": body})
        raise api.subprocess.TimeoutExpired(args, kwargs["timeout"])
    assert args[1] == "--review-activity-since", args
    reads += 1
    if reads > 1 and mode == "failed_read":
        raise RuntimeError("recovery inventory unavailable")
    facts = {"action": "review_activity_since", "repository": "example/repo", "pull_number": 21,
             "username": actor, "state": "OPEN", "draft": False, "head_sha": head,
             "reviewer_change_requests_since": 0, "reviewer_approvals_since": len(posts) if behavior == "pr_approve" else 0,
             "reviewer_comments_since": len(posts) if behavior == "pr_review" else 0,
             "reviewer_reviews_since": len(posts), "reviewer_pending_reviews": 0,
             "reviewer_latest_any_review_id": "R_91" if posts else None,
             "reviewer_reviews_since_items": [{"id": post["id"], "state": post["state"], "commit": head,
                                               "submitted_at": api.utc_stamp(clock + 1)} for post in posts]}
    if reads > 1:
        if mode == "pending":
            facts["reviewer_pending_reviews"] = 1
        if mode == "missing_inventory":
            del facts["reviewer_reviews_since_items"]
        if mode == "changed_inventory":
            facts.update(reviewer_reviews_since_items=[{"id": 99}], reviewer_reviews_since=1)
        if mode == "contradictory_counters":
            facts["reviewer_reviews_since"] = 1
        if mode == "wrong_target":
            facts["pull_number"] = 22
    return SimpleNamespace(returncode=0, stderr="", stdout=json.dumps(facts))


def ask(*args):
    if mode == "lost_ack":
        return json.dumps({"action": "reviewed_clean" if behavior == "pr_review" else "approve",
                           "comments": [], "assessment": assessment})
    if mode in {"missing_artifact", "submitting"}:
        with api.db() as conn:
            conn.execute("update calls set artifact=?", (None if mode == "missing_artifact" else json.dumps({"phase": "submitting_review"}),))
    raise review_budget.ReviewLimitError("analysis deadline", "review_budget_exhausted",
        diagnostic_envelope(operation="provider.review", phase="provider_execution", outcome="timed_out",
                            timeout_seconds=1, submission="none"))


def review(pwd, pr, actor, head, note, seconds, p, *, model, **kwargs):
    review_receipt.prepare_response(packet, model)
    return structured_review.run(pwd, "Review", "Pinned packet", CATALOG.resolve(model), behavior, pr, actor, head,
                                 seconds, packet=packet)


with tempfile.TemporaryDirectory() as root:
    api.DB, api.RESPONSES = Path(root) / "calls.sqlite3", Path(root) / "responses"
    api.init_db()
    with patch.object(api, "time", return_value=clock), patch.object(review_receipt.time, "time", return_value=clock), \
            patch.object(api.subprocess, "run", side_effect=command), patch.object(pr_review, "run", side_effect=review), \
            patch.object(pr_approve, "run", side_effect=review), patch.object(api, "sleep"), \
            patch.dict(structured_review.ASK, {"codex": ask}), \
            patch.object(structured_review, "ReviewWatch",
                       return_value=nullcontext(SimpleNamespace(check_closed=lambda: None))), \
            patch.object(structured_review.resource_ownership, "temporary_directory", side_effect=tempfile.TemporaryDirectory), \
            patch.object(sys, "argv", ["agent-interface", *argv]), redirect_stdout(io.StringIO()):
        try:
            api._main()
        except SystemExit as error:
            assert error.code == 1
    pending, = api.logs()
    # Stand in only for positive physical cleanup; the action fields still
    # pass through the production finalizer after the Caller result.
    with api.db() as conn:
        conn.execute("update calls set resources_settled_at=?", (clock + 3,))
        api.mark_managed_no_write(conn, pending["id"])
    released, = api.logs()
    print(json.dumps({"pending": pending, "released": released, "posts": posts}))
