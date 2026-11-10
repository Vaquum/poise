"""Durable native-effect receipts; these guards do not validate live cycles."""
import asyncio
import json
import os
import sqlite3
import subprocess
import sys
from contextlib import nullcontext, redirect_stdout
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import AsyncMock, MagicMock, patch

import agent_interface as api
from agent_interface import issue_review, native_namespace, review_budget, review_receipt, resource_ownership
from github_interface.behaviors import pr_review

CALL = "a" * 32
HEAD = "b" * 40


class ManagedReceipts(TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "calls.sqlite3"
        self.conn = sqlite3.connect(self.path)
        self.addCleanup(self.conn.close)
        self.conn.execute("create table calls (id text primary key, source text, status text, behavior text, error_code text, artifact text, "
                          "action text, outcome text, head_sha text, resources_settled_at real, action_plan text, resource_ownership text, namespace_control text)")
        self.conn.execute("insert into calls(id,source,status,behavior,artifact) values(?, 'poise:behavior-chain','running','pr_review',?)",
                          (CALL, json.dumps({"phase": "reviewing", "review_response": {"head_sha": HEAD, "completed_at": 1}})))
        self.conn.execute("update calls set resource_ownership=?", (resource_ownership.initial(),))
        self.conn.commit()
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, {"AGENT_INTERFACE_RECEIPT_DB": str(self.path), "AGENT_INTERFACE_RECEIPT_CALL": CALL}).start()

    def test_submission_is_recorded_before_post_and_cannot_be_submitted_twice(self):
        body = review_receipt.begin_submission("Actual verdict", HEAD)
        self.assertTrue(body.endswith(f"<!-- poise-invocation {CALL} -->"))
        phase = json.loads(self.conn.execute("select artifact from calls").fetchone()[0])["phase"]
        self.assertEqual(phase, "submitting_review")
        with self.assertRaisesRegex(RuntimeError, "unsubmitted native action"):
            review_receipt.begin_submission("Duplicate", HEAD)

    def test_metadata_only_or_future_response_cannot_enter_terminal_submission(self):
        for response in (None, {"head_sha": "c" * 40, "completed_at": 1}, {"head_sha": HEAD, "completed_at": 10 ** 15}):
            self.conn.execute("update calls set artifact=?", (json.dumps({"phase": "reviewing", "review_response": response}),))
            self.conn.commit()
            with self.assertRaisesRegex(RuntimeError, "unsubmitted native action"):
                review_receipt.begin_submission("Actual verdict", HEAD)

    def test_a_pushed_head_preserves_unattempted_replies_and_reserves_them_only_once(self):
        self.conn.execute("update calls set behavior='repair_pr', action_plan='{}', artifact=?",
                          (json.dumps({"phase": "publishing", "plan_sha": "c" * 64}),))
        self.conn.commit()
        review_receipt.work_publication(HEAD)
        with review_receipt.invocation_environment(self.path, CALL, True, initialize=False):
            artifact = json.loads(self.conn.execute("select artifact from calls").fetchone()[0])
            self.assertEqual((artifact["publication_head"], artifact["replies_started"]), (HEAD, False))
        self.conn.execute("update calls set status='failed', resources_settled_at=1")
        self.conn.commit()
        review_receipt.work_publication(HEAD, start_replies=True)
        with self.assertRaisesRegex(RuntimeError, "already attempted"):
            review_receipt.work_publication(HEAD, start_replies=True)

    def test_unknown_resources_or_a_changed_head_cannot_resume_an_unattempted_reply(self):
        self.conn.execute("update calls set behavior='repair_pr', action_plan='{}', status='failed', artifact=?",
                          (json.dumps({"phase": "publishing", "plan_sha": "c" * 64, "publication_head": HEAD, "replies_started": False}),))
        self.conn.commit()
        with self.assertRaisesRegex(RuntimeError, "settled native ownership"):
            review_receipt.work_publication(HEAD, start_replies=True)
        self.conn.execute("update calls set resources_settled_at=1")
        self.conn.commit()
        with self.assertRaisesRegex(RuntimeError, "settled native ownership"):
            review_receipt.work_publication("c" * 40, start_replies=True)

    def active_publication(self):
        owned = json.loads(resource_ownership.initial(CALL, "original-publication"))
        owned["namespace"].update(state="active", controller={"version": 1, "instance": "c" * 32},
                                  binding={"pid": 104, "start": "12", "namespace": "pid:[91]",
                                           "owner": {"pid": 102, "start": "10"}, "holder": {"pid": 103, "start": "11"},
                                           "epoch": {"boot": "fixture", "init_start": "1", "namespace_dev": "2", "namespace_ino": "3"}})
        self.conn.execute("update calls set behavior='repair_pr', action_plan='{}', artifact=?,resource_ownership=?",
                          (json.dumps({"phase": "publishing", "plan_sha": "c" * 64,
                                       "publication_head": HEAD, "replies_started": False}), json.dumps(owned)))
        self.conn.commit()
        return owned

    def test_original_active_v2_call_can_reserve_its_planned_replies_without_releasing_resources(self):
        owned = self.active_publication()
        # Explicit kernel-reader stand-in; actual namespace publication guard
        # execution belongs to the isolated image component gate.
        idle = MagicMock()
        scope = SimpleNamespace(key={"callId": CALL}, require_idle=idle)
        with patch.object(native_namespace, "active", return_value=scope):
            review_receipt.work_publication(HEAD, start_replies=True)
        idle.assert_called_once_with()
        self.assertFalse(resource_ownership.released(owned))
        self.assertTrue(json.loads(self.conn.execute("select artifact from calls").fetchone()[0])["replies_started"])

    def test_a_different_or_missing_active_namespace_cannot_borrow_running_publication(self):
        self.active_publication()
        for scope in (None, SimpleNamespace(key={"callId": "d" * 32}, require_idle=MagicMock())):
            with self.subTest(scope=scope), patch.object(native_namespace, "active", return_value=scope), \
                    self.assertRaises(RuntimeError):
                review_receipt.work_publication(HEAD, start_replies=True)
        self.assertFalse(json.loads(self.conn.execute("select artifact from calls").fetchone()[0])["replies_started"])

    def test_original_executed_publication_helper_reserves_replies_without_borrowing_parent_memory(self):
        self.active_publication()
        scope = SimpleNamespace(binding={"namespace": "pid:[91]"}, read=MagicMock(return_value={"pids": [1, 2, 3]}))
        with patch.object(native_namespace, "active", return_value=None), \
                patch.object(resource_ownership, "original_scope", return_value=scope), \
                patch.object(os, "getpid", return_value=3), patch.object(os, "getppid", return_value=2), \
                patch.object(os, "readlink", return_value="pid:[91]"):
            review_receipt.work_publication(HEAD, start_replies=True)
            with self.assertRaisesRegex(RuntimeError, "already attempted"):
                review_receipt.work_publication(HEAD, start_replies=True)
        self.assertTrue(json.loads(self.conn.execute("select artifact from calls").fetchone()[0])["replies_started"])

    def test_publication_helper_refuses_foreign_scope_parent_or_remaining_worker(self):
        self.active_publication()
        for parent, namespace, pids in ((9, "pid:[91]", [1, 2, 3]), (2, "pid:[92]", [1, 2, 3]), (2, "pid:[91]", [1, 2, 3, 4])):
            scope = SimpleNamespace(binding={"namespace": "pid:[91]"}, read=lambda: {"pids": pids})
            with self.subTest(parent=parent, namespace=namespace, pids=pids), \
                    patch.object(native_namespace, "active", return_value=None), \
                    patch.object(resource_ownership, "original_scope", return_value=scope), \
                    patch.object(os, "getpid", return_value=3), patch.object(os, "getppid", return_value=parent), \
                    patch.object(os, "readlink", return_value=namespace), self.assertRaises(RuntimeError):
                review_receipt.work_publication(HEAD, start_replies=True)
        self.assertFalse(json.loads(self.conn.execute("select artifact from calls").fetchone()[0])["replies_started"])

    def test_unacknowledged_issue_comment_is_never_reclassified_as_no_write(self):
        self.conn.execute("update calls set status='failed', behavior='issue_review', resources_settled_at=1, action_plan='{}', artifact=?",
                          (json.dumps({"phase": "posting_issue_reviews"}),))
        api.mark_managed_no_write(self.conn, CALL)
        self.assertIsNone(self.conn.execute("select action from calls").fetchone()[0])
        self.conn.execute("update calls set action_plan=null, artifact=?", (json.dumps({"phase": "reviewing"}),))
        api.mark_managed_no_write(self.conn, CALL)
        self.assertEqual(self.conn.execute("select action from calls").fetchone()[0], "not_started")

    def test_resource_inspection_failure_preserves_publication_intent_and_prevents_handoff(self):
        self.conn.commit()
        with patch('agent_interface.issue_review.stop_leftovers'), patch('agent_interface.issue_review._cwd_pids', return_value=None):
            with self.assertRaisesRegex(RuntimeError, "resources could not be proven"):
                with review_receipt.managed_resources(Path(self.directory.name) / "checkout"):
                    review_receipt.begin_submission("Actual verdict", HEAD)
        artifact = json.loads(self.conn.execute("select artifact from calls").fetchone()[0])
        self.assertEqual(artifact["phase"], "submitting_review")
        self.assertEqual(artifact["resource_error"], "resources_unknown")


