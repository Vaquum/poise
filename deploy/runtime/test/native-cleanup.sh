#!/bin/bash
# Actual image/kernel component proof. No providers, workflow or GitHub writes.
set -euo pipefail
if [ "$#" -ne 2 ] || { [ "$2" != runsc ] && [ "$2" != runc ]; }; then
  echo 'usage: native-cleanup.sh IMAGE runsc|runc' >&2
  exit 2
fi
image=$1
runtime=$2
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
container=poise-native-component-$runtime-$$
volume=$container-home
if docker container inspect "$container" >/dev/null 2>&1 || docker volume inspect "$volume" >/dev/null 2>&1; then
  echo 'native component resource already exists; refusing reuse' >&2
  rm -rf "$work"
  exit 1
fi
volume_created=false
cleanup() {
  if docker container inspect "$container" >/dev/null 2>&1; then
    docker logs "$container"
    docker rm --force --volumes "$container" >/dev/null
  fi
  if [ "$volume_created" = true ]; then docker volume rm "$volume" >/dev/null; fi
  rm -rf "$work"
}
trap cleanup EXIT
key=$(node "$here/identity.mjs" key "$work/gateway.pem")
docker volume create --label poise.audit.scope=native-component "$volume" >/dev/null
volume_created=true
start_workspace() {
  docker run --detach --name "$container" --label poise.audit.scope=native-component \
  --runtime "$runtime" --user 10001:10001 --init --security-opt no-new-privileges --cap-drop ALL \
  --network none --memory 2g --cpus 2 --pids-limit 256 --read-only \
  --tmpfs /tmp:rw,exec,nosuid,nodev,size=128m \
  --mount "type=volume,source=$volume,target=/home/poise" \
  --mount "type=bind,source=$here/native,target=/contract,readonly" \
  -e POISE_MODE=service -e POISE_WORKSPACE_HANDLE=native-component -e POISE_WORKSPACE_OWNER=Native-Component \
  -e POISE_PUBLIC_ORIGIN=https://native-component.poise.test -e "POISE_GATEWAY_PUBLIC_KEY=$key" \
  -e POISE_SKIP_CLI_BOOTSTRAP=1 "$image" >/dev/null
  local healthy=false
  for _ in $(seq 1 90); do
    if docker exec "$container" curl --fail --silent --max-time 2 http://127.0.0.1:5555/api/service/health >/dev/null; then
      healthy=true; break
    fi
    sleep 1
  done
  [ "$healthy" = true ] || { echo 'actual service did not become healthy' >&2; exit 1; }
}
start_workspace
expected=unsupported
if [ "$runtime" = runsc ]; then expected=supported; fi
docker exec "$container" /opt/caller/venv/bin/python /contract/service.py "$expected"
if [ "$runtime" = runsc ]; then
  docker exec "$container" node /contract/resources.mjs
  docker exec "$container" mkdir /tmp/native-fixtures
  docker exec "$container" gcc -O0 -g -fsanitize=address -static-libasan /contract/sanitizer.c -o /tmp/native-fixtures/sanitizer
  docker exec "$container" gcc -O0 -pthread /contract/thread-leader.c -o /tmp/native-fixtures/thread-leader
  docker exec "$container" /opt/caller/venv/bin/python /contract/kernel.py
  docker exec "$container" /opt/caller/venv/bin/python /contract/receipt.py
  docker exec "$container" /opt/caller/venv/bin/python /contract/receipt.py slow
  for fault in parent-loss before-active deleted-before-ack cleaner-loss partial-root partial-before-mkdir permission-zero unknown-process-error base-replaced data-replaced metadata-pid-collision native-coordination native-coordination-replaced paused-maintenance-tick; do
    docker exec "$container" /opt/caller/venv/bin/python /contract/recovery.py "$fault"
  done
  for resource_case in memory disk deleted-home deleted-tmp unavailable busy-memory; do
    headroom=$(node "$here/native-headroom.mjs" "$container")
    docker exec -e "POISE_COMPONENT_HEADROOM=$headroom" "$container" /opt/caller/venv/bin/python /contract/limits.py enforced "$resource_case"
  done
  for replacement in cooperative abrupt; do
    docker exec "$container" /opt/caller/venv/bin/python /contract/replacement.py before "$replacement"
    if [ "$replacement" = cooperative ]; then docker stop "$container" >/dev/null; fi
    docker rm --force "$container" >/dev/null
    start_workspace
    docker exec "$container" /opt/caller/venv/bin/python /contract/replacement.py after "$replacement"
  done
fi
