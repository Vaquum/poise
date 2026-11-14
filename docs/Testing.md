# Testing and profiling

Poise uses Node 22 (minimum 22.13), matching the workspace image and gateway.
`.node-version`, the root package engine and CI select this line.

## Gates and parallelism

Most runs use only the essential tests. The whole suite runs on a sample of
merges.

`npm test` and `npm run test:e2e` run the essential tests. `npm run check` is
lint, those tests and the production build, and `npm run verify` adds the
browser tests. `npm run test:full` and `npm run test:e2e:full` run everything.
A command that names tests runs exactly those, such as
`npm test -- tests/chat/runtime.test.ts` or
`npm run test:e2e -- tests/e2e/chat.spec.ts`. Flags alone steer the essential
run, and the word after a bare flag counts as its value, as in
`npm test -- --reporter dot`.

Local browser runs serialize one at a time per workspace: `npm run test:e2e`
holds the lock from before its build (`scripts/with-e2e-lock.mjs`), and a bare
`npx playwright test` takes the same lock in `globalSetup` after its webServer
build, so either may wait for another run to finish. CI shards skip it and run
concurrently by design.

### The essential tests

Agents, PR checks and merge-queue candidates run the same set, which
`.github/workflows/ci.mjs` chooses:

- Lint, all typechecks and the production build.
- [`tests/essential.txt`](../tests/essential.txt): the tests that guard
  security, agent spend and PR actions, data loss and release safety, and the
  whole-repository wiring tests an import link cannot reach. A new test that
  guards one of those belongs in this list. A delegated self-update change may
  not edit it.
- Any test the change edits, and any test that directly imports a changed file.
  One step only: following imports further selects most of the suite.
- The core browser journeys (`service-mode` and `ui-frame`), any spec the change
  edits, and the browser suites mapped to a changed frontend area. Each place of the new
  interface (`src/ui/places/`, and setup) maps to its own `ui-` specs. A path
  outside those areas adds no browser suite.

CI compares a PR or queue candidate with its base and uses one unit shard,
and one browser shard for about every 80 selected browser tests, up to six, so
the browser tests finish beside the unit tests. Locally the comparison is with
`origin/main`, including uncommitted and untracked work, and the command
stops with a message if it cannot reach `origin/main`. While `main` is being
merged in, the comparison is with its side, so what it brings does not count as
the change.

A change to dependencies, test or build configuration, CI or
`tests/essential.txt` runs everything in CI, because it can change what every
test proves. Documentation-only changes omit application jobs. Caller omits
Python work for frontend/browser/documentation-only PR changes; shared and
unknown paths still run it. Every merge-queue candidate runs all Caller tests.

The set comes from the record. Of about 400 PRs merged in October 2026, tests
caught a real defect on 24. The 17 unit catches were spread over 34 files, and
the files with repeat catches in the first half caught 1 of the 8 later ones, so
past catches do not pick tests. A direct import of the changed file caught 14 of
the 17, and that link with the safety tests caught 15. The browser selection
caught 5 of the 8 browser catches. In all, 3 or 4 of the 24 would have reached
`main`.

So passing the merge queue proves the essential tests on that candidate, not the
whole suite, and a later PR can break a regression test outside the set until
the next full run.

### The full run

A push to `main` here draws the full run when the first eight hex digits of its
commit, modulo 10, are zero: about one merge in ten, with no state to keep and
the same answer on a rerun. That commit skips its queue evidence and runs the
complete gates. `.github/workflows/full-suite.yml` also starts one at 03:41 UTC
every night, so a quiet stretch cannot hide a defect for days, and
`gh workflow run ci.yml --ref main` starts one by hand. Each push to `main` here
has its own concurrency group, so a later merge cannot cancel one.

On these runs a unit test gets one retry, as browser tests in CI get Playwright's
two, so a lone flake does not count.

When a full run on `main` finishes, `full-suite.yml` reads it through
`ci.mjs report`. A failed one opens one issue, `fix: the full test suite fails on
main`, labelled `poise`, naming the failed tests and jobs and what merged since
the last full run that passed. Poise's chain fixes it in a normal PR. Nothing is
reverted and other PRs keep merging. Another failure adds a comment, never an
edit, because editing an issue's body re-bases the chain already fixing it. A
later full run that passes closes the issue.

Full runs can overlap, so commit order decides what counts. A pass on an older
commit than the latest failure leaves the issue open, and a failure on an older
commit than a pass files nothing. A run cancelled as a whole reports nothing,
because it was superseded or stopped by hand; a job that runs out of time still
counts as failed.

A fork's `main` needs complete CI and Caller evidence for its exact commit.
It can reuse complete upstream checks as described below. Otherwise it runs
the complete gates locally. `deploy/actions/gate.sh` refuses a tip whose CI
or Caller run failed. `full-suite.yml` does nothing in a fork.

