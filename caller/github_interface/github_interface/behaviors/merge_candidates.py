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


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    result = await read_pull_batch(client, payload, FIELDS)
    result["action"] = "merge_candidates"
    for record in result["records"]:
        pull = record.pop("pull")
        record["ready"] = False
        record["behind"] = False
        record["approved_at"] = None
        if pull is not None:
            try:
                record["ready"] = bool(record["author"]) and readiness_status(pull) == "green"
                record["behind"] = bool(record["author"]) and readiness_behind(pull) == "behind"
                record["approved_at"] = latest_approval(pull)
            except (KeyError, TypeError, AttributeError) as error:
                record["error"] = f"GitHub returned malformed pull request readiness evidence: {error}"
    return result
