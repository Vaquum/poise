import os
from copy import deepcopy
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

from github_interface.behaviors import resolve_nonblocking_conversations_if_ready as behavior

HEAD = 'a' * 40
PULL = {'state': 'open', 'draft': False, 'mergeable': True, 'head': {'sha': HEAD}}
REVIEWS = [{'state': 'APPROVED', 'user': {'login': 'review-bot'}, 'commit_id': HEAD,
            'submitted_at': '2026-10-26T18:00:00Z'}]
STATUS = {'statuses': [{'state': 'success'}]}
ROLLUP = {'headRefOid': HEAD,
          'commits': {'nodes': [{'commit': {'statusCheckRollup': {'state': 'SUCCESS'}}}]}}
EMPTY_ROLLUP = {'headRefOid': HEAD, 'commits': {'nodes': [{'commit': {'statusCheckRollup': None}}]}}
DIRECT_READY = {**EMPTY_ROLLUP, 'mergeQueue': None, 'mergeStateStatus': 'CLEAN'}
THREADS = [{'id': 'thread-1', 'is_resolved': False}, {'id': 'thread-2', 'is_resolved': False}]
PAYLOAD = {'repository': 'acme/app', 'pr': '#7', 'expected_head': HEAD,
           'username': 'review-bot', 'token_user': 'review-bot'}
SECONDARY_LIMIT = ("GitHub 403 rate-limit: {'x-ratelimit-resource': 'core', "
                   "'x-ratelimit-remaining': '58', 'x-ratelimit-reset': '1792870000', "
                   "'retry-after': '300'} body={\"message\": \"You have exceeded a "
                   "secondary rate limit. Please wait a few minutes before you try again.\"}")


