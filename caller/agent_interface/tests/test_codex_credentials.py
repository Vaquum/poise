"""Rotated Codex credentials survive one isolated Caller run.

Covers autonomio/poise#1797 (intra-run scope): a later file group,
inspection round or fragment must never overwrite this run's refreshed
credential with the older copy. Caller never writes the isolated file
back: it is worker-writable and same-account forged JSON is
indistinguishable from a genuine rotation, so cross-Call persistence
stays explicitly unresolved. Every credential here is a canary in an
isolated temporary home; the developer's real ~/.codex is never touched.
"""
import json
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from agent_interface import atomic_work, issue_review, structured_review
from agent_interface.model_catalog import CATALOG
from agent_interface.review_watch import ReviewWatch

CANARY_A = ('{"auth_mode":"chatgpt","tokens":{"refresh_token":"codex-canary-refresh-A",'
            '"account_id":"codex-canary-acct-1","login_owner_id":"codex-canary-login-1"}}')
CANARY_B = ('{"auth_mode":"chatgpt","tokens":{"refresh_token":"codex-canary-refresh-B",'
            '"account_id":"codex-canary-acct-1","login_owner_id":"codex-canary-login-1"}}')
CANARY_FORGED = ('{"auth_mode":"chatgpt","tokens":{"refresh_token":"codex-canary-refresh-FORGED",'
                 '"account_id":"codex-canary-acct-1","login_owner_id":"codex-canary-login-1"}}')
THREAD = "01234567-89ab-4cde-8123-456789abcdef"
REUSE_MESSAGE = ("Your access token could not be refreshed because your refresh "
                 "token was already used. Please log out and sign in again.")
ASSESSMENT = {"verdict": "The changed validation paths have no remaining blocking defects.",
              "reviewed_context": "Inspected the supplied immutable diff and its affected callers.",
              "limitations": "Provider fixture; no application test execution."}
VERDICT = {"action": "reviewed_clean", "comments": [], "assessment": ASSESSMENT}


def staged_packet(paths):
    diff = "\n".join(
        f"diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -1 +1 @@\n-old\n+new"
        for path in paths)
    return json.dumps({"action": "read", "repository": "o/r", "pull_number": 12, "head_sha": "a" * 40,
                       "diff": diff, "files": [{"filename": path, "status": "modified",
                                                "old_mode": "100644", "new_mode": "100644"} for path in paths],
                       "coverage": "complete", "excluded_files": [], "review_scope": "Review the complete retained diff."},
                      separators=(",", ":"))


def write_fake_codex(directory: Path) -> Path:
    """A codex CLI that rotates A to B once, then rejects a re-sight of A.

    Records each sighting as a label, never credential contents, in the
    FAKE_CODEX_LOG file.
    """
    script = directory / "codex"
    script.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys\n"
        "from pathlib import Path\n"
        "home = Path(os.environ['CODEX_HOME'])\n"
        "auth = home / 'auth.json'\n"
        "seen = auth.read_text()\n"
        "expected_a, rotated_b = os.environ['FAKE_CODEX_A'], os.environ['FAKE_CODEX_B']\n"
        "with open(os.environ['FAKE_CODEX_LOG'], 'a') as log:\n"
        "    log.write(('saw:A' if seen == expected_a else 'saw:B' if seen == rotated_b else 'saw:other') + '\\n')\n"
        "marker = home / '.fake-rotated'\n"
        "if seen == expected_a and not marker.exists():\n"
        "    auth.write_text(rotated_b)\n"
        "    marker.touch()\n"
        "elif seen == expected_a:\n"
        "    sys.stdout.write(json.dumps({'type': 'turn.failed', 'message': os.environ['FAKE_CODEX_REUSE']}) + '\\n')\n"
        "    sys.stderr.write(os.environ['FAKE_CODEX_REUSE'] + '\\n')\n"
        "    sys.exit(1)\n"
        "elif seen != rotated_b:\n"
        "    sys.stderr.write('fake codex: unexpected isolated credential\\n')\n"
        "    sys.exit(2)\n"
        "argv = sys.argv[1:]\n"
        "out = Path(argv[argv.index('--output-last-message') + 1])\n"
        "out.write_text(os.environ['FAKE_CODEX_VERDICT'])\n"
        "sys.stdout.write(json.dumps({'type': 'thread.started', 'thread_id': os.environ['FAKE_CODEX_THREAD']}) + '\\n')\n"
    )
    script.chmod(0o700)
    return script


