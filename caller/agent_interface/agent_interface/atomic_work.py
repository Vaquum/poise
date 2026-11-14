"""One implementation or repair invocation, with no persistent model session."""
import json
import os
import re
import secrets
import subprocess
import sys
from pathlib import Path
from time import monotonic
from typing import Callable

from . import atoms, checkout_lock, failed_source, issue_review, native_namespace, progress, review_budget, resource_ownership
from .model_catalog import Model
from .process_diagnostic import diagnostic_envelope, escaped_failure

UNATTENDED = "You are one atomic implementation/repair behavior. Work unattended; report a blocker instead of inventing a human answer. Caller owns publication."


class AtomicWorkFailed(ValueError):
    """A Caller-authored validation reason, safe to retain as diagnostic detail."""


def failure_diagnostic(error: Exception) -> dict:
    phase = progress.phase() or "preparing_issue"
    evidence = escaped_failure(error, phase)
    # External exception text can contain prompts, argv or provider output.
    detail = str(error) if type(error) is AtomicWorkFailed else evidence["message"]
    if isinstance(error, json.JSONDecodeError):
        detail = f"invalid JSON at line {error.lineno}, column {error.colno}"
    evidence["message"] = atoms.bounded_cause(f"atomic behavior failed during {phase}: {detail} ({evidence['operation']})")
    return evidence


class AtomicWorkBlocked(ValueError):
    code = "atomic_work_blocked"

    def __init__(self, reason: object):
        message = "AtomicWorkBlocked"
        stderr = ""
        if isinstance(reason, str) and reason.strip():
            # Mask complete environment credentials around pattern redaction:
            # values patterns would only fragment (a ghp_ token or a Bearer
            # token inside a JSON credential) are masked whole first;
            # values carrying a header shape wait until after so masking
            # cannot rewrite the pattern keyword and leave a trailing secret.
            secrets = sorted({value for key, value in os.environ.items()
                              if value and re.search(r"TOKEN|KEY|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE|GIT_CONFIG_VALUE", key, re.I)},
                             key=len, reverse=True)
            safe = reason
            if secrets:
                marker = r"\[redacted(?: header| credential)?\]"
                markers = ("[redacted]", "[redacted header]", "[redacted credential]")
                keyword_end = re.compile(r"(?i)\b(?:proxy-authorization|authorization|set-cookie|cookie|bearer|basic|token)\s*[:=]?\s*$")
                keyword_any = re.compile(r"(?i)\b(?:proxy-authorization|authorization|set-cookie|cookie|bearer|basic|token)\b")
                forms: dict[str, bool] = {}
                extra: set[str] = set()

                def _fragment(text: str) -> None:
                    # Secret-looking fragments of values the before-pass must
                    # not touch: long enough to identify, or structured. Short
                    # plain words stay readable (a bare scheme or context word
                    # carries no credential), and markers are never fragments.
                    text = text.strip()
                    if not text or text in markers:
                        return
                    if len(text) >= 8 or len(text) >= 4 and re.search(r"[^A-Za-z ]", text):
                        extra.add(text)

                for value in secrets:
                    norm = " ".join(value.split())
                    end = keyword_end.search(norm) if norm else None
                    if end:
                        # A trailing keyword is left for the patterns, but the
                        # secret material before it would otherwise persist
                        # once the pattern consumes the keyword and its token.
                        # Split on every keyword too: the credential pattern
                        # can re-pair across value boundaries (matching a
                        # keyword as another keyword's token) and strand the
                        # middle of the value.
                        _fragment(norm[:end.start()])
                        for segment in keyword_any.split(norm):
                            _fragment(segment)
                        continue
                    for form in {value, norm}:
                        if not form:
                            continue
                        shaped = atoms.redact_cause(form)
                        if shaped != form and shaped not in markers and "[redacted header]" not in shaped:
                            forms[form] = True
                    if not norm:
                        continue
                    shaped_norm = atoms.redact_cause(norm)
                    if "[redacted header]" in shaped_norm:
                        # Header-shaped values also wait for the patterns; mask
                        # each surviving prefix segment separately, since later
                        # patterns may separate them with redaction markers.
                        for segment in re.split(marker, shaped_norm.split("[redacted header]")[0]):
                            _fragment(segment)
                    if re.search(marker, norm):
                        # Marker-first alternation would preserve a literal
                        # marker inside the value and shield the remainder, so
                        # mask the non-marker segments directly.
                        for segment in re.split(marker, norm):
                            _fragment(segment)
                before = sorted(forms, key=len, reverse=True)
                if before:
                    safe = re.sub(marker + "|" + "|".join(map(re.escape, before)),
                                  lambda match: match[0] if re.fullmatch(marker, match[0]) else "[redacted]", safe)
                safe = atoms.redact_cause(" ".join(safe.split()))
                # Match the normalized safe: raw values with newlines, tabs or
                # repeated/outer whitespace would otherwise miss their
                # normalized occurrence and persist. Include before values'
                # normalized forms too; masking after patterns cannot rewrite
                # a pattern keyword.
                normed = sorted({" ".join(value.split()) for value in secrets if " ".join(value.split())} | extra,
                                key=len, reverse=True)
                if normed:
                    # Values under four characters would rewrite common words,
                    # so require word boundaries for them while still redacting
                    # bare occurrences. Longer values mask substrings so an
                    # embedded secret stays masked without touching markers.
                    tiny = [value for value in normed if len(value) < 4]
                    rest = [value for value in normed if len(value) >= 4]
                    alternatives = [re.escape(value) for value in rest]
                    if tiny:
                        alternatives.append(r"(?<![A-Za-z0-9_])(?:" + "|".join(map(re.escape, tiny)) + r")(?![A-Za-z0-9_])")
                    safe = re.sub(marker + "|" + "|".join(alternatives),
                                  lambda match: match[0] if re.fullmatch(marker, match[0]) else "[redacted]", safe)
            # Mask complete credentials before whitespace normalization or the
            # cutoff, including a secret spanning either boundary.
            # Leave room for JSON-escaped Unicode and the short summary in the
            # diagnostic stream's 64 KiB event, without losing the first failure.
            stderr = atoms.bounded_cause(safe, limit=4096)
            message = "atomic behavior blocked: " + atoms.bounded_cause(stderr)
        super().__init__(message)
        self.diagnostic = diagnostic_envelope(operation="provider.atomic_work", phase="validating", outcome="blocked",
                                              message=message, submission="none", stderr=stderr,
                                              stderr_truncated=len(stderr) > 4096)


