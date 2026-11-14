# Caller

Caller is the three Python command-line tools Poise drives. They came from
the standalone Caller repository at `a6a4c4c`, with their package layout,
tests and contract documents.

| Package | CLI | What Poise uses it for |
| --- | --- | --- |
| `agent_interface/` | `agent-interface` | Runs the model CLIs for PR reviews, approvals, issue reviews, `/content` and `/consensus`; keeps the calls log Swarm shows; exports the model catalog |
| `github_interface/` | `github-interface` | Repository lists, checkouts, pull request state and sub-issues for the behaviors; resolves non-blocking review conversations and merges ready pull requests. `agent-interface` posts its reviews and comments through it |
| `github_datastore/` | `github-datastore` | The per-account SQLite index of issues and pull requests behind Current, Archive and the behaviors |

Each package's own README, AGENTS and (for the datastore) CONSUMER_CONTRACT
describe its contract. Caller terminal states map to the shared contract in
[Error-state handling contract](../docs/Error-State-Contract.md).

## How Poise runs them

Poise runs the three CLIs from `caller/.venv/bin` and runs `agent-interface`
with `caller/agent_interface` as its working directory. `CALLER_BIN_ROOT` and
`AGENT_INTERFACE_ROOT` (absolute paths) name another installation instead.
The model-refresh child receives the server's resolved `CALLER_BIN_ROOT`
explicitly; a missing executable fails without selecting another Caller.
`/api/health` reports Caller as `callerRelease`: `ready` when the three CLIs
are runnable, with each package's version from its `pyproject.toml`. The
production server does not start without it, and `npm run install:production`
builds the same virtualenv in the production checkout.

