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

Credentials, encoded Git authentication, authorization/cookie headers and
credential-bearing URLs are redacted before persistence. Context excludes
prompts, content, responses, stdout, arguments, environment and conversation
fields recursively. Strings and nested context are bounded; truncation is
explicit. The source adapters select Caller metadata without reading prompt or
response fields, and preserve its exact process evidence when available.

## Native Logging view

Menu → Logging opens a server-paged table of retained events, with all three
severities and Any time selected initially. Filters cover the full permitted
store; the count is matching events, while each row's occurrence count describes
its retained incident. Source time is displayed in Settings' timezone; missing
source time is explicitly labeled as ingestion time. Today, Yesterday and This
week use civil boundaries in that timezone. Custom intervals require UTC offsets.

Expand a row with its evidence button (Enter or Space). Cause, stderr, stack,
resource units/measurement time and truncation are shown as recorded. Related
incident/correlation reads use the applied time, severity and access scope,
twenty events per page. Recorded Caller runs open Swarm; valid repository/PR
pairs open GitHub. Unrecorded targets have no link.

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
journal are also bounded. Records remain after a source or container disappears.
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

## Collection and operation

The application starts a dedicated `logging.db` beside `POISE_DB` (otherwise
`~/.poise/logging.db`). This is independent of alerts, dismissal and recovery.
An adjacent private journal retains collection gaps and loss across restart.
The bounded Caller completion stream is polled every 15 seconds without
opening prompts or response/reasoning artifacts. Process capture excludes argv,
stdout and environments; credential commands also exclude stderr. Sync phases,
input admission limits, model-discovery outcomes, lock acquisition failures and
temporary-filesystem pressure retain measurements known at the source.

The gateway retains its separate central `logging.db` in `poise-gateway-data`.
Existing volume backup/restore snapshots it with the other SQLite databases.
Gateway warnings/errors are redacted before Docker stdout and retained directly.
Every 15 seconds the independent collector reads bounded Docker logs/lifecycle
windows for managed workspaces, Poise Compose services and release-install
tasks. Only validated structured workspace envelopes enter private history;
unstructured output is excluded and its coverage limitation is explicit.
Docker OOM, nonzero exit and unhealthy events use native lifecycle meanings.
Workspace backfill reads three durable events per authenticated maintenance
page and commits its checkpoint only with central persistence. Replacement or
removal of the source does not delete central records. Query/collection outages
never become empty successful reads.

The gateway reads native host kernel and `docker.service` Warning-or-higher
journal records using `journalctl`, with a durable native cursor. Compose mounts
only the journal directories and machine ID read-only; workspaces receive no
journal, Docker socket or central-store mount. Missing journals, insufficient
permissions, unavailable Docker, incompatible old workspaces and excluded
unstructured logs remain explicit source coverage gaps. The first observation
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

Container discovery includes stopped containers and removes checkpoints only for absent container IDs; retained events survive that cleanup. Operator ingress deduplicates exact record replays, while separate records sharing a request ID retain distinct occurrence IDs. Bootstrap line capture keeps folded credential-header state across child output chunks before reporting or persistence.

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
