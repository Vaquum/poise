from typing import Any

from github_interface.behaviors.mergeable import readiness_behind, readiness_status
from github_interface.client import GitHubClient
from github_interface.atoms.pr_batch import read_pull_batch

REQUIRE_TOKEN_USER = True
MAX_CANDIDATES = 50
FIELDS = """
  number state isDraft headRefOid mergeable mergeStateStatus
  reviewDecision mergeQueue { id } mergeQueueEntry { id }
  author { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviews(first: 100) {
    pageInfo { hasNextPage }
    nodes { state submittedAt }
  }
  reviewThreads(first: 100) {
    pageInfo { hasNextPage }
    nodes { isResolved isOutdated }
  }
"""


def latest_approval(pull: dict[str, Any]) -> str | None:
    """Latest APPROVED review's submittedAt, or None when nothing approved
    or the review page is incomplete. Orders branch updates oldest first."""
    reviews = pull["reviews"]
    if reviews["pageInfo"]["hasNextPage"]:
        return None
    stamps = [str(node["submittedAt"]) for node in reviews["nodes"]
              if node.get("state") == "APPROVED" and node.get("submittedAt")]
    return max(stamps) if stamps else None


def queue_entry_id(pull: dict[str, Any]) -> str | None:
    """Current merge queue entry id, or None when the PR is not queued."""
    entry = pull.get("mergeQueueEntry")
    if entry is None:
        return None
    if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or not entry["id"]:
        raise TypeError("GitHub returned malformed merge queue entry evidence")
    return entry["id"]


def rollup_state(pull: dict[str, Any]) -> str | None:
    """Head check-rollup aggregate, or None when no rollup came back."""
    nodes = (pull.get("commits") or {}).get("nodes") or []
    if not nodes or not nodes[0].get("commit"):
        return None
    commit = nodes[0]["commit"]
    if "statusCheckRollup" not in commit:
        return None
    return (commit["statusCheckRollup"] or {}).get("state")


def unresolved_thread_count(pull: dict[str, Any]) -> tuple[int, bool]:
    """Open conversations plus whether every thread page was read."""
    threads = pull["reviewThreads"]
    unresolved = sum(not thread["isResolved"] and not thread["isOutdated"] for thread in threads["nodes"])
    return unresolved, not threads["pageInfo"]["hasNextPage"]


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    result = await read_pull_batch(client, payload, FIELDS)
    result["action"] = "merge_candidates"
    for record in result["records"]:
        pull = record.pop("pull")
        record["ready"] = False
        record["behind"] = False
        record["approved_at"] = None
        record["queue_entry_id"] = None
        record["rollup_state"] = None
        record["review_decision"] = None
        record["merge_state_status"] = None
        record["unresolved_threads"] = None
        record["threads_complete"] = None
        if pull is not None:
            try:
                record["ready"] = bool(record["author"]) and readiness_status(pull) == "green"
                record["behind"] = bool(record["author"]) and readiness_behind(pull) == "behind"
                record["approved_at"] = latest_approval(pull)
                record["queue_entry_id"] = queue_entry_id(pull)
                # Already-fetched readiness evidence, at zero added GraphQL
                # cost, for the per-PR status projection.
                record["rollup_state"] = rollup_state(pull)
                record["review_decision"] = pull.get("reviewDecision")
                record["merge_state_status"] = pull.get("mergeStateStatus")
                unresolved, complete = unresolved_thread_count(pull)
                record["unresolved_threads"] = unresolved
                record["threads_complete"] = complete
            except (KeyError, TypeError, AttributeError) as error:
                # A failed target carries no positive claims: ready/behind
                # alongside an error would fail the server's batch validation
                # and block unrelated valid PRs.
                record["ready"] = False
                record["behind"] = False
                record["approved_at"] = None
                record["queue_entry_id"] = None
                record["rollup_state"] = None
                record["review_decision"] = None
                record["merge_state_status"] = None
                record["unresolved_threads"] = None
                record["threads_complete"] = None
                record["error"] = f"GitHub returned malformed pull request readiness evidence: {error}"
    return result
