# Downstream reuse of Poise's PR lifecycle

Status: scope decision recorded 31 October 2026 for autonomio/poise#762,
verified against main `8c230fc74ec13eab06b633c7a89cc234589f89a4`.
Documentation only; no runtime behavior changes in this record.
The canonical chain semantics live in [Behavior-chain.md](Behavior-chain.md);
this page decides the downstream boundary and points at the exact
existing surfaces.

## Question

A downstream application (Resolvent maintenance is the concrete producer)
creates its own private PRs under its own governance and asks to reuse
Poise's review → repair → fresh review/CI → merge lifecycle for those
already-created PRs: authorize one selected repository/PR, then let Poise
own the sequence with the canonical journal, native receipts,
deduplication and human hold/resume controls.

## Decision

There is no supported interface at this revision that enrolls an
already-created PR into the canonical behavior-chain lifecycle.
Enrollment belongs in Poise as future work and is deferred until both
hold:

1. v2 chain execution is proven in production. It remains disabled by
   default (`DEFAULT_BEHAVIOR_CHAIN_SETTINGS` in `server/settings.ts`).
2. The seven contracts below are settled. They are the acceptance
   checklist for the follow-up work, not authorization to bypass them.

This changes no production default, migrates no active work, creates no
seed issue and adds no authentication surface. Follow-up execution is not
filed by this record; the contract checklist is the filing source.

PR #737 has merged ("feat: add behavior cutover and v2 controls") since
the request was written; its scope is cutover and v2 controls
(`switch-to-v2`/`cancel-cutover` in `server/behavior-chain-api.ts`), not
downstream PR admission.

## What exists today for already-created PRs

Each route below is verified at the recorded revision, with its limit.

### Standalone PR behaviors (configured-pair authors only)

Standalone PR scans cover exactly the five `SkippableBehavior` members
(`server/behaviors.ts`):

| Standalone behavior | Chain phase |
| --- | --- |
| `review-new-prs` | `review-pr` |
| `approve-prs` | `approve-pr` |
| `resolve-unblocking` | `resolve-threads` |
| `merge-prs` | `merge-pr` |
| `rerun-grey-ci` | `rerun-grey-ci` |

(`review-new-issues` covers seed issues, not PRs. The chain-to-behavior
key map in `server/behaviors.ts` is partial: the `publish-issue` phase
has no mapping.)

Admission is per behavior and per scan: open PRs are filtered to the
configured account pair (`ownPullRequestRefusal` in
`server/behaviors.ts`), then to eligible PRs outside skipped repositories
and outside chain ownership (`listEligiblePrs`: `chainOwnsPr` plus
`pullRequestRefusal`), and rechecked immediately before launch
(`stillEligible`). Chain-owned PRs cannot acquire a second behavior owner
(`chainOwnsPr` reads `behaviorChainOwner` in
`server/behavior-chain-journal.ts`).

`implement-issues` and `repair-prs` are chain-only, not standalone
routes: the runtime treats them as runnable only within an enabled chain
(`server/behaviors.ts`), and metrics attribute them to source
`poise:behavior-chain` (`server/behavior-metrics.ts`). There is no
standalone implement or repair for an already-created PR outside the
journal; that gap is part of why enrollment is future work.

Limit: a PR authored outside the configured pair (for example a
workflow-authored maintenance PR) is refused as "outside your configured
GitHub account pair", and there is no per-PR enrollment override.
Standalone admission is per behavior; there is no cross-behavior chain
record, journal hold/resume, or single execution owner outside the
journal.

### Explicit one-shot review of any PR

`POST /api/pr-review` with `{ url }` (`server/cache-plugin.ts`) runs
`triggerPrReview` (`server/agent.ts`), which resolves the PR author and
reviews as the agent account even for third-party authors
(`prReviewer(author, true)` in `server/pr-accounts.ts`, source
`poise:manual-review`).

Limit: one review run with Swarm visibility; not lifecycle ownership,
repair, approval sequencing or merge.

### Chat Auto-merge (persistent chat owner)

An Auto-merge chat takes responsibility for existing PRs across
repositories (`server/chat/auto-merge.ts`). Limit: the owner is that
persistent chat, not the canonical behavior journal; no chain receipts,
journal deduplication or hold/resume controls attach.

### Chain API (existing chains only)

`GET /api/behavior-chains` observes; `POST` accepts the current sequence
with `hold`/`resume` for an admitted chain, or cutover operations
(`server/behavior-chain-api.ts`). Intake admits issue seeds only and
creates `poise/issue-…` branches (`server/behavior-chain-runtime.ts`).
There is no admission operation for an existing PR.

### Caller primitives (direct use, caller sequences nothing)

- `agent-interface --pr-review` / `--pr-approve` / `--atomic-work`
  (CLI dispatch in `caller/agent_interface/agent_interface/__init__.py`).
- `github-interface --merge-if-ready` / `--update-branch-if-behind` /
  `--rerun-grey-ci-if-ready` (`caller/README.md`).

