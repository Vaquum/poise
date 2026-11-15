# Poise MCP connection and work trail

The optional HTTPS endpoint `https://<POISE_DOMAIN>/mcp` connects an MCP
client to its owner's workspace. It is disabled by default. An operator can
set `POISE_MCP_ENABLED=1` in the gateway environment (`deploy/.env` with the
deployment bundle); unset it to remove the transport, discovery and grant pages.
No default or deployed configuration is changed by this capability.

`poise_describe`, with no arguments, returns the authorized workspace, effective
tools, grant expiry, running release and a machine-readable inventory. Each entry
names its data kind, source, permission, retention, current MCP availability and
Poise link. The catalog follows Poise's existing places, Observe parts, Settings
sections and capability names. The MCP resource `poise://workspace/inventory`
returns the same projection and runbooks. `poise_work` reads the workspace's
issue work trail. The owner can also grant Chat metadata during consent.

## Read work

Call `poise_work` with one of these selectors:

```json
{"repository":"autonomio/poise","issue":1059}
```

```json
{"repository":"autonomio/poise","label":"poise","limit":5}
```

Label pages also accept a UTC issue creation window. Pass `since` (inclusive)
and `until` (exclusive) as `YYYY-MM-DDTHH:MM:SSZ`. Keep the window the same
on continuation. Each row reports the known intake eligibility and selected
label. The mirror does not retain label application times, so that history
is reported separately as unavailable.

The repository must belong to a ready followed account in the owner's workspace.
Label pages include all matching issues, including closed issues and third-party
authors without configured-account involvement, Calls or chains. They use the
existing datastore `issue` repo/label/keyset selector, not Current's involvement
view or its workspace-wide intake scan. The default page has five issues, at
most ten. Each request reads one freshness result and at most `limit + 1` issue
rows (one for an exact issue), then exact chain projections and at most two
five-record ledger pages per selected issue: the issue and its known PR.
The issue read has a ten-second/512 KiB bound; freshness has five seconds/16 KiB.
The existing ledger worker admission and timeout bounds still apply. Workspace
results are bounded at 128 KiB; reduce the page size if a result exceeds it.

Pass `nextCursor` back as `cursor` with the same repository, label and limit.
The authenticated keyset continuation binds the resource, immutable owner,
workspace and grant; it survives access-token rotation within that grant.
A new grant starts a new listing. Label membership can change between pages;
this is a current keyset traversal, not a frozen snapshot or change feed.

The result carries `work.items`, observation time and per-source coverage:

- `coverage.issues` reports mirror freshness. Stale rows remain readable;
  failed issue reads return no rows with their reason, never confirmed absence.
- Each item's chain and GitHub observation coverage are independent. Stage,
  issue age in milliseconds, latest invocation admission time, step, blocker
  and next actor and action come from retained records. The next action is an
  observation of the current chain and can still require runtime admission.
  `not_recorded` means no chain or retained ledger
  work within fresh coverage, not proof about execution before collection or
  retention. Missing work with incomplete coverage remains `unknown`.
- The latest five invocation receipts retain original Call IDs, recorded action,
  outcome, head, review IDs and the existing native-action attribution. Omitted
  invocations are counted. Target ledger pages carry their original health,
  retention/gaps and explicit truncation. A missing original Call or receipt is
  a separate partial receipt gap; it does not make the mirror stale.
- `reviewStatus` preserves `pending`, `complete` and `not-recorded`. A verified
  merge SHA with pending review proof is `merged_review_pending`, and historical
  merges without a recorded review result are `merged_review_not_recorded`.
  Only an explicitly complete review result and recorded merge yield `complete`.

Links open the issue, chain journal, known Calls, PR, reviews, exact observed-head
checks, observed queue and recorded merge SHA under their existing browser access
rules. Returned source text is data, not instructions. Coverage and receipt
records grant no execution or publication authority.

## Read Chat metadata

On the Poise consent page, allow Chat metadata to enable `poise_get` and
`poise_list`. The grant page shows the allowed tools. `poise_describe`
reports the tools available with that grant.

Call `poise_get` with `kind: "chat"` and a Chat record ID from its Poise link.
The result includes the stored session state, role, repository, last sequence
and live timer IDs. Call it with `kind: "timer"` and one of those IDs for its
schedule and state, pending delivery and recorded failure and skip counts.
The gateway builds the link to the owning Chat. Times use UTC.

The exact lookup covers the connected workspace's stored Chats and active,
held or tripped timers. An empty record means there is no matching record in
that scope. This grant covers metadata. Transcript, attachment and timer
message content and Manager actions require separate capabilities.

