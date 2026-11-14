"""Validation-time bytes survive normal Caller cleanup, without publication authority."""
import base64
import gzip
import hashlib
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import tarfile
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

import agent_interface as api
from agent_interface import atomic_work, failed_source, issue_review

RUN = "b" * 32
TEST = "const {test}=require('node:test'); const assert=require('node:assert/strict'); test('candidate-only regression',()=>assert.equal(require('../source.cjs'),2));\n"


@pytest.fixture
def workspace(monkeypatch, request):
    # Reuse the cleanup fixtures' filesystem: test boxes give /tmp files and directories different devices.
    directory = TemporaryDirectory(dir="/dev/shm" if sys.platform == "linux" else None)
    request.addfinalizer(directory.cleanup)
    tmp_path = Path(directory.name).resolve()
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("POISE_NATIVE_CONTROL", raising=False)
    data = tmp_path / ".poise" / "agent-interface"
    data.mkdir(parents=True)
    monkeypatch.setenv("AGENT_INTERFACE_DATA_DIR", str(data))
    monkeypatch.setenv("POISE_DB", str(data.parent / "cache.db"))
    monkeypatch.setattr(api, "DB", data / "calls.sqlite3")
    monkeypatch.setattr(api, "DATA_DIR", data)
    monkeypatch.setattr(api, "RESPONSES", data / "responses")
    monkeypatch.setattr(api, "_native_cli", False)
    api.init_db()
    monkeypatch.setattr(api, "CATALOG", SimpleNamespace(issue_review_model=lambda _: SimpleNamespace(identity="fixture", provider="codex")))
    monkeypatch.setattr(issue_review, "WORK_ROOT", tmp_path / "issue-review")
    monkeypatch.setattr(issue_review, "packet", lambda *args: {"issue": {"state": "open"}})
    monkeypatch.setattr(issue_review, "command", lambda *args: (["fixture-provider"], "", {
        key: value for key, value in os.environ.items() if not key.startswith("AGENT_INTERFACE_RECEIPT_")}))
    monkeypatch.setattr(atomic_work.checkout_lock, "Lease", lambda *args, **kwargs: MagicMock(held=False))
    # Fixture-owned release proof: the worker waits for its own subprocesses, so an
    # unreadable host-wide /proc entry must not fail settlement. Production keeps
    # its fail-closed scan; receipts and managed reclamation stay real.
    monkeypatch.setattr(issue_review, "_cwd_pids", lambda *args, **kwargs: [])
    return tmp_path


def git(checkout, *args):
    return subprocess.run(["git", "-C", str(checkout), *args], check=True, capture_output=True).stdout.decode().strip()


def prepared(checkout):
    checkout.mkdir()
    git(checkout, "init", "-q")
    (checkout / ".gitignore").write_text(".env\nnode_modules/\n")
    (checkout / "source.cjs").write_text("module.exports=0;\n")
    (checkout / "deleted.cjs").write_text("module.exports='deleted';\n")
    git(checkout, "add", ".")
    git(checkout, "-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture base")
    return {"outcome": "prepared", "checkout_head": git(checkout, "rev-parse", "HEAD"), "path": str(checkout)}


