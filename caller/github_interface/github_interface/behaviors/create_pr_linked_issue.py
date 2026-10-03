from typing import Any

from github_interface.atoms.issues import create_issue
from github_interface.client import GitHubClient
from github_interface.context import pull_number, repository

REQUIRE_TOKEN_USER = True


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    number = pull_number(payload)
    title = str(payload.get("title", "")).strip()
    body = str(payload.get("body", "")).strip()
    if not title or not body:
        raise ValueError("title and body are required")

    url = f"https://github.com/{owner}/{repo}/pull/{number}"
    issue = await create_issue(client, owner, repo, title, f"{body}\n\nRelated PR: {url}")
    return {"action": "created_pr_linked_issue", "repository": f"{owner}/{repo}", "pull_number": number, "issue": issue}
