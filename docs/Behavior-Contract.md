# Behavior integration contract

Poise is a trigger and orchestration layer. It does not read GitHub source,
construct reviews, or mutate review threads itself.

## Diagnostic severity

Behaviors' diagnostics are listed in the notification rail
([Notifications](Notifications.md)), grouped by target and cause.
- **Poise faults** are red and mean the scheduler or Poise's launch/result
  integration needs repair.
- **Needs you** is amber for repository access, sign-in, provider limits and
  uncertain outcomes, including unusable model verdicts and exhausted review
  recovery.
- **Handled automatically** is grey and folded. It covers known capacity, head
  changes, upstream 429/5xx and transport interruptions that Poise rechecks.

A failed behavior's notice and its diagnostic are one entry, in the group the
diagnostic decides.
Unknown causes stay yellow until their cause is established; a process exit or
retry count alone never proves Poise is broken. Each row expands to its full
diagnostic details, retaining its expansion through refresh.

The last terminal provider event is selected first; otherwise the message
inside a JSON error — with a rate-limit error's resource, remaining and reset
facts — else the last cause-bearing stderr line. Brace-only, link-only and
empty tails leave the outer error alone, so unrecognized causes stay honest.
Selection happens before canonical redaction and the 300-character display
bound. A 403 with explicit quota-exhaustion evidence classifies as a rate
limit; other 403s still mean repository access. Old summaries are refreshed
only from an exact, validated Caller identity, without changing failure
counts or retry clocks.
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
visible under Needs you. Classification never authorizes a retry.
Distinct attempts are read before visual grouping, so a newer automatic event
cannot hide an older held reviewer. Persisted launch contract and quarantine
evidence overrides Caller no-action text; a matching correlation must identify
exactly one Caller row. Stronger current incident evidence also overrides a
cached automatic failure summary.

If the browser cannot read `/api/behaviors`, it reports one request diagnostic
and retains its last known snapshot. It does not infer agent-log, datastore or
identity failures from that request. A generic browser fetch exception retains
its actual message and unknown cause; it never fabricates an ECONNRESET. Controls remain unavailable until a
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

