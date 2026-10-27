from typing import Any

from github_interface.atoms.pulls import get_pr_readiness_state, get_pull
from github_interface.behaviors.mergeable import behind_status, readiness_behind
from github_interface.client import GitHubClient
from github_interface.context import expected_head
from github_interface.context import pull_number as parse_pull_number
from github_interface.context import repository

REQUIRE_TOKEN_USER = True


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    number = parse_pull_number(payload)
    head = expected_head(payload)
    author = str(payload.get("author") or "").strip()
    if not author:
        raise ValueError("author is required")
    result = {
        "action": "update_branch_if_behind", "repository": f"{owner}/{repo}",
        "pull_number": number, "head_sha": head, "outcome": "not_ready",
    }

    pull = await get_pull(client, owner, repo, number)
    if (pull.get("head") or {}).get("sha") != head:
        return {**result, "outcome": "superseded"}
    if pull.get("merged") is True:
        return result
    if str((pull.get("user") or {}).get("login") or "").lower() != author.lower():
        return result
    if behind_status(pull, None, 0) != "behind":
        return result

    # The uncached packet pins checks and conversations to the same head.
    readiness = await get_pr_readiness_state(client, owner, repo, number)
    if readiness["headRefOid"] != head:
        return {**result, "outcome": "superseded"}
    if readiness_behind(readiness) != "behind":
        return result

    pull = await get_pull(client, owner, repo, number)
    if (pull.get("head") or {}).get("sha") != head:
        return {**result, "outcome": "superseded"}
    if behind_status(pull, None, 0) != "behind" or str((pull.get("user") or {}).get("login") or "").lower() != author.lower():
        return result
    updated = await client.request(
        "PUT", f"/repos/{owner}/{repo}/pulls/{number}/update-branch",
        json={"expected_head_sha": head},
    )
    if not isinstance(updated, dict) or not updated.get("url"):
        raise RuntimeError(f"GitHub did not update the branch for pull request #{number}: {updated!r}")
    return {**result, "outcome": "updated"}
