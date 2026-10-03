#!/bin/bash
# Installs every provider CLI missing from ~/.local/bin, each with its vendor's
# own installer, into the home volume. Poise's updater
# (scripts/provider-cli-updates.mjs) keeps them current from then on, and
# Settings -> Connected accounts shows a CLI that is not installed.
#
# entrypoint.sh runs this in the background on every start. Its output goes to
# ~/.poise/logs/cli-bootstrap.log: a failed install is logged with the command
# and its exit code, the remaining CLIs are still installed, and Poise keeps
# running. It exits 1 when a CLI is still missing.
# shellcheck disable=SC2329 # the install_* functions run as "install_$provider"
set -uo pipefail

bin_dir="$HOME/.local/bin"
log_file="$HOME/.poise/logs/cli-bootstrap.log"
mkdir -p "$bin_dir" "${log_file%/*}" || exit 1
exec 3>&2 >>"$log_file" 2>&1

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

# Every command is bounded, so a stalled download fails instead of holding up
# the CLIs after it.
run() {
  timeout --kill-after=30s 15m "$@"
  local code=$?
  if [ "$code" -ne 0 ]; then
    log "command failed (exit $code): $*"
  fi
  return "$code"
}

fetch() {
  run curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --output "$2" "$1"
}

# A vendor's install script, downloaded whole before it runs: a download cut
# short never executes.
vendor_script() {
  local script code
  log "running $1"
  script=$(mktemp) || return
  fetch "$1" "$script" && run bash "$script"
  code=$?
  rm -f "$script"
  return "$code"
}

# https://code.claude.com/docs/en/setup: the native installer
# (https://claude.ai/install.sh) checks the binary against the SHA-256 in the
# release manifest, but not the manifest's signature. That signature is
# checked here first, as the page's "Binary integrity and code signing"
# describes; the checked binary then sets itself up with `claude install`, as
# install.sh does.
install_claude() {
  local platform work code
  case "$(uname -m)" in
    x86_64) platform=linux-x64 ;;
    aarch64) platform=linux-arm64 ;;
    *) log "claude: Claude Code has no build for $(uname -m)"; return 1 ;;
  esac
  work=$(mktemp -d) || return
  claude_release "$platform" "$work"
  code=$?
  rm -rf "$work"
  return "$code"
}

claude_release() {
  local platform=$1 work=$2 releases=https://downloads.claude.ai/claude-code-releases version checksum actual
  fetch "$releases/latest" "$work/latest" || return
  version=$(<"$work/latest")
  if ! [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
    log "claude: $releases/latest does not name a version"
    return 1
  fi
  fetch "$releases/$version/manifest.json" "$work/manifest.json" || return
  fetch "$releases/$version/manifest.json.sig" "$work/manifest.json.sig" || return
  run gpgv --keyring /usr/share/keyrings/claude-code.gpg "$work/manifest.json.sig" "$work/manifest.json" || return
  if ! checksum=$(jq --exit-status --raw-output --arg platform "$platform" \
    '.platforms[$platform].checksum | select(type == "string" and test("^[0-9a-f]{64}$"))' "$work/manifest.json"); then
    log "claude: the signed manifest of $version lists no $platform checksum"
    return 1
  fi
  fetch "$releases/$version/$platform/claude" "$work/claude" || return
  actual=$(sha256sum "$work/claude") || return
  if [ "${actual%% *}" != "$checksum" ]; then
    log "claude: the $platform binary of $version does not match its signed manifest"
    return 1
  fi
  chmod +x "$work/claude" && run "$work/claude" install
}

# https://github.com/openai/codex (npm), under ~/.local rather than npm's
# global prefix, which belongs to root. npm checks every package against the
# registry's integrity hash.
install_codex() {
  run npm install --global --prefix "$HOME/.local" --include=optional --no-audit --no-fund @openai/codex@latest
}

# https://docs.x.ai/build/overview: installs into ~/.grok and links grok into
# ~/.local/bin because that directory is on PATH. xAI publishes no checksums.
install_grok() {
  vendor_script https://x.ai/cli/install.sh
}

# https://antigravity.google/docs/cli/install/: installs ~/.local/bin/agy after
# checking the SHA-512 its release manifest lists.
install_antigravity() {
  vendor_script https://antigravity.google/cli/install.sh
}

# https://dev.meta.ai/docs/muse-code: installs the ~/.local/bin/muse launcher,
# which downloads the binary beside it; both are checked against the SHA-256
# Meta publishes. The page pipes the script to sh, but it is a bash script.
install_muse() {
  vendor_script https://dev.meta.ai/install.sh
}

log "bootstrap started"
missing=()
for entry in claude:claude codex:codex grok:grok antigravity:agy muse:muse; do
  provider=${entry%%:*}
  command="$bin_dir/${entry#*:}"
  if [ -x "$command" ]; then
    log "$provider: present at $command"
    continue
  fi
  log "$provider: installing"
  if ! "install_$provider"; then
    log "$provider: not installed"
    missing+=("$provider")
  elif [ ! -x "$command" ]; then
    log "$provider: not installed; its installer finished without $command"
    missing+=("$provider")
  elif ! version=$(MUSE_NO_AUTO_UPDATE=1 run "$command" --version); then
    log "$provider: not installed; $command does not run"
    missing+=("$provider")
  else
    log "$provider: installed $command (${version%%$'\n'*})"
  fi
done

if [ ${#missing[@]} -eq 0 ]; then
  log "bootstrap finished: every provider CLI is installed"
  exit 0
fi
log "bootstrap finished: not installed: ${missing[*]}"
echo "poise-runtime: provider CLIs not installed: ${missing[*]}; see $log_file." >&3
exit 1
