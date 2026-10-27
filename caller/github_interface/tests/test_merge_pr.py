from copy import deepcopy
from io import StringIO
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from github_interface import cli, interface
from github_interface.behaviors import merge_pr

HEAD = 'a' * 40
PULL = {'state': 'open', 'draft': False, 'mergeable': True, 'mergeable_state': 'clean',
        'head': {'sha': HEAD}, 'user': {'login': 'octocat'}, 'merged': False}
READY = {'state': 'OPEN', 'isDraft': False, 'mergeable': 'MERGEABLE', 'mergeStateStatus': 'CLEAN',
         'headRefOid': HEAD, 'commits': {'nodes': [{'commit': {'statusCheckRollup': {'state': 'SUCCESS'}}}]},
         'reviewThreads': {'nodes': [], 'pageInfo': {'hasNextPage': False}}}
PAYLOAD = {'repository': 'acme/app', 'pr': '#7', 'expected_head': HEAD, 'token_user': 'octocat'}


class TestMergePr(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncMock()
        self.client.get.return_value = {'allow_squash_merge': True, 'allow_merge_commit': True}
        self.client.request.return_value = {'merged': True, 'sha': 'b' * 40}
        self.pull = deepcopy(PULL)
        self.ready = deepcopy(READY)
        self.pulls = AsyncMock(side_effect=lambda *_: deepcopy(self.pull))
        self.readiness = AsyncMock(side_effect=lambda *_: deepcopy(self.ready))
        self.patch_pull = patch.object(merge_pr, 'get_pull', self.pulls)
        self.patch_ready = patch.object(merge_pr, 'get_pr_readiness_state', self.readiness)
        self.patch_pull.start()
        self.patch_ready.start()
        self.addCleanup(self.patch_pull.stop)
        self.addCleanup(self.patch_ready.stop)

    async def test_merges_green_head_with_exact_sha_and_allowed_squash_method(self):
        result = await merge_pr.run(self.client, PAYLOAD)
        self.assertEqual(result['outcome'], 'merged')
        self.assertEqual(result['merge_sha'], 'b' * 40)
        self.assertEqual(result['merge_method'], 'squash')
        self.client.request.assert_awaited_once_with('PUT', '/repos/acme/app/pulls/7/merge',
                                                    json={'sha': HEAD, 'merge_method': 'squash'})

    async def test_merges_whatever_account_authored_it(self):
        self.pull['user'] = {'login': 'someone-else'}
        result = await merge_pr.run(self.client, PAYLOAD)
        self.assertEqual(result['outcome'], 'merged')

    async def test_selects_only_a_repository_allowed_method(self):
        for config, expected in [({'allow_merge_commit': True}, 'merge'), ({'allow_rebase_merge': True}, 'rebase')]:
            with self.subTest(expected=expected):
                self.client.get.return_value = config
                await merge_pr.run(self.client, PAYLOAD)
                self.assertEqual(self.client.request.call_args.kwargs['json']['merge_method'], expected)

    async def test_unsafe_or_unknown_pull_never_merges(self):
        for fields in [{'draft': True}, {'state': 'closed'}, {'mergeable': None}, {'mergeable': False},
                       {'mergeable_state': 'unknown'}, {'mergeable_state': 'blocked'}]:
            with self.subTest(fields=fields):
                self.pull = {**deepcopy(PULL), **fields}
                result = await merge_pr.run(self.client, PAYLOAD)
                self.assertEqual(result['outcome'], 'not_ready')
                self.client.request.assert_not_awaited()

    async def test_failed_pending_or_unread_checks_never_merge(self):
        for state in ['FAILURE', 'PENDING', 'ERROR', 'EXPECTED']:
            with self.subTest(state=state):
                self.ready['commits']['nodes'][0]['commit']['statusCheckRollup']['state'] = state
                self.assertEqual((await merge_pr.run(self.client, PAYLOAD))['outcome'], 'not_ready')
                self.client.request.assert_not_awaited()

    async def test_head_changed_in_each_read_is_superseded_without_mutation(self):
        changed = {**PULL, 'head': {'sha': 'c' * 40}}
        for reads, ready in [([changed], READY), ([PULL], {**READY, 'headRefOid': 'c' * 40}), ([PULL, changed], READY)]:
            with self.subTest(reads=reads, ready=ready):
                self.pulls.side_effect = reads
                self.readiness.side_effect = None
                self.readiness.return_value = ready
                result = await merge_pr.run(self.client, PAYLOAD)
                self.assertEqual((result['outcome'], result['actual_head']), ('superseded', 'c' * 40))
                self.client.request.assert_not_awaited()

    async def test_already_merged_reports_who_merged_it(self):
        self.pull.update(state='closed', merged=True, merged_by={'login': 'hubot'}, merge_commit_sha='d' * 40)
        result = await merge_pr.run(self.client, PAYLOAD)
        self.assertEqual((result['outcome'], result['merged_by'], result['merge_sha']), ('already_merged', 'hubot', 'd' * 40))
        self.client.request.assert_not_awaited()
        self.readiness.assert_not_awaited()

    async def test_a_refused_merge_returns_github_words_not_an_exception(self):
        self.client.request.return_value = {'merged': False, 'message': 'Pull Request is not mergeable'}
        result = await merge_pr.run(self.client, PAYLOAD)
        self.assertEqual((result['outcome'], result['message']), ('refused', 'Pull Request is not mergeable'))

    async def test_queue_admission_enqueues_and_observes_an_existing_entry(self):
        self.ready['mergeQueue'] = {'id': 'queue-1'}
        self.ready['reviewDecision'] = 'APPROVED'
        self.ready['id'] = 'PR_1'
        with patch.object(merge_pr, 'enqueue_pull_request', AsyncMock(return_value={'id': 'entry-1'})) as enqueue:
            result = await merge_pr.run(self.client, PAYLOAD)
        self.assertEqual((result['outcome'], result['queue_entry_id']), ('enqueued', 'entry-1'))
        enqueue.assert_awaited_once()
        self.ready['mergeQueueEntry'] = {'id': 'entry-9'}
        result = await merge_pr.run(self.client, PAYLOAD)
        self.assertEqual((result['outcome'], result['queue_entry_id']), ('in_queue', 'entry-9'))
        self.client.request.assert_not_awaited()

    async def test_missing_head_is_refused_and_identity_must_be_explicit(self):
        with self.assertRaises(ValueError):
            await merge_pr.run(self.client, {k: v for k, v in PAYLOAD.items() if k != 'expected_head'})
        with self.assertRaisesRegex(ValueError, 'token-user is required'):
            await interface.merge_pr({k: v for k, v in PAYLOAD.items() if k != 'token_user'})
        self.client.request.assert_not_awaited()


class TestMergePrCli(TestCase):
    def test_cli_routes_the_pinned_merge_contract(self):
        operation = AsyncMock(return_value={'outcome': 'merged'})
        with patch('sys.argv', ['github-interface', '--merge-pr', '#7', '--expected-head', HEAD,
                                '--repository', 'acme/app', '--token-user', 'octocat']), \
                patch.object(cli, 'merge_pr', operation), patch('sys.stdout', StringIO()):
            cli.main()
        operation.assert_awaited_once_with(PAYLOAD)
