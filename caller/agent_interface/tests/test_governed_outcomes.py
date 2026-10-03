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
