"""Native publication guards. These isolated API stand-ins are not cycle proof."""
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from github_interface.behaviors.issue_work import confirmed_pull, publication_body, publication_metadata, review_replies, run

CALL = "a" * 32


class PublicationScope(TestCase):
    def test_metadata_validation_rejects_invalid_subjects_titles_and_foreign_closures_before_publication(self):
        valid = {"message": "feat: implement seed", "title": "feat: implement seed", "body": "Implement the requested behavior."}
        self.assertEqual(publication_metadata(valid, "example/repo", 7, creating=True), tuple(valid.values()))
        for changed in ({"message": "Implement seed"}, {"message": "feat: one\nfix: two"},
                        {"message": "feat: one\rtwo"}, {"title": "Implement seed"},
                        {"title": "feat: one\nfix: two"}, {"body": "Fixes #8"}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                publication_metadata({**valid, **changed}, "example/repo", 7, creating=True)

    def test_only_the_actual_seed_may_be_closed_by_publication_or_recovery(self):
        publication_body("Implements the change. Closes #7", "example/repo", 7)
        publication_body("Closes https://github.com/example/repo/issues/7", "example/repo", 7)
        for body in ("Fixes #8", "Resolves other/repo#7", "Closes https://github.com/other/repo/issues/7"):
            with self.subTest(body=body), self.assertRaisesRegex(ValueError, "only its seed"):
                publication_body(body, "example/repo", 7)


class ReviewReplyReceipts(IsolatedAsyncioTestCase):
    async def test_pr_head_lag_is_confirmed_with_bounded_reads_before_replies(self):
        client = AsyncMock()
        stale = {"number": 3, "head": {"sha": "a" * 40}}
        current = {"number": 3, "head": {"sha": "b" * 40}}
        with patch('github_interface.behaviors.issue_work.get_pull', side_effect=[stale, current]) as read, \
                patch('github_interface.behaviors.issue_work.asyncio.sleep', new_callable=AsyncMock):
            self.assertEqual(await confirmed_pull(client, "example", "repo", stale, "b" * 40), current)
        self.assertEqual(read.await_count, 2)
        with patch('github_interface.behaviors.issue_work.get_pull', return_value=stale) as read, \
                patch('github_interface.behaviors.issue_work.asyncio.sleep', new_callable=AsyncMock), \
                self.assertRaisesRegex(RuntimeError, "heads disagree"):
            await confirmed_pull(client, "example", "repo", stale, "b" * 40)
        self.assertEqual(read.await_count, 5)
        client.post.assert_not_awaited()

    async def test_existing_pr_completion_posts_the_original_reply_without_using_the_unused_repair_title(self):
        client = AsyncMock()
        head = "b" * 40
        pull = {"number": 3, "state": "open", "head": {"ref": "poise/issue-7", "sha": head, "repo": {"full_name": "example/repo"}},
                "user": {"login": "author"}, "body": "<!-- poise-chain example/repo#7 -->"}
        client.get.side_effect = [{"full_name": "example/repo", "default_branch": "main"}, {"state": "open"}]
        client.paginate.side_effect = [[pull], [{"id": 17}]]
        client.graphql.return_value = {"repository": {"ref": {"target": {"oid": head, "message": f"fix: repair\n\nPoise-Invocation: {CALL}"}},
            "defaultBranchRef": {"target": {"oid": "c" * 40}}, "issue": {"closedByPullRequestsReferences": {"nodes": [], "pageInfo": {"hasNextPage": False}}}}}
        client.post.return_value = {"id": 18}
        with patch('github_interface.behaviors.issue_work.work_publication') as checkpoint:
            result = await run(client, {"repository": "example/repo", "token_user": "author", "issue": 7, "branch": "poise/issue-7",
                "mode": "complete", "expected_head": head, "invocation_id": CALL, "title": "Repair outcomes", "body": "Actual repair",
                "replies_json": '[{"commentId":17,"body":"Fixed the actual finding."}]'})
        checkpoint.assert_called_once_with(head, start_replies=True)
        self.assertEqual(result["reply_receipts"][0]["comment_id"], 18)
        client.post.assert_awaited_once()
        self.assertIn("/comments/17/replies", client.post.call_args.args[0])

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
