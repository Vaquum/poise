"""Real SQLite receipt transitions; not provider/workflow acceptance."""
import asyncio
import json
import os
import re
import signal
import sqlite3
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from shutil import copyfile
from tempfile import TemporaryDirectory
from threading import Thread
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import agent_interface as api
from agent_interface import issue_review, native_cleanup, native_namespace, process_identity, resource_ownership as ownership, review_receipt
from agent_interface.model_catalog import CATALOG
from github_interface.behaviors import issue_work


@pytest.fixture
def database(tmp_path, monkeypatch, request):
    if hasattr(request, "param"):
        directory = TemporaryDirectory(dir=request.param)
        request.addfinalizer(directory.cleanup)
        tmp_path = Path(directory.name)
    monkeypatch.setattr(api, "DB", tmp_path / "calls.sqlite3")
    monkeypatch.setattr(api, "DATA_DIR", tmp_path)
    monkeypatch.setattr(api, "RESPONSES", tmp_path / "responses")
    monkeypatch.setattr(api, "_native_cli", False)
    api.init_db()
    return tmp_path


def claim(correlation="original-native"):
    return api.track("fixture", "original prompt", pr_id="7", repo="example/repo", actor="reviewer",
                     behavior="issue_review", source="poise:behavior-chain", correlation_id=correlation)


def state(call):
    with api.db() as conn:
        return ownership.read(conn, call)


def requested():
    call = claim()
    with api.db() as conn:
        conn.execute("update calls set resource_ownership=? where id=?", (ownership.initial(call, "original-native"), call))
    scope = SimpleNamespace(key={"callId": call, "correlation": "original-native", "token": "b" * 32},
        address={"version": 1, "instance": "c" * 32, "path": "/tmp/poise-native-test-only/control.sock"},
        binding={"pid": 104, "start": "12", "namespace": "pid:[91]", "owner": {"pid": 102, "start": "10"},
                 "holder": {"pid": 103, "start": "11"},
                 "epoch": {"boot": "test-epoch", "init_start": "1", "namespace_dev": "2", "namespace_ino": "3"}},
        read=lambda: {"empty": True})
    with api.db() as conn:
        identity = {"version": 1, "pid": 102, "start": "10", "epoch": scope.binding["epoch"]}
        conn.execute("update calls set pid='102',process_identity=? where id=?", (json.dumps(identity), call))
    return call, scope


def register(call, scope):
    ownership.request_namespace(api.DB, call, scope)
    ownership.register_namespace(api.DB, call, {"controller": scope.address, **scope.key, "binding": scope.binding})


@pytest.mark.parametrize("identity", ["opus-5-max", "gpt-6-astra-ultra", "grok-4.6-xhigh",
                                      "gemini-3.8-flash-high", "muse-spark-1.3-contributor-max"])
def test_provider_child_scratch_leaves_managed_parent_receipt_unchanged(database, identity):
    call, scope = requested()
    register(call, scope)
    before = state(call)
    work = database / "worker"
    work.mkdir()
    with review_receipt.invocation_environment(api.DB, call, True):
        _, _, env = issue_review.command(CATALOG.resolve(identity), "test scratch", work / "repo", work, 60)
        done = subprocess.run(
            [sys.executable, "-c", "from pathlib import Path\n"
             "from agent_interface import resource_ownership\n"
             "with resource_ownership.temporary_directory('caller-pr-review-') as directory:\n"
             "    assert Path(directory).is_dir()\n"
             "    print(directory)\n"],
            cwd=work, env=env, text=True, capture_output=True, timeout=30,
        )
        assert state(call) == before
        assert done.returncode == 0, done.stderr
        assert os.environ["AGENT_INTERFACE_RECEIPT_DB"] == str(api.DB)
        assert os.environ["AGENT_INTERFACE_RECEIPT_CALL"] == call
        assert env["XDG_CACHE_HOME"] == str(work / "cache")
        assert env["npm_config_cache"] == str(work / "npm-cache")
    assert Path(done.stdout.strip()).parent == work / "tmp"
    assert not Path(done.stdout.strip()).exists()


def test_physical_cli_wins_original_claim_before_contacting_controller(database, monkeypatch):
    observed = []

    def unsupported(call, correlation):
        receipt = state(call)
        assert receipt == {"version": 2, "roots": [], "errors": [],
                           "namespace": {"state": "requested", "callId": call, "correlation": correlation}}
        with api.db() as conn:
            assert conn.execute("select namespace_control from calls where id=?", (call,)).fetchone()[0] is None
        observed.append(call)
        raise native_namespace.NamespaceUnavailable("unsupported test host")

    monkeypatch.setattr(native_namespace, "Namespace", unsupported)
    monkeypatch.setattr(api, "_main", claim)
    monkeypatch.setattr(sys, "argv", ["agent-interface", "--issue-review", "example/repo#7", "--source", "poise:behavior-chain",
                                      "--correlation-id", "original-native"])
    with pytest.raises(native_namespace.NamespaceUnavailable, match="unsupported test host"):
        api.main()
    assert len(observed) == 1
    receipt = state(observed[0])
    assert receipt["namespace"]["state"] == "not_started"
    assert receipt["namespace"]["no_effect"] == "original-no-go"
    assert ownership.released(receipt)
    with api.db() as conn:
        row = conn.execute("select * from calls where id=?", (observed[0],)).fetchone()
    assert row["status"] == "failed" and row["action"] == "not_started"
    assert float(row["resources_settled_at"]) >= receipt["namespace"]["settled_at"]
    assert not (database / "native-resources").exists()


def test_duplicate_claim_never_allocates_or_contacts_controller(database, monkeypatch):
    original = claim()
    before = state(original)
    monkeypatch.setattr(api, "_native_cli", True)
    with patch.object(api, "_enter_native_call", side_effect=AssertionError("duplicate reached kernel boundary")) as enter:
        with pytest.raises(sqlite3.IntegrityError):
            claim()
        enter.assert_not_called()
    assert state(original) == before


def test_private_controller_precedes_registration_and_never_enters_public_logs(database):
    call, scope = requested()
    with pytest.raises(RuntimeError, match="private controller"):
        ownership.register_namespace(api.DB, call, {"controller": scope.address, **scope.key, "binding": scope.binding})
    register(call, scope)
    assert state(call)["namespace"]["binding"] == scope.binding
    public = json.dumps(api.logs_selected({"latest": [], "ids": [call]}))
    assert scope.key["token"] not in public and scope.address["path"] not in public
    assert scope.address["instance"] in public
    assert not ownership.released(state(call))


def test_positive_original_settlement_preserves_first_stamp_and_all_evidence(database):
    call, scope = requested()
    register(call, scope)
    ownership.failure(api.DB, call, "resources_unknown")
    ownership.settle_namespace(api.DB, call, scope)
    first = state(call)
    ownership.settle_namespace(api.DB, call, scope)
    assert state(call) == first
    assert first["namespace"]["state"] == "settled"
    assert first["errors"][0]["cause"] == "resources_unknown"
    assert not ownership.released(first)
    with api.db() as conn:
        assert conn.execute("select resources_settled_at from calls where id=?", (call,)).fetchone()[0] is None


def test_nonempty_or_lost_witness_cannot_settle_a_terminal_result(database):
    call, scope = requested()
    register(call, scope)
    api.finish(call, "completed", outcome="commented", action="commented")
    before = state(call)
    scope.read = lambda: {"empty": False}
    with pytest.raises(RuntimeError, match="still owns processes"):
        ownership.settle_namespace(api.DB, call, scope)
    with patch.object(scope, "read", side_effect=OSError("original witness lost")):
        with pytest.raises(OSError, match="original witness lost"):
            ownership.settle_namespace(api.DB, call, scope)
    assert state(call) == before
    assert not ownership.released(before)


def test_foreign_binding_and_allocated_no_go_never_release(database):
    call, scope = requested()
    register(call, scope)
    with patch.object(scope, "binding", {**scope.binding, "pid": 999}):
        with pytest.raises(RuntimeError, match="original namespace"):
            ownership.settle_namespace(api.DB, call, scope)
    with pytest.raises(RuntimeError, match="no-GO"):
        ownership.namespace_not_started(api.DB, call)
    assert state(call)["namespace"]["state"] == "active"


