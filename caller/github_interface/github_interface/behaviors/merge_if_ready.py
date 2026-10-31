from typing import Any

from github_interface.atoms.pulls import enqueue_pull_request, get_pr_readiness_state, get_pull, list_reviews
from github_interface.atoms.review_response import context_sha, matches_review, qualifying_response
from github_interface.behaviors.mergeable import QUEUE_ADMISSIBLE, queue_enabled, readiness_status, status
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
    if pull.get("state") != "open" or pull.get("draft"):
        return result

    # The uncached packet pins checks and conversations to the same head.
    readiness = await get_pr_readiness_state(client, owner, repo, number)
    if readiness["headRefOid"] != head:
        return {**result, "outcome": "superseded"}
    queued = queue_enabled(readiness)
    entry = readiness.get("mergeQueueEntry")
    if queued and entry is not None:
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or not entry["id"]:
            raise RuntimeError("GitHub returned malformed merge queue entry evidence")
        # Observation is idempotent even while the queue's integration checks run.
        return {**result, "outcome": "in_queue", "queue_entry_id": entry["id"]}
    if not queued and status(pull, None, 0) != "green":
        return result
    if readiness_status(readiness) != "green":
        return result

    response = payload.get("review_response")
    actor = str(payload.get("token_user") or "")
    if not qualifying_response(response, pull, f"{owner}/{repo}", number, head, actor):
        return {**result, "reason": "completed substantive final-context review response required", "review_context": context_sha(pull)}
    if not any(matches_review(response, review) for review in await list_reviews(client, owner, repo, number)):
        return {**result, "reason": "final-context review response is unverified", "review_context": context_sha(pull)}

    if queued:
        pull = await get_pull(client, owner, repo, number)
        if (pull.get("head") or {}).get("sha") != head:
            return {**result, "outcome": "superseded"}
        if (pull.get("state") != "open" or pull.get("draft") or pull.get("mergeable") is not True
                or str(pull.get("mergeable_state") or "").upper() not in QUEUE_ADMISSIBLE
                or str((pull.get("user") or {}).get("login") or "").lower() != author.lower()):
            return result
        pull_id = readiness.get("id")
        if not isinstance(pull_id, str) or not pull_id:
            raise RuntimeError("GitHub returned no pull request node ID for queue admission")
        if not qualifying_response(response, pull, f"{owner}/{repo}", number, head, actor):
            return {**result, "reason": "final-context review response is unverified", "review_context": context_sha(pull)}
        entry = await enqueue_pull_request(client, pull_id, head)
        return {**result, "outcome": "enqueued", "queue_entry_id": entry["id"]}

    config = await client.get(f"/repos/{owner}/{repo}")
    method = next((method for method, flag in (
        ("squash", "allow_squash_merge"), ("merge", "allow_merge_commit"),
        ("rebase", "allow_rebase_merge"),
    ) if config.get(flag) is True), None)
    if method is None:
        raise RuntimeError("repository has no allowed merge method")

    pull = await get_pull(client, owner, repo, number)
    if (pull.get("head") or {}).get("sha") != head:
        return {**result, "outcome": "superseded"}
    if status(pull, None, 0) != "green" or str((pull.get("user") or {}).get("login") or "").lower() != author.lower():
        return result
    if not qualifying_response(response, pull, f"{owner}/{repo}", number, head, actor):
        return {**result, "reason": "final-context review response is unverified", "review_context": context_sha(pull)}
    merged = await client.request(
        "PUT", f"/repos/{owner}/{repo}/pulls/{number}/merge",
        json={"sha": head, "merge_method": method},
    )
    if merged.get("merged") is not True:
        raise RuntimeError(f"GitHub did not merge pull request #{number}: {merged.get('message')}")
    return {**result, "outcome": "merged", "merge_sha": merged["sha"], "merge_method": method}
