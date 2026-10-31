"""A run's outcome is the review it submitted, told apart from a sibling's by id."""
import io
import json
import os
import sqlite3
import sys
import tempfile
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import Mock, patch
from uuid import uuid4

import agent_interface as api
from agent_interface import bash_guard, review_budget as budget, review_receipt, structured_review
from agent_interface.model_catalog import CATALOG
from agent_interface.review_watch import ReviewWatch

HEAD = "a" * 40
CHANGES = {"id": 91, "node_id": "PRR_91", "state": "CHANGES_REQUESTED", "commit": HEAD, "submitted_at": "2026-09-17T10:05:00Z"}
CLEAN = {"id": 92, "node_id": "PRR_92", "state": "COMMENTED", "commit": HEAD, "submitted_at": "2026-09-17T10:06:00Z"}
APPROVAL = {"id": 93, "node_id": "PRR_93", "state": "APPROVED", "commit": HEAD, "submitted_at": "2026-09-17T10:07:00Z"}
QUOTA_HEADERS = {"x-ratelimit-resource": "core", "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "0",
                 "x-ratelimit-used": "5000", "x-ratelimit-reset": "1792564636"}
QUOTA_FAILURE = f"error: GitHub 403 rate-limit: {QUOTA_HEADERS}"
QUOTA_ERROR = QUOTA_FAILURE + ' body={"message":"API rate limit exceeded"}'


def facts(items=(), **updates):
    items = list(items)
    value = dict(
        repository="o/r", pull_number=1, state="OPEN", draft=False, head_sha=HEAD,
        reviewer_change_requests_since=sum(1 for i in items if i["state"] == "CHANGES_REQUESTED"),
        reviewer_approvals_since=sum(1 for i in items if i["state"] == "APPROVED"),
        reviewer_comments_since=sum(1 for i in items if i["state"] == "COMMENTED"),
        reviewer_reviews_since=len(items), reviewer_reviews_since_items=items, reviewer_pending_reviews=0,
        reviewer_latest_review_id=None, reviewer_latest_any_review_id=None,
    )
    return {**value, **updates}


def receipt(action, review_id):
    return {"action": action, "review_id": review_id, "head_sha": HEAD}


