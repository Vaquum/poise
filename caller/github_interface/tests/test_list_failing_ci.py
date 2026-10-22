import json
import os
import sys
from io import StringIO
from unittest import TestCase
from unittest.mock import AsyncMock, patch

from github_interface import cli, interface
from github_interface.behaviors import list_failing_ci
from github_interface.identity import AGENT, PERSON

# The work monitor's CI read (server/chat/control.ts readWorkCi) shells out to
# the bundled CLI with this exact argv; the CLI must accept the explicit
# repository and return the bound PR's CI state for it.
HEAD = "b" * 40
SERVER_ARGV = ["github-interface", "--list-failing-ci", "9", "--repository", "acme/app",
               "--token-user", "fixture-agent"]
PULL = {"head": {"sha": HEAD}}
CHECKS = [{"name": "Verify", "status": "completed", "conclusion": "failure", "id": 11,
           "details_url": "https://github.com/acme/app/actions/runs/1/job/22",
           "html_url": "https://github.com/acme/app/actions/runs/1",
           "output": {"summary": "failing"}}]
STATUSES = {"statuses": [{"context": "Legacy", "state": "error", "description": "boom",
                          "target_url": "https://example.invalid/legacy"}]}
NO_ACCOUNTS = {AGENT: "", PERSON: ""}


class FakeClient:
    def __init__(self, user: str) -> None:
        self.user = user


class TestListFailingCiCli(TestCase):
    def test_server_argv_returns_the_bound_prs_typed_ci_state(self) -> None:
        self.assertIn("--repository", cli._parser("--list-failing-ci").format_help())
        stdout, stderr = StringIO(), StringIO()
        with patch("sys.argv", SERVER_ARGV), patch.object(interface, "GitHubClient", FakeClient), \
                patch.object(list_failing_ci, "get_pull", AsyncMock(return_value=PULL)) as get_pull, \
                patch.object(list_failing_ci, "list_check_runs", AsyncMock(return_value=CHECKS)) as check_runs, \
                patch.object(list_failing_ci, "get_combined_status", AsyncMock(return_value=STATUSES)) as combined, \
                patch("sys.stdout", stdout), patch("sys.stderr", stderr):
            cli.main()
        self.assertEqual(stderr.getvalue(), "")
        state = json.loads(stdout.getvalue())
        self.assertEqual(state["action"], "list_failing_ci")
        self.assertEqual((state["repository"], state["pull_number"], state["head_sha"]),
                         ("acme/app", 9, HEAD))
        self.assertIsInstance(state["head_sha"], str)
        self.assertEqual([(check["name"], check["state"]) for check in state["failing"]],
                         [("Verify", "completed"), ("Legacy", "error")])
        get_pull.assert_awaited_once()
        self.assertEqual(get_pull.call_args.args[1:], ("acme", "app", 9))
        check_runs.assert_awaited_once()
        self.assertEqual(check_runs.call_args.args[1:], ("acme", "app", HEAD))
        combined.assert_awaited_once()
        self.assertEqual(combined.call_args.args[1:], ("acme", "app", HEAD))

    def test_wrong_repository_fails_clearly_without_touching_github(self) -> None:
        for repository in ("acme", "acme/app/extra"):
            with self.subTest(repository=repository):
                stdout, stderr = StringIO(), StringIO()
                argv = ["github-interface", "--list-failing-ci", "9", "--repository", repository,
                        "--token-user", "fixture-agent"]
                with patch("sys.argv", argv), patch.object(interface, "GitHubClient", FakeClient), \
                        patch.object(list_failing_ci, "get_pull", AsyncMock()) as get_pull, \
                        patch("sys.stdout", stdout), patch("sys.stderr", stderr):
                    with self.assertRaises(SystemExit) as exited:
                        cli.main()
                self.assertEqual(exited.exception.code, 1)
                self.assertEqual(stderr.getvalue().strip(), "error: repository must look like org/repo")
                self.assertEqual(stdout.getvalue(), "")
                get_pull.assert_not_awaited()

    def test_missing_account_identity_fails_naming_the_variable_to_set(self) -> None:
        stdout, stderr = StringIO(), StringIO()
        argv = ["github-interface", "--list-failing-ci", "9", "--repository", "acme/app"]
        with patch("sys.argv", argv), patch.dict(os.environ, NO_ACCOUNTS), \
                patch.object(list_failing_ci, "get_pull", AsyncMock()) as get_pull, \
                patch("sys.stdout", stdout), patch("sys.stderr", stderr):
            with self.assertRaises(SystemExit) as exited:
                cli.main()
        self.assertEqual(exited.exception.code, 1)
        self.assertEqual(stderr.getvalue().strip(),
                         f"error: no GitHub account to act as: pass --token-user or set {AGENT}")
        get_pull.assert_not_awaited()

    def test_bare_pr_keeps_resolving_the_repository_from_the_checkout(self) -> None:
        operation = AsyncMock(return_value={"ok": True})
        with patch("sys.argv", ["github-interface", "--list-failing-ci", "#9"]), \
                patch.object(cli, "list_failing_ci", operation), patch("sys.stdout", StringIO()):
            cli.main()
        self.assertEqual(operation.call_args.args[0], {"pr": "#9", "repository": None, "token_user": None})
