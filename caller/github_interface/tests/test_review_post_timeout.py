from typing import Any
from unittest import IsolatedAsyncioTestCase
from unittest.mock import patch

import httpx
from github_interface.atoms.pulls import approve_pr, comment_review, request_changes
from github_interface.behaviors import request_changes as request_changes_command
from github_interface.client import GitHubClient

from github_interface import client as client_module

HEAD = "c" * 40
PULL = "/repos/o/r/pulls/7"
REVIEWS = f"{PULL}/reviews"
ISSUE_COMMENTS = "/repos/o/r/issues/7/comments"
COMMENT = {"path": "a.py", "line": 3, "body": "Fix this."}
REVIEW_POSTS = {
    "request_changes": lambda client: request_changes(client, "o", "r", 7, HEAD, [COMMENT], "body"),
    "comment_review": lambda client: comment_review(client, "o", "r", 7, HEAD, "body"),
    "approve_pr": lambda client: approve_pr(client, "o", "r", 7, HEAD, "body"),
}


class TestSlowGitHubAnswer(IsolatedAsyncioTestCase):
    """Runs the real GitHubClient and httpx; only the network is simulated."""

    def setUp(self) -> None:
        self.requests: list[httpx.Request] = []
        self.answers: dict[str, Any] = {REVIEWS: {"id": 9}}
        self.delays: dict[str, float] = {}
        real_client = httpx.AsyncClient
        self.enterContext(patch.object(client_module, "get_token", return_value="test-token"))
        self.enterContext(patch.object(client_module, "_RETRY_DELAY_SECONDS", 0))
        self.enterContext(
            patch.object(
                client_module.httpx,
                "AsyncClient",
                lambda **kwargs: real_client(transport=httpx.MockTransport(self._github), **kwargs),
            )
        )
        self.client = GitHubClient("test-account")

    def _github(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if self.delays.get(path, 0.0) > request.extensions["timeout"]["read"]:
            raise httpx.ReadTimeout("no answer within the read limit", request=request)
        return httpx.Response(200, json=self.answers[path])

    async def test_answer_after_ten_seconds_completes_each_review_post(self) -> None:
        self.delays[REVIEWS] = 11.0

        for name, post in REVIEW_POSTS.items():
            with self.subTest(name):
                self.assertEqual(await post(self.client), {"id": 9})
                limits = dict(self.requests[-1].extensions["timeout"])
                del limits["read"]
                self.assertEqual(set(limits.values()), {10.0})

    async def test_answer_after_ten_seconds_completes_the_request_changes_command(self) -> None:
        self.delays[REVIEWS] = 11.0
        self.answers.update({
            PULL: {"state": "open", "draft": False, "user": {"login": "person"}, "head": {"sha": HEAD}},
            f"{PULL}/comments": [],
            "/graphql": {"data": {"repository": {"pullRequest": {"reviewThreads": {
                "pageInfo": {"hasNextPage": False, "endCursor": None},
                "nodes": [],
            }}}}},
            REVIEWS: {"id": 9, "state": "CHANGES_REQUESTED", "commit_id": HEAD, "user": {"login": "bit-mis"}},
        })

        result = await request_changes_command.run(self.client, {
            "repository": "o/r",
            "pr": "7",
            "expected_head": HEAD,
            "token_user": "bit-mis",
            "comments": [COMMENT],
        })

        self.assertEqual(result["outcome"], "changes_requested")
        self.assertEqual(result["review_id"], 9)

    async def test_no_answer_within_the_limit_times_out_after_one_post(self) -> None:
        self.delays[REVIEWS] = 31.0

        for name, post in REVIEW_POSTS.items():
            with self.subTest(name):
                self.requests.clear()
                with self.assertRaises(httpx.ReadTimeout):
                    await post(self.client)
                self.assertEqual(len(self.requests), 1)

    async def test_other_requests_keep_the_ten_second_limit(self) -> None:
        self.delays.update({PULL: 11.0, ISSUE_COMMENTS: 11.0})

        with self.assertRaises(httpx.ReadTimeout):
            await self.client.get(PULL)
        self.assertEqual(len(self.requests), 2)
        with self.assertRaises(httpx.ReadTimeout):
            await self.client.post(ISSUE_COMMENTS, json={"body": "note"})
        self.assertEqual(len(self.requests), 3)
