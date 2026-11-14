import asyncio
import re
import tempfile
from typing import Any

from github_interface.atoms.process_diagnostic import GitProcessError
from github_interface.atoms.pulls import get_combined_status, get_pull, list_check_runs
from github_interface.atoms.review_diff import _env, _git
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
    from_head = payload.get("base_update_from")
    if from_head is not None and (not isinstance(from_head, str) or not re.fullmatch(r"[0-9a-f]{40}", from_head)):
        raise ValueError("base update source must be a commit SHA")
    if requested:
        ref = (pull.get("base") or {}).get("sha") if requested == "base" else requested
        if not isinstance(ref, str) or not re.fullmatch(r"[0-9a-f]{40}", ref):
            raise ValueError("CI ref must be a commit SHA or base")
    checks = await list_check_runs(client, owner, repo, ref, **({"all_runs": True} if requested else {}))
    status = await get_combined_status(client, owner, repo, ref)
    evidence = {}
    if requested or from_head:
        commit = await client.get(f"/repos/{owner}/{repo}/commits/{ref}")
        evidence = {"ref": ref, "parents": [parent["sha"] for parent in commit["parents"]]}
    if requested:
        runs, page = [], 1
        while True:
            batch = await client.get(f"/repos/{owner}/{repo}/actions/runs",
                                     params={"head_sha": ref, "per_page": 100, "page": page})
            runs.extend(batch["workflow_runs"])
            if len(batch["workflow_runs"]) < 100:
                break
            page += 1
        evidence.update({"checks": [_check(check) for check in checks],
                         "runs": [{key: run.get(key) for key in ("id", "event", "head_sha", "head_branch", "workflow_id", "run_attempt", "status", "conclusion")}
                                  for run in runs]})

    failing_checks = [_check(check) for check in checks if _check_failing(check)]
    failing_statuses = [_status(item) for item in status.get("statuses", []) if item.get("state") != "success"]
    # Merge state, author, draft flag and pull state ride the same get_pull
    # response the head SHA already comes from: the work monitor's
    # conflict/behind/terminal read costs zero additional GitHub requests.
    # mergeable is None while GitHub is still computing it; the monitor
    # treats that as no observation.
    user = pull.get("user") or {}
    base = pull.get("base") or {}
    if from_head:
        if ref != pull["head"]["sha"] or not re.fullmatch(r"[0-9a-f]{40}", str(base.get("sha"))):
            raise ValueError("base update proof requires the current PR head and base")
        if commit.get("sha") != ref:
            raise RuntimeError("base update commit differs from the inspected head")
        evidence["base_update"] = (None if failing_checks or failing_statuses else
                                   await _base_update(client, owner, repo, ref, from_head, base["sha"], commit))
        latest = await get_pull(client, owner, repo, pull_number)
        if latest["head"]["sha"] != ref or latest["base"]["sha"] != base["sha"]:
            raise RuntimeError("PR head or base changed during base update proof")
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


async def _base_update(client, owner, repo, head, from_head, base, commit):
    parents = [parent["sha"] for parent in commit["parents"]]
    if len(parents) != 2 or parents[0] != from_head:
        return None
    env = _env(client.token)
    with tempfile.TemporaryDirectory(prefix="caller-base-update-") as directory:
        async def git(*args):
            return await asyncio.to_thread(_git, directory, env, *args, timeout=20)

        await git("init", "--bare", "--quiet", "--template=")
        await git("remote", "add", "origin", f"https://github.com/{owner}/{repo}.git")
        await git("config", "remote.origin.promisor", "true")
        await git("config", "remote.origin.partialclonefilter", "blob:none")
        await git("fetch", "--quiet", "--no-tags", "--filter=blob:none", "origin", head, base)
        try:
            await git("merge-base", "--is-ancestor", parents[1], base)
            # Parents and ancestry cannot exclude edits made in the merge.
            tree = (await git("merge-tree", "--write-tree", from_head, parents[1])).decode().strip()
        except GitProcessError as error:
            if error.diagnostic["outcome"] == "exit" and error.diagnostic["exit_code"] == 1:
                return None  # Non-base parent or a conflicting integration.
            raise
    return {"from": from_head, "base": parents[1], "tree": tree} if tree == commit["commit"]["tree"]["sha"] else None


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
