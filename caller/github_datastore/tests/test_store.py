import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from github_datastore.db import (
    add_user,
    connect,
    get_state,
    init_db,
    prune_items_for_repo,
    set_state,
    upsert_repo,
)
from github_datastore.store import (
    apply_repo_filter,
    stored_pr_updated_at_by_id,
    store_expanded,
    sync_once,
    validate_repo_filter,
)


def base_expanded(body: str, comments: list[dict]) -> dict:
    return {
        "repo": {
            "id": 10,
            "node_id": "R_10",
            "owner": {"login": "Vaquum"},
            "name": "Test",
            "full_name": "Vaquum/Test",
            "private": False,
            "archived": False,
            "has_issues": True,
        },
        "is_pr": False,
        "issue": {
            "id": 100,
            "node_id": "I_100",
            "number": 1,
            "state": "open",
            "title": "Issue",
            "body": body,
            "user": {"login": "other"},
            "assignees": [],
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-02T00:00:00Z",
            "closed_at": None,
        },
        "pull": None,
        "comments": comments,
        "timeline": [],
        "reviews": [],
        "review_comments": [],
        "commits": [],
    }


def repo_row() -> dict:
    return {
        "id": 10,
        "node_id": "R_10",
        "owner": {"login": "Vaquum"},
        "name": "Test",
        "full_name": "Vaquum/Test",
        "private": False,
        "archived": False,
        "has_issues": True,
        "graphql": {},
    }


def initialize_sync_state(
    db_path: Path,
    watermark: str,
    include_repo: bool = True,
    complete: bool = True,
) -> None:
    conn = connect(db_path)
    try:
        init_db(conn)
        with conn:
            set_state(conn, "org", "login", "Vaquum")
            set_state(conn, "org", "last_sync_at", watermark)
            if complete:
                set_state(conn, "org", "full_build_markers_v1_initialized", "1")
            if include_repo:
                upsert_repo(conn, repo_row())
                if complete:
                    set_state(conn, "repo:10", "full_build_complete", "1")
    finally:
        conn.close()


class BatchReader:
    def fetch_initial_item_graphs(self, repo: dict, items: list[dict]) -> dict:
        return {item["number"]: item for item in items}

    def expand_item_graph(self, repo: dict, item: dict, node: dict) -> dict:
        if node != item:
            raise AssertionError("wrong prefetched item")
        return self.expand_issue_or_pr(repo, item)

    def list_repos_changed_items(
        self, full_names: list[str], since: str | None, stored: dict[str, dict[int, str]]
    ) -> dict[str, list[dict]]:
        return {name: self.list_repo_changed_items(name, since, stored[name]) for name in full_names}


