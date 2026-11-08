import io
import json
import os
import signal
import tempfile
from time import monotonic, sleep
import subprocess
import sys
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

import agent_interface
from agent_interface import atoms, bash_guard, claude_acl, pr_review, structured_review
from agent_interface.model_catalog import CATALOG
from agent_interface.review_gate import cancel_when_idle, submission_gate
from agent_interface import review_watch
from agent_interface.review_budget import ReviewBudget, ReviewLimitError
from agent_interface.review_watch import RateLimitAbort, ReviewSuperseded, ReviewWatch

HEAD = "a" * 40
NEW_HEAD = "b" * 40
PR = "https://github.com/o/r/pull/12"
# A cut response loses its reasoning, so one that needs more than the cap never
# finishes. Measured on the canary#170 approval that ran out the budget: 86,958
# and 88,480 output tokens.
CUT_PROVIDER = f"""#!{sys.executable}
import json, sys, time
cap = json.loads(sys.argv[sys.argv.index("--settings") + 1])["env"]["CLAUDE_CODE_MAX_OUTPUT_TOKENS"]
sys.stdin.read()
while int(cap) < 88000:
    print(json.dumps({{"type": "user", "isSynthetic": True, "message": {{"role": "user", "content": [{{"type": "text", "text": "Output token limit hit."}}]}}}}), flush=True)
    time.sleep(0.1)
print(json.dumps({{"type": "result", "subtype": "success", "is_error": False, "result": "approved"}}), flush=True)
"""


class TestOutputLimit(TestCase):
    def test_approval_that_outgrows_a_64000_token_response_returns_inside_the_budget(self):
        with tempfile.TemporaryDirectory() as folder:
            cli = Path(folder) / "claude"
            cli.write_text(CUT_PROVIDER)
            cli.chmod(0o755)
            with patch.dict(os.environ, {"CLAUDE_CLI": str(cli)}), ReviewBudget(25):
                self.assertEqual(atoms.run_agent(folder, "system", "packet", ["Bash(github-interface *)"], "pr_approve",
                                                 pr=PR, actor_name="bit-mis", head=HEAD), "approved")


class TestHeadObservation(TestCase):
    def test_only_an_authoritative_change_for_the_exact_target_cancels(self):
        valid = {"action": "head_sha", "repository": "o/r", "pull_number": 12, "head_sha": NEW_HEAD}
        cases = [
            (valid, NEW_HEAD),
            ({**valid, "head_sha": HEAD}, None),
            ({**valid, "repository": "o/other"}, None),
            ({**valid, "pull_number": 13}, None),
            ({**valid, "pull_number": "12"}, None),
            ({**valid, "head_sha": "z" * 40}, None),
            ({**valid, "action": "wrong"}, None),
            ({}, None), (None, None),
        ]
        watch = ReviewWatch("/tmp", PR, "bit-mis", HEAD)
        for body, changed in cases:
            with self.subTest(body=body), patch.object(review_watch.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=json.dumps(body))) as run:
                self.assertEqual(watch.changed_head(10), changed)
                self.assertEqual(run.call_args.args[0], ["github-interface", "--head-sha", "#12", "--repository", "o/r", "--token-user", "bit-mis"])
                self.assertEqual(run.call_args.kwargs["timeout"], 10)

    def test_transient_or_malformed_checks_do_not_cancel(self):
        watch = ReviewWatch("/tmp", PR, "bit-mis", HEAD)
        for result in (SimpleNamespace(returncode=1, stdout="failure"), SimpleNamespace(returncode=0, stdout="{")):
            with patch.object(review_watch.subprocess, "run", return_value=result):
                self.assertIsNone(watch.changed_head(10))
        for error in (OSError("unavailable"), subprocess.TimeoutExpired("github-interface", 10)):
            with patch.object(review_watch.subprocess, "run", side_effect=error):
                self.assertIsNone(watch.changed_head(10))


