"""Per-checkout writer lease shared with Poise (poise-contract.md §1).

One SQLite file per repository checkout under ~/.poise/locks, one row, held by
whoever mutates that checkout: a Poise Chat turn or Caller's fix-failing-ci
worker. The acquisition token is the only re-entry key; a live holder process
always blocks; a stale row is recovered only when nothing in its registered
worker group lives. The native agent never runs outside a registered group.
"""
from __future__ import annotations

import hashlib
import os
import re
import signal
import sqlite3
import subprocess
import sys
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryFile
from threading import Event, Thread, current_thread, main_thread
from time import monotonic, sleep, time
from uuid import uuid4

LEASE_MS = 90_000
HEARTBEAT_MS = 20_000
POLL_SECONDS = 1.0
BUSY_TIMEOUT_SECONDS = 10.0
STOP_GRACE_SECONDS = 5.0
PS_TIMEOUT_SECONDS = 5.0
ACQUIRE_WAIT_SECONDS = 300.0
OWNER_KIND = "caller:fix-failing-ci"
GATE = Path(__file__).with_name("lease_gate.py")
GATE_NO_GO = 3  # the gate's exit status when it never received GO
SCHEMA = """create table if not exists lease (
  id             integer primary key check (id = 1),
  token          text    not null,
  checkout       text    not null,
  owner_kind     text    not null,
  owner_id       text    not null,
  owner_label    text    not null,
  instance       text    not null,
  host_pid       integer not null,
  worker_pid     integer,
  worker_pgid    integer,
  worker_ident   text,
  branch         text,
  acquired_at    text    not null,
  heartbeat_at   text    not null,
  lease_until    integer not null
)"""


class LockBusy(RuntimeError):
    pass


class LeaseLost(RuntimeError):
    pass


class WorkerOrphaned(RuntimeError):
    pass


def lock_dir() -> Path:
    directory = Path(os.getenv("POISE_LOCK_DIR") or Path.home() / ".poise" / "locks")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    return directory


def canonical(checkout: str) -> str:
    return os.path.realpath(checkout)


def lock_path(checkout: str) -> Path:
    key = hashlib.sha256(canonical(checkout).encode("utf-8")).hexdigest()[:32]
    return lock_dir() / f"checkout-{key}.sqlite3"


def connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path, timeout=BUSY_TIMEOUT_SECONDS, isolation_level=None)
    conn.row_factory = sqlite3.Row
    os.chmod(path, 0o600)
    conn.execute(SCHEMA)
    return conn


def stamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def now_ms() -> int:
    return int(time() * 1000)


