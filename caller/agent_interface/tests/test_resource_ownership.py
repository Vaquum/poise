"""Caller/SQLite/filesystem contracts, not provider workflow acceptance."""
import json
import os
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
from contextlib import nullcontext
from pathlib import Path
from unittest import TestCase, skipUnless
from unittest.mock import Mock, patch

import agent_interface as api
from agent_interface import issue_review, resource_ownership as ownership, review_receipt


class ResourceOwnershipCase(TestCase):
    def setUp(self):
        # Managed test boxes report different devices for files and directories
        # on /tmp. Keep these cleanup fixtures on a consistent filesystem.
        self.work = tempfile.TemporaryDirectory(dir="/dev/shm" if sys.platform == "linux" else None)
        self.addCleanup(self.work.cleanup)
        self.root = Path(self.work.name).resolve()
        for target in (patch.object(api, "DB", self.root / "calls.sqlite3"),
                       patch.object(api, "RESPONSES", self.root / "responses"),
                       patch.object(api, "DATA_DIR", self.root),
                       patch.dict(os.environ, {"AGENT_INTERFACE_RECEIPT_DB": "", "AGENT_INTERFACE_RECEIPT_CALL": ""}),
                       patch.object(issue_review, "_cwd_pids", return_value=[])):
            target.start()
            self.addCleanup(target.stop)
        api.init_db()

    def call(self, correlation="resource-contract"):
        return api.track("fixture-model", "original prompt", repo="acme/app", pr_id="7", actor="reviewer",
                         behavior="issue_review", source="poise:behavior-chain", correlation_id=correlation,
                         session_id="original-session")

    def state(self, call):
        with api.db() as conn:
            return ownership.read(conn, call)

    def test_caller_database_context_releases_its_connection_after_commit(self):
        with api.db() as conn:
            conn.execute("select 1").fetchone()
        with self.assertRaises(sqlite3.ProgrammingError):
            conn.execute("select 1")

    def test_registration_precedes_directory_creation(self):
        call = self.call()
        root = self.root / "owned"
        mkdir = Path.mkdir

        def observed(path, *args, **kwargs):
            if path == root:
                self.assertEqual(self.state(call)["roots"], [{"path": str(root), "state": "registered"}])
                self.assertFalse(root.exists())
            return mkdir(path, *args, **kwargs)

        with patch.object(Path, "mkdir", new=observed):
            ownership.allocate(api.DB, call, root)
        entry = self.state(call)["roots"][0]
        self.assertEqual((entry["state"], entry["device"], entry["inode"]),
                         ("allocated", str(root.stat().st_dev), str(root.stat().st_ino)))

    def test_phase_writes_and_initialization_cannot_replace_resource_identity_or_failure(self):
        call = self.call()
        root = ownership.allocate(api.DB, call, self.root / "owned")
        ownership.failure(api.DB, call, "resources_unknown", root)
        before = self.state(call)
        with review_receipt.invocation_environment(api.DB, call, True):
            with api.db() as conn:
                conn.execute("update calls set artifact=? where id=?",
                             (json.dumps({"phase": "posting_issue_reviews", "plan_sha": "a" * 64}), call))
        self.assertEqual(self.state(call), before)
        self.assertFalse(ownership.released(self.state(call)))

    def test_recovery_attempts_append_all_temporary_roots_and_retain_a_failed_first_cleanup(self):
        call = self.call()
        with review_receipt.invocation_environment(api.DB, call, True):
            with patch.object(ownership, "_remove_directory", side_effect=PermissionError("retained first attempt")):
                with self.assertRaisesRegex(RuntimeError, "cleanup is unverified"):
                    with ownership.temporary_directory("caller-pr-review-") as first:
                        (Path(first) / "build-output").write_text("retained")
            for prefix in ("agent-interface-review-", "agent-interface-review-watch-", "caller-pr-review-",
                           "agent-interface-review-", "agent-interface-review-watch-"):
                with ownership.temporary_directory(prefix) as directory:
                    (Path(directory) / "receipt").write_text("local filesystem contract")
        before = self.state(call)
        self.assertEqual(len(before["roots"]), 7)  # One Call parent plus six attempt roots.
        self.assertTrue((Path(first) / "build-output").is_file())
        self.assertFalse(ownership.released(before))
        ownership.cleanup_remaining(api.DB, call)
        after = self.state(call)
        self.assertEqual(len(after["roots"]), 7)
        self.assertEqual(after["errors"], before["errors"])
        first_receipt = next(entry for entry in after["roots"] if entry["path"] == first)
        self.assertGreaterEqual(first_receipt["recovered_at"], before["errors"][0]["at"])
        self.assertTrue(ownership.released(after))

    def run_finalizer(self, execute, correlation="resource-contract"):
        argv = ["agent-interface", "--issue-review", "acme/app#7", "--source", "poise:behavior-chain",
                "--correlation-id", correlation]
        def legacy_receipt():
            # These retain the version-1 historical/library receipt contract.
            # Physical namespace delivery has separate native Call tests.
            with patch.object(api, "_native_cli", False):
                execute()

        with patch.object(sys, "argv", argv), patch.object(api, "_main", side_effect=legacy_receipt):
            api.main()

    def test_normal_deletion_failure_and_all_four_log_reads_keep_original_publication_and_ownership(self):
        kept = {}

        def execute():
            call = self.call()
            root = ownership.allocate(api.DB, call, self.root / "owned")
            (root / "retained-output").write_text("must not disappear")
            api.finish(call, "completed", outcome="commented", action="commented")
            with api.db() as conn:
                conn.execute("update calls set artifact=?,action_plan=?,receipts=? where id=?",
                             ('{"phase":"posting_issue_reviews"}', '{"posts":["original plan"]}',
                              '[{"comment_id":91}]', call))
            kept.update(call=call, root=root)

        with patch.object(ownership, "_remove_directory", side_effect=PermissionError("deletion denied")):
            self.run_finalizer(execute)
        readers = (lambda: api.logs(), lambda: api.logs_selected({"latest": [], "ids": [kept["call"]]}),
                   lambda: api.logs_session_since("0", "original-session", "issue_review", "original prompt"),
                   lambda: api.logs_page(10)["rows"])
        for reader in readers:
            with self.subTest(reader=reader):
                rows = reader()
                row = next(row for row in rows if row["id"] == kept["call"])
                self.assertIsNone(row["resources_settled_at"])
                self.assertEqual(row["receipts"], [{"comment_id": 91}])
                self.assertTrue(row["resource_ownership"]["errors"])
                self.assertTrue((kept["root"] / "retained-output").is_file())
                with api.db() as conn:
                    self.assertEqual(conn.execute("select action_plan from calls where id=?", (kept["call"],)).fetchone()[0],
                                     '{"posts":["original plan"]}')

    def test_normal_positive_cleanup_settles_once_without_overwriting_its_first_timestamp(self):
        kept = {}

        def execute():
            kept["call"] = self.call()
            root = ownership.allocate(api.DB, kept["call"], self.root / "owned")
            (root / "output").write_text("disposable")
            api.finish(kept["call"], "completed", outcome="commented", action="commented")

        self.run_finalizer(execute)
        with api.db() as conn:
            first = conn.execute("select resources_settled_at from calls where id=?", (kept["call"],)).fetchone()[0]
        self.assertIsNotNone(first)
        self.assertFalse((self.root / "owned").exists())
        self.run_finalizer(lambda: None)
        with api.db() as conn:
            self.assertEqual(conn.execute("select resources_settled_at from calls where id=?", (kept["call"],)).fetchone()[0], first)

    def test_a_replaced_symlink_or_missing_pinned_root_never_authorizes_cleanup(self):
        for replacement in ("symlink", "absent"):
            with self.subTest(replacement=replacement):
                call = self.call(replacement)
                root = ownership.allocate(api.DB, call, self.root / replacement)
                root.rename(self.root / (replacement + "-retained"))
                foreign = self.root / (replacement + "-foreign")
                foreign.mkdir()
                sentinel = foreign / "user-data"
                sentinel.write_text("protected")
                if replacement == "symlink":
                    root.symlink_to(foreign, target_is_directory=True)
                self.assertFalse(ownership.cleanup(api.DB, call, root))
                self.assertEqual(sentinel.read_text(), "protected")
                self.assertFalse(ownership.released(self.state(call)))

    def test_cleanup_refuses_a_differing_child_device_without_releasing_ownership(self):
        call = self.call()
        root = ownership.allocate(api.DB, call, self.root / "owned")
        sentinel = root / "foreign-data"
        sentinel.write_text("protected")
        before = self.state(call)
        info = list(sentinel.stat())
        info[2] = root.stat().st_dev + 1  # st_dev
        child = Mock()
        child.name = sentinel.name
        child.stat.return_value = os.stat_result(info)
        with patch.object(ownership.os, "scandir") as scan:
            scan.return_value.__enter__.return_value = [child]
            self.assertFalse(ownership.cleanup(api.DB, call, root))
        after = self.state(call)
        self.assertEqual(sentinel.read_text(), "protected")
        self.assertEqual(after["roots"], before["roots"])
        self.assertEqual(after["errors"][0]["cause"], "native resource cleanup crosses a filesystem boundary")
        self.assertFalse(ownership.released(after))

    def test_a_failed_positive_receipt_write_is_not_replaced_by_a_release_from_path_absence(self):
        call = self.call()
        root = ownership.allocate(api.DB, call, self.root / "owned")
        with patch.object(ownership, "_write", side_effect=sqlite3.OperationalError("receipt write locked")), \
                self.assertRaises(sqlite3.OperationalError):
            ownership.cleanup(api.DB, call, root)
        self.assertFalse(root.exists())
        self.assertEqual(self.state(call)["roots"][0]["state"], "allocated")
        self.assertFalse(ownership.cleanup(api.DB, call, root))
        self.assertFalse(ownership.released(self.state(call)))

    def test_normal_native_serializer_decoder_and_journal_share_the_same_resource_boundary(self):
        repo = Path(__file__).resolve().parents[3]
        if not (repo / "tests/fixtures/behavior-fence-contract.ts").is_file():
            self.skipTest("requires the repository's existing Node contract harness")
        output = repo / "test-results"
        output.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="native-resource-contract-", dir=output) as work:
            root = Path(work)
            env = {"PATH": os.environ["PATH"], "HOME": str(self.root), "TMPDIR": work}
            build = subprocess.run([str(repo / "node_modules/esbuild/bin/esbuild"),
                                    str(repo / "tests/fixtures/behavior-fence-contract.ts"), "--bundle", "--platform=node",
                                    "--packages=external", "--format=esm", "--target=node22", f"--outfile={root / 'contract.mjs'}"],
                                   cwd=repo, env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(build.returncode, 0, build.stderr)
            for mode in ("pending", "released", "recovered"):
                with self.subTest(mode=mode):
                    def execute():
                        call = self.call(mode)
                        directory = ownership.allocate(api.DB, call, self.root / mode)
                        (directory / "output").write_text("isolated filesystem contract")
                        if mode == "recovered":
                            with patch.object(ownership, "_remove_directory", side_effect=PermissionError("first deletion denied")):
                                self.assertFalse(ownership.cleanup(api.DB, call, directory))
                        api.finish(call, "completed", outcome="commented", action="commented")
                        with api.db() as conn:
                            conn.execute("update calls set receipts=? where id=?", (json.dumps([
                                {"issue": "acme/app#7", "comment_id": 91, "author": "reviewer", "url": None}]), call))

                    failure = patch.object(ownership, "_remove_directory", side_effect=PermissionError("deletion denied")) \
                        if mode == "pending" else nullcontext()
                    with failure:
                        self.run_finalizer(execute, mode)
                    cli_env = {"PATH": "", "HOME": str(self.root), "AGENT_INTERFACE_DATA_DIR": str(self.root),
                               "PYTHONPATH": str(Path(__file__).resolve().parents[1]), "PYTHONDONTWRITEBYTECODE": "1"}
                    selected = subprocess.run([sys.executable, "-c", "from agent_interface import main; main()", "--logs", "--select",
                                               json.dumps({"latest": [], "ids": [], "correlations": [mode]})],
                                              cwd=self.root, env=cli_env, capture_output=True, text=True, timeout=30)
                    self.assertEqual(selected.returncode, 0, selected.stderr)
                    wire = root / f"{mode}.json"
                    wire.write_text(selected.stdout)
                    result = subprocess.run(["node", str(root / "contract.mjs"), str(wire), mode],
                                            cwd=repo, env=env, capture_output=True, text=True, timeout=30)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(json.loads(result.stdout), {"accepted": 1, "settled": 0 if mode == "pending" else 1,
                                                               "reservations": 1 if mode == "pending" else 0})

    @skipUnless(sys.platform == "linux", "kernel identity and deleted-directory process evidence require Linux")
    def test_dead_supervisor_and_deleted_provider_directory_never_release_a_live_orphan(self):
        # This is an OS fault fixture, with no provider or GitHub operation.
        child = '''import json, os, subprocess, sys
from pathlib import Path
import agent_interface as api
from agent_interface import resource_ownership as ownership, process_identity
call = api.track("fixture-model", "parent-loss contract", repo="acme/app", pr_id="7", actor="reviewer",
                 behavior="pr_review", expected_head="a" * 40, source="poise:behavior-chain", correlation_id="orphan")
parent = ownership.allocate(api.DB, call, api.DATA_DIR / "orphan-call")
provider_root = ownership.allocate(api.DB, call, parent / "provider")
ownership.allocate(api.DB, call, parent / "watch")
provider = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], cwd=provider_root,
                            start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
print(json.dumps({"call": call, "pid": provider.pid, "identity": process_identity.capture(provider.pid),
                  "root": str(provider_root)}), flush=True)
os._exit(0)
'''
        env = {"PATH": "", "HOME": str(self.root), "AGENT_INTERFACE_DATA_DIR": str(self.root),
               "PYTHONPATH": str(Path(__file__).resolve().parents[1]), "PYTHONDONTWRITEBYTECODE": "1"}
        result = subprocess.run([sys.executable, "-c", child], cwd=self.root, env=env,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        original = json.loads(result.stdout)

        def stop_owned_fixture():
            with api.process_identity.pinned(original["identity"], original["pid"]) as process:
                if process is not None:
                    process.signal(signal.SIGKILL)
                    self.assertTrue(process.wait(5))

        self.addCleanup(stop_owned_fixture)
        foreign = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", "agent-interface", "--logs"],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(foreign.wait)
        self.addCleanup(lambda: foreign.poll() is None and foreign.kill())
        with patch.object(issue_review, "_cwd_pids", side_effect=AssertionError("log reads must not scan or signal by paths")):
            entry = api.logs_selected({"latest": [], "ids": [original["call"]]})[0]
            self.assertEqual(entry["status"], "failed")
            self.assertIsNone(entry["resources_settled_at"])
            os.kill(original["pid"], 0)
            shutil.rmtree(original["root"])
            self.assertTrue(os.readlink(f"/proc/{original['pid']}/cwd").endswith(" (deleted)"))
            self.assertIsNone(api.logs_selected({"latest": [], "ids": [original["call"]]})[0]["resources_settled_at"])
            self.assertIsNone(foreign.poll())
            stop_owned_fixture()
            self.assertIsNone(api.logs_selected({"latest": [], "ids": [original["call"]]})[0]["resources_settled_at"],
                              "same-epoch parent/provider exit is still not a positive cleanup receipt")

    @skipUnless(sys.platform == "linux", "isolated native PID-reuse finalizer contract")
    def test_a_fresh_failed_launch_cannot_finalize_a_call_whose_numeric_pid_was_reused(self):
        call = self.call()
        directory = ownership.allocate(api.DB, call, self.root / "retained-original")
        sentinel = directory / "original-output"
        sentinel.write_text("not owned by the later CLI")
        api.finish(call, "completed", outcome="commented", action="commented")
        child = '''import json, os, sys
import agent_interface as api
with api.db() as conn:
    conn.execute("update calls set pid=? where id=?", (str(os.getpid()), sys.argv[1]))
sys.argv = ["agent-interface", "--issue-review", "acme/app#7", "--actor", "reviewer", "--model", "fixture-model",
            "--source", "poise:behavior-chain", "--correlation-id", "resource-contract"]
api.main()
'''
        env = {"PATH": "", "HOME": str(self.root), "AGENT_INTERFACE_DATA_DIR": str(self.root),
               "PYTHONPATH": str(Path(__file__).resolve().parents[1]), "PYTHONDONTWRITEBYTECODE": "1"}
        result = subprocess.run([sys.executable, "-c", child, call], cwd=self.root, env=env,
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("fixture-model", result.stderr)
        self.assertTrue(sentinel.is_file(), "a numeric PID match grants no original finalizer ownership")
        self.assertIsNone(api.logs_selected({"latest": [], "ids": [call]})[0]["resources_settled_at"])
