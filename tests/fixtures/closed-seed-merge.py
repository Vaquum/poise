"""Closed-seed discovery through real Caller projections with isolated transport."""
import asyncio
import json
import sys
from types import SimpleNamespace

# The application suite needs neither HTTP dependencies nor account credentials.
sys.modules["httpx"] = SimpleNamespace(Timeout=lambda *args, **kwargs: None)
sys.modules["github_interface.client"] = SimpleNamespace(GitHubClient=object)
from github_interface.behaviors import chain_seed, pull_action_state

request = json.load(sys.stdin)
argv, mode = request["argv"], request["mode"]
bound = request.get("bound", False)
TARGET, HEAD, MERGE = "example/repo", "a" * 40, "d" * 40
ISSUE, CLOSING = (1251, 1260) if bound else (7, 21)
BRANCH = f"poise/issue-{ISSUE}"
TEST_MERGE = "307c8a031acceae31843add8e66d97ce93ef5e13"
pull = {"number": CLOSING, "state": "closed", "merged": True, "merge_commit_sha": MERGE,
        "merged_at": "2026-11-10T14:18:50Z", "title": "fix: maintainer repair", "body": f"Closes #{ISSUE}",
        "user": {"login": "maintainer"},
        "head": {"ref": "emergency-repair", "sha": HEAD, "repo": {"full_name": "maintainer/fork"}},
        "base": {"ref": "main", "sha": "b" * 40, "repo": {"full_name": TARGET}}}
binding = {**pull, "number": 1259, "merged": False, "merged_at": None, "merge_commit_sha": TEST_MERGE,
           "html_url": f"https://github.com/{TARGET}/pull/1259",
           "body": f"Closes #{ISSUE}\n<!-- poise-chain {TARGET}#{ISSUE} -->", "user": {"login": "author"},
           "head": {"ref": BRANCH, "sha": HEAD, "repo": {"full_name": TARGET}}}


class Client:
    async def get(self, path):
        if path == f"/repos/{TARGET}":
            return {"full_name": TARGET, "default_branch": "main"}
        if path == f"/repos/{TARGET}/issues/{ISSUE}":
            return {"title": "Seed", "body": "", "state": "closed", "labels": []}
        if bound and path == f"/repos/{TARGET}/pulls/1259":
            return binding
        if path == f"/repos/{TARGET}/pulls/{CLOSING}":
            return {**pull, "merge_commit_sha": "c" * 40 if mode == "contradictory" else MERGE}
        raise AssertionError(f"unexpected read {path}")

    async def paginate(self, path, params=None):
        if path == f"/repos/{TARGET}/pulls":
            assert params == {"state": "all", "head": f"example:{BRANCH}"}
            return [binding] if bound else []
        if path in {f"/repos/{TARGET}/issues/{ISSUE}/comments", f"/repos/{TARGET}/pulls/{CLOSING}/reviews",
                    f"/repos/{TARGET}/pulls/1259/reviews"}:
            return []
        raise AssertionError(f"unexpected list {path}")

    async def graphql(self, query, variables):
        if "includeClosedPrs:true" not in query:
            assert variables == {"owner": "example", "repo": "repo", "ref": f"refs/heads/{BRANCH}", "number": ISSUE, "cursor": None}
            linked = [{"number": CLOSING, "url": f"https://github.com/{TARGET}/pull/{CLOSING}",
                       "repository": {"nameWithOwner": TARGET}, "headRefName": "emergency-repair"}] if bound else []
            return {"repository": {"ref": {"target": {"oid": HEAD}} if bound else None,
                    "defaultBranchRef": {"target": {"oid": "b" * 40}},
                    "issue": {"closedByPullRequestsReferences": {"nodes": linked, "pageInfo": {"hasNextPage": False}}}}}
        assert variables == {"owner": "example", "repo": "repo", "number": ISSUE}
        assert "baseRepository{nameWithOwner}" in query and "baseRefName" in query and "mergeCommit{oid}" in query
        if mode == "unavailable":
            raise RuntimeError("closing references unavailable")
        reference = {"number": CLOSING, "merged": mode != "unmerged", "baseRepository": {"nameWithOwner": TARGET},
                     "baseRefName": "main", "mergeCommit": {"oid": MERGE}}
        if mode == "wrong-repository":
            reference["baseRepository"]["nameWithOwner"] = "other/repo"
        if mode == "wrong-branch":
            reference["baseRefName"] = "release"
        if mode == "missing-sha":
            reference["mergeCommit"]["oid"] = ""
        nodes = [] if mode == "unmatched" else [reference]
        if mode == "ambiguous":
            nodes.append({**reference, "number": 22})
        return {"repository": {"nameWithOwner": TARGET, "defaultBranchRef": {"name": "main"},
                "issue": {"state": "CLOSED", "closedByPullRequestsReferences": {
                    "nodes": nodes, "pageInfo": {"hasNextPage": mode == "incomplete"}}}}}


payload = {"repository": TARGET, "token_user": argv[argv.index("--token-user") + 1]}
if argv[0] == "--chain-seed":
    assert payload["token_user"] == "author"
    result = chain_seed.run(Client(), {**payload, "issue": argv[1], "branch": argv[argv.index("--branch") + 1]})
else:
    assert argv[0] == "--pull-action-state" and int(argv[1]) in {CLOSING, 1259} and "--queue-evidence" in argv
    assert payload["token_user"] == "reviewer"
    result = pull_action_state.run(Client(), {**payload, "pr": argv[1], "queue_evidence": True})
print(json.dumps(asyncio.run(result)))
