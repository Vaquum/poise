# Workspace runtime image

`deploy/runtime/` builds `poise-runtime`, the image of every person's
workspace container. The gateway creates those containers as
[docs/Service-architecture.md](../../docs/Service-architecture.md) ("Workspace
runtime contract") describes: uid 10001, the home volume at `/home/poise`, the
contract's environment, `init`, no capabilities, restart policy
`unless-stopped`.

Build it from the repository root; `.dockerignore` keeps dependencies, builds
and local state out of the context:

```bash
docker build --file deploy/runtime/Dockerfile --tag poise-runtime .
```

The context has no `.git`, so the image cannot tell which commit it was built
from: `/api/service/health` reports `version: null`. The build argument
`POISE_SOURCE_SHA` declares the commit; `deploy/install.sh` and
`deploy/upgrade.sh` pass it whenever the checkout is clean:

```bash
docker build --file deploy/runtime/Dockerfile --tag poise-runtime \
  --build-arg POISE_SOURCE_SHA="$(git rev-parse HEAD)" .
```

## Contents

- Node 22 and Poise in `/opt/poise`: the built `dist/`, the production
  `node_modules`, `scripts/` and `caller/`, which is agent-interface's working
  directory (`AGENT_INTERFACE_ROOT`). `/opt/poise/RELEASE` names this release.
- Python 3.13 and Caller's three CLIs in the relocatable virtualenv
  `/opt/caller/venv` (`CALLER_BIN_ROOT`); agent-interface keeps its data in
  `~/.poise/agent-interface` (`AGENT_INTERFACE_DATA_DIR`).
- `/opt/poise-runtime`: `supervisor.mjs`, its `resource-witness.mjs` directory
  handles, `install-release.sh` and `BASE`, the
  base every release of this image runs on
  ([Updates in place](../../docs/Service-architecture.md#updates-in-place)).
- `gh` from GitHub's apt repository, `git`, `build-essential`,
  `openssh-client`, `curl`, `ripgrep`, `jq`, `unzip`, `xz-utils`, `less`,
  `procps`, `tini` and the `en_US.UTF-8` locale.
- The user `poise`, uid and gid 10001, with the home `/home/poise`.

`PATH` starts with `~/.local/bin`, then the Caller virtualenv. The image holds
no provider CLI and no identity: the gateway passes the identity, and the CLIs
live in the home volume.

## Start

The entrypoint is tini, as a child subreaper beneath Docker's own `init`,
running `entrypoint.sh`. That script

1. stops, naming each variable, when the contract's environment is incomplete;
2. creates `~/.poise` (mode 700), `~/.poise/logs`, `~/.local/bin` and `~/.cache`;
3. starts `install-clis.sh` in the background unless
   `POISE_SKIP_CLI_BOOTSTRAP=1`;
4. becomes `node /opt/poise-runtime/supervisor.mjs`, which runs Poise from
   the current release, or this image's own, and restarts it onto a newly
   installed release while the agents it started keep running. The image
   never rebuilds Poise the way `scripts/start-production.mjs` does on a
   personal computer.

The health check is `GET /api/service/health` over loopback.

The supervisor also retains native cleanup witnesses across Poise release
switches. The private controller and supported-runtime gate are defined in
[Service architecture](../../docs/Service-architecture.md#workspace-behavior-observation).
Unsupported hosts retain v1; the image does not enable v2 or configure a host
runtime automatically.

`deploy/runtime/test/native-cleanup.sh IMAGE runsc` checks the actual service
entrypoint/gate and kernel teardown, sanitizer semantics and native Caller
resource serialization under the shipped uid/capability/security settings.
It distinguishes executor signals from explicit exits in the original Call's
diagnostics. A separate isolated supervisor exercises the real service switch
with native review and implementation Calls held live through activation, then
checks those same Calls' publication receipts and resource release against a
no-switch workload. Providers and GitHub responses in this check are stand-ins.
`... IMAGE runc` separately checks refusal under Docker's default profile.
Resource-growth fixtures hold the initialized allocation child on stdin until
the independent observer asserts the complete tree starts below 256 MiB.
Memory cases require an independently observed overrun before enforced success,
alongside the existing termination, cleanup and live-neighbor checks.
The Runtime image workflow installs a pinned runsc only on its disposable CI
runner. Tests use isolated tmpfs and home-volume state, no network, no provider identities or
GitHub actions. They are component proof; the frozen real-provider campaign
remains separate.

The `cleaner-loss` fixture records a live-owner retry and the resulting skipped
recovery pass. It reserves only its selected Call while interrupting real cleanup
after the original root's unlink, including a nested directory with the same name.
Before allowing service maintenance to recover that Call, it checks the original
controller's positive unlink proof and the still-pending durable root and release
acknowledgements.

## Provider CLIs

`install-clis.sh` installs each CLI missing from `~/.local/bin` with its
vendor's own installer, and checks what the vendor publishes to check:

| CLI | Installer | Checked |
| --- | --- | --- |
| `claude` | the native release, set up by `claude install` | manifest signature, then the binary's SHA-256 |
| `codex` | `npm install --global --prefix ~/.local @openai/codex` | npm's registry integrity hash |
| `grok` | `https://x.ai/cli/install.sh` | nothing published |
| `agy` | `https://antigravity.google/cli/install.sh` | the installer checks the SHA-512 |
| `muse` | `https://dev.meta.ai/install.sh` | the installer checks the SHA-256 |

It logs to `~/.poise/logs/cli-bootstrap.log`. A failed install names the
command and its exit code there, the other CLIs are still installed, and Poise
keeps running; Settings → Connected accounts shows the CLI as not installed,
and the next start tries again. From then on Poise's updater
(`scripts/provider-cli-updates.mjs`) keeps each CLI current where it is.

## Tests

`test/smoke.sh` runs containers with the gateway's settings and environment
(`gateway/src/orchestrator.ts`) and checks the image:

- `contract`: the workspace twice on one home volume, first with the plain-http
  origin of the gateway's `POISE_INSECURE_HTTP` runs, then with an https
  origin. Each time: health over loopback with every field the gateway reads;
  identity assertions from another container on the workspace network (the
  right ones get through; unsigned, bearer-only, forged, expired, wrong
  audience, subject, scope, host and origin scheme are refused). Then the
  image's user and uid 10001 under tini, the toolchain and Caller's CLIs, the
  home layout and the entrypoint's refusals.
- `offline`: with no network every install fails, is logged, and Poise keeps
  answering.
- `bootstrap`: installs the five CLIs for real, finds them with Poise's
  updater, and installs nothing again after a restart.

`.github/workflows/runtime-image.yml` builds the image and runs all three;
`bootstrap` only when files in `deploy/runtime/` change.
