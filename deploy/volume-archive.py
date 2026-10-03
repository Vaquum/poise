"""Archives one Docker volume for deploy/backup.sh, which runs this as root in
a throwaway container of the workspace image, with the volume mounted:

    python3 volume-archive.py VOLUME_DIRECTORY ARCHIVE UID:GID

Every SQLite database goes into the archive as a snapshot taken with SQLite's
online backup, which reads the database through SQLite's own locks while
Poise keeps writing to it. A copy of its files could miss commits that are
still in its -wal file, or catch a write half done. Its -wal, -shm and
-journal files stay out. Everything else goes in as it is, with owners,
modes and times, so restoring needs no more than tar. ARCHIVE, a gzipped
tar, is written readable by UID:GID only: it holds people's credentials.
"""

import os
import sqlite3
import stat
import sys
import tarfile
import tempfile
import urllib.parse

SQLITE_HEADER = b'SQLite format 3\x00'
COMPANIONS = ('-wal', '-shm', '-journal')


def note(message):
    print(f'volume-archive: {message}', file=sys.stderr)


def removed(path):
    note(f'{path}: removed while the volume was archived')


def walk(top):
    """Every path below top, top first and each directory before its contents."""
    def failed(error):
        if not isinstance(error, FileNotFoundError):
            raise error
        removed(error.filename)

    yield top
    for directory, subdirectories, files in os.walk(top, onerror=failed):
        subdirectories.sort()
        for name in sorted(subdirectories + files):
            yield os.path.join(directory, name)


def snapshot(database, copy):
    """Copies the database into copy in one online-backup step, so the copy is one consistent state."""
    source = sqlite3.connect(f'file:{urllib.parse.quote(database)}?mode=ro', uri=True, timeout=60)
    try:
        target = sqlite3.connect(copy)
        try:
            source.backup(target)
        finally:
            target.close()
    finally:
        source.close()


class Padded:
    """A file that may shrink while it is archived: what went missing reads as zeros, as with GNU tar."""

    def __init__(self, file, path):
        self.file = file
        self.path = path
        self.shrank = False

    def read(self, size):
        data = self.file.read(size)
        if len(data) < size:
            if not self.shrank:
                note(f'{self.path}: shrank while the volume was archived; its missing end is archived as zeros')
                self.shrank = True
            data += bytes(size - len(data))
        return data


def add_file(tar, path, name, staging, skipped):
    """Adds a regular file, or a consistent snapshot of it when it is a SQLite database."""
    try:
        file = open(path, 'rb')
    except FileNotFoundError:
        removed(path)
        return
    with file:
        info = tar.gettarinfo(arcname=name, fileobj=file)
        if not info.isreg():
            tar.addfile(info)  # A hard link to a file already archived.
            return
        if file.read(len(SQLITE_HEADER)) == SQLITE_HEADER:
            copy = os.path.join(staging, 'snapshot.db')
            try:
                snapshot(path, copy)
            except sqlite3.Error as error:
                note(f'{path}: SQLite cannot read it ({error}), so it is archived as it is, with its -wal and -shm files')
            else:
                skipped.update(path + suffix for suffix in COMPANIONS)
                info.size = os.path.getsize(copy)
                with open(copy, 'rb') as consistent:
                    tar.addfile(info, consistent)
                os.remove(copy)
                return
        file.seek(0)
        tar.addfile(info, Padded(file, path))


def archive(volume, output, staging):
    skipped = set()
    with tarfile.open(output, 'w:gz', compresslevel=6) as tar:
        for path in walk(volume):
            if path in skipped:
                continue
            name = os.path.relpath(path, volume)
            try:
                regular = stat.S_ISREG(os.lstat(path).st_mode)
                info = None if regular else tar.gettarinfo(path, name)
            except FileNotFoundError:
                removed(path)
                continue
            if regular:
                add_file(tar, path, name, staging, skipped)
            elif info is not None:  # None for a socket, a live endpoint rather than data.
                tar.addfile(info)


def main(arguments):
    if len(arguments) != 3:
        sys.exit('usage: volume-archive.py VOLUME_DIRECTORY ARCHIVE UID:GID')
    volume, output, owner = arguments
    uid, gid = (int(part) for part in owner.split(':'))
    os.umask(0o077)
    partial = f'{output}.partial'
    with tempfile.TemporaryDirectory() as staging:
        archive(os.path.abspath(volume), partial, staging)
    os.chown(partial, uid, gid)
    os.rename(partial, output)


if __name__ == '__main__':
    main(sys.argv[1:])
