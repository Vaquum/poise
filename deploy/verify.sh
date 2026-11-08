#!/bin/bash
# Reconciles one retained rollout without building, applying Compose or asking
# a workspace to switch. Each invocation takes one verification observation.
#
#   deploy/verify.sh ROLLOUT
set -euo pipefail
# shellcheck source=deploy/lib.sh
. "$(dirname "$0")/lib.sh"

[ $# -eq 1 ] || die "usage: $0 ROLLOUT (the ID printed by install.sh or upgrade.sh)"
[[ $1 =~ ^[0-9a-f]{40}\.[a-zA-Z0-9]{6}$ ]] || die "invalid rollout ID: $1"
require_linux
require_docker
read_rollout "$workspace_proof_file.rollouts/$1"
verify_timeout_seconds=0
verify_workspaces "$rollout_sha" "$rollout_image_id" "$rollout_expected"