`poise_list` accepts `kind: "chat"`, optional repository, UTC `since`
(inclusive) and `until` (exclusive) update times, and a limit from one to ten.
The page includes current and archived Chats. Pass `nextCursor` back with the
same selector and grant. The keyset orders by update time and ID. Updates can
move records between pages.

With the separate transcript grant, `poise_changes` accepts `kind: "chat"`,
a Chat ID, and `afterSequence` or a continuation cursor. It returns retained
prompts, assistant text and turn metadata. Oversize text and events with only
metadata report partial coverage. A reset reports expired coverage for an
older checkpoint and returns the retained boundary. `watermark` is the last
sequence consumed. Pass `nextCursor` to continue or check for new events.

For exact Chat metadata, `poise_get` includes current worker and creator
identities, work bindings, inbox delivery with the admitted turn ID,
supervision, Switchboard item states and pending owner requests. Each collection
returns up to ten records and reports truncation. Cross-repository relationships
are visible only with the applicable repository access. Plan
updates appear in the retained Chat event stream.

With separate artifact consent, call `poise_get` with `kind: "chat-attachment"`
or `kind: "chat-diff"`, the artifact `id`, and the owning `chatId`. Attachment
metadata includes original size and upload time. Text up to 16 KiB is served
only when its saved content hash still matches. A diff uses the retained event
and returns up to 6,144 characters on each side for a previewable checkout file.
Missing or limited content carries an explicit coverage result.

## Read workspace operations

With workspace-wide operational data consent, use `poise_get` with
`kind: "workspace"` and a snapshot name from the workspace inventory. The
available snapshots cover effective settings and model slots, followed accounts
and recorded sign-in, behavior policy and capacity, release and dependency
health, storage and GitHub quota, the analytics health cohort, notices and
handling history, Current cards, repositories visible to the configured
account, Switchboard check state and Manager Rhythm, and extension, memory
and snippet metadata.

The same consent allows `poise_list` with `kind: "call"` to page the retained
Caller archive newest first, or `poise_get` with the full Call ID. Use
`kind: "invocation"` for a retained chain invocation. The archive total
counts retained rows, including evidence the reader may need to quarantine. Receipts include the
known actor, action, outcome, head, settlement and available response link.
Quarantined Call evidence is reported as partial. Caller prompts, diagnostics
payloads, extension arguments and memory text stay in their owning surfaces.
Snapshot timestamps report when the read was assembled. Underlying observations
keep their own times, and bounded summaries report omitted records.

## Read Logging and linked devices

Use `poise_list` with `kind: "logging"` for bounded retained workspace events.
The optional `repository`, `since` and `until` select a repository and UTC
window. Counts refer to retained events. Each page includes retention bounds,
source coverage and a continuation. Open a specific event with
`poise_get`, `kind: "logging"` and the exact event ID.

Read new observations with `poise_changes`, the same selector and the
previous `watermark` as `afterWatermark`. Finish all continuation pages of a
batch before advancing to its new watermark. The cursor and watermark are
bound to the grant. An instance administrator can separately consent to
`kind: "instance-logging"`, with access rechecked before every read.

Use `poise_get` with `kind: "gateway"` for `logging-health`,
`instance-logging-health` or `link-devices`. Device status carries pairing and
connection metadata. It carries no device credentials.

## Read workspace content

With separate workspace content consent, use `poise_list` with
`kind: "document"` to page the Editor library and `poise_get` with the document
slug to read the current version, bounded text, publication versions and
cached review status. Documents are ordered by slug. Continue with the same
page size under the same grant.

Use `poise_get` with `kind: "snippet"` and a switch name, or with
`kind: "memory"` and `id: "current"` for the saved revision. Text is limited
to an 8,000-character preview and reports truncation. Cached review coverage
retains its original observation time.

## Delegate Manager controls

The owner can separately delegate Manager actions in Connected agents consent.
The active workspace Manager's limits and Chat policies apply. A client can
queue a message, steer a running turn, stop a Chat or schedule supervision of
one Chat. Supervision persists across turns and requires a workspace-wide grant.

Call `poise_action_preview` with `operation` and `sessionId`. Send and steer
also take `text`. Supervision takes `text` and `intervalMinutes`. The result
shows the target and sequence, current turn, acting Manager, delegated client,
effect and any required human decision. Use the opaque `preview` with
`poise_action_apply` after checking that the effect matches the requested task.

An unused preview lasts five minutes. Apply checks the current Manager, Chat
basis and grant again. Reusing the same preview returns the durable original
outcome or explicitly reports uncertainty. The command receipt identifies the
grant, client and target. Messages report queue admission, and stops report
whether execution settled. A send or steering action cannot approve a native
permission request or supply the person's answer.

