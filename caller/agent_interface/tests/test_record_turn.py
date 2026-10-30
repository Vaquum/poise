import json
import os
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from time import time
from unittest import TestCase
from unittest.mock import patch

import agent_interface

ROOT = Path(__file__).resolve().parents[1]


class RecordTurnCase(TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.data = Path(self.work.name)
        for target in (
            patch.object(agent_interface, "DATA_DIR", self.data),
            patch.object(agent_interface, "DB", self.data / "calls.sqlite3"),
            patch.object(agent_interface, "RESPONSES", self.data / "responses"),
            patch.dict(os.environ, {"AGENT_INTERFACE_ACTOR": ""}),
        ):
            target.start()
            self.addCleanup(target.stop)
        agent_interface.init_db()

    def start(self, **overrides) -> str:
        args = {"model": "opus-5-max", "session_id": "sess-1", "source": "poise:chat", **overrides}
        return agent_interface.record_turn_start(**args)

    def row(self, id_):
        with agent_interface.db() as conn:
            return conn.execute("select * from calls where id=?", (id_,)).fetchone()

    def cli(self, *args: str) -> subprocess.CompletedProcess:
        env = {
            "AGENT_INTERFACE_DATA_DIR": str(self.data),
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONPATH": str(ROOT),
            "PATH": "",
            "HOME": self.work.name,
        }
        return subprocess.run(
            [sys.executable, "-c", "from agent_interface import main; main()", *args],
            text=True, capture_output=True, env=env, cwd=self.work.name, timeout=60,
        )


class TestStart(RecordTurnCase):
    def test_creates_one_external_chat_row_and_launches_nothing(self):
        with patch.dict(os.environ, {"AGENT_INTERFACE_ACTOR": "poise-bot"}), \
                patch.object(subprocess, "Popen", side_effect=AssertionError("launched a process")), \
                patch.object(subprocess, "run", side_effect=AssertionError("launched a process")):
            before = time()
            id_ = self.start(repo="mikkokotila/Poise", pr="#68", correlation_id="turn-1")
        self.assertRegex(id_, r"^[0-9a-f]{32}$")
        row = self.row(id_)
        self.assertEqual(
            (row["behavior"], row["status"], row["model"], row["session_id"], row["source"], row["repo"],
             row["pr_id"], row["correlation_id"], row["prompt"], row["actor"], row["runner"], row["pid"], row["ended_at"]),
            ("chat", "running", "opus-5-max", "sess-1", "poise:chat", "mikkokotila/Poise",
             "68", "turn-1", "", "poise-bot", "external", None, None),
        )
        self.assertGreaterEqual(row["started_at"], before)
        self.assertIsNone(row["outcome"])
        self.assertIsNone(row["expected_head"])

    def test_optional_fields_stay_null(self):
        row = self.row(self.start())
        self.assertEqual((row["repo"], row["pr_id"], row["correlation_id"], row["actor"]), (None, None, None, None))

    def test_rejects_malformed_arguments(self):
        cases = (
            ("unknown model", dict(model="opus-9-max")),
            ("session", dict(session_id="bad session")),
            ("session", dict(session_id="")),
            ("source", dict(source="bad source")),
            ("repo", dict(repo="not-a-repo")),
            ("repo", dict(repo="a/b/c")),
            ("pr", dict(repo="a/b", pr="zero")),
            ("pr", dict(repo="a/b", pr="0")),
            ("--pr requires --repo", dict(pr="68")),
            ("correlation", dict(correlation_id="bad id")),
        )
        for message, overrides in cases:
            with self.subTest(overrides), self.assertRaisesRegex(
                    (ValueError, agent_interface.ModelCatalogError), message):
                self.start(**overrides)
        with agent_interface.db() as conn:
            self.assertEqual(conn.execute("select count(*) from calls").fetchone()[0], 0)

    def test_accepts_pr_forms_and_trims(self):
        for pr in ("68", "#68", "https://github.com/mikkokotila/Poise/pull/68"):
            self.assertEqual(self.row(self.start(repo=" mikkokotila/Poise ", pr=pr))["pr_id"], "68")


class TestStartIdempotency(RecordTurnCase):
    def test_same_turn_twice_is_one_row(self):
        first = self.start(repo="a/b", pr="1", correlation_id="turn-1")
        self.assertEqual(self.start(repo="a/b", pr="1", correlation_id="turn-1"), first)
        agent_interface.record_turn_finish(first, "completed")
        self.assertEqual(self.start(repo="a/b", pr="1", correlation_id="turn-1"), first)
        with agent_interface.db() as conn:
            self.assertEqual(conn.execute("select count(*) from calls").fetchone()[0], 1)

    def test_a_different_turn_under_the_same_correlation_id_is_refused(self):
        self.start(repo="a/b", pr="1", correlation_id="turn-1")
        for overrides in (dict(model="opus-5-high"), dict(session_id="sess-2"), dict(source="poise:other"),
                          dict(repo="a/c"), dict(pr="2"), dict(repo=None, pr=None)):
            with self.subTest(overrides), self.assertRaisesRegex(ValueError, "already records a different call"):
                self.start(**{"repo": "a/b", "pr": "1", **overrides, "correlation_id": "turn-1"})
        with agent_interface.db() as conn:
            self.assertEqual(conn.execute("select count(*) from calls").fetchone()[0], 1)

    def test_a_review_correlation_id_is_never_adopted(self):
        agent_interface.track("opus-5-high", "", "1", "a/b", "bot", "pr_review", source="poise:chat",
                              correlation_id="turn-1", expected_head="a" * 40)
        with self.assertRaisesRegex(ValueError, "already records a different call"):
            self.start(repo="a/b", pr="1", correlation_id="turn-1")

    def test_without_a_correlation_id_every_start_is_new(self):
        self.assertNotEqual(self.start(), self.start())

    def test_concurrent_starts_converge_on_one_row(self):
        with ThreadPoolExecutor(8) as pool:
            ids = set(pool.map(lambda _: self.start(correlation_id="turn-1"), range(8)))
        self.assertEqual(len(ids), 1)
        with agent_interface.db() as conn:
            self.assertEqual(conn.execute("select count(*) from calls").fetchone()[0], 1)


class TestFinish(RecordTurnCase):
    def test_closes_the_turn_with_timestamps_and_outcome(self):
        id_ = self.start()
        before = time()
        result = agent_interface.record_turn_finish(id_, "completed")
        row = self.row(id_)
        self.assertEqual((row["status"], row["error"], row["outcome"], row["action"], row["head_sha"]),
                         ("completed", "", None, None, None))
        self.assertGreaterEqual(row["ended_at"], before)
        self.assertEqual(result, {
            "id": id_,
            "status": "completed",
            "started_at": agent_interface.utc_stamp(row["started_at"]),
            "completed_at": agent_interface.utc_stamp(row["ended_at"]),
            "time_elapsed": "0s",
            "error": None,
        })

    def test_failed_and_cancelled_record_their_error(self):
        failed = agent_interface.record_turn_finish(self.start(), "failed", "Adapter exited")
        self.assertEqual((failed["status"], failed["error"]), ("failed", "Adapter exited"))
        defaulted = agent_interface.record_turn_finish(self.start(), "failed")
        self.assertEqual((defaulted["status"], defaulted["error"]), ("failed", "Turn failed"))
        cancelled = agent_interface.record_turn_finish(self.start(), "cancelled")
        self.assertEqual((cancelled["status"], cancelled["error"]), ("cancelled", None))
        self.assertEqual(self.row(cancelled["id"])["error"], "")

    def test_rejects_malformed_arguments(self):
        id_ = self.start()
        with self.assertRaisesRegex(ValueError, "status must be one of"):
            agent_interface.record_turn_finish(id_, "done")
        with self.assertRaisesRegex(ValueError, "only recorded for a failed or cancelled"):
            agent_interface.record_turn_finish(id_, "completed", "oops")
        with self.assertRaisesRegex(ValueError, "unknown call id"):
            agent_interface.record_turn_finish("f" * 32, "completed")
        self.assertEqual(self.row(id_)["status"], "running")

    def test_repeating_the_same_outcome_changes_nothing(self):
        id_ = self.start()
        first = agent_interface.record_turn_finish(id_, "failed", "first")
        again = agent_interface.record_turn_finish(id_, "failed", "second")
        self.assertEqual(again, first)
        self.assertEqual(self.row(id_)["error"], "first")

    def test_a_contradictory_outcome_is_refused_and_kept(self):
        id_ = self.start()
        agent_interface.record_turn_finish(id_, "completed")
        ended = self.row(id_)["ended_at"]
        for status in ("failed", "cancelled"):
            with self.assertRaisesRegex(ValueError, "already finished as completed"):
                agent_interface.record_turn_finish(id_, status, "late")
        self.assertEqual((self.row(id_)["status"], self.row(id_)["ended_at"], self.row(id_)["error"]),
                         ("completed", ended, ""))

    def test_only_external_rows_can_be_finished(self):
        review = agent_interface.track("opus-5-high", "", "1", "a/b", "bot", "pr_review", source="poise:manual-review",
                                       correlation_id="r-1", expected_head="a" * 40)
        approve = agent_interface.track("opus-5-high", "", "1", "a/b", "bot", "pr_approve")
        legacy_chat = agent_interface.track("opus-5-max", "hello", behavior="chat", session_id="sess-1")
        for id_ in (review, approve, legacy_chat):
            with self.subTest(id_), self.assertRaisesRegex(ValueError, "not an externally recorded turn"):
                agent_interface.record_turn_finish(id_, "completed")
            self.assertEqual(self.row(id_)["status"], "running")

    def test_concurrent_finishes_keep_exactly_one_outcome(self):
        id_ = self.start()
        statuses = ["completed", "failed", "cancelled"] * 3

        def attempt(status):
            try:
                return agent_interface.record_turn_finish(id_, status)["status"]
            except ValueError as error:
                return str(error)

        with ThreadPoolExecutor(len(statuses)) as pool:
            results = list(pool.map(attempt, statuses))
        final = self.row(id_)["status"]
        self.assertIn(final, ("completed", "failed", "cancelled"))
        self.assertEqual(results.count(final), 3)
        self.assertEqual(sum(f"already finished as {final}" in r for r in results), 6)


class TestStopAndLogs(RecordTurnCase):
    def test_generic_stop_refuses_an_external_turn_and_signals_nothing(self):
        id_ = self.start()
        with patch.object(agent_interface, "signal_group", side_effect=AssertionError("signalled")), \
                patch.object(agent_interface, "process_command", side_effect=AssertionError("looked up a process")):
            with self.assertRaisesRegex(RuntimeError, "managed externally .*poise:chat.*through Poise"):
                agent_interface.stop_call(id_)
        self.assertEqual((self.row(id_)["status"], self.row(id_)["ended_at"]), ("running", None))
        agent_interface.record_turn_finish(id_, "cancelled")
        self.assertEqual(agent_interface.stop_call(id_), {"id": id_, "stopped": False, "status": "cancelled"})

    def test_native_rows_keep_their_stop_semantics(self):
        id_ = agent_interface.track("opus-5-max", "prompt")
        self.assertEqual((self.row(id_)["pid"], self.row(id_)["runner"]), (str(os.getpid()), None))
        with agent_interface.db() as conn:
            conn.execute("update calls set pid=null where id=?", (id_,))
        with self.assertRaisesRegex(RuntimeError, "recorded no process id"):
            agent_interface.stop_call(id_)

    def test_logs_list_the_turn_as_external_before_and_after_finish(self):
        native = agent_interface.track("opus-5-max", "prompt", behavior="chat")
        id_ = self.start(repo="a/b", pr="7", correlation_id="turn-1")
        by_id = {entry["id"]: entry for entry in agent_interface.logs()}
        self.assertIsNone(by_id[native]["runner"])
        entry = by_id[id_]
        self.assertEqual(
            {key: entry[key] for key in ("behavior", "model", "session_id", "source", "repo", "pr_id",
                                         "correlation_id", "status", "completed_at", "runner", "outcome", "prompt")},
            {"behavior": "chat", "model": "opus-5-max", "session_id": "sess-1", "source": "poise:chat", "repo": "a/b",
             "pr_id": "7", "correlation_id": "turn-1", "status": "running", "completed_at": None,
             "runner": "external", "outcome": None, "prompt": ""},
        )
        agent_interface.record_turn_finish(id_, "cancelled")
        entry = {e["id"]: e for e in agent_interface.logs()}[id_]
        self.assertEqual((entry["status"], entry["runner"], entry["outcome"], entry["error"]),
                         ("cancelled", "external", None, ""))
        self.assertIsNotNone(entry["completed_at"])
        self.assertEqual(entry["time_elapsed"], "0s")


class TestCli(RecordTurnCase):
    def test_start_prints_a_bare_id_and_finish_prints_json(self):
        done = self.cli("--record-turn", "start", "--model", "grok-4.6-xhigh", "--session", "sess-1",
                        "--source", "poise:chat", "--repo", "a/b", "--pr", "7", "--correlation-id", "turn-1")
        self.assertEqual((done.returncode, done.stderr), (0, ""), done.stderr)
        id_ = done.stdout.rstrip("\n")
        self.assertRegex(done.stdout, r"^[0-9a-f]{32}\n$")
        self.assertEqual(self.row(id_)["runner"], "external")
        repeat = self.cli("--record-turn", "start", "--model", "grok-4.6-xhigh", "--session", "sess-1",
                          "--source", "poise:chat", "--repo", "a/b", "--pr", "7", "--correlation-id", "turn-1")
        self.assertEqual((repeat.returncode, repeat.stdout), (0, done.stdout))
        done = self.cli("--record-turn", "finish", id_, "--status", "failed", "--error", "Adapter exited")
        self.assertEqual((done.returncode, done.stderr), (0, ""), done.stderr)
        result = json.loads(done.stdout)
        self.assertEqual((result["id"], result["status"], result["error"]), (id_, "failed", "Adapter exited"))
        self.assertEqual(set(result), {"id", "status", "started_at", "completed_at", "time_elapsed", "error"})
        listed = {e["id"]: e for e in json.loads(self.cli("--logs").stdout)}[id_]
        self.assertEqual((listed["status"], listed["runner"], listed["model"]), ("failed", "external", "grok-4.6-xhigh"))

    def test_errors_are_one_line_and_nonzero(self):
        id_ = self.start()
        agent_interface.record_turn_finish(id_, "completed")
        for args, message in (
            (("start", "--model", "nope", "--session", "s", "--source", "poise:chat"), "unknown model"),
            (("start", "--model", "opus-5-max", "--session", "s", "--source", "poise:chat", "--pr", "1"), "--pr requires --repo"),
            (("finish", id_, "--status", "cancelled"), "already finished as completed"),
            (("finish", "f" * 32, "--status", "completed"), "unknown call id"),
            (("finish", id_, "--status", "done"), "status must be one of"),
        ):
            with self.subTest(args):
                done = self.cli("--record-turn", *args)
                self.assertEqual((done.returncode, done.stdout), (1, ""))
                self.assertRegex(done.stderr, rf"^error: .*{message}")
                self.assertEqual(len(done.stderr.rstrip("\n").splitlines()), 1)

    def test_usage_errors(self):
        for args, message in (
            (("start", "--model", "opus-5-max", "--session", "s"), "--source is required"),
            (("start", "--model", "opus-5-max", "--source", "poise:chat"), "--session is required"),
            (("finish", "--status", "completed"), "finish requires a full call id"),
            (("finish", "abc", "--status", "completed"), "finish requires a full call id"),
            (("finish", "a" * 32), "--status is required"),
            (("bogus",), "takes start or finish"),
        ):
            with self.subTest(args):
                done = self.cli("--record-turn", *args)
                self.assertEqual((done.returncode, done.stdout), (2, ""))
                self.assertIn(message, done.stderr)
        with agent_interface.db() as conn:
            self.assertEqual(conn.execute("select count(*) from calls").fetchone()[0], 0)

    def test_stop_reports_the_external_turn(self):
        id_ = self.start()
        done = self.cli("--stop", id_)
        self.assertEqual(done.returncode, 1)
        self.assertIn("stop it through Poise", done.stderr)
        self.assertEqual(self.row(id_)["status"], "running")
