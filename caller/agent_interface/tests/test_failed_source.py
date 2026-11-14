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
from agent_interface import review_budget

RUN = "b" * 32
TEST = "const {test}=require('node:test'); const assert=require('node:assert/strict'); test('candidate-only regression',()=>assert.equal(require('../source.cjs'),2));\n"
REAL_LEASE = atomic_work.checkout_lock.Lease
REAL_RUN_GATED = atomic_work.checkout_lock.run_gated


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


def prepared_fixed(checkout, when="2026-01-01T00:00:00+00:00"):
    checkout.mkdir()
    git(checkout, "init", "-q")
    (checkout / ".gitignore").write_text(".env\nnode_modules/\n")
    (checkout / "source.cjs").write_text("module.exports=0;\n")
    (checkout / "deleted.cjs").write_text("module.exports='deleted';\n")
    git(checkout, "add", ".")
    env = {**os.environ, "GIT_AUTHOR_DATE": when, "GIT_COMMITTER_DATE": when}
    subprocess.run(["git", "-C", str(checkout), "-c", "user.name=fixture", "-c", "user.email=fixture@example.test",
                    "commit", "-qm", "fixture base"], check=True, capture_output=True, env=env)
    return {"outcome": "prepared", "checkout_head": git(checkout, "rev-parse", "HEAD"), "path": str(checkout),
            "repository": "example/repo", "issue_number": 7, "actor": "author", "branch": "fix/fixture"}


def _deadline_provider(code):
    return [sys.executable, "-c", code]


def _run_deadline_original(workspace, monkeypatch, provider_code, when="2026-01-01T00:00:00+00:00"):
    validation = {}
    monkeypatch.setattr(atomic_work.checkout_lock, "Lease", REAL_LEASE)
    monkeypatch.setattr(atomic_work.checkout_lock, "run_gated", REAL_RUN_GATED)
    monkeypatch.setattr(review_budget, "timeout", lambda *args, **kwargs: 1)
    monkeypatch.setattr(issue_review, "command", lambda *args: (_deadline_provider(provider_code), "", None))

    def interface(*args, **kwargs):
        mode = args[args.index("--mode") + 1]
        assert mode == "prepare"
        checkout = Path(args[args.index("--path") + 1])
        validation["prepared"] = prepared_fixed(checkout, when)
        return validation["prepared"]

    monkeypatch.setattr(issue_review, "interface", interface)
    monkeypatch.setattr(api, "_main", lambda: api.run_atomic_work(
        "example/repo#7", "author", "poise:behavior-chain", "deadline-original", "fixture", "fix/fixture"))
    monkeypatch.setattr(sys, "argv", ["agent-interface", "--fixture"])
    with pytest.raises(review_budget.ReviewLimitError):
        api.main()
    original, = api.logs_selected({"latest": [], "ids": [], "correlations": ["deadline-original"]})
    assert original["error_code"] == "atomic_work_execution_budget_exhausted"
    assert (original["action"], original["outcome"]) == ("not_started", "preflight_failed")
    assert original["resources_settled_at"]
    assert not Path(validation["prepared"]["path"]).parent.exists()
    return original, validation["prepared"]


