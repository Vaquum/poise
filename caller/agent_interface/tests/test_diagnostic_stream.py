"""The Logging stream never reads prompts or artifacts and never skips late completion."""
import io
import json
import sys
import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

import agent_interface


class DiagnosticStreamCase(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        for name, value in (("DB", root / "calls.sqlite3"), ("RESPONSES", root / "responses")):
            target = patch.object(agent_interface, name, value)
            target.start()
            self.addCleanup(target.stop)
        agent_interface.init_db()

    def call(self):
        return agent_interface.track("opus-5-max", "private-prompt", repo="acme/app", behavior="pr_review")

    def test_late_completion_is_delivered_once_after_the_previous_cursor(self):
        late, first = self.call(), self.call()
        agent_interface.finish(first, "failed", error="first precise cause")
        page = agent_interface.diagnostics()
        self.assertEqual([row["id"] for row in page["events"]], [first])
        agent_interface.finish(late, "failed", error="late precise cause", diagnostic={"version": 1, "stderr": "fatal: cause"})
        next_page = agent_interface.diagnostics(page["cursor"])
        self.assertEqual([row["id"] for row in next_page["events"]], [late])
        self.assertEqual(next_page["events"][0]["diagnostic"]["stderr"], "fatal: cause")
        agent_interface.finish(late, "failed", error="late precise cause")
        self.assertEqual(agent_interface.diagnostics(next_page["cursor"])["events"], [])
        self.assertNotIn("private-prompt", json.dumps(page))
        self.assertNotIn("response_path", json.dumps(page))

    def test_backfill_is_bounded_and_tracks_terminal_updates_without_prompt_reads(self):
        ids = [self.call() for _ in range(12)]
        with agent_interface.db() as conn:
            conn.executemany("update calls set status='failed',error='legacy',ended_at=1 where id=?", [(id_,) for id_ in ids])
            conn.execute("delete from diagnostic_calls")
        page = agent_interface.diagnostics(0, 10)
        self.assertEqual(len(page["events"]), 10)
        self.assertTrue(page["hasMore"])
        self.assertEqual(len(agent_interface.diagnostics(page["cursor"], 10)["events"]), 2)
        self.assertNotIn("private-prompt", json.dumps(page))

    def test_malformed_large_evidence_does_not_stall_the_stream(self):
        id_ = self.call()
        with agent_interface.db() as conn:
            conn.execute("update calls set status='failed',error=?,diagnostic=? where id=?", ("障" * 100000, "{" * 100000, id_))
        page = agent_interface.diagnostics()
        self.assertLess(len(json.dumps(page).encode()), 66 * 1024)
        self.assertIn("evidence_unavailable", page["events"][0])
        self.assertEqual(agent_interface.diagnostics(page["cursor"])["events"], [])
        for cursor, limit in [(-1, 1), (0, 11), (True, 1)]:
            with self.assertRaises(ValueError):
                agent_interface.diagnostics(cursor, limit)


    def test_database_identity_survives_reopen_and_changes_when_database_is_recreated(self):
        first = self.call()
        agent_interface.finish(first, "failed", error="original database cause")
        original = agent_interface.diagnostics()
        agent_interface.init_db()
        self.assertEqual(agent_interface.diagnostics()["streamId"], original["streamId"])
        agent_interface.DB.unlink()
        agent_interface.init_db()
        second = self.call()
        agent_interface.finish(second, "failed", error="replacement database cause")
        stale = agent_interface.diagnostics(100)
        self.assertNotEqual(stale["streamId"], original["streamId"])
        self.assertEqual(stale["events"], [])
        replay = agent_interface.diagnostics()
        self.assertEqual(replay["streamId"], stale["streamId"])
        self.assertEqual([row["id"] for row in replay["events"]], [second])
        self.assertEqual(replay["cursor"], 1)

    def test_nonfinite_and_deep_evidence_cannot_poison_cli_pages_or_block_later_calls(self):
        malformed = [
            '{"version":1,"context":{"value":NaN}}',
            '{"version":1,"context":{"value":Infinity}}',
            '{"version":1,"context":{"value":-Infinity}}',
            '{"version":1,"context":{"value":1e9999}}',
            '{"version":1,"context":' + '[' * 40000 + '0' + ']' * 40000 + '}',
            '{"version":2,"stderr":"unsupported evidence"}',
            '{"stderr":"unversioned evidence"}',
            '{"version":true}',
            'null',
            '',
        ]
        ids = []
        for raw in malformed:
            id_ = self.call()
            agent_interface.finish(id_, "failed", error="known process cause")
            with agent_interface.db() as conn:
                conn.execute("update calls set diagnostic=? where id=?", (raw, id_))
            ids.append(id_)
        later = self.call()
        agent_interface.finish(later, "failed", error="later exact cause", diagnostic={"version": 1, "stderr": "later stderr"})
        cursor = 0
        for id_ in ids:
            page = agent_interface.diagnostics(cursor, 1)
            with self.subTest(id=id_):
                output = io.StringIO()
                with patch.object(sys, "argv", ["agent-interface", "--diagnostics", str(cursor), "1"]), patch.object(sys, "stdout", output):
                    agent_interface.main()
                parsed = json.loads(output.getvalue(), parse_constant=lambda value: self.fail(f"invalid JSON constant {value}"))
                self.assertEqual(parsed, page)
                json.dumps(page, allow_nan=False)
                row = page["events"][0]
                self.assertEqual(row["id"], id_)
                self.assertIsNone(row["diagnostic"])
                self.assertIn("evidence_unavailable", row)
                self.assertEqual(row["error"], "known process cause")
                self.assertGreater(page["cursor"], cursor)
            cursor = page["cursor"]
        final = agent_interface.diagnostics(cursor, 1)
        self.assertEqual(final["events"][0]["id"], later)
        self.assertEqual(final["events"][0]["diagnostic"]["stderr"], "later stderr")
        self.assertEqual(agent_interface.diagnostics(final["cursor"])["events"], [])
