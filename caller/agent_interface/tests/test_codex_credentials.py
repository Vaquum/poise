"""Rotated Codex credentials survive isolated Caller runs.

Covers autonomio/poise#1797: a later file group, inspection round or Call
must never overwrite a refreshed credential with the older copy, and a
rotation propagates back to the originating sign-in without clobbering a
newer external sign-in. Every credential here is a canary in an isolated
temporary home; the developer's real ~/.codex is never touched.
"""
import fcntl
import json
import os
import sys
import tempfile
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from agent_interface import atomic_work, issue_review, structured_review
from agent_interface.model_catalog import CATALOG
from agent_interface.review_watch import ReviewWatch

CANARY_A = '{"auth_mode":"chatgpt","tokens":{"refresh_token":"codex-canary-refresh-A"}}'
CANARY_B = '{"auth_mode":"chatgpt","tokens":{"refresh_token":"codex-canary-refresh-B"}}'
CANARY_C = '{"auth_mode":"chatgpt","tokens":{"refresh_token":"codex-canary-refresh-C"}}'
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
            self.assertEqual((original / "auth.json").read_text(), CANARY_B)
            self.assertEqual((original / "auth.json").stat().st_mode & 0o777, 0o600)
            self.assertNotIn("codex-canary", result)

    def test_sequential_calls_converge_on_the_propagated_credential(self):
        packet = json.dumps({"coverage": "complete", "files": [{"filename": "src/main.py"}],
                             "diff": "diff --git a/src/main.py b/src/main.py\n--- a/src/main.py\n+++ b/src/main.py\n@@ -4 +4 @@\n-old\n+new\n"})
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            original = tmp / "home" / ".codex"
            original.mkdir(parents=True)
            (original / "auth.json").write_text(CANARY_A)
            log = tmp / "sightings.log"
            with patch.dict(os.environ, self.fake_env(original, write_fake_codex(tmp), log)):
                first, _ = self.run_review(tmp, packet)
                second, _ = self.run_review(tmp, packet)
            self.assertIn('"review_id": 91', first)
            self.assertIn('"review_id": 91', second)
            self.assertEqual(log.read_text().split(), ["saw:A", "saw:B"])
            self.assertEqual((original / "auth.json").read_text(), CANARY_B)
            self.assertNotIn("codex-canary", second)

    def test_concurrent_winner_propagates_while_loser_raises_without_overwriting(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            original = tmp / "home" / ".codex"
            original.mkdir(parents=True)
            (original / "auth.json").write_text(CANARY_A)
            server = tmp / "server"
            server.write_text(CANARY_A)
            barrier = threading.Barrier(2)

            def fake_run(command, *, input, cwd, timeout, env, provider):
                barrier.wait(timeout=30)
                home = Path(env["CODEX_HOME"])
                with open(server, "r+") as handle:
                    fcntl.flock(handle, fcntl.LOCK_EX)
                    try:
                        current = handle.read()
                        seen = (home / "auth.json").read_text()
                        if seen != current:
                            return SimpleNamespace(
                                returncode=1,
                                stdout=json.dumps({"type": "turn.failed", "message": REUSE_MESSAGE}),
                                stderr=REUSE_MESSAGE + "\n")
                        (home / "auth.json").write_text(CANARY_B)
                        handle.seek(0)
                        handle.write(CANARY_B)
                        handle.truncate()
                    finally:
                        fcntl.flock(handle, fcntl.LOCK_UN)
                out = Path(command[command.index("--output-last-message") + 1])
                out.write_text('{"ok":true}')
                return SimpleNamespace(
                    returncode=0,
                    stdout=json.dumps({"type": "thread.started", "thread_id": THREAD}),
                    stderr="")

            watch = SimpleNamespace(run=fake_run)
            model = CATALOG.resolve("gpt-6-astra-max")
            roots = [tmp / "run-first", tmp / "run-second"]
            for root in roots:
                root.mkdir()
            results = {}

            def attempt(name, root):
                try:
                    results[name] = ("ok", structured_review.ask_codex(
                        root, model, "system", "packet", {}, watch, 60))
                except Exception as error:
                    # The race loser lands here; the assertions below tell a
                    # reuse rejection from an unexpected thread failure.
                    results[name] = ("error", error)
                finally:
                    # _review_once does this after every provider run.
                    structured_review.codex_propagate(root)

            with patch.dict(os.environ, {"CODEX_HOME": str(original)}):
                threads = [threading.Thread(target=attempt, args=(name, root))
                           for name, root in zip(("first", "second"), roots)]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join(timeout=60)
                    self.assertFalse(thread.is_alive())
            self.assertEqual(set(results), {"first", "second"})
            kinds = sorted(kind for kind, _ in results.values())
            self.assertEqual(kinds, ["error", "ok"])
            ok = next(value for kind, value in results.values() if kind == "ok")
            error = next(value for kind, value in results.values() if kind == "error")
            self.assertEqual(ok, '{"ok":true}')
            self.assertIn("already used", str(error))
            self.assertNotIn("codex-canary", str(error))
            self.assertEqual((original / "auth.json").read_text(), CANARY_B)

    def test_newer_external_sign_in_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            original = tmp / "home" / ".codex"
            original.mkdir(parents=True)
            (original / "auth.json").write_text(CANARY_A)
            with patch.dict(os.environ, {"CODEX_HOME": str(original)}):
                root = tmp / "review"
                root.mkdir()
                structured_review.codex_environment(root)
                (original / "auth.json").write_text(CANARY_C)
                (original / "auth.json").chmod(0o600)
                (root / "codex-home" / "auth.json").write_text(CANARY_B)
                structured_review.codex_propagate(root)
                self.assertEqual((original / "auth.json").read_text(), CANARY_C)
                self.assertEqual((original / "auth.json").stat().st_mode & 0o777, 0o600)
                followup = tmp / "followup"
                followup.mkdir()
                structured_review.codex_environment(followup)
                self.assertEqual((followup / "codex-home" / "auth.json").read_text(), CANARY_C)

    def test_propagation_leaves_fresh_state_alone(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            original = tmp / "home" / ".codex"
            original.mkdir(parents=True)
            (original / "auth.json").write_text(CANARY_A)
            with patch.dict(os.environ, {"CODEX_HOME": str(original)}):
                # No rotation: nothing is written and no lock is even taken.
                root = tmp / "fresh"
                root.mkdir()
                structured_review.codex_environment(root)
                before = (original / "auth.json").read_bytes()
                structured_review.codex_propagate(root)
                self.assertEqual((original / "auth.json").read_bytes(), before)
                self.assertFalse((original / "auth.json.lock").exists())
                # Nothing was copied in: no-op, no error.
                bare = tmp / "bare"
                bare.mkdir()
                structured_review.codex_propagate(bare)

    def test_propagation_skips_symlinked_and_deleted_originals(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            original = tmp / "home" / ".codex"
            original.mkdir(parents=True)
            (original / "auth.json").write_text(CANARY_A)
            with patch.dict(os.environ, {"CODEX_HOME": str(original)}):
                # A managed symlink is never severed by the atomic rename.
                linked = tmp / "linked"
                linked.mkdir()
                structured_review.codex_environment(linked)
                managed = tmp / "managed.json"
                managed.write_text(CANARY_C)
                (original / "auth.json").unlink()
                (original / "auth.json").symlink_to(managed)
                (linked / "codex-home" / "auth.json").write_text(CANARY_B)
                structured_review.codex_propagate(linked)
                self.assertTrue((original / "auth.json").is_symlink())
                self.assertEqual(managed.read_text(), CANARY_C)
                # A deleted original is a logout, not an invitation to resurrect.
                (original / "auth.json").unlink()
                (original / "auth.json").write_text(CANARY_A)
                gone = tmp / "gone"
                gone.mkdir()
                structured_review.codex_environment(gone)
                (original / "auth.json").unlink()
                (gone / "codex-home" / "auth.json").write_text(CANARY_B)
                structured_review.codex_propagate(gone)
                self.assertFalse((original / "auth.json").exists())

    def test_propagation_skips_when_the_commit_lock_is_held(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            original = tmp / "home" / ".codex"
            original.mkdir(parents=True)
            (original / "auth.json").write_text(CANARY_A)
            with patch.dict(os.environ, {"CODEX_HOME": str(original)}):
                root = tmp / "review"
                root.mkdir()
                structured_review.codex_environment(root)
                (root / "codex-home" / "auth.json").write_text(CANARY_B)
                with open(original / "auth.json.lock", "w") as held:
                    fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    try:
                        with patch.object(structured_review, "CODEX_COMMIT_WAIT_SECONDS", 0.2):
                            structured_review.codex_propagate(root)
                    finally:
                        fcntl.flock(held, fcntl.LOCK_UN)
                self.assertEqual((original / "auth.json").read_text(), CANARY_A)

    def test_issue_review_propagates_an_ephemeral_rotation(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            original = tmp / "home" / ".codex"
            original.mkdir(parents=True)
            (original / "auth.json").write_text(CANARY_A)
            work = tmp / "work"
            data = {"issue": {"issue": "o/r#7", "state": "open"}, "sub_issues": []}

            def checkout(*args, **kwargs):
                return {"branch": "main", "head_sha": "b" * 40}

            def rotated_provider(args, *, input, cwd, timeout, env, provider, cleanup_root=None):
                (Path(env["CODEX_HOME"]) / "auth.json").write_text(CANARY_B)
                (work / "review.json").write_text(json.dumps(
                    {"comments": [{"issue": "o/r#7", "body": "fine"}]}))
                return SimpleNamespace(returncode=0, stdout="", stderr="")

            with patch.dict(os.environ, {"CODEX_HOME": str(original)}), \
                    patch.object(issue_review, "interface", side_effect=checkout), \
                    patch.object(issue_review, "supervise", side_effect=rotated_provider):
                posts, ignored = issue_review.review(
                    CATALOG.resolve("gpt-6-astra-max"), "o/r", 7, data, "bit-mis", "", work)
            self.assertEqual(posts, [{"issue": "o/r#7", "body": "fine"}])
            self.assertEqual(ignored, [])
            self.assertEqual((original / "auth.json").read_text(), CANARY_B)

    def test_atomic_work_propagates_an_ephemeral_rotation(self):
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            original = tmp / "home" / ".codex"
            original.mkdir(parents=True)
            (original / "auth.json").write_text(CANARY_A)
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

            def rotated_provider(lease, args, *, input, cwd, timeout, env, provider):
                (Path(env["CODEX_HOME"]) / "auth.json").write_text(CANARY_B)
                (work / "publication.json").write_text(json.dumps(publication))
                return SimpleNamespace(returncode=0, stdout="", stderr="")

            with patch.dict(os.environ, {"CODEX_HOME": str(original)}), \
                    patch.object(atomic_work.issue_review, "packet",
                                 lambda *args: {"issue": {"state": "open"}}), \
                    patch.object(atomic_work.issue_review, "interface", side_effect=interface), \
                    patch.object(atomic_work.issue_review, "_cwd_pids", lambda *args, **kwargs: []), \
                    patch.object(atomic_work.checkout_lock, "run_gated", side_effect=rotated_provider):
                result = atomic_work.run(CATALOG.resolve("gpt-6-astra-max"), "example/repo", 7,
                                         "fix/rotation", "author", work, "c" * 32,
                                         lambda receipt: None)
            self.assertEqual(result, {"outcome": "published"})
            self.assertEqual((original / "auth.json").read_text(), CANARY_B)
