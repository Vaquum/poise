"""SQLite/claim contracts with explicit process-reader stand-ins.

These do not replace the installed-image namespace/filesystem fault checks.
"""
import json
import os
from types import SimpleNamespace
from unittest.mock import patch

import pytest

import agent_interface as api
from agent_interface import native_cleanup as cleanup, process_identity, resource_ownership as ownership


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
        value["errors"] = [{"cause": "x" * 500, "path": None, "at": 5, "recovered_at": 15} for _ in range(230)]
        value["errors"][-1]["recovered_at"] = 20
        encoded = json.dumps(value, separators=(",", ":"))
        assert len(encoded.encode()) < 131072
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
