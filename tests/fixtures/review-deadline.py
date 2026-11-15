"""Real Caller completion with isolated provider, GitHub and resource witnesses."""
import io
import json
import shutil
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
resumed = "--resume-review" in argv
head = argv[argv.index("--expected-head") + 1]
actor = argv[argv.index("--actor") + 1]
behavior = "pr_review" if argv[0] == "--pr-review" else "pr_approve"
clock = data["now"] / 1000
posts = []
reads = 0
assessment = {"verdict": "Inspected the affected behavior and found no blocking defects.",
              "reviewed_context": "Read the pinned diff and its affected callers.", "limitations": "Isolated regression fixture."}
packet = json.dumps({"repository": "example/repo", "pull_number": 21, "head_sha": head,
                     "coverage": "complete", "files": [{"filename": "src/fixture.py"}],
                     "diff": "diff --git a/src/fixture.py b/src/fixture.py\n--- /dev/null\n+++ b/src/fixture.py\n"
                             "@@ -0,0 +1,2 @@\n+contract = 'value'\n+consumer(contract)",
                     "pull": {"base": {"sha": "b" * 40}, "title": "Candidate", "body": ""}})


def command(args, **kwargs):
    global reads
    if args[1] in {"--reviewed-clean", "--approve-pr"}:
        if mode == "conversation_blocked":
            assert args[1] == "--approve-pr"
            return SimpleNamespace(returncode=1, stdout="",
                                   stderr="error: 1 unresolved review conversation(s) from other reviewers remain")
        response = review_receipt.retained_response()
        body = review_receipt.begin_submission(assessment["verdict"], head)
        posts.append({"id": 91, "invocation": response["invocation_id"], "head": head,
                      "state": "COMMENTED" if behavior == "pr_review" else "APPROVED",
                      "response": response, "submittedAt": data["now"] + 1000, "body": body})
        raise api.subprocess.TimeoutExpired(args, kwargs["timeout"])
    if "--manifest-only" in args:
        return SimpleNamespace(returncode=0, stderr="", stdout=packet)
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
    if mode in {"lost_ack", "lost_ack_resumed", "conversation_blocked"}:
        verdict = {"action": "reviewed_clean" if behavior == "pr_review" else "approve",
                   "comments": [], "assessment": assessment}
        if mode == "lost_ack_resumed":
            prompt = args[3]
            marker = "Required evidence IDs for a terminal verdict: "
            evidence = json.loads(prompt.split(marker, 1)[1].splitlines()[0]) if marker in prompt else []
            verdict.update(requests=[], evidence=evidence)
        return json.dumps(verdict)
    if mode in {"missing_artifact", "submitting"}:
        with api.db() as conn:
            conn.execute("update calls set artifact=?", (None if mode == "missing_artifact" else json.dumps({"phase": "submitting_review"}),))
    raise review_budget.ReviewLimitError("analysis deadline", "review_budget_exhausted",
        diagnostic_envelope(operation="provider.review", phase="provider_execution", outcome="timed_out",
                            timeout_seconds=1, submission="none"))


repository = SimpleNamespace(diff_packet=lambda value, *_args, **_kwargs: value,
                             inspect=lambda requests, **_kwargs: {"action": "review_context", "head_sha": head, "results": []})


def review(pwd, pr, actor, head, note, seconds, p, *, model, **kwargs):
    review_receipt.prepare_response(packet, model)
    return structured_review.run(pwd, "Review", "Pinned packet", CATALOG.resolve(model), behavior, pr, actor, head,
                                 seconds, packet=packet,
                                 **({"repository": repository} if mode == "lost_ack_resumed" else {}))


real_stage = structured_review.progress.stage


def stage(name, *args, **kwargs):
    if mode == "lost_ack_resumed" and not resumed and name == "submitting":
        raise review_budget.ReviewLimitError("pre-reservation deadline", "review_budget_exhausted")
    return real_stage(name, *args, **kwargs)


with tempfile.TemporaryDirectory() as root:
    if mode == "lost_ack_resumed" and resumed:
        original = argv[argv.index("--resume-review") + 1].split(":")[0]
        stash = Path(tempfile.gettempdir()) / f"poise-resume-{original}"
        for child in stash.iterdir():
            target = Path(root) / child.name
            if child.is_dir():
                shutil.copytree(child, target)
            else:
                shutil.copy2(child, target)
        shutil.rmtree(stash, ignore_errors=True)
    api.DB, api.RESPONSES = Path(root) / "calls.sqlite3", Path(root) / "responses"
    api.init_db()
    with patch.object(api, "time", return_value=clock), patch.object(review_receipt.time, "time", return_value=clock), \
            patch.object(api.subprocess, "run", side_effect=command), patch.object(pr_review, "run", side_effect=review), \
            patch.object(pr_approve, "run", side_effect=review), patch.object(api, "sleep"), \
            patch.dict(structured_review.ASK, {"codex": ask}), \
            patch.object(structured_review.progress, "stage", side_effect=stage), \
            patch.object(structured_review, "ReviewWatch",
                       return_value=nullcontext(SimpleNamespace(check_closed=lambda: None))), \
            patch.object(structured_review.resource_ownership, "temporary_directory", side_effect=tempfile.TemporaryDirectory), \
            patch.object(sys, "argv", ["agent-interface", *argv]), redirect_stdout(io.StringIO()):
        try:
            api._main()
        except SystemExit as error:
            assert error.code == 1
    if mode == "lost_ack_resumed" and resumed:
        original = argv[argv.index("--resume-review") + 1].split(":")[0]
        pending = next(call for call in api.logs() if call["id"] != original)
    else:
        pending, = api.logs()
    # Stand in only for positive physical cleanup; the action fields still
    # pass through the production finalizer after the Caller result.
    with api.db() as conn:
        conn.execute("update calls set resources_settled_at=?", (clock + 3,))
        api.mark_managed_no_write(conn, pending["id"])
    released = next(call for call in api.logs() if call["id"] == pending["id"])
    if mode == "lost_ack_resumed" and not resumed:
        stash = Path(tempfile.gettempdir()) / f"poise-resume-{pending['id']}"
        shutil.rmtree(stash, ignore_errors=True)
        shutil.copytree(root, stash)
    print(json.dumps({"pending": pending, "released": released, "posts": posts}))
