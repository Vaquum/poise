# Error-state handling contract

Status: normative state/transition contract for Poise and Caller.
Scope: general invariants for how error states are defined, propagated,
contained, recovered and reported. It does not add message-specific
exceptions; per-message paragraphs in existing docs are examples of this
table, not a second source of truth.

Single source: [Behavior integration contract](Behavior-Contract.md) keeps
the behavior transaction shape, [Behavior ledger](Behavior-ledger.md) keeps
the read-only firing vocabulary, and [Caller](../caller/README.md) keeps
the CLI wire facts. This file is authoritative for the shared state
vocabulary and its certainty, retryability, recovery authority, deadline
and escalation columns. Where code does not yet meet an invariant, Known
gaps names the violation; docs describe what runs.

## 1. Units

- **Operation** is one launch claim: a scheduler or replay admission with
  behavior, target, actor, source, correlation ID and expected head,
  persisted before detached work starts
  (`server/behaviors.ts`, `BEHAVIOR_CLAIM_RENEWAL_MS`). Direct resolve,
  merge and CI-rerun invocations are operations with their own firing and
  run-ledger receipt.
- **Target** is the work the operation acts on: a pull request or issue
  plus its current head (PRs) and slot (`target:secondary` panel scope).
  Eligibility is the shared scheduler/replay predicate per target kind
  ([Behavior integration contract](Behavior-Contract.md#replays)).
- **Ledger state** observes operations and never drives them: `running`,
  `held`, `unknown`, `pending`, `failed`, `superseded`, `completed`, with
  a separate `activity` of `running`, `settled` or `unknown`.
  Held/failed never by itself proves idle.

## 2. Columns

- **Ownership** names the resource holder and what proves release after
  throw, cancel, timeout or process loss.
- **Side-effect certainty** is `none_proven`, `uncertain` or `landed`.
  Only typed fields decide it; error prose never does.
- **Retryability** names the precondition for another attempt: changed
  input, a recovered dependency, a reconciled receipt, or no one
  (quarantine).
- **Recovery authority** enumerates who may move each state: scheduler
  automatically, the operator retry API, a Swarm replay, a head change, a
  model change, Caller reconciliation, or no one.
- **Deadlines** nest: a child wait never outlives its parent's remaining
  deadline, and every wait accepts the parent's cancellation. A timeout
  either cancels the child or keeps owning its resources until it settles.
- **Terminal** means no automatic transition remains. Silence is never
  terminal: every state has bounded recovery and escalation, including an
  explicit parked-by-owner state with expiry rather than indefinite quiet.

## 3. Invariants

| ID | Invariant | Status today |
| --- | --- | --- |
| E1 | Every behavior follows one transaction shape: fresh-consumer gate, immutable fact packet, persisted launch intent, model work through permitted primitives, reconcile by exact correlation ID, dead-letter uncertain terminal work. | Holds ([Behavior integration contract](Behavior-Contract.md), steps 1-6). |
| E2 | Never retry an ambiguous side effect. Reconcile receipts before retrying uncertain writes. | Holds as policy; gaps in typed certainty (E4) and per-operation idempotency (E14) weaken it. |
| E3 | Proven no-action failures are distinct from unknown publication outcomes. A grey no-action incident needs one validated Caller row with `not_started`/`preflight_failed`, pinned head and no receipts; classification never authorizes a retry. | Holds for the incident rule; Caller proof paths are prose-coupled (G2). |
| E4 | Every terminal Caller result carries typed certainty and the server decides retryability only from typed fields. | Gap G2: `budgetExhaustedProvenNoAction`, `boundedReviewFailure` and `reviewAccountFailure` read `call.error` prose. |
| E5 | Bounded resource ownership: every resource in §4 is released on throw, cancel, timeout and process loss, with restart reconciliation. | Partial: release paths exist; restart over-admission and clock nesting are gaps G5-G6. |
| E6 | Fair progress: one failing or hanging target occupies at most one slot per behavior and its retries are rate-limited, so an unrelated eligible target is admitted within one sweep plus its preparation bound. | Partial: per-PR locks, batch cursors and small pools isolate targets; a hung worker holds its slot until exit (G5). |
| E7 | Timeouts cancel the child or keep owning its resources; cancelled and expired waiters never run callbacks. | Gap G6: `waitForBehavior` abandons work instead of cancelling it. |
| E8 | Completion observed wins over a deadline that fired afterwards. | Gap G7: `serializeBehaviorOperation` reports finished work as failed when the signal fired first. |
| E9 | Every failure is classified by what a retry depends on: input-determined, dependency-determined, or uncertain side effect. | Gap G3: bounded per-target holds are per-code, with carved-out exceptions. |
| E10 | Dependency recovery releases every target held on that dependency through one probe per window; input-held targets stay held. | Partial: the reviewer trip is half-open with a single probe per window; per-target dependency holds do not release this way (G3). |
| E11 | Pipeline health reflects eligible-work age and delivered progress. Targeted holds degrade health. | Gap G4: `scopedBehaviorsRuntimeHealth` returns `ok` while every target is held. |
| E12 | Every blocked target has an actionable explanation. | Partial: `pr-status` carries a closed blocker vocabulary, but flags are display-only and never alert or release. |
| E13 | Component failure is distinct from intentional admission pauses, including upgrade drains; each pause exposes owner, progress and deadline. | Gap G8: no shared pause vocabulary with owner/progress/deadline. |
| E14 | Every operation declares idempotency under a pinned precondition, non-idempotency with receipt reconciliation, or unreconcilable hold-and-escalate. | Gap G9: merge SHA-pinning is unstated; grey-CI, merge and resolve handle the same unknown outcome three ways. |

## 4. Resource ownership and fair progress

| Resource | Owner | Release guarantee |
| --- | --- | --- |
| Check semaphore slots (`server/behaviors.ts`) | Claiming behavior | Released when the claim drops; detached workers that survive Poise are not re-charged after restart (G5). |
| Process locks (`server/process-lock.ts`) | Local path queue plus SQLite reservation | Queueing and SQLite acquisition share one timeout; cancelled and expired waiters never run callbacks; callback or acquisition failure releases both. |
| Review checkout locks and provisioning (`server/review-checkout.ts`) | Launch phase after the claim | Provisioning failures release the claim with `preflight_failed`; retention pruning runs hourly. |
| Caller `checkout_lock.py` / `lease_gate.py` | Caller lease holder | Interruptible acquisition with orphan detection; worker loss without proven release raises `WorkerOrphaned`. |
| Launch claims and replay reservations | Scheduler tick or replay request | Claims renew up to `BEHAVIOR_CLAIM_RENEWAL_MS`; replays reserve ten minutes and release on refusal. |
| Behavior pools and per-PR operation locks | Sweep or direct run | Per-account cursors resume past blocked batches; one PR batch error holds only its targets. |

Fair progress is measurable per E6. Shared asynchronous preparation may
still release continuations together; that is not a throughput guarantee.

## 5. Proven no-action versus uncertain

- `none_proven` requires exact evidence: the expected Caller row, pinned
  head, no executed head and no review/posting receipts, plus live GitHub
  inventory proving no unclaimed or pending publication before an explicit
  retry.
- `uncertain` requires live receipt reconciliation first, never a blind
  retry; escalate after bounded failed reconciliations.
- `landed` is adopted from receipts; a retry after a lost response
  observes the landed state and does not mutate again where the operation
  is idempotent under its pinned precondition (see G9 for the unstated
  cases).
- Diagnostic reading grants no new execution or replay authority.
  Historical Caller v1 diagnostics may omit outcome, stderr or truncation
  facts; those read as null while retaining submission uncertainty and the
  failed lifecycle. Present malformed fields and unsupported versions stay
  quarantined.

## 6. Recovery and escalation

- Input-determined failures (same packet plus same model yields the same
  result) recover only through changed input, a different model, or a
  human; they surface as Needs you with that action named.
- Dependency-determined failures (provider 429/5xx, budget or capacity,
  account balance/sign-in, lock contention, datastore staleness) hold on
  the dependency, recover through one probe per window, and release every
  target held on that dependency when the probe succeeds.
- Uncertain side effects reconcile from receipts, hold visibly while
  ambiguous, and escalate after bounded attempts.
- Held targets count as eligible-and-waiting for health; excluding them
  hides exactly the stranded work this contract exists to surface.

## 7. Pipeline health

Health reports liveness plus delivery:

- **Metric:** age of the oldest eligible target with no delivered outcome
  since it became eligible on its current head, plus the count of targets
  past a bound, computed with the shared scheduler/replay eligibility
  function so the metric cannot drift from admission.
- **Delivered progress:** reconciled terminal outcomes with receipts per
  hour versus eligible arrivals. Thresholds and the durable alert path are
  part of the definition; a human-parked target uses the explicit parked
  state with expiry rather than silence.
- **Liveness:** the tick-fire stamp stays liveness only; a separate stamp
  records the last sweep that delivered or reconciled something.

Current `status: 'ok'` does not meet this definition (G4).

## 8. State mapping

| Existing state | Contract column |
| --- | --- |
| Caller `model_output_limit`, `review_budget_exhausted`, `review_recovery_failed`, `review_contract_violation`, `review_provider_blocked`, `stopped` | Bounded same-head/model hold until head, model or operator changes it (`boundedReviewFailure`); budget-exhausted with proven no-action retries on backoff (`budgetExhaustedProvenNoAction`, prose-coupled in G2). |
| Caller `review_provider_error`, `review_provider_exit` | Reviewer trip, provider kind, before a verdict with nothing posted. |
| Caller `review_packet_too_large` | Held on unchanged input and model; oversized packets do not retry blindly. |
| Caller `review_submission_failed`, `submission: uncertain`, duplicate-verdict and malformed-verdict paths | Uncertain: reconcile from live receipts before any retry; contract violations hold. |
| Caller `review_target_closed` | Native terminal closure: settles the obsolete panel without claiming publication or worker termination. |
| Caller `not_started` / `preflight_failed`, `launch_preflight_failed` | No-action proof candidates under E3; missing, conflicting or quarantined evidence stays under Needs you. |
| Caller `stopped`, `stopping`, `interrupted`, `atomic_work_failed` | User stop holds like a bounded failure; process loss closes direct runs as `interrupted`, outside the success rate with unknown duration. |
| Server `overloaded`, `rate_limit`, `server_error`, `authentication_failed` | Classifier-only codes Caller never writes; provider 429s arrive as `review_provider_exit` or untyped text (G2). |
| Ledger `running`, `held`, `unknown`, `pending`, `failed`, `superseded`, `completed` plus `activity` | Observation only; native settlement overrides passive Caller observations. |
| Dead letter `resolved`, `superseded`, `held` plus quarantine | Resolved and superseded rows retire; held rows stay open; quarantined rows are never resolved or superseded. |
| Datastore freshness gate (120 s), `unavailable` versus stale | Admission pauses scheduling until an ordinary sync passes; bounded lock-admission deferrals stay distinct from ownership corruption and shared failure. |
| Diagnostics: Poise faults, Needs you, Handled automatically | Severity groups presentation only; severity changes no launch, retry, ownership or publication rule. |
| Repository access holds and reviewer trips | Access holds are per repository and actor with hourly recheck; reviewer trips are per reviewer with backoff and a single probe per window. |

## 9. Regression obligations

Slices implement these combined scenarios against the existing fake CLIs
with a fake GitHub that records writes. No slice invents a parallel
contract; each enforces one row of this table:

1. Provider refusal on reviewer A plus a hung lock holder plus an
   unrelated PR: the unrelated PR reaches a terminal outcome within the
   E6 bound.
2. Kill the server between Caller publication and receipt persistence,
   then restart: reconciliation adopts the landed review and the fake
   GitHub shows exactly one write.
3. Cancel during lock acquisition and checkout provisioning: no callback
   runs and no lock, claim or semaphore slot leaks.
4. Dependency recovers: one probe releases every target held on that
   dependency and none held on input.
5. Error-prose mutation: changing `call.error` wording does not change
   any retry decision.
6. Hold every target: health reads `degraded` with the oldest
   eligible-and-waiting age and count.

A CI check parses the §8 table and fails when Caller or the server
introduces an `error_code` the table lacks, so the exception list cannot
grow back silently.

## 10. Known gaps

| ID | Current behavior | Required by this contract | Slice hint |
| --- | --- | --- | --- |
| G1 | Incident postmortem lives on a private workspace page; the 89% figure has no recorded definition or baseline. | Inline the timeline, metric definition and per-cause breakdown in the issue or a repo doc; derive the §9 matrix from observed causes. | Docs follow-up to #691. |
| G2 | Certainty and retryability come from error prose: the `could not prove a safe recovery` suffix, `reviewAccountFailure` regexes, `boundedReviewFailure` regexes, and safeguards-flag matching. `submission` exists on some paths and is missing or wrong on others. | E4: typed `submission` on every terminal Caller result; server retry decisions read only typed fields. | First runtime slice: typed certainty. |
| G3 | Bounded holds are per-target per-code with carved-out exceptions; safeguards refusal scope is undecided. | E9-E10: input versus dependency versus uncertain classification with dependency-level probes. | Depends on G2; #670 waits for this axis. |
| G4 | `scopedBehaviorsRuntimeHealth` returns `ok` while every target is held; the liveness stamp is taken before any work runs. | E11-E12 and §7: eligible-work age, delivered progress, per-target blockers, separate delivery stamp. | Health slice; feeds #675 and #676 instead of parallel signals. |
| G5 | Shutdown releases check slots while detached workers survive; restarts do not re-charge them. Hung workers hold slots up to claim renewal; Caller orphan reaping and review budgets use unrelated clocks. | E5: explicit nesting for slot, claim, orphan and budget clocks with restart reconciliation. | Resource-ownership audit. |
| G6 | `waitForBehavior` races the operation against cancellation and leaves the underlying promise running; some checkout lock waits do not receive the caller's signal (#692). | E7: a timeout cancels the child or keeps owning its resources. | Generalize #692. |
| G7 | `serializeBehaviorOperation` throws the abort reason even when the operation already completed. | E8: observed completion wins over a later deadline. | Narrow correctness slice. |
| G8 | No shared pause vocabulary with owner, progress and deadline. | E13: distinguish component failure from admission pauses including upgrade drains. | Health/pause slice. |
| G9 | Grey-CI holds on any post-claim exception, merge records `unknown` then retries on backoff, and resolve follows merge; lock contention and post-write kills share one timeout regex. | E14: explicit per-operation idempotency column with pinned preconditions. | Idempotency audit. |
| G10 | Direct runs record `unknown` in the ledger but `finishDirectBehaviorRun(runId, false)` counts them as failed in success-rate metrics. | Unknown stays unknown in E11 progress accounting. | Metrics slice. |
| G11 | Recovery canary hit eleven native Chat fixture timeouts on its first full queue run; the next complete integration passed 4,646 tests and every browser shard without test, deadline or gate changes. | Preserve both queue evidences and isolate fixtures so one native process failure cannot cascade. | Fixture isolation slice. |
| G12 | Three unexpected application exits, including SIGBUS, remain unexplained; current free disk and zero current-container OOM kills do not establish historical causes. | Preserve process and filesystem causes and verify restart reconciliation. | Restart-recovery slice. |

Overlapping work stays explicit: #673 (budget exhaustion staging), #675
(idle slots and progress health), #676 (per-PR age and blocker), #688 and
#669 (CPU and event-loop starvation), and #692 (lock and cancel
containment) each change transitions in §8 and must cite the row they
enforce rather than define parallel semantics.

## 11. Evidence preserved

- Controlled cross-repository verification: Poise #698, Mimicry #10 and
  Mimicry #12.
- Failed queue with eleven native Chat fixture timeouts and the next
  green queue with 4,646 tests and every browser shard green, without
  test, deadline or gate changes (see #691 for run links).
- Bounded 50 ms datastore-lock admission deferrals retained after #694
  while other reviews, approvals and merges continued: deadline expiry
  stayed distinct from ownership corruption and shared failure.
- Malformed review verdict on Poise #680 failed safely before publication
  while independent work completed.
- Actor-specific repository-access hold on `Vaquum/Briefing#6`
  (`bit-mis` receives `NOT_FOUND` while the author can read it):
  access recovery stays distinct from unchanged-input holds and names the
  affected authority.
- Six historical Caller diagnostics with v1 omissions stay readable as
  partial evidence under §5 instead of withholding all aggregate agent
  metrics.
