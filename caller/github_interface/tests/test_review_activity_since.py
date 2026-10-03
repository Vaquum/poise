from typing import Any
from unittest import IsolatedAsyncioTestCase

from github_interface.behaviors import review_activity_since

HEAD = "c" * 40
PAGE = {"pageInfo": {"hasNextPage": False, "endCursor": None}}


def review(database_id: int, state: str, submitted_at: str, login: str = "bit-mis", commit: str = HEAD) -> dict[str, Any]:
    return {
        "id": f"PRR_{database_id}",
        "databaseId": database_id,
        "author": {"login": login},
        "state": state,
        "submittedAt": submitted_at,
        "updatedAt": submitted_at,
        "commit": {"oid": commit},
    }


class FakeClient:
    def __init__(self, reviews: list[dict[str, Any]]):
        self._reviews = reviews

    async def graphql(self, query: str, variables: dict[str, Any]) -> dict[str, Any]:
        if "reviewRequests" in query:
            pull = {"state": "OPEN", "isDraft": False, "headRefOid": HEAD, "updatedAt": "2026-09-17T10:00:00Z", "reviewRequests": {**PAGE, "nodes": []}}
        elif "reviewThreads" in query:
            pull = {"reviewThreads": {**PAGE, "nodes": []}}
        else:
            self.assertReviewFields(query)
            pull = {"reviews": {**PAGE, "nodes": self._reviews}}
        return {"repository": {"pullRequest": pull}}

    @staticmethod
    def assertReviewFields(query: str) -> None:
        assert "databaseId" in query, "review nodes must carry the id a submission returns"


def payload(since: str) -> dict[str, Any]:
    return {"repository": "Vaquum/repo", "pr": "68", "username": "bit-mis", "token_user": "bit-mis", "since": since}


class TestReviewActivitySince(IsolatedAsyncioTestCase):
    async def test_lists_each_reviewer_review_since_with_its_submission_id(self) -> None:
        client = FakeClient([
            review(90, "COMMENTED", "2026-09-17T09:00:00Z"),
            review(91, "CHANGES_REQUESTED", "2026-09-17T10:05:00Z"),
            review(92, "COMMENTED", "2026-09-17T10:06:00Z"),
            review(93, "APPROVED", "2026-09-17T10:07:00Z", login="someone-else"),
        ])
        facts = await review_activity_since.run(client, payload("2026-09-17T10:00:00Z"))
        self.assertEqual(facts["reviewer_reviews_since"], 2)
        self.assertEqual(
            facts["reviewer_reviews_since_items"],
            [
                {"id": 91, "node_id": "PRR_91", "state": "CHANGES_REQUESTED", "commit": HEAD, "submitted_at": "2026-09-17T10:05:00Z"},
                {"id": 92, "node_id": "PRR_92", "state": "COMMENTED", "commit": HEAD, "submitted_at": "2026-09-17T10:06:00Z"},
            ],
        )
        self.assertEqual(facts["reviewer_change_requests_since"], 1)
        self.assertEqual(facts["reviewer_comments_since"], 1)
        self.assertEqual(facts["reviewer_latest_review_id"], "PRR_91")
        self.assertEqual(facts["reviewer_latest_any_review_id"], "PRR_92")

    async def test_nothing_since_is_an_empty_list(self) -> None:
        facts = await review_activity_since.run(FakeClient([review(90, "COMMENTED", "2026-09-17T09:00:00Z")]), payload("2026-09-17T10:00:00Z"))
        self.assertEqual(facts["reviewer_reviews_since"], 0)
        self.assertEqual(facts["reviewer_reviews_since_items"], [])
