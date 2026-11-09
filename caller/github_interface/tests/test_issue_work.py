"""Native publication guards. These isolated API stand-ins are not cycle proof."""
import json
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from github_interface.behaviors import pr_review
from github_interface.behaviors.issue_work import confirmed_pull, publication_body, publication_metadata, review_replies, run
from github_interface.client import GitHubClient

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
    async def test_successive_repairs_reuse_prior_receipts_and_inspect_the_full_plan_after_a_lost_response(self):
        with patch('github_interface.client.get_token', return_value="test-token"):
            client = GitHubClient("author")
        call, head = CALL, "b" * 40
        pull = {"number": 3, "state": "open", "base": {"sha": "d" * 40},
                "head": {"ref": "poise/issue-7", "sha": head, "repo": {"full_name": "example/repo"}},
                "user": {"login": "author"}, "body": "<!-- poise-chain example/repo#7 -->"}
        comments = [{"id": root, "body": f"Finding {root}", "user": {"login": "reviewer"},
                     "updated_at": "2026-11-09T10:00:00Z"} for root in (17, 19)]
        # Put the prior replies on page two of the publisher's actual paginator.
        comments += [{"id": root, "body": "Unrelated finding", "user": {"login": "reviewer"},
                      "updated_at": "2026-11-09T12:00:00Z"} for root in range(1000, 1098)]
        pages = []

        async def get(path, **kwargs):
            if path == "/repos/example/repo":
                return {"full_name": "example/repo", "default_branch": "main"}
            if path.endswith("/issues/7"):
                return {"state": "open"}
            page = kwargs["params"]["page"]
            if path.endswith("/comments"):
                pages.append(page)
                return comments[(page - 1) * 100:page * 100]
            self.assertEqual(path, "/repos/example/repo/pulls")
            return [pull]

        async def graph(*_args):
            return {"repository": {"ref": {"target": {"oid": head, "message": f"fix: repair\n\nPoise-Invocation: {call}"}},
                "defaultBranchRef": {"target": {"oid": "d" * 40}},
                "issue": {"closedByPullRequestsReferences": {"nodes": [], "pageInfo": {"hasNextPage": False}}}}}

        async def post(path, *, json):
            parent = int(path.split("/")[-2])
            posted = {"id": 201 + sum(bool(comment.get("in_reply_to_id")) for comment in comments),
                      "in_reply_to_id": parent, "user": {"login": "AUTHOR"}, "body": json["body"],
                      "created_at": "2026-11-09T11:00:00Z" if call == CALL else "2026-11-09T13:00:00Z"}
            comments.append(posted)
            if call != CALL:
                raise RuntimeError("reply response lost after acceptance")
            return posted

        client.get, client.graphql, client.post = AsyncMock(side_effect=get), AsyncMock(side_effect=graph), AsyncMock(side_effect=post)
        payload = {"repository": "example/repo", "token_user": "author", "issue": 7, "branch": "poise/issue-7",
                   "mode": "complete", "expected_head": head, "invocation_id": call, "body": "Actual repair"}
        first = [{"commentId": root, "body": f"Fixed finding {root} and verified its regression."} for root in (17, 19)]
        first[1]["body"] += " The answer may discuss `<!-- poise-reply CALL_ID ROOT_ID -->` syntax."
        with patch('github_interface.behaviors.issue_work.work_publication') as checkpoint:
            initial = await run(client, {**payload, "replies_json": json.dumps(first)})
            self.assertEqual([receipt["comment_id"] for receipt in initial["reply_receipts"]], [201, 202])
            checkpoint.assert_called_once_with(head, start_replies=True)
            client.post.reset_mock()
            checkpoint.reset_mock()

            call, head = "c" * 32, "e" * 40
            pull["head"]["sha"] = head
            comments.append({"id": 21, "body": "One new finding", "user": {"login": "reviewer"}, "updated_at": "2026-11-09T12:00:00Z"})
            second = [{"commentId": comment["in_reply_to_id"], "body": comment["body"]}
                      for comment in comments if comment.get("in_reply_to_id")]
            second.append({"commentId": 21, "body": "Fixed the new finding and verified its regression."})
            payload.update(expected_head=head, invocation_id=call, replies_json=json.dumps(second))
            with self.assertRaisesRegex(RuntimeError, "response lost"):
                await run(client, payload)
            client.post.assert_awaited_once_with("/repos/example/repo/pulls/3/comments/21/replies", json={
                "body": second[-1]["body"] + f"\n\n<!-- poise-reply {call} 21 -->"})
            checkpoint.assert_called_once_with(head, start_replies=True)
            client.post.reset_mock()
            checkpoint.reset_mock()

            inspected = await run(client, {**payload, "mode": "inspect"})
            self.assertEqual(inspected["head_sha"], head)
            self.assertTrue(inspected["replies_complete"])
            self.assertEqual([receipt["comment_id"] for receipt in inspected["reply_receipts"]], [201, 202, 203])
            self.assertIn(2, pages)
            with patch.object(pr_review, "get_pull", return_value=pull), \
                    patch.object(pr_review, "issue_comments", return_value=[]), \
                    patch.object(pr_review, "list_review_threads", return_value=[]), \
                    patch.object(pr_review, "list_reviews", return_value=[]), \
                    patch.object(pr_review, "linked_issues", return_value=[]), \
                    patch.object(pr_review, "review_diff", return_value={}):
                packet = await pr_review.run(client, {"repository": "example/repo", "pr": 3, "expected_head": head})
            self.assertEqual(packet["head_sha"], head)
            self.assertEqual([comment["body"] for comment in packet["existing_inline_comments"] if comment["user"] == "AUTHOR"],
                             [comment["body"] for comment in comments if comment.get("in_reply_to_id")])
            comments.pop()  # An unconfirmed POST cannot count without its actual reply.
            incomplete = await run(client, {**payload, "mode": "inspect"})
            self.assertFalse(incomplete["replies_complete"])
            self.assertEqual(len(incomplete["reply_receipts"]), 2)
            comments[:] = [comment for comment in comments if comment["id"] != 201]
            with self.assertRaisesRegex(ValueError, "verified|receipt"):
                await run(client, {**payload, "mode": "inspect"})
            client.post.assert_not_awaited()
            checkpoint.assert_not_called()

    async def test_carried_reply_requires_exact_proof_and_unchanged_reviewer_input(self):
        body = f"Fixed the input branch and verified its regression.\n\n<!-- poise-reply {CALL} 17 -->"
        root = {"id": 17, "body": "Actual finding", "user": {"login": "reviewer"}, "updated_at": "2026-11-09T10:00:00Z"}
        prior = {"id": 18, "in_reply_to_id": 17, "user": {"login": "author"}, "body": body, "created_at": "2026-11-09T11:00:00Z"}
        followup = {"id": 19, "in_reply_to_id": 17, "body": "Changed reviewer input", "user": {"login": "reviewer"},
                    "updated_at": "2026-11-09T12:00:00Z"}
        for proof in ([], [{**prior, "user": {"login": "other"}}], [{**prior, "in_reply_to_id": 99}],
                      [{**prior, "body": body.replace("input", "output")}], [{**prior, "created_at": None}],
                      [prior, followup], [prior, {**followup, "id": 16, "created_at": "2026-11-09T09:00:00Z"}]):
            for publish in (False, True):
                with self.subTest(proof=proof, publish=publish):
                    client = AsyncMock()
                    client.paginate.return_value = [root, *proof]
                    with self.assertRaisesRegex(ValueError, "reused review reply"):
                        await review_replies(client, "example/repo", 3, "author", "b" * 32,
                                             [{"commentId": 17, "body": body}], publish=publish)
                    client.post.assert_not_awaited()
        client = AsyncMock()
        client.paginate.return_value = [{**root, "body": "Edited finding", "updated_at": "2026-11-09T12:00:00Z"}, prior]
        with self.assertRaisesRegex(ValueError, "reviewer input"):
            await review_replies(client, "example/repo", 3, "author", "b" * 32, [{"commentId": 17, "body": body}], publish=True)
        client.post.assert_not_awaited()
        # Later feedback cannot erase proof that the original Call posted its answer.
        original = [{"commentId": 17, "body": body.split("\n\n<!-- poise-reply", 1)[0]}]
        reconciled = await review_replies(client, "example/repo", 3, "author", CALL, original, publish=False)
        self.assertEqual(reconciled[0]["comment_id"], 18)
        client.post.return_value = {"id": 20}
        changed = [{"commentId": 17, "body": "Addressed the edited finding with a new regression."}]
        receipts = await review_replies(client, "example/repo", 3, "author", "b" * 32, changed, publish=True)
        self.assertEqual(receipts[0]["comment_id"], 20)
        self.assertIn("<!-- poise-reply " + "b" * 32 + " 17 -->", client.post.call_args.kwargs["json"]["body"])

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
