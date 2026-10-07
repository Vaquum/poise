from __future__ import annotations

import shlex

from . import atoms

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


def allowed(pr: str, actor: str, expected_head: str) -> list[str]:
    ref = shlex.quote(atoms.pr_ref(pr))
    fixed = atoms.fixed_mutation_args(actor, expected_head)
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
) -> str:
    spec = atoms.CATALOG.review_model("pr_approve", model)
    tools = allowed(pr, actor, expected_head) if spec.provider == "claude" else []
    text = atoms.prompt(
        POLICY if spec.provider == "claude" else atoms.STRUCTURED_POLICY,
        SEVERITY,
        RULES,
        atoms.packet(pwd, pr, actor, expected_head, p),
        tools,
        note,
        p,
    )
    return atoms.run_agent(
        pwd, SYSTEM, text, tools, "pr_approve", timeout_s,
        model=spec.identity, pr=pr, actor_name=actor, head=expected_head,
    )
