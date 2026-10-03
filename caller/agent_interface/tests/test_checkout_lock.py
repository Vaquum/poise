import json
import os
import signal
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path
from threading import Thread
from time import monotonic, sleep, time
from unittest import TestCase
from unittest.mock import patch

import agent_interface
from agent_interface import checkout_lock, fix_failing_ci
from agent_interface.checkout_lock import Lease, LeaseLost, LockBusy, WorkerOrphaned, pgid_alive, pid_alive
from agent_interface.model_catalog import CATALOG

ROOT = Path(__file__).resolve().parents[1]
# Exercise the gate shipped with the imported package (wheel or source),
# not a different copy inferred from the location of the tests.
GATE = checkout_lock.GATE

# A fake native writer: appends to WRITER_LOG ten times a second, records its
# pid and group, and checks that CONTROL_FD (if given) is closed for it.
WRITER = """
import os, sys, time
log = os.environ["WRITER_LOG"]
fd = os.environ.get("CONTROL_FD")
try:
    os.fstat(int(fd)) if fd else None
    control = "open" if fd else "unset"
except OSError:
    control = "closed"
with open(log + ".meta", "w") as meta:
    meta.write(f"{os.getpid()} {os.getpgid(0)} {os.getppid()} {control}")
if os.environ.get("WRITER_GRANDCHILD"):
    import subprocess
    subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
for _ in range(int(os.environ.get("WRITER_TICKS", "600"))):
    with open(log, "a") as out:
        out.write("x")
    time.sleep(0.1)
sys.stdout.write("wrote")
"""

# A holder process: acquires the lease on argv[1], runs WRITER under the gate.
HOLDER = """
import os, sys
from agent_interface import checkout_lock
lease = checkout_lock.Lease(sys.argv[1], "holder-call", "fix-failing-ci o/r#1 (call holder-c)").acquire(5)
print(lease.token, flush=True)
with checkout_lock.interruptible():
    checkout_lock.run_gated(lease, [sys.executable, "-c", sys.argv[2]], cwd=sys.argv[1], env=None, timeout=120)
"""


def dead_pid() -> int:
    process = subprocess.Popen([sys.executable, "-c", "pass"])
    process.wait()
    return process.pid


