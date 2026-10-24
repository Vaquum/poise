import os
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import patch

from github_interface.atoms.review_identity import require_other_author, require_owned_reviews
from github_interface.behaviors import approve_pr, reviewed_clean, request_changes


class IdentityTests(TestCase):
    def test_missing_and_self_authors_fail(self):
        for author in ['', 'MAIN']:
            with self.assertRaises(RuntimeError):
                require_other_author({'user': {'login': author}}, 'main')
        require_other_author({'user': {'login': 'agent'}}, 'main')

    def test_manual_review_cannot_become_automatic_approval(self):
        with patch.dict(os.environ, {'GITHUB_INTERFACE_AUTOMATED_REVIEWS': '[12]'}):
            require_owned_reviews([{'id': 12, 'user': {'login': 'Main'}}], 'main')
            with self.assertRaisesRegex(RuntimeError, 'Manual or unclaimed'):
                require_owned_reviews([{'id': 13, 'user': {'login': 'main'}}], 'main')
            with self.assertRaisesRegex(RuntimeError, 'Manual or unclaimed'):
                require_owned_reviews([{'id': 13, 'state': 'PENDING', 'user': {'login': 'main'}}], 'main')
            require_owned_reviews([{'id': 13, 'user': {'login': 'other'}}], 'main')

    def test_invalid_receipts_fail(self):
        for receipt in ['null', '{}', '[true]', '[0]', '["12"]']:
            with patch.dict(os.environ, {'GITHUB_INTERFACE_AUTOMATED_REVIEWS': receipt}):
                with self.assertRaises(RuntimeError):
                    require_owned_reviews([], 'main')


class SubmissionTests(IsolatedAsyncioTestCase):
    async def test_all_review_submissions_refuse_self_review_before_publication(self):
        class Client:
            async def get(self, path, **kwargs):
                return {'state': 'open', 'draft': False, 'user': {'login': 'MAIN'}, 'head': {'sha': 'a' * 40}}

        payload = {'repository': 'owner/repo', 'pr': '1', 'expected_head': 'a' * 40,
                   'token_user': 'main', 'comments': [{'path': 'a.py', 'line': 1, 'body': 'bad'}]}
        for behavior in [approve_pr, reviewed_clean, request_changes]:
            with self.assertRaisesRegex(RuntimeError, 'own pull request'):
                await behavior.run(Client(), payload)
