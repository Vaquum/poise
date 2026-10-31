"""Durable native-effect receipts; these guards do not validate live cycles."""
import json
import os
import sqlite3
from contextlib import nullcontext, redirect_stdout
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch

import agent_interface as api
from agent_interface import issue_review, review_budget, review_receipt

CALL = "a" * 32
HEAD = "b" * 40


class ManagedReceipts(TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "calls.sqlite3"
        self.conn = sqlite3.connect(self.path)
        self.addCleanup(self.conn.close)
        self.conn.execute("create table calls (id text primary key, source text, status text, behavior text, error_code text, artifact text, "
                          "action text, outcome text, head_sha text, resources_settled_at real, action_plan text)")
        self.conn.execute("insert into calls(id,source,status,behavior,artifact) values(?, 'poise:behavior-chain','running','pr_review',?)",
                          (CALL, json.dumps({"phase": "reviewing", "review_response": {"head_sha": HEAD, "completed_at": 1}})))
        self.conn.commit()
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, {"AGENT_INTERFACE_RECEIPT_DB": str(self.path), "AGENT_INTERFACE_RECEIPT_CALL": CALL}).start()

    def test_submission_is_recorded_before_post_and_cannot_be_submitted_twice(self):
        body = review_receipt.begin_submission("Actual verdict", HEAD)
        self.assertTrue(body.endswith(f"<!-- poise-invocation {CALL} -->"))
        phase = json.loads(self.conn.execute("select artifact from calls").fetchone()[0])["phase"]
        self.assertEqual(phase, "submitting_review")
        with self.assertRaisesRegex(RuntimeError, "unsubmitted native action"):
            review_receipt.begin_submission("Duplicate", HEAD)

    def test_metadata_only_or_future_response_cannot_enter_terminal_submission(self):
        for response in (None, {"head_sha": "c" * 40, "completed_at": 1}, {"head_sha": HEAD, "completed_at": 10 ** 15}):
            self.conn.execute("update calls set artifact=?", (json.dumps({"phase": "reviewing", "review_response": response}),))
            self.conn.commit()
            with self.assertRaisesRegex(RuntimeError, "unsubmitted native action"):
                review_receipt.begin_submission("Actual verdict", HEAD)

    def test_a_pushed_head_preserves_unattempted_replies_and_reserves_them_only_once(self):
        self.conn.execute("update calls set behavior='repair_pr', action_plan='{}', artifact=?",
                          (json.dumps({"phase": "publishing", "plan_sha": "c" * 64}),))
        self.conn.commit()
        review_receipt.work_publication(HEAD)
        with review_receipt.invocation_environment(self.path, CALL, True, initialize=False):
            artifact = json.loads(self.conn.execute("select artifact from calls").fetchone()[0])
            self.assertEqual((artifact["publication_head"], artifact["replies_started"]), (HEAD, False))
        self.conn.execute("update calls set status='failed', resources_settled_at=1")
        self.conn.commit()
        review_receipt.work_publication(HEAD, start_replies=True)
        with self.assertRaisesRegex(RuntimeError, "already attempted"):
            review_receipt.work_publication(HEAD, start_replies=True)

    def test_unknown_resources_or_a_changed_head_cannot_resume_an_unattempted_reply(self):
        self.conn.execute("update calls set behavior='repair_pr', action_plan='{}', status='failed', artifact=?",
                          (json.dumps({"phase": "publishing", "plan_sha": "c" * 64, "publication_head": HEAD, "replies_started": False}),))
        self.conn.commit()
        with self.assertRaisesRegex(RuntimeError, "settled native ownership"):
            review_receipt.work_publication(HEAD, start_replies=True)
        self.conn.execute("update calls set resources_settled_at=1")
        self.conn.commit()
        with self.assertRaisesRegex(RuntimeError, "settled native ownership"):
            review_receipt.work_publication("c" * 40, start_replies=True)

    def test_unacknowledged_issue_comment_is_never_reclassified_as_no_write(self):
        self.conn.execute("update calls set status='failed', behavior='issue_review', resources_settled_at=1, action_plan='{}', artifact=?",
                          (json.dumps({"phase": "posting_issue_reviews"}),))
        api.mark_managed_no_write(self.conn, CALL)
        self.assertIsNone(self.conn.execute("select action from calls").fetchone()[0])
        self.conn.execute("update calls set action_plan=null, artifact=?", (json.dumps({"phase": "reviewing"}),))
        api.mark_managed_no_write(self.conn, CALL)
        self.assertEqual(self.conn.execute("select action from calls").fetchone()[0], "not_started")

    def test_resource_inspection_failure_preserves_publication_intent_and_prevents_handoff(self):
        self.conn.commit()
        with patch('agent_interface.issue_review.stop_leftovers'), patch('agent_interface.issue_review._cwd_pids', return_value=None):
            with self.assertRaisesRegex(RuntimeError, "resources could not be proven"):
                with review_receipt.managed_resources(Path(self.directory.name) / "checkout"):
                    review_receipt.begin_submission("Actual verdict", HEAD)
        artifact = json.loads(self.conn.execute("select artifact from calls").fetchone()[0])
        self.assertEqual(artifact["phase"], "submitting_review")
        self.assertEqual(artifact["resource_error"], "resources_unknown")


