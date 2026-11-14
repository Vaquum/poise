"""Private inspection evidence from a failed validation's original archive."""
from __future__ import annotations

import base64
from contextlib import closing
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sqlite3
import stat
import subprocess
import tarfile
from time import time

from . import caller_store, resource_ownership

MAX_BYTES = 2 * 1024 * 1024
RETENTION_SECONDS = 30 * 24 * 60 * 60
SOURCE_SUFFIXES = frozenset(".py .ts .tsx .mts .cts .js .jsx .mjs .cjs .rs .sh .json .toml .yaml .yml .html .css .scss .md .sql .go .c .h .cpp .java .vue .svelte".split())


def _poise_database() -> Path:
    path = Path(os.environ.get("POISE_DB", Path.home() / ".poise" / "cache.db")).absolute()
    if os.environ.get("POISE_DB") == ":memory:" or not path.is_relative_to(Path.home().resolve()) \
            or path.parent.resolve() != path.parent:
        raise ValueError("workspace artifact location unavailable")
    return path


def _directory() -> int:
    root = _poise_database().parent / "incident-recovery"
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    node = os.fstat(fd)
    if node.st_uid != os.getuid() or node.st_mode & 0o077:
        os.close(fd)
        raise ValueError("workspace artifact directory is not private")
    return fd


