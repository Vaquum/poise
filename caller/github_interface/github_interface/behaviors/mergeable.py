import asyncio
from typing import Any

from github_interface.atoms.pulls import get_pull
from github_interface.client import GitHubClient
from github_interface.context import pull_number as parse_pull_number
from github_interface.context import repository
from github_interface.identity import AGENT

IDENTITY = AGENT


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    pull_number = parse_pull_number(payload)

    pull = {}
    for _ in range(3):
        pull = await get_pull(client, owner, repo, pull_number)
        if pull.get("mergeable") is not None and pull.get("mergeable_state") != "unknown":
            break
        await asyncio.sleep(1)

    green = pull.get("state") == "open" and not pull.get("draft") and pull.get("mergeable") is True and pull.get("mergeable_state") == "clean"
    return {
        "action": "mergeable",
        "repository": f"{owner}/{repo}",
        "pull_number": pull_number,
        "mergeable": green,
        "github_mergeable": pull.get("mergeable"),
        "github_mergeable_state": pull.get("mergeable_state"),
        "state": pull.get("state"),
        "draft": pull.get("draft"),
    }
