# Poise MCP connection

The optional HTTPS endpoint `https://<POISE_DOMAIN>/mcp` connects an MCP
client to its owner's workspace. It is disabled by default. An operator can
set `POISE_MCP_ENABLED=1` in the gateway environment (`deploy/.env` with the
deployment bundle); unset it to remove the transport, discovery and grant pages.
No default or deployed configuration is changed by this capability.

The only tool is `poise_describe`, with no arguments. It returns exactly
`{ workspace, owner, capabilities: { tools: ["poise_describe"] } }` for the
authorized workspace. It reads no work, content, chats or diagnostics and
grants no Manager controls. Work-trail queries and plugin packaging remain
outside this connection boundary.

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

`tests/mcp.test.ts` exercises an SDK client through isolated gateway and
workspace HTTP fixtures, including fresh connections after registration floods
and assertion rejection. `gateway/tests/mcp.test.ts` covers OAuth, token
rotation, owner isolation and revocation. `tests/service-mode-server.test.ts`
checks the read endpoint through the production server. The Chromium regression
in `tests/e2e/service-mode.spec.ts` submits consent and reaches an isolated
registered callback with code and state, including when its origin is also a
font source in the CSP. These fixtures do not establish staging desktop activation.
