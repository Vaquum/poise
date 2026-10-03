from typing import Any

from github_interface.atoms.issues import issue_comments
from github_interface.client import GitHubClient
from github_interface.context import issue_number, repository

TOKEN_USER = "bit-mis"


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    number = issue_number(payload)
    comments = await issue_comments(client, owner, repo, number)
    return {
        "action": "issue_comments",
        "repository": f"{owner}/{repo}",
        "issue_number": number,
        "comments": [
            {
                "id": comment["id"],
                "author": (comment.get("user") or {}).get("login"),
                "body": comment.get("body") or "",
                "created_at": comment.get("created_at"),
                "updated_at": comment.get("updated_at"),
                "url": comment.get("html_url"),
            }
            for comment in comments
        ],
    }
