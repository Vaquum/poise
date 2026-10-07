# Models

Every model has one name everywhere: its identity `<family>-<version>-<effort>`,
for example `opus-5-max` or `gpt-6-astra-ultra`. `agent_interface/models.toml`
holds the catalog — the latest model of each family (Claude Opus and Fable,
Codex Astra and Sol, Grok Build, Antigravity Gemini, Muse) with its top efforts
— three for Claude, since reviews run at high, two elsewhere — plus the
default per behavior. `agent-interface --models` prints it as JSON.
`agent-interface --refresh-models` asks each CLI what it offers today and rewrites
the runtime copy under the data directory when something changed; a family whose
CLI cannot answer keeps its rows and is reported as unavailable.

# Authoring content

`--author-content TOPIC [--session-id ID] [--pwd DIR] [--voice-guide PATH]`
writes a piece on TOPIC with the catalog's `author_content` model and no tools.
It writes in the voice guide `--voice-guide` names, else the one
`AGENT_INTERFACE_VOICE_GUIDE` names: a local text file, read when the call
starts. A named guide that is missing or empty fails the call. With neither,
it writes without a voice guide, says so on stderr, and prints
`"voice_guide": null` with its result.

# Stopping a run

Every call records the process id of the `agent-interface` that runs it.
`agent-interface --stop CALL_ID` signals that process group (the CLI and the
provider it started; a governed review stops its provider itself on SIGTERM),
waits briefly, and closes the row as `failed` with `error_code = stopped` and
the error "Stopped by user". A call that already finished is left as it is.

# Recording a Chat turn

Poise's Chat runs the agents itself; Caller only keeps the row so Swarm lists
each turn with its model, elapsed time and outcome.

`agent-interface --record-turn start --model IDENTITY --session ID --source poise:chat
[--repo OWNER/NAME --pr N] [--correlation-id ID]` writes one `behavior = chat`,
`status = running` row and prints its 32-hex call id. No process is launched, so
the row records no pid and is marked `runner = external` (visible in `--logs`);
`--stop` refuses such a row and says to stop the turn through Poise, which routes
Swarm's Stop to its runtime. With `--correlation-id`, starting the same turn
again prints the same id — whatever state it is in — and a different turn under a
used id is refused; without one every start is a new row.

`agent-interface --record-turn finish CALL_ID --status completed|failed|cancelled
[--error TEXT]` closes it with the end time and prints
`{id, status, started_at, completed_at, time_elapsed, error}`. A `failed` turn
without `--error` records "Turn failed"; `--error` is refused with `completed`.
Repeating the same status returns the stored record unchanged; a different
status is refused and nothing is overwritten. Only rows started by
`--record-turn` can be finished this way, and Caller never closes them on its own.

# The checkout lease (fix-failing-ci)

`--fix-failing-ci` is the one behavior that writes to a repository checkout
(`--checkout-pr-head`, `--write-file`, `--commit-work`), so it shares Poise's
per-checkout writer lease: one SQLite file per checkout under `~/.poise/locks`
(`POISE_LOCK_DIR` overrides it for tests), named by the SHA-256 of the real
path, one row, schema and rules in Poise's contract. Caller acquires it before
the agent starts — waiting up to five minutes, then failing and naming the
holder (`checkout … is in use by chat "…" on … (Poise dev)`) — and heartbeats
it every 20 seconds while the agent runs. If the heartbeat finds the row taken
over, the agent is stopped and the call fails.

