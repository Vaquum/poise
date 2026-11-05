"""Real provider/gate/lease regression with a namespace-reader stand-in."""
import json
import os
import signal
import sqlite3
import sys
from pathlib import Path
from types import SimpleNamespace

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
