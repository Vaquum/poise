from io import StringIO
import json
from typing import Any
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from github_interface import cli
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
        self.calls = []

    async def graphql(self, query: str, variables: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((query, variables))
        pull = {}
        if "reviewRequests" in query:
            pull.update({"state": "OPEN", "isDraft": False, "headRefOid": HEAD, "updatedAt": "2026-09-17T10:00:00Z", "reviewRequests": {**PAGE, "nodes": []}})
        if "reviewThreads" in query:
            pull["reviewThreads"] = {**PAGE, "nodes": []}
        if "reviews(" in query:
            self.assertReviewFields(query)
            pull["reviews"] = {**PAGE, "nodes": self._reviews}
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
        self.assertEqual(len(client.calls), 1)

    async def test_nothing_since_is_an_empty_list(self) -> None:
        facts = await review_activity_since.run(FakeClient([review(90, "COMMENTED", "2026-09-17T09:00:00Z")]), payload("2026-09-17T10:00:00Z"))
        self.assertEqual(facts["reviewer_reviews_since"], 0)
        self.assertEqual(facts["reviewer_reviews_since_items"], [])


class BatchFakeClient:
    """Per-PR reviews keyed by pull number, served from one shared client."""

    def __init__(self, pulls: dict[int, list[dict[str, Any]]]):
        self._pulls = pulls
        self.calls: list[int] = []

    async def graphql(self, query: str, variables: dict[str, Any]) -> dict[str, Any]:
        self.calls.append(variables["number"])
        return {"repository": {"pullRequest": {
            "state": "OPEN", "isDraft": False, "headRefOid": HEAD, "updatedAt": "2026-09-17T10:00:00Z",
            "reviewRequests": {**PAGE, "nodes": []},
            "reviewThreads": {**PAGE, "nodes": []},
            "reviews": {**PAGE, "nodes": self._pulls[variables["number"]]},
        }}}


def batch_payload(*entries: tuple[int, str]) -> dict[str, Any]:
    return {"username": "bit-mis", "token_user": "bit-mis", "requests": [
        {"repository": "Vaquum/repo", "number": number, "since": since} for number, since in entries
    ]}


class TestReviewActivitySinceBatch(IsolatedAsyncioTestCase):
    async def test_batch_honors_each_request_watermark_in_order(self) -> None:
        client = BatchFakeClient({
            68: [review(90, "COMMENTED", "2026-09-17T09:00:00Z"),
                 review(91, "APPROVED", "2026-09-17T10:05:00Z")],
            69: [review(92, "CHANGES_REQUESTED", "2026-09-17T10:06:00Z")],
        })
        result = await review_activity_since.run(client, batch_payload(
            (68, "2026-09-17T10:00:00Z"), (69, "1970-01-01T00:00:00Z")))
        self.assertEqual(result["action"], "review_activity_since_batch")
        self.assertEqual(result["username"], "bit-mis")
        records = result["records"]
        self.assertEqual(
            [(record["pull_number"], record["reviewer_reviews_since"], record["error"]) for record in records],
            [(68, 1, None), (69, 1, None)],
        )
        self.assertEqual(records[0]["reviewer_reviews_since_items"][0]["id"], 91)
        self.assertEqual(records[1]["reviewer_reviews_since_items"][0]["id"], 92)
        self.assertEqual(sorted(client.calls), [68, 69])

    async def test_bad_watermark_fails_only_its_record(self) -> None:
        client = BatchFakeClient({68: [], 69: []})
        result = await review_activity_since.run(client, batch_payload(
            (68, "2026-09-17T10:00:00Z"), (69, "not-a-timestamp")))
        records = result["records"]
        self.assertIsNone(records[0]["error"])
        self.assertEqual(records[1]["repository"], "Vaquum/repo")
        self.assertEqual(records[1]["pull_number"], 69)
        self.assertIn("ISO-8601", records[1]["error"])
        self.assertEqual(client.calls, [68])

    async def test_invalid_batches_are_refused_before_any_read(self) -> None:
        client = BatchFakeClient({})
        invalid = [
            [{"repository": "Vaquum/repo", "number": number, "since": "2026-09-17T10:00:00Z"}
             for number in range(1, 52)],
            [{"repository": "Vaquum/repo", "number": 68, "since": "2026-09-17T10:00:00Z"},
             {"repository": "Vaquum/repo", "number": 68, "since": "2026-09-17T10:00:00Z"}],
            [{"repository": "Vaquum/repo", "number": 68}],
            [{"repository": "Vaquum/repo", "number": 68, "since": "2026-09-17T10:00:00Z", "extra": 1}],
        ]
        for requests in invalid:
            with self.subTest(requests=requests):
                with self.assertRaises(ValueError):
                    await review_activity_since.run(
                        client, {"username": "bit-mis", "token_user": "bit-mis", "requests": requests})
        self.assertEqual(client.calls, [])


class TestReviewActivitySinceCli(TestCase):
    def test_cli_routes_batch_without_a_positional_pr(self) -> None:
        operation = AsyncMock(return_value={"action": "review_activity_since_batch"})
        requests = [{"repository": "Vaquum/repo", "number": 68, "since": "2026-09-17T10:00:00Z"}]
        with patch("sys.argv", ["github-interface", "--review-activity-since", "--requests-json", json.dumps(requests),
                                "--username", "bit-mis", "--token-user", "bit-mis"]), \
                patch.object(cli, "review_activity_since", operation), patch("sys.stdout", StringIO()):
            cli.main()
        operation.assert_awaited_once_with({"username": "bit-mis", "token_user": "bit-mis",
                                            "requests": requests, "since": None})

    def test_cli_still_routes_one_pr_positionally(self) -> None:
        operation = AsyncMock(return_value={"action": "review_activity_since"})
        with patch("sys.argv", ["github-interface", "--review-activity-since", "#68", "--username", "bit-mis",
                                "--since", "2026-09-17T10:00:00Z", "--token-user", "bit-mis"]), \
                patch.object(cli, "review_activity_since", operation), patch("sys.stdout", StringIO()):
            cli.main()
        operation.assert_awaited_once_with({"pr": "#68", "username": "bit-mis", "requests_json": None,
                                            "since": "2026-09-17T10:00:00Z", "token_user": "bit-mis"})
