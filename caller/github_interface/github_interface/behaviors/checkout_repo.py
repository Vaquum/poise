from pathlib import Path
from typing import Any

from github_interface.atoms.local import checkout_repo
from github_interface.client import GitHubClient
from github_interface.context import repository

TOKEN_USER = "bit-mis"


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    path = Path(str(payload.get("path") or "").strip())
    if not str(path) or str(path) == ".":
        raise ValueError("path is required")
    info = await client.get(f"/repos/{owner}/{repo}")
    checkout = checkout_repo(owner, repo, str(info["default_branch"]), client.token, path)
    return {"action": "checkout_repo", "repository": f"{owner}/{repo}", "path": str(path), **checkout}
