"""Fixed-command transport/SQLite tests, not native workflow acceptance."""
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

import pytest

import agent_interface as api
from agent_interface import native_action, native_namespace, resource_ownership, review_receipt


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


def test_resolution_checkpoint_actor_binding_is_case_insensitive(database):
    head = "a" * 40
    argv = ["--resolve-nonblocking-conversations-if-ready", "21", "--expected-head", head,
            "--username", "Reviewer", "--token-user", "reviewer"]
    request, number, _ = native_action.validate(argv, "/example/repo", "example/repo", "Reviewer", resource_version=True)
    call = api.track("native-action", "resolution", number, "example/repo", "Reviewer", "native_action",
                     expected_head=head, source="poise:behavior-chain", correlation_id="original-resolution")
    digest = hashlib.sha256(json.dumps(request, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    api.persist_action_plan(call, {"kind": "native_action", "request": request})
    api._native_action_artifact(call, "preparing_native_action", digest)
    api._native_action_artifact(call, "performing_native_action", digest)
    with review_receipt.invocation_environment(api.DB, call, True, initialize=False):
        assert native_action.resolution_checkpoint("example/repo", 21, head, "reviewer") == {"confirmed": [], "pending": None}
        assert native_action.resolution_checkpoint("example/repo", 21, head, "REVIEWER") == {"confirmed": [], "pending": None}
        with pytest.raises(RuntimeError, match="original"):
            native_action.resolution_checkpoint("example/repo", 21, head, "someone-else", "A")
    assert json.loads(row(call)["artifact"]).get("resolution_progress", {"confirmed": [], "pending": None}) == {"confirmed": [], "pending": None}


@pytest.mark.parametrize("changed", ["actor", "head", "request_sha"])
def test_resolution_checkpoint_requires_original_actor_head_and_request(database, changed):
    head = "a" * 40
    argv = ["--resolve-nonblocking-conversations-if-ready", "21", "--expected-head", head,
            "--username", "reviewer", "--token-user", "reviewer"]
    request, number, _ = native_action.validate(argv, "/example/repo", "example/repo", "reviewer", resource_version=True)
    call = api.track("native-action", "resolution", number, "example/repo", "reviewer", "native_action",
                     expected_head=head, source="poise:behavior-chain", correlation_id="original-resolution")
    digest = hashlib.sha256(json.dumps(request, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    api.persist_action_plan(call, {"kind": "native_action", "request": request})
    api._native_action_artifact(call, "preparing_native_action", digest)
    api._native_action_artifact(call, "performing_native_action", digest)
    if changed == "request_sha":
        with api.db() as conn:
            conn.execute("update calls set artifact=json_set(artifact,'$.request_sha',?) where id=?", ("b" * 64, call))
    before = row(call)
    with review_receipt.invocation_environment(api.DB, call, True, initialize=False):
        with pytest.raises(RuntimeError, match="original"):
            native_action.resolution_checkpoint("example/repo", 21, "b" * 40 if changed == "head" else head,
                                                "someone-else" if changed == "actor" else "reviewer", "A")
    assert row(call) == before


@pytest.mark.parametrize("mode,submission", [
    ("pre_request", "none"), ("rejected", "rejected"), ("lost", "uncertain"),
    ("graphql", "uncertain"), ("unconfirmed", "uncertain"), ("accepted", None),
])
@pytest.mark.skipif(sys.platform != "linux", reason="Native v2 receipt identity requires Linux /proc")
def test_merge_failure_survives_cli_original_call_and_chain(database, monkeypatch, mode, submission):
    repo = Path(__file__).resolve().parents[3]
    monkeypatch.syspath_prepend(str(repo / "caller/github_interface/tests"))
    from test_merge_queue import PULL, READY
    from review_response_fixture import published_review, response

    pull = {**PULL, "user": {"login": "author"}}
    review = response(pull, "example/repo", 21, "reviewer")
    argv = ["--merge-if-ready", "21", "--expected-head", "a" * 40, "--author", "author",
            "--token-user", "reviewer", "--review-response-json", json.dumps(review)]
    writes = database / "mutations"
    script = f"""
import json, sys
from unittest.mock import patch
from pathlib import Path
import httpx
from github_interface import cli, client
from github_interface.behaviors.merge_if_ready import MergeAdmissionError
mode = {mode!r}
pull = {pull!r}
ready = {READY!r}
if mode == 'pre_request':
    ready['id'] = None
secret = 'ephemeral-client-credential'
async def request(self, method, path, headers, retry_transient, follow_redirects, **kwargs):
    if method == 'GET' and path.endswith('/pulls/21'):
        payload = pull
    elif method == 'GET' and path.endswith('/reviews'):
        payload = {[published_review(review)]!r}
    elif path == '/graphql' and kwargs['json']['query'].lstrip().startswith('query'):
        payload = {{'data': {{'repository': {{'pullRequest': ready}}}}}}
    elif path == '/graphql':
        Path({str(writes)!r}).write_text('submitted')
        assert kwargs['json']['variables'] == {{'pull': 'PR_7', 'head': 'a' * 40}}
        if mode == 'lost':
            raise httpx.ReadTimeout('Queue response lost after possible submission')
        if mode == 'rejected':
            return httpx.Response(403, json={{'message': 'Queue admission denied ' + secret + '原因' * 20000 + '\\nAuthorization: Bearer private-header'}},
                                  request=httpx.Request(method, 'https://api.github.com/graphql'))
        if mode == 'graphql':
            payload = {{'errors': [{{'message': 'Internal resolver error', 'path': ['enqueuePullRequest']}}]}}
        elif mode == 'unconfirmed':
            payload = {{'data': {{'enqueuePullRequest': {{'mergeQueueEntry': None}}}}}}
        else:
            payload = {{'data': {{'enqueuePullRequest': {{'mergeQueueEntry': {{'id': 'original-entry', 'pullRequest': {{'headRefOid': 'a' * 40}}}}}}}}}}
    else:
        raise AssertionError((method, path))
    return httpx.Response(200, json=payload, request=httpx.Request(method, 'https://api.github.com' + path))
sys.argv = ['github-interface', *{argv!r}]
with patch.object(client, 'get_token', return_value=secret), patch.object(client.GitHubClient, '_request', request):
    cli.main()
if mode == 'accepted':
    print('caller_diagnostic: ' + json.dumps(MergeAdmissionError(RuntimeError('later refusal'), 'none').diagnostic), file=sys.stderr)
    sys.exit(7)
"""
    with monkeypatch.context() as transport:
        children = process(transport, script)
        scopes = []

        def enter(call, correlation):
            identity = json.loads(row(call)["process_identity"])
            scope = SimpleNamespace(key={"callId": call, "correlation": correlation, "token": "b" * 32},
                address={"version": 1, "instance": "c" * 32, "path": str(database / "test-controller")},
                binding={"pid": os.getpid() + 2, "start": "12", "namespace": "pid:[91]",
                         "owner": {"pid": os.getpid(), "start": identity["start"]},
                         "holder": {"pid": os.getpid() + 1, "start": "11"},
                         "epoch": {key: str(value) for key, value in identity["epoch"].items()}},
                read=lambda: {"empty": all(child.poll() is not None for child in children)}, retire=lambda: None)
            resource_ownership.request_namespace(api.DB, call, scope)
            resource_ownership.register_namespace(api.DB, call, {"controller": scope.address, **scope.key, "binding": scope.binding})
            scopes.append(scope)

        def execute():
            try:
                api.run_native_action(argv, "/isolated-contract", "example/repo", "reviewer", "original-action", resource_version=True)
            finally:
                resource_ownership.settle_namespace(api.DB, scopes[0].key["callId"], scopes[0])

        # Kernel/controller witnesses are stand-ins; scratch belongs to pytest.
        # Caller's actual producers and finalizer still persist the v2 receipt.
        scratch = database / "scratch"
        scratch.mkdir()
        transport.setattr(resource_ownership, "allocate", lambda *_: scratch)
        transport.setattr(native_namespace, "active", lambda: scopes[0] if scopes else None)
        transport.setattr(api, "_enter_native_call", enter)
        transport.setattr(sys, "argv", ["agent-interface", "--native-action", "--source", "poise:behavior-chain"])
        transport.setattr(api, "_main", execute)
        if submission is None:
            api.main()
        else:
            with pytest.raises(native_action.ActionFailure):
                api.main()
    assert children[0].returncode == (7 if submission is None else 1)
    assert writes.exists() == (mode != "pre_request")

    # Read committed evidence in a fresh Caller, then pass its actual bytes to
    # Poise's decoder and reconciler. No provider or GitHub request is real.
    environment = {**os.environ, "AGENT_INTERFACE_DATA_DIR": str(database),
                   "PYTHONPATH": str(repo / "caller/agent_interface")}
    stored = subprocess.run([sys.executable, "-c", "from agent_interface import main; main()", "--logs", "--select",
                             json.dumps({"latest": [], "ids": [], "correlations": ["original-action"]})],
                            cwd=repo, env=environment, capture_output=True, text=True, check=True, timeout=30)
    call = json.loads(stored.stdout)[0]
    assert call["resources_settled_at"]
    assert call["action"] == ("native_action" if submission is None else "not_started" if submission != "uncertain" else None)
    assert "ephemeral-client-credential" not in stored.stdout
    assert "private-header" not in stored.stdout
    if submission is not None:
        assert call["diagnostic"]["submission"] == submission
        assert call["diagnostic"]["call_id"] == call["id"]
        assert len(call["diagnostic"]["stderr"].encode()) <= 16 * 1024 + 3
    if mode == "rejected":
        assert call["diagnostic"]["stderr_truncated"] is True
        assert "Queue admission denied" in call["diagnostic"]["stderr"]

    output = repo / "test-results"
    output.mkdir(exist_ok=True)
    with TemporaryDirectory(prefix="merge-admission-", dir=output) as work:
        bundle = Path(work) / "contract.mjs"
        subprocess.run([str(repo / "node_modules/esbuild/bin/esbuild"), str(repo / "tests/fixtures/native-merge-admission.ts"),
                        "--bundle", "--platform=node", "--packages=external", "--format=esm", "--target=node22",
                        f"--outfile={bundle}"], cwd=repo, env=environment, check=True, capture_output=True, text=True, timeout=30)
        wire = Path(work) / "stored.json"
        wire.write_text(json.dumps({"logs": json.loads(stored.stdout), "submission": submission,
                                   "request": api.read_action_plan(call["id"])["plan"]["request"],
                                   "response": Path(row(call["id"])["response_path"]).read_text() if call["response"] else None}))
        consumed = subprocess.run(["node", str(bundle), str(wire)], cwd=repo, env=environment,
                                  capture_output=True, text=True, timeout=30)
        assert consumed.returncode == 0, consumed.stderr
        summary = json.loads(consumed.stdout)
        assert summary["invocations"][0]["callId"] == call["id"]
        if submission is not None:
            assert summary["invocations"][0]["evidence"]["diagnostic"]["context"]["submission"] == submission


@pytest.mark.parametrize("mode", ["timeout", "complete", "checkpoint_failed", "final_gate_failed"])
@pytest.mark.skipif(sys.platform != "linux", reason="Native v2 receipt identity requires Linux /proc")
def test_resolution_progress_survives_caller_deadline_and_journal_reload(database, monkeypatch, mode):
    repo = Path(__file__).resolve().parents[3]
    argv = ["--resolve-nonblocking-conversations-if-ready", "21", "--expected-head", "a" * 40,
            "--username", "reviewer", "--token-user", "reviewer"]
    mutations = database / "mutations.json"
    monkeypatch.setenv("GITHUB_INTERFACE_AUTOMATED_REVIEWS", "[71]")
    script = f"""
import asyncio, json, sys, time
if {mode!r} == 'complete':
    time.sleep(3)  # CLI startup can exceed the old two-second fixture deadline.
from pathlib import Path
from unittest.mock import patch
import httpx
from github_interface import cli, client
mode = {mode!r}
seen = []
async def request(self, method, path, headers, retry_transient, follow_redirects, **kwargs):
    if method == 'GET' and path.endswith('/pulls/21'):
        payload = {{'state': 'open', 'draft': False, 'mergeable': True, 'head': {{'sha': 'a' * 40}}}}
    elif method == 'GET' and path.endswith('/reviews'):
        state = 'DISMISSED' if mode == 'final_gate_failed' and len(seen) == 2 else 'APPROVED'
        payload = [{{'id': 71, 'state': state, 'user': {{'login': 'reviewer'}}, 'commit_id': 'a' * 40,
                    'submitted_at': '2026-11-09T15:00:00Z'}}]
    elif method == 'GET' and path.endswith('/status'):
        payload = {{'statuses': [{{'state': 'success'}}]}}
    elif path == '/graphql':
        query = kwargs['json']['query']
        if query.lstrip().startswith('mutation'):
            thread = kwargs['json']['variables']['threadId']
            seen.append(thread)
            Path({str(mutations)!r}).write_text(json.dumps(seen))
            if mode == 'timeout' and thread == 'B':
                await asyncio.sleep(60)  # GitHub accepted B; its reply never reaches Caller.
            payload = {{'data': {{'resolveReviewThread': {{'thread': {{'id': thread, 'isResolved': True}}}}}}}}
        elif 'reviewThreads' in query:
            nodes = [{{'id': thread, 'isResolved': thread in seen, 'isOutdated': False,
                      'path': 'file.py', 'line': 1, 'originalLine': 1, 'diffSide': 'RIGHT',
                      'comments': {{'nodes': []}}}} for thread in ['A', 'B']]
            payload = {{'data': {{'repository': {{'pullRequest': {{'reviewThreads': {{
                'pageInfo': {{'hasNextPage': False}}, 'nodes': nodes}}}}}}}}}}
        else:
            payload = {{'data': {{'repository': {{'pullRequest': {{'headRefOid': 'a' * 40,
                'commits': {{'nodes': [{{'commit': {{'statusCheckRollup': {{'state': 'SUCCESS'}}}}}}]}}}}}}}}}}
    else:
        raise AssertionError((method, path))
    return httpx.Response(200, json=payload, request=httpx.Request(method, 'https://api.github.com' + path))
sys.argv = ['github-interface', *{argv!r}]
with patch.object(client, 'get_token', return_value='isolated-credential'), patch.object(client.GitHubClient, '_request', request):
    cli.main()
"""
    if mode == "checkpoint_failed":
        with api.db() as conn:
            conn.execute("create trigger reject_resolution_checkpoint before update of artifact on calls "
                         "when json_array_length(new.artifact,'$.resolution_progress.confirmed')=1 "
                         "begin select raise(abort,'checkpoint unavailable'); end")

    scopes = []
    with monkeypatch.context() as process_transport:
        children = process(process_transport, script)
        if mode == "timeout":
            start = native_action.subprocess.Popen

            def start_after_acceptance(*args, **kwargs):
                child = start(*args, **kwargs)
                try:
                    setup_deadline = time.monotonic() + 30
                    while not mutations.exists() or mutations.read_text() != json.dumps(["A", "B"]):
                        assert child.poll() is None, "resolution fixture exited before accepting B"
                        assert time.monotonic() < setup_deadline, "resolution fixture did not accept B within 30 seconds"
                        time.sleep(0.01)
                except BaseException:
                    try:
                        child.kill()
                        child.wait(timeout=30)
                    finally:
                        child.stdout.close()
                        child.stderr.close()
                    raise
                return child

            # Popen returns only after B is accepted, so the real deadline
            # measures its lost response rather than CLI startup.
            process_transport.setattr(native_action.subprocess, "Popen", start_after_acceptance)
            process_transport.setattr(native_action, "TIMEOUT_SECONDS", 2)

        def enter(call, correlation):
            identity = json.loads(row(call)["process_identity"])
            scope = SimpleNamespace(key={"callId": call, "correlation": correlation, "token": "b" * 32},
                address={"version": 1, "instance": "c" * 32, "path": str(database / "test-controller")},
                binding={"pid": os.getpid() + 2, "start": "12", "namespace": "pid:[91]",
                         "owner": {"pid": os.getpid(), "start": identity["start"]},
                         "holder": {"pid": os.getpid() + 1, "start": "11"},
                         "epoch": {key: str(value) for key, value in identity["epoch"].items()}},
                read=lambda: {"empty": all(child.poll() is not None for child in children)}, retire=lambda: None)
            resource_ownership.request_namespace(api.DB, call, scope)
            resource_ownership.register_namespace(api.DB, call, {"controller": scope.address, **scope.key, "binding": scope.binding})
            scopes.append(scope)

        def execute():
            try:
                api.run_native_action(argv, "/isolated-contract", "example/repo", "reviewer", "original-resolution", resource_version=True)
            finally:
                resource_ownership.settle_namespace(api.DB, scopes[0].key["callId"], scopes[0])

        # Only kernel/controller witnesses are stand-ins. The CLI, timeout kill,
        # SQLite commits, response writer and resource finalizer are Caller's own.
        scratch = database / "scratch"
        scratch.mkdir()
        process_transport.setattr(resource_ownership, "allocate", lambda *_: scratch)
        process_transport.setattr(native_namespace, "active", lambda: scopes[0] if scopes else None)
        process_transport.setattr(api, "_enter_native_call", enter)
        process_transport.setattr(sys, "argv", ["agent-interface", "--native-action", "--source", "poise:behavior-chain"])
        process_transport.setattr(api, "_main", execute)
        if mode == "complete":
            api.main()
        else:
            with pytest.raises(native_action.ActionFailure):
                api.main()
    assert children[0].returncode == (-9 if mode == "timeout" else 0 if mode == "complete" else 1)
    assert json.loads(mutations.read_text()) == (["A"] if mode == "checkpoint_failed" else ["A", "B"])
    call_id = scopes[0].key["callId"]

    environment = {**os.environ, "AGENT_INTERFACE_DATA_DIR": str(database),
                   "PYTHONPATH": str(repo / "caller/agent_interface")}
    stored = subprocess.run([sys.executable, "-c", "from agent_interface import main; main()", "--logs", "--select",
                             json.dumps({"latest": [], "ids": [call_id], "correlations": []})],
                            cwd=repo, env=environment, capture_output=True, text=True, check=True, timeout=30)
    call = json.loads(stored.stdout)[0]
    progress = call["artifact"]["resolution_progress"]
    expected_ids = [] if mode == "checkpoint_failed" else ["A"] if mode == "timeout" else ["A", "B"]
    assert progress == {"confirmed": [{"id": thread, "isResolved": True} for thread in expected_ids],
                        "pending": "A" if mode == "checkpoint_failed" else "B" if mode == "timeout" else None}
    assert call["resources_settled_at"]
    assert bool(call["response"]) == (mode == "complete")
    if mode == "timeout":
        assert call["diagnostic"]["outcome"] == "timed_out"
    request = api.read_action_plan(call_id)["plan"]["request"]
    output = repo / "test-results"
    output.mkdir(exist_ok=True)
    with TemporaryDirectory(prefix="resolution-progress-", dir=output) as work:
        bundle = Path(work) / "contract.mjs"
        subprocess.run([str(repo / "node_modules/esbuild/bin/esbuild"), str(repo / "tests/fixtures/native-resolution-progress.ts"),
                        "--bundle", "--platform=node", "--packages=external", "--format=esm", "--target=node22",
                        f"--outfile={bundle}"], cwd=repo, env=environment, check=True, capture_output=True, text=True, timeout=30)
        wire = Path(work) / "stored.json"
        wire.write_text(json.dumps({"logs": json.loads(stored.stdout), "request": request, "mode": mode,
                                   "response": Path(row(call_id)["response_path"]).read_text() if call["response"] else None}))
        consumed = subprocess.run(["node", str(bundle), str(wire)], cwd=repo, env=environment,
                                  capture_output=True, text=True, timeout=30)
        assert consumed.returncode == 0, consumed.stderr
