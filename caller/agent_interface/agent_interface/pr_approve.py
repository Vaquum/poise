from __future__ import annotations

import shlex

from . import atoms, review_continuation, review_repository
from . import review_cap as followup
from .pr_review import VERIFY_FIXES

SYSTEM = "Decide whether this PR can be approved. Use only permitted github-interface commands."
POLICY = (
    "Review the supplied immutable PR packet. Approve only if all requested changes "
    "are addressed and no new blocking issue was introduced. Otherwise call "
    "request-changes exactly once with every blocking inline finding in one JSON array. "
    "Every terminal review command includes --assessment-json with verdict (your substantive "
    "assessment, 20-4000 characters), reviewed_context (what you inspected, 20-4000 characters), "
    "and limitations (including unverified tests, 4-4000 characters). "
    "When the packet lists verification_candidates, the assessment also accepts a verified_fixes array of root comment IDs. "
    "Acknowledgements do not qualify."
)
SEVERITY = (
    "p0: breaks a common path — data loss, crash, security hole, auth bypass.",
    "p1: wrong on an edge or inverse case, a swallowed error, a race, missing backoff.",
    "p2: a real defect worth blocking on, with smaller blast radius.",
    "p3: a real but normally non-blocking defect.",
)
RULES = (
    "Review for correctness, not style.",
    "Confirm requested changes are addressed on the supplied head.",
    "Review the changed contract and every diff-scoped consumer.",
    "Confirm every defect against the cited diff line before commenting.",
    "Do not block on unverified assumptions about dependency internals; require evidence in the supplied packet.",
    "State the defect and impact in one sentence; do not write the fix.",
    "Prefix each new finding body with [p0], [p1], or [p2]; preserve original bodies when reaffirming existing threads.",
    "Put one inline comment per {levels} finding into the single atomic review; for non-{levels}, do nothing.",
    "Avoid duplicate findings. If the supplied head reintroduces a resolved defect, report the new regression and its current evidence.",
    "Reaffirm an unresolved outdated finding only after confirming it still blocks the supplied head, using its original body and path.",
    VERIFY_FIXES,
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
        f"Bash(github-interface --request-changes {ref} --comments-json * --assessment-json * {fixed})",
        f"Bash(github-interface --approve-pr {ref} --assessment-json * {fixed})",
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
    review_scope: str = "",
) -> str:
    if capped and (review_round is None or review_cap is None):
        raise ValueError("a capped approval round needs its round and cap numbers")
    spec = atoms.CATALOG.review_model("pr_approve", model)
    bounded = review_continuation.enabled() or (review_round is not None and spec.provider == "claude")
    governed = spec.provider == "claude" and not bounded
    tools = allowed(pr, actor, expected_head) if governed else []
    # A follow-up round reviews the diff since the last reviewed head, not
    # the whole PR again. The same head (or no prior review) reviews everything.
    since = atoms.last_reviewed_head(pwd, pr, actor)
    if since is not None and since == expected_head.strip().lower():
        since = None
    if review_continuation.enabled() and not review_continuation.select_automatically():
        since = None
    lost_since = None
    try:
        packet_text = atoms.packet(pwd, pr, actor, expected_head, p, since_head=since)
    except atoms.AgentPreflightError as error:
        if since is None or error.code != "review_since_head_unknown":
            raise
        # A garbage-collected head (after a force-push) must not brick the
        # round: review the full diff once, and say so in the prompt.
        lost_since = since
        packet_text = atoms.packet(pwd, pr, actor, expected_head, p, since_head=None)
    policy = POLICY if governed else atoms.STRUCTURED_POLICY
    if bounded:
        if spec.provider == "claude":
            tools = [review_repository.INSPECTION_RULE]
        policy += " " + review_repository.REQUEST_POLICY
    round_note = followup.round_policy(review_round, review_cap, capped)
    if round_note:
        policy += " " + round_note
    text = atoms.prompt(
        policy,
        SEVERITY,
        RULES,
        packet_text,
        tools,
        note,
        p,
    )
    if lost_since is not None and not review_continuation.enabled():
        text += (f"\n\nThe last reviewed head ({lost_since}) is no longer fetchable; "
                 "this round reviews the full diff instead.")
    if bounded:
        with review_repository.prepare_current(pwd, pr, actor, expected_head, packet_text, allow_unavailable=True) as (repository, current_packet):
            text = text.replace(packet_text, current_packet, 1)
            packet_text = current_packet
            return atoms.run_agent(pwd, SYSTEM + " " + review_repository.POLICY,
                text + repository.prompt(), tools, "pr_approve", timeout_s,
                model=spec.identity, pr=pr, actor_name=actor, head=expected_head, repository=repository,
                packet=packet_text, note=note, capped=capped, review_round=review_round,
                review_cap=review_cap, review_scope=review_scope)
    return atoms.run_agent(
        pwd, SYSTEM, text, tools, "pr_approve", timeout_s,
        model=spec.identity, pr=pr, actor_name=actor, head=expected_head,
        packet=packet_text, note=note, capped=capped, review_round=review_round, review_cap=review_cap, review_scope=review_scope,
    )
