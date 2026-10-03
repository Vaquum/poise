#!/bin/bash
# Smoke tests for the poise-runtime image. Each starts containers the way the
# gateway does (docs/Service-architecture.md, "Workspace runtime contract")
# and checks what the image promises. CI runs them from
# .github/workflows/runtime-image.yml; anywhere with Docker and Node they run as
#
#   deploy/runtime/test/smoke.sh contract IMAGE   identity, user, tools, entrypoint checks
#   deploy/runtime/test/smoke.sh offline IMAGE    a failed CLI bootstrap leaves Poise running
#   deploy/runtime/test/smoke.sh bootstrap IMAGE  installs the provider CLIs (needs the internet)
#   deploy/runtime/test/smoke.sh logs IMAGE       prints what every smoke container logged
set -euo pipefail

if [ $# -ne 2 ]; then
  sed -n '7,10p' "$0" >&2
  exit 2
fi
mode=$1
image=$2
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

handle=octo-ci
# The owner's login in GitHub's case; the handle is the login in lower case.
owner=Octo-CI
host=$handle.poise.test
workspace=poise-ws-$handle
client=poise-smoke-client

pass() { echo "ok - $*"; }
fail() {
  echo "FAIL - $*" >&2
  exit 1
}

# A new volume, and a new network unless it is `none`, for CONTAINER.
fresh() {
  local container=$1 volume=$2 network=$3
  if docker container inspect "$container" >/dev/null 2>&1; then docker container rm --force "$container" >/dev/null; fi
  if docker volume inspect "$volume" >/dev/null 2>&1; then docker volume rm "$volume" >/dev/null; fi
  docker volume create "$volume" >/dev/null
  if [ "$network" != none ]; then
    if docker network inspect "$network" >/dev/null 2>&1; then docker network rm "$network" >/dev/null; fi
    docker network create "$network" >/dev/null
  fi
}

# A workspace container with the settings and environment the gateway gives
# one. The user is left to the image, which must make it uid 10001.
start_workspace() {
  local container=$1 volume=$2 network=$3 public_key=$4
  shift 4
  docker run --detach --name "$container" --label poise.smoke=1 \
    --init --security-opt no-new-privileges --cap-drop ALL --memory 4g --pids-limit 4096 \
    --network "$network" --mount "type=volume,source=$volume,target=/home/poise" \
    --health-interval 2s \
    --env POISE_MODE=service \
    --env POISE_WORKSPACE_HANDLE="$handle" \
    --env POISE_WORKSPACE_OWNER="$owner" \
    --env POISE_PUBLIC_ORIGIN="https://$host" \
    --env POISE_GATEWAY_PUBLIC_KEY="$public_key" \
    --env POISE_HOST=0.0.0.0 \
    --env POISE_PORT=5555 \
    --env HOME=/home/poise \
    "$@" "$image" >/dev/null
}

# The image's own health check, polled every two seconds.
wait_healthy() {
  local container=$1 state
  for _ in $(seq 1 90); do
    state=$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "$container")
    case "$state" in
      "running healthy") pass "$container is healthy"; return 0 ;;
      running*) sleep 2 ;;
      *) fail "$container stopped ($state) before it was healthy" ;;
    esac
  done
  fail "$container was not healthy within 180 seconds"
}

# Waits until the CLI bootstrap has finished COUNT times in CONTAINER and
# prints its log.
wait_for_bootstrap() {
  local container=$1 count=$2 seconds=$3 log
  for _ in $(seq 1 $((seconds / 5))); do
    [ "$(docker inspect --format '{{.State.Status}}' "$container")" = running ] || fail "$container stopped during the CLI bootstrap"
    if log=$(docker exec "$container" cat /home/poise/.poise/logs/cli-bootstrap.log 2>/dev/null) \
      && [ "$(grep -c 'bootstrap finished' <<<"$log")" -ge "$count" ]; then
      printf '%s\n' "$log"
      return 0
    fi
    sleep 5
  done
  fail "the CLI bootstrap did not finish within $seconds seconds"
}

identity() { node "$here/identity.mjs" assert "$@"; }

# One request from the client container on the workspace's network, the way
# the gateway sends them. Prints the status; the body stays in the client.
request() {
  local request_host=$1 path=$2
  shift 2
  docker exec "$client" curl --silent --show-error --max-time 10 --output /tmp/body \
    --write-out '%{http_code}' --header "Host: $request_host" "$@" "http://$workspace:5555$path"
}

