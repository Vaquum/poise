from typing import Any

from github_interface.atoms.pulls import read_job_log
from github_interface.client import GitHubClient
from github_interface.context import repository
from github_interface.identity import AGENT

IDENTITY = AGENT


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    log_id = _log_id(payload)
    log = await read_job_log(client, owner, repo, log_id)
    return {"action": "read_failing_ci_log", "repository": f"{owner}/{repo}", "log_id": log_id, "log": log}


def _log_id(payload: dict[str, Any]) -> int:
    value = payload.get("log") or payload.get("log_id") or payload.get("id")
    if value is None or not str(value).strip().isdigit():
        raise ValueError("log id is required")
    return int(value)
