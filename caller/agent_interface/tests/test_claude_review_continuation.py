"""Governed Claude entry-point proof with isolated provider and GitHub launches."""
import io
import json
import os
import shlex
import subprocess
import sys
import tempfile
from contextlib import ExitStack, nullcontext, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch
from uuid import uuid4

import agent_interface as api
from agent_interface import atoms, bash_guard, issue_review, pr_approve, pr_review, review_budget, \
    review_continuation as continuation, review_receipt, review_repository, review_watch, structured_review
from agent_interface.model_catalog import CATALOG
from review_submission_fixture import submission_args
from test_review_continuation import ASSESSMENT, HEAD, packet, supplied, verdict

MODEL = CATALOG.resolve("opus-5-high")
EARLY = {"path": "src/f000.py", "line": 2, "side": "RIGHT", "body": "[p1] Consumer uses an obsolete contract."}
LATE = {"path": "src/f008.py", "line": 2, "side": "RIGHT", "body": "[p0] The common path loses its input."}


class TestGovernedClaudeContinuation(TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        for name, value in (("DB", self.root / "calls.sqlite3"), ("RESPONSES", self.root / "responses")):
            self.stack.enter_context(patch.object(api, name, value))
        api.init_db()
        self.node = packet(9)
        self.clock = SimpleNamespace(now=0.0)
        for module in (review_budget, continuation, structured_review):
            self.stack.enter_context(patch.object(module, "monotonic", lambda: self.clock.now))
        self.stack.enter_context(patch.object(issue_review, "_cwd_pids", return_value=[]))
        self.stack.enter_context(patch.dict(os.environ, {"CLAUDE_CLI": "fixture-claude"}))
        self.posts, self.launches = [], []
        self.reply = lambda prompt: verdict(prompt)
        self.lost_ack = False
        self.review_state, self.review_reads = None, 0
        self.repository = SimpleNamespace(root=self.root, prompt=lambda: "\n\nPinned review repository: fixture",
            diff_packet=lambda value, _limit, **_kwargs: json.dumps({**json.loads(value),
                "diff": self.node["diff"], "diff_deferred": False, "coverage": "complete"}),
            inspect=lambda requests, **_kwargs: {"action": "review_context", "head_sha": HEAD, "results": [
                {"request": request, "lines": [{"line": 1, "text": "pinned consumer evidence"}],
                 "truncated": False, "next_line": None} for request in requests]})
        self.stack.enter_context(patch.object(review_repository, "prepare", side_effect=lambda *_args: nullcontext(self.repository)))
        watch = SimpleNamespace(run=self.launch, check_closed=lambda: None,
                                gate_path=str(self.root / "gate"), receipt_path=str(self.root / "receipt"))
        for module in (structured_review, review_watch):
            self.stack.enter_context(patch.object(module, "ReviewWatch", side_effect=lambda *_args: nullcontext(watch)))
        self.stack.enter_context(patch.object(subprocess, "run", side_effect=self.github))
        self.stack.enter_context(patch.object(api, "review_facts", side_effect=self.facts))

    def facts(self, *_args):
        items = [{"id": 91, "commit": HEAD, "state": "CHANGES_REQUESTED" if "--request-changes" in command
                  else "APPROVED" if "--approve-pr" in command else "COMMENTED",
                  "submitted_at": "2026-11-14T10:00:00Z"} for command, _body in self.posts]
        return {"state": "OPEN", "draft": False, "head_sha": HEAD, "repository": "o/r", "pull_number": 12,
                "reviewer_pending_reviews": 0, "reviewer_reviews_since": len(items),
                "reviewer_change_requests_since": sum(item["state"] == "CHANGES_REQUESTED" for item in items),
                "reviewer_approvals_since": sum(item["state"] == "APPROVED" for item in items),
                "reviewer_comments_since": sum(item["state"] == "COMMENTED" for item in items),
                "reviewer_latest_any_review_id": 91 if items else None,
                "reviewer_reviews_since_items": items}

    def github(self, command, **_kwargs):
        flag = command[1]
        if flag == "--pr-review":
            node = self.node
            if "--manifest-only" in command:
                node = {**node, "diff": "", "diff_deferred": True, "coverage": "incomplete"}
            return SimpleNamespace(returncode=0, stderr="", stdout=json.dumps(node))
        if flag == "--review-activity-since":
            return SimpleNamespace(returncode=0, stderr="", stdout=json.dumps({"reviewer_latest_complete_commit": HEAD}))
        if flag == "--pull-action-state":
            self.assertIn("--queue-evidence", command)
            self.assertIsNotNone(self.review_state)
            self.review_reads += 1
            return SimpleNamespace(returncode=0, stderr="", stdout=json.dumps(self.review_state))
        self.assertIn(flag, ("--request-changes", "--approve-pr", "--reviewed-clean"))
        body = review_receipt.begin_submission("Verified final verdict", HEAD)
        self.posts.append((submission_args(command), body))
        if self.lost_ack:
            raise subprocess.TimeoutExpired(command, 10)
        return SimpleNamespace(returncode=0, stderr="", stdout=json.dumps({"review_id": 91, "head_sha": HEAD,
            "action": "requested_changes" if flag == "--request-changes" else "approved_pr" if flag == "--approve-pr" else "reviewed_clean"}))

    def launch(self, command, **kwargs):
        self.assertEqual(command[0], "fixture-claude")
        self.assertEqual(command[command.index("--model") + 1], MODEL.selector)
        self.assertEqual(command[command.index("--effort") + 1], MODEL.effort)
        self.assertEqual(kwargs["provider"], "claude")
        self.launches.append((review_receipt._call.get()[1], command, kwargs))
        self.clock.now += 1
        raw = self.reply(kwargs["input"])
        if isinstance(raw, BaseException):
            raise raw
        return raw if not isinstance(raw, str) else SimpleNamespace(returncode=0, stderr="", stdout=json.dumps(
            {"type": "result", "subtype": "success", "is_error": False, "result": raw}))

    def execute(self, behavior="pr_review", resume=None, *, capped=False, cleanup=True, units=1):
        output = io.StringIO()
        with redirect_stdout(output):
            try:
                api.run_governed_behavior(pr_review if behavior == "pr_review" else pr_approve, behavior,
                    "https://github.com/o/r/pull/12", "reviewer", HEAD, "poise:behavior-chain", uuid4().hex,
                    pwd=str(self.root), model=MODEL.identity, review_slot="primary", resume_review=resume,
                    review_units_per_call=units, capped=capped,
                    review_round=2 if capped else None, review_cap=2 if capped else None)
            except SystemExit as stopped:
                self.assertEqual(stopped.code, 1)
        result = json.loads(output.getvalue())
        if cleanup:
            self.release(result["id"])
        with api.db() as conn:
            return dict(conn.execute("select * from calls where id=?", (result["id"],)).fetchone()), result

    def release(self, call_id):
        api.resource_ownership.cleanup_remaining(api.DB, call_id)
        with api.db() as conn:
            conn.execute("update calls set resources_settled_at=1 where id=?", (call_id,))

    def progress(self, call_id):
        with api.db() as conn:
            return json.loads(conn.execute("select artifact from calls where id=?", (call_id,)).fetchone()[0])["review_progress"]

    def resume(self, root):
        return f"{root}:{self.progress(root)['generation']}"

    def guard_analysis(self):
        command, kwargs = self.launches[-1][1:]
        rules = [review_repository.INSPECTION_RULE]
        self.assertEqual(json.loads(command[command.index("--settings") + 1])["permissions"]["allow"], rules)
        self.assertEqual(kwargs["env"]["GITHUB_INTERFACE_REVIEW_ROOT"], str(self.root))
        attempts = pr_approve.allowed("#12", "reviewer", HEAD, capped=True) + pr_review.allowed("#12", "reviewer", HEAD)
        for rule in attempts:
            mutation = rule[5:-1].replace("*", "'[]'")
            with patch.dict(os.environ, kwargs["env"]), patch.object(sys, "argv", ["guard", mutation]), \
                    patch.object(subprocess, "run") as executed, self.assertRaisesRegex(SystemExit, "blocked by agent-interface"):
                bash_guard.main()
            executed.assert_not_called()
        read = shlex.join(["github-interface", "--review-context", "--requests-json", "[]"])
        with patch.dict(os.environ, kwargs["env"]), patch.object(sys, "argv", ["guard", read]), \
                patch.object(subprocess, "run", return_value=SimpleNamespace(returncode=0)) as executed, self.assertRaises(SystemExit) as stopped:
            bash_guard.main()
        self.assertEqual(stopped.exception.code, 0)
        executed.assert_called_once_with(shlex.split(read), text=True)

    def large_review(self, behavior, capped=False):
        first = True
        request = {"operation": "read", "path": EARLY["path"], "query": "", "start_line": 1}

        def reply(prompt):
            nonlocal first
            self.guard_analysis()
            if first:
                first = False
                return verdict(prompt, [EARLY], [request])
            if len(self.launches) == 2:
                return SimpleNamespace(returncode=1, stderr="", stdout=json.dumps({"type": "result", "is_error": True,
                    "subtype": "error_during_execution", "errors": ["output token maximum reached"]}))
            source = supplied(prompt)
            if "required_cross_unit_evidence" in source:
                self.assertEqual(len(source["required_cross_unit_evidence"]), 2)
                self.assertIn(LATE, source["required_cross_unit_evidence"][1]["verdict"]["comments"])
            step = json.loads(verdict(prompt, [LATE] if source["files"][0]["filename"] == LATE["path"] else []))
            if behavior == "pr_approve" and step["action"] == "reviewed_clean":
                step["action"] = "approve"
            return json.dumps(step)

        self.reply = reply
        row, result = self.execute(behavior, capped=capped)
        root = row["id"]
        self.assertIn("continuation", result, result)
        self.assertEqual(result["continuation"]["outcome"], "continuation_required")
        self.assertEqual(self.progress(root)["unit"], 0)
        for _ in range(3):
            self.assertEqual(self.posts, [])
            self.assertIsNone(row["recovery_model"])
            row, result = self.execute(behavior, self.resume(root), capped=capped)
        self.assertEqual((row["status"], row["action"], row["outcome"]), ("completed", "requested_changes", "changes_requested"))
        response = json.loads(row["artifact"])["review_response"]
        self.assertEqual((response["model"], response["head_sha"], response["coverage"], response["invocation_id"]),
                         (MODEL.identity, HEAD, "complete", row["id"]))
        self.assertEqual(self.progress(root)["publisher"], row["id"])
        self.assertEqual(len(self.posts), 1)
        command, body = self.posts[0]
        self.assertEqual(json.loads(command[command.index("--comments") + 1]), [EARLY, LATE])
        self.assertIn(row["id"], body)
        self.assertEqual(len({call for call, _command, _kwargs in self.launches}), 4)

    def test_governed_large_review_resumes_validated_inspection_without_provider_recovery(self):
        self.large_review("pr_review")

    def test_governed_capped_approval_keeps_early_p1_and_late_p0_without_partial_writes(self):
        self.large_review("pr_approve", capped=True)

    def test_original_resources_must_release_before_claude_can_resume(self):
        row, _result = self.execute(cleanup=False)
        root = row["id"]
        launches = len(self.launches)
        row, result = self.execute(resume=self.resume(root))
        self.assertIn("has not released its resources", result["error"])
        self.assertEqual(len(self.launches), launches)
        self.release(root)
        row, result = self.execute(resume=self.resume(root))
        self.assertEqual(result["continuation"]["outcome"], "continuation_required")
        self.assertEqual(self.posts, [])

    def test_same_head_context_changes_and_missing_coverage_never_publish(self):
        row, _result = self.execute()
        root = row["id"]
        for key, value in (("head_sha", "c" * 40), ("pull", {**self.node["pull"], "body": "changed context"})):
            original = self.node[key]
            self.node[key] = value
            launches = len(self.launches)
            _row, result = self.execute(resume=self.resume(root))
            self.assertIn("material review basis changed", result["error"])
            self.assertEqual(len(self.launches), launches)
            self.node[key] = original
        self.reply = lambda prompt: json.dumps({**json.loads(verdict(prompt)), "evidence": []})
        _row, result = self.execute(resume=self.resume(root))
        self.assertEqual(result["error_code"], "review_contract_violation")
        self.assertEqual(self.posts, [])

    def test_user_stop_prevents_unit_completion_and_publication(self):
        def stop(prompt):
            with api.db() as conn:
                conn.execute("update calls set error_code='stopping' where id=?", (review_receipt._call.get()[1],))
            return verdict(prompt)
        self.reply = stop
        row, _result = self.execute()
        self.assertEqual(row["error_code"], "stopped")
        self.assertEqual(self.posts, [])

    def test_omitted_required_source_never_starts_claude_or_publishes(self):
        self.node["omitted_files"] = ["src/omitted.py"]
        _row, result = self.execute()
        self.assertIn("required review source coverage is incomplete", result["error"])
        self.assertEqual(self.launches, [])
        self.assertEqual(self.posts, [])

    def test_unknown_publication_retains_first_publisher_without_another_claude_launch(self):
        self.lost_ack = True
        row, _result = self.execute(units=6)
        root = row["id"]
        self.assertEqual(row["error_code"], "review_submission_failed")
        response = json.loads(row["artifact"])["review_response"]
        self.review_state = {"repository": "o/r", "pull_number": 12, "head_sha": HEAD,
                             "review_context": response["context_sha"], "my_reviews": []}
        launches = len(self.launches)
        row, result = self.execute(resume=self.resume(root), units=6)
        self.assertIn("reconcile that Call", result["error"])
        self.assertEqual(len(self.launches), launches)
        self.assertEqual(self.progress(root)["publisher"], root)
        self.assertEqual(len(self.posts), 1)
        self.assertEqual(self.review_reads, 1)

    def test_small_approval_keeps_ordinary_claude_output_limit_recovery(self):
        self.node = packet(1)
        self.reply = lambda _prompt: SimpleNamespace(returncode=1, stderr="", stdout=json.dumps(
            {"type": "result", "result": "output token maximum reached"}))
        recovery = CATALOG.review_model("pr_approve", CATALOG.behaviors["review_recovery"])
        seen = []
        def ask(_root, model, _system, _text, _schema, _watch, _timeout):
            seen.append(model.identity)
            return json.dumps({"action": "approve", "comments": [], "assessment": ASSESSMENT})
        with patch.dict(structured_review.ASK, {recovery.provider: ask}):
            row, _result = self.execute("pr_approve", units=6)
        self.assertEqual((row["status"], row["action"], row["recovery_model"]), ("completed", "approved", recovery.identity), row["error"])
        self.assertEqual(seen, [recovery.identity])
        self.assertNotIn("review_progress", json.loads(row["artifact"]))
        self.assertEqual(json.loads(row["artifact"])["review_response"]["model"], recovery.identity)
        self.assertEqual(len(self.posts), 1)

    def test_small_review_keeps_ordinary_governed_terminal_tools(self):
        self.node = packet(1)
        def review(_prompt):
            command = self.launches[-1][1]
            rules = json.loads(command[command.index("--settings") + 1])["permissions"]["allow"]
            self.assertEqual(rules, pr_review.allowed("#12", "reviewer", HEAD) + [review_repository.INSPECTION_RULE])
            review_receipt.complete_response(ASSESSMENT, HEAD)
            done = self.github(["github-interface", "--reviewed-clean", "#12"])
            review_receipt.record(done.stdout)
            return "Completed the ordinary governed review."
        self.reply = review
        row, _result = self.execute(units=6)
        self.assertEqual((row["status"], row["action"]), ("completed", "reviewed_clean"), row["error"])
        self.assertNotIn("review_progress", json.loads(row["artifact"]))
        self.assertEqual(json.loads(row["artifact"])["review_response"]["model"], MODEL.identity)
        self.assertEqual(len(self.posts), 1)
