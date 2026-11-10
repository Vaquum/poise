"""Recovered full-suite retirement; isolated API fixtures, not live CI proof."""
import base64
import copy
import difflib
import io
import json
import zipfile
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock

from github_interface import full_suite_repair
from github_interface.behaviors import issue_work

TARGET = "example/repo"
FAIL, RECOVERY, HEAD, BASE = (char * 40 for char in "abcd")
TESTS = ["the notices lists backfilled completions by handling time, not insertion order",
         "the notices compares since cutoffs carrying timezone offsets in UTC"]
# The two assertions from #940/#946: the first uses different fixture instants.
BEFORE = """const MINUTE = 60_000
const T0 = Date.parse('2026-10-09T10:00:00.000Z')
const at = (minutes: number) => T0 + minutes * MINUTE
describe('the notices', () => {
  it('lists backfilled completions by handling time, not insertion order', () => {
    expect(handling.listHandling().map((row) => row.title)).toEqual(['Recent dismissal', 'Old run'])
  })
  it('compares since cutoffs carrying timezone offsets in UTC', () => {
    expect(handling.listHandling(200, Date.now(), '2026-10-09T12:00:00+02:00').map((row) => row.title))
      .toEqual(['Eleven oclock'])
  })
})
"""
COVERING = BEFORE.replace("listHandling()", "listHandling(200, at(61))").replace("Date.now()", "at(61)")
DUPLICATE = COVERING.replace("at(61)", "at(11)", 1)


def file_change(after):
    return {"filename": "tests/notices.test.ts", "status": "modified", "additions": 2, "deletions": 2,
            "patch": "\n".join(list(difflib.unified_diff(BEFORE.splitlines(), after.splitlines()))[2:])}


