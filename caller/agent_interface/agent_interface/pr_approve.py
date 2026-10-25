from __future__ import annotations

import shlex

from . import atoms
from . import review_cap as followup

SYSTEM = "Decide whether this PR can be approved. Use only permitted github-interface commands."
POLICY = (
    "Review the supplied immutable PR packet. Approve only if all requested changes "
    "are addressed and no new blocking issue was introduced. Otherwise call "
    "request-changes exactly once with every blocking inline finding in one JSON array."
)
SEVERITY = (
    "p0: breaks a common path — data loss, crash, security hole, auth bypass.",
    "p1: wrong on an edge or inverse case, a swallowed error, a race, missing backoff.",
    "p2: a real defect worth blocking on, with smaller blast radius.",
)
RULES = (
    "Review for correctness, not style.",
    "Confirm requested changes are addressed on the supplied head.",
    "Review the changed contract and every diff-scoped consumer.",
    "Confirm every defect against the cited diff line before commenting.",
    "Do not block on unverified assumptions about dependency internals; require evidence in the supplied packet.",
    "State the defect and impact in one sentence; do not write the fix.",
    "Put one inline comment per {levels} finding into the single atomic review; for non-{levels}, do nothing.",
    "Never publish duplicate inline comments or re-litigate resolved findings. An outdated location does not prove a defect is fixed; reaffirm an unresolved outdated finding only after confirming it still blocks the supplied head, using its original body and path.",
    "If an existing current, unresolved thread still describes a confirmed blocking defect on this head, include its original body and exact path, current line, and side in the request-changes comments array, including in a structured JSON verdict.",
    "github-interface deduplicates existing findings; when no new inline comments remain, it submits one summary-only change-request review reaffirming the current unresolved blocker.",
    "A request-changes comments array must contain at least one finding; pass the existing blocking finding instead of an empty array.",
    "Finish with exactly one atomic review: one change request with all blocking findings, or one approval.",
)


pr_number = atoms.pr_number
repo_name = atoms.repo_name


def capped_policy(review_round: int, review_cap: int) -> str:
    return (
        f"This is review round {review_round} of a {review_cap}-round cap: the final round. "
        "Review the supplied immutable PR packet as usual. Do NOT request changes: file "
        "every blocking finding as ONE follow-up issue, then approve exactly once."
    )


def capped_rules(
    repo: str,
    pr: str,
    head: str,
    review_round: int,
    review_cap: int,
    actor: str,
) -> tuple[str, ...]:
    number = atoms.pr_number(pr)
    ref = shlex.quote(atoms.pr_ref(pr))
    issue_command = (
        f"github-interface --create-pr-linked-issue {ref} --title "
        f"{shlex.quote(followup.render_title(repo, number, review_round))} "
        f"--body <body> --token-user {atoms.actor(actor)}"
    )
    return (
        "Review for correctness, not style.",
        "Confirm requested changes are addressed on the supplied head.",
        "Review the changed contract and every diff-scoped consumer.",
        "Confirm every defect against the cited diff line before commenting.",
        "Do not block on unverified assumptions about dependency internals; require evidence in the supplied packet.",
        "State the defect and impact in one sentence; do not write the fix.",
        "Put one inline comment per {levels} finding into the follow-up issue; for non-{levels}, do nothing.",
        "Never publish duplicate findings or re-litigate resolved findings.",
        f"First check the packet's linked_issues for an issue whose body contains "
        f"`{followup.marker(number, head)}`. If one exists, reuse it: file nothing.",
        "If blocking findings remain and no such issue exists, file ONE follow-up issue with "
        f"exactly this command shape: `{issue_command}`. The body starts with the marker line "
        f"`{followup.marker(number, head)}`, then one section per finding with its severity, "
        "path, line, side, a permalink pinned to the supplied head for new-side findings or "
        "to the packet's pull.base.sha for removed-side findings, and the defect-and-impact "
        "sentence. The issue links back to the pull request itself.",
        "File the issue BEFORE approving. If no blocking finding remains, approve without filing an issue.",
        "If filing the issue fails, submit NOTHING and report the error: never approve a round whose findings were lost.",
        "Finish with exactly one atomic approval. Never request changes on a capped round.",
    )


def allowed(pr: str, actor: str, expected_head: str, capped: bool = False) -> list[str]:
    ref = shlex.quote(atoms.pr_ref(pr))
    fixed = atoms.fixed_mutation_args(actor, expected_head)
    if capped:
        # A capped round cannot request changes: its findings become one
        # follow-up issue, filed before the approval.
        token = f"--token-user {atoms.actor(actor)}"
        return [
            f"Bash(github-interface --create-pr-linked-issue {ref} --title * --body * {token})",
            f"Bash(github-interface --approve-pr {ref} {fixed})",
        ]
    return [
        f"Bash(github-interface --request-changes {ref} --comments-json * {fixed})",
        f"Bash(github-interface --approve-pr {ref} {fixed})",
    ]


def run(
    pwd: str,
    pr: str,
    actor: str,
    expected_head: str,
    note: str = "",
    timeout_s: int = 3600,
    p: str | None = None,
    model: str | None = None,
    capped: bool = False,
    review_round: int | None = None,
    review_cap: int | None = None,
) -> str:
    if capped and (review_round is None or review_cap is None):
        raise ValueError("a capped approval round needs its round and cap numbers")
    spec = atoms.CATALOG.review_model("pr_approve", model)
    tools = allowed(pr, actor, expected_head, capped) if spec.provider == "claude" else []
    packet_text = atoms.packet(pwd, pr, actor, expected_head, p)
    if capped and spec.provider == "claude":
        policy: str = capped_policy(review_round or 0, review_cap or 0)
        rules = capped_rules(repo_name(pr, pwd), pr, expected_head, review_round or 0, review_cap or 0, actor)
    else:
        # Structured providers review as usual; the harness files the
        # follow-up issue and converts a change request into an approval.
        policy = POLICY if spec.provider == "claude" else atoms.STRUCTURED_POLICY
        rules = RULES
    text = atoms.prompt(
        policy,
        SEVERITY,
        rules,
        packet_text,
        tools,
        note,
        p,
    )
    return atoms.run_agent(
        pwd, SYSTEM, text, tools, "pr_approve", timeout_s,
        model=spec.identity, pr=pr, actor_name=actor, head=expected_head,
        packet=packet_text, capped=capped, review_round=review_round, review_cap=review_cap,
    )
