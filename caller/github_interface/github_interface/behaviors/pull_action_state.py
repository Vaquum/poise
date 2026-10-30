from typing import Any
import re

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

    # The pull, its reviews and its readiness are separate reads; a push or
    # merge between them would pair one head's pull with another head's
    # queue entry. The readiness packet carries the head it saw: while it
    # disagrees with the pull read, the sequence runs again, so H's pull
    # is never answered with H2's queue entry.
    pull: dict[str, Any] = {}
    mine: list[dict[str, Any]] = []
    queue_entry_id: str | None = None
    for _ in range(3):
        pull = await get_pull(client, owner, repo, number)
        reviews = await list_reviews(client, owner, repo, number)
        mine = []
        for review in reviews:
            login = _login(review.get("user"))
            if login is not None and login.lower() == actor.lower():
                mine.append({"id": review.get("id"), "state": review.get("state"),
                             "commit_id": review.get("commit_id"), "submitted_at": review.get("submitted_at")})
                if payload.get("queue_evidence"):
                    marker = re.search(r"<!-- poise-invocation ([0-9a-f]{32}) -->\s*\Z", review.get("body") or "")
                    mine[-1]["invocation_id"] = marker.group(1) if marker else None

        queue_entry_id = None
        steady = True
        if pull.get("state") == "open" and pull.get("merged") is not True:
            readiness = await get_pr_readiness_state(client, owner, repo, number)
            entry = readiness.get("mergeQueueEntry")
            if entry is not None:
                if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or not entry["id"]:
                    raise RuntimeError("GitHub returned malformed merge queue entry evidence")
                queue_entry_id = entry["id"]
            ready_head = readiness.get("headRefOid")
            rest_head = (pull.get("head") or {}).get("sha")
            if isinstance(ready_head, str) and isinstance(rest_head, str) \
                    and ready_head.lower() != rest_head.lower():
                steady = False
            ready_state = readiness.get("state")
            if isinstance(ready_state, str) and ready_state != "OPEN":
                steady = False
        if steady:
            break

    queue_evidence = {}
    if payload.get("queue_evidence") and pull.get("state") == "open":
        data = await client.graphql("""query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){
          pullRequest(number:$number){headRefOid timelineItems(last:5,itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT]){
            nodes{... on RemovedFromMergeQueueEvent{id createdAt reason actor{login} beforeCommit{oid statusCheckRollup{
              state contexts(first:100){pageInfo{hasNextPage} nodes{__typename
                ... on CheckRun{name status conclusion detailsUrl}
                ... on StatusContext{context state targetUrl}
              }}
            }}}}
          }}
        }}""", {"owner": owner, "repo": repo, "number": number})
        observed = data["repository"]["pullRequest"]
        if observed["headRefOid"] != (pull.get("head") or {}).get("sha"):
            raise RuntimeError("pull-request head changed while reading queue removal evidence")
        queue_evidence = {"queue_removals": observed["timelineItems"]["nodes"]}

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
        **queue_evidence,
    }
