"""Real provider/gate/lease regression with a namespace-reader stand-in, plus typed provider-result settlement."""
import json
import os
import signal
import sqlite3
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from agent_interface import atomic_work, native_namespace, resource_ownership


@pytest.mark.skipif(sys.platform != "linux", reason="uses Linux process state")
@pytest.mark.parametrize("provider_exit,terminate_helpers", [(0, True), (1, True), (0, False)])
def test_atomic_publication_waits_for_detached_stopped_helper(tmp_path, monkeypatch, provider_exit, terminate_helpers):
    scope = native_namespace.Namespace.__new__(native_namespace.Namespace)
    scope.key = {"callId": "a" * 32}
    scope.binding = {"owner": {"pid": os.getpid(), "start": "1"}, "pid": os.getpid()}
    work = tmp_path / "native-resources" / scope.key["callId"]
    work.mkdir(parents=True, mode=0o700)
    node = work.stat()
    helper_file = work / "helper.pid"
    publication = {"commitMessage": "fix: keep completed work", "title": "fix: keep completed work",
                   "body": "Preserve the completed result after helper cleanup.", "replies": [], "blocked": None}
    provider = f"""
import json, os, signal, time
from pathlib import Path
helper = os.fork()
if helper == 0:
    os.setsid()
    os.kill(os.getpid(), signal.SIGSTOP)
    time.sleep(60)
    os._exit(0)
Path('../helper.pid').write_text(str(helper))
assert os.WIFSTOPPED(os.waitpid(helper, os.WUNTRACED)[1])
Path('../publication.json').write_text({json.dumps(json.dumps(publication))})
print(json.dumps({{"type": "turn.completed"}}), flush=True)
raise SystemExit({provider_exit})
"""

    def read(**kwargs):
        pids = [1, 2]
        if helper_file.exists():
            helper = int(helper_file.read_text())
            if Path(f"/proc/{helper}").exists():
                pids.append(helper)
        return {"pids": pids}

    kill = os.kill

    def signal_helper(pid, sig):
        if sig == signal.SIGKILL:
            assert pid == int(helper_file.read_text()), "signalled a process outside the owned helper fixture"
            if not terminate_helpers:
                return
        kill(pid, sig)

    # Namespace/disk receipts and GitHub are explicit stand-ins. The provider
    # exits after its separate-session helper stops; it is not a mocked result.
    monkeypatch.setattr(native_namespace, "active", lambda: scope)
    monkeypatch.setattr(os, "getpid", lambda: 2)
    monkeypatch.setattr(os, "kill", signal_helper)
    monkeypatch.setattr(scope, "read", read)
    monkeypatch.setattr(scope, "resource", lambda *args: {
        "path": str(work), "state": "allocated", "unlinked": False,
        "device": str(node.st_dev), "inode": str(node.st_ino)})
    monkeypatch.setattr(resource_ownership, "binding", lambda: (tmp_path / "calls.sqlite3", scope.key["callId"]))
    monkeypatch.setattr(resource_ownership, "process_check", lambda *args, **kwargs: None)
    monkeypatch.setattr(atomic_work.issue_review, "_cwd_pids", lambda *args, **kwargs: [])
    monkeypatch.setattr(atomic_work.issue_review, "packet", lambda *args: {"issue": {"state": "open"}})
    monkeypatch.setattr(atomic_work.issue_review, "command", lambda *args: ([sys.executable, "-c", provider], "", None))
    if not terminate_helpers:
        monkeypatch.setattr(native_namespace, "SETTLE_SECONDS", 0.1)
    modes = []

    def interface(*args, **kwargs):
        mode = args[args.index("--mode") + 1]
        modes.append(mode)
        if mode == "prepare":
            (work / "repo").mkdir()
            return {"outcome": "prepared", "checkout_head": "b" * 40}
        assert read()["pids"] == [1, 2], "publication preceded helper removal"
        assert args[args.index("--message") + 1] == publication["commitMessage"]
        assert args[args.index("--body") + 1] == publication["body"]
        return {"outcome": "validated" if mode == "validate" else "published"}

    monkeypatch.setattr(atomic_work.issue_review, "interface", interface)
    try:
        run = lambda: atomic_work.run(SimpleNamespace(provider="codex"), "example/repo", 7, "fix/settlement",
                                      "author", work, scope.key["callId"], lambda receipt: None)
        if not terminate_helpers:
            with pytest.raises(atomic_work.checkout_lock.WorkerOrphaned) as failure:
                run()
            helper = int(helper_file.read_text())
            assert f"pid={helper}" in str(failure.value)
            name = Path(f"/proc/{helper}/comm").read_text().strip()
            assert f"name={name!r}" in str(failure.value)
            assert "state=T" in str(failure.value)
            with sqlite3.connect(work / "checkout-lease.sqlite3") as connection:
                assert connection.execute("select native_call from lease").fetchall() == [(scope.key["callId"],)]
            assert modes == ["prepare"]
        elif provider_exit:
            with pytest.raises(RuntimeError, match="provider exited 1"):
                run()
            assert modes == ["prepare"]
        else:
            assert run() == {"outcome": "published"}
            assert modes == ["prepare", "validate", "publish"]
    finally:
        if helper_file.exists():
            try:
                kill(int(helper_file.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass


CANARY = "canary-secret-9f2c7d4e1a"
TAIL_MARKER = "TAIL-MARKER-7f3a9c"
REUSE_CORE = "Your refresh token could not be refreshed because it was already used."
# The canary sits inside the retained cause to prove redaction; the tail
# marker sits past truncation to prove the raw stream does not leak.
REUSE_MESSAGE = f"{REUSE_CORE} Refresh failed with Bearer {CANARY}; " + "padding " * 80 + TAIL_MARKER
GENERIC_MESSAGE = "refresh token request failed: connection reset by peer"
GITHUB_MESSAGE = "GitHub 401 Unauthorized"
SETTLEMENT_HEAD = "b" * 40


def _codex_stdout(message):
    return json.dumps({"type": "turn.failed", "error": {"message": message}}) + "\n"


@pytest.mark.parametrize("pull", [None, 3], ids=["implement", "repair"])
@pytest.mark.parametrize("returncode,message,provider,typed", [
    (1, REUSE_MESSAGE, "codex", True),
    (0, REUSE_MESSAGE, "codex", True),
    (-9, REUSE_MESSAGE, "codex", True),
    (1, GENERIC_MESSAGE, "codex", False),
    (1, GITHUB_MESSAGE, "codex", False),
    (1, REUSE_MESSAGE, "muse", False),
])
def test_atomic_codex_rejection_is_typed(tmp_path, monkeypatch, capsys, pull, returncode, message, provider, typed):
    call_id = "c" * 32
    work = tmp_path / "atomic-rejection"
    work.mkdir(mode=0o700)
    # A decoy publication the failure must never read: the rejection raises
    # before publication.json is touched.
    (work / "publication.json").write_text(json.dumps({
        "commitMessage": "fix: decoy", "title": "fix: decoy", "body": "must not publish",
        "replies": [], "blocked": None}))
    records, modes, stop_calls, cwd_calls, checks = [], [], [], [], []
    lease = MagicMock()
    lease.held = True

    def interface(*args, **kwargs):
        if args[0] == "--issue-work":
            mode = args[args.index("--mode") + 1]
            modes.append(mode)
            (work / "repo").mkdir(exist_ok=True)
            return {"outcome": "prepared", "checkout_head": SETTLEMENT_HEAD}
        if args[0] == "--list-failing-ci":
            return {"failing": []}
        if args[0] == "--pr-review":
            return {"review_threads": []}
        if args[0] == "--pull-action-state":
            return {}
        raise AssertionError(f"unexpected interface call: {args[0]}")

    def run_gated(_lease, _args, **kwargs):
        return SimpleNamespace(returncode=returncode, stdout=_codex_stdout(message), stderr="")

    # The provider result is faked; classification, redaction, the diagnostic
    # envelope and the release calls it runs after are all real.
    monkeypatch.setattr(atomic_work.issue_review, "packet", lambda *args: {"issue": {"state": "open"}})
    monkeypatch.setattr(atomic_work.issue_review, "command", lambda *args: (["fixture"], "", {}))
    monkeypatch.setattr(atomic_work.issue_review, "interface", interface)
    monkeypatch.setattr(atomic_work.issue_review, "stop_leftovers", lambda root: stop_calls.append(root))
    monkeypatch.setattr(atomic_work.issue_review, "_cwd_pids",
                        lambda *args, **kwargs: cwd_calls.append((args, kwargs)) or [])
    monkeypatch.setattr(atomic_work.checkout_lock, "run_gated", run_gated)
    monkeypatch.setattr(atomic_work.checkout_lock, "Lease", lambda *args, **kwargs: lease)
    monkeypatch.setattr(resource_ownership, "binding", lambda: ("db", call_id))
    monkeypatch.setattr(resource_ownership, "process_check", lambda *args, **kwargs: checks.append((args, kwargs)))

    kwargs = {} if pull is None else {"pull": pull, "expected_head": SETTLEMENT_HEAD}
    with pytest.raises(Exception) as failure:
        atomic_work.run(SimpleNamespace(provider=provider), "example/repo", 7, "fix/rejection",
                        "author", work, call_id, records.append, **kwargs)
    error = failure.value
    # Process release ran before the raise; publication never started.
    assert stop_calls == [work]
    assert cwd_calls == [((work,), {"require_complete": True})]
    assert checks == [(("db", call_id), {"complete": True})]
    lease.acquire.assert_called_once_with(atomic_work.checkout_lock.ACQUIRE_WAIT_SECONDS)
    lease.release.assert_called_once_with()
    assert modes == ["prepare"]
    assert [record["phase"] for record in records] == ["prepared", "executing", "resources_unknown", "executing"]
    captured = capsys.readouterr()
    if typed:
        assert isinstance(error, atomic_work.issue_review.ProviderFailure)
        assert error.code == "authentication_failed"
        assert "already used" in str(error)
        assert CANARY not in str(error)
        assert TAIL_MARKER not in str(error)
        diagnostic = error.diagnostic
        assert diagnostic["operation"] == "provider.atomic_work"
        assert diagnostic["phase"] == "provider_execution"
        assert diagnostic["outcome"] == ("signal" if returncode < 0 else "exit")
        assert diagnostic["stderr"] == str(error)
        assert diagnostic["provider"] == "codex"
        assert diagnostic["exit_code"] == (returncode if returncode > 0 else None)
        assert diagnostic["signal"] == (-returncode if returncode < 0 else None)
        assert diagnostic["submission"] == "none"
        assert CANARY not in json.dumps(diagnostic)
        assert TAIL_MARKER not in json.dumps(diagnostic)
    else:
        # Generic crashes, GitHub failures and other providers keep the
        # existing untyped failure; the outer diagnostic still redacts them.
        assert type(error) is RuntimeError
        assert getattr(error, "code", None) is None
        assert getattr(error, "diagnostic", None) is None
        assert message[:50] in str(error)
    assert CANARY not in captured.out + captured.err
    assert TAIL_MARKER not in captured.out + captured.err
