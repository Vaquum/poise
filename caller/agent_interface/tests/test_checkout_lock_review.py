"""Regressions for the coordinator review of checkout_lock.py / lease_gate.py,
plus contention against Poise's real TypeScript lock and gate."""
import json
import os
import shutil
import signal
import sqlite3
import subprocess
import sys
from pathlib import Path
from threading import Event, Thread, Timer
from time import monotonic, sleep, time as wall
from unittest import skipUnless
from unittest.mock import patch

from agent_interface import checkout_lock
from agent_interface.checkout_lock import Lease, LeaseLost, LockBusy, pgid_alive, pid_alive

from test_checkout_lock import GATE, WRITER, LockCase, dead_pid

# The Poise this Caller lives in: caller/agent_interface/tests -> the repository root.
POISE_DIR = Path(os.environ.get("POISE_DIR") or Path(__file__).resolve().parents[3])
NODE = shutil.which("node", path="/opt/homebrew/opt/node@22/bin:" + os.environ.get("PATH", "")) or ""
POISE_LOCK = POISE_DIR / "server" / "chat" / "checkout-lock.ts"
POISE_GATE = POISE_DIR / "scripts" / "chat-worker-gate.mjs"
FIXTURES = Path(__file__).resolve().parent / "fixtures"

# A writer whose grandchild ignores SIGTERM and outlives it.
STUBBORN_GRANDCHILD = """
import os, signal, subprocess, sys, time
log = os.environ["WRITER_LOG"]
child = subprocess.Popen([sys.executable, "-c",
    "import os, signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN)\\n"
    "open(os.environ['WRITER_LOG'] + '.grandchild', 'w').write(str(os.getpid()))\\n"
    "time.sleep(120)"])
with open(log + ".meta", "w") as meta:
    meta.write(f"{os.getpid()} {os.getpgid(0)} {os.getppid()} unset {child.pid}")
sys.stdout.write("wrote")
"""

# A leader that dies the instant it is told to stop, leaving a stubborn child.
FRAGILE_LEADER = """
import os, signal, subprocess, sys, time
child = subprocess.Popen([sys.executable, "-c",
    "import os, signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN)\\n"
    "open(os.environ['WRITER_LOG'] + '.grandchild', 'w').write(str(os.getpid()))\\n"
    "time.sleep(120)"])
open(os.environ["WRITER_LOG"] + ".meta", "w").write(f"{os.getpid()} {os.getpgid(0)} {os.getppid()} unset {child.pid}")
time.sleep(120)
"""


def trigger(path: Path, sql: str):
    conn = sqlite3.connect(path)
    conn.execute(sql)
    conn.commit()
    conn.close()


class TestAcquireAbort(LockCase):
    def test_an_already_aborted_wait_never_acquires(self):
        abort = Event()
        abort.set()
        lease = self.lease()
        with self.assertRaisesRegex(LockBusy, "aborted"):
            lease.acquire(5, abort=abort)
        self.assertEqual((lease.held, self.rows()), (False, []))

    def test_abort_interrupts_the_wait_at_once(self):
        holder = self.lease().acquire(1)
        abort = Event()
        Timer(0.2, abort.set).start()
        started = monotonic()
        with self.assertRaisesRegex(LockBusy, r'in use by fix-failing-ci o/r#1 \(call call-1\); aborted'):
            self.lease("other").acquire(30, abort=abort)
        self.assertLess(monotonic() - started, checkout_lock.POLL_SECONDS)
        self.assertEqual(self.rows()[0]["token"], holder.token)
        holder.release()


