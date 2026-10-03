from typing import Any

from github_interface.behaviors.request_changes import run as request_changes
from github_interface.client import GitHubClient

REQUIRE_TOKEN_USER = True


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    return await request_changes(
        client,
        {
            **payload,
            "comments": [
                {
                    "path": payload.get("file"),
                    "line": payload.get("line"),
                    "side": payload.get("side", "RIGHT"),
                    "body": payload.get("body"),
                }
            ],
        },
    )