class TestSubmissionGate(TestCase):
    def test_cancellation_refuses_a_gate_with_a_sealed_submission(self):
        with ReviewWatch("/tmp", PR, "bit-mis", HEAD) as watch:
            with submission_gate(watch.gate_path) as gate:
                gate.seal()
            self.assertFalse(cancel_when_idle(watch.gate_path))
            self.assertEqual(Path(watch.gate_path).read_text(), "submitted\n")

    def test_uncertain_gate_blocks_new_commands_until_reconciled(self):
        with ReviewWatch("/tmp", PR, "bit-mis", HEAD) as watch:
            with submission_gate(watch.gate_path) as gate:
                gate.mark_uncertain()
            with self.assertRaisesRegex(RuntimeError, "uncertain; blocked until reconciled"):
                with submission_gate(watch.gate_path):
                    self.fail("uncertain review acquired permission to submit")
            self.assertTrue(cancel_when_idle(watch.gate_path))
            with self.assertRaisesRegex(RuntimeError, "uncertain; blocked until reconciled"):
                with submission_gate(watch.gate_path):
                    self.fail("cancelled uncertain review acquired permission to submit")

    def test_cancellation_waits_for_submission_and_then_blocks_new_commands(self):
        with ReviewWatch("/tmp", PR, "bit-mis", HEAD) as watch:
            with submission_gate(watch.gate_path):
                self.assertFalse(cancel_when_idle(watch.gate_path))
            self.assertTrue(cancel_when_idle(watch.gate_path))
            with self.assertRaisesRegex(RuntimeError, "superseded"):
                with submission_gate(watch.gate_path):
                    self.fail("cancelled review acquired permission to submit")

    def test_claude_settings_forward_the_gate_through_the_subscription_wrapper(self):
        with patch.object(ReviewWatch, "run", return_value=SimpleNamespace(returncode=0, stdout="ok", stderr="")) as run:
            atoms.run_agent("/tmp", "system", "packet", ["Bash(github-interface *)"], "pr_review", pr=PR, actor_name="bit-mis", head=HEAD)
            args = run.call_args.args[0]
            config = json.loads(args[args.index("--settings") + 1])
            self.assertIn("AGENT_INTERFACE_REVIEW_GATE", config["env"])
            self.assertEqual(config["env"]["CLAUDE_CODE_MAX_OUTPUT_TOKENS"], "128000")
            self.assertEqual(config["permissions"]["allow"], ["Bash(github-interface *)"])
        # Other Claude behaviors keep their existing settings.
        self.assertNotIn("env", json.loads(claude_acl.settings([])))

    def test_failed_provider_revokes_future_submissions_before_returning(self):
        with ReviewWatch('/tmp', PR, 'bit-mis', HEAD) as watch:
            result = watch.run([sys.executable, '-c', 'raise SystemExit(1)'], input='', cwd='/tmp', timeout=5, env=os.environ.copy())
            self.assertEqual(result.returncode, 1)
            with self.assertRaises(RuntimeError), submission_gate(watch.gate_path):
                self.fail('failed provider may not submit')

    def test_provider_exit_during_submission_never_allows_recovery(self):
        from agent_interface.review_budget import ReviewLimitError
        with ReviewWatch('/tmp', PR, 'bit-mis', HEAD) as watch, submission_gate(watch.gate_path):
            with self.assertRaises(ReviewLimitError) as error:
                watch.run([sys.executable, '-c', 'raise SystemExit(1)'], input='', cwd='/tmp', timeout=5, env=os.environ.copy())
            self.assertEqual(error.exception.code, 'review_recovery_failed')

    def test_guard_never_executes_after_cancellation_or_gate_cleanup(self):
        command = f"github-interface --reviewed-clean #12 --expected-head {HEAD} --token-user bit-mis"
        with ReviewWatch("/tmp", PR, "bit-mis", HEAD) as watch:
            cancel_when_idle(watch.gate_path)
            for missing in (False, True):
                if missing:
                    Path(watch.gate_path).unlink()
                with patch.dict(os.environ, {"AGENT_INTERFACE_BASH_ALLOW": json.dumps([command]), "AGENT_INTERFACE_REVIEW_GATE": watch.gate_path}), \
                        patch.object(sys, "argv", ["bash_guard.py", command]), \
                        patch.object(bash_guard.subprocess, "run") as run, \
                        self.assertRaises((RuntimeError, FileNotFoundError)):
                    bash_guard.main()
                run.assert_not_called()

    def test_guard_as_an_executable_blocks_a_cancelled_command(self):
        command = "github-interface --reviewed-clean #12"
        with ReviewWatch("/tmp", PR, "bit-mis", HEAD) as watch:
            cancel_when_idle(watch.gate_path)
            done = subprocess.run([sys.executable, bash_guard.__file__, command], text=True, capture_output=True,
                                  env={**os.environ, "AGENT_INTERFACE_BASH_ALLOW": json.dumps([command]), "AGENT_INTERFACE_REVIEW_GATE": watch.gate_path})
            self.assertNotEqual(done.returncode, 0)
            self.assertIn("superseded", done.stderr)


