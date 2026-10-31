"""One-process seed read for a single behavior chain observation.

Runs the three existing initial reads — issue, comments and publication
inspection — concurrently on one shared client, so one observation pays one
interpreter startup and one auth lookup instead of three. Each facet reuses
its existing behavior projection unchanged; any facet failure fails the
whole read, exactly like the previous three separate calls failing their
joint observation. There is deliberately no partial envelope: a failed facet
is an unavailable read, never an empty value.
"""
import asyncio
from typing import Any

from github_interface.behaviors import issue_comments, issue_work, read_issue
from github_interface.client import GitHubClient
from github_interface.context import issue_number, repository, token_user

REQUIRE_TOKEN_USER = True


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    number = issue_number(payload)
    actor = token_user(payload)
    branch = str(payload.get("branch") or "")
    if not issue_work.BRANCH.fullmatch(branch) or ".." in branch or "//" in branch:
        raise ValueError("chain-seed requires a poise/ branch")
    target = f"{owner}/{repo}"
    read, comments, publication = await asyncio.gather(
        read_issue.run(client, payload),
        issue_comments.run(client, payload),
        issue_work.run(client, {**payload, "mode": "inspect"}),
    )
    return {
        "action": "chain_seed",
        "repository": target,
        "issue_number": number,
        "actor": actor,
        "branch": branch,
        "issue": read["issue"],
        "comments": comments["comments"],
        "publication": publication,
    }
