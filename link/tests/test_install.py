"""Tests link/install.sh, the one-command installer for Poise Link and Espanso.

The script runs with every system command it could change the computer with
replaced by a stand-in that records its arguments, and with nothing else on
PATH but a few harmless tools (curl reads local file:// fixtures). Nothing on
the computer running the tests is installed, started or stopped:

    python3 -m unittest discover --start-directory link/tests --pattern 'test_*.py'

CI also runs the real script on fresh macOS, Ubuntu and Debian machines
(.github/workflows/link.yml).
"""

import hashlib
import io
import os
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import time
import unittest
from dataclasses import dataclass
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / 'install.sh'
# The shell that runs the script, as `curl ... | sh` would: dash on Debian and Ubuntu, bash on macOS.
SH = shutil.which('sh') or '/bin/sh'

# The real tools on the script's PATH. Everything else it runs is a stand-in.
REAL_TOOLS = ['awk', 'basename', 'cat', 'chmod', 'cp', 'env', 'find', 'mkdir', 'mktemp', 'mv', 'rm', 'sed', 'sleep', 'tar']
DOWNLOADERS = ['curl']
HASHERS = ['sha256sum', 'shasum']

POISE_IMAGE = 'Poise-Link-macos-universal.dmg'
POISE_PACKAGE = 'Poise-Link-linux-amd64.deb'
ESPANSO_IMAGE = 'Espanso-Mac-Universal.dmg'
ESPANSO_X11 = 'espanso-debian-x11-amd64.deb'
ESPANSO_WAYLAND = 'espanso-debian-wayland-amd64.deb'

# Appends one line per call to $CALLS: the command's name and its arguments, separated by \x1f.
RECORD = r'''#!/bin/sh
{ printf '%s' "${0##*/}"; for arg in "$@"; do printf '\037%s' "$arg"; done; printf '\n'; } >>"$CALLS"
'''

STANDINS = {
    'uname': r'''
case $1 in
-s) cat "$STATE/os" ;;
-m) cat "$STATE/machine" ;;
esac
''',
    'id': r'''
cat "$STATE/uid"
''',
    # Prints the live process IDs listed for the name in its last argument.
    'pgrep': r'''
for name; do :; done
found=1
if [ -f "$STATE/pids.$name" ]; then
	for pid in $(cat "$STATE/pids.$name"); do
		if kill -0 "$pid" 2>/dev/null; then
			echo "$pid"
			found=0
		fi
	done
fi
exit $found
''',
    # A disk image is a tar archive here: attaching unpacks it at the mount point.
    'hdiutil': r'''
case $1 in
attach)
	shift
	while [ $# -gt 0 ]; do
		case $1 in
		-mountpoint) mount=$2; shift 2 ;;
		-*) shift ;;
		*) image=$1; shift ;;
		esac
	done
	tar -xf "$image" -C "$mount"
	;;
detach)
	find "$2" -mindepth 1 -delete
	;;
esac
''',
    'ditto': r'''
cp -R "$1" "$2"
''',
    # Opening Espanso for the first time ends, when the person finishes its setup, with its match folder.
    'open': r'''
case $1 in
*/Espanso.app)
	if [ -f "$STATE/espanso-setup-finishes" ]; then
		mkdir -p "$HOME/Library/Application Support/espanso/match"
	fi
	;;
esac
''',
    'sudo': r'''
exec env "$@"
''',
    # Installing a package puts its command on PATH.
    'apt-get': r'''
case $1 in
update)
	exit "$(cat "$STATE/apt-update-exit")"
	;;
install)
	[ ! -f "$STATE/apt-install-fails" ] || exit 100
	for arg; do
		case $arg in
		*/Poise-Link-linux-amd64.deb) cp "$STATE/recorder" "$STANDINS/poise-link" ;;
		*/espanso-debian-*.deb) cp "$STATE/espanso" "$STANDINS/espanso" ;;
		esac
	done
	;;
esac
''',
    'dpkg': r'''
echo amd64
''',
    'dpkg-query': r'''
echo 0.1.0
''',
    'setcap': '',
    'setsid': '',
    'systemctl': r'''
case "$1 $2" in
"--user show-environment")
	exit "$(cat "$STATE/systemd-user-exit")"
	;;
"--user start")
	if [ -f "$STATE/espanso-setup-finishes" ]; then
		mkdir -p "$HOME/.config/espanso/match"
	fi
	;;
esac
''',
}

