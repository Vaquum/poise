from typing import Any

from github_interface.atoms.issues import edit_issue_body, edit_issue_comment
from github_interface.client import GitHubClient
from github_interface.context import repository

TOKEN_USER = "bit-mis"


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    issue_number = _number(payload, "issue")
    body = str(payload.get("body", "")).strip()
    if not body:
        raise ValueError("body is required")

    comment_id = payload.get("comment_id")
    if comment_id:
        number = _number({"comment": comment_id}, "comment")
        comment = await edit_issue_comment(client, owner, repo, number, body)
        return {"action": "edited_issue_comment", "repository": f"{owner}/{repo}", "issue_number": issue_number, "comment_id": number, "comment": comment}

    issue = await edit_issue_body(client, owner, repo, issue_number, body)
    return {"action": "edited_issue_body", "repository": f"{owner}/{repo}", "issue_number": issue_number, "issue": issue}


def _number(payload: dict[str, Any], key: str) -> int:
    value = payload.get(key) or payload.get("id") or payload.get(f"{key}_id") or payload.get(f"{key}_number")
    if value is None:
        raise ValueError(f"{key} is required")
    number = str(value).strip().lstrip("#")
    if not number.isdigit() or int(number) < 1:
        raise ValueError(f"{key} must be a positive integer")
    return int(number)
