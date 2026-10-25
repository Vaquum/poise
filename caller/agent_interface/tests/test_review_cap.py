import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

import agent_interface
from agent_interface import atoms, pr_approve, structured_review
from agent_interface import review_cap as followup
from agent_interface import review_budget, review_receipt
from agent_interface.model_catalog import CATALOG
from agent_interface.review_watch import ReviewWatch

HEAD = "c" * 40
BASE = "b" * 40
FINDING = {"path": "src/main.py", "line": 4, "side": "RIGHT", "body": "Crashes on empty input."}
REMOVED_FINDING = {"path": "src/old.py", "line": 9, "side": "LEFT", "body": "Deleted helper still referenced."}
PACKET = json.dumps({
    "action": "read",
    "repository": "o/r",
    "pull_number": 12,
    "head_sha": HEAD,
    "pull": {"base": {"sha": BASE}},
    "linked_issues": [],
})


def packet_with_issue(body):
    return json.dumps({
        "action": "read",
        "repository": "o/r",
        "pull_number": 12,
        "head_sha": HEAD,
        "pull": {"base": {"sha": BASE}},
        "linked_issues": [{"number": 7, "html_url": "https://github.com/o/r/issues/7", "body": body}],
    })


def approval_reply():
    return SimpleNamespace(returncode=0, stdout=json.dumps(
        {"action": "approved_pr", "review_id": 91, "head_sha": HEAD}), stderr="")


def issue_reply(number=8):
    return SimpleNamespace(returncode=0, stdout=json.dumps(
        {"action": "created_pr_linked_issue", "repository": "o/r", "pull_number": 12,
         "issue": {"number": number, "html_url": f"https://github.com/o/r/issues/{number}"}}), stderr="")


class TestCappedApprovalTools(TestCase):
    def test_uncapped_tools_are_unchanged(self):
        self.assertEqual(
            pr_approve.allowed("#12", "bit-mis", HEAD),
            ["Bash(github-interface --request-changes '#12' --comments-json * "
             f"--expected-head {HEAD} --token-user bit-mis)",
             f"Bash(github-interface --approve-pr '#12' --expected-head {HEAD} --token-user bit-mis)"])

    def test_capped_tools_file_an_issue_and_approve(self):
        tools = pr_approve.allowed("#12", "bit-mis", HEAD, capped=True)
        self.assertEqual(len(tools), 2)
        self.assertIn("--create-pr-linked-issue '#12' --title * --body * --token-user bit-mis", tools[0])
        self.assertIn("--approve-pr '#12' ", tools[1])
        self.assertFalse(any("--request-changes" in tool for tool in tools))

    def test_capped_run_needs_round_and_cap_numbers(self):
        with self.assertRaises(ValueError):
            pr_approve.run("/repo", "https://github.com/o/r/pull/12", "bit-mis", HEAD, capped=True)

    def test_capped_prompt_names_the_round_issue_and_approval(self):
        self.assertIn("round 5 of a 5-round cap", pr_approve.capped_policy(5, 5))
        rules = pr_approve.capped_rules("o/r", "#12", HEAD, 5, 5, "bit-mis")
        text = "\n".join(rules)
        self.assertIn(followup.marker("12", HEAD), text)
        self.assertIn("--create-pr-linked-issue '#12' --title", text)
        self.assertIn("BEFORE approving", text)
        self.assertIn("submit NOTHING", text)
        # The prompt formats its severity placeholder without other braces leaking in.
        atoms.prompt("policy", ("p0: x.",), rules, "{}", [], "", "p2")


class TestCappedApprovalCli(TestCase):
    def test_cli_passes_the_capped_round(self):
        argv = ["agent-interface", "--pr-approve", "12", "--actor", "bit-mis",
               "--expected-head", HEAD, "--source", "poise:test", "--correlation-id", "test",
               "--review-cap-reached", "--review-round", "5", "--review-cap", "5"]
        with patch.object(agent_interface.sys, "argv", argv), \
                patch.object(agent_interface, "run_pr_approve") as run:
            agent_interface.main()
            self.assertTrue(run.call_args.kwargs["capped"])
            self.assertEqual(run.call_args.kwargs["review_round"], 5)
            self.assertEqual(run.call_args.kwargs["review_cap"], 5)

    def test_cli_rejects_a_half_capped_round(self):
        base = ["agent-interface", "--pr-approve", "12", "--actor", "bit-mis",
                "--expected-head", HEAD, "--source", "poise:test", "--correlation-id", "test"]
        cases = [
            base + ["--review-cap-reached", "--review-round", "5"],
            base + ["--review-cap-reached"],
            base + ["--review-round", "5", "--review-cap", "5"],
            base + ["--review-cap-reached", "--review-round", "banana", "--review-cap", "5"],
            base + ["--review-cap-reached", "--review-round", "0", "--review-cap", "5"],
        ]
        for argv in cases:
            with self.subTest(argv=argv), self.assertRaises(SystemExit):
                with patch.object(agent_interface.sys, "argv", argv):
                    agent_interface.main()


