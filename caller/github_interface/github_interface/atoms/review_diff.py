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
from time import monotonic
import threading
from pathlib import PurePosixPath
from typing import Any

from github_interface.client import GitHubClient
from .process_diagnostic import GitProcessError, StderrCapture, failure

MAX_DIFF_BYTES = 1_350_000
MAX_PACKET_BYTES = 1_450_000  # Leave room for the governed agent policy.
BULK_FILE_BYTES = 32_000
BULK_SUFFIXES = {".json", ".jsonl", ".ndjson", ".csv", ".tsv"}
OPAQUE_SUFFIXES = {".gz", ".zip", ".tar", ".bz2", ".xz", ".7z", ".pdf", ".parquet", ".arrow"}
FILE_STATUS = {"A": "added", "D": "removed", "M": "modified", "T": "changed"}
PACKET_LIMIT_CODE = "review_packet_too_large"
SINCE_HEAD_UNKNOWN_CODE = "review_since_head_unknown"


class ReviewPacketTooLarge(RuntimeError):
    pass


def _git(cwd: str, env: dict[str, str], *args: str, limit: int = MAX_DIFF_BYTES, timeout: float = 120) -> bytes:
    started = monotonic()
    capture = StderrCapture()
    try:
        process = subprocess.Popen(
            ["git", *args], cwd=cwd, env=env, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, start_new_session=True,
        )
    except OSError as error:
        raise failure(cwd, env, args, started, capture, error=error, timeout=timeout) from error
    with process:
        def stop() -> None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except PermissionError:
                process.kill()

        timed_out = threading.Event()
        def expire() -> None:
            if process.poll() is None:
                timed_out.set()
            stop()

        reader = threading.Thread(target=capture.drain, args=(process.stderr,), daemon=True)
        reader.start()
        timer = threading.Timer(timeout, expire)
        timer.start()
        try:
            stdout = process.stdout.read(limit + 1)
            if len(stdout) > limit:
                stop()
                raise ReviewPacketTooLarge(f"{PACKET_LIMIT_CODE}: retained review diff exceeds {limit} bytes")
            process.wait()
            timer.cancel()
            reader.join(timeout=1)
            if reader.is_alive():
                stop()  # A completed leader may leave inherited stderr open.
                reader.join(timeout=1)
            if process.returncode:
                raise failure(cwd, env, args, started, capture, process=process,
                              timed_out=timed_out.is_set(), timeout=timeout)
            return stdout
        finally:
            timer.cancel()
            if process.poll() is None or reader.is_alive():
                stop()
            process.wait()
            reader.join(timeout=1)


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


async def _bounded_packet(git, files: list[dict[str, Any]], retained: list[str],
                         excluded: list[dict[str, Any]], context: dict[str, Any] | None,
                         merge_base: str, head: str, since: str | None = None) -> dict[str, Any]:
    """The largest verified fitting sorted prefix of retained files, with the
    rest listed explicitly as omitted. A rename-aware diff is not strictly
    monotone in the file set, so the search keeps the largest prefix it
    verified fits instead of assuming every smaller prefix fits."""
    if not retained:
        raise ReviewPacketTooLarge(f"{PACKET_LIMIT_CODE}: retained review packet exceeds {MAX_PACKET_BYTES} bytes")
    ordered = sorted(set(retained))
    meta = {item["filename"]: item for item in files}

    async def probe(count: int) -> dict[str, Any] | None:
        chosen = ordered[:count]
        try:
            diff = (await git(
                "-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv",
                "--find-renames", merge_base, head, "--",
                *(f":(literal){path}" for path in chosen),
            )).decode("utf-8", errors="replace") if chosen else ""
        except ReviewPacketTooLarge:
            return None
        omitted = [{"path": path, "reason": "omitted from the bounded review packet; not reviewed"}
                   for path in ordered[count:]]
        scope = (_since_lede(since) +
                 f"Review the retained diff below. Coverage is partial: {len(omitted)} of {len(ordered)} "
                 f"retained files, listed in omitted_files, were not reviewed; "
                 f"do not infer their correctness from this packet.")
        if excluded:
            scope += " Excluded file contents were not reviewed either; do not infer their correctness from this packet."
        scope += _since_positioning(since)
        packet = {
            "diff": diff,
            "files": [{"filename": path, "status": FILE_STATUS[meta[path]["status"]],
                       "old_mode": meta[path]["old_mode"], "new_mode": meta[path]["new_mode"]} for path in chosen],
            "excluded_files": excluded,
            "omitted_files": omitted,
            "merge_base_sha": merge_base,
            "since_head_sha": since,
            "review_scope": scope,
        }
        if len(json.dumps({**(context or {}), **packet}, indent=2).encode("utf-8")) > MAX_PACKET_BYTES:
            return None
        return packet

    if await probe(0) is None:
        raise ReviewPacketTooLarge(
            f"{PACKET_LIMIT_CODE}: review context exceeds the {MAX_PACKET_BYTES} byte packet budget with no retained diff")
    best, low, high = None, 0, len(ordered)
    while low < high:
        mid = (low + high + 1) // 2
        packet = await probe(mid)
        if packet is None:
            high = mid - 1
        else:
            best, low = packet, mid
    if low == 0:
        raise ReviewPacketTooLarge(
            f"{PACKET_LIMIT_CODE}: no single retained file fits within the {MAX_DIFF_BYTES} "
            f"byte diff budget and {MAX_PACKET_BYTES} byte packet budget")
    return best


