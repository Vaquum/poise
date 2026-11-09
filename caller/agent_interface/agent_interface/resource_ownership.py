"""Per-Call resource receipts in Caller, independent of publication artifacts.

Registration is append-only and precedes allocation. Only the cleaner which
observed the pinned directory can acknowledge its reclamation; disappearance
or process loss alone is not a cleanup receipt. This is resource metadata,
not another behavior/action ledger.
"""
from __future__ import annotations

import json
import os
import sqlite3
import stat
from contextlib import closing, contextmanager
from pathlib import Path
from time import monotonic, time
from uuid import uuid4


MAX_RECEIPT_BYTES = 128 * 1024
MAX_ERROR_CHARACTERS = 512


def initial(call_id: str | None = None, correlation: str | None = None) -> str:
    value = {"version": 1, "roots": [], "errors": []}
    if call_id is not None or correlation is not None:
        if not call_id or not correlation:
            raise ValueError("native namespace requires its original Call and correlation")
        value.update(version=2, namespace={"state": "requested", "callId": call_id, "correlation": correlation})
    return json.dumps(value)


def call_directory(database: Path, call_id: str) -> Path:
    return database.parent / "native-resources" / call_id


@contextmanager
def _database(path: Path):
    from . import caller_store
    with closing(caller_store.connect(path, timeout=30)) as conn:
        with conn:
            yield conn


def read(conn: sqlite3.Connection, call_id: str) -> dict:
    row = conn.execute("select resource_ownership from calls where id=? and source='poise:behavior-chain'", (call_id,)).fetchone()
    value = json.loads(row[0]) if row and row[0] else None
    if not isinstance(value, dict) or value.get("version") not in (1, 2) \
            or not isinstance(value.get("roots"), list) or not isinstance(value.get("errors"), list):
        raise RuntimeError("native Call lacks its durable resource ownership")
    if value["version"] == 2 and (not isinstance(value.get("namespace"), dict)
                                  or value["namespace"].get("callId") != call_id):
        raise RuntimeError("native Call lacks its original namespace ownership")
    return value


def _settlement_size(value: dict) -> int:
    # Size-only placeholders cover full-width kernel identities and timestamps.
    # Include both possible certificates for an incomplete registration, plus
    # one bounded terminal blocker. The blocker uses an astral character so the
    # reserve covers the worst-case JSON escaping (12 bytes per character).
    # None of this projection is persisted.
    stamp = "9" * 24
    settled = {**value, "process_pending": False, "roots": [], "errors": [
        {**error, "recovered_at": stamp} for error in value["errors"]]}
    if value["version"] == 2:
        settled["namespace"] = {**value["namespace"], "state": "settled", "settled_at": stamp}
    for root in value["roots"]:
        reclaimed = {**root, "state": "reclaimed", "reclaimed_at": stamp, "recovered_at": stamp}
        if root["state"] == "registered":
            reclaimed.update({key: "9" * 20 for key in ("device", "inode", "parent_device", "parent_inode")})
            covered = {**root, "state": "covered", "covered_by": root["path"], "reclaimed_at": stamp}
            reclaimed = max((reclaimed, covered), key=lambda entry: len(json.dumps(entry, separators=(",", ":")).encode()))
        elif root["state"] == "covered":
            reclaimed = {**root, "reclaimed_at": stamp}
        settled["roots"].append(reclaimed)
    settled["errors"].append({"cause": "\U0001F600" * MAX_ERROR_CHARACTERS, "path": None, "at": stamp, "recovered_at": stamp})
    return len(json.dumps(settled, separators=(",", ":")).encode())