class TestOwnReviews(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(patch.stopall)
        patch.object(api, "DB", Path(self.directory.name) / "calls.sqlite3").start()
        patch.object(api, "RESPONSES", Path(self.directory.name) / "responses").start()
        patch.object(api, "sleep").start()
        api.init_db()
        review_receipt.bind(api.DB, "me")

    def row(self, call_id, review_id=None):
        with sqlite3.connect(api.DB) as conn:
            conn.execute("insert into calls (id, behavior, repo, pr_id, review_id, started_at) values (?, 'pr_review', 'o/r', '1', ?, 0)",
                         (call_id, str(review_id) if review_id else None))

    def outcome(self, behavior, before, after, **kwargs):
        return api.behavior_outcome(object(), behavior, "1", "/tmp", "bit-mis", HEAD, before, after, **kwargs)

    def test_receipt_picks_this_runs_review_among_siblings(self):
        after = facts([CHANGES, CLEAN])
        self.assertEqual(self.outcome("pr_review", facts(), after, receipt=receipt("reviewed_clean", 92))["outcome"], "clean")
        self.assertEqual(self.outcome("pr_review", facts(), after, receipt=receipt("requested_changes", 91))["outcome"], "changes_requested")
        self.assertEqual(self.outcome("pr_approve", facts(), facts([CHANGES, APPROVAL]), receipt=receipt("approved_pr", 93))["outcome"], "approved")

    def test_receipt_must_match_a_posted_review_of_its_kind(self):
        with self.assertRaisesRegex(RuntimeError, "exactly one"):
            self.outcome("pr_review", facts(), facts([CHANGES]), receipt=receipt("reviewed_clean", 92))
        with self.assertRaisesRegex(RuntimeError, "does not match its receipt"):
            self.outcome("pr_review", facts(), facts([CHANGES]), receipt=receipt("reviewed_clean", 91))
        with self.assertRaisesRegex(RuntimeError, "expected head"):
            self.outcome("pr_review", facts(), facts([{**CLEAN, "commit": "b" * 40}]), receipt=receipt("reviewed_clean", 92))
        with self.assertRaisesRegex(RuntimeError, "unexpected approval"):
            self.outcome("pr_review", facts(), facts([APPROVAL]), receipt=receipt("approved_pr", 93))

    def test_reviews_already_there_before_the_run_are_not_its_own(self):
        with self.assertRaisesRegex(RuntimeError, "exactly one"):
            self.outcome("pr_review", facts([CLEAN]), facts([CLEAN]), receipt=receipt("reviewed_clean", 92))

    def test_without_a_receipt_an_unclaimed_review_is_uncertain_not_adopted(self):
        self.row("me")
        self.row("sibling", 91)
        with self.assertRaises(budget.ReviewLimitError) as raised:
            self.outcome("pr_review", facts(), facts([CHANGES, CLEAN]), call_id="me")
        self.assertEqual(raised.exception.code, api.REVIEW_PUBLICATION_UNCERTAIN_CODE)
        self.assertIn("[92]", str(raised.exception))
        self.row("other", 92)
        with self.assertRaisesRegex(RuntimeError, "exactly one"):
            self.outcome("pr_review", facts(), facts([CHANGES, CLEAN]), call_id="me")

    def test_without_identity_a_new_review_is_not_adopted(self):
        self.assertEqual(api.own_reviews(facts(), facts([CLEAN]), None, None), [])
        with self.assertRaisesRegex(budget.ReviewLimitError, "exactly one"):
            self.outcome("pr_review", facts(), facts([CLEAN]))

    def test_an_unclaimed_review_is_checked_again_after_a_grace(self):
        self.row("me")
        self.row("sibling")
        calls = []

        def claim():
            calls.append(1)
            with sqlite3.connect(api.DB) as conn:
                conn.execute("update calls set review_id='91' where id='sibling'")
        api.sleep.side_effect = lambda _: claim()
        with self.assertRaisesRegex(RuntimeError, "exactly one"):
            self.outcome("pr_review", facts(), facts([CHANGES]), call_id="me")
        self.assertEqual(calls, [1])

    def test_facts_without_ids_hold_instead_of_adopting_from_counters(self):
        before = {k: v for k, v in facts().items() if k != "reviewer_reviews_since_items"}
        after = {**before, "reviewer_comments_since": 1, "reviewer_latest_any_state": "COMMENTED",
                 "reviewer_latest_any_commit": HEAD, "reviewer_latest_any_review_id": "R_clean",
                 "reviewer_latest_any_submitted_at": "2026-09-17T10:06:00Z"}
        self.assertIsNone(api.own_reviews(before, after, None, "me"))
        # Aggregate progress cannot validate an exact publication receipt, and
        # without per-review ids a sibling's review is indistinguishable too.
        for kwargs in ({"receipt": receipt("reviewed_clean", 92)}, {"call_id": "me"}, {}):
            with self.subTest(kwargs=sorted(kwargs)):
                with self.assertRaises(budget.ReviewLimitError) as raised:
                    self.outcome("pr_review", before, after, **kwargs)
                self.assertEqual(raised.exception.code, api.REVIEW_PUBLICATION_UNCERTAIN_CODE)

    def test_logs_carry_the_review_id(self):
        self.row("me", 92)
        self.assertEqual(api.logs()[0]["review_id"], 92)

    def test_quota_marker_cannot_override_live_review_or_receipt_checks(self):
        review_receipt.bind(api.DB, "me")
        review_receipt.record_failure(QUOTA_ERROR)
        self.row("me")
        for behavior, review, outcome in (("pr_review", CLEAN, "clean"), ("pr_review", CHANGES, "changes_requested"),
                                          ("pr_approve", APPROVAL, "approved")):
            with self.subTest(outcome=outcome):
                with self.assertRaises(budget.ReviewLimitError) as raised:
                    self.outcome(behavior, facts(), facts([review]), call_id="me")
                self.assertEqual(raised.exception.code, api.REVIEW_PUBLICATION_UNCERTAIN_CODE)
        with self.assertRaisesRegex(budget.ReviewLimitError, "exactly one"):
            self.outcome("pr_approve", facts(), facts([CHANGES]), receipt=receipt("approved_pr", 93))
        with self.assertRaisesRegex(RuntimeError, "expected head"):
            self.outcome("pr_approve", facts(), facts([{**APPROVAL, "commit": "b" * 40}]), receipt=receipt("approved_pr", 93))
        with self.assertRaises(review_receipt.SubmissionError):
            self.outcome("pr_review", facts(), facts([CLEAN, CHANGES]))
        self.assertEqual(self.outcome("pr_approve", facts(), facts(head_sha="b" * 40))["outcome"], "superseded")


class TestReceiptRecording(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(patch.stopall)
        patch.object(api, "DB", Path(self.directory.name) / "calls.sqlite3").start()
        patch.object(api, "RESPONSES", Path(self.directory.name) / "responses").start()
        api.init_db()
        review_receipt.bind(api.DB, "run")
        with sqlite3.connect(api.DB) as conn:
            conn.execute("insert into calls (id, started_at) values ('run', 0)")

    def stored(self):
        with sqlite3.connect(api.DB) as conn:
            return conn.execute("select review_id from calls where id='run'").fetchone()[0]

    def test_only_a_submission_reply_is_a_receipt(self):
        for text in ("not json", json.dumps({"action": "no_review", "review_id": 5}), json.dumps({"action": "reviewed_clean"}),
                     json.dumps({"action": "reviewed_clean", "review_id": "9"}), json.dumps({"action": "reviewed_clean", "review_id": True})):
            with self.subTest(text=text):
                self.assertIsNone(review_receipt.record(text))
        self.assertIsNone(review_receipt.get())
        self.assertIsNone(self.stored())
        self.assertEqual(review_receipt.record(json.dumps({"action": "requested_changes", "review_id": 91, "head_sha": HEAD})),
                         {"action": "requested_changes", "review_id": 91, "head_sha": HEAD})
        self.assertEqual(review_receipt.get()["review_id"], 91)
        self.assertEqual(self.stored(), "91")

    def test_a_change_request_records_how_many_comments_it_posted(self):
        review_receipt.record(json.dumps({"action": "requested_changes", "review_id": 91, "head_sha": HEAD, "comments": 3}))
        with sqlite3.connect(api.DB) as conn:
            self.assertEqual(conn.execute("select review_comments from calls where id='run'").fetchone()[0], "3")
        self.assertEqual([entry["review_comments"] for entry in api.logs() if entry["id"] == "run"], [3])
        review_receipt.record(json.dumps({"action": "requested_changes", "review_id": 91, "head_sha": HEAD, "comments": 5}))
        self.assertEqual([entry["review_comments"] for entry in api.logs() if entry["id"] == "run"], [5])

    def test_a_second_accepted_receipt_is_preserved_as_this_calls_conflict(self):
        review_receipt.record(json.dumps({"action": "requested_changes", "review_id": 91, "head_sha": HEAD, "comments": 3}))
        kept = review_receipt.record(json.dumps({"action": "reviewed_clean", "review_id": 92, "head_sha": HEAD}))
        self.assertEqual(kept, {"action": "requested_changes", "review_id": 91, "head_sha": HEAD})
        self.assertEqual(self.stored(), "91")
        with sqlite3.connect(api.DB) as conn:
            self.assertEqual(conn.execute("select review_comments from calls where id='run'").fetchone()[0], "3")
        pair = review_receipt.conflict()
        self.assertEqual(pair["first"]["review_id"], 91)
        self.assertEqual(pair["second"], {"action": "reviewed_clean", "review_id": 92, "head_sha": HEAD})

    def test_a_receipt_without_its_head_is_not_positive_evidence(self):
        for text in (json.dumps({"action": "reviewed_clean", "review_id": 92}),
                     json.dumps({"action": "reviewed_clean", "review_id": 92, "head_sha": "not-a-sha"})):
            with self.subTest(text=text):
                review_receipt.bind(api.DB, "run")
                self.assertIsNone(review_receipt.record(text))
        self.assertIsNone(review_receipt.get())
        self.assertIsNone(self.stored())

    def test_structured_submission_records_its_receipt(self):
        reply = json.dumps({"action": "reviewed_clean", "review_id": 92, "head_sha": HEAD})

        def process(args, **kwargs):
            if args[0] == "github-interface":
                return SimpleNamespace(returncode=0, stdout=reply, stderr="")
            return SimpleNamespace(returncode=0, stdout=json.dumps({"stopReason": "end_turn", "num_turns": 1,
                                   "structuredOutput": {"action": "reviewed_clean", "comments": []}}), stderr="")
        with patch.object(structured_review.subprocess, "run", side_effect=process), patch.object(ReviewWatch, "run", side_effect=process):
            structured_review.run("/repo", "system", "packet", CATALOG.resolve("grok-4.6-xhigh"), "pr_review",
                                  "https://github.com/o/r/pull/12", "bit-mis", HEAD, 60)
        self.assertEqual(review_receipt.get()["review_id"], 92)
        self.assertEqual(self.stored(), "92")

    def test_failed_structured_submission_records_controller_error_without_a_receipt(self):
        def process(args, **kwargs):
            if args[0] == "github-interface":
                return SimpleNamespace(returncode=1, stdout="", stderr="error: GitHub 500:\n")
            return SimpleNamespace(returncode=0, stdout=json.dumps({"stopReason": "end_turn", "num_turns": 1,
                                   "structuredOutput": {"action": "reviewed_clean", "comments": []}}), stderr="")
        with patch.object(structured_review.subprocess, "run", side_effect=process), patch.object(ReviewWatch, "run", side_effect=process):
            with self.assertRaises(review_receipt.SubmissionError):
                structured_review.run("/repo", "system", "packet", CATALOG.resolve("grok-4.6-xhigh"), "pr_review",
                                      "https://github.com/o/r/pull/12", "bit-mis", HEAD, 60)
        self.assertEqual(review_receipt.failure(), "error: GitHub 500:")
        self.assertIsNone(review_receipt.get())
        self.assertIsNone(self.stored())

    def test_validation_auth_and_provider_prose_are_not_transient_submission_errors(self):
        for text in ("error: GitHub 422: invalid review", "error: GitHub 403: forbidden",
                     "The model says GitHub 500: failed", "invalid model verdict",
                     "error: GitHub 422: invalid review\nGitHub 500: body text",
                     f"error: GitHub 403 rate-limit: {dict(QUOTA_HEADERS, **{'x-ratelimit-remaining': '4800', 'x-ratelimit-used': '200'})} body={QUOTA_ERROR}\nGitHub 503: body text"):
            with self.subTest(text=text):
                review_receipt.bind(api.DB, "run")
                self.assertIsNone(review_receipt.record_failure(text))
                self.assertIsNone(review_receipt.failure())

    def test_malformed_quota_metadata_cannot_be_rescued_by_body_text(self):
        invalid = [
            {k: v for k, v in QUOTA_HEADERS.items() if k != "x-ratelimit-resource"},
            {k: v for k, v in QUOTA_HEADERS.items() if k != "x-ratelimit-remaining"},
            {**QUOTA_HEADERS, "x-ratelimit-remaining": 0},
            {**QUOTA_HEADERS, "x-ratelimit-remaining": "00"},
            {**QUOTA_HEADERS, "x-ratelimit-reset": "secret-marker"},
            {**QUOTA_HEADERS, "x-ratelimit-reset": "1" * 21},
            {**QUOTA_HEADERS, "authorization": "secret-marker"},
        ]
        literals = [str(headers) for headers in invalid] + [
            "{'x-ratelimit-resource': 'core', 'x-ratelimit-remaining': '4', 'x-ratelimit-remaining': '0'}",
            "{'x-ratelimit-resource': 'core', 'x-ratelimit-remaining': {'value': '0'}}",
            "{'x-ratelimit-resource': 'core', 'x-ratelimit-remaining': '0'",
            "{'x-ratelimit-resource': 'core', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '" + "1" * 2048 + "'}",
        ]
        for index, headers in enumerate(literals):
            with self.subTest(case=index):
                review_receipt.bind(api.DB, "run")
                self.assertIsNone(review_receipt.record_failure(f"error: GitHub 403 rate-limit: {headers} body={QUOTA_ERROR}\nGitHub 500: body text"))
                self.assertIsNone(review_receipt.failure())

    def test_quota_without_optional_reset_retains_only_observed_metadata(self):
        headers = {"x-ratelimit-resource": "core", "x-ratelimit-remaining": "0"}
        self.assertEqual(review_receipt.record_failure(f"GitHub 403 rate-limit: {headers} body=omitted"),
                         f"error: GitHub 403 rate-limit: {headers}")
        self.assertNotIn("reset", review_receipt.failure())
        self.assertIsNone(review_receipt.get())

    def test_genuine_outer_transient_statuses_survive_nested_body_errors(self):
        for status in (408, 429, 500, 503, 599):
            with self.subTest(status=status):
                review_receipt.bind(api.DB, "run")
                message = f"error: GitHub {status}: actual failure\nGitHub 403: nested body text"
                self.assertEqual(review_receipt.record_failure("warning before error\n" + message), message)
                self.assertIsNone(review_receipt.get())

    def test_transport_timeout_is_transient_never_a_refused_submission(self):
        for error in ("httpx.ReadTimeout: timed out",
                      "httpx.ConnectError: [Errno 111] Connection refused",
                      "httpx._exceptions.RemoteProtocolError: peer closed connection"):
            with self.subTest(error=error):
                review_receipt.bind(api.DB, "run")
                text = f"Traceback (most recent call last):\n  File \"client.py\", line 69, in request\n{error}\n"
                message = review_receipt.record_failure(text)
                self.assertTrue(message.startswith(error.split(":")[0]))
                self.assertEqual(review_receipt.failure(), message)
                self.assertIsNone(review_receipt.get())

    def test_guard_refusal_is_not_a_transient_submission_error(self):
        review_receipt.bind(api.DB, "run")
        self.assertIsNone(review_receipt.record_failure(
            "error: 1 unresolved review conversation(s) from other reviewers remain"))
        self.assertIsNone(review_receipt.failure())

    def test_blocked_refusal_matches_only_the_guard_line(self):
        line = "error: 1 unresolved review conversation(s) from other reviewers remain"
        self.assertEqual(review_receipt.blocked_refusal(line), line)
        self.assertEqual(review_receipt.blocked_refusal(f"Traceback\nRuntimeError: {line}\n"), line)
        for text in ("error: GitHub 422: invalid review",
                     "Traceback\nhttpx.ReadTimeout: timed out",
                     "2 unresolved review conversation(s) remain after resolution",
                     "the model mentions unresolved review conversations"):
            with self.subTest(text=text):
                self.assertIsNone(review_receipt.blocked_refusal(text))

    def test_provider_failure_with_exact_quota_prose_is_not_a_submission_failure(self):
        with patch.object(ReviewWatch, "run", return_value=SimpleNamespace(returncode=1, stdout="", stderr=QUOTA_ERROR)), \
                patch.object(structured_review.subprocess, "run") as submit:
            with self.assertRaises(api.atoms.AgentPreflightError):
                structured_review.run("/repo", "system", "packet", CATALOG.resolve("grok-4.6-xhigh"), "pr_review",
                                      "https://github.com/o/r/pull/1", "bit-mis", HEAD, 60)
        submit.assert_not_called()
        self.assertIsNone(review_receipt.failure())
        self.assertIsNone(self.stored())

    def test_claude_guard_leaves_the_reply_for_the_run_and_the_model(self):
        head = HEAD
        command = f"github-interface --reviewed-clean #68 --expected-head {head} --token-user bit-mis"
        reply = json.dumps({"action": "reviewed_clean", "review_id": 92, "head_sha": head})
        receipt_path = Path(self.directory.name) / "receipt.json"
        with patch.dict(os.environ, {"AGENT_INTERFACE_BASH_ALLOW": json.dumps([command]), "AGENT_INTERFACE_REVIEW_RECEIPT": str(receipt_path)}), \
                patch.object(sys, "argv", ["bash_guard.py", command]), \
                patch.object(bash_guard.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=reply, stderr="warn\n")) as run, \
                redirect_stdout(io.StringIO()) as out:
            with self.assertRaises(SystemExit) as stopped:
                bash_guard.main()
        self.assertEqual(stopped.exception.code, 0)
        self.assertTrue(run.call_args.kwargs["capture_output"])
        self.assertEqual(out.getvalue(), reply)
        self.assertEqual(json.loads(receipt_path.read_text())["review_id"], 92)
        # The run notices the file while the provider is still working.
        self.assertEqual(review_receipt.record_file(receipt_path)["review_id"], 92)
        self.assertEqual(self.stored(), "92")

    def test_claude_guard_without_a_receipt_path_runs_as_before(self):
        command = "github-interface --reviewed-clean #68 --expected-head " + HEAD + " --token-user bit-mis"
        with patch.dict(os.environ, {"AGENT_INTERFACE_BASH_ALLOW": json.dumps([command])}, clear=False), \
                patch.object(sys, "argv", ["bash_guard.py", command]), \
                patch.object(bash_guard.subprocess, "run", return_value=SimpleNamespace(returncode=0)) as run:
            os.environ.pop("AGENT_INTERFACE_REVIEW_RECEIPT", None)
            with self.assertRaises(SystemExit):
                bash_guard.main()
        self.assertNotIn("capture_output", run.call_args.kwargs)

    def test_claude_guard_preserves_transient_submission_error_for_controller(self):
        command = f"github-interface --reviewed-clean #68 --expected-head {HEAD} --token-user bit-mis"
        receipt_path = Path(self.directory.name) / "receipt.json"
        with patch.dict(os.environ, {"AGENT_INTERFACE_BASH_ALLOW": json.dumps([command]), "AGENT_INTERFACE_REVIEW_RECEIPT": str(receipt_path)}), \
                patch.object(sys, "argv", ["bash_guard.py", command]), \
                patch.object(bash_guard.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout="", stderr="error: GitHub 503:\n")), \
                redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as stopped:
                bash_guard.main()
        self.assertEqual(stopped.exception.code, 1)
        review_receipt.bind(api.DB, "run")
        self.assertIsNone(review_receipt.record_file(receipt_path))
        self.assertEqual(review_receipt.failure(), "error: GitHub 503:")
        self.assertIsNone(self.stored())

    def test_claude_guard_blocks_a_second_write_after_an_uncertain_submission(self):
        command = f"github-interface --reviewed-clean #68 --expected-head {HEAD} --token-user bit-mis"
        gate_path = Path(self.directory.name) / "gate.lock"
        gate_path.touch()
        receipt_path = Path(self.directory.name) / "receipt.json"
        reply = json.dumps({"action": "reviewed_clean", "review_id": 92, "head_sha": HEAD})
        env = {"AGENT_INTERFACE_BASH_ALLOW": json.dumps([command]),
               "AGENT_INTERFACE_REVIEW_GATE": str(gate_path),
               "AGENT_INTERFACE_REVIEW_RECEIPT": str(receipt_path)}
        runs = iter([SimpleNamespace(returncode=1, stdout="", stderr="error: GitHub 503:\n"),
                     SimpleNamespace(returncode=0, stdout=reply, stderr="")])
        with patch.dict(os.environ, env), patch.object(sys, "argv", ["bash_guard.py", command]), \
                patch.object(bash_guard.subprocess, "run", side_effect=lambda *a, **k: next(runs)) as run, \
                redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as stopped:
                bash_guard.main()
            self.assertEqual(stopped.exception.code, 1)
            self.assertIn("uncertain", gate_path.read_text())
            with self.assertRaisesRegex(RuntimeError, "uncertain; blocked until reconciled"):
                bash_guard.main()
        self.assertEqual(run.call_count, 1)
        self.assertFalse(receipt_path.exists())

    def test_claude_guard_persists_the_guard_refusal_unsealed_for_retry(self):
        command = f"github-interface --approve-pr #68 --expected-head {HEAD} --token-user bit-mis"
        receipt_path = Path(self.directory.name) / "receipt.json"
        gate_path = Path(self.directory.name) / "gate"
        gate_path.write_text("")
        line = "error: 2 unresolved review conversation(s) from other reviewers remain"
        with patch.dict(os.environ, {"AGENT_INTERFACE_BASH_ALLOW": json.dumps([command]),
                                     "AGENT_INTERFACE_REVIEW_RECEIPT": str(receipt_path),
                                     "AGENT_INTERFACE_REVIEW_GATE": str(gate_path)}), \
                patch.object(sys, "argv", ["bash_guard.py", command]), \
                patch.object(bash_guard.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout="", stderr=line + "\n")), \
                redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as stopped:
                bash_guard.main()
        self.assertEqual(stopped.exception.code, 1)
        self.assertEqual(Path(str(receipt_path) + ".blocked").read_text(), line)
        self.assertEqual(gate_path.read_text(), "")
        review_receipt.bind(api.DB, "run")
        self.assertIsNone(review_receipt.record_file(receipt_path))
        self.assertEqual(review_receipt.blocked(), line)
        self.assertIsNone(review_receipt.failure())
        self.assertIsNone(self.stored())

    def test_parse_no_review_types_repeat_only_refusals(self):
        repeat = {"reason": "repeat", "comment": {"path": "a.py", "line": 1}}
        skipped = [repeat, dict(repeat)]
        details = review_receipt.parse_no_review(json.dumps({"action": "no_review", "skipped": skipped}))
        self.assertEqual(details, {"skipped": skipped, "repeat_only": True})
        mixed = [repeat, {"reason": "already_commented_or_resolved", "comment": {"path": "a.py", "line": 1}}]
        self.assertEqual(review_receipt.parse_no_review(
            json.dumps({"action": "no_review", "skipped": mixed}))["repeat_only"], False)
        for text in ("not json", json.dumps({"action": "no_review", "skipped": []}),
                     json.dumps({"action": "no_review"}), json.dumps({"action": "requested_changes", "review_id": 91})):
            with self.subTest(text=text):
                details = review_receipt.parse_no_review(text)
                if text == "not json" or "requested_changes" in text:
                    self.assertIsNone(details)
                else:
                    self.assertEqual(details["repeat_only"], False)

    def test_claude_guard_persists_a_duplicate_only_refusal_unsealed(self):
        command = f"github-interface --request-changes #68 --expected-head {HEAD} --token-user bit-mis"
        receipt_path = Path(self.directory.name) / "receipt.json"
        gate_path = Path(self.directory.name) / "gate"
        gate_path.write_text("")
        reply = json.dumps({"action": "no_review",
                            "skipped": [{"reason": "repeat", "comment": {"path": "a.py", "line": 1}}]})
        with patch.dict(os.environ, {"AGENT_INTERFACE_BASH_ALLOW": json.dumps([command]),
                                     "AGENT_INTERFACE_REVIEW_RECEIPT": str(receipt_path),
                                     "AGENT_INTERFACE_REVIEW_GATE": str(gate_path)}), \
                patch.object(sys, "argv", ["bash_guard.py", command]), \
                patch.object(bash_guard.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=reply, stderr="")), \
                redirect_stdout(io.StringIO()) as out:
            with self.assertRaises(SystemExit) as stopped:
                bash_guard.main()
        self.assertEqual(stopped.exception.code, 0)
        self.assertEqual(out.getvalue(), reply)
        self.assertEqual(json.loads(Path(str(receipt_path) + ".refused").read_text())["action"], "no_review")
        self.assertEqual(gate_path.read_text(), "")
        self.assertFalse(receipt_path.exists())
        review_receipt.bind(api.DB, "run")
        self.assertIsNone(review_receipt.record_file(receipt_path))
        self.assertEqual(review_receipt.refused()["repeat_only"], True)
        self.assertIsNone(review_receipt.failure())
        self.assertIsNone(review_receipt.blocked())
        self.assertIsNone(self.stored())

    def test_accepted_submission_wins_over_a_stale_refusal(self):
        receipt_path = Path(self.directory.name) / "receipt.json"
        Path(str(receipt_path) + ".refused").write_text(json.dumps(
            {"action": "no_review", "skipped": [{"reason": "repeat", "comment": {"path": "a.py", "line": 1}}]}))
        receipt_path.write_text(json.dumps({"action": "requested_changes", "review_id": 91, "head_sha": HEAD}))
        review_receipt.bind(api.DB, "run")
        self.assertEqual(review_receipt.record_file(receipt_path)["review_id"], 91)
        self.assertEqual(review_receipt.refused()["repeat_only"], True)
        self.assertEqual(self.stored(), "91")