@pytest.mark.parametrize("proof", ["original", "missing", "mismatched"])
def test_persisted_near_limit_receipt_recovers_only_with_original_proof(database, monkeypatch, proof):
    call, scope = requested()
    register(call, scope)
    value = state(call)
    parent = f"/home/poise/.poise/agent-interface/native-resources/{call}"
    identity = {key: "18446744073709551615" for key in ("device", "inode", "parent_device", "parent_inode")}
    value["roots"] = [{"path": f"{parent}/agent-interface-review-{index:032x}/codex-home",
                       "state": "allocated", **identity} for index in range(160)]
    partial = {"path": value["roots"][0]["path"] + "/partial", "state": "registered"}
    value["roots"].append(partial)
    while len(json.dumps(value, separators=(",", ":")).encode()) < 523000:
        index = len(value["errors"])
        value["errors"].append({"cause": f"original directory cleanup failed on retry {index}: " + "x" * 200,
                                "path": value["roots"][index % 160]["path"], "at": 10 + index})
    value["errors"][-1]["cause"] += "x" * (524282 - len(json.dumps(value, separators=(",", ":")).encode()))
    encoded = json.dumps(value, separators=(",", ":"))
    assert len(encoded.encode()) == 524282
    artifact = {"phase": "posting_issue_reviews", "resource_error": "retained original cleanup failure"}
    api.finish(call, "completed", outcome="commented", action="commented")
    with api.db() as conn:
        # This is an already-persisted receipt from before settlement was reserved.
        conn.execute("update calls set resource_ownership=?,artifact=?,receipts=? where id=?",
                     (encoded, json.dumps(artifact), json.dumps([
                         {"issue": "example/repo#7", "comment_id": 91, "author": "reviewer", "url": None}]), call))
        before = tuple(conn.execute("select status,outcome,action,receipts from calls where id=?", (call,)).fetchone())

    def resource(operation, root):
        if str(root) == partial["path"]:
            raise RuntimeError("incomplete child has no original directory handle")
        return {"path": str(root), "state": "reclaimed", **identity,
                "inode": "1" if proof == "mismatched" else identity["inode"], "reclaimed_at": 1000}

    def read():
        if proof == "missing":
            raise OSError("original namespace witness is unavailable")
        return {"empty": True}

    scope.read, scope.resource, scope.retire = read, resource, lambda: None
    monkeypatch.setattr(native_namespace.Namespace, "restore", lambda *args: scope)
    observed = process_identity.state
    monkeypatch.setattr(process_identity, "state", lambda encoded, pid: observed(encoded, pid) if pid == os.getpid() else "gone")
    report = native_cleanup.recover(api.DB)
    with api.db() as conn:
        after = ownership.read(conn, call)
        row = conn.execute("select resources_settled_at,resource_cleanup,artifact,status,outcome,action,receipts from calls where id=?", (call,)).fetchone()
        persisted = conn.execute("select resource_ownership from calls where id=?", (call,)).fetchone()[0]
    assert len(persisted.encode()) <= 524288
    assert len(after["errors"]) < len(value["errors"])
    assert tuple(row[3:]) == before
    if proof != "original":
        assert report["held"] and not report["released"]
        assert row[0] is None and json.loads(row[1])["next_attempt_at"] > 0
        assert not ownership.released(after)
        assert json.loads(row[2]) == artifact
        return
    assert report["released"] == [call] and not report["held"]
    assert row[0] is not None and row[1] is None
    assert ownership.released(after)
    assert after["roots"][-1] == {**partial, "state": "covered", "covered_by": value["roots"][0]["path"], "reclaimed_at": 1000}
    assert all(error["recovered_at"] >= error["at"] for error in after["errors"])
    assert json.loads(row[2]) == {**artifact, "resource_recovered_at": after["errors"][0]["recovered_at"]}
    # Feed the actual Caller log through Poise's unchanged decoder and journal.
    repo = Path(__file__).resolve().parents[3]
    output = repo / "test-results"
    output.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="native-receipt-limit-", dir=output) as work:
        script, wire = Path(work) / "contract.mjs", Path(work) / "receipt.json"
        environment = {"PATH": os.environ["PATH"], "HOME": str(database), "TMPDIR": work}
        built = subprocess.run([str(repo / "node_modules/esbuild/bin/esbuild"), str(repo / "tests/fixtures/behavior-fence-contract.ts"),
                                "--bundle", "--platform=node", "--packages=external", "--format=esm", "--target=node22", f"--outfile={script}"],
                               cwd=repo, env=environment, capture_output=True, text=True, timeout=30)
        assert built.returncode == 0, built.stderr
        wire.write_text(json.dumps(api.logs_selected({"latest": [], "ids": [call]})))
        consumed = subprocess.run(["node", str(script), str(wire), "recovered"], cwd=repo, env=environment, capture_output=True, text=True, timeout=30)
        assert consumed.returncode == 0, consumed.stderr
        assert json.loads(consumed.stdout) == {"accepted": 1, "settled": 1, "reservations": 0}


def test_allocation_reserves_identity_settlement_and_a_terminal_blocker(database, monkeypatch):
    call, scope = requested()
    register(call, scope)
    allocated = []
    identity = {key: "18446744073709551615" for key in ("device", "inode", "parent_device", "parent_inode")}

    def resource(operation, root):
        if operation == "allocate-root":
            allocated.append(str(root))
            return {"state": "allocated", "unlinked": False, **identity}
        return {"state": "reclaimed", "reclaimed_at": 1000, **identity}

    scope.resource = resource
    monkeypatch.setattr(native_namespace, "active", lambda: scope)
    parent = ownership.call_directory(api.DB, call)
    for index in range(4000):
        root = parent / f"agent-interface-review-{index:032x}" / "codex-home"
        before = state(call)
        try:
            ownership.allocate(api.DB, call, root)
        except RuntimeError as error:
            assert "size limit" in str(error)
            assert state(call) == before
            assert str(root) not in allocated and not root.exists()
            break
    else:
        pytest.fail("native ownership accepted unbounded allocations")
    assert len(allocated) > 100
    # Escaped non-ASCII diagnostics cost more bytes than characters.
    ownership.failure(api.DB, call, "\u2603" * 2000)
    ownership.failure(api.DB, call, "resources_unknown")
    ownership.settle_namespace(api.DB, call, scope)
    ownership.cleanup_remaining(api.DB, call)
    ownership.acknowledge_recovery(api.DB, call)
    after = state(call)
    assert ownership.released(after)
    assert len(after["roots"]) == len(allocated)
    with api.db() as conn:
        assert len(conn.execute("select resource_ownership from calls where id=?", (call,)).fetchone()[0].encode()) <= 524288
    stamp = max(error["recovered_at"] for error in after["errors"]) + 1
    with patch.object(ownership, "time", return_value=stamp):
        ownership.failure(api.DB, call, "resources_unknown")
    assert not ownership.released(state(call)), "an earlier recovery cannot cover a repeated later failure"


def test_settlement_blocker_reserves_worst_case_unicode_escaping():
    value = {"version": 1, "roots": [], "errors": []}
    stamp = "9" * 24
    expected = {**value, "process_pending": False, "roots": [], "errors": [
        {"cause": "\U0001F600" * ownership.MAX_ERROR_CHARACTERS, "path": None, "at": stamp, "recovered_at": stamp}]}
    assert ownership._settlement_size(value) == len(json.dumps(expected, separators=(",", ":")).encode())


@pytest.mark.parametrize("code,severity", [(0, "warning"), (1, "error")])
def test_preparation_diagnostic_survives_terminal_result(database, monkeypatch, code, severity):
    call = claim()
    evidence = {"version": 1, "source": "caller", "severity": severity, "operation": "provider.cli_update",
                "phase": "launcher_verification", "outcome": "unavailable", "message": "Updater unavailable",
                "stderr": "redacted updater cause", "stderr_truncated": False}
    monkeypatch.setattr(api, "CATALOG", SimpleNamespace(resolve=lambda model: SimpleNamespace(provider="codex")))
    monkeypatch.setattr(sys, "argv", ["agent-interface", "--issue-review", "example/repo#7", "--model", "fixture"])
    monkeypatch.setenv("POISE_NATIVE_NODE", "/pinned/node")
    monkeypatch.setenv("POISE_NATIVE_PREPARE", "/pinned/prepare.mjs")
    monkeypatch.setattr(ownership, "allocate", lambda *args: database / "preparation")
    monkeypatch.setattr(ownership, "cleanup", lambda *args: True)
    monkeypatch.setattr(api.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(returncode=code,
                       stdout=json.dumps({"version": 1, "env": {}, "diagnostic": evidence})))
    if code:
        with pytest.raises(RuntimeError, match="Updater unavailable"):
            api._prepare_native_clis(call)
    else:
        api._prepare_native_clis(call)
    api.finish(call, "failed" if code else "completed")
    public = api.logs_selected({"latest": [], "ids": [call]})[0]
    assert public["diagnostic"] == {**evidence, "call_id": call}


