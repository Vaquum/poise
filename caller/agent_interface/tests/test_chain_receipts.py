"""Durable native-effect receipts; these guards do not validate live cycles."""
import json
import os
import sqlite3
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

import agent_interface as api
from agent_interface import review_receipt

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
                          (CALL, json.dumps({"phase": "reviewing"})))
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
