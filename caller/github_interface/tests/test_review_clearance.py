from copy import deepcopy
from io import StringIO
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from github_interface import cli
from github_interface.behaviors import merge_pr, review_clearance

HEAD, INTEGRATION, BASE = 'a' * 40, 'b' * 40, 'c' * 40
APP = 123
NAME = 'Poise review clearance'
PULL = {'number': 17, 'state': 'open', 'draft': False, 'title': 'Candidate', 'body': '',
        'user': {'login': 'author'}, 'head': {'sha': HEAD, 'ref': 'poise/issue-7', 'repo': {'full_name': 'autonomio/poise'}},
        'base': {'sha': BASE}}
RULES = [{'type': 'required_status_checks', 'parameters': {'required_status_checks': [
    {'context': NAME, 'integration_id': APP}, {'context': 'Caller (Python 3.13)', 'integration_id': 15368},
    {'context': 'Verify (Node 22)', 'integration_id': 15368}]}}]


class TestClearanceCli(TestCase):
    def test_publisher_uses_the_dedicated_interface_without_a_user_token_or_candidate_checkout(self):
        operation = AsyncMock(return_value={'checks': []})
        with patch('sys.argv', ['github-interface', '--review-clearance', '--mode', 'begin', '--results-json', '[]']), \
                patch.object(cli, 'review_clearance', operation), patch('sys.stdout', StringIO()):
            cli.main()
        self.assertEqual(operation.call_args.args, ({'mode': 'begin', 'results_json': '[]', 'token_user': None},))


