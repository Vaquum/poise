from unittest import TestCase
from unittest.mock import patch

import agent_interface


class TestGovernedOutcomes(TestCase):
    def test_outcome_facts_allow_a_newer_current_head(self) -> None:
        expected_head = "a" * 40
        actual_head = "b" * 40
        facts = {
            "action": "review_activity_since",
            "repository": "Vaquum/repo",
            "pull_number": 68,
            "username": "bit-mis",
            "head_sha": actual_head,
            "state": "OPEN",
            "draft": False,
        }

        agent_interface._validate_outcome_facts(
            facts,
            "68",
            "Vaquum/repo",
            "bit-mis",
            expected_head,
        )

    def test_review_requires_one_terminal_github_review(self) -> None:
        facts = self._facts()

        with patch.object(agent_interface, "review_facts", return_value=facts):
            with self.assertRaisesRegex(RuntimeError, "exactly one atomic"):
                agent_interface.behavior_outcome(
                    object(), "pr_review", "68", "/tmp", "bit-mis", "a" * 40, facts
                )

    def test_review_accepts_explicit_clean_review_on_expected_head(self) -> None:
        before = self._facts()
        after = self._facts(
            reviewer_comments_since=1,
            reviewer_latest_any_state="COMMENTED",
            reviewer_latest_any_commit="a" * 40,
            reviewer_latest_any_review_id="R_clean",
            reviewer_latest_any_submitted_at="2026-07-21T12:00:00Z",
        )

        with patch.object(agent_interface, "review_facts", return_value=after):
            result = agent_interface.behavior_outcome(
                object(), "pr_review", "68", "/tmp", "bit-mis", "a" * 40, before
            )

        self.assertEqual(result["action"], "reviewed_clean")
        self.assertEqual(result["outcome"], "clean")

    def test_review_rejects_clean_review_on_wrong_head(self) -> None:
        before = self._facts()
        after = self._facts(
            reviewer_comments_since=1,
            reviewer_latest_any_state="COMMENTED",
            reviewer_latest_any_commit="b" * 40,
            reviewer_latest_any_review_id="R_clean",
            reviewer_latest_any_submitted_at="2026-07-21T12:00:00Z",
        )

        with patch.object(agent_interface, "review_facts", return_value=after):
            with self.assertRaisesRegex(RuntimeError, "expected head"):
                agent_interface.behavior_outcome(
                    object(), "pr_review", "68", "/tmp", "bit-mis", "a" * 40, before
                )

    def test_review_is_superseded_when_pull_merges_during_run(self) -> None:
        before = self._facts()
        after = self._facts(state="MERGED")

        with patch.object(agent_interface, "review_facts", return_value=after):
            result = agent_interface.behavior_outcome(
                object(), "pr_review", "68", "/tmp", "bit-mis", "a" * 40, before
            )

        self.assertEqual(
            result,
            {"action": None, "outcome": "superseded", "head_sha": "a" * 40},
        )

    def test_review_is_superseded_when_head_changes_during_run(self) -> None:
        before = self._facts()
        after = self._facts(head_sha="b" * 40)

        with patch.object(agent_interface, "review_facts", return_value=after):
            result = agent_interface.behavior_outcome(
                object(), "pr_review", "68", "/tmp", "bit-mis", "a" * 40, before
            )

        self.assertEqual(
            result,
            {"action": None, "outcome": "superseded", "head_sha": "b" * 40},
        )

    def test_posted_change_request_wins_over_a_moved_head(self) -> None:
        for behavior in ("pr_review", "pr_approve"):
            with self.subTest(behavior=behavior):
                before = self._facts(reviewer_reviews_since_items=[])
                after = self._facts(
                    head_sha="b" * 40,
                    reviewer_reviews_since_items=[
                        self._item(91, state="CHANGES_REQUESTED", commit="a" * 40)
                    ],
                )
                receipt = {"action": "requested_changes", "review_id": 91, "head_sha": "a" * 40}

                with patch.object(agent_interface, "review_facts", return_value=after):
                    result = agent_interface.behavior_outcome(
                        object(), behavior, "68", "/tmp", "bit-mis", "a" * 40,
                        before, receipt=receipt, call_id="call-1",
                    )

                self.assertEqual(result, {
                    "action": "requested_changes",
                    "outcome": "changes_requested",
                    "head_sha": "a" * 40,
                })

    def test_posted_approval_wins_over_a_moved_head(self) -> None:
        before = self._facts(reviewer_reviews_since_items=[])
        after = self._facts(
            head_sha="b" * 40,
            reviewer_reviews_since_items=[
                self._item(92, state="APPROVED", commit="a" * 40)
            ],
        )
        receipt = {"action": "approved_pr", "review_id": 92, "head_sha": "a" * 40}

        with patch.object(agent_interface, "review_facts", return_value=after):
            result = agent_interface.behavior_outcome(
                object(), "pr_approve", "68", "/tmp", "bit-mis", "a" * 40,
                before, receipt=receipt, call_id="call-1",
            )

        self.assertEqual(result, {
            "action": "approved", "outcome": "approved", "head_sha": "a" * 40,
        })

    def test_clean_supersede_with_no_posted_review_is_unchanged(self) -> None:
        before = self._facts(reviewer_reviews_since_items=[])
        after = self._facts(head_sha="b" * 40, reviewer_reviews_since_items=[])

        with patch.object(agent_interface, "review_facts", return_value=after):
            result = agent_interface.behavior_outcome(
                object(), "pr_approve", "68", "/tmp", "bit-mis", "a" * 40, before
            )

        self.assertEqual(result, {
            "action": None, "outcome": "superseded", "head_sha": "b" * 40,
        })

    def test_dismissed_change_request_keeps_its_original_kind(self) -> None:
        for head in ("a" * 40, "b" * 40):
            with self.subTest(head=head):
                before = self._facts(reviewer_reviews_since_items=[])
                after = self._facts(
                    head_sha=head,
                    reviewer_reviews_since_items=[
                        self._item(91, state="DISMISSED", commit="a" * 40)
                    ],
                )
                receipt = {"action": "requested_changes", "review_id": 91, "head_sha": "a" * 40}

                with patch.object(agent_interface, "review_facts", return_value=after):
                    result = agent_interface.behavior_outcome(
                        object(), "pr_approve", "68", "/tmp", "bit-mis", "a" * 40,
                        before, receipt=receipt, call_id="call-1",
                    )

                self.assertEqual(result, {
                    "action": "requested_changes",
                    "outcome": "changes_requested",
                    "head_sha": "a" * 40,
                })

    def test_dismissed_approval_on_a_moved_head_is_a_typed_release(self) -> None:
        from agent_interface import review_budget

        before = self._facts(reviewer_reviews_since_items=[])
        after = self._facts(
            head_sha="b" * 40,
            reviewer_reviews_since_items=[
                self._item(92, state="DISMISSED", commit="a" * 40)
            ],
        )
        receipt = {"action": "approved_pr", "review_id": 92, "head_sha": "a" * 40}

        with patch.object(agent_interface, "review_facts", return_value=after):
            with self.assertRaises(review_budget.ReviewLimitError) as raised:
                agent_interface.behavior_outcome(
                    object(), "pr_approve", "68", "/tmp", "bit-mis", "a" * 40,
                    before, receipt=receipt, call_id="call-1",
                )
        self.assertEqual(raised.exception.code, "approval_dismissed_stale")

    def test_dismissed_approval_on_an_unchanged_head_fails_loudly(self) -> None:
        before = self._facts(reviewer_reviews_since_items=[])
        after = self._facts(
            reviewer_reviews_since_items=[
                self._item(92, state="DISMISSED", commit="a" * 40)
            ],
        )
        receipt = {"action": "approved_pr", "review_id": 92, "head_sha": "a" * 40}

        with patch.object(agent_interface, "review_facts", return_value=after):
            with self.assertRaisesRegex(RuntimeError, "dismissed before verification"):
                agent_interface.behavior_outcome(
                    object(), "pr_approve", "68", "/tmp", "bit-mis", "a" * 40,
                    before, receipt=receipt, call_id="call-1",
                )

    def test_interrupted_run_adopts_a_posted_review_on_a_moved_head(self) -> None:
        import subprocess as process
        from types import SimpleNamespace

        from agent_interface import pr_review
        from agent_interface import review_receipt

        before = self._facts(reviewer_reviews_since_items=[])
        after = self._facts(
            head_sha="b" * 40,
            reviewer_reviews_since_items=[
                self._item(91, state="CHANGES_REQUESTED", commit="a" * 40)
            ],
        )
        receipt = {"action": "requested_changes", "review_id": 91, "head_sha": "a" * 40}
        spec = SimpleNamespace(identity="model-a", provider="codex")
        recovery = SimpleNamespace(identity="model-b", provider="codex")

        def expired(*args, **kwargs):
            raise process.TimeoutExpired("codex", 60)

        with patch.object(pr_review, "run", side_effect=expired), \
                patch.object(agent_interface, "review_facts", return_value=after):
            review_receipt._current.set(receipt)
            try:
                response, result = agent_interface._run_review_with_recovery(
                    pr_review, "pr_review", "68", "/tmp", "bit-mis", "a" * 40,
                    "", 60, None, spec, recovery, before, "call-1",
                )
            finally:
                review_receipt._current.set(None)

        self.assertIn("time limit", response)
        self.assertEqual(result, {
            "action": "requested_changes",
            "outcome": "changes_requested",
            "head_sha": "a" * 40,
        })

    @staticmethod
    def _item(review_id: int, state: str, commit: str) -> dict:
        return {
            "id": review_id,
            "node_id": f"node-{review_id}",
            "state": state,
            "commit": commit,
            "submitted_at": "2026-10-25T13:51:24Z",
        }

    @staticmethod
    def _facts(**updates):
        facts = {
            "state": "OPEN",
            "draft": False,
            "head_sha": "a" * 40,
            "reviewer_change_requests_since": 0,
            "reviewer_approvals_since": 0,
            "reviewer_comments_since": 0,
            "reviewer_latest_review_id": None,
            "reviewer_latest_any_review_id": None,
        }
        facts.update(updates)
        return facts

