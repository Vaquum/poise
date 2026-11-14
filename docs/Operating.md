# Operating Poise

Open Menu → Logging to investigate retained diagnostics; Export NDJSON downloads
a fresh bounded snapshot of the applied filters. Diagnostic HTTP reads are for
the owner's same-origin workspace page. Typing or
bookmarking an export endpoint is refused by the existing browser guards; an
operator without that page uses the operator command documented in Logging.
The page's authenticated `/_poise/api/logging/export` request returns bounded
NDJSON with `truncated` and `resumeCursor` in its metadata line. Continuing an
export requires the same filters and that opaque cursor. `scope=instance` is
an explicit administrator choice. Local installations use `/api/logging/export`
under the local loopback rules; no browser session token is needed there.
See [Logging](Logging.md) for access, retention, filters and query budgets.
For an external Caddy proxy, install the optional
[bounded diagnostic reader](../deploy/ingress/README.md) on its operator-owned
Docker host to connect the external ingress source with expiring health.

## Main-thread stalls

`GET /api/health/stalls` reports, from memory and with no I/O, where the
server's main thread has stalled since it started (`server/stall-observer.ts`):
- garbage-collection pauses;
- SQLite calls of 50 ms or more, with SQL literals masked and the three frames
  that made the call, including each transaction's `BEGIN` and `COMMIT`;
- how long a trivial file read waited for the file-I/O threads, probed every
  2 s;
- the event loop's delay and the process's memory.

Nothing triggers, writes or exports anything; it is always on, and its cost is
two clock reads per SQLite call.

## Bounded CPU capture

The direct service-mode production server accepts at most one operator-requested
15-second CPU capture during its lifetime. It opens no debugger listener and
does not enable SIGUSR1 inspection. There is no HTTP trigger or environment
override for duration, output or commands. This is an optional diagnostic,
not a responsiveness fix or an unlimited-load acceptance test.
Environment-supplied service mode installs the handler before dotenv loading;
mode supplied by a secured `.env` installs it immediately after validation,
before logging/runtime startup. Neither path is ready for an operator signal
until its process-specific availability record exists.

Before sending any signal, complete this preflight in the workspace's PID
namespace:

1. Identify the **Node application PID**, its `/proc/<pid>/stat` start ticks,
   executable, supervisor parent and running command. Never signal PID 1,
   `tini`, a launcher/supervisor, a process group or an older release. Never use
   `docker kill --signal=USR2`: that targets the container's init and can stop
   the workspace and its agents.
2. Read normal authenticated service health. Bind its compiled `version` and
   active `release` to the running bundle containing this handler; require no
   pending release switch. A checkout HEAD, installed/desired release, image
   label or successful Deploy job alone does not establish the running code.
3. Find that process's startup `CPU capture availability` record. Require
   `available:true` and matching PID, start ticks, build SHA and release.
   Independently check the effective Node arguments and inherited
   `NODE_OPTIONS` for native diagnostic signal flags without exporting the
   environment. Capture refuses signal-report/heap options, including
   ambiguous or overridden spellings, and `process.report.reportOnSignal`.
   The supported server does not mutate that report setting after startup;
   if the effective configuration cannot be established, stop. A JS refusal
   **cannot prevent** an already-enabled native report or heap handler from
   writing sensitive data when SIGUSR2 arrives.
4. Require the caught-signal bit `SigCgt & 0x800` in `/proc/<pid>/status` and
   no existing `~/.poise/diagnostics/cpu-profile.json`. Preserve any prior
   artifact before a separately authorized later process/attempt. Recheck
   PID/start identity and active release immediately before delivering
   **SIGUSR2 only to that application PID**. An old server without this
   handler can terminate on SIGUSR2.

Choose a naturally busy Chat or Caller phase with contemporaneous loop-delay
evidence; do not create production agent load for a capture. Separately retain
native host CPU/I/O pressure, cgroup limits/counters, actual workload phases
and client vantage for the same window. The artifact reads only fixed
namespace-local `cpu.stat` and `cpu.pressure` paths; unavailable sources are
explicit, and these are not necessarily host-wide measurements. A failed,
interrupted, oversized or uninformative attempt does not re-arm the process
or authorize a retry. Duplicate signals produce only one refusal log and the
handler remains installed after completion, failure and shutdown.

The fixed output is `~/.poise/diagnostics/cpu-profile.json`: an envelope with
`metadata` and `profile`. Directory mode is 0700 and file mode 0600. These
exclude other UIDs, not agent processes sharing the server's UID. Do not post
profile frames, environment/argument dumps or the artifact in GitHub. Extract
the `profile` member privately as JSON to a `.cpuprofile` file for a CPU-profile
viewer; an oversize envelope has `profile:null` and cannot be opened as one.

Publication uses exclusive staging, file sync, an atomic non-replacing link
and directory sync. Existing output is preserved. The persisted UTF-8 cap is
64 MiB, including metadata; this is not a peak serialization-memory cap.
Oversize captures publish valid metadata only. Disk/write/sync failures name
the failure and clean owned staging files; a full disk cannot guarantee a
fallback artifact. A directory-sync failure after the atomic commit retains
the complete artifact but does not promise durability. Cancellation before
commit prevents publication; an already committed artifact is retained.

Capture-only metadata records UTC/monotonic phase timestamps, actual duration,
start/stop wait and serialization costs, V8 profile times in microseconds,
sample count/mean interval and gaps over 100 ms. **Gaps are unattributed**:
weighting one by an adjacent frame does not prove CPU self-time or distinguish
scheduler pressure from a synchronous wait. Dedicated loop statistics report
their sample count and coverage; zero samples means insufficient coverage.
CPU/resource deltas include worker threads; ELU measures the main isolate.
`persistenceStarted` precedes output I/O; the bounded completion log
records publication completion time. Start/stop/setup/persistence overhead is
separate from workload evidence. A quiet or incomplete capture cannot explain
an earlier stall. Shutdown promptly abandons diagnostics, preserves normal
exit codes and never holds the quiet release gate for the remaining 15 seconds.

This guide runs Poise as a service on one Linux server, for yourself and a
few colleagues. Each person signs in with GitHub at one address and gets
their own workspace: their own Poise, agent CLIs, GitHub accounts and data,
in a container of their own. [Service architecture](Service-architecture.md)
describes how the parts fit together.

