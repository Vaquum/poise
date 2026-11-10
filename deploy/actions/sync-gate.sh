#!/bin/bash
# Hold a deployment-enabled fork's main through CI and its serialized Deploy
# attempt. No state is stored: Actions runs and the attempted Deploy SHA are
# the evidence. A failed candidate or a two-hour timeout admits a newer fix.
set -euo pipefail

evidence=()
finish() {
  local state=$1 proceed=$2 reason=$3
  printf '%s: %s\n' "$state" "$reason"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      printf '### Fork release %s: %s\n\n%s\n\n' "$state" "${tip:-unknown}" "$reason"
      printf '%s\n' "${evidence[@]}"
    } >>"$GITHUB_STEP_SUMMARY"
  fi
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'proceed=%s\nsha=%s\n' "$proceed" "${tip:-}" >>"$GITHUB_OUTPUT"
  fi
}

fail() {
  echo "::error::$1" >&2
  finish blocked false "$1"
  exit 1
}

read_runs() {
  local workflow=$1 event=$2 response filter=branch=main
  if [ "$event" = push ]; then filter="head_sha=$tip"; fi
  if ! response=$(gh api "repos/$REPO/actions/workflows/$workflow/runs?$filter&per_page=30" 2>&1); then
    fail "cannot read $workflow runs for $tip: $response"
  fi
  jq -ce --arg repo "$REPO" --arg sha "$tip" --arg event "$event" '
    .workflow_runs | map(select(.head_branch == "main"
      and .head_repository.full_name == $repo
      and (if $event == "push" then .event == "push" and .head_sha == $sha
           else .event == "workflow_run" or .event == "workflow_dispatch" end)))
    | sort_by([.created_at, .id]) | reverse' <<<"$response" \
    || fail "cannot read $workflow runs for $tip: unexpected answer"
}

[ -n "${REPO:-}" ] || fail 'no REPO for the sync gate'
if ! response=$(gh api "repos/$REPO/commits/main" 2>&1); then
  fail "cannot read the tip of $REPO's main: $response"
fi
tip=$(jq -r '.sha // empty' <<<"$response" 2>/dev/null) \
  || fail "cannot read the tip of $REPO's main: unexpected answer"
[[ "$tip" =~ ^[0-9a-f]{40}$ ]] || fail "cannot read the tip of $REPO's main: unexpected answer"

blocked=()
waiting=()
started=$(date +%s)
verified_at='1970-01-01T00:00:00Z'
for workflow in ci.yml caller.yml; do
  runs=$(read_runs "$workflow" push)
  run=$(jq -c '.[0] // empty' <<<"$runs")
  if [ -z "$run" ]; then
    blocked+=("no $workflow push run for $tip; check POISE_SYNC_TOKEN")
    continue
  fi
  status=$(jq -r '.status' <<<"$run")
  conclusion=$(jq -r '.conclusion // empty' <<<"$run")
  url=$(jq -r '.html_url' <<<"$run")
  evidence+=("- $workflow: $status $conclusion ($url)")
  created=$(jq -er '.created_at | fromdateiso8601' <<<"$run") \
    || fail "cannot read $workflow start time for $tip"
  if (( created < started )); then started=$created; fi
  updated=$(jq -er '.updated_at | fromdateiso8601 | todateiso8601' <<<"$run") \
    || fail "cannot read $workflow update time for $tip"
  if [[ "$updated" > "$verified_at" ]]; then verified_at=$updated; fi
  if [ "$status" != completed ]; then
    waiting+=("$workflow is $status ($url)")
  elif [ "$conclusion" != success ]; then
    blocked+=("$workflow concluded $conclusion ($url)")
  fi
done

if [ "${#blocked[@]}" -gt 0 ]; then
  finish blocked true "${blocked[*]}. Allowing a newer upstream fix."
  exit 0
fi
if [ "${#waiting[@]}" -gt 0 ]; then
  if (( $(date +%s) - started >= 7200 )); then
    finish blocked true 'Verification/deployment exceeded two hours. Allowing a newer upstream fix.'
  else
    finish 'waiting for verification' false "${waiting[*]}. Retaining $tip."
  fi
  exit 0
fi

runs=$(read_runs deploy.yml deploy)
in_flight=false
while IFS= read -r run; do
  status=$(jq -r '.status' <<<"$run")
  url=$(jq -r '.html_url' <<<"$run")
  evidence+=("- Deploy: $status $(jq -r '.conclusion // empty' <<<"$run") ($url)")
  if [ "$status" != completed ]; then
    in_flight=true
    continue
  fi
  id=$(jq -r '.id' <<<"$run")
  if ! jobs=$(gh api "repos/$REPO/actions/runs/$id/jobs?per_page=100" 2>&1); then
    fail "cannot read Deploy jobs for $tip ($url): $jobs"
  fi
  # Deploy re-reads main: a run recorded on an older head may apply this tip.
  targeted=$(jq -er --arg step "Deploy $tip" '
    [.jobs[].steps[]? | select(.name == $step)] | length' <<<"$jobs") \
    || fail "cannot read Deploy steps for $tip ($url): unexpected answer"
  if [ "$(jq -r '.head_sha' <<<"$run")" != "$tip" ] && (( targeted == 0 )); then continue; fi
  # A green gate may have skipped before the second workflow finished. Only
  # the SHA-named apply step proves an attempt; success alone proves nothing.
  attempted=$(jq -er --arg step "Deploy $tip" '
    [.jobs[].steps[]? | select(.name == $step and .conclusion != null
      and .conclusion != "skipped")] | length' <<<"$jobs") \
    || fail "cannot read Deploy steps for $tip ($url): unexpected answer"
  conclusion=$(jq -r '.conclusion' <<<"$run")
  applied=$(jq -r --arg step "Deploy $tip" '
    [.jobs[].steps[]? | select(.name == $step and .conclusion == "success")] | length' <<<"$jobs")
  if [ "$conclusion" = success ] && (( applied > 0 )); then
    finish 'deploy attempt completed' true "Deploy attempted $tip ($url). Workspace verification and health release establish what is serving."
    exit 0
  fi
  # An early refusal is not the final CI -> Deploy handoff. A later failed or
  # cancelled attempt must release the candidate even if SSH/apply never began.
  admitted=$(jq -r --arg verified "$verified_at" '
    [.jobs[].steps[]? | select(.name == "Refuse any tip whose required CI did not pass on it"
      and .started_at != null and .started_at >= $verified)] | length' <<<"$jobs")
  created=$(jq -r '.created_at' <<<"$run")
  if [ "$conclusion" != success ] \
    && { (( attempted > 0 || admitted > 0 )) || [[ "$created" > "$verified_at" || "$created" = "$verified_at" ]]; }; then
    finish blocked true "Deploy concluded $conclusion for $tip ($url). Allowing a newer upstream fix."
    exit 0
  fi
done < <(jq -c '.[]' <<<"$runs")

if (( $(date +%s) - started >= 7200 )); then
  finish blocked true 'Verification/deployment exceeded two hours. Allowing a newer upstream fix.'
elif [ "$in_flight" = true ]; then
  finish 'waiting for Deploy' false "Deploy is queued or running; retaining $tip until it finishes."
else
  if ! response=$(gh workflow run deploy.yml --repo "$REPO" --ref main 2>&1); then
    fail "cannot dispatch Deploy for $tip: $response"
  fi
  finish 'waiting for Deploy' false "Required verification passed; requested a gated Deploy. Retaining $tip until its attempt finishes."
fi
