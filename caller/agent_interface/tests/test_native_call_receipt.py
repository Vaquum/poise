"""Real SQLite receipt transitions; not provider/workflow acceptance."""
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

import pytest

import agent_interface as api
from agent_interface import issue_review, native_namespace, resource_ownership as ownership, review_receipt
from agent_interface.model_catalog import CATALOG


@pytest.fixture
def database(tmp_path, monkeypatch):
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
