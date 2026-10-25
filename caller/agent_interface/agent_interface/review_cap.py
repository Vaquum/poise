"""The capped review round: file findings as one follow-up issue, then approve.

When Poise launches an approve-prs run at or past the configured review-round
cap, the run must not request changes again. It files that round's findings as
one follow-up issue in the pull request's repository and approves, so review
ping-pong cannot stall the queue forever. The issue carries a marker for its
pull request and head, so a retry or replay reuses it instead of filing again.
"""
from __future__ import annotations

import json
import os
import subprocess

from . import progress, review_budget, review_receipt
from .atoms import bounded_cause
from .process_diagnostic import diagnostic_envelope


def marker(pr_number: str, head: str) -> str:
    return f"<!-- poise:review-cap #{pr_number}@{head.lower()} -->"


def find_capped_issue(packet: str, pr_number: str, head: str) -> dict | None:
    """The follow-up issue already filed for this pull request and head, if any."""
    needle = marker(pr_number, head)
    try:
        issues = json.loads(packet).get("linked_issues") or []
    except ValueError:
        return None
    if not isinstance(issues, list):
        return None
    for issue in issues:
        if isinstance(issue, dict) and needle in str(issue.get("body") or ""):
            return issue
    return None


def issue_reference(issue: dict) -> str:
    number = issue.get("number")
    url = issue.get("html_url") or issue.get("url")
    if isinstance(number, int) and url:
        return f"issue #{number} ({url})"
    return "the existing follow-up issue"


def render_title(repo: str, pr_number: str, review_round: int) -> str:
    return f"Review follow-up for {repo}#{pr_number} (round {review_round})"


def render_body(
    repo: str,
    pr_number: str,
    head: str,
    base: str,
    review_round: int,
    review_cap: int,
    comments: list[dict],
) -> str:
    lines = [
        marker(pr_number, head),
        "",
        f"Review round {review_round} reached the configured cap of {review_cap} rounds, "
        f"so these findings were deferred here and the pull request approved.",
        "",
        f"## Findings (on `{head[:7]}`)",
        "",
    ]
    for index, comment in enumerate(comments, 1):
        path = str(comment.get("path") or "")
        line = comment.get("line")
        side = comment.get("side") if comment.get("side") in ("LEFT", "RIGHT") else "RIGHT"
        # A removed-side finding names old-file lines: pin it to the base blob,
        # where that file and those lines exist, not to the reviewed head.
        pin = base.lower() if side == "LEFT" else head.lower()
        permalink = f"https://github.com/{repo}/blob/{pin}/{path}#L{line}"
        lines.append(f"### {index}. `{path}:{line}` ({side}, [permalink]({permalink}))")
        lines.append("")
        lines.append(str(comment.get("body") or "").strip())
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def file_followup_issue(
    pwd: str,
    pr_ref: str,
    actor_name: str,
    title: str,
    body: str,
) -> dict:
    """File the capped round's follow-up issue; fail loudly, never half-publish.

    A rejected filing raises a contract violation: nothing is approved, so the
    findings stay visible as an unresolved round instead of merging silently.
    An uncertain filing (exit 0 without a receipt, a timeout, a transient
    GitHub error) raises a submission error: Poise reconciles before anything
    retries, and the retry reuses the issue via its marker.
    """
    limit = review_budget.timeout(600)
    progress.stage("filing_followup", "Filing the capped round's follow-up issue", timeout=limit)
    args = [
        os.getenv("GITHUB_INTERFACE_CLI", "github-interface"),
        "--create-pr-linked-issue",
        pr_ref,
        "--title",
        title,
        "--body",
        body,
        "--token-user",
        actor_name,
    ]
    try:
        done = subprocess.run(args, cwd=pwd, text=True, capture_output=True, timeout=limit)
    except subprocess.TimeoutExpired as error:
        raise review_receipt.SubmissionError(
            "follow-up issue filing timed out; publication uncertain, reconcile before retry") from error
    if done.returncode:
        transient = review_receipt.record_failure(done.stderr or done.stdout)
        if transient is not None:
            raise review_receipt.SubmissionError(transient)
        cause = bounded_cause((done.stderr or done.stdout).strip() or f"github-interface exited {done.returncode}")
        raise review_budget.ReviewLimitError(
            f"follow-up issue filing rejected: {cause}; nothing was approved",
            "review_contract_violation",
            diagnostic_envelope(operation="provider.review", phase="filing_followup", outcome="exit",
                                stderr=cause, submission="rejected"))
    try:
        reply = json.loads(done.stdout)
    except ValueError:
        reply = None
    if not isinstance(reply, dict) or reply.get("action") != "created_pr_linked_issue" \
            or not isinstance(reply.get("issue"), dict) or not isinstance(reply["issue"].get("number"), int):
        raise review_receipt.SubmissionError(
            "follow-up issue filing returned no receipt; publication uncertain, reconcile before retry")
    return reply["issue"]