Managed accounts interleave ordinary refreshes with resumable daily
reconciliation chunks (20-second work budget, plus in-flight GraphQL work).
Partial maintenance is not a completed daily reconciliation and does not
advance freshness. Scheduling resumes only after an ordinary sync passes the
unchanged 120-second datastore health gate.

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
After a dismissal and a head change, a completed change-request review by the
configured reviewer can admit a fresh head-pinned approval evaluation through
the same activity and ownership guards. Dismissal never counts as approval.
The recovery retains the admitted reviewer through preparation and preserves
same-head/model failure holds across request and head dedupe keys.
An occupied head's failed record remains through preparation; an eligible model
change replaces it atomically with the admitted intent before normal launch.
A failure about the reviewer's account, not the review — a 402 or "balance
exhausted", or "not signed in" or missing credentials — trips that reviewer
instead of holding the target: Poise records one failure naming the reviewer,
the cause and the fix, launches the next configured reviewer in its place, or
waits when none is healthy. The trip retries on the usual backoff and clears
when the reviewer succeeds again, with a single probe launch per window. A
failure Caller's recovery reports trips the recovery model while its target
holds, and a run that posted anything holds without tripping. Other provider
blocks (a local account
latch, safeguards) keep the per-target hold, preventing them from launching
identical workers.
Codex input overflow is staged within the existing total review budget, with
every fragment acknowledged in one native conversation before a single final
verdict can be submitted. Ordinary messages are unchanged. The bounds and
failure rules are in [Caller PR review models](../caller/agent_interface/README.md#pr-review-models).
A structured provider exit or error terminal keeps `not_started` /
`preflight_failed` with a typed `review_provider_exit` / `review_provider_error`
cause and no receipt; Poise retries it only after live GitHub evidence proves
no reviewer action. Submission rejections, `no_review` no-ops, malformed or
duplicate verdicts and duplicate GitHub reviews are contract violations and
held. Uncertain submissions are reconciled from live receipts before any retry.
After account recovery, a successful explicit replay on the same head, model,
and reviewer reconciles the held no-action attempt. Its GitHub review receipt
must be present in live evidence before it becomes durable approval evidence.
`resolve-unblocking` uses the upstream strong
resolution primitive, which revalidates the complete gate before every thread
mutation.

Load timeouts — an expired sweep deadline, a slow CLI, lock contention — retry
on a short clock of a few minutes, not the hour-long backoff of hard failures.
A failure carrying an explicit quota reset retries at the reset instead of that
backoff: no sooner than a minute out, never later than an hour.
A `review-new-prs` sweep cut short by its deadline still claims and launches
the reviews it managed to prepare, and an `approve-prs` sweep still fires the
approvals it managed to prepare; the next sweep prepares the rest. Git
verification uses the same 30-second CLI budget as other review reads, and the
rail names a timed-out sweep as stalled instead of repeating the timeout text.

Every behavior tick starts at most one open-PR listing per ready account,
shared by the pull-request behaviors; each behavior then reads its per-PR
evidence in batches of ten over one process per batch, and a per-account
cursor rotates coverage so a sweep cut short by its deadline resumes beyond
the blocked batch. One pull request's batch error holds only that target's
check on the usual backoff; a failed batch holds each of its targets the
same way. Each record settles on its own timeout inside the batch, so one
hung read cannot take its completed siblings with it. Review preparation
and approval launches run in small pools instead of one process per pull
request at once. The review checkout provisions in the launch phase after
the claim, outside the sweep deadline; a checkout failure there releases
the claim and records a `preflight_failed` outcome.
Scheduled ticks start each ready account a few seconds apart so their CLI
bursts don't collide, and the service health and behavior diagnostics expose
the current minute window of event-loop delay, where fan-out stalls show up
first.

`merge-prs` is disabled unless `behavior_merge_prs_enabled` is explicitly `1`.
It uses Caller directly without a model launch: after fresh datastore eligibility,
it discovers up to 50 eligible PRs per ready account with one fresh
`--merge-candidates --requests-json JSON --token-user AGENT` GraphQL read.
The packet carries current head, author, the existing green readiness predicate,
a behind flag for branches that are only out of date, and the latest approval
time; unchanged heads are still reevaluated for completed checks and conversations.
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
After the merges, one scan updates at most one behind branch, oldest approval
first, so updates don't churn CI: the oldest-approved behind candidate holds the
shared per-PR operation lock for
`--update-branch-if-behind PR --expected-head SHA --author USER --token-user AGENT`.
Caller revalidates the behind predicate on fresh head-pinned reads and sends the
expected SHA to GitHub's update-branch endpoint. Anything else blocking, and a
branch that caught up on its own, report `not_ready`. It reports `updated`,
`not_ready`, or `superseded`; an update is not a merge and leaves Last triggered
alone. A per-account cursor advances before each batch read and each merge attempt, so
a scan cut short by its deadline resumes beyond the blocked batch or candidate.
Ten blocked PRs in one account add 60 GraphQL queries per hour at the one-minute
cadence. Each successful merge adds three REST reads, one GraphQL query and one
REST write; each branch update adds the same without the repository read.
Transient retries may add requests. GitHub's returned query cost is
exposed in the Caller batch packet.

`rerun-grey-ci` is off unless `behavior_rerun_grey_ci_enabled` is `1`. It reads
`--grey-ci-candidates --requests-json JSON --token-user AGENT` in batches of 50
with no REST polling. Current-head workflow check suites identify only completed
cancelled/stale/timed-out GitHub Actions runs. Additional GraphQL pages complete
truncated workflow inventories. The latest run per workflow/event excludes
superseded interruptions; third-party checks and intentional skips do not become
reruns. An unreadable batch or PR records that target's failure and the scan
continues with the rest; one PR never stops another's rerun.

A ready candidate takes the shared PR operation lock. Immediately before launch,
Poise rereads skips, enable and acting identity, then atomically records a durable
workflow/head/event intent. Caller `--rerun-grey-ci-if-ready` rechecks the author,
head, exact run/attempt, every job and latest replacement run, then requests one
workflow rerun. Every job must be completed with a known conclusion, and at least
one job must prove interruption (cancelled, stale or timed out): a failed job
beside an interrupted one is collateral, since rollups fail because a sibling was
interrupted, while a run whose jobs show no interruption merely failed and is left
alone. Unknown or active jobs refuse recovery. The normal path uses five REST
reads and one write; paginated job lists add reads. The API has no atomic
expected-head parameter, so the PR head is rechecked immediately before the final
workflow read and write.

Only `rerun_requested` updates Last triggered with a workflow URL. `not_ready`
and `superseded` prove no write and release the exact intent. Missing/malformed
receipts preserve the intent and visible held diagnostics across restarts. There
is one automatic recovery per workflow, event and head; no running CI is cancelled.
A rate-limit error retries at GitHub's stated reset instead of inside the blocked
window. Every completed scan stamps Last succeeded, so a stale stamp with no
visible failure is a silent stop, not a quiet queue.
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

## Run analytics

Behaviors uses the full table width. Its leading, unlabeled toggle controls
activation; notification counts occupy the Status column after Behavior.
The shaded numeric columns show total runs, total elapsed minutes, and the
percentage of finished runs that did not fail. Any time, Today, Yesterday,
and This week filter all three metrics by run start, using the timezone in
Settings, independently of Current. These filters do not change settings,
notifications, or Last triggered. Live runs contribute elapsed time but are
excluded from success rate; no finished runs shows a dash.

Agent metrics use only automatic runs with the matching behavior and Poise
source. Missing or quarantined logs show unavailable metrics, never zero.
Resolution, merge, and grey-CI metrics count direct mutation attempts recorded
in the local run ledger since tracking was introduced; earlier history is
unavailable. Eligibility checks and resolution polls that change no conversations
are excluded. Safe no-write merge/rerun receipts count as successful executions;
errors count as failures. Unknown durations show a dash. The ledger uses indexed
time windows and cached database aggregates; unchanged refreshes do not scan its
history. Narrow windows scroll the table without compressing its controls.

### Notification evidence identity

The browser retains validated `callId`/`correlationId` and optional retained
Logging references in each diagnostic detail before deduplicating presentation.
Preparation exceptions inherit only their current launch's identity through the
existing capture path. Read-time joins require exact source, owner, target and
material cause; absent preparation or Caller evidence is never replaced by a
sibling PR attempt. These references change neither retry ownership nor attempt
accounting. [Logging](Logging.md#notification-evidence) defines the read boundary.

## Read-only firing ledger

The [Behavior ledger](Behavior-ledger.md) exposes compact per-firing metadata,
child attempts, native evidence references and a resumable change feed. It
observes the existing six Behaviors through nonblocking hooks and existing
Caller snapshots. Its separate worker/store cannot change behavior decisions,
claims, retries, metrics or launch arguments. Missing or stale evidence stays
explicitly unknown; capture loss is visible in independent health metadata.

Review launch eligibility is checked again after checkout provisioning: disabling
Review New Pull Requests or skipping the repository settles the unused intent
and releases its claim without spawning a worker. Resolution sweeps retain the
last attempted mutation as their cursor, so slow attempts cannot hide later
pull requests behind a batch that was already read.
