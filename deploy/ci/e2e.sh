#!/bin/bash
# The deployment bundle end to end, on a Linux host with Docker, as
# .github/workflows/deploy-e2e.yml runs it:
#
#   deploy/ci/e2e.sh run    install, sign in, use a workspace and Poise Link, check TLS, back up and restore, upgrade
#   deploy/ci/e2e.sh logs   print what the stack and the workspaces logged
#
# It drives the real stack, deploy/compose.yaml, through deploy/install.sh,
# backup.sh, restore.sh and upgrade.sh, with deploy/ci/compose.yaml on top:
# plain http (POISE_INSECURE_HTTP=1) on poise.test, a fake GitHub beside the
# gateway, and workspaces without provider CLIs. It writes deploy/.env and
# commits to a branch of this checkout. poise.test and its subdomains alice,
# bob, nobody and admin must resolve to 127.0.0.1.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
deploy=$(cd "$here/.." && pwd)
root=$(cd "$deploy/.." && pwd)
export COMPOSE_FILE=compose.yaml:ci/compose.yaml
domain=poise.test
apex=http://$domain
github=http://127.0.0.1:9999
work=$(mktemp -d)
alice=$work/alice.cookies
bob=$work/bob.cookies
nobody=$work/nobody.cookies
navigate=(--header 'Accept: text/html' --header 'Sec-Fetch-Mode: navigate')
# Commits rows to a database in WAL mode and keeps it open, with automatic
# checkpoints off, so the commits stay in its -wal file.
live_writer="
import os, sqlite3, time
os.makedirs('/home/poise/e2e', exist_ok=True)
db = sqlite3.connect('/home/poise/e2e/live.db', isolation_level=None)
db.execute('PRAGMA journal_mode=WAL')
db.execute('PRAGMA wal_autocheckpoint=0')
db.execute('CREATE TABLE notes (body TEXT)')
for n in range(100):
    db.execute('INSERT INTO notes VALUES (?)', (f'note {n}',))
open('/home/poise/e2e/ready', 'w').close()
time.sleep(86400)
"

pass() { echo "ok - $*"; }
fail() {
  echo "FAIL - $*" >&2
  exit 1
}
compose() { (cd "$deploy" && docker compose "$@"); }
uri() { jq --raw-output --null-input --arg value "$1" '$value | @uri'; }
in_workspace() { docker exec poise-ws-alice "$@"; }

