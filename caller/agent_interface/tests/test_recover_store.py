"""The recovery guard must reject stale evidence before changing the original store."""
from contextlib import closing
import shutil
import sqlite3
import subprocess
import sys

import pytest

from agent_interface import recover_store


@pytest.fixture
def stores(tmp_path):
    original = tmp_path / "calls.sqlite3"
    candidate = tmp_path / "recovered.sqlite3"
    with closing(sqlite3.connect(original)) as database:
        database.executescript("""
            pragma journal_mode=wal;
            create table calls (id text primary key, status text, session_id text, correlation_id text, prompt text);
            create index calls_status_started on calls(status);
            create index calls_session_behavior on calls(session_id);
            create unique index calls_correlation_id_unique on calls(correlation_id) where correlation_id is not null;
            create table diagnostic_calls (seq integer primary key autoincrement, call_id text);
            create table diagnostic_stream (id integer primary key, generation text);
            create table chat_sessions (session_id text, provider_session text);
            insert into calls values ('a', 'completed', null, 'original-a', 'original');
            insert into calls values ('b', 'completed', null, 'original-b', cast(x'ff' as text));
            insert into diagnostic_calls values (7, 'b');
            insert into diagnostic_stream values (1, 'source');
            insert into chat_sessions values ('session', 'provider');
        """)
    shutil.copyfile(original, candidate)
    return original, candidate, {"source_rows": 2, "candidate_rows": 2, "unreadable_omitted": []}


def test_activation_preserves_inode_and_excludes_a_writer_at_backup(stores):
    original, candidate, manifest = stores
    identity = original.stat()
    competing_writer = """import sqlite3, sys
with sqlite3.connect(sys.argv[1], timeout=0) as database:
    try:
        database.execute("begin immediate")
    except sqlite3.OperationalError as error:
        assert error.sqlite_errorcode == sqlite3.SQLITE_BUSY
    else:
        raise SystemExit("competing writer acquired the lock")
"""

    class Candidate(sqlite3.Connection):
        def backup(self, target, **kwargs):
            subprocess.run([sys.executable, "-c", competing_writer, str(original)], check=True)
            super().backup(target, **kwargs)

    with closing(sqlite3.connect(candidate, factory=Candidate)) as staged, closing(sqlite3.connect(original)) as target:
        staged.text_factory = bytes
        recover_store._activate(target, staged, manifest)
    after = original.stat()
    assert (identity.st_dev, identity.st_ino) == (after.st_dev, after.st_ino)
    with closing(recover_store._sqlite(original)) as restored:
        assert restored.execute("select typeof(prompt), hex(prompt) from calls where id='b'").fetchone() == (b"text", b"FF")
        assert restored.execute("select * from chat_sessions").fetchall() == [(b"session", b"provider")]


def test_activation_refuses_to_overwrite_a_newer_original(stores):
    original, candidate, manifest = stores
    with closing(sqlite3.connect(original)) as target, target:
        target.execute("update calls set prompt='newer' where id='a'")
    with closing(recover_store._sqlite(candidate)) as staged, closing(sqlite3.connect(original)) as target:
        with pytest.raises(RuntimeError, match="Call at row 1 changed"):
            recover_store._activate(target, staged, manifest)
    with closing(sqlite3.connect(original)) as target:
        assert target.execute("select prompt from calls where id='a'").fetchone() == ("newer",)


def test_manifest_cannot_exclude_a_readable_original(stores):
    original, candidate, manifest = stores
    with closing(sqlite3.connect(candidate)) as staged, staged:
        staged.execute("delete from calls where id='a'")
    manifest["candidate_rows"] = 1
    manifest["unreadable_omitted"] = [{
        "rowid": 1, "call_id": "a", "correlation_id": "original-a", "status": "completed", "code": "SQLITE_CORRUPT",
    }]
    with closing(recover_store._sqlite(candidate)) as staged, closing(sqlite3.connect(original)) as target:
        with pytest.raises(RuntimeError, match="Call at row 1 changed"):
            recover_store._activate(target, staged, manifest)
    with closing(sqlite3.connect(original)) as target:
        assert target.execute("select count(*) from calls").fetchone() == (2,)