def pid_alive(pid: int | None) -> bool:
    if not pid or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def pgid_alive(pgid: int | None) -> bool:
    """A live group is a live worker even when its leader is gone."""
    if not pgid or pgid <= 0:
        return False
    try:
        os.kill(-pgid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def worker_identity_matches(pid: int | None, ident: str | None) -> bool:
    """Whether `pid` is still our gate: its command line must name the gate
    script and carry exactly `--lease-worker <ident>` after it. Anything else
    (pid reuse, unreadable table, a substring inside another argument) is no."""
    if not pid or not ident or not pid_alive(pid):
        return False
    try:
        done = subprocess.run(["ps", "-ww", "-o", "command=", "-p", str(pid)], text=True, capture_output=True, timeout=PS_TIMEOUT_SECONDS)
    except (OSError, subprocess.TimeoutExpired):
        return False
    if done.returncode != 0:
        return False
    line = done.stdout.strip()
    gate = line.find(f"{GATE} ")
    marker = re.search(rf"(?:^|\s)--lease-worker {re.escape(ident)}(?:\s|$)", line)
    return gate >= 0 and marker is not None and marker.start() > gate


def group_members(pgid: int) -> list[int] | None:
    """Pids in `pgid` other than the leader; None when they cannot be listed
    (which callers must read as "members present, unknown")."""
    try:
        done = subprocess.run(["ps", "-eo", "pid=,pgid="], text=True, capture_output=True,
                              timeout=PS_TIMEOUT_SECONDS, start_new_session=True)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if done.returncode != 0:
        return None
    members = []
    for line in done.stdout.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit() and int(parts[1]) == pgid and int(parts[0]) != pgid:
            members.append(int(parts[0]))
    return members


def try_acquire(
    conn: sqlite3.Connection,
    checkout: str,
    token: str,
    owner_kind: str,
    owner_id: str,
    owner_label: str,
    instance: str,
    branch: str | None = None,
) -> tuple[str, sqlite3.Row | None]:
    """One immediate transaction: 'acquired', 'busy' or 'orphan', with the row seen."""
    now = now_ms()
    mine = (token, checkout, owner_kind, owner_id, owner_label, instance, os.getpid(), branch, stamp(), stamp(), now + LEASE_MS)
    conn.execute("begin immediate")
    try:
        row = conn.execute("select * from lease where id = 1").fetchone()
        if row is None:
            conn.execute(
                """insert into lease (id, token, checkout, owner_kind, owner_id, owner_label, instance, host_pid,
                                      branch, acquired_at, heartbeat_at, lease_until)
                   values (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                mine,
            )
            return "acquired", None
        if row["token"] == token:
            conn.execute("update lease set heartbeat_at = ?, lease_until = ? where id = 1 and token = ?",
                         (stamp(), now + LEASE_MS, token))
            return "acquired", row
        if pid_alive(row["host_pid"]) or row["lease_until"] >= now:
            return "busy", row
        if pgid_alive(row["worker_pgid"]) or pid_alive(row["worker_pid"]):
            return "orphan", row
        conn.execute(
            """update lease set token = ?, checkout = ?, owner_kind = ?, owner_id = ?, owner_label = ?, instance = ?,
                   host_pid = ?, worker_pid = null, worker_pgid = null, worker_ident = null, branch = ?,
                   acquired_at = ?, heartbeat_at = ?, lease_until = ?
               where id = 1""",
            mine,
        )
        return "acquired", row
    finally:
        conn.execute("commit")


class Lease:
    """Caller's hold on one checkout: acquire with a deadline, register the
    gate, heartbeat from a thread, release only when the worker has settled."""

    def __init__(self, checkout: str, owner_id: str, owner_label: str, branch: str | None = None):
        self.checkout = canonical(checkout)
        self.owner_id = owner_id
        self.owner_label = owner_label
        self.branch = branch
        self.token = uuid4().hex
        self.instance = f"caller:{os.getpid()}"
        self.path = lock_path(checkout)
        self.held = False
        self.retained: str | None = None
        self.lost = Event()
        self._stop = Event()
        self._thread: Thread | None = None

    def acquire(self, timeout: float = ACQUIRE_WAIT_SECONDS, abort: Event | None = None) -> "Lease":
        """Wait up to `timeout` for the checkout; `abort` ends the wait early
        and is honoured before the first attempt. Each new hold gets a fresh
        token — only a hold still in hand re-enters with its own."""
        if abort is not None and abort.is_set():
            raise LockBusy(f"checkout {self.checkout} was not acquired; aborted")
        if not self.held:
            self.token = uuid4().hex
            self.retained = None
            self.lost = Event()
            self._stop = Event()
        deadline = monotonic() + timeout
        conn = connect(self.path)
        try:
            while True:
                state, row = try_acquire(conn, self.checkout, self.token, OWNER_KIND, self.owner_id,
                                         self.owner_label, self.instance, self.branch)
                if state == "acquired":
                    self.held = True
                    return self
                assert row is not None
                holder = row["owner_label"]
                if state == "orphan":
                    holder += f" (worker group {row['worker_pgid']} still alive after its holder died)"
                if monotonic() >= deadline:
                    raise LockBusy(f"checkout {self.checkout} is in use by {holder}; gave up after {int(timeout)}s")
                if abort is None:
                    sleep(POLL_SECONDS)
                elif abort.wait(POLL_SECONDS):
                    raise LockBusy(f"checkout {self.checkout} is in use by {holder}; aborted")
        finally:
            conn.close()

    def _own(self, conn: sqlite3.Connection, sql: str, params: tuple) -> None:
        """Renew/register only our token. Zero rows means another writer holds
        the checkout; a database error means we cannot prove we still do —
        both are loss, and the owner must stop its worker. A lease once lost
        (or retained) never touches the row again."""
        if not self.held:
            raise LeaseLost(f"checkout lease for {self.checkout} is no longer held")
        try:
            conn.execute("begin immediate")
            try:
                changed = conn.execute(sql, params + (self.token,)).rowcount
            finally:
                conn.execute("commit")
        except sqlite3.Error as error:
            self.held = False
            self.lost.set()
            raise LeaseLost(f"checkout lease for {self.checkout} could not be verified: {error}") from error
        if changed != 1:
            self.held = False
            self.lost.set()
            raise LeaseLost(f"checkout lease for {self.checkout} was taken over by another writer")

    def register_worker(self, pid: int, pgid: int, ident: str) -> None:
        conn = connect(self.path)
        try:
            self._own(conn, "update lease set worker_pid = ?, worker_pgid = ?, worker_ident = ?, heartbeat_at = ?, lease_until = ? where id = 1 and token = ?",
                      (pid, pgid, ident, stamp(), now_ms() + LEASE_MS))
        finally:
            conn.close()

    def heartbeat(self, conn: sqlite3.Connection | None = None) -> None:
        own = conn is None
        conn = conn or connect(self.path)
        try:
            self._own(conn, "update lease set heartbeat_at = ?, lease_until = ? where id = 1 and token = ?",
                      (stamp(), now_ms() + LEASE_MS))
        finally:
            if own:
                conn.close()

    def start_heartbeat(self) -> None:
        def beat():
            try:
                conn = connect(self.path)
            except sqlite3.Error as error:
                print(f"checkout lease heartbeat cannot open {self.path}: {error}", file=sys.stderr)
                self.held = False
                self.lost.set()
                return
            try:
                while not self._stop.wait(HEARTBEAT_MS / 1000):
                    try:
                        self.heartbeat(conn)
                    except LeaseLost as error:
                        print(f"checkout lease heartbeat: {error}", file=sys.stderr)
                        return
            finally:
                conn.close()
        self._thread = Thread(target=beat, name="checkout-lease-heartbeat", daemon=True)
        self._thread.start()

    def stop_heartbeat(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=BUSY_TIMEOUT_SECONDS + 1)
            self._thread = None

    def release(self) -> bool:
        """Delete only our own row; False when it was already someone else's."""
        self.stop_heartbeat()
        if not self.held:
            return False
        conn = connect(self.path)
        try:
            conn.execute("begin immediate")
            try:
                changed = conn.execute("delete from lease where id = 1 and token = ?", (self.token,)).rowcount
            finally:
                conn.execute("commit")
        finally:
            conn.close()
        self.held = False
        return changed == 1

    def retain(self, reason: str) -> None:
        """Keep the row: something that can still write may be alive."""
        self.stop_heartbeat()
        self.retained = reason
        self.held = False


@contextmanager
def interruptible():
    """SIGTERM (Caller --stop) unwinds through the finally blocks that stop the
    worker group and settle the lease, instead of killing us mid-hold."""
    previous = signal.signal(signal.SIGTERM, _interrupted) if current_thread() is main_thread() else None
    try:
        yield
    finally:
        if previous is not None:
            signal.signal(signal.SIGTERM, previous)


def _interrupted(signum, _frame):
    raise SystemExit(128 + signum)


def run_gated(lease: Lease, args: list[str], *, cwd: str, env: dict | None, timeout: float) -> subprocess.CompletedProcess:
    """Run the native writer under the lease. A gate leads a fresh process
    group and starts the agent only after it is registered in the lease and
    told GO over a pipe only we hold; it reports `STARTED` on a second pipe,
    so "the agent never ran" is a fact, not an exit-code guess. Losing us
    (EOF), the lease or the deadline stops the whole group. Returns like
    subprocess.run(capture_output=True) and settles the lease: released when
    the group is gone, retained otherwise."""
    ident = str(uuid4())
    control_r, control_w = os.pipe()
    status_r, status_w = os.pipe()
    gate_args = [sys.executable, str(GATE), "--lease-worker", ident, "--control-fd", str(control_r),
                 "--status-fd", str(status_w), "--", *args]
    process: subprocess.Popen | None = None
    result: subprocess.CompletedProcess | None = None
    with TemporaryFile(mode="w+t") as stdout, TemporaryFile(mode="w+t") as stderr:
        try:
            process = subprocess.Popen(
                gate_args, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, cwd=cwd, env=env,
                start_new_session=True, pass_fds=(control_r, status_w),
            )
            os.close(control_r)
            os.close(status_w)
            control_r = status_w = -1
            lease.register_worker(process.pid, process.pid, ident)
            try:
                os.write(control_w, b"GO\n")
            except BrokenPipeError:
                pass
            lease.start_heartbeat()
            deadline = monotonic() + timeout
            while process.poll() is None:
                if lease.lost.is_set():
                    _stop_group(process)
                    raise LeaseLost(f"checkout lease for {lease.checkout} was taken over; fix-failing-ci agent stopped")
                remaining = deadline - monotonic()
                if remaining <= 0:
                    _stop_group(process)
                    raise subprocess.TimeoutExpired(args, timeout)
                try:
                    process.wait(timeout=min(POLL_SECONDS, remaining))
                except subprocess.TimeoutExpired:
                    continue
            if not _gate_started(status_r):
                raise RuntimeError("fix-failing-ci worker gate exited before the agent started")
            stdout.seek(0)
            stderr.seek(0)
            result = subprocess.CompletedProcess(args, process.returncode, stdout.read(), stderr.read())
        finally:
            try:
                if process is not None and process.poll() is None:
                    _stop_group(process)
            finally:
                for fd in (control_r, status_w, control_w, status_r):
                    if fd != -1:
                        os.close(fd)
                _settle(lease, process.pid if process is not None else None)
    if lease.retained:
        raise WorkerOrphaned(lease.retained)
    return result


def _gate_started(status_r: int) -> bool:
    """The gate's status pipe is at EOF once the gate (its only writer) has
    exited; STARTED is on it exactly when the agent was spawned."""
    data = b""
    while True:
        chunk = os.read(status_r, 64)
        if not chunk:
            return data.startswith(b"STARTED")
        data += chunk


def _stop_group(process: subprocess.Popen) -> None:
    """Stop our own gate's group: SIGTERM, then SIGKILL once the grace is over
    or only the leader is left. The leader is reaped after the last signal,
    never before, so the group id we signal stays ours throughout — a leader
    that exits early cannot hand its number to an unrelated group in between.
    An unlistable group counts as still populated."""
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    deadline = monotonic() + STOP_GRACE_SECONDS
    while monotonic() < deadline:
        if group_members(process.pid) == [] and _exited_unreaped(process.pid):
            break
        sleep(0.1)
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        # macOS reports EPERM for a group holding only its unreaped leader.
        pass
    process.wait()


def _exited_unreaped(pid: int) -> bool:
    """Our child has exited but still holds its pid (not reaped yet)."""
    try:
        return os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
    except ChildProcessError:
        return False


def _settle(lease: Lease, pgid: int | None) -> None:
    """Release only once nothing in the worker group can still write. The gate
    is reaped by now, so a live group means descendants we cannot vouch for."""
    if pgid is not None and pgid_alive(pgid):
        lease.retain(f"orphan requiring intervention: worker group {pgid} ({lease.owner_label}) is still alive; lease retained")
        return
    lease.release()
