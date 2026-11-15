"""Caller protocol proof; providers and GitHub writes are isolated stand-ins."""
import json
import io
import sqlite3
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, contextmanager, nullcontext, redirect_stdout
from pathlib import Path
from threading import Barrier
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch
from uuid import uuid4

import agent_interface as api
from agent_interface import atoms, issue_review, pr_approve, review_budget, review_continuation as continuation, \
    review_receipt, review_repository, review_stages, structured_review
from agent_interface.model_catalog import CATALOG
from github_interface.atoms.review_response import qualifying_response
from review_submission_fixture import submission_args

HEAD, BASE = "a" * 40, "b" * 40
MODEL = CATALOG.resolve("gpt-6-astra-ultra")
ASSESSMENT = {"verdict": "Verified the supplied change and all required cross-unit contracts.",
              "reviewed_context": "Inspected the pinned diff, required source pages and unit boundaries.",
              "limitations": "Isolated protocol proof; no application tests run by the reviewer."}


def packet(count=1):
    names = [f"src/f{index:03d}.py" for index in range(count)]
    return {"repository": "o/r", "pull_number": 12, "head_sha": HEAD,
            "pull": {"base": {"sha": BASE}, "title": "Continuation regression", "body": "Review context"},
            "merge_base_sha": BASE, "files": [{"filename": name} for name in names],
            "linked_issues": [],
            "excluded_files": [{"path": "data.zip", "reason": "archive payload"}], "coverage": "complete",
            "diff": "\n".join(f"diff --git a/{name} b/{name}\n--- /dev/null\n+++ b/{name}\n"
                               "@@ -0,0 +1,2 @@\n+contract = 'value'\n+consumer(contract)" for name in names)}


def supplied(prompt):
    return json.JSONDecoder().raw_decode(prompt.split("PR packet:\n", 1)[1])[0]


def verdict(prompt, comments=(), requests=()):
    evidence = json.loads(prompt.split("Required evidence IDs for a terminal verdict: ", 1)[1].splitlines()[0])
    return json.dumps({"action": "inspect" if requests else "request_changes" if comments else "reviewed_clean",
                       "comments": list(comments), "assessment": ASSESSMENT, "requests": list(requests),
                       "evidence": [] if requests else evidence})


