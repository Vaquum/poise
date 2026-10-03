from typing import Any

from github_interface.atoms.issues import create_issue
from github_interface.client import GitHubClient
from github_interface.context import repository
from github_interface.identity import AGENT

IDENTITY = AGENT


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    title = str(payload.get("title", "")).strip()
    body = str(payload.get("body", "")).strip()
    if not title or not body:
        raise ValueError("title and body are required")

    issue = await create_issue(client, owner, repo, title, body)
    return {"action": "created_issue", "repository": f"{owner}/{repo}", "issue": issue}
