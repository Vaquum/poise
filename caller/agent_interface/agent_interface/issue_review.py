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
import os
import re
import shutil
import signal
import subprocess
import tempfile
from pathlib import Path
from threading import current_thread, main_thread
from time import monotonic, sleep, time
from typing import Callable

from . import progress, review_budget
from .atoms import AgentPreflightError
from .model_catalog import Model
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
STALE_RUN_SECONDS = 2 * 24 * 3600
LEFTOVER_GRACE_SECONDS = 3
WORK_ROOT = Path(os.getenv("AGENT_INTERFACE_WORK_DIR") or Path.home() / ".cache" / "agent-interface" / "issue-review")
REF_RE = re.compile(r"([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)#(\d+)")
URL_RE = re.compile(r"https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/issues/(\d+)/?")
# What post() leaves at the very end of every comment it makes. A marker
# earlier in a body is a quote of someone else's.
MARKER_RE = re.compile(r"<!-- agent-interface issue-review call=([0-9a-f]{32}) -->\s*\Z")


class InvalidReview(RuntimeError):
    code = "invalid_review_output"


def parse(issue: str) -> tuple[str, int]:
    raw = str(issue).strip()
    match = URL_RE.fullmatch(raw) or REF_RE.fullmatch(raw)
    if not match or int(match.group(3)) < 1:
        raise ValueError("issue must look like owner/repo#123 or a GitHub issue URL")
    return f"{match.group(1)}/{match.group(2)}", int(match.group(3))


def ref(repo: str, number: int) -> str:
    return f"{repo}#{number}"


def interface(*args: str, seconds: float = 120) -> dict:
    # Its own process group: a timeout or a stop must also end the git it
    # started, which would otherwise keep working on a shared mirror.
    process = subprocess.Popen(
        [os.getenv("GITHUB_INTERFACE_CLI", "github-interface"), *args],
        text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=review_budget.timeout(seconds))
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


def prompt(target: str, repo: str, checkout: dict, data: dict, output: Path, actor: str, note: str) -> str:
    places = allowed(data)
    memories = f"Memories from the past:\n{note}\n\n" if note.strip() else ""
    readable = [sub["issue"] for sub in data["sub_issues"] if "error" not in sub]
    reviewed = [f"{sub['issue']} (from the review of {sub['reviewed_by']})" for sub in data["sub_issues"] if "reviewed_by" in sub]
    already = (f"These already have an issue review: {', '.join(reviewed)}. Read them and that review for context, "
               f"but do not comment on them; put anything you would add in your comment on {target}.\n\n"
               if reviewed else "")
    return (
        f"{memories}{INSTRUCTION.format(target=target)}\n\n"
        f"The issues directly linked to it are the sub-issues it makes part of itself: {', '.join(readable) or 'none'}. "
        "The packet below holds each one's text and comments.\n\n"
        f"{already}"
        f"You run unattended with full access. The current directory is a fresh clone of {repo} "
        f"({checkout['branch']} at {checkout['head_sha']}): read anything, build, run the tests, "
        "use git history and GitHub as you see fit.\n\n"
        f"Do not post to GitHub yourself. When you are done, write your comments to {output} as JSON "
        '{"comments": [{"issue": "owner/repo#number", "body": "markdown"}]} — at most one comment per issue, '
        f"each under {MAX_COMMENT_CHARS} characters, only for {', '.join(places)}. Caller posts them as {actor}.\n\n"
        f"Packet:\n{json.dumps(data, indent=2)}"
    )


def command(model: Model, text: str, checkout: Path, work: Path, seconds: float) -> tuple[list[str], str, dict]:
    """The provider's own CLI with full access — no allowlist, no sandbox."""
    env = os.environ.copy()
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
            "--append-system-prompt", UNATTENDED,
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
        return [
            os.getenv("MUSE_CLI", "muse"), "exec", "--prompt-file", str(prompt_file),
            "--model", model.selector, "--reasoning-effort", model.effort,
            "--yolo", "--workspace", str(checkout), "--json", "--no-session-log",
        ], "", env
    raise AgentPreflightError(f"{model.provider} cannot run an issue review")


def supervise(args: list[str], *, input: str, cwd: Path, timeout: float, env: dict, provider: str) -> subprocess.CompletedProcess:
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
                    stop_leftovers(cwd)
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
                    stop_leftovers(cwd)
            finally:
                if previous is not None:
                    signal.signal(signal.SIGTERM, previous)


def _cwd_pids(root: Path) -> list[int]:
    """Processes whose working directory is inside `root`, this one excepted."""
    prefix, found = str(root.resolve()), []
    proc = Path("/proc")
    if proc.is_dir():
        for entry in proc.iterdir():
            if entry.name.isdigit():
                try:
                    found.append((int(entry.name), os.readlink(entry / "cwd")))
                except OSError:
                    continue
    else:
        try:
            done = subprocess.run(["lsof", "-a", "-u", str(os.getuid()), "-d", "cwd", "-Fpn"],
                                  text=True, capture_output=True, timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            return []
        pid = None
        for line in done.stdout.splitlines():
            if line.startswith("p") and line[1:].isdigit():
                pid = int(line[1:])
            elif line.startswith("n") and pid is not None:
                found.append((pid, line[1:]))
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
        data = json.loads(path.read_text())
    except (OSError, ValueError) as error:
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


def review(model: Model, repo: str, number: int, data: dict, actor: str, note: str, work: Path) -> tuple[list[dict], list[str]]:
    """One full-power agent run in its own fresh checkout."""
    work.mkdir(parents=True)
    checkout = work / "repo"
    progress.stage("checking_out", f"Preparing a fresh checkout of {repo}", timeout=review_budget.timeout(1800))
    info = interface("--checkout-repo", repo, "--path", str(checkout), "--token-user", actor, seconds=1800)
    output = work / "review.json"
    text = prompt(ref(repo, number), repo, info, data, output, actor, note)
    seconds = review_budget.timeout(TIMEOUT_SECONDS, reserve=POST_RESERVE_SECONDS)
    args, stdin, env = command(model, text, checkout, work, seconds)
    try:
        done = supervise(args, input=stdin, cwd=checkout, timeout=seconds, env=env, provider=model.provider)
    except subprocess.TimeoutExpired as error:
        raise review_budget.ReviewLimitError("Issue review reached its time limit; needs attention", "review_budget_exhausted") from error
    if done.returncode:
        # Claude's own result or stream diagnostics; a launch the subscription
        # wrapper refused says why on stderr.
        error = claude_error(done.stdout) if model.provider == "claude" else provider_error(done.stdout, done.stderr)
        error = error or done.stderr.strip()[-500:] or f"{model.provider} exited {done.returncode}"
        if "output token maximum" in error or "context window limit" in error:
            raise review_budget.ReviewLimitError(error)
        raise RuntimeError(error)
    progress.stage("validating", "Validating review comments")
    return comments(output, allowed(data), repo)


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
        body = (f"{item['body']}\n\n---\n<sub>Issue review · `{model}`</sub>\n"
                f"<!-- agent-interface issue-review call={call_id} -->")
        try:
            reply = interface("--comment-issue", f"#{number}", "--repository", repo, "--token-user", actor, f"--body={body}")
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


def sweep() -> None:
    """Remove run directories a killed run could not clean up."""
    if not WORK_ROOT.is_dir():
        return
    for path in WORK_ROOT.iterdir():
        try:
            if path.is_dir() and time() - path.stat().st_mtime > STALE_RUN_SECONDS:
                shutil.rmtree(path, ignore_errors=True)
        except OSError:
            continue