@pytest.fixture
def decode_failure(database):
    """Read committed SQLite in a new Caller, then use Poise's real decoder."""
    repo = Path(__file__).resolve().parents[3]
    environment = {"PATH": os.environ["PATH"], "HOME": str(database), "AGENT_INTERFACE_DATA_DIR": str(database),
                   "PYTHONPATH": str(repo / "caller/agent_interface")}
    # Keep the bundle under the repo so its external dependencies resolve.
    output = repo / "test-results"
    output.mkdir(exist_ok=True)
    with TemporaryDirectory(prefix="caller-failure-", dir=output) as work:
        bundle = Path(work) / "decoder.mjs"
        subprocess.run([str(repo / "node_modules/esbuild/bin/esbuild"), str(repo / "tests/fixtures/caller-failure-contract.ts"),
                        "--bundle", "--platform=node", "--packages=external", "--format=esm", "--target=node22",
                        f"--outfile={bundle}"], cwd=repo, env=environment, check=True, capture_output=True, text=True, timeout=30)

        def decode():
            read = subprocess.run([sys.executable, "-c", "from agent_interface import main; main()", "--logs", "--select",
                                   json.dumps({"latest": [], "ids": [], "correlations": ["original-native"]})],
                                  cwd=repo, env=environment, capture_output=True, text=True, timeout=30)
            assert read.returncode == 0, read.stderr
            wire = Path(work) / "stored.json"
            wire.write_text(read.stdout)
            decoded = subprocess.run(["node", str(bundle), str(wire)], cwd=repo, env=environment,
                                     capture_output=True, text=True, timeout=30)
            assert decoded.returncode == 0, decoded.stderr
            return json.loads(read.stdout)[0], json.loads(decoded.stdout)

        yield decode


@pytest.mark.parametrize("database", ["/dev/shm" if sys.platform == "linux" else None], indirect=True)
@pytest.mark.parametrize("scenario", ["implementation", "repair", "merged-parent"])
@pytest.mark.parametrize("lost_push", [False, True], ids=["before-push", "lost-push-result"])
def test_original_publication_boundary_reconciles_without_repeating_work(database, monkeypatch, scenario, lost_push):
    parent, candidate = "b" * 40, "c" * 40
    repair = scenario != "implementation"
    pull = {"number": 3, "state": "open", "head": {"ref": "poise/issue-7", "sha": parent,
            "repo": {"full_name": "example/repo"}}, "user": {"login": "author"},
            "body": "<!-- poise-chain example/repo#7 -->"}
    client = SimpleNamespace(token="fixture-token", post=AsyncMock())

    async def get(path):
        if path == "/repos/example/repo":
            return {"full_name": "example/repo", "default_branch": "main"}
        return pull if path.endswith("/pulls/3") else {"state": "open"}

    async def paginate(path, *args):
        if path.endswith("/comments"):
            return [{"id": 17, "body": "Original finding", "user": {"login": "reviewer"}}]
        return [pull] if repair else []

    client.get, client.paginate = AsyncMock(side_effect=get), AsyncMock(side_effect=paginate)
    client.graphql = AsyncMock(return_value={"repository": {
        "ref": {"target": {"oid": parent, "message": "fix: original parent"}} if repair else None,
        "defaultBranchRef": {"target": {"oid": parent}},
        "issue": {"blockedBy": {"nodes": [], "totalCount": 0, "pageInfo": {"hasNextPage": False}},
                  "closedByPullRequestsReferences": {"nodes": [], "pageInfo": {"hasNextPage": False}}}}})
    committed, pushes = False, []

    def git(command, *_secrets):
        nonlocal committed
        if command[-2:] == ["branch", "--show-current"]:
            return "poise/issue-7"
        if command[-3:] == ["remote", "get-url", "origin"]:
            return "https://github.com/example/repo.git"
        if command[-2:] == ["rev-parse", "HEAD"]:
            if committed and not lost_push:
                raise RuntimeError("interrupted after local commit, before push intent")
            return candidate if committed else parent
        if "status" in command:
            return " M seed.txt"
        if "commit" in command:
            committed = True
        if "push" in command:
            pushes.append(command)
            raise RuntimeError("original push result lost")
        return ""

    def interface(*args, **_kwargs):
        if args[0] == "--pr-review":
            return {"review_threads": [{"root_comment_id": 17, "is_resolved": False}]}
        if args[0] != "--issue-work":
            return {}
        mode = args[args.index("--mode") + 1]
        if mode == "prepare":
            return {"outcome": "prepared", "checkout_head": parent}
        payload = {args[index][2:].replace("-", "_"): args[index + 1] for index in range(2, len(args), 2)}
        payload["issue"] = 7
        if repair:
            payload["pull_number"] = 3
        return asyncio.run(issue_work.run(client, payload))

    def worker(_lease, _args, **kwargs):
        (Path(kwargs["cwd"]).parent / "publication.json").write_text(json.dumps({
            "commitMessage": "fix: seed", "title": "fix: seed", "body": "Concrete seed change",
            "replies": [{"commentId": 17, "body": "Fixed the finding"}] if repair else [], "blocked": None}))
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    def execute():
        with patch.object(api, "_native_cli", False):
            api.run_atomic_work("example/repo#7", "author", "poise:behavior-chain", "original-native", "fixture",
                                "poise/issue-7", pull=3 if repair else None, expected_head=parent if repair else None)

    monkeypatch.setattr(api, "CATALOG", SimpleNamespace(issue_review_model=lambda _: SimpleNamespace(identity="fixture", provider="codex")))
    monkeypatch.setattr(issue_review, "WORK_ROOT", database / "issue-review")
    monkeypatch.setattr(api, "_main", execute)
    monkeypatch.setattr(sys, "argv", ["agent-interface", "--atomic-work", "example/repo#7", "--source",
                                     "poise:behavior-chain", "--correlation-id", "original-native"])
    with patch.object(issue_review, "packet", return_value={"issue": {"state": "open"}}), \
            patch.object(issue_review, "interface", side_effect=interface), \
            patch.object(issue_review, "command", return_value=(["fixture"], "", {})), \
            patch.object(issue_review, "stop_leftovers"), patch.object(issue_review, "_cwd_pids", return_value=[]), \
            patch.object(api.atomic_work.checkout_lock, "Lease", return_value=MagicMock()), \
            patch.object(api.atomic_work.checkout_lock, "run_gated", side_effect=worker) as provider, \
            patch.object(issue_work, "_run", side_effect=git), pytest.raises(RuntimeError, match="original push|before push"):
        api.main()
    provider.assert_called_once()
    client.post.assert_not_awaited()
    assert len(pushes) == int(lost_push)
    call, = api.logs_selected({"latest": [], "ids": [], "correlations": ["original-native"]})
    assert call["status"] == "failed" and call["resources_settled_at"]
    assert call["action"] == (None if lost_push else "not_started")
    assert call["outcome"] == (None if lost_push else "preflight_failed")
    assert call["artifact"]["phase"] == ("publishing" if lost_push else "preparing_publication")
    if lost_push:
        assert call["artifact"]["publication_head"] == candidate
        assert call["artifact"]["replies_started"] is False
    assert api.read_action_plan(call["id"])["sha"] == call["artifact"]["plan_sha"]
    repo = Path(__file__).resolve().parents[3]
    output = repo / "test-results"
    output.mkdir(exist_ok=True)
    with TemporaryDirectory(prefix="publication-recovery-", dir=output) as work:
        root = Path(work)
        wire = root / "receipt.json"
        wire.write_text(json.dumps([call]))
        bundle = root / "contract.mjs"
        environment = {"PATH": os.environ["PATH"], "HOME": str(database)}
        built = subprocess.run([str(repo / "node_modules/esbuild/bin/esbuild"),
                                str(repo / "tests/fixtures/publication-recovery-contract.ts"), "--bundle", "--platform=node",
                                "--packages=external", "--format=esm", "--target=node22", f"--outfile={bundle}"],
                               cwd=repo, env=environment, capture_output=True, text=True, timeout=30)
        assert built.returncode == 0, built.stderr
        consumed = subprocess.run(["node", str(bundle), str(wire), scenario], cwd=repo, env=environment,
                                  capture_output=True, text=True, timeout=30)
        assert consumed.returncode == 0, consumed.stderr