The agent never runs unregistered: `lease_gate.py` is started first as the
leader of a new process group, its pid, group and a random `--lease-worker`
ident are written into the lease, and only then does it receive `GO` on a pipe
that Caller alone holds and start the `claude` command in its group, reporting
`STARTED` on a second pipe so a gate that died first is never confused with an
agent that ran. If Caller dies (pipe EOF) or is stopped (`--stop` sends
SIGTERM; Caller then stops the group itself, keeping the gate unreaped until
the last signal so the group id stays its own), the gate ends the whole group —
SIGTERM, SIGKILL after five seconds. When the agent exits, lingering
descendants are settled the same way from a fresh `ps` listing each round; a
group that cannot be listed is never called settled. The lease is deleted only
once nothing in the group is alive; a group that will not die keeps the row and
the call fails with `orphan requiring intervention: worker group <pgid> …`. A
stale row whose holder is dead is recovered by the next writer only when the
registered group is dead too. Each hold uses a fresh token; a released or lost
lease never touches the row again.

# PR review models

PR reviews and approvals default to `opus-5-high`; on a Claude output limit they
recover once with `gpt-6-astra-ultra`. Pass `--model` and `--recovery-model` to
`--pr-review` or `--pr-approve` with any identity from the catalog.

PR review prepares an independent temporary checkout at the packet's exact head,
with its merge base available. `github-interface --checkout-review` checks the
live head and base before and after preparation, disables Git hooks and user
configuration, limits preparation to 180 seconds, and rejects incomplete trees,
more than 20,000 tree entries, or more than 256 MiB of tracked content. The checkout
is removed after the provider finishes, fails, or is cancelled. Approvals retain
their existing packet-only behavior.

Every PR reviewer receives AGENTS.md and CLAUDE.md guidance from the pinned merge
base, including nested files and their paths. Guidance is limited to 256 KiB,
applies within its directory scope, and cannot change the review contract. Changes
to those files in the PR are source to review, not new authority over the reviewer.

Repository inspection is a read-only interface, not permission to execute code.
`github-interface --review-context --requests-json JSON` accepts 1-8 requests with
`operation` (`read`, `search`, or `list`), repository-relative `path`, `query`
(literal search text, otherwise empty), and `start_line` (1 initially). Reads and
lists return 200 entries, searches return 100 matches; use `next_line` when
`truncated` is true. Search covers tracked UTF-8 files up to 4 MiB. Responses are
limited to 64 KiB and file pages to 32 KiB. Git metadata, untracked files, symlinks,
path escapes, writes, test execution, and arbitrary commands are unavailable.

Claude reviews with the governed `github-interface` tools and can invoke that
inspection command from the pinned checkout. Every other provider
returns a structured JSON verdict instead; Caller validates it and invokes exactly
one existing `github-interface` terminal command with the original PR, actor, and
expected head. For PR review these providers can first return `action: "inspect"`
with provisional `comments` and a `requests` array; Caller reads the requested
source and supplies the result in their next turn. Terminal verdicts require
`requests: []`. At most 12 inspection rounds fit within the existing total review
deadline and 1.5 MB prompt limit; exhausting inspection never submits a review.
Each provider process runs in a separate temporary directory with native tools
disabled, receiving the same explicit guidance and scoped inspection access: Codex
(Astra, Sol; CLI 0.154.0 or newer, signed in to ChatGPT — API credentials are not
used) with read-only sandboxing, user configuration ignored, and shell, connector,
extension, and delegation tools disabled; Grok Build (`grok`) in one turn with
its built-in tools, web search and subagents off; Antigravity (`agy`) in plan
mode, the packet streamed on stdin; Muse (`muse`) with shell, writes and web
tools off. A run that used a native tool, failed, or answered anything but a valid
inspection request or terminal verdict
submits nothing, and the existing authoritative outcome check still determines
completion or supersession.

While a model is analyzing a PR, Caller checks its live head approximately
every 30 seconds through `github-interface --head-sha`. Only a valid response
for the original repository and PR can cancel the run. Failed, timed-out, or
malformed checks leave it running. A per-run submission lock lets an in-flight
GitHub command finish and prevents cancelled workers from starting another one.
Cancellation stops the provider process group and records `superseded` with the
observed head, preserving the launch provenance. Poise then reconsiders the PR
through its existing scheduler. Normal completion still uses the existing
terminal head checks and authoritative review outcomes.

