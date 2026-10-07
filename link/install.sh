#!/bin/sh
# Installs Poise Link, the desktop companion to a Poise workspace, together
# with Espanso when Espanso is missing, on macOS or on Debian and Ubuntu
# (amd64):
#
#   curl -fsSL https://github.com/autonomio/poise/releases/latest/download/install.sh | sh
#   wget -qO- https://github.com/autonomio/poise/releases/latest/download/install.sh | sh
#
# Run it as yourself; on Linux it asks for sudo to install the packages. Run it
# again to update Poise Link. docs/Poise-Link.md describes every step.
#
# Optional settings:
#   POISE_LINK_DOWNLOAD_BASE  where Poise Link's installers and SHA256SUMS are
#                             (default: the latest release)
#   POISE_LINK_APP_DIR        macOS: the folder the apps go to, and the only
#                             folder Espanso is looked for in (default:
#                             /Applications, or ~/Applications when
#                             /Applications is not writable)
#   POISE_LINK_ESPANSO_WAIT   seconds to wait for Espanso's first-run setup
#                             (default 900; 0 does not wait)
#   POISE_LINK_SESSION        Linux: x11 or wayland, when the terminal is not
#                             part of the desktop session
#
# Everything runs from main, called on the last line, so a partly downloaded
# script does nothing.

set -eu

RELEASE_BASE=https://github.com/autonomio/poise/releases/latest/download
RELEASES=https://github.com/autonomio/poise/releases/latest
DOCS=https://github.com/autonomio/poise/blob/main/docs/Poise-Link.md
MAC_IMAGE=Poise-Link-macos-universal.dmg
DEBIAN_PACKAGE=Poise-Link-linux-amd64.deb

# Espanso's own release, pinned: these exact files are what gets installed.
ESPANSO_VERSION=2.4.1
ESPANSO_BASE=https://github.com/espanso/espanso/releases/download/v$ESPANSO_VERSION
ESPANSO_MAC_IMAGE=Espanso-Mac-Universal.dmg
ESPANSO_MAC_SHA256=e6aee2d9446d7625e57dafc6613add21fc7c9f709ba42f08b5ada844c6f7110a
ESPANSO_X11_PACKAGE=espanso-debian-x11-amd64.deb
ESPANSO_X11_SHA256=190305ea01b6fe24c87867532fb1786ad5622fd2d5deeefb0ecace26ef4078c7
ESPANSO_WAYLAND_PACKAGE=espanso-debian-wayland-amd64.deb
ESPANSO_WAYLAND_SHA256=d4b3b284c6fabf6f2a73dc269189fb5a06611547529853c87b58d07aa7d295ae

WORK=
MOUNT=
ESPANSO_CLI=
ESPANSO_STARTED=
ESPANSO_READY=
LINK_OPEN=
STOP_WAITING=

say() {
	printf '%s\n' "$*"
}

step() {
	printf '\n==> %s\n' "$*"
}

warn() {
	printf 'Warning: %s\n' "$*" >&2
}

fail() {
	printf 'Error: %s\n' "$*" >&2
	exit 1
}

has() {
	command -v "$1" >/dev/null 2>&1
}

need() {
	for needed in "$@"; do
		has "$needed" || fail "this installer needs $needed, which is not installed"
	done
}

cleanup() {
	if [ -n "$MOUNT" ]; then
		hdiutil detach "$MOUNT" -quiet -force >/dev/null 2>&1 || warn "could not detach the disk image at $MOUNT"
	fi
	if [ -n "$WORK" ]; then
		rm -rf "$WORK"
	fi
}

# fetch URL FILE
fetch() {
	if has curl; then
		curl --proto '=https,file' --proto-redir '=https' --fail --silent --show-error \
			--location --retry 3 --output "$2" "$1" || fail "could not download $1"
	else
		wget --quiet --output-document="$2" "$1" || fail "could not download $1"
	fi
}

sha256_of() {
	if has sha256sum; then
		set -- "$(sha256sum "$1")"
	else
		set -- "$(shasum -a 256 "$1")"
	fi
	printf '%s\n' "${1%% *}"
}

# check FILE SHA256
check() {
	actual_sha256=$(sha256_of "$1")
	[ "$actual_sha256" = "$2" ] ||
		fail "${1##*/} does not match its SHA-256 checksum (expected $2, got $actual_sha256). Nothing was installed."
}

# fetch_release NAME: one of Poise Link's installers, checked against the
# release's SHA256SUMS, which must already be in WORK.
fetch_release() {
	fetch "$BASE/$1" "$WORK/$1"
	listed_sha256=$(awk -v name="$1" '$2 == name || $2 == "*" name { print $1; exit }' "$WORK/SHA256SUMS")
	[ -n "$listed_sha256" ] || fail "the release's SHA256SUMS does not list $1. Nothing was installed."
	check "$WORK/$1" "$listed_sha256"
}

