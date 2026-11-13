from datetime import datetime, timezone
from math import isfinite

import httpx

from github_interface.atoms.pulls import get_pull
from github_interface.client import GitHubClient
from github_interface.context import pull_number, repository, token_user
from github_interface.identity import AGENT, PERSON, account

REQUIRE_TOKEN_USER = True


async def run(client: GitHubClient, payload: dict[str, object]) -> dict[str, object]:
    owner, repo = repository(payload)
    number = pull_number(payload)
    author = str(payload.get("author") or "").strip().lower()
    person, agent = account(PERSON, {}).lower(), account(AGENT, {}).lower()
    actor = token_user(payload).lower()
    if person == agent or author not in (person, agent) or actor != (agent if author == person else person):
        raise ValueError("close requires the configured author pair and opposite acting account")
    cutoff = payload.get("cutoff_ms")
    now = datetime.now(timezone.utc).timestamp() * 1000
    if type(cutoff) not in (int, float) or not isfinite(cutoff) or cutoff >= now:
        raise ValueError("cutoff-ms must be a finite timestamp in the past")
    path = f"/repos/{owner}/{repo}/pulls/{number}"
    result = {"action": "close_old_pr_if_ready", "repository": f"{owner}/{repo}",
              "pull_number": number, "cutoff_ms": cutoff, "outcome": "not_ready"}
    pull = await get_pull(client, owner, repo, number)
    if pull.get("merged") is True or pull.get("state") == "closed":
        return {**result, "outcome": "already_closed"}
    if pull.get("state") != "open" or pull.get("draft") is not False \
            or str((pull.get("user") or {}).get("login") or "").lower() != author:
        return result
    created = pull.get("created_at")
    if not isinstance(created, str):
        raise RuntimeError("PR created_at is missing; leaving it open")
    try:
        opened = datetime.fromisoformat(created.replace("Z", "+00:00"))
        if opened.tzinfo is None:
            raise ValueError("created_at has no timezone")
        created_ms = opened.timestamp() * 1000
    except ValueError as error:
        raise RuntimeError("PR created_at is invalid; leaving it open") from error
    if created_ms > now:
        raise RuntimeError("PR created_at is in the future; leaving it open")
    if created_ms > cutoff:
        return result
    try:
        receipt = await client.patch(path, json={"state": "closed"})
    except (RuntimeError, httpx.HTTPError) as error:
        # A lost response can follow an accepted close. Read once, never repeat
        # the write, and retain the original cause if closure is unconfirmed.
        receipt = await get_pull(client, owner, repo, number)
        if not isinstance(receipt, dict) or receipt.get("state") != "closed" or receipt.get("merged") is not False:
            raise RuntimeError(f"PR close unconfirmed: {error}") from error
    if not isinstance(receipt, dict) or receipt.get("number") != number \
            or receipt.get("state") != "closed" or receipt.get("merged") is not False:
        raise RuntimeError("GitHub did not confirm an unmerged closed pull request")
    return {**result, "outcome": "closed", "state": "closed", "merged": False}
