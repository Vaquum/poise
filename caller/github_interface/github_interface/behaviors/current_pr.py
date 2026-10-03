from typing import Any

from github_interface.atoms.local import current_branch
from github_interface.atoms.pulls import list_open_pulls_for_branch
from github_interface.client import GitHubClient
from github_interface.context import repository

async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    branch = current_branch()
    pulls = await list_open_pulls_for_branch(client, owner, repo, branch)
    if len(pulls) > 1:
        raise RuntimeError(f"multiple open pull requests found for branch {branch}")
    if not pulls:
        return {
            "action": "current_pr",
            "repository": f"{owner}/{repo}",
            "branch": branch,
            "found": False,
        }

    pull = pulls[0]
    head_sha = str((pull.get("head") or {}).get("sha") or "").lower()
    if len(head_sha) != 40:
        raise RuntimeError("GitHub returned no pull-request head SHA")
    return {
        "action": "current_pr",
        "repository": f"{owner}/{repo}",
        "branch": branch,
        "found": True,
        "pull_number": int(pull["number"]),
        "url": pull.get("html_url"),
        "head_sha": head_sha,
    }
