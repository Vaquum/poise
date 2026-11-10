"""One implementation or repair invocation, with no persistent model session."""
import json
import re
import subprocess
from pathlib import Path
from time import monotonic
from typing import Callable

from . import checkout_lock, issue_review, progress, review_budget, resource_ownership
from .model_catalog import Model
from .process_diagnostic import diagnostic_envelope

UNATTENDED = "You are one atomic implementation/repair behavior. Work unattended; report a blocker instead of inventing a human answer. Caller owns publication."


class AtomicWorkBlocked(ValueError):
    code = "atomic_work_blocked"


def _verify_ci_dependency(value: dict, repo: str, pull: int, head: str, actor: str, queue: dict) -> dict:
    """Bind a worker's diagnosis to native integration and exact-base log evidence."""
    if not isinstance(value, dict) or value.get("head") != head \
            or not re.fullmatch(rf"https://github\.com/{re.escape(repo)}/(?:issues|pull)/[1-9][0-9]*", str(value.get("remediation"))):
        raise ValueError("CI dependency lacks its candidate or remediation")
    removals = queue.get("queue_removals", [])
    removal = removals[-1] if removals else None
    if queue.get("head_sha") != head or not removal or removal.get("reason") != "failed_checks" \
            or removal.get("id") != value.get("removal") \
            or (removal.get("beforeCommit") or {}).get("oid") != value.get("integration"):
        raise ValueError("CI dependency does not identify the failed queue integration")
    common = [str(pull), "--repository", repo, "--token-user", actor]
    integration = issue_review.interface("--list-failing-ci", *common, "--ref", str(value["integration"]))
    base = value.get("base")
    parents = integration.get("parents", [])
    if integration.get("head_sha") != head or integration.get("ref") != value["integration"] \
            or not parents or parents[0] != base or head not in parents[1:]:
        raise ValueError("CI dependency integration does not contain the exact candidate and base")
    baseline = issue_review.interface("--list-failing-ci", *common, "--ref", str(base))
    failures = value.get("failures")
    if baseline.get("head_sha") != head or baseline.get("ref") != base \
            or not isinstance(failures, list) or not failures or len(failures) > 100:
        raise ValueError("CI dependency lacks exact-base failure evidence")
    verified, used = [], set()
    for failure in failures:
        if not isinstance(failure, dict):
            raise ValueError("CI dependency failure evidence is invalid")
        check = next((item for item in integration["failing"] if item.get("check_run_id") == failure.get("check")), None)
        prior = next((item for item in baseline["failing"] if item.get("check_run_id") == failure.get("baselineCheck")), None)
        excerpt = failure.get("evidence")
        if not check or not prior or check["check_run_id"] in used or check.get("head_sha") != value["integration"] \
                or prior.get("head_sha") != base or check.get("name") != prior.get("name") \
                or check.get("state") != "completed" or check.get("conclusion") != "failure" \
                or prior.get("state") != "completed" or prior.get("conclusion") != "failure" \
                or not isinstance(excerpt, str) or not 20 <= len(excerpt.strip()) <= 2000:
            raise ValueError("CI dependency requires matching completed failures and a specific cause excerpt")
        run = next((item for item in integration["runs"] if item.get("id") == check.get("run_id")), None)
        base_run = next((item for item in baseline["runs"] if item.get("id") == prior.get("run_id")), None)
        if not run or run.get("event") != "merge_group" or run.get("head_sha") != value["integration"] \
                or not base_run or base_run.get("head_sha") != base or base_run.get("event") not in {"push", "workflow_dispatch", "schedule"} \
                or not run.get("workflow_id") or run["workflow_id"] != base_run.get("workflow_id"):
            raise ValueError("CI dependency workflow identities do not prove a baseline failure")
        for item in (check, prior):
            if not item.get("log_id"):
                raise ValueError("CI dependency has no readable job log")
            log = issue_review.interface("--read-failing-ci-log", str(item["log_id"]), "--repository", repo, "--token-user", actor)
            if log.get("repository", "").lower() != repo.lower() or excerpt not in log.get("log", ""):
                raise ValueError("CI dependency cause is absent from its actual job logs")
        used.add(check["check_run_id"])
        verified.append({**failure, "name": check["name"], "run": run["id"], "workflow": run["workflow_id"],
                         "baselineRun": base_run["id"]})
    remediation = issue_review.interface("--read-issue", value["remediation"].rsplit("/", 1)[1],
                                         "--repository", repo, "--token-user", actor)
    if not remediation.get("issue"):
        raise ValueError("CI dependency remediation could not be read")
    return {**value, "failures": verified,
            "allShared": len(used) == len(integration["failing"])}


