from copy import deepcopy
from io import StringIO
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from github_interface import cli, interface
from github_interface.behaviors import merge_if_ready

HEAD = 'a' * 40
PULL = {'state': 'open', 'draft': False, 'mergeable': True, 'mergeable_state': 'clean',
        'head': {'sha': HEAD}, 'user': {'login': 'octocat'}, 'merged': False}
READY = {'state': 'OPEN', 'isDraft': False, 'mergeable': 'MERGEABLE', 'mergeStateStatus': 'CLEAN',
         'headRefOid': HEAD, 'commits': {'nodes': [{'commit': {'statusCheckRollup': {'state': 'SUCCESS'}}}]},
         'reviewThreads': {'nodes': [], 'pageInfo': {'hasNextPage': False}}}
PAYLOAD = {'repository': 'acme/app', 'pr': '#7', 'expected_head': HEAD, 'author': 'octocat', 'token_user': 'review-bot'}


class TestMergeIfReady(IsolatedAsyncioTestCase):
    async def test_account_approval_without_retained_response_cannot_merge(self):
        result = await merge_if_ready.run(self.client, PAYLOAD)
        self.assertEqual(result['outcome'], 'not_ready')
        self.assertIn('substantive', result['reason'])
        self.client.request.assert_not_awaited()

    async def asyncSetUp(self):
        self.client = AsyncMock()
        self.client.get.return_value = {'allow_squash_merge': True, 'allow_merge_commit': True}
        self.client.request.return_value = {'merged': True, 'sha': 'b' * 40}
        self.pull = deepcopy(PULL)
        self.ready = deepcopy(READY)
        self.pulls = AsyncMock(side_effect=lambda *_: deepcopy(self.pull))
        self.readiness = AsyncMock(side_effect=lambda *_: deepcopy(self.ready))
        self.patch_pull = patch.object(merge_if_ready, 'get_pull', self.pulls)
        self.patch_ready = patch.object(merge_if_ready, 'get_pr_readiness_state', self.readiness)
        self.patch_pull.start()
        self.patch_ready.start()
        self.addCleanup(self.patch_pull.stop)
        self.addCleanup(self.patch_ready.stop)

    async def test_merges_green_head_with_exact_sha_and_allowed_squash_method(self):
        result = await merge_if_ready.run(self.client, PAYLOAD)
        self.assertEqual(result['outcome'], 'merged')
        self.assertEqual(result['merge_sha'], 'b' * 40)
        self.client.request.assert_awaited_once_with('PUT', '/repos/acme/app/pulls/7/merge',
                                                    json={'sha': HEAD, 'merge_method': 'squash'})
        self.assertEqual(self.pulls.await_count, 2)
        self.readiness.assert_awaited_once()

    async def test_selects_only_a_repository_allowed_method(self):
        for config, expected in [({'allow_merge_commit': True}, 'merge'), ({'allow_rebase_merge': True}, 'rebase')]:
            with self.subTest(expected=expected):
                self.client.get.return_value = config
                await merge_if_ready.run(self.client, PAYLOAD)
                self.assertEqual(self.client.request.call_args.kwargs['json']['merge_method'], expected)

    async def test_unsafe_or_unknown_pull_never_merges(self):
        for fields in [{'draft': True}, {'state': 'closed'}, {'mergeable': None}, {'mergeable': False},
                       {'mergeable_state': 'unknown'}, {'mergeable_state': 'blocked'}, {'user': {'login': 'other'}}]:
            with self.subTest(fields=fields):
                self.pull = {**deepcopy(PULL), **fields}
                result = await merge_if_ready.run(self.client, PAYLOAD)
                self.assertEqual(result['outcome'], 'not_ready')
                self.client.request.assert_not_awaited()

    async def test_failed_pending_or_unread_checks_never_merge(self):
        for state in ['FAILURE', 'PENDING', 'ERROR', 'EXPECTED']:
            with self.subTest(state=state):
                self.ready['commits']['nodes'][0]['commit']['statusCheckRollup']['state'] = state
                self.assertEqual((await merge_if_ready.run(self.client, PAYLOAD))['outcome'], 'not_ready')
                self.client.request.assert_not_awaited()
                self.client.get.assert_not_awaited()

    async def test_missing_commit_evidence_is_not_ready(self):
        for commits in [None, {}, {'nodes': []}, {'nodes': [{'commit': None}]}, {'nodes': [{'commit': {'oid': HEAD}}]}]:
            with self.subTest(commits=commits):
                self.ready['commits'] = commits
                self.assertEqual((await merge_if_ready.run(self.client, PAYLOAD))['outcome'], 'not_ready')
                self.client.request.assert_not_awaited()

    async def test_no_checks_is_ready_like_the_green_status(self):
        self.ready['commits']['nodes'][0]['commit']['statusCheckRollup'] = None
        self.assertEqual((await merge_if_ready.run(self.client, PAYLOAD))['outcome'], 'merged')

    async def test_open_or_incompletely_read_conversations_prevent_merge(self):
        for threads in [{'nodes': [{'isResolved': False, 'isOutdated': False}], 'pageInfo': {'hasNextPage': False}},
                        {'nodes': [], 'pageInfo': {'hasNextPage': True}}]:
            self.ready['reviewThreads'] = threads
            self.assertEqual((await merge_if_ready.run(self.client, PAYLOAD))['outcome'], 'not_ready')
            self.client.request.assert_not_awaited()

    async def test_unknown_or_blocked_graphql_readiness_prevents_merge(self):
        for fields in [{'state': 'CLOSED'}, {'isDraft': True}, {'mergeable': 'UNKNOWN'}, {'mergeStateStatus': 'BLOCKED'}]:
            self.ready = {**deepcopy(READY), **fields}
            self.assertEqual((await merge_if_ready.run(self.client, PAYLOAD))['outcome'], 'not_ready')
            self.client.request.assert_not_awaited()

    async def test_head_changed_in_each_read_is_superseded_without_mutation(self):
        changed = {**PULL, 'head': {'sha': 'c' * 40}}
        for reads, ready in [([changed], READY), ([PULL], {**READY, 'headRefOid': 'c' * 40}), ([PULL, changed], READY)]:
            with self.subTest(reads=reads, ready=ready):
                self.pulls.side_effect = reads
                self.readiness.side_effect = None
                self.readiness.return_value = ready
                self.assertEqual((await merge_if_ready.run(self.client, PAYLOAD))['outcome'], 'superseded')
                self.client.request.assert_not_awaited()

    async def test_pull_blocked_just_before_mutation_is_left_alone(self):
        self.pulls.side_effect = [PULL, {**PULL, 'mergeable_state': 'blocked'}]
        self.assertEqual((await merge_if_ready.run(self.client, PAYLOAD))['outcome'], 'not_ready')
        self.client.request.assert_not_awaited()

    async def test_already_merged_is_idempotent_after_lost_receipt(self):
        self.pull.update(state='closed', merged=True)
        self.assertEqual((await merge_if_ready.run(self.client, PAYLOAD))['outcome'], 'already_merged')
        self.client.request.assert_not_awaited()
        self.readiness.assert_not_awaited()

    async def test_missing_readiness_and_api_failures_do_not_claim_success(self):
        self.readiness.side_effect = RuntimeError('GitHub unavailable')
        with self.assertRaisesRegex(RuntimeError, 'GitHub unavailable'):
            await merge_if_ready.run(self.client, PAYLOAD)
        self.client.request.assert_not_awaited()
        self.readiness.side_effect = None
        self.readiness.return_value = READY
        self.client.request.return_value = {'merged': False, 'message': 'blocked'}
        with self.assertRaisesRegex(RuntimeError, 'did not merge'):
            await merge_if_ready.run(self.client, PAYLOAD)

    async def test_missing_author_or_head_is_refused(self):
        for key in ['author', 'expected_head']:
            with self.subTest(key=key), self.assertRaises(ValueError):
                await merge_if_ready.run(self.client, {k: v for k, v in PAYLOAD.items() if k != key})
        self.client.request.assert_not_awaited()

    async def test_identity_must_be_explicit(self):
        with self.assertRaisesRegex(ValueError, 'token-user is required'):
            await interface.merge_if_ready({k: v for k, v in PAYLOAD.items() if k != 'token_user'})


class TestMergeCli(TestCase):
    def test_cli_routes_the_pinned_merge_contract(self):
        operation = AsyncMock(return_value={'outcome': 'merged'})
        with patch('sys.argv', ['github-interface', '--merge-if-ready', '#7', '--expected-head', HEAD,
                                '--author', 'octocat', '--token-user', 'review-bot']), \
                patch.object(cli, 'merge_if_ready', operation), patch('sys.stdout', StringIO()):
            cli.main()
        operation.assert_awaited_once_with({k: v for k, v in PAYLOAD.items() if k != 'repository'})
