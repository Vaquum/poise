"""An adversarial review of one issue and the sub-issues it makes part of itself.

Unlike the PR behaviors, the agent is not held to Caller commands: at the
operator's explicit request it runs its provider's own CLI with full access,
in a fresh checkout of the issue's repository, so it can read the whole
repository, build and run the tests. It does not post. It writes its comments
to a file, and Caller posts them as the actor through github-interface — only
on the issue and its sub-issues, one comment per issue. Every github-interface
call names the actor with --token-user, so the reads, the checkout and the
comments are all the agent account's.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import hashlib
from pathlib import Path
from threading import current_thread, main_thread
from time import monotonic, sleep, time
from typing import Callable

from . import progress, review_budget
from .atoms import AgentPreflightError, bounded_cause, provider_blocked
from .model_catalog import Model
from .process_diagnostic import diagnostic_envelope
from .provider_progress import ProviderStream, claude_error
from .review_watch import _interrupted, _stop_process_group

INSTRUCTION = "Provide an adversarial, meticulous, and comprehensive review with comments on {target} and any issue directly linked to it."
# Added to Claude Code's own system prompt; the task itself goes on stdin.
UNATTENDED = ("You run unattended: nobody will answer a question or approve anything. "
              "Do not post to GitHub yourself; write your review comments to the output file the task names.")
TIMEOUT_SECONDS = 3600
POST_RESERVE_SECONDS = 120
MAX_PACKET_BYTES = 1_500_000
MAX_COMMENT_CHARS = 60_000
STALE_RUN_SECONDS = 2 * TIMEOUT_SECONDS
LEFTOVER_GRACE_SECONDS = 3
WORK_ROOT = Path(os.getenv("AGENT_INTERFACE_WORK_DIR") or Path.home() / ".cache" / "agent-interface" / "issue-review")
REF_RE = re.compile(r"([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)#(\d+)")
URL_RE = re.compile(r"https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/issues/(\d+)/?")
# What post() leaves at the very end of every comment it makes. A marker
# earlier in a body is a quote of someone else's.
MARKER_RE = re.compile(r"<!-- agent-interface issue-review call=([0-9a-f]{32}) -->\s*\Z")
logger = logging.getLogger(__name__)


class InvalidReview(RuntimeError):
    code = "invalid_review_output"

    def __init__(self, message: str, diagnostic: dict | None = None):
        super().__init__(message)
        self.diagnostic = diagnostic


class ProviderFailure(RuntimeError):
    """The issue-review provider ran and failed: an exit or signal, or an
    error terminal despite a zero exit. Nothing was posted."""

    def __init__(self, message: str, code: str, diagnostic: dict | None = None):
        super().__init__(message)
        self.code = code
        self.diagnostic = diagnostic


def parse(issue: str) -> tuple[str, int]:
    raw = str(issue).strip()
    match = URL_RE.fullmatch(raw) or REF_RE.fullmatch(raw)
    if not match or int(match.group(3)) < 1:
        raise ValueError("issue must look like owner/repo#123 or a GitHub issue URL")
    return f"{match.group(1)}/{match.group(2)}", int(match.group(3))


def ref(repo: str, number: int) -> str:
    return f"{repo}#{number}"


def revision(issue: dict) -> str:
    return hashlib.sha256(json.dumps([issue.get("title") or "", issue.get("body") or ""],
                                    ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def interface(*args: str, seconds: float = 120, cwd: Path | None = None) -> dict:
    # Its own process group: a timeout or a stop must also end the git it
    # started, which would otherwise keep working on a shared mirror.
    # Check the budget before spawning so an exhausted budget never starts
    # (and SIGKILLs) a fresh child.
    limit = review_budget.timeout(seconds)
    process = subprocess.Popen(
        [os.getenv("GITHUB_INTERFACE_CLI", "github-interface"), *args],
        text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, cwd=cwd,
    )
    try:
        stdout, stderr = process.communicate(timeout=limit)
    except BaseException:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        process.communicate()
        raise
    if process.returncode:
        raise RuntimeError((stderr or stdout).strip() or f"github-interface {args[0]} exited {process.returncode}")
    return json.loads(stdout)


def _issue(repo: str, number: int, actor: str) -> dict:
    issue = interface("--read-issue", f"#{number}", "--repository", repo, "--token-user", actor)["issue"]
    comments = interface("--issue-comments", f"#{number}", "--repository", repo, "--token-user", actor)["comments"]
    return {
        "issue": ref(repo, number),
        "title": issue.get("title"),
        "state": issue.get("state"),
        "author": (issue.get("user") or {}).get("login"),
        "labels": [label.get("name") for label in issue.get("labels") or [] if isinstance(label, dict)],
        "url": issue.get("html_url"),
        "created_at": issue.get("created_at"),
        "updated_at": issue.get("updated_at"),
        "body": issue.get("body") or "",
        "comments": comments,
        "pull_request": "pull_request" in issue,
    }


def packet(repo: str, number: int, actor: str) -> dict:
    """The issue, its comments, and every sub-issue with its own comments."""
    progress.stage("preparing_issue", "Reading the issue and its sub-issues", timeout=review_budget.timeout(600))
    target = _issue(repo, number, actor)
    if target.pop("pull_request"):
        raise AgentPreflightError(f"{ref(repo, number)} is a pull request, not an issue")
    subs = []
    for item in interface("--sub-issues", f"#{number}", "--repository", repo, "--token-user", actor)["sub_issues"]:
        linked = ref(item["repository"], item["issue_number"])
        try:
            sub = _issue(item["repository"], item["issue_number"], actor)
        except (RuntimeError, ValueError) as error:
            subs.append({"issue": linked, "via": item["via"], "error": str(error)[:500]})
            continue
        if not sub.pop("pull_request"):
            subs.append({**sub, "via": item["via"]})
    data = {"issue": target, "sub_issues": subs}
    size = len(json.dumps(data).encode("utf-8"))
    if size > MAX_PACKET_BYTES:
        raise AgentPreflightError(
            f"issue packet is {size} bytes, over the {MAX_PACKET_BYTES} a reliable review can take",
            "review_packet_too_large",
        )
    return data


def mark_reviewed(data: dict, actor: str, reviews: Callable[[list[str]], dict[str, str]],
                  running: frozenset[str] = frozenset()) -> None:
    """A sub-issue is reviewed once. One that a review of another issue has
    already commented on as the actor (its own review, say, from before a PRD
    took it in), or whose own review is running now, stays in the packet for
    context but gets no comment from this review. `reviews` maps call ids to
    the issue each review was of; a review this machine has no record of counts
    as another issue's. `running` holds the issues, lowercased, with a review
    running."""
    target = data["issue"]["issue"].lower()
    for sub in data["sub_issues"]:
        if "error" in sub:
            continue
        if sub["issue"].lower() in running:
            sub["reviewed_by"] = sub["issue"]
            continue
        calls = []
        for comment in sub.get("comments") or []:
            match = MARKER_RE.search(str(comment.get("body") or ""))
            if match and str(comment.get("author") or "").lower() == actor.lower():
                calls.append(match.group(1))
        if not calls:
            continue
        of = reviews(calls)
        other = next((of.get(call) or "another issue" for call in calls if (of.get(call) or "").lower() != target), None)
        if other:
            sub["reviewed_by"] = other


def allowed(data: dict) -> list[str]:
    """Where comments may land: the issue, then each readable sub-issue that
    has no review from another issue."""
    return [data["issue"]["issue"],
            *(sub["issue"] for sub in data["sub_issues"] if "error" not in sub and "reviewed_by" not in sub)]


def prompt(target: str, repo: str, checkout: dict, data: dict, output: Path, actor: str, note: str,
           seconds: float | None = None) -> str:
    places = allowed(data)
    memories = f"Memories from the past:\n{note}\n\n" if note.strip() else ""
    readable = [sub["issue"] for sub in data["sub_issues"] if "error" not in sub]
    reviewed = [f"{sub['issue']} (from the review of {sub['reviewed_by']})" for sub in data["sub_issues"] if "reviewed_by" in sub]
    already = (f"These already have an issue review: {', '.join(reviewed)}. Read them and that review for context, "
               f"but do not comment on them; put anything you would add in your comment on {target}.\n\n"
               if reviewed else "")
    budget = (f"You have {int(seconds)} seconds from now to finish. Write {output.name} early "
              "and keep it updated as you work; only what is in that file when time runs out can be used.\n\n"
              if seconds else "")
    return (
        f"{memories}{INSTRUCTION.format(target=target)}\n\n"
        f"The issues directly linked to it are the sub-issues it makes part of itself: {', '.join(readable) or 'none'}. "
        "The packet below holds each one's text and comments.\n\n"
        f"{already}"
        f"You run unattended with full access. The current directory is a fresh clone of {repo} "
        f"({checkout['branch']} at {checkout['head_sha']}): read anything, build, run the tests, "
        "use git history and GitHub as you see fit.\n\n"
        f"{budget}"
        "Keep all throwaway files, dependency environments, downloads and test artifacts in "
        f"$TMPDIR ({output.parent.resolve() / 'tmp'}), not in shared /tmp. Caller removes this run's "
        "temporary directory after the review; repository access and tool permissions are unchanged.\n\n"
        f"Do not post to GitHub yourself. When you are done, write your comments to {output} as JSON "
        '{"comments": [{"issue": "owner/repo#number", "body": "markdown"}]} — at most one comment per issue, '
        f"each under {MAX_COMMENT_CHARS} characters, only for {', '.join(places)}. Caller posts them as {actor}.\n\n"
        f"Packet:\n{json.dumps(data, indent=2)}"
    )


MAX_ARTIFACT_BYTES = 5 * 1024 * 1024


def artifact_status(path: Path) -> dict:
    """What the provider left behind: presence, size, mtime and readability,
    recorded before cleanup removes the evidence."""
    try:
        stat = path.stat()
    except OSError:
        return {"present": False}
    if not path.is_file() or path.is_symlink():
        return {"present": True, "regular": False}
    status = {"present": True, "regular": True, "bytes": stat.st_size, "mtime": stat.st_mtime}
    if stat.st_size > MAX_ARTIFACT_BYTES:
        return {**status, "readable": False, "error": "artifact exceeds its byte limit"}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        items = data.get("comments") if isinstance(data, dict) else None
        status["readable"] = isinstance(items, list)
        status["entries"] = len(items) if isinstance(items, list) else 0
        if not isinstance(items, list):
            status["error"] = "artifact is not {\"comments\": [...]}"
    except (OSError, ValueError) as error:
        status["readable"] = False
        status["error"] = str(error)[:200]
    return status


def command(model: Model, text: str, checkout: Path, work: Path, seconds: float, unattended: str = UNATTENDED) -> tuple[list[str], str, dict]:
    """The provider's own CLI with full access — no allowlist, no sandbox."""
    env = os.environ.copy()
    scratch = work.resolve() / "tmp"
    scratch.mkdir(mode=0o700, exist_ok=True)
    env.update({key: str(scratch) for key in ("TMPDIR", "TMP", "TEMP")})
    if model.provider == "claude":
        settings = json.dumps({"env": {"CLAUDE_CODE_MAX_OUTPUT_TOKENS": str(review_budget.OUTPUT_TOKENS)}})
        return [
            os.getenv("CLAUDE_CLI", "claude"), "--print",
            "--output-format", "stream-json", "--verbose", "--include-partial-messages",
            "--thinking-display", "summarized",
            "--model", model.selector, "--effort", model.effort,
            "--dangerously-skip-permissions", "--setting-sources", "", "--no-session-persistence",
            "--add-dir", str(work), "--settings", settings,
            # Last, so Poise's subscription wrapper reads the prompt from stdin.
            "--append-system-prompt", unattended,
        ], text, env
    if model.provider == "codex":
        for key in ("OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"):
            env.pop(key, None)
        return [
            os.getenv("CODEX_CLI", "codex"), "exec",
            "--ignore-user-config", "--ignore-rules", "--ephemeral",
            "--sandbox", "danger-full-access", "-c", 'approval_policy="never"',
            "--model", model.selector, "-c", f'model_reasoning_effort="{model.effort}"',
            "-c", 'forced_login_method="chatgpt"', "--json", "-",
        ], text, env
    prompt_file = work / "prompt.txt"
    prompt_file.write_text(text)
    if model.provider == "grok":
        return [
            os.getenv("GROK_CLI", "grok"), "--prompt-file", str(prompt_file),
            "-m", model.selector, "--effort", model.effort, "--output-format", "streaming-json",
            "--permission-mode", "bypassPermissions", "--sandbox", "off", "--cwd", str(checkout),
        ], "", env
    if model.provider == "antigravity":
        message = {"event": "user", "message": {"role": "user", "content": text}}
        return [
            os.getenv("ANTIGRAVITY_CLI", "agy"), "--print=", "--input-format", "stream-json",
            "--output-format", "stream-json", "--model", model.selector, "--effort", model.effort,
            "--dangerously-skip-permissions", "--add-dir", str(work),
            "--print-timeout", f"{max(1, int(seconds))}s",
        ], json.dumps(message) + "\n", env
    if model.provider == "muse":
        # This Muse CLI needs session logging for its local session
        # messaging, so the run keeps its session store inside the run.
        data = work / "data"
        data.mkdir(mode=0o700, exist_ok=True)
        env["XDG_DATA_HOME"] = str(data)
        return [
            os.getenv("MUSE_CLI", "muse"), "exec", "--contributor-mode", "on", "--prompt-file", str(prompt_file),
            "--model", model.selector, "--reasoning-effort", model.effort,
            "--yolo", "--workspace", str(checkout), "--json",
        ], "", env
    raise AgentPreflightError(f"{model.provider} cannot run an issue review")


