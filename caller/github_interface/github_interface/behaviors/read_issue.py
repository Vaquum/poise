import re
from typing import Any

from github_interface.atoms.issues import read_issue
from github_interface.client import GitHubClient
from github_interface.context import repository
from github_interface.identity import AGENT

IDENTITY = AGENT


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    number = _issue_number(payload)
    if payload.get("delivery_base") is not None:
        return await _delivery(client, owner, repo, number, payload["delivery_base"])
    issue = await read_issue(client, owner, repo, number)
    return {"action": "read_issue", "repository": f"{owner}/{repo}", "issue_number": number, "issue": issue}


async def _delivery(client: GitHubClient, owner: str, repo: str, number: int, base: str) -> dict:
    if not isinstance(base, str) or not re.fullmatch(r"[0-9a-f]{40}", base):
        raise ValueError("delivery-base requires a full commit SHA")
    target = f"{owner}/{repo}"
    result = {"action": "read_issue", "repository": target, "issue_number": number,
              "base_sha": base, "state": None, "verified": False, "pull_number": None, "merge_sha": None}
    graph = await client.graphql("""query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){
      nameWithOwner
      issue(number:$number){state closedByPullRequestsReferences(first:100,includeClosedPrs:true){pageInfo{hasNextPage}
        nodes{number merged repository{nameWithOwner} mergeCommit{oid}}
      }}
    }}""", {"owner": owner, "repo": repo, "number": number})
    source = graph.get("repository") if isinstance(graph, dict) else None
    if not isinstance(source, dict) or str(source.get("nameWithOwner")).lower() != target.lower():
        return {**result, "reason": "prerequisite repository evidence is missing"}
    issue = source.get("issue")
    if not isinstance(issue, dict) or issue.get("state") not in {"OPEN", "CLOSED"}:
        return {**result, "reason": "prerequisite state is missing"}
    result["state"] = issue["state"].lower()
    if issue["state"] == "OPEN":
        return {**result, "reason": "prerequisite is open"}
    connection = issue.get("closedByPullRequestsReferences")
    if not isinstance(connection, dict) or not isinstance(connection.get("nodes"), list) \
            or any(not isinstance(pull, dict) for pull in connection["nodes"]) \
            or not isinstance(connection.get("pageInfo"), dict) or connection["pageInfo"].get("hasNextPage") is not False:
        return {**result, "reason": "prerequisite closing PR evidence is incomplete"}
    for pull in connection["nodes"]:
        merge = pull.get("mergeCommit")
        repository_node = pull.get("repository")
        if pull.get("merged") is not True or not isinstance(repository_node, dict) \
                or str(repository_node.get("nameWithOwner")).lower() != target.lower() \
                or type(pull.get("number")) is not int or pull["number"] < 1 \
                or not isinstance(merge, dict) or not isinstance(merge.get("oid"), str) \
                or not re.fullmatch(r"[0-9a-f]{40}", merge["oid"]):
            continue
        comparison = await client.get(f"/repos/{target}/compare/{merge['oid']}...{base}")
        if isinstance(comparison, dict) and comparison.get("status") in {"ahead", "identical"} \
                and isinstance(comparison.get("base_commit"), dict) and comparison["base_commit"].get("sha") == merge["oid"] \
                and isinstance(comparison.get("merge_base_commit"), dict) and comparison["merge_base_commit"].get("sha") == merge["oid"]:
            return {**result, "verified": True, "pull_number": pull["number"], "merge_sha": merge["oid"], "reason": None}
    return {**result, "reason": "no linked closing PR merge is verified on the implementation base"}


def _issue_number(payload: dict[str, Any]) -> int:
    value = payload.get("issue") or payload.get("id") or payload.get("issue_number")
    if value is None:
        raise ValueError("issue is required")

    number = str(value).strip().lstrip("#")
    if not number.isdigit() or int(number) < 1:
        raise ValueError("issue must look like #123")
    return int(number)
