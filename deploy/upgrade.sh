#!/bin/bash
# Upgrades the Poise service to the newest commit of the branch this checkout
# follows: pulls it, rebuilds the workspace image, lets Docker Compose
# recreate what changed, and says which workspaces the gateway will now drain
# and recreate on the new image. docs/Operating.md describes upgrades.
#
#   deploy/upgrade.sh             pull, then apply
#   deploy/upgrade.sh --no-pull   apply the checkout as it is, e.g. to roll back
set -euo pipefail
# shellcheck source=deploy/lib.sh
. "$(dirname "$0")/lib.sh"

# The base an image's releases run on (deploy/runtime/Dockerfile), or nothing.
image_base() {
  local base
  base=$(docker image inspect --format '{{index .Config.Labels "poise.base"}}' "$1" 2>/dev/null) || return 0
  [ "$base" = '<no value>' ] || printf '%s' "$base"
}

# What the gateway will do with each workspace now that IMAGE is new, said the
# moment the image is built: the gateway may start on one right after.
plan_workspaces() {
  local image=$1 image_id ids lines handle id running drain base outdated=0
  image_id=$(docker image inspect --format '{{.Id}}' "$image")
  base=$(image_base "$image")
  drain=$(env_value POISE_DRAIN_TIMEOUT)
  ids=$(docker ps --all --quiet --filter label=poise.managed=true)
  if [ -z "$ids" ]; then
    say "No workspace exists yet."
    return
  fi
  # shellcheck disable=SC2086 # one argument per container ID
  lines=$(docker inspect --format '{{index .Config.Labels "poise.workspace"}} {{.Image}} {{.State.Running}}' $ids)
  while read -r handle id running; do
    if [ "$id" = "$image_id" ]; then continue; fi
    if [ $outdated -eq 0 ]; then say "These workspaces run an older image; the gateway recreates each on $image:"; fi
    outdated=$((outdated + 1))
    if [ "$running" = true ] && [ -n "$base" ] && [ "$(image_base "$id")" = "$base" ]; then
      say "  $handle: running. The gateway installs the new release in it, and Poise restarts on it alone within seconds, once no Chat turn runs; agents carry on."
    elif [ "$running" = true ]; then
      say "  $handle: running. The gateway drains it first: it takes no new work and finishes what runs, for at most ${drain:-1800} seconds."
    else
      say "  $handle: stopped. The gateway recreates it and leaves it stopped."
    fi
  done <<<"$lines"
  if [ $outdated -eq 0 ]; then
    say "Every workspace already runs $image."
  else
    say "The gateway does this by itself, when it starts and every five minutes after. Follow it with:
  docker logs --follow $gateway 2>&1 | grep workspace."
  fi
}

case ${1:-} in
  '')
    require_linux
    require_docker
    require_env_file
    say "Pulling the newest commit into $root."
    git -C "$root" pull --ff-only
    # The rest runs as the version just pulled, so an upgrade that changes these scripts applies at once.
    exec "$deploy/upgrade.sh" --no-pull
    ;;
  --no-pull) [ $# -eq 1 ] || die "usage: $0 [--no-pull]" ;;
  *) die "usage: $0 [--no-pull]" ;;
esac

require_linux
require_docker
require_env_file
image=$(runtime_image)
sha=$(source_sha)
build_runtime_image "$image" "$sha"
plan=$(plan_workspaces "$image")
say "Recreating what changed."
compose up --detach --build
wait_for_gateway
check_gateway_networks
say "$plan"
