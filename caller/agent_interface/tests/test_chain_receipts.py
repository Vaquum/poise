"""Durable native-effect receipts; these guards do not validate live cycles."""
import asyncio
import json
import os
import sqlite3
import subprocess
import sys
from contextlib import nullcontext, redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import AsyncMock, MagicMock, patch

import httpx

import agent_interface as api
from agent_interface import issue_review, native_namespace, review_budget, review_receipt, resource_ownership
from github_interface import cli as github_cli, interface as github_api
from github_interface.behaviors import pr_review
from github_interface.behaviors import issue_work

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
        for helper, parent, namespace, pids, reason in (
                (2, 2, "pid:[91]", [1, 2], "helper_pid"),
                (3, 9, "pid:[91]", [1, 2, 3], "helper_parent"),
                (3, 2, "pid:[92]", [1, 2, 3], "helper_namespace"),
                (3, 2, "pid:[91]", [1, 3], "namespace_members"),
                (3, 2, "pid:[91]", [1, 2, 3, 4], "namespace_busy")):
            scope = SimpleNamespace(binding={"namespace": "pid:[91]"}, read=MagicMock(return_value={"pids": pids}))
            with self.subTest(parent=parent, namespace=namespace, pids=pids), \
                    patch.object(native_namespace, "active", return_value=None), \
                    patch.object(resource_ownership, "original_scope", return_value=scope), \
                    patch.object(os, "getpid", return_value=helper), patch.object(os, "getppid", return_value=parent), \
                    patch.object(os, "readlink", return_value=namespace), \
                    patch.object(review_receipt.time, "monotonic", side_effect=[0, 0, 0, 0, 2]), \
                    self.assertRaisesRegex(RuntimeError, reason):
                review_receipt.work_publication(HEAD, start_replies=True)
            if reason.startswith("helper_"):
                scope.read.assert_not_called()
        self.assertFalse(json.loads(self.conn.execute("select artifact from calls").fetchone()[0])["replies_started"])

    def test_executed_helper_waits_only_for_extra_members_with_reads_bounded_by_remaining_time(self):
        self.active_publication()
        scope = SimpleNamespace(binding={"namespace": "pid:[91]"}, read=MagicMock(side_effect=[
            {"pids": [1, 2, 3, 4]}, {"pids": [1, 2, 3]}]))
        with patch.object(native_namespace, "active", return_value=None), \
                patch.object(resource_ownership, "original_scope", return_value=scope), \
                patch.object(os, "getpid", return_value=3), patch.object(os, "getppid", return_value=2), \
                patch.object(os, "readlink", return_value="pid:[91]"), \
                patch.object(review_receipt.time, "monotonic", side_effect=[0, 0.2, 0.25, 0.3, 0.4, 0.5]):
            review_receipt.work_publication(HEAD, start_replies=True)
        self.assertEqual([read.kwargs["timeout_seconds"] for read in scope.read.call_args_list], [1.8, 1.6])
        self.assertTrue(json.loads(self.conn.execute("select artifact from calls").fetchone()[0])["replies_started"])

    def test_executed_helper_rejects_idle_evidence_arriving_after_the_settlement_deadline(self):
        self.active_publication()
        scope = SimpleNamespace(binding={"namespace": "pid:[91]"}, read=MagicMock(return_value={"pids": [1, 2, 3]}))
        with patch.object(native_namespace, "active", return_value=None), \
                patch.object(resource_ownership, "original_scope", return_value=scope), \
                patch.object(os, "getpid", return_value=3), patch.object(os, "getppid", return_value=2), \
                patch.object(os, "readlink", return_value="pid:[91]"), \
                patch.object(review_receipt.time, "monotonic", side_effect=[0, 0, 2.1]), \
                self.assertRaisesRegex(RuntimeError, "namespace_read_timeout"):
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

    def test_legacy_publication_head_and_unstarted_replies_do_not_prove_an_unattempted_push(self):
        self.conn.execute("update calls set status='failed', behavior='repair_pr', resources_settled_at=1, action_plan='{}', artifact=?",
                          (json.dumps({"phase": "publishing", "plan_sha": "c" * 64,
                                       "publication_head": HEAD, "replies_started": False}),))
        for _ in range(3):
            api.mark_managed_no_write(self.conn, CALL)
            self.assertEqual(self.conn.execute("select action,outcome from calls").fetchone(), (None, None))

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

    def run_behavior(self, pull=None, expected_head=None, correlation_id="00000000-0000-4000-8000-000000000001"):
        api.run_atomic_work("example/repo#7", "author", "poise:behavior-chain",
                            correlation_id, "fixture-model", "poise/issue-7", pull=pull, expected_head=expected_head)

    def test_same_head_merge_at_validation_or_publication_settles_through_native_receipts(self):
        repo = Path(__file__).resolve().parents[3]
        output = repo / "test-results"
        output.mkdir(exist_ok=True)
        with TemporaryDirectory(prefix="merged-repair-contract-", dir=output) as work:
            root = Path(work)
            env = {"PATH": os.environ["PATH"], "HOME": str(self.path.parent), "TMPDIR": work}
            build = subprocess.run([str(repo / "node_modules/esbuild/bin/esbuild"),
                                    str(repo / "tests/fixtures/behavior-fence-contract.ts"), "--bundle", "--platform=node",
                                    "--packages=external", "--format=esm", "--target=node22", f"--outfile={root / 'contract.mjs'}"],
                                   cwd=repo, env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(build.returncode, 0, build.stderr)
            for scenario, deleted in (("validate", False), ("validate", True), ("publish", False), ("publish", True),
                                      ("refused", True), ("read-failed", False)):
                with self.subTest(scenario=scenario, deleted=deleted):
                    modes, commands = [], []
                    original_interface = issue_review.interface
                    client = AsyncMock(token="private-token")

                    def pull():
                        merged = scenario != "refused" and (scenario != "publish" or modes[-1] == "publish")
                        return {"number": 3, "state": "closed" if merged or scenario == "refused" else "open",
                                "merged": merged, "merged_at": "2026-11-13T20:51:13Z" if merged else None,
                                "merge_commit_sha": "d" * 40, "user": {"login": "author"},
                                "body": "<!-- poise-chain example/repo#7 -->",
                                "head": {"ref": "poise/issue-7", "sha": HEAD, "repo": {"full_name": "example/repo"}}}

                    async def get(path):
                        if path == "/repos/example/repo":
                            return {"full_name": "example/repo", "default_branch": "main"}
                        if path.endswith("/pulls/3"):
                            if scenario == "read-failed":
                                request = httpx.Request("GET", "https://api.github.com" + path)
                                raise httpx.ReadError("repair PR read unavailable private-token", request=request)
                            return pull()
                        self.assertEqual(path, "/repos/example/repo/issues/7")
                        return {"state": "closed" if pull()["state"] == "closed" else "open"}

                    async def paginate(path, params=None):
                        if path.endswith("/comments"):
                            return [{"id": 17}]
                        return [pull()] if params["state"] == "all" else []

                    async def graph(*_args):
                        return {"repository": {"ref": None if deleted and pull()["merged"] else {
                            "target": {"oid": HEAD, "message": "Original repair head"}},
                            "defaultBranchRef": {"target": {"oid": "d" * 40}},
                            "issue": {"closedByPullRequestsReferences": {"nodes": [], "pageInfo": {"hasNextPage": False}}}}}

                    client.get.side_effect, client.paginate.side_effect, client.graphql.side_effect = get, paginate, graph

                    def interface(*args, **kwargs):
                        if args[0] != "--issue-work":
                            return {"review_threads": [{"root_comment_id": 17, "is_resolved": False}]}
                        mode = args[args.index("--mode") + 1]
                        modes.append(mode)
                        if mode == "prepare":
                            return {"outcome": "prepared", "checkout_head": HEAD}
                        return original_interface(*args, **kwargs)

                    def command(args, **_kwargs):
                        stdout, stderr, code = StringIO(), StringIO(), 0
                        with patch.object(sys, "argv", args), redirect_stdout(stdout), redirect_stderr(stderr):
                            try:
                                github_cli.main()
                            except SystemExit as stopped:
                                code = stopped.code
                        # Caller must still ignore arbitrary stderr outside its envelope.
                        return SimpleNamespace(returncode=code, communicate=lambda **_kwargs: (
                            stdout.getvalue(), "private raw stderr\n" + stderr.getvalue()))

                    def git(args, *_args):
                        commands.append(args[3:])
                        return {("branch", "--show-current"): "poise/issue-7",
                                ("remote", "get-url", "origin"): "https://github.com/example/repo.git",
                                ("rev-parse", "HEAD"): HEAD, ("status", "--porcelain"): " M candidate.txt"}[tuple(args[3:])]

                    def worker(_lease, _args, **kwargs):
                        (Path(kwargs["cwd"]).parent / "publication.json").write_text(json.dumps({
                            "commitMessage": "fix: seed", "title": "fix: seed", "body": "Completed repair",
                            "replies": [{"commentId": 17, "body": "Fixed the finding and checked the regression."}]}))
                        return SimpleNamespace(returncode=0, stdout="", stderr="")

                    correlation = f"merged-repair-{scenario}-{deleted}"

                    def execute():
                        # Exercise the CLI finalizer using the existing v1
                        # library boundary, without a physical provider.
                        with patch.object(api, "_native_cli", False):
                            self.run_behavior(3, HEAD, correlation)

                    with patch.object(issue_review, "packet", return_value={"issue": {"state": "open"}}), \
                            patch.object(issue_review, "interface", side_effect=interface), \
                            patch.object(issue_review.subprocess, "Popen", side_effect=command), \
                            patch.object(issue_review, "command", return_value=(["fixture"], "", {})), \
                            patch.object(issue_review, "_terminal_failure", return_value=None), \
                            patch.object(issue_review, "stop_leftovers"), patch.object(issue_review, "_cwd_pids", return_value=[]), \
                            patch.object(api.atomic_work.checkout_lock, "Lease", return_value=MagicMock()), \
                            patch.object(api.atomic_work.checkout_lock, "run_gated", side_effect=worker), \
                            patch.object(github_api, "GitHubClient", return_value=client), \
                            patch.object(issue_work, "_run", side_effect=git), \
                            patch.object(sys, "argv", ["agent-interface", "--atomic-work", "example/repo#7", "--source",
                                                      "poise:behavior-chain", "--correlation-id", correlation]), \
                            patch.object(api, "_main", side_effect=execute), \
                            patch.object(issue_work, "work_publication") as checkpoint, redirect_stdout(StringIO()):
                        if scenario in {"refused", "read-failed"}:
                            with self.assertRaises(RuntimeError):
                                api.main()
                        else:
                            api.main()
                    call, = [row for row in api.logs() if row["correlation_id"] == correlation]
                    self.assertIsNotNone(call["resources_settled_at"])
                    if scenario in {"refused", "read-failed"}:
                        self.assertEqual((call["status"], call["action"], call["outcome"]), ("failed", "not_started", "preflight_failed"))
                        self.assertEqual(call["diagnostic"]["operation"], "issue_work.validate")
                        self.assertEqual(call["diagnostic"]["severity"], "error")
                        self.assertIn("no longer an open issue" if scenario == "refused" else "GET /repos/example/repo/pulls/3", call["error"])
                    else:
                        self.assertEqual((call["status"], call["action"], call["outcome"], call["head_sha"]),
                                         ("superseded", None, "superseded", HEAD))
                        self.assertIsNone(call["diagnostic"])
                    for private in ("private-token", "private raw stderr"):
                        self.assertNotIn(private, json.dumps(call))
                    self.assertEqual(modes, ["prepare", "validate", "publish"] if scenario == "publish" else ["prepare", "validate"])
                    self.assertEqual(bool(commands), scenario == "publish")
                    checkpoint.assert_not_called()
                    client.post.assert_not_awaited()
                    client.patch.assert_not_awaited()
                    wire = root / "call.json"
                    wire.write_text(json.dumps([call]))
                    consumed = subprocess.run(["node", str(root / "contract.mjs"), str(wire),
                                               "atomic-work-failed" if scenario in {"refused", "read-failed"} else "atomic-merged-repair"],
                                              cwd=repo, env=env, capture_output=True, text=True, timeout=30)
                    self.assertEqual(consumed.returncode, 0, consumed.stderr)

    def test_verified_relay_no_result_instructions_hand_the_exact_candidate_to_normal_publication(self):
        for pull, exit_code, reason in (
            (None, 124, "the test offload exhausted its total time budget"),
            (3, 125, "the connection to the test relay ended before the suite did"),
        ):
            with self.subTest(pull=pull, exit_code=exit_code):
                modes, instructions = [], []
                diagnostic = (f"[poise] no test result: {reason}. This says nothing about your code. "
                              "Skip local tests for this work: don't retry, and don't run parts of it. "
                              "Push your change and let CI run the tests.")
                publication = {
                    "commitMessage": "fix: seed", "title": "fix: seed", "replies": [], "blocked": None,
                    "body": f"npm run check passed. npm run test:e2e exited {exit_code} after 52 of 99 Chromium tests. "
                            f"{diagnostic} Local browser verification is incomplete; PR CI must complete it.",
                }
                candidate = None

                def interface(*args, **_kwargs):
                    nonlocal candidate
                    if args[0] != "--issue-work":
                        return {"review_threads": []}
                    mode = args[args.index("--mode") + 1]
                    modes.append(mode)
                    if mode == "prepare":
                        candidate = Path(args[args.index("--path") + 1])
                        candidate.mkdir(parents=True)
                        return {"outcome": "prepared", "checkout_head": HEAD}
                    self.assertEqual(Path(args[args.index("--path") + 1]), candidate)
                    self.assertEqual(args[args.index("--starting-head") + 1], HEAD)
                    self.assertEqual((candidate / "candidate.txt").read_text(), "completed candidate edits")
                    self.assertEqual(args[args.index("--body") + 1], publication["body"])
                    return {"outcome": "validated" if mode == "validate" else "published", "head_sha": HEAD}

                def command(_model, instruction, *_args):
                    instructions.append(instruction)
                    return ["fixture"], "", {}

                def worker(_lease, _args, **kwargs):
                    self.assertEqual(Path(kwargs["cwd"]), candidate)
                    (candidate / "candidate.txt").write_text("completed candidate edits")
                    (candidate.parent / "publication.json").write_text(json.dumps(publication))
                    return SimpleNamespace(returncode=0, stdout="", stderr="")

                with patch.object(issue_review, "packet", return_value={"issue": {"state": "open"}}), \
                        patch.object(issue_review, "interface", side_effect=interface), \
                        patch.object(issue_review, "command", side_effect=command), \
                        patch.object(issue_review, "_terminal_failure", return_value=None), \
                        patch.object(issue_review, "stop_leftovers"), patch.object(issue_review, "_cwd_pids", return_value=[]), \
                        patch.object(api.atomic_work.checkout_lock, "Lease", return_value=MagicMock()), \
                        patch.object(api.atomic_work.checkout_lock, "run_gated", side_effect=worker), redirect_stdout(StringIO()):
                    self.run_behavior(pull, HEAD if pull else None, f"relay-no-result-{exit_code}")
                for clause in (
                    'require the final relay diagnostic for that command saying "no test result:" and "Skip local tests for this work"',
                    "Exit 124/125 alone or an interrupted attempt followed by a genuine suite result does not authorize this handoff",
                    "Do not retry or run parts of the suite after that final diagnostic. If the work is otherwise complete",
                    "preserve the exact candidate checkout and unchanged HEAD",
                    "record the command, relay diagnostic/reason, incomplete local verification and required CI in body",
                    "return complete publication metadata with blocked null so Caller can validate and publish normally",
                    "Never report the incomplete check as passed. Required CI and review remain mandatory",
                    "Genuine suite failures, provider execution-budget exhaustion and other blockers remain blockers",
                ):
                    self.assertIn(clause, instructions[0])
                self.assertEqual(modes, ["prepare", "validate", "publish"])
                with sqlite3.connect(self.path) as conn:
                    status, action, plan = conn.execute(
                        "select status,action,action_plan from calls order by rowid desc limit 1").fetchone()
                self.assertEqual((status, action), ("completed", "published"))
                self.assertEqual(json.loads(plan)["publication"], publication)

    def test_shared_ci_dependency_waits_without_publication_only_without_edits_and_mixed_or_unknown_failures_are_not_excused(self):
        base, integration = "c" * 40, "d" * 40
        excerpt = "Error: timed out waiting: the first Vitest assertion before interruption"
        # GitHub job logs 132463172632 and 132465258335 (#1859).
        logs = {
            "11": "2026-11-14T13:38:29.8312034Z \x1b[31m\x1b[1mError\x1b[22m: timed out waiting: the first Vitest assertion before interruption",
            "21": "2026-11-14T13:47:24.6393561Z \x1b[31m\x1b[1mError\x1b[22m: timed out waiting: the first Vitest assertion before interruption",
        }
        dependency = {"head": HEAD, "removal": "removed", "integration": integration, "base": base,
                      "remediation": "https://github.com/example/repo/pull/99",
                      "failures": [{"check": 11, "baselineCheck": 21, "evidence": excerpt}]}
        check = {"check_run_id": 11, "head_sha": integration, "name": "unit", "state": "completed", "conclusion": "failure",
                 "run_id": 10, "log_id": 11}
        baseline_check = {**check, "check_run_id": 21, "head_sha": base, "run_id": 20, "log_id": 21}
        queue = {"head_sha": HEAD, "queue_removals": [{"id": "removed", "reason": "failed_checks", "beforeCommit": {"oid": integration}}]}
        scenarios = ("shared", "shared-styled", "shared-edits", "candidate-only", "mixed", "mixed-unfixed",
                     "wrong-head", "wrong-parent", "wrong-base", "wrong-event", "wrong-workflow", "missing-cause",
                     "changed-assertion", "short-excerpt", "oversized-excerpt", "non-sgr")
        for index, scenario in enumerate(scenarios):
            with self.subTest(scenario=scenario):
                modes, reads, instructions = [], [], []
                evidence = excerpt
                if scenario == "shared-styled":
                    evidence = "\x1b[1mError\x1b[0m: timed out waiting: the first Vitest assertion before interruption"
                if scenario == "changed-assertion":
                    evidence = excerpt.replace("first", "different")
                if scenario == "short-excerpt":
                    evidence = "\x1b[31m" * 4 + "Error" + "\x1b[0m"
                if scenario == "oversized-excerpt":
                    evidence = "\x1b[31m" * 400 + excerpt
                dependency["failures"][0]["evidence"] = evidence
                integration_data = {"head_sha": HEAD, "ref": integration, "parents": [base, HEAD], "failing": [check],
                                    "runs": [{"id": 10, "head_sha": integration, "event": "merge_group", "workflow_id": 1}]}
                base_data = {"head_sha": HEAD, "ref": base, "failing": [baseline_check],
                             "runs": [{"id": 20, "head_sha": base, "event": "push", "workflow_id": 1}]}
                if scenario.startswith("mixed"):
                    integration_data["failing"] = [check, {**check, "check_run_id": 12, "name": "candidate regression"}]
                if scenario == "wrong-head":
                    integration_data["head_sha"] = "e" * 40
                if scenario == "wrong-parent":
                    integration_data["parents"] = [base, "e" * 40]
                if scenario == "wrong-base":
                    base_data["ref"] = "e" * 40
                if scenario == "wrong-event":
                    integration_data["runs"][0]["event"] = "pull_request"
                if scenario == "wrong-workflow":
                    base_data["runs"][0]["workflow_id"] = 2

                def interface(*args, **_kwargs):
                    reads.append(args)
                    if args[0] == "--issue-work":
                        mode = args[args.index("--mode") + 1]
                        modes.append(mode)
                        return {"outcome": {"prepare": "prepared", "validate": "validated", "publish": "published"}[mode],
                                "checkout_head": HEAD, "head_sha": HEAD, "has_changes": scenario in {"mixed", "candidate-only", "shared-edits"}}
                    if args[0] == "--pr-review":
                        return {"review_threads": []}
                    if args[0] == "--pull-action-state":
                        return queue
                    if args[0] == "--list-failing-ci":
                        if "--ref" not in args:
                            return {"failing": []}
                        return integration_data if args[-1] == integration else base_data
                    if args[0] == "--read-failing-ci-log":
                        log = logs[args[1]]
                        if scenario == "missing-cause" and args[1] == "21":
                            log = "different failure"
                        if scenario == "non-sgr":
                            log = log.replace("Error", "Error\x1b[2K")
                        return {"repository": "example/repo", "log": log}
                    if args[0] == "--read-issue":
                        return {"issue": {"number": 99}}
                    raise AssertionError(args)

                def worker(_lease, _args, **kwargs):
                    publication = {"commitMessage": "fix: candidate", "title": "fix: candidate", "body": "Fix the candidate only", "replies": []}
                    if scenario != "candidate-only":
                        publication["ciDependency"] = dependency
                    if scenario == "shared-edits":
                        checkout = Path(kwargs["cwd"])
                        checkout.mkdir(parents=True, exist_ok=True)
                        (checkout / "candidate-fix.txt").write_text("candidate-specific fix co-located in the shared check")
                    (Path(kwargs["cwd"]).parent / "publication.json").write_text(json.dumps(publication))
                    return SimpleNamespace(returncode=0, stdout="", stderr="")

                def command(_model, instruction, *_args):
                    instructions.append(instruction)
                    return ["fixture"], "", {}

                with patch.object(issue_review, "packet", return_value={"issue": {"state": "open"}}), \
                        patch.object(issue_review, "interface", side_effect=interface), patch.object(issue_review, "command", side_effect=command), \
                        patch.object(issue_review, "_terminal_failure", return_value=None), patch.object(issue_review, "stop_leftovers"), \
                        patch.object(issue_review, "_cwd_pids", return_value=[]), \
                        patch.object(api.atomic_work.checkout_lock, "Lease", return_value=MagicMock()), \
                        patch.object(api.atomic_work.checkout_lock, "run_gated", side_effect=worker), redirect_stdout(StringIO()):
                    if scenario in {"shared", "shared-styled", "shared-edits", "mixed", "candidate-only"}:
                        self.run_behavior(3, HEAD, f"00000000-0000-4000-8000-{index + 1:012d}")
                    else:
                        with self.assertRaises(ValueError):
                            self.run_behavior(3, HEAD, f"00000000-0000-4000-8000-{index + 1:012d}")
                with sqlite3.connect(self.path) as conn:
                    row = conn.execute("select status,action,artifact,action_plan from calls order by rowid desc limit 1").fetchone()
                if scenario in {"shared", "shared-styled"}:
                    self.assertEqual(modes, ["prepare", "validate"])
                    self.assertEqual(row[:2], ("completed", "no_changes"))
                    self.assertIsNone(row[3])
                    self.assertEqual(json.loads(row[2])["ci_dependency"]["failures"][0]["run"], 10)
                    self.assertEqual(json.loads(row[2])["ci_dependency"]["failures"][0]["evidence"], evidence)
                    self.assertTrue(json.loads(row[2])["ci_dependency"]["allShared"])
                    self.assertEqual(json.loads(row[2])["phase"], "waiting_baseline")
                    self.assertIn("Never independently edit a verified shared baseline failure", instructions[0])
                    self.assertIn("shared-only failure leave blocked null", instructions[0])
                elif scenario in {"shared-edits", "mixed", "candidate-only"}:
                    self.assertEqual(modes, ["prepare", "validate", "publish"])
                    self.assertEqual(row[:2], ("completed", "published"))
                    if scenario == "mixed":
                        self.assertFalse(json.loads(row[2])["ci_dependency"]["allShared"])
                    if scenario == "shared-edits":
                        self.assertTrue(json.loads(row[2])["ci_dependency"]["allShared"])
                else:
                    self.assertNotIn("publish", modes)
                    self.assertEqual(row[:2], ("failed", "not_started"))

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

    def test_provider_deadline_with_retained_lease_records_unknown_ownership(self):
        modes = []

        def interface(*args, **_kwargs):
            self.assertEqual(args[0], "--issue-work")
            mode = args[args.index("--mode") + 1]
            modes.append(mode)
            self.assertEqual(mode, "prepare", "unverified checkout reached publication")
            Path(args[args.index("--path") + 1]).mkdir()
            return {"outcome": "prepared", "checkout_head": HEAD}

        with patch.dict(os.environ, {"POISE_LOCK_DIR": str(self.path.parent / "locks")}), \
                patch.object(issue_review, "packet", return_value={"issue": {"state": "open"}}), \
                patch.object(issue_review, "interface", side_effect=interface), \
                patch.object(issue_review, "command", return_value=(
                    [sys.executable, "-c", "import time; time.sleep(60)"], "", {})), \
                patch.object(issue_review, "_cwd_pids", return_value=[]), \
                patch.object(review_budget, "timeout", return_value=1), \
                patch.object(api.atomic_work.checkout_lock, "pgid_alive", return_value=True), \
                self.assertRaises(api.atomic_work.checkout_lock.WorkerOrphaned) as failure:
            self.run_behavior()
        self.assertIsInstance(failure.exception.__context__, subprocess.TimeoutExpired)
        call, = api.logs()
        self.assertEqual(call["artifact"]["phase"], "resources_unknown")
        self.assertTrue(any(error["cause"] == "resources_unknown" for error in call["resource_ownership"]["errors"]))
        self.assertIsNone(call["resources_settled_at"])
        self.assertFalse(resource_ownership.released(call["resource_ownership"]))
        self.assertEqual((call["status"], call["error_code"], call["action"], call["outcome"]),
                         ("failed", "atomic_work_failed", None, None))
        self.assertEqual(call["diagnostic"]["outcome"], "timed_out")
        self.assertEqual(modes, ["prepare"])
        self.assertTrue(Path(call["artifact"]["resource_root"]).is_dir())
        with api.db() as conn:
            self.assertIsNone(conn.execute("select action_plan from calls where id=?", (call["id"],)).fetchone()[0])

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
                        self.assertEqual(call["diagnostic"]["phase"], "preparing_checkout")
                        self.assertEqual(call["diagnostic"]["outcome"], "timed_out")
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
        earlier_answer = f"Verified the outdated finding against the repair and its regression.\n\n<!-- poise-reply {CALL} 18 -->"
        threads = [
            {"root_comment_id": 17, "is_resolved": False, "is_outdated": False, "bodies": ["private current finding"]},
            {"root_comment_id": 18, "is_resolved": False, "is_outdated": True, "bodies": ["private outdated finding", earlier_answer]},
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
                    self.assertEqual(args[args.index("--title") + 1], "fix: repair seed")
                    self.assertEqual(args[args.index("--body") + 1], "Concrete repair and checks.")
                    return {"outcome": "validated" if mode == "validate" else "published", "head_sha": HEAD}

                replies = [{"commentId": root, "body": earlier_answer if root == 18 else "Verified the finding against the repair and its regression."}
                           for root in reply_ids]

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
                self.assertIn("retain the required title/body fields", instruction)
                self.assertIn("Existing PR metadata is preserved", instruction)
                self.assertIn("required unresolved root comment IDs: [17, 18]", instruction)
                self.assertIn("outdated", instruction)
                self.assertIn("already have replies", instruction)
                self.assertIn("verbatim", instruction)
                self.assertIn("original", instruction)
                self.assertIn("changed reviewer input", instruction)
                self.assertIn(earlier_answer, json.loads(instruction.split("Actual PR evidence:\n", 1)[1])["review_packet"]["review_threads"][1]["bodies"])
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
                    self.assertEqual(json.loads(plan)["publication"]["replies"], replies)

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

    def test_atomic_work_blocked_masks_env_value_before_pattern_redaction(self):
        credential = '{"token":"ghp_abc123","password":"opaque-secret"}'
        reason = f"blocked by check; SERVICE_CREDENTIALS={credential}"
        with patch.dict(os.environ, {"SERVICE_CREDENTIALS": credential}, clear=True):
            blocked = api.atomic_work.AtomicWorkBlocked(reason)
        message = str(blocked)
        self.assertIn("[redacted]", message)
        self.assertEqual(blocked.diagnostic["message"], message)
        for private in (credential, "ghp_abc123", "opaque-secret"):
            self.assertNotIn(private, message)
            self.assertNotIn(private, json.dumps(blocked.diagnostic))

    def test_atomic_work_blocked_short_env_value_keeps_header_redaction(self):
        with patch.dict(os.environ, {"TEST_KEY": "a"}, clear=True):
            blocked = api.atomic_work.AtomicWorkBlocked("Authorization: Bearer my-secret")
        message = str(blocked)
        self.assertEqual(message, "atomic behavior blocked: [redacted header]")
        self.assertEqual(blocked.diagnostic["message"], message)
        for private in ("my-secret", "Authoriz[redacted]", "Be[redacted]"):
            self.assertNotIn(private, message)
            self.assertNotIn(private, json.dumps(blocked.diagnostic))
        with patch.dict(os.environ, {"TEST_KEY": "a"}, clear=True):
            bare = api.atomic_work.AtomicWorkBlocked("fatal: a")
        self.assertEqual(str(bare), "atomic behavior blocked: fatal: [redacted]")

    def test_atomic_work_blocked_short_env_values_masked_after_pattern_redaction(self):
        with patch.dict(os.environ, {"TEST_KEY": "opaque-secret"}, clear=True):
            blocked = api.atomic_work.AtomicWorkBlocked("prefixopaque-secretsuffix and token my-secret")
        message = str(blocked)
        self.assertIn("[redacted]", message)
        self.assertEqual(blocked.diagnostic["message"], message)
        for private in ("opaque-secret", "prefixopaque-secretsuffix", "my-secret"):
            self.assertNotIn(private, message)
            self.assertNotIn(private, json.dumps(blocked.diagnostic))
        with patch.dict(os.environ, {"TEST_KEY": "token"}, clear=True):
            masked = api.atomic_work.AtomicWorkBlocked("token my-secret")
        self.assertEqual(str(masked), "atomic behavior blocked: [redacted credential]")
        self.assertEqual(masked.diagnostic["message"], str(masked))
        self.assertNotIn("my-secret", str(masked))
        self.assertNotIn("my-secret", json.dumps(masked.diagnostic))

    def test_atomic_work_blocked_overlapping_env_and_pattern_values_stay_masked(self):
        with patch.dict(os.environ, {"TEST_KEY": "Authorization: Bearer"}, clear=True):
            blocked = api.atomic_work.AtomicWorkBlocked("Authorization: Bearer my-secret")
        message = str(blocked)
        self.assertEqual(message, "atomic behavior blocked: [redacted header]")
        self.assertEqual(blocked.diagnostic["message"], message)
        for private in ("Authorization: Bearer", "my-secret"):
            self.assertNotIn(private, message)
            self.assertNotIn(private, json.dumps(blocked.diagnostic))
        credential = "ghp_a:opaque-secret"
        with patch.dict(os.environ, {"SERVICE_CREDENTIALS": credential}, clear=True):
            fragmented = api.atomic_work.AtomicWorkBlocked(f"blocked {credential} end")
        masked = str(fragmented)
        self.assertEqual(masked, "atomic behavior blocked: blocked [redacted] end")
        self.assertEqual(fragmented.diagnostic["message"], masked)
        for private in (credential, "ghp_a", "opaque-secret"):
            self.assertNotIn(private, masked)
            self.assertNotIn(private, json.dumps(fragmented.diagnostic))

    def test_atomic_work_blocked_prefix_value_keeps_header_redaction(self):
        value = "prefix Authorization: Bearer"
        with patch.dict(os.environ, {"TEST_KEY": value}, clear=True):
            blocked = api.atomic_work.AtomicWorkBlocked("prefix Authorization: Bearer my-secret")
        message = str(blocked)
        self.assertEqual(message, "atomic behavior blocked: prefix [redacted header]")
        self.assertEqual(blocked.diagnostic["message"], message)
        for private in (value, "my-secret"):
            self.assertNotIn(private, message)
            self.assertNotIn(private, json.dumps(blocked.diagnostic))

    def test_atomic_work_blocked_env_values_match_across_whitespace_normalization(self):
        cases = [
            ("line1\nline2", "reason line1 line2 end"),
            ("line1\tline2", "reason line1 line2 end"),
            ("a  b", "reason a b end"),
            ("  secret  ", "reason secret end"),
            ("secret\n", "reason secret end"),
        ]
        for value, reason in cases:
            with self.subTest(value=value):
                with patch.dict(os.environ, {"TEST_KEY": value}, clear=True):
                    blocked = api.atomic_work.AtomicWorkBlocked(reason)
                message = str(blocked)
                self.assertEqual(blocked.diagnostic["message"], message)
                self.assertIn("[redacted]", message)
                for private in ("line1", "line2", "a b", "secret"):
                    if private in " ".join(value.split()) or private in value:
                        self.assertNotIn(private, message)
                        self.assertNotIn(private, json.dumps(blocked.diagnostic))

    def test_atomic_work_blocked_keyword_ending_and_whitespace_variant_values_stay_masked(self):
        with patch.dict(os.environ, {"TEST_KEY": "ghp_a Bearer"}, clear=True):
            blocked = api.atomic_work.AtomicWorkBlocked("ghp_a Bearer my-secret")
        message = str(blocked)
        self.assertEqual(message, "atomic behavior blocked: [redacted] [redacted credential]")
        self.assertEqual(blocked.diagnostic["message"], message)
        for private in ("ghp_a Bearer", "ghp_a", "my-secret"):
            self.assertNotIn(private, message)
            self.assertNotIn(private, json.dumps(blocked.diagnostic))
        credential = "ghp_a:\nopaque-secret"
        with patch.dict(os.environ, {"SERVICE_CREDENTIALS": credential}, clear=True):
            fragmented = api.atomic_work.AtomicWorkBlocked("blocked ghp_a: opaque-secret end")
        masked = str(fragmented)
        self.assertEqual(masked, "atomic behavior blocked: blocked [redacted] end")
        self.assertEqual(fragmented.diagnostic["message"], masked)
        for private in (credential, "ghp_a: opaque-secret", "ghp_a", "opaque-secret"):
            self.assertNotIn(private, masked)
            self.assertNotIn(private, json.dumps(fragmented.diagnostic))

    def test_atomic_work_blocked_credential_shaped_env_value_masks_whole_before_patterns(self):
        credential = '{"auth":"Bearer abc","password":"opaque-secret"}'
        with patch.dict(os.environ, {"SERVICE_CREDENTIALS": credential}, clear=True):
            blocked = api.atomic_work.AtomicWorkBlocked(f"blocked {credential} end")
        message = str(blocked)
        self.assertEqual(message, "atomic behavior blocked: blocked [redacted] end")
        self.assertEqual(blocked.diagnostic["message"], message)
        for private in (credential, "Bearer abc", "opaque-secret"):
            self.assertNotIn(private, message)
            self.assertNotIn(private, json.dumps(blocked.diagnostic))

    def test_atomic_work_blocked_trailing_keyword_value_masks_secret_prefix(self):
        value = "opaque-prefix-12 Bearer"
        with patch.dict(os.environ, {"TEST_KEY": value}, clear=True):
            blocked = api.atomic_work.AtomicWorkBlocked("blocked opaque-prefix-12 Bearer [REDACTED] end")
        message = str(blocked)
        self.assertEqual(message, "atomic behavior blocked: blocked [redacted] [redacted credential] end")
        self.assertEqual(blocked.diagnostic["message"], message)
        for private in (value, "opaque-prefix-12"):
            self.assertNotIn(private, message)
            self.assertNotIn(private, json.dumps(blocked.diagnostic))

    def test_atomic_work_blocked_keyword_wrapped_value_survives_credential_repairing(self):
        value = "Bearer opaque-core-99 Bearer"
        with patch.dict(os.environ, {"TEST_KEY": value}, clear=True):
            blocked = api.atomic_work.AtomicWorkBlocked(f"{value} {value}")
        message = str(blocked)
        self.assertEqual(message, "atomic behavior blocked: [redacted credential] [redacted credential] [redacted] Bearer")
        self.assertEqual(blocked.diagnostic["message"], message)
        for private in (value, "opaque-core-99"):
            self.assertNotIn(private, message)
            self.assertNotIn(private, json.dumps(blocked.diagnostic))

    def test_atomic_work_blocked_header_shaped_value_masks_leading_secret(self):
        cases = [
            ("opaque-prefix-12 Authorization: Bearer ok",
             "atomic behavior blocked: seen [redacted] [redacted header]"),
            ("opaque-prefix-12 ghp_a opaque-middle-34 Authorization: Bearer ok",
             "atomic behavior blocked: seen [redacted] [redacted] [redacted] [redacted header]"),
        ]
        for value, expected in cases:
            with self.subTest(value=value):
                with patch.dict(os.environ, {"SERVICE_CREDENTIALS": value}, clear=True):
                    blocked = api.atomic_work.AtomicWorkBlocked(f"seen {value}")
                message = str(blocked)
                self.assertEqual(message, expected)
                self.assertEqual(blocked.diagnostic["message"], message)
                for private in (value, "opaque-prefix-12", "ghp_a", "opaque-middle-34"):
                    self.assertNotIn(private, message)
                    self.assertNotIn(private, json.dumps(blocked.diagnostic))

    def test_atomic_work_blocked_leading_marker_value_masks_remainder(self):
        value = "[redacted] opaque-core-99"
        with patch.dict(os.environ, {"TEST_KEY": value}, clear=True):
            blocked = api.atomic_work.AtomicWorkBlocked("saw [redacted] opaque-core-99 here")
        message = str(blocked)
        self.assertEqual(message, "atomic behavior blocked: saw [redacted] [redacted] here")
        self.assertEqual(blocked.diagnostic["message"], message)
        for private in (value, "opaque-core-99"):
            self.assertNotIn(private, message)
            self.assertNotIn(private, json.dumps(blocked.diagnostic))

    def test_work_blocker_and_provider_failures_keep_receipts_without_attempting_publication(self):
        reason = "Review requires a product decision before implementation can continue"
        secret = "opaque-environment-credential-crossing-cutoff"
        shaped = "ghp_" + "s" * 40
        prefix = "atomic behavior blocked: "
        long_reason = "Decision needed " + "x" * 474 + secret + " tail" * 200
        self.assertLess(long_reason.index(secret), 500)
        self.assertGreater(long_reason.index(secret) + len(secret), 500)
        cases = [(pull, blocked, message, None) for pull, blocked, message in [
            (None, reason, prefix + reason),
            (3, reason, prefix + reason),
            (3, {"cause": "ci_only", "reason": reason}, prefix + reason),
            (None, f"{reason}; {shaped}; {secret}\nAuthorization: Bearer header-secret",
             prefix + reason + "; [redacted]; [redacted] [redacted header]"),
            (None, long_reason, prefix + ("Decision needed " + "x" * 474 + "[redacted]") + "…"),
            (None, {"private": "unsupported reason"}, "AtomicWorkBlocked"),
            (None, "", "AtomicWorkBlocked"),
            (None, " \n\t", "AtomicWorkBlocked"),
            (None, False, "AtomicWorkBlocked"),
        ]]
        stdout = "private provider output stdout-canary-1844"
        stderr = "private provider stderr stderr-canary-1844"
        exit_message = "Atomic behavior provider failed with exit 1; provider cause unavailable; no publication attempted"
        failures = [
            (SimpleNamespace(returncode=1, stdout=stdout, stderr=stderr), exit_message),
            # The gate can encode a child signal as 128 + signal. Do not infer
            # a signal from that observed status; the negative result is separate.
            (SimpleNamespace(returncode=137, stdout=stdout, stderr=stderr),
             "Atomic behavior provider failed with exit 137; provider cause unavailable; no publication attempted"),
            (SimpleNamespace(returncode=-9, stdout=stdout, stderr=stderr),
             "Atomic behavior provider failed with signal 9; provider cause unavailable; no publication attempted"),
            (SimpleNamespace(returncode=0, stdout=stdout + "\n" + json.dumps({
                "type": "turn.failed", "error": {"message": "private terminal stdout-canary-1844"}}), stderr=stderr),
             "Atomic behavior provider reported a failed terminal with exit 0; provider cause unavailable; no publication attempted"),
            (SimpleNamespace(returncode=1, stdout=stdout, stderr="Status 429 " + stderr), "status 429: " + exit_message),
            (SimpleNamespace(returncode=1, stdout=stdout, stderr="balance exhausted " + stderr), "balance exhausted: " + exit_message),
            (SimpleNamespace(returncode=1, stdout=stdout, stderr="GitHub 429 " + stderr), exit_message),
            (RuntimeError(stdout + stderr),
             "atomic behavior failed during waiting_provider: RuntimeError (agent_interface.atomic_work.run)"),
        ]
        cases.extend((pull, None, message, result) for pull in (None, 3) for result, message in failures)
        original_track = api.track

        def track(*args, **kwargs):
            # Stand in for the kernel boundary with the existing v1 resource
            # path; native Progress/finish/main retention still runs normally.
            with patch.object(api, "_native_cli", False):
                return original_track(*args, **kwargs)

        repo = Path(__file__).resolve().parents[3]
        output = repo / "test-results"
        output.mkdir(exist_ok=True)
        with TemporaryDirectory(prefix="atomic-blocker-contract-", dir=output) as work:
            root = Path(work)
            env = {"PATH": os.environ["PATH"], "HOME": str(self.path.parent), "TMPDIR": work}
            build = subprocess.run([str(repo / "node_modules/esbuild/bin/esbuild"),
                                    str(repo / "tests/fixtures/behavior-fence-contract.ts"), "--bundle", "--platform=node",
                                    "--packages=external", "--format=esm", "--target=node22", f"--outfile={root / 'contract.mjs'}"],
                                   cwd=repo, env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(build.returncode, 0, build.stderr)
            diagnostic_cursor = 0
            for index, (pull, blocked, message, provider_result) in enumerate(cases):
                with self.subTest(pull=pull, case=index):
                    modes = []
                    correlation = f"explicit-blocker-{index}"

                    def interface(*args, **_kwargs):
                        if args[0] != "--issue-work":
                            return {"review_threads": []}
                        modes.append(args[args.index("--mode") + 1])
                        return {"outcome": "prepared", "checkout_head": HEAD}

                    def worker(_lease, _args, **kwargs):
                        (Path(kwargs["cwd"]).parent / "publication.json").write_text(json.dumps({"blocked": blocked}))
                        if isinstance(provider_result, Exception):
                            raise provider_result
                        return provider_result or SimpleNamespace(returncode=0, stdout=stdout, stderr=stderr)

                    expected = (RuntimeError if isinstance(provider_result, Exception) else issue_review.ProviderFailure) \
                        if blocked is None else api.atomic_work.AtomicWorkBlocked
                    captured_stdout, captured_stderr = StringIO(), StringIO()
                    with patch.object(issue_review, "packet", return_value={"issue": {"state": "open"}}), \
                            patch.object(issue_review, "interface", side_effect=interface), \
                            patch.object(issue_review, "command", return_value=(["fixture", "private prompt"], "", {})), \
                            patch.object(issue_review, "stop_leftovers"), patch.object(issue_review, "_cwd_pids", return_value=[]), \
                            patch.object(api.atomic_work.checkout_lock, "Lease", return_value=MagicMock()), \
                            patch.object(api.atomic_work.checkout_lock, "run_gated", side_effect=worker), \
                            patch.object(api, "track", side_effect=track), \
                            patch.dict(os.environ, {"TEST_API_KEY": secret}, clear=True), \
                            patch.object(sys, "argv", ["agent-interface", "--atomic-work", "example/repo#7", "--source",
                                                      "poise:behavior-chain", "--correlation-id", correlation]), \
                            patch.object(api, "_main", side_effect=lambda: self.run_behavior(pull, HEAD if pull else None, correlation)), \
                            redirect_stdout(captured_stdout), redirect_stderr(captured_stderr), \
                            self.assertRaises(expected) as caught:
                        api.main()
                    call, = [row for row in api.logs() if row["correlation_id"] == correlation]
                    self.assertEqual(modes, ["prepare"])
                    self.assertEqual((call["status"], call["action"], call["outcome"]), ("failed", "not_started", "preflight_failed"))
                    self.assertEqual(call["error_code"], "atomic_work_failed" if blocked is None else "atomic_work_blocked")
                    self.assertEqual(call["error"], message)
                    self.assertEqual(call["diagnostic"]["message"], message)
                    self.assertIsNone(call["head_sha"])
                    self.assertIsNotNone(call["resources_settled_at"])
                    with api.db() as conn:
                        self.assertIsNone(conn.execute("select action_plan from calls where id=?", (call["id"],)).fetchone()[0])
                    if blocked is not None:
                        self.assertEqual(str(caught.exception), message)
                        self.assertEqual(call["diagnostic"]["submission"], "none")
                        self.assertLessEqual(len(message), len(prefix) + 501)
                    elif not isinstance(provider_result, Exception):
                        self.assertEqual(call["diagnostic"]["operation"], "provider.atomic_work")
                        self.assertEqual(call["diagnostic"]["phase"], "provider_execution")
                        self.assertEqual(call["diagnostic"]["executable"], "codex")
                        self.assertEqual(call["diagnostic"]["outcome"], "signal" if provider_result.returncode < 0 else "exit")
                        self.assertEqual(call["diagnostic"]["exit_code"], provider_result.returncode if provider_result.returncode >= 0 else None)
                        self.assertEqual(call["diagnostic"]["signal"], -provider_result.returncode if provider_result.returncode < 0 else None)
                        self.assertEqual(call["diagnostic"]["submission"], "none")
                        self.assertEqual(call["diagnostic"]["stderr"], "")
                        self.assertFalse(call["diagnostic"]["stderr_truncated"])
                    else:
                        self.assertEqual(call["diagnostic"]["outcome"], "exception")
                    for private in (secret, "opaque-environment-", shaped, "header-secret", "private provider", "private prompt", "unsupported reason",
                                    "private terminal", "stdout-canary-1844", "stderr-canary-1844"):
                        self.assertNotIn(private, json.dumps(call))
                        self.assertNotIn(private, captured_stdout.getvalue() + captured_stderr.getvalue())
                    page = api.diagnostics(after=diagnostic_cursor, limit=10)
                    diagnostic_cursor = page["cursor"]
                    diagnostic, = [event for event in page["events"] if event["id"] == call["id"]]
                    self.assertEqual((diagnostic["error"], diagnostic["diagnostic"]["message"]), (message, message))
                    wire = root / "call.json"
                    wire.write_text(json.dumps([call]))
                    mode = "atomic-work-blocked" if blocked is not None else "atomic-work-failed"
                    consumed = subprocess.run(["node", str(root / "contract.mjs"), str(wire), mode],
                                              cwd=repo, env=env, capture_output=True, text=True, timeout=30)
                    self.assertEqual(consumed.returncode, 0, consumed.stderr)

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

    def test_pre_pr_shared_test_block_retains_only_independently_verified_original_base_evidence(self):
        dependency = {"base": HEAD, "run": 41, "baselineRun": 42,
                      "remediation": "https://github.com/example/repo/issues/1530"}
        proof = {**dependency, "verified": True, "runAttempt": 1, "baselineAttempt": 1,
                 "failures": [{"file": "tests/test-relay.test.ts", "test": "warning array", "cause": "expected []"}]}
        for index, mode in enumerate(("verified", "unverified", "wrong base", "unavailable")):
            verified = mode == "verified"
            with self.subTest(mode=mode):
                commands = []

                def interface(*args, **_kwargs):
                    commands.append(args[0])
                    if args[0] == "--issue-work":
                        self.assertEqual(args[args.index("--mode") + 1], "prepare")
                        return {"outcome": "prepared", "checkout_head": HEAD}
                    self.assertEqual(args[0], "--chain-seed")
                    self.assertEqual(json.loads(args[args.index("--test-dependency-json") + 1]), dependency)
                    if mode == "unavailable":
                        raise RuntimeError("original CI artifacts could not be read")
                    return {"test_dependency": {**proof, "verified": verified}}

                def worker(_lease, _args, **kwargs):
                    (Path(kwargs["cwd"]).parent / "publication.json").write_text(json.dumps({
                        "blocked": "Original test failed on the implementation base",
                        "testDependency": {**dependency, "base": "c" * 40} if mode == "wrong base" else dependency}))
                    return SimpleNamespace(returncode=0, stdout="", stderr="")

                with patch.object(issue_review, "packet", return_value={"issue": {"state": "open"}}), \
                        patch.object(issue_review, "interface", side_effect=interface), \
                        patch.object(issue_review, "command", return_value=(["fixture"], "", {})), \
                        patch.object(issue_review, "_terminal_failure", return_value=None), \
                        patch.object(issue_review, "stop_leftovers"), patch.object(issue_review, "_cwd_pids", return_value=[]), \
                        patch.object(api.atomic_work.checkout_lock, "Lease", return_value=MagicMock()), \
                        patch.object(api.atomic_work.checkout_lock, "run_gated", side_effect=worker), \
                        self.assertRaisesRegex(ValueError, "Original test failed"):
                    self.run_behavior(correlation_id=f"00000000-0000-4000-8000-00000000000{index + 2}")
                with sqlite3.connect(self.path) as conn:
                    status, code, action, artifact, plan = conn.execute(
                        "select status,error_code,action,artifact,action_plan from calls order by rowid desc limit 1").fetchone()
                self.assertEqual(commands, ["--issue-work"] if mode == "wrong base" else ["--issue-work", "--chain-seed"])
                self.assertEqual((status, code, action), ("failed", "atomic_work_blocked", "not_started"))
                self.assertEqual(json.loads(artifact).get("test_dependency"), proof if verified else None)
                self.assertIsNone(plan)

    def test_queue_ci_blocker_requires_the_original_integration_workflow_and_failed_attempt(self):
        integration, base = "d" * 40, "c" * 40
        ci = {"action": "list_failing_ci", "repository": "example/repo", "pull_number": 3, "head_sha": HEAD, "failing": []}
        queue = {"head_sha": HEAD, "queue_removals": [{"id": "removed", "reason": "failed_checks", "beforeCommit": {"oid": integration}}]}
        for mode in ("verified", "refailed", "rerun-succeeded", "rerun-running", "rerun-running-first", "wrong-head",
                     "wrong-ref", "wrong-parent", "unknown-run", "wrong-event", "missing-attempt", "pending", "missing-job",
                     "contradictory-success"):
            with self.subTest(mode=mode):
                check = {"type": "check_run", "name": "Caller", "state": "completed", "conclusion": "failure",
                         "check_run_id": 41, "log_id": 42, "run_id": 40, "head_sha": integration,
                         "url": "https://github.com/example/repo/actions/runs/40/job/42", "summary": "x" * 65536}
                run = {"id": 40, "workflow_id": 1, "run_attempt": 1, "event": "merge_group", "head_sha": integration}
                packet = {**ci, "ref": integration, "parents": [base, HEAD], "failing": [check], "runs": [run]}
                if mode == "refailed":
                    run.update(run_attempt=2, status="completed", conclusion="failure")
                if mode == "rerun-succeeded":
                    run.update(run_attempt=2, status="completed", conclusion="success")
                if mode == "rerun-running":
                    run.update(run_attempt=2, status="in_progress", conclusion=None)
                if mode == "rerun-running-first":
                    run.update(status="in_progress", conclusion=None)
                if mode == "contradictory-success":
                    run.update(status="completed", conclusion="success")
                if mode == "wrong-head":
                    packet["head_sha"] = base
                if mode == "wrong-ref":
                    packet["ref"] = base
                if mode == "wrong-parent":
                    packet["parents"] = [base, integration]
                if mode == "unknown-run":
                    packet["runs"] = []
                if mode == "wrong-event":
                    run["event"] = "pull_request"
                if mode == "missing-attempt":
                    del run["run_attempt"]
                if mode == "pending":
                    check["state"] = "in_progress"
                if mode == "missing-job":
                    check["log_id"] = None
                with patch.object(issue_review, "interface", return_value=packet) as read:
                    if mode.startswith("wrong-") and mode != "wrong-event":
                        with self.assertRaisesRegex(ValueError, "admitted candidate and base"):
                            api.atomic_work._ci_only_blocker(ci, queue, HEAD, "author")
                        continue
                    blocker = api.atomic_work._ci_only_blocker(ci, queue, HEAD, "author")
                read.assert_called_once_with("--list-failing-ci", "3", "--repository", "example/repo", "--token-user", "author", "--ref", integration)
                expected = {"verified": 1, "refailed": 2, "rerun-succeeded": 1, "rerun-running": 1, "rerun-running-first": 1}.get(mode)
                self.assertEqual("queue" in blocker, expected is not None)
                self.assertNotIn("summary", json.dumps(blocker))
                if expected is not None:
                    self.assertEqual(blocker["queue"], {"removal": "removed", "integration": integration, "base": base,
                        "failures": [{"name": "Caller", "check": 41, "job": 42, "run": 40, "workflow": 1, "attempt": expected,
                                      "url": check["url"]}]})

    def test_queue_ci_blocker_keeps_verified_failure_alongside_pending_rerun(self):
        integration, base = "d" * 40, "c" * 40
        ci = {"action": "list_failing_ci", "repository": "example/repo", "pull_number": 3, "head_sha": HEAD, "failing": []}
        queue = {"head_sha": HEAD, "queue_removals": [{"id": "removed", "reason": "failed_checks", "beforeCommit": {"oid": integration}}]}
        for mode in ("same-run", "new-run", "rerun-first", "distinct-workflow", "distinct-name", "malformed-pending"):
            with self.subTest(mode=mode):
                check = {"type": "check_run", "name": "Caller", "state": "completed", "conclusion": "failure",
                         "check_run_id": 41, "log_id": 42, "run_id": 40, "head_sha": integration,
                         "url": "https://github.com/example/repo/actions/runs/40/job/42"}
                run = {"id": 40, "workflow_id": 1, "run_attempt": 1, "event": "merge_group", "head_sha": integration}
                rerun = {"id": 41, "workflow_id": 1, "run_attempt": 1, "event": "merge_group",
                         "head_sha": integration, "status": "in_progress", "conclusion": None}
                pending = {"type": "check_run", "name": "Caller", "state": "in_progress", "conclusion": None,
                           "check_run_id": 43, "log_id": 44, "run_id": 41, "head_sha": integration,
                           "url": "https://github.com/example/repo/actions/runs/41/job/44"}
                if mode == "same-run":
                    run.update(run_attempt=2, status="in_progress", conclusion=None)
                    pending.update(run_id=40, url="https://github.com/example/repo/actions/runs/40/job/44")
                    packet = {**ci, "ref": integration, "parents": [base, HEAD], "failing": [check, pending], "runs": [run]}
                else:
                    if mode == "distinct-workflow":
                        rerun["workflow_id"] = 2
                    if mode == "distinct-name":
                        pending["name"] = "Other"
                    if mode == "malformed-pending":
                        pending["log_id"] = None
                    failing = [pending, check] if mode == "rerun-first" else [check, pending]
                    packet = {**ci, "ref": integration, "parents": [base, HEAD], "failing": failing, "runs": [run, rerun]}
                with patch.object(issue_review, "interface", return_value=packet):
                    blocker = api.atomic_work._ci_only_blocker(ci, queue, HEAD, "author")
                retained = mode in {"same-run", "new-run", "rerun-first"}
                self.assertEqual("queue" in blocker, retained)
                if retained:
                    self.assertEqual(blocker["queue"]["failures"],
                                     [{"name": "Caller", "check": 41, "job": 42, "run": 40, "workflow": 1,
                                       "attempt": 1, "url": check["url"]}])

    def test_failed_queue_blocker_keeps_integration_failures_when_baseline_proof_is_rejected_or_partial(self):
        integration, base = "d" * 40, "c" * 40
        ci = {"action": "list_failing_ci", "repository": "example/repo", "pull_number": 3, "head_sha": HEAD, "failing": []}
        queue = {"head_sha": HEAD, "queue_removals": [{"id": "removed", "reason": "failed_checks", "beforeCommit": {"oid": integration}}]}
        check = {"type": "check_run", "name": "Caller", "state": "completed", "conclusion": "failure",
                 "check_run_id": 41, "log_id": 42, "run_id": 40, "head_sha": integration,
                 "url": "https://github.com/example/repo/actions/runs/40/job/42"}
        run = {"id": 40, "workflow_id": 1, "run_attempt": 1, "event": "merge_group", "head_sha": integration}
        packet = {**ci, "ref": integration, "parents": [base, HEAD], "failing": [check], "runs": [run]}
        for index, mode in enumerate(("rejected", "partial", "shared")):
            with self.subTest(mode=mode):
                shared = mode == "shared"
                modes = []
                rejection = "CI dependency cause is absent from its actual job logs"
                dependency = {"head": HEAD, "removal": "removed", "integration": integration, "base": base,
                              "remediation": "https://github.com/example/repo/issues/99", "allShared": shared,
                              "failures": [{"check": 41, "name": "Caller", "run": 40, "workflow": 1,
                                            "evidence": "AssertionError: original fixture did not complete"}]}

                def interface(*args, **_kwargs):
                    if args[0] == "--issue-work":
                        modes.append(args[args.index("--mode") + 1])
                        return {"outcome": "prepared", "checkout_head": HEAD}
                    if args[0] == "--list-failing-ci":
                        return packet if "--ref" in args else ci
                    return {"--pr-review": {"review_threads": []}, "--pull-action-state": queue}[args[0]]

                def worker(_lease, _args, **kwargs):
                    (Path(kwargs["cwd"]).parent / "publication.json").write_text(json.dumps({
                        "blocked": {"cause": "ci_only", "reason": "The merge-group Caller job failed"},
                        "ciDependency": {"head": HEAD}}))
                    return SimpleNamespace(returncode=0, stdout="", stderr="")

                with patch.object(issue_review, "packet", return_value={"issue": {"state": "open"}}), \
                        patch.object(issue_review, "interface", side_effect=interface), \
                        patch.object(issue_review, "command", return_value=(["fixture"], "", {})) as command, \
                        patch.object(issue_review, "_terminal_failure", return_value=None), \
                        patch.object(issue_review, "stop_leftovers"), patch.object(issue_review, "_cwd_pids", return_value=[]), \
                        patch.object(api.atomic_work.checkout_lock, "Lease", return_value=MagicMock()), \
                        patch.object(api.atomic_work.checkout_lock, "run_gated", side_effect=worker), \
                        patch.object(api.atomic_work, "_verify_ci_dependency", return_value=dependency,
                                     side_effect=api.atomic_work.AtomicWorkFailed(rejection) if mode == "rejected" else None), \
                        self.assertRaisesRegex(api.atomic_work.AtomicWorkBlocked, "The merge-group Caller job failed"):
                    self.run_behavior(pull=3, expected_head=HEAD,
                                      correlation_id=f"00000000-0000-4000-8000-0000000000{index + 2:02d}"[-36:])
                with sqlite3.connect(self.path) as conn:
                    status, code, action, error, artifact, plan = conn.execute(
                        "select status,error_code,action,error,artifact,action_plan from calls order by rowid desc limit 1").fetchone()
                self.assertEqual(modes, ["prepare"])
                self.assertEqual((status, code, action), ("failed", "atomic_work_blocked", "not_started"))
                self.assertIsNone(plan)
                self.assertIn("The merge-group Caller job failed", error)
                if mode == "rejected":
                    self.assertIn(rejection, error)
                instruction = command.call_args.args[1]
                self.assertIn("verified merge-group-only failure", instruction)
                self.assertIn("PR-head checks are green and optional baseline proof is unavailable", instruction)
                self.assertIn("missing original failure evidence", instruction)
                artifact = json.loads(artifact)
                blocker = artifact["ci_blocker"]
                self.assertEqual({key: blocker[key] for key in ci}, ci)
                self.assertEqual(blocker["queue"], {"removal": "removed", "integration": integration, "base": base,
                    "failures": [{"name": "Caller", "check": 41, "job": 42, "run": 40, "workflow": 1,
                                  "attempt": 1, "url": check["url"]}]})
                self.assertEqual("ci_dependency" in blocker, shared)
                if shared:
                    self.assertNotIn("evidence", json.dumps(blocker["ci_dependency"]))

    def test_relay_dependency_uses_original_caller_binding_and_retained_runner_receipts(self):
        for index, missing in enumerate((False, True)):
            dependency = {"source": "relay", "base": HEAD, "run": "1" * 32, "baselineRun": "2" * 32,
                          "remediation": "https://github.com/example/repo/issues/1530"}
            captured, verified = {}, {}

            def interface(*args, **_kwargs):
                if args[0] == "--issue-work":
                    return {"outcome": "prepared", "checkout_head": HEAD}
                actual = json.loads(args[args.index("--test-dependency-json") + 1])
                self.assertEqual(actual["capture"], captured)
                self.assertEqual(actual["relay"], {name: {"payload": name, "signature": "runner signature"}
                                                 for name in ("original", "baseline")})
                verified.update(actual, verified=True, runAttempt=1, baselineAttempt=1,
                                failures=[{"file": "tests/test-relay.test.ts", "test": "warning", "cause": "expected []"}])
                return {"test_dependency": verified}

            def worker(_lease, _args, **kwargs):
                captured.update(json.loads(kwargs["env"]["POISE_TEST_BINDING"]))
                for key, name in (("run", "original"), ("baselineRun", "baseline")):
                    if missing and name == "original":
                        continue
                    receipt = Path(kwargs["env"]["POISE_TEST_EVIDENCE_DIR"]) / f"{dependency[key]}.json"
                    receipt.write_text(json.dumps({"payload": name, "signature": "runner signature"}))
                (Path(kwargs["cwd"]).parent / "publication.json").write_text(json.dumps({
                    "blocked": "Original relay assertion failed", "testDependency": {**dependency,
                    "capture": {"call": "worker-selected"}, "relay": {"original": "worker text"}}}))
                return SimpleNamespace(returncode=0, stdout="", stderr="")

            def execute():
                # Exercise the CLI finalizer with the existing library scope;
                # native namespace admission has its own contract tests.
                with patch.object(api, "_native_cli", False):
                    self.run_behavior(correlation_id=f"00000000-0000-4000-8000-00000000001{index}")

            with patch.object(issue_review, "packet", return_value={"issue": {"state": "open"}}), \
                    patch.object(issue_review, "interface", side_effect=interface), \
                    patch.object(issue_review, "command", return_value=(["fixture"], "", {})), \
                    patch.object(issue_review, "_terminal_failure", return_value=None), \
                    patch.object(issue_review, "stop_leftovers"), patch.object(issue_review, "_cwd_pids", return_value=[]), \
                    patch.object(api.atomic_work.checkout_lock, "Lease", return_value=MagicMock()), \
                    patch.object(api.atomic_work.checkout_lock, "run_gated", side_effect=worker), \
                    patch.object(sys, "argv", ["agent-interface", "--atomic-work", "example/repo#7", "--source", "poise:behavior-chain"]), \
                    patch.object(api, "_main", side_effect=execute), \
                    self.assertRaisesRegex(ValueError, "Original relay assertion failed"):
                api.main()
            with sqlite3.connect(self.path) as conn:
                call, artifact, settled = conn.execute("select id,artifact,resources_settled_at from calls order by rowid desc limit 1").fetchone()
            artifact = json.loads(artifact)
            self.assertEqual(captured["call"], call)
            self.assertEqual(artifact["test_capture"], captured)
            self.assertEqual(artifact.get("test_dependency"), None if missing else verified)
            self.assertIsNotNone(settled)

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