expect() {
  local want=$1 what=$2 request_host=$3 path=$4 got
  shift 4
  got=$(request "$request_host" "$path" "$@")
  [ "$got" = "$want" ] || fail "$what: $path answered $got, not $want: $(docker exec "$client" cat /tmp/body)"
  pass "$what: $path answered $got"
}

body_has() {
  docker exec "$client" grep --quiet --fixed-strings -- "$1" /tmp/body \
    || fail "the answer lacks $1: $(docker exec "$client" cat /tmp/body)"
}

check_identity() {
  local key=$work/gateway.pem forger=$work/forger.pem aud=workspace:$handle
  expect 401 "an unsigned request" "$host" /api/service/health
  expect 401 "an unsigned request" "$host" /
  expect 200 "the gateway's admin assertion" "$host" /api/service/health \
    --header "X-Poise-Identity: $(identity "$key" "$aud" "$owner" admin)"
  body_has '"mode":"service"'
  expect 200 "the owner's browser assertion" "$host" / \
    --header "X-Poise-Identity: $(identity "$key" "$aud" "$owner" browser)"
  body_has '<title>Poise</title>'
  expect 401 "an assertion for another workspace" "$host" /api/service/health \
    --header "X-Poise-Identity: $(identity "$key" workspace:someone-else "$owner" admin)"
  expect 401 "an assertion for another person" "$host" / \
    --header "X-Poise-Identity: $(identity "$key" "$aud" someone-else browser)"
  expect 401 "an assertion signed with another key" "$host" /api/service/health \
    --header "X-Poise-Identity: $(identity "$forger" "$aud" "$owner" admin)"
  expect 401 "an expired assertion" "$host" /api/service/health \
    --header "X-Poise-Identity: $(identity "$key" "$aud" "$owner" admin 300)"
  expect 403 "a browser assertion on a service endpoint" "$host" /api/service/health \
    --header "X-Poise-Identity: $(identity "$key" "$aud" "$owner" browser)"
  expect 403 "a Link assertion on a service endpoint" "$host" /api/service/health \
    --header "X-Poise-Identity: $(identity "$key" "$aud" "$owner" link)"
  expect 403 "an admin assertion on the browser app" "$host" / \
    --header "X-Poise-Identity: $(identity "$key" "$aud" "$owner" admin)"
  expect 403 "another host" other.poise.test /api/service/health \
    --header "X-Poise-Identity: $(identity "$key" "$aud" "$owner" admin)"
}

check_user() {
  local pid uid ppid parent uids
  pid=$(docker exec "$workspace" pgrep --exact --oldest node) || fail "no node process runs"
  read -r uid ppid < <(docker exec "$workspace" ps -o uid=,ppid= -p "$pid")
  parent=$(docker exec "$workspace" ps -o comm= -p "$ppid")
  [ "$uid" = 10001 ] || fail "Poise runs as uid $uid"
  [ "$parent" = tini ] || fail "Poise's parent is $parent, not tini"
  uids=$(docker exec "$workspace" ps -e -o uid= | tr -d ' ' | sort -u | tr '\n' ' ')
  [ "$uids" = "10001 " ] || fail "the container's processes run as uids $uids"
  pass "Poise runs as uid 10001 under tini (PID 1 is $(docker exec "$workspace" ps -o comm= -p 1)); every process is uid 10001"
}

check_tools() {
  local command output
  for command in agent-interface github-interface github-datastore; do
    docker exec "$workspace" "$command" --help >/dev/null || fail "$command --help failed"
    pass "$command --help"
  done
  output=$(docker exec "$workspace" node --version)
  [[ $output == v22.* ]] || fail "node is $output, not Node 22"
  pass "node $output"
  output=$(docker exec "$workspace" sh -c 'command -v python3 && python3 --version')
  [[ $output == $'/opt/caller/venv/bin/python3\nPython 3.13.'* ]] || fail "python3 is $output"
  pass "python3: ${output//$'\n'/, }"
  for command in "gh --version" "git --version" "make --version" "gcc --version" "g++ --version" "rg --version" "jq --version"; do
    # shellcheck disable=SC2086 # each command is a name and an option
    output=$(docker exec "$workspace" $command) || fail "$command failed"
    pass "${output%%$'\n'*}"
  done
}