# running NAME: prints the IDs of this user's processes called NAME, and fails
# when there are none.
running() {
	has pgrep || return 1
	pgrep -x -u "$(id -u)" "$1"
}

can_open_link() {
	[ "$OS" = Darwin ] || [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]
}

open_link() {
	if [ "$OS" = Darwin ]; then
		open "$APP_DIR/Poise Link.app"
	else
		setsid poise-link </dev/null >/dev/null 2>&1 &
	fi
	LINK_OPEN=1
}

# The running Poise Link is the previous version once the new one is in
# place: quit it and open the new one. Nothing stops Poise Link before the
# new version is installed, so a failed install leaves it running.
restart_link() {
	link_pids=$(running poise-link) || return 0
	if ! can_open_link; then
		warn "Poise Link is still running the previous version. Quit it from its menu and open it again to use the new one."
		LINK_OPEN=1
		return
	fi
	step "Restarting Poise Link"
	# One argument per process ID.
	# shellcheck disable=SC2086
	kill $link_pids
	waited_for_link=0
	while running poise-link >/dev/null; do
		[ "$waited_for_link" -lt 20 ] ||
			fail "the previous Poise Link did not quit. Quit it from its menu and open Poise Link again to use the new version."
		sleep 1
		waited_for_link=$((waited_for_link + 1))
	done
	open_link
}

# The folder Espanso reads match files from, found the way Poise Link finds it:
# the folder `espanso path config` names, otherwise Espanso's default.
espanso_match_dir() {
	if [ -n "$ESPANSO_CLI" ] && espanso_config=$("$ESPANSO_CLI" path config 2>/dev/null) && [ -n "$espanso_config" ]; then
		printf '%s/match\n' "$espanso_config"
	elif [ "$OS" = Darwin ]; then
		printf '%s/Library/Application Support/espanso/match\n' "$HOME"
	else
		case ${XDG_CONFIG_HOME:-} in
		/*) printf '%s/espanso/match\n' "$XDG_CONFIG_HOME" ;;
		*) printf '%s/.config/espanso/match\n' "$HOME" ;;
		esac
	fi
}

# Espanso creates its match folder when its first-run setup finishes, and
# Poise Link writes the snippets into that folder. Waiting only makes sense
# while Espanso runs.
wait_for_espanso() {
	match_dir=$(espanso_match_dir)
	if [ ! -d "$match_dir" ] && [ -n "$ESPANSO_STARTED" ] && [ "$ESPANSO_WAIT" -gt 0 ]; then
		say "Espanso's setup window is open. $1"
		say "Waiting for the setup to finish (Ctrl-C stops waiting)..."
		trap 'STOP_WAITING=1' INT
		waited_for_espanso=0
		while [ ! -d "$match_dir" ] && [ -z "$STOP_WAITING" ] && [ "$waited_for_espanso" -lt "$ESPANSO_WAIT" ]; do
			# Ctrl-C ends the sleep as well; the loop then sees STOP_WAITING.
			sleep 2 || :
			waited_for_espanso=$((waited_for_espanso + 2))
		done
		trap 'exit 130' INT
	fi
	if [ -d "$match_dir" ]; then
		ESPANSO_READY=1
		say "Espanso is ready: Poise Link writes your snippets to $match_dir."
	fi
}

mac_app_dir() {
	if [ -n "${POISE_LINK_APP_DIR:-}" ]; then
		printf '%s\n' "$POISE_LINK_APP_DIR"
	elif [ -d "$HOME/Applications/Poise Link.app" ] && [ ! -d "/Applications/Poise Link.app" ]; then
		printf '%s\n' "$HOME/Applications"
	elif [ -w /Applications ]; then
		printf '%s\n' /Applications
	else
		printf '%s\n' "$HOME/Applications"
	fi
}

mac_espanso_app() {
	if [ -n "${POISE_LINK_APP_DIR:-}" ]; then
		set -- "$POISE_LINK_APP_DIR"
	else
		set -- /Applications "$HOME/Applications"
	fi
	for espanso_dir in "$@"; do
		if [ -d "$espanso_dir/Espanso.app" ]; then
			printf '%s\n' "$espanso_dir/Espanso.app"
			return
		fi
	done
}

mac_version() {
	sed -n '/<key>CFBundleShortVersionString<\/key>/{n;s/.*<string>\(.*\)<\/string>.*/\1/p;}' "$1/Contents/Info.plist"
}

