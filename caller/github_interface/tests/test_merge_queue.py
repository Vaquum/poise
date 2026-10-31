from copy import deepcopy
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from github_interface.behaviors import merge_candidates, merge_if_ready, mergeable, pr_readiness, update_branch_if_behind
from review_response_fixture import published_review, response

HEAD = "a" * 40
PAYLOAD = {"repository": "acme/app", "pr": "#7", "expected_head": HEAD, "author": "octocat", "token_user": "review-bot"}
PULL = {"state": "open", "draft": False, "mergeable": True, "mergeable_state": "behind",
        "head": {"sha": HEAD}, "user": {"login": "octocat"}, "merged": False,
        "base": {"sha": "b" * 40}, "title": "Fix review ordering", "body": "Retain final-context review responses."}
PAYLOAD["review_response"] = response(PULL)
READY = {"id": "PR_7", "state": "OPEN", "isDraft": False, "mergeable": "MERGEABLE",
         "mergeStateStatus": "BEHIND", "headRefOid": HEAD, "mergeQueue": {"id": "MQ_main"},
         "mergeQueueEntry": None, "reviewDecision": "APPROVED",
         "commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": "SUCCESS"}}}]},
         "reviewThreads": {"nodes": [], "pageInfo": {"hasNextPage": False}}}


