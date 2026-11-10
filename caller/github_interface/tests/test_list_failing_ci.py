import json
import os
import sys
from io import StringIO
from unittest import IsolatedAsyncioTestCase, TestCase
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
PULL = {"head": {"sha": HEAD}, "user": {"login": "fixture-agent"}, "draft": False,
        "mergeable": True, "mergeable_state": "behind", "base": {"ref": "main"},
        "state": "open", "merged": False}
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
        # Merge state, author, draft and pull state ride the same get_pull
        # response; the monitor's conflict/behind/terminal read adds no
        # GitHub request.
        self.assertEqual(state["mergeable"], True)
        self.assertEqual(state["mergeable_state"], "behind")
        self.assertEqual(state["author"], "fixture-agent")
        self.assertEqual(state["draft"], False)
        self.assertEqual(state["base"], "main")
        self.assertEqual(state["state"], "open")
        self.assertEqual(state["merged"], False)
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


class TestIntegrationCi(IsolatedAsyncioTestCase):
    async def test_exact_ref_retains_candidate_base_parents_and_paginated_workflow_identity(self):
        integration, base = "c" * 40, "d" * 40
        check = {**CHECKS[0], "head_sha": integration}
        client = AsyncMock()
        client.get.side_effect = [{"parents": [{"sha": base}, {"sha": HEAD}]},
                                  {"workflow_runs": [{"id": n, "head_sha": integration, "event": "merge_group"} for n in range(100)]},
                                  {"workflow_runs": [{"id": 101, "head_sha": integration, "event": "merge_group"}]}]
        with patch.object(list_failing_ci, "get_pull", AsyncMock(return_value={**PULL, "base": {"ref": "main", "sha": base}})), \
                patch.object(list_failing_ci, "list_check_runs", AsyncMock(return_value=[check])) as checks, \
                patch.object(list_failing_ci, "get_combined_status", AsyncMock(return_value={"statuses": []})):
            result = await list_failing_ci.run(client, {"repository": "acme/app", "pr": 9, "ref": integration})
        self.assertEqual((result["head_sha"], result["ref"], result["base_sha"]), (HEAD, integration, base))
        self.assertEqual(result["parents"], [base, HEAD])
        self.assertEqual(len(result["runs"]), 101)
        self.assertEqual(result["failing"][0]["run_id"], 1)
        self.assertEqual(result["failing"][0]["log_id"], 22)
        self.assertEqual(checks.call_args.args[1:], ("acme", "app", integration))
        self.assertEqual(checks.call_args.kwargs, {"all_runs": True})
        self.assertEqual(client.get.call_args.kwargs["params"]["page"], 2)

    async def test_base_ref_observes_current_base_and_missing_base_never_falls_back_to_head(self):
        base = "c" * 40
        client = AsyncMock()
        client.get.side_effect = [{"parents": []}, {"workflow_runs": []}]
        with patch.object(list_failing_ci, "get_pull", AsyncMock(return_value={**PULL, "base": {"sha": base}})), \
                patch.object(list_failing_ci, "list_check_runs", AsyncMock(return_value=[])) as checks, \
                patch.object(list_failing_ci, "get_combined_status", AsyncMock(return_value={"statuses": []})):
            result = await list_failing_ci.run(client, {"repository": "acme/app", "pr": 9, "ref": "base"})
        self.assertEqual(result["ref"], base)
        self.assertEqual(checks.call_args.args[-1], base)
        with patch.object(list_failing_ci, "get_pull", AsyncMock(return_value=PULL)):
            with self.assertRaisesRegex(ValueError, "CI ref"):
                await list_failing_ci.run(client, {"repository": "acme/app", "pr": 9, "ref": "base"})
