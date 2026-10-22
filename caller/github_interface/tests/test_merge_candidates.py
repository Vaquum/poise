from copy import deepcopy
from io import StringIO
import json
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from github_interface import cli, interface
from github_interface.behaviors import merge_candidates, mergeable
HEAD = 'a' * 40
APPROVED_AT = '2026-10-22T00:00:00Z'
READY = {'state': 'OPEN', 'isDraft': False, 'mergeable': 'MERGEABLE', 'mergeStateStatus': 'CLEAN',
         'headRefOid': HEAD, 'commits': {'nodes': [{'commit': {'statusCheckRollup': {'state': 'SUCCESS'}}}]},
         'reviews': {'nodes': [{'state': 'APPROVED', 'submittedAt': APPROVED_AT}], 'pageInfo': {'hasNextPage': False}},
         'reviewThreads': {'nodes': [], 'pageInfo': {'hasNextPage': False}}}

REQUESTS = [{'repository': 'acme/app', 'number': n} for n in range(1, 11)]


def packet(number, fields=None):
    return {'nameWithOwner': 'acme/app', 'pullRequest': {
        **deepcopy(READY), 'number': number, 'author': {'login': 'octocat'}, **(fields or {}),
    }}


def response(requests=REQUESTS, fields=None):
    return {'data': {'viewer': {'login': 'review-bot'}, 'rateLimit': {'cost': 1},
                     **{f'pr{i}': packet(request['number'], fields) for i, request in enumerate(requests)}}}


