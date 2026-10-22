from copy import deepcopy
from io import StringIO
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from github_interface import cli, interface
from github_interface.behaviors import update_branch_if_behind

HEAD = 'a' * 40
PULL = {'state': 'open', 'draft': False, 'mergeable': True, 'mergeable_state': 'behind',
        'head': {'sha': HEAD}, 'user': {'login': 'octocat'}, 'merged': False}
READY = {'state': 'OPEN', 'isDraft': False, 'mergeable': 'MERGEABLE', 'mergeStateStatus': 'BEHIND',
         'headRefOid': HEAD, 'commits': {'nodes': [{'commit': {'statusCheckRollup': {'state': 'SUCCESS'}}}]},
         'reviewThreads': {'nodes': [], 'pageInfo': {'hasNextPage': False}}}
PAYLOAD = {'repository': 'acme/app', 'pr': '#7', 'expected_head': HEAD, 'author': 'octocat', 'token_user': 'review-bot'}
UPDATED = {'message': 'Updating branch...', 'url': 'https://api.github.com/repos/acme/app/pulls/7'}


class TestUpdateBranchIfBehind(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncMock()
        self.client.request.return_value = deepcopy(UPDATED)
        self.pull = deepcopy(PULL)
        self.ready = deepcopy(READY)
        self.pulls = AsyncMock(side_effect=lambda *_: deepcopy(self.pull))
        self.readiness = AsyncMock(side_effect=lambda *_: deepcopy(self.ready))
        self.patch_pull = patch.object(update_branch_if_behind, 'get_pull', self.pulls)
        self.patch_ready = patch.object(update_branch_if_behind, 'get_pr_readiness_state', self.readiness)
        self.patch_pull.start()
        self.patch_ready.start()
        self.addCleanup(self.patch_pull.stop)
        self.addCleanup(self.patch_ready.stop)

    async def test_updates_behind_head_with_exact_expected_sha(self):
        result = await update_branch_if_behind.run(self.client, PAYLOAD)
        self.assertEqual(result['outcome'], 'updated')
        self.assertEqual(result['action'], 'update_branch_if_behind')
        self.client.request.assert_awaited_once_with('PUT', '/repos/acme/app/pulls/7/update-branch',
                                                     json={'expected_head_sha': HEAD})
        self.assertEqual(self.pulls.await_count, 2)
        self.readiness.assert_awaited_once()

    async def test_unsafe_unknown_or_current_pull_never_updates(self):
        for fields in [{'draft': True}, {'state': 'closed'}, {'mergeable': None}, {'mergeable': False},
                       {'mergeable_state': 'unknown'}, {'mergeable_state': 'blocked'}, {'mergeable_state': 'dirty'},
                       {'mergeable_state': 'clean'}, {'mergeable_state': 'unstable'}, {'user': {'login': 'other'}}]:
            with self.subTest(fields=fields):
                self.pull = {**deepcopy(PULL), **fields}
                result = await update_branch_if_behind.run(self.client, PAYLOAD)
                self.assertEqual(result['outcome'], 'not_ready')
                self.client.request.assert_not_awaited()

    async def test_failed_pending_or_unread_checks_never_update(self):
        for state in ['FAILURE', 'PENDING', 'ERROR', 'EXPECTED']:
            with self.subTest(state=state):
                self.ready['commits']['nodes'][0]['commit']['statusCheckRollup']['state'] = state
                self.assertEqual((await update_branch_if_behind.run(self.client, PAYLOAD))['outcome'], 'not_ready')
                self.client.request.assert_not_awaited()

    async def test_missing_commit_evidence_is_not_ready(self):
        for commits in [None, {}, {'nodes': []}, {'nodes': [{'commit': None}]}, {'nodes': [{'commit': {'oid': HEAD}}]}]:
            with self.subTest(commits=commits):
                self.ready['commits'] = commits
                self.assertEqual((await update_branch_if_behind.run(self.client, PAYLOAD))['outcome'], 'not_ready')
                self.client.request.assert_not_awaited()

    async def test_no_checks_updates_like_the_behind_predicate(self):
        self.ready['commits']['nodes'][0]['commit']['statusCheckRollup'] = None
        self.assertEqual((await update_branch_if_behind.run(self.client, PAYLOAD))['outcome'], 'updated')

    async def test_open_or_incompletely_read_conversations_prevent_update(self):
        for threads in [{'nodes': [{'isResolved': False, 'isOutdated': False}], 'pageInfo': {'hasNextPage': False}},
                        {'nodes': [], 'pageInfo': {'hasNextPage': True}}]:
            self.ready['reviewThreads'] = threads
            self.assertEqual((await update_branch_if_behind.run(self.client, PAYLOAD))['outcome'], 'not_ready')
            self.client.request.assert_not_awaited()

    async def test_unknown_blocked_or_current_graphql_readiness_prevents_update(self):
        for fields in [{'state': 'CLOSED'}, {'isDraft': True}, {'mergeable': 'UNKNOWN'},
                       {'mergeable': 'CONFLICTING', 'mergeStateStatus': 'DIRTY'},
                       {'mergeStateStatus': 'BLOCKED'}, {'mergeStateStatus': 'CLEAN'}]:
            self.ready = {**deepcopy(READY), **fields}
            self.assertEqual((await update_branch_if_behind.run(self.client, PAYLOAD))['outcome'], 'not_ready')
            self.client.request.assert_not_awaited()

    async def test_head_changed_in_each_read_is_superseded_without_mutation(self):
        changed = {**PULL, 'head': {'sha': 'c' * 40}}
        for reads, ready in [([changed], READY), ([PULL], {**READY, 'headRefOid': 'c' * 40}), ([PULL, changed], READY)]:
            with self.subTest(reads=reads, ready=ready):
                self.pulls.side_effect = reads
                self.readiness.side_effect = None
                self.readiness.return_value = ready
                self.assertEqual((await update_branch_if_behind.run(self.client, PAYLOAD))['outcome'], 'superseded')
                self.client.request.assert_not_awaited()

    async def test_pull_current_just_before_mutation_is_left_alone(self):
        self.pulls.side_effect = [PULL, {**PULL, 'mergeable_state': 'clean'}]
        self.assertEqual((await update_branch_if_behind.run(self.client, PAYLOAD))['outcome'], 'not_ready')
        self.client.request.assert_not_awaited()

    async def test_already_merged_needs_no_update(self):
        self.pull.update(state='closed', merged=True)
        self.assertEqual((await update_branch_if_behind.run(self.client, PAYLOAD))['outcome'], 'not_ready')
        self.client.request.assert_not_awaited()
        self.readiness.assert_not_awaited()

    async def test_missing_readiness_and_api_failures_do_not_claim_success(self):
        self.readiness.side_effect = RuntimeError('GitHub unavailable')
        with self.assertRaisesRegex(RuntimeError, 'GitHub unavailable'):
            await update_branch_if_behind.run(self.client, PAYLOAD)
        self.client.request.assert_not_awaited()
        self.readiness.side_effect = None
        self.readiness.return_value = READY
        self.client.request.return_value = {'merged': False}
        with self.assertRaisesRegex(RuntimeError, 'did not update'):
            await update_branch_if_behind.run(self.client, PAYLOAD)

    async def test_missing_author_or_head_is_refused(self):
        for key in ['author', 'expected_head']:
            with self.subTest(key=key), self.assertRaises(ValueError):
                await update_branch_if_behind.run(self.client, {k: v for k, v in PAYLOAD.items() if k != key})
        self.client.request.assert_not_awaited()

    async def test_identity_must_be_explicit(self):
        with self.assertRaisesRegex(ValueError, 'token-user is required'):
            await interface.update_branch_if_behind({k: v for k, v in PAYLOAD.items() if k != 'token_user'})


class TestUpdateBranchCli(TestCase):
    def test_cli_routes_the_pinned_update_contract(self):
        operation = AsyncMock(return_value={'outcome': 'updated'})
        with patch('sys.argv', ['github-interface', '--update-branch-if-behind', '#7', '--expected-head', HEAD,
                                '--author', 'octocat', '--token-user', 'review-bot']), \
                patch.object(cli, 'update_branch_if_behind', operation), patch('sys.stdout', StringIO()):
            cli.main()
        operation.assert_awaited_once_with({k: v for k, v in PAYLOAD.items() if k != 'repository'})
