"""Changed-call log reads: the calls changed since a change number, in the
whole history's row format, with the whole history's order."""
import json
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

import agent_interface

ROOT = Path(__file__).resolve().parents[1]


class LogsChangedCase(TestCase):
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

    def insert(self, call_id, started, status="completed", progress=None):
        with agent_interface.db() as conn:
            conn.execute(
                "insert into calls (id, model, prompt, started_at, ended_at, status, error, behavior, progress)"
                " values (?,?,?,?,?,?,?,?,?)",
                (call_id, "opus-5-max", "review", started, started + 60 if status != "running" else None, status, "",
                 "pr_review", json.dumps(progress) if progress else None),
            )

    def whole(self, without_progress=False):
        return agent_interface.logs(without_progress=without_progress)

    def merged(self, without_progress=False):
        """The whole history, built only from changed-call reads."""
        held, after = {}, 0
        while True:
            page = agent_interface.logs_changed(after, 2, without_progress)
            for item in page["rows"]:
                held[item["rowid"]] = item["row"]
            after = page["cursor"]
            if not page["more"]:
                return [held[rowid] for rowid in page["order"]]

    def test_changed_reads_rebuild_the_whole_history_in_its_order(self):
        progress = {"version": 1, "phase": "completed", "events": []}
        # Out of start order on purpose: the order is the whole history's, not insertion's.
        self.insert("b" * 32, 1761000200.0, progress=progress)
        self.insert("a" * 32, 1761000100.0)
        self.insert("c" * 32, 1761000300.0, status="running")
        self.assertEqual(self.merged(), self.whole())
        self.assertEqual(self.merged(without_progress=True), self.whole(without_progress=True))
        self.assertTrue(all("progress" not in row for row in self.merged(without_progress=True)))

    def test_every_insert_and_update_takes_the_next_change_number(self):
        self.insert("a" * 32, 1761000100.0)
        first = agent_interface.logs_changed(0, 10)
        self.assertEqual([item["rowid"] for item in first["rows"]], [1])
        cursor = first["cursor"]
        self.assertEqual(agent_interface.logs_changed(cursor, 10)["rows"], [])
        with agent_interface.db() as conn:
            conn.execute("update calls set status = 'failed', error = 'boom' where id = ?", ("a" * 32,))
        self.insert("b" * 32, 1761000050.0)
        later = agent_interface.logs_changed(cursor, 10)
        self.assertEqual([item["rowid"] for item in later["rows"]], [1, 2])
        self.assertEqual(sorted(item["seq"] for item in later["rows"]), [item["seq"] for item in later["rows"]])
        self.assertTrue(all(item["seq"] > cursor for item in later["rows"]))
        self.assertEqual(later["rows"][0]["row"]["status"], "failed")
        self.assertEqual(later["order"], [2, 1])
        self.assertEqual(later["newest"], max(item["seq"] for item in later["rows"]))
        self.assertEqual(self.merged(), self.whole())

    def test_pages_hand_over_every_change_once(self):
        for n in range(5):
            self.insert(f"{n:032x}", 1761000000.0 + n)
        seen, after, pages = [], 0, 0
        while True:
            page = agent_interface.logs_changed(after, 2)
            pages += 1
            seen.extend(item["rowid"] for item in page["rows"])
            after = page["cursor"]
            if not page["more"]:
                break
        self.assertEqual(seen, [1, 2, 3, 4, 5])
        self.assertEqual(pages, 3)

    def test_an_older_database_is_numbered_from_its_rowids(self):
        path = self.data / "older.sqlite3"
        with closing_connection(path) as conn:
            conn.execute("create table calls (id text primary key, model text, prompt text, started_at real,"
                         " ended_at real, status text, response_path text, error text)")
            conn.executemany("insert into calls (id, model, prompt, started_at, ended_at, status, error) values (?,?,?,?,?,?,?)",
                             [(f"{n:032x}", "m", "", 1761000000.0 + n, 1761000060.0 + n, "completed", "") for n in range(3)])
        with patch.object(agent_interface, "DB", path):
            agent_interface.init_db()
            with agent_interface.db() as conn:
                self.assertEqual([tuple(r) for r in conn.execute("select rowid, change_seq from calls order by rowid")],
                                 [(1, 1), (2, 2), (3, 3)])
            self.insert("f" * 32, 1761000900.0)
            self.assertEqual(agent_interface.logs_changed(3, 10)["rows"][0]["seq"], 4)

    def test_the_cli_prints_a_page_and_refuses_other_shapes(self):
        self.insert("a" * 32, 1761000100.0)
        done = self.cli("--logs", "--without-progress", "--changed-after", "0", "--limit", "10")
        self.assertEqual((done.returncode, done.stderr), (0, ""), done.stderr)
        self.assertEqual(json.loads(done.stdout), agent_interface.logs_changed(0, 10, True))
        for args in (("--logs", "--changed-after", "0"), ("--logs", "--changed-after", "x", "--limit", "1"),
                     ("--logs", "--changed-after", "0", "--limit", "5001"), ("--logs", "--changed-after", "-1", "--limit", "1")):
            failed = self.cli(*args)
            self.assertEqual(failed.returncode, 2, args)
            self.assertIn("usage:", failed.stderr)

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
            text=True, capture_output=True, env=env, cwd=self.work.name, timeout=60,
        )


class closing_connection:
    def __init__(self, path):
        self.conn = sqlite3.connect(path)

    def __enter__(self):
        return self.conn

    def __exit__(self, *_):
        self.conn.commit()
        self.conn.close()
