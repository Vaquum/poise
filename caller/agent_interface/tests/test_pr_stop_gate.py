import json
import os
import tempfile
from io import StringIO
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from agent_interface import pr_stop_gate


ACCOUNTS = {"GITHUB_INTERFACE_AGENT_USER": "agent-account", "CALLER_PR_REVIEWER": "", "CALLER_GITHUB_READER": ""}


class TestPrStopGate(TestCase):
    def setUp(self) -> None:
        accounts = patch.dict(os.environ, ACCOUNTS)
        accounts.start()
        self.addCleanup(accounts.stop)

    def test_codex_uses_its_supported_stop_response_contract(self) -> None:
        with patch.dict(os.environ, {"CALLER_HOOK_CLIENT": "codex"}):
            result = pr_stop_gate._block("not green")

        self.assertIs(result["continue"], False)
        self.assertEqual(result["stopReason"], "not green")

    def test_stop_checks_repo_mutated_from_a_different_session_cwd(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            state = Path(root) / "state"
            session = "session-1"
            scratch = str((Path(root) / "scratch" / "limen").resolve())
            control = str((Path(root) / "control").resolve())
            (Path(scratch) / ".git").mkdir(parents=True)
            with patch.object(pr_stop_gate, "STATE_DIR", state):
                pr_stop_gate.handle({
                    "hook_event_name": "PostToolUse",
                    "session_id": session,
                    "cwd": control,
                    "tool_name": "Bash",
                    "tool_input": {
                        "command": f'cd "{scratch}" && git commit -m fix && git push',
                    },
                })
                with patch.object(
                    pr_stop_gate,
                    "_interface",
                    side_effect=self._blocked_interface(scratch),
                ):
                    result = pr_stop_gate.handle({
                        "hook_event_name": "Stop",
                        "session_id": session,
                        "cwd": control,
                        "last_assistant_message": "The PR is ready to merge.",
                    })

            self.assertEqual(result["decision"], "block")
            self.assertIn("Vaquum/Limen#757", result["reason"])
            self.assertIn("required_checks_not_green", result["reason"])

    def test_green_tracked_scratch_pr_clears_the_session_marker(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            state = Path(root) / "state"
            session = "session-2"
            scratch = str((Path(root) / "scratch" / "limen").resolve())
            control = str((Path(root) / "control").resolve())
            (Path(scratch) / ".git").mkdir(parents=True)
            with patch.object(pr_stop_gate, "STATE_DIR", state):
                pr_stop_gate.handle({
                    "hook_event_name": "PostToolUse",
                    "session_id": session,
                    "cwd": control,
                    "tool_name": "Bash",
                    "tool_input": {"command": f'git -C "{scratch}" push'},
                })
                self.assertTrue(pr_stop_gate._marker(session).exists())
                with patch.object(
                    pr_stop_gate,
                    "_interface",
                    side_effect=self._green_interface(scratch),
                ):
                    result = pr_stop_gate.handle({
                        "hook_event_name": "Stop",
                        "session_id": session,
                        "cwd": control,
                        "last_assistant_message": "Everything is green.",
                    })
                marker = pr_stop_gate._marker(session)

            self.assertIsNone(result)
            self.assertFalse(marker.exists())

    def test_missing_candidate_does_not_prevent_checking_good_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            state = Path(root) / "state"
            state.mkdir()
            session = "session-mixed"
            control = str((Path(root) / "control").resolve())
            missing = str((Path(root) / "deleted-scratch").resolve())
            good = str((Path(root) / "good").resolve())
            (Path(good) / ".git").mkdir(parents=True)

            def interface(args, cwd):
                if cwd == missing:
                    raise FileNotFoundError(cwd)
                if args[0] == "--current-pr":
                    if cwd != good:
                        return {"action": "current_pr", "found": False}
                    return {
                        "action": "current_pr",
                        "found": True,
                        "repository": "Vaquum/Limen",
                        "pull_number": 757,
                        "head_sha": "a" * 40,
                    }
                return {"action": "pr_readiness", "green": True, "blockers": []}

            with patch.object(pr_stop_gate, "STATE_DIR", state):
                pr_stop_gate._marker(session).write_text(
                    json.dumps({"candidate_cwds": [missing, good]}) + "\n"
                )
                with patch.object(
                    pr_stop_gate,
                    "_interface",
                    side_effect=interface,
                ) as interface:
                    result = pr_stop_gate.handle(
                        {
                            "hook_event_name": "Stop",
                            "session_id": session,
                            "cwd": control,
                            "last_assistant_message": "Everything is green.",
                        }
                    )

            self.assertIsNone(result)
            self.assertIn(good, [call.args[1] for call in interface.call_args_list])

    def test_non_git_candidate_without_in_scope_pr_allows_stop(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            state = Path(root) / "state"
            state.mkdir()
            session = "session-non-git"
            non_git = Path(root) / "ordinary-directory"
            non_git.mkdir()

            with patch.object(pr_stop_gate, "STATE_DIR", state):
                pr_stop_gate._marker(session).write_text(
                    json.dumps({"candidate_cwds": [str(non_git)]}) + "\n"
                )
                with patch.object(pr_stop_gate, "_interface") as interface:
                    result = pr_stop_gate.handle(
                        {
                            "hook_event_name": "Stop",
                            "session_id": session,
                            "cwd": str(non_git),
                            "last_assistant_message": "Everything is green.",
                        }
                    )

            self.assertIsNone(result)
            interface.assert_not_called()

    def test_unexpanded_variable_candidate_is_not_persisted(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            state = Path(root) / "state"
            session = "session-variable"
            repository = Path(root) / "repository"
            (repository / ".git").mkdir(parents=True)

            with patch.object(pr_stop_gate, "STATE_DIR", state):
                pr_stop_gate.handle(
                    {
                        "hook_event_name": "PostToolUse",
                        "session_id": session,
                        "cwd": str(repository),
                        "tool_name": "Bash",
                        "tool_input": {
                            "command": "cd $S/caller && git commit -m fix",
                        },
                    }
                )
                marker = json.loads(pr_stop_gate._marker(session).read_text())

            self.assertEqual(marker, {"candidate_cwds": [str(repository.resolve())]})

    def test_repeated_stop_allows_degradation_but_not_concrete_blocker(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            state = Path(root) / "state"
            state.mkdir()
            session = "session-repeated-stop"
            repository = Path(root) / "repository"
            (repository / ".git").mkdir(parents=True)

            with patch.object(pr_stop_gate, "STATE_DIR", state):
                pr_stop_gate._marker(session).write_text(
                    json.dumps({"candidate_cwds": [str(repository)]}) + "\n"
                )
                with patch.object(
                    pr_stop_gate,
                    "_interface",
                    side_effect=RuntimeError("temporary verification failure"),
                ):
                    with self.assertRaisesRegex(RuntimeError, "temporary verification failure"):
                        pr_stop_gate.handle(
                            {
                                "hook_event_name": "Stop",
                                "session_id": session,
                                "cwd": str(repository),
                            }
                        )
                    degraded = pr_stop_gate.handle(
                        {
                            "hook_event_name": "Stop",
                            "stop_hook_active": True,
                            "session_id": session,
                            "cwd": str(repository),
                        }
                    )

                with patch.object(
                    pr_stop_gate,
                    "_interface",
                    side_effect=self._blocked_interface(str(repository.resolve())),
                ):
                    blocked = pr_stop_gate.handle(
                        {
                            "hook_event_name": "Stop",
                            "stop_hook_active": True,
                            "session_id": session,
                            "cwd": str(repository),
                        }
                    )

            self.assertIsNone(degraded)
            self.assertEqual(blocked["decision"], "block")
            self.assertIn("required_checks_not_green", blocked["reason"])

    def test_repeated_stop_allows_readiness_degradation(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            state = Path(root) / "state"
            state.mkdir()
            session = "session-readiness-degraded"
            repository = Path(root) / "repository"
            (repository / ".git").mkdir(parents=True)

            def interface(args, _cwd):
                if args[0] == "--current-pr":
                    return {
                        "action": "current_pr",
                        "found": True,
                        "repository": "Vaquum/Limen",
                        "pull_number": 757,
                        "head_sha": "a" * 40,
                    }
                raise RuntimeError("readiness unavailable")

            with patch.object(pr_stop_gate, "STATE_DIR", state):
                pr_stop_gate._marker(session).write_text(
                    json.dumps({"candidate_cwds": [str(repository)]}) + "\n"
                )
                with patch.object(pr_stop_gate, "_interface", side_effect=interface):
                    with self.assertRaisesRegex(RuntimeError, "readiness unavailable"):
                        pr_stop_gate.handle(
                            {
                                "hook_event_name": "Stop",
                                "session_id": session,
                                "cwd": str(repository),
                            }
                        )
                    result = pr_stop_gate.handle(
                        {
                            "hook_event_name": "Stop",
                            "stop_hook_active": True,
                            "session_id": session,
                            "cwd": str(repository),
                        }
                    )

            self.assertIsNone(result)

    def test_repeated_stop_allows_unexpected_degradation(self) -> None:
        event = {
            "hook_event_name": "Stop",
            "stop_hook_active": True,
            "session_id": "session-unexpected-degradation",
        }
        with (
            patch.object(pr_stop_gate.sys, "stdin", StringIO(json.dumps(event))),
            patch.object(pr_stop_gate, "handle", side_effect=KeyError("unexpected")),
            patch("builtins.print") as output,
        ):
            pr_stop_gate.run()

        output.assert_not_called()

    def _stop(self, root: str, interface) -> dict | None:
        state = Path(root) / "state"
        state.mkdir()
        repository = Path(root) / "repository"
        (repository / ".git").mkdir(parents=True)
        with patch.object(pr_stop_gate, "STATE_DIR", state), patch.object(pr_stop_gate, "_interface", side_effect=interface):
            return pr_stop_gate.handle({
                "hook_event_name": "Stop",
                "session_id": "session-accounts",
                "cwd": str(repository),
                "last_assistant_message": "The PR is ready to merge.",
            })

    def test_waits_for_the_agent_accounts_approval_and_reads_as_it(self) -> None:
        calls = []
        with tempfile.TemporaryDirectory() as root:
            def interface(args, cwd):
                calls.append(args)
                return self._blocked_interface(cwd)(args, cwd)

            self._stop(root, interface)

        current, readiness = calls
        self.assertEqual(current, ["--current-pr", "--token-user", "agent-account"])
        self.assertEqual(readiness[:4], ["--pr-readiness", "#757", "--username", "agent-account"])
        self.assertEqual(readiness[-2:], ["--token-user", "agent-account"])

    def test_a_named_reviewer_and_reader_win(self) -> None:
        calls = []
        with tempfile.TemporaryDirectory() as root, \
                patch.dict(os.environ, {"CALLER_PR_REVIEWER": "review-account", "CALLER_GITHUB_READER": "person-account"}):
            def interface(args, cwd):
                calls.append(args)
                return self._blocked_interface(cwd)(args, cwd)

            self._stop(root, interface)

        current, readiness = calls
        self.assertEqual(current, ["--current-pr", "--token-user", "person-account"])
        self.assertEqual(readiness[3], "review-account")
        self.assertEqual(readiness[-2:], ["--token-user", "person-account"])

    def test_without_an_agent_account_the_gate_says_what_to_set(self) -> None:
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {"GITHUB_INTERFACE_AGENT_USER": ""}):
            with self.assertRaisesRegex(RuntimeError, "set GITHUB_INTERFACE_AGENT_USER"):
                self._stop(root, self._blocked_interface(root))

    def test_install_fixes_the_accounts_into_both_hooks(self) -> None:
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {
            "CLAUDE_SETTINGS_PATH": str(Path(root) / "claude.json"),
            "CODEX_HOOKS_PATH": str(Path(root) / "codex.json"),
            "CALLER_GITHUB_READER": "person-account",
        }):
            result = pr_stop_gate.install()
            hooks = [json.loads((Path(root) / name).read_text()) for name in ("claude.json", "codex.json")]

        for command in result["commands"].values():
            self.assertIn(" CALLER_PR_REVIEWER=agent-account CALLER_GITHUB_READER=person-account ", command)
        self.assertEqual([hook["hooks"]["Stop"][0]["hooks"][0]["command"] for hook in hooks],
                         [result["commands"]["claude"], result["commands"]["codex"]])

    def test_install_refuses_without_an_agent_account(self) -> None:
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {
            "CLAUDE_SETTINGS_PATH": str(Path(root) / "claude.json"),
            "CODEX_HOOKS_PATH": str(Path(root) / "codex.json"),
            "GITHUB_INTERFACE_AGENT_USER": "",
        }):
            with self.assertRaisesRegex(RuntimeError, "set GITHUB_INTERFACE_AGENT_USER"):
                pr_stop_gate.install()
            self.assertEqual(list(Path(root).iterdir()), [])

    @staticmethod
    def _blocked_interface(scratch: str):
        def call(args, cwd):
            if args[0] == "--current-pr":
                if cwd != scratch:
                    return {"action": "current_pr", "found": False}
                return {
                    "action": "current_pr",
                    "found": True,
                    "repository": "Vaquum/Limen",
                    "pull_number": 757,
                    "head_sha": "a" * 40,
                }
            return {"action": "pr_readiness", "green": False, "blockers": ["required_checks_not_green"]}

        return call

    @staticmethod
    def _green_interface(scratch: str):
        blocked = TestPrStopGate._blocked_interface(scratch)

        def call(args, cwd):
            if args[0] == "--pr-readiness":
                return {"action": "pr_readiness", "green": True, "blockers": []}
            return blocked(args, cwd)

        return call
