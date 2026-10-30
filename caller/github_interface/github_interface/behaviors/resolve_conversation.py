from typing import Any

from github_interface.atoms.pulls import resolve_conversation
from github_interface.client import GitHubClient
from github_interface.identity import AGENT

IDENTITY = AGENT


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    thread_id = str(payload.get("conversation") or payload.get("conversation_id") or payload.get("thread_id") or "").strip()
    if not thread_id:
        raise ValueError("conversation id is required")

    thread = await resolve_conversation(client, thread_id)
    return {"action": "resolved_conversation", "conversation_id": thread_id, "conversation": thread}
