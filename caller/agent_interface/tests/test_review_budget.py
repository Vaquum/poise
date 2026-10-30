import io
import json
import subprocess
from uuid import uuid4
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch, Mock
from contextlib import redirect_stdout

import agent_interface as api
from agent_interface import review_budget as budget, atoms, progress
from agent_interface.model_catalog import CATALOG

HEAD = 'a' * 40

def facts(**updates):
    value = dict(state='OPEN', draft=False, head_sha=HEAD,
                 reviewer_change_requests_since=0, reviewer_approvals_since=0,
                 reviewer_comments_since=0, reviewer_reviews_since=0, reviewer_pending_reviews=0,
                 reviewer_latest_review_id=None, reviewer_latest_any_review_id=None)
    return {**value, **updates}

def approved():
    return facts(reviewer_approvals_since=1, reviewer_reviews_since=1,
                 reviewer_latest_state='APPROVED', reviewer_latest_commit=HEAD,
                 reviewer_latest_review_id='R_new', reviewer_latest_any_review_id='R_new',
                 reviewer_latest_submitted_at='2026-09-13T10:00:00Z')

class TestReviewBudget(TestCase):
    def test_total_budget_includes_elapsed_time_and_cannot_be_extended(self):
        with patch.object(budget, 'monotonic', return_value=100) as clock, budget.ReviewBudget(3600):
            self.assertEqual(budget.timeout(3600), 1413)
            clock.return_value = 1100
            self.assertEqual(budget.timeout(3600, reserve=15), 398)
            clock.return_value = 1514
            with self.assertRaises(budget.ReviewLimitError) as error: budget.timeout(3600)
            self.assertEqual(error.exception.code, 'review_budget_exhausted')
        self.assertEqual(budget.timeout(3600), 3600)

    def test_packet_reused_only_inside_same_review(self):
        with patch.object(atoms.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='immutable packet')) as run:
            with budget.ReviewBudget():
                self.assertEqual(atoms.packet('/tmp', '#1', 'bit-mis', HEAD), atoms.packet('/tmp', '#1', 'bit-mis', HEAD))
                self.assertEqual(run.call_count, 1)
            with budget.ReviewBudget(): atoms.packet('/tmp', '#1', 'bit-mis', HEAD)
            self.assertEqual(run.call_count, 2)

    def test_budget_usage_reports_elapsed_against_the_capped_allowance(self):
        self.assertIsNone(budget.usage())
        with patch.object(budget, 'monotonic', return_value=100), budget.ReviewBudget(3600):
            with patch.object(budget, 'monotonic', return_value=130):
                used = budget.usage()
            self.assertEqual(used['total_seconds'], 1413)
            self.assertEqual(used['used_seconds'], 30)
        self.assertIsNone(budget.usage())

    def test_terminal_progress_and_completion_report_budget_usage(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / 'calls.sqlite3'
            with sqlite3.connect(database) as db:
                db.execute("create table calls(id text, ended_at real, progress text)")
                db.execute("insert into calls values('run', null, null)")
            with budget.ReviewBudget(100), progress.Progress(database, 'run'):
                snapshot = json.loads(progress.terminal('completed'))
            self.assertEqual(snapshot['budget']['total_seconds'], 100)
            self.assertGreaterEqual(snapshot['budget']['used_seconds'], 0)
            self.assertLessEqual(snapshot['budget']['used_seconds'], 100)

class TestPreparationDeadlines(TestCase):
    def test_packet_git_deadline_does_not_claim_the_total_budget_expired(self):
        diagnostic = {"version": 1, "source": "caller", "severity": "error", "operation": "fetch",
                      "outcome": "timed_out", "stderr": "peer did not respond", "stderr_truncated": False}
        done = SimpleNamespace(returncode=1, stdout="", stderr="caller_diagnostic: " + json.dumps(diagnostic))
        with budget.ReviewBudget(), patch.object(atoms.subprocess, 'run', return_value=done), self.assertRaises(atoms.AgentPreflightError) as failure:
            atoms.packet('/tmp', '#1', 'bit-mis', HEAD)
        self.assertIsNone(failure.exception.code)
        self.assertEqual(failure.exception.diagnostic['phase'], 'packet_acquisition')

class TestRecovery(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        self.addCleanup(patch.stopall)
        patch.object(api, 'DB', Path(self.directory.name) / 'calls.sqlite3').start()
        patch.object(api, 'RESPONSES', Path(self.directory.name) / 'responses').start()
        api.init_db()
        self.mod = SimpleNamespace(pr_number=lambda _: '1', repo_name=lambda *_: 'o/r', run=Mock())

    def execute(self, runs, checks, model='opus-5-high'):
        steps = iter(runs if isinstance(runs, list) else [runs])

        def dispatch(*args, **kwargs):
            step = next(steps)
            if isinstance(step, BaseException):
                raise step
            return step(*args, **kwargs) if callable(step) else step
        self.mod.run.side_effect = dispatch
        with patch.object(api, 'review_facts', side_effect=checks), redirect_stdout(io.StringIO()):
            try:
                api.run_governed_behavior(self.mod, 'pr_approve', 'https://github.com/o/r/pull/1',
                    'bit-mis', HEAD, 'poise:approve-prs', uuid4().hex, pwd=self.directory.name, model=model)
            except SystemExit: pass
        return api.logs()[-1]

    def test_output_limit_recovers_once_and_records_actual_github_outcome(self):
        from agent_interface import review_receipt
        item = {"id": 93, "node_id": "PRR_93", "state": "APPROVED", "commit": HEAD,
                "submitted_at": "2026-09-13T10:00:00Z"}
        def recovered(*args, **kwargs):
            review_receipt.record(json.dumps({"action": "approved_pr", "review_id": 93, "head_sha": HEAD}))
            return 'done'
        before = facts(reviewer_reviews_since_items=[])
        mid = facts(reviewer_reviews_since_items=[])
        after = approved()
        after["reviewer_reviews_since_items"] = [item]
        row = self.execute([budget.ReviewLimitError('output token maximum'), recovered], [before, mid, after])
        self.assertEqual([x.kwargs['model'] for x in self.mod.run.call_args_list], ['opus-5-high', 'gpt-6-astra-ultra'])
        self.assertEqual(row['outcome'], 'approved')
        self.assertEqual(row['review_policy'], 'bounded-v1')
        self.assertEqual(row['recovery_model'], 'gpt-6-astra-ultra')
        self.assertEqual(row['model'], 'opus-5-high')

    def test_completion_print_reports_budget_usage(self):
        from agent_interface import review_receipt
        item = {"id": 93, "node_id": "PRR_93", "state": "APPROVED", "commit": HEAD,
                "submitted_at": "2026-09-13T10:00:00Z"}
        def submitted(*args, **kwargs):
            review_receipt.record(json.dumps({"action": "approved_pr", "review_id": 93, "head_sha": HEAD}))
            return 'done'
        self.mod.run.side_effect = submitted
        before = facts(reviewer_reviews_since_items=[])
        after = approved()
        after["reviewer_reviews_since_items"] = [item]
        output = io.StringIO()
        with patch.object(api, 'review_facts', side_effect=[before, after]), redirect_stdout(output):
            try:
                api.run_governed_behavior(self.mod, 'pr_approve', 'https://github.com/o/r/pull/1',
                    'bit-mis', HEAD, 'poise:approve-prs', uuid4().hex, pwd=self.directory.name,
                    model='gpt-6-astra-ultra')
            except SystemExit:
                pass
        printed = json.loads(output.getvalue())
        self.assertEqual(printed['budget']['total_seconds'], budget.REVIEW_TIMEOUT_SECONDS)
        self.assertGreaterEqual(printed['budget']['used_seconds'], 0)

    def test_terminal_contract_failure_is_logged_with_its_hold_code(self):
        row = self.execute([atoms.AgentPreflightError('invalid review verdict', 'review_contract_violation')],
                           [facts()], model='gpt-6-astra-ultra')
        self.assertEqual(row['status'], 'failed')
        self.assertEqual(row['error_code'], 'review_contract_violation')
        self.assertEqual(row['action'], 'not_started')
        self.assertEqual(row['outcome'], 'preflight_failed')
        self.assertIsNone(row['head_sha'])
        self.assertIsNone(row['recovery_model'])

    def test_checkout_cause_propagates_from_cli_into_durable_call_and_log(self):
        import json
        import sys
        from agent_interface import review_repository
        diagnostic = {"version": 1, "source": "caller", "severity": "error", "operation": "fetch",
                      "phase": "checkout", "outcome": "exit", "exit_code": 128, "signal": None,
                      "errno": None, "stderr": "fatal: remote ref missing\nremote: exact cause",
                      "stderr_truncated": False, "filesystem": None}
        cli = Path(self.directory.name) / "fake-github-interface"
        cli.write_text(f"#!{sys.executable}\nimport sys\nsys.stderr.write({('caller_diagnostic: ' + json.dumps(diagnostic))!r})\nsys.exit(1)\n")
        cli.chmod(0o700)
        packet = json.dumps({"repository": "o/r", "head_sha": HEAD,
                             "pull": {"base": {"sha": "b" * 40}}, "merge_base_sha": "b" * 40})

        def prepare(*args, **kwargs):
            with review_repository.prepare(self.directory.name, 'https://github.com/o/r/pull/1', 'bit-mis', HEAD, packet):
                self.fail('failed checkout yielded a repository')

        with patch.dict('os.environ', {"GITHUB_INTERFACE_CLI": str(cli)}):
            row = self.execute(prepare, [facts()], model='gpt-6-astra-ultra')
        self.assertEqual(row['diagnostic']['stderr'], diagnostic['stderr'])
        self.assertEqual(row['diagnostic']['call_id'], row['id'])
        self.assertEqual(row['diagnostic']['correlation_id'], row['correlation_id'])
        self.assertEqual(row['diagnostic']['expected_head'], HEAD)
        self.assertEqual(row['diagnostic']['repository'], 'o/r')
        self.assertEqual(row['diagnostic']['reviewer'], 'bit-mis')
        self.assertIn('git fetch', row['error'])
        self.assertIn('remote: exact cause', row['error'])
        self.assertEqual(row['action'], 'not_started')
        self.assertEqual(row['outcome'], 'preflight_failed')
        self.assertEqual(self.mod.run.call_count, 1)
        with api.db() as connection:
            stored = json.loads(connection.execute('select diagnostic from calls where id=?', (row['id'],)).fetchone()[0])
        self.assertEqual(stored, row['diagnostic'])

    def test_total_packet_deadline_keeps_process_evidence_through_failed_reconciliation(self):
        with patch.object(budget, 'monotonic', return_value=100) as clock:
            def timeout(*args, **kwargs):
                clock.return_value = 2000
                raise subprocess.TimeoutExpired('github-interface', kwargs['timeout'])

            def packet(*args, **kwargs):
                return atoms.packet(self.directory.name, '#1', 'bit-mis', HEAD)

            with patch.object(atoms.subprocess, 'run', side_effect=timeout):
                row = self.execute(packet, [facts(), RuntimeError('GitHub unavailable')], model='gpt-6-astra-ultra')
        self.assertEqual(row['error_code'], 'review_budget_exhausted')
        self.assertEqual(row['diagnostic']['phase'], 'packet_acquisition')
        self.assertEqual(row['diagnostic']['outcome'], 'timed_out')
        self.assertEqual(row['diagnostic']['timeout_seconds'], 600)
        self.assertEqual(row['diagnostic']['call_id'], row['id'])
        self.assertEqual(row['diagnostic']['correlation_id'], row['correlation_id'])

    def test_receipted_submission_before_provider_error_never_launches_recovery(self):
        from agent_interface import review_receipt
        item = {"id": 93, "node_id": "PRR_93", "state": "APPROVED", "commit": HEAD,
                "submitted_at": "2026-09-13T10:00:00Z"}
        def submitted_then_limited(*args, **kwargs):
            review_receipt.record(json.dumps({"action": "approved_pr", "review_id": 93, "head_sha": HEAD}))
            raise budget.ReviewLimitError('output token maximum')
        before = facts(reviewer_reviews_since_items=[])
        after = approved()
        after["reviewer_reviews_since_items"] = [item]
        row = self.execute([submitted_then_limited], [before, after])
        self.assertEqual(self.mod.run.call_count, 1)
        self.assertEqual(row['outcome'], 'approved')
        self.assertIsNone(row['recovery_model'])

    def test_ambiguous_pending_unavailable_and_changed_activity_never_recover(self):
        for check in [facts(reviewer_pending_reviews=1), facts(reviewer_reviews_since=1), RuntimeError('network unavailable')]:
            with self.subTest(check=check):
                self.mod.run.reset_mock()
                row = self.execute([budget.ReviewLimitError('output token maximum')], [facts(), check])
                self.assertEqual(self.mod.run.call_count, 1)
                self.assertEqual(row['status'], 'failed')
                self.assertEqual(row['error_code'], 'model_output_limit')
                self.assertIsNone(row['action'])

    def test_new_head_supersedes_without_recovery(self):
        row = self.execute([budget.ReviewLimitError('output token maximum')], [facts(), facts(head_sha='b'*40)])
        self.assertEqual(row['outcome'], 'superseded')
        self.assertEqual(self.mod.run.call_count, 1)

    def test_timeout_never_restarts_a_fresh_budget(self):
        row = self.execute([budget.ReviewLimitError('deadline', 'review_budget_exhausted')], [facts(), facts()])
        self.assertEqual(self.mod.run.call_count, 1)
        self.assertEqual(row['error_code'], 'review_budget_exhausted')

    def test_failed_recovery_does_not_loop_or_claim_preflight(self):
        row = self.execute([budget.ReviewLimitError('output token maximum'), atoms.AgentPreflightError('codex failed')], [facts(), facts(), facts()])
        self.assertEqual(self.mod.run.call_count, 2)
        self.assertEqual(row['error_code'], 'review_recovery_failed')
        self.assertIsNone(row['action'])
        self.assertIsNone(row['outcome'])

    def test_lost_recovery_response_without_receipt_holds(self):
        row = self.execute([budget.ReviewLimitError('output token maximum'), RuntimeError('lost response')], [facts(), facts(), approved()])
        self.assertEqual(row['status'], 'failed')
        self.assertEqual(row['error_code'], 'review_recovery_failed')
        self.assertIn('lost response', row['error'])
        self.assertIsNone(row['action'])
        self.assertIsNone(row['outcome'])
        self.assertEqual(self.mod.run.call_count, 2)

    def test_receipted_recovery_submission_adopts_despite_lost_response(self):
        from agent_interface import review_receipt
        item = {"id": 93, "node_id": "PRR_93", "state": "APPROVED", "commit": HEAD,
                "submitted_at": "2026-09-13T10:00:00Z"}
        def submitted_then_lost(*args, **kwargs):
            review_receipt.record(json.dumps({"action": "approved_pr", "review_id": 93, "head_sha": HEAD}))
            raise RuntimeError('lost response')
        before = facts(reviewer_reviews_since_items=[])
        mid = facts(reviewer_reviews_since_items=[])
        after = approved()
        after["reviewer_reviews_since_items"] = [item]
        row = self.execute([budget.ReviewLimitError('output token maximum'), submitted_then_lost], [before, mid, after])
        self.assertEqual(row['outcome'], 'approved')
        self.assertEqual(row['review_id'], 93)
        self.assertEqual(self.mod.run.call_count, 2)

    def test_astra_primary_cannot_fallback_to_itself(self):
        row = self.execute([budget.ReviewLimitError('output limit')], [facts(), facts()], model='gpt-6-astra-ultra')
        self.assertEqual(self.mod.run.call_count, 1)
        self.assertEqual(row['error_code'], 'model_output_limit')

class TestMinuteReasoning(TestCase):
    def test_each_minute_reports_new_or_no_reasoning_and_keeps_only_bounded_text(self):
        import sqlite3, json
        from agent_interface.provider_progress import ProviderStream
        with tempfile.TemporaryDirectory() as folder:
            database = Path(folder) / 'calls.sqlite3'
            with sqlite3.connect(database) as db:
                db.execute('create table calls(id text, ended_at real, progress text)')
                db.execute("insert into calls values('run', null, null)")
            with patch.object(progress, 'monotonic', return_value=100) as clock, progress.Progress(database, 'run') as reporter:
                stream = ProviderStream('claude')
                stream.line(json.dumps({'type':'stream_event','event':{'delta':{'type':'thinking_delta','thinking':'é' * 70000}}}).encode())
                clock.return_value = 160
                reporter.flush()
                self.assertIn('new reasoning activity (1 events)', reporter.state['events'][-1]['message'])
                self.assertEqual(reporter.reasoning_path.read_text(), 'é' * 65536)
                stream.line(b'{"type":"system","subtype":"init"}')
                clock.return_value = 220
                reporter.flush()
                self.assertEqual(reporter.state['events'][-1]['message'], 'Past minute: no new reasoning activity')
                self.assertEqual(reporter.state['reasoning_chars'], 70000)
                self.assertTrue(reporter.state['reasoning_available'])
                with sqlite3.connect(database) as db:
                    metadata = db.execute('select progress from calls').fetchone()[0]
                self.assertNotIn('é', metadata)

    def test_complete_thinking_is_used_when_partial_text_is_absent_without_duplication(self):
        import json
        from agent_interface.provider_progress import ProviderStream
        with patch.object(progress, 'provider_event') as observe:
            stream = ProviderStream('claude')
            complete = {'type': 'assistant', 'message': {'content': [{'type': 'thinking', 'thinking': 'exposed summary'}]}}
            stream.line(json.dumps(complete).encode())
            self.assertEqual(observe.call_args.args[2], 'exposed summary')
            stream.line(b'{"type":"stream_event","event":{"type":"message_start"}}')
            stream.line(b'{"type":"stream_event","event":{"delta":{"type":"thinking_delta","thinking":"exposed summary"}}}')
            stream.line(json.dumps(complete).encode())
            self.assertIsNone(observe.call_args.args[2])

    def test_reasoning_read_requires_full_call_identity(self):
        import sys
        with tempfile.TemporaryDirectory() as folder, patch.object(api, 'DB', Path(folder) / 'calls.sqlite3'):
            api.init_db()
            call_id = api.track('opus-5-high', '', '1', 'o/r', 'bit-mis', 'pr_review')
            path = Path(folder) / 'reasoning' / (call_id + '.txt')
            path.parent.mkdir(); path.write_text('provider text')
            with patch.object(sys, 'argv', ['agent-interface', '--read-reasoning', call_id]), redirect_stdout(io.StringIO()) as output:
                api.main()
            self.assertEqual(output.getvalue().strip(), 'provider text')
            for invalid in [call_id[:8], '../secret', 'b' * 32]:
                with self.subTest(invalid=invalid), patch.object(sys, 'argv', ['agent-interface', '--read-reasoning', invalid]), redirect_stdout(io.StringIO()), self.assertRaises(ValueError):
                    api.main()
