"""The #1648/#1653 sequence, using real Git integration and isolated GitHub reads."""
import copy
import json
import subprocess
import tempfile
from pathlib import Path
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

from github_interface.behaviors import chain_seed, issue_work

TARGET = "example/repo"
PAYLOAD = {"repository": TARGET, "token_user": "author", "issue": 1633, "branch": "poise/issue-1633"}
BEFORE = """it('take a Python test runner out of this machine, from any interpreter, and it never runs here', () => {
  const { hooks } = hooked(true)
  const repo = temp()
  execFileSync('git', ['init', '-q', repo])
  const marker = join(repo, 'ran-here')
  mkdirSync(join(repo, 'pytest'))
  writeFileSync(join(repo, 'pytest', '__main__.py'), `open(${JSON.stringify(marker)}, 'w')`)
  const result = spawnSync('python3', ['-m', 'pytest', '-q'], { cwd: repo, encoding: 'utf8', env: { ...process.env, PYTHONPATH: hooks } })
  expect(result.status).toBe(125)
  expect(result.stderr).toContain('[poise]')
  expect(existsSync(marker)).toBe(false)
})
"""
DUPLICATE = BEFORE.replace("  const repo = temp()", """  writeFileSync(join(hooks, 'run.mjs'), `console.log(JSON.stringify(process.argv.slice(2)))
console.error('[poise] fixture sender: relay unavailable')
process.exitCode = 125`)
  const repo = temp()""").replace("  expect(result.stderr).toContain('[poise]')", """  const args = JSON.parse(result.stdout) as string[]
  expect(args.slice(args.indexOf('--') + 1)).toEqual(['python3', '-m', 'pytest', '-q'])
  expect(result.stderr).toContain('[poise] fixture sender: relay unavailable')""")
COVERING = DUPLICATE.replace("  mkdirSync(join(repo, 'pytest'))", """  mkdirSync(join(repo, 'pytest'))
  writeFileSync(join(repo, 'pytest', '__init__.py'), '')""")


