# Native issue-to-merge behavior chain

PR review and approval retain the configured reviewer's substantive verdict,
reviewed context and limitations before submission. The existing native receipt
binds that response and its actual completion time to its reviewer, model,
invocation, repository, PR, head and context (base SHA, title and body). A changed
head or context requires the existing fresh-review cycle. Approval metadata and
another process using the same account cannot supply that invocation's response.
Merge and queue admission revalidate the retained response against the current
PR and its published review while preserving the normal CI and thread gates.
A confirmed external merge is recorded separately: without qualifying pre-merge
review evidence its review obligation remains open through journal recovery.
A closed seed without a bound PR also discovers exactly one merged GitHub closing
reference on the expected base repository and default branch, confirming its merge
SHA through the normal PR read. Missing, ambiguous or contradictory evidence keeps
the closure hold; discovery grants no publication ownership or new invocation.
When the bound PR is confirmed closed without merge, the same verifier retains
the different closing PR as separate observation evidence. Its linked reference
does not keep an otherwise settled closed chain active. The original binding,
invocation receipts and merge/review fields remain unchanged; GitHub's test-merge
SHA on the unmerged binding is not evidence of a merge. Other linked PRs,
uncertain publication, unsettled native resources and recorded review obligations
still keep the chain active.

After a confirmed merge, review reconciliation uses the last canonical
pre-merge observation recorded before both the actual merge time and the first
merge event. Its target, head, review context and required reviewer slots remain
fixed. Today's reviewer settings and post-merge PR edits cannot discharge that
obligation. A previously missing original review may become visible later, but
its response and actual GitHub submission must precede the merge and match the
original basis. The first recorded merged context and the current merged read
must also match that basis; a mismatch recorded at the first merge cannot be
erased by a later edit restoring the old title/body. Missing historical context
or an empty panel stays unproven;
the supported reviewer setting is one to three. This lookup reads existing
immutable history and adds no state field, execution authority or polling loop.
Previously completed histories are not rewritten or retroactively certified.

Status: the native implementation completed the ten real cycles documented below. The admission cutover and GUI changes carry separate local regression proof; those historical cycles do not prove production cutover. Production execution remains disabled by default.

The existing behavior scheduler consumes one durable journal in Poise's existing database. It admits one atomic invocation for a chain, records its native Caller correlation before starting a process, observes the resulting artifacts, and then decides the next behavior. A chain identifies an issue and its eventual PR; it is not a persistent Chat session or worker.

Intake failures remain visible in runtime health and diagnostics while already-admitted chains continue reconciling and advancing. A stale discovery index cannot suspend execution evidence belonging to existing chains.

An organization's sweep holds a zero-timeout try-lock for its whole run. An
overlapping attempt skips only its chain work; the rest of the tick still runs.
Skips are counted per organization without warning until overlap lasts more than
two scheduler intervals (120 seconds) from its first skip, even before any sweep
has completed. This elapsed-time progress budget is independent of one-second
check-slot retries. Overdue overlap degrades runtime health with `runtimeError`,
and the next contended attempt warns once for that episode. Contention establishes
overdue overlap, not that the lock holder has stopped progressing. Skips and
warnings preserve `lastSweepAt` and any genuine sweep error, which takes precedence
in health. An observed sweep completion, successful or failed, ends the episode
and logs its aggregate skip count and elapsed time; a failed completion retains
its error. A later episode can warn again. Slow lock setup delays a sweep but
never skips or fails it. Any other sweep error is reported in runtime health as a failure.

## Intake and controls

Settings → Behaviors → Issue to merge selects either issues bearing the configured label (default `poise`) or all open issues in followed organizations. Label intake includes old issues that acquire the label. Existing Chat bindings and linked open PRs prevent new ownership; active work is not migrated. The author and review account must be distinct and remain fixed for an admitted chain.

Intake and the fresh pre-implementation ownership check include explicit closing
keywords in open PR bodies in the issue's repository, including stacked PRs
whose GitHub closing-reference connections are empty. The existing PR link and
hold paths keep that ownership visible. Ordinary mentions do not claim ownership;
body keywords supply no merge or prerequisite-delivery proof.

Downstream reuse of this lifecycle for already-created PRs is decided separately: [Downstream-lifecycle.md](Downstream-lifecycle.md) records the scope decision, the exact existing routes and the contracts a follow-up must settle. There is no supported enrollment of an existing PR into a chain at this revision.

The existing reviewer count, model slots, severity, behavior notes, switches, pauses and PR exclusions remain in effect. Implement Issues and Repair Pull Requests are rows in Behaviors with independent switches, notes, author identity, native activity, run metrics and pause/resume controls. Their switches default on within an enabled chain, preserving the existing execution semantics; they cannot enable the chain itself. Their model slots remain in Settings → Models. A chain can be held or resumed individually. Disabling invocations retains receipts and ownership and continues reconciling already admitted outcomes. Holding or pausing does not terminate an existing worker; its existing native Stop control still applies.

**Switch to v2** is one action in Settings → Behaviors → Behavior chain. It records a durable `draining` admission state before any asynchronous work. The existing cooperative release barrier counts behavior operations separately; late legacy launches and prepared chain admissions recheck the durable gate. Running invocations finish, Chats remain usable, and unreadable Caller activity refuses readiness. The existing behavior tick then verifies fresh, complete PR observations across all followed organizations and commits the legacy PR boundary and enabled v2 setting in the same transaction. No new polling system is added.

