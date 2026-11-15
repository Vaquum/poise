"""Native datastore fixture only; no GitHub or provider calls."""
import os
from datetime import UTC, datetime, timedelta

from github_datastore.db import add_user, connect, init_db, set_state, upsert_repo, upsert_expanded_item
from github_datastore import views

if os.environ.get("POISE_SKIP_CLI_BOOTSTRAP") != "1":
    raise RuntimeError("MCP fixture requires a disposable workspace")

now = datetime.now(UTC)
stamp = lambda value: value.isoformat().replace("+00:00", "Z")
repo = {"id": 10, "node_id": "R_fixture", "owner": {"login": "fixtures"}, "name": "Work", "full_name": "fixtures/Work",
        "private": True, "archived": False, "has_issues": True}
conn = connect("/home/poise/mcp-fixture.sqlite")
owner = os.environ["POISE_WORKSPACE_OWNER"]
try:
    init_db(conn)
    with conn:
        upsert_repo(conn, repo)
        add_user(conn, owner)
        add_user(conn, "review-bot")
        set_state(conn, "org", "login", "fixtures")
        set_state(conn, "org", "last_sync_at", stamp(now))
    for number in range(1, 6):
        upsert_expanded_item(conn, {"repo": repo, "is_pr": False,
            "issue": {"id": 100 + number, "node_id": f"I_fixture_{number}", "number": number, "state": "closed" if number in (3, 4) else "open",
                      "title": f"Fixture issue {number}", "body": "Fixture only; no configured account involvement.",
                      "user": {"login": "third-party"}, "assignees": [], "labels": [{"name": "poise"}],
                      "created_at": stamp(now - timedelta(minutes=1)), "updated_at": stamp(now), "closed_at": None},
            "pull": None, "comments": [], "timeline": [], "reviews": [], "review_comments": [], "commits": []})
    conn.commit()
finally:
    conn.close()

assert '"number": 1' in views.issue(db_path="/home/poise/mcp-fixture.sqlite", repo="fixtures/Work", label="poise", limit=2)
for account in (owner, "review-bot"):
    assert views.user(db_path="/home/poise/mcp-fixture.sqlite", username=account, item_type="issue") == "[]"
