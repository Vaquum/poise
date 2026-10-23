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

    def test_pr_view_shows_the_size_github_reported_and_null_when_never_read(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            sized = base_expanded("@mikkokotila", [])
            sized["is_pr"] = True
            sized["issue"] = dict(sized["issue"], id=101, node_id="I_101", number=2)
            sized["pull"] = {
                "id": 101,
                "node_id": "I_101",
                "graphql": {"isDraft": False, "additions": 120, "deletions": 0},
                "requested_reviewers": [],
                "assignees": [],
                "merged_by": None,
                "updated_at": "2026-01-02T00:00:00Z",
            }
            sized["issue"]["pull_request"] = {"node_id": "I_101"}
            # Stored before the query asked for a size.
            unsized = base_expanded("@mikkokotila", [])
            unsized["is_pr"] = True
            unsized["issue"] = dict(unsized["issue"], id=102, node_id="I_102", number=3)
            unsized["pull"] = dict(sized["pull"], id=102, node_id="I_102", graphql={"isDraft": False})
            unsized["issue"]["pull_request"] = {"node_id": "I_102"}
            with conn:
                upsert_repo(conn, sized["repo"])
            store_expanded(conn, sized)
            store_expanded(conn, unsized)
            conn.close()

            rows = {row["number"]: row for row in json.loads(views.pr(db_path=db_path))}
            self.assertEqual((rows[2]["additions"], rows[2]["deletions"]), (120, 0))
            self.assertEqual((rows[3]["additions"], rows[3]["deletions"]), (None, None))

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

    def test_a_version_2_database_gets_pull_request_sizes(self) -> None:
        # A version-2 database has every view name, so only the version
        # number tells init_db that its prs view lacks the size columns.
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            conn.execute("DROP VIEW prs")
            conn.execute("CREATE VIEW prs AS SELECT item_id AS pr_ref FROM items WHERE item_type = 'pr'")
            conn.execute("PRAGMA user_version = 2")
            conn.commit()
            init_db(conn)
            pr_columns = [column[0] for column in conn.execute("SELECT * FROM prs LIMIT 0").description]
            conn.close()
            self.assertIn("additions", pr_columns)
            self.assertIn("deletions", pr_columns)

    def test_views_fail_on_invalid_datetime(self) -> None:
        with self.assertRaises(ValueError):
            views.pr(updated_since_datetime="2026-01-01T00:00:00")

    def test_pr_reviews_returns_reviews_and_threads_for_one_pr(self) -> None:
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
                "assignees": [],
                "merged_by": None,
                "updated_at": "2026-01-02T00:00:00Z",
            }
            pr["issue"]["pull_request"] = {"node_id": "I_101"}
            pr["reviews"] = [
                {"id": 11, "node_id": "R_11", "user": {"login": "reviewer"},
                 "state": "CHANGES_REQUESTED", "body": "fix this", "commit_id": "a" * 40,
                 "submitted_at": "2026-01-02T00:00:00Z"},
            ]
            pr["review_comments"] = [
                {"id": 21, "node_id": "C_21", "user": {"login": "reviewer"}, "body": "here",
                 "path": "a.ts", "position": None, "created_at": "2026-01-02T00:00:00Z",
                 "updated_at": "2026-01-02T00:00:00Z", "thread_node_id": "T_1",
                 "thread_resolved": False, "thread_outdated": False},
                {"id": 22, "node_id": "C_22", "user": {"login": "fixture-agent"}, "body": "done",
                 "path": "a.ts", "position": None, "created_at": "2026-01-03T00:00:00Z",
                 "updated_at": "2026-01-03T00:00:00Z", "thread_node_id": "T_1",
                 "thread_resolved": False, "thread_outdated": True},
            ]
            with conn:
                upsert_repo(conn, pr["repo"])
            store_expanded(conn, pr)
            conn.close()

            found = json.loads(views.pr_reviews(db_path=db_path, repo="vaquum/test", number=2))
            self.assertTrue(found["found"])
            self.assertFalse(found["truncated"])
            self.assertEqual(
                found["reviews"],
                [{"node_id": "R_11", "author": "reviewer", "state": "CHANGES_REQUESTED",
                  "submitted_at": "2026-01-02T00:00:00Z"}],
            )
            self.assertEqual(len(found["threads"]), 1)
            self.assertEqual(found["threads"][0]["thread_node_id"], "T_1")
            self.assertEqual(found["threads"][0]["resolved"], False)
            self.assertEqual([comment["node_id"] for comment in found["threads"][0]["comments"]],
                             ["C_21", "C_22"])

            missing = json.loads(views.pr_reviews(db_path=db_path, repo="vaquum/test", number=9))
            self.assertFalse(missing["found"])
            self.assertEqual((missing["reviews"], missing["threads"]), ([], []))

    def test_pr_reviews_pages_beyond_caps_and_revisits_older_thread_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            pr = base_expanded("@mikkokotila", [])
            pr["is_pr"] = True
            pr["issue"] = dict(pr["issue"], id=101, node_id="I_101", number=2)
            pr["pull"] = {"id": 101, "node_id": "I_101", "graphql": {"isDraft": False},
                          "requested_reviewers": [], "assignees": [], "merged_by": None,
                          "updated_at": "2026-01-02T00:00:00Z"}
            pr["issue"]["pull_request"] = {"node_id": "I_101"}
            with conn:
                upsert_repo(conn, pr["repo"])
            store_expanded(conn, pr)
            with conn:
                conn.executemany(
                    """INSERT INTO reviews(review_id, node_id, item_id, author_login, state, raw_json)
                       VALUES (?, ?, 101, 'shared-account', ?, '{}')""",
                    [(i, f"R_{i}", "CHANGES_REQUESTED" if i == 205 else "APPROVED") for i in range(1, 206)],
                )
                conn.executemany(
                    """INSERT INTO review_comments(comment_id, node_id, item_id, author_login,
                       thread_node_id, thread_resolved, thread_outdated, created_at, updated_at, raw_json)
                       VALUES (?, ?, 101, 'shared-account', ?, ?, 0, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z', '{}')""",
                    [(i, f"C_{i}", f"T_{i:04}", int(i != 1005)) for i in range(1, 1006)],
                )
                # A long single thread contributes one bounded latest summary,
                # never 1000 comments that hide other thread identities.
                conn.executemany(
                    """INSERT INTO review_comments(comment_id, node_id, item_id, author_login,
                       thread_node_id, thread_resolved, thread_outdated, created_at, updated_at, raw_json)
                       VALUES (?, ?, 101, 'shared-account', 'T_0001', 1, 0, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z', '{}')""",
                    [(i, f"C_{i}") for i in range(2000, 3100)],
                )
            review_after, comment_after = 0, 0
            review_ids: list[str] = []
            thread_ids: list[str] = []
            for _ in range(11):
                page = json.loads(views.pr_reviews(db_path=db_path, repo="vaquum/test", number=2,
                                  review_after=review_after, comment_after=comment_after, page_size=200))
                self.assertLessEqual(len(page["reviews"]), 200)
                self.assertLessEqual(len(page["threads"]), 200)
                self.assertTrue(page["has_unresolved"])
                review_ids.extend(row["node_id"] for row in page["reviews"])
                thread_ids.extend(row["thread_node_id"] for row in page["threads"])
                self.assertTrue(all(len(row["comments"]) == 1 for row in page["threads"]))
                review_after = page["page"]["next_review_after"]
                comment_after = page["page"]["next_comment_after"]
            self.assertIn("R_205", review_ids)
            self.assertIn("T_1005", thread_ids)
            self.assertEqual(comment_after, 0)
            with conn:
                conn.execute("UPDATE review_comments SET thread_resolved = 0 WHERE thread_node_id = 'T_0001'")
                conn.execute("UPDATE reviews SET state = 'CHANGES_REQUESTED', body = 'edited' WHERE review_id = 1")
            revisited = json.loads(views.pr_reviews(db_path=db_path, repo="vaquum/test", number=2, page_size=200))
            self.assertEqual(revisited["reviews"][0]["state"], "CHANGES_REQUESTED")
            self.assertNotEqual(revisited["reviews"][0]["revision"], page["reviews"][0]["revision"])
            self.assertFalse(revisited["threads"][0]["resolved"])
            self.assertEqual(revisited["threads"][0]["comments"][0]["node_id"], "C_3099")
            conn.close()

    def test_pr_reviews_rejects_unbounded_or_invalid_page_requests(self) -> None:
        for kwargs in ({"page_size": 0}, {"page_size": 201}, {"review_after": -1}, {"comment_after": -1}):
            with self.assertRaises(ValueError):
                views.pr_reviews(repo="vaquum/test", number=2, **kwargs)

    def test_pr_view_matches_mixed_case_repos_case_insensitively(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            item = base_expanded("@mikkokotila", [])
            with conn:
                upsert_repo(conn, item["repo"])
            store_expanded(conn, item)
            conn.close()
            # Stored as Vaquum/Test, queried normalized: the row must be found.
            self.assertEqual(len(json.loads(views.issue(db_path=db_path, repo="vaquum/test"))), 1)

    def test_pre_thread_rows_migrate_with_unknown_resolution(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            conn.execute(
                """CREATE TABLE review_comments (
                    comment_id INTEGER PRIMARY KEY, node_id TEXT NOT NULL UNIQUE,
                    item_id INTEGER NOT NULL, author_login TEXT, body TEXT, path TEXT,
                    position INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    raw_json TEXT NOT NULL)"""
            )
            conn.execute(
                "INSERT INTO review_comments VALUES (21, 'C_21', 101, 'reviewer', 'here', 'a.ts', NULL, ?, ?, '{}')",
                ("2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z"),
            )
            conn.commit()
            init_db(conn)
            names = {row["name"] for row in conn.execute("PRAGMA table_info(review_comments)")}
            self.assertTrue({"thread_node_id", "thread_resolved", "thread_outdated"} <= names)
            row = conn.execute("SELECT thread_node_id, thread_resolved FROM review_comments").fetchone()
            self.assertEqual((row["thread_node_id"], row["thread_resolved"]), (None, None))
            conn.close()


if __name__ == "__main__":
    unittest.main()
