"""Tests deploy/volume-archive.py, which deploy/backup.sh runs on each volume.

    python3 -m unittest discover --start-directory deploy/ci --pattern 'test_*.py'
"""

import os
import shutil
import socket
import sqlite3
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest

ARCHIVER = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'volume-archive.py')
OWNER = f'{os.getuid()}:{os.getgid()}'

# Commits pairs of rows, one pair per transaction, until it is killed.
PAIR_WRITER = """
import sqlite3, sys
db = sqlite3.connect(sys.argv[1], isolation_level=None)
db.execute('PRAGMA journal_mode=WAL')
db.execute('CREATE TABLE IF NOT EXISTS pairs (n INTEGER)')
print('ready', flush=True)
n = 0
while True:
    db.execute('BEGIN')
    db.execute('INSERT INTO pairs VALUES (?)', (n,))
    db.execute('INSERT INTO pairs VALUES (?)', (n,))
    db.execute('COMMIT')
    n += 1
"""


def run_archiver(volume, archive):
    return subprocess.run([sys.executable, ARCHIVER, volume, archive, OWNER], capture_output=True, text=True, check=True)


def extract(archive, into):
    with tarfile.open(archive) as tar:
        tar.extractall(into, filter='fully_trusted')
        return tar.getnames()


class VolumeArchiveTest(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.volume = os.path.join(self.work.name, 'volume')
        self.out = os.path.join(self.work.name, 'out')
        os.mkdir(self.volume, 0o750)
        os.mkdir(self.out)
        self.archive = os.path.join(self.work.name, 'volume.tar.gz')

    def test_takes_commits_still_in_the_wal_that_a_file_copy_would_miss(self):
        path = os.path.join(self.volume, 'live.db')
        writer = sqlite3.connect(path, isolation_level=None)
        self.addCleanup(writer.close)
        writer.execute('PRAGMA journal_mode=WAL')
        writer.execute('PRAGMA wal_autocheckpoint=0')
        writer.execute('CREATE TABLE notes (body TEXT)')
        writer.executemany('INSERT INTO notes VALUES (?)', [(f'note {n}',) for n in range(50)])
        self.assertGreater(os.path.getsize(path + '-wal'), 0)
        file_copy = os.path.join(self.work.name, 'copy.db')
        shutil.copyfile(path, file_copy)
        copied = sqlite3.connect(f'file:{file_copy}?mode=ro', uri=True)
        self.assertRaises(sqlite3.OperationalError, copied.execute, 'SELECT count(*) FROM notes')
        copied.close()

        run_archiver(self.volume, self.archive)
        names = extract(self.archive, self.out)

        self.assertIn('live.db', names)
        self.assertNotIn('live.db-wal', names)
        self.assertNotIn('live.db-shm', names)
        restored = sqlite3.connect(os.path.join(self.out, 'live.db'))
        self.addCleanup(restored.close)
        self.assertEqual(restored.execute('SELECT count(*) FROM notes').fetchone(), (50,))
        self.assertGreater(os.path.getsize(path + '-wal'), 0, 'the live database was checkpointed')

    def test_snapshots_a_database_that_is_written_while_it_is_archived(self):
        path = os.path.join(self.volume, 'busy.db')
        writer = subprocess.Popen([sys.executable, '-c', PAIR_WRITER, path], stdout=subprocess.PIPE, text=True)
        self.addCleanup(writer.stdout.close)
        self.addCleanup(writer.wait)
        self.addCleanup(writer.kill)
        self.assertEqual(writer.stdout.readline().strip(), 'ready')
        time.sleep(0.5)

        run_archiver(self.volume, self.archive)
        extract(self.archive, self.out)

        restored = sqlite3.connect(os.path.join(self.out, 'busy.db'))
        self.addCleanup(restored.close)
        self.assertEqual(restored.execute('PRAGMA integrity_check').fetchone(), ('ok',))
        (rows,) = restored.execute('SELECT count(*) FROM pairs').fetchone()
        self.assertGreater(rows, 0)
        self.assertEqual(rows % 2, 0, 'the snapshot caught a transaction half done')
        unpaired = restored.execute('SELECT n FROM pairs GROUP BY n HAVING count(*) != 2').fetchall()
        self.assertEqual(unpaired, [])

    def test_keeps_everything_else_as_it_is(self):
        os.chmod(self.volume, 0o750)
        os.makedirs(os.path.join(self.volume, '.poise', 'logs'))
        secret = os.path.join(self.volume, '.poise', 'token')
        with open(secret, 'w') as file:
            file.write('credential')
        os.chmod(secret, 0o600)
        os.utime(secret, (1_700_000_000, 1_700_000_000))
        script = os.path.join(self.volume, 'run.sh')
        with open(script, 'w') as file:
            file.write('#!/bin/sh\n')
        os.chmod(script, 0o755)
        os.symlink('/home/poise/.local/share/tool', os.path.join(self.volume, 'tool'))
        os.link(secret, os.path.join(self.volume, '.poise', 'token-link'))
        os.mkfifo(os.path.join(self.volume, 'pipe'))
        listener = socket.socket(socket.AF_UNIX)
        self.addCleanup(listener.close)
        here = os.getcwd()
        os.chdir(self.volume)  # A socket's path has a short length limit; a relative one fits.
        try:
            listener.bind('agent.sock')
        finally:
            os.chdir(here)
        with open(os.path.join(self.volume, 'stale.db-wal'), 'wb') as file:
            file.write(b'not a companion of any database')

        run_archiver(self.volume, self.archive)
        self.assertEqual(stat.S_IMODE(os.stat(self.archive).st_mode), 0o600)
        with tarfile.open(self.archive) as tar:
            members = {member.name: member for member in tar.getmembers()}

        self.assertEqual(members['.'].mode, 0o750)
        self.assertTrue(members['.'].isdir())
        self.assertEqual(members['.poise/token'].mode, 0o600)
        self.assertEqual(members['.poise/token'].mtime, 1_700_000_000)
        self.assertEqual(members['.poise/token'].uid, os.getuid())
        self.assertEqual(members['run.sh'].mode, 0o755)
        self.assertTrue(members['tool'].issym())
        self.assertEqual(members['tool'].linkname, '/home/poise/.local/share/tool')
        self.assertTrue(members['.poise/token-link'].islnk())
        self.assertEqual(members['.poise/token-link'].linkname, '.poise/token')
        self.assertTrue(members['pipe'].isfifo())
        self.assertIn('.poise/logs', members)
        self.assertIn('stale.db-wal', members)
        self.assertNotIn('agent.sock', members)
        extract(self.archive, self.out)
        with open(os.path.join(self.out, '.poise', 'token')) as file:
            self.assertEqual(file.read(), 'credential')

    def test_archives_an_unreadable_database_as_it_is_and_says_so(self):
        path = os.path.join(self.volume, 'broken.db')
        with open(path, 'wb') as file:
            file.write(b'SQLite format 3\x00' + b'\xff' * 200)

        result = run_archiver(self.volume, self.archive)
        extract(self.archive, self.out)

        self.assertIn(f'{path}: SQLite cannot read it', result.stderr)
        with open(os.path.join(self.out, 'broken.db'), 'rb') as file:
            self.assertEqual(file.read(), b'SQLite format 3\x00' + b'\xff' * 200)

    def test_refuses_to_run_without_its_three_arguments(self):
        result = subprocess.run([sys.executable, ARCHIVER, self.volume], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('usage: volume-archive.py', result.stderr)


if __name__ == '__main__':
    unittest.main()