def _run_deadline_successor(workspace, monkeypatch, base_when, expect_restored, mutate=None):
    validation, seen = {}, {}
    monkeypatch.setattr(atomic_work.checkout_lock, "Lease", REAL_LEASE)
    monkeypatch.setattr(review_budget, "timeout", lambda *args, **kwargs: 30)

    def command(model, instruction, checkout, work, seconds, unattended):
        seen["instruction"] = instruction
        return (["fixture-provider"], "", {k: v for k, v in os.environ.items() if not k.startswith("AGENT_INTERFACE_RECEIPT_")})

    monkeypatch.setattr(issue_review, "command", command)

    def interface(*args, **kwargs):
        mode = args[args.index("--mode") + 1]
        if mode == "prepare":
            checkout = Path(args[args.index("--path") + 1])
            validation["prepared"] = prepared_fixed(checkout, base_when)
            return validation["prepared"]
        validation.setdefault("modes", []).append(mode)
        return {"outcome": "validated" if mode == "validate" else "published",
                "head_sha": validation["prepared"]["checkout_head"]}

    monkeypatch.setattr(issue_review, "interface", interface)

    def worker(lease, args, *, cwd, env, **kwargs):
        checkout = Path(cwd)
        content = (checkout / "source.cjs").read_text()
        if expect_restored:
            assert content == "module.exports=1;\n", content
        else:
            assert content == "module.exports=0;\n", content
        validation["checkout"] = checkout
        (checkout.parent / "publication.json").write_text(json.dumps({
            "commitMessage": "fix: fixture", "title": "fix: fixture", "body": "Successor validation", "replies": [], "blocked": None}))
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(atomic_work.checkout_lock, "run_gated", worker)
    if mutate is not None:
        mutate()
    monkeypatch.setattr(api, "_main", lambda: api.run_atomic_work(
        "example/repo#7", "author", "poise:behavior-chain", "deadline-successor", "fixture", "fix/fixture"))
    monkeypatch.setattr(sys, "argv", ["agent-interface", "--fixture"])
    api.main()
    successor, = api.logs_selected({"latest": [], "ids": [], "correlations": ["deadline-successor"]})
    assert successor["status"] == "completed" and successor["action"] == "published"
    assert validation.get("modes") == ["validate", "publish"]
    return successor, validation, seen


def test_deadline_edit_survives_reclamation_and_restores_on_same_base(workspace, monkeypatch):
    provider = "import time, pathlib; pathlib.Path('source.cjs').write_text('module.exports=1;\\n'); time.sleep(5)"
    original, prepared_receipt = _run_deadline_original(workspace, monkeypatch, provider)
    metadata = original["artifact"].get("deadline_source", {})
    assert metadata.get("status") == "available" and metadata.get("base") == prepared_receipt["checkout_head"]
    assert "module.exports" not in json.dumps(original)
    path = Path(os.environ["POISE_DB"]).parent / "incident-recovery" / f"deadline-source-{original['id']}.json"
    assert path.is_file() and path.stat().st_mode & 0o077 == 0
    successor, validation, seen = _run_deadline_successor(workspace, monkeypatch, "2026-01-01T00:00:00+00:00", True)
    assert successor["artifact"]["deadline_restored"]["predecessor"] == original["id"]
    assert "source.cjs" in seen["instruction"] and original["id"] in seen["instruction"]


def test_deadline_changed_base_refuses_restore(workspace, monkeypatch):
    provider = "import time, pathlib; pathlib.Path('source.cjs').write_text('module.exports=1;\\n'); time.sleep(5)"
    original, _ = _run_deadline_original(workspace, monkeypatch, provider)
    assert original["artifact"]["deadline_source"]["status"] == "available"
    successor, _, seen = _run_deadline_successor(workspace, monkeypatch, "2026-01-02T00:00:00+00:00", False)
    assert "deadline_restored" not in successor["artifact"]
    assert "Restored" not in seen["instruction"]


def test_deadline_timeout_without_edits_proceeds_clean(workspace, monkeypatch):
    provider = "import time; time.sleep(5)"
    original, _ = _run_deadline_original(workspace, monkeypatch, provider)
    assert original["artifact"]["deadline_source"]["status"] == "unavailable"
    successor, _, seen = _run_deadline_successor(workspace, monkeypatch, "2026-01-01T00:00:00+00:00", False)
    assert "deadline_restored" not in successor["artifact"]


def test_deadline_oversized_capture_proceeds_clean(workspace, monkeypatch):
    monkeypatch.setattr(failed_source, "MAX_BYTES", 200)
    provider = "import time, pathlib; pathlib.Path('source.cjs').write_text('module.exports=1;\\n'); time.sleep(5)"
    original, _ = _run_deadline_original(workspace, monkeypatch, provider)
    assert original["artifact"]["deadline_source"]["status"] == "unavailable"
    successor, _, _ = _run_deadline_successor(workspace, monkeypatch, "2026-01-01T00:00:00+00:00", False)
    assert "deadline_restored" not in successor["artifact"]


