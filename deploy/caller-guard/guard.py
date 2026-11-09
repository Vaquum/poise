"""Host-kernel advisory SQLite fence for Docker's managed gVisor workspaces.

Never use SQLite here: even a read-only connection can modify guest WAL state.
"""

import argparse
import fcntl
import json
import logging
import os
from pathlib import Path
import socket
import stat
import struct
import subprocess
import sys

LOG = logging.getLogger("poise-caller-guard")
START = 0x40000000
LENGTH = 512  # SQLite's pending byte, reserved byte and shared lock range.
SOCKET = "/run/poise-caller-guard/control.sock"
FLOCK = "hhqqi4x"  # struct flock on the supported 64-bit Linux host.


def docker(*arguments):
    return subprocess.check_output(["docker", *arguments], text=True, stderr=subprocess.PIPE, timeout=15).strip()


def inventory():
    runtimes = json.loads(docker("info", "--format", "{{json .Runtimes}}"))
    ids = docker("ps", "--all", "--quiet", "--filter", "label=poise.managed=true").split()
    containers = json.loads(docker("inspect", *ids)) if ids else []
    return runtimes, containers


def gvisor(runtime, runtimes):
    definition = runtimes.get(runtime, {})
    return (runtime == "runsc" or Path(definition.get("path", "")).name == "runsc"
            or definition.get("runtimeType") == "io.containerd.runsc.v1")


def homes(containers, runtimes):
    result = set()
    for container in containers:
        if not container["State"]["Running"] or not gvisor(container["HostConfig"]["Runtime"], runtimes):
            continue
        mounts = [mount for mount in container["Mounts"] if mount["Destination"] == "/home/poise"]
        if len(mounts) != 1 or mounts[0]["Type"] != "volume":
            raise RuntimeError(f'{container["Name"]}: Caller guard requires the workspace home volume')
        result.add(mounts[0]["Source"])
    return result


def stores(path, parent=None):
    # fwalk can open and close a file raced into a directory name. O_DIRECTORY
    # prevents that from releasing a previously held database's POSIX locks.
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    try:
        with os.scandir(fd) as entries:
            for entry in entries:
                if entry.name == "calls.sqlite3":
                    yield fd, str(path)
                elif entry.is_dir(follow_symlinks=False):
                    for directory_fd, relative in stores(entry.name, fd):
                        yield directory_fd, str(Path(path) / relative)
    finally:
        os.close(fd)


def verify(snapshot):
    """Run outside the holder: F_GETLK ignores the querying process's locks."""
    pid = snapshot["pid"]
    for entry in snapshot["locks"]:
        fd = os.open(f'/proc/{pid}/fd/{entry["fd"]}', os.O_RDONLY)
        try:
            node = os.fstat(fd)
            if not stat.S_ISREG(node.st_mode) or [node.st_dev, node.st_ino] != entry["identity"]:
                raise RuntimeError("Caller guard's original inode is unavailable")
            answer = fcntl.fcntl(fd, fcntl.F_GETLK, struct.pack(FLOCK, fcntl.F_RDLCK, os.SEEK_SET, START, LENGTH, 0))
            kind, _, start, length, owner = struct.unpack(FLOCK, answer)
            if kind != fcntl.F_WRLCK or owner != pid or start > START or (length and start + length < START + LENGTH):
                raise RuntimeError(f'Caller host lock lost on device/inode {entry["identity"]}')
        finally:
            os.close(fd)


