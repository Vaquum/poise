# Behavior integration contract

Poise is a trigger and orchestration layer. It does not read GitHub source,
construct reviews, or mutate review threads itself.

## Diagnostic severity

Behaviors shows a compact Activity log grouped by target and cause. **Poise
faults** are red and mean the scheduler or Poise's launch/result integration needs repair.
**Needs attention** is yellow for repository access, sign-in, provider limits
and uncertain outcomes, including unusable model verdicts and exhausted review
recovery. **Automatic** is grey and folded for known capacity,
head changes, upstream 429/5xx and transport interruptions that Poise rechecks.
Unknown causes stay yellow until their cause is established; a process exit or
retry count alone never proves Poise is broken. Each row expands to its full
diagnostic details, retaining its expansion through refresh.

The last terminal provider event is selected before redaction and the
300-character display bound. Old summaries are refreshed only from an exact,
validated Caller identity, without changing failure counts or retry clocks.
A later authoritative completion removes transient warnings from the current
view; uncertain held work and the audit history remain. Severity changes no
launch, retry, ownership or publication rule.
Recovered attempts carry `recovered: true` in the diagnostic payload so their
exact audit identities can still suppress duplicate incidents. The view shows
neither as an active problem; unrelated held attempts still need attention.
Retained incidents are classified independently of active failure summaries.
A grey no-action PR incident requires one validated Caller row matching its
call, correlation, actor, repository, PR, behavior and source, with
`not_started` / `preflight_failed`, a pinned expected head, and no executed head
or review/posting receipts. Missing, conflicting or quarantined evidence stays
visible under Needs attention. Classification never authorizes a retry.
Distinct attempts are read before visual grouping, so a newer automatic event
cannot hide an older held reviewer. Persisted launch contract and quarantine
evidence overrides Caller no-action text; a matching correlation must identify
exactly one Caller row. Stronger current incident evidence also overrides a
cached automatic failure summary.

If the browser cannot read `/api/behaviors`, it reports one request diagnostic
and retains its last known snapshot. It does not infer agent-log, datastore or
identity failures from that request. Controls remain unavailable until a
successful read restores current state.
An initial unread runtime has `status: 'unknown'`. A previously observed
degraded runtime remains visible alongside the request diagnostic until a
successful read supplies new health evidence.
The API supplies `runtimeError` only for a stopped/stale scheduler or an overdue
operation. A degraded status without a known runtime cause is yellow.

An operator can POST `/api/behaviors/retry-pr-reviews` with 1-3 `callIds`
from failed automated slots on one PR/head. Poise verifies exact launch
ownership, unchanged live head, no active worker, and no unclaimed or pending
GitHub review. Only then does one transaction release those failed slots and
their retry delay, retaining Caller results and a durable retry audit record.
The normal scheduler launches the configured panel. Unknown evidence,
quarantined results, recorded actions and concurrent changes remain held.

Each behavior follows one transaction shape:

1. Gate on fresh `github-datastore` consumer state.
2. Read one immutable fact packet from `github-interface`, including head SHA
   and acting GitHub identity.
3. Persist launch intent with behavior, target, actor, source, correlation ID,
   and expected head before starting detached work.
4. Let `agent-interface` perform model work using only the permitted
   `github-interface` primitives.
5. Reconcile the durable agent outcome by exact correlation ID. Accept only
   an expected action/outcome pair on the expected head.
6. Dead-letter uncertain terminal work. Never retry an ambiguous side effect.

`review-new-issues` accepts `commented`: Caller posted every comment the
reviewer wrote, on the issue and its sub-issues, and recorded each one as it
was posted. An issue has no head, so no head is pinned or reported. A failure
is relaunched once, and only when the run recorded no comment and never began
posting. See [Review New Issues](Issue-review.md).