### How CI runs them

A full run has independent lint/types/audit and production-build jobs, two
unit/integration shards and six Chromium shards. Browser shards consume the
same run's build artifact without rebuilding it. Each owns its runner, server,
databases and fixtures, and retains one browser worker because some real-API
fixtures share server state within a shard. The queue admits at most two
candidate builds at once; each candidate retains its internal shards. Each CI
unit shard also uses one worker: the real process/lease fixtures must not compete
with another test file. Per-test deadlines stay unchanged; the job budget allows
the serial file execution. Local Vitest defaults stay at two.

All CI helper entry points live under the controller's existing protected
`.github/workflows/` prefix. The delegated-policy regression derives the live
workflow commands and rejects direct edits or renames out of that boundary.

Browser jobs use the official `mcr.microsoft.com/playwright:v<VERSION>-noble`
image, with VERSION read from the locked `@playwright/test` package. Its browsers
and system libraries are already installed. A version/executable mismatch fails
before tests. Browser isolation and every existing assertion are unchanged.

A push to upstream main that did not draw the full run looks for the latest
merge-queue run of the same workflow for the **exact same commit**, repository
and queue branch. A completed success is reused, with its URL recorded in the
Actions summary. Missing, failed, cancelled or unfinished evidence runs the
complete main gates. API errors fail visibly.

A GitHub.com fork push can reuse a successful upstream merge group, main
push, or main dispatch on the exact same commit. The planner reads the
public Actions API and checks the latest eligible runs and attempt-specific
jobs. CI needs the full-suite verification step, lint and types, the
production build, both unit shards, and all six Chromium shards. Caller
needs its tests, Python parsing and CLI checks. A fork push that changes
dependencies also needs a successful upstream dependency audit. Each
workflow links the accepted attempt in its summary. Missing, incomplete,
stale or unavailable evidence leaves the complete local checks to run.

`Verify (Node 22)` and `Caller (Python 3.13)` retain their names and main-push
workflow events. The aggregate accepts omitted application jobs only when the
successful planner explicitly selected documentation-only work or trusted
exact-commit reuse; unexpected skips/failures still fail. The application update
controller and deployment gate continue to consume these checks without any
application or deployment-policy changes.

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

The retained Caller-history issue-review regression uses 6,276 rows and responses
larger than 96 MiB. It clears inspected mock results and snapshot observations
before the second large read and again before outage recovery so Vitest does not
retain earlier responses and decoded snapshots alongside fresh reads. A retained-byte
guard before the second read rejects either preceding payload; the existing guard
also bounds mock data still held after recovery.

## Agents' suites

On a deployment with a test relay, a suite an agent starts in a workspace runs on a disposable test box, not beside Poise ([Agents' test suites](Operating.md#agents-test-suites)). `tests/test-offload.test.ts` runs the real hooks, runner, relay and box script against a stand-in for Render's API.
Its interrupted Vitest fixture awaits an annotation to deliver pending case
updates before holding the suite open. Caller also retains an actual emitted
timeout excerpt through checkout reclamation without validating or publishing.
With GNU tar it exercises dependency reuse on jobs and sandboxes, including
hard links, metadata, source edits and dependency edits at the same HEAD and
mtime. It checks workspace isolation and replays the original dependency
bytes after a cache hit followed by a relay restart.
It replaces the relay mid-suite and verifies one recovery with identical captured
input despite unchanged-HEAD edits, genuine failures (including exit 125),
cancellation, repeated restarts and an unrecovered relay. Recovery and the full
rerun share the original command budget. A journal/decision fixture continues
from the fresh complete result through exact-head review, CI, readiness and merge
observations without Resume; it performs no live GitHub actions and retains the
interrupted attempt as missing a result.
Caller's native-receipt regression also feeds completed pytest assertion and
setup-error output through the client, truncates the worker's console, and checks
the original persisted diagnostic after a different run returns no result.

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
the Claude subscription wrapper carries both on to the native CLI and its
tool children, and the runtime smoke contract checks the shipped config
parses.

Measured on a Linux container with 12 vCPUs (Node 22.23.4, TypeScript
5.9.3, ESLint 10.6.0, ripgrep 13.0.0, esbuild 0.28.1). CPU seconds are user
plus system as reported by `time`:

| Workload | Condition | Elapsed (s) | CPU (s) |
| --- | --- | ---: | ---: |
| Lint, all files | Uncached | 41.56 | 33.88 |
| Lint, all files | Warm content cache | 12.11 | 5.89 |
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
npm run test:full -- --reporter=default --reporter=json --outputFile=test-results/vitest.json
npm run test:e2e:full -- --workers=1
# Inspect or reproduce an individual CI shard:
npm run test:full -- --shard=1/2
npm run test:e2e:full -- --shard=1/4 --workers=1
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
