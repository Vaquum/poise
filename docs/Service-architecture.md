# Service architecture

This repository runs Poise as a self-hosted service: several people sign in at
one public address, and each of them gets their own Poise with their own agent
CLIs, GitHub accounts and data. This document is the contract the gateway, the
workspace runtime, the desktop companion and Poise itself are built against.
Change it in the same pull request as any change to an interface it defines.

## Shape

```
browser ──https──▶ Caddy ──▶ gateway ──▶ workspace container (one per person)
                    (TLS)    (login,       Poise + Caller + agent CLIs,
                              routing,     home folder on a persistent volume
                              identity)
Poise Link (desktop) ──https──▶ Caddy ──▶ gateway ──▶ the same workspace, /api/link/*
```

- **Caddy** terminates TLS for the apex domain and every workspace subdomain.
  A server that already runs a proxy on ports 80 and 443 can have that proxy
  do it instead (`POISE_PROXY_LISTEN`): the deployment then runs no Caddy and
  publishes the gateway on that one address for the proxy.
- **The gateway** (`gateway/`) signs people in with GitHub, owns the user list,
  starts and upgrades workspace containers through the Docker Engine API, and
  proxies HTTP and WebSocket traffic to the signed-in person's own workspace.
- **A workspace** (`deploy/runtime/`) is one container per person built from the
  `poise-runtime` image. Inside it Poise runs in service mode as a single-user
  application, exactly as it does on a personal computer, with Caller and the
  provider CLIs beside it. Its home folder is a named volume, so every CLI keeps
  its login where it normally does.
- **Poise Link** (`link/`) is the desktop companion: it keeps Espanso's copy of
  the person's snippets in sync and shows Poise alerts as native notifications.

Isolation between people is the container boundary. Agents run with full
access and no sandbox inside a workspace, so nothing shares a workspace and no
workspace can reach another one.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/`, `server/`, `scripts/`, `tests/` | Poise (browser client, Node server, scripts, tests) |
| `caller/agent_interface`, `caller/github_interface`, `caller/github_datastore` | Caller, the Python CLIs Poise drives |
| `gateway/` | Login, routing and workspace orchestration service (Node 22, TypeScript) |
| `deploy/runtime/` | Workspace image (`Dockerfile`, entrypoint, CLI bootstrap) |
| `deploy/` | Compose file, Caddyfile, environment template, operator scripts |
| `link/` | Poise Link desktop companion (Tauri 2) |

## Addresses

- `POISE_DOMAIN` is the apex, for example `poise.example.com`. The gateway's own
  pages live there: sign-in, a home page that opens the workspace, and an admin
  page for when an admin's own workspace cannot open. They share Poise's look.
  Pairing, the paired devices and admin are otherwise in Poise's Settings.
- Each person's workspace lives at `https://<handle>.<POISE_DOMAIN>`. The handle
  is their GitHub login in lower case. GitHub logins are already valid DNS
  labels. The handles `www`, `api`, `admin`, `auth`, `link`, `static`,
  `gateway`, `app` and `mail` are reserved; a login that equals one of them is
  refused at sign-in. A handle stays with the GitHub account that first signed
  in with it, matched by account id, so a login that is renamed and later
  claimed by someone else cannot take over the workspace.
- DNS needs two records pointing at the server: `POISE_DOMAIN` and
  `*.POISE_DOMAIN`. Caddy obtains a certificate for each workspace host on first
  use (on-demand TLS); it asks the gateway first
  (`GET http://gateway:8080/_gateway/tls-ask?domain=<host>`), and the gateway
  answers 200 only for the apex and the handles of known users. It answers this
  only for requests addressed to `gateway:8080`, or to `POISE_PROXY_LISTEN`
  when the server's own proxy asks it there, never on a public host.

## Sign-in and sessions

**Optional public deployment content.** An operator can explicitly install a
bounded `public-pages.json` in `POISE_GATEWAY_DATA` through
`deploy/public-pages.sh` ([Public pages](Public-pages.md)). The gateway loads and
validates it at startup. Its absence preserves existing behavior; invalid or
unreadable content stops startup. On the configured apex only, anonymous `/`
shows the deployment description and policy links, while `/privacy` and `/terms`
serve the approved plain-text paragraphs with GET/HEAD and existing page security
headers. Domain/origin substitutions use the gateway configuration. Authenticated
home, workspace identity and every other route retain their checks. No workspace
can install this content, and no upgrade generates or replaces it. The existing
gateway data backup includes it. A proxy with an additional login must forward
only these exact apex public paths and methods without that additional login.

- Sign-in is a GitHub OAuth App web flow on the apex: `/auth/login` →
  GitHub → `/auth/callback`. The gateway requests `read:user`, plus `read:org`
  only when organisation-based access is configured. It reads the login and
  discards the GitHub token.
- Access: a login may sign in when it is on the allow list (seeded from
  `POISE_ALLOWED_USERS`, editable by admins) or is a member of an organisation
  in `POISE_ALLOWED_ORGS`. Admins come from `POISE_ADMINS` and may always sign
  in. Organisation membership is verified at each sign-in.
- An admin can disable anyone, however they got access. That takes effect at
  once: sign-in is refused, every session ends, every paired device is revoked
  and the workspace stops. Re-enabling lets the person sign in and pair again.
- The apex session cookie is `poise_gw` (host-only, `Secure`, `HttpOnly`,
  `SameSite=Lax`, 14 days).
- A workspace host gets its own host-only cookie, `poise_ws`, through a ticket:
  the apex mints a single-use ticket valid for 60 seconds and redirects to
  `https://<handle>.<POISE_DOMAIN>/_poise/session?ticket=…&next=<path>`, where the
  gateway checks it, sets `poise_ws` and redirects to `next` (a same-host path
  only). `poise_ws` has the same attributes as `poise_gw` and ends with the apex
  session it came from; signing out on either host ends both.
- A ticket redeems only in the browser it was minted for. The apex sets
  `poise_bind` (`Domain=<POISE_DOMAIN>`, `Secure`, `HttpOnly`, `SameSite=Lax`,
  14 days), each ticket stores a hash of its value, and `/_poise/session`
  refuses a ticket that arrives without the matching `poise_bind`.
- A workspace host only ever serves its owner. A session for another person on
  that host is rejected with 403; admins get no implicit access.
- Paths under `/_poise/` on workspace hosts belong to the gateway
  (`/_poise/session`, `/_poise/logout` and the gateway API below). Everything
  else is proxied. While a workspace starts, the gateway answers navigations
  itself with a "starting your workspace" page that reloads until the
  workspace is ready, and other requests with `503`. For an admin whose start
  failed, the page links to the apex admin page.
- When the sign-in in front of an open page ends, every request it makes is
  turned away. The gateway answers 401 once its own session has ended. A login
  proxy in front of the gateway, such as a portal, redirects to its own login
  page, which the page's requests cannot follow. Poise then checks once,
  without following redirects, whether `/api/workspace` is turned away too: a
  401 or a redirect. If it is, Poise dims the page under "Your sign-in has
  ended" with **Sign in again**, which reloads the page through the sign-in
  and back (`src/signed-out.ts`). A server that cannot be reached at all is not
  an ended sign-in.

**Sign in on a phone.** Settings → Accounts → Sign in on your phone signs a
phone in to the owner's account with a QR code, without GitHub
(`gateway/src/phone.ts`).
- A code is a one-time token of 128 bits, stored as its hash and valid for 2
  minutes. The QR holds `https://<POISE_DOMAIN>/auth/phone?t=<token>`. One
  sign-in, across its hosts, may mint 30 codes in 15 minutes.
- The first device to open the code is bound to it. The gateway sets a random
  secret on that device in `poise_phone` (host-only on the apex,
  `Path=/auth/phone`, `Secure`, `HttpOnly`, `SameSite=Lax`, 10 minutes). It
  records the device's kind and browser from its `User-Agent`, and redirects
  to `/auth/phone`.
  - Another device gets 409, and an unknown or expired code 410.
  - A client that opens 20 unknown codes in 10 minutes gets 429 for the rest
    of that window. The client is the first `X-Forwarded-For` entry, which the
    deployment's proxy sets.
  - A device already signed in goes through the code all the same, because a
    login proxy in front may have ended its sign-in there.
- `/auth/phone` reloads itself every 2 seconds while the owner decides, for up
  to 2 minutes. The page has no script.
