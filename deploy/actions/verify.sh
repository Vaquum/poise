#!/bin/bash
# Verify the retained host rollout over the deployment SSH connection.
set -euo pipefail

{
  printf 'path=%q sha=%q\n' "$DEPLOY_PATH" "${SHA:-}"
  cat <<'REMOTE'
set -euo pipefail
if [ -n "$sha" ]; then
  exec "$path/deploy/verify.sh" --wait-for "$sha"
fi
if [ -e "$path/deploy/.env.workspace-proof.rollouts/current" ]; then
  exec "$path/deploy/verify.sh" --current
fi
REMOTE
} | ssh poise-server bash -s
