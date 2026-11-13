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
`--refresh-models --families a,b` probes only the named families and reports
the rest skipped with their rows kept; an explicit empty `--families ""`
probes nothing.

# Authoring content

`--author-content TOPIC [--session-id ID] [--pwd DIR] [--voice-guide PATH]`
writes a piece on TOPIC with the catalog's `author_content` model and no tools.
It writes in the voice guide `--voice-guide` names, else the one
`AGENT_INTERFACE_VOICE_GUIDE` names: a local text file, read when the call
starts. A named guide that is missing or empty fails the call. With neither,
it writes without a voice guide, says so on stderr, and prints
`"voice_guide": null` with its result.

# Stopping a run

Every local call records its supervisor PID and available kernel start/epoch
identity before managed work. On Linux, `agent-interface --stop CALL_ID` opens
a pidfd before checking that identity and signals only through the verified
handle. SIGTERM lets the supervisor unwind its own provider handlers; escalation
reaches only that same supervisor. Numeric process groups and command-name
matches do not authorize signals. Stop closes the row as `failed` with
`error_code = stopped` and "Stopped by user"; it never releases native resources
or proves all descendants ended. A call that already finished is left as it is.
Missing, reused, previous-epoch, unreadable or unsupported identity refuses the
operation without a signal. This includes older rows and macOS development
without kernel-pinned handles. The refusal is explicit; no unsafe fallback is
used. Externally managed Chat turns retain Poise's existing Stop route.

Interruption reconciliation checks the original supervisor's process identity.
Only a reader that can observe the current workspace supervisor can reconcile
a previous workspace epoch. A reader in a private PID namespace cannot do so.
Existing resource and publication receipts still govern recovery.

New native registrations use process identity version 2. An older Caller
still running through a workspace update cannot reap these registrations.
The current Caller continues to read version 1 identities and settle their
original Calls.

