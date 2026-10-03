import copy
import io
import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from github_datastore.cli import main
from github_datastore.db import connect, get_state, init_db, set_state, upsert_repo
from github_datastore.store import INITIALIZATION_KEY, init_org, iter_expanded, store_expanded, sync_once
from tests.test_store import base_expanded, repo_row


START = "2026-08-29T12:00:00Z"
CATCHUP = "2026-08-29T14:00:00Z"


def expansion(repo: dict, item_id: int, number: int, updated: str = "2026-01-02T00:00:00Z") -> dict:
    value = base_expanded("body", [])
    value["repo"] = copy.deepcopy(repo)
    value["issue"].update(id=item_id, node_id=f"I_{item_id}", number=number, updated_at=updated)
    return value


def stub(expanded: dict) -> dict:
    issue = expanded["issue"]
    return {"id": issue["id"], "number": issue["number"], "updated_at": issue["updated_at"], "item_kind": "issue"}


class InitializationReader:
    def __init__(self, repos: list[dict], items: dict[str, list[dict]]) -> None:
        self.repos = repos
        self.items = copy.deepcopy(items)
        self.expanded: list[int] = []
        self.listed: list[str] = []
        self.polls: list[tuple[list[str], str]] = []
        self.fail_item: int | None = None
        self.fail_catchup = False
        self.catchup_items: dict[str, list[dict]] = {}

    def list_org_repos(self, org: str) -> list[dict]:
        return self.repos

    def list_repo_issues(self, name: str) -> list[dict]:
        self.listed.append(name)
        return [stub(item) for item in self.items.get(name, [])]

    def list_repos_changed_items(self, names: list[str], since: str, stored: dict) -> dict:
        self.polls.append((names, since))
        if self.fail_catchup:
            raise RuntimeError("rate limit during catch-up")
        for name, items in self.catchup_items.items():
            by_id = {item["issue"]["id"]: item for item in self.items.get(name, [])}
            by_id.update({item["issue"]["id"]: item for item in items})
            self.items[name] = list(by_id.values())
        return {name: [stub(item) for item in self.catchup_items.get(name, [])] for name in names}

    def expand_issue_or_pr(self, repo: dict, item: dict) -> dict:
        self.expanded.append(item["id"])
        if item["id"] == self.fail_item:
            raise RuntimeError("rate limit during expansion")
        return copy.deepcopy(next(value for value in self.items[repo["full_name"]] if value["issue"]["id"] == item["id"]))


class InitializationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "db.sqlite"
        self.repo = repo_row()
        self.other_repo = dict(self.repo, id=20, node_id="R_20", name="Second", full_name="Vaquum/Second")

    def initialize(self, reader: InitializationReader, **kwargs: object) -> None:
        with patch("github_datastore.store.GitHubOrgReader", return_value=reader):
            init_org("Vaquum", self.path, workers=1, **kwargs)

    def reader(self, items: list[dict]) -> InitializationReader:
        return InitializationReader([self.repo], {self.repo["full_name"]: items})

    def state(self, key: str) -> str | None:
        conn = connect(self.path)
        try:
            return get_state(conn, "org", key)
        finally:
            conn.close()

    def item_ids(self) -> list[int]:
        conn = connect(self.path)
        try:
            return [row[0] for row in conn.execute("SELECT item_id FROM items ORDER BY item_id")]
        finally:
            conn.close()

    def partial(self, **kwargs: object) -> InitializationReader:
        reader = self.reader([expansion(self.repo, 100, 1), expansion(self.repo, 101, 2)])
        reader.fail_item = 101
        with self.assertRaisesRegex(RuntimeError, "rate limit"):
            self.initialize(reader, **kwargs)
        return reader

    def test_resume_preserves_completed_repos_and_items_after_quota_failure(self) -> None:
        items = {
            self.repo["full_name"]: [expansion(self.repo, 100, 1)],
            self.other_repo["full_name"]: [expansion(self.other_repo, 200, 1), expansion(self.other_repo, 201, 2)],
        }
        first = InitializationReader([self.repo, self.other_repo], items)
        first.fail_item = 201
        with patch("github_datastore.store.utc_now", return_value=START):
            with self.assertRaisesRegex(RuntimeError, "rate limit"):
                self.initialize(first, resume=True)
        self.assertEqual(self.item_ids(), [100, 200])
        self.assertIsNone(self.state("last_sync_at"))
        self.assertIsNone(self.state("last_full_build_at"))
        with self.assertRaisesRegex(RuntimeError, "initialization is incomplete"):
            sync_once(self.path, workers=1)

        second = InitializationReader([self.repo, self.other_repo], items)
        with patch("github_datastore.store.utc_now", return_value=CATCHUP):
            self.initialize(second, resume=True)
        self.assertEqual(second.expanded, [201])
        self.assertEqual(second.polls, [([self.repo["full_name"], self.other_repo["full_name"]], START)])
        self.assertEqual(self.item_ids(), [100, 200, 201])
        self.assertEqual(self.state("last_sync_at"), CATCHUP)
        self.assertEqual(json.loads(self.state(INITIALIZATION_KEY))["status"], "complete")

    def test_resume_refreshes_changes_prunes_deletions_and_adds_new_items(self) -> None:
        first = self.reader([expansion(self.repo, 100, 1), expansion(self.repo, 101, 2), expansion(self.repo, 102, 3)])
        first.fail_item = 102
        with self.assertRaisesRegex(RuntimeError, "rate limit"):
            self.initialize(first)
        self.assertEqual(self.item_ids(), [100, 101])
        second = self.reader([expansion(self.repo, 101, 2, START), expansion(self.repo, 102, 3), expansion(self.repo, 103, 4)])
        self.initialize(second, resume=True)
        self.assertEqual(second.expanded, [101, 102, 103])
        self.assertEqual(self.item_ids(), [101, 102, 103])
        conn = connect(self.path)
        try:
            self.assertEqual([row[0] for row in conn.execute("SELECT item_id FROM item_fts ORDER BY item_id")], [101, 102, 103])
        finally:
            conn.close()

    def test_resume_prunes_a_repository_removed_between_attempts(self) -> None:
        first = InitializationReader([self.repo, self.other_repo], {
            self.repo["full_name"]: [expansion(self.repo, 100, 1)],
            self.other_repo["full_name"]: [expansion(self.other_repo, 200, 1)],
        })
        first.fail_item = 200
        with self.assertRaisesRegex(RuntimeError, "rate limit"):
            self.initialize(first)
        second = InitializationReader([self.other_repo], {self.other_repo["full_name"]: [expansion(self.other_repo, 200, 1)]})
        self.initialize(second, resume=True)
        self.assertEqual(self.item_ids(), [200])

    def test_catchup_captures_changes_after_full_enumeration(self) -> None:
        reader = self.reader([expansion(self.repo, 100, 1)])
        reader.catchup_items = {self.repo["full_name"]: [expansion(self.repo, 100, 1, START), expansion(self.repo, 101, 2, START)]}
        with patch("github_datastore.store.utc_now", side_effect=[START, CATCHUP, CATCHUP]):
            self.initialize(reader)
        self.assertEqual(reader.expanded, [100, 100, 101])
        self.assertEqual(reader.polls, [([self.repo["full_name"]], START)])
        self.assertEqual(self.state("last_sync_at"), CATCHUP)

    def test_catchup_failure_keeps_initialization_incomplete_without_repeating_expansions(self) -> None:
        first = self.reader([expansion(self.repo, 100, 1)])
        first.fail_catchup = True
        with self.assertRaisesRegex(RuntimeError, "rate limit during catch-up"):
            self.initialize(first)
        self.assertIsNone(self.state("last_sync_at"))
        self.assertEqual(json.loads(self.state(INITIALIZATION_KEY))["status"], "building")
        second = self.reader([expansion(self.repo, 100, 1)])
        self.initialize(second, resume=True)
        self.assertEqual(second.expanded, [])
        self.assertIsNotNone(self.state("last_sync_at"))

    def test_explicit_fresh_init_still_rebuilds(self) -> None:
        self.partial()
        second = self.reader([expansion(self.repo, 100, 1)])
        self.initialize(second)
        self.assertEqual(second.expanded, [100])

    def test_legacy_partial_adoption_preserves_valid_expansions(self) -> None:
        conn = connect(self.path)
        try:
            init_db(conn)
            with conn:
                set_state(conn, "org", "login", "Vaquum")
                upsert_repo(conn, self.repo)
                set_state(conn, "repo:10", "full_build_complete", "1")
            store_expanded(conn, expansion(self.repo, 100, 1))
        finally:
            conn.close()
        reader = self.reader([expansion(self.repo, 100, 1), expansion(self.repo, 101, 2)])
        self.initialize(reader, resume=True)
        self.assertEqual(reader.expanded, [101])
        self.assertEqual(self.item_ids(), [100, 101])

    def test_resume_rejects_wrong_owner_before_network_or_mutation(self) -> None:
        self.partial()
        before = self.state(INITIALIZATION_KEY)
        with patch("github_datastore.store.GitHubOrgReader") as reader:
            with self.assertRaisesRegex(RuntimeError, "database belongs to"):
                init_org("Other", self.path, resume=True)
            reader.return_value.list_org_repos.assert_not_called()
        self.assertEqual(self.state(INITIALIZATION_KEY), before)
        self.assertEqual(self.item_ids(), [100])

    def test_resume_rejects_filter_change(self) -> None:
        self.partial(include_repos=["Test"])
        with self.assertRaisesRegex(RuntimeError, "different repo filter"):
            self.initialize(self.reader([]), resume=True)
        self.assertEqual(self.item_ids(), [100])

    def test_resume_preserves_equivalent_filter_spelling(self) -> None:
        self.partial(include_repos=["Test"])
        reader = self.reader([expansion(self.repo, 100, 1), expansion(self.repo, 101, 2)])
        self.initialize(reader, resume=True, include_repos=["test"])
        self.assertEqual(reader.expanded, [101])

    def filtered_partial(self, mode: str) -> None:
        reader = InitializationReader([self.repo, self.other_repo], {
            self.repo["full_name"]: [expansion(self.repo, 100, 1), expansion(self.repo, 101, 2)],
            self.other_repo["full_name"]: [expansion(self.other_repo, 200, 1)],
        })
        reader.fail_item = 101
        arguments = {"include_repos": ["test"]} if mode == "include" else {"exclude_repos": ["second"]}
        with self.assertRaisesRegex(RuntimeError, "rate limit"):
            self.initialize(reader, **arguments)

    def test_resume_rejects_tampered_ids_pointing_to_another_visible_repository(self) -> None:
        for mode, tampered_id in (("include", "20"), ("exclude", "10")):
            with self.subTest(mode=mode):
                self.filtered_partial(mode)
                before = self.state(INITIALIZATION_KEY)
                conn = connect(self.path)
                try:
                    with conn:
                        set_state(conn, "repo_filter", "repo_ids", tampered_id)
                finally:
                    conn.close()
                reader = InitializationReader([self.repo, self.other_repo], {})
                arguments = {"include_repos": ["test"]} if mode == "include" else {"exclude_repos": ["second"]}
                with self.assertRaisesRegex(RuntimeError, "ids do not match the checkpoint"):
                    self.initialize(reader, resume=True, **arguments)
                self.assertEqual(reader.listed, [])
                self.assertEqual(reader.expanded, [])
                self.assertEqual(self.item_ids(), [100])
                self.assertEqual(self.state(INITIALIZATION_KEY), before)
                self.assertIsNone(self.state("last_sync_at"))
                self.assertIsNone(self.state("last_full_build_at"))

    def test_resume_rejects_malformed_persisted_filter_ids(self) -> None:
        for value in ("", "10,10", "20,10", "010", "0", "-1", "ten", "10,", "10,,20"):
            with self.subTest(value=value):
                self.filtered_partial("include")
                before = self.state(INITIALIZATION_KEY)
                conn = connect(self.path)
                try:
                    with conn:
                        set_state(conn, "repo_filter", "repo_ids", value)
                finally:
                    conn.close()
                reader = InitializationReader([self.repo, self.other_repo], {})
                with self.assertRaisesRegex(RuntimeError, "invalid stored initialization repo ids"):
                    self.initialize(reader, resume=True, include_repos=["test"])
                self.assertEqual(reader.expanded, [])
                self.assertEqual(self.state(INITIALIZATION_KEY), before)
                self.assertEqual(self.item_ids(), [100])
                self.assertIsNone(self.state("last_sync_at"))

    def test_resume_rejects_malformed_or_mismatched_checkpoint_ids(self) -> None:
        for value in (None, "10", ["10"], [True], [10, 10], [20, 10], [20], []):
            with self.subTest(value=value):
                self.filtered_partial("include")
                state = json.loads(self.state(INITIALIZATION_KEY))
                state["filter_repo_ids"] = value
                conn = connect(self.path)
                try:
                    with conn:
                        set_state(conn, "org", INITIALIZATION_KEY, json.dumps(state))
                finally:
                    conn.close()
                reader = InitializationReader([self.repo, self.other_repo], {})
                with self.assertRaisesRegex(RuntimeError, "ids do not match the checkpoint"):
                    self.initialize(reader, resume=True, include_repos=["test"])
                self.assertEqual(reader.expanded, [])
                self.assertEqual(self.item_ids(), [100])
                self.assertIsNone(self.state("last_sync_at"))

    def test_legacy_adoption_proves_filter_names_match_persisted_ids(self) -> None:
        for mode, tampered_id in (("include", "20"), ("exclude", "10")):
            with self.subTest(mode=mode):
                self.filtered_partial(mode)
                conn = connect(self.path)
                try:
                    with conn:
                        conn.execute("DELETE FROM sync_state WHERE key = ?", (INITIALIZATION_KEY,))
                        set_state(conn, "repo_filter", "repo_ids", tampered_id)
                finally:
                    conn.close()
                reader = InitializationReader([self.repo, self.other_repo], {})
                arguments = {"include_repos": ["test"]} if mode == "include" else {"exclude_repos": ["second"]}
                with self.assertRaisesRegex(RuntimeError, "identities do not match stored ids"):
                    self.initialize(reader, resume=True, **arguments)
                self.assertEqual(reader.listed, [])
                self.assertEqual(reader.expanded, [])
                self.assertIsNone(self.state(INITIALIZATION_KEY))
                self.assertEqual(self.item_ids(), [100])
                self.assertIsNone(self.state("last_sync_at"))
                self.assertIsNone(self.state("last_full_build_at"))

    def test_bound_filter_ids_survive_rename_and_reuse_of_the_old_name(self) -> None:
        self.filtered_partial("include")
        renamed = dict(self.repo, name="Renamed", full_name="Vaquum/Renamed")
        second = InitializationReader([renamed, self.other_repo], {
            renamed["full_name"]: [expansion(renamed, 100, 1), expansion(renamed, 101, 2)],
        })
        second.fail_item = 101
        with self.assertRaisesRegex(RuntimeError, "rate limit"):
            self.initialize(second, resume=True, include_repos=["test"])
        replacement = dict(self.other_repo, name="Test", full_name="Vaquum/Test")
        third = InitializationReader([renamed, replacement], {
            renamed["full_name"]: [expansion(renamed, 100, 1), expansion(renamed, 101, 2)],
            replacement["full_name"]: [expansion(replacement, 200, 1)],
        })
        self.initialize(third, resume=True, include_repos=["test"])
        self.assertEqual(third.listed, [renamed["full_name"]])
        self.assertEqual(third.expanded, [101])
        self.assertEqual(self.item_ids(), [100, 101])
        self.assertEqual(json.loads(self.state(INITIALIZATION_KEY))["filter_repo_ids"], [10])

    def test_legacy_filter_can_prove_a_rename_from_the_stored_repository_identity(self) -> None:
        self.filtered_partial("include")
        conn = connect(self.path)
        try:
            with conn:
                conn.execute("DELETE FROM sync_state WHERE key = ?", (INITIALIZATION_KEY,))
        finally:
            conn.close()
        renamed = dict(self.repo, name="Renamed", full_name="Vaquum/Renamed")
        reader = InitializationReader([renamed, self.other_repo], {
            renamed["full_name"]: [expansion(renamed, 100, 1), expansion(renamed, 101, 2)],
        })
        self.initialize(reader, resume=True, include_repos=["test"])
        self.assertEqual(reader.listed, [renamed["full_name"]])
        self.assertEqual(self.item_ids(), [100, 101])
        self.assertEqual(json.loads(self.state(INITIALIZATION_KEY))["filter_repo_ids"], [10])

    def test_legacy_filter_rejects_unverifiable_renamed_exclusion(self) -> None:
        self.filtered_partial("exclude")
        conn = connect(self.path)
        try:
            with conn:
                conn.execute("DELETE FROM sync_state WHERE key = ?", (INITIALIZATION_KEY,))
        finally:
            conn.close()
        renamed = dict(self.other_repo, name="Renamed", full_name="Vaquum/Renamed")
        reader = InitializationReader([self.repo, renamed], {})
        with self.assertRaisesRegex(RuntimeError, "unknown repos"):
            self.initialize(reader, resume=True, exclude_repos=["second"])
        self.assertEqual(reader.expanded, [])
        self.assertIsNone(self.state(INITIALIZATION_KEY))
        self.assertIsNone(self.state("last_sync_at"))
        self.assertEqual(self.item_ids(), [100])

    def test_resume_rejects_corrupt_progress_and_expansion_identity(self) -> None:
        cases = [
            ("UPDATE sync_state SET value = 'not-json' WHERE key = ?", (INITIALIZATION_KEY,), "invalid initialization"),
            ("UPDATE sync_state SET value = 'invalid' WHERE key = ?", ("full_build_markers_v1_initialized",), "marker state"),
            ("UPDATE repos SET owner = 'Other'", (), "different repository owner"),
            ("UPDATE items SET expanded_json = '{}'", (), "invalid stored expansion"),
            ("UPDATE items SET number = 99", (), "identity mismatch"),
        ]
        for statement, params, message in cases:
            with self.subTest(message=message):
                self.partial()
                conn = connect(self.path)
                try:
                    with conn:
                        conn.execute(statement, params)
                finally:
                    conn.close()
                with self.assertRaisesRegex(RuntimeError, message):
                    self.initialize(self.reader([]), resume=True)
                self.assertEqual(self.item_ids(), [100])

    def test_legacy_resume_rejects_completion_timestamp(self) -> None:
        self.partial()
        conn = connect(self.path)
        try:
            with conn:
                conn.execute("DELETE FROM sync_state WHERE key = ?", (INITIALIZATION_KEY,))
                set_state(conn, "org", "last_sync_at", START)
        finally:
            conn.close()
        with self.assertRaisesRegex(RuntimeError, "completion timestamps"):
            self.initialize(self.reader([]), resume=True)

    def test_discovery_failure_leaves_empty_schema_that_can_resume(self) -> None:
        with patch("github_datastore.store.GitHubOrgReader") as reader:
            reader.return_value.list_org_repos.side_effect = RuntimeError("discovery quota")
            with self.assertRaisesRegex(RuntimeError, "discovery quota"):
                init_org("Vaquum", self.path, resume=True)
        self.assertIsNone(self.state("login"))
        reader = self.reader([expansion(self.repo, 100, 1)])
        self.initialize(reader, resume=True)
        self.assertEqual(self.item_ids(), [100])

    def test_unidentified_nonempty_database_cannot_be_adopted(self) -> None:
        conn = connect(self.path)
        try:
            init_db(conn)
            with conn:
                upsert_repo(conn, self.repo)
        finally:
            conn.close()
        with self.assertRaisesRegex(RuntimeError, "data without an owner"):
            self.initialize(self.reader([]), resume=True)
        self.assertIsNone(self.state("login"))

    def test_resume_rejects_legacy_filter_mismatch_without_discarding_items(self) -> None:
        self.partial(include_repos=["test"])
        conn = connect(self.path)
        try:
            with conn:
                conn.execute("DELETE FROM sync_state WHERE key = ?", (INITIALIZATION_KEY,))
        finally:
            conn.close()
        with self.assertRaisesRegex(RuntimeError, "stored initialization repo filter"):
            self.initialize(self.reader([]), resume=True)
        self.assertEqual(self.item_ids(), [100])

    def test_resume_rejects_item_timestamp_regression(self) -> None:
        self.partial()
        reader = self.reader([expansion(self.repo, 100, 1, "2026-01-01T00:00:00Z")])
        with self.assertRaisesRegex(RuntimeError, "timestamp moved backward"):
            self.initialize(reader, resume=True)
        self.assertEqual(reader.expanded, [])
        self.assertIsNone(self.state("last_sync_at"))

    def test_quota_failure_cancels_queued_expansions(self) -> None:
        release = threading.Event()
        shutdown = threading.Event()
        calls: list[int] = []
        errors: list[BaseException] = []

        class ObservedExecutor(ThreadPoolExecutor):
            def shutdown(self, *args: object, **kwargs: object) -> None:
                shutdown.set()
                super().shutdown(*args, **kwargs)

        class QuotaReader:
            def expand_issue_or_pr(self, repo: dict, issue: dict) -> dict:
                calls.append(issue["number"])
                if issue["number"] == 1:
                    raise RuntimeError("quota exceeded")
                if not release.wait(5):
                    raise AssertionError("test did not release running expansion")
                return {}

        def consume() -> None:
            try:
                list(iter_expanded(QuotaReader(), self.repo, [{"number": number} for number in range(1, 101)], 2))
            except BaseException as error:
                errors.append(error)

        with patch("github_datastore.store.ThreadPoolExecutor", ObservedExecutor):
            thread = threading.Thread(target=consume)
            thread.start()
            try:
                self.assertTrue(shutdown.wait(5), "quota error did not stop queued work")
            finally:
                release.set()
                thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertRegex(str(errors[0]), "quota exceeded")
        self.assertLessEqual(len(calls), 3)

    def test_cli_passes_explicit_resume_and_defaults_to_fresh(self) -> None:
        with patch("github_datastore.cli.init_org") as initialize, redirect_stdout(io.StringIO()):
            main(["--db", str(self.path), "init-org", "Vaquum", "--resume"])
            self.assertTrue(initialize.call_args.kwargs["resume"])
            main(["--db", str(self.path), "init-org", "Vaquum"])
            self.assertFalse(initialize.call_args.kwargs["resume"])


if __name__ == "__main__":
    unittest.main()
