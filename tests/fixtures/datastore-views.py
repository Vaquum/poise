"""A real datastore, built by Caller's own store, and Caller's own answers.

stdin: {"db": path, "me": login, "agent": login, "argvs": [[...], ...], "unlabelled": bool}
stdout: one entry per argv, in order: {"rows": [...]} or {"error": message}

The items vary every column the pr, issue and user views filter, order or
derive on: state, author, assignee, labels, repository case and timestamps.
"""
import contextlib
import io
import json
import sys
from pathlib import Path

from github_datastore.cli import main
from github_datastore.db import connect, init_db, upsert_repo
from github_datastore.store import store_expanded

request = json.load(sys.stdin)
db, me, agent = request["db"], request["me"], request["agent"]

REPOS = [
    {"id": 1, "node_id": "R_1", "full_name": "acme/Mixed-Case", "owner": {"login": "acme"}, "name": "Mixed-Case",
     "private": False, "archived": False, "has_issues": True},
    {"id": 2, "node_id": "R_2", "full_name": "acme/plain", "owner": {"login": "acme"}, "name": "plain",
     "private": False, "archived": False, "has_issues": True},
]
AUTHORS = [me, agent, "someone"]
LABELS = [[], [{"name": "poise-work"}], [{"name": "Poise-Work"}, {"name": "bug"}], [{"name": "bug"}]]


def user(login):
    return {"login": login, "avatar_url": f"https://avatars.example/{login}"}


def stamp(day, hour):
    return f"2026-11-{day:02d}T{hour:02d}:00:00Z"


conn = connect(Path(db))
init_db(conn)
with conn:
    for repo in REPOS:
        upsert_repo(conn, repo)
item_id = 100
for index in range(24):
    repo = REPOS[index % 2]
    is_pr = index % 3 != 0
    number = index + 1
    author = AUTHORS[index % 3]
    state = "closed" if index % 5 == 0 else "open"
    # Two items share an updated_at, so the repo and number tiebreaks decide.
    updated = stamp(1 + index % 9, 12 if index in (4, 7) else index % 24)
    created = stamp(1 + index % 5, 3)
    assignees = [user(me)] if index % 4 == 0 else [user("helper")] if index % 4 == 1 else []
    body = f"Work item {number}" + (f" for @{me}" if index % 6 == 1 else "")
    item_id += 1
    issue = {"id": item_id, "node_id": f"I_{item_id}", "number": number, "state": state, "title": f"Item {number}",
             "body": body, "user": user(author), "assignees": assignees, "labels": LABELS[index % 4],
             "created_at": created, "updated_at": updated, "closed_at": updated if state == "closed" else None,
             "comments": 0}
    if is_pr:
        issue["pull_request"] = {"url": f"https://api.github.com/repos/{repo['full_name']}/pulls/{number}"}
    pull = None
    if is_pr:
        pull = {"id": item_id + 5000, "node_id": f"PR_{item_id}", "number": number, "state": state, "title": issue["title"], "body": body, "user": user(author),
                "assignees": assignees, "requested_reviewers": [user(me)] if index % 2 else [],
                "created_at": created, "updated_at": updated, "closed_at": issue["closed_at"],
                "merged": False, "draft": index % 7 == 0,
                "graphql": {"isDraft": index % 7 == 0, "additions": index * 3, "deletions": index,
                            "headRefName": f"branch-{number}",
                            "headRepository": {"nameWithOwner": repo["full_name"]}}}
    comments = [{"id": 9000 + index, "node_id": f"C_{index}", "user": user(me), "body": "Looks right",
                 "created_at": updated, "updated_at": updated}] if index % 5 == 2 else []
    store_expanded(conn, {"repo": repo, "is_pr": is_pr, "issue": issue, "pull": pull, "comments": comments,
                          "timeline": [], "reviews": [], "review_comments": [], "commits": []}, users=[me])
if request.get("unlabelled"):
    with conn:
        conn.execute("UPDATE items SET expanded_json = json_remove(expanded_json, '$.issue.labels') "
                     "WHERE item_id = (SELECT min(item_id) FROM items WHERE item_type = 'issue')")
conn.close()

answers = []
for argv in request["argvs"]:
    out, err = io.StringIO(), io.StringIO()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            main(["--db", db, *argv])
        answers.append({"rows": json.loads(out.getvalue())})
    except (Exception, SystemExit) as exc:
        answers.append({"error": str(exc) or err.getvalue().strip()})
print(json.dumps(answers))