`review-new-prs` accepts either one atomic `requested_changes` review or the
authoritative `reviewed_clean` outcome. `approve-prs` accepts one head-pinned
approval or one atomic change request. An unresolved finding whose location became
outdated can be reaffirmed without another inline comment when the reviewer
confirms it still blocks the supplied head. A terminal review contract violation
is held on unchanged input and model instead of repeatedly launching the same
worker. A clean review becomes approval-eligible on the next scheduler scan.
Provider account blocks (`review_provider_blocked`) use the same hold, preventing
an exhausted balance or local account latch from launching identical workers.
After account recovery, a successful explicit replay on the same head, model,
and reviewer reconciles the held no-action attempt. Its GitHub review receipt
must be present in live evidence before it becomes durable approval evidence.
`resolve-unblocking` uses the upstream strong
resolution primitive, which revalidates the complete gate before every thread
mutation.

`merge-prs` is disabled unless `behavior_merge_prs_enabled` is explicitly `1`.
It uses Caller directly without a model launch: after fresh datastore eligibility,
it discovers up to 50 eligible PRs per ready account with one fresh
`--merge-candidates --requests-json JSON --token-user AGENT` GraphQL read.
The packet carries current head, author and the existing green readiness predicate;
unchanged heads are still reevaluated for completed checks and conversations.
Scoped GraphQL errors hold only their target; identity or unscoped errors hold the
whole batch visibly. Discovery sends no REST reads or writes. For a ready candidate
it holds the shared per-PR operation lock, then calls
`--merge-if-ready PR --expected-head SHA --author USER --token-user AGENT`.
Caller uses the existing green predicate with fresh head-pinned readiness and
rechecks the pull request before a SHA-pinned merge request. Unknown readiness,
pending/failed checks, unresolved live conversations, incomplete conversation
reads, drafts, foreign authors and changed heads do not merge. GitHub enforces
repository protections at mutation. Caller prefers allowed squash, merge, then
rebase. It reports `merged`, `already_merged`, `not_ready`, or `superseded`.
A confirmed `merged` receipt alone updates the per-account Last triggered event;
operation failures use existing diagnostics and retry backoff. A retry after a
lost response observes the merged state and does not mutate again. Skips and the
global enable flag are read again immediately before launching the operation.
A per-account cursor advances before each batch read and each merge attempt, so
a scan cut short by its deadline resumes beyond the blocked batch or candidate.
Ten blocked PRs in one account add 60 GraphQL queries per hour at the one-minute
cadence. Each successful merge adds three REST reads, one GraphQL query and one
REST write; transient retries may add requests. GitHub's returned query cost is
exposed in the Caller batch packet.

`rerun-grey-ci` is off unless `behavior_rerun_grey_ci_enabled` is `1`. It reads
`--grey-ci-candidates --requests-json JSON --token-user AGENT` in batches of 50
with no REST polling. Current-head workflow check suites identify only completed
cancelled/stale GitHub Actions runs. Additional GraphQL pages complete truncated
workflow inventories. The latest run per workflow/event excludes superseded
interruptions; third-party checks and intentional skips do not become reruns.

A ready candidate takes the shared PR operation lock. Immediately before launch,
Poise rereads skips, enable and acting identity, then atomically records a durable
workflow/head/event intent. Caller `--rerun-grey-ci-if-ready` rechecks the author,
head, exact run/attempt, every job and latest replacement run, then requests one
workflow rerun. Failed/timed-out/unknown or active jobs refuse recovery. The normal
path uses five REST reads and one write; paginated job lists add reads. The API
has no atomic expected-head parameter, so the PR head is rechecked immediately
before the final workflow read and write.

Only `rerun_requested` updates Last triggered with a workflow URL. `not_ready`
and `superseded` prove no write and release the exact intent. Missing/malformed
receipts preserve the intent and visible held diagnostics across restarts. There
is one automatic recovery per workflow, event and head; no running CI is cancelled.
The behavior needs no model and adds zero GitHub traffic when disabled.

New behaviors must add the required atomic fact or mutation upstream first.
They must not add GitHub authentication, GraphQL, REST, or repository-source
access to Poise.

One deliberate exception to step 4: an issue review's model work is not held
to github-interface primitives. At the operator's explicit request each
reviewer runs its provider's own CLI with full access in a fresh checkout, so
it can read the whole repository and run the tests. Its GitHub side effect is
still Caller's: the reviewer writes comments to a file, and Caller posts them
through github-interface as your agent account, only on the issue and its
sub-issues.

