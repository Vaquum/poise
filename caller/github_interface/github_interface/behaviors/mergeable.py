from typing import Any

from github_interface.atoms.pulls import get_pr_readiness_state
from github_interface.client import GitHubClient
from github_interface.context import pull_number as parse_pull_number
from github_interface.context import repository
from github_interface.identity import AGENT

IDENTITY = AGENT

# The merge states GitHub shows a green merge button for.
BUTTON_GREEN = {"clean", "unstable", "has_hooks"}
QUEUE_ADMISSIBLE = {"CLEAN", "BEHIND", "BLOCKED", "UNSTABLE", "HAS_HOOKS"}


def queue_enabled(readiness: dict[str, Any]) -> bool:
    queue = readiness.get("mergeQueue")
    if queue is None:
        return False
    if not isinstance(queue, dict) or not isinstance(queue.get("id"), str) or not queue["id"]:
        raise RuntimeError("GitHub returned malformed merge queue evidence")
    return True


def status(pull: dict[str, Any], checks_state: str | None, unresolved: int, all_threads_read: bool = True) -> str | None:
    """Current's colour for a pull request: green when its merge button is
    green, no check fails or is still running and no conversation is left
    unresolved; yellow when the button is green but one of those remains, or
    when there were more conversations than one read could check."""
    if pull.get("state") != "open" or pull.get("draft") or pull.get("mergeable") is not True:
        return None
    if pull.get("mergeable_state") not in BUTTON_GREEN:
        return None
    return "green" if checks_state in (None, "SUCCESS") and unresolved == 0 and all_threads_read else "yellow"


def readiness_status(readiness: dict[str, Any]) -> str | None:
    nodes = (readiness.get("commits") or {}).get("nodes") or []
    if not nodes or not nodes[0].get("commit"):
        return None
    commit = nodes[0]["commit"]
    if "statusCheckRollup" not in commit:
        return None
    threads = readiness["reviewThreads"]
    unresolved = sum(not thread["isResolved"] and not thread["isOutdated"] for thread in threads["nodes"])
    if queue_enabled(readiness):
        if (readiness["state"] != "OPEN" or readiness["isDraft"]
                or readiness["mergeable"] != "MERGEABLE"
                or readiness["mergeStateStatus"] not in QUEUE_ADMISSIBLE):
            return None
        return "green" if (
            readiness.get("reviewDecision") == "APPROVED"
            and (commit["statusCheckRollup"] or {}).get("state") == "SUCCESS"
            and unresolved == 0 and not threads["pageInfo"]["hasNextPage"]
        ) else "yellow"
    return status({
        "state": readiness["state"].lower(), "draft": readiness["isDraft"],
        "mergeable": readiness["mergeable"] == "MERGEABLE",
        "mergeable_state": readiness["mergeStateStatus"].lower(),
    }, (commit["statusCheckRollup"] or {}).get("state"), unresolved, not threads["pageInfo"]["hasNextPage"])


def behind_status(pull: dict[str, Any], checks_state: str | None, unresolved: int, all_threads_read: bool = True) -> str | None:
    """`behind` when the branch is mergeable but out of date with its base
    and nothing else blocks it: open, not a draft, no conflicts, an
    update-branch away from the green button, checks passed and no
    conversation left unresolved. Anything else blocking is None."""
    if pull.get("state") != "open" or pull.get("draft") or pull.get("mergeable") is not True:
        return None
    if pull.get("mergeable_state") != "behind":
        return None
    return "behind" if checks_state in (None, "SUCCESS") and unresolved == 0 and all_threads_read else None


def readiness_behind(readiness: dict[str, Any]) -> str | None:
    """`behind` when GitHub reports the pull request mergeable but out of
    date with its base and the green predicate holds on everything else."""
    if queue_enabled(readiness) or readiness.get("mergeStateStatus") != "BEHIND":
        return None
    if readiness_status({**readiness, "mergeStateStatus": "CLEAN"}) != "green":
        return None
    return "behind"


# GraphQL mergeable values mapped to the REST get_pull tri-state the response
# shape keeps: True while mergeable, False on conflict, None while GitHub is
# still computing (Poise shows that as no colour until the next refresh).
_MERGEABLE = {"MERGEABLE": True, "CONFLICTING": False, "UNKNOWN": None}


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    pull_number = parse_pull_number(payload)

    # No REST: the readiness packet already carries mergeability, so the
    # get_pull loop only re-fetched it at 1-3 core calls per refresh (#488).
    readiness = await get_pr_readiness_state(client, owner, repo, pull_number)
    try:
        github_mergeable = _MERGEABLE[readiness["mergeable"]]
    except KeyError as error:
        raise RuntimeError(f"GitHub returned unknown mergeable value: {readiness.get('mergeable')!r}") from error
    state = str(readiness.get("state") or "").lower()
    if state == "merged":
        state = "closed"
    pull = {
        "state": state,
        "draft": bool(readiness.get("isDraft")),
        "mergeable": github_mergeable,
        "mergeable_state": str(readiness.get("mergeStateStatus") or "").lower(),
    }

    green = (readiness_status(readiness) == "green" if queue_enabled(readiness) else
             pull["state"] == "open" and not pull["draft"] and pull["mergeable"] is True and pull["mergeable_state"] == "clean")
    commit = (((readiness.get("commits") or {}).get("nodes") or [{}])[0].get("commit") or {})
    checks_state = (commit.get("statusCheckRollup") or {}).get("state")
    threads = readiness["reviewThreads"]
    unresolved = sum(1 for thread in threads["nodes"] if not thread["isResolved"] and not thread["isOutdated"])
    all_threads_read = not threads["pageInfo"]["hasNextPage"]
    return {
        "action": "mergeable",
        "repository": f"{owner}/{repo}",
        "pull_number": pull_number,
        "mergeable": green,
        "github_mergeable": pull["mergeable"],
        "github_mergeable_state": pull["mergeable_state"],
        "state": pull["state"],
        "draft": pull["draft"],
        "checks_state": checks_state,
        "unresolved_conversations": unresolved,
        "status": readiness_status(readiness) if queue_enabled(readiness) else status(pull, checks_state, unresolved, all_threads_read),
    }
