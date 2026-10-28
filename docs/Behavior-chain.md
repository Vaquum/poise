# Native issue-to-merge behavior chain

Status: local implementation under validation. Ten unattended real cycles have not yet been demonstrated. Production execution remains disabled by default.

The existing behavior scheduler consumes one durable journal in Poise's existing database. It admits one atomic invocation for a chain, records its native Caller correlation before starting a process, observes the resulting artifacts, and then decides the next behavior. A chain identifies an issue and its eventual PR; it is not a persistent Chat session or worker.

## Intake and controls

Settings → General → Behavior chain selects either issues bearing the configured label (default `poise`) or all open issues in followed organizations. Label intake includes old issues that acquire the label. Existing Chat bindings and linked open PRs prevent new ownership; active work is not migrated. The author and review account must be distinct and remain fixed for an admitted chain.

The existing reviewer count, model slots, severity, behavior notes, switches, pauses and PR exclusions remain in effect. Issue implementation and PR repair have model places in the existing model settings. A chain can be held or resumed individually. Disabling admissions retains receipts and ownership and continues reconciling already admitted outcomes. Holding new invocations does not terminate an existing worker; its existing native Stop control still applies.

The existing authorized HTTP API supports interactive and headless controls: `GET /api/behavior-chains`, optional `state=active|merged`, cursor `after`, or `id` with an event-sequence cursor; `POST` accepts `id`, current `sequence` and `operation=hold|resume`. Reads return bounded summaries and pages. Stale control writes fail instead of overwriting a later decision. No new poller is introduced.

## Handoffs and outcomes

1. Each configured issue-review slot must finish successfully and its native receipt must identify an actually posted comment on the current issue revision. Once all required slots satisfy that check, implementation is eligible immediately; no elapsed review delay authorizes it.
2. Implementation reads the actual issue and comments, makes real changes in a fresh checkout and runs the repository's checks. After the model ends, Caller's publication primitive commits, pushes and opens the linked PR. Commit trailers and the PR's chain marker preserve artifact identity across lost responses.
3. Each current PR head receives the configured review invocations. Repairs use a fresh model invocation and the actual review packet, CI evidence and branch state. They publish code and substantive model-written replies to original findings. A new head requires fresh reviews and approval. An unchanged-code repair still requires independent approval verification.
4. Existing native primitives handle grey CI, approved nonblocking conversation resolution, strict readiness, merge and merge-queue admission. Their repository policy leaves a merely behind branch to native queue integration; an actual conflict still requires repair. Completion requires the actual GitHub merge SHA. Queue admission, a finished turn, approval or CLOSED alone cannot complete a chain.
5. A removed queue entry requires its actual GitHub removal event. Failed integration checks or conflicts lead to fresh repair; manual or unknown removal holds for a decision. An unchanged-head repair requires a new independent approval before another native queue attempt. Only that attempt's actual integration result can establish acceptance. Deliberate dismissal of a current-head managed approval is also held.

The chain intentionally does not use the legacy approval-round escape that files remaining findings as a follow-up issue and approves. Unresolved blockers remain blockers.

## Authority and recovery

`behavior_chain_events` is immutable. It owns admissions, phase progression, retry history and ownership. `behavior_chain_current` is a rebuildable index whose state is checked against the authoritative event hash. Admissions and projection updates commit together with SQLite FULL durability. Existing observational behavior ledgers do not authorize this executor.

Native Call rows and immutable action plans record effect intent before controlled publication. They provide execution evidence to the journal, not a second phase controller. Unique native correlations prevent duplicate processes from executing the same admission. Worker resource settlement is required before a handoff; a terminal model result is insufficient. A restart or interrupted process is reconciled against the original invocation, pushed branch, posted comments and exact-head review receipts.

Durable model admissions use the existing semaphore's behavior-lane ceiling, including its interactive reserve. A fresh server process cannot fill that reserve with another background invocation merely because surviving workers hold no slots in its new in-memory semaphore. Existing work above a lowered ceiling finishes normally while new admissions wait.

Known failures before publication retry with bounded backoff and existing provider fallback. Ambiguous writes retain ownership. Confirmed actual artifacts can settle a lost response; missing receipts cannot justify another write. Partially published review/reply plans that cannot be fully reconciled remain uncertain and visible. They are not silently retried or reported successful. This limitation must be exercised and resolved if encountered in the real validation runs.

## Acceptance boundary

Local unit/integration tests use explicit isolated stand-ins to protect contracts. They are not the requested acceptance proof. Historical dispatcher-driven runs in [the archived report](V2-real-cycle-validation.md) are excluded.

The acceptance run must use the production image, entrypoint and supervisor with separate local state and authorized alternative GitHub identities, following only an organization excluded from production. Only the ten seed issues are created manually. Actual behaviors must produce every subsequent comment, implementation, PR, review, repair and native merge without an external dispatcher or phase toggling. Any operator intervention to advance a stalled phase invalidates that unattended run and is retained as a failure. The source candidate, native receipts, artifacts, exact-head CI, actual merge SHAs and production-boundary observations must be recorded before declaring completion.

The first native attempt at `01c1998d` found a real intake failure: issues #27–#36 had their `poise` labels on GitHub, but the existing datastore did not capture label evidence. Zero chains and zero workers were admitted. That attempt is retained as failed. The reader now captures complete GraphQL label connections, refuses missing label evidence, and backfills old open issues through the existing sync/full-refresh path without editing the issues or adding a poller. A subsequent uninterrupted run is still required.

The `10fa17d4` run then posted real issue reviews and implemented #27 as PR #37, with green exact-head CI. Its PR-review admission failed before Caller tracking because a relative PR reference could not identify a repository from an empty interface directory. This candidate is not accepted as a completed run. Native PR requests now use absolute URLs; recovery qualifies an older relative reference against its immutable chain identity, preserving its admission and correlation. Native process exits are retained, and an exited process without a Call receipt becomes uncertain rather than silently respawning. Existing work must continue through the behaviors; no operator review, repair or phase advance substitutes for it.

The same candidate also allowed one legacy review of PR #38 before its next chain observation recorded the new PR number. That extra review remains evidence of a failed ownership boundary and does not satisfy a managed review slot. PR admission and Chat binding now recognize the branch reserved in the canonical chain, using existing datastore head identity. Unknown head evidence in a repository with active chains refuses legacy admission; matching branch names in another head repository do not claim ownership.

The implementation of #34 exhausted an unintended PR-review cap: the caller requested an hour but its budget context silently capped that at 1,413 seconds. Atomic implementation/repair now uses its requested hour, including the existing publication reserve. Its registered writer gate also consumes the existing provider activity and quota observers; it does not wait out the entire work budget on a provider reconnect loop. Both failed and successful native work run through existing strict resource settlement before a subsequent behavior can start. The original timeout remains a failed attempt, not completed work.

The in-place switch to `83eab4ed` preserved three active Call IDs and PIDs but admitted a fourth background worker: durable capacity used the total check cap instead of the behavior lane's reserved ceiling. That failed reserve check remains recorded. Admission now reuses the existing lane ceiling across process replacement rather than duplicating its reservation policy.
