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

# Docker Compose on deploy/compose.yaml, or on the files COMPOSE_FILE names,
# with compose.proxy.yaml added when deploy/.env sets POISE_PROXY_LISTEN.
# deploy/.env is the only source of settings: a POISE_ variable exported in
# this shell would otherwise take its place in compose.yaml, unchecked.
compose() {
  local files=${COMPOSE_FILE:-compose.yaml} name exported=()
  if [ -n "$(proxy_listen)" ]; then files=$files:compose.proxy.yaml; fi
  for name in $(compgen -e); do
    if [[ $name == POISE_* ]]; then exported+=(-u "$name"); fi
  done
  (cd "$deploy" && env "${exported[@]}" COMPOSE_FILE="$files" docker compose "$@")
}

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

# The address the gateway is published on for a proxy the server already
# runs (POISE_PROXY_LISTEN); empty when this installation's own Caddy fronts it.
proxy_listen() {
  if [ -r "$env_file" ]; then env_value POISE_PROXY_LISTEN; fi
}

# Whether VALUE is one IPv4 address, or one IPv6 address in brackets, and a
# port: never a port alone, 0.0.0.0 or [::], which Docker publishes on every
# address. The gateway checks the IPv6 form in full when it starts.
listen_address() {
  local octet
  [[ $1 =~ ^(\[[0-9A-Fa-f:.]+\]|[0-9.]+):([1-9][0-9]{0,4})$ ]] || return 1
  [ "${BASH_REMATCH[2]}" -le 65535 ] || return 1
  case ${BASH_REMATCH[1]} in
    \[*) [[ ! ${BASH_REMATCH[1]} =~ ^\[[0:]*\]$ ]] ;;
    0.0.0.0) return 1 ;;
    *)
      [[ ${BASH_REMATCH[1]} =~ ^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$ ]] || return 1
      for octet in "${BASH_REMATCH[@]:1}"; do
        [ "$octet" -le 255 ] || return 1
      done
      ;;
  esac
}

require_env_file() {
  local mode name proxy missing=() required=(POISE_DOMAIN POISE_GITHUB_CLIENT_ID POISE_GITHUB_CLIENT_SECRET POISE_ADMINS)
  [ -f "$env_file" ] || die "$env_file does not exist. Create it from the template, then fill it in:
  cp $deploy/.env.example $env_file
  chmod 600 $env_file"
  [ -r "$env_file" ] || die "cannot read $env_file; run this as the user who owns it."
  mode=$(stat -c %a "$env_file")
  [ $((8#$mode & 8#077)) -eq 0 ] \
    || die "$env_file holds the GitHub OAuth App's client secret, but its mode $mode lets others read it. Run: chmod 600 $env_file"
  proxy=$(env_value POISE_PROXY_LISTEN)
  # Behind the server's own proxy, that proxy obtains the certificates.
  if [ -z "$proxy" ]; then required+=(POISE_ACME_EMAIL); fi
  for name in "${required[@]}"; do
    [ -n "$(env_value "$name")" ] || missing+=("$name")
  done
  [ ${#missing[@]} -eq 0 ] || die "$env_file sets no ${missing[*]}; $deploy/.env.example describes each."
  if [ -n "$proxy" ] && ! listen_address "$proxy"; then
    die "POISE_PROXY_LISTEN in $env_file is $proxy, but it must be the one IP address and port your proxy reaches the gateway at, such as 127.0.0.1:8080 or [::1]:8080. A port alone, 0.0.0.0 or [::] would publish the gateway's plain http on every address."
  fi
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

# Docker's build cache may keep this much once a deploy finishes: the layers
# the next build reuses. The cache is shared with the server's other builds.
build_cache_limit=5GB

# Removes what earlier builds left behind: workspace images under older commit
# tags, Poise images that lost their tag to a newer build (labelled
# poise.image), and build cache beyond build_cache_limit. It keeps IMAGE, the
# build before it, so a rollback to that commit rebuilds from cache, and every
# image a container uses: a workspace the gateway has yet to recreate keeps
# its image until a later deploy. Nothing here stops a deploy.
prune_docker_storage() {
  local image=$1 name=$1 current ids used='' tag id previous='' removed=0 help cache_flag=--keep-storage
  if [[ ${image##*/} == *:* ]]; then name=${image%:*}; fi
  current=$(docker image inspect --format '{{.Id}}' "$image") || return 0
  ids=$(docker ps --all --quiet) || return 0
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086 # one argument per container ID
    used=" $(docker inspect --format '{{.Image}}' $ids 2>/dev/null | tr '\n' ' ')" || true
  fi
  while read -r _ id tag; do
    if [ "$id" = "$current" ]; then continue; fi
    if [ -z "$previous" ]; then
      previous=$tag
      continue
    fi
    if [[ $used == *" $id "* ]]; then continue; fi
    if docker image rm "$name:$tag" >/dev/null; then
      removed=$((removed + 1))
    else
      warn "could not remove the workspace image $name:$tag; the next deploy tries again."
    fi
  done < <(
    for tag in $(docker image ls "$name" --format '{{.Tag}}' | grep -E '^[0-9a-f]{40}$'); do
      printf '%s %s\n' "$(docker image inspect --format '{{.Created}} {{.Id}}' "$name:$tag")" "$tag"
    done | sort -r
  )
  if [ $removed -gt 0 ]; then say "Removed $removed workspace images of earlier commits."; fi
  docker image prune --force --filter label=poise.image >/dev/null \
    || warn "could not remove Poise images that lost their tag; the next deploy tries again."
  # Docker 28 and later name the limit --max-used-space; earlier ones --keep-storage.
  help=$(docker builder prune --help 2>&1) || true
  if [[ $help == *--max-used-space* ]]; then cache_flag=--max-used-space; fi
  if docker builder prune --force "$cache_flag" "$build_cache_limit" >/dev/null; then
    say "Docker's build cache keeps at most $build_cache_limit."
  else
    warn "could not trim Docker's build cache to $build_cache_limit; the next deploy tries again."
  fi
}

# A recreated gateway container is on Compose's network alone; the gateway
# joins every workspace's network itself as it starts, before it answers. Once
# it answers, check that it shares a network with each running workspace,
# which it must reach to drain it before an upgrade.
check_gateway_networks() {
  local attached handle
  attached=" $(docker inspect --format '{{range $name, $settings := .NetworkSettings.Networks}}{{$name}} {{end}}' "$gateway")"
  for handle in $(docker ps --filter label=poise.managed=true --format '{{.Label "poise.workspace"}}'); do
    [[ $attached == *" poise-net-$handle "* ]] \
      || die "the gateway is not on poise-net-$handle, so it cannot reach the running workspace of $handle, nor drain it before an upgrade. Its log says why: docker logs $gateway 2>&1 | grep workspace.network"
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