class TestReviewContinuation(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(api, "DB", Path(self.directory.name) / "calls.sqlite3"))
        self.stack.enter_context(patch.object(api, "RESPONSES", Path(self.directory.name) / "responses"))
        api.init_db()
        self.clock = SimpleNamespace(now=0.0)
        for module in (review_budget, structured_review, continuation):
            self.stack.enter_context(patch.object(module, "monotonic", lambda: self.clock.now))
        self.stack.enter_context(patch.object(structured_review, "ReviewWatch", return_value=nullcontext(
            SimpleNamespace(check_closed=lambda: None))))
        # The fixture binds a native-source Call in this process, so cleanup
        # takes the legacy host-wide process scan; an unreadable runner-owned
        # /proc entry must not fail settlement. Production keeps its
        # fail-closed scan; allocation, physical cleanup and receipts stay real.
        self.stack.enter_context(patch.object(issue_review, "_cwd_pids", return_value=[]))
        self.posts = []
        self.stack.enter_context(patch.object(structured_review.subprocess, "run", side_effect=self.submit))
        self.repository = SimpleNamespace(diff_packet=lambda value, _limit, **_kwargs: value, inspect=self.inspect)
        self.inspections = []

    def inspect(self, requests, *, timeout_s):
        self.inspections.extend(requests)
        return {"action": "review_context", "head_sha": HEAD, "results": [
            {"request": request, "lines": [{"line": request["start_line"], "text": "pinned evidence"}],
             "truncated": False, "next_line": None} for request in requests]}

    def submit(self, command, **_kwargs):
        database, call_id = review_receipt._call.get()
        with review_receipt.invocation_environment(database, call_id, True, initialize=False):
            body = review_receipt.begin_submission("Verified final verdict", HEAD)
        self.posts.append((submission_args(command), body))
        return SimpleNamespace(returncode=0, stderr="", stdout=json.dumps(
            {"action": "requested_changes" if "--request-changes" in command else "approved_pr" if "--approve-pr" in command else "reviewed_clean",
             "review_id": 91, "head_sha": HEAD}))

    @contextmanager
    def call(self, node, resume=None, slot="sol", policy="policy", behavior="pr_review"):
        call_id = api.track(MODEL.identity, "", "12", "o/r", "reviewer", behavior,
                            expected_head=HEAD, source="poise:behavior-chain")
        review_receipt.bind(api.DB, call_id)
        with review_budget.ReviewBudget(), review_receipt.invocation_environment(api.DB, call_id, True), \
                continuation.request(slot, resume):
            review_receipt.prepare_response(json.dumps(node), MODEL.identity, policy=policy)
            try:
                yield call_id
            finally:
                api.resource_ownership.cleanup_remaining(api.DB, call_id)
                with sqlite3.connect(api.DB) as conn:
                    conn.execute("update calls set status='failed', resources_settled_at=1 where id=?", (call_id,))

    def run_review(self, node, ask, behavior="pr_review", **kwargs):
        raw = json.dumps(node)
        with (patch.dict(structured_review.ASK, {"codex": ask}) if ask is not None else nullcontext()):
            return structured_review.run(self.directory.name, "system", "PR packet:\n" + raw, MODEL, behavior,
                                        "https://github.com/o/r/pull/12", "reviewer", HEAD, 1413,
                                        repository=self.repository, packet=raw, **kwargs)

    def artifact(self, call):
        with sqlite3.connect(api.DB) as conn:
            return json.loads(conn.execute("select artifact from calls where id=?", (call,)).fetchone()[0])

    def saved(self, root):
        with sqlite3.connect(api.DB) as conn:
            return json.loads(conn.execute("select artifact from calls where id=?", (root,)).fetchone()[0])["review_progress"]

    def resume(self, root):
        return f"{root}:{self.saved(root)['generation']}"

    def test_twenty_two_groups_resume_a_later_deadline_and_publish_one_verified_verdict(self):
        self.later_deadline(176, 22)

    def test_twenty_two_groups_can_spend_more_than_one_call_and_publish_once(self):
        node = packet(176)
        completed = []
        unit_seconds = 68

        def ask(*args):
            prompt, timeout = args[3], args[-1]
            self.clock.now += min(timeout, unit_seconds)
            if timeout < unit_seconds:
                raise subprocess.TimeoutExpired("isolated provider", timeout)
            value = supplied(prompt)
            if "required_cross_unit_evidence" in value:
                self.assertEqual(len(value["required_cross_unit_evidence"]), 22)
                completed.append("integration")
            else:
                completed.append(value["files"][0]["filename"])
            return verdict(prompt)

        with self.call(node) as root:
            with self.assertRaises(continuation.Continuation) as stopped:
                self.run_review(node, ask)
            self.assertEqual(stopped.exception.result["outcome"], "continuation_required")
            self.assertEqual(self.saved(root)["unit"], len(completed))
            self.assertTrue(0 < len(completed) < 22)
            self.assertLessEqual(self.clock.now, review_budget.REVIEW_TIMEOUT_SECONDS - continuation.FINALIZATION_RESERVE_SECONDS)
            self.assertEqual(self.posts, [])

        with self.call(node, self.resume(root)) as publisher:
            output = self.run_review(node, ask)
            with sqlite3.connect(api.DB) as conn:
                receipt = json.loads(conn.execute("select artifact from calls where id=?", (publisher,)).fetchone()[0])
        self.assertEqual(completed, [f"src/f{i:03d}.py" for i in range(0, 176, 8)] + ["integration"])
        self.assertGreater(len(completed) * unit_seconds, review_budget.REVIEW_TIMEOUT_SECONDS)
        self.assertGreaterEqual(self.saved(root)["spent_ms"], len(completed) * unit_seconds * 1000)
        self.assertEqual(self.saved(root)["publisher"], publisher)
        self.assertEqual(receipt["review_response"]["coverage"], "complete")
        self.assertIn('"review_id": 91', output)
        self.assertEqual(len(self.posts), 1)

    def test_isomora_821_resumes_group_four_of_ten(self):
        self.later_deadline(74, 10)

    def later_deadline(self, files, groups):
        node = packet(files)
        observed, interrupted = [], False

        def ask(root, _model, _system, prompt, _schema, _watch, timeout):
            nonlocal interrupted
            # Codex, Antigravity and Muse read this file as their output
            # schema; without evidence their verdicts cannot validate.
            on_disk = json.loads((root / "verdict.schema.json").read_text())
            self.assertIn("evidence", on_disk["required"])
            self.assertIn("evidence", on_disk["properties"])
            value = supplied(prompt)
            group = value.get("review_scope", "integration")
            integration = "required_cross_unit_evidence" in value
            if not integration:
                observed.append(value["files"][0]["filename"])
            self.clock.now += 0.1 if interrupted else 1
            if f"file group 4 of {groups}" in group and not interrupted:
                interrupted = True
                self.clock.now += timeout
                raise subprocess.TimeoutExpired("isolated provider", timeout)
            return verdict(prompt)

        with self.call(node) as root:
            with self.assertRaises(continuation.Continuation) as stopped:
                self.run_review(node, ask)
            self.assertEqual(stopped.exception.result["outcome"], "continuation_required")
            self.assertEqual(self.saved(root)["unit"], 3)  # Isomora #821, group 4/10 shape.
            with self.assertRaisesRegex(RuntimeError, "complete, exclusively reserved"):
                review_receipt.complete_response(ASSESSMENT, HEAD)
            self.assertEqual(self.posts, [])
        with self.call(node, self.resume(root)) as publisher:
            output = self.run_review(node, ask)
            self.assertIn('"review_id": 91', output)
            with sqlite3.connect(api.DB) as conn:
                response = json.loads(conn.execute("select artifact from calls where id=?", (publisher,)).fetchone()[0])["review_response"]
            self.assertEqual(response["coverage"], "complete")
            self.assertEqual(response["invocation_id"], publisher)
            self.assertEqual(self.saved(root)["publisher"], publisher)
        self.assertEqual(len(self.posts), 1)
        self.assertEqual(observed.count("src/f000.py"), 1)
        self.assertEqual(observed.count("src/f024.py"), 2)
        self.assertEqual(self.saved(root)["unit"], groups + 1)

    def test_inspection_cap_carries_unfinished_position_and_provisional_findings_across_calls(self):
        # PR #1637's 12-round cap, and #841's unfinished third group, share
        # the same saved inspection protocol. Units 1 and 2 remain credited.
        node = packet(37)
        read = {"operation": "read", "path": "src/f016.py", "query": "", "start_line": 1}
        finding = {"path": "src/f016.py", "line": 2, "side": "RIGHT", "body": "[p1] Consumer uses the wrong contract."}
        finished = False

        def inspect(requests, *, timeout_s):
            nonlocal finished
            response = self.inspect(requests, timeout_s=timeout_s)
            result = response["results"][0]
            result.update(truncated=requests[0]["start_line"] < 14,
                          next_line=requests[0]["start_line"] + 1 if requests[0]["start_line"] < 14 else None)
            finished = not result["truncated"]
            return response

        self.repository.inspect = inspect
        calls = []

        def ask(_root, _model, _system, prompt, *_args):
            value = supplied(prompt)
            if "file group 3 of 5" in value.get("review_scope", ""):
                pending = json.loads(prompt.split("Required unfinished inspection requests: ", 1)[1].splitlines()[0])
                request = pending or [read]
                calls.append(request[0]["start_line"])
                if request[0]["start_line"] <= 14:
                    return verdict(prompt, [finding], request)
            return verdict(prompt)

        with self.call(node) as root:
            with self.assertRaises(continuation.Continuation):
                self.run_review(node, ask)
            self.assertEqual(self.saved(root)["unit"], 2)
        with self.call(node, self.resume(root)):
            # The second Call starts at page 13, then reaches the terminal
            # verdict only after the pending page has completed.
            self.run_review(node, lambda *args: verdict(args[3]) if finished else ask(*args))
        self.assertEqual(calls[:13], list(range(1, 14)))
        self.assertEqual([request["start_line"] for request in self.inspections], list(range(1, 15)))
        command = self.posts[0][0]
        self.assertEqual(json.loads(command[command.index("--comments") + 1]), [finding])

    def test_changed_answer_revision_same_head_and_changed_policy_invalidate_progress(self):
        node = packet()
        node.update(verification_candidates=[17], review_threads=[{"root_comment_id": 17, "id": "thread",
                    "repair_answer": {"revision": "answer-v1", "body": "Fixed the caller"}}])
        with self.call(node) as root:
            session = continuation.Session(json.dumps(node), MODEL.identity)
            session.initialize(self.repository)
            session.state["verified"] = session.verified([17])
            session.checkpoint()
            with self.assertRaises(continuation.Continuation):
                session.pause("inspection checkpoint committed before acknowledgement")
        for changed, policy, slot in ((node, "changed policy", "sol"), (node, "policy", "other-slot"),
                                      (json.loads(json.dumps(node)), "policy", "sol")):
            if changed is not node:
                changed["review_threads"][0]["repair_answer"].update(revision="answer-v2", body="Different repair")
            with self.subTest(policy=policy, slot=slot), self.call(changed, self.resume(root), slot, policy):
                with self.assertRaisesRegex(continuation.Continuation, "material review basis changed"):
                    continuation.Session(json.dumps(changed), MODEL.identity)
        self.assertEqual(self.posts, [])

    def test_two_distinct_claimants_cannot_spend_or_overwrite_the_same_generation(self):
        node = packet()
        with self.call(node) as root:
            first = continuation.Session(json.dumps(node), MODEL.identity)
            first.initialize(self.repository)
            first.checkpoint()  # Simulate commit followed by loss of acknowledgement.
        resume = self.resume(root)
        ids = [api.track(MODEL.identity, "", "12", "o/r", "reviewer", "pr_review",
                         expected_head=HEAD, source="poise:behavior-chain") for _ in range(2)]
        for call_id in ids:
            review_receipt.bind(api.DB, call_id)
            with review_receipt.invocation_environment(api.DB, call_id, True), continuation.request("sol", resume):
                review_receipt.prepare_response(json.dumps(node), MODEL.identity, policy="policy")
        barrier = Barrier(2)
        finding = {"path": "src/f000.py", "line": 2, "side": "RIGHT", "body": "[p1] Winner retained this contract defect."}

        def ask(*args):
            before = self.saved(root)
            first.state["provisional"] = [{"kept": "stale worker"}]
            with self.assertRaisesRegex(continuation.Continuation, "stale review claimant"):
                first.checkpoint()  # Old worker result arrives after the winner's claim.
            self.assertEqual(self.saved(root), before)
            return verdict(args[3], [finding])

        def race(call_id):
            review_receipt.bind(api.DB, call_id)
            with continuation.request("sol", resume):
                barrier.wait(timeout=5)
                try:
                    self.run_review(node, None)
                    return "published"
                except continuation.Continuation:
                    return "held"

        with patch.dict(structured_review.ASK, {"codex": ask}), ThreadPoolExecutor(max_workers=2) as workers:
            outcomes = list(workers.map(race, ids))
        self.assertEqual(sorted(outcomes), ["held", "published"])
        self.assertEqual(len(self.posts), 1)
        command = self.posts[0][0]
        self.assertEqual(json.loads(command[command.index("--comments") + 1]), [finding])
        self.assertIn(self.saved(root)["publisher"], ids)

    def test_lost_publication_ack_keeps_the_original_publisher_fence(self):
        node = packet()
        attempts = []

        def lost_ack(command, **_kwargs):
            body = review_receipt.begin_submission("Original verdict", HEAD)
            attempts.append(body)
            raise subprocess.TimeoutExpired(command, 10)

        with self.call(node) as root:
            with patch.object(structured_review.subprocess, "run", side_effect=lost_ack):
                with self.assertRaises(review_receipt.SubmissionError):
                    self.run_review(node, lambda *_args: verdict(_args[3]))
        original = self.saved(root)
        self.assertEqual(original["publisher"], root)
        response = self.artifact(root)["review_response"]
        state = {"repository": "o/r", "pull_number": 12, "head_sha": HEAD, "review_context": response["context_sha"],
                 "my_reviews": [{"id": 91, "state": "COMMENTED", "commit_id": HEAD,
                    "submitted_at": api.utc_stamp(api.time()), "invocation_id": root, "review_response": response}]}

        def reconcile(command, **_kwargs):
            self.assertIn("--pull-action-state", command)
            return SimpleNamespace(returncode=0, stdout=json.dumps(state), stderr="")

        original_state = json.loads(json.dumps(state))
        for mismatch in ("sibling", "altered_response", "missing"):
            state = json.loads(json.dumps(original_state))
            if mismatch == "sibling":
                state["my_reviews"][0]["invocation_id"] = "d" * 32
            elif mismatch == "altered_response":
                state["my_reviews"][0]["review_response"]["assessment"]["verdict"] = "Another Call's verdict"
            else:
                state["my_reviews"] = []
            with self.subTest(mismatch=mismatch), self.call(node, self.resume(root)), \
                    patch.object(structured_review.subprocess, "run", side_effect=reconcile):
                with self.assertRaisesRegex(continuation.Continuation, "original review publication"):
                    self.run_review(node, lambda *_: self.fail("unattributed review repeated analysis"))
        state = original_state
        with self.call(node, self.resume(root)), patch.object(structured_review.subprocess, "run", side_effect=reconcile):
            output = self.run_review(node, lambda *_args: self.fail("uncertain publication must not launch a provider"))
            self.assertIn('"review_id": 91', output)
            self.assertEqual(review_receipt.get()["review_response"], response)
        self.assertEqual(self.saved(root)["publisher"], original["publisher"])
        self.assertEqual(len(attempts), 1)

    def test_large_completed_review_resumes_only_its_unfinished_remap_or_submission(self):
        node = packet(176)
        path = "src/f175.py"
        since = (f"diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n"
                 "@@ -10,3 +10,2 @@\n context\n-removed\n context2")
        full = (f"diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n"
                "@@ -4,3 +10,3 @@\n context\n-removed\n+added\n context2")
        node.update(since_head_sha="c" * 40, p="p2")
        node["diff"] = node["diff"].split(f"diff --git a/{path}", 1)[0] + since
        finding = {"path": path, "line": 11, "side": "LEFT", "body": "[p1] Removed contract still has a consumer."}
        original_validate = structured_review._validate_since_positions

        for boundary in ("remap", "ready"):
            with self.subTest(boundary=boundary):
                calls = []

                def ask(*args):
                    prompt = args[3]
                    calls.append(prompt)
                    return verdict(prompt, [finding] if path in supplied(prompt)["diff"] else [])

                def validate(*args):
                    if boundary == "remap":
                        raise review_budget.ReviewLimitError("pre-write remap deadline", "review_budget_exhausted")
                    return original_validate(*args)

                def before_submission(phase, *_args, **_kwargs):
                    if phase == "submitting":
                        raise review_budget.ReviewLimitError("pre-write submission deadline", "review_budget_exhausted")

                with self.call(node, policy=boundary, slot=boundary) as root, \
                        patch.object(structured_review, "fetch_packet", return_value=json.dumps({**node, "diff": full})), \
                        patch.object(structured_review, "_validate_since_positions", side_effect=validate), \
                        patch.object(structured_review.progress, "stage", side_effect=before_submission):
                    with self.assertRaises(continuation.Continuation) as stopped:
                        self.run_review(node, ask)
                    self.assertEqual(stopped.exception.result["outcome"], "continuation_required")
                    self.assertEqual(self.saved(root)["finalization"]["step"], boundary)
                    response = self.artifact(root)["review_response"]
                self.assertEqual(len(calls), 23)
                posts_before = len(self.posts)
                with self.call(node, self.resume(root), policy=boundary, slot=boundary) as resumed, \
                        patch.object(structured_review, "fetch_packet", return_value=json.dumps({**node, "diff": full})) as fetch:
                    self.run_review(node, lambda *_: self.fail("finalization repeated provider analysis"))
                    retained = self.artifact(resumed)["review_response"]
                    self.assertEqual(retained, response)
                    self.assertTrue(qualifying_response(retained, node["pull"], "o/r", 12, HEAD, "reviewer"))
                    self.assertEqual(fetch.call_count, 1 if boundary == "remap" else 0)
                self.assertEqual(len(self.posts), posts_before + 1)
                command, body = self.posts[-1]
                self.assertEqual(json.loads(command[command.index("--comments") + 1]), [{**finding, "line": 5}])
                self.assertTrue(body.endswith(f"<!-- poise-invocation {root} -->"))
                self.assertEqual(self.saved(root)["publisher"], root)

    def test_capped_followup_receipt_or_lost_ack_survives_a_deadline_before_approval(self):
        finding = {"path": "src/f000.py", "line": 2, "side": "RIGHT", "body": "[p1] Optional caller uses the wrong contract."}
        for lost_ack in (False, True):
            node = packet()
            created, approvals = [], []

            def post(command, **kwargs):
                if "--create-pr-linked-issue" in command:
                    issue = {"number": 18, "html_url": "https://github.com/o/r/issues/18", "user": {"login": "reviewer"},
                             "title": command[command.index("--title") + 1],
                             "body": command[command.index("--body") + 1].strip() + "\n\nRelated PR: https://github.com/o/r/pull/12"}
                    created.append(issue)
                    if lost_ack:
                        raise subprocess.TimeoutExpired(command, kwargs["timeout"])
                    return SimpleNamespace(returncode=0, stderr="", stdout=json.dumps(
                        {"action": "created_pr_linked_issue", "issue": issue}))
                approvals.append(command)
                return self.submit(command, **kwargs)

            def deadline(phase, *_args, **_kwargs):
                if phase == "submitting":
                    raise review_budget.ReviewLimitError("pre-write approval deadline", "review_budget_exhausted")

            policy = f"capped-{lost_ack}"
            cap = {"behavior": "pr_approve", "capped": True, "review_round": 5, "review_cap": 5}
            with self.subTest(lost_ack=lost_ack), self.call(node, policy=policy, slot=policy, behavior="pr_approve") as root, \
                    patch.object(structured_review.subprocess, "run", side_effect=post), \
                    patch.object(structured_review.progress, "stage", side_effect=deadline):
                with self.assertRaises(review_receipt.SubmissionError if lost_ack else continuation.Continuation):
                    self.run_review(node, lambda *args: verdict(args[3], [finding]), **cap)
                self.assertEqual(self.artifact(root)["phase"], "filing_followup")
            self.assertEqual(len(created), 1)
            self.assertEqual(approvals, [])
            if lost_ack:
                with self.call(node, self.resume(root), policy=policy, slot=policy, behavior="pr_approve"), \
                        patch.object(structured_review.subprocess, "run", side_effect=post):
                    with self.assertRaisesRegex(continuation.Continuation, "original follow-up creation is uncertain"):
                        self.run_review(node, lambda *_: self.fail("lost issue acknowledgement repeated analysis"), **cap)
            node["linked_issues"] = created
            with self.call(node, policy=policy, slot=policy, behavior="pr_approve"):
                with self.assertRaisesRegex(continuation.Continuation, "saved review already exists"):
                    self.run_review(node, lambda *_: self.fail("omitting resume replayed a follow-up effect"), **cap)
            with self.call(node, self.resume(root), policy=policy, slot=policy, behavior="pr_approve"), \
                    patch.object(structured_review.subprocess, "run", side_effect=post):
                output = self.run_review(node, lambda *_: self.fail("completed capped review repeated analysis"), **cap)
                self.assertIn('"review_id": 91', output)
            self.assertEqual(len(created), 1)
            self.assertEqual(len(approvals), 1)
            self.assertIn("--approve-pr", approvals[0])
            self.assertIn(f"<!-- poise-invocation {root} -->", created[0]["body"])
            self.assertTrue(self.posts[-1][1].endswith(f"<!-- poise-invocation {root} -->"))

    def test_capped_approval_entry_hydrates_manifest_coverage_before_deferring_findings(self):
        node = packet()
        node.update(coverage="incomplete", diff_deferred=True)
        finding = {"path": "src/f000.py", "line": 2, "side": "RIGHT", "body": "[p1] Optional caller uses the wrong contract."}
        repository = SimpleNamespace(prompt=lambda: "", inspect=self.inspect,
            diff_packet=lambda value, _limit, **_kwargs: json.dumps({**json.loads(value), "coverage": "complete", "diff_deferred": False}))
        creations = []

        def post(command, **kwargs):
            if "--create-pr-linked-issue" in command:
                creations.append(command)
                return SimpleNamespace(returncode=0, stderr="", stdout=json.dumps({"action": "created_pr_linked_issue",
                    "issue": {"number": 18, "html_url": "https://github.com/o/r/issues/18"}}))
            return self.submit(command, **kwargs)

        with self.call(node, behavior="pr_approve"), patch.object(atoms, "last_reviewed_head", return_value=None), \
                patch.object(atoms, "packet", return_value=json.dumps(node)), \
                patch.object(review_repository, "prepare", return_value=nullcontext(repository)), \
                patch.dict(structured_review.ASK, {"codex": lambda *args: verdict(args[3], [finding])}), \
                patch.object(structured_review.subprocess, "run", side_effect=post):
            pr_approve.run(self.directory.name, "https://github.com/o/r/pull/12", "reviewer", HEAD,
                           model=MODEL.identity, capped=True, review_round=5, review_cap=5)
        self.assertEqual(len(creations), 1)
        self.assertIn("--approve-pr", self.posts[0][0])

    def test_completed_finalization_refuses_changed_basis_altered_result_and_unreleased_worker(self):
        node = packet()

        def deadline(phase, *_args, **_kwargs):
            if phase == "submitting":
                raise review_budget.ReviewLimitError("pre-write deadline", "review_budget_exhausted")

        with self.call(node) as root, patch.object(structured_review.progress, "stage", side_effect=deadline):
            with self.assertRaises(continuation.Continuation):
                self.run_review(node, lambda *args: verdict(args[3]))
        for field in ("head_sha", "title", "body", "coverage"):
            changed = json.loads(json.dumps(node))
            if field in {"title", "body"}:
                changed["pull"][field] = "Changed context"
            else:
                changed[field] = "d" * 40 if field == "head_sha" else "incomplete"
            with self.subTest(field=field), self.call(changed, self.resume(root)):
                with self.assertRaisesRegex(continuation.Continuation, "material review basis changed"):
                    self.run_review(changed, lambda *_: self.fail("changed basis launched analysis"))
        with sqlite3.connect(api.DB) as conn:
            conn.execute("update calls set resources_settled_at=null where id=?", (root,))
        with self.call(node, self.resume(root)):
            with self.assertRaisesRegex(continuation.Continuation, "has not released its resources"):
                self.run_review(node, lambda *_: self.fail("unreleased worker launched analysis"))
        with sqlite3.connect(api.DB) as conn:
            conn.execute("update calls set resources_settled_at=1 where id=?", (root,))
        reference = self.saved(root)["finalization"]["verdict"]
        (api.RESPONSES / f"{reference['id']}.txt").write_text("{}")
        with self.call(node, self.resume(root)):
            with self.assertRaisesRegex(continuation.Continuation, "digest or length differs"):
                self.run_review(node, lambda *_: self.fail("altered retained verdict launched analysis"))
        self.assertEqual(self.posts, [])

    def test_completed_finalization_cannot_spend_its_cumulative_verification_reserve(self):
        node = packet()

        def deadline(phase, *_args, **_kwargs):
            if phase == "submitting":
                raise review_budget.ReviewLimitError("pre-write deadline", "review_budget_exhausted")

        with self.call(node) as root, patch.object(structured_review.progress, "stage", side_effect=deadline):
            with self.assertRaises(continuation.Continuation):
                self.run_review(node, lambda *args: verdict(args[3]))
        artifact = self.artifact(root)
        saved = artifact["review_progress"]
        saved["spent_ms"] = saved["allowance_ms"] - structured_review.VERIFICATION_RESERVE_SECONDS * 1000
        with sqlite3.connect(api.DB) as conn:
            conn.execute("update calls set artifact=? where id=?", (json.dumps(artifact), root))
        with self.call(node, self.resume(root)):
            with self.assertRaisesRegex(continuation.Continuation, "cumulative review time allowance exhausted"):
                self.run_review(node, lambda *_: self.fail("exhausted finalization repeated analysis"))
        self.assertEqual(self.saved(root)["phase"], "held")
        self.assertEqual(self.posts, [])

    def test_completed_101_finding_review_is_held_with_every_finding_retained(self):
        node = packet(101)

        def ask(*args):
            source = supplied(args[3])
            comments = [] if "required_cross_unit_evidence" in source else [
                {"path": entry["filename"], "line": 2, "side": "RIGHT", "body": f"[p1] Broken consumer in {entry['filename']}"}
                for entry in source["files"]]
            return verdict(args[3], comments)

        with self.call(node) as root:
            with self.assertRaisesRegex(continuation.Continuation, "101 findings"):
                self.run_review(node, ask)
        self.assertEqual(self.saved(root)["phase"], "held")
        reference = self.saved(root)["finalization"]["verdict"]
        retained = json.loads((api.RESPONSES / f"{reference['id']}.txt").read_text())
        self.assertEqual(len(retained["comments"]), 101)
        with self.call(node, self.resume(root)):
            with self.assertRaisesRegex(continuation.Continuation, "101 findings"):
                self.run_review(node, lambda *_: self.fail("held verdict repeated analysis"))
        self.assertEqual(self.posts, [])

    def test_released_analysis_keeps_its_publication_owner_while_competing_finalizers_claim_once(self):
        node = packet(9)

        def deadline(phase, *_args, **_kwargs):
            if phase == "submitting":
                raise review_budget.ReviewLimitError("pre-write deadline", "review_budget_exhausted")

        with self.call(node) as root, patch.object(structured_review.progress, "stage", side_effect=deadline):
            with self.assertRaises(continuation.Continuation):
                self.run_review(node, lambda *args: verdict(args[3]))
        pending = self.saved(root)
        self.assertEqual(pending["owner"], root)
        self.assertTrue(pending["complete"])
        # Released physical resources do not retire the publication obligation.
        # Another eligible slot can reserve and release its own workspace.
        with self.call(node, slot="unrelated"):
            with api.resource_ownership.temporary_directory(prefix="unrelated-review-"):
                self.assertEqual(self.saved(root), pending)
        resume = self.resume(root)
        ids = [api.track(MODEL.identity, "", "12", "o/r", "reviewer", "pr_review", expected_head=HEAD,
                         source="poise:behavior-chain") for _ in range(2)]
        for call_id in ids:
            review_receipt.bind(api.DB, call_id)
            with review_receipt.invocation_environment(api.DB, call_id, True), continuation.request("sol", resume):
                review_receipt.prepare_response(json.dumps(node), MODEL.identity, policy="policy")
        barrier = Barrier(2)

        def race(call_id):
            review_receipt.bind(api.DB, call_id)
            with continuation.request("sol", resume):
                barrier.wait(timeout=5)
                try:
                    self.run_review(node, lambda *_: self.fail("competing finalizer repeated analysis"))
                    return "published"
                except continuation.Continuation:
                    return "held"

        with ThreadPoolExecutor(max_workers=2) as workers:
            self.assertEqual(sorted(workers.map(race, ids)), ["held", "published"])
        self.assertEqual(len(self.posts), 1)
        self.assertEqual(self.saved(root)["publisher"], root)
        self.assertTrue(self.posts[0][1].endswith(f"<!-- poise-invocation {root} -->"))

    def test_legacy_and_native_entry_points_reconcile_the_original_review_already_in_their_inventory(self):
        for native in (False, True):
            node = packet()
            policy = f"entry-{native}"

            def lost_ack(command, **kwargs):
                review_receipt.begin_submission("Original verdict", HEAD)
                raise subprocess.TimeoutExpired(command, kwargs["timeout"])

            with self.subTest(native=native), self.call(node, policy=policy, slot=policy) as root, \
                    patch.object(structured_review.subprocess, "run", side_effect=lost_ack):
                with self.assertRaises(review_receipt.SubmissionError):
                    self.run_review(node, lambda *args: verdict(args[3]))
            response = self.artifact(root)["review_response"]
            submitted = api.utc_stamp(api.time())
            review_id = 91 + int(native)
            inventory = {"id": review_id, "state": "COMMENTED", "commit": HEAD, "submitted_at": submitted}
            facts = {"repository": "o/r", "pull_number": 12, "state": "OPEN", "draft": False, "head_sha": HEAD,
                     "reviewer_reviews_since_items": [inventory], "review_context": response["context_sha"]}
            state = {**facts, "my_reviews": [{"id": review_id, "state": "COMMENTED", "commit_id": HEAD,
                      "submitted_at": submitted, "invocation_id": root, "review_response": response}]}

            def read(command, **_kwargs):
                self.assertIn("--pull-action-state", command)
                return SimpleNamespace(returncode=0, stdout=json.dumps(state), stderr="")

            def execute(*_args, **_kwargs):
                review_receipt.prepare_response(json.dumps(node), MODEL.identity, policy=policy)
                return self.run_review(node, lambda *_: self.fail("entry point repeated completed analysis"))

            def boundary(call_id, _correlation):
                # Kernel-boundary stand-in; routing, native receipts, generation
                # fencing and actual registered-directory cleanup remain real.
                with sqlite3.connect(api.DB) as conn:
                    conn.execute("update calls set resource_ownership=? where id=?",
                                 (api.resource_ownership.initial(), call_id))

            correlation = uuid4().hex
            with patch.object(api, "review_facts", return_value=facts), \
                    patch.object(api.pr_review, "run", side_effect=execute), \
                    patch.object(structured_review.subprocess, "run", side_effect=read), \
                    patch.object(api, "_enter_native_call", side_effect=boundary), redirect_stdout(io.StringIO()):
                if native:
                    argv = ["agent-interface", "--pr-review", "https://github.com/o/r/pull/12", "--actor", "reviewer",
                            "--expected-head", HEAD, "--source", "poise:behavior-chain", "--correlation-id", correlation,
                            "--model", MODEL.identity, "--review-slot", policy, "--resume-review", self.resume(root),
                            "--pwd", self.directory.name]
                    with patch.object(sys, "argv", argv):
                        api.main()
                else:
                    api.run_pr_review("https://github.com/o/r/pull/12", "reviewer", HEAD, "poise:behavior-chain", correlation,
                                      pwd=self.directory.name, model=MODEL.identity, review_slot=policy, resume_review=self.resume(root))
            with sqlite3.connect(api.DB) as conn:
                row = conn.execute("select status,outcome,artifact,resources_settled_at from calls where correlation_id=?",
                                   (correlation,)).fetchone()
            self.assertEqual(row[:2], ("completed", "clean"))
            self.assertEqual(json.loads(row[2])["review_response"], response)
            if native:
                self.assertIsNotNone(row[3])
        self.assertEqual(self.posts, [])

    def test_missing_evidence_and_storage_exhaustion_never_clear_a_review(self):
        node = packet()
        for kind in ("missing", "malformed", "storage"):
            with self.subTest(kind=kind), self.call(node, policy=kind) as root:
                session = continuation.Session(json.dumps(node), MODEL.identity)
                session.initialize(self.repository)
                if kind in {"missing", "malformed"}:
                    reference = session.manifest["units"][0]
                    target = api.RESPONSES / f"{reference['id']}.txt"
                    if kind == "missing":
                        target.unlink()
                    else:
                        target.write_text("{}")
                    with self.assertRaisesRegex(continuation.Continuation, "evidence"):
                        session.read(reference)
                else:
                    with patch.object(continuation, "MAX_STORAGE_BYTES", self.saved(root)["retained_bytes"]):
                        with self.assertRaisesRegex(continuation.Continuation, "storage allowance"):
                            session.put("another allocation")
                with self.assertRaises(RuntimeError):
                    review_receipt.complete_response(ASSESSMENT, HEAD)
        self.assertEqual(self.posts, [])

    def test_cumulative_time_exhaustion_retains_interrupted_charges_across_calls(self):
        node = packet(176)
        call_seconds = review_budget.REVIEW_TIMEOUT_SECONDS - continuation.FINALIZATION_RESERVE_SECONDS

        def interrupted(_grant):
            raise RuntimeError("worker interrupted")

        def timed_out(*args):
            timeout = args[-1]
            self.assertEqual(timeout, continuation.FINALIZATION_RESERVE_SECONDS)
            self.clock.now += timeout
            raise subprocess.TimeoutExpired("isolated provider", timeout)

        with self.call(node) as root:
            session = continuation.Session(json.dumps(node), MODEL.identity)
            session.initialize(self.repository)
            with self.assertRaisesRegex(RuntimeError, "worker interrupted"):
                session.funded(interrupted, call_seconds)

        with self.call(node, self.resume(root)):
            session = continuation.Session(json.dumps(node), MODEL.identity)
            with self.assertRaisesRegex(RuntimeError, "worker interrupted"):
                session.funded(interrupted, call_seconds)

        with self.call(node, self.resume(root)):
            with self.assertRaisesRegex(continuation.Continuation, "cumulative review time allowance exhausted") as stopped:
                self.run_review(node, timed_out)
            self.assertEqual(stopped.exception.result["outcome"], "held")
            self.assertEqual(self.saved(root)["spent_ms"], 2 * call_seconds * 1000 + 120_000)

        with self.call(node, self.resume(root)):
            with self.assertRaisesRegex(continuation.Continuation, "cumulative review time allowance exhausted"):
                self.run_review(node, lambda *_args: self.fail("exhausted allowance launched work"))
        self.assertEqual(self.posts, [])

    def test_identical_inspection_and_ordinary_output_do_not_reset_stall_bound(self):
        node = packet()
        read = {"operation": "read", "path": "src/f000.py", "query": "", "start_line": 1}

        def ask(*args):
            return verdict(args[3], requests=[read])

        with self.call(node) as root:
            with self.assertRaises(continuation.Continuation):
                self.run_review(node, ask)
        for attempt in range(2):
            with self.call(node, self.resume(root)):
                with self.assertRaises(continuation.Continuation) as stopped:
                    self.run_review(node, ask)
                self.assertEqual(stopped.exception.result["outcome"], "held" if attempt else "continuation_required")
        self.assertIn("no validated advancement in two attempts", stopped.exception.result["reason"])
        self.assertEqual(self.posts, [])

    def test_isomora_841_two_later_deadlines_resume_validated_pages_within_cumulative_allowance(self):
        node = packet(37)
        failures, turns, credited = 0, 0, []
        read = {"operation": "read", "path": "src/f016.py", "query": "", "start_line": 1}

        def inspect(requests, *, timeout_s):
            response = self.inspect(requests, timeout_s=timeout_s)
            page = requests[0]["start_line"]
            response["results"][0].update(truncated=page < 3, next_line=page + 1 if page < 3 else None)
            return response

        self.repository.inspect = inspect

        def ask(*args):
            nonlocal failures, turns
            prompt, timeout = args[3], args[-1]
            source = supplied(prompt)
            if "file group 3 of 5" in source.get("review_scope", ""):
                turns += 1
                self.clock.now += 0.1
                if turns == 1:
                    pending = json.loads(prompt.split("Required unfinished inspection requests: ", 1)[1].splitlines()[0])
                    return verdict(prompt, requests=pending or [read])
                if failures < 2:
                    failures += 1
                    self.clock.now += timeout
                    raise subprocess.TimeoutExpired("isolated provider", timeout)
            else:
                if "required_cross_unit_evidence" not in source:
                    credited.append(source["files"][0]["filename"])
                self.clock.now += 10 if not failures else 0.1
            return verdict(prompt)

        with self.call(node) as root:
            with self.assertRaises(continuation.Continuation):
                self.run_review(node, ask)
            self.assertEqual(self.saved(root)["unit"], 2)
            first_spend = self.saved(root)["spent_ms"]
        turns = 0
        with self.call(node, self.resume(root)):
            with self.assertRaises(continuation.Continuation):
                self.run_review(node, ask)
            self.assertEqual(self.saved(root)["unit"], 2)
            self.assertGreater(self.saved(root)["spent_ms"], first_spend)
        turns = 0
        with self.call(node, self.resume(root)):
            self.run_review(node, ask)
        self.assertEqual([request["start_line"] for request in self.inspections], [1, 2, 3])
        self.assertEqual(credited.count("src/f000.py"), 1)
        self.assertEqual(credited.count("src/f008.py"), 1)
        self.assertEqual(self.saved(root)["allowance_ms"], continuation.OBLIGATION_TIME_MS)
        self.assertLess(self.saved(root)["spent_ms"], continuation.OBLIGATION_TIME_MS - 120_000)
        self.assertEqual(len(self.posts), 1)

    def test_verification_keeps_its_original_revision_and_cannot_attach_to_a_refreshed_answer(self):
        node = packet()
        node.update(verification_candidates=[17], review_threads=[{"root_comment_id": 17, "id": "thread",
                    "repair_answer": {"revision": "answer-v1", "body": "Fixed the caller"}}])
        read = {"operation": "read", "path": "src/f000.py", "query": "", "start_line": 1}
        observed = False

        def ask(*args):
            nonlocal observed
            value = json.loads(verdict(args[3], requests=[] if observed else [read]))
            value["assessment"]["verified_fixes"] = [17]
            observed = True
            return json.dumps(value)

        with self.call(node) as root:
            self.run_review(node, ask)
            with sqlite3.connect(api.DB) as conn:
                artifact = json.loads(conn.execute("select artifact from calls where id=?", (root,)).fetchone()[0])
            self.assertEqual(artifact["review_response"]["verified_fixes"], {"17": {"id": "thread", "revision": "answer-v1"}})
            node["review_threads"][0]["repair_answer"]["revision"] = "answer-v2"
            review_receipt.prepare_response(json.dumps(node), MODEL.identity, policy="policy")
            with self.assertRaisesRegex(RuntimeError, "complete, exclusively reserved"):
                review_receipt.complete_response({**ASSESSMENT, "verified_fixes": [17]}, HEAD)

    def test_omitting_resume_cannot_reset_the_saved_basis_budget(self):
        node = packet()
        with self.call(node) as root:
            session = continuation.Session(json.dumps(node), MODEL.identity)
            session.initialize(self.repository)
            with self.assertRaises(continuation.Continuation):
                session.pause("Call boundary")
        before = self.saved(root)
        with self.call(node):
            with self.assertRaisesRegex(continuation.Continuation, "saved review already exists"):
                continuation.Session(json.dumps(node), MODEL.identity)
        self.assertEqual(self.saved(root), before)

    def test_manifest_unit_bound_is_checked_before_rendering_or_launching_work(self):
        node = packet(9)
        with self.call(node), patch.object(continuation, "MAX_UNITS", 1), \
                patch.object(review_stages, "_render", side_effect=AssertionError("rendered an over-limit manifest")):
            with self.assertRaisesRegex(continuation.Continuation, "unit count exceeds its bounded manifest"):
                self.run_review(node, lambda *_args: self.fail("over-limit manifest launched a provider"))
        self.assertEqual(self.posts, [])

    def test_large_single_file_retains_end_defect_and_cross_boundary_evidence(self):
        node = packet()
        path = node["files"][0]["filename"]
        additions = ["+MODE = 'strict'", "+def encode(value): return {'value': value}"]
        additions += [f"+value_{index} = {index}" for index in range(2997)]
        additions += ["+decoded = encode('x')['payload']", "+result = 1 / 0"]
        node["diff"] = f"diff --git a/{path} b/{path}\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,3001 @@\n" + "\n".join(additions)
        finding = {"path": path, "line": 3001, "side": "RIGHT", "body": "[p1] End-of-file arithmetic always crashes."}
        crossing = {"path": path, "line": 3000, "side": "RIGHT", "body": "[p1] Consumer reads payload although encode returns value."}
        seen, cross = [], []

        def ask(*args):
            value = supplied(args[3])
            if "required_cross_unit_evidence" in value:
                cross.extend(value["required_cross_unit_evidence"])
                boundaries = json.dumps(value["required_cross_unit_evidence"])
                self.assertIn("def encode(value): return {'value': value}", boundaries)
                self.assertIn("decoded = encode('x')['payload']", boundaries)
                return verdict(args[3], [crossing])
            seen.extend(line for line in value["diff"].splitlines() if line.startswith("+") and not line.startswith("+++"))
            return verdict(args[3], [finding] if "+result = 1 / 0" in value["diff"] else [])

        with patch.object(review_stages, "STAGE_MAX_DIFF_BYTES", 4000), self.call(node):
            self.run_review(node, ask)
        self.assertEqual(seen, additions)
        self.assertGreater(len(cross), 1)
        command = self.posts[0][0]
        self.assertEqual(json.loads(command[command.index("--comments") + 1]), [finding, crossing])
