# Behavior integration contract

Poise is a trigger and orchestration layer. It does not read GitHub source,
construct reviews, or mutate review threads itself.

The shared error-state vocabulary lives in [Error-state handling contract](Error-State-Contract.md);
per-message paragraphs below are examples of that table.

## PR accounts

PR behaviors accept either configured GitHub account as author, case-insensitively.
The other account reviews, approves, resolves, merges, updates behind branches and
recovers interrupted CI. Both accounts must be configured and distinct. Existing
behavior enable switches and repository skips apply in both directions. Issue
reviews continue to use the agent account alone. Neither saved settings nor gh's
active account is switched. The human account now also spends automation API quota.

Evidence reads are batched separately per acting account. Review and approval
admissions pin their account pair and reviewer. The roles must still match at
launch, even when the reviewer username stays the same. Resolution pins
the pair before invoking Caller. Completed work
and uncertain publications retain their original actor and dedupe identities.
Review New PRs' existing baseline markers remain: previously unclaimed agent PRs
become eligible on a normal scan; first enable snapshots both authors.

When reviewing as the main user, only recorded Poise review receipts authorize
follow-up approval or resolution. Any manual/unclaimed review by that account
holds those actions visibly, including after restart. Caller rechecks that receipt
inventory immediately before approval and during each resolution gate; automation
cannot supersede the person's manual review. Explicit manual reviews accept any
known PR author (third-party authors use the agent); automatic eligibility stays
within the pair. Author discovery uses Caller's live head primitive. The installed
PR stop gate uses the same opposite-account rule from live PR author evidence.

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
Chain observation summaries include the bounded, redacted stderr cause. Known
upstream 5xx and transport observation failures are grey while the existing
scheduler rechecks them; other runtime faults remain red.

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
The API supplies `runtimeError` for a stopped/stale scheduler, an overdue
operation, or a chain sweep failure or [overdue overlap](Behavior-chain.md).
A degraded status without a known runtime cause is yellow.

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

Verified PR packet head or base drift settles through Caller's existing
`superseded` outcome before provider invocation or publication. A matching,
durable, no-publication supersession also suppresses a generic review worker
exit Error; missing, unreadable or mismatched evidence and independent process
failures remain visible. Normal reconciliation reconsiders the current revision.

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
Sub-issue reader entries and later pickups yield to real callbacks rather
than draining in microtasks; at most four reads run concurrently. Reader
failures are observed before yielding and retain the first original rejection
when several fail during startup. Normal per-issue read failures still use
their existing independent retry handling.

`review-new-prs` accepts either one atomic `requested_changes` review or the
authoritative `reviewed_clean` outcome. `approve-prs` accepts one head-pinned
approval or one atomic change request. An unresolved finding whose location became
outdated can be reaffirmed without another inline comment when the reviewer
confirms it still blocks the supplied head. The same review body retains each
reaffirmed thread's root-comment permalink and finding text, including alongside
new inline findings. Distinct findings at the same location remain new inline
comments. Referenced roots retain reply and resolution evidence for the active
change request. A terminal review contract violation
is held on unchanged input and model instead of repeatedly launching the same
worker. When live GitHub state confirms the pull request already closed or
merged, the obsolete firing settles natively superseded instead of holding:
Caller records `review_target_closed` with the original failure and the
unclaimed-publication evidence, never a clean review, and the settle proves no
unknown worker stopped and authorizes no replay. Native reconciliation accepts
that typed terminal closure even with a retained review receipt, preserves the
launch's error and seen marker, and does not release an account-access hold.
The firing ledger distinguishes `review_target_closed` from a head-change
supersession: closure ends unstarted panel slots, while any running or uncertain
started sibling retains its actual activity. A later admission cannot inherit
an earlier closure. A clean review becomes approval-eligible on the next scheduler scan.
Before a legacy approval worker starts, a verified head change records the rejected
request as superseded with settled activity and releases ownership without check
backoff. The next tick evaluates the new head; the rejected request keeps its
expected head. Unavailable or malformed head reads still fail visibly, and Caller
retains its head-pinned publication guard.
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
A budget-exhausted run that proved it posted nothing can retry on backoff.
Verified file-group deadlines (`review_budget_exhausted`, diagnostic phase
`file_group`, outcome `timed_out`, submission `none`) count toward the target's
retry stop without tripping the shared reviewer or clearing an existing provider
trip. Older generic budget receipts still trigger shared backoff.
After two distinct automatic timeouts for the same PR, head, behavior and model,
the legacy runtime retains the failed launch and shows that automatic retries
stopped, without another retry time. Provider recovery, restart, another slot
or approval context cannot clear this stop. A changed head or model remains
eligible; the verified explicit retry permits one successful launch and then
consumes its exception. Uncertain publication keeps its existing hold.
After account recovery, a successful explicit replay on the same head, model,
and reviewer reconciles the held no-action attempt. Its GitHub review receipt
must be present in live evidence before it becomes durable approval evidence.

