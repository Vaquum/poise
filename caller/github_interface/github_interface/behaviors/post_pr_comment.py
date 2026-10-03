from typing import Any

from github_interface.atoms.pulls import post_pr_comment
from github_interface.client import GitHubClient
from github_interface.context import pull_number, repository

TOKEN_USER = "bit-mis"


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    number = pull_number(payload)
    body = str(payload.get("body", "")).strip()
    if not body:
        raise ValueError("body is required")

    comment = await post_pr_comment(client, owner, repo, number, body)
    return {"action": "posted_pr_comment", "repository": f"{owner}/{repo}", "pull_number": number, "comment": comment}