# Runs the image in the foreground with OPTIONS, expecting the entrypoint to
# refuse to start, and prints what it said.
refused() {
  local output code
  set +e
  output=$(docker run --rm --label poise.smoke=1 "$@" "$image" 2>&1)
  code=$?
  set -e
  [ "$code" = 1 ] || fail "the container exited $code instead of refusing to start: $output"
  printf '%s\n' "$output"
}

check_entrypoint() {
  local public_key=$1 output name
  output=$(refused)
  for name in POISE_MODE POISE_WORKSPACE_HANDLE POISE_WORKSPACE_OWNER POISE_PUBLIC_ORIGIN POISE_GATEWAY_PUBLIC_KEY; do
    grep --quiet --fixed-strings "$name" <<<"$output" || fail "the entrypoint does not name $name: $output"
  done
  pass "without the gateway's environment: $output"
  output=$(refused --env POISE_MODE=service --env POISE_WORKSPACE_HANDLE="$handle" --env POISE_WORKSPACE_OWNER="$owner" \
    --env POISE_PUBLIC_ORIGIN="https://$host" --env POISE_GATEWAY_PUBLIC_KEY="$public_key" --env POISE_SKIP_CLI_BOOTSTRAP=yes)
  grep --quiet --fixed-strings POISE_SKIP_CLI_BOOTSTRAP <<<"$output" || fail "the entrypoint accepted POISE_SKIP_CLI_BOOTSTRAP=yes: $output"
  pass "with POISE_SKIP_CLI_BOOTSTRAP=yes: $output"
}

# The entrypoint's home layout on a new volume, owned by the workspace user.
check_home() {
  local container=$1 layout
  layout=$(docker exec "$container" stat -c '%u:%g %a %n' /home/poise /home/poise/.poise \
    /home/poise/.poise/logs /home/poise/.local/bin /home/poise/.cache)
  awk '$1 != "10001:10001" { exit 1 }' <<<"$layout" || fail "the home volume is not uid 10001's: $layout"
  grep --quiet '^10001:10001 700 /home/poise/.poise$' <<<"$layout" || fail "/home/poise/.poise is not private: $layout"
  pass "the home volume is prepared: ${layout//$'\n'/, }"
}

