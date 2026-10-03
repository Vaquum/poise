from typing import Any

from github_interface.atoms.local import checkout_path

NO_AUTH = True


async def run(_, payload: dict[str, Any]) -> dict[str, Any]:
    org = str(payload.get("org", "")).strip()
    repo = str(payload.get("repo", "")).strip()
    if not org or not repo:
        raise ValueError("org and repo are required")

    return {"action": "local_checkout_path", "repository": f"{org}/{repo}", "path": checkout_path(org, repo)}
