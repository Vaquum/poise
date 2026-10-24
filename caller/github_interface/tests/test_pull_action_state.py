from copy import deepcopy
from io import StringIO
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from github_interface import cli, interface
from github_interface.behaviors import pull_action_state

HEAD = 'a' * 40
PULL = {'state': 'open', 'draft': False, 'merged': False, 'merged_by': None,
        'head': {'sha': HEAD}, 'user': {'login': 'octocat'}}
REVIEWS = [
    {'id': 11, 'user': {'login': 'octocat'}, 'state': 'APPROVED', 'commit_id': HEAD,
     'submitted_at': '2026-09-01T00:00:00Z'},
    {'id': 12, 'user': {'login': 'hubot'}, 'state': 'APPROVED', 'commit_id': HEAD,
     'submitted_at': '2026-09-02T00:00:00Z'},
]
PAYLOAD = {'repository': 'acme/app', 'pr': '#7', 'token_user': 'octocat'}


class TestPullActionState(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncMock()
        self.pull = deepcopy(PULL)
        self.reviews = deepcopy(REVIEWS)
        self.patch_pull = patch.object(pull_action_state, 'get_pull', AsyncMock(side_effect=lambda *_: deepcopy(self.pull)))
        self.patch_reviews = patch.object(pull_action_state, 'list_reviews', AsyncMock(side_effect=lambda *_: deepcopy(self.reviews)))
        self.readiness = AsyncMock(return_value={'mergeQueueEntry': None})
        self.patch_ready = patch.object(pull_action_state, 'get_pr_readiness_state', self.readiness)
        self.patch_pull.start()
        self.patch_reviews.start()
        self.patch_ready.start()
        self.addCleanup(self.patch_pull.stop)
        self.addCleanup(self.patch_reviews.stop)
        self.addCleanup(self.patch_ready.stop)

    async def test_reports_merge_state_head_queue_entry_and_only_my_reviews(self):
        self.readiness.return_value = {'mergeQueueEntry': {'id': 'entry-1'}}
        result = await pull_action_state.run(self.client, PAYLOAD)
        self.assertEqual(result, {
            'action': 'pull_action_state', 'repository': 'acme/app', 'pull_number': 7,
            'actor': 'octocat', 'state': 'open', 'merged': False, 'merged_by': None,
            'head_sha': HEAD, 'merge_sha': None, 'queue_entry_id': 'entry-1',
            'my_reviews': [{'id': 11, 'state': 'APPROVED', 'commit_id': HEAD,
                            'submitted_at': '2026-09-01T00:00:00Z'}],
        })

    async def test_reports_who_merged_without_reading_readiness(self):
        self.pull.update(state='closed', merged=True, merged_by={'login': 'hubot'})
        result = await pull_action_state.run(self.client, PAYLOAD)
        self.assertEqual((result['merged'], result['merged_by'], result['queue_entry_id']), (True, 'hubot', None))
        self.readiness.assert_not_awaited()

    async def test_rereads_when_the_head_moves_between_the_pull_and_readiness_reads(self):
        other = 'b' * 40
        self.readiness.return_value = {'mergeQueueEntry': {'id': 'entry-1'}, 'headRefOid': other, 'state': 'OPEN'}
        pulls = [dict(self.pull, head={'sha': HEAD}), dict(self.pull, head={'sha': other})]
        calls = {'n': 0}

        async def pull_then(*_args):
            calls['n'] += 1
            return deepcopy(pulls[0] if calls['n'] == 1 else pulls[1])

        with patch.object(pull_action_state, 'get_pull', AsyncMock(side_effect=pull_then)):
            result = await pull_action_state.run(self.client, PAYLOAD)
        self.assertEqual((result['head_sha'], result['queue_entry_id']), (other, 'entry-1'))
        self.assertEqual(calls['n'], 2)

    async def test_malformed_queue_entry_fails_loud(self):
        self.readiness.return_value = {'mergeQueueEntry': {'id': 7}}
        with self.assertRaisesRegex(RuntimeError, 'malformed merge queue entry'):
            await pull_action_state.run(self.client, PAYLOAD)

    async def test_identity_must_be_explicit(self):
        with self.assertRaisesRegex(ValueError, 'token-user is required'):
            await interface.pull_action_state({k: v for k, v in PAYLOAD.items() if k != 'token_user'})


class TestPullActionStateCli(TestCase):
    def test_cli_routes_the_state_contract(self):
        operation = AsyncMock(return_value={'action': 'pull_action_state'})
        with patch('sys.argv', ['github-interface', '--pull-action-state', '#7',
                                '--repository', 'acme/app', '--token-user', 'octocat']), \
                patch.object(cli, 'pull_action_state', operation), patch('sys.stdout', StringIO()):
            cli.main()
        operation.assert_awaited_once_with(PAYLOAD)
