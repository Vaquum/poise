from typing import Any

from github_interface.atoms.issues import comment_issue
from github_interface.client import GitHubClient
from github_interface.context import repository
from github_interface.identity import AGENT

IDENTITY = AGENT


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    number = _number(payload, "issue")
    body = str(payload.get("body", "")).strip()
    if not body:
        raise ValueError("body is required")

    comment = await comment_issue(client, owner, repo, number, body)
    return {"action": "commented_issue", "repository": f"{owner}/{repo}", "issue_number": number, "comment": comment}


def _number(payload: dict[str, Any], key: str) -> int:
    value = payload.get(key) or payload.get("id") or payload.get(f"{key}_number")
    if value is None:
        raise ValueError(f"{key} is required")
    number = str(value).strip().lstrip("#")
    if not number.isdigit() or int(number) < 1:
        raise ValueError(f"{key} must look like #123")
    return int(number)
