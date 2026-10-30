"""calls.sqlite3 runs WAL so readers never block writers' commits."""
import sqlite3
import tempfile
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

import agent_interface


class CallsWalCase(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        for name, value in (("DB", root / "calls.sqlite3"), ("RESPONSES", root / "responses")):
            target = patch.object(agent_interface, name, value)
            target.start()
            self.addCleanup(target.stop)

    def journal_mode(self, path):
        conn = sqlite3.connect(path)
        try:
            return conn.execute("pragma journal_mode").fetchone()[0].lower()
        finally:
            conn.close()

    def test_init_db_enables_wal_on_fresh_and_delete_mode_databases(self):
        agent_interface.init_db()
        self.assertEqual(self.journal_mode(agent_interface.DB), "wal")
        migrate = Path(self.directory.name) / "migrate.sqlite3"
        conn = sqlite3.connect(migrate)
        try:
            conn.execute(
                "create table calls (id text primary key, model text, prompt text, started_at real, ended_at real, status text, response_path text, error text)"
            )
            conn.execute("insert into calls values('kept', null, null, null, null, null, null, null)")
            conn.commit()
            self.assertEqual(conn.execute("pragma journal_mode").fetchone()[0].lower(), "delete")
        finally:
            conn.close()
        with patch.object(agent_interface, "DB", migrate):
            agent_interface.init_db()
            self.assertEqual(self.journal_mode(migrate), "wal")
            check = sqlite3.connect(migrate)
            try:
                self.assertEqual(check.execute("select id from calls where id='kept'").fetchone()[0], "kept")
            finally:
                check.close()

    def test_steady_state_init_db_opens_no_write_transaction(self):
        agent_interface.init_db()
        statements = []
        real_connect = sqlite3.connect

        def traced(*args, **kwargs):
            conn = real_connect(*args, **kwargs)
            conn.set_trace_callback(statements.append)
            return conn

        with patch.object(agent_interface.sqlite3, "connect", traced):
            agent_interface.init_db()
        writes = [s for s in statements if s.strip().upper().startswith(("BEGIN", "COMMIT", "INSERT", "UPDATE", "DELETE"))]
        self.assertEqual(writes, [])