class TestHeartbeatFailure(LockCase):
    def test_a_heartbeat_that_cannot_renew_signals_loss(self):
        lease = self.lease().acquire(1)
        trigger(lease.path, "create trigger fail before update on lease begin select raise(abort, 'injected'); end")
        try:
            with patch.object(checkout_lock, "HEARTBEAT_MS", 100):
                lease.start_heartbeat()
                self.assertTrue(lease.lost.wait(5))
        finally:
            trigger(lease.path, "drop trigger fail")
        self.assertFalse(lease.held)
        with self.assertRaisesRegex(LeaseLost, "no longer held"):
            lease.register_worker(1, 1, "x")
        self.assertFalse(lease.release())
        self.assertEqual(self.rows()[0]["token"], lease.token)

    def test_a_heartbeat_that_cannot_open_the_lock_signals_loss(self):
        lease = self.lease().acquire(1)
        with patch.object(checkout_lock, "connect", side_effect=sqlite3.OperationalError("disk gone")), \
                patch.object(checkout_lock, "HEARTBEAT_MS", 100):
            lease.start_heartbeat()
            self.assertTrue(lease.lost.wait(5))
        self.assertFalse(lease.held)

    def test_a_lost_heartbeat_stops_the_agent_under_run_gated(self):
        lease = self.lease().acquire(1)
        errors = []

        def run():
            try:
                checkout_lock.run_gated(lease, [sys.executable, "-c", WRITER], cwd=self.checkout, env=None, timeout=30)
            except BaseException as error:
                errors.append(error)
        with patch.object(checkout_lock, "HEARTBEAT_MS", 200):
            thread = Thread(target=run)
            thread.start()
            self.assertTrue(self.wait_until(lambda: Path(self.log + ".meta").exists()))
            trigger(lease.path, "create trigger fail before update on lease begin select raise(abort, 'injected'); end")
            thread.join(15)
            trigger(lease.path, "drop trigger fail")
        self.assertFalse(thread.is_alive())
        self.assertIsInstance(errors[0], LeaseLost)
        self.assertFalse(pid_alive(self.meta()[0]))


class TestStopGroupIdentity(LockCase):
    def test_the_leader_stays_unreaped_until_after_the_final_kill(self):
        process = subprocess.Popen([sys.executable, "-c", FRAGILE_LEADER], start_new_session=True)
        self.addCleanup(lambda: pgid_alive(process.pid) and os.killpg(process.pid, signal.SIGKILL))
        self.assertTrue(self.wait_until(lambda: Path(self.log + ".grandchild").exists()))
        grandchild = int(Path(self.log + ".grandchild").read_text())
        seen = []
        real_killpg = os.killpg

        def killpg(pgid, sig):
            seen.append((sig, checkout_lock._exited_unreaped(pgid), pgid_alive(pgid)))
            return real_killpg(pgid, sig)
        started = monotonic()
        with patch.object(checkout_lock.os, "killpg", killpg), patch.object(checkout_lock, "STOP_GRACE_SECONDS", 2.0):
            checkout_lock._stop_group(process)
        self.assertGreaterEqual(monotonic() - started, 2.0)
        self.assertEqual([sig for sig, _, _ in seen], [signal.SIGTERM, signal.SIGKILL])
        # At SIGKILL time the leader had exited (it died on SIGTERM) but was
        # still ours, unreaped; the group id could not have been reused.
        self.assertEqual(seen[1][1:], (True, True))
        self.assertTrue(self.wait_until(lambda: not pid_alive(grandchild)))
        self.assertFalse(pgid_alive(process.pid))

    def test_an_unlistable_group_waits_out_the_grace(self):
        process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True)
        self.addCleanup(lambda: pgid_alive(process.pid) and os.killpg(process.pid, signal.SIGKILL))
        started = monotonic()
        with patch.object(checkout_lock, "group_members", return_value=None), patch.object(checkout_lock, "STOP_GRACE_SECONDS", 1.0):
            checkout_lock._stop_group(process)
        self.assertGreaterEqual(monotonic() - started, 1.0)
        self.assertFalse(pgid_alive(process.pid))

    def test_group_members_lists_only_that_group_without_the_leader(self):
        process = subprocess.Popen([sys.executable, "-c", "import subprocess, sys, time; subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)']); time.sleep(30)"],
                                   start_new_session=True)
        self.addCleanup(lambda: pgid_alive(process.pid) and os.killpg(process.pid, signal.SIGKILL))
        self.assertTrue(self.wait_until(lambda: len(checkout_lock.group_members(process.pid) or []) == 1))
        (child,) = checkout_lock.group_members(process.pid)
        self.assertNotEqual(child, process.pid)
        self.assertEqual(os.getpgid(child), process.pid)
        with patch.object(checkout_lock.subprocess, "run", side_effect=OSError("no ps")):
            self.assertIsNone(checkout_lock.group_members(process.pid))


