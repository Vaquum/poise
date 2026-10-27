from typing import Any

from github_interface.atoms.pulls import get_requested_review_state
from github_interface.client import GitHubClient
from github_interface.context import pull_number as parse_pull_number
from github_interface.context import repository, token_user

REQUIRE_TOKEN_USER = True


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    pull_number = parse_pull_number(payload)
    username = str(payload.get("username", "")).strip()
    if not username:
        raise ValueError("username is required")
    actor = token_user(payload)
    if username.lower() != actor.lower():
        raise ValueError("username must match token-user")

    pull = await get_requested_review_state(client, owner, repo, pull_number)
    username_lower = username.lower()
    requests = pull["reviewRequests"]
    reviews = pull["reviews"]
    requested = (
        not requests["pageInfo"]["hasNextPage"]
        and any(
            str((node.get("requestedReviewer") or {}).get("login") or "").lower()
            == username_lower
            for node in requests["nodes"]
        )
    )
    latest_review_states: dict[str, str] = {}
    for review in reviews["nodes"]:
        login = str((review.get("author") or {}).get("login") or "").lower()
        state = str(review.get("state") or "")
        if login and state in {"APPROVED", "CHANGES_REQUESTED", "DISMISSED"}:
            latest_review_states[login] = state
    blocked_by_other_change_request = reviews["pageInfo"]["hasNextPage"] or any(
        login != username_lower and state == "CHANGES_REQUESTED"
        for login, state in latest_review_states.items()
    )
    rollup = ((pull.get("commits") or {}).get("nodes") or [{}])[0]
    rollup_state = (
        ((rollup.get("commit") or {}).get("statusCheckRollup") or {}).get("state")
    )
    checks_green = rollup_state in {None, "SUCCESS"}
    head_sha = str(pull.get("headRefOid") or "")
    ready = (
        pull.get("state") == "OPEN"
        and pull.get("isDraft") is False
        and pull.get("mergeable") == "MERGEABLE"
        and requested
        and not blocked_by_other_change_request
        and checks_green
    )
    if ready and not head_sha:
        raise RuntimeError("GitHub returned a ready review request without a head SHA")

    return {
        "action": "requested_review_ready",
        "repository": f"{owner}/{repo}",
        "pull_number": pull_number,
        "username": username,
        "ready": ready,
        "requested": requested,
        "head_sha": head_sha,
        "state": pull.get("state"),
        "draft": pull.get("isDraft"),
        "mergeable": pull.get("mergeable"),
        "checks_green": checks_green,
        "blocked_by_other_change_request": blocked_by_other_change_request,
    }