### Several reviewers on one head

Every submission answers with GitHub's `review_id`, and a run records it as
its receipt the moment it is known — the structured runner from the reply it
submits, a Claude review from the reply `bash_guard` captures — on the call
row (`review_id` in `--logs`). The outcome of a run is the review its receipt
names, checked against the reviewer's reviews since the run started
(`reviewer_reviews_since_items` from `github-interface --review-activity-since`,
each with the same id). So Poise can run a primary, secondary and tertiary
reviewer on the same head at once: each run reports its own review, a
run without a receipt never adopts a sibling's, and an interrupted run recovers
only when nothing of its own was posted. A run that has no receipt and sees an
unclaimed review waits two seconds for the sibling to record its id before
treating the review as its own. Against a github-interface that does not list
review ids, the activity counters decide as before.

### Live review progress

Reviews and approvals expose an optional `progress` object through `--logs`.
It records the last observed stage, stage deadline, worker heartbeat, last
provider event time, and the latest 20 activity transitions. Caller reads CLI
events during execution and saves a heartbeat every five seconds. Messages
describe event types; prompts, tool arguments, and private reasoning content
are not copied into this history. Grok Build prints only its final answer, so
its runs stay at "Waiting for provider" until it does.

Progress is observational. Silent providers, malformed events, or failed progress
writes do not cancel, retry, approve, or reject a review. A stale heartbeat means
observation is stale, not that the provider is necessarily dead. Existing head
checks, submission locking, timeouts, and GitHub outcome verification remain
authoritative. Terminal progress and the outcome are committed together.
Historical calls and other behavior adapters have no progress object; clients
must display that as unavailable. Newly started reviews gain instrumentation
after this Caller version is installed.

### Review limits and recovery

Governed reviews share one 1,413-second budget across packet preparation, model
execution, recovery, and GitHub verification. This is the longest of 962 completed
calls measured on 2026-09-13 (1,283.662532 seconds), plus 10%, rounded up. Opus uses
the catalog's review effort and an explicit 64,000-output-token limit in the trusted CLI settings.
Other behaviors retain their existing model assignments and limits.

On an Opus output-limit error, Caller can recover once with the recovery model using the
same immutable packet and remaining budget. GitHub must first confirm the same
open head and no new or pending reviewer action. A verified completed action is
adopted instead. Ambiguous activity, time exhaustion, or failed recovery leaves a
typed failure for Poise to retain without automatically repeating unchanged input.
Logs include `review_policy` and `recovery_model`; capability discovery includes
`policy: bounded-v1` so Poise can reject an incompatible runtime before launch.

Claude Code 2.1.267 or newer is required for the explicitly requested
`--thinking-display summarized` stream; noninteractive defaults omit its text.
Every minute the activity history says whether new reasoning events arrived.
`--read-reasoning FULL_CALL_ID` returns the latest 65,536 characters explicitly
exposed by the provider, stored separately from logs. This may be unavailable even
while reasoning activity is reported. Prompts and tool arguments are excluded.

A reasoning-file write failure leaves heartbeats and terminal outcomes working.
Progress warns about the unavailable text, and its text counter advances only
after an atomic file save, so clients can fetch new text when storage recovers.

# Issue review

`--issue-review OWNER/REPO#N --model MODEL [--recovery-model MODEL] --actor USER
--source SOURCE --correlation-id ID [--note TEXT]` gives one issue, and every
sub-issue it makes part of itself, an adversarial review: "Provide an
adversarial, meticulous, and comprehensive review with comments on
OWNER/REPO#N and any issue directly linked to it." Poise runs one call per
reviewer, in parallel.