def _verify_ci_dependency(value: dict, repo: str, pull: int, head: str, actor: str, queue: dict) -> dict:
    """Bind a worker's diagnosis to native integration and exact-base log evidence."""
    if not isinstance(value, dict) or value.get("head") != head \
            or not re.fullmatch(rf"https://github\.com/{re.escape(repo)}/(?:issues|pull)/[1-9][0-9]*", str(value.get("remediation"))):
        raise AtomicWorkFailed("CI dependency lacks its candidate or remediation")
    removals = queue.get("queue_removals", [])
    removal = removals[-1] if removals else None
    if queue.get("head_sha") != head or not removal or removal.get("reason") != "failed_checks" \
            or removal.get("id") != value.get("removal") \
            or (removal.get("beforeCommit") or {}).get("oid") != value.get("integration"):
        raise AtomicWorkFailed("CI dependency does not identify the failed queue integration")
    common = [str(pull), "--repository", repo, "--token-user", actor]
    integration = issue_review.interface("--list-failing-ci", *common, "--ref", str(value["integration"]))
    base = value.get("base")
    parents = integration.get("parents", [])
    if integration.get("head_sha") != head or integration.get("ref") != value["integration"] \
            or not parents or parents[0] != base or head not in parents[1:]:
        raise AtomicWorkFailed("CI dependency integration does not contain the exact candidate and base")
    baseline = issue_review.interface("--list-failing-ci", *common, "--ref", str(base))
    failures = value.get("failures")
    if baseline.get("head_sha") != head or baseline.get("ref") != base \
            or not isinstance(failures, list) or not failures or len(failures) > 100:
        raise AtomicWorkFailed("CI dependency lacks exact-base failure evidence")
    sgr = re.compile(r"\x1b\[[0-9;]*m")
    verified, used = [], set()
    for failure in failures:
        if not isinstance(failure, dict):
            raise AtomicWorkFailed("CI dependency failure evidence is invalid")
        check = next((item for item in integration["failing"] if item.get("check_run_id") == failure.get("check")), None)
        prior = next((item for item in baseline["failing"] if item.get("check_run_id") == failure.get("baselineCheck")), None)
        excerpt = failure.get("evidence")
        visible_excerpt = sgr.sub("", excerpt) if isinstance(excerpt, str) else ""
        if not check or not prior or check["check_run_id"] in used or check.get("head_sha") != value["integration"] \
                or prior.get("head_sha") != base or check.get("name") != prior.get("name") \
                or check.get("state") != "completed" or check.get("conclusion") != "failure" \
                or prior.get("state") != "completed" or prior.get("conclusion") != "failure" \
                or not isinstance(excerpt, str) or len(excerpt.strip()) > 2000 or len(visible_excerpt.strip()) < 20:
            raise AtomicWorkFailed("CI dependency requires matching completed failures and a specific cause excerpt")
        run = next((item for item in integration["runs"] if item.get("id") == check.get("run_id")), None)
        base_run = next((item for item in baseline["runs"] if item.get("id") == prior.get("run_id")), None)
        if not run or run.get("event") != "merge_group" or run.get("head_sha") != value["integration"] \
                or not base_run or base_run.get("head_sha") != base or base_run.get("event") not in {"push", "workflow_dispatch", "schedule"} \
                or not run.get("workflow_id") or run["workflow_id"] != base_run.get("workflow_id"):
            raise AtomicWorkFailed("CI dependency workflow identities do not prove a baseline failure")
        for item in (check, prior):
            if not item.get("log_id"):
                raise AtomicWorkFailed("CI dependency has no readable job log")
            log = issue_review.interface("--read-failing-ci-log", str(item["log_id"]), "--repository", repo, "--token-user", actor)
            if log.get("repository", "").lower() != repo.lower() or visible_excerpt not in sgr.sub("", log.get("log", "")):
                raise AtomicWorkFailed("CI dependency cause is absent from its actual job logs")
        used.add(check["check_run_id"])
        verified.append({**failure, "name": check["name"], "run": run["id"], "workflow": run["workflow_id"],
                         "baselineRun": base_run["id"]})
    remediation = issue_review.interface("--read-issue", value["remediation"].rsplit("/", 1)[1],
                                         "--repository", repo, "--token-user", actor)
    if not remediation.get("issue"):
        raise AtomicWorkFailed("CI dependency remediation could not be read")
    return {**value, "failures": verified,
            "allShared": len(used) == len(integration["failing"])}


