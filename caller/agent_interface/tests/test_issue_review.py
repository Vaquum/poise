import io
import json
import os
import subprocess
import sys
import tempfile
import time
from contextlib import redirect_stdout
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

import agent_interface
from agent_interface import issue_review, review_budget
from agent_interface.atoms import AgentPreflightError
from agent_interface.model_catalog import CATALOG, ModelCatalogError

REPO = "Vaquum/Origo"
ACTOR = "bit-mis"


def issue(number: int, **extra) -> dict:
    return {"number": number, "title": f"Issue {number}", "state": "open", "user": {"login": "mikkokotila"},
            "labels": [{"name": "prd"}], "html_url": f"https://github.com/{REPO}/issues/{number}",
            "created_at": "2026-09-24T06:15:10Z", "updated_at": "2026-09-24T06:28:06Z", "body": f"Body {number}", **extra}


class FakeGitHub:
    """github-interface as the run sees it: reads, a checkout, and comments."""

    def __init__(self, subs=None, unreadable=(), fail_comment_on=None, author="bit-mis", comments=None):
        self.subs = subs if subs is not None else [{"repository": REPO, "issue_number": 453, "via": ["work_slices"]}]
        self.unreadable, self.fail_comment_on, self.author = set(unreadable), fail_comment_on, author
        self.comments = comments or {}
        self.calls: list[tuple[str, ...]] = []
        self.issues = {452: issue(452), 453: issue(453), 454: issue(454, pull_request={"url": "x"})}

    def __call__(self, *args: str, seconds: float = 120) -> dict:
        self.calls.append(args)
        # Every call acts as the actor, never as whatever account is configured.
        assert args[args.index("--token-user") + 1] == ACTOR, args
        flag = args[0]
        if flag == "--read-issue":
            number = int(args[1].lstrip("#"))
            if number in self.unreadable:
                raise RuntimeError("GitHub 404: Not Found")
            return {"issue": self.issues[number]}
        if flag == "--issue-comments":
            number = int(args[1].lstrip("#"))
            return {"comments": self.comments.get(number, [{"id": 1, "author": "zero-bang", "body": "Why?", "url": "u"}])}
        if flag == "--sub-issues":
            return {"sub_issues": self.subs}
        if flag == "--checkout-repo":
            return {"action": "checkout_repo", "repository": args[1], "path": args[3], "branch": "main", "head_sha": "a" * 40}
        if flag == "--comment-issue":
            number = int(args[1].lstrip("#"))
            if number == self.fail_comment_on:
                raise RuntimeError("GitHub 502")
            return {"action": "commented_issue", "repository": args[3], "issue_number": number,
                    "comment": {"id": 9000 + number, "html_url": f"https://github.com/{args[3]}/issues/{number}#c",
                                "user": {"login": self.author}}}
        raise AssertionError(f"unexpected github-interface call {args}")


def agent_writes(review: dict | str | None, code: int = 0, stdout: str = ""):
    """A provider that does its work and leaves its review next to the checkout."""
    runs = []

    def supervise(args, *, input, cwd, timeout, env, provider):
        runs.append({"args": args, "input": input, "cwd": cwd, "provider": provider})
        if review is not None:
            (Path(cwd).parent / "review.json").write_text(review if isinstance(review, str) else json.dumps(review))
        return subprocess.CompletedProcess(args, code, stdout, "provider failed" if code else "")
    supervise.runs = runs
    return supervise


