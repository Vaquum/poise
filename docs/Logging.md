# Diagnostic data contract

The shared diagnostic primitives live in `gateway/src/diagnostics/`. They use
Node and Poise's existing SQLite dependency. `normalize` produces immutable
version 1 records; `DiagnosticStore` owns bounded persistence and authorized
queries; `DiagnosticRuntime` owns buffering and independent collection health.

## Events and identity

Each record has an event ID, incident ID, source event time (null when unknown),
ingestion time, normalized severity, original source level, component, operation,
phase, target and available workspace/container/release/account/repository/PR/
behavior/reviewer/call/request/correlation identity. Absent facts remain null.
Cause chains, stderr, stacks, process outcomes and resource observations are
bounded. A multiline exception is one occurrence. Incident identity includes
the workspace, access scope, operation, target and cause. Event IDs carry a
scope digest, preventing another workspace from claiming an existing event.
Event identity is independent of source/ingestion time and container replacement.
Duplicate delivery is idempotent; expired IDs cannot resurrect pruned evidence; contradictory content for an existing ID is
reported rather than overwriting evidence.

Fatal, Critical, Crit, Emerg, Alert and Panic map to Critical; Error and Err to
Error; Warning and Warn to Warning. Syslog priorities 0–2, 3 and 4 map to those
same three levels. Notice, Info, Debug and Trace (priorities 5–7) produce no
Logging event. Unknown levels or invalid source timestamps produce visible
collection warnings with the original source identity. Notification colors and
successful change-request reviews do not determine technical severity.

For future collection, a failed `pr_approve` with
`approval_blocked_unresolved_conversations` is Warning only when the complete
original flat Caller Error envelope records `provider.review`, `submitting`,
`exit`, `submission: blocked` and explicitly untruncated stderr, with the original
`not_started` / `preflight_failed` result and null executed head. Missing or
conflicting evidence, publication receipts and process or cleanup failures retain
their authoritative severity. The shared source classification governs storage,
delivery, filters, counts and export; retained events remain immutable. Approval,
backoff and resource gates are unchanged.

Repair preflight refusals are retained as Warnings when a failed `repair_pr`
Call has `not_started` / `preflight_failed`, no executed head, and either
`atomic_work_blocked` or `atomic_work_failed` with the exact cause
`repair did not answer every unresolved review finding`. Structured process
failure evidence remains authoritative. This classification changes neither
Caller status nor publication, retry or hold rules.

