from typing import Any

from github_interface.atoms.pulls import (
    get_pull,
    list_inline_comments,
    list_review_threads,
)
from github_interface.atoms.pulls import (
    request_changes as submit_change_request,
)
from github_interface.behaviors.pr_review import accepted_inline_comments
from github_interface.client import GitHubClient
from github_interface.context import expected_head, repository, token_user
from github_interface.context import pull_number as parse_pull_number

REVIEW_BODY = "Change requested in inline comments."
REAFFIRM_BODY = "Existing unresolved inline comments still block this head."
REQUIRE_TOKEN_USER = True


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    pull_number = parse_pull_number(payload)
    required_head = expected_head(payload)
    actor = token_user(payload)
    comments = payload.get("comments") or []
    if not isinstance(comments, list) or not comments or len(comments) > 100:
        raise ValueError("comments must be a JSON array with 1-100 entries")
    if not all(isinstance(comment, dict) for comment in comments):
        raise ValueError("every inline comment must be an object")

    pull = await get_pull(client, owner, repo, pull_number)
    if pull.get("state") != "open" or pull.get("draft") is True:
        raise RuntimeError("pull request is not open and ready for review")
    rest_comments = await list_inline_comments(client, owner, repo, pull_number)
    threads = await list_review_threads(client, owner, repo, pull_number)
    accepted, skipped = accepted_inline_comments(comments, rest_comments, threads)
    reaffirmed = not accepted and _has_unresolved_finding(comments, threads)
    if not accepted and not reaffirmed:
        return {"action": "no_review", "repository": f"{owner}/{repo}", "pull_number": pull_number, "skipped": skipped}
    submitted = await submit_change_request(
        client,
        owner,
        repo,
        pull_number,
        required_head,
        accepted,
        REAFFIRM_BODY if reaffirmed else REVIEW_BODY,
    )
    submitted_head = str(submitted.get("commit_id") or "").lower()
    submitted_actor = str((submitted.get("user") or {}).get("login") or "")
    if submitted.get("state") != "CHANGES_REQUESTED":
        raise RuntimeError("GitHub did not return a CHANGES_REQUESTED review")
    if submitted_head != required_head:
        raise RuntimeError(
            f"GitHub attached change request to {submitted_head or 'missing'}, expected {required_head}"
        )
    if submitted_actor.lower() != actor.lower():
        raise RuntimeError(
            f"GitHub recorded change request as {submitted_actor or 'missing'}, expected {actor}"
        )
    return {
        "action": "requested_changes",
        "repository": f"{owner}/{repo}",
        "pull_number": pull_number,
        "actor": actor,
        "outcome": "changes_requested",
        "head_sha": required_head,
        "comments": len(accepted),
        "reaffirmed": reaffirmed,
        "skipped": skipped,
        "review_id": submitted.get("id"),
        "submitted_at": submitted.get("submitted_at"),
    }


def _has_unresolved_finding(
    comments: list[dict[str, Any]],
    threads: list[dict[str, Any]],
) -> bool:
    active = [
        thread
        for thread in threads
        if not thread["is_resolved"]
    ]
    keys = {
        (str(thread["path"]), int(thread["line"]), str(thread["side"]).upper())
        for thread in active
        if not thread["is_outdated"] and thread["path"] and thread["line"]
    }
    bodies = {
        (str(thread["path"]), " ".join(str(body).lower().split()))
        for thread in active
        for body in thread["bodies"]
        if body
    }
    for comment in comments:
        path = str(comment.get("path") or "")
        line = comment.get("line")
        side = str(comment.get("side") or "RIGHT").upper()
        body = " ".join(str(comment.get("body") or "").lower().split())
        if line and (path, int(line), side) in keys:
            return True
        if body and (path, body) in bodies:
            return True
    return False
