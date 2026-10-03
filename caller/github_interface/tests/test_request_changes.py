from typing import Any
from unittest import IsolatedAsyncioTestCase

from github_interface.behaviors import request_changes

HEAD = "c" * 40


class FakeClient:
    def __init__(self, rest_comments: list[dict[str, Any]], review: dict[str, Any], threads: list[dict[str, Any]] | None = None):
        self._rest_comments = rest_comments
        self._review = review
        self._threads = threads or []
        self.posts: list[tuple[str, dict[str, Any]]] = []

    async def get(self, path: str, **kwargs: Any) -> dict[str, Any]:
        return {"state": "open", "draft": False}

    async def paginate(self, path: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        return self._rest_comments

    async def graphql(self, query: str, variables: dict[str, Any]) -> dict[str, Any]:
        return {
            "repository": {
                "pullRequest": {
                    "reviewThreads": {
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                        "nodes": self._threads,
                    }
                }
            }
        }

    async def post(self, path: str, **kwargs: Any) -> dict[str, Any]:
        self.posts.append((path, kwargs["json"]))
        return self._review


def payload(comments: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "repository": "Vaquum/repo",
        "pr": "68",
        "expected_head": HEAD,
        "token_user": "bit-mis",
        "comments": comments,
    }


def review(state: str = "CHANGES_REQUESTED", commit_id: str = HEAD, login: str = "bit-mis") -> dict[str, Any]:
    return {
        "id": 9,
        "state": state,
        "commit_id": commit_id,
        "user": {"login": login},
        "submitted_at": "2026-07-25T00:00:00Z",
    }


COMMENT = {"path": "a.py", "line": 3, "body": "Fix this."}


def thread(*, resolved: bool = False, outdated: bool = False) -> dict[str, Any]:
    return {
        "id": "thread", "isResolved": resolved, "isOutdated": outdated,
        "path": COMMENT["path"], "line": COMMENT["line"], "diffSide": "RIGHT",
        "comments": {"nodes": [{"body": COMMENT["body"], "author": {"login": "bit-mis"}}]},
    }


class TestRequestChanges(IsolatedAsyncioTestCase):
    async def test_change_request_pins_expected_head_as_commit_id(self) -> None:
        fake = FakeClient([], review())

        result = await request_changes.run(fake, payload([COMMENT]))

        self.assertEqual(len(fake.posts), 1)
        path, body = fake.posts[0]
        self.assertEqual(path, "/repos/Vaquum/repo/pulls/68/reviews")
        self.assertEqual(body["event"], "REQUEST_CHANGES")
        self.assertEqual(body["commit_id"], HEAD)
        self.assertEqual(
            body["comments"],
            [{"path": "a.py", "line": 3, "side": "RIGHT", "body": "Fix this."}],
        )
        self.assertEqual(result["outcome"], "changes_requested")
        self.assertEqual(result["head_sha"], HEAD)

    async def test_wrong_review_state_fails_closed(self) -> None:
        fake = FakeClient([], review(state="COMMENTED"))

        with self.assertRaises(RuntimeError) as raised:
            await request_changes.run(fake, payload([COMMENT]))
        self.assertIn("CHANGES_REQUESTED", str(raised.exception))

    async def test_wrong_review_commit_fails_closed(self) -> None:
        fake = FakeClient([], review(commit_id="d" * 40))

        with self.assertRaises(RuntimeError) as raised:
            await request_changes.run(fake, payload([COMMENT]))
        self.assertIn("expected " + HEAD, str(raised.exception))

    async def test_wrong_review_actor_fails_closed(self) -> None:
        fake = FakeClient([], review(login="impostor"))

        with self.assertRaises(RuntimeError) as raised:
            await request_changes.run(fake, payload([COMMENT]))
        self.assertIn("impostor", str(raised.exception))

    async def test_fully_skipped_comments_submit_no_review(self) -> None:
        existing = {"path": "a.py", "line": 3, "side": "RIGHT", "body": "already here", "user": {"login": "x"}}
        fake = FakeClient([existing], review())

        result = await request_changes.run(fake, payload([COMMENT]))

        self.assertEqual(result["action"], "no_review")
        self.assertEqual(len(result["skipped"]), 1)
        self.assertEqual(fake.posts, [])

    async def test_current_unresolved_finding_is_reaffirmed_without_duplicate_inline_comment(self) -> None:
        fake = FakeClient([COMMENT], review(), [thread()])

        result = await request_changes.run(fake, payload([COMMENT]))

        self.assertEqual(fake.posts, [("/repos/Vaquum/repo/pulls/68/reviews", {
            "event": "REQUEST_CHANGES",
            "commit_id": HEAD,
            "body": request_changes.REAFFIRM_BODY,
        })])
        self.assertEqual(result["outcome"], "changes_requested")
        self.assertTrue(result["reaffirmed"])
        self.assertEqual(result["comments"], 0)

    async def test_resolved_or_outdated_findings_are_not_reaffirmed(self) -> None:
        for resolved, outdated in ((True, False), (False, True), (True, True)):
            with self.subTest(resolved=resolved, outdated=outdated):
                fake = FakeClient([COMMENT], review(), [thread(resolved=resolved, outdated=outdated)])

                result = await request_changes.run(fake, payload([COMMENT]))

                self.assertEqual(result["action"], "no_review")
                self.assertEqual(fake.posts, [])

    async def test_existing_and_new_findings_share_one_review_without_duplicate_comment(self) -> None:
        new = {"path": "b.py", "line": 8, "side": "RIGHT", "body": "New blocking defect."}
        fake = FakeClient([COMMENT], review(), [thread()])

        result = await request_changes.run(fake, payload([COMMENT, new]))

        self.assertEqual(len(fake.posts), 1)
        self.assertEqual(fake.posts[0][1], {
            "event": "REQUEST_CHANGES", "commit_id": HEAD,
            "body": request_changes.REVIEW_BODY, "comments": [new],
        })
        self.assertFalse(result["reaffirmed"])
        self.assertEqual(result["comments"], 1)

    async def test_empty_findings_cannot_reaffirm_an_unreviewed_thread(self) -> None:
        fake = FakeClient([COMMENT], review(), [thread()])

        with self.assertRaisesRegex(ValueError, "1-100 entries"):
            await request_changes.run(fake, payload([]))

        self.assertEqual(fake.posts, [])