class AtomicWorkLimits(TestCase):
    def setUp(self):
        # Cleanup needs consistent file/directory device IDs on managed boxes.
        self.directory = TemporaryDirectory(dir="/dev/shm" if sys.platform == "linux" else None)
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.path = root / "calls.sqlite3"
        self.addCleanup(patch.stopall)
        patch.object(api, "DB", self.path).start()
        patch.object(api, "RESPONSES", root / "responses").start()
        patch.object(issue_review, "WORK_ROOT", root / "reviews").start()
        patch.object(issue_review, "cleanup").start()
        patch.object(api, "CATALOG", SimpleNamespace(issue_review_model=lambda _identity: SimpleNamespace(identity="fixture-model", provider="codex"))).start()
        api.init_db()

    def run_behavior(self, pull=None, expected_head=None):
        api.run_atomic_work("example/repo#7", "author", "poise:behavior-chain",
                            "00000000-0000-4000-8000-000000000001", "fixture-model", "poise/issue-7", pull=pull, expected_head=expected_head)

    def test_implementation_receives_its_requested_hour_instead_of_the_pr_review_cap(self):
        remaining = []

        def work(*_args, **_kwargs):
            remaining.append(review_budget.timeout(issue_review.TIMEOUT_SECONDS))
            return {"outcome": "no_changes", "head_sha": None}

        with patch.object(api.atomic_work, "run", side_effect=work), \
                patch.object(review_receipt, "managed_resources", return_value=nullcontext()), redirect_stdout(StringIO()):
            self.run_behavior()
        self.assertGreater(remaining[0], 3500)
        self.assertLessEqual(remaining[0], issue_review.TIMEOUT_SECONDS)

    def test_a_failed_worker_keeps_unknown_resource_evidence_in_its_native_receipt(self):
        with patch.object(api.atomic_work, "run", side_effect=RuntimeError("provider failed")), \
                patch.object(issue_review, "stop_leftovers"), patch.object(issue_review, "_cwd_pids", return_value=None), \
                self.assertRaisesRegex(RuntimeError, "resources could not be proven"):
            self.run_behavior()
        with sqlite3.connect(self.path) as conn:
            status, artifact, settled = conn.execute("select status, artifact, resources_settled_at from calls").fetchone()
        self.assertEqual(status, "failed")
        self.assertEqual(json.loads(artifact)["resource_error"], "resources_unknown")
        self.assertIsNone(settled)

    def test_provider_deadline_and_preflight_timeout_reach_chain_history_distinctly(self):
        repo = Path(__file__).resolve().parents[3]
        output = repo / "test-results"
        output.mkdir(exist_ok=True)
        with TemporaryDirectory(prefix="atomic-timeout-contract-", dir=output) as work:
            root = Path(work)
            env = {"PATH": os.environ["PATH"], "HOME": str(self.path.parent), "TMPDIR": work}
            build = subprocess.run([str(repo / "node_modules/esbuild/bin/esbuild"),
                                    str(repo / "tests/fixtures/behavior-fence-contract.ts"), "--bundle", "--platform=node",
                                    "--packages=external", "--format=esm", "--target=node22", f"--outfile={root / 'contract.mjs'}"],
                                   cwd=repo, env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(build.returncode, 0, build.stderr)
            for phase in ("preflight", "provider"):
                with self.subTest(phase=phase):
                    modes = []

                    def interface(*args, **kwargs):
                        if args[0] == "--pr-review":
                            return {"review_threads": []}
                        if args[0] != "--issue-work":
                            return {}
                        modes.append(args[args.index("--mode") + 1])
                        if phase == "preflight":
                            raise subprocess.TimeoutExpired("preflight", 1800)
                        return {"outcome": "prepared", "checkout_head": HEAD}

                    def worker(_lease, args, **kwargs):
                        # Even valid late metadata cannot authorize publication.
                        (Path(kwargs["cwd"]).parent / "publication.json").write_text(json.dumps({
                            "commitMessage": "fix: seed", "title": "fix: seed", "body": "Checked repair", "replies": []}))
                        raise subprocess.TimeoutExpired(args, kwargs["timeout"], output="private stdout", stderr="private stderr")

                    def execute():
                        # Use the CLI finalizer with the existing v1 library
                        # boundary; namespace execution has separate guards.
                        with patch.object(api, "_native_cli", False):
                            api.run_atomic_work("example/repo#7", "author", "poise:behavior-chain", f"timeout-{phase}",
                                                "fixture-model", "poise/issue-7", 3, HEAD)

                    expected = review_budget.ReviewLimitError if phase == "provider" else subprocess.TimeoutExpired
                    with patch.object(issue_review, "packet", return_value={"issue": {"state": "open"}}), \
                            patch.object(issue_review, "interface", side_effect=interface), \
                            patch.object(issue_review, "command", return_value=(["fixture", "private prompt"], "", {})), \
                            patch.object(issue_review, "stop_leftovers"), patch.object(issue_review, "_cwd_pids", return_value=[]), \
                            patch.object(api.atomic_work.checkout_lock, "Lease", return_value=MagicMock()), \
                            patch.object(api.atomic_work.checkout_lock, "run_gated", side_effect=worker) as provider, \
                            patch.object(review_budget, "timeout", return_value=3443.25), \
                            patch.object(api.atomic_work, "monotonic", side_effect=[10, 3453.375]), \
                            patch.object(sys, "argv", ["agent-interface", "--atomic-work", "example/repo#7", "--source",
                                                      "poise:behavior-chain", "--correlation-id", f"timeout-{phase}"]), \
                            patch.object(api, "_main", side_effect=execute), self.assertRaises(expected):
                        api.main()
                    call, = [row for row in api.logs() if row["correlation_id"] == f"timeout-{phase}"]
                    self.assertEqual(modes, ["prepare"])
                    self.assertEqual((call["status"], call["action"], call["outcome"]), ("failed", "not_started", "preflight_failed"))
                    self.assertIsNone(call["head_sha"])
                    self.assertIsNotNone(call["resources_settled_at"])
                    with api.db() as conn:
                        self.assertIsNone(conn.execute("select action_plan from calls where id=?", (call["id"],)).fetchone()[0])
                    if phase == "provider":
                        self.assertEqual(call["error_code"], "atomic_work_execution_budget_exhausted")
                        self.assertEqual(call["diagnostic"], {
                            "version": 1, "source": "caller", "severity": "error", "operation": "provider.atomic_work",
                            "phase": "provider_execution", "outcome": "timed_out", "stderr": "", "stderr_truncated": False,
                            "executable": "codex", "elapsed_ms": 3443375, "timeout_seconds": 3443.25,
                            "repository": "example/repo", "pr": 3, "expected_head": HEAD, "behavior": "repair_pr",
                            "message": "Seed issue example/repo#7", "submission": "none", "call_id": call["id"]})
                        self.assertNotIn("private", json.dumps(call))
                        provider.assert_called_once()
                    else:
                        self.assertEqual(call["error_code"], "atomic_work_failed")
                        self.assertIsNone(call["diagnostic"])
                        provider.assert_not_called()
                    wire = root / f"{phase}.json"
                    wire.write_text(json.dumps([call]))
                    consumed = subprocess.run(["node", str(root / "contract.mjs"), str(wire), f"atomic-{phase}-timeout"],
                                              cwd=repo, env=env, capture_output=True, text=True, timeout=30)
                    self.assertEqual(consumed.returncode, 0, consumed.stderr)

    def test_invalid_publication_is_a_known_unstarted_failure_without_an_action_plan(self):
        modes = []

        def interface(*args, **_kwargs):
            mode = args[args.index("--mode") + 1]
            modes.append(mode)
            if mode == "prepare":
                return {"outcome": "prepared", "checkout_head": HEAD}
            raise ValueError("publication requires Conventional Commit metadata")

        def worker(_lease, _args, **kwargs):
            output = Path(kwargs["cwd"]).parent / "publication.json"
            output.write_text(json.dumps({"commitMessage": "not a Conventional Commit", "title": "Invalid title", "body": "Fixes #8", "replies": []}))
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        with patch.object(issue_review, "packet", return_value={"issue": {"state": "open"}}), \
                patch.object(issue_review, "interface", side_effect=interface), \
                patch.object(issue_review, "command", return_value=(["fixture"], "", {})), \
                patch.object(issue_review, "_terminal_failure", return_value=None), \
                patch.object(issue_review, "stop_leftovers"), patch.object(issue_review, "_cwd_pids", return_value=[]), \
                patch.object(api.atomic_work.checkout_lock, "Lease", return_value=MagicMock()), \
                patch.object(api.atomic_work.checkout_lock, "run_gated", side_effect=worker), \
                self.assertRaisesRegex(ValueError, "Conventional Commit"):
            self.run_behavior()
        with sqlite3.connect(self.path) as conn:
            status, action, outcome, plan = conn.execute("select status, action, outcome, action_plan from calls").fetchone()
        self.assertEqual(modes, ["prepare", "validate"])
        self.assertEqual((status, action, outcome), ("failed", "not_started", "preflight_failed"))
        self.assertIsNone(plan)

    def test_repair_prompts_exact_roots_and_keeps_missing_ids_after_cleanup(self):
        threads = [
            {"root_comment_id": 17, "is_resolved": False, "is_outdated": False, "bodies": ["private current finding"]},
            {"root_comment_id": 18, "is_resolved": False, "is_outdated": True, "bodies": ["private outdated finding", "earlier reply"]},
            {"root_comment_id": 19, "is_resolved": True, "is_outdated": False, "bodies": ["private resolved finding"]},
            {"root_comment_id": 20, "is_resolved": True, "is_outdated": True, "bodies": ["private resolved outdated finding"]},
        ]
        for attempt, reply_ids in enumerate(([17], [17, 18]), 1):
            with self.subTest(reply_ids=reply_ids):
                modes, workspaces = [], []

                def interface(*args, **_kwargs):
                    if args[0] == "--pr-review":
                        return {"review_threads": threads}
                    if args[0] != "--issue-work":
                        return {}
                    mode = args[args.index("--mode") + 1]
                    modes.append(mode)
                    if mode == "prepare":
                        return {"outcome": "prepared", "checkout_head": HEAD}
                    self.assertEqual(json.loads(args[args.index("--replies-json") + 1]), replies)
                    return {"outcome": "validated" if mode == "validate" else "published", "head_sha": HEAD}

                replies = [{"commentId": root, "body": "Verified the finding against the repair and its regression."} for root in reply_ids]

                def worker(_lease, _args, **kwargs):
                    workspace = Path(kwargs["cwd"]).parent
                    workspaces.append(workspace)
                    (workspace / "publication.json").write_text(json.dumps({
                        "commitMessage": "fix: repair seed", "title": "fix: repair seed", "body": "Concrete repair and checks.",
                        "replies": replies, "blocked": None}))
                    return SimpleNamespace(returncode=0, stdout="", stderr="")

                with patch.object(issue_review, "packet", return_value={"issue": {"state": "open"}}), \
                        patch.object(issue_review, "interface", side_effect=interface), \
                        patch.object(issue_review, "command", return_value=(["fixture"], "", {})) as command, \
                        patch.object(issue_review, "_terminal_failure", return_value=None), \
                        patch.object(issue_review, "stop_leftovers"), patch.object(issue_review, "_cwd_pids", return_value=[]), \
                        patch.object(api.atomic_work.checkout_lock, "Lease", return_value=MagicMock()), \
                        patch.object(api.atomic_work.checkout_lock, "run_gated", side_effect=worker), redirect_stdout(StringIO()):
                    context = self.assertRaisesRegex(ValueError, "repair did not answer every unresolved review finding") if attempt == 1 else nullcontext()
                    with context:
                        api.run_atomic_work("example/repo#7", "author", "poise:behavior-chain",
                                            f"00000000-0000-4000-8000-{attempt:012d}", "fixture-model", "poise/issue-7", 3, HEAD)

                instruction = command.call_args.args[1]
                self.assertIn("required unresolved root comment IDs: [17, 18]", instruction)
                self.assertIn("outdated", instruction)
                self.assertIn("already have replies", instruction)
                with sqlite3.connect(self.path) as conn:
                    row = conn.execute("select status,error_code,action,outcome,error,action_plan,artifact,resource_ownership from calls "
                                       "where correlation_id=?", (f"00000000-0000-4000-8000-{attempt:012d}",)).fetchone()
                status, code, action, outcome, error, plan, artifact, ownership = row
                self.assertFalse(workspaces[0].exists(), f"publication metadata must be cleaned up: {ownership}")
                if attempt == 1:
                    self.assertEqual(modes, ["prepare"])
                    self.assertEqual((status, code, action, outcome), ("failed", "atomic_work_failed", "not_started", "preflight_failed"))
                    self.assertIn("missing_root_comment_ids=[18]", error)
                    self.assertIn("missing_count=1; required_count=2", error)
                    self.assertNotIn("private", error + artifact)
                    self.assertIsNone(plan)
                    with self.assertRaisesRegex(ValueError, "no durable publication plan"):
                        with api.db() as conn:
                            call = conn.execute("select id from calls where correlation_id=?",
                                                (f"00000000-0000-4000-8000-{attempt:012d}",)).fetchone()[0]
                        api.complete_atomic_publication(call, "c" * 64, HEAD)
                else:
                    self.assertEqual(modes, ["prepare", "validate", "publish"])
                    self.assertEqual((status, action, outcome), ("completed", "published", "published"))

    def test_summary_only_change_request_reaches_repair_prompt_without_required_replies(self):
        review = {"id": 91, "state": "CHANGES_REQUESTED", "commit_id": HEAD, "user": {"login": "reviewer"},
                  "body": "  Verify the current-head failure before repairing it.\n", "submitted_at": "2026-11-08T19:51:00Z",
                  "html_url": "https://github.com/example/repo/pull/3#pullrequestreview-91"}
        client = AsyncMock()
        client.paginate.return_value = [review]
        modes = []

        def interface(*args, **_kwargs):
            if args[0] == "--pr-review":
                return asyncio.run(pr_review.run(client, {"repository": "example/repo", "pr": 3, "expected_head": HEAD}))
            if args[0] != "--issue-work":
                return {}
            mode = args[args.index("--mode") + 1]
            modes.append(mode)
            if mode == "prepare":
                return {"outcome": "prepared", "checkout_head": HEAD}
            self.assertEqual(json.loads(args[args.index("--replies-json") + 1]), [])
            return {"outcome": "validated" if mode == "validate" else "published", "head_sha": HEAD}

        def worker(_lease, _args, **kwargs):
            (Path(kwargs["cwd"]).parent / "publication.json").write_text(json.dumps({
                "commitMessage": "fix: repair seed", "title": "fix: repair seed", "body": "Concrete repair and checks.",
                "replies": [], "blocked": None}))
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        with patch.object(pr_review, "get_pull", AsyncMock(return_value={"head": {"sha": HEAD}, "base": {"sha": "c" * 40}})), \
                patch.object(pr_review, "list_inline_comments", AsyncMock(return_value=[])), \
                patch.object(pr_review, "issue_comments", AsyncMock(return_value=[])), \
                patch.object(pr_review, "list_review_threads", AsyncMock(return_value=[])), \
                patch.object(pr_review, "linked_issues", AsyncMock(return_value=[])), \
                patch.object(pr_review, "review_diff", AsyncMock(return_value={})), \
                patch.object(issue_review, "packet", return_value={"issue": {"state": "open"}}), \
                patch.object(issue_review, "interface", side_effect=interface), \
                patch.object(issue_review, "command", return_value=(["fixture"], "", {})) as command, \
                patch.object(issue_review, "_terminal_failure", return_value=None), \
                patch.object(issue_review, "stop_leftovers"), patch.object(issue_review, "_cwd_pids", return_value=[]), \
                patch.object(api.atomic_work.checkout_lock, "Lease", return_value=MagicMock()), \
                patch.object(api.atomic_work.checkout_lock, "run_gated", side_effect=worker), redirect_stdout(StringIO()):
            api.run_atomic_work("example/repo#7", "author", "poise:behavior-chain", "summary-only-repair",
                                "fixture-model", "poise/issue-7", 3, HEAD)

        instruction = command.call_args.args[1]
        packet = json.loads(instruction.split("Actual PR evidence:\n", 1)[1])["review_packet"]
        self.assertEqual(packet["change_request_reviews"], [
            {"id": 91, "user": "reviewer", "state": "CHANGES_REQUESTED", "commit_id": HEAD,
             "submitted_at": review["submitted_at"], "url": review["html_url"], "body": review["body"]}
        ])
        self.assertEqual(packet["review_threads"], [])
        self.assertIn("required unresolved root comment IDs: []", instruction)
        self.assertIn("address every actionable review/CI/conflict blocker", instruction)
        self.assertIn("Run the repository's required checks", instruction)
        self.assertEqual(modes, ["prepare", "validate", "publish"])

    def test_explicit_work_blocker_keeps_its_own_code_without_attempting_publication(self):
        modes = []
        reason = "Review requires a product decision before implementation can continue"

        def interface(*args, **_kwargs):
            modes.append(args[args.index("--mode") + 1])
            return {"outcome": "prepared", "checkout_head": HEAD}

        def worker(_lease, _args, **kwargs):
            (Path(kwargs["cwd"]).parent / "publication.json").write_text(json.dumps({"blocked": reason}))
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        with patch.object(issue_review, "packet", return_value={"issue": {"state": "open"}}), \
                patch.object(issue_review, "interface", side_effect=interface), \
                patch.object(issue_review, "command", return_value=(["fixture"], "", {})), \
                patch.object(issue_review, "_terminal_failure", return_value=None), \
                patch.object(issue_review, "stop_leftovers"), patch.object(issue_review, "_cwd_pids", return_value=[]), \
                patch.object(api.atomic_work.checkout_lock, "Lease", return_value=MagicMock()), \
                patch.object(api.atomic_work.checkout_lock, "run_gated", side_effect=worker), \
                self.assertRaisesRegex(ValueError, reason):
            self.run_behavior()
        with sqlite3.connect(self.path) as conn:
            status, code, action, outcome, plan = conn.execute("select status,error_code,action,outcome,action_plan from calls").fetchone()
        self.assertEqual(modes, ["prepare"])
        self.assertEqual((status, code, action, outcome), ("failed", "atomic_work_blocked", "not_started", "preflight_failed"))
        self.assertIsNone(plan)

    def test_ci_only_blocker_retains_the_supplied_head_and_failed_job_attempt_without_publication(self):
        ci = {"action": "list_failing_ci", "repository": "example/repo", "pull_number": 3, "head_sha": HEAD,
              "failing": [{"type": "check_run", "name": "unit", "state": "completed", "conclusion": "failure",
                           "check_run_id": 41, "log_id": 42, "url": "https://github.com/example/repo/actions/runs/40/job/42"}]}
        commands = []

        def interface(*args, **_kwargs):
            commands.append(args[0])
            if args[0] == "--issue-work" and args[args.index("--mode") + 1] == "prepare":
                return {"outcome": "prepared", "checkout_head": HEAD}
            return {"--list-failing-ci": ci, "--pr-review": {"review_threads": []}, "--pull-action-state": {}}[args[0]]

        def worker(_lease, _args, **kwargs):
            (Path(kwargs["cwd"]).parent / "publication.json").write_text(json.dumps({
                "blocked": {"cause": "ci_only", "reason": "The supplied unit job failed"}}))
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        with patch.object(issue_review, "packet", return_value={"issue": {"state": "open"}}), \
                patch.object(issue_review, "interface", side_effect=interface), \
                patch.object(issue_review, "command", return_value=(["fixture"], "", {})), \
                patch.object(issue_review, "_terminal_failure", return_value=None), \
                patch.object(issue_review, "stop_leftovers"), patch.object(issue_review, "_cwd_pids", return_value=[]), \
                patch.object(api.atomic_work.checkout_lock, "Lease", return_value=MagicMock()), \
                patch.object(api.atomic_work.checkout_lock, "run_gated", side_effect=worker), \
                self.assertRaisesRegex(ValueError, "The supplied unit job failed"):
            self.run_behavior(pull=3, expected_head=HEAD)
        with sqlite3.connect(self.path) as conn:
            status, code, action, artifact, plan = conn.execute("select status,error_code,action,artifact,action_plan from calls").fetchone()
        self.assertEqual(commands, ["--issue-work", "--list-failing-ci", "--pr-review", "--pull-action-state"])
        self.assertEqual((status, code, action), ("failed", "atomic_work_blocked", "not_started"))
        self.assertEqual(json.loads(artifact)["ci_blocker"], ci)
        self.assertIsNone(plan)

    def test_ci_only_blocker_drops_check_summaries_to_fit_the_receipt_limit(self):
        failing = [{"type": "check_run", "name": f"unit-{index}", "state": "completed", "conclusion": "failure",
                    "check_run_id": 41 + index, "log_id": 42 + index,
                    "url": f"https://github.com/example/repo/actions/runs/40/job/{42 + index}",
                    "summary": "x" * (50 * 1024)} for index in range(3)]
        ci = {"action": "list_failing_ci", "repository": "example/repo", "pull_number": 3, "head_sha": HEAD,
              "failing": failing, "mergeable": True, "author": "author", "state": "open", "merged": False}

        def interface(*args, **_kwargs):
            if args[0] == "--issue-work" and args[args.index("--mode") + 1] == "prepare":
                return {"outcome": "prepared", "checkout_head": HEAD}
            return {"--list-failing-ci": ci, "--pr-review": {"review_threads": []}, "--pull-action-state": {}}[args[0]]

        def worker(_lease, _args, **kwargs):
            (Path(kwargs["cwd"]).parent / "publication.json").write_text(json.dumps({
                "blocked": {"cause": "ci_only", "reason": "The supplied unit job failed"}}))
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        with patch.object(issue_review, "packet", return_value={"issue": {"state": "open"}}), \
                patch.object(issue_review, "interface", side_effect=interface), \
                patch.object(issue_review, "command", return_value=(["fixture"], "", {})), \
                patch.object(issue_review, "_terminal_failure", return_value=None), \
                patch.object(issue_review, "stop_leftovers"), patch.object(issue_review, "_cwd_pids", return_value=[]), \
                patch.object(api.atomic_work.checkout_lock, "Lease", return_value=MagicMock()), \
                patch.object(api.atomic_work.checkout_lock, "run_gated", side_effect=worker), \
                self.assertRaisesRegex(ValueError, "The supplied unit job failed"):
            self.run_behavior(pull=3, expected_head=HEAD)
        with sqlite3.connect(self.path) as conn:
            status, code, action, artifact, plan = conn.execute("select status,error_code,action,artifact,action_plan from calls").fetchone()
        self.assertEqual((status, code, action), ("failed", "atomic_work_blocked", "not_started"))
        stored = json.loads(artifact)["ci_blocker"]
        self.assertEqual(stored, {"action": "list_failing_ci", "repository": "example/repo", "pull_number": 3,
                                  "head_sha": HEAD,
                                  "failing": [{key: entry[key] for key in
                                               ("type", "name", "state", "conclusion", "check_run_id", "log_id", "url")}
                                              for entry in failing]})
        self.assertNotIn("summary", json.dumps(stored))
        self.assertLess(len(artifact.encode()), 128 * 1024)
        self.assertIsNone(plan)

    def test_repair_completion_reuses_the_original_plan_without_a_worker_or_new_call(self):
        call = api.track("fixture-model", "repair", "3", "example/repo", "author", "repair_pr", source="poise:behavior-chain")
        publication = {"title": "fix: repair seed", "body": "Concrete repair", "replies": [{"commentId": 17, "body": "Fixed."}]}
        digest = api.persist_action_plan(call, {"kind": "atomic_work", "publication": publication})
        artifact = {"phase": "publishing", "plan_sha": digest, "publication_head": HEAD, "replies_started": False,
                    "prepared": {"repository": "example/repo", "issue_number": 7, "pull_number": 3, "branch": "poise/issue-7", "actor": "author"}}
        with api.db() as conn:
            conn.execute("update calls set status='failed',resources_settled_at=1,artifact=? where id=?", (json.dumps(artifact), call))
        with patch.object(issue_review, "interface", return_value={"outcome": "published"}) as interface:
            self.assertEqual(api.complete_atomic_publication(call, digest, HEAD), {"outcome": "published"})
        args = interface.call_args.args
        self.assertEqual(args[args.index("--invocation-id") + 1], call)
        self.assertEqual(json.loads(args[args.index("--replies-json") + 1]), publication["replies"])
        for changed in ({"replies_started": True}, {"publication_head": "c" * 40}, {"plan_sha": "c" * 64}):
            with self.subTest(changed=changed), api.db() as conn:
                conn.execute("update calls set artifact=? where id=?", (json.dumps({**artifact, **changed}), call))
            with self.assertRaisesRegex(ValueError, "original unattempted"):
                api.complete_atomic_publication(call, digest, HEAD)
        with api.db() as conn:
            self.assertEqual(conn.execute("select count(*) from calls").fetchone()[0], 1)

    def test_a_failed_cleanup_is_recorded_durably_beside_the_native_receipt(self):
        call = api.track("fixture-model", "", "7", "example/repo", "author", "implement_issue", source="poise:behavior-chain")
        with api.db() as conn:
            conn.execute("update calls set status='completed',artifact=? where id=?",
                         (json.dumps({"phase": "published", "plan_sha": "d" * 64}), call))
        api.record_cleanup_failure(call)
        with api.db() as conn:
            artifact = json.loads(conn.execute("select artifact from calls where id=?", (call,)).fetchone()[0])
        self.assertEqual(artifact["resource_error"], "cleanup_failed")
        self.assertEqual((artifact["phase"], artifact["plan_sha"]), ("published", "d" * 64))