class TestRecoveryWithSiblings(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(patch.stopall)
        patch.object(api, "DB", Path(self.directory.name) / "calls.sqlite3").start()
        patch.object(api, "RESPONSES", Path(self.directory.name) / "responses").start()
        patch.object(api, "sleep").start()
        api.init_db()
        self.mod = SimpleNamespace(pr_number=lambda _: "1", repo_name=lambda *_: "o/r", run=Mock())

    def execute(self, runs, checks, behavior="pr_review", model=None):
        steps = iter(runs)

        def dispatch(*args, **kwargs):
            step = next(steps)
            if isinstance(step, BaseException):
                raise step
            return step(*args, **kwargs) if callable(step) else step
        self.mod.run.side_effect = dispatch
        with patch.object(api, "review_facts", side_effect=checks), redirect_stdout(io.StringIO()):
            try:
                api.run_governed_behavior(self.mod, behavior, "https://github.com/o/r/pull/1",
                                          "bit-mis", HEAD, "poise:approve-prs" if behavior == "pr_approve" else "poise:review-new-prs",
                                          uuid4().hex, pwd=self.directory.name, model=model)
            except SystemExit:
                pass
        return api.logs()[-1]

    def test_confirmed_quota_structured_approval_records_failure_without_retry(self):
        submissions = []
        verdict = {"action": "request_changes", "comments": [{"path": "src/main.py", "line": 4, "side": "RIGHT", "body": "[p2] Retained finding."}]}

        def submit(*args, **kwargs):
            def process(command, **options):
                if command[0] == "github-interface":
                    submissions.append(command)
                    return SimpleNamespace(returncode=1, stdout="", stderr=QUOTA_ERROR)
                return SimpleNamespace(returncode=0, stdout=json.dumps({"stopReason": "end_turn", "num_turns": 1,
                                                                       "structuredOutput": verdict}), stderr="")
            with patch.object(ReviewWatch, "run", side_effect=process), patch.object(structured_review.subprocess, "run", side_effect=process):
                return structured_review.run(self.directory.name, "system", "packet", CATALOG.resolve("grok-4.6-xhigh"), "pr_approve",
                                             "https://github.com/o/r/pull/1", "bit-mis", HEAD, 60)
        row = self.execute([submit], [facts(), facts()], behavior="pr_approve", model="grok-4.6-xhigh")
        self.assertEqual(row["error_code"], "review_submission_failed")
        self.assertEqual(row["error"], QUOTA_FAILURE)
        self.assertEqual(row["status"], "failed")
        for field in ("action", "outcome", "review_id"):
            self.assertIsNone(row[field])
        self.assertEqual(len(submissions), 1)
        self.assertIn("--request-changes", submissions[0])
        self.assertEqual(self.mod.run.call_count, 1)

    def test_confirmed_quota_claude_sidecar_is_bounded_redacted_and_reclassified(self):
        command = f"github-interface --request-changes #1 --expected-head {HEAD} --token-user bit-mis"
        path = Path(self.directory.name) / "receipt.json"
        error = QUOTA_ERROR + " credential-marker=private-token " + "\u00e9" * 10_000
        with patch.dict(os.environ, {"AGENT_INTERFACE_BASH_ALLOW": json.dumps([command]), "AGENT_INTERFACE_REVIEW_RECEIPT": str(path)}), \
                patch.object(sys, "argv", ["bash_guard.py", command]), \
                patch.object(bash_guard.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout="", stderr=error)) as submit, \
                redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as stopped:
                bash_guard.main()
        self.assertEqual(stopped.exception.code, 1)
        self.assertEqual(submit.call_count, 1)
        retained = Path(str(path) + ".failure").read_text()
        self.assertEqual(retained, QUOTA_FAILURE)
        self.assertLessEqual(len(retained), 4096)
        self.assertLessEqual(len(retained.encode("utf-8")), 4096)
        self.assertNotIn("credential-marker", retained)
        self.assertNotIn("body=", retained)
        self.assertFalse(path.exists())

        def parent(*args, **kwargs):
            self.assertIsNone(review_receipt.failure())
            self.assertIsNone(review_receipt.record_file(path))
            return "valid verdict; publication failed"
        row = self.execute([parent], [facts(), facts()], behavior="pr_approve")
        self.assertEqual(row["error_code"], "review_submission_failed")
        self.assertEqual(row["error"], QUOTA_FAILURE)
        for field in ("action", "outcome", "review_id"):
            self.assertIsNone(row[field])
        self.assertEqual(self.mod.run.call_count, 1)

    def test_quota_does_not_adopt_sibling_or_pending_reviews(self):
        with sqlite3.connect(api.DB) as conn:
            conn.execute("insert into calls (id, behavior, repo, pr_id, review_id, started_at) values ('sibling', 'pr_review', 'o/r', '1', '91', 0)")

        def failed(*args, **kwargs):
            review_receipt.record_failure(QUOTA_ERROR)
            return "submission failed"
        row = self.execute([failed], [facts(), facts([CHANGES], reviewer_pending_reviews=1)])
        self.assertEqual(row["error_code"], "review_submission_failed")
        self.assertIsNone(row["review_id"])
        self.assertIsNone(row["action"])
        self.assertIsNone(row["outcome"])
        self.assertEqual(self.mod.run.call_count, 1)

    def test_quota_does_not_bypass_unavailable_final_inventory(self):
        def failed(*args, **kwargs):
            review_receipt.record_failure(QUOTA_ERROR)
            return "submission failed"
        row = self.execute([failed], [facts(), RuntimeError("final inventory unavailable")])
        self.assertEqual(row["status"], "failed")
        self.assertIsNone(row["error_code"])
        self.assertIsNone(row["action"])
        self.assertIsNone(row["outcome"])
        self.assertEqual(self.mod.run.call_count, 1)

    def test_github_outage_is_retryable_but_never_claims_no_action(self):
        def failed(*args, **kwargs):
            review_receipt.record_failure("error: GitHub 500:")
            return "valid verdict; submission failed"
        row = self.execute([failed], [facts(), facts()])
        self.assertEqual(row["status"], "failed")
        self.assertEqual(row["error_code"], "review_submission_failed")
        self.assertEqual(row["error"], "error: GitHub 500:")
        self.assertIsNone(row["action"])
        self.assertIsNone(row["outcome"])
        self.assertIsNone(row["review_id"])
        self.assertEqual(self.mod.run.call_count, 1)

    def test_lost_claude_submission_response_holds_without_adopting(self):
        def lost(*args, **kwargs):
            review_receipt.record_failure("error: GitHub 502:")
            return "response lost"
        row = self.execute([lost], [facts(), facts([CLEAN])])
        self.assertEqual(row["status"], "failed")
        self.assertEqual(row["error_code"], api.REVIEW_PUBLICATION_UNCERTAIN_CODE)
        self.assertIn("uncertain", row["error"])
        for field in ("action", "outcome", "review_id", "recovery_model"):
            self.assertIsNone(row[field])
        self.assertEqual(self.mod.run.call_count, 1)

    def test_lost_structured_submission_holds_without_adopting(self):
        def lost(*args, **kwargs):
            raise review_receipt.SubmissionError("error: GitHub 502:")
        row = self.execute([lost], [facts(), facts([CLEAN])])
        self.assertEqual(row["status"], "failed")
        self.assertEqual(row["error_code"], "review_submission_failed")
        self.assertIn("could not prove a safe recovery", row["error"])
        self.assertIn("uncertain", row["error"])
        for field in ("action", "outcome", "review_id", "recovery_model"):
            self.assertIsNone(row[field])
        self.assertEqual(self.mod.run.call_count, 1)

    def test_uncertain_structured_submission_without_a_landed_review_is_never_retried(self):
        row = self.execute([review_receipt.SubmissionError(
            "review submission timed out; publication uncertain, reconcile before retry")],
            [facts(), facts()])
        self.assertEqual(row["status"], "failed")
        self.assertEqual(row["error_code"], "review_submission_failed")
        self.assertIn("uncertain", row["error"])
        for field in ("action", "outcome", "review_id", "recovery_model"):
            self.assertIsNone(row[field])
        self.assertEqual(self.mod.run.call_count, 1)

    def test_deterministic_submission_rejection_is_not_recovered(self):
        row = self.execute([budget.ReviewLimitError(
            "review submission rejected: error: GitHub 422: line not in diff", "review_contract_violation")],
            [facts(), facts()])
        self.assertEqual(row["status"], "failed")
        self.assertEqual(row["error_code"], "review_contract_violation")
        self.assertIn("line not in diff", row["error"])
        self.assertIsNone(row["recovery_model"])
        self.assertEqual(self.mod.run.call_count, 1)

    def test_a_siblings_review_does_not_stop_recovery(self):
        with sqlite3.connect(api.DB) as conn:
            conn.execute("insert into calls (id, behavior, repo, pr_id, review_id, started_at) values ('sibling', 'pr_review', 'o/r', '1', '91', 0)")
        # The primary hit its output limit; the secondary had already posted 91.
        def recovered(*args, **kwargs):
            review_receipt.record(json.dumps({"action": "reviewed_clean", "review_id": 92, "head_sha": HEAD}))
            return "done"
        row = self.execute([budget.ReviewLimitError("output token maximum"), recovered],
                           [facts(), facts([CHANGES]), facts([CHANGES, CLEAN])])
        self.assertEqual([x.kwargs["model"] for x in self.mod.run.call_args_list], ["opus-5-high", "gpt-6-astra-ultra"])
        self.assertEqual(row["outcome"], "clean")
        self.assertEqual(row["review_id"], 92)

    def test_own_receipted_review_is_adopted_instead_of_recovering(self):
        def submitted_then_failed(*args, **kwargs):
            review_receipt.record(json.dumps({"action": "requested_changes", "review_id": 91, "head_sha": HEAD}))
            raise budget.ReviewLimitError("output token maximum")
        row = self.execute([submitted_then_failed], [facts(), facts([CHANGES])])
        self.assertEqual(self.mod.run.call_count, 1)
        self.assertEqual(row["outcome"], "changes_requested")
        self.assertEqual(row["review_id"], 91)

    def test_completed_run_with_only_a_siblings_review_is_a_failure_not_a_verdict(self):
        with sqlite3.connect(api.DB) as conn:
            conn.execute("insert into calls (id, behavior, repo, pr_id, review_id, started_at) values ('sibling', 'pr_review', 'o/r', '1', '91', 0)")
        row = self.execute(["done"], [facts(), facts([CHANGES])])
        self.assertEqual(row["status"], "failed")
        self.assertIn("exactly one", row["error"])
        self.assertIsNone(row["review_id"])