def _consolidate_errors(value: dict) -> None:
    errors = value["errors"]
    if not errors:
        return
    if value["version"] == 1:
        # Historical release depends on the path, failure kind and latest time.
        latest = {}
        for error in sorted(errors, key=lambda item: item["at"]):
            latest[(error["path"], error["cause"] == "resources_unknown")] = error
        value["errors"] = list(latest.values())
        return
    latest = max(errors, key=lambda item: item["at"])
    summary = {"cause": latest["cause"], "path": None, "at": latest["at"]}
    recovered = min(error.get("recovered_at", 0) for error in errors)
    namespace = value["namespace"]
    if namespace["state"] == "settled" and recovered >= max(
            summary["at"], namespace["settled_at"],
            *(root.get("reclaimed_at", float("inf")) for root in value["roots"])):
        summary["recovered_at"] = max(error["recovered_at"] for error in errors)
    # A namespace-wide blocker cannot borrow an individual path's recovery or
    # let an earlier acknowledgement cover a later failure.
    value["errors"] = [summary]


def _write(conn: sqlite3.Connection, call_id: str, value: dict, *, reserve: bool = False) -> None:
    for error in value["errors"]:
        error["cause"] = error["cause"][:MAX_ERROR_CHARACTERS]
    if _settlement_size(value) > MAX_RECEIPT_BYTES:
        _consolidate_errors(value)
    encoded = json.dumps(value, separators=(",", ":"))
    if len(encoded.encode()) > MAX_RECEIPT_BYTES or reserve and _settlement_size(value) > MAX_RECEIPT_BYTES:
        raise RuntimeError("native resource ownership receipt exceeds its size limit")
    if conn.execute("update calls set resource_ownership=? where id=? and resources_settled_at is null",
                    (encoded, call_id)).rowcount != 1:
        raise RuntimeError("native Call no longer owns unsettled resources")


def request_namespace(database: Path, call_id: str, scope) -> None:
    with _database(database) as conn:
        conn.execute("begin immediate")
        value = read(conn, call_id)
        namespace = value.get("namespace")
        if not namespace or namespace != {"state": "requested", "callId": call_id, "correlation": scope.key["correlation"]}:
            raise RuntimeError("native namespace request differs from its original claim")
        # The socket address and retirement token are private Caller state.
        # They never enter the public log DTO or canonical journal evidence.
        changed = conn.execute("update calls set namespace_control=? where id=? and namespace_control is null "
                               "and status='running' and resources_settled_at is null",
                               (json.dumps({"address": scope.address, **scope.key}), call_id)).rowcount
        if changed != 1:
            raise RuntimeError("native namespace already has an original controller")


def register_namespace(database: Path, call_id: str, receipt: dict) -> None:
    with _database(database) as conn:
        conn.execute("begin immediate")
        value = read(conn, call_id)
        namespace = value.get("namespace")
        if not namespace or namespace["state"] != "requested" or namespace["callId"] != receipt["callId"] \
                or namespace["correlation"] != receipt["correlation"] or value["roots"]:
            raise RuntimeError("native namespace registration conflicts with its original admission")
        row = conn.execute("select namespace_control,process_identity,pid from calls where id=?", (call_id,)).fetchone()
        expected = {"address": receipt["controller"], **{key: receipt[key] for key in ("callId", "correlation", "token")}}
        if row is None or json.loads(row[0] or "null") != expected:
            raise RuntimeError("native namespace registration lacks its original private controller")
        original = json.loads(row[1] or "null")
        binding = receipt["binding"]
        if not isinstance(original, dict) or not isinstance(original.get("epoch"), dict) \
                or binding.get("owner") != {"pid": int(row[2]), "start": original.get("start")} \
                or binding.get("epoch") != {key: str(value) for key, value in original["epoch"].items()}:
            raise RuntimeError("native namespace does not belong to its original Caller identity")
        namespace.update(state="active", controller={"version": 1, "instance": receipt["controller"]["instance"]},
                         binding=receipt["binding"])
        _write(conn, call_id, value)


