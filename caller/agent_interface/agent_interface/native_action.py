"""The fixed, non-model GitHub actions admitted by the behavior journal."""
from __future__ import annotations

import hashlib
import json
import os
import re
import selectors
import signal
import sqlite3
import subprocess
import sys
from contextlib import closing
from pathlib import Path
from time import monotonic

from . import atoms, caller_store
from .process_diagnostic import command_failure, diagnostic_envelope, diagnostic_from_stderr

MAX_OUTPUT = 256 * 1024
TIMEOUT_SECONDS = 30
# The command keeps its original 30 seconds. Its containing Call also needs
# time to persist intent/response and unwind before the outer client expires.
CALL_SECONDS = TIMEOUT_SECONDS + 30
COMMANDS = {"--merge-if-ready", "--resolve-nonblocking-conversations-if-ready", "--rerun-grey-ci-if-ready", "--issue-work"}


class NotStarted(RuntimeError):
    """Popen rejected the executable before it could perform an action."""


class ActionFailure(RuntimeError):
    def __init__(self, message: str, diagnostic: dict):
        super().__init__(message)
        self.diagnostic = diagnostic


def process_failure(code: int) -> dict:
    if code >= 0:
        return {"code": code, "signal": None}
    try:
        name = signal.Signals(-code).name
    except ValueError:
        name = f"SIG{-code}"  # Preserve real-time signals without a Python enum member.
    return {"code": None, "signal": name}


def argument(argv: list[str], flag: str) -> str:
    if argv.count(flag) != 1 or argv.index(flag) + 1 >= len(argv):
        raise ValueError(f"native action requires exactly one {flag}")
    return argv[argv.index(flag) + 1]


def validate(argv: list[str], cwd: str, repository: str, actor: str, *, resource_version: bool) -> tuple[dict, str, str]:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]+", repository) \
            or repository.split("/")[1] in {".", ".."} or not Path(cwd).is_absolute() \
            or len(argv) < 2 or argv[0] not in COMMANDS or any(not isinstance(value, str) or "\0" in value for value in argv):
        raise ValueError("native action requires its original fixed command and repository")
    actor = atoms.actor(actor)
    if argument(argv, "--token-user").lower() != actor.lower():
        raise ValueError("native action actor differs from its original admission")
    if "--repository" in argv and argument(argv, "--repository").lower() != repository.lower():
        raise ValueError("native action repository differs from its original admission")
    if not re.fullmatch(r"#?[1-9][0-9]*", argv[1]):
        raise ValueError("native action requires its original positive target number")
    head = atoms.expected_head(argument(argv, "--expected-head"))
    if argv[0] == "--issue-work" and argument(argv, "--mode") != "complete":
        raise ValueError("native action permits only the original issue publication completion")
    request = {"command": "github-interface", "cwd": cwd, "argv": argv}
    if resource_version:
        request["nativeResources"] = 2
    if len(json.dumps(request, ensure_ascii=False).encode()) > MAX_OUTPUT:
        raise ValueError("native action request exceeds its journal bound")
    return request, argv[1].lstrip("#"), head


