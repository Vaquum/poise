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

The Analytics midnight browser regression observes each selected day's exact
year-history bounds and organization scope, then waits for the history charts
to render before navigating again or checking read counts. Selected-day request
admission precedes its response and the deliberately deferred history read; it
is not a completion signal. The original pace, calendar, request-count and
midnight deduplication assertions remain intact.

The review/approval ownership regression separates durable review reconciliation
from the following eligibility sweep. The two behaviors run concurrently, so
approval may observe the still-owned review before reconciliation settles it.
The test keeps its no-overlap and exactly-one-approval assertions.

## Agent tool CPU defaults

Repeated agent tooling runs through native caches and bounded parallelism.
The three typechecks run incrementally, each with its own build-info file
under `node_modules/.cache/poise/`, outside `dist`, so `npm run clean`
keeps them. `npm run lint` caches by file content at
`node_modules/.cache/poise/.eslintcache`. The caches are disposable and
checkout-local; CI runs cold with no shared cache between jobs.
`npm run lint:uncached` and `npm run typecheck:uncached` keep the uncached
invocations. The lint cache stays valid only while the rules need no
compiler type information; `tests/tool-cache-config.test.ts` names the
markers that must revisit the cache.

Every child Poise starts also observes two tool defaults
(`server/process.ts`): `GOMAXPROCS=2`, which only Go runtimes read, and
`RIPGREP_CONFIG_PATH` pointing at `scripts/agent-tools.ripgreprc`
(`--threads=2`). An inherited or explicitly passed value always wins, and
an explicit undefined removes the variable. Explicit ripgrep flags override
the config file; `--no-config` and provider-embedded search bypass it.
Caller passes both on to provider CLIs through its inherited environment,
and the runtime smoke contract checks the shipped config parses.

Measured on a Linux container with 12 vCPUs (Node 22.23.4, TypeScript
5.9.3, ESLint 10.6.0, ripgrep 13.0.0, esbuild 0.28.1). CPU seconds are user
plus system as reported by `time`:

| Workload | Condition | Elapsed (s) | CPU (s) |
| --- | --- | ---: | ---: |
| Lint, all files | Uncached | 41.56 | 33.88 |
| Lint, all files | Warm content cache | 13.75 | 7.49 |
| All three typechecks | Uncached | 82.47 | 64.99 |
| All three typechecks | Warm build info | 25.86 | 22.44 |
| Complete build (clean, typecheck, client, server) | Cold caches | 110.18 | 65.07 |
| Complete build (clean, typecheck, client, server) | Warm caches | 43.43 | 34.08 |

A mixed batch of 80 whole-repo searches plus 32 six-entry esbuild bundles
over 12 search and 12 build lanes, alternating conditions, with sampled
peak RSS of the `rg` and `esbuild` processes:

| Run | Elapsed (s) | User (s) | System (s) | Peak RSS (KiB) |
| --- | ---: | ---: | ---: | ---: |
| Default | 15.23 | 24.31 | 96.10 | 426924 |
| Candidate | 12.99 | 40.74 | 29.81 | 151076 |
| Default | 8.39 | 13.28 | 61.33 | 334352 |
| Candidate | 16.17 | 49.39 | 26.35 | 155388 |
| Default | 11.87 | 20.25 | 74.32 | 325500 |
| Candidate | 13.01 | 36.99 | 25.37 | 163960 |

A single whole-repo search measured 0.24 to 0.26 seconds elapsed with
default threads and 0.35 to 0.57 seconds with two threads; a single
six-entry esbuild bundle measured 0.06 seconds elapsed with and without
`GOMAXPROCS=2`.

Cached and uncached typecheck and lint report identical diagnostics,
stable across repeats, with clean recovery after the error is removed;
every diagnostic exit stays nonzero (the incremental typecheck exits 1
where the uncached one exits 2). Eighty searches per condition produced
identical match sets and exit statuses, and 32 bundles per condition
produced identical bytes apart from the harness's per-run fixture path in
a source comment.

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

The provider refresh retry case runs three complete process refreshes and has a
30-second case budget, three times the unchanged ten-second single-refresh
budget. Its case-owned fixture forwards the case abort signal to the runner,
awaits every owned runner's closure before removing its root, and refuses new
work after cleanup. A held-updater regression verifies that abort also stops the
native updater group. The global test deadline and production updater/discovery
deadlines remain unchanged.

`tests/chat/message-queue-runtime.test.ts` drives the real Chat runtime against
real git repositories, and most of its cases run several turns. Under suite
load one git or SQLite step can stall past eight seconds, so the file gives
each readiness wait 20 seconds and each case and hook 25 seconds
(`vi.setConfig`), instead of the global 10 seconds in `vitest.config.ts`, which
stays as it is. One of its cases fails, naming the case, if any case's timeout
differs from 25 seconds.
