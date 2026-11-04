"""Resource accounting and durable-cause contracts; no provider is invoked."""
import json
import os
import sqlite3
import sys
import threading
import time
from types import SimpleNamespace

import pytest

import agent_interface as api
from agent_interface import resource_guard as guard


@pytest.fixture
def database(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "DB", tmp_path / "calls.sqlite3")
    monkeypatch.setattr(api, "RESPONSES", tmp_path / "responses")
    monkeypatch.setattr(api, "_native_cli", False)
    api.init_db()
    call = api.track("fixture-model", "contract", "7", "example/repo", "reviewer", "implement_issue",
                     source="poise:behavior-chain", correlation_id="guard-contract")
    return call


def receipt(call):
    with api.db() as conn:
        return dict(conn.execute("select * from calls where id=?", (call,)).fetchone())


def observer(call, memory=10, disk=None):
    monitor = guard.Guard(api.DB, call, None, {"version": 1, "memoryBytes": memory, "diskBytes": disk})
    monitor.breach = {"memoryBytes": 11, "diskBytes": 12, "completedAt": 1800000000,
                      "completedMonotonic": 1, "memoryModel": "rss"}
    return monitor


@pytest.mark.parametrize("value", [False, [], {}, {"version": 1, "memoryBytes": None, "diskBytes": None},
                                 {"version": True, "memoryBytes": 1, "diskBytes": None},
                                 {"version": 1, "memoryBytes": 0, "diskBytes": None},
                                 {"version": 1, "memoryBytes": 2 ** 53, "diskBytes": None}])
def test_contradictory_limits_refuse_before_any_execution(value):
    with pytest.raises(ValueError):
        guard.limits(json.dumps(value))


def test_bounded_dimensions_are_explicit_and_legacy_is_unenforced():
    assert guard.limits(None) is None
    assert guard.limits('{"version":1,"memoryBytes":null,"diskBytes":8}') == {
        "version": 1, "memoryBytes": None, "diskBytes": 8}


def test_allocated_disk_deduplicates_links_and_never_follows_symlink(tmp_path):
    own, foreign = tmp_path / "own", tmp_path / "foreign"
    own.mkdir()
    foreign.mkdir()
    (own / "data").write_bytes(b"x" * 65536)
    os.link(own / "data", own / "same-inode")
    (foreign / "unrelated").write_bytes(b"x" * 1048576)
    (own / "outside").symlink_to(foreign, target_is_directory=True)
    fd = os.open(own, os.O_RDONLY)
    try:
        seen = set()
        measured = guard.tree_bytes(fd, seen, threading.Event())
        assert measured == sum(path.lstat().st_blocks * 512 for path in (own, own / "data", own / "outside"))
        assert guard.tree_bytes(fd, seen, threading.Event()) == 0
    finally:
        os.close(fd)


