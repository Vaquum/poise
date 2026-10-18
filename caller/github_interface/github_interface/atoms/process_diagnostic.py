"""Bounded process evidence. Never record argv, stdout, or the environment."""
import base64
import binascii
import errno
import os
import re
import shutil
from datetime import datetime, timezone
from time import monotonic

STDERR_BYTES = 16 * 1024
MARKER = "\n[stderr truncated; incomplete boundary lines omitted]\n"


def redact(text: str, env: dict[str, str]) -> str:
    secrets = {value for key, value in env.items()
               if re.search(r"TOKEN|KEY|SECRET|PASSWORD|AUTH|GIT_CONFIG_VALUE", key, re.I)
               and len(value) >= 8}
    for value in list(secrets):
        match = re.search(r"(?i)authorization: basic ([A-Za-z0-9+/=]+)", value)
        if match:
            secrets.add(match[1])
            try:
                decoded = base64.b64decode(match[1], validate=True).decode("utf-8", errors="replace")
            except binascii.Error:
                # Invalid optional encoding still remains in the verbatim
                # redaction set; it cannot replace the original process error.
                continue
            if ":" in decoded:
                secrets.add(decoded.split(":", 1)[1])
    for value in sorted((value for value in secrets if value), key=len, reverse=True):
        text = text.replace(value, "[redacted]")
    text = re.sub(r"(?im)\b(?:proxy-authorization|authorization|set-cookie|cookie)\s*[:=][^\r\n]*", "[redacted header]", text)
    text = re.sub(r"(?i)\b(?:basic|bearer|token)\s+[^\s,;\"']+", "[redacted credential]", text)
    text = re.sub(r"(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)", "[redacted]", text)
    text = re.sub(r"(https?://)[^\s/@]+@", r"\1[redacted]@", text)
    text = re.sub(r"(?i)([?&](?:token|key|secret|password|auth|signature)=)[^\s&#]+", r"\1[redacted]", text)
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)


class StderrCapture:
    def __init__(self):
        self.first = bytearray()
        self.last = bytearray()
        self.size = 0

    def drain(self, stream):
        while block := stream.read(8192):
            self.size += len(block)
            remaining = STDERR_BYTES // 2 - len(self.first)
            self.first.extend(block[:remaining])
            self.last.extend(block)
            del self.last[:-STDERR_BYTES // 2]

    def evidence(self, env):
        text, truncated = self._evidence(env)
        encoded = text.encode("utf-8")
        if len(encoded) <= STDERR_BYTES:
            return text, truncated
        return (encoded[:STDERR_BYTES // 2].decode("utf-8", errors="replace") + MARKER
                + encoded[-STDERR_BYTES // 2:].decode("utf-8", errors="replace")), True

    def _evidence(self, env):
        truncated = self.size > STDERR_BYTES
        if not truncated:
            raw = bytes(self.first) + bytes(self.last)[max(0, len(self.first) + len(self.last) - self.size):]
            return redact(raw.decode("utf-8", errors="replace"), env).strip(), False
        # A credential may cross the capture boundary. Omit partial lines so
        # neither fragments nor a truncated authentication header can escape.
        first = bytes(self.first).rsplit(b"\n", 1)[0] if b"\n" in self.first else b""
        last = bytes(self.last).split(b"\n", 1)[1] if b"\n" in self.last else b""
        return redact(first.decode("utf-8", errors="replace") + MARKER + last.decode("utf-8", errors="replace"), env).strip(), True


def operation(args: tuple[str, ...]) -> str:
    skip = False
    for arg in args:
        if skip:
            skip = False
        elif arg in ("-c", "-C", "--git-dir", "--work-tree", "--namespace", "--config-env"):
            skip = True
        elif not arg.startswith("-"):
            return arg
    return args[0].lstrip("-") if args else "unknown"


class GitProcessError(RuntimeError):
    def __init__(self, diagnostic: dict):
        self.diagnostic = diagnostic
        state = "timed out" if diagnostic["outcome"] == "timed_out" else diagnostic["outcome"]
        detail = diagnostic["stderr"] or "no stderr was provided; cause unknown"
        super().__init__(f"review git {diagnostic['operation']} {state} "
                         f"(exit {diagnostic['exit_code']}, signal {diagnostic['signal']}, errno {diagnostic['errno']}): {detail}")


class GitTimeoutError(GitProcessError, TimeoutError):
    pass


def failure(cwd, env, args, started, capture, *, process=None, error=None, timed_out=False, timeout=None):
    stderr, truncated = capture.evidence(env)
    code = process.returncode if process else None
    path = cwd.replace(env["HOME"], "~", 1) if env.get("HOME") and cwd.startswith(env["HOME"] + os.sep) else cwd
    resource_failure = (isinstance(error, OSError) and error.errno in (errno.ENOSPC, errno.EDQUOT)) or bool(re.search(r"\bENOSPC\b|No space left on device|Disk quota exceeded", stderr, re.I))
    filesystem = None
    if resource_failure:
        try:
            stat = os.statvfs(cwd)
            filesystem = {"path": redact(path, env), "free_bytes": stat.f_bavail * stat.f_frsize,
                          "total_bytes": stat.f_blocks * stat.f_frsize, "free_inodes": stat.f_favail,
                          "total_inodes": stat.f_files, "measured_at": datetime.now(timezone.utc).isoformat()}
        except OSError as measurement:
            filesystem = {"path": redact(path, env), "free_bytes": None, "total_bytes": None,
                          "free_inodes": None, "total_inodes": None, "measurement_error": redact(str(measurement), env)}
    diagnostic = {
        "version": 1, "source": "caller", "severity": "error", "operation": operation(args), "phase": "git",
        "event_time": datetime.now(timezone.utc).isoformat(), "executable": "git", "resolved_executable": shutil.which("git", path=env.get("PATH")),
        "cwd": redact(path, env), "pid": process.pid if process else None,
        "outcome": "timed_out" if timed_out else "missing_executable" if isinstance(error, FileNotFoundError) else "resource_failure" if resource_failure else "signal" if code is not None and code < 0 else "spawn_error" if error else "exit",
        "exit_code": code if code is not None and code >= 0 else None, "signal": -code if code is not None and code < 0 else None,
        "timeout_seconds": timeout, "errno": error.errno if isinstance(error, OSError) else None,
        "elapsed_ms": round((monotonic() - started) * 1000), "stderr": stderr,
        "stderr_truncated": truncated, "filesystem": filesystem,
        "message": redact(str(error), env) if error else None,
        "workspace": env.get("POISE_WORKSPACE_HANDLE"), "container": env.get("HOSTNAME") if env.get("POISE_MODE") == "service" else None,
        "release": env.get("POISE_RELEASE"),
    }
    diagnostic = {key: redact(value, env) if isinstance(value, str) else value for key, value in diagnostic.items()}
    return (GitTimeoutError if timed_out else GitProcessError)(diagnostic)
