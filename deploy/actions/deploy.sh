#!/bin/bash
# Deploys commit SHA of REPO to the server deploy/actions/ssh-setup.sh named
# poise-server, into its checkout DEPLOY_PATH, as .github/workflows/deploy.yml
# runs it: deploy/actions/remote.sh does the server's part, and everything it
# needs, TOKEN and deploy/.env (from deploy/actions/env.sh) included, reaches
# the server's bash on its standard input, never on a command line.
#
#   REPO=... SHA=... DEPLOY_PATH=... TOKEN=... VARS=... POISE_GITHUB_CLIENT_SECRET=... deploy/actions/deploy.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
settings=$("$here/env.sh")
{
  printf 'repo=%q sha=%q path=%q token=%q settings=%q\n' "$REPO" "$SHA" "$DEPLOY_PATH" "$TOKEN" "$settings"
  cat "$here/remote.sh"
} | ssh poise-server bash -s