Approve Pull Requests carries a review-round cap: off unless set, otherwise an
integer from 2 to 10. A round is a completed change-request round on the pull
request: the initial review counts once however wide its panel, and every
approve-prs follow-up counts, including follow-ups on an unchanged head that
author replies re-armed. Failed, held, quarantined and manual runs add none,
as do superseded runs that posted nothing. A review that posted on its
expected head counts even when the pull request's head moved before the run
finished verifying it; Caller reports the posted verdict, not a supersede,
and a superseded run that nevertheless carries a review id is quarantined
for a person instead of being silently released. The count is read from the
durable launch ledger at preparation time, so it survives restarts. From the capped round on
(round ≥ cap, never = cap alone, so a push after a capped approval cannot
reopen the loop), the run retains the ordinary atomic change request with all
blocking findings if any verified `p0` remains (`p0` breaks a common path).
Missing or unrecognized severity also stays blocking. Only when every finding
body explicitly starts with `[p1]` or `[p2]` (case-insensitive) does the run file
the findings as one follow-up issue in the pull request's repository and approve.
New findings carry a severity prefix; reaffirmed threads keep their original
bodies. A capped round with no findings is a plain approval with no issue.
The issue carries a marker for its pull request and head
(`<!-- poise:review-cap #N@sha -->`), one section per finding with its
severity, path, line and side, a permalink
pinned to the reviewed head (to its base for removed-side findings), and a
link back to the pull request; a retry or replay
reuses the marked issue and never files a second one for the same head.
An explicit approval replay runs under the same effective cap: at or past
the capped round it applies the same breaking-finding check before filing
(or reusing) a follow-up issue and approving. An existing marked issue never
bypasses that check.
The capped approval reconciles as the ordinary head-pinned approved outcome.
When the issue cannot be created, nothing is approved and the run fails loudly
with a contract violation; an uncertain filing is reconciled from live
evidence before anything retries. With Merge Pull Requests on, a pull request
can merge with deferred p1/p2 findings and the follow-up issue is their only
remaining record. Structured providers convert only explicitly nonbreaking
change requests into issue-plus-approval in the harness; Claude receives the
same severity policy and can request changes or file the issue then approve.
Claude submits nothing when filing fails. A human's change request still blocks
as before, and the row's Skip list and pause/disable guards apply to capped
runs like any other launch.
`resolve-unblocking` uses the upstream strong
resolution primitive, which revalidates the complete gate before every thread
mutation. Before Caller starts, an admitted resolution persists its target,
actor, head and shared direct-run/firing/diagnostic identity. Every post-admission exit,
including deadline cancellation, disable and access holds, retains recovery
independently of the presentation failure row. Validated retry scheduling reads
the original CLI evidence before presentation selection drops rate headers.
Earlier uncertain invocations remain linked when a later invocation fails or
leaves unresolved work. Unchanged thread counts and draft status prove no
recovery. The target's empty-thread read can settle same-head failed work;
positive closed/merged lifecycle evidence supersedes obsolete work while
retaining unknown effects. Absence from the open inventory is insufficient.
Native disposition receipts remain on their direct runs, with legacy unmatched
identities retained separately rather than inventing correlation. Late callbacks
cannot replace a newer attempt or a settled receipt; a late no-op preserves its
receipt before its idle run is discarded. Missing-target lifecycle reads respect
the retained attempt's retry deadline too. At 32 unreconciled
invocations the target requires reconciliation before another admission; no
uncertain evidence is dropped. One missing target is read at the end of each
existing resolver pass, using its reader, deadline and access holds; no timer or
new polling loop is added. The mutation never runs merely to clear a diagnostic.
Each `merge-prs` merge or branch-update invocation retains a bounded native
receipt on its direct run: target, native identity, acting account, expected
head, operation (`merge-if-ready` vs `update-branch-if-behind`), outcome, and
the validated `merge_sha` or queue entry id on writes, or the redacted failure
cause. Direct runs settle once; a delayed failure or unknown callback never
overwrites a proven completion, and an unavailable handling view never erases
the canonical run.

