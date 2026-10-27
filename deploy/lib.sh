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
  image=$(env_value POISE_RUNTIME_IMAGE)
  image=${image:-poise-runtime:latest}
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

# The base a workspace image's releases run on: a digest of the files that
# build the system around Poise. A workspace takes a new image of the same
# base in place; a new base recreates its container.
runtime_base() {
  (cd "$root/deploy/runtime" && cat Dockerfile entrypoint.sh install-clis.sh supervisor.mjs install-release.sh) \
    | sha256sum | cut -c1-16
}

# Builds the workspace image as IMAGE and, for a commit SHA, also as
# <IMAGE without its tag>:<SHA>. Its release is the commit, or a development
# build's own name.
build_runtime_image() {
  local image=$1 sha=$2 tags=(--tag "$1") name=$1 release
  if [ -n "$sha" ]; then
    if [[ ${image##*/} == *:* ]]; then name=${image%:*}; fi
    tags+=(--tag "$name:$sha")
  fi
  release=${sha:-development-$(date -u +%Y%m%d%H%M%S)}
  say "Building the workspace image $image${sha:+ at $sha}. The first build takes several minutes."
  docker build --file "$root/deploy/runtime/Dockerfile" --build-arg "POISE_SOURCE_SHA=$sha" \
    --build-arg "POISE_RELEASE=$release" --build-arg "POISE_BASE=$(runtime_base)" "${tags[@]}" "$root"
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

# How long verify_workspaces waits for every workspace to serve the deployed
# commit before it reports what is still pending instead of success.
verify_timeout_seconds=600
verify_poll_seconds=10
workspace_proof_file=$deploy/.env.workspace-proof

# Keep an unfinished deploy's obligations across process failure and retry.
# The checkout survives operator deploys; backups intentionally contain only
# volumes, and a successful restore starts a different inventory lifecycle.
save_workspace_proof() {
  local handles=$1 temporary
  temporary=$(mktemp "$workspace_proof_file.XXXXXX") || die "cannot create the workspace proof beside $workspace_proof_file."
  if ! printf '%s\n' "$handles" >"$temporary" || ! chmod 600 "$temporary" || ! mv "$temporary" "$workspace_proof_file"; then
    rm -f "$temporary"
    die "cannot retain the workspace proof at $workspace_proof_file."
  fi
}

clear_workspace_proof() {
  rm -f "$workspace_proof_file" || die "cannot clear the completed workspace proof at $workspace_proof_file."
}

# Capture the expected handles before building/retagging the runtime image:
# even the old gateway can notice that tag and start replacing containers.
# Container IDs change during replacement; these workspace labels do not.
workspace_handles() {
  local lines container handle retained='' handles=''
  [ ! -L "$workspace_proof_file" ] || die "the pending workspace proof must be a regular file, not a symbolic link."
  if [ -e "$workspace_proof_file" ]; then
    [ -f "$workspace_proof_file" ] || die "the pending workspace proof must be a regular file."
    retained=$(cat "$workspace_proof_file") || die "cannot read the pending workspace proof at $workspace_proof_file."
    [[ $retained =~ ^[a-z0-9[:space:]-]*$ ]] || die "the pending workspace proof contains an invalid workspace handle."
    for handle in $retained; do
      [[ $handle =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "the pending workspace proof contains an invalid workspace handle."
      handles="$handles$handle "
    done
  fi
  lines=$(docker ps --all --filter label=poise.managed=true --format '{{.ID}} {{.Label "poise.workspace"}}') \
    || die "cannot list the managed workspaces."
  if [ -n "$lines" ]; then
    while read -r container handle; do
      [ -n "$handle" ] || die "managed container $container has no poise.workspace label."
      [[ $handle =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "managed container $container has an invalid workspace handle."
      if [[ " $handles" != *" $handle "* ]]; then handles="$handles$handle "; fi
    done <<<"$lines"
  fi
  save_workspace_proof "$handles"
  printf '%s' "$handles"
}

# The string value of KEY in the flat JSON OBJECT, or empty when null or
# absent. Health answers hold only release names, ISO times and nulls under
# these keys, so no value carries a quote.
health_field() {
  printf '%s' "$1" | sed -n "s/.*\"$2\": *\"\([^\"]*\)\".*/\1/p"
}

# SECONDS as a person reads a wait: 45s, 12m05s, 3h04m, 2d05h.
format_age() {
  local total=$1 days hours minutes seconds
  days=$((total / 86400))
  hours=$(((total % 86400) / 3600))
  minutes=$(((total % 3600) / 60))
  seconds=$((total % 60))
  if [ "$days" -gt 0 ]; then printf '%dd%02dh' "$days" "$hours"
  elif [ "$hours" -gt 0 ]; then printf '%dh%02dm' "$hours" "$minutes"
  elif [ "$minutes" -gt 0 ]; then printf '%dm%02ds' "$minutes" "$seconds"
  else printf '%ds' "$seconds"
  fi
}

# How long ago the ISO time was, as format_age reads it, or 'unknown' when it
# cannot be told (a workspace that predates pending tracking).
pending_age() {
  local since=$1 epoch now
  [ -n "$since" ] || {
    printf 'unknown'
    return
  }
  epoch=$(date -d "$since" +%s 2>/dev/null) || {
    printf 'unknown'
    return
  }
  now=$(date +%s)
  if [ "$epoch" -gt "$now" ]; then printf '0s'; else format_age $((now - epoch)); fi
}

# One workspace that does not serve the deployed commit yet, as the pending
# report shows it: its desired and active release, whether the desired one is
# installed, and how long the switch has been pending.
pending_line() {
  local handle=$1 active=$2 desired=$3 installed=$4 has_installed=$5 since=$6 line
  line="  $handle: pending ${desired:-(unknown)} (active ${active:-(unknown)}"
  if [ "$has_installed" = yes ] && [ -n "$desired" ] && [ "$installed" != "$desired" ]; then
    line="$line, not installed"
  fi
  printf '%s, pending %s)\n' "$line" "$(pending_age "$since")"
}

# Proves every managed workspace serves the deployed commit SHA: a running one
# answers its health check with that active release, a stopped one is on the
# new image and serves it on its next start. Waits up to
# verify_timeout_seconds for the gateway's upgrade to land; past that it
# reports what is still pending, with its age, instead of success. A
# development build (no SHA) has no release to prove.
verify_workspaces() {
  [ $# -eq 3 ] || die "verify_workspaces needs the workspace handles captured before building the image."
  local sha=$1 image=$2 expected=$3
  local image_id inventory ids lines pending waiting serving deadline announced observed
  local handle id running name health active desired installed has_installed since
  if [ -z "$sha" ]; then
    say "This is a development build, which reports no release; skipping workspace verification."
    return 0
  fi
  image_id=$(docker image inspect --format '{{.Id}}' "$image") || die "cannot read the workspace image $image."
  say "Waiting for every workspace to serve $sha."
  deadline=$((SECONDS + verify_timeout_seconds))
  announced=$SECONDS
  while :; do
    pending=''
    waiting=''
    serving=''
    observed=''
    # The gateway replaces containers as it recreates them, so list them anew every poll.
    inventory=$(docker ps --all --filter label=poise.managed=true --format '{{.ID}} {{.Label "poise.workspace"}}') \
      || die "cannot list the managed workspaces."
    ids=''
    if [ -n "$inventory" ]; then
      while read -r id handle; do
        [ -n "$handle" ] || die "managed container $id has no poise.workspace label."
        [[ $handle =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "managed container $id has an invalid workspace handle."
        # Retain the identity from this listing before inspection can race
        # with removal. A later empty poll must still require its replacement.
        if [[ " $expected" != *" $handle "* ]]; then
          expected="$expected$handle "
          save_workspace_proof "$expected"
        fi
        ids="$ids$id "
      done <<<"$inventory"
    fi
    if [ -n "$ids" ]; then
      # A container removed since docker ps is its replacement's business, not
      # a failed deploy: inspect still prints the containers it found, and the
      # expected-handles loop below reports the missing ones as pending.
      # shellcheck disable=SC2086 # one argument per container ID
      if ! lines=$(docker inspect --format '{{index .Config.Labels "poise.workspace"}} {{.Image}} {{.State.Running}} {{.Name}}' $ids 2>/dev/null); then
        # A newly listed workspace may not have supplied its handle yet.
        # Partial output cannot prove that either the inventory or deploy is complete.
        pending="$pending  workspace inventory: incomplete (a listed container could not be inspected)\n"
      fi
      while read -r handle id running name; do
        # No line at all when every container vanished since docker ps.
        [ -n "$handle$id$running$name" ] || continue
        name=${name#/}
        [ -n "$handle" ] || die "managed container $name has no poise.workspace label."
        [[ $handle =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "managed container $name has an invalid workspace handle."
        observed="$observed$handle "
        # New workspaces join the obligation; a disappearing container never
        # removes one captured before the upgrade or seen in an earlier poll.
        if [[ " $expected" != *" $handle "* ]]; then
          expected="$expected$handle "
          save_workspace_proof "$expected"
        fi
        if [ "$running" = true ]; then
          if health=$(docker exec "$name" curl -fsS --max-time 10 http://127.0.0.1:5555/api/service/health 2>/dev/null); then
            active=$(health_field "$health" release)
            if [ "$active" = "$sha" ]; then
              serving="$serving$handle "
              continue
            fi
            desired=$(health_field "$health" desiredRelease)
            if [ -z "$desired" ]; then desired=$(health_field "$health" switching); fi
            installed=$(health_field "$health" installedRelease)
            has_installed=no
            if [[ $health == *'"installedRelease"'* ]]; then has_installed=yes; fi
            since=$(health_field "$health" pendingSince)
            pending="$pending$(pending_line "$handle" "$active" "$desired" "$installed" "$has_installed" "$since")\n"
          else
            pending="$pending  $handle: unreachable (its health check did not answer)\n"
          fi
        elif [ "$id" = "$image_id" ]; then
          serving="$serving$handle (stopped) "
        else
          pending="$pending  $handle: stopped, still on an older image\n"
        fi
        waiting="$waiting$handle "
      done <<<"$lines"
    fi
    for handle in $expected; do
      if [[ " $observed" != *" $handle "* ]]; then
        pending="$pending  $handle: missing (waiting for its replacement)\n"
        waiting="$waiting$handle "
      fi
    done
    if [ -z "$expected" ] && [ -z "$pending" ]; then
      clear_workspace_proof
      say "No workspace exists yet."
      return 0
    fi
    if [ -z "$pending" ]; then
      clear_workspace_proof
      say "Every workspace serves $sha: ${serving% }."
      return 0
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      die "the deploy of $sha is still pending after ${verify_timeout_seconds}s: these workspaces do not serve it yet:
$(printf '%b' "$pending")"
    fi
    if [ -n "$waiting" ] && [ $((SECONDS - announced)) -ge 60 ]; then
      say "Still waiting for: ${waiting% }."
      announced=$SECONDS
    fi
    sleep "$verify_poll_seconds"
  done
}
