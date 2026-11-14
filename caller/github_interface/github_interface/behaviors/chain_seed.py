"""One-process seed read for a single behavior chain observation.

Runs the three existing initial reads — issue, comments and publication
inspection — concurrently on one shared client, so one observation pays one
interpreter startup and one auth lookup instead of three. Each facet reuses
its existing behavior projection unchanged; any facet failure fails the
whole read, exactly like the previous three separate calls failing their
joint observation. Closed seeds without an owned PR, or with one confirmed closed
without merge, also resolve merged closing references separately from publication
ownership. There is no partial envelope:
a failed facet is an unavailable read, never an empty value.
"""
import asyncio
import json
from typing import Any

from github_interface.behaviors import issue_comments, issue_work, read_issue
from github_interface.client import GitHubClient
from github_interface.context import issue_number, repository, token_user
from github_interface import full_suite_repair, test_dependency
from github_interface.atoms.pulls import get_pull

REQUIRE_TOKEN_USER = True


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    number = issue_number(payload)
    actor = token_user(payload)
    branch = str(payload.get("branch") or "")
    if not issue_work.BRANCH.fullmatch(branch) or ".." in branch or "//" in branch:
        raise ValueError("chain-seed requires a poise/ branch")
    target = f"{owner}/{repo}"
    read, comments, publication = await asyncio.gather(
        read_issue.run(client, payload),
        issue_comments.run(client, payload),
        issue_work.run(client, {**payload, "mode": "inspect"}),
    )
    result = {
        "action": "chain_seed",
        "repository": target,
        "issue_number": number,
        "actor": actor,
        "branch": branch,
        "issue": read["issue"],
        "comments": comments["comments"],
        "publication": publication,
    }
    if payload.get("test_dependency_json") is not None:
        result["test_dependency"] = await test_dependency.inspect(client, target, json.loads(payload["test_dependency_json"]), publication["base_sha"])
    if read["issue"].get("state") == "closed" and (publication["pull_number"] is None
            or publication["state"] == "closed" and publication["merged"] is False):
        result["external_merge"] = await _external_merge(client, owner, repo, number)
    if read["issue"].get("state") == "closed" and read["issue"].get("title") == full_suite_repair.TITLE:
        pull = await get_pull(client, owner, repo, publication["pull_number"]) if publication["pull_number"] else None
        result["full_suite"] = await full_suite_repair.inspect(client, target, read["issue"], comments["comments"], pull)
    if publication["pull_number"] and publication["merged"] is False and issue_work.pre_pr_remediation(read["issue"], target):
        pull = await get_pull(client, owner, repo, publication["pull_number"])
        result["remediation"] = await issue_work.remediation_coverage(client, target, read["issue"], pull, publication["base_sha"])
    return result


async def _external_merge(client: GitHubClient, owner: str, repo: str, number: int) -> dict | None:
    target = f"{owner}/{repo}"
    graph = await client.graphql("""query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){
      nameWithOwner defaultBranchRef{name}
      issue(number:$number){state closedByPullRequestsReferences(first:100,includeClosedPrs:true){pageInfo{hasNextPage}
        nodes{number merged baseRepository{nameWithOwner} baseRefName mergeCommit{oid}}
      }}
    }}""", {"owner": owner, "repo": repo, "number": number})
    source = graph["repository"]
    if source["nameWithOwner"].lower() != target.lower() or not source["defaultBranchRef"]["name"]:
        raise ValueError("external merge repository or base branch evidence is incomplete")
    issue = source["issue"]
    if issue["state"] != "CLOSED":
        return None
    references = issue["closedByPullRequestsReferences"]
    if references["pageInfo"]["hasNextPage"] is not False or not isinstance(references["nodes"], list):
        raise ValueError("external merge closing PR evidence is incomplete")
    merged = []
    for pull in references["nodes"]:
        if type(pull["merged"]) is not bool:
            raise ValueError("external merge closing PR state is incomplete")
        if not pull["merged"]:
            continue
        if not isinstance(pull["baseRefName"], str) or not pull["baseRefName"]:
            raise ValueError("external merge base branch evidence is incomplete")
        if pull["baseRepository"]["nameWithOwner"].lower() != target.lower() \
                or pull["baseRefName"] != source["defaultBranchRef"]["name"]:
            continue
        if type(pull["number"]) is not int or pull["number"] < 1 \
                or not issue_work.SHA.fullmatch(pull["mergeCommit"]["oid"]):
            raise ValueError("external merge closing PR identity is incomplete")
        merged.append({"pull_number": pull["number"], "merge_sha": pull["mergeCommit"]["oid"].lower()})
    return merged[0] if len(merged) == 1 else None