Limit: sequencing, repair publication, ownership and reconciliation stay
with the invoker. The merge predicate treats a missing check rollup as
green on a non-queue branch (`status` in
`caller/github_interface/github_interface/behaviors/mergeable.py`), with
a regression test pinning that behavior
(`test_no_checks_is_ready_like_the_green_status` in
`caller/github_interface/tests/test_merge_if_ready.py`); the chain's
separate `pr_readiness` gate instead records `checks_missing`
(`caller/github_interface/github_interface/behaviors/pr_readiness.py`).
"Review, then `--merge-if-ready`" is not equivalent to the chain's merge.

## Contracts the follow-up must settle

Derived from the #762 discussion; each names the exact current source
that forces the contract.

1. **PR as authoritative target.** `BehaviorChain` and `chain.admitted`
   require an issue and a `poise/` branch
   (`server/behavior-chain-store.ts`); the decision function runs issue
   reviews before any PR phase (`decideBehaviorChain` in
   `server/behavior-chain-decision.ts`); atomic repair requires an open
   seed issue (`run` in
   `caller/agent_interface/agent_interface/atomic_work.py`); issue-work
   explicitly rejects a PR as seed, requires a `poise/` branch, the
   acting publisher as PR author, the chain marker and a same-repository
   head, merges the default branch (not the PR base) for base
   integration, creates PRs against the default base, and enforces
   Conventional Commits with seed-only closing references
   (`caller/github_interface/github_interface/behaviors/issue_work.py`).
   Specify an immutable PR target, its task/governance source, PR-review
   start, preserved PR/branch/base/body, downstream contribution policy,
   and fork/non-default-base bounds. No fabricated receipts.

2. **Scoped enrollment authority.** `prReviewer`
   (`server/pr-accounts.ts`) rejects third-party authors for automation;
   the native adapter fixes author/reviewer to the configured pair
   (`nativeChainOperations` in `server/behavior-chain-native.ts`).
   Record repository/PR, original author, authorized writer and
   independent reviewer per enrollment; carry it through repair,
   approval, CI recovery, resolution, merge and restart. A bot login,
   body marker, label or membership alone must not grant enrollment;
   each PR needs its own authorization.

3. **Atomic ownership.** The journal's admission guard checks a Chat
   binding for an issue URL only (`BehaviorChainJournal.append` in
   `server/behavior-chain-store.ts`); PR ownership is inferred from a
   later publication number or the reserved branch (`behaviorChainOwner`
   in `server/behavior-chain-journal.ts`). Admission must refuse
   incompatible active ownership (Chat bindings, prepared reviews,
   replay reservations, merge/rerun operations) and reserve the exact PR
   before any model or GitHub write, visible to scheduler and Chat
   admissions immediately. Retries, restarts and lost responses must
   return the same owner or a conflict; hold and uncertainty retain
   ownership. Answer concurrent-version journals explicitly.

4. **Semantic worker boundary.** Native repair runs Caller's fixed
   task/output/publication contract (`run` in `atomic_work.py`: no other
   agents, no independent publication); repository instructions guide it
   but define no callback protocol. Settlement requires
   source/actor/repository/behavior match plus worker-resource settlement
   (`reconcile` in `server/behavior-chain-runtime.ts`). Either scope the
   first capability to Caller-owned repair under repository instructions,
   or define the smallest supervised invocation boundary with Poise
   owning admission, cancellation, publication intent, exact-head
   evidence and reconciliation.

5. **Managed receipts.** Managed binding, action-plan persistence, repair
   continuation and no-write marking apply only to
   `source == "poise:behavior-chain"`
   (`caller/agent_interface/agent_interface/__init__.py`); repair
   continuation rebuilds `--issue-work` from the immutable plan's
   `issue_number`. Keep lifecycle execution under the canonical managed
   identity with downstream provenance recorded separately;
   distinguish unattempted work from lost/partial writes; never let
   resume convert missing receipts into repeated writes. Legacy capped
   approval (file findings as an issue, then approve:
   `caller/agent_interface/agent_interface/pr_approve.py`) does not
   satisfy chain review.

6. **Native readiness.** Keep current-head approval, exact-head CI
   evidence, complete conversation reads and live merge protections in
   the enrollment path (see the merge/readiness split above). Define the
   disposition when no expected CI starts; prove queue and direct-merge
   paths without treating absent checks as fresh CI.

7. **Versioning and boundary.** `package.json` is private: no public
   library. A service release switch preserves a running invocation's
   files and adopts turns, but pins no chain version
   ([Service-architecture.md](Service-architecture.md),
   Releases/Switching; chains carry no version field in
   `server/behavior-chain-store.ts`). Whole-job pinning (executor,
   Caller, durable state together) stays a downstream deployment
   responsibility. The recommended boundary is the existing
   workspace-local CLI/service surfaces above at pinned main revisions;
   no new remote access.

## Downstream guidance (Resolvent maintenance lane)

The producer pins stated in #762 exist at Resolvent
`a3db7f9663387c0dc8ba38ffe2cb0eeb8390b028`
(`.github/workflows/maintenance.yml`, `docs/AGENT_JOBS.md` verified
present at that ref): ordinary `resolvent/maintenance/M-*` branches with
workflow-authored PRs under the repository's agent contract.

Until enrollment lands: keep execution disabled, pin full main
revisions, and use the one-shot review and Caller primitives above where
their authorship gates permit. Do not manufacture a seed issue to force
admission: intake would build a `poise/issue-…` branch for the wrong
owner, and issue-work rejects PR seeds and non-chain branches at
prepare/publish time.
