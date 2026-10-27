from copy import deepcopy
from unittest import IsolatedAsyncioTestCase

from github_interface.atoms.pulls import get_review_activity, list_review_threads

HEAD = "c" * 40


def page(nodes, cursor=None):
    return {"nodes": nodes, "pageInfo": {"hasNextPage": cursor is not None, "endCursor": cursor}}


def thread(identifier):
    return {"id": identifier, "isOutdated": False, "isResolved": False, "path": "a.py",
            "line": 3, "originalLine": 2, "diffSide": "RIGHT", "comments": {"nodes": [
                {"databaseId": 1, "body": "root", "author": {"login": "reviewer"}},
                {"databaseId": 2, "body": "reply", "author": {"login": "author"}},
            ]}}


class ScriptedClient:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def graphql(self, query, variables):
        self.calls.append((query, variables))
        connection, cursor, pull = self.responses.pop(0)
        assert connection in query
        assert variables.get("cursor") == cursor
        if isinstance(pull, Exception):
            raise pull
        return {"repository": {"pullRequest": deepcopy(pull)}}


class TestReviewActivityPagination(IsolatedAsyncioTestCase):
    async def test_each_connection_uses_its_own_continuation_without_refetching_first_pages(self):
        first = {"state": "OPEN", "isDraft": False, "headRefOid": HEAD,
                 "updatedAt": "2026-09-17T10:00:00Z",
                 "reviewRequests": page([{"requestedReviewer": {"login": "first"}}], "requests-1"),
                 "reviews": page([{"id": "review-1"}], "reviews-1"),
                 "reviewThreads": page([thread("thread-1")], "threads-1")}
        client = ScriptedClient([
            ("reviewRequests", None, first),
            ("reviewRequests", "requests-1", {"reviewRequests": page([{"requestedReviewer": {"login": "second"}}])}),
            ("reviews", "reviews-1", {"reviews": page([{"id": "review-2"}], "reviews-2")}),
            ("reviews", "reviews-2", {"reviews": page([{"id": "review-3"}])}),
            ("reviewThreads", "threads-1", {"reviewThreads": page([thread("thread-2")])}),
        ])
        result = await get_review_activity(client, "owner", "repo", 7)
        self.assertEqual(result, {
            "state": "OPEN", "isDraft": False, "headRefOid": HEAD, "updatedAt": first["updatedAt"],
            "reviewRequests": [{"requestedReviewer": {"login": name}} for name in ("first", "second")],
            "reviews": [{"id": f"review-{number}"} for number in (1, 2, 3)],
            "reviewThreads": [
                {"id": f"thread-{number}", "is_outdated": False, "is_resolved": False,
                 "root_comment_id": 1, "author": "reviewer", "path": "a.py", "line": 3,
                 "side": "RIGHT", "bodies": ["root", "reply"]} for number in (1, 2)
            ],
        })
        self.assertEqual(len(client.calls), 5)
        self.assertFalse(client.responses)
        for query, variables in client.calls[1:]:
            self.assertEqual(sum(f"{name}(" in query for name in ("reviewRequests", "reviews", "reviewThreads")), 1)
            self.assertEqual((variables["owner"], variables["repo"], variables["number"]), ("owner", "repo", 7))

    async def test_standalone_thread_read_keeps_original_fields_and_pagination(self):
        client = ScriptedClient([
            ("reviewThreads", None, {"reviewThreads": page([thread("first")], "next")}),
            ("reviewThreads", "next", {"reviewThreads": page([thread("second")])}),
        ])
        result = await list_review_threads(client, "owner", "repo", 7)
        self.assertEqual([item["id"] for item in result], ["first", "second"])
        self.assertEqual(result[0]["bodies"], ["root", "reply"])
        self.assertEqual(len(client.calls), 2)

    async def test_missing_pull_and_failed_continuation_fail_visibly(self):
        with self.assertRaisesRegex(ValueError, "pull request not found"):
            await get_review_activity(ScriptedClient([("reviewRequests", None, None)]), "owner", "repo", 7)
        first = {"state": "OPEN", "isDraft": False, "headRefOid": HEAD, "updatedAt": "now",
                 "reviewRequests": page([], "next"), "reviews": page([]), "reviewThreads": page([])}
        client = ScriptedClient([("reviewRequests", None, first),
                                 ("reviewRequests", "next", RuntimeError("rate limited"))])
        with self.assertRaisesRegex(RuntimeError, "rate limited"):
            await get_review_activity(client, "owner", "repo", 7)