def settle_namespace(database: Path, call_id: str, scope) -> None:
    # Callers must observe the original retained witness immediately before
    # committing. A missing/replaced controller cannot certify settlement.
    if not scope.read()["empty"]:
        raise RuntimeError("native namespace still owns processes")
    with _database(database) as conn:
        conn.execute("begin immediate")
        value = read(conn, call_id)
        namespace = value.get("namespace")
        if not namespace or namespace["state"] not in ("active", "settled") \
                or namespace.get("binding") != scope.binding or namespace["correlation"] != scope.key["correlation"] \
                or namespace.get("controller") != {"version": 1, "instance": scope.address["instance"]}:
            raise RuntimeError("native settlement differs from its original namespace")
        if namespace["state"] == "active":
            namespace.update(state="settled", settled_at=int(time() * 1000) / 1000)
            value["process_pending"] = False
            _write(conn, call_id, value)


def namespace_not_started(database: Path, call_id: str) -> None:
    from . import process_identity
    with _database(database) as conn:
        conn.execute("begin immediate")
        value = read(conn, call_id)
        namespace = value.get("namespace")
        if not namespace or namespace["state"] != "requested" or value["roots"]:
            raise RuntimeError("native no-GO evidence conflicts with allocated resources")
        row = conn.execute("select process_identity from calls where id=?", (call_id,)).fetchone()
        if not row or not process_identity.owns_registration(row[0]):
            raise RuntimeError("native no-GO evidence requires its original Caller")
        namespace.update(state="not_started", no_effect="original-no-go", settled_at=int(time() * 1000) / 1000)
        _write(conn, call_id, value)


def binding() -> tuple[Path, str] | None:
    database, call_id = os.environ.get("AGENT_INTERFACE_RECEIPT_DB"), os.environ.get("AGENT_INTERFACE_RECEIPT_CALL")
    if not database and not call_id:
        return None
    if not database or not call_id:
        raise RuntimeError("native resource ownership lacks its Call binding")
    with _database(Path(database)) as conn:
        row = conn.execute("select source from calls where id=?", (call_id,)).fetchone()
    if row is None:
        raise RuntimeError("resource ownership binding does not identify a Call")
    if row[0] != "poise:behavior-chain":
        return None
    return Path(database), call_id


def original_scope(database: Path, call_id: str, value: dict):
    from . import native_namespace
    namespace = value.get("namespace")
    if value.get("version") != 2 or not namespace or namespace.get("state") not in {"active", "settled"}:
        raise RuntimeError("native resources lack their original namespace binding")
    with _database(database) as conn:
        row = conn.execute("select namespace_control from calls where id=?", (call_id,)).fetchone()
    private = json.loads(row[0] or "null") if row else None
    if not isinstance(private, dict) or private.get("callId") != call_id \
            or private.get("correlation") != namespace["correlation"] \
            or namespace.get("controller") != {"version": 1, "instance": private.get("address", {}).get("instance")}:
        raise RuntimeError("native resources lack their original private controller")
    scope = native_namespace.active()
    if scope is not None:
        if scope.address != private["address"] or scope.key != {key: private[key] for key in ("callId", "correlation", "token")} \
                or scope.binding != namespace["binding"]:
            raise RuntimeError("native resource scope belongs to another Call")
        return scope
    return native_namespace.Namespace.restore(private, namespace["binding"])


