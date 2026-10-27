import copy
import unittest

from github_datastore.extract import extract_associations
from github_datastore.github_api import GitHubApiError, GitHubOrgReader
from github_datastore.store import iter_expanded
from tests.test_github_api import ScriptedClient, connection
from tests.test_store import repo_row


def page(nodes=(), cursor=None):
    return connection(list(nodes), cursor is not None, cursor)


def comment(number, author='mikkokotila'):
    return {'id': f'C{number}', 'fullDatabaseId': str(number),
            'author': {'login': author}, 'body': 'body',
            'createdAt': '2026-01-01T00:00:00Z', 'updatedAt': '2026-01-01T00:00:00Z'}


def graph(number=1, kind='issue'):
    node = {'__typename': 'PullRequest' if kind == 'pr' else 'Issue',
            'id': f'I{number}', 'fullDatabaseId': str(number + 100),
            'number': number, 'state': 'OPEN', 'title': 'title', 'body': 'body',
            'author': {'login': 'author'}, 'assignees': page(),
            'createdAt': '2026-01-01T00:00:00Z', 'updatedAt': '2026-01-01T00:00:00Z',
            'closedAt': None, 'comments': page(), 'timelineItems': page()}
    if kind == 'pr':
        node.update(mergedAt=None, mergedBy=None, isDraft=False, additions=3, deletions=1,
                    reviewRequests=page(), reviews=page(), reviewThreads=page(), commits=page())
    return node


def stub(node):
    return {'id': int(node['fullDatabaseId']), 'number': node['number'],
            'item_kind': 'pr' if node['__typename'] == 'PullRequest' else 'issue'}