class TestResolveFailurePhase(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncMock()
        self.patches = [
            patch.object(behavior, 'get_pull', AsyncMock(return_value=deepcopy(PULL))),
            patch.object(behavior, 'list_reviews', AsyncMock(return_value=deepcopy(REVIEWS))),
            patch.object(behavior, 'require_owned_reviews', return_value=None),
            patch.object(behavior, 'get_combined_status', AsyncMock(return_value=deepcopy(STATUS))),
            patch.object(behavior, 'get_pull_check_rollup', AsyncMock(return_value=deepcopy(ROLLUP))),
            patch.object(behavior, 'get_pr_readiness_state', AsyncMock(return_value=deepcopy(DIRECT_READY))),
            patch.object(behavior, 'list_review_threads', AsyncMock(return_value=deepcopy(THREADS))),
            patch.object(behavior, 'resolve_conversation',
                         AsyncMock(side_effect=lambda _client, thread_id: {'id': thread_id, 'isResolved': True})),
        ]
        for entered in self.patches:
            entered.start()
        self.addCleanup(lambda: [entered.stop() for entered in self.patches])

    def _resolve_mock(self):
        return behavior.resolve_conversation

    async def test_resolves_ready_threads_without_a_phase_marker(self):
        resolved = [{**thread, 'is_resolved': True} for thread in THREADS]
        behavior.list_review_threads.side_effect = [
            deepcopy(THREADS), deepcopy(THREADS), deepcopy(THREADS), resolved]
        result = await behavior.run(self.client, PAYLOAD)
        self.assertEqual(result['resolved_count'], 2)
        self.assertEqual(result['unresolved_count'], 0)
        self.assertTrue(result['ready_except_conversations'])
        self.assertEqual(self._resolve_mock().await_count, 2)
        behavior.get_pr_readiness_state.assert_not_awaited()

    async def test_resolves_an_approved_clean_direct_merge_without_checks(self):
        behavior.get_combined_status.return_value = {'statuses': []}
        behavior.get_pull_check_rollup.return_value = EMPTY_ROLLUP
        resolved = [{**thread, 'is_resolved': True} for thread in THREADS]
        behavior.list_review_threads.side_effect = [deepcopy(THREADS), deepcopy(THREADS), deepcopy(THREADS), resolved]

        result = await behavior.run(self.client, PAYLOAD)

        self.assertTrue(result['ready_except_conversations'])
        self.assertFalse(result['checks_present'])
        self.assertTrue(result['checks_not_required'])
        self.assertEqual(result['resolved_count'], 2)
        self.assertEqual(self._resolve_mock().await_count, 2)
        self.assertEqual(behavior.get_pr_readiness_state.await_count, 4)

    async def test_leaves_missing_checks_held_without_clean_direct_merge_evidence(self):
        behavior.get_combined_status.return_value = {'statuses': []}
        behavior.get_pull_check_rollup.return_value = EMPTY_ROLLUP
        for evidence in (
            {**DIRECT_READY, 'mergeQueue': {'id': 'queue'}},
            {**DIRECT_READY, 'mergeStateStatus': 'BLOCKED'},
            {**EMPTY_ROLLUP, 'mergeStateStatus': 'CLEAN'},
            {**DIRECT_READY, 'commits': ROLLUP['commits']},
        ):
            with self.subTest(evidence=evidence):
                behavior.get_pr_readiness_state.return_value = evidence
                result = await behavior.run(self.client, PAYLOAD)
                self.assertEqual(result['blockers'], ['checks_missing'])
                self.assertNotIn('checks_not_required', result)
                self._resolve_mock().assert_not_awaited()

    async def test_head_change_in_direct_merge_read_cannot_resolve(self):
        behavior.get_combined_status.return_value = {'statuses': []}
        behavior.get_pull_check_rollup.return_value = EMPTY_ROLLUP
        new_head = 'b' * 40
        behavior.get_pr_readiness_state.return_value = {**DIRECT_READY, 'headRefOid': new_head}

        result = await behavior.run(self.client, PAYLOAD)

        self.assertEqual(result['outcome'], 'superseded')
        self.assertEqual(result['current_head_sha'], new_head)
        self._resolve_mock().assert_not_awaited()

    async def test_native_resolution_keeps_its_check_gate(self):
        behavior.get_combined_status.return_value = {'statuses': []}
        behavior.get_pull_check_rollup.return_value = EMPTY_ROLLUP
        with (
            patch.dict(os.environ, {'AGENT_INTERFACE_RECEIPT_CALL': 'a' * 32}),
            patch.object(behavior, '_checkpoint', return_value={'confirmed': [], 'pending': None}),
        ):
            result = await behavior.run(self.client, PAYLOAD)
        self.assertEqual(result['blockers'], ['checks_missing'])
        behavior.get_pr_readiness_state.assert_not_awaited()
        self._resolve_mock().assert_not_awaited()

    async def test_continuation_skips_original_confirmed_threads(self):
        progress = {'confirmed': [{'id': 'thread-1', 'isResolved': True}], 'pending': None}
        resolved = [{**thread, 'is_resolved': True} for thread in THREADS]
        behavior.list_review_threads.side_effect = [deepcopy(THREADS), deepcopy(THREADS), resolved]
        with patch.object(behavior, '_checkpoint', return_value=progress):
            result = await behavior.run(self.client, PAYLOAD)
        self._resolve_mock().assert_awaited_once_with(self.client, 'thread-2')
        self.assertEqual([item['id'] for item in result['conversations']], ['thread-1', 'thread-2'])

    async def test_closed_thread_observation_cannot_clear_an_unacknowledged_attempt(self):
        progress = {'confirmed': [{'id': 'thread-1', 'isResolved': True}], 'pending': 'thread-2'}
        behavior.list_review_threads.return_value = [{**thread, 'is_resolved': True} for thread in THREADS]
        with patch.object(behavior, '_checkpoint', return_value=progress):
            with self.assertRaisesRegex(RuntimeError, 'thread-2 lacks its original resolution response'):
                await behavior.run(self.client, PAYLOAD)
        self._resolve_mock().assert_not_awaited()

    async def test_secondary_limit_before_any_mutation_proves_no_action(self):
        behavior.get_pull.side_effect = RuntimeError(SECONDARY_LIMIT)
        with self.assertRaises(RuntimeError) as raised:
            await behavior.run(self.client, PAYLOAD)
        self.assertIn('(no conversation was resolved before this failure)', str(raised.exception))
        self.assertEqual(str(raised.exception).count('no conversation was resolved'), 1)
        self._resolve_mock().assert_not_awaited()

    async def test_failure_after_a_mutation_reports_uncertain_state(self):
        calls = {'count': 0}

        async def resolve_once(_client, thread_id):
            calls['count'] += 1
            if calls['count'] > 1:
                raise RuntimeError(SECONDARY_LIMIT)
            return {'id': thread_id, 'isResolved': True}

        behavior.resolve_conversation.side_effect = resolve_once
        with self.assertRaises(RuntimeError) as raised:
            await behavior.run(self.client, PAYLOAD)
        message = str(raised.exception)
        self.assertIn('1 review conversation(s) resolved before this failure', message)
        self.assertIn('remaining resolved state is uncertain', message)
        self.assertNotIn('no conversation was resolved', message)

    async def test_head_change_before_any_mutation_proves_no_action(self):
        moved = {**deepcopy(PULL), 'head': {'sha': 'b' * 40}}
        behavior.get_pull.side_effect = [deepcopy(PULL), moved]
        with self.assertRaises(RuntimeError) as raised:
            await behavior.run(self.client, PAYLOAD)
        self.assertIn('pull-request head changed', str(raised.exception))
        self.assertIn('(no conversation was resolved before this failure)', str(raised.exception))
        self._resolve_mock().assert_not_awaited()
