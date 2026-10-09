import os
import subprocess
import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

import agent_interface


class InterruptedCallsCase(TestCase):
    """Calls whose process a container restart or a crash ended read as failed
    and interrupted, so what launched them tries again."""

    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        data = Path(self.work.name)
        for target in (
            patch.object(agent_interface, "DATA_DIR", data),
            patch.object(agent_interface, "DB", data / "calls.sqlite3"),
            patch.object(agent_interface, "RESPONSES", data / "responses"),
            patch.dict(os.environ, {"AGENT_INTERFACE_ACTOR": ""}),
        ):
            target.start()
            self.addCleanup(target.stop)
        agent_interface.init_db()

    def call(self, pid, status="running", runner=None):
        id_ = agent_interface.track("opus-5-max", "review", repo="acme/app", pr_id="7", behavior="pr_review", runner=runner)
        with agent_interface.db() as conn:
            conn.execute("update calls set pid=?, status=? where id=?", (pid, status, id_))
        return id_

    def row(self, id_):
        with agent_interface.db() as conn:
            return conn.execute("select status, error, error_code, ended_at from calls where id=?", (id_,)).fetchone()

    def test_a_call_whose_process_is_gone_reads_as_interrupted(self):
        gone = subprocess.Popen(["true"])
        gone.wait()
        id_ = self.call(str(gone.pid))
        entries = {entry["id"]: entry for entry in agent_interface.logs()}
        self.assertEqual(entries[id_]["status"], "failed")
        self.assertEqual(entries[id_]["error_code"], "interrupted")
        self.assertEqual(entries[id_]["error"], agent_interface.INTERRUPTED_ERROR)
        self.assertIsNotNone(self.row(id_)["ended_at"])

    def test_a_reused_pid_does_not_keep_a_call_running(self):
        id_ = self.call("4242")
        with patch.object(agent_interface, "process_command", return_value="sleep 100"):
            self.assertEqual(agent_interface.reap_interrupted(), 1)
        self.assertEqual(self.row(id_)["error_code"], "interrupted")

    def test_a_live_worker_and_everything_else_stay_as_they_are(self):
        live = self.call("4242")
        done = self.call("4243", status="completed")
        turn = self.call(None, runner=agent_interface.EXTERNAL_RUNNER)
        old = self.call(None)
        with patch.object(agent_interface, "process_command", return_value="/venv/bin/python /venv/bin/agent-interface --pr-review"):
            self.assertEqual(agent_interface.reap_interrupted(), 0)
        self.assertEqual(self.row(live)["status"], "running")
        self.assertEqual(self.row(done)["status"], "completed")
        self.assertEqual(self.row(turn)["status"], "running")
        self.assertEqual(self.row(old)["status"], "running")
