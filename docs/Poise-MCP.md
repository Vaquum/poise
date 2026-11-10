# Poise MCP connection and work trail

The optional HTTPS endpoint `https://<POISE_DOMAIN>/mcp` connects an MCP
client to its owner's workspace. It is disabled by default. An operator can
set `POISE_MCP_ENABLED=1` in the gateway environment (`deploy/.env` with the
deployment bundle); unset it to remove the transport, discovery and grant pages.
No default or deployed configuration is changed by this capability.

`poise_describe`, with no arguments, returns
`{ workspace, owner, capabilities: { tools: ["poise_describe", "poise_work"] } }`
for the authorized workspace. `poise_work` reads its issue work trail. Neither
tool grants Manager controls or reads chats, documents, credentials or raw
process state.

## Read work

Call `poise_work` with one of these selectors:

```json
{"repository":"autonomio/poise","issue":1059}
```

```json
{"repository":"autonomio/poise","label":"poise","limit":5}
```

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
  issue age in milliseconds, latest invocation admission time, step and blocker
  come from retained records. `not_recorded` means no chain or retained ledger
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

## Private plugin

Render a private package for an installation's HTTPS apex into a new directory:

```bash
node scripts/package-poise-plugin.mjs https://poise.example.com /tmp/poise-private
```

The output contains `plugins/poise/plugin.json`, `mcp.json`, the `poise-manager`
skill and `.agents/plugins/marketplace.json`. It uses the supported portable
[OpenAI plugin format](https://developers.openai.com/plugins/build/plugins),
with a Streamable HTTP server at that installation's `/mcp`, OAuth DCR and
`poise:read`; discovery supplies the existing endpoints. The package contains
no credentials. The renderer refuses an existing destination and does not
install a plugin, change settings or enable the endpoint.

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