def _ci_only_blocker(ci: object, queue: dict, head: str, actor: str) -> object:
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
    blocker = {
        "action": ci.get("action"),
        "repository": ci.get("repository"),
        "pull_number": ci.get("pull_number"),
        "head_sha": ci.get("head_sha"),
        "failing": compact,
    }
    if failing != [] or ci.get("head_sha") != head:
        return blocker
    removals = queue.get("queue_removals", [])
    removal = removals[-1] if removals else None
    integration = (removal.get("beforeCommit") or {}).get("oid") if isinstance(removal, dict) else None
    if queue.get("head_sha") != head or not removal or removal.get("reason") != "failed_checks" \
            or not isinstance(removal.get("id"), str) or not removal["id"] \
            or not isinstance(integration, str) or not re.fullmatch(r"[0-9a-f]{40}", integration):
        return blocker
    packet = issue_review.interface("--list-failing-ci", str(ci["pull_number"]), "--repository", ci["repository"],
                                    "--token-user", actor, "--ref", integration)
    parents = packet.get("parents", [])
    if packet.get("repository") != ci["repository"] or packet.get("pull_number") != ci["pull_number"] \
            or packet.get("head_sha") != head or packet.get("ref") != integration \
            or len(parents) < 2 or head not in parents[1:] or not re.fullmatch(r"[0-9a-f]{40}", str(parents[0])):
        raise AtomicWorkFailed("CI blocker integration does not contain the admitted candidate and base")
    failures = []
    verified: set[tuple[int, str]] = set()
    pending = []
    for check in packet.get("failing", []):
        run = next((run for run in packet.get("runs", []) if run.get("id") == check.get("run_id")), None)
        if check.get("state") != "completed":
            pending.append((check, run))
            continue
        if check.get("type") != "check_run" or check.get("head_sha") != integration or check.get("state") != "completed" \
                or check.get("conclusion") not in {"failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"} \
                or not check.get("name") or not check.get("url") or not run or run.get("head_sha") != integration \
                or run.get("event") != "merge_group" \
                or any(type(value) is not int or value < 1 for value in
                       (check.get("check_run_id"), check.get("log_id"), run.get("id"), run.get("workflow_id"), run.get("run_attempt"))):
            return blocker  # Unknown obligations cannot authorize recovery.
        attempt = run["run_attempt"]
        rerun_finished = run.get("status") == "completed" and run.get("conclusion") == "success"
        rerun_running = isinstance(run.get("status"), str) and run.get("status") != "completed" and attempt > 1
        if rerun_finished or rerun_running:
            # The run already moved past the retained failure, so its
            # current attempt is not the failed one. Pinning it would
            # reject that existing success and demand another rerun.
            if attempt < 2:
                return blocker  # A completed success on attempt 1 contradicts the retained failure.
            attempt -= 1
        failures.append({"name": check["name"], "check": check["check_run_id"], "job": check["log_id"],
                         "run": run["id"], "workflow": run["workflow_id"], "attempt": attempt, "url": check["url"]})
        verified.add((run["workflow_id"], check["name"]))
    for check, run in pending:
        if not isinstance(check, dict) or check.get("type") != "check_run" or check.get("head_sha") != integration \
                or not isinstance(check.get("state"), str) or check.get("state") == "completed" \
                or check.get("conclusion") is not None or not check.get("name") or not check.get("url") \
                or not run or run.get("head_sha") != integration or run.get("event") != "merge_group" \
                or any(type(value) is not int or value < 1 for value in
                       (check.get("check_run_id"), check.get("log_id"), run.get("id"), run.get("workflow_id"), run.get("run_attempt"))):
            return blocker  # Unknown or malformed pending obligations cannot authorize recovery.
        if (run["workflow_id"], check["name"]) not in verified:
            return blocker  # A pending distinct obligation leaves the original failure set unknown.
        # A pending rerun of a verified failure keeps the original
        # evidence; recovery waits for its later result.
    if failures:
        blocker["queue"] = {"removal": removal["id"], "integration": integration, "base": parents[0], "failures": failures}
    return blocker


