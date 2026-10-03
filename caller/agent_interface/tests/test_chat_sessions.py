import subprocess
import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from agent_interface import chat

SESSION = "editor-untitled-20260727091613565-1785143835153"
STALE = "No conversation found with session ID: 6889b47a-9cd6-5152-8104-8540f29d2934\n"


def outcome(args, returncode=0, stderr=""):
    return subprocess.CompletedProcess(args, returncode, stdout="ok\n", stderr=stderr)


class TestStaleClaudeSession(TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        data = Path(self.work.name)
        for target in (patch.object(chat, "DATA_DIR", data), patch.object(chat, "DB", data / "calls.sqlite3")):
            target.start()
            self.addCleanup(target.stop)
        self.model = chat.model_name("opus-5-max")
        self.provider = chat.stable_uuid(SESSION, self.model)
        chat.set_session(SESSION, self.model, self.provider)

    def test_forgets_the_session_and_starts_over_under_the_same_id(self):
        calls = []

        def call(args):
            calls.append(list(args))
            if "--resume" in args:
                return outcome(args, 1, STALE)
            return outcome(args)

        done = chat.run_session(call, ["claude", "--resume", self.provider, "hi"], SESSION, self.model, chat.STALE_SESSION["claude"])

        self.assertEqual(done.returncode, 0)
        self.assertEqual(calls, [["claude", "--resume", self.provider, "hi"], ["claude", "--session-id", self.provider, "hi"]])
        self.assertIsNone(chat.get_session(SESSION, self.model))

    def test_other_failures_keep_the_session_and_do_not_retry(self):
        calls = []

        def call(args):
            calls.append(list(args))
            return outcome(args, 1, "Not logged in\n")

        done = chat.run_session(call, ["claude", "--resume", self.provider, "hi"], SESSION, self.model, chat.STALE_SESSION["claude"])

        self.assertEqual(done.returncode, 1)
        self.assertEqual(len(calls), 1)
        self.assertEqual(chat.get_session(SESSION, self.model), self.provider)

    def test_a_fresh_session_that_fails_is_not_retried(self):
        calls = []

        def call(args):
            calls.append(list(args))
            return outcome(args, 1, STALE)

        chat.run_session(call, ["claude", "--session-id", self.provider, "hi"], SESSION, self.model, chat.STALE_SESSION["claude"])

        self.assertEqual(len(calls), 1)

    def test_chat_turn_heals_and_records_the_same_provider_session(self):
        commands = []

        def fake_run(args, **_):
            commands.append(list(args))
            if "--resume" in args:
                return outcome(args, 1, STALE)
            return outcome(args)

        with patch.object(chat.subprocess, "run", fake_run):
            response = chat.run(self.work.name, "opus-5-max", SESSION, "hi", no_tools=True)

        self.assertEqual(response, "ok")
        self.assertEqual([c[c.index("--resume" if "--resume" in c else "--session-id")] for c in commands], ["--resume", "--session-id"])
        self.assertEqual([c[-2] for c in commands], [self.provider, self.provider])
        self.assertEqual(chat.get_session(SESSION, self.model), self.provider)
