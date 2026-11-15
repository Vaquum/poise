import json
import os
from typing import Any

import httpx

from github_interface import pr_ci_recovery
from github_interface.atoms.process_diagnostic import STDERR_BYTES, redact
from github_interface.atoms.pulls import get_pr_readiness_state, get_pull
from github_interface.behaviors import list_failing_ci
from github_interface.behaviors.mergeable import behind_status, readiness_behind
from github_interface.client import GitHubClient
from github_interface.context import expected_head
from github_interface.context import pull_number as parse_pull_number
from github_interface.context import repository

REQUIRE_TOKEN_USER = True


class BranchUpdateError(RuntimeError):
    def __init__(self, error: Exception, phase: str, token: str | None = None):
        env = dict(os.environ)
        if isinstance(token, str):
            env["GITHUB_INTERFACE_TOKEN"] = token
        cause = redact(f"{phase}: {type(error).__module__}.{type(error).__name__}: {error}", env).encode("utf-8")
        message = cause[:STDERR_BYTES].decode("utf-8", errors="replace")
        self.diagnostic = {
            "version": 1, "source": "caller", "severity": "error", "operation": "update_branch_if_behind",
            "phase": phase, "outcome": "unknown" if phase == "update_branch" else "failed",
            "submission": "uncertain" if phase == "update_branch" else "none",
            "message": message, "stderr": message, "stderr_truncated": len(cause) > STDERR_BYTES,
        }
        super().__init__(message)


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    number = parse_pull_number(payload)
    head = expected_head(payload)
    author = str(payload.get("author") or "").strip()
    if not author:
        raise ValueError("author is required")
    result = {
        "action": "update_branch_if_behind", "repository": f"{owner}/{repo}",
        "pull_number": number, "head_sha": head, "outcome": "not_ready",
    }
    proof_json = payload.get("shared_ci_recovery_json")
    proof = json.loads(proof_json) if proof_json is not None else None
    if proof_json is not None:
        if not isinstance(proof, dict) or proof.get("head") != head or not pr_ci_recovery.SHA.fullmatch(str(proof.get("base"))):
            raise ValueError("shared CI recovery must pin the original head and recovered base")
        result["base_sha"] = proof["base"]

    phase = "read_pull"
    try:
        pull = await get_pull(client, owner, repo, number)
        if (pull.get("head") or {}).get("sha") != head:
            return {**result, "outcome": "superseded"}
        if pull.get("merged") is True:
            return result
        if str((pull.get("user") or {}).get("login") or "").lower() != author.lower():
            return result
        if proof:
            if not _refresh_target(pull, proof):
                return result
            phase = "verify_shared_ci_recovery"
            checks = await list_failing_ci.run(client, payload)
            if checks["head_sha"] != head or checks["base_sha"] != proof["base"]:
                return result
            if await pr_ci_recovery.inspect(client, f"{owner}/{repo}", pull, checks["failing"], checks["failing"]) != proof:
                return result
        elif behind_status(pull, None, 0) != "behind":
            return result

        # The uncached packet pins checks and conversations to the same head.
        phase = "read_readiness"
        readiness = (await get_pr_readiness_state(client, owner, repo, number, include_auto_merge=True)
                     if proof else await get_pr_readiness_state(client, owner, repo, number))
        if readiness["headRefOid"] != head:
            return {**result, "outcome": "superseded"}
        if proof:
            commit = (((readiness.get("commits") or {}).get("nodes") or [{}])[0].get("commit") or {})
            checks_state = (commit.get("statusCheckRollup") or {}).get("state")
            if readiness.get("state") != "OPEN" or readiness.get("isDraft") is not False \
                    or readiness.get("mergeable") != "MERGEABLE" or checks_state != "FAILURE" or "mergeQueueEntry" not in readiness \
                    or readiness["mergeQueueEntry"] is not None or "autoMergeRequest" not in readiness \
                    or readiness["autoMergeRequest"] is not None:
                return result
        elif readiness_behind(readiness) != "behind":
            return result

        phase = "recheck_pull"
        pull = await get_pull(client, owner, repo, number)
        if (pull.get("head") or {}).get("sha") != head:
            return {**result, "outcome": "superseded"}
        if str((pull.get("user") or {}).get("login") or "").lower() != author.lower() \
                or not (_refresh_target(pull, proof) if proof else behind_status(pull, None, 0) == "behind"):
            return result
        phase = "update_branch"
        updated = await client.request(
            "PUT", f"/repos/{owner}/{repo}/pulls/{number}/update-branch",
            json={"expected_head_sha": head},
        )
        if not isinstance(updated, dict) or not updated.get("url"):
            raise RuntimeError(f"GitHub did not update the branch for pull request #{number}: {updated!r}")
        return {**result, "outcome": "updated"}
    except (RuntimeError, ValueError, httpx.HTTPError) as error:
        # Only a terminal failure before this boundary proves no PUT was reached.
        raise BranchUpdateError(error, phase, client.token) from error


def _refresh_target(pull: dict, proof: dict) -> bool:
    return (pull.get("base") or {}).get("sha") == proof["base"] and pull.get("state") == "open" \
        and (pull.get("base") or {}).get("ref") == "main" \
        and pull.get("draft") is False and pull.get("merged") is False and pull.get("mergeable") is True
