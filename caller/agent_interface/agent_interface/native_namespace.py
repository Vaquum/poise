"""One native invocation's kernel boundary, witnessed by the workspace supervisor.

The original Caller stays outside the namespace. Its forked continuation may
run only after the kernel witness and the original receipt are established.
Neither an exited parent nor a missing control socket certifies settlement.
"""
from __future__ import annotations

import ctypes
import json
import os
import re
import select
import signal
import socket
import stat
import sys
from collections.abc import Callable
from pathlib import Path
from time import monotonic, sleep
from uuid import uuid4

START_SECONDS = 10.0
SETTLE_SECONDS = 2.0
CONTROL_SECONDS = 5.0
TERM_SECONDS = 5.0
MAX_MESSAGE = 64 * 1024
_active: Namespace | None = None


def active() -> Namespace | None:
    return _active


class NamespaceUnavailable(RuntimeError):
    def __init__(self, message: str, *, no_init: bool = False, unsupported: bool = True):
        super().__init__(message)
        self.no_init = no_init
        self.unsupported = unsupported


def task_identity(pid: int, root: str = "/proc") -> dict:
    fields = Path(f"{root}/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    if not fields[19].isdigit():
        raise RuntimeError("native process start identity is unreadable")
    return {"pid": pid, "start": fields[19]}


def observer_epoch() -> dict:
    namespace = Path("/proc/self/ns/pid").stat()
    boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    if not boot:
        raise RuntimeError("native observer has no kernel identity")
    return {"boot": boot, "init_start": task_identity(1)["start"],
            "namespace_dev": str(namespace.st_dev), "namespace_ino": str(namespace.st_ino)}


def control_address() -> dict:
    if sys.platform != "linux" or os.getuid() == 0:
        raise NamespaceUnavailable("v2 cleanup requires a supported unprivileged Linux workspace")
    try:
        value = json.loads(os.environ.get("POISE_NATIVE_CONTROL", "null"))
    except ValueError as error:
        raise NamespaceUnavailable("workspace cleanup controller configuration is unreadable") from error
    if not isinstance(value, dict) or value.get("version") != 1 \
            or not isinstance(value.get("path"), str) or not value["path"].startswith("/tmp/poise-native-") \
            or len(value["path"].encode()) > 103 or not isinstance(value.get("instance"), str) \
            or len(value["instance"]) != 32 or any(char not in "0123456789abcdef" for char in value["instance"]):
        raise NamespaceUnavailable("v2 cleanup requires the workspace supervisor's controller")
    node, parent = Path(value["path"]).lstat(), Path(value["path"]).parent.lstat()
    if not stat.S_ISSOCK(node.st_mode) or stat.S_IMODE(node.st_mode) != 0o600 or node.st_uid != os.getuid() \
            or not stat.S_ISDIR(parent.st_mode) or stat.S_IMODE(parent.st_mode) != 0o700 or parent.st_uid != os.getuid():
        raise NamespaceUnavailable("workspace cleanup controller is not private and owned")
    return value


def control_request(address: dict, operation: str, *, timeout_seconds: float = CONTROL_SECONDS, **scope) -> dict:
    payload = json.dumps({"version": 1, "instance": address["instance"], "operation": operation, **scope},
                         separators=(",", ":")).encode() + b"\n"
    if len(payload) > 16 * 1024:
        raise RuntimeError("native cleanup request exceeds its limit")
    if type(timeout_seconds) not in (int, float) or not 0 < timeout_seconds <= CONTROL_SECONDS:
        raise ValueError("native cleanup request requires its bounded deadline")
    deadline = monotonic() + timeout_seconds
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(timeout_seconds)
        connection.connect(address["path"])
        connection.sendall(payload)
        response = bytearray()
        while b"\n" not in response:
            remaining = deadline - monotonic()
            if remaining <= 0:
                raise TimeoutError("original cleanup controller exceeded its deadline")
            connection.settimeout(remaining)
            data = connection.recv(4096)
            if not data:
                raise RuntimeError("original cleanup controller ended without evidence")
            response.extend(data)
            if len(response) > MAX_MESSAGE:
                raise RuntimeError("native cleanup response exceeds its limit")
    row = json.loads(response)
    if not isinstance(row, dict) or row.get("version") != 1 or row.get("instance") != address["instance"]:
        raise RuntimeError("original cleanup controller identity differs")
    if row.get("error"):
        raise RuntimeError(f"native cleanup evidence unavailable: {row['error']}")
    return row


def _libc():
    library = ctypes.CDLL(None, use_errno=True)
    library.unshare.argtypes = [ctypes.c_int]
    library.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    library.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_void_p]
    return library