# mac_install_app IMAGE APP: copies APP from the disk image IMAGE into APP_DIR,
# replacing the copy already there. Downloading with curl or wget leaves the
# app without macOS's quarantine flag, so it opens without a Gatekeeper prompt.
mac_install_app() {
	mkdir -p "$APP_DIR"
	mount_dir=$(mktemp -d "$WORK/mount.XXXXXX")
	hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mount_dir" "$1" >/dev/null ||
		fail "could not open ${1##*/}"
	MOUNT=$mount_dir
	[ -d "$MOUNT/$2" ] || fail "${1##*/} does not contain $2"
	rm -rf "$APP_DIR/.$2.new"
	if ! ditto "$MOUNT/$2" "$APP_DIR/.$2.new"; then
		rm -rf "$APP_DIR/.$2.new"
		fail "could not copy $2 to $APP_DIR"
	fi
	hdiutil detach "$MOUNT" -quiet || fail "could not detach ${1##*/}"
	MOUNT=
	rm -rf "${APP_DIR:?}/$2"
	mv "$APP_DIR/.$2.new" "$APP_DIR/$2"
}

install_mac() {
	need hdiutil ditto open
	APP_DIR=$(mac_app_dir)
	espanso_app=$(mac_espanso_app)
	if [ -n "$espanso_app" ]; then
		ESPANSO_CLI=$espanso_app/Contents/MacOS/espanso
	elif has espanso; then
		ESPANSO_CLI=$(command -v espanso)
	fi

	# Every download is checked before anything on the computer changes.
	step "Downloading Poise Link"
	fetch "$BASE/SHA256SUMS" "$WORK/SHA256SUMS"
	fetch_release "$MAC_IMAGE"
	if [ -z "$ESPANSO_CLI" ]; then
		step "Downloading Espanso $ESPANSO_VERSION"
		fetch "$ESPANSO_BASE/$ESPANSO_MAC_IMAGE" "$WORK/$ESPANSO_MAC_IMAGE"
		check "$WORK/$ESPANSO_MAC_IMAGE" "$ESPANSO_MAC_SHA256"
	fi

	if [ -z "$ESPANSO_CLI" ]; then
		step "Installing Espanso in $APP_DIR"
		mac_install_app "$WORK/$ESPANSO_MAC_IMAGE" Espanso.app
		espanso_app=$APP_DIR/Espanso.app
		ESPANSO_CLI=$espanso_app/Contents/MacOS/espanso
	else
		say "Espanso is already installed; it is left as it is."
	fi
	step "Installing Poise Link in $APP_DIR"
	mac_install_app "$WORK/$MAC_IMAGE" "Poise Link.app"
	say "Installed Poise Link $(mac_version "$APP_DIR/Poise Link.app")."
	restart_link

	if running espanso >/dev/null; then
		ESPANSO_STARTED=1
	elif [ -n "$espanso_app" ]; then
		step "Starting Espanso"
		open "$espanso_app"
		ESPANSO_STARTED=1
	else
		warn "Espanso is installed but not running. Start it, and Poise Link fills it with your snippets."
	fi
	wait_for_espanso "Allow Accessibility when it asks: Espanso needs it to type your snippets."
}

detect_session() {
	if [ -n "${POISE_LINK_SESSION:-}" ]; then
		case $POISE_LINK_SESSION in
		x11 | wayland) SESSION=$POISE_LINK_SESSION ;;
		*) fail "POISE_LINK_SESSION must be x11 or wayland" ;;
		esac
		return
	fi
	case ${XDG_SESSION_TYPE:-} in
	x11 | wayland) SESSION=$XDG_SESSION_TYPE ;;
	*)
		if [ -n "${WAYLAND_DISPLAY:-}" ]; then
			SESSION=wayland
		elif [ -n "${DISPLAY:-}" ]; then
			SESSION=x11
		else
			fail "cannot tell whether your desktop runs X11 or Wayland, which decides Espanso's package. Run this from a terminal in your desktop session, or set POISE_LINK_SESSION=x11 or POISE_LINK_SESSION=wayland."
		fi
		;;
	esac
}

start_espanso_linux() {
	if running espanso >/dev/null; then
		ESPANSO_STARTED=1
		return
	fi
	if ! has systemctl || ! systemctl --user show-environment >/dev/null 2>&1; then
		warn "there is no systemd user session here, so Espanso cannot be set to start at login. In your desktop session run: espanso service register && espanso start"
		return
	fi
	step "Starting Espanso"
	"$ESPANSO_CLI" service register || fail "could not register Espanso's service; run espanso service register to see why"
	# Not `espanso start`: it times out while Espanso's welcome window is open.
	systemctl --user start espanso || fail "could not start Espanso's service; systemctl --user status espanso says why"
	ESPANSO_STARTED=1
}

