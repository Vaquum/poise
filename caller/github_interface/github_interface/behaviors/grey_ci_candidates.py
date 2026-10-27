from typing import Any

from github_interface.atoms.pr_batch import read_pull_batch
from github_interface.client import GitHubClient

REQUIRE_TOKEN_USER = True
GREY_CONCLUSIONS = {"cancelled", "stale", "timed_out"}
SUITES = """
  pageInfo { hasNextPage endCursor }
  nodes { status conclusion workflowRun {
    databaseId runAttempt event createdAt
    workflow { databaseId }
  } }
"""
FIELDS = "state isDraft commits(last: 1) { nodes { commit { checkSuites(first: 100) { " + SUITES + " } } } }"


def grey_runs(contexts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    latest = {}
    for suite in contexts:
        if not suite or not suite.get("workflowRun"):
            continue
        run = suite["workflowRun"]
        workflow_id = run["workflow"]["databaseId"]
        if any(type(value) is not int or value < 1 for value in (run["databaseId"], run["runAttempt"], workflow_id)):
            raise ValueError("GitHub returned malformed workflow identity")
        key = (workflow_id, run["event"])
        candidate = {"run_id": run["databaseId"], "run_attempt": run["runAttempt"],
                     "workflow_id": workflow_id, "event": run["event"],
                     "status": suite["status"].lower(), "conclusion": (suite["conclusion"] or "").lower(),
                     "created_at": run["createdAt"]}
        previous = latest.get(key)
        if previous is None or (candidate["created_at"], candidate["run_id"]) > (previous["created_at"], previous["run_id"]):
            latest[key] = candidate
        elif candidate["run_id"] == previous["run_id"] and candidate != previous:
            raise ValueError("GitHub returned contradictory workflow evidence")
    return [run for run in latest.values() if run["status"] == "completed" and run["conclusion"] in GREY_CONCLUSIONS]


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    result = await read_pull_batch(client, payload, FIELDS)
    result["action"] = "grey_ci_candidates"
    for record in result["records"]:
        pull = record.pop("pull")
        record["runs"] = []
        if pull is None or pull["state"] != "OPEN" or pull["isDraft"]:
            continue
        try:
            commits = (pull.get("commits") or {}).get("nodes") or []
            if not commits or not commits[0].get("commit"):
                raise ValueError("GitHub returned missing current commit evidence")
            page = commits[0]["commit"]["checkSuites"]
            contexts = list(page["nodes"])
            while page["pageInfo"]["hasNextPage"]:
                cursor = page["pageInfo"]["endCursor"]
                if not isinstance(cursor, str) or not cursor:
                    raise ValueError("GitHub returned missing CI pagination cursor")
                owner, repo = record["repository"].split("/")
                query = """query($owner: String!, $repo: String!, $number: Int!, $cursor: String!) {
                  rateLimit { cost }
                  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
                    headRefOid commits(last: 1) { nodes { commit {
                      checkSuites(first: 100, after: $cursor) { """ + SUITES + " } } } } } } }"
                data = await client.graphql(query, {"owner": owner, "repo": repo, "number": record["number"], "cursor": cursor})
                cost = data["rateLimit"]["cost"]
                if type(cost) is not int or cost < 1:
                    raise ValueError("GitHub returned malformed CI page cost")
                result["graphql_cost"] += cost
                current = data["repository"]["pullRequest"]
                if current["headRefOid"] != record["head_sha"]:
                    raise ValueError("Pull request head changed during CI pagination")
                page = current["commits"]["nodes"][0]["commit"]["checkSuites"]
                contexts.extend(page["nodes"])
            record["runs"] = grey_runs(contexts)
        except (KeyError, TypeError, AttributeError, ValueError, RuntimeError) as error:
            record["error"] = f"GitHub grey CI evidence could not be read: {error}"
    return result