The [behavior chain](../docs/Behavior-chain.md) drives atomic implementation
and repair through `agent-interface --atomic-work`, with publication through
`github-interface --issue-work`. Its internal `--complete-atomic-publication
CALL_ID PLAN_SHA HEAD_SHA` continuation accepts only an original failed repair
whose immutable plan, pushed head, unattempted replies and released worker
resources are proven. It starts no model and cannot replace that plan.
Shared baseline CI dependencies use that same atomic repair artifact and the
existing chain tick ([dependency evidence and recovery](../docs/Behavior-chain.md)).
Before new implementation, Poise reads live `blockedBy` evidence in the existing
authenticated `--chain-seed` / `--issue-work` GraphQL preflight, bounded to 100
nodes with a matching total count and complete page. The mirror health gate
remains required. After awaited request preparation, the same observation and
decision run again before implementation admission; missing or truncated live
evidence waits. For each explicit same-repository prerequisite,
`github-interface --read-issue ISSUE --delivery-base SHA --token-user USER`
reads its state and linked closing PRs, including closed PRs. It returns
`verified: true` only for a closed issue with a linked closing PR's merge commit
verified on that exact base by GitHub's commit comparison; missing or incomplete
evidence returns an explicit unverified reason. The result retains the base, PR
number and merge SHA. [Dependency waits](../docs/Behavior-chain.md#handoffs-and-outcomes)
preserve ordinary chain holds and admission gates.
`github-interface --list-failing-ci PR --repository OWNER/REPO --ref SHA`
includes the exact commit's checks, parent SHAs and workflow identities while
retaining the current candidate head. `--ref base` reads the current base.
`--base-update-from FAILED_SHA` also verifies whether the current head is a
direct clean merge of the failed head and a commit in this PR's base history.
It returns `base_update` with the source, base parent and verified merge tree,
or null when the update is not proven. A head or base change during the proof
fails the read. Git runs in an isolated temporary bare repository; no branch or
checkout is changed.
`--read-failing-ci-log JOB_ID --repository OWNER/REPO` reads the actual job log,
following GitHub's download redirect without forwarding credentials across hosts.

For a closed full-suite reporter seed, `--chain-seed` also reads the actual
failing/recovery runs, test artifacts and covering merges. Conservative complete
test-repair coverage permits `github-interface --issue-work ISSUE --mode retire
--branch BRANCH --pull-number N --expected-head SHA --coverage-json JSON
--token-user USER`. Retirement revalidates that evidence, preserves unrelated
work and rechecks the owned head immediately before closing. It returns `closed`,
`already_closed`, `not_ready` or `superseded`; a missing response proves none of
them. The chain invokes it only through the original native action/resource
path after settling prior writes and native ownership. See
[full-suite reconciliation](../docs/Behavior-chain.md#bounded-reconciliation).
The same retirement action accepts verified empty-integration coverage for
Poise-generated pre-PR failure remediations, including queued PRs with open
seeds. `--chain-seed` retains the pinned Git trees and distinct covering merge;
the close action rechecks the current head and base. Independent work and
unverified coverage retain ordinary processing. The source issue is untouched.

An atomic repair blocked solely by the supplied head's failed CI can return
`blocked: {"cause":"ci_only","reason":"concrete CI blocker"}`. Caller retains
its own supplied CI snapshot as `artifact.ci_blocker`, including the failed
check and job IDs that identify the original run attempt. Other blockers remain
strings and confer no automatic recovery authority. The
[chain reconciler](../docs/Behavior-chain.md#bounded-reconciliation) checks the
original no-publication receipt, resource release and fresh CI on the same head
or a verified base-only update before resuming the remaining gates.

A pre-PR implementation blocked solely by an observed main CI test failure may
also return `testDependency: {base, run, baselineRun, remediation}` alongside its
concrete blocked string. `base` must be `prepared.checkout_head`; `run` is the
original producing CI run, `baselineRun` is a distinct run on that exact commit,
and `remediation` is an existing same-repository issue URL. Caller reads both
full-suite assertion artifacts and verifies every failing test and cause before
retaining `artifact.test_dependency`. `github-interface --chain-seed ISSUE
--branch BRANCH --test-dependency-json JSON --token-user USER` revalidates that
proof and the delivered recovery on the current implementation base. See
[pre-PR recovery](../docs/Behavior-chain.md#bounded-reconciliation) for admission
and evidence limits. Relay prose and digests alone remain actionable holds.

For new Calls, `source: "relay"` would identify the original and clean-base
completed relay run IDs, but recovery is currently held for #1619: the suite UID
owns the report files, so candidate code can replace them before signing.
Caller supplies its own retained Call/capture binding and reads the signed runner
receipts saved by the hook; worker-supplied receipt text cannot replace them.
The gateway would authenticate both complete assertion inventories. A distinct run
at the same HEAD is insufficient: the baseline must independently match a clean
prepared-base source capture. Direct Vitest commands, wrappers, other runners,
canceled/incomplete results and evidence overflow all retain the hold until the
runner establishes the inventory independently. The same delivered-fix and
full-suite CI validation gates would apply, including every duplicate parameter
under a failing title.

## Accounts

No GitHub account is fixed in Caller. Each `github-interface` behavior acts as
the account `--token-user` names, which every behavior accepts. Without it,
agent work — reviews, comments, checkouts, CI fixes and the reads they need —
acts as `GITHUB_INTERFACE_AGENT_USER`, and reads done as you (`--view-repos`,
`--current-pr`, `--pr-readiness`) act as `GITHUB_INTERFACE_USER`. Review
behaviors whose account is part of what they check take `--token-user` on every
call. With no account, a behavior fails naming the variable to set; gh's active
account is never used. `agent-interface` posts issue reviews as its `--actor`,
which must be `GITHUB_INTERFACE_AGENT_USER`, and `github-datastore` reads
GitHub only as the account whose token `GH_TOKEN` holds. Poise sets all of
these from Settings → GitHub.

Poise selects the opposite configured account for PR work. The live `--head-sha`
and `--current-pr` replies include `author`; PR review submissions reject the
PR author as actor. For automated work under the main account, Poise supplies
`GITHUB_INTERFACE_AUTOMATED_REVIEWS`, a JSON array of recorded review IDs.
Approval and every conversation-resolution gate refuse reviews by that actor
whose IDs are absent. An absent variable preserves standalone Caller behavior.
The installed stop gate selects the main reader for agent-authored PRs and the
agent reviewer otherwise; the accounts must be distinct and author evidence known.

## Repository checkouts

Repository checkouts reuse a bare mirror under a per-repository lock. The lock
covers refreshing the mirror and taking an independent full-history snapshot;
working-tree files are materialized after it is released. A slow checkout or
filter therefore does not hold other snapshots behind it. Each checkout keeps
its own objects and remains usable after the mirror is refreshed or removed.
Credentials are passed per command and never stored in either repository.

Refresh, snapshot cloning and a missing-tree failure from the first working-tree
reset share one recovery attempt within the invoking command's deadline. Recovery
discards only the owned temporary snapshot and, under the same lock, its implicated
mirror generation if it is still current. A concurrent replacement is reused;
filter and other reset failures do not rebuild the mirror. A permanent missing
tree fails with the existing redacted Git diagnostic before managed review
preparation can publish a head checkout or start a review or approval worker.

`github-interface --prune-mirrors ROOT --cap-bytes N --now-ms N
[--fresh-ms N] [--dry-run]` is local maintenance and needs no GitHub account.
It evicts whole bare mirrors only at `ROOT/owner/repo.git`, oldest first,
under the same nonblocking `owner/repo.lock` flock as repository checkouts.
Owner directories and lock files stay in place. Freshness includes every
descendant write, rechecked under the lock; busy, recent, nonbare or
symlinked entries are held. Open directory descriptors anchor inspection
and removal so path replacement cannot redirect deletion outside the mirror.
The JSON response contains `removed` (`path`, `bytes`), `held` (`path`,
`reason`) and remaining `totalBytes`; dry-run returns the same classification
without removing mirrors.

## Automatic merge primitive

`github-interface --merge-if-ready '#7' --expected-head SHA --author USER
--token-user AGENT` (from a repository checkout or an `owner/repo` directory)
merges only the named author's open, non-draft, green head. It rereads checks,
conversation completeness and merge state without Poise's display cache, and
sends the expected SHA to GitHub's merge endpoint. GitHub enforces protections.
The method is the first allowed of squash, merge and rebase. The JSON outcome
is `merged` with `merge_sha`, `not_ready`, `superseded`, or `already_merged`.
On a branch with a native merge queue it instead sends a head-pinned enqueue
mutation after successful head checks, platform approval and complete
conversation checks, and reports `enqueued` or `in_queue` with the confirmed
queue entry id; neither is a completed merge. The queue admission contract is
in `docs/Behavior-Contract.md`.
`already_merged` and `in_queue` report observed target state, not proof that
this request performed the mutation. API errors fail visibly; a lost merge
response can be reconciled by the next read without merging twice. This
operation requires an explicit acting account.

Merge-admission failures emit the existing bounded, redacted `caller_diagnostic`
v1 envelope. Native Caller retains it with the original Call; the
[native action receipt contract](../docs/Behavior-chain.md#native-action-receipts)
defines refusal evidence, uncertainty and the chain's displayed next action.

`github-interface --update-branch-if-behind '#7' --expected-head SHA --author
USER --token-user AGENT` updates only the named author's open, non-draft head
that is mergeable but behind its base with nothing else blocking. It revalidates
checks, conversation completeness and merge state on fresh head-pinned reads,
then sends the expected SHA to GitHub's update-branch endpoint. The JSON outcome
is `updated`, `not_ready`, or `superseded`. This operation requires an explicit
acting account.

## Setup

Caller needs Python 3.13 (`brew install python@3.13`; `POISE_PYTHON` names
another interpreter).

```bash
npm run caller:setup
```

This creates `caller/.venv` (rebuilding one that is not Python 3.13), installs
the three packages into it editable, plus pytest, and checks the installed
versions against `caller/`. Run it again when a Caller change adds a
dependency.

Without `AGENT_INTERFACE_DATA_DIR`, `agent-interface` keeps its calls and
responses in `caller/agent_interface/data`, which Git ignores. `calls.sqlite3`
runs in WAL mode, so its `-wal` and `-shm` companions live alongside it.

## Tests

```bash
npm ci
caller/.venv/bin/python -m pytest caller/agent_interface/tests caller/github_interface/tests caller/github_datastore/tests
```

The checkout-lock interop tests drive this repository's TypeScript lock with
Node 22, so `npm ci` comes first. The Caller workflow
(`.github/workflows/caller.yml`) runs the same suites on Python 3.13, parses
every Python file and checks each CLI's `--help`.

`github-interface --merge-candidates --requests-json
'[{"repository":"owner/repo","number":7}]' --token-user AGENT` reads up to 50
explicit targets in one GraphQL query. It returns the acting account,
`graphql_cost` in GitHub points, and ordered records with `repository`, `number`,
`head_sha`, `author`, `ready`, `behind`, `approved_at` and `error`. The green
predicate is shared with the merge primitive; `behind` is true when the same
predicate holds except the branch is out of date with its base, and
`approved_at` is the latest approval time or null. A partial query error is
returned on its affected target; unscoped errors and missing identity/cost
evidence fail the operation visibly. The read does not merge or use REST
polling. An empty list adds no API requests.

## GitHub polling reads

Interface REST reads and GraphQL queries retry transport failures and HTTP
500/502/503/504 once after a 250 ms delay. Exhaustion still fails. Mutations
remain single-attempt; an uncertain publication must be reconciled before retry.

`--requested-changes-addressed` reads the PR and its complete review list first.
Without an active change request from the acting reviewer, its response evidence
is empty and it skips inline comments, commits, public comments and threads.
Active requests retain those reads, including reaffirmed findings and resolved
threads. Successful response fields are unchanged.

`--review-activity-since` reads PR metadata, review requests, reviews and review
threads together on their first page. Each overflowing connection follows its
own cursor to completion. Thread summaries retain the same fields and comment
bodies. This changes neither the polling cadence nor checks before writes.

The bounded four-call proof compares identical single-page activity payloads
fetched separately and together, and requires lower GitHub-reported point cost:

```bash
caller/.venv/bin/python caller/github_interface/scripts/measure_review_activity.py --token-user LOGIN --repository autonomio/poise --pr 161
```

## Grey CI recovery

`github-interface --grey-ci-candidates --requests-json
'[{"repository":"owner/repo","number":7}]' --token-user AGENT` discovers completed
cancelled/stale GitHub Actions workflows on current PR heads. Up to 50 PRs share
one GraphQL query; truncated check workflow inventories get extra pages. JSON
includes `actor`, actual `graphql_cost`, and ordered records with `head_sha`,
`author`, `runs` and `error`. The newest workflow/event run supersedes older ones.

`github-interface --rerun-grey-ci-if-ready '#7' --run-id ID --run-attempt N
--expected-head SHA --author USER --token-user AGENT` revalidates current PR
identity/head, completed cancelled/stale workflow state, exact attempt, all jobs
and the latest replacement run before a POST to the workflow rerun endpoint.
A failure, timeout, active or unknown job refuses recovery. Outcomes are
`rerun_requested`, `not_ready`, `superseded` and `read_failed`; the successful outcome means
GitHub accepted a request, not that CI passed. Writes are never blindly retried.
Poise owns the persistent once-per-workflow/head/event intent and ambiguity hold.
The same command with `--inspect` is read-only: an actual later attempt of the
original workflow on the original head returns `rerun_observed`. An unchanged
attempt is `unconfirmed`; neither absence nor a different workflow settles a
lost response. This inspection lets managed chains recover an accepted rerun
without posting another one.

Grey CI recovery intents are shared by repository, workflow, event and head,
independent of PR number or changes to the acting account. Intent is persisted
before launch; a restart rehydrates unconfirmed requests as visible holds even
if the workflow is now running or green. Diagnostics belong to each workflow,
so a different successful rerun cannot clear an unresolved hold. A `read_failed`
receipt proves no write occurred: its intent is released and the visible read
failure retries with backoff. Errors after the write begins remain held.

`github-interface --close-old-pr-if-ready '#7' --cutoff-ms TIMESTAMP --author USER
--token-user REVIEWER [--repository OWNER/REPO]` closes an old PR without a model.
The cutoff is Unix milliseconds supplied by Poise from its current days setting.
The configured GitHub author pair and opposite acting account are required. A live
read must show an open, non-draft PR by the admitted author, with a known creation
time at or before the cutoff. Missing, invalid or future `created_at` fails visibly.
`closed` requires a response confirming `state: closed`, `merged: false` and the
requested PR number. A lost write response is reconciled by one read; an
unconfirmed close remains an error. `already_closed` (including merged PRs) and
`not_ready` are no-ops. Poise owns repository scope, skips, holds and the PR lock.

## Review preparation diagnostics

Governed Claude reviews forward their original invocation ID and receipt database
through the subscription wrapper's explicit shell settings, together with the
original Caller data directory and metadata controller reference when present. The submission helper
therefore retains the substantive response with its original model and invocation
before publishing; a response without that identity cannot authorize approval.

Review Git failures retain a version 1 `diagnostic` object in the durable call
and `agent-interface --logs`. `github-interface` emits the same redacted JSON
as `caller_diagnostic: …` on stderr; agent-interface preserves it across packet
acquisition, checkout and inspection. Poise's agent-log API exposes its bounded
cause as `diagnostic` (identity/process fields under `context`), and validated
behavior incidents carry `processDiagnostic` alongside their classification;
both pass through Poise's canonical redactor first, as Logging does.

Unpaged `agent-interface --logs` history keeps readable calls available when
an individual record has invalid UTF-8 or cannot be decoded as a log entry.
The damaged row carries its position, readable identity fields and a
quarantine reason in place of a receipt. Exact receipt selection and
structural database failures still fail closed.

The evidence records the actual Git subcommand after global options, exit or
signal, deadline, elapsed time, configured/resolved executable, working path,
repository/revision and call/correlation identity. Unobserved values are null.
A timeout is distinct from a killed process; user cancellation and head moves
keep their existing stopped/superseded lifecycle and retry ownership.

Stderr is drained concurrently, retaining at most 16 KiB plus a truncation
marker. Partial lines at capture boundaries are omitted to avoid leaking
credential fragments. Credentials of every length, encoded Git authentication,
URL passwords, authorization headers and cookies are redacted before CLI output
or durable storage. Secrets are replaced last, in one pass that keeps the
redaction and truncation markers whole, so redacting twice changes nothing.
Neither stdout, prompts, argv nor the environment enter the diagnostic.
An empty stderr says the cause is unknown. Explicit ENOSPC/quota evidence also
records filesystem bytes/inodes measured immediately after the process failure,
with its own measurement time; unavailable readings are null with the measurement
error. This is evidence at capture time, never a claim about earlier disk use.

Atomic publication retains that same Git diagnostic in the original Call before
managed-resource cleanup, including the inner Git exit or signal. Invalid,
oversized or absent diagnostic envelopes retain only the github-interface
process outcome and an explicitly unavailable cause; raw output is excluded.
Caller logs and Logging expose the operation, publication phase and available
cause. This evidence neither settles an unknown push nor authorizes a retry,
including after a later merge; resource release and review obligations keep
their existing gates. Discarded historical causes remain unavailable.

Native namespace init forwards the executor's observed wait status before
exiting. The original Call retains an executor signal separately from an
explicit exit such as 137; the init's conventional 128+signal exit does not
establish a signal. Missing inner failure evidence still leaves the initiating
cause unknown. Exit diagnostics grant no publication or resource-release proof.

### Bounded diagnostic reads

`agent-interface --diagnostics [after-sequence] [limit]` returns version 1
metadata-only events, a persistent database `streamId`, a completion cursor, `hasMore` and `backfillPending`. The owner binds its checkpoint to that identity; database replacement restarts bounded replay with a visible collection gap. Legacy unbound checkpoints replay from zero.
The default page is three events; the maximum is ten. Late-finishing calls
receive a new completion sequence, so advancing past a running call cannot
skip its later failure. Legacy terminal calls are indexed in bounded batches.
Prompt, response, reasoning and command arguments are never returned or opened.
The owner applies Poise's canonical redactor before retaining or publishing the
records. Malformed/oversized stored evidence is reported explicitly within the
64 KiB per-row envelope; it cannot stall later completions. This read does not
change review, retry, outcome or interruption policy.
