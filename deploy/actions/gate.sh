#!/bin/bash
# Refuses to deploy SHA unless that exact commit is the tip of REPO's main
# and its required CI passed on it, as .github/workflows/deploy.yml runs it
# before deploy/actions/ssh-setup.sh. The required set is the CI and Caller
# workflows, the same two upstream branch protection requires; a run counts
# only when GitHub ran it for a push to this repository's main, so a pull
# request from a fork whose branch is also called main can never satisfy it.
#
# The gate ends three ways: it prints proceed=true and exits 0 to deploy, it
# prints proceed=false and exits 0 to skip without failing the run (the SHA
# was superseded, or a required workflow is still running and its completion
# re-evaluates the gate), or it exits 1 to refuse, naming the blocking
# workflow and run. It writes proceed= and sha= to GITHUB_OUTPUT when set.
#
#   REPO=... SHA=... TRIGGER=workflow_run|workflow_dispatch GH_TOKEN=... deploy/actions/gate.sh
set -euo pipefail

required=(ci.yml caller.yml)

fail() {
  echo "::error::$1" >&2
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '### Deploy gate refused %s\n\n%s\n' "${SHA:-?}" "$1" >>"$GITHUB_STEP_SUMMARY"
  fi
  exit 1
}

skip() {
  echo "::notice::$1" >&2
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '### Deploy gate skipped %s\n\n%s\n' "$SHA" "$1" >>"$GITHUB_STEP_SUMMARY"
  fi
  echo "proceed=false"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'proceed=%s\nsha=%s\n' false "$SHA" >>"$GITHUB_OUTPUT"
  fi
  exit 0
}

[ -n "${REPO:-}" ] || fail "no REPO for the deploy gate"
[[ "${SHA:-}" =~ ^[0-9a-f]{40}$ ]] || fail "no deployable SHA for the deploy gate: '${SHA:-}'"
[ "${TRIGGER:-}" = workflow_run ] || [ "${TRIGGER:-}" = workflow_dispatch ] \
  || fail "no deploy trigger for the deploy gate: '${TRIGGER:-}'"

if ! tip_json=$(gh api "repos/$REPO/commits/main" 2>&1); then
  fail "cannot read the tip of $REPO's main: $tip_json"
fi
tip=$(jq -r '.sha // empty' <<<"$tip_json" 2>/dev/null) || tip=""
[[ "$tip" =~ ^[0-9a-f]{40}$ ]] || fail "cannot read the tip of $REPO's main: unexpected answer"
[ "$tip" = "$SHA" ] || skip "$SHA is no longer the tip of $REPO's main (tip is $tip); the tip's own CI decides its deploy."

evidence=()
for workflow in "${required[@]}"; do
  if ! runs_json=$(gh api "repos/$REPO/actions/workflows/$workflow/runs?head_sha=$SHA&per_page=30" 2>&1); then
    fail "cannot read $workflow runs for $SHA: $runs_json"
  fi
  if ! run_json=$(jq -c --arg repo "$REPO" \
    '[.workflow_runs[] | select(.event == "push" and .head_branch == "main" and .head_repository.full_name == $repo)] | max_by([.created_at, .id]) // empty' \
    <<<"$runs_json" 2>/dev/null); then
    fail "cannot read $workflow runs for $SHA: unexpected answer"
  fi
  if [ -z "$run_json" ]; then
    fail "refuses $SHA: no $workflow run tested it on $REPO's main. A new fork gets CI from its first push; a fork that syncs without POISE_SYNC_TOKEN gets none until it sets the token."
  fi
  run_id=$(jq -r '.id' <<<"$run_json")
  status=$(jq -r '.status' <<<"$run_json")
  conclusion=$(jq -r '.conclusion // empty' <<<"$run_json")
  url=$(jq -r '.html_url' <<<"$run_json")
  attempt=$(jq -r '.run_attempt' <<<"$run_json")
  if [ "$status" != completed ]; then
    if [ "$TRIGGER" = workflow_dispatch ]; then
      fail "refuses $SHA: $workflow is still $status ($url); dispatch again once its CI passes."
    fi
    skip "$workflow is still $status for $SHA ($url); its completion re-evaluates the deploy gate."
  fi
  if [ "$conclusion" != success ]; then
    failed_steps=$(gh api "repos/$REPO/actions/runs/$run_id/jobs?per_page=100" 2>/dev/null \
      | jq -r '[.jobs[].steps[]? | select(.conclusion == "failure") | .name] | unique | join(", ")') \
      || failed_steps=""
    detail="$workflow concluded $conclusion for $SHA ($url, attempt $attempt)"
    [ -n "$failed_steps" ] && detail="$detail, failing in: $failed_steps"
    if [ "$TRIGGER" = workflow_run ]; then
      fail "refuses $SHA: $detail. Re-run its failed jobs; their success triggers the deploy."
    fi
    fail "refuses $SHA: $detail. Re-run its failed jobs, then dispatch again."
  fi
  evidence+=("$workflow passed: $url (attempt $attempt)")
done

echo "Deploys $SHA: every required workflow passed on it."
for line in "${evidence[@]}"; do
  echo "  $line"
done
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    printf '### Deploy gate passed for %s\n\n' "$SHA"
    for line in "${evidence[@]}"; do
      printf '%s\n' "- $line"
    done
  } >>"$GITHUB_STEP_SUMMARY"
fi
echo "proceed=true"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf 'proceed=%s\nsha=%s\n' true "$SHA" >>"$GITHUB_OUTPUT"
fi