Unlike the PR behaviors, the agent is not held to Caller commands. At the
operator's explicit request it is the provider's own CLI with full access —
Claude with `--dangerously-skip-permissions`, Codex with `danger-full-access`
and approvals off, Grok Build with `bypassPermissions` and its sandbox off,
Antigravity with `--dangerously-skip-permissions`, Muse with `--yolo` — so it
can read the whole repository, build and run the tests. It runs in a fresh
checkout of the repository's default branch with full history
(`github-interface --checkout-repo`, cloned from a local mirror kept under
`~/.cache/github-interface/mirrors`, `GITHUB_INTERFACE_MIRROR_DIR`), under
`~/.cache/agent-interface/issue-review/<call>` (`AGENT_INTERFACE_WORK_DIR`),
deleted when the call ends. When the agent exits, its process group is
killed, and so is anything still running in its checkout, detached or not.
Claude keeps Claude Code's own system prompt: the unattended rules are
appended with `--append-system-prompt`, last on the line, and the task goes on
stdin — the shape Poise's subscription wrapper reads a stdin prompt from.

The actor is the agent account. `GITHUB_INTERFACE_AGENT_USER` names it, and
an `--actor` that differs from it is refused before anything runs
(`actor_mismatch`); without it nothing runs (`agent_account_missing`). Every
github-interface call names the actor with `--token-user`.

Caller first reads the packet through github-interface as the actor: the
issue and its comments (`--read-issue`, `--issue-comments`) and each
sub-issue with its own (`--sub-issues`). A sub-issue is a GitHub sub-issue or
an issue of the same owner linked under the issue's "Work Slices" heading
(not inside a code block or HTML comment); one that cannot be read is listed
with its error and gets no comment. A sub-issue is reviewed once: one that
already carries an issue review from a review of another issue, or whose own
review is running now, stays in the packet for context, marked `reviewed_by`,
but gets no comment. A posted review is found by the marker that ends the
actor's footer. Its call names the issue it was of; a call with no local
record counts as another issue's, and a row left running for over two hours
counts as no run. Comments post as the actor. The agent does not post:
it writes `{"comments": [{"issue": "owner/repo#N", "body": "..."}]}` to a file
outside the checkout. Caller keeps one comment per issue (merging duplicates,
splitting one over 60,000 characters into parts), sets aside any for an issue
outside the review or without a body, and posts each through
`github-interface --comment-issue … --repository …` with a footer naming the
model and the call. `receipts` on the call row (and in `--logs`) is `null`
until posting begins, then lists every comment posted — `issue`,
`comment_id`, `url`, `author` — recorded one by one. An issue that refuses its
comment does not stop the rest; the call then ends `posting_failed`.

A completed call has `action` and `outcome` `commented`; it has no head.
Failures are typed: `preflight_failed` when the packet could not be read
(`review_packet_too_large` when it is over 1.5 MB), `invalid_review_output`
when the agent left no usable review, `posting_failed` once posting began,
`review_budget_exhausted` after the one-hour budget (wall-clock, so time
asleep counts), `review_recovery_failed`,
and `stopped`. A failed provider's error is its own message or stderr, never
its output stream, which can hold whatever a full-access shell printed. A
Claude output limit before posting recovers once with the recovery model in a
new checkout. github-interface runs in its own process group, so a timeout
also ends the git it started; a mirror left broken is cloned afresh once.
`--models` lists `issue_review_providers`.

# PR stop gate

`--install-pr-stop-gate` registers `--pr-stop-gate` as a Stop and PostToolUse
hook for Claude Code and Codex. When a session claims its pull request is
ready, or changed a repository, the hook asks github-interface whether that
pull request is green — the reviewer approved its current head, checks pass,
no live conversation is open — and blocks the stop until it is. The reviewer
is the agent account: `CALLER_PR_REVIEWER`, else `GITHUB_INTERFACE_AGENT_USER`.
Pull requests are read as `CALLER_GITHUB_READER`, else as the reviewer. The
hook runs in every agent session on the machine, so installing fixes these
accounts into its command; installing without an agent account fails.
