import os
import pkgutil
import subprocess
import sys
from importlib import import_module
from io import StringIO
from typing import Any
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from github_interface import behaviors, cli, interface, token
from github_interface.identity import AGENT, PERSON

# Every behavior that used to act as one fixed agent account.
AGENT_BEHAVIORS = {
    "assign_issue", "checkout_pr_head", "checkout_repo", "comment_issue", "commit_work", "create_issue",
    "edit_issue_comment", "issue_comments", "list_failing_ci", "mergeable", "post_pr_comment",
    "read_failing_ci_log", "read_issue", "resolve_conversation", "resolve_pr_conversations", "sub_issues",
}
PERSON_BEHAVIORS = {"view_repos", "current_pr", "pr_readiness"}
NO_ACCOUNTS = {AGENT: "", PERSON: ""}


def behavior_modules() -> dict[str, Any]:
    return {
        info.name: import_module(f"github_interface.behaviors.{info.name}")
        for info in pkgutil.iter_modules(behaviors.__path__)
    }


class FakeClient:
    def __init__(self, user: str) -> None:
        self.user = user


class TestIdentityClasses(TestCase):
    def test_every_behavior_declares_exactly_one_way_to_authenticate(self) -> None:
        for name, module in behavior_modules().items():
            with self.subTest(behavior=name):
                declared = [flag for flag in ("NO_AUTH", "REQUIRE_TOKEN_USER", "IDENTITY") if hasattr(module, flag)]
                self.assertEqual(len(declared), 1, declared)
                self.assertFalse(hasattr(module, "TOKEN_USER"))
                if hasattr(module, "IDENTITY"):
                    self.assertIn(module.IDENTITY, (AGENT, PERSON))

    def test_agent_work_and_reads_done_as_the_person_are_classed(self) -> None:
        modules = behavior_modules()
        self.assertEqual({name for name, module in modules.items() if getattr(module, "IDENTITY", None) == AGENT}, AGENT_BEHAVIORS)
        self.assertEqual({name for name, module in modules.items() if getattr(module, "IDENTITY", None) == PERSON}, PERSON_BEHAVIORS)


class TestAccountResolution(IsolatedAsyncioTestCase):
    async def run_as(self, name: str, payload: dict[str, Any], environment: dict[str, str]) -> str:
        module = import_module(f"github_interface.behaviors.{name}")
        with patch.dict(os.environ, environment), patch.object(interface, "GitHubClient", FakeClient), \
                patch.object(module, "run", AsyncMock(side_effect=lambda client, _: client.user)):
            return await interface.run_behavior(name, payload)

    async def test_agent_behaviors_act_as_the_configured_agent_account(self) -> None:
        accounts = {AGENT: "agent-account", PERSON: "person-account"}
        for name in sorted(AGENT_BEHAVIORS):
            with self.subTest(behavior=name):
                self.assertEqual(await self.run_as(name, {}, accounts), "agent-account")

    async def test_reads_done_as_the_person_act_as_their_account(self) -> None:
        accounts = {AGENT: "agent-account", PERSON: "person-account"}
        for name in sorted(PERSON_BEHAVIORS):
            with self.subTest(behavior=name):
                self.assertEqual(await self.run_as(name, {}, accounts), "person-account")

    async def test_token_user_names_the_account_over_the_configured_one(self) -> None:
        accounts = {AGENT: "agent-account", PERSON: "person-account"}
        self.assertEqual(await self.run_as("comment_issue", {"token_user": "someone-else"}, accounts), "someone-else")
        self.assertEqual(await self.run_as("view_repos", {"token_user": "someone-else"}, accounts), "someone-else")

    async def test_a_missing_account_fails_naming_the_variable_to_set(self) -> None:
        for name, variable in (("comment_issue", AGENT), ("view_repos", PERSON)):
            with self.subTest(behavior=name), self.assertRaisesRegex(ValueError, f"pass --token-user or set {variable}"):
                await self.run_as(name, {}, NO_ACCOUNTS)

    async def test_the_other_class_account_never_stands_in(self) -> None:
        with self.assertRaisesRegex(ValueError, AGENT):
            await self.run_as("comment_issue", {}, {AGENT: "", PERSON: "person-account"})
        with self.assertRaisesRegex(ValueError, PERSON):
            await self.run_as("view_repos", {}, {AGENT: "agent-account", PERSON: ""})

    async def test_an_account_that_is_not_a_login_is_refused(self) -> None:
        with self.assertRaisesRegex(ValueError, f"{AGENT} must be a GitHub username"):
            await self.run_as("comment_issue", {}, {AGENT: "https://github.com/agent"})
        with self.assertRaisesRegex(ValueError, "token-user must be a GitHub username"):
            await self.run_as("comment_issue", {"token_user": "-bad-"}, {AGENT: "agent-account"})

    async def test_reviewer_behaviors_still_take_their_account_on_every_call(self) -> None:
        with self.assertRaisesRegex(ValueError, "token-user is required"):
            await self.run_as("head_sha", {}, {AGENT: "agent-account", PERSON: "person-account"})


class TestToken(TestCase):
    def test_always_asks_gh_for_the_named_account(self) -> None:
        done = subprocess.CompletedProcess([], 0, stdout="gho_token\n", stderr="")
        with patch.object(token.subprocess, "run", return_value=done) as gh:
            self.assertEqual(token.get_token("agent-account"), "gho_token")
        self.assertEqual(gh.call_args.args[0], ["gh", "auth", "token", "--user", "agent-account"])

    def test_never_falls_back_to_the_active_account(self) -> None:
        with patch.object(token.subprocess, "run") as gh, patch.dict(os.environ, {PERSON: "person-account"}):
            with self.assertRaisesRegex(ValueError, "a GitHub account is required"):
                token.get_token("")
        gh.assert_not_called()

    def test_an_account_gh_has_no_login_for_says_so(self) -> None:
        failure = subprocess.CalledProcessError(1, ["gh"], stderr="no oauth token found for github.com account agent-account")
        with patch.object(token.subprocess, "run", side_effect=failure):
            with self.assertRaisesRegex(RuntimeError, "gh has no token for agent-account; sign in with gh auth login as agent-account"):
                token.get_token("agent-account")


class TestCli(TestCase):
    def test_every_behavior_accepts_token_user(self) -> None:
        for name in sorted(behavior_modules()):
            flag = "--" + name.replace("_", "-")
            with self.subTest(behavior=flag):
                self.assertIn("--token-user USER", cli._parser(flag).format_help())

    def test_a_missing_account_exits_with_the_variable_to_set(self) -> None:
        stderr = StringIO()
        with patch.object(sys, "argv", ["github-interface", "--mergeable", "#7"]), patch.dict(os.environ, NO_ACCOUNTS), \
                patch.object(token.subprocess, "run") as gh, patch.object(sys, "stderr", stderr):
            with self.assertRaises(SystemExit) as exited:
                cli.main()
        self.assertEqual(exited.exception.code, 1)
        self.assertEqual(stderr.getvalue().strip(), f"error: no GitHub account to act as: pass --token-user or set {AGENT}")
        gh.assert_not_called()

    def test_token_user_reaches_the_behavior(self) -> None:
        behavior = AsyncMock(return_value={"ok": True})
        with patch.object(sys, "argv", ["github-interface", "--view-repos", "acme", "--token-user", "octocat"]), \
                patch.object(cli, "view_repos", behavior), patch("builtins.print"):
            cli.main()
        self.assertEqual(behavior.call_args.args[0], {"org": "acme", "token_user": "octocat"})
