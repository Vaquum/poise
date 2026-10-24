from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from github_interface.atoms import pulls
from github_interface.behaviors import mergeable

# The colour Current shows a pull request by (behaviors/mergeable.py).

OPEN = {"state": "open", "draft": False, "mergeable": True, "mergeable_state": "clean"}


def readiness(checks: str | None, threads: list[tuple[bool, bool]], more: bool = False, **fields) -> dict:
    packet = {
        "state": "OPEN",
        "isDraft": False,
        "mergeable": "MERGEABLE",
        "mergeStateStatus": "CLEAN",
        "commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": checks} if checks else None}}]},
        "reviewThreads": {"pageInfo": {"hasNextPage": more},
                          "nodes": [{"isResolved": resolved, "isOutdated": outdated} for resolved, outdated in threads]},
    }
    packet.update(fields)
    return packet


class TestStatus(IsolatedAsyncioTestCase):
    def test_green_only_with_every_check_passed_and_no_open_conversation(self):
        self.assertEqual(mergeable.status(OPEN, "SUCCESS", 0), "green")
        self.assertEqual(mergeable.status(OPEN, None, 0), "green")
        self.assertEqual(mergeable.status({**OPEN, "mergeable_state": "has_hooks"}, "SUCCESS", 0), "green")

    def test_yellow_when_the_merge_button_is_green_but_a_check_or_a_conversation_is_not_done(self):
        self.assertEqual(mergeable.status(OPEN, "SUCCESS", 2), "yellow")
        self.assertEqual(mergeable.status(OPEN, "PENDING", 0), "yellow")
        self.assertEqual(mergeable.status({**OPEN, "mergeable_state": "unstable"}, "FAILURE", 0), "yellow")

    def test_no_colour_without_a_green_merge_button(self):
        for pull in ({**OPEN, "mergeable_state": "blocked"}, {**OPEN, "mergeable_state": "dirty"},
                     {**OPEN, "mergeable": False}, {**OPEN, "draft": True}, {**OPEN, "state": "closed"}):
            with self.subTest(pull=pull):
                self.assertIsNone(mergeable.status(pull, "SUCCESS", 0))

    async def test_counts_only_live_unresolved_conversations(self):
        client = AsyncMock()
        with patch.object(mergeable, "get_pr_readiness_state",
                           AsyncMock(return_value=readiness("SUCCESS", [(True, False), (False, True), (False, False)]))):
            result = await mergeable.run(client, {"repository": "acme/app", "pull_number": "7"})
        self.assertEqual((result["mergeable"], result["checks_state"], result["unresolved_conversations"], result["status"]),
                         (True, "SUCCESS", 1, "yellow"))
        client.get.assert_not_awaited()

    async def test_more_conversations_than_one_read_checks_cannot_show_green(self):
        client = AsyncMock()
        with patch.object(mergeable, "get_pr_readiness_state", AsyncMock(return_value=readiness("SUCCESS", [(True, False)], more=True))):
            result = await mergeable.run(client, {"repository": "acme/app", "pull_number": "7"})
        self.assertEqual((result["unresolved_conversations"], result["status"]), (0, "yellow"))
        client.get.assert_not_awaited()

    async def test_colours_come_from_graphql_alone_with_no_rest_reads(self):
        client = AsyncMock()
        with patch.object(mergeable, "get_pr_readiness_state", AsyncMock(return_value=readiness("SUCCESS", []))):
            result = await mergeable.run(client, {"repository": "acme/app", "pull_number": "7"})
        self.assertEqual(result, {
            "action": "mergeable",
            "repository": "acme/app",
            "pull_number": 7,
            "mergeable": True,
            "github_mergeable": True,
            "github_mergeable_state": "clean",
            "state": "open",
            "draft": False,
            "checks_state": "SUCCESS",
            "unresolved_conversations": 0,
            "status": "green",
            "head_sha": None,
            "review_decision": None,
            "threads_checked": True,
            "queue_enabled": False,
            "has_rollup": True,
            "check_contexts": [],
            "contexts_partial": False,
        })
        client.get.assert_not_awaited()
        client.paginate.assert_not_awaited()
        client.post.assert_not_awaited()

    async def test_computing_mergeability_reports_no_colour_like_rest_did(self):
        with patch.object(mergeable, "get_pr_readiness_state",
                           AsyncMock(return_value=readiness("SUCCESS", [], mergeable="UNKNOWN", mergeStateStatus="UNKNOWN"))):
            result = await mergeable.run(AsyncMock(), {"repository": "acme/app", "pull_number": "7"})
        self.assertEqual((result["mergeable"], result["github_mergeable"],
                          result["github_mergeable_state"], result["status"]),
                         (False, None, "unknown", None))

    async def test_merged_pull_reports_the_closed_state_rest_used(self):
        with patch.object(mergeable, "get_pr_readiness_state",
                           AsyncMock(return_value=readiness("SUCCESS", [], state="MERGED"))):
            result = await mergeable.run(AsyncMock(), {"repository": "acme/app", "pull_number": "7"})
        self.assertEqual((result["state"], result["mergeable"], result["status"]), ("closed", False, None))

    async def test_unknown_mergeable_value_fails_loud(self):
        with patch.object(mergeable, "get_pr_readiness_state",
                           AsyncMock(return_value=readiness("SUCCESS", [], mergeable="STUCK"))):
            with self.assertRaisesRegex(RuntimeError, "unknown mergeable value"):
                await mergeable.run(AsyncMock(), {"repository": "acme/app", "pull_number": "7"})