def test_deadline_unsafe_symlink_never_applies(workspace, monkeypatch):
    provider = ("import time, pathlib, os; pathlib.Path('source.cjs').write_text('module.exports=1;\\n'); "
                "os.symlink('/etc/passwd', 'evil.cjs'); time.sleep(5)")
    original, _ = _run_deadline_original(workspace, monkeypatch, provider)
    assert original["artifact"]["deadline_source"]["status"] == "available"
    successor, _, seen = _run_deadline_successor(workspace, monkeypatch, "2026-01-01T00:00:00+00:00", False)
    assert "deadline_restored" not in successor["artifact"]
    assert "Restored" not in seen["instruction"]


def test_deadline_uncertain_publication_refuses_restore(workspace, monkeypatch):
    provider = "import time, pathlib; pathlib.Path('source.cjs').write_text('module.exports=1;\\n'); time.sleep(5)"
    original, _ = _run_deadline_original(workspace, monkeypatch, provider)
    assert original["artifact"]["deadline_source"]["status"] == "available"

    def mutate():
        with api.db() as conn:
            conn.execute("update calls set artifact=json_set(artifact,'$.publication_head',?) where id=?",
                         ("a" * 40, original["id"]))

    successor, _, _ = _run_deadline_successor(workspace, monkeypatch, "2026-01-01T00:00:00+00:00", False, mutate=mutate)
    assert "deadline_restored" not in successor["artifact"]


def test_deadline_unreleased_cleanup_refuses_restore(workspace, monkeypatch):
    provider = "import time, pathlib; pathlib.Path('source.cjs').write_text('module.exports=1;\\n'); time.sleep(5)"
    original, _ = _run_deadline_original(workspace, monkeypatch, provider)
    assert original["artifact"]["deadline_source"]["status"] == "available"

    def mutate():
        with api.db() as conn:
            conn.execute("update calls set resources_settled_at=null where id=?", (original["id"],))

    successor, _, _ = _run_deadline_successor(workspace, monkeypatch, "2026-01-01T00:00:00+00:00", False, mutate=mutate)
    assert "deadline_restored" not in successor["artifact"]


def test_deadline_large_unchanged_file_does_not_veto_capture(workspace, monkeypatch):
    monkeypatch.setattr(failed_source, "MAX_BYTES", 500)
    real_prepared = prepared_fixed

    def with_large(checkout, when="2026-01-01T00:00:00+00:00"):
        receipt = real_prepared(checkout, when)
        (checkout / "large.cjs").write_text("module.exports='" + "x" * 1500 + "';\n")
        git(checkout, "add", "large.cjs")
        env = {**os.environ, "GIT_AUTHOR_DATE": when, "GIT_COMMITTER_DATE": when}
        subprocess.run(["git", "-C", str(checkout), "-c", "user.name=fixture", "-c", "user.email=fixture@example.test",
                        "commit", "-qm", "fixture large"], check=True, capture_output=True, env=env)
        receipt["checkout_head"] = git(checkout, "rev-parse", "HEAD")
        return receipt

    monkeypatch.setattr(sys.modules[__name__], "prepared_fixed", with_large)
    provider = "import time, pathlib; pathlib.Path('source.cjs').write_text('module.exports=1;\\n'); time.sleep(5)"
    original, _ = _run_deadline_original(workspace, monkeypatch, provider)
    assert original["artifact"]["deadline_source"]["status"] == "available"
    successor, _, seen = _run_deadline_successor(workspace, monkeypatch, "2026-01-01T00:00:00+00:00", True)
    assert successor["artifact"]["deadline_restored"]["predecessor"] == original["id"]
    assert "source.cjs" in seen["instruction"]


def test_deadline_chained_symlink_escape_never_applies(workspace, monkeypatch):
    provider = ("import time, pathlib, os; pathlib.Path('source.cjs').write_text('module.exports=1;\\n'); "
                "pathlib.Path('d').mkdir(exist_ok=True); os.symlink('..', 'd/up.cjs'); "
                "os.symlink('d/up.cjs/../secret', 'escape.cjs'); time.sleep(5)")
    original, _ = _run_deadline_original(workspace, monkeypatch, provider)
    assert original["artifact"]["deadline_source"]["status"] == "available"
    successor, _, seen = _run_deadline_successor(workspace, monkeypatch, "2026-01-01T00:00:00+00:00", False)
    assert "deadline_restored" not in successor["artifact"]
    assert "Restored" not in seen["instruction"]


