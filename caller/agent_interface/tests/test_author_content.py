import io
import json
import os
import subprocess
import tempfile
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

import agent_interface
from agent_interface import author_content


class TestAuthorContent(TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        data = Path(self.work.name) / "data"
        for target in (
            patch.object(agent_interface, "DATA_DIR", data),
            patch.object(agent_interface, "DB", data / "calls.sqlite3"),
            patch.object(agent_interface, "RESPONSES", data / "responses"),
            patch.dict(os.environ, {author_content.VOICE_GUIDE_ENV: ""}),
        ):
            target.start()
            self.addCleanup(target.stop)
        agent_interface.init_db()
        self.runs: list[list[str]] = []

    def provider(self, args, **_):
        self.runs.append(args)
        return subprocess.CompletedProcess(args, 0, "The authored piece.\n", "")

    def author(self, voice_guide: str | None = None) -> tuple[dict, str]:
        with patch.object(author_content.subprocess, "run", side_effect=self.provider), \
                redirect_stdout(io.StringIO()) as output, redirect_stderr(io.StringIO()) as errors:
            agent_interface.run_author_content("Write about tides", voice_guide=voice_guide)
        return json.loads(output.getvalue()), errors.getvalue()

    def guide(self, name: str, text: str) -> Path:
        path = Path(self.work.name) / name
        path.write_text(text)
        return path

    def test_without_a_guide_it_writes_without_one_and_says_so(self):
        printed, errors = self.author()
        self.assertEqual(printed["voice_guide"], None)
        self.assertEqual(printed["response"], "The authored piece.")
        self.assertIn("no voice guide (--voice-guide or AGENT_INTERFACE_VOICE_GUIDE); writing without one", errors)
        # One process: the provider. Nothing is fetched.
        [args] = self.runs
        self.assertEqual(args[0], os.getenv("CLAUDE_CLI", "claude"))
        self.assertTrue(args[-1].startswith("Topic:\nWrite about tides"))
        self.assertNotIn("Voice", args[-1])
        self.assertEqual(args[-2], "Author the content. Use no tools.")

    def test_writes_in_the_guide_the_environment_names(self):
        guide = self.guide("voice.md", "Short sentences. No adverbs.\n")
        with patch.dict(os.environ, {author_content.VOICE_GUIDE_ENV: str(guide)}):
            printed, errors = self.author()
        self.assertEqual((printed["voice_guide"], errors), (str(guide), ""))
        [args] = self.runs
        self.assertTrue(args[-1].startswith("Voice:\nShort sentences. No adverbs.\n\nTopic:\nWrite about tides"))
        self.assertEqual(args[-2], "Author content in the provided voice. Use no tools.")

    def test_the_flag_names_the_guide_over_the_environment(self):
        named = self.guide("named.md", "Named voice.")
        configured = self.guide("configured.md", "Configured voice.")
        with patch.dict(os.environ, {author_content.VOICE_GUIDE_ENV: str(configured)}):
            printed, _ = self.author(str(named))
        self.assertEqual(printed["voice_guide"], str(named))
        self.assertTrue(self.runs[0][-1].startswith("Voice:\nNamed voice."))

    def test_a_named_guide_that_cannot_be_read_fails_before_the_provider_runs(self):
        for guide in (str(Path(self.work.name) / "missing.md"), str(self.guide("empty.md", " \n"))):
            with self.subTest(guide=guide), self.assertRaises(SystemExit):
                self.author(guide)
        self.assertEqual(self.runs, [])
        with agent_interface.db() as conn:
            rows = conn.execute("select status from calls where behavior='author_content'").fetchall()
        self.assertEqual([row["status"] for row in rows], ["failed", "failed"])

    def test_cli_passes_the_voice_guide(self):
        argv = ["agent-interface", "--author-content", "Tides", "--session-id", "chat-1", "--voice-guide", "/guides/voice.md"]
        with patch.object(agent_interface.sys, "argv", argv), patch.object(agent_interface, "run_author_content") as run:
            agent_interface.main()
        self.assertEqual(run.call_args.args, ("Tides", None, "chat-1"))
        self.assertEqual(run.call_args.kwargs, {"voice_guide": "/guides/voice.md"})