BEHIND = {"state": "open", "draft": False, "mergeable": True, "mergeable_state": "behind"}


def behind_packet(checks="SUCCESS", threads=(), more=False, **fields):
    packet = {
        "state": "OPEN", "isDraft": False, "mergeable": "MERGEABLE", "mergeStateStatus": "BEHIND",
        "commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": checks} if checks else None}}]},
        "reviewThreads": {"pageInfo": {"hasNextPage": more},
                          "nodes": [{"isResolved": resolved, "isOutdated": outdated} for resolved, outdated in threads]},
    }
    packet.update(fields)
    return packet


class TestBehindStatus(TestCase):
    def test_behind_only_when_out_of_date_and_nothing_else_blocks(self):
        self.assertEqual(mergeable.behind_status(BEHIND, "SUCCESS", 0), "behind")
        self.assertEqual(mergeable.behind_status(BEHIND, None, 0), "behind")

    def test_anything_else_blocking_is_not_behind(self):
        for pull in ({**BEHIND, "mergeable_state": "clean"}, {**BEHIND, "mergeable_state": "blocked"},
                     {**BEHIND, "mergeable_state": "dirty"}, {**BEHIND, "mergeable": False},
                     {**BEHIND, "mergeable": None}, {**BEHIND, "draft": True}, {**BEHIND, "state": "closed"}):
            with self.subTest(pull=pull):
                self.assertIsNone(mergeable.behind_status(pull, "SUCCESS", 0))
        self.assertIsNone(mergeable.behind_status(BEHIND, "PENDING", 0))
        self.assertIsNone(mergeable.behind_status(BEHIND, "FAILURE", 0))
        self.assertIsNone(mergeable.behind_status(BEHIND, "SUCCESS", 1))
        self.assertIsNone(mergeable.behind_status(BEHIND, "SUCCESS", 0, False))

    def test_readiness_behind_tracks_the_green_predicate(self):
        self.assertEqual(mergeable.readiness_behind(behind_packet()), "behind")
        self.assertEqual(mergeable.readiness_behind(behind_packet(checks=None)), "behind")
        for packet in (behind_packet(checks="PENDING"), behind_packet(checks="FAILURE"),
                       behind_packet(threads=[(False, False)]), behind_packet(more=True),
                       behind_packet(state="CLOSED"), behind_packet(isDraft=True),
                       behind_packet(mergeable="CONFLICTING"), behind_packet(mergeable="UNKNOWN"),
                       behind_packet(mergeStateStatus="BLOCKED"), behind_packet(mergeStateStatus="DIRTY"),
                       behind_packet(mergeStateStatus="CLEAN"), behind_packet(mergeStateStatus="UNSTABLE")):
            with self.subTest(packet=packet):
                self.assertIsNone(mergeable.readiness_behind(packet))


def evidence_packet(**fields):
    packet = readiness("FAILURE", [(False, False)], more=True,
                       headRefOid="a" * 40, reviewDecision="REVIEW_REQUIRED",
                       mergeQueue={"id": "queue-1"})
    packet["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"] = {
        "pageInfo": {"hasNextPage": False},
        "nodes": [
            {"__typename": "CheckRun", "name": "browser shard 3", "status": "COMPLETED", "conclusion": "FAILURE"},
            {"__typename": "CheckRun", "name": "lint", "status": "COMPLETED", "conclusion": "SUCCESS"},
            {"__typename": "StatusContext", "context": "deploy", "state": "PENDING"},
        ],
    }
    packet.update(fields)
    return packet


