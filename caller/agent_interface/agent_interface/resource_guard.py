"""Sampled native execution limits. Ownership and reclamation stay separate.

The original Caller owns this thread and its descriptors. The shared workspace
supervisor and Poise's event loop never walk a behavior's filesystem tree.
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import stat
import threading
from contextlib import closing
from pathlib import Path
from time import monotonic, time

from . import caller_store, native_namespace, progress, resource_ownership

SAMPLE_SECONDS = 1.0
STALE_SECONDS = 5.0
CODES = {"resource_memory_exceeded", "resource_disk_exceeded", "resource_measurement_unavailable"}
logger = logging.getLogger(__name__)


class GuardStopped(RuntimeError):
    pass


class ReceiptUnavailable(RuntimeError):
    code = "resource_receipt_unavailable"


class MembershipChanged(RuntimeError):
    pass


def limits(raw: str | None) -> dict | None:
    if raw is None:
        return None
    if len(raw.encode()) > 1024:
        raise ValueError("native execution limits exceed their request bound")
    value = json.loads(raw)
    if not isinstance(value, dict) or set(value) != {"version", "memoryBytes", "diskBytes"} or type(value["version"]) is not int or value["version"] != 1 \
            or all(value[key] is None for key in ("memoryBytes", "diskBytes")) \
            or any(value[key] is not None and (type(value[key]) is not int or not 0 < value[key] <= 2 ** 53 - 1)
                   for key in ("memoryBytes", "diskBytes")):
        raise ValueError("native execution requires its original positive resource ceilings")
    return value


def initial(value: dict) -> str:
    return json.dumps({"version": 1, "limits": value, "state": "starting", "memoryModel": "unmeasured",
                       "peakMemoryBytes": 0, "peakDiskBytes": 0, "samples": 0, "partialSamples": 0,
                       "lastCompleteAt": None, "longestUnavailableSeconds": 0, "failure": None}, separators=(",", ":"))


def _identity(directory: Path, expected: dict) -> None:
    if native_namespace.task_identity(expected["pid"], str(directory.parent))["start"] != expected["start"]:
        raise RuntimeError("resource measurement lost its original process identity")


def process_memory(directory: Path) -> tuple[int, str]:
    try:
        lines = (directory / "smaps_rollup").read_text().splitlines()
        field, model = "Pss:", "pss"
    except FileNotFoundError:
        lines = (directory / "status").read_text().splitlines()
        field, model = "VmRSS:", "rss"
    matches = [line.split() for line in lines if line.startswith(field)]
    if len(matches) != 1 or len(matches[0]) != 3 or not matches[0][1].isdigit() or matches[0][2] != "kB":
        raise RuntimeError("resource process memory counter is unavailable")
    return int(matches[0][1]) * 1024, model


def allocated(node, seen: set[tuple[int, int]]) -> int:
    identity = (node.st_dev, node.st_ino)
    if identity in seen:
        return 0
    seen.add(identity)
    return node.st_blocks * 512


def tree_bytes(fd: int, seen: set[tuple[int, int]], cancelled: threading.Event) -> int:
    """Descriptor traversal never follows a replacement directory or symlink."""
    pending = [os.dup(fd)]
    total = 0
    try:
        while pending:
            directory = pending.pop()
            try:
                node = os.fstat(directory)
                if (node.st_dev, node.st_ino) in seen:
                    continue
                total += allocated(node, seen)
                with os.scandir(directory) as entries:
                    for entry in entries:
                        if cancelled.is_set():
                            raise InterruptedError("resource sampler was cancelled")
                        node = entry.stat(follow_symlinks=False)
                        if stat.S_ISDIR(node.st_mode):
                            child = os.open(entry.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                            dir_fd=directory)
                            opened = os.fstat(child)
                            if (opened.st_dev, opened.st_ino) != (node.st_dev, node.st_ino):
                                os.close(child)
                                raise RuntimeError("resource directory changed during measurement")
                            pending.append(child)
                        else:
                            total += allocated(node, seen)
            finally:
                os.close(directory)
    finally:
        for fd in pending:
            os.close(fd)
    return total


def deleted_bytes(directory: Path, seen: set[tuple[int, int]]) -> int:
    total = 0
    described = set()
    for entry in (directory / "fd").iterdir():
        try:
            target = os.readlink(entry)
            node = entry.stat()
        except FileNotFoundError:
            continue  # This descriptor positively closed during the sample.
        if stat.S_ISREG(node.st_mode) and (target.endswith(" (deleted)") or node.st_nlink == 0):
            described.add((node.st_dev, node.st_ino))
            total += allocated(node, seen)
    # gVisor has no map_files, and a closed mapped file has no allocated-byte
    # counter. Its virtual mapping length must not masquerade as disk usage.
    for line in (directory / "maps").read_text().splitlines():
        if not line.endswith(" (deleted)"):
            continue
        fields = line.split(maxsplit=5)
        major, minor = (int(part, 16) for part in fields[3].split(":"))
        if (os.makedev(major, minor), int(fields[4])) not in described:
            raise RuntimeError("mapped deleted file has incomplete allocated-byte coverage")
    return total


class Guard:
    def __init__(self, database: Path, call_id: str, scope, value: dict):
        self.database, self.call_id, self.scope, self.limits = database, call_id, scope, value
        self.cancelled = threading.Event()
        self.lock = threading.Lock()
        self.summary = json.loads(initial(value))
        self.error: str | None = None
        self.last_complete = self.started = monotonic()
        self.sample: dict | None = None
        self.breach: dict | None = None
        self.thread: threading.Thread | None = None
        self.proc: int | None = None
        self.saved = (0, 0)
        self.disabled = False
        self.pending_failure: dict | None = None
        self.reading_stage: str | None = None

    def _stage(self, name: str) -> None:
        with self.lock:
            self.reading_stage = name

    def _read(self) -> dict:
        self._stage("native process counters")
        view = Path(f"/proc/self/fd/{self.proc}")
        pids = sorted(int(entry.name) for entry in view.iterdir() if entry.name.isdecimal())
        if 1 not in pids:
            raise RuntimeError("original resource namespace ended during measurement")
        directories = [view / str(pid) for pid in pids]
        for name in ("owner", "holder"):
            identity = self.scope.binding[name]
            directory = Path(f"/proc/{identity['pid']}")
            _identity(directory, identity)
            directories.append(directory)
        seen: set[tuple[int, int]] = set()
        memory, disk, models = 0, 0, set()
        for directory in directories:
            self._stage("native process counters")
            before = native_namespace.task_identity(int(directory.name), str(directory.parent))
            amount, model = process_memory(directory)
            memory += amount
            models.add(model)
            if self.limits["diskBytes"] is not None:
                self._stage("open deleted files")
                disk += deleted_bytes(directory, seen)
            if native_namespace.task_identity(int(directory.name), str(directory.parent)) != before:
                raise MembershipChanged("resource process changed during measurement")
        # Validate the process counter pass before the independent filesystem
        # walk. A child born later belongs to the next process sample.
        if set(pids) != {int(entry.name) for entry in view.iterdir() if entry.name.isdecimal()}:
            raise MembershipChanged("resource membership changed during measurement")
        if self.limits["diskBytes"] is not None:
            self._stage("Caller resource inventory")
            with closing(caller_store.connect(self.database, timeout=1)) as conn:
                roots = resource_ownership.read(conn, self.call_id)["roots"]
            for root in roots:
                if root["state"] in {"reclaimed", "covered"}:
                    continue
                if root["state"] != "allocated":
                    raise RuntimeError("resource allocation is not yet measurable")
                self._stage("original directory handle")
                proof = self.scope.resource("read-root", Path(root["path"]))
                if proof["state"] == "reclaimed":
                    continue
                anchor = proof["anchor"]
                fd = os.open(f"/proc/{anchor['pid']}/fd/{anchor['rootFd']}", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
                try:
                    self._stage("allocated blocks")
                    node = os.fstat(fd)
                    if {"device": str(node.st_dev), "inode": str(node.st_ino)} != {key: root[key] for key in ("device", "inode")}:
                        raise RuntimeError("resource root differs from its original allocation")
                    disk += tree_bytes(fd, seen, self.cancelled)
                finally:
                    os.close(fd)
        return {"memoryBytes": memory, "diskBytes": disk, "memoryModel": "+".join(sorted(models)),
                "completedAt": time(), "completedMonotonic": monotonic()}

    def _sample(self) -> dict:
        deadline = monotonic() + SAMPLE_SECONDS
        retry = False
        while True:
            try:
                return self._read()
            except (FileNotFoundError, ProcessLookupError, MembershipChanged) as error:
                if self.cancelled.is_set() or monotonic() >= deadline:
                    raise
                # Retry changing membership within this sampling opportunity.
                # Only a complete snapshot refreshes the five-second coverage.
                with self.lock:
                    self.error = str(error)[:500]
                    self.summary["partialSamples"] += 1
                if retry and (self.cancelled.wait(0.01) or monotonic() >= deadline):
                    raise
                retry = True

    def _run(self) -> None:
        while not self.cancelled.is_set():
            began = monotonic()
            try:
                sample = self._sample()
                with self.lock:
                    self.sample, self.error = sample, None
                    self.summary["longestUnavailableSeconds"] = max(self.summary["longestUnavailableSeconds"],
                                                                   sample["completedMonotonic"] - self.last_complete)
                    self.last_complete = sample["completedMonotonic"]
                    self.summary.update(state="measured", memoryModel=sample["memoryModel"], lastCompleteAt=sample["completedAt"],
                                        peakMemoryBytes=max(self.summary["peakMemoryBytes"], sample["memoryBytes"]),
                                        peakDiskBytes=max(self.summary["peakDiskBytes"], sample["diskBytes"]),
                                        samples=self.summary["samples"] + 1)
                    if self.breach is None and any(self.limits[key] is not None and sample[key] > self.limits[key]
                                                   for key in ("memoryBytes", "diskBytes")):
                        self.breach = sample
            except (OSError, RuntimeError, ValueError, sqlite3.Error) as error:
                with self.lock:
                    self.error = str(error)[:500]
                    self.summary["partialSamples"] += 1
            finally:
                with self.lock:
                    self.reading_stage = None
            if self.cancelled.wait(max(0, SAMPLE_SECONDS - (monotonic() - began))):
                return

    def start(self) -> None:
        binding = self.scope.binding
        _identity(Path(f"/proc/{binding['pid']}"), binding)
        self.proc = os.open(f"/proc/{binding['pid']}/root/proc", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            view = Path(f"/proc/self/fd/{self.proc}")
            if os.readlink(view / "1/ns/pid") != binding["namespace"] \
                    or native_namespace.task_identity(1, str(view))["start"] != binding["start"]:
                raise RuntimeError("resource sampler lacks its original private procfs")
            _identity(Path(f"/proc/{binding['pid']}"), binding)
            self.thread = threading.Thread(target=self._run, name="native-resource-sample", daemon=True)
            self.thread.start()
        except BaseException:
            os.close(self.proc)
            self.proc = None
            raise

    def poll(self) -> bool:
        if self.disabled:
            return False
        with self.lock:
            summary = json.loads(json.dumps(self.summary))
            sample = dict(self.breach) if self.breach else None
            stale = monotonic() - self.last_complete > STALE_SECONDS
            error = f"still reading {self.reading_stage}" if self.reading_stage else self.error
            summary["longestUnavailableSeconds"] = max(summary["longestUnavailableSeconds"], monotonic() - self.last_complete)
        failure = self.pending_failure
        if failure is None and sample:
            for key, code in (("memoryBytes", "resource_memory_exceeded"), ("diskBytes", "resource_disk_exceeded")):
                ceiling = self.limits[key]
                if ceiling is not None and sample[key] > ceiling:
                    failure = {"code": code, "dimension": key, "ceiling": ceiling, "observed": sample[key],
                               "observedAt": sample["completedAt"], "observedMonotonic": sample["completedMonotonic"],
                               "message": f"Behavior {key} exceeded {ceiling} bytes: observed {sample[key]} bytes"}
                    break
        if failure is None and stale:
            failure = {"code": "resource_measurement_unavailable", "dimension": "coverage", "ceiling": None, "observed": None,
                       "observedAt": time(), "observedMonotonic": monotonic(),
                       "message": f"Behavior resource measurement unavailable for over {STALE_SECONDS:g}s: {error or 'no complete sample'}"}
        if failure:
            self.pending_failure = failure
            summary.update(state="stopped", failure=failure)
        counters = (summary["samples"], summary["partialSamples"])
        if not failure and counters == self.saved:
            return False
        previous = self.saved
        try:
            return self._persist(summary, failure, counters)
        except sqlite3.OperationalError as error:
            if getattr(error, "sqlite_errorcode", 0) & 0xff not in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED}:
                raise
            self.saved, self.disabled = previous, False
            if failure and monotonic() - failure["observedMonotonic"] >= 1.5:
                # The wait loop fails closed before the physical stop deadline.
                # A locked journal cannot certify a first cause or no-write;
                # normal interrupted/uncertain receipt recovery retains it.
                raise ReceiptUnavailable(f"Cannot commit original resource stop receipt: {failure['message']}") from error
            return False

    def _persist(self, summary: dict, failure: dict | None, counters: tuple[int, int]) -> bool:
        encoded = json.dumps(summary, separators=(",", ":"))
        with closing(caller_store.connect(self.database, timeout=0.05)) as conn, conn:
            if failure:
                conn.execute("begin immediate")
                row = conn.execute("select behavior,artifact,action_plan,status,error_code from calls where id=?", (self.call_id,)).fetchone()
                self.disabled = True
                if not row or row[3] != "running" or row[4] is not None:
                    return False
                artifact = json.loads(row[1] or "{}")
                phase = artifact.get("phase")
                failure["noWrite"] = phase in {"preparing", "prepared", "executing", "reviewing"} \
                    or row[0] == "native_action" and phase in {None, "preparing_native_action"} \
                    or row[2] is None and row[0] in {"issue_review", "implement_issue", "repair_pr", "native_publication"}
                encoded = json.dumps(summary, separators=(",", ":"))
                # Terminal before signalling: the publication writers' running
                # gate cannot advance a known pre-write phase after this cause.
                changed = conn.execute("update calls set status='failed',ended_at=?,resource_guard=?,error_code=?,error=?,action=null,outcome=null,progress=coalesce(?,progress) "
                                       "where id=? and status='running' and error_code is null",
                                       (time(), encoded, failure["code"], failure["message"], progress.terminal("failed"), self.call_id)).rowcount
                return changed == 1
            changed = conn.execute("update calls set resource_guard=? where id=? and status='running' and error_code is null",
                                   (encoded, self.call_id)).rowcount
            self.saved, self.disabled = counters, changed == 0
        return False

    def close(self) -> None:
        self.cancelled.set()
        if self.thread is not None:
            self.thread.join(timeout=2)
            if self.thread.is_alive():
                # A Python thread cannot be safely killed or have its live FDs
                # closed by another thread. Exit the original owner; existing
                # parent-death containment and claimed maintenance recover it.
                resource_ownership.failure(self.database, self.call_id, "resources_unknown")
                os._exit(70)
        if self.proc is not None:
            os.close(self.proc)
            self.proc = None

    def signalled(self) -> None:
        at = monotonic()
        try:
            with closing(caller_store.connect(self.database, timeout=0.05)) as conn, conn:
                conn.execute("update calls set resource_guard=json_set(resource_guard,'$.failure.signalMonotonic',?) "
                             "where id=? and error_code in ('resource_memory_exceeded','resource_disk_exceeded','resource_measurement_unavailable')",
                             (at, self.call_id))
        except sqlite3.OperationalError as error:
            if getattr(error, "sqlite_errorcode", 0) & 0xff not in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED}:
                raise
            # The cause is already durable and the signal already sent. An
            # unavailable timing annotation is never fabricated as zero.
            logger.warning("Resource stop timing annotation unavailable: Caller database is busy")

    def timeout(self) -> None:
        try:
            with closing(caller_store.connect(self.database, timeout=0.05)) as conn, conn:
                conn.execute("update calls set error_code='native_timeout',error='Native invocation exceeded its operation deadline' "
                             "where id=? and status='running' and error_code is null", (self.call_id,))
        except sqlite3.OperationalError as error:
            if getattr(error, "sqlite_errorcode", 0) & 0xff not in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED}:
                raise
            # Preserve the existing operation deadline even when Caller cannot
            # persist its cause. The original exit remains interrupted/unknown.
            logger.warning("Native timeout cause unavailable: Caller database is busy")
