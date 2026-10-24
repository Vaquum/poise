from typing import Any

from github_interface.atoms.pulls import get_pr_readiness_state, get_pull, list_reviews
from github_interface.client import GitHubClient
from github_interface.context import pull_number as parse_pull_number
from github_interface.context import repository, token_user

REQUIRE_TOKEN_USER = True

# The pull request state the person's approve and merge endpoints reconcile
# against: whether it merged and who merged it, its head, its queue entry,
# and the acting account's own reviews. Read-only, one REST pull, one REST
# review list, and the readiness packet while the pull request is open.


def _login(value: Any) -> str | None:
    if isinstance(value, dict):
        login = value.get("login")
        return str(login) if login else None
    return None


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    number = parse_pull_number(payload)
    actor = token_user(payload)

    pull = await get_pull(client, owner, repo, number)
    reviews = await list_reviews(client, owner, repo, number)
    mine = []
    for review in reviews:
        login = _login(review.get("user"))
        if login is not None and login.lower() == actor.lower():
            mine.append({"id": review.get("id"), "state": review.get("state"),
                         "commit_id": review.get("commit_id"), "submitted_at": review.get("submitted_at")})

    queue_entry_id = None
    if pull.get("state") == "open" and pull.get("merged") is not True:
        entry = (await get_pr_readiness_state(client, owner, repo, number)).get("mergeQueueEntry")
        if entry is not None:
            if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or not entry["id"]:
                raise RuntimeError("GitHub returned malformed merge queue entry evidence")
            queue_entry_id = entry["id"]

    return {
        "action": "pull_action_state",
        "repository": f"{owner}/{repo}",
        "pull_number": number,
        "actor": actor,
        "state": pull.get("state"),
        "merged": pull.get("merged") is True,
        "merged_by": _login(pull.get("merged_by")),
        "head_sha": (pull.get("head") or {}).get("sha"),
        "merge_sha": pull.get("merge_commit_sha"),
        "queue_entry_id": queue_entry_id,
        "my_reviews": mine,
    }