Load timeouts — an expired sweep deadline, a slow CLI, lock contention — retry
on a short clock of a few minutes, not the hour-long backoff of hard failures.
A failure carrying an explicit quota reset retries at the reset instead of that
backoff: no sooner than a minute out, never later than an hour.
PR review preparation and claimed-head revalidation retain the fixed GitHub
primitive, phase, PR, reviewer slot, available expected head and original operation
identity on failures. The handler records the existing per-slot `:check` retry
before emitting one Error with the original child evidence and next retry time;
separate attempts remain separate records. A timed-out probe launches no review.
Its due retry reads the current head and launches each admitted reviewer slot
once, while unrelated targets remain eligible.
When the agent account cannot read a repository at all — GitHub 404 or
NOT_FOUND for the repository — the first such failure records one held state
for the repository instead of a per-target failure, and the pull-request
behaviors skip the repository until access comes back. One recheck an hour
later either clears the hold or renews it; a successful check against the
repository clears it sooner. A batch failure shared by several repositories
is unattributable and never holds any of them. The rail's held-repository
entry names the acting account and links the repository's access settings,
where the person invites the account or resends its pending invitation;
grants stay the person's explicit action.
A `review-new-prs` sweep cut short by its deadline still claims and launches
the reviews it managed to prepare, and an `approve-prs` sweep still fires the
approvals it managed to prepare; the next sweep prepares the rest. Git
verification uses the same 30-second CLI budget as other review reads, and the
rail names a timed-out sweep as stalled instead of repeating the timeout text.
Review and approval cycle failures retain their organization, last known phase, live
effective deadline and observed check/launch counts in diagnostic context before
clock cleanup, including a tick that returns on abort. Pending checks include
unfinished review preparation and unread or failed approval reads; prepared work
is counted separately. A review timeout keeps the sweep identity even when a
target attached its identity to the same exception. A deadline record retains
the cursor, original launch claim,
correlation, expected head and observed Call, plus the next scheduled tick.
Only a proven deferral with a successful final evidence read and an available
scheduled continuation is captured as Warning at the sweep cycle: either
prepared approvals remain before any launch attempt, or every attempted claim
has matching, unambiguous running Call evidence. An approval deferral requires
every attempted claim to stay visible: released attempts cannot be hidden by
surviving owned launches. Missing or conflicting ownership, unreadable
evidence, uncertain writes and unavailable continuation remain Errors.
Read counts do not prove completed evaluation, and a launch does
not prove publication: publication stays unverified until reconciliation proves
its outcome. The next tick reconciles original launches before reconsidering
unread and queued work under the existing eligibility, cursor and retry gates.

Process-lock contenders within one server queue by normalized path, so only
the local owner polls SQLite for cross-process ownership. Queueing and SQLite
acquisition share one timeout; cancelled and expired waiters never run their
callbacks. Different paths progress independently, and callback or acquisition
failure releases local admission as well as the SQLite reservation. Review
checkout retention and provisioning waits use the review's cancellation signal.

