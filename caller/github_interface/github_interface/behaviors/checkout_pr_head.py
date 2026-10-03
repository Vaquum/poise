from typing import Any

from github_interface.atoms.local import checkout_pr_head
from github_interface.client import GitHubClient
from github_interface.context import pull_number as parse_pull_number
from github_interface.context import repository
from github_interface.identity import AGENT

IDENTITY = AGENT


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    pull_number = parse_pull_number(payload)
    checkout = checkout_pr_head(owner, repo, pull_number, client.token)
    return {
        "action": "checkout_pr_head",
        "repository": f"{owner}/{repo}",
        "pull_number": pull_number,
        **checkout,
    }