@pytest.mark.skipif(sys.platform != "linux", reason="requires descriptor-backed procfs paths")
@pytest.mark.parametrize("birth_during", ["memory", "disk"])
def test_process_sample_is_not_invalidated_by_birth_during_later_disk_walk(database, tmp_path, monkeypatch, birth_during):
    view, root = tmp_path / "process-view", tmp_path / "owned"
    view.mkdir()
    (view / "1").mkdir()
    root.mkdir()
    (root / "data").write_bytes(b"x" * 65536)
    proc_fd, root_fd = os.open(view, os.O_RDONLY), os.open(root, os.O_RDONLY)
    node = os.fstat(root_fd)
    allocation = {"path": str(root), "state": "allocated", "device": str(node.st_dev), "inode": str(node.st_ino)}
    scope = SimpleNamespace(binding={"owner": {"pid": 1}, "holder": {"pid": 2}},
        resource=lambda *args: {"state": "allocated", "anchor": {"pid": os.getpid(), "rootFd": root_fd}})
    monitor = guard.Guard(api.DB, database, scope, {"version": 1, "memoryBytes": 100, "diskBytes": 1000000})
    monitor.proc = proc_fd
    tree_bytes = guard.tree_bytes
    def memory(directory):
        if birth_during == "memory":
            (view / "2").mkdir(exist_ok=True)
        return 7, "rss"
    def disk(fd, seen, cancelled):
        (view / "2").mkdir(exist_ok=True)
        return tree_bytes(fd, seen, cancelled)
    monkeypatch.setattr(guard, "_identity", lambda *args: None)
    monkeypatch.setattr(guard.native_namespace, "task_identity", lambda *args: {"start": "original"})
    monkeypatch.setattr(guard, "process_memory", memory)
    monkeypatch.setattr(guard, "deleted_bytes", lambda *args: 0)
    monkeypatch.setattr(guard.resource_ownership, "read", lambda *args: {"roots": [allocation]})
    monkeypatch.setattr(guard, "tree_bytes", disk)
    try:
        if birth_during == "memory":
            with pytest.raises(RuntimeError, match="membership changed"):
                monitor._read()
            assert monitor._sample()["memoryBytes"] == 28
        else:
            sample = monitor._read()
            assert sample["memoryBytes"] == 21
            assert sample["diskBytes"] == root.stat().st_blocks * 512 + (root / "data").stat().st_blocks * 512
    finally:
        os.close(proc_fd)
        os.close(root_fd)


@pytest.mark.parametrize("error_type", [FileNotFoundError, ProcessLookupError])
@pytest.mark.parametrize("recovers", [True, False])
def test_short_lived_process_gets_one_fresh_read_before_waiting(database, monkeypatch, error_type, recovers):
    monitor = guard.Guard(api.DB, database, None, {"version": 1, "memoryBytes": 100, "diskBytes": None})
    original_complete = monitor.last_complete
    attempts = []
    sample = {"memoryBytes": 7, "diskBytes": 0, "memoryModel": "rss",
              "completedAt": time.time(), "completedMonotonic": time.monotonic()}
    def read():
        attempts.append(1)
        if len(attempts) == 1:
            raise error_type("process ended during counter read")
        monitor.cancelled.set()
        if not recovers:
            raise error_type("still unavailable")
        return sample
    def wait(seconds):
        assert len(attempts) == 2, "waited a full sampling interval before rereading transient membership"
        return True
    monkeypatch.setattr(monitor, "_read", read)
    monkeypatch.setattr(monitor.cancelled, "wait", wait)
    monitor._run()
    assert monitor.summary["partialSamples"] == (1 if recovers else 2)
    assert monitor.summary["samples"] == int(recovers)
    assert monitor.last_complete == (sample["completedMonotonic"] if recovers else original_complete)
    assert monitor.summary["failure"] is None


def test_unreadable_process_counter_is_not_retried_as_normal_exit(database, monkeypatch):
    monitor = guard.Guard(api.DB, database, None, {"version": 1, "memoryBytes": 100, "diskBytes": None})
    attempts = []
    original_complete = monitor.last_complete
    def read():
        attempts.append(1)
        monitor.cancelled.set()
        raise PermissionError("counter inaccessible")
    monkeypatch.setattr(monitor, "_read", read)
    monitor._run()
    assert len(attempts) == 1 and monitor.summary["partialSamples"] == 1
    assert monitor.summary["samples"] == 0 and monitor.last_complete == original_complete


def test_several_process_exits_can_recover_within_one_sampling_opportunity(database, monkeypatch):
    monitor = guard.Guard(api.DB, database, None, {"version": 1, "memoryBytes": 100, "diskBytes": None})
    attempts = []
    sample = {"memoryBytes": 7, "diskBytes": 0, "memoryModel": "rss",
              "completedAt": time.time(), "completedMonotonic": time.monotonic()}
    def read():
        attempts.append(1)
        if len(attempts) <= 3:
            raise guard.MembershipChanged("resource membership changed during measurement")
        return sample
    monkeypatch.setattr(monitor, "_read", read)
    assert monitor._sample() == sample
    assert len(attempts) == 4
    assert monitor.summary["partialSamples"] == 3


