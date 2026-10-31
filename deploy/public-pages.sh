#!/bin/bash
# Publish reviewed operator content through the maintained gateway, for any POISE_DOMAIN.
set -euo pipefail
# shellcheck source=deploy/lib.sh
. "$(dirname "$0")/lib.sh"

[ $# -eq 2 ] || die "usage: $0 validate|publish FILE.json"
action=$1
file=$2
case "$action" in validate | publish) ;; *) die "usage: $0 validate|publish FILE.json" ;; esac
[ -r "$file" ] || die "cannot read $file"
require_linux
require_docker
require_env_file

if [ "$action" = validate ]; then
  compose exec -T gateway node dist/public-pages-cli.js validate <"$file"
else
  compose exec -T gateway node dist/public-pages-cli.js install <"$file"
  compose restart gateway
  wait_for_gateway
  check_gateway_networks
fi
