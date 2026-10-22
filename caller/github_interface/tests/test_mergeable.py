from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from github_interface.behaviors import mergeable

# The colour Current shows a pull request by (behaviors/mergeable.py).

OPEN = {"state": "open", "draft": False, "mergeable": True, "mergeable_state": "clean"}


def readiness(checks: str | None, threads: list[tuple[bool, bool]], more: bool = False) -> dict:
    return {
        "commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": checks} if checks else None}}]},
        "reviewThreads": {"pageInfo": {"hasNextPage": more},
                          "nodes": [{"isResolved": resolved, "isOutdated": outdated} for resolved, outdated in threads]},
    }


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
        client = object()
        with patch.object(mergeable, "get_pull", AsyncMock(return_value=OPEN)), \
                patch.object(mergeable, "get_pr_readiness_state",
                             AsyncMock(return_value=readiness("SUCCESS", [(True, False), (False, True), (False, False)]))):
            result = await mergeable.run(client, {"repository": "acme/app", "pull_number": "7"})
        self.assertEqual((result["mergeable"], result["checks_state"], result["unresolved_conversations"], result["status"]),
                         (True, "SUCCESS", 1, "yellow"))

    async def test_more_conversations_than_one_read_checks_cannot_show_green(self):
        with patch.object(mergeable, "get_pull", AsyncMock(return_value=OPEN)), \
                patch.object(mergeable, "get_pr_readiness_state", AsyncMock(return_value=readiness("SUCCESS", [(True, False)], more=True))):
            result = await mergeable.run(object(), {"repository": "acme/app", "pull_number": "7"})
        self.assertEqual((result["unresolved_conversations"], result["status"]), (0, "yellow"))


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
