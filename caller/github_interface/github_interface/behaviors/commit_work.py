from typing import Any

from github_interface.atoms.local import commit_work
from github_interface.atoms.pulls import get_pull
from github_interface.client import GitHubClient
from github_interface.context import pull_number as parse_pull_number
from github_interface.context import repository

TOKEN_USER = "bit-mis"


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    pull_number = parse_pull_number(payload)
    message = str(payload.get("message", "")).strip()
    if not message:
        raise ValueError("message is required")

    pull = await get_pull(client, owner, repo, pull_number)
    head_repo = pull["head"]["repo"]["full_name"]
    head_ref = pull["head"]["ref"]
    committed = commit_work(head_repo, head_ref, message, client.token)
    return {
        "action": "commit_work",
        "repository": f"{owner}/{repo}",
        "pull_number": pull_number,
        "head_repo": head_repo,
        "head_ref": head_ref,
        **committed,
    }
