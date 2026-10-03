from typing import Any

from github_interface.atoms.pulls import get_pr_readiness_state
from github_interface.client import GitHubClient
from github_interface.context import expected_head
from github_interface.context import pull_number as parse_pull_number
from github_interface.context import repository
from github_interface.identity import PERSON

IDENTITY = PERSON


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    pull_number = parse_pull_number(payload)
    required_head = expected_head(payload)
    username = str(payload.get("username") or "").strip()
    if not username:
        raise ValueError("username is required")

    pull = await get_pr_readiness_state(client, owner, repo, pull_number)
    actual_head = str(pull.get("headRefOid") or "").lower()
    if actual_head != required_head:
        return _superseded(owner, repo, pull_number, required_head, actual_head)

    reviews = pull["reviews"]
    threads = pull["reviewThreads"]
    approval = _approval_state(reviews["nodes"], username, required_head)
    commit = (((pull.get("commits") or {}).get("nodes") or [{}])[0].get("commit") or {})
    rollup_state = (commit.get("statusCheckRollup") or {}).get("state")
    unresolved_live = [
        thread
        for thread in threads["nodes"]
        if not thread["isResolved"] and not thread["isOutdated"]
    ]
    blockers = _blockers(
        pull,
        approval,
        rollup_state,
        unresolved_live,
        reviews["pageInfo"]["hasNextPage"] or threads["pageInfo"]["hasNextPage"],
    )
    return {
        "action": "pr_readiness",
        "repository": f"{owner}/{repo}",
        "pull_number": pull_number,
        "outcome": "green" if not blockers else "blocked",
        "green": not blockers,
        "head_sha": required_head,
        "state": pull.get("state"),
        "draft": pull.get("isDraft"),
        "github_mergeable": pull.get("mergeable"),
        "github_mergeable_state": pull.get("mergeStateStatus"),
        "checks_state": rollup_state,
        "reviewer_approved_current_head": approval["reviewer_approved_current_head"],
        "changes_requested": approval["changes_requested"],
        "unresolved_live_conversation_count": len(unresolved_live),
        "blockers": blockers,
    }


def _approval_state(
    reviews: list[dict[str, Any]],
    username: str,
    head_sha: str,
) -> dict[str, bool]:
    latest: dict[str, dict[str, str]] = {}
    for review in sorted(reviews, key=lambda item: str(item.get("submittedAt") or "")):
        state = str(review.get("state") or "")
        if state not in {"APPROVED", "CHANGES_REQUESTED", "DISMISSED"}:
            continue
        login = str((review.get("author") or {}).get("login") or "").lower()
        if login:
            latest[login] = {
                "state": state,
                "commit_id": str((review.get("commit") or {}).get("oid") or "").lower(),
            }
    reviewer = latest.get(username.lower())
    return {
        "reviewer_approved_current_head": bool(
            reviewer
            and reviewer["state"] == "APPROVED"
            and reviewer["commit_id"] == head_sha
        ),
        "changes_requested": any(
            review["state"] == "CHANGES_REQUESTED" for review in latest.values()
        ),
    }


def _blockers(
    pull: dict[str, Any],
    approval: dict[str, bool],
    checks_state: str | None,
    unresolved_live: list[dict[str, Any]],
    pagination_incomplete: bool,
) -> list[str]:
    blockers = []
    if pull.get("state") != "OPEN":
        blockers.append("pull_not_open")
    if pull.get("isDraft"):
        blockers.append("draft")
    if pull.get("mergeable") != "MERGEABLE":
        blockers.append("not_mergeable")
    if pull.get("mergeStateStatus") != "CLEAN":
        blockers.append("merge_state_not_clean")
    if checks_state is None:
        blockers.append("checks_missing")
    elif checks_state != "SUCCESS":
        blockers.append("required_checks_not_green")
    if not approval["reviewer_approved_current_head"]:
        blockers.append("reviewer_not_approved_current_head")
    if approval["changes_requested"]:
        blockers.append("changes_requested")
    if unresolved_live:
        blockers.append("unresolved_live_conversations")
    if pagination_incomplete:
        blockers.append("readiness_pagination_incomplete")
    return blockers


def _superseded(
    owner: str,
    repo: str,
    pull_number: int,
    expected: str,
    actual: str,
) -> dict[str, Any]:
    return {
        "action": "pr_readiness",
        "repository": f"{owner}/{repo}",
        "pull_number": pull_number,
        "outcome": "superseded",
        "green": False,
        "head_sha": expected,
        "current_head_sha": actual,
        "blockers": ["head_changed"],
    }
