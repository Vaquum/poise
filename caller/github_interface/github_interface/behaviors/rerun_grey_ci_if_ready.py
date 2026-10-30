from typing import Any

import httpx

from github_interface.atoms.pulls import get_pull
from github_interface.behaviors.grey_ci_candidates import GREY_CONCLUSIONS
from github_interface.client import GitHubClient
from github_interface.context import expected_head, repository
from github_interface.context import pull_number as parse_pull_number

REQUIRE_TOKEN_USER = True


def eligible_pull(pull: dict[str, Any], head: str, author: str) -> bool:
    return (pull.get("state") == "open" and pull.get("draft") is False
            and (pull.get("head") or {}).get("sha") == head
            and str((pull.get("user") or {}).get("login") or "").lower() == author.lower())


def eligible_run(run: dict[str, Any], run_id: int, attempt: int, head: str, number: int) -> bool:
    return (run.get("id") == run_id and run.get("run_attempt") == attempt
            and run.get("head_sha") == head and run.get("status") == "completed"
            and run.get("conclusion") in GREY_CONCLUSIONS
            and isinstance(run.get("pull_requests"), list)
            and (not run["pull_requests"] or any(pr.get("number") == number for pr in run["pull_requests"])))


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    number = parse_pull_number(payload)
    head = expected_head(payload)
    author = str(payload.get("author") or "").strip()
    run_id, attempt = payload.get("run_id"), payload.get("run_attempt")
    if not author or any(type(value) is not int or value < 1 for value in (run_id, attempt)):
        raise ValueError("author, positive run-id and run-attempt are required")
    result = {"action": "rerun_grey_ci_if_ready", "repository": f"{owner}/{repo}",
              "pull_number": number, "head_sha": head, "run_id": run_id, "run_attempt": attempt,
              "outcome": "not_ready"}
    if payload.get("inspect"):
        try:
            pull = await get_pull(client, owner, repo, number)
            if (pull.get("head") or {}).get("sha") != head:
                return {**result, "outcome": "superseded"}
            if str((pull.get("user") or {}).get("login") or "").lower() != author.lower():
                raise RuntimeError("workflow recovery pull author differs from the admitted action")
            workflow = await client.get(f"/repos/{owner}/{repo}/actions/runs/{run_id}")
            observed = workflow.get("run_attempt")
            if workflow.get("id") != run_id or workflow.get("head_sha") != head \
                    or type(observed) is not int or observed < attempt:
                raise RuntimeError("workflow recovery evidence conflicts with the admitted run/head/attempt")
            return {**result, "outcome": "rerun_observed" if observed > attempt else "unconfirmed",
                    "observed_run_attempt": observed, "workflow_status": workflow.get("status"), "conclusion": workflow.get("conclusion")}
        except (RuntimeError, httpx.HTTPError, KeyError, TypeError, ValueError) as error:
            return {**result, "outcome": "read_failed", "error": str(error)}
    try:
        readiness = await preflight(client, owner, repo, number, head, author, run_id, attempt)
    except (RuntimeError, httpx.HTTPError, KeyError, TypeError, ValueError) as error:
        return {**result, "outcome": "read_failed", "error": str(error)}
    if readiness != "ready":
        return {**result, "outcome": readiness}
    await client.post(f"/repos/{owner}/{repo}/actions/runs/{run_id}/rerun")
    return {**result, "outcome": "rerun_requested"}


async def preflight(client: GitHubClient, owner: str, repo: str, number: int, head: str,
                    author: str, run_id: int, attempt: int) -> str:
    pull = await get_pull(client, owner, repo, number)
    if (pull.get("head") or {}).get("sha") != head:
        return "superseded"
    if not eligible_pull(pull, head, author):
        return "not_ready"
    path = f"/repos/{owner}/{repo}/actions/runs/{run_id}"
    workflow = await client.get(path)
    if not eligible_run(workflow, run_id, attempt, head, number):
        return "not_ready"
    # Verify the exact attempt, including every matrix job, before rerunning
    # a whole workflow. Active or unknown jobs are never swept into recovery.
    # A failed job beside an interrupted one is collateral: rollup jobs fail
    # *because* a sibling was cancelled, so the run still needs a rerun. A run
    # whose jobs show no interruption merely failed and is left alone.
    page = 1
    jobs = []
    while True:
        data = await client.get(f"{path}/attempts/{attempt}/jobs", params={"per_page": 100, "page": page})
        batch = data["jobs"]
        if not isinstance(batch, list) or type(data["total_count"]) is not int:
            raise RuntimeError("GitHub returned malformed workflow job inventory")
        jobs.extend(batch)
        if len(jobs) >= data["total_count"]:
            if len(jobs) != data["total_count"]:
                raise RuntimeError("GitHub workflow job inventory changed during pagination")
            break
        if not batch:
            raise RuntimeError("GitHub workflow job inventory is incomplete")
        page += 1
    if any(job.get("run_id") != run_id or job.get("run_attempt") != attempt
                       or job.get("status") != "completed"
                       or job.get("conclusion") not in {"success", "skipped", "neutral", "failure", *GREY_CONCLUSIONS}
                       for job in jobs):
        return "not_ready"
    if jobs and not any(job.get("conclusion") in GREY_CONCLUSIONS for job in jobs):
        return "not_ready"
    # Changes between discovery and mutation refuse the operation, including
    # a manually started rerun of this same workflow.
    if not eligible_pull(await get_pull(client, owner, repo, number), head, author):
        return "superseded"
    latest = await client.get(f"/repos/{owner}/{repo}/actions/workflows/{workflow['workflow_id']}/runs",
                              params={"head_sha": head, "event": workflow["event"], "per_page": 1})
    current_runs = latest["workflow_runs"]
    if not current_runs or not eligible_run(current_runs[0], run_id, attempt, head, number):
        return "not_ready"
    return "ready"
