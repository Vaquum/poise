import json
import os
import sys
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from agent_interface import bash_guard, claude_acl


class TestBashGuard(TestCase):
    def test_markdown_is_passed_as_literal_argv(self) -> None:
        head = "a" * 40
        body = '[{"body":"`name` and $(literal)"}]'
        command = (
            "github-interface --request-changes #68 --comments-json "
            f"'{body}' --expected-head {head} --token-user bit-mis"
        )
        pattern = (
            "github-interface --request-changes #68 --comments-json * "
            f"--expected-head {head} --token-user bit-mis"
        )

        with (
            patch.dict(os.environ, {"AGENT_INTERFACE_BASH_ALLOW": json.dumps([pattern])}),
            patch.object(sys, "argv", ["bash_guard.py", command]),
            patch.object(
                bash_guard.subprocess,
                "run",
                return_value=SimpleNamespace(returncode=0),
            ) as run,
        ):
            with self.assertRaises(SystemExit) as stopped:
                bash_guard.main()

        self.assertEqual(stopped.exception.code, 0)
        self.assertEqual(run.call_args.args[0][4], body)


class TestClaudeShellPrefix(TestCase):
    RULES = ["Bash(github-interface --review-context --requests-json *)"]

    def test_uses_an_executable_guard_without_changing_it(self) -> None:
        # A read-only install: chmod by anyone but the owner fails.
        refused = PermissionError(1, "Operation not permitted")
        with (
            patch.object(claude_acl.os, "access", return_value=True),
            patch.object(claude_acl.Path, "chmod", side_effect=refused) as chmod,
        ):
            env = claude_acl.env(self.RULES)

        chmod.assert_not_called()
        self.assertTrue(env["CLAUDE_CODE_SHELL_PREFIX"].endswith("bash_guard.py"))
        self.assertEqual(json.loads(env["AGENT_INTERFACE_BASH_ALLOW"]), [self.RULES[0][5:-1]])

    def test_makes_a_guard_that_lost_its_executable_bit_executable(self) -> None:
        with (
            patch.object(claude_acl.os, "access", return_value=False),
            patch.object(claude_acl.Path, "stat", return_value=SimpleNamespace(st_mode=0o100644)),
            patch.object(claude_acl.Path, "chmod") as chmod,
        ):
            claude_acl.env(self.RULES)

        chmod.assert_called_once_with(0o100755)

    def test_sets_no_guard_without_bash_rules(self) -> None:
        with patch.object(claude_acl.Path, "chmod") as chmod:
            env = claude_acl.env(["Read"])

        chmod.assert_not_called()
        self.assertNotIn("CLAUDE_CODE_SHELL_PREFIX", env)
