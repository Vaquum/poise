"""Build a pinned diff without downloading bulk data blobs.

A temporary, blob-filtered Git repository supplies Git's own diff semantics.
Only retained paths hydrate blobs; the user's checkout is never changed.
"""
import asyncio
import base64
import json
import os
import re
import signal
import subprocess
import tempfile
import threading
from pathlib import PurePosixPath
from typing import Any

from github_interface.client import GitHubClient

MAX_DIFF_BYTES = 1_350_000
MAX_PACKET_BYTES = 1_450_000  # Leave room for the governed agent policy.
BULK_FILE_BYTES = 32_000
BULK_SUFFIXES = {".json", ".jsonl", ".ndjson", ".csv", ".tsv"}
OPAQUE_SUFFIXES = {".gz", ".zip", ".tar", ".bz2", ".xz", ".7z", ".pdf", ".parquet", ".arrow"}
PACKET_LIMIT_CODE = "review_packet_too_large"


class ReviewPacketTooLarge(RuntimeError):
    pass


def _git(cwd: str, env: dict[str, str], *args: str, limit: int = MAX_DIFF_BYTES, timeout: float = 120) -> bytes:
    # The credential stays out of argv and errors. Every command is read-only
    # against GitHub, and all local writes are inside the temporary directory.
    with tempfile.TemporaryFile() as errors, subprocess.Popen(
        ["git", *args], cwd=cwd, env=env, stdout=subprocess.PIPE,
        stderr=errors, start_new_session=True,
    ) as process:
        def stop() -> None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except PermissionError:
                process.kill()

        timer = threading.Timer(timeout, stop)
        timer.start()
        try:
            stdout = process.stdout.read(limit + 1)
            if len(stdout) > limit:
                stop()
                raise ReviewPacketTooLarge(f"{PACKET_LIMIT_CODE}: retained review diff exceeds {limit} bytes")
            if process.wait():
                raise RuntimeError(f"review diff git {args[0]} failed (exit {process.returncode})")
            return stdout
        finally:
            timer.cancel()
            if process.poll() is None:
                stop()


def _env(token: str) -> dict[str, str]:
    env = os.environ.copy()
    # Isolate hooks, credential helpers, replace refs, diff drivers, and user Git
    # config. The actor's token is the only network credential in this repo.
    for key in list(env):
        if key.startswith("GIT_"):
            del env[key]
    credential = base64.b64encode(f"x-access-token:{token}".encode()).decode()
    env.update({
        "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_TERMINAL_PROMPT": "0", "GIT_NO_REPLACE_OBJECTS": "1",
        "GIT_CONFIG_COUNT": "3",
        "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
        "GIT_CONFIG_VALUE_0": f"AUTHORIZATION: basic {credential}",
        "GIT_CONFIG_KEY_1": "credential.helper", "GIT_CONFIG_VALUE_1": "",
        "GIT_CONFIG_KEY_2": "core.hooksPath", "GIT_CONFIG_VALUE_2": os.devnull,
    })
    return env


def _changes(raw: bytes) -> list[dict[str, Any]]:
    fields = raw.decode("utf-8").rstrip("\0").split("\0") if raw else []
    files = []
    for i in range(0, len(fields), 2):
        old_mode, new_mode, old_oid, new_oid, status = fields[i].lstrip(":").split()
        files.append({
            "filename": fields[i + 1], "status": status,
            "old_mode": old_mode, "new_mode": new_mode,
            "old_oid": old_oid, "new_oid": new_oid,
        })
    return files


async def _blob_sizes(client: GitHubClient, owner: str, repo: str, files: list[dict[str, Any]]) -> dict[str, int]:
    # Git cannot answer blob sizes in a partial clone without fetching them.
    # GraphQL returns size metadata without the blob content.
    oids = sorted({f[key] for f in files for key in ("old_oid", "new_oid")
                   if f[key] != "0" * 40 and f[key.replace("oid", "mode")] != "160000"})
    sizes: dict[str, int] = {}
    for offset in range(0, len(oids), 100):
        batch = oids[offset:offset + 100]
        fields = " ".join(f'b{i}: object(oid: "{oid}") {{ ... on Blob {{ byteSize }} }}' for i, oid in enumerate(batch))
        data = await client.graphql(
            "query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { " + fields + " } }",
            {"owner": owner, "repo": repo},
        )
        for i, oid in enumerate(batch):
            value = (data.get("repository") or {}).get(f"b{i}")
            if not isinstance(value, dict) or not isinstance(value.get("byteSize"), int):
                raise RuntimeError("review diff blob metadata is incomplete")
            sizes[oid] = value["byteSize"]
    return sizes


