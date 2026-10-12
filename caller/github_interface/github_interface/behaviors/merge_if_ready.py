from typing import Any

from github_interface.atoms.pulls import get_pr_readiness_state, get_pull
from github_interface.behaviors.mergeable import status
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
        "action": "merge_if_ready", "repository": f"{owner}/{repo}",
        "pull_number": number, "head_sha": head, "outcome": "not_ready",
    }

    pull = await get_pull(client, owner, repo, number)
    if (pull.get("head") or {}).get("sha") != head:
        return {**result, "outcome": "superseded"}
    if pull.get("merged") is True:
        return {**result, "outcome": "already_merged"}
    if str((pull.get("user") or {}).get("login") or "").lower() != author.lower():
        return result
    if status(pull, None, 0) != "green":
        return result

    config = await client.get(f"/repos/{owner}/{repo}")
    method = next((method for method, flag in (
        ("squash", "allow_squash_merge"), ("merge", "allow_merge_commit"),
        ("rebase", "allow_rebase_merge"),
    ) if config.get(flag) is True), None)
    if method is None:
        raise RuntimeError("repository has no allowed merge method")

    # The uncached packet pins checks and conversations to the same head.
    readiness = await get_pr_readiness_state(client, owner, repo, number)
    if readiness["headRefOid"] != head:
        return {**result, "outcome": "superseded"}
    nodes = (readiness.get("commits") or {}).get("nodes") or []
    if not nodes or not nodes[0].get("commit"):
        return result
    commit = nodes[0]["commit"]
    if "statusCheckRollup" not in commit:
        return result
    checks = (commit["statusCheckRollup"] or {}).get("state")
    threads = readiness["reviewThreads"]
    unresolved = sum(not thread["isResolved"] and not thread["isOutdated"] for thread in threads["nodes"])
    current = {
        "state": readiness["state"].lower(), "draft": readiness["isDraft"],
        "mergeable": readiness["mergeable"] == "MERGEABLE",
        "mergeable_state": readiness["mergeStateStatus"].lower(),
    }
    if status(current, checks, unresolved, not threads["pageInfo"]["hasNextPage"]) != "green":
        return result

    pull = await get_pull(client, owner, repo, number)
    if (pull.get("head") or {}).get("sha") != head:
        return {**result, "outcome": "superseded"}
    if status(pull, checks, unresolved) != "green" or str((pull.get("user") or {}).get("login") or "").lower() != author.lower():
        return result
    merged = await client.request(
        "PUT", f"/repos/{owner}/{repo}/pulls/{number}/merge",
        json={"sha": head, "merge_method": method},
    )
    if merged.get("merged") is not True:
        raise RuntimeError(f"GitHub did not merge pull request #{number}: {merged.get('message')}")
    return {**result, "outcome": "merged", "merge_sha": merged["sha"], "merge_method": method}
