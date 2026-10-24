from typing import Any

from github_interface.atoms.pulls import enqueue_pull_request, get_pr_readiness_state, get_pull
from github_interface.behaviors.mergeable import QUEUE_ADMISSIBLE, queue_enabled, readiness_status, status
from github_interface.client import GitHubClient
from github_interface.context import expected_head
from github_interface.context import pull_number as parse_pull_number
from github_interface.context import repository

REQUIRE_TOKEN_USER = True

# The person's Merge button, built from merge_if_ready without the author
# check: the person merges any pull request, not only the agent's. Every
# determined outcome is returned, never raised: merged, enqueued, in_queue,
# already_merged, superseded, not_ready, or refused with GitHub's own words.
# Only unreadable evidence and transport failures raise.


def _login(value: Any) -> str | None:
    if isinstance(value, dict):
        login = value.get("login")
        return str(login) if login else None
    return None


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    number = parse_pull_number(payload)
    head = expected_head(payload)
    result = {
        "action": "merge_pr", "repository": f"{owner}/{repo}",
        "pull_number": number, "head_sha": head, "outcome": "not_ready",
    }

    pull = await get_pull(client, owner, repo, number)
    if (pull.get("head") or {}).get("sha") != head:
        return {**result, "outcome": "superseded", "actual_head": (pull.get("head") or {}).get("sha")}
    if pull.get("merged") is True:
        return {**result, "outcome": "already_merged",
                "merged_by": _login(pull.get("merged_by")),
                "merge_sha": pull.get("merge_commit_sha")}
    if pull.get("state") != "open" or pull.get("draft"):
        return result

    # The uncached packet pins checks and conversations to the same head.
    readiness = await get_pr_readiness_state(client, owner, repo, number)
    if readiness["headRefOid"] != head:
        return {**result, "outcome": "superseded", "actual_head": readiness["headRefOid"]}
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

    if queued:
        pull = await get_pull(client, owner, repo, number)
        if (pull.get("head") or {}).get("sha") != head:
            return {**result, "outcome": "superseded", "actual_head": (pull.get("head") or {}).get("sha")}
        if (pull.get("state") != "open" or pull.get("draft") or pull.get("mergeable") is not True
                or str(pull.get("mergeable_state") or "").upper() not in QUEUE_ADMISSIBLE):
            return result
        pull_id = readiness.get("id")
        if not isinstance(pull_id, str) or not pull_id:
            raise RuntimeError("GitHub returned no pull request node ID for queue admission")
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
        return {**result, "outcome": "superseded", "actual_head": (pull.get("head") or {}).get("sha")}
    if status(pull, None, 0) != "green":
        return result
    merged = await client.request(
        "PUT", f"/repos/{owner}/{repo}/pulls/{number}/merge",
        json={"sha": head, "merge_method": method},
    )
    if merged.get("merged") is not True:
        return {**result, "outcome": "refused",
                "message": merged.get("message") or f"GitHub refused to merge pull request #{number}"}
    return {**result, "outcome": "merged", "merge_sha": merged["sha"], "merge_method": method}