class ItemGraphBatchTest(unittest.TestCase):
    def test_mixed_graphs_keep_every_item_and_reject_unexpected_network_reads(self):
        nodes = [graph(n, 'pr' if n % 2 else 'issue') for n in range(1, 21)]
        client = ScriptedClient([{'repository': {f'item_{i}': n for i, n in enumerate(nodes)}}])
        reader = GitHubOrgReader(client)
        output = list(iter_expanded(reader, repo_row(), [stub(n) for n in nodes], 2))
        self.assertEqual({(x['issue']['number'], x['is_pr']) for x in output},
                         {(n['number'], n['__typename'] == 'PullRequest') for n in nodes})
        self.assertEqual(len(output), 20)
        self.assertEqual(len(client.calls), 1)
        self.assertIn('reviewThreads(first: 20)', client.calls[0][0])
        client.assert_exhausted()

    def test_pull_request_size_is_read_and_kept(self):
        pull = graph(1, 'pr')
        client = ScriptedClient([{'repository': {'item_0': pull}}])
        expanded = list(iter_expanded(GitHubOrgReader(client), repo_row(), [stub(pull)], 1))[0]
        self.assertRegex(client.calls[0][0], r'\badditions\b')
        self.assertRegex(client.calls[0][0], r'\bdeletions\b')
        graphql = expanded['pull']['graphql']
        self.assertEqual((graphql['additions'], graphql['deletions']), (3, 1))
        client.assert_exhausted()

    def test_all_associations_beyond_initial_pages_survive_without_duplicate_requests(self):
        pull = graph(1, 'pr')
        for key in ['comments', 'timelineItems', 'reviewRequests', 'reviews', 'reviewThreads', 'commits']:
            pull[key] = page(cursor=key)
        initial_comment = comment(1, 'someone')
        initial_comment['path'] = 'a.py'
        pull['reviewThreads']['nodes'] = [{'id': 'T1', 'comments': page([initial_comment], 'thread-comments')}]
        review = {'id': 'RV1', 'fullDatabaseId': '900', 'author': {'login': 'mikkokotila'},
                  'state': 'COMMENTED', 'body': '', 'submittedAt': '2026-01-01T00:00:00Z',
                  'commit': {'oid': 'a' * 40}}
        inline = dict(comment(2), path='a.py')
        later_inline = dict(comment(3), path='b.py')
        timeline = {'id': 'A1', '__typename': 'AssignedEvent', 'createdAt': '2026-01-01T00:00:00Z',
                    'actor': {'login': 'other'}, 'assignee': {'login': 'mikkokotila'}}
        commit = {'id': 'CO1', 'commit': {'oid': 'b' * 40,
                  'author': {'name': 'Mikko', 'date': '2026-01-01T00:00:00Z', 'user': {'login': 'mikkokotila'}},
                  'committer': {'name': 'other', 'date': '2026-01-01T00:00:00Z', 'user': {'login': 'other'}}}}
        pages = [
            {'repository': {'pullRequest': {'comments': page([comment(4)])}}},
            {'repository': {'pullRequest': {'timelineItems': page([timeline])}}},
            {'repository': {'pullRequest': {'reviewRequests': page([{'id': 'RQ1', 'requestedReviewer': {'login': 'mikkokotila'}}])}}},
            {'repository': {'pullRequest': {'reviews': page([review])}}},
            {'node': {'comments': page([inline])}},
            {'repository': {'pullRequest': {'reviewThreads': page([{'id': 'T2', 'comments': page([later_inline])}])}}},
            {'repository': {'pullRequest': {'commits': page([commit])}}},
        ]
        client = ScriptedClient([{'repository': {'item_0': pull}}, *pages])
        expanded = list(iter_expanded(GitHubOrgReader(client), repo_row(), [stub(pull)], 1))[0]
        self.assertEqual([x['id'] for x in expanded['comments']], [4])
        self.assertEqual({x['id'] for x in expanded['review_comments']}, {1, 2, 3})
        self.assertEqual(len(expanded['timeline']), 1)
        self.assertEqual(len(expanded['reviews']), 1)
        self.assertEqual(len(expanded['commits']), 1)
        self.assertEqual(expanded['pull']['requested_reviewers'], [{'login': 'mikkokotila'}])
        kinds = {x['association_type'] for x in extract_associations(expanded, 'mikkokotila')}
        self.assertTrue({'commenter', 'review_commenter', 'reviewer', 'review_requested', 'event_assignee:assigned', 'commit_author'} <= kinds, kinds)
        self.assertEqual(len(client.calls), 8)
        self.assertEqual(sum(v and v.get('id') == 'T1' for _, v in client.calls), 1)
        client.assert_exhausted()

    def test_malformed_identity_or_incomplete_aliases_fail_before_any_item_is_emitted(self):
        node = graph()
        cases = [None, {}, {'item_0': None}, {'item_0': node, 'extra': node}]
        for field, bad in [('__typename', 'PullRequest'), ('number', 2), ('fullDatabaseId', '999')]:
            changed = copy.deepcopy(node)
            changed[field] = bad
            cases.append({'item_0': changed})
        for response in cases:
            with self.subTest(response=response):
                client = ScriptedClient([{'repository': response}])
                with self.assertRaises(GitHubApiError):
                    list(iter_expanded(GitHubOrgReader(client), repo_row(), [stub(node)], 1))
                client.assert_exhausted()

    def test_batches_are_bounded_and_next_batch_is_not_fetched_after_failure(self):
        nodes = [graph(n) for n in range(1, 26)]
        client = ScriptedClient([
            {'repository': {f'item_{i}': n for i, n in enumerate(nodes[:20])}},
            {'repository': {f'item_{i}': n for i, n in enumerate(nodes[20:])}},
        ])
        rows = list(iter_expanded(GitHubOrgReader(client), repo_row(), [stub(n) for n in nodes], 1))
        self.assertEqual(len(rows), 25)
        self.assertEqual([len(v) - 2 for _, v in client.calls], [20, 5])
        client.assert_exhausted()
        client = ScriptedClient([{'repository': {}}])
        with self.assertRaises(GitHubApiError):
            list(iter_expanded(GitHubOrgReader(client), repo_row(), [stub(n) for n in nodes], 2))
        self.assertEqual(len(client.calls), 1)
        client.assert_exhausted()

    def test_invalid_batch_inputs_do_not_send_graphql(self):
        reader = GitHubOrgReader(ScriptedClient([]))
        valid = stub(graph())
        for items in [[], [valid] * 2, [stub(graph(n)) for n in range(1, 22)], [dict(valid, item_kind='unknown')]]:
            with self.subTest(items=items), self.assertRaises(ValueError):
                reader.fetch_initial_item_graphs(repo_row(), items)
        reader.client.assert_exhausted()


if __name__ == '__main__':
    unittest.main()
