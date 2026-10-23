"""Incremental Caller log reads: indexed running-only query, bounded pages.

Whole-log `--logs` dumps (14.2 MB, ~8 s) saturated Poise's main thread and
timed behaviors out. Current queries must stay flat as history grows: the
running-only read is indexed, and history walks back in bounded pages behind
a stable cursor.
"""
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

import agent_interface

ROOT = Path(__file__).resolve().parents[1]

# Today's retained history (~6,276 rows) times ten, per the issue.
TEN_X_ROWS = 62760


class LogsIncrementalCase(TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.data = Path(self.work.name)
        for target in (
            patch.object(agent_interface, "DATA_DIR", self.data),
            patch.object(agent_interface, "DB", self.data / "calls.sqlite3"),
            patch.object(agent_interface, "RESPONSES", self.data / "responses"),
        ):
            target.start()
            self.addCleanup(target.stop)
        agent_interface.init_db()

    def seed(self, count, running=0):
        with agent_interface.db() as conn:
            conn.executemany(
                "insert into calls (id, model, prompt, started_at, ended_at, status)"
                " values (?,?,?,?,?,?)",
                [
                    (
                        f"{n:032x}",
                        "opus-5-max",
                        f"prompt {n}",
                        1761000000.0 + n,
                        None if n >= count - running else 1761000060.0 + n,
                        "running" if n >= count - running else "completed",
                    )
                    for n in range(count)
                ],
            )

    def cli(self, *args: str) -> subprocess.CompletedProcess:
        env = {
            "AGENT_INTERFACE_DATA_DIR": str(self.data),
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONPATH": str(ROOT),
            "PATH": "",
            "HOME": self.work.name,
        }
        return subprocess.run(
            [sys.executable, "-c", "from agent_interface import main; main()", *args],
            text=True, capture_output=True, env=env, cwd=self.work.name, timeout=120,
        )

    def test_running_read_returns_only_running_rows(self):
        self.seed(5, running=2)
        rows = agent_interface.logs(status="running")
        self.assertEqual([r["status"] for r in rows], ["running", "running"])
        self.assertEqual([r["prompt"] for r in rows], ["prompt 3", "prompt 4"])
        done = self.cli("--logs", "--status", "running")
        self.assertEqual((done.returncode, done.stderr), (0, ""), done.stderr)
        self.assertEqual(json.loads(done.stdout), rows)

    def test_running_and_paged_reads_use_indexes_not_scans(self):
        self.seed(10, running=1)
        with agent_interface.db() as conn:
            running = conn.execute(
                "explain query plan select id from calls"
                " where status='running' order by started_at"
            ).fetchall()
            page = conn.execute(
                "explain query plan select rowid from calls"
                " where rowid < 9 order by rowid desc limit 3"
            ).fetchall()
        self.assertTrue(any("calls_status_started" in r[3] for r in running), running)
        self.assertFalse(any("SCAN" in r[3] for r in running), running)
        self.assertTrue(any("INTEGER PRIMARY KEY" in r[3] for r in page), page)
        self.assertFalse(any("SCAN" in r[3] for r in page), page)

    def test_running_and_paged_reads_stay_flat_at_ten_x_history(self):
        self.seed(TEN_X_ROWS, running=5)
        started = time.monotonic()
        rows = agent_interface.logs(status="running")
        running_elapsed = time.monotonic() - started
        self.assertEqual(len(rows), 5)
        self.assertLess(running_elapsed, 2, f"running read took {running_elapsed:.2f}s")
        started = time.monotonic()
        page = agent_interface.logs_page(500)
        page_elapsed = time.monotonic() - started
        self.assertEqual(len(page["rows"]), 500)
        self.assertLess(page_elapsed, 2, f"paged read took {page_elapsed:.2f}s")

    def test_pages_walk_newest_first_with_a_stable_cursor(self):
        self.seed(5)
        seen: list[str] = []
        cursor = None
        while True:
            page = agent_interface.logs_page(2, cursor)
            prompts = [r["prompt"] for r in page["rows"]]
            self.assertEqual(prompts, sorted(prompts), "rows stay oldest-first in the page")
            seen.extend(r["id"] for r in page["rows"])
            cursor = page["nextCursor"]
            if cursor is None:
                break
        full = agent_interface.logs()
        self.assertEqual(sorted(seen), sorted(r["id"] for r in full))
        self.assertEqual(len(seen), len(set(seen)), "every row is visited exactly once")
        # A cursor past the oldest row ends the walk without an empty page.
        empty = agent_interface.logs_page(2, "1")
        self.assertEqual((empty["rows"], empty["nextCursor"]), ([], None))

    def test_appends_during_a_walk_do_not_shift_older_pages(self):
        self.seed(4)
        first = agent_interface.logs_page(2)
        self.assertEqual([r["prompt"] for r in first["rows"]], ["prompt 2", "prompt 3"])
        with agent_interface.db() as conn:
            conn.execute(
                "insert into calls (id, model, prompt, started_at, ended_at, status)"
                " values (?,?,?,?,?,?)",
                ("f" * 32, "opus-5-max", "prompt 4", 1761000004.0, 1761000064.0, "completed"),
            )
        second = agent_interface.logs_page(2, first["nextCursor"])
        self.assertEqual([r["prompt"] for r in second["rows"]], ["prompt 0", "prompt 1"])
        self.assertIsNone(second["nextCursor"])

    def test_paged_cli_returns_an_envelope(self):
        self.seed(3)
        done = self.cli("--logs", "--limit", "2")
        self.assertEqual((done.returncode, done.stderr), (0, ""), done.stderr)
        page = json.loads(done.stdout)
        self.assertEqual([r["prompt"] for r in page["rows"]], ["prompt 1", "prompt 2"])
        self.assertEqual(page["nextCursor"], "2")
        followed = self.cli("--logs", "--limit", "2", "--cursor", page["nextCursor"])
        self.assertEqual((followed.returncode, followed.stderr), (0, ""), followed.stderr)
        tail = json.loads(followed.stdout)
        self.assertEqual([r["prompt"] for r in tail["rows"]], ["prompt 0"])
        self.assertIsNone(tail["nextCursor"])

    def test_logs_rejects_bad_filters_and_limits(self):
        self.seed(2)
        for args, message in (
            (("--logs", "--status", "completed"), "--status must be running"),
            (("--logs", "--status", "running", "--limit", "2"), "--status running cannot combine"),
            (("--logs", "--cursor", "2"), "--cursor requires --limit"),
            (("--logs", "--limit", "0"), "logs page limit must be 1..1000"),
            (("--logs", "--limit", "1001"), "logs page limit must be 1..1000"),
            (("--logs", "--limit", "many"), "--limit must be an integer"),
            (("--logs", "--limit", "2", "--cursor", "oldest"), "logs page cursor is invalid"),
            (("--logs", "--limit", "2", "--cursor", "0"), "logs page cursor is invalid"),
        ):
            done = self.cli(*args)
            self.assertEqual(done.returncode, 2, args)
            self.assertIn(message, done.stderr, args)
        unknown = self.cli("--logs", "--since", "yesterday")
        self.assertEqual(unknown.returncode, 2)
        self.assertIn("usage: agent-interface", unknown.stderr)
        with self.assertRaises(ValueError):
            agent_interface.logs(status="completed")
        with self.assertRaises(ValueError):
            agent_interface.logs_page(0)
        with self.assertRaises(ValueError):
            agent_interface.logs_page(1001)
        with self.assertRaises(ValueError):
            agent_interface.logs_page(2, cursor="oldest")

    def test_latest_selection_proves_missing_kinds_and_old_ids_without_history_pages(self):
        self.seed(TEN_X_ROWS)
        with agent_interface.db() as conn:
            # The later insertion has an older timestamp; rowid is not recency.
            conn.execute("update calls set behavior='pr_review', source='poise:review-new-prs', repo='OWNER/repo', pr_id='1' where id=?",
                         (f"{TEN_X_ROWS - 1:032x}",))
            conn.execute("insert into calls (id,model,prompt,started_at,status,behavior,source,repo,pr_id) values(?,?,?,?,?,?,?,?,?)",
                         ("f" * 32, "opus-5-max", "late insertion, older call", 1761000000.0, "completed",
                          "pr_review", "poise:review-new-prs", "owner/repo", "2"))
            plan = conn.execute("explain query plan " + agent_interface.LOGS_LATEST_QUERY,
                                ("pr_review", "poise:review-new-prs", "owner")).fetchall()
        details = " ".join(row[3] for row in plan)
        self.assertIn("calls_behavior_owner_started", details)
        self.assertNotIn("SCAN", details)
        self.assertNotIn("TEMP B-TREE", details)
        selection = {"latest": [
            {"behavior": "pr_review", "source": "poise:review-new-prs", "owner": "owner"},
            {"behavior": "issue_review", "source": "poise:review-new-issues", "owner": "owner"},
            {"behavior": "pr_review", "source": "poise:review-new-prs", "owner": "absent"},
        ], "ids": ["0" * 32]}
        rows = agent_interface.logs_selected(selection)
        self.assertEqual([row["id"] for row in rows], ["0" * 32, f"{TEN_X_ROWS - 1:032x}"])
        selected = self.cli("--logs", "--select", json.dumps(selection))
        self.assertEqual((selected.returncode, selected.stderr), (0, ""))
        self.assertEqual(json.loads(selected.stdout), rows)

    def test_launch_selection_includes_terminal_calls_and_retains_ambiguity(self):
        self.seed(2)
        before = agent_interface.logs_watermark()
        self.assertEqual(before, "2")
        watermark = self.cli("--logs", "--watermark")
        self.assertEqual((watermark.returncode, json.loads(watermark.stdout)), (0, {"cursor": before}))
        with agent_interface.db() as conn:
            for id_, session, prompt, status in [
                ("a" * 32, "session", "--topic", "completed"),
                ("b" * 32, "other", "--topic", "completed"),
                ("c" * 32, "session", "other topic", "completed"),
            ]:
                conn.execute("insert into calls (id,model,prompt,started_at,status,behavior,session_id) values(?,?,?,?,?,?,?)",
                             (id_, "opus-5-max", prompt, 1761000000.0, status, "author_content", session))
            plan = conn.execute("explain query plan select id from calls where session_id=? and behavior=? and rowid>? and prompt=? order by rowid limit 2",
                                ("session", "author_content", int(before), "--topic")).fetchall()
        self.assertIn("calls_session_behavior", " ".join(row[3] for row in plan))
        self.assertEqual([row["id"] for row in agent_interface.logs_session_since(before, "session", "author_content", "--topic")], ["a" * 32])
        with agent_interface.db() as conn:
            conn.execute("insert into calls (id,model,prompt,started_at,status,behavior,session_id) values(?,?,?,?,?,?,?)",
                         ("d" * 32, "opus-5-max", "--topic", 1761000001.0, "failed", "author_content", "session"))
        selected = self.cli("--logs", "--after", before, "--session", "session", "--behavior", "author_content", "--prompt", "--topic")
        self.assertEqual((selected.returncode, selected.stderr), (0, ""))
        self.assertEqual([row["status"] for row in json.loads(selected.stdout)], ["completed", "failed"])
        self.assertEqual(agent_interface.logs_session_since(agent_interface.logs_watermark(), "session", "author_content", "--topic"), [])

    def test_selected_reads_fail_loud_on_malformed_or_oversized_needles(self):
        for selection in [None, {}, {"latest": [], "ids": ["partial"]},
                          {"latest": [{"behavior": "pr_review"}], "ids": []},
                          {"latest": [], "ids": ["a" * 32] * 1001}]:
            with self.assertRaises(ValueError):
                agent_interface.logs_selected(selection)
            done = self.cli("--logs", "--select", json.dumps(selection))
            self.assertEqual(done.returncode, 2, done.stdout)
        for after in ["-1", "01", "unknown", str(2**63)]:
            with self.assertRaises(ValueError):
                agent_interface.logs_session_since(after, "session", "author_content", "topic")
