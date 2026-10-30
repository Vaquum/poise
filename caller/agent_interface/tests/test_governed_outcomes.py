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
            {key: result[key] for key in ("action", "outcome", "head_sha")},
            {"action": None, "outcome": "superseded", "head_sha": "a" * 40},
        )
        self.assertEqual(result["error_code"], "review_target_closed")
        self.assertIn("publication state unknown", result["diagnostic"]["message"])

    def test_legacy_counter_closure_retains_failure_and_unknown_publication(self) -> None:
        for state in ("CLOSED", "MERGED"):
            for behavior in ("pr_review", "pr_approve"):
                with self.subTest(state=state, behavior=behavior):
                    before = self._facts()
                    after = self._facts(state=state, reviewer_approvals_since=1)
                    result = agent_interface.behavior_outcome(
                        object(), behavior, "68", "/tmp", "bit-mis", "a" * 40,
                        before, facts=after, prior_error="review submission timed out",
                    )
                    self.assertEqual(result["outcome"], "superseded")
                    self.assertEqual(result["error_code"], "review_target_closed")
                    self.assertIn("review submission timed out", result["error"])
                    self.assertIn("publication state unknown", result["diagnostic"]["message"])

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

    def test_interrupted_run_keeps_a_stale_dismissal_typed(self) -> None:
        import subprocess as process
        from types import SimpleNamespace

        from agent_interface import pr_approve, review_budget
        from agent_interface import review_receipt

        before = self._facts(reviewer_reviews_since_items=[])
        after = self._facts(
            head_sha="b" * 40,
            reviewer_reviews_since_items=[
                self._item(92, state="DISMISSED", commit="a" * 40)
            ],
        )
        receipt = {"action": "approved_pr", "review_id": 92, "head_sha": "a" * 40}
        spec = SimpleNamespace(identity="model-a", provider="codex")
        recovery = SimpleNamespace(identity="model-b", provider="codex")

        def expired(*args, **kwargs):
            raise process.TimeoutExpired("codex", 60)

        with patch.object(pr_approve, "run", side_effect=expired), \
                patch.object(agent_interface, "review_facts", return_value=after):
            review_receipt._current.set(receipt)
            try:
                with self.assertRaises(review_budget.ReviewLimitError) as raised:
                    agent_interface._run_review_with_recovery(
                        pr_approve, "pr_approve", "68", "/tmp", "bit-mis", "a" * 40,
                        "", 60, None, spec, recovery, before, "call-1",
                    )
            finally:
                review_receipt._current.set(None)

        self.assertEqual(raised.exception.code, "approval_dismissed_stale")

    def test_blocked_approval_never_adopts_another_request_review(self) -> None:
        from types import SimpleNamespace

        from agent_interface import pr_approve, review_budget
        from agent_interface import review_receipt

        before = self._facts(reviewer_reviews_since_items=[])
        after = self._facts(
            reviewer_reviews_since_items=[
                self._item(92, state="APPROVED", commit="a" * 40)
            ],
        )
        failure = review_budget.ReviewLimitError(
            "approval blocked by unresolved review conversations: "
            "error: 1 unresolved review conversation(s) from other reviewers remain",
            "approval_blocked_unresolved_conversations")
        spec = SimpleNamespace(identity="model-a", provider="codex")
        recovery = SimpleNamespace(identity="model-b", provider="codex")

        def blocked(*args, **kwargs):
            raise failure

        with patch.object(pr_approve, "run", side_effect=blocked), \
                patch.object(agent_interface, "review_facts", return_value=after):
            review_receipt._current.set(None)
            try:
                with self.assertRaises(review_budget.ReviewLimitError) as raised:
                    agent_interface._run_review_with_recovery(
                        pr_approve, "pr_approve", "68", "/tmp", "bit-mis", "a" * 40,
                        "", 60, None, spec, recovery, before, "call-1",
                    )
            finally:
                review_receipt._current.set(None)

        self.assertIs(raised.exception, failure)
        self.assertEqual(raised.exception.code, "approval_blocked_unresolved_conversations")

    def test_blocked_approval_supersede_keeps_the_original_disposition(self) -> None:
        from types import SimpleNamespace

        from agent_interface import pr_approve, review_budget
        from agent_interface import review_receipt

        before = self._facts(reviewer_reviews_since_items=[])
        after = self._facts(head_sha="b" * 40, reviewer_reviews_since_items=[])
        failure = review_budget.ReviewLimitError(
            "approval blocked by unresolved review conversations: "
            "error: 1 unresolved review conversation(s) from other reviewers remain",
            "approval_blocked_unresolved_conversations")
        spec = SimpleNamespace(identity="model-a", provider="codex")
        recovery = SimpleNamespace(identity="model-b", provider="codex")

        def blocked(*args, **kwargs):
            raise failure

        with patch.object(pr_approve, "run", side_effect=blocked), \
                patch.object(agent_interface, "review_facts", return_value=after):
            review_receipt._current.set(None)
            try:
                response, result = agent_interface._run_review_with_recovery(
                    pr_approve, "pr_approve", "68", "/tmp", "bit-mis", "a" * 40,
                    "", 60, None, spec, recovery, before, "call-1",
                )
            finally:
                review_receipt._current.set(None)

        self.assertIn("blocked", response)
        self.assertEqual(result, {
            "action": None,
            "outcome": "superseded",
            "head_sha": "b" * 40,
            "error": str(failure),
            "error_code": "approval_blocked_unresolved_conversations",
        })

    def test_rejected_submission_never_adopts_another_request_approval(self) -> None:
        import sqlite3
        import tempfile
        from pathlib import Path
        from time import time
        from types import SimpleNamespace

        from agent_interface import pr_approve, review_budget
        from agent_interface import review_receipt

        before = self._facts(reviewer_reviews_since_items=[])
        after = self._facts(
            head_sha="b" * 40,
            reviewer_reviews_since_items=[
                self._item(92, state="APPROVED", commit="a" * 40)
            ],
        )
        failure = review_budget.ReviewLimitError(
            "review submission rejected: error: GitHub 422: line not in diff",
            "review_contract_violation", {"submission": "rejected"})
        spec = SimpleNamespace(identity="model-a", provider="codex")
        recovery = SimpleNamespace(identity="model-b", provider="codex")

        def rejected(*args, **kwargs):
            raise failure

        with tempfile.TemporaryDirectory() as directory, \
                patch.object(agent_interface, 'DB', Path(directory) / 'calls.sqlite3'), \
                patch.object(agent_interface, 'sleep'), \
                patch.object(pr_approve, "run", side_effect=rejected), \
                patch.object(agent_interface, "review_facts", return_value=after):
            agent_interface.init_db()
            with sqlite3.connect(Path(directory) / 'calls.sqlite3', timeout=30) as conn:
                conn.execute(
                    "insert into calls(id, started_at, actor, repo, pr_id, behavior, status)"
                    " values (?,?,?,?,?,?,?)",
                    ("call-1", time(), "bit-mis", "o/r", "68", "pr_approve", "running"))
            review_receipt._current.set(None)
            try:
                response, result = agent_interface._run_review_with_recovery(
                    pr_approve, "pr_approve", "68", "/tmp", "bit-mis", "a" * 40,
                    "", 60, None, spec, recovery, before, "call-1",
                )
            finally:
                review_receipt._current.set(None)

        self.assertIn("line not in diff", response)
        self.assertEqual(result, {
            "action": None,
            "outcome": "superseded",
            "head_sha": "b" * 40,
            "error": str(failure),
            "error_code": "review_contract_violation",
        })

    def test_blocked_marker_settles_an_approval_without_a_review(self) -> None:
        from agent_interface import review_budget, review_receipt

        line = "error: 1 unresolved review conversation(s) from other reviewers remain"
        before = self._facts(reviewer_reviews_since_items=[])
        after = self._facts(reviewer_reviews_since_items=[])
        review_receipt._failure.set(None)
        review_receipt._blocked.set(line)
        try:
            with self.assertRaises(review_budget.ReviewLimitError) as raised:
                agent_interface.behavior_outcome(
                    object(), "pr_approve", "68", "/tmp", "bit-mis", "a" * 40,
                    before, facts=after,
                )
        finally:
            review_receipt._blocked.set(None)
        self.assertEqual(raised.exception.code, "approval_blocked_unresolved_conversations")
        self.assertIn(line, str(raised.exception))

    def test_uncertain_submission_wins_over_a_blocked_marker(self) -> None:
        from agent_interface import review_receipt

        before = self._facts(reviewer_reviews_since_items=[])
        after = self._facts(reviewer_reviews_since_items=[])
        review_receipt._failure.set("httpx.ReadTimeout: timed out")
        review_receipt._blocked.set("error: 1 unresolved review conversation(s) from other reviewers remain")
        try:
            with self.assertRaises(review_receipt.SubmissionError):
                agent_interface.behavior_outcome(
                    object(), "pr_approve", "68", "/tmp", "bit-mis", "a" * 40,
                    before, facts=after,
                )
        finally:
            review_receipt._failure.set(None)
            review_receipt._blocked.set(None)

    def test_blocked_marker_settles_the_legacy_counter_path(self) -> None:
        from agent_interface import review_budget, review_receipt

        line = "error: 1 unresolved review conversation(s) from other reviewers remain"
        before = self._facts()
        after = self._facts()
        review_receipt._failure.set(None)
        review_receipt._blocked.set(line)
        try:
            with self.assertRaises(review_budget.ReviewLimitError) as raised:
                agent_interface.behavior_outcome(
                    object(), "pr_approve", "68", "/tmp", "bit-mis", "a" * 40,
                    before, facts=after,
                )
        finally:
            review_receipt._blocked.set(None)
        self.assertEqual(raised.exception.code, "approval_blocked_unresolved_conversations")

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