class RemediationRetirement(IsolatedAsyncioTestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.git("init", "--quiet", "--initial-branch=main")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.path = self.root / "fixture.ts"
        self.path.write_text(BEFORE)
        self.original = self.commit("original base")
        self.git("checkout", "--quiet", "-b", PAYLOAD["branch"])
        self.path.write_text(DUPLICATE)
        self.head = self.commit("#1653 duplicate repair")
        self.git("checkout", "--quiet", "main")
        self.base = self.original
        self.covering = None
        self.linked = True
        self.issue = {"number": 1633, "title": "fix: blocked implementation for #1608", "state": "open", "labels": [],
                      "user": {"login": "author"}, "body": "<!-- poise-repair-exhaustion:" + "a" * 64 + " -->\n\n"
                      "Stage: implement-issue. Cause: atomic_work_blocked.\nSource: example/repo#1608; hold event 1;"}
        self.client = AsyncMock(token="fixture-token")
        self.client.get.side_effect = self.get
        self.client.paginate.side_effect = self.paginate
        self.client.graphql.side_effect = self.graphql
        self.client.patch.side_effect = lambda *args, **kwargs: {**self.pull(), "state": "closed"}
        original_git = issue_work._git

        def local_git(cwd, env, *args, **kwargs):
            if args[:2] == ("remote", "add"):
                args = (*args[:-1], self.root.as_uri())
            return original_git(cwd, env, *args, **kwargs)

        standin = patch.object(issue_work, "_git", side_effect=local_git)
        standin.start()
        self.addCleanup(standin.stop)

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, env=issue_work._env("fixture-token"),
                                       stderr=subprocess.STDOUT).decode().strip()

    def commit(self, message):
        self.git("add", ".")
        self.git("commit", "--quiet", "-m", message)
        return self.git("rev-parse", "HEAD")

    def land_cover(self):
        self.git("checkout", "--quiet", "-b", "covering", self.original)
        self.path.write_text(COVERING)
        self.commit("#1648 repair plus Python package fixture")
        self.git("checkout", "--quiet", "main")
        self.git("merge", "--quiet", "--no-ff", "covering", "-m", "merge #1648")
        self.covering = self.base = self.git("rev-parse", "HEAD")

    def pull(self):
        return {"number": 1653, "state": "open", "merged": False, "merged_at": None, "merge_commit_sha": None,
                "head": {"ref": PAYLOAD["branch"], "sha": self.head, "repo": {"full_name": TARGET}},
                "base": {"ref": "main", "sha": self.base, "repo": {"full_name": TARGET}},
                "user": {"login": "author"}, "body": "<!-- poise-chain example/repo#1633 -->"}

    async def get(self, path, **kwargs):
        root = f"/repos/{TARGET}"
        if path == root:
            return {"full_name": TARGET, "default_branch": "main"}
        if path == root + "/issues/1633":
            return copy.deepcopy(self.issue)
        if path == root + "/pulls/1653":
            return self.pull()
        if path == root + "/pulls/1648":
            return {"number": 1648, "merged": True, "merge_commit_sha": self.covering,
                    "base": {"ref": "main", "repo": {"full_name": TARGET}}, "html_url": f"https://github.com/{TARGET}/pull/1648"}
        if path == root + "/git/ref/heads/main":
            return {"object": {"sha": self.base}}
        if path.startswith(root + "/commits/") and path.endswith("/pulls"):
            return [{"number": 1648, "merged_at": "2026-11-13T23:00:00Z", "merge_commit_sha": self.covering}] \
                if self.linked and path == root + f"/commits/{self.covering}/pulls" else []
        raise AssertionError(f"unexpected GitHub read {path}")

    async def paginate(self, path, params=None):
        if path.endswith("/pulls"):
            return [self.pull()]
        if path.endswith("/comments"):
            return []
        raise AssertionError(f"unexpected GitHub page {path}")

    async def graphql(self, *args):
        return {"repository": {"ref": {"target": {"oid": self.head, "message": "fix: duplicate"}},
                "defaultBranchRef": {"target": {"oid": self.base}},
                "issue": {"closedByPullRequestsReferences": {"nodes": [], "pageInfo": {"hasNextPage": False}}}}}

    async def coverage(self):
        return (await chain_seed.run(self.client, PAYLOAD))["remediation"]

    async def retire(self, proof):
        return await issue_work.run(self.client, {**PAYLOAD, "mode": "retire", "pull_number": 1653,
                                   "expected_head": proof["duplicate"]["head"], "coverage_json": json.dumps(proof)})

    async def test_cover_lands_after_enqueue_and_closes_without_redundant_merge_despite_different_branch_tree(self):
        self.assertFalse((await self.coverage())["verified"])
        self.land_cover()
        # A later unrelated merge must not be credited with the fixture repair.
        (self.root / "later.txt").write_text("unrelated base work\n")
        self.base = self.commit("later base change")
        self.assertNotEqual(self.git("rev-parse", f"{self.head}^{{tree}}"), self.git("rev-parse", f"{self.base}^{{tree}}"))
        proof = await self.coverage()
        self.assertTrue(proof["verified"], proof)
        self.assertEqual(proof["covering"][0]["mergeSha"], self.covering)
        self.assertEqual(proof["covering"][0]["parent"], self.original)
        self.assertEqual(proof["integration"]["tree"], proof["integration"]["baseTree"])
        before = self.git("rev-parse", "main")
        result = await self.retire(proof)
        self.assertEqual((result["outcome"], result["coverage"], result["merge_sha"]), ("closed", proof, None))
        self.client.patch.assert_awaited_once_with(f"/repos/{TARGET}/pulls/1653", json={"state": "closed"})
        self.client.post.assert_not_awaited()
        self.assertEqual(self.git("rev-parse", "main"), before)

    async def test_independent_work_conflicts_and_missing_cover_evidence_leave_normal_processing(self):
        self.land_cover()
        self.linked = False
        self.assertFalse((await self.coverage())["verified"])
        self.linked = True
        self.git("checkout", "--quiet", PAYLOAD["branch"])
        (self.root / "independent.txt").write_text("remaining work\n")
        self.head = self.commit("independent work")
        self.assertFalse((await self.coverage())["verified"])
        self.path.write_text(BEFORE.replace("const repo = temp()", "const repo = independent()"))
        self.head = self.commit("conflicting work")
        self.assertFalse((await self.coverage())["verified"])
        self.client.patch.assert_not_awaited()

    async def test_native_close_rejects_head_or_base_drift_that_introduces_remaining_work(self):
        self.land_cover()
        proof = await self.coverage()
        self.git("checkout", "--quiet", PAYLOAD["branch"])
        (self.root / "independent.txt").write_text("remaining work\n")
        independent = self.commit("independent candidate work")
        self.git("checkout", "--quiet", "main")
        self.path.write_text(BEFORE)
        reverted = self.commit("base no longer covers candidate")
        initial_head, initial_base = self.head, self.base
        for change in ("head", "base"):
            reads = 0

            async def drift(path, **kwargs):
                nonlocal reads
                response = await self.get(path, **kwargs)
                if path.endswith("/pulls/1653"):
                    reads += 1
                    if reads == 2 and change == "head":
                        self.head = independent
                        response["head"]["sha"] = independent
                    if reads == 2 and change == "base":
                        self.base = reverted  # The PR projection still carries the previous base.
                return response

            self.client.get.side_effect = drift
            self.assertEqual((await self.retire(proof))["outcome"], "superseded")
            self.client.patch.assert_not_awaited()
            self.client.get.side_effect = self.get
            self.assertFalse((await self.coverage())["verified"])
            self.head, self.base = initial_head, initial_base

    async def test_ordinary_issues_do_not_acquire_the_remediation_policy(self):
        self.issue["body"] = "An ordinary issue, even if its patch is already merged."
        self.land_cover()
        self.assertNotIn("remediation", await chain_seed.run(self.client, PAYLOAD))