class TestSupervisedProcess(TestCase):
    def setUp(self):
        self.timing = patch.multiple(review_watch, POLL_SECONDS=0.03, STOP_GRACE_SECONDS=0.05)
        self.timing.start()
        self.addCleanup(self.timing.stop)

    def run_worker(self, watch, script, timeout=3, prompt="input"):
        return watch.run([sys.executable, "-c", script], input=prompt, cwd="/tmp", timeout=timeout, env=os.environ.copy())

    def test_failed_checks_keep_running_and_large_io_cannot_block_the_watcher(self):
        prompt = "x" * (1024 * 1024)
        with ReviewWatch("/tmp", PR, "bit-mis", HEAD) as watch, patch.object(watch, "changed_head", return_value=None) as check:
            done = self.run_worker(watch, "import sys,time; text=sys.stdin.read(); sys.stdout.write(text); sys.stderr.write(text); time.sleep(.15)", prompt=prompt)
            self.assertEqual(done.stdout, prompt)
            self.assertEqual(done.stderr, prompt)
            self.assertEqual(done.returncode, 0)
            self.assertGreater(check.call_count, 0)

    def test_submission_during_head_check_wins_over_cancellation(self):
        worker = (
            "import fcntl, sys, time; gate_path, receipt_path = sys.argv[1], sys.argv[2]; "
            "gate = open(gate_path, 'r+'); fcntl.flock(gate, fcntl.LOCK_EX); "
            "open(receipt_path, 'w').write('{\"action\": \"requested_changes\", \"review_id\": 91, "
            "\"head_sha\": \"" + HEAD + "\"}'); "
            "gate.seek(0, 2); gate.write('submitted\\n'); gate.flush(); time.sleep(.3)"
        )
        with ReviewWatch("/tmp", PR, "bit-mis", HEAD) as watch:
            def head(_timeout):
                deadline = monotonic() + 5
                while "submitted" not in Path(watch.gate_path).read_text():
                    self.assertLess(monotonic(), deadline, "provider never submitted")
                    sleep(.01)
                return NEW_HEAD
            with patch.object(watch, "changed_head", side_effect=head):
                done = watch.run([sys.executable, "-c", worker, watch.gate_path, watch.receipt_path],
                                 input="", cwd="/tmp", timeout=10, env=os.environ.copy())
            self.assertEqual(done.returncode, 0)
            self.assertEqual(Path(watch.gate_path).read_text(), "submitted\n")
            from agent_interface import review_receipt
            self.assertEqual((review_receipt.get() or {}).get("review_id"), 91)

    def test_completion_during_head_check_wins_over_cancellation(self):
        with ReviewWatch("/tmp", PR, "bit-mis", HEAD) as watch:
            real_popen = subprocess.Popen
            children = []
            def launch(*args, **kwargs):
                child = real_popen(*args, **kwargs)
                children.append(child)
                return child
            def head(_timeout):
                children[0].wait(timeout=2)
                return NEW_HEAD
            with patch.object(review_watch.subprocess, "Popen", side_effect=launch), patch.object(watch, "changed_head", side_effect=head):
                done = self.run_worker(watch, "import time; time.sleep(.15); print('done')")
            self.assertEqual(done.stdout, "done\n")
            self.assertEqual(Path(watch.gate_path).read_text(), "")

    def test_changed_head_does_not_interrupt_a_submission_in_progress(self):
        with ReviewWatch("/tmp", PR, "bit-mis", HEAD) as watch:
            gate = submission_gate(watch.gate_path)
            gate.__enter__()
            checks = 0
            def head(_timeout):
                nonlocal checks
                checks += 1
                if checks == 2:
                    gate.__exit__(None, None, None)
                return NEW_HEAD
            with patch.object(watch, "changed_head", side_effect=head), self.assertRaises(ReviewSuperseded):
                self.run_worker(watch, "import time; time.sleep(10)")
            self.assertEqual(checks, 2)
            self.assertEqual(Path(watch.gate_path).read_text(), "cancelled\n")

    def test_cancel_stops_the_provider_and_signal_resistant_descendant(self):
        with ReviewWatch("/tmp", PR, "bit-mis", HEAD) as watch:
            pid_file = Path(watch.gate_path).parent / "child.pid"
            child_code = "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)"
            script = ("import os,subprocess,sys,time; from pathlib import Path; "
                      f"child=subprocess.Popen([sys.executable,'-c',{child_code!r}]); "
                      f"Path({str(pid_file)!r}).write_text(str(child.pid)); time.sleep(30)")
            def head(_timeout):
                return NEW_HEAD if pid_file.exists() else None
            with patch.object(watch, "changed_head", side_effect=head), self.assertRaises(ReviewSuperseded) as cancelled:
                self.run_worker(watch, script)
            self.assertEqual(cancelled.exception.head_sha, NEW_HEAD)
            child_pid = int(pid_file.read_text())
            state = subprocess.run(["ps", "-o", "stat=", "-p", str(child_pid)], text=True, capture_output=True).stdout.strip()
            self.assertTrue(not state or state.startswith("Z"), state)

    def test_timeout_reaps_the_provider(self):
        real_popen = subprocess.Popen
        children = []
        def launch(*args, **kwargs):
            child = real_popen(*args, **kwargs)
            children.append(child)
            return child
        with ReviewWatch("/tmp", PR, "bit-mis", HEAD) as watch, \
                patch.object(review_watch.subprocess, "Popen", side_effect=launch), \
                patch.object(watch, "changed_head", return_value=None), self.assertRaises(subprocess.TimeoutExpired):
            self.run_worker(watch, "import time; time.sleep(30)", timeout=.1)
        self.assertIsNotNone(children[0].returncode)

    def test_terminating_the_caller_also_stops_its_provider(self):
        with tempfile.TemporaryDirectory() as work:
            marker = Path(work) / "provider.pid"
            provider = f"import os,time; from pathlib import Path; Path({str(marker)!r}).write_text(str(os.getpid())); time.sleep(30)"
            controller = (
                "import os,sys; from agent_interface.review_watch import ReviewWatch; "
                f"watch=ReviewWatch('/tmp', {PR!r}, 'bit-mis', {HEAD!r}); "
                "watch.__enter__(); "
                f"watch.run([sys.executable,'-c',{provider!r}], input='', cwd='/tmp', timeout=30, env=os.environ.copy())"
            )
            controller_process = subprocess.Popen([sys.executable, "-c", controller], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            try:
                deadline = monotonic() + 5
                while not marker.exists() and monotonic() < deadline:
                    sleep(.01)
                self.assertTrue(marker.exists())
                controller_process.terminate()
                _, stderr = controller_process.communicate(timeout=5)
                self.assertEqual(controller_process.returncode, 143, stderr)
                state = subprocess.run(["ps", "-o", "stat=", "-p", marker.read_text()], text=True, capture_output=True).stdout.strip()
                self.assertTrue(not state or state.startswith("Z"), state)
            finally:
                if controller_process.poll() is None:
                    controller_process.kill()
                    controller_process.wait()

    def test_normal_exit_restores_the_callers_signal_handler(self):
        original = signal.getsignal(signal.SIGTERM)
        with ReviewWatch("/tmp", PR, "bit-mis", HEAD) as watch:
            self.run_worker(watch, "print('done')")
        self.assertEqual(signal.getsignal(signal.SIGTERM), original)

    def test_already_exited_group_does_not_mask_cancellation(self):
        process = SimpleNamespace(pid=123, wait=lambda **kwargs: 0)
        with patch.object(review_watch.os, "killpg", side_effect=ProcessLookupError):
            review_watch._stop_process_group(process)

    def test_macos_empty_group_permission_error_is_safe_only_after_exit(self):
        process = SimpleNamespace(pid=123, wait=lambda **kwargs: 0)
        with patch.object(review_watch.os, "killpg", side_effect=[None, PermissionError]), patch.object(review_watch, "sleep"):
            review_watch._stop_process_group(process)
        process = SimpleNamespace(pid=123, wait=lambda **kwargs: (_ for _ in ()).throw(subprocess.TimeoutExpired("provider", 0)))
        with patch.object(review_watch.os, "killpg", side_effect=[None, PermissionError]), patch.object(review_watch, "sleep"), self.assertRaises(subprocess.TimeoutExpired):
            review_watch._stop_process_group(process)


class TestCancellationOutcome(TestCase):
    def test_supersession_keeps_provenance_and_does_not_require_another_network_read(self):
        with tempfile.TemporaryDirectory() as work, \
                patch.object(agent_interface, "DB", Path(work) / "calls.sqlite3"), \
                patch.object(agent_interface, "RESPONSES", Path(work) / "responses"), \
                patch.object(agent_interface, "review_facts", return_value={}) as facts, \
                patch.object(pr_review, "run", side_effect=ReviewSuperseded(NEW_HEAD)), redirect_stdout(io.StringIO()) as output:
            agent_interface.init_db()
            agent_interface.run_pr_review(PR, "bit-mis", HEAD, "poise:review-new-prs", "correlation", model="opus-5-high")
            row = agent_interface.logs()[0]
        self.assertEqual(facts.call_count, 1)
        self.assertEqual(row["status"], "superseded")
        self.assertEqual(row["correlation_id"], "correlation")
        self.assertEqual(row["expected_head"], HEAD)
        self.assertEqual(row["head_sha"], NEW_HEAD)
        self.assertEqual(row["source"], "poise:review-new-prs")
        self.assertEqual(row["actor"], "bit-mis")
        self.assertEqual(row["repo"], "o/r")
        self.assertIsNone(row["action"])
        self.assertFalse(row["error"])
        self.assertEqual(json.loads(output.getvalue())["outcome"], "superseded")

    def test_cancellation_after_submission_verifies_the_posted_review(self):
        from agent_interface import review_receipt

        before = {"reviewer_reviews_since_items": []}
        after = {
            "state": "OPEN", "draft": False, "head_sha": NEW_HEAD,
            "reviewer_reviews_since_items": [{
                "id": 91, "node_id": "node-91", "state": "CHANGES_REQUESTED",
                "commit": HEAD, "submitted_at": "2026-10-25T13:51:24Z",
            }],
        }

        def submitted_then_cancelled(*args, **kwargs):
            review_receipt.record(json.dumps(
                {"action": "requested_changes", "review_id": 91, "head_sha": HEAD}))
            raise ReviewSuperseded(NEW_HEAD)

        with tempfile.TemporaryDirectory() as work, \
                patch.object(agent_interface, "DB", Path(work) / "calls.sqlite3"), \
                patch.object(agent_interface, "RESPONSES", Path(work) / "responses"), \
                patch.object(agent_interface, "review_facts", side_effect=[before, after]), \
                patch.object(pr_review, "run", side_effect=submitted_then_cancelled), \
                redirect_stdout(io.StringIO()) as output:
            agent_interface.init_db()
            agent_interface.run_pr_review(PR, "bit-mis", HEAD, "poise:review-new-prs", "correlation", model="opus-5-high")
            row = agent_interface.logs()[0]
        self.assertEqual(row["status"], "completed")
        self.assertEqual(row["action"], "requested_changes")
        self.assertEqual(row["outcome"], "changes_requested")
        self.assertEqual(row["head_sha"], HEAD)
        self.assertEqual(row["review_id"], 91)
        printed = json.loads(output.getvalue())
        self.assertEqual(printed["outcome"], "changes_requested")

    def test_watch_argv_parses_with_the_real_github_interface_cli(self):
        from github_interface.cli import _parser
        from github_interface.context import pull_number, repository

        watch = ReviewWatch("/tmp", PR, "bit-mis", HEAD)
        body = {"action": "head_sha", "repository": "o/r", "pull_number": 12, "head_sha": NEW_HEAD}
        with patch.object(review_watch.subprocess, "run",
                          return_value=SimpleNamespace(returncode=0, stdout=json.dumps(body))) as run:
            self.assertEqual(watch.changed_head(10), NEW_HEAD)
        argv = run.call_args.args[0]
        payload = {"pr": argv[2], **vars(_parser(argv[1]).parse_args(argv[3:]))}
        self.assertEqual(pull_number(payload), 12)
        self.assertEqual(repository(payload), ("o", "r"))
        self.assertEqual(payload["token_user"], "bit-mis")

    def test_watcher_receives_the_repository_captured_at_launch(self):
        with patch.object(agent_interface, "track", return_value="run"), \
                patch.object(agent_interface, "finish", return_value=1), \
                patch.object(agent_interface, "review_facts", return_value={}), \
                patch.object(pr_review, "repo_name", return_value="o/r"), \
                patch.object(pr_review, "run", side_effect=ReviewSuperseded(NEW_HEAD)) as run, redirect_stdout(io.StringIO()):
            agent_interface.run_pr_review("12", "bit-mis", HEAD, "poise:review-new-prs", "correlation", pwd="/tmp")
        self.assertEqual(run.call_args.args[1], PR)

    def test_astra_does_not_submit_after_its_analysis_is_cancelled(self):
        with patch.object(ReviewWatch, "run", side_effect=ReviewSuperseded(NEW_HEAD)), \
                patch.object(structured_review.subprocess, "run") as submit, self.assertRaises(ReviewSuperseded):
            structured_review.run("/tmp", "system", "packet", CATALOG.resolve("gpt-6-astra-ultra"), "pr_review", PR, "bit-mis", HEAD, 30)
        submit.assert_not_called()


class TestRateLimitAbort(TestCase):
    def test_tool_output_and_prose_clear_stalls_before_a_quiet_minute(self):
        text = "429 Too Many Requests; rate limit exceeded; Reconnecting... 2/5"
        events = [
            {"type": "item.completed", "item": {"type": "command_execution", "command": "cat fixture",
             "aggregated_output": text, "exit_code": 0, "status": "completed"}},
            {"type": "item.started", "item": {"type": "mcp_tool_call", "arguments": {"text": text}}},
            {"type": "item.completed", "item": {"type": "mcp_tool_call", "result": text}},
            {"type": "item.completed", "item": {"type": "agent_message", "text": text}},
            {"type": "item.completed", "item": {"type": "reasoning", "text": text}},
            {"type": "assistant", "message": {"content": [{"type": "tool_use", "input": text}]}},
            {"type": "user", "message": {"content": [{"type": "tool_result", "content": text}]}},
            {"type": "assistant", "text": text},
            {"type": "stream_event", "event": {"delta": {"type": "thinking_delta", "thinking": text}}},
            {"type": "result", "is_error": False, "result": text},
            {"type": "error", "message": "unrelated error", "output": text, "arguments": {"text": text}},
        ]
        lines = [json.dumps(event).encode() for event in events]
        lines.extend([b"Reconnecting... 2/5 (429 Too Many Requests)",
                      b'{"type":"error","message":"429 Too Many Requests"',
                      b'["429 Too Many Requests"]'])
        for line in lines:
            for retry_first in (False, True):
                with self.subTest(line=line, retry_first=retry_first), \
                        patch.object(review_watch, "monotonic", return_value=100.0) as clock, \
                        patch.object(review_watch, "_stop_process_group") as stop:
                    abort = RateLimitAbort()
                    if retry_first:
                        abort.note(b'{"type":"error","message":"Reconnecting... 1/5 (429 Too Many Requests)"}\n')
                        self.assertEqual(abort.since, 100.0)
                    abort.note(line + b"\n")
                    clock.return_value = 161.0
                    abort.check("codex", SimpleNamespace())
                    self.assertIsNone(abort.since)
                    self.assertFalse(abort.quota)
                    self.assertEqual(abort.signal, b"")
                    stop.assert_not_called()

    def test_tool_event_spanning_reads_never_becomes_a_plain_text_signal(self):
        event = json.dumps({"type": "item.completed", "item": {
            "type": "command_execution", "aggregated_output": "x" * 3000 + "429 Too Many Requests",
            "exit_code": 0, "status": "completed"}})
        abort = RateLimitAbort()
        with tempfile.TemporaryFile(mode="w+t") as out, tempfile.TemporaryFile(mode="w+t") as err, \
                patch.object(review_watch, "monotonic", return_value=100.0) as clock, \
                patch.object(review_watch, "_stop_process_group") as stop:
            abort.note(b'{"type":"error","message":"Reconnecting... 1/5"}\n')
            out.write(event[:2500])
            out.flush()
            abort.scan(out, err)
            out.write(event[2500:] + "\n")
            out.flush()
            abort.scan(out, err)
            clock.return_value = 161.0
            abort.check("codex", SimpleNamespace())
            self.assertIsNone(abort.since)
            self.assertEqual(abort.signal, b"")
            stop.assert_not_called()

    def test_persistent_structured_provider_signals_keep_only_diagnostics(self):
        cases = [
            ({"type": "error", "message": "429 Too Many Requests"}, "rate-limited", "429 Too Many Requests"),
            ({"type": "turn.failed", "error": {"message": "rate limit exceeded", "output": "private-tool-output"}},
             "rate-limited", "rate limit exceeded"),
            ({"type": "system", "subtype": "api_retry", "error": "rate_limit", "attempt": 2},
             "rate-limited", "rate_limit"),
            ({"type": "error", "error": {"http_status": 429}}, "rate-limited", "429"),
            ({"type": "result", "is_error": True, "errors": ["rate limit exceeded"]},
             "rate-limited", "rate limit exceeded"),
            ({"type": "error", "message": "Reconnecting... 2/5 (WebSocket idle timeout)"},
             "reconnecting", "WebSocket idle timeout"),
        ]
        for event, cause, excerpt in cases:
            event = {"arguments": "private-tool-arguments", "output": "private-tool-output", **event}
            with self.subTest(event=event), patch.object(review_watch, "monotonic", return_value=100.0) as clock, \
                    patch.object(review_watch, "_stop_process_group") as stop:
                abort = RateLimitAbort()
                line = json.dumps(event).encode() + b"\n"
                abort.note(line)
                clock.return_value = 130.0
                abort.note(line)
                self.assertEqual(abort.since, 100.0)
                clock.return_value = 161.0
                process = SimpleNamespace(pid=1234)
                with self.assertRaises(ReviewLimitError) as raised:
                    abort.check("codex", process)
                self.assertEqual(raised.exception.code, "review_provider_error")
                self.assertIn(cause, str(raised.exception))
                self.assertIn(excerpt, str(raised.exception))
                self.assertNotIn("private-tool", str(raised.exception))
                self.assertLessEqual(len(abort.signal), 200)
                if cause == "reconnecting":
                    self.assertNotIn("rate-limit", str(raised.exception))
                stop.assert_called_once_with(process)

    def test_healthy_output_never_starts_the_clock(self):
        abort = RateLimitAbort()
        abort.note(b'{"type":"turn","text":"reviewing line 429"}\nmore progress\n')
        self.assertIsNone(abort.since)
        abort.check("codex", SimpleNamespace())

    def test_signal_then_progress_resets_the_clock(self):
        abort = RateLimitAbort()
        with patch.object(review_watch, "monotonic", side_effect=[100.0, 130.0]):
            abort.note(b"Reconnecting... 1/5 (last status: 429 Too Many Requests)\n", stderr=True)
            self.assertEqual(abort.since, 100.0)
            abort.note(b'{"type":"assistant","text":"back to work"}\n')
            self.assertIsNone(abort.since)
            abort.check("codex", SimpleNamespace())

    def test_minute_of_signals_aborts_with_a_handoff(self):
        abort = RateLimitAbort()
        proc = SimpleNamespace(pid=1234)
        with patch.object(review_watch, "monotonic", side_effect=[100.0, 161.0]), \
                patch.object(review_watch, "_stop_process_group") as stop:
            abort.note(b"Reconnecting... 1/5\n", stderr=True)
            abort.note(b"Reconnecting... 2/5 (exceeded retry limit, last status: 429 Too Many Requests)\n", stderr=True)
            with self.assertRaises(ReviewLimitError) as raised:
                abort.check("codex", proc)
        self.assertEqual(raised.exception.code, "review_provider_error")
        self.assertIn("rate-limited", str(raised.exception))
        self.assertIn("next model", str(raised.exception))
        self.assertIn("429 Too Many Requests", str(raised.exception))
        stop.assert_called_once_with(proc)

    def test_transport_stall_without_quota_keeps_the_transport_cause(self):
        abort = RateLimitAbort()
        proc = SimpleNamespace(pid=1234)
        with patch.object(review_watch, "monotonic", side_effect=[100.0, 161.0]), \
                patch.object(review_watch, "_stop_process_group") as stop:
            abort.note(b"Reconnecting... 1/5 (WebSocket idle timeout)\n", stderr=True)
            abort.note(b"Reconnecting... 2/5 (stream disconnected before completion: idle timeout waiting for websocket)\n", stderr=True)
            with self.assertRaises(ReviewLimitError) as raised:
                abort.check("codex", proc)
        self.assertEqual(raised.exception.code, "review_provider_error")
        self.assertTrue(
            str(raised.exception).startswith("Provider kept reconnecting for over a minute (codex); "),
            str(raised.exception))
        self.assertIn("next model", str(raised.exception))
        self.assertIn("idle timeout waiting for websocket", str(raised.exception))
        self.assertNotIn("rate-limit", str(raised.exception).lower())
        stop.assert_called_once_with(proc)

    def test_transport_lines_after_quota_keep_the_quota_handoff(self):
        abort = RateLimitAbort()
        with patch.object(review_watch, "monotonic", side_effect=[100.0, 161.0]), \
                patch.object(review_watch, "_stop_process_group"):
            abort.note(b"error: rate limit exceeded, retrying in 30s\n", stderr=True)
            abort.note(b"Reconnecting... 2/5 (backing off)\n", stderr=True)
            with self.assertRaises(ReviewLimitError) as raised:
                abort.check("codex", SimpleNamespace())
        self.assertEqual(raised.exception.code, "review_provider_error")
        self.assertIn("rate-limited", str(raised.exception))

    def test_assistant_prose_mentioning_reconnects_never_starts_the_clock(self):
        abort = RateLimitAbort()
        abort.note(b'{"type":"assistant","text":"reconnecting the pieces, let me re-read the diff"}\n')
        abort.note(b"reasoning: reconnecting the helper to its caller now\n")
        abort.note(b"reconnecting\n")
        self.assertIsNone(abort.since)
        proc = SimpleNamespace(pid=1234)
        with patch.object(review_watch, "monotonic", return_value=1_000_000.0), \
                patch.object(review_watch, "_stop_process_group") as stop:
            abort.check("claude", proc)
        stop.assert_not_called()

    def test_silence_after_a_signal_aborts(self):
        abort = RateLimitAbort()
        with patch.object(review_watch, "monotonic", side_effect=[100.0, 161.0]), \
                patch.object(review_watch, "_stop_process_group"):
            abort.note(b"Provider retry: rate limit; attempt 3; waiting 120s\n", stderr=True)
            with self.assertRaises(ReviewLimitError):
                abort.check("claude", SimpleNamespace())

    def test_github_limits_never_start_the_clock(self):
        abort = RateLimitAbort()
        abort.note(b"error: GitHub 429: rate limit exceeded for resource\n", stderr=True)
        abort.note(b"error: GitHub 403 rate-limit: {}\n", stderr=True)
        abort.note(b'{"type":"error","error":{"message":"GitHub 429: rate limit exceeded"}}\n')
        self.assertIsNone(abort.since)
        with patch.object(review_watch, "monotonic", return_value=10_000.0):
            abort.check("codex", SimpleNamespace())

    def test_marker_across_reads_still_counts(self):
        abort = RateLimitAbort()
        with tempfile.TemporaryFile(mode="w+t") as out, tempfile.TemporaryFile(mode="w+t") as err:
            err.write("error: rate")
            err.flush()
            abort.scan(out, err)
            self.assertIsNone(abort.since)
            err.write(" limit exceeded, backing off\n")
            err.flush()
            abort.scan(out, err)
            self.assertIsNotNone(abort.since)

    def test_bare_mention_without_throttle_action_never_aborts(self):
        abort = RateLimitAbort()
        abort.note(b'{"type":"assistant","text":"mind the rate_limit window here"}\n')
        abort.note(b"reasoning: the rate limit resets hourly, keep reviewing\n")
        self.assertIsNone(abort.since)
        proc = SimpleNamespace(pid=1234)
        with patch.object(review_watch, "monotonic", return_value=1_000_000.0), \
                patch.object(review_watch, "_stop_process_group") as stop:
            abort.check("claude", proc)
        stop.assert_not_called()

    def test_throttle_action_counts_without_a_status_code(self):
        abort = RateLimitAbort()
        abort.note(b"error: rate limit exceeded, retrying in 30s\n", stderr=True)
        self.assertIsNotNone(abort.since)

    def test_check_leaves_a_split_fragment_for_the_next_read(self):
        abort = RateLimitAbort()
        with tempfile.TemporaryFile(mode="w+t") as out, tempfile.TemporaryFile(mode="w+t") as err:
            err.write("Reconnecting...")
            err.flush()
            abort.scan(out, err)
            self.assertIsNone(abort.since)
            abort.check("codex", SimpleNamespace())
            self.assertEqual(abort.pending_err, b"Reconnecting...")
            err.write(" 2/5, waiting\n")
            err.flush()
            abort.scan(out, err)
            self.assertIsNotNone(abort.since)

    def test_scan_reads_stderr_too(self):
        abort = RateLimitAbort()
        with tempfile.TemporaryFile(mode="w+t") as out, tempfile.TemporaryFile(mode="w+t") as err:
            err.write("Reconnecting... 1/5\n")
            err.flush()
            abort.scan(out, err)
            self.assertIsNotNone(abort.since)

    def test_check_kills_the_process_group(self):
        proc = subprocess.Popen(["sleep", "30"], start_new_session=True)
        try:
            abort = RateLimitAbort()
            abort.note(b"Reconnecting... 1/5\n", stderr=True)
            assert abort.since is not None
            with patch.object(review_watch, "monotonic", return_value=abort.since + 61):
                with self.assertRaises(ReviewLimitError):
                    abort.check("codex", proc)
            self.assertIsNotNone(proc.poll())
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