def supervise(args: list[str], *, input: str, cwd: Path, timeout: float, env: dict, provider: str,
              cleanup_root: Path | None = None) -> subprocess.CompletedProcess:
    """Run the provider in its own process group, record its activity, and
    leave nothing of that group running afterwards."""
    # Wall-clock too: a monotonic clock stands still while the machine sleeps,
    # and Poise counts a run's time on the wall clock.
    deadline, wall_deadline = monotonic() + timeout, time() + timeout
    events = ProviderStream(provider)
    progress.stage("waiting_provider", "Waiting for provider", timeout=timeout)
    with tempfile.TemporaryFile(mode="w+t") as stdin, \
            tempfile.TemporaryFile(mode="w+t") as stdout, \
            tempfile.TemporaryFile(mode="w+t") as stderr:
        stdin.write(input)
        stdin.seek(0)
        process = subprocess.Popen(args, stdin=stdin, stdout=stdout, stderr=stderr, cwd=cwd,
                                   env=env, text=True, start_new_session=True)
        completed = False
        previous = signal.signal(signal.SIGTERM, _interrupted) if current_thread() is main_thread() else None
        try:
            while True:
                events.read(stdout)
                if process.poll() is not None:
                    events.read(stdout, final=True)
                    completed = True
                    # Whatever the agent left running in the background (a dev
                    # server, a watcher) would outlive the checkout it runs in.
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        pass
                    stop_leftovers(cwd if cleanup_root is None else cleanup_root)
                    stdout.seek(0)
                    stderr.seek(0)
                    return subprocess.CompletedProcess(args, process.returncode, stdout.read(), stderr.read())
                remaining = min(deadline - monotonic(), wall_deadline - time())
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(args, timeout)
                try:
                    process.wait(timeout=min(1, remaining))
                except subprocess.TimeoutExpired:
                    pass
        finally:
            try:
                if not completed:
                    _stop_process_group(process)
                    stop_leftovers(cwd if cleanup_root is None else cleanup_root)
            finally:
                if previous is not None:
                    signal.signal(signal.SIGTERM, previous)


