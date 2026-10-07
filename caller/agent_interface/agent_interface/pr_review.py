from __future__ import annotations

import shlex

from . import atoms
from . import review_repository

SYSTEM = (
    "You get one pass at this review. Be thorough, report only defects you can "
    "substantiate from the diff, and treat finding nothing as a valid result."
)
POLICY = (
    "Review the supplied immutable PR packet. Gather every blocking inline finding, "
    "then finish with exactly one terminal call: request-changes once with one JSON "
    "array, or reviewed-clean once when there is no blocking finding."
)
SEVERITY = (
    "p0: breaks a common path — data loss, crash, security hole, auth bypass, etc.",
    "p1: wrong on an edge or inverse case, a swallowed error, a race, missing backoff, etc.",
    "p2: a real defect worth blocking on, with smaller blast radius, etc.",
    "p3: a real but normally non-blocking defect.",
)
RULES = (
    "Review for correctness, not style: logic, edge and inverse cases, swallowed errors, masking defaults, races, missing backoff, security holes, and tests that do not exercise what they claim.",
    "Ignore formatting, style, naming conventions, and import order.",
    "For every changed contract, find consumers of the old shape and flag diff-scoped omissions.",
    "After finding one issue, sweep the whole diff for the same bug class.",
    "Confirm every defect against the cited diff line before commenting.",
    "Do not block on unverified assumptions about dependency internals; require evidence in the supplied packet or pinned repository inspection.",
    "State the defect and impact in one sentence; do not propose or write the fix.",
    "Put one inline comment per {levels} finding into the single atomic review; for non-{levels}, do nothing.",
    "If only positive things remain, call reviewed-clean exactly once.",
    "Never publish duplicate inline comments or re-litigate resolved or outdated findings.",
    "If an existing current, unresolved thread still describes a confirmed blocking defect on this head, include its original body and exact path, current line, and side in the request-changes comments array, including in a structured JSON verdict.",
    "github-interface deduplicates existing findings; when no new inline comments remain, it submits one summary-only change-request review reaffirming the current unresolved blocker.",
    "A request-changes comments array must contain at least one finding; pass the existing blocking finding instead of an empty array.",
)


pr_number = atoms.pr_number
repo_name = atoms.repo_name


def allowed(pr: str, actor: str, expected_head: str) -> list[str]:
    ref = shlex.quote(atoms.pr_ref(pr))
    fixed = atoms.fixed_mutation_args(actor, expected_head)
    return [
        f"Bash(github-interface --request-changes {ref} --comments-json * {fixed})",
        f"Bash(github-interface --reviewed-clean {ref} {fixed})",
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
    spec = atoms.CATALOG.review_model("pr_review", model)
    tools = allowed(pr, actor, expected_head) if spec.provider == "claude" else []
    packet = atoms.packet(pwd, pr, actor, expected_head, p)
    with review_repository.prepare(pwd, pr, actor, expected_head, packet) as repository:
        if spec.provider == "claude":
            tools.append(review_repository.INSPECTION_RULE)
        policy = POLICY if spec.provider == "claude" else atoms.STRUCTURED_POLICY + " " + review_repository.REQUEST_POLICY
        text = atoms.prompt(policy, SEVERITY, RULES, packet, tools, note, p) + repository.prompt()
        return atoms.run_agent(
            pwd, SYSTEM + " " + review_repository.POLICY, text, tools, "pr_review", timeout_s,
            model=spec.identity, pr=pr, actor_name=actor, head=expected_head, repository=repository,
        )
