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
  - Each answers with the updated overview.
- Failures answer `{ error, message }` with their HTTP status.
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
  | `scope` | `browser`, `link` or `admin` |
  | `iat`, `exp` | seconds; `exp` is `iat + 60` |
  | `jti` | random, unique per assertion |

- The gateway generates its key pair on first start and keeps it in its data
  volume. Workspaces receive the public key as `POISE_GATEWAY_PUBLIC_KEY`, the
  SPKI PEM encoded as single-line base64.
- A workspace accepts an assertion when the signature verifies, `iss` and `aud`
  match, `sub` equals `POISE_WORKSPACE_OWNER` (case-insensitive), `iat` is at
  most 5 seconds in the future, `exp` has not passed (5 seconds of skew), and
  `exp - iat` is at most 120.
- Scopes:
  - `browser`: the owner's browser; every route.
  - `link`: a paired Poise Link device; only `/api/link/*`.
  - `admin`: the gateway itself; only `/api/service/*`.
- The gateway also sets `X-Forwarded-For`, `X-Forwarded-Proto: https` and
  `X-Forwarded-Host`, and keeps the browser's `Host` and `Origin` headers. It
  forwards no `Cookie` header at all: neither its own cookies (`poise_gw`,
  `poise_ws`, `poise_bind`, `poise_oauth`) nor any other the browser sends,
  such as a login cookie that a parent domain shares with every host below
  it. Nor does it forward a device token's `Authorization` header.
- Workspaces cannot set cookies: the gateway drops every `Set-Cookie` from
  their responses. An answer with a status outside 100–599 becomes a 502.
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
| `POISE_PUBLIC_ORIGIN` | `https://<handle>.<POISE_DOMAIN>` |
| `POISE_GATEWAY_PUBLIC_KEY` | see above |
| `POISE_HOST` | `0.0.0.0` |
| `POISE_PORT` | `5555` |
| `HOME` | `/home/poise` |
| `POISE_DRAIN_TIMEOUT` | the gateway's own `POISE_DRAIN_TIMEOUT`, in seconds (default 5400), so both sides time a drain alike |
| `POISE_SKIP_CLI_BOOTSTRAP` | `1`, only when the gateway's `POISE_WORKSPACE_SKIP_CLI_BOOTSTRAP` is `1` (end-to-end tests); otherwise unset |