def resolution_checkpoint(repository: str, number: int, head: str, actor: str,
                          thread_id: str | None = None, result: dict | None = None) -> dict:
    """Commit an attempt, then its accepted reply, in the original managed Call.

    An outstanding attempt cannot be replayed or cleared by observing a closed
    thread. Only its actual mutation response confirms the original action.
    """
    database = os.environ.get("AGENT_INTERFACE_RECEIPT_DB")
    call_id = os.environ.get("AGENT_INTERFACE_RECEIPT_CALL")
    if not database or not call_id or not re.fullmatch(r"[0-9a-f]{32}", call_id):
        raise RuntimeError("conversation resolution lacks its native receipt binding")
    with closing(caller_store.connect(database, timeout=30)) as conn, conn:
        conn.row_factory = sqlite3.Row
        conn.execute("begin immediate")
        row = conn.execute("select * from calls where id=?", (call_id,)).fetchone()
        if not row or row["source"] != "poise:behavior-chain" or row["behavior"] != "native_action" \
                or row["status"] != "running" or row["error_code"] in {"stopping", "stopped"} \
                or row["repo"] != repository or row["pr_id"] != str(number) \
                or row["actor"] != actor or row["expected_head"] != head or not row["action_plan"]:
            raise RuntimeError("conversation resolution differs from its original running Call")
        plan = json.loads(row["action_plan"])
        request = plan.get("request", {})
        artifact = json.loads(row["artifact"] or "{}")
        digest = hashlib.sha256(json.dumps(request, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        if plan.get("kind") != "native_action" or request.get("command") != "github-interface" \
                or artifact.get("phase") != "performing_native_action" or artifact.get("request_sha") != digest \
                or request.get("argv", [None])[0] != "--resolve-nonblocking-conversations-if-ready":
            raise RuntimeError("conversation resolution lacks its original request receipt")
        _, requested_number, requested_head = validate(request["argv"], request["cwd"], repository, actor,
                                                     resource_version=request.get("nativeResources") == 2)
        if requested_number != str(number) or requested_head != head:
            raise RuntimeError("conversation resolution differs from its original target")
        progress = artifact.get("resolution_progress", {"confirmed": [], "pending": None})
        if not isinstance(progress, dict) or set(progress) != {"confirmed", "pending"} \
                or not isinstance(progress["confirmed"], list) \
                or any(not isinstance(item, dict) or set(item) != {"id", "isResolved"}
                       or not isinstance(item["id"], str) or not re.fullmatch(r"[A-Za-z0-9_+=/-]{1,256}", item["id"])
                       or item["isResolved"] is not True for item in progress["confirmed"]) \
                or (progress["pending"] is not None and (not isinstance(progress["pending"], str)
                    or not re.fullmatch(r"[A-Za-z0-9_+=/-]{1,256}", progress["pending"]))):
            raise RuntimeError("invalid native conversation resolution progress")
        confirmed = {item["id"] for item in progress["confirmed"]}
        if len(confirmed) != len(progress["confirmed"]) or progress["pending"] in confirmed:
            raise RuntimeError("contradictory native conversation resolution progress")
        if thread_id is None:
            return progress
        if not isinstance(thread_id, str) or not re.fullmatch(r"[A-Za-z0-9_+=/-]{1,256}", thread_id):
            raise ValueError("conversation resolution requires its exact thread id")
        if result is None:
            if progress["pending"] is not None or thread_id in confirmed:
                raise RuntimeError("conversation resolution cannot replay an attempted thread")
            progress["pending"] = thread_id
        else:
            if progress["pending"] != thread_id or result.get("id") != thread_id or result.get("isResolved") is not True:
                raise RuntimeError("conversation resolution lacks its accepted thread response")
            progress["confirmed"].append({"id": thread_id, "isResolved": True})
            progress["pending"] = None
        artifact["resolution_progress"] = progress
        encoded = json.dumps(artifact)
        if len(encoded.encode()) > 128 * 1024:
            raise RuntimeError("conversation resolution progress exceeds its Call bound")
        conn.execute("update calls set artifact=? where id=?", (encoded, call_id))
        return progress


def execute(argv: list[str], cwd: Path) -> tuple[dict, int]:
    """Same command deadline/output bound as the original Poise call. Every
    child is already inside its registered namespace before Popen/GO.
    """
    try:
        process = subprocess.Popen(["github-interface", *argv], cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as error:
        raise NotStarted("native action executable could not start") from error
    stdout, stderr = bytearray(), bytearray()
    try:
        with selectors.DefaultSelector() as selector:
            for stream, target in ((process.stdout, stdout), (process.stderr, stderr)):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ, target)
            deadline = monotonic() + TIMEOUT_SECONDS
            while selector.get_map():
                remaining = deadline - monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired("github-interface", TIMEOUT_SECONDS)
                for key, _ in selector.select(remaining):
                    data = os.read(key.fd, 64 * 1024)
                    if not data:
                        selector.unregister(key.fileobj)
                        continue
                    key.data.extend(data)
                    if len(stdout) + len(stderr) > MAX_OUTPUT:
                        raise RuntimeError("native action exceeded its output limit")
            remaining = deadline - monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired("github-interface", TIMEOUT_SECONDS)
            code = process.wait(timeout=remaining)
        # Preserve a complete accepted response even if the command reports
        # failure afterward. The production consumer validates its admission.
        try:
            result = json.loads(stdout.decode())
        except (ValueError, UnicodeError) as error:
            evidence = diagnostic_from_stderr(stderr.decode("utf-8", errors="replace"), "native_action") \
                or diagnostic_envelope(operation="github-interface", phase="native_action", outcome="exit",
                                       exit_code=code if code >= 0 else None,
                                       signal=-code if code < 0 else None,
                                       message="Native action returned no valid structured response; action outcome is unknown")
            raise ActionFailure("native action returned no valid structured response", evidence) from error
        if not isinstance(result, dict):
            raise RuntimeError("native action returned no structured response")
        return result, code
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ActionFailure("native action process failed; action outcome is unknown",
                            command_failure(error, "native_action", str(cwd), TIMEOUT_SECONDS)) from error
    finally:
        original = sys.exception()
        process.stdout.close()
        process.stderr.close()
        if process.poll() is None:
            process.kill()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired as error:
                raise BaseExceptionGroup("native action process did not end", ([original] if original else []) + [error])
