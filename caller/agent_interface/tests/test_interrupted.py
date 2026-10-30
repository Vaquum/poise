import os
import tempfile
import threading
from pathlib import Path
from time import time
from unittest import TestCase
from unittest.mock import patch

import agent_interface

AGENT = "/venv/bin/python /venv/bin/agent-interface --pr-review"


class InterruptedCallsCase(TestCase):
    """A call nothing of which can still run reads as failed, so what launched
    it tries again; one whose providers may live on stays running."""

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
        self.now = time()
        # This container's init started an hour ago.
        init = patch.object(agent_interface, "init_started_at", return_value=self.now - 3600)
        init.start()
        self.addCleanup(init.stop)

    def call(self, started_ago, pid="4242", status="running", runner=None, error_code=None):
        id_ = agent_interface.track("opus-5-max", "review", repo="acme/app", pr_id="7", behavior="pr_review", runner=runner)
        with agent_interface.db() as conn:
            conn.execute(
                "update calls set pid=?, status=?, started_at=?, error_code=? where id=?",
                (pid, status, self.now - started_ago, error_code, id_),
            )
        return id_

    def row(self, id_):
        with agent_interface.db() as conn:
            return conn.execute("select status, error, error_code, ended_at from calls where id=?", (id_,)).fetchone()

    def test_a_call_from_before_the_container_restarted_reads_as_interrupted(self):
        id_ = self.call(started_ago=2 * 3600)
        with patch.object(agent_interface, "process_command", return_value=AGENT):
            entries = {entry["id"]: entry for entry in agent_interface.logs()}
        self.assertEqual(entries[id_]["status"], "failed")
        self.assertEqual(entries[id_]["error_code"], "interrupted")
        self.assertEqual(entries[id_]["error"], agent_interface.INTERRUPTED_ERROR)
        self.assertIsNotNone(self.row(id_)["ended_at"])

    def test_a_gone_supervisor_waits_for_its_providers_before_it_reads_as_interrupted(self):
        recent = self.call(started_ago=600)
        orphaned = self.call(started_ago=agent_interface.ORPHAN_AFTER_SECONDS + 60)
        with patch.object(agent_interface, "init_started_at", return_value=self.now - 30 * 3600), \
                patch.object(agent_interface, "process_command", return_value=None):
            self.assertEqual(agent_interface.reap_interrupted(), 1)
        self.assertEqual(self.row(recent)["status"], "running")
        self.assertEqual(self.row(orphaned)["error_code"], "interrupted")

    def test_a_reused_pid_does_not_keep_an_old_call_running_but_a_live_worker_does(self):
        reused = self.call(started_ago=agent_interface.ORPHAN_AFTER_SECONDS + 60, pid="4242")
        live = self.call(started_ago=agent_interface.ORPHAN_AFTER_SECONDS + 60, pid="4243")
        commands = {4242: "sleep 100", 4243: AGENT}
        with patch.object(agent_interface, "init_started_at", return_value=None), \
                patch.object(agent_interface, "process_command", side_effect=commands.get):
            self.assertEqual(agent_interface.reap_interrupted(), 1)
        self.assertEqual(self.row(reused)["error_code"], "interrupted")
        self.assertEqual(self.row(live)["status"], "running")

    def test_a_call_being_stopped_reads_as_stopped(self):
        id_ = self.call(started_ago=2 * 3600, error_code="stopping")
        agent_interface.reap_interrupted()
        self.assertEqual((self.row(id_)["error"], self.row(id_)["error_code"]), ("Stopped by user", "stopped"))

    def test_a_stop_stays_a_stop_when_the_call_is_reaped_meanwhile(self):
        id_ = self.call(started_ago=60)

        def reaped_meanwhile(pid, signum):
            # The container's init is newer than the call now, as after a restart mid-stop.
            with patch.object(agent_interface, "init_started_at", return_value=self.now):
                agent_interface.reap_interrupted()

        with patch.object(agent_interface, "process_command", side_effect=[AGENT, None, None]), \
                patch.object(agent_interface, "signal_group", side_effect=reaped_meanwhile):
            result = agent_interface.stop_call(id_)
        self.assertEqual(result, {"id": id_, "stopped": True, "status": "failed", "error_code": "stopped"})
        self.assertEqual(self.row(id_)["error_code"], "stopped")

    def test_a_stop_between_the_reapers_read_and_its_write_stays_a_stop(self):
        id_ = self.call(started_ago=agent_interface.ORPHAN_AFTER_SECONDS + 60)
        read, killed, reaped = threading.Event(), threading.Event(), threading.Event()

        def command(pid):
            if threading.current_thread() is reaper:
                # The reaper has read the row; the stop marks it and ends its worker now.
                read.set()
                killed.wait(5)
                return None
            return None if killed.is_set() else AGENT

        def kill(pid, signum):
            killed.set()
            # The reaper writes before the stop's own last update.
            reaped.wait(5)

        def reap():
            agent_interface.reap_interrupted()
            reaped.set()

        reaper = threading.Thread(target=reap)
        with patch.object(agent_interface, "init_started_at", return_value=None), \
                patch.object(agent_interface, "process_command", side_effect=command), \
                patch.object(agent_interface, "signal_group", side_effect=kill):
            reaper.start()
            self.assertTrue(read.wait(5))
            result = agent_interface.stop_call(id_)
            reaper.join(5)
        self.assertEqual(result, {"id": id_, "stopped": True, "status": "failed", "error_code": "stopped"})
        self.assertEqual((self.row(id_)["error"], self.row(id_)["error_code"]), ("Stopped by user", "stopped"))

    def test_finished_calls_turns_and_calls_without_a_pid_are_left_alone(self):
        done = self.call(started_ago=2 * 3600, status="completed")
        turn = self.call(started_ago=2 * 3600, pid=None, runner=agent_interface.EXTERNAL_RUNNER)
        old = self.call(started_ago=2 * 3600, pid=None)
        self.assertEqual(agent_interface.reap_interrupted(), 0)
        self.assertEqual(self.row(done)["status"], "completed")
        self.assertEqual(self.row(turn)["status"], "running")
        self.assertEqual(self.row(old)["status"], "running")
