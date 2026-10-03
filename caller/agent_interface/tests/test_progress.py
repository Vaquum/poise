import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from time import monotonic, sleep
from contextlib import redirect_stdout
from unittest import TestCase
from unittest.mock import patch

import agent_interface
from agent_interface import atoms, progress
from agent_interface.provider_progress import ProviderStream, claude_error, claude_result
from agent_interface.review_watch import ReviewWatch

PR = "https://github.com/o/r/pull/12"
HEAD = "a" * 40


class TestProgress(TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.database = Path(self.work.name) / "calls.sqlite3"
        with sqlite3.connect(self.database) as db:
            db.execute("create table calls(id text, ended_at real, progress text)")
            db.execute("insert into calls values('run', null, null)")

    def saved(self):
        with sqlite3.connect(self.database) as db:
            return json.loads(db.execute("select progress from calls where id='run'").fetchone()[0])

    def test_silent_provider_has_heartbeat_but_no_invented_model_activity(self):
        with patch.object(progress, "HEARTBEAT_SECONDS", .02), progress.Progress(self.database, "run"):
            first = self.saved()["heartbeat_at"]
            progress.stage("waiting_provider", "Waiting for provider", timeout=60)
            deadline = monotonic() + 2
            while self.saved()["heartbeat_at"] == first and monotonic() < deadline:
                sleep(.01)
            saved = self.saved()
            self.assertNotEqual(saved["heartbeat_at"], first)
            self.assertIsNone(saved["last_provider_event_at"])
            self.assertEqual(saved["phase"], "waiting_provider")
            self.assertIsNotNone(saved["deadline_at"])
        after = self.saved()["heartbeat_at"]
        sleep(.05)
        self.assertEqual(self.saved()["heartbeat_at"], after)

    def test_partial_unicode_lines_and_oversized_events_recover_without_storing_content(self):
        secret = "private prompt / token / reasoning é"
        with progress.Progress(self.database, "run") as reporter:
            stream = ProviderStream("claude")
            event = {"type": "stream_event", "event": {"delta": {"type": "thinking_delta", "thinking": secret}}}
            encoded = (json.dumps(event, ensure_ascii=False) + "\n").encode()
            for byte in encoded:
                stream.feed(bytes([byte]))
            stream.feed(b"invalid\n" + b"x" * (1024 * 1024 + 1) + b"\n")
            stream.feed(b'{"type":"system","subtype":"api_retry","error":"rate_limit","attempt":2,"retry_delay_ms":3000}\n')
            reporter.flush()
            saved = self.saved()
            self.assertEqual(saved["phase"], "retrying")
            self.assertIn("rate limit; attempt 2; waiting 3s", saved["events"][-1]["message"])
            self.assertTrue(saved["last_provider_event_at"])
            self.assertIsNotNone(saved["warning"])
            self.assertNotIn(secret, json.dumps(saved))

    def test_history_is_bounded_and_old_snapshots_cannot_overwrite_a_terminal_record(self):
        with progress.Progress(self.database, "run") as reporter:
            for index in range(100):
                progress.stage("retrying", f"Retry {index}")
            terminal = progress.terminal("completed")
            with sqlite3.connect(self.database) as db:
                db.execute("update calls set ended_at=1, progress=?", (terminal,))
            saved = self.saved()
            self.assertEqual(saved["phase"], "completed")
            self.assertLessEqual(len(saved["events"]), 20)
            progress.stage("reasoning", "Late event")
            reporter.flush()
            self.assertEqual(self.saved(), saved)

    def test_recording_failure_never_fails_the_provider_or_fakes_a_new_heartbeat(self):
        with progress.Progress(self.database, "run") as reporter:
            before = self.saved()
            with patch.object(progress.sqlite3, "connect", side_effect=sqlite3.OperationalError("locked")), patch.object(progress.sys, "stderr", io.StringIO()) as stderr:
                reporter.flush()
                reporter.flush()
                self.assertEqual(stderr.getvalue().count("recording unavailable"), 1)
            self.assertEqual(self.saved(), before)

    def test_reasoning_write_failure_preserves_heartbeats_and_recovers_without_stale_text_counts(self):
        with progress.Progress(self.database, "run") as reporter:
            progress.provider_event("reasoning", "Provider reported reasoning activity", "First summary")
            reporter.flush()
            previous = self.saved()
            progress.provider_event("reasoning", "Provider reported reasoning activity", " New evidence")
            with patch.object(Path, "write_text", side_effect=PermissionError("unwritable")):
                sleep(.01)
                reporter.flush()
            saved = self.saved()
            self.assertNotEqual(saved["heartbeat_at"], previous["heartbeat_at"])
            self.assertEqual(saved["reasoning_chars"], len("First summary"))
            self.assertEqual(saved["warning"], progress.REASONING_WARNING)
            self.assertEqual(reporter.reasoning_path.read_text(), "First summary")
            reporter.flush()
            self.assertEqual(self.saved()["reasoning_chars"], len("First summary New evidence"))
            self.assertIsNone(self.saved()["warning"])
            progress.warning()
            reporter.flush()
            self.assertIsNotNone(self.saved()["warning"])

    def test_malformed_reasoning_text_cannot_prevent_terminal_outcome(self):
        with progress.Progress(self.database, "run"):
            progress.provider_event("reasoning", "Provider reported reasoning activity", "\ud800")
            result = json.loads(progress.terminal("completed"))
            self.assertEqual(result["phase"], "completed")
            self.assertEqual(result["reasoning_chars"], 0)
            self.assertFalse(result["reasoning_available"])
            self.assertEqual(result["warning"], progress.REASONING_WARNING)

    def test_receives_events_before_worker_exit_and_preserves_stdout_bytes(self):
        event = {"type": "item.completed", "item": {"type": "reasoning", "text": "private reasoning"}}
        encoded = json.dumps(event) + "\n"
        with patch.object(progress, "HEARTBEAT_SECONDS", .02), progress.Progress(self.database, "run"), \
                ReviewWatch("/tmp", PR, "bit-mis", HEAD) as watch:
            def inspect_head(_timeout):
                saved = self.saved()
                self.assertEqual(saved["phase"], "reasoning")
                self.assertTrue(saved["last_provider_event_at"])
                return None
            with patch('agent_interface.review_watch.PROGRESS_SECONDS', .01), \
                    patch('agent_interface.review_watch.POLL_SECONDS', .15), \
                    patch.object(watch, "changed_head", side_effect=inspect_head) as check:
                done = watch.run([sys.executable, "-c", f"import sys,time; sys.stdout.write({encoded!r}); sys.stdout.flush(); time.sleep(.35)"],
                                 input="packet", cwd="/tmp", timeout=3, env=os.environ.copy(), provider="codex")
            self.assertGreater(check.call_count, 0)
            self.assertEqual(done.stdout, encoded)

    def test_progress_read_failure_does_not_abort_model_execution(self):
        with progress.Progress(self.database, "run"), ReviewWatch("/tmp", PR, "bit-mis", HEAD) as watch, \
                patch('agent_interface.provider_progress.os.pread', side_effect=OSError("failed")):
            done = watch.run([sys.executable, "-c", "print('done')"], input="", cwd="/tmp", timeout=3, env=os.environ.copy(), provider="claude")
        self.assertEqual(done.returncode, 0)
        self.assertEqual(done.stdout, "done\n")
        self.assertTrue(self.saved()["warning"])

    def test_crashed_worker_stops_heartbeats(self):
        code = (
            "import time; from pathlib import Path; from agent_interface import progress; "
            "progress.HEARTBEAT_SECONDS=.02; "
            f"reporter=progress.Progress(Path({str(self.database)!r}), 'run'); "
            "reporter.__enter__(); time.sleep(30)"
        )
        child = subprocess.Popen([sys.executable, "-c", code], stderr=subprocess.PIPE)
        try:
            deadline = monotonic() + 3
            while monotonic() < deadline:
                with sqlite3.connect(self.database) as db:
                    if db.execute("select progress from calls").fetchone()[0]:
                        break
                sleep(.01)
            child.kill()
            child.communicate(timeout=3)
            saved = self.saved()
            sleep(.08)
            self.assertEqual(self.saved()["heartbeat_at"], saved["heartbeat_at"])
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate(timeout=3)

    def test_missing_final_claude_event_leaves_outcome_to_authoritative_github_facts(self):
        with tempfile.TemporaryDirectory() as work, \
                patch.object(agent_interface, "DB", Path(work) / "calls.sqlite3"), \
                patch.object(agent_interface, "RESPONSES", Path(work) / "responses"), \
                patch.object(agent_interface, "review_facts", return_value={}), \
                patch.object(atoms, "packet", return_value="packet"), \
                patch.object(ReviewWatch, "run", return_value=subprocess.CompletedProcess([], 0, "malformed\n", "")), \
                patch.object(agent_interface, "behavior_outcome", return_value={"outcome": "approved", "action": "approved", "head_sha": HEAD}) as facts, \
                redirect_stdout(io.StringIO()):
            agent_interface.init_db()
            agent_interface.run_pr_approve(PR, "bit-mis", HEAD, "poise:test", "progress-test")
            row = agent_interface.logs()[0]
            self.assertEqual(row["status"], "completed")
            self.assertEqual(row["outcome"], "approved")
            self.assertEqual(row["progress"]["phase"], "completed")
            facts.assert_called_once()

    def test_claude_final_result_and_errors_are_read_without_partial_text(self):
        for body, result in [({"result": "done"}, "done"), ({"errors": ["limit reached"]}, "limit reached")]:
            output = json.dumps({"type": "assistant", "message": "private intermediate text"}) + "\n"
            output += json.dumps({"type": "result", **body})
            self.assertEqual(claude_result(output), result)

    def test_plain_cli_failure_remains_visible_without_dumping_json_payloads(self):
        self.assertEqual(claude_error("CLI startup failed\n"), "CLI startup failed")
        self.assertEqual(claude_error(json.dumps({"type": "assistant", "message": "private content", "error": "rate_limit"})), "rate_limit")


    def test_output_limit_failure_keeps_exact_error_and_observed_history(self):
        error = "API Error: Claude's response exceeded the 64000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable."
        for body in ({"result": error}, {"errors": [error]}):
            output = json.dumps({"type": "result", "subtype": "error_during_execution", "is_error": True, **body}) + "\n"
            def failed_provider(*args, **kwargs):
                ProviderStream("claude").feed(output.encode())
                return subprocess.CompletedProcess([], 1, output, "Nonfatal CLI warning")
            with self.subTest(body=body), tempfile.TemporaryDirectory() as work, \
                    patch.object(agent_interface, "DB", Path(work) / "calls.sqlite3"), \
                    patch.object(agent_interface, "RESPONSES", Path(work) / "responses"), \
                    patch.object(agent_interface, "review_facts", return_value={}), \
                    patch.object(atoms, "packet", return_value="packet"), \
                    patch.object(ReviewWatch, "run", side_effect=failed_provider), \
                    patch.object(agent_interface, "behavior_outcome") as facts, \
                    redirect_stdout(io.StringIO()):
                agent_interface.init_db()
                with self.assertRaises(SystemExit):
                    agent_interface.run_pr_approve(PR, "bit-mis", HEAD, "poise:test", "output-limit-test")
                row = agent_interface.logs()[0]
                self.assertEqual(row["status"], "failed")
                self.assertIn(error, row["error"])
                self.assertEqual(row["error_code"], "model_output_limit")
                self.assertIsNone(row["outcome"])
                self.assertEqual(row["progress"]["phase"], "failed")
                self.assertIn("Provider reported an error", [event["message"] for event in row["progress"]["events"]])
                facts.assert_not_called()


class TestOtherProviderStreams(TestCase):
    """Antigravity, Muse and Grok name their events differently; the stages are the same."""

    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.database = Path(self.work.name) / "calls.sqlite3"
        with sqlite3.connect(self.database) as db:
            db.execute("create table calls(id text, ended_at real, progress text)")
            db.execute("insert into calls values('run', null, null)")

    def phases(self, provider, events):
        seen = []
        with progress.Progress(self.database, "run"), \
                patch.object(progress, "provider_event", side_effect=lambda phase=None, message=None, reasoning=None: seen.append((phase, reasoning))):
            stream = ProviderStream(provider)
            stream.feed("".join(json.dumps(event) + "\n" for event in events).encode())
        return seen

    def test_antigravity_steps_map_to_stages_without_copying_text(self):
        seen = self.phases("antigravity", [
            {"event": "init", "conversation_id": "c1"},
            {"event": "step_update", "step_update": {"step_type": "user_input", "state": "DONE"}},
            {"event": "step_update", "step_update": {"step_type": "agent_response", "state": "ACTIVE", "text_delta": "secret answer"}},
            {"event": "step_update", "step_update": {"step_type": "tool", "state": "ACTIVE", "tool_name": "run_command"}},
            {"event": "step_update", "step_update": {"step_type": "finish", "state": "DONE"}},
            {"event": "result", "result": {"status": "SUCCESS", "response": "secret answer"}},
            {"event": "result", "result": {"status": "ERROR", "error": "quota"}},
        ])
        self.assertEqual([phase for phase, _ in seen],
                         ["waiting_provider", None, "responding", "tool_running", None, "provider_finished", "provider_error"])
        self.assertTrue(all(reasoning is None for _, reasoning in seen))

    def test_muse_events_map_to_stages_without_copying_text(self):
        seen = self.phases("muse", [
            {"payload_type": "run.lifecycle.started", "payload": {"kind": "run_started"}},
            {"payload_type": "task.lifecycle.proposed", "payload": {"event": {"task_kind": "model.meta.response"}}},
            {"payload_type": "task.lifecycle.proposed", "payload": {"event": {"task_kind": "tool.read_file"}}},
            {"payload_type": "run.output.delta", "payload": {"text": "secret answer"}},
            {"payload_type": "run.terminal.completed", "payload": {"terminal": "completed", "text": "secret answer"}},
            {"payload_type": "run.terminal.failed", "payload": {"terminal": "failed", "reason": "boom"}},
        ])
        self.assertEqual([phase for phase, _ in seen],
                         ["waiting_provider", None, "tool_running", "responding", "provider_finished", "provider_error"])
        self.assertTrue(all(reasoning is None for _, reasoning in seen))

    def test_grok_stream_maps_to_stages_and_keeps_only_exposed_reasoning(self):
        seen = self.phases("grok", [
            {"type": "available_commands", "tools": ["run_terminal_command"]},
            {"type": "thought", "data": "Check the head"},
            {"type": "text", "data": "secret answer"},
            {"type": "tool_call", "toolCallId": "t1", "toolName": "run_terminal_command", "rawInput": {"command": "git log"}},
            {"type": "tool_call_update", "toolCallId": "t1", "rawOutput": "secret output"},
            {"type": "end", "stopReason": "end_turn"},
            {"type": "end", "stopReason": "max_tokens"},
        ])
        self.assertEqual([phase for phase, _ in seen],
                         [None, "reasoning", "responding", "tool_running", "tool_running", "provider_finished", "provider_error"])
        self.assertEqual([reasoning for _, reasoning in seen if reasoning], ["Check the head"])
