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
    requested = payload.get("ref")
    if requested:
        ref = (pull.get("base") or {}).get("sha") if requested == "base" else requested
        if not isinstance(ref, str) or not re.fullmatch(r"[0-9a-f]{40}", ref):
            raise ValueError("CI ref must be a commit SHA or base")
    checks = await list_check_runs(client, owner, repo, ref, **({"all_runs": True} if requested else {}))
    status = await get_combined_status(client, owner, repo, ref)
    evidence = {}
    if requested:
        commit = await client.get(f"/repos/{owner}/{repo}/commits/{ref}")
        runs, page = [], 1
        while True:
            batch = await client.get(f"/repos/{owner}/{repo}/actions/runs",
                                     params={"head_sha": ref, "per_page": 100, "page": page})
            runs.extend(batch["workflow_runs"])
            if len(batch["workflow_runs"]) < 100:
                break
            page += 1
        evidence = {"ref": ref, "parents": [parent["sha"] for parent in commit["parents"]],
                    "checks": [_check(check) for check in checks],
                    "runs": [{key: run.get(key) for key in ("id", "event", "head_sha", "head_branch", "workflow_id", "run_attempt")}
                             for run in runs]}

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
        "head_sha": pull["head"]["sha"],
        "base_sha": base.get("sha"),
        **evidence,
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
        "head_sha": check.get("head_sha"),
        "run_id": _run_id(check.get("details_url")),
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


def _run_id(url: str | None) -> int | None:
    match = re.search(r"/actions/runs/(\d+)", url or "")
    return int(match.group(1)) if match else None