def captured(checkout, directory):
    (checkout / "source.cjs").write_text("module.exports=1;\n")
    (checkout / "deleted.cjs").unlink(missing_ok=True)
    (checkout / "tests").mkdir(exist_ok=True)
    (checkout / "tests/candidate.test.cjs").write_text(TEST)
    (checkout / ".env").write_text("PRIVATE_CREDENTIAL=never retain\n")
    (checkout / "notes.log").write_text("not a source file\n")
    archive, spec = directory / "tree.tgz", directory / "spec.json"
    spec.write_text(json.dumps({"argv": ["node", "--test", "tests/candidate.test.cjs"], "cwd": str(checkout)}))
    names = subprocess.run(["git", "-C", str(checkout), "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
                           check=True, capture_output=True).stdout.split(b"\0")
    with tarfile.open(archive, "w:gz") as tree:
        for name in names:
            path = checkout / name.decode()
            if name and path.exists():
                tree.add(path, arcname=str(path).lstrip("/"))
    # The runner hashes the specification plus the uncompressed tar stream.
    candidate = hashlib.sha256(spec.read_bytes() + gzip.decompress(archive.read_bytes())).hexdigest()
    return archive, spec, candidate


def linked_reader(monkeypatch, original, issue=99):
    reader = api.track("fixture", "inspect failed source", pr_id=str(issue), repo=original["repo"], actor=original["actor"],
                       behavior="implement_issue", source="poise:behavior-chain", correlation_id="remediation")
    monkeypatch.setenv("AGENT_INTERFACE_FAILED_SOURCE_CALL", reader)
    source = f"{original['repo']}#{original['pr_id']}"
    key = hashlib.sha256(json.dumps(["atomic_work_blocked", source], separators=(",", ":")).encode()).hexdigest()
    with sqlite3.connect(os.environ["POISE_DB"]) as conn:
        conn.execute("create table meta(key text primary key, value text)")
        conn.execute("insert into meta values (?,?)", ("behavior_chain_repair_report:" + key, json.dumps({
            "source": source, "pull": None, "issueNumber": 99,
            "attempts": [{"call": original["id"], "invocation": original["correlation_id"]}]})))
    return reader


@pytest.mark.parametrize("publish", [False, True])
def test_original_failed_candidate_survives_cleanup_only_for_blocked_unpublished_call(workspace, monkeypatch, publish):
    validation = {}

    def interface(*args, **kwargs):
        mode = args[args.index("--mode") + 1]
        if mode == "prepare":
            checkout = Path(args[args.index("--path") + 1])
            validation["prepared"] = prepared(checkout)
            return validation["prepared"]
        return {"outcome": "validated" if mode == "validate" else "published", "head_sha": validation["prepared"]["checkout_head"]}

    def worker(lease, args, *, cwd, env, **kwargs):
        checkout = Path(cwd)
        archive, spec, candidate = captured(checkout, checkout.parent)
        # Run the candidate-only regression from the captured tree, not a later edit.
        box = workspace / "box"
        with tarfile.open(archive) as tree:
            tree.extractall(box, filter="data")
        result = subprocess.run(["node", "--test", "tests/candidate.test.cjs"],
                                cwd=box / str(checkout).lstrip("/"), capture_output=True, text=True)
        assert result.returncode == 1 and "candidate-only regression" in result.stdout and "1 !== 2" in result.stdout
        saved = subprocess.run(["agent-interface", "--capture-failed-source", str(archive), str(spec), candidate, RUN, "1"],
                               env=env, capture_output=True, text=True, timeout=30)
        assert saved.returncode == 0, saved.stderr
        assert not saved.stdout, "source must not enter Caller stdout"
        validation.update(candidate=candidate, run=RUN, checkout=checkout)
        (checkout / "source.cjs").write_text("module.exports=2; // untested B\n")
        (checkout / "tests/candidate.test.cjs").write_text("// later untested B\n")
        (checkout.parent / "publication.json").write_text(json.dumps({
            "commitMessage": "fix: fixture", "title": "fix: fixture", "body": "Fixture correction", "replies": [],
            "blocked": None if publish else f"candidate-only regression: 1 !== 2; candidate {candidate}; run {RUN}"}))
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(issue_review, "interface", interface)
    monkeypatch.setattr(atomic_work.checkout_lock, "run_gated", worker)
    monkeypatch.setattr(api, "_main", lambda: api.run_atomic_work(
        "example/repo#7", "author", "poise:behavior-chain", "original", "fixture", "fix/fixture"))
    monkeypatch.setattr(sys, "argv", ["agent-interface", "--fixture"])
    if publish:
        api.main()
    else:
        with pytest.raises(atomic_work.AtomicWorkBlocked, match="1 !== 2"):
            api.main()
    original, = api.logs_selected({"latest": [], "ids": [], "correlations": ["original"]})
    assert not original["resource_ownership"]["errors"], [error["cause"] for error in original["resource_ownership"]["errors"]]
    assert not validation["checkout"].parent.exists(), original["resource_ownership"]
    assert original["resources_settled_at"]
    assert "module.exports" not in json.dumps(original) and TEST not in json.dumps(original)
    linked_reader(monkeypatch, original)
    evidence = failed_source.inspect(api.DB, original["id"], validation["candidate"], RUN)
    if publish:
        assert evidence["status"] == "unavailable"
        assert "failed_source" not in original["artifact"]
        assert not list((workspace / ".poise/incident-recovery").iterdir())
        return
    assert evidence["status"] == "available"
    manifest = json.loads(Path(evidence["path"]).read_bytes())
    changes = {change["path"]: change for change in manifest["changes"]}
    assert set(changes) == {"source.cjs", "deleted.cjs", "tests/candidate.test.cjs"}
    assert base64.b64decode(changes["source.cjs"]["content"]) == b"module.exports=1;\n"
    assert base64.b64decode(changes["tests/candidate.test.cjs"]["content"]).decode() == TEST
    assert changes["deleted.cjs"]["content"] is None
    assert manifest["call"] == original["id"] and manifest["run"] == RUN and manifest["candidate"] == validation["candidate"]
    assert Path(evidence["path"]).stat().st_mode & 0o077 == 0


@pytest.fixture
def retained(workspace, monkeypatch):
    call = api.track("fixture", "fixture", pr_id="7", repo="example/repo", actor="author", behavior="implement_issue",
                     source="poise:behavior-chain", correlation_id="original")
    work = workspace / "worker"
    work.mkdir()
    checkout = work / "repo"
    receipt = prepared(checkout)
    with api.db() as conn:
        conn.execute("update calls set artifact=? where id=?", (json.dumps({"phase": "executing", "prepared": receipt, "resource_root": str(work)}), call))
    monkeypatch.setenv("AGENT_INTERFACE_FAILED_SOURCE_CALL", call)
    archive, spec, candidate = captured(checkout, work)
    return call, work, archive, spec, candidate


@pytest.mark.parametrize("cause", ["candidate", "oversized", "unsafe directory"])
def test_unbound_or_oversized_capture_is_explicitly_unavailable(retained, monkeypatch, cause):
    call, work, archive, spec, candidate = retained
    if cause == "candidate":
        candidate = "c" * 64
    if cause == "oversized":
        monkeypatch.setattr(failed_source, "MAX_BYTES", 200)
    if cause == "unsafe directory":
        outside = work / "outside"
        outside.mkdir()
        (Path(os.environ["POISE_DB"]).parent / "incident-recovery").symlink_to(outside, target_is_directory=True)
    metadata = failed_source.capture(api.DB, archive, spec, candidate, RUN, 1)
    assert metadata["status"] == "unavailable" and "reason" in metadata
    assert "content" not in json.dumps(metadata)


@pytest.mark.parametrize("cause", ["candidate", "run", "expiry", "missing", "tampered", "foreign workspace", "unlinked remediation"])
def test_inspection_refuses_unavailable_or_unauthorized_evidence(retained, monkeypatch, cause):
    call, work, archive, spec, candidate = retained
    assert failed_source.capture(api.DB, archive, spec, candidate, RUN, 1)["status"] == "available"
    with api.db() as conn:
        conn.execute("update calls set status='failed', error_code='atomic_work_blocked',action='not_started',outcome='preflight_failed',resources_settled_at=? where id=?",
                     (failed_source.time(), call))
    original, = api.logs_selected({"latest": [], "ids": [call]})
    linked_reader(monkeypatch, original, issue=100 if cause == "unlinked remediation" else 99)
    run = RUN
    if cause == "candidate":
        candidate = "c" * 64
    if cause == "run":
        run = "c" * 32
    if cause == "expiry":
        now = failed_source.time()
        monkeypatch.setattr(failed_source, "time", lambda: now + failed_source.RETENTION_SECONDS + 1)
    path = Path(os.environ["POISE_DB"]).parent / "incident-recovery" / f"failed-source-{call}-{RUN}.json"
    if cause == "missing":
        path.unlink()
    if cause == "tampered":
        path.write_bytes(path.read_bytes().replace(b"source.cjs", b"forged.cjs"))
    database = api.DB
    if cause == "foreign workspace":
        database = work / "foreign.sqlite3"
        with sqlite3.connect(database) as conn:
            conn.execute("create table calls(id text primary key)")
    assert failed_source.inspect(database, call, candidate, run)["status"] == "unavailable"


def test_inspection_returns_unavailable_without_blocking_on_fifo_evidence(retained, monkeypatch):
    call, work, archive, spec, candidate = retained
    assert failed_source.capture(api.DB, archive, spec, candidate, RUN, 1)["status"] == "available"
    with api.db() as conn:
        conn.execute("update calls set status='failed', error_code='atomic_work_blocked',action='not_started',outcome='preflight_failed',resources_settled_at=? where id=?",
                     (failed_source.time(), call))
    original, = api.logs_selected({"latest": [], "ids": [call]})
    linked_reader(monkeypatch, original)
    path = Path(os.environ["POISE_DB"]).parent / "incident-recovery" / f"failed-source-{call}-{RUN}.json"
    path.unlink()
    os.mkfifo(path)

    def _hung(*args):
        raise AssertionError("inspect blocked on FIFO evidence instead of returning unavailable")

    previous = signal.signal(signal.SIGALRM, _hung)
    signal.alarm(10)
    try:
        assert failed_source.inspect(api.DB, call, candidate, RUN)["status"] == "unavailable"
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, previous)


