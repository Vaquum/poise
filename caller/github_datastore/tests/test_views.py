import csv
import io
import json
import tempfile
import unittest
from pathlib import Path

from github_datastore import views
from github_datastore.db import VIEW_SCHEMA_VERSION, add_user, connect, init_db, upsert_repo
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

    def test_user_view_is_one_row_per_item_with_all_its_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            pr = base_expanded("@mikkokotila", [])
            pr["is_pr"] = True
            pr["issue"] = dict(pr["issue"], id=101, node_id="I_101", number=2)
            pr["pull"] = {
                "id": 101,
                "node_id": "I_101",
                "graphql": {"isDraft": False},
                "requested_reviewers": [],
                "assignees": [{"login": "pr-owner", "avatar_url": "https://avatars.example/pr-owner.png"}],
                "merged_by": None,
                "updated_at": "2026-01-02T00:00:00Z",
            }
            pr["issue"]["pull_request"] = {"node_id": "I_101"}
            with conn:
                upsert_repo(conn, pr["repo"])
                add_user(conn, "mikkokotila")
            store_expanded(conn, pr)
            with conn:
                conn.execute("DELETE FROM associations")
                evidence = [
                    ("mikkokotila", "reviewer", "review", "1"),
                    ("mikkokotila", "author", "issue", "101"),
                    ("mikkokotila", "commenter", "comment", "7"),
                    ("mikkokotila", "commenter", "comment", "8"),
                    ("someone-else", "author", "issue", "101"),
                ]
                conn.executemany(
                    "INSERT INTO associations(username, item_id, association_type, evidence_kind, evidence_id, evidence_field)"
                    " VALUES (?, 101, ?, ?, ?, 'body')",
                    evidence,
                )
            conn.close()

            rows = json.loads(views.user(db_path=db_path, username="mikkokotila"))
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["item_ref"], 101)
            self.assertEqual(rows[0]["evidence_count"], 4)
            self.assertEqual(rows[0]["reasons"], "author,commenter,reviewer")
            self.assertEqual(rows[0]["owner_login"], "pr-owner")
            self.assertEqual(rows[0]["url"], "https://github.com/Vaquum/Test/pull/2")
            other = json.loads(views.user(db_path=db_path, username="someone-else"))
            self.assertEqual([(row["item_ref"], row["evidence_count"]) for row in other], [(101, 1)])

    def test_user_view_groups_evidence_before_joining_item_payloads(self) -> None:
        # Grouping the joined rows sorted every evidence row with its item's
        # whole payload: 30 000 evidence rows of a busy user took minutes and
        # gigabytes of temporary space. The evidence is grouped by its own key.
        with tempfile.TemporaryDirectory() as tmp:
            conn = connect(Path(tmp) / "db.sqlite")
            init_db(conn)
            plan = [
                str(row[3])
                for row in conn.execute(
                    "EXPLAIN QUERY PLAN SELECT * FROM user_items WHERE username = ? AND item_type = ? "
                    "ORDER BY updated_at DESC, repo ASC, number ASC LIMIT 201",
                    ("mikkokotila", "pr"),
                )
            ]
            conn.close()
            self.assertNotIn("USE TEMP B-TREE FOR GROUP BY", plan)
            self.assertTrue(any("SEARCH associations USING COVERING INDEX" in step for step in plan), plan)

    def test_existing_databases_get_the_current_views(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            conn.execute("DROP VIEW user_items")
            conn.execute("CREATE VIEW user_items AS SELECT 'stale' AS username")
            conn.execute("PRAGMA user_version = 1")
            conn.commit()
            init_db(conn)
            self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], VIEW_SCHEMA_VERSION)
            columns = [column[0] for column in conn.execute("SELECT * FROM user_items LIMIT 0").description]
            conn.close()
            self.assertIn("evidence_count", columns)

    def test_views_fail_on_invalid_datetime(self) -> None:
        with self.assertRaises(ValueError):
            views.pr(updated_since_datetime="2026-01-01T00:00:00")


if __name__ == "__main__":
    unittest.main()
