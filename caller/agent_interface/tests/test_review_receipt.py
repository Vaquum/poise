"""A run's outcome is the review it submitted, told apart from a sibling's by id."""
import io
import json
import os
import sqlite3
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch
from uuid import uuid4

import agent_interface as api
from agent_interface import bash_guard, review_budget as budget, review_receipt, structured_review
from agent_interface.model_catalog import CATALOG
from agent_interface.review_watch import ReviewWatch

HEAD = "a" * 40
CHANGES = {"id": 91, "node_id": "PRR_91", "state": "CHANGES_REQUESTED", "commit": HEAD, "submitted_at": "2026-09-17T10:05:00Z"}
CLEAN = {"id": 92, "node_id": "PRR_92", "state": "COMMENTED", "commit": HEAD, "submitted_at": "2026-09-17T10:06:00Z"}
APPROVAL = {"id": 93, "node_id": "PRR_93", "state": "APPROVED", "commit": HEAD, "submitted_at": "2026-09-17T10:07:00Z"}


def facts(items=(), **updates):
    items = list(items)
    value = dict(
        repository="o/r", pull_number=1, state="OPEN", draft=False, head_sha=HEAD,
        reviewer_change_requests_since=sum(1 for i in items if i["state"] == "CHANGES_REQUESTED"),
        reviewer_approvals_since=sum(1 for i in items if i["state"] == "APPROVED"),
        reviewer_comments_since=sum(1 for i in items if i["state"] == "COMMENTED"),
        reviewer_reviews_since=len(items), reviewer_reviews_since_items=items, reviewer_pending_reviews=0,
        reviewer_latest_review_id=None, reviewer_latest_any_review_id=None,
    )
    return {**value, **updates}


def receipt(action, review_id):
    return {"action": action, "review_id": review_id, "head_sha": HEAD}