contract() {
  local volume=poise-home-$handle network=poise-net-$handle public_key health
  if docker container inspect "$client" >/dev/null 2>&1; then docker container rm --force "$client" >/dev/null; fi
  fresh "$workspace" "$volume" "$network"
  public_key=$(node "$here/identity.mjs" key "$work/gateway.pem")
  node "$here/identity.mjs" key "$work/forger.pem" >/dev/null
  start_workspace "$workspace" "$volume" "$network" "$public_key" --env POISE_SKIP_CLI_BOOTSTRAP=1
  wait_healthy "$workspace"

  health=$(docker exec "$workspace" curl --fail --silent --show-error http://127.0.0.1:5555/api/service/health) \
    || fail "loopback health check failed"
  grep --quiet --fixed-strings '"mode":"service"' <<<"$health" || fail "loopback health answered $health"
  pass "loopback health: $health"

  docker run --detach --name "$client" --label poise.smoke=1 --network "$network" --no-healthcheck \
    --entrypoint sleep "$image" infinity >/dev/null
  check_identity
  check_user
  check_tools
  check_home "$workspace"
  check_entrypoint "$public_key"
}

offline() {
  local container=poise-ws-offline volume=poise-home-offline public_key log provider
  fresh "$container" "$volume" none
  public_key=$(node "$here/identity.mjs" key "$work/gateway.pem")
  # Without a network every install fails at once; npm would retry for a minute.
  start_workspace "$container" "$volume" none "$public_key" --env npm_config_fetch_retries=0
  wait_healthy "$container"
  check_home "$container"
  log=$(wait_for_bootstrap "$container" 1 300)
  for provider in claude codex grok antigravity muse; do
    grep --quiet "$provider: not installed" <<<"$log" || fail "the log does not report $provider as not installed: $log"
  done
  [ "$(grep --count 'command failed (exit [1-9][0-9]*): ' <<<"$log")" -ge 5 ] \
    || fail "the log does not name each failed command and its exit code: $log"
  grep --quiet 'bootstrap finished: not installed: claude codex grok antigravity muse' <<<"$log" || fail "no summary: $log"
  docker logs "$container" 2>&1 | grep --quiet 'provider CLIs not installed: claude codex grok antigravity muse' \
    || fail "the container's log does not report the failed bootstrap"
  docker exec "$container" curl --fail --silent --show-error http://127.0.0.1:5555/api/service/health >/dev/null \
    || fail "Poise stopped answering after the failed bootstrap"
  pass "every install failed and was logged with its command and exit code; Poise kept running"
}

# Poise's own updater (scripts/provider-cli-updates.mjs) must find each CLI
# where the bootstrap put it and read its version. Whether a vendor's update
# command then succeeds is that vendor's affair, so it is printed, not judged.
updater_check() {
  cat <<'EOF'
import { ensureProviderClis } from '/opt/poise/scripts/provider-cli-updates.mjs'
const commands = { claude: 'claude', codex: 'codex', grok: 'grok', antigravity: 'agy', muse: 'muse' }
let lost = 0
for (const [provider, result] of Object.entries(await ensureProviderClis())) {
  console.log(`${provider}: ${result.status} ${result.path} ${result.before} -> ${result.after}${result.error ? ` (${result.error})` : ''}`)
  if (result.path !== `/home/poise/.local/bin/${commands[provider]}` || !result.before) lost += 1
}
if (lost) throw new Error(`Poise's updater did not find ${lost} provider CLI(s) in ~/.local/bin`)
EOF
}

bootstrap() {
  local container=poise-ws-bootstrap volume=poise-home-bootstrap network=poise-net-bootstrap public_key log command path version last_run
  fresh "$container" "$volume" "$network"
  public_key=$(node "$here/identity.mjs" key "$work/gateway.pem")
  start_workspace "$container" "$volume" "$network" "$public_key"
  wait_healthy "$container"
  log=$(wait_for_bootstrap "$container" 1 1200)
  grep --quiet 'bootstrap finished: every provider CLI is installed' <<<"$log" || fail "the bootstrap failed: $log"
  grep ' [a-z]*: \(installing\|installed\|present\)' <<<"$log"
  for command in claude codex grok agy muse; do
    path=$(docker exec "$container" sh -c "command -v $command") || fail "$command is not on PATH"
    [ "$path" = "/home/poise/.local/bin/$command" ] || fail "$command resolves to $path"
    version=$(docker exec --env MUSE_NO_AUTO_UPDATE=1 "$container" "$command" --version) || fail "$command --version failed"
    pass "$path: ${version%%$'\n'*}"
  done
  docker exec "$container" node --input-type=module --eval "$(updater_check)" || fail "Poise's updater lost a CLI"
  pass "Poise's updater finds every CLI in ~/.local/bin"

  docker restart "$container" >/dev/null
  wait_healthy "$container"
  log=$(wait_for_bootstrap "$container" 2 300)
  last_run=$(awk '/bootstrap started/ { run = "" } { run = run $0 "\n" } END { printf "%s", run }' <<<"$log")
  if [ "$(grep --count ': present at ' <<<"$last_run")" != 5 ] || grep --quiet ': installing' <<<"$last_run"; then
    fail "after a restart the bootstrap did more than find the five CLIs: $last_run"
  fi
  pass "after a restart the bootstrap finds all five CLIs and installs nothing"
}

logs() {
  local container mounts
  for container in $(docker ps --all --filter label=poise.smoke=1 --format '{{.Names}}'); do
    echo "::group::$container"
    docker inspect --format '{{.State.Status}} (exit {{.State.ExitCode}}) health: {{json .State.Health}}' "$container"
    docker logs --tail 300 "$container" 2>&1
    mounts=$(docker inspect --format '{{range .Mounts}}{{.Destination}} {{end}}' "$container")
    if [[ $mounts == *"/home/poise "* ]]; then
      echo "--- ~/.poise/logs/cli-bootstrap.log"
      docker run --rm --volumes-from "$container" --network none --no-healthcheck --entrypoint sh "$image" \
        -c 'cat /home/poise/.poise/logs/cli-bootstrap.log 2>&1 | tail -n 300'
    fi
    echo "::endgroup::"
  done
}

case "$mode" in
  contract | offline | bootstrap | logs) "$mode" ;;
  *)
    sed -n '7,10p' "$0" >&2
    exit 2
    ;;
esac
