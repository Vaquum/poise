from copy import deepcopy
from io import StringIO
import json
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from github_interface import cli, interface
from github_interface.behaviors import grey_ci_candidates, rerun_grey_ci_if_ready

HEAD = 'a' * 40
REQUESTS = [{'repository': 'acme/app', 'number': n} for n in range(1, 11)]
PULL = {'state': 'open', 'draft': False, 'head': {'sha': HEAD}, 'user': {'login': 'octocat'}}
WORKFLOW = {'id': 100, 'run_attempt': 2, 'head_sha': HEAD, 'status': 'completed', 'conclusion': 'cancelled',
            'pull_requests': [{'number': 7}], 'workflow_id': 70, 'event': 'pull_request_review'}
JOB = {'run_id': 100, 'run_attempt': 2, 'status': 'completed', 'conclusion': 'cancelled'}
PAYLOAD = {'repository': 'acme/app', 'pr': '#7', 'expected_head': HEAD, 'author': 'octocat',
           'run_id': 100, 'run_attempt': 2, 'token_user': 'review-bot'}


def context(status='COMPLETED', conclusion='CANCELLED', run_id=100, created='2026-10-13T09:23:04Z', event='pull_request_review'):
    return {'status': status, 'conclusion': conclusion, 'workflowRun': {
        'databaseId': run_id, 'runAttempt': 2, 'event': event, 'createdAt': created, 'workflow': {'databaseId': 70}}}


def response(contexts=None):
    contexts = [context()] if contexts is None else contexts
    pull = {'state': 'OPEN', 'isDraft': False, 'headRefOid': HEAD, 'author': {'login': 'octocat'},
            'commits': {'nodes': [{'commit': {'checkSuites': {
                'nodes': contexts, 'pageInfo': {'hasNextPage': False, 'endCursor': None}}}}]}}
    return {'data': {'viewer': {'login': 'review-bot'}, 'rateLimit': {'cost': 1},
                     **{f'pr{i}': {'nameWithOwner': r['repository'], 'pullRequest': {**deepcopy(pull), 'number': r['number']}}
                        for i, r in enumerate(REQUESTS)}}}


