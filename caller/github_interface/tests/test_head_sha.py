from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock

from github_interface.behaviors import head_sha

HEAD = "a" * 40
PULL = {"head": {"sha": HEAD}, "state": "open", "merged": False, "user": {"login": "author"}}
PAYLOAD = {"repository": "o/r", "pr": "12", "token_user": "reviewer"}


class TestHeadSha(IsolatedAsyncioTestCase):
    async def test_state_comes_from_the_existing_single_pull_read(self):
        for state, merged, expected in (("open", False, "OPEN"), ("closed", False, "CLOSED"), ("closed", True, "MERGED")):
            with self.subTest(state=expected):
                client = AsyncMock()
                client.get.return_value = {**PULL, "state": state, "merged": merged}
                self.assertEqual(await head_sha.run(client, PAYLOAD), {
                    "action": "head_sha", "repository": "o/r", "pull_number": 12,
                    "head_sha": HEAD, "state": expected, "author": "author",
                })
                client.get.assert_awaited_once_with("/repos/o/r/pulls/12")
                client.graphql.assert_not_awaited()

    async def test_missing_malformed_or_contradictory_state_is_not_authoritative(self):
        for change in ({"state": None}, {"state": {}}, {"state": "unknown"}, {"merged": None},
                       {"merged": "true"}, {"merged": True}, {"head": {"sha": "z" * 40}}):
            with self.subTest(change=change):
                client = AsyncMock()
                client.get.return_value = {**PULL, **change}
                with self.assertRaises(RuntimeError):
                    await head_sha.run(client, PAYLOAD)