class TestPreflightLogContract(TestCase):
    def test_failure_code_survives_database_and_logs_with_no_action_proof(self):
        import io
        import json
        import tempfile
        from contextlib import redirect_stdout
        from pathlib import Path

        from agent_interface import atoms, pr_review

        for code in (None, "review_packet_too_large"):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as directory, \
                    patch.object(agent_interface, 'DB', Path(directory) / 'calls.sqlite3'), \
                    patch.object(agent_interface, 'RESPONSES', Path(directory) / 'responses'), \
                    patch.object(agent_interface, 'review_facts', return_value={}), \
                    patch.object(pr_review, 'run', side_effect=atoms.AgentPreflightError('preflight failure', code)):
                agent_interface.init_db()
                output = io.StringIO()
                with redirect_stdout(output), self.assertRaises(SystemExit):
                    agent_interface.run_governed_behavior(
                        pr_review, 'pr_review', 'https://github.com/o/r/pull/1',
                        actor='bit-mis', expected_head='a' * 40,
                        source='poise:review-new-prs', correlation_id='test-packet', pwd=directory,
                    )
                row = agent_interface.logs()[0]
                self.assertEqual(row['error_code'], code)
                self.assertEqual(row['action'], 'not_started')
                self.assertEqual(row['outcome'], 'preflight_failed')
                self.assertIsNone(row['head_sha'])
                self.assertEqual(row['expected_head'], 'a' * 40)
                self.assertEqual(row['correlation_id'], 'test-packet')
                self.assertEqual(json.loads(output.getvalue())['error_code'], code)