def allocate(database: Path, call_id: str, root: Path) -> Path:
    from . import caller_store
    caller_store.require_current_path(database.parent)
    with _database(database) as conn:
        conn.execute("begin immediate")
        value = read(conn, call_id)
        # A v2 path names the original metadata root; resolving a replaced
        # native-resources ancestor would silently adopt a foreign location.
        root = root.absolute() if value["version"] == 2 else root.parent.resolve() / root.name
        if value["version"] == 2 and conn.execute("select status from calls where id=?", (call_id,)).fetchone()[0] != "running":
            raise RuntimeError("terminal native Calls cannot allocate resources")
        if value["version"] == 2:
            names = root.relative_to((database.parent / "native-resources").absolute()).parts
            if not names or names[0] not in {call_id, f"{call_id}-preparation"} or any(name in {".", ".."} for name in names):
                raise RuntimeError("native resource allocation is outside its original Call")
        if any(entry["path"] == str(root) for entry in value["roots"]):
            raise RuntimeError("native resource directory was already registered")
        value["roots"].append({"path": str(root), "state": "registered"})
        _write(conn, call_id, value, reserve=True)
    # A crash before the next transaction retains the registered, incomplete
    # root. No cleaner may infer that incomplete registration means no disk.
    if value["version"] == 2:
        from . import native_namespace
        scope = original_scope(database, call_id, value)
        if native_namespace.active() is not scope:
            raise RuntimeError("native allocation requires its original active namespace")
        proof = scope.resource("allocate-root", root)
        if proof["state"] != "allocated" or proof["unlinked"]:
            raise RuntimeError("native allocation lacks its original live directory handle")
        identity = {key: proof[key] for key in ("device", "inode", "parent_device", "parent_inode")}
    else:
        root.mkdir(mode=0o700, parents=True)
        parent = root.parent.stat()
        node = root.lstat()
        if not stat.S_ISDIR(node.st_mode) or node.st_uid != os.getuid() or node.st_mode & 0o077:
            raise RuntimeError("native resource directory is not private and owned")
        identity = {"device": str(node.st_dev), "inode": str(node.st_ino),
                    "parent_device": str(parent.st_dev), "parent_inode": str(parent.st_ino)}
    with _database(database) as conn:
        conn.execute("begin immediate")
        value = read(conn, call_id)
        entry = next(entry for entry in value["roots"] if entry["path"] == str(root))
        entry.update(state="allocated", **identity)
        _write(conn, call_id, value)
    return root


def failure(database: Path, call_id: str, cause: str, root: Path | None = None) -> None:
    with _database(database) as conn:
        conn.execute("begin immediate")
        value = read(conn, call_id)
        evidence = {"cause": cause[:MAX_ERROR_CHARACTERS], "path": str(root) if root else None}
        previous = next((item for item in value["errors"] if all(item.get(key) == val for key, val in evidence.items())), None)
        if previous is None:
            value["errors"].append({**evidence, "at": time()})
        else:
            previous["at"] = time()
            previous.pop("recovered_at", None)
        _write(conn, call_id, value)


def released(value: dict | None) -> bool:
    if not healthy(value):
        return False
    if value["version"] == 2 and value["namespace"]["state"] not in {"settled", "not_started"}:
        return False
    return all(entry.get("state") in {"reclaimed", "covered"} for entry in value["roots"])


def healthy(value: dict | None) -> bool:
    if not isinstance(value, dict) or value.get("version") not in (1, 2) or value.get("process_pending") is True \
            or not isinstance(value.get("roots"), list) or not isinstance(value.get("errors"), list):
        return False
    if value["version"] == 2 and (not isinstance(value.get("namespace"), dict)
                                  or value["namespace"].get("state") not in ("active", "settled", "not_started")):
        return False
    roots = {entry["path"]: entry for entry in value["roots"]}
    def recovered(item):
        stamp = item.get("recovered_at", 0)
        return value["version"] == 2 and value["namespace"]["state"] == "settled" \
            and stamp >= max(item["at"], value["namespace"]["settled_at"]) \
            and all(root.get("state") in {"reclaimed", "covered"} and stamp >= root["reclaimed_at"] for root in roots.values())
    return all(recovered(item) or item.get("cause") != "resources_unknown" and item.get("path") in roots
               and roots[item["path"]].get("recovered_at", 0) >= item["at"] for item in value["errors"])


def process_check(database: Path, call_id: str, *, complete: bool = False) -> None:
    with _database(database) as conn:
        conn.execute("begin immediate")
        value = read(conn, call_id)
        value["process_pending"] = not complete
        _write(conn, call_id, value)


def publication_released(settled_at, encoded: str | None, artifact: dict) -> bool:
    value = json.loads(encoded) if encoded else None
    uncertain = artifact.get("resource_error") or artifact.get("phase") == "resources_unknown"
    recovered = artifact.get("resource_recovered_at", 0)
    covering = value and value["version"] == 2 and value["errors"] \
        and all(error.get("recovered_at", 0) >= error["at"] and recovered >= error["recovered_at"] for error in value["errors"])
    return settled_at is not None and released(value) and (not uncertain or covering)