class TestCodexCredentialPreservation(TestCase):
    def run_review(self, directory, packet, *, behavior="pr_review"):
        calls = []

        def submit(args, **kwargs):
            calls.append(args)
            action = {"--request-changes": "requested_changes", "--reviewed-clean": "reviewed_clean",
                      "--approve-pr": "approved_pr"}[args[1]]
            return SimpleNamespace(returncode=0, stdout=json.dumps(
                {"action": action, "review_id": 91, "head_sha": "a" * 40}), stderr="")

        text = f"policy\n\nPR packet:\n{packet}\n\nAllowed:\nnone"
        with patch.object(structured_review.subprocess, "run", side_effect=submit), \
                patch.object(ReviewWatch, "check_closed", lambda self: None):
            result = structured_review.run(str(directory), "system", text, CATALOG.resolve("gpt-6-astra-ultra"),
                                           behavior, "https://github.com/o/r/pull/12", "bit-mis",
                                           "a" * 40, 60, packet=packet)
        return result, calls

    def fake_env(self, original: Path, fake: Path, log: Path) -> dict:
        return {"CODEX_HOME": str(original), "CODEX_CLI": str(fake),
                "FAKE_CODEX_A": CANARY_A, "FAKE_CODEX_B": CANARY_B,
                "FAKE_CODEX_REUSE": REUSE_MESSAGE, "FAKE_CODEX_VERDICT": json.dumps(VERDICT),
                "FAKE_CODEX_THREAD": THREAD, "FAKE_CODEX_LOG": str(log)}

    def test_second_group_keeps_the_rotated_credential(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            original = tmp / "home" / ".codex"
            original.mkdir(parents=True)
            (original / "auth.json").write_text(CANARY_A)
            (original / "auth.json").chmod(0o600)
            log = tmp / "sightings.log"
            packet = staged_packet([f"src/f{i:02d}.py" for i in range(9)])
            with patch.dict(os.environ, self.fake_env(original, write_fake_codex(tmp), log)):
                result, calls = self.run_review(tmp, packet)
            self.assertIn('"review_id": 91', result)
            self.assertEqual(calls[-1][1], "--reviewed-clean")
            self.assertEqual(log.read_text().split(), ["saw:A", "saw:B"])
            # The run keeps its rotation; the originating sign-in is never
            # written back (cross-Call persistence is explicitly unresolved).
            self.assertEqual((original / "auth.json").read_text(), CANARY_A)
            self.assertEqual((original / "auth.json").stat().st_mode & 0o777, 0o600)
            self.assertNotIn("codex-canary", result)

    def test_same_account_forged_isolated_output_never_touches_the_sign_in(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            original = tmp / "home" / ".codex"
            original.mkdir(parents=True)
            (original / "auth.json").write_text(CANARY_A)
            (original / "auth.json").chmod(0o600)
            work = tmp / "work"
            data = {"issue": {"issue": "o/r#7", "state": "open"}, "sub_issues": []}

            def checkout(*args, **kwargs):
                return {"branch": "main", "head_sha": "b" * 40}

            def forged_provider(args, *, input, cwd, timeout, env, provider, cleanup_root=None):
                # A danger-full-access worker writing same-account forged
                # JSON: valid shape, same login identifiers, forged tokens.
                (Path(env["CODEX_HOME"]) / "auth.json").write_text(CANARY_FORGED)
                (work / "review.json").write_text(json.dumps(
                    {"comments": [{"issue": "o/r#7", "body": "fine"}]}))
                return SimpleNamespace(returncode=0, stdout="", stderr="")

            with patch.dict(os.environ, {"CODEX_HOME": str(original)}), \
                    patch.object(issue_review, "interface", side_effect=checkout), \
                    patch.object(issue_review, "supervise", side_effect=forged_provider):
                posts, ignored = issue_review.review(
                    CATALOG.resolve("gpt-6-astra-max"), "o/r", 7, data, "bit-mis", "", work)
            self.assertEqual(posts, [{"issue": "o/r#7", "body": "fine"}])
            self.assertEqual(ignored, [])
            self.assertEqual((work / "codex-home" / "auth.json").read_text(), CANARY_FORGED)
            self.assertEqual((original / "auth.json").read_text(), CANARY_A)
            self.assertEqual((original / "auth.json").stat().st_mode & 0o777, 0o600)

    def test_atomic_work_leaves_the_sign_in_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            original = tmp / "home" / ".codex"
            original.mkdir(parents=True)
            (original / "auth.json").write_text(CANARY_A)
            (original / "auth.json").chmod(0o600)
            work = tmp / "work"
            work.mkdir()
            publication = {"commitMessage": "fix: rotate", "title": "fix: rotate",
                           "body": "rotation", "replies": [], "blocked": None}

            def interface(*args, **kwargs):
                mode = args[args.index("--mode") + 1]
                if mode == "prepare":
                    (work / "repo").mkdir(exist_ok=True)
                    return {"outcome": "prepared", "checkout_head": "b" * 40}
                if mode == "validate":
                    return {"outcome": "validated"}
                return {"outcome": "published"}

            def forged_provider(lease, args, *, input, cwd, timeout, env, provider):
                (Path(env["CODEX_HOME"]) / "auth.json").write_text(CANARY_FORGED)
                (work / "publication.json").write_text(json.dumps(publication))
                return SimpleNamespace(returncode=0, stdout="", stderr="")

            with patch.dict(os.environ, {"CODEX_HOME": str(original)}), \
                    patch.object(atomic_work.issue_review, "packet",
                                 lambda *args: {"issue": {"state": "open"}}), \
                    patch.object(atomic_work.issue_review, "interface", side_effect=interface), \
                    patch.object(atomic_work.issue_review, "_cwd_pids", lambda *args, **kwargs: []), \
                    patch.object(atomic_work.checkout_lock, "run_gated", side_effect=forged_provider):
                result = atomic_work.run(CATALOG.resolve("gpt-6-astra-max"), "example/repo", 7,
                                         "fix/rotation", "author", work, "c" * 32,
                                         lambda receipt: None)
            self.assertEqual(result, {"outcome": "published"})
            self.assertEqual((work / "codex-home" / "auth.json").read_text(), CANARY_FORGED)
            self.assertEqual((original / "auth.json").read_text(), CANARY_A)
            self.assertEqual((original / "auth.json").stat().st_mode & 0o777, 0o600)
