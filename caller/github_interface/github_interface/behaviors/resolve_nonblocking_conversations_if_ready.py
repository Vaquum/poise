from typing import Any

from github_interface.atoms.pulls import (
    get_combined_status,
    get_pull,
    get_pull_check_rollup,
    list_review_threads,
    list_reviews,
    resolve_conversation,
)
from github_interface.client import GitHubClient
from github_interface.context import expected_head
from github_interface.context import pull_number as parse_pull_number
from github_interface.context import repository, token_user

REQUIRE_TOKEN_USER = True


class HeadChanged(RuntimeError):
    def __init__(self, expected: str, actual: str, phase: str) -> None:
        self.actual = actual
        super().__init__(
            f"pull-request head changed {phase}: "
            f"expected {expected}, got {actual or 'missing'}"
        )


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    pull_number = parse_pull_number(payload)
    required_head = expected_head(payload)
    username = str(payload.get("username") or "").strip()
    actor = token_user(payload)
    if not username:
        raise ValueError("username is required")
    if username.lower() != actor.lower():
        raise ValueError("username must match token-user")

    try:
        gate = await _read_gate(
            client,
            owner,
            repo,
            pull_number,
            required_head,
            username,
        )
    except HeadChanged as error:
        return {
            "action": "resolved_nonblocking_conversations_if_ready",
            "repository": f"{owner}/{repo}",
            "pull_number": pull_number,
            "outcome": "superseded",
            "head_sha": required_head,
            "current_head_sha": error.actual,
        }
    threads = await list_review_threads(client, owner, repo, pull_number)

    unresolved = [thread for thread in threads if not thread["is_resolved"]]
    if not gate["ready"]:
        return _result(
            owner,
            repo,
            pull_number,
            required_head,
            False,
            0,
            len(unresolved),
            gate["approval"],
            gate["statuses_green"],
            gate["checks_green"],
            gate["checks_present"],
            gate["blockers"],
            [],
        )

    resolved = []
    for thread in unresolved:
        current_gate = await _read_gate(
            client,
            owner,
            repo,
            pull_number,
            required_head,
            username,
        )
        if not current_gate["ready"]:
            raise RuntimeError(
                f"pull request stopped being ready before resolving thread {thread['id']}"
            )
        current_threads = await list_review_threads(client, owner, repo, pull_number)
        current_thread = next(
            (candidate for candidate in current_threads if candidate["id"] == thread["id"]),
            None,
        )
        if current_thread is None:
            raise RuntimeError(f"review thread disappeared before resolution: {thread['id']}")
        if current_thread["is_resolved"]:
            continue
        result = await resolve_conversation(client, thread["id"])
        if result.get("id") != thread["id"] or result.get("isResolved") is not True:
            raise RuntimeError(f"GitHub did not resolve review thread {thread['id']}")
        resolved.append(result)

    final_gate = await _read_gate(
        client,
        owner,
        repo,
        pull_number,
        required_head,
        username,
    )
    if not final_gate["ready"]:
        raise RuntimeError("pull request stopped being ready after conversation resolution")
    final_threads = await list_review_threads(client, owner, repo, pull_number)
    final_unresolved = [thread for thread in final_threads if not thread["is_resolved"]]
    if final_unresolved:
        raise RuntimeError(
            f"{len(final_unresolved)} unresolved review conversation(s) remain after resolution"
        )
    return _result(
        owner,
        repo,
        pull_number,
        required_head,
        True,
        len(resolved),
        0,
        final_gate["approval"],
        final_gate["statuses_green"],
        final_gate["checks_green"],
        final_gate["checks_present"],
        final_gate["blockers"],
        resolved,
    )