class TestOwnReviews(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(patch.stopall)
        patch.object(api, "DB", Path(self.directory.name) / "calls.sqlite3").start()
        patch.object(api, "RESPONSES", Path(self.directory.name) / "responses").start()
        patch.object(api, "sleep").start()
        api.init_db()

    def row(self, call_id, review_id=None):
        with sqlite3.connect(api.DB) as conn:
            conn.execute("insert into calls (id, behavior, repo, pr_id, review_id, started_at) values (?, 'pr_review', 'o/r', '1', ?, 0)",
                         (call_id, str(review_id) if review_id else None))

    def outcome(self, behavior, before, after, **kwargs):
        return api.behavior_outcome(object(), behavior, "1", "/tmp", "bit-mis", HEAD, before, after, **kwargs)

    def test_receipt_picks_this_runs_review_among_siblings(self):
        after = facts([CHANGES, CLEAN])
        self.assertEqual(self.outcome("pr_review", facts(), after, receipt=receipt("reviewed_clean", 92))["outcome"], "clean")
        self.assertEqual(self.outcome("pr_review", facts(), after, receipt=receipt("requested_changes", 91))["outcome"], "changes_requested")
        self.assertEqual(self.outcome("pr_approve", facts(), facts([CHANGES, APPROVAL]), receipt=receipt("approved_pr", 93))["outcome"], "approved")

    def test_receipt_must_match_a_posted_review_of_its_kind(self):
        with self.assertRaisesRegex(RuntimeError, "exactly one"):
            self.outcome("pr_review", facts(), facts([CHANGES]), receipt=receipt("reviewed_clean", 92))
        with self.assertRaisesRegex(RuntimeError, "does not match its receipt"):
            self.outcome("pr_review", facts(), facts([CHANGES]), receipt=receipt("reviewed_clean", 91))
        with self.assertRaisesRegex(RuntimeError, "expected head"):
            self.outcome("pr_review", facts(), facts([{**CLEAN, "commit": "b" * 40}]), receipt=receipt("reviewed_clean", 92))
        with self.assertRaisesRegex(RuntimeError, "unexpected approval"):
            self.outcome("pr_review", facts(), facts([APPROVAL]), receipt=receipt("approved_pr", 93))

    def test_reviews_already_there_before_the_run_are_not_its_own(self):
        with self.assertRaisesRegex(RuntimeError, "exactly one"):
            self.outcome("pr_review", facts([CLEAN]), facts([CLEAN]), receipt=receipt("reviewed_clean", 92))

    def test_without_a_receipt_a_siblings_review_is_not_adopted(self):
        self.row("me")
        self.row("sibling", 91)
        result = self.outcome("pr_review", facts(), facts([CHANGES, CLEAN]), call_id="me")
        self.assertEqual(result["outcome"], "clean")
        self.row("other", 92)
        with self.assertRaisesRegex(RuntimeError, "exactly one"):
            self.outcome("pr_review", facts(), facts([CHANGES, CLEAN]), call_id="me")

    def test_an_unclaimed_review_is_checked_again_after_a_grace(self):
        self.row("me")
        self.row("sibling")
        calls = []

        def claim():
            calls.append(1)
            with sqlite3.connect(api.DB) as conn:
                conn.execute("update calls set review_id='91' where id='sibling'")
        api.sleep.side_effect = lambda _: claim()
        with self.assertRaisesRegex(RuntimeError, "exactly one"):
            self.outcome("pr_review", facts(), facts([CHANGES]), call_id="me")
        self.assertEqual(calls, [1])

    def test_facts_without_ids_fall_back_to_the_counters(self):
        before = {k: v for k, v in facts().items() if k != "reviewer_reviews_since_items"}
        after = {**before, "reviewer_comments_since": 1, "reviewer_latest_any_state": "COMMENTED",
                 "reviewer_latest_any_commit": HEAD, "reviewer_latest_any_review_id": "R_clean",
                 "reviewer_latest_any_submitted_at": "2026-09-17T10:06:00Z"}
        self.assertIsNone(api.own_reviews(before, after, None, "me"))
        self.assertEqual(self.outcome("pr_review", before, after, receipt=receipt("reviewed_clean", 92))["outcome"], "clean")

    def test_logs_carry_the_review_id(self):
        self.row("me", 92)
        self.assertEqual(api.logs()[0]["review_id"], 92)


class TestReceiptRecording(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(patch.stopall)
        patch.object(api, "DB", Path(self.directory.name) / "calls.sqlite3").start()
        patch.object(api, "RESPONSES", Path(self.directory.name) / "responses").start()
        api.init_db()
        review_receipt.bind(api.DB, "run")
        with sqlite3.connect(api.DB) as conn:
            conn.execute("insert into calls (id, started_at) values ('run', 0)")

    def stored(self):
        with sqlite3.connect(api.DB) as conn:
            return conn.execute("select review_id from calls where id='run'").fetchone()[0]

    def test_only_a_submission_reply_is_a_receipt(self):
        for text in ("not json", json.dumps({"action": "no_review", "review_id": 5}), json.dumps({"action": "reviewed_clean"}),
                     json.dumps({"action": "reviewed_clean", "review_id": "9"}), json.dumps({"action": "reviewed_clean", "review_id": True})):
            with self.subTest(text=text):
                self.assertIsNone(review_receipt.record(text))
        self.assertIsNone(review_receipt.get())
        self.assertIsNone(self.stored())
        self.assertEqual(review_receipt.record(json.dumps({"action": "requested_changes", "review_id": 91, "head_sha": HEAD})),
                         {"action": "requested_changes", "review_id": 91, "head_sha": HEAD})
        self.assertEqual(review_receipt.get()["review_id"], 91)
        self.assertEqual(self.stored(), "91")

    def test_structured_submission_records_its_receipt(self):
        reply = json.dumps({"action": "reviewed_clean", "review_id": 92, "head_sha": HEAD})

        def process(args, **kwargs):
            if args[0] == "github-interface":
                return SimpleNamespace(returncode=0, stdout=reply, stderr="")
            return SimpleNamespace(returncode=0, stdout=json.dumps({"stopReason": "end_turn", "num_turns": 1,
                                   "structuredOutput": {"action": "reviewed_clean", "comments": []}}), stderr="")
        with patch.object(structured_review.subprocess, "run", side_effect=process), patch.object(ReviewWatch, "run", side_effect=process):
            structured_review.run("/repo", "system", "packet", CATALOG.resolve("grok-4.6-xhigh"), "pr_review",
                                  "https://github.com/o/r/pull/12", "bit-mis", HEAD, 60)
        self.assertEqual(review_receipt.get()["review_id"], 92)
        self.assertEqual(self.stored(), "92")

    def test_failed_structured_submission_records_controller_error_without_a_receipt(self):
        def process(args, **kwargs):
            if args[0] == "github-interface":
                return SimpleNamespace(returncode=1, stdout="", stderr="error: GitHub 500:\n")
            return SimpleNamespace(returncode=0, stdout=json.dumps({"stopReason": "end_turn", "num_turns": 1,
                                   "structuredOutput": {"action": "reviewed_clean", "comments": []}}), stderr="")
        with patch.object(structured_review.subprocess, "run", side_effect=process), patch.object(ReviewWatch, "run", side_effect=process):
            structured_review.run("/repo", "system", "packet", CATALOG.resolve("grok-4.6-xhigh"), "pr_review",
                                  "https://github.com/o/r/pull/12", "bit-mis", HEAD, 60)
        self.assertEqual(review_receipt.failure(), "error: GitHub 500:")
        self.assertIsNone(review_receipt.get())
        self.assertIsNone(self.stored())

    def test_validation_auth_and_provider_prose_are_not_transient_submission_errors(self):
        for text in ("error: GitHub 422: invalid review", "error: GitHub 403: forbidden",
                     "The model says GitHub 500: failed", "invalid model verdict"):
            self.assertIsNone(review_receipt.record_failure(text))
        self.assertIsNone(review_receipt.failure())

    def test_claude_guard_leaves_the_reply_for_the_run_and_the_model(self):
        head = HEAD
        command = f"github-interface --reviewed-clean #68 --expected-head {head} --token-user bit-mis"
        reply = json.dumps({"action": "reviewed_clean", "review_id": 92, "head_sha": head})
        receipt_path = Path(self.directory.name) / "receipt.json"
        with patch.dict(os.environ, {"AGENT_INTERFACE_BASH_ALLOW": json.dumps([command]), "AGENT_INTERFACE_REVIEW_RECEIPT": str(receipt_path)}), \
                patch.object(sys, "argv", ["bash_guard.py", command]), \
                patch.object(bash_guard.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=reply, stderr="warn\n")) as run, \
                redirect_stdout(io.StringIO()) as out:
            with self.assertRaises(SystemExit) as stopped:
                bash_guard.main()
        self.assertEqual(stopped.exception.code, 0)
        self.assertTrue(run.call_args.kwargs["capture_output"])
        self.assertEqual(out.getvalue(), reply)
        self.assertEqual(json.loads(receipt_path.read_text())["review_id"], 92)
        # The run notices the file while the provider is still working.
        self.assertEqual(review_receipt.record_file(receipt_path)["review_id"], 92)
        self.assertEqual(self.stored(), "92")

    def test_claude_guard_without_a_receipt_path_runs_as_before(self):
        command = "github-interface --reviewed-clean #68 --expected-head " + HEAD + " --token-user bit-mis"
        with patch.dict(os.environ, {"AGENT_INTERFACE_BASH_ALLOW": json.dumps([command])}, clear=False), \
                patch.object(sys, "argv", ["bash_guard.py", command]), \
                patch.object(bash_guard.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as run:
            os.environ.pop("AGENT_INTERFACE_REVIEW_RECEIPT", None)
            with self.assertRaises(SystemExit):
                bash_guard.main()
        self.assertNotIn("capture_output", run.call_args.kwargs)

    def test_claude_guard_preserves_transient_submission_error_for_controller(self):
        command = f"github-interface --reviewed-clean #68 --expected-head {HEAD} --token-user bit-mis"
        receipt_path = Path(self.directory.name) / "receipt.json"
        with patch.dict(os.environ, {"AGENT_INTERFACE_BASH_ALLOW": json.dumps([command]), "AGENT_INTERFACE_REVIEW_RECEIPT": str(receipt_path)}), \
                patch.object(sys, "argv", ["bash_guard.py", command]), \
                patch.object(bash_guard.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout="", stderr="error: GitHub 503:\n")), \
                redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as stopped:
                bash_guard.main()
        self.assertEqual(stopped.exception.code, 1)
        review_receipt.bind(api.DB, "run")
        self.assertIsNone(review_receipt.record_file(receipt_path))
        self.assertEqual(review_receipt.failure(), "error: GitHub 503:")
        self.assertIsNone(self.stored())


class TestRecoveryWithSiblings(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(patch.stopall)
        patch.object(api, "DB", Path(self.directory.name) / "calls.sqlite3").start()
        patch.object(api, "RESPONSES", Path(self.directory.name) / "responses").start()
        patch.object(api, "sleep").start()
        api.init_db()
        self.mod = SimpleNamespace(pr_number=lambda _: "1", repo_name=lambda *_: "o/r", run=Mock())

    def execute(self, runs, checks):
        steps = iter(runs)

        def dispatch(*args, **kwargs):
            step = next(steps)
            if isinstance(step, BaseException):
                raise step
            return step(*args, **kwargs) if callable(step) else step
        self.mod.run.side_effect = dispatch
        with patch.object(api, "review_facts", side_effect=checks), redirect_stdout(io.StringIO()):
            try:
                api.run_governed_behavior(self.mod, "pr_review", "https://github.com/o/r/pull/1",
                                          "bit-mis", HEAD, "poise:review-new-prs", uuid4().hex, pwd=self.directory.name)
            except SystemExit:
                pass
        return api.logs()[-1]

    def test_github_outage_is_retryable_but_never_claims_no_action(self):
        def failed(*args, **kwargs):
            review_receipt.record_failure("error: GitHub 500:")
            return "valid verdict; submission failed"
        row = self.execute([failed], [facts(), facts()])
        self.assertEqual(row["status"], "failed")
        self.assertEqual(row["error_code"], "review_submission_failed")
        self.assertEqual(row["error"], "error: GitHub 500:")
        self.assertIsNone(row["action"])
        self.assertIsNone(row["outcome"])
        self.assertIsNone(row["review_id"])
        self.assertEqual(self.mod.run.call_count, 1)

    def test_github_accepted_review_wins_over_lost_submission_response(self):
        def lost(*args, **kwargs):
            review_receipt.record_failure("error: GitHub 502:")
            return "response lost"
        row = self.execute([lost], [facts(), facts([CLEAN])])
        self.assertEqual(row["status"], "completed")
        self.assertEqual(row["outcome"], "clean")
        self.assertIsNone(row["error_code"])
        self.assertEqual(self.mod.run.call_count, 1)

    def test_a_siblings_review_does_not_stop_recovery(self):
        with sqlite3.connect(api.DB) as conn:
            conn.execute("insert into calls (id, behavior, repo, pr_id, review_id, started_at) values ('sibling', 'pr_review', 'o/r', '1', '91', 0)")
        # The primary hit its output limit; the secondary had already posted 91.
        def recovered(*args, **kwargs):
            review_receipt.record(json.dumps({"action": "reviewed_clean", "review_id": 92, "head_sha": HEAD}))
            return "done"
        row = self.execute([budget.ReviewLimitError("output token maximum"), recovered],
                           [facts(), facts([CHANGES]), facts([CHANGES, CLEAN])])
        self.assertEqual([x.kwargs["model"] for x in self.mod.run.call_args_list], ["opus-5-high", "gpt-6-astra-ultra"])
        self.assertEqual(row["outcome"], "clean")
        self.assertEqual(row["review_id"], 92)

    def test_own_receipted_review_is_adopted_instead_of_recovering(self):
        def submitted_then_failed(*args, **kwargs):
            review_receipt.record(json.dumps({"action": "requested_changes", "review_id": 91, "head_sha": HEAD}))
            raise budget.ReviewLimitError("output token maximum")
        row = self.execute([submitted_then_failed], [facts(), facts([CHANGES])])
        self.assertEqual(self.mod.run.call_count, 1)
        self.assertEqual(row["outcome"], "changes_requested")
        self.assertEqual(row["review_id"], 91)

    def test_completed_run_with_only_a_siblings_review_is_a_failure_not_a_verdict(self):
        with sqlite3.connect(api.DB) as conn:
            conn.execute("insert into calls (id, behavior, repo, pr_id, review_id, started_at) values ('sibling', 'pr_review', 'o/r', '1', '91', 0)")
        row = self.execute(["done"], [facts(), facts([CHANGES])])
        self.assertEqual(row["status"], "failed")
        self.assertIn("exactly one", row["error"])
        self.assertIsNone(row["review_id"])