def _remove_directory(parent_fd: int, name: str, device: int, inode: int, *, deadline: float | None = None) -> None:
    try:
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
    except PermissionError:
        if not hasattr(os, "O_PATH"):
            raise RuntimeError("unreadable resource repair requires Linux directory handles") from None
        pinned = os.open(name, os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        try:
            node = os.fstat(pinned)
            if (node.st_dev, node.st_ino) != (device, inode) or node.st_uid != os.getuid() or not stat.S_ISDIR(node.st_mode):
                raise RuntimeError("unreadable resource identity changed before permission repair")
            # This is the original kernel handle, not the mutable entry name.
            os.chmod(f"/proc/self/fd/{pinned}", stat.S_IMODE(node.st_mode) | stat.S_IRWXU)
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        finally:
            os.close(pinned)
    try:
        node = os.fstat(fd)
        if (node.st_dev, node.st_ino) != (device, inode):
            raise RuntimeError("native resource directory changed before opening")
        os.fchmod(fd, stat.S_IMODE(node.st_mode) | stat.S_IRWXU)
        with os.scandir(fd) as children:
            for child in children:
                if deadline is not None and monotonic() >= deadline:
                    raise TimeoutError("native cleanup pass yielded at its deadline")
                info = child.stat(follow_symlinks=False)
                if info.st_dev != node.st_dev:
                    raise RuntimeError("native resource cleanup crosses a filesystem boundary")
                if stat.S_ISDIR(info.st_mode):
                    _remove_directory(fd, child.name, info.st_dev, info.st_ino, deadline=deadline)
                else:
                    os.unlink(child.name, dir_fd=fd)
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if (current.st_dev, current.st_ino) != (device, inode):
            raise RuntimeError("native resource directory changed before unlinking")
        os.rmdir(name, dir_fd=parent_fd)
    finally:
        os.close(fd)


def _cleanup_native(database: Path, call_id: str, value: dict, entry: dict, claim: str | None, deadline: float | None) -> dict:
    from . import native_namespace, process_identity
    scope = original_scope(database, call_id, value)
    if native_namespace.active() is not scope:
        with _database(database) as conn:
            row = conn.execute("select process_identity,resource_cleanup from calls where id=?", (call_id,)).fetchone()
        cleaner = json.loads(row[1] or "null")
        if not process_identity.owns_registration(row[0]) and (not isinstance(cleaner, dict)
                or cleaner.get("token") != claim or not process_identity.owns_registration(cleaner.get("owner"))):
            raise RuntimeError("native cleanup lacks its original owner or current cleanup claim")
    if value["namespace"]["state"] == "active":
        if native_namespace.active() is not scope:
            raise RuntimeError("native disk cleanup lacks its original live or settled namespace")
        scope.require_idle()
    elif not scope.read()["empty"]:
        raise RuntimeError("original native namespace is not empty")
    root = Path(entry["path"])
    proof = scope.resource("read-root", root)
    fields = ("device", "inode", "parent_device", "parent_inode")
    if entry["state"] != "registered" and any(entry.get(key) != proof[key] for key in fields):
        raise RuntimeError("native resource differs from its original directory handle")
    if proof["state"] == "allocated" and not proof["unlinked"]:
        repaired = scope.resource("repair-root", root)
        if repaired != proof:
            raise RuntimeError("original native resource changed during permission repair")
        anchor = proof["anchor"]
        if native_namespace.active() is scope:
            # PID 2 cannot borrow a parent user namespace's procfs handles.
            # Its normal path is accepted only against the still-pinned
            # parent identity; replacement defers to the outer cleaner.
            parent_fd = os.open(root.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        else:
            # This descriptor link duplicates the original anchored parent,
            # including after an ancestor pathname has been replaced.
            parent_fd = os.open(f"/proc/{anchor['pid']}/fd/{anchor['parentFd']}/", os.O_RDONLY | os.O_DIRECTORY)
        try:
            parent = os.fstat(parent_fd)
            if (str(parent.st_dev), str(parent.st_ino)) != (proof["parent_device"], proof["parent_inode"]) \
                    or scope.resource("read-root", root) != proof:
                raise RuntimeError("original native directory handle changed before cleanup")
            _remove_directory(parent_fd, root.name, int(proof["device"]), int(proof["inode"]), deadline=deadline)
        finally:
            os.close(parent_fd)
    reclaimed = scope.resource("finish-root", root)
    if reclaimed["state"] != "reclaimed" or any(reclaimed[key] != proof[key] for key in fields):
        raise RuntimeError("original native resource reclamation was not confirmed")
    return reclaimed


def cleanup(database: Path, call_id: str, root: Path, *, claim: str | None = None, deadline: float | None = None) -> bool:
    from . import issue_review
    with _database(database) as conn:
        value = read(conn, call_id)
    if value["version"] == 1:
        root = root.parent.resolve() / root.name
    if value.get("process_pending") or value["version"] == 1 and any(item["cause"] == "resources_unknown" for item in value["errors"]):
        return False
    entry = next((entry for entry in value["roots"] if entry["path"] == str(root)), None)
    if entry is None:
        raise RuntimeError("native cleanup lacks a registered directory")
    if entry["state"] in {"reclaimed", "covered"}:
        return True
    if value["version"] == 2:
        try:
            reclaimed = _cleanup_native(database, call_id, value, entry, claim, deadline)
        except (OSError, RuntimeError) as error:
            failure(database, call_id, str(error), root)
            return False
        with _database(database) as conn:
            conn.execute("begin immediate")
            value = read(conn, call_id)
            kept = next(item for item in value["roots"] if item["path"] == str(root))
            if kept != entry:
                raise RuntimeError("native resource ownership changed during cleanup")
            kept.update({key: reclaimed[key] for key in ("state", "device", "inode", "parent_device", "parent_inode", "reclaimed_at")})
            if any(item.get("path") == str(root) and item["at"] <= reclaimed["reclaimed_at"] for item in value["errors"]):
                kept["recovered_at"] = kept["reclaimed_at"]
            _write(conn, call_id, value)
        return True
    try:
        if entry["state"] != "allocated":
            raise RuntimeError("native resource allocation identity is incomplete")
        parent_fd = os.open(root.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            parent = os.fstat(parent_fd)
            node = os.stat(root.name, dir_fd=parent_fd, follow_symlinks=False)
            if tuple(str(item) for item in (parent.st_dev, parent.st_ino, node.st_dev, node.st_ino)) != \
                    (entry["parent_device"], entry["parent_inode"], entry["device"], entry["inode"]) \
                    or not stat.S_ISDIR(node.st_mode):
                raise RuntimeError("native resource directory identity changed")
            # Historical Calls retain their path-scan veto. A version-2 Call
            # uses its original namespace proof; cleanup must not launch an
            # unowned ps helper after that boundary has already ended.
            if value["version"] == 1 and issue_review._cwd_pids(root, require_complete=True) != []:
                raise RuntimeError("native resource directory still has unverified processes")
            _remove_directory(parent_fd, root.name, node.st_dev, node.st_ino)
        finally:
            os.close(parent_fd)
    except (OSError, RuntimeError) as error:
        failure(database, call_id, str(error), root)
        return False
    with _database(database) as conn:
        conn.execute("begin immediate")
        value = read(conn, call_id)
        kept = next(item for item in value["roots"] if item["path"] == str(root))
        if kept != entry:
            raise RuntimeError("native resource ownership changed during cleanup")
        kept.update(state="reclaimed", reclaimed_at=time())
        if any(item.get("path") == str(root) and item["cause"] != "resources_unknown" for item in value["errors"]):
            kept["recovered_at"] = kept["reclaimed_at"]
        _write(conn, call_id, value)
    return True


def acknowledge_recovery(database: Path, call_id: str) -> None:
    with _database(database) as conn:
        value = read(conn, call_id)
    if value["version"] != 2 or not value["errors"]:
        return
    if value["namespace"]["state"] != "settled" or value.get("process_pending") \
            or any(root["state"] not in {"reclaimed", "covered"} for root in value["roots"]):
        raise RuntimeError("native cleanup recovery lacks complete physical proof")
    if not original_scope(database, call_id, value).read()["empty"]:
        raise RuntimeError("original native namespace is not empty")
    with _database(database) as conn:
        conn.execute("begin immediate")
        current = read(conn, call_id)
        if current != value:
            raise RuntimeError("native ownership changed before recovery acknowledgement")
        stamp = time()
        for error in current["errors"]:
            error.setdefault("recovered_at", stamp)
        _write(conn, call_id, current)
        row = conn.execute("select artifact from calls where id=?", (call_id,)).fetchone()
        artifact = json.loads(row[0] or "{}")
        if artifact.get("resource_error") or artifact.get("phase") == "resources_unknown":
            recovered = max(error["recovered_at"] for error in current["errors"])
            if artifact.get("resource_recovered_at", 0) < recovered:
                artifact["resource_recovered_at"] = recovered
            conn.execute("update calls set artifact=? where id=?", (json.dumps(artifact), call_id))


@contextmanager
def temporary_directory(prefix: str):
    bound = binding()
    if bound is None:
        import tempfile
        with tempfile.TemporaryDirectory(prefix=prefix) as directory:
            yield directory
        return
    database, call_id = bound
    # All PR attempts and all three preparation/provider/watch roots live
    # below the same deterministic Call parent, rather than untracked /tmp.
    parent = call_directory(database, call_id)
    with _database(database) as conn:
        value = read(conn, call_id)
    if not any(entry["path"] == str(parent.parent.resolve() / parent.name) for entry in value["roots"]):
        allocate(database, call_id, parent)
    root = allocate(database, call_id, parent / f"{prefix}{uuid4().hex}")
    try:
        yield str(root)
    finally:
        if not cleanup(database, call_id, root):
            raise RuntimeError("native temporary resource cleanup is unverified")


def cleanup_remaining(database: Path, call_id: str, *, claim: str | None = None, deadline: float | None = None) -> None:
    with _database(database) as conn:
        value = read(conn, call_id)
    # Nested temporary directories are acknowledged before their Call parent.
    for entry in sorted(value["roots"], key=lambda item: len(Path(item["path"]).parts), reverse=True):
        if deadline is not None and monotonic() >= deadline:
            return
        if entry["state"] not in {"reclaimed", "covered"}:
            cleanup(database, call_id, Path(entry["path"]), claim=claim, deadline=deadline)
    with _database(database) as conn:
        value = read(conn, call_id)
    if value["version"] != 2 or value["namespace"]["state"] != "settled":
        return
    for entry in value["roots"]:
        if entry["state"] != "registered":
            continue
        ancestors = [root for root in value["roots"] if root["state"] == "reclaimed"
                     and entry["path"].startswith(root["path"] + "/")]
        if not ancestors:
            continue
        ancestor = max(ancestors, key=lambda root: len(root["path"]))
        proof = original_scope(database, call_id, value).resource("read-root", Path(ancestor["path"]))
        if proof["state"] != "reclaimed" or any(ancestor.get(key) != proof[key]
                for key in ("device", "inode", "parent_device", "parent_inode", "reclaimed_at")):
            raise RuntimeError("incomplete native allocation lacks its original ancestor proof")
        with _database(database) as conn:
            conn.execute("begin immediate")
            current = read(conn, call_id)
            kept = next(root for root in current["roots"] if root["path"] == entry["path"])
            if kept != entry:
                raise RuntimeError("native allocation changed before ancestor coverage acknowledgement")
            kept.update(state="covered", covered_by=ancestor["path"], reclaimed_at=proof["reclaimed_at"])
            _write(conn, call_id, current)
