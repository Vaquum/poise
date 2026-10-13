from typing import Any

from github_interface.behaviors.mergeable import readiness_status
from github_interface.client import GitHubClient
from github_interface.atoms.pr_batch import read_pull_batch

REQUIRE_TOKEN_USER = True
MAX_CANDIDATES = 50
FIELDS = """
  number state isDraft headRefOid mergeable mergeStateStatus
  author { login }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviewThreads(first: 100) {
    pageInfo { hasNextPage }
    nodes { isResolved isOutdated }
  }
"""


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    result = await read_pull_batch(client, payload, FIELDS)
    result["action"] = "merge_candidates"
    for record in result["records"]:
        pull = record.pop("pull")
        record["ready"] = False
        if pull is not None:
            try:
                record["ready"] = bool(record["author"]) and readiness_status(pull) == "green"
            except (KeyError, TypeError, AttributeError) as error:
                record["error"] = f"GitHub returned malformed pull request readiness evidence: {error}"
    return result
