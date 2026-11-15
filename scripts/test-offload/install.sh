#!/bin/sh
# Installs agents' test offload into a workspace's home volume. The gateway runs
# this in a short-lived container of the current image, next to each release
# install. The hooks live here rather than in a release because agents keep
# their path for as long as they run, and an old release gets deleted. With the
# gateway's settings gone the hooks stay in place and do nothing, so running
# agents are unharmed.
# docs/Operating.md, "Agents' test suites".
set -eu

source=$(dirname "$0")
target=$HOME/.poise/test-offload

if [ -z "${POISE_TEST_RELAY_URL:-}" ]; then
  rm -f "$target/relay"
  exit 0
fi

# On a first start this comes before the entrypoint, which makes ~/.poise private only when it creates it.
[ -d "$HOME/.poise" ] || mkdir -m 700 "$HOME/.poise"
mkdir -p "$target"
for file in redaction.mjs sitecustomize.py hook.cjs run.mjs; do
  cp "$source/$file" "$target/.$file.new"
  mv "$target/.$file.new" "$target/$file"
done
umask 077
printf '%s\n%s\n%s\n' "$POISE_TEST_RELAY_URL" "$POISE_TEST_RELAY_KEY" "${POISE_TEST_LIMIT_SECONDS:-540}" > "$target/.relay.new"
mv "$target/.relay.new" "$target/relay"
