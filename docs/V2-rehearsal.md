# V2 rehearsal, steps 1–3

V1 is pinned at `05a70e0b4262601001ab68e3832de54101c198ca`. The v2
candidate is an offline decision and presentation rehearsal. Nothing registers
it with the server, the behavior tick, Chat admission or the browser entry.
It has no executor. Both production defaults stay v1. There is no production
configuration or active-work migration in this change.

## Baseline and retained capabilities

The pinned commit's [full Linux Node 22 run](https://github.com/autonomio/poise/actions/runs/40423761735)
passed static checks, build, both unit/integration shards and all four browser
shards: 4,652 application tests and 870 browser cases. The final functional
[audit](https://github.com/autonomio/poise/issues/669#issuecomment-6429918452)
retains one Editor retry and its earlier failure; it also records 37 real-server
sequences and three supplemental checks. These are separate kinds of evidence.

The local Node 22.23.1/macOS baseline ran all 4,652 application tests: 4,644
passed and eight `chat/turn-stall` cases failed. The retained failures include
command labels truncated at the existing display bound, `/var` versus
`/private/var` canonical paths, a long-command startup wait, and three fixtures
that exceed macOS's filesystem path-length bound. This is not a locally green
baseline; a one-file isolated rerun reproduced all eight failures. The unchanged Linux cases remain required on the candidate; no
assertions, deadlines or platform skips are weakened for this rehearsal.

The local full browser run of the first candidate passed 873 of 874 cases.
The bulk-selection case failed at its Control-click toggle on macOS. An
isolated repeat preserving every assertion and changing only Control to Meta
passed there; the canonical Control case passed in Linux CI without retry.
The original failed report and trace remain retained; this is not presented as
a locally green canonical browser gate.

The functional fixes are actual merges, with successful `Verify (Node 22)`
checks on these exact PR candidates:

| PR | Candidate | Actual merge | CI run |
| --- | --- | --- | --- |
| #702 | `1393ab0235f56b7b38ee5458e356654aa5ae9c6c` | `da9efac41b8e5dcac85779732e020eadc1f36b65` | [40389810138](https://github.com/autonomio/poise/actions/runs/40389810138) |
| #704 | `093e75edb339abf9786e401d6d25d8bc25ed264c` | `05a70e0b4262601001ab68e3832de54101c198ca` | [40421838717](https://github.com/autonomio/poise/actions/runs/40421838717) |
| #706 | `f261437678409b59c2b2dbe4a3a04ad07b518073` | `49f150ac31374f0c437c894eec21579cecb0e08b` | [40403279255](https://github.com/autonomio/poise/actions/runs/40403279255) |
| #708 | `6f17f13c97454722c9fbd45af1dd94a7753a80a4` | `3d3ede01ad1fb76f0a3ea285a99bdf5721ca6b38` | [40406073831](https://github.com/autonomio/poise/actions/runs/40406073831) |
| #710 | `2a46b9dd2749c1d2bdbf12441004348637b12991` | `a742e7f53c1a58c99701d56339100350a528917c` | [40416562190](https://github.com/autonomio/poise/actions/runs/40416562190) |
| #712 | `3a7b2e20e9e6676cc494dd3311c35c216b7109a9` | `f2210770363a5e85f890d1bf512cdffb6e13f78b` | [40421840484](https://github.com/autonomio/poise/actions/runs/40421840484) |

[The refreshed element review](design/interface/review.json) preserves #556's
original row identities, vocabulary, destinations, decisions and reasons. The
recovered artifact actually contains 390 rows, 321 with live IDs and 274
distinct live IDs, including later additions; the old PRD's “270” is not its
current count. Its SHA-256 pins the original input. Group entries map retained
v1 capabilities to the same shared component and existing executable suites.
Mock-only additions and old mock removal decisions are explicitly design
history, not functionality silently added or removed here. #556's frontend
replacement remains independent of this orchestration rehearsal.

The additions section refreshes capabilities introduced after that inventory:
worker charters and Manager controls, explicit/autodiscovered bindings,
release recovery, observation paging, account roles, review caps/recovery,
merge-queue ownership, model slots, Extensions, Settings conflict recovery,
server health and bounded history. The source and executable checks stay with
each entry. Existing tests remain intact.

## Rehearsal boundary

`server/work-rehearsal.ts` contains one advancing function over recorded work
observations and action receipts. Existing `CiObservation` and `WorkTarget`
types are shared without importing a runtime. Admission refusal comes from the
existing behavior policy. The rehearsal does not collect observations, read
GitHub, start a timer, spawn a worker, change a binding or mutate a work item.

`WorkRehearsal` is opened explicitly on the test's isolated SQLite connection.
It appends bounded immutable observations, imported native action receipts and
proposals, with event identity checks and an indexed current projection. Duplicate
triggers retain one proposal. Native receipts pin the issue body revision as
well as a PR head. Late older receipts stay in history without replacing a
newer attempt or retry deadline. Native intent admission time orders attempts
independently of their later settlement times. Restart reads the current observation and receipt,
not retained history. No production database is opened by importing it.
Its unbounded append history is appropriate to a bounded offline recording;
production retention/admission is not implemented or enabled here.

The [observational behavior ledger](Behavior-ledger.md) is not an input to
execution authority. Losing it cannot release an unresolved action. A running
native attempt keeps ownership; an uncertain write requires reconciliation;
a recorded no-write outcome may retry after its existing backoff. A finished
worker requires a new artifact observation. Repeated unchanged observations
cannot substitute for an issue, a PR, completed CI, resolved conversations,
current-head approval or actual merge. A native queue entry retains ownership before CI/review/branch repair proposals. It is a wait.

The new work table is mounted only by the isolated browser fixture, between
Poise's actual Manager Chat component and actual Switchboard pane. It renders
recorded rows and their timestamped history, keeps pre-PR tasks associated with
their later PR, filters by Manager relationship, and renders unread/stale flags
as `?`. It retains the snapshot and error after a failed read. Opening, updating
or resizing it performs no model or work-item action. It adds no polling. Existing Switchboard and sessions-pane resize bounds
include the additional docked table, preserving the Chat floor at their limits.
The regular Chat composer, permissions, questions, timers, Stop and worker
navigation are the existing controls. This proves the composition without
publishing an alternate browser entry or enabling a live task trial.

## Compared behavior and intentional differences

| Observation / obligation | Existing v1 path | Rehearsal decision and check |
| --- | --- | --- |
| Assigned Plan, captured Markdown/chat context | Current card and explicit issue creation | Propose issue creation; observed issue URL is required before issue review |
| Issue body and completed reviews | Existing issue-review panel and Chat implementation | Review current body revision, then propose implementation; a changed body needs review again |
| New PR and configured review panel | Existing head-pinned panel, claims and Caller | Same review obligation and head; paired fixture checks all three panel widths and duplicate suppression |
| CI running | Independent v1 new-PR review may run already | Deliberately wait before review; repair failed/stuck CI first; waiting launches nothing |
| Grey CI eligible | Existing direct rerun behavior / durable intent | Propose that existing operation, retaining uncertain receipts |
| Review changes / unresolved threads | Existing work monitor and resolution behavior | Propose fixes, current-head review and approval, then strong conversation resolution; the existing resolver requires that approval, and unknown coverage cannot mean clear |
| Behind / conflicts | Existing branch-update and monitor paths | Repair conflicts; preserve native merge-queue policy instead of updating queue-enabled branches |
| Current-head approval and readiness | Existing native merge behavior | Propose merge only with both; queued is waiting, closed alone is unverified, observed merge SHA is completion |
| Stop, permission, question, timer and draft | Existing interactive Chat controls | Identical controls/assertions with and without the rehearsal table; headless requires no Manager |
| Existing v1 ownership / interrupted or uncertain attempt | Existing binding and durable native receipts | Keep owner or inspect the exact receipt; never adopt from an absent observer row |

The new behavior is the sequencing of bounded work proposals, not replacement
implementations of Caller actions. Native mutation gates are still guarded by
the existing behavior/Caller tests. The paired test executes v1 using the
existing isolated behavior fixture, then feeds the same target/head/policy facts
to v2 and verifies v2 adds no CLI calls or launches. New stages use isolated
artifact recordings; no production task was run through them.

## Reproduction

Use Node 22 and the repository's existing CLI/home isolation:

```sh
npm ci
npm run check
npm run test:e2e -- --workers=1
npx vitest run tests/work-rehearsal.test.ts tests/work-rehearsal-parity.test.ts --maxWorkers=1
npm run test:e2e -- tests/e2e/work-rehearsal.spec.ts --workers=1
```

The decision tests cover both headless and interactive modes, all proposed
stages, changed heads, conflicts, failed/stuck CI, unknown facts, active ownership,
Stop, receipt uncertainty, safe no-write retry, restart and deduplication.
Browser tests run the same control assertions against v1 and the rehearsal
composition and retain the table's measurement attachment.

The load checks use 10,000 retained journal events with 100 repeated decisions,
and 100 visible tasks with 2,000 retained transitions. Current state uses its
primary-key index; repeated proposals add one event. The checks keep their
one-second budgets. These are offline recording and rendering measurements.

The separate [service-mode HTTP replay](https://github.com/autonomio/poise/issues/669#issuecomment-6424583316)
retains all 1,800 successful requests and fixed worst p99/max 163.1/273.2 ms,
plus its failed background test processes and limited workload/pressure. It did
not reproduce or attribute the original multi-second stall. The later action
load audit retains its three Chat completion timeouts, early Settings read,
background failures and missing service-health route; its 300 HTTP404s are not
latency proof. The two runs are not combined into incident-recovery evidence.
The owner accepted the prerequisite and directed this work to proceed; the
retained limitations are not reintroduced as an execution hold.

Steps 4–5, production execution, live admissions, migration, default flips and
v1 removal are outside this proof and require the next discussion.

The subsequent [local sandbox validation](V2-sandbox-validation.md) exercised
real GitHub CI, reviews and native queue merges using scripted workers in an
excluded organization. It records its approval-order fix and remaining limits.
