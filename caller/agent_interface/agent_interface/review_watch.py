"""Stop obsolete PR analysis without interrupting a GitHub submission."""
from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import tempfile
from pathlib import Path
from time import monotonic, sleep
from threading import current_thread, main_thread

from . import atoms, progress, review_budget, review_receipt
from .review_gate import cancel_when_idle, submission_active
from .provider_progress import ProviderStream, READ_BYTES

PROGRESS_SECONDS = 1
POLL_SECONDS = 30
HEAD_TIMEOUT_SECONDS = 10
STOP_GRACE_SECONDS = 2
# A provider CLI stuck in its own reconnect loop (codex retries a 429 for
# twenty minutes) hands off after a minute of nothing but stall signals,
# so Poise can move the run to the next slot on budget instead.
RATE_LIMIT_ABORT_SECONDS = 60
_RATE_LIMIT_WORDS = (
    b"rate limit",
    b"rate_limit",
    b"rate-limit",
)
# A bare mention ("mind the rate_limit window") is assistant prose, not a
# throttle event: provider diagnostics say what they are doing about it.
_THROTTLE_COMPANIONS = (
    b"retry",
    b"retries",
    b"reconnect",
    b"backoff",
    b"waiting",
    b"attempt",
    b"exceed",
    b"throttl",
    b"cooldown",
    b"429",
)
# A reconnect loop without quota evidence is a transport stall, not proof
# of a 429: codex prints the same "Reconnecting... n/m" lines for an idle
# WebSocket timeout. "reconnect" itself cannot be the retry evidence, or
# every mention of reconnecting would count.
_TRANSPORT_COMPANIONS = tuple(c for c in _THROTTLE_COMPANIONS if c != b"reconnect")
_RETRY_COUNTER = re.compile(rb"\d+\s*/\s*\d+")
_STATUS_429 = re.compile(rb"(?:status|http_status)\D{0,3}429\b")
_GITHUB_STATUS = re.compile(rb"github\s+\d{3}")


class ReviewSuperseded(RuntimeError):
    def __init__(self, head_sha: str):
        self.head_sha = atoms.expected_head(head_sha)
        super().__init__(f"Review stopped early: PR head changed to {self.head_sha}")


def _stall_kind(line: bytes) -> str | None:
    """Classify one provider output line as quota or transport evidence.

    Returns "quota" for 429/rate-limit evidence, "transport" for a retry
    loop without quota evidence, and None for anything else — including
    assistant prose that merely mentions reconnecting.
    """
    lowered = line.lower()
    if _GITHUB_STATUS.search(lowered):
        # GitHub's own limit: switching models cannot fix it.
        return None
    if (_STATUS_429.search(lowered) or b"too many requests" in lowered
            or (any(word in lowered for word in _RATE_LIMIT_WORDS)
                and any(companion in lowered for companion in _THROTTLE_COMPANIONS))):
        return "quota"
    if ((b"reconnect" in lowered or b"exceeded retry limit" in lowered)
            and (_RETRY_COUNTER.search(lowered)
                 or any(companion in lowered for companion in _TRANSPORT_COMPANIONS))):
        return "transport"
    return None


class RateLimitAbort:
    """Kill a provider run stalled in its own retry loop.

    The first stall signal starts a minute's grace for the provider's own
    retry; any output line without a signal resets it. Past the minute
    with nothing but signals (or silence), the run is killed so Poise can
    move the review to the next slot instead of waiting out the budget.
    The handoff keeps the observed cause: quota evidence says rate-limited,
    a bare reconnect loop says reconnecting.
    """

    def __init__(self) -> None:
        self.out_offset = 0
        self.err_offset = 0
        self.pending_out = b""
        self.pending_err = b""
        self.since: float | None = None
        self.quota = False
        self.signal = b""

    def scan(self, stdout, stderr) -> None:
        for stream, offsets in ((stdout, ("out_offset", "pending_out")), (stderr, ("err_offset", "pending_err"))):
            try:
                chunk = os.pread(stream.fileno(), READ_BYTES, getattr(self, offsets[0]))
            except OSError:
                continue
            setattr(self, offsets[0], getattr(self, offsets[0]) + len(chunk))
            data = getattr(self, offsets[1]) + chunk
            *lines, rest = data.split(b"\n")
            # A marker can straddle two reads; only the tail can hold half of one.
            setattr(self, offsets[1], rest[-1024:])
            for line in lines:
                self.feed(line)

    def note(self, chunk: bytes) -> None:
        for line in chunk.split(b"\n"):
            self.feed(line)

    def feed(self, line: bytes) -> None:
        if not line.strip():
            return
        kind = _stall_kind(line)
        if kind is None:
            self.since = None
            self.quota = False
        else:
            if self.since is None:
                self.since = monotonic()
            if kind == "quota":
                self.quota = True
            self.signal = line.strip()[:200]

    def check(self, provider: str | None, process: subprocess.Popen) -> None:
        # Only complete lines judge: a pending fragment may hold half a
        # marker, and feeding it early would both lose the signal and reset
        # the clock. scan() carries fragments across reads instead.
        if self.since is None or monotonic() - self.since < RATE_LIMIT_ABORT_SECONDS:
            return
        _stop_process_group(process)
        excerpt = self.signal.decode("utf-8", "replace") if self.signal else ""
        if self.quota:
            complaint = f"Provider rate-limited this run for over a minute ({provider or 'unknown'})"
        else:
            complaint = f"Provider kept reconnecting for over a minute ({provider or 'unknown'})"
        raise review_budget.ReviewLimitError(
            f"{complaint}; handing off so the next model can run instead{(': ' + excerpt) if excerpt else ''}",
            "review_provider_error")


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
                 f"#{self.number}", "--repository", self.repo, "--token-user", self.actor],
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
        limited = RateLimitAbort()
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
                    limited.scan(stdout, stderr)
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
                    # Completion wins over the abort: a run that just exited
                    # reports its own result, never a handoff.
                    limited.check(provider, process)
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