Every behavior tick starts at most one open-PR listing per ready account,
shared by the pull-request behaviors; each behavior then reads its per-PR
evidence in batches of ten over one process per batch, and a per-account
cursor rotates coverage so a sweep cut short by its deadline resumes beyond
the blocked batch. One pull request's batch error holds only that target's
check on the usual backoff; a failed batch holds each of its targets the
same way. Each record settles on its own timeout inside the batch, so one
hung read cannot take its completed siblings with it. Review preparation
and approval launches run in small pools instead of one process per pull
request at once. Pool worker entries and later pickups yield to real callbacks
rather than draining in one microtask sequence. Multiple startup failures retain
the first observed original rejection. Later workers can enter later under
load while the original sweep deadline still applies, lowering early
concurrency; the existing cursor preserves deferred targets. Shared asynchronous
preparation can still release continuations together; this is not a global
limit on forks per turn or a throughput guarantee.
Review launch (phase 3) remains unspaced and bounded by check slots. The review checkout
provisions in the launch phase after the claim, outside the sweep
deadline; a checkout failure there releases the claim and records a
`preflight_failed` outcome.
Scheduled ticks start each ready account a few seconds apart so their CLI
bursts don't collide, and the service health and behavior diagnostics expose
the current minute window of event-loop delay, where fan-out stalls show up
first. Every such CLI process starts from a worker thread: on Linux, starting a
process blocks the starting thread until the child runs, and under CPU
contention that wait held the event loop. Should the worker fail, processes
start on the main thread again. GitHub lists (`/api/gh`) start no process for
the datastore's `pr`, `issue` and `user` views: one long-lived worker thread
reads each datastore file read-only with the CLI's own query
(`server/datastore-views.ts`), reopens a file that was replaced, and gives an
identical read already in flight the same answer. Other views, and any read the
worker fails, still run `github-datastore view`.

`merge-prs` is disabled unless `behavior_merge_prs_enabled` is explicitly `1`.
It uses Caller directly without a model launch: after fresh datastore eligibility,
it discovers up to 50 eligible PRs per ready account with one fresh
`--merge-candidates --requests-json JSON --token-user REVIEWER` GraphQL read.
The packet carries current head, author, the existing green readiness predicate,
a behind flag for branches that are only out of date, and the latest approval
time; unchanged heads are still reevaluated for completed checks and conversations.
Scoped GraphQL errors hold only their target; identity or unscoped errors hold the
whole batch visibly. Discovery sends no REST reads or writes. For a ready candidate
it holds the shared per-PR operation lock, then calls
`--merge-if-ready PR --expected-head SHA --review-response-json RECEIPT --author PR_AUTHOR --token-user REVIEWER`.
The receipt retains the existing configured reviewer's substantive verdict,
reviewed context and limitations, with its actual completion time and native
invocation identity. Both approval and merge validate the final repository,
PR, head and context (base SHA, title and body). Merge also matches the response
to the actual submitted review and its invocation marker; account identity or
an empty approval cannot replace that evidence. Context changes re-arm the
existing review cycle. The [native chain](Behavior-chain.md) records a confirmed
external merge separately from any still-open pre-merge review obligation.
Caller uses the existing green predicate with fresh head-pinned readiness and
rechecks the pull request before a SHA-pinned merge request. Unknown readiness,
pending/failed checks, unresolved live conversations, incomplete conversation
reads, drafts, foreign authors and changed heads do not merge. GitHub enforces
repository protections at mutation. Caller prefers allowed squash, merge, then
rebase on branches without a merge queue. A branch with a native merge queue
instead uses a head-pinned enqueue mutation after successful head checks,
platform approval and complete conversation checks. It reports `enqueued` or
`in_queue` with the confirmed queue entry; neither is a completed merge.
The direct path reports `merged`, `already_merged`, `not_ready`, or `superseded`.
A confirmed `merged` or `enqueued` receipt updates the per-account Last triggered
event; `enqueued` is recorded as a write with the queue entry reference, while
`in_queue` stays an observation. The server remembers the last entry seen per PR
head: a queued PR is skipped from the batch evidence without further calls, and
a vanished entry for an unchanged green head is retained as a rejection with
backoff instead of being resubmitted. A new head, a manual requeue, or the merge
itself releases the admission.
Operation failures use existing diagnostics and retry backoff. A retry after a
lost response observes the merged state and does not mutate again. Skips and the
global enable flag are read again immediately before launching the operation.
Queue-enabled branches are excluded from automatic base updates: GitHub tests
the queued integration against current main. With Merge Pull Requests enabled,
ready eligible PRs enter that queue automatically; no per-PR merge or confirmation
click is needed. Chat Auto-merge instructions, the default Manager charter and
work-monitor notices follow the repository's live merge policy instead of
requiring every PR branch to contain the latest main. Existing edited Manager
snippets retain their saved text. After the merges, one scan updates
at most one other behind branch, oldest approval
first, so updates don't churn CI: the oldest-approved behind candidate holds the
shared per-PR operation lock for
`--update-branch-if-behind PR --expected-head SHA --author PR_AUTHOR --token-user REVIEWER`.
Caller revalidates the behind predicate on fresh head-pinned reads and sends the
expected SHA to GitHub's update-branch endpoint. Anything else blocking, and a
branch that caught up on its own, report `not_ready`. It reports `updated`,
`not_ready`, or `superseded`; an update is not a merge and leaves Last triggered
alone. A terminal branch-update failure identifies the initial REST read, GraphQL
readiness read, final head read or possible PUT in the existing diagnostic.
Only a confirmed CLI failure before the PUT proves no write: that attempt is
`failed`/`settled` in the ledger. Its event, retry and direct run retain the same
attempt identity and failed stage. A transient read failure is a Warning only
after retry persistence succeeds and automatic retry remains eligible; cancellation,
blocked work and bookkeeping failures retain Error. A possible PUT or a killed
process without terminal proof stays Error/unknown, even after a later attempt
updates the branch. Existing retry bounds and expected-head protections apply.
A per-account cursor advances before each batch read and each merge attempt, so
a scan cut short by its deadline resumes beyond the blocked batch or candidate.
Ten blocked PRs in one account add 60 GraphQL queries per hour at the one-minute
cadence. Each successful merge adds three REST reads, one GraphQL query and one
REST write; each branch update adds the same without the repository read.
Transient retries may add requests. GitHub's returned query cost is
exposed in the Caller batch packet.

