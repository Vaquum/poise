import gc
import io
import json
import os
import subprocess
import sys
import tempfile
import tracemalloc
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
MUSE_SESSION_ERROR = "muse: local session messaging disabled: session logging is required"


def scripted_muse(directory: Path) -> Path:
    """A muse CLI that enforces the session-logging requirement: it fails
    exactly like the observed startup error when session logging is off,
    and otherwise records its arguments and writes one session file."""
    script = directory / "muse"
    script.write_text(
        f"#!{sys.executable}\n"
        "import os, sys\n"
        "if '--no-session-log' in sys.argv[1:]:\n"
        f"    sys.stderr.write({MUSE_SESSION_ERROR!r} + '\\n')\n"
        "    sys.exit(1)\n"
        "store = os.path.join(os.environ['XDG_DATA_HOME'], 'muse', 'sessions')\n"
        "os.makedirs(store, exist_ok=True)\n"
        "with open(os.path.join(store, 'probe'), 'w') as handle:\n"
        "    handle.write('session log\\n')\n"
        "with open(os.environ['MUSE_ARGV_LOG'], 'w') as handle:\n"
        "    handle.write('\\n'.join(sys.argv[1:]))\n"
        "reply = os.environ.get('MUSE_SCRIPT_REPLY')\n"
        "if reply:\n"
        "    with open(reply) as handle:\n"
        "        sys.stdout.write(handle.read())\n"
    )
    script.chmod(0o700)
    return script