@pytest.mark.parametrize("database", ["/dev/shm" if sys.platform == "linux" else None], indirect=True)
@pytest.mark.parametrize("output,cleanup_error,lease_error", [
    ("git", False, False), ("git", True, False), ("git", False, True), ("git-signal", False, False), ("git-empty", False, False),
    ("unsafe", False, False), ("absent", False, False), ("malformed", False, False), ("oversized", False, False),
    ("invalid-shape", False, False), ("cli-signal", False, False),
])
def test_publication_process_failure_survives_caller_cleanup_and_logging(database, tmp_path, monkeypatch, decode_failure, output, cleanup_error, lease_error):
    parent, candidate = "b" * 40, "c" * 40
    private = "private-publication-output"
    token = "test-private-token"
    binaries = tmp_path / "bin"
    binaries.mkdir()
    git = binaries / "git"
    # Only the external Git/GitHub/provider transports are stand-ins. The
    # publication runner, CLI, subprocess wrapper and durable receipts are real.
    git.write_text(f"""#!{sys.executable}
import os, signal, sys
from pathlib import Path
state = Path({str(database / 'committed')!r})
if 'branch' in sys.argv: print('poise/issue-7')
elif 'get-url' in sys.argv: print('https://github.com/example/repo.git')
elif 'rev-parse' in sys.argv: print({candidate!r} if state.exists() else {parent!r})
elif 'status' in sys.argv: print(' M seed.txt')
elif 'commit' in sys.argv: state.touch()
elif 'push' in sys.argv:
    print({private!r})
    if {output!r} != 'git-empty':
        sys.stderr.write('fatal: original push rejected\\n' + {token!r} + '\\n' + sys.argv[4] + '\\nCookie: session=private-cookie\\n' + 'x' * 200000 + '\\nfinal push cause\\n')
    if {output!r} == 'git-signal': os.kill(os.getpid(), signal.SIGTERM)
    sys.exit(128)
""")
    git.chmod(0o700)
    unsafe = {
        "unsafe": private,
        "absent": "",
        "malformed": "caller_diagnostic: {" + private,
        "oversized": "caller_diagnostic: " + json.dumps({"version": 1, "source": "caller", "severity": "error",
            "operation": "push", "stderr": private * 10000}),
        "invalid-shape": "caller_diagnostic: " + json.dumps({"version": 1, "source": "caller", "severity": "error",
            "operation": "push", "stderr": private, "filesystem": []}),
        "cli-signal": private,
    }
    pull = {"number": 3, "state": "open", "head": {"ref": "poise/issue-7", "sha": parent,
            "repo": {"full_name": "example/repo"}}, "user": {"login": "author"}, "body": "<!-- poise-chain example/repo#7 -->"}
    graph = {"repository": {"ref": {"target": {"oid": parent, "message": "fix: parent"}},
        "defaultBranchRef": {"target": {"oid": parent}},
        "issue": {"closedByPullRequestsReferences": {"nodes": [], "pageInfo": {"hasNextPage": False}}}}}
    cli = binaries / "github-interface"
    cli.write_text(f"""#!{sys.executable}
import os, signal, sys
from types import SimpleNamespace
from unittest.mock import AsyncMock
from github_interface import cli
from github_interface.behaviors import issue_work
from github_interface.atoms.review_identity import work_publication
async def get(path):
    if path == '/repos/example/repo': return {{'full_name': 'example/repo', 'default_branch': 'main'}}
    return {pull!r} if path.endswith('/pulls/3') else {{'state': 'open'}}
client = SimpleNamespace(token={token!r}, get=AsyncMock(side_effect=get),
    paginate=AsyncMock(return_value=[{pull!r}]), graphql=AsyncMock(return_value={graph!r}),
    post=AsyncMock(side_effect=AssertionError('no GitHub write may follow a failed push')))
async def publish(payload):
    if {output.startswith('git')!r}: return await issue_work.run(client, payload)
    work_publication({candidate!r})
    sys.stdout.write({private!r})
    sys.stderr.write({unsafe.get(output, '')!r})
    sys.stderr.flush()
    if {output!r} == 'cli-signal': os.kill(os.getpid(), signal.SIGTERM)
    raise SystemExit(53)
cli.issue_work = publish
cli.main()
""")
    cli.chmod(0o700)
    monkeypatch.setenv("PATH", str(binaries) + os.pathsep + os.environ["PATH"])
    monkeypatch.setenv("GITHUB_INTERFACE_CLI", str(cli))
    monkeypatch.setenv("HOME", str(database))
    original_interface, original_track = issue_review.interface, api.track
    original_check, cleanup_seen = ownership.process_check, []

    def track(*args, **kwargs):
        with patch.object(api, "_native_cli", False):
            return original_track(*args, **kwargs)

    def interface(*args, **kwargs):
        if args[0] == "--pr-review":
            return {"review_threads": [{"root_comment_id": 17, "is_resolved": False}]}
        if args[0] != "--issue-work":
            return {}
        mode = args[args.index("--mode") + 1]
        if mode == "publish":
            return original_interface(*args, **kwargs)
        if mode == "prepare":
            Path(args[args.index("--path") + 1]).mkdir()
        return {"outcome": "prepared" if mode == "prepare" else "validated", "checkout_head": parent}

    def worker(_lease, _args, **kwargs):
        (Path(kwargs["cwd"]).parent / "publication.json").write_text(json.dumps({
            "commitMessage": "fix: seed", "title": "fix: seed", "body": "Concrete seed change",
            "replies": [{"commentId": 17, "body": "Fixed the finding"}], "blocked": None}))
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    def process_check(path, call_id, *, complete=False):
        with api.db() as conn:
            raw = conn.execute("select diagnostic from calls where id=?", (call_id,)).fetchone()[0]
        if cleanup_error and raw and not cleanup_seen:
            assert json.loads(raw)["operation"] == "push", "original cause must be committed before cleanup"
            cleanup_seen.append(True)
            raise RuntimeError("later cleanup " + private)
        return original_check(path, call_id, complete=complete)

    def lease_factory(*args, **kwargs):
        lease = MagicMock()
        lease.held = True
        if lease_error:
            lease.release.side_effect = api.atomic_work.checkout_lock.WorkerOrphaned(
                "native checkout settlement is unverified: idle check failed")
        return lease

    monkeypatch.setattr(api, "track", track)
    monkeypatch.setattr(api, "CATALOG", SimpleNamespace(issue_review_model=lambda _: SimpleNamespace(identity="fixture", provider="codex")))
    monkeypatch.setattr(issue_review, "interface", interface)
    monkeypatch.setattr(issue_review, "packet", lambda *args: {"issue": {"state": "open"}})
    monkeypatch.setattr(issue_review, "command", lambda *args: (["fixture"], "", {}))
    monkeypatch.setattr(issue_review, "stop_leftovers", lambda *args: None)
    monkeypatch.setattr(issue_review, "_cwd_pids", lambda *args, **kwargs: [])
    monkeypatch.setattr(api.atomic_work.checkout_lock, "Lease", lease_factory)
    monkeypatch.setattr(api.atomic_work.checkout_lock, "run_gated", worker)
    monkeypatch.setattr(ownership, "process_check", process_check)
    monkeypatch.setattr(api, "_main", lambda: api.run_atomic_work("example/repo#7", "author", "poise:behavior-chain",
        "original-native", "fixture", "poise/issue-7", pull=3, expected_head=parent))
    monkeypatch.setattr(sys, "argv", ["agent-interface", "--atomic-work", "example/repo#7", "--source",
                                     "poise:behavior-chain", "--correlation-id", "original-native"])
    expected = "later cleanup" if cleanup_error else "native checkout settlement" if lease_error else "during publishing"
    with pytest.raises(RuntimeError, match=expected):
        api.main()
    stored, decoded = decode_failure()
    evidence = stored["diagnostic"]
    valid = output.startswith("git")
    exit_code = 128 if valid and output != "git-signal" else 53 if output != "cli-signal" and not valid else None
    term_signal = signal.SIGTERM if output in {"git-signal", "cli-signal"} else None
    assert (evidence["operation"], evidence["phase"]) == ("push" if valid else "github-interface", "publishing")
    assert (evidence["exit_code"], evidence["signal"]) == (exit_code, term_signal)
    assert decoded["context"]["exit_code"] == exit_code and decoded["context"]["signal"] == term_signal
    assert evidence["call_id"] == stored["id"] and evidence["correlation_id"] == "original-native"
    assert "publishing" in stored["error"]
    cli_code = 1 if valid else -signal.SIGTERM if output == "cli-signal" else 53
    assert f"return code {cli_code}" in stored["error"]
    if valid and output != "git-empty":
        assert "original push rejected" in stored["error"] and "final push cause" in evidence["stderr"]
        assert evidence["stderr_truncated"] is True
    else:
        assert "cause unavailable" in stored["error"] and evidence["stderr"] == ""
    assert (stored["status"], stored["action"], stored["outcome"]) == ("failed", None, None)
    expected_phase = "resources_unknown" if lease_error else "publishing"
    assert stored["artifact"]["phase"] == expected_phase and stored["artifact"]["publication_head"] == candidate
    assert stored["artifact"]["replies_started"] is False
    if lease_error:
        assert "native checkout settlement" in stored["error"] and "(original failure:" in stored["error"]
        assert stored["resources_settled_at"] is None and not ownership.released(stored["resource_ownership"])
    else:
        assert stored["resources_settled_at"] and ownership.released(stored["resource_ownership"])
    assert bool(cleanup_seen) == cleanup_error
    event, = api.diagnostics()["events"]
    assert event["diagnostic"] == evidence and event["error"] == stored["error"]
    for secret in (private, token, "private-cookie", "Authorization: Basic"):
        assert secret not in json.dumps(stored) + json.dumps(event)
    repo = Path(__file__).resolve().parents[3]
    with TemporaryDirectory(prefix="publication-failure-", dir=repo / "test-results") as work:
        bundle, wire = Path(work) / "contract.mjs", Path(work) / "call.json"
        wire.write_text(json.dumps([stored]))
        built = subprocess.run([str(repo / "node_modules/esbuild/bin/esbuild"), str(repo / "tests/fixtures/publication-recovery-contract.ts"),
            "--bundle", "--platform=node", "--packages=external", "--format=esm", "--target=node22", f"--outfile={bundle}"],
            cwd=repo, capture_output=True, text=True, timeout=30)
        assert built.returncode == 0, built.stderr
        consumed = subprocess.run(["node", str(bundle), str(wire), "merged-parent"], cwd=repo, capture_output=True, text=True, timeout=30)
        assert consumed.returncode == 0, consumed.stderr


