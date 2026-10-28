"""Native publication guards. These isolated API stand-ins are not cycle proof."""
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock

from github_interface.behaviors.issue_work import publication_body, review_replies

CALL = "a" * 32


class PublicationScope(TestCase):
    def test_only_the_actual_seed_may_be_closed_by_publication_or_recovery(self):
        publication_body("Implements the change. Closes #7", "example/repo", 7)
        publication_body("Closes https://github.com/example/repo/issues/7", "example/repo", 7)
        for body in ("Fixes #8", "Resolves other/repo#7", "Closes https://github.com/other/repo/issues/7"):
            with self.subTest(body=body), self.assertRaisesRegex(ValueError, "only its seed"):
                publication_body(body, "example/repo", 7)


class ReviewReplyReceipts(IsolatedAsyncioTestCase):
    async def test_posts_the_model_answer_on_the_original_finding_and_reconciles_lost_reply(self):
        client = AsyncMock()
        client.paginate.return_value = [{"id": 17, "body": "actual finding", "user": {"login": "reviewer"}}]
        answer = [{"commentId": 17, "body": "Fixed the empty-input branch and added its regression."}]
        client.post.return_value = {"id": 18, "html_url": "https://github.com/example/repo/pull/3#discussion_r18"}
        receipts = await review_replies(client, "example/repo", 3, "author", CALL, answer, publish=True)
        client.post.assert_awaited_once_with("/repos/example/repo/pulls/3/comments/17/replies", json={
            "body": answer[0]["body"] + f"\n\n<!-- poise-reply {CALL} 17 -->"})
        self.assertEqual(receipts[0]["comment_id"], 18)
        client.paginate.return_value += [{"id": 18, "in_reply_to_id": 17, "user": {"login": "AUTHOR"},
                                          "body": answer[0]["body"] + f"\n\n<!-- poise-reply {CALL} 17 -->"}]
        client.post.reset_mock()
        found = await review_replies(client, "example/repo", 3, "author", CALL, answer, publish=False)
        self.assertEqual(found[0]["comment_id"], 18)
        client.post.assert_not_awaited()

    async def test_missing_reply_is_not_invented_during_uncertain_outcome_inspection(self):
        client = AsyncMock()
        client.paginate.return_value = [{"id": 17}]
        self.assertEqual(await review_replies(client, "example/repo", 3, "author", CALL,
                                             [{"commentId": 17, "body": "Actual answer"}], publish=False), [])
        client.post.assert_not_awaited()

    async def test_foreign_comment_and_duplicate_publication_refuse_instead_of_answering_elsewhere(self):
        client = AsyncMock()
        client.paginate.return_value = [{"id": 17}]
        with self.assertRaisesRegex(ValueError, "original finding"):
            await review_replies(client, "example/repo", 3, "author", CALL, [{"commentId": 99, "body": "Answer"}], publish=True)
        body = f"Answer\n\n<!-- poise-reply {CALL} 17 -->"
        client.paginate.return_value += [{"id": ident, "in_reply_to_id": 17, "body": body, "user": {"login": "author"}} for ident in (18, 19)]
        with self.assertRaisesRegex(ValueError, "duplicate native"):
            await review_replies(client, "example/repo", 3, "author", CALL, [{"commentId": 17, "body": "Answer"}], publish=True)
        client.post.assert_not_awaited()