class FullSuiteRepair(IsolatedAsyncioTestCase):
    def setUp(self):
        self.issue = {"title": full_suite_repair.TITLE, "state": "closed", "user": {"login": full_suite_repair.BOT},
                      "body": f"The full test suite failed on `main` at {FAIL}: https://github.com/{TARGET}/actions/runs/1\n\n"
                              + "\n".join(f"- tests/notices.test.ts > {test}" for test in TESTS)}
        self.comments = [{"author": full_suite_repair.BOT,
                          "body": f"The full suite passed at {RECOVERY}: https://github.com/{TARGET}/actions/runs/2\n\nClosing."}]
        self.pull = {"number": 946, "state": "open", "merged": False, "merged_at": None, "merge_commit_sha": None,
                     "head": {"ref": "poise/issue-7", "sha": HEAD, "repo": {"full_name": TARGET}},
                     "base": {"ref": "main", "sha": RECOVERY}, "user": {"login": "author"},
                     "body": "<!-- poise-chain example/repo#7 -->", "changed_files": 1, "additions": 2, "deletions": 2}
        self.duplicate, self.covering = DUPLICATE, COVERING
        self.files = [file_change(DUPLICATE)]
        self.run_event, self.passed_status, self.ancestry = "push", "passed", "ahead"
        self.current_head = HEAD
        self.client = AsyncMock()
        self.client.get.side_effect = self.get
        self.client.paginate.side_effect = self.paginate
        self.client.download.side_effect = self.download
        self.client.graphql.return_value = {"repository": {
            "ref": {"target": {"oid": HEAD, "message": "fix: repair\n\nPoise-Invocation: " + "e" * 32}},
            "defaultBranchRef": {"target": {"oid": RECOVERY}},
            "issue": {"closedByPullRequestsReferences": {"nodes": [], "pageInfo": {"hasNextPage": False}}}}}
        self.client.patch.side_effect = lambda *args, **kwargs: {**self.pull, "state": "closed"}

    async def get(self, path, **kwargs):
        root = f"/repos/{TARGET}"
        if path == root:
            return {"full_name": TARGET, "default_branch": "main"}
        if path == root + "/issues/7":
            return self.issue
        if path == root + "/pulls/946":
            return {**copy.deepcopy(self.pull), "head": {**self.pull["head"], "sha": self.current_head}}
        if path == root + "/pulls/940":
            return {"merged": True, "merge_commit_sha": RECOVERY, "base": {"ref": "main"}}
        for ident, sha, outcome in ((1, FAIL, "failure"), (2, RECOVERY, "success")):
            run = root + f"/actions/runs/{ident}"
            if path == run:
                return {"id": ident, "head_sha": sha, "head_repository": {"full_name": TARGET}, "head_branch": "main",
                        "path": ".github/workflows/ci.yml", "event": self.run_event, "status": "completed",
                        "conclusion": outcome, "run_attempt": 1, "html_url": f"https://github.com/{TARGET}/actions/runs/{ident}"}
            if path == run + "/attempts/1/jobs":
                return {"jobs": [{"name": "Unit & integration (2)", "conclusion": outcome}], "total_count": 1}
            if path == run + "/artifacts":
                return {"artifacts": [{"id": ident * 10 + shard, "name": f"unit-timings-{shard}", "expired": False}
                                      for shard in (1, 2)], "total_count": 2}
        if path == root + f"/compare/{FAIL}...{RECOVERY}":
            return {"status": self.ancestry, "commits": [{"sha": RECOVERY}], "total_commits": 1}
        if path == root + f"/compare/{RECOVERY}...{HEAD}":
            return {"merge_base_commit": {"sha": BASE}}
        if path == root + f"/commits/{RECOVERY}/pulls":
            return [{"number": 940, "merged_at": "2026-11-08T18:00:00Z", "merge_commit_sha": RECOVERY,
                     "html_url": f"https://github.com/{TARGET}/pull/940"}]
        if path == root + "/contents/tests/notices.test.ts":
            text = {HEAD: self.duplicate, BASE: BEFORE, RECOVERY: self.covering}[kwargs["params"]["ref"]]
            return {"encoding": "base64", "type": "file", "content": base64.b64encode(text.encode()).decode()}
        raise AssertionError(f"unexpected GitHub read {path}")

    async def paginate(self, path, params=None):
        if path.endswith("/pulls/946/files"):
            return self.files
        if path.endswith("/pulls/940/files"):
            return [file_change(self.covering)]
        if path.endswith("/pulls"):
            return [self.pull]
        if path.endswith("/issues/7/comments"):
            return [{**comment, "id": 3, "user": {"login": comment["author"]}} for comment in self.comments]
        raise AssertionError(f"unexpected GitHub page {path}")

    async def download(self, path):
        ident = int(path.split("/")[-2])
        tests = [{"fullName": test, "status": "failed" if ident < 20 else self.passed_status} for test in TESTS] if ident % 10 == 2 else []
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("vitest.json", json.dumps({"testResults": [{"name": "/runner/repo/tests/notices.test.ts", "assertionResults": tests}]}))
        return buffer.getvalue()

    async def inspect(self):
        return await full_suite_repair.inspect(self.client, TARGET, self.issue, self.comments, self.pull)

    async def test_real_nonidentical_assertion_repairs_are_covered_by_verified_run_and_merge(self):
        proof = await self.inspect()
        self.assertTrue(proof["verified"], proof)
        self.assertEqual(proof["duplicate"], {"number": 946, "head": HEAD})
        self.assertEqual(proof["covering"][0]["number"], 940)
        self.assertEqual(proof["recovery"]["sha"], RECOVERY)
        self.assertEqual(proof["failures"][0]["sha"], FAIL)
        self.client.patch.assert_not_awaited()

    async def test_green_or_closed_without_ancestry_and_test_coverage_cannot_retire(self):
        for attribute, value in (("run_event", "pull_request"), ("ancestry", "behind"), ("passed_status", "pending")):
            original = getattr(self, attribute)
            setattr(self, attribute, value)
            self.assertFalse((await self.inspect())["verified"])
            setattr(self, attribute, original)
        self.comments[0]["author"] = "someone-else"
        self.assertFalse((await self.inspect())["verified"])

    async def test_independent_work_and_changed_expected_values_stay_open(self):
        self.covering = COVERING.replace("T0 + minutes * MINUTE", "arbitraryFunction(minutes)")
        self.assertFalse((await self.inspect())["verified"])
        self.covering = COVERING
        self.duplicate += "const independent = true\n"
        self.assertFalse((await self.inspect())["verified"])
        self.duplicate = DUPLICATE.replace("'Old run'", "'Another expectation'")
        self.assertFalse((await self.inspect())["verified"])
        self.files += [{"filename": "server/independent.ts", "status": "modified", "additions": 1, "deletions": 1}]
        self.pull.update(changed_files=2, additions=3, deletions=3)
        self.assertFalse((await self.inspect())["verified"])
        self.client.patch.assert_not_awaited()

    async def retire(self, proof):
        return await issue_work.run(self.client, {"repository": TARGET, "token_user": "author", "issue": 7,
            "branch": "poise/issue-7", "pull_number": 946, "expected_head": HEAD, "mode": "retire", "coverage_json": json.dumps(proof)})

    async def test_native_close_rechecks_head_and_never_retries_a_lost_write_response(self):
        proof = await self.inspect()
        result = await self.retire(proof)
        self.assertEqual(result["outcome"], "closed")
        self.assertIsNone(result["merge_sha"])
        self.client.patch.assert_awaited_once_with(f"/repos/{TARGET}/pulls/946", json={"state": "closed"})
        self.client.patch.reset_mock()
        self.current_head = "f" * 40
        self.assertEqual((await self.retire(proof))["outcome"], "superseded")
        self.client.patch.assert_not_awaited()
        self.current_head = HEAD
        reads = 0

        async def changed_during_verification(path, **kwargs):
            nonlocal reads
            response = await self.get(path, **kwargs)
            if path.endswith("/pulls/946"):
                reads += 1
                if reads == 2:
                    response["head"]["sha"] = "f" * 40
            return response

        self.client.get.side_effect = changed_during_verification
        self.assertEqual((await self.retire(proof))["outcome"], "superseded")
        self.client.patch.assert_not_awaited()
        self.client.get.side_effect = self.get
        self.client.patch.side_effect = RuntimeError("close response lost")
        with self.assertRaisesRegex(RuntimeError, "close response lost"):
            await self.retire(proof)
        self.assertEqual(self.client.patch.await_count, 1)