def test_inspection_returns_unavailable_on_deeply_nested_tampered_evidence(retained, monkeypatch):
    call, work, archive, spec, candidate = retained
    checkout = work / "repo"
    (checkout / "large.cjs").write_text("module.exports='" + "x" * 100_000 + "';\n")
    archive, spec, candidate = captured(checkout, work)
    assert failed_source.capture(api.DB, archive, spec, candidate, RUN, 1)["status"] == "available"
    with api.db() as conn:
        conn.execute("update calls set status='failed', error_code='atomic_work_blocked',action='not_started',outcome='preflight_failed',resources_settled_at=? where id=?",
                     (failed_source.time(), call))
    original, = api.logs_selected({"latest": [], "ids": [call]})
    linked_reader(monkeypatch, original)
    path = Path(os.environ["POISE_DB"]).parent / "incident-recovery" / f"failed-source-{call}-{RUN}.json"
    size = path.stat().st_size
    depth = size // 2
    assert depth > 30000, f"retained payload ({size} bytes) is too small to nest beyond the recursion limit"
    payload = b"[" * depth + b"]" * depth + b" " * (size - 2 * depth)
    assert len(payload) == size
    path.write_bytes(payload)
    with pytest.raises(RecursionError):
        json.loads(payload)
    assert failed_source.inspect(api.DB, call, candidate, RUN)["status"] == "unavailable"
