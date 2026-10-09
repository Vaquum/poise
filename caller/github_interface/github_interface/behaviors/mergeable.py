import asyncio
from typing import Any

from github_interface.atoms.pulls import get_pr_readiness_state, get_pull
from github_interface.client import GitHubClient
from github_interface.context import pull_number as parse_pull_number
from github_interface.context import repository
from github_interface.identity import AGENT

IDENTITY = AGENT

# The merge states GitHub shows a green merge button for.
BUTTON_GREEN = {"clean", "unstable", "has_hooks"}


def status(pull: dict[str, Any], checks_state: str | None, unresolved: int) -> str | None:
    """Current's colour for a pull request: green when its merge button is
    green, no check fails or is still running and no conversation is left
    unresolved; yellow when the button is green but one of those remains."""
    if pull.get("state") != "open" or pull.get("draft") or pull.get("mergeable") is not True:
        return None
    if pull.get("mergeable_state") not in BUTTON_GREEN:
        return None
    return "green" if checks_state in (None, "SUCCESS") and unresolved == 0 else "yellow"


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
    readiness = await get_pr_readiness_state(client, owner, repo, pull_number)
    commit = (((readiness.get("commits") or {}).get("nodes") or [{}])[0].get("commit") or {})
    checks_state = (commit.get("statusCheckRollup") or {}).get("state")
    unresolved = sum(1 for thread in readiness["reviewThreads"]["nodes"] if not thread["isResolved"] and not thread["isOutdated"])
    return {
        "action": "mergeable",
        "repository": f"{owner}/{repo}",
        "pull_number": pull_number,
        "mergeable": green,
        "github_mergeable": pull.get("mergeable"),
        "github_mergeable_state": pull.get("mergeable_state"),
        "state": pull.get("state"),
        "draft": pull.get("draft"),
        "checks_state": checks_state,
        "unresolved_conversations": unresolved,
        "status": status(pull, checks_state, unresolved),
    }