class Guard:
    def __init__(self):
        self.locks = {}

    def snapshot(self):
        return {"pid": os.getpid(), "locks": [
            {"fd": entry["fds"][0], "identity": list(identity)} for identity, entry in self.locks.items() if entry["acquired"]
        ]}

    def scan(self):
        # Do not let a surviving PID or a new acquisition conceal lock loss.
        if self.locks:
            subprocess.run([sys.executable, __file__, "--probe"], input=json.dumps(self.snapshot()),
                           text=True, check=True, timeout=10, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        runtimes, containers = inventory()
        active = homes(containers, runtimes)
        for identity, entry in list(self.locks.items()):
            entry["homes"].intersection_update(active)
            if not entry["homes"]:
                for fd in entry["fds"]:
                    os.close(fd)
                del self.locks[identity]
                LOG.info("Released host lock on %s: no gVisor workspace uses its home", identity)

        # A failed acquisition stays retained under its original inode, even
        # after its pathname is renamed away. Retry it before discovering
        # replacements: otherwise a rescan could report protection while the
        # original remains unlocked.
        for identity, entry in list(self.locks.items()):
            if not entry["acquired"]:
                try:
                    fcntl.lockf(entry["fds"][0], fcntl.LOCK_EX | fcntl.LOCK_NB, LENGTH, START, os.SEEK_SET)
                except OSError as error:
                    raise RuntimeError(f"Cannot acquire host lock on retained Caller inode {identity}: {error}") from error
                entry["acquired"] = True
                LOG.info("Acquired host lock on retained Caller inode %s", identity)

        for home in active:
            found = False
            # A restarted guard must also find Caller's retained directory after
            # ancestor renames, without following directory symlinks.
            for directory_fd, directory in stores(home):
                found = True
                node = os.stat("calls.sqlite3", dir_fd=directory_fd, follow_symlinks=False)
                if not stat.S_ISREG(node.st_mode):
                    raise RuntimeError(f"{directory}/calls.sqlite3 is not a regular Caller store")
                identity = (node.st_dev, node.st_ino)
                if identity not in self.locks:
                    fd = os.open("calls.sqlite3", os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
                    node = os.fstat(fd)
                    identity = (node.st_dev, node.st_ino)
                    # Even an alias raced into this open must remain open:
                    # closing ANY descriptor for an inode drops its POSIX locks.
                    entry = self.locks.setdefault(identity, {"fds": [], "homes": set(), "acquired": False})
                    entry["fds"].append(fd)
                    entry["homes"].add(home)
                    if not stat.S_ISREG(node.st_mode):
                        raise RuntimeError(f"{directory}/calls.sqlite3 changed type")
                entry = self.locks[identity]
                if not entry["acquired"]:
                    try:
                        fcntl.lockf(entry["fds"][0], fcntl.LOCK_EX | fcntl.LOCK_NB, LENGTH, START, os.SEEK_SET)
                    except OSError as error:
                        raise RuntimeError(f"Cannot acquire host lock on {directory}/calls.sqlite3 device/inode {identity}: {error}") from error
                    entry["acquired"] = True
                    LOG.info("Acquired host lock on %s/calls.sqlite3 device/inode %s", directory, identity)
                entry["homes"].add(home)
            if not found:
                raise RuntimeError(f"{home}: waiting for the first Caller store; protection is not established")
        return self.snapshot()


def check(path):
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(60)
        connection.connect(path)
        connection.sendall(b"check\n")
        with connection.makefile("r") as stream:
            answer = json.loads(stream.readline())
    if "error" in answer:
        raise RuntimeError(answer["error"])
    verify(answer)
    return answer


def notify(message):
    address = os.environ.get("NOTIFY_SOCKET")
    if address:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as connection:
            connection.connect("\0" + address[1:] if address.startswith("@") else address)
            connection.sendall(f"STATUS={message}".encode())


def serve(path):
    guard = Guard()
    previous = None
    # systemd owns the private runtime directory and removes stale sockets.
    with socket.socket(socket.AF_UNIX) as server:
        server.bind(path)
        os.chmod(path, 0o600)
        server.listen(4)
        server.settimeout(5)
        while True:
            try:
                connection, _ = server.accept()
            except TimeoutError:
                connection = None
            try:
                answer = guard.scan()
                # Every report, including periodic status, proves the locks in
                # another host process, without opening SQLite or its sidecars.
                subprocess.run([sys.executable, __file__, "--probe"], input=json.dumps(answer),
                               text=True, check=True, timeout=10, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                status = f'Host locks verified on {len(answer["locks"])} Caller inode(s)'
            except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as error:
                detail = error.stderr.strip() if isinstance(error, subprocess.CalledProcessError) and error.stderr else str(error)
                status = f"Caller host protection unavailable: {detail}"
                answer = {"error": status}
            if status != previous:
                (LOG.error if "error" in answer else LOG.info)(status)
                notify(status)
                previous = status
            if connection is None:
                continue
            with connection:
                connection.settimeout(5)
                try:
                    connection.recv(16)
                    connection.sendall((json.dumps(answer) + "\n").encode())
                except (BrokenPipeError, TimeoutError) as error:
                    LOG.warning("Caller guard check disconnected: %s", error)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", default=SOCKET)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--needed", action="store_true")
    parser.add_argument("--runtime", default="")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(name)s: %(levelname)s: %(message)s")
    if args.needed:
        runtimes, containers = inventory()
        return 0 if gvisor(args.runtime, runtimes) or any(gvisor(c["HostConfig"]["Runtime"], runtimes) for c in containers) else 10
    if args.probe:
        verify(json.load(sys.stdin))
    elif args.check:
        snapshot = check(args.socket)
        LOG.info("Verified host locks on %s Caller inode(s)", len(snapshot["locks"]))
    else:
        serve(args.socket)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as failure:
        LOG.error("%s", failure)
        sys.exit(1)
