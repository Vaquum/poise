from datetime import datetime
from typing import Any

from github_interface.atoms.pulls import get_review_activity, list_review_threads
from github_interface.client import GitHubClient
from github_interface.context import pull_number as parse_pull_number
from github_interface.context import repository, token_user

REQUIRE_TOKEN_USER = True
ACTIONABLE_REVIEW_STATES = {"APPROVED", "CHANGES_REQUESTED", "DISMISSED"}


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    pull_number = parse_pull_number(payload)
    username = str(payload.get("username", "")).strip()
    if not username:
        raise ValueError("username is required")
    actor = token_user(payload)
    if actor.lower() != username.lower():
        raise ValueError("username must match token-user")
    since = _time(str(payload.get("since", "")), "since")

    pull = await get_review_activity(client, owner, repo, pull_number)
    threads = await list_review_threads(client, owner, repo, pull_number)
    unresolved = [thread for thread in threads if not thread["is_resolved"]]
    unresolved_live = [thread for thread in unresolved if not thread["is_outdated"]]
    head_sha = str(pull.get("headRefOid") or "")
    if not head_sha:
        raise RuntimeError("GitHub returned no pull-request head SHA")

    requested_reviewers = sorted(
        {
            str((node.get("requestedReviewer") or {}).get("login") or "")
            for node in pull["reviewRequests"]
            if (node.get("requestedReviewer") or {}).get("login")
        },
        key=str.lower,
    )
    reviews = sorted(
        pull["reviews"],
        key=lambda review: _time(str(review.get("submittedAt") or ""), "review submittedAt"),
    )
    reviewer_reviews = [review for review in reviews if _login(review) == username.lower()]
    latest_reviews: dict[str, dict[str, Any]] = {}
    for review in reviews:
        login = _login(review)
        if login and review.get("state") in ACTIONABLE_REVIEW_STATES:
            latest_reviews[login] = review

    activity_times = [
        _time(str(pull.get("updatedAt") or ""), "pull updatedAt"),
        *(_event_time(review, "submittedAt", "updatedAt") for review in reviews),
    ]
    activity_since = [value for value in activity_times if value > since]
    username_lower = username.lower()
    reviewer_change_requests_since = sum(
        1
        for review in reviews
        if _login(review) == username_lower
        and review.get("state") == "CHANGES_REQUESTED"
        and _event_time(review, "submittedAt", "updatedAt") > since
    )
    reviewer_approvals_since = sum(
        1
        for review in reviews
        if _login(review) == username_lower
        and review.get("state") == "APPROVED"
        and _event_time(review, "submittedAt", "updatedAt") > since
    )
    reviewer_comments_since = sum(
        1
        for review in reviewer_reviews
        if review.get("state") == "COMMENTED"
        and _event_time(review, "submittedAt", "updatedAt") > since
    )
    # Each review the reviewer posted since, by the id a submission returns,
    # so a run can tell its own review from a sibling's on the same head.
    reviewer_reviews_since_items = [
        {
            "id": review.get("databaseId"),
            "node_id": review.get("id"),
            "state": review.get("state"),
            "commit": (review.get("commit") or {}).get("oid"),
            "submitted_at": review.get("submittedAt"),
        }
        for review in reviewer_reviews
        if _event_time(review, "submittedAt", "updatedAt") > since
    ]
    reviewer_reviews_since = len(reviewer_reviews_since_items)
    reviewer_pending_reviews = sum(
        1
        for review in reviews
        if _login(review) == username_lower
        and review.get("state") == "PENDING"
    )
    reviewer_latest = latest_reviews.get(username_lower)
    reviewer_latest_any = reviewer_reviews[-1] if reviewer_reviews else None

    return {
        "action": "review_activity_since",
        "repository": f"{owner}/{repo}",
        "pull_number": pull_number,
        "username": username,
        "since": _iso(since),
        "state": pull["state"],
        "draft": pull["isDraft"],
        "head_sha": head_sha,
        "pull_updated_at": pull["updatedAt"],
        "requested_reviewers": requested_reviewers,
        "reviewer_requested": any(login.lower() == username_lower for login in requested_reviewers),
        "active_change_request_authors": sorted(
            login
            for login, review in latest_reviews.items()
            if review.get("state") == "CHANGES_REQUESTED"
        ),
        "unresolved_conversation_count": len(unresolved),
        "unresolved_outdated_conversation_count": len(unresolved) - len(unresolved_live),
        "unresolved_live_conversation_count": len(unresolved_live),
        "unresolved_conversation_authors": sorted(
            {thread["author"] for thread in unresolved if thread["author"]},
            key=str.lower,
        ),
        "unresolved_live_conversation_authors": sorted(
            {thread["author"] for thread in unresolved_live if thread["author"]},
            key=str.lower,
        ),
        "reviewer_latest_state": reviewer_latest.get("state") if reviewer_latest else None,
        "reviewer_latest_commit": (
            (reviewer_latest.get("commit") or {}).get("oid") if reviewer_latest else None
        ),
        "reviewer_latest_review_id": reviewer_latest.get("id") if reviewer_latest else None,
        "reviewer_latest_submitted_at": (
            reviewer_latest.get("submittedAt") if reviewer_latest else None
        ),
        "reviewer_change_requests_since": reviewer_change_requests_since,
        "reviewer_approvals_since": reviewer_approvals_since,
        "reviewer_comments_since": reviewer_comments_since,
        "reviewer_latest_any_state": reviewer_latest_any.get("state") if reviewer_latest_any else None,
        "reviewer_latest_any_commit": (
            (reviewer_latest_any.get("commit") or {}).get("oid") if reviewer_latest_any else None
        ),
        "reviewer_latest_any_review_id": reviewer_latest_any.get("id") if reviewer_latest_any else None,
        "reviewer_latest_any_submitted_at": (
            reviewer_latest_any.get("submittedAt") if reviewer_latest_any else None
        ),
        "reviewer_reviews_since": reviewer_reviews_since,
        "reviewer_reviews_since_items": reviewer_reviews_since_items,
        "reviewer_pending_reviews": reviewer_pending_reviews,
        "reviews_since": _count_since(reviews, since, "submittedAt", "updatedAt"),
        "latest_activity_at": _iso(max(activity_since)) if activity_since else None,
    }


def _login(item: dict[str, Any]) -> str:
    return str((item.get("author") or {}).get("login") or "").lower()


def _event_time(item: dict[str, Any], created: str, updated: str) -> datetime:
    values = [
        _time(str(item[field]), field)
        for field in (created, updated)
        if item.get(field)
    ]
    if not values:
        raise ValueError(f"review has neither {created} nor {updated}")
    return max(values)


def _count_since(items: list[dict[str, Any]], since: datetime, created: str, updated: str) -> int:
    return sum(1 for item in items if _event_time(item, created, updated) > since)


def _time(value: str, field: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"{field} must be an ISO-8601 timestamp") from error
    if parsed.tzinfo is None:
        raise ValueError(f"{field} must include a timezone")
    return parsed


def _iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")
