#!/bin/sh
# Installs this image's Poise release into a workspace's home volume, for its
# supervisor to switch to (deploy/runtime/supervisor.mjs). The gateway runs
# this in a short-lived container of the new image, as the workspace user,
# with the workspace's home volume mounted. With --activate it also makes the
# release current, for a stopped workspace's next start.
set -eu

release=$(cat /opt/poise/RELEASE)
base=$(cat /opt/poise-runtime/BASE)
if [ -z "$release" ] || [ -z "$base" ]; then
  echo "install-release.sh: this image names no release or base; build it with deploy/lib.sh" >&2
  exit 1
fi
releases=$HOME/.poise/releases
mkdir -p "$releases"

if [ ! -f "$releases/$release/installed" ] || [ "$(cat "$releases/$release/base" 2>/dev/null || true)" != "$base" ]; then
  staging=$(mktemp -d "$releases/.install-XXXXXX")
  cp -a /opt/poise "$staging/poise"
  cp -a /opt/caller/venv "$staging/venv"
  printf '%s\n' "$base" > "$staging/base"
  : > "$staging/installed"
  rm -rf "${releases:?}/$release"
  mv "$staging" "$releases/$release"
fi

if [ "${1:-}" = --activate ]; then
  # Dated to now, as the supervisor dates a release it switches away from: the pruning below counts from it.
  previous=$(cat "$releases/current" 2>/dev/null || true)
  case $previous in ''|*/*|.*) ;; *) [ "$previous" = "$release" ] || [ ! -d "$releases/$previous" ] || touch "$releases/$previous" ;; esac
  printf '%s\n' "$release" > "$releases/current.tmp"
  mv "$releases/current.tmp" "$releases/current"
  # A switch queued before the workspace stopped would start ahead of current.
  rm -f "$releases/next"
fi

# Older releases go once five newer ones exist and three hours have passed
# since they were last current (a release's directory is dated to the moment
# it stopped being current, or its install), so an agent still running from
# one keeps its files. The current release and this one always stay.
current=$(cat "$releases/current" 2>/dev/null || true)
find "$releases" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%T@ %f\n' | sort -rn | tail -n +6 |
  while read -r _ old; do
    if [ "$old" != "$release" ] && [ "$old" != "$current" ] && [ -n "$(find "$releases/$old" -maxdepth 0 -mmin +180)" ]; then
      rm -rf "${releases:?}/$old"
    fi
  done
# What an interrupted install left.
find "$releases" -maxdepth 1 -name '.install-*' -mmin +60 -exec rm -rf {} +

echo "installed release $release"
