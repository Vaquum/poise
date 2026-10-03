"""Stop obsolete PR analysis without interrupting a GitHub submission."""
from __future__ import annotations

import json
import os
import signal
import subprocess
import tempfile
from pathlib import Path
from time import monotonic, sleep
from threading import current_thread, main_thread

from . import atoms, progress, review_budget, review_receipt
from .review_gate import cancel_when_idle, submission_active
from .provider_progress import ProviderStream

PROGRESS_SECONDS = 1
POLL_SECONDS = 30
HEAD_TIMEOUT_SECONDS = 10
STOP_GRACE_SECONDS = 2


class ReviewSuperseded(RuntimeError):
    def __init__(self, head_sha: str):
        self.head_sha = atoms.expected_head(head_sha)
        super().__init__(f"Review stopped early: PR head changed to {self.head_sha}")


class ReviewWatch:
    def __init__(self, pwd: str, pr: str, actor: str, head: str):
        self.pwd = pwd
        self.number = int(atoms.pr_number(pr))
        self.repo = atoms.repo_name(pr, pwd)
        self.actor = atoms.actor(actor)
        self.head = atoms.expected_head(head)

    def __enter__(self):
        self.directory = tempfile.TemporaryDirectory(prefix="agent-interface-review-watch-")
        self.gate_path = str(Path(self.directory.name) / "submission.lock")
        Path(self.gate_path).touch(mode=0o600)
        self.receipt_path = str(Path(self.directory.name) / "receipt.json")
        return self

    def __exit__(self, *exc):
        self.directory.cleanup()

    def changed_head(self, timeout: float) -> str | None:
        try:
            done = subprocess.run(
                [os.getenv("GITHUB_INTERFACE_CLI", "github-interface"), "--head-sha",
                 f"https://github.com/{self.repo}/pull/{self.number}", "--token-user", self.actor],
                cwd=self.pwd, text=True, capture_output=True, timeout=timeout,
            )
            if done.returncode:
                return None
            fact = json.loads(done.stdout)
            if (not isinstance(fact, dict) or fact.get("action") != "head_sha"
                    or fact.get("repository") != self.repo
                    or type(fact.get("pull_number")) is not int
                    or fact["pull_number"] != self.number):
                return None
            head = fact.get("head_sha")
            if not isinstance(head, str) or not atoms.SHA_RE.fullmatch(head):
                return None
            return head if head != self.head else None
        except (OSError, ValueError, subprocess.TimeoutExpired):
            # An unavailable/malformed check proves nothing. Keep the review;
            # the existing expected-head guard still protects its terminal call.
            return None

    def run(self, args, *, input: str, cwd: str, timeout: float, env: dict, provider: str | None = None) -> subprocess.CompletedProcess:
        deadline = monotonic() + timeout
        next_head_check = monotonic() + POLL_SECONDS
        events = ProviderStream(provider)
        progress.stage("waiting_provider", "Waiting for provider", timeout=timeout)
        # Files avoid pipe backpressure while the supervisor checks GitHub.
        with tempfile.TemporaryFile(mode="w+t") as stdin, \
                tempfile.TemporaryFile(mode="w+t") as stdout, \
                tempfile.TemporaryFile(mode="w+t") as stderr:
            stdin.write(input)
            stdin.seek(0)
            process = subprocess.Popen(
                args, stdin=stdin, stdout=stdout, stderr=stderr, cwd=cwd,
                env=env, text=True, start_new_session=True,
            )
            completed = False
            previous_sigterm = None
            if current_thread() is main_thread():
                previous_sigterm = signal.signal(signal.SIGTERM, _interrupted)
            try:
                while True:
                    events.read(stdout)
                    review_receipt.record_file(self.receipt_path)
                    if provider:
                        try:
                            if submission_active(self.gate_path):
                                progress.stage("submitting", "GitHub command in progress", timeout=max(0, deadline - monotonic()))
                        except OSError:
                            progress.warning()
                    if process.poll() is not None:
                        events.read(stdout, final=True)
                        review_receipt.record_file(self.receipt_path)
                        stdout.seek(0)
                        stderr.seek(0)
                        completed = True
                        # Revoke future submissions before recovery can start.
                        # An active submission is ambiguous and must be held.
                        if process.returncode and not cancel_when_idle(self.gate_path):
                            raise review_budget.ReviewLimitError(
                                "Provider exited during a GitHub submission; needs reconciliation",
                                "review_recovery_failed")
                        return subprocess.CompletedProcess(args, process.returncode, stdout.read(), stderr.read())
                    remaining = deadline - monotonic()
                    if remaining <= 0:
                        raise subprocess.TimeoutExpired(args, timeout)
                    try:
                        process.wait(timeout=min(PROGRESS_SECONDS, max(0.001, next_head_check - monotonic()), remaining))
                    except subprocess.TimeoutExpired:
                        remaining = deadline - monotonic()
                        if remaining <= 0:
                            continue
                        if monotonic() < next_head_check:
                            continue
                        changed = self.changed_head(min(HEAD_TIMEOUT_SECONDS, remaining))
                        next_head_check = monotonic() + POLL_SECONDS
                        # Completion wins a race with a slow head lookup.
                        if process.poll() is not None:
                            continue
                        if changed and cancel_when_idle(self.gate_path):
                            raise ReviewSuperseded(changed)
            finally:
                try:
                    if not completed:
                        _stop_process_group(process)
                finally:
                    if previous_sigterm is not None:
                        signal.signal(signal.SIGTERM, previous_sigterm)


def _interrupted(signum, _frame):
    raise SystemExit(128 + signum)


def _stop_process_group(process: subprocess.Popen) -> None:
    try:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        # Keep the leader unreaped until the final group signal, so its PID
        # cannot be reused for an unrelated process group during the grace.
        sleep(STOP_GRACE_SECONDS)
    finally:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except PermissionError:
            # macOS can report EPERM for a group containing only the unreaped
            # leader. Accept that only when the leader has actually exited.
            process.wait(timeout=0)
        process.wait()
