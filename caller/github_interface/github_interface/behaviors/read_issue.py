from typing import Any

from github_interface.atoms.issues import read_issue
from github_interface.client import GitHubClient
from github_interface.context import repository
from github_interface.identity import AGENT

IDENTITY = AGENT


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    number = _issue_number(payload)
    issue = await read_issue(client, owner, repo, number)
    return {"action": "read_issue", "repository": f"{owner}/{repo}", "issue_number": number, "issue": issue}


def _issue_number(payload: dict[str, Any]) -> int:
    value = payload.get("issue") or payload.get("id") or payload.get("issue_number")
    if value is None:
        raise ValueError("issue is required")

    number = str(value).strip().lstrip("#")
    if not number.isdigit() or int(number) < 1:
        raise ValueError("issue must look like #123")
    return int(number)
