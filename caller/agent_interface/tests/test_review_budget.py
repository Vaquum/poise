import io
import json
import re
import sqlite3
import subprocess
import sys
from uuid import uuid4
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch, Mock
from contextlib import nullcontext, redirect_stdout

import agent_interface as api
from agent_interface import review_budget as budget, atoms, pr_approve, progress, structured_review
from agent_interface.model_catalog import CATALOG

HEAD = 'a' * 40
APPROVAL = json.dumps({
    'action': 'approve', 'comments': [],
    'assessment': {'verdict': 'The changed validation paths have no remaining blocking defects.',
                   'reviewed_context': 'Inspected the supplied immutable diff and its affected callers.',
                   'limitations': 'Provider fixture; no application test execution.'}})

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

def refusal_error(refusal='repeat_only'):
    from agent_interface.process_diagnostic import diagnostic_envelope
    return budget.ReviewLimitError(
        'review submission was a no-op: [{"reason": "repeat"}]', 'review_contract_violation',
        diagnostic_envelope(operation='provider.review', phase='submitting', outcome='exit',
                            stderr='[{"reason": "repeat"}]', provider='claude',
                            submission='noop', refusal=refusal))

def context_refusal():
    from agent_interface.process_diagnostic import diagnostic_envelope
    return budget.ReviewLimitError(
        'review submission rejected: retained review response differs from the current PR context',
        'review_contract_violation',
        diagnostic_envelope(operation='provider.review', phase='submitting', outcome='exit', submission='rejected'))

def verdict_error():
    return atoms.ReviewVerdictError('invalid corrected verdict', 'review_contract_violation',
                                   {'submission': 'none', 'phase': 'validating'})

