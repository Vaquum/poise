"""SQLite/claim contracts with explicit process-reader stand-ins.

These do not replace the installed-image namespace/filesystem fault checks.
"""
import json
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

import agent_interface as api
from agent_interface import native_cleanup as cleanup, native_namespace, process_identity, resource_ownership as ownership


@pytest.fixture
def database(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "DB", tmp_path / "calls.sqlite3")
    monkeypatch.setattr(api, "RESPONSES", tmp_path / "responses")
    monkeypatch.setattr(api, "DATA_DIR", tmp_path)
    api.init_db()
    call = api.track("fixture", "claim component fixture", repo="example/repo", actor="reviewer",
                     behavior="issue_review", source="poise:behavior-chain", correlation_id="original")
    with api.db() as db:
        db.execute("update calls set status='failed',resource_ownership=? where id=?",
                   (json.dumps({"version": 2, "roots": [], "errors": [], "namespace": {"state": "requested", "callId": call, "correlation": "original"}}), call))
    return api.DB, call


def test_failure_backoff_keeps_the_first_three_opportunities_and_caps_at_ten_minutes():
    value = {}
    waits = []
    with patch.object(cleanup, "time", return_value=100):
        for _ in range(12):
            value = cleanup._failure_wait(value)
            waits.append(value["next_attempt_at"] - 100)
    assert waits == [60, 60, 60, 120, 240, 480, 600, 600, 600, 600, 600, 600]
    with pytest.raises(RuntimeError, match="failure count"):
        cleanup._failure_wait({"failures": "missing"})


@pytest.mark.parametrize("state", ["alive", "gone", "same-epoch-reuse", "different-epoch", "unreadable"])
def test_claim_takeover_requires_both_original_owners_gone_in_the_same_epoch(database, state, monkeypatch):
    path, call = database
    original = {"version": 1, "pid": 100, "start": "1", "epoch": {"boot": "original"}, "owner_nonce": "old"}
    cleaner = {**original, "pid": 101}
    with api.db() as db:
        db.execute("update calls set pid=100,process_identity=?,resource_cleanup=? where id=?",
                   (json.dumps(original), json.dumps({"owner": json.dumps(cleaner), "token": "old", "attempt_at": 1}), call))
    monkeypatch.setattr(process_identity, "epoch", lambda: original["epoch"] if state != "different-epoch" else {"boot": "replacement"})

    def observed(encoded, pid):
        if state == "unreadable":
            raise RuntimeError("original reader unavailable")
        if state == "alive":
            return "alive"
        return "different" if state in {"different-epoch", "same-epoch-reuse"} else "gone"

    monkeypatch.setattr(process_identity, "state", observed)
    token, reason = cleanup._claim(path, call)
    assert bool(token) is (state in {"gone", "same-epoch-reuse"})
    assert bool(reason) is (token is None)
    with api.db() as db:
        retained = json.loads(db.execute("select resource_cleanup from calls where id=?", (call,)).fetchone()[0])
    if token:
        assert retained["token"] != "old" and "owner" in retained
    else:
        assert retained["token"] == "old" and retained["next_attempt_at"] > retained["attempt_at"]


def test_live_original_finalizer_keeps_its_initial_claim(database, monkeypatch):
    path, call = database
    monkeypatch.setattr(process_identity, "state", lambda encoded, pid: "alive")
    before = None
    with api.db() as db:
        before = db.execute("select resource_ownership from calls where id=?", (call,)).fetchone()[0]
    token, reason = cleanup._claim(path, call)
    assert token is None and "original Caller" in reason
    with api.db() as db:
        assert db.execute("select resource_ownership from calls where id=?", (call,)).fetchone()[0] == before


def test_dry_run_does_not_claim_or_reap_and_skips_legacy_and_fenced_rows(database):
    path, call = database
    with api.db() as db:
        for name, receipt, stamp in (("legacy", {"version": 1, "roots": [], "errors": []}, None), ("fenced", None, "10")):
            db.execute("insert into calls(id,source,status,resource_ownership,resources_settled_at) values(?,?,?,?,?)",
                       (name, "poise:behavior-chain", "failed", json.dumps(receipt) if receipt else None, stamp))
        before = [tuple(row) for row in db.execute("select * from calls order by id")]
    report = cleanup.recover(path, dry_run=True)
    assert report["examined"] == 1 and report["held"][0]["callId"] == call and not report["released"]
    with api.db() as db:
        assert [tuple(row) for row in db.execute("select * from calls order by id")] == before


