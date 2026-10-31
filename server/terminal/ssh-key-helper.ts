// The SSH key import Poise runs in a terminal with `python3 -I -c
// SSH_KEY_HELPER`. It is held here as text rather than as a .py file beside
// the bundle: the workspace image ships dist/ and scripts/, not server/, so a
// separate file would be missing exactly where the terminal is needed (as
// helper.ts). The program documents its own protocol at the top.

export const SSH_KEY_HELPER = String.raw`# Poise's SSH key import: pastes one private key into ~/.ssh with the
# permissions ssh requires, and derives its public key. Standard library only.
#
#   python3 -I -c <this program>
#
# It asks for a file name (default id_ed25519), then reads the pasted private
# key with echo off until end-of-file (Ctrl-D). The key is written with 0600
# to a file that must not exist, ~/.ssh is created and kept at 0700, and
# ssh-keygen -y derives <name>.pub; without ssh-keygen the private key is
# kept and the public one is left for later. The key never leaves this
# terminal: nothing is sent, logged or stored anywhere else.
#
# Exit 0 saved the key; any other exit saved nothing, except when ssh-keygen
# is missing (said so). An existing file, private or public, is never
# overwritten.

import base64
import hashlib
import os
import re
import subprocess
import sys
import termios

NAME = re.compile(r'[A-Za-z0-9._-]{1,64}')
RESERVED = {'config', 'known_hosts', 'known_hosts.old', 'authorized_keys', 'environment', 'rc'}
MAX_KEY_BYTES = 65536


def fail(message):
    sys.stdout.write('Error: ' + message + '\n')
    return 1


def main():
    ssh_dir = os.path.join(os.path.expanduser('~'), '.ssh')
    try:
        sys.stdout.write('Key name [id_ed25519]: ')
        sys.stdout.flush()
        name = sys.stdin.readline()
    except KeyboardInterrupt:
        sys.stdout.write('\nCancelled; nothing was saved.\n')
        return 1
    if not name:
        sys.stdout.write('\nCancelled; nothing was saved.\n')
        return 1
    name = name.strip() or 'id_ed25519'
    if not NAME.fullmatch(name) or name.startswith('.') or name.endswith('.pub') or name in RESERVED:
        return fail('use a file name like id_ed25519 (letters, digits, dot, _ and -, no .pub).')
    target = os.path.join(ssh_dir, name)
    if os.path.lexists(target):
        return fail('~/.ssh/' + name + ' already exists; remove it in a shell first. Nothing was saved.')
    pub_target = target + '.pub'
    if os.path.lexists(pub_target):
        return fail('~/.ssh/' + name + '.pub already exists; remove it in a shell first. Nothing was saved.')
    sys.stdout.write('Paste the private key, then press Ctrl-D. Nothing shows while you paste.\n')
    sys.stdout.flush()
    try:
        fd = sys.stdin.fileno()
        saved = termios.tcgetattr(fd)
        quiet = termios.tcgetattr(fd)
        quiet[3] &= ~termios.ECHO
        termios.tcsetattr(fd, termios.TCSADRAIN, quiet)
    except Exception:
        saved = None
    try:
        try:
            pasted = sys.stdin.read(MAX_KEY_BYTES + 1)
        except KeyboardInterrupt:
            pasted = None
    finally:
        if saved is not None:
            termios.tcsetattr(fd, termios.TCSADRAIN, saved)
    sys.stdout.write('\n')
    if pasted is None:
        return fail('cancelled; nothing was saved.')
    if not pasted.strip():
        return fail('no key was pasted; nothing was saved.')
    if len(pasted) > MAX_KEY_BYTES:
        return fail('the pasted text is larger than 64 KiB; nothing was saved.')
    text = pasted.strip()
    lines = text.split('\n')
    if not (lines[0].startswith('-----BEGIN ') and lines[0].rstrip().endswith('PRIVATE KEY-----')):
        return fail('that is not a private key: its first line is not a private-key header. Nothing was saved.')
    if not (lines[-1].startswith('-----END ') and lines[-1].rstrip().endswith('PRIVATE KEY-----')):
        return fail('the key is incomplete: its last line is not a private-key footer. Nothing was saved.')
    if len(lines) < 3:
        return fail('the key has no body; nothing was saved.')
    try:
        os.mkdir(ssh_dir, 0o700)
    except FileExistsError:
        pass
    except OSError as error:
        return fail('~/.ssh could not be created: ' + str(error) + '. Nothing was saved.')
    try:
        os.chmod(ssh_dir, 0o700)
    except OSError as error:
        return fail('~/.ssh could not be secured: ' + str(error) + '. Nothing was saved.')
    try:
        private = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return fail('~/.ssh/' + name + ' already exists; remove it in a shell first. Nothing was saved.')
    except OSError as error:
        return fail('~/.ssh/' + name + ' could not be written: ' + str(error) + '. Nothing was saved.')
    try:
        os.write(private, (text + '\n').encode('utf-8'))
    finally:
        os.close(private)
    try:
        derived = subprocess.run(['ssh-keygen', '-y', '-f', target], capture_output=True, text=True)
    except FileNotFoundError:
        sys.stdout.write('Saved ~/.ssh/' + name + ' (0600), but ssh-keygen was not found: derive ' +
                         '~/.ssh/' + name + '.pub in a shell with ssh-keygen -y -f ~/.ssh/' + name + '.\n')
        return 0
    if derived.returncode != 0:
        os.unlink(target)
        detail = (derived.stderr or '').strip().split('\n')[0][:160]
        return fail('ssh-keygen refused the key' + (': ' + detail if detail else '') + '; nothing was saved.')
    public = derived.stdout.strip() + '\n'
    try:
        pub = os.open(pub_target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    except FileExistsError:
        os.unlink(target)
        return fail('~/.ssh/' + name + '.pub already exists; nothing was saved.')
    except OSError as error:
        os.unlink(target)
        return fail('~/.ssh/' + name + '.pub could not be written: ' + str(error) + '. Nothing was saved.')
    try:
        os.write(pub, public.encode('utf-8'))
    finally:
        os.close(pub)
    fingerprint = ''
    try:
        blob = base64.b64decode(public.split()[1])
        fingerprint = 'SHA256:' + base64.b64encode(hashlib.sha256(blob).digest()).decode('ascii').rstrip('=')
    except Exception:
        pass
    sys.stdout.write('Saved ~/.ssh/' + name + ' (0600) and ~/.ssh/' + name + '.pub.\n')
    if fingerprint:
        sys.stdout.write('SHA256 fingerprint: ' + fingerprint + '\n')
    return 0


sys.exit(main())
`
