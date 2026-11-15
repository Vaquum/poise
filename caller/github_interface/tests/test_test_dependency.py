"""Original CI artifacts, exact-base failure and delivered recovery fixtures."""
import copy
import io
import json
import zipfile
from unittest import IsolatedAsyncioTestCase
from unittest.mock import AsyncMock, patch

from github_interface import test_dependency

TARGET, BASE, MERGE, MAIN = "example/repo", "a" * 40, "b" * 40, "c" * 40


class TestDependency(IsolatedAsyncioTestCase):
    def setUp(self):
        self.value = {"base": BASE, "run": 1, "baselineRun": 2, "remediation": f"https://github.com/{TARGET}/issues/1530"}
        self.delivered = False
        self.runs = {ident: {"id": ident, "head_sha": BASE if ident < 3 else MAIN,
                            "head_repository": {"full_name": TARGET}, "head_branch": "main", "event": "push",
                            "path": ".github/workflows/ci.yml", "status": "completed", "run_attempt": 1,
                            "conclusion": "failure" if ident < 3 else "success",
                            "html_url": f"https://github.com/{TARGET}/actions/runs/{ident}"} for ident in (1, 2, 3)}
        self.tests = {ident: [{"fullName": "relay rejects an unrelated warning", "status": "failed" if ident < 3 else "passed",
                              "failureMessages": ["AssertionError: expected warning array to be empty"] if ident < 3 else []}]
                      for ident in (1, 2, 3)}
        self.extra_job = None
        self.unit2_failure = False
        self.client = AsyncMock()
        self.client.get.side_effect = self.get
        self.client.download.side_effect = self.download
        self.client.graphql.side_effect = self.graphql

    async def get(self, path, **kwargs):
        root = f"/repos/{TARGET}"
        if path == root + "/issues/1530":
            return {"number": 1530, "state": "closed" if self.delivered else "open"}
        if path == root + "/pulls/1531":
            return {"merged": True, "merge_commit_sha": MERGE, "base": {"ref": "main", "repo": {"full_name": TARGET}}}
        if path.startswith(root + "/compare/"):
            before = path.split("/compare/")[1].split("...")[0]
            return {"status": "ahead", "base_commit": {"sha": before}, "merge_base_commit": {"sha": before}}
        if path == root + "/actions/runs":
            self.assertEqual(kwargs["params"]["head_sha"], MAIN)
            return {"workflow_runs": [self.runs[3]]}
        for ident in (1, 2, 3):
            run = root + f"/actions/runs/{ident}"
            if path == run:
                return self.runs[ident]
            if path == run + f"/attempts/{self.runs[ident]['run_attempt']}/jobs":
                jobs = [{"name": f"Unit & integration ({shard})",
                         "conclusion": "failure" if ident < 3 and (shard == 1 or self.unit2_failure) else "success"} for shard in (1, 2)]
                if self.extra_job:
                    jobs.append(self.extra_job)
                return {"jobs": jobs, "total_count": len(jobs)}
            if path == run + "/artifacts":
                return {"artifacts": [{"id": ident * 10 + shard, "name": f"unit-timings-{shard}", "expired": False} for shard in (1, 2)],
                        "total_count": 2}
        raise AssertionError(f"unexpected read {path}")

    async def graphql(self, query, variables):
        self.assertEqual(variables["number"], 1530)
        return {"repository": {"nameWithOwner": TARGET, "issue": {"state": "CLOSED" if self.delivered else "OPEN",
                "closedByPullRequestsReferences": {"pageInfo": {"hasNextPage": False}, "nodes": [
                    {"number": 1531, "merged": True, "repository": {"nameWithOwner": TARGET}, "mergeCommit": {"oid": MERGE}}]}}}}

    async def download(self, path):
        ident, shard = divmod(int(path.split("/")[-2]), 10)
        tests = self.tests[ident] if shard == 1 else []
        report = {"numFailedTests": sum(test["status"] == "failed" for test in tests), "numTotalTests": len(tests),
                  "testResults": [{"name": "/runner/repo/tests/test-relay.test.ts", "assertionResults": tests,
                                   "status": "failed" if any(test["status"] == "failed" for test in tests) else "passed"}]}
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("vitest.json", json.dumps(report))
        return buffer.getvalue()

    async def inspect(self, value=None):
        return await test_dependency.inspect(self.client, TARGET, value or self.value, MAIN)

    async def test_original_failure_is_independently_proven_then_original_test_passes_after_delivery(self):
        proof = await self.inspect()
        self.assertTrue(proof["verified"], proof)
        self.assertFalse(proof["recovered"])
        self.assertEqual(proof["base"], BASE)
        self.assertEqual(proof["failures"][0]["cause"], self.tests[1][0]["failureMessages"][0])
        self.delivered = True
        recovery = await self.inspect(proof)
        self.assertTrue(recovery["recovered"], recovery)
        self.assertEqual(recovery["recovery"], {"merge": MERGE, "base": MAIN,
                         "run": {"id": 3, "sha": MAIN, "attempt": 1, "url": self.runs[3]["html_url"]}})
        self.client.post.assert_not_awaited()
        self.client.patch.assert_not_awaited()

    async def test_wrong_base_original_rerun_missing_assertions_and_different_causes_keep_hold(self):
        proof = await self.inspect()
        for change in ({"head_sha": MAIN}, {"event": "pull_request"}, {"run_attempt": 2}):
            prior = copy.deepcopy(self.runs[1])
            self.runs[1].update(change)
            self.assertFalse((await self.inspect(proof))["verified"])
            self.runs[1] = prior
        self.tests[2][0]["failureMessages"] = ["AssertionError: independent candidate-specific cause"]
        self.assertFalse((await self.inspect())["verified"])
        self.tests[2] = []
        self.assertFalse((await self.inspect())["verified"])

    async def test_every_failure_in_one_suite_must_be_shared(self):
        self.tests[1].append({"fullName": "candidate regression", "status": "failed", "failureMessages": ["candidate broke behavior"]})
        self.assertFalse((await self.inspect())["verified"])
        self.tests[2].append(copy.deepcopy(self.tests[1][-1]))
        self.assertTrue((await self.inspect())["verified"])
        self.extra_job = {"name": "Static checks", "conclusion": "failure"}
        self.assertFalse((await self.inspect())["verified"])
        self.extra_job = None
        self.unit2_failure = True
        self.assertFalse((await self.inspect())["verified"])

    async def test_closed_issue_green_unrelated_job_or_skipped_original_test_cannot_recover(self):
        self.delivered = True
        for status in ("pending", "failed"):
            self.tests[3][0]["status"] = status
            self.assertFalse((await self.inspect())["recovered"])
        self.tests[3] = []
        self.assertFalse((await self.inspect())["recovered"])
        self.runs[3]["path"] = ".github/workflows/unrelated.yml"
        self.assertFalse((await self.inspect())["recovered"])
        self.assertFalse((await self.inspect({**self.value, "run": "relay-run", "base": "d" * 64}))["verified"])

    async def test_passing_parameterized_duplicates_with_one_fixed_title_do_not_block_proof(self):
        duplicates = [{"fullName": "rejects malformed preparation envelopes through the read error path",
                       "status": "passed", "failureMessages": []} for _ in range(2)]
        for ident in (1, 2, 3):
            self.tests[ident].extend(copy.deepcopy(duplicates))
        proof = await self.inspect()
        self.assertTrue(proof["verified"], proof)
        self.assertEqual(len(proof["failures"]), 1)
        self.delivered = True
        self.assertTrue((await self.inspect(proof))["recovered"])

    async def test_recovered_report_missing_one_duplicate_case_does_not_authorize_recovery(self):
        first = {"fullName": "rejects malformed preparation envelopes", "status": "failed",
                 "failureMessages": ["AssertionError: first parameter"]}
        second = {"fullName": "rejects malformed preparation envelopes", "status": "failed",
                  "failureMessages": ["AssertionError: second parameter"]}
        for ident in (1, 2):
            self.tests[ident] = [copy.deepcopy(first), copy.deepcopy(second)]
        self.tests[3] = [{"fullName": "rejects malformed preparation envelopes",
                          "status": "passed", "failureMessages": []}]
        proof = await self.inspect()
        self.assertTrue(proof["verified"], proof)
        self.assertEqual(len(proof["failures"]), 2)
        self.delivered = True
        recovered = await self.inspect(proof)
        self.assertFalse(recovered["recovered"], recovered)
        self.assertIn("every original failing assertion", recovered["reason"])
        self.tests[3].append(copy.deepcopy(self.tests[3][0]))
        self.assertTrue((await self.inspect(proof))["recovered"])

    async def test_recovered_report_matching_only_the_original_passing_case_does_not_authorize_recovery(self):
        failing = {"fullName": "rejects malformed preparation envelopes", "status": "failed",
                   "failureMessages": ["AssertionError: one parameter"]}
        passing = {"fullName": "rejects malformed preparation envelopes",
                   "status": "passed", "failureMessages": []}
        for ident in (1, 2):
            self.tests[ident] = [copy.deepcopy(failing), copy.deepcopy(passing)]
        self.tests[3] = [copy.deepcopy(passing)]
        proof = await self.inspect()
        self.assertTrue(proof["verified"], proof)
        self.assertEqual(len(proof["failures"]), 1)
        self.delivered = True
        recovered = await self.inspect(proof)
        self.assertFalse(recovered["recovered"], recovered)
        self.assertIn("every original failing assertion", recovered["reason"])
        self.tests[3].append(copy.deepcopy(passing))
        self.assertTrue((await self.inspect(proof))["recovered"])

    def relay_fixture(self):
        binding = {"call": "d" * 32, "nonce": "e" * 64, "repository": TARGET, "base": BASE}
        value = {"source": "relay", "base": BASE, "run": "1" * 32, "baselineRun": "2" * 32,
                 "capture": binding, "remediation": self.value["remediation"],
                 "relay": {name: {"payload": name, "signature": "gateway signature"} for name in ("original", "baseline")}}
        failed = {"file": "tests/test-relay.test.ts", "test": self.tests[1][0]["fullName"],
                  "cause": self.tests[1][0]["failureMessages"][0], "causeDigest": "8" * 64}
        runs = {name: {"binding": binding, "base": BASE, "repository": TARGET, "exit": 1,
                       "run": value["run" if name == "original" else "baselineRun"],
                       "candidate": ("3" if name == "original" else "4") * 64,
                       "source": ("5" if name == "original" else "6") * 64,
                       "clean": name == "baseline", "command": ["node", "$CHECKOUT/node_modules/vitest/vitest.mjs", "run"],
                       "failures": [copy.deepcopy(failed)], "totals": [{"file": failed["file"], "test": failed["test"], "total": 2}]}
                for name in ("original", "baseline")}
        return value, runs

    async def test_completed_relay_proof_reuses_delivery_and_full_original_case_validation(self):
        value, runs = self.relay_fixture()
        with patch.object(test_dependency, "_relay_receipt", side_effect=lambda receipt: copy.deepcopy(runs[receipt["payload"]])):
            proof = await self.inspect(value)
            self.assertTrue(proof["verified"], proof)
            self.assertFalse(proof["recovered"])
            self.assertEqual(proof["capture"], value["capture"])
            self.assertEqual(proof["candidate"], runs["original"]["candidate"])
            self.delivered = True
            # The passing fixed-title parameter cannot replace the missing
            # failing parameter, even though the title appears in green CI.
            self.assertFalse((await self.inspect(proof))["recovered"])
            self.tests[3].append(copy.deepcopy(self.tests[3][0]))
            self.assertTrue((await self.inspect(proof))["recovered"])
            self.tests[3][1]["status"] = "skipped"
            self.assertFalse((await self.inspect(proof))["recovered"])
            runs["original"]["candidate"] = "7" * 64
            self.assertFalse((await self.inspect(proof))["verified"])

    async def test_same_head_dirty_replay_mismatched_call_and_missing_relay_results_keep_hold(self):
        value, runs = self.relay_fixture()
        changes = [
            ("baseline", {"clean": False}),
            ("baseline", {"source": runs["original"]["source"]}),
            ("baseline", {"candidate": runs["original"]["candidate"]}),
            ("baseline", {"base": MAIN}),
            ("baseline", {"command": ["node", "other-suite"]}),
            ("original", {"binding": {**value["capture"], "call": "f" * 32}}),
            ("original", {"exit": 125}),
            ("original", {"failures": []}),
            ("original", {"totals": []}),
        ]
        with patch.object(test_dependency, "_relay_receipt", side_effect=lambda receipt: copy.deepcopy(runs[receipt["payload"]])):
            for name, change in changes:
                before = copy.deepcopy(runs[name])
                runs[name].update(change)
                with self.subTest(change=change):
                    self.assertFalse((await self.inspect(value))["verified"])
                runs[name] = before
        with patch.object(test_dependency, "_relay_receipt", side_effect=ValueError("signature is invalid")):
            self.assertFalse((await self.inspect(value))["verified"])

    async def test_complete_relay_multiset_rejects_candidate_only_failure_beyond_excerpt_and_overflow(self):
        value, runs = self.relay_fixture()
        for run in runs.values():
            run["failures"][0]["cause"] += "\n" + "common stack detail\n" * 300
        extra = {"file": "tests/candidate.test.ts", "test": "candidate regression", "cause": "expected candidate behavior", "causeDigest": "9" * 64}
        runs["original"]["failures"].append(extra)
        runs["original"]["totals"].append({"file": extra["file"], "test": extra["test"], "total": 1})
        with patch.object(test_dependency, "_relay_receipt", side_effect=lambda receipt: copy.deepcopy(runs[receipt["payload"]])):
            self.assertFalse((await self.inspect(value))["verified"])
            # Sharing one cause does not excuse a second candidate-only cause
            # under that same title either.
            runs["baseline"]["failures"].append({**extra, "cause": "different assertion"})
            runs["baseline"]["totals"].append(copy.deepcopy(runs["original"]["totals"][-1]))
            self.assertFalse((await self.inspect(value))["verified"])
            runs["baseline"]["failures"][-1] = copy.deepcopy(extra)
            self.assertTrue((await self.inspect(value))["verified"])
            runs["baseline"]["failures"][-1]["causeDigest"] = "0" * 64
            self.assertFalse((await self.inspect(value))["verified"])
            for run in runs.values():
                run["failures"][0]["cause"] = "x" * (32 * 1024 + 1)
            self.assertFalse((await self.inspect(value))["verified"])
