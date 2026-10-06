import io
import json
import os
import subprocess
from contextlib import redirect_stdout
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

import agent_interface
from agent_interface import atoms, pr_review, pr_approve, structured_review, review_repository
from agent_interface.model_catalog import CATALOG, ModelCatalogError
from agent_interface.review_watch import ReviewWatch

FINDING = {"path": "src/main.py", "line": 4, "side": "RIGHT", "body": "[p1] O'Brien's input crashes."}


class TestReviewModel(TestCase):
    def test_default_and_explicit_models_use_the_same_catalog(self):
        for behavior in ("pr_review", "pr_approve"):
            self.assertEqual(CATALOG.review_model(behavior).identity, "opus-5-high")
            self.assertEqual(CATALOG.review_model(behavior, "gpt-6-astra-ultra").identity, "gpt-6-astra-ultra")
            self.assertEqual(CATALOG.review_model(behavior, "fable-5.1-max").provider, "claude")
            for identity, provider in (("gpt-5.6-sol-ultra", "codex"), ("grok-4.6-xhigh", "grok"),
                                       ("gemini-3.8-flash-high", "antigravity"), ("muse-spark-1.3-contributor-max", "muse")):
                self.assertEqual(CATALOG.review_model(behavior, identity).provider, provider)
            for value in ("opus", "astra", "sol", "grok", "missing", ""):
                with self.subTest(behavior=behavior, value=value), self.assertRaises(ModelCatalogError):
                    CATALOG.review_model(behavior, value)

    def test_cli_passes_model_for_reviews_and_approvals(self):
        for flag, func in (("--pr-review", "run_pr_review"), ("--pr-approve", "run_pr_approve")):
            argv = ["agent-interface", flag, "12", "--model", "gpt-6-astra-ultra", "--recovery-model", "opus-5-max", "--actor", "bit-mis",
                    "--expected-head", "a" * 40, "--source", "poise:test", "--correlation-id", "test"]
            with patch.object(agent_interface.sys, "argv", argv), patch.object(agent_interface, func) as run:
                agent_interface.main()
                self.assertEqual(run.call_args.kwargs["model"], "gpt-6-astra-ultra")
                self.assertEqual(run.call_args.kwargs["recovery_model"], "opus-5-max")

    def test_capability_response_is_machine_readable(self):
        with patch.object(agent_interface.sys, "argv", ["agent-interface", "--models"]), redirect_stdout(io.StringIO()) as output:
            agent_interface.main()
        exported = json.loads(output.getvalue())
        self.assertEqual(exported["policy"], "bounded-v1")
        self.assertEqual(exported["behaviors"]["pr_review"], "opus-5-high")
        self.assertEqual(exported["behaviors"]["review_recovery"], "gpt-6-astra-ultra")
        self.assertEqual(exported["review_providers"], ["antigravity", "claude", "codex", "grok", "muse"])
        self.assertIn({"identity": "gpt-6-astra-ultra", "provider": "codex", "selector": "gpt-6-astra", "effort": "ultra"}, exported["models"])
        self.assertIn({"identity": "gpt-5.6-sol-max", "provider": "codex", "selector": "gpt-5.6-sol", "effort": "max"}, exported["models"])

    def test_governed_log_records_the_selected_model(self):
        with patch.object(agent_interface, "track", return_value="run") as track, \
                patch.object(agent_interface, "finish"), \
                patch.object(agent_interface, "review_facts", return_value={}), \
                patch.object(agent_interface, "behavior_outcome", return_value={"outcome": "superseded", "head_sha": "b" * 40, "action": None}), \
                patch.object(pr_review, "run", return_value="verdict") as run, redirect_stdout(io.StringIO()):
            agent_interface.run_pr_review("https://github.com/o/r/pull/1", "bit-mis", "a" * 40, "poise:test", "test", model="gpt-6-astra-ultra")
        self.assertEqual(track.call_args.args[0], "gpt-6-astra-ultra")
        self.assertEqual(run.call_args.kwargs["model"], "gpt-6-astra-ultra")

    def test_packet_and_review_rules_are_shared(self):
        for mod in (pr_review, pr_approve):
            for identity in ("gpt-6-astra-ultra", "grok-4.6-xhigh", "gemini-3.8-flash-high", "muse-spark-1.3-contributor-max"):
                repository = SimpleNamespace(prompt=lambda: "repo guidance", root=Path("/tmp/review"))
                with patch.object(atoms, "packet", return_value="immutable packet"), patch.object(atoms, "run_agent") as run, \
                        patch.object(review_repository, "prepare", return_value=nullcontext(repository)):
                    mod.run("/tmp", "12", "bit-mis", "a" * 40, note="memory", p="p1", model=identity)
                    text = run.call_args.args[2]
                    self.assertIn("immutable packet", text)
                    self.assertIn("memory", text)
                    self.assertIn("p0/p1", text)
                    self.assertIn(atoms.STRUCTURED_POLICY, text)
                    self.assertEqual(run.call_args.args[3], [])

    def test_every_provider_but_claude_reviews_through_the_structured_runner(self):
        for identity in ("gpt-6-astra-ultra", "grok-4.6-xhigh", "gemini-3.8-flash-high", "muse-spark-1.3-contributor-max"):
            with patch.object(structured_review, "run", return_value="verdict") as run:
                self.assertEqual(atoms.run_agent("/repo", "system", "packet", [], "pr_review", 60, model=identity,
                                                 pr="https://github.com/o/r/pull/1", actor_name="bit-mis", head="a" * 40), "verdict")
            self.assertEqual(run.call_args.args[3].identity, identity)


