from typing import Any

from github_interface.atoms.repos import list_org_repos
from github_interface.client import GitHubClient

TOKEN_USER = "mikkokotila"


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    org = str(payload.get("org", "")).strip()
    if not org:
        raise ValueError("org is required")

    repos = await list_org_repos(client, org)
    return {"action": "view_repos", "org": org, "count": len(repos), "repos": repos}
