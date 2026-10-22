"""`agent-interface --logs` prints compact JSON: same rows, fewer bytes."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

import agent_interface

ROOT = Path(__file__).resolve().parents[1]


class LogsCompactCase(TestCase):
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

    def seed(self):
        progress = {"version": 1, "phase": "completed", "reasoning_available": True,
                    "events": [{"at": "2026-10-22T00:00:00.000Z", "message": f"step {n}"} for n in range(3)]}
        diagnostic = {"version": 1, "source": "caller", "operation": "fetch", "outcome": "exit"}
        with agent_interface.db() as conn:
            conn.execute(
                "insert into calls (id, model, prompt, started_at, ended_at, status, response_path, error,"
                " pr_id, repo, actor, behavior, progress, diagnostic) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                ("a" * 32, "opus-5-max", "review this", 1761000000.0, 1761000060.0, "completed", None, "",
                 "7", "owner/repo", "poise-bot", "pr_review",
                 json.dumps(progress), json.dumps(diagnostic)),
            )
            conn.execute(
                "insert into calls (id, model, prompt, started_at, ended_at, status) values (?,?,?,?,?,?)",
                ("b" * 32, "grok-4-6", "", 1761000100.0, 1761000160.0, "failed"),
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
            text=True, capture_output=True, env=env, cwd=self.work.name, timeout=60,
        )

    def test_logs_prints_compact_json_with_identical_rows(self):
        self.seed()
        done = self.cli("--logs")
        self.assertEqual((done.returncode, done.stderr), (0, ""), done.stderr)
        parsed = json.loads(done.stdout)
        self.assertEqual(parsed, agent_interface.logs())
        self.assertEqual(done.stdout, json.dumps(parsed, separators=(",", ":")) + "\n")

    def test_compact_logs_are_smaller_than_pretty_logs(self):
        self.seed()
        done = self.cli("--logs")
        parsed = json.loads(done.stdout)
        self.assertLess(len(done.stdout.encode()), len(json.dumps(parsed, indent=2).encode()))
