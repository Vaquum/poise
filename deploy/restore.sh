#!/bin/bash
# Restores a backup deploy/backup.sh made: BACKUP is one of the directories
# it writes. Every volume in it is created anew and filled from its archive;
# a volume that already exists is refused, never overwritten. Restore before
# deploy/install.sh starts the service (docs/Operating.md, "Restore").
#
#   deploy/restore.sh BACKUP
set -euo pipefail
# shellcheck source=deploy/lib.sh
. "$(dirname "$0")/lib.sh"

[ $# -eq 1 ] || die "usage: $0 BACKUP"
[ -d "$1" ] || die "$1 is not a directory."
backup=$(cd "$1" && pwd)
require_linux
require_docker
require_env_file

[ -f "$backup/SHA256SUMS" ] || die "$backup has no SHA256SUMS; name one of the directories deploy/backup.sh writes."
say "Checking the archives in $backup."
(cd "$backup" && sha256sum --check --quiet SHA256SUMS) || die "the archives in $backup do not match their SHA256SUMS."
volumes=()
while read -r _ archive; do
  [[ $archive =~ ^(poise-gateway-data|poise-home-[a-z0-9-]+)\.tar\.gz$ ]] || die "$backup/SHA256SUMS names $archive, which is not a volume backup.sh archives."
  volumes+=("${archive%.tar.gz}")
done <"$backup/SHA256SUMS"
[ ${#volumes[@]} -gt 0 ] || die "$backup/SHA256SUMS lists no archive."

existing=()
for volume in "${volumes[@]}"; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then existing+=("$volume"); fi
done
[ ${#existing[@]} -eq 0 ] || die "these volumes exist already, and restore.sh never overwrites one: ${existing[*]}
docs/Operating.md (\"Restore\") says how to replace them."

image=$(runtime_image)
if ! docker image inspect "$image" >/dev/null 2>&1; then
  sha=$(source_sha)
  build_runtime_image "$image" "$sha"
fi

created=()
# A failed restore leaves no volume half filled behind.
trap 'if [ ${#created[@]} -gt 0 ]; then docker volume rm "${created[@]}" >/dev/null; warn "the restore failed; removed the volumes it had created: ${created[*]}"; fi' EXIT
for volume in "${volumes[@]}"; do
  say "Restoring $volume."
  docker volume create "$volume" >/dev/null
  created+=("$volume")
  docker run --rm --network none --no-healthcheck --user 0:0 \
    --mount "type=volume,source=$volume,target=/volume" \
    --mount "type=bind,source=$backup,target=/backup,readonly" \
    --entrypoint tar "$image" --extract --gzip --file "/backup/$volume.tar.gz" --directory /volume \
    --numeric-owner --same-owner --same-permissions
done
created=()
say "Restored ${#volumes[@]} volumes from $backup. Start Poise with deploy/install.sh."
