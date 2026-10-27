from typing import Any

from github_interface.atoms.issues import assign_issue
from github_interface.client import GitHubClient
from github_interface.context import repository
from github_interface.identity import AGENT

IDENTITY = AGENT


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    number = _issue_number(payload)
    assignees = payload.get("users") or payload.get("user") or payload.get("assignees")
    if isinstance(assignees, str):
        assignees = [assignees]
    assignees = [str(user).strip() for user in (assignees or []) if str(user).strip()]
    if not assignees:
        raise ValueError("at least one user is required")

    issue = await assign_issue(client, owner, repo, number, assignees)
    return {"action": "assigned_issue", "repository": f"{owner}/{repo}", "issue_number": number, "assignees": assignees, "issue": issue}


def _issue_number(payload: dict[str, Any]) -> int:
    value = payload.get("issue") or payload.get("id") or payload.get("issue_number")
    if value is None:
        raise ValueError("issue is required")

    number = str(value).strip().lstrip("#")
    if not number.isdigit() or int(number) < 1:
        raise ValueError("issue must look like #123")
    return int(number)
