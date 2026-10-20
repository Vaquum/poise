# Testing and profiling

Poise uses Node 22 (minimum 22.13), matching the workspace image and gateway.
`.node-version`, the root package engine and CI select this line.

## Gates and parallelism

`npm run check` remains the complete local lint, unit/integration and production
build gate. `npm run test:e2e` prepares isolated fixtures, builds the application
and runs Chromium. `npm run verify` runs both.

CI starts lint/types/audit, the production build and two unit/integration shards
independently. Four browser shards start when the build artifact is available;
each runs that artifact without rebuilding it. Every shard owns its runner,
server, databases and fixture directories. Browser shards use one worker each:
real-API fixtures share server state within a shard and some suites are serial.
The four runners provide browser parallelism without changing those contracts.

`Verify (Node 22)` is the stable required check. It runs even after failure or
skip and fails unless every dependency succeeds. The self-update controller
requires this exact aggregate from the trusted CI workflow on the candidate head.
Caller retains its independent Python 3.13 check.

Behavior runtime tests live in responsibility-named `tests/behaviors-*.test.ts`
files. Their common fixture registers the original mocks and per-test lifecycle;
each isolated Vitest file gets its own state and temporary database.

The self-update disconnect regression sends the held request only after public
readiness reaches `busy === 0`. It observes controller entry before closing the
client, then waits for the server response's close event while the handler
remains held and requires total readiness `busy === 1`. It releases the controller
and waits for the middleware to finish before checking rollback and readiness.
Both assertion cleanup and test teardown release the hold and destroy the
request before stopping the runtime, including after the unchanged 20-second
test deadline leaves an event pending.

## Profile a run

CI uploads `unit-timings-1` and `unit-timings-2` (Vitest JSON with per-test
assertion durations), plus `browser-report-1` through `browser-report-4`
(Playwright HTML and JSON with durations, retries and errors). Download them
from the Actions run's artifacts. Compare the slowest shard, not the sum of
parallel job times; GitHub's job steps include install/build overhead.

Local equivalents:

```sh
npm test -- --reporter=default --reporter=json --outputFile=test-results/vitest.json
npm run test:e2e -- --workers=1
# Inspect or reproduce an individual CI shard:
npm test -- --shard=1/2
npm run test:e2e -- --shard=1/4 --workers=1
```

`POISE_E2E_PREBUILT=1 npm run test:e2e` uses an existing `dist/` build. CI uses
this only after downloading the production build from the same workflow run.
Run `npm run build` first when using it locally.

## Motion completion measurements

The Chromium completion guard freezes animation frames while sampling CDP style
counters around synchronous `finishMotion`. A deliberate driver delay exercises
the gap between inspector commands. The guard verifies that all 80 actors are
active at completion, fewer than 10 style recalculations occur, and no actors
remain in motion afterward.

## Analytics performance proof

The merged-detail benchmark prepares the production query and its legacy
reference on one connection, warms both, then measures eight counterbalanced
pairs over identical rows. Assertions and report aggregation stay outside both
clocks. The cost guard compares process CPU time (user plus system) so scheduler
delay cannot masquerade as query work. The optimized CPU median must remain
strictly faster; all elapsed-time samples remain in the diagnostic output.
Full-report equality is checked separately. A native SQLite delegation counts
large-input extraction
calls: the production query must use one per merged row, while the legacy
reference uses more. Restoring the legacy query therefore fails a deterministic
work bound as well as retaining the measured speed comparison.

## Baseline

[Green run 39310158948](https://github.com/autonomio/poise/actions/runs/39310158948)
ran one `Verify (Node 22)` job in 21m27s: static/unit/build took 3m05s and
Chromium took 17m40s, including server setup. All 492 browser tests passed
without retries. The unit/integration phase took 151.04s across 171 files;
`behaviors-runtime.test.ts` alone used 81.18s for 216 tests. Its test expressions
are preserved in the split files. Browser test execution was concentrated in
Chat (219.4s, 148 tests), Analytics (90.0s, 44) and Notices (88.2s, 23).

[Parallel run 39314409471](https://github.com/autonomio/poise/actions/runs/39314409471)
completed all Poise CI jobs in 7m03s from the first job start to the aggregate
completion, versus 21m27s before (67% shorter). Both unit/integration shards
passed all 2,718 tests, including the original 216 behavior cases; their jobs
took 83s and 85s including setup/reporting. The longest split behavior file used
6.76s of assertion time, versus 81.18s for the original file. All 492 browser
tests passed across four shards, with no retries. These are observed runs, not
a fixed performance budget; runner contention and test inventory affect timings.

Local profiling also exposed two load-sensitive test bounds. The bootstrap
process timeout now allows the gate to start before testing descendant cleanup;
the attachment queue test waits separately for both turns, matching the existing
FIFO and native-handoff tests. Both retain their original behavioral assertions.
