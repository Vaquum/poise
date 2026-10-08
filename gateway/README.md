# Poise gateway

The gateway is the one public entry point of a Poise service. It signs people in with GitHub, routes each workspace host to its owner's container, attaches a signed identity assertion to everything it forwards, pairs Poise Link devices, and creates, starts and upgrades workspace containers through the Docker Engine API.

[docs/Service-architecture.md](../docs/Service-architecture.md) is the contract it implements: addresses, sessions, the assertion format, the workspace runtime and device pairing are specified there and not repeated here.

It is a standalone Node 22 TypeScript service built on `node:http` and `node:crypto`, with `better-sqlite3` for state.

## Configuration

Everything comes from the environment and is validated at startup. Every problem is reported at once and the process exits with status 1.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `POISE_DOMAIN` | yes | | Apex host name with at least two labels, for example `poise.example.com` or `poise.localhost` |
| `POISE_GITHUB_CLIENT_ID` | yes | | GitHub OAuth App client ID |
| `POISE_GITHUB_CLIENT_SECRET` | yes | | GitHub OAuth App client secret |
| `POISE_ADMINS` | yes | | GitHub logins that may open `/admin`; admins may always sign in |
| `POISE_ALLOWED_USERS` | | | Logins seeded into the allow list |
| `POISE_ALLOWED_ORGS` | | | Organisations whose active members may sign in; adds the `read:org` scope |
| `POISE_RUNTIME_IMAGE` | yes | | Workspace image, for example `poise-runtime:latest` |
| `POISE_GATEWAY_CONTAINER` | yes | | The gateway's own container name, so it can join workspace networks |
| `POISE_WORKSPACE_MEMORY` | | `8g` | Memory limit per workspace (`b`, `k`, `m`, `g`) |
| `POISE_WORKSPACE_CPUS` | | `4` | CPU limit per workspace |
| `POISE_WORKSPACE_PIDS` | | `4096` | Process limit per workspace |
| `POISE_WORKSPACE_RUNTIME` | | | OCI runtime for workspaces, for example `runsc` |
| `POISE_WORKSPACE_DNS` | | | One to three resolver IP addresses the workspaces use instead of Docker's embedded DNS, which gVisor cannot reach; required with `runsc`. The gateway writes them to `workspace-resolv.conf` in its data directory and mounts that file read-only over each workspace's `/etc/resolv.conf`, so the data directory must be a mount when the gateway runs in a container |
| `POISE_WORKSPACE_SKIP_CLI_BOOTSTRAP` | | | `1` passes `POISE_SKIP_CLI_BOOTSTRAP=1` to new workspaces, so they install no provider CLIs; for end-to-end tests, which need no CLIs |
| `POISE_DRAIN_TIMEOUT` | | `1800` | Seconds to wait for a workspace to go idle before it is recreated, at most `604800` (a week); passed to every workspace, and a workspace created with another value is recreated, drained, like one on an outdated image |
| `POISE_GATEWAY_DATA` | | `/data` | Data directory |
| `POISE_DOCKER_SOCKET` | | `/var/run/docker.sock` | Docker Engine socket |
| `PORT` | | `8080` | Listening port |
| `POISE_PROXY_LISTEN` | | | The address a proxy the server already runs reaches the gateway at, which `deploy/compose.proxy.yaml` publishes it on: one IP address and port such as `127.0.0.1:8080` or `[::1]:8080`, never `0.0.0.0` or `[::]`. The TLS ask is answered there too |
| `POISE_GITHUB_URL` | | `https://github.com` | GitHub web origin; tests point it at a fake |
| `POISE_GITHUB_API_URL` | | `https://api.github.com` | GitHub API origin; tests point it at a fake |
| `POISE_INSECURE_HTTP` | | | `1` serves plain http for local and CI end-to-end runs; refused unless the domain is `*.localhost` or `*.test` |

The GitHub OAuth App's callback URL is `https://<POISE_DOMAIN>/auth/callback`.

## Routes

On the apex:

