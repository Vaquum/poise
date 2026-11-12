#!/bin/bash
# Reconciles one retained rollout without building, applying Compose or asking
# a workspace to switch. An explicit rollout ID takes one observation.
#
#   deploy/verify.sh ROLLOUT
#   deploy/verify.sh --current        observe a pending rollout
#   deploy/verify.sh --wait-for SHA   Actions verification after host apply
set -euo pipefail
# shellcheck source=deploy/lib.sh
. "$(dirname "$0")/lib.sh"

mode=${1:-}
store=$workspace_proof_file.rollouts
case "$mode" in
  --current)
    [ $# -eq 1 ] || die "usage: $0 --current"
    [ -e "$store/current" ] || exit 0
    lock_deployment --nonblock --conflict-exit-code 75 || {
      result=$?
      [ "$result" -eq 75 ] || exit "$result"
      say "A deployment is in progress; workspace proof will be checked again."
      exit 0
    }
    id=$(cat "$store/current") || die "cannot read the current rollout."
    verify_timeout_seconds=0
    verify_pending_ok=true
    ;;
  --wait-for)
    [ $# -eq 2 ] || die "usage: $0 --wait-for SHA"
    [[ $2 =~ ^[0-9a-f]{40}$ ]] || die "invalid rollout SHA: $2"
    lock_deployment --timeout 600
    id=$(cat "$store/current") || die "cannot read the current rollout."
    ;;
  *)
    [ $# -eq 1 ] || die "usage: $0 ROLLOUT (the ID printed by install.sh or upgrade.sh)"
    id=$1
    verify_timeout_seconds=0
    ;;
esac
[[ $id =~ ^[0-9a-f]{40}\.[a-zA-Z0-9]{6}$ ]] || die "invalid rollout ID: $id"
require_linux
require_docker
read_rollout "$store/$id"
case "$mode" in
  --current)
    [ "$rollout_status" = pending ] && [ -f "$rollout_file.applied" ] || exit 0
    ;;
  --wait-for)
    [ "$rollout_sha" = "$2" ] || die "the current rollout targets $rollout_sha, expected $2."
    [ -f "$rollout_file.applied" ] || die "the host apply has no checkpoint for $id."
    ;;
esac
verify_workspaces "$rollout_sha" "$rollout_image_id" "$rollout_expected"
if [ "$mode" = --wait-for ]; then
  ensure_caller_guard
  prune_docker_storage "$rollout_image"
fi
