"""Original provider/gate/receipt regression; GitHub and the provider are stand-ins."""
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from types import SimpleNamespace

import pytest

import agent_interface as api
from agent_interface import checkout_lock, issue_review, resource_ownership, review_receipt, review_watch

HEAD, NEW_HEAD = "a" * 40, "b" * 40


@pytest.fixture
def database(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "DB", tmp_path / "calls.sqlite3")
    monkeypatch.setattr(api, "DATA_DIR", tmp_path)
    monkeypatch.setattr(api, "RESPONSES", tmp_path / "responses")
    monkeypatch.setattr(api, "_native_cli", False)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("POISE_LOCK_DIR", str(tmp_path / "locks"))
    api.init_db()
    return tmp_path


@pytest.mark.parametrize("evidence", ["analysis", "planning", "unchanged", "missing", "wrong-target", "unsettled"])
def test_original_repair_supersession(database, monkeypatch, evidence):
    pending = []
    cleanup = resource_ownership.cleanup_remaining

    def cleanup_remaining(path, call_id, **kwargs):
        if not pending:
            pending.extend(api.logs_selected({"latest": [], "ids": [call_id], "correlations": []}))
        return cleanup(path, call_id, **kwargs)

    monkeypatch.setattr(resource_ownership, "cleanup_remaining", cleanup_remaining)
    provider_pid = database / "provider.pid"
    released = database / "provider.released"
    finish = database / "provider.finish"
    provider = f"""
import os, signal, time
from pathlib import Path
def stop(*_):
    time.sleep(0.2)
    Path({str(released)!r}).touch()
    raise SystemExit(0)
signal.signal(signal.SIGTERM, stop)
Path({str(provider_pid)!r}).write_text(str(os.getpid()))
deadline = time.monotonic() + 10
while not Path({str(finish)!r}).exists() and time.monotonic() < deadline:
    time.sleep(0.01)
Path({str(released)!r}).touch()
"""
    packet = {"action": "head_sha", "repository": "example/repo", "pull_number": 17, "head_sha": NEW_HEAD, "state": "OPEN"}
    if evidence in {"unchanged", "planning"}:
        packet["head_sha"] = HEAD
    if evidence == "wrong-target":
        packet["pull_number"] = 18
    head_cli = database / "head-cli"
    # An actual bounded CLI read, including malformed evidence. It releases
    # healthy providers only after observation, so this cannot pass by racing
    # their natural completion ahead of the head check.
    head_cli.write_text(f"#!{sys.executable}\nfrom pathlib import Path\n"
                        f"assert Path({str(provider_pid)!r}).exists()\n"
                        + (f"Path({str(finish)!r}).touch()\n" if evidence in {"planning", "unchanged", "missing", "wrong-target"} else "")
                        + f"print({('{' if evidence == 'missing' else json.dumps(packet))!r})\n")
    head_cli.chmod(0o700)
    monkeypatch.setenv("GITHUB_INTERFACE_CLI", str(head_cli))
    monkeypatch.setattr(review_watch, "POLL_SECONDS", 0.1)
    monkeypatch.setattr(checkout_lock, "POLL_SECONDS", 0.05)
    # Keep the real gate/holder shutdown grace: shortening it races the
    # gate's child reaping and can correctly retain a still-live group.
    assert checkout_lock.STOP_GRACE_SECONDS == 5
    monkeypatch.setattr(api, "CATALOG", SimpleNamespace(issue_review_model=lambda _: SimpleNamespace(identity="fixture", provider="codex")))
    monkeypatch.setattr(issue_review, "packet", lambda *args: {"issue": {"state": "open"}})
    monkeypatch.setattr(issue_review, "sweep", lambda: None)

    def command(*args):
        env = {key: value for key, value in os.environ.items() if not key.startswith("AGENT_INTERFACE_RECEIPT_")}
        return [sys.executable, "-c", provider], "", env

    monkeypatch.setattr(issue_review, "command", command)
    modes = []

    def interface(*args, **kwargs):
        if args[0] == "--issue-work":
            mode = args[args.index("--mode") + 1]
            modes.append(mode)
            if evidence == "planning" and mode == "validate":
                assert review_receipt.supersede_repair(HEAD, NEW_HEAD)
                return {"outcome": "validated"}
            assert mode == "prepare", "obsolete repair reached publication"
            root = Path(args[args.index("--path") + 1])
            root.mkdir()
            (root.parent / "publication.json").write_text(json.dumps({
                "commitMessage": "fix: fixture", "title": "fix: fixture", "body": "Fixture candidate", "replies": [],
                "blocked": None if evidence == "planning" else "fixture completed without supersession"}))
            return {"outcome": "prepared", "checkout_head": HEAD}
        if args[0] == "--pr-review":
            return {"review_threads": []}
        return {}

    monkeypatch.setattr(issue_review, "interface", interface)
    if evidence == "unsettled":
        monkeypatch.setattr(checkout_lock, "pgid_alive", lambda _: True)
    monkeypatch.setattr(api, "_main", lambda: api.run_atomic_work("example/repo#7", "author", "poise:behavior-chain", "original", "fixture",
                                                               "poise/issue-7", pull=17, expected_head=HEAD))
    # Exercise main's original-owner settlement too, with provider preparation
    # and the kernel namespace outside this process-group fixture's scope.
    monkeypatch.setattr(sys, "argv", ["agent-interface", "--fixture"])
    run = api.main
    if evidence in {"analysis", "planning", "unsettled"}:
        if evidence == "unsettled":
            with pytest.raises(checkout_lock.WorkerOrphaned, match="lease retained"):
                run()
        else:
            run()
    else:
        with pytest.raises(api.atomic_work.AtomicWorkBlocked, match="fixture completed"):
            run()
    call, = api.logs_selected({"latest": [], "ids": [], "correlations": ["original"]})
    assert modes == (["prepare", "validate"] if evidence == "planning" else ["prepare"])
    assert released.exists(), "original provider did not acknowledge termination"
    assert not Path(f"/proc/{provider_pid.read_text()}").exists() if sys.platform == "linux" else True
    lease_file = checkout_lock.lock_path(str(database / "native-resources" / call["id"] / "repo"))
    with checkout_lock.connect(lease_file) as conn:
        leases = conn.execute("select * from lease").fetchall()
    assert bool(leases) == (evidence == "unsettled")
    if evidence in {"analysis", "planning"}:
        assert (call["status"], call["outcome"], call["action"]) == ("superseded", "superseded", None)
        assert (call["expected_head"], call["head_sha"]) == (HEAD, NEW_HEAD)
        assert call["resources_settled_at"] and not call["error"]
        assert "plan_sha" not in call["artifact"]
        _reconcile_actual_receipt(database, call, pending)
    else:
        assert call["status"] == "failed"
        if evidence == "unsettled":
            assert call["resources_settled_at"] is None