class TestIdentity(LockCase):
    def test_identity_requests_an_untruncated_process_command(self):
        expected = f"{sys.executable} {GATE} --lease-worker identity --control-fd 3 -- true"
        result = subprocess.CompletedProcess([], 0, stdout=expected, stderr="")
        with patch.object(checkout_lock, "pid_alive", return_value=True), patch.object(checkout_lock.subprocess, "run", return_value=result) as run:
            self.assertTrue(checkout_lock.worker_identity_matches(123, "identity"))
        self.assertEqual(run.call_args.args[0], ["ps", "-ww", "-o", "command=", "-p", "123"])

    def test_only_the_gate_script_with_the_exact_ident_argument_matches(self):
        control_r, control_w = os.pipe()
        gate = subprocess.Popen([sys.executable, str(GATE), "--lease-worker", "id-1", "--control-fd", str(control_r), "--", "true"],
                                start_new_session=True, pass_fds=(control_r,))
        os.close(control_r)
        impostors = [
            subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)", "--lease-worker", "id-1", "--", "x"]),
            subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)", str(GATE), "--lease-worker-x", "id-1"]),
            subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)", str(GATE), "--lease-worker", "id-10"]),
            subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)", "--lease-worker", "id-1", str(GATE)]),
        ]
        for process in impostors:
            self.addCleanup(process.kill)
        try:
            sleep(0.3)
            self.assertTrue(checkout_lock.worker_identity_matches(gate.pid, "id-1"))
            self.assertFalse(checkout_lock.worker_identity_matches(gate.pid, "id-"))
            for process in impostors:
                with self.subTest(process.args):
                    self.assertFalse(checkout_lock.worker_identity_matches(process.pid, "id-1"))
            self.assertFalse(checkout_lock.worker_identity_matches(dead_pid(), "id-1"))
            with patch.object(checkout_lock.subprocess, "run", side_effect=subprocess.TimeoutExpired("ps", 5)):
                self.assertFalse(checkout_lock.worker_identity_matches(gate.pid, "id-1"))
        finally:
            os.close(control_w)
            gate.wait(timeout=5)


