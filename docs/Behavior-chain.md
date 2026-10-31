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

Status: the native implementation completed the ten real cycles documented below. The admission cutover and GUI changes carry separate local regression proof; those historical cycles do not prove production cutover. Production execution remains disabled by default.

The existing behavior scheduler consumes one durable journal in Poise's existing database. It admits one atomic invocation for a chain, records its native Caller correlation before starting a process, observes the resulting artifacts, and then decides the next behavior. A chain identifies an issue and its eventual PR; it is not a persistent Chat session or worker.

Intake failures remain visible in runtime health and diagnostics while already-admitted chains continue reconciling and advancing. A stale discovery index cannot suspend execution evidence belonging to existing chains.

## Intake and controls

Settings → General → Behavior chain selects either issues bearing the configured label (default `poise`) or all open issues in followed organizations. Label intake includes old issues that acquire the label. Existing Chat bindings and linked open PRs prevent new ownership; active work is not migrated. The author and review account must be distinct and remain fixed for an admitted chain.

The existing reviewer count, model slots, severity, behavior notes, switches, pauses and PR exclusions remain in effect. Implement Issues and Repair Pull Requests are rows in Behaviors with independent switches, notes, author identity, native activity, run metrics and pause/resume controls. Their switches default on within an enabled chain, preserving the existing execution semantics; they cannot enable the chain itself. Their model slots remain in Settings → Models. A chain can be held or resumed individually. Disabling invocations retains receipts and ownership and continues reconciling already admitted outcomes. Holding or pausing does not terminate an existing worker; its existing native Stop control still applies.

**Switch to v2** is one action in Settings → General → Behavior chain. It records a durable `draining` admission state before any asynchronous work. The existing cooperative release barrier counts behavior operations separately; late legacy launches and prepared chain admissions recheck the durable gate. Running invocations finish, Chats remain usable, and unreadable Caller activity refuses readiness. The existing behavior tick then verifies fresh, complete PR observations across all followed organizations and commits the legacy PR boundary and enabled v2 setting in the same transaction. No new polling system is added.

The chain settings checkbox controls invocations only after the durable cutover completes. The settings API refuses early enablement, and the runtime independently checks the journal's v2 mode before admitting native work. Saving intake settings alone cannot enable coexistence with v1 issue intake.

After completion, v2 owns new eligible seed issues; new legacy issue intake is fenced. Existing PR behaviors continue for PRs outside native chains, including PRs subsequently created manually or by Chats. They recheck canonical chain ownership immediately before acting, so v2-owned PRs cannot acquire a second behavior owner. Existing Chat bindings and linked PRs are not migrated, and standalone PRs do not acquire fabricated issue-chain history. The observed legacy boundary is retained across restart, and the UI labels its count as PRs retained at cutover, not a live remaining count. Cancel cutover is available while draining and records a return to v1; it does not terminate work or reverse a completed cutover. A failed or incomplete observation leaves the drain visible with its error. Ordinary chain pause remains available after cutover and never reopens v1 issue intake.

The chain list displays v2 ownership, actual phase/wait/hold/uncertainty, last recorded outcome and confirmed merge SHA, with links to the issue and PR. More chains and per-chain History/More events page through the existing journal readers. It refreshes on the application's existing refresh clock while General settings is open. Unavailable reads disable cutover controls instead of displaying a confident engine state. Repository/author triggers and the approval-round escape remain explicitly legacy-only; v2 uses its selected label/all-issues intake and never escapes unresolved blockers by approving.

The existing authorized HTTP API supports interactive and headless controls: `GET /api/behavior-chains`, optional `state=active|merged`, cursor `after`, or `id` with an event-sequence cursor; `POST` accepts `id`, current `sequence` and `operation=hold|resume`. Cutover controls instead send the current cutover `sequence` and `operation=switch-to-v2|cancel-cutover`. Reads include `cutover` (mode, sequence, request time, recorded legacy targets and current drain blockers). Summaries/events are paginated. Stale writes fail instead of overwriting a later decision.

## Handoffs and outcomes