# One request with cookie jar JAR, which must answer WANT. The body is left
# in $work/body and the redirect target in $location.
expect() {
  local want=$1 what=$2 jar=$3 url=$4 answer status
  shift 4
  answer=$(curl --silent --show-error --max-time 30 --cookie "$jar" --cookie-jar "$jar" \
    --output "$work/body" --write-out '%{http_code} %{redirect_url}' "$@" "$url") || fail "$what: $url could not be reached"
  status=${answer%% *}
  location=${answer#* }
  [ "$status" = "$want" ] || fail "$what: $url answered $status, not $want: $(head -c 800 "$work/body")"
  pass "$what ($status)"
}

# A command that must fail and say SAYS.
refused() {
  local what=$1 says=$2 output
  shift 2
  if output=$("$@" 2>&1); then fail "$what: $* succeeded: $output"; fi
  grep --quiet --fixed-strings -- "$says" <<<"$output" || fail "$what: $* did not say \"$says\": $output"
  pass "$what is refused: $says"
}

# Whether JAR holds cookie NAME for DOMAIN, as a domain cookie (TRUE) or for that host only (FALSE).
has_cookie() {
  local jar=$1 domain=$2 scope=$3 name=$4
  awk -F '\t' -v domain="$domain" -v scope="$scope" -v name="$name" \
    '{ sub(/^#HttpOnly_/, "", $1) } $1 == domain && $2 == scope && $6 == name { found = 1 } END { exit !found }' "$jar" \
    || fail "no $name cookie for $domain ($scope) in $jar"
  pass "$name is set for $domain ($scope)"
}

cookie() {
  awk -F '\t' -v domain="$2" -v name="$3" '{ sub(/^#HttpOnly_/, "", $1) } $1 == domain && $6 == name { print $7 }' "$1"
}

# The value of the first form field NAME on the last page fetched.
form_field() {
  grep --only-matching "name=\"$1\" value=\"[^\"]*\"" "$work/body" | head -n 1 | sed 's/.*value="//; s/"$//'
}

# Signs LOGIN in through the fake GitHub into JAR, asking to continue to NEXT.
sign_in() {
  local login=$1 jar=$2 next=$3
  : >"$jar"
  expect 302 "$login starts to sign in" "$jar" "$apex/auth/login?next=$(uri "$next")"
  [[ $location == "$github/login/oauth/authorize?"* ]] || fail "sign-in went to $location, not to the GitHub in POISE_GITHUB_URL"
  [[ $location == *"redirect_uri=$(uri "$apex/auth/callback")&"* ]] || fail "the gateway's callback is not $apex/auth/callback: $location"
  [[ $location == *"&scope=read%3Auser&"* ]] || fail "the gateway asks GitHub for more than read:user: $location"
  expect 302 "GitHub signs $login in" "$jar" "$location&login=$login"
  [[ $location == "$apex/auth/callback?"* ]] || fail "GitHub sent $login to $location"
  expect 302 "the gateway lets $login in" "$jar" "$location"
}

# Waits until the workspace behind HANDLE's host serves Poise to JAR.
wait_for_poise() {
  local jar=$1 handle=$2 status
  for _ in $(seq 1 120); do
    status=$(curl --silent --max-time 30 --cookie "$jar" --output "$work/body" --write-out '%{http_code}' \
      "${navigate[@]}" "http://$handle.$domain/") || status=000
    if [ "$status" = 200 ]; then break; fi
    if [ "$status" != 503 ]; then fail "$handle's workspace host answered $status while it started: $(head -c 800 "$work/body")"; fi
    sleep 2
  done
  [ "$status" = 200 ] || fail "$handle's workspace did not start within four minutes: $(head -c 800 "$work/body")"
  grep --quiet '<title>Poise</title>' "$work/body" || fail "$handle's workspace host did not serve Poise: $(head -c 800 "$work/body")"
  pass "$handle's workspace host serves Poise"
}

workspace_version() {
  in_workspace curl --fail --silent --show-error http://127.0.0.1:5555/api/service/health | jq --raw-output .version
}

install() {
  : >"$deploy/.env"
  chmod 644 "$deploy/.env"
  refused "install.sh with a deploy/.env others can read" "chmod 600" "$deploy/install.sh"
  chmod 600 "$deploy/.env"
  refused "install.sh with no settings" \
    "sets no POISE_DOMAIN POISE_GITHUB_CLIENT_ID POISE_GITHUB_CLIENT_SECRET POISE_ADMINS POISE_ACME_EMAIL" "$deploy/install.sh"
  cat >"$deploy/.env" <<EOF
POISE_DOMAIN=$domain
POISE_GITHUB_CLIENT_ID=e2e-client
POISE_GITHUB_CLIENT_SECRET=e2e-secret
POISE_ADMINS=alice
POISE_ALLOWED_USERS=bob
POISE_ACME_EMAIL=e2e@poise.test
POISE_WORKSPACE_MEMORY=3g
POISE_WORKSPACE_CPUS=2
POISE_INSECURE_HTTP=1
POISE_GITHUB_URL=$github
POISE_GITHUB_API_URL=$github
POISE_WORKSPACE_SKIP_CLI_BOOTSTRAP=1
EOF
  "$deploy/install.sh" | tee "$work/install.log"
  grep --quiet --fixed-strings "$apex/auth/callback" "$work/install.log" || fail "install.sh did not print the OAuth App's callback URL"
  pass "install.sh installed the stack"
}

sign_in_alice() {
  local ticket
  sign_in alice "$alice" "http://alice.$domain/"
  ticket=$location
  [[ $ticket == "http://alice.$domain/_poise/session?ticket="* ]] || fail "alice was sent to $ticket, not to her workspace host"
  has_cookie "$alice" "$domain" FALSE poise_gw
  has_cookie "$alice" ".$domain" TRUE poise_bind
  : >"$nobody"
  expect 403 "her ticket, redeemed by a browser without her poise_bind" "$nobody" "$ticket"
  expect 302 "alice asks for her workspace again" "$alice" "$apex/auth/login?next=$(uri "http://alice.$domain/")"
  [[ $location == "http://alice.$domain/_poise/session?ticket="* ]] || fail "alice was sent to $location"
  expect 302 "alice redeems the new ticket on her workspace host, with her poise_bind" "$alice" "$location"
  [ "$location" = "http://alice.$domain/" ] || fail "the ticket sent alice on to $location"
  has_cookie "$alice" "alice.$domain" FALSE poise_ws
}

open_workspace() {
  local script
  expect 503 "alice's first visit starts her workspace" "$alice" "http://alice.$domain/" "${navigate[@]}"
  grep --quiet 'Starting your workspace' "$work/body" || fail "no starting page: $(head -c 800 "$work/body")"
  wait_for_poise "$alice" alice
  script=$(grep --only-matching 'src="/assets/[^"]*\.js"' "$work/body" | head -n 1 | cut -d '"' -f 2)
  [ -n "$script" ] || fail "Poise's page names no script"
  expect 200 "Poise's script, through alice's workspace host" "$alice" "http://alice.$domain$script"
  [ "$(workspace_version)" = "$(git -C "$root" rev-parse HEAD)" ] || fail "the workspace reports version $(workspace_version), not the commit it was built from"
  pass "the workspace reports the commit it was built from"
  expect 200 "the admin page, for alice" "$alice" "$apex/admin"
}

# The gateway's service endpoints and its certificate question stay inside.
check_inside_only() {
  : >"$nobody"
  expect 403 "/api/service/health, for alice's own browser" "$alice" "http://alice.$domain/api/service/health"
  expect 403 "a drain, from alice's own browser" "$alice" "http://alice.$domain/api/service/drain" \
    --request POST --header "Origin: http://alice.$domain"
  expect 401 "/api/service/health, without a session" "$nobody" "http://alice.$domain/api/service/health"
  expect 404 "/api/service/health on the apex" "$nobody" "$apex/api/service/health"
  expect 404 "the certificate question, through the apex" "$nobody" "$apex/_gateway/tls-ask?domain=$domain"
  [ -z "$(curl --silent --max-time 10 --header 'Host: gateway:8080' "http://127.0.0.1/_gateway/tls-ask?domain=$domain")" ] \
    || fail "Caddy passed a request for Host gateway:8080 to the gateway"
  pass "Caddy answers Host gateway:8080 itself and never passes it on"
  expect 401 "a forged X-Poise-Identity, without a session" "$nobody" "http://alice.$domain/api/health" \
    --header 'X-Poise-Identity: e30.e30.forged'
}

second_user() {
  local session
  sign_in bob "$bob" "http://bob.$domain/"
  [[ $location == "http://bob.$domain/_poise/session?ticket="* ]] || fail "bob was sent to $location"
  expect 302 "bob redeems his ticket on his own host" "$bob" "$location"
  session=$(cookie "$bob" "bob.$domain" poise_ws)
  [ -n "$session" ] || fail "bob got no workspace session"
  expect 403 "bob asking the apex for alice's workspace" "$bob" "$apex/auth/login?next=$(uri "http://alice.$domain/")"
  expect 302 "bob opening alice's workspace host" "$bob" "http://alice.$domain/" "${navigate[@]}"
  [[ $location == "$apex/auth/login?"* ]] || fail "bob was sent to $location, not to sign in"
  : >"$nobody"
  expect 403 "bob's workspace session on alice's host" "$nobody" "http://alice.$domain/" "${navigate[@]}" \
    --header "Cookie: poise_ws=$session"
  expect 403 "bob's session on alice's host, with forwarding headers naming his own" "$nobody" "http://alice.$domain/api/health" \
    --header "Cookie: poise_ws=$session" --header "X-Forwarded-Host: bob.$domain" --header "Forwarded: host=bob.$domain"
  socket_refused 403 "bob's session" "poise_ws=$session"
  socket_refused 401 "no session" ""
}

socket_refused() {
  local want=$1 what=$2 cookie=$3 output
  output=$(node "$here/chat-socket.mjs" "ws://alice.$domain/ws/chat" "http://alice.$domain" "$cookie" 0) && fail "Chat's WebSocket with $what connected"
  [ "$output" = "refused $want" ] || fail "Chat's WebSocket with $what: $output"
  pass "Chat's WebSocket on alice's host, with $what: $output"
}

# Poise Link's path through Caddy and the gateway: a device code, alice's
# approval at the apex, the token, and the Link API on her workspace host,
# its event stream left open while the other checks run.
pair_link() {
  local code user
  code=$(curl --silent --show-error --fail --max-time 30 --request POST --user-agent 'Poise Link e2e' "$apex/link/device/code") \
    || fail "POST /link/device/code failed"
  user=$(jq --raw-output .user_code <<<"$code")
  [ "$(jq --raw-output .verification_uri <<<"$code")" = "$apex/link" ] || fail "the device code sends people elsewhere: $code"
  pass "Poise Link gets the device code $user"
  expect 200 "alice opens the pairing page" "$alice" "$apex/link"
  expect 200 "alice approves $user" "$alice" "$apex/link" --header "Origin: $apex" \
    --data-urlencode "csrf=$(form_field csrf)" --data-urlencode "user_code=$user" --data-urlencode decision=approve
  grep --quiet 'Approved.' "$work/body" || fail "the approval was not confirmed: $(head -c 800 "$work/body")"
  curl --silent --show-error --fail --max-time 30 --header 'Content-Type: application/json' \
    --data "{\"device_code\":\"$(jq --raw-output .device_code <<<"$code")\"}" "$apex/link/device/token" >"$work/token" \
    || fail "POST /link/device/token failed: $(cat "$work/token")"
  [ "$(jq --raw-output '.endpoint + " " + .login' "$work/token")" = "http://alice.$domain alice" ] \
    || fail "the token is not for alice's workspace: $(jq --compact-output 'del(.access_token)' "$work/token")"
  link_token=$(jq --raw-output .access_token "$work/token")
  pass "Poise Link gets a token for alice's workspace"

  curl --silent --no-buffer --max-time 25 --header "Authorization: Bearer $link_token" \
    "http://alice.$domain/api/link/events" >"$work/events" 2>&1 &
  events=$!

  expect 200 "/api/link/hello with the device token" "$nobody" "http://alice.$domain/api/link/hello" \
    --header "Authorization: Bearer $link_token"
  [ "$(jq --raw-output '.login + " " + .version' "$work/body")" = "alice $(git -C "$root" rev-parse HEAD)" ] \
    || fail "/api/link/hello answered $(cat "$work/body")"
  expect 200 "/api/link/snippets with the device token" "$nobody" "http://alice.$domain/api/link/snippets" \
    --header "Authorization: Bearer $link_token" --dump-header "$work/headers"
  snippets_version=$(jq --raw-output .version "$work/body")
  [ "$(jq --raw-output .yaml "$work/body" | head -n 1)" = '# Managed by Poise Link. Edit snippets in Poise; changes made here are overwritten.' ] \
    || fail "the snippets lack Poise Link's header: $(cat "$work/body")"
  [ "$(jq --join-output .yaml "$work/body" | sha256sum | cut -d ' ' -f 1)" = "$snippets_version" ] \
    || fail "the snippets' version is not the SHA-256 of their YAML"
  grep --quiet --ignore-case "^etag: \"$snippets_version\"" "$work/headers" || fail "the snippets carry no ETag of their version"
  pass "the snippets carry Poise Link's header, and their version is the YAML's SHA-256"
  expect 401 "the device token outside /api/link/" "$nobody" "http://alice.$domain/api/health" \
    --header "Authorization: Bearer $link_token"
}

# The event stream must still be open after 25 seconds, having sent the
# snippets version at once and a ping since. Then alice revokes the device.
revoke_link() {
  local status=0
  wait "$events" || status=$?
  [ "$status" = 28 ] || fail "the event stream ended before 25 seconds (curl $status): $(cat "$work/events")"
  if ! grep --quiet --line-regexp 'event: snippets' "$work/events" \
    || ! grep --quiet --fixed-strings "{\"version\":\"$snippets_version\"}" "$work/events"; then
    fail "the event stream sent no snippets version: $(cat "$work/events")"
  fi
  grep --quiet --line-regexp 'event: ping' "$work/events" || fail "the event stream sent no ping: $(cat "$work/events")"
  pass "the event stream stays open through Caddy and the gateway, with the snippets version and pings"
  expect 200 "alice opens her paired devices" "$alice" "$apex/link/devices"
  expect 303 "alice revokes the device" "$alice" "$apex/link/devices/revoke" --header "Origin: $apex" \
    --data-urlencode "csrf=$(form_field csrf)" --data-urlencode "id=$(form_field id)"
  expect 401 "/api/link/hello with the revoked device's token" "$nobody" "http://alice.$domain/api/link/hello" \
    --header "Authorization: Bearer $link_token" --dump-header "$work/headers"
  [ "$(jq --raw-output .error "$work/body")" = device_revoked ] || fail "the refusal does not say device_revoked: $(cat "$work/body")"
  grep --quiet --ignore-case '^www-authenticate: Bearer error="invalid_token"' "$work/headers" || fail "the refusal lacks WWW-Authenticate"
  pass "a revoked device gets 401 device_revoked"
}

# deploy/Caddyfile itself, with Caddy's own certificate authority in place of
# Let's Encrypt: the apex gets a certificate, and a workspace host gets one on
# demand only when the gateway knows its owner.
check_tls() {
  local caddyfile=$work/Caddyfile host
  awk '{ print } !done && $0 == "{" { print "\tlocal_certs\n\tskip_install_trust"; done = 1 }' "$deploy/Caddyfile" >"$caddyfile"
  grep --quiet --line-regexp $'\tlocal_certs' "$caddyfile" || fail "could not give deploy/Caddyfile local certificates"
  docker run --detach --name poise-e2e-tls --network poise-edge --publish 127.0.0.1:8443:443 \
    --env POISE_DOMAIN=$domain --env POISE_ACME_EMAIL=e2e@poise.test \
    --mount "type=bind,source=$caddyfile,target=/etc/caddy/Caddyfile,readonly" caddy:2 >/dev/null
  for _ in $(seq 1 30); do
    if docker exec poise-e2e-tls cat /data/caddy/pki/authorities/local/root.crt >"$work/root.crt" 2>/dev/null \
      && curl --silent --max-time 10 --cacert "$work/root.crt" --output /dev/null "https://$domain:8443/"; then
      break
    fi
    sleep 1
  done
  for host in "$domain" "alice.$domain" "bob.$domain"; do
    curl --silent --show-error --max-time 30 --cacert "$work/root.crt" --output /dev/null "https://$host:8443/" \
      || fail "deploy/Caddyfile has no valid certificate for $host"
    pass "deploy/Caddyfile serves $host with a valid certificate"
  done
  for host in "nobody.$domain" "admin.$domain"; do
    if curl --silent --max-time 30 --cacert "$work/root.crt" --output /dev/null "https://$host:8443/"; then
      fail "deploy/Caddyfile served $host, whose owner the gateway does not know"
    fi
    pass "deploy/Caddyfile gets no certificate for $host"
  done
  docker rm --force poise-e2e-tls >/dev/null
}

# Chat's WebSocket, opened through Caddy and the gateway and left silent for
# 75 seconds, longer than the 60 seconds a proxy commonly allows, while the
# other checks run.
open_chat_socket() {
  node "$here/chat-socket.mjs" "ws://alice.$domain/ws/chat" "http://alice.$domain" \
    "poise_ws=$(cookie "$alice" "alice.$domain" poise_ws)" 75 >"$work/socket" 2>&1 &
  socket=$!
}

check_chat_socket() {
  wait "$socket" || fail "Chat's WebSocket through Caddy and the gateway: $(cat "$work/socket")"
  [ "$(cat "$work/socket")" = $'connected\nanswered' ] || fail "Chat's WebSocket through Caddy and the gateway: $(cat "$work/socket")"
  pass "Chat's WebSocket connects through Caddy and the gateway and still answers after 75 silent seconds"
}

check_data() {
  local marker=$1 rows owners
  [ "$(in_workspace cat /home/poise/e2e/marker)" = "$marker" ] || fail "alice's file did not survive"
  rows=$(in_workspace python3 -c "import sqlite3; print(sqlite3.connect('file:/home/poise/e2e/live.db?mode=ro', uri=True).execute('SELECT count(*) FROM notes').fetchone()[0])")
  [ "$rows" = 100 ] || fail "alice's database has $rows of its 100 rows"
  owners=$(in_workspace stat -c '%u:%g' /home/poise /home/poise/.poise /home/poise/e2e/marker /home/poise/e2e/live.db | sort -u)
  [ "$owners" = 10001:10001 ] || fail "alice's home is not owned by the workspace user: $owners"
  pass "alice's file and database are intact, owned by the workspace user"
}

backup_and_restore() {
  local marker backup key
  marker="e2e $(date +%s)"
  in_workspace sh -c "mkdir -p /home/poise/e2e && printf '%s' '$marker' >/home/poise/e2e/marker"
  docker exec --detach poise-ws-alice python3 -c "$live_writer"
  for _ in $(seq 1 30); do
    if in_workspace test -f /home/poise/e2e/ready; then break; fi
    sleep 1
  done
  [ "$(in_workspace stat -c %s /home/poise/e2e/live.db-wal)" -gt 0 ] || fail "the database's commits are not in its -wal file"
  key=$(docker exec poise-gateway sha256sum /data/identity-ed25519.pem)

  "$deploy/backup.sh" "$work/backups" | tee "$work/backup.log"
  backup=$(find "$work/backups" -mindepth 1 -maxdepth 1 -type d)
  [ "$(find "$backup" -type f -printf '%f\n' | LC_ALL=C sort | tr '\n' ' ')" = "SHA256SUMS poise-gateway-data.tar.gz poise-home-alice.tar.gz " ] \
    || fail "the backup holds $(ls "$backup")"
  tar --list --gzip --file "$backup/poise-home-alice.tar.gz" >"$work/listing"
  grep --quiet --line-regexp 'e2e/live.db' "$work/listing" || fail "the backup lacks alice's database"
  if grep --quiet 'e2e/live.db-' "$work/listing"; then fail "the backup holds the database's -wal or -shm file"; fi
  pass "backup.sh archived both volumes, the database without its -wal and -shm"

  refused "restore.sh over volumes that exist" "exist already" "$deploy/restore.sh" "$backup"

  # A new server: nothing of the old installation is left.
  compose down
  docker rm --force poise-ws-alice >/dev/null
  docker volume rm poise-gateway-data poise-home-alice >/dev/null
  docker network rm poise-net-alice >/dev/null
  "$deploy/restore.sh" "$backup"
  "$deploy/install.sh"
  [ "$(docker exec poise-gateway sha256sum /data/identity-ed25519.pem)" = "$key" ] || fail "the gateway's signing key was not restored"
  pass "the gateway's signing key is restored"

  # alice's browser session lives in the restored gateway database.
  expect 503 "alice's visit after the restore starts her workspace" "$alice" "http://alice.$domain/" "${navigate[@]}"
  wait_for_poise "$alice" alice
  check_data "$marker"
  echo "$marker" >"$work/marker"
}

# A new commit on the branch this checkout follows, as a merge to main makes one.
next_commit() {
  local upstream=$work/upstream.git next=$work/next
  git init --quiet --bare "$upstream"
  git -C "$root" checkout --quiet -B e2e
  git -C "$root" push --quiet "$upstream" e2e
  git -C "$root" remote add e2e "$upstream"
  git -C "$root" fetch --quiet e2e
  git -C "$root" branch --quiet --set-upstream-to=e2e/e2e
  git clone --quiet --branch e2e "$upstream" "$next"
  git -C "$next" -c user.name=e2e -c user.email=e2e@poise.test commit --quiet --allow-empty --message 'test: the next commit'
  git -C "$next" push --quiet origin e2e
  git -C "$next" rev-parse HEAD
}

check_upgrade() {
  local sha before image id current status health
  before=$(docker inspect --format '{{.Id}}' poise-ws-alice)
  sha=$(next_commit)
  "$deploy/upgrade.sh" | tee "$work/upgrade.log"
  [ "$(git -C "$root" rev-parse HEAD)" = "$sha" ] || fail "upgrade.sh did not pull $sha"
  grep --quiet 'alice: running. The gateway drains it first' "$work/upgrade.log" || fail "upgrade.sh did not say it will drain alice's workspace"
  docker image inspect "poise-runtime:$sha" >/dev/null || fail "upgrade.sh did not tag the image with the commit"
  image=$(docker image inspect --format '{{.Id}}' poise-runtime:latest)
  # The gateway looks for outdated workspaces when it starts and every five minutes.
  for _ in $(seq 1 90); do
    read -r id current status health < <(docker inspect --format \
      '{{.Id}} {{.Image}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' poise-ws-alice 2>/dev/null || echo gone)
    if [ "$id" != "$before" ] && [ "$current" = "$image" ] && [ "$status" = running ] && [ "$health" = healthy ]; then break; fi
    sleep 5
  done
  [ "$id" != "$before" ] && [ "$current" = "$image" ] && [ "$status" = running ] && [ "$health" = healthy ] \
    || fail "the gateway did not recreate alice's workspace on the new image within 7.5 minutes: $id $current $status $health"
  docker logs poise-gateway 2>&1 | grep '"handle":"alice"' | grep --quiet '"event":"workspace.drain.requested"' \
    || fail "the gateway recreated alice's workspace without draining it"
  pass "the gateway drained alice's workspace and recreated it on the new image"
  [ "$(workspace_version)" = "$sha" ] || fail "the workspace reports version $(workspace_version), not $sha"
  pass "the workspace reports the new commit"
  check_data "$(cat "$work/marker")"
  wait_for_poise "$alice" alice
}

run() {
  install
  sign_in_alice
  open_workspace
  open_chat_socket
  pair_link
  check_inside_only
  second_user
  check_tls
  check_chat_socket
  revoke_link
  backup_and_restore
  check_upgrade
  echo "The deployment works end to end."
}

logs() {
  local container
  compose ps --all || echo "(docker compose ps failed)"
  compose logs --no-color --timestamps --tail 400 || echo "(docker compose logs failed)"
  for container in $(docker ps --all --filter label=poise.managed=true --format '{{.Names}}') poise-e2e-tls; do
    if ! docker container inspect "$container" >/dev/null 2>&1; then continue; fi
    echo "::group::$container"
    docker inspect --format '{{.State.Status}} (exit {{.State.ExitCode}}, restarts {{.RestartCount}}) health: {{json .State.Health}}' "$container"
    docker logs --timestamps --tail 400 "$container" 2>&1
    echo "::endgroup::"
  done
}

case ${1:-} in
  run) run ;;
  logs) logs ;;
  *)
    sed -n '5,6p' "$0" >&2
    exit 2
    ;;
esac