def test_wait_retains_backoff_without_churning_public_ownership(database):
    path, call = database
    token = "private-original-token"
    with api.db() as db:
        owner = process_identity.capture(os.getpid())
        db.execute("update calls set resource_cleanup=? where id=?", (json.dumps({"token": token, "owner": owner, "attempt_at": 1}), call))
        before = db.execute("select resource_ownership from calls where id=?", (call,)).fetchone()[0]
    cleanup._wait(path, call, token, "retained original failure")
    with api.db() as db:
        row = db.execute("select resource_cleanup,resource_ownership from calls where id=?", (call,)).fetchone()
        assert row[1] == before
        assert json.loads(row[0])["failures"] == 1
    with pytest.raises(RuntimeError, match="no longer owns"):
        cleanup._wait(path, call, token, "stale worker cannot mutate")


def test_recovery_errors_are_retained_and_covered_only_after_original_physical_proof(database, monkeypatch):
    path, call = database
    original_error = {"cause": "resources_unknown", "path": None, "at": 5}
    with api.db() as db:
        value = ownership.read(db, call)
        value["namespace"].update(state="settled", settled_at=10)
        value["errors"] = [original_error]
        ownership._write(db, call, value)
        db.execute("update calls set artifact=? where id=?", (json.dumps({"phase": "resources_unknown", "resource_error": "original cause"}), call))

    class Reader:
        def read(self):
            return {"empty": True}

    monkeypatch.setattr(ownership, "original_scope", lambda *args: Reader())
    with patch.object(ownership, "time", return_value=15):
        ownership.acknowledge_recovery(path, call)
    with api.db() as db:
        recovered = ownership.read(db, call)
        artifact = json.loads(db.execute("select artifact from calls where id=?", (call,)).fetchone()[0])
    assert recovered["errors"] == [{**original_error, "recovered_at": 15}]
    assert ownership.released(recovered)
    assert artifact == {"phase": "resources_unknown", "resource_error": "original cause", "resource_recovered_at": 15}
    with patch.object(ownership, "time", return_value=20):
        ownership.acknowledge_recovery(path, call)
    with api.db() as db:
        assert ownership.read(db, call) == recovered


@pytest.fixture
def retained_inventory(database, monkeypatch):
    path, call = database
    parent = f"/home/poise/.poise/agent-interface/native-resources/{call}"
    identity = {"device": "2049", "inode": "901", "parent_device": "2049", "parent_inode": "900"}
    parents = [{"path": parent + suffix, "state": "reclaimed", **identity, "inode": str(901 + index), "reclaimed_at": 20.125}
               for index, suffix in enumerate(("", "-preparation"))]
    children = [{"path": f"{parents[index % 2]['path']}/pr-attempt-{index:032x}", "state": "registered"}
                for index in range(288)]
    for index, child in enumerate(children[:15]):
        child.update(state="covered", covered_by=parents[index % 2]["path"], reclaimed_at=20.125)
    errors = [{"cause": "original native resource directory handle is unavailable", "path": child["path"], "at": 10.125}
              for child in children]
    address = {"version": 1, "instance": "b" * 32, "path": "/isolated/controller.sock"}
    private = {"address": address, "callId": call, "correlation": "original", "token": "c" * 32}
    binding = {"pid": 4, "start": "4", "namespace": "pid:[9]", "owner": {"pid": 2, "start": "2"},
               "holder": {"pid": 3, "start": "3"},
               "epoch": {"boot": "fixture", "init_start": "1", "namespace_dev": "1", "namespace_ino": "9"}}
    value = {"version": 2, "roots": parents + children, "errors": errors,
             "namespace": {"state": "settled", "callId": call, "correlation": "original", "settled_at": 15.125,
                           "controller": {"version": 1, "instance": address["instance"]}, "binding": binding}}
    # The retained production shape fits the former limit; coverage/recovery grows it.
    assert len(json.dumps(value, separators=(",", ":")).encode()) < 128 * 1024
    owner = json.loads(process_identity.capture(os.getpid()))
    owner["owner_nonce"] = "original-worker"
    original = json.dumps(owner)
    with api.db() as db:
        ownership._write(db, call, value)
        db.execute("update calls set namespace_control=?,process_identity=?,behavior='repair_pr',pr_id='941',"
                   "expected_head=?,outcome='preflight_failed',action='not_started',ended_at=30.125,"
                   "error='provider deadline',error_code='atomic_work_execution_budget_exhausted',artifact=? where id=?",
                   (json.dumps(private), original, "a" * 40, json.dumps({"phase": "executing"}), call))
    observe = process_identity.state
    monkeypatch.setattr(process_identity, "state", lambda encoded, pid: "gone" if encoded == original else observe(encoded, pid))
    monkeypatch.setattr(native_namespace, "control_address", lambda: address)
    proofs = {entry["path"]: dict(entry) for entry in parents}
    reads = []
    clock = [0]

    def control(observed, operation, **request):
        assert observed == address
        assert all(request[key] == private[key] for key in ("callId", "correlation", "token"))
        response = {"callId": call, "correlation": "original"}
        if operation == "read":
            return {**response, "binding": binding, "namespace": binding["namespace"], "pids": [], "empty": True}
        if operation == "retire":
            return {**response, "retired": True, "present": False}
        assert operation in {"read-root", "finish-root"}
        reads.append(request["root"])
        clock[0] += 1
        if request["root"] not in proofs:
            raise RuntimeError("original native resource directory handle is unavailable")
        return {**response, "resource": proofs[request["root"]]}

    monkeypatch.setattr(native_namespace, "control_request", control)
    monkeypatch.setattr(ownership, "monotonic", lambda: clock[0])
    return path, call, value, proofs, reads, clock


