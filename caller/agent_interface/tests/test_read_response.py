import json
import shutil

import pytest

import agent_interface as api


@pytest.fixture(autouse=True)
def response_store(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "DATA_DIR", tmp_path)
    monkeypatch.setattr(api, "DB", tmp_path / "calls.sqlite3")
    monkeypatch.setattr(api, "RESPONSES", tmp_path / "responses")
    api.init_db()


@pytest.mark.parametrize("status", [None, "running", "completed", "failed"])
def test_ordinary_absence_is_typed_and_never_a_successful_body(status, capsys):
    call_id = "0" * 32 if status is None else api.track("fixture", "prompt")
    if status not in {None, "running"}:
        api.finish(call_id, status, error="provider failed" if status == "failed" else "")
    with pytest.raises(SystemExit) as failure:
        api.read_response(call_id)
    assert failure.value.code == 3
    captured = capsys.readouterr()
    result = json.loads(captured.out)
    assert result == {"id": call_id, "disposition": "unavailable", "reason": (
        "The Call is unknown" if status is None else
        "The Call is still running" if status == "running" else "The Call ended without a response")}
    assert captured.err == ""


@pytest.mark.parametrize("body", ["retained response\n", '{"duration":1.0,"outcome":"enqueued"}'])
def test_success_preserves_the_original_response_and_cli_newline(body, capsys):
    call_id = api.track("fixture", "prompt")
    api.finish(call_id, "completed", response=body)
    api.read_response(call_id)
    assert capsys.readouterr().out == body + "\n"


@pytest.mark.parametrize("damage", ["missing", "invalid_utf8"])
def test_a_promised_response_file_remains_an_error(damage, capsys):
    call_id = api.track("fixture", "prompt")
    api.finish(call_id, "completed", response="promised")
    path = api.RESPONSES / f"{call_id}.txt"
    if damage == "missing":
        path.unlink()
    else:
        path.write_bytes(b"\xff")
    with pytest.raises(SystemExit, match=f"Response read failed for Call {call_id}") as failure:
        api.read_response(call_id)
    assert failure.value.code != 3
    assert capsys.readouterr().out == ""


def test_a_cleared_path_after_response_persistence_failure_remains_an_error(capsys):
    call_id = api.track("fixture", "prompt")
    shutil.rmtree(api.RESPONSES)
    api.finish(call_id, "completed", response="promised")
    with api.db() as conn:
        row = conn.execute("select response_path,diagnostic from calls where id=?", (call_id,)).fetchone()
    assert row["response_path"] is None
    assert json.loads(row["diagnostic"])["outcome"] == "persist_failed"
    with pytest.raises(SystemExit, match=f"Call {call_id}: response persistence failed"):
        api.read_response(call_id)
    assert capsys.readouterr().out == ""


def test_a_persistence_failure_with_an_earlier_diagnostic_remains_an_error(capsys):
    call_id = api.track("fixture", "prompt")
    shutil.rmtree(api.RESPONSES)
    api.finish(call_id, "completed", response="promised",
               diagnostic={"operation": "provider.review", "phase": "submitting", "outcome": "exit"})
    with api.db() as conn:
        row = conn.execute("select response_path,diagnostic from calls where id=?", (call_id,)).fetchone()
    assert row["response_path"] is None
    stored = json.loads(row["diagnostic"])
    assert (stored["phase"], stored["outcome"]) == ("response_persist", "persist_failed")
    assert stored["prior"]["phase"] == "submitting"
    with pytest.raises(SystemExit, match=f"Call {call_id}: response persistence failed") as failure:
        api.read_response(call_id)
    assert failure.value.code != 3
    assert capsys.readouterr().out == ""


def test_a_fenced_superseded_call_without_a_response_is_ordinary_absence(capsys):
    fenced = api.fence_closed_behavior(model="original-model", actor="author", repository="example/repo",
                                       number=17, behavior="repair_pr", correlation_id="test-fence",
                                       expected_head="a" * 40)
    with pytest.raises(SystemExit) as failure:
        api.read_response(fenced["id"])
    assert failure.value.code == 3
    captured = capsys.readouterr()
    assert json.loads(captured.out) == {"id": fenced["id"], "disposition": "unavailable",
                                        "reason": "The Call ended without a response"}
    assert captured.err == ""


@pytest.mark.parametrize("evidence", [
    {"behavior": "native_action"},
    {"artifact": json.dumps({"response_sha": "a" * 64})},
    {"diagnostic": "{"},
])
def test_missing_required_or_corrupt_evidence_is_not_ordinary_absence(evidence, capsys):
    call_id = api.track("fixture", "prompt")
    api.finish(call_id, "completed")
    with api.db() as conn:
        for key, value in evidence.items():
            conn.execute(f"update calls set {key}=? where id=?", (value, call_id))
    with pytest.raises(SystemExit, match=f"Response read failed for Call {call_id}") as failure:
        api.read_response(call_id)
    assert failure.value.code != 3
    assert capsys.readouterr().out == ""


def test_prefix_matching_does_not_hide_response_less_calls():
    with api.db() as conn:
        conn.executemany("insert into calls(id,status,response_path) values(?,?,?)", [
            ("a" * 32, "completed", "/missing/response.txt"), ("a" * 31 + "b", "completed", None),
        ])
    with pytest.raises(SystemExit, match="Call ID matched 2 rows"):
        api.read_response("a")
