from typing import Any
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

from github_interface.atoms.review_response import response_body
from github_interface.behaviors import pr_review, request_changes

HEAD = "c" * 40
ASSESSMENT = {
    "verdict": "The submitted findings still block the supplied head.",
    "reviewed_context": "Checked the existing findings and the changed validation paths.",
    "limitations": "Fixture review; no application tests executed.",
}


class FakeClient:
    def __init__(self, rest_comments: list[dict[str, Any]], review: dict[str, Any], threads: list[dict[str, Any]] | None = None,
                 pull: dict[str, Any] | None = None):
        self._rest_comments = rest_comments
        self._review = review
        self._threads = threads or []
        self._pull = pull or {"state": "open", "draft": False, "user": {"login": "person"}, "head": {"sha": HEAD},
                              "base": {"sha": "b" * 40}, "title": "Fix validation", "body": ""}
        self.posts: list[tuple[str, dict[str, Any]]] = []

    async def get(self, path: str, **kwargs: Any) -> dict[str, Any]:
        return self._pull

    async def paginate(self, path: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        if path.endswith("/reviews"):
            return [self._review] if self.posts else []
        if "/issues/" in path:
            return []
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
        self._review = {**self._review, "body": kwargs["json"]["body"],
                        "html_url": "https://github.com/Vaquum/repo/pull/68#pullrequestreview-9"}
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


def thread(*, resolved: bool = False, outdated: bool = False, identifier: int = 101,
           comment: dict[str, Any] | None = None) -> dict[str, Any]:
    comment = comment or COMMENT
    return {
        "id": f"thread-{identifier}", "isResolved": resolved, "isOutdated": outdated,
        "path": comment["path"], "line": None if outdated else comment["line"],
        "originalLine": comment["line"], "diffSide": "RIGHT",
        "comments": {"nodes": [{"databaseId": identifier, "body": comment["body"], "author": {"login": "bit-mis"}}]},
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

    async def test_moved_head_refuses_before_post(self) -> None:
        moved = {"state": "open", "draft": False, "user": {"login": "person"}, "head": {"sha": "d" * 40}}
        fake = FakeClient([], review(), pull=moved)

        with self.assertRaisesRegex(RuntimeError, "pull-request head changed"):
            await request_changes.run(fake, payload([COMMENT]))
        self.assertEqual(fake.posts, [])

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
        existing = {**COMMENT, "side": "RIGHT", "user": {"login": "x"}}
        fake = FakeClient([existing], review())

        result = await request_changes.run(fake, payload([COMMENT]))

        self.assertEqual(result["action"], "no_review")
        self.assertEqual(len(result["skipped"]), 1)
        self.assertEqual(fake.posts, [])

    async def test_current_unresolved_finding_is_reaffirmed_without_duplicate_inline_comment(self) -> None:
        outdated = {"path": "a.py", "line": 8, "body": "A second blocker.\nKeep its explanation."}
        resolved = {"path": "a.py", "line": 10, "body": "Already resolved."}
        unrelated = {**COMMENT, "line": 12}
        fake = FakeClient([COMMENT, outdated, resolved, unrelated], review(), [
            thread(), thread(identifier=102, outdated=True, comment=outdated),
            thread(identifier=103, resolved=True, comment=resolved), thread(identifier=104, comment=unrelated),
        ])

        result = await request_changes.run(fake, {**payload([COMMENT, outdated, resolved, COMMENT]), "assessment": ASSESSMENT})

        self.assertEqual(fake.posts, [("/repos/Vaquum/repo/pulls/68/reviews", {
            "event": "REQUEST_CHANGES",
            "commit_id": HEAD,
            "body": response_body(result["review_response"]) + "\n\n" + request_changes.REAFFIRM_BODY
                    + "\n\n[Thread 101](https://github.com/Vaquum/repo/pull/68#discussion_r101):\n\n> Fix this."
                    + "\n\n[Thread 102](https://github.com/Vaquum/repo/pull/68#discussion_r102):"
                      "\n\n> A second blocker.\n> Keep its explanation.",
        })])
        self.assertEqual(result["outcome"], "changes_requested")
        self.assertTrue(result["reaffirmed"])
        self.assertEqual(result["comments"], 0)
        await self.assert_repair_readback(fake)

    async def test_standalone_reaffirmation_retains_the_finding_and_thread(self) -> None:
        fake = FakeClient([COMMENT], review(), [thread()])

        result = await request_changes.run(fake, payload([COMMENT]))

        self.assertTrue(result["reaffirmed"])
        self.assertEqual(fake.posts[0][1]["body"], request_changes.REAFFIRM_BODY
                         + "\n\n[Thread 101](https://github.com/Vaquum/repo/pull/68#discussion_r101):\n\n> Fix this.")
        self.assertNotIn("comments", fake.posts[0][1])

    async def test_missing_reaffirmed_root_id_fails_before_publication(self) -> None:
        existing = thread()
        del existing["comments"]["nodes"][0]["databaseId"]
        fake = FakeClient([COMMENT], review(), [existing])

        with self.assertRaisesRegex(RuntimeError, "missing reaffirmed root comment IDs"):
            await request_changes.run(fake, payload([COMMENT]))
        self.assertEqual(fake.posts, [])

    async def test_resolved_findings_are_not_reaffirmed(self) -> None:
        for resolved, outdated in ((True, False), (True, True)):
            with self.subTest(resolved=resolved, outdated=outdated):
                fake = FakeClient([COMMENT], review(), [thread(resolved=resolved, outdated=outdated)])

                result = await request_changes.run(fake, payload([COMMENT]))

                self.assertEqual(result["action"], "no_review")
                self.assertEqual(fake.posts, [])

    async def test_existing_and_new_findings_share_one_review_without_duplicate_comment(self) -> None:
        new = {**COMMENT, "side": "RIGHT", "body": "New blocking defect on the same line."}
        unrelated = {"path": "a.py", "line": 12, "body": "Not assessed in this review."}
        fake = FakeClient([COMMENT, unrelated], review(), [thread(), thread(identifier=102, comment=unrelated)])

        result = await request_changes.run(fake, {**payload([COMMENT, new]), "assessment": ASSESSMENT})

        self.assertEqual(len(fake.posts), 1)
        self.assertEqual(fake.posts[0][1], {
            "event": "REQUEST_CHANGES", "commit_id": HEAD,
            "body": response_body(result["review_response"]) + "\n\n" + request_changes.REAFFIRM_BODY
                    + "\n\n[Thread 101](https://github.com/Vaquum/repo/pull/68#discussion_r101):\n\n> Fix this.",
            "comments": [new],
        })
        self.assertTrue(result["reaffirmed"])
        self.assertEqual(result["comments"], 1)
        await self.assert_repair_readback(fake)

    async def assert_repair_readback(self, fake: FakeClient) -> None:
        with patch.object(pr_review, "review_diff", AsyncMock(return_value={})), \
                patch.object(pr_review, "linked_issues", AsyncMock(return_value=[])):
            packet = await pr_review.run(fake, payload([]))
        self.assertEqual(len(packet["change_request_reviews"]), 1)
        self.assertEqual(packet["change_request_reviews"][0]["body"], fake.posts[0][1]["body"])

    async def test_distinct_new_findings_at_one_location_are_both_published(self) -> None:
        new = {**COMMENT, "body": "Another defect on the same line."}
        fake = FakeClient([], review())

        result = await request_changes.run(fake, payload([COMMENT, new, COMMENT]))

        self.assertEqual(fake.posts[0][1]["comments"], [{**COMMENT, "side": "RIGHT"}, {**new, "side": "RIGHT"}])
        self.assertEqual(result["comments"], 2)
        self.assertEqual(len(result["skipped"]), 1)

    async def test_different_finding_at_an_unresolved_location_is_new(self) -> None:
        new = {**COMMENT, "body": "Another defect on the same line."}
        fake = FakeClient([COMMENT], review(), [thread()])

        result = await request_changes.run(fake, payload([new]))

        self.assertEqual(fake.posts[0][1]["comments"], [{**new, "side": "RIGHT"}])
        self.assertEqual(fake.posts[0][1]["body"], request_changes.REVIEW_BODY)
        self.assertFalse(result["reaffirmed"])

    async def test_empty_findings_cannot_reaffirm_an_unreviewed_thread(self) -> None:
        fake = FakeClient([COMMENT], review(), [thread()])

        with self.assertRaisesRegex(ValueError, "1-100 entries"):
            await request_changes.run(fake, payload([]))

        self.assertEqual(fake.posts, [])