# Real cleanup needs consistent file/directory device IDs on managed test boxes.
@pytest.mark.parametrize("database", ["/dev/shm" if sys.platform == "linux" else None], indirect=True)
@pytest.mark.parametrize("step,phase,detail,trip", [
    ("checkout", "preparing_checkout", "ValueError", ""),
    ("checkout", "preparing_checkout", "ValueError", "not signed in"),
    ("checkout", "preparing_checkout", "ValueError", "status 429"),
    ("json", "reading_publication", "invalid JSON at line 1, column 1", ""),
    ("metadata", "validating_publication", "atomic behavior publication metadata is incomplete", ""),
])
def test_atomic_preflight_failure_survives_native_receipt_and_logging(database, monkeypatch, decode_failure, step, phase, detail, trip):
    private = "private-provider-prompt ghp_private123 Authorization: Bearer header-secret " * 4000
    original = ValueError(trip + " " + private)
    modes = []
    original_track = api.track

    def track(*args, **kwargs):
        # Only the physical namespace is a stand-in. Native Progress/finish
        # retain the failure around the real atomic runner and resource cleanup.
        with patch.object(api, "_native_cli", False):
            return original_track(*args, **kwargs)

    def interface(*args, **kwargs):
        mode = args[args.index("--mode") + 1]
        modes.append(mode)
        assert mode == "prepare", "a failed preflight must not validate or publish"
        if step == "checkout":
            raise original
        Path(args[args.index("--path") + 1]).mkdir()
        return {"outcome": "prepared", "checkout_head": "b" * 40}

    def worker(_lease, _args, **kwargs):
        output = Path(kwargs["cwd"]).parent / "publication.json"
        output.write_text(private[:2000] if step == "json" else json.dumps({"body": private[:2000]}))
        return SimpleNamespace(returncode=0, stdout=private, stderr=private)

    monkeypatch.setattr(api, "track", track)
    monkeypatch.setattr(api, "CATALOG", SimpleNamespace(issue_review_model=lambda _: SimpleNamespace(identity="fixture", provider="codex")))
    monkeypatch.setattr(issue_review, "WORK_ROOT", database / "issue-review")
    monkeypatch.setattr(issue_review, "packet", lambda *args: {"issue": {"state": "open"}})
    monkeypatch.setattr(issue_review, "interface", interface)
    monkeypatch.setattr(issue_review, "command", lambda *args: (["fixture", private], "", {}))
    monkeypatch.setattr(issue_review, "stop_leftovers", lambda *args: None)
    monkeypatch.setattr(issue_review, "_cwd_pids", lambda *args, **kwargs: [])
    monkeypatch.setattr(issue_review, "_terminal_failure", lambda *args: None)
    monkeypatch.setattr(api.atomic_work.checkout_lock, "Lease", lambda *args, **kwargs: MagicMock())
    monkeypatch.setattr(api.atomic_work.checkout_lock, "run_gated", worker)
    monkeypatch.setattr(api, "_main", lambda: api.run_atomic_work("example/repo#7", "reviewer", "poise:behavior-chain",
                                                               "original-native", "fixture", "poise/issue-7"))
    monkeypatch.setattr(sys, "argv", ["agent-interface", "--atomic-work", "example/repo#7", "--source", "poise:behavior-chain",
                                      "--correlation-id", "original-native"])
    with pytest.raises(ValueError) as caught:
        api.main()
    if step == "checkout":
        assert caught.value is original and str(caught.value) == trip + " " + private
    stored, decoded = decode_failure()
    evidence = stored["diagnostic"]
    assert (stored["status"], stored["error_code"], stored["action"], stored["outcome"], stored["head_sha"]) == (
        "failed", "atomic_work_failed", "not_started", "preflight_failed", None)
    assert evidence["phase"] == phase
    assert detail in evidence["message"] and phase in stored["error"]
    if trip:
        assert stored["error"].startswith(trip + ": ")
    assert stored["error"] == evidence["message"] == decoded["context"]["message"]
    assert evidence["correlation_id"] == "original-native" and evidence["call_id"] == stored["id"]
    assert len(stored["error"]) <= 501 and len(json.dumps(evidence)) < 2048
    assert stored["resources_settled_at"] is not None, stored["resource_ownership"]
    assert ownership.released(stored["resource_ownership"])
    with api.db() as conn:
        assert conn.execute("select action_plan from calls where id=?", (stored["id"],)).fetchone()[0] is None
    assert modes == ["prepare"]
    diagnostic, = api.diagnostics()["events"]
    assert diagnostic["error"] == stored["error"] and diagnostic["diagnostic"] == evidence
    for secret in ("private-provider", "ghp_private123", "header-secret"):
        assert secret not in json.dumps(stored) + json.dumps(diagnostic)
    # The ordinary Logging reader and chain reconciliation consume those same
    # persisted bytes; diagnostics cannot hold retries or release pending work.
    repo = Path(__file__).resolve().parents[3]
    with TemporaryDirectory(prefix="atomic-failure-", dir=repo / "test-results") as work:
        bundle, wire = Path(work) / "contract.mjs", Path(work) / "call.json"
        environment = {"PATH": os.environ["PATH"], "HOME": str(database), "TMPDIR": work}
        built = subprocess.run([str(repo / "node_modules/esbuild/bin/esbuild"), str(repo / "tests/fixtures/behavior-fence-contract.ts"),
                                "--bundle", "--platform=node", "--packages=external", "--format=esm", "--target=node22", f"--outfile={bundle}"],
                               cwd=repo, env=environment, capture_output=True, text=True, timeout=30)
        assert built.returncode == 0, built.stderr
        wire.write_text(json.dumps([stored]))
        consumed = subprocess.run(["node", str(bundle), str(wire), "atomic-work-failed"], cwd=repo, env=environment,
                                  capture_output=True, text=True, timeout=30)
        assert consumed.returncode == 0, consumed.stderr
        assert json.loads(consumed.stdout) == {"accepted": 1, "settled": 1, "reservations": 0}