class StoreTest(unittest.TestCase):
    def test_sync_routes_local_pr_snapshot_to_existing_repo_poller(self) -> None:
        previous_watermark = "2026-08-29T12:00:00Z"

        class RecordingReader(BatchReader):
            def __init__(self) -> None:
                self.calls: list[tuple[str, str | None, dict[int, str]]] = []

            def list_org_repos(self, org: str) -> list[dict]:
                self.org = org
                return [repo_row()]

            def list_repo_changed_items(
                self,
                full_name: str,
                since: str | None,
                stored: dict[int, str],
            ) -> list[dict]:
                self.calls.append((full_name, since, stored))
                return []

        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            initialize_sync_state(db_path, previous_watermark)
            reader = RecordingReader()
            with (
                patch("github_datastore.store.GitHubOrgReader", return_value=reader),
                patch(
                    "github_datastore.store.stored_pr_updated_at_by_id",
                    return_value={100: "2026-08-29T11:59:00Z"},
                ),
            ):
                sync_once(db_path, workers=1)

        self.assertEqual(reader.org, "Vaquum")
        self.assertEqual(
            reader.calls,
            [
                (
                    "Vaquum/Test",
                    previous_watermark,
                    {100: "2026-08-29T11:59:00Z"},
                )
            ],
        )

    def test_existing_repositories_are_polled_in_one_batch(self) -> None:
        previous_watermark = "2026-08-29T12:00:00Z"
        second_repo = dict(repo_row(), id=20, node_id="R_20", name="Second", full_name="Vaquum/Second")

        class RecordingReader:
            def __init__(self) -> None:
                self.calls: list[tuple] = []

            def list_org_repos(self, org: str) -> list[dict]:
                return [repo_row(), second_repo]

            def list_repos_changed_items(self, names: list[str], since: str, stored: dict) -> dict:
                self.calls.append((names, since, stored))
                return {name: [] for name in names}

        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            initialize_sync_state(db_path, previous_watermark)
            conn = connect(db_path)
            try:
                with conn:
                    upsert_repo(conn, second_repo)
                    set_state(conn, "repo:20", "full_build_complete", "1")
            finally:
                conn.close()
            reader = RecordingReader()
            with patch("github_datastore.store.GitHubOrgReader", return_value=reader):
                sync_once(db_path, workers=1)
            self.assertEqual(reader.calls, [(
                ["Vaquum/Test", "Vaquum/Second"], previous_watermark,
                {"Vaquum/Test": {}, "Vaquum/Second": {}},
            )])

    def test_missing_batch_repository_is_fatal_without_watermark_advancement(self) -> None:
        previous_watermark = "2026-08-29T12:00:00Z"
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            initialize_sync_state(db_path, previous_watermark)
            with patch("github_datastore.store.GitHubOrgReader") as reader:
                reader.return_value.list_org_repos.return_value = [repo_row()]
                reader.return_value.list_repos_changed_items.return_value = {}
                with self.assertRaisesRegex(RuntimeError, "does not cover"):
                    sync_once(db_path, workers=1)
            conn = connect(db_path)
            try:
                self.assertEqual(get_state(conn, "org", "last_sync_at"), previous_watermark)
            finally:
                conn.close()

    def test_failed_incremental_poll_does_not_advance_watermark(self) -> None:
        previous_watermark = "2026-08-29T12:00:00Z"

        class FailingReader(BatchReader):
            def list_org_repos(self, org: str) -> list[dict]:
                return [repo_row()]

            def list_repo_changed_items(
                self,
                full_name: str,
                since: str | None,
                stored: dict[int, str],
            ) -> list[dict]:
                raise RuntimeError("poll failed")

        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            initialize_sync_state(db_path, previous_watermark)
            with patch("github_datastore.store.GitHubOrgReader", return_value=FailingReader()):
                with self.assertRaisesRegex(RuntimeError, "poll failed"):
                    sync_once(db_path, workers=1)
            conn = connect(db_path)
            self.addCleanup(conn.close)
            self.assertEqual(get_state(conn, "org", "last_sync_at"), previous_watermark)

    def test_legacy_repo_requires_lightweight_full_proof(self) -> None:
        previous_watermark = "2026-08-29T12:00:00Z"
        stub = {
            "id": 100,
            "number": 1,
            "updated_at": "2026-01-02T00:00:00Z",
            "item_kind": "issue",
        }

        class ProofReader(BatchReader):
            def __init__(self) -> None:
                self.full_calls: list[str] = []

            def list_org_repos(self, org: str) -> list[dict]:
                return [repo_row()]

            def list_repo_issues(self, full_name: str) -> list[dict]:
                self.full_calls.append(full_name)
                return [stub]

            def list_repo_changed_items(self, *args: object) -> list[dict]:
                raise AssertionError("incremental path must not run")

            def expand_issue_or_pr(self, repo: dict, issue: dict) -> dict:
                raise AssertionError("unchanged proof item must not be downloaded")

        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            initialize_sync_state(
                db_path, previous_watermark, include_repo=True, complete=False
            )
            conn = connect(db_path)
            store_expanded(conn, base_expanded("body", []))
            conn.close()

            reader = ProofReader()
            with patch("github_datastore.store.GitHubOrgReader", return_value=reader):
                sync_once(db_path, workers=1)

            conn = connect(db_path)
            self.addCleanup(conn.close)
            self.assertEqual(get_state(conn, "repo:10", "full_build_complete"), "1")

        self.assertEqual(reader.full_calls, ["Vaquum/Test"])

    def test_new_repo_and_reconcile_use_full_enumeration(self) -> None:
        previous_watermark = "2026-08-29T12:00:00Z"

        class FullReader(BatchReader):
            def __init__(self) -> None:
                self.full_calls: list[str] = []

            def list_org_repos(self, org: str) -> list[dict]:
                return [repo_row()]

            def list_repo_issues(self, full_name: str) -> list[dict]:
                self.full_calls.append(full_name)
                return []

            def list_repo_changed_items(self, *args: object) -> list[dict]:
                raise AssertionError("incremental path must not run")

        cases = [(False, False), (True, True)]
        for include_repo, reconcile in cases:
            with self.subTest(include_repo=include_repo, reconcile=reconcile):
                with tempfile.TemporaryDirectory() as tmp:
                    db_path = Path(tmp) / "db.sqlite"
                    initialize_sync_state(db_path, previous_watermark, include_repo)
                    reader = FullReader()
                    with patch("github_datastore.store.GitHubOrgReader", return_value=reader):
                        sync_once(db_path, workers=1, reconcile=reconcile)
                    self.assertEqual(reader.full_calls, ["Vaquum/Test"])

    def test_failed_new_repo_full_build_is_retried_until_complete(self) -> None:
        previous_watermark = "2026-08-29T12:00:00Z"
        stub = {"id": 100, "number": 1, "item_kind": "issue"}

        class FullReader(BatchReader):
            def __init__(self, fail: bool) -> None:
                self.fail = fail
                self.full_calls: list[str] = []

            def list_org_repos(self, org: str) -> list[dict]:
                return [repo_row()]

            def list_repo_issues(self, full_name: str) -> list[dict]:
                self.full_calls.append(full_name)
                return [stub]

            def list_repo_changed_items(self, *args: object) -> list[dict]:
                raise AssertionError("incremental path must not run")

            def expand_issue_or_pr(self, repo: dict, issue: dict) -> dict:
                if self.fail:
                    raise RuntimeError("expansion failed")
                return base_expanded("body", [])

        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            initialize_sync_state(db_path, previous_watermark, include_repo=False)
            first = FullReader(fail=True)
            with patch("github_datastore.store.GitHubOrgReader", return_value=first):
                with self.assertRaisesRegex(RuntimeError, "expansion failed"):
                    sync_once(db_path, workers=1)
            failed_conn = connect(db_path)
            self.assertIsNone(get_state(failed_conn, "repo:10", "full_build_complete"))
            self.assertEqual(
                get_state(failed_conn, "org", "last_sync_at"), previous_watermark
            )
            failed_conn.close()

            second = FullReader(fail=False)
            with patch("github_datastore.store.GitHubOrgReader", return_value=second):
                sync_once(db_path, workers=1)

            conn = connect(db_path)
            self.addCleanup(conn.close)
            self.assertEqual(get_state(conn, "repo:10", "full_build_complete"), "1")
            self.assertNotEqual(get_state(conn, "org", "last_sync_at"), previous_watermark)

        self.assertEqual(first.full_calls, ["Vaquum/Test"])
        self.assertEqual(second.full_calls, ["Vaquum/Test"])

    def test_reenabled_issues_force_full_enumeration(self) -> None:
        previous_watermark = "2026-08-29T12:00:00Z"
        disabled_repo = dict(repo_row(), has_issues=False)

        class FullReader(BatchReader):
            def __init__(self) -> None:
                self.full_calls: list[str] = []

            def list_org_repos(self, org: str) -> list[dict]:
                return [repo_row()]

            def list_repo_issues(self, full_name: str) -> list[dict]:
                self.full_calls.append(full_name)
                return []

            def list_repo_changed_items(self, *args: object) -> list[dict]:
                raise AssertionError("incremental path must not run")

        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            initialize_sync_state(db_path, previous_watermark, include_repo=False)
            conn = connect(db_path)
            with conn:
                upsert_repo(conn, disabled_repo)
                set_state(conn, "repo:10", "full_build_complete", "1")
            conn.close()

            reader = FullReader()
            with patch("github_datastore.store.GitHubOrgReader", return_value=reader):
                sync_once(db_path, workers=1)

        self.assertEqual(reader.full_calls, ["Vaquum/Test"])

    def test_renamed_repo_full_build_failure_is_retried(self) -> None:
        previous_watermark = "2026-08-29T12:00:00Z"
        old_repo = dict(repo_row(), name="Old", full_name="Vaquum/Old")

        class RenameReader(BatchReader):
            def __init__(self, fail: bool) -> None:
                self.fail = fail
                self.full_calls: list[str] = []

            def list_org_repos(self, org: str) -> list[dict]:
                return [repo_row()]

            def list_repo_issues(self, full_name: str) -> list[dict]:
                self.full_calls.append(full_name)
                if self.fail:
                    raise RuntimeError("listing failed")
                return []

            def list_repo_changed_items(self, *args: object) -> list[dict]:
                raise AssertionError("incremental path must not run")

        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            initialize_sync_state(db_path, previous_watermark, include_repo=False)
            conn = connect(db_path)
            with conn:
                upsert_repo(conn, old_repo)
                set_state(conn, "repo:10", "full_build_complete", "1")
            conn.close()

            first = RenameReader(fail=True)
            with patch("github_datastore.store.GitHubOrgReader", return_value=first):
                with self.assertRaisesRegex(RuntimeError, "listing failed"):
                    sync_once(db_path, workers=1)

            second = RenameReader(fail=False)
            with patch("github_datastore.store.GitHubOrgReader", return_value=second):
                sync_once(db_path, workers=1)

        self.assertEqual(first.full_calls, ["Vaquum/Test"])
        self.assertEqual(second.full_calls, ["Vaquum/Test"])

    def test_failed_reconcile_clears_marker_and_forces_full_retry(self) -> None:
        previous_watermark = "2026-08-29T12:00:00Z"
        stub = {
            "id": 100,
            "number": 1,
            "updated_at": "2026-01-02T00:00:00Z",
            "item_kind": "issue",
        }

        class ReconcileReader(BatchReader):
            def __init__(self, fail: bool) -> None:
                self.fail = fail
                self.full_calls: list[str] = []
                self.expand_calls = 0

            def list_org_repos(self, org: str) -> list[dict]:
                return [repo_row()]

            def list_repo_issues(self, full_name: str) -> list[dict]:
                self.full_calls.append(full_name)
                return [stub]

            def list_repo_changed_items(self, *args: object) -> list[dict]:
                raise AssertionError("incremental path must not run")

            def expand_issue_or_pr(self, repo: dict, issue: dict) -> dict:
                self.expand_calls += 1
                if self.fail:
                    raise RuntimeError("reconcile expansion failed")
                return base_expanded("body", [])

        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            initialize_sync_state(db_path, previous_watermark)
            conn = connect(db_path)
            store_expanded(conn, base_expanded("body", []))
            conn.close()
            first = ReconcileReader(fail=True)
            with patch("github_datastore.store.GitHubOrgReader", return_value=first):
                with self.assertRaisesRegex(RuntimeError, "reconcile expansion failed"):
                    sync_once(db_path, workers=1, reconcile=True)

            conn = connect(db_path)
            self.assertIsNone(get_state(conn, "repo:10", "full_build_complete"))
            self.assertEqual(get_state(conn, "repo:10", "full_build_retry_required"), "1")
            conn.close()

            second = ReconcileReader(fail=False)
            with patch("github_datastore.store.GitHubOrgReader", return_value=second):
                sync_once(db_path, workers=1)

        self.assertEqual(first.full_calls, ["Vaquum/Test"])
        self.assertEqual(second.full_calls, ["Vaquum/Test"])
        self.assertEqual(second.expand_calls, 1)

    def test_stored_include_filter_survives_repo_rename(self) -> None:
        previous_watermark = "2026-08-29T12:00:00Z"
        old_repo = dict(repo_row(), name="Old", full_name="Vaquum/Old")

        class RenameReader(BatchReader):
            def __init__(self) -> None:
                self.full_calls: list[str] = []

            def list_org_repos(self, org: str) -> list[dict]:
                return [repo_row()]

            def list_repo_issues(self, full_name: str) -> list[dict]:
                self.full_calls.append(full_name)
                return []

            def list_repo_changed_items(self, *args: object) -> list[dict]:
                raise AssertionError("incremental path must not run")

        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            initialize_sync_state(db_path, previous_watermark, include_repo=False)
            conn = connect(db_path)
            with conn:
                upsert_repo(conn, old_repo)
                set_state(conn, "repo:10", "full_build_complete", "1")
                set_state(conn, "repo_filter", "mode", "include")
                set_state(conn, "repo_filter", "values", "old")
            conn.close()

            reader = RenameReader()
            with patch("github_datastore.store.GitHubOrgReader", return_value=reader):
                sync_once(db_path, workers=1)

            conn = connect(db_path)
            self.addCleanup(conn.close)
            self.assertEqual(get_state(conn, "repo_filter", "repo_ids"), "10")

        self.assertEqual(reader.full_calls, ["Vaquum/Test"])

    def test_reconcile_marks_later_repos_for_full_retry_before_work(self) -> None:
        previous_watermark = "2026-08-29T12:00:00Z"
        second_repo = dict(
            repo_row(),
            id=20,
            node_id="R_20",
            name="Second",
            full_name="Vaquum/Second",
        )

        class MultiRepoReader(BatchReader):
            def __init__(self, fail_first: bool) -> None:
                self.fail_first = fail_first
                self.full_calls: list[str] = []

            def list_org_repos(self, org: str) -> list[dict]:
                return [repo_row(), second_repo]

            def list_repo_issues(self, full_name: str) -> list[dict]:
                self.full_calls.append(full_name)
                if self.fail_first and full_name == "Vaquum/Test":
                    raise RuntimeError("first repo failed")
                return []

            def list_repo_changed_items(self, *args: object) -> list[dict]:
                raise AssertionError("pending repo must not run incrementally")

        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            initialize_sync_state(db_path, previous_watermark)
            conn = connect(db_path)
            with conn:
                upsert_repo(conn, second_repo)
                set_state(conn, "repo:20", "full_build_complete", "1")
            conn.close()

            first = MultiRepoReader(fail_first=True)
            with patch("github_datastore.store.GitHubOrgReader", return_value=first):
                with self.assertRaisesRegex(RuntimeError, "first repo failed"):
                    sync_once(db_path, workers=1, reconcile=True)

            conn = connect(db_path)
            self.assertEqual(get_state(conn, "repo:10", "full_build_retry_required"), "1")
            self.assertEqual(get_state(conn, "repo:20", "full_build_retry_required"), "1")
            conn.close()

            second = MultiRepoReader(fail_first=False)
            with patch("github_datastore.store.GitHubOrgReader", return_value=second):
                sync_once(db_path, workers=1)

        self.assertEqual(first.full_calls, ["Vaquum/Test"])
        self.assertEqual(second.full_calls, ["Vaquum/Test", "Vaquum/Second"])

    def test_later_renamed_repo_marker_is_cleared_before_earlier_failure(self) -> None:
        previous_watermark = "2026-08-29T12:00:00Z"
        old_repo = dict(
            repo_row(),
            id=20,
            node_id="R_20",
            name="Old",
            full_name="Vaquum/Old",
        )
        renamed_repo = dict(old_repo, name="Renamed", full_name="Vaquum/Renamed")

        class RenameAfterFailureReader(BatchReader):
            def __init__(self, fail_first: bool) -> None:
                self.fail_first = fail_first
                self.full_calls: list[str] = []
                self.incremental_calls: list[str] = []

            def list_org_repos(self, org: str) -> list[dict]:
                return [repo_row(), renamed_repo]

            def list_repo_issues(self, full_name: str) -> list[dict]:
                self.full_calls.append(full_name)
                return []

            def list_repo_changed_items(
                self, full_name: str, since: str | None, stored: dict[int, str]
            ) -> list[dict]:
                self.incremental_calls.append(full_name)
                if self.fail_first and full_name == "Vaquum/Test":
                    raise RuntimeError("earlier repo failed")
                return []

        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite"
            initialize_sync_state(db_path, previous_watermark)
            conn = connect(db_path)
            with conn:
                upsert_repo(conn, old_repo)
                set_state(conn, "repo:20", "full_build_complete", "1")
            conn.close()

            first = RenameAfterFailureReader(fail_first=True)
            with patch("github_datastore.store.GitHubOrgReader", return_value=first):
                with self.assertRaisesRegex(RuntimeError, "earlier repo failed"):
                    sync_once(db_path, workers=1)

            conn = connect(db_path)
            self.assertIsNone(get_state(conn, "repo:20", "full_build_complete"))
            conn.close()

            second = RenameAfterFailureReader(fail_first=False)
            with patch("github_datastore.store.GitHubOrgReader", return_value=second):
                sync_once(db_path, workers=1)

        self.assertEqual(second.incremental_calls, ["Vaquum/Test"])
        self.assertEqual(second.full_calls, ["Vaquum/Renamed"])

    def test_stored_pr_timestamps_come_from_local_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            conn = connect(Path(tmp) / "db.sqlite")
            self.addCleanup(conn.close)
            init_db(conn)
            expanded = base_expanded("body", [])
            expanded["is_pr"] = True
            expanded["issue"]["updated_at"] = "2026-08-29T12:01:00Z"
            expanded["issue"]["pull_request"] = {"node_id": "I_100"}
            expanded["pull"] = {
                "id": 100,
                "node_id": "I_100",
                "requested_reviewers": [],
                "assignees": [],
                "merged_by": None,
                "merged_at": None,
                "updated_at": "2026-08-29T12:01:00Z",
            }
            with conn:
                upsert_repo(conn, expanded["repo"])
            store_expanded(conn, expanded)

            self.assertEqual(
                stored_pr_updated_at_by_id(conn, 10),
                {100: "2026-08-29T12:01:00Z"},
            )

    def test_rebuild_replaces_associations_exactly(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            conn = connect(Path(tmp) / "db.sqlite")
            self.addCleanup(conn.close)
            init_db(conn)
            with conn:
                expanded = base_expanded("@mikkokotila", [])
                upsert_repo(conn, expanded["repo"])
                add_user(conn, "mikkokotila")

            item_id = store_expanded(conn, base_expanded("@mikkokotila", []))
            count = conn.execute(
                "SELECT count(*) AS n FROM associations WHERE item_id = ?", (item_id,)
            ).fetchone()["n"]
            self.assertEqual(count, 1)

            store_expanded(conn, base_expanded("no mention", []))
            count = conn.execute(
                "SELECT count(*) AS n FROM associations WHERE item_id = ?", (item_id,)
            ).fetchone()["n"]
            self.assertEqual(count, 0)

            store_expanded(
                conn,
                base_expanded(
                    "no mention",
                    [
                        {
                            "id": 200,
                            "node_id": "C_200",
                            "user": {"login": "mikkokotila"},
                            "body": "comment",
                            "created_at": "2026-01-03T00:00:00Z",
                            "updated_at": "2026-01-03T00:00:00Z",
                        }
                    ],
                ),
            )
            row = conn.execute(
                "SELECT association_type FROM associations WHERE item_id = ?", (item_id,)
            ).fetchone()
            self.assertEqual(row["association_type"], "commenter")

    def test_expanded_json_is_stored(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            conn = connect(Path(tmp) / "db.sqlite")
            self.addCleanup(conn.close)
            init_db(conn)
            expanded = base_expanded("body", [])
            with conn:
                upsert_repo(conn, expanded["repo"])
            item_id = store_expanded(conn, expanded)
            raw = conn.execute(
                "SELECT expanded_json FROM items WHERE item_id = ?", (item_id,)
            ).fetchone()["expanded_json"]
            self.assertEqual(json.loads(raw)["issue"]["number"], 1)

    def test_duplicate_idless_events_are_preserved_by_position(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            conn = connect(Path(tmp) / "db.sqlite")
            self.addCleanup(conn.close)
            init_db(conn)
            expanded = base_expanded("body", [])
            expanded["timeline"] = [
                {
                    "event": "cross-referenced",
                    "actor": {"login": "other"},
                    "created_at": "2026-01-03T00:00:00Z",
                    "_datastore_timeline_index": 0,
                },
                {
                    "event": "cross-referenced",
                    "actor": {"login": "other"},
                    "created_at": "2026-01-03T00:00:00Z",
                    "_datastore_timeline_index": 1,
                },
            ]
            with conn:
                upsert_repo(conn, expanded["repo"])
            item_id = store_expanded(conn, expanded)
            count = conn.execute(
                "SELECT count(*) AS n FROM events WHERE item_id = ?", (item_id,)
            ).fetchone()["n"]
            self.assertEqual(count, 2)

    def test_same_event_key_can_exist_on_different_items(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            conn = connect(Path(tmp) / "db.sqlite")
            self.addCleanup(conn.close)
            init_db(conn)
            expanded_one = base_expanded("one", [])
            expanded_two = base_expanded("two", [])
            expanded_two["issue"] = dict(expanded_two["issue"], id=101, node_id="I_101", number=2)
            shared = {
                "id": 300,
                "node_id": "E_300",
                "event": "cross-referenced",
                "actor": {"login": "other"},
                "created_at": "2026-01-03T00:00:00Z",
            }
            expanded_one["timeline"] = [shared]
            expanded_two["timeline"] = [shared]
            with conn:
                upsert_repo(conn, expanded_one["repo"])
            store_expanded(conn, expanded_one)
            store_expanded(conn, expanded_two)
            count = conn.execute("SELECT count(*) AS n FROM events").fetchone()["n"]
            self.assertEqual(count, 2)

    def test_prune_items_removes_stale_rows_and_fts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            conn = connect(Path(tmp) / "db.sqlite")
            self.addCleanup(conn.close)
            init_db(conn)
            one = base_expanded("first", [])
            two = base_expanded("second", [])
            two["issue"] = dict(two["issue"], id=101, node_id="I_101", number=2)
            with conn:
                upsert_repo(conn, one["repo"])
            keep_id = store_expanded(conn, one)
            drop_id = store_expanded(conn, two)
            with conn:
                prune_items_for_repo(conn, 10, [keep_id])
            item_ids = [
                row["item_id"] for row in conn.execute("SELECT item_id FROM items ORDER BY item_id")
            ]
            self.assertEqual(item_ids, [keep_id])
            fts_ids = [
                row["item_id"] for row in conn.execute("SELECT item_id FROM item_fts ORDER BY item_id")
            ]
            self.assertEqual(fts_ids, [keep_id])
            self.assertNotEqual(keep_id, drop_id)

    def test_consumer_views_project_items(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            conn = connect(Path(tmp) / "db.sqlite")
            self.addCleanup(conn.close)
            init_db(conn)
            expanded = base_expanded("@mikkokotila", [])
            expanded["issue"]["assignees"] = [
                {"login": "owner-one", "avatar_url": "https://avatars.example/owner-one.png"}
            ]
            expanded["is_pr"] = True
            expanded["pull"] = {
                "id": 100,
                "node_id": "I_100",
                "requested_reviewers": [],
                "assignees": [
                    {"login": "owner-two", "avatar_url": "https://avatars.example/owner-two.png"}
                ],
                "merged_by": None,
                "updated_at": "2026-01-02T00:00:00Z",
            }
            expanded["issue"]["pull_request"] = {"node_id": "I_100"}
            with conn:
                upsert_repo(conn, expanded["repo"])
                add_user(conn, "mikkokotila")
            item_id = store_expanded(conn, expanded)
            pr = conn.execute(
                "SELECT pr_ref, repo, number, payload_ref, owner_login, owner_avatar FROM prs"
            ).fetchone()
            self.assertEqual(
                dict(pr),
                {
                    "pr_ref": item_id,
                    "repo": "Vaquum/Test",
                    "number": 1,
                    "payload_ref": item_id,
                    "owner_login": "owner-two",
                    "owner_avatar": "https://avatars.example/owner-two.png",
                },
            )
            user_item = conn.execute(
                "SELECT username, item_type, item_ref, repo, evidence_count, owner_login, owner_avatar FROM user_items"
            ).fetchone()
            self.assertEqual(user_item["username"], "mikkokotila")
            self.assertEqual(user_item["item_type"], "pr")
            self.assertEqual(user_item["item_ref"], item_id)
            self.assertEqual(user_item["owner_login"], "owner-two")
            self.assertEqual(user_item["owner_avatar"], "https://avatars.example/owner-two.png")

    def test_repo_include_exclude_filters(self) -> None:
        repos = [
            {"name": "Limen", "full_name": "Vaquum/Limen"},
            {"name": "Nexus", "full_name": "Vaquum/Nexus"},
        ]
        self.assertEqual(
            [repo["name"] for repo in apply_repo_filter(repos, ["limen"], None)],
            ["Limen"],
        )
        self.assertEqual(
            [repo["name"] for repo in apply_repo_filter(repos, None, ["vaquum/limen"])],
            ["Nexus"],
        )
        with self.assertRaises(ValueError):
            validate_repo_filter(["limen"], ["nexus"])
        with self.assertRaises(RuntimeError):
            apply_repo_filter(repos, ["missing"], None)


if __name__ == "__main__":
    unittest.main()
