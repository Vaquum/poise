#!/bin/bash
# Prints the deploy/.env that .github/workflows/deploy.yml writes on the
# server: a NAME=value line for each of the repository's POISE_ variables in
# VARS (the workflow's toJSON(vars)), except the workflow's own POISE_DEPLOY_
# and POISE_UPSTREAM_ ones, then POISE_GITHUB_CLIENT_SECRET from the secret of
# that name and optional POISE_GOOGLE_CLIENT_SECRET. docs/Operating.md,
# "Run your own Poise from a fork", lists them.
#
#   VARS='{"POISE_DOMAIN": "poise.example.com", ...}' POISE_GITHUB_CLIENT_SECRET=... deploy/actions/env.sh
set -euo pipefail

die() {
  printf 'deploy: %s\n' "$*" >&2
  exit 1
}

secret=${POISE_GITHUB_CLIENT_SECRET:-}
[ -n "$secret" ] \
  || die "the repository has no POISE_GITHUB_CLIENT_SECRET secret. Add the OAuth App's client secret under Settings, Secrets and variables, Actions."
[[ $secret != *[$'\r\n']* ]] || die "the POISE_GITHUB_CLIENT_SECRET secret spans more than one line."

google_secret=${POISE_GOOGLE_CLIENT_SECRET:-}
[[ $google_secret != *[$'\r\n']* ]] || die "the POISE_GOOGLE_CLIENT_SECRET secret spans more than one line."

# Validate all variables before emitting any configuration, especially secrets.
variables=$(jq --raw-output '
  if has("POISE_GOOGLE_CLIENT_SECRET") then error("POISE_GOOGLE_CLIENT_SECRET is a variable; make it a secret instead") else . end
  |
  to_entries
  | sort_by(.key)[]
  | select((.key | test("^POISE_")) and (.key | test("^POISE_(DEPLOY|UPSTREAM)_") | not))
  | if .key == "POISE_GITHUB_CLIENT_SECRET" then error("POISE_GITHUB_CLIENT_SECRET is a variable; make it a secret instead")
    elif (.value | test("[\r\n]")) then error("the variable \(.key) spans more than one line")
    else "\(.key)=\(.value)" end
' <<<"${VARS:-{\}}") || die "the repository's POISE_ variables cannot be written to deploy/.env; jq said why above."
google_id=$(jq --raw-output '.POISE_GOOGLE_CLIENT_ID // ""' <<<"${VARS:-{\}}")
if { [ -n "$google_id" ] && [ -z "$google_secret" ]; } \
  || { [ -z "$google_id" ] && [ -n "$google_secret" ]; }; then
  die "POISE_GOOGLE_CLIENT_ID variable and POISE_GOOGLE_CLIENT_SECRET secret must be set together, or both left unset."
fi

[ -z "$variables" ] || printf '%s\n' "$variables"
printf 'POISE_GITHUB_CLIENT_SECRET=%s\n' "$secret"
[ -z "$google_secret" ] || printf 'POISE_GOOGLE_CLIENT_SECRET=%s\n' "$google_secret"
