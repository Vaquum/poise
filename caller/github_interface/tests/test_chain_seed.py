"""Single-chain seed batch. These isolated API stand-ins are not cycle proof."""
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

from github_interface.behaviors import chain_seed, issue_comments, issue_work, read_issue

PAYLOAD = {"repository": "example/repo", "token_user": "author", "issue": "#7", "branch": "poise/issue-7"}
ISSUE = {"number": 7, "title": "Seed", "body": "", "state": "open", "labels": []}
RAW_COMMENTS = [{"id": 3, "user": {"login": "reviewer"}, "body": "note",
                 "created_at": "2026-10-01T00:00:00Z", "updated_at": "2026-10-01T00:00:00Z",
                 "html_url": "https://github.com/example/repo/issues/7#issuecomment-3"}]


def client():
    mock = AsyncMock()

    async def fake_get(path, **kwargs):
        if path == "/repos/example/repo/issues/7":
            return dict(ISSUE)
        if path == "/repos/example/repo":
            return {"full_name": "example/repo", "default_branch": "main"}
        raise AssertionError(f"unexpected read {path}")

    async def fake_paginate(path, params=None):
        if path == "/repos/example/repo/issues/7/comments":
            return [dict(RAW_COMMENTS[0])]
        if path == "/repos/example/repo/pulls":
            return []
        raise AssertionError(f"unexpected read {path}")

    mock.get.side_effect = fake_get
    mock.paginate.side_effect = fake_paginate
    mock.graphql.return_value = {"repository": {"ref": None,
        "defaultBranchRef": {"target": {"oid": "c" * 40}},
        "issue": {"closedByPullRequestsReferences": {"nodes": [], "pageInfo": {"hasNextPage": False}}}}}
    return mock


class ChainSeed(IsolatedAsyncioTestCase):
    async def test_facets_match_the_individual_behaviors_on_identical_inputs(self):
        read = await read_issue.run(client(), dict(PAYLOAD))
        comments = await issue_comments.run(client(), dict(PAYLOAD))
        publication = await issue_work.run(client(), {**PAYLOAD, "mode": "inspect"})
        seed = await chain_seed.run(client(), dict(PAYLOAD))
        self.assertEqual(seed["action"], "chain_seed")
        self.assertEqual(seed["repository"], "example/repo")
        self.assertEqual(seed["issue_number"], 7)
        self.assertEqual(seed["actor"], "author")
        self.assertEqual(seed["branch"], "poise/issue-7")
        self.assertEqual(seed["issue"], read["issue"])
        self.assertEqual(seed["comments"], comments["comments"])
        self.assertEqual(seed["publication"], publication)
        self.assertEqual(seed["comments"], [{"id": 3, "author": "reviewer", "body": "note",
            "created_at": "2026-10-01T00:00:00Z", "updated_at": "2026-10-01T00:00:00Z",
            "url": "https://github.com/example/repo/issues/7#issuecomment-3"}])
        self.assertIsNone(seed["publication"]["pull_number"])

    async def test_facets_share_one_client_and_inspect_without_writing(self):
        mock = client()
        with patch("github_interface.behaviors.chain_seed.read_issue") as read, \
                patch("github_interface.behaviors.chain_seed.issue_comments") as comments, \
                patch("github_interface.behaviors.chain_seed.issue_work") as work:
            read.run = AsyncMock(return_value={"issue": {"number": 7}})
            comments.run = AsyncMock(return_value={"comments": []})
            work.run = AsyncMock(return_value={"pull_number": None})
            work.BRANCH = issue_work.BRANCH
            seed = await chain_seed.run(mock, dict(PAYLOAD))
        read.run.assert_awaited_once_with(mock, PAYLOAD)
        comments.run.assert_awaited_once_with(mock, PAYLOAD)
        work.run.assert_awaited_once_with(mock, {**PAYLOAD, "mode": "inspect"})
        self.assertEqual((seed["issue"], seed["comments"], seed["publication"]),
                         ({"number": 7}, [], {"pull_number": None}))

    async def test_one_facet_failure_fails_the_read_without_a_partial_envelope(self):
        mock = client()
        healthy = mock.paginate.side_effect

        async def failing_paginate(path, params=None):
            if path == "/repos/example/repo/issues/7/comments":
                raise RuntimeError("comments unavailable")
            return await healthy(path, params)

        mock.paginate.side_effect = failing_paginate
        with self.assertRaisesRegex(RuntimeError, "comments unavailable"):
            await chain_seed.run(mock, dict(PAYLOAD))
        mock.post.assert_not_awaited()

    async def test_rejects_a_non_chain_branch_before_any_read(self):
        mock = client()
        with self.assertRaisesRegex(ValueError, "poise/ branch"):
            await chain_seed.run(mock, {**PAYLOAD, "branch": "main"})
        mock.get.assert_not_awaited()
        mock.paginate.assert_not_awaited()
        mock.graphql.assert_not_awaited()

    async def test_rejects_a_missing_actor_before_any_read(self):
        mock = client()
        payload = dict(PAYLOAD)
        del payload["token_user"]
        with self.assertRaises(ValueError):
            await chain_seed.run(mock, payload)
        mock.get.assert_not_awaited()
