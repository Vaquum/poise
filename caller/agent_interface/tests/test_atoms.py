import json
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from agent_interface.model_catalog import CATALOG

from agent_interface import atoms
from agent_interface.review_watch import ReviewWatch


class TestAtoms(TestCase):
    def test_run_agent_streams_prompt_over_stdin(self) -> None:
        prompt = "x" * (1024 * 1024)
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
        prompt = "x" * (atoms.MAX_GOVERNED_PROMPT_BYTES + 1)

        with patch.object(atoms.subprocess, "run") as run:
            with self.assertRaisesRegex(atoms.AgentPreflightError, "reduce the remaining review input"):
                atoms.run_agent("/tmp", "system", prompt, [], "pr_approve")

        run.assert_not_called()

    def test_packet_timeout_is_proven_before_agent_start(self) -> None:
        with patch.object(atoms.subprocess, "run", side_effect=atoms.subprocess.TimeoutExpired("github-interface", 600)):
            with self.assertRaises(atoms.AgentPreflightError) as caught:
                atoms.packet("/tmp", "#1", "bit-mis", "a" * 40)
        self.assertIsNone(caught.exception.code)

    def test_packet_limit_has_stable_code_but_network_error_remains_retryable(self) -> None:
        for error, code in [
            ("error: review_packet_too_large: retained diff exceeds limit", "review_packet_too_large"),
            ("error: GitHub 503", None),
        ]:
            with self.subTest(error=error), patch.object(atoms.subprocess, "run", return_value=SimpleNamespace(returncode=1, stderr=error, stdout="")):
                with self.assertRaises(atoms.AgentPreflightError) as caught:
                    atoms.packet("/tmp", "#1", "bit-mis", "a" * 40)
                self.assertEqual(caught.exception.code, code)
