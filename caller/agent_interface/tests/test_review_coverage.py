"""Capacity omissions never acquire review clearance or since-head authority."""
import asyncio
import io
import json
import tempfile
from contextlib import ExitStack, nullcontext, redirect_stdout
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import AsyncMock, patch

import agent_interface as api
from agent_interface import atoms, pr_approve, pr_review, review_budget, review_receipt, review_repository, structured_review
from github_interface.atoms import review_diff
from github_interface.behaviors import approve_pr, request_changes, review_activity_since, reviewed_clean

HEAD = "a" * 40
NEXT = "b" * 40
BASE = "c" * 40
ASSESSMENT = {"verdict": "The retained source has no remaining blocking findings.",
              "reviewed_context": "Inspected every supplied source hunk in the retained prefix.",
              "limitations": "The bounded packet omits required source; tests were not run."}
FINDING = {"path": "a.py", "line": 2, "side": "RIGHT", "body": "[p1] Empty values crash the optional lookup."}


class TestReviewCoverage(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(api, "DB", Path(self.directory.name) / "calls.sqlite3"))
        self.stack.enter_context(patch.object(api, "RESPONSES", Path(self.directory.name) / "responses"))
        api.init_db()
        self.head = HEAD
        self.reviews = []
        self.packets = []
        self.client = AsyncMock()
        self.client.token = "fixture-token"
        self.client.get.return_value = {"merge_base_commit": {"sha": BASE}}
        self.client.post.side_effect = self.post
        self.stack.enter_context(patch.object(atoms, "packet", side_effect=self.packet))
        self.stack.enter_context(patch.object(api, "review_facts", side_effect=lambda *_args: self.activity()))
        self.stack.enter_context(patch.object(review_activity_since, "get_review_activity", side_effect=self.history))
        self.stack.enter_context(patch.object(review_repository, "prepare", return_value=nullcontext(
            SimpleNamespace(root=Path(self.directory.name), prompt=lambda: ""))))
        self.stack.enter_context(patch.object(structured_review, "ReviewWatch", return_value=nullcontext(None)))
        self.stack.enter_context(patch.object(structured_review.subprocess, "run", side_effect=self.command))
        for module in (approve_pr, request_changes, reviewed_clean):
            self.stack.enter_context(patch.object(module, "get_pull", side_effect=lambda *_args: self.pull()))
        self.stack.enter_context(patch.object(request_changes, "list_inline_comments", AsyncMock(return_value=[])))
        self.stack.enter_context(patch.object(request_changes, "list_review_threads", AsyncMock(return_value=[])))
        self.stack.enter_context(patch.object(approve_pr, "list_review_threads", AsyncMock(return_value=[])))

    def pull(self):
        return {"head": {"sha": self.head}, "base": {"sha": BASE}, "title": "Coverage regression", "body": "",
                "state": "open", "draft": False, "user": {"login": "author"}}

    async def history(self, *_args):
        return {"state": "OPEN", "isDraft": False, "headRefOid": self.head, "baseRefOid": BASE,
                "title": self.pull()["title"], "body": "", "updatedAt": "2026-09-17T10:00:00Z",
                "reviewRequests": [], "reviewThreads": [], "reviews": self.reviews}

    def activity(self):
        return asyncio.run(review_activity_since.read_request(
            self.client, "o", "r", 12, "reviewer", datetime(1970, 1, 1, tzinfo=timezone.utc)))

    async def post(self, _path, *, json, timeout):
        state = {"REQUEST_CHANGES": "CHANGES_REQUESTED", "APPROVE": "APPROVED", "COMMENT": "COMMENTED"}[json["event"]]
        stamp = datetime.now(timezone.utc).isoformat()
        number = len(self.reviews) + 91
        self.reviews.append({"id": f"PRR_{number}", "databaseId": number, "state": state, "body": json["body"],
                             "commit": {"oid": json["commit_id"]}, "author": {"login": "reviewer"},
                             "submittedAt": stamp, "updatedAt": stamp})
        return {"id": number, "state": state, "commit_id": json["commit_id"],
                "user": {"login": "reviewer"}, "submitted_at": stamp}

    def command(self, argv, **_kwargs):
        if argv[1] == "--review-activity-since":
            return SimpleNamespace(returncode=0, stdout=json.dumps(self.activity()), stderr="")
        module = {"--request-changes": request_changes, "--reviewed-clean": reviewed_clean, "--approve-pr": approve_pr}[argv[1]]
        payload = {"repository": "o/r", "pr": "12", "expected_head": self.head, "token_user": "reviewer",
                   "assessment": json.loads(argv[argv.index("--assessment-json") + 1])}
        if "--comments-json" in argv:
            payload["comments"] = json.loads(argv[argv.index("--comments-json") + 1])
        result = asyncio.run(module.run(self.client, payload))
        return SimpleNamespace(returncode=0, stdout=json.dumps(result), stderr="")

    def packet(self, _pwd, _pr, _actor, head, _p=None, since_head=None):
        lookup = "values[0]" if getattr(self, "retained_finding", False) else "values[0] if values else None"
        sources = {"a.py": f"def lookup(values):\n    return {lookup}", "z.py": "result = 1 / 0"}
        if head == NEXT:
            sources["b.py"] = "unrelated_change = True"
        if since_head == HEAD:
            sources = {"b.py": sources["b.py"]}
        diffs = {path: f"diff --git a/{path} b/{path}\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{len(code.splitlines())} @@\n"
                 + "".join(f"+{line}\n" for line in code.splitlines())
                 for path, code in sources.items()}
        raw = b"".join(f':000000 100644 {"0" * 40} {index + 1:040d} A\0{path}\0'.encode()
                       for index, path in enumerate(sources))

        def git(_cwd, _env, *args, limit):
            if "--raw" in args:
                return raw
            if "--find-renames" in args:
                result = "".join(diffs[arg.removeprefix(":(literal)")] for arg in args if arg.startswith(":(literal)")).encode()
                if len(result) > limit:
                    raise review_diff.ReviewPacketTooLarge("fixture diff budget")
                return result
            return b""

        context = {"repository": "o/r", "pull_number": 12, "head_sha": head, "pull": self.pull(), "p": "p2"}
        with patch.object(review_diff, "_git", side_effect=git), \
                patch.object(review_diff, "_blob_sizes", AsyncMock(return_value={})), \
                patch.object(review_diff, "MAX_DIFF_BYTES", max(len(diff.encode()) for diff in diffs.values()) + 1):
            packet = {**context, **asyncio.run(review_diff.review_diff(self.client, "o", "r", self.pull(), context, since=since_head))}
        self.packets.append(packet)
        return json.dumps(packet)

    def run_review(self, behavior, findings=(), **options):
        verdict = {"action": "request_changes" if findings else "reviewed_clean" if behavior == "pr_review" else "approve",
                   "comments": list(findings), "assessment": ASSESSMENT,
                   **({"requests": []} if behavior == "pr_review" else {})}
        with patch.dict(structured_review.ASK, {"codex": lambda *_args: json.dumps(verdict)}), redirect_stdout(io.StringIO()):
            api.run_governed_behavior(pr_review if behavior == "pr_review" else pr_approve, behavior,
                "https://github.com/o/r/pull/12", "reviewer", self.head, "poise:test", f"coverage-{behavior}-{self.head}",
                pwd=self.directory.name, model="gpt-6-astra-ultra", **options)

    def test_clean_prefix_cannot_clear_the_omitted_sole_defect(self):
        with self.assertRaises(SystemExit):
            self.run_review("pr_review")
        self.assertEqual(self.packets[0]["coverage"], "incomplete")
        self.assertNotIn("1 / 0", self.packets[0]["diff"])
        self.assertEqual(self.packets[0]["omitted_files"][0]["path"], "z.py")
        self.client.post.assert_not_awaited()
        self.assertEqual(api.logs()[0]["outcome"], "incomplete")
        self.head = NEXT
        with self.assertRaises(SystemExit):
            self.run_review("pr_approve")
        self.assertIsNone(self.packets[-1]["since_head_sha"])
        self.assertIn("z.py", [entry["path"] for entry in self.packets[-1]["omitted_files"]])
        self.client.post.assert_not_awaited()

    def test_partial_change_request_keeps_its_receipt_but_never_becomes_a_capped_approval_or_baseline(self):
        self.retained_finding = True
        self.run_review("pr_review", [FINDING])
        row = api.logs()[0]
        self.assertEqual((row["action"], row["outcome"], row["review_id"]), ("requested_changes", "incomplete", 91))
        self.assertEqual(self.activity()["reviewer_latest_commit"], HEAD)
        self.assertIsNone(self.activity()["reviewer_latest_complete_commit"])
        self.head = NEXT
        self.run_review("pr_approve", [FINDING], capped=True, review_round=5, review_cap=5)
        self.assertIsNone(self.packets[-1]["since_head_sha"])
        self.assertIn("z.py", [entry["path"] for entry in self.packets[-1]["omitted_files"]])
        self.assertEqual([review["state"] for review in self.reviews], ["CHANGES_REQUESTED", "CHANGES_REQUESTED"])

    def test_claude_terminal_commands_refuse_incomplete_or_unproven_coverage_before_post(self):
        for coverage in ("incomplete", None, {}, True, "complete"):
            for module in (reviewed_clean, approve_pr):
                with self.subTest(coverage=coverage, module=module.__name__):
                    call_id = api.track("fixture", "", "12", "o/r", "reviewer", "pr_approve")
                    review_receipt.bind(api.DB, call_id)
                    packet = {"repository": "o/r", "pull_number": 12, "head_sha": HEAD, "pull": self.pull(),
                              "files": [{"filename": "a.py"}], "coverage": coverage,
                              "omitted_files": [{"path": "z.py", "reason": "capacity"}]}
                    with review_receipt.invocation_environment(api.DB, call_id, True):
                        review_receipt.prepare_response(json.dumps(packet), "fixture")
                        review_receipt.complete_response(ASSESSMENT, HEAD)
                        with self.assertRaisesRegex(RuntimeError, "review_incomplete"):
                            asyncio.run(module.run(self.client, {"repository": "o/r", "pr": "12", "token_user": "reviewer",
                                "expected_head": HEAD, "assessment": ASSESSMENT}))
        self.client.post.assert_not_awaited()
