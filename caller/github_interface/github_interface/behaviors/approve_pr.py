from typing import Any

from github_interface.atoms.pulls import approve_pr, get_pull, list_review_threads
from github_interface.client import GitHubClient
from github_interface.context import expected_head, pull_number, repository, token_user

REQUIRE_TOKEN_USER = True


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    number = pull_number(payload)
    required_head = expected_head(payload)
    actor = token_user(payload)
    pull = await get_pull(client, owner, repo, number)
    if pull.get("state") != "open" or pull.get("draft") is True:
        raise RuntimeError("pull request is not open and ready for review")
    threads = await list_review_threads(client, owner, repo, number)
    unresolved_other = [
        thread
        for thread in threads
        if not thread["is_resolved"]
        and not thread["is_outdated"]
        and thread["author"].lower() != actor.lower()
    ]
    if unresolved_other:
        raise RuntimeError(
            f"{len(unresolved_other)} unresolved review conversation(s) from other reviewers remain"
        )

    review = await approve_pr(client, owner, repo, number, required_head)
    review_head = str(review.get("commit_id") or "").lower()
    review_actor = str((review.get("user") or {}).get("login") or "")
    if review.get("state") != "APPROVED":
        raise RuntimeError("GitHub did not return an APPROVED review")
    if review_head != required_head:
        raise RuntimeError(
            f"GitHub attached approval to {review_head or 'missing'}, expected {required_head}"
        )
    if review_actor.lower() != actor.lower():
        raise RuntimeError(
            f"GitHub recorded approval as {review_actor or 'missing'}, expected {actor}"
        )
    return {
        "action": "approved_pr",
        "repository": f"{owner}/{repo}",
        "pull_number": number,
        "actor": actor,
        "outcome": "approved",
        "head_sha": required_head,
        "review_id": review.get("id"),
        "submitted_at": review.get("submitted_at"),
    }
