import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

import agent_interface
from agent_interface import atoms, pr_approve, review_repository, structured_review
from agent_interface import review_cap as followup
from agent_interface import review_budget, review_receipt
from agent_interface.model_catalog import CATALOG
from agent_interface.review_watch import ReviewWatch
from review_submission_fixture import submission_args

ASSESSMENT = {'verdict': 'The changed validation paths have no remaining blocking defects.', 'reviewed_context': 'Inspected the supplied immutable diff and its affected callers.', 'limitations': 'Provider fixture; no application test execution.'}
HEAD = "c" * 40
BASE = "b" * 40
FINDING = {"path": "src/main.py", "line": 4, "side": "RIGHT", "body": "[p1] Empty input returns the wrong status."}
REMOVED_FINDING = {"path": "src/old.py", "line": 9, "side": "LEFT", "body": "[p2] Deleted helper still referenced by the optional hook."}
BREAKING_FINDING = {**FINDING, "body": "[p0] Every save loses the existing document."}
PACKET = json.dumps({
    "action": "read",
    "coverage": "complete",
    "repository": "o/r",
    "pull_number": 12,
    "head_sha": HEAD,
    "pull": {"base": {"sha": BASE}},
    "linked_issues": [],
    "files": [{"filename": "src/main.py"}, {"filename": "src/old.py"}],
    "diff": "diff --git a/src/main.py b/src/main.py\n--- a/src/main.py\n+++ b/src/main.py\n"
            "@@ -4 +4 @@\n-old\n+new\n"
            "diff --git a/src/old.py b/src/old.py\n--- a/src/old.py\n+++ b/src/old.py\n"
            "@@ -9 +9,0 @@\n-removed\n",
})


