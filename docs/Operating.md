# Operating Poise

This guide runs Poise as a service on one Linux server, for yourself and a
few colleagues. Each person signs in with GitHub at one address and gets
their own workspace: their own Poise, agent CLIs, GitHub accounts and data,
in a container of their own. [Service architecture](Service-architecture.md)
describes how the parts fit together.

Setting up takes four steps: point DNS at the server, create a GitHub OAuth
App, fill in `deploy/.env`, and run `deploy/install.sh`. Upgrading is
`deploy/upgrade.sh`.

## What runs

`deploy/compose.yaml` runs two containers with Docker Compose:

- **`poise-caddy`** ([Caddy](https://caddyserver.com/)) listens on ports 80
  and 443, holds the TLS certificates and passes every request to the
  gateway.
- **`poise-gateway`** signs people in, routes each workspace host to its
  owner's workspace, and creates, starts and upgrades the workspace
  containers itself through the Docker socket.

Each person's workspace is a container named `poise-ws-<handle>`, where the
handle is their GitHub login in lower case. Their home folder is the volume
`poise-home-<handle>`, so their data and signed-in CLIs outlive the
container. The gateway keeps its own state (people, sessions, devices, its
signing key) in the volume `poise-gateway-data`.

## The server

- 64-bit Linux with Docker Engine 24 or newer and its Compose plugin
  ([install Docker](https://docs.docker.com/engine/install/)), and `git`.
  The deployment is tested on Ubuntu on x86-64.
- Ports 80 and 443 reachable from the internet, and nothing else listening on
  them.
- A domain whose DNS you control.

Size it for what agents do: they check out repositories, build them and run
their test suites, often for several people at once. Each workspace may use
up to 8 GB of memory and 4 CPUs by default (`POISE_WORKSPACE_MEMORY`,
`POISE_WORKSPACE_CPUS`); those are limits, not reservations. For three to
five people, start with:

- **CPU**: 8 cores. Builds and test suites are CPU-bound, and two people's
  agents often run at the same time.
- **Memory**: 16 GB, 32 GB if agents work on large codebases. An agent CLI
  and a test run each take several hundred megabytes to a few gigabytes.
- **Disk**: 150 GB of SSD. Each home volume holds about 1 GB of provider
  CLIs plus every repository its agents check out; the workspace image is
  about 1 GB, and every upgrade adds a new one and some build cache.

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
| `POISE_ADMINS` | GitHub logins that administer this Poise, separated by commas |
| `POISE_ACME_EMAIL` | The address Let's Encrypt writes to about certificates |

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
page then links to your workspace, your Poise Link devices and the admin page,
`https://poise.example.com/admin`. The admin page lists everyone who has
signed in, how they got access, and their workspace's state and image, and
lets you start, stop or restart a workspace and disable or enable a person.

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
   **Agent account**. Both must be signed in to `gh` in the workspace. Poise
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
   alerts while the browser is closed.

## Upgrades

```bash
deploy/upgrade.sh
```

It pulls the newest commit of the branch the checkout follows (fast-forward
only), rebuilds the workspace image, lets Compose recreate Caddy or the
gateway if they changed, and lists the workspaces that run an older image.

The gateway upgrades those workspaces by itself, when it starts and every
five minutes. It drains a running workspace first: the workspace refuses new
Chat turns and agent launches, which then answer that Poise is installing an
update, and lets running work finish. Once it is idle, or after
`POISE_DRAIN_TIMEOUT` seconds (30 minutes by default), the gateway recreates
the container on the new image with the same home volume. A stopped
workspace is recreated without being started. Follow it in the gateway's log:

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
than recreating the workspace undrained.

To roll back, check out the earlier commit and apply it without pulling;
return to the branch the same way:

```bash
git checkout <commit>
deploy/upgrade.sh --no-pull
git checkout main
deploy/upgrade.sh
```

Every upgrade keeps the previous image under its commit tag. List them with
`docker image ls poise-runtime`, and remove the ones you no longer need with
`docker image rm poise-runtime:<commit>` and `docker builder prune`.

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

## Backups

```bash
deploy/backup.sh [DIRECTORY]
```

It backs up the gateway's volume and every home volume into a new directory
named after the time (UTC), in `DIRECTORY` or `deploy/backups`, while
everything keeps running. Each volume becomes one gzipped tar beside a
`SHA256SUMS` file. SQLite databases go in as snapshots taken with SQLite's
online backup, so each is consistent even while Poise writes to it; their
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

A workspace that runs under gVisor (`POISE_WORKSPACE_RUNTIME=runsc`) is
outside the reach of SQLite's locks from the backup's container, so a busy
one may be caught mid-write; `deploy/backup.sh` warns about each. Stop such a
workspace on the admin page before the backup when you need a copy that is
certainly consistent.

## Restore

```bash
deploy/restore.sh BACKUP
```

`BACKUP` is one of the directories `deploy/backup.sh` writes. The script
checks the archives against `SHA256SUMS`, then creates each volume anew and
fills it, keeping owners and permissions. It never overwrites a volume: if
one already exists it stops before touching anything, and if it fails it
removes the volumes it created.

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

## Logs

From `deploy/`:

- `docker compose logs --follow gateway`: one JSON object per line, each with
  an `event`, such as `auth.signed_in`, `workspace.container.started`,
  `workspace.upgrade.finished`, and every refusal and error.
- `docker compose logs --follow caddy`: certificates and Caddy's errors.

A workspace logs to `docker logs --follow poise-ws-<handle>`. The provider
CLI installation logs inside it:
`docker exec poise-ws-<handle> cat /home/poise/.poise/logs/cli-bootstrap.log`.

Docker keeps container logs without a size limit unless told otherwise. Set
a limit for every container, workspaces included, in
`/etc/docker/daemon.json`, and restart Docker:

```json
{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "5" } }
```

## Troubleshooting

- **`install.sh` says a port is in use.** Another web server holds port 80
  or 443; stop it. `sudo ss -ltnp 'sport = :443'` names it.
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
  `workspace.drain`, `workspace.upgrade` and `workspace.network` events in its
  log.
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
  on (see [Upgrades](#upgrades)).
- **Sign-in and sessions.** Caddy serves everything over TLS. Session
  cookies are `Secure`, `HttpOnly` and `SameSite=Lax`. A workspace host
  serves its owner only; an admin gets no access to it either. The gateway
  stores no GitHub token, and keeps only hashes of session ids, tickets and
  device tokens.
- **Secrets on disk**: the OAuth App's client secret in `deploy/.env`, the
  gateway's signing key in `poise-gateway-data`, and each person's CLI
  credentials in their home volume. Backups hold the last two.