def run(model: Model, repo: str, number: int, branch: str, actor: str, work: Path,
        call_id: str, record: Callable[[dict], None], pull: int | None = None,
        expected_head: str | None = None, note: str = "", merge_base: bool = False, expected_issue_revision: str | None = None) -> dict:
    progress.stage("preparing_workspace", "Preparing the atomic workspace")
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
        raise AtomicWorkFailed("seed issue is no longer open")
    seed_revision = issue_review.revision(data["issue"])
    if expected_issue_revision and seed_revision != expected_issue_revision:
        raise AtomicWorkFailed("seed issue changed before implementation/repair")
    progress.stage("preparing_checkout", "Preparing the implementation/repair checkout")
    prepared = issue_review.interface("--issue-work", *common, "--mode", "prepare", "--path", str(checkout),
                                      *(["--merge-base"] if merge_base else []), seconds=1800)
    if prepared.get("outcome") != "prepared":
        return prepared
    test_capture = {"call": call_id, "nonce": secrets.token_hex(32), "repository": repo, "base": prepared["checkout_head"]}
    record({"phase": "prepared", "prepared": prepared, "test_capture": test_capture, "seed_revision": seed_revision})
    restored = None
    if pull is None:
        try:
            bound = resource_ownership.binding()
        except Exception:
            bound = None
        if bound is not None and bound[1] == call_id:
            try:
                result = failed_source.restore_deadline(bound[0], call_id, checkout, prepared["checkout_head"], seed_revision)
            except Exception as error:
                raise AtomicWorkFailed(f"deadline restore verification failed; no publication attempted: {error}") from error
            if result.get("status") == "restored":
                restored = result
                record({"phase": "prepared", "prepared": prepared, "seed_revision": seed_revision,
                        "deadline_restored": {"predecessor": result["predecessor"], "base": result["base"],
                                              "seed": result["seed"], "count": len(result["paths"])}})
    test_evidence = work / "test-evidence"
    test_evidence.mkdir(mode=0o700)
    evidence = {}
    required_reply_ids: set[int] = set()
    if pull is not None:
        progress.stage("preparing_review_evidence", "Reading repair CI, reviews and queue evidence")
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
        "Run the repository's required checks. If a check has a verified Poise test-relay no-result, "
        'require the final relay diagnostic for that command saying "no test result:" and "Skip local tests for this work". '
        "Exit 124/125 alone or an interrupted attempt followed by a genuine suite result does not authorize this handoff. "
        "Do not retry or run parts of the suite after that final diagnostic. If the work is otherwise complete, "
        "preserve the exact candidate checkout and unchanged HEAD, record the command, relay diagnostic/reason, "
        "incomplete local verification and required CI in body, and return complete publication metadata with blocked null "
        "so Caller can validate and publish normally. Never report the incomplete check as passed. "
        "Required CI and review remain mandatory. Genuine suite failures, provider execution-budget exhaustion "
        "and other blockers remain blockers; do not relabel them as relay no-results. "
        "Before cleanup, put the worker-reported first actionable assertion/failure excerpt, suite/test identifier, "
        "captured candidate digest and producing run ID in the existing blocked string, ahead of any later relay timeout explanation. "
        "For the Caller pytest gate, copy its bounded 'completed Caller pytest failure:' summary first in blocked. "
        "Use the relay's captured candidate digest, which includes uncommitted edits; checkout_head is only the starting HEAD. "
        "Retain the run ID of the attempt that produced the failure. If only a failed-test marker was observed, "
        "say assertion details are unavailable; say when candidate or run identity is unavailable too. "
        "A later timeout must not overwrite an observed test failure or permit the relay-only handoff. "
        "Never fabricate reviews, approvals, CI, completion, or tests. "
        "Do not start other agents or chats, schedule work, create orchestration scripts, modify Poise settings, "
        "commit, push, open a PR, submit reviews, resolve threads or merge. Caller performs publication after this invocation ends. "
        "Keep HEAD unchanged; leave real edits in this checkout. The preparation receipt names any base merge already in progress and actual conflicts to resolve; "
        "never force-push, rewrite history or weaken repository rules. "
        f"Write JSON to {output}: {{\"commitMessage\":\"Conventional Commit subject\",\"title\":\"Conventional Commit PR title\","
        "\"body\":\"Concrete change, reason and actual checks, without a Closes footer\","
        "\"replies\":[{\"commentId\":123,\"body\":\"Your concrete answer to this actual review finding, including what changed or evidence for disagreement\"}],\"blocked\":null}}. "
        "For repairs, retain the required title/body fields; they describe this repair but are not published. Existing PR metadata is preserved. "
        f"For a repair, include one substantive answer for each of these required unresolved root comment IDs: {json.dumps(sorted(required_reply_ids))}. "
        "This exact set includes outdated unresolved roots and roots that already have replies. Check each finding and its answer against the repaired code and current reviewer input. "
        "When an existing native reply still applies and that finding's reviewer input is unchanged, carry its entire body verbatim in replies, including its original <!-- poise-reply CALL_ID ROOT_ID --> marker. "
        "Do not prepend acknowledgements or restate that answer; a different Call/head or unrelated finding does not invalidate it. The publisher verifies its actual author, root, body and marker and returns the existing receipt. "
        "For a new finding, changed reviewer input or a materially changed answer, write a fresh substantive answer without a native marker. Missing or uncertain prior reply proof cannot count as verified coverage. "
        "Do not reply to replies, invent comment ids, or use generic acknowledgements. For initial implementation replies must be empty. "
        "If unable to finish, set blocked to the concrete reason; do not claim the work complete. "
        "For a pre-PR block caused solely by an observed failing main CI test run, you may also supply "
        "testDependency: {base: prepared.checkout_head, run: original producing CI run ID, baselineRun: a distinct CI run ID "
        "on that exact base, remediation: existing repository GitHub issue URL}. Caller independently reads the complete "
        "assertion artifacts and requires every original failure/cause on the exact base. Keep blocked as the concrete string. "
        "Relay assertion proof is currently held for #1619: candidate-controlled reports cannot authorize recovery. "
        "Do not use source 'relay'; worker text and historical relay output cannot substitute. "
        "Do not use the CI dependency for candidate-specific failures or other blockers. "
        'If a repair is blocked solely by failed CI on the supplied PR head or a verified merge-group-only failure, set blocked to {"cause":"ci_only","reason":"the concrete CI blocker"}. '
        "Use this ci_only receipt even when PR-head checks are green and optional baseline proof is unavailable. "
        "Use a string for every other blocker, including missing original failure evidence, a product decision or uncertain publication. "
        f"You have {int(seconds)} seconds. This invocation ends after edits/checks and that file.\n"
        f"Behavior note: {note}\nPreparation receipt:\n{json.dumps(prepared)}\nActual issue and comments:\n{json.dumps(data)}\nActual PR evidence:\n{json.dumps(evidence)}"
    )
    if restored is not None:
        instruction += (f"\nRestored {len(restored['paths'])} unvalidated file(s) from previous deadline attempt "
                        f"{restored['predecessor']} on the same base and seed: {json.dumps(sorted(restored['paths']))}. "
                        "These edits are unvalidated; validate from scratch and publish only from this attempt.\n")
    progress.stage("preparing_provider", "Preparing the atomic provider command")
    args, stdin, env = issue_review.command(model, instruction, checkout, work, seconds, UNATTENDED)
    env = dict(os.environ if env is None else env)
    env.update(POISE_TEST_BINDING=json.dumps(test_capture), POISE_TEST_EVIDENCE_DIR=str(test_evidence))
    if os.environ.get("AGENT_INTERFACE_RECEIPT_CALL") == call_id and pull is None:
        # Unlike the receipt binding, this grants only private source inspection;
        # worker tests must still not register resources against their parent.
        env["AGENT_INTERFACE_FAILED_SOURCE_CALL"] = call_id
    lease = checkout_lock.Lease(str(checkout), call_id, f"atomic behavior {repo}#{number} ({call_id[:8]})", owner_kind="caller:repair-pr" if pull else "caller:implement-issue")
    with checkout_lock.interruptible():
        progress.stage("acquiring_checkout", "Acquiring the atomic checkout lease")
        lease.acquire(checkout_lock.ACQUIRE_WAIT_SECONDS)
        try:
            record({"phase": "executing", "prepared": prepared})
            progress.stage("waiting_provider", "Waiting for atomic behavior provider", timeout=seconds)
            started = monotonic()
            try:
                done = checkout_lock.run_gated(lease, args, input=stdin, cwd=str(checkout), timeout=seconds, env=env, provider=model.provider)
            except subprocess.TimeoutExpired as error:
                if pull is None:
                    try:
                        bound = resource_ownership.binding()
                    except Exception:
                        bound = None
                    if bound is not None and bound[1] == call_id:
                        base = prepared.get("checkout_head")
                        proven = not lease.retained
                        if proven:
                            try:
                                issue_review.stop_leftovers(work)
                                proven = issue_review._cwd_pids(work, require_complete=True) == []
                            except Exception:
                                proven = False
                        if proven:
                            try:
                                scope = native_namespace.active()
                                if scope is not None:
                                    scope.require_idle()
                            except Exception:
                                proven = False
                        if proven:
                            try:
                                failed_source.capture_deadline(bound[0], call_id, checkout, base, seed_revision)
                            except Exception:
                                pass
                        else:
                            try:
                                record({"phase": "executing", "prepared": prepared,
                                        "deadline_source": {"status": "unavailable", "base": base,
                                                            "seed": seed_revision, "reason": failed_source.DEADLINE_REASON}})
                            except Exception:
                                pass
                raise review_budget.ReviewLimitError(
                    "Atomic behavior provider exhausted its execution budget; no publication attempted",
                    "atomic_work_execution_budget_exhausted",
                    diagnostic_envelope(operation="provider.atomic_work", phase="provider_execution", outcome="timed_out",
                                        executable=model.provider, elapsed_ms=round((monotonic() - started) * 1000),
                                        timeout_seconds=seconds, repository=repo, pr=pull, expected_head=expected_head,
                                        behavior="repair_pr" if pull is not None else "implement_issue",
                                        message=f"Seed issue {repo}#{number}", submission="none")) from error
            progress.stage("settling_provider_resources", "Verifying atomic provider resource release")
            record({"phase": "resources_unknown", "prepared": prepared})
            issue_review.stop_leftovers(work)
            if issue_review._cwd_pids(work, require_complete=True) != []:
                raise checkout_lock.WorkerOrphaned("atomic behavior resources could not be proven released")
            bound = resource_ownership.binding()
            if bound is not None:
                resource_ownership.process_check(*bound, complete=True)
            record({"phase": "executing", "prepared": prepared})
            progress.stage("validating_provider_result", "Checking the atomic provider result")
            terminal = issue_review._terminal_failure(model.provider, done.stdout)
            if done.returncode or terminal:
                raw = terminal or issue_review.provider_error(done.stdout, done.stderr) or f"provider exited {done.returncode}"
                # Classify the provider's own cause before credential redaction can
                # hide natural-language words such as "token was".
                if model.provider == "codex" and atoms.credential_rejected(raw):
                    error = atoms.bounded_cause(raw)
                    raise issue_review.ProviderFailure(
                        error, "authentication_failed",
                        diagnostic_envelope(operation="provider.atomic_work", phase="provider_execution",
                                            outcome="signal" if done.returncode < 0 else "exit",
                                            stderr=error, provider=model.provider,
                                            exit_code=done.returncode if done.returncode > 0 else None,
                                            signal=-done.returncode if done.returncode < 0 else None,
                                            submission="none"))
                from . import _retained_account_signal, _retained_rate_limit_signal
                # Raw provider causes can include tool output. Keep only the
                # existing fixed account/rate markers and observed process facts.
                trip = _retained_account_signal(raw) or _retained_rate_limit_signal(raw)
                disposition = f"signal {-done.returncode}" if done.returncode < 0 else f"exit {done.returncode}"
                message = (f"Atomic behavior provider {'reported a failed terminal with' if terminal else 'failed with'} {disposition}; "
                           "provider cause unavailable; no publication attempted")
                if trip:
                    message = f"{trip}: {message}"
                raise issue_review.ProviderFailure(
                    message, "atomic_work_failed",
                    diagnostic_envelope(operation="provider.atomic_work", phase="provider_execution",
                                        outcome="signal" if done.returncode < 0 else "exit",
                                        executable=model.provider, message=message,
                                        exit_code=done.returncode if done.returncode >= 0 else None,
                                        signal=-done.returncode if done.returncode < 0 else None,
                                        submission="none"))
            progress.stage("reading_publication", "Reading bounded publication metadata")
            if not output.is_file() or output.stat().st_size > 64 * 1024:
                raise AtomicWorkFailed("atomic behavior returned no bounded publication metadata")
            publication = json.loads(output.read_text())
            progress.stage("validating_publication", "Validating publication metadata and review replies")
            if not isinstance(publication, dict):
                raise AtomicWorkFailed("atomic behavior blocked: invalid output")
            if publication.get("blocked") is not None:
                blocked = publication["blocked"]
                if pull is None and publication.get("testDependency") is not None and isinstance(blocked, str) and blocked.strip():
                    dependency = publication["testDependency"]
                    if not isinstance(dependency, dict) or dependency.get("base") != prepared.get("checkout_head") \
                            or dependency.get("remediation") == f"https://github.com/{repo}/issues/{number}":
                        raise AtomicWorkBlocked(f"{blocked}; test dependency does not identify the original checkout base and external remediation")
                    try:
                        if dependency.get("source") == "relay":
                            receipts = {}
                            for key, name in (("run", "original"), ("baselineRun", "baseline")):
                                ident = dependency.get(key)
                                if not isinstance(ident, str) or not re.fullmatch(r"[a-f0-9]{32}", ident):
                                    raise ValueError("relay dependency requires original completed runner IDs")
                                path = test_evidence / f"{ident}.json"
                                if path.stat().st_size > 48 * 1024:
                                    raise ValueError("relay assertion receipt is oversized")
                                receipts[name] = json.loads(path.read_text())
                            dependency = {**dependency, "capture": test_capture, "relay": receipts}
                        verified = issue_review.interface("--chain-seed", f"#{number}", "--repository", repo, "--branch", branch,
                                                          "--token-user", actor, "--test-dependency-json", json.dumps(dependency))
                    except (RuntimeError, ValueError, OSError, subprocess.SubprocessError) as error:
                        raise AtomicWorkBlocked(f"{blocked}; authoritative test evidence is unavailable: {error}") from error
                    proof = verified.get("test_dependency")
                    if isinstance(proof, dict) and proof.get("verified") is True and proof.get("base") == prepared["checkout_head"]:
                        # The original Call retains this independently read proof
                        # even when report publication is disabled.
                        record({"phase": "executing", "prepared": prepared, "test_dependency": proof})
                if pull is not None and isinstance(blocked, dict) and set(blocked) == {"cause", "reason"} \
                        and blocked["cause"] == "ci_only" and isinstance(blocked["reason"], str) and blocked["reason"].strip():
                    try:
                        blocker = _ci_only_blocker(evidence["ci"], evidence["queue"], expected_head or "", actor)
                        record({"phase": "executing", "prepared": prepared, "ci_blocker": blocker})
                        if publication.get("ciDependency") is not None and isinstance(blocker, dict) and blocker.get("queue"):
                            dependency = _verify_ci_dependency(publication["ciDependency"], repo, pull, expected_head or "", actor, evidence["queue"])
                            if dependency["remediation"] in {f"https://github.com/{repo}/issues/{number}", f"https://github.com/{repo}/pull/{pull}"}:
                                raise AtomicWorkFailed("CI dependency cannot use its own repair as the external remediation")
                            if dependency.get("allShared") is True:
                                blocker["ci_dependency"] = {**dependency, "failures": [
                                    {key: value for key, value in failure.items() if key != "evidence"} for failure in dependency["failures"]]}
                            # A partial proof cannot grant baseline recovery; the
                            # retained queue failures still allow integration recovery.
                    except (RuntimeError, ValueError, OSError, subprocess.SubprocessError) as error:
                        raise AtomicWorkBlocked(f"{blocked['reason']}; authoritative queue CI evidence is unavailable: {error}") from error
                    record({"phase": "executing", "prepared": prepared, "ci_blocker": blocker})
                    blocked = blocked["reason"]
                raise AtomicWorkBlocked(blocked)
            dependency = None
            if publication.get("ciDependency") is not None:
                progress.stage("verifying_ci_dependency", "Verifying exact-base CI dependency evidence")
                if pull is None or not expected_head:
                    raise AtomicWorkFailed("CI dependencies require an exact repair candidate")
                dependency = _verify_ci_dependency(publication["ciDependency"], repo, pull, expected_head, actor, evidence["queue"])
                if dependency["remediation"] in {f"https://github.com/{repo}/issues/{number}", f"https://github.com/{repo}/pull/{pull}"}:
                    raise AtomicWorkFailed("CI dependency cannot use its own repair as the external remediation")
            progress.stage("validating_publication", "Validating publication metadata and review replies")
            if any(not isinstance(publication.get(key), str) or not publication[key].strip() for key in ("commitMessage", "title", "body")):
                raise AtomicWorkFailed("atomic behavior publication metadata is incomplete")
            replies = publication.get("replies", [])
            if not isinstance(replies, list) or (pull is None and replies):
                raise AtomicWorkFailed("atomic behavior returned invalid review replies")
            if pull is not None:
                answered = {reply.get("commentId") for reply in replies if isinstance(reply, dict)}
                missing = sorted(required_reply_ids - answered)
                if missing:
                    raise AtomicWorkFailed("repair did not answer every unresolved review finding: "
                                     f"missing_root_comment_ids={json.dumps(missing[:20])}; "
                                     f"missing_count={len(missing)}; required_count={len(required_reply_ids)}")
            # run_gated releases only after the complete worker group exits.
            # Publication is a separate bounded writer under the same lease.
            progress.stage("acquiring_checkout", "Reacquiring the atomic checkout lease for publication")
            lease.acquire(checkout_lock.ACQUIRE_WAIT_SECONDS)
            progress.stage("revalidating_issue", "Rechecking the seed issue before publication")
            if expected_issue_revision and issue_review.revision(issue_review._issue(repo, number, actor)) != expected_issue_revision:
                raise AtomicWorkFailed("seed issue changed during implementation/repair; no publication attempted")
            publication_args = ["--issue-work", *common, "--path", str(checkout),
                                "--starting-head", prepared["checkout_head"], "--message", publication["commitMessage"],
                                "--title", publication["title"], "--body", publication["body"], "--replies-json", json.dumps(replies)]
            progress.stage("validating_publication", "Validating the candidate through github-interface")
            validated = issue_review.interface(*publication_args, "--mode", "validate", seconds=120)
            if validated.get("outcome") == "superseded":
                return validated
            if validated.get("outcome") != "validated":
                raise AtomicWorkFailed("publication validation returned no confirmation; no publication attempted")
            if dependency is not None:
                if type(validated.get("has_changes")) is not bool:
                    raise AtomicWorkFailed("CI dependency requires a complete checkout validation")
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
            receipt = {"phase": "preparing_publication", "prepared": prepared, "publication": publication}
            record(receipt)
            progress.stage("publishing", "Publishing the verified checkout through github-interface")
            published = issue_review.interface(*publication_args, "--mode", "publish", seconds=120)
            if published.get("outcome") == "prerequisite_wait":
                if pull is not None:
                    raise AtomicWorkFailed("prerequisite wait is only available for first publication")
                wait = published.get("prerequisite_wait")
                if not isinstance(wait, dict) or wait.get("base") != str(prepared.get("checkout_head") or "").lower() \
                        or not isinstance(wait.get("reason"), str) or not wait["reason"].strip():
                    raise AtomicWorkFailed("prerequisite wait lacks its original candidate base and reason")
                record({"phase": "prerequisite_wait", "prepared": prepared, "prerequisite_wait": wait})
                return published
            record({**receipt, "phase": "published", "result": published})
            return published
        finally:
            if lease.held:
                active = sys.exception()
                try:
                    lease.release()
                except Exception as cleanup:
                    if active is not None and getattr(cleanup, "diagnostic", None) is None:
                        diagnostic = getattr(active, "diagnostic", None)
                        if diagnostic is not None:
                            cleanup.diagnostic = diagnostic
                            cleanup.args = (f"{cleanup} (original failure: {active})", *cleanup.args[1:])
                    raise
