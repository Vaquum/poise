import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from agent_interface.model_catalog import CATALOG

from agent_interface import atoms, review_budget, review_receipt
from agent_interface.review_watch import ReviewWatch


class TestAtoms(TestCase):
    def test_run_agent_streams_prompt_over_stdin(self) -> None:
        prompt = "é" * 1_500_000  # Exactly 3 MB in UTF-8, not 1.5 MB.
        completed = SimpleNamespace(returncode=0, stdout=json.dumps({"type": "result", "subtype": "success", "result": "ok"}), stderr="")

        with patch.object(ReviewWatch, "run", return_value=completed) as run:
            self.assertEqual(
                atoms.run_agent("/tmp", "system", prompt, [], "pr_review",
                                pr="https://github.com/o/r/pull/1", actor_name="bit-mis", head="a" * 40),
                "ok",
            )

        argv = run.call_args.args[0]
        self.assertNotIn(prompt, argv)
        self.assertEqual(argv[argv.index("--output-format") + 1], "stream-json")
        self.assertIn("--include-partial-messages", argv)
        self.assertEqual(argv[argv.index("--thinking-display") + 1], "summarized")
        self.assertIn("--verbose", argv)
        self.assertEqual(
            argv[argv.index("--model") + 1],
            CATALOG.behavior("pr_review").selector,
        )
        self.assertEqual(argv[argv.index("--effort") + 1], CATALOG.behavior("pr_review").effort)
        self.assertEqual(run.call_args.kwargs["input"], prompt)

    def test_run_agent_rejects_oversized_prompt_before_launch(self) -> None:
        prompt = "é" * 1_500_000 + "x"

        with patch.object(ReviewWatch, "run") as run:
            with self.assertRaisesRegex(atoms.AgentPreflightError, "reduce the remaining review input") as caught:
                atoms.run_agent("/tmp", "system", prompt, [], "pr_approve")

        run.assert_not_called()
        self.assertEqual(caught.exception.code, "review_packet_too_large")
        self.assertEqual(caught.exception.diagnostic["context"]["actual_input_bytes"], 3_000_001)
        self.assertEqual(caught.exception.diagnostic["context"]["input_limit_bytes"], 3_000_000)

    def test_run_agent_types_a_guarded_duplicate_only_refusal(self) -> None:
        completed = SimpleNamespace(returncode=0, stdout=json.dumps(
            {"type": "result", "subtype": "success", "result": "reviewed"}), stderr="")
        reply = {"action": "no_review",
                 "skipped": [{"reason": "repeat", "comment": {"path": "a.py", "line": 1}}]}
        with tempfile.TemporaryDirectory() as directory:
            receipt_path = Path(directory) / "receipt.json"
            Path(str(receipt_path) + ".refused").write_text(json.dumps(reply))
            review_receipt.record_file(receipt_path)
            self.addCleanup(review_receipt._refused.set, None)
            with patch.object(ReviewWatch, "run", return_value=completed):
                with self.assertRaises(review_budget.ReviewLimitError) as caught:
                    atoms.run_agent("/tmp", "system", "prompt", [], "pr_approve",
                                    pr="https://github.com/o/r/pull/1", actor_name="bit-mis", head="a" * 40)

        self.assertEqual(caught.exception.code, "review_contract_violation")
        self.assertIn("no-op", str(caught.exception))
        self.assertEqual(caught.exception.diagnostic["provider"], "claude")
        self.assertEqual(caught.exception.diagnostic["submission"], "noop")
        self.assertEqual(caught.exception.diagnostic["refusal"], "repeat_only")

    def test_run_agent_returns_the_result_when_a_receipt_followed_a_refusal(self) -> None:
        completed = SimpleNamespace(returncode=0, stdout=json.dumps(
            {"type": "result", "subtype": "success", "result": "ok"}), stderr="")
        with tempfile.TemporaryDirectory() as directory:
            receipt_path = Path(directory) / "receipt.json"
            Path(str(receipt_path) + ".refused").write_text(json.dumps(
                {"action": "no_review", "skipped": [{"reason": "repeat"}]}))
            receipt_path.write_text(json.dumps({"action": "approved_pr", "review_id": 93, "head_sha": "a" * 40}))
            review_receipt.record_file(receipt_path)
            self.addCleanup(review_receipt._refused.set, None)
            self.addCleanup(review_receipt._current.set, None)
            with patch.object(ReviewWatch, "run", return_value=completed):
                self.assertEqual(
                    atoms.run_agent("/tmp", "system", "prompt", [], "pr_approve",
                                    pr="https://github.com/o/r/pull/1", actor_name="bit-mis", head="a" * 40),
                    "ok",
                )

    def test_packet_timeout_is_proven_before_agent_start(self) -> None:
        with patch.object(atoms.subprocess, "run", side_effect=atoms.subprocess.TimeoutExpired("github-interface", 600)):
            with self.assertRaises(atoms.AgentPreflightError) as caught:
                atoms.packet("/tmp", "#1", "bit-mis", "a" * 40)
        self.assertIsNone(caught.exception.code)

    def test_last_reviewed_head_reports_the_reviewers_latest_commit(self) -> None:
        reply = {"action": "review_activity_since", "reviewer_latest_commit": "c" * 40}
        with patch.object(atoms.subprocess, "run",
                          return_value=SimpleNamespace(returncode=0, stdout=json.dumps(reply), stderr="")) as run:
            self.assertEqual(atoms.last_reviewed_head("/tmp", "#1", "bit-mis"), "c" * 40)
        self.assertEqual(run.call_args.args[0],
                         ["github-interface", "--review-activity-since", "#1", "--username", "bit-mis",
                          "--since", "1970-01-01T00:00:00Z", "--token-user", "bit-mis"])

    def test_last_reviewed_head_is_none_without_a_prior_review(self) -> None:
        for commit in (None, ""):
            reply = {"action": "review_activity_since", "reviewer_latest_commit": commit}
            with patch.object(atoms.subprocess, "run",
                              return_value=SimpleNamespace(returncode=0, stdout=json.dumps(reply), stderr="")):
                self.assertIsNone(atoms.last_reviewed_head("/tmp", "#1", "bit-mis"))

    def test_last_reviewed_head_rejects_garbage_loudly(self) -> None:
        reply = {"action": "review_activity_since", "reviewer_latest_commit": "not-a-sha"}
        with patch.object(atoms.subprocess, "run",
                          return_value=SimpleNamespace(returncode=0, stdout=json.dumps(reply), stderr="")), \
                self.assertRaises(atoms.AgentPreflightError) as failure:
            atoms.last_reviewed_head("/tmp", "#1", "bit-mis")
        self.assertEqual(failure.exception.code, "review_contract_violation")

    def test_last_reviewed_head_failure_is_not_a_prior_review(self) -> None:
        with patch.object(atoms.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout="", stderr="boom")), \
                self.assertRaises(atoms.AgentPreflightError):
            atoms.last_reviewed_head("/tmp", "#1", "bit-mis")

    def test_packet_limit_has_stable_code_but_network_error_remains_retryable(self) -> None:
        for error, code in [
            ("error: review_packet_too_large: retained diff exceeds limit", "review_packet_too_large"),
            ("error: GitHub 503", None),
        ]:
            with self.subTest(error=error), patch.object(atoms.subprocess, "run", return_value=SimpleNamespace(returncode=1, stderr=error, stdout="")):
                with self.assertRaises(atoms.AgentPreflightError) as caught:
                    atoms.packet("/tmp", "#1", "bit-mis", "a" * 40)
                self.assertEqual(caught.exception.code, code)