class TestClearancePublisher(IsolatedAsyncioTestCase):
    async def test_queue_snapshot_uses_the_actual_integration_sha_and_original_heads_for_every_member(self):
        client = AsyncMock()
        client.paginate.return_value = [PULL, {**deepcopy(PULL), 'number': 18, 'head': {
            **PULL['head'], 'sha': 'd' * 40, 'ref': 'independent'}, 'user': {'login': 'independent'}}]
        client.graphql.return_value = {'repository': {'mergeQueue': {'entries': {
            'pageInfo': {'hasNextPage': False}, 'nodes': [
                {'position': 1, 'pullRequest': {'number': 17, 'headRefOid': HEAD}, 'baseCommit': {'oid': BASE}, 'headCommit': None},
                {'position': 2, 'pullRequest': {'number': 18, 'headRefOid': 'd' * 40}, 'baseCommit': {'oid': BASE},
                 'headCommit': {'oid': INTEGRATION}}]}}}}
        client.get.return_value = {'status': 'ahead'}
        with patch.object(review_clearance, 'list_reviews', AsyncMock(return_value=[])):
            snapshot = await review_clearance.snapshot(client)
        self.assertEqual(snapshot['groups'], [{'head': INTEGRATION, 'base': BASE, 'pulls': [17, 18]}])
        self.assertEqual([call.args[0] for call in client.get.await_args_list], [
            f'/repos/autonomio/poise/compare/{head}...{INTEGRATION}' for head in (HEAD, 'd' * 40)])
        self.assertEqual([pull['number'] for pull in snapshot['pulls']], [17, 18])
        client.get.return_value = {'status': 'diverged'}
        with patch.object(review_clearance, 'list_reviews', AsyncMock(return_value=[])):
            with self.assertRaisesRegex(RuntimeError, 'does not contain'):
                await review_clearance.snapshot(client)

    async def test_only_the_bound_app_can_publish_success_and_an_old_evaluation_cannot_restore_it(self):
        client = AsyncMock()
        client.get.return_value = RULES
        checks = [{'id': 1, 'name': NAME, 'head_sha': HEAD, 'app': {'id': APP}},
                  {'id': 2, 'name': NAME, 'head_sha': HEAD, 'app': {'id': APP}}]
        with patch.object(review_clearance, 'list_check_runs', AsyncMock(return_value=checks)):
            result = await review_clearance.publish(client, APP, 'complete', [
                {'id': 1, 'head': HEAD, 'conclusion': 'success'}])
        client.patch.assert_not_awaited()
        self.assertTrue(result['checks'][0]['superseded'])
        for publisher in (None, 15368):
            client.get.return_value = [{'type': 'required_status_checks', 'parameters': {
                'required_status_checks': [{'context': NAME, 'integration_id': publisher}]}}]
            with self.assertRaisesRegex(RuntimeError, 'must require'):
                await review_clearance.publish(client, APP, 'complete', [{'id': 2, 'head': HEAD, 'conclusion': 'success'}])
        client.patch.assert_not_awaited()

    async def test_github_queue_boundary_refuses_pending_and_native_changes_requested_then_accepts_clearance(self):
        # CI and a distinct GitHub approval remain green throughout. Only the
        # App's required context changes; the actual enqueue behavior consumes it.
        client = AsyncMock()
        client.get.return_value = RULES
        latest = {'id': 0, 'name': NAME, 'head_sha': HEAD, 'app': {'id': APP}}

        async def create(_path, *, json):
            latest.update(json, id=latest['id'] + 1, conclusion=None)
            return deepcopy(latest)

        async def update(_path, *, json):
            latest.update(json)

        client.post.side_effect = create
        client.patch.side_effect = update
        pull = {**PULL, 'merged': False, 'mergeable': True, 'mergeable_state': 'blocked'}

        async def readiness(*_args):
            return {'id': 'PR_17', 'headRefOid': HEAD, 'state': 'OPEN', 'isDraft': False, 'mergeable': 'MERGEABLE',
                    'mergeStateStatus': 'BLOCKED', 'mergeQueue': {'id': 'QUEUE'}, 'mergeQueueEntry': None,
                    'reviewDecision': 'APPROVED', 'reviewThreads': {'pageInfo': {'hasNextPage': False}, 'nodes': []},
                    'reviews': {'pageInfo': {'hasNextPage': False}, 'nodes': []},
                    'commits': {'nodes': [{'commit': {'statusCheckRollup': {
                        'state': 'SUCCESS' if latest.get('conclusion') == 'success' else 'FAILURE'}}}]}}

        payload = {'repository': 'autonomio/poise', 'pr': '#17', 'expected_head': HEAD}
        with patch.object(review_clearance, 'list_check_runs', AsyncMock(side_effect=lambda *_args, **_kwargs: [deepcopy(latest)])), \
                patch.object(merge_pr, 'get_pull', AsyncMock(return_value=pull)), \
                patch.object(merge_pr, 'get_pr_readiness_state', AsyncMock(side_effect=readiness)), \
                patch.object(merge_pr, 'enqueue_pull_request', AsyncMock(return_value={'id': 'ENTRY'})) as enqueue:
            handles = (await review_clearance.publish(client, APP, 'begin', [{'head': HEAD}]))['checks']
            self.assertEqual((await merge_pr.run(client, payload))['outcome'], 'not_ready')
            await review_clearance.publish(client, APP, 'complete', [{**handles[0], 'conclusion': 'failure',
                                                                       'summary': 'Native changes requested'}])
            self.assertEqual((await merge_pr.run(client, payload))['outcome'], 'not_ready')
            enqueue.assert_not_awaited()
            await review_clearance.publish(client, APP, 'complete', [{**handles[0], 'conclusion': 'success'}])
            self.assertEqual((await merge_pr.run(client, payload))['outcome'], 'enqueued')
            enqueue.assert_awaited_once_with(client, 'PR_17', HEAD)

    async def test_blocking_results_never_use_neutral_or_skipped_and_cannot_target_an_untrusted_check(self):
        client = AsyncMock()
        client.post.return_value = {'id': 1, 'head_sha': HEAD, 'app': {'id': 15368}}
        with self.assertRaisesRegex(RuntimeError, 'trusted clearance check'):
            await review_clearance.publish(client, APP, 'begin', [{'head': HEAD}])
        for verdict in ('neutral', 'skipped'):
            with self.assertRaisesRegex(ValueError, 'blocking or successful'):
                await review_clearance.publish(client, APP, 'complete', [{'id': 1, 'head': HEAD, 'conclusion': verdict}])