# Espanso's command: `espanso path config` fails until its configuration exists, as the real one does.
ESPANSO = r'''
case "$1 $2" in
"path config")
	for config in "$HOME/.config/espanso" "$HOME/Library/Application Support/espanso"; do
		if [ -d "$config" ]; then
			echo "$config"
			exit 0
		fi
	done
	echo "thread 'main' panicked: unable to load config" >&2
	exit 101
	;;
esac
'''

WGET = r'''
for arg; do
	case $arg in
	--output-document=*) out=${arg#--output-document=} ;;
	file://*) src=${arg#file://} ;;
	esac
done
cp "$src" "$out"
'''


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_executable(path, text):
    path.write_text(text)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def disk_image(path, files):
    """A stand-in disk image: a tar archive of `files`, {name: (text, executable)}."""
    with tarfile.open(path, 'w') as tar:
        for name, (text, executable) in files.items():
            data = text.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o755 if executable else 0o644
            tar.addfile(info, io.BytesIO(data))


def info_plist(version):
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>poise-link</string>
	<key>CFBundleShortVersionString</key>
	<string>{version}</string>
</dict>
</plist>
'''


def detached_sleeper():
    """A process that is not this test's child, so its exit is reaped at once."""
    out = subprocess.run(['sh', '-c', 'sleep 600 >/dev/null 2>&1 & echo $!'], capture_output=True, text=True, check=True)
    return int(out.stdout)


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


@dataclass
class Run:
    returncode: int
    stdout: str
    stderr: str
    seconds: float


class Installer:
    """One run's world: stand-ins, fixtures, a home folder and a copy of the script."""

    def __init__(self, test, os_name, machine='x86_64'):
        self.test = test
        self.root = Path(tempfile.mkdtemp(prefix='poise-link-install-'))
        test.addCleanup(shutil.rmtree, self.root, True)
        self.home = self.root / 'home'
        self.tmp = self.root / 'tmp'
        self.state = self.root / 'state'
        self.standins = self.root / 'standins'
        self.tools = self.root / 'tools'
        self.release = self.root / 'release'
        self.espanso_release = self.root / 'espanso-release'
        self.apps = self.root / 'Applications'
        for folder in (self.home, self.tmp, self.state, self.standins, self.tools, self.release, self.espanso_release):
            folder.mkdir()
        self.calls_file = self.root / 'calls'
        self.calls_file.touch()

        for name in REAL_TOOLS + DOWNLOADERS + HASHERS:
            found = shutil.which(name)
            if found:
                (self.tools / name).symlink_to(found)
        for name in REAL_TOOLS + DOWNLOADERS:
            test.assertTrue((self.tools / name).exists(), f'the tests need {name}')
        test.assertTrue(any((self.tools / name).exists() for name in HASHERS), 'the tests need sha256sum or shasum')

        write_executable(self.state / 'recorder', RECORD)
        write_executable(self.state / 'espanso', RECORD + ESPANSO)
        for name, body in STANDINS.items():
            write_executable(self.standins / name, RECORD + body)
        (self.state / 'os').write_text(os_name + '\n')
        (self.state / 'machine').write_text(machine + '\n')
        (self.state / 'uid').write_text('501\n')
        (self.state / 'apt-update-exit').write_text('0\n')
        (self.state / 'systemd-user-exit').write_text('0\n')

        disk_image(self.release / POISE_IMAGE, {
            'Poise Link.app/Contents/Info.plist': (info_plist('0.1.0'), False),
            'Poise Link.app/Contents/MacOS/poise-link': (RECORD, True),
        })
        (self.release / POISE_PACKAGE).write_bytes(b'poise-link 0.1.0 amd64 package\n')
        disk_image(self.espanso_release / ESPANSO_IMAGE, {
            'Espanso.app/Contents/Info.plist': (info_plist('2.4.1'), False),
            'Espanso.app/Contents/MacOS/espanso': (RECORD + ESPANSO, True),
        })
        (self.espanso_release / ESPANSO_X11).write_bytes(b'espanso 2.4.1 x11 package\n')
        (self.espanso_release / ESPANSO_WAYLAND).write_bytes(b'espanso 2.4.1 wayland package\n')
        self.write_sums()

        self.script = self.root / 'install.sh'
        self.write_script()
        self.env = {
            'PATH': f'{self.standins}:{self.tools}',
            'HOME': str(self.home),
            'TMPDIR': str(self.tmp),
            'CALLS': str(self.calls_file),
            'STATE': str(self.state),
            'STANDINS': str(self.standins),
            'POISE_LINK_DOWNLOAD_BASE': f'file://{self.release}',
            'POISE_LINK_APP_DIR': str(self.apps),
            'POISE_LINK_ESPANSO_WAIT': '6',
        }

    def write_sums(self, overrides=None, leave_out=()):
        lines = []
        for path in sorted(self.release.iterdir()):
            if path.name == 'SHA256SUMS' or path.name in leave_out:
                continue
            lines.append(f'{(overrides or {}).get(path.name, sha256(path))}  {path.name}\n')
        (self.release / 'SHA256SUMS').write_text(''.join(lines))

    def write_script(self, espanso_sums=None):
        """The script, with Espanso's pinned release swapped for the fixtures."""
        sums = {
            'ESPANSO_MAC_SHA256': sha256(self.espanso_release / ESPANSO_IMAGE),
            'ESPANSO_X11_SHA256': sha256(self.espanso_release / ESPANSO_X11),
            'ESPANSO_WAYLAND_SHA256': sha256(self.espanso_release / ESPANSO_WAYLAND),
            **(espanso_sums or {}),
        }
        text = SCRIPT.read_text()
        replacements = {'ESPANSO_BASE': f'file://{self.espanso_release}', **sums}
        for name, value in replacements.items():
            text, count = re.subn(rf'^{name}=.*$', f'{name}={value}', text, flags=re.M)
            self.test.assertEqual(count, 1, f'install.sh sets {name} on exactly one line')
        self.script.write_text(text)

    def standin(self, name, body=''):
        write_executable(self.standins / name, RECORD + body)

    def remove(self, name):
        for folder in (self.standins, self.tools):
            if (folder / name).exists() or (folder / name).is_symlink():
                (folder / name).unlink()

    def set(self, name, value=''):
        (self.state / name).write_text(value)

    def running(self, name):
        pid = detached_sleeper()
        self.test.addCleanup(lambda: alive(pid) and os.kill(pid, 9))
        self.set(f'pids.{name}', f'{pid}\n')
        return pid

    def run(self, script=None, **env):
        started = time.monotonic()
        result = subprocess.run([SH, str(script or self.script)], env={**self.env, **env},
                                capture_output=True, text=True, timeout=120, stdin=subprocess.DEVNULL)
        return Run(result.returncode, result.stdout, result.stderr, time.monotonic() - started)

    def calls(self, name=None):
        out = []
        for line in self.calls_file.read_text().splitlines():
            parts = line.split('\x1f')
            if name is None or parts[0] == name:
                out.append(parts)
        return out

    def names(self):
        return [call[0] for call in self.calls()]

    def background_calls(self, name, count=1):
        """Calls the script started in the background and did not wait for."""
        deadline = time.monotonic() + 10
        while len(self.calls(name)) < count and time.monotonic() < deadline:
            time.sleep(0.05)
        return self.calls(name)

    def system_changes(self):
        """Calls that would change the computer."""
        changing = {'hdiutil', 'ditto', 'open', 'sudo', 'apt-get', 'setcap', 'systemctl', 'setsid', 'espanso'}
        return [call for call in self.calls() if call[0] in changing and call[1:3] != ['--user', 'show-environment']]


class InstallerTest(unittest.TestCase):
    def assert_ok(self, result):
        self.assertEqual(result.returncode, 0, f'stdout:\n{result.stdout}\nstderr:\n{result.stderr}')

    def assert_refused(self, result, message):
        self.assertEqual(result.returncode, 1, f'stdout:\n{result.stdout}\nstderr:\n{result.stderr}')
        self.assertIn(message, result.stderr)

    def assert_cleaned_up(self, installer):
        self.assertEqual(list(installer.tmp.iterdir()), [], 'the download folder is removed')


class MacTest(InstallerTest):
    def test_installs_espanso_and_poise_link_then_opens_espanso_first(self):
        mac = Installer(self, 'Darwin', 'arm64')
        mac.set('espanso-setup-finishes')
        result = mac.run()
        self.assert_ok(result)

        self.assertTrue((mac.apps / 'Espanso.app/Contents/MacOS/espanso').is_file())
        self.assertIn('<string>0.1.0</string>', (mac.apps / 'Poise Link.app/Contents/Info.plist').read_text())
        self.assertEqual(sorted(p.name for p in mac.apps.iterdir()), ['Espanso.app', 'Poise Link.app'])
        attaches = [call for call in mac.calls('hdiutil') if call[1] == 'attach']
        self.assertEqual([call[-1].rsplit('/', 1)[1] for call in attaches], [ESPANSO_IMAGE, POISE_IMAGE])
        self.assertTrue(all('-readonly' in call and '-nobrowse' in call for call in attaches))
        self.assertEqual(len([call for call in mac.calls('hdiutil') if call[1] == 'detach']), 2)
        self.assertEqual([call[1] for call in mac.calls('open')], [str(mac.apps / 'Espanso.app'), str(mac.apps / 'Poise Link.app')])
        self.assertIn('Installed Poise Link 0.1.0.', result.stdout)
        self.assertIn('Espanso is ready', result.stdout)
        self.assertNotIn("setup has not finished", result.stdout)
        self.assert_cleaned_up(mac)

    def test_leaves_an_installed_espanso_alone(self):
        mac = Installer(self, 'Darwin', 'x86_64')
        espanso = mac.apps / 'Espanso.app'
        (espanso / 'Contents/MacOS').mkdir(parents=True)
        write_executable(espanso / 'Contents/MacOS/espanso', RECORD + ESPANSO)
        (espanso / 'mine').write_text('the person installed this\n')
        (mac.home / 'Library/Application Support/espanso/match').mkdir(parents=True)
        mac.running('espanso')
        (mac.espanso_release / ESPANSO_IMAGE).unlink()

        result = mac.run()
        self.assert_ok(result)
        self.assertIn('Espanso is already installed', result.stdout)
        self.assertTrue((espanso / 'mine').is_file())
        self.assertEqual([call[1] for call in mac.calls('open')], [str(mac.apps / 'Poise Link.app')])
        self.assertEqual(len([call for call in mac.calls('hdiutil') if call[1] == 'attach']), 1)

    def test_replaces_a_running_poise_link_and_opens_the_new_one(self):
        mac = Installer(self, 'Darwin', 'arm64')
        old = mac.apps / 'Poise Link.app'
        (old / 'Contents').mkdir(parents=True)
        (old / 'Contents/Info.plist').write_text(info_plist('0.0.9'))
        (old / 'Contents/stale').write_text('from the old version\n')
        (mac.apps / 'Espanso.app').mkdir()
        (mac.home / 'Library/Application Support/espanso/match').mkdir(parents=True)
        mac.running('espanso')
        link = mac.running('poise-link')

        result = mac.run()
        self.assert_ok(result)
        self.assertFalse(alive(link), 'the running Poise Link was asked to quit')
        self.assertIn('Quitting the running Poise Link', result.stdout)
        self.assertFalse((old / 'Contents/stale').exists(), 'the old app is replaced, not merged into')
        self.assertIn('<string>0.1.0</string>', (old / 'Contents/Info.plist').read_text())
        self.assertFalse(any(p.name.startswith('.') for p in mac.apps.iterdir()))
        self.assertEqual([call[1] for call in mac.calls('open')], [str(old)])

    def test_opens_poise_link_when_espanso_setup_is_not_finished_in_time(self):
        mac = Installer(self, 'Darwin', 'arm64')
        result = mac.run(POISE_LINK_ESPANSO_WAIT='2')
        self.assert_ok(result)
        self.assertGreaterEqual(result.seconds, 2)
        self.assertIn('Allow Accessibility', result.stdout)
        self.assertIn('setup has not finished yet', result.stdout)
        self.assertEqual([call[1] for call in mac.calls('open')], [str(mac.apps / 'Espanso.app'), str(mac.apps / 'Poise Link.app')])

    def test_does_not_wait_when_told_not_to(self):
        mac = Installer(self, 'Darwin', 'arm64')
        result = mac.run(POISE_LINK_ESPANSO_WAIT='0')
        self.assert_ok(result)
        self.assertNotIn('Waiting for the setup', result.stdout)
        self.assertIn('setup has not finished yet', result.stdout)

    def test_a_poise_link_download_that_fails_its_checksum_changes_nothing(self):
        mac = Installer(self, 'Darwin', 'arm64')
        mac.write_sums(overrides={POISE_IMAGE: '0' * 64})
        result = mac.run()
        self.assert_refused(result, f'{POISE_IMAGE} does not match its SHA-256 checksum')
        self.assertIn('Nothing was installed', result.stderr)
        self.assertEqual(mac.system_changes(), [])
        self.assertFalse(mac.apps.exists())
        self.assert_cleaned_up(mac)

    def test_an_espanso_download_that_fails_its_pinned_checksum_changes_nothing(self):
        mac = Installer(self, 'Darwin', 'arm64')
        mac.write_script(espanso_sums={'ESPANSO_MAC_SHA256': 'f' * 64})
        result = mac.run()
        self.assert_refused(result, f'{ESPANSO_IMAGE} does not match its SHA-256 checksum')
        self.assertEqual(mac.system_changes(), [])
        self.assertFalse(mac.apps.exists())

    def test_an_installer_missing_from_sha256sums_changes_nothing(self):
        mac = Installer(self, 'Darwin', 'arm64')
        mac.write_sums(leave_out=(POISE_IMAGE,))
        result = mac.run()
        self.assert_refused(result, f"SHA256SUMS does not list {POISE_IMAGE}")
        self.assertEqual(mac.system_changes(), [])


class LinuxTest(InstallerTest):
    def desktop(self, session):
        display = {'DISPLAY': ':0'} if session == 'x11' else {'WAYLAND_DISPLAY': 'wayland-0'}
        return {'XDG_SESSION_TYPE': session, **display}

    def test_x11_installs_both_packages_in_one_apt_call_then_starts_espanso_and_poise_link(self):
        linux = Installer(self, 'Linux')
        linux.set('espanso-setup-finishes')
        result = linux.run(**self.desktop('x11'))
        self.assert_ok(result)

        installs = [call for call in linux.calls('apt-get') if call[1] == 'install']
        self.assertEqual(len(installs), 1)
        self.assertEqual([arg.rsplit('/', 1)[-1] for arg in installs[0][2:]], ['--yes', POISE_PACKAGE, ESPANSO_X11])
        self.assertEqual(linux.calls('sudo')[0][1:], ['apt-get', 'update'])
        self.assertEqual(linux.calls('sudo')[1][1:3], ['DEBIAN_FRONTEND=noninteractive', 'apt-get'])
        self.assertEqual(linux.calls('setcap'), [])
        self.assertEqual([call[1:] for call in linux.calls('espanso') if call[1] == 'service'], [['service', 'register']])
        self.assertIn(['systemctl', '--user', 'start', 'espanso'], linux.calls('systemctl'))
        self.assertEqual(linux.background_calls('setsid'), [['setsid', 'poise-link']])
        order = [name for name in linux.names() if name in {'apt-get', 'espanso', 'setsid'}]
        self.assertEqual(order.index('setsid'), len(order) - 1, 'Poise Link starts last')
        self.assertLess(order.index('apt-get'), order.index('espanso'))
        self.assertIn('Installed Poise Link 0.1.0.', result.stdout)
        self.assertIn('Espanso is ready', result.stdout)
        self.assert_cleaned_up(linux)

    def test_wayland_installs_the_wayland_package_and_grants_its_capability(self):
        linux = Installer(self, 'Linux')
        linux.set('espanso-setup-finishes')
        result = linux.run(**self.desktop('wayland'))
        self.assert_ok(result)
        install = [call for call in linux.calls('apt-get') if call[1] == 'install'][0]
        self.assertEqual([arg.rsplit('/', 1)[-1] for arg in install[2:]], ['--yes', POISE_PACKAGE, ESPANSO_WAYLAND, 'libcap2-bin'])
        self.assertEqual(linux.calls('setcap'), [['setcap', 'cap_dac_override+p', str(linux.standins / 'espanso')]])
        names = linux.names()
        self.assertLess(names.index('setcap'), names.index('systemctl'), 'the capability is granted before Espanso starts')

    def test_the_session_can_be_named_when_the_terminal_does_not_say(self):
        linux = Installer(self, 'Linux')
        result = linux.run(POISE_LINK_SESSION='wayland', POISE_LINK_ESPANSO_WAIT='0')
        self.assert_ok(result)
        install = [call for call in linux.calls('apt-get') if call[1] == 'install'][0]
        self.assertTrue(install[4].endswith(ESPANSO_WAYLAND))
        self.assertEqual(linux.calls('setsid'), [], 'without a display, Poise Link is not started')
        self.assertIn('Open Poise Link from your applications menu', result.stdout)

    def test_with_espanso_installed_only_poise_link_is_installed(self):
        linux = Installer(self, 'Linux')
        linux.standin('espanso', ESPANSO)
        (linux.home / '.config/espanso/match').mkdir(parents=True)
        linux.running('espanso')
        (linux.espanso_release / ESPANSO_X11).unlink()

        result = linux.run()
        self.assert_ok(result)
        self.assertIn('Espanso is already installed', result.stdout)
        install = [call for call in linux.calls('apt-get') if call[1] == 'install'][0]
        self.assertEqual([arg.rsplit('/', 1)[-1] for arg in install[2:]], ['--yes', POISE_PACKAGE])
        self.assertEqual([call for call in linux.calls('espanso') if call[1] == 'service'], [])
        self.assertEqual(linux.calls('systemctl'), [])

    def test_restarts_a_running_poise_link_after_updating_it(self):
        linux = Installer(self, 'Linux')
        linux.standin('espanso', ESPANSO)
        (linux.home / '.config/espanso/match').mkdir(parents=True)
        linux.running('espanso')
        link = linux.running('poise-link')
        result = linux.run(DISPLAY=':0')
        self.assert_ok(result)
        self.assertFalse(alive(link))
        self.assertEqual(linux.background_calls('setsid'), [['setsid', 'poise-link']])
        names = linux.names()
        self.assertLess(names.index('apt-get'), names.index('setsid'))

    def test_without_a_systemd_user_session_it_says_how_to_start_espanso(self):
        linux = Installer(self, 'Linux')
        linux.set('systemd-user-exit', '1\n')
        result = linux.run(**self.desktop('x11'))
        self.assert_ok(result)
        self.assertIn('espanso service register && espanso start', result.stderr)
        self.assertEqual([call for call in linux.calls('espanso') if call[1] == 'service'], [])
        self.assertEqual(linux.calls('systemctl'), [['systemctl', '--user', 'show-environment']])
        self.assertNotIn('Waiting for the setup', result.stdout, 'nothing started Espanso, so nothing waits for it')
        self.assertIn('setup has not finished yet', result.stdout)

    def test_downloads_with_wget_when_curl_is_missing(self):
        linux = Installer(self, 'Linux')
        linux.remove('curl')
        linux.standin('wget', WGET)
        result = linux.run(**self.desktop('x11'), POISE_LINK_ESPANSO_WAIT='0')
        self.assert_ok(result)
        fetched = [call[-1].rsplit('/', 1)[-1] for call in linux.calls('wget')]
        self.assertEqual(fetched, ['SHA256SUMS', POISE_PACKAGE, ESPANSO_X11])

    def test_an_unknown_session_stops_before_any_change(self):
        linux = Installer(self, 'Linux')
        result = linux.run()
        self.assert_refused(result, 'POISE_LINK_SESSION=x11')
        self.assertEqual(linux.system_changes(), [])

    def test_an_unknown_session_name_is_refused(self):
        linux = Installer(self, 'Linux')
        result = linux.run(POISE_LINK_SESSION='mir')
        self.assert_refused(result, 'POISE_LINK_SESSION must be x11 or wayland')

    def test_a_distribution_without_apt_stops_before_any_change(self):
        linux = Installer(self, 'Linux')
        linux.remove('apt-get')
        result = linux.run(**self.desktop('x11'))
        self.assert_refused(result, 'covers Debian and Ubuntu')
        self.assertEqual(linux.system_changes(), [])

    def test_a_computer_other_than_x86_64_stops_before_any_change(self):
        linux = Installer(self, 'Linux', machine='aarch64')
        result = linux.run(**self.desktop('x11'))
        self.assert_refused(result, 'this computer is aarch64')
        self.assertEqual(linux.system_changes(), [])

    def test_an_espanso_package_that_fails_its_pinned_checksum_changes_nothing(self):
        linux = Installer(self, 'Linux')
        linux.write_script(espanso_sums={'ESPANSO_X11_SHA256': 'a' * 64})
        result = linux.run(**self.desktop('x11'))
        self.assert_refused(result, f'{ESPANSO_X11} does not match its SHA-256 checksum')
        self.assertEqual(linux.system_changes(), [])
        self.assert_cleaned_up(linux)

    def test_apt_failing_names_the_releases_espanso_needs(self):
        linux = Installer(self, 'Linux')
        linux.set('apt-install-fails')
        result = linux.run(**self.desktop('x11'))
        self.assert_refused(result, 'need Debian 12 or Ubuntu 24.04 or newer')
        self.assertEqual(linux.calls('setsid'), [])

    def test_a_failed_apt_update_still_installs(self):
        linux = Installer(self, 'Linux')
        linux.set('apt-update-exit', '100\n')
        result = linux.run(**self.desktop('x11'), POISE_LINK_ESPANSO_WAIT='0')
        self.assert_ok(result)
        self.assertIn('apt-get update failed', result.stderr)
        self.assertEqual(len([call for call in linux.calls('apt-get') if call[1] == 'install']), 1)


class LintTest(unittest.TestCase):
    @unittest.skipUnless(shutil.which('shellcheck'), 'shellcheck is not installed')
    def test_passes_shellcheck(self):
        result = subprocess.run(['shellcheck', str(SCRIPT)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


class AnySystemTest(InstallerTest):
    def test_refuses_to_run_as_root(self):
        linux = Installer(self, 'Linux')
        linux.set('uid', '0\n')
        result = linux.run(**{'XDG_SESSION_TYPE': 'x11'})
        self.assert_refused(result, 'not as root or with sudo')
        self.assertEqual([name for name in linux.names() if name != 'id'], [])

    def test_refuses_other_systems(self):
        other = Installer(self, 'FreeBSD')
        result = other.run()
        self.assert_refused(result, 'covers macOS and Linux')
        self.assertEqual(other.system_changes(), [])

    def test_refuses_a_wait_that_is_not_a_number(self):
        mac = Installer(self, 'Darwin')
        result = mac.run(POISE_LINK_ESPANSO_WAIT='soon')
        self.assert_refused(result, 'POISE_LINK_ESPANSO_WAIT must be a whole number')

    def test_a_partly_downloaded_script_does_nothing(self):
        mac = Installer(self, 'Darwin')
        mac.set('espanso-setup-finishes')
        text = mac.script.read_text()
        last_line = text.rstrip('\n').rsplit('\n', 1)[1]
        self.assertEqual(last_line, 'main "$@"')
        for cut in (len(text) // 4, len(text) // 2, len(text) * 3 // 4, len(text) - len('main "$@"\n')):
            partial = mac.root / f'partial-{cut}.sh'
            partial.write_text(text[:cut])
            mac.run(partial)
            self.assertEqual(mac.calls(), [], f'a script cut at byte {cut} ran something')


if __name__ == '__main__':
    unittest.main()