class LockCase(TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.checkout = str(Path(self.work.name, "repo"))
        Path(self.checkout).mkdir()
        self.lockdir = str(Path(self.work.name, "locks"))
        self.log = str(Path(self.work.name, "writer.log"))
        patcher = patch.dict(os.environ, {"POISE_LOCK_DIR": self.lockdir, "WRITER_LOG": self.log, "PYTHONPATH": str(ROOT),
                                          "PYTHONDONTWRITEBYTECODE": "1", "AGENT_INTERFACE_DATA_DIR": str(Path(self.work.name, "data"))})
        patcher.start()
        self.addCleanup(patcher.stop)
        for name in ("CONTROL_FD", "WRITER_GRANDCHILD", "WRITER_TICKS"):
            os.environ.pop(name, None)

    def rows(self) -> list[sqlite3.Row]:
        conn = checkout_lock.connect(checkout_lock.lock_path(self.checkout))
        try:
            return conn.execute("select * from lease").fetchall()
        finally:
            conn.close()

    def set_row(self, **values) -> None:
        conn = checkout_lock.connect(checkout_lock.lock_path(self.checkout))
        try:
            conn.execute("update lease set " + ", ".join(f"{k} = ?" for k in values) + " where id = 1", tuple(values.values()))
        finally:
            conn.close()

    def lease(self, owner="call-1", label="fix-failing-ci o/r#1 (call call-1)") -> Lease:
        return Lease(self.checkout, owner, label)

    def meta(self) -> tuple[int, int, int, str]:
        pid, pgid, ppid, control = Path(self.log + ".meta").read_text().split()
        return int(pid), int(pgid), int(ppid), control

    def wait_until(self, predicate, seconds=10.0) -> bool:
        deadline = monotonic() + seconds
        while monotonic() < deadline:
            if predicate():
                return True
            sleep(0.05)
        return predicate()

    def writer_stopped(self) -> bool:
        size = Path(self.log).stat().st_size if Path(self.log).exists() else 0
        sleep(0.4)
        return (Path(self.log).stat().st_size if Path(self.log).exists() else 0) == size

    def holder(self, writer=WRITER) -> tuple[subprocess.Popen, str]:
        process = subprocess.Popen([sys.executable, "-c", HOLDER, self.checkout, writer], text=True, stdout=subprocess.PIPE)
        self.addCleanup(lambda: process.poll() is None and process.kill())
        token = process.stdout.readline().strip()
        self.assertTrue(self.wait_until(lambda: Path(self.log + ".meta").exists()))
        return process, token


class TestIdentityAndSchema(LockCase):
    def test_lock_file_is_the_sha256_of_the_real_path_with_private_modes(self):
        link = Path(self.work.name, "link")
        link.symlink_to(self.checkout)
        expected = checkout_lock.hashlib.sha256(os.path.realpath(self.checkout).encode()).hexdigest()[:32]
        self.assertEqual(checkout_lock.lock_path(str(link) + "/"), Path(self.lockdir) / f"checkout-{expected}.sqlite3")
        self.assertEqual(checkout_lock.lock_path(self.checkout), checkout_lock.lock_path(str(link)))
        self.lease().acquire(1).release()
        self.assertEqual(oct(Path(self.lockdir).stat().st_mode & 0o777), "0o700")
        self.assertEqual(oct(checkout_lock.lock_path(self.checkout).stat().st_mode & 0o777), "0o600")

    def test_schema_is_the_shared_one(self):
        conn = checkout_lock.connect(checkout_lock.lock_path(self.checkout))
        columns = [(r["name"], r["type"].lower(), r["notnull"]) for r in conn.execute("pragma table_info(lease)")]
        conn.close()
        self.assertEqual(columns, [
            ("id", "integer", 0), ("token", "text", 1), ("checkout", "text", 1), ("owner_kind", "text", 1),
            ("owner_id", "text", 1), ("owner_label", "text", 1), ("instance", "text", 1), ("host_pid", "integer", 1),
            ("worker_pid", "integer", 0), ("worker_pgid", "integer", 0), ("worker_ident", "text", 0), ("branch", "text", 0),
            ("acquired_at", "text", 1), ("heartbeat_at", "text", 1), ("lease_until", "integer", 1),
        ])

    def test_acquire_writes_the_row_and_release_deletes_only_it(self):
        before = int(time() * 1000)
        lease = self.lease().acquire(1)
        (row,) = self.rows()
        self.assertEqual((row["id"], row["token"], row["checkout"], row["owner_kind"], row["owner_id"], row["owner_label"],
                          row["instance"], row["host_pid"], row["worker_pid"], row["worker_pgid"], row["worker_ident"], row["branch"]),
                         (1, lease.token, os.path.realpath(self.checkout), "caller:fix-failing-ci", "call-1",
                          "fix-failing-ci o/r#1 (call call-1)", f"caller:{os.getpid()}", os.getpid(), None, None, None, None))
        self.assertRegex(row["token"], r"^[0-9a-f]{32}$")
        self.assertRegex(row["acquired_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
        self.assertGreaterEqual(row["lease_until"], before + checkout_lock.LEASE_MS)
        self.assertTrue(lease.release())
        self.assertEqual(self.rows(), [])
        self.assertFalse(lease.release())


class TestContention(LockCase):
    def test_another_process_blocks_until_it_releases(self):
        holder = subprocess.Popen([sys.executable, "-c", (
            "import sys, time; from agent_interface import checkout_lock\n"
            "lease = checkout_lock.Lease(sys.argv[1], 'other', 'chat \"x\" on main (Poise dev)').acquire(5)\n"
            "print('held', flush=True); time.sleep(2.5); lease.release()"), self.checkout], text=True, stdout=subprocess.PIPE)
        self.addCleanup(lambda: holder.poll() is None and holder.kill())
        self.assertEqual(holder.stdout.readline().strip(), "held")
        with self.assertRaisesRegex(LockBusy, r'in use by chat "x" on main \(Poise dev\); gave up after 0s'):
            self.lease().acquire(0.3)
        lease = self.lease().acquire(10)
        self.assertEqual(holder.wait(timeout=10), 0)
        self.assertEqual(self.rows()[0]["token"], lease.token)
        lease.release()

    def test_same_owner_id_is_a_different_holder(self):
        first = self.lease().acquire(1)
        with self.assertRaisesRegex(LockBusy, "in use by fix-failing-ci o/r#1"):
            self.lease().acquire(0)
        self.assertEqual(self.rows()[0]["token"], first.token)
        first.release()

    def test_a_live_host_blocks_even_when_its_lease_expired(self):
        first = self.lease().acquire(1)
        self.set_row(lease_until=0, heartbeat_at="2000-01-01T00:00:00.000Z")
        with self.assertRaisesRegex(LockBusy, "in use by"):
            self.lease("other").acquire(0)
        first.release()

    def test_a_dead_host_keeps_the_lease_until_it_is_stale(self):
        first = self.lease().acquire(1)
        self.set_row(host_pid=dead_pid())
        with self.assertRaises(LockBusy):
            self.lease("other").acquire(0)
        self.set_row(lease_until=0)
        second = self.lease("other").acquire(0)
        self.assertEqual((self.rows()[0]["token"], self.rows()[0]["owner_id"]), (second.token, "other"))
        second.release()

    def test_token_aba_the_old_holder_can_neither_renew_nor_release(self):
        old = self.lease().acquire(1)
        self.set_row(host_pid=dead_pid(), lease_until=0)
        new = self.lease("other").acquire(0)
        with self.assertRaises(LeaseLost):
            old.heartbeat()
        self.assertTrue(old.lost.is_set())
        with self.assertRaises(LeaseLost):
            old.register_worker(1, 1, "x")
        self.assertFalse(old.release())
        (row,) = self.rows()
        self.assertEqual((row["token"], row["worker_pid"]), (new.token, None))
        new.heartbeat()
        new.release()

    def test_a_live_worker_group_with_a_dead_leader_blocks_recovery(self):
        gate = subprocess.Popen([sys.executable, "-c", "import subprocess, sys, time; subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); time.sleep(60)"],
                                start_new_session=True)
        self.addCleanup(lambda: pgid_alive(gate.pid) and os.killpg(gate.pid, signal.SIGKILL))
        sleep(0.5)
        self.lease().acquire(1)
        self.set_row(host_pid=dead_pid(), lease_until=0, worker_pid=gate.pid, worker_pgid=gate.pid, worker_ident="w")
        gate.kill()
        gate.wait()
        self.assertFalse(pid_alive(gate.pid))
        self.assertTrue(pgid_alive(gate.pid))
        with self.assertRaisesRegex(LockBusy, rf"worker group {gate.pid} still alive after its holder died"):
            self.lease("other").acquire(0)
        os.killpg(gate.pid, signal.SIGKILL)
        self.assertTrue(self.wait_until(lambda: not pgid_alive(gate.pid)))
        second = self.lease("other").acquire(0)
        self.assertEqual(self.rows()[0]["token"], second.token)
        second.release()


class TestGate(LockCase):
    def gate(self, command, **kwargs) -> tuple[subprocess.Popen, int]:
        control_r, control_w = os.pipe()
        kwargs.setdefault("stdout", subprocess.DEVNULL)
        process = subprocess.Popen([sys.executable, str(GATE), "--lease-worker", "ident-1", "--control-fd", str(control_r), "--", *command],
                                   start_new_session=True, pass_fds=(control_r,), **kwargs)
        os.close(control_r)
        self.addCleanup(lambda: pgid_alive(process.pid) and os.killpg(process.pid, signal.SIGKILL))
        return process, control_w

    def test_eof_before_go_starts_nothing(self):
        process, control = self.gate([sys.executable, "-c", WRITER])
        sleep(0.3)
        self.assertIsNone(process.poll())
        os.close(control)
        self.assertEqual(process.wait(timeout=5), checkout_lock.GATE_NO_GO)
        self.assertFalse(Path(self.log + ".meta").exists())

    def test_go_starts_the_agent_in_the_gate_group_without_the_control_pipe(self):
        os.environ["WRITER_TICKS"] = "3"
        process, control = self.gate([sys.executable, "-c", WRITER], stdout=subprocess.PIPE, text=True)
        os.write(control, b"GO\n")
        stdout, _ = process.communicate(timeout=10)
        self.assertEqual((process.returncode, stdout), (0, "wrote"))
        _, pgid, ppid, _ = self.meta()
        self.assertEqual((pgid, ppid), (process.pid, process.pid))
        os.close(control)

    def test_control_fd_is_closed_for_the_agent(self):
        # The gate passes the control fd number on its own argv only; the agent
        # is spawned with close_fds, so whatever number it was is not open.
        os.environ["WRITER_TICKS"] = "1"
        control_r, control_w = os.pipe()
        os.environ["CONTROL_FD"] = str(control_r)
        process = subprocess.Popen([sys.executable, str(GATE), "--lease-worker", "i", "--control-fd", str(control_r), "--", sys.executable, "-c", WRITER],
                                   start_new_session=True, pass_fds=(control_r,), stdout=subprocess.DEVNULL)
        os.close(control_r)
        os.write(control_w, b"GO\n")
        self.assertEqual(process.wait(timeout=10), 0)
        self.assertEqual(self.meta()[3], "closed")
        os.close(control_w)

    def test_eof_after_go_stops_the_group(self):
        process, control = self.gate([sys.executable, "-c", WRITER])
        os.write(control, b"GO\n")
        self.assertTrue(self.wait_until(lambda: Path(self.log + ".meta").exists()))
        pid = self.meta()[0]
        os.close(control)
        self.assertEqual(process.wait(timeout=10), 128 + signal.SIGTERM)
        self.assertFalse(pid_alive(pid))
        self.assertFalse(pgid_alive(process.pid))
        self.assertTrue(self.writer_stopped())

    def test_sigterm_to_the_gate_stops_the_group(self):
        process, control = self.gate([sys.executable, "-c", WRITER])
        os.write(control, b"GO\n")
        self.assertTrue(self.wait_until(lambda: Path(self.log + ".meta").exists()))
        process.send_signal(signal.SIGTERM)
        self.assertEqual(process.wait(timeout=10), 128 + signal.SIGTERM)
        self.assertFalse(pid_alive(self.meta()[0]))
        self.assertTrue(self.writer_stopped())
        os.close(control)

    def test_lingering_descendants_are_settled_before_the_gate_exits(self):
        os.environ["WRITER_TICKS"] = "2"
        os.environ["WRITER_GRANDCHILD"] = "1"
        process, control = self.gate([sys.executable, "-c", WRITER])
        os.write(control, b"GO\n")
        started = monotonic()
        self.assertEqual(process.wait(timeout=20), 0)
        self.assertLess(monotonic() - started, 15)
        self.assertFalse(pgid_alive(process.pid))
        os.close(control)

    def test_identity_is_visible_on_the_gate_argv(self):
        process, control = self.gate([sys.executable, "-c", WRITER])
        self.assertTrue(checkout_lock.worker_identity_matches(process.pid, "ident-1"))
        self.assertFalse(checkout_lock.worker_identity_matches(process.pid, "ident-2"))
        self.assertFalse(checkout_lock.worker_identity_matches(dead_pid(), "ident-1"))
        self.assertFalse(checkout_lock.worker_identity_matches(os.getpid(), "ident-1"))
        os.close(control)
        process.wait(timeout=5)


class TestRunGated(LockCase):
    def test_registers_the_gate_before_go_and_releases_after_the_group_is_gone(self):
        os.environ["WRITER_TICKS"] = "2"
        lease = self.lease().acquire(1)
        seen = {}
        original = lease.register_worker

        def register(pid, pgid, ident):
            original(pid, pgid, ident)
            (row,) = self.rows()
            seen.update(pid=pid, pgid=pgid, ident=ident, row=dict(row), meta=Path(self.log + ".meta").exists(),
                        identity=checkout_lock.worker_identity_matches(pid, ident))
        lease.register_worker = register
        done = checkout_lock.run_gated(lease, [sys.executable, "-c", WRITER], cwd=self.checkout, env=None, timeout=30)
        self.assertEqual((done.returncode, done.stdout, done.stderr), (0, "wrote", ""))
        self.assertEqual((seen["row"]["worker_pid"], seen["row"]["worker_pgid"], seen["row"]["worker_ident"], seen["row"]["token"]),
                         (seen["pid"], seen["pgid"], seen["ident"], lease.token))
        self.assertEqual((seen["pid"], seen["meta"], seen["identity"]), (seen["pgid"], False, True))
        self.assertEqual(self.meta()[1], seen["pgid"])
        self.assertFalse(pgid_alive(seen["pgid"]))
        self.assertEqual((lease.held, lease.retained, self.rows()), (False, None, []))

    def test_a_gate_killed_after_registration_before_go_starts_nothing(self):
        lease = self.lease().acquire(1)
        original = lease.register_worker

        def register_then_kill(pid, pgid, ident):
            original(pid, pgid, ident)
            os.kill(pid, signal.SIGKILL)
            os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT)
        lease.register_worker = register_then_kill
        with self.assertRaisesRegex(RuntimeError, "gate exited before the agent started"):
            checkout_lock.run_gated(lease, [sys.executable, "-c", WRITER], cwd=self.checkout, env=None, timeout=30)
        sleep(0.3)
        self.assertFalse(Path(self.log + ".meta").exists())
        self.assertEqual(self.rows(), [])

    def test_a_lost_lease_before_registration_starts_nothing(self):
        lease = self.lease().acquire(1)
        self.set_row(token="f" * 32)
        with self.assertRaises(LeaseLost):
            checkout_lock.run_gated(lease, [sys.executable, "-c", WRITER], cwd=self.checkout, env=None, timeout=30)
        sleep(0.3)
        self.assertFalse(Path(self.log + ".meta").exists())
        self.assertEqual(self.rows()[0]["token"], "f" * 32)

    def test_timeout_stops_the_group_and_releases(self):
        lease = self.lease().acquire(1)
        with self.assertRaises(subprocess.TimeoutExpired):
            checkout_lock.run_gated(lease, [sys.executable, "-c", WRITER], cwd=self.checkout, env=None, timeout=1)
        self.assertFalse(pid_alive(self.meta()[0]))
        self.assertTrue(self.writer_stopped())
        self.assertEqual(self.rows(), [])

    def test_losing_the_lease_mid_run_stops_the_agent_and_never_touches_the_new_row(self):
        lease = self.lease().acquire(1)
        with patch.object(checkout_lock, "HEARTBEAT_MS", 200):
            thread_error = []

            def run():
                try:
                    checkout_lock.run_gated(lease, [sys.executable, "-c", WRITER], cwd=self.checkout, env=None, timeout=30)
                except BaseException as error:
                    thread_error.append(error)
            thread = Thread(target=run)
            thread.start()
            self.assertTrue(self.wait_until(lambda: Path(self.log + ".meta").exists()))
            self.set_row(token="e" * 32, owner_label="chat \"y\" (Poise production)")
            thread.join(timeout=15)
        self.assertFalse(thread.is_alive())
        self.assertIsInstance(thread_error[0], LeaseLost)
        self.assertFalse(pid_alive(self.meta()[0]))
        (row,) = self.rows()
        self.assertEqual((row["token"], row["owner_label"]), ("e" * 32, "chat \"y\" (Poise production)"))

    def test_normal_completion_settles_grandchildren_before_release(self):
        os.environ["WRITER_TICKS"] = "2"
        os.environ["WRITER_GRANDCHILD"] = "1"
        lease = self.lease().acquire(1)
        done = checkout_lock.run_gated(lease, [sys.executable, "-c", WRITER], cwd=self.checkout, env=None, timeout=30)
        self.assertEqual(done.returncode, 0)
        self.assertFalse(pgid_alive(self.meta()[1]))
        self.assertEqual(self.rows(), [])

    def test_a_group_that_will_not_die_keeps_the_lease(self):
        lease = self.lease().acquire(1)
        with patch.object(checkout_lock, "pgid_alive", return_value=True):
            with self.assertRaisesRegex(WorkerOrphaned, "orphan requiring intervention: worker group .* lease retained"):
                checkout_lock.run_gated(lease, [sys.executable, "-c", "print('ok')"], cwd=self.checkout, env=None, timeout=30)
        self.assertEqual((lease.held, len(self.rows())), (False, 1))
        self.assertEqual(self.rows()[0]["token"], lease.token)


class TestHolderDeath(LockCase):
    def test_holder_sigkill_during_a_write_stops_the_group_and_blocks_takeover_until_stale(self):
        holder, token = self.holder()
        pid, pgid, _, _ = self.meta()
        holder.kill()
        holder.wait()
        self.assertTrue(self.wait_until(lambda: not pid_alive(pid) and not pgid_alive(pgid), 10))
        self.assertTrue(self.writer_stopped())
        (row,) = self.rows()
        self.assertEqual((row["token"], row["worker_pgid"]), (token, pgid))
        with self.assertRaisesRegex(LockBusy, "in use by fix-failing-ci o/r#1 \\(call holder-c\\)"):
            self.lease("other").acquire(0)
        self.set_row(lease_until=0)
        lease = self.lease("other").acquire(0)
        self.assertEqual(self.rows()[0]["token"], lease.token)
        lease.release()

    def test_holder_sigterm_stops_the_group_and_releases(self):
        holder, _ = self.holder()
        pid, pgid, _, _ = self.meta()
        holder.send_signal(signal.SIGTERM)
        self.assertEqual(holder.wait(timeout=15), 128 + signal.SIGTERM)
        self.assertFalse(pid_alive(pid))
        self.assertFalse(pgid_alive(pgid))
        self.assertTrue(self.writer_stopped())
        self.assertEqual(self.rows(), [])


class TestFixFailingCi(LockCase):
    def setUp(self):
        super().setUp()
        self.record = str(Path(self.work.name, "claude.json"))
        fake = Path(self.work.name, "claude")
        fake.write_text(f"""#!{sys.executable}
import json, os, sqlite3, subprocess, sys
from agent_interface import checkout_lock
row = dict(checkout_lock.connect(checkout_lock.lock_path(os.getcwd())).execute("select * from lease").fetchone())
parent = subprocess.run(["ps", "-o", "command=", "-p", str(os.getppid())], text=True, capture_output=True).stdout
json.dump({{"argv": sys.argv[1:], "cwd": os.getcwd(), "row": row, "pgid": os.getpgid(0), "parent": parent,
           "guard": os.environ.get("CLAUDE_CODE_SHELL_PREFIX")}}, open({self.record!r}, "w"))
if os.environ.get("FAKE_FAIL"):
    sys.stderr.write("provider broke"); sys.exit(2)
sys.stdout.write(" fixed tests \\n")
""")
        fake.chmod(0o755)
        os.environ["CLAUDE_CLI"] = str(fake)
        self.addCleanup(os.environ.pop, "CLAUDE_CLI", None)

    def test_runs_the_unchanged_agent_command_under_a_call_named_lease(self):
        response = fix_failing_ci.run(self.checkout, "https://github.com/o/r/pull/7", "remember", timeout_s=30, call_id="c" * 32)
        self.assertEqual(response, "fixed tests")
        recorded = json.load(open(self.record))
        tools = fix_failing_ci.allowed("#7")
        model = CATALOG.behavior("fix_failing_ci")
        self.assertEqual(recorded["argv"], [
            "--print", "--model", model.selector, "--effort", model.effort, "--permission-mode", "dontAsk",
            "--setting-sources", "", "--tools", "Bash", "--no-session-persistence", "--allowedTools", *tools,
            "--settings", json.dumps({"permissions": {"allow": tools}, "defaultMode": "dontAsk"}),
            "--system-prompt", fix_failing_ci.SYSTEM, fix_failing_ci.prompt(fix_failing_ci.command("#7"), tools, "remember"),
        ])
        self.assertEqual(recorded["cwd"], os.path.realpath(self.checkout))
        self.assertTrue(recorded["guard"].endswith("bash_guard.py"))
        row = recorded["row"]
        self.assertEqual((row["owner_kind"], row["owner_id"], row["owner_label"], row["instance"], row["host_pid"], row["worker_pgid"]),
                         ("caller:fix-failing-ci", "c" * 32, "fix-failing-ci o/r#7 (call cccccccc)", f"caller:{os.getpid()}", os.getpid(), recorded["pgid"]))
        self.assertIn(f"--lease-worker {row['worker_ident']}", recorded["parent"])
        self.assertEqual(self.rows(), [])

    def test_a_failing_agent_reports_stderr_and_releases(self):
        os.environ["FAKE_FAIL"] = "1"
        self.addCleanup(os.environ.pop, "FAKE_FAIL", None)
        with self.assertRaisesRegex(RuntimeError, "provider broke"):
            fix_failing_ci.run(self.checkout, "#7", timeout_s=30)
        self.assertEqual(self.rows(), [])

    def test_a_busy_checkout_fails_naming_the_holder_without_launching(self):
        other = Lease(self.checkout, "sess", 'chat "fix ci" on chat/x (Poise dev)').acquire(1)
        with self.assertRaisesRegex(LockBusy, 'in use by chat "fix ci" on chat/x \\(Poise dev\\); gave up after 0s'):
            fix_failing_ci.run(self.checkout, "#7", timeout_s=30, lock_wait_s=0)
        self.assertFalse(Path(self.record).exists())
        self.assertEqual(self.rows()[0]["token"], other.token)
        other.release()

    def test_without_a_call_id_the_owner_is_a_fresh_uuid(self):
        fix_failing_ci.run(self.checkout, "#7", timeout_s=30)
        row = json.load(open(self.record))["row"]
        self.assertRegex(row["owner_id"], r"^[0-9a-f]{32}$")
        self.assertEqual(row["owner_label"], f"fix-failing-ci repo#7 (call {row['owner_id'][:8]})")

    def test_the_cli_behavior_names_its_lease_after_the_calls_row(self):
        data = Path(self.work.name, "data")
        with patch.object(agent_interface, "DATA_DIR", data), patch.object(agent_interface, "DB", data / "calls.sqlite3"), \
                patch.object(agent_interface, "RESPONSES", data / "responses"), patch("sys.stdout"):
            agent_interface.init_db()
            agent_interface.run_fix_failing_ci("#7", self.checkout)
            (entry,) = agent_interface.logs()
        row = json.load(open(self.record))["row"]
        self.assertEqual((row["owner_id"], entry["status"], entry["behavior"]), (entry["id"], "completed", "fix_failing_ci"))
        self.assertEqual(self.rows(), [])
