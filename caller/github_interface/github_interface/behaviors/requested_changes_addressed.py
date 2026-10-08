from datetime import datetime
from typing import Any

from github_interface.atoms.issues import issue_comments
from github_interface.atoms.pulls import get_pull, list_commits, list_inline_comments, list_review_threads, list_reviews
from github_interface.behaviors.request_changes import REAFFIRM_BODY
from github_interface.client import GitHubClient
from github_interface.context import pull_number as parse_pull_number
from github_interface.context import repository, token_user

REQUIRE_TOKEN_USER = True
ACTIONABLE_STATES = {"APPROVED", "CHANGES_REQUESTED", "DISMISSED"}


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    pull_number = parse_pull_number(payload)
    username = str(payload.get("username", "")).strip()
    if not username:
        raise ValueError("username is required")
    actor = token_user(payload)
    if actor.lower() != username.lower():
        raise ValueError("username must match token-user")

    pull = await get_pull(client, owner, repo, pull_number)
    reviews = await list_reviews(client, owner, repo, pull_number)
    comments = await list_inline_comments(client, owner, repo, pull_number)
    commits = await list_commits(client, owner, repo, pull_number)
    public_comments = await issue_comments(client, owner, repo, pull_number)
    threads = await list_review_threads(client, owner, repo, pull_number)

    actor_reviews = [
        review
        for review in reviews
        if _login(review) == username.lower()
        and review.get("submitted_at")
    ]
    actor_reviews.sort(key=lambda review: _time(review["submitted_at"]))
    actionable_reviews = [review for review in actor_reviews if review.get("state") in ACTIONABLE_STATES]
    latest_review = actionable_reviews[-1] if actionable_reviews else None
    request_review = (
        latest_review
        if latest_review and latest_review.get("state") == "CHANGES_REQUESTED"
        else None
    )
    request_ids = {request_review["id"]} if request_review else set()
    request_comments = [
        comment
        for comment in comments
        if comment.get("pull_request_review_id") in request_ids and _login(comment) == username.lower()
    ]
    latest_request_at = _time(request_review["submitted_at"]) if request_review else None
    author = _login(pull)

    # Use committer.date (when the commit was actually applied to the
    # branch), not author.date — author.date is preserved across rebase
    # and amend, so a fix-up commit prepared earlier and rebased onto
    # the branch after the review looks "old" to the date check and
    # gets counted as 0, blocking approve-prs from re-firing. The
    # committer date updates whenever the commit object is rewritten,
    # which is the signal we actually want here.
    commits_after_request = [
        commit
        for commit in commits
        if latest_request_at
        and _time(commit["commit"]["committer"]["date"]) > latest_request_at
    ]
    request_thread_ids = {comment.get("in_reply_to_id") or comment.get("id") for comment in request_comments if comment.get("in_reply_to_id") or comment.get("id")}
    author_replies = [
        comment
        for comment in comments
        if latest_request_at
        and comment.get("in_reply_to_id") in request_thread_ids
        and _login(comment) == author
        and _time(comment["created_at"]) > latest_request_at
    ]
    author_pr_comments = [
        comment
        for comment in public_comments
        if latest_request_at
        and _login(comment) == author
        and _time(comment["created_at"]) > latest_request_at
    ]
    # Resolution has no timestamp in GitHub's thread state. Match the active
    # request's exact root comments instead of treating old resolved threads as
    # responses. A summary-only reaffirmation can repeat a COMMENTED finding
    # as well as a change request, ending at an approval or dismissal.
    resolution_review_ids = set(request_ids)
    if request_review and not request_comments and request_review.get("body") == REAFFIRM_BODY:
        for review in reversed(actor_reviews):
            if review["state"] in {"APPROVED", "DISMISSED"}:
                break
            if review["state"] in {"CHANGES_REQUESTED", "COMMENTED"}:
                resolution_review_ids.add(review["id"])
    resolution_thread_ids = {
        comment.get("in_reply_to_id") or comment["id"]
        for comment in comments
        if comment.get("pull_request_review_id") in resolution_review_ids
        and _login(comment) == username.lower()
    }
    resolution_threads = [
        thread for thread in threads if thread["root_comment_id"] in resolution_thread_ids
    ]
    if len(resolution_threads) != len(resolution_thread_ids):
        raise RuntimeError("GitHub review-thread inventory is missing change-request root comments")
    resolved_request_threads = (
        len(resolution_threads)
        if resolution_thread_ids
        and all(thread["is_resolved"] for thread in resolution_threads)
        else 0
    )
    response_count = (
        len(commits_after_request) + len(author_replies) + len(author_pr_comments)
        + resolved_request_threads
    )
    addressed = request_review is not None and response_count > 0
    head_sha = str((pull.get("head") or {}).get("sha") or "").lower()
    if len(head_sha) != 40:
        raise RuntimeError("GitHub returned no pull-request head SHA")

    return {
        "action": "requested_changes_addressed",
        "repository": f"{owner}/{repo}",
        "pull_number": pull_number,
        "username": username,
        "pr_author": pull["user"]["login"],
        "status": addressed,
        "has_change_request": request_review is not None,
        "reviewer_latest_state": latest_review.get("state") if latest_review else None,
        "reviewer_latest_commit": latest_review.get("commit_id") if latest_review else None,
        "request_review_id": request_review.get("id") if request_review else None,
        "request_reviews": 1 if request_review else 0,
        "request_inline_comments": len(request_comments),
        "latest_request_at": latest_request_at.isoformat() if latest_request_at else None,
        "head_sha": head_sha,
        "commits_after_request": len(commits_after_request),
        "author_commits_after_request": len(commits_after_request),
        "author_inline_replies_after_request": len(author_replies),
        "author_pr_comments_after_request": len(author_pr_comments),
        "resolved_request_threads": resolved_request_threads,
        "response_count": response_count,
    }


def _login(item: dict[str, Any]) -> str:
    return ((item.get("user") or {}).get("login") or "").lower()


def _time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))
