from typing import Any

from github_interface.atoms.pulls import list_review_threads, resolve_conversation
from github_interface.client import GitHubClient
from github_interface.context import pull_number as parse_pull_number
from github_interface.context import repository

TOKEN_USER = "bit-mis"


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    pull_number = parse_pull_number(payload)
    threads = await list_review_threads(client, owner, repo, pull_number)
    unresolved = [thread for thread in threads if not thread["is_resolved"]]
    resolved = [await resolve_conversation(client, thread["id"]) for thread in unresolved]
    return {
        "action": "resolved_pr_conversations",
        "repository": f"{owner}/{repo}",
        "pull_number": pull_number,
        "resolved_count": len(resolved),
        "already_resolved_count": len(threads) - len(unresolved),
        "conversations": resolved,
    }
