import subprocess
import sys
import tempfile
from pathlib import Path
from time import time
from unittest import TestCase
from unittest.mock import patch

import agent_interface


class TestStopCall(TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        data = Path(self.work.name)
        for target in (
            patch.object(agent_interface, "DATA_DIR", data),
            patch.object(agent_interface, "DB", data / "calls.sqlite3"),
            patch.object(agent_interface, "RESPONSES", data / "responses"),
            patch.object(agent_interface, "STOP_COMMAND_MARK", "time.sleep"),
            patch.object(agent_interface, "STOP_GRACE_SECONDS", 2.0),
        ):
            target.start()
            self.addCleanup(target.stop)
        agent_interface.init_db()

    def running(self, pid: int) -> str:
        id_ = agent_interface.track("opus-5-max", "prompt")
        with agent_interface.db() as conn:
            conn.execute("update calls set pid=? where id=?", (str(pid), id_))
        return id_

    def sleeper(self) -> subprocess.Popen:
        process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True)
        self.addCleanup(lambda: process.poll() is None and process.kill())
        return process

    def test_track_records_the_process_id(self):
        id_ = agent_interface.track("opus-5-max", "prompt")
        with agent_interface.db() as conn:
            row = conn.execute("select pid, status from calls where id=?", (id_,)).fetchone()
        self.assertEqual((row["pid"], row["status"]), (str(agent_interface.os.getpid()), "running"))

    def test_stops_the_process_group_and_finishes_the_row(self):
        process = self.sleeper()
        id_ = self.running(process.pid)
        started = time()
        result = agent_interface.stop_call(id_)
        self.assertEqual(result, {"id": id_, "stopped": True, "status": "failed", "error_code": "stopped"})
        self.assertIsNotNone(process.wait(timeout=5))
        with agent_interface.db() as conn:
            row = conn.execute("select status, error, error_code, ended_at from calls where id=?", (id_,)).fetchone()
        self.assertEqual((row["status"], row["error"], row["error_code"]), ("failed", "Stopped by user", "stopped"))
        self.assertGreaterEqual(row["ended_at"], started)

    def test_a_finished_call_is_left_alone(self):
        id_ = agent_interface.track("opus-5-max", "prompt")
        agent_interface.finish(id_, "completed", response="done")
        self.assertEqual(agent_interface.stop_call(id_), {"id": id_, "stopped": False, "status": "completed"})

    def test_a_reused_pid_is_never_signalled(self):
        process = self.sleeper()
        id_ = self.running(process.pid)
        with patch.object(agent_interface, "STOP_COMMAND_MARK", "agent-interface"):
            with self.assertRaisesRegex(RuntimeError, "belongs to another process"):
                agent_interface.stop_call(id_)
        self.assertIsNone(process.poll())
        with agent_interface.db() as conn:
            self.assertEqual(conn.execute("select status from calls where id=?", (id_,)).fetchone()["status"], "running")

    def test_a_vanished_process_still_closes_the_row(self):
        process = self.sleeper()
        id_ = self.running(process.pid)
        process.kill()
        process.wait()
        result = agent_interface.stop_call(id_)
        self.assertEqual(result["stopped"], True)
        self.assertEqual(result["status"], "failed")

    def test_unknown_and_pidless_calls_are_errors(self):
        with self.assertRaisesRegex(ValueError, "unknown call id"):
            agent_interface.stop_call("f" * 32)
        id_ = agent_interface.track("opus-5-max", "prompt")
        with agent_interface.db() as conn:
            conn.execute("update calls set pid=null where id=?", (id_,))
        with self.assertRaisesRegex(RuntimeError, "recorded no process id"):
            agent_interface.stop_call(id_)