def test_retained_ancestor_coverage_yields_and_recovers_the_original_large_call(retained_inventory, tmp_path):
    path, call, original, proofs, reads, clock = retained_inventory
    token, reason = cleanup._claim(path, call)
    assert token and reason is None
    with api.db() as db:
        before = dict(db.execute("select * from calls where id=?", (call,)).fetchone())
    previous = original
    for attempt in range(19):
        ownership.cleanup_remaining(path, call, claim=token, deadline=clock[0] + cleanup.PASS_SECONDS)
        with api.db() as db:
            current = ownership.read(db, call)
            assert db.execute("select resources_settled_at from calls where id=?", (call,)).fetchone()[0] is None
        assert current["roots"][:2] == original["roots"][:2]
        assert current["errors"] == original["errors"]
        for earlier, later in zip(previous["roots"], current["roots"]):
            if earlier["state"] in {"reclaimed", "covered"}:
                assert later == earlier
        assert sum(root["state"] == "covered" for root in current["roots"]) == min(288, 15 + 15 * (attempt + 1))
        if attempt == 0:
            pending_wire = tmp_path / "pending.json"
            pending_wire.write_text(json.dumps(api.logs_selected({"latest": [], "ids": [call]})))
        if attempt < 18:
            with pytest.raises(RuntimeError, match="complete physical proof"):
                ownership.acknowledge_recovery(path, call)
        previous = current
    assert len(reads) == 273 and set(reads) == set(proofs)
    ownership.acknowledge_recovery(path, call)
    with api.db() as db:
        recovered = ownership.read(db, call)
    assert all({key: val for key, val in error.items() if key != "recovered_at"} == original_error
               for error, original_error in zip(recovered["errors"], original["errors"]))
    assert ownership.released(recovered)
    assert len(json.dumps(recovered).encode()) > 128 * 1024
    ownership.acknowledge_recovery(path, call)
    with api.db() as db:
        assert ownership.read(db, call) == recovered
    assert cleanup._complete(path, call, token)
    assert cleanup.recover(path)["examined"] == 0
    with api.db() as db:
        after = dict(db.execute("select * from calls where id=?", (call,)).fetchone())
    for field in ("outcome", "action", "error", "error_code", "artifact", "ended_at", "started_at"):
        assert after[field] == before[field]
    assert after["resources_settled_at"] and after["resource_cleanup"] is None

    repo = Path(__file__).resolve().parents[3]
    contract = repo / "test-results" / f"ancestor-recovery-{call}.mjs"
    contract.parent.mkdir(exist_ok=True)
    env = {"PATH": os.environ["PATH"], "HOME": str(tmp_path), "TMPDIR": str(tmp_path)}
    try:
        subprocess.run([str(repo / "node_modules/esbuild/bin/esbuild"), str(repo / "tests/fixtures/behavior-fence-contract.ts"),
                        "--bundle", "--platform=node", "--packages=external", "--format=esm", "--target=node22", f"--outfile={contract}"],
                       cwd=repo, env=env, capture_output=True, text=True, timeout=30, check=True)
        wire = tmp_path / "recovered.json"
        wire.write_text(json.dumps(api.logs_selected({"latest": [], "ids": [call]})))
        result = subprocess.run(["node", str(contract), str(wire), "ancestor-recovery", str(pending_wire)], cwd=repo, env=env,
                                capture_output=True, text=True, timeout=30)
        assert result.returncode == 0, result.stderr
    finally:
        contract.unlink(missing_ok=True)