class TestHeldEvidence(IsolatedAsyncioTestCase):
    async def test_evidence_fields_ride_the_same_read(self):
        with patch.object(mergeable, "get_pr_readiness_state", AsyncMock(return_value=evidence_packet())):
            result = await mergeable.run(AsyncMock(), {"repository": "acme/app", "pull_number": "7"})
        self.assertEqual(
            (result["head_sha"], result["review_decision"], result["threads_checked"],
             result["queue_enabled"], result["has_rollup"]),
            ("a" * 40, "REVIEW_REQUIRED", False, True, True))
        self.assertEqual(result["check_contexts"], [
            {"name": "browser shard 3", "status": "COMPLETED", "conclusion": "FAILURE"},
            {"name": "lint", "status": "COMPLETED", "conclusion": "SUCCESS"},
            {"name": "deploy", "status": None, "conclusion": "PENDING"},
        ])
        self.assertFalse(result["contexts_partial"])

    async def test_full_read_is_the_default(self):
        fetch = AsyncMock(return_value=evidence_packet())
        with patch.object(mergeable, "get_pr_readiness_state", fetch):
            await mergeable.run(AsyncMock(), {"repository": "acme/app", "pull_number": "7"})
        self.assertTrue(fetch.call_args[0][4])

    async def test_slim_read_omits_contexts_but_keeps_the_aggregate(self):
        fetch = AsyncMock(return_value=evidence_packet())
        with patch.object(mergeable, "get_pr_readiness_state", fetch):
            result = await mergeable.run(AsyncMock(), {"repository": "acme/app", "pull_number": "7", "no_check_contexts": True})
        self.assertFalse(fetch.call_args[0][4])
        self.assertIsNone(result["check_contexts"])
        self.assertFalse(result["contexts_partial"])
        self.assertEqual(result["checks_state"], "FAILURE")

    async def test_contexts_beyond_one_read_are_partial(self):
        packet = evidence_packet()
        packet["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"]["pageInfo"]["hasNextPage"] = True
        with patch.object(mergeable, "get_pr_readiness_state", AsyncMock(return_value=packet)):
            result = await mergeable.run(AsyncMock(), {"repository": "acme/app", "pull_number": "7"})
        self.assertTrue(result["contexts_partial"])
        self.assertEqual(len(result["check_contexts"]), 3)

    async def test_missing_rollup_is_reported(self):
        with patch.object(mergeable, "get_pr_readiness_state", AsyncMock(return_value=readiness(None, []))):
            result = await mergeable.run(AsyncMock(), {"repository": "acme/app", "pull_number": "7"})
        self.assertEqual((result["has_rollup"], result["checks_state"], result["check_contexts"]),
                         (False, None, []))


class TestNormalizeCheckContexts(TestCase):
    def test_check_run_and_legacy_status_share_one_shape(self):
        self.assertEqual(mergeable.normalize_check_contexts({"nodes": [
            {"__typename": "CheckRun", "name": "test", "status": "IN_PROGRESS", "conclusion": None},
            {"__typename": "StatusContext", "context": "docs", "state": "SUCCESS"},
        ]}), [
            {"name": "test", "status": "IN_PROGRESS", "conclusion": None},
            {"name": "docs", "status": None, "conclusion": "SUCCESS"},
        ])

    def test_malformed_context_fails_loud(self):
        with self.assertRaisesRegex(RuntimeError, "malformed check context"):
            mergeable.normalize_check_contexts({"nodes": ["test"]})
        with self.assertRaisesRegex(RuntimeError, "without a name"):
            mergeable.normalize_check_contexts({"nodes": [{"__typename": "CheckRun", "status": "COMPLETED"}]})


class TestReadinessQuery(IsolatedAsyncioTestCase):
    def test_contexts_selected_only_when_asked(self):
        self.assertIn("contexts(first: 100)", pulls.readiness_query(True))
        self.assertIn("StatusContext", pulls.readiness_query(True))
        self.assertNotIn("contexts(", pulls.readiness_query(False))
        self.assertEqual(pulls.readiness_query(False), pulls.readiness_query())

    async def test_slim_flag_reaches_the_query(self):
        client = AsyncMock()
        client.graphql = AsyncMock(return_value={"repository": {"pullRequest": {"id": "1"}}})
        await pulls.get_pr_readiness_state(client, "acme", "app", 7, include_contexts=False)
        self.assertNotIn("contexts(", client.graphql.call_args[0][0])
        await pulls.get_pr_readiness_state(client, "acme", "app", 7, include_contexts=True)
        self.assertIn("contexts(first: 100)", client.graphql.call_args[0][0])