class TestMergeCandidates(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncMock()
        self.client.request.return_value = response()

    async def read(self, requests=REQUESTS):
        return await merge_candidates.run(self.client, {'token_user': 'review-bot', 'requests': requests})

    async def test_ten_blocked_prs_cost_one_graphql_read_and_no_rest_reads(self):
        self.client.request.return_value = response(fields={'mergeStateStatus': 'BLOCKED'})
        result = await self.read()
        self.assertEqual(len(result['records']), 10)
        self.assertTrue(all(not row['ready'] for row in result['records']))
        self.assertEqual(result['graphql_cost'], 1)
        self.client.request.assert_awaited_once()
        args, kwargs = self.client.request.call_args
        self.assertEqual(args, ('POST', '/graphql'))
        self.assertTrue(kwargs['retry_transient'])
        self.assertEqual(kwargs['json']['variables']['number9'], 10)
        self.client.get.assert_not_awaited()
        self.client.post.assert_not_awaited()

    async def test_sixty_scans_of_ten_blocked_prs_use_sixty_requests(self):
        self.client.request.return_value = response(fields={'mergeStateStatus': 'BLOCKED'})
        for _ in range(60):
            await self.read()
        self.assertEqual(self.client.request.await_count, 60)
        self.client.get.assert_not_awaited()

    async def test_ready_packets_keep_the_exact_head_and_author(self):
        result = await self.read()
        self.assertEqual(result['records'][0], {'repository': 'acme/app', 'number': 1,
                         'ready': True, 'behind': False, 'head_sha': HEAD, 'author': 'octocat',
                         'approved_at': APPROVED_AT, 'error': None})

    async def test_discovery_preserves_the_existing_readiness_predicate(self):
        cases = [({}, True), ({'state': 'CLOSED'}, False), ({'isDraft': True}, False),
                 ({'mergeable': 'UNKNOWN'}, False), ({'mergeStateStatus': 'BLOCKED'}, False),
                 ({'mergeStateStatus': 'BEHIND'}, False), ({'mergeStateStatus': 'DIRTY'}, False),
                 ({'mergeStateStatus': 'UNSTABLE'}, True), ({'mergeStateStatus': 'HAS_HOOKS'}, True),
                 ({'commits': None}, False), ({'commits': {'nodes': []}}, False),
                 ({'commits': {'nodes': [{'commit': {}}]}}, False),
                 ({'commits': {'nodes': [{'commit': {'statusCheckRollup': None}}]}}, True)]
        cases += [({'commits': {'nodes': [{'commit': {'statusCheckRollup': {'state': state}}}]}}, False)
                  for state in ['FAILURE', 'PENDING', 'ERROR', 'EXPECTED']]
        cases += [({'reviewThreads': {'pageInfo': {'hasNextPage': more}, 'nodes': threads}}, ready)
                  for more, threads, ready in [
                      (True, [], False),
                      (False, [{'isResolved': False, 'isOutdated': False}], False),
                      (False, [{'isResolved': False, 'isOutdated': True}], True),
                      (False, [{'isResolved': True, 'isOutdated': False}], True)]]
        for fields, expected in cases:
            with self.subTest(fields=fields):
                self.client.request.return_value = response(fields=fields)
                result = await self.read()
                self.assertEqual(result['records'][0]['ready'], expected)
                self.assertEqual(result['records'][0]['ready'],
                                 mergeable.readiness_status({**deepcopy(READY), **fields}) == 'green')

    async def test_behind_packets_are_not_ready_but_carry_behind_and_approval(self):
        self.client.request.return_value = response(fields={'mergeStateStatus': 'BEHIND'})
        record = (await self.read())['records'][0]
        self.assertEqual((record['ready'], record['behind'], record['approved_at'], record['error']),
                         (False, True, APPROVED_AT, None))

    async def test_blocked_dirty_or_checked_states_are_neither_ready_nor_behind(self):
        cases = [{'mergeStateStatus': 'BLOCKED'}, {'mergeStateStatus': 'DIRTY', 'mergeable': 'CONFLICTING'},
                 {'mergeStateStatus': 'BEHIND',
                  'commits': {'nodes': [{'commit': {'statusCheckRollup': {'state': 'PENDING'}}}]}},
                 {'mergeStateStatus': 'BEHIND',
                  'reviewThreads': {'pageInfo': {'hasNextPage': False},
                                    'nodes': [{'isResolved': False, 'isOutdated': False}]}}]
        for fields in cases:
            with self.subTest(fields=fields):
                self.client.request.return_value = response(fields=fields)
                record = (await self.read())['records'][0]
                self.assertEqual((record['ready'], record['behind'], record['error']), (False, False, None))

    async def test_approved_at_is_the_latest_approval_or_none(self):
        reviews = [{'state': 'APPROVED', 'submittedAt': '2026-10-21T23:00:00Z'},
                   {'state': 'CHANGES_REQUESTED', 'submittedAt': '2026-10-21T23:30:00Z'},
                   {'state': 'COMMENTED', 'submittedAt': '2026-10-22T01:00:00Z'},
                   {'state': 'APPROVED', 'submittedAt': '2026-10-22T00:30:00Z'}]
        self.client.request.return_value = response(
            fields={'reviews': {'nodes': reviews, 'pageInfo': {'hasNextPage': False}}})
        self.assertEqual((await self.read())['records'][0]['approved_at'], '2026-10-22T00:30:00Z')
        for nodes, more in [([], False), ([{'state': 'CHANGES_REQUESTED', 'submittedAt': APPROVED_AT}], False),
                            ([{'state': 'APPROVED', 'submittedAt': APPROVED_AT}], True)]:
            with self.subTest(nodes=nodes, more=more):
                self.client.request.return_value = response(
                    fields={'reviews': {'nodes': nodes, 'pageInfo': {'hasNextPage': more}}})
                record = (await self.read())['records'][0]
                self.assertIsNone(record['approved_at'])
                self.assertIsNone(record['error'])

    async def test_unchanged_head_becomes_ready_when_checks_finish(self):
        self.client.request.return_value = response(fields={
            'commits': {'nodes': [{'commit': {'statusCheckRollup': {'state': 'PENDING'}}}]}})
        waiting = (await self.read())['records'][0]
        self.client.request.return_value = response()
        ready = (await self.read())['records'][0]
        self.assertEqual(waiting['head_sha'], ready['head_sha'])
        self.assertFalse(waiting['ready'])
        self.assertTrue(ready['ready'])
        self.assertEqual(self.client.request.await_count, 2)

    async def test_partial_error_holds_only_its_target(self):
        value = response()
        value['data']['pr0'] = None
        value['errors'] = [{'message': 'Repository not accessible', 'path': ['pr0']}]
        self.client.request.return_value = value
        records = (await self.read())['records']
        self.assertFalse(records[0]['ready'])
        self.assertEqual(records[0]['error'], 'Repository not accessible')
        self.assertTrue(records[1]['ready'])
        self.assertIsNone(records[1]['error'])

    async def test_global_errors_or_identity_and_cost_mismatches_fail_visibly(self):
        values = [response(), response(), response(), response()]
        values[0]['errors'] = [{'message': 'Rate limit exceeded'}]
        values[1]['data']['viewer']['login'] = 'other'
        values[2]['data']['rateLimit']['cost'] = 0
        values[3]['data']['rateLimit'] = None
        for value in values:
            with self.subTest(value=value):
                self.client.request.return_value = value
                with self.assertRaises(RuntimeError):
                    await self.read()

    async def test_missing_or_mismatched_target_evidence_does_not_hold_other_targets(self):
        bad = [None, {'nameWithOwner': 'other/app'}, packet(99), packet(1, {'headRefOid': 'bad'})]
        for first in bad:
            with self.subTest(first=first):
                value = response()
                value['data']['pr0'] = first
                self.client.request.return_value = value
                records = (await self.read())['records']
                self.assertFalse(records[0]['ready'])
                self.assertTrue(records[0]['error'])
                self.assertTrue(records[1]['ready'])

    async def test_invalid_batches_are_refused_before_any_request(self):
        invalid = [None, {}, REQUESTS * 6, [REQUESTS[0], REQUESTS[0]],
                   [{'repository': 'acme/app', 'number': True}],
                   [{'repository': 'acme/app', 'number': 0}],
                   [{'repository': 'acme', 'number': 1}],
                   [{'repository': 'acme/app', 'number': 1, 'extra': 'field'}]]
        for requests in invalid:
            with self.subTest(requests=requests), self.assertRaises(ValueError):
                await self.read(requests)
        self.client.request.assert_not_awaited()

    async def test_empty_batch_uses_no_api_and_fifty_targets_use_one_query(self):
        self.assertEqual((await self.read([]))['graphql_cost'], 0)
        self.client.request.assert_not_awaited()
        requests = [{'repository': 'acme/app', 'number': n} for n in range(1, 51)]
        self.client.request.return_value = response(requests)
        self.assertEqual(len((await self.read(requests))['records']), 50)
        self.client.request.assert_awaited_once()

    async def test_repositories_are_parameterized_in_one_query(self):
        requests = [REQUESTS[0], {'repository': 'beta/other', 'number': 7}]
        value = response(requests)
        value['data']['pr1']['nameWithOwner'] = 'beta/other'
        self.client.request.return_value = value
        self.assertTrue(all(row['ready'] for row in (await self.read(requests))['records']))
        query = self.client.request.call_args.kwargs['json']
        self.assertEqual(query['variables']['owner1'], 'beta')
        self.assertEqual(query['variables']['name1'], 'other')
        self.assertNotIn('beta/other', query['query'])

    async def test_identity_must_be_explicit(self):
        with self.assertRaisesRegex(ValueError, 'token-user is required'):
            await interface.merge_candidates({'requests': REQUESTS})


class TestMergeCandidatesCli(TestCase):
    def test_cli_routes_batch_without_a_positional_pr(self):
        operation = AsyncMock(return_value={'action': 'merge_candidates'})
        with patch('sys.argv', ['github-interface', '--merge-candidates', '--requests-json', json.dumps(REQUESTS),
                                '--token-user', 'review-bot']), \
                patch.object(cli, 'merge_candidates', operation), patch('sys.stdout', StringIO()):
            cli.main()
        operation.assert_awaited_once_with({'requests': REQUESTS, 'token_user': 'review-bot'})

    def test_invalid_json_is_refused_before_routing(self):
        operation = AsyncMock()
        with patch('sys.argv', ['github-interface', '--merge-candidates', '--requests-json', 'invalid',
                                '--token-user', 'review-bot']), patch.object(cli, 'merge_candidates', operation):
            with self.assertRaisesRegex(SystemExit, 'invalid JSON'):
                cli.main()
        operation.assert_not_awaited()
