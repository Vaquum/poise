"""One implementation or repair invocation, with no persistent model session."""
import json
from pathlib import Path
from typing import Callable

from . import checkout_lock, issue_review, progress, review_budget
from .model_catalog import Model

UNATTENDED = "You are one atomic implementation/repair behavior. Work unattended; report a blocker instead of inventing a human answer. Caller owns publication."


def run(model: Model, repo: str, number: int, branch: str, actor: str, work: Path,
        call_id: str, record: Callable[[dict], None], pull: int | None = None,
        expected_head: str | None = None, note: str = "", merge_base: bool = False, expected_issue_revision: str | None = None) -> dict:
    work.mkdir(parents=True)
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
    if pull is not None:
        evidence["ci"] = issue_review.interface("--list-failing-ci", str(pull), "--repository", repo, "--token-user", actor)
        evidence["review_packet"] = issue_review.interface("--pr-review", str(pull), "--expected-head", expected_head or "",
                                                          "--token-user", actor, cwd=checkout)
        evidence["queue"] = issue_review.interface("--pull-action-state", str(pull), "--repository", repo,
                                                   "--token-user", actor, "--queue-evidence")
    seconds = review_budget.timeout(issue_review.TIMEOUT_SECONDS, reserve=issue_review.POST_RESERVE_SECONDS)
    instruction = (
        f"Read AGENTS.md and its routed repository instructions first. You are the {'PR repair' if pull else 'issue implementation'} behavior "
        f"for {repo}#{number}. Read the issue and ALL its review comments below before changing code. "
        "Implement the actual requested behavior with minimal changes and meaningful regression coverage. "
        "For a repair, address every actionable review/CI/conflict blocker in the evidence; inspect actual CI logs through github-interface. "
        "Run the repository's required checks. Never fabricate reviews, approvals, CI, completion, or tests. "
        "Do not start other agents or chats, schedule work, create orchestration scripts, modify Poise settings, "
        "commit, push, open a PR, submit reviews, resolve threads or merge. Caller performs publication after this invocation ends. "
        "Keep HEAD unchanged; leave real edits in this checkout. The preparation receipt names any base merge already in progress and actual conflicts to resolve; "
        "never force-push, rewrite history or weaken repository rules. "
        f"Write JSON to {output}: {{\"commitMessage\":\"Conventional Commit subject\",\"title\":\"Conventional Commit PR title\","
        "\"body\":\"Concrete change, reason and actual checks, without a Closes footer\","
        "\"replies\":[{\"commentId\":123,\"body\":\"Your concrete answer to this actual review finding, including what changed or evidence for disagreement\"}],\"blocked\":null}}. "
        "For a repair, include one substantive answer for every original actionable inline review comment, using its actual numeric id. "
        "Do not reply to replies, invent comment ids, or use generic acknowledgements. For initial implementation replies must be empty. "
        "If unable to finish, set blocked to the concrete reason; do not claim the work complete. "
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
            done = checkout_lock.run_gated(lease, args, input=stdin, cwd=str(checkout), timeout=seconds, env=env, provider=model.provider)
            record({"phase": "resources_unknown", "prepared": prepared})
            issue_review.stop_leftovers(work)
            if issue_review._cwd_pids(work, require_complete=True) != []:
                raise checkout_lock.WorkerOrphaned("atomic behavior resources could not be proven released")
            record({"phase": "executing", "prepared": prepared})
            terminal = issue_review._terminal_failure(model.provider, done.stdout)
            if done.returncode or terminal:
                raise RuntimeError(terminal or issue_review.provider_error(done.stdout, done.stderr) or f"provider exited {done.returncode}")
            if not output.is_file() or output.stat().st_size > 64 * 1024:
                raise ValueError("atomic behavior returned no bounded publication metadata")
            publication = json.loads(output.read_text())
            if not isinstance(publication, dict) or publication.get("blocked"):
                raise ValueError(f"atomic behavior blocked: {publication.get('blocked') if isinstance(publication, dict) else 'invalid output'}")
            if any(not isinstance(publication.get(key), str) or not publication[key].strip() for key in ("commitMessage", "title", "body")):
                raise ValueError("atomic behavior publication metadata is incomplete")
            replies = publication.get("replies", [])
            if not isinstance(replies, list) or (pull is None and replies):
                raise ValueError("atomic behavior returned invalid review replies")
            if pull is not None:
                required = {thread["root_comment_id"] for thread in evidence["review_packet"]["review_threads"] if not thread["is_resolved"]}
                answered = {reply.get("commentId") for reply in replies if isinstance(reply, dict)}
                if not required.issubset(answered):
                    raise ValueError("repair did not answer every unresolved review finding")
            # run_gated releases only after the complete worker group exits.
            # Publication is a separate bounded writer under the same lease.
            lease.acquire(checkout_lock.ACQUIRE_WAIT_SECONDS)
            if expected_issue_revision and issue_review.revision(issue_review._issue(repo, number, actor)) != expected_issue_revision:
                raise ValueError("seed issue changed during implementation/repair; no publication attempted")
            receipt = {"phase": "publishing", "prepared": prepared, "publication": publication}
            record(receipt)
            progress.stage("publishing", "Publishing the verified checkout through github-interface")
            published = issue_review.interface("--issue-work", *common, "--mode", "publish", "--path", str(checkout),
                                               "--starting-head", prepared["checkout_head"], "--message", publication["commitMessage"],
                                               "--title", publication["title"], "--body", publication["body"], "--replies-json", json.dumps(replies), seconds=120)
            record({**receipt, "phase": "published", "result": published})
            return published
        finally:
            if lease.held:
                lease.release()