class TestClosedTargetSettle(TestCase):
    def test_preparation_settles_when_target_already_closed(self) -> None:
        import io
        import json
        import tempfile
        from contextlib import redirect_stdout
        from pathlib import Path

        from agent_interface import pr_review

        before = self._facts(state="MERGED", reviewer_reviews_since_items=[])
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(agent_interface, 'DB', Path(directory) / 'calls.sqlite3'), \
                patch.object(agent_interface, 'RESPONSES', Path(directory) / 'responses'), \
                patch.object(agent_interface, 'review_facts', return_value=before), \
                patch.object(pr_review, 'run') as provider:
            agent_interface.init_db()
            output = io.StringIO()
            with redirect_stdout(output):
                agent_interface.run_governed_behavior(
                    pr_review, 'pr_review', 'https://github.com/o/r/pull/68',
                    actor='bit-mis', expected_head='a' * 40,
                    source='poise:review-new-prs', correlation_id='test-closed-prep', pwd=directory,
                )
            provider.assert_not_called()
            row = agent_interface.logs()[0]
            self.assertEqual(row['status'], 'superseded')
            self.assertEqual(row['outcome'], 'superseded')
            self.assertIsNone(row['action'])
            self.assertEqual(row['head_sha'], 'a' * 40)
            self.assertEqual(row['error_code'], 'review_target_closed')
            self.assertIn('MERGED', row['error'])
            self.assertIn('provider never ran', row['error'])
            self.assertIsNone(row['review_id'])
            printed = json.loads(output.getvalue())
            self.assertEqual(printed['outcome'], 'superseded')
            self.assertEqual(printed['error_code'], 'review_target_closed')
            diagnostic = row['diagnostic']
            self.assertEqual(
                (diagnostic['operation'], diagnostic['phase'], diagnostic['outcome']),
                ('review.verify', 'preparing', 'target_closed'))
            self.assertEqual(
                (diagnostic['repository'], diagnostic['pr'], diagnostic['reviewer'],
                 diagnostic['behavior'], diagnostic['expected_head']),
                ('o/r', '68', 'bit-mis', 'pr_review', 'a' * 40))

    def test_failed_provider_run_settles_when_target_closed(self) -> None:
        import subprocess as process
        import tempfile
        from pathlib import Path
        from types import SimpleNamespace

        from agent_interface import pr_review

        before = self._facts(reviewer_reviews_since_items=[])
        after = self._facts(
            state="MERGED",
            reviewer_reviews_since_items=[self._item(77, state="APPROVED", commit="a" * 40)],
        )
        spec = SimpleNamespace(identity="model-a", provider="codex")
        recovery = SimpleNamespace(identity="model-b", provider="codex")

        def expired(*args, **kwargs):
            raise process.TimeoutExpired("codex", 60)

        with tempfile.TemporaryDirectory() as directory, \
                patch.object(agent_interface, 'DB', Path(directory) / 'calls.sqlite3'), \
                patch.object(agent_interface, 'sleep'), \
                patch.object(pr_review, "run", side_effect=expired), \
                patch.object(agent_interface, "review_facts", return_value=after):
            agent_interface.init_db()
            response, result = agent_interface._run_review_with_recovery(
                pr_review, "pr_review", "68", "/tmp", "bit-mis", "a" * 40,
                "", 60, None, spec, recovery, before, "call-1",
            )

        self.assertIn("time limit", response)
        self.assertEqual(result["outcome"], "superseded")
        self.assertIsNone(result["action"])
        self.assertEqual(result["error_code"], "review_target_closed")
        self.assertIn("time limit", result["error"])
        self.assertIn("target MERGED", result["error"])
        self.assertIn("unexpected approval", result["error"])
        self.assertIn("77/APPROVED", result["error"])
        self.assertIn("receipt=none", result["error"])

    def test_reconciliation_settles_unattributable_reviews_on_a_closed_target(self) -> None:
        import tempfile
        from pathlib import Path

        from agent_interface import review_receipt

        before = self._facts(reviewer_reviews_since_items=[])
        after = self._facts(
            state="CLOSED",
            reviewer_reviews_since_items=[self._item(78, state="APPROVED", commit="a" * 40)],
        )
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(agent_interface, 'DB', Path(directory) / 'calls.sqlite3'), \
                patch.object(agent_interface, 'sleep'), \
                patch.object(agent_interface, "review_facts", return_value=after):
            agent_interface.init_db()
            review_receipt._current.set(None)
            try:
                result = agent_interface.behavior_outcome(
                    object(), "pr_review", "68", "/tmp", "bit-mis", "a" * 40, before
                )
            finally:
                review_receipt._current.set(None)

        self.assertEqual(result["outcome"], "superseded")
        self.assertEqual(result["error_code"], "review_target_closed")
        self.assertIn("target CLOSED", result["error"])
        self.assertIn("78/APPROVED", result["error"])
        self.assertEqual(result["diagnostic"]["outcome"], "target_closed")

    def test_reconciliation_settles_duplicate_reviews_on_a_closed_target(self) -> None:
        import sqlite3
        import tempfile
        from pathlib import Path
        from time import time

        from agent_interface import review_receipt

        before = self._facts(reviewer_reviews_since_items=[])
        after = self._facts(
            state="MERGED",
            reviewer_reviews_since_items=[
                self._item(91, state="COMMENTED", commit="a" * 40),
                self._item(92, state="APPROVED", commit="a" * 40),
            ],
        )
        receipt = {"action": "reviewed_clean", "review_id": 91, "head_sha": "a" * 40}
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(agent_interface, 'DB', Path(directory) / 'calls.sqlite3'), \
                patch.object(agent_interface, 'sleep'), \
                patch.object(agent_interface, "review_facts", return_value=after):
            agent_interface.init_db()
            with sqlite3.connect(Path(directory) / 'calls.sqlite3', timeout=30) as conn:
                conn.execute(
                    "insert into calls(id, started_at, actor, repo, pr_id, behavior, status)"
                    " values (?,?,?,?,?,?,?)",
                    ("call-1", time(), "bit-mis", "o/r", "68", "pr_review", "running"))
            review_receipt._current.set(None)
            try:
                result = agent_interface.behavior_outcome(
                    object(), "pr_review", "68", "/tmp", "bit-mis", "a" * 40,
                    before, receipt=receipt, call_id="call-1",
                )
            finally:
                review_receipt._current.set(None)

        self.assertEqual(result["outcome"], "superseded")
        self.assertEqual(result["error_code"], "review_target_closed")
        self.assertIn("duplicate", result["error"])
        self.assertIn("92/APPROVED", result["error"])

    def test_closed_settle_lists_sibling_claims_beside_unclaimed_reviews(self) -> None:
        import sqlite3
        import tempfile
        from pathlib import Path

        from agent_interface import review_receipt

        before = self._facts(reviewer_reviews_since_items=[])
        after = self._facts(
            state="MERGED",
            reviewer_reviews_since_items=[
                self._item(55, state="APPROVED", commit="a" * 40),
                self._item(77, state="APPROVED", commit="a" * 40),
            ],
        )
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(agent_interface, 'DB', Path(directory) / 'calls.sqlite3'), \
                patch.object(agent_interface, 'sleep'), \
                patch.object(agent_interface, "review_facts", return_value=after):
            agent_interface.init_db()
            database = Path(directory) / 'calls.sqlite3'
            with sqlite3.connect(database, timeout=30) as conn:
                conn.execute(
                    "insert into calls(id, repo, pr_id, review_id, status) values (?,?,?,?,?)",
                    ("sibling-1", "o/r", "68", "55", "completed"))
            review_receipt._current.set(None)
            try:
                result = agent_interface.behavior_outcome(
                    object(), "pr_review", "68", "/tmp", "bit-mis", "a" * 40,
                    before, call_id="call-1",
                )
            finally:
                review_receipt._current.set(None)

        self.assertEqual(result["outcome"], "superseded")
        self.assertIn("new_unclaimed=[77/APPROVED]", result["error"])
        self.assertIn("sibling_claimed=[55]", result["error"])

    def test_closed_target_with_no_new_reviews_settles_with_evidence(self) -> None:
        before = self._facts(reviewer_reviews_since_items=[])
        after = self._facts(state="MERGED", reviewer_reviews_since_items=[])

        with patch.object(agent_interface, "review_facts", return_value=after):
            result = agent_interface.behavior_outcome(
                object(), "pr_review", "68", "/tmp", "bit-mis", "a" * 40, before
            )

        self.assertEqual(
            (result["action"], result["outcome"], result["head_sha"]),
            (None, "superseded", "a" * 40))
        self.assertEqual(result["error_code"], "review_target_closed")
        self.assertIn("no review attributable", result["error"])

    def test_posted_review_still_wins_on_a_closed_target(self) -> None:
        before = self._facts(reviewer_reviews_since_items=[])
        after = self._facts(
            state="MERGED",
            reviewer_reviews_since_items=[self._item(91, state="COMMENTED", commit="a" * 40)],
        )
        receipt = {"action": "reviewed_clean", "review_id": 91, "head_sha": "a" * 40}

        with patch.object(agent_interface, "review_facts", return_value=after):
            result = agent_interface.behavior_outcome(
                object(), "pr_review", "68", "/tmp", "bit-mis", "a" * 40,
                before, receipt=receipt, call_id="call-1",
            )

        self.assertEqual(result, {
            "action": "reviewed_clean",
            "outcome": "clean",
            "head_sha": "a" * 40,
        })

    def test_open_target_still_holds_an_unexpected_approval(self) -> None:
        from agent_interface import review_receipt

        before = self._facts(reviewer_reviews_since_items=[])
        after = self._facts(
            reviewer_reviews_since_items=[self._item(77, state="APPROVED", commit="a" * 40)],
        )
        with patch.object(agent_interface, "sleep"), \
                patch.object(agent_interface, "review_facts", return_value=after):
            review_receipt._current.set(None)
            try:
                with self.assertRaisesRegex(RuntimeError, "unexpected approval"):
                    agent_interface.behavior_outcome(
                        object(), "pr_review", "68", "/tmp", "bit-mis", "a" * 40, before
                    )
            finally:
                review_receipt._current.set(None)

    def test_open_target_still_holds_duplicate_reviews(self) -> None:
        import sqlite3
        import tempfile
        from pathlib import Path
        from time import time

        from agent_interface import review_budget, review_receipt

        before = self._facts(reviewer_reviews_since_items=[])
        after = self._facts(
            reviewer_reviews_since_items=[
                self._item(91, state="COMMENTED", commit="a" * 40),
                self._item(92, state="APPROVED", commit="a" * 40),
            ],
        )
        receipt = {"action": "reviewed_clean", "review_id": 91, "head_sha": "a" * 40}
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(agent_interface, 'DB', Path(directory) / 'calls.sqlite3'), \
                patch.object(agent_interface, 'sleep'), \
                patch.object(agent_interface, "review_facts", return_value=after):
            agent_interface.init_db()
            with sqlite3.connect(Path(directory) / 'calls.sqlite3', timeout=30) as conn:
                conn.execute(
                    "insert into calls(id, started_at, actor, repo, pr_id, behavior, status)"
                    " values (?,?,?,?,?,?,?)",
                    ("call-1", time(), "bit-mis", "o/r", "68", "pr_review", "running"))
            review_receipt._current.set(None)
            try:
                with self.assertRaises(review_budget.ReviewLimitError) as raised:
                    agent_interface.behavior_outcome(
                        object(), "pr_review", "68", "/tmp", "bit-mis", "a" * 40,
                        before, receipt=receipt, call_id="call-1",
                    )
            finally:
                review_receipt._current.set(None)
        self.assertEqual(raised.exception.code, "review_contract_violation")

    def test_evidence_inventory_degrades_to_unknown_instead_of_raising(self) -> None:
        malformed = self._facts(reviewer_reviews_since_items=[{"id": "not-an-int"}])
        self.assertIn(
            "unknown",
            agent_interface._closed_target_evidence(malformed, malformed, None, "call-1"))
        missing = self._facts()
        del missing["reviewer_reviews_since_items"]
        self.assertIn(
            "publication state unknown",
            agent_interface._closed_target_evidence(missing, missing, None, None))

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
            "repository": "o/r",
            "pull_number": 68,
            "state": "OPEN",
            "draft": False,
            "head_sha": "a" * 40,
            "reviewer_change_requests_since": 0,
            "reviewer_approvals_since": 0,
            "reviewer_comments_since": 0,
            "reviewer_reviews_since": 0,
            "reviewer_pending_reviews": 0,
            "reviewer_latest_review_id": None,
            "reviewer_latest_any_review_id": None,
            "reviewer_reviews_since_items": [],
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
