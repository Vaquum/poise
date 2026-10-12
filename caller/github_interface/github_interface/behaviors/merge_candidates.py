import re
from typing import Any

from github_interface.behaviors.mergeable import readiness_status
from github_interface.client import GitHubClient
from github_interface.context import token_user

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
    actor = token_user(payload)
    requests = payload.get("requests")
    if not isinstance(requests, list) or len(requests) > MAX_CANDIDATES:
        raise ValueError("requests must be a list of at most 50 pull requests")
    seen = set()
    declarations, selections, variables = [], [], {}
    for index, request in enumerate(requests):
        if (not isinstance(request, dict) or set(request) != {"repository", "number"}
                or not isinstance(request["repository"], str)
                or not re.fullmatch(r"[^/\s]+/[^/\s]+", request["repository"])
                or type(request["number"]) is not int or request["number"] < 1):
            raise ValueError("each request must name an owner/repo repository and positive integer number")
        target = (request["repository"].lower(), request["number"])
        if target in seen:
            raise ValueError("duplicate pull request in requests")
        seen.add(target)
        owner, name = request["repository"].split("/")
        declarations.extend([f"$owner{index}: String!", f"$name{index}: String!", f"$number{index}: Int!"])
        variables.update({f"owner{index}": owner, f"name{index}": name, f"number{index}": request["number"]})
        selections.append(f"""
          pr{index}: repository(owner: $owner{index}, name: $name{index}) {{
            nameWithOwner
            pullRequest(number: $number{index}) {{ {FIELDS} }}
          }}
        """)
    result = {"action": "merge_candidates", "actor": actor, "graphql_cost": 0, "records": []}
    if not requests:
        return result
    query = "query(" + ", ".join(declarations) + ") { viewer { login } rateLimit { cost } " + "".join(selections) + "}"
    # Preserve valid targets when GitHub returns a partial query error for a
    # different repository. Unscoped errors hold the entire read visibly.
    response = await client.request("POST", "/graphql", retry_transient=True,
                                    json={"query": query, "variables": variables})
    errors = response.get("errors") or []
    aliases = {f"pr{index}" for index in range(len(requests))}
    if any(not error.get("path") or error["path"][0] not in aliases for error in errors):
        raise RuntimeError(f"GitHub merge candidate query failed: {errors}")
    data = response.get("data") or {}
    login = (data.get("viewer") or {}).get("login")
    cost = (data.get("rateLimit") or {}).get("cost")
    if not isinstance(login, str) or login.lower() != actor.lower() or type(cost) is not int or cost < 1:
        raise RuntimeError("GitHub merge candidate query has missing or mismatched identity/cost evidence")
    result["graphql_cost"] = cost
    for index, request in enumerate(requests):
        record = {"repository": request["repository"], "number": request["number"],
                  "ready": False, "head_sha": None, "author": None, "error": None}
        scoped_errors = [error for error in errors if error["path"][0] == f"pr{index}"]
        repo = data.get(f"pr{index}")
        if scoped_errors:
            record["error"] = "; ".join(str(error.get("message") or error) for error in scoped_errors)
        elif not isinstance(repo, dict) or str(repo.get("nameWithOwner") or "").lower() != request["repository"].lower():
            record["error"] = "GitHub returned missing or mismatched repository evidence"
        else:
            pull = repo.get("pullRequest")
            if not isinstance(pull, dict) or pull.get("number") != request["number"]:
                record["error"] = "GitHub returned missing or mismatched pull request evidence"
            else:
                head = pull.get("headRefOid")
                author = (pull.get("author") or {}).get("login")
                if not isinstance(head, str) or not re.fullmatch(r"[0-9a-f]{40}", head):
                    record["error"] = "GitHub returned missing or malformed pull request head evidence"
                else:
                    record.update(head_sha=head, author=author, ready=readiness_status(pull) == "green")
        result["records"].append(record)
    return result
