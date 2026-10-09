from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

from github_interface.behaviors import mergeable

# The colour Current shows a pull request by (behaviors/mergeable.py).

OPEN = {"state": "open", "draft": False, "mergeable": True, "mergeable_state": "clean"}


def readiness(checks: str | None, threads: list[tuple[bool, bool]]) -> dict:
    return {
        "commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": checks} if checks else None}}]},
        "reviewThreads": {"nodes": [{"isResolved": resolved, "isOutdated": outdated} for resolved, outdated in threads]},
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
