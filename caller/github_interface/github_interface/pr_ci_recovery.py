"""Read-only proof for revalidating a held ordinary pull-request CI failure."""
import re

from . import full_suite_repair, test_dependency
from .atoms.pulls import get_pull

SHA = re.compile(r"[a-f0-9]{40}")
GATE = "Verify (Node 22)"
UNIT_SHARDS = {"Unit & integration (1)": "unit-timings-1", "Unit & integration (2)": "unit-timings-2"}


def failure_jobs(target: str, failures: list) -> tuple[int, dict[str, int]]:
    if not isinstance(failures, list) or not 2 <= len(failures) <= 3:
        raise ValueError("the original PR CI failure inventory is incomplete")
    jobs, runs = {}, set()
    for check in failures:
        if not isinstance(check, dict):
            raise ValueError("invalid original PR CI check")
        url = re.fullmatch(rf"https://github\.com/{re.escape(target)}/actions/runs/([1-9][0-9]*)/job/([1-9][0-9]*)",
                           str(check.get("url")))
        name, check_id = check.get("name"), check.get("check_run_id")
        if not url or check.get("type") != "check_run" or check.get("state") != "completed" or check.get("conclusion") != "failure" \
                or name not in {GATE, *UNIT_SHARDS} or name in jobs or type(check_id) is not int \
                or check_id != int(url[2]) or check.get("log_id") != check_id:
            raise ValueError("PR CI includes an unverified or non-assertion failure")
        jobs[name] = check_id
        runs.add(int(url[1]))
    if len(runs) != 1 or GATE not in jobs:
        raise ValueError("PR CI failures do not belong to one failed workflow attempt")
    return runs.pop(), jobs


def _failures(results: dict) -> list:
    failures = test_dependency._failures(results)
    if any(not all(len(line) >= 20 for line in item["cause"].split("\n")) for item in failures):
        raise ValueError("PR CI lacks a specific assertion cause")
    return failures


def _passes(results: dict, totals: list) -> bool:
    return all(len(entries := results.get((item["file"], item["test"]), [])) >= item["total"]
               and all(entry["status"] == "passed" for entry in entries) for item in totals)


async def _compare(client, target, before, after) -> str | None:
    comparison = await client.get(f"/repos/{target}/compare/{before}...{after}", params={"per_page": 1})
    if (comparison.get("base_commit") or {}).get("sha") == before:
        if comparison.get("status") in {"ahead", "identical"} and (comparison.get("merge_base_commit") or {}).get("sha") != before:
            return None
        return comparison.get("status")
    return None


async def _reported_recovery(client, target, pull, run, failures, totals):
    head, base = pull["head"]["sha"], pull["base"]["sha"]
    path = failures[0]["file"]
    if not re.fullmatch(r"tests/[a-zA-Z0-9_./-]+", path):
        return None
    issues = await client.get("/search/issues", params={
        "q": f'repo:{target} is:issue is:closed in:body "{path}" "The full test suite failed on"',
        "sort": "updated", "per_page": 5,
    })
    for report in issues["items"]:
        if report.get("state") != "closed" or report.get("title") != full_suite_repair.TITLE \
                or (report.get("user") or {}).get("login") != full_suite_repair.BOT:
            continue
        number = report["number"]
        comments = await client.get(f"/repos/{target}/issues/{number}/comments", params={"per_page": 100})
        if len(comments) >= 100:
            continue
        failed_pattern = rf"The full test suite failed on `main` at ([a-f0-9]{{40}}): https://github.com/{re.escape(target)}/actions/runs/([1-9][0-9]*)\n"
        passed_pattern = rf"The full suite passed at ([a-f0-9]{{40}}): https://github.com/{re.escape(target)}/actions/runs/([1-9][0-9]*)\n\nClosing\."
        bodies = [report.get("body") or "", *(item.get("body") or "" for item in comments
                  if (item.get("user") or {}).get("login") == full_suite_repair.BOT)]
        failed = passed = None
        for body in bodies:
            if match := re.match(failed_pattern, body):
                failed, passed = match, None
            elif match := re.fullmatch(passed_pattern, body):
                passed = match
        if not failed or not passed or int(passed[2]) <= max(run["id"], int(failed[2])):
            continue
        try:
            baseline = await test_dependency._run(client, target, int(failed[2]), failed[1], "failure")
            if _failures(await full_suite_repair.test_results(client, target, baseline, causes=True, headlines=True)) != failures:
                continue
            remediation = passed[1]
            if await _compare(client, target, failed[1], remediation) != "ahead" \
                    or await _compare(client, target, remediation, base) not in {"ahead", "identical"}:
                continue
            # The reporter supplies run locators. Verify the passing revision
            # is a different delivered PR that touched the failed tests.
            linked = await client.get(f"/repos/{target}/commits/{remediation}/pulls", params={"per_page": 100})
            repairs = [item for item in linked if item.get("merge_commit_sha") == remediation and item.get("merged_at")
                       and item.get("number") != pull["number"] and (item.get("base") or {}).get("ref") == "main"
                       and ((item["base"].get("repo") or {}).get("full_name") or "").lower() == target.lower()]
            if len(linked) >= 100 or len(repairs) != 1:
                continue
            files = await client.get(f"/repos/{target}/pulls/{repairs[0]['number']}/files", params={"per_page": 100})
            if len(files) >= 100 or not {item["file"] for item in failures} <= {item["filename"] for item in files}:
                continue
            recovered = await test_dependency._run(client, target, int(passed[2]), remediation, "success")
            if not _passes(await full_suite_repair.test_results(client, target, recovered, causes=True), totals):
                continue
            if base != remediation:
                inventory = await client.get(f"/repos/{target}/actions/workflows/{run['workflow_id']}/runs",
                                             params={"head_sha": base, "branch": "main", "per_page": 20})
                main_runs = [item for item in inventory["workflow_runs"] if item.get("head_sha") == base
                             and item.get("event") in {"push", "workflow_dispatch"}]
                if not main_runs or inventory["total_count"] > 20:
                    continue
                recovered = await test_dependency._run(client, target, max(item["id"] for item in main_runs), base, "success")
                if not _passes(await full_suite_repair.test_results(client, target, recovered, causes=True), totals):
                    continue
            return {"report": number, "baselineRun": baseline["id"], "passedRun": recovered["id"], "remediation": remediation}
        except ValueError:
            # Each report is a hint. Inconsistent or incomplete evidence
            # cannot establish recovery, even when the report is closed.
            continue
    return None