install_linux() {
	machine=$(uname -m)
	[ "$machine" = x86_64 ] ||
		fail "Espanso publishes Linux packages for x86_64 only, and this computer is $machine. $DOCS lists what works elsewhere."
	if ! has apt-get || ! has dpkg; then
		fail "this installer covers Debian and Ubuntu, which use apt. On other distributions install Espanso (https://espanso.org/install/) and Poise Link's AppImage from $RELEASES by hand, as $DOCS describes."
	fi
	need sudo
	espanso_package=
	if has espanso; then
		ESPANSO_CLI=$(command -v espanso)
	else
		detect_session
		if [ "$SESSION" = wayland ]; then
			espanso_package=$ESPANSO_WAYLAND_PACKAGE
			espanso_sha256=$ESPANSO_WAYLAND_SHA256
		else
			espanso_package=$ESPANSO_X11_PACKAGE
			espanso_sha256=$ESPANSO_X11_SHA256
		fi
	fi

	# Every download is checked before anything on the computer changes.
	step "Downloading Poise Link"
	fetch "$BASE/SHA256SUMS" "$WORK/SHA256SUMS"
	fetch_release "$DEBIAN_PACKAGE"
	if [ -n "$espanso_package" ]; then
		step "Downloading Espanso $ESPANSO_VERSION for $SESSION"
		fetch "$ESPANSO_BASE/$espanso_package" "$WORK/$espanso_package"
		check "$WORK/$espanso_package" "$espanso_sha256"
	else
		say "Espanso is already installed; it is left as it is."
	fi

	# apt reads local packages as its own _apt user.
	chmod 755 "$WORK"
	chmod 644 "$WORK"/*.deb
	set -- "$WORK/$DEBIAN_PACKAGE"
	if [ -n "$espanso_package" ]; then
		set -- "$@" "$WORK/$espanso_package"
		if [ "$SESSION" = wayland ]; then
			set -- "$@" libcap2-bin
		fi
	fi

	step "Installing the packages (sudo may ask for your password)"
	sudo apt-get update || warn "apt-get update failed; installing with the package lists this computer already has"
	if ! sudo DEBIAN_FRONTEND=noninteractive apt-get install --yes "$@"; then
		if [ -n "$espanso_package" ]; then
			fail "apt-get could not install the packages; its messages above say why. When it cannot find a dependency such as libwxgtk3.2-1, the cause is the release: Espanso $ESPANSO_VERSION's packages need Debian 12 or Ubuntu 24.04 or newer."
		fi
		fail "apt-get could not install Poise Link's package; its messages above say why."
	fi
	# shellcheck disable=SC2016
	say "Installed Poise Link $(dpkg-query --show --showformat='${Version}' poise-link)."
	restart_link
	if [ -n "$espanso_package" ]; then
		ESPANSO_CLI=$(command -v espanso) || fail "Espanso's package did not install the espanso command"
		if [ "$SESSION" = wayland ]; then
			step "Letting Espanso read the keyboard on Wayland"
			sudo setcap cap_dac_override+p "$ESPANSO_CLI" ||
				fail "could not give Espanso the capability it needs on Wayland"
		fi
	fi

	start_espanso_linux
	wait_for_espanso "Choose Start in it."
}

finish() {
	step "Done"
	say "If Poise Link is not paired yet, enter the address you sign in to Poise at"
	say "(for example poise.example.com) in its window and choose Pair."
	if [ -z "$ESPANSO_READY" ]; then
		say "Espanso's setup has not finished yet. Once it has, Poise Link fills Espanso"
		say "with your snippets within ten minutes, or at once with Sync now in its menu."
	fi
}

main() {
	[ "$(id -u)" -ne 0 ] ||
		fail "run this as yourself, not as root or with sudo. On Linux it asks for sudo when it installs the packages."
	has curl || has wget || fail "this installer needs curl or wget to download"
	has sha256sum || has shasum || fail "this installer needs sha256sum or shasum to check the downloads"
	BASE=${POISE_LINK_DOWNLOAD_BASE:-$RELEASE_BASE}
	ESPANSO_WAIT=${POISE_LINK_ESPANSO_WAIT:-900}
	case $ESPANSO_WAIT in
	'' | *[!0-9]*) fail "POISE_LINK_ESPANSO_WAIT must be a whole number of seconds" ;;
	esac
	OS=$(uname -s)
	case $OS in
	Darwin | Linux) ;;
	*) fail "this installer covers macOS and Linux. On Windows, use the installer from $RELEASES" ;;
	esac

	trap cleanup EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
	WORK=$(mktemp -d)
	if [ "$OS" = Darwin ]; then
		install_mac
	else
		install_linux
	fi
	if [ -z "$LINK_OPEN" ]; then
		if can_open_link; then
			step "Opening Poise Link"
			open_link
		else
			say "Open Poise Link from your applications menu."
		fi
	fi
	finish
}

main "$@"