@pytest.mark.parametrize("invalid", ["state", "device", "inode", "parent_device", "parent_inode", "reclaimed_at",
                                     "missing-controller", "wrong-controller", "wrong-claim", "unsettled", "unrelated", "allocated", "preparation"])
def test_ancestor_coverage_cannot_release_without_matching_original_proof(retained_inventory, invalid, monkeypatch):
    path, call, value, proofs, reads, clock = retained_inventory
    token, reason = cleanup._claim(path, call)
    assert token and reason is None
    if invalid in {"state", "device", "inode", "parent_device", "parent_inode", "reclaimed_at"}:
        for proof in proofs.values():
            proof[invalid] = "allocated" if invalid == "state" else 21.125 if invalid == "reclaimed_at" else "999"
    with api.db() as db:
        if invalid == "missing-controller":
            db.execute("update calls set namespace_control=null where id=?", (call,))
        if invalid == "wrong-controller":
            monkeypatch.setattr(native_namespace, "control_address", lambda: {"instance": "replacement"})
        if invalid == "unsettled":
            value["namespace"]["state"] = "active"
            value["namespace"].pop("settled_at")
        if invalid == "preparation":
            sibling = value["roots"][1]
            proofs.pop(sibling["path"])
            value["roots"] = [value["roots"][0], {"path": sibling["path"], "state": "registered"}]
            value["errors"] = []
        elif invalid in {"unrelated", "allocated"}:
            child = value["roots"][17]
            child.update(path=proofs[next(iter(proofs))]["path"] + "-lookalike/child" if invalid == "unrelated" else child["path"],
                         **({"state": "allocated", "device": "1", "inode": "2", "parent_device": "1", "parent_inode": "3"}
                            if invalid == "allocated" else {}))
            value["errors"][15]["path"] = child["path"]
        ownership._write(db, call, value)
    if invalid == "wrong-claim":
        token = "stale-claim"
    try:
        ownership.cleanup_remaining(path, call, claim=token, deadline=None if invalid in {"unrelated", "allocated", "preparation"} else 15)
    except RuntimeError as error:
        assert any(cause in str(error) for cause in ("original", "ancestor proof"))
    with api.db() as db:
        pending = ownership.read(db, call)
        assert db.execute("select resources_settled_at from calls where id=?", (call,)).fetchone()[0] is None
    assert not ownership.released(pending)
    if invalid == "preparation":
        assert pending["roots"][1]["state"] == "registered"
        assert reads == [pending["roots"][1]["path"]]
    elif invalid in {"unrelated", "allocated"}:
        assert pending["roots"][17]["state"] == value["roots"][17]["state"]
        assert sum(root["state"] not in {"covered", "reclaimed"} for root in pending["roots"]) == 1
    else:
        assert all(root["state"] != "covered" for root in pending["roots"][17:])
    with pytest.raises(RuntimeError, match="complete physical proof"):
        ownership.acknowledge_recovery(path, call)