class TestStructuredVerdict(TestCase):
    def _run(self, verdict, behavior="pr_review", event=None, code=0):
        def process(args, **kwargs):
            if args[0] == "github-interface":
                return SimpleNamespace(returncode=0, stdout="submitted", stderr="")
            Path(args[args.index("--output-last-message") + 1]).write_text(json.dumps(verdict))
            return SimpleNamespace(returncode=code, stdout=json.dumps(event) if event else "", stderr="provider failed" if code else "")
        with patch.object(structured_review.subprocess, "run", side_effect=process) as run, \
                patch.object(ReviewWatch, "run", side_effect=run):
            try:
                result = structured_review.run("/repo", "system", "packet", CATALOG.resolve("gpt-6-astra-ultra"), behavior, "https://github.com/o/r/pull/12", "bit-mis", "a" * 40, 60)
            except atoms.AgentPreflightError:
                self.assertEqual(run.call_count, 1)
                raise
        return result, run

    def test_submits_exactly_one_atomic_review_with_fixed_target(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key", "CODEX_API_KEY": "test-key"}):
            result, run = self._run({"action": "request_changes", "comments": [FINDING]})
        self.assertIn("submitted", result)
        self.assertEqual(run.call_count, 2)
        model_call, mutation = run.call_args_list
        args = model_call.args[0]
        self.assertEqual(args[args.index("--model") + 1], "gpt-6-astra")
        self.assertIn('model_reasoning_effort="ultra"', args)
        self.assertIn("--ignore-user-config", args)
        self.assertIn('forced_login_method="chatgpt"', args)
        self.assertEqual(args[args.index("--sandbox") + 1], "read-only")
        self.assertNotIn("--dangerously-bypass-approvals-and-sandbox", args)
        self.assertIn("shell_tool", args)
        self.assertEqual(model_call.kwargs["input"], "system\n\npacket")
        self.assertNotEqual(model_call.kwargs["cwd"], "/repo")
        self.assertNotIn("OPENAI_API_KEY", model_call.kwargs["env"])
        self.assertNotIn("CODEX_API_KEY", model_call.kwargs["env"])
        self.assertEqual(mutation.args[0], ["github-interface", "--request-changes", "#12", "--comments-json",
                                          json.dumps([FINDING]), "--expected-head", "a" * 40, "--token-user", "bit-mis"])
        self.assertEqual(mutation.kwargs["cwd"], "/repo")

    def test_clean_and_approval_are_distinct_terminal_actions(self):
        for behavior, action, flag in (("pr_review", "reviewed_clean", "--reviewed-clean"), ("pr_approve", "approve", "--approve-pr")):
            with self.subTest(behavior=behavior):
                _, run = self._run({"action": action, "comments": []}, behavior)
                self.assertEqual(run.call_args.args[0][1], flag)

    def test_malformed_or_conflicting_verdicts_never_submit(self):
        verdicts = [None, {}, {"action": "approve", "comments": []},
                    {"action": "request_changes", "comments": []},
                    {"action": "reviewed_clean", "comments": [FINDING]},
                    {"action": "request_changes", "comments": [{**FINDING, "line": True}]},
                    {"action": "request_changes", "comments": [FINDING] * 101},
                    {"action": "reviewed_clean", "comments": [], "head": "b" * 40}]
        for verdict in verdicts:
            with self.subTest(verdict=verdict), self.assertRaises(atoms.AgentPreflightError):
                self._run(verdict)

    def test_provider_failure_and_tool_use_do_not_submit(self):
        for kwargs in ({"code": 1}, {"event": {"item": {"type": "command_execution"}}}):
            with self.subTest(kwargs=kwargs), self.assertRaises(atoms.AgentPreflightError):
                self._run({"action": "reviewed_clean", "comments": []}, **kwargs)

    def test_disabled_tool_notice_does_not_reject_a_completed_verdict(self):
        _, run = self._run({"action": "reviewed_clean", "comments": []},
                          event={"type": "item.completed", "item": {"type": "error", "message": "Code mode is disabled"}})
        self.assertEqual(run.call_count, 2)

    def test_turn_failure_cannot_submit_even_with_output_and_zero_exit(self):
        with self.assertRaises(atoms.AgentPreflightError):
            self._run({"action": "reviewed_clean", "comments": []}, event={"type": "turn.failed"})

    def test_timeout_is_proven_no_action_before_submission(self):
        with patch.object(ReviewWatch, "run", side_effect=subprocess.TimeoutExpired("codex", 60)) as run, \
                self.assertRaises(agent_interface.review_budget.ReviewLimitError):
            structured_review.run("/repo", "system", "packet", CATALOG.resolve("gpt-6-astra-ultra"), "pr_review", "https://github.com/o/r/pull/12", "bit-mis", "a" * 40, 60)
        self.assertEqual(run.call_count, 1)


GROK_REPLY = {"text": "{}", "stopReason": "end_turn", "num_turns": 1, "structuredOutput": None}
AGY_RESULT = {"conversation_id": "c1", "status": "SUCCESS", "num_turns": 2, "structured_output": None}


def agy_stream(result: dict, steps=("user_input", "agent_response", "user_input", "agent_response", "finish")) -> str:
    lines = [{"event": "init", "conversation_id": "c1"}]
    lines += [{"event": "step_update", "step_update": {"step_index": i, "state": "DONE", "step_type": step}} for i, step in enumerate(steps)]
    lines.append({"event": "result", "result": result})
    return "\n".join(json.dumps(line) for line in lines) + "\n"


def muse_stream(text: str | None, tasks=("model.meta.response",), terminal="completed") -> str:
    lines = [{"payload_type": "run.lifecycle.started", "payload": {"kind": "run_started"}}]
    lines += [{"payload_type": "task.lifecycle.proposed", "payload": {"kind": "task_lifecycle", "event": {"kind": "proposed", "task_kind": task}}} for task in tasks]
    if text is not None:
        lines.append({"payload_type": "run.output.delta", "payload": {"kind": "run_output_delta", "text": text}})
    lines.append({"payload_type": f"run.terminal.{terminal}", "payload": {"kind": "run_terminal", "terminal": terminal, "text": text, "reason": None}})
    return "\n".join(json.dumps(line) for line in lines) + "\n"


class TestOtherProviderVerdicts(TestCase):
    """Grok, Antigravity and Muse answer with the same verdict the Codex path submits."""

    def _run(self, identity, stdout, behavior="pr_review", code=0):
        calls = []

        def provider(args, **kwargs):
            calls.append((args, kwargs))
            return SimpleNamespace(returncode=code, stdout=stdout, stderr="provider failed" if code else "")

        def github(args, **kwargs):
            calls.append((args, kwargs))
            return SimpleNamespace(returncode=0, stdout="submitted", stderr="")

        with patch.object(structured_review.subprocess, "run", side_effect=github), \
                patch.object(ReviewWatch, "run", side_effect=provider):
            result = structured_review.run("/repo", "system", "packet", CATALOG.resolve(identity), behavior,
                                           "https://github.com/o/r/pull/12", "bit-mis", "a" * 40, 60)
        return result, calls

    def test_grok_runs_one_tool_free_turn_from_a_prompt_file_and_submits(self):
        reply = {**GROK_REPLY, "structuredOutput": {"action": "request_changes", "comments": [FINDING]}}
        result, calls = self._run("grok-4.6-xhigh", json.dumps(reply))
        self.assertIn("submitted", result)
        (args, kwargs), (mutation, _) = calls
        self.assertEqual(Path(args[0]).name, "grok")
        self.assertEqual(args[args.index("-m") + 1], "grok-4.6")
        self.assertEqual(args[args.index("--effort") + 1], "xhigh")
        self.assertEqual(args[args.index("--tools") + 1], "")
        self.assertEqual(args[args.index("--max-turns") + 1], "1")
        self.assertEqual(args[args.index("--permission-mode") + 1], "dontAsk")
        self.assertEqual(args[args.index("--output-format") + 1], "json")
        self.assertEqual(json.loads(args[args.index("--json-schema") + 1]), structured_review.verdict_schema("pr_review"))
        self.assertNotEqual(kwargs["cwd"], "/repo")
        self.assertIsNone(kwargs["provider"])
        self.assertNotIn("packet", " ".join(args))
        self.assertEqual(mutation[:5], ["github-interface", "--request-changes", "#12", "--comments-json", json.dumps([FINDING])])

    def test_grok_prompt_carries_the_packet_and_the_schema(self):
        seen = {}

        def provider(args, **kwargs):
            seen["prompt"] = Path(args[args.index("--prompt-file") + 1]).read_text()
            reply = {**GROK_REPLY, "structuredOutput": {"action": "reviewed_clean", "comments": []}}
            return SimpleNamespace(returncode=0, stdout=json.dumps(reply), stderr="")

        with patch.object(structured_review.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="ok", stderr="")), \
                patch.object(ReviewWatch, "run", side_effect=provider):
            structured_review.run("/repo", "system", "packet", CATALOG.resolve("grok-4.6-high"), "pr_review",
                                  "https://github.com/o/r/pull/12", "bit-mis", "a" * 40, 60)
        self.assertTrue(seen["prompt"].startswith("system\n\npacket"))
        self.assertIn('"reviewed_clean"', seen["prompt"])
        self.assertIn("no code fence", seen["prompt"])

    def test_grok_rejects_extra_turns_missing_output_and_failures(self):
        for stdout, code in ((json.dumps({**GROK_REPLY, "structuredOutput": {"action": "reviewed_clean", "comments": []}, "num_turns": 2}), 0),
                             (json.dumps({**GROK_REPLY, "stopReason": "max_turns"}), 0),
                             (json.dumps({**GROK_REPLY, "text": '{"action":"reviewed_clean","comments":[]}'}), 0),
                             ("not json", 0),
                             (json.dumps({**GROK_REPLY, "structuredOutput": {"action": "reviewed_clean", "comments": []}}), 1)):
            with self.subTest(stdout=stdout, code=code), self.assertRaises(atoms.AgentPreflightError):
                self._run("grok-4.6-xhigh", stdout, code=code)

    def test_antigravity_streams_the_packet_in_plan_mode_and_submits(self):
        result_event = {**AGY_RESULT, "structured_output": {"action": "approve", "comments": []}}
        result, calls = self._run("gemini-3.8-flash-high", agy_stream(result_event), behavior="pr_approve")
        self.assertIn("submitted", result)
        (args, kwargs), (mutation, _) = calls
        self.assertEqual(Path(args[0]).name, "agy")
        self.assertIn("--print=", args)
        self.assertEqual(args[args.index("--input-format") + 1], "stream-json")
        self.assertEqual(args[args.index("--output-format") + 1], "stream-json")
        self.assertEqual(args[args.index("--mode") + 1], "plan")
        self.assertEqual(args[args.index("--model") + 1], "gemini-3.8-flash")
        self.assertEqual(args[args.index("--effort") + 1], "high")
        self.assertTrue(args[args.index("--json-schema") + 1].endswith("verdict.schema.json"))
        self.assertEqual(args[args.index("--print-timeout") + 1], "60s")
        message = json.loads(kwargs["input"])
        self.assertEqual(message["event"], "user")
        self.assertTrue(message["message"]["content"].startswith("system\n\npacket"))
        self.assertEqual(kwargs["provider"], "antigravity")
        self.assertEqual(mutation[:3], ["github-interface", "--approve-pr", "#12"])

    def test_antigravity_rejects_tool_steps_errors_and_missing_results(self):
        clean = {**AGY_RESULT, "structured_output": {"action": "reviewed_clean", "comments": []}}
        for stdout in (agy_stream(clean, steps=("user_input", "agent_response", "tool", "agent_response", "finish")),
                       agy_stream({**clean, "status": "ERROR", "error": "quota"}),
                       agy_stream({**AGY_RESULT, "response": '{"action":"reviewed_clean","comments":[]}'}),
                       json.dumps({"event": "init"}) + "\n"):
            with self.subTest(stdout=stdout), self.assertRaises(atoms.AgentPreflightError):
                self._run("gemini-3.8-flash-high", stdout)

    def test_muse_answers_from_a_prompt_file_with_tools_off_and_submits(self):
        result, calls = self._run("muse-spark-1.3-contributor-max", muse_stream('```json\n{"action": "reviewed_clean", "comments": []}\n```'))
        self.assertIn("submitted", result)
        (args, kwargs), (mutation, _) = calls
        self.assertEqual(Path(args[0]).name, "muse")
        self.assertEqual(args[1], "exec")
        self.assertEqual(args[args.index("--model") + 1], "muse-spark-1.3-contributor")
        self.assertEqual(args[args.index("--reasoning-effort") + 1], "max")
        for flag in ("--disable-shell", "--disable-write", "--disable-web-tools", "--no-session-log", "--json"):
            self.assertIn(flag, args)
        self.assertEqual(args[args.index("--approval-mode") + 1], "never")
        self.assertEqual(args[args.index("--workspace") + 1], kwargs["cwd"])
        self.assertNotEqual(kwargs["cwd"], "/repo")
        self.assertEqual(kwargs["provider"], "muse")
        self.assertEqual(mutation[:3], ["github-interface", "--reviewed-clean", "#12"])

    def test_muse_rejects_tool_use_prose_and_failed_runs(self):
        clean = '{"action": "reviewed_clean", "comments": []}'
        for stdout in (muse_stream(clean, tasks=("model.meta.response", "tool.read_file", "model.meta.response")),
                       muse_stream("Looks good to me: " + clean),
                       muse_stream(None),
                       muse_stream(clean, terminal="failed")):
            with self.subTest(stdout=stdout), self.assertRaises(atoms.AgentPreflightError):
                self._run("muse-spark-1.3-contributor-max", stdout)

    def test_unfenced_accepts_one_fenced_object_only(self):
        self.assertEqual(structured_review.unfenced('```json\n{"a": 1}\n```\n'), '{"a": 1}')
        self.assertEqual(structured_review.unfenced('  {"a": 1} '), '{"a": 1}')
        self.assertEqual(structured_review.unfenced('```\n{"a": 1}\n```'), '{"a": 1}')
        self.assertEqual(structured_review.unfenced('Sure:\n```json\n{"a": 1}\n```'), 'Sure:\n```json\n{"a": 1}\n```')