`rerun-grey-ci` is off unless `behavior_rerun_grey_ci_enabled` is `1`. It reads
`--grey-ci-candidates --requests-json JSON --token-user REVIEWER` in batches of 50
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

`close-old-prs` (Close Old Pull Requests) is off by default and needs a positive
whole number of days before enabling. The global `behavior_close_old_prs_days`
metadata setting is independent of the priority ceiling; the behavior API reads
and writes it as `days`. A tick with missing or invalid days closes nothing and
reports one operation failure. It uses the shared fresh open-PR listing and full
PR eligibility policy, including repository holds and chain ownership exclusions.
There is no backlog baseline: existing old PRs qualify on the first enabled tick.
Age is elapsed time since `created_at`: `now - Date.parse(created_at) >= days *
86_400_000`. Missing, invalid or future creation times leave the PR open with a
visible failure; `updated_at` never substitutes for creation time.

Each candidate takes the shared PR operation lock and rechecks enablement, pause,
scope, account pair and current days before dispatch. Caller
`--close-old-pr-if-ready` rechecks live open state, non-draft status, author and
creation time against the supplied cutoff immediately before closing. It validates
an unmerged closed receipt; a lost write response gets one read, never a repeated
write. Already closed or merged returns `already_closed`; other live refusals
return `not_ready`. Only `closed` updates `behavior_close_old_prs_last_fired` and
Last triggered. Direct runs and the firing ledger retain outcomes; errors and
unconfirmed receipts stay visible as failures and dead letters, with normal retry
backoff. A repository read 404 uses the existing access hold; a 403 stays per target.
No intent or seen state is needed: retries live-check closure and never re-close
an already closed PR. Disabled ticks add no GitHub traffic.

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

Validated stale health opens one durable episode per mirror account/database.
It retains the first detection, first and latest freshness evidence, and the
union of behaviors whose gates refused work. Logging records its opening once;
Behaviors groups those refusals under the same episode while keeping each
behavior's refusal. Changing sync ages, later ticks and server restarts do not
open another episode. Evidence is ordered by successful sync timestamp, then
age within that sync; late stale or healthy results cannot replace newer evidence.
Closed-target reconciliation uses the same episode for verified stale refusals,
without adding Error rows on later probes or reading targets before freshness returns.
Healthy probes keep advancing the retained evidence after recovery. Only a
validated successful healthy probe records recovery and rearms the mirror.
Caller's normal stale stderr with validated stale JSON is an expected probe
outcome; unexpected stderr remains a process fault.
Native discovery and cutover probes share this reporting and retain their
existing exit-based admission rules. Crashes, malformed or
mismatched health, and failed recovery commands remain independent faults, even
while a stale episode is open. The freshness limit remains 120 seconds.