Native per-Call resource receipts live in `resource_ownership`, outside the
replaceable publication artifact. Directory registration precedes allocation;
all PR attempt roots and copied credentials use a private recorded Call parent.
The normal finalizer also verifies the process nonce committed by the original
unique Call claim; a later failed launch cannot borrow that claim by PID reuse.
Positive cleanup, including a covering retry after a retained failure, is
required for settlement. Log reads perform no deletion and never manufacture
release from PID loss, wall-clock order or path absence. Physical v2 CLI calls
register the original private namespace with the existing workspace supervisor
before preparation or a helper/provider starts. Only the original retained
kernel view can certify process settlement before normal pinned disk cleanup.
At idle settlement, the original Caller kills leftover helpers inside its
private PID namespace, preserving PID 1's reaper and PID 2's Caller. The existing
two-second deadline and positive idle proof still gate lease release and
publication. An unverified settlement retains ownership and reports remaining
PIDs, process names and states.
The [service contract](../../docs/Service-architecture.md#workspace-behavior-observation)
defines support, teardown and uncertainty. Same-supervisor claimed disk recovery
uses the maintenance path below. Losing its original witnesses through forced
supervisor/container replacement retains the disk and reservation, without an
eventual-reclamation guarantee. Complete resource acceptance remains pending
under #806. Legacy review parents stay retained with a warning through Caller's
sweep; age, names and empty path scans grant no cleanup authority
([retention policy](../../docs/Operating.md#storage-maintenance)).

Cleanup recovery uses the existing maintenance/runtime triggers and the same
original Call. Its private `resource_cleanup` column records a bounded cleanup
claim, the cleaner's kernel identity and retry metadata; it is not a work or
action ledger and never enters the log DTO. Root handles stay in the existing
workspace supervisor until positive deletion is acknowledged. Original errors
are retained with optional `recovered_at` evidence after a complete positive
retry; an artifact's matching `resource_recovered_at` distinguishes recovered
resource uncertainty from an uncertain external action. Neither marker alone
can release a reservation.
The receipt stays within 128 KiB. Allocation reserves its full directory and
settlement certificates plus a bounded blocker before creating disk resources.
Diagnostics are bounded and consolidated under pressure, including in existing
receipts; consolidation retains a blocker until complete original recovery can
cover it. A diagnostic write failure cannot prevent the private cleanup claim
from retaining its held reason/backoff or stop later due Calls in the pass.
An incompletely registered descendant can carry `state: covered` only when its
original ancestor's pinned deletion certificate covers it. Its `covered_by`
names that reclaimed ancestor; it carries no invented child device/inode.
Allocated roots, preparation siblings and unknown older ownership require
their own proof. Original and recovery cleanup use the same private claim;
PID loss, a new epoch or a deadline never grants takeover by itself.
The claim transaction rechecks whether the Call still needs cleanup and is due.
Recovery reads the current settlement only after claiming the Call.
The supervisor pins Caller's original data directory, database and response
directory. Caller metadata reads/writes and service drain counts use those
handles after an ancestor rename; a replacement directory never becomes the
recovery target. New allocations refuse a changed data-directory identity.
`--reclaim-native-resources [--dry-run]` is an internal, bounded maintenance
command, not a behavior entrypoint.
An older workspace's owned `native-resources` parent may have mode 0755.
The allocator tightens the original pinned parent to 0700 without deleting
its contents; foreign ownership and symlink replacements are refused.
Fresh helpers inside a private PID namespace verify the original metadata
handles with that same live controller before opening them. A same-numbered
local PID or descriptor cannot substitute foreign metadata or prevent the
verified original-directory path from being used.

Poise's internal `--native-action` admits only the existing fixed merge,
conversation-resolution, grey-CI and issue-publication-completion commands.
It preserves the immutable logical request while giving the physical action
its own Call, correlation, scratch root and resource receipt. Accepted JSON is
fsynced before terminal status; Stop or a lost terminal write cannot erase it
or authorize a repeated mutation. The internal publication continuation also
has a physical Call and reuses the original repair's guarded publication plan.
`--native-capability` creates no Call or workflow: it verifies namespace setup
and positive teardown through the same private controller. Direct Python
library/unit calls retain historical receipts and are not physical CLI proof.
Provider preparation now runs inside the original physical Call; nonfatal
updater warnings retain warning severity in the existing diagnostic stream,
and missing verified launchers fail with their preparation diagnostic.

Native failures, including setup exceptions after Call registration, retain the
first error in the existing v1 `diagnostic`, replacing an earlier preparation
warning. Evidence keeps the original Call/correlation, execution phase and
Caller operation, with exception type, errno, deadline and exit/signal when
observed. Ordinary exception text, subprocess arguments and captured output are
excluded. Explicit implementation/repair blockers retain only their bounded,
redacted reason as defined in [chain outcomes](../../docs/Behavior-chain.md#handoffs-and-outcomes).
Generic atomic failures also identify the checkout, provider or publication
validation step. Caller-authored validation reasons and JSON line/column details
are retained in both the error and diagnostic message before cleanup; other
exception text remains excluded. These failures keep `atomic_work_failed` and
the existing result, resource-release and retry rules.
The outer detached Caller records an explicit unknown cause and observed exit
status when its inner continuation leaves no cause. These SQLite records survive
Poise restarts; they authorize neither publication nor resource release.

# Fencing a closed behavior

`--fence-closed-behavior --model MODEL --actor USER --repo OWNER/NAME --number N
--behavior issue_review|implement_issue|repair_pr|pr_review|pr_approve
--correlation-id ID [--expected-head SHA]` is Poise's no-worker reconciliation
command for an original invocation whose target is now closed. PR behaviors and
repair require the original head. It performs no provider preparation, checkout,
GitHub operation or signal. In one native database transaction it either wins
the original correlation and records a terminal `superseded` / `not_started` /
`target_closed` Call with settled resources, or returns the existing matching
Call unchanged. Conflicting identity fails; an existing worker's resources are
never released by this command. Repeats preserve the original receipt and time.

The existing unique correlation claim precedes every managed provider/checkout/
write. A late original therefore loses that claim if the fence won. The journal
still owns phase decisions, and Poise reads the resulting Call through its normal
validated receipt reader before releasing its durable reservation. A failed or
lost fence response alone proves no settlement. This adds no remote endpoint or
replacement worker.
The consumer requires the exact `admission_fenced` artifact, null executed head
and publication fields, and a valid resource-release timestamp. Caller tests
feed real `--logs --select` bytes into Poise's decoder and journal runtime for
all five behaviors; malformed variants remain quarantined. These contract
checks create no GitHub artifacts and are not workflow acceptance runs.

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

Native implementation/repair checkouts are private to their original Call.
Their same lease/gate protocol uses `checkout-lease.sqlite3` inside the owned
Call root, checked against the original supervisor's pinned directory identity.
Connections and heartbeat writers verify that identity; SQLite and its journals
use a local directory descriptor. Other application writers refuse these paths.
The original normal or claimed cleanup reclaims the gate together with the root,
while older global metadata stays retained. See the shared
[lease contract](../../docs/Chat-v1.md#sessions-and-working-context) and
[retention policy](../../docs/Operating.md#storage-maintenance).

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

Provider supervision hands off after a minute of quota or reconnect diagnostics
without progress. It reads bounded diagnostic fields from structured provider
error/retry events and supported native stderr diagnostics; tool events,
assistant prose and reasoning clear the stall timer. Malformed stdout never
supplies quota evidence. The retained cause excerpt contains only the selected
diagnostics, and GitHub quota errors do not trigger a provider handoff.

Every attempt ends with one durable terminal state: a validated result with its
authoritative `review_id` receipt, or a typed failure carrying provider, phase,
bounded redacted cause and known (`none`, `rejected`, `noop`, `blocked`) or
unknown submission state. Structured provider exits and signals are `review_provider_exit`,
provider-reported error terminals are `review_provider_error`; both keep
`not_started` / `preflight_failed` with no receipt, so Poise can safely retry
after proving no reviewer action. On a nonzero Codex exit, the cause prefers the
last usable `error` / `turn.failed` message, then a recognizable stderr failure;
startup warnings alone report cause unavailable with the observed exit or signal.
Malformed event lines cannot replace that process failure with invalid output.
Uncorrected invalid, missing, duplicate or contradictory
verdicts, submission rejections (including `no_review` no-ops) and duplicate
GitHub reviews are `review_contract_violation` and held. A repeat-only
`no_review` refusal first recovers once with the recovery model; anything
still failing is held. For `pr_approve`, a structured verdict that remains invalid
after its correction attempt first gets one fresh verdict from the admitted model.
Packet, staging, position and submission errors do not qualify for this verdict recovery.
Claude runs persist the refusal through the guard's
`.refused` sidecar, since they submit outside the structured runner; a receipt
from a later accepted submission wins over the stale marker. An approval the
unresolved-conversation guard refuses is
`approval_blocked_unresolved_conversations`: still nothing approved, but a
waiting external blocker rather than a failed verdict publication; a superseding
head keeps that disposition, and another request's review never settles the
blocked run. Claude runs persist the refusal through the guard's `.blocked`
sidecar, since they submit outside the structured runner; uncertainty still wins
when both markers exist. A second terminal submission after an accepted one is
blocked at the gate.

A controller-observed transient GitHub submission failure is recorded as
`review_submission_failed`, with action and outcome unknown until live review
receipts establish what happened. It does not become a permanent model-contract
hold. A verified accepted review wins over a lost response; Caller never retries
the write automatically. A submission timeout or a success without a receipt is
uncertain and reconciled the same way before any retry. A transport timeout or
connection error during submission names no status, so it is uncertain as well —
never a refused submission. Claude's pinned
inspection root is also carried in its explicit settings so shell tools retain
repository access.

When live GitHub state confirms the pull request closed or merged — at
preparation, after provider execution, or during publication reconciliation —
the obsolete round settles `superseded` under `review_target_closed`, never
clean. The original failure, the run's receipt state and the unclaimed and
sibling-claimed review inventory stay on the row; the settle claims no unknown
worker stopped and authorizes no replay.
Counter-only legacy facts use the same typed closure; missing per-review
inventories remain explicitly unknown publication evidence.

An outer GitHub 403 submission error qualifies only when its validated quota
headers identify `core` with string remaining `0`; authorization/validation
errors cannot inherit a transient status from response-body text. Quota failure
errors and Claude's `.failure` sidecar retain only bounded ASCII rate metadata,
at most 4096 characters, without the body. Optional reset data remains unknown
when absent; invalid metadata is rejected. Raw response artifacts and unavailable
final-inventory handling are unchanged; live receipt and head checks still run
before the failure marker can determine the outcome.

PR reviews and approvals default to `opus-5-high`; on a Claude output limit or a
repeat-only publication refusal they recover once with `gpt-6-astra-ultra`.
Pass `--model` and `--recovery-model` to `--pr-review` or `--pr-approve` with
any identity from the catalog.

PR review prepares an independent temporary checkout at the packet's exact head,
with its merge base available. `github-interface --checkout-review` checks the
live head and base before and after preparation, disables Git hooks and user
configuration, limits preparation to 180 seconds, and rejects incomplete trees,
more than 20,000 tree entries, or more than 256 MiB of tracked content. The checkout
is removed after the provider finishes, fails, or is cancelled. Approvals retain
their existing packet-only behavior.
Head or base drift at either checkout check returns `outcome: superseded` with
the validated observed head. Caller records the review as `superseded` without
invoking a provider, preserves its launch provenance, and lets Poise reconsider
the current PR. Other checkout failures remain failed.
Preparation uses a sparse checkout: archives, images, fonts, media, and bytecode
remain in the tracked-file inventory but are not downloaded. Reading one returns
an explicit text-unavailable result. All other tracked source remains available.
Checkout uses the remaining preparation deadline; a timeout is reported explicitly.

Every PR reviewer receives AGENTS.md and CLAUDE.md guidance from the pinned merge
base, including nested files and their paths. Guidance is limited to 256 KiB,
applies within its directory scope, and cannot change the review contract. Changes
to those files in the PR are source to review, not new authority over the reviewer.

Repository inspection is a read-only interface, not permission to execute code.
`github-interface --review-context --requests-json JSON` accepts 1-8 requests with
`operation` (`read`, `search`, or `list`), repository-relative `path`, `query`
(literal search text, otherwise empty), and `start_line` (1 initially). Reads and
lists return up to 200 entries, searches up to 100 matches; use `next_line` when
`truncated` is true. Search covers tracked UTF-8 files up to 4 MiB. Shared path
components are checked once per search request and revalidated on subsequent
requests. Responses are limited to 64 KiB including JSON formatting. The budget is
shared across requests; dense batches return shorter pages with lossless `next_line` continuations.
An entry too large for its share asks for a separate request. Git metadata, untracked files, symlinks,
path escapes, writes, test execution, and arbitrary commands are unavailable.
Reading a non-UTF-8 file returns an explicit per-file error and no text; other
requests in the batch still return their results. Binary content is not decoded
with replacement characters or treated as inspected source.

Claude reviews with the governed `github-interface` tools and can invoke that
inspection command from the pinned checkout. Every other provider
returns a structured JSON verdict instead; Caller validates it and invokes exactly
one existing `github-interface` terminal command with the original PR, actor, and
expected head. For PR review these providers can first return `action: "inspect"`
with provisional `comments` and a `requests` array; Caller reads the requested
source and supplies the result in their next turn. Terminal verdicts require
`requests: []`. At most 12 inspection rounds fit within the existing total review
deadline and 3 MB prompt limit; exhausting inspection never submits a review.
After a successful provider call, an invalid response gets one correction attempt
with the rejected output and validation error, within the remaining review budget
and prompt limit. Codex reuses the same review conversation. The same validation
checks apply; a second invalid response fails explicitly without submitting.
Codex messages at or below its 1,048,576-character input limit keep their existing
single-turn path. Only overflowing messages are sent as consecutive bounded
fragments through the same native review conversation. Intermediate turns must
acknowledge the exact fragment number; only the last can return a verdict or
inspection request. The full input is retained, the existing total deadline and
3 MB limit still apply, and partial staging, mismatched conversation IDs,
failed turns or native tool use submit nothing.
Each provider process runs in a separate temporary directory with native tools
disabled, receiving the same explicit guidance and scoped inspection access: Codex
(Astra, Sol; CLI 0.154.0 or newer, signed in to ChatGPT — API credentials are not
used) with read-only sandboxing, user configuration ignored, and shell, connector,
extension, and delegation tools disabled; Grok Build (`grok`) in one turn with
its built-in tools, web search and subagents off; Antigravity (`agy`) in plan
mode, the packet streamed on stdin; Muse (`muse`) with an isolated configuration,
an empty tool roster, workflows and reminders off, schema-enforced output and
one model step per inspection round. Sign-in is preserved without importing
personal settings. A run that used a native tool, failed, or still has no valid
inspection request or terminal verdict
submits nothing, and the existing authoritative outcome check still determines
completion or supersession.
An explicit provider refusal, exhausted Grok balance, or local Muse account latch
is recorded as `review_provider_blocked`; transient provider outages remain retryable.

While a model is analyzing a PR, Caller checks its live head approximately
every 30 seconds through `github-interface --head-sha`. Only a valid response
for the original repository and PR can cancel the run. Failed, timed-out, or
malformed checks leave it running. A per-run submission lock lets an in-flight
GitHub command finish and prevents cancelled workers from starting another one.
Cancellation stops the provider process group and records `superseded` with the
observed head, preserving the launch provenance. Poise then reconsiders the PR
through its existing scheduler. Normal completion still uses the existing
terminal head checks and authoritative review outcomes.

Before provider invocation, verified head or base drift at either PR packet guard
also settles as `superseded`. The packet CLI returns the original repository and
PR with the validated observed head; Caller checks that target before caching or
launching a provider. Base-only drift may retain the expected head. The audit
response and launch provenance remain durable, and normal reconciliation admits
the current revision. Missing or malformed revisions and packet-read failures
remain errors.

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
the catalog's review effort and an explicit 128,000-output-token limit in the trusted CLI settings.
The limit applies per response. `pr_approve` has no inspection tool, so all its reasoning
is one response, and Claude Code restarts a response cut at the limit without that reasoning.
Other behaviors retain their existing model assignments and limits.

Local pinned-repository inspection has a separate 30-second deadline, capped by
the remaining review budget. Structured analysis also caps each inspection by
the remaining analysis allowance and current file group's deadline, keeping the
60-second submission and 60-second verification reserves even after a provider
returns near the analysis cutoff.
A timeout records `review_inspection_timeout` and
retains the inspection phase, deadline and pinned target in the existing process
diagnostic, without command arguments or inspection content in the error.
Poise excludes this diagnostic from provider backoff, including older calls
labeled `review_budget_exhausted`. The existing behavior chain retries the same
review basis and slot after resource release and native failure backoff, holding
after three failed attempts; Caller adds no inspection retry loop.

A Grok Build `pr_review` or `pr_approve` also has an 800-second analysis ceiling,
counted from when analysis starts, for one file group or many, with or without
inspection rounds. With no verdict by then the run stops, posts nothing and fails
with `review_budget_exhausted`, which Poise reads as a hand-off to the next slot. A
verdict returned inside the ceiling still submits within the shared budget. Other
providers and Grok issue reviews are unchanged.
The existing v1 diagnostic records this planned handoff as `provider.review`,
phase `analysis`, outcome `handoff`, and positive `submission: none` evidence.
A shorter overall or file-group deadline remains a terminal timeout, not a
provider handoff. [Logging](../../docs/Logging.md#observe--logging) requires
attributed successor evidence before displaying the handoff as Warning.

On an Opus output-limit error or a repeat-only publication refusal, Caller can recover
once with the recovery model using the same immutable packet and remaining budget.
An approval's exhausted structured-verdict correction can recover once with its
original model under that same Call, packet, policy and deadline. The existing durable
`recovery_model` guard is consumed before launch, including when it names the original
model, so a restart cannot grant another recovery.
Claude Code reports the output-limit error only on a fourth cut. At about 110 tokens per
second, Opus's rate measured on 2026-11-04, the budget ends first, so a review whose
responses keep reaching the limit ends at the time limit and does not recover.
GitHub must first confirm the same open head and no new or pending reviewer action.
A verified completed action is adopted instead. Ambiguous activity, time exhaustion,
or failed recovery leaves a typed failure for Poise to retain without automatically
repeating unchanged input. Every recovery exit keeps the refused first attempt beside
the re-verdict outcome, including a later supersede.
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

### Capped review rounds

`--pr-approve ... --review-cap-reached --review-round N --review-cap N` runs
the capped round. On and after the cap, any verified `p0` (breaks a common path)
keeps the whole atomic change request blocking, including mixed p0/p1/p2
findings. Missing or unrecognized severity also stays blocking. Only when all
finding bodies explicitly start with `[p1]` or `[p2]` (case-insensitive) does it
file one follow-up issue via `github-interface --create-pr-linked-issue` and
approve; a round with no findings approves without filing. New findings carry
a severity prefix; reaffirmed threads keep their original bodies.
The issue body starts with a marker for its pull request and
head (`<!-- poise:review-cap #N@sha -->`), then one finding per section, each
pinned to the reviewed head — or to its base for removed-side findings.
A rejected filing approves nothing and raises a contract violation;
an uncertain filing (timeout, transient GitHub error, exit 0 without a
receipt) raises a submission error for Poise to reconcile, and the retry
reuses the marked issue instead of filing again. An existing marked issue
never bypasses the breaking-finding check. Structured providers review as usual
and the harness converts only explicitly nonbreaking change requests;
Claude receives the same severity policy and can request changes or file the
issue then approve. It must submit nothing when filing fails.

### Staged and follow-up reviews

A governed review admits up to 3,000,000 UTF-8 prompt bytes. Diff generation
is capped at 2,850,000 bytes and the serialized packet at 2,950,000 bytes,
leaving room for context and policy. Existing bulk-data compaction rules still
apply. These byte limits do not guarantee that an input fits a provider's token
window. Claude receives the whole packet in one call.

A structured review whose packet exceeds one provider call's reliable size
runs in file-group stages targeting at most 8 files or 200,000 diff bytes each.
Individual files stay intact and can exceed the byte target. All groups share
the same head watch and total time budget; retaining more code can increase
review duration and usage. Codex keeps one native conversation across file
groups and inspection rounds, retaining earlier analysis and inspected source.
Structured reviews reserve 60 seconds for submission and another 60 seconds
for the authoritative outcome lookup. Submission keeps that verification
reserve even when it is slow. After the first common-context turn, staged
inspection shares the remaining analysis allowance across the remaining file
groups. Each group stops offering further inspection once half its allowance
is spent and requests a terminal assessment on the evidence already held.
Provider execution and inspection stay within the group's deadline; a timeout
still fails without submitting an incomplete review. Every stage's findings
combine into the single verdict the harness submits; a packet that fits in one
group needs no staging.
A follow-up (`--pr-approve`) round reviews the diff since
the reviewer's last submitted review instead of the whole PR again: new
findings on current lines stay on current-head lines, while a defect caused
by a removal is commented on the removed line and validated against the full
pull request diff before the single submission. An unfetchable last head, or
a base that moved since the last review, widens the round to the full diff
instead. Both full and follow-up reviews validate every inline location against
the retained PR diff before invoking the GitHub submission command. Any finding
without a verified position fails the review before
submission, including a capped round's follow-up issue and approval.
Removed lines are mapped by their content within the current-head span of their
change block; ambiguous matches fail visibly. Reaffirmed unresolved findings
keep their original thread coordinates, including outdated findings absent
from the current diff.
Every run reports its budget usage
(`used_seconds` of `total_seconds`) in its terminal progress snapshot and in
the completion result, so a near-miss is visible before it fails.

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

Issue-review and atomic implementation/repair providers and their commands run
without `AGENT_INTERFACE_RECEIPT_DB` or `AGENT_INTERFACE_RECEIPT_CALL`. Scratch
and managed build caches stay inside the run. Caller retains its receipt binding
for resource checks, trusted publication and cleanup.

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
and `stopped`. A failed provider's error is its own bounded redacted message
or stderr, never its output stream, which can hold whatever a full-access
shell printed; a provider-reported failure terminal rejects the run even when
the process exits zero. The instruction names the provider deadline and asks
for the artifact early; a timeout records the artifact's presence, size and
readability in the diagnostic and never posts late work. A posting timeout is
reconciled through the call marker before it counts as a failure, and stays
uncertain until then. A Claude output limit before posting recovers once with
the recovery model in a new checkout, though at Opus's measured rate the fourth
cut that reports it comes after the 3,600-second limit, as under
[Review limits and recovery](#review-limits-and-recovery). github-interface runs in its own process
group, so a timeout also ends the git it started; a mirror left broken is
cloned afresh once. `--models` lists `issue_review_providers`.

# Incremental log reads

Bare `--logs` retains its complete oldest-first array. `--logs --status running`
uses the running-call index; `--logs --limit N [--cursor C]` returns a bounded
insertion-order page with an opaque `nextCursor`. Insertion order is not a
call's start time.
The full-history read sorts positions through the existing covering index
before loading each retained payload, keeping prompts and artifacts out of
SQLite's temporary sort without omitting historical receipts.

If a page's records are unreadable but its count and index still verify the
requested scope, Caller returns the readable records and quarantines the
unreadable positions. Those positions count toward the page and preserve its
cursor. Swarm reports them alongside the readable history. Receipt lookups
retain their existing integrity checks.

The full-history read quarantines an unreadable record with what still reads
cleanly: its identity (`id`, `repo`, `pr_id`, `behavior`, `correlation_id`,
`session_id`, `source`) and its lifecycle columns (`status`, `started_at`,
`started_at_precise`, `completed_at`), each only when it decodes. Damage usually
hits the JSON columns, so Poise can still count the call in run metrics; the
lifecycle never stands in for the unreadable result.

`--logs --id CALL_ID` reads one exact History record. A primary-key index
lookup first verifies the requested ID; an unreadable record returns that ID
with the existing typed `history_read_error` cause. Missing IDs return an empty
array; unavailable identity/index evidence fails the read. Swarm's exact Call
lookup uses this History read without running interruption reconciliation.
Ordinary selected receipt reads remain strict.

Bounded pages, running reads and exact History reads include the stored
`history_rowid` as a decimal string. Swarm uses it to count unreadable rows
once across feeds, even when a Call ID cannot be decoded or its page index
changes. It supplies no receipt or action evidence.

`--logs --select '{"latest":[{"behavior":"pr_review","source":"poise:review-new-prs","owner":"autonomio"}],"ids":["FULL_CALL_ID"]}'`
returns an oldest-first array containing one indexed latest-started call per
behavior/source/owner needle plus exact call-ID lookups. Missing kinds return
no row without traversing history. There are at most 256 latest needles and
1,000 IDs; invalid or larger requests fail. Poise shares identical selections
in flight and for five seconds, and decodes large responses off its main thread.
Development parses share one temporary build while workers are active, then
remove that owned directory after the final worker stops, including failures.
Production continues to use its packaged worker asset.
An unsupported command or failed read marks dashboard history unavailable,
rather than proving that a behavior has never run.

Native resource maintenance selects at most 32 exact correlations with
`resourceRecovery: true` and empty `latest` and `ids` arrays. Each indexed
position is rechecked against the record's correlation. Unreadable positions
return the requested correlation and a typed quarantine reason. An unavailable
index fails the request. This mode leaves Call status reaping to maintenance.

Before launching content, `--logs --watermark` returns an insertion `cursor`.
`--logs --after CURSOR --session SESSION --behavior author_content --prompt TEXT`
then returns at most two exact candidates inserted after that boundary,
including completed and failed calls. Two candidates preserve ambiguity;
neither an early completion nor an old matching call is mistaken for absence
or for the new launch. These arguments stay separate so a permitted topic
does not expand into an oversized JSON command argument.

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

The installed PR stop gate reads the live PR author from `--current-pr`. When
`CALLER_GITHUB_READER` (the main account) is configured, agent-authored PRs wait
for that account; main-authored PRs wait for `CALLER_PR_REVIEWER`. Missing author
evidence and equal identities fail explicitly. Neither account is switched.