class TestReviewModel(TestCase):
    def test_structured_prompt_admission_uses_the_three_mb_utf8_boundary(self):
        prompt = "é" * 1_500_000
        structured_review._admit(prompt)
        with self.assertRaises(atoms.AgentPreflightError) as caught:
            structured_review._admit(prompt + "x")
        self.assertEqual(caught.exception.code, "review_packet_too_large")
        self.assertEqual(caught.exception.diagnostic["context"]["actual_input_bytes"], 3_000_001)

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
                        patch.object(atoms, "last_reviewed_head", return_value=None), \
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
    def test_codex_resumes_only_its_review_with_new_inspection_evidence(self):
        thread = "01234567-89ab-4cde-8123-456789abcdef"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            watch = SimpleNamespace(run=lambda *args, **kwargs: None)
            def process(args, **kwargs):
                Path(args[args.index("--output-last-message") + 1]).write_text('{"action":"reviewed_clean","comments":[]}')
                return SimpleNamespace(returncode=0, stdout=json.dumps({"type":"thread.started","thread_id":thread}), stderr="")
            with patch.object(watch, "run", side_effect=process) as run:
                first = "immutable packet\n\nInspection rounds remaining: 12."
                second = "immutable packet\n\nPrevious review step: inspected consumer\n\nInspection rounds remaining: 11."
                model = CATALOG.resolve("gpt-6-astra-max")
                structured_review.ask_codex(root, model, "system", first, {}, watch, 60)
                structured_review.ask_codex(root, model, "system", second, {}, watch, 60)
                initial, resumed = run.call_args_list
                self.assertNotIn("resume", initial.args[0])
                self.assertNotIn("--ephemeral", initial.args[0])
                self.assertEqual(resumed.args[0][-3:], ["resume", thread, "-"])
                self.assertNotIn("immutable packet", resumed.kwargs["input"])
                self.assertIn("inspected consumer", resumed.kwargs["input"])
                self.assertEqual(resumed.args[0][resumed.args[0].index("--sandbox") + 1], "read-only")
                self.assertIn("shell_tool", resumed.args[0])
                self.assertIn("multi_agent", resumed.args[0])
                self.assertNotIn("--last", resumed.args[0])

    def test_codex_rejects_an_unrelated_resumed_thread(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            watch = SimpleNamespace(run=lambda *args, **kwargs: None)
            threads = iter(["01234567-89ab-4cde-8123-456789abcdef", "01234567-89ab-4cde-8123-456789abcdea"])
            def process(args, **kwargs):
                Path(args[args.index("--output-last-message") + 1]).write_text('{"action":"reviewed_clean","comments":[]}')
                return SimpleNamespace(returncode=0, stdout=json.dumps({"type":"thread.started","thread_id":next(threads)}), stderr="")
            with patch.object(watch, "run", side_effect=process):
                model = CATALOG.resolve("gpt-6-astra-max")
                structured_review.ask_codex(root, model, "system", "packet", {}, watch, 60)
                with self.assertRaisesRegex(structured_review.InvalidVerdict, "different review conversation"):
                    structured_review.ask_codex(root, model, "system", "packet plus inspection", {}, watch, 60)

    def _run(self, verdict, behavior="pr_review", event=None, code=0):
        def process(args, **kwargs):
            if args[0] == "github-interface":
                action = {"--request-changes": "requested_changes", "--reviewed-clean": "reviewed_clean",
                          "--approve-pr": "approved_pr"}[args[1]]
                return SimpleNamespace(returncode=0, stdout=json.dumps(
                    {"action": action, "review_id": 91, "head_sha": "a" * 40}), stderr="")
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
        self.assertIn('"review_id": 91', result)
        self.assertEqual(run.call_count, 2)
        model_call, mutation = run.call_args_list
        args = model_call.args[0]
        self.assertEqual(args[args.index("--model") + 1], "gpt-6-astra")
        self.assertIn('model_reasoning_effort="ultra"', args)
        self.assertIn('model_reasoning_summary="auto"', args)
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

    def test_stale_head_refusal_at_submit_is_superseded_not_a_violation(self):
        from agent_interface.review_watch import ReviewSuperseded

        def process(args, **kwargs):
            if args[0] == "github-interface":
                return SimpleNamespace(returncode=1, stdout="",
                                       stderr="error: pull-request head changed: expected %s, got %s" % ("a" * 40, "b" * 40))
            Path(args[args.index("--output-last-message") + 1]).write_text(
                json.dumps({"action": "request_changes", "comments": [FINDING]}))
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        with patch.object(structured_review.subprocess, "run", side_effect=process), \
                patch.object(ReviewWatch, "run", side_effect=process):
            with self.assertRaises(ReviewSuperseded) as raised:
                structured_review.run("/repo", "system", "packet", CATALOG.resolve("gpt-6-astra-ultra"),
                                      "pr_approve", "https://github.com/o/r/pull/12", "bit-mis", "a" * 40, 60)
        self.assertEqual(raised.exception.head_sha, "b" * 40)

    def test_unresolved_conversation_refusal_is_blocked_not_a_violation(self):
        from agent_interface import review_receipt

        def process(args, **kwargs):
            if args[0] == "github-interface":
                return SimpleNamespace(returncode=1, stdout="",
                                       stderr="error: 1 unresolved review conversation(s) from other reviewers remain")
            Path(args[args.index("--output-last-message") + 1]).write_text(
                json.dumps({"action": "approve", "comments": []}))
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        with patch.object(structured_review.subprocess, "run", side_effect=process), \
                patch.object(ReviewWatch, "run", side_effect=process):
            with self.assertRaises(agent_interface.review_budget.ReviewLimitError) as failure:
                structured_review.run("/repo", "system", "packet", CATALOG.resolve("gpt-6-astra-ultra"),
                                      "pr_approve", "https://github.com/o/r/pull/12", "bit-mis", "a" * 40, 60)
        self.assertEqual(failure.exception.code, "approval_blocked_unresolved_conversations")
        self.assertIn("blocked", str(failure.exception))
        self.assertIn("1 unresolved review conversation(s) from other reviewers remain", str(failure.exception))
        self.assertEqual(failure.exception.diagnostic["submission"], "blocked")
        self.assertIsNone(review_receipt.get())

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


def staged_packet(paths):
    diff = "\n".join(
        f"diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -1 +1 @@\n-old\n+new"
        for path in paths)
    return json.dumps({"action": "read", "repository": "o/r", "pull_number": 12, "head_sha": "a" * 40,
                       "diff": diff, "files": [{"filename": path, "status": "modified",
                                                "old_mode": "100644", "new_mode": "100644"} for path in paths],
                       "excluded_files": [], "review_scope": "Review the complete retained diff."},
                      separators=(",", ":"))


class TestStagedReview(TestCase):
    def _run(self, packet, verdicts, text_packet=None):
        pending = list(verdicts)
        calls = []

        def process(args, **kwargs):
            calls.append((args, kwargs))
            if args[0] == "github-interface":
                action = {"--request-changes": "requested_changes", "--reviewed-clean": "reviewed_clean",
                          "--approve-pr": "approved_pr"}[args[1]]
                return SimpleNamespace(returncode=0, stdout=json.dumps(
                    {"action": action, "review_id": 91, "head_sha": "a" * 40}), stderr="")
            Path(args[args.index("--output-last-message") + 1]).write_text(json.dumps(pending.pop(0)))
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        text = f"policy\n\nPR packet:\n{text_packet or packet}\n\nAllowed:\nnone"
        with patch.object(structured_review.subprocess, "run", side_effect=process), \
                patch.object(ReviewWatch, "run", side_effect=process):
            result = structured_review.run("/repo", "system", text, CATALOG.resolve("gpt-6-astra-ultra"),
                                           "pr_review", "https://github.com/o/r/pull/12", "bit-mis",
                                           "a" * 40, 60, packet=packet)
        return result, calls

    def test_group_findings_combine_into_one_head_pinned_verdict(self):
        first = {"path": "src/f00.py", "line": 1, "side": "RIGHT", "body": "first group defect"}
        second = {"path": "src/f08.py", "line": 1, "side": "RIGHT", "body": "second group defect"}
        packet = staged_packet([f"src/f{i:02d}.py" for i in range(9)])
        result, calls = self._run(packet, [{"action": "request_changes", "comments": [first]},
                                           {"action": "request_changes", "comments": [second]}])
        self.assertIn('"review_id": 91', result)
        self.assertEqual(len(calls), 3)
        (first_args, first_kwargs), (second_args, second_kwargs), (mutation, _) = calls
        self.assertIn("file group 1 of 2", first_kwargs["input"])
        self.assertIn("src/f00.py", first_kwargs["input"])
        self.assertNotIn("src/f08.py", first_kwargs["input"])
        self.assertIn("file group 2 of 2", second_kwargs["input"])
        self.assertIn("Findings already recorded in earlier file groups", second_kwargs["input"])
        self.assertIn("first group defect", second_kwargs["input"])
        self.assertEqual(mutation[:4], ["github-interface", "--request-changes", "#12", "--comments-json"])
        self.assertEqual(json.loads(mutation[4]), [first, second])
        self.assertEqual(mutation[5:], ["--expected-head", "a" * 40, "--token-user", "bit-mis"])

    def test_clean_groups_combine_into_one_clean_verdict(self):
        packet = staged_packet([f"src/f{i:02d}.py" for i in range(9)])
        result, calls = self._run(packet, [{"action": "reviewed_clean", "comments": []},
                                           {"action": "reviewed_clean", "comments": []}])
        self.assertIn('"review_id": 91', result)
        self.assertEqual(calls[-1][0][1], "--reviewed-clean")

    def test_small_packet_with_packet_runs_one_unchanged_stage(self):
        packet = staged_packet(["src/only.py"])
        result, calls = self._run(packet, [{"action": "reviewed_clean", "comments": []}])
        self.assertIn('"review_id": 91', result)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0][1]["input"], f"system\n\npolicy\n\nPR packet:\n{packet}\n\nAllowed:\nnone")
        self.assertNotIn("file group", calls[0][1]["input"])

    def test_mismatched_packet_and_prompt_is_a_contract_violation(self):
        packet = staged_packet([f"src/f{i:02d}.py" for i in range(9)])
        with self.assertRaises(atoms.AgentPreflightError) as failure:
            self._run(packet, [{"action": "reviewed_clean", "comments": []}],
                      text_packet=staged_packet(["src/other.py"]))
        self.assertEqual(failure.exception.code, "review_contract_violation")

    def test_stages_keep_repository_inspection_with_one_combined_submission(self):
        request = {"operation": "read", "path": "src/old.py", "query": "", "start_line": 1}
        calls = []

        def ask(root, model, system, text, schema, watch, timeout):
            calls.append(text)
            self.assertIn("requests", schema["required"])
            if "file group 1 of 2" in text and "Previous review step" not in text:
                return json.dumps({"action": "inspect", "comments": [], "requests": [request]})
            path = "src/f00.py" if "file group 1 of 2" in text else "src/f08.py"
            finding = {"path": path, "line": 1, "side": "RIGHT", "body": "defect"}
            return json.dumps({"action": "request_changes", "comments": [finding], "requests": []})

        repo = review_repository.Repository(Path("/tmp/review"), {"head_sha": "a" * 40})
        inspected = {"action": "review_context", "head_sha": "a" * 40, "results": []}
        packet = staged_packet([f"src/f{i:02d}.py" for i in range(9)])
        text = f"policy\n\nPR packet:\n{packet}\n\nAllowed:\nnone"
        receipt = json.dumps({"action": "requested_changes", "review_id": 91, "head_sha": "a" * 40})
        with patch.dict(structured_review.ASK, {"codex": ask}), \
                patch.object(repo, "inspect", return_value=inspected) as inspect, \
                patch.object(structured_review.subprocess, "run",
                             return_value=SimpleNamespace(returncode=0, stdout=receipt, stderr="")) as submit:
            structured_review.run("/repo", "system", text, CATALOG.resolve("gpt-6-astra-ultra"), "pr_review",
                                  "https://github.com/o/r/pull/12", "bit-mis", "a" * 40, 60,
                                  repository=repo, packet=packet)
        inspect.assert_called_once_with([request])
        submit.assert_called_once()
        self.assertEqual(len(calls), 3)
        self.assertIn("file group 2 of 2", calls[2])
        self.assertEqual(len(json.loads(submit.call_args.args[0][4])), 2)