def packet_with_issue(body):
    return json.dumps({
        **json.loads(PACKET),
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
    def test_claude_gets_the_final_round_policy_and_only_read_tools(self):
        with patch.object(atoms, "packet", return_value=PACKET), \
                patch.object(atoms, "last_reviewed_head", return_value=None), \
                patch.object(review_repository, "prepare") as prepare, \
                patch.object(atoms, "run_agent", return_value="submitted") as run:
            prepare.return_value.__enter__.return_value.prompt.return_value = ""
            pr_approve.run("/repo", "https://github.com/o/r/pull/12", "bit-mis", HEAD,
                           model="opus-5-high", capped=True, review_round=5, review_cap=5)
        text, tools = run.call_args.args[2:4]
        self.assertIn("PR review round 5 of 5", text)
        self.assertIn("This is the final PR review round", text)
        self.assertIn("Only breaking changes", text)
        self.assertIn("linked ticket", text)
        self.assertEqual(tools, [review_repository.INSPECTION_RULE])

    def test_uncapped_tools_are_unchanged(self):
        self.assertEqual(
            pr_approve.allowed("#12", "bit-mis", HEAD),
            ["Bash(github-interface --request-changes '#12' --comments-json * "
             f"--assessment-json * --expected-head {HEAD} --token-user bit-mis)",
             f"Bash(github-interface --approve-pr '#12' --assessment-json * --expected-head {HEAD} --token-user bit-mis)"])

    def test_capped_run_needs_round_and_cap_numbers(self):
        with self.assertRaises(ValueError):
            pr_approve.run("/repo", "https://github.com/o/r/pull/12", "bit-mis", HEAD, capped=True)


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
            base + ["--review-cap", "5"],
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
        self.assertIn("round 5 of 5", body)
        self.assertIn(f"https://github.com/o/r/blob/{HEAD}/src/main.py#L4", body)
        self.assertIn("(RIGHT,", body)
        self.assertIn(FINDING["body"], body)
        self.assertEqual(followup.render_title("o/r", "12", 5), "Review follow-up for o/r#12 (round 5)")

    def test_removed_side_findings_pin_to_the_base(self):
        body = followup.render_body("o/r", "12", HEAD, BASE, 5, 5, [REMOVED_FINDING])
        self.assertIn(f"https://github.com/o/r/blob/{BASE}/src/old.py#L9", body)
        self.assertIn("(LEFT,", body)
        self.assertNotIn(HEAD, body.split("## Findings")[1])

    def test_special_characters_in_paths_do_not_break_the_link(self):
        finding = {"path": "docs/C#-notes.md", "line": 1, "side": "RIGHT", "body": "Stale link."}
        body = followup.render_body("o/r", "12", HEAD, BASE, 5, 5, [finding])
        self.assertIn(f"https://github.com/o/r/blob/{HEAD}/docs/C%23-notes.md#L1", body)
        self.assertIn("`docs/C#-notes.md:1`", body)

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
                return github(submission_args(args))
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

    def test_capped_reaffirmation_preserves_a_breaking_legacy_thread(self):
        original = {**FINDING, "body": "Every save loses the existing document."}
        node = {**json.loads(PACKET), "review_threads": [{**original, "bodies": [original["body"]],
                "is_resolved": False, "is_outdated": True}]}

        def github(args):
            self.assertEqual(args[1], "--request-changes")
            self.assertEqual(json.loads(args[args.index("--comments") + 1]), [original])
            return SimpleNamespace(returncode=0, stdout=json.dumps(
                {"action": "requested_changes", "review_id": 92, "head_sha": HEAD}), stderr="")

        for body in (original["body"], "[p0] " + original["body"]):
            with self.subTest(body=body):
                self._run({"assessment": ASSESSMENT, "action": "request_changes",
                           "comments": [{**original, "body": body, "line": 999}]}, github, packet=json.dumps(node))

    def test_capped_change_request_files_an_issue_then_approves(self):
        seen = []

        def github(args):
            seen.append(args[1])
            return issue_reply() if args[1] == "--create-pr-linked-issue" else approval_reply()

        for review_round in (5, 6):
            with self.subTest(review_round=review_round):
                seen.clear()
                result, calls = self._run({"assessment": ASSESSMENT, "action": "request_changes",
                                           "comments": [FINDING, REMOVED_FINDING]}, github, review_round=review_round)
                self.assertEqual(seen, ["--create-pr-linked-issue", "--approve-pr"])
                self.assertIn("issue #8 (https://github.com/o/r/issues/8)", result)
                self.assertIn('"review_id": 91', result)
                self.assertEqual(calls[-1][calls[-1].index("--expected-head") + 1], HEAD)

    def test_capped_request_publishes_only_the_breaking_finding(self):
        for packet in (PACKET, packet_with_issue(followup.render_body("o/r", "12", HEAD, BASE, 5, 5, [FINDING]))):
            seen = []
            def github(args):
                seen.append(args[1])
                if args[1] == "--create-pr-linked-issue":
                    self.assertIn(FINDING["body"], args[args.index("--body") + 1])
                    self.assertNotIn(BREAKING_FINDING["body"], args[args.index("--body") + 1])
                    return issue_reply()
                self.assertEqual(args[1], "--request-changes")
                self.assertEqual(json.loads(args[args.index("--comments") + 1]), [BREAKING_FINDING])
                self.assertEqual(args[args.index("--expected-head") + 1], HEAD)
                return SimpleNamespace(returncode=0, stdout=json.dumps(
                    {"action": "requested_changes", "review_id": 92, "head_sha": HEAD}), stderr="")

            self._run({"assessment": ASSESSMENT, "action": "request_changes",
                       "comments": [BREAKING_FINDING, FINDING]}, github, packet=packet)
            has_issue = packet != PACKET
            self.assertEqual(seen, ["--request-changes"] if has_issue else
                             ["--create-pr-linked-issue", "--request-changes"])

    def test_capped_issue_carries_marker_findings_and_actor(self):
        bodies = {}

        def github(args):
            if args[1] == "--create-pr-linked-issue":
                bodies["title"] = args[args.index("--title") + 1]
                bodies["body"] = args[args.index("--body") + 1]
                self.assertEqual(args[args.index("--token-user") + 1], "bit-mis")
                return issue_reply()
            return approval_reply()

        self._run({"assessment": ASSESSMENT, "action": "request_changes", "comments": [FINDING]}, github)
        self.assertEqual(bodies["title"], "Review follow-up for o/r#12 (round 5)")
        self.assertIn(followup.marker("12", HEAD), bodies["body"])
        self.assertIn(FINDING["body"], bodies["body"])
        self.assertIn(f"/blob/{HEAD}/src/main.py#L4", bodies["body"])

    def test_capped_clean_verdict_approves_without_an_issue(self):
        seen = []

        def github(args):
            seen.append(args[1])
            return approval_reply()

        result, _ = self._run({"assessment": ASSESSMENT, "action": "approve", "comments": []}, github)
        self.assertEqual(seen, ["--approve-pr"])
        self.assertNotIn("round 5 of 5", result)

    def test_capped_removed_side_finding_links_the_base(self):
        bodies = {}

        def github(args):
            if args[1] == "--create-pr-linked-issue":
                bodies["body"] = args[args.index("--body") + 1]
                return issue_reply()
            return approval_reply()

        self._run({"assessment": ASSESSMENT, "action": "request_changes", "comments": [REMOVED_FINDING]}, github)
        self.assertIn(f"/blob/{BASE}/src/old.py#L9", bodies["body"])
        self.assertIn("(LEFT,", bodies["body"])

    def test_capped_round_without_a_base_fails_loudly(self):
        node = json.loads(PACKET)
        del node["pull"]
        packet = json.dumps(node)

        def github(args):
            raise AssertionError("no GitHub call may precede the packet check")

        with self.assertRaises(review_budget.ReviewLimitError) as failure:
            self._run({"assessment": ASSESSMENT, "action": "request_changes", "comments": [FINDING]}, github, packet=packet)
        self.assertEqual(failure.exception.code, "review_contract_violation")

    def test_capped_replay_reuses_the_marked_issue(self):
        seen = []

        def github(args):
            seen.append(args[1])
            return approval_reply()

        packet = packet_with_issue(followup.render_body("o/r", "12", HEAD, BASE, 5, 5, [FINDING]))
        for review_round in (5, 6):
            with self.subTest(review_round=review_round):
                seen.clear()
                comments = [{**FINDING, "body": FINDING["body"].replace("[p1]", "[P1]")}]
                result, _ = self._run({"assessment": ASSESSMENT, "action": "request_changes", "comments": comments},
                                      github, packet=packet, review_round=review_round)
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
            self._run({"assessment": ASSESSMENT, "action": "request_changes", "comments": [FINDING]}, github)
        self.assertEqual(failure.exception.code, "review_contract_violation")
        self.assertEqual(seen, ["--create-pr-linked-issue"])

    def test_uncapped_change_request_is_unchanged(self):
        seen = []

        def github(args):
            seen.append(args[1])
            return SimpleNamespace(returncode=0, stdout=json.dumps(
                {"action": "requested_changes", "review_id": 92, "head_sha": HEAD}), stderr="")

        self._run({"assessment": ASSESSMENT, "action": "request_changes", "comments": [FINDING]}, github, capped=False,
                  review_round=None, review_cap=None)
        self.assertEqual(seen, ["--request-changes"])
