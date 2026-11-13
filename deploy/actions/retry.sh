#!/bin/bash
# Sync serializes retries and lets a newer upstream commit take precedence.
set -euo pipefail

tip=$(gh api "repos/$GITHUB_REPOSITORY/commits/main" --jq .sha)
if [ "$tip" != "$CANDIDATE" ]; then
  echo "Fork main advanced to $tip before the retry."
  exit 0
fi
attempt=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$RUN_ID" --jq .run_attempt)
if [ "$attempt" != 1 ]; then
  echo "Workflow $RUN_ID already moved to attempt $attempt."
  exit 0
fi
gh run rerun "$RUN_ID" --repo "$GITHUB_REPOSITORY"
printf '### Retrying the failed stage for %s\n\n[Workflow run](https://github.com/%s/actions/runs/%s)\n' \
  "$CANDIDATE" "$GITHUB_REPOSITORY" "$RUN_ID" >>"$GITHUB_STEP_SUMMARY"