class IssueReviewCase(TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        data = Path(self.work.name)
        for target in (
            patch.object(agent_interface, "DATA_DIR", data),
            patch.object(agent_interface, "DB", data / "calls.sqlite3"),
            patch.object(agent_interface, "RESPONSES", data / "responses"),
            patch.object(issue_review, "WORK_ROOT", data / "runs"),
            patch.dict(os.environ, {"GITHUB_INTERFACE_AGENT_USER": ACTOR}),
        ):
            target.start()
            self.addCleanup(target.stop)
        agent_interface.init_db()

    def run_review(self, github, supervise, model="opus-5-max", recovery=None, expect_exit=False):
        with patch.object(issue_review, "interface", github), patch.object(issue_review, "supervise", supervise), \
                redirect_stdout(io.StringIO()) as output:
            if expect_exit:
                with self.assertRaises(SystemExit):
                    agent_interface.run_issue_review(f"{REPO}#452", "bit-mis", "poise:review-new-issues", "claim-1",
                                                     model, recovery, note="Remember the charts.")
            else:
                agent_interface.run_issue_review(f"{REPO}#452", "bit-mis", "poise:review-new-issues", "claim-1",
                                                 model, recovery, note="Remember the charts.")
        with agent_interface.db() as conn:
            row = conn.execute("select * from calls where correlation_id='claim-1'").fetchone()
        return row, json.loads(output.getvalue())

    def exported(self, row):
        return next(entry for entry in agent_interface.logs() if entry["id"] == row["id"])


class TestIssueReviewRun(IssueReviewCase):
    def test_reviews_with_full_access_and_posts_one_comment_per_issue_as_the_actor(self):
        github = FakeGitHub()
        supervise = agent_writes({"comments": [
            {"issue": "#452", "body": "The PRD skips the 72-hour clear window."},
            {"issue": "vaquum/origo#453", "body": "S453 has no failing test for zero gaps."},
            {"issue": f"{REPO}#452", "body": "Also: the fingerprint freeze is unverified."},
            {"issue": "Vaquum/Other#1", "body": "Out of scope."},
        ]})
        row, printed = self.run_review(github, supervise)

        self.assertEqual((row["status"], row["action"], row["outcome"]), ("completed", "commented", "commented"))
        self.assertEqual((row["behavior"], row["repo"], row["pr_id"], row["actor"]), ("issue_review", REPO, "452", "bit-mis"))
        self.assertEqual((row["source"], row["model"], row["expected_head"], row["head_sha"]), ("poise:review-new-issues", "opus-5-max", None, None))
        exported = self.exported(row)
        self.assertEqual([r["comment_id"] for r in exported["receipts"]], [9452, 9453])
        self.assertEqual(exported["progress"]["phase"], "completed")
        self.assertEqual(printed["receipts"], exported["receipts"])

        posted = [call for call in github.calls if call[0] == "--comment-issue"]
        self.assertEqual([call[1:6] for call in posted], [("#452", "--repository", REPO, "--token-user", ACTOR),
                                                           ("#453", "--repository", REPO, "--token-user", ACTOR)])
        self.assertEqual({call[0] for call in github.calls},
                         {"--read-issue", "--issue-comments", "--sub-issues", "--checkout-repo", "--comment-issue"})
        first = posted[0][6]
        self.assertTrue(first.startswith("--body=The PRD skips the 72-hour clear window.\n\nAlso: the fingerprint"))
        self.assertIn("`opus-5-max`", first)
        self.assertIn(f"call={row['id']}", first)

        run = supervise.runs[0]
        self.assertEqual(run["provider"], "claude")
        self.assertIn("Provide an adversarial, meticulous, and comprehensive review with comments on Vaquum/Origo#452 "
                      "and any issue directly linked to it.", run["input"])
        self.assertTrue(run["input"].startswith("Memories from the past:\nRemember the charts."))
        self.assertIn("sub-issues it makes part of itself: Vaquum/Origo#453", run["input"])
        self.assertIn("Do not post to GitHub yourself", run["input"])
        response = agent_interface.RESPONSES / f"{row['id']}.txt"
        self.assertIn("S453 has no failing test", response.read_text())
        self.assertIn("Vaquum/Other#1", response.read_text())
        self.assertFalse((issue_review.WORK_ROOT / row["id"]).exists())

    def test_a_run_that_fails_before_posting_records_no_receipts(self):
        row, printed = self.run_review(FakeGitHub(), agent_writes(None, code=1), expect_exit=True)
        self.assertEqual((row["status"], row["action"], row["outcome"]), ("failed", None, None))
        self.assertIsNone(self.exported(row)["receipts"])
        self.assertIn("provider failed", row["error"])
        self.assertFalse((issue_review.WORK_ROOT / row["id"]).exists())

    def test_an_unusable_review_fails_before_posting(self):
        for review in ("not json", {"comments": []}, {"comments": [{"issue": "#452", "body": " "}, {"issue": 7, "body": "x"}]}, {"verdict": "ok"}):
            with self.subTest(review=review):
                with agent_interface.db() as conn:
                    conn.execute("delete from calls")
                github = FakeGitHub()
                row, _ = self.run_review(github, agent_writes(review), expect_exit=True)
                self.assertEqual((row["status"], row["error_code"]), ("failed", "invalid_review_output"))
                self.assertIsNone(self.exported(row)["receipts"])
                self.assertFalse([call for call in github.calls if call[0] == "--comment-issue"])

    def test_a_run_that_fails_while_posting_keeps_the_receipts_it_has(self):
        supervise = agent_writes({"comments": [{"issue": "#452", "body": "One."}, {"issue": "#453", "body": "Two."}]})
        row, printed = self.run_review(FakeGitHub(fail_comment_on=453), supervise, expect_exit=True)
        self.assertEqual((row["status"], row["error_code"]), ("failed", "posting_failed"))
        self.assertEqual([r["comment_id"] for r in self.exported(row)["receipts"]], [9452])

    def test_one_issue_that_cannot_take_a_comment_does_not_cost_the_others_theirs(self):
        supervise = agent_writes({"comments": [{"issue": "#452", "body": "One."}, {"issue": "#453", "body": "Two."}]})
        github = FakeGitHub(fail_comment_on=452)
        row, _ = self.run_review(github, supervise, expect_exit=True)
        self.assertEqual((row["status"], row["error_code"]), ("failed", "posting_failed"))
        self.assertIn("posted 1 of 2", row["error"])
        self.assertEqual([r["comment_id"] for r in self.exported(row)["receipts"]], [9453])

    def refused(self, actor: str) -> tuple[dict, FakeGitHub]:
        github = FakeGitHub()
        with patch.object(issue_review, "interface", github), patch.object(issue_review, "supervise", agent_writes(None)), \
                redirect_stdout(io.StringIO()), self.assertRaises(SystemExit):
            agent_interface.run_issue_review(f"{REPO}#452", actor, "poise:review-new-issues", "claim-1", "opus-5-max")
        with agent_interface.db() as conn:
            row = conn.execute("select * from calls where correlation_id='claim-1'").fetchone()
        return row, github

    def test_an_actor_that_is_not_the_agent_account_is_refused_before_anything_runs(self):
        row, github = self.refused("someone-else")
        self.assertEqual((row["status"], row["action"], row["outcome"], row["error_code"]), ("failed", "not_started", "preflight_failed", "actor_mismatch"))
        self.assertIn(f"posted as the agent account {ACTOR}; --actor someone-else", row["error"])
        self.assertEqual(github.calls, [])

    def test_without_a_configured_agent_account_nothing_runs(self):
        with patch.dict(os.environ, {"GITHUB_INTERFACE_AGENT_USER": ""}):
            row, github = self.refused(ACTOR)
        self.assertEqual((row["status"], row["action"], row["outcome"], row["error_code"]),
                         ("failed", "not_started", "preflight_failed", "agent_account_missing"))
        self.assertIn("GITHUB_INTERFACE_AGENT_USER is not set", row["error"])
        self.assertEqual(github.calls, [])

    def test_the_agent_account_matches_whatever_its_case(self):
        supervise = agent_writes({"comments": [{"issue": "#452", "body": "One."}]})
        with patch.dict(os.environ, {"GITHUB_INTERFACE_AGENT_USER": ACTOR.upper()}):
            row, _ = self.run_review(FakeGitHub(), supervise)
        self.assertEqual(row["status"], "completed")

    def test_a_comment_posted_by_another_account_fails_the_run(self):
        supervise = agent_writes({"comments": [{"issue": "#452", "body": "One."}]})
        row, _ = self.run_review(FakeGitHub(author="mikkokotila"), supervise, expect_exit=True)
        self.assertEqual((row["status"], row["error_code"]), ("failed", "posting_failed"))
        self.assertEqual(self.exported(row)["receipts"][0]["author"], "mikkokotila")

    def test_an_unreadable_issue_is_a_preflight_failure(self):
        row, _ = self.run_review(FakeGitHub(unreadable={452}), agent_writes(None), expect_exit=True)
        self.assertEqual((row["status"], row["action"], row["outcome"]), ("failed", "not_started", "preflight_failed"))

    def test_a_claude_output_limit_recovers_once_with_the_recovery_model(self):
        attempts = []

        def review(model, repo, number, data, actor, note, work):
            attempts.append(model.identity)
            if len(attempts) == 1:
                raise review_budget.ReviewLimitError("Claude's response exceeded the 64000 output token maximum")
            return [{"issue": f"{REPO}#452", "body": "Recovered."}], []

        with patch.object(issue_review, "review", side_effect=review):
            row, printed = self.run_review(FakeGitHub(), agent_writes(None), recovery="gpt-6-astra-ultra")
        self.assertEqual(attempts, ["opus-5-max", "gpt-6-astra-ultra"])
        self.assertEqual((row["status"], row["recovery_model"]), ("completed", "gpt-6-astra-ultra"))
        self.assertEqual(printed["model"], "gpt-6-astra-ultra")

    def test_a_time_limit_is_held_rather_than_recovered(self):
        def review(*args):
            raise review_budget.ReviewLimitError("Issue review reached its time limit; needs attention", "review_budget_exhausted")

        with patch.object(issue_review, "review", side_effect=review):
            row, _ = self.run_review(FakeGitHub(), agent_writes(None), recovery="gpt-6-astra-ultra", expect_exit=True)
        self.assertEqual((row["status"], row["error_code"], row["recovery_model"]), ("failed", "review_budget_exhausted", None))


class TestPacket(IssueReviewCase):
    def test_sub_issues_bring_their_comments_and_pull_requests_are_dropped(self):
        github = FakeGitHub(subs=[
            {"repository": REPO, "issue_number": 453, "via": ["native", "work_slices"]},
            {"repository": REPO, "issue_number": 454, "via": ["work_slices"]},
            {"repository": REPO, "issue_number": 455, "via": ["work_slices"]},
        ], unreadable={455})
        with patch.object(issue_review, "interface", github):
            data = issue_review.packet(REPO, 452, ACTOR)
        self.assertEqual(data["issue"]["issue"], f"{REPO}#452")
        self.assertEqual(data["issue"]["comments"][0]["author"], "zero-bang")
        self.assertEqual([sub["issue"] for sub in data["sub_issues"]], [f"{REPO}#453", f"{REPO}#455"])
        self.assertIn("404", data["sub_issues"][1]["error"])
        self.assertEqual(issue_review.allowed(data), [f"{REPO}#452", f"{REPO}#453"])

    def test_a_pull_request_or_an_oversized_packet_is_refused(self):
        github = FakeGitHub()
        with patch.object(issue_review, "interface", github), self.assertRaises(AgentPreflightError):
            issue_review.packet(REPO, 454, ACTOR)
        github.issues[452]["body"] = "x" * (issue_review.MAX_PACKET_BYTES + 1)
        with patch.object(issue_review, "interface", github), self.assertRaises(AgentPreflightError) as raised:
            issue_review.packet(REPO, 452, ACTOR)
        self.assertEqual(raised.exception.code, "review_packet_too_large")


class TestSubIssuesReviewedOnce(IssueReviewCase):
    def review_comment(self, call_id: str, author: str = "bit-mis", text: str = "Looks thin.") -> dict:
        body = f"{text}\n\n---\n<sub>Issue review · `opus-5-max`</sub>\n<!-- agent-interface issue-review call={call_id} -->\n"
        return {"id": 7, "author": author, "body": body, "url": "u"}

    def earlier_review(self, call_id: str, number: int, running_since: float | None = None) -> None:
        with agent_interface.db() as conn:
            conn.execute("insert into calls (id, behavior, repo, pr_id, status, started_at, ended_at) values (?, 'issue_review', ?, ?, ?, ?, ?)",
                         (call_id, REPO, str(number), "running" if running_since else "completed",
                          running_since or time.time() - 600, None if running_since else time.time() - 300))

    def test_a_sub_issue_with_its_own_review_is_read_but_not_commented_on(self):
        numbers = (453, 455, 456, 457, 458, 459)
        subs = [{"repository": REPO, "issue_number": number, "via": ["work_slices"]} for number in numbers]
        quoted = f"As the earlier review said:\n> <!-- agent-interface issue-review call={'a' * 32} -->"
        github = FakeGitHub(subs=subs, comments={
            # Its own review, from before this PRD took it in.
            453: [self.review_comment("a" * 32)],
            # This PRD's earlier review, quoting another: a replay comments on it again.
            455: [self.review_comment("b" * 32, text=quoted)],
            # A review this machine has no record of.
            456: [self.review_comment("c" * 32)],
            # The marker in someone else's comment proves nothing.
            457: [self.review_comment("a" * 32, author="zero-bang")],
        })
        github.issues.update({number: issue(number) for number in numbers[1:]})
        self.earlier_review("a" * 32, 453)
        self.earlier_review("b" * 32, 452)
        # 458's own review is running now; 459's died long ago without finishing.
        self.earlier_review("d" * 32, 458, running_since=time.time() - 60)
        self.earlier_review("e" * 32, 459, running_since=time.time() - 3 * issue_review.TIMEOUT_SECONDS)
        with patch.object(issue_review, "interface", github):
            data = issue_review.packet(REPO, 452, ACTOR)
        issue_review.mark_reviewed(data, ACTOR, agent_interface._issue_review_targets, agent_interface._running_issue_reviews("f" * 32))
        self.assertEqual({sub["issue"]: sub.get("reviewed_by") for sub in data["sub_issues"]}, {
            f"{REPO}#453": f"{REPO}#453", f"{REPO}#455": None, f"{REPO}#456": "another issue", f"{REPO}#457": None,
            f"{REPO}#458": f"{REPO}#458", f"{REPO}#459": None,
        })
        self.assertEqual(issue_review.allowed(data), [f"{REPO}#452", f"{REPO}#455", f"{REPO}#457", f"{REPO}#459"])

    def test_the_review_leaves_such_a_sub_issue_to_its_own_review(self):
        github = FakeGitHub(comments={453: [self.review_comment("a" * 32)]})
        self.earlier_review("a" * 32, 453)
        supervise = agent_writes({"comments": [{"issue": "#452", "body": "One."}, {"issue": "#453", "body": "Again."}]})
        row, printed = self.run_review(github, supervise)

        posted = [call[1] for call in github.calls if call[0] == "--comment-issue"]
        self.assertEqual(posted, ["#452"])
        self.assertEqual([r["issue"] for r in printed["receipts"]], [f"{REPO}#452"])
        text = supervise.runs[0]["input"]
        self.assertIn("sub-issues it makes part of itself: Vaquum/Origo#453", text)
        self.assertIn(f"These already have an issue review: {REPO}#453 (from the review of {REPO}#453)", text)
        self.assertIn(f"only for {REPO}#452. Caller posts them", text)
        response = (agent_interface.RESPONSES / f"{row['id']}.txt").read_text()
        self.assertIn("Not posted (outside what this review comments on): #453", response)


class TestFullAccessCommands(TestCase):
    def command(self, identity):
        with tempfile.TemporaryDirectory() as work, patch.dict(os.environ, {"OPENAI_API_KEY": "k", "CODEX_API_KEY": "k"}):
            args, stdin, env = issue_review.command(CATALOG.resolve(identity), "review this", Path(work) / "repo", Path(work), 600)
            return args, stdin, env, work

    def test_every_provider_runs_its_own_cli_without_restrictions(self):
        args, stdin, _, work = self.command("opus-5-max")
        self.assertIn("--dangerously-skip-permissions", args)
        # Poise's subscription wrapper reads the prompt from stdin only when a
        # system-prompt flag and its value come last.
        self.assertEqual(args[-2:], ["--append-system-prompt", issue_review.UNATTENDED])
        self.assertEqual(args[args.index("--add-dir") + 1], work)
        for restriction in ("--tools", "--allowedTools", "--system-prompt"):
            self.assertNotIn(restriction, args)
        self.assertEqual(stdin, "review this")

        args, stdin, env, _ = self.command("gpt-6-astra-ultra")
        self.assertEqual(args[args.index("--sandbox") + 1], "danger-full-access")
        self.assertIn('approval_policy="never"', args)
        self.assertNotIn("--disable", args)
        self.assertNotIn("OPENAI_API_KEY", env)

        args, _, _, work = self.command("grok-4.6-xhigh")
        self.assertEqual(args[args.index("--permission-mode") + 1], "bypassPermissions")
        self.assertEqual(args[args.index("--sandbox") + 1], "off")
        self.assertEqual(args[args.index("--cwd") + 1], str(Path(work) / "repo"))
        self.assertNotIn("--tools", args)

        args, stdin, _, _ = self.command("gemini-3.8-flash-high")
        self.assertIn("--dangerously-skip-permissions", args)
        self.assertNotIn("--mode", args)
        self.assertEqual(json.loads(stdin)["message"]["content"], "review this")

        args, _, _, _ = self.command("muse-spark-1.3-contributor-max")
        self.assertIn("--yolo", args)
        for restriction in ("--disable-shell", "--disable-write", "--disable-web-tools"):
            self.assertNotIn(restriction, args)


class TestComments(TestCase):
    def write(self, value) -> Path:
        path = Path(tempfile.mkdtemp()) / "review.json"
        path.write_text(json.dumps(value))
        return path

    def test_one_comment_per_issue_in_scope_order(self):
        places = [f"{REPO}#452", f"{REPO}#453"]
        posts, ignored = issue_review.comments(self.write({"comments": [
            {"issue": f"https://github.com/{REPO}/issues/453", "body": "B"},
            {"issue": "#452", "body": "A"},
            {"issue": "#999", "body": "C"},
        ]}), places, REPO)
        self.assertEqual(posts, [{"issue": f"{REPO}#452", "body": "A"}, {"issue": f"{REPO}#453", "body": "B"}])
        self.assertEqual(ignored, ["#999"])

    def test_an_overlong_comment_is_split_and_a_malformed_one_set_aside(self):
        paragraph = "p" * 40_000
        posts, ignored = issue_review.comments(self.write({"comments": [
            {"issue": "#452", "body": f"{paragraph}\n\n{paragraph}\n\n{paragraph}"},
            {"issue": 452, "body": "no issue string"},
        ]}), [f"{REPO}#452"], REPO)
        self.assertEqual(len(posts), 3)
        self.assertTrue(all(len(post["body"]) <= issue_review.MAX_COMMENT_CHARS for post in posts))
        self.assertTrue(posts[0]["body"].startswith("*Part 1 of 3*"))
        self.assertEqual(ignored, ["a comment without an issue and a body"])
        self.assertEqual(issue_review.split("a" * 130_000, 60_000), ["a" * 60_000, "a" * 60_000, "a" * 10_000])


class TestInterface(TestCase):
    def test_cli_passes_the_issue_model_and_provenance(self):
        argv = ["agent-interface", "--issue-review", f"{REPO}#452", "--model", "grok-4.6-xhigh", "--recovery-model", "opus-5-max",
                "--actor", "bit-mis", "--source", "poise:review-new-issues", "--correlation-id", "claim-1", "--note", "memory"]
        with patch.object(agent_interface.sys, "argv", argv), patch.object(agent_interface, "run_issue_review") as run:
            agent_interface.main()
        self.assertEqual(run.call_args.args, (f"{REPO}#452", "bit-mis", "poise:review-new-issues", "claim-1", "grok-4.6-xhigh", "opus-5-max"))
        self.assertEqual(run.call_args.kwargs["note"], "memory")

    def test_issue_references_and_models(self):
        self.assertEqual(issue_review.parse(f"https://github.com/{REPO}/issues/452"), (REPO, 452))
        self.assertEqual(issue_review.parse(f"{REPO}#452"), (REPO, 452))
        for value in ("#452", "452", f"https://github.com/{REPO}/pull/452", f"{REPO}#0"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                issue_review.parse(value)
        self.assertEqual(CATALOG.issue_review_model("muse-spark-1.3-contributor-max").provider, "muse")
        with self.assertRaises(ModelCatalogError):
            CATALOG.issue_review_model("opus")
        self.assertEqual(CATALOG.export()["issue_review_providers"], ["antigravity", "claude", "codex", "grok", "muse"])


class TestProcessesAndErrors(TestCase):
    def test_a_provider_error_is_its_message_not_its_output(self):
        stdout = "\n".join([
            json.dumps({"type": "item.completed", "item": {"type": "command_execution", "aggregated_output": "SECRET=abc"}}),
            json.dumps({"type": "turn.failed", "error": {"message": "usage limit reached"}}),
        ])
        self.assertEqual(issue_review.provider_error(stdout, "stderr detail"), "usage limit reached")
        self.assertEqual(issue_review.provider_error("SECRET=abc\n", "codex: login required\n"), "codex: login required")

    def test_what_the_agent_leaves_running_in_its_checkout_is_stopped(self):
        with tempfile.TemporaryDirectory() as work:
            checkout = Path(work) / "repo"
            checkout.mkdir()
            script = ("import subprocess, sys; "
                      "p = subprocess.Popen(['sleep', '60'], start_new_session=True); "
                      "print(p.pid)")
            done = issue_review.supervise([sys.executable, "-c", script], input="", cwd=checkout, timeout=30,
                                          env=os.environ.copy(), provider=None)
            pid = int(done.stdout.strip())
            deadline = time.time() + 10
            while time.time() < deadline:
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.1)
            else:
                os.kill(pid, 9)
                self.fail("a process the agent detached into its own session outlived the run")

    def test_github_interface_is_stopped_with_everything_it_started(self):
        with tempfile.TemporaryDirectory() as work:
            marker = Path(work) / "child.pid"
            cli = Path(work) / "github-interface"
            cli.write_text(f"#!{sys.executable}\nimport subprocess, time\n"
                           f"p = subprocess.Popen(['sleep', '60'])\nopen({str(marker)!r}, 'w').write(str(p.pid))\ntime.sleep(60)\n")
            cli.chmod(0o755)
            with patch.dict(os.environ, {"GITHUB_INTERFACE_CLI": str(cli)}), self.assertRaises(subprocess.TimeoutExpired):
                issue_review.interface("--read-issue", "#1", seconds=2)
            pid = int(marker.read_text())
            deadline = time.time() + 10
            while time.time() < deadline:
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    return
                time.sleep(0.1)
            os.kill(pid, 9)
            self.fail("git work started by github-interface outlived its timeout")
