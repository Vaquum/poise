import json
import os
import tempfile
from io import StringIO
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from agent_interface import pr_stop_gate


class TestPrStopGate(TestCase):
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
