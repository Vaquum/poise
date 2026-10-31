"""Evict independent bare mirrors under the same lock used by checkout_repo."""

import fcntl
import os
import re
import shutil
import stat
import subprocess
from pathlib import Path


DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def _measure(descriptor: int) -> tuple[int, float]:
    info = os.fstat(descriptor)
    size, modified = info.st_size, info.st_mtime_ns / 1_000_000
    for _, directories, files, current in os.fwalk(".", dir_fd=descriptor, follow_symlinks=False):
        for name in directories + files:
            info = os.stat(name, dir_fd=current, follow_symlinks=False)
            if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                raise ValueError("mirror contains a symlink or nonregular entry")
            size += info.st_size
            modified = max(modified, info.st_mtime_ns / 1_000_000)
    return size, modified


def _read(descriptor: int, name: str) -> bytes:
    child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
    with os.fdopen(child, "rb") as file:
        if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
            raise ValueError("mirror metadata is not a regular file")
        data = file.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024:
            raise ValueError("mirror metadata is too large to verify")
        return data


def _bare(descriptor: int) -> bool:
    # Git cannot use directory /dev/fd aliases on macOS. Read anchored bytes
    # instead; Git parses only that config, without following include paths.
    try:
        head = _read(descriptor, "HEAD").strip()
        config = _read(descriptor, "config")
        for name in ("objects", "refs"):
            os.close(os.open(name, DIRECTORY_FLAGS, dir_fd=descriptor))
        if head.startswith(b"ref: "):
            ref = head[5:].decode("utf-8")
            checked = subprocess.run(["git", "check-ref-format", ref], capture_output=True, check=False)
            if checked.returncode != 0:
                return False
        elif not re.fullmatch(rb"[a-fA-F0-9]{40}|[a-fA-F0-9]{64}", head):
            return False
    except (OSError, ValueError):
        return False
    result = subprocess.run(
        ["git", "config", "--no-includes", "--file", "-", "--type", "bool", "--get", "core.bare"],
        input=config, capture_output=True, check=False,
    )
    return result.returncode == 0 and result.stdout.strip() == b"true"


def prune_mirrors(root: Path, cap_bytes: int, now_ms: int, fresh_ms: int, dry_run: bool = False) -> dict[str, object]:
    if not root.is_absolute():
        raise ValueError("mirror root must be absolute")
    if any(type(value) is not int or value < 0 for value in (cap_bytes, now_ms, fresh_ms)):
        raise ValueError("mirror cap, time and freshness must be nonnegative integers")
    if not shutil.rmtree.avoids_symlink_attacks:
        raise ValueError("mirror eviction requires symlink-safe directory removal")
    removed: list[dict[str, object]] = []
    held: list[dict[str, object]] = []
    candidates: list[tuple[str, str, int, float]] = []
    try:
        root_fd = os.open(root, DIRECTORY_FLAGS)
    except FileNotFoundError:
        return {"removed": removed, "held": held, "totalBytes": 0}
    except OSError as error:
        raise ValueError(f"cannot open mirror root without following symlinks: {root}: {error}") from error
    try:
        with os.scandir(root_fd) as owners:
            for owner in owners:
                if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]*", owner.name) or not owner.is_dir(follow_symlinks=False):
                    held.append({"path": str(root / owner.name), "reason": "not a regular mirror owner directory"})
                    continue
                try:
                    owner_fd = os.open(owner.name, DIRECTORY_FLAGS, dir_fd=root_fd)
                except OSError as error:
                    held.append({"path": str(root / owner.name), "reason": str(error)})
                    continue
                try:
                    with os.scandir(owner_fd) as repositories:
                        for repository in repositories:
                            path = str(root / owner.name / repository.name)
                            if repository.name.endswith(".lock"):
                                continue
                            if not re.fullmatch(r"[A-Za-z0-9_.-]+\.git", repository.name) or not repository.is_dir(follow_symlinks=False):
                                held.append({"path": path, "reason": "not a regular owner/repo.git mirror"})
                                continue
                            try:
                                mirror_fd = os.open(repository.name, DIRECTORY_FLAGS, dir_fd=owner_fd)
                                try:
                                    size, modified = _measure(mirror_fd)
                                finally:
                                    os.close(mirror_fd)
                                candidates.append((owner.name, repository.name, size, modified))
                            except (OSError, ValueError) as error:
                                held.append({"path": path, "reason": str(error)})
                finally:
                    os.close(owner_fd)
        total = sum(item[2] for item in candidates)
        for owner, name, previous_size, _ in sorted(candidates, key=lambda item: item[3]):
            if total <= cap_bytes:
                break
            path = str(root / owner / name)
            try:
                owner_fd = os.open(owner, DIRECTORY_FLAGS, dir_fd=root_fd)
            except OSError as error:
                held.append({"path": path, "reason": str(error)})
                continue
            try:
                # Never unlink this sibling lock: waiting checkouts must keep
                # coordinating on its original inode after an eviction.
                lock_fd = os.open(name[:-4] + ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=owner_fd)
                try:
                    if not stat.S_ISREG(os.fstat(lock_fd).st_mode):
                        raise ValueError("mirror lock is not a regular file")
                    try:
                        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        held.append({"path": path, "reason": "the Caller mirror lock is busy"})
                        continue
                    mirror_fd = os.open(name, DIRECTORY_FLAGS, dir_fd=owner_fd)
                    try:
                        if not _bare(mirror_fd):
                            held.append({"path": path, "reason": "not a bare Git mirror"})
                            continue
                        size, modified = _measure(mirror_fd)
                        total += size - previous_size
                        if now_ms - modified < fresh_ms:
                            held.append({"path": path, "reason": "mirror or descendant was recently written"})
                            continue
                        owner_info = os.stat(owner, dir_fd=root_fd, follow_symlinks=False)
                        mirror_info = os.stat(name, dir_fd=owner_fd, follow_symlinks=False)
                        if not os.path.samestat(owner_info, os.fstat(owner_fd)) or not os.path.samestat(mirror_info, os.fstat(mirror_fd)):
                            raise ValueError("mirror identity changed during eviction")
                        if not dry_run:
                            shutil.rmtree(name, dir_fd=owner_fd)
                        removed.append({"path": path, "bytes": size})
                        total -= size
                    finally:
                        os.close(mirror_fd)
                finally:
                    os.close(lock_fd)
            except (OSError, ValueError) as error:
                held.append({"path": path, "reason": str(error)})
            finally:
                os.close(owner_fd)
        if total > cap_bytes:
            held.append({"path": str(root), "reason": f"mirrors remain {total - cap_bytes} bytes over the cap; unproved or busy mirrors are kept"})
        return {"removed": removed, "held": held, "totalBytes": total}
    finally:
        os.close(root_fd)