Setting up takes four steps: point DNS at the server, create a GitHub OAuth
App, fill in `deploy/.env`, and run `deploy/install.sh`. Upgrading is
`deploy/upgrade.sh`. On a server whose web server already holds ports 80 and
443, Poise runs behind it instead (see
[Behind your own proxy](#behind-your-own-proxy)). A fork of this repository
can do the installing and upgrading itself from GitHub Actions (see
[Run your own Poise from a fork](#run-your-own-poise-from-a-fork)).

## What runs

`deploy/compose.yaml` runs two containers with Docker Compose:

- **`poise-caddy`** ([Caddy](https://caddyserver.com/)) listens on ports 80
  and 443, holds the TLS certificates and passes every request to the
  gateway.
- **`poise-gateway`** signs people in, routes each workspace host to its
  owner's workspace, and creates, starts and upgrades the workspace
  containers itself through the Docker socket.

Behind a proxy the server already runs, the gateway runs alone and that
proxy does Caddy's part.

Each person's workspace is a container named `poise-ws-<handle>`, where the
handle is their GitHub login in lower case. Their home folder is the volume
`poise-home-<handle>`, so their data and signed-in CLIs outlive the
container. The gateway keeps its own state (people, sessions, devices, its
signing key) in the volume `poise-gateway-data`.

## The server

- 64-bit Linux with Docker Engine 24 or newer and its Compose plugin
  ([install Docker](https://docs.docker.com/engine/install/)), and `git`.
  The deployment is tested on Ubuntu on x86-64.
- For gVisor deployments, Python 3.10+, systemd and root or passwordless sudo
  on the host to install the Caller guard.
- Ports 80 and 443 reachable from the internet, and nothing else listening on
  them, or a proxy already on them that will front Poise too
  ([Behind your own proxy](#behind-your-own-proxy)).
- A domain whose DNS you control.

Size it for what agents do: they check out repositories, build them and run
their test suites, often for several people at once, unless the suites run
elsewhere ([Agents' test suites](#agents-test-suites)). Each workspace may use
up to 8 GB of memory and 4 CPUs by default (`POISE_WORKSPACE_MEMORY`,
`POISE_WORKSPACE_CPUS`); those are limits, not reservations. For three to
five people, start with:

- **CPU**: 8 cores. Builds and test suites are CPU-bound, and two people's
  agents often run at the same time.
- **Memory**: 16 GB, 32 GB if agents work on large codebases. An agent CLI
  and a test run each take several hundred megabytes to a few gigabytes.
- **Disk**: 150 GB of SSD. Each home volume holds about 1 GB of provider
  CLIs plus the repositories its agents check out; review checkouts are
  removed a day after their last use. The workspace image is about 1 GB; each
  upgrade keeps the previous one and at most 5 GB of build cache, and removes
  the rest ([Upgrades](#upgrades)).

Run the scripts as a user who owns the checkout and may use Docker (root, or
a member of the `docker` group).

## 1. DNS

Point two records at the server's public address: the apex you choose and a
wildcard below it. Use A records for IPv4 and AAAA records for IPv6, and add
AAAA records only if the server is reachable over IPv6.

| Name | Type | Value |
| --- | --- | --- |
| `poise.example.com` | A / AAAA | the server's address |
| `*.poise.example.com` | A / AAAA | the server's address |

People sign in at `https://poise.example.com/`. Alice, whose GitHub login is
`Alice`, works at `https://alice.poise.example.com/`. Caddy obtains the
apex's certificate from Let's Encrypt as soon as the name reaches the server,
and each workspace host's certificate on its first visit, after the gateway
confirms that the host belongs to someone who has signed in. Names that
belong to nobody never get a certificate.

## 2. The GitHub OAuth App

People sign in through a GitHub OAuth App that you own. Create it under your
account (GitHub → Settings → Developer settings → OAuth Apps → New OAuth App)
or under an organization's settings:

| Field | Value |
| --- | --- |
| Application name | Anything people will recognise, such as `Poise` |
| Homepage URL | `https://poise.example.com` |
| Authorization callback URL | `https://poise.example.com/auth/callback`, exactly |
| Enable Device Flow | Off |

Register it, choose **Generate a new client secret**, and keep the client ID
and the secret for the next step.

At sign-in the gateway asks GitHub for the `read:user` scope, and also for
`read:org` when `POISE_ALLOWED_ORGS` is set. It reads the person's login and,
for organisation access, their membership, and then discards the GitHub
token; it never stores one. An organisation that restricts OAuth App access
must approve the app before its members can sign in through
`POISE_ALLOWED_ORGS`; until then the sign-in page says GitHub did not share
the membership.

## 3. Settings

Clone the repository onto the server, for example to `/srv/poise`, with
credentials that can read it (a deploy key or a token), and create the
settings file from its template:

```bash
git clone https://github.com/autonomio/poise.git /srv/poise
cd /srv/poise
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
```

Fill in `deploy/.env`. [`deploy/.env.example`](../deploy/.env.example)
describes every setting with an example. These are required:

| Setting | Value |
| --- | --- |
| `POISE_DOMAIN` | The apex, for example `poise.example.com` |
| `POISE_GITHUB_CLIENT_ID` | The OAuth App's client ID |
| `POISE_GITHUB_CLIENT_SECRET` | The OAuth App's client secret |
| `POISE_GOOGLE_CLIENT_ID`, `POISE_GOOGLE_CLIENT_SECRET` | Optional Google client pair, configured once; [Google connections](Google-connections.md#operator-configuration) |
| `POISE_ADMINS` | GitHub logins that administer this Poise, separated by commas |
| `POISE_ACME_EMAIL` | The address Let's Encrypt writes to about certificates; not needed behind your own proxy |

`POISE_ALLOWED_USERS` and `POISE_ALLOWED_ORGS` decide who else may sign in
(see [People](#people)). The workspace limits, the drain timeout and the
optional gVisor runtime are described in the template and under
[Security](#security).

The file holds the OAuth App's client secret: keep it readable by its owner
only. The scripts refuse to run otherwise.

## 4. Install

```bash
deploy/install.sh
```

It checks Docker, the ports and `deploy/.env`, and stops with a message that
names the problem if something is missing. Then it builds the workspace image
`poise-runtime:latest` (several minutes the first time), starts Caddy and the
gateway, waits for the gateway to answer, and prints what is left to do: the
DNS records, the OAuth App's callback URL, the admin sign-in and Poise Link.

The image is also tagged with the commit it was built from, such as
`poise-runtime:0fcf84e…`, and each workspace reports that commit as `version`
at `/api/service/health`. A checkout with uncommitted changes builds a
development image, which reports no version; the script says so.

Run `deploy/install.sh` again after any change to `deploy/.env`: Compose
recreates the gateway with the new settings.

## 5. The first sign-in

Open `https://poise.example.com/` and sign in with GitHub as one of the
`POISE_ADMINS`. GitHub asks once whether to authorize the OAuth App. The home
page then opens your workspace, where first-run setup takes you step by step
through the theme, your GitHub account, the agent account, organizations, time,
the AI accounts, models and pairing this computer with Poise Link (see
[First-run setup](Service-architecture.md#first-run-setup)). In the workspace,
Settings → Admin lists
everyone who has signed in, how they got access, and their workspace's state
and image, and lets you start, stop or restart a workspace, disable or enable a
person, and change who may sign in. The same controls stay at
`https://poise.example.com/admin` for when your own workspace cannot open; its
starting page links there when a start failed.

## Behind your own proxy

For repeatable public deployment descriptions and OAuth policy pages, use the
gateway's [operator-approved public pages](Public-pages.md). They use the current
deployment domain and persisted operator content, including behind an external proxy.

When the server already runs a web server or reverse proxy on ports 80 and
443, such as a Caddy or nginx serving other sites, Poise runs behind it
instead of with a Caddy of its own. Set `POISE_PROXY_LISTEN` in
`deploy/.env` to the address that proxy will reach the gateway at, and run
`deploy/install.sh`:

```bash
POISE_PROXY_LISTEN=127.0.0.1:8080
```

The installation then runs the gateway alone, removes a Caddy it ran before,
and publishes the gateway, over plain http, on that one address. Choose one
only the proxy can reach: `127.0.0.1` when the proxy runs on the same host,
or the private address it reaches this server at, such as a virtual
machine's address on its host's internal network. `0.0.0.0` and `[::]` are
refused, because they would publish the gateway on every address.
`POISE_ACME_EMAIL` is not needed: the proxy holds the certificates.

Your proxy must:

- send every request for `poise.example.com` and `*.poise.example.com`, and
  for no other name, to `http://<POISE_PROXY_LISTEN>`, with the browser's
  `Host` header;
- pass WebSockets through, put no time limit on a response, and accept
  request bodies of up to 32 MiB: event streams, Chat's WebSocket and
  terminals stay open for as long as people use them;
- retry a connection failure (no listener while the gateway is replaced) for
  30 seconds before it answers 502, so a replacement reads as a brief delay;
- set `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` from what
  it saw itself, never from what the client sent; Caddy does unless told to
  trust another proxy;
- serve a certificate for the apex and one for each workspace host: either a
  wildcard certificate for `*.poise.example.com`, or each host's on demand.
  For on-demand certificates it asks the gateway first,
  `GET http://<POISE_PROXY_LISTEN>/_gateway/tls-ask?domain=<host>`, which
  answers 200 only for the apex and the hosts of people who have signed in.
  The gateway answers that question only for requests addressed to
  `POISE_PROXY_LISTEN`, which is why the proxy must never pass that name on.

A proxy that signs people in itself, as a portal does, should keep that
sign-in alive while it is used. Once the sign-in has ended, it should answer
an open page's requests, those that are not page navigations, with 401 rather
than a redirect to its login page. Poise notices either: it says "Your
sign-in has ended" and offers Sign in again, which reloads the page through
the proxy's login.

Such a proxy also stands between a phone and its sign-in by QR code (Settings
→ Accounts → Sign in on your phone). It must let `GET /auth/phone` on the apex
through without its own login. It must also give the phone the owner approved
a session of its own, or the phone stops at the proxy's login.
[Sign in on a phone](Service-architecture.md#sign-in-and-sessions) says how a
proxy can recognise both the approval and the phone.

With Caddy, for a gateway on `127.0.0.1:8080`:

```caddyfile
{
	on_demand_tls {
		ask http://127.0.0.1:8080/_gateway/tls-ask
	}
}

poise.example.com {
	reverse_proxy 127.0.0.1:8080 {
		lb_try_duration 30s
		lb_try_interval 100ms
	}
}

*.poise.example.com {
	tls {
		on_demand
	}
	reverse_proxy 127.0.0.1:8080 {
		lb_try_duration 30s
		lb_try_interval 100ms
	}
}
```

Apply the retry window to every handler that reaches the gateway, including
separate Poise Link and authenticated routes. Leave `lb_retry_match` unset:
Caddy can retry any method after a failed dial, but its default only retries
GET after a connected request fails. A dispatched mutation with an unknown
outcome must not be replayed. Genuine upstream HTTP 502 responses and connection
failures that exhaust the 30-second window remain visible.

Validate and reload the operator-owned Caddy, then inspect its private admin
API (`GET /config/`) to confirm every gateway handler has the retry window.
`deploy/upgrade.sh` reloads only the bundled Caddy. For replacement proof,
record the old and new gateway container IDs, start public requests while the
gateway listener is absent, and wait for their completed results through the
successor. Include a POST handled exactly once; readiness alone is insufficient.
The deployment test runs on an isolated Docker Engine with
`"userland-proxy": false`, so the published port refuses dials until the gateway
listens. Docker's userspace proxy can accept a connection during startup and
then reset it before the gateway listens. Caddy treats that reset as a
connected failure and returns 502 for a POST whose delivery it cannot verify.

Point the DNS records at the proxy. The OAuth App and everything after it
are the same as above.

**A sign-in of the proxy's own.** A proxy may ask for a sign-in of its own
before it passes a request on, as a company portal does. Poise Link cannot
answer one, so let these requests through without it; the gateway checks
each against the device's token itself:

- `POST /link/device/code` and `POST /link/device/token` on the apex;
- every path under `/api/link/` on the workspace hosts.

**A parent domain shared with other services.** When `POISE_DOMAIN` is under
a domain other services use, such as `poise.example.com` beside a portal at
`portal.example.com`, the browser also sends the gateway every cookie set
for the whole of `example.com`, the portal's login among them. The gateway
forwards no cookie to a workspace, so none of them reaches a workspace or
its agents. A page in a workspace still counts as the same site as those
services, so they must refuse cross-origin requests, for example by checking
`Origin` or `Sec-Fetch-Site`, as they should in any case.

To switch back, remove `POISE_PROXY_LISTEN`, set `POISE_ACME_EMAIL`, free
ports 80 and 443 and run `deploy/install.sh`. When you run Compose yourself
in `deploy/`, name both files as the scripts do, for example
`COMPOSE_FILE=compose.yaml:compose.proxy.yaml docker compose ps`.

## Run your own Poise from a fork

This repository is meant to be forked. A fork deploys itself to its own
server from GitHub Actions, and can take this repository's changes as they
land.

1. **Fork** autonomio/poise into your account or organisation. GitHub turns
   workflows off in a new fork: enable them on the fork's **Actions** tab.
2. **Prepare the server** as for any installation: [the server](#the-server),
   [DNS](#1-dns) and [the OAuth App](#2-the-github-oauth-app). Then give the
   workflow an account on it:
   - a user that may use Docker, such as `poise` in the `docker` group, with
     `git` installed;
   - an empty directory for the checkout, owned by that user: `/srv/poise`,
     unless you set `POISE_DEPLOY_PATH`;
   - a key pair of the workflow's own, its public key in that user's
     `~/.ssh/authorized_keys`.
3. **Set the fork's variables and secrets** under Settings → Secrets and
   variables → Actions (below).
4. **Start CI with a push, then run the Deploy workflow** on the fork's
   **Actions** tab. The fork deploys only a commit whose CI and Caller runs
   both passed on that exact commit, so a new fork with no runs yet deploys
   nothing until its first push has gone green; an empty commit suffices.
   Once green, the workflow signs in to the server, brings the checkout to
   the commit, cloning it the first time, writes `deploy/.env`, and runs
   `deploy/install.sh` the first time and `deploy/upgrade.sh --no-pull`
   after that. Every push to the fork's main deploys the same way once its
   CI passes, about ten to twenty minutes later, and a deployment that
   fails fails the run. A commit CI never tested, or one whose CI failed,
   is refused: re-run the failed jobs and the deploy follows their success.
   Every completion re-checks the current tip, so a re-run for an older
   commit deploys the green tip instead of losing its deploy.

The workflow reaches the server with these:

| Name | Kind | Value |
| --- | --- | --- |
| `POISE_DEPLOY_HOST` | variable | The server's address or host name. Without it the workflow does nothing, which is why autonomio/poise itself deploys nowhere |
| `POISE_DEPLOY_USER` | variable | The account it deploys as |
| `POISE_DEPLOY_KNOWN_HOSTS` | variable | The server's host keys, and the jump host's, as `ssh-keyscan` prints them. The workflow connects to no other key |
| `POISE_DEPLOY_SSH_KEY` | secret | The workflow's private key |
| `POISE_DEPLOY_PORT` | variable | The server's SSH port, when not 22 |
| `POISE_DEPLOY_JUMP` | variable | `user@host` of a jump host to reach the server through, when it has no address of its own on the internet |
| `POISE_DEPLOY_PATH` | variable | The checkout, when not `/srv/poise` |

Every other `POISE_` variable becomes a line of `deploy/.env`, so the
settings [`deploy/.env.example`](../deploy/.env.example) describes are
variables of the fork: `POISE_DOMAIN`, `POISE_GITHUB_CLIENT_ID`,
`POISE_ADMINS`, `POISE_ACME_EMAIL` or `POISE_PROXY_LISTEN`, and whichever
others you need. The OAuth App's client secret is the secret
`POISE_GITHUB_CLIENT_SECRET`. The workflow writes `deploy/.env` anew at every
deployment, so change settings in the fork, not on the server, and run the
workflow to apply them. A run started by hand checks the same gate, so
applying settings needs green CI on the tip too. Of what a run brings, only `deploy/.env` stays on the
server: the checkout fetches with the run's own token, which expires with the
run, and the settings reach the server over SSH alone, never on a command
line.

**Repair exhaustion reports.** Set `POISE_REPAIR_EXHAUSTION_REPOSITORIES` as an
Actions repository variable to opt in explicit repositories. The gateway forwards
it through trusted service configuration to compatible running workspaces,
including deployments on the same image. Adding, changing or removing it needs
no container replacement, even while native cleanup remains held. An applied
empty value stays disabled after Poise restarts over a legacy environment. See
[reporting verified repair exhaustion](Behavior-chain.md#reporting-verified-repair-exhaustion)
for eligibility, deduplication and admission.

**Google OAuth client settings.** To supply an optional Google client through
Actions, add
`POISE_GOOGLE_CLIENT_ID` as an Actions repository **variable** and
`POISE_GOOGLE_CLIENT_SECRET` as an Actions repository **secret**. Set both
together; leaving both unset omits Google client credentials from the generated
deployment environment. The Deploy workflow
rejects an incomplete pair or a Google secret stored as a variable before
contacting the server. It rewrites both values into the protected `deploy/.env`
on each deployment, so configure them in Actions rather than editing that file.

**Test relay settings.** To run agents' test suites on disposable boxes
([Agents' test suites](#agents-test-suites)), add `POISE_TEST_WORKSPACE` as an
Actions repository **variable** and `POISE_TEST_RENDER_API_KEY` as an Actions
repository **secret**, under the same rules as the Google client's pair, and
`POISE_TEST_BASE_SERVICE` as a variable to start suites on jobs.

**Serving the fork's own releases.** Set `POISE_RELEASE_REPO` to the fork,
as an Actions variable like the settings above. The gateway then serves the
fork's Poise Link installer links to every workspace's Settings, and each
workspace attributes its release to the fork once its container is recreated.
Tag `link-v*` in the fork to publish its own Poise Link builds; until then
the links point at releases that do not exist yet.

**Keeping up with autonomio/poise.** For the fork to update itself, it needs
both of these:

| Name | Kind | Value |
| --- | --- | --- |
| `POISE_UPSTREAM_SYNC` | variable | `true` |
| `POISE_SYNC_TOKEN` | secret | A fine-grained personal access token for the fork, made as below |

For the production fork, upstream's **Wake production Sync** workflow requests
the fork's existing Sync workflow on each push to `autonomio/poise`'s `main`,
without waiting for cron. In **autonomio/poise**'s Actions settings, set
`POISE_PRODUCTION_FORK` to `Vaquum/poise` (or the configured production fork's
`owner/repo`) and add the repository secret `POISE_SYNC_WAKE_TOKEN`. Use a
fine-grained personal access token restricted to **only that fork**, with
**Actions: Write** (and GitHub's automatic Metadata: Read). The upstream
[`GITHUB_TOKEN` is repository-scoped](https://docs.github.com/en/actions/concepts/security/github_token#about-the-github_token);
cross-repository [workflow dispatch requires Actions: Write](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).
Keep this credential separate from the fork's Contents/Workflows merge token
`POISE_SYNC_TOKEN`. An unset target disables the wake; a configured target with
a missing, expired or rejected wake credential fails visibly in upstream Actions.
The wake sends only `ref: main`, never a candidate SHA. The fork still requires
`POISE_UPSTREAM_SYNC=true`; forks cannot dispatch the production wake themselves.

Sync retains its five-minute schedule to reconcile missed or failed wakes.
A successful Deploy wakes Sync for the next upstream changes once its apply
step succeeds. A failed Deploy wakes Sync to reconcile the failure.
Duplicate or stale wakes enter the same serialized Sync, which reads current
main: they introduce no additional deployment or rollback. This does not prevent
an operator from reapplying settings through Deploy on the same green tip.
With `POISE_DEPLOY_HOST` set, Sync
retains the fork's current main through both required push workflows (CI and
Caller) and its gated, serialized Deploy attempt. Green CI alone does not
release the candidate, nor does a successful Deploy that skipped its apply
step. If the completion wake is missed after both required workflows pass,
Sync dispatches the normal gated Deploy and retains the candidate for that
tick, even with nothing new upstream. Queued or running Deploys suppress
recovery, as does a successful `Deploy <sha>` step: a run recorded on an
older head can deploy the current tip.
Then Sync merges directly to the newest upstream main, coalescing changes
that arrived during verification. Forks without deployment keep syncing every
five minutes. GitHub may start a scheduled run some minutes late when it is busy.

Missing verification, a failed or cancelled required workflow or host apply,
or two hours since verification began lets Sync admit a newer fix with its own
required CI. When the fork stays on the same candidate, Sync retries the first
failed, cancelled or timed-out CI, Caller or host apply attempt once. An
exhausted retry remains visible in Actions. Deployment-enabled forks reconcile
their own main even with upstream merging disabled. API errors stop Sync visibly.
Its summary names waiting, blocked and superseded SHAs and links the runs.

Deploy records host apply and workspace proof as separate steps. The
[workspace verifier](#upgrades) establishes the commit actually serving.
After a proof timeout or interruption, Sync rechecks the current applied
rollout using the original workspace inventory and image ID.
A change to Poise alone then reaches the running workspaces within five more
minutes. A change to the system under `deploy/runtime/` first waits for their
running work to finish, up to `POISE_DRAIN_TIMEOUT` ([Upgrades](#upgrades)).

**Release lag observation.** On that same five-minute schedule, the separate
**Observe the production release** job runs for deployment-enabled forks even
when Sync is skipped or fails. Its Actions summary shows the upstream tip,
fork candidate, freshly verified serving releases, first waiting/failed stage,
evidence links and next action. It reads the same exact-main push CI/Caller
and SHA-named Deploy steps as the gates; it never calls those gates or starts
Sync, CI, Deploy or a workspace switch.

A fixed 30-minute grace starts at the first observation of an expected release
that is not yet verified serving. Within it, verification/deployment is shown
as in progress. Past it, one stale-release condition warns once. Its identity,
first observation, warning state and expected workspace inventory live in the
private host file `deploy/.env.release-lag`; repeated observations and newer
upstream tips keep that episode and its original clock. A workflow GitHub records as manually
disabled is shown as a deliberate pause, retaining the episode and age.
False/unset `POISE_UPSTREAM_SYNC` instead says **sync disabled/missing; intent
unknown**: confirm intent before enabling it. There is no new pause setting.

Recovery requires the fork candidate to contain the observed upstream tip and
fresh workspace health to verify that candidate, with the retained rollout's
expected workspace inventory and immutable image proof for stopped workspaces.
At least one workspace must be running; stopped images alone cannot establish
serving. An old successful Deploy, a terminal rollout receipt, unavailable
GitHub/SSH/health evidence or a missing workspace cannot clear the condition.
Observation uses Python 3.10+ on the deployment host and the existing deployment
SSH identity. It changes only its diagnostic file, leaving rollout receipts and
release controls intact. If the host cannot be read, the summary reports the
unavailable condition/age and leaves the host's episode untouched. GitHub must
keep the scheduled workflow enabled for observation to run.

To opt into issue intake for stalled replacement drains, set the fork's Actions
variable `POISE_RELEASE_REPORT_REPOSITORY` to the authorized `owner/repo` with
Issues enabled and a `poise` label. Set `POISE_RELEASE_REPORT_TOKEN` to a
dedicated fine-grained token restricted to **that repository only**, with
**Issues: read and write** and no contents, workflows or other write permissions.
The observer's workflow token remains read-only; the issue credential stays in
Actions and is never sent to the deployment host. An unset destination disables
publication; an opted-in destination without its credential fails visibly.

Publication requires a successful SHA-named host apply and that same job's
failed verifier, whose timestamped log identifies the exact retained rollout,
image and exhausted 600-second wait, plus fresh healthy workspace evidence with
`draining=true`. A generic failed workflow, stale-release warning or pending
switch is insufficient; replacement drains need no pending-switch fields.
The report includes requested/serving releases, workspace admission state,
available blocker details and counters, last retained observation, next action
and verification/observation links. Missing progress or blocker details stay
explicit. The condition marker reconciles closed as well as open issues.
Warning delivery does not consume publication. A creation intent in the existing
diagnostic file prevents another POST after an ambiguous result; subsequent Sync
observations retry lookup. Failed lookups cannot authorize creation, and explicit
HTTP rejections leave creation retryable. Publication failures fail the observation
step with their cause in its summary, within the existing bounded job.
New candidates keep one report during a continuous pause. Fresh health proving
all expected workspaces resumed rearms reporting even if release lag remains;
a later drain needs its own verifier exhaustion after that boundary. Recovery
leaves filed remediation issues open and never changes native safety gates.

`POISE_SYNC_TOKEN` is required because GitHub never lets a workflow's own token change
a workflow file, anything under `.github/workflows/`. autonomio/poise changes
its workflows from time to time. Without the token, the first such change
stops the sync, and the fork stays on the commit before it until someone
presses **Sync fork**. The workflow uses the token for its merges only.
Without the token the scheduled sync's merges also start no CI — a push
the workflow token makes starts no workflow — so the deploy gate refuses
them. Set the token and the next merged change deploys once its CI passes.

To make the token, open GitHub → Settings → Developer settings → Personal
access tokens → **Fine-grained tokens** → **Generate new token**, or this
link, which fills in all but the repository (replace `<owner>` with the fork's
owner):
`https://github.com/settings/personal-access-tokens/new?name=Poise+fork+sync&target_name=<owner>&expires_in=366&contents=write&workflows=write`

- **Resource owner:** the fork's owner.
- **Repository access:** **Only select repositories**, and the fork.
- **Permissions**, under Repositories: **Contents**: Write, and
  **Workflows**: Write. GitHub adds **Metadata**: Read by itself.
- **Expiration:** at most a year. When it expires the sync stops, until a new
  token replaces it.

Save it in the fork as a repository secret named `POISE_SYNC_TOKEN`: the
fork's Settings → Secrets and variables → **Actions** → **New repository
secret**. A secret saved under Dependabot or Codespaces does not reach the
workflow. An organization secret does only when its repository access
includes the fork; one limited to private repositories never reaches a public
fork. To check, run the Sync workflow by hand: its log shows
`WORKFLOW_TOKEN_ONLY: false` once it has the token.

A fork with commits of its own can conflict with autonomio/poise; the sync
then fails and leaves the merge to you.

## In a virtual machine on a shared server

The gateway drives the Docker Engine of the machine it runs on, which amounts
to root there (see [Security](#security)). On a server that runs other
services too, give Poise a virtual machine of its own, so that neither the
gateway nor an agent in a workspace can reach those services. Vaquum's
deployment runs this way, with libvirt on an Ubuntu host:

1. **A network of its own.** A libvirt NAT network, such as
   `192.168.150.0/24` with the host at `.1` and the VM fixed at `.10` by its
   MAC address, gives the VM the internet, and nothing outside the host can
   open a connection into it.
2. **A traffic filter.** A libvirt network filter on the VM's interface drops
   what the VM sends to every private range and to the host's own public
   addresses, so it reaches none of the host's services, containers or other
   VMs. It lets through DNS and DHCP to the host, and the answers to the
   host's connections to the VM's SSH and to the gateway:

   ```xml
   <filter name='poise-isolation' chain='root'>
     <filterref filter='clean-traffic'/>
     <rule action='accept' direction='out' priority='-905'>
       <tcp dstipaddr='192.168.150.1' srcportstart='22' state='ESTABLISHED'/>
     </rule>
     <rule action='accept' direction='out' priority='-904'>
       <tcp dstipaddr='192.168.150.1' srcportstart='8080' state='ESTABLISHED'/>
     </rule>
     <rule action='accept' direction='out' priority='-900'>
       <udp dstipaddr='192.168.150.1' dstportstart='53'/>
     </rule>
     <rule action='accept' direction='out' priority='-899'>
       <tcp dstipaddr='192.168.150.1' dstportstart='53'/>
     </rule>
     <rule action='accept' direction='out' priority='-898'>
       <udp srcportstart='68' dstportstart='67'/>
     </rule>
     <rule action='drop' direction='out' priority='-850'><all dstipaddr='10.0.0.0' dstipmask='8'/></rule>
     <rule action='drop' direction='out' priority='-849'><all dstipaddr='172.16.0.0' dstipmask='12'/></rule>
     <rule action='drop' direction='out' priority='-848'><all dstipaddr='192.168.0.0' dstipmask='16'/></rule>
     <rule action='drop' direction='out' priority='-847'><all dstipaddr='169.254.0.0' dstipmask='16'/></rule>
     <rule action='drop' direction='out' priority='-846'><all dstipaddr='100.64.0.0' dstipmask='10'/></rule>
     <rule action='drop' direction='out' priority='-845'><all dstipaddr='203.0.113.10'/></rule>
     <rule action='drop' direction='inout' priority='-844'><ipv6/></rule>
   </filter>
   ```

   Write one rule like the one for `203.0.113.10` for each public address of
   the host. From inside the VM, check that the internet answers and the
   host does not.
3. **The VM.** Ubuntu 24.04 from Ubuntu's cloud image, checked against its
   signed checksums, sized as the server would be ([The server](#the-server)).
   Install Docker Engine and its Compose plugin from Docker's repository, and
   gVisor from gVisor's, and set `POISE_WORKSPACE_RUNTIME=runsc` and
   `POISE_WORKSPACE_DNS` ([Security](#security)).
4. **The host's proxy in front.** Set `POISE_PROXY_LISTEN` to the VM's
   address, `192.168.150.10:8080`, and have the host's proxy send Poise's
   names there ([Behind your own proxy](#behind-your-own-proxy)). The filter
   above lets the answers through.
5. **Deploying from a fork** reaches the VM through the host. Give the
   workflow an account on the host that can do nothing but forward a
   connection to the VM's SSH, and set `POISE_DEPLOY_JUMP` to it and
   `POISE_DEPLOY_HOST` to the VM's address. Create the account without a
   shell (`/usr/sbin/nologin`) and put the workflow's public key in its
   `~/.ssh/authorized_keys` with these restrictions:

   ```text
   restrict,port-forwarding,permitopen="192.168.150.10:22" ssh-ed25519 AAAA… poise-deploy
   ```

   `permitopen` limits only the connections the key opens through the host;
   `port-forwarding` would also let it listen on the host (`ssh -R`). Allow
   the account local forwarding alone in the host's SSH server, in a file of
   its own such as `/etc/ssh/sshd_config.d/poise-deploy.conf`, check it with
   `sudo sshd -t`, and reload SSH:

   ```text
   Match User poise-deploy
   	AllowTcpForwarding local
   	PermitOpen 192.168.150.10:22
   	PermitListen none
   	PermitTTY no
   	X11Forwarding no
   	AllowAgentForwarding no
   	AllowStreamLocalForwarding no
   ```

## People

A GitHub login may sign in when it is an admin, on the allow list, or an
active member of an organisation in `POISE_ALLOWED_ORGS`.

- **Add someone** on the admin page under the allow list, or list their login
  in `POISE_ALLOWED_USERS` and run `deploy/install.sh`. For a whole
  organisation, add it to `POISE_ALLOWED_ORGS`; membership is checked at every
  sign-in.
- **Remove someone** from the allow list on the admin page. A login that comes
  from `POISE_ALLOWED_USERS` can only be removed there, followed by
  `deploy/install.sh`. Removal takes effect on their next request; their
  workspace keeps running until you stop it.
- **Disable someone** on the admin page to cut them off at once, however they
  got access: their sessions end, their Poise Link devices are revoked,
  sign-in is refused and their workspace stops. Enabling them lets them sign
  in and pair again. Disabling is also how to cut off an organisation member
  before their next sign-in.

A person's data stays in their home volume after they are removed or
disabled. To delete it for good, stop their workspace, then remove the
container and the volume: `docker rm poise-ws-<handle>` and
`docker volume rm poise-home-<handle>`. This cannot be undone.

### What each person does first

1. Sign in at `https://poise.example.com/` and choose **Open your
   workspace**. It lives at `https://<your login>.poise.example.com/`. Its
   first start takes about a minute, behind a page that reloads by itself,
   and the provider CLIs install in the background over the next few
   minutes.
2. In **Settings → Accounts**, under **Connected accounts**, choose
   **Connect** for each agent CLI you use (Claude, Codex, Grok, Muse,
   Antigravity) and for **GitHub**. Each opens a terminal in the panel running
   that CLI's own login. Connect GitHub twice: sign in once as your own GitHub
   account and once as your agent account.
3. In **Settings → General → GitHub**, set **Your GitHub account** and
   **GitHub automation account**. Both must be signed in to `gh` in the workspace. Poise
   acts on GitHub only as these two accounts, and every automation that posts
   reviews or comments fails, saying so, until the agent account is set.
   There is no server-wide default: `REVIEW_AGENT_USERNAME` only seeds the
   agent account on a personal computer. Then add the organisations and
   accounts to work with under **GitHub accounts**.
4. In **Behaviors**, choose where your automations act before you turn them
   on. The pull-request behaviors act in every repository of your accounts
   except those ticked under **Skip repositories** in their Setting; Review
   New Issues reviews only the repositories you opt in. Colleagues can
   automate the same repositories: each person's automations act only as
   their own agent account.
5. Install [Poise Link](Poise-Link.md) on your computer and pair it with
   `poise.example.com`. It keeps Espanso's snippets in sync and shows Poise's
   alerts while the browser is closed. On macOS or on Debian and Ubuntu, one
   command installs it, with Espanso when that is missing; Settings →
   Accounts → Poise Link shows it too, and is where you approve the code
   Poise Link shows:

   ```bash
   curl -fsSL https://github.com/autonomio/poise/releases/latest/download/install.sh | sh
   ```

## Agents' test suites

Agents run the test suites of the repositories they work on, often several at
once and all on one workspace's CPUs. That can starve Poise itself. Set up as
below, those suites run on disposable test boxes instead: a Render one-off job,
or a [Render Sandbox](https://render.com/docs/sandboxes), which costs more but has
Docker, for a suite that reaches for Docker. Only the agent's command stays in the
workspace: it still prints the suite's output and ends with its exit code, as if it
had run there. Without that setup, suites run in the workspace.

**What moves.** Poise starts everything with two hooks, on `PYTHONPATH` and
`NODE_OPTIONS`, so whichever provider's agent asks and however it reaches the
runner, these start on a test box: `pytest`, `python -m pytest` and
`python -m unittest` from any Python; `vitest`, `jest`, `mocha`, `playwright
test` and `tsc --noEmit`; `npm test` and `npm run` of a script whose name starts
with `test`, `check`, `lint`, `typecheck` or `verify`. Asking a runner for its
version or help stays in the workspace, and so do `npm run build`, `dev` and
`start`, with their steps, because their files or servers are wanted where they
are. A command that replaces `PYTHONPATH` or `NODE_OPTIONS` outright, as in
`PYTHONPATH=src python -m pytest`, removes the hook and runs in the workspace. So
do runners the hooks don't know, such as `go test` or `cargo test`. The mechanism
is `scripts/test-offload/`, `gateway/src/test-relay.ts`, `gateway/src/test-instance.cjs`
and `gateway/src/test-box.cjs`.

**What runs.** Exactly what the agent typed, in the same folder, as uid 10001. Agents
need nothing new, and nothing narrows or skips anything: the repository decides what
its commands mean, as Poise's `npm test` does with [the essential tests](Testing.md#the-essential-tests).
A box has one CPU and 2 GB, and Node may use 80% of the memory.

**Which box.** A suite starts on a job, a Render one-off job of the workspace image,
so its tools are the workspace's own at the same paths. A job has no Docker. The
moment the suite reaches for it there, by the `docker` or `docker-compose` command
or by the socket `DOCKER_HOST` names (on a job, its own, unless the agent's
environment names a remote engine), the job ends and the agent's command starts the same captured suite
again on a sandbox, saying so. The gateway remembers that checkout's history for
that workspace until it restarts, so the checkout's next suites go to a sandbox at
once. A suite that only checks whether a `docker` exists stays on the job. Without
`POISE_TEST_BASE_SERVICE`, every suite goes to a sandbox.

**What a box has.** A job has what the workspace image has, without a sign-in, and
runs the suite as that image's user. So the image's own files stay as they are, and
so does what its folders hold that this user may not write: a suite started with the
workspace's own Python runs with the job image's copy of it, which can lag the
workspace's for the few minutes Render takes to build that image again. A sandbox has Docker, running and open to the
suite, and the tools of the workspace image at the same paths: Node 22, Python
3.13 (also selected by `python3` in npm scripts), `git`, a build toolchain,
ShellCheck and the Chromium of this repository's Playwright. Python uses the
workspace image's pinned uv release and `/opt/python` installation directory;
its default executables are installed in `/usr/local/bin`.
`gateway/src/test-box-setup.sh` builds those once, in about a minute, and the
gateway keeps the result as a Render snapshot named after that file's contents, so
a change there builds a new one. Sandboxes live in a sandbox group of their own,
one per `POISE_DOMAIN`, so deployments sharing a Render workspace leave each
other's alone. On either, `/tmp` is its own, whatever temporary folder the agent
has, because that can be too long for a Unix socket made under it.

**What a box gets.** Only what the suite needs, at the same paths: the
checkout's tracked and untracked files without what git ignores, its
`node_modules`, `.venv` and `venv` folders, its `.git`, the virtualenv and Python
of the interpreter when they live outside the checkout, with every link on the way
from the interpreter to its base, and the Node and npm that started the suite when
they aren't the system's. The environment
loses every variable named like a credential or belonging to a provider CLI,
git or GitHub, and the hooks. A checkout whose `.git/config` holds a credential
is refused. A box holds no sign-in, so a test that needs a secret or an ignored
file fails there. What the suite changes stays on the box and goes with it, so
update snapshots with the runner on your own machine if you need them back.

With GNU tar, the runner and relay can reuse verified chunks of the ignored
dependency directories selected for the outer checkout. The runner hashes their
captured tar bytes, including file contents, paths and metadata. Source, Git
data and separately selected interpreters travel with each run. The relay
retains compressed dependency chunks in private temporary files scoped to the
workspace. It keeps at most 128 chunks and 512 MiB across workspaces, expires
idle entries after 30 minutes, and starts empty after a restart. Each fresh box
receives the whole tar in its original order. A miss sends bytes from the
runner's captured input, including during recovery.

**How it dies.** A box is created for one suite and ended when it ends: a sandbox
is terminated, a job cancelled. That happens in each of these cases, and none
depends on the others:

- The suite ends: the gateway passes on its exit code and ends the box.
- The time limit passes (`POISE_TEST_LIMIT_SECONDS`, nine minutes by default): the
  gateway ends the box, and a minute later Render ends a sandbox, and `timeout`
  a job, if the gateway could not.
- The agent's command is stopped or killed, or stops renewing its lease for 45
  seconds: the gateway ends the box.
- The gateway disappears: Render ends a sandbox at the same time limit, and a job
  ends itself within seconds of its next message going unanswered. A gateway that
  restarts ends every box it finds no run for, and does so again every 15 seconds.

The relay keeps one cancellation request in flight per job, with a ten-second
deadline. Failures and timeouts retain the cancellation-failure warning, and a
later sweep retries an owned job that Render still lists. Run retirement frees
its admission slot immediately, without waiting for cancellation.

**When there is no result.** A suite can be too big for its box, by running out of
memory or passing the time limit, and the box can also fail to start, the checkout
can fail to arrive, or Render can be down. The agent's command then says on stderr
why there is no test result, that this says nothing about its code, and to skip
local tests for this work: not to retry or run parts of it, but to push and let CI
run the tests. It exits with 125, or 124 at the time limit, and never falls back to
running in the workspace. Each that the gateway can see also reaches its diagnostics
as `test_relay.run.failed`, naming the relay run ID, workspace, a bounded executable
basename or recognized npm suite, and the reason. Relay lifecycle logs exclude
argument values and shell/interpreter command bodies. Every run is logged with
that safe command label, exit code and duration as `test_relay.run.finished`.
The runner prints the captured-candidate digest and suite, then the existing run ID
at each admission, so observed failures can name the attempt that produced them.
The digest covers the original command specification and uncompressed captured
tar bytes, including uncommitted edits, on both dependency-cache upload routes.
For new atomic Calls, completed direct Vitest assertion failures would retain
bounded gateway-authenticated evidence before the relay deletes their run, but
recovery is currently held for #1619: candidate-controlled reports cannot
authorize it. Missing, interrupted, oversized, unaccounted or relay results cannot
authorize the existing [pre-PR recovery](Behavior-chain.md#bounded-reconciliation)
path; historical worker logs remain diagnostic evidence only.
Poise's configured Vitest reporters also emit the first failed test's file, full
name and assertion/error stack as soon as that test finishes, alongside the
normal reporter. This failure-only stderr record is redacted in full before
being limited to 8,192 characters (plus its final newline). Passing tests add no
output. A later interruption still leaves the suite incomplete and any observed
failure blocked under the evidence rules below.
An explicit gateway-restart failure is the one exception: the active command
records an interrupted validation with its candidate digest, suite and run ID,
with no test result. It waits at most 30 seconds for the existing authenticated
run handshake and retries the whole suite once. The authenticated
`GET /api/link/test-relay/runs/probe/output` handshake returns 410 with
`this run is over` without a request-failure warning. Other relay failures
retain their warnings. Both attempts use one captured
checkout archive, command, cwd and environment, including uncommitted edits.
Capture, provisioning, upload, waiting and the complete rerun share one command
budget from the gateway's `POISE_TEST_LIMIT_SECONDS`: 540 seconds by default,
with whole seconds from 1 to 3540 supported. Invalid or excessive configuration
stops gateway startup. The gateway installs the validated limit beside the URL
and key in `~/.poise/test-offload/relay`; older two-line files retain 540 seconds.
A shorter inherited `BASH_DEFAULT_TIMEOUT_MS` still caps the command budget.
Cancellation retires the active upload and lease and prevents recovery from
starting a new suite. Only the fresh suite's complete exit is returned; a genuine
suite exit (including 125), a broken stream or another relay cause never retries.
A second restart or an unrecovered relay retains the no-result contract above.
Poise derives the agent shell default from the installed budget plus 60 seconds
for reporting and cleanup (600000 ms at the default budget). The shell maximum
stays 3600000 ms. The client allows up to one second for its cleanup DELETE;
retirement is independent of asynchronous provider termination. The gateway
checks time and leases every five seconds, and lost leases expire after 45
seconds. Independently, each sandbox has a provider deadline of the configured
budget plus 60 seconds from its creation; a job's `timeout` has that same limit
and a further ten-second forced-kill grace. These provider backstops still apply
when the gateway is unavailable; neither a DELETE response nor run retirement
alone proves the provider resource stopped.

For atomic implementation and repair, that final relay diagnostic for the command
permits otherwise complete work to pass to Caller with complete publication metadata
and `blocked: null`. Keep the exact candidate checkout and HEAD unchanged; record the
command, diagnostic/reason, incomplete local verification and required CI in `body`.
Caller validates and publishes through its normal PR path; required CI and review
still gate merge. Exit 124/125 alone, a genuine suite failure, an interrupted attempt
followed by a suite result, provider execution-budget exhaustion and other blockers
do not authorize this handoff. An observed test failure stays blocked even if the
relay later times out; retain its first assertion/failure excerpt, suite/test and
available captured-candidate and producing-run identities in `blocked` as defined
in [chain outcomes](Behavior-chain.md#handoffs-and-outcomes). A previously held Call
stays failed. If its checkout
was reclaimed before publication, resource release proves neither surviving edits
nor a publication plan: use the existing **Resume** and a fresh invocation to produce
a new candidate, including for #1039, rather than claim to publish the old one.

**Where they meet.** A workspace dials the gateway at `/api/link/test-relay` on its
host. A proxy with a sign-in of its own must let that through without one, as it
does for Poise Link. Behind your own proxy a workspace dials `POISE_PROXY_LISTEN`
instead, so that address must be reachable from workspaces. A job dials the
gateway too, at the same path on the workspace's public host, so that must be
reachable from Render. The gateway starts each box and passes the checkout and the
output between the two. It holds the
Render API key, which reaches the whole Render account, so no workspace and no
box ever does. A workspace presents its own key, which the gateway signs and
installs for it; an agent can read that key, which lets it start suites and
nothing else.

**What it costs.** A job costs its plan's price for as long as it lives: about
$0.035 an hour for one CPU and 2 GB (`plan-crn-005`), and $1 a month for the cron job
that holds the image. A sandbox costs $0.12 per CPU hour actually used, plus $0.038
an hour for the 2 GB, for as long as it lives, and $0.08 per GB a month for the
snapshot. See [Render's pricing](https://render.com/pricing).

**Setting it up.** Render Sandboxes are in beta and run in Oregon only. Give the
gateway a Render API key and the ID of the Render workspace, and it does the rest
for sandboxes. To start suites on jobs, which cost less, also create, in a Render
workspace and region with no other live service, because a job can reach its
neighbours on Render's private network, a **cron job** named `poise-test-instance`:
the Docker runtime, this repository and the branch you deploy, Dockerfile
`deploy/runtime/Dockerfile`, build context `.`, command `true`, a yearly schedule,
auto-deploy off, and no environment variables, since each job inherits them. It runs
nothing and holds the image. Each `deploy/upgrade.sh` has Render build it again when
`deploy/runtime/`, `caller/` or `package-lock.json` changed since the commit Render
last built; other deploys spend no build minutes on it. Render builds a cron job only
at its branch's newest commit, so the image can be a few commits past the one just
deployed. A deploy never waits for that build or stops for Render; when Render
refuses, the deploy's output shows Render's answer. Give the gateway its service ID:

| Setting | Required | Default | What it is |
| --- | --- | --- | --- |
| `POISE_TEST_RENDER_API_KEY` | yes | | A Render API key. Set both of these, or neither |
| `POISE_TEST_WORKSPACE` | yes | | The Render workspace's ID, `tea-…` |
| `POISE_TEST_BOX_PLAN` | | `1c-2g` | The sandboxes' size |
| `POISE_TEST_BASE_SERVICE` | | | The cron job's service ID, `crn-…`: suites then start on its jobs. Unset, every suite goes to a sandbox |
| `POISE_TEST_PLAN` | | `plan-crn-005` | The jobs' size: one CPU and 2 GB |
| `POISE_TEST_LIMIT_SECONDS` | | `540` | One command budget in whole seconds, 1–3540, including capture, provisioning, upload and retries. Also bounds each relay run; the enclosing shell default adds 60 seconds |
| `POISE_TEST_MAX_RUNS` | | `30` | Suites at once; past it an agent's command fails loudly |

In a fork, `POISE_TEST_RENDER_API_KEY` is an Actions secret and the others are
variables. The gateway installs the hooks and each workspace's key into its home
volume, in `~/.poise/test-offload`, whenever it installs a release there, so no
workspace is drained or recreated for this, and agents started after that
release's Poise restarts use them. Removing the settings turns it off at the next
release, for running agents too.

## Upgrades

```bash
deploy/upgrade.sh
```

It pulls the newest commit of the branch the checkout follows (fast-forward
only), rebuilds the workspace image, lets Compose recreate Caddy or the
gateway if they changed, restarts or reloads Caddy when its Caddyfile changed, and lists the workspaces that run an older image.
A fork that deploys itself does this once CI passes on what a push to its
main brought ([Run your own Poise from a fork](#run-your-own-poise-from-a-fork)).

It then proves the deploy landed: for up to ten minutes it waits for every
workspace to serve the new commit — a running one through its health check,
a stopped one by its new image — and only then reports success. Past that it
reports which workspaces are still pending, with the release each runs, the
one it waits for and how long it has waited, and fails: a deploy run is
green only once the workspaces run what it deployed. `deploy/install.sh`
proves the same after it starts the gateway.
Both scripts capture workspace handles before building or retagging the image,
then retain that inventory and add any workspaces observed during verification.
A removed container stays pending until its replacement is verified; another
healthy workspace cannot hide a missing one.
Each poll retains the workspace labels from its container listing before
inspection. If a listed container vanishes before inspection, verification
still requires that workspace across later polls and retries; it waits for
a complete inventory instead of treating partial results as proof of success.
The private `deploy/.env.workspace-proof` retains unfinished obligations across
failed deploys and retries, and is cleared after successful verification.
It proves handles captured by these scripts; a workspace already absent before
the first captured inventory cannot be inferred from that inventory.

Each release deployment also prints a rollout ID and retains its full commit
SHA, immutable image ID, expected workspace set and outcome under the private
`deploy/.env.workspace-proof.rollouts/` directory. A retry of the same pending
target reuses its receipt. After the verifier or its
SSH/Actions process exits, recheck that ID with `deploy/verify.sh ROLLOUT`.
For the most recently started rollout:

```bash
deploy/verify.sh "$(cat deploy/.env.workspace-proof.rollouts/current)"
```

This takes one observation using the same verifier, without pulling, building,
applying Compose, starting a workspace or requesting a switch. It requires no
current `deploy/.env`: the original target and inventory come from the record.
Running workspaces must report that exact active SHA; stopped workspaces must
use the original image ID, even if another build has retagged `latest`.
Timeout, missing workspaces and unreadable health remain `pending`, and the
command exits nonzero. Invoke it again later to observe activation. A different
`desiredRelease` alone never establishes failure or supersession.

Deployment-enabled forks recheck pending host-applied rollouts on the Sync
schedule. The proof uses the exact active release and build and requires no
pending switch. The recheck performs only inventory and health reads and
updates the retained receipt and its [deployment pause diagnostics](Logging.md#collection-and-operation).
Check a legacy receipt by its rollout ID. An observed replacement drain still
active at the verifier's positive deadline retains an Error in Logging while
the rollout remains pending; receipt-only zero-second waits do not raise it.

The outcome becomes `complete` only after every expected workspace passes the
proof. A supervisor `failed` marker for the exact target release establishes
`failed`; a subsequent deployment replacing the target SHA or image establishes
`superseded`. Terminal observations remain historical receipts when another
rollout finishes; the command reads those without reclassifying them. Each
record retains the latest 32 UTC-timestamped observations, at most 4096 bytes
each, including evidence after completion. The historical Actions result is
unchanged: a later `complete` observation does not turn its earlier timeout green.

The gateway upgrades those workspaces by itself, when it starts and every
five minutes. Most upgrades change Poise but not the system it runs on, and
those happen in place: the gateway installs the new release into each
running workspace, and Poise restarts on it alone within seconds, at a moment
no Chat turn runs. Agents and reviews keep running through it, and the open
page shows "Updating to the latest version" until it reloads into the new
version (docs/Service-architecture.md, "Updates in place"). The first line of
Poise's menu (☰) says which commit a workspace runs, linked to it on
autonomio/poise, and when the workspace was updated to it, as in
`46815bf · 9 Oct 21:40`.

An upgrade that changes the system itself, the files under `deploy/runtime/`,
gets a new container instead. The gateway drains a running workspace first:
the workspace refuses new Chat turns and agent launches, which then answer
that Poise is installing an update, and lets running work finish. In an ordinary
drain, one Chat turn holds the drain at most 30 minutes: past that the workspace stops it
with a notice in its transcript, naming the update, and the agent keeps its
context for the next prompt. After a fresh admitted drain confirms the workspace
is idle, the gateway recreates it on the new image with the same home volume.
A terminal cleanup failure can carry across replacement once Caller has
recorded that the original process namespace is empty. The original Call,
disk and reservation stay held. The gateway logs the retained cleanup with
`workspace.upgrade.cleanup-retained` after all live work has finished.
With retained cleanup, the workspace lets Chat turns finish and the gateway
defers replacement if they are still active at its deadline.
Past `POISE_DRAIN_TIMEOUT` seconds (90 minutes by default), cutting confirmed
busy work requires a fresh admitted drain with zero unsettled native Calls,
Caller processes and background operations, including launches before Call
registration.
Cleanup without that process proof, unreadable cleanup records and unconfirmed
drains defer replacement and release the drain (`workspace.upgrade.aborted`,
`workspace.upgrade.native-pending`). An older workspace can still upgrade
when it reports cooperative idle. When a hold blocks replacement, the gateway
logs the Call and its available reason and retries resume while health still
shows an admitted drain. Existing maintenance continues to retry cleanup.
After starting the replacement the gateway
waits for its health before declaring the upgrade finished, within the two-minute
idle-to-ready bound; past it the miss is recorded (`workspace.upgrade.ready.missed`),
a late answer still reports its measured `readyAfterMs`, and one that never answers
is left for the next visit to bring up. A stopped workspace
is recreated without being started. Follow it all in the gateway's log:

```bash
docker logs --follow poise-gateway 2>&1 | grep workspace.
```

When Compose recreates the gateway, the new container is on none of the
workspace networks the old one had joined. The gateway joins them all as it
starts, before it answers or upgrades anything, so it reaches each running
workspace to drain it; `deploy/upgrade.sh` and `deploy/install.sh` check that
it did, and stop with a message if not. If the gateway cannot join a
workspace's network, that workspace's upgrade fails with the reason
(`workspace.upgrade.failed`) and is tried again five minutes later, rather
than recreating the workspace undrained. The old gateway lets in-flight
requests finish for up to ten seconds while the front retries dials for
thirty, so a replacement reads as a brief delay, not 502s.

To roll back, check out the earlier commit and apply it without pulling;
return to the branch the same way:

```bash
git checkout <commit>
deploy/upgrade.sh --no-pull
git checkout main
deploy/upgrade.sh
```

Every upgrade keeps the previous image under its commit tag, for a rollback
to rebuild from cache. Once Poise is up, `deploy/install.sh` and
`deploy/upgrade.sh` remove what older builds left: workspace images of
earlier commits that no container uses, Poise's images that lost their tag
to a newer build, and Docker's build cache beyond 5 GB (`build_cache_limit`
in `deploy/lib.sh`; the cache is shared with the server's other builds). List
what is left with `docker image ls poise-runtime` and `docker system df`.

Settings that shape a workspace container (its limits and runtime) apply to
containers the gateway creates from then on. To apply them to an existing
workspace, stop it on the admin page and remove its container with
`docker rm poise-ws-<handle>`; its home volume stays, and its next visit
creates it again.

`POISE_DRAIN_TIMEOUT` is different: the gateway passes it to every workspace,
which lets a drain the gateway stopped renewing lapse by the same value, so
the two must agree. After you change it and run `deploy/install.sh`, the
gateway recreates every workspace the way it does for a new image: a running
one drained first, a stopped one without starting it. It may be at most
604800 seconds, a week.

The optional [native behavior budgets and reservations](../gateway/README.md)
also pass from `deploy/.env` to each workspace. Configure both values for every
bounded dimension. Applying an addition, change or removal uses that same
replacement drain and retains original cleanup records. Unset budgets
remain unbounded; existing invocation ceilings never change in place.

## Backups

```bash
deploy/backup.sh [DIRECTORY]
```

It backs up the gateway's volume and every home volume into a new directory
named after the time (UTC), in `DIRECTORY` or `deploy/backups`, while
same-kernel (`runc`) containers keep running. Each volume becomes one gzipped
tar beside a `SHA256SUMS` file. SQLite databases go in as snapshots taken with
SQLite's online backup, so each is consistent even while Poise writes to it; their
`-wal` and `-shm` files stay out. Everything else is archived as it is, with
owners and permissions.

A backup holds every person's signed-in CLIs and the gateway's signing key,
so only the user who made it can read it. Copy it off the server; a backup on
the same disk does not survive the disk. To run it nightly, add a line like
this to root's crontab (`sudo crontab -e`):

```cron
0 3 * * * /srv/poise/deploy/backup.sh /var/backups/poise >>/var/log/poise-backup.log 2>&1
```

Not in a backup: `deploy/.env` (keep a copy somewhere safe; it holds the
OAuth App's client secret), Caddy's certificates (it obtains new ones) and
the images (the scripts build them).

A workspace that runs under gVisor (`POISE_WORKSPACE_RUNTIME=runsc`) has a
different kernel from the backup helper, which always uses `runc`. Opening
its live SQLite databases from that helper can crash the workspace's writer.
`backup.sh` refuses running, paused or restarting consumers of an archived
volume under any runtime other than `runc` or `io.containerd.runc.v2`,
including consumers of the gateway volume and containers without workspace
labels. A stopped gVisor workspace also requires the gateway to be stopped:
**Stop** on the admin page is insufficient, because the next authenticated
request can start the workspace again. A gateway configured to create
workspaces under another runtime must be stopped even when the current
workspace containers use `runc`. Quiesce native work through the
existing drain and settlement gates before stopping such a workspace for backup.
Never query its live SQLite files from the host or another kernel, including
with `mode=ro` and `PRAGMA query_only=on`: those reads can change shared WAL
state and disrupt a writer. Use the workspace kernel or a preserved offline copy.

For an offline backup, stop the gateway first, then every affected workspace
container (the error names it). For example, for `alice`:

```bash
docker stop poise-gateway
# If paused, unpause the workspace before stopping it.
docker stop poise-ws-alice
deploy/backup.sh /var/backups/poise
docker start poise-gateway
```

Keep the gateway and affected workspaces stopped until `backup.sh` finishes;
do not start, replace or deploy containers during that interval. The gateway
starts a stopped workspace on its owner's next visit. The script checks Docker's
inventory before and after each volume. A failed inventory or safety check
removes the entire new backup directory, including
archives already completed. Live `runc` volumes still support the nightly command
above without stopping the gateway. A busy or locked SQLite snapshot aborts the
backup; it never falls back to copying that live database's files.

## Live Caller diagnostics under gVisor

Use Poise's History, Behaviors, Logging and workspace service health readers.
Run any required Caller reader inside the workspace kernel, using its existing
supervisor metadata reference. Host SQLite access is unsafe even with `mode=ro`
or `PRAGMA query_only=on`: it can modify the guest's WAL shared-memory file.
For offline SQL, first stop the workspace and preserve its database and sidecars.

Managed Caller validates the database inode and ownership using filesystem
metadata without opening an extra file descriptor. SQLite owns the database
connection and its locks.

`deploy/install.sh` and `deploy/upgrade.sh` install and enable
`poise-caller-guard.service` when the configured or an existing workspace runtime
is gVisor. It runs on the host, independently of the gateway and workspace
restart policies. It inspects each container's actual runtime (including aliases
registered with a `runsc` executable), and fences only gVisor home volumes.
Every five seconds, and on an explicit check, it discovers Caller stores and
holds SQLite's Unix lock range on their exact host inodes. Discovery prunes
`native-resources` work trees, including beneath renamed metadata ancestors:
their disposable fixture stores are never opened or retained and cannot stand
in for a missing workspace Caller store. It retains locks on
original inodes after ancestor renames, `calls.sqlite3.old` file renames and
replacement, while that home still belongs to a gVisor workspace. A restarted
guard rescans the home volume to find those originals. It never opens SQLite
or WAL sidecars. Ordinary `runc` and `io.containerd.runc.v2` workspaces retain
their normal SQLite locking.

Check protection explicitly; an active service or live PID is insufficient:

```sh
sudo python3 /opt/poise-caller-guard/guard.py --check
sudo systemctl status poise-caller-guard.service
sudo journalctl -u poise-caller-guard.service
```

The check scans current stores and verifies every retained lock's owner, range
and inode from a separate host process. Deployment fails if it cannot obtain
that proof. Missing first stores, acquisition failures, unavailable Docker
inventory and lock loss report protection unavailable in checks, the journal
and the unit's status text. Existing locks remain held during inventory errors.
The boot-enabled service restarts after guard death and rechecks after host,
Docker or workspace restart. First store creation and newly replaced inodes
are protected only after discovery and verified acquisition. Guard downtime
and discovery intervals are not continuous protection; inspect the check after
recovery before performing host maintenance. Unexpected lock loss requires
repair and guard restart; it is never concealed by a surviving PID.
If an existing ad hoc guard owns this range, deployment refuses acquisition;
transfer protection to the packaged service through a controlled operator handoff.

This is advisory protection for ordinary SQLite clients, not a boundary against
privileged host access. Root or Docker administrators can stop the guard, remove
its locks or modify files directly. SQLite's `immutable=1` and `nolock=1` bypass
locking and are **not supported live diagnostic workarounds**. Do not use them
on live stores. The guard does not establish receipt integrity or authorize
store replacement; Caller's existing metadata identity checks still apply.

### Caller receipt-store recovery

`caller.receipts.integrity` diagnostics retain the first observed SQLite cause,
time and workspace independently of Caller's damaged store. `SQLITE_NOTADB`
and `SQLITE_CORRUPT` are integrity failures; busy/locked reads are contention,
and other read failures remain unavailable. Health keeps `idle: false` and
`unsettledNativeCalls: null` while unreadable. Managed chain admission and its
final launch/action/publication boundaries refuse unavailable receipts.
A confirmed integrity failure also persists the existing chain admission pause
across server restarts. While the hold persists the effective chain setting
reports disabled even when the stored setting still reads enabled (for example
a stop between the hold write and the settings update). Successful health
responses and narrow SQL reads cannot resume admissions, and an automatic v2
cutover cannot re-enable them while the hold persists. Cleanup and
original-receipt reconciliation continue; explicit resume through the existing
behavior control follows the recovery checks below.
Contention recovers automatically without pausing admissions. The first receipt
diagnostic remains actionable; behavior sweeps omit its repetitive wrapper only
after that exact failure was recorded, while separate failures remain reported.

1. Preserve the original main file, WAL (including deleted files held open by
   original processes), shared-memory state, behavior journal and process/resource
   identities before changing writers or storage. Use the workspace kernel for
   live observations. A release restart leaves original workers alive; a zero
   process-local count cannot establish quiescence.
2. Retain the existing journal's `invocation.uncertain` holds for started work
   whose receipts cannot be read or are absent. Check those holds before exposing
   a partial recovery to normal reconciliation. Missing rows cannot authorize a
   retry, a synthetic no-effect Call, or reservation release, even on a closed,
   disabled or held chain. Never recreate missing receipt identities.
3. Work on separate offline copies. Check SQLite integrity, foreign keys and the
   unchanged application schema, then inventory missing and invalid receipts
   against the preserved journal and actual GitHub effects. Structural integrity
   alone cannot validate incomplete Call, publication or resource evidence.
4. Quiesce original writers and verify their original namespace/resource witnesses
   before any activation. Preserve settlement certificates before any lifecycle
   change that destroys supervisor handles. Both Caller and Poise's bounded
   health/maintenance reader pin the original database identity and reject a
   replacement inode; verify recovery through both actual readers in the
   workspace kernel. Do not bypass that identity check or destroy an unsettled
   supervisor to make a replacement readable.
5. Reconcile original Calls and GitHub artifacts through the existing receipt
   checks. Missing or invalid evidence stays uncertain and retains capacity until
   original resource release is proven. New work then passes the existing enable,
   hold, identity, capacity and final receipt gates; readability alone clears no
   invocation hold and authorizes no repeated effect.

The #971 disposable reproduction established that cross-kernel read-only access
can disrupt a guest writer. The exact production corruption transaction remains
unverified; the backup refusal prevents the demonstrated unsafe access.

The active release's `caller/agent_interface/agent_interface/recover_store.py`
is the operator activation command for a reviewed candidate. Run it as the
workspace user inside the original workspace kernel. Pass the private staging
directory, `--service-pid` with the active Poise server PID and `--apply-manifest`
with the reviewed SHA-256 of `verification.json`. The staging directory lives
under `~/.poise/incident-recovery` and contains the preserved `source-calls.sqlite3`
and any captured WAL and SHM, the `recovered.sqlite3` candidate and the manifest.
Record the original inode, archive and candidate digests, row counts and exact
omitted row identities and causes in the manifest. Verify those omissions
against the live journal and keep unsettled effects and resources fenced.

Before activation, pause behavior admissions and use the existing service drain
to stop new Chat turns and Caller launches. The command requires the original
supervisor, no running writers, the same Caller schema and every readable
original record. It rechecks any omitted terminal managed record and refuses
changed evidence or a changed rowid watermark. SQLite holds the write lock
across verification and backup to preserve the original inode. Keep the drain
and admission pause through post-activation validation. Resume through the
existing service and behavior controls after the bounded and exact readers
work and the original holds are verified.

## Restore

```bash
deploy/restore.sh BACKUP
```

`BACKUP` is one of the directories `deploy/backup.sh` writes. The script
checks the archives against `SHA256SUMS`, then creates each volume anew and
fills it, keeping owners and permissions. It never overwrites a volume: if
one already exists it stops before touching anything, and if it fails it
removes the volumes it created.
A successful restore also clears any unfinished host deployment proof: restored
home volumes intentionally wait for their owner's next visit to create a container.

**On a new server**, for example after losing the old one:

1. Install Docker, clone the repository and write `deploy/.env` with the same
   `POISE_DOMAIN` as before (see [Settings](#3-settings)).
2. Copy the backup directory to the server and run
   `deploy/restore.sh <backup directory>`.
3. Run `deploy/install.sh`, then point DNS at the new server.

Everyone's sessions, devices and workspaces come back as they were; each
workspace container is created again on its owner's next visit.

**On the same server**, to go back to a backup, remove what it replaces
first. This deletes the current data of the gateway and of every workspace:

```bash
cd deploy
docker compose down
docker rm --force $(docker ps --all --quiet --filter label=poise.managed=true)
docker volume rm poise-gateway-data $(docker volume ls --quiet --filter name=poise-home-)
./restore.sh <backup directory>
./install.sh
```

## Disk

The gateway measures every workspace's home volume and the free space of the
disk its data lives on when it starts and every hour. Settings → Admin and
the admin page show both. The gateway logs `disk.workspace.over_budget` when
a workspace grows past `POISE_WORKSPACE_DISK_BUDGET` (50 GB by default), and
`disk.low` when less than a tenth of the disk is free. Each is logged once,
until it clears. Both Admin views show these capacity warnings in amber;
failed operations, such as a workspace that could not start, remain red.

What grows in a home volume is each person's own: their provider CLIs, Chat
history, the GitHub indexes Poise reads, and the repositories agents check
out. Review checkouts are removed a day after their last use. Old images and
build cache are removed after each deploy ([Upgrades](#upgrades)).

### Storage maintenance

Each workspace also cleans itself: every 6 hours, counted from the last run
so that a restart does not start one early, and never in the first 10 minutes
after a start; whenever its own disk passes 80% used; and on demand from
Settings → Storage, which shows the storage breakdown and the last run. A run removes a closed session's scratch
workspace after 24 hours when its tree is clean and nothing is unpushed,
requiring a remote-tracking ref to contain every local branch tip and any
detached HEAD; remote-less committed work stays held. Open idle sessions keep
their artifacts: directory names and Git ignore rules do not prove that an
entry can be regenerated. Artifact pruning requires recorded generator
provenance, which existing workspaces do not have. Any legacy prune marker
still restores dependencies on the next turn. Maintenance takes the checkout
lease and rechecks turn claims before tidying its Git data. It expires
incident snapshots after 30 days unless pinned with a
`KEEP` file, and caps the pip, uv, npm and GitHub-mirror caches with
least-recently-used eviction. Workspace content with uncommitted or unpushed
work stays held, and a running or queued turn blocks all workspace maintenance;
everything kept is listed
as held with the reason, and every run is logged with the bytes it reclaimed.
GitHub mirrors are evicted through Caller's local `--prune-mirrors` behavior,
which shares checkout's per-repository lock and keeps owner directories and
lock files. A recent descendant write, a busy lock or uncertain bare-mirror
identity holds the mirror; symlinks are never followed for deletion.
Resuming a removed managed workspace creates only its empty private path
before constructing the canonical lease. Ownership/Git initialization and
the post-wait existence check run under that same held lease. Foreign
markers are refused; an unsettled initializer worker keeps its lease.

Legacy issue-review and atomic-work directories stay retained regardless of
age, hex names or an empty path-based process scan. Neither maintenance nor
Caller's sweep traverses those trees for deletion or permission repair.
Maintenance lists the legacy review parent as held; Caller warns for each
existing legacy parent that original ownership and process termination are
unverified. Owned native resources continue through the existing original
receipt, process-witness and pinned-directory cleanup path.

Settings → General reads a cached storage summary: one scan answers
concurrent requests, and its observation answers Settings opens for 60
seconds. Each read walks at most 100,000 entries or 5 seconds across every
category; a category past either bound reports partial (a measured prefix)
or unavailable, while a missing directory still reads as zero. When a
refresh fails, the panel keeps the last update, marked stale with its age
and the refresh error; a failed first read, and a read that never answers
within 15 seconds, show an error instead. Partial, stale and failed reads
offer Retry, which re-measures at once (`GET /api/storage?fresh=1`). A
completed maintenance run drops the cached summary, so the next open
measures the reclaimed space.

Shared checkout coordination and provider state are retained, independently of
age. The existing bounded storage scan includes the global lease directory,
Codex/Claude/Grok homes and Muse data/configuration, honoring their configured
paths. Storage lists these categories as retained; maintenance never unlinks their
SQLite gates or removes shared sign-in, history or user files. Missing, partial
and unavailable measurements keep the same meanings above. A retained directory
is not proof of an idle provider or attributable to a particular invocation;
return-to-idle evidence must include it. Antigravity's external history layout
is not established by these categories, so this inventory cannot establish
complete provider-disk coverage for an unexercised Antigravity run.

Reclamation still requires the original filesystem's positive unlink proof.
Persistent-home backends can retain a link count of one after unlink; an
unaccepted or unavailable proof retains capacity. Retention checks alone do not
establish return-to-idle on those backends.

New native atomic checkout gates live inside their original owned Call root and
are reclaimed with that root after positive process settlement. Codex issue
review and implementation/repair commands reuse structured review's isolated
Codex home: only sign-in is copied, ephemeral invocations remain ephemeral, and
structured reviews retain within-invocation resume. Muse already keeps its
invocation history in the owned root. These guarantees do not authorize deleting
older shared history or prove other unexercised provider/platform cleanup.

### Giving space back on a VM host

When Poise runs [in a virtual machine](#in-a-virtual-machine-on-a-shared-server),
freed guest blocks only return to the host if the disk passes discards
through. Without that, the image keeps growing while the guest reports free
space. On the libvirt host, set `discard='unmap'` on the VM's disk (with the
VM shut down, `virsh edit` the domain and find the `<driver>` line of its
disk):

```xml
<driver name='qemu' type='qcow2' discard='unmap'/>
```

Then start the VM and compare the guest's `df` against the host's
`virsh domblkinfo` allocation: after the guest trims, the two agree again.
The guest side needs nothing from the operator: each maintenance run issues
`fstrim` on the home volume when the tool is available. If the filesystem
reports that discard is unsupported, Poise records one warning and skips trim
for that home volume until the server restarts. Other trim failures retain
their stderr diagnostic and are retried on the next run. Maintenance still
completes its cleanup report when trim fails or is skipped.

## Logs

From `deploy/`:

- `docker compose logs --follow gateway`: one JSON object per line, each with
  an `event`, such as `auth.signed_in`, `workspace.container.started`,
  `workspace.upgrade.finished`, and every refusal and error.
- `docker compose logs --follow caddy`: certificates and Caddy's errors.

A workspace logs to `docker logs --follow poise-ws-<handle>`. The provider
CLI installation logs inside it:
`docker exec poise-ws-<handle> cat /home/poise/.poise/logs/cli-bootstrap.log`.

Docker keeps container logs without a size limit unless told otherwise.
Poise's own containers need nothing: Caddy and the gateway (in
`deploy/compose.yaml`) and every workspace (set by the gateway) keep at most
five log files of 20 MB each. A workspace created before this limit gets it
when it is next recreated. For other containers on the server, set a default
in `/etc/docker/daemon.json` and restart Docker:

```json
{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "5" } }
```

## Health

Each workspace answers three levels of health:

- `GET /api/health/live` is liveness: 200 whenever the process answers. It
  performs no I/O, so no dependency can slow it down.
- `GET /api/health` adds readiness: `readiness` says whether interactive
  work can trust its dependencies, `dependencies` names each one (ledger,
  datastore per organization, GitHub quota per account, local collection),
  and `history` keeps cumulative ledger loss. These fields are additive:
  the response's status code and `status` keep the meaning existing
  monitors read.
- `GET /api/service/health` is the gateway's contract: startup readiness,
  release switching and drain polling. The container health check probes it.

A degraded dependency never changes a status code. Alert on
`readiness.status` and the `dependencies` entries rather than on the
process existing. Ledger queue stalls, worker failures and capture loss
also alert through Poise Link and the page's notices.

A responsive health endpoint does not prove that PR automation is making
progress. During a service-mode drain, `/api/health` can still report
`scheduler.status: ok` and `selfUpdate.draining: false`. Read the workspace's
actual drain state from its loopback service endpoint:

```bash
docker exec poise-ws-<handle> curl -fsS http://127.0.0.1:5555/api/service/health
```

`draining: true` pauses new PR reviews and approvals while running work
settles. The gateway reports a recreate drain in `workspace.drain.waiting`,
including its blockers and `remainingSeconds`; an in-place release switch
uses `workspace.update.waiting`. `switching` alone does not pause behaviors.
Missing gateway events do not disprove a drain: when renewals stop, the drain
lasts until its lapse timeout ([Upgrades](#upgrades)).

Provider failures appear in `/api/health` under `scheduler.failures`, with
`diagnostic.code` and `lastFailureAt`. Old failures remain visible during a
drain, so compare their timestamps with the admission pause. Check recent
outcomes for the PR in the [behavior ledger](Behavior-ledger.md#read-interface);
an empty or stale result does not prove no work is running—check its `health`.

## Troubleshooting

- **`install.sh` says a port is in use.** Another web server holds port 80
  or 443; stop it, or run Poise behind it
  ([Behind your own proxy](#behind-your-own-proxy)).
  `sudo ss -ltnp 'sport = :443'` names it.
- **The gateway keeps restarting.** `docker compose logs gateway` lists every
  setting it refused, each with the reason.
- **The browser warns about the certificate.** For the apex, check the DNS
  records and that ports 80 and 443 are open to the internet;
  `docker compose logs caddy` shows each attempt. Let's Encrypt limits how
  often it issues for one name, so fix the cause before retrying with
  `docker compose restart caddy`. A workspace host gets its certificate only
  after its owner has signed in at the apex once.
- **GitHub shows "The redirect_uri is not associated with this
  application".** The OAuth App's callback URL must be exactly
  `https://<POISE_DOMAIN>/auth/callback`.
- **Sign-in ends with "GitHub refused the sign-in code".** The client ID or
  secret in `deploy/.env` does not belong to the OAuth App; correct it and run
  `deploy/install.sh`.
- **Sign-in says the login is not allowed.** Add it on the admin page, or
  check `POISE_ALLOWED_ORGS` and the organisation's OAuth App approval.
- **A workspace stays on "Starting your workspace".** The page shows the last
  start error, and the gateway logs `workspace.start.failed` with the reason.
  If the workspace image is missing, run `deploy/install.sh`.
- **A workspace still runs the old image after an upgrade.** The gateway
  waits up to `POISE_DRAIN_TIMEOUT` for a busy workspace. Look for
  `workspace.drain.waiting` (what it waits on and the time left),
  `workspace.drain.unconfirmed` (the drain was never admitted),
  `workspace.upgrade.aborted` and `workspace.drain.released` (a slow workspace
  freed for the next pass), `workspace.update.waiting` and
  `workspace.update.stuck` (an in-place switch waiting or stuck), and
  `workspace.upgrade` and `workspace.network` events in its log.
  `readyAfterMs` on `workspace.upgrade.finished` says how long the replacement
  took to answer health; past the two-minute idle-to-ready bound the miss is
  recorded as `workspace.upgrade.ready.missed` alongside it, and a replacement
  that never answers is left for the next visit to bring up.
- **`install.sh` or `upgrade.sh` says the gateway is not on a workspace's
  network.** The gateway joins every workspace's network as it starts, and
  `docker logs poise-gateway 2>&1 | grep workspace.network` says why it could
  not. Fix that, then run `docker compose restart gateway` from `deploy/`.
- **The disk fills up.** Remove old images and build cache (see
  [Upgrades](#upgrades)); `docker system df` shows where the space goes.

## Security

- **The gateway is root on the server.** It manages workspaces through the
  Docker socket, which gives full control of the host to whoever controls
  the gateway. Keep the server for Poise alone, keep the checkout up to date,
  and limit who can log in to it. Whoever is root on the server can read
  every person's data and signed-in CLIs, so people must trust its operator.
- **Workspaces are isolated containers.** Each runs as an unprivileged user
  with every Linux capability dropped, `no-new-privileges`, and memory, CPU
  and process limits. Its network is shared with the gateway only, so no
  workspace can reach another, and it publishes no ports. Agents inside a
  workspace run with full access and no sandbox: anything an agent does can
  touch everything in that person's workspace, and it can reach the
  internet.
- **gVisor** adds a second boundary. Workspaces share the host's kernel; with
  [gVisor](https://gvisor.dev/docs/user_guide/install/) each one runs on its
  own application kernel instead. Install `runsc`, register it with Docker
  (`sudo runsc install`, then `sudo systemctl reload docker`), set
  `POISE_WORKSPACE_RUNTIME=runsc` in `deploy/.env` and run
  `deploy/install.sh`. It applies to workspace containers created from then
  on (see [Upgrades](#upgrades)). Set `POISE_WORKSPACE_DNS` with it, to
  resolvers such as `1.1.1.1,8.8.8.8`. gVisor cannot reach the DNS server
  Docker gives containers on their own networks, so without it a workspace
  resolves no host: it installs no provider CLI and cannot reach GitHub. The
  gateway mounts a file naming those resolvers over each workspace's
  `/etc/resolv.conf`, and recreates a workspace whose resolvers differ.
- **Sign-in and sessions.** Caddy, or your own proxy, serves everything over
  TLS. Session cookies are `Secure`, `HttpOnly` and `SameSite=Lax`, and no
  cookie the browser sends ever reaches a workspace. A workspace host
  serves its owner only; an admin gets no access to it either. The gateway
  stores no GitHub token, and keeps only hashes of session ids, tickets and
  device tokens.
- **Secrets on disk**: the OAuth App's client secret in `deploy/.env`, the
  gateway's signing key in `poise-gateway-data`, and each person's CLI
  credentials in their home volume. Backups hold the last two.

### Diagnostic history

[Logging](Logging.md#collection-and-operation) defines independent local and
central stores, retention limits, source coverage, the operator CLI and external
proxy delivery. `poise-gateway-data` backups include the central SQLite history;
workspace replacement/removal does not remove that history. Missing host
journals or incompatible workspace versions are visible collection gaps.
