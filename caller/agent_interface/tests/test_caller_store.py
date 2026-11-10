"""Metadata reader boundaries with a controller-reader stand-in and real files."""
import json
import os
import sqlite3
import subprocess
import sys
from contextlib import closing

import pytest

from agent_interface import caller_store, native_namespace


@pytest.fixture
def store(tmp_path, monkeypatch):
    root = tmp_path / 'original'
    root.mkdir()
    (root / 'responses').mkdir()
    with sqlite3.connect(root / 'calls.sqlite3') as db:
        db.execute('create table original(value text)')
        db.execute('insert into original values(?)', ('retained original',))
    flags = os.O_RDONLY | os.O_DIRECTORY
    directory = os.open(root, flags)
    responses = os.open(root / 'responses', flags)
    identity = lambda path: {'device': str(path.stat().st_dev), 'inode': str(path.stat().st_ino)}
    reference = {'path': str(root), 'pid': os.getpid(), 'directoryFd': directory, 'responsesFd': responses,
                 'directory': identity(root), 'database': identity(root / 'calls.sqlite3'), 'responses': identity(root / 'responses')}
    address = {'version': 1, 'instance': 'a' * 32, 'path': '/test-only-controller', 'store': reference}
    monkeypatch.setenv('POISE_NATIVE_CONTROL', json.dumps(address))
    monkeypatch.setattr(caller_store, '_reference', None)
    monkeypatch.setattr(caller_store, '_descriptors', None)
    monkeypatch.setattr(native_namespace, 'control_address', lambda: address)
    monkeypatch.setattr(native_namespace, 'control_request', lambda *args: {'resourceProtocol': 2, 'store': reference})
    try:
        yield root, reference
    finally:
        caller_store._close()
        os.close(directory)
        os.close(responses)


@pytest.mark.skipif(sys.platform != 'linux', reason='original directory handles require Linux procfs')
def test_same_numbered_pid_descriptor_cannot_substitute_foreign_metadata(store, tmp_path, monkeypatch):
    root, reference = store
    foreign = tmp_path / 'foreign'
    foreign.mkdir()
    sentinel = foreign / 'user-auth-evidence'
    sentinel.write_text('protected')
    real_open = os.open
    aliases = {f"/proc/{reference['pid']}/fd/{reference[key]}" for key in ('directoryFd', 'responsesFd')}

    def collision(path, flags, *args, **kwargs):
        return real_open(foreign if str(path) in aliases else path, flags, *args, **kwargs)

    monkeypatch.setattr(os, 'open', collision)
    with caller_store.connect(root / 'calls.sqlite3') as db:
        assert db.execute('select value from original').fetchone()[0] == 'retained original'
    assert list(foreign.iterdir()) == [sentinel] and sentinel.read_text() == 'protected'


def test_stale_or_missing_controller_metadata_refuses_before_opening_the_database(store, monkeypatch):
    root, reference = store
    monkeypatch.setattr(native_namespace, 'control_request', lambda *args: {'resourceProtocol': 2, 'store': {**reference, 'pid': 0}})
    with pytest.raises(RuntimeError, match='original live controller handles'):
        caller_store.connect(root / 'calls.sqlite3')
    assert caller_store._descriptors is None


@pytest.mark.skipif(sys.platform != 'linux', reason='original directory handles require Linux procfs')
def test_response_directory_identity_and_database_inode_stay_bound_to_the_original(store):
    root, _ = store
    with caller_store.connect(root / 'calls.sqlite3') as db:
        assert db.execute('select value from original').fetchone()[0] == 'retained original'
    (root / 'calls.sqlite3').rename(root / 'retained.sqlite3')
    (root / 'calls.sqlite3').write_text('foreign database sentinel')
    with pytest.raises(RuntimeError, match='differs from its original'):
        caller_store.connect(root / 'calls.sqlite3')
    assert (root / 'calls.sqlite3').read_text() == 'foreign database sentinel'


@pytest.mark.skipif(sys.platform != 'linux', reason='original directory handles require Linux procfs')
def test_managed_connections_preserve_an_existing_sqlite_lock(store):
    root, _ = store
    path = root / 'calls.sqlite3'

    def try_external_transaction():
        script = "import sqlite3, sys; sqlite3.connect(sys.argv[1], timeout=0).execute('begin exclusive')"
        return subprocess.run([sys.executable, '-c', script, str(path)], capture_output=True, text=True, check=False)

    with closing(caller_store.connect(path)) as first:
        first.execute('begin exclusive')
        blocked = try_external_transaction()
        assert blocked.returncode != 0 and 'database is locked' in blocked.stderr
        with closing(caller_store.connect(path)):
            blocked = try_external_transaction()
            assert blocked.returncode != 0 and 'database is locked' in blocked.stderr
        first.rollback()
    available = try_external_transaction()
    assert available.returncode == 0, available.stderr


@pytest.mark.skipif(sys.platform != 'linux', reason='original directory handles require Linux procfs')
def test_managed_database_refuses_a_symlink_even_to_the_original_inode(store):
    root, _ = store
    path = root / 'calls.sqlite3'
    retained = root / 'retained.sqlite3'
    path.rename(retained)
    path.symlink_to(retained)

    with pytest.raises(RuntimeError, match='differs from its original'):
        caller_store.connect(path)
