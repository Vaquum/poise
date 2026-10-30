"""External diagnostic source projection, process bounds and replay windows."""

import datetime as dt
import importlib.util
import json
from pathlib import Path
import sys
import subprocess
import time
import unittest
from unittest.mock import patch

PATH = Path(__file__).resolve().parents[1] / "ingress" / "reporter.py"
SPEC = importlib.util.spec_from_file_location("poise_ingress", PATH)
reporter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reporter)
NOW = dt.datetime(2026, 10, 19, 10, tzinfo=dt.timezone.utc)
CONTAINER = "a" * 64
CONFIG = {"domain": "poise.test", "container": "caddy"}


def line(host="alice.poise.test", level="error", message="upstream refused", stamp="2026-10-19T09:59:58.123456789Z"):
    return (stamp + " " + json.dumps({"level": level, "msg": message, "request": {"host": host, "method": "GET", "uri": "/?private-query", "headers": {"Authorization": "private-header"}}, "business-data": "private-body"})).encode()


class IngressTests(unittest.TestCase):
    def test_native_projection_excludes_other_hosts_routine_output_and_request_payload(self):
        start, end = NOW - dt.timedelta(minutes=5), NOW
        for value in (line("business.test"), line("poise.test.attacker.test"), line(level="info"), ):
            self.assertIsNone(reporter.projected(value, "poise.test", start, end))
        record = reporter.projected(line(), "poise.test", start, end)
        self.assertEqual(record["time"], "2026-10-19T09:59:58.123Z")
        self.assertEqual(record["log"]["request"], {"host": "alice.poise.test", "method": "GET"})
        self.assertNotIn("private-", json.dumps(record))
        self.assertEqual(record["id"], reporter.projected(line(), "poise.test", start, end)["id"])
        self.assertNotEqual(record["id"], reporter.projected(line(message="second occurrence"), "poise.test", start, end)["id"])

    def test_native_nanos_and_canonical_pretransport_projection(self):
        self.assertEqual(reporter.instant("2026-10-19T09:59:58.123456789Z").microsecond, 123456)
        start, end = NOW - dt.timedelta(minutes=5), NOW
        values = [reporter.projected(line(message="upstream failed\\nAuthorization: Bearer private-secret"), "poise.test", start, end),
                  reporter.projected(line("admin.poise.test"), "poise.test", start, end),
                  reporter.projected(line("nested.alice.poise.test"), "poise.test", start, end)]
        helper = PATH.parents[2] / "test-results/ingress/projection.cjs"
        result = json.loads(subprocess.check_output(["node", str(helper), "poise.test"], input=json.dumps(values).encode(), timeout=3))
        self.assertEqual(len(result), 1)
        self.assertNotIn("private-secret", json.dumps(result))
        self.assertNotIn("private-header", json.dumps(result))
        self.assertNotIn("private-query", json.dumps(result))

    def test_unstructured_lines_do_not_discard_attributable_records_in_the_same_second(self):
        native = b"2026-10-19T09:59:58.123456789Z goroutine 1 [running]:\n" + line() + b"\n"
        def source(argv, **_options):
            return CONTAINER.encode() if "inspect" in argv else native
        with patch.object(reporter, "bounded_command", side_effect=source), patch.object(reporter, "retained_boundary", return_value=None):
            batch = reporter.collect(CONFIG, {"version": 1, "domain": "poise.test", "issuedAt": reporter.iso(NOW), "checkpoint": None}, NOW)
        self.assertEqual(batch["state"], "complete")
        self.assertEqual(len(batch["records"]), 1)

    def test_gateway_clock_anchors_windows_and_excessive_skew_is_explicit_without_advancing(self):
        def source(argv, **_options):
            return CONTAINER.encode() if "inspect" in argv else b""
        hello = {"version": 1, "domain": "poise.test", "issuedAt": reporter.iso(NOW), "checkpoint": None}
        with patch.object(reporter, "bounded_command", side_effect=source), patch.object(reporter, "retained_boundary", return_value=None):
            ahead = reporter.collect(CONFIG, hello, NOW + dt.timedelta(seconds=4))
            behind = reporter.collect(CONFIG, hello, NOW - dt.timedelta(seconds=60))
        self.assertEqual(ahead["until"], "2026-10-19T09:59:59.000Z")
        self.assertEqual(ahead["state"], "complete")
        self.assertEqual(behind["state"], "unavailable")
        self.assertEqual(behind["failure"], "clock-skew")
        self.assertEqual(behind["expected"], hello["checkpoint"])
        self.assertEqual(behind["records"], [])

    def test_a_slow_edge_clock_never_commits_past_events_that_have_not_been_emitted(self):
        reads = 0
        def source(argv, **_options):
            nonlocal reads
            if "inspect" in argv:
                return CONTAINER.encode()
            reads += 1
            stamp = "2026-10-19T09:59:54.000000000Z" if reads == 1 else "2026-10-19T09:59:57.000000000Z"
            return line(message="before scan" if reads == 1 else "emitted after scan", stamp=stamp) + b"\n"
        hello = {"version": 1, "domain": "poise.test", "issuedAt": reporter.iso(NOW), "checkpoint": None}
        with patch.object(reporter, "bounded_command", side_effect=source), patch.object(reporter, "retained_boundary", return_value=None):
            first = reporter.collect(CONFIG, hello, NOW - dt.timedelta(seconds=4))
            cursor = json.dumps({"container": CONTAINER, "until": first["until"]}, separators=(",", ":"))
            second = reporter.collect(CONFIG, {**hello, "issuedAt": reporter.iso(NOW + dt.timedelta(seconds=15)), "checkpoint": cursor}, NOW + dt.timedelta(seconds=11))
        self.assertEqual(first["state"], "complete")
        self.assertLess(reporter.instant(first["until"]), NOW - dt.timedelta(seconds=4))
        self.assertEqual(second["from"], first["until"])
        self.assertEqual([record["log"]["msg"] for record in second["records"]], ["emitted after scan"])

    def test_real_subprocess_output_and_absolute_time_bounds(self):
        with self.assertRaises(reporter.ReadBound):
            reporter.bounded_command([sys.executable, "-c", "import sys;sys.stdout.write('x'*10000)"], limit=1024)
        started = time.monotonic()
        with self.assertRaises(reporter.ReadBound):
            reporter.bounded_command([sys.executable, "-c", "import time;time.sleep(5)"], timeout=0.1)
        self.assertLess(time.monotonic() - started, 2)
        with self.assertRaises(RuntimeError):
            reporter.bounded_command([sys.executable, "-c", "raise SystemExit(1)"])

    def test_window_uses_exact_committed_container_and_time(self):
        cursor = json.dumps({"container": CONTAINER, "until": "2026-10-19T09:59:30.000Z"}, separators=(",", ":"))
        calls = []

        def run(argv, **_options):
            calls.append(argv)
            return CONTAINER.encode() if "inspect" in argv else line() + b"\n"

        with patch.object(reporter, "bounded_command", side_effect=run), patch.object(reporter, "retained_boundary", return_value="2026-10-01T00:00:00.000Z"):
            batch = reporter.collect(CONFIG, {"version": 1, "domain": "poise.test", "issuedAt": reporter.iso(NOW), "checkpoint": cursor}, NOW)
        self.assertEqual(batch["from"], "2026-10-19T09:59:30.000Z")
        self.assertEqual(batch["until"], "2026-10-19T09:59:59.000Z")
        self.assertEqual(batch["expected"], cursor)
        self.assertEqual(len(batch["records"]), 1)
        self.assertNotIn("--tail", calls[-1])
        self.assertNotIn("--follow", calls[-1])

    def test_reduces_source_window_and_records_irrecoverable_read_loss(self):
        def bounded(argv, **_options):
            if "inspect" in argv:
                return CONTAINER.encode()
            raise reporter.ReadBound("source byte cap")

        with patch.object(reporter, "bounded_command", side_effect=bounded), patch.object(reporter, "retained_boundary", return_value=None):
            batch = reporter.collect(CONFIG, {"version": 1, "domain": "poise.test", "issuedAt": reporter.iso(NOW), "checkpoint": None}, NOW)
        self.assertEqual(batch["state"], "bounded")
        self.assertEqual(batch["records"], [])
        self.assertLessEqual((reporter.instant(batch["until"]) - reporter.instant(batch["from"])).total_seconds(), 1)

    def test_projection_framing_overflow_reduces_window_before_invoking_helper(self):
        def native(stamp, message):
            return (stamp + " " + json.dumps({"level": "error", "msg": message, "request": {"host": "poise.test"}}) + "\n").encode()
        stamp = "2026-10-19T09:59:32.000000000Z"
        length = (reporter.MAX_BYTES - 100) // 100 - len(native(stamp, ""))
        message = ("upstream refused. " * (length // 18 + 1))[:length]
        raw = b"".join(native(stamp if index < 50 else "2026-10-19T09:59:57.000000000Z", message) for index in range(100))
        self.assertLess(len(raw), reporter.MAX_BYTES)
        reads = 0
        def source(argv, **_options):
            nonlocal reads
            if "inspect" in argv:
                return CONTAINER.encode()
            reads += 1
            return raw
        cursor = json.dumps({"container": CONTAINER, "until": "2026-10-19T09:59:30.000Z"}, separators=(",", ":"))
        with patch.object(reporter, "bounded_command", side_effect=source), patch.object(reporter, "retained_boundary", return_value=None):
            batch = reporter.collect(CONFIG, {"version": 1, "domain": "poise.test", "issuedAt": reporter.iso(NOW), "checkpoint": cursor}, NOW)
        self.assertGreater(reads, 1)
        self.assertEqual(batch["state"], "complete")
        self.assertEqual(len(batch["records"]), 50)
        self.assertLess(reporter.instant(batch["until"]), NOW - dt.timedelta(seconds=1))

    def test_budget_expiry_keeps_the_reduced_window_for_the_next_poll(self):
        clock = [0]
        durations = []
        def source(argv, **_options):
            if "inspect" in argv:
                return CONTAINER.encode()
            start = reporter.instant(argv[argv.index("--since") + 1])
            end = reporter.instant(argv[argv.index("--until") + 1])
            durations.append((end - start).total_seconds())
            clock[0] += 3
            if durations[-1] > 2:
                raise reporter.ReadBound("source read consumed its deadline")
            return b""
        cursor = json.dumps({"container": CONTAINER, "until": "2026-10-19T09:59:30.000Z"}, separators=(",", ":"))
        hello = {"version": 1, "domain": "poise.test", "issuedAt": reporter.iso(NOW), "checkpoint": cursor}
        window = reporter.ReplayWindow()
        with patch.object(reporter, "bounded_command", side_effect=source), patch.object(reporter, "retained_boundary", return_value=None), patch.object(reporter.time, "monotonic", side_effect=lambda: clock[0]):
            first = reporter.collect(CONFIG, hello, NOW, window)
            second = reporter.collect(CONFIG, hello, NOW, window)
        self.assertEqual(first["state"], "unavailable")
        self.assertEqual(first["expected"], cursor)
        self.assertEqual(second["state"], "complete")
        self.assertEqual(second["from"], first["from"])
        self.assertEqual(second["until"], first["until"])
        self.assertLessEqual(durations[-1], 2)
        self.assertGreater(len(durations), 4)

    def test_initial_replay_anchor_survives_budget_expiry_and_a_moving_retention_cutoff(self):
        clock = [0]
        def source(argv, **_options):
            if "inspect" in argv:
                return CONTAINER.encode()
            start = reporter.instant(argv[argv.index("--since") + 1])
            end = reporter.instant(argv[argv.index("--until") + 1])
            clock[0] += 3
            if (end - start).total_seconds() > 2 * 86400:
                raise reporter.ReadBound("source window is still too large")
            return b""
        hello = {"version": 1, "domain": "poise.test", "issuedAt": reporter.iso(NOW), "checkpoint": None}
        window = reporter.ReplayWindow()
        with patch.object(reporter, "bounded_command", side_effect=source), patch.object(reporter, "retained_boundary", return_value=reporter.iso(NOW - dt.timedelta(days=40))), patch.object(reporter.time, "monotonic", side_effect=lambda: clock[0]):
            first = reporter.collect(CONFIG, hello, NOW, window)
            later = NOW + dt.timedelta(days=3)
            second = reporter.collect(CONFIG, {**hello, "issuedAt": reporter.iso(later)}, later, window)
        self.assertEqual(first["state"], "unavailable")
        self.assertEqual(second["state"], "complete")
        self.assertEqual(second["from"], first["from"])
        self.assertEqual(second["until"], first["until"])
        self.assertLess(reporter.instant(second["from"]), reporter.instant(second["until"]))

    def test_rotation_during_a_read_refreshes_the_retention_boundary(self):
        def source(argv, **_options):
            return CONTAINER.encode() if "inspect" in argv else line() + b"\n"
        old, new = reporter.iso(NOW - dt.timedelta(minutes=10)), reporter.iso(NOW - dt.timedelta(seconds=10))
        cursor = json.dumps({"container": CONTAINER, "until": "2026-10-19T09:59:30.000Z"}, separators=(",", ":"))
        for after in (new, None):
            with self.subTest(after=after), patch.object(reporter, "bounded_command", side_effect=source), patch.object(reporter, "retained_boundary", side_effect=[old, after]):
                batch = reporter.collect(CONFIG, {"version": 1, "domain": "poise.test", "issuedAt": reporter.iso(NOW), "checkpoint": cursor}, NOW)
            self.assertEqual(batch["state"], "complete" if after else "bounded")
            if after:
                self.assertEqual(batch["retainedFrom"], new)
                self.assertGreater(reporter.instant(batch["retainedFrom"]), reporter.instant(batch["from"]))
            else:
                self.assertEqual(batch["records"], [])

    def test_redaction_expansion_obeys_the_gateway_per_record_bound(self):
        raw = line(message="?x " * 5000, stamp="2026-10-19T09:59:30.100000000Z") + b"\n"
        self.assertLess(len(raw), 64 * 1024)
        def source(argv, **_options):
            return CONTAINER.encode() if "inspect" in argv else raw
        cursor = json.dumps({"container": CONTAINER, "until": "2026-10-19T09:59:30.000Z"}, separators=(",", ":"))
        with patch.object(reporter, "bounded_command", side_effect=source), patch.object(reporter, "retained_boundary", return_value=None):
            batch = reporter.collect(CONFIG, {"version": 1, "domain": "poise.test", "issuedAt": reporter.iso(NOW), "checkpoint": cursor}, NOW)
        self.assertEqual(batch["state"], "bounded")
        self.assertEqual(batch["records"], [])
        self.assertLessEqual((reporter.instant(batch["until"]) - reporter.instant(batch["from"])).total_seconds(), 1)
        self.assertLess(reporter.instant("2026-10-19T09:59:30.100Z"), reporter.instant(batch["until"]))

    def test_source_failure_is_explicit_and_domain_mismatch_stops_before_read(self):
        def unavailable(argv, **_options):
            if "inspect" in argv:
                return CONTAINER.encode()
            raise RuntimeError("source unavailable")

        with patch.object(reporter, "bounded_command", side_effect=unavailable), patch.object(reporter, "retained_boundary", return_value=None):
            batch = reporter.collect(CONFIG, {"version": 1, "domain": "poise.test", "issuedAt": reporter.iso(NOW), "checkpoint": None}, NOW)
        self.assertEqual(batch["state"], "unavailable")
        with patch.object(reporter, "bounded_command") as source:
            with self.assertRaises(RuntimeError):
                reporter.collect(CONFIG, {"version": 1, "domain": "other.test", "checkpoint": None}, NOW)
            source.assert_not_called()

    def test_initial_replay_uses_retained_history_and_keeps_identical_native_occurrences(self):
        def source(argv, **_options):
            return CONTAINER.encode() if "inspect" in argv else line() + b"\n" + line() + b"\n"

        with patch.object(reporter, "bounded_command", side_effect=source), patch.object(reporter, "retained_boundary", return_value="2026-10-09T10:00:00.000Z"):
            batch = reporter.collect(CONFIG, {"version": 1, "domain": "poise.test", "issuedAt": reporter.iso(NOW), "checkpoint": None}, NOW)
        self.assertEqual(batch["from"], "2026-10-09T10:00:00.000Z")
        self.assertEqual(batch["state"], "complete")
        self.assertEqual(len(batch["records"]), 2)
        self.assertNotEqual(batch["records"][0]["id"], batch["records"][1]["id"])


if __name__ == "__main__":
    unittest.main()