If Caller explicitly reports a missing local checkout, Poise can provision an
owned checkout through Caller's existing checkout primitive, verify its origin,
commit and clean state, and publish it atomically. Concurrent requests share
provisioning; changed or existing user checkouts are never replaced. The
checkout is provisioned as the selected opposite account, the reviewer, which Poise names
to Caller with `--token-user`. CLI errors retain bounded, credential-redacted
terminal diagnostics. Review receipts and launch claims remain authoritative;
dependency repair never fabricates a verdict.
Provisioned checkouts (`~/.poise/review-checkouts/<head>`) are removed a day
after a review last resolved their head, checked in the background when Poise
starts and every hour after, whether or not reviews run; a later review of
that head provisions it again. User checkouts are never removed.

A closed legacy failure can recover when Caller subsequently supplies an exact
`not_started` / `preflight_failed` result. The same no-action rule applies before
and after restart. Other bounded, oversized-packet and invalid-result holds retain
their existing rules; unrelated reviewers’ submitted receipts do not override
an exact proof that this particular run never submitted.

For legacy failed Calls with `action=null` and `outcome=null`, the existing
publication probe retains its refusal on that exact held Call/correlation.
Behaviors' held diagnostic and PR status `blocker.details` distinguish pending
reviews, unclaimed reviews, incomplete identity inventory and unavailable reads,
with the original/observed heads and at most three observed review IDs, states
and commits where available. These observations never become the Call's receipt.
The explanation survives ticks and restarts without another launch or changes to
failure counts, backoff or the timeout-stop marker. Original Caller results and
incident history remain intact; typed no-action and count-only zero-activity
recovery retain their existing retry rules.

## Where the pull-request behaviors act

`review-new-prs`, `approve-prs`, `resolve-unblocking`, `merge-prs`, `rerun-grey-ci` and `close-old-prs` each have a Skip
repositories list (`behavior_<behavior>_skip_repos`): `owner/repo` names, one
list per behavior shared by every ready account. Before a scan claims, reads or
launches anything, it keeps only the pull requests that pass one check: open,
not a draft, authored by either configured GitHub account, and outside the behavior's
skipped repositories. A skipped pull request is never claimed, dead-lettered or
counted toward a retry. The list is read again immediately before a launch or a
resolution, merge, CI rerun or age close, so a repository skipped while a scan is under way is left alone too.

`review-new-prs` takes its anti-flood baseline (`behavior_seen`,
`__snapshot_v3__` and the pull requests recorded with it) over every open pull
request of yours, skipped repositories included: the baseline records what was
already open when the behavior began, wherever it is. Saving a skip list never
retakes the baseline or clears the ledger. Unskipping a repository therefore
makes its open pull requests eligible on the next tick exactly as new ones are:
those opened since the baseline are reviewed, and the backlog it recorded is
not. `approve-prs`, `resolve-unblocking`, `merge-prs`, `rerun-grey-ci` and `close-old-prs` have no baseline; an unskipped
repository's pull requests are evaluated on the next tick like any other.

## Dead-letter reconciliation

Every behavior tick reconciles the dead-letter inventory against the launch
ledger. Resolved and superseded rows retire with their evidence and check time;
held rows stay active. Nothing is deleted. Listing absence never proves closure.
Unseen rows reconcile before rechecks of held rows, least-recently rechecked first.

The same tick checks held targets, including quarantines and target-specific
failure summaries, through the fresh datastore's exact issue/PR readers. Only
an explicit closed issue or closed/merged PR retires its incidents and notices.
Open, missing, unreadable and timed-out targets remain held. This cleanup runs
independently of enablement, pauses, model availability and behavior cutover,
coalesced per account under the existing 55-second operation deadline and
shutdown signal. Pending resolver recovery retains its failure summary.

Closure preserves launch ownership, quarantine, original errors and uncertain
outcomes. Late reconciliation cannot recreate a retired closed-target incident.
An exact open read restores held evidence for the original reviewer/request
target when its retained launch still needs reconciliation; history stays intact.

## Replays

A replay from Swarm passes the same eligibility check the scheduler applies,
or it is refused with HTTP 409 and an error naming the check that failed.
Poise reads the target fresh, behind the datastore freshness gate and from
the same datastore the scheduler reads, and decides before it prepares a
model, a checkout or a head. The scheduler and the replay call the same
function for each kind of target for eligibility, so the two cannot drift
apart.

- `pr_review` and `pr_approve`: the pull request is open, not a draft,
  authored by either configured GitHub account, and not in the Skip repositories list of
  `review-new-prs` or `approve-prs` respectively.