1. Each configured issue-review slot must finish successfully and its native receipt must identify an actually posted comment on the current issue revision. Once all required slots satisfy that check, implementation is eligible immediately; no elapsed review delay authorizes it.
2. Implementation reads the actual issue and comments, makes real changes in a fresh checkout and runs the repository's checks. After the model ends, Caller's publication primitive commits, pushes and opens the linked PR. Commit trailers and the PR's chain marker preserve artifact identity across lost responses.
3. Each current PR head receives the configured review invocations. Repairs use a fresh model invocation and the actual review packet, CI evidence and branch state. They publish code and substantive model-written replies to original findings. A new head requires fresh reviews and approval. An unchanged-code repair still requires independent approval verification.
4. Existing native primitives handle grey CI, approved nonblocking conversation resolution, strict readiness, merge and merge-queue admission. Their repository policy leaves a merely behind branch to native queue integration; an actual conflict still requires repair. Completion requires the actual GitHub merge SHA. Queue admission, a finished turn, approval or CLOSED alone cannot complete a chain.
5. A removed queue entry requires its actual GitHub removal event. Failed integration checks or conflicts lead to fresh repair; manual or unknown removal holds for a decision. An unchanged-head repair requires a new independent approval before another native queue attempt. Only that attempt's actual integration result can establish acceptance. Deliberate dismissal of a current-head managed approval is also held.

The chain intentionally does not use the legacy approval-round escape that files remaining findings as a follow-up issue and approves. Unresolved blockers remain blockers.

## Authority and recovery

`behavior_chain_events` is immutable. It owns admissions, phase progression, retry history and ownership. `behavior_chain_current` is a rebuildable index whose state is checked against the authoritative event hash. Admissions and projection updates commit together with SQLite FULL durability. Existing observational behavior ledgers do not authorize this executor.

Admission-mode transitions use `admission.changed` events under the reserved `@behavior-admission` journal identity. They share the immutable log and hashes but are not fabricated issue chains and do not appear in chain pages. Rebuilding chain projections verifies and preserves this durable admission state.

Native Call rows and immutable action plans record effect intent before controlled publication. They provide execution evidence to the journal, not a second phase controller. Unique native correlations prevent duplicate processes from executing the same admission. Worker resource settlement is required before a handoff; a terminal model result is insufficient. A restart or interrupted process is reconciled against the original invocation, pushed branch, posted comments and exact-head review receipts.

The publication primitive validates the checkout and model-written metadata in
read-only mode before Caller records its write intent. Invalid commit subjects,
PR titles, issue-closing references or reply targets fail as unstarted work,
rather than becoming ambiguous writes that never occurred.

Durable model admissions use the existing semaphore's behavior-lane ceiling, including its interactive reserve. A fresh server process cannot fill that reserve with another background invocation merely because surviving workers hold no slots in its new in-memory semaphore. Existing work above a lowered ceiling finishes normally while new admissions wait. The journal's capacity check also precedes provider preparation, so waiting work cannot consume a provider recovery probe without launching; admission still rechecks capacity transactionally afterward.

Known failures before publication retry with bounded backoff and existing provider fallback. Ambiguous writes retain ownership. Confirmed actual artifacts can settle a lost response; missing receipts cannot justify another write. Partially published review/reply plans that cannot be fully reconciled remain uncertain and visible. They are not silently retried or reported successful. This limitation must be exercised and resolved if encountered in the real validation runs.

A repair push checkpoints its exact native head before bounded PR-head
confirmation. If GitHub's PR projection still trails the push, the existing
reconciliation pass can complete the original immutable reply plan once the
head is confirmed and worker resources have settled. The canonical journal
records this continuation before Caller acts; no replacement model starts.
Caller reserves the reply batch before its first POST. A lost or partial
reply POST remains uncertain unless every original reply is found on GitHub;
absence never authorizes another POST. Older receipts without an explicit
unattempted checkpoint do not acquire this recovery authority.

An uncertain grey-CI rerun is inspected through the existing native command in
read-only mode. A later attempt of that exact workflow/head settles its original
admission; an unchanged attempt remains uncertain. A confirmed preflight read
failure is a failed, unstarted action and retries with the existing backoff.

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
| Native worker/parent failure | Observed worker or Caller-parent death | Descendants reclaimed; surviving live descendant reconciled against the original invocation | Held |
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