def test_persistent_membership_changes_cannot_extend_coverage_or_retry_forever(database, monkeypatch):
    monitor = guard.Guard(api.DB, database, None, {"version": 1, "memoryBytes": 100, "diskBytes": None})
    monitor.last_complete = 0
    clock, attempts = [0.0], []
    def read():
        attempts.append(1)
        clock[0] += 0.4
        raise guard.MembershipChanged("resource membership changed during measurement")
    monkeypatch.setattr(guard, "monotonic", lambda: clock[0])
    monkeypatch.setattr(monitor, "_read", read)
    with pytest.raises(guard.MembershipChanged):
        monitor._sample()
    assert len(attempts) == 3 and monitor.last_complete == 0
    assert monitor.summary["samples"] == 0
    clock[0] = 5.01
    assert monitor.poll() is True
    assert receipt(database)["error_code"] == "resource_measurement_unavailable"


@pytest.mark.parametrize("memory,disk,code", [(10, None, "resource_memory_exceeded"), (None, 8, "resource_disk_exceeded")])
def test_breach_survives_completion_and_no_write_reclassification(database, memory, disk, code):
    call = database
    monitor = observer(call, memory, disk)
    assert monitor.poll() is True
    api.finish(call, "completed", response='{"accepted":"original-artifact"}', action="published", outcome="published")
    first = receipt(call)
    assert first["status"] == "failed" and first["error_code"] == code
    assert first["action"] is None and first["outcome"] is None
    assert json.loads(first["resource_guard"])["failure"]["code"] == code
    with api.db() as conn:
        conn.execute("update calls set artifact=?,resources_settled_at=? where id=?",
                     ('{"phase":"executing"}', 1, call))
        api.mark_managed_no_write(conn, call)
    assert receipt(call)["action"] is None
    assert receipt(call)["response_path"] == first["response_path"]


@pytest.mark.parametrize("first", ["stopping", "native_timeout", "completed"])
def test_prior_stop_timeout_or_completion_wins_over_later_breach(database, first):
    call = database
    if first == "completed":
        api.finish(call, "completed", response="durable-original")
    else:
        with api.db() as conn:
            conn.execute("update calls set error_code=?,error='original cause' where id=?", (first, call))
    before = receipt(call)
    assert observer(call).poll() is False
    assert receipt(call) == before


def test_unavailable_sample_is_a_durable_stop_not_zero(database, monkeypatch):
    monitor = guard.Guard(api.DB, database, None, {"version": 1, "memoryBytes": 10, "diskBytes": None})
    monitor.last_complete = 1
    monitor.error = "permission denied"
    monkeypatch.setattr(guard, "monotonic", lambda: 7)
    assert monitor.poll() is True
    value = receipt(database)
    assert value["error_code"] == "resource_measurement_unavailable"
    assert "permission denied" in value["error"]


def test_slow_sample_retains_its_current_stage_in_the_stop_cause(database, monkeypatch):
    monitor = guard.Guard(api.DB, database, None, {"version": 1, "memoryBytes": 10, "diskBytes": None})
    monitor.last_complete = 1
    monitor.reading_stage = "allocated blocks"
    monitor.error = "an earlier transient process exit"
    monkeypatch.setattr(guard, "monotonic", lambda: 7)
    assert monitor.poll() is True
    value = receipt(database)
    assert value["error_code"] == "resource_measurement_unavailable"
    assert "still reading allocated blocks" in value["error"]
    assert "earlier transient" not in value["error"]


def test_breach_survives_original_parent_loss_and_reaping(database, monkeypatch):
    assert observer(database).poll() is True
    monkeypatch.setattr(api.process_identity, "state", lambda *args: "gone")
    assert api.reap_interrupted() == 0
    assert receipt(database)["error_code"] == "resource_memory_exceeded"


