import re
from typing import Any

from github_interface.atoms.pulls import get_combined_status, get_pull, list_check_runs
from github_interface.client import GitHubClient
from github_interface.context import pull_number as parse_pull_number
from github_interface.context import repository
from github_interface.identity import AGENT

IDENTITY = AGENT
OK_CHECKS = {"success", "neutral", "skipped"}


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    pull_number = parse_pull_number(payload)
    pull = await get_pull(client, owner, repo, pull_number)
    ref = pull["head"]["sha"]
    checks = await list_check_runs(client, owner, repo, ref)
    status = await get_combined_status(client, owner, repo, ref)

    failing_checks = [_check(check) for check in checks if _check_failing(check)]
    failing_statuses = [_status(item) for item in status.get("statuses", []) if item.get("state") != "success"]
    # Merge state, author, draft flag and pull state ride the same get_pull
    # response the head SHA already comes from: the work monitor's
    # conflict/behind/terminal read costs zero additional GitHub requests.
    # mergeable is None while GitHub is still computing it; the monitor
    # treats that as no observation.
    user = pull.get("user") or {}
    base = pull.get("base") or {}
    return {
        "action": "list_failing_ci",
        "repository": f"{owner}/{repo}",
        "pull_number": pull_number,
        "head_sha": ref,
        "failing": failing_checks + failing_statuses,
        "mergeable": pull.get("mergeable"),
        "mergeable_state": pull.get("mergeable_state"),
        "author": user.get("login"),
        "draft": pull.get("draft"),
        "base": base.get("ref"),
        "state": pull.get("state"),
        "merged": pull.get("merged"),
    }


def _check_failing(check: dict[str, Any]) -> bool:
    return check.get("status") != "completed" or check.get("conclusion") not in OK_CHECKS


def _check(check: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "check_run",
        "name": check.get("name"),
        "state": check.get("status"),
        "conclusion": check.get("conclusion"),
        "check_run_id": check.get("id"),
        "log_id": _job_id(check.get("details_url")),
        "url": check.get("html_url") or check.get("details_url"),
        "summary": (check.get("output") or {}).get("summary"),
    }


def _status(status: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "status",
        "name": status.get("context"),
        "state": status.get("state"),
        "description": status.get("description"),
        "url": status.get("target_url"),
        "log_id": None,
    }


def _job_id(url: str | None) -> int | None:
    match = re.search(r"/job/(\d+)", url or "")
    return int(match.group(1)) if match else None
