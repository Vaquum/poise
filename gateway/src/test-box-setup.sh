#!/bin/sh
# What every test box starts from: the tools of the workspace image (deploy/runtime/Dockerfile), at the same
# paths, and Docker. test-relay.ts runs this once in a Render sandbox and keeps the result as a snapshot named
# after this file's contents, so a change here builds a new one. docs/Operating.md, "Agents' test suites".
set -eu
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq
apt-get install --yes -qq --no-install-recommends \
  build-essential curl fuse-overlayfs git iptables jq less locales openssh-client procps ripgrep tini unzip xz-utils
sed -i 's/^# *\(en_US.UTF-8 UTF-8\)$/\1/' /etc/locale.gen
locale-gen

curl -fsSL https://get.docker.com | sh

# The workspace's Node: a checkout's native modules are built for it, and it comes first on PATH.
node=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | sed -n 's/.*  \(node-v22[^ ]*-linux-x64\.tar\.xz\)$/\1/p')
curl -fsSL "https://nodejs.org/dist/latest-v22.x/$node" | tar -xJ --strip-components=1 -C /usr/local
hash -r

# The workspace's user, so that a suite meets the same permissions and the same home.
groupadd --gid 10001 poise
useradd --uid 10001 --gid 10001 --home-dir /home/poise --create-home --shell /bin/bash poise
chmod 700 /home/poise

# What a checkout brings along lands at the path it has in the workspace, unpacked by that user.
chmod 1777 / /opt

# The Chromium browser tests expect, for the Playwright in this repository's package-lock.json.
PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers npx --yes playwright@1.61.1 install --with-deps chromium
chmod -R a-w,a+rX /opt/playwright-browsers

node --version
docker --version