class TestDuplicatePrevention(TestCase):
    """#723: only positive same-call evidence proves a duplicate publication.

    An extra same-account review without that evidence stays unattributed,
    never blamed on this run by elimination."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(patch.stopall)
        patch.object(api, "DB", Path(self.directory.name) / "calls.sqlite3").start()
        patch.object(api, "RESPONSES", Path(self.directory.name) / "responses").start()
        patch.object(api, "sleep").start()
        api.init_db()
        review_receipt.bind(api.DB, "me")
        with sqlite3.connect(api.DB) as conn:
            conn.execute("insert into calls (id, behavior, repo, pr_id, started_at) values ('me', 'pr_review', 'o/r', '1', 0)")

    def test_second_unclaimed_review_with_receipt_is_unattributed(self):
        after = facts([CHANGES, CLEAN])
        result = api.behavior_outcome(object(), "pr_review", "1", "/tmp", "bit-mis", HEAD, facts(), after,
                                      receipt=receipt("reviewed_clean", 92), call_id="me")
        self.assertEqual(result["outcome"], "clean")

    def test_independent_approval_before_and_during_a_receipted_review(self):
        earlier = {"id": 90, "node_id": "PRR_90", "state": "APPROVED", "commit": HEAD,
                   "submitted_at": "2026-09-17T10:04:00Z"}
        after = facts([earlier, CHANGES, APPROVAL])
        result = api.behavior_outcome(object(), "pr_approve", "1", "/tmp", "bit-mis", HEAD,
                                      facts([earlier]), after,
                                      receipt=receipt("approved_pr", 93), call_id="me")
        self.assertEqual(result["outcome"], "approved")

    def test_two_accepted_receipts_by_one_call_are_a_duplicate(self):
        review_receipt.record(json.dumps({"action": "reviewed_clean", "review_id": 91, "head_sha": HEAD}))
        review_receipt.record(json.dumps({"action": "reviewed_clean", "review_id": 92, "head_sha": HEAD}))
        after = facts([CHANGES, CLEAN])
        with self.assertRaises(budget.ReviewLimitError) as raised:
            api.behavior_outcome(object(), "pr_review", "1", "/tmp", "bit-mis", HEAD, facts(), after,
                                 receipt=receipt("reviewed_clean", 92), call_id="me")
        self.assertEqual(raised.exception.code, "review_contract_violation")
        self.assertIn("91 and 92", str(raised.exception))
        # Unrelated work continues: a run without the conflict reconciles.
        review_receipt.bind(api.DB, "other")
        result = api.behavior_outcome(object(), "pr_review", "1", "/tmp", "bit-mis", HEAD, facts(), after,
                                      receipt=receipt("reviewed_clean", 92), call_id="other")
        self.assertEqual(result["outcome"], "clean")

    def test_contradictory_receipts_for_one_review_are_a_violation(self):
        review_receipt.record(json.dumps({"action": "requested_changes", "review_id": 91, "head_sha": HEAD}))
        review_receipt.record(json.dumps({"action": "reviewed_clean", "review_id": 91, "head_sha": HEAD}))
        with self.assertRaisesRegex(budget.ReviewLimitError, "contradictory receipts for review 91"):
            api.behavior_outcome(object(), "pr_review", "1", "/tmp", "bit-mis", HEAD, facts(), facts([CHANGES]),
                                 receipt=receipt("requested_changes", 91), call_id="me")

    def test_receipt_claimed_by_a_sibling_is_a_conflict_not_corroboration(self):
        with sqlite3.connect(api.DB) as conn:
            conn.execute("insert into calls (id, behavior, repo, pr_id, review_id, started_at) values ('sibling', 'pr_review', 'o/r', '1', '92', 0)")
        with self.assertRaisesRegex(budget.ReviewLimitError, "claimed by another run"):
            api.behavior_outcome(object(), "pr_review", "1", "/tmp", "bit-mis", HEAD, facts(), facts([CLEAN]),
                                 receipt=receipt("reviewed_clean", 92), call_id="me")

    def test_receipt_for_another_head_is_rejected(self):
        other = receipt("reviewed_clean", 92)
        other["head_sha"] = "b" * 40
        with self.assertRaisesRegex(RuntimeError, "receipt does not match the expected head"):
            api.behavior_outcome(object(), "pr_review", "1", "/tmp", "bit-mis", HEAD, facts(), facts([CLEAN]),
                                 receipt=other, call_id="me")

    def test_receipted_extra_with_a_transient_failure_holds_as_uncertain(self):
        review_receipt.record_failure("error: GitHub 503:")
        after = facts([CHANGES, CLEAN])
        with self.assertRaises(budget.ReviewLimitError) as raised:
            api.behavior_outcome(object(), "pr_review", "1", "/tmp", "bit-mis", HEAD, facts(), after,
                                 receipt=receipt("reviewed_clean", 92), call_id="me")
        self.assertEqual(raised.exception.code, api.REVIEW_PUBLICATION_UNCERTAIN_CODE)
        self.assertIn("[91]", str(raised.exception))

    def test_receipted_extra_with_a_transport_failure_holds_as_uncertain(self):
        review_receipt.record_failure("Traceback (most recent call last):\nhttpx.ConnectError: boom")
        after = facts([CHANGES, CLEAN])
        with self.assertRaises(budget.ReviewLimitError) as raised:
            api.behavior_outcome(object(), "pr_review", "1", "/tmp", "bit-mis", HEAD, facts(), after,
                                 receipt=receipt("reviewed_clean", 92), call_id="me")
        self.assertEqual(raised.exception.code, api.REVIEW_PUBLICATION_UNCERTAIN_CODE)
        self.assertIn("[91]", str(raised.exception))

    def test_sibling_claim_after_the_grace_cannot_settle_the_wrong_call(self):
        with sqlite3.connect(api.DB) as conn:
            conn.execute("insert into calls (id, behavior, repo, pr_id, started_at) values ('sibling', 'pr_review', 'o/r', '1', 0)")
        with self.assertRaises(budget.ReviewLimitError) as raised:
            api.behavior_outcome(object(), "pr_review", "1", "/tmp", "bit-mis", HEAD, facts(), facts([CHANGES]),
                                 call_id="me")
        self.assertEqual(raised.exception.code, api.REVIEW_PUBLICATION_UNCERTAIN_CODE)
        with sqlite3.connect(api.DB) as conn:
            conn.execute("update calls set review_id='91' where id='sibling'")
        with self.assertRaisesRegex(RuntimeError, "exactly one"):
            api.behavior_outcome(object(), "pr_review", "1", "/tmp", "bit-mis", HEAD, facts(), facts([CHANGES]),
                                 call_id="me")

    def test_sibling_claimed_extra_review_is_not_a_duplicate(self):
        with sqlite3.connect(api.DB) as conn:
            conn.execute("insert into calls (id, behavior, repo, pr_id, review_id, started_at) values ('sibling', 'pr_review', 'o/r', '1', '91', 0)")
        after = facts([CHANGES, CLEAN])
        result = api.behavior_outcome(object(), "pr_review", "1", "/tmp", "bit-mis", HEAD, facts(), after,
                                      receipt=receipt("reviewed_clean", 92), call_id="me")
        self.assertEqual(result["outcome"], "clean")

    def test_failed_recovery_does_not_adopt_a_siblings_review(self):
        with sqlite3.connect(api.DB) as conn:
            conn.execute("insert into calls (id, behavior, repo, pr_id, review_id, started_at) values ('sibling', 'pr_review', 'o/r', '1', '92', 0)")
        mod = SimpleNamespace(pr_number=lambda _: "1", repo_name=lambda *_: "o/r", run=Mock())
        steps = iter([budget.ReviewLimitError("output token maximum"),
                      budget.ReviewLimitError("review behavior must produce exactly one atomic clean or change-request review",
                                              "review_contract_violation")])

        def dispatch(*args, **kwargs):
            step = next(steps)
            if isinstance(step, BaseException):
                raise step
            return step
        mod.run.side_effect = dispatch
        with patch.object(api, "review_facts", side_effect=[facts(), facts(), facts([CLEAN])]), \
                redirect_stdout(io.StringIO()):
            try:
                api.run_governed_behavior(mod, "pr_review", "https://github.com/o/r/pull/1", "bit-mis", HEAD,
                                          "poise:review-new-prs", uuid4().hex, pwd=self.directory.name)
            except SystemExit:
                pass
        row = api.logs()[-1]
        self.assertEqual(row["status"], "failed")
        self.assertEqual(row["error_code"], "review_recovery_failed")
        self.assertIsNone(row["review_id"])
        self.assertIsNone(row["action"])

    def test_bash_guard_blocks_a_second_terminal_submission(self):
        import sys as _sys
        gate = Path(self.directory.name) / "gate.lock"
        gate.touch()
        path = str(Path(self.directory.name) / "receipt.json")
        reply = json.dumps({"action": "reviewed_clean", "review_id": 92, "head_sha": HEAD})
        command = "github-interface --reviewed-clean #1 --expected-head a --token-user bit-mis"
        env = {"AGENT_INTERFACE_BASH_ALLOW": json.dumps(["github-interface *"]),
               "AGENT_INTERFACE_REVIEW_GATE": str(gate), "AGENT_INTERFACE_REVIEW_RECEIPT": path}
        with patch.dict("os.environ", env), \
                patch.object(_sys, "argv", ["bash_guard.py", command]), \
                patch.object(bash_guard.subprocess, "run",
                             return_value=SimpleNamespace(returncode=0, stdout=reply, stderr="")):
            with self.assertRaises(SystemExit) as first:
                bash_guard.main()
            self.assertEqual(first.exception.code, 0)
            with self.assertRaisesRegex(RuntimeError, "duplicate submission blocked"):
                bash_guard.main()
        self.assertEqual(json.loads(Path(path).read_text())["review_id"], 92)

    def test_finish_is_first_writer_wins(self):
        call_id = api.track("opus-5-high", "", "1", "o/r", "bit-mis", "pr_review")
        first = api.finish(call_id, "failed", error="Stopped by user", error_code="stopped")
        with redirect_stderr(io.StringIO()):
            second = api.finish(call_id, "completed", response="late", outcome="clean", action="reviewed_clean")
        self.assertEqual(first, second)
        row = [entry for entry in api.logs() if entry["id"] == call_id][0]
        self.assertEqual(row["status"], "failed")
        self.assertEqual(row["error_code"], "stopped")
        self.assertIsNone(row["outcome"])

    def test_recent_uncertain_sibling_run_is_never_blamed_on_this_run(self):
        with sqlite3.connect(api.DB) as conn:
            conn.execute("update calls set actor = 'bit-mis' where id = 'me'")
            conn.execute("insert into calls (id, behavior, repo, pr_id, actor, status, error_code, started_at, ended_at)"
                         " values ('sibling', 'pr_review', 'o/r', '1', 'BIT-MIS', 'failed', 'review_submission_failed', 50, 100)")
        after = facts([CHANGES, CLEAN])
        result = api.behavior_outcome(object(), "pr_review", "1", "/tmp", "bit-mis", HEAD, facts(), after,
                                      receipt=receipt("reviewed_clean", 92), call_id="me")
        self.assertEqual(result["outcome"], "clean")

    def test_running_sibling_run_is_never_blamed_on_this_run(self):
        with sqlite3.connect(api.DB) as conn:
            conn.execute("update calls set actor = 'bit-mis' where id = 'me'")
            conn.execute("insert into calls (id, behavior, repo, pr_id, actor, status, started_at)"
                         " values ('sibling', 'pr_review', 'o/r', '1', 'BIT-MIS', 'running', 50)")
        after = facts([CHANGES, CLEAN])
        result = api.behavior_outcome(object(), "pr_review", "1", "/tmp", "bit-mis", HEAD, facts(), after,
                                      receipt=receipt("reviewed_clean", 92), call_id="me")
        self.assertEqual(result["outcome"], "clean")

    def test_extra_review_is_unattributed_whatever_the_sibling_state(self):
        after = facts([CHANGES, CLEAN])
        siblings = [
            ("other-reviewer", "running"), (None, "failed"),
            ("bit-mis", "running"), ("bit-mis", "failed"),
        ]
        for actor, status in siblings:
            with self.subTest(actor=actor, status=status):
                with sqlite3.connect(api.DB) as conn:
                    conn.execute("update calls set actor = 'bit-mis' where id = 'me'")
                    conn.execute("insert or replace into calls "
                                 "(id, behavior, repo, pr_id, actor, status, error_code, started_at, ended_at) "
                                 "values ('sibling', 'pr_review', 'o/r', '1', ?, ?, 'review_submission_failed', 50, 100)",
                                 (actor, status))
                result = api.behavior_outcome(object(), "pr_review", "1", "/tmp", "bit-mis", HEAD, facts(), after,
                                              receipt=receipt("reviewed_clean", 92), call_id="me")
                self.assertEqual(result["outcome"], "clean")
