from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

from github_interface.atoms import review_diff as rd
from github_interface.atoms.pulls import _thread_summary
from github_interface.behaviors import pr_review

HEAD = "a" * 40
BASE = "b" * 40


def review(identity=1, state="CHANGES_REQUESTED", head=HEAD, body="  Repair the current blocker.\n", user="Reviewer"):
    return {"id": identity, "state": state, "commit_id": head, "body": body, "user": {"login": user},
            "submitted_at": f"2026-11-08T19:51:{identity:02d}Z", "html_url": f"https://github.com/o/r/pull/1#pullrequestreview-{identity}"}


class TestReviewSummaries(IsolatedAsyncioTestCase):
    def setUp(self):
        self.client = AsyncMock()
        self.client.token = "test-token"
        self.client.get.return_value = {"merge_base_commit": {"sha": BASE}}
        self.client.paginate.return_value = []
        self.enterContext(patch.object(pr_review, "get_pull", AsyncMock(return_value={"head": {"sha": HEAD}, "base": {"sha": BASE}})))
        for name in ("list_inline_comments", "issue_comments", "list_review_threads", "linked_issues"):
            self.enterContext(patch.object(pr_review, name, AsyncMock(return_value=[])))
        self.enterContext(patch.object(rd, "_git", return_value=b""))
        self.enterContext(patch.object(rd, "_blob_sizes", AsyncMock(return_value={})))

    async def packet(self):
        return await pr_review.run(self.client, {"repository": "o/r", "pr": 1, "expected_head": HEAD})

    async def test_only_latest_effective_current_head_substantive_requests_are_retained(self):
        current = review()
        cases = [
            ([current], [current]),
            ([review(head=BASE)], []),
            ([review(state="DISMISSED")], []),
            ([review(body=" \n\t")], []),
            ([review(body=None)], []),
            ([current, review(2, "APPROVED", body="", user="reviewer")], []),
            ([current, review(2, "APPROVED", head=BASE, body="")], []),
            ([current, review(2, "DISMISSED", head=BASE, body="")], []),
            ([current, review(2, head=BASE)], []),
            ([current, review(2, body="")], []),
            ([current, review(2, "COMMENTED", body="")], [current]),
            ([current, review(2, "PENDING", body="")], [current]),
            ([current, review(2, body="Another blocker.", user="other")], [current, review(2, body="Another blocker.", user="other")]),
            ([current, review(2, body="Replacement blocker.")], [review(2, body="Replacement blocker.")]),
        ]
        for reviews, expected in cases:
            with self.subTest(reviews=reviews):
                self.client.paginate.return_value = list(reversed(reviews))
                packet = await self.packet()
                self.assertEqual(packet["change_request_reviews"], [
                    {"id": item["id"], "user": item["user"]["login"], "state": item["state"],
                     "commit_id": item["commit_id"], "submitted_at": item["submitted_at"],
                     "url": item["html_url"], "body": item["body"]}
                    for item in expected
                ])
                self.assertEqual(packet["review_threads"], [])
        self.client.paginate.assert_awaited_with("/repos/o/r/pulls/1/reviews")

    async def test_only_current_answer_to_own_feedback_can_be_verified(self):
        def thread(root, *, edited_at=None, more=False, reviewer="Reviewer"):
            return _thread_summary({
                "id": f"thread-{root}", "isResolved": False, "isOutdated": True,
                "path": "fix.py", "line": None, "originalLine": root, "diffSide": "RIGHT",
                "comments": {"pageInfo": {"hasNextPage": more}, "nodes": [
                    {"databaseId": root, "body": "Blocking defect.", "author": {"login": reviewer},
                     "createdAt": "2026-11-08T19:50:00Z",
                     "updatedAt": edited_at or "2026-11-08T19:50:00Z"},
                    {"databaseId": root + 1000, "body": f"Fixed the defect.\n\n<!-- poise-reply {'a' * 32} {root} -->",
                     "author": {"login": "Author"}, "createdAt": "2026-11-08T19:52:00Z",
                     "updatedAt": "2026-11-08T19:52:00Z"},
                ]},
            })

        threads = [thread(1), thread(2, edited_at="2026-11-08T19:53:00Z"), thread(3, more=True),
                   thread(4, reviewer="Other"), thread(5, edited_at="2026-11-08T19:52:00Z")]
        pull = {"head": {"sha": HEAD}, "base": {"sha": BASE}, "user": {"login": "Author"}}
        with patch.object(pr_review, "get_pull", AsyncMock(return_value=pull)), \
                patch.object(pr_review, "list_review_threads", AsyncMock(return_value=threads)):
            packet = await pr_review.run(self.client, {"repository": "o/r", "pr": 1, "expected_head": HEAD,
                                                       "token_user": "reviewer"})
        self.assertEqual(packet["verification_candidates"], [1])
        self.assertEqual([t["root_comment_id"] for t in packet["review_threads"] if "repair_answer" in t], [1, 4])

    async def test_review_read_failure_fails_the_packet(self):
        self.client.paginate.side_effect = RuntimeError("GitHub review read failed")
        with self.assertRaisesRegex(RuntimeError, "GitHub review read failed"):
            await self.packet()

    async def test_missing_or_malformed_revisions_never_prove_packet_supersession(self):
        initial = {"head": {"sha": HEAD}, "base": {"sha": BASE}}
        for phase in ("before", "after"):
            for field in ("head", "base"):
                for invalid in (None, {}, {"sha": ""}, {"sha": "z" * 40}):
                    observed = {"head": {"sha": "c" * 40}, "base": {"sha": "d" * 40}, field: invalid}
                    with self.subTest(phase=phase, field=field, invalid=invalid), \
                            patch.object(pr_review, "get_pull", AsyncMock(side_effect=[observed] if phase == "before" else [initial, observed])), \
                            patch.object(pr_review, "review_diff", AsyncMock(return_value={})), \
                            self.assertRaises(ValueError):
                        await self.packet()

    async def test_review_summary_overflow_fails_instead_of_dropping_blockers(self):
        with patch.object(rd, "MAX_PACKET_BYTES", 6000):
            await self.packet()
            self.client.paginate.return_value = [review(body="é" * 6000)]
            with self.assertRaisesRegex(rd.ReviewPacketTooLarge, "review_packet_too_large"):
                await self.packet()
