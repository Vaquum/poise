# Workspace runtime image

`deploy/runtime/` builds `poise-runtime`, the image of every person's
workspace container. The gateway creates those containers as
[docs/Service-architecture.md](../../docs/Service-architecture.md) ("Workspace
runtime contract") describes: uid 10001, the home volume at `/home/poise`, the
contract's environment, `init`, no capabilities.

Build it from the repository root; `.dockerignore` keeps dependencies, builds
and local state out of the context:

```bash
docker build --file deploy/runtime/Dockerfile --tag poise-runtime .
```

## Contents

- Node 22 and Poise in `/opt/poise`: the built `dist/`, the production
  `node_modules`, `scripts/` and `caller/`, which is agent-interface's working
  directory (`AGENT_INTERFACE_ROOT`).
- Python 3.13 and Caller's three CLIs in the virtualenv `/opt/caller/venv`
  (`CALLER_BIN_ROOT`); agent-interface keeps its data in
  `~/.poise/agent-interface` (`AGENT_INTERFACE_DATA_DIR`).
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
4. becomes `node /opt/poise/dist/server.js`. The image never rebuilds Poise
   the way `scripts/start-production.mjs` does on a personal computer.

The health check is `GET /api/service/health` over loopback.

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

`test/smoke.sh` runs containers the way the gateway does and checks the image:

- `contract`: loopback health; identity assertions from another container on
  the workspace network (unsigned, forged, expired, wrong audience, subject,
  scope and host are refused; the right ones get through); uid 10001 under
  tini; the toolchain and Caller's CLIs; the entrypoint's refusals.
- `offline`: with no network every install fails, is logged, and Poise keeps
  answering.
- `bootstrap`: installs the five CLIs for real, finds them with Poise's
  updater, and installs nothing again after a restart.

`.github/workflows/runtime-image.yml` builds the image and runs all three;
`bootstrap` only when files in `deploy/runtime/` change.
