#!/bin/sh
# Starts a workspace: checks the environment the gateway passes
# (docs/Service-architecture.md, "Workspace runtime contract"), prepares the
# home volume, starts the provider CLI bootstrap in the background and then
# becomes Poise.
set -eu

missing=
for name in POISE_MODE POISE_WORKSPACE_HANDLE POISE_WORKSPACE_OWNER POISE_PUBLIC_ORIGIN POISE_GATEWAY_PUBLIC_KEY POISE_HOST POISE_PORT HOME; do
  eval "value=\${$name:-}"
  [ -n "$value" ] || missing="$missing $name"
done
if [ -n "$missing" ]; then
  echo "poise-runtime: missing environment:$missing. The gateway passes these to every workspace (docs/Service-architecture.md, \"Workspace runtime contract\")." >&2
  exit 1
fi

skip_bootstrap=${POISE_SKIP_CLI_BOOTSTRAP:-0}
case "$skip_bootstrap" in
  0 | 1) ;;
  *)
    echo "poise-runtime: POISE_SKIP_CLI_BOOTSTRAP must be 0 or 1, not \"$skip_bootstrap\"." >&2
    exit 1
    ;;
esac

prepare_home() {
  [ -d "$HOME/.poise" ] || mkdir -m 700 "$HOME/.poise" || return
  mkdir -p "$HOME/.poise/logs" "$HOME/.local/bin" "$HOME/.cache"
}
if ! prepare_home; then
  echo "poise-runtime: $HOME must be writable by uid $(id -u), the workspace user." >&2
  exit 1
fi

if [ "$skip_bootstrap" = 1 ]; then
  echo "poise-runtime: not installing provider CLIs (POISE_SKIP_CLI_BOOTSTRAP=1)."
else
  echo "poise-runtime: installing missing provider CLIs in the background; see $HOME/.poise/logs/cli-bootstrap.log."
  # The subshell exits at once, so tini adopts the bootstrap and reaps it:
  # Poise, which this process becomes, never has a child it did not start.
  (/opt/poise/deploy/runtime/install-clis.sh &)
fi

# The supervisor runs Poise from the current release and restarts it onto a
# newly installed one, while the agents Poise started keep running.
cd /opt/poise
exec node /opt/poise-runtime/supervisor.mjs
