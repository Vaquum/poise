#!/bin/bash
# Installs the Poise service on this server, and applies later changes to
# deploy/.env: checks Docker and deploy/.env, builds the workspace image,
# starts Caddy and the gateway with Docker Compose (the gateway alone, behind
# the server's own proxy, when POISE_PROXY_LISTEN is set), waits for the
# gateway to answer and to reach every running workspace, and prints what is
# left to do. docs/Operating.md walks through it.
#
#   deploy/install.sh
set -euo pipefail
# shellcheck source=deploy/lib.sh
. "$(dirname "$0")/lib.sh"

[ $# -eq 0 ] || die "usage: $0"

# Whether a program on this host listens on TCP PORT, over IPv4 or IPv6.
listening() {
  local port file files=()
  port=$(printf ':%04X' "$1")
  for file in /proc/net/tcp /proc/net/tcp6; do
    if [ -r "$file" ]; then files+=("$file"); fi
  done
  [ ${#files[@]} -gt 0 ] || die "cannot read /proc/net/tcp to check which ports are free."
  awk -v port="$port" '$4 == "0A" && substr($2, length($2) - 4) == port { found = 1 } END { exit !found }' "${files[@]}"
}

require_free_ports() {
  local port proxy
  proxy=$(proxy_listen)
  if [ -n "$proxy" ]; then
    port=${proxy##*:}
    # Once installed this way, this installation's gateway holds the port, on
    # this address or on the one it had before, and Compose frees it as it
    # recreates the gateway.
    if docker port "$gateway" 8080/tcp 2>/dev/null | grep --quiet ":$port\$"; then return; fi
    if listening "$port"; then
      die "something on this server already listens on port $port, which POISE_PROXY_LISTEN gives the gateway. See what: sudo ss -ltnp 'sport = :$port'"
    fi
    return
  fi
  # Once installed, this installation's own Caddy holds them.
  if [ "$(docker inspect --format '{{.State.Running}}' poise-caddy 2>/dev/null)" = true ]; then return; fi
  for port in 80 443; do
    if listening "$port"; then
      die "something on this server already listens on port $port, and Caddy needs ports 80 and 443. See what: sudo ss -ltnp 'sport = :$port'"
    fi
  done
}

next_steps() {
  local domain proxy scheme=https step=2
  domain=$(env_value POISE_DOMAIN)
  domain=${domain,,}
  proxy=$(proxy_listen)
  if [ "$(env_value POISE_INSECURE_HTTP)" = 1 ]; then scheme=http; fi
  if [ -n "$proxy" ]; then
    step=3
    cat <<EOF

Poise is running behind your own proxy. What is left (docs/Operating.md,
"Behind your own proxy", describes each step):

1. Your proxy. Send every request for $domain and *.$domain to
     http://$proxy
   with the browser's Host, WebSockets passed through and no time limit on
   a response. For a certificate per workspace host on demand, it asks the
   gateway first; in Caddy:
     on_demand_tls {
       ask http://$proxy/_gateway/tls-ask
     }
   A sign-in of the proxy's own must let Poise Link's requests through:
   POST /link/device/code and /link/device/token on $domain, and
   /api/link/ on every workspace host.

2. DNS. Unless you have already, point $domain and *.$domain at your
   proxy.
EOF
  else
    cat <<EOF

Poise is running. What is left (docs/Operating.md describes each step):

1. DNS. Unless you have already, point two records at this server's public
   address, as A records for IPv4 and AAAA records for IPv6:
     $domain
     *.$domain
   Caddy obtains the certificate for $domain once that name reaches this
   server, and one for each workspace on its first visit.
EOF
  fi
  cat <<EOF

$step. The GitHub OAuth App. Its Authorization callback URL must be exactly
     $scheme://$domain/auth/callback

$((step + 1)). Sign in at $scheme://$domain/ as an admin: $(env_value POISE_ADMINS)
   The admin page, $scheme://$domain/admin, lists people and workspaces.

$((step + 2)). Poise Link. Each person installs it on their computer, enters $domain,
   and approves the code it shows at $scheme://$domain/link
   (docs/Poise-Link.md).
EOF
}

require_linux
require_docker
require_env_file
require_free_ports
image=$(runtime_image)
sha=$(source_sha)
build_runtime_image "$image" "$sha"
if [ -n "$(proxy_listen)" ]; then
  say "Starting the gateway on $(proxy_listen), for your own proxy."
else
  say "Starting Caddy and the gateway."
fi
compose up --detach --build
wait_for_gateway
check_gateway_networks
next_steps
