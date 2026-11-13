"""Read-only proof for an implementation held before publication.

Only retained CI assertion artifacts are supported. A relay digest or worker
diagnosis cannot substitute for the original producing run.
"""
import re

from github_interface import full_suite_repair
from github_interface.atoms.pulls import get_pull
from github_interface.behaviors import read_issue


async def _run(client, target: str, ident: int, base: str, conclusion: str) -> dict:
    run = await full_suite_repair.verified_run(client, target, str(ident), base, conclusion)
    inventory = await client.get(f"/repos/{target}/actions/runs/{ident}/attempts/{run['attempt']}/jobs", params={"per_page": 100})
    jobs = inventory["jobs"]
    units = [job for job in jobs if job.get("name") in {"Unit & integration (1)", "Unit & integration (2)"}]
    if len(jobs) != inventory["total_count"] or sorted(job["name"] for job in units) != ["Unit & integration (1)", "Unit & integration (2)"] \
            or any(job.get("conclusion") not in {"success", "failure"} for job in units) \
            or any(job.get("conclusion") not in {"success", "skipped", "neutral"} and job not in units
                   and job.get("name") != "Verify (Node 22)" for job in jobs):
        raise ValueError("CI run has incomplete tests or failures outside the assertion suites")
    return {**run, "unit_conclusions": {f"unit-timings-{shard}": next(job["conclusion"] for job in units
            if job["name"] == f"Unit & integration ({shard})") for shard in (1, 2)}}


def _failures(results: dict) -> list:
    failures = []
    for (path, name), entries in sorted(results.items()):
        # Parameterized cases can share one fixed title (e.g. it.each without
        # placeholders); passing duplicates carry no failure and failing ones
        # must match as a multiset across both runs.
        for entry in sorted(entries, key=lambda item: item["cause"]):
            if entry["status"] == "failed":
                failures.append({"file": path, "test": name, "cause": entry["cause"]})
    failures.sort(key=lambda item: (item["file"], item["test"], item["cause"]))
    if not failures or len(failures) > 100 or sum(len(item["cause"]) for item in failures) > 32 * 1024:
        raise ValueError("CI run lacks bounded complete assertion failures")
    return failures


def _totals(results: dict, keys: set) -> list:
    # Every case the original run executed under a failing title, passing or
    # not: a recovered report matching only the originally passing cases must
    # not stand in for the removed failing one.
    return [{"file": path, "test": name, "total": len(entries)}
            for (path, name), entries in sorted(results.items()) if (path, name) in keys]


async def inspect(client, target: str, value: dict, current_base: str) -> dict:
    result = {"verified": False, "recovered": False}
    try:
        if not isinstance(value, dict) or not re.fullmatch(r"[0-9a-f]{40}", str(value.get("base"))) \
                or any(type(value.get(key)) is not int or value[key] < 1 for key in ("run", "baselineRun")) \
                or value["run"] == value["baselineRun"]:
            raise ValueError("test dependency requires the original and independent exact-base CI runs")
        remediation = re.fullmatch(rf"https://github\.com/{re.escape(target)}/issues/([1-9][0-9]*)", str(value.get("remediation")))
        if not remediation:
            raise ValueError("test dependency requires an existing repository remediation issue")
        original = await _run(client, target, value["run"], value["base"], "failure")
        baseline = await _run(client, target, value["baselineRun"], value["base"], "failure")
        original_results = await full_suite_repair.test_results(client, target, original, causes=True)
        failures = _failures(original_results)
        if failures != _failures(await full_suite_repair.test_results(client, target, baseline, causes=True)):
            raise ValueError("original and exact-base runs do not demonstrate every same assertion/cause")
        totals = _totals(original_results, {(item["file"], item["test"]) for item in failures})
        proof = {"base": value["base"], "run": original["id"], "runAttempt": original["attempt"],
                 "baselineRun": baseline["id"], "baselineAttempt": baseline["attempt"],
                 "remediation": value["remediation"], "failures": failures, "totals": totals}
        # Once retained by Caller, reruns or changed artifact contents cannot
        # replace the original cause, even if the new attempt is green.
        if value.get("verified") is True and any(value.get(key) != entry for key, entry in proof.items()):
            raise ValueError("original retained test dependency evidence changed")
        issue = await read_issue.run(client, {"repository": target, "issue": remediation[1]})
        if not isinstance(issue.get("issue"), dict):
            raise ValueError("test dependency remediation is unavailable")
        result.update(proof, verified=True)
        delivery = await read_issue.run(client, {"repository": target, "issue": remediation[1], "delivery_base": current_base})
        if delivery.get("verified") is not True:
            return {**result, "reason": delivery.get("reason", "remediation is not delivered on main")}
        merge = delivery["merge_sha"]
        pull = await get_pull(client, *target.split("/"), delivery["pull_number"])
        if pull.get("merged") is not True or pull.get("merge_commit_sha") != merge \
                or (pull.get("base") or {}).get("ref") != "main" \
                or ((pull.get("base") or {}).get("repo") or {}).get("full_name", "").lower() != target.lower():
            raise ValueError("remediation is not the exact recovery delivered on main")
        comparison = await client.get(f"/repos/{target}/compare/{value['base']}...{merge}")
        if comparison.get("status") != "ahead" or (comparison.get("base_commit") or {}).get("sha") != value["base"] \
                or (comparison.get("merge_base_commit") or {}).get("sha") != value["base"]:
            raise ValueError("delivered recovery does not follow the original tested base")
        inventory = await client.get(f"/repos/{target}/actions/runs", params={"head_sha": current_base, "per_page": 100})
        runs = [run for run in inventory["workflow_runs"] if run.get("path") == ".github/workflows/ci.yml"
                and run.get("head_sha") == current_base and run.get("head_branch") == "main"
                and run.get("event") in {"push", "workflow_dispatch"}]
        if not runs:
            raise ValueError("recovered base has no original-test CI validation")
        latest = max(runs, key=lambda run: run["id"])
        recovered = await _run(client, target, latest["id"], current_base, "success")
        passed = await full_suite_repair.test_results(client, target, recovered, causes=True)
        # Parameterized cases can share one fixed title; the recovered report
        # must pass at least as many cases per failing title as originally
        # ran, so removing a case cannot stand in for fixing it.
        required = {(item["file"], item["test"]): item["total"] for item in totals}
        if any(entries["status"] == "failed" for results in passed.values() for entries in results) \
                or any(len(passed.get(key, [])) < count
                       or any(entry["status"] != "passed" for entry in passed.get(key, []))
                       for key, count in required.items()):
            raise ValueError("recovered base did not pass every original failing assertion")
        result.update(recovered=True, recovery={"merge": merge, "base": current_base,
                      "run": {key: entry for key, entry in recovered.items() if key != "unit_conclusions"}})
    except ValueError as error:
        result.update(recovered=False, reason=str(error))
    return result