A workspace container created with another `POISE_DRAIN_TIMEOUT` than the
gateway's, or with none, is recreated as one on an outdated image is: drained
first if it runs ([Deployment](#deployment)).

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
off. Agent calls (behavior runs, manual reviews, replays) are processes Poise
starts detached; they keep running while Poise restarts, and the next Poise
reconciles them as after any restart.

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
  the supervisor). Poise writes `next`, stops admitting new background ticks,
  and restarts at the first moment no Chat turn and no work of its own runs;
  it waits for no agent call. The gateway asks again on later passes until
  health reports the release, which the request makes idempotent.
- **Meanwhile.** While the workspace restarts, the gateway answers for it
  with `x-poise-updating: 1`: "Updating to the latest version" for a page, 503
  `workspace_updating` for anything else. Poise dims the open page with the
  same notice and reloads it once Poise answers again (`src/updating.ts`).
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

**Storage.** Everything lives under `~/.poise` in the home volume:
- Chat workspaces in `~/.poise/chat` (`POISE_CHAT_ROOT`).
- Snippets in `~/.poise/snippets/poise.yml`.
- Caller's data in `~/.poise/agent-interface` (`AGENT_INTERFACE_DATA_DIR`).
- Caller itself runs from the image: its CLIs from `CALLER_BIN_ROOT`,
  `agent-interface` in `AGENT_INTERFACE_ROOT`.

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
  runningCallerCalls, backgroundWork, idle, draining, release, switching }`. `idle` is true only
  when `activeChatTurns`, `runningCallerCalls` and `backgroundWork` are all 0.
  It backs the container health check and the gateway's readiness check.
  - `version` is the commit the running bundle was built from, `null` for a
    development build.
  - `release` is the installed release the supervisor started this server on
    ([Updates in place](#updates-in-place)), `null` without one.
  - `switching` is the release a pending switch restarts this server onto,
    `null` when none is pending. Asking to switch to the release it runs calls
    a pending switch off; the gateway does so when the target changes back.
  - `activeChatTurns` counts the Chat turns recorded open: reserved before
    their first write, closed once their outcome is recorded.
  - `runningCallerCalls` counts the Caller processes Poise launched for agent
    work (behavior runs, manual reviews and replays, card chats, `/content`)
    that it has not seen exit, plus `/consensus` debates still running, or,
    when more, the calls Caller records as running with their process alive,
    which include those an earlier release started.
  - `backgroundWork` counts everything else a restart would cut: the Chat
    runtime's startups, operations and agent processes, process-owned
    background work (behavior ticks, provider CLI updates, the model check),
    and launches from the browser admitted and still in their handler.
- `POST /api/service/drain` stops admitting new Chat turns and behavior
  launches, then returns the same fields. A drain lapses unless it is renewed:
  while the gateway polls health it re-POSTs `/api/service/drain` at least
  every 5 minutes. It recreates the container once `idle` is true or
  `POISE_DRAIN_TIMEOUT` seconds (default 5400, 90 minutes: longer than an
  issue review may run, so it should cut only a hung call) have passed.
  - New Chat turns include queued messages, and launches include the
    browser's (`/api/pr-review`, `/api/agent-replay`, `/api/chat-content`,
    `/api/debate`, `/api/chat`, `/api/models/refresh`). Refused work answers
    503 with code `draining`; work already running continues.
  - The workspace lets a drain lapse `POISE_DRAIN_TIMEOUT` seconds (default
    5400) plus five minutes after the last drain call, so a gateway that
    stopped renewing it cannot leave the workspace refusing work.
- `POST /api/service/resume` lifts a drain. The owner's browser may call it
  too, to lift a drain a gateway left behind.

## Accounts, identities and the terminal

**Identities are user-level settings.** Settings → GitHub holds two accounts:
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
- `GET /api/accounts` returns `{ accounts }`, one entry per CLI in that order.
  Each entry is `{ id, installed, version, signedIn: true | false | null,
  identity, detail, login: { label } }`; gh's also has `accounts: [{ login,
  active, signedIn, detail }]`, every account gh holds for github.com.
  - Each CLI's own status command answers, never its credential files:
    `claude auth status --json` through Poise's Claude wrapper (signed in
    means a Claude subscription), `codex login status`, and `gh auth status
    --json hosts --hostname github.com` with no token from the environment.
    Grok, Muse and Antigravity have no status command: their `signedIn` is
    `null` and `detail` says so.
  - `identity` is the account name the status command prints (Claude's email,
    gh's active login); no token, key or organisation id is returned.
  - The gh row marks the person's own account and the agent account among
    gh's accounts and says when either is not signed in to gh.
  - Each command has 10 seconds. Answers are kept for 15 seconds and dropped
    whenever a terminal exits.
  - Every read records sign-in alerts (`sign_in_needed`): one for an
    installed CLI that says it is not signed in, and one each for the
    person's own account and the agent account while gh does not hold it
    signed in. Each clears once signed in again; Claude's alert stays its
    auth monitor's. In service mode Poise also reads the accounts every 15
    minutes, so the alerts come while the browser is closed. They open
    `/?settings=accounts`, Settings → Accounts.
- Connect opens a terminal in the browser, inside the workspace, running that
  CLI's own login (`login.label`):

  | CLI | Login command |
  | --- | --- |
  | Claude | `auth login --claudeai` through Poise's Claude wrapper |
  | Codex | `codex login --device-auth` |
  | gh | `gh auth login --hostname github.com --git-protocol https --web` |
  | Grok | `grok login --device-auth` |
  | Muse | `muse login` |
  | Antigravity | `agy`, which has no login subcommand: it opens its sign-in screen when it starts signed out |

  Credentials go straight from the CLI to its own files; Poise never reads them.
- `/ws/terminal?preset=<id>|shell` is browser scope only.
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

**Repository opt-out.** Review new PRs, Approve PRs and Resolve unblocking
each have a "Skip repositories" list:
- The list is chosen from all repositories of the person's ready accounts.
- The picker groups repositories by account and offers "Select all" for each
  group and overall.
- The scheduler never launches work for a skipped repository.

Review New Issues stays opt-in.

**Replay checks.** A replay from Swarm passes the same eligibility checks the
scheduler applies, or it is refused with HTTP 409 and the failed check named:
- **Issue review:** the repository is opted in, the issue is open, and its
  author is a trusted author.
- **PR review and approval:** the pull request is open, is not a draft, is
  authored by the person's own GitHub account, and is not in a skipped
  repository.

The facts are read fresh from the datastore the scheduler reads; when they
cannot be read the replay answers 502 and launches nothing. Swarm shows a
refusal under the row whose Replay was pressed.

## Snippets and Poise Link

**Snippets are edited only in Poise:** the Snippets view, Chat's `/create`, and
the Editor's "save selection as snippet". The desktop copy is generated.
Snippets view → Import takes an Espanso YAML file once and adds its simple
trigger/replace pairs, reporting any it skipped. In a workspace the Snippets
view says, from the devices answer, whether Poise Link is connected, so whether
a change reaches the desktop now or once Poise Link runs there.

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

**Alerts** are recorded by the workspace and kept for 30 days. Each condition
alerts once, and again only after it has cleared:
- a Claude or other provider sign-in is needed, or the person's own GitHub
  account or the agent account is not signed in to gh;
- a behavior failed and is held;
- datastore sync has been failing for 15 minutes;
- a Chat agent is waiting for a permission or an answer;
- a Chat turn that ran longer than two minutes has finished.

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
whose `POISE_DRAIN_TIMEOUT` differs from its own, keeping its volume.

**Provider CLIs** are installed into each person's home volume on first start
and update themselves there, as Poise already does before each launch. The
image carries everything else: Node 22, Python 3.13, Caller, `gh`, `git`,
build tools and `tini`.