class TestFollowupIssue(TestCase):
    def test_marker_is_stable_per_pr_and_head(self):
        self.assertEqual(followup.marker("12", HEAD), f"<!-- poise:review-cap #12@{HEAD} -->")

    def test_find_returns_the_matching_issue_only(self):
        match = followup.marker("12", HEAD)
        packet = packet_with_issue(f"findings\n\n{match}\n")
        found = followup.find_capped_issue(packet, "12", HEAD)
        self.assertIsNotNone(found)
        self.assertEqual(found["number"], 7)
        self.assertIsNone(followup.find_capped_issue(packet, "12", "d" * 40))
        self.assertIsNone(followup.find_capped_issue(packet, "13", HEAD))
        self.assertIsNone(followup.find_capped_issue(PACKET, "12", HEAD))
        self.assertIsNone(followup.find_capped_issue("not json", "12", HEAD))

    def test_rendered_body_pins_findings_to_the_head(self):
        body = followup.render_body("o/r", "12", HEAD, BASE, 5, 5, [FINDING])
        self.assertTrue(body.startswith(followup.marker("12", HEAD)))
        self.assertIn("round 5", body)
        self.assertIn("cap of 5 rounds", body)
        self.assertIn(f"https://github.com/o/r/blob/{HEAD}/src/main.py#L4", body)
        self.assertIn("(RIGHT,", body)
        self.assertIn("Crashes on empty input.", body)
        self.assertEqual(followup.render_title("o/r", "12", 5), "Review follow-up for o/r#12 (round 5)")

    def test_removed_side_findings_pin_to_the_base(self):
        body = followup.render_body("o/r", "12", HEAD, BASE, 5, 5, [REMOVED_FINDING])
        self.assertIn(f"https://github.com/o/r/blob/{BASE}/src/old.py#L9", body)
        self.assertIn("(LEFT,", body)
        self.assertNotIn(HEAD, body.split("## Findings")[1])

    def test_filing_failure_approves_nothing(self):
        def process(args, **kwargs):
            return SimpleNamespace(returncode=1, stdout="", stderr="error: GitHub 422: Issues are disabled")
        with patch.object(followup.subprocess, "run", side_effect=process):
            with self.assertRaises(review_budget.ReviewLimitError) as failure:
                followup.file_followup_issue("/repo", "#12", "bit-mis", "title", "body")
        self.assertEqual(failure.exception.code, "review_contract_violation")
        self.assertIn("nothing was approved", str(failure.exception))

    def test_filing_without_a_receipt_is_uncertain(self):
        def process(args, **kwargs):
            return SimpleNamespace(returncode=0, stdout="not json", stderr="")
        with patch.object(followup.subprocess, "run", side_effect=process):
            with self.assertRaises(review_receipt.SubmissionError):
                followup.file_followup_issue("/repo", "#12", "bit-mis", "title", "body")


