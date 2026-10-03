from typing import Any
from unittest import IsolatedAsyncioTestCase

from github_interface.behaviors import approve_pr

HEAD = "a" * 40


class FakeClient:
    def __init__(self, pull: dict[str, Any], threads: list[dict[str, Any]], review: dict[str, Any]):
        self._pull = pull
        self._threads = threads
        self._review = review
        self.posts: list[tuple[str, dict[str, Any]]] = []

    async def get(self, path: str, **kwargs: Any) -> dict[str, Any]:
        return self._pull

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


def thread(author: str, resolved: bool = False, outdated: bool = False) -> dict[str, Any]:
    return {
        "id": "T1",
        "isOutdated": outdated,
        "isResolved": resolved,
        "path": "a.py",
        "line": 3,
        "originalLine": 3,
        "diffSide": "RIGHT",
        "comments": {"nodes": [{"body": "please fix", "author": {"login": author}}]},
    }


def payload() -> dict[str, Any]:
    return {"repository": "Vaquum/repo", "pr": "68", "expected_head": HEAD, "token_user": "bit-mis"}


def review(state: str = "APPROVED", commit_id: str = HEAD, login: str = "bit-mis") -> dict[str, Any]:
    return {
        "id": 5,
        "state": state,
        "commit_id": commit_id,
        "user": {"login": login},
        "submitted_at": "2026-07-25T00:00:00Z",
    }


def client(
    pull: dict[str, Any] | None = None,
    threads: list[dict[str, Any]] | None = None,
    response: dict[str, Any] | None = None,
) -> FakeClient:
    return FakeClient(pull or {"state": "open", "draft": False}, threads or [], response or review())


class TestApprovePr(IsolatedAsyncioTestCase):
    async def test_approval_pins_expected_head_as_commit_id(self) -> None:
        fake = client()

        result = await approve_pr.run(fake, payload())

        self.assertEqual(
            fake.posts,
            [("/repos/Vaquum/repo/pulls/68/reviews", {"event": "APPROVE", "commit_id": HEAD})],
        )
        self.assertEqual(result["outcome"], "approved")
        self.assertEqual(result["head_sha"], HEAD)
        self.assertEqual(result["actor"], "bit-mis")

    async def test_unresolved_thread_from_other_reviewer_blocks_without_mutation(self) -> None:
        fake = client(threads=[thread("someone-else")])

        with self.assertRaises(RuntimeError) as raised:
            await approve_pr.run(fake, payload())
        self.assertIn("unresolved review conversation", str(raised.exception))
        self.assertEqual(fake.posts, [])

    async def test_own_unresolved_thread_does_not_block(self) -> None:
        fake = client(threads=[thread("Bit-Mis")])

        result = await approve_pr.run(fake, payload())
        self.assertEqual(result["outcome"], "approved")

    async def test_outdated_unresolved_thread_does_not_block(self) -> None:
        fake = client(threads=[thread("someone-else", outdated=True)])

        result = await approve_pr.run(fake, payload())
        self.assertEqual(result["outcome"], "approved")

    async def test_resolved_thread_does_not_block(self) -> None:
        fake = client(threads=[thread("someone-else", resolved=True)])

        result = await approve_pr.run(fake, payload())
        self.assertEqual(result["outcome"], "approved")

    async def test_closed_pull_fails_before_mutation(self) -> None:
        fake = client(pull={"state": "closed", "draft": False})

        with self.assertRaises(RuntimeError):
            await approve_pr.run(fake, payload())
        self.assertEqual(fake.posts, [])

    async def test_draft_pull_fails_before_mutation(self) -> None:
        fake = client(pull={"state": "open", "draft": True})

        with self.assertRaises(RuntimeError):
            await approve_pr.run(fake, payload())
        self.assertEqual(fake.posts, [])

    async def test_wrong_review_state_fails_closed(self) -> None:
        fake = client(response=review(state="COMMENTED"))

        with self.assertRaises(RuntimeError) as raised:
            await approve_pr.run(fake, payload())
        self.assertIn("APPROVED", str(raised.exception))

    async def test_wrong_review_commit_fails_closed(self) -> None:
        fake = client(response=review(commit_id="b" * 40))

        with self.assertRaises(RuntimeError) as raised:
            await approve_pr.run(fake, payload())
        self.assertIn("expected " + HEAD, str(raised.exception))

    async def test_wrong_review_actor_fails_closed(self) -> None:
        fake = client(response=review(login="impostor"))

        with self.assertRaises(RuntimeError) as raised:
            await approve_pr.run(fake, payload())
        self.assertIn("impostor", str(raised.exception))