class TestBoundedStagePrompts(TestCase):
    def test_stage_prompts_stream_one_at_a_time(self):
        paths = [f"src/f{i:04d}.py" for i in range(1000)]
        node = json.loads(staged_packet(paths))
        node["review_threads"] = [{"path": paths[0], "line": 1, "side": "RIGHT", "bodies": ["c" * 60_000]}
                                  for _ in range(16)]
        packet = json.dumps(node)
        self.assertLess(len(packet.encode()), 1_450_000)
        text = f"policy\n\nPR packet:\n{packet}\n\nAllowed:\nnone"
        self.assertFalse(isinstance(structured_review._stage_texts(text, packet), list),
                         "stage prompts must stream, not materialize every prompt")
        gc.collect()
        tracemalloc.start()
        try:
            total, count = 0, 0
            for prompt in structured_review._stage_texts(text, packet):
                total += len(prompt.encode())
                count += 1
            peak = tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()
        self.assertEqual(count, 125)
        self.assertGreater(total, 100_000_000)
        self.assertLess(peak, total // 8)


class TestApproveSinceHead(TestCase):
    def _run(self, since, packets):
        with patch.object(atoms, "last_reviewed_head", return_value=since) as history, \
                patch.object(atoms, "packet", side_effect=packets) as packet, \
                patch.object(atoms, "run_agent", return_value="verdict") as run:
            self.assertEqual(pr_approve.run("/tmp", "12", "bit-mis", "a" * 40, model="gpt-6-astra-ultra"), "verdict")
        return history, packet, run

    def test_follow_up_reviews_the_diff_since_the_last_reviewed_head(self):
        _, packet, run = self._run("c" * 40, ["since packet"])
        packet.assert_called_once_with("/tmp", "12", "bit-mis", "a" * 40, None, since_head="c" * 40)
        self.assertIn("since packet", run.call_args.args[2])

    def test_same_head_reviews_the_full_packet(self):
        _, packet, _ = self._run("a" * 40, ["full packet"])
        packet.assert_called_once_with("/tmp", "12", "bit-mis", "a" * 40, None, since_head=None)

    def test_first_review_has_no_since_head(self):
        _, packet, _ = self._run(None, ["full packet"])
        packet.assert_called_once_with("/tmp", "12", "bit-mis", "a" * 40, None, since_head=None)

    def test_unfetchable_since_head_falls_back_to_the_full_diff(self):
        unknown = atoms.AgentPreflightError("error: review_since_head_unknown: gone", "review_since_head_unknown")
        _, packet, run = self._run("c" * 40, [unknown, "full packet"])
        self.assertEqual(packet.call_count, 2)
        self.assertEqual(packet.call_args_list[0].kwargs, {"since_head": "c" * 40})
        self.assertEqual(packet.call_args_list[1].kwargs, {"since_head": None})
        self.assertIn("full packet", run.call_args.args[2])
        self.assertIn("c" * 40, run.call_args.args[2])

    def test_other_packet_failures_do_not_fall_back(self):
        with patch.object(atoms, "last_reviewed_head", return_value="c" * 40), \
                patch.object(atoms, "packet",
                             side_effect=atoms.AgentPreflightError("too large", "review_packet_too_large")) as packet, \
                patch.object(atoms, "run_agent") as run:
            with self.assertRaises(atoms.AgentPreflightError):
                pr_approve.run("/tmp", "12", "bit-mis", "a" * 40, model="gpt-6-astra-ultra")
        packet.assert_called_once()
        run.assert_not_called()


class TestSincePositions(TestCase):
    REMOVAL = "\n".join(["diff --git a/src/gone.py b/src/gone.py", "--- a/src/gone.py", "+++ b/src/gone.py",
                         "@@ -10,3 +10,2 @@", " context", "-removed", " context2"])

    def _packet(self, since, diff=None, paths=("src/gone.py",)):
        node = json.loads(staged_packet(list(paths)))
        node["p"] = "p2"
        node["since_head_sha"] = since
        if diff is not None:
            node["diff"] = diff
        return json.dumps(node)

    def _full(self, diff, paths=("src/gone.py",)):
        node = json.loads(staged_packet(list(paths)))
        node["diff"] = diff
        return json.dumps(node)

    def _run(self, packet, verdict, full, **options):
        calls = []

        def process(args, **kwargs):
            calls.append((args, kwargs))
            if args[0] == "github-interface":
                return SimpleNamespace(returncode=0, stdout=json.dumps(
                    {"action": "requested_changes", "review_id": 91, "head_sha": "a" * 40}), stderr="")
            Path(args[args.index("--output-last-message") + 1]).write_text(json.dumps(verdict))
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        text = f"policy\n\nPR packet:\n{packet}\n\nAllowed:\nnone"
        with patch.object(structured_review.subprocess, "run", side_effect=process), \
                patch.object(ReviewWatch, "run", side_effect=process), \
                patch.object(structured_review, "fetch_packet", return_value=full) as fetch:
            result = structured_review.run("/repo", "system", text, CATALOG.resolve("gpt-6-astra-ultra"),
                                           "pr_approve", "https://github.com/o/r/pull/12", "bit-mis",
                                           "a" * 40, 60, packet=packet, **options)
        return result, calls, fetch

    def test_removal_finding_inside_the_pr_diff_submits(self):
        verdict = {"action": "request_changes",
                   "comments": [{"path": "src/gone.py", "line": 11, "side": "LEFT", "body": "needed file"}]}
        result, calls, fetch = self._run(self._packet("c" * 40, self.REMOVAL), verdict,
                                         self._full(self.REMOVAL))
        self.assertIn('"review_id": 91', result)
        fetch.assert_called_once_with("/repo", "https://github.com/o/r/pull/12", "bit-mis",
                                      "a" * 40, "p2", since_head=None)
        self.assertEqual(calls[-1][0][1], "--request-changes")
        self.assertEqual(json.loads(calls[-1][0][4]), verdict["comments"])

    def test_removal_finding_outside_the_reviewed_since_diff_is_a_contract_violation(self):
        verdict = {"action": "request_changes",
                   "comments": [{"path": "src/gone.py", "line": 99, "side": "LEFT", "body": "stale"}]}
        with self.assertRaises(atoms.AgentPreflightError) as failure:
            self._run(self._packet("c" * 40, self.REMOVAL), verdict, self._full(self.REMOVAL))
        self.assertEqual(failure.exception.code, "review_contract_violation")

    def test_left_finding_remaps_onto_shifted_pr_coordinates(self):
        shifted = "\n".join(["diff --git a/src/gone.py b/src/gone.py", "--- a/src/gone.py", "+++ b/src/gone.py",
                             "@@ -4,3 +10,3 @@", " context", "-removed", "+added", " context2"])
        verdict = {"action": "request_changes",
                   "comments": [{"path": "src/gone.py", "line": 11, "side": "LEFT", "body": "needed file"}]}
        result, calls, _ = self._run(self._packet("c" * 40, self.REMOVAL), verdict, self._full(shifted))
        self.assertIn('"review_id": 91', result)
        self.assertEqual(calls[-1][0][1], "--request-changes")
        submitted = json.loads(calls[-1][0][4])
        self.assertEqual([(comment["line"], comment["side"]) for comment in submitted], [(5, "LEFT")])

    def test_reaffirmed_left_finding_keeps_its_original_thread_coordinates(self):
        verdict = {"action": "request_changes",
                   "comments": [{"path": "src/gone.py", "line": 5, "side": "LEFT", "body": "still blocks"}]}
        for outdated in (False, True):
            with self.subTest(outdated=outdated):
                node = json.loads(self._packet("c" * 40, self.REMOVAL))
                node["review_threads"] = [{"path": "src/gone.py", "line": 5, "side": "LEFT",
                                          "is_resolved": False, "is_outdated": outdated,
                                          "bodies": ["still blocks"]}]
                _, calls, _ = self._run(json.dumps(node), verdict, self._full(self.REMOVAL))
                self.assertEqual(calls[-1][0][1], "--request-changes")
                self.assertEqual(json.loads(calls[-1][0][4]), verdict["comments"])

    def test_resolved_thread_cannot_validate_a_finding_outside_the_since_diff(self):
        verdict = {"action": "request_changes",
                   "comments": [{"path": "src/gone.py", "line": 5, "side": "LEFT", "body": "still blocks"}]}
        node = json.loads(self._packet("c" * 40, self.REMOVAL))
        node["review_threads"] = [{"path": "src/gone.py", "line": 5, "side": "LEFT",
                                  "is_resolved": True, "is_outdated": True, "bodies": ["still blocks"]}]
        with self.assertRaises(atoms.AgentPreflightError):
            self._run(json.dumps(node), verdict, self._full(self.REMOVAL))

    def test_repeated_removed_text_maps_using_current_head_position(self):
        since = "\n".join(["diff --git a/src/gone.py b/src/gone.py",
                           "--- a/src/gone.py", "+++ b/src/gone.py",
                           "@@ -10,3 +30,2 @@", " context", "-return None", " context2"])
        full = "\n".join(["diff --git a/src/gone.py b/src/gone.py",
                          "--- a/src/gone.py", "+++ b/src/gone.py",
                          "@@ -4,3 +10,3 @@", " context", "-return None", "+first", " context2",
                          "@@ -40,3 +30,3 @@", " context", "-return None", "+second", " context2"])
        verdict = {"action": "request_changes",
                   "comments": [{"path": "src/gone.py", "line": 11, "side": "LEFT", "body": "second removal"}]}
        _, calls, _ = self._run(self._packet("c" * 40, since), verdict, self._full(full))
        self.assertEqual(json.loads(calls[-1][0][4])[0]["line"], 41)

    def test_left_finding_absent_from_the_pr_diff_fails_closed(self):
        other = "\n".join(["diff --git a/src/gone.py b/src/gone.py", "--- a/src/gone.py", "+++ b/src/gone.py",
                           "@@ -4,3 +4,3 @@", " context", "-other", "+replacement", " context2"])
        verdict = {"action": "request_changes",
                   "comments": [{"path": "src/gone.py", "line": 11, "side": "LEFT", "body": "needed file"}]}
        with self.assertRaises(atoms.AgentPreflightError) as failure:
            self._run(self._packet("c" * 40, self.REMOVAL), verdict, self._full(other))
        self.assertEqual(failure.exception.code, "review_contract_violation")
        self.assertIn("no submitted verdict", str(failure.exception))

    def test_added_then_deleted_finding_fails_closed_without_approving(self):
        deleted = "\n".join(["diff --git a/src/helper.py b/src/helper.py", "--- a/src/helper.py",
                             "+++ /dev/null", "@@ -1,1 +0,0 @@", "-def helper():"])
        verdict = {"action": "request_changes",
                   "comments": [{"path": "src/helper.py", "line": 1, "side": "LEFT",
                                "body": "deleted while still imported"}]}
        empty = json.dumps({"action": "read", "diff": "", "files": []})
        with self.assertRaises(atoms.AgentPreflightError) as failure:
            self._run(self._packet("c" * 40, deleted, paths=("src/helper.py",)), verdict, empty)
        self.assertEqual(failure.exception.code, "review_contract_violation")
        self.assertIn("no submitted verdict", str(failure.exception))

    def test_right_finding_inside_the_pr_diff_submits(self):
        full = "\n".join(["diff --git a/src/gone.py b/src/gone.py", "--- a/src/gone.py", "+++ b/src/gone.py",
                          "@@ -1,1 +1,2 @@", " old", "+new"])
        verdict = {"action": "request_changes",
                   "comments": [{"path": "src/gone.py", "line": 2, "side": "RIGHT", "body": "defect"}]}
        result, calls, fetch = self._run(self._packet("c" * 40), verdict, self._full(full))
        self.assertIn('"review_id": 91', result)
        fetch.assert_called_once_with("/repo", "https://github.com/o/r/pull/12", "bit-mis",
                                      "a" * 40, "p2", since_head=None)
        self.assertEqual(calls[-1][0][1], "--request-changes")
        self.assertEqual(json.loads(calls[-1][0][4]), verdict["comments"])

    def test_right_finding_on_a_reverted_file_fails_closed(self):
        kept = "\n".join(["diff --git a/src/kept.py b/src/kept.py", "--- a/src/kept.py", "+++ b/src/kept.py",
                          "@@ -1,1 +1,2 @@", " same", "+more"])
        verdict = {"action": "request_changes",
                   "comments": [{"path": "src/gone.py", "line": 10, "side": "RIGHT", "body": "revert issue"}]}
        with self.assertRaises(atoms.AgentPreflightError) as failure:
            self._run(self._packet("c" * 40, self.REMOVAL), verdict,
                       self._full(kept, paths=("src/kept.py",)))
        self.assertEqual(failure.exception.code, "review_contract_violation")
        self.assertIn("no submitted verdict", str(failure.exception))

    def test_reaffirmed_prior_left_finding_absent_from_since_diff_submits(self):
        kept = "\n".join(["diff --git a/src/kept.py b/src/kept.py", "--- a/src/kept.py", "+++ b/src/kept.py",
                          "@@ -1,1 +1,2 @@", " same", "+more"])
        verdict = {"action": "request_changes",
                   "comments": [{"path": "src/gone.py", "line": 11, "side": "LEFT",
                                "body": "still removed upstream"}]}
        node = json.loads(self._packet("c" * 40, kept, paths=("src/kept.py",)))
        node["review_threads"] = [{"path": "src/gone.py", "line": 11, "side": "LEFT",
                                  "is_resolved": False, "is_outdated": False,
                                  "bodies": ["still removed upstream"]}]
        result, calls, _ = self._run(json.dumps(node), verdict,
                                     self._full(self.REMOVAL + "\n" + kept,
                                              paths=("src/gone.py", "src/kept.py")))
        self.assertIn('"review_id": 91', result)
        self.assertEqual(calls[-1][0][1], "--request-changes")
        self.assertEqual(json.loads(calls[-1][0][4]), verdict["comments"])

    def test_left_finding_on_repeated_text_anchors_at_the_current_head(self):
        full = "\n".join(["diff --git a/src/dup.py b/src/dup.py", "--- a/src/dup.py", "+++ b/src/dup.py",
                          "@@ -1,5 +1,3 @@", " def a():", "-    return None", " def b():",
                          "-    return None", " tail"])
        since = "\n".join(["diff --git a/src/dup.py b/src/dup.py", "--- a/src/dup.py", "+++ b/src/dup.py",
                           "@@ -8,3 +2,2 @@", " def b():", "-    return None", " tail"])
        verdict = {"action": "request_changes",
                   "comments": [{"path": "src/dup.py", "line": 9, "side": "LEFT", "body": "needed"}]}
        result, calls, _ = self._run(self._packet("c" * 40, since, paths=("src/dup.py",)), verdict,
                                     self._full(full, paths=("src/dup.py",)))
        self.assertIn('"review_id": 91', result)
        submitted = json.loads(calls[-1][0][4])
        self.assertEqual([(comment["line"], comment["side"]) for comment in submitted], [(4, "LEFT")])

    def test_left_finding_on_indistinguishable_repeats_fails_closed(self):
        full = "\n".join(["diff --git a/src/dup.py b/src/dup.py", "--- a/src/dup.py", "+++ b/src/dup.py",
                          "@@ -1,4 +1,2 @@", " ctx", "-x", "-x", " tail"])
        since = "\n".join(["diff --git a/src/dup.py b/src/dup.py", "--- a/src/dup.py", "+++ b/src/dup.py",
                           "@@ -1,3 +1,2 @@", " ctx", "-x", " tail"])
        verdict = {"action": "request_changes",
                   "comments": [{"path": "src/dup.py", "line": 2, "side": "LEFT", "body": "which one"}]}
        with self.assertRaises(atoms.AgentPreflightError) as failure:
            self._run(self._packet("c" * 40, since, paths=("src/dup.py",)), verdict,
                       self._full(full, paths=("src/dup.py",)))
        self.assertEqual(failure.exception.code, "review_contract_violation")
        self.assertIn("no submitted verdict", str(failure.exception))

    def test_partially_stale_verdict_fails_closed(self):
        kept = "\n".join(["diff --git a/src/kept.py b/src/kept.py", "--- a/src/kept.py", "+++ b/src/kept.py",
                          "@@ -1,1 +1,2 @@", " same", "+more"])
        verdict = {"action": "request_changes", "comments": [
            {"path": "src/gone.py", "line": 10, "side": "RIGHT", "body": "kept"},
            {"path": "src/kept.py", "line": 99, "side": "RIGHT", "body": "stale"}]}
        with self.assertRaises(atoms.AgentPreflightError) as failure:
            self._run(self._packet("c" * 40, self.REMOVAL), verdict,
                       self._full(self.REMOVAL + "\n" + kept,
                                paths=("src/gone.py", "src/kept.py")))
        self.assertEqual(failure.exception.code, "review_contract_violation")
        self.assertIn("no submitted verdict", str(failure.exception))

    def test_capped_partial_stale_verdict_preserves_every_finding_or_fails_closed(self):
        kept = "\n".join(["diff --git a/src/kept.py b/src/kept.py", "--- a/src/kept.py", "+++ b/src/kept.py",
                          "@@ -1,1 +1,2 @@", " same", "+more"])
        verdict = {"action": "request_changes", "comments": [
            {"path": "src/gone.py", "line": 11, "side": "LEFT", "body": "removed helper is still imported"},
            {"path": "src/kept.py", "line": 2, "side": "RIGHT", "body": "another defect"}]}
        with patch.object(structured_review, "_file_capped_followup", return_value="https://github.com/o/r/issues/99") as followup:
            with self.assertRaises(atoms.AgentPreflightError) as failure:
                self._run(self._packet("c" * 40, self.REMOVAL + "\n" + kept,
                                       paths=("src/gone.py", "src/kept.py")), verdict,
                          self._full(kept, paths=("src/kept.py",)),
                          capped=True, review_round=5, review_cap=5)
        self.assertEqual(failure.exception.code, "review_contract_violation")
        followup.assert_not_called()

    def test_full_review_left_findings_keep_todays_behavior(self):
        verdict = {"action": "request_changes",
                   "comments": [{"path": "src/gone.py", "line": 99, "side": "LEFT", "body": "defect"}]}
        result, _, fetch = self._run(self._packet(None), verdict, "unused")
        self.assertIn('"review_id": 91', result)
        fetch.assert_not_called()

    def test_production_priorities_pass_through_unchanged(self):
        for priority in ("p0", "p1", "p2", "p12"):
            with self.subTest(priority=priority):
                node = json.loads(self._packet("c" * 40, self.REMOVAL))
                node["p"] = priority
                verdict = {"action": "request_changes",
                           "comments": [{"path": "src/gone.py", "line": 11, "side": "LEFT", "body": "needed file"}]}
                result, _, fetch = self._run(json.dumps(node), verdict, self._full(self.REMOVAL))
                self.assertIn('"review_id": 91', result)
                fetch.assert_called_once_with("/repo", "https://github.com/o/r/pull/12", "bit-mis",
                                              "a" * 40, priority, since_head=None)

    def test_missing_priority_fails_closed_without_fetch_or_submit(self):
        verdict = {"action": "request_changes",
                   "comments": [{"path": "src/gone.py", "line": 11, "side": "LEFT", "body": "needed file"}]}
        for missing in ("absent", None, "", "   "):
            with self.subTest(missing=missing):
                node = json.loads(self._packet("c" * 40, self.REMOVAL))
                if missing == "absent":
                    del node["p"]
                else:
                    node["p"] = missing
                packet = json.dumps(node)
                calls = []

                def process(args, **kwargs):
                    calls.append((args, kwargs))
                    if args[0] == "github-interface":
                        return SimpleNamespace(returncode=0, stdout=json.dumps(
                            {"action": "requested_changes", "review_id": 91, "head_sha": "a" * 40}), stderr="")
                    Path(args[args.index("--output-last-message") + 1]).write_text(json.dumps(verdict))
                    return SimpleNamespace(returncode=0, stdout="", stderr="")

                text = f"policy\n\nPR packet:\n{packet}\n\nAllowed:\nnone"
                with patch.object(structured_review.subprocess, "run", side_effect=process), \
                        patch.object(ReviewWatch, "run", side_effect=process), \
                        patch.object(structured_review, "fetch_packet") as fetch:
                    with self.assertRaises(atoms.AgentPreflightError) as failure:
                        structured_review.run("/repo", "system", text, CATALOG.resolve("gpt-6-astra-ultra"),
                                              "pr_approve", "https://github.com/o/r/pull/12", "bit-mis",
                                              "a" * 40, 60, packet=packet)
                self.assertEqual(failure.exception.code, "review_contract_violation")
                self.assertIn("missing its priority", str(failure.exception))
                fetch.assert_not_called()
                self.assertEqual(len(calls), 1)
                self.assertNotEqual(calls[0][0][0], "github-interface")

    def test_malformed_and_integer_priorities_fail_closed_via_adapter(self):
        verdict = {"action": "request_changes",
                   "comments": [{"path": "src/gone.py", "line": 11, "side": "LEFT", "body": "needed file"}]}
        full = self._full(self.REMOVAL)

        def validating_fetch(pwd, pr, actor_name, head, p, since_head=None):
            atoms._priority(p)
            return full

        for bad in ("pp2", "px", "p", "2", 2, 0, True):
            with self.subTest(p=bad):
                node = json.loads(self._packet("c" * 40, self.REMOVAL))
                node["p"] = bad
                with patch.object(structured_review, "fetch_packet", side_effect=validating_fetch):
                    with self.assertRaises(structured_review.InvalidVerdict) as failure:
                        structured_review._validate_since_positions(
                            "/repo", "https://github.com/o/r/pull/12", "bit-mis", "a" * 40,
                            json.dumps(node), dict(verdict))
                self.assertIn("cannot validate since-diff positions", str(failure.exception))


class TestOtherProviderVerdicts(TestCase):
    """Grok, Antigravity and Muse answer with the same verdict the Codex path submits."""

    def _run(self, identity, stdout, behavior="pr_review", code=0):
        calls = []

        def provider(args, **kwargs):
            calls.append((args, kwargs))
            return SimpleNamespace(returncode=code, stdout=stdout, stderr="provider failed" if code else "")

        def github(args, **kwargs):
            calls.append((args, kwargs))
            action = {"--request-changes": "requested_changes", "--reviewed-clean": "reviewed_clean",
                      "--approve-pr": "approved_pr"}[args[1]]
            return SimpleNamespace(returncode=0, stdout=json.dumps(
                {"action": action, "review_id": 91, "head_sha": "a" * 40}), stderr="")

        with patch.object(structured_review.subprocess, "run", side_effect=github), \
                patch.object(ReviewWatch, "run", side_effect=provider):
            result = structured_review.run("/repo", "system", "packet", CATALOG.resolve(identity), behavior,
                                           "https://github.com/o/r/pull/12", "bit-mis", "a" * 40, 60)
        return result, calls

    def test_grok_runs_one_tool_free_turn_from_a_prompt_file_and_submits(self):
        reply = {**GROK_REPLY, "structuredOutput": {"action": "request_changes", "comments": [FINDING]}}
        result, calls = self._run("grok-4.6-xhigh", json.dumps(reply))
        self.assertIn('"review_id": 91', result)
        (args, kwargs), (mutation, _) = calls
        self.assertEqual(Path(args[0]).name, "grok")
        self.assertEqual(args[args.index("-m") + 1], "grok-4.6")
        self.assertEqual(args[args.index("--effort") + 1], "xhigh")
        self.assertEqual(args[args.index("--tools") + 1], "")
        self.assertEqual(args[args.index("--max-turns") + 1], "1")
        self.assertIn("--verbatim", args)
        self.assertEqual(args[args.index("--system-prompt-override") + 1], "system")
        disabled = args[args.index("--disallowed-tools") + 1].split(",")
        for tool in ("read_file", "run_terminal_cmd", "search_tool", "use_tool", "write", "search_replace"):
            self.assertIn(tool, disabled)
        self.assertNotIn("write_file", disabled)
        self.assertEqual(kwargs["env"]["GROK_CLAUDE_MCPS_ENABLED"], "0")
        self.assertEqual(kwargs["env"]["GROK_CLAUDE_HOOKS_ENABLED"], "0")
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

        receipt = json.dumps({"action": "reviewed_clean", "review_id": 91, "head_sha": "a" * 40})
        with patch.object(structured_review.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=receipt, stderr="")), \
                patch.object(ReviewWatch, "run", side_effect=provider):
            structured_review.run("/repo", "system", "packet", CATALOG.resolve("grok-4.6-high"), "pr_review",
                                  "https://github.com/o/r/pull/12", "bit-mis", "a" * 40, 60)
        self.assertTrue(seen["prompt"].startswith("system\n\npacket"))
        self.assertIn('"reviewed_clean"', seen["prompt"])
        self.assertIn("no code fence", seen["prompt"])

    def test_grok_rejects_extra_turns_missing_output_and_failures(self):
        for stdout, code in ((json.dumps({**GROK_REPLY, "structuredOutput": {"action": "reviewed_clean", "comments": []}, "num_turns": 2}), 0),
                             (json.dumps({**GROK_REPLY, "text": '{"action":"reviewed_clean","comments":[]}'}), 0),
                             ("not json", 0),
                             (json.dumps({**GROK_REPLY, "structuredOutput": {"action": "reviewed_clean", "comments": []}}), 1)):
            with self.subTest(stdout=stdout, code=code), self.assertRaises(atoms.AgentPreflightError):
                self._run("grok-4.6-xhigh", stdout, code=code)

    def test_grok_turn_limits_are_held_but_provider_outages_remain_retryable(self):
        with self.assertRaises(agent_interface.review_budget.ReviewLimitError) as failure:
            self._run("grok-4.6-high", json.dumps({**GROK_REPLY, "stopReason": "max_turns"}))
        self.assertEqual(failure.exception.code, "review_budget_exhausted")
        with self.assertRaises(atoms.AgentPreflightError) as failure:
            self._run("grok-4.6-high", "", code=1)
        self.assertEqual(failure.exception.code, "review_provider_exit")
        self.assertEqual(failure.exception.diagnostic["provider"], "grok")
        self.assertEqual(failure.exception.diagnostic["submission"], "none")

    def test_antigravity_streams_the_packet_in_plan_mode_and_submits(self):
        result_event = {**AGY_RESULT, "structured_output": {"action": "approve", "comments": []}}
        result, calls = self._run("gemini-3.8-flash-high", agy_stream(result_event), behavior="pr_approve")
        self.assertIn('"review_id": 91', result)
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
        self.assertIn('"review_id": 91', result)
        (args, kwargs), (mutation, _) = calls
        self.assertEqual(Path(args[0]).name, "muse")
        self.assertEqual(args[1], "exec")
        self.assertEqual(args[args.index("--model") + 1], "muse-spark-1.3-contributor")
        self.assertEqual(args[args.index("--contributor-mode") + 1], "on")
        self.assertEqual(args[args.index("--reasoning-effort") + 1], "max")
        for flag in ("--disable-shell", "--disable-write", "--disable-web-tools", "--json"):
            self.assertIn(flag, args)
        self.assertNotIn("--no-session-log", args)
        self.assertEqual(Path(kwargs["env"]["XDG_DATA_HOME"]), Path(kwargs["cwd"]) / "data")
        self.assertEqual(args[args.index("--approval-mode") + 1], "never")
        self.assertEqual(args[args.index("--workspace") + 1], kwargs["cwd"])
        self.assertNotEqual(kwargs["cwd"], "/repo")
        self.assertEqual(kwargs["provider"], "muse")
        for flag in ("--output-schema", "--no-foreign-personal-context", "--disable-reminders"):
            self.assertIn(flag, args)
        self.assertEqual(args[args.index("--max-model-steps") + 1], "1")
        self.assertEqual(mutation[:3], ["github-interface", "--reviewed-clean", "#12"])

    def test_muse_review_run_keeps_the_session_logging_the_cli_requires(self):
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            script = scripted_muse(root)
            reply = root / "reply.jsonl"
            reply.write_text(muse_stream('{"action": "reviewed_clean", "comments": []}'))
            log = root / "argv.log"
            with patch.dict(os.environ, {"MUSE_CLI": str(script), "MUSE_ARGV_LOG": str(log),
                                         "MUSE_SCRIPT_REPLY": str(reply)}):
                denied = subprocess.run([str(script), "exec", "--no-session-log"], text=True, capture_output=True)
                self.assertEqual((denied.returncode, denied.stderr), (1, MUSE_SESSION_ERROR + "\n"))
                schema = structured_review.verdict_schema("pr_review")
                with ReviewWatch("/repo", "https://github.com/o/r/pull/12", "bit-mis", "a" * 40) as watch:
                    answer = structured_review.ask_muse(root, CATALOG.resolve("muse-spark-1.3-contributor-max"),
                                                       "system", "packet", schema, watch, 60)
            self.assertEqual(answer, '{"action": "reviewed_clean", "comments": []}')
            self.assertNotIn("--no-session-log", log.read_text().splitlines())
            self.assertTrue((root / "data" / "muse" / "sessions" / "probe").is_file())

    def test_account_blocks_are_typed_without_submitting_or_hiding_transient_errors(self):
        for message in ("MUSE GUARD: Muse provider access is latched off locally.",
                        "API error: Grok Build usage balance exhausted",
                        "API Error: Opus 5's safeguards flagged this message"):
            with self.subTest(message=message), self.assertRaises(atoms.AgentPreflightError) as failure:
                structured_review.provider_failure(message)
            self.assertEqual(failure.exception.code, "review_provider_blocked")
        with self.assertRaises(atoms.AgentPreflightError) as failure:
            structured_review.provider_failure("temporary provider outage")
        self.assertEqual(failure.exception.code, "review_provider_exit")
        self.assertEqual(failure.exception.diagnostic["submission"], "none")

    def test_blocked_provider_causes_are_redacted_and_bounded(self):
        message = ("API error: Grok Build usage balance exhausted; "
                   "proxy-authorization: Basic dGVzdA== token=secret-value ghp_abc123")
        with self.assertRaises(atoms.AgentPreflightError) as failure:
            structured_review.provider_failure(message, provider="grok")
        self.assertEqual(failure.exception.code, "review_provider_blocked")
        self.assertIn("Grok Build usage balance exhausted", str(failure.exception))
        for field in (str(failure.exception), failure.exception.diagnostic["stderr"]):
            self.assertNotIn("dGVzdA==", field)
            self.assertNotIn("secret-value", field)
            self.assertNotIn("ghp_abc123", field)
            self.assertLessEqual(len(field), 501)

    def test_provider_cause_redacts_url_credentials_regardless_of_scheme_case(self):
        for scheme in ("http", "HTTP", "https", "HTTPS", "hTtPs"):
            with self.subTest(scheme=scheme):
                message = ("API error: Grok Build usage balance exhausted via "
                           f"{scheme}://test-user:private-password@proxy.example/failure")
                with self.assertRaises(atoms.AgentPreflightError) as failure:
                    structured_review.provider_failure(message, provider="grok")
                self.assertEqual(failure.exception.code, "review_provider_blocked")
                for field in (str(failure.exception), failure.exception.diagnostic["stderr"]):
                    self.assertIn(f"{scheme}://[redacted]@proxy.example/failure", field)
                    self.assertNotIn("test-user", field)
                    self.assertNotIn("private-password", field)

    def test_muse_isolates_its_tool_roster_and_keeps_sign_in(self):
        with tempfile.TemporaryDirectory() as work:
            original = Path(work) / "original" / "muse"
            original.mkdir(parents=True)
            (original / "auth.json").write_text('{"test": "credential pointer"}')
            (original / "settings.json").write_text('{"run":{"toolset":["workflow"]}}')
            root = Path(work) / "review"
            with patch.dict(os.environ, {"XDG_CONFIG_HOME": str(original.parent)}):
                env = structured_review.muse_environment(root)
            isolated = Path(env["XDG_CONFIG_HOME"]) / "muse"
            self.assertEqual(Path(env["XDG_DATA_HOME"]), root / "data")
            self.assertEqual(json.loads((isolated / "settings.json").read_text())["run"],
                             {"toolset": [], "workflow_trigger_mode": "off"})
            self.assertEqual((isolated / "auth.json").read_text(), (original / "auth.json").read_text())
            self.assertEqual((isolated / "auth.json").stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads((original / "settings.json").read_text())["run"]["toolset"], ["workflow"])

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


