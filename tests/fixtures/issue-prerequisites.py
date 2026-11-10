"""Captured #1100 -> #1104/#1105 evidence with only GitHub transport replaced."""
import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

from github_datastore.cli import main
from github_datastore.db import connect, init_db, upsert_repo
from github_datastore.store import store_expanded


BASE = "a" * 40
MERGE = "b" * 40
TARGET = "autonomio/poise"
request = json.load(sys.stdin)
mode, argv = request["mode"], request["argv"]

if request["command"] == "github-datastore":
    number = int(argv[argv.index("--number") + 1])
    graph = {"blockedBy": {"nodes": [{"number": 1100, "repository": {"nameWithOwner": "Autonomio/Poise"}}],
                           "pageInfo": {"hasNextPage": mode == "truncated"}}}
    if mode == "absent":
        graph = {}
    elif mode == "missing-page":
        del graph["blockedBy"]["pageInfo"]
    elif mode == "malformed":
        graph["blockedBy"]["nodes"] = [{"number": 1100}]
    elif mode == "empty":
        graph["blockedBy"]["nodes"] = []
    elif mode == "cross-repo":
        graph["blockedBy"]["nodes"][0]["repository"]["nameWithOwner"] = "other/repo"
    repo = {"id": 1, "node_id": "R_1", "full_name": TARGET, "owner": {"login": "autonomio"},
            "name": "poise", "private": False, "archived": False, "has_issues": True}
    issue = {"id": number, "node_id": f"I_{number}", "number": number, "state": "open", "title": "Seed", "body": "Depends on: #1100",
             "user": {"login": "author"}, "assignees": [], "labels": [], "created_at": "2026-11-10T00:00:00Z",
             "updated_at": "2026-11-10T00:00:00Z", "closed_at": None, "graphql": graph}
    conn = connect(Path(request["db"]))
    init_db(conn)
    with conn:
        upsert_repo(conn, repo)
    if mode != "missing-item":
        store_expanded(conn, {"repo": repo, "is_pr": False, "issue": issue, "pull": None,
                              "comments": [], "timeline": [], "reviews": [], "review_comments": [], "commits": []})
    else:
        with conn:
            conn.execute("DELETE FROM items WHERE number = ?", (number,))
    conn.close()
    main(["--db", request["db"], *argv])
else:
    # The application suite needs no HTTP client dependency or credentials.
    # Only the transport module is replaced; the delivery projection is real.
    sys.modules["github_interface.client"] = SimpleNamespace(GitHubClient=object)
    from github_interface.behaviors import read_issue

    assert argv[:2] == ["--read-issue", "#1100"]
    payload = {"issue": argv[1], "delivery_base": argv[argv.index("--delivery-base") + 1],
               "token_user": argv[argv.index("--token-user") + 1], "repository": TARGET}
    assert payload["token_user"] == "author"
    assert payload["delivery_base"] == BASE

    class Client:
        async def graphql(self, query, variables):
            assert "includeClosedPrs:true" in query
            assert variables == {"owner": "autonomio", "repo": "poise", "number": 1100}
            pull = {"number": 1101, "merged": mode != "queued", "baseRefName": "release" if mode in {"other-branch", "integrated-branch"} else "main",
                    "repository": {"nameWithOwner": TARGET}, "mergeCommit": {"oid": MERGE}}
            issue = {"state": "OPEN" if mode == "open" else "CLOSED", "closedByPullRequestsReferences": {
                "nodes": [] if mode == "closed" else [pull], "pageInfo": {"hasNextPage": mode == "truncated-delivery"}}}
            return {"repository": {"nameWithOwner": TARGET, "defaultBranchRef": {"name": "main"},
                                   "issue": None if mode == "missing-prerequisite" else issue}}

        async def get(self, path):
            assert path == f"/repos/{TARGET}/compare/{MERGE}...{BASE}"
            off_base = mode in {"off-base", "other-branch"}
            return {"status": "diverged" if off_base else "ahead", "base_commit": {"sha": MERGE},
                    "merge_base_commit": {"sha": "c" * 40 if off_base else MERGE}}

    print(json.dumps(asyncio.run(read_issue.run(Client(), payload))))