Cutover also requires the native-cleanup setup check to pass. Hosts
that cannot provide the [native process boundary](Service-architecture.md#workspace-behavior-observation)
stay on v1; checking, unsupported or unavailable evidence disables Switch to v2.
Cancel remains available during a drain even if the check subsequently fails.
An already-v2 setup with unavailable cleanup pauses new invocations and keeps
its existing ownership; it never silently falls back to v1. Run controls show
the same refusal. No deployment or runtime setting changes through this check.

Every new physical model, fixed GitHub action and publication continuation has
its own original Caller resource receipt. Preparation cannot run before that
claim and registered process boundary. A received action response is durably
stored before its Call becomes terminal and remains available after Stop or
interruption. Accepted responses, actual GitHub outcomes and process/disk release
are independent evidence: a response alone cannot release capacity or permit
another action. Reconciliation reads these Calls through the existing batched
snapshot, including quick actions that reserve resources without counting as
model agents. Shared checkout leases retain original outer identities and cannot
be expired, adopted or numerically signalled by legacy lease recovery.

Quarantined legacy review/approval originals retain their input fences and historical uncertainty across cutover. Their retained PR-operation leases are not active work. Live or unreadable native activity, pending native cleanup, in-flight behavior operations and unlinked preparation leases still prevent completion; cutover clears no held record or resource reservation.

The chain settings checkbox controls invocations only after the durable cutover completes. The settings API refuses early enablement, and the runtime independently checks the journal's v2 mode before admitting native work. Saving intake settings alone cannot enable coexistence with v1 issue intake.

After completion, v2 owns new eligible seed issues; new legacy issue intake is fenced. Existing PR behaviors continue for PRs outside native chains, including PRs subsequently created manually or by Chats. They recheck canonical chain ownership immediately before acting, so v2-owned PRs cannot acquire a second behavior owner. Existing Chat bindings and linked PRs are not migrated, and standalone PRs do not acquire fabricated issue-chain history. The observed legacy boundary is retained across restart, and the UI labels its count as PRs retained at cutover, not a live remaining count. Cancel cutover is available while draining and records a return to v1; it does not terminate work or reverse a completed cutover. A failed or incomplete observation leaves the drain visible with its error. Ordinary chain pause remains available after cutover and never reopens v1 issue intake.

Automatic PR behaviors also retain the published PR identity after a chain
completes: a stale open datastore row cannot admit a legacy worker for a PR
the journal already records as merged. This uses the existing bounded journal
status reader. A later standalone PR on a completed chain's retired branch
remains eligible; this fence does not change manual Chat binding controls.

Settings → Behaviors contains the chain preference fields, their save/reload actions and the guarded Switch to v2 or Cancel cutover action while applicable. Operational output lives in Observe → Tasks: cutover state and legacy ownership, capacity, the chain list and per-chain journal. The chain list displays v2 ownership, actual phase/wait/hold/uncertainty, last recorded outcome and confirmed merge SHA, with links to the issue and PR. Hold/Resume retains the current journal sequence check. More chains and per-chain History/More events page through the existing journal readers. It refreshes on the application's existing refresh clock while Tasks is open. Unavailable reads disable writes instead of displaying a confident engine state. Repository/author triggers and the approval-round escape remain explicitly legacy-only; v2 uses its selected label/all-issues intake and never escapes unresolved blockers by approving.

After Resume, a wait recorded before its journal boundary is history rather than
current status. Until a new wait or invocation, Tasks awaits the next observation;
observation-only events cannot revive the old wait. A fresh wait with identical
text is current. The original blocker and linked report remain in History, and
original Call/resource blockers and review/admission gates still apply.

Tasks shows workspace-wide occupied model slots and the subset retained for
uncertain invocations awaiting original resource evidence, independent of list
pages and organization filters. The capacity response's nullable
`retainedModelInvocations` uses the occupied count's resource predicate and
requires an uncertain model invocation; unavailable or missing counts stay
unknown. Needs attention retains each chain's blocker, next action and journal.
Verified physical release removes a reservation from both counts even while
publication remains uncertain and held. These reads change no admission, hold,
retry or release authority.

History exposes each `chain.merged` event's recorded `evidence.review_complete` boolean. Explicit `true` reads “Original review evidence complete”; `false` or legacy absence reads “Merged”. Each event keeps its own disposition across pages and links, independently of the current chain summary. Legacy absence establishes neither review completion nor a pending obligation.

Notifications lists each delayed or held admitted issue's step,
progress age, hold, exact-head CI/review gates and next known action, with issue,
PR links and a Journal evidence action that opens the same journal in Observe → Tasks. Held, uncertain and pending-original-review work
appears immediately, as does a fresh queue/review conflict even while a review is
running or awaiting capacity; other active work appears after 24 hours without a verified
advance. Selection covers every active chain page, including unpublished issues
and merged PRs with pending review evidence, sorted by oldest progress first.
The clock starts at admission. Canonical history advances it on a newly verified
PR head, posted issue-review comment, qualifying PR review, queue entry, confirmed
merge, or recovery of an observed same-head CI/review/conflict gate. Unchanged
polls, admission/start, failed attempts, holds and Resume do not reset it. Restart
and projection rebuild derive the same clock without changing journal events.
Fresh, stale, incomplete and unavailable evidence remain labelled. A known native
failure backoff shows retry eligibility under existing admission gates; an unknown
provider backoff has no invented deadline. Scheduled evidence rechecks never retry
held work. CI or approval recovery cannot clear a hold or missing original receipt,
and a queue entry cannot establish merge completion. Verified progress can remove
a delayed entry; a durable hold remains until explicitly resumed, and a merged
review obligation remains until its original evidence is verified. The first list
page's optional `attention` projection is independent of the ordinary chain-list
cursor/filter; later list pages retain the existing pagination contract. Failed
refreshes label retained attention entries stale. These are read-only summaries
on the existing refresh clock, with no new observation or execution authority.
Unchanged attention reads reuse the history-derived progress clock after
validating the chain's current journal revision. A new event invalidates only
that chain's cached clock; restart reconstructs it from the original history.

In v2, Review New Issues shows that saved seed scope instead of the inactive
legacy repository filter. Its setting opens the existing General seed controls,
using capacity data already returned by the Behaviors read.

API summaries include nullable `reviewPending` and `reviewStatus` (`pending`,
`complete`, `not-recorded`). Older merges without an explicit review verdict
stay not-recorded; they acquire neither fabricated proof nor a new obligation.
These fields are projections, never normalized into historical reducer state.
Merged list and detail reads also expose `mergedReviewWarning` when the original
head, context and reviewer panel prove completed pre-merge native responses but
no response qualifies under the native favorable-review check. Observe → Tasks
retains the merge and completed review status, and shows the unmet clearance,
retained changes-requested verdicts and review links. A separately verified later
GitHub approval includes its head, submission time and link; its submitting client
remains unknown. A qualifying native approval before merge clears this diagnosis;
a post-merge submission cannot. Missing or contradictory original evidence leaves
the diagnosis unproven (`null`). The projection uses full canonical history,
survives observation expiry and rebuild, and grants no execution authority.
A confirmed merge remains visible alongside any hold or uncertain invocation.
List and detail summaries omit the superseded native merge queue wait only when
the canonical merge SHA is recorded. Other waits and pending original evidence
remain visible; the original queue wait stays in journal history.
Merged chains offer History and original receipt reconciliation, including
while an invocation is unsettled. They have no Hold/Resume admission controls;
the headless API refuses those operations with 409 after a confirmed merge.
The UI explains missing original pre-merge evidence without a way to create a
replacement review. `state=active` retains open obligations, including merged
PRs with pending review evidence; `state=merged` retains the existing terminal
classification, including legacy not-recorded merges. Confirmed closed seeds
leave the active list only when no open owned or linked PR, unsettled invocation,
native resource obligation or pending review evidence remains. Missing or
contradictory closure evidence keeps the chain active. This exclusion precedes
pagination and changes neither merge evidence nor ownership; the unfiltered list
and ID/history reads retain closed chains. Failed refreshes disable
the retained row's write controls until a successful read. Native action summaries
distinguish original accepted responses, observed no-action results and uncertain
or unrecorded attribution without returning the full receipt. Quiescent evidence
checks use the bounded reconciliation described below. Observe → Tasks also
shows workspace-wide durable model admissions and their behavior-lane ceiling,
the durable mode, effective all-issues/label intake or inactive saved intake,
and admission pause. Configured resource budgets, reservations and unaccounted
ownership are exposed in the same snapshot without headroom probes. This count survives a
replacement semaphore and includes uncertain model ownership until native
resource-release proof arrives; it is not a claim that a provider process is
currently alive or that all unreserved slots are free of other heavy work.
The separately labelled process-local semaphore count is not additive to durable
chain occupancy and cannot establish that surviving workers have ended.
Unavailable counts are unknown, never zero. The same `chainCapacity` appears
beside `workerCapacity` in behavior diagnostics and Manager context. The latter
still describes Manager worker Chats and their enhancement backlog; its Rhythm
target does not govern atomic chain admissions. No new refresh loop is added.

### Bounded reconciliation

For a reporter-owned full-suite failure, a closed seed can retire a redundant
chain PR as **superseded**, independently of a merge. The seed observation
retains the failing runs, recovery run, reported tests, covering merged PRs and
duplicate head. GitHub must confirm completed full runs on main, and the test
artifacts must show the reported failures and their successful recovery. The
recovery commit must descend from the failure and contain the covering merges.
Missing or expired artifacts leave the decision visible.

Automatic coverage is conservative: every change in the latest duplicate must
be a covered replacement inside the reported tests. The complete recovered
test bodies retain their fixtures and assertions. A fixture-clock assertion
repair with the same pure fixed-clock helper may use another `at(...)` instant, as in #940's `at(61)` and #946's
`at(11)`; unrelated numeric changes, additional assertions, production edits,
other linked PRs and unclear coverage require a decision and remain open.

Original possible writes, review replies and positive native resource-release
proof must reconcile before cleanup. Only the automatic closed-target hold can
be cleared; a person's hold remains. The existing native action path journals
`issue-work --mode retire`, revalidates coverage and rechecks the owned PR head
before closing it on GitHub. Its accepted response and resource release are
required for the `chain.superseded` event. A lost response stays uncertain;
observing a closed PR cannot attribute that close or authorize a second one.
Supersession retains the covering merge separately, keeps the duplicate's
`mergeSha` unset, removes settled work from the active list, and leaves History
and GitHub evidence links available. Rebuild and restart retain this terminal
outcome and the original invocation ownership.

Poise-generated pre-PR failure remediations (`implement-issue`,
`atomic_work_blocked`, with the original repair-report marker) use the same native
retirement path even while their seed remains open or their PR is queued. Their
coverage policy is separate: Git must integrate the whole pinned candidate into
the current default-branch base without conflicts and produce exactly the base
tree. A distinct merged PR on that base's first-parent history must introduce
that coverage; a later unrelated merge is not credited. The bounded read examines
up to 100 base commits and retains the candidate, base, merge base, integration
tree, and covering merge with its first parent and tree. Retirement revalidates
this proof and checks both the head and current integration base before closing.
Changed heads or bases invalidate the decision. Independent changes, conflicts
or incomplete coverage evidence continue through ordinary gates. Supersession
keeps the source issue's hold and outstanding work intact; it does not resume or
complete that source chain.

The existing scheduler selects a normal-work page before a separate due
reconciliation page under its existing pass budget. Quiescent held or merged
chains keep their original ownership, but cannot
consume the normal-work page. Native model/resource receipts are still read
while an original model lacks resource-release proof, including after a merge;
only unnecessary GitHub observation waits.
Before new model work takes a free slot, the same sweep offers it to older
capacity waiters across all chain pages. Both the shared semaphore and durable
invocation-capacity refusals count. Journal order dates the uninterrupted eligible
behavior/basis/reviewer-slot episode; unchanged checks and restart retain its
place, while changed work, other waits and Hold/Resume reset it. Each candidate
passes fresh observation and the existing permission, provider, resource and
atomic admission gates. An older candidate that cannot run leaves the slot for
later eligible work. The reconciliation cursors, interactive reserve and
publication/merge gates remain unchanged; no worker or polling loop is added.
Known closed PRs and closed seeds use the same native-only resource wait for
their blocked model behaviors. A closed seed alone does not defer PR review or
approval of an open PR. Public recheck times describe GitHub observation;
native receipt reconciliation remains eligible on every pass.

Journal revision conflicts are isolated to the affected chain. The sweep makes
at most one fresh attempt within its existing 45-second budget, re-reading the
chain and its native receipts and recomputing the decision. Another conflict or
an exhausted budget defers that chain while unrelated chains remain eligible.
Retained warning diagnostics identify the chain, phase and recovery or deferral
outcome without marking a recovered race as an organization failure. Other
journal errors and unreadable native receipts still surface; concurrent exit
evidence and original invocation correlations and uncertainty are preserved.

Held open PRs are rechecked every two minutes through that same scheduler,
including after a head change. Running PR reviews also refresh their open PR
observation at that two-minute boundary without settling or replacing the original
invocation. Fresh queue evidence without the required retained
exact-head/context reviews surfaces a conflict in work diagnostics, naming the
PR, head and queue entry. The next action directs removal from the queue and
disabling auto-merge if enabled before reconciling the original review receipts;
Resume alone cannot stop GitHub merging. Stale or incomplete observations do not
emit this conflict. The hold and original receipts remain unchanged.
The conflict stays actionable after a retained changes-requested verdict while
the queue entry persists. It clears when qualifying review evidence is retained
without current change requests, or a fresh observation finds the queue entry gone.

Other successful quiescent observations schedule their next read at `checkedAt +
min(24 hours, max(2 minutes, checkedAt - origin))`. Origin is the recorded actual
merge time, otherwise the first native admission; a held chain with neither
uses the one-day cap. The interval approximately doubles until the cap. These
times are derived from canonical state and indexed, so process replacement
does not reset the cadence. Existing Resume makes unmerged work immediately
eligible again; it never creates post-merge review authority. Identical holds
are not repeated and a person's hold is retained. Failed observations neither
advance timestamps nor become success: their error remains in runtime health
after unrelated work is allowed to advance, with at most one attempt per
target per existing pass under the existing account/native budgets.

An explicitly CI-only repair blocker retains the supplied head and failed
check/job identities and URLs in its original native artifact. Its automatic
hold records that invocation and head and stays eligible every two minutes,
using the same scheduler. Once that original settles with `action: not_started`
and positive resource-release proof, fresh `checksState: SUCCESS` with no pending
or failing checks can recover the same head or a verified direct base update.
For an updated head, the failed head must be its first parent, its second parent
must belong to the PR's current base history, and its tree must equal Git's clean
merge of those parents. Extra merge edits, conflicting integrations and ambiguous
or mismatched repository/PR/head evidence retain the hold. The CI read rechecks
the live head and base after verifying the tree. The original failed Call and
hold head remain unchanged; `chain.observed` records the updated head and the
existing resume event records `ciRecovery`. The normal decision path then
rechecks review, approval and merge gates;
overall readiness is not required to release this hold. A generic worker
blocker, uncertain publication or a later operator Hold cannot auto-resume.
When a fresh conflict on the retained failed head prevents a clean base update,
the same settled receipt and resource proof can instead release the hold for
the existing `repair-pr --merge-base` path. The ordinary repair, ownership,
closure and queue guards must permit that repair; an unchanged, merely behind
or unrelated changed head does not qualify. Automatic release preserves
`resumedAfterSequence`, so another CI-only failure and hold cannot replenish
the three-attempt budget on the same repair basis, including after restart.
The original failed CI receipt remains unchanged and unresolved by admission;
the published repair still requires fresh head checks, reviews, approval and
the normal queue gates.
Work impact and attention describe this automatic CI recheck instead of asking
for Resume; attention retains the scheduled `reconciliation.nextObservationAt`.
Unsettled original receipts and resources still require reconciliation first.

When only merge-group CI failed, `ci_blocker.queue` instead retains the verified
GitHub removal, admitted candidate, integration and first-parent base, and each
failed check/job, workflow run and attempt. Caller persists this verified blocker
before optional exact-base baseline proof. Rejected baseline proof retains its
reason and the original queue evidence, without granting baseline recovery.
The existing hold and attention output name those checks and their links.
Green PR-head CI alone cannot release this hold. The same bounded observation
reads the original integration through
`--list-failing-ci --ref`: each original obligation needs a later successful
check in its retained workflow, from a later attempt or run. A stale success,
same-named check from another workflow, pending or unknown evidence stays held.
The latest matching workflow run must also have completed successfully.
Alternatively, a failed no-write Call can retain independently verified
`ci_dependency` proof inside its blocker and use the existing exact-base
recovery checks; a remediation link or closure alone grants no recovery.
Original resource settlement and current-head CI remain required. Recovery keeps
the original Call failed and returns to ordinary review, independent approval
of the queue diagnosis, and fresh current-base native merge-queue gates.

A pre-PR implementation can recover through the same bounded observation even
with failure reporting disabled. The original-run proof path requires its Caller artifact to retain
`test_dependency`: independently verified assertion evidence tying the original
producing run to `prepared.checkout_head`, plus a distinct failing run on that
exact base. CI proof requires both completed main runs' complete full-suite
artifacts. Relay proof would require gateway-authenticated completed Vitest
assertions bound to the original Call's retained random capture binding, but
recovery is currently held for #1619: the suite UID owns the report files, so
candidate code can replace them before signing. The box independently hashes the
uploaded archive and actual source files before execution; the baseline would need
a distinct capture and source digest and match the clean prepared base,
independently of its uploaded index. Matching HEAD alone cannot make a dirty
candidate into its baseline.

Both paths would compare the complete failure multiset and retain every case count
under a failing title, including passing duplicate parameters. Mixed or non-test
failures, missing/incomplete results, overflow, changed original evidence and
worker diagnosis alone keep the hold. Relay inventories, including direct Vitest
commands with runner-owned reporting of assertion, setup and unhandled errors,
all retain their hold until the runner establishes them independently; wrappers
and other runners retain theirs. The gateway would sign evidence only after
genuine completion and return it before deleting the run. Caller would authenticate
and retain those bounded, redacted receipts before checkout cleanup, then the
existing seed observation would revalidate them. A log, archive digest alone,
canceled run or historical output without this provenance grants no recovery.
In particular, #1505 remains held when its original evidence is unavailable.

The existing seed observation verifies the remediation issue's exact closing PR
merge on main and its ancestry after the failed base. A successful full-suite CI
run on the current implementation base must actually pass every original failing
test. Closure or an unrelated passing job cannot authorize recovery. The same
source revision and implementation slot must remain eligible, with the original
failed/no-publication receipt and positive resource release. A fresh seed read
must show no pushed branch, PR or competing work; this is checked again after
provider preparation at admission.

When the original assertion run did not finish, a saved automatic implementation
hold report can instead authorize one fresh clean-base recheck. Its saved source,
Call, implementation basis/slot and hold sequence must still match the current
failed-before-publication receipt and released resources. The current report and
its author/reviewer comments identify a unique delivered remediation of the named
test. The recheck verifies ancestry and a change to that fixture, installs the
locked dependencies on each pinned base, and runs the exact reported Vitest case
on the old base and corrected current base. The old case must fail with a complete
actionable assertion; the corrected case must pass. Completed reporting must
account for every selected case and exclude interruptions, unhandled errors and
file/setup errors. Historical worker output stays diagnostic evidence only.

The single-slot recovery incident uses the same 750 ms delay after observing
first output and before interrupting the relay on both bases. The memory-warning
incident uses 6650 ms before each command on both bases, retaining its 20-second
case deadlines and all three command variants after the fixture split. These
temporary observation conditions preserve assertions and production code. Other
reported tests run unchanged. The completion reporter must witness the injected
observation on both bases. A passing old case cannot prove a shared failure.

The existing report saves intent before checkout or execution and retains the
outcome. Restart, repeated observations, an interrupted attempt or a newer base
cannot relaunch that recheck. Checkout and each dependency install have a
120-second bound, each suite a 90-second bound, and Git reads a 30-second bound;
suites use one worker without retries. An unverified correction or failed recheck
states its blocker on the existing hold. A successful recheck feeds the same
single-retry admission below, with source, publication, resources, controls and
the pinned corrected base checked again after preparation. The new implementation
still runs normal full required validation, review and CI.

The automatic hold carries its original journal sequence. An operator Hold,
including one with identical text, removes that recovery identity. The existing
resume event retains the delivered recovery commit and original hold identity;
normal invocation admission durably consumes one fresh implementation allowance
before launch, even after three prior attempts. A restart between recovery and
admission preserves it. Duplicate observations, newer main commits or passing
reruns cannot replenish it after a failed replacement. Ordinary operator Resume
retains its existing retry policy. Original review evidence, reports and receipts
remain unchanged; resource, provider, review and publication gates still apply.

Merged `merge-pr` and `resolve-threads` uncertainty uses original journal
receipts only. A missing original response schedules no GitHub read; retaining
that response makes its original settlement eligible without another mutation.
Observe → Tasks and API/status summaries show the scheduled evidence check or the
missing original response. Intentionally deferred observation is not a
collector outage, and old GitHub facets remain unverified. The chain summary's
`reconciliation.nextObservationAt` is epoch milliseconds (`0` means eligible
on the existing pass, `null` means no GitHub check is scheduled), with a separate
`waitingForOriginalResponse` flag. The optional `waitingForResourceRelease`
flag identifies merged model ownership whose native resources remain
unverified. Its GitHub observation time is null even though native receipt
reconciliation remains immediately eligible on every pass, including when the
invocation is uncertain. It is not a missing original merge/resolve response.
No timer, independent execution ledger or
new completion control is added. Old duplicate events are preserved; this fix
does not shrink accumulated history or rewrite historical hashes.

The existing authorized HTTP API supports interactive and headless controls: `GET /api/behavior-chains`, optional `state=active|merged`, cursor `after`, or `id` with an event-sequence cursor; `POST` accepts `id`, current `sequence` and `operation=hold|resume`. Cutover controls instead send the current cutover `sequence` and `operation=switch-to-v2|cancel-cutover`. Reads include `cutover` (mode, sequence, request time, recorded legacy targets and current drain blockers). Summaries/events are paginated. Stale writes fail instead of overwriting a later decision.

## Handoffs and outcomes

An implementation or repair that explicitly reports a blocker records
`atomic_work_blocked` and holds its chain with that reason. Caller masks
credential patterns and known environment credentials before normalizing and
limiting the explicit string reason to 500 characters plus a truncation ellipsis.
The exception and retained diagnostic use the same safe message. Before deriving
that summary, Caller retains up to 4096 redacted reason characters plus an ellipsis
in the existing diagnostic `stderr`, with `stderr_truncated` when clipped, within
the 64 KiB diagnostic event limit. Workers put the first observed actionable
assertion/failure excerpt, suite/test and available relay captured-candidate digest
and producing-run ID first in `blocked`, before a later timeout explanation. Missing
assertion details or identities are explicitly unavailable. This worker-reported
evidence survives checkout reclamation; a later relay timeout cannot excuse an
observed test failure. Empty or unsupported reasons retain `AtomicWorkBlocked`.
Ordinary exception text and raw provider output remain excluded from native failure
evidence. The reason grants
no retry or resource-release authority. Cleanup still
requires its original positive proof and does not restart blocked work. The
hold survives journal rebuild and server replacement; the person can resume
through the existing control after resolving the blocker.

1. Each configured issue-review slot must finish successfully and its native receipt must identify an actually posted comment on the current issue revision. Before a new implementation, the authenticated Caller seed read must expose complete live same-repository GitHub `blockedBy` evidence; the mirror health gate still applies. This bounded connection is read again after awaited request preparation, immediately before admission, because dependency changes need not change the issue timestamp. A verified empty connection permits the ordinary path; absent or truncated evidence waits visibly. Each recorded prerequisite waits by issue number until it is closed and a linked closing PR's merge commit is verified as an ancestor of the observed implementation base. Closing an issue, queueing a PR or merging only into another branch is insufficient. The ordinary chain sweep rechecks this dependency wait without admitting a worker, recording an execution failure or creating a remediation issue. Existing holds still require Resume. No elapsed review delay authorizes implementation.
2. Implementation reads the actual issue and comments, makes real changes in a fresh checkout and runs the repository's checks. After the model ends, Caller's publication primitive re-verifies those same live prerequisites on the prepared candidate base before the first push; a new unresolved dependency or incomplete evidence settles as a no-write `prerequisite_wait` deferral with the dependency recorded, so the ordinary wait above re-admits on a suitable base without Resume or failure-budget consumption. Otherwise it commits, pushes and opens the linked PR. Commit trailers and the PR's chain marker preserve artifact identity across lost responses. An already pushed branch still reconciles through the existing recovery.
3. Fresh exact-head evidence of an actual branch conflict selects the existing scoped repair before PR review, after invocation, hold and queue guards. Clean or merely behind branches still receive the configured current-head reviews first. Repairs use a fresh model invocation and the actual review packet, CI evidence and branch state. They publish code and substantive model-written replies to original findings. A new head requires fresh reviews and approval. An unchanged-code repair still requires independent approval verification.
4. Existing native primitives handle grey CI, approved nonblocking conversation resolution, strict readiness, merge and merge-queue admission. Conversation resolution also covers outdated threads, because GitHub's merge rule counts them, but only when readiness is blocked solely by `merge_state_not_clean` or `required_reviews_not_approved`, the blockers an open conversation can explain. A PR that readiness reports green goes to merge with its outdated threads left alone. Their repository policy leaves a merely behind branch to native queue integration; an actual conflict still requires repair. Completion requires the actual GitHub merge SHA. Queue admission, a finished turn, approval or CLOSED alone cannot complete a chain.
5. A removed queue entry requires its actual GitHub removal event. Failed integration checks or conflicts lead to fresh repair; manual or unknown removal holds for a decision. A `merged` removal alongside an earlier open-PR read waits for confirmed merge evidence; that event alone neither completes nor holds the chain. An unchanged-head repair requires a new independent approval before another native queue attempt. Only that attempt's actual integration result can establish acceptance. Deliberate dismissal of a current-head managed approval is also held.

Live queue observations retain the entry ID, GitHub disposition and nullable
integration base/head commits together through `pull_action_state --queue-evidence`.
Exhausting its three head-matching reads fails rather than attaching another
head's queue disposition. Work status keeps queue membership and original enqueue
attribution while showing `UNMERGEABLE` as `blocked`, with cause unknown. This is
a queue wait, including when PR mergeability is `UNKNOWN`; it does not diagnose a
conflict against current main or authorize repair or dequeue. Delayed entries use
the existing 24-hour history progress clock to request attention; unchanged polls
do not reset it. Replaced integration evidence supersedes the prior observation.
After a verified removal, the ordinary exact-head repair, CI, fresh review and
independent approval gates govern readmission.

The chain intentionally does not use the legacy approval-round escape that files remaining findings as a follow-up issue and approves. Unresolved blockers remain blockers.

## Authority and recovery

`behavior_chain_events` is immutable. It owns admissions, phase progression, retry history and ownership. `behavior_chain_current` is a rebuildable index whose state is checked against the authoritative event hash. Admissions and projection updates commit together with SQLite FULL durability. Existing observational behavior ledgers do not authorize this executor.

Projection rebuild preserves historical invocation hashes across the resource-admission upgrade. Older admissions omitted `reservation` from their state; resource-era admissions can retain it as null even when their payload omits it. For that omission only, replay selects the representation matching the original immutable hash. It never rewrites events or accepts a hash mismatch. An admission with no reservation evidence remains unaccounted live ownership and blocks bounded resource admission until its resources are proven settled.

Admission-mode transitions use `admission.changed` events under the reserved `@behavior-admission` journal identity. They share the immutable log and hashes but are not fabricated issue chains and do not appear in chain pages. Rebuilding chain projections verifies and preserves this durable admission state.

Native Call rows and immutable action plans record effect intent before controlled publication. They provide execution evidence to the journal, not a second phase controller. Unique native correlations prevent duplicate processes from executing the same admission. Worker resource settlement is required before a handoff; a terminal model result is insufficient. A restart or interrupted process is reconciled against the original invocation, pushed branch, posted comments and exact-head review receipts.

Verified Codex sign-in recovery can retire issue-review retry accounting through
the existing journal resume event. Every affected attempt must belong to that
credential-rejection episode, prove `not_started` / `preflight_failed`, retain
`receipts=null`, and have positively settled resources. Only the matching
automatic three-failure hold is resumed; operator holds, other failures and
uncertain publication remain held. A bounded page of these automatic holds is
checked before their ordinary observation cadence, without another GitHub read.
The provider's fresh recovery allowance is consumed by the existing reviewer
probe admission, so repeated recovery reads cannot launch another probe.

Native request digests use Caller's recursively sorted JSON encoding.
Journal event/state and plan hashes keep their original serialization, while response
digests verify the original retained bytes. These are separate contracts;
reconciliation never rewrites historical events to make a digest match.

When reconciliation confirms that an uncertain original Call has no durable
publication plan, its invocation retains one `original_publication_plan_missing`
condition in `invocation.reconciled` evidence. Repeated absence, including after
runtime replacement, keeps that episode while due reads continue. Logging shows
the original Call, the evidence gap and the action to restore its original Caller
plan. A matching Call, digest and validated plan records recovery; a different
read, parse or validation failure remains an observation error and cannot clear
the condition. Absence and recovery change neither the hold nor uncertainty,
ownership, resource-release proof or publication gates, and authorize no retry
or inferred no-action receipt. Unrelated chains continue advancing.

An uncertain fixed action retains its first verified response and digest in
the same journal, so unchanged passes and projection rebuilds do not launch
another response reader or repeat uncertainty events. Observation-based recovery
of grey CI or publication preserves the original physical Call, failure and
resource-release evidence; confirming an effect cannot discard cleanup proof.

Log-read recovery never releases native resource ownership from parent death or
a new container epoch alone. A release timestamp paired with an active cleanup
error or unknown-resource phase is contradictory and stays quarantined, keeping
the original reservation. The native finalizer preserves the first recorded
settlement time; process lifecycle and verified cleanup remain separate facts.
Caller records native resource ownership separately from publication artifacts.
Registration precedes allocation and appends across recovery attempts. The
issue/atomic root and every PR checkout, provider and watch directory have
pinned filesystem identities. Native issue, atomic and PR work uses one private
per-Call parent under Caller's data directory, outside the legacy age sweeps;
temporary credential copies remain inside those registered roots. In service
mode that directory is on the home volume and survives restart and recreation.
Normal cleanup uses directory descriptors, records positive reclamation and
retains the original failure plus an explicit covering recovery time on a
successful retry. A failed proof write, absent/replaced root or unknown process
inspection retains ownership. Historical v1 receipts retain their path-scan
veto; physical v2 Calls require the original kernel scope's positive idle/empty
proof. Neither grants numeric process-group signal authority. Process uncertainty is independent of
replaceable phase fields and cannot be cleared by a later publication phase.

The existing decoder checks these receipts before native settlement. Active
invocations with older missing ownership remain uncertain; a timestamp alone
does not release them. Contradictory releases already copied into historical
events re-hold derived capacity, including after merge, without rewriting any
event or hash. A one-time projection/index migration preserves bounded capacity
and reconciliation reads. Ordinary settled historical receipts stay readable.
Uncertain native receipts retain their original Call evidence and the cleanup
cause/path for inspection. Publication continuation requires the same positive
resource predicate and an originally unattempted reply batch.

The supported physical v2 boundary establishes descendant ownership, as defined
in the service contract above. Same-supervisor claimed recovery now reclaims
positively owned roots through existing maintenance, including new native
checkout coordination and isolated Codex/Muse history inside those roots.
An unreadable identity, incomplete proof or a new epoch without positive
original lifecycle evidence stays held. Removing a named
directory is not a supported way to manufacture a release. A one-slot lane can
remain held after such a failure; loss of the original witnesses does not
guarantee eventual reclamation. #822 (`17d06d9f`) delivered native lease and
Codex-history reclamation with explicit retention of older shared state;
#824 (`11331d75`) delivered execution limits. #806 remains open for complete
resource-lifecycle proof and the frozen matched real fault/load campaign,
including repairs at every concurrency level and unexercised provider/platform
cases. Later fault/repair cohorts cannot fill a frozen candidate's missing cells.
The [retention policy](Operating.md#storage-maintenance) keeps older
shared metadata/history measured and protected; it does not establish zero
provider residue or complete resource readiness.

Known closure blocks all new model requests, worker launch/relaunch and repair
publication continuation. A durable merge stays closed when a later observation
has no PR; a closed PR blocks all model behaviors, and a closed seed also blocks
issue review, implementation and repair. A never-started admission with no
conflicting or quarantined Call settles as deferred `target_closed`, with
explicit no-effect evidence and no failed-attempt charge. A started original
with no Call becomes `uncertain`: a partial receipt-store recovery can lose the
unique correlation that once protected it. It cannot be relaunched or given a
synthetic no-effect fence, even while held or disabled. Unreadable receipt
snapshots also journal this uncertainty before reconciliation resumes.
An existing Call is never altered, and normal validated receipt reconciliation
must prove release. [Receipt-store recovery](Operating.md#caller-receipt-store-recovery)
defines preservation and activation requirements.
The receipt reader accepts only the fence's exact no-provider, no-publication
shape with its native resource-release timestamp. Other superseded outcomes
retain their original validation; malformed fence rows stay quarantined.

Original artifact/receipt adoption continues while paused or held. Incomplete
publication after closure is held once; complete original comments, reviews or
replies can still settle through read-only observation. Native exit or
quarantined uncertainty is retained. A running Call, or a terminal Call without
resource-release proof, keeps its existing cleanup owner and reservation; no
new stop or signal is sent. Closure first seen after that running worker ends
is not a retroactive guarantee about its in-flight publication.

The publication primitive validates the checkout and model-written metadata in
read-only mode before Caller records its write intent. Invalid commit subjects,
PR titles, issue-closing references or reply targets fail as unstarted work,
rather than becoming ambiguous writes that never occurred.
PR title and body checks apply only when creating a PR, including first-PR
completion after an interrupted publish. Repairs retain the required proposed
title/body fields for the atomic plan but preserve existing PR metadata; their
unused body does not undergo the issue-closing check.
Validation and publication both return the existing no-write `superseded`
outcome when GitHub confirms that the original owned PR merged at the repair's
unchanged head, before rejecting a closed seed. The receipt retains the verified
PR head even after branch deletion. The existing chain settles it only after
resource release and records the observed merge. Unverified closures,
ownership mismatches, contradictory evidence and unavailable reads remain
errors with bounded, redacted v1 `caller_diagnostic` evidence identifying the
failed check; arbitrary stderr remains inadmissible.
After retaining the atomic plan, Caller records `preparing_publication` until
the publication helper durably changes it to `publishing` before push or replies.
A failed original still at that no-write checkpoint can become
`not_started` / `preflight_failed` only after resource settlement; the journal
then applies normal admission and backoff. A `publishing` receipt, local commit,
plan digest or unstarted replies cannot prove that push was unattempted. Without
an attributable pushed head, the existing wait names the missing original
pre-push checkpoint or conclusive push result and retains the original fence.
The plan contains metadata, not a replayable checkout. Closed-target
reconciliation still forbids late publication and retains pending review evidence,
including when a parent of an uncertain repair commit has merged.

PR review and approval deadlines retain `failed` and their timeout code. Caller
records `not_started` / `preflight_failed` only when the original durable phase
is still `reviewing`, no publication receipt exists, and a successful recovery
read validates the target/head and complete, unchanged reviewer inventory with
no pending review. A diagnostic alone cannot supply that proof. Native
settlement also matches the admitted PR/head, rejects contradictory receipts or
submission phases, and waits for positive resource release. Ordinary backoff
then permits at most three failed attempts before an explicit hold, retained
across restart. Failed or incomplete recovery reads and an attempted POST keep
the original effect fenced for receipt reconciliation; cleanup cannot promote
them to no action.

Durable model admissions use the existing semaphore's behavior-lane ceiling, including its interactive reserve. A fresh server process cannot fill that reserve with another background invocation merely because surviving workers hold no slots in its new in-memory semaphore. Existing work above a lowered ceiling finishes normally while new admissions wait. The journal's capacity check also precedes provider preparation, so waiting work cannot consume a provider recovery probe without launching; admission still rechecks capacity transactionally afterward.

Provider-backoff waits are journaled on entry, when the reason changes and after
Resume. Unchanged polls still check provider recovery without another waiting
event; an admitted invocation clears the wait for a later episode.

Resource-aware admission (#731) extends that boundary with memory/disk budgets instead of another scheduler. Each admitted native invocation holds a durable reservation covering its whole tree, including provider children and build/test descendants; the count and budget checks run in one journal transaction, so concurrent admissions cannot double-spend. A synchronous free-memory/free-disk probe guards the same boundary before provider preparation and again before spawn, and fails closed with an explicit reason. Blocked chains wait with that reason and no agent process, waking through the existing release paths. Verified settlement releases a reservation exactly once; cleanup uncertainty and pre-reservation live invocations retain or block it. Budgets and reservations are environment-only (`POISE_BEHAVIOR_MEMORY_BUDGET_BYTES`, `POISE_BEHAVIOR_DISK_BUDGET_BYTES`, `POISE_BEHAVIOR_MEMORY_RESERVATION_BYTES`, `POISE_BEHAVIOR_DISK_RESERVATION_BYTES`); unset means unbounded and production behaves as before. Deletion authority stays with the Caller sweep's ownership proofs.

A configured cgroup memory limit requires a readable, nonempty current-usage
counter. Missing usage cannot masquerade as zero.

For new bounded admissions, each bounded dimension's reservation is also its
sampled execution ceiling. The immutable request records explicit null for an
unbounded dimension, includes the limits in native arguments and binds fixed
actions/publication continuations through their request digest. Later environment
changes cannot enlarge that booking. Older admissions remain unenforced; they
never acquire a fabricated measurement or new execution limit.

The original outside Caller samples on one thread, at most once per second,
while its existing wait loop handles Stop and deadlines. No tree walk runs on
Poise's or the shared supervisor's event loop. Its pinned private procfs covers
the namespace plus the original owner and holder. Charged memory is Linux PSS
where `smaps_rollup` exists, otherwise RSS. RSS deliberately charges shared fork
pages repeatedly; neither model includes kernel/sentry/page-cache overhead.
Allocated blocks under pinned disposable roots and regular open-but-deleted
files, including Caller spools, are deduplicated by device/inode. Deleted target
names count even when runsc still reports one link. A deleted mapping lacking an
open allocated-byte counter makes coverage partial. Tmpfs allocation counts as
disk; it is not added again to process memory. Symlinks are not followed. Known
build caches use disposable paths; closed files in arbitrary shared user caches
and inode quotas are outside this byte counter.

The process counter pass validates membership before the independent pinned
filesystem walk. A child born during that later walk belongs to the next
process sample; it does not invalidate the earlier counters. A process change
during the process counter pass still makes coverage partial. The counters
are sampled across an interval, not one atomic memory/filesystem snapshot.
An exit or changed membership during that pass gets fresh reads within the
same one-second sampling opportunity, with a short pause after the first retry
to avoid busy spinning. Only a complete successful read refreshes
coverage; persistent races and inaccessible counters retain the five-second
fail-closed rule. The retry starts no process and grants no cleanup authority.

A complete sample over its ceiling, or five seconds without a complete sample,
commits the first typed cause before immediately killing the original pinned
holder. A stalled read names its current measurement stage in that cause.
There is no five-second grace for a resource breach. The chain is held;
ordinary Stop, timeout, completion and reaping preserve whichever cause/result
committed first. Publication remains guarded and original accepted/uncertain
action receipts are retained. Ownership and cleanup failures stay separate from
the bounded `resource_guard` measurement summary; release still requires positive
process and disk receipts. Older consumers retain a possible-write failure rather
than automatically retrying a breached preflight. Resume requires correcting the
workload or reservation, then an explicit decision; it does not expand old limits.
Brief SQLite contention defers summary persistence without terminating healthy
work. A stop receipt that cannot commit within 1.5 seconds fails closed as
receipt-unavailable through the original scope's teardown; it cannot certify a
first cause or no-write result without that commit. Missing signal-timing
annotations remain unavailable rather than zero. Proven failures before native
scope creation retain their existing no-worker receipt and release path.
When that optional annotation is unavailable, the component check requires the
existing independent positive-empty observation within the same two-second bound;
this proves completion, a stronger requirement than stop initiation.

The admitted model request also includes these immutable ceilings in its existing
behavior note. The provider must bound test/build parallelism, starting with one
worker when a runner otherwise follows host CPU count, while preserving every
required check and assertion. This guidance grants no authority to change the
ceilings or enforcement; the original resource guard still stops a breach.

These are sampled soft ceilings, not hard kernel quotas or a guarantee against
instantaneous allocation. Component proof uses 256-MiB memory and 8-MiB disk
ceilings, at most 64 MiB/s memory and 2 MiB/s disk growth, at least 1 GiB of
outside-measured headroom and a live independent neighbor. Its frozen overshoot
allowances are 192 MiB memory and 8 MiB disk, with stop initiation within two
seconds and positive namespace emptiness within ten seconds of the first complete
breach sample (monotonic completion time). The separate 180-second reclamation
bound remains unchanged. These component checks do not establish real-provider
campaign acceptance or forced-container recovery.

Known failures before publication retry with bounded backoff and existing provider fallback. After two settled native repairs on the current head, repair basis and selected model exhaust their execution budgets before publication, the existing third attempt uses the first eligible alternate in the configured repair candidates. Both original Calls must prove resource release and no publication. With no eligible alternate, ordinary selection remains. The original slot, basis, budget and three-attempt window survive model selection and restart; an alternate timeout reaches the existing hold/report path without a fourth automatic Call. This changes no global provider trip. Ambiguous writes retain ownership. Confirmed actual artifacts can settle a lost response; missing receipts cannot justify another write. Partially published review/reply plans that cannot be fully reconciled remain uncertain and visible. They are not silently retried or reported successful. This limitation must be exercised and resolved if encountered in the real validation runs.

An implementation or repair provider that reaches its execution deadline records
`atomic_work_execution_budget_exhausted`. Its v1 diagnostic retains the provider,
execution phase, measured elapsed milliseconds, actual seconds allowance and
seed issue/PR/head, without command arguments or provider output. Caller keeps
`not_started` / `preflight_failed`; the chain retains the diagnostic and exposes
the specific cause as its invocation outcome in History. Preparation timeouts
remain distinct. Retry still requires positive resource release and the existing
same-basis backoff; three failures hold the chain across restart until **Resume**.

Repair prompts receive `change_request_reviews` from the native
`github-interface --pr-review` packet, even with no inline roots. The read selects each
author's latest effective review (`APPROVED`, `CHANGES_REQUESTED`, `DISMISSED`),
then includes only substantive change requests on the expected head, with their
original body, review ID, author, commit, submission time and URL. A later
`COMMENTED` review does not retire a request. Summaries share the packet byte
limit; an overflowing packet or failed review read fails visibly. The final
head/base recheck and independent approval verification still apply.

Repair prompts name the exact unresolved root comment IDs from the head-verified
review packet, including outdated threads and roots with earlier replies.
Caller requires that same set before publication. After checking the repaired
code and current reviewer input, a repair can carry a still-applicable native
reply verbatim, including its original `poise-reply` marker, in the existing
`replies` plan. The publisher verifies the reply's author, root, exact body and
marker against paginated GitHub comments and returns its existing receipt.
Reviewer edits or follow-ups on that finding require a fresh answer, as do new
findings or materially changed answers; a new Call/head or unrelated finding
does not invalidate reuse. Prior replies remain in the current-head review
packet and durable publication plan. Inspection/recovery verifies their proof
again; missing or altered proof fails visibly and cannot count as coverage.
Reuse changes neither exact-head review/approval nor conversation-resolution
gates. Missing coverage records
`atomic_work_failed`, `not_started` / `preflight_failed`, with the missing count,
required count and at most 20 sorted missing IDs in the retained error field;
comment text is not retained there. No publication plan exists at this point,
so recovery uses fresh repair attempts, not publication completion. Three
same-basis failures exhaust the existing attempt window and hold the chain.
The hold survives deployment, restart and changed head/findings. After deploying
the fix for incomplete reply instructions, use **Resume** on the already-held
chains for `autonomio/poise#893` (seed #887) and `autonomio/poise#900` (seed #896).
Resume opens a new bounded attempt window using the current head and findings;
it does not repeat an uncertain publication or release unsettled resources.

An independent reviewer can explicitly verify its own answered findings on
the current head while requesting changes elsewhere. After GitHub accepts
that review, Caller rechecks the PR context and each selected thread's exact
revision before resolving it without another reply. Changed threads and
reaffirmed blockers stay open. The original review Call retains resolution
attempts and acknowledgements separately from the submitted review. Merge
still requires current-head approval, green checks, and resolved conversations.

A repair push checkpoints its exact native head before bounded PR-head
confirmation. If GitHub's PR projection still trails the push, the existing
reconciliation pass can complete the original immutable reply plan once the
head is confirmed, the target remains open and worker resources have settled. The canonical journal
records this continuation before Caller acts; no replacement model starts.
Caller reserves the reply batch before its first POST. A lost or partial
reply POST remains uncertain unless every original reply is found on GitHub;
absence never authorizes another POST. Older receipts without an explicit
unattempted checkpoint do not acquire this recovery authority.

The executed publication helper verifies its original controller and PID
namespace, its direct Caller parent and the absence of any other worker before
reserving replies. It cannot inherit an in-memory Python scope across exec.
Only extra namespace members receive the existing two-second settlement window;
each controller read is bounded by the time remaining. Reservation requires
exactly PID 1, PID 2 and the original helper. Identity mismatches, persistent
members and namespace read timeouts or I/O failures retain distinct bounded
reasons through the existing diagnostic, with replies still unattempted.
After a repair publishes the current head and all required fresh reviews
complete, answered conversations proceed to independent approval rather than
another repair solely because the original thread is still unresolved. A new
change request, failing CI, conflict, base update or changed seed still requires
repair; approval and native conversation resolution retain their own gates.

A queue repair can retain a shared baseline CI dependency in its existing
Caller artifact (`ci_dependency`), instead of editing unrelated baseline code.
The worker's `ciDependency` output must identify the exact candidate, latest
queue removal, failed merge-group commit and its base, failing check/run,
existing remediation, and a specific cause excerpt verified in both integration
and exact-base job logs from the same workflow. Green PR checks, another PR's
failure or a remediation link alone provide no such proof. Comparison copies of
the excerpt and both logs remove only ANSI SGR styling; matching stays literal,
the raw excerpt size bound and original evidence stay intact, and the 20-character
minimum applies to visible text. Missing evidence
remains unresolved; candidate-specific failures still require normal repair.

An unchanged, verified shared failure settles as `no_changes` with that
dependency, without publication or a durable hold. The normal tick retains the
candidate/check/remediation in its wait reason and rechecks the current base's
latest matching workflow checks. Missing, pending or failed checks keep the
wait; remediation closure or merge does not release it. Operator holds retain
their authority. Recovery re-observes the current candidate and passes the
normal exact-head reviews, independent approval and fresh native merge-group
gates. Current heads retain their own review/CI obligations; a new queue
rejection needs its own diagnosis. Mixed repairs may
publish candidate fixes while retaining the verified shared dependency.
When every failure is shared and no candidate CI, review or conflict blocker
exists, Caller retains only the dependency, even if the worker proposed edits.

An uncertain grey-CI rerun is inspected through the existing native command in
read-only mode. A later attempt of that exact workflow/head settles its original
admission; an unchanged attempt remains uncertain. A confirmed preflight read
failure is a failed, unstarted action and retries with the existing backoff.

## Reporting verified repair exhaustion

Reporting is off by default. An operator can set
`POISE_REPAIR_EXHAUSTION_REPOSITORIES` in Poise's environment to a comma-separated
list of explicit `owner/repo` names, up to 8192 bytes so the workspace can echo
it in health for gateway reconciliation. Enabled v2 chains check both new and existing
repair holds, automatic implementation holds before a PR, uncertain implementation
publication, and uncertain merge
submissions during their ordinary bounded reconciliation, including open `poise`
seeds whose only PR closed unmerged; no Resume or extra poller is needed.
Creating a report preserves the source hold, uncertainty and ownership. A verified
repair-exhaustion report can subsequently hand an actionable diagnosis to the
source chain's existing `repair-pr` owner; other report causes keep their existing
behavior.
The initial report body includes a dated snapshot of the same
[verified work impact](Logging.md#native-logging-view) used by Logging and existing
Notifications. It names the work, stage, last verified progress and known retry or
action, with journal evidence linked on the owning workspace when its service
origin is configured; local reports retain the workspace-relative journal path.
These destinations retain their normal access checks. Missing or unavailable
optional annotation is explicit and cannot prevent an otherwise eligible report
from filing. Later recovery never rewrites the snapshot or files another report.
In service deployments, set it in `deploy/.env` or as a fork's Actions repository
variable. The gateway reconciles it through trusted service configuration on
compatible running workspaces, including when image and release already match.
Adding, changing or removing it needs no restart or container replacement and
does not disturb native cleanup holds. Explicit empty durably overrides a legacy
container environment after Poise restarts. Local mode keeps environment-based
configuration. Unset or empty opts out.

Native repair and PR review exhaustion reporting requires at least three settled original Caller
receipts for the same phase, current head, review basis and slot after the last
Resume, each with positive resource release, `action=not_started`, retained
`outcome=preflight_failed` and no
publication plan or action receipts. All matching repair attempts must share one cause:
`repair_incomplete_replies` requires `error_code=atomic_work_failed` and the specific
incomplete-reply error; `repair_execution_budget_exhausted` requires
`error_code=atomic_work_execution_budget_exhausted`.
The historical fixed message and the newer omission-ID/count suffix represent
the same cause. Hold text and generic failures cannot establish eligibility.
The reporter also accepts `review_budget_exhausted` and `review_inspection_timeout`,
including file-group deadlines and a mixture of the two codes, for native `review-pr`
admissions by the reviewer account, pinned with `--expected-head`. Their basis
includes `reviewContext` (base SHA, title and body), distinct from repair's
`reviewRevision`. Each original receipt must retain the pre-submission `reviewing`
phase and one of those timeout codes; differing raw messages do not change their
typed causes. An automatic three-attempt hold with exactly two of those timeout
receipts and one `review_provider_exit` or `authentication_failed` receipt on the
same head, basis and slot also qualifies, in any order, when the provider receipt
retains the same `reviewing` phase, no-submission proof and a structured diagnostic
with `submission=none`. The mixed report reuses the same review intent, marker and
title, lists every original code with bounded operation, phase and timeout, names
the last timeout's diagnostic phase and the terminal attempt separately, preserves
the source hold and grants no retry or recovery authority. Each report lists the
original code for every attempt and bounded diagnostic operation, phase and timeout
in seconds where retained. Missing step evidence stays unknown; raw errors, paths
and inspection arguments are excluded. All three codes reuse the existing review
report intent and marker. `submitting_review` cannot prove no action even without
a returned review ID.
Native `approve-pr` deadlines use the same two timeout codes, reviewer account,
`--expected-head` pin and `reviewing` phase, but their approval basis carries
`reviewRevision` and their durable automatic hold must match the approval
exhaustion. They file a distinct `approval_budget_exhausted` report intent and
marker; an earlier review report never covers a current approval hold.
Before first reporting, the existing datastore freshness gate must pass and a
new native observation must still require the same phase on that head and basis.
Stale, unknown or changed findings, heads, PR review contexts or approval bases
leave reporting pending, including title, body or base changes on an unchanged
head. Other causes remain visible in their ordinary holds without an issue report;
mixed repair causes, provider-only review episodes, other provider codes, or
review causes outside these two timeouts and the mixed provider pair cannot
qualify. Operator or ambiguous holds cannot qualify; only the automatic
three-attempt hold on the same basis reports. Closed or merged targets remain
ineligible for a new review or approval exhaustion report.
Revoking repository scope during verification prevents publication and leaves the
creation intent unconsumed, so re-enabling can still report once.

Repair-exhaustion recovery matches the saved automatic hold event, open source
PR, exact head, repair basis, slot and original no-publication/resource-release
receipts. Ordinary implementation and publication of that report issue are
fenced, including admissions from before this routing existed. An already-started
report implementation must settle with its original blocked, no-publication
receipt and released resources. Its retained, untruncated Caller diagnostic must
name the source PR, pinned head and a concrete code location. For a report with no
implementation, a settled native issue-review receipt and its actual posted
comment must supply that diagnosis. Creation, labeling, review completion or
closure alone cannot admit recovery. The explanation remains worker-reported;
the source repair verifies it.

The original seed and branch remain unchanged. The existing `--note` carries the
diagnosis, original Call, report reference and configured accounts' report guidance
into exact-head repair preparation. The existing journal retains one recovery
admission without resetting the original retry boundary. Source, diagnosis and
operator holds are checked again after provider preparation; missing or changed
evidence keeps an actionable wait. A failed or deferred recovery cannot admit
another attempt after restart or repeated report observation. Explicit Resume
retains its operator meaning. Publication, validation, review and CI use the
ordinary source PR gates. This admission is separate from the bounded alternate
model attempt; report deduplication and recursion suppression remain unchanged.

Legacy review and approval ticks also report retained automatic retry stops in
opted-in repositories, before checking model readiness and with v2 disabled.
Their existing two same-head/model timeout policy is unchanged. Reporting requires
the exact retained Call and correlation, behavior and target, two unambiguous
no-submission timeout receipts with settled activity, and fresh datastore and
native PR evidence. Each attempt's pinned review context must still match;
closed or changed targets, published or pending reviews, live successors,
explicit retries and cleared or ambiguous holds exclude creation. The report
lists original Calls, retained timeout steps (unknown when unavailable), the
retry-stop cause and explicit retry action. It uses the same durable publisher
and reuses an existing PR review report across legacy/v2 ownership changes,
including an unconfirmed creation intent. Reporting never changes the source
hold or PR and does not enable v2 intake.

Before a PR, `atomic_work_blocked` separately qualifies one settled original
`implement-issue` receipt after the last Resume. The current durable automatic
hold must match that receipt's blocker; a later operator Hold excludes it.
The receipt must retain `status=failed`, `action=not_started`,
`outcome=preflight_failed`, the pre-publication `executing` artifact and positive
resource ownership/release proof, without a publication plan, result or receipts.
A fresh open seed and native inspection must also verify no pushed branch,
bound PR or competing linked work. Poise rechecks the hold before reserving intent.
In label-based intake, the live source must still carry the configured intake label
before a report is created or an existing report is relabeled. Unverified eligibility
leaves reporting pending without consuming new intent; published reports and the
original hold and receipts remain retained. All-issues intake is unchanged.
Ordinary retries and unknown original effects do not qualify. The report includes
the bounded, redacted blocker as **worker-reported** and available structured Caller
diagnostic facts. Caller's blocked result does not independently verify the worker's
health-check, test-relay or other runner explanation. Its next action is to inspect
the original Call, remedy the blocker and explicitly Resume for a fresh implementation.
The same report exposes [private validation-time source evidence](../caller/agent_interface/README.md#inspecting-failed-unpublished-source)
when retained, or explicit unavailability requiring a fresh reproduction. This
inspection preserves the earlier failed capture independently of later untested
edits and grants no publication, retry or approval authority.

While reporting remains unfinished for the current automatic pre-PR hold, the
existing deferred scheduler rechecks at `checkedAt + 2 minutes`, regardless of
implementation age. This covers verification before reservation and reconciliation
of an unconfirmed creation intent without another POST. A verified report or terminal
disposition returns to the ordinary quiescent cadence; operator holds retain it.

These pre-PR implementation-hold reports require explicit triage before their
own implementation can prepare or start. A posted issue review alone cannot
authorize implementation. Through the existing guarded `/api/behavior-chains`
control, the workspace owner records `source-only` or `distinct-fix`, with a
diagnosis and next action. Read `GET /api/behavior-chains?id=OWNER/REPO%23N` for
the report chain's current sequence and `implementationReport` binding, then
POST `{ id, sequence, operation: "report-disposition", binding, disposition }`.
`binding` is that exact read value. `disposition` contains `kind`, `review`
(the settled native issue-review invocation ID), `commentId` (its posted receipt),
`diagnosis` and `nextAction`. Triage must identify an independently implementable,
verified defect to select `distinct-fix`; source-candidate-only failures select
`source-only`. The control verifies the publishing account and report marker,
the reviewed title/body revision and native posted-review receipt, the source's
exact original hold event and Call, and configured ownership. It persists the
disposition inside the existing report intent and records the diagnosis and next
action on both chains. Labels, comment wording and closure supply no disposition.

At implementation admission, missing or stale dispositions wait visibly, even
when new report publishing is disabled. `source-only` leaves the source held and
starts no report implementation on main. Checkout availability remains explicitly
unverified; disposition does not depend on retaining the unpublished checkout.
Only a current `distinct-fix` can pass through the ordinary implementation gates.
Admission freshly verifies the original source's open state, no-publication and
resource-release evidence before and after awaited preparation, and guards the
source journal revision atomically with admission. Resume, a replacement Hold
(even with identical text), a different failed Call, changed report revision or
new source publication invalidates the old binding. The report link and generated
issue recursion guard remain retained. No disposition retries the source: later
source work still requires existing verified recovery or explicit Resume, original
no-publication/resource evidence and absence of competing work.

Before a PR, `implementation_execution_budget_exhausted` separately qualifies three settled original
`implement-issue` timeout receipts after the last Resume. Each must retain `status=failed`,
`action=not_started`, `outcome=preflight_failed`, `error_code=atomic_work_execution_budget_exhausted`,
the pre-publication `executing` artifact and positive resource-release proof, without a publication
plan, result or receipts, on the current seed revision, actor and slot. The durable automatic hold
must be the exact three-failure hold for the last receipt; a later operator Hold excludes it. A fresh
open, eligible seed must still verify no pushed branch, bound PR or competing linked work. Its identity
is the new cause plus the source chain. It uses the same explicit triage and admission gate with its
three original Calls; missing or `source-only` waits, only a current `distinct-fix` passes. A single
timeout with retry remaining and any write evidence do not qualify.

PR review deadline reports (`review_budget_exhausted`, legacy or durable) require
the same triage before their own implementation can prepare or start. A posted
issue review alone cannot authorize implementation. Read `GET
/api/behavior-chains?id=OWNER/REPO%23N` for the report chain's current sequence
and `reviewReport` binding (`key`, `source`, `pull`, `head`, `holdSequence`
— null for legacy PR-scoped reports, the hold event for durable chain reports —
`attempts` as invocation/call pairs, `revision`, `disposition`), then POST the
same `{ id, sequence, operation: "report-disposition", binding, disposition }`
with that exact binding value. `implementationReport` keeps its single
invocation/call shape for pre-PR reports. Triage must identify an independently
implementable, verified defect to select `distinct-fix`; source-review-only
diagnoses select `source-only`. The control verifies the publishing account and
report marker, the reviewed title/body revision and native posted-review receipt,
and the source: durable binds the exact original hold event, review-pr
invocations, basis, slot and sole PR ownership; legacy binds the PR-scoped key,
configured ownership and that no chain owns the PR. It persists the disposition
inside the existing report intent and records the diagnosis and next action in
waiting reasons on the report chain and, for durable, the source chain. Liveness
goes in those reasons only; the report body is never edited. Labels, comment
wording and closure supply no disposition.

At admission, missing or stale review dispositions wait visibly, even when new
report publishing is disabled. `source-only` starts no report implementation and
leaves the original exact-head review obligation and explicit retry path intact.
Only a current `distinct-fix` can pass through the ordinary implementation gates.
Durable admission re-verifies the source through a fresh observation and the
qualifying review attempts (exact head, basis, slot and Calls) with sole
ownership; legacy re-verifies the marker, configured ownership, that no chain
owns the PR, and that the report is unchanged. A review ownership change
(legacy↔durable cutover, a different chain owning the PR), Resume, a replacement
Hold, different Calls, a changed report revision or a new head invalidates the
old binding. Original review Calls prove no-submission and resource release, not
publication. No recovery is added: retry stays explicit and automatic retry stays
stopped. Admitted-but-unlaunched report implementations retire as
`launch_deferred`; launched work settles through its original receipts under the
original reconciliation and publication fences.

For `repair-pr`, `atomic_work_blocked` also qualifies one settled original Call
under its matching active automatic hold after the last Resume. The same
no-publication and positive resource-release proof is required, with fresh
evidence that the open PR still has the admitted head and repair basis. Operator
holds, unknown effects and structured CI-only holds with their existing recovery
path do not qualify. The report names the source issue, PR, original Call and
verified stage, and distinguishes the settled no-publication fact from the
bounded, redacted **worker-reported** blocker. It preserves the source hold and
repair ownership without admitting work or relaunching repair. Its identity is
`atomic_work_blocked` + source chain + PR, separate from the pre-PR implementation
identity; even a closed historical implementation report cannot cover this repair.

These repair-hold reports use the same guarded `report-disposition` control with
`existing-remedy` or `distinct-fix`. `existing-remedy` names the already-owned
remedy issue in `remedy` and keeps it as the single implementation owner; the
report stays fenced and the source stays held, showing the source PR/head and the
remedy link. Only a current `distinct-fix` for a separately diagnosed,
implementable defect with no existing owner can pass through ordinary
implementation gates. The control binds the original report marker, settled
no-write Call and release, reviewed report revision, current source PR head/basis
and remedy identity, and re-verifies them before and after awaited preparation.
Missing, stale or unauthenticated triage waits visibly; a comment alone, remedy
closure, changed head or ambiguous publication cannot authorize implementation.
The source still requires its own authorized recovery or explicit Resume.

`implementation_publication_uncertain` qualifies an original `implement-issue`
invocation that remains uncertain after recovery, including an unheld source.
Its failed terminal Call is retained in `evidence.callId` while `invocation.callId`
is still null. The original receipt must retain the `publishing` phase, completion
time and positive resource-release proof without a conclusive publication result.
Fresh reconciliation must still verify the same open, eligible source with no
attributable pushed branch, bound PR or competing linked work. Reporting keeps
the source fenced and names the original invocation, Call, bounded cause and
missing pre-push no-write checkpoint or conclusive push result. It authorizes
neither replacement implementation nor a second push. Its existing intent uses
cause + source chain + original invocation. Before creation, source-body links
and comments by configured accounts can identify an existing report, including a
closed markerless issue by either configured account. Its body must verify the
same source, invocation, Call and uncertain publication with missing original
push evidence; an ordinary reference or another failure cannot qualify. Adoption
retains that issue in the intent across restart without another POST or marker edit.

`merge_submission_uncertain` separately qualifies the original pending `merge-pr`
invocation after recovery rereads the journal, even without an explicit chain hold.
Its failed terminal Call must have a completion time and positive resource-release
proof, with no accepted action receipt or proven no-effect result. The Call identity
can be retained as `evidence.nativeCallId` while `invocation.callId` remains null.
A fresh native observation must verify that the seed and original PR remain open,
the PR still has the request's pinned head, and no merge is running or queued.
Unavailable evidence, a changed target, closure or a confirmed merge prevents
creation. Same-head conflicts, failing CI and other readiness blockers do not
prevent reporting: the uncertain invocation also blocks repair. The report names
the seed, PR, head, original invocation and Call, recorded error code and bounded
process diagnostic facts, or explicitly states that historical diagnostics are
missing. Its next action is to inspect and reconcile those original receipts and
the PR/queue state before deciding how to proceed. It never retries the merge or
asserts an unobserved external write.

`pull_closed_unmerged` qualifies a fresh open seed whose only linked PR is
confirmed closed without merge, after all original invocations and resources
settle. It creates one actionable continuation through the same publisher and
normal intake, naming the source issue, closed PR, reason and next action.
A merge, closed seed or replacement PR cannot qualify. Missing or unreadable
original receipts stay in runtime recovery with their invocation, hold and
reservation; reporting never clears that fence to create replacement work.
Before reserving a new intent, the reporter reconciles any durable source/PR
report link across causes. Manual links in the source or PR body, or comments
by the configured accounts, require an explicit `Continuation: #N`,
`Replacement issue: #N`, `Continued in #N`, `Work moved to #N`, `Work continued to #N` or
`Superseded by #N` relationship. The exact target must be an open `poise` issue
in the same repository whose body references both the source and closed PR.
Ordinary references, including original-outcome investigations, do not prove
replacement-work coverage. Ambiguous or unavailable successor evidence stays
pending. Existing links and uncertain creation intents are retained across
restarts; the new cause uses the same source-issue/PR deduplication and
single-POST rule below.

Poise creates the report as the configured main GitHub account through its
existing issue publisher, requesting the `poise` label. The body records the
stage, stable cause, target, hold time/age, head/basis, safe invocation and Caller
receipt identities, and next action. Apart from the explicitly worker-reported
implementation or terminal repair blocker, it excludes raw errors, omitted finding IDs, worker paths
and provider output. An intent in the existing durable metadata store
links the original failure to the report issue. Repair identity uses cause + source
chain + PR, independently of omission details, heads and subsequent attempt windows.
Existing repair and review intent keys and markers remain unchanged. Uncertain merge reports
use cause + source chain + original invocation, with the same metadata store and
marker format; an unheld source has no hold event or hold time.
Implementation reports use cause + source chain, independently of blocker prose,
receipt identity and observation time, with null source PR/head fields in the same intent.
All report bodies include the canonical clinical scope directive in the
[report template](../server/behavior-chain-report.ts), followed by
"Include this exact paragraph in the linked PR review." Native PR review and
approval check closing references only when their chain's exact seed is a recorded
report issue in that repository or contains the canonical paragraph followed by
that exact directive. The recorded issue number identifies the
remediation ticket; the report's `pull` identifies the stalled source PR.
The datastore must report complete `closing-references` that identify that exact
seed; `body-keywords` cannot verify the relationship. A validated fresh page missing
the exact PR (empty or starting at a later number) records a wait naming that PR
before admission, while other chains continue. Its 120-second budget starts at
the first timestamped journal wait for that repository/PR; rechecks, restarts and
healthy syncs cannot reset it. Once the exact closing reference appears, review
preparation resumes with the required scope. Stale, unreadable, incomplete or
conflicting evidence, and an indexing delay beyond that budget, remain errors.
Unrelated seeds skip these additional datastore reads.
A `poise` label or copied report marker alone cannot qualify a PR.
Poise passes the trusted paragraph through `--review-scope`, separately from the
configurable `--note`, and includes it in the reviewer's instructions. A lookalike
marker in a configurable note cannot supply the formal review directive.
Caller retains the trusted directive before invoking the reviewer and inserts it once
in the formal GitHub review through the existing submission helper, for Claude
and structured reviewers. The assessment, findings, review event and receipt
keep their existing meaning. PR descriptions and Manager/Worker defaults do
not acquire this policy.
The marker lookup includes closed issues and verifies the publishing account.
Intent is committed before creation;
after an ambiguous POST, even repeated empty searches cannot authorize another
POST. A crash before sending the reserved request also remains unconfirmed and
requires reconciliation rather than an automatic replacement.

A confirmed issue number is retained before label reconciliation. Missing labels
are retried additively on that same issue; label failures, datastore indexing lag,
incompatible saved intake labels and a held remediation chain are shown in the
source chain's `waiting` reason, including its report URL when known. Poise does
not add a different intake label or bypass ownership/admission gates. Admission is
verified only when the normal datastore intake records the new chain. Generated
remediation issues cannot report any supported cause recursively, using their
marker or the retained source-to-issue link; their ordinary holds and uncertainty
remain visible.

For implementation reports, `waiting` leads with the source's current implementation
or repair stage and worker-reported blocker, then directs the person to inspect
that Call, address the blocker and explicitly Resume. Report dispositions carry
the time of successful report verification, not the status read or source observation;
deferred or failed report reads cannot refresh that claim. Between ordinary
rechecks, admission and remediation holds describe that dated observation, not
live remediation. Once closure is verified, the report link remains historical
context and the source blocker and next action remain. Its body, intent and marker
stay unchanged; status reads and reconciliation create no replacement report or
implementation attempt and do not change the quiescent cadence.

`tests/behavior-chain-report.test.ts` exercises publication, labeling, uncertain
creation/restart, reconciliation, uncertain merge target suppression and normal
admission with an isolated journal and fake GitHub/datastore commands. Live
acceptance remains pending until an
operator follows a real qualifying hold through one labeled report, chain
admission and the normal merge receipt after deployment. No fabricated hold,
live write or production setting change is part of that component proof.

### PR #957: merged after repair exhaustion (#1044)

[PR #957](https://github.com/autonomio/poise/pull/957) merged on
10 November 2026 at 11:47:10 UTC, with final head
`570a39ce4d4cb40518411b8c99bd6135370d774b` and merge commit
`90031625ce91362ce5dd3f8ef1d79ec21324dae1`. This supersedes the
"Current hold" next action in [#1044](https://github.com/autonomio/poise/issues/1044):
repairing the old head or adding another retry mechanism is no longer needed.

A read-only live journal inspection at 12:04 UTC on 10 November still found
chain `autonomio/poise#910` at sequence 8063, hold event
`9f014bbb-2aa2-4556-a143-2b10e86e9221` from 9 November at
16:47:50.995 UTC, with no later Resume or recorded merge. Its last observation
still named head `087b6f1e9522846ab496240dc565127867d5463f`. All three repairs
on basis `ddd163087b13a0aec64478d968d985d525a9b2b413d0b28b042cada17c45d545`
and review revision
`df3c35c6fc859fe517f330f7e93cb5c1d84cbf198647f68f2bff11f15b9e1583`
remain settled failures with `atomic_work_execution_budget_exhausted`,
`action=not_started`, `outcome=preflight_failed`, released resources and no
publication plan:

| Native invocation | Caller receipt |
| --- | --- |
| `879e925a-0acc-432e-9026-2cc82df0d32c` | `89e7e319077a47788416c8acd9e5012a` |
| `3c46c70b-437b-40a0-888a-db220d59a82a` | `71e8a6d8938d4d19b5786c5afa4d38ff` |
| `c8ed00fc-46ba-4cd7-9b11-6c7819b28d52` | `f2420c18b8534935828b2af2e00871b6` |

The next action is the existing [bounded reconciliation](#bounded-reconciliation)
of the confirmed merge and original receipts, without Resume or publication.
The runtime records a merge before evaluating a hold and retains these failures.
GitHub's final-head approval alone does not discharge the chain's original
review obligation: that approval has no native invocation/response receipt, and
the last canonical pre-merge observation names a different head and context.
Keep that obligation unproven unless qualifying original evidence is recovered;
closing this PR-specific repair incident does not certify chain completion.
This inspection changed neither the live journal nor GitHub.

## Native action receipts

Merge, queue-submission and conversation-resolution responses are attributed to
their original admitted invocation, actor, request digest, repository, PR and
pinned head. The runtime validates and retains a bounded receipt in the canonical
journal before terminal settlement. If settlement is interrupted, rebuilding the
journal recovers that same accepted response without another native write. A
returned response survives a subsequent nonzero process exit; the process failure
is retained separately from the accepted effect. An observed prior merge, queue
entry or empty thread set does not prove that this invocation performed it.
Merge-admission failures retain their bounded, redacted v1 diagnostic through
the original Caller receipt. `submission: none` requires positive evidence that
execution had not reached the mutation; `rejected` requires an explicit refusal
response. Both use the existing no-action failure/backoff path; settlement still
requires positive resource-release proof. Generic GraphQL errors, lost responses and
missing queue confirmation retain `submission: uncertain`. The chain list and
History show the original Call, cause and next action using this evidence.
Without an accepted response or positive refusal evidence, the invocation remains
uncertain and blocks a replacement write, even when the queue is empty or another
actor subsequently advances the PR. A failed receipt write has the same boundary:
the returned response alone is not durable authority. Other chains can continue.
Publication recovery likewise requires the original native invocation marker and pinned head; grey-CI recovery
retains its existing exact-workflow/attempt inspection.
Historical Calls whose causes were discarded remain uncertain; this diagnostic
path cannot reconstruct their missing evidence.

Conversation resolution checkpoints each attempted thread and validated mutation
response in the original Call's `artifact.resolution_progress` before another
mutation. Chain summaries expose its `confirmed` results and `pending` thread as
`nativeAction.resolutionProgress`, including after a subprocess timeout and journal
reload. Confirmed threads are skipped on continuation; an unacknowledged attempt
refuses continuation and remains uncertain even if a later read finds it closed.
A failed checkpoint stops further mutations. Partial progress cannot replace the
completed batch response, final readiness/thread checks or resource-release proof.

### Queue admission trace — 12 November 2026 (#1254)

GitHub's complete enablement/queue/merge timelines were read alongside the
workspace's retained Caller and chain receipts. All times below are UTC.

| PR | Auto-merge enabled | Queue admission | Merge |
| --- | --- | --- | --- |
| [#1245](https://github.com/autonomio/poise/pull/1245) | 18:50:53 | 18:53:35 | 19:00:15, [`afd8c832`](https://github.com/autonomio/poise/commit/afd8c832301b19cdea063c14a8a6bfd8555b7d91) |
| [#1246](https://github.com/autonomio/poise/pull/1246) | 18:51:35 | 18:54:32 | 19:09:20, [`e9610e22`](https://github.com/autonomio/poise/commit/e9610e22b8b867d616fcb8685bbf589eebc9441d) |
| [#1247](https://github.com/autonomio/poise/pull/1247) | 18:53:51 | 19:02:27 | 19:21:36, [`27b8fde1`](https://github.com/autonomio/poise/commit/27b8fde1b78797a58a86e3553f02fddb4da1a04a) |
| [#1252](https://github.com/autonomio/poise/pull/1252) | 19:05:12 | 19:08:45 | 19:21:52, [`7be811a1`](https://github.com/autonomio/poise/commit/7be811a1e5fec6178dbd21e01b2ceefbdec0263a) |

The enablement actor is `bit-mis`; the originating client remains **unknown**.
The three held chains retain implementation Calls
`f9fdfde023424f6a8648d6c2638a72d4` (#1237),
`dde7cebda2bb467d9adb0a5338c5b924` (#1218) and
`53393c235a284a37b9f326e2db43bf63` (#1240), plus issue reviews, but no
`review-pr` or `merge-pr` invocation. The manual-action receipt table is empty,
and no Chat events were recorded during 18:45–19:10. These absences do not
attribute the enablement request to an operator, Chat or autonomous behavior.
Their final-head GitHub approvals contain neither native invocation nor review
response markers. Each verified merge remains recorded with `reviewPending: true`.

#1252's original review Call `57b2824699ec475ea462912d458544c2` posted
[review 5880497729](https://github.com/autonomio/poise/pull/1252#pullrequestreview-5880497729)
at 19:11:17, after admission and before merge. It proves reconciliation of the
original review, not enforcement at admission. The chain decision requires all
configured review slots; Caller's `merge_if_ready` validates the retained
response before its direct enqueue. Neither enables auto-merge. No autonomous
enablement bypass is established by this trace. Work reads already preserve
the merge and pending obligation; [Logging's Work impact](Logging.md#observe--logging)
directs reconciliation of that original evidence even while held, rather than
recommending Resume on a merged chain. A GitHub approval alone cannot discharge
the obligation or authorize a new post-merge review.

For [#1270](https://github.com/autonomio/poise/pull/1270), the retained original
chain and Caller records contain six failed `review-pr` Calls, no retained review
response and no `merge-pr` invocation. The manual-action receipt table is empty.
The unchanged-head and changed-head queue admissions and auto-merge enablement
reported in [#1308](https://github.com/autonomio/poise/issues/1308) therefore have
no attributable native submission receipt; `bit-mis` identifies the account,
not the client. No Poise submission bypass is established. The existing native
enqueue gate remains unchanged; held open PRs now receive the timely observation
and actionable queue conflict described above.

## Seed observation batch

One observation starts one native process for its seed issue, comments and
publication inspection, instead of three. The batch reuses the three existing
read projections on one shared client and returns them as named facets bound
to the chain's repository, issue, branch and author account. Any facet failure
fails the whole read; there is no partial envelope and no cached evidence, so
freshness, validation and uncertain-action recovery are unchanged. The output
cap is the sum of the three previous per-read caps. Reviewer readiness, CI,
grey-CI recovery and the review-datastore path still read separately and keep
their existing budgets. The saving is interpreter startup and auth setup, not
API reads: the batch issues the same HTTP requests as the three separate
reads did.

## Acceptance boundary

Local unit/integration tests use explicit isolated stand-ins to protect contracts. They are not the requested acceptance proof. Historical dispatcher-driven runs in [the archived report](V2-real-cycle-validation.md) are excluded.

The acceptance run must use the production image, entrypoint and supervisor with separate local state and authorized alternative GitHub identities, following only an organization excluded from production. Only the ten seed issues are created manually. Actual behaviors must produce every subsequent comment, implementation, PR, review, repair and native merge without an external dispatcher or phase toggling. Any operator intervention to advance a stalled phase invalidates that unattended run and is retained as a failure. The source candidate, native receipts, artifacts, exact-head CI, actual merge SHAs and production-boundary observations must be recorded before declaring completion.

The first native attempt at `01c1998d` found a real intake failure: issues #27–#36 had their `poise` labels on GitHub, but the existing datastore did not capture label evidence. Zero chains and zero workers were admitted. That attempt is retained as failed. The reader now captures complete GraphQL label connections, refuses missing label evidence, and backfills old open issues through the existing sync/full-refresh path without editing the issues or adding a poller. The completed native outcomes below span corrective releases; they do not establish ten uninterrupted cycles on one frozen candidate.

The `10fa17d4` run then posted real issue reviews and implemented #27 as PR #37, with green exact-head CI. Its PR-review admission failed before Caller tracking because a relative PR reference could not identify a repository from an empty interface directory. This candidate is not accepted as a completed run. Native PR requests now use absolute URLs; recovery qualifies an older relative reference against its immutable chain identity, preserving its admission and correlation. Native process exits are retained, and an exited process without a Call receipt becomes uncertain rather than silently respawning. Existing work must continue through the behaviors; no operator review, repair or phase advance substitutes for it.

The same candidate also allowed one legacy review of PR #38 before its next chain observation recorded the new PR number. That extra review remains evidence of a failed ownership boundary and does not satisfy a managed review slot. PR admission and Chat binding now recognize the branch reserved in the canonical chain, using existing datastore head identity. Unknown head evidence in a repository with active chains refuses legacy admission; matching branch names in another head repository do not claim ownership.

The implementation of #34 exhausted an unintended PR-review cap: the caller requested an hour but its budget context silently capped that at 1,413 seconds. Atomic implementation/repair now uses its requested hour, including the existing publication reserve. Its registered writer gate also consumes the existing provider activity and quota observers; it does not wait out the entire work budget on a provider reconnect loop. Both failed and successful native work run through existing strict resource settlement before a subsequent behavior can start. The original timeout remains a failed attempt, not completed work.

The in-place switch to `83eab4ed` preserved three active Call IDs and PIDs but admitted a fourth background worker: durable capacity used the total check cap instead of the behavior lane's reserved ceiling. That failed reserve check remains recorded. Admission now reuses the existing lane ceiling across process replacement rather than duplicating its reservation policy.

## Confirmed native outcomes — 28 October 2026

All ten manually seeded issues, ranging from 36 to 1,049 words, reached actual
merges through the isolated production image, entrypoint and supervisor.
`zero-bang` published the work and `llun-ved` reviewed and approved it. Each
chain completed two posted issue reviews before implementation. Every final PR
head has successful CI and an independent current-head approval from a managed
behavior; every actual merge has successful native queue CI completed before
the merge timestamp. The canonical journal records all ten merge SHAs.

| Seed issue | PR | Actual merge | Queue CI |
| --- | --- | --- | --- |
| [#27](https://github.com/test1234test1234test/poise-v2-local-20261027/issues/27) | [#37](https://github.com/test1234test1234test/poise-v2-local-20261027/pull/37) | [`bc44151b97a6`](https://github.com/test1234test1234test/poise-v2-local-20261027/commit/bc44151b97a6381cd8d2f6176bb752eb9fde4ee9) | [Passed](https://github.com/test1234test1234test/poise-v2-local-20261027/actions/runs/40730056122/job/122963612760) |
| [#28](https://github.com/test1234test1234test/poise-v2-local-20261027/issues/28) | [#39](https://github.com/test1234test1234test/poise-v2-local-20261027/pull/39) | [`45c36b630740`](https://github.com/test1234test1234test/poise-v2-local-20261027/commit/45c36b6307407c6448b01a6a66a6ef1cc7aef3b9) | [Passed](https://github.com/test1234test1234test/poise-v2-local-20261027/actions/runs/40706583932/job/122880244298) |
| [#29](https://github.com/test1234test1234test/poise-v2-local-20261027/issues/29) | [#38](https://github.com/test1234test1234test/poise-v2-local-20261027/pull/38) | [`59983c0da380`](https://github.com/test1234test1234test/poise-v2-local-20261027/commit/59983c0da38041849a298d9413457fc5e0823148) | [Passed](https://github.com/test1234test1234test/poise-v2-local-20261027/actions/runs/40731881671/job/122970076536) |
| [#30](https://github.com/test1234test1234test/poise-v2-local-20261027/issues/30) | [#41](https://github.com/test1234test1234test/poise-v2-local-20261027/pull/41) | [`24aa894eb402`](https://github.com/test1234test1234test/poise-v2-local-20261027/commit/24aa894eb402f615e7169b21bc61799de20f7a87) | [Passed](https://github.com/test1234test1234test/poise-v2-local-20261027/actions/runs/40720104525/job/122928349245) |
| [#31](https://github.com/test1234test1234test/poise-v2-local-20261027/issues/31) | [#42](https://github.com/test1234test1234test/poise-v2-local-20261027/pull/42) | [`4d348316db9a`](https://github.com/test1234test1234test/poise-v2-local-20261027/commit/4d348316db9aa9d4869fcab3182ff6349359f665) | [Passed](https://github.com/test1234test1234test/poise-v2-local-20261027/actions/runs/40721073415/job/122931802636) |
| [#32](https://github.com/test1234test1234test/poise-v2-local-20261027/issues/32) | [#43](https://github.com/test1234test1234test/poise-v2-local-20261027/pull/43) | [`eb1f71c8406d`](https://github.com/test1234test1234test/poise-v2-local-20261027/commit/eb1f71c8406d18200ba50af5c1a5c1f6dee8effd) | [Passed](https://github.com/test1234test1234test/poise-v2-local-20261027/actions/runs/40724706721/job/122944717029) |
| [#33](https://github.com/test1234test1234test/poise-v2-local-20261027/issues/33) | [#45](https://github.com/test1234test1234test/poise-v2-local-20261027/pull/45) | [`3848804d2bd4`](https://github.com/test1234test1234test/poise-v2-local-20261027/commit/3848804d2bd4f5ce5b96124fc24d050652b4b467) | [Passed](https://github.com/test1234test1234test/poise-v2-local-20261027/actions/runs/40728339373/job/122957546288) |
| [#34](https://github.com/test1234test1234test/poise-v2-local-20261027/issues/34) | [#44](https://github.com/test1234test1234test/poise-v2-local-20261027/pull/44) | [`70d5eee27336`](https://github.com/test1234test1234test/poise-v2-local-20261027/commit/70d5eee273363d69e0a4635c33844a9d48eaf0d0) | [Passed](https://github.com/test1234test1234test/poise-v2-local-20261027/actions/runs/40729302816/job/122960939681) |
| [#35](https://github.com/test1234test1234test/poise-v2-local-20261027/issues/35) | [#40](https://github.com/test1234test1234test/poise-v2-local-20261027/pull/40) | [`50b8537e9f35`](https://github.com/test1234test1234test/poise-v2-local-20261027/commit/50b8537e9f357f1554a108dfc6e94e20804040ec) | [Passed](https://github.com/test1234test1234test/poise-v2-local-20261027/actions/runs/40728661657/job/122958687460) |
| [#36](https://github.com/test1234test1234test/poise-v2-local-20261027/issues/36) | [#46](https://github.com/test1234test1234test/poise-v2-local-20261027/pull/46) | [`1d0bc6bad570`](https://github.com/test1234test1234test/poise-v2-local-20261027/commit/1d0bc6bad5705ebb8c167f16a27a4f16d1771912) | [Passed](https://github.com/test1234test1234test/poise-v2-local-20261027/actions/runs/40740164672/job/122999285212) |

No operator performed a sandbox review, repair, approval, queue admission or
merge, or advanced a chain phase. Native behaviors handled real conflicts,
provider failures and a pushed-head visibility failure. Failed Calls and the
extra legacy review described above remain in the evidence. The final merged
repository at `1d0bc6bad5705ebb8c167f16a27a4f16d1771912` passes all 1,350 Node
tests without failures or skips; independent public-API checks verify returned
values, errors, ordering, rollback and replay for all ten requested libraries.

The final runtime code is `f89d71a0578c06c1a1c8a8161ddb9883120cb95e`.
Its normal supervisor switch preserved the tenth implementation's Call
`c07597ff9faa4d45b24f00ee2307d866` and PID 6169, with zero container restarts.
That issue's second posted review completed 3.686 seconds before implementation
admission; implementation settlement preceded PR-review admission by 12.981
seconds. The run used no external dispatcher, scripted worker or persistent
owning Chat. It spans earlier corrective releases, rather than ten complete
cycles on this final revision alone.

The replica has its own home volume, network, alternative account credentials
and 4-CPU/8-GiB limits, with no host ports, production mounts or Docker socket.
The live VM read at 17:44 UTC reports v1 release `38aba181`, the five production
organizations excluding `test1234test1234test`, zero test-organization pickups
and zero test Caller runs. Its native-chain setting is absent. An earlier
preview-only boundary read and an aborted incorrectly stamped build are
excluded from proof. Production configuration, active work, v2 admissions and
defaults were not changed.

The final runtime revision has independent approval and all 13 exact-head CI
checks green, including 877 browser cases without retries. Local Caller checks
pass all 958 tests and image contract/offline checks pass. The complete local
application check passes 4,777 tests, lint and the production build at
`25028a32`; application sources are unchanged by the final Caller-only fix.
Earlier local failures and passing unchanged rechecks remain retained; no
assertions or deadlines were weakened.

Live queue ejection and an ambiguous nonempty reply batch did not occur in
these ten cycles. Their recovery guards use explicit isolated regression
stand-ins and do not constitute live acceptance of those failure paths. These
results do not authorize production activation or migration of active v1 work.
Raw journal events, native receipts, GitHub artifacts and gate logs are retained
privately under `test-results/behavior-chain-20261028/` in the validation
worktree; historical externally dispatched runs remain excluded.

## Native parallel-execution evaluation — 30 October 2026

The supported native options were evaluated against the checked-in Codex
protocol surface and the current official documentation. The comparative
workload leg is blocked: #729 (teardown), #730 (memory bounds) and #731
(admission) are all still open, so no candidate can run under the required
controls yet. Decision: retain the current isolated workers. No adapter
change. The empirical method below is recorded so the blocked leg can run
unchanged once those controls land.

### Options and verdicts

The only checked-in version marker is the Chat protocol types generated
from codex-cli 0.154.0 (`server/chat/adapters/codex.ts`). There is no
behavior-runtime Codex pin: provider preparation checks npm
`@openai/codex@latest` on every launch
(`scripts/provider-cli-updates.mjs`) and the workspace image installs
`@openai/codex@latest` (`deploy/runtime/install-clis.sh`). CLI execution,
app-server threads and agent APIs have distinct contracts and were
evaluated separately.

| Topology | Verdict |
| --- | --- |
| Current: one CLI exec process per behavior invocation (`codex exec --ephemeral`, `issue_review.command`), owned process group (`start_new_session`), group kill plus checkout process-scan reclamation (`checkout_lock._stop_group`, `issue_review.stop_leftovers`) and settlement before handoff | Retained |
| One app-server process per behavior | Rejected: keeps the process boundary but adds a persistent server, on-disk thread state and an unsubscribe/delete/kill teardown per behavior with no demonstrated benefit over direct exec |
| Shared app-server multiplexing independent behaviors | Ineligible: fails the ownership, unload and reservation gates below |
| In-behavior native delegation (subagents) | Out of scope: irreconcilable with the review delegation contract below |

### Ownership and selective termination

Each current invocation owns one OS process group, registered through the
writer gate (`checkout_lock.register_worker`); timeout or lease loss kills
exactly that group, and the checkout scan reclaims what the agent left
behind. A shared server breaks this boundary: its process, allocations
and process-group kill are shared across behaviors. Stopping or timing
out behavior A while B is live must not stop B, free B's reservation or
publish A's unfinished output, and shared-server death plus Poise
replacement with both active must reconcile each uncertain action
individually. No durable mapping from canonical invocation/Call ID to
native root, logical descendants and checkout exists, and the checkout
process scan cannot see logical threads in a server outside the checkout,
so an empty scan cannot prove unload. A PID-only child counter, killing
the whole shared server, or a lost `thread/start` / `turn/start` reply
authorizing duplicate work are all insufficient. The exact evaluated
version exposes no primitive that supplies the missing mapping, so the
shared topology is rejected without adding another scheduler.

### Observed unload

Per the current app-server documentation, `thread/unsubscribe` keeps the
thread loaded through a 30-minute no-subscriber/no-activity grace period
before unload and `thread/closed`; archiving moves the JSONL log into the
archived directory and retains its history; ephemeral root threads cannot
use `thread/delete`. A successful RPC, `turn/completed`, or absence from
the ordinary history list therefore cannot establish zero resident agents
or disk reclamation. The checked-in history-list contract defaults to
interactive sources and excludes archived threads
(`server/chat/generated/codex/v2/ThreadListParams.ts`), so an unfiltered
first page misses the `exec` and subagent histories under evaluation.
Eligibility requires separate observations against the loaded-thread
inventory (`thread/loaded/list`), OS descendants, disk/history removal
and retained required receipts. Even Chat's own adapter tears a session
down by ending RPC and killing its one app-server process
(`server/chat/adapters/codex.ts` `close`), never by per-thread
unsubscribe/delete — with a shared server that per-behavior kill is
unavailable.

### Delegation contract

Structured Codex PR review disables `multi_agent` (and shell, exec and
related tools), owns one fresh native conversation per review, resumes
only that exact conversation for fragment/inspection continuation, and
rejects execution/delegation events and foreign conversations
(`structured_review.ask_codex`). Implementation and repair instruct the
model not to start other agents and leave all publication to Caller
(`atomic_work`). Enabling native delegation merely to obtain a sample
would change the review's evidence and authority. Any permitted internal
delegation must stay inside one admitted behavior, retain the governed
inspection/packet and output checks, keep publication with Caller, start
each reviewer independently rather than fork the implementer's analysis,
and keep exact-conversation continuation until that behavior's outcome is
durable with a fresh context for the next behavior. No evaluated option
demonstrates this, so delegation stays disabled.

### Advance reservation

Expected-result accounting requires the measured maximum envelope to be
reserved through behavior admission before native execution; observing a
child-creation event afterward cannot prevent overcommit. The documented
`agents.max_concurrent_threads_per_session` caps concurrently open
spawned-agent threads per session excluding the primary: it is neither a
workspace-wide limit nor a cap on arbitrary client-created app-server
threads, so a child-limit setting alone cannot establish compliance.
Unbounded or unmeasurable fan-out is ineligible rather than zero-cost,
and a shared server's base/context memory plus build/test descendants
would need explicit attribution with stated shared-page treatment.

### Blocked empirical leg

Run only under #729 teardown, #730 measured bounds and #731 admission,
once available, reusing the existing local service replica, readers and
diagnostics. Preserve the #728 pre-change measurements
(`77976fd92963cc7e2ad238f90b5ef3f8788ee0c0`), then capture an
isolated-worker baseline after those controls with identical
prerequisites, configuration and budgets; record both revisions and
compare the candidate against the controlled baseline, never #728 alone.
Freeze versions with verified immutable launch paths for both lanes and
retain bounded, redacted executable/version/config/schema evidence per
attempt, including actual child model/effort, auth/provider route and
fallback use; a version or model change separates that pair, and fallback
to existing workers is not a native sample. This needs no production
updater change.

Define concurrency as achieved simultaneous behaviors. The unchanged
semaphore keeps a person reserve and a behavior reserve of one each
(`server/check-semaphore.ts`), so total caps 1/2/3 admit only 1/1/2
behaviors and cap 4 admits 3; record achieved 1/2/3 levels and admission
blocks under the same budgets, separately from native context counts.
Predeclare matched seed/base revisions, packet and build/test sizes,
cache conditions, repetitions and run ordering. Already reviewed,
repaired or merged targets cannot be replayed as unchanged inputs.

Derive counts from canonical admissions, settled native receipts and
verified artifacts, deduplicated by invocation and outcome; a child turn
is not another completed behavior. The UI behavior-metrics summary is
excluded: it covers only the six legacy behavior keys and classifies
`superseded` as success (`server/behavior-metrics.ts`). Report phase
throughput separately from issue-to-confirmed-merge throughput, splitting
admission delay, execution, external CI/queue wait and verified
reclamation. Measure full-process-tree peak memory with stated
shared-page treatment, disk retained after completion,
termination/reclamation latency and idle agent counts; include parent and
child token/context usage where observable, every failed attempt and
retry, and provider throttling. Observe reclamation through the
loaded-thread inventory as well as OS descendants, disk/history removal
and retained receipts, against #729's deadlines. Predeclare the
improvement/uncertainty rule; if no benefit is demonstrated, or the
native option is infeasible, report retain-current or inconclusive
explicitly. Evidence analysis stays bounded and read-only; no new
telemetry.

Seed issues are created manually in dedicated test
repositories/accounts; real product behaviors perform every review,
implementation, repair and strict merge/queue action. Excluded: Poise
Chat performance, a persistent agent coordinating multiple behaviors,
production operations, v2 activation/admissions/default changes and
active-work migration.

Evidence for this record: audited baseline #728 at
`77976fd92963cc7e2ad238f90b5ef3f8788ee0c0`, evaluated main at
`e5484ab50bc73ceb1d5119057688e33ab881e950`, official app-server and
subagent documentation as published on 30 October 2026, and the
checked-in generated v2 protocol types. The `codex-cli 0.166.0` binary
visible in this documentation environment is not evidence of any
replica version. No provider workload was run, so this record
establishes the options analysis and the retain-current decision, not a
performance winner.

## Resource-lifecycle acceptance (#733) — frozen protocol and retained baseline

Status: protocol frozen 30 October 2026 by PR #757; unchanged baseline
retained below. The frozen contract is this PR's merge commit: checking
out any earlier revision cannot reproduce it, and campaign manifests
must cite that merge SHA. The real-run campaign is pending #729, #731
and the measured-budget follow-up to #730. #732 is recorded above
(retain the current isolated workers; no adapter change) and #730
closed with bounded review-input memory. No resource-readiness claim
is made here. Thresholds frozen in this section cannot move after
observed failures.

### Retained unchanged baseline

The baseline is the audited pre-change candidate `77976fd92963cc7e2ad238f90b5ef3f8788ee0c0`
(merged #728), on which the ten workflow cycles above ran. The #732
evaluation above assessed main at `e5484ab50bc73ceb1d5119057688e33ab881e950`;
that revision predates this protocol and is not its freeze.

| Pinned element | Baseline value |
| --- | --- |
| Poise application | `0.1.0` (`package.json`), candidate SHAs above |
| Node runtime | `^22.13.0` (`engines`), `.node-version` `22`, image `node:22-bookworm` (`deploy/runtime/Dockerfile`) |
| Caller runtime | Python 3.13 |
| Provider CLI | Not pinned: the updater queries and installs `@openai/codex@latest` (`scripts/provider-cli-updates.mjs`); the run manifest must record the actual executed binary and version per worker |
| Service container | uid `10001`, `CapDrop: ALL`, `no-new-privileges` (`gateway/src/orchestrator.ts`) |
| Replica limits | 4-CPU/8-GiB, own home volume and network, no host ports, production mounts or Docker socket |
| Test scope | Organization `test1234test1234test` (excluded from production), author `zero-bang`, reviewer `llun-ved` |
| Storage reader | Logical bytes, potentially partial; missing reads as zero, anything else that stops the walk reports partial or unavailable (`server/storage-maintenance.ts`) |
| Temporary storage | Warns on downward crossings only; never gates or stops work (`server/temporary-storage.ts`) |

Two concrete retained-data observations calibrate the acceptance
inventory; #729 owns the implementation and retention decisions:

- 30 Codex session files occupying 7,403,527 bytes after the ten
  workflow cycles, with both disposable checkout roots empty.
- Five isolated acquire/release/delete cycles left zero run directories
  but five checkout lock databases / 40,960 allocated bytes
  (`caller/agent_interface/agent_interface/checkout_lock.py`).

Idle process, memory and disk measurements are taken in the isolated
replica on the frozen baseline candidate before the campaign, using the
idle-observation procedure below. They are not captured in this change.

### Frozen run manifest

Each campaign runs under one immutable manifest: Poise and Caller
commits, image digest, executed provider binary path and version per
worker, model/effort and fallback, initial target commit, gates and
rulesets, review settings and cache state. Paired baseline/candidate
campaigns use the same workload definitions and a reset procedure over
dedicated test repositories from the frozen initial target commit.
Actual packet, output and build sizes and the exercised review
stages and continuations are recorded per run; requested workload
class alone does not establish a substantial run. Version, base,
cache or ruleset drift invalidates the comparison or separates it
into a new campaign; a corrective source revision starts a new
candidate campaign while earlier attempts remain failed evidence.

Workload classes are defined by exercised stages: minimal (issue
reviews, implementation, PR reviews, no repair), moderate (at least
one repair round), substantial (conflict or multi-round repair with
full review stages). Each concurrency level's repetitions include at
least one moderate or substantial run.

### Concurrency proof

Levels 1, 2 and 3 name achieved simultaneous behaviors, not admission
ceilings or observed overlap alone: the journal permits one
unsettled invocation per chain (`server/behavior-chain-store.ts`)
and the semaphore already blocks by count
(`server/check-semaphore.ts`). With the unchanged person and
behavior reserves of one each, total caps 1–2 admit one behavior,
cap 3 admits two and cap 4 admits three, so achieved levels 1, 2
and 3 run under caps 2, 3 and 4 with the unused reserve
documented per run. Each level requires a backlog of at least N+1
admitted unsettled chains and a continuous overlap interval of at
least 120 seconds with N behavior workers concurrently started
across distinct chains, verified by a time-aligned invocation,
process and reservation trace. Admission pressure cases are forced
separately with a count slot still available: blocked work must
show zero provider preparation and zero spawn, then become
eligible only after verified resource release. A run that never
reaches its intended overlap or pressure case is marked
unexercised, never passed.

### Predeclared counts, budgets, deadlines and uncertainty

- #815's isolated cleanup component check uses at most 128 MiB and
  5,000 directory entries per interrupted Call. Its first recovery attempt
  must start within 120 seconds of the original kernel scope becoming
  positively empty; disk reclamation and the first durable release must
  complete within 180 seconds of that same event. Existing one-minute
  runtime/maintenance ticks supply opportunities even with admissions paused.
  One cleanup pass examines at most 16 Calls, yields after 15 seconds of
  work and has a 30-second outer process deadline. Interrupted passes retain
  their original claims and proof; expiry or a missing sample grants no
  release. These limits are fixed before the #815 implementation and do not
  claim the still-pending full campaign has passed.
  Retained cleanup failures retry on the existing one-minute opportunity for
  the first three failures, then after 120, 240 and 480 seconds, capped at
  600 seconds. There is one coalesced cleanup command per workspace, rather
  than one process per held Call. Ownership still must be positively verified
  on every eligible attempt; a deadline or backoff expiry grants no authority.
- Merge campaign: at least 3 unattended repetitions per achieved
  concurrency level (1, 2, 3), hence at least 9 confirmed merges
  on one frozen candidate. Each fault and breach case is
  exercised at least once at achieved concurrency 2 or above
  unless its definition names another level.
- #730 closed with bounded review-input memory (one rendered
  stage packet at a time, per-page issue-packet accounting) while
  measured memory budgets and enforcement remain follow-up work.
  Numeric memory and disk budgets, permitted breach overshoot
  and termination delays, and numeric cleanup deadlines are
  recorded here from #729, #731 and that follow-up before the
  campaign. Once recorded they cannot move.
- Clocks start and end on observed events: provider exit (stop
  signal to last behavior-owned PID gone), cleanup settlement
  (durable outcome to verified `resources_settled_at`), and
  restart recovery (process start to reconciled reservations).
  Restarting or missing a sample never resets elapsed time.
- Uncertainty follows #730's accounting limits: allocated bytes
  and inodes plus open-but-unlinked resources from the independent
  inventory, sampling intervals and coverage gaps published per
  run. Missing or restart-gap observations are excluded from
  peaks; they are never counted as zero.

### Fault and breach matrix

Injections gate on observed process, action or cleanup state, never
on a fixed sleep after launch. Successful-merge runs and
fault/breach runs form separate cohorts; every attempt is retained
in its declared cohort.

| Case | Trigger gate | Expected durable state | Terminal |
| --- | --- | --- | --- |
| Person Stop / cancellation | Observed stop of a live invocation | Worker tree terminated and settled; chain held even after settlement (`server/behavior-chain-runtime.ts`); no silent resume | Held |
| Timeout | Budget expiry with worker alive | Tree terminated, settlement verified, ownership retained | Held or failed per cause |
| Native worker/parent failure | Observed worker or Caller-parent death | Descendants reclaimed; surviving live descendant reconciled against the original invocation. A durable pre-write phase and verified resource release permit a fresh atomic attempt; a possible external write retains the original invocation for reconciliation | Continues only with proven no-write; otherwise held or uncertain |
| In-container server replacement | New server process with observed surviving workers | Survivors keep no duplicate admissions; capacity reuses the lane ceiling across replacement | Continues or held |
| Container restart | New container-init epoch with persistent disk and reservations | Caller epoch handling reconciles reservations; cleanup/restart settles exactly once | Continues or held |
| Interrupted cleanup, before reclamation | Kill between outcome durability and deletion | Failed cleanup durable, visible and retryable; retry repeats no completed external action | Held until recovered |
| Interrupted cleanup, after deletion before settlement | Kill between deletion and durable settlement | Settlement completes on recovery without re-deleting or duplicating | Settled, then held or continued |
| Duplicate/overlapping settlement observations | Two observers report one completion | Exactly-once reservation settlement; ledger comparison matches artifacts | Settled once |
| Uncertain external write | Proof GitHub accepted the real action before the local acknowledgement was lost | Reconcile the original identity; absent receipts never authorize another POST; duplicate counts inspected | Held or settled, never duplicated |
| Post-admission memory breach | Live growth past the predeclared memory budget (#730 follow-up) under real service security settings, neighbor running | Named durable resource cause; neighbor unaffected; actual external actions preserved and reconciled; reservation retained until cleanup is verified | Held |
| Post-admission disk breach | Disposable growth past budget under the same conditions | Same guarantees as the memory breach | Held |
| Unavailable/stale measurement | Probe failure during an admission decision | No admission on unknown state; blocked work wakes through the existing runtime without consuming failure attempts or starting a waiting agent | Waiting, then admitted |
| Cleanup failure with no other releaser | Failed reclamation while no other worker can emit a release | Blocked work still wakes through the existing runtime under the same guarantees | Waiting, then admitted |

A breach is distinct from a person's Stop, an ordinary provider
failure and an unexplained SIGKILL. Cases whose correct result is a
hold end held; an explicitly logged test-control resume is allowed
only where the case row names it, and never counts as an
unattended merge. A regression-only path stays explicitly unproven
in the real run.

An interrupted status alone permits no retry. Caller's existing
`mark_managed_no_write` boundary additionally requires positive resource
settlement and a durable phase before controlled publication. Admitted or
submitting writes stay excluded. The runtime retains that original failed
attempt before admitting another invocation; it does not count the failed
attempt as a completed review. A person's Stop and resource-limit failures
still hold the chain even when no external write occurred. The earlier blanket
Held expectation for parent loss was broader than these existing executable
contracts; retained tests against that expectation record the mismatch rather
than silently claiming a pass.

### Accumulation and return to idle

Repetitions run as one uninterrupted block on the same candidate,
HOME, provider profile, state and cache volumes, with no operator
cleanup between runs. Idle is observed while Poise remains up: ten
minutes after each phase-handoff settlement and thirty minutes
after final settlement, requiring zero idle behavior agents (no
behavior-lane holdings, no behavior-owned processes). Only then is
the replica stopped, and shutdown cleanup is recorded separately.
Settlement receipts are verified against an independent
process and disk inventory covering detached and reparented
children and paths outside the two disposable checkout roots.
Unrelated sessions, required retained evidence, shared
authentication and another behavior's files must remain intact and
usable; deleting them never counts as reclamation.

### Evidence bundle

Each campaign publishes its manifest and the pass/fail/unexercised
matrix in this document. The full bundle — frozen protocol and
manifest, all run IDs and attempts, the complete canonical event
sequence with hashes, correlated Caller, action-plan and
publication receipts, raw timestamped resource samples with
coverage gaps, fault-trigger evidence, and actual GitHub IDs,
heads, queue checks and merge SHAs — is retained under a
campaign `test-results/` path in the validation worktree. Database
exports use a consistent read-only snapshot including WAL files;
both Poise (`server/db.ts`) and Caller use WAL, so copying main
files alone can omit the final settlements under proof. The bundle
is replayed into an empty offline projection and compared against
the independent artifacts across all invocations and
reservations; replay starts no workers and performs no external
actions. The retained bundle is reopened and validated after
replica cleanup. The chain HTTP reader returns only recent
summaries (`server/behavior-chain-api.ts`); a scrape of that API
cannot substitute for the bundle.

### Execution-choice gating

The final campaign runs only on the execution path #732 selected
and recorded above: the current isolated workers, with no adapter
change. That path must satisfy #729 and #731, the #730 budget
follow-up, and its own regression and CI gates before the
campaign. Any future adapter work becomes an explicitly approved
implementation dependency first; until then the native
alternatives stay unproven. This issue performs no adapter
implementation, and a standalone native benchmark never counts as
product acceptance.

### Throughput, latency and coverage rules

The measurement interval runs from first seed admission to last
merge settlement per level, with the declared backlog and arrival
pattern published. The numerator is unique functionally verified
merges; retries and failed attempts charge their elapsed time and
resources to the cohort. The first cycle per level is warm-up:
excluded from steady-state latency, retained in costs. Admission,
queue, service and external-CI waits are bounded separately.
Queue depth and retained invocation history are part of the
envelope: the capacity query traverses invocation JSON across
active chains (`server/behavior-chain-store.ts`), so running
workers alone do not bound admission overhead. Distributions and
uncertainty are published; the candidate must match or beat
baseline useful throughput at each level within measurement
uncertainty with zero lifecycle failures, with equivalent
workload outputs and unchanged required assertions and
build/test gates. The coverage table distinguishes pass, fail
and unexercised per mandatory lifecycle, provider and
execution-path case with run IDs; an unproven mandatory case
permits no generic readiness claim.

### Campaign matrix

| Cohort | Level | Runs | Result |
| --- | --- | --- | --- |
| Baseline retention (this change) | — | Protocol frozen by PR #757; baseline `77976fd9` retained | Pass |
| Baseline merge campaign | 1, 2, 3 (achieved) | Pending #729, #731, budget follow-up | Unexercised |
| Candidate merge campaign | 1, 2, 3 (achieved) | Pending #729, #731, budget follow-up | Unexercised |
| Fault matrix | ≥2 (achieved) | Pending #729, #731, budget follow-up | Unexercised |
| Breach matrix | ≥2 (achieved) | Pending #729, #731, budget follow-up | Unexercised |

Required CI remains authoritative for engineering merges. Resource
readiness cannot be claimed with a missing lifecycle proof or
changed behavior assertions. The replica is stopped and its
disposable behavior resources verified and reclaimed after
evidence capture, preserving the required audit evidence; live
production is never attached, followed repositories are verified
absent from production before seeding and after the campaign, and
production configuration, admissions, defaults and active work
are untouched.

The 3 November candidate `1508cbbbebed14b15d253bf4c058a8a829d4a703`
stopped after its first three real merges: test-repository PRs #114–#116
(`42be7131`, `ca17471f`, `462d9b4e`). Their exact-head approvals, native queue
checks and independent functional assertions passed. All 18 original native
Calls settled, their owned roots were physically absent, and their ten-minute
handoff windows passed. The campaign nevertheless failed its ownership fence:
after PR #116 merged, legacy review admitted Caller
`f0db2bf4b1c24496a1dae11dea4cb9d2`. Its live closed-target check superseded it
before any provider ran or review was posted. It is not a managed review or a
successful lifecycle case. Levels 2–3 and the remaining seven cycles were not
started. The fix retains completed PR provenance in automatic legacy admission
using the existing journal reader; it changes neither manual Chat controls nor
the eligibility of a later standalone PR on a retired branch.

The immutable manifest SHA-256 is
`0cedc250d10ab7a6e7a6badaae390491745a64d12be0666594ce22ae00d5a6fa`.
The manifest, raw inventory, consistent journal/Caller backups, actual GitHub
artifacts, original failing regression and corrected checks are retained in
the validation worktree at `test-results/server-v2-final-1508cbbb-20261103/`.
These three merges are retained evidence, not completion of the frozen
ten-cycle campaign. A corrected candidate requires its own campaign.

### Corrected candidate `fe58f67e` — sealed real campaign

The corrected campaign uses source `fe58f67ef92c066077edd65037e5b500e55f2989`
and immutable manifest SHA-256
`8b3ba7a63abbdb7eed8d037f3899442b4aa56c97e7225971d6bd084851405e30`.
It runs actual Codex 0.166.0 behaviors in the separate service replica, with
zero-bang authoring and llun-ved reviewing in the excluded test organization.
Only settled prior history was retained; the initial 19 Caller IDs are excluded
from new-cycle counts. The operator applied intake labels and performed no
downstream review, implementation, repair, approval or merge actions.

| Achieved level | Seed → actual PR | Confirmed merge |
| --- | --- | --- |
| 1 | 117 → 120 | `232d1aa9511e5fedae74a1d905a12407d5cf803b` |
| 1 | 118 → 121 | `922b9175e5366544c2bf875aa78a26c4eeae6bf6` |
| 1 | 119 → 122 | `ce8d9dc6ffd9fbd24bba3cb0fa263047b2332e1e` |
| 2 | 94 → 123 | `2d1f880e041060f18de14f7bc8b9c4e267b55b83` |
| 2 | 69 → 124 | `17cf07afca642d56e265f24cd6d2018317a8ff29` |
| 2 | 109 → 125 | `af5f854934c902812e74033c4c82a23cdba9d0a6` |
| 3 | 106 → 126 | `6ea2a9086c4ef61119f3541403a71432ab9c1866` |
| 3 | 105 → 127 | `d2730559e129d193397fd13f7475c657145a4217` |
| 3 | 92 → 128 | `8113026d76e9243c63788f3710d8990aef332ef7` |
| 3 | 93 → 129 | `538553769b995d10da7226d56353d2de898a7c20` |

All ten merges have independently verified current-head approval,
successful exact-head and native-queue checks, preserved existing assertions,
passing merged-API assertions and positive original process/disk settlement.
All 60 original Calls pass their ten-minute idle windows. The final 30-minute
idle window also passes with zero remaining behavior processes, unsettled Calls
or reservations. Actual provider overlap is 451.54 seconds at
level 2 and 355.39 seconds at level 3, with the required admitted/unmerged backlog
throughout. Independent observation gaps are retained; the largest interval in
these idle windows is 6.87 seconds. Missing observations are not counted as zero
activity. The 671-event checkpoint rebuilds exactly: 13 chains and 78 invocations
include three prior chains and 18 prior invocations, with zero reservations.
Initial settlement timestamps remain unchanged; replay starts no worker.
All 60 new Caller responses are copied and hashed. All 20 original issue-review
comments match their actual GitHub identities; two older comments on seed 69
remain retained without new credit. The final native queue check passes 3,212
tests, and all 28 independent merged-API checks pass, including older APIs.

The stopped campaign's 317 indexed files reopen and hash-verify from the sealed
bundle, SHA-256 `f07ff66192a3f601349f080b5682a9024b0b6bb5ed82b1f2748829aa1590515c`.
Its archived journal rebuilds to the same 671 events, 13 chains, 78 invocations
and zero reservations, without starting workers or performing live writes.

This is ten verified merge cycles, not full resource acceptance. No repair round
occurred at any level; that criterion remains unexercised. Real fault cases are
kept in a separate cohort, not added to the ten frozen cycles. Paired throughput
comparison remains pending. The 12-CPU/40-GiB replica differs from the retained 4-CPU/8-GiB
baseline, so no matched-throughput claim is made. Production remains untouched.
Evidence is retained at `test-results/server-v2-final-fe58f67e-20261103/` in the
validation worktree, including the unchanged manifest, original receipts,
consistent databases, paginated GitHub evidence, raw inventory and failed reads.

The subsequent fault cohort retained the same resource implementation and
proved real memory/disk breaches with unaffected neighbors, drained container
replacement, maintenance reclamation after the registered cleanup owner's loss,
and admission recovery after an actual unreadable kernel counter. Its seed
145 subsequently reached PR 147 and actual merge
`05cfdf846c83e7dc2f47f4a8a3d93272460181bf`, with all six original Calls positively
settled. These are separate fault results, not new frozen-cycle credit.
PR 146 then exposed two repair-path defects: an executed reply helper could not
see Caller's in-memory scope, and a successfully repaired, freshly reviewed head
could enter another repair solely for its answered but unresolved thread. The
original failures, automatic publication continuations and extra repair are
retained. The corrections above start a new candidate; the sealed campaign is
not relabelled as execution on that candidate. On `039a0bd6`, the original
complex repair reached actual PR 146 merge
`fb09abc1b5fa030c8cbbdc98b6a35bcdeeadfc94`; its current-head approval,
conversation resolution, head checks and native queue checks were verified.
The accepted-response interruption for PR 150 killed its original Caller before
the journal acknowledgement. Recovery retained one original physical Call and
queue admission, reconciled the actual accepted response, and reached merge
`a89103b431e69ddd3ffa61be8ada230120f946c1`. Two neighboring native behaviors
completed normally. The original request/response hashes and first resource
certificates remain unchanged.

The real approval for PR 153 subsequently failed when GitHub rejected an inline
path. Its uncertain submission remains retained, with no retry authorized by
that rejection. Full-diff structured reviews now use the existing diff-line
reader to validate inline anchors before submission, as follow-up reviews
already did; an unanchored finding cannot be dropped or converted to approval.
Regression coverage includes nonexistent paths, invalid lines on both sides,
and reaffirmed unresolved outdated threads.

The separate real 30-second native-action timeout on seed 143 retained the
original uncertain merge invocation without repeating it. Positive process/disk
release followed the timeout by 0.132 seconds; its concurrently running native
implementation completed normally. Person Stop on seed 154 reclaimed its
original worker and directories and held the chain until an explicit test-control
resume. The next real worker was interrupted by killing its entire isolated
container. Replacement preserved all 157 previously settled Caller rows and the
1,706-event journal prefix, started no new physical Call, and retained the
original unreclaimed directory and 2-GiB/512-MiB reservation as uncertain.
That result proves a visible safe hold, not reclamation after lost kernel proof.
These fault observations are retained under
`test-results/server-v2-repair-039a0bd6-20261103/`; they do not replace the pending
matched resource campaign or its per-level repair/throughput requirements.