def _excluded(file: dict[str, Any], sizes: dict[str, int], compact: bool | None = False) -> str | None:
    if compact is None:
        return None
    path = PurePosixPath(file["filename"])
    if {file["old_mode"], file["new_mode"]} & {"120000", "160000"}:
        return None  # Preserve symlink targets and submodule commits.
    size = sum(sizes.get(file[key], 0) for key in ("old_oid", "new_oid"))
    # Installed Python dependencies and generated bytecode are not project
    # source. Retain dependency manifests and environment entrypoints.
    parts = path.parts
    if (len(parts) >= 5 and parts[0] in {"venv", ".venv"}
            and parts[1] in {"lib", "lib64"} and re.fullmatch(r"python\d+(?:\.\d+)*", parts[2])
            and parts[3] == "site-packages"):
        return "installed Python dependency"
    if "__pycache__" in parts and path.suffix.lower() in {".pyc", ".pyo"}:
        return "generated Python bytecode"
    if ({"captures", "raw"} <= set(path.parts)
            and path.suffix.lower() in {".md", ".txt", ".html", ".htm"}
            and (size > BULK_FILE_BYTES or compact)):
        return f"raw captured data ({size} bytes across base and head)"
    if path.suffix.lower() in OPAQUE_SUFFIXES:
        return "archive or document payload"
    fixture = bool({"test", "tests", "fixtures", "__fixtures__"} & set(path.parts))
    if path.suffix.lower() in BULK_SUFFIXES and (size > BULK_FILE_BYTES or (compact and not fixture)):
        # Manifests/configuration remain reviewable even when unusually large.
        name = path.name.lower()
        if (name in {"package.json", "tsconfig.json", "composer.json"}
                or any(word in name for word in ("config", "schema", "manifest"))
                or {"config", "configs", "configuration", "schema", "schemas", "manifests", ".github", ".vscode", ".devcontainer"} & set(path.parts)):
            return None
        return f"bulk data ({size} bytes across base and head)"
    return None


async def review_diff(
    client: GitHubClient, owner: str, repo: str, pull: dict[str, Any],
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    head = pull["head"]["sha"]
    base = pull["base"]["sha"]
    # GitHub returns file patches only on comparison page 1. Page 2 gives us
    # the merge base without downloading the full patch-heavy comparison.
    comparison = await client.get(
        f"/repos/{owner}/{repo}/compare/{base}...{head}",
        params={"page": 2, "per_page": 1},
    )
    merge_base = comparison["merge_base_commit"]["sha"]
    env = _env(client.token)
    with tempfile.TemporaryDirectory(prefix="caller-review-") as directory:
        async def git(*args: str, limit: int = MAX_DIFF_BYTES) -> bytes:
            return await asyncio.to_thread(_git, directory, env, *args, limit=limit)

        await git("init", "--bare", "--quiet", "--template=")
        await git("remote", "add", "origin", f"https://github.com/{owner}/{repo}.git")
        await git("config", "remote.origin.promisor", "true")
        await git("config", "remote.origin.partialclonefilter", "blob:none")
        await git("fetch", "--quiet", "--no-tags", "--depth=1", "--filter=blob:none", "origin", merge_base, head)
        raw = await git("diff", "--raw", "--no-abbrev", "--no-renames", "-z", merge_base, head, "--", limit=4_000_000)
        files = _changes(raw)
        sizes = await _blob_sizes(client, owner, repo, files)
        # Keep ordinary PRs unchanged. When full blob inputs already exceed
        # the budget, exclude bulk data before Git can download those blobs.
        input_bytes = sum(sizes.get(f[key], 0) for f in files for key in ("old_oid", "new_oid"))
        passes = (None, False, True) if input_bytes <= MAX_DIFF_BYTES else (False, True)
        for compact in passes:
            excluded = []
            retained = []
            for file in files:
                reason = _excluded(file, sizes, compact)
                if reason:
                    excluded.append({"path": file["filename"], "reason": reason})
                else:
                    retained.append(file["filename"])
            retained_paths = set(retained)
            # Literal pathspecs cannot interpret a filename as an option, glob
            # or exclusion. Git supplies complete hunks, renames and modes.
            try:
                diff = (await git(
                    "-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv",
                    "--find-renames", merge_base, head, "--",
                    *(f":(literal){path}" for path in retained),
                )).decode("utf-8", errors="replace") if retained else ""
                packet = {
                    "diff": diff,
                    "files": [{"filename": f["filename"],
                               "status": {"A": "added", "D": "removed", "M": "modified", "T": "changed"}[f["status"]],
                               "old_mode": f["old_mode"], "new_mode": f["new_mode"]} for f in files if f["filename"] in retained_paths],
                    "excluded_files": excluded,
                    "merge_base_sha": merge_base,
                    "review_scope": "Review the complete retained diff. Excluded file contents were not reviewed; do not infer their correctness from this packet.",
                }
                packet_bytes = len(json.dumps({**(context or {}), **packet}, indent=2).encode("utf-8"))
                if packet_bytes > MAX_PACKET_BYTES:
                    raise ReviewPacketTooLarge(f"{PACKET_LIMIT_CODE}: retained review packet exceeds {MAX_PACKET_BYTES} bytes")
                return packet
            except ReviewPacketTooLarge:
                if compact:
                    raise
        raise AssertionError("review packet compaction did not finish")
