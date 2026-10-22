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
describe its contract.

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

## Repository checkouts

Repository checkouts reuse a bare mirror under a per-repository lock. The lock
covers refreshing the mirror and taking an independent full-history snapshot;
working-tree files are materialized after it is released. A slow checkout or
filter therefore does not hold other snapshots behind it. Each checkout keeps
its own objects and remains usable after the mirror is refreshed or removed.
Credentials are passed per command and never stored in either repository.

## Automatic merge primitive

`github-interface --merge-if-ready '#7' --expected-head SHA --author USER
--token-user AGENT` (from a repository checkout or an `owner/repo` directory)
merges only the named author's open, non-draft, green head. It rereads checks,
conversation completeness and merge state without Poise's display cache, and
sends the expected SHA to GitHub's merge endpoint. GitHub enforces protections.
The method is the first allowed of squash, merge and rebase. The JSON outcome
is `merged` with `merge_sha`, `not_ready`, `superseded`, or `already_merged`.
API errors fail visibly; a lost merge response can be reconciled by the next
read without merging twice. This operation requires an explicit acting account.

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

Grey CI recovery intents are shared by repository, workflow, event and head,
independent of PR number or changes to the acting account. Intent is persisted
before launch; a restart rehydrates unconfirmed requests as visible holds even
if the workflow is now running or green. Diagnostics belong to each workflow,
so a different successful rerun cannot clear an unresolved hold. A `read_failed`
receipt proves no write occurred: its intent is released and the visible read
failure retries with backoff. Errors after the write begins remain held.

## Review preparation diagnostics

Review Git failures retain a version 1 `diagnostic` object in the durable call
and `agent-interface --logs`. `github-interface` emits the same redacted JSON
as `caller_diagnostic: …` on stderr; agent-interface preserves it across packet
acquisition, checkout and inspection. Poise's agent-log API exposes its bounded
cause as `diagnostic` (identity/process fields under `context`), and validated
behavior incidents carry `processDiagnostic` alongside their classification;
both pass through Poise's canonical redactor first, as Logging does.

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
