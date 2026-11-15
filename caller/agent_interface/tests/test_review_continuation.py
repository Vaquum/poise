"""Caller protocol proof; providers and GitHub writes are isolated stand-ins."""
import json
import sqlite3
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, contextmanager, nullcontext
from pathlib import Path
from threading import Barrier
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

import agent_interface as api
from agent_interface import atoms, issue_review, review_budget, review_continuation as continuation, review_receipt, \
    review_stages, structured_review
from agent_interface.model_catalog import CATALOG
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
            {"action": "requested_changes" if "--request-changes" in command else "reviewed_clean",
             "review_id": 91, "head_sha": HEAD}))

    @contextmanager
    def call(self, node, resume=None, slot="sol", policy="policy", *, source="poise:behavior-chain", units_per_call=None):
        call_id = api.track(MODEL.identity, "", "12", "o/r", "reviewer", "pr_review",
                            expected_head=HEAD, source=source, managed_review=units_per_call is not None)
        review_receipt.bind(api.DB, call_id)
        with review_budget.ReviewBudget(), review_receipt.invocation_environment(api.DB, call_id, True), \
                continuation.request(slot, resume, units_per_call):
            review_receipt.prepare_response(json.dumps(node), MODEL.identity, policy=policy)
            try:
                yield call_id
            finally:
                api.resource_ownership.cleanup_remaining(api.DB, call_id)
                with sqlite3.connect(api.DB) as conn:
                    conn.execute("update calls set status='failed', resources_settled_at=1 where id=?", (call_id,))

    def run_review(self, node, ask):
        raw = json.dumps(node)
        with (patch.dict(structured_review.ASK, {"codex": ask}) if ask is not None else nullcontext()):
            return structured_review.run(self.directory.name, "system", "PR packet:\n" + raw, MODEL, "pr_review",
                                        "https://github.com/o/r/pull/12", "reviewer", HEAD, 1413,
                                        repository=self.repository, packet=raw)

    def saved(self, root):
        with sqlite3.connect(api.DB) as conn:
            return json.loads(conn.execute("select artifact from calls where id=?", (root,)).fetchone()[0])["review_progress"]

    def resume(self, root):
        return f"{root}:{self.saved(root)['generation']}"

    def test_twenty_two_groups_resume_a_later_deadline_and_publish_one_verified_verdict(self):
        self.later_deadline(176, 22)

    def test_six_unit_slices_of_a_22_group_review_keep_original_receipts(self):
        node = packet(176)
        seen = []

        def ask(*args):
            self.clock.now += 68
            value = supplied(args[3])
            if "required_cross_unit_evidence" in value:
                self.assertEqual(len(value["required_cross_unit_evidence"]), 22)
                seen.append("integration")
            else:
                seen.append(value["files"][0]["filename"])
            return verdict(args[3])

        for source in ("poise:behavior-chain", "poise:review-new-prs"):
            with self.subTest(source=source), patch.object(atoms, "packet", return_value=json.dumps(node)):
                root, resume = None, None
                self.posts.clear()
                seen.clear()
                for completed in (6, 12, 18, 23):
                    with self.call(node, resume, slot=source, source=source, units_per_call=6) as call_id:
                        if completed < 23:
                            with self.assertRaises(continuation.Continuation) as stopped:
                                self.run_review(node, ask)
                            self.assertEqual(stopped.exception.result["outcome"], "continuation_required")
                            self.assertEqual(self.posts, [])
                        else:
                            self.assertIn('"review_id": 91', self.run_review(node, ask))
                        with sqlite3.connect(api.DB) as conn:
                            call_source, raw = conn.execute("select source,artifact from calls where id=?", (call_id,)).fetchone()
                        self.assertEqual(call_source, source)
                        root = root or call_id
                        evidence = json.loads(raw)["review_checkpoint"]
                        self.assertEqual((evidence["root_call"], evidence["unit"], evidence["required_units"]), (root, completed, 23))
                        self.assertGreaterEqual(evidence["spent_ms"], completed * 68_000)
                        self.assertGreater(evidence["last_progress_at"], 0)
                    resume = self.resume(root)
                self.assertEqual(seen, [f"src/f{i:03d}.py" for i in range(0, 176, 8)] + ["integration"])
                self.assertEqual(self.saved(root)["publisher"], call_id)
                self.assertEqual(len(self.posts), 1)

    def test_resumes_a_checkpoint_created_before_progress_metadata(self):
        node = packet(9)
        seen = []

        def ask(*args):
            value = supplied(args[3])
            seen.append("integration" if "required_cross_unit_evidence" in value else value["files"][0]["filename"])
            return verdict(args[3])

        with self.call(node, units_per_call=1) as root:
            with self.assertRaises(continuation.Continuation):
                self.run_review(node, ask)
        with sqlite3.connect(api.DB) as conn:
            artifact = json.loads(conn.execute("select artifact from calls where id=?", (root,)).fetchone()[0])
            del artifact["review_checkpoint"]
            for key in ("required_units", "last_progress_at", "progress_call"):
                del artifact["review_progress"][key]
            conn.execute("update calls set artifact=? where id=?", (json.dumps(artifact), root))

        with self.call(node, self.resume(root), units_per_call=6) as final, \
                patch.object(atoms, "packet", return_value=json.dumps(node)):
            self.assertIn('"review_id": 91', self.run_review(node, ask))
        self.assertEqual(seen, ["src/f000.py", "src/f008.py", "integration"])
        self.assertEqual(self.saved(root)["required_units"], 3)
        self.assertEqual(self.saved(root)["publisher"], final)
        self.assertEqual(len(self.posts), 1)

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
        with self.call(node, self.resume(root)):
            with self.assertRaisesRegex(continuation.Continuation, "reconcile that Call"):
                self.run_review(node, lambda *_args: self.fail("uncertain publication must not launch a provider"))
        self.assertEqual(self.saved(root), original)
        self.assertEqual(len(attempts), 1)

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
