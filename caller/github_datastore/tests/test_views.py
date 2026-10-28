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
    def test_label_intake_refuses_legacy_missing_observations_instead_of_silently_omitting_work(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / 'db.sqlite'
            conn = connect(db_path); init_db(conn)
            issue = base_expanded('', [])
            del issue['issue']['labels']
            with conn:
                upsert_repo(conn, issue['repo'])
            store_expanded(conn, issue); conn.close()
            with self.assertRaisesRegex(RuntimeError, 'label evidence is incomplete'):
                views.issue(db_path=db_path, label='poise')

    def test_label_intake_includes_old_issues_and_drains_stable_pages(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            original = base_expanded("@mikkokotila", [])
            with conn:
                upsert_repo(conn, original["repo"])
            for number in range(1, 6):
                issue = base_expanded("@mikkokotila", [])
                issue["issue"] = dict(issue["issue"], id=100 + number, node_id=f"I_{number}", number=number,
                                      labels=[{"name": "Poise"}] if number != 3 else [])
                store_expanded(conn, issue)
            conn.close()
            first = json.loads(views.issue(db_path=db_path, label="poise", after_repo="", after_number=0, limit=2))
            self.assertEqual([row["number"] for row in first], [1, 2])
            second = json.loads(views.issue(db_path=db_path, label="poise", after_repo=first[-1]["repo"], after_number=2, limit=2))
            self.assertEqual([row["number"] for row in second], [4, 5])
            self.assertEqual(len(json.loads(views.issue(db_path=db_path, label="poise"))), 4)

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
            root_before = revisited["comments"][0]["revision"]
            latest_before = revisited["threads"][0]["comments"][0]["revision"]
            with conn:
                conn.execute("UPDATE review_comments SET body = 'edited root after a reply' WHERE comment_id = 1")
            edited = json.loads(views.pr_reviews(db_path=db_path, repo="vaquum/test", number=2, page_size=200))
            self.assertEqual(edited["comments"][0]["id"], "C_1")
            self.assertNotEqual(edited["comments"][0]["revision"], root_before)
            self.assertEqual(edited["threads"][0]["comments"][0]["revision"], latest_before)
            # A pre-migration database is unavailable, never a fallback to
            # scanning an unbounded thread history for every bounded row.
            with conn:
                conn.execute("DROP INDEX idx_review_threads_page")
            with self.assertRaisesRegex(RuntimeError, "idx_review_threads_page"):
                views.pr_reviews(db_path=db_path, repo="vaquum/test", number=2, page_size=200)
            init_db(conn)
            self.assertTrue(json.loads(views.pr_reviews(db_path=db_path, repo="vaquum/test", number=2, page_size=200))["found"])
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


def dependent_fixture(number, item_id, body, state="open", blocked_by=(), title=None):
    item = base_expanded(body, [])
    item["issue"] = dict(item["issue"], id=item_id, node_id=f"I_{item_id}", number=number,
                         state=state, title=title or f"Issue {number}")
    if blocked_by is not None:
        item["issue"]["graphql"] = {"blockedBy": {"pageInfo": {"hasNextPage": False}, "nodes": [
            {"number": n, "repository": {"nameWithOwner": "Vaquum/Test"}} for n in blocked_by]}}
    return item


def closing_pr_fixture(number, item_id, body, closing=(), state="merged", title=None, head=None, head_repo=None):
    pr = base_expanded(body, [])
    pr["is_pr"] = True
    pr["issue"] = dict(pr["issue"], id=item_id, node_id=f"I_{item_id}", number=number, state=state,
                       title=title or f"PR {number}")
    graphql = {} if closing is None else {
        "closingIssuesReferences": {"pageInfo": {"hasNextPage": False}, "nodes": [
            {"number": n, "title": f"Issue {n}", "repository": {"nameWithOwner": "Vaquum/Test"}}
            for n in closing]}}
    if head is not None:
        graphql["headRefName"] = head
    if head_repo is not None:
        graphql["headRepository"] = {"nameWithOwner": head_repo}
    pr["pull"] = {"id": item_id, "node_id": f"I_{item_id}", "graphql": graphql,
                  "requested_reviewers": [], "assignees": [], "merged_by": None,
                  "updated_at": "2026-01-02T00:00:00Z"}
    pr["issue"]["pull_request"] = {"node_id": f"I_{item_id}"}
    return pr


class PrDependentsTest(unittest.TestCase):
    def test_pr_dependents_returns_closed_and_dependents_listed_either_way(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            items = [
                closing_pr_fixture(12, 112, "Closes #7", closing=(7,)),
                dependent_fixture(7, 107, "the fix", state="closed"),
                dependent_fixture(9, 109, "waiting on the fix", blocked_by=(7,)),
                dependent_fixture(10, 110, "Depends on:\n- #7\nUnlocks:\n- none"),
                dependent_fixture(11, 111, "Depends on: #7", blocked_by=(7,)),
                dependent_fixture(13, 113, "Depends on:\n- #999"),
                dependent_fixture(14, 114, "Depends on: #7", state="closed"),
                dependent_fixture(15, 115, "Depends on:\n- Vaquum/Test#7"),
                dependent_fixture(16, 116, "nothing to do with it", blocked_by=None),
            ]
            with conn:
                upsert_repo(conn, items[0]["repo"])
            for item in items:
                store_expanded(conn, item)
            conn.close()

            found = json.loads(views.pr_dependents(db_path=db_path, repo="vaquum/test", number=12))
            self.assertTrue(found["found"])
            self.assertEqual(found["title"], "PR 12")
            self.assertEqual(found["closes_via"], "closing-references")
            self.assertFalse(found["truncated"])
            self.assertEqual(found["closed"], [{
                "repo": "Vaquum/Test", "number": 7, "title": "Issue 7",
                "url": "https://github.com/Vaquum/Test/issues/7", "state": "closed"}])
            self.assertEqual(
                [(entry["number"], entry["via"]) for entry in found["dependents"]],
                [(9, ["blocked-by"]), (10, ["depends-on"]), (11, ["blocked-by", "depends-on"]),
                 (15, ["depends-on"])],
            )
            self.assertEqual(found["dependents"][0]["url"], "https://github.com/Vaquum/Test/issues/9")

            missing = json.loads(views.pr_dependents(db_path=db_path, repo="vaquum/test", number=99))
            self.assertFalse(missing["found"])
            self.assertEqual((missing["closed"], missing["dependents"]), ([], []))

    def test_pr_dependents_falls_back_to_closing_keywords_without_tracked_references(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            pr = closing_pr_fixture(12, 112, "Fixes #7", closing=None)
            with conn:
                upsert_repo(conn, pr["repo"])
            store_expanded(conn, pr)
            store_expanded(conn, dependent_fixture(7, 107, "the fix", state="closed"))
            store_expanded(conn, dependent_fixture(9, 109, "waiting on the fix", blocked_by=(7,)))
            conn.close()

            found = json.loads(views.pr_dependents(db_path=db_path, repo="vaquum/test", number=12))
            self.assertTrue(found["found"])
            self.assertEqual(found["closes_via"], "body-keywords")
            self.assertFalse(found["truncated"])
            self.assertEqual([entry["number"] for entry in found["closed"]], [7])
            self.assertEqual([entry["number"] for entry in found["dependents"]], [9])

    def test_pr_dependents_marks_truncated_lists(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            pr = closing_pr_fixture(12, 5000, "Closes #7", closing=(7,))
            with conn:
                upsert_repo(conn, pr["repo"])
            store_expanded(conn, pr)
            store_expanded(conn, dependent_fixture(7, 5001, "the fix", state="closed"))
            for offset in range(51):
                store_expanded(conn, dependent_fixture(100 + offset, 5100 + offset, "Depends on: #7"))
            conn.close()

            found = json.loads(views.pr_dependents(db_path=db_path, repo="vaquum/test", number=12))
            self.assertTrue(found["truncated"])
            self.assertEqual(len(found["dependents"]), 50)
            self.assertEqual(found["dependents"][0]["number"], 100)

    def test_pr_dependents_caps_untracked_closing_keywords(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            body = "\n".join(f"Closes #{number}" for number in range(1, 102))
            pr = closing_pr_fixture(12, 112, body, closing=None)
            with conn:
                upsert_repo(conn, pr["repo"])
            store_expanded(conn, pr)
            conn.close()

            found = json.loads(views.pr_dependents(db_path=db_path, repo="vaquum/test", number=12))
            self.assertEqual(found["closes_via"], "body-keywords")
            self.assertTrue(found["truncated"])
            self.assertEqual(len(found["closed"]), 100)
            self.assertEqual(found["closed"][0]["number"], 1)

    def test_pr_dependents_rejects_non_json_or_unscoped_reads(self) -> None:
        with self.assertRaises(ValueError):
            views.pr_dependents(repo="vaquum/test", number=2, output="csv")
        with self.assertRaises(ValueError):
            views.pr_dependents(number=2)
        with self.assertRaises(ValueError):
            views.pr_dependents(repo="vaquum/test")

    def test_pr_dependents_serves_through_the_view_command(self) -> None:
        from contextlib import redirect_stdout

        from github_datastore import cli

        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            pr = closing_pr_fixture(12, 112, "Closes #7", closing=(7,))
            with conn:
                upsert_repo(conn, pr["repo"])
            store_expanded(conn, pr)
            conn.close()
            output = io.StringIO()
            with redirect_stdout(output):
                cli.main(["--db", str(db_path), "view", "pr-dependents",
                          "--repo", "vaquum/test", "--number", "12"])
            found = json.loads(output.getvalue())
            self.assertTrue(found["found"])
            self.assertEqual([entry["number"] for entry in found["closed"]], [7])


class DependsOnParserTest(unittest.TestCase):
    def test_depends_on_formats(self) -> None:
        self.assertEqual(views.parse_depends_on("Depends on:\n- #354\n- #355", "acme/app"),
                         {("acme/app", 354), ("acme/app", 355)})
        self.assertEqual(views.parse_depends_on("Depends on: #354, #355", "acme/app"),
                         {("acme/app", 354), ("acme/app", 355)})
        self.assertEqual(views.parse_depends_on("depends on:\n1. #354\n2) acme/app#355", "other/repo"),
                         {("other/repo", 354), ("acme/app", 355)})
        self.assertEqual(views.parse_depends_on(
            "Depends on:\n- https://github.com/acme/app/issues/354", "other/repo"),
            {("acme/app", 354)})
        self.assertEqual(views.parse_depends_on("Depends on:\n- none", "acme/app"), set())
        self.assertEqual(views.parse_depends_on(None, "acme/app"), set())
        self.assertEqual(views.parse_depends_on("", "acme/app"), set())

    def test_depends_on_stops_at_the_next_section(self) -> None:
        self.assertEqual(
            views.parse_depends_on("Depends on:\n- #354\nUnlocks:\n- #999", "acme/app"),
            {("acme/app", 354)})
        # A bare list without a header claims nothing.
        self.assertEqual(views.parse_depends_on("- #354\n- #355", "acme/app"), set())

    def test_closes_keywords(self) -> None:
        self.assertEqual(views.parse_closes("Closes #7", "acme/app"), {("acme/app", 7)})
        self.assertEqual(views.parse_closes("Fixes acme/app#7 and resolves #8", "other/repo"),
                         {("acme/app", 7), ("other/repo", 8)})
        self.assertEqual(views.parse_closes(
            "Closed https://github.com/acme/app/issues/7", "other/repo"), {("acme/app", 7)})
        self.assertEqual(views.parse_closes("no keywords here #7", "acme/app"), set())
        self.assertEqual(views.parse_closes(None, "acme/app"), set())


def pr_with_reviewers(number: int, item_id: int, reviewers: list[dict] | None) -> dict:
    pr = base_expanded("@mikkokotila", [])
    pr["is_pr"] = True
    pr["issue"] = dict(pr["issue"], id=item_id, node_id=f"I_{item_id}", number=number)
    pull: dict = {
        "id": item_id,
        "node_id": f"I_{item_id}",
        "graphql": {"isDraft": False},
        "assignees": [],
        "merged_by": None,
        "updated_at": "2026-01-02T00:00:00Z",
    }
    if reviewers is not None:
        pull["requested_reviewers"] = reviewers
    pr["pull"] = pull
    pr["issue"]["pull_request"] = {"node_id": f"I_{item_id}"}
    return pr


class RequestedReviewersTest(unittest.TestCase):
    def test_prs_view_returns_the_current_requested_reviewers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            current = pr_with_reviewers(2, 101, [{"login": "mikkokotila"}, {"login": "hubot"}])
            empty = pr_with_reviewers(3, 102, [])
            legacy = pr_with_reviewers(4, 103, None)
            with conn:
                upsert_repo(conn, current["repo"])
            store_expanded(conn, current)
            store_expanded(conn, empty)
            store_expanded(conn, legacy)
            conn.close()

            rows = {row["number"]: row for row in json.loads(views.pr(db_path=db_path))}
            self.assertEqual(json.loads(rows[2]["requested_reviewers"]), ["mikkokotila", "hubot"])
            self.assertEqual(json.loads(rows[3]["requested_reviewers"]), [])
            self.assertIsNone(rows[4]["requested_reviewers"])

    def test_user_view_carries_reviewers_and_null_for_issues(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            pr = pr_with_reviewers(2, 101, [{"login": "mikkokotila"}])
            issue = base_expanded("@mikkokotila", [])
            with conn:
                upsert_repo(conn, pr["repo"])
                add_user(conn, "mikkokotila")
            store_expanded(conn, pr)
            store_expanded(conn, issue)
            conn.close()

            rows = {(row["item_type"], row["number"]): row
                    for row in json.loads(views.user(db_path=db_path, username="mikkokotila"))}
            self.assertEqual(json.loads(rows[("pr", 2)]["requested_reviewers"]), ["mikkokotila"])
            self.assertIsNone(rows[("issue", 1)]["requested_reviewers"])

    def test_a_review_request_alone_is_an_involvement(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            pr = pr_with_reviewers(2, 101, [{"login": "mikkokotila"}])
            pr["issue"] = dict(pr["issue"], title="Someone else's work", body="no mention here")
            with conn:
                upsert_repo(conn, pr["repo"])
                add_user(conn, "mikkokotila")
            store_expanded(conn, pr)
            conn.close()

            rows = json.loads(views.user(db_path=db_path, username="mikkokotila", item_type="pr"))
            self.assertEqual(len(rows), 1)
            self.assertIn("review_requested", rows[0]["reasons"].split(","))
            self.assertEqual(json.loads(rows[0]["requested_reviewers"]), ["mikkokotila"])

    def test_a_removed_request_leaves_only_its_timeline_trace_outside_the_projection(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            pr = pr_with_reviewers(2, 101, [])
            pr["timeline"] = [{
                "id": 400, "node_id": "E_400", "event": "review_requested",
                "actor": {"login": "other"}, "requested_reviewer": {"login": "mikkokotila"},
                "created_at": "2026-01-04T00:00:00Z",
            }]
            with conn:
                upsert_repo(conn, pr["repo"])
                add_user(conn, "mikkokotila")
            store_expanded(conn, pr)
            conn.close()

            rows = json.loads(views.user(db_path=db_path, username="mikkokotila", item_type="pr"))
            self.assertEqual(len(rows), 1)
            self.assertIn("event_requested_reviewer:review_requested", rows[0]["reasons"].split(","))
            self.assertEqual(json.loads(rows[0]["requested_reviewers"]), [])

    def test_a_version_3_database_gets_requested_reviewers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            conn.execute("DROP VIEW prs")
            conn.execute("CREATE VIEW prs AS SELECT item_id AS pr_ref FROM items WHERE item_type = 'pr'")
            conn.execute("PRAGMA user_version = 3")
            conn.commit()
            init_db(conn)
            columns = [column[0] for column in conn.execute("SELECT * FROM prs LIMIT 0").description]
            user_columns = [column[0] for column in conn.execute("SELECT * FROM user_items LIMIT 0").description]
            conn.close()
            self.assertIn("requested_reviewers", columns)
            self.assertIn("requested_reviewers", user_columns)


class PrClosingTest(unittest.TestCase):
    def test_pr_closing_lists_open_prs_with_their_closing_refs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            items = [
                closing_pr_fixture(12, 112, "Closes #7", closing=(7,), state="open"),
                closing_pr_fixture(13, 113, "Fixes vaquum/other#3", closing=None, state="open"),
                closing_pr_fixture(14, 114, "no closing keyword", closing=None, state="open"),
                closing_pr_fixture(15, 115, "Closes #7", closing=(7,), state="merged"),
            ]
            with conn:
                upsert_repo(conn, items[0]["repo"])
            for item in items:
                store_expanded(conn, item)
            conn.close()

            listed = json.loads(views.pr_closing(db_path=db_path))
            self.assertFalse(listed["truncated"])
            self.assertEqual(
                [(entry["number"], entry["closes_via"]) for entry in listed["prs"]],
                [(12, "closing-references"), (13, "body-keywords"), (14, "body-keywords")],
            )
            self.assertEqual(listed["prs"][0]["closing"], [{"repo": "vaquum/test", "number": 7}])
            self.assertEqual(listed["prs"][0]["url"], "https://github.com/Vaquum/Test/pull/12")
            self.assertEqual(listed["prs"][1]["closing"], [{"repo": "vaquum/other", "number": 3}])
            self.assertEqual(listed["prs"][2]["closing"], [])

    def test_pr_closing_filters_by_repo_case_insensitively(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            first = closing_pr_fixture(12, 112, "Closes #7", closing=(7,), state="open")
            second = closing_pr_fixture(13, 113, "Closes #7", closing=(7,), state="open")
            second["repo"] = dict(second["repo"], id=11, node_id="R_11", name="Other", full_name="Vaquum/Other")
            with conn:
                upsert_repo(conn, first["repo"])
                upsert_repo(conn, second["repo"])
            store_expanded(conn, first)
            store_expanded(conn, second)
            conn.close()

            listed = json.loads(views.pr_closing(db_path=db_path, repo="vaquum/test"))
            self.assertEqual([entry["number"] for entry in listed["prs"]], [12])

    def test_pr_closing_marks_a_truncated_list(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            first = closing_pr_fixture(12, 112, "Closes #7", closing=(7,), state="open")
            with conn:
                upsert_repo(conn, first["repo"])
            store_expanded(conn, first)
            store_expanded(conn, closing_pr_fixture(13, 113, "Closes #8", closing=(8,), state="open"))
            conn.close()

            listed = json.loads(views.pr_closing(db_path=db_path, limit=1))
            self.assertTrue(listed["truncated"])
            self.assertEqual([entry["number"] for entry in listed["prs"]], [12])

    def test_pr_closing_rejects_csv_or_a_bad_limit(self) -> None:
        with self.assertRaises(ValueError):
            views.pr_closing(output="csv")
        with self.assertRaises(ValueError):
            views.pr_closing(limit=0)

    def test_pr_closing_marks_a_capped_closing_list(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            body = "\n".join(f"Closes #{number}" for number in range(1, 102))
            pr = closing_pr_fixture(12, 112, body, closing=None, state="open")
            with conn:
                upsert_repo(conn, pr["repo"])
            store_expanded(conn, pr)
            store_expanded(conn, closing_pr_fixture(13, 113, "Closes #7", closing=(7,), state="open"))
            conn.close()

            listed = json.loads(views.pr_closing(db_path=db_path))
            self.assertTrue(listed["truncated"])
            self.assertFalse(listed["more"])
            self.assertEqual(len(listed["prs"][0]["closing"]), 100)
            self.assertTrue(listed["prs"][0]["closing_truncated"])
            self.assertFalse(listed["prs"][1]["closing_truncated"])

    def test_pr_closing_pages_one_repo_by_number(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            first = closing_pr_fixture(12, 112, "Closes #7", closing=(7,), state="open")
            with conn:
                upsert_repo(conn, first["repo"])
            store_expanded(conn, first)
            store_expanded(conn, closing_pr_fixture(13, 113, "Closes #8", closing=(8,), state="open"))
            store_expanded(conn, closing_pr_fixture(14, 114, "Closes #9", closing=(9,), state="open"))
            conn.close()

            head = json.loads(views.pr_closing(db_path=db_path, repo="vaquum/test", limit=2))
            self.assertTrue(head["more"])
            self.assertEqual([entry["number"] for entry in head["prs"]], [12, 13])
            tail = json.loads(views.pr_closing(db_path=db_path, repo="vaquum/test", limit=2, after_number=13))
            self.assertFalse(tail["more"])
            self.assertEqual([entry["number"] for entry in tail["prs"]], [14])
            with self.assertRaises(ValueError):
                views.pr_closing(db_path=db_path, limit=2, after_number=13)
            with self.assertRaises(ValueError):
                views.pr_closing(db_path=db_path, repo="vaquum/test", after_number=0)

    def test_pr_closing_pages_an_unscoped_list_by_repo_and_number(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            first = closing_pr_fixture(12, 112, "Closes #7", closing=(7,), state="open")
            second = closing_pr_fixture(3, 113, "Closes #7", closing=(7,), state="open")
            second["repo"] = dict(second["repo"], id=11, node_id="R_11", name="Other", full_name="Vaquum/Other")
            with conn:
                upsert_repo(conn, first["repo"])
                upsert_repo(conn, second["repo"])
            store_expanded(conn, first)
            store_expanded(conn, second)
            store_expanded(conn, closing_pr_fixture(14, 114, "Closes #9", closing=(9,), state="open"))
            conn.close()

            head = json.loads(views.pr_closing(db_path=db_path, limit=1))
            self.assertTrue(head["more"])
            self.assertEqual([(entry["repo"], entry["number"]) for entry in head["prs"]], [("Vaquum/Other", 3)])
            middle = json.loads(views.pr_closing(db_path=db_path, limit=1, after_repo="Vaquum/Other", after_number=3))
            self.assertTrue(middle["more"])
            self.assertEqual([(entry["repo"], entry["number"]) for entry in middle["prs"]], [("Vaquum/Test", 12)])
            tail = json.loads(views.pr_closing(db_path=db_path, limit=1, after_repo="Vaquum/Test", after_number=12))
            self.assertFalse(tail["more"])
            self.assertEqual([(entry["repo"], entry["number"]) for entry in tail["prs"]], [("Vaquum/Test", 14)])
            with self.assertRaises(ValueError):
                views.pr_closing(db_path=db_path, after_repo="Vaquum/Other")
            with self.assertRaises(ValueError):
                views.pr_closing(db_path=db_path, repo="vaquum/test", after_repo="Vaquum/Other", after_number=3)

    def test_pr_closing_serves_through_the_view_command(self) -> None:
        from contextlib import redirect_stdout

        from github_datastore import cli

        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            pr = closing_pr_fixture(12, 112, "Closes #7", closing=(7,), state="open")
            with conn:
                upsert_repo(conn, pr["repo"])
            store_expanded(conn, pr)
            conn.close()
            output = io.StringIO()
            with redirect_stdout(output):
                cli.main(["--db", str(db_path), "view", "pr-closing", "--limit", "50"])
            listed = json.loads(output.getvalue())
            self.assertFalse(listed["truncated"])
            self.assertEqual([entry["number"] for entry in listed["prs"]], [12])

    def test_pr_closing_reports_head_ref_and_repo(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            same = closing_pr_fixture(12, 112, "Closes #7", closing=(7,), state="open",
                                      head="fix/7-test", head_repo="Vaquum/Test")
            fork = closing_pr_fixture(13, 113, "Closes #7", closing=(7,), state="open",
                                      head="fix/7-test", head_repo="Fork/Test")
            with conn:
                upsert_repo(conn, same["repo"])
            store_expanded(conn, same)
            store_expanded(conn, fork)
            conn.close()

            listed = json.loads(views.pr_closing(db_path=db_path))
            self.assertEqual(
                [(entry["number"], entry["head_ref"], entry["head_repo"]) for entry in listed["prs"]],
                [(12, "fix/7-test", "Vaquum/Test"), (13, "fix/7-test", "Fork/Test")],
            )

    def test_pr_closing_reports_null_head_for_old_rows(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            pr = closing_pr_fixture(12, 112, "Closes #7", closing=(7,), state="open")
            with conn:
                upsert_repo(conn, pr["repo"])
            store_expanded(conn, pr)
            conn.close()

            listed = json.loads(views.pr_closing(db_path=db_path))
            self.assertIsNone(listed["prs"][0]["head_ref"])
            self.assertIsNone(listed["prs"][0]["head_repo"])
            self.assertEqual(listed["prs"][0]["closing"], [{"repo": "vaquum/test", "number": 7}])

    def test_pr_closing_reports_null_head_for_malformed_values(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            conn = connect(db_path)
            init_db(conn)
            pr = closing_pr_fixture(12, 112, "Closes #7", closing=(7,), state="open")
            pr["pull"]["graphql"]["headRefName"] = 7
            pr["pull"]["graphql"]["headRepository"] = "Vaquum/Test"
            with conn:
                upsert_repo(conn, pr["repo"])
            store_expanded(conn, pr)
            conn.close()

            listed = json.loads(views.pr_closing(db_path=db_path))
            self.assertIsNone(listed["prs"][0]["head_ref"])
            self.assertIsNone(listed["prs"][0]["head_repo"])
            self.assertEqual(listed["prs"][0]["closing"], [{"repo": "vaquum/test", "number": 7}])


if __name__ == "__main__":
    unittest.main()
