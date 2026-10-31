// The pseudo-terminal helper Poise starts with `python3 -I -c PTY_HELPER`.
// It is held here as text rather than as a .py file beside the bundle: the
// workspace image ships dist/ and scripts/, not server/, so a separate file
// would be missing exactly where the terminal is needed. The program documents
// its own protocol at the top.

export const PTY_HELPER = String.raw`# Poise's pseudo-terminal helper: runs one program on a new pseudo-terminal
# and relays it over plain pipes to Poise's Node server, which therefore needs
# no native module. Standard library only.
#
#   python3 -I -c <this program> <cols> <rows> <program> [argument ...]
#
#   fd 0  input: bytes for the terminal, written to it unchanged
#   fd 1  output: everything the terminal shows, unchanged
#   fd 2  the helper's own diagnostics, one line each
#   fd 3  control: ASCII lines, each "resize <cols> <rows>"
#
# The program starts at <cols> x <rows> in a new session whose controlling
# terminal is the new one, so the terminal's own keys (Ctrl-C, Ctrl-Z) reach
# it. When it exits, the helper relays the rest of its output and exits with
# its status: its exit code, or 128 + the number of the signal that ended it.
# When fd 0 closes, or the helper gets SIGTERM or SIGHUP, it hangs up the
# program's process group (SIGHUP, then SIGKILL a second later) and exits.
# A program that cannot start says why on the terminal and exits 127.

import errno
import fcntl
import os
import select
import signal
import struct
import sys
import termios
import time

CONTROL = 3
CHUNK = 65536
MAX_PENDING = 1 << 20
HANGUP_GRACE = 1.0
DRAIN = 0.5


class HangUp(Exception):
    pass


def say(message):
    os.write(2, ("poise-pty: " + message + "\n").encode("utf-8", "replace"))


def dimension(value):
    number = int(value)
    if not 1 <= number <= 1000:
        raise ValueError(value)
    return number


def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def write_all(fd, data):
    view = memoryview(data)
    while view:
        try:
            view = view[os.write(fd, view):]
        except BlockingIOError:
            select.select([], [fd], [])


def exit_code(status):
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return os.WEXITSTATUS(status)


def start(argv, cols, rows):
    # The forked child: fds 0 to 2 are already the new terminal.
    try:
        set_size(0, cols, rows)
        os.close(CONTROL)
        # Python ignores these two; the program starts with the defaults.
        signal.signal(signal.SIGPIPE, signal.SIG_DFL)
        signal.signal(signal.SIGXFSZ, signal.SIG_DFL)
        os.execvp(argv[0], argv)
    except Exception as error:
        say("cannot run %s: %s" % (argv[0], getattr(error, "strerror", None) or error))
    os._exit(127)


def signal_group(pgid, number):
    try:
        os.killpg(pgid, number)
    except (ProcessLookupError, PermissionError):
        # Nothing of the group is left that the helper may signal (macOS
        # answers EPERM for a group of zombies). Closing the terminal when
        # the helper exits hangs up anything still attached to it.
        pass


def wait(pid, seconds):
    deadline = time.monotonic() + seconds
    while True:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            return status
        if time.monotonic() >= deadline:
            return None
        time.sleep(0.02)


def hang_up(pid):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    signal_group(pid, signal.SIGHUP)
    status = wait(pid, HANGUP_GRACE)
    signal_group(pid, signal.SIGKILL)
    if status is None:
        status = os.waitpid(pid, 0)[1]
    return exit_code(status)


def raise_hang_up(number, frame):
    raise HangUp()


def control(master, line):
    words = line.split()
    if len(words) != 3 or words[0] != b"resize":
        raise ValueError("unknown control line %r" % line)
    set_size(master, dimension(words[1]), dimension(words[2]))


def relay(pid, master):
    pending = bytearray()
    commands = b""
    reading_control = True
    status = None
    drain_until = 0.0
    while True:
        if status is None:
            done, raw = os.waitpid(pid, os.WNOHANG)
            if done:
                status = raw
                drain_until = time.monotonic() + DRAIN
        readers = [master]
        if len(pending) < MAX_PENDING:
            readers.append(0)
        if reading_control:
            readers.append(CONTROL)
        writers = [master] if pending else []
        ready, writable, _ = select.select(readers, writers, [], 0.25 if status is None else 0.05)
        if master in writable:
            try:
                del pending[:os.write(master, pending)]
            except BlockingIOError:
                pass
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                pending.clear()  # nothing reads the terminal any more
        if master in ready:
            try:
                data = os.read(master, CHUNK)
            except BlockingIOError:
                data = None
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b""
            if data == b"":
                # Every process has let go of the terminal: the program has
                # exited, or is about to.
                if status is None:
                    status = wait(pid, DRAIN)
                return exit_code(status) if status is not None else hang_up(pid)
            if data:
                write_all(1, data)
        elif status is not None and (not ready or time.monotonic() >= drain_until):
            return exit_code(status)
        if 0 in ready:
            data = os.read(0, CHUNK)
            if not data:
                raise HangUp()
            pending += data
        if CONTROL in ready:
            data = os.read(CONTROL, 4096)
            if not data:
                reading_control = False
            commands += data
            while b"\n" in commands:
                line, _, commands = commands.partition(b"\n")
                control(master, line)


def main():
    if len(sys.argv) < 4:
        say("usage: python3 -I -c <helper> <cols> <rows> <program> [argument ...]")
        return 2
    try:
        cols, rows = dimension(sys.argv[1]), dimension(sys.argv[2])
    except ValueError:
        say("cols and rows must be whole numbers from 1 to 1000")
        return 2
    try:
        os.fstat(CONTROL)
    except OSError:
        say("fd 3 must be open for control lines")
        return 2
    pid, master = os.forkpty()
    if pid == 0:
        start(sys.argv[3:], cols, rows)
    signal.signal(signal.SIGTERM, raise_hang_up)
    signal.signal(signal.SIGHUP, raise_hang_up)
    for fd in (0, 1, CONTROL):
        os.set_blocking(fd, True)
    os.set_blocking(master, False)
    try:
        return relay(pid, master)
    except (HangUp, BrokenPipeError):
        return hang_up(pid)
    except ValueError as error:
        say(str(error))
        hang_up(pid)
        return 2


sys.exit(main())
`
