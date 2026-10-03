import json
import os
import sys
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from agent_interface import bash_guard


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