class TestStructuredCappedConversion(TestCase):
    def _run(self, verdict, github, packet=PACKET, **kwargs):
        def process(args, **kwargs):
            if args[0] == "github-interface":
                return github(args)
            Path(args[args.index("--output-last-message") + 1]).write_text(json.dumps(verdict))
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        params = {"packet": packet, "capped": True, "review_round": 5, "review_cap": 5}
        params.update(kwargs)
        calls = []

        def recording(args, **kwargs):
            calls.append(args)
            return process(args, **kwargs)

        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key", "CODEX_API_KEY": "test-key"}), \
                patch.object(structured_review.subprocess, "run", side_effect=recording) as run, \
                patch.object(ReviewWatch, "run", side_effect=recording):
            result = structured_review.run(
                "/repo", "system", "packet", CATALOG.resolve("gpt-6-astra-ultra"), "pr_approve",
                "https://github.com/o/r/pull/12", "bit-mis", HEAD, 60, **params)
        return result, [args for args in calls if args[0] == "github-interface"]

    def test_capped_change_request_files_an_issue_then_approves(self):
        seen = []

        def github(args):
            seen.append(args[1])
            return issue_reply() if args[1] == "--create-pr-linked-issue" else approval_reply()

        result, _ = self._run({"action": "request_changes", "comments": [FINDING]}, github)
        self.assertEqual(seen, ["--create-pr-linked-issue", "--approve-pr"])
        self.assertIn("issue #8 (https://github.com/o/r/issues/8)", result)
        self.assertIn("round 5 of 5", result)
        self.assertIn('"review_id": 91', result)

    def test_capped_issue_carries_marker_findings_and_actor(self):
        bodies = {}

        def github(args):
            if args[1] == "--create-pr-linked-issue":
                bodies["title"] = args[args.index("--title") + 1]
                bodies["body"] = args[args.index("--body") + 1]
                self.assertEqual(args[args.index("--token-user") + 1], "bit-mis")
                return issue_reply()
            return approval_reply()

        self._run({"action": "request_changes", "comments": [FINDING]}, github)
        self.assertEqual(bodies["title"], "Review follow-up for o/r#12 (round 5)")
        self.assertIn(followup.marker("12", HEAD), bodies["body"])
        self.assertIn("Crashes on empty input.", bodies["body"])
        self.assertIn(f"/blob/{HEAD}/src/main.py#L4", bodies["body"])

    def test_capped_clean_verdict_approves_without_an_issue(self):
        seen = []

        def github(args):
            seen.append(args[1])
            return approval_reply()

        result, _ = self._run({"action": "approve", "comments": []}, github)
        self.assertEqual(seen, ["--approve-pr"])
        self.assertNotIn("round 5 of 5", result)

    def test_capped_removed_side_finding_links_the_base(self):
        bodies = {}

        def github(args):
            if args[1] == "--create-pr-linked-issue":
                bodies["body"] = args[args.index("--body") + 1]
                return issue_reply()
            return approval_reply()

        self._run({"action": "request_changes", "comments": [REMOVED_FINDING]}, github)
        self.assertIn(f"/blob/{BASE}/src/old.py#L9", bodies["body"])
        self.assertIn("(LEFT,", bodies["body"])

    def test_capped_round_without_a_base_fails_loudly(self):
        packet = json.dumps({"action": "read", "repository": "o/r", "pull_number": 12,
                             "head_sha": HEAD, "linked_issues": []})

        def github(args):
            raise AssertionError("no GitHub call may precede the packet check")

        with self.assertRaises(review_budget.ReviewLimitError) as failure:
            self._run({"action": "request_changes", "comments": [FINDING]}, github, packet=packet)
        self.assertEqual(failure.exception.code, "review_contract_violation")

    def test_capped_replay_reuses_the_marked_issue(self):
        seen = []

        def github(args):
            seen.append(args[1])
            return approval_reply()

        packet = packet_with_issue(f"findings\n\n{followup.marker('12', HEAD)}\n")
        result, _ = self._run({"action": "request_changes", "comments": [FINDING]}, github, packet=packet)
        self.assertEqual(seen, ["--approve-pr"])
        self.assertIn("issue #7 (https://github.com/o/r/issues/7)", result)

    def test_capped_issue_failure_approves_nothing(self):
        seen = []

        def github(args):
            seen.append(args[1])
            if args[1] == "--create-pr-linked-issue":
                return SimpleNamespace(returncode=1, stdout="", stderr="error: GitHub 422: no issues")
            return approval_reply()

        with self.assertRaises(review_budget.ReviewLimitError) as failure:
            self._run({"action": "request_changes", "comments": [FINDING]}, github)
        self.assertEqual(failure.exception.code, "review_contract_violation")
        self.assertEqual(seen, ["--create-pr-linked-issue"])

    def test_uncapped_change_request_is_unchanged(self):
        seen = []

        def github(args):
            seen.append(args[1])
            return SimpleNamespace(returncode=0, stdout=json.dumps(
                {"action": "requested_changes", "review_id": 92, "head_sha": HEAD}), stderr="")

        self._run({"action": "request_changes", "comments": [FINDING]}, github, capped=False,
                  review_round=None, review_cap=None)
        self.assertEqual(seen, ["--request-changes"])
