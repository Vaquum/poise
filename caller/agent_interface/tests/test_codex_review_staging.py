import json
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from agent_interface import atoms, structured_review
from agent_interface.model_catalog import CATALOG


THREAD = "01234567-89ab-4cde-8123-456789abcdef"
LIMIT = 4096


class TestCodexReviewStaging(TestCase):
    def run_review(self, text, failure=None):
        messages, commands, timeouts = [], [], []

        def turn(command, **kwargs):
            messages.append(kwargs["input"])
            commands.append(command)
            timeouts.append(kwargs["timeout"])
            schema = json.loads(Path(command[command.index("--output-schema") + 1]).read_text())
            stage = schema["properties"].get("received", {}).get("enum", [None])[0]
            result = {"received": stage} if stage else {"action": "approve", "comments": []}
            thread = THREAD
            events = [{"type": "thread.started", "thread_id": thread}]
            if failure == "wrong_ack" and stage:
                result = {"received": stage + 1}
            if failure == "boolean_ack" and stage:
                result = {"received": True}
            if failure == "early_verdict" and stage:
                result = {"action": "approve", "comments": []}
            if failure == "missing_thread" and stage:
                events = []
            if failure == "changed_thread" and not stage:
                events = [{"type": "thread.started", "thread_id": "11234567-89ab-4cde-8123-456789abcdef"}]
            if failure == "native_tool" and not stage:
                events.append({"type": "item.completed", "item": {"type": "command_execution"}})
            Path(command[command.index("--output-last-message") + 1]).write_text(json.dumps(result))
            return SimpleNamespace(returncode=1 if failure == "provider_failure" and not stage else 0,
                                   stdout="\n".join(json.dumps(event) for event in events), stderr="failed")

        watch = SimpleNamespace(run=turn)
        with patch.object(structured_review, "CODEX_MAX_INPUT_CHARS", LIMIT), \
                patch.object(structured_review, "ReviewWatch", return_value=nullcontext(watch)), \
                patch.object(structured_review.subprocess, "run",
                             return_value=SimpleNamespace(returncode=0, stdout="submitted", stderr="")) as submit:
            if failure:
                with self.assertRaises(atoms.AgentPreflightError):
                    self.review(text)
                submit.assert_not_called()
            else:
                self.assertIn("submitted", self.review(text))
                submit.assert_called_once()
                self.assertEqual(submit.call_args.args[0], ["github-interface", "--approve-pr", "#12",
                    "--expected-head", "a" * 40, "--token-user", "bit-mis"])
        return messages, commands, timeouts

    @staticmethod
    def review(text):
        return structured_review.run("/repo", "system", text, CATALOG.resolve("gpt-6-astra-ultra"),
                                     "pr_approve", "https://github.com/o/r/pull/12", "bit-mis", "a" * 40, 60)

    def test_at_limit_keeps_the_original_single_message(self):
        text = "x" * (LIMIT - len("system\n\n"))
        messages, commands, timeouts = self.run_review(text)
        self.assertEqual(messages, ["system\n\n" + text])
        self.assertNotIn("resume", commands[0])
        self.assertEqual(timeouts, [60])

    def test_overflow_delivers_every_character_before_one_atomic_verdict(self):
        # Includes non-ASCII text and JSON escapes; the transport limit counts
        # characters, while the existing total review guard counts UTF-8 bytes.
        text = ('字😀"\\\n' * 1600) + "final evidence"
        messages, commands, timeouts = self.run_review(text)
        self.assertGreater(len(messages), 2)
        fragments = [message.split("\nBEGIN REVIEW INPUT FRAGMENT\n", 1)[1]
                     .removesuffix("\nEND REVIEW INPUT FRAGMENT") for message in messages]
        self.assertEqual("".join(fragments), "system\n\n" + text)
        self.assertTrue(all(len(message) <= LIMIT for message in messages))
        self.assertNotIn("resume", commands[0])
        for command in commands[1:]:
            self.assertEqual(command[-3:], ["resume", THREAD, "-"])
        self.assertTrue(all(0 < value <= 60 for value in timeouts))
        self.assertEqual(timeouts, sorted(timeouts, reverse=True))

    def test_one_character_over_the_limit_uses_staging(self):
        messages, _, _ = self.run_review("x" * (LIMIT - len("system\n\n") + 1))
        self.assertEqual(len(messages), 2)

    def test_incomplete_or_untrusted_staging_never_publishes(self):
        for failure in ("wrong_ack", "boolean_ack", "early_verdict", "missing_thread", "changed_thread",
                        "native_tool", "provider_failure"):
            with self.subTest(failure=failure):
                self.run_review("x" * (LIMIT + 1), failure)