def test_deadline_base_symlink_escape_never_applies(workspace, monkeypatch):
    real_prepared = prepared_fixed

    def with_base_link(checkout, when="2026-01-01T00:00:00+00:00"):
        receipt = real_prepared(checkout, when)
        (checkout / "d").mkdir(exist_ok=True)
        os.symlink("..", checkout / "d" / "up.cjs")
        git(checkout, "add", "d/up.cjs")
        env = {**os.environ, "GIT_AUTHOR_DATE": when, "GIT_COMMITTER_DATE": when}
        subprocess.run(["git", "-C", str(checkout), "-c", "user.name=fixture", "-c", "user.email=fixture@example.test",
                        "commit", "-qm", "fixture base link"], check=True, capture_output=True, env=env)
        receipt["checkout_head"] = git(checkout, "rev-parse", "HEAD")
        return receipt

    monkeypatch.setattr(sys.modules[__name__], "prepared_fixed", with_base_link)
    provider = ("import time, pathlib, os; pathlib.Path('source.cjs').write_text('module.exports=1;\\n'); "
                "os.symlink('d/up.cjs/../secret', 'escape.cjs'); time.sleep(5)")
    original, _ = _run_deadline_original(workspace, monkeypatch, provider)
    assert original["artifact"]["deadline_source"]["status"] == "available"
    successor, _, seen = _run_deadline_successor(workspace, monkeypatch, "2026-01-01T00:00:00+00:00", False)
    assert "deadline_restored" not in successor["artifact"]
    assert "Restored" not in seen["instruction"]


def test_deadline_parent_symlink_escape_never_captures(workspace, monkeypatch):
    real_prepared = prepared_fixed

    def with_secret_dir(checkout, when="2026-01-01T00:00:00+00:00"):
        receipt = real_prepared(checkout, when)
        (checkout / "d").mkdir(exist_ok=True)
        (checkout / "d" / "secret.json").write_text('{"base": true}\n')
        git(checkout, "add", "d/secret.json")
        env = {**os.environ, "GIT_AUTHOR_DATE": when, "GIT_COMMITTER_DATE": when}
        subprocess.run(["git", "-C", str(checkout), "-c", "user.name=fixture", "-c", "user.email=fixture@example.test",
                        "commit", "-qm", "fixture secret dir"], check=True, capture_output=True, env=env)
        receipt["checkout_head"] = git(checkout, "rev-parse", "HEAD")
        return receipt

    monkeypatch.setattr(sys.modules[__name__], "prepared_fixed", with_secret_dir)
    provider = ("import time, pathlib, os, shutil; pathlib.Path('source.cjs').write_text('module.exports=1;\\n'); "
                "pathlib.Path('../private').mkdir(exist_ok=True); "
                "pathlib.Path('../private/secret.json').write_text('{\"pwned\": true}\\n'); "
                "shutil.rmtree('d'); os.symlink('../private', 'd'); time.sleep(5)")
    original, _ = _run_deadline_original(workspace, monkeypatch, provider)
    assert original["artifact"]["deadline_source"]["status"] == "unavailable"
    successor, _, seen = _run_deadline_successor(workspace, monkeypatch, "2026-01-01T00:00:00+00:00", False)
    assert "deadline_restored" not in successor["artifact"]
    assert "Restored" not in seen["instruction"]


def test_deadline_repo_symlink_escape_never_captures(workspace, monkeypatch):
    provider = ("import pathlib, os, shutil, time; repo=pathlib.Path.cwd(); root=repo.parent; outside=root/'outside'; "
                "outside.mkdir(exist_ok=True); shutil.copytree(repo/'.git', outside/'.git', symlinks=True); "
                "(outside/'source.cjs').write_text('module.exports=1;\\n'); "
                "(outside/'secret.json').write_text('{\"pwned\": true}\\n'); "
                "os.rename(repo, root/'repo-backup'); os.symlink('outside', repo); time.sleep(5)")
    original, _ = _run_deadline_original(workspace, monkeypatch, provider)
    assert original["artifact"]["deadline_source"]["status"] == "unavailable"
    successor, _, seen = _run_deadline_successor(workspace, monkeypatch, "2026-01-01T00:00:00+00:00", False)
    assert "deadline_restored" not in successor["artifact"]
    assert "Restored" not in seen["instruction"]