class TestGateStatus(LockCase):
    def gate(self, command, status=True, **kwargs):
        control_r, control_w = os.pipe()
        status_r, status_w = os.pipe()
        args = [sys.executable, str(GATE), "--lease-worker", "ident-1", "--control-fd", str(control_r)]
        if status:
            args += ["--status-fd", str(status_w)]
        process = subprocess.Popen([*args, "--", *command], start_new_session=True, pass_fds=(control_r, status_w),
                                   stdout=subprocess.DEVNULL, **kwargs)
        os.close(control_r)
        os.close(status_w)
        self.addCleanup(lambda: pgid_alive(process.pid) and os.killpg(process.pid, signal.SIGKILL))
        return process, control_w, status_r

    def test_an_agent_that_exits_3_is_not_mistaken_for_no_go(self):
        lease = self.lease().acquire(1)
        done = checkout_lock.run_gated(lease, [sys.executable, "-c", "import sys; sys.stdout.write('ran'); sys.exit(3)"],
                                       cwd=self.checkout, env=None, timeout=30)
        self.assertEqual((done.returncode, done.stdout), (3, "ran"))
        self.assertEqual(self.rows(), [])

    def test_started_is_reported_only_when_the_agent_was_spawned(self):
        process, control, status = self.gate(["true"])
        os.close(control)
        self.assertEqual(process.wait(timeout=5), checkout_lock.GATE_NO_GO)
        self.assertEqual(os.read(status, 64), b"")
        os.close(status)
        process, control, status = self.gate(["true"])
        os.write(control, b"GO\n")
        self.assertEqual(process.wait(timeout=5), 0)
        self.assertEqual(os.read(status, 64), b"STARTED\n")
        os.close(control)
        os.close(status)

    def test_a_gate_killed_after_go_before_spawning_reports_no_agent(self):
        lease = self.lease().acquire(1)
        original = lease.register_worker

        def register_then_stop(pid, pgid, ident):
            original(pid, pgid, ident)
            os.kill(pid, signal.SIGSTOP)
            Timer(0.3, lambda: os.kill(pid, signal.SIGKILL)).start()
        lease.register_worker = register_then_stop
        with self.assertRaisesRegex(RuntimeError, "gate exited before the agent started"):
            checkout_lock.run_gated(lease, [sys.executable, "-c", WRITER], cwd=self.checkout, env=None, timeout=30)
        self.assertFalse(Path(self.log + ".meta").exists())
        self.assertEqual(self.rows(), [])

    def test_the_agent_inherits_neither_pipe(self):
        os.environ["WRITER_TICKS"] = "1"
        control_r, control_w = os.pipe()
        status_r, status_w = os.pipe()
        os.environ["CONTROL_FD"] = str(status_w)
        process = subprocess.Popen([sys.executable, str(GATE), "--lease-worker", "i", "--control-fd", str(control_r),
                                    "--status-fd", str(status_w), "--", sys.executable, "-c", WRITER],
                                   start_new_session=True, pass_fds=(control_r, status_w), stdout=subprocess.DEVNULL)
        os.close(control_r)
        os.close(status_w)
        os.write(control_w, b"GO\n")
        self.assertEqual(process.wait(timeout=10), 0)
        self.assertEqual(self.meta()[3], "closed")
        os.close(control_w)
        os.close(status_r)

    def test_sigint_and_sighup_stop_the_group(self):
        for sig in (signal.SIGINT, signal.SIGHUP):
            with self.subTest(sig):
                for name in (self.log, self.log + ".meta"):
                    Path(name).unlink(missing_ok=True)
                process, control, status = self.gate([sys.executable, "-c", WRITER])
                os.write(control, b"GO\n")
                self.assertTrue(self.wait_until(lambda: Path(self.log + ".meta").exists()))
                process.send_signal(sig)
                self.assertEqual(process.wait(timeout=10), 128 + signal.SIGTERM)
                self.assertFalse(pid_alive(self.meta()[0]))
                self.assertFalse(pgid_alive(process.pid))
                self.assertTrue(self.writer_stopped())
                os.close(control)
                os.close(status)

    def test_a_term_ignoring_grandchild_is_killed_before_the_gate_exits(self):
        process, control, status = self.gate([sys.executable, "-c", STUBBORN_GRANDCHILD])
        os.write(control, b"GO\n")
        started = monotonic()
        self.assertEqual(process.wait(timeout=30), 0)
        elapsed = monotonic() - started
        grandchild = int(Path(self.log + ".grandchild").read_text())
        self.assertGreaterEqual(elapsed, 5.0)
        self.assertFalse(pid_alive(grandchild))
        self.assertFalse(pgid_alive(process.pid))
        os.close(control)
        os.close(status)

    def test_run_gated_releases_only_after_the_stubborn_grandchild_is_gone(self):
        lease = self.lease().acquire(1)
        done = checkout_lock.run_gated(lease, [sys.executable, "-c", STUBBORN_GRANDCHILD], cwd=self.checkout, env=None, timeout=40)
        self.assertEqual((done.returncode, done.stdout), (0, "wrote"))
        self.assertFalse(pid_alive(int(Path(self.log + ".grandchild").read_text())))
        self.assertEqual((lease.retained, self.rows()), (None, []))

    def test_an_unlistable_group_is_never_reported_settled(self):
        # ps fails for the first second; the gate must keep waiting, not exit.
        bin_dir = Path(self.work.name, "bin")
        bin_dir.mkdir()
        stamp = Path(self.work.name, "ps-fails-until")
        fake = bin_dir / "ps"
        fake.write_text(f"""#!{sys.executable}
import os, sys, time
if time.time() < float(open({str(stamp)!r}).read()):
    sys.exit(1)
os.execv({shutil.which("ps")!r}, ["ps", *sys.argv[1:]])
""")
        fake.chmod(0o755)
        stamp.write_text(str(wall() + 1.5))
        with patch.dict(os.environ, {"PATH": f"{bin_dir}:{os.environ['PATH']}"}):
            process, control, status = self.gate(["true"])
            os.write(control, b"GO\n")
            started = monotonic()
            self.assertEqual(process.wait(timeout=30), 0)
        self.assertGreaterEqual(monotonic() - started, 1.2)
        os.close(control)
        os.close(status)