class TestMergeQueue(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = AsyncMock()
        self.client.paginate.return_value = [published_review(PAYLOAD["review_response"])]
        self.client.graphql.return_value = {"enqueuePullRequest": {"mergeQueueEntry": {
            "id": "MQE_7", "pullRequest": {"headRefOid": HEAD},
        }}}
        self.pull = deepcopy(PULL)
        self.ready = deepcopy(READY)
        self.pulls = AsyncMock(side_effect=lambda *_: deepcopy(self.pull))
        for module in (merge_if_ready, update_branch_if_behind):
            for name, value in (("get_pull", self.pulls),
                                ("get_pr_readiness_state", AsyncMock(side_effect=lambda *_: deepcopy(self.ready)))):
                stub = patch.object(module, name, value)
                stub.start()
                self.addCleanup(stub.stop)

    async def test_behind_head_enqueues_atomically_without_direct_merge_or_branch_update(self):
        result = await merge_if_ready.run(self.client, PAYLOAD)
        self.assertEqual(result["outcome"], "enqueued")
        self.assertEqual(result["queue_entry_id"], "MQE_7")
        self.assertNotIn("merge_sha", result)
        query, variables = self.client.graphql.call_args.args
        self.assertIn("expectedHeadOid: $head", query)
        self.assertEqual(variables, {"pull": "PR_7", "head": HEAD})
        self.client.request.assert_not_awaited()
        self.client.get.assert_not_awaited()
        self.assertEqual((await update_branch_if_behind.run(self.client, PAYLOAD))["outcome"], "not_ready")
        self.client.request.assert_not_awaited()

    async def test_queue_admission_requires_its_retained_final_context_response(self):
        for value in (None, {}, {**PAYLOAD['review_response'], 'context_sha': 'd' * 64},
                      {**PAYLOAD['review_response'], 'completed_at': 10 ** 15},
                      {**PAYLOAD['review_response'], 'invocation_id': 'd' * 32}):
            self.assertEqual((await merge_if_ready.run(self.client, {**PAYLOAD, 'review_response': value}))['outcome'], 'not_ready')
            self.client.graphql.assert_not_awaited()
            self.client.request.assert_not_awaited()

    async def test_observing_existing_entry_does_not_claim_merge_or_enqueue_again(self):
        self.ready["mergeQueueEntry"] = {"id": "MQE_existing"}
        self.ready["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["state"] = "PENDING"
        result = await merge_if_ready.run(self.client, PAYLOAD)
        self.assertEqual(result["outcome"], "in_queue")
        self.assertEqual(result["queue_entry_id"], "MQE_existing")
        self.assertNotIn("merge_sha", result)
        self.client.graphql.assert_not_awaited()
        self.client.request.assert_not_awaited()

    async def test_queue_requirement_blocked_state_can_enqueue_after_controls_pass(self):
        self.ready["mergeStateStatus"] = "BLOCKED"
        self.pull["mergeable_state"] = "blocked"
        self.assertEqual((await merge_if_ready.run(self.client, PAYLOAD))["outcome"], "enqueued")

    async def test_failed_pending_missing_checks_and_required_reviews_do_not_enqueue(self):
        for state in ("PENDING", "FAILURE", "ERROR", None):
            with self.subTest(state=state):
                self.ready = deepcopy(READY)
                self.ready["commits"]["nodes"][0]["commit"]["statusCheckRollup"] = {"state": state} if state else None
                self.assertEqual((await merge_if_ready.run(self.client, PAYLOAD))["outcome"], "not_ready")
        for decision in (None, "REVIEW_REQUIRED", "CHANGES_REQUESTED"):
            with self.subTest(decision=decision):
                self.ready = {**deepcopy(READY), "reviewDecision": decision}
                self.assertEqual((await merge_if_ready.run(self.client, PAYLOAD))["outcome"], "not_ready")
        self.client.graphql.assert_not_awaited()

    async def test_conflicts_and_unread_or_open_conversations_do_not_enqueue(self):
        for fields in (
            {"mergeable": "CONFLICTING", "mergeStateStatus": "DIRTY"},
            {"mergeable": "UNKNOWN", "mergeStateStatus": "UNKNOWN"},
            {"reviewThreads": {"nodes": [], "pageInfo": {"hasNextPage": True}}},
            {"reviewThreads": {"nodes": [{"isResolved": False, "isOutdated": False}], "pageInfo": {"hasNextPage": False}}},
        ):
            with self.subTest(fields=fields):
                self.ready = {**deepcopy(READY), **fields}
                self.assertEqual((await merge_if_ready.run(self.client, PAYLOAD))["outcome"], "not_ready")
        self.client.graphql.assert_not_awaited()

    async def test_changed_head_at_final_read_does_not_enqueue(self):
        self.pulls.side_effect = [deepcopy(PULL), {**deepcopy(PULL), "head": {"sha": "b" * 40}}]
        self.assertEqual((await merge_if_ready.run(self.client, PAYLOAD))["outcome"], "superseded")
        self.client.graphql.assert_not_awaited()

    async def test_failed_or_wrong_head_queue_confirmation_never_claims_success(self):
        for response in ({}, {"enqueuePullRequest": {"mergeQueueEntry": None}},
                         {"enqueuePullRequest": {"mergeQueueEntry": {"id": "MQE_7", "pullRequest": {"headRefOid": "b" * 40}}}}):
            with self.subTest(response=response):
                self.client.graphql.return_value = response
                with self.assertRaisesRegex(RuntimeError, "did not confirm"):
                    await merge_if_ready.run(self.client, PAYLOAD)


class TestQueueReadiness(TestCase):
    def test_queue_candidate_is_ready_without_requesting_a_base_update(self):
        self.assertEqual(mergeable.readiness_status(deepcopy(READY)), "green")
        self.assertIsNone(mergeable.readiness_behind(deepcopy(READY)))
        self.assertIn("mergeQueue", merge_candidates.FIELDS)
        self.assertIn("reviewDecision", merge_candidates.FIELDS)

    def test_person_readiness_retains_current_head_approval_checks_and_threads(self):
        approval = {"reviewer_approved_current_head": True, "changes_requested": False}
        self.assertEqual(pr_readiness._blockers(READY, approval, "SUCCESS", [], False), [])
        self.assertIn("reviewer_not_approved_current_head", pr_readiness._blockers(
            READY, {**approval, "reviewer_approved_current_head": False}, "SUCCESS", [], False))
        self.assertIn("required_checks_not_green", pr_readiness._blockers(READY, approval, "PENDING", [], False))
        self.assertIn("unresolved_live_conversations", pr_readiness._blockers(READY, approval, "SUCCESS", [{}], False))
        self.assertIn("readiness_pagination_incomplete", pr_readiness._blockers(READY, approval, "SUCCESS", [], True))

    def test_queue_detection_fails_closed_on_malformed_evidence(self):
        for queue in ({}, {"id": None}, "enabled"):
            with self.subTest(queue=queue), self.assertRaisesRegex(RuntimeError, "malformed merge queue"):
                mergeable.readiness_status({**deepcopy(READY), "mergeQueue": queue})
