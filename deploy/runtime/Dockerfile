# syntax=docker/dockerfile:1

# The poise-runtime image: one workspace container per person, which the
# gateway creates as docs/Service-architecture.md ("Workspace runtime
# contract") describes. Build it from the repository root:
#
#   docker build --file deploy/runtime/Dockerfile --tag poise-runtime .

# Poise, built once; the image ships its production dependencies only.
FROM node:22-bookworm AS poise
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# .dockerignore leaves .git out, so the builder declares the commit:
# deploy/install.sh and deploy/upgrade.sh pass it for a clean checkout, and
# /api/service/health reports it as `version`. Without it the image is a
# development build, whose version is null (scripts/build-identity.mjs).
ARG POISE_SOURCE_SHA
# The only optional production packages are the Agent SDK's platform builds.
# Each carries a bundled Claude Code binary (about 230 MB) that Poise never
# runs: it starts the standalone `claude` through scripts/claude-subscription.mjs.
RUN npm run build && npm prune --omit=dev --omit=optional

# Caller: Python 3.13 from uv (pinning uv pins the Python release it
# installs) and the three CLIs installed, not editable, into a virtualenv.
FROM debian:bookworm-slim AS caller
COPY --from=ghcr.io/astral-sh/uv:0.12.22 /uv /usr/local/bin/uv
ENV UV_PYTHON_INSTALL_DIR=/opt/python UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 UV_NO_CACHE=1
COPY caller /src/caller
RUN uv python install 3.13 \
 && uv venv --python 3.13 /opt/caller/venv \
 && uv pip install --python /opt/caller/venv/bin/python \
      /src/caller/agent_interface /src/caller/github_interface /src/caller/github_datastore

# Release signing keys, each checked against the fingerprints its publisher
# lists: the GitHub CLI apt repository's
# (https://github.com/cli/cli/blob/trunk/docs/install_linux.md) and Claude
# Code's (https://code.claude.com/docs/en/setup#binary-integrity-and-code-signing).
FROM node:22-bookworm AS keys
WORKDIR /keys
RUN <<'EOF'
set -eu
only_listed_keys() {
  keyring=$1
  shift
  found=$(gpg --show-keys --with-colons "$keyring" | awk -F: '$1 == "pub" { pub = 1; next } pub && $1 == "fpr" { print $10; pub = 0 }')
  if [ -z "$found" ]; then
    echo "$keyring holds no key" >&2
    exit 1
  fi
  for key in $found; do
    case " $* " in
      *" $key "*) ;;
      *) echo "$keyring holds key $key, which its publisher does not list" >&2; exit 1 ;;
    esac
  done
}
curl -fsSL -o githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg
only_listed_keys githubcli-archive-keyring.gpg 2C6106201985B60E6C7AC87323F3D4EA75716059 7F38BBB59D064DBCB3D84D725612B36462313325
curl -fsSL -o claude-code.asc https://downloads.claude.ai/keys/claude-code.asc
gpg --dearmor < claude-code.asc > claude-code.gpg
only_listed_keys claude-code.gpg 31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE
EOF

FROM node:22-bookworm-slim
# deploy/lib.sh removes the workspace images an upgrade leaves without a tag by this label.
LABEL poise.image=runtime

COPY --from=keys /keys/githubcli-archive-keyring.gpg /etc/apt/keyrings/githubcli-archive-keyring.gpg
# install-clis.sh checks Claude Code's signed release manifest with it.
COPY --from=keys /keys/claude-code.gpg /usr/share/keyrings/claude-code.gpg

# Agents run the real test suites of arbitrary repositories in here, so the
# image carries a working build toolchain beside the everyday tools.
RUN <<'EOF'
set -eu
apt-get update
apt-get install --yes --no-install-recommends ca-certificates
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  > /etc/apt/sources.list.d/github-cli.list
apt-get update
apt-get install --yes --no-install-recommends \
  build-essential curl gh git gpgv jq less locales openssh-client procps ripgrep tini unzip xz-utils
sed -i 's/^# *\(en_US.UTF-8 UTF-8\)$/\1/' /etc/locale.gen
locale-gen
rm -rf /var/lib/apt/lists/*
EOF

# The gateway runs the container as uid 10001. A new named volume mounted at
# /home/poise starts as a copy of this directory, ownership included.
RUN groupadd --gid 10001 poise \
 && useradd --uid 10001 --gid 10001 --home-dir /home/poise --create-home --shell /bin/bash poise \
 && chmod 700 /home/poise

COPY --from=caller /opt/python /opt/python
COPY --from=caller /opt/caller/venv /opt/caller/venv
COPY --from=poise /src/package.json /opt/poise/package.json
COPY --from=poise /src/node_modules /opt/poise/node_modules
COPY --from=poise /src/dist /opt/poise/dist
COPY scripts /opt/poise/scripts
COPY caller /opt/poise/caller
COPY deploy/runtime/entrypoint.sh deploy/runtime/install-clis.sh /opt/poise/deploy/runtime/

# The provider CLIs come first on PATH: they live in the home volume and
# update themselves there. No identity is baked in; the gateway passes it.
# agent-interface opens its data directory as soon as it starts and would
# otherwise look for it inside the read-only virtualenv; service mode names
# the same directory for the processes Poise starts.
ENV HOME=/home/poise \
    PATH=/home/poise/.local/bin:/opt/caller/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=en_US.UTF-8 \
    NODE_ENV=production \
    CALLER_BIN_ROOT=/opt/caller/venv/bin \
    AGENT_INTERFACE_ROOT=/opt/poise/caller/agent_interface \
    AGENT_INTERFACE_DATA_DIR=/home/poise/.poise/agent-interface \
    POISE_HOST=0.0.0.0 \
    POISE_PORT=5555

USER 10001:10001
WORKDIR /opt/poise
EXPOSE 5555

# The gateway also starts the container with `init`, which makes Docker's own
# tini PID 1 and this one its child. -s registers this one as a child
# subreaper, so it still reaps what the agents orphan and forwards signals to
# Poise; started without `init`, it is PID 1 itself. Either way each signal
# reaches Poise once and every orphan is reaped.
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/opt/poise/deploy/runtime/entrypoint.sh"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${POISE_PORT}/api/service/health" || exit 1