class TestVerifiedResultsOrExplicitFailures(TestCase):
    """#236: every attempt ends with a validated receipt or a typed failure."""

    def _codex_run(self, *, returncode=0, stderr="", stdout_events=(), verdict=None):
        def process(args, **kwargs):
            if args[0] == "github-interface":
                action = {"--request-changes": "requested_changes", "--reviewed-clean": "reviewed_clean",
                          "--approve-pr": "approved_pr"}[args[1]]
                return SimpleNamespace(returncode=0, stdout=json.dumps(
                    {"action": action, "review_id": 91, "head_sha": "a" * 40}), stderr="")
            Path(args[args.index("--output-last-message") + 1]).write_text(
                json.dumps(verdict or {"action": "reviewed_clean", "comments": []}))
            return SimpleNamespace(returncode=returncode, stdout="\n".join(
                json.dumps(event) for event in stdout_events), stderr=stderr)
        with patch.object(structured_review.subprocess, "run", side_effect=process) as run, \
                patch.object(ReviewWatch, "run", side_effect=run):
            return structured_review.run("/repo", "system", "packet", CATALOG.resolve("gpt-6-astra-ultra"),
                                         "pr_review", "https://github.com/o/r/pull/12", "bit-mis", "a" * 40, 60), run

    def test_codex_exit_101_is_typed_bounded_and_submits_nothing(self):
        stream = [{"type": "thread.started", "thread_id": "01234567-89ab-4cde-8123-456789abcdef"}] * 5
        with patch.object(structured_review.subprocess, "run") as submit, \
                patch.object(ReviewWatch, "run", return_value=SimpleNamespace(
                    returncode=101, stdout="\n".join(json.dumps(e) for e in stream), stderr="")):
            with self.assertRaises(atoms.AgentPreflightError) as failure:
                structured_review.run("/repo", "system", "packet", CATALOG.resolve("gpt-6-astra-ultra"),
                                      "pr_review", "https://github.com/o/r/pull/12", "bit-mis", "a" * 40, 60)
        self.assertEqual(failure.exception.code, "review_provider_exit")
        self.assertEqual(failure.exception.diagnostic["provider"], "codex")
        self.assertEqual(failure.exception.diagnostic["exit_code"], 101)
        self.assertEqual(failure.exception.diagnostic["submission"], "none")
        self.assertLessEqual(len(str(failure.exception)), 600)
        self.assertNotIn("thread.started", str(failure.exception))
        submit.assert_not_called()

    def test_codex_signal_is_typed_with_signal_and_no_submission(self):
        with patch.object(structured_review.subprocess, "run") as submit, \
                patch.object(ReviewWatch, "run", return_value=SimpleNamespace(
                    returncode=-9, stdout="", stderr="")):
            with self.assertRaises(atoms.AgentPreflightError) as failure:
                structured_review.run("/repo", "system", "packet", CATALOG.resolve("gpt-6-astra-ultra"),
                                      "pr_review", "https://github.com/o/r/pull/12", "bit-mis", "a" * 40, 60)
        self.assertEqual(failure.exception.code, "review_provider_exit")
        self.assertEqual(failure.exception.diagnostic["signal"], 9)
        self.assertIsNone(failure.exception.diagnostic["exit_code"])
        submit.assert_not_called()

    def test_muse_server_error_is_typed_whether_exit_or_terminal(self):
        from agent_interface import review_receipt as receipt_mod
        # Exit with server_error on stderr.
        with patch.object(structured_review.subprocess, "run") as submit, \
                patch.object(ReviewWatch, "run", return_value=SimpleNamespace(
                    returncode=1, stdout="", stderr="server_error")):
            with self.assertRaises(atoms.AgentPreflightError) as failure:
                structured_review.run("/repo", "system", "packet",
                                      CATALOG.resolve("muse-spark-1.3-contributor-max"), "pr_review",
                                      "https://github.com/o/r/pull/12", "bit-mis", "a" * 40, 60)
        self.assertEqual(failure.exception.code, "review_provider_exit")
        submit.assert_not_called()
        # Exit zero with a failed terminal.
        stdout = muse_stream('{"action": "reviewed_clean", "comments": []}', terminal="failed")
        with patch.object(structured_review.subprocess, "run") as submit, \
                patch.object(ReviewWatch, "run", return_value=SimpleNamespace(
                    returncode=0, stdout=stdout, stderr="")):
            with self.assertRaises(atoms.AgentPreflightError) as failure:
                structured_review.run("/repo", "system", "packet",
                                      CATALOG.resolve("muse-spark-1.3-contributor-max"), "pr_review",
                                      "https://github.com/o/r/pull/12", "bit-mis", "a" * 40, 60)
        self.assertEqual(failure.exception.code, "review_provider_error")
        self.assertEqual(failure.exception.diagnostic["provider"], "muse")
        submit.assert_not_called()

    def test_duplicate_verdict_keys_and_terminals_never_submit(self):
        with self.assertRaises(structured_review.InvalidVerdict):
            structured_review.validate_verdict(
                '{"action": "request_changes", "action": "reviewed_clean", "comments": []}', "pr_review")
        dup_turns = [{"type": "turn.completed"}, {"type": "turn.completed"}]
        with self.assertRaises(atoms.AgentPreflightError):
            self._codex_run(stdout_events=dup_turns)
        first = {"payload_type": "run.terminal.completed",
                 "payload": {"terminal": "completed", "text": '{"action": "reviewed_clean", "comments": []}'}}
        second = {"payload_type": "run.terminal.completed",
                  "payload": {"terminal": "completed", "text": '{"action": "request_changes", "comments": []}'}}
        stdout = "\n".join(json.dumps(event) for event in [first, second])
        with patch.object(ReviewWatch, "run", return_value=SimpleNamespace(returncode=0, stdout=stdout, stderr="")), \
                patch.object(structured_review.subprocess, "run") as submit:
            with self.assertRaises(atoms.AgentPreflightError):
                structured_review.run("/repo", "system", "packet",
                                      CATALOG.resolve("muse-spark-1.3-contributor-max"), "pr_review",
                                      "https://github.com/o/r/pull/12", "bit-mis", "a" * 40, 60)
            submit.assert_not_called()

    def test_submission_rejection_noop_and_uncertainty_are_typed(self):
        from agent_interface import review_receipt as receipt_mod
        verdict = {"action": "request_changes", "comments": [FINDING]}

        def run_with_github(reply):
            def process(args, **kwargs):
                if args[0] == "github-interface":
                    return reply
                Path(args[args.index("--output-last-message") + 1]).write_text(json.dumps(verdict))
                return SimpleNamespace(returncode=0, stdout="", stderr="")
            with patch.object(structured_review.subprocess, "run", side_effect=process), \
                    patch.object(ReviewWatch, "run", side_effect=process):
                return structured_review.run("/repo", "system", "packet", CATALOG.resolve("gpt-6-astra-ultra"),
                                             "pr_review", "https://github.com/o/r/pull/12", "bit-mis", "a" * 40, 60)

        with self.assertRaises(agent_interface.review_budget.ReviewLimitError) as failure:
            run_with_github(SimpleNamespace(returncode=1, stdout="", stderr="error: GitHub 422: line not in diff"))
        self.assertEqual(failure.exception.code, "review_contract_violation")
        self.assertIn("line not in diff", str(failure.exception))
        self.assertEqual(failure.exception.diagnostic["submission"], "rejected")

        noop = json.dumps({"action": "no_review", "skipped": [{"reason": "duplicate"}]})
        with self.assertRaises(agent_interface.review_budget.ReviewLimitError) as failure:
            run_with_github(SimpleNamespace(returncode=0, stdout=noop, stderr=""))
        self.assertEqual(failure.exception.code, "review_contract_violation")
        self.assertEqual(failure.exception.diagnostic["submission"], "noop")

        with self.assertRaises(receipt_mod.SubmissionError):
            run_with_github(SimpleNamespace(returncode=0, stdout="not json", stderr=""))

        def provider(args, **kwargs):
            Path(args[args.index("--output-last-message") + 1]).write_text(json.dumps(
                {"action": "reviewed_clean", "comments": []}))
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        with patch.object(structured_review.subprocess, "run",
                          side_effect=subprocess.TimeoutExpired("github-interface", 1)), \
                patch.object(ReviewWatch, "run", side_effect=provider):
            with self.assertRaises(receipt_mod.SubmissionError):
                structured_review.run("/repo", "system", "packet", CATALOG.resolve("gpt-6-astra-ultra"),
                                      "pr_review", "https://github.com/o/r/pull/12", "bit-mis", "a" * 40, 60)
