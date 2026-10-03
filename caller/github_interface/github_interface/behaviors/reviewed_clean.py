from typing import Any

from github_interface.atoms.pulls import comment_review, get_pull
from github_interface.client import GitHubClient
from github_interface.context import expected_head, pull_number, repository, token_user

REQUIRE_TOKEN_USER = True
REVIEW_BODY = "Reviewed: no blocking findings."


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    number = pull_number(payload)
    required_head = expected_head(payload)
    actor = token_user(payload)
    pull = await get_pull(client, owner, repo, number)
    actual_head = str((pull.get("head") or {}).get("sha") or "").lower()
    if pull.get("state") != "open" or pull.get("draft") is True:
        raise RuntimeError("pull request is not open and ready for review")
    if actual_head != required_head:
        raise RuntimeError(
            f"pull-request head changed: expected {required_head}, got {actual_head or 'missing'}"
        )

    review = await comment_review(
        client,
        owner,
        repo,
        number,
        required_head,
        REVIEW_BODY,
    )
    review_head = str(review.get("commit_id") or "").lower()
    review_actor = str((review.get("user") or {}).get("login") or "")
    if review.get("state") != "COMMENTED":
        raise RuntimeError("GitHub did not return a COMMENTED review")
    if review_head != required_head:
        raise RuntimeError(
            f"GitHub attached clean review to {review_head or 'missing'}, expected {required_head}"
        )
    if review_actor.lower() != actor.lower():
        raise RuntimeError(
            f"GitHub recorded clean review as {review_actor or 'missing'}, expected {actor}"
        )
    return {
        "action": "reviewed_clean",
        "repository": f"{owner}/{repo}",
        "pull_number": number,
        "actor": actor,
        "outcome": "clean",
        "head_sha": required_head,
        "review_id": review.get("id"),
        "submitted_at": review.get("submitted_at"),
    }