class TestTokenAcrossHolds(LockCase):
    def test_a_new_hold_gets_a_new_token_and_the_old_one_is_dead(self):
        lease = self.lease()
        lease.acquire(1)
        first = lease.token
        lease.release()
        lease.acquire(1)
        second = lease.token
        self.assertNotEqual(first, second)
        self.assertEqual(self.rows()[0]["token"], second)
        conn = checkout_lock.connect(lease.path)
        self.assertEqual(conn.execute("update lease set lease_until = 0 where id = 1 and token = ?", (first,)).rowcount, 0)
        conn.close()
        stale = Lease(self.checkout, "call-1", "stale copy")
        stale.token = first
        stale.held = True
        with self.assertRaises(LeaseLost):
            stale.heartbeat()
        self.assertFalse(stale.release())
        self.assertEqual(self.rows()[0]["token"], second)
        lease.heartbeat()
        self.assertTrue(lease.release())

    def test_re_entry_keeps_the_token_only_while_held(self):
        lease = self.lease().acquire(1)
        token = lease.token
        self.assertIs(lease.acquire(1), lease)
        self.assertEqual((lease.token, self.rows()[0]["token"]), (token, token))
        lease.release()


@skipUnless(NODE and POISE_LOCK.exists() and POISE_GATE.exists(), "Poise checkout with its TypeScript lock and node are required")
class TestAgainstPoiseTypeScript(LockCase):
    """Contention against Poise's real server/chat/checkout-lock.ts and
    scripts/chat-worker-gate.mjs, read-only, in a temporary lock directory."""

    def node(self, *args, **kwargs) -> subprocess.Popen:
        env = {**os.environ, "POISE_DIR": str(POISE_DIR), "NODE_OPTIONS": ""}
        return subprocess.Popen([NODE, "--experimental-transform-types", "--no-warnings", "--import", str(FIXTURES / "poise-ts-resolver.mjs"),
                                 str(FIXTURES / "poise-lock-holder.mjs"), *args], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, **kwargs)

    def ts(self, *args) -> str:
        process = self.node(*args)
        out, err = process.communicate(timeout=60)
        self.assertEqual(process.returncode, 0, err)
        return out.strip()

    def test_both_sides_use_the_same_file_and_see_each_others_rows(self):
        link = Path(self.work.name, "link")
        link.symlink_to(self.checkout)
        python = self.lease().acquire(1)
        self.assertEqual(self.ts("try", str(link)), 'busy live_host false fix-failing-ci o/r#1 (call call-1)')
        row = json.loads(self.ts("read", self.checkout))
        self.assertEqual((row["token"], row["owner_kind"], row["instance"], row["host_pid"]),
                         (python.token, "caller:fix-failing-ci", f"caller:{os.getpid()}", os.getpid()))
        python.release()
        self.assertRegex(self.ts("try", self.checkout), r"^acquired [0-9a-f]{32}$")
        self.assertEqual(self.rows(), [])
        self.assertEqual(sorted(Path(self.lockdir).iterdir()), [checkout_lock.lock_path(self.checkout)])

    def test_python_waits_behind_a_typescript_holder_and_takes_over_when_it_releases(self):
        holder = self.node("acquire", self.checkout, "2.5")
        self.addCleanup(lambda: holder.poll() is None and holder.kill())
        self.assertRegex(holder.stdout.readline().strip(), r"^acquired [0-9a-f]{32}$")
        with self.assertRaisesRegex(LockBusy, r'in use by chat "ts" on chat/x \(Poise dev\); gave up after 0s'):
            self.lease().acquire(0.2)
        row = self.rows()[0]
        self.assertEqual((row["owner_kind"], row["instance"], row["worker_pid"]), ("poise:chat", "poise-dev:interop", None))
        lease = self.lease().acquire(10)
        self.assertEqual(holder.stdout.readline().strip(), "released")
        self.assertEqual(holder.wait(timeout=10), 0)
        self.assertEqual(self.rows()[0]["token"], lease.token)
        lease.release()

    def test_typescript_sees_a_python_stale_row_the_same_way(self):
        python = self.lease().acquire(1)
        self.set_row(lease_until=0)
        self.assertEqual(self.ts("try", self.checkout), 'busy live_host false fix-failing-ci o/r#1 (call call-1)')
        self.set_row(host_pid=dead_pid(), lease_until=int(wall() * 1000) + 60_000)
        self.assertEqual(self.ts("try", self.checkout), 'busy lease_valid false fix-failing-ci o/r#1 (call call-1)')
        self.set_row(lease_until=0)
        self.assertRegex(self.ts("try", self.checkout), r"^acquired [0-9a-f]{32}$")
        with self.assertRaises(LeaseLost):
            python.heartbeat()

    def test_python_blocks_on_a_live_poise_gate_group_after_its_holder_died(self):
        control_r, control_w = os.pipe()
        # Poise's gate reads its control pipe on fd 3; a trampoline puts it there and execs node.
        gate = subprocess.Popen([sys.executable, "-c", "import os, sys; os.dup2(int(sys.argv[1]), 3); os.execv(sys.argv[2], sys.argv[2:])",
                                 str(control_r), NODE, str(POISE_GATE), "--lease-worker", "poise-ident", "--", "sleep", "60"],
                                start_new_session=True, pass_fds=(control_r,), stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env={**os.environ, "NODE_OPTIONS": ""})
        os.close(control_r)
        self.addCleanup(lambda: gate.poll() is None and os.killpg(gate.pid, signal.SIGKILL))
        os.write(control_w, b"GO\n")
        self.assertTrue(self.wait_until(lambda: len(checkout_lock.group_members(gate.pid) or []) >= 1))
        holder = self.node("acquire", self.checkout, "30")
        self.addCleanup(lambda: holder.poll() is None and holder.kill())
        self.assertRegex(holder.stdout.readline().strip(), r"^acquired")
        holder.kill()
        holder.wait()
        self.set_row(lease_until=0, worker_pid=gate.pid, worker_pgid=gate.pid, worker_ident="poise-ident")
        with self.assertRaisesRegex(LockBusy, rf"worker group {gate.pid} still alive after its holder died"):
            self.lease().acquire(0)
        os.close(control_w)
        # Poise's gate tears its group down on control EOF; reaped, the group is gone.
        self.assertEqual(gate.wait(timeout=15), 128 + signal.SIGTERM)
        self.assertTrue(self.wait_until(lambda: not pgid_alive(gate.pid), 5))
        lease = self.lease().acquire(0)
        self.assertEqual(self.ts("try", self.checkout), 'busy live_host false fix-failing-ci o/r#1 (call call-1)')
        lease.release()