The installed legacy sync service runs Caller’s one-minute loop under launchd
KeepAlive, with a one-minute restart throttle. It does not depend on repeated
StartInterval launches for ordinary freshness.

Dependency recovery remains fail-closed. Exit-1 datastore health reports retain
the validated sync timestamp and age. A stale legacy index can wake only the
installed sync job matching the database and Caller binary, at most once per
minute across gates and restarts. Recovery never kills a live sync or admits
work before freshness is confirmed.

If Caller explicitly reports a missing local checkout, Poise can provision an
owned checkout through Caller's existing checkout primitive, verify its origin,
commit and clean state, and publish it atomically. Concurrent requests share
provisioning; changed or existing user checkouts are never replaced. The
checkout is provisioned as your agent account, the reviewer, which Poise names
to Caller with `--token-user`. CLI errors retain bounded, credential-redacted
terminal diagnostics. Review receipts and launch claims remain authoritative;
dependency repair never fabricates a verdict.
Provisioned checkouts (`~/.poise/review-checkouts/<head>`) are removed a day
after a review last resolved their head, checked in the background when Poise
starts and every hour after, whether or not reviews run; a later review of
that head provisions it again. User checkouts are never removed.

A closed legacy failure can recover when Caller subsequently supplies an exact
`not_started` / `preflight_failed` result. The same no-action rule applies before
and after restart. Bounded, oversized-packet and invalid-result holds retain
their existing rules; unrelated reviewers’ submitted receipts do not override
an exact proof that this particular run never submitted.

## Where the pull-request behaviors act

`review-new-prs`, `approve-prs`, `resolve-unblocking`, `merge-prs` and `rerun-grey-ci` each have a Skip
repositories list (`behavior_<behavior>_skip_repos`): `owner/repo` names, one
list per behavior shared by every ready account. Before a scan claims, reads or
launches anything, it keeps only the pull requests that pass one check: open,
not a draft, authored by your GitHub account, and outside the behavior's
skipped repositories. A skipped pull request is never claimed, dead-lettered or
counted toward a retry. The list is read again immediately before a launch or a
resolution or merge or CI rerun, so a repository skipped while a scan is under way is left alone too.

`review-new-prs` takes its anti-flood baseline (`behavior_seen`,
`__snapshot_v3__` and the pull requests recorded with it) over every open pull
request of yours, skipped repositories included: the baseline records what was
already open when the behavior began, wherever it is. Saving a skip list never
retakes the baseline or clears the ledger. Unskipping a repository therefore
makes its open pull requests eligible on the next tick exactly as new ones are:
those opened since the baseline are reviewed, and the backlog it recorded is
not. `approve-prs`, `resolve-unblocking`, `merge-prs` and `rerun-grey-ci` have no baseline; an unskipped
repository's pull requests are evaluated on the next tick like any other.

## Replays

A replay from Swarm passes the same check the scheduler applies, or it is
refused with HTTP 409 and an error naming the check that failed. Poise reads
the target fresh, behind the datastore freshness gate and from the same
datastore the scheduler reads, and decides before it prepares a model, a
checkout or a head. The scheduler and the replay call the same function for
each kind of target, so the two cannot drift apart.

- `pr_review` and `pr_approve`: the pull request is open, not a draft,
  authored by your GitHub account, and not in the Skip repositories list of
  `review-new-prs` or `approve-prs` respectively.
- `issue_review`: the repository is opted in to `review-new-issues`, the issue
  is open, and its author is a trusted author.

A repository outside every ready account is refused the same way. When the
facts cannot be read, the replay answers 502 and launches nothing.

Grey CI recovery intents are shared by repository, workflow, event and head,
independent of PR number or changes to the acting account. Intent is persisted
before launch; a restart rehydrates unconfirmed requests as visible holds even
if the workflow is now running or green. Diagnostics belong to each workflow,
so a different successful rerun cannot clear an unresolved hold. A `read_failed`
receipt proves no write occurred: its intent is released and the visible read
failure retries with backoff. Errors after the write begins remain held.