class AtomicWorkLimits(TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.path = root / "calls.sqlite3"
        self.addCleanup(patch.stopall)
        patch.object(api, "DB", self.path).start()
        patch.object(api, "RESPONSES", root / "responses").start()
        patch.object(issue_review, "WORK_ROOT", root / "reviews").start()
        patch.object(issue_review, "cleanup").start()
        patch.object(api, "CATALOG", SimpleNamespace(issue_review_model=lambda _identity: SimpleNamespace(identity="fixture-model", provider="codex"))).start()
        api.init_db()

    def run_behavior(self):
        api.run_atomic_work("example/repo#7", "author", "poise:behavior-chain",
                            "00000000-0000-4000-8000-000000000001", "fixture-model", "poise/issue-7")

    def test_implementation_receives_its_requested_hour_instead_of_the_pr_review_cap(self):
        remaining = []

        def work(*_args, **_kwargs):
            remaining.append(review_budget.timeout(issue_review.TIMEOUT_SECONDS))
            return {"outcome": "no_changes", "head_sha": None}

        with patch.object(api.atomic_work, "run", side_effect=work), \
                patch.object(review_receipt, "managed_resources", return_value=nullcontext()), redirect_stdout(StringIO()):
            self.run_behavior()
        self.assertGreater(remaining[0], 3500)
        self.assertLessEqual(remaining[0], issue_review.TIMEOUT_SECONDS)

    def test_a_failed_worker_keeps_unknown_resource_evidence_in_its_native_receipt(self):
        with patch.object(api.atomic_work, "run", side_effect=RuntimeError("provider failed")), \
                patch.object(issue_review, "stop_leftovers"), patch.object(issue_review, "_cwd_pids", return_value=None), \
                self.assertRaisesRegex(RuntimeError, "resources could not be proven"):
            self.run_behavior()
        with sqlite3.connect(self.path) as conn:
            status, artifact, settled = conn.execute("select status, artifact, resources_settled_at from calls").fetchone()
        self.assertEqual(status, "failed")
        self.assertEqual(json.loads(artifact)["resource_error"], "resources_unknown")
        self.assertIsNone(settled)

    def test_invalid_publication_is_a_known_unstarted_failure_without_an_action_plan(self):
        modes = []

        def interface(*args, **_kwargs):
            mode = args[args.index("--mode") + 1]
            modes.append(mode)
            if mode == "prepare":
                return {"outcome": "prepared", "checkout_head": HEAD}
            raise ValueError("publication requires Conventional Commit metadata")

        def worker(_lease, _args, **kwargs):
            output = Path(kwargs["cwd"]).parent / "publication.json"
            output.write_text(json.dumps({"commitMessage": "not a Conventional Commit", "title": "Invalid title", "body": "Fixes #8", "replies": []}))
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        with patch.object(issue_review, "packet", return_value={"issue": {"state": "open"}}), \
                patch.object(issue_review, "interface", side_effect=interface), \
                patch.object(issue_review, "command", return_value=(["fixture"], "", {})), \
                patch.object(issue_review, "_terminal_failure", return_value=None), \
                patch.object(issue_review, "stop_leftovers"), patch.object(issue_review, "_cwd_pids", return_value=[]), \
                patch.object(api.atomic_work.checkout_lock, "Lease", return_value=MagicMock()), \
                patch.object(api.atomic_work.checkout_lock, "run_gated", side_effect=worker), \
                self.assertRaisesRegex(ValueError, "Conventional Commit"):
            self.run_behavior()
        with sqlite3.connect(self.path) as conn:
            status, action, outcome, plan = conn.execute("select status, action, outcome, action_plan from calls").fetchone()
        self.assertEqual(modes, ["prepare", "validate"])
        self.assertEqual((status, action, outcome), ("failed", "not_started", "preflight_failed"))
        self.assertIsNone(plan)

    def test_repair_completion_reuses_the_original_plan_without_a_worker_or_new_call(self):
        call = api.track("fixture-model", "repair", "3", "example/repo", "author", "repair_pr", source="poise:behavior-chain")
        publication = {"title": "fix: repair seed", "body": "Concrete repair", "replies": [{"commentId": 17, "body": "Fixed."}]}
        digest = api.persist_action_plan(call, {"kind": "atomic_work", "publication": publication})
        artifact = {"phase": "publishing", "plan_sha": digest, "publication_head": HEAD, "replies_started": False,
                    "prepared": {"repository": "example/repo", "issue_number": 7, "pull_number": 3, "branch": "poise/issue-7", "actor": "author"}}
        with api.db() as conn:
            conn.execute("update calls set status='failed',resources_settled_at=1,artifact=? where id=?", (json.dumps(artifact), call))
        with patch.object(issue_review, "interface", return_value={"outcome": "published"}) as interface:
            self.assertEqual(api.complete_atomic_publication(call, digest, HEAD), {"outcome": "published"})
        args = interface.call_args.args
        self.assertEqual(args[args.index("--invocation-id") + 1], call)
        self.assertEqual(json.loads(args[args.index("--replies-json") + 1]), publication["replies"])
        for changed in ({"replies_started": True}, {"publication_head": "c" * 40}, {"plan_sha": "c" * 64}):
            with self.subTest(changed=changed), api.db() as conn:
                conn.execute("update calls set artifact=? where id=?", (json.dumps({**artifact, **changed}), call))
            with self.assertRaisesRegex(ValueError, "original unattempted"):
                api.complete_atomic_publication(call, digest, HEAD)
        with api.db() as conn:
            self.assertEqual(conn.execute("select count(*) from calls").fetchone()[0], 1)