@pytest.mark.parametrize("phase,no_write", [("executing", True), ("publishing", False)])
def test_terminal_guard_fences_new_publication_but_keeps_an_uncertain_existing_plan(database, phase, no_write):
    call = database
    with api.db() as conn:
        conn.execute("update calls set artifact=?,action_plan=? where id=?",
                     (json.dumps({"phase": phase}), '{"original":"plan"}', call))
    assert observer(call).poll() is True
    row = receipt(call)
    assert row["status"] == "failed"
    assert json.loads(row["resource_guard"])["failure"]["noWrite"] is no_write
    assert row["action_plan"] == '{"original":"plan"}'
    with pytest.raises(ValueError, match="original durable record"):
        api.persist_action_plan(call, {"replacement": "forbidden"})


def test_parent_loss_before_a_breach_does_not_invent_a_limit_failure(database, monkeypatch):
    monkeypatch.setattr(api.process_identity, "state", lambda *args: "gone")
    assert api.reap_interrupted() == 1
    assert receipt(database)["error_code"] == "interrupted"


def test_transient_database_writer_defers_a_healthy_summary_instead_of_killing_work(database):
    monitor = guard.Guard(api.DB, database, None, {"version": 1, "memoryBytes": 10, "diskBytes": None})
    monitor.summary["samples"] = 1
    with api.db() as writer:
        writer.execute("begin immediate")
        started = time.monotonic()
        assert monitor.poll() is False
        assert time.monotonic() - started < 0.2
        assert receipt(database)["status"] == "running"
    assert monitor.poll() is False
    assert json.loads(receipt(database)["resource_guard"])["samples"] == 1


def test_breach_waits_briefly_for_a_writer_then_commits_before_stop(database):
    monitor = observer(database)
    monitor.breach["completedMonotonic"] = time.monotonic()
    with api.db() as writer:
        writer.execute("begin immediate")
        assert monitor.poll() is False
        assert receipt(database)["status"] == "running"
    assert monitor.poll() is True
    assert receipt(database)["error_code"] == "resource_memory_exceeded"


def test_journal_outage_cannot_make_the_physical_stop_wait_indefinitely(database):
    monitor = observer(database)
    monitor.breach["completedMonotonic"] = time.monotonic() - 2
    with api.db() as writer:
        writer.execute("begin immediate")
        with pytest.raises(guard.ReceiptUnavailable, match="Cannot commit original resource stop receipt"):
            monitor.poll()
        assert receipt(database)["status"] == "running"


def test_unexpected_database_errors_are_not_tolerated_as_contention(database, monkeypatch):
    monitor = observer(database)
    def corrupt(*args, **kwargs):
        raise sqlite3.OperationalError("not a lock failure")
    monkeypatch.setattr(guard.caller_store, "connect", corrupt)
    with pytest.raises(sqlite3.OperationalError, match="not a lock failure"):
        monitor.poll()


def test_actual_pretrack_fallback_is_a_resource_released_no_worker_receipt(database, monkeypatch):
    def preparation_failed():
        raise RuntimeError("catalog preparation failed before tracking")
    def forbidden(*args, **kwargs):
        pytest.fail("pre-track fallback started a native boundary")
    monkeypatch.setattr(api, "_main", preparation_failed)
    monkeypatch.setattr(api.native_namespace, "Namespace", forbidden)
    monkeypatch.setattr(sys, "argv", ['agent-interface', '--issue-review', 'example/repo#7',
        '--model', 'fixture-model', '--actor', 'reviewer', '--source', 'poise:behavior-chain',
        '--correlation-id', 'pretrack-fallback', '--resource-limits-json', '{"version":1,"memoryBytes":10,"diskBytes":null}'])
    with pytest.raises(RuntimeError, match="before tracking"):
        api.main()
    value = api.logs_selected({'latest': [], 'ids': [], 'correlations': ['pretrack-fallback']})[0]
    assert value['error_code'] == 'launch_preflight_failed'
    assert value['action'] == 'not_started' and value['outcome'] == 'preflight_failed'
    assert value['resource_ownership'] == {'version': 1, 'roots': [], 'errors': []}
    assert value['resource_guard'] is None and value['resources_settled_at'] is not None
