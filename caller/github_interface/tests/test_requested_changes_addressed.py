from copy import deepcopy
from unittest import IsolatedAsyncioTestCase

from github_interface.behaviors import requested_changes_addressed
from github_interface.behaviors.request_changes import REAFFIRM_BODY

HEAD = "c" * 40
PAYLOAD = {"repository": "owner/repo", "pr": "7", "username": "reviewer", "token_user": "reviewer"}
REQUESTED_AT = "2026-09-17T10:00:00Z"
REPLIED_AT = "2026-09-17T11:00:00Z"


def review(state, identifier=1, body="finding", login="reviewer", submitted_at=REQUESTED_AT):
    return {"id": identifier, "state": state, "body": body, "user": {"login": login},
            "submitted_at": submitted_at, "commit_id": HEAD}


class FakeClient:
    def __init__(self, reviews):
        self.calls = []
        self.reviews = reviews
        self.inline = []
        self.commits = []
        self.comments = []
        self.threads = []

    async def get(self, path):
        self.calls.append(path)
        return {"user": {"login": "author"}, "head": {"sha": HEAD}}

    async def paginate(self, path):
        self.calls.append(path)
        return {"/repos/owner/repo/pulls/7/reviews": self.reviews,
                "/repos/owner/repo/pulls/7/comments": self.inline,
                "/repos/owner/repo/pulls/7/commits": self.commits,
                "/repos/owner/repo/issues/7/comments": self.comments}[path]

    async def graphql(self, query, variables):
        self.calls.append("graphql")
        return {"repository": {"pullRequest": {"reviewThreads": {
            "pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": self.threads,
        }}}}


def expected(latest=None):
    return {"action": "requested_changes_addressed", "repository": "owner/repo", "pull_number": 7,
            "username": "reviewer", "pr_author": "author", "status": False, "has_change_request": False,
            "reviewer_latest_state": latest, "reviewer_latest_commit": HEAD if latest else None,
            "request_review_id": None, "request_reviews": 0, "request_inline_comments": 0,
            "latest_request_at": None, "head_sha": HEAD, "commits_after_request": 0,
            "author_commits_after_request": 0, "author_inline_replies_after_request": 0,
            "author_pr_comments_after_request": 0, "resolved_request_threads": 0, "response_count": 0}


def thread(identifier=10, resolved=True):
    return {"id": "thread", "isOutdated": False, "isResolved": resolved, "path": "a.py",
            "line": 1, "originalLine": 1, "diffSide": "RIGHT",
            "comments": {"nodes": [{"databaseId": identifier, "body": "finding", "author": {"login": "reviewer"}}]}}


class TestRequestedChangesAddressed(IsolatedAsyncioTestCase):
    async def test_no_active_request_preserves_payload_with_only_two_reads(self):
        cases = [([], None), ([review("COMMENTED")], None), ([review("PENDING")], None),
                 ([review("CHANGES_REQUESTED", login="someone-else")], None)]
        for state in ("APPROVED", "DISMISSED"):
            cases.append(([review("CHANGES_REQUESTED"), review(state, 2, submitted_at=REPLIED_AT)], state))
        for reviews, latest in cases:
            with self.subTest(reviews=reviews):
                client = FakeClient(reviews)
                # Stale response evidence must not activate an absent/superseded request.
                client.inline = [{"id": 10, "pull_request_review_id": 1, "user": {"login": "reviewer"}}]
                client.threads = [thread()]
                self.assertEqual(await requested_changes_addressed.run(client, PAYLOAD), expected(latest))
                self.assertEqual(client.calls, ["/repos/owner/repo/pulls/7", "/repos/owner/repo/pulls/7/reviews"])

    async def test_active_request_retains_every_response_source(self):
        client = FakeClient([review("CHANGES_REQUESTED"), review("COMMENTED", 2, submitted_at=REPLIED_AT)])
        client.inline = [
            {"id": 10, "pull_request_review_id": 1, "user": {"login": "reviewer"}},
            {"id": 11, "in_reply_to_id": 10, "pull_request_review_id": 3,
             "user": {"login": "author"}, "created_at": REPLIED_AT},
        ]
        client.commits = [{"commit": {"author": {"date": "2026-09-16T10:00:00Z"},
                                      "committer": {"date": REPLIED_AT}}}]
        client.comments = [{"user": {"login": "author"}, "created_at": REPLIED_AT}]
        client.threads = [thread()]
        wanted = expected("CHANGES_REQUESTED")
        wanted.update(status=True, has_change_request=True, request_review_id=1, request_reviews=1,
                      request_inline_comments=1, latest_request_at="2026-09-17T10:00:00+00:00",
                      commits_after_request=1, author_commits_after_request=1,
                      author_inline_replies_after_request=1, author_pr_comments_after_request=1,
                      resolved_request_threads=1, response_count=4)
        self.assertEqual(await requested_changes_addressed.run(client, PAYLOAD), wanted)
        self.assertEqual(len(client.calls), 6)

    async def test_reaffirmation_retains_prior_commented_finding(self):
        client = FakeClient([review("COMMENTED"), review("CHANGES_REQUESTED", 2, REAFFIRM_BODY, submitted_at=REPLIED_AT)])
        client.inline = [{"id": 10, "pull_request_review_id": 1, "user": {"login": "reviewer"}}]
        client.threads = [thread()]
        wanted = expected("CHANGES_REQUESTED")
        wanted.update(status=True, has_change_request=True, request_review_id=2, request_reviews=1,
                      latest_request_at="2026-09-17T11:00:00+00:00", resolved_request_threads=1, response_count=1)
        self.assertEqual(await requested_changes_addressed.run(client, PAYLOAD), wanted)

    async def test_missing_active_request_thread_still_fails(self):
        client = FakeClient([review("CHANGES_REQUESTED")])
        client.inline = [{"id": 10, "pull_request_review_id": 1, "user": {"login": "reviewer"}}]
        with self.assertRaisesRegex(RuntimeError, "missing change-request root comments"):
            await requested_changes_addressed.run(client, PAYLOAD)

    async def test_wrong_actor_still_fails_before_reading(self):
        client = FakeClient([])
        payload = deepcopy(PAYLOAD)
        payload["token_user"] = "someone-else"
        with self.assertRaisesRegex(ValueError, "username must match token-user"):
            await requested_changes_addressed.run(client, payload)
        self.assertEqual(client.calls, [])