- Settings shows the device with Approve and Deny. Approving sends the code's
  grant, the SHA-256 of the device's secret in lower-case hex, as `GET
  /_poise/api/phone` reports it.
- Within 2 minutes of approval, the device's next `/auth/phone` gives it a new
  apex session and binding of its own (`poise_gw`, `poise_bind`) and clears
  `poise_phone`. Its page then goes on through a ticket to the workspace. The
  owner's session is never copied, and a code signs in one device.
- A phone can drop the request whose answer carried its sign-in and retry it,
  for example when Safari resumes or reloads the page. So within that 2-minute
  window the same device gets the same sign-in again, while it lives. A login
  proxy in front should do the same for its own session, or the retried phone
  meets the proxy's login.
- Settings lists these phones while their sessions live: 14 days, like any apex
  session. Signing one out there ends its apex session and every workspace
  session made from it. It also cuts what the phone still holds open through
  the gateway: a WebSocket such as Chat's, authenticated only at its upgrade,
  and any answer still streaming.
- Codes, secrets and grants are never logged. The log names the login and the
  device only.
- **A login proxy in front**, such as Vaquum's Portal, must let `GET
  /auth/phone` on the apex through without its own login. It must also give the
  approved phone its own session.
  - The owner's approval and sign-out pass the proxy with the owner's session,
    and carry the grant in the query.
  - The phone's `/auth/phone` carries `poise_phone`, and the SHA-256 of that
    value is the grant.
  - So the proxy can record the approval and start the phone's session on the
    phone's next request, without knowing anything else of the gateway's.

**Gateway API on workspace hosts.** Poise's Settings calls the gateway at
`/_poise/api/*` on its own host; the gateway answers itself and nothing reaches
the workspace.
- Only the owner's `poise_ws` session reaches it: a device token gets 401,
  another person's session 403. A request whose `Sec-Fetch-Site` is not
  `same-origin` is refused with 403. A `POST` must carry the workspace's exact
  `Origin` and `Content-Type: application/json`, or it is refused with 403
  or 415.
- `GET /_poise/api/account` returns `{ login, handle, isAdmin, workspaceHost,
  apexOrigin, link: { installer, releases } }`.
- `GET /_poise/api/devices` returns `{ devices: [{ id, label, createdAt,
  lastUsedAt, revokedAt, state, connected }] }`, times in milliseconds and
  `state` one of `active`, `revoked` or `expired`. `connected` is true while an
  active device holds `/api/link/events` open through the gateway and the
  workspace has answered it with 200; the gateway keeps this in memory. When
  that stream closes, `lastUsedAt` becomes that moment.
- `POST /_poise/api/devices/pair` with `{ userCode, decision }`, `decision`
  being `approve` or `deny`, returns `{ decision, message }`. An unknown or
  expired code answers 400 `invalid_code`. More than 10 codes per sign-in in
  15 minutes answers 429 `too_many_requests` with `Retry-After`.
- `POST /_poise/api/devices/revoke` with `{ id }` returns `{ devices }`, or 404
  for a device that is not the owner's.
- `GET /_poise/api/phone` returns `{ codes, phones }`.
  - `codes` are the owner's codes of the last 15 minutes, each `{ id, state,
    device, grant, createdAt, expiresAt, scannedAt, decidedAt, finishedAt }`.
    `state` is one of `waiting`, `scanned`, `approved`, `denied`, `signed_in`
    or `expired`. `grant` is set once a device opened the code.
  - `phones` are the phones signed in with a code, each `{ id, device, grant,
    createdAt }`.
- `POST /_poise/api/phone/start` returns `{ code, url }`. Past its rate limit
  it answers 429 `too_many_requests` with `Retry-After`.
- `POST /_poise/api/phone/approve?grant=<grant>` and `POST
  /_poise/api/phone/deny`, each with `{ id }`, return `{ code }`. A missing
  grant or another device's answers 400, and a code that is no longer waiting
  answers 409.
- `POST /_poise/api/phone/revoke?grant=<grant>` with `{ id }` returns `{ phones
  }`. A grant that is not that phone's answers 400.
- For admins only (403 otherwise): `GET /_poise/api/admin` returns `{ users,
  allowed, admins, allowedOrgs, dockerError, disk }`. Each user is `{ handle,
  login, admin, access, lastLoginAt, disabled, workspace, lastError, disk }`,
  where `workspace` is `{ state, image }` or `null` while the Docker Engine
  cannot be asked.
  - The user's `disk` is `{ bytes, overBudget }`, the size of their home volume
    at the last measurement, or `null` while it has not been measured.
  - The top-level `disk` is `{ measuredAt, free, total, low, budget }`, or
    `null` before the first measurement. `free` and `total` are in bytes, or
    `null` when the filesystem could not be read; `low` then keeps the last
    known answer. `budget` is POISE_WORKSPACE_DISK_BUDGET in bytes, 0 for none.
  - `POST /_poise/api/admin/allow` and `/_poise/api/admin/allow/remove` take
    `{ login }`.
  - `POST /_poise/api/admin/workspaces/start`, `…/stop`, `…/restart`,
    `/_poise/api/admin/users/disable` and `…/enable` take `{ handle }`.
  - Each answers with the updated overview. Settings keeps each user's
    workspace and access controls available after applying that overview.
- Failures answer `{ error, message }` with their HTTP status.
- `GET /_poise/api/logging`, `/logging/events/ID`, `/logging/health` and
  `/logging/export` read retained central diagnostics through a bounded worker.
  They require the owner's browser session and exact Origin when one is sent.
  Explicit `scope=instance` requires current admin access; another workspace's
  private application/Caller records remain excluded. No assertion scope or
  workspace fan-out is added. [Logging](Logging.md) defines filters, budgets,
  scoped cursors and 404/410/503 evidence states. Local `/api/logging` uses the
  local store and existing loopback checks; service workspaces return 404 there.
- For local and CI end-to-end runs only, `POISE_INSECURE_HTTP=1` serves plain
  http: the cookies drop `Secure`, and every address the gateway builds,
  including `POISE_PUBLIC_ORIGIN` and `X-Forwarded-Proto`, uses `http`. The
  gateway refuses it unless `POISE_DOMAIN` is `*.localhost` or `*.test`; a
  single-label domain such as `localhost` is refused in any mode, because
  `poise_bind` cannot span it.

## Gateway → workspace identity

Every request the gateway forwards carries a fresh identity assertion in the
`X-Poise-Identity` header. The gateway removes any `X-Poise-Identity` header a
client sent.

- Format: a compact JWT signed with Ed25519. Header
  `{"alg":"EdDSA","typ":"JWT"}`.
- Claims:

  | Claim | Value |
  | --- | --- |
  | `iss` | `poise-gateway` |
  | `aud` | `workspace:<handle>` |
  | `sub` | the GitHub login, in GitHub's case |
  | `scope` | `browser`, `link`, `admin` or `mcp` |
  | `iat`, `exp` | seconds; `exp` is `iat + 60` |
  | `jti` | random, unique per assertion |
  | `sid` | browser only: opaque hash reference to the authenticated workspace session |
  | `gport` | browser only: gateway listening port for private Google delegation |
  | `mcp` | MCP only: `{ resource, ownerId, handle, grantId }`, bound to the exact apex `/mcp` resource and immutable workspace owner ID |

- The gateway generates its key pair on first start and keeps it in its data
  volume. Workspaces receive the public key as `POISE_GATEWAY_PUBLIC_KEY`, the
  SPKI PEM encoded as single-line base64.
- A workspace accepts an assertion when the signature verifies, `iss` and `aud`
  match, `sub` equals `POISE_WORKSPACE_OWNER` (case-insensitive), `iat` is at
  most 5 seconds in the future, `exp` has not passed (5 seconds of skew), and
  `exp - iat` is at most 120.
- Scopes:
  - `browser`: the owner's browser; ordinary workspace routes.
  - `link`: a paired Poise Link device; only `/api/link/*`.
  - `admin`: the gateway itself; only `/api/service/*`.
  - `mcp`: a consented workspace read grant; only `POST /api/mcp/read`.
    That endpoint refuses browser, Link, admin and unsigned loopback requests.
    It returns workspace identity and capabilities through `poise_describe`,
    and bounded issue work trails through `poise_work`. Work reads select one
    exact issue or repository/label keyset page, then only those targets' chain
    projections and retained ledger pages. Continuations bind the owner grant,
    resource, repository, label and limit. The gateway rechecks result scope;
    source freshness and missing receipts remain independent evidence.
    The gateway's disabled-by-default HTTPS transport, OAuth discovery, S256
    PKCE consent and revocation are defined in [Poise MCP](Poise-MCP.md).
- The gateway also sets `X-Forwarded-For`, `X-Forwarded-Proto: https` and
  `X-Forwarded-Host`, and keeps the browser's `Host` and `Origin` headers. It
  forwards no `Cookie` header at all: neither its own cookies (`poise_gw`,
  `poise_ws`, `poise_bind`, `poise_oauth`, `poise_phone`) nor any other the browser sends,
  such as a login cookie that a parent domain shares with every host below
  it. Nor does it forward a device token's `Authorization` header.
- Workspaces cannot set cookies: the gateway drops every `Set-Cookie` from
  their responses. An answer with a status outside 100–599 becomes a 502.
- The gateway retires pooled HTTP sockets after four idle seconds, before
  the workspace's five-second keep-alive closes them. This is an idle pool
  limit; active responses, long polls and event streams remain open. Failed
  requests are not replayed, including mutations with an unknown outcome.
- A workspace that fails after its answer started — a response cut mid-body,
  or an established WebSocket reset — leaves the client with a partial answer
  the status cannot show: the gateway closes the stream and records
  `proxy.truncated` with the phase and the bytes relayed instead of answering
  twice. A client that goes first is never recorded as an upstream failure.
- A request on a bodiless method (`GET`, `HEAD`, `OPTIONS`, `DELETE`, `TRACE`)
  that carries a body is refused with 400, and every forwarded body is framed,
  so nothing can ride along as a second request.
- The gateway's own calls to `/api/service/*` carry an `admin` assertion and
  `Host: <handle>.<POISE_DOMAIN>`.
- Sizes the gateway relays are bounded, so one person cannot exhaust the shared
  gateway's memory. Request bodies may be at most 32 MiB, which covers Poise's
  largest body, the 30 MiB editor envelope. A larger declared body gets `413`
  before it reaches the workspace, and a chunked body is cut off with `413` as
  soon as it crosses the limit. A workspace's answer to a declined WebSocket
  upgrade is relayed only up to 64 KiB, and anything longer gets `502`. The
  gateway reads at most 64 KiB of a workspace's health or drain answer, and
  treats a longer one as a refused health check.

## Workspace runtime contract

The gateway creates, per person:

| Resource | Name |
| --- | --- |
| Volume (mounted at `/home/poise`) | `poise-home-<handle>` |
| Network (shared only with the gateway) | `poise-net-<handle>` |
| Container | `poise-ws-<handle>` |

Container settings: image `POISE_RUNTIME_IMAGE`; user `poise` (uid 10001);
labels `poise.managed=true` and `poise.workspace=<handle>`; no published ports;
`init` enabled; `no-new-privileges`; all capabilities dropped; a log of at most
five 20 MB files (`json-file`); memory, CPU and
process limits from `POISE_WORKSPACE_MEMORY` (default `8g`),
`POISE_WORKSPACE_CPUS` (default `4`) and `POISE_WORKSPACE_PIDS` (default `4096`);
restart policy `unless-stopped`, so a server reboot brings workspaces back
while one an admin stopped stays stopped; optional OCI runtime from
`POISE_WORKSPACE_RUNTIME` (for example `runsc`). With `POISE_WORKSPACE_DNS`,
a file naming those resolvers is mounted read-only over `/etc/resolv.conf`,
and the label `poise.dns` records them; gVisor cannot reach Docker's embedded
DNS server. A workspace whose resolvers differ is recreated, drained, like
one on an outdated image.

Environment the gateway passes:

| Variable | Value |
| --- | --- |
| `POISE_MODE` | `service` |
| `POISE_WORKSPACE_HANDLE` | `<handle>` |
| `POISE_WORKSPACE_OWNER` | the GitHub login |
| `POISE_WORKSPACE_OWNER_ID` | immutable GitHub account ID; optional for older containers, which refuse MCP assertions without it |
| `POISE_PUBLIC_ORIGIN` | `https://<handle>.<POISE_DOMAIN>` |
| `POISE_GATEWAY_PUBLIC_KEY` | see above |
| `POISE_HOST` | `0.0.0.0` |
| `POISE_PORT` | `5555` |
| `HOME` | `/home/poise` |
| `POISE_DRAIN_TIMEOUT` | the gateway's own `POISE_DRAIN_TIMEOUT`, in seconds (default 5400), so both sides time a drain alike |
| `POISE_BEHAVIOR_MEMORY_BUDGET_BYTES`, `POISE_BEHAVIOR_MEMORY_RESERVATION_BYTES`, `POISE_BEHAVIOR_DISK_BUDGET_BYTES`, `POISE_BEHAVIOR_DISK_RESERVATION_BYTES` | optional validated whole-byte native behavior settings from the gateway; unset remains unbounded ([configuration](../gateway/README.md)) |
| `POISE_REPAIR_EXHAUSTION_REPOSITORIES` | optional explicit comma-separated `owner/repo` allowlist for new containers from the gateway; trusted service configuration overrides it, including explicit empty to disable reporting |
| `POISE_SKIP_CLI_BOOTSTRAP` | `1`, only when the gateway's `POISE_WORKSPACE_SKIP_CLI_BOOTSTRAP` is `1` (end-to-end tests); otherwise unset |

Beside each release, the gateway installs agents' test offload into the home
volume by running `/opt/poise/scripts/test-offload/install.sh` in a short-lived
container of the image. With `POISE_TEST_RENDER_API_KEY` and
`POISE_TEST_WORKSPACE` set, it passes `POISE_TEST_RELAY_URL`, which is
`/api/link/test-relay` on the workspace's host or on `POISE_PROXY_LISTEN`, and
`POISE_TEST_RELAY_KEY`, the workspace's handle signed by the gateway, and the
validated `POISE_TEST_LIMIT_SECONDS`. That writes the hooks and `relay`, holding
URL, key and limit on successive lines, to `~/.poise/test-offload`; without them it removes `relay`. Poise starts its
children with the hooks while `relay` exists
([Agents' test suites](Operating.md#agents-test-suites)). The settings travel this
way because only a new container would take an environment variable.
The limit defaults to 540 seconds and accepts whole seconds from 1 to 3540.
The runner reads it from this installed configuration for one command lifetime,
including capture and retries. Workspace children get a shell default of that
budget plus 60 seconds for reporting and cleanup, within the existing 3600000 ms
shell maximum. Explicit shorter shell deadlines still cap the command. Older
two-line relay files retain the 540-second default.

The relay retains the last 1,024 retired run IDs, their workspace owners and, for
jobs, SHA-256 runner-token digests in memory, outside active admission slots.
After the signed-key and current-access
checks, the owner's exact `DELETE /runs/:id` returns 204 even while box termination
is pending. An exact `POST /runs/:id/output` with a constant-time digest match
returns 410 without processing output or logging a redundant request warning.
Unknown, evicted and foreign IDs, invalid tokens and other requests retain their
failure warnings. Run-stop, missing-result and box-termination diagnostics remain independent.

The relay's run admission advertises `dependencyCache: true`. The authenticated
workspace can send `POST /runs/:id/dependency?sha256=…` between checkout parts
to insert one cached gzip member in order. An empty request looks up the
workspace's chunk and returns 404 on a miss. A request with a body submits the
member, which the relay verifies against the SHA-256 of its uncompressed tar
bytes before forwarding and retaining it. Earlier runners and relays still
exchange the whole checkout through the existing tree upload. Jobs and
sandboxes receive the same single tar stream from either route.

New atomic Calls also pass a Caller-owned random capture binding through the
test-offload hooks, outside the suite environment. The box independently hashes
the captured archive and source files before running a direct Vitest command.
Relay recovery is currently held for #1619: the suite UID owns the report files,
so no assertion inventory is trusted and no evidence frame is emitted. The held
design would post a complete bounded inventory from the private run credential to
`POST /runs/:id/assertions`; workspace credentials cannot submit that result.
Only a matching completed failure would emit an Ed25519-signed evidence frame
before the relay deletes the run. The hook would retain the redacted receipt for
Caller; `POST /evidence/verify` would authenticate it against the existing gateway
key and workspace credential after run deletion or restart. There is no unsigned
or partial-result fallback. Caller would retain the verified receipt in its
original artifact before resource cleanup. This extends the existing relay
interface, without a new identity scope, setting or runner-retention store.

A workspace container created with another `POISE_DRAIN_TIMEOUT` than the
gateway's, or with none, is recreated as one on an outdated image is: drained
first if it runs ([Deployment](#deployment)).
Changed or removed native behavior budget/reservation settings use that same
replacement path and its existing native resource-settlement barrier. Existing
invocations retain their original immutable ceilings; no setting changes an
already-admitted booking.
Adding, changing or removing the repair-report allowlist instead uses
`POST /api/service/config` on compatible running workspaces. Each upgrade pass
reconciles it even when image and release already match, without a drain,
restart or container replacement. An explicitly applied empty value is durable
and overrides a legacy nonempty container environment after Poise restarts.
Older releases without this configuration support retain the existing release
upgrade path; the gateway applies the setting once a compatible release runs.

The gateway reaches the workspace at `http://poise-ws-<handle>:5555`, over the
workspace's network, which it joins by its own container name,
`POISE_GATEWAY_CONTAINER`. A recreated gateway container is on none of the
networks the one it replaced had joined, so the gateway joins them itself:
- When it starts, before it answers a request or runs an upgrade pass, it
  joins the network of every managed workspace container, running or stopped.
- Before a call to a workspace (a proxied request, a health check, a drain) it
  joins that workspace's network if it is not on it. It asks Docker the first
  time, and again after any call that reached nothing.
- A network it cannot join fails the call with the reason. The starting page
  shows it, and an upgrade stops there (`workspace.upgrade.failed`) and tries
  again on the next pass, instead of waiting out the drain and recreating the
  workspace undrained.

## Updates in place

A workspace takes a new image without a new container when the image's
system base is the one its container runs, so the agents in it are never cut
off. The container's inherited `poise.base` and `poise.release` labels retain
that proof even when a cached rebuild changes an attestation/index digest and
the original image can no longer be inspected. A healthy workspace already on
the requested release keeps its container; missing base/release labels and
changed container settings retain the drained replacement path.
Agent calls (behavior runs, manual reviews, replays) are processes Poise
starts detached; they keep running while Poise restarts, and the next Poise
reconciles them as after any restart. Chat turns survive the same way: each
session's agent runs under a per-session relay that owns its stdio and
spools the turn's output, so the next server reconnects and replays the turn
instead of interrupting it. Completed permission and question requests consume
their persisted one-time answers without sending them again; completed filesystem
requests never repeat their effects. The LIVE handoff waits until buffered spooled stdout reaches the adapter,
including across an awaited outbound read. Relay termination follows gate stdio
EOF, pending replay and final socket writes, so the last response precedes exit.
A LIVE boundary decoded before exit retains its successful handoff even when
both frames arrive in one socket callback. File-tool permission admission waits
for replayed pre-image reads before allowing native writes.
Historical request matching ends with
the adopted turn. Each recorded RPC response is consumed once per occurrence,
so the native agent can reuse its request ID after completing an earlier one.
Historical callbacks cannot clear a later request's active slot. Claude control
answers likewise retain each completed occurrence when a request ID is reused.
Recovery atomically claims the checkout lease before stopping
a recorded worker, including an idle worker whose completed turn released its
lease; a competing live owner retains its turn and session. Cancelling an
adopted Grok turn waits for its correlated native result or verified worker
termination before releasing the checkout. A completed adopted turn drops its
spool and outbound history without clearing another server's handed-over turn.
Relay exit alone does not prove its separate worker group exited. Failed startup
rollback or shutdown retains the worker records and checkout lease until that
group is verified gone. While this server owns that relay, its exit observer
retires matching worker records when the group subsequently exits; ownership
transfer or server stop ends that observation.
Recovery rechecks cancellation after relay attachment and outbound reads. A replay
already aborted by lease loss requires verified native-worker termination before
releasing its checkout.
A recorded failed Muse decision ends the turn with a visible error
instead of retaining an unanswerable request and checkout lease.
Relay and gate identity never names the install directory: verification
matches the `scripts/chat-relay.mjs` or `scripts/chat-worker-gate.mjs`
script carrying its recorded random ident, so a new release adopts relays
and workers still running from the previous release. A handoff that never
reaches LIVE within a minute fails instead of hanging: the turn is
interrupted and its processes are terminated through the same verified
path as Stop. An adopted turn's pre-restart relay and agent retire when
the turn settles, so no old-release relay outlives its adoption and the
next prompt starts a fresh relay that resumes the same native session. A
Stop asked before the restart is finished, never adopted: shutdown
terminates a stopped turn instead of handing it over, and recovery
terminates it instead of replaying it. Waiting follow-ups stranded by an
interruption continue on their own once recovery clears the way; the
interrupted in-flight turn itself is never retried, and a person's Stop
still holds its chat until the person sends again. An agent that is
demonstrably alive but unverifiable keeps its turn open and counted,
with its rows kept for the next restart to retry, instead of being
interrupted while it runs unseen. A session whose scratch checkout sits
on an agent-cut branch with uncommitted work checkpoints that work as
its own instead of refusing with dirty_unowned.

- **Releases.** The image carries one release, Poise (`/opt/poise`) and
  Caller's relocatable virtualenv (`/opt/caller/venv`), and labels it
  `poise.release` (the commit `deploy/lib.sh` built it from) and `poise.base`
  (a digest of the files that build the system around it:
  `deploy/runtime/Dockerfile`, `entrypoint.sh`, `install-clis.sh`,
  `supervisor.mjs` and `install-release.sh`).
- **The supervisor.** `entrypoint.sh` becomes `supervisor.mjs`, which runs
  Poise from `~/.poise/releases/current` when that release is installed for
  its base, and from the image's own release otherwise. When Poise exits with
  75, it starts the release named in `~/.poise/releases/next` and makes it
  current. A release that exits on its own within a minute of starting is
  marked failed and never run again; the image's own release takes over.
  Production shutdown synchronously retains deadline and rejection evidence in
  the private Logging store before exit 1, even after Logging stops. The
  supervisor supplies a fresh `POISE_SHUTDOWN_DIAGNOSTIC_ID` for every launch.
  A read-only lookup of that launch's owner-scoped shutdown Error permits a
  distinct `workspace.exit` Warning linked by `correlationId`, retaining the
  actual exit code and signal. Missing, unavailable or mismatched evidence keeps
  the independent exit Error. Clean exit 75 stays quiet.
  On Linux the same supervisor owns the private native-cleanup controller.
  Its uid-only Unix socket and random generation are passed to Poise and
  Caller as `POISE_NATIVE_CONTROL`; neither the address nor per-Call tokens
  are public API fields. Its original kernel witnesses survive Poise release
  replacement, but never a supervisor/container replacement. Controller loss
  leaves resource settlement unknown; replacement cannot manufacture proof.
- **Installing.** For a running workspace whose image has the new image's
  base, the gateway runs `install-release.sh` in a short-lived container of
  the new image, as uid 10001 with the workspace's home volume and no
  network. It copies the release into `~/.poise/releases/<release>/` and
  keeps an older one for at least three hours after it was last current, so
  an agent still running from it keeps its files. The supervisor dates a
  release it switches away from to that moment.
- **Switching.** The gateway then sends `POST /api/service/switch` with
  `{ release }` (`admin` scope or loopback; 202 `{ release, switching }`,
  409 for a release not installed for this base or a server started without
  the supervisor). While someone is using Poise in a browser (input on a
  visible page, reported by `POST /api/service/activity` at most every 30
  seconds), the switch is held, not queued: nothing is written, new Chat
  turns keep starting, and health names the release with `switchWaitingOn:
  "someone using Poise"`. It is queued after 90 quiet seconds, or five
  minutes after it was first asked for, well inside the deploy's ten-minute
  proof, so the restart and the minutes its caches take to warm land in a
  quiet moment. Poise then writes `next` and restarts at the first moment no unheld Chat turn and no work of its own
  runs; it waits for no agent call and no turn a healthy relay holds, since
  the relay keeps the turn running and the next server adopts it. While the
  switch is pending, new Chat turns
  wait behind the update instead of starting — sent messages, queued
  messages and work-monitor wakes alike, nothing refused or dropped —
  while browser launches remain available. New behavior sweeps wait, and active
  Chat work-monitor passes yield between targets, workspace scans and discovery
  pages. An admitted unit finishes and persists its observations or receipts
  before releasing the background barrier; detached agent calls keep running.
  Withdrawal or a refused restart lets deferred work resume on the existing ticks.
  A Poise implementation whose
  controller binding completes during this pause also waits durably, retaining
  its runbook, displayed request, switches and completion responsibility. It
  remains ahead of discussion in that change chat, including messages sent to
  the visible child before binding returns. Without a pending update, that
  child refuses discussion until binding reserves its initial implementation;
  ordinary starting chats retain their existing admission policy. A restart does not report an
  implementation that never started as failed. Turns without a healthy relay get the
  update turn bound (a chat setting, default 15 minutes counted from when
  the switch became pending); past it they are cancelled through the normal
  cancel path, their sessions recorded, and the server restarted. After the
  restart each interrupted session gets exactly one automatic continue
  prompt on its resumed native session; a request still waiting for a
  checkout or startup is replayed with its original input and attribution.
  Compaction does not count as delivering that request. If recovery must
  wait, its durable recovery record retains its displayed request, switches and change
  completion responsibility with the original source, including timer
  provenance, and model. A busy session's continuation remains ahead of its
  existing normal-queue follow-ups, ready when that busy turn finishes.
  If a drain or another switch is pending during recovery, both interrupted and
  waiting records stay durable until it clears; continuations keep priority
  over their follow-ups. A new interruption supersedes older automatic
  continuations even if transient admission deferred them into the waiting
  store; literal waiting messages retain their order. Drain and withdrawal release paths also retain records
  held by another live server. Waiting turns follow these recoveries in order.
  In an isolated Poise change, recovered and waited follow-ups also wait for
  the controller to release the checkout after checks, build and deployment.
  A waited message retains its position between earlier and later normal queue
  items when the preceding turn finishes naturally during the switch. New
  waited messages record that queue boundary; older records use their stored
  creation times. The person's Stop also holds these waited messages until the
  person resumes the chat. A Stop that overlaps the update bound's native
  cancellation also keeps its interrupted record durable; after the person's
  resumed turn, that recovery still precedes normal queued follow-ups.
  A later update preserves every earlier unsent request by interrupted turn
  identity. It resumes the current turn first with one generic continuation,
  then those older requests, consuming each durable row separately; that current
  continuation supersedes an older generic continuation of the same session.
  Withdrawal waits for any bound cancellation to record recovery before
  releasing messages. A bound
  cancellation never bypasses the quiet gate for server work, background
  work or admitted launches. The gateway asks again on later passes until health reports the
  release, which the request makes idempotent.
- **Shutdown.** Active HTTP responses finish before their keep-alive sockets
  retire. Storage-pressure passes, including native Caller cleanup and receipt
  reconciliation, join the background barrier: a release switch waits for the
  admitted pass before starting shutdown. Collaborator reconciliation also joins
  that barrier, retaining the admitted invitation's account confirmation before
  the switch; new passes wait during a pending switch or drain.
  Clean shutdown waits for runtime cleanup
  and HTTP closure, closes SQLite, then exits 75. The existing ten-second deadline
  still exits 1 with one structured Error naming pending shutdown phases and
  unresolved runtime stops (including `runtime_stop.agent_collaborator`) and
  retaining known cleanup failure causes.
- **Unreachable.** A workspace that does not answer a probe keeps its
  container; the gateway probes again on later passes, and only a workspace
  unreachable past the switch grace gets a new container, drained first.
  During that fallback drain, each successful drain or health reply can prove
  the target release is already running. If the base and required container
  settings still match, the gateway explicitly resumes the workspace and ends
  replacement, even while Caller work continues.
- **Waiting.** A switch fires at a quiet moment, so a busy workspace keeps its
  container while the gateway asks again; each pass logs `workspace.update.waiting`
  with what it waits on. An idle workspace still on the old release past the switch
  grace is stuck, not waiting: the gateway warns once (`workspace.update.stuck`) and
  keeps asking, since recreating could cut work it cannot see.
- **Meanwhile.** While the workspace restarts, the gateway answers for it
  with `x-poise-updating: 1`: "Updating to the latest version" for a page, 503
  `workspace_updating` for anything else. Poise dims the open page with the
  same notice and reloads it once Poise answers again (`src/updating.ts`).
  A GET/HEAD connection reset before response headers uses this same response
  only for a known switch whose fresh health probe cannot reach the workspace
  or finds it healthy on the requested release. A healthy old release keeps
  the ordinary 502. The reset invalidates cached readiness, so recovery freshly
  verifies `/api/service/health` on the requested release. `proxy.failed` is one
  Warning only after the retryable update response is produced; unverified
  resets, interrupted mutations and unanswered failures retain an Error.
  Request, requested release and actual response disposition are retained in
  diagnostics (`disconnect` records the status/disposition or an unanswered
  response). Failed rollout evidence remains in the existing rollout diagnostics;
  no request is replayed.
- **Everything else.** An image of another base, a workspace started without
  the supervisor, or a changed container setting still gets a new container,
  drained first ([Deployment](#deployment)). The gateway makes the new image's
  release current before it creates the container. `runningCallerCalls`
  counts agent calls by Caller's own records and live processes, so a drain
  also waits for the calls an earlier release started.

## Poise in service mode

`POISE_MODE=service` changes only what has to change for a container behind
the gateway. Without it Poise behaves exactly as it does on a personal
computer.

**Requests**
- Binding to a non-loopback address is allowed only in service mode.
- Loopback requests keep today's rules; they come from inside the owner's own
  container.
- Native chats discover Poise through a private connection file and
  `POST /api/chat/control`. This endpoint additionally requires a per-chat
  credential that survives restarts, a loopback peer and no browser
  Origin/fetch headers; even a valid gateway browser/admin assertion cannot
  call it.
  The native command can also use the normal loopback Poise APIs under their
  existing policy. Creating-chat and worker relationships, the workspace Manager's role, inbox admission, supervision,
  explicit issue/PR ownership, pending owner escalations, durable timers and their holds persist in the
  workspace's SQLite store.
  Dispatch pauses while draining; running monitor reads join the existing
  background-work barrier. New observation passes, including queued follow-ups,
  wait during drain or a pending release switch. Shutdown fences late read
  results before releasing their barrier; it does not wait on remote reads.
  A release switch waiting for quiet holds timer fire
  and admission back so timer turns never keep it waiting. See [Chat orchestration](Chat-orchestration.md).
- The Switchboard pane's actions (`POST /api/chat/switchboard/…`) act for the
  owner, so they also require an `Origin`, checked as below. A loopback
  request without one, such as a native chat's `api` operation, is refused
  with 403; in service mode only a request admitted with the gateway's
  assertion qualifies. Reading `GET /api/chat/switchboard` keeps the ordinary
  rules. See [Switchboard](Switchboard.md).
- Non-loopback requests need a valid assertion with the right scope: API
  routes, static assets and the page itself alike. The assertion header is
  removed before any check, so Poise never echoes, logs or forwards it.
  Identity comes from the assertion alone: no cookie or `Authorization`
  header stands in for it.
- The Host and Origin checks compare against `POISE_PUBLIC_ORIGIN`, scheme
  included: every non-loopback request, the gateway's own `admin` calls
  included, carries the workspace's public host in `Host`, and an `Origin`
  must equal `POISE_PUBLIC_ORIGIN` exactly. Requests without an Origin are
  accepted only from loopback or with a valid assertion.
- `POISE_PUBLIC_ORIGIN` is an https origin. It may be plain http only when its
  host is `localhost` or ends in `.localhost` or `.test` (such as
  `<handle>.poise.localhost` under the gateway's `POISE_INSECURE_HTTP`); any
  other http origin stops startup.
- A missing or invalid assertion is refused with 401; a valid one whose scope
  does not reach the route, a wrong Host or Origin, and a cross-site API call
  with 403.
- The Chat WebSocket and the terminal WebSocket apply the same rules. An
  upgrade to any other path is answered (401, 403 or 404) and closed.
- `GET /api/workspace` returns `{ mode: "service", owner }`, or `{ mode:
  "local" }` outside service mode. Settings adds Poise Link, and Admin for the
  gateway's admins, only in service mode.
- Startup validates `POISE_WORKSPACE_HANDLE`, `POISE_WORKSPACE_OWNER`,
  `POISE_PUBLIC_ORIGIN`, `POISE_GATEWAY_PUBLIC_KEY` and, when set,
  `POISE_DRAIN_TIMEOUT`, and stops with one message naming each that is
  missing or invalid; any `POISE_MODE` other than `service` is an error.

**Storage.** State and temporary work live in the home volume:
- Chat workspaces in `~/.poise/chat` (`POISE_CHAT_ROOT`).
- Snippets in `~/.poise/snippets/poise.yml`.
- Caller's data in `~/.poise/agent-interface` (`AGENT_INTERFACE_DATA_DIR`).
- Issue-review temporary files in each owned run's `tmp` directory under
  `~/.cache/agent-interface/issue-review` (`AGENT_INTERFACE_WORK_DIR` can move
  this root), removed with the run ([Issue review](Issue-review.md)).
- Caller itself runs from the image: its CLIs from `CALLER_BIN_ROOT`,
  `agent-interface` in `AGENT_INTERFACE_ROOT`.

Legacy review parents are retained under the
[storage retention policy](Operating.md#storage-maintenance); only original
native resource receipts can authorize maintenance reclamation of owned Calls.

Poise delegates GitHub-mirror cache eviction to Caller's local, account-free
`github-interface --prune-mirrors` behavior. Caller retains each
`owner/repo.lock` inode and owner directory, locks nonblockingly against
refresh/snapshot, and removes only stale whole bare mirrors at
`owner/repo.git`. Recent descendant writes and uncertain or symlinked
identities are held; directory descriptors anchor removal. The JSON
`removed`/`held` report and options are defined in
[Caller's repository checkout contract](../caller/README.md#repository-checkouts).

**Scheduling.** The daily model-catalogue refresh runs inside Poise at 07:00
in the owner's configured timezone (UTC, logged, when none is set), replacing
the launchd job; a drain skips it. Datastore sync already runs inside Poise.

**Turned off in service mode** (each with a clear message where the UI would
otherwise offer it):
- The self-update controller and "Improve Poise from Poise".
- The production updater status.
- launchd and legacy-datastore recovery.
- Desktop notifications through `osascript`.
- Espanso detection on the server.
- Claude sign-in through a local browser; the Connected accounts terminal
  replaces it, and the sign-in banner opens it there.

**Service endpoints** (loopback, or the `admin` scope; the owner's `browser`
assertion may only resume, and anything else is refused with 403):
- `GET /api/service/health` returns `{ ok, mode, version, activeChatTurns,
  runningCallerCalls, unsettledNativeCalls, backgroundWork, idle, draining, release, switching,
  repairExhaustionRepositories, eventLoop, desiredRelease, installedRelease, pendingSince, switchWaitingOn }`. `idle` is true only
  when `activeChatTurns`, `runningCallerCalls` and `backgroundWork` are all 0.
  It backs the container health check and the gateway's readiness check.
  - `eventLoop` is the current minute window of event-loop delay
    (`{ p50Ms, p99Ms, maxMs, meanMs, samples, windowStartedAt }`): main-thread
    stall, where CLI fan-out shows up first. The behavior diagnostics carry
    the same window; maximum delay is the stall signal, since an isolated
    stall barely moves p99.
  - `version` is the commit the running bundle was built from, `null` for a
    development build.
  - `repairExhaustionRepositories` is the effective comma-separated reporting
    allowlist, empty when disabled. Legacy values over 8 KiB return `[oversized]`
    so the gateway corrects them even when its desired value matches their prefix.
    Its absence identifies an older release that cannot apply this setting
    through service configuration.
  - `release` is the installed release the supervisor started this server on
    ([Updates in place](#updates-in-place)), `null` without one: the active
    SHA. A deploy is done only once it equals the deployed commit.
  - `switching` is the release a pending switch restarts this server onto,
    `null` when none is pending. Health reads it from the `next` record in
    `~/.poise/releases`, the same record the supervisor switches on, so it
    stays truthful when this server restarts: once the switch has fired, the
    record is consumed and nothing is pending. Asking to switch to the
    release it runs calls a pending switch off; the gateway does so when the
    target changes back. If the turn bound already cancelled work and the
    restart is refused or withdrawn, that work gets one continuation on the
    current server before waiting messages. A switch requested again while
    an earlier cancellation settles keeps its own deadline and turn set.
  - `desiredRelease` is the release the workspace is asked to run: the
    pending switch's target, else the active release.
  - `installedRelease` is the desired release when an install of it for this
    base exists (the running release needs none), `null` when it is not
    installed: desired without installed is an install failure, not a stuck
    switch.
  - `pendingSince` is when the pending switch was first asked for, as ISO,
    `null` when none is pending. It is the `next` record's mtime, which
    re-asking the queued release leaves alone, so asking again on later
    passes never moves it.
  - `switchWaitingOn` names what the pending switch still waits for, one
    phrase per failing quiet-gate clause (unheld chat turns, runtime
    operations, background operations, browser launches); `null` when none
    is pending or nothing blocks it.
  - `activeChatTurns` counts the Chat turns recorded open: reserved before
    their first write, closed once their outcome is recorded.
  - `runningCallerCalls` counts the Caller processes Poise launched for agent
    work (behavior runs, manual reviews and replays, card chats, `/content`)
    that it has not seen exit, plus `/consensus` debates still running, or,
    when more, the calls Caller records as running with their process alive,
    which include those an earlier release started. That records read waits at
    most 100 ms; on contention health reports unknown (idle false) at once
    instead of blocking the loop.
  - `unsettledNativeCalls` exposes the same bounded Caller read's count of
    native Calls awaiting durable resource release or cleanup-claim retirement.
    It is `null` when that read is unknown, never an assumed zero.
  - Optional `nativeCleanupHold` identifies one terminal Call with a recorded
    cleanup failure from that same snapshot. It exposes `callId` and a bounded,
    redacted `reason`, which is `null` while a retry owns the claim and has yet
    to record its result. If every reported cleanup failure has a terminal Call
    and durable settlement of its original process namespace, `retainedCalls`
    counts those failures. The gateway can carry that cleanup across replacement
    after a fresh drain confirms no other blocking work.
  - `backgroundWork` counts everything else a restart would cut: the Chat
    runtime's startups, operations and agent processes, process-owned
    background work (behavior ticks, provider CLI updates, the model check),
    launches from the browser admitted and still in their handler, and native
    Calls whose resource release or cleanup claim remains pending. The Caller
    count and pending-resource count use one bounded read transaction. Unknown
    cleanup records keep `idle` false. Cleanup continues on the existing
    one-minute maintenance opportunity while admissions and behavior ticks are
    paused.
- `POST /api/service/config` takes `{ repairExhaustionRepositories }`, a string
  of explicit comma-separated `owner/repo` names up to 8 KiB or empty to disable
  reporting, persists it in the workspace metadata store and returns health (200).
  Invalid or missing values return 400 without changing the previous setting.
  Only loopback or an `admin` assertion may write it; browser and Link assertions
  are refused. This setting does not
  alter existing native resource ownership or release/replacement safeguards.
- `POST /api/service/drain` stops admitting new Chat turns and behavior
  launches, then returns the same fields with the drain on. The gateway treats
  the drain as admitted only when the answer is `ok` and shows `draining`; an
  answer that does not (`workspace.drain.unconfirmed`) never recreates the
  workspace, since without admission new work stays unblocked. A drain lapses
  unless it is renewed: while the gateway polls health it re-POSTs
  `/api/service/drain` at least every 5 minutes. One `POISE_DRAIN_TIMEOUT`
  budget (default 5400, 90 minutes) covers the whole workspace operation: every
  drain, recheck and re-drain. The gateway recreates the container after an
  admitted drain reports `idle`, or when retained cleanup accounts for every
  unsettled Call and background operation and no Chat turn or Caller is running.
  Past the budget, cutting confirmed busy work requires a fresh admitted drain
  with `unsettledNativeCalls: 0` and no Caller or background work, including
  launches before Call registration. Cleanup without settled process proof and
  unreadable or unconfirmed answers defer replacement. The gateway releases
  the drain for the next pass (`workspace.upgrade.aborted`). When pending
  cleanup blocks replacement and no Caller is live, it releases the drain
  immediately. Existing maintenance retries cleanup independently. While
  waiting for live work, the gateway logs `workspace.drain.waiting` at each renew
  with the counters and the
  time left, `workspace.drain.lifted` when a drain it saw on is gone while the
  workspace still isn't idle, and `workspace.drain.timeout` with the last known
  counters. After starting the replacement the gateway waits for its health before
  declaring the upgrade finished, within the two-minute idle-to-ready bound
  (`readyAfterMs` on `workspace.upgrade.finished` measures stop to ready). Past it
  the miss is recorded as `workspace.upgrade.ready.missed`: a replacement that answers
  late still reports its measured `readyAfterMs`, and one that never answers is left
  for the next visit to bring up through demand-driven readiness. A pass skipped
  behind a running one names its handle and phase.
  - New Chat turns include queued messages, and launches include the
    browser's (`/api/pr-review`, `/api/agent-replay`, `/api/chat-content`,
    `/api/debate`, `/api/models/refresh`). Refused work answers
    503 with code `draining`; work already running continues.
  - One Chat turn holds an ordinary drain at most 30 minutes: past that the
    drain stops it through the person's Stop path, with a transcript notice
    naming the update, and the agent keeps its context for the next prompt.
    A drain with retained native cleanup lets Chat turns finish.
    `idle` follows once the stopped turn settles and the other health counters
    clear. Past the gateway's own timeout, confirmed busy work can be cut
    only after native cleanup is positively clear. Older workspaces
    without the native count still upgrade when cooperatively idle; they cannot
    authorize a forced busy replacement.
  - The workspace lets a drain lapse `POISE_DRAIN_TIMEOUT` seconds (default
    5400) plus five minutes after the last drain call, so a gateway that
    stopped renewing it cannot leave the workspace refusing work.
  - One service call waits 5 seconds for an answer and retries a timeout twice
    with backoff; a refused connection is not retried.
- `POST /api/service/resume` lifts a drain. The gateway calls it whenever it
  abandons an upgrade after attempting a drain without recreating the
  workspace; the owner's browser may call it too, to lift a drain a gateway
  left behind.

## Accounts, identities and the terminal

**Identities are user-level settings.** Menu → Settings → General → GitHub holds two accounts:
- the person's own GitHub account (`me`);
- the agent account their automations review and comment as.

Both must be signed in to `gh` inside the workspace. Trusted issue authors
default to those two accounts. Nothing in Poise or Caller names a fixed GitHub
account. Poise passes the accounts to Caller explicitly, through `--token-user`
and the `GITHUB_INTERFACE_USER` and `GITHUB_INTERFACE_AGENT_USER` environment
variables, and Caller fails loudly when an account is needed and missing.

**Connected accounts** (Settings → Accounts) lists `claude`, `codex`, `gh`,
`grok`, `muse` and `antigravity`. Each shows whether the CLI is installed, its
version, whether it is signed in and as whom.

**Followed accounts.** Settings → General → GitHub accounts follows GitHub
organizations and users, each with its own synced datastore. `DELETE
/api/organizations/<login>` stops following one; it is the person's action in
the browser. The account from setup and the last one cannot be removed.
Removal aborts the account's activation or sync job, resolves its notices,
and drops its repositories from the issue review selection and the Manager's
scope. Nothing changes on GitHub, datastores are kept, and work bindings stay
as history.

An account's due sync makes one nonblocking SQLite lock attempt after filesystem
setup, even when setup is slow. An activated account retains lock acquisition
failures in its existing sync error and retry state. Retries back off from one
minute to at most one hour, survive restart, and leave other accounts eligible. Five-second scheduler ticks
do not acquire the lock or repeat diagnostics before that retry. SQLite contention
and setup errors retain their actual causes; neither verifies a holder's process
identity. A newer sync, retry, identity or registration wins over an old
failed acquirer. Settings shows the error and automatic retry time immediately;
diagnostics retain the failure start, last successful sync age (unknown without a
timestamp), and the unchanged 120-second freshness limit. The existing per-account
alert still starts after 15 minutes of failures and clears/rearms only after a
validated sync. An activation lock conflict stays eligible for automatic
activation rather than becoming a manual-retry error.

`GET /api/github-quota` reads the configured user and automation accounts'
stored credentials explicitly and returns their API budgets without secrets.
Its response and forecast model are defined in [Analytics](Analytics.md#github-api-quota).
The workspace observes these budgets every 15 seconds even with notifications
off; only quota alert issuance is disabled. This does
not use the gateway's discarded OAuth token.
- `GET /api/accounts` returns `{ accounts }`, one entry per CLI in that order.
  `GET /api/accounts?id=<cli>` returns only that CLI, so Settings can show each
  result as soon as it arrives. An unknown `id` answers 400. These reads share
  each CLI's 15-second cache with the full list and sign-in alert checks;
  terminal exit invalidates all of them.
  Each entry is `{ id, installed, version, signedIn: true | false | null,
  identity, detail, login: { label } }`; gh's also has `accounts: [{ login,
  active, signedIn, detail }]`, every account gh holds for github.com, and
  Muse's has `credential: 'api-key' | 'account-login'` when its auth file
  names one.
  - Each CLI's own status command answers, never its credential files:
    `claude auth status --json` through Poise's Claude wrapper (signed in
    means a Claude subscription), `codex login status`, and `gh auth status
    --json hosts --hostname github.com` with no token from the environment.
    Grok and Antigravity have no status command: their `signedIn` is `null`
    and `detail` says so. Muse has none either, but its auth file's
    non-secret fields say which credential it holds, so its `signedIn` stays
    `null` while `credential` names the API key or the account login; no key
    or token is returned.
  - `signInRecordedAt`, when present, is historical completion/confirmation
    for installed Grok, Muse or Antigravity with a successful version probe.
    Their `signedIn` stays `null` and `identity` stays unasserted. Accounts and
    setup display **Signed in here** and Reconnect; this does not verify a
    current session. CLI status failures and Claude subscription rejection
    always retain their own status and detail, regardless of stored history.
    This history is joined after cached probes settle, so setup confirmation
    and withdrawal immediately affect both the full list and `?id=` reads.
  - `identity` is the account name the status command prints (Claude's email,
    gh's active login); no token, key or organisation id is returned.
  - The gh row marks the person's own account and the agent account among
    gh's accounts and says when either is not signed in to gh.
  - Each command has 10 seconds. Answers are kept for 15 seconds and dropped
    whenever a terminal exits.
    Codex's version and login-status probes use the same `CODEX_CLI` override
    when set, otherwise `codex` on PATH, without running CLI maintenance.
    Only confirmed launcher absence with no configured override and no durable
    sign-in record stays account status without a Logging Error. Unreadable
    configuration, broken launchers and unexpected probe failures retain an
    Error naming the probe purpose and executable; a normal signed-out answer
    remains account status.
  - Every read records sign-in alerts (`sign_in_needed`): one for an
    installed, configured CLI that says it is not signed in, and one each for
    the person's own account and the GitHub automation account while gh does
    not hold it signed in. A rejected saved GitHub account also raises one.
    A provider with no configuration record raises no
    sign-in demand, and a stale demand clears once the provider reads as
    unconfigured. Status-based conditions clear once signed in again; Claude's alert stays its
    auth monitor's, gated on the same participation. In service mode Poise
    also reads the accounts every 15 minutes, so the alerts come while the
    browser is closed. They open `/?settings=accounts`, Settings → Accounts.
    A native Codex credential rejection raises the same condition immediately,
    retaining the affected stage, issue and redacted cause. It survives a status
    poll that still reports signed in. After a fresh successful Connect,
    Accounts attempts one native verification (30 seconds, 64 KiB) through
    Caller's `--verify-codex-login`, using the review's private credential home
    and tool-free ChatGPT request options, without API-key/base-URL overrides.
    Canonical-home success alone cannot clear the block. A refresh retained
    only in the disposable home also cannot prove the next worker can sign in;
    verification never writes its credentials back to the canonical sign-in.
    A successful response after the latest rejection clears the condition and
    permits one early review probe through existing admission. Failed
    verification keeps its fixed typed reason in the existing sign-in
    alert and requires another Connect; one completed during a failed
    verification remains eligible. A failed review probe cannot reuse
    old recovery evidence. Successful native reviews on that route also prove
    recovery. Quota backoff and uncertain publication retain their own gates.
  - Participation: a provider takes part in model maintenance when
    `account_logins` records it, or when its live status positively verifies
    a usable sign-in (Claude/Codex; the observation is then recorded, so a
    later lost sign-in reads as a failure). Grok, Muse and Antigravity have
    no live status: their history is their only signal. Providers with
    neither record nor verified sign-in are skipped with reason
    `never_configured`; eligibility that cannot be established fails the
    check. A check with no eligible providers reports every provider skipped
    and succeeds neutrally. The server forwards its own observation to the
    refresh script; the standalone job resolves the same rule itself.
- `GET /api/ssh-keys` returns `{ keys }`, the public inventory of `~/.ssh`:
  one entry per private key file (name, permission bits, size) and per public
  key without a private file, with the `.pub` line and its SHA256 fingerprint
  when readable. Private files are stated, never opened. A missing `~/.ssh`
  answers empty; anything else unreadable answers 500.
- Connect opens a terminal in the browser, inside the workspace, running that
  CLI's own login (`login.label`):

  | CLI | Login command |
  | --- | --- |
  | Claude | `auth login --claudeai` through Poise's Claude wrapper |
  | Codex | `codex login --device-auth` |
  | gh | `gh auth login --hostname github.com --git-protocol https --web` |
  | Grok | `grok login --device-auth` |
  | Muse | `muse login`, which warns it switches Muse to the account login and its subscription quota |
  | Muse API key | `muse auth set --api-key-stdin`, pasted into the terminal; Poise never sees or stores the key |
  | Antigravity | `agy`, which has no login subcommand: it opens its sign-in screen when it starts signed out |
  | SSH key | the SSH import: a pasted private key lands in `~/.ssh` with 0600 and its `.pub` is derived; Poise never sees or stores the key |

  Credentials go straight from the CLI to its own files; Poise never reads them,
  except Muse's auth file for its non-secret fields (which credential it holds).
  SSH private keys go straight from the import terminal to `~/.ssh`; Poise never
  opens a private key file.
  In local and service mode, a successful Connect exit records a timestamp in
  Poise's existing `account_logins` map, independently of setup progress. Grok
  and Muse can therefore show the completed sign-in immediately and after a
  restart; storing a Muse API key records Muse the same way. A positively
  observed Claude/Codex sign-in, including one made outside Poise, records
  the same way. A failed/signaled login, startup failure or shell exit adds
  no evidence; failed reconnects retain any earlier historical confirmation.
  Antigravity's app exit never creates a confirmation. Existing entries,
  including indistinguishable older automatic Antigravity entries, are kept.
  Missing CLIs and failed version probes retain history without showing a
  positive sign-in state. Setup's explicit withdrawal removes the record.
- `/ws/terminal?preset=<id>|shell|muse-api-key|ssh-key` is browser scope only.
  - Client to server: `{type:"input", data}` and `{type:"resize", cols, rows}`,
    with `cols` from 2 to 500, `rows` from 2 to 200 and frames up to 64 KiB.
  - Server to client: `{type:"output", data}` (base64) and `{type:"exit",
    code}`, then a close with 1000. `code` is the program's exit code, or 128
    plus the signal that ended it.
  - At most two terminals at a time: a third is closed with 1013 and a message
    saying so. One with neither input nor output for 15 minutes is closed with
    4000. One that cannot start is closed with 1011 and the reason; a frame
    that is not one of the above with 1007, a binary frame with 1003.
  - Closing or losing the socket hangs up the program's process group (SIGHUP,
    then SIGKILL a second later); so does Poise stopping.
  - `shell` is the owner's login shell. Every program starts in the home
    folder with Poise's environment allowlists and `TERM=xterm-256color`.
  - A small Python helper (`python3`, standard library only) provides the
    pseudo-terminal, so the server needs no native Node module.

## First-run setup

A new workspace opens a setup dialog on the first sign-in. It sits in the
middle of the screen with the rest of Poise dimmed and out of reach, in Poise's
own look. It goes through, in order:

1. **Theme**, applied at once.
2. **GitHub:** GitHub's device sign-in. gh's own login runs through the
   terminal socket with no terminal on screen. Setup answers its two
   questions with their defaults and shows its one-time code with **Copy code
   and open GitHub**. gh's output stays folded away under "What gh says", and
   "Answer it in a terminal" takes over when gh shows no code. Poise then
   checks the connection and makes the account your GitHub account.
3. **The agent account,** connected the same way, with the code copied into
   a private window signed in as that account, and checked the same way.
4. **Organizations** to follow. Any that failed to activate before GitHub was
   connected are retried once.
5. **Time zone and refresh rate.**
6. **The AI accounts,** each with its own Connect terminal.
7. **Models** for every place. Only signed-in providers can be chosen; the
   others are dimmed.
8. **Poise Link,** through the gateway API above.
9. A finish that names Settings, in the menu, as where all of it can be
   changed.

Every step saves through the same API Settings uses, so Settings shows what
setup chose. A step that connects something lets setup continue only once it
works. Finish later closes the dialog until the next page load. Settings →
General → Run setup again starts it over. `/?settings=link` opens it at
Poise Link while it is unfinished.

- `GET /api/onboarding` returns `{ available, status, step, owner, logins,
  completedAt }`; outside service mode only `{ available: false, status:
  "done" }`.
  - `status` is decided once and stored: `done` for a workspace that already
    had a ready GitHub account when it was first asked, `pending` otherwise.
  - `step` is where it resumes.
  - `logins` holds, per agent CLI, when its Connect terminal last exited with
    code 0, or when the person said it is signed in. Antigravity is the
    exception to the first: its terminal runs the app itself, which exits
    cleanly whether or not a sign-in finished.
  - The CLIs that report no sign-in (Grok, Muse, Antigravity) count as signed
    in once that has happened. Setup lets the person say so, or take it back,
    with `POST /api/onboarding` and `{ account, signedIn }`; for any other
    `account` that answers 400.
- `POST /api/onboarding` takes `{ step }`, `{ done: true }`, `{ restart: true
  }` or `{ account, signedIn }`, and answers like the GET.
- `POST /api/onboarding/github` takes `{ role: "me" | "agent", login }`.
  - It checks that gh holds a sign-in for `login` and that its token answers
    GitHub's `/user` as that account, with the `repo` and `read:org` scopes
    when the token reports scopes.
  - It returns `{ ok: true, login, scopes, note? }`, or `{ ok: false, reason,
    message }` with `reason` one of `not-signed-in`, `rejected`,
    `other-account` or `scopes`.
  - On success it saves the account as `me` or as the agent account. For `me`
    it then runs `gh auth setup-git`. For the agent account it makes `me` gh's
    active account again, since gh makes the account it signed in last the
    active one, and git and gh's own defaults act as that account.
  - `note` says when either gh command failed.
  - The token never leaves the check.
- Outside service mode these routes answer 404, except that GET.

## Behaviors

Behavior run metrics reuse the existing Caller snapshot and direct-run ledger.
Optional quarantine source/start hints limit reporting uncertainty; they never
change execution or replay authority. [Run analytics](Behavior-Contract.md#run-analytics)
defines historical diagnostic compatibility and scoped metric availability.

Overview's *Answer here* lists Behaviors' diagnostics: red Poise faults, amber
conditions that need the person and folded grey automatic recovery, with grouped
target/cause details ([Notifications](Notifications.md)).
The API carries an explicit `runtimeError` for scheduler faults and classifies
retained incidents from its validated Caller snapshot independently of active
failure summaries. An unavailable Behaviors API request is one availability
diagnostic; it cannot establish datastore or identity failure. Last-known runtime
degradation remains visible; an initial unread runtime is unknown. The classification
and evidence rules are in [Behavior integration contract](Behavior-Contract.md#diagnostic-severity).
Validated stale mirrors use one durable episode per account/database, with
per-behavior refusals grouped beneath it and recovery recorded only by a
validated healthy probe; upstream and process faults remain independent.

PR automation uses the opposite configured account from the PR author, including
follow-up approval, replay and downstream PR operations. Existing enable switches
cover both directions. Settings and gh's active account are unchanged. Manual
reviews under the main account cannot become automation evidence: only recorded
Poise receipts authorize automated follow-up approval and conversation resolution.
See [PR accounts](Behavior-Contract.md#pr-accounts) for admission and recovery rules.

**Repository opt-out.** Review new PRs, Approve PRs, Resolve unblocking,
Merge PRs, Rerun Grey CI and Close Old Pull Requests
each have a "Skip repositories" list:
- The list is chosen from all repositories of the person's ready accounts.
- The picker groups repositories by account and offers "Select all" for each
  group and overall.
- The scheduler never launches work for a skipped repository.

Review New Issues stays opt-in.

**Replay checks.** A replay from Observe → Behaviors passes the same eligibility checks the
scheduler applies, or it is refused with HTTP 409 and the failed check named:
- **Issue review:** the repository is opted in, the issue is open, and its
  author is a trusted author.
- **PR review and approval:** the pull request is open, is not a draft, is
  authored by either the person's GitHub account or their configured agent account, and is not in a skipped
  repository.

The facts are read fresh from the datastore the scheduler reads; when they
cannot be read the replay answers 502 and launches nothing. Observe → Behaviors
shows a refusal under the row whose Replay was pressed.

**Pausing.** A behavior can be paused until a time (`pausedUntil` on `POST
/api/behaviors/<key>`, `null` clears). The pause is stored apart from the
saved on/off and attributed to the person or the api; it clears no claims,
seen state or backoff. While it holds, reconciliation and already launched
agents run on, but nothing new launches: every launch path rechecks at its
final admission, and replays and explicit runs stay available. Expiry needs
no write and never flips the saved on/off.

## Snippets and Poise Link

**Snippets are edited only in Poise:** the Snippets view, Chat's `/create`, and
the Editor's "save selection as snippet". The desktop copy is generated.
Snippets view → Import takes an Espanso YAML file once and adds its simple
trigger/replace pairs, reporting any it skipped. Poise Link connection status
appears in Settings → Accounts → Poise Link. The Snippets toolbar contains no
Poise Link connection banners or settings shortcuts.

**Device pairing** (gateway, on the apex):
1. `POST /link/device/code` returns
   `{ device_code, user_code, verification_uri, expires_in, interval }`.
2. The person opens `verification_uri` (`/link`). Signed in, the gateway sends
   them on to Settings in their workspace (`/?settings=link`), where they
   confirm the `user_code` through `POST /_poise/api/devices/pair`.
3. `POST /link/device/token` with `{ device_code }` returns
   `{ error: "authorization_pending" }` until approved, then
   `{ access_token, endpoint, login }`, where `endpoint` is the workspace
   address. Every refusal follows RFC 8628: HTTP 400 with `{ error }`, where
   `error` is one of these and nothing else:
   - `authorization_pending`;
   - `slow_down`, when polling faster than `interval`, which then grows by 5
     seconds;
   - `access_denied`;
   - `expired_token`, after `expires_in` (15 minutes);
   - `invalid_grant`, for an unknown or already redeemed code;
   - `invalid_request`, for a body without a `device_code` string. This one
     also carries `error_description`.

Settings may submit at most 10 codes per sign-in in 15 minutes.

Devices are listed and revoked in Settings → Accounts → Poise Link;
`/link/devices` sends there too. The gateway stores token hashes only. A device token expires after 30 days without use and 365 days
after pairing; Poise Link then pairs again.

**Link API** (workspace, `link` scope, `Authorization: Bearer <access_token>`):
- `GET /api/link/hello` returns `{ login, version }`.
- `GET /api/link/snippets` returns `{ version, yaml }`.
  - The YAML holds only plain `trigger`/`replace` string pairs, under the header
    comment `# Managed by Poise Link. Edit snippets in Poise; changes made here
    are overwritten.`
  - `version` is the SHA-256 of the YAML, also sent as the `ETag`.
  - `?wait=<version>` holds the request for up to 25 seconds until the version
    changes.
- `GET /api/link/events` is a Server-Sent Events stream:
  - `snippets` with `{ version }`;
  - `alert` with `{ id, kind, title, body, url, created_at }`;
  - `ping` every 20 seconds.
  - On connect it sends the current snippets version, plus the alerts
    recorded after `Last-Event-ID`: the newest 50 of them at most, so a device
    that was away for weeks is not flooded. An id the workspace did not issue
    resumes nothing. Each alert's id is its event id.
- An unusable device token gets HTTP 401 with `{ error, message }` and
  `WWW-Authenticate: Bearer error="invalid_token"`, never a 403 or a
  redirect. Poise Link treats any 401 as "sign out and pair again". `error`
  names why:
  - `device_unknown`: never issued, or paired with another workspace;
  - `device_revoked`;
  - `device_expired`;
  - `user_disabled`: the owner is disabled;
  - `access_removed`: the owner no longer has access.

  A device token on a path outside `/api/link/*` gets 401 with
  `invalid_token`.

**Alerts** retain unresolved workspace conditions until authoritative resolution;
resolved history and native replay retain their 30-day window. Each condition
alerts once, and again only after it has cleared:
- in service mode, temporary space falls to 5 GB free and each GB below
  (binary GB, measured every minute); only downward crossings alert, including
  an initial low reading. Recovery to 6 GB clears and rearms the warning so
  fluctuations near a threshold do not repeat it. Measurements and
  warnings never pause, reject or stop work;
- a configured agent, GitHub, Google or extension account needs to sign in
  again ([Connected accounts](Connected-accounts.md#alerts));
- a behavior failed and is held, with a fresh alert when its cause materially
  changes even if the previous alert was dismissed. Repeats of the same cause
  remain deduplicated ([Notifications](Notifications.md));
- datastore sync has been failing for 15 minutes;
- a GitHub API budget is forecast to run out (`github_quota_warning`), or is
  exhausted (`github_quota_exhausted`), while notifications are on. These use
  the same alert event envelope; [Notifications](Notifications.md#github-api-quota)
  defines their reset, recovery and dismissal behavior;
- a Chat agent is waiting for the owner's permission or answer;
- a Chat turn that ran longer than two minutes has finished;
- a pull request of the person's own has become ready to merge, while
  notifications are on ([Notifications](Notifications.md)).

With the browser open, Overview's *Answer here* and the bell apply the
[selected notification level](Notifications.md#answer-here).

**Poise Link** runs on macOS, Windows and Linux from one Tauri codebase.
- **First run:** asks for the server address, runs device pairing, keeps the
  token in the operating system's credential store, and turns on
  start-at-login itself (a launch agent on macOS, the Run key on Windows, XDG
  autostart on Linux). It then lives in the tray. On macOS launchd also starts
  it again whenever it stops other than by Quit, so while start at login is on
  every other start hands over to launchd's copy.
- **Snippet sync:**
  - It holds the event stream open, refetching snippets on change and at least
    every 10 minutes.
  - It accepts only plain string pairs.
  - It writes `poise.yml` into Espanso's match folder in one atomic rename. The
    folder is found through `espanso path config`, with these fallbacks:
    - macOS: `~/Library/Application Support/espanso/match`
    - Linux: `$XDG_CONFIG_HOME/espanso/match`
    - Windows: `%APPDATA%\espanso\match`
- **Alerts** become native notifications; clicking one opens its URL.
- **Tray menu:** status, Open Poise, Sync now, Notifications on/off,
  Start at login on/off, Sign out, Quit.

## Pull-request actions

The person's Approve and Merge buttons (workspace, the person's browser
only): `POST /api/pull-requests/approve` and `POST /api/pull-requests/merge`.
Both take `{ repo, number, expectedHeadSha, actionId }`, act with the person's
GitHub account, and pin the action to the expected head. Anything without the
person's authority answers 403 and acts on nothing.

Each `actionId` is a receipt: the server reserves it with a fingerprint of the
action before anything is sent. Repeating a call returns the stored outcome
without acting again; the same ID for a different action is refused with 409.
A lost response or a crash reconciles against GitHub instead of acting twice:
a recorded result becomes the outcome, anything else answers unknown with the
GitHub state, and a retry with the same ID reconciles again. Outcomes name
what happened: `approved` and `already_approved` carry the approval's head and
the current head; `merged` carries the merge SHA and method; `enqueued` and
`in_queue` carry the queue entry; `already_merged` names who merged;
`superseded` carries both heads; `refused` carries GitHub's own words.

## Redesigned-interface reads

`GET /api/capabilities` lists the capabilities this server has, by name
(`server/capabilities.ts`). #556's interface reads it once at mount and uses
each capability once it ships, keeping its Open fallback otherwise. Only
delivered capabilities appear; the Manager's controls, plan and escalation
stay absent until their enforcement lands.

The supporting reads behind those names:

- `GET /api/behavior-estimates`: each running behavior run with its remaining
  time from similar runs (same behavior and model, last 30 days, at least
  five); an overrun reads `overrun`, never below zero.
- `GET /api/chat/requests`: up to 200 open chat requests with a revision,
  kept current by the `chatRequests.updated` frame. `ownerAction` identifies
  requests for the owner and sorts them first. `escalation` carries the
  Manager's reason when it escalates a pending question.
- `GET /api/notices/handled?since=<ISO>`: the append-only handling log, kept
  30 days from each entry's time. It answers from the stored log at once and
  starts the notices check without waiting for it, so what that check
  resolves is in the next read.
- `GET /api/editor/reviews`: every publication with its `checkedAt`, `stale`,
  `problems` and `retryAt`, including ones with no open thread; a cold or
  failed one stays listed, never looking as if it had no feedback. The
  response also states the sweep's longest delay in minutes.
- Settings saves may carry `expect: { <field>: <value the tab read> }`; a
  save that would overwrite another tab's edit is refused with 409 and the
  current values, changing nothing.

A background sweep reads every GitHub publication as your GitHub account,
oldest checked first, one publication a minute and each at most every 15
minutes; closed or merged ones are re-read once a day, so a reopened pull
request or late feedback is seen within a day. It pauses on release drain
and on the account's deferred budget, keeps the Editor's backoff, and skips
Google publications, whose reads need live browser delegation.

## Deployment

`deploy/` holds:
- a Compose file running Caddy and the gateway, and `compose.proxy.yaml`,
  which the scripts add when `POISE_PROXY_LISTEN` leaves TLS to a proxy the
  server already runs;
- the Caddyfile (apex plus on-demand TLS for workspace hosts);
- an environment template;
- operator scripts to install, upgrade, back up and restore
  ([Operating Poise](Operating.md)).

The `poise-runtime` image is built from this repository on the server, with
the checkout's commit as the build argument `POISE_SOURCE_SHA`, which
`/api/service/health` reports as `version`.
Upgrading is: pull, build, `docker compose up -d`. The gateway then drains and
recreates any workspace whose image differs from `POISE_RUNTIME_IMAGE`, or
whose `POISE_DRAIN_TIMEOUT` or configured native behavior budgets differ from
its own, keeping its volume and respecting the native settlement barrier.
The reporting allowlist is reconciled separately through trusted service
configuration without replacing a compatible running container.
Replacement pins stop and removal to the inspected container ID. If stopping
fails, the gateway inspects that ID and the current workspace name separately.
It continues only for the same owned container with an explicit stopped state;
an absent, unreadable or malformed target cannot authorize removal. An already
serving successor is left alone and observed only after the old container is
confirmed stopped or absent and its own ownership, image, settings and health
(including the intended release) match. Otherwise the upgrade retains an Error
with the stop cause and safe old/current identity and inspection evidence.
Abandoning replacement releases a drain only while the original container still
owns the workspace name.
The operator scripts retain an exact-release rollout receipt beyond their
bounded verification wait. `deploy/verify.sh ROLLOUT` reconciles a pending
receipt through the existing workspace health/image proof without initiating
another rollout; [Upgrades](Operating.md#upgrades) defines its outcomes and
retained evidence. This adds no gateway or workspace API.
Fork Deploy verifies the receipt in a separate step after host apply. Sync
rechecks the current applied receipt after the bounded wait.
The Sync workflow's separate release observer uses the existing five-minute
schedule and Actions summary even when upstream sync is disabled. It reads
exact-main workflow evidence, retained rollout inventory and fresh workspace
health/image proof, retaining one diagnostic episode on the deployment host.
It never invokes release gates or controls; [release lag observation](Operating.md#run-your-own-poise-from-a-fork)
defines its fixed grace, unavailable evidence and recovery proof.

For gVisor workspaces, install/upgrade also own the boot-enabled host
`poise-caller-guard.service`. It selects actual Docker runtimes, holds host
SQLite locks on current and retained original Caller inodes, and verifies
acquisition from a separate process before deployment reports protection.
Its independent scans cover workspace creation/replacement and host, Docker
and guard restarts without relying on cached gateway readiness. Failure is
visible through its check, journal and unit status; existing workspace readers
and metadata identity checks remain unchanged. This advisory fence cannot
prevent privileged host bypass and has recovery/discovery intervals.
[Live Caller diagnostics](Operating.md#live-caller-diagnostics-under-gvisor)
defines the supported readers and explicit protection check. Host backups
refuse running separate-kernel workspaces and busy/locked SQLite snapshots.

**Provider CLIs** are installed into each person's home volume on first start
and update themselves there, as Poise already does before each launch. The
image carries everything else: Node 22, Python 3.13, Caller, `gh`, `git`,
build tools and `tini`.

## Diagnostic collection boundary

The direct workspace production entrypoint additionally owns a permanent
`SIGUSR2` handler for one optional 15-second CPU capture per process. It uses
an in-process inspector Session without a debugger listener, HTTP interface,
heap capture or expression execution. Its fixed protocol commands are
`Profiler.enable/start/stop/disable` and `Runtime.discardConsoleEntries`; the
last command releases console references before disconnect. `SIGUSR1` remains
refused. Imported production modules, local launchers and development servers
do not install the capture handler. Service mode supplied by `.env` installs
it after secure loading/validation and before logging/runtime startup;
environment-supplied service mode installs it before dotenv loading.
Native signal-report/heap options make
capture unavailable; operators must check availability before signalling,
since a JS handler cannot prevent Node's independent native signal actions.

This optional capture does not enter the release background barrier. Shutdown
abandons it without waiting for the remaining capture period or changing exit
codes. Its one private, non-replacing home-volume artifact is separate from
retained diagnostic delivery and creates no new gateway or health contract.
The exact process/release preflight, file limits and interpretation rules are
in [Operating: bounded CPU capture](Operating.md#bounded-cpu-capture).

Poise retains version 1 private diagnostic records in a dedicated home-volume
SQLite store; the gateway retains the central copy in its own data volume.
Neither store depends on alert lifecycle. Workspaces never mount the central
store, Docker socket or host journal. Host journal directories and machine ID
are read-only gateway mounts, used only for kernel and Docker-daemon warnings.
The operator CLI and redaction/retention/coverage contracts are in
[Logging](Logging.md).

An optional external Caddy reader uses a dedicated operator SSH key restricted
to `docker exec -i poise-gateway node dist/diagnostics/cli.js ingress-stream`.
No HTTP ingestion route, JWT scope or workspace host capability is added.
The command relays to the gateway's mode-0600 private Unix socket; only the
gateway writes the diagnostic store. Externally owned coverage lives in that
store, and runtime journal flushes cannot overwrite it. The version-1 stdin
protocol carries one bounded projected source window after a domain/checkpoint
handshake with a new random challenge and gateway-issued observation time.
Central events, coverage and its compare-and-set checkpoint commit together
before acknowledgement. Coverage includes an optional 90-second
`observationExpiresAt` lease starting at challenge issue, enforced at read time even when the
reporter is dead. Retained history and initial/rotation/read-bound uncertainty
remain independent of current connectivity. A stopped observation opens a gap
at its last confirmed time; restart remains initializing until a fresh scan.
Canonical host selection and redaction run on the edge before transmission,
then attribution and normalization run again at the gateway. See the
[external reader installation contract](../deploy/ingress/README.md).
The host deployment verifier also sends bounded observations through that
private operator socket. The gateway retains rollout/workspace deadline and
recovery diagnostics using the existing v1 envelope/store, without a public
ingestion route or a release/replacement control change. Only deployment delivery
retries a complete response containing only the writer's exact busy refusal,
replaying the same bounded observation within one 30-second deadline; other
refusals retain a bounded, redacted cause.
[Logging](Logging.md#collection-and-operation)
defines the budget, deduplication and recovery contract.
The edge also derives the fixed `/api/link/events` route label before removing
the URI. All ingress paths apply the narrow native cancellation exception and
retain other redacted causes as defined in [Logging](Logging.md#collection-and-operation).

`GET /api/service/diagnostics?cursor=OPAQUE` is a maintenance-only delivery
route: loopback or the existing gateway `admin` assertion, never browser/link
scope. It returns `{ version:1, events, cursor, hasMore, coverage }`, at most
three redacted private events and 256 KiB. This separate bound does not change
the 64 KiB health/drain bound. The gateway validates the workspace identity,
full scoped event/incident identifiers and severity, re-redacts the envelope,
and commits its checkpoint only after durable central ingestion. Delivery
cursors survive ordinary process/container replacement and cannot widen scope.
No new JWT scope, owner bypass, shared filesystem or public ingest route is
introduced. A failed source or sink remains explicitly unavailable/partial. Coverage retains its historical `status` and independently reports optional `currentStatus`; runtime and browser-health responses distinguish recovered observation from retained gaps, pending backfill and stale/unread state. Ordinary workspace stdout is outside the structured collection contract and cannot create a false outage. Malformed claimed diagnostic envelopes remain observable failures.
An obsolete source cursor returns 409 `diagnostic_cursor_invalid`; only this explicit rejection permits resetting that source checkpoint and bounded replay, with a recorded collection gap. Other failures preserve the checkpoint.
The optional `lossActive` observation distinguishes current overflow/rejection
from cumulative loss. Its first transition is immediately journaled; a successful
drain/persistence boundary without new loss establishes recovery. Independent
health readers retain cumulative loss and do not infer recovery from legacy
counters that lack this observation.
Maintenance coverage adds bounded owner-scoped historical summaries: optional
`historyIncomplete`, dropped/rejected lower bounds and up to two latest gaps for
each of at most 16 sources. The production producer and collector share this
projection's regression proof; invalid coverage cannot advance a delivery cursor.
Source details omitted by the projection remain explicitly incomplete after
current observation recovers. No status enum changes. An explicit `optional`
flag describes intentionally unsupported local collectors; missing required
production sources are not exempted from health.
Workspace native diagnostic/fatal/fallback reports use stderr. Ordinary stdout
is outside that log-read window; Caddy retains its native streams and release
tasks retain their separate failure collector. Workspace stream health is
aggregated once per collection pass across all relevant containers.

The workspace distribution includes the bounded bootstrap diagnostic command and
its canonical redaction module for standalone maintenance scripts. Installer
output capture preserves command status/deadlines and excludes arguments and
stdout from diagnostic records. The gateway captures release-task failure
metadata before removing its short-lived container; retained central evidence
is independent of that container and its home-volume lifecycle.

The browser notice and Behaviors APIs may include optional `evidence` and bounded
`evidenceReferences` from the retained owner-scoped index. Association shares the
Logging read worker and its admission/deadline limits; it creates no diagnostic
occurrences and cannot delay raising an alert. Pending/unavailable associations
preserve the primary condition and action. No new route, ingest endpoint, target
variant or scope is introduced. See [Logging](Logging.md#notification-evidence).

## Workspace behavior observation

Analytics adds a guarded, read-only `GET /api/analytics/system-health?org=LOGIN`
projection of canonical v2 work, original Caller receipts, existing GitHub
observations and ledger coverage history. It preserves seed identity, original
merge times and historical gaps, and labels unavailable accounts and
instance-wide coverage. The existing Analytics refresh reads it; it adds no
poller, Caller/GitHub observation, gateway scope or execution authority.
Existing `chain.resumed` producers may retain recovery origin and failure-linked
reconnect/provider-verification evidence; these optional fields do not change
reducer state or old event hashes. Ambiguous older events stay unknown. See
[System health](Analytics.md#system-health).

New implementation admission also consumes Caller's complete live forward GitHub
prerequisites and verified delivery on the implementation base through the
existing chain sweep, including a final observation after awaited request
preparation. The mirror health gate remains required.
[Behavior chain](Behavior-chain.md#handoffs-and-outcomes) defines the
dependency wait; no gateway route, journal event or poller is added.

The workspace's existing `/api/behavior-chains` controls also expose an explicit
behavior-only admission cutover. One `switch-to-v2` request records a durable
drain in the canonical behavior journal; `cancel-cutover` is permitted only
before completion. Both require its current sequence. The cooperative release
barrier supplies behavior settlement counts, independently of Chat/background
work. Unknown native Caller activity or incomplete PR observations prevents
completion. The existing tick commits the v2 mode, legacy PR ownership boundary
and enabled chain setting atomically; late launches recheck the durable gate.
This does not call the service-wide drain or its Chat-stop deadline, restart a
workspace, change production defaults, or migrate existing work. Reads return
the actual cutover mode/blockers; [Behavior chain](Behavior-chain.md) defines the
GUI, headless controls, ownership and cancellation semantics.

The [Behavior ledger](Behavior-ledger.md) adds guarded, read-only
`/api/behavior-ledger` routes and a loopback CLI within each workspace. A separate
bounded worker/store captures existing behavior events and Caller snapshots;
no new Caller reads, gateway scope, public machine credential or proxy delivery
is introduced. It shares the current workspace owner/operator boundary and
cannot influence execution. Concrete pilot deployment remains outside this
package contract. A native `review_target_closed` outcome distinguishes target
closure from a head-change retry; panel activity still reflects every started
worker, including running or uncertain siblings. It adds no execution authority.
Existing ledger responses may include fixed, bounded `Server-Timing` headers
for handler, queue and completed worker phases. They add no JSON fields,
authority, persistence or collection; absent responses establish no timing.
A per-PR status projection is served beside the ledger at guarded, read-only
`GET /api/behavior-ledger/pr-status` with a `pr-status` loopback CLI
subcommand. It projects one row per open pull request from already-held
state (datastore listing, launch ledger, incidents, queue admissions, and
the merge-prs tick's cached candidate reading, or the canonical journal for
chain-owned work) with no new Caller or GitHub read and no execution influence.
The status reply is version 2 (ordinary ledger replies remain version 1).
Rows identify v1/v2 ownership; v2 exposes retained merge/review obligations and
uses nullable verified review-slot counts instead of the legacy review-cap
counter. Stale chain observations remain unverified and contradictory journal
evidence fails unavailable. Queue observations do not acquire original enqueue
attribution, and an owned long-running model invocation remains a current phase
while GitHub facets await refresh. Chain summaries preserve pending/complete/
not-recorded review evidence without changing journal payloads or historical
hashes. Behavior diagnostics add workspace-wide durable `chainCapacity`, with
mode, effective enablement, saved intake, configured budgets/reservations and
separate process-local counts. Manager worker-Chat occupancy is nullable when
unreadable, and its backlog excludes proven chain-owned issues. See
[Behavior ledger](Behavior-ledger.md) and [Behavior chain](Behavior-chain.md).

Chain/status summaries also expose derived reconciliation timing for quiescent
ownership. The existing scheduler and indexed journal projection bound GitHub
rechecks while preserving the public active/merged filters, native resource
settlement and immutable history. Confirmed closed seeds without remaining
obligations leave the active list before pagination, retaining ownership and
unfiltered/history reads as defined in [Behavior chain](Behavior-chain.md).
For a closed seed without an owned PR, Caller's seed read can identify a sole
merged closing PR on the expected base repository and default branch. The normal
PR read confirms its merge SHA before reconciliation records the external outcome;
missing original review evidence remains pending and publication ownership is unchanged.
For a bound PR confirmed closed without merge, the same verifier retains a
different merged closing PR separately in `externalMerge`. Only that verified
closing reference is discounted from the active-list exclusion; the original
binding and receipts remain unchanged, and its test-merge SHA cannot establish
a merge. Remaining publication, native resource and review obligations stay active.
Recovered full-suite repairs can instead end with verified supersession. The
same journal retains failure/recovery runs, covering merges, the duplicate head
and its native close receipt; summaries expose that evidence separately from
`mergeSha`. Original writes and native resources must settle first. Unclear or
independent work remains open with its decision visible. The existing Caller
action performs head-checked retirement; a lost close response stays uncertain.
The normal-work page precedes due quiescent
reconciliation; observation failures remain reported after unrelated progress.
Merged direct-action recovery reads original journal responses without another
GitHub observation. The optional `reconciliation` read fields add no write
operation or authority; a deliberate wait keeps GitHub facets unknown without
declaring a collector outage. No extra poller or gateway scope is
introduced. [Bounded reconciliation](Behavior-chain.md#bounded-reconciliation)
defines the cadence and timestamp units.
The same reconciliation can release a CI-only hold after a proven clean base
update, or admit the existing scoped repair when a fresh conflict on the retained
failed head blocks that update, retaining the original Call, resource-release
proof, repair retry bound and remaining gates
as defined in [CI hold recovery](Behavior-chain.md#bounded-reconciliation).
Queue-only CI holds retain their original removal, integration, workflow and
failed attempt in the existing Caller blocker. Recovery requires later matching
integration success or independently verified shared-baseline recovery; green
PR-head checks alone retain the hold. The original no-write Call and native
resource settlement remain required, and current-head review and current-base
merge gates still apply under the same [CI hold recovery](Behavior-chain.md#bounded-reconciliation).
For a pre-PR implementation, the existing Caller artifact and seed read can
instead verify an original CI assertion failure on its exact prepared base, and
the delivered main recovery with validation of every original failing test and
case. Relay assertions remain held for #1619 until the runner establishes their
inventory independently of candidate-controlled reports.
The journal admits one fresh implementation for that automatic hold and recovery
commit, independently of report publishing. An incomplete original assertion can
instead use the saved automatic hold report and linked delivered fixture fix for
one persisted clean-base recheck, requiring reproduction on the old base and an
executed pass on the corrected base. This uses the same single-retry admission
and normal validation gates, as defined in [bounded reconciliation](Behavior-chain.md#bounded-reconciliation).
Unverified rechecks and later operator holds retain their authority; no gateway
route or new poller is added.

The first `/api/behavior-chains` list page also includes read-only `attention`
across all active chain pages. It joins durable progress age, holds, exact-head
merge gates and the next known retry/intervention, including pending original
review obligations after merge. The existing journal history supplies the clock;
unchanged polls cannot refresh it. Stale/incomplete evidence stays explicit.
This adds no observation, scheduler, event type, scope or execution authority.
[Behavior chain](Behavior-chain.md#intake-and-controls) defines selection and resets.

Logging incident details, list snapshots and existing browser Notification entries may independently read `/api/behavior-chains` with exact
`callId` and/or `correlationId` selectors for a read-only work-impact annotation
shared with expanded details. `batch=1` accepts up to 100 paired, repeated
`callId`/`correlationId` parameters (empty means absent, at least one per pair)
and returns ordered `impacts` using the same single-invocation association and
state calculation. The existing single lookup retains its `impact` response.
Each displayed page uses one optional batch read, deduplicating exact selector
pairs; Refresh replaces its results without a new polling loop or per-row reads.
This uses the existing owner workspace boundary and canonical journal, including
completed chains. Ambiguous or missing matches remain unknown, as does a failed
workspace read; central Logging queries and retained evidence remain independent.
No gateway read, scope, ingestion or execution authority is added.
Typed provider analysis handoffs use the existing v1 diagnostic envelope and
positive no-submission evidence. The same work-impact read confirms only later
same-PR/head/basis/slot successor admissions or attributed review verdicts for
Warning display; current blockers retain Error. Source events and their IDs
remain immutable, including historical unproven handoffs. The exact display and
source-filter distinction is defined in [Logging](Logging.md#observe--logging).
Initial remediation report bodies retain a dated snapshot of this projection;
later recovery does not rewrite it. Optional annotation failure leaves impact
unknown and does not consume the report's creation attempt.

Invocation summaries may also carry retained original publication-plan absence
and recovery evidence. Logging displays the original Call and restoration
action even while its invocation is active. This diagnostic evidence grants no
publication, retry or resource-release authority; [Behavior chain](Behavior-chain.md#authority-and-recovery)
defines its reconciliation rules.
Atomic publication also retains its original pre-write phase: a proven no-write
failure settles through the existing Caller receipt after resource release;
missing original push evidence stays visible in the chain wait with its fence intact.
PR review and approval deadlines likewise carry validated no-publication results
through Caller completion and native resource settlement under those same
[recovery rules](Behavior-chain.md#authority-and-recovery); a diagnostic or
cleanup alone cannot release an unknown publication effect.

Known closed targets cannot start or restart a model behavior or continue
publication. Never-started admissions settle with explicit no-effect evidence;
started originals without a Call remain uncertain without a retry or synthetic
no-effect receipt, since partial recovery can lose the original unique correlation.
Unreadable snapshots retain that hold in the existing journal.
The existing in-flight review/approval poll also observes same-head closure.
It waits for active submission and retains completed-turn results while preventing
further analysis. Unattempted rounds use `review_target_closed`; attempted writes
retain the original publication fence and receipt.
Existing Calls and uncertain
resources are never released by closure alone. Merged-chain Hold/Resume writes
return 409 and the GUI retains History and read-only reconciliation. No new
endpoint, signal or journal event type is added; the Caller contract is in
[agent_interface](../caller/agent_interface/README.md#fencing-a-closed-behavior).
Poise's existing log decoder validates the fence's exact terminal no-effect
shape and native resource-release timestamp before the journal can settle its
reservation. Closed-target native resource waits are separate from public
GitHub recheck times; unrelated open-PR review/approval stays eligible.
Managed native admissions recheck the bounded receipt reader at their final
launch, action and publication boundaries. Its independent diagnostics retain
the first typed SQLite cause and affected workspace; confirmed integrity failure
persists the existing chain admission pause, including across an automatic v2
cutover. Health keeps its existing unknown
counters. Readability cannot clear that pause or missing original evidence. See
[receipt-store recovery](Operating.md#caller-receipt-store-recovery).

Native Caller receipts also carry append-only resource ownership outside
publication artifacts. Normal cleanup acknowledges pinned directory identities;
uncertain process/disk state retains its original reservation. The decoder and
journal-derived capacity reject contradictory release timestamps, including
historical contradictions on rebuild, without rewriting events. Capacity uses
an indexed derived pending-resource flag rather than scanning settled history.
Linux Stop pins a process handle before start/epoch verification and signals
only its original supervisor. Unsupported/older/unreadable identities refuse
signals; Chat Stop keeps its external runtime route. Epoch identity does not
use wall-clock ordering. Neither supervisor loss nor a container replacement
proves disk reclamation.

New physical v2 Calls require a namespace-capable Linux host. The existing
supervisor retains the original private procfs view before the original Call
permits execution. The whole Call runs inside that boundary: CLI preparation,
checkout/build/test/provider children, publication and fixed direct GitHub
actions. PID 1 reaps descendants; Caller continues as PID 2 with all capabilities
dropped and no-new-privileges preserved. Session changes, double forks and
nested PID namespaces do not escape the boundary. Original parent/holder loss
terminates the namespace. Neither init exit nor a queued kill proves settlement:
the retained original kernel view must positively become empty, including
unreaped entries, before normal pinned disk cleanup can acknowledge release.
The original Call, epoch, outer process identities and immutable action receipt
remain separate requirements. Missing witnesses or conflicting evidence retain
the reservation; the first positive settlement time is never refreshed.

The existing behavior request/tick performs a bounded internal capability
check, with at most one setup probe and no new timer. Cutover and native
admission require its positive result; Settings guards the controls and explains
unsupported or unavailable setups. An unsupported setup stays on v1. A v2 setup that
loses support pauses new admissions rather than reopening v1 ownership.
Mac development and default Docker security settings remain supported for v1;
this does not change the gateway's optional runtime setting or any production
configuration. The runtime image tests exercise actual runsc and default-Docker
profiles separately; stand-in providers are not real workflow acceptance.
The claimed recovery path below also reclaims new native checkout coordination
inside its owned root. Chat and unrelated Caller writers refuse those private
checkout paths; ordinary shared leases retain their existing protocol. Codex
issue/implementation and structured review histories use the same per-invocation
home, preserving sign-in and structured resume. Older shared state remains
retained and measured under the [storage retention policy](Operating.md#storage-maintenance).
Bounded Calls also carry immutable execution ceilings and a separate version-1
`resource_guard` receipt. Caller samples its original boundary off the service
event loop; a committed breach or stale measurement kills only its pinned holder
and holds the chain. This sampled guard neither grants deletion authority nor
replaces positive release proof. Unbounded/older Calls retain their prior path;
older readers hold a guarded possible-write failure instead of retrying it as
preflight work. [Accounting and limits](Behavior-chain.md) define coverage,
overshoot and the component bounds. Forced-container lifecycle proof and the
frozen real-provider campaign remain #806 obligations.
The stable metadata interface remains resource protocol 2. Physical setup also
requires the controller's `persistentCleanup: 1` feature and bounded admission
requires Caller's `resourceGuard: 1` capability. Older images cannot advertise
these guarantees; their v1 path stays available.

Claimed disk recovery uses the same original Call and supervisor directory
handles. A final unlink requires the original held directory's zero link count,
or an empty held directory whose kernel `getcwd` returns `ENOENT` after a
successful descriptor-based `chdir`. This handles persistent-home backends that
retain a link count of one after unlink; a literal ` (deleted)` name cannot
authorize release. The synchronous controller restores its pinned working
directory before another request runs. Handle closure follows this positive
proof; its first certificate survives a cleanup
worker's death before the Caller receipt commits. Private claim attempts never
enter journal evidence. A new container or lost supervisor without retained
positive proof leaves the disk and reservation held. Managed replacement gives
native cleanup its existing drain opportunity. A terminal Call with a recorded
cleanup failure and original process settlement can retain its disk and
reservation across replacement. Reclamation still requires the original
positive proof.
Before retrying registered child handles, each bounded cleanup pass commits
coverage from verified original reclaimed ancestors. Coverage also runs after
the pass's own reclamations, within the same 15-second budget. Later passes
skip committed coverage and preserve the first deletion certificates. Allocated
roots and unrelated siblings still require their own proof. Caller and Poise
bound the unchanged resource receipt format at 512 KiB so hundreds of children
can retain their paths, original errors and recovery evidence through release.
The same supervisor holds the original Caller metadata directory, database
and response-directory descriptors. Its private control configuration names
them; Caller and health/maintenance readers verify and use the held originals
after ancestor replacement. A mismatched reference fails closed. The cleanup
capability requires resource protocol 2 and these original metadata handles;
an older image remains on v1 until its runtime base is upgraded. Unsupported
metadata layouts also refuse v2 visibly while retaining v1's existing path.
After cleanup, the same maintenance opportunity reuses Caller's existing
selected-receipt reader to reconcile at most 16 pending admissions, including
held and merged chains. Its maintenance selection isolates unreadable rows by
exact correlation and reports their cause through storage diagnostics. An
unreadable or missing Call retains its reservation. See
[Caller's selected reads](../caller/agent_interface/README.md#incremental-log-reads).
`invocation.resources_reconciled` in the canonical
event log changes only physical resource evidence. It preserves the original
outcome, uncertainty, hold and merge evidence, starts no worker and repeats no
external action. A later enabled behavior tick separately decides any next work.

Fixed direct GitHub commands keep their original 30-second command deadline
(publication completion keeps 25 seconds). Their enclosing Caller execution
scope allows 60 seconds, and the outer client 120 seconds for interpreter/setup,
durable receipts and teardown. The kernel emptiness deadline remains two
seconds; these outer bounds do not extend the command or kernel deadlines.

Native merge-admission failures retain their bounded, redacted v1 diagnostic in
the original Call. Existing chain summaries and History expose that Call and
diagnostic so the browser can show its cause and next action. Positive refusal
evidence, unknown external outcomes and resource release remain separate; an
empty queue cannot authorize another enqueue. See
[native action receipts](Behavior-chain.md#native-action-receipts).
Conversation-resolution summaries also expose the original Call's validated
per-thread progress; partial progress retains the original action's uncertainty.

History response details distinguish typed ordinary Caller absence from a
promised response that is missing or unreadable. `/api/agent-response/CALL_ID`
returns `{id, disposition: "unavailable", reason}` for ordinary absence, keeping
it out of process Error; actual failures remain 502 and retain the exact Call ID
and reader purpose. Required content and native-action reads still reject absent
results, preserving receipt digests and publication/retry fences. The CLI's
response-read contract is in [agent_interface](../caller/agent_interface/README.md#reading-a-response).

Atomic provider deadlines propagate Caller's `atomic_work_execution_budget_exhausted`
code and existing v1 diagnostic into chain receipts and History. The unchanged
no-publication shape and retry requirements are defined in
[Behavior chain](Behavior-chain.md#authority-and-recovery).

Optional work-failure reporting uses the same chain reconciliation,
configured-account issue publisher and datastore intake. An explicit per-repository
opt-in enables verified repair incomplete-reply, repair execution-budget
or PR review timeout exhaustion, including retained legacy review/approval stops
from their existing reconciliation independently of model readiness or v2 mode,
verified automatic implementation holds before a PR and terminal repair holds
before publication,
terminal uncertain implementation publication,
open Poise seeds with a sole closed unmerged PR,
and terminal uncertain merge submissions, including
sources without an explicit hold, supplied by trusted service configuration or the
environment in local mode. Scope is rechecked after verification before reserving
creation intent and publishing; revocation during those reads leaves the creation
intent available.
Merge reports revalidate the open seed/PR, original pinned head and absent queue
entry after recovery, retaining the original invocation's uncertainty and ownership.
Implementation reports require the current automatic hold's settled blocked receipt,
positive resource release and fresh open-seed inspection proving no publication.
They retain the hold and distinguish worker-reported blockers from Caller diagnostic facts.
Their own implementation additionally requires an explicit disposition through
the existing guarded chain control, bound to the authenticated report, native
issue review, reviewed revision and original source hold/Call. Source-only and
missing or stale dispositions wait without starting report implementation;
a verified distinct-fix disposition retains ordinary admission gates, including
fresh source verification after preparation. Diagnosis and next action persist
on the held source through the existing report metadata and journal waits.
This adds no retry or checkout-retention authority; see
[report triage](Behavior-chain.md#reporting-verified-repair-exhaustion).
The existing linked remediation also exposes bounded private source evidence
from the original failed validation capture, retained through normal checkout
cleanup under the workspace's incident-artifact lifecycle. Only its availability
and capture identity enter receipts and reports; source bytes stay in the owning
workspace. [Caller's inspection contract](../caller/agent_interface/README.md#inspecting-failed-unpublished-source)
defines binding, access, limits and expiry without granting recovery authority.
Terminal repair reports require the matching automatic hold, settled original Call,
positive release and unchanged open PR head and repair basis, without possible
publication effects. They preserve repair ownership and exclude CI-only recovery holds.
Verified repair-exhaustion reports fence ordinary report implementation and can
hand a pinned actionable diagnosis to the source chain's existing exact-head
repair owner. The existing journal bounds that recovery to one admission without
resetting retries; original no-publication/resource receipts, the saved automatic
hold and unchanged source/diagnosis are rechecked. An already-admitted report's
original implementation must settle without publication before this handoff.
The original seed/branch, normal publication, review and CI gates remain in force;
missing evidence, changed heads and later operator holds retain the wait.
Uncertain implementation reports instead require the original failed `publishing`
Call, verified resource release and fresh open-source eligibility and publication
reconciliation. They preserve its missing-push-evidence action and execution fence,
reusing verified matching linked reports even when closed and markerless; they
authorize neither replacement implementation nor a second push.
Durable creation intent prevents another POST after an uncertain result; the source state,
label/intake blockers and generated-issue recursion boundary stay visible through
the existing `waiting` field. Closed-PR continuations verify existing source/PR
report links across causes and explicit manual successor relationships before
creation. Original uncertain receipts and resources retain their execution fence.
It adds no gateway route, scope, journal event,
settings default or admission bypass. See
[reporting verified repair exhaustion](Behavior-chain.md#reporting-verified-repair-exhaustion)
for configuration, evidence and pending live acceptance.

## Google document publishing

Google account grants belong to the gateway, partitioned by immutable GitHub
owner ID and Google subject. One deployment Google client redirects to the apex
`/auth/google/callback`. The secret and refresh tokens never enter user workspaces
or browser responses. [Google connections](Google-connections.md) defines the
operator configuration, encrypted vault, session-bound delegation, operation
deadlines, browser proof and migration limits.

- `GET /api/google/accounts` returns `{configured,accounts:[{id,email,connected,state}]}`.
- `POST /api/google/connect` accepts `{browserSecret,accountId?}` and returns the
  central browser start URL. Reconnect verifies the expected subject.
- `POST /api/google/callback` accepts `{state,browserSecret}` from the returning
  flow, consumes its staged result under the publication lock, and returns
  settings plus `{connection:{outcome,accountId?,message?}}`.
- `POST /api/google/disconnect` forgets `{accountId}`. `/config` returns 404;
  Google app configuration is deployment-owned.
- Browser assertions carry signed `sid`. The workspace guard strips the header
  and retains only verified delegation privately against that request. The fixed
  broker `POST /_gateway/google` admits an operation with `open`, then
  accepts purpose-limited `settings`, `begin`, `finish`, `token`, `disconnect`
  and `close`. Workspace calls use the verified TCP gateway peer and signed
  `gport` over the private network, addressed to the fixed internal gateway host;
  no public-apex egress or Docker DNS is needed. Its server-only credential has a fixed twenty-minute deadline;
  every action requires the exact original live login and current owner/access.
  This changes neither Link/admin scopes nor the ordinary sixty-second assertion
  lifetime. No browser cookie or arbitrary upstream URL reaches the broker.
- Local Poise uses operator environment configuration or existing private direct
  grants, the same account UI, and its loopback root callback. It retains the
  random browser-flow proof; it never requires a workspace cookie.
- `GET /api/editor/doc/:slug/google` returns local publication bindings. POST
  suffixes `/sync`, `/publish`, `/review` and `/import` read remote state, publish
  the specified `{accountId,localVersion}`, review that account's remote text,
  and import `{accountId,localVersion,remoteSha,fileId,connectionVersion}` respectively. A reviewed
  publish also supplies `fileId`, `connectionVersion` and `reviewedRemoteSha`,
  the exact remote raw-file hash
  shown by `/review`; a changed hash refuses the overwrite.

Imports check the reviewed local and remote versions and retain the old local
file. Publication requires an unchanged remote text baseline and a live Drive
v2 ETag, enforced by a conditional media PUT. Downloads check matching metadata
ETags before and after reading; the metadata validator cannot condition media GETs.
Import freezes document mutations before draining pending saves; queued saves
retain the version they were captured against. Provider comment tokens stay server-side; only comment text, author, quote,
resolution state and local offsets reach the browser. The Google metadata
round-trip and the API behavior are tested in `tests/google-*.test.ts`; browser
journeys are in `tests/e2e/google-publishing.spec.ts`. See
[Publishing](Publishing.md#google-docs) for setup and user behavior.

### Bound PR review observations

The workspace's bound-chat monitor reads local Caller `pr-reviews` pages; it
adds no GitHub requests. Each pass requests at most 200 reviews and 200 comment identities, returning
each represented thread's latest comment plus bounded raw-comment revision
summaries for edits to older comments. Content revisions participate in notice
identity even when IDs and review state stay unchanged. It persists independent cursors
and cycles back to observe
older updates and reopens. Per-identity seen state survives partial or failed
reads; page absence cannot establish resolution or completion. GitHub authors
identify accounts, not chats, so unproven same-account feedback remains
eligible. The local datastore currently supplies no per-chat origin receipt.
[Chat orchestration](Chat-orchestration.md#issue-and-pr-ownership) defines the
notification and ownership behavior.
