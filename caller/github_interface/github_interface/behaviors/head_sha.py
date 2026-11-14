import re
from typing import Any

from github_interface.atoms.pulls import get_pull
from github_interface.client import GitHubClient
from github_interface.context import pull_number as parse_pull_number
from github_interface.context import repository

REQUIRE_TOKEN_USER = True


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    pull_number = parse_pull_number(payload)
    pull = await get_pull(client, owner, repo, pull_number)
    head_sha = str((pull.get("head") or {}).get("sha") or "").lower()
    if not re.fullmatch(r"[0-9a-f]{40}", head_sha):
        raise RuntimeError("GitHub returned no pull-request head SHA")
    state, merged = pull.get("state"), pull.get("merged")
    if state not in ("open", "closed") or type(merged) is not bool or (merged and state != "closed"):
        raise RuntimeError("GitHub returned invalid pull-request state")
    return {
        "action": "head_sha",
        "repository": f"{owner}/{repo}",
        "pull_number": pull_number,
        "head_sha": head_sha,
        "state": "MERGED" if merged else state.upper(),
        "author": (pull.get("user") or {}).get("login"),
    }
