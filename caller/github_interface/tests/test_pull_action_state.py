from copy import deepcopy
from io import StringIO
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from github_interface import cli, interface
from github_interface.atoms.pulls import get_pr_readiness_state
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
QUEUE_ENTRY = {'id': 'MQE_lQDOU59AVM8AAAABO91Wr84ABOPkzgP6O_8', 'state': 'UNMERGEABLE',
               'baseCommit': {'oid': '7ad75ba8c4fa9ab4df456e13824a311715082e64'}, 'headCommit': None}


class TestPullActionState(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncMock()
        self.pull = deepcopy(PULL)
        self.reviews = deepcopy(REVIEWS)
        self.patch_pull = patch.object(pull_action_state, 'get_pull', AsyncMock(side_effect=lambda *_: deepcopy(self.pull)))
        self.patch_reviews = patch.object(pull_action_state, 'list_reviews', AsyncMock(side_effect=lambda *_: deepcopy(self.reviews)))
        self.readiness = AsyncMock(return_value={'mergeQueueEntry': None, 'headRefOid': HEAD, 'state': 'OPEN'})
        self.patch_ready = patch.object(pull_action_state, 'get_pr_readiness_state', self.readiness)
        self.patch_pull.start()
        self.patch_reviews.start()
        self.patch_ready.start()
        self.addCleanup(self.patch_pull.stop)
        self.addCleanup(self.patch_reviews.stop)
        self.addCleanup(self.patch_ready.stop)

    async def test_reports_merge_state_head_queue_entry_and_only_my_reviews(self):
        self.readiness.return_value['mergeQueueEntry'] = {'id': 'entry-1'}
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

    async def test_queue_evidence_preserves_unknown_pr_mergeability_and_nullable_integration(self):
        head = 'ee7c6737a58dbdbbebbc59eb9222891e7af72f22'
        self.pull.update(head={'sha': head}, mergeable=None, title='Queued candidate', body='',
                         base={'sha': 'c' * 40})
        self.readiness.side_effect = get_pr_readiness_state
        ready = {'headRefOid': head, 'state': 'OPEN', 'mergeable': 'UNKNOWN', 'mergeQueueEntry': QUEUE_ENTRY}
        self.client.graphql.side_effect = [
            {'repository': {'pullRequest': ready}},
            {'repository': {'pullRequest': {'headRefOid': head, 'timelineItems': {'nodes': []}}}},
        ]
        result = await pull_action_state.run(self.client, dict(PAYLOAD, queue_evidence=True))
        self.assertEqual(result['queue_entry'], {'id': QUEUE_ENTRY['id'], 'state': 'UNMERGEABLE',
                                               'base': QUEUE_ENTRY['baseCommit']['oid'], 'head': None})
        self.assertEqual(result['queue_removals'], [])
        self.assertIn('mergeQueueEntry { id state baseCommit { oid } headCommit { oid } }',
                      self.client.graphql.await_args_list[0].args[0])

    async def test_exhausted_head_mismatches_fail_before_reading_removals(self):
        self.readiness.return_value.update(headRefOid='b' * 40, mergeQueueEntry=QUEUE_ENTRY)
        with self.assertRaisesRegex(RuntimeError, 'all three readiness reads'):
            await pull_action_state.run(self.client, dict(PAYLOAD, queue_evidence=True))
        self.assertEqual(self.readiness.await_count, 3)
        self.client.graphql.assert_not_awaited()

    async def test_retry_replaces_the_entire_stale_queue_packet(self):
        self.pull.update(title='Queued candidate', body='', base={'sha': 'c' * 40})
        self.readiness.side_effect = [
            {'headRefOid': 'b' * 40, 'state': 'OPEN', 'mergeQueueEntry': QUEUE_ENTRY},
            {'headRefOid': HEAD, 'state': 'OPEN', 'mergeQueueEntry': {
                'id': 'replacement', 'state': 'AWAITING_CHECKS', 'baseCommit': None, 'headCommit': {'oid': 'd' * 40}}},
        ]
        self.client.graphql.return_value = {'repository': {'pullRequest': {
            'headRefOid': HEAD, 'timelineItems': {'nodes': []}}}}
        result = await pull_action_state.run(self.client, dict(PAYLOAD, queue_evidence=True))
        self.assertEqual(result['queue_entry_id'], 'replacement')
        self.assertEqual(result['queue_entry'], {'id': 'replacement', 'state': 'AWAITING_CHECKS',
                                               'base': None, 'head': 'd' * 40})

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
