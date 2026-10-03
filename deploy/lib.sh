# shellcheck shell=bash
# What the operator scripts beside this file share. They source it; it is
# never run on its own.

deploy=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$deploy/.." && pwd)
env_file=$deploy/.env
gateway=poise-gateway

say() { printf '%s\n' "$*"; }
warn() { printf 'poise: warning: %s\n' "$*" >&2; }
die() {
  printf 'poise: %s\n' "$*" >&2
  exit 1
}

# Docker Compose on deploy/compose.yaml; COMPOSE_FILE, when set, adds files.
compose() { (cd "$deploy" && docker compose "$@"); }

require_linux() {
  [ "$(uname -s)" = Linux ] || die "run this on the Linux server that hosts Poise; this is $(uname -s)."
}

require_docker() {
  local server
  command -v docker >/dev/null \
    || die "Docker is not installed. Install Docker Engine 24 or newer with its Compose plugin: https://docs.docker.com/engine/install/"
  server=$(docker version --format '{{.Server.Version}}' 2>&1) \
    || die "cannot reach the Docker Engine. Start it, and run this as root or as a member of the docker group. Docker said: $server"
  if ! [[ $server =~ ^([0-9]+)\. ]] || [ "${BASH_REMATCH[1]}" -lt 24 ]; then
    die "this is Docker Engine $server; Poise needs 24 or newer."
  fi
  docker compose version >/dev/null 2>&1 \
    || die "the Docker Compose plugin is missing ('docker compose' does not run). Install it: https://docs.docker.com/compose/install/linux/"
}

# The value deploy/.env gives NAME, as Compose reads a NAME=value line: without
# surrounding quotes, or else without a trailing comment; empty when unset.
env_value() {
  local line value
  line=$(grep -E "^[[:space:]]*$1[[:space:]]*=" "$env_file" | tail -n 1) || true
  value=${line#*=}
  value=${value#"${value%%[![:space:]]*}"}
  case $value in
    \"* | \'*) ;;
    *) value=${value%%[[:space:]]#*} ;;
  esac
  value=${value%"${value##*[![:space:]]}"}
  case $value in
    \"*\" | \'*\') value=${value:1:${#value}-2} ;;
  esac
  printf '%s' "$value"
}

require_env_file() {
  local mode name missing=()
  [ -f "$env_file" ] || die "$env_file does not exist. Create it from the template, then fill it in:
  cp $deploy/.env.example $env_file
  chmod 600 $env_file"
  [ -r "$env_file" ] || die "cannot read $env_file; run this as the user who owns it."
  mode=$(stat -c %a "$env_file")
  [ $((8#$mode & 8#077)) -eq 0 ] \
    || die "$env_file holds the GitHub OAuth App's client secret, but its mode $mode lets others read it. Run: chmod 600 $env_file"
  for name in POISE_DOMAIN POISE_GITHUB_CLIENT_ID POISE_GITHUB_CLIENT_SECRET POISE_ADMINS POISE_ACME_EMAIL; do
    [ -n "$(env_value "$name")" ] || missing+=("$name")
  done
  [ ${#missing[@]} -eq 0 ] || die "$env_file sets no ${missing[*]}; $deploy/.env.example describes each."
}

# The workspace image the gateway runs: POISE_RUNTIME_IMAGE as Compose resolves it.
runtime_image() {
  local image
  image=$(compose config --format json | sed -n 's/^ *"POISE_RUNTIME_IMAGE": "\(.*\)",\{0,1\}$/\1/p' | head -n 1)
  [ -n "$image" ] || die "Docker Compose resolved no POISE_RUNTIME_IMAGE from $deploy/compose.yaml"
  case $image in
    *@*) die "POISE_RUNTIME_IMAGE is $image, a digest; name a tag this server builds, such as poise-runtime:latest." ;;
  esac
  printf '%s' "$image"
}

# The commit the checkout is at, or nothing when its files differ from that
# commit: an image built from them is then a development build, whose
# /api/service/health reports version null.
source_sha() {
  local head changes
  head=$(git -C "$root" rev-parse --verify HEAD) || die "$root is not a git checkout of Poise."
  changes=$(git -C "$root" status --porcelain --untracked-files=normal) || die "git status failed in $root."
  if [ -n "$changes" ]; then
    warn "$root has changes that are not committed, so the workspace image is a development build and reports version null. The changes:
$(head -n 10 <<<"$changes")"
    return
  fi
  printf '%s' "$head"
}

# Builds the workspace image as IMAGE and, for a commit SHA, also as
# <IMAGE without its tag>:<SHA>.
build_runtime_image() {
  local image=$1 sha=$2 tags=(--tag "$1") name=$1
  if [ -n "$sha" ]; then
    if [[ ${image##*/} == *:* ]]; then name=${image%:*}; fi
    tags+=(--tag "$name:$sha")
  fi
  say "Building the workspace image $image${sha:+ at $sha}. The first build takes several minutes."
  docker build --file "$root/deploy/runtime/Dockerfile" --build-arg "POISE_SOURCE_SHA=$sha" "${tags[@]}" "$root"
}

# A recreated gateway container is on Compose's network alone: the workspace
# networks it had joined stay with the container it replaced. It reaches and
# drains running workspaces over those networks, so join them again.
reattach_gateway() {
  local attached network
  attached=" $(docker inspect --format '{{range $name, $settings := .NetworkSettings.Networks}}{{$name}} {{end}}' "$gateway")"
  for network in $(docker network ls --filter name=poise-net- --format '{{.Name}}'); do
    if [[ $network == poise-net-* && $attached != *" $network "* ]]; then
      docker network connect "$network" "$gateway"
      say "The gateway joined $network again."
    fi
  done
}

wait_for_gateway() {
  local first status health restarts deadline=$((SECONDS + 180))
  first=$(docker inspect --format '{{.RestartCount}}' "$gateway") || die "there is no $gateway container."
  say "Waiting for the gateway to answer."
  while :; do
    if ! read -r status health restarts < <(docker inspect --format \
      '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}}' "$gateway"); then
      die "the $gateway container went away while it started."
    fi
    if [ "$status" = running ] && [ "$health" = healthy ]; then
      say "The gateway is up."
      return
    fi
    if [ "$status" != running ] || [ "$health" = unhealthy ] || [ "$restarts" != "$first" ] || [ $SECONDS -ge $deadline ]; then
      compose logs --tail 40 gateway >&2
      die "the gateway is not answering (container $status, health $health, restarted $((restarts - first)) times); its log is above."
    fi
    sleep 2
  done
}