async def _read_gate(
    client: GitHubClient,
    owner: str,
    repo: str,
    pull_number: int,
    expected_head_sha: str,
    username: str,
) -> dict[str, Any]:
    pull = await get_pull(client, owner, repo, pull_number)
    _assert_head(pull, expected_head_sha, "during readiness check")
    reviews = await list_reviews(client, owner, repo, pull_number)
    status = await get_combined_status(client, owner, repo, expected_head_sha)
    rollup = await get_pull_check_rollup(client, owner, repo, pull_number)
    _assert_head(
        {"head": {"sha": rollup.get("headRefOid")}},
        expected_head_sha,
        "during check rollup",
    )
    approval = _approval_state(reviews, username, expected_head_sha)
    statuses_green = _statuses_green(status)
    commit = (
        ((rollup.get("commits") or {}).get("nodes") or [{}])[0].get("commit")
        or {}
    )
    rollup_state = (commit.get("statusCheckRollup") or {}).get("state")
    checks_green = rollup_state in {None, "SUCCESS"}
    checks_present = bool(
        (status.get("statuses") or []) or rollup_state is not None
    )
    blockers = _blockers(
        pull,
        approval,
        statuses_green,
        checks_green,
        checks_present,
    )
    ready = not blockers
    return {
        "ready": ready,
        "approval": approval,
        "statuses_green": statuses_green,
        "checks_green": checks_green,
        "checks_present": checks_present,
        "blockers": blockers,
    }


def _blockers(
    pull: dict[str, Any],
    approval: dict[str, Any],
    statuses_green: bool,
    checks_green: bool,
    checks_present: bool,
) -> list[str]:
    blockers = []
    if pull.get("state") != "open":
        blockers.append("pull_not_open")
    if pull.get("draft"):
        blockers.append("draft")
    if pull.get("mergeable") is not True:
        blockers.append("not_mergeable")
    if not approval["reviewer_approved_current_head"]:
        blockers.append("reviewer_not_approved_current_head")
    if approval["changes_requested"]:
        blockers.append("changes_requested")
    if not checks_present:
        blockers.append("checks_missing")
    if not statuses_green:
        blockers.append("commit_status_failed")
    if not checks_green:
        blockers.append("required_checks_not_green")
    return blockers


def _assert_head(pull: dict[str, Any], expected: str, phase: str) -> None:
    actual = str((pull.get("head") or {}).get("sha") or "").lower()
    if actual != expected:
        raise HeadChanged(expected, actual, phase)


def _approval_state(
    reviews: list[dict[str, Any]], username: str, expected_head_sha: str
) -> dict[str, Any]:
    latest: dict[str, dict[str, str]] = {}
    ordered = sorted(reviews, key=lambda review: str(review.get("submitted_at") or ""))
    for review in ordered:
        state = str(review.get("state") or "")
        if state not in {"APPROVED", "CHANGES_REQUESTED", "DISMISSED"}:
            continue
        user = str((review.get("user") or {}).get("login") or "").lower()
        if user:
            latest[user] = {
                "state": state,
                "commit_id": str(review.get("commit_id") or "").lower(),
            }

    reviewer = latest.get(username.lower())
    return {
        "reviewer_approved_current_head": bool(
            reviewer
            and reviewer["state"] == "APPROVED"
            and reviewer["commit_id"] == expected_head_sha
        ),
        "changes_requested": any(
            review["state"] == "CHANGES_REQUESTED" for review in latest.values()
        ),
        "latest_reviews": latest,
    }


def _statuses_green(status: dict[str, Any]) -> bool:
    return all(
        item.get("state") == "success" for item in (status.get("statuses") or [])
    )


def _result(
    owner: str,
    repo: str,
    pull_number: int,
    head_sha: str,
    ready: bool,
    resolved_count: int,
    unresolved_count: int,
    approval: dict[str, Any],
    statuses_green: bool,
    checks_green: bool,
    checks_present: bool,
    blockers: list[str],
    conversations: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "action": "resolved_nonblocking_conversations_if_ready",
        "repository": f"{owner}/{repo}",
        "pull_number": pull_number,
        "head_sha": head_sha,
        "ready_except_conversations": ready,
        "reviewer_approved_current_head": approval["reviewer_approved_current_head"],
        "changes_requested": approval["changes_requested"],
        "statuses_green": statuses_green,
        "checks_green": checks_green,
        "checks_present": checks_present,
        "blockers": blockers,
        "resolved_count": resolved_count,
        "unresolved_count": unresolved_count,
        "latest_reviews": approval["latest_reviews"],
        "conversations": conversations,
    }