def _cwd_pids(root: Path, *, require_complete: bool = False) -> list[int] | None:
    """Processes whose working directory is inside `root`, this one excepted."""
    prefix, found = str(root.resolve()), []
    proc = Path("/proc")
    if proc.is_dir():
        for entry in proc.iterdir():
            if entry.name.isdigit() and int(entry.name) != os.getpid():
                try:
                    if require_complete and entry.stat().st_uid != os.getuid():
                        continue
                    found.append((int(entry.name), os.readlink(entry / "cwd")))
                    if require_complete:
                        # A detached process may have left the checkout but
                        # still use this run's temporary files or environment.
                        environment = (entry / "environ").read_bytes()
                        handles = []
                        for fd in (entry / "fd").iterdir():
                            try:
                                handles.append(os.readlink(fd))
                            except FileNotFoundError:
                                continue  # A closed handle no longer uses this run.
                        if prefix.encode() in environment or any(
                            handle == prefix or handle.startswith(prefix + os.sep) for handle in handles
                        ):
                            found.append((int(entry.name), prefix))
                except OSError:
                    # A process may have exited between enumeration and read.
                    # An existing unreadable process cannot prove the run idle.
                    if require_complete and entry.exists():
                        try:
                            state = (entry / "stat").read_text().rpartition(") ")[2].split()[0]
                        except (OSError, IndexError):
                            return None
                        if state != "Z":
                            return None
    else:
        try:
            # GUI/launchd environments often omit macOS's system sbin path.
            lsof = "/usr/sbin/lsof" if sys.platform == "darwin" else "lsof"
            args = [lsof, "-a", "-u", str(os.getuid()), "-Fpn"]
            if not require_complete:
                args += ["-d", "cwd"]
            done = subprocess.run(args,
                                  text=True, capture_output=True, timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            return None if require_complete else []
        if require_complete and done.returncode:
            return None
        pid = None
        for line in done.stdout.splitlines():
            if line.startswith("p") and line[1:].isdigit():
                pid = int(line[1:])
            elif line.startswith("n") and pid is not None:
                found.append((pid, line[1:]))
        if require_complete:
            try:
                processes = subprocess.run(["ps", "eww", "-U", str(os.getuid()), "-o", "pid=,command="],
                                           text=True, capture_output=True, timeout=10)
            except (OSError, subprocess.TimeoutExpired):
                return None
            if processes.returncode:
                return None
            for line in processes.stdout.splitlines():
                fields = line.strip().split(None, 1)
                if len(fields) == 2 and fields[0].isdigit() and prefix in fields[1]:
                    found.append((int(fields[0]), prefix))
    return [pid for pid, path in found
            if pid != os.getpid() and (path == prefix or path.startswith(prefix + os.sep))]


def stop_leftovers(root: Path) -> None:
    """End what the agent left running in its checkout — a dev server, a watcher,
    a test that detached into its own session — before the checkout goes."""
    for sig in (signal.SIGTERM, signal.SIGKILL):
        pids = _cwd_pids(Path(root))
        if not pids:
            return
        for pid in pids:
            try:
                os.kill(pid, sig)
            except (ProcessLookupError, PermissionError):
                pass
        if sig == signal.SIGTERM:
            sleep(LEFTOVER_GRACE_SECONDS)


def comments(path: Path, places: list[str], repo: str) -> tuple[list[dict], list[str]]:
    """The agent's comments, one per issue in `places` order; comments for
    any other issue are set aside and reported, never posted."""
    try:
        if path.is_symlink() or not path.is_file():
            raise InvalidReview(f"the agent left no regular review file at {path.name}")
        if path.stat().st_size > MAX_ARTIFACT_BYTES:
            raise InvalidReview(f"the agent review at {path.name} exceeds its byte limit")
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        if isinstance(error, InvalidReview):
            raise
        raise InvalidReview(f"the agent left no readable review at {path.name}: {error}") from error
    items = data.get("comments") if isinstance(data, dict) else None
    if not isinstance(items, list):
        raise InvalidReview('the review must be an object {"comments": [...]}')
    canonical = {place.lower(): place for place in places}
    merged: dict[str, list[str]] = {}
    ignored: list[str] = []
    for item in items:
        # One malformed entry must not discard the rest of an hour's work.
        if not isinstance(item, dict) or not isinstance(item.get("issue"), str) \
                or not isinstance(item.get("body"), str) or not item["body"].strip():
            ignored.append("a comment without an issue and a body")
            continue
        raw = item["issue"].strip()
        try:
            target = ref(repo, int(raw[1:])) if re.fullmatch(r"#\d+", raw) else ref(*parse(raw))
        except ValueError:
            target = raw
        place = canonical.get(target.lower())
        if place is None:
            ignored.append(raw)
            continue
        merged.setdefault(place, []).append(item["body"].strip())
    posts = []
    for place in places:
        if place in merged:
            parts = split("\n\n".join(merged[place]))
            posts += [{"issue": place, "body": part if len(parts) == 1 else f"*Part {index} of {len(parts)}*\n\n{part}"}
                      for index, part in enumerate(parts, 1)]
    if not posts:
        raise InvalidReview("the review has no comment for the issue or its sub-issues")
    return posts, ignored


def split(body: str, limit: int = MAX_COMMENT_CHARS) -> list[str]:
    """A body GitHub cannot take in one comment, in parts at paragraph breaks."""
    parts: list[str] = []
    while len(body) > limit:
        cut = body.rfind("\n\n", 0, limit)
        cut = cut if cut > limit // 2 else limit
        parts.append(body[:cut].rstrip())
        body = body[cut:].lstrip()
    return [*parts, body] if body else parts


def _terminal_failure(provider: str, stdout: str) -> str | None:
    """A provider-reported failure terminal, independent of process exit code.
    A failed provider must not quietly become successful artifact output."""
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        if provider == "codex" and event.get("type") in {"error", "turn.failed"}:
            return str(event.get("message") or "Codex review did not complete successfully")
        if provider == "claude" and event.get("type") == "result":
            if event.get("is_error") or event.get("subtype") not in (None, "success"):
                text = event.get("result")
                if isinstance(text, str) and text.strip():
                    return text.strip()
                errors = event.get("errors")
                if isinstance(errors, list):
                    joined = "\n".join(item for item in errors if isinstance(item, str))
                    if joined.strip():
                        return joined.strip()
                return "Claude review reported an error"
        if provider == "grok" and event.get("type") == "end" and event.get("stopReason") != "end_turn":
            return f"Grok review ended with {event.get('stopReason')}"
        if provider == "antigravity" and event.get("event") == "result":
            result = event.get("result") or {}
            if isinstance(result, dict) and result.get("status") != "SUCCESS":
                return str(result.get("error") or f"Antigravity review ended with status {result.get('status')!r}")
        if provider == "muse" and isinstance(event.get("payload_type"), str) \
                and event["payload_type"].startswith("run.terminal"):
            payload = event.get("payload") or {}
            if payload.get("terminal") != "completed":
                return str(payload.get("reason") or f"Muse review ended with {payload.get('terminal')}")
    return None


def review(model: Model, repo: str, number: int, data: dict, actor: str, note: str, work: Path) -> tuple[list[dict], list[str]]:
    """One full-power agent run in its own fresh checkout."""
    work.mkdir(parents=True)
    checkout = work / "repo"
    progress.stage("checking_out", f"Preparing a fresh checkout of {repo}", timeout=review_budget.timeout(1800))
    try:
        info = interface("--checkout-repo", repo, "--path", str(checkout), "--token-user", actor, seconds=1800)
    except subprocess.TimeoutExpired as error:
        raise review_budget.ReviewLimitError(
            "Issue review checkout reached its time limit; needs attention", "review_budget_exhausted",
            diagnostic_envelope(operation="issue.checkout", phase="checking_out",
                                outcome="timed_out", provider=model.provider)) from error
    output = work / "review.json"
    seconds = review_budget.timeout(TIMEOUT_SECONDS, reserve=POST_RESERVE_SECONDS)
    text = prompt(ref(repo, number), repo, info, data, output, actor, note, seconds)
    args, stdin, env = command(model, text, checkout, work, seconds)
    try:
        done = supervise(args, input=stdin, cwd=checkout, timeout=seconds, env=env, provider=model.provider, cleanup_root=work)
    except subprocess.TimeoutExpired as error:
        status = artifact_status(output)
        raise review_budget.ReviewLimitError(
            "Issue review reached its time limit; needs attention", "review_budget_exhausted",
            diagnostic_envelope(operation="provider.review", phase="provider_execution",
                                outcome="timed_out", provider=model.provider,
                                artifact=status, submission="none")) from error
    terminal = _terminal_failure(model.provider, done.stdout)
    if done.returncode or terminal:
        # Claude's own result or stream diagnostics; a launch the subscription
        # wrapper refused says why on stderr.
        raw = terminal or (claude_error(done.stdout) if model.provider == "claude"
                           else provider_error(done.stdout, done.stderr))
        raw = raw or done.stderr.strip()[-500:] or f"{model.provider} exited {done.returncode}"
        error = bounded_cause(raw)
        status = artifact_status(output)
        diagnostic = diagnostic_envelope(operation="provider.review", phase="provider_execution",
                                               outcome="signal" if done.returncode < 0 else "exit",
                                               stderr=error, provider=model.provider,
                                               exit_code=done.returncode if done.returncode > 0 else None,
                                               signal=-done.returncode if done.returncode < 0 else None,
                                               artifact=status, submission="none")
        if "output token maximum" in error or "context window limit" in error:
            raise review_budget.ReviewLimitError(error, diagnostic=diagnostic)
        # Held for a person, as a PR review is: relaunching cannot succeed until the account is fixed.
        if provider_blocked(error):
            raise AgentPreflightError(error, "review_provider_blocked", diagnostic)
        code = "review_provider_error" if terminal and not done.returncode else "review_provider_exit"
        raise ProviderFailure(error, code, diagnostic)
    progress.stage("validating", "Validating review comments")
    try:
        return comments(output, allowed(data), repo)
    except InvalidReview as error:
        error.diagnostic = diagnostic_envelope(operation="provider.review", phase="validating",
                                                    outcome="invalid_output", provider=model.provider,
                                                    artifact=artifact_status(output), submission="none")
        raise


def provider_error(stdout: str, stderr: str) -> str:
    """The provider's own error message, never the raw stream: a full-access
    agent's output can hold whatever its shell printed."""
    for line in reversed(stdout.splitlines()):
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        error = event.get("error")
        message = error.get("message") if isinstance(error, dict) else error if isinstance(error, str) else None
        if event.get("type") in {"error", "turn.failed"} and not message:
            message = event.get("message")
        if isinstance(message, str) and message.strip():
            return message.strip()[:500]
    return stderr.strip()[-500:]


def _reconcile_post(repo: str, number: int, actor: str, call_id: str, seen: set[int]) -> dict | None:
    """A comment lost to a timeout may still exist: match this call's marker
    in the issue's comments rather than assuming failure. Already-receipted
    comments are skipped, so a timed-out later part of a split body cannot
    reconcile to an earlier part's comment."""
    try:
        comments = interface("--issue-comments", f"#{number}", "--repository", repo,
                             "--token-user", actor).get("comments") or []
    except Exception:
        return None
    for comment in comments:
        if not isinstance(comment, dict):
            continue
        match = MARKER_RE.search(str(comment.get("body") or ""))
        if not match or match.group(1) != call_id:
            continue
        comment_id = comment.get("id")
        if isinstance(comment_id, bool) or not isinstance(comment_id, int) or comment_id in seen:
            continue
        author = comment.get("author")
        if not isinstance(author, str):
            user = comment.get("user") or {}
            author = user.get("login") if isinstance(user, dict) else ""
        return {"issue": ref(repo, number), "comment_id": comment_id,
                "url": comment.get("html_url"), "author": str(author or "")}
    return None


def comment_body(item: dict, model: str, call_id: str) -> str:
    return (f"{item['body']}\n\n---\n<sub>Issue review · `{model}`</sub>\n"
            f"<!-- agent-interface issue-review call={call_id} -->")


def post(posts: list[dict], actor: str, call_id: str, model: str, record) -> list[dict]:
    """Post each comment as the actor. `record` is called with the receipts
    before the first comment and after every one, so a run that dies while
    posting is never mistaken for one that posted nothing."""
    progress.stage("posting", f"Posting {len(posts)} comment(s) as {actor}")
    receipts: list[dict] = []
    failures: list[str] = []
    record(receipts)
    for item in posts:
        repo, number = parse(item["issue"])
        body = comment_body(item, model, call_id)
        try:
            reply = interface("--comment-issue", f"#{number}", "--repository", repo, "--token-user", actor, f"--body={body}")
        except (subprocess.TimeoutExpired, review_budget.ReviewLimitError) as error:
            # The comment may exist: reconcile through the call marker before
            # calling it a failure. Unreconciled stays uncertain, never definite.
            reconciled = _reconcile_post(repo, number, actor, call_id,
                                           {receipt["comment_id"] for receipt in receipts})
            if reconciled is not None:
                receipts.append(reconciled)
                record(receipts)
                if str(reconciled.get("author") or "").lower() != actor.lower():
                    raise RuntimeError(f"the comment on {item['issue']} was posted by {reconciled.get('author') or 'an unknown account'}, not {actor}")
                continue
            failures.append(f"{item['issue']}: uncertain publication ({type(error).__name__}); reconcile before retry")
            continue
        except (RuntimeError, ValueError, subprocess.SubprocessError) as error:
            # A locked or deleted sub-issue must not cost the others their comment.
            failures.append(f"{item['issue']}: {str(error)[:300]}")
            continue
        comment = reply.get("comment") if isinstance(reply, dict) else None
        if not isinstance(comment, dict) or reply.get("action") != "commented_issue" \
                or reply.get("repository") != repo or reply.get("issue_number") != number \
                or isinstance(comment.get("id"), bool) or not isinstance(comment.get("id"), int):
            failures.append(f"{item['issue']}: github-interface answered unexpectedly")
            continue
        author = str((comment.get("user") or {}).get("login") or "")
        receipts.append({"issue": item["issue"], "comment_id": comment["id"], "url": comment.get("html_url"), "author": author})
        record(receipts)
        if author.lower() != actor.lower():
            raise RuntimeError(f"the comment on {item['issue']} was posted by {author or 'an unknown account'}, not {actor}")
    if failures:
        raise RuntimeError(f"posted {len(receipts)} of {len(posts)} comment(s); " + "; ".join(failures))
    return receipts


def summary(posts: list[dict], receipts: list[dict], ignored: list[str]) -> str:
    lines = [f"Posted {len(receipts)} comment(s):"]
    for item, receipt in zip(posts, receipts):
        lines += ["", f"### {item['issue']} — {receipt.get('url') or receipt['comment_id']}", "", item["body"]]
    if ignored:
        lines += ["", "Not posted (outside what this review comments on): " + ", ".join(ignored)]
    return "\n".join(lines)


def cleanup(path: Path) -> None:
    def report(function, failed_path, error):
        logger.warning("Could not remove issue-review artifact %s: %s", failed_path, error)

    def writable(directory: Path) -> None:
        mode = directory.lstat().st_mode
        if stat.S_ISDIR(mode) and mode & stat.S_IRWXU != stat.S_IRWXU:
            directory.chmod(stat.S_IMODE(mode) | stat.S_IRWXU, follow_symlinks=False)

    try:
        if path.is_symlink():
            logger.warning("Refusing to traverse issue-review workspace symlink %s", path)
            return
        writable(path)
        for root, directories, _ in os.walk(path, followlinks=False, onerror=lambda error: report(None, path, error)):
            for name in directories:
                directory = Path(root) / name
                try:
                    writable(directory)
                except OSError as error:
                    report(None, directory, error)
        shutil.rmtree(path, onexc=report)
    except FileNotFoundError:
        return
    except OSError as error:
        logger.warning("Could not remove issue-review workspace %s: %s", path, error)


def sweep() -> None:
    """Remove run directories a killed run could not clean up."""
    if not WORK_ROOT.is_dir():
        return
    for path in WORK_ROOT.iterdir():
        if path.is_symlink() or not re.fullmatch(r"[0-9a-f]{32}", path.name):
            continue
        try:
            if path.is_dir() and time() - path.stat().st_mtime > STALE_RUN_SECONDS:
                active = _cwd_pids(path, require_complete=True)
                if active is not None and not active:
                    cleanup(path)
        except OSError as error:
            logger.warning("Could not inspect issue-review workspace %s: %s", path, error)