def _call(database: Path, call_id: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{32}", call_id):
        raise ValueError("invalid source Call")
    with closing(caller_store.connect(database)) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute("select * from calls where id=?", (call_id,)).fetchone()
    if row is None or row["source"] != "poise:behavior-chain" or row["behavior"] != "implement_issue":
        raise ValueError("source Call is unavailable in this workspace")
    return dict(row)


def _unpublished(row: dict, artifact: dict) -> bool:
    return artifact.get("phase") == "executing" and not any(artifact.get(key) is not None for key in (
        "plan_sha", "publication", "result", "publication_head", "replies_started", "receipts")) \
        and not row["action_plan"] and not row["receipts"] and not row["head_sha"]


def _failed_unpublished(row: dict, artifact: dict) -> bool:
    return row["status"] == "failed" \
        and row["action"] == "not_started" and row["outcome"] == "preflight_failed" and _unpublished(row, artifact)


def _git(checkout: Path, *args: str) -> bytes:
    return subprocess.run(["git", "-C", str(checkout), *args], check=True, capture_output=True, timeout=30).stdout


def _changes(archive: Path, checkout: Path, base: str) -> list[dict]:
    if _git(checkout, "rev-parse", "HEAD").decode().strip() != base:
        raise ValueError("capture base mismatch")
    tracked = {}
    for entry in _git(checkout, "ls-tree", "-rz", base).split(b"\0"):
        if not entry:
            continue
        info, name = entry.split(b"\t", 1)
        mode, kind, digest = info.decode().split()
        if kind != "blob":
            raise ValueError("nested repository capture is unavailable")
        tracked[name.decode()] = (mode, digest)
    algorithm = _git(checkout, "rev-parse", "--show-object-format").decode().strip()
    prefix = checkout.as_posix().lstrip("/") + "/"
    seen, changes = set(), []
    size = 0
    with tarfile.open(archive, "r|*") as tree:
        for entry in tree:
            if not entry.name.startswith(prefix):
                continue
            name = entry.name[len(prefix):]
            path = PurePosixPath(name)
            if not name or path.is_absolute() or ".." in path.parts or ".git" in path.parts:
                continue
            if entry.isdir():
                continue
            if name not in tracked and (any(part in {"node_modules", ".venv", "venv"} for part in path.parts)
                                        or path.suffix not in SOURCE_SUFFIXES and path.name not in {"Dockerfile", "Makefile"}):
                continue
            if name in seen:
                raise ValueError("duplicate captured source")
            seen.add(name)
            mode = "120000" if entry.issym() else "100755" if entry.mode & 0o100 else "100644"
            if entry.issym():
                data = entry.linkname.encode()
                digest = hashlib.new(algorithm, b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
            elif entry.isfile():
                hasher = hashlib.new(algorithm, b"blob " + str(entry.size).encode() + b"\0")
                parts = []
                with tree.extractfile(entry) as source:
                    while chunk := source.read(64 * 1024):
                        hasher.update(chunk)
                        if entry.size <= MAX_BYTES:
                            parts.append(chunk)
                data, digest = b"".join(parts), hasher.hexdigest()
            else:
                raise ValueError("captured source is not a file or symlink")
            if tracked.get(name) == (mode, digest):
                continue
            size += entry.size if entry.isfile() else len(data)
            if size > MAX_BYTES:
                raise ValueError("source evidence exceeds its byte limit")
            changes.append({"path": name, "mode": mode, "content": base64.b64encode(data).decode()})
    changes.extend({"path": name, "mode": None, "content": None} for name in tracked.keys() - seen)
    return sorted(changes, key=lambda change: change["path"])


def capture(database: Path, archive: Path, spec: Path, candidate: str, run: str, exit_code: int) -> dict:
    """Only the first completed failed validation is retained; later edits cannot replace it."""
    call_id = os.environ.get("AGENT_INTERFACE_FAILED_SOURCE_CALL", "")
    row = _call(database, call_id)
    artifact = json.loads(row["artifact"] or "{}")
    if row["status"] != "running" or not _unpublished(row, artifact) \
            or not re.fullmatch(r"[0-9a-f]{64}", candidate) or not re.fullmatch(r"[0-9a-f]{32}", run) \
            or not 1 <= exit_code <= 255:
        raise ValueError("failed validation lacks its original unpublished Call")
    if "failed_source" in artifact:
        return artifact["failed_source"]
    metadata = {"status": "unavailable", "candidate": candidate, "run": run}
    fd = None
    name = f"failed-source-{call_id}-{run}.json"
    written = False
    try:
        request_bytes = spec.read_bytes()
        request = json.loads(request_bytes)
        checkout = Path(artifact["prepared"]["path"])
        base = artifact["prepared"]["checkout_head"]
        if not re.fullmatch(r"[0-9a-f]{40}", base) or not Path(request["cwd"]).is_relative_to(checkout) \
                or checkout != Path(artifact["resource_root"]) / "repo":
            raise ValueError("capture checkout mismatch")
        # The runner and the box hash the specification plus the uncompressed
        # tar stream, so a gzipped archive is verified after decompression.
        digest = hashlib.sha256(request_bytes)
        with archive.open("rb") as raw:
            gzipped = raw.read(2) == b"\x1f\x8b"
            raw.seek(0)
            if gzipped:
                with gzip.GzipFile(fileobj=raw) as source:
                    while chunk := source.read(1024 * 1024):
                        digest.update(chunk)
            else:
                while chunk := raw.read(1024 * 1024):
                    digest.update(chunk)
        if digest.hexdigest() != candidate:
            raise ValueError("candidate capture mismatch")
        payload = json.dumps({"call": call_id, "candidate": candidate, "run": run, "base": base,
                              "changes": _changes(archive, checkout, base)}, separators=(",", ":")).encode()
        if len(payload) > MAX_BYTES:
            raise ValueError("source evidence exceeds its byte limit")
        fd = _directory()
        with os.fdopen(os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd), "wb") as target:
            written = True
            target.write(payload)
            target.flush()
            os.fsync(target.fileno())
        metadata = {"status": "available", "candidate": candidate, "run": run, "base": base,
                    "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest(),
                    "expires_at": int(time()) + RETENTION_SECONDS}
    except (OSError, ValueError, KeyError, TypeError, EOFError, tarfile.TarError, subprocess.SubprocessError):
        # Exception text can contain a source path or payload; only this fixed reason leaves the private store.
        metadata["reason"] = "capture could not be bound or safely retained within the source limit"
        if written:
            os.unlink(name, dir_fd=fd)
    finally:
        if fd is not None:
            os.close(fd)
    with closing(caller_store.connect(database)) as conn, conn:
        changed = conn.execute("update calls set artifact=json_set(artifact,'$.failed_source',json(?)) "
                               "where id=? and status='running' and json_extract(artifact,'$.phase')='executing' "
                               "and json_extract(artifact,'$.failed_source') is null", (json.dumps(metadata), call_id)).rowcount
    if changed != 1:
        if written and metadata["status"] == "available":
            fd = _directory()
            try:
                os.unlink(name, dir_fd=fd)
            finally:
                os.close(fd)
        raise ValueError("source capture no longer owns its original Call")
    return metadata


def discard_unless_failed(database: Path, call_id: str) -> None:
    row = _call(database, call_id)
    artifact = json.loads(row["artifact"] or "{}")
    metadata = artifact.get("failed_source")
    if not isinstance(metadata, dict) or _failed_unpublished(row, artifact):
        return
    if metadata.get("status") == "available":
        if not re.fullmatch(r"[0-9a-f]{32}", str(metadata.get("run"))):
            raise ValueError("invalid retained source run identity")
        fd = _directory()
        try:
            try:
                os.unlink(f"failed-source-{call_id}-{metadata['run']}.json", dir_fd=fd)
            except FileNotFoundError:
                # Retention may already have expired this evidence.
                pass
        finally:
            os.close(fd)
    with closing(caller_store.connect(database)) as conn, conn:
        conn.execute("update calls set artifact=json_remove(artifact,'$.failed_source') where id=?", (call_id,))


def inspect(database: Path, call_id: str, candidate: str, run: str) -> dict:
    """Return a private file location, never source bytes, to the linked remediation Call."""
    unavailable = {"status": "unavailable", "reason": "source evidence is absent, expired, mismatched or not authorized; reproduce afresh"}
    fd = None
    try:
        original = _call(database, call_id)
        reader = _call(database, os.environ.get("AGENT_INTERFACE_FAILED_SOURCE_CALL", ""))
        artifact = json.loads(original["artifact"] or "{}")
        metadata = artifact.get("failed_source", {})
        if not _failed_unpublished(original, artifact) or not resource_ownership.publication_released(
                original["resources_settled_at"], original["resource_ownership"], artifact) \
                or reader["status"] != "running" or reader["repo"] != original["repo"] or reader["actor"] != original["actor"] \
                or metadata.get("status") != "available" or metadata.get("candidate") != candidate or metadata.get("run") != run \
                or not re.fullmatch(r"[0-9a-f]{32}", run) or not re.fullmatch(r"[0-9a-f]{64}", candidate) \
                or metadata.get("expires_at", 0) <= time():
            return unavailable
        source = f"{original['repo'].lower()}#{original['pr_id']}"
        key = hashlib.sha256(json.dumps(["atomic_work_blocked", source], separators=(",", ":")).encode()).hexdigest()
        with closing(sqlite3.connect(f"{_poise_database().as_uri()}?mode=ro", uri=True, timeout=1)) as conn:
            report = conn.execute("select value from meta where key=?", ("behavior_chain_repair_report:" + key,)).fetchone()
        report = json.loads(report[0]) if report else {}
        if report.get("source") != source or report.get("pull") is not None or report.get("issueNumber") != int(reader["pr_id"]) \
                or not any(attempt.get("call") == call_id and attempt.get("invocation") == original["correlation_id"]
                           for attempt in report.get("attempts", [])):
            return unavailable
        fd = _directory()
        name = f"failed-source-{call_id}-{run}.json"
        with os.fdopen(os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd), "rb") as source_file:
            node = os.fstat(source_file.fileno())
            if not stat.S_ISREG(node.st_mode) or node.st_uid != os.getuid() or node.st_mode & 0o077 \
                    or node.st_size > MAX_BYTES or node.st_size != metadata.get("bytes"):
                return unavailable
            payload = source_file.read(MAX_BYTES + 1)
        evidence = json.loads(payload)
        if hashlib.sha256(payload).hexdigest() != metadata.get("sha256") \
                or any(evidence.get(key) != value for key, value in {"call": call_id, "candidate": candidate, "run": run, "base": metadata.get("base")}.items()):
            return unavailable
        return {**metadata, "path": str(_poise_database().parent / "incident-recovery" / name)}
    except (OSError, ValueError, KeyError, TypeError, AttributeError, RecursionError, sqlite3.Error):
        return unavailable
    finally:
        if fd is not None:
            os.close(fd)