## Private plugin

Render a private package for an installation's HTTPS apex into a new directory:

```bash
node scripts/package-poise-plugin.mjs https://poise.example.com /tmp/poise-private
```

The output contains `plugins/poise/plugin.json`, `mcp.json`, the `poise-manager`
skill and `.agents/plugins/marketplace.json`. It uses the supported portable
[OpenAI plugin format](https://developers.openai.com/plugins/build/plugins),
with a Streamable HTTP server at that installation's `/mcp`. OAuth discovery
supplies the resource, registration endpoint and `poise:read` scope. The
package contains no credentials. The renderer refuses an existing destination
and does not install a plugin, change settings or enable the endpoint.

Open the generated directory in Codex desktop, select its private marketplace
in the Plugins Directory and install Poise. Sign in and explicitly consent
through the installation's existing Poise flow. Production activation remains
gated on the recorded clean Codex desktop staging install and OAuth smoke in
[#979](https://github.com/autonomio/poise/issues/979). The separate callback-origin
work remains [#1051](https://github.com/autonomio/poise/issues/1051).

## Connect and revoke

Use a client supporting Streamable HTTP, OAuth discovery, dynamic public-client
registration and authorization code with S256 PKCE. Discovery starts from the
401 `WWW-Authenticate` challenge at `/mcp`:

- `GET /.well-known/oauth-protected-resource/mcp` names the exact resource
  `https://<POISE_DOMAIN>/mcp`, its authorization server and `poise:read` scope.
- `GET /.well-known/oauth-authorization-server` describes `/mcp/register`,
  `/mcp/authorize`, `/mcp/token` and `/mcp/revoke`.
- Registration accepts up to five exact HTTPS or loopback HTTP redirect URIs.
  It grants no workspace access. At most 256 unconsented registrations are
  retained; new registrations reclaim the oldest unconsented metadata.
  Registrations backed by live owner grants are retained separately, so
  anonymous registrations cannot fill the capacity required by a fresh client.
- Authorization requires the exact resource and scope, S256 PKCE, the existing
  Poise GitHub sign-in, and explicit owner consent protected by the browser
  session's CSRF token and exact apex Origin. It never accepts a requested
  workspace or owner from the client. Denial returns `access_denied`.
- The owner can enter an `owner/repository` restriction at consent. The grant
  page shows the repository. The scope survives refresh and applies at both
  gateway and workspace dispatch. A repository outside the scope is refused.
- A single-use code expires after 60 seconds. Access tokens expire after ten
  minutes; rotating refresh tokens end with their 30-day owner grant.
  Token exchange binds the client, redirect URI, PKCE verifier and resource.

Signed-in owners can open **Connected agents** on the apex home page
(`/mcp/grants`) to revoke a grant. Clients can also use `/mcp/revoke`.
Revocation invalidates access and refresh tokens immediately. Every read checks
the current immutable owner ID, workspace, resource and access permission;
disabling the owner or removing access also refuses the grant. A result still
in flight is withheld if the grant expires or is revoked before it returns.

The gateway forwards only a dedicated, short-lived signed `mcp` assertion to
`POST /api/mcp/read`. Browser, Link and admin assertions cannot call that
endpoint, and an MCP assertion cannot call their APIs, static pages or sockets.
New workspace containers receive `POISE_WORKSPACE_OWNER_ID` from the gateway.
Older containers without it retain normal behavior but refuse MCP assertions;
they need a normal container replacement before connecting.

The Deployment CI journey opens the installed gateway's MCP endpoint with a
real SDK client and follows records across two isolated workspaces. The
deployment uses fixture GitHub identities, a generated plugin package and
native datastore and journal records.

`tests/mcp.test.ts` exercises a real SDK client through disposable gateway and
workspace HTTP fixtures with the production assertion guard and read handler.
It uses the packaged endpoint, real datastore selectors, isolated chain journal
and ledger worker for two label pages, bounded source reads, a third-party seed,
delayed and completed chains, and a recorded merge with pending review proof.
Missing receipts, stale mirrors, cursor tampering/cross-owner replay and
unavailable coverage have separate assertions. Fixture records are not live
GitHub workflow or desktop installation evidence. Fresh connections after
registration floods and assertion rejection remain covered.
`gateway/tests/mcp.test.ts` covers OAuth, token
rotation, owner isolation and revocation. `tests/service-mode-server.test.ts`
checks the read endpoint through the production server. The Chromium regression
in `tests/e2e/service-mode.spec.ts` submits consent and reaches an isolated
registered callback with code and state, including when its origin is also a
font source in the CSP. These fixtures do not establish staging desktop activation.
