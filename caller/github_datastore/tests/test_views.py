import csv
import io
import json
import tempfile
import unittest
from pathlib import Path

from github_datastore import views
from github_datastore.db import add_user, connect, init_db, upsert_repo
from github_datastore.store import store_expanded
from tests.test_store import base_expanded


class ViewsTest(unittest.TestCase):
    def test_pr_issue_and_user_views_return_json_or_csv(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            issue = base_expanded("@mikkokotila", [])
            issue["issue"]["assignees"] = [
                {"login": "issue-owner", "avatar_url": "https://avatars.example/issue-owner.png"}
            ]
            pr = base_expanded("@mikkokotila", [])
            pr["is_pr"] = True
            pr["issue"] = dict(pr["issue"], id=101, node_id="I_101", number=2)
            pr["pull"] = {
                "id": 101,
                "node_id": "I_101",
                "graphql": {"isDraft": True},
                "requested_reviewers": [],
                "assignees": [
                    {"login": "pr-owner", "avatar_url": "https://avatars.example/pr-owner.png"}
                ],
                "merged_by": None,
                "updated_at": "2026-01-02T00:00:00Z",
            }
            pr["issue"]["pull_request"] = {"node_id": "I_101"}
            with conn:
                upsert_repo(conn, issue["repo"])
                add_user(conn, "mikkokotila")
            store_expanded(conn, issue)
            store_expanded(conn, pr)
            conn.close()

            pr_rows = json.loads(views.pr(db_path=db_path, status="open", limit=1))
            self.assertEqual(pr_rows[0]["number"], 2)
            self.assertEqual(pr_rows[0]["payload_ref"], 101)
            self.assertEqual(pr_rows[0]["draft"], 1)
            self.assertEqual(pr_rows[0]["owner_login"], "pr-owner")
            self.assertEqual(pr_rows[0]["owner_avatar"], "https://avatars.example/pr-owner.png")

            csv_text = views.issue(
                db_path=db_path,
                author="other",
                created_at_datetime="2026-01-01T00:00:00Z",
                output="csv",
            )
            csv_rows = list(csv.DictReader(io.StringIO(csv_text)))
            self.assertEqual(csv_rows[0]["issue_ref"], "100")
            self.assertEqual(csv_rows[0]["owner_login"], "issue-owner")
            self.assertEqual(csv_rows[0]["owner_avatar"], "https://avatars.example/issue-owner.png")

            user_rows = json.loads(
                views.user(db_path=db_path, username="mikkokotila", item_type="pr")
            )
            self.assertEqual(user_rows[0]["item_ref"], 101)
            self.assertEqual(user_rows[0]["owner_login"], "pr-owner")
            self.assertEqual(user_rows[0]["owner_avatar"], "https://avatars.example/pr-owner.png")

    def test_views_fail_on_invalid_datetime(self) -> None:
        with self.assertRaises(ValueError):
            views.pr(updated_since_datetime="2026-01-01T00:00:00")


if __name__ == "__main__":
    unittest.main()
