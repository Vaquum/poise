"""Use the supervisor's original Caller metadata, never a replacement path."""
from __future__ import annotations

import atexit
import json
import os
import sqlite3
import stat
from pathlib import Path

_reference: dict | None = None
_descriptors: tuple[int, int] | None = None


def _identity(node: os.stat_result, expected: dict, directory: bool) -> None:
    if (not stat.S_ISDIR(node.st_mode) if directory else not stat.S_ISREG(node.st_mode)) \
            or node.st_uid != os.getuid() \
            or {"device": str(node.st_dev), "inode": str(node.st_ino)} != expected:
        raise RuntimeError("Caller metadata differs from its original workspace directory")


def _close() -> None:
    global _descriptors
    if _descriptors is not None:
        descriptors, _descriptors = _descriptors, None
        failures = []
        for fd in descriptors:
            try:
                os.close(fd)
            except OSError as error:
                failures.append(error)
        if failures:
            raise ExceptionGroup("Caller metadata handles could not close", failures)


atexit.register(_close)


def _store() -> tuple[dict, tuple[int, int]] | None:
    global _reference, _descriptors
    raw = os.environ.get("POISE_NATIVE_CONTROL")
    if raw is None:
        return None
    value = json.loads(raw)
    reference = value.get("store")
    if reference is None:
        return None
    if not isinstance(reference, dict) or set(reference) != {"path", "pid", "directoryFd", "responsesFd", "directory", "database", "responses"} \
            or not isinstance(reference["path"], str) or not Path(reference["path"]).is_absolute() \
            or any(type(reference[key]) is not int or reference[key] < 0 for key in ("pid", "directoryFd", "responsesFd")) \
            or any(not isinstance(reference[key], dict) or set(reference[key]) != {"device", "inode"}
                   or any(not isinstance(number, str) or not number.isdigit() for number in reference[key].values())
                   for key in ("directory", "database", "responses")):
        raise RuntimeError("Caller metadata controller reference is invalid")
    if _reference is not None and reference != _reference:
        raise RuntimeError("Caller metadata controller changed during this process")
    if _descriptors is None:
        if __package__:
            from .native_namespace import control_address, control_request
        else:
            from native_namespace import control_address, control_request
        address = control_address()
        observed = control_request(address, "hello")
        if address.get("store") != reference or observed.get("resourceProtocol") != 2 or observed.get("store") != reference:
            raise RuntimeError("Caller metadata lacks its original live controller handles")
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        opened = []
        try:
            for name, key, fallback in (("directory", "directoryFd", reference["path"]),
                                        ("responses", "responsesFd", str(Path(reference["path"]) / "responses"))):
                fd = None
                try:
                    # Following this procfs link duplicates the original held inode.
                    fd = os.open(f"/proc/{reference['pid']}/fd/{reference[key]}", os.O_RDONLY | os.O_DIRECTORY)
                    _identity(os.fstat(fd), reference[name], True)
                except (FileNotFoundError, PermissionError, NotADirectoryError, RuntimeError):
                    if fd is not None:
                        os.close(fd)
                        fd = None
                if fd is None:
                    # Executed helpers in the private PID namespace cannot see
                    # the outer supervisor. The still-live controller and exact
                    # original inode are both required before using its name.
                    fd = os.open(fallback, flags)
                opened.append(fd)
                _identity(os.fstat(fd), reference[name], True)
            _reference, _descriptors = reference, (opened[0], opened[1])
        except (OSError, RuntimeError, ValueError, KeyError, TypeError):
            for fd in opened:
                os.close(fd)
            raise
    return reference, _descriptors


def directory(path: Path, *, responses: bool = False) -> Path:
    store = _store()
    if store is None:
        return path
    reference, descriptors = store
    expected = Path(reference["path"]) / "responses" if responses else Path(reference["path"])
    if path.absolute() != expected:
        raise RuntimeError("Caller metadata path differs from its configured workspace")
    fd = descriptors[1 if responses else 0]
    _identity(os.fstat(fd), reference["responses" if responses else "directory"], True)
    return Path(f"/proc/self/fd/{fd}")


def connect(path: str | Path, *, timeout: float = 30) -> sqlite3.Connection:
    path = Path(path)
    store = _store()
    if store is None:
        return sqlite3.connect(path, timeout=timeout)
    reference, _ = store
    if path.name != "calls.sqlite3":
        raise RuntimeError("Caller metadata database name differs")
    database = directory(path.parent) / path.name
    # Closing an ordinary file descriptor would release SQLite's POSIX locks
    # on this inode throughout the process, including other live connections.
    _identity(database.lstat(), reference["database"], False)
    return sqlite3.connect(f"{database.as_uri()}?mode=rw", timeout=timeout, uri=True)


def require_current_path(path: Path) -> None:
    store = _store()
    if store is None:
        return
    reference, _ = store
    if path.absolute() != Path(reference["path"]):
        raise RuntimeError("Caller allocation path differs from its original metadata directory")
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        _identity(os.fstat(fd), reference["directory"], True)
    finally:
        os.close(fd)


def response(path: Path, responses: Path) -> Path:
    if _store() is None:
        return path
    if path.parent != responses or path.suffix != ".txt" or len(path.stem) != 32 \
            or any(char not in "0123456789abcdef" for char in path.stem):
        raise RuntimeError("Caller response differs from its original metadata directory")
    return directory(responses, responses=True) / path.name


def response_name(path: Path) -> str:
    return str(path.resolve() if _store() is None else path.absolute())


def open_responses(path: Path) -> int:
    bound = directory(path, responses=True)
    return os.open(bound, os.O_RDONLY | os.O_DIRECTORY | (os.O_NOFOLLOW if _store() is None else 0))
