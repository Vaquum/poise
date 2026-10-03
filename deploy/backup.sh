#!/bin/bash
# Backs up the gateway's data volume and every person's home volume, while
# Poise keeps running, into a new directory named after the time (UTC) in
# DIRECTORY, deploy/backups by default. Each volume becomes one gzipped tar;
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
for volume in $(docker volume ls --quiet --filter name=poise-home-); do
  if [[ $volume == poise-home-* ]]; then volumes+=("$volume"); fi
done

# SQLite's locks reach every container on this host except one that runs under
# another kernel, such as gVisor's.
for container in $(docker ps --quiet --filter label=poise.managed=true); do
  read -r name runtime < <(docker inspect --format '{{.Name}} {{.HostConfig.Runtime}}' "$container")
  if [ "$runtime" != runc ]; then
    warn "${name#/} runs under $runtime, so its databases may be caught mid-write. For a copy that is certainly consistent, stop it on the admin page first."
  fi
done

umask 077
parent=${1:-$deploy/backups}
mkdir -p "$parent"
backup=$(cd "$parent" && pwd)/$(date -u +%Y%m%dT%H%M%SZ)
mkdir "$backup"
finished=false
trap 'if [ "$finished" = false ]; then rm -rf "$backup"; warn "the backup failed; $backup was removed."; fi' EXIT

for volume in "${volumes[@]}"; do
  say "Backing up $volume."
  docker run --rm --network none --no-healthcheck --user 0:0 \
    --mount "type=volume,source=$volume,target=/volume" \
    --mount "type=bind,source=$backup,target=/backup" \
    --mount "type=bind,source=$deploy/volume-archive.py,target=/volume-archive.py,readonly" \
    --entrypoint python3 "$image" /volume-archive.py /volume "/backup/$volume.tar.gz" "$(id -u):$(id -g)"
done
(cd "$backup" && sha256sum -- *.tar.gz >SHA256SUMS)
finished=true
say "Backed up ${#volumes[@]} volumes into $backup ($(du -sh "$backup" | cut -f1))."
