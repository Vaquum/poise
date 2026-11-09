#!/bin/bash
# Backs up the gateway's data volume and every person's home volume into a new
# UTC-named directory in DIRECTORY, deploy/backups by default. Same-kernel
# workspaces keep running. Each volume becomes one gzipped tar;
# SQLite databases go in as consistent snapshots (deploy/volume-archive.py).
# deploy/restore.sh restores a backup; docs/Operating.md has both.
#
#   deploy/backup.sh [DIRECTORY]
#
# A backup holds people's credentials and the gateway's signing key, so it
# is readable by the user who made it only.
set -euo pipefail
# shellcheck source=deploy/lib.sh
. "$(dirname "$0")/lib.sh"

[ $# -le 1 ] || die "usage: $0 [DIRECTORY]"
gateway_volume=poise-gateway-data
require_linux
require_docker
require_env_file
image=$(runtime_image)
docker image inspect "$image" >/dev/null 2>&1 || die "the workspace image $image is not on this server; run deploy/install.sh first."
docker volume inspect "$gateway_volume" >/dev/null 2>&1 || die "there is no $gateway_volume volume; run deploy/install.sh first."

volumes=("$gateway_volume")
listed=$(docker volume ls --quiet --filter name=poise-home-) || die "cannot list the home volumes; no backup is safe without a complete inventory."
for volume in $listed; do
  if [[ $volume == poise-home-* ]]; then volumes+=("$volume"); fi
done

default_runtime=$(docker info --format '{{.DefaultRuntime}}') || die "cannot determine Docker's default runtime."
[ -n "$default_runtime" ] || die "Docker reported no default runtime."
offline_reason=''
offline_procedure="Stop $gateway first, then the affected workspace containers with docker stop (unpause paused containers first). Keep them stopped and do not run install/upgrade or start/replace containers until backup.sh finishes; see docs/Operating.md (Backups)."

# A stopped gVisor workspace is not offline while the gateway can start it.
# Inspect all consumers, including unlabelled ones and the gateway volume.
check_backup_safety() {
  local containers container details inspected name runtime status workspace_runtime mounts end mounted volume
  local gateway_status=absent gateway_runtime=$default_runtime
  containers=$(docker ps --all --quiet --no-trunc) || die "cannot list containers; no backup is safe without a complete inventory."
  for container in $containers; do
    details=$(docker inspect --type container --format '{{.Id}}|{{.Name}}|{{.HostConfig.Runtime}}|{{.State.Status}}|{{range .Config.Env}}{{if eq (index (split . "=") 0) "POISE_WORKSPACE_RUNTIME"}}{{.}}{{end}}{{end}}|{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}|end' "$container") \
      || die "cannot inspect container $container; no backup is safe without a complete inventory."
    # The runtime setting prints verbatim, so fold newlines to spaces before
    # the single-line read; config.ts read().trim() accepts them as padding.
    details=${details//$'\n'/ }
    IFS='|' read -r inspected name runtime status workspace_runtime mounts end <<<"$details"
    if [ "$inspected" != "$container" ] || [[ $name != /* ]] || [ -z "$runtime" ] || [ "$end" != end ]; then
      die "incomplete inventory for container $container."
    fi
    case $status in
      created|exited|dead|running|paused|restarting|removing) ;;
      *) die "unknown state $status for ${name#/}; cannot establish backup safety." ;;
    esac
    if [ "${name#/}" = "$gateway" ]; then
      gateway_status=$status
      workspace_runtime=${workspace_runtime#POISE_WORKSPACE_RUNTIME=}
      # Match gateway/src/config.ts, which trims POISE_WORKSPACE_RUNTIME.
      workspace_runtime=${workspace_runtime#"${workspace_runtime%%[![:space:]]*}"}
      workspace_runtime=${workspace_runtime%"${workspace_runtime##*[![:space:]]}"}
      gateway_runtime=${workspace_runtime:-$default_runtime}
    fi
    for mounted in $mounts; do
      for volume in "${volumes[@]}"; do
        if [ "$mounted" != "$volume" ] || [ "$runtime" = runc ]; then continue; fi
        offline_reason="${name#/} uses $runtime with $volume"
        case $status in
          created|exited|dead) ;;
          *) die "refusing backup: $offline_reason and is $status; opening its SQLite databases from another kernel is unsafe. $offline_procedure" ;;
        esac
      done
    done
  done
  # Also fence replacements of current runc workspaces with another runtime.
  if [ -z "$offline_reason" ] && [ "$gateway_runtime" != runc ] && [ ${#volumes[@]} -gt 1 ]; then
    offline_reason="${volumes[*]:1} can be started under $gateway_runtime by $gateway"
  fi
  if [ -n "$offline_reason" ]; then
    case $gateway_status in
      absent|created|exited|dead) ;;
      *) die "refusing backup: $offline_reason; $gateway is $gateway_status and can start or replace workspaces. $offline_procedure" ;;
    esac
  fi
}

check_backup_safety

umask 077
parent=${1:-$deploy/backups}
mkdir -p "$parent"
backup=$(cd "$parent" && pwd)/$(date -u +%Y%m%dT%H%M%SZ)
mkdir "$backup"
finished=false
trap 'if [ "$finished" = false ]; then rm -rf "$backup"; warn "the backup failed; $backup was removed."; fi' EXIT

for volume in "${volumes[@]}"; do
  say "Backing up $volume."
  check_backup_safety
  docker run --rm --runtime=runc --network none --no-healthcheck --user 0:0 \
    --mount "type=volume,source=$volume,target=/volume" \
    --mount "type=bind,source=$backup,target=/backup" \
    --mount "type=bind,source=$deploy/volume-archive.py,target=/volume-archive.py,readonly" \
    --entrypoint python3 "$image" /volume-archive.py /volume "/backup/$volume.tar.gz" "$(id -u):$(id -g)"
  check_backup_safety
done
(cd "$backup" && sha256sum -- *.tar.gz >SHA256SUMS)
finished=true
say "Backed up ${#volumes[@]} volumes into $backup ($(du -sh "$backup" | cut -f1))."