class TestGreyDiscovery(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncMock()
        self.client.request.return_value = response()

    async def read(self):
        return await grey_ci_candidates.run(self.client, {'requests': REQUESTS, 'token_user': 'review-bot'})

    async def test_ten_prs_share_one_graphql_call_and_no_rest_polling(self):
        result = await self.read()
        self.assertEqual(len(result['records']), 10)
        self.assertEqual(result['graphql_cost'], 1)
        self.client.request.assert_awaited_once()
        self.assertEqual(self.client.request.call_args.args, ('POST', '/graphql'))
        self.client.get.assert_not_awaited()
        self.client.post.assert_not_awaited()
        self.assertEqual(result['records'][0]['runs'][0]['run_id'], 100)

    async def test_sixty_scans_are_sixty_queries_regardless_of_ten_prs(self):
        self.client.request.return_value = response([context(conclusion='SUCCESS')])
        for _ in range(60):
            self.assertTrue(all(not row['runs'] for row in (await self.read())['records']))
        self.assertEqual(self.client.request.await_count, 60)
        self.client.get.assert_not_awaited()

    async def test_only_completed_grey_interruptions_are_candidates(self):
        for status, conclusion, expected in [('COMPLETED', 'CANCELLED', True), ('COMPLETED', 'STALE', True),
                ('COMPLETED', 'TIMED_OUT', True),
                ('COMPLETED', 'FAILURE', False),
                ('COMPLETED', 'SUCCESS', False), ('COMPLETED', 'SKIPPED', False), ('COMPLETED', 'NEUTRAL', False),
                ('COMPLETED', 'ACTION_REQUIRED', False), ('IN_PROGRESS', None, False), ('QUEUED', None, False)]:
            with self.subTest(status=status, conclusion=conclusion):
                self.client.request.return_value = response([context(status, conclusion)])
                self.assertEqual(bool((await self.read())['records'][0]['runs']), expected)

    async def test_newer_success_or_active_replacement_supersedes_old_cancelled_run(self):
        for status, conclusion in [('IN_PROGRESS', None), ('COMPLETED', 'SUCCESS')]:
            self.client.request.return_value = response([context(), context(status, conclusion, 101, '2026-10-13T10:00:00Z')])
            self.assertEqual((await self.read())['records'][0]['runs'], [])
        # A different trigger does not replace the cancelled review-triggered run.
        self.client.request.return_value = response([context(), context('COMPLETED', 'SUCCESS', 101,
                                                                      '2026-10-13T10:00:00Z', 'pull_request')])
        self.assertEqual(len((await self.read())['records'][0]['runs']), 1)

    async def test_duplicate_matrix_contexts_do_not_duplicate_workflow_recovery(self):
        self.client.request.return_value = response([context(), context(), {'workflowRun': None}])
        self.assertEqual(len((await self.read())['records'][0]['runs']), 1)

    async def test_partial_error_is_scoped_and_does_not_drop_readable_targets(self):
        value = response()
        value['errors'] = [{'path': ['pr0'], 'message': 'repository unavailable'}]
        value['data']['pr0'] = None
        self.client.request.return_value = value
        rows = (await self.read())['records']
        self.assertTrue(rows[0]['error'])
        self.assertTrue(rows[1]['runs'])

    async def test_truncated_contexts_are_completed_and_latest_replacement_is_seen(self):
        value = response()
        for i in range(10):
            value['data'][f'pr{i}']['pullRequest']['commits']['nodes'][0]['commit']['checkSuites']['pageInfo'] = {
                'hasNextPage': True, 'endCursor': 'next'}
        self.client.request.return_value = value
        page = {'nodes': [context('IN_PROGRESS', None, 101, '2026-10-13T10:00:00Z')],
                'pageInfo': {'hasNextPage': False, 'endCursor': None}}
        self.client.graphql.return_value = {'rateLimit': {'cost': 1}, 'repository': {'pullRequest': {
            'headRefOid': HEAD, 'commits': {'nodes': [{'commit': {'checkSuites': page}}]}}}}
        result = await self.read()
        self.assertEqual(result['graphql_cost'], 11)
        self.assertTrue(all(not row['runs'] for row in result['records']))
        self.assertEqual(self.client.graphql.await_count, 10)


class TestGreyRerun(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncMock()
        self.workflow = deepcopy(WORKFLOW)
        self.jobs = [deepcopy(JOB)]
        self.latest = None
        async def read(path, **kwargs):
            if path.endswith('/jobs'):
                return {'jobs': deepcopy(self.jobs), 'total_count': len(self.jobs)}
            if path.endswith('/runs'):
                return {'workflow_runs': [deepcopy(self.latest or self.workflow)]}
            return deepcopy(self.workflow)
        self.client.get.side_effect = read
        self.pulls = AsyncMock(return_value=deepcopy(PULL))
        patcher = patch.object(rerun_grey_ci_if_ready, 'get_pull', self.pulls)
        patcher.start(); self.addCleanup(patcher.stop)

    async def rerun(self):
        return await rerun_grey_ci_if_ready.run(self.client, PAYLOAD)

    async def test_grey_workflow_requests_exact_rerun_without_cancel_or_mutation_retry(self):
        self.assertEqual((await self.rerun())['outcome'], 'rerun_requested')
        self.client.post.assert_awaited_once_with('/repos/acme/app/actions/runs/100/rerun')
        self.assertEqual(self.pulls.await_count, 2)
        self.assertEqual(self.client.get.await_count, 3)
        self.client.get.assert_any_await('/repos/acme/app/actions/runs/100/attempts/2/jobs', params={'per_page': 100, 'page': 1})

    async def test_uncertain_rerun_inspection_requires_a_later_attempt_and_never_writes(self):
        for status in ('queued', 'in_progress', 'completed'):
            with self.subTest(status=status):
                self.workflow = {**deepcopy(WORKFLOW), 'run_attempt': 3, 'status': status}
                result = await rerun_grey_ci_if_ready.run(self.client, {**PAYLOAD, 'inspect': True})
                self.assertEqual((result['outcome'], result['observed_run_attempt']), ('rerun_observed', 3))
                self.assertEqual(result['workflow_status'], status)
        self.workflow = deepcopy(WORKFLOW)
        self.assertEqual((await rerun_grey_ci_if_ready.run(self.client, {**PAYLOAD, 'inspect': True}))['outcome'], 'unconfirmed')
        for changed in ({'head_sha': 'b' * 40}, {'id': 99}, {'run_attempt': 1}):
            with self.subTest(changed=changed):
                self.workflow = {**deepcopy(WORKFLOW), **changed}
                self.assertEqual((await rerun_grey_ci_if_ready.run(self.client, {**PAYLOAD, 'inspect': True}))['outcome'], 'read_failed')
        self.client.post.assert_not_awaited()

    async def test_failed_green_active_and_skipped_runs_never_rerun(self):
        for fields in [{'conclusion': 'failure'}, {'conclusion': 'success'},
                       {'conclusion': 'skipped'}, {'conclusion': 'neutral'}, {'status': 'in_progress'},
                       {'status': 'queued'}, {'run_attempt': 3}, {'head_sha': 'b' * 40}, {'pull_requests': [{'number': 8}]}]:
            with self.subTest(fields=fields):
                self.workflow = {**deepcopy(WORKFLOW), **fields}
                self.assertEqual((await self.rerun())['outcome'], 'not_ready')
                self.client.post.assert_not_awaited()

    async def test_timed_out_run_with_an_interrupted_job_reruns(self):
        self.workflow = {**deepcopy(WORKFLOW), 'conclusion': 'timed_out'}
        self.assertEqual((await self.rerun())['outcome'], 'rerun_requested')
        self.client.post.assert_awaited_once_with('/repos/acme/app/actions/runs/100/rerun')

    async def test_failed_rollup_beside_a_cancelled_job_reruns_the_whole_workflow(self):
        self.jobs = [{**JOB, 'conclusion': 'cancelled'}, {**JOB, 'conclusion': 'failure'},
                   {**JOB, 'conclusion': 'success'}]
        self.assertEqual((await self.rerun())['outcome'], 'rerun_requested')
        self.client.post.assert_awaited_once_with('/repos/acme/app/actions/runs/100/rerun')

    async def test_timed_out_job_beside_completed_jobs_reruns(self):
        self.jobs = [{**JOB, 'conclusion': 'timed_out'}, {**JOB, 'conclusion': 'success'}]
        self.assertEqual((await self.rerun())['outcome'], 'rerun_requested')
        self.client.post.assert_awaited_once_with('/repos/acme/app/actions/runs/100/rerun')

    async def test_jobs_without_an_interruption_never_rerun(self):
        for conclusions in (['success', 'failure'], ['failure'], ['success'], ['skipped', 'neutral']):
            with self.subTest(conclusions=conclusions):
                self.jobs = [{**JOB, 'conclusion': conclusion} for conclusion in conclusions]
                self.assertEqual((await self.rerun())['outcome'], 'not_ready')
                self.client.post.assert_not_awaited()

    async def test_an_active_unknown_or_mismatched_job_blocks_whole_workflow_rerun(self):
        for fields in [{'conclusion': None}, {'conclusion': 'action_required'},
                       {'status': 'in_progress'}, {'run_id': 99}, {'run_attempt': 1}]:
            with self.subTest(fields=fields):
                self.jobs = [deepcopy(JOB), {**JOB, **fields}]
                self.assertEqual((await self.rerun())['outcome'], 'not_ready')
                self.client.post.assert_not_awaited()

    async def test_cancelled_before_jobs_started_and_push_ci_can_recover(self):
        self.jobs = []
        self.workflow['pull_requests'] = []
        self.assertEqual((await self.rerun())['outcome'], 'rerun_requested')

    async def test_draft_closed_foreign_or_changed_head_refuses_recovery(self):
        for fields in [{'draft': True}, {'state': 'closed'}, {'user': {'login': 'other'}}, {'head': {'sha': 'b' * 40}}]:
            with self.subTest(fields=fields):
                self.pulls.return_value = {**deepcopy(PULL), **fields}
                self.assertIn((await self.rerun())['outcome'], ['not_ready', 'superseded'])
                self.client.post.assert_not_awaited()

    async def test_head_or_attempt_changes_immediately_before_write_refuse_recovery(self):
        self.pulls.side_effect = [PULL, {**PULL, 'head': {'sha': 'b' * 40}}]
        self.assertEqual((await self.rerun())['outcome'], 'superseded')
        self.client.post.assert_not_awaited()
        self.pulls.side_effect = None; self.pulls.return_value = deepcopy(PULL)
        for fields in [{'id': 101}, {'run_attempt': 3}, {'status': 'in_progress'}, {'conclusion': 'success'}]:
            self.latest = {**WORKFLOW, **fields}
            self.assertEqual((await self.rerun())['outcome'], 'not_ready')
            self.client.post.assert_not_awaited()

    async def test_incomplete_job_inventory_fails_visibly_without_a_write(self):
        self.client.get.side_effect = [WORKFLOW, {'jobs': [], 'total_count': 1}]
        result = await self.rerun()
        self.assertEqual(result['outcome'], 'read_failed')
        self.assertIn('incomplete', result['error'])
        self.client.post.assert_not_awaited()

    async def test_read_failure_proves_no_write_but_a_write_error_remains_ambiguous(self):
        self.client.get.side_effect = RuntimeError('read unavailable')
        self.assertEqual((await self.rerun())['outcome'], 'read_failed')
        self.client.post.assert_not_awaited()
        self.client.get.side_effect = [WORKFLOW, {'jobs': [JOB], 'total_count': 1}, {'workflow_runs': [WORKFLOW]}]
        self.client.post.side_effect = RuntimeError('write receipt lost')
        with self.assertRaisesRegex(RuntimeError, 'write receipt lost'):
            await self.rerun()

    async def test_missing_identity_is_refused(self):
        with self.assertRaisesRegex(ValueError, 'token-user is required'):
            await interface.rerun_grey_ci_if_ready({k: v for k, v in PAYLOAD.items() if k != 'token_user'})


class TestGreyCli(TestCase):
    def test_batch_cli_routes_without_a_positional_pr(self):
        operation = AsyncMock(return_value={})
        with patch('sys.argv', ['github-interface', '--grey-ci-candidates', '--requests-json', json.dumps(REQUESTS),
                                '--token-user', 'review-bot']), patch.object(cli, 'grey_ci_candidates', operation), \
                patch('sys.stdout', StringIO()):
            cli.main()
        operation.assert_awaited_once_with({'requests': REQUESTS, 'token_user': 'review-bot'})

    def test_mutation_cli_routes_exact_head_run_and_attempt(self):
        operation = AsyncMock(return_value={})
        with patch('sys.argv', ['github-interface', '--rerun-grey-ci-if-ready', '#7', '--run-id', '100', '--run-attempt', '2',
                                '--expected-head', HEAD, '--author', 'octocat', '--token-user', 'review-bot']), \
                patch.object(cli, 'rerun_grey_ci_if_ready', operation), patch('sys.stdout', StringIO()):
            cli.main()
        operation.assert_awaited_once_with({k: v for k, v in PAYLOAD.items() if k != 'repository'})