def _since_lede(since: str | None) -> str:
    if since is None:
        return ""
    return ("Follow-up review: the retained diff covers only changes since the last reviewed head. "
            "Earlier PR code was reviewed in prior rounds; review ONLY this diff, using the supplied "
            "threads and comments as context. ")


def _since_positioning(since: str | None) -> str:
    if since is None:
        return ""
    return (" New findings must reference RIGHT-side (current-head) lines; "
            "reaffirm existing unresolved findings with their original locations.")


async def review_diff(
    client: GitHubClient, owner: str, repo: str, pull: dict[str, Any],
    context: dict[str, Any] | None = None,
    since: str | None = None,
) -> dict[str, Any]:
    head = pull["head"]["sha"]
    base = pull["base"]["sha"]
    if since is None:
        # GitHub returns file patches only on comparison page 1. Page 2 gives us
        # the merge base without downloading the full patch-heavy comparison.
        comparison = await client.get(
            f"/repos/{owner}/{repo}/compare/{base}...{head}",
            params={"page": 2, "per_page": 1},
        )
        merge_base = comparison["merge_base_commit"]["sha"]
    else:
        merge_base = since
    env = _env(client.token)
    with tempfile.TemporaryDirectory(prefix="caller-review-") as directory:
        async def git(*args: str, limit: int = MAX_DIFF_BYTES) -> bytes:
            try:
                return await asyncio.to_thread(_git, directory, env, *args, limit=limit)
            except GitProcessError as error:
                error.diagnostic.update(phase="packet_acquisition", repository=f"{owner}/{repo}",
                                        pr=pull.get("number"), expected_head=head, observed_head=None,
                                        base_sha=base, merge_base_sha=merge_base)
                raise

        await git("init", "--bare", "--quiet", "--template=")
        await git("remote", "add", "origin", f"https://github.com/{owner}/{repo}.git")
        await git("config", "remote.origin.promisor", "true")
        await git("config", "remote.origin.partialclonefilter", "blob:none")
        try:
            await git("fetch", "--quiet", "--no-tags", "--depth=1", "--filter=blob:none", "origin", merge_base, head)
        except GitProcessError as error:
            if since is not None:
                raise RuntimeError(f"{SINCE_HEAD_UNKNOWN_CODE}: last reviewed head {since} is not fetchable") from error
            raise
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
                if since is None:
                    scope = ("Review the complete retained diff. Excluded file contents were not reviewed; "
                             "do not infer their correctness from this packet.")
                else:
                    scope = (_since_lede(since) + "Excluded file contents were not reviewed either; "
                             "do not infer their correctness from this packet." + _since_positioning(since))
                packet = {
                    "diff": diff,
                    "files": [{"filename": f["filename"],
                               "status": FILE_STATUS[f["status"]],
                               "old_mode": f["old_mode"], "new_mode": f["new_mode"]} for f in files if f["filename"] in retained_paths],
                    "excluded_files": excluded,
                    "merge_base_sha": merge_base,
                    "since_head_sha": since,
                    "review_scope": scope,
                }
                packet_bytes = len(json.dumps({**(context or {}), **packet}, indent=2).encode("utf-8"))
                if packet_bytes > MAX_PACKET_BYTES:
                    raise ReviewPacketTooLarge(f"{PACKET_LIMIT_CODE}: retained review packet exceeds {MAX_PACKET_BYTES} bytes")
                return packet
            except ReviewPacketTooLarge:
                if compact:
                    return await _bounded_packet(git, files, retained, excluded, context, merge_base, head, since)
        raise AssertionError("review packet compaction did not finish")
