import asyncio
import shutil
from pathlib import Path

from github_interface.atoms.review_checkout import checkout
from github_interface.atoms.pulls import get_pull
from github_interface.context import expected_head, pull_number, repository

REQUIRE_TOKEN_USER = True


async def run(client, payload):
    owner, repo = repository(payload)
    number = pull_number(payload)
    head = expected_head(payload)
    base = expected_head({"expected_head": payload.get("base_sha")})
    merge_base = expected_head({"expected_head": payload.get("merge_base_sha")})
    path = Path(str(payload.get("path") or ""))
    pull = await get_pull(client, owner, repo, number)
    if pull["head"]["sha"] != head or pull["base"]["sha"] != base:
        raise RuntimeError("pull-request head or base changed before checkout")
    comparison = await client.get(f"/repos/{owner}/{repo}/compare/{base}...{head}", params={"page": 2, "per_page": 1})
    if comparison["merge_base_commit"]["sha"] != merge_base:
        raise RuntimeError("review checkout merge base differs from the PR packet")
    trees = await asyncio.gather(*(client.get(f"/repos/{owner}/{repo}/git/trees/{sha}", params={"recursive": 1})
                                   for sha in (head, merge_base)))
    info = await asyncio.to_thread(checkout, owner, repo, head, merge_base, client.token, path, *trees)
    try:
        latest = await get_pull(client, owner, repo, number)
        if latest["head"]["sha"] != head or latest["base"]["sha"] != base:
            raise RuntimeError("pull-request head or base changed during checkout")
    except BaseException:
        shutil.rmtree(path, ignore_errors=True)
        raise
    return {"action": "checkout_review", "repository": f"{owner}/{repo}", "path": str(path), **info}