def _ci_only_blocker(ci: object) -> object:
    # Durable CI-only evidence is the packet identity plus the failed
    # check/job IDs that pin the original run attempt. Full check summaries
    # can exceed the 128 KiB receipt limit and would turn an explicit CI-only
    # blocker into an unrecoverable failure.
    if not isinstance(ci, dict):
        return ci
    failing = ci.get("failing")
    compact: list[object] = []
    if isinstance(failing, list):
        for entry in failing:
            if isinstance(entry, dict):
                compact.append({key: entry[key] for key in
                                ("type", "name", "state", "conclusion", "check_run_id", "log_id", "url")
                                if key in entry})
    return {
        "action": ci.get("action"),
        "repository": ci.get("repository"),
        "pull_number": ci.get("pull_number"),
        "head_sha": ci.get("head_sha"),
        "failing": compact,
    }


def run(model: Model, repo: str, number: int, branch: str, actor: str, work: Path,
        call_id: str, record: Callable[[dict], None], pull: int | None = None,
        expected_head: str | None = None, note: str = "", merge_base: bool = False, expected_issue_revision: str | None = None) -> dict:
    work.mkdir(parents=True, exist_ok=True)
    checkout = work / "repo"
    output = work / "publication.json"
    common = [f"#{number}", "--repository", repo, "--branch", branch, "--token-user", actor, "--invocation-id", call_id]
    if pull is not None:
        common.extend(["--pull-number", str(pull)])
    if expected_head:
        common.extend(["--expected-head", expected_head])
    progress.stage("preparing_issue", "Reading the issue and its actual review comments")
    data = issue_review.packet(repo, number, actor)
    if data["issue"]["state"] != "open":
        raise ValueError("seed issue is no longer open")
    if expected_issue_revision and issue_review.revision(data["issue"]) != expected_issue_revision:
        raise ValueError("seed issue changed before implementation/repair")
    prepared = issue_review.interface("--issue-work", *common, "--mode", "prepare", "--path", str(checkout),
                                      *(["--merge-base"] if merge_base else []), seconds=1800)
    if prepared.get("outcome") != "prepared":
        return prepared
    record({"phase": "prepared", "prepared": prepared})
    evidence = {}
    required_reply_ids: set[int] = set()
    if pull is not None:
        evidence["ci"] = issue_review.interface("--list-failing-ci", str(pull), "--repository", repo, "--token-user", actor)
        evidence["review_packet"] = issue_review.interface("--pr-review", str(pull), "--expected-head", expected_head or "",
                                                          "--token-user", actor, cwd=checkout)
        required_reply_ids = {thread["root_comment_id"] for thread in evidence["review_packet"]["review_threads"] if not thread["is_resolved"]}
        evidence["queue"] = issue_review.interface("--pull-action-state", str(pull), "--repository", repo,
                                                   "--token-user", actor, "--queue-evidence")
    seconds = review_budget.timeout(issue_review.TIMEOUT_SECONDS, reserve=issue_review.POST_RESERVE_SECONDS)
    instruction = (
        f"Read AGENTS.md and its routed repository instructions first. You are the {'PR repair' if pull else 'issue implementation'} behavior "
        f"for {repo}#{number}. Read the issue and ALL its review comments below before changing code. "
        "Implement the actual requested behavior with minimal changes and meaningful regression coverage. "
        "For a repair, address every actionable review/CI/conflict blocker in the evidence; inspect actual CI logs through github-interface. "
        "Keep repairs scoped to the seed issue. Never independently edit a verified shared baseline failure; use its existing remediation. "
        "Green PR checks, another PR failing the same shard, or a remediation link alone do not establish a shared cause. "
        "For a shared queue failure, add ciDependency to the JSON: {head: candidate SHA, removal: queue removal id, "
        "integration: failed merge-group SHA, base: its first parent SHA, remediation: existing GitHub issue/PR URL, "
        "failures: [{check: failed check id, baselineCheck: failed check id on that exact base, evidence: specific common failure excerpt}]}. "
        "For a verified shared-only failure leave blocked null; Caller retains a recoverable wait without publishing a baseline patch. "
        "Use github-interface --list-failing-ci PR --ref SHA to inspect integration/base checks, parents and workflow runs, "
        "and --read-failing-ci-log for the actual causes. Account for every cause in each claimed shared check; "
        "a generic failure line is insufficient. Fix candidate-specific failures and review findings normally alongside the dependency. "
        "Incomplete or contradictory evidence remains unresolved; do not claim it shared or return no_changes as acceptance. "
        "Run the repository's required checks. Never fabricate reviews, approvals, CI, completion, or tests. "
        "Do not start other agents or chats, schedule work, create orchestration scripts, modify Poise settings, "
        "commit, push, open a PR, submit reviews, resolve threads or merge. Caller performs publication after this invocation ends. "
        "Keep HEAD unchanged; leave real edits in this checkout. The preparation receipt names any base merge already in progress and actual conflicts to resolve; "
        "never force-push, rewrite history or weaken repository rules. "
        f"Write JSON to {output}: {{\"commitMessage\":\"Conventional Commit subject\",\"title\":\"Conventional Commit PR title\","
        "\"body\":\"Concrete change, reason and actual checks, without a Closes footer\","
        "\"replies\":[{\"commentId\":123,\"body\":\"Your concrete answer to this actual review finding, including what changed or evidence for disagreement\"}],\"blocked\":null}}. "
        f"For a repair, include one substantive answer for each of these required unresolved root comment IDs: {json.dumps(sorted(required_reply_ids))}. "
        "This exact set includes outdated unresolved roots and roots that already have replies; answer each with concrete changes or evidence for disagreement. "
        "Do not reply to replies, invent comment ids, or use generic acknowledgements. For initial implementation replies must be empty. "
        "If unable to finish, set blocked to the concrete reason; do not claim the work complete. "
        'If a repair is blocked solely by failed CI on the supplied head, set blocked to {"cause":"ci_only","reason":"the concrete CI blocker"}. '
        "Use a string for every other blocker, including missing evidence, a product decision or uncertain publication. "
        f"You have {int(seconds)} seconds. This invocation ends after edits/checks and that file.\n"
        f"Behavior note: {note}\nPreparation receipt:\n{json.dumps(prepared)}\nActual issue and comments:\n{json.dumps(data)}\nActual PR evidence:\n{json.dumps(evidence)}"
    )
    args, stdin, env = issue_review.command(model, instruction, checkout, work, seconds, UNATTENDED)
    lease = checkout_lock.Lease(str(checkout), call_id, f"atomic behavior {repo}#{number} ({call_id[:8]})", owner_kind="caller:repair-pr" if pull else "caller:implement-issue")
    with checkout_lock.interruptible():
        lease.acquire(checkout_lock.ACQUIRE_WAIT_SECONDS)
        try:
            record({"phase": "executing", "prepared": prepared})
            progress.stage("waiting_provider", "Waiting for atomic behavior provider", timeout=seconds)
            started = monotonic()
            try:
                done = checkout_lock.run_gated(lease, args, input=stdin, cwd=str(checkout), timeout=seconds, env=env, provider=model.provider)
            except subprocess.TimeoutExpired as error:
                raise review_budget.ReviewLimitError(
                    "Atomic behavior provider exhausted its execution budget; no publication attempted",
                    "atomic_work_execution_budget_exhausted",
                    diagnostic_envelope(operation="provider.atomic_work", phase="provider_execution", outcome="timed_out",
                                        executable=model.provider, elapsed_ms=round((monotonic() - started) * 1000),
                                        timeout_seconds=seconds, repository=repo, pr=pull, expected_head=expected_head,
                                        behavior="repair_pr" if pull is not None else "implement_issue",
                                        message=f"Seed issue {repo}#{number}", submission="none")) from error
            record({"phase": "resources_unknown", "prepared": prepared})
            issue_review.stop_leftovers(work)
            if issue_review._cwd_pids(work, require_complete=True) != []:
                raise checkout_lock.WorkerOrphaned("atomic behavior resources could not be proven released")
            bound = resource_ownership.binding()
            if bound is not None:
                resource_ownership.process_check(*bound, complete=True)
            record({"phase": "executing", "prepared": prepared})
            terminal = issue_review._terminal_failure(model.provider, done.stdout)
            if done.returncode or terminal:
                raise RuntimeError(terminal or issue_review.provider_error(done.stdout, done.stderr) or f"provider exited {done.returncode}")
            if not output.is_file() or output.stat().st_size > 64 * 1024:
                raise ValueError("atomic behavior returned no bounded publication metadata")
            publication = json.loads(output.read_text())
            if not isinstance(publication, dict):
                raise ValueError("atomic behavior blocked: invalid output")
            if publication.get("blocked"):
                blocked = publication["blocked"]
                if pull is not None and isinstance(blocked, dict) and set(blocked) == {"cause", "reason"} \
                        and blocked["cause"] == "ci_only" and isinstance(blocked["reason"], str) and blocked["reason"].strip():
                    record({"phase": "executing", "prepared": prepared, "ci_blocker": _ci_only_blocker(evidence["ci"])})
                    blocked = blocked["reason"]
                raise AtomicWorkBlocked(f"atomic behavior blocked: {blocked}")
            dependency = None
            if publication.get("ciDependency") is not None:
                if pull is None or not expected_head:
                    raise ValueError("CI dependencies require an exact repair candidate")
                dependency = _verify_ci_dependency(publication["ciDependency"], repo, pull, expected_head, actor, evidence["queue"])
                if dependency["remediation"] in {f"https://github.com/{repo}/issues/{number}", f"https://github.com/{repo}/pull/{pull}"}:
                    raise ValueError("CI dependency cannot use its own repair as the external remediation")
            if any(not isinstance(publication.get(key), str) or not publication[key].strip() for key in ("commitMessage", "title", "body")):
                raise ValueError("atomic behavior publication metadata is incomplete")
            replies = publication.get("replies", [])
            if not isinstance(replies, list) or (pull is None and replies):
                raise ValueError("atomic behavior returned invalid review replies")
            if pull is not None:
                answered = {reply.get("commentId") for reply in replies if isinstance(reply, dict)}
                missing = sorted(required_reply_ids - answered)
                if missing:
                    raise ValueError("repair did not answer every unresolved review finding: "
                                     f"missing_root_comment_ids={json.dumps(missing[:20])}; "
                                     f"missing_count={len(missing)}; required_count={len(required_reply_ids)}")
            # run_gated releases only after the complete worker group exits.
            # Publication is a separate bounded writer under the same lease.
            lease.acquire(checkout_lock.ACQUIRE_WAIT_SECONDS)
            if expected_issue_revision and issue_review.revision(issue_review._issue(repo, number, actor)) != expected_issue_revision:
                raise ValueError("seed issue changed during implementation/repair; no publication attempted")
            publication_args = ["--issue-work", *common, "--path", str(checkout),
                                "--starting-head", prepared["checkout_head"], "--message", publication["commitMessage"],
                                "--title", publication["title"], "--body", publication["body"], "--replies-json", json.dumps(replies)]
            validated = issue_review.interface(*publication_args, "--mode", "validate", seconds=120)
            if validated.get("outcome") == "superseded":
                return validated
            if validated.get("outcome") != "validated":
                raise ValueError("publication validation returned no confirmation; no publication attempted")
            if dependency is not None:
                if type(validated.get("has_changes")) is not bool:
                    raise ValueError("CI dependency requires a complete checkout validation")
                record({"phase": "executing", "prepared": prepared, "ci_dependency": dependency})
                candidate_checks = [check for check in evidence["ci"].get("failing", [])
                                    if check.get("state") in {"failure", "error"}
                                    or check.get("state") == "completed" and check.get("conclusion") not in {"success", "neutral", "skipped", None}]
                candidate_blockers = candidate_checks or merge_base or any(
                    not thread["is_resolved"] for thread in evidence["review_packet"]["review_threads"])
                if dependency["allShared"] and not candidate_blockers and validated.get("has_changes") is not True:
                    # A shared-only diagnosis with no candidate edits retains
                    # only its external dependency. Validated edits publish
                    # normally: one shared check can co-locate a
                    # candidate-specific failure the excerpt cannot disprove,
                    # and discarding that fix would head-of-line block the
                    # candidate behind the baseline remediation.
                    record({"phase": "waiting_baseline", "prepared": prepared, "ci_dependency": dependency})
                    return {"outcome": "no_changes", "head_sha": expected_head}
                if validated.get("has_changes") is not True and not dependency["allShared"]:
                    raise AtomicWorkBlocked("candidate integration failures remain unresolved alongside the shared dependency")
                if validated.get("has_changes") is False and not replies:
                    if evidence["ci"].get("failing"):
                        raise AtomicWorkBlocked("candidate CI failures remain unresolved alongside the shared dependency")
                    record({"phase": "waiting_baseline", "prepared": prepared, "ci_dependency": dependency})
                    return {"outcome": "no_changes", "head_sha": expected_head}
            receipt = {"phase": "publishing", "prepared": prepared, "publication": publication}
            record(receipt)
            progress.stage("publishing", "Publishing the verified checkout through github-interface")
            published = issue_review.interface(*publication_args, "--mode", "publish", seconds=120)
            record({**receipt, "phase": "published", "result": published})
            return published
        finally:
            if lease.held:
                lease.release()
