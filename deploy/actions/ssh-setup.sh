#!/bin/bash
# Sets up the runner's SSH for .github/workflows/deploy.yml: the host name
# poise-server reaches the server as the deploy user, through the jump host
# when one is set, with the deploy key, and only if the server shows a host
# key from POISE_DEPLOY_KNOWN_HOSTS. docs/Operating.md, "Run your own Poise
# from a fork", describes each setting.
#
#   POISE_DEPLOY_HOST=... POISE_DEPLOY_USER=... POISE_DEPLOY_KNOWN_HOSTS=... POISE_DEPLOY_SSH_KEY=... deploy/actions/ssh-setup.sh
set -euo pipefail

die() {
  printf 'deploy: %s\n' "$*" >&2
  exit 1
}

host=${POISE_DEPLOY_HOST:-}
user=${POISE_DEPLOY_USER:-}
port=${POISE_DEPLOY_PORT:-22}
jump=${POISE_DEPLOY_JUMP:-}
[ -n "$host" ] || die "the repository sets no POISE_DEPLOY_HOST variable."
[ -n "$user" ] || die "the repository sets no POISE_DEPLOY_USER variable, the server account the workflow deploys as."
[ -n "${POISE_DEPLOY_SSH_KEY:-}" ] || die "the repository has no POISE_DEPLOY_SSH_KEY secret, the private key the workflow signs in with."
[ -n "${POISE_DEPLOY_KNOWN_HOSTS:-}" ] \
  || die "the repository sets no POISE_DEPLOY_KNOWN_HOSTS variable: the server's host keys, and the jump host's, as ssh-keyscan prints them."
for value in "$host" "$user" "$port" "$jump"; do
  [[ $value =~ ^[]A-Za-z0-9@:.[_-]*$ ]] || die "the deploy settings may hold only a host name, an address, a user and a port; got \"$value\"."
done

install -d -m 700 "$HOME/.ssh"
(
  umask 077
  printf '%s\n' "$POISE_DEPLOY_SSH_KEY" >"$HOME/.ssh/poise_deploy"
  printf '%s\n' "$POISE_DEPLOY_KNOWN_HOSTS" >"$HOME/.ssh/poise_known_hosts"
  {
    printf 'Host poise-server\n  HostName %s\n  User %s\n  Port %s\n' "$host" "$user" "$port"
    if [ -n "$jump" ]; then printf '  ProxyJump %s\n' "$jump"; fi
    # Every connection, the jump host's included: the deploy key alone, and only known host keys.
    printf 'Host *\n'
    printf '  IdentityFile %s\n  IdentitiesOnly yes\n' "$HOME/.ssh/poise_deploy"
    printf '  UserKnownHostsFile %s\n  StrictHostKeyChecking yes\n' "$HOME/.ssh/poise_known_hosts"
    printf '  BatchMode yes\n  ConnectTimeout 30\n  ServerAliveInterval 30\n'
  } >"$HOME/.ssh/config"
)