- `issue_review`: the repository is opted in to `review-new-issues`, the issue
  is open, and its author is a trusted author.

A pull-request replay is additionally refused while any worker owns the pull
request, and when live GitHub already shows the review as published on the
current head. Each behavior replays only its own publication kind: an
approval for `pr_approve`; a commented or change-requested review for
`pr_review`, unless a failed review slot on that head is still outstanding.
Panel siblings share the agent account, so a review another Caller row claims
as its own receipt is not a duplicate. Dismissed reviews never count. A
replay reserves its target for ten minutes before its checks and holds it
through spawn, so a concurrent replay is refused while preparation and
spawn are ahead. Launch claims fence live reservations atomically, so a
scheduler tick in that window skips instead of starting a duplicate
worker; a refused replay releases its reservation. An
`issue_review` replay stays a deliberate fresh run that comments again: it
takes no publication check. It is bound to the exact document revision read
when the request is accepted — the SHA-256 of the current title and body —
and Caller verifies that revision before reading and before posting. One
revision is requested once: a repeated request reuses the recorded
obligation and starts nothing new, however the run ended. Each published
comment carries the short revision it reviewed, so a stale result stays
distinguishable from a review of the current body.

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
The shaded numeric columns show total runs, total elapsed duration, and the
percentage of finished runs that did not fail. In Settings → Behaviors, Any
time, Today, Yesterday, and This week filter all three metrics by run start,
using the timezone in Settings, independently of Current. On Overview they
follow the day chosen at the top right instead, like the day's numbers. These filters do not change settings,
notifications, or Last triggered. Live runs contribute elapsed time but are
excluded from success rate. Where a value cannot exist, the cell says why in
words: *no runs*, or *none finished* while every run is still live or
interrupted.

Agent metrics use only automatic runs with the matching behavior and Poise
source. A failed log read withholds agent metrics. A quarantined row counts as a
run when Caller still reads its behavior, source, status and start: damage to
its JSON columns (diagnostic, artifact, progress) leaves those intact, and the
row's end, when it reads, times it. A quarantined row missing any of them, or
sharing a readable row's identity, withholds only the behavior and start-time
window it could affect, and that row says *unknown: some of its run records
cannot be read*. Missing provenance stays conservative, and conflicting
duplicate identities cannot escape through contradictory scope hints.
Unavailable metrics remain unknown, never zero.
On Overview, incomplete Today coverage also raises an immediate tab-local Poise
fault. Its evidence names the range, affected behaviors and metrics, source
reason and available Caller/history-row references; Logging retains the same
diagnostic context. Repeated reads keep the fault's identity and dismissal.
Failed refreshes, reading another day and leaving Overview do not clear it:
only verified coverage of its exact range does. An empty verified day, independently
identified older quarantine outside the range, and untimed history do not raise it.
Historical Caller v1 diagnostics may omit outcome, stderr or truncation facts;
these read as null, retaining submission uncertainty and the failed lifecycle.
Present malformed fields and unsupported versions remain quarantined. Diagnostic
reading grants no new execution or replay authority.
Resolution, merge, grey-CI and age-close metrics count direct mutation attempts recorded
in the local run ledger since tracking was introduced; earlier history is
unavailable. Eligibility checks and resolution polls that change no conversations
are excluded. Safe no-write merge/rerun/close receipts count as successful executions;
errors count as failures. A direct run whose owner died without finishing
closes as interrupted with its completion unknown: it stays out of the
success rate, and its duration is never guessed. Time adds the runs whose
duration is known and says how many are untimed (`+ 6 untimed`). Durations use
explicit units, such as `6s`, `8m 30s` or `4h`; a known zero is `0s`. The ledger uses indexed
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
observes the existing Behaviors through nonblocking hooks and existing
Caller snapshots. Its separate worker/store cannot change behavior decisions,
claims, retries, metrics or launch arguments. Missing or stale evidence stays
explicitly unknown; capture loss is visible in independent health metadata.

Review launch eligibility is checked again after checkout provisioning: disabling
Review New Pull Requests or skipping the repository settles the unused intent
and releases its claim without spawning a worker. Resolution sweeps retain the
last attempted mutation as their cursor, so slow attempts cannot hide later
pull requests behind a batch that was already read.
