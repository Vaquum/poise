"""Native publication guards. These isolated API stand-ins are not cycle proof."""
import json
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

import httpx

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
            if "message" in changed:
                with self.subTest(changed=changed, creating=False), self.assertRaises(ValueError):
                    publication_metadata({**valid, **changed}, "example/repo", 7, creating=False)

    def test_only_the_actual_seed_may_be_closed_by_publication_or_recovery(self):
        publication_body("Implements the change. Closes #7", "example/repo", 7)
        publication_body("Closes https://github.com/example/repo/issues/7", "example/repo", 7)
        for body in ("Fixes #8", "Resolves other/repo#7", "Closes https://github.com/other/repo/issues/7"):
            with self.subTest(body=body), self.assertRaisesRegex(ValueError, "only its seed"):
                publication_body(body, "example/repo", 7)


class IssueOwnership(IsolatedAsyncioTestCase):
    def setUp(self):
        self.payload = {"repository": "example/repo", "token_user": "author", "issue": 7,
                        "branch": "poise/issue-7", "mode": "inspect"}
        self.candidate = {"number": 8, "state": "open", "body": "Closes #7",
                          "html_url": "https://github.com/example/repo/pull/8",
                          "head": {"ref": "stacked-fix", "repo": {"full_name": "example/repo"}},
                          "base": {"ref": "parent-fix", "repo": {"full_name": "example/repo"}}}
        self.graph = {"repository": {"ref": None, "defaultBranchRef": {"target": {"oid": "c" * 40}},
                      "issue": {"closedByPullRequestsReferences": {"nodes": [], "pageInfo": {"hasNextPage": False}}}}}
        self.client = AsyncMock()
        self.client.get.return_value = {"full_name": "example/repo", "default_branch": "main"}
        self.client.graphql.return_value = self.graph

    async def test_stacked_owner_appearing_after_intake_is_found_on_a_later_page_before_prepare(self):
        with patch('github_interface.client.get_token', return_value="test-token"):
            client = GitHubClient("author")
        open_pulls, pages = [], []

        async def get(path, **kwargs):
            if path == "/repos/example/repo":
                return {"full_name": "example/repo", "default_branch": "main"}
            self.assertEqual(path, "/repos/example/repo/pulls")
            params = kwargs["params"]
            if params["state"] == "all":
                self.assertEqual(params["head"], "example:poise/issue-7")
                return []
            self.assertEqual(params["state"], "open")
            pages.append(params["page"])
            return open_pulls[(params["page"] - 1) * 100:params["page"] * 100]

        client.get, client.graphql = AsyncMock(side_effect=get), AsyncMock(return_value=self.graph)
        self.assertEqual((await run(client, self.payload))["existing_pulls"], [])
        open_pulls.extend({**self.candidate, "number": number, "body": "Related to #7"} for number in range(100, 200))
        open_pulls.append(self.candidate)
        self.assertEqual((await run(client, self.payload))["existing_pulls"], [self.candidate["html_url"]])
        self.assertEqual(pages, [1, 1, 2])
        with patch('github_interface.behaviors.issue_work.checkout_repo') as checkout, \
                patch('github_interface.behaviors.issue_work._run') as git, \
                self.assertRaisesRegex(ValueError, "already has another open pull request"):
            await run(client, {**self.payload, "mode": "prepare", "path": "/unused"})
        checkout.assert_not_called()
        git.assert_not_called()

    async def test_body_ownership_requires_an_explicit_seed_reference_in_another_open_same_repository_pr(self):
        for changed, expected in [({}, True), ({"body": "fIxEd EXAMPLE/REPO#7"}, True),
                                  ({"body": "Resolves https://github.com/example/repo/issues/7"}, True),
                                  ({"body": "Related to #7"}, False), ({"body": None}, False),
                                  ({"body": "Closes #70"}, False), ({"body": "Closes other/repo#7"}, False),
                                  ({"body": "Closes https://github.com/other/repo/issues/7"}, False),
                                  ({"state": "closed"}, False),
                                  ({"base": {"repo": {"full_name": "other/repo"}}}, False),
                                  ({"head": {"ref": "poise/issue-7", "repo": {"full_name": "example/repo"}}}, False)]:
            with self.subTest(changed=changed):
                self.client.paginate.side_effect = [[], [{**self.candidate, **changed}]]
                result = await run(self.client, self.payload)
                self.assertEqual(result["existing_pulls"], [self.candidate["html_url"]] if expected else [])
        self.client.post.assert_not_awaited()
        self.client.patch.assert_not_awaited()

    async def test_graphql_owners_are_preserved_and_incomplete_ownership_reads_fail(self):
        linked = {"number": 8, "url": self.candidate["html_url"],
                  "repository": {"nameWithOwner": "example/repo"}, "headRefName": "stacked-fix"}
        connection = self.graph["repository"]["issue"]["closedByPullRequestsReferences"]
        connection["nodes"] = [linked, {**linked, "headRefName": "poise/issue-7", "url": "own-pr"},
                               {**linked, "url": "https://github.com/example/repo/pull/9"}]
        self.client.paginate.side_effect = [[], [self.candidate]]
        self.assertEqual((await run(self.client, self.payload))["existing_pulls"],
                         [linked["url"], "https://github.com/example/repo/pull/9"])
        connection["pageInfo"] = {"hasNextPage": True, "endCursor": None}
        self.client.paginate.side_effect = None
        self.client.paginate.return_value = []
        with self.assertRaisesRegex(ValueError, "ownership pagination did not advance"):
            await run(self.client, self.payload)
        connection["pageInfo"] = {"hasNextPage": False}
        self.client.paginate.side_effect = [[], RuntimeError("open PR page unavailable")]
        with self.assertRaisesRegex(RuntimeError, "open PR page unavailable"), \
                patch('github_interface.behaviors.issue_work.checkout_repo') as checkout:
            await run(self.client, {**self.payload, "mode": "prepare", "path": "/unused"})
        checkout.assert_not_called()