def _checked(result: int, operation: str) -> None:
    if result != 0:
        raise OSError(ctypes.get_errno(), operation)


def _exited(fd: int, seconds: float = 0) -> bool:
    poll = select.poll()
    poll.register(fd, select.POLLIN)
    return bool(poll.poll(max(0, int(seconds * 1000))))


def _parent_death(library, parent: int) -> None:
    _checked(library.prctl(1, signal.SIGKILL, 0, 0, 0), "native parent-death signal")
    if _exited(parent):
        raise RuntimeError("original native parent ended before registration")


def _drop_capabilities(library) -> None:
    class Header(ctypes.Structure):
        _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]

    class Data(ctypes.Structure):
        _fields_ = [("effective", ctypes.c_uint32), ("permitted", ctypes.c_uint32), ("inheritable", ctypes.c_uint32)]

    for capability in range(65):
        present = library.prctl(23, capability, 0, 0, 0)
        if present == -1:
            if ctypes.get_errno() != 22 or capability == 0:
                raise OSError(ctypes.get_errno(), "read native capability bound")
            break
        _checked(library.prctl(24, capability, 0, 0, 0), "drop native capability bound")
    else:
        raise RuntimeError("kernel capability range exceeds the native limit")
    header, data = Header(0x20080522, 0), (Data * 2)()
    _checked(library.capset(ctypes.byref(header), ctypes.byref(data)), "drop native capabilities")
    _checked(library.prctl(38, 1, 0, 0, 0), "native no-new-privileges")
    _checked(library.prctl(4, 1, 0, 0, 0), "native witness access")
    values = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines() if ":" in line)
    if any(values.get(key, "").strip() != "0000000000000000" for key in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb")) \
            or values.get("NoNewPrivs", "").strip() != "1":
        raise RuntimeError("native continuation retained privileges")


class Namespace:
    def __init__(self, call_id: str, correlation: str, *, token: str | None = None, probe: bool = False):
        token = token or uuid4().hex
        if not re.fullmatch(r"[a-f0-9]{32}", call_id) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9:._-]{0,127}", correlation) \
                or not re.fullmatch(r"[a-f0-9]{32}", token):
            raise ValueError("invalid original native namespace identity")
        self.address = control_address()
        state = control_request(self.address, "hello")
        if state.get("available") is not True:
            raise NamespaceUnavailable("workspace cleanup controller is unavailable")
        if probe and state.get("probeAvailable") is not True:
            raise RuntimeError("original native setup probe is still unsettled")
        self.probe = probe
        self.key = {"callId": call_id, "correlation": correlation, "token": token}
        self.binding: dict | None = None
        self.exit_code: int | None = None
        self.outer_proc: int | None = None
        self.go_sent = False
        self.forked = False
        self._buffer = bytearray()

    @classmethod
    def restore(cls, private: dict, binding: dict):
        address = control_address()
        if private.get("address") != address:
            raise RuntimeError("original native cleanup controller is unavailable")
        scope = cls.__new__(cls)
        scope.address = address
        scope.key = {key: private[key] for key in ("callId", "correlation", "token")}
        if not re.fullmatch(r"[a-f0-9]{32}", scope.key["callId"]) \
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9:._-]{0,127}", scope.key["correlation"]) \
                or not re.fullmatch(r"[a-f0-9]{32}", scope.key["token"]):
            raise RuntimeError("original native cleanup identity is invalid")
        scope.binding = binding
        scope.outer_proc = None
        return scope

    def resource(self, operation: str, root: Path) -> dict:
        if operation not in {"allocate-root", "read-root", "repair-root", "finish-root"}:
            raise ValueError("invalid native resource operation")
        row = control_request(self.address, operation, **self.key, root=str(root))
        value = row.get("resource")
        if row.get("callId") != self.key["callId"] or row.get("correlation") != self.key["correlation"] \
                or not isinstance(value, dict) or value.get("path") != str(root) \
                or value.get("state") not in {"allocated", "reclaimed"} \
                or any(not isinstance(value.get(key), str) or not re.fullmatch(r"[0-9]{1,20}", value[key])
                       for key in ("device", "inode", "parent_device", "parent_inode")):
            raise RuntimeError("native resource differs from its original controller proof")
        if value["state"] == "allocated":
            anchor = value.get("anchor")
            if type(value.get("unlinked")) is not bool or not isinstance(anchor, dict) \
                    or type(anchor.get("pid")) is not int or anchor["pid"] < 2 \
                    or any(type(anchor.get(key)) is not int or anchor[key] < 0 for key in ("parentFd", "rootFd")):
                raise RuntimeError("native resource lacks its original directory handles")
        elif type(value.get("reclaimed_at")) not in (int, float) or not 0 < value["reclaimed_at"] < float("inf"):
            raise RuntimeError("native resource lacks its positive reclamation time")
        return value

    def _message(self, fd: int, deadline: float) -> dict:
        while b"\n" not in self._buffer:
            remaining = deadline - monotonic()
            if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
                raise TimeoutError("native namespace startup exceeded its deadline")
            chunk = os.read(fd, 4096)
            if not chunk:
                raise RuntimeError("native namespace startup ended without evidence")
            self._buffer.extend(chunk)
            if len(self._buffer) > 16 * 1024:
                raise RuntimeError("native namespace startup receipt exceeds its limit")
        line, _, tail = self._buffer.partition(b"\n")
        self._buffer = bytearray(tail)
        message = json.loads(line)
        if not isinstance(message, dict):
            raise RuntimeError("native namespace startup receipt is invalid")
        if message.get("error"):
            raise NamespaceUnavailable(str(message["error"]), no_init=message.get("no_init") is True,
                                       unsupported=message.get("errno") in {1, 13, 22, 38, 95})
        return message

    @staticmethod
    def _send(fd: int, value: dict) -> None:
        encoded = json.dumps(value, separators=(",", ":")).encode() + b"\n"
        if len(encoded) > 4096 or os.write(fd, encoded) != len(encoded):
            raise RuntimeError("native namespace startup receipt was not delivered")

    def read(self, *, timeout_seconds: float = CONTROL_SECONDS) -> dict:
        if self.binding is None:
            raise RuntimeError("native namespace lacks its original registration")
        row = control_request(self.address, "read", timeout_seconds=timeout_seconds, **self.key)
        if row.get("callId") != self.key["callId"] or row.get("correlation") != self.key["correlation"] \
                or row.get("binding") != self.binding or not isinstance(row.get("pids"), list) \
                or any(type(pid) is not int or pid < 1 for pid in row["pids"]) \
                or len(set(row["pids"])) != len(row["pids"]) \
                or row.get("empty") is not (len(row["pids"]) == 0) or row.get("namespace") != self.binding["namespace"]:
            raise RuntimeError("native namespace evidence differs from its original registration")
        return row

    def release(self) -> None:
        if not self.read()["empty"]:
            raise RuntimeError("native namespace still owns processes")
        response = control_request(self.address, "release", **self.key)
        if response.get("released") is not True:
            raise RuntimeError("native namespace witness retirement was not confirmed")

    def retire(self) -> None:
        # This is housekeeping after durable physical release, not a proof
        # from an absent witness. Callers must already have that release.
        response = control_request(self.address, "retire", **self.key)
        if type(response.get("retired")) is not bool or response.get("present") is not False:
            raise RuntimeError("native cleanup witness retirement is unavailable")

    def await_empty(self) -> None:
        deadline = monotonic() + SETTLE_SECONDS
        while True:
            remaining = deadline - monotonic()
            if remaining <= 0:
                raise TimeoutError("native namespace did not settle within its deadline")
            state = self.read(timeout_seconds=min(CONTROL_SECONDS, remaining))
            if monotonic() > deadline:
                raise TimeoutError("native namespace proof arrived after its deadline")
            if state["empty"]:
                return
            sleep(0.005)

    def require_idle(self) -> None:
        if active() is not self or os.getpid() != 2:
            raise RuntimeError("native checkout cleanup requires its original Caller continuation")
        deadline = monotonic() + SETTLE_SECONDS
        while True:
            remaining = deadline - monotonic()
            if remaining <= 0:
                raise TimeoutError("native invocation still owns a helper or worker")
            state = self.read(timeout_seconds=min(CONTROL_SECONDS, remaining))
            if monotonic() > deadline:
                raise TimeoutError("native idle proof arrived after its deadline")
            # PID 1 is the trusted reaper; PID 2 is this synchronous Caller.
            # Any other member, including an unreaped child, keeps the lease.
            if state["pids"] == [1, 2]:
                return
            sleep(0.005)

    def start(self, registered: Callable[[dict], None], *, timeout_seconds: float, guard=None) -> bool:
        """True in the confined continuation; False in the original Caller
        after the continuation and every namespace member have ended.
        `registered` must commit the original receipt before GO is delivered.
        """
        if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
            raise NamespaceUnavailable("v2 cleanup requires kernel process handles")
        if len(list(Path("/proc/self/task").iterdir())) != 1:
            raise NamespaceUnavailable("native namespace must start before Caller threads")
        if type(timeout_seconds) not in (int, float) or not 0 < timeout_seconds <= 24 * 3600:
            raise ValueError("native namespace requires its bounded operation deadline")
        owner = task_identity(os.getpid())
        epoch = observer_epoch()
        descriptors: set[int] = set()
        holder = holder_fd = None
        init_fd = None
        waited_holder = False
        continuing = False
        stop_requested = False
        prior_sigterm = None
        monitor = None

        def owned(fd: int) -> int:
            descriptors.add(fd)
            return fd

        def close(fd: int) -> None:
            descriptors.remove(fd)
            os.close(fd)

        try:
            owner_fd = owned(os.pidfd_open(os.getpid()))
            self.outer_proc = owned(os.open("/proc", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC))
            read, output = os.pipe2(os.O_CLOEXEC)
            descriptors.update((read, output))
            control, send = os.pipe2(os.O_CLOEXEC)
            descriptors.update((control, send))
            holder = os.fork()
            self.forked = True
            if holder == 0:
                init = None
                try:
                    close(read)
                    close(send)
                    library = _libc()
                    _parent_death(library, owner_fd)
                    uid, gid = os.getuid(), os.getgid()
                    _checked(library.unshare(0x10000000), "native user namespace")
                    Path("/proc/self/setgroups").write_text("deny")
                    Path("/proc/self/uid_map").write_text(f"{uid} {uid} 1\n")
                    Path("/proc/self/gid_map").write_text(f"{gid} {gid} 1\n")
                    _checked(library.unshare(0x20000000 | 0x20000), "native PID/mount namespace")
                    parent_fd = owned(os.pidfd_open(os.getpid()))
                    init = os.fork()
                    if init == 0:
                        _parent_death(library, parent_fd)
                        _checked(library.mount(None, b"/", None, (1 << 18) | (1 << 14), None), "native private mounts")
                        _checked(library.mount(b"proc", b"/proc", b"proc", 2 | 4 | 8, None), "native private procfs")
                        _drop_capabilities(library)
                        _parent_death(library, parent_fd)
                        executor_fd = None
                        init_stopped = False

                        def stop_executor(signum, frame):
                            nonlocal init_stopped
                            init_stopped = True
                            if executor_fd is not None and not _exited(executor_fd):
                                signal.pidfd_send_signal(executor_fd, signal.SIGTERM)

                        inherited_sigterm = signal.signal(signal.SIGTERM, stop_executor)
                        self._send(output, {"ready": os.readlink("/proc/self/ns/pid")})
                        go = self._message(control, monotonic() + START_SECONDS)
                        if go.get("operation") != "GO" or not isinstance(go.get("binding"), dict):
                            raise RuntimeError("native namespace lacks its committed GO receipt")
                        self.binding = go["binding"]
                        if init_stopped:
                            os._exit(128 + signal.SIGTERM)
                        init_handle = owned(os.pidfd_open(os.getpid()))
                        executor = os.fork()
                        if executor == 0:
                            signal.signal(signal.SIGTERM, inherited_sigterm)
                            _parent_death(library, init_handle)
                            global _active
                            _active = self
                            # Only the Caller continuation retains this read
                            # handle; provider execs never inherit it.
                            descriptors.remove(self.outer_proc)
                            continuing = True
                            return True
                        executor_fd = owned(os.pidfd_open(executor))
                        if init_stopped:
                            signal.pidfd_send_signal(executor_fd, signal.SIGTERM)
                        # PID 1 only reaps adopted children. Running Caller as
                        # PID 2 preserves subprocess waits and default signals;
                        # no generic SIGCHLD handler can steal a provider result.
                        for fd in list(descriptors):
                            if fd != executor_fd:
                                close(fd)
                        while True:
                            waited, status = os.waitpid(executor, os.WNOHANG)
                            if waited == executor:
                                code = os.waitstatus_to_exitcode(status)
                                os._exit(code if code >= 0 else 128 - code)
                            waited, status = os.waitpid(-1, 0)
                            if waited == executor:
                                code = os.waitstatus_to_exitcode(status)
                                os._exit(code if code >= 0 else 128 - code)
                    close(control)
                    close(parent_fd)
                    self._send(output, {"init": init})
                    waited, status = os.waitpid(init, 0)
                    self._send(output, {"exited": waited, "status": status})
                    os._exit(0)
                except BaseException as error:
                    try:
                        self._send(output, {"error": str(error), "no_init": init is None,
                                            "errno": error.errno if isinstance(error, OSError) else None})
                    finally:
                        os._exit(1)
            close(output)
            close(control)
            close(owner_fd)
            holder_fd = owned(os.pidfd_open(holder))

            def stop_namespace(signum, frame):
                nonlocal stop_requested
                stop_requested = True
                if init_fd is not None and not _exited(init_fd):
                    signal.pidfd_send_signal(init_fd, signal.SIGTERM)

            prior_sigterm = signal.signal(signal.SIGTERM, stop_namespace)
            deadline = monotonic() + START_SECONDS
            init, namespace = None, None
            while init is None or namespace is None:
                message = self._message(read, deadline)
                if "init" in message:
                    if type(message["init"]) is not int or message["init"] < 2:
                        raise RuntimeError("native namespace init identity is invalid")
                    init = message["init"]
                    init_fd = owned(os.pidfd_open(init))
                if "ready" in message:
                    namespace = message["ready"]
            self.binding = {**task_identity(init), "namespace": namespace, "epoch": epoch,
                            "owner": owner, "holder": task_identity(holder)}
            response = control_request(self.address, "register", **self.key, identity=self.binding, probe=self.probe)
            if response.get("binding") != self.binding or response.get("empty") is not False \
                    or response.get("callId") != self.key["callId"] or response.get("correlation") != self.key["correlation"] \
                    or response.get("namespace") != namespace or 1 not in response.get("pids", []):
                raise RuntimeError("native namespace was not witnessed before GO")
            registered({"controller": self.address, **self.key, "binding": self.binding})
            if guard is not None:
                monitor = guard(self)
                monitor.start()
            if stop_requested:
                raise InterruptedError("native invocation was stopped before GO")
            self._send(send, {"operation": "GO", "binding": self.binding})
            self.go_sent = True
            deadline = monotonic() + timeout_seconds
            stop_deadline = None
            while not _exited(holder_fd, 0.05):
                if monitor is not None and monitor.poll():
                    # A committed resource cause has no grace period. Killing
                    # the pinned holder ends this original namespace only.
                    signal.pidfd_send_signal(holder_fd, signal.SIGKILL)
                    monitor.signalled()
                    from .resource_guard import GuardStopped
                    raise GuardStopped("native behavior stopped by its resource guard")
                if stop_requested and stop_deadline is None:
                    stop_deadline = monotonic() + TERM_SECONDS
                if monotonic() >= (stop_deadline if stop_deadline is not None else deadline):
                    if monitor is not None and not stop_requested:
                        monitor.timeout()
                    if init_fd is not None and not _exited(init_fd):
                        signal.pidfd_send_signal(init_fd, signal.SIGTERM)
                    if stop_requested or not _exited(holder_fd, TERM_SECONDS):
                        signal.pidfd_send_signal(holder_fd, signal.SIGKILL)
                    if stop_requested:
                        raise InterruptedError("native invocation was stopped")
                    raise TimeoutError("native invocation exceeded its operation deadline")
            _, holder_status = os.waitpid(holder, 0)
            waited_holder = True
            if not os.WIFEXITED(holder_status) or os.WEXITSTATUS(holder_status) != 0:
                raise RuntimeError("native namespace holder ended without its original result")
            ended = self._message(read, monotonic() + CONTROL_SECONDS)
            if ended.get("exited") != init or type(ended.get("status")) is not int:
                raise RuntimeError("native namespace holder returned another process's result")
            self.exit_code = os.waitstatus_to_exitcode(ended["status"])
            # The synchronous teardown wait is bounded. Ongoing recovery uses
            # the existing Caller readers; this adds no independent poller.
            self.await_empty()
            return False
        finally:
            failures = []
            if prior_sigterm is not None:
                signal.signal(signal.SIGTERM, prior_sigterm)
            if os.getpid() == owner["pid"] and holder_fd is not None:
                try:
                    if not _exited(holder_fd):
                        signal.pidfd_send_signal(holder_fd, signal.SIGKILL)
                    if not waited_holder:
                        if not _exited(holder_fd, TERM_SECONDS):
                            raise TimeoutError("original native namespace holder did not terminate")
                        os.waitpid(holder, 0)
                except (OSError, RuntimeError, TimeoutError) as error:
                    failures.append(error)
            if monitor is not None:
                try:
                    monitor.close()
                except (OSError, RuntimeError) as error:
                    failures.append(error)
            for fd in list(descriptors):
                try:
                    close(fd)
                except OSError as error:
                    failures.append(error)
            if not continuing:
                self.outer_proc = None
            if failures:
                original = sys.exception()
                raise BaseExceptionGroup("native namespace teardown failed", ([original] if original else []) + failures)