| Path | Purpose |
| --- | --- |
| `/` | Sign-in page, or links to your workspace, devices and admin |
| `/auth/login`, `/auth/callback`, `/auth/logout` | GitHub sign-in and sign-out; `/auth/login?next=` accepts an apex path or a URL on a workspace host |
| `/link` | Approve or deny a Poise Link user code (at most 10 tries per session in 15 minutes) |
| `/link/devices` | List and revoke paired devices |
| `POST /link/device/code`, `POST /link/device/token` | Device authorization for Poise Link |
| `/admin` | Users with their access, workspace state and image; allowed logins; start, stop and restart a workspace; disable or enable a person |

On a workspace host, `/_poise/session` redeems a sign-in ticket and `/_poise/logout` signs out of the workspace and the apex together. Everything else is proxied to the owner's workspace. While it starts, navigations get a page that reloads every two seconds and other requests get `503` JSON.

`GET /_gateway/tls-ask?domain=` answers Caddy's on-demand TLS question, or that of the server's own proxy. It is served only to requests addressed to `gateway:<PORT>` or to `POISE_PROXY_LISTEN`, so the public cannot use it to list handles.

## Security properties

- A ticket redeems only in the browser it was minted for, through the `poise_bind` cookie the apex sets for the whole domain.
- No cookie reaches a workspace, neither the gateway's own nor any other the browser sends, such as a login cookie a parent domain shares with every host below it. A workspace cannot set cookies either: `Set-Cookie` is dropped from every proxied answer.
- A body on `GET`, `HEAD`, `OPTIONS`, `DELETE` or `TRACE` is refused with 400, and forwarded bodies are always framed, so nothing can be smuggled to a workspace as a second request.
- A workspace answer the gateway cannot relay, such as a status outside 100–599, becomes a 502 for that request alone.
- A device token stops working after 30 days without use or 365 days after pairing, and Poise Link pairs again.
- Every unusable device token gets 401 with a JSON reason (`device_unknown`, `device_revoked`, `device_expired`, `user_disabled` or `access_removed`), never a 403 or a redirect, because Poise Link treats any 401 as "sign out and pair again".
- A disabled person is cut off at once: every session ends, every device is revoked, sign-in is refused and the workspace stops. Organisation membership is verified at each sign-in, so disabling is how an admin cuts off an organisation member before then.

## State

`POISE_GATEWAY_DATA` holds:

- `gateway.db`: users, the allow list, sessions, tickets, OAuth states, device codes, devices and workspace records. Session ids, tickets, binding values, OAuth states, device codes and device tokens are stored as SHA-256 hashes only. GitHub tokens are never stored.
- `identity-ed25519.pem`: the assertion signing key, generated on first start with mode `0600` and linked into place whole, so concurrent starts agree on one key. The gateway refuses to start if others can read it.

A handle stays bound to the GitHub account id that first signed in with it, so a renamed-and-reused login cannot take over an existing workspace.

## Logs

One JSON object per line on standard output, with an `event` name. Every container lifecycle step is logged (`workspace.volume.created`, `workspace.container.started`, `workspace.upgrade.finished` and so on), as are sign-ins, refusals, device pairing and admin actions. Query strings are never logged, because they can carry sign-in tickets.

## Container

The gateway drives the Docker Engine through its mounted socket and joins each workspace network: all of them when it starts, before it answers, because a recreated container is on none of them, and any one it is not on before it calls that workspace. The socket is root-equivalent on the host whatever user the process runs as, so the image does not switch to an unprivileged user. Build it with `docker build gateway/`.

## Development

Use Node 22:

```sh
cd gateway
npm ci
npm run typecheck
npm test
npm run build
```

The tests run in-process with no Docker: a fake GitHub, a fake Docker Engine API on a unix socket, and a real upstream that echoes HTTP and WebSocket traffic. The one exception is `tests/docker.integration.test.ts`. With `POISE_GATEWAY_DOCKER_TESTS=1` it creates and reaches a workspace on the local Docker Engine, recreates the gateway's container, which must join the workspace's network again to drain it before an upgrade, and recreates the workspace for a new drain timeout. CI runs it after building the image; otherwise it is skipped.
