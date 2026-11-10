import json
import os
import tempfile
import threading
from pathlib import Path
from time import time
from unittest import TestCase
from unittest.mock import MagicMock, patch

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

        pinned = MagicMock()
        pinned.__enter__.return_value.signal.side_effect = lambda sig: reaped_meanwhile(4242, sig)
        pinned.__enter__.return_value.wait.return_value = True
        with patch.object(agent_interface, "process_command", side_effect=[AGENT, None, None]), \
                patch.object(agent_interface.process_identity, "pinned", return_value=pinned):
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
        pinned = MagicMock()
        pinned.__enter__.return_value.signal.side_effect = lambda sig: kill(4242, sig)
        pinned.__enter__.return_value.wait.return_value = True
        with patch.object(agent_interface, "init_started_at", return_value=None), \
                patch.object(agent_interface, "process_command", side_effect=command), \
                patch.object(agent_interface.process_identity, "pinned", return_value=pinned):
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

    def test_native_cleanup_failure_survives_recovery_without_freeing_its_resources(self):
        for previous_epoch in (False, True):
            for status in ("running", "completed", "failed"):
                with self.subTest(previous_epoch=previous_epoch, status=status):
                    id_ = agent_interface.track("fixture-model", "original review", repo="acme/app", pr_id="7",
                                                actor="reviewer", behavior="pr_review", expected_head="a" * 40,
                                                source="poise:behavior-chain")
                    root = Path(self.work.name) / id_
                    root.mkdir()
                    retained = root / "owned-build-output"
                    retained.write_bytes(b"not yet reclaimed")
                    artifact = json.dumps({"phase": "review_submitted", "resource_root": str(root),
                                           "resource_error": "cleanup_failed"})
                    receipts = json.dumps([{"review_id": 91}])
                    with agent_interface.db() as conn:
                        conn.execute("update calls set pid='4242', status=?, started_at=?, artifact=?, "
                                     "action_plan=?, receipts=?, review_id=91 where id=?",
                                     (status, self.now - 7200, artifact, "original publication plan", receipts, id_))
                    epoch = self.now - 3600 if previous_epoch else self.now - 10800
                    with patch.object(agent_interface, "init_started_at", return_value=epoch), \
                            patch.object(agent_interface, "process_command", return_value=None), \
                            patch.object(agent_interface.issue_review, "_cwd_pids", return_value=[]):
                        agent_interface.reap_interrupted()
                    with agent_interface.db() as conn:
                        row = conn.execute("select artifact, action_plan, receipts, review_id, resources_settled_at "
                                           "from calls where id=?", (id_,)).fetchone()
                    self.assertIsNone(row["resources_settled_at"], "process loss is not disposable disk reclamation")
                    self.assertTrue(retained.is_file())
                    self.assertEqual((row["artifact"], row["action_plan"], row["receipts"], row["review_id"]),
                                     (artifact, "original publication plan", receipts, "91"))

    def test_another_pid_namespace_cannot_interrupt_a_native_supervisor(self):
        identity = agent_interface.process_identity
        outer = {"boot": "boot", "init_start": "10", "namespace_dev": 1, "namespace_ino": 2}
        inner = {**outer, "init_start": "20", "namespace_ino": 3}
        with patch.object(identity, "epoch", return_value=outer), patch.object(identity, "_start", return_value="42"):
            call = agent_interface.track("fixture-model", "native observer", repo="acme/app",
                                         behavior="pr_review", source="poise:behavior-chain")
            self.assertEqual(agent_interface.reap_interrupted(), 0)
        with patch.object(identity, "epoch", return_value=inner), patch.object(identity, "_start") as start, \
                patch.object(agent_interface.caller_store, "observes_workspace_supervisor", return_value=False):
            entries = agent_interface.logs(status="running")
            start.assert_not_called()
        self.assertIn(call, {entry["id"] for entry in entries})
        self.assertEqual(self.row(call)["status"], "running")
        with patch.object(identity, "epoch", return_value=outer), patch.object(identity, "_start", side_effect=FileNotFoundError):
            self.assertEqual(agent_interface.reap_interrupted(), 1)
        self.assertEqual(self.row(call)["error_code"], "interrupted")

    def test_an_old_reader_cannot_reap_a_native_registration_from_a_new_release(self):
        identity = agent_interface.process_identity
        epoch = {"boot": "boot", "init_start": "10", "namespace_dev": 1, "namespace_ino": 2}
        with patch.object(identity, "epoch", return_value=epoch), patch.object(identity, "_start", return_value="42"):
            call = agent_interface.track("fixture-model", "mixed release", repo="acme/app",
                                         behavior="pr_review", source="poise:behavior-chain")
            with agent_interface.db() as conn:
                recorded = conn.execute("select process_identity from calls where id=?", (call,)).fetchone()[0]
            self.assertTrue(identity.owns_registration(recorded))
            self.assertEqual(identity.state(identity.capture(os.getpid()), os.getpid()), "alive")

        def old_reader(encoded, _pid, *_args):
            if json.loads(encoded)["version"] != 1:
                raise RuntimeError("call lacks a verified process identity")
            return "different"

        with patch.object(identity, "state", side_effect=old_reader):
            self.assertEqual(agent_interface.reap_interrupted(), 0)
        self.assertEqual(self.row(call)["status"], "running")

    def test_a_verified_workspace_observer_reaps_a_previous_epoch(self):
        identity = agent_interface.process_identity
        original = {"boot": "boot", "init_start": "10", "namespace_dev": 1, "namespace_ino": 2}
        replacement = {**original, "init_start": "20", "namespace_ino": 3}
        with patch.object(identity, "epoch", return_value=original), patch.object(identity, "_start", return_value="42"):
            call = agent_interface.track("fixture-model", "workspace replacement", repo="acme/app",
                                         behavior="pr_review", source="poise:behavior-chain")
        with patch.object(identity, "epoch", return_value=replacement), patch.object(identity, "_start") as start, \
                patch.object(agent_interface.caller_store, "observes_workspace_supervisor", return_value=True):
            row = agent_interface.logs_selected({"latest": [], "ids": [call]})[0]
            start.assert_not_called()
        self.assertEqual((row["status"], row["error_code"]), ("failed", "interrupted"))
        self.assertIsNone(row["resources_settled_at"])

    def test_a_forward_wall_clock_step_does_not_interrupt_or_release_a_live_native_supervisor(self):
        call = agent_interface.track("fixture-model", "native epoch contract", repo="acme/app", pr_id="7",
                                     actor="reviewer", behavior="pr_review", source="poise:behavior-chain")
        with patch.object(agent_interface, "init_started_at", return_value=self.now + 24 * 3600), \
                patch.object(agent_interface, "process_command", return_value=AGENT):
            agent_interface.reap_interrupted()
        with agent_interface.db() as conn:
            row = conn.execute("select status,resources_settled_at from calls where id=?", (call,)).fetchone()
        self.assertEqual((row["status"], row["resources_settled_at"]), ("running", None))