def test_registered_child_is_covered_when_its_parent_is_reclaimed_in_the_same_pass(retained_inventory):
    path, call, value, proofs, reads, clock = retained_inventory
    parent = value["roots"][0]
    parent.update(state="allocated")
    parent.pop("reclaimed_at")
    child = value["roots"][18]  # A registered child of this parent.
    value["roots"] = [parent, child]
    value["errors"] = [error for error in value["errors"] if error["path"] == child["path"]]
    with api.db() as db:
        ownership._write(db, call, value)
    token, reason = cleanup._claim(path, call)
    assert token and reason is None
    ownership.cleanup_remaining(path, call, claim=token)
    with api.db() as db:
        result = ownership.read(db, call)
    assert result["roots"][0] == proofs[parent["path"]]
    assert result["roots"][1] == {**child, "state": "covered", "covered_by": parent["path"], "reclaimed_at": 20.125}
    assert reads == [child["path"], parent["path"], parent["path"], parent["path"]]


def test_diagnostic_overflow_releases_the_cleanup_claim_and_keeps_the_next_call_due(database, monkeypatch):
    path, call = database
    second = api.track("fixture", "second due Call", repo="example/repo", actor="reviewer",
                       behavior="issue_review", source="poise:behavior-chain", correlation_id="second")
    with api.db() as db:
        value = json.loads(ownership.initial(second, "second"))
        value["namespace"].update(state="not_started", no_effect="original-no-go", settled_at=10)
        db.execute("update calls set status='failed',resource_ownership=? where id=?", (json.dumps(value), second))
        db.execute("update calls set pid=123 where id in (?,?)", (call, second))
        original = db.execute("select resource_ownership from calls where id=?", (call,)).fetchone()[0]
    observed = process_identity.state
    monkeypatch.setattr(process_identity, "state", lambda encoded, pid: observed(encoded, pid) if pid == os.getpid() else "gone")
    with patch.object(ownership, "failure", side_effect=RuntimeError("native resource ownership receipt exceeds its size limit")) as failure:
        report = cleanup.recover(path)
    failure.assert_called_once()
    assert report["examined"] == 2 and report["released"] == [second]
    assert report["held"][0]["callId"] == call
    assert "diagnostic could not be recorded" in report["held"][0]["reason"]
    assert "size limit" in report["held"][0]["reason"]
    with api.db() as db:
        row = db.execute("select resource_cleanup,resource_ownership,resources_settled_at from calls where id=?", (call,)).fetchone()
        claim = json.loads(row[0])
        assert "owner" not in claim and "token" not in claim
        assert claim["failures"] == 1 and claim["next_attempt_at"] > claim["attempt_at"]
        assert "original native cleanup controller" in claim["last_error"]
        assert row[1] == original and row[2] is None
        assert db.execute("select resources_settled_at from calls where id=?", (second,)).fetchone()[0] is not None
    assert cleanup.recover(path)["examined"] == 0


def test_consolidation_and_repeated_failure_preserve_recovery_ordering(database, monkeypatch):
    path, call = database
    artifact = {"phase": "resources_unknown", "resource_recovered_at": 15}
    with api.db() as db:
        value = ownership.read(db, call)
        value["namespace"].update(state="settled", settled_at=10)
        value["errors"] = [{"cause": "x" * 500, "path": None, "at": 5, "recovered_at": 15} for _ in range(950)]
        value["errors"][-1]["recovered_at"] = 20
        encoded = json.dumps(value, separators=(",", ":"))
        assert len(encoded.encode()) < 512 * 1024
        db.execute("update calls set resource_ownership=?,artifact=? where id=?", (encoded, json.dumps(artifact), call))
    ownership.process_check(path, call, complete=True)
    with api.db() as db:
        compacted = ownership.read(db, call)
    assert compacted["errors"] == [{"cause": "x" * 500, "path": None, "at": 5, "recovered_at": 20}]
    assert ownership.released(compacted)
    assert not ownership.publication_released(30, json.dumps(compacted), artifact)
    with patch.object(ownership, "time", return_value=25):
        ownership.failure(path, call, "x" * 500)
    with api.db() as db:
        assert not ownership.released(ownership.read(db, call))
    reader = SimpleNamespace(read=lambda: {"empty": True})
    monkeypatch.setattr(ownership, "original_scope", lambda *args: reader)
    with patch.object(ownership, "time", return_value=30):
        ownership.acknowledge_recovery(path, call)
    with api.db() as db:
        recovered = ownership.read(db, call)
        artifact = json.loads(db.execute("select artifact from calls where id=?", (call,)).fetchone()[0])
    assert artifact["resource_recovered_at"] == 30
    assert ownership.publication_released(30, json.dumps(recovered), artifact)
