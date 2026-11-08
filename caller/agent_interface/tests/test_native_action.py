"""Fixed-command transport/SQLite tests, not native workflow acceptance."""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

import agent_interface as api
from agent_interface import native_action


@pytest.fixture
def database(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "DB", tmp_path / "calls.sqlite3")
    monkeypatch.setattr(api, "RESPONSES", tmp_path / "responses")
    monkeypatch.setattr(api, "_native_cli", False)
    api.init_db()
    return tmp_path


def original():
    call = api.track("native-action", "merge", "7", "example/repo", "reviewer", "native_action",
                     expected_head="a" * 40, source="poise:behavior-chain", correlation_id="original-action")
    request = {"command": "github-interface", "argv": ["--merge-if-ready", "7"], "cwd": "/example/repo"}
    digest = hashlib.sha256(json.dumps(request, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    api.persist_action_plan(call, {"kind": "native_action", "request": request})
    api._native_action_artifact(call, "preparing_native_action", digest)
    api._native_action_artifact(call, "performing_native_action", digest)
    return call, digest


def row(call):
    with api.db() as conn:
        return dict(conn.execute("select * from calls where id=?", (call,)).fetchone())


def test_retirement_uses_the_fixed_original_native_request_and_resource_boundary():
    argv = ["--issue-work", "943", "--mode", "retire", "--branch", "poise/issue-943", "--pull-number", "946",
            "--coverage-json", '{"verified":true}', "--expected-head", "a" * 40, "--token-user", "author"]
    request, number, head = native_action.validate(argv, "/isolated/example/repo", "example/repo", "author", resource_version=True)
    assert request == {"command": "github-interface", "cwd": "/isolated/example/repo", "argv": argv, "nativeResources": 2}
    assert number == "943" and head == "a" * 40
    for mode in ("prepare", "publish", "validate"):
        with pytest.raises(ValueError, match="permits only"):
            native_action.validate([*argv[:3], mode, *argv[4:]], request["cwd"], "example/repo", "author", resource_version=True)


def test_response_is_durable_before_terminal_status_and_not_rewritten(database, monkeypatch):
    call, digest = original()
    response = '{"outcome":"enqueued","queueEntryId":"actual-response"}'
    api._native_action_artifact(call, "received_native_action", digest, response)
    receipt = row(call)
    assert receipt["status"] == "running"
    assert Path(receipt["response_path"]).read_text() == response
    assert json.loads(receipt["artifact"])["response_sha"] == hashlib.sha256(response.encode()).hexdigest()
    monkeypatch.setattr(Path, "write_text", lambda *args, **kwargs: pytest.fail("durable response was rewritten"))
    api.finish(call, "completed", response=response)
    assert row(call)["response_path"] == receipt["response_path"]
    api._native_action_artifact(call, "received_native_action", digest, response)
    assert row(call)["artifact"] == receipt["artifact"]


def test_stop_or_later_failure_preserves_received_response_and_original_terminal_state(database):
    call, digest = original()
    api.finish(call, "failed", error="Stopped by user", error_code="stopped")
    api._native_action_artifact(call, "received_native_action", digest, '{"outcome":"enqueued"}')
    stopped = row(call)
    api.finish(call, "completed", response='{"outcome":"enqueued"}')
    assert row(call) == stopped
    assert stopped["status"] == "failed" and stopped["error_code"] == "stopped"
    assert Path(stopped["response_path"]).read_text() == '{"outcome":"enqueued"}'


def test_failure_after_response_keeps_its_pointer(database):
    call, digest = original()
    api._native_action_artifact(call, "received_native_action", digest, '{"outcome":"enqueued"}')
    api.finish(call, "failed", error="interrupted after response")
    assert Path(row(call)["response_path"]).read_text() == '{"outcome":"enqueued"}'


def test_unknown_or_changed_request_cannot_allocate_a_response(database):
    with pytest.raises(RuntimeError, match="original claimed request"):
        api._native_action_artifact("a" * 32, "received_native_action", "b" * 64, "{}")
    assert list(api.RESPONSES.iterdir()) == []
    call, digest = original()
    with pytest.raises(RuntimeError, match="original request"):
        api._native_action_artifact(call, "received_native_action", "c" * 64, "{}")
    assert list(api.RESPONSES.iterdir()) == []
    api._native_action_artifact(call, "received_native_action", digest, "{}")
    before = row(call)
    with pytest.raises(RuntimeError, match="first durable receipt"):
        api._native_action_artifact(call, "received_native_action", digest, '{"different":true}')
    with pytest.raises(RuntimeError, match="original request"):
        api._native_action_artifact(call, "preparing_native_action", digest)
    assert row(call) == before
    assert Path(before["response_path"]).read_text() == "{}"


def test_response_never_follows_a_foreign_symlink(database):
    call, digest = original()
    foreign = database / "protected"
    foreign.write_text("protected")
    (api.RESPONSES / f"{call}.txt").symlink_to(foreign)
    with pytest.raises(OSError):
        api._native_action_artifact(call, "received_native_action", digest, "{}")
    assert foreign.read_text() == "protected"
    assert row(call)["response_path"] is None


def test_response_directory_replacement_cannot_receive_native_evidence(database):
    call, digest = original()
    foreign = database / "foreign-responses"
    foreign.mkdir()
    sentinel = foreign / "user-auth-evidence"
    sentinel.write_text("retained")
    api.RESPONSES.rmdir()
    api.RESPONSES.symlink_to(foreign, target_is_directory=True)
    with pytest.raises(OSError):
        api._native_action_artifact(call, "received_native_action", digest, "{}")
    assert list(foreign.iterdir()) == [sentinel]
    assert sentinel.read_text() == "retained"
    assert row(call)["response_path"] is None


def process(monkeypatch, program):
    # An isolated transport stand-in; it cannot reach GitHub or start a worker.
    popen = subprocess.Popen
    children = []

    def start(argv, **kwargs):
        assert argv[0] == "github-interface"
        child = popen([sys.executable, "-c", program], **kwargs)
        children.append(child)
        return child

    monkeypatch.setattr(native_action.subprocess, "Popen", start)
    return children


def test_complete_response_survives_nonzero_process_exit(tmp_path, monkeypatch):
    children = process(monkeypatch, 'import sys; print(\'{"outcome":"enqueued"}\'); sys.exit(7)')
    assert native_action.execute(["--merge-if-ready", "7"], tmp_path) == ({"outcome": "enqueued"}, 7)
    assert children[0].poll() == 7


@pytest.mark.parametrize("program,limit", [
    ("import time; time.sleep(10)", 0.1),
    ("import sys; sys.stdout.write('x' * 300000); sys.stdout.flush()", 1),
])
def test_transport_failure_is_bounded_and_ends_its_process(tmp_path, monkeypatch, program, limit):
    children = process(monkeypatch, program)
    monkeypatch.setattr(native_action, "TIMEOUT_SECONDS", limit)
    with pytest.raises((native_action.ActionFailure, RuntimeError)):
        native_action.execute(["--merge-if-ready", "7"], tmp_path)
    assert children[0].poll() is not None
    assert children[0].stdout.closed and children[0].stderr.closed


def test_invalid_response_retains_only_explicit_diagnostic(tmp_path, monkeypatch):
    evidence = {"version": 1, "source": "caller", "severity": "error", "operation": "merge",
                "stderr": "redacted cause", "outcome": "exit"}
    program = f"import sys; print('private raw text', file=sys.stderr); print('caller_diagnostic: ' + {json.dumps(json.dumps(evidence))}, file=sys.stderr); sys.exit(1)"
    process(monkeypatch, program)
    with pytest.raises(native_action.ActionFailure) as failure:
        native_action.execute(["--merge-if-ready", "7"], tmp_path)
    assert failure.value.diagnostic["stderr"] == "redacted cause"
    assert "private raw text" not in json.dumps(failure.value.diagnostic)


def test_spawn_rejection_is_explicitly_not_started(tmp_path, monkeypatch):
    def missing(*args, **kwargs):
        raise FileNotFoundError("github-interface missing")

    monkeypatch.setattr(native_action.subprocess, "Popen", missing)
    with pytest.raises(native_action.NotStarted):
        native_action.execute(["--merge-if-ready", "7"], tmp_path)


def test_unmapped_signal_cannot_erase_an_accepted_response():
    assert native_action.process_failure(7) == {"code": 7, "signal": None}
    assert native_action.process_failure(-9) == {"code": None, "signal": "SIGKILL"}
    assert native_action.process_failure(-35) == {"code": None, "signal": "SIG35"}