The typed pre-publication [issue revision fence](Issue-review.md#when-a-reviewer-fails)
is routine supersession and creates no new Logging event or work-error count.
The metadata-only diagnostic feed carries that invariant without receipts,
publication artifacts or ownership, but with artifact and ownership cleanup
failures; omitted fields alone never prove that nothing was posted. A cleanup
failure recorded after the terminal result requeues its diagnostic, so a poll
that already passed still sees it. This correction applies to future collection.
Retained events are immutable, so an Error already stored for a stale review keeps
its original classification.

Credentials, encoded Git authentication, authorization/cookie headers and
credential-bearing URLs are redacted before persistence. Context excludes
prompts, content, responses, stdout, arguments, environment and conversation
fields recursively. Strings and nested context are bounded; truncation is
explicit. The source adapters select Caller metadata without reading prompt or
response fields, and preserve its exact process evidence when available.
For newly captured Caller completions, a nonempty diagnostic context message
distinct from the summary is retained in the cause chain. Review deadlines keep
their recorded phase, file-group position and remaining budget in the same
event detail. Missing causes remain absent; stored events are not rewritten.

## Observe → Logging

By default, Observe → Logging opens a server-paged table of retained events, with all three
severities and Any time selected initially. Filters cover the full permitted
store; the count is matching events, while each row's occurrence count describes
its retained incident. Source time is displayed in Settings' timezone; missing
source time is explicitly labeled as ingestion time. Today, Yesterday and This
week use civil boundaries in that timezone. Custom intervals require UTC offsets.

The behavior chain's evidence is in Observe → Tasks: cutover and legacy
ownership, capacity, active/held work, sequence-checked Hold/Resume and
paginated journal history. Notifications' Journal evidence action opens its
recorded journal cursor there, including after reload. These are reads of the
canonical chain journal, separate from Logging's diagnostics and their Work impact;
they create no new Logging events. General keeps only chain
preferences and guarded cutover controls.

Column headers own the severity, time, source and exact identity filters. Columns selects optional workspace/account/repository/call/correlation/incident fields; an active filter keeps its field visible until cleared. Search and the event count remain in the native toolbar. Filters stay usable after a failed query.

The normal view contains no retention, snapshot or coverage prose. Data and collection opens a structured inspection panel with retention bounds, timezone, snapshot/read times, current source observation and expandable historical gaps. Current connectivity is independent of historical completeness: a recovered source can be connected now while its retained coverage remains partial. Legacy partial records without current evidence remain unknown until observed again. Historical gaps and normal filtering metadata do not create notifications; genuine collection failures retain their diagnostic evidence.

Expand a row with its evidence button (Enter or Space). Cause, stderr, stack,
resource units/measurement time and truncation are shown as recorded. Related
incident/correlation reads use the applied time, severity and access scope,
twenty events per page. Recorded Caller runs open Observe → Behaviors; valid repository/PR
pairs open GitHub. Unrecorded targets have no link.

Each list snapshot also reads the owner's existing managed chain journal in one
batch for retained Poise/Caller records with exact Call or correlation identities.
Each batch scans retained invocation candidates once and validates matching chains
against the journal. Ambiguity across either selector is rejected before checking
that both selectors agree; repeated input positions retain their order. The next
request reads current journal state, including changes since the preceding batch.
The Work impact column leads with retrying/blocked/recovered/unknown, the verified
target and stage. Duplicate diagnostics retain their event rows and identify the
same work target; Count still measures retained diagnostic occurrences.
Rows and expanded details share the same verified result. Impact is verified at
the list snapshot read and replaced by Refresh or applying new diagnostics; the
fifteen-second watermark poll does not update displayed impact. Returning to the
cached first page restores its impact snapshot too.
Details keep the recorded stage and target,
last verified progress, and the next recorded retry or action. Progress must follow
the exact matched failed invocation to establish recovery; unchanged polls and
failed retries do not advance it. A recovered failure remains visible alongside
an independent hold, with current impact blocked. Missing, conflicting, legacy or
unreadable associations show unknown. A failed workspace read leaves retained
Logging evidence usable, including in service mode. Source severity and Count
(retained event/occurrence count) keep their separate meanings. This annotation
neither starts work nor changes execution or holds.
For a new typed analysis handoff with positive no-submission evidence, the
displayed severity is Warning only after a later admission for that original
Call's same PR, head, review basis and slot, or its attributed substantive
successor verdict. A changed head, green CI, an earlier or independent sibling
review, or generic work progress cannot confirm the handoff. No successor,
failed recovery, a current hold, uncertain publication or unavailable evidence
keeps Error. The active blocker and next action remain visible. The retained
source event stays Error: severity filters, counts and exports continue to use
that immutable source severity. Refresh replaces the displayed work assessment;
historical rows without typed no-submission proof remain unproven.
For a verified merge with a pending native review obligation, the next action is
to reconcile original pre-merge review evidence, including when a durable hold
is retained. Resume cannot start a new review after merge.

Filters and the selected view survive reload. A mounted refresh preserves focus,
scroll position and ID-keyed expansion. Only the visible first page checks for
new ingestions every fifteen seconds; late older events count too. Apply the
new-diagnostics button to replace the snapshot. Other pages retain their snapshot;
hiding the document or leaving Logging cancels reads and stops polling. Failed
refreshes visibly retain a stale snapshot with its last-success time.

Durable `/?view=logging&event=ID` or `incident=ID` links accept optional zoned
`from`/`to` bounds. They replace saved filters visibly, expand/focus the target,
and offer Restore saved filters. Missing bounds use recorded time ± one hour;
provided bounds widen visibly when needed. Invalid, unavailable, expired and
query-service failure states are distinct and show available retention bounds.
Export NDJSON reads a fresh matching snapshot, independent of the current page.

## Retention and queries

Browser reads use `GET /_poise/api/logging` on the owner's workspace host, with
its existing `poise_ws` session. Device tokens and identity assertions cannot
replace that session. An Origin, when supplied, must match exactly. The gateway
reads central history itself, without starting or querying a workspace.
`scope=instance` is an explicit administrator choice checked on every request;
it never grants another owner's private application or Caller evidence.

`/logging/events/ID`, `/logging/health` and `/logging/export` share that boundary.
Local development uses `/api/logging` and the same suffixes under its loopback,
Host and Origin rules. Service workspaces refuse this alternative query path.
The HTTP and operator JSON adapters share filter validation. HTTP `severity`
may repeat; a single empty value selects none. Times require valid zoned ISO
timestamps, and unknown or duplicate scalar parameters fail explicitly.

One worker handles reads away from agent/request execution, with at most sixteen
queued jobs and two outstanding responses per owner across scopes. Admission is
held until the response finishes or closes. A two-second budget includes queue,
execution and response backpressure. Saturation returns 429 with Retry-After;
timeouts and unavailable/unsupported stores return explicit 503 errors.
Unknown and inaccessible event IDs both return 404; only authorized retained
expiry evidence returns 410. Health projects independent collection state and
never exposes other owners' private counts or causes.

Export is NDJSON, with metadata first, at most 1,000 events and 8 MiB including
metadata. `resumeCursor` and `truncated` describe bounded partial exports; resume
with the same filters and that opaque cursor. No CSV or logged URL is executed.
An explicit HTTP `limit` also caps the exported row count (1–100); omitting it
uses the export's 1,000-event cap rather than the list's 50-event page size.

Defaults are **up to 30 days**, **64 MiB of accounted event storage**, and **50,000 events**;
the earliest bound reached expires evidence. Age and eviction use ingestion time,
so an untrusted future source timestamp cannot pin a record. Accounting includes the searchable
projection and an index allowance. Expiry tombstones retain only ID and scope
for up to one further retention period, capped at the smaller of twice the event
count limit and one tombstone per KiB of the storage budget (at least one).
Unknown and inaccessible IDs share one response; expiry is reported only from
an authorized tombstone. SQLite's page budget, cache and
journal are also bounded. Physical page pressure can expire the oldest evidence
before the logical byte/count limits. Pruning releases payload/index pages before
recording expiry, in the same transaction, and preserves write headroom without
raising the SQLite page ceiling. Records remain after a source or container disappears.
Source coverage and its unavailable intervals are separate from event counts.
SQLite allows up to 256 coverage records of 64 KiB each, with bounded identity
fields. Its page ceiling includes 32 MiB of separate coverage/index headroom,
twice the accounted event budget and 1 MiB for other metadata. This is a ceiling,
not preallocated storage; even a 4 KiB event budget admits subsequent events
when coverage is full. New sources beyond the cap fail visibly; updates to
existing sources remain permitted.
Coverage IDs affected by redaction use stable opaque identities, keeping source
updates and partial backfills distinct even when their labels redact alike.
Canonical source names and validated Caller call/correlation IDs keep their
structural identity for filtering and drill-down; a whole identifier matching
a configured credential is still masked. Technical evidence remains redacted.
Opaque OAuth/token assignments and quoted credential fields are masked by
field name even when the value is absent from the configured secret list.
The collection runtime has a separate coverage journal and in-memory health
path, so a broken event sink does not turn failed reads into an empty result.

Queries accept Critical/Error/Warning selections, time, source, component,
workspace, account, repository, call/correlation/incident IDs and redacted text.
Counts name events; occurrence counts name retained records in the incident.
Pages contain at most 100 records, newest first, with stable identity ordering.
AES-GCM encrypted cursors bind authorization, filters and an ingestion boundary,
without exposing the shared ingestion sequence. A scoped watermark supports
`after` queries for later ingestions, including backdated source events. Later
arrivals cannot displace the remaining pages. Event lookup distinguishes found,
outside retention, and unavailable evidence without exposing other workspaces.

A trusted server supplies `LogAccess`: an ordinary workspace scope cannot be
widened by a query, event ID or cursor. Operator scope is an explicit server
authorization for infrastructure events. It never widens access to another
workspace's application or Caller records. A safely attributable infrastructure
event can be read by its workspace owner and the operator; unassigned host
evidence is operator-only. Shared coverage hides operator-only cause details from ordinary
workspace queries. Collection buffers default to at most 1,000 events or 2 MiB;
sink failures and drops remain visible while active work continues. Invalid input,
query validation, coverage-journal and reporting failures remain distinct from sink
outages. Shutdown drains queued batches within two seconds, then records any loss.
Coverage preserves prior drops and open outage intervals across restart.

Quota observation continues every fifteen seconds with Notifications off.
A warning requires at least 50% forecast risk sustained across distinct
observations thirty seconds apart in one reset window; exhaustion remains
immediate. These technical records do not depend on popup issuance or dismissal.

## Collection and operation

The application starts a dedicated `logging.db` beside `POISE_DB` (otherwise
`~/.poise/logging.db`). This is independent of alerts, dismissal and recovery.
An adjacent private journal retains collection gaps and loss across restart.
Full Caller history reads are capped at 128 MiB (134,217,728 bytes). A successful
read at or above 96 MiB (75%) records one approaching-cap warning. A successful
full-history read below 96 MiB rearms the warning.
The bounded Caller completion stream is polled every 15 seconds without
opening prompts or response/reasoning artifacts. Process capture excludes argv,
stdout and environments; credential commands also exclude stderr. Sync phases,
input admission limits, model-discovery outcomes, lock acquisition failures and
temporary-filesystem pressure retain measurements known at the source.
Managed datastore failures are reported once by `datastore.sync` or
`datastore.activate`, retaining the process exit code and stderr alongside retry
and freshness context. Standalone datastore process failures are still reported.
Legacy `resolve-unblocking` and `merge-prs` mutation commands (including branch
updates) are reported once by their behavior handler after failure bookkeeping,
with the primitive, target, phase, native attempt identity, original process
result and recorded retry evidence. Cancellation or failed bookkeeping cannot
erase that original failure; independent wrapper and invalid-output failures
remain visible. Resolve uses Warning only for a confirmed no-action transient
exit with a recorded safe retry. Uncertain outcomes, timeouts and policy
refusals remain Errors. Separate attempts retain separate event IDs.
Legacy approval batch reads, the final head check and checkout preparation, and review
launch checkout, retain one Error per failed child after recording the scheduler
consequence. The fixed primitive, phase, checked targets, available expected heads,
correlation, original process timing/result and recorded retry state travel together.
Two failed children remain separate even within one sweep correlation; cancellation
or failed retry bookkeeping cannot erase either cause. These diagnostics do not change
backoff, launch progress or the exact-head publication checks, except a stalled review
checkout defers without backoff and retries on the next tick.
Checkout failures use phase `checkout` and fixed operations
`github-interface.local-checkout-path` or `github-interface.checkout-repo`;
other checkout callers retain default process reporting.
JavaScript DOMException identity and numeric code are retained in context as
`exceptionName` and `exceptionCode`, with no process `exitCode`. Actual subprocess
exit codes remain process evidence, even when the same number names an exception.

Outside those owned mutation diagnostics, untyped GitHub 5xx and transport failures from `github-interface`,
`github-datastore` and Caller completions retain Warning evidence. A bare exit
code, access refusal or local failure still retains Error evidence; an explicit
Caller diagnostic keeps its source severity. This classification never retries
a mutation or clears an uncertain publication hold.

A legacy PR review worker's exit 1 keeps its exit state in the launch claim.
When a readable failed timeout matches that invocation's launch provenance and
its Caller Error is accepted by Logging, the callback omits the generic worker
Error. It uses the same Caller event identity as periodic collection, including
timeouts with no process diagnostic object, so delayed collection and replay
retain one occurrence. Missing or unreadable results, rejected capture and
independent process errors or signals keep the worker failure visible. Retry
and publication rules are unchanged.

The same correlation covers initial-review and approval workers that exit 1
after a matching GitHub 503 explicitly recorded as `not_started / preflight_failed`,
with no executed head, review ID, comments or receipts. A fresh readable Caller
history must confirm the original Call and remaining retry budget, with no
ambiguous evidence or retained hold and the behavior still runnable. Logging
accepts that Call's diagnostic at its adapter severity, including Warning, before
omitting the duplicate worker Error. Publication-time 503s, exhausted or held
retries and unverifiable evidence retain the worker failure and original Call.

Claude auth status probes from the auth monitor and Connected accounts treat a
recognized sign-in requirement returned with exit 1 as an ongoing condition,
without another process error. The existing sign-in notice stays until the
monitor verifies recovery with its canary. Status JSON must contain a boolean
`loggedIn`; unrecognized output (including exit 0), other exit-1 failures,
start failures and timeouts remain diagnostic errors.
The auth monitor also keeps a missing optional Claude CLI unavailable without an
Error only when the wrapper reports `spawn claude ENOENT`, the strict account
record has no Claude connection, no sign-in was previously observed by the
monitor, and no launcher entry exists on its launch PATH. Broken launchers and
unreadable account or path evidence retain the Error; the launch gate is unchanged.
The live canary owns its failure diagnostic, retaining a fixed recognized reason
from bounded probe evidence, or `cause unavailable`, with the process outcome.
It retains no provider output. Unchanged reason/outcome repeats are suppressed;
a changed cause or outcome, or a recurrence after successful live verification,
is retained again. This recognition changes neither readiness nor retry policy.

The gateway retains its separate central `logging.db` in `poise-gateway-data`.
Existing volume backup/restore snapshots it with the other SQLite databases.
Gateway warnings/errors are redacted before Docker stdout and retained directly.
New `disk.workspace.over_budget` Warnings retain measured usage as `context.bytes`
and the configured threshold as `context.budget`, in bytes, in the existing
expanded detail. Each count is independently validated as a non-negative safe
integer; zero is kept, while missing or invalid counts remain unknown without
coercion. Previously retained entries cannot recover discarded fields.
Recovery remains `disk.workspace.within_budget` at Info and is not retained.
Every 15 seconds the independent collector reads bounded Docker logs/lifecycle
windows for managed workspaces, Poise Compose services and release-install
tasks. Only validated structured workspace envelopes enter private history;
ordinary unstructured output is intentionally outside the diagnostic contract
and does not create a coverage gap.
Docker OOM, nonzero exit and unhealthy events use native lifecycle meanings.
Workspace backfill reads three durable events per authenticated maintenance
page and commits its checkpoint only with central persistence. Replacement or
removal of the source does not delete central records. Query/collection outages
never become empty successful reads.
Caller ingestion waits for the runtime's scheduled 100-event persistence batches,
leaving event-loop turns for queued maintenance requests within the collector's
five-second complete response budget. Its completion checkpoint still waits for
durable local ingestion.

The gateway reads native host kernel and `docker.service` Warning-or-higher
journal records using `journalctl`, with a durable native cursor. Compose mounts
only the journal directories and machine ID read-only; workspaces receive no
journal, Docker socket or central-store mount. Missing journals, insufficient
permissions, unavailable Docker and incompatible old workspaces remain explicit
source coverage failures. The first observation
is not a claim of complete history before installation. Polling bounds can
limit historical replay; Docker's own retained native event history is finite.

When a workspace cannot open, the host operator can investigate with:

```sh
docker exec poise-gateway node dist/diagnostics/cli.js health
docker exec poise-gateway node dist/diagnostics/cli.js query '{"severities":["error","critical"]}'
docker exec poise-gateway node dist/diagnostics/cli.js event EVENT_ID
docker exec poise-gateway node dist/diagnostics/cli.js export '{"limit":100}'
```

Export is paged NDJSON with metadata, bounds and a continuation cursor. It
includes infrastructure/operator records, never another owner's private Caller
or application history. External proxy installations may send one native JSON
record through `docker exec -i poise-gateway node dist/diagnostics/cli.js ingress`.
The command requires a request host inside `POISE_DOMAIN`, bounds input to
64 KiB, excludes headers/query/payload context and acknowledges the event ID
only after persistence. The operator owns delivery/retry and must not forward
unrelated business-service logs. No public or workspace ingestion endpoint is
added. Unconfigured external ingress coverage remains unknown, not healthy.

The deployment verifier uses the same private socket through the operator
`deployment` command, with a bounded health snapshot. An observed replacement
drain that exhausts its positive verification budget (normally 600 seconds)
retains one `workspace.deployment.pause` Error per full rollout ID and workspace.
Zero-second receipt reads and routine waits create no Error. The requested
revision comes from the receipt; health's desired release and switch age remain
context, with unavailable blocker/retry evidence unknown. The first accepted
snapshot retains the exhausted budget, elapsed seconds, serving revision and
admission state unchanged across verifier processes. Durable observation state
prevents delayed evidence from reopening a recovered pause. A Warning in the
same incident records observed restored admissions or the same rollout's exact
completion proof; missing health, supersession and another rollout's completion
cannot establish recovery. The rollout stays pending until its existing release
and build/image verification gates pass. Diagnostic delivery failure is visible
on stderr and does not change those gates.
Only a complete response containing solely the private writer's exact busy
refusal is retried for `deployment`: at most five connections, waiting 250,
500, 1,000 and 2,000 milliseconds between attempts.
The writer drains refused connections until client EOF or the existing 30-second
connection deadline, preserving the reply when the client writes before reading it.
The complete observation frame, including its original timestamp and health
snapshot, is read once within 64 KiB and replayed unchanged. Input, attempts and
waits share one 30-second delivery deadline; the verifier's proof clock is
unchanged. Other refusals retain a bounded, redacted cause and fail immediately;
an ambiguous disconnect, bare write error or incomplete reply is not retried.
Exhausted contention leaves the verifier's warning visible. Manual ingress and
the continuous reader keep single attempts and their existing input/handshake behavior.

External Caddy installations can instead run the bounded continuous
[operator reader](../deploy/ingress/README.md). A dedicated forced-command SSH
key reaches only `ingress-stream`. Its version-1 handshake returns the configured
domain and durable source checkpoint; a single bounded JSON batch carries the
expected checkpoint, container, UTC source window and projected records. Events,
coverage and the next checkpoint commit atomically before acknowledgement.
The source's optional `observationExpiresAt` lease makes current health unavailable
after 90 seconds without reporting. Initial history replays retained native records
within 30 days (an empty source starts with five minutes); rotation, replacement and irreducible read bounds remain explicit
historical uncertainty/gaps. The reader excludes unrelated hosts and request
payloads before transport; canonical gateway normalization/redaction remains
authoritative. Manual one-record delivery cannot renew this continuous lease.

Caddy's native `warn` from `http.handlers.reverse_proxy` with message
`aborting with incomplete response` is a normal close only for GET
`/api/link/events` and the exact cause `reading: context canceled`. That warning
occurs after response headers; it supplies neither status nor content type.
The edge derives this one fixed route label before discarding the request URI.
Missing discriminators, other routes, unexpected EOF, refusal, timeouts and
other cancellations remain faults. All ingress paths retain the redacted native
cause in `stderr`. A successful cancellation-only scan advances its checkpoint
and renews observation without adding a fault or a gap; failed and bounded scans
keep their existing coverage semantics. Link reconnect and replay are unchanged.

Production starts capture after secure environment validation and before the
application database modules load. An uncaught process failure retains a
Critical event and then exits with the existing failure status. Structured
stderr forwarding is capped by backpressure; local durable backfill remains
independent. Source records beyond Docker/window or native-line bounds produce
explicit historical gaps and do not pin later collection behind poison input.

Incident identity hashes the full redacted material cause, independently of the
short displayed summary and changing attempt/release/resource context. Native
journal collection uses `--all` with a bounded field projection and `--no-tail`,
so journalctl's default 4 KiB null substitution and ten-record follow tail do
not silently discard replayable evidence. See the upstream
[journalctl contract](https://www.freedesktop.org/software/systemd/man/latest/journalctl.html).

Operators configure `POISE_LOG_RETENTION_DAYS` (1–365), `POISE_LOG_MAX_BYTES`
(4 KiB–1 GiB), `POISE_LOG_MAX_EVENTS` (1–1,000,000),
`POISE_LOG_QUEUE_EVENTS` (1–10,000) and `POISE_LOG_QUEUE_BYTES`
(64 KiB–16 MiB). Defaults are 30 days / 64 MiB / 50,000 retained events and
1,000 events / 2 MiB queued. The first reached bound applies. Invalid values
name the configuration error at startup. These settings govern the central
store and, when supplied to a local application, its separate store.

The operator health command reads the independent coverage journal even when
SQLite is unavailable. Query/detail/export open the existing store read-only;
a missing store is an explicit error. Local development reports Docker, kernel
and ingress as not configured. External proxy record delivery remains partial
coverage unless a continuous observation boundary is established; a received
record does not prove complete proxy history.

Native container faults retain a bounded post-event inspection of actual
memory/CPU/PID limits and Docker's OOM state when available. The measurement is
labeled as post-event container state; it never substitutes a later usage
reading for usage at the incident. Removed containers or an exhausted inspection
budget leave explicit unavailable resource evidence. Exit 137 alone does not
establish an OOM cause.

The workspace image also ships `dist/runtime-diagnostic.js`. Provider bootstrap
uses it before the application starts: it preserves the existing 15-minute
command deadline and 30-second termination grace, drains bounded stderr,
redacts complete lines before truncation, and stores one source event per failed
command or native Warning. Native level detection precedes secret redaction;
only redacted text is retained or forwarded. Stdout and arguments are excluded. A diagnostic sink
or reporter failure does not change the installer exit status. Cwd-filesystem
measurements are labeled as such; an unobserved affected filesystem stays null.
Helper SIGTERM/SIGINT forwards to the detached installer group, waits for bounded
SIGKILL escalation even after the direct child exits, and returns status 143/130.

Bootstrap stdout is redacted during forwarding and capped at 64 KiB per command,
while its diagnostic event excludes stdout entirely. The bootstrap source file
is trimmed between commands above 2 MiB, retaining its latest 1 MiB; one bounded
command can temporarily add its 64 KiB stdout and 16 KiB stderr. Durable events
remain in the separate retained store after trimming.

CLI-update and model-discovery failures carry bounded redacted process evidence
through their existing reports, including configured/resolved executable paths,
exit/signal/errno, deadlines and elapsed time. The JavaScript updater and the
application use the same canonical redactor in `diagnostics/redaction.mjs`.
Workspace images ship that module for standalone maintenance scripts. Local
production build stamps include shared diagnostic sources, preventing a stale
server bundle after those sources change.

Expiry metadata is also limited by the byte budget (a conservative 1 KiB
allowance per tombstone), so a small retained-event budget cannot fill the store
with unlimited expiry history. Once that metadata expires, lookup reports
unavailable rather than inventing an expiry claim. Release-install tasks capture
their owned bounded stderr before Docker removes them; configured limits are
explicitly distinguished from unobserved incident usage.
Start/wait failures capture available stderr before cleanup too. Unknown task
completion keeps a null exit code and the actual control error; failed evidence
reads or reporting remain explicit and never replace the task's outcome.
Malformed, unsupported, non-finite or excessively nested Caller evidence advances with an
explicit unavailable marker; it cannot poison JSON pages or block later calls.


## Storage calibration

The automated `diagnostic-volume.test.ts` replay measures 100 qualifying records
across Git/Caller, datastore, Docker OOM, kernel/filesystem and ingress causes.
It also verifies that 1,000 routine Info observations produce no retained rows.
On the 18 October 2026 candidate, those records consumed 210,640 accounted bytes:
2,107 bytes per record, including search and the conservative index allowance.
At that fixture size, 64 MiB holds about 31,850 events; larger stderr reduces
that count. This is a reproducible fixture measurement, not a measured production
arrival rate. Thirty days is a maximum age, never a guaranteed history window.
The 50,000-event cap also bounds small records; bytes normally expire these
representative records first. Operators can size either bound from their own
retained event counts and observed coverage without running another log stack.

A permanent record rejection (including a configured byte budget smaller than
one record) is quarantined with a collection Warning when it fits and a durable
rejection count regardless. Accepted siblings and their native source checkpoint
commit together. A sink or checkpoint transaction failure instead preserves the
cursor for retry; native inspection metadata is not committed ahead of it.


`npm run check:gateway-docker` runs the real Engine workspace and source-history
proofs from a Node 22 container on the Engine host network. This also works when
a macOS checkout cannot directly route to Docker Desktop's private bridge IPs.
Only the isolated test runner receives the Docker socket; production workspaces
retain their existing restricted mounts and networks.


The workspace supervisor retains native spawn errors, unexpected nonzero/signal
exits, unavailable requested releases and early-release fallback observations
through the same private local store before the application starts. Expected
update exits and container shutdown do not produce fault rows. Reporting failure
does not change release selection or process exit behavior. The Docker adapter
also recognizes the entrypoint's three owned fatal configuration/home checks;
it assigns the verified container owner even when workspace environment setup
failed. Normal supervisor startup chatter remains excluded. Helper/reporting
unavailability is a collection Warning rather than an invented application cause.

Production shutdown retains one `process.shutdown` Error when cleanup rejects or
reaches its ten-second deadline, including pending runtime/HTTP phases and known
rejection causes. `pendingPhases` also names unresolved runtime stops, such as
`runtime_stop.agent_collaborator`, including the later ledger and Logging stops.
It commits through the same independent diagnostic store before
exit 1, including after runtime teardown has stopped Logging. Each supervisor
spawn overrides `POISE_SHUTDOWN_DIAGNOSTIC_ID` with a fresh launch ID. Only a
read-only lookup confirming that exact normalized event ID, owner, release and
shutdown Error permits a distinct `workspace.exit` Warning. Both records use
the launch ID as `correlationId`; the Error retains the shutdown cause and the
Warning retains the supervisor's actual exit code and signal. Missing,
unavailable or mismatched records leave an independent exit Error, and lookup
failure does not change supervision. Logging retains those events after a
healthy successor starts. Clean update exits (75) stay quiet.

Container discovery includes stopped containers and removes checkpoints only for absent container IDs; retained events survive that cleanup. Operator ingress deduplicates exact record replays, while separate records sharing a request ID retain distinct occurrence IDs. Bootstrap line capture keeps folded credential-header state across child output chunks before reporting or persistence.

The workspace/time index also covers visibility, ingestion retention and severity.
Broad retained counts therefore read index metadata without fetching every event
payload; writable stores upgrade the earlier three-column index in place. Query
filters, source-time ordering, snapshot cursors and retained counts are unchanged.
Compact scope counts and the covering filter/search metadata index avoid cold
payload-page scans. Page selection reads only identities/order keys; it loads
payloads for the selected page inside the same SQLite read transaction. Legacy
read-only stores remain readable before a writer installs the indexes. The
100,000-event parity and 500 ms gates retain their original limits.

Workspace log reads select stderr independently of ordinary stdout. Structured
envelopes, entrypoint fatal checks and the supervisor's reporting fallback use
stderr; routine output cannot consume that diagnostic window. Release tasks use
their dedicated evidence collector. A pass publishes one workspace-stream
observation after all container reads: a success for another container cannot
close an actual failed read. Caddy keeps its native streams. No Docker `tail`
limit is used as a completeness proof before the time-window filter.

The maintenance producer carries at most 16 source summaries and two latest gaps
per source, preserving the three-event / 256 KiB delivery limit. The central
collector validates this metadata before advancing the event cursor, retains
owner-scoped history and marks missing/truncated details as `historyIncomplete`.
Observed upstream loss counters are retained as lower bounds across replacement;
the inspector uses `≥` rather than presenting them as an exhaustive lifetime sum.
The dedicated store still caps each source's detailed history at 32 gaps and
retains an incompleteness marker when older details are compacted. Existing
ambiguous false gaps/Warning rows are not reinterpreted or deleted; already
evicted evidence cannot be recovered from counters.

Only deliberately unsupported local collectors use `optional: true`; required
production sources, including unconfigured external ingress, remain degraded.
A cached health snapshot is marked stale after a failed health read or 60 seconds
without a fresh read. Successful independent health cannot clear a failed list
read: a successful actual query must establish query connectivity again. Rows
and their earlier snapshot time remain available throughout a transport outage.

Current queue overflow/rejection is separately reported as `lossActive` in runtime
and independent browser health. The first transition is journaled immediately.
A successful drain/persistence boundary with no new loss clears active state;
cumulative counters and historical status remain. Legacy loss counters without
this observation field cannot establish recovery and remain initializing.

A recreated workspace store rejects obsolete delivery cursors explicitly. The authenticated collector records a collection gap, resets only that source checkpoint and resumes bounded retained-history backfill; authentication and other failures do not reset checkpoints. Bootstrap deadlines retain process-group SIGKILL escalation even when the direct child exits first, and await escalation before returning the timeout result.

Caller completion checkpoints include the source database's persistent stream identity. A replaced database causes bounded replay from zero and a retained collection gap, even when its new sequences are below the old checkpoint. Legacy numeric checkpoints replay safely rather than guessing their source identity.

Configured and explicitly supplied nonempty secrets are masked regardless of length, including their Git encodings. Literal replacement protects existing redaction markers. Validated public workspace handles retain their authoritative authorization scope when a short secret overlaps the handle; captured technical text remains redacted. Workspace and Docker diagnostic reads have absolute five-second deadlines in addition to byte and inactivity limits; response trickling cannot keep a collection pass open indefinitely.

The independent coverage journal has an 8 MiB read/write limit, covering the
maximum 256 sources with 32 bounded Unicode gap reasons per source. Clean
restarts preserve all retained gaps and accumulated drop counts.

Credential and private-field matching follows terminal/control-byte cleanup,
including recursive field names and streaming folded headers. Removed bytes
cannot reveal a credential name after its redaction check.

Atomic source delivery quarantines only the offending record, preserving the
first valid occurrence even when conflicting copies share one batch. Successful
deliveries update the exact source boundary’s last-ingestion time independently
of later coverage writes; coverage persistence failures remain explicit.
Every matching source is updated before SQLite coverage persistence starts, so
an earlier source's write failure cannot erase a later source's committed
ingestion time. The journal retains that time across restart and idle recovery.

Text capture also redacts spaced API/private-key names using the same key
separators as structured context. Caller registers coverage before its first
page is flushed, so the initial successful ingestion is recorded even when no
later failure arrives.

Successful Caller pagination and pending legacy backfill are temporary partial
coverage, not observation failures. Catch-up clears that state without creating
an outage gap or a synthetic warning; genuine observed failure gaps remain.
Review verdicts alone do not create diagnostics. A recorded operational failure
remains an Error even when the row also has a clean, approved or changes-requested
verdict and lacks structured process evidence; its cause is retained before the
completion checkpoint advances.

Empty Caller operation metadata uses the recorded behavior or `call.failed`,
preserving its cause and acknowledging the page so later completions continue.
Routine Info ingress delivery updates observation without erasing the last
retained ingestion time. Tombstone lookups enforce their age limit even when
the store is idle or opened read-only.

Text credential detection covers prefixed/suffixed password, secret and key
names as well as structured fields, without needing the secret value in the
environment. The truncation marker includes bounded signal and errno text.
Application exception chains retain the first eight underlying causes. A longer
chain or a detected cycle marks the persisted event truncated explicitly.

Age-expiry evidence starts when retention elapses. An idle store or later
cleanup cannot extend that evidence window beyond one further retention period.
An initial stale delivery or replay uses the same original ingestion boundary;
it cannot restart expiry evidence after that window has elapsed.

Release-task stderr reads from the beginning under the independent byte/time
budget, retaining the first 1,000 decoded stderr lines. Later omitted lines or
unavailable capture mark evidence incomplete explicitly. Docker's shared tail
window is avoided because filtered stdout can consume its records. Short lines
can reach the line limit even when retained text fits within its byte limit.

### Notification evidence

Expanded browser notifications and Behaviors diagnostics offer **View in Logging**
when the retained index contains an exact qualifying source record. The optional
`evidence` reference contains `eventId`, `incidentId` and zoned `from`/`to` bounds;
`evidenceReferences` preserves up to twenty distinct retained attempts before
presentation deduplication. Additional retained history is labelled. A pending
association or unavailable query service remains explicit and does not delay or
suppress the primary condition.

Association uses the existing bounded read worker and owner-scoped index, with
no ingestion or association database. Caller call IDs identify source events;
correlation IDs identify preparation attempts or producer conditions. A Behaviors
workflow incident, alert dedupe key and material-cause hash retain their separate
lifecycle roles. Source, workspace, target and material cause must match; a newer
record about the same PR cannot substitute for missing evidence.

Opening evidence preserves dismissal/silence state. Arrival cards keep their primary controls. Known links
keep the ordinary 410 expiry, indistinguishable unknown/foreign 404 and honest
503 unavailable behavior described above. Recovery, Notifications off and
container replacement do not delete retained source evidence.

Ordinary non-diagnostic workspace stdout/JSON is excluded by policy without manufacturing a collection outage. Malformed claimed diagnostic envelopes, read bounds, truncation and transport failures still retain warnings and gaps. Successful observation closes the current gap without deleting historical intervals; pending backfill remains a distinct degraded observation.

The Active loss observation includes authenticated workspace overflow/rejection,
independently of the gateway queue. Recovery clears that live observation while
retaining cumulative counters. A legacy producer with recorded loss and no live
observation remains unknown; a healthy central queue cannot establish its recovery.