def require_resource_controller() -> None:
    address = control_address()
    state = control_request(address, "hello")
    if state.get("resourceProtocol") != 2 or not isinstance(address.get("store"), dict):
        reason = state.get("storeError")
        raise NamespaceUnavailable(reason if isinstance(reason, str) and reason else
                                   "v2 cleanup requires the current workspace image and original Caller metadata handles")
    if state.get("persistentCleanup") != 1:
        raise NamespaceUnavailable("v2 cleanup requires a workspace image with persistent-home reclamation support")


def capability() -> dict:
    """An explicit local setup check, not a behavior or an execution admission.
    No provider, checkout or GitHub operation is started by the continuation.
    """
    try:
        require_resource_controller()
        scope = Namespace(uuid4().hex, f"capability-{uuid4().hex}", probe=True)
        if scope.start(lambda receipt: None, timeout_seconds=START_SECONDS):
            os._exit(0)
        if scope.exit_code != 0:
            raise RuntimeError("native cleanup setup check did not complete")
        scope.release()
        return {"version": 1, "supported": True, "resourceGuard": 1}
    except Exception as error:
        return {"version": 1, "supported": False, "error": str(error)[:500],
                **({"unavailable": True} if not isinstance(error, NamespaceUnavailable) or not error.unsupported else {})}
