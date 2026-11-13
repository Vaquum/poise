from copy import deepcopy
from datetime import datetime, timezone
from io import StringIO
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from github_interface import cli
from github_interface.behaviors import close_old_pr_if_ready as close
from github_interface.identity import AGENT, PERSON

CUTOFF = datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp() * 1000
PAYLOAD = {"repository": "acme/app", "pr": "#7", "author": "octocat", "token_user": "review-bot", "cutoff_ms": CUTOFF}
PULL = {"number": 7, "state": "open", "merged": False, "draft": False,
        "user": {"login": "octocat"}, "created_at": "2026-01-01T00:00:00Z"}
CLOSED = {**PULL, "state": "closed"}


class TestCloseOldPull(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        accounts = patch.dict("os.environ", {PERSON: "octocat", AGENT: "review-bot"})
        accounts.start()
        self.addCleanup(accounts.stop)
        self.client = AsyncMock()
        self.client.patch.return_value = deepcopy(CLOSED)
        self.pull = AsyncMock(return_value=deepcopy(PULL))
        reads = patch.object(close, "get_pull", self.pull)
        reads.start()
        self.addCleanup(reads.stop)

    async def run_close(self, **fields):
        return await close.run(self.client, {**PAYLOAD, **fields})

    async def test_at_cutoff_closes_and_validates_the_receipt(self):
        result = await self.run_close()
        self.assertEqual((result["outcome"], result["state"], result["merged"]), ("closed", "closed", False))
        self.client.patch.assert_awaited_once_with("/repos/acme/app/pulls/7", json={"state": "closed"})
        self.pull.assert_awaited_once()

    async def test_below_cutoff_and_each_live_eligibility_refusal_leave_open(self):
        for fields in ({"created_at": "2026-01-01T00:00:00.001Z"}, {"draft": True}, {"draft": None},
                       {"user": {"login": "stranger"}}, {"user": None}, {"state": None}):
            with self.subTest(fields=fields):
                self.pull.return_value = {**PULL, **fields}
                self.assertEqual((await self.run_close())["outcome"], "not_ready")
                self.client.patch.assert_not_awaited()

    async def test_closed_or_merged_between_discovery_and_dispatch_is_noop(self):
        for fields in ({"state": "closed"}, {"merged": True}):
            self.pull.return_value = {**PULL, **fields}
            self.assertEqual((await self.run_close())["outcome"], "already_closed")
            self.client.patch.assert_not_awaited()

    async def test_unknown_invalid_naive_or_future_creation_time_fails_without_updated_at_fallback(self):
        for created in (None, "invalid", "2020-01-01", "2999-01-01T00:00:00Z"):
            with self.subTest(created=created):
                self.pull.return_value = {**PULL, "created_at": created, "updated_at": "2020-01-01T00:00:00Z"}
                with self.assertRaisesRegex(RuntimeError, "created_at"):
                    await self.run_close()
                self.client.patch.assert_not_awaited()

    async def test_pair_and_opposite_actor_are_required(self):
        for fields in ({"author": "stranger"}, {"token_user": "octocat"}):
            with self.assertRaisesRegex(ValueError, "author pair"):
                await self.run_close(**fields)
        with patch.dict("os.environ", {AGENT: "octocat"}), self.assertRaisesRegex(ValueError, "author pair"):
            await self.run_close()
        self.client.patch.assert_not_awaited()

    async def test_case_insensitive_pair_accepts_both_author_directions(self):
        self.pull.return_value = {**PULL, "user": {"login": "REVIEW-BOT"}}
        self.assertEqual((await self.run_close(author="Review-Bot", token_user="Octocat"))["outcome"], "closed")

    async def test_invalid_cutoff_never_writes(self):
        for cutoff in (None, True, "broken", float("nan"), float("inf"), 10**16):
            with self.subTest(cutoff=cutoff), self.assertRaisesRegex(ValueError, "cutoff-ms"):
                await self.run_close(cutoff_ms=cutoff)
        self.client.patch.assert_not_awaited()

    async def test_missing_or_contradictory_receipts_never_count_as_closed(self):
        for receipt in (None, {}, {**CLOSED, "state": "open"}, {**CLOSED, "merged": True},
                        {**CLOSED, "merged": None}, {**CLOSED, "number": 8}):
            with self.subTest(receipt=receipt):
                self.client.patch.return_value = receipt
                with self.assertRaisesRegex(RuntimeError, "did not confirm"):
                    await self.run_close()

    async def test_lost_write_reads_once_and_adopts_only_confirmed_close(self):
        self.client.patch.side_effect = RuntimeError("connection lost")
        self.pull.side_effect = [deepcopy(PULL), deepcopy(CLOSED)]
        self.assertEqual((await self.run_close())["outcome"], "closed")
        self.assertEqual(self.pull.await_count, 2)
        self.client.patch.assert_awaited_once()

    async def test_lost_write_without_close_confirmation_stays_failed(self):
        self.client.patch.side_effect = RuntimeError("connection lost")
        for receipt in (PULL, {**CLOSED, "merged": True}, {**CLOSED, "number": 8}):
            with self.subTest(receipt=receipt):
                self.pull.side_effect = [deepcopy(PULL), deepcopy(receipt)]
                with self.assertRaises(RuntimeError):
                    await self.run_close()
        self.assertEqual(self.client.patch.await_count, 3)
        self.assertEqual(self.pull.await_count, 6)

    async def test_live_read_errors_and_permission_failures_stay_visible(self):
        self.pull.side_effect = RuntimeError("GitHub 404: Not Found")
        with self.assertRaisesRegex(RuntimeError, "404"):
            await self.run_close()
        self.client.patch.assert_not_awaited()
        self.pull.side_effect = None
        self.client.patch.side_effect = RuntimeError("GitHub 403: Forbidden")
        with self.assertRaisesRegex(RuntimeError, "403"):
            await self.run_close()


class TestCloseCLI(TestCase):
    def test_dispatches_the_narrow_operation(self):
        operation = AsyncMock(return_value={"outcome": "closed"})
        with patch.object(cli, "close_old_pr_if_ready", operation), patch("sys.stdout", new_callable=StringIO), \
                patch("sys.argv", ["github-interface", "--close-old-pr-if-ready", "#7", "--repository", "acme/app",
                                   "--cutoff-ms", str(CUTOFF), "--author", "octocat", "--token-user", "review-bot"]):
            cli.main()
        operation.assert_awaited_once_with(PAYLOAD)