def completed_pytest_then_no_result(directory, setup):
    """Real pytest and offload client; only the remote transport is a stand-in."""
    repo = Path(__file__).resolve().parents[3]
    work, hooks = directory / "pytest-gate", directory / "hooks"
    work.mkdir()
    hooks.mkdir()
    paths = ["caller/agent_interface/tests", "caller/github_interface/tests", "caller/github_datastore/tests"]
    for name in paths:
        (work / name).mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(work)], check=True)
    secret = "completed-pytest-credential-sentinel"
    folded = "folded-opaque-value-outside-env"
    # One failure line past the client's 64 KiB bound: its head must still
    # carry the folded-header state to the continuation line.
    pad = "P" * 70000
    test = paths[0] + "/test_codex_credentials.py::TestToken::test_credentials_are_redacted_before_cli_serialization[retained response]"
    fixture = ("import pytest\n@pytest.fixture\ndef broken():\n"
               f"    raise RuntimeError('first setup cause {secret}\\nAuthorization: Bearer {pad}\\n  {folded}')\n"
               "class TestToken:\n"
               "    @pytest.mark.parametrize('body', ['retained response'])\n"
               "    def test_credentials_are_redacted_before_cli_serialization(self, broken, body):\n        pass\n") if setup else (
                   "import pytest\nclass TestToken:\n"
                   "    @pytest.mark.parametrize('body', ['retained response'])\n"
                   "    def test_credentials_are_redacted_before_cli_serialization(self, body):\n"
                   f"        assert 1 == 2, 'first assertion cause {secret}\\nAuthorization: Bearer {pad}\\n  {folded}'\n")
    (work / paths[0] / "test_codex_credentials.py").write_text(fixture + "\ndef test_later_failure():\n    assert False, 'later unrelated cause'\n")
    # Pytest emits this after its detailed reports and short test summary.
    (work / "conftest.py").write_text("def pytest_terminal_summary(terminalreporter):\n"
                                     "    terminalreporter.write_line('console noise ' * 40000)\n")
    environment = {"PATH": os.environ["PATH"], "HOME": str(directory), "TEST_API_KEY": secret}
    suite = subprocess.run([sys.executable, "-m", "pytest", *paths], cwd=work, env=environment,
                           capture_output=True, text=True, timeout=30)
    assert suite.returncode == 1, suite.stdout + suite.stderr
    assert len(suite.stdout) > 400000 and test in suite.stdout
    header = next(line for line in suite.stdout.splitlines() if line.startswith("E ") and "Authorization: Bearer" in line)
    assert len(header) > 64 * 1024, "the fixture must drive the oversized-header path"
    for name in ("run.mjs", "redaction.mjs"):
        copyfile(repo / "scripts/test-offload" / name, hooks / name)
    original_run, later_run = "d" * 32, "e" * 32
    relay_reason = "[poise] no test result: later attempt expired. This says nothing about your code. Skip local tests for this work"

    def frame(kind, value):
        payload = value.encode()
        return bytes([kind]) + len(payload).to_bytes(4, "big") + payload

    class Relay(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            self.rfile.read(int(self.headers.get("content-length", 0)))
            self.send_response(201)
            self.end_headers()
            self.wfile.write(json.dumps({"id": original_run if len(admitted) == 0 else later_run}).encode())
            admitted.append(self.path)

        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            if original_run in self.path:
                # Split output frames arbitrarily, as the real relay does.
                output = frame(1, suite.stdout) + frame(2, suite.stderr) + frame(3, str(suite.returncode))
                for start in range(0, len(output), 1777):
                    self.wfile.write(output[start:start + 1777])
            else:
                self.wfile.write(frame(4, chr(124) + "later attempt expired"))

    admitted = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), Relay)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    (hooks / "relay").write_text(f"http://127.0.0.1:{server.server_port}\nfixture-key\n")
    command = ["node", str(hooks / "run.mjs"), "--", sys.executable, "-m", "pytest", *paths]
    try:
        completed = subprocess.run(command, cwd=work, env=environment, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, text=True, timeout=30)
        assert completed.returncode == suite.returncode, completed.stdout[-4096:]
        identity = re.search(r"candidate ([a-f0-9]{64}), suite .*, run ([a-f0-9]{32})", completed.stdout)
        assert identity and identity[2] == original_run
        # What the worker can see after its tool truncates the console.
        visible = completed.stdout[-4096:]
        assert "checkout sent" not in visible and "suite python" not in visible
        summary = visible[visible.index("[poise] completed Caller pytest failure:"):].strip()
        assert len(summary) < 2600 and secret not in summary and "[redacted]" in summary
        assert folded not in summary, "a folded header continuation is a credential even outside the environment secrets"
        (work / paths[0] / "test_codex_credentials.py").write_text("# a later candidate\n")
        later = subprocess.run(command, cwd=work, env=environment, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, timeout=30)
        assert later.returncode == 124 and relay_reason in later.stdout
        assert later_run in later.stdout and "completed Caller pytest failure:" not in later.stdout
        later_candidate = re.search(r"candidate ([a-f0-9]{64}), suite .*, run", later.stdout)[1]
        assert later_candidate != identity[1]
        return summary + "; Later attempt: " + later.stdout, identity[1], original_run, test, secret, relay_reason, folded
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.mark.parametrize("database", ["/dev/shm" if sys.platform == "linux" else None], indirect=True)
@pytest.mark.parametrize("observed", ["assertion", "timeout", "marker", "none", "completed_assertion", "completed_setup"])
def test_atomic_failure_then_relay_timeout_survives_checkout_reclamation(database, monkeypatch, decode_failure, observed):
    candidate, run = "c" * 64, "d" * 32
    excerpt = "AssertionError: expected 1 to equal 2"
    test = "fixture.validation::test_first_failure"
    if observed == "timeout":
        repo = Path(__file__).resolve().parents[3]
        (repo / "test-results").mkdir(exist_ok=True)
        with TemporaryDirectory(prefix="vitest-timeout-", dir=repo / "test-results") as work:
            fixture = Path(work)
            (fixture / "vitest.config.mjs").write_text(
                f"import config from {json.dumps(str(repo / 'vitest.config.ts'))};\n"
                "export default { ...config, test: { ...config.test, setupFiles: [], "
                "include: ['timeout.test.mjs'], pool: 'threads' } };\n")
            (fixture / "timeout.test.mjs").write_text(
                "import { describe, it } from 'vitest';\n"
                "describe('offload reporting', () => {\n"
                "  it('first timed out expectation', async () => { await new Promise(() => {}); }, 200);\n"
                "  it('keeps the suite open', async ({ annotate }) => {\n"
                "    await annotate('completed cases delivered before holding the suite open');\n"
                "    console.log('VITEST_HELD');\n"
                "    await new Promise(() => {});\n"
                "  }, 60000);\n"
                "});\n")
            with subprocess.Popen(["node", str(repo / "node_modules/vitest/vitest.mjs"), "run"], cwd=work,
                                  env={"PATH": os.environ["PATH"], "HOME": work, "TMPDIR": work, "CI": "1"},
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as child:
                try:
                    with pytest.raises(subprocess.TimeoutExpired):
                        child.communicate(timeout=10)
                finally:
                    child.kill()
                    stdout, stderr = child.communicate()
            assert "VITEST_HELD" in stdout and "Test Files" not in stdout, (stdout, stderr)
            assert stderr.count("[poise] first test failure:") == 1, stderr
            excerpt = " ".join(stderr[stderr.index("[poise] first test failure:"):].split())
            test = "timeout.test.mjs > offload reporting > first timed out expectation"
            assert test in excerpt and "Test timed out in 200ms" in excerpt, excerpt
    failed = observed in {"assertion", "timeout"}
    secret = "opaque-credential-spanning-the-summary-cutoff"
    relay = ("[poise] no test result: the test offload exhausted its total time budget. "
             "This says nothing about your code. Skip local tests for this work: don't retry, "
             "and don't run parts of it. Push your change and let CI run the tests.")
    # Stress both summary truncation and JSON's worst-case Unicode expansion.
    prefix = "First observed failure: "
    reason = prefix + "\U0001F600" * (492 - len(prefix)) + secret + "; "
    reason += f"{excerpt}; suite/test {test}; captured candidate {candidate}; producing run {run}; {relay}; "
    reason += "\U0001F600" * 7000
    assert reason.index(secret) < 500 < reason.index(secret) + len(secret)
    assert reason.index(excerpt) > 500
    blocked = reason if failed else (
        f"FAIL {test}; assertion details unavailable; captured candidate unavailable; producing run unavailable; {relay}"
        if observed == "marker" else None)
    if observed.startswith("completed_"):
        blocked, candidate, run, test, secret, relay, folded = completed_pytest_then_no_result(database, observed == "completed_setup")
        excerpt = "RuntimeError: first setup cause" if observed == "completed_setup" else "first assertion cause"
    else:
        folded = "folded-opaque-value-outside-env"
    publication = {"commitMessage": "fix: seed", "title": "fix: seed", "replies": [], "blocked": blocked,
                   "body": f"fixture validation: {relay} Local verification is incomplete; required CI and review remain mandatory."}
    modes, instructions, checkouts = [], [], []
    original_track = api.track

    def track(*args, **kwargs):
        # Only the physical namespace is a stand-in; main's real finalizer must
        # retain the original Call and certify the reclaimed resources.
        with patch.object(api, "_native_cli", False):
            return original_track(*args, **kwargs)

    def interface(*args, **kwargs):
        mode = args[args.index("--mode") + 1]
        modes.append(mode)
        if mode == "prepare":
            checkout = Path(args[args.index("--path") + 1])
            checkout.mkdir()
            checkouts.append(checkout)
            return {"outcome": "prepared", "checkout_head": "b" * 40}
        assert observed == "none", "an observed failure must never validate or publish"
        assert args[args.index("--body") + 1] == publication["body"]
        return {"outcome": "validated" if mode == "validate" else "published", "head_sha": "b" * 40}

    def command(_model, instruction, *args):
        instructions.append(instruction)
        return ["fixture"], "", {}

    def worker(_lease, _args, **kwargs):
        # The stand-in worker copies its visible completion summary first, as
        # instructed. Native Caller never scrapes the provider's raw output.
        (Path(kwargs["cwd"]).parent / "publication.json").write_text(json.dumps(publication, ensure_ascii=False))
        return SimpleNamespace(returncode=0, stdout="private provider output", stderr="private provider stderr")

    monkeypatch.setenv("TEST_API_KEY", secret)
    monkeypatch.setattr(api, "track", track)
    monkeypatch.setattr(api, "CATALOG", SimpleNamespace(issue_review_model=lambda _: SimpleNamespace(identity="fixture", provider="codex")))
    monkeypatch.setattr(issue_review, "WORK_ROOT", database / "issue-review")
    monkeypatch.setattr(issue_review, "packet", lambda *args: {"issue": {"state": "open"}})
    monkeypatch.setattr(issue_review, "interface", interface)
    monkeypatch.setattr(issue_review, "command", command)
    monkeypatch.setattr(issue_review, "stop_leftovers", lambda *args: None)
    monkeypatch.setattr(issue_review, "_cwd_pids", lambda *args, **kwargs: [])
    monkeypatch.setattr(issue_review, "_terminal_failure", lambda *args: None)
    monkeypatch.setattr(api.atomic_work.checkout_lock, "Lease", lambda *args, **kwargs: MagicMock())
    monkeypatch.setattr(api.atomic_work.checkout_lock, "run_gated", worker)
    monkeypatch.setattr(api, "_main", lambda: api.run_atomic_work("example/repo#7", "reviewer", "poise:behavior-chain",
                                                               "original-native", "fixture", "poise/issue-7"))
    monkeypatch.setattr(sys, "argv", ["agent-interface", "--atomic-work", "example/repo#7", "--source", "poise:behavior-chain",
                                      "--correlation-id", "original-native"])
    if observed == "none":
        api.main()
    else:
        with pytest.raises(api.atomic_work.AtomicWorkBlocked):
            api.main()
    assert not checkouts[0].parent.exists(), "read the original Call only after its checkout and metadata were reclaimed"
    stored, decoded = decode_failure()
    assert ownership.released(stored["resource_ownership"]) and stored["resources_settled_at"] is not None
    with api.db() as conn:
        plan = conn.execute("select action_plan from calls where id=?", (stored["id"],)).fetchone()[0]
    for clause in ("first actionable assertion/failure excerpt", "existing blocked string", "producing run ID",
                   "checkout_head is only the starting HEAD", "assertion details are unavailable",
                   "A later timeout must not overwrite an observed test failure"):
        assert clause in instructions[0]
    if observed == "none":
        assert modes == ["prepare", "validate", "publish"]
        assert (stored["status"], stored["action"], stored["error_code"]) == ("completed", "published", None)
        assert json.loads(plan)["publication"] == publication
        assert decoded is None
        return
    assert modes == ["prepare"] and plan is None
    assert (stored["status"], stored["action"], stored["outcome"], stored["error_code"], stored["head_sha"]) == (
        "failed", "not_started", "preflight_failed", "atomic_work_blocked", None)
    evidence = stored["diagnostic"]
    assert stored["error"] == evidence["message"] and len(stored["error"]) <= len("atomic behavior blocked: ") + 501
    assert decoded["stderr"] == evidence["stderr"]
    assert evidence["stderr_truncated"] == failed
    event, = api.diagnostics()["events"]
    assert event["diagnostic"] == evidence and "evidence_unavailable" not in event
    assert len(json.dumps(event).encode()) <= 64 * 1024
    expected = (excerpt, test, candidate, run, relay) if (failed or observed.startswith("completed_")) else (
        f"FAIL {test}", "assertion details unavailable", "captured candidate unavailable", "producing run unavailable", relay)
    for item in expected:
        assert item in evidence["stderr"]
    if failed:
        assert excerpt not in stored["error"] and evidence["stderr"].index(excerpt) > 500
        assert evidence["stderr"].index(excerpt) < evidence["stderr"].index(relay)
    if observed.startswith("completed_"):
        assert evidence["stderr"].startswith("[poise] completed Caller pytest failure:")
        assert evidence["stderr"].index(run) < evidence["stderr"].index("e" * 32)
        assert evidence["stderr"].index(excerpt) < evidence["stderr"].index(relay)
        assert len(evidence["stderr"]) <= 4096
    for private in (secret, folded, "opaque-credential-", "summary-cutoff", "private provider"):
        assert private not in json.dumps(stored) + json.dumps(event)


@pytest.mark.parametrize("during_cleanup", [False, True])
def test_registered_failure_precedes_handler_and_survives_cleanup(database, monkeypatch, decode_failure, during_cleanup):
    private = "private-provider-prompt credential-value " * 4000
    original = OSError(28, private) if during_cleanup else subprocess.CalledProcessError(17, ["provider", private], stderr=private)
    warning = {"version": 1, "source": "caller", "severity": "warning", "operation": "provider.cli_update",
               "phase": "launcher_verification", "outcome": "unavailable", "message": "Earlier warning",
               "stderr": "", "stderr_truncated": False}

    def prepared(call, _correlation):
        with api.db() as conn:
            conn.execute("update calls set diagnostic=? where id=?", (json.dumps(warning), call))

    def fail_binding(_value):
        raise original

    def execute():
        if during_cleanup:
            call = claim()
            with api.progress.Progress(api.DB, call, "preparing_issue"):
                try:
                    raise original
                finally:
                    raise RuntimeError("later cleanup " + private)
        api.run_governed_behavior(api.pr_review, "pr_review", "https://github.com/example/repo/pull/7", "reviewer",
                                  "a" * 40, "poise:behavior-chain", "original-native", model="fixture")

    monkeypatch.setattr(api, "_enter_native_call", prepared)  # Kernel-boundary stand-in; no provider is started.
    monkeypatch.setattr(api, "CATALOG", SimpleNamespace(review_model=lambda *args: SimpleNamespace(identity="fixture"),
                                                       behaviors={"review_recovery": "fixture"}))
    monkeypatch.setattr(api.review_receipt, "_call", SimpleNamespace(set=fail_binding))
    monkeypatch.setattr(ownership, "cleanup_remaining", lambda *args, **kwargs: None)
    monkeypatch.setattr(ownership, "acknowledge_recovery", lambda *args: None)
    monkeypatch.setattr(api, "_main", execute)
    monkeypatch.setattr(sys, "argv", ["agent-interface", "--pr-review", "example/repo#7", "--source", "poise:behavior-chain",
                                      "--correlation-id", "original-native"])
    with patch.object(api, "review_facts", side_effect=AssertionError("behavior handler must not run")) as handler:
        with pytest.raises(RuntimeError if during_cleanup else subprocess.CalledProcessError):
            api.main()
        handler.assert_not_called()
    stored, decoded = decode_failure()
    evidence = stored["diagnostic"]
    assert evidence["severity"] == "error" and evidence["call_id"] == stored["id"]
    assert evidence["correlation_id"] == "original-native"
    assert evidence["phase"] == ("preparing_issue" if during_cleanup else "call_setup")
    assert evidence["message"] == ("OSError (ENOSPC)" if during_cleanup else "CalledProcessError")
    assert evidence["exit_code"] == (None if during_cleanup else 17)
    if not during_cleanup:
        assert evidence["operation"] == "agent_interface.review_receipt.bind"
    assert len(json.dumps(evidence)) < 2048
    assert "private-provider" not in json.dumps(evidence) + stored["error"]
    assert decoded["context"]["correlation_id"] == "original-native"
    assert decoded["context"]["message"] == evidence["message"]
    assert stored["resources_settled_at"] is None  # Diagnostics grant no resource proof.


@pytest.mark.parametrize("code", [23, -9])
def test_detached_inner_exit_without_cause_is_retained(database, decode_failure, code):
    # A fork/wait boundary stand-in exercises the actual outer Caller wrapper.
    # The inner continuation uses _exit/a signal, so it cannot run a recorder.
    source = '''
import os
import agent_interface as api
from agent_interface import native_namespace as ns, resource_ownership as owned
class Boundary:
    def __init__(self, *args):
        self.exit_code = None
    def start(self, *args, **kwargs):
        child = os.fork()
        if child == 0:
            ns._active = self
            return True
        _, status = os.waitpid(child, 0)
        self.exit_code = os.waitstatus_to_exitcode(status)
        return False
ns.Namespace = Boundary
ns.require_resource_controller = lambda: None
owned.request_namespace = lambda *args: None
owned.settle_namespace = lambda *args: None
owned.cleanup_remaining = lambda *args, **kwargs: None
owned.acknowledge_recovery = lambda *args: None
api._prepare_native_clis = lambda *args: None
def execute():
    api.track("fixture", "", "7", "example/repo", "reviewer", "issue_review",
              source="poise:behavior-chain", correlation_id="original-native")
    code = int(os.environ["TEST_EXIT"])
    if code < 0:
        os.kill(os.getpid(), -code)
    os._exit(code)
api._main = execute
api.main()
'''
    env = {"PATH": "", "HOME": str(database), "AGENT_INTERFACE_DATA_DIR": str(database), "TEST_EXIT": str(code),
           "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
    with subprocess.Popen([sys.executable, "-c", source, "--issue-review", "example/repo#7", "--source", "poise:behavior-chain",
                           "--correlation-id", "original-native"], cwd=database, env=env, start_new_session=True,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) as caller:
        assert caller.wait(timeout=30) == (code if code >= 0 else 128 - code)
    stored, decoded = decode_failure()
    assert stored["error_code"] == "interrupted"
    assert stored["diagnostic"]["outcome"] == "unknown"
    assert "cause unknown" in stored["diagnostic"]["message"]
    assert decoded["context"]["exit_code"] == (code if code >= 0 else None)
    assert decoded["context"]["signal"] == (-code if code < 0 else None)
    assert decoded["context"]["call_id"] == stored["id"]
    assert decoded["context"]["correlation_id"] == "original-native"
    assert stored["resources_settled_at"] is None


def test_failed_duplicate_main_cannot_annotate_original_call(database, monkeypatch):
    call = claim()
    with api.db() as conn:
        before = dict(conn.execute("select * from calls where id=?", (call,)).fetchone())
    monkeypatch.setattr(api, "_main", claim)
    monkeypatch.setattr(sys, "argv", ["agent-interface", "--issue-review", "example/repo#7", "--source", "poise:behavior-chain",
                                      "--correlation-id", "original-native"])
    with pytest.raises(sqlite3.IntegrityError):
        api.main()
    with api.db() as conn:
        assert dict(conn.execute("select * from calls where id=?", (call,)).fetchone()) == before


@pytest.mark.parametrize("cause,signal", [
    ("Provider rate-limited this run for over a minute (codex)", "rate limited"),
    ("API error (status 429 Too Many Requests)", "status 429"),
    ('{"http_status": 429}', "http_status 429"),
    ("Too many requests", "too many requests"),
])
def test_native_failure_preserves_rate_limit_trip_without_prompt(database, monkeypatch, cause, signal):
    # A rate-limited recovery wrapped as review_recovery_failed without a
    # diagnostic; finish() must keep the reviewer trip signal while still
    # excluding prompts and argv from stored evidence.
    private = "private-provider-prompt credential-value " * 200
    call = claim()
    monkeypatch.setattr(api, "_native_cli", True)
    assert api._native_call_id == call
    wrapped = f"grok-4.6-xhigh recovery failed; needs attention: {cause} {private}"
    try:
        raise api.review_budget.ReviewLimitError(wrapped, "review_recovery_failed")
    except api.review_budget.ReviewLimitError as error:
        api.finish(call, "failed", error=str(error), error_code=error.code, diagnostic=error.diagnostic)
    with api.db() as conn:
        row = conn.execute("select error, diagnostic from calls where id=?", (call,)).fetchone()
    assert signal in row["error"]
    assert "private-provider" not in row["error"]
    assert "private-provider" not in row["diagnostic"]


@pytest.mark.parametrize("cause", [
    "error: GitHub 429: rate limit exceeded for resource",
    "verdict failed at line 429",
])
def test_native_failure_never_trips_without_provider_quota(database, monkeypatch, cause):
    # GitHub's own limits and bare numbers must not trip the recovery model.
    call = claim()
    monkeypatch.setattr(api, "_native_cli", True)
    assert api._native_call_id == call
    wrapped = f"grok-4.6-xhigh recovery failed; needs attention: {cause}"
    try:
        raise api.review_budget.ReviewLimitError(wrapped, "review_recovery_failed")
    except api.review_budget.ReviewLimitError as error:
        api.finish(call, "failed", error=str(error), error_code=error.code, diagnostic=error.diagnostic)
    with api.db() as conn:
        row = conn.execute("select error from calls where id=?", (call,)).fetchone()
    assert row["error"] == "ReviewLimitError"


@pytest.mark.parametrize("cause,signal", [
    ("Grok Build usage balance exhausted", "balance exhausted"),
    ("Not signed in", "not signed in"),
])
def test_native_failure_preserves_account_trip_without_prompt(database, monkeypatch, cause, signal):
    # _issue_review_with_recovery wraps a recovery account failure without a
    # diagnostic; finish() must keep the reviewer trip signal while still
    # excluding prompts and argv from stored evidence.
    private = "private-provider-prompt credential-value " * 200
    call = claim()
    monkeypatch.setattr(api, "_native_cli", True)
    assert api._native_call_id == call
    wrapped = f"grok-4.6-xhigh recovery failed; needs attention: {cause} {private}"
    try:
        raise api.review_budget.ReviewLimitError(wrapped, "review_recovery_failed")
    except api.review_budget.ReviewLimitError as error:
        api.finish(call, "failed", error=str(error), error_code=error.code, diagnostic=error.diagnostic)
    with api.db() as conn:
        row = conn.execute("select error, diagnostic from calls where id=?", (call,)).fetchone()
    assert signal in row["error"]
    assert "private-provider" not in row["error"]
    assert "private-provider" not in row["diagnostic"]