def _reconcile_actual_receipt(directory, call, pending):
    repo = Path(__file__).resolve().parents[3]
    output = repo / "test-results"
    output.mkdir(exist_ok=True)
    bundle = output / "repair-supersession-contract.mjs"
    build = subprocess.run([str(repo / "node_modules/esbuild/bin/esbuild"),
                            str(repo / "tests/fixtures/repair-supersession-contract.ts"), "--bundle", "--platform=node",
                            "--packages=external", "--format=esm", "--target=node22", f"--outfile={bundle}"],
                           cwd=repo, capture_output=True, text=True, timeout=30)
    assert build.returncode == 0, build.stderr
    wire = directory / "receipt.json"
    wire.write_text(json.dumps({"released": [call], "pending": pending}))
    consumed = subprocess.run(["node", str(bundle), str(wire)], cwd=repo, capture_output=True, text=True, timeout=30)
    assert consumed.returncode == 0, consumed.stderr


@pytest.mark.parametrize("winner", ["fence", "publication", "race"])
def test_head_change_serializes_with_publication(database, winner):
    call = api.track("fixture", "", pr_id="17", repo="example/repo", actor="author", behavior="repair_pr",
                     expected_head=HEAD, source="poise:behavior-chain", correlation_id="original")
    digest = api.persist_action_plan(call, {"kind": "atomic_work", "publication": {}})
    with api.db() as conn:
        conn.execute("update calls set artifact=? where id=?", (json.dumps({"phase": "preparing_publication", "plan_sha": digest}), call))
    barrier = Barrier(2)
    with review_receipt.invocation_environment(api.DB, call, True, initialize=False):
        def fence():
            if winner == "race":
                barrier.wait()
            return review_receipt.supersede_repair(HEAD, NEW_HEAD)

        def publish():
            if winner == "race":
                barrier.wait()
            try:
                review_receipt.work_publication("c" * 40)
            except RuntimeError as error:
                assert "fenced" in str(error)
                return False
            return True

        if winner == "race":
            with ThreadPoolExecutor(max_workers=2) as pool:
                fenced, published = pool.submit(fence), pool.submit(publish)
                fenced, published = fenced.result(), published.result()
        elif winner == "fence":
            fenced, published = fence(), publish()
        else:
            published, fenced = publish(), fence()
        assert fenced != published
        if fenced:
            with pytest.raises(review_watch.ReviewSuperseded):
                api.persist_action_plan(call, {"kind": "atomic_work", "publication": {}})
        with api.db() as conn:
            row = conn.execute("select status,outcome,head_sha,artifact from calls where id=?", (call,)).fetchone()
        assert row["status"] == "running", "a fence cannot itself settle original resources"
        assert row["outcome"] == ("superseded" if fenced else None)
        assert row["head_sha"] == (NEW_HEAD if fenced else None)
        assert json.loads(row["artifact"])["phase"] == ("preparing_publication" if fenced else "publishing")
