# Poise review clearance at GitHub

`Poise review clearance` is the single review-evidence check for
`autonomio/poise`, targeting `main`. The installed Poise service publishes it
through a dedicated GitHub App using `github-interface --review-clearance`.
It does not run a candidate's code or workflow and does not launch a review.
The existing behavior tick refreshes it independently of behavior enablement,
holds, and native workers still running. Release drains retain their existing
background-work barrier.

For a chain-owned PR, every configured review slot needs its original retained
response and matching live GitHub submission for the PR's current head and
context (base commit, title and body). Pending reviews, missing evidence and
native change requests block. A native change request can clear through the
existing same-head repair followed by retained independent approval verification;
another GitHub approval alone cannot clear it. Review readiness does not depend
on aggregate CI readiness, which includes this check.

The publisher reads all open PR heads and the live merge queue. Each queue
entry's `headCommit` is the integration commit on which GitHub requests checks
(`merge_group.head_sha`). Its represented queue prefix is checked against the
integration's ancestry. Reviews are evaluated against each PR's original head
and context, including mixed managed and independent groups. All open PRs
sharing a represented head participate in the same result: a later independent
PR cannot clear a blocked managed PR on that commit.

Only positive independent classification passes without a receipt: the live PR
author must be outside both configured native accounts, the branch outside the
reserved `poise/` namespace, and the canonical ownership lookup must succeed
without claiming it. Unclassified work, including work under a shared native
account without a canonical chain receipt, stays blocked for an ownership
decision. Unknown or unavailable state never becomes `neutral` or `skipped`.

Every refresh reads live heads, contexts, reviews, queue membership, ownership
and retained evidence. Identical evidence reuses its existing result, so healthy
queued candidates stay green. Changed evidence starts new in-progress check
runs, then a second complete read must agree before they can succeed.
Unavailable evidence revokes retained checks, including after restart. Each evaluation retains its own check IDs; a late
completion cannot update a newer evaluation. Cross-process publication uses the
existing process lock. Observation follows the existing behavior tick, so a
GitHub edit or review becomes visible at its next successful refresh; publication
and GitHub API failures are reported in Behaviors runtime health.

The CI reader excludes this context from build/test repair triggers while
retaining it in raw check evidence and GitHub's required checks. A queue removal
returns to the ordinary review/repair path only when its complete integration
rollup proves clearance was the sole unsuccessful check. Other failures and
incomplete rollups retain queue diagnosis. Caller, Verify, approval, conversation
and merge-queue requirements remain in force.

## Activation and audit

Repository code cannot activate a GitHub ruleset or grant an App installation.
Deployment and repository administrators perform this rollout separately; a
merged implementation alone is not evidence that the boundary is enforced.

1. Install a dedicated GitHub App on `autonomio/poise` with Checks **write**,
   Contents **read**, and Pull requests **read**. Keep its private key and the
   trusted installed publisher outside implementation/review checkouts. Do not
   give the key to a candidate workflow or run this publisher from a candidate.
2. In the authoritative Poise owner's secured server environment (or its
   existing mode-0600 `.env` under `POISE_ENV_ROOT`), configure all three:
   `POISE_REVIEW_APP_ID`, `POISE_REVIEW_INSTALLATION_ID`, and
   `POISE_REVIEW_PRIVATE_KEY_FILE` (an absolute PEM path). The publisher uses
   the runtime's OpenSSL to sign a short-lived App JWT and requests an
   installation token restricted to this repository. Partial configuration
   fails visibly; no configuration leaves other installations unchanged.
3. Add `Poise review clearance` to `main`'s existing required status checks,
   with **Expected source** set to that App's numeric ID (`integration_id`).
   Preserve Caller (Python 3.13), Verify (Node 22), the required approval,
   resolved conversations and the native merge queue. The publisher refuses
   success unless GitHub's effective branch rules contain this exact
   context/publisher binding. It never writes rulesets.
4. Retain a dated rollout receipt in this repository: deployed release SHA,
   App/installation IDs (no credentials), effective rule IDs and context/App
   binding, plus PR-head and integration check URLs. Verify queue refusal with
   pending review and with a same-head native change request despite a separate
   approval. Verify a qualifying retained review admits the queue without a
   replacement review, and a queued context/verdict change revokes the PR and
   integration checks. Record the actual terminal queue disposition separately.

Read-only operator probes are `github-interface --review-clearance --mode
snapshot` for live membership and `github-interface --list-failing-ci PR --ref
SHA --token-user USER --repository autonomio/poise` for raw check evidence.
`begin` and `complete` are publisher mutations, not diagnostic probes.

Automated coverage lives in `tests/review-clearance.test.ts` (essential) and
`caller/github_interface/tests/test_review_clearance.py`. These execute the
real clearance predicate, publication ordering, queue snapshot and native
GitHub enqueue behavior with isolated GitHub responses. They do not establish
live ruleset activation, a live merge, CI completion, or review approval.