class MergedRepair(IsolatedAsyncioTestCase):
    async def test_same_head_merge_is_read_only_before_closed_seed_rejection_even_without_branch(self):
        head = "b" * 40
        pull = {"number": 3, "state": "closed", "merged": True, "merged_at": "2026-11-13T20:51:13Z",
                "merge_commit_sha": "d" * 40, "user": {"login": "author"},
                "body": "<!-- poise-chain example/repo#7 -->",
                "head": {"ref": "poise/issue-7", "sha": head, "repo": {"full_name": "example/repo"}}}
        payload = {"repository": "example/repo", "token_user": "author", "issue": 7,
                   "branch": "poise/issue-7", "pull_number": 3, "expected_head": head, "starting_head": head,
                   "replies_json": '[{"commentId":17,"body":"Completed repair answer."}]'}
        for mode in ("validate", "publish"):
            for deleted in (False, True):
                with self.subTest(mode=mode, deleted=deleted):
                    client = AsyncMock(token="private-token")
                    client.get.side_effect = [{"full_name": "example/repo", "default_branch": "main"}, pull]
                    client.paginate.side_effect = [[pull], []]
                    client.graphql.return_value = {"repository": {
                        "ref": None if deleted else {"target": {"oid": head, "message": "Original head"}},
                        "defaultBranchRef": {"target": {"oid": "d" * 40}},
                        "issue": {"closedByPullRequestsReferences": {"nodes": [], "pageInfo": {"hasNextPage": False}}}}}
                    with patch('github_interface.behaviors.issue_work._run') as git, \
                            patch('github_interface.behaviors.issue_work.checkout_repo') as checkout, \
                            patch('github_interface.behaviors.issue_work.work_publication') as checkpoint:
                        result = await run(client, {**payload, "mode": mode})
                    self.assertEqual((result["outcome"], result["head_sha"], result["merged"], result["merge_sha"]),
                                     ("superseded", head, True, "d" * 40))
                    git.assert_not_called()
                    checkout.assert_not_called()
                    checkpoint.assert_not_called()
                    client.post.assert_not_awaited()
                    client.patch.assert_not_awaited()
                    self.assertNotIn("/repos/example/repo/issues/7", [call.args[0] for call in client.get.call_args_list])

    async def test_closure_without_merge_ownership_or_consistent_same_head_proof_remains_an_error(self):
        head = "b" * 40
        pull = {"number": 3, "state": "closed", "merged": True, "merged_at": "2026-11-13T20:51:13Z",
                "merge_commit_sha": "d" * 40, "user": {"login": "author"},
                "body": "<!-- poise-chain example/repo#7 -->",
                "head": {"ref": "poise/issue-7", "sha": head, "repo": {"full_name": "example/repo"}}}
        payload = {"repository": "example/repo", "token_user": "author", "issue": 7,
                   "branch": "poise/issue-7", "pull_number": 3, "expected_head": head, "starting_head": head}
        cases = [
            ({"merged": False, "merged_at": None}, {}),  # A merge SHA alone proves nothing.
            ({"merged": False}, {}), ({"merged": None}, {}), ({"merged_at": None}, {}),
            ({"merge_commit_sha": None}, {}), ({"state": "open"}, {}), ({"number": 4}, {}),
            ({"user": {"login": "someone-else"}}, {}), ({"body": "Unowned PR"}, {}),
            ({"head": {**pull["head"], "repo": {"full_name": "other/repo"}}}, {}),
            ({"head": {**pull["head"], "ref": "other-branch"}}, {}),
            ({}, {"expected_head": "c" * 40}), ({}, {"starting_head": "c" * 40}),
            ({}, {"expected_head": ""}), ({}, {"starting_head": ""}),
        ]
        for mode, seed_state in (("validate", "open"), ("publish", "closed")):
            for changed, arguments, remote in [(changed, arguments, None) for changed, arguments in cases] + [({}, {}, "c" * 40)]:
                with self.subTest(mode=mode, changed=changed, arguments=arguments):
                    client = AsyncMock(token="private-token")
                    client.get.side_effect = [{"full_name": "example/repo", "default_branch": "main"},
                                              {**pull, **changed}, {"state": seed_state}]
                    client.paginate.side_effect = [[], []]
                    client.graphql.return_value = {"repository": {"ref": {"target": {"oid": remote}} if remote else None,
                        "defaultBranchRef": {"target": {"oid": "d" * 40}},
                        "issue": {"closedByPullRequestsReferences": {"nodes": [], "pageInfo": {"hasNextPage": False}}}}}
                    with patch('github_interface.behaviors.issue_work._run') as git, \
                            patch('github_interface.behaviors.issue_work.work_publication') as checkpoint, \
                            self.assertRaises(ValueError) as caught:
                        await run(client, {**payload, "mode": mode, **arguments})
                    self.assertEqual(caught.exception.diagnostic["operation"], f"issue_work.{mode}")
                    self.assertEqual(caught.exception.diagnostic["outcome"], "refused")
                    self.assertTrue(caught.exception.diagnostic["stderr"])
                    git.assert_not_called()
                    checkpoint.assert_not_called()
                    client.post.assert_not_awaited()
                    client.patch.assert_not_awaited()

    async def test_failed_github_read_identifies_the_request_and_redacts_before_bounding(self):
        client = AsyncMock(token="private-token")
        request = httpx.Request("GET", "https://api.github.com/repos/example/repo")
        client.get.side_effect = httpx.ReadError("private-token ghp_hiddenkey unavailable " + "x" * 20_000, request=request)
        with self.assertRaises(RuntimeError) as caught:
            await run(client, {"repository": "example/repo", "token_user": "author", "issue": 7,
                               "branch": "poise/issue-7", "mode": "validate"})
        diagnostic = caught.exception.diagnostic
        self.assertTrue(diagnostic["stderr_truncated"])
        self.assertLessEqual(len(diagnostic["stderr"].encode()), 16 * 1024)
        self.assertIn("GET /repos/example/repo", diagnostic["stderr"])
        self.assertIn("unavailable", diagnostic["stderr"])
        for secret in ("private-token", "ghp_hiddenkey"):
            self.assertNotIn(secret, str(caught.exception))
            self.assertNotIn(secret, json.dumps(diagnostic))


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
        # A reviewer edit within the reply's creation second truncates equal and must not count as coverage.
        client.paginate.return_value = [{**root, "updated_at": "2026-11-09T11:00:00Z"}, prior]
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

    async def test_existing_pr_completion_posts_the_original_reply_without_using_the_unused_repair_metadata(self):
        client = AsyncMock()
        head = "b" * 40
        title, body = "fix: implement seed", "Original description.\n\nCloses #7\n\n<!-- poise-chain example/repo#7 -->"
        pull = {"number": 3, "state": "open", "head": {"ref": "poise/issue-7", "sha": head, "repo": {"full_name": "example/repo"}},
                "user": {"login": "author"}, "title": title, "body": body}
        client.get.side_effect = [{"full_name": "example/repo", "default_branch": "main"}, {"state": "open"}]
        client.paginate.side_effect = [[pull], [], [{"id": 17}]]
        client.graphql.return_value = {"repository": {"ref": {"target": {"oid": head, "message": f"fix: repair\n\nPoise-Invocation: {CALL}"}},
            "defaultBranchRef": {"target": {"oid": "c" * 40}}, "issue": {"closedByPullRequestsReferences": {"nodes": [], "pageInfo": {"hasNextPage": False}}}}}
        client.post.return_value = {"id": 18}
        with patch('github_interface.behaviors.issue_work.work_publication') as checkpoint:
            result = await run(client, {"repository": "example/repo", "token_user": "author", "issue": 7, "branch": "poise/issue-7",
                "mode": "complete", "expected_head": head, "invocation_id": CALL, "title": "Repair outcomes", "body": "Also fixes #8",
                "replies_json": '[{"commentId":17,"body":"Fixed the actual finding."}]'})
        checkpoint.assert_called_once_with(head, start_replies=True)
        self.assertEqual((result["outcome"], result["head_sha"], result["head_invocation"]), ("published", head, CALL))
        self.assertEqual(result["reply_receipts"], [{"comment_id": 18, "in_reply_to_id": 17, "url": None}])
        client.post.assert_awaited_once_with("/repos/example/repo/pulls/3/comments/17/replies", json={
            "body": f"Fixed the actual finding.\n\n<!-- poise-reply {CALL} 17 -->"})
        client.patch.assert_not_awaited()
        self.assertEqual((pull["title"], pull["body"]), (title, body))

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


