import io
import json
import os
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
from pathlib import Path
from threading import Event
from unittest import TestCase
from unittest.mock import patch

from github_interface import cli
from github_interface.atoms import local, mirror_cache


FRESH_MS = 300_000


def git(root: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True).stdout.strip()


def age_tree(root: Path) -> None:
    old = time.time() - 86_400
    for current, directories, files in os.walk(root, topdown=False):
        for name in directories + files:
            os.utime(Path(current) / name, (old, old), follow_symlinks=False)
        os.utime(current, (old, old))


class TestMirrorCache(TestCase):
    def setUp(self) -> None:
        work = tempfile.TemporaryDirectory()
        self.addCleanup(work.cleanup)
        self.work = Path(work.name).resolve()
        self.root = self.work / "mirrors"
        self.root.mkdir()

    def mirror(self, name: str = "owner/repo.git") -> Path:
        path = self.root / name
        path.mkdir(parents=True)
        git(path, "init", "--bare", "--quiet", "--initial-branch", "main")
        age_tree(path)
        return path

    def prune(self, dry_run: bool = False) -> dict[str, object]:
        return mirror_cache.prune_mirrors(self.root, 0, time.time_ns() // 1_000_000, FRESH_MS, dry_run)

    def test_removes_only_whole_owner_repo_mirror_and_preserves_owner_and_lock_inode(self) -> None:
        mirror = self.mirror()
        lock = mirror.parent / "repo.lock"
        lock.write_text("retained lock inode\n")
        inode = lock.stat().st_ino
        sibling = mirror.parent / "another.lock"
        sibling.write_text("another checkout\n")
        report = self.prune()
        self.assertEqual([item["path"] for item in report["removed"]], [str(mirror)])
        self.assertFalse(mirror.exists())
        self.assertTrue(mirror.parent.is_dir())
        self.assertEqual(lock.stat().st_ino, inode)
        self.assertEqual(lock.read_text(), "retained lock inode\n")
        self.assertEqual(sibling.read_text(), "another checkout\n")

    def test_dry_run_classifies_like_eviction_without_removing_mirrors(self) -> None:
        mirror = self.mirror()
        dry = self.prune(True)
        self.assertTrue((mirror / "HEAD").exists())
        real = self.prune()
        self.assertEqual(dry, real)
        self.assertFalse(mirror.exists())

    def test_descendant_write_keeps_a_mirror_even_when_its_directory_is_old(self) -> None:
        mirror = self.mirror()
        old = mirror.stat().st_mtime
        pack = mirror / "objects" / "pack" / "new-data"
        pack.write_bytes(b"recent fetch data")
        os.utime(mirror / "objects" / "pack", (old, old))
        os.utime(mirror, (old, old))
        report = self.prune()
        self.assertEqual(report["removed"], [])
        self.assertTrue(any("recently written" in item["reason"] for item in report["held"]))
        self.assertEqual(pack.read_bytes(), b"recent fetch data")

    def test_rechecks_freshness_under_lock_after_the_inventory_scan(self) -> None:
        mirror = self.mirror()
        bare = mirror_cache._bare

        def write_during_validation(descriptor: int) -> bool:
            (mirror / "FETCH_HEAD").write_text("new refresh\n")
            return bare(descriptor)

        with patch.object(mirror_cache, "_bare", side_effect=write_during_validation):
            report = self.prune()
        self.assertEqual(report["removed"], [])
        self.assertTrue((mirror / "FETCH_HEAD").exists())

    def test_checkout_repo_refresh_holds_the_same_nonblocking_lock(self) -> None:
        source = self.work / "source"
        source.mkdir()
        git(source, "init", "--quiet", "--initial-branch", "main")
        (source / "README").write_text("independent snapshot\n")
        git(source, "add", "README")
        git(source, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "fixture")
        local.checkout_repo("owner", "repo", "main", "fixture-token", self.work / "first", root=self.root, remote=str(source))
        age_tree(self.root / "owner" / "repo.git")
        entered, release = Event(), Event()
        original = local._run

        def hold_refresh(command: list[str], token: str, *secrets: str) -> str:
            if "fetch" in command:
                entered.set()
                if not release.wait(10):
                    raise RuntimeError("fixture did not release refresh")
            return original(command, token, *secrets)

        with patch.object(local, "_run", side_effect=hold_refresh), ThreadPoolExecutor(max_workers=1) as pool:
            checkout = pool.submit(local.checkout_repo, "owner", "repo", "main", "fixture-token", self.work / "second", self.root, str(source))
            try:
                self.assertTrue(entered.wait(10), "checkout never entered its locked refresh")
                report = self.prune()
                self.assertEqual(report["removed"], [])
                self.assertTrue(any("lock is busy" in item["reason"] for item in report["held"]))
                self.assertTrue((self.root / "owner" / "repo.git" / "HEAD").exists())
            finally:
                release.set()
            checkout.result()
        self.assertEqual((self.work / "second" / "README").read_text(), "independent snapshot\n")
        age_tree(self.root / "owner" / "repo.git")
        self.assertEqual(len(self.prune()["removed"]), 1)
        self.assertEqual(git(self.work / "second", "show", "HEAD:README"), "independent snapshot")

    def test_rejects_nonbare_mirrors_and_unrecognized_layout(self) -> None:
        checkout = self.root / "owner" / "repo.git"
        checkout.mkdir(parents=True)
        git(checkout, "init", "--quiet")
        (checkout / "unique").write_text("user source\n")
        flat = self.root / "flat.git"
        flat.mkdir()
        git(flat, "init", "--bare", "--quiet")
        age_tree(self.root)
        report = self.prune()
        self.assertEqual(report["removed"], [])
        self.assertTrue(any("not a bare Git mirror" in item["reason"] for item in report["held"]))
        self.assertEqual((checkout / "unique").read_text(), "user source\n")
        self.assertTrue((flat / "HEAD").exists())

    def test_bare_proof_uses_anchored_metadata_without_external_config_includes(self) -> None:
        mirror = self.mirror()
        external = self.work / "external-config"
        external.write_text("[core]\n bare = true\n")
        git(mirror, "config", "core.bare", "false")
        git(mirror, "config", "include.path", str(external))
        age_tree(mirror)
        report = self.prune()
        self.assertEqual(report["removed"], [])
        self.assertTrue(any("not a bare Git mirror" in item["reason"] for item in report["held"]))
        git(mirror, "config", "--no-includes", "core.bare", "true")
        (mirror / "HEAD").write_text("ref: refs/heads/../../outside\n")
        age_tree(mirror)
        self.assertEqual(self.prune()["removed"], [])

    def test_never_follows_owner_mirror_lock_or_descendant_symlinks(self) -> None:
        external = self.work / "outside"
        external.mkdir()
        (external / "unique").write_text("only copy\n")
        (self.root / "linked-owner").symlink_to(external, target_is_directory=True)
        mirror = self.mirror("owner/linked.git")
        (mirror.parent / "escape.git").symlink_to(external, target_is_directory=True)
        (mirror.parent / "linked.lock").symlink_to(external / "unique")
        descendant = self.mirror("owner/descendant.git")
        (descendant / "objects" / "outside").symlink_to(external, target_is_directory=True)
        report = self.prune()
        self.assertEqual(report["removed"], [])
        self.assertTrue(mirror.exists())
        self.assertTrue(descendant.exists())
        self.assertEqual((external / "unique").read_text(), "only copy\n")
        with self.assertRaisesRegex(ValueError, "without following symlinks"):
            mirror_cache.prune_mirrors(self.root / "linked-owner", 0, time.time_ns() // 1_000_000, FRESH_MS)

    def test_replaced_mirror_path_cannot_redirect_removal_outside_the_opened_directory(self) -> None:
        mirror = self.mirror()
        external = self.work / "outside"
        external.mkdir()
        (external / "unique").write_text("only copy\n")
        moved = self.work / "moved.git"
        bare = mirror_cache._bare

        def replace_during_validation(descriptor: int) -> bool:
            mirror.rename(moved)
            mirror.symlink_to(external, target_is_directory=True)
            return bare(descriptor)

        with patch.object(mirror_cache, "_bare", side_effect=replace_during_validation):
            report = self.prune()
        self.assertEqual(report["removed"], [])
        self.assertTrue(any("identity changed" in item["reason"] for item in report["held"]))
        self.assertEqual((external / "unique").read_text(), "only copy\n")
        self.assertTrue((moved / "HEAD").exists())

    def test_cli_is_local_without_a_github_account(self) -> None:
        mirror = self.mirror()
        output = io.StringIO()
        argv = ["github-interface", "--prune-mirrors", str(self.root), "--cap-bytes", "0", "--now-ms", str(time.time_ns() // 1_000_000)]
        with patch.object(sys, "argv", argv), patch("github_interface.interface.GitHubClient", side_effect=AssertionError("network client")), redirect_stdout(output):
            cli.main()
        self.assertEqual([item["path"] for item in json.loads(output.getvalue())["removed"]], [str(mirror)])

    def test_rejects_invalid_limits_before_mutation(self) -> None:
        mirror = self.mirror()
        for cap in (-1, True):
            with self.subTest(cap=cap), self.assertRaises(ValueError):
                mirror_cache.prune_mirrors(self.root, cap, time.time_ns() // 1_000_000, FRESH_MS)
        self.assertTrue((mirror / "HEAD").exists())