async def inspect(client, target: str, pull: dict, retained: list, current: list) -> dict | None:
    head, base = pull["head"]["sha"], pull["base"]["sha"]
    if pull.get("state") != "open" or pull.get("merged") is not False or pull.get("draft") is not False \
            or pull.get("mergeable") is not True or pull["base"].get("ref") != "main" \
            or any((pull[side].get("repo") or {}).get("full_name", "").lower() != target.lower() for side in ("head", "base")) \
            or not SHA.fullmatch(head) or not SHA.fullmatch(base):
        return None
    try:
        run_id, failed_jobs = failure_jobs(target, retained)
        if failure_jobs(target, current) != (run_id, failed_jobs):
            return None
        run = await client.get(f"/repos/{target}/actions/runs/{run_id}")
        if run.get("id") != run_id or run.get("head_sha") != head or run.get("head_branch") != pull["head"].get("ref") \
                or (run.get("head_repository") or {}).get("full_name", "").lower() != target.lower() \
                or run.get("event") != "pull_request" or run.get("path") != ".github/workflows/ci.yml" \
                or run.get("status") != "completed" or run.get("conclusion") != "failure" \
                or any(type(run.get(key)) is not int or run[key] < 1 for key in ("workflow_id", "run_attempt")):
            return None
        packet = await client.get(f"/repos/{target}/actions/runs/{run_id}/attempts/{run['run_attempt']}/jobs", params={"per_page": 100})
        jobs = packet["jobs"]
        units = {UNIT_SHARDS[job["name"]]: job["conclusion"] for job in jobs
                 if job["name"] in UNIT_SHARDS and job["conclusion"] != "skipped"}
        red = {job["name"]: job["id"] for job in jobs if job["conclusion"] == "failure"}
        if len(jobs) != packet["total_count"] or len({job["name"] for job in jobs}) != len(jobs) or red != failed_jobs \
                or not units or any(job.get("status") != "completed" or job.get("conclusion") not in {"success", "failure", "skipped", "neutral"}
                                    for job in jobs):
            return None
        results = await full_suite_repair.test_results(client, target, {**run, "unit_conclusions": units}, causes=True, headlines=True)
        failures = _failures(results)
        totals = test_dependency._totals(results, {(item["file"], item["test"]) for item in failures})
    except ValueError:
        return None
    if await _compare(client, target, base, head) not in {"behind", "diverged"}:
        return None
    proof = await _reported_recovery(client, target, pull, run, failures, totals)
    if proof is None:
        return None
    latest = await get_pull(client, *target.split("/"), pull["number"])
    if latest["head"]["sha"] != head or latest["base"]["sha"] != base or latest.get("mergeable") is not True:
        return None
    return {**proof, "head": head, "base": base, "workflow": run["workflow_id"], "failedRun": run_id,
            "checks": sorted(failed_jobs.values())}