def stored_response(call_id):
    with api.db() as conn:
        path = conn.execute('select response_path from calls where id=?', (call_id,)).fetchone()[0]
    return Path(path).read_text()

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
        with patch.object(atoms.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='{}')) as run:
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

    def test_inspection_at_analysis_cutoff_preserves_both_publication_reserves(self):
        from agent_interface import review_repository

        for returned_at in (1292, 1293):
            with self.subTest(returned_at=returned_at):
                clock = SimpleNamespace(now=0.0)
                repository = review_repository.Repository(Path('/tmp/review'), {'head_sha': HEAD})
                request = {'operation': 'read', 'path': 'consumer.py', 'query': '', 'start_line': 1}

                def ask(*args):
                    clock.now = returned_at
                    return json.dumps({'action': 'inspect', 'comments': [], 'requests': [request],
                                       'assessment': json.loads(APPROVAL)['assessment']})

                def inspect(argv, *, timeout, **kwargs):
                    self.assertEqual(argv[1], '--review-context')
                    self.assertEqual(timeout, 1)
                    clock.now += timeout
                    return SimpleNamespace(returncode=0, stderr='', stdout=json.dumps(
                        {'action': 'review_context', 'head_sha': HEAD, 'results': []}))

                with patch.object(budget, 'monotonic', lambda: clock.now), \
                        patch.object(structured_review, 'monotonic', lambda: clock.now), \
                        patch.object(structured_review, 'ReviewWatch', return_value=nullcontext(SimpleNamespace(check_closed=lambda: None))), \
                        patch.dict(structured_review.ASK, {'codex': ask}), \
                        patch.object(subprocess, 'run', side_effect=inspect) as command, \
                        budget.ReviewBudget(), self.assertRaises(budget.ReviewLimitError) as failure:
                    structured_review.run('/tmp', 'system', 'packet', CATALOG.resolve('gpt-6-astra-ultra'),
                                          'pr_review', 'https://github.com/o/r/pull/1', 'bit-mis', HEAD,
                                          1413, repository=repository)
                self.assertEqual(failure.exception.code, 'review_budget_exhausted')
                self.assertEqual(command.call_count, 1 if returned_at == 1292 else 0)
                self.assertEqual(clock.now, 1293)

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

    def execute(self, runs, checks, model='opus-5-high', behavior='pr_approve'):
        steps = iter(runs if isinstance(runs, list) else [runs])

        def dispatch(*args, **kwargs):
            step = next(steps)
            if isinstance(step, BaseException):
                raise step
            return step(*args, **kwargs) if callable(step) else step
        self.mod.run.side_effect = dispatch
        with patch.object(api, 'review_facts', side_effect=checks), redirect_stdout(io.StringIO()):
            try:
                api.run_governed_behavior(self.mod, behavior, 'https://github.com/o/r/pull/1',
                    'bit-mis', HEAD, 'poise:approve-prs', uuid4().hex, pwd=self.directory.name, model=model)
            except SystemExit: pass
        return api.logs()[-1]

    def execute_verdicts(self, replies, checks, submission=None):
        packet = json.dumps({'repository': 'o/r', 'pull_number': 1, 'head_sha': HEAD, 'coverage': 'complete', 'files': [],
                             'pull': {'title': 'Pinned approval target', 'base': {'sha': 'b' * 40}}})
        replies = iter(replies)
        self.verdict_snapshots = []

        def ask(*args):
            database, call_id = api.review_receipt._call.get()
            self.assertEqual(database, api.DB)
            with api.db() as conn:
                row = dict(conn.execute('select * from calls where id=?', (call_id,)).fetchone())
            self.verdict_snapshots.append((row, budget._current.get().deadline))
            return next(replies)

        def github(args, **kwargs):
            self.assertEqual(args[args.index('--token-user') + 1], 'bit-mis')
            if args[1] == '--review-activity-since':
                return SimpleNamespace(returncode=0, stdout=json.dumps({'reviewer_latest_complete_commit': HEAD}), stderr='')
            self.assertEqual(args[args.index('--expected-head') + 1], HEAD)
            if args[1] == '--pr-review':
                return SimpleNamespace(returncode=0, stdout=packet, stderr='')
            self.assertEqual(args[1], '--approve-pr')
            if isinstance(submission, BaseException):
                raise submission
            return submission or SimpleNamespace(returncode=0, stderr='', stdout=json.dumps(
                {'action': 'approved_pr', 'review_id': 93, 'head_sha': HEAD}))

        with patch.dict(structured_review.ASK, {'codex': Mock(side_effect=ask)}) as providers, \
                patch.object(structured_review, 'ReviewWatch', return_value=nullcontext(SimpleNamespace(check_closed=lambda: None))), \
                patch.object(subprocess, 'run', side_effect=github) as self.verdict_github:
            self.verdict_ask = providers['codex']
            return self.execute([pr_approve.run, pr_approve.run], checks, model='gpt-6-astra-ultra')

    def test_exhausted_verdict_correction_recovers_on_unchanged_approval_input(self):
        before = facts(review_context='c' * 64, reviewer_reviews_since_items=[])
        after = approved()
        after['review_context'] = before['review_context']
        after['reviewer_reviews_since_items'] = [{'id': 93, 'state': 'APPROVED', 'commit': HEAD,
                                                 'submitted_at': '2026-09-13T10:00:00Z'}]
        row = self.execute_verdicts(['{}', '{}', APPROVAL], [before, before, after])
        self.assertEqual((row['status'], row['action'], row['outcome'], row['review_id']),
                         ('completed', 'approved', 'approved', 93))
        self.assertEqual((row['model'], row['recovery_model']), ('gpt-6-astra-ultra', 'gpt-6-astra-ultra'))
        asks = self.verdict_ask.call_args_list
        self.assertEqual(len(asks), 3, 'the first verdict must exhaust its correction before recovery')
        self.assertEqual([call.args[1].identity for call in asks], ['gpt-6-astra-ultra'] * 3)
        self.assertIn('previous review response was rejected', asks[1].args[3])
        self.assertEqual(asks[0].args[3], asks[2].args[3])
        snapshots, deadlines = zip(*self.verdict_snapshots)
        self.assertEqual({snapshot['id'] for snapshot in snapshots}, {row['id']})
        self.assertEqual({snapshot['actor'] for snapshot in snapshots}, {'bit-mis'})
        self.assertEqual({snapshot['expected_head'] for snapshot in snapshots}, {HEAD})
        self.assertEqual({snapshot['review_policy'] for snapshot in snapshots}, {'bounded-v1'})
        self.assertEqual([snapshot['recovery_model'] for snapshot in snapshots], [None, None, row['model']])
        self.assertEqual(len(set(deadlines)), 1)
        commands = [call.args[0][1] for call in self.verdict_github.call_args_list]
        self.assertEqual(commands.count('--pr-review'), 1, 'recovery must reuse the immutable packet')
        self.assertEqual(commands.count('--approve-pr'), 1)
        self.assertEqual(api.review_receipt.get()['review_id'], row['review_id'])
        self.assertIn('review verdict must contain', stored_response(row['id']))

    def test_failed_verdict_recovery_stays_held_without_another_launch(self):
        before = facts(reviewer_reviews_since_items=[])
        row = self.execute_verdicts(['{}', '{}', 'invalid JSON', 'invalid JSON'], [before] * 3)
        self.assertEqual((row['status'], row['error_code']), ('failed', 'review_recovery_failed'))
        self.assertEqual(row['recovery_model'], 'gpt-6-astra-ultra')
        self.assertEqual(self.verdict_ask.call_count, 4)
        self.assertEqual(self.mod.run.call_count, 2)
        self.assertIsNone(row['review_id'])
        self.assertIsNone(row['action'])
        self.assertIn('Expecting value', row['error'])
        self.assertIn('prior: codex review produced no submitted verdict: review verdict must contain', row['error'])
        api.init_db()
        with self.assertRaises(sqlite3.IntegrityError):
            api.run_governed_behavior(self.mod, 'pr_approve', 'https://github.com/o/r/pull/1', 'bit-mis', HEAD,
                                      row['source'], row['correlation_id'], pwd=self.directory.name, model=row['model'])
        self.assertEqual(self.mod.run.call_count, 2)
        self.assertEqual(len(api.logs()), 1)

    def test_verdict_recovery_requires_quiet_live_review_inventory(self):
        before = facts(review_context='c' * 64, reviewer_reviews_since_items=[])
        for change in ({'reviewer_pending_reviews': 1}, {'reviewer_reviews_since_items': [{'id': 99}]}):
            with self.subTest(change=change), patch.object(api, 'sleep'):
                self.mod.run.reset_mock()
                row = self.execute_verdicts(['{}', '{}'], [before, {**before, **change}])
                self.assertEqual(self.mod.run.call_count, 1)
                self.assertEqual(self.verdict_ask.call_count, 2)
                self.assertEqual((row['status'], row['error_code']), ('failed', 'review_contract_violation'))
                self.assertIn('could not prove a safe recovery', row['error'])
                self.assertIsNone(row['recovery_model'])
                self.assertIsNone(row['review_id'])

    def test_verdict_recovery_requires_unchanged_head_and_context(self):
        before = facts(review_context='c' * 64, reviewer_reviews_since_items=[])
        for change in ({'head_sha': 'b' * 40}, {'review_context': 'd' * 64}):
            with self.subTest(change=change):
                self.mod.run.reset_mock()
                row = self.execute_verdicts(['{}', '{}'], [before, {**before, **change}])
                self.assertEqual(self.mod.run.call_count, 1)
                self.assertEqual(row['outcome'], 'superseded')
                self.assertEqual(row['error_code'], 'review_contract_violation')
                self.assertIn('review verdict must contain', row['error'])
                self.assertIsNone(row['recovery_model'])

    def test_verdict_recovery_does_not_replay_an_uncertain_submission(self):
        before = facts(reviewer_reviews_since_items=[])
        unclaimed = approved()
        unclaimed['reviewer_reviews_since_items'] = [{'id': 99, 'state': 'APPROVED', 'commit': HEAD,
                                                     'submitted_at': '2026-09-13T10:00:00Z'}]
        with patch.object(api, 'sleep'):
            row = self.execute_verdicts(['{}', '{}', APPROVAL], [before, before, unclaimed],
                                        submission=subprocess.TimeoutExpired('github-interface', 1))
        self.assertEqual((row['status'], row['error_code']), ('failed', 'review_recovery_failed'))
        self.assertEqual(self.mod.run.call_count, 2)
        self.assertEqual(self.verdict_ask.call_count, 3)
        self.assertIsNone(row['review_id'])
        self.assertIsNone(row['action'])
        self.assertIn('publication uncertain', row['error'])
        self.assertIn('prior: codex review produced no submitted verdict', row['error'])

    def test_packet_and_position_contract_errors_do_not_reverdict(self):
        from agent_interface import review_stages
        for target, method, error in ((review_stages, 'stage_count', review_stages.StageError('invalid packet stages')),
                                      (structured_review, '_validate_since_positions', structured_review.InvalidVerdict('outside since diff'))):
            with self.subTest(method=method), patch.object(target, method, side_effect=error):
                self.mod.run.reset_mock()
                row = self.execute_verdicts([APPROVAL], [facts()])
                self.assertEqual(self.mod.run.call_count, 1)
                self.assertEqual(row['error_code'], 'review_contract_violation')
                self.assertEqual(row['action'], 'not_started')
                self.assertIsNone(row['recovery_model'])

    def test_verdict_recovery_uses_the_remaining_deadline(self):
        with patch.object(budget, 'monotonic', return_value=100) as clock:
            def exhausted(*args, **kwargs):
                clock.return_value = 1514
                raise verdict_error()
            row = self.execute(exhausted, [facts(), facts()], model='gpt-6-astra-ultra')
        self.assertEqual(row['error_code'], 'review_budget_exhausted')
        self.assertEqual((row['action'], row['outcome']), ('not_started', 'preflight_failed'))
        self.assertIsNone(row['recovery_model'])
        self.assertEqual(self.mod.run.call_count, 1)

    def test_repeat_only_budget_exhaustion_settles_retryable_for_pr_review(self):
        with patch.object(budget, 'monotonic', return_value=100) as clock:
            def exhausted(*args, **kwargs):
                clock.return_value = 1514
                raise refusal_error()
            row = self.execute(exhausted, [facts(), facts()], model='opus-5-high', behavior='pr_review')
        self.assertEqual(row['error_code'], 'review_budget_exhausted')
        self.assertEqual((row['action'], row['outcome']), ('not_started', 'preflight_failed'))
        self.assertIsNone(row['recovery_model'])
        self.assertEqual(self.mod.run.call_count, 1)

    def test_consumed_verdict_recovery_guard_survives_a_restart(self):
        model = CATALOG.resolve('gpt-6-astra-ultra')
        call_id = api.track(model.identity, '', '1', 'o/r', 'bit-mis', 'pr_approve', expected_head=HEAD)
        with api.db() as conn:
            conn.execute('update calls set recovery_model=? where id=?', (model.identity, call_id))
        for _ in range(2):
            api.init_db()
            self.mod.run.side_effect = verdict_error()
            with patch.object(api, 'review_facts', return_value=facts()), self.assertRaises(budget.ReviewLimitError) as failure:
                api._run_review_with_recovery(self.mod, 'pr_approve', 'https://github.com/o/r/pull/1', self.directory.name,
                                              'bit-mis', HEAD, '', 60, None, model, model, facts(), call_id)
            self.assertEqual(failure.exception.code, 'review_recovery_failed')
            self.assertIn('Recovery was already attempted', str(failure.exception))
        self.assertEqual(self.mod.run.call_count, 2, 'neither invocation may launch a recovery')

    def test_invalid_pr_review_does_not_gain_approval_recovery(self):
        row = self.execute(verdict_error(), [facts()], model='gpt-6-astra-ultra', behavior='pr_review')
        self.assertEqual((row['status'], row['action'], row['outcome']), ('failed', 'not_started', 'preflight_failed'))
        self.assertEqual(row['error_code'], 'review_contract_violation')
        self.assertIsNone(row['recovery_model'])

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

    def test_local_inspection_timeout_retains_sanitized_target_and_never_recovers_in_place(self):
        from agent_interface import pr_review, review_repository, structured_review
        query = 'rate limit; not signed in; status 402 Payment Required'
        actual_run, original_timeout = subprocess.run, budget.timeout
        started = Path(self.directory.name) / 'inspection-started'
        cli = Path(self.directory.name) / 'stalled-github-interface'
        cli.write_text(f'#!{sys.executable}\nimport time\nfrom pathlib import Path\n'
                       f'Path({str(started)!r}).touch()\nprint({query!r}, flush=True)\ntime.sleep(60)\n')
        cli.chmod(0o700)
        packet = json.dumps({'repository': 'o/r', 'pull_number': 1, 'head_sha': HEAD, 'merge_base_sha': 'b' * 40,
                             'pull': {'title': 'Pinned review target', 'base': {'sha': 'b' * 40}}})
        for initial in (True, False):
            roots = []
            started.unlink(missing_ok=True)
            def command(argv, **kwargs):
                if '--checkout-review' in argv:
                    root = Path(argv[argv.index('--path') + 1]); root.mkdir(); roots.append(root)
                    return SimpleNamespace(returncode=0, stderr='', stdout=json.dumps({
                        'action': 'checkout_review', 'repository': 'o/r', 'path': str(root),
                        'head_sha': HEAD, 'merge_base_sha': 'b' * 40}))
                self.assertEqual(argv[1], '--review-context')
                requests = json.loads(argv[argv.index('--requests-json') + 1])
                if initial or requests[0]['operation'] == 'search':
                    return actual_run(argv, **kwargs)
                return SimpleNamespace(returncode=0, stderr='', stdout=json.dumps({
                    'action': 'review_context', 'head_sha': HEAD, 'results': []}))

            ask = Mock(return_value=json.dumps({'action': 'inspect', 'comments': [],
                'assessment': {'verdict': 'Inspect the affected consumers before concluding.',
                               'reviewed_context': 'Read the supplied immutable review packet.',
                               'limitations': 'No repository code execution.'},
                'requests': [{'operation': 'search', 'path': '.', 'query': query, 'start_line': 1}]}))
            def review(*args, **kwargs):
                return pr_review.run(self.directory.name, 'https://github.com/o/r/pull/1', 'bit-mis', HEAD,
                                     model='gpt-6-astra-ultra')

            self.mod.run.reset_mock()
            with self.subTest(initial=initial), patch.object(atoms, 'packet', return_value=packet), \
                    patch.object(review_repository.subprocess, 'run', side_effect=command), \
                    patch.dict('os.environ', {'GITHUB_INTERFACE_CLI': str(cli)}), \
                    patch.object(budget, 'timeout', side_effect=lambda cap, **kwargs: original_timeout(0.5 if cap == 30 else cap, **kwargs)), \
                    patch.dict(structured_review.ASK, {'codex': ask}):
                row = self.execute(review, [facts()], model='gpt-6-astra-ultra')
            self.assertEqual(row['error_code'], 'review_inspection_timeout', row['error'])
            self.assertEqual(row['action'], 'not_started')
            self.assertEqual(row['outcome'], 'preflight_failed')
            self.assertIsNone(row['head_sha'])
            self.assertIsNone(row['review_id'])
            self.assertIsNone(row['recovery_model'])
            self.assertEqual(self.mod.run.call_count, 1)
            self.assertEqual(ask.call_count, 0 if initial else 1)
            self.assertTrue(started.exists())
            self.assertFalse(roots[0].parent.exists())
            self.assertIn('inspection timed out', row['error'])
            for private in ('--requests-json', query):
                self.assertNotIn(private, row['error'])
                self.assertNotIn(private, json.dumps(row['diagnostic']))
            self.assertEqual(row['diagnostic']['operation'], 'github-interface')
            self.assertEqual(row['diagnostic']['phase'], 'inspection')
            self.assertEqual(row['diagnostic']['outcome'], 'timed_out')
            self.assertEqual(row['diagnostic']['timeout_seconds'], 0.5)
            self.assertEqual(row['diagnostic']['repository'], 'o/r')
            self.assertEqual(row['diagnostic']['pr'], '1')
            self.assertEqual(row['diagnostic']['expected_head'], HEAD)
            self.assertEqual(row['diagnostic']['call_id'], row['id'])
            self.assertEqual(row['diagnostic']['correlation_id'], row['correlation_id'])
            with api.db() as connection:
                stored = json.loads(connection.execute('select diagnostic from calls where id=?', (row['id'],)).fetchone()[0])
            self.assertEqual(stored, row['diagnostic'])

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

    def test_failed_recovery_retains_file_group_cause_in_call_log(self):
        diagnostic = structured_review.diagnostic_envelope(
            operation='provider.review', phase='file_group', outcome='timed_out', provider='codex',
            message='Incomplete analysis in file group 3 of 10: file_group deadline; elapsed 498.7s; '
                    'remaining analysis 387.9s. No review submitted.',
            elapsed_ms=498735, timeout_seconds=498.735, submission='none')
        failure = budget.ReviewLimitError('Review file-group time limit reached; incomplete analysis',
                                          'review_budget_exhausted', diagnostic)
        row = self.execute([budget.ReviewLimitError('output token maximum'), failure], [facts()] * 3)
        self.assertEqual((row['status'], row['error_code']), ('failed', 'review_recovery_failed'))
        self.assertEqual(row['recovery_model'], 'gpt-6-astra-ultra')
        self.assertEqual(self.mod.run.call_count, 2)
        self.assertIsNone(row['review_id'])
        for key, value in diagnostic.items():
            self.assertEqual(row['diagnostic'][key], value)
        self.assertEqual(row['diagnostic']['call_id'], row['id'])
        self.assertEqual(row['diagnostic']['expected_head'], HEAD)
        with api.db() as connection:
            stored = json.loads(connection.execute('select diagnostic from calls where id=?', (row['id'],)).fetchone()[0])
        self.assertEqual(stored, row['diagnostic'])

    def _staged_review(self, files, *, publication='normal', stalled=False, inspection_loop=False,
                       finding_counts=None, remapping=None, followup=None,
                       slow_second=False, deadline=None, clean=False, group_seconds=None):
        from hashlib import sha256

        from agent_interface import pr_review, review_stages

        # Bounded analogues of #1137 (three groups) and #1146 (sixteen).
        # Retained Calls 88a0b19a/f8ae3f13 and 9815e6e8/4ca0c9ec show
        # repeated inspection, then an interrupted provider, not submission.
        # Latencies are bounded fixture costs, not measured production timings.
        paths = [f'src/f{i:03d}.py' for i in range(files)]
        lines = max(finding_counts) if finding_counts else 1
        packet = {'repository': 'o/r', 'pull_number': 1, 'head_sha': HEAD, 'coverage': 'complete',
                  'merge_base_sha': 'b' * 40,
                  'pull': {'title': 'Pinned staged review', 'body': 'Review every group',
                           'base': {'sha': 'b' * 40}},
                  'files': [{'filename': path} for path in paths],
                  'diff': '\n'.join(f'diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n'
                                    f'@@ -1 +1,{lines} @@\n-old\n' + '\n'.join(['+new'] * lines) for path in paths)}
        if remapping:
            packet.update(since_head_sha='d' * 40, p='p2')
        packet_text = json.dumps(packet)
        total = review_stages.stage_count(packet_text)
        context = sha256(json.dumps(['b' * 40, packet['pull']['title'], packet['pull']['body']],
                                    separators=(',', ':')).encode()).hexdigest()
        clock = SimpleNamespace(now=0.0)
        observed = SimpleNamespace(groups={}, inspected=set(), submissions=[], lookups=[], timeline=[],
                                   threads={}, commands=[], guidance_reads=0, delivered={}, entries={},
                                   stall_inspection=False, review_id=93 + len(api.logs()),
                                   packets=0, issues=[], findings=[], responses=[], workdirs=set())
        common = ['AGENTS.md', 'CLAUDE.md', 'AUTONOMIO_PR_GUIDELINE.md', 'POISE_REPO_SPECIFICS.md']
        published = []

        def spend(phase, duration, timeout):
            observed.timeline.append((phase, duration, timeout))
            clock.now += min(duration, timeout)
            if duration > timeout:
                raise subprocess.TimeoutExpired(phase, timeout)

        def command(argv, *, timeout, **kwargs):
            flag = argv[1]
            self.assertIn(flag, ('--review-activity-since', '--pr-review', '--checkout-review',
                                 '--review-context', '--request-changes', '--create-pr-linked-issue', '--approve-pr',
                                 '--reviewed-clean'))
            if flag != '--review-context':
                self.assertEqual(argv[argv.index('--token-user') + 1], 'bit-mis')
            if flag == '--review-activity-since':
                observed.lookups.append(len(published))
                spend('verification' if len(observed.lookups) > 1 else 'preparation',
                      45 if len(observed.lookups) > 1 else 15, timeout)
                value = facts(action='review_activity_since', repository='o/r', pull_number=1,
                              username='bit-mis', review_context=context,
                              reviewer_reviews_since_items=list(published),
                              reviewer_reviews_since=len(published),
                              reviewer_change_requests_since=sum(r['state'] == 'CHANGES_REQUESTED' for r in published),
                              reviewer_approvals_since=sum(r['state'] == 'APPROVED' for r in published),
                              reviewer_comments_since=len(published) if clean else 0,
                              reviewer_latest_commit=HEAD if published else 'd' * 40 if remapping else None)
            elif flag == '--pr-review':
                observed.packets += 1
                if observed.packets == 2:
                    observed.responses.append(api.review_receipt.retained_response())
                    spend('remapping', float('inf') if remapping == 'timeout' else timeout - 1, timeout)
                else:
                    spend('packet', 25, timeout)
                self.assertEqual(argv[argv.index('--expected-head') + 1], HEAD)
                value = packet
            elif flag == '--checkout-review':
                spend('checkout', 45, timeout)
                root = Path(argv[argv.index('--path') + 1]); root.mkdir()
                self.assertEqual(argv[argv.index('--expected-head') + 1], HEAD)
                value = {'action': 'checkout_review', 'repository': 'o/r', 'path': str(root),
                         'head_sha': HEAD, 'merge_base_sha': 'b' * 40}
            elif flag == '--review-context':
                requests = json.loads(argv[argv.index('--requests-json') + 1])
                spend('listing' if requests[0]['operation'] == 'list' else 'inspection',
                      float('inf') if observed.stall_inspection else
                      10 if requests[0]['operation'] == 'list' else 0.4 if inspection_loop else 1, timeout)
                observed.inspected.update(r['path'] for r in requests if r['path'] in paths)
                observed.guidance_reads += sum(r['path'] == 'AGENTS.md' for r in requests)
                value = {'action': 'review_context', 'head_sha': HEAD,
                         'results': [{'request': r, 'content': 'Pinned consumer and guidance evidence'}
                                     for r in requests]}
            elif flag == '--create-pr-linked-issue':
                observed.issues.append(argv)
                observed.responses.append(api.review_receipt.retained_response())
                spend('followup', float('inf') if followup == 'timeout' else timeout - 1, timeout)
                if followup == 'lost':
                    # The issue POST was accepted before its response was lost.
                    raise subprocess.TimeoutExpired(argv, timeout)
                if followup == 'rejected':
                    return SimpleNamespace(returncode=1, stdout='', stderr='error: GitHub 422: Issues are disabled')
                value = {'action': 'created_pr_linked_issue', 'issue': {'number': 8, 'html_url': 'https://github.com/o/r/issues/8'}}
            else:
                observed.submissions.append(argv)
                self.assertEqual(argv[argv.index('--expected-head') + 1], HEAD)
                response = api.review_receipt.retained_response()
                self.assertEqual(response['head_sha'], HEAD)
                self.assertEqual(response['context_sha'], context)
                observed.responses.append(response)
                spend('publication', timeout - 1 if publication == 'slow' else 55, timeout)
                published.append({'id': observed.review_id, 'state': 'APPROVED' if flag == '--approve-pr' else 'COMMENTED' if clean else 'CHANGES_REQUESTED', 'commit': HEAD,
                                  'submitted_at': '2026-11-11T10:00:00Z'})
                if publication == 'uncertain':
                    raise subprocess.TimeoutExpired(argv, timeout)
                value = {'action': 'approved_pr' if flag == '--approve-pr' else 'reviewed_clean' if clean else 'requested_changes',
                         'review_id': observed.review_id, 'head_sha': HEAD}
            return SimpleNamespace(returncode=0, stdout=json.dumps(value), stderr='')

        def provider(argv, *, input, timeout, **kwargs):
            observed.commands.append(argv)
            observed.workdirs.add(kwargs['cwd'])
            if 'resume' in argv:
                thread_id = argv[-2]
                history = observed.threads[thread_id]
            else:
                thread_id = str(uuid4())
                history = SimpleNamespace(common=False, inspected=set(), pending=None, stage=None, optional={})
                observed.threads[thread_id] = history
            if history.pending is not None:
                kind, group, requests = history.pending
                self.assertIn('Pinned consumer and guidance evidence', input)
                for request in requests:
                    self.assertIn(request['path'], input)
                if kind == 'common':
                    history.common = True
                else:
                    history.inspected.add(group)
                    if kind == 'group':
                        observed.delivered[group] = observed.delivered.get(group, 0) + 1
                history.pending = None
            if 'PR packet:\n' in input:
                history.stage, _ = json.JSONDecoder().raw_decode(input.split('PR packet:\n', 1)[1])
            stage = history.stage
            group = int(re.search(r'file group (\d+) of', stage['review_scope'])[1]) if total > 1 else 1
            observed.entries.setdefault(group, clock.now)
            self.assertEqual(stage['head_sha'], HEAD)
            self.assertEqual(stage['pull'], packet['pull'])
            self.assertEqual(stage['repository'], 'o/r')
            if (inspection_loop or slow_second or group_seconds) and 'PR packet:\n' in input:
                for earlier in range(1, group):
                    if not clean:
                        self.assertIn(f'Blocking defect in file group {earlier}.', input)
                    self.assertIn(f'Pinned evidence for group {earlier}', input)
            observed.groups[group] = observed.groups.get(group, 0) + 1
            requests = []
            if not history.common:
                seconds = 90.28 if group_seconds else 25 if slow_second else 0 if publication == 'slow' else 225 if total == 16 else 400
                requests = [{'operation': 'read', 'path': path, 'query': '', 'start_line': 1} for path in common]
                history.pending = ('common', group, requests)
            else:
                seconds = (30 if group == 2 else 10) if slow_second else 198 if publication == 'slow' else 25
                if group_seconds:
                    # Two provider turns plus required inspection; the first
                    # group also pays for the common-guidance inspection.
                    seconds = (group_seconds[group - 1] - (2 if group == 1 else 1)) / 2
                if group not in history.inspected:
                    requests = [{'operation': 'read', 'path': f['filename'], 'query': '', 'start_line': 1}
                                for f in stage['files']]
                    history.pending = ('group', group, requests)
                elif slow_second and group == 2 and observed.delivered[group] < 2:
                    requests = [{'operation': 'search', 'path': stage['files'][0]['filename'],
                                 'query': 'required-consumer', 'start_line': 1}]
                    history.pending = ('group', group, requests)
            schema = json.loads(Path(argv[argv.index('--output-schema') + 1]).read_text())
            if 'requests' not in schema['properties']:
                requests = []
                history.pending = None
            if requests:
                self.assertIn('inspect', schema['properties']['action']['enum'],
                              'required inspection must remain available beyond the equal-share cutoff')
            if inspection_loop:
                # #1161 Call 5fed3a4a entered group 5 at 1,284.8 s, with
                # ~10 s left. Its final inspections took ~0.4 s, compared
                # with 20/33 s provider turns. These bounded fixture costs
                # reproduce that starvation; they are not a production trace.
                seconds = 195 if not history.common else 61.75
                if 'omit optional inspection' in input:
                    self.assertTrue(history.common)
                    self.assertIn(group, history.inspected)
                    requests = []
                elif not requests and history.optional.get(group, 0) < 2:
                    history.optional[group] = history.optional.get(group, 0) + 1
                    requests = [{'operation': 'search', 'path': '.', 'start_line': 1,
                                 'query': f'optional-consumer-{group}-{history.optional[group]}'}]
                    history.pending = ('optional', group, requests)
            stopped_group = (3 if group_seconds else 2) if deadline in ('file_group', 'file_group_inspection', 'inspection') else total
            if deadline and group == stopped_group and history.common:
                if deadline.endswith('_inspection'):
                    seconds = timeout - 5
                    requests = [{'operation': 'read', 'path': stage['files'][0]['filename'],
                                 'query': '', 'start_line': 1}]
                    observed.stall_inspection = True
                elif deadline == 'inspection':
                    observed.stall_inspection = True
                else:
                    seconds = float('inf')
            boundary = group == total and not requests and 'boundary' in (remapping, followup)
            spend('provider', float('inf') if stalled else timeout if boundary else seconds, timeout)
            finding = {'path': stage['files'][0]['filename'], 'line': 1, 'side': 'RIGHT',
                       'body': f'[p1] Blocking defect in file group {group}.'}
            findings = [] if clean else ([finding] if finding_counts is None else [
                {**finding, 'line': line, 'body': finding['body'] + f' Finding {line}: ' + 'retained evidence ' * 90}
                for line in range(1, finding_counts[group - 1] + 1)])
            if not requests:
                observed.findings.extend(findings)
            reply = {'action': 'inspect' if requests else 'reviewed_clean' if clean else 'request_changes',
                     'comments': findings,
                     'assessment': json.loads(APPROVAL)['assessment'], 'requests': requests}
            if inspection_loop or slow_second or group_seconds:
                reply['assessment']['reviewed_context'] = '; '.join(
                    f'Pinned evidence for group {earlier}' for earlier in sorted(history.inspected))
                if not history.inspected:
                    reply['assessment']['reviewed_context'] = 'Reading pinned guidance before the file groups.'
            if 'requests' not in schema['properties']:
                del reply['requests']
            Path(argv[argv.index('--output-last-message') + 1]).write_text(json.dumps(reply))
            return SimpleNamespace(returncode=0, stderr='', stdout=json.dumps(
                {'type': 'thread.started', 'thread_id': thread_id}))

        self.mod.run.reset_mock()
        self.mod.run.side_effect = pr_approve.run if remapping or followup else pr_review.run
        with patch.object(budget, 'monotonic', lambda: clock.now), \
                patch.object(structured_review, 'monotonic', lambda: clock.now), \
                patch.object(structured_review, 'ReviewWatch', return_value=nullcontext(SimpleNamespace(run=provider, check_closed=lambda: None))), \
                patch.object(structured_review, 'codex_environment', return_value={}), \
                (patch.dict(structured_review.PROVIDER_ANALYSIS_SECONDS, {'codex': 800})
                 if deadline and deadline.startswith('provider_analysis') else nullcontext()), \
                patch.object(subprocess, 'run', side_effect=command), \
                patch.object(api, 'sleep'), redirect_stdout(io.StringIO()):
            try:
                api.run_governed_behavior(self.mod, 'pr_approve' if remapping or followup else 'pr_review', 'https://github.com/o/r/pull/1',
                    'bit-mis', HEAD, 'poise:review-new-prs', uuid4().hex, pwd=self.directory.name,
                    model='gpt-6-astra-ultra', capped=bool(followup),
                    review_round=5 if followup else None, review_cap=5 if followup else None)
            except SystemExit:
                pass
        observed.elapsed = clock.now
        observed.paths = paths
        observed.total = total
        return api.logs()[-1], observed

    def test_staged_inspection_finishes_through_independent_outer_verification(self):
        for files in (19, 128):
            with self.subTest(files=files):
                row, run = self._staged_review(files)
                self.assertEqual((row['status'], row['outcome'], row['review_id']),
                                 ('completed', 'changes_requested', run.review_id), (row['error'], run.timeline))
                self.assertEqual(set(run.groups), set(range(1, run.total + 1)))
                self.assertEqual(run.inspected, set(run.paths))
                self.assertEqual(run.lookups, [0, 1])
                self.assertEqual(len(run.submissions), 1)
                self.assertEqual(len(run.threads), 1)
                self.assertEqual(run.guidance_reads, 1)
                self.assertNotIn('resume', run.commands[0])
                self.assertTrue(all('resume' in argv for argv in run.commands[1:]))
                argv = run.submissions[0]
                self.assertEqual(len(json.loads(argv[argv.index('--comments-json') + 1])), run.total)
                self.assertEqual(run.elapsed, 749 if files == 19 else 1237)
                self.assertLess(run.elapsed, 1413)
                self.assertEqual(row['progress']['budget']['total_seconds'], 1413)
                self.assertEqual(row['expected_head'], HEAD)
                self.assertIsNone(row['recovery_model'])

    def test_submission_leaves_time_for_authoritative_outcome_lookup(self):
        row, run = self._staged_review(19, publication='slow')
        self.assertEqual((row['status'], row['outcome'], row['review_id']),
                         ('completed', 'changes_requested', run.review_id), row['error'])
        self.assertEqual(run.lookups, [0, 1])
        self.assertEqual(len(run.submissions), 1)
        self.assertEqual(run.inspected, set(run.paths))
        self.assertEqual(run.elapsed, 1397)
        self.assertLess(run.elapsed, 1413)

    def test_slow_inspection_loop_finishes_every_group_and_verifies_one_verdict(self):
        row, run = self._staged_review(36, inspection_loop=True)
        self.assertEqual((row['status'], row['outcome'], row['review_id']),
                         ('completed', 'changes_requested', run.review_id), (row['error'], run.timeline))
        self.assertEqual(run.total, 5)
        self.assertEqual(set(run.groups), set(range(1, 6)))
        self.assertEqual(run.inspected, set(run.paths))
        self.assertEqual(run.lookups, [0, 1])
        self.assertEqual(len(run.submissions), 1)
        self.assertEqual(len(run.threads), 1)
        argv = run.submissions[0]
        findings = json.loads(argv[argv.index('--comments-json') + 1])
        self.assertEqual([finding['body'] for finding in findings],
                         [f'[p1] Blocking defect in file group {group}.' for group in range(1, 6)])
        assessment = json.loads(argv[argv.index('--assessment-json') + 1])
        self.assertEqual(assessment['reviewed_context'], '; '.join(
            f'Pinned evidence for group {group}' for group in range(1, 6)))
        self.assertEqual(row['expected_head'], HEAD)
        self.assertEqual(row['head_sha'], HEAD)
        self.assertIsNone(row['recovery_model'])
        self.assertLessEqual(run.elapsed, 1413)
        self.assertAlmostEqual(run.elapsed, 1382.8)
        self.assertAlmostEqual(row['progress']['budget']['used_seconds'], run.elapsed)

    def test_large_packet_slow_second_group_borrows_time_for_required_inspection(self):
        for files, total in ((158, 20), (171, 22)):
            with self.subTest(files=files):
                row, run = self._staged_review(files, slow_second=True)
                self.assertEqual((row['status'], row['outcome'], row['review_id']),
                                 ('completed', 'changes_requested', run.review_id), (row['error'], run.timeline))
                self.assertEqual(run.total, total)
                self.assertEqual(run.timeline[:4], [('preparation', 15, 60), ('packet', 25, 600),
                                                   ('checkout', 45, 240), ('listing', 10, 30)])
                old_share = (1293 - run.entries[2]) / (total - 1)
                self.assertLess(old_share, 62)
                self.assertEqual(run.entries[3] - run.entries[2], 92)
                self.assertGreater(run.entries[3] - run.entries[2], old_share)
                self.assertEqual(run.groups[2], 3)
                self.assertEqual(run.delivered, {group: 2 if group == 2 else 1 for group in range(1, total + 1)})
                self.assertEqual(run.inspected, set(run.paths))
                self.assertEqual(run.guidance_reads, 1)
                self.assertEqual(len(run.threads), 1)
                self.assertEqual(run.lookups, [0, 1])
                self.assertEqual(len(run.submissions), 1)
                argv = run.submissions[0]
                self.assertEqual(len(json.loads(argv[argv.index('--comments-json') + 1])), total)
                assessment = json.loads(argv[argv.index('--assessment-json') + 1])
                self.assertEqual(assessment['reviewed_context'], '; '.join(
                    f'Pinned evidence for group {group}' for group in range(1, total + 1)))
                self.assertEqual(row['expected_head'], HEAD)
                self.assertEqual(row['head_sha'], HEAD)
                self.assertIsNone(row['recovery_model'])
                self.assertLess(run.elapsed, 1413)

    def test_expensive_prefix_leaves_room_for_slow_group_and_bounds_a_stall(self):
        for deadline in (None, 'file_group'):
            with self.subTest(deadline=deadline):
                row, run = self._staged_review(
                    80, group_seconds=[110.54, 110.54, 135] + [65] * 7, deadline=deadline)
                self.assertEqual(run.total, 10)
                self.assertAlmostEqual(1293 - run.entries[3], 886.64)
                self.assertAlmostEqual(run.entries[3] - run.entries[2], 110.54)
                self.assertEqual(row['expected_head'], HEAD)
                self.assertIsNone(row['recovery_model'])
                self.assertEqual(self.mod.run.call_count, 1)
                self.assertLess(run.elapsed, 1413)
                if deadline:
                    self.assertEqual((row['status'], row['error_code']), ('failed', 'review_budget_exhausted'))
                    self.assertEqual(row['diagnostic']['phase'], 'file_group')
                    self.assertEqual(row['diagnostic']['submission'], 'none')
                    self.assertIn('file group 3 of 10', row['diagnostic']['message'])
                    self.assertIsNone(row['review_id'])
                    self.assertEqual(set(run.groups), {1, 2, 3})
                    self.assertEqual(run.submissions, [])
                    self.assertEqual(run.lookups, [0, 0])
                    continue
                self.assertEqual((row['status'], row['outcome'], row['review_id']),
                                 ('completed', 'changes_requested', run.review_id), (row['error'], run.timeline))
                self.assertEqual(set(run.groups), set(range(1, 11)))
                self.assertEqual(run.inspected, set(run.paths))
                self.assertAlmostEqual(run.entries[4] - run.entries[3], 135)
                self.assertEqual(run.lookups, [0, 1])
                self.assertEqual(len(run.submissions), 1)
                self.assertEqual(row['head_sha'], HEAD)
                argv = run.submissions[0]
                self.assertEqual(len(json.loads(argv[argv.index('--comments-json') + 1])), 10)
                assessment = json.loads(argv[argv.index('--assessment-json') + 1])
                self.assertEqual(assessment['reviewed_context'], '; '.join(
                    f'Pinned evidence for group {group}' for group in range(1, 11)))

    def test_staged_deadlines_retain_the_limiting_cause_and_never_publish_partial_results(self):
        for phase in ('file_group', 'overall', 'provider_analysis', 'inspection',
                      'file_group_inspection', 'overall_inspection', 'provider_analysis_inspection'):
            with self.subTest(phase=phase):
                row, run = self._staged_review(171, slow_second=True, deadline=phase, clean=True)
                limiting_phase = phase.removesuffix('_inspection') if phase != 'inspection' else phase
                group = 2 if limiting_phase in ('file_group', 'inspection') else 22
                self.assertEqual(row['status'], 'failed', row['error'])
                self.assertEqual(row['error_code'], 'review_inspection_timeout' if phase == 'inspection'
                                 else 'review_budget_exhausted', row['error'])
                diagnostic = row['diagnostic']
                handoff = phase == 'provider_analysis'
                self.assertEqual(diagnostic['phase'], 'analysis' if handoff else limiting_phase)
                self.assertEqual(diagnostic['outcome'], 'handoff' if handoff else 'timed_out')
                if handoff:
                    self.assertEqual(diagnostic['operation'], 'provider.review')
                if phase.endswith('_inspection'):
                    self.assertEqual(diagnostic['operation'], 'github-interface')
                if phase == 'provider_analysis_inspection':
                    self.assertEqual(row['error'], 'Local review repository inspection timed out; incomplete analysis; needs attention')
                    self.assertNotIn('handing off', row['error'])
                self.assertEqual(diagnostic['submission'], 'none')
                self.assertIn(f'file group {group} of 22', diagnostic['message'])
                self.assertIn('Incomplete analysis', diagnostic['message'])
                self.assertIn('remaining analysis', diagnostic['message'])
                self.assertLessEqual(len(diagnostic['message']), 500)
                self.assertGreaterEqual(diagnostic['elapsed_ms'], 0)
                self.assertGreater(diagnostic['timeout_seconds'], 0)
                self.assertEqual(diagnostic['expected_head'], HEAD)
                self.assertEqual(diagnostic['call_id'], row['id'])
                self.assertIsNone(row['review_id'])
                self.assertIsNone(row['recovery_model'])
                self.assertEqual(self.mod.run.call_count, 1)
                self.assertEqual(run.submissions, [])
                self.assertEqual(set(run.groups), set(range(1, group + 1)))
                self.assertEqual(run.lookups, [0] if phase == 'inspection' else [0, 0])
                analysis_end = run.elapsed if phase == 'inspection' else run.elapsed - 45
                self.assertLessEqual(analysis_end, 1293)
                self.assertLess(run.elapsed, 1413)
                if limiting_phase == 'overall':
                    self.assertEqual(analysis_end, 1293)
                elif limiting_phase == 'provider_analysis':
                    self.assertEqual(analysis_end, 95 + 800)
                else:
                    self.assertLess(analysis_end, 1293)
                if phase == 'inspection' or phase.endswith('_inspection'):
                    self.assertEqual(diagnostic['timeout_seconds'], 30 if phase == 'inspection' else 5)
                with api.db() as connection:
                    retained = json.loads(connection.execute('select diagnostic from calls where id=?', (row['id'],)).fetchone()[0])
                self.assertEqual(retained, diagnostic)

    def test_small_clean_review_uses_one_group_and_one_verified_verdict(self):
        row, run = self._staged_review(1, clean=True)
        self.assertEqual((row['status'], row['outcome'], row['review_id']),
                         ('completed', 'clean', run.review_id), row['error'])
        self.assertEqual(run.total, 1)
        self.assertEqual(run.inspected, set(run.paths))
        self.assertEqual(len(run.submissions), 1)
        self.assertEqual(run.submissions[0][1], '--reviewed-clean')
        self.assertEqual(run.lookups, [0, 1])
        self.assertIsNone(row['recovery_model'])

    def test_staged_exhaustion_and_uncertain_publication_do_not_retry(self):
        for kwargs, code in (({'stalled': True}, 'review_budget_exhausted'),
                             ({'publication': 'uncertain'}, 'review_submission_failed')):
            with self.subTest(kwargs=kwargs):
                row, run = self._staged_review(19, **kwargs)
                self.assertEqual((row['status'], row['error_code']), ('failed', code), row['error'])
                self.assertIsNone(row['review_id'])
                self.assertIsNone(row['recovery_model'])
                self.assertEqual(self.mod.run.call_count, 1)
                self.assertEqual(len(run.submissions), 0 if kwargs.get('stalled') else 1)
                self.assertLess(run.elapsed, 1413)

    def assert_retained_findings(self, row, run):
        self.assertTrue(all(not Path(path).exists() for path in run.workdirs))
        with redirect_stdout(io.StringIO()) as output:
            api.read_response(row['id'][:8])
        verdict, _ = json.JSONDecoder().raw_decode(output.getvalue())
        self.assertEqual(verdict['comments'], run.findings)
        self.assertEqual(verdict['action'], 'request_changes')
        response = row['artifact']['review_response']
        self.assertEqual(response['invocation_id'], row['id'])
        self.assertEqual(response['model'], row['model'])
        self.assertEqual(response['head_sha'], HEAD)
        self.assertTrue(all(value == response for value in run.responses))
        self.assertIsNone(row['recovery_model'])
        self.assertEqual(self.mod.run.call_count, 1)

    def test_101_aggregate_findings_are_retained_outside_the_artifact_and_held(self):
        row, run = self._staged_review(9, finding_counts=(100, 1))
        self.assertEqual((row['status'], row['error_code']), ('failed', 'review_contract_violation'), row['error'])
        self.assertIn('101 findings', row['error'])
        self.assertIn('single-review inline limit is 100', row['error'])
        self.assertEqual(row['diagnostic']['submission'], 'none')
        self.assertEqual(len(run.findings), 101)
        self.assertGreater(len(json.dumps(run.findings).encode()), 128 * 1024)
        self.assertLess(len(json.dumps(row['artifact']).encode()), 128 * 1024)
        self.assertEqual(run.submissions, [])
        self.assertIsNone(row['action'])
        self.assertIsNone(row['outcome'])
        self.assert_retained_findings(row, run)

    def test_slow_remapping_and_capped_filing_leave_both_publication_reserves(self):
        for kwargs in ({'remapping': 'slow'}, {'followup': 'slow'}):
            with self.subTest(kwargs=kwargs):
                row, run = self._staged_review(19, **kwargs)
                expected = 'approved' if kwargs.get('followup') else 'changes_requested'
                self.assertEqual((row['status'], row['outcome'], row['review_id']),
                                 ('completed', expected, run.review_id), row['error'])
                self.assertEqual(len(run.submissions), 1)
                self.assertEqual(run.lookups[-1], 1)
                self.assertLessEqual(run.elapsed, 1413)
                self.assert_retained_findings(row, run)

    def test_finalization_at_reserve_boundary_holds_completed_analysis(self):
        for operation in ('remapping', 'followup'):
            for mode in ('boundary', 'timeout'):
                with self.subTest(operation=operation, mode=mode):
                    row, run = self._staged_review(19, **{operation: mode})
                    self.assertEqual((row['status'], row['error_code']),
                                     ('failed', 'review_submission_failed' if operation == 'followup' and mode == 'timeout'
                                      else 'review_contract_violation'), row['error'])
                    self.assertEqual(run.submissions, [])
                    self.assertEqual(len(run.issues), int(operation == 'followup' and mode == 'timeout'))
                    self.assertIsNone(row['action'])
                    self.assertIsNone(row['outcome'])
                    self.assert_retained_findings(row, run)

    def test_lost_post_responses_and_rejected_filing_retain_findings_without_replay(self):
        for kwargs in ({'publication': 'uncertain'}, {'followup': 'lost'}, {'followup': 'rejected'}):
            with self.subTest(kwargs=kwargs):
                row, run = self._staged_review(19, **kwargs)
                self.assertEqual((row['status'], row['error_code']),
                                 ('failed', 'review_contract_violation' if kwargs.get('followup') == 'rejected'
                                  else 'review_submission_failed'), row['error'])
                self.assertEqual(len(run.submissions), int('publication' in kwargs))
                self.assertEqual(len(run.issues), int('followup' in kwargs))
                if kwargs.get('followup') == 'rejected':
                    self.assertEqual(row['diagnostic']['submission'], 'rejected')
                self.assertIsNone(row['action'])
                self.assertIsNone(row['outcome'])
                self.assertIsNone(row['review_id'])
                self.assert_retained_findings(row, run)

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

    def test_repeat_only_refusal_recovers_once_with_a_different_model(self):
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
        row = self.execute([refusal_error(), recovered], [before, mid, after])
        self.assertEqual([x.kwargs['model'] for x in self.mod.run.call_args_list], ['opus-5-high', 'gpt-6-astra-ultra'])
        self.assertEqual(row['outcome'], 'approved')
        self.assertEqual(row['model'], 'opus-5-high')
        self.assertEqual(row['recovery_model'], 'gpt-6-astra-ultra')
        response = stored_response(row['id'])
        self.assertIn('review submission was a no-op', response)
        self.assertIn('done', response)

    def test_repeat_only_refusal_recovers_for_a_non_claude_primary(self):
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
        row = self.execute([refusal_error(), recovered], [before, mid, after], model='grok-4.6-xhigh')
        self.assertEqual([x.kwargs['model'] for x in self.mod.run.call_args_list], ['grok-4.6-xhigh', 'gpt-6-astra-ultra'])
        self.assertEqual(row['outcome'], 'approved')
        self.assertEqual(row['recovery_model'], 'gpt-6-astra-ultra')

    def test_repeat_only_refusal_cannot_fallback_to_itself(self):
        row = self.execute([refusal_error()], [facts(), facts()], model='gpt-6-astra-ultra')
        self.assertEqual(self.mod.run.call_count, 1)
        self.assertEqual(row['error_code'], 'review_contract_violation')
        self.assertIsNone(row['recovery_model'])

    def test_duplicate_noop_never_recovers(self):
        row = self.execute([refusal_error('duplicate')], [facts(), facts()])
        self.assertEqual(self.mod.run.call_count, 1)
        self.assertEqual(row['error_code'], 'review_contract_violation')
        self.assertIsNone(row['recovery_model'])

    def test_repeat_only_predicate_ignores_untyped_failures(self):
        self.assertFalse(api._repeat_only_refusal(budget.ReviewLimitError('no-op', 'review_contract_violation')))
        self.assertFalse(api._repeat_only_refusal(atoms.AgentPreflightError('no-op', 'review_contract_violation')))
        self.assertFalse(api._repeat_only_refusal(budget.ReviewLimitError('output limit')))
        self.assertTrue(api._repeat_only_refusal(refusal_error()))

    def test_repeat_only_refusal_never_recovers_past_a_pending_review(self):
        row = self.execute([refusal_error()], [facts(), facts(reviewer_pending_reviews=1)])
        self.assertEqual(self.mod.run.call_count, 1)
        self.assertEqual(row['error_code'], 'review_contract_violation')
        self.assertIn('could not prove a safe recovery', row['error'])
        self.assertIsNone(row['recovery_model'])

    def test_repeat_only_refusal_holds_when_another_review_is_published(self):
        before = facts()
        before['reviewer_reviews_since_items'] = []
        after = facts()
        after['reviewer_reviews_since_items'] = [{'id': 99}]
        with patch.object(api, 'sleep'):
            row = self.execute([refusal_error()], [before, after])
        self.assertEqual(self.mod.run.call_count, 1)
        self.assertEqual(row['error_code'], 'review_contract_violation')
        self.assertIn('another review is already published on this head', row['error'])
        self.assertIsNone(row['recovery_model'])

    def test_repeat_only_refusal_keeps_prior_failure_when_recovery_fails(self):
        row = self.execute([refusal_error(), atoms.AgentPreflightError('codex failed')], [facts(), facts(), facts()])
        self.assertEqual(self.mod.run.call_count, 2)
        self.assertEqual(row['error_code'], 'review_recovery_failed')
        self.assertIn('codex failed', row['error'])
        self.assertIn('prior: review submission was a no-op', row['error'])

    def test_repeat_only_refusal_keeps_prior_failure_when_recovery_supersedes(self):
        from agent_interface.review_watch import ReviewSuperseded
        row = self.execute([refusal_error(), ReviewSuperseded('b' * 40)], [facts(), facts()])
        self.assertEqual(self.mod.run.call_count, 2)
        self.assertEqual(row['outcome'], 'superseded')
        response = stored_response(row['id'])
        self.assertIn('head or base changed', response)
        self.assertIn('prior: review submission was a no-op', response)

    def test_repeat_only_refusal_keeps_prior_disposition_when_head_moves(self):
        row = self.execute([refusal_error()], [facts(), facts(head_sha='b' * 40)])
        self.assertEqual(self.mod.run.call_count, 1)
        self.assertEqual(row['outcome'], 'superseded')
        self.assertEqual(row['head_sha'], 'b' * 40)
        self.assertEqual(row['error_code'], 'review_contract_violation')
        self.assertIn('review submission was a no-op', row['error'])

    def test_refused_submission_supersedes_when_the_pr_context_changed(self):
        before = facts(review_context='a' * 64, reviewer_reviews_since_items=[])
        row = self.execute([context_refusal()], [before, {**before, 'review_context': 'b' * 64}])
        self.assertEqual(self.mod.run.call_count, 1)
        self.assertEqual(row['status'], 'superseded')
        self.assertEqual(row['outcome'], 'superseded')
        self.assertEqual(row['head_sha'], HEAD)
        self.assertEqual(row['error_code'], 'review_contract_violation')
        self.assertIn('retained review response differs', row['error'])

    def test_uncertain_submission_holds_when_the_pr_context_changed(self):
        before = facts(review_context='a' * 64, reviewer_reviews_since_items=[])
        row = self.execute([api.review_receipt.SubmissionError('publication uncertain')],
                           [before, {**before, 'review_context': 'b' * 64}])
        self.assertEqual(self.mod.run.call_count, 1)
        self.assertEqual(row['status'], 'failed')
        self.assertEqual(row['error_code'], 'review_submission_failed')

    def test_uncertain_recovery_holds_when_the_pr_context_changed(self):
        before = facts(review_context='a' * 64, reviewer_reviews_since_items=[])
        moved = {**before, 'review_context': 'b' * 64}
        for uncertain in (api.review_receipt.SubmissionError('publication uncertain'),
                          budget.ReviewLimitError('Provider exited during a GitHub submission; needs reconciliation',
                                                  'review_recovery_failed'),
                          subprocess.TimeoutExpired('provider', 1)):
            with self.subTest(uncertain=type(uncertain).__name__):
                row = self.execute([budget.ReviewLimitError('output token maximum'), uncertain], [before, before, moved])
                self.assertEqual(row['status'], 'failed')
                self.assertEqual(row['error_code'], 'review_recovery_failed')
                self.assertIsNone(row['outcome'])

    def test_refused_recovery_supersedes_when_the_pr_context_changed(self):
        before = facts(review_context='a' * 64, reviewer_reviews_since_items=[])
        row = self.execute([budget.ReviewLimitError('output token maximum'), context_refusal()],
                           [before, before, {**before, 'review_context': 'b' * 64}])
        self.assertEqual(self.mod.run.call_count, 2)
        self.assertEqual(row['status'], 'superseded')
        self.assertEqual(row['outcome'], 'superseded')
        self.assertEqual(row['head_sha'], HEAD)

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
