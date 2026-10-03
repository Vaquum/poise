from datetime import datetime
from typing import Any

from github_interface.atoms.pulls import get_pull, list_commits, list_inline_comments, list_reviews
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

    actor_reviews = [
        review
        for review in reviews
        if _login(review) == username.lower()
        and review.get("state") in ACTIONABLE_STATES
        and review.get("submitted_at")
    ]
    actor_reviews.sort(key=lambda review: _time(review["submitted_at"]))
    latest_review = actor_reviews[-1] if actor_reviews else None
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
    addressed = bool(request_comments) and bool(commits_after_request or author_replies)
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
        "response_count": len(commits_after_request) + len(author_replies),
    }


def _login(item: dict[str, Any]) -> str:
    return ((item.get("user") or {}).get("login") or "").lower()


def _time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))
