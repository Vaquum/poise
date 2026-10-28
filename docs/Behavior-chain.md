# Native issue-to-merge behavior chain

Status: local implementation under validation. Ten unattended real cycles have not yet been demonstrated. Production execution remains disabled by default.

The existing behavior scheduler consumes one durable journal in Poise's existing database. It admits one atomic invocation for a chain, records its native Caller correlation before starting a process, observes the resulting artifacts, and then decides the next behavior. A chain identifies an issue and its eventual PR; it is not a persistent Chat session or worker.

Intake failures remain visible in runtime health and diagnostics while already-admitted chains continue reconciling and advancing. A stale discovery index cannot suspend execution evidence belonging to existing chains.

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