class FirstPublicationPrerequisites(IsolatedAsyncioTestCase):
    def setUp(self):
        self.base = "a" * 40
        self.payload = {"repository": "example/repo", "token_user": "author", "issue": 7,
                        "branch": "poise/issue-7", "mode": "publish", "path": "/tmp/repo",
                        "starting_head": self.base, "message": "fix: implement seed",
                        "title": "fix: implement seed", "body": "Implements the requested behavior.",
                        "invocation_id": CALL, "replies_json": "[]"}
        self.graph = {"repository": {"ref": None, "defaultBranchRef": {"target": {"oid": "c" * 40}},
                      "issue": {"blockedBy": {"nodes": [], "totalCount": 0, "pageInfo": {"hasNextPage": False}},
                                "closedByPullRequestsReferences": {"nodes": [], "pageInfo": {"hasNextPage": False}}}}}

    def _client(self):
        client = AsyncMock(token="private-token")
        client.get.side_effect = [{"full_name": "example/repo", "default_branch": "main"},
                                  {"state": "open"}]
        client.paginate.side_effect = [[], []]
        client.graphql.return_value = self.graph
        return client

    def _git(self, mock, dirty=" M file"):
        def run(args, token, *extra):
            if args[3:5] == ["branch", "--show-current"]:
                return "poise/issue-7"
            if args[3:5] == ["remote", "get-url"]:
                return "https://github.com/example/repo.git"
            if args[3:5] == ["rev-parse", "HEAD"]:
                return self.base
            if args[3:5] == ["status", "--porcelain"]:
                return dirty
            if args[3] == "add":
                return ""
            if args[3] == "commit":
                return ""
            if args[3] == "push":
                return ""
            raise AssertionError(f"unexpected git {args}")
        mock.side_effect = run
        return mock

    async def test_existing_pr_validate_and_publish_ignore_unused_foreign_closure_and_preserve_metadata(self):
        self.graph["repository"]["ref"] = {"target": {"oid": self.base, "message": f"fix: original\n\nPoise-Invocation: {CALL}"}}
        title, body = "fix: implement seed", "Original description.\n\nCloses #7\n\n<!-- poise-chain example/repo#7 -->"
        pull = {"number": 3, "state": "open", "title": title, "body": body,
                "html_url": "https://github.com/example/repo/pull/3", "user": {"login": "author"},
                "head": {"ref": "poise/issue-7", "sha": self.base, "repo": {"full_name": "example/repo"}}}
        for mode, dirty, outcome in (("validate", " M file", "validated"),
                                     ("publish", " M file", "published"), ("publish", "", "no_changes")):
            with self.subTest(mode=mode, dirty=dirty):
                head = "b" * 40 if mode == "publish" and dirty else self.base
                client = self._client()
                client.get.side_effect = [{"full_name": "example/repo", "default_branch": "main"}, {"state": "open"},
                                          {**pull, "head": {**pull["head"], "sha": head}}]
                client.paginate.side_effect = [[pull], [], [{"id": 17}]]
                client.post.return_value = {"id": 18}
                with patch('github_interface.behaviors.issue_work._run') as git, \
                        patch('github_interface.behaviors.issue_work.work_publication') as checkpoint:
                    git.side_effect = ["poise/issue-7", "https://github.com/example/repo.git", self.base, dirty] + (
                        ["", "", head, ""] if mode == "publish" and dirty else [])
                    result = await run(client, {**self.payload, "mode": mode, "expected_head": self.base,
                                               "title": "Repair outcomes", "body": "Also fixes #8",
                                               "replies_json": '[{"commentId":17,"body":"Fixed the actual finding."}]'})
                self.assertEqual((result["outcome"], result["head_sha"]), (outcome, head))
                self.assertEqual((pull["title"], pull["body"]), (title, body))
                client.patch.assert_not_awaited()
                if mode == "validate":
                    self.assertTrue(result["has_changes"])
                    checkpoint.assert_not_called()
                    client.post.assert_not_awaited()
                else:
                    checkpoint.assert_any_call(head)
                    checkpoint.assert_any_call(head, start_replies=True)
                    self.assertEqual(result["reply_receipts"], [{"comment_id": 18, "in_reply_to_id": 17, "url": None}])
                    client.post.assert_awaited_once_with("/repos/example/repo/pulls/3/comments/17/replies", json={
                        "body": f"Fixed the actual finding.\n\n<!-- poise-reply {CALL} 17 -->"})
                    if dirty:
                        self.assertIn(["git", "-C", "/tmp/repo", "commit", "-m", f"fix: implement seed\n\nPoise-Invocation: {CALL}"],
                                      [call.args[0] for call in git.call_args_list])
                        self.assertEqual(git.call_args.args[0][-3:], ["push", "origin", "HEAD:refs/heads/poise/issue-7"])

    async def test_first_pr_validate_publish_and_completion_reject_foreign_closure_before_writes(self):
        self.graph["repository"]["ref"] = {"target": {"oid": self.base, "message": f"fix: implement\n\nPoise-Invocation: {CALL}"}}
        for mode in ("validate", "publish", "complete"):
            with self.subTest(mode=mode):
                client = self._client()
                with patch('github_interface.behaviors.issue_work._run') as git, \
                        patch('github_interface.behaviors.issue_work.work_publication') as checkpoint:
                    self._git(git)
                    with self.assertRaisesRegex(ValueError, "only its seed issue"):
                        await run(client, {**self.payload, "mode": mode, "body": "Also fixes #8", "expected_head": self.base})
                self.assertEqual([call.args[0][3:] for call in git.call_args_list],
                                 [] if mode == "complete" else [["branch", "--show-current"], ["remote", "get-url", "origin"]])
                checkpoint.assert_not_called()
                client.post.assert_not_awaited()
                client.patch.assert_not_awaited()

    async def test_late_edge_without_title_or_body_edit_defers_without_push_or_pr(self):
        self.graph["repository"]["issue"]["blockedBy"] = {
            "nodes": [{"number": 6, "repository": {"nameWithOwner": "example/repo"}}],
            "totalCount": 1, "pageInfo": {"hasNextPage": False}}
        client = self._client()
        with patch('github_interface.behaviors.issue_work._run') as git, \
                patch('github_interface.behaviors.issue_work.work_publication') as checkpoint, \
                patch('github_interface.behaviors.issue_work.read_issue.run',
                      return_value={"repository": "example/repo", "issue_number": 6, "base_sha": self.base,
                                    "state": "open", "verified": False, "pull_number": None, "merge_sha": None,
                                    "reason": "prerequisite is open"}) as delivery:
            self._git(git)
            result = await run(client, dict(self.payload))
        self.assertEqual(result["outcome"], "prerequisite_wait")
        self.assertEqual(result["prerequisite_wait"]["base"], self.base)
        self.assertIn("example/repo#6", result["prerequisite_wait"]["reason"])
        self.assertIn("prerequisite is open", result["prerequisite_wait"]["reason"])
        delivery.assert_awaited_once()
        self.assertEqual(delivery.call_args.args[1]["delivery_base"], self.base)
        checkpoint.assert_not_called()
        client.post.assert_not_awaited()
        pushed = [call for call in git.call_args_list if call.args[0][3] == "push"]
        committed = [call for call in git.call_args_list if call.args[0][3] == "commit"]
        self.assertEqual((pushed, committed), ([], []))

    async def test_edge_added_after_validation_is_caught_at_publish(self):
        client = self._client()
        with patch('github_interface.behaviors.issue_work._run') as git:
            self._git(git)
            validated = await run(client, {**self.payload, "mode": "validate"})
        self.assertEqual(validated["outcome"], "validated")
        self.graph["repository"]["issue"]["blockedBy"] = {
            "nodes": [{"number": 6, "repository": {"nameWithOwner": "example/repo"}}],
            "totalCount": 1, "pageInfo": {"hasNextPage": False}}
        client = self._client()
        with patch('github_interface.behaviors.issue_work._run') as git, \
                patch('github_interface.behaviors.issue_work.work_publication') as checkpoint, \
                patch('github_interface.behaviors.issue_work.read_issue.run',
                      return_value={"repository": "example/repo", "issue_number": 6, "base_sha": self.base,
                                    "state": "open", "verified": False, "pull_number": None, "merge_sha": None,
                                    "reason": "prerequisite is open"}):
            self._git(git)
            result = await run(client, dict(self.payload))
        self.assertEqual(result["outcome"], "prerequisite_wait")
        checkpoint.assert_not_called()
        client.post.assert_not_awaited()

    async def test_prerequisite_merged_only_after_candidate_base_defers_while_delivered_base_publishes(self):
        self.graph["repository"]["issue"]["blockedBy"] = {
            "nodes": [{"number": 6, "repository": {"nameWithOwner": "example/repo"}}],
            "totalCount": 1, "pageInfo": {"hasNextPage": False}}
        client = self._client()
        with patch('github_interface.behaviors.issue_work._run') as git, \
                patch('github_interface.behaviors.issue_work.work_publication') as checkpoint, \
                patch('github_interface.behaviors.issue_work.read_issue.run',
                      return_value={"repository": "example/repo", "issue_number": 6, "base_sha": self.base,
                                    "state": "closed", "verified": False, "pull_number": None, "merge_sha": None,
                                    "reason": "no linked closing PR merge is verified on the implementation base"}):
            self._git(git)
            deferred = await run(client, dict(self.payload))
        self.assertEqual(deferred["outcome"], "prerequisite_wait")
        checkpoint.assert_not_called()
        client.post.assert_not_awaited()
        client = self._client()
        client.post.return_value = {"number": 8, "html_url": "https://github.com/example/repo/pull/8",
                                    "head": {"sha": "b" * 40}}
        with patch('github_interface.behaviors.issue_work._run') as git, \
                patch('github_interface.behaviors.issue_work.work_publication') as checkpoint, \
                patch('github_interface.behaviors.issue_work.read_issue.run',
                      return_value={"repository": "example/repo", "issue_number": 6, "base_sha": self.base,
                                    "state": "closed", "verified": True, "pull_number": 9, "merge_sha": "d" * 40,
                                    "reason": None}), \
                patch('github_interface.behaviors.issue_work.confirmed_pull',
                      new_callable=AsyncMock, return_value={"number": 8, "html_url": "https://github.com/example/repo/pull/8"}):
            def run_git(args, token, *extra):
                if args[3:5] == ["branch", "--show-current"]:
                    return "poise/issue-7"
                if args[3:5] == ["remote", "get-url"]:
                    return "https://github.com/example/repo.git"
                if args[3:5] == ["rev-parse", "HEAD"]:
                    return self.base if mock_count[0] < 1 else "b" * 40
                if args[3:5] == ["status", "--porcelain"]:
                    return " M file"
                return ""
            mock_count = [0]
            orig = run_git
            def counting(args, token, *extra):
                if args[3:5] == ["rev-parse", "HEAD"]:
                    mock_count[0] += 1
                    return self.base if mock_count[0] == 1 else "b" * 40
                return orig(args, token, *extra)
            git.side_effect = counting
            result = await run(client, dict(self.payload))
        self.assertEqual(result["outcome"], "published")
        checkpoint.assert_called()
        client.post.assert_awaited_once()

    async def test_incomplete_blocked_by_evidence_defers_without_delivery_reads(self):
        self.graph["repository"]["issue"]["blockedBy"] = {
            "nodes": [{"number": 6, "repository": {"nameWithOwner": "example/repo"}}],
            "totalCount": 2, "pageInfo": {"hasNextPage": False}}
        client = self._client()
        with patch('github_interface.behaviors.issue_work._run') as git, \
                patch('github_interface.behaviors.issue_work.work_publication') as checkpoint, \
                patch('github_interface.behaviors.issue_work.read_issue.run') as delivery:
            self._git(git)
            result = await run(client, dict(self.payload))
        self.assertEqual(result["outcome"], "prerequisite_wait")
        self.assertIn("missing or incomplete", result["prerequisite_wait"]["reason"])
        delivery.assert_not_awaited()
        checkpoint.assert_not_called()
        client.post.assert_not_awaited()

    async def test_already_attempted_publication_still_reconciles_when_prerequisites_wait(self):
        self.graph["repository"]["issue"]["blockedBy"] = {
            "nodes": [{"number": 6, "repository": {"nameWithOwner": "example/repo"}}],
            "totalCount": 1, "pageInfo": {"hasNextPage": False}}
        head = "b" * 40
        self.graph["repository"]["ref"] = {"target": {"oid": head, "message": f"fix: implement\n\nPoise-Invocation: {CALL}"}}
        client = AsyncMock(token="private-token")
        client.get.side_effect = [{"full_name": "example/repo", "default_branch": "main"},
                                  {"state": "open"}]
        client.paginate.side_effect = [[], []]
        client.graphql.return_value = self.graph
        client.post.return_value = {"number": 8, "html_url": "https://github.com/example/repo/pull/8"}
        with patch('github_interface.behaviors.issue_work.work_publication') as checkpoint, \
                patch('github_interface.behaviors.issue_work.read_issue.run') as delivery:
            result = await run(client, {"repository": "example/repo", "token_user": "author", "issue": 7,
                                        "branch": "poise/issue-7", "mode": "complete", "expected_head": head,
                                        "invocation_id": CALL, "title": "fix: implement seed",
                                        "body": "Implements the requested behavior.", "replies_json": "[]"})
        self.assertEqual(result["outcome"], "published")
        delivery.assert_not_awaited()
        checkpoint.assert_not_called()
        client.post.assert_awaited_once()
