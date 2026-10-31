import json
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from github_datastore import views
from github_datastore.db import connect, get_state, upsert_repo
from github_datastore.store import init_org, sync_once
from tests.test_initialization import CATCHUP, START, InitializationReader, expansion
from tests.test_store import initialize_sync_state, repo_row


def pull(repo: dict, item_id: int, number: int, updated: str = START) -> dict:
    value = expansion(repo, item_id, number, updated)
    value["is_pr"] = True
    value["issue"]["pull_request"] = {"node_id": value["issue"]["node_id"]}
    value["pull"] = {
        "id": item_id, "node_id": value["issue"]["node_id"], "graphql": {"isDraft": False},
        "requested_reviewers": [], "assignees": [], "merged_by": None, "updated_at": updated,
    }
    return value


class IssuesDisabledTest(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "github.sqlite"
        self.repo = dict(repo_row(), has_issues=False)
        self.name = self.repo["full_name"]

    def run_reader(self, reader: InitializationReader, *, initialize: bool = False, **options: object) -> None:
        with patch("github_datastore.store.GitHubOrgReader", return_value=reader):
            if initialize:
                init_org("Vaquum", self.path, workers=1, **options)
            else:
                sync_once(self.path, workers=1, **options)

    def pr_numbers(self) -> list[int]:
        return sorted(row["number"] for row in json.loads(views.pr(db_path=self.path, repo=self.name)))

    def test_initialization_and_catchup_include_prs_with_issues_disabled(self) -> None:
        other = dict(repo_row(), id=20, node_id="R_20", name="Second", full_name="Vaquum/Second")
        reader = InitializationReader([self.repo, other], {
            self.name: [expansion(self.repo, 100, 1), pull(self.repo, 101, 2)],
            other["full_name"]: [expansion(other, 200, 1)],
        })
        reader.catchup_items = {self.name: [pull(self.repo, 102, 3, CATCHUP)]}
        self.run_reader(reader, initialize=True)
        self.assertEqual(self.pr_numbers(), [2, 3])
        issues = json.loads(views.issue(db_path=self.path))
        self.assertEqual([(row["repo"], row["number"]) for row in issues], [(other["full_name"], 1)])
        self.assertEqual(reader.expanded, [101, 200, 102])
        self.assertEqual([names for names, _ in reader.polls], [[other["full_name"]], [self.name]])
        with closing(connect(self.path)) as conn:
            self.assertEqual(get_state(conn, "repo:10", "full_build_complete"), "1")

    def test_disabling_issues_retains_prs_and_uses_incremental_sync_afterward(self) -> None:
        enabled = dict(self.repo, has_issues=True)
        first = InitializationReader([enabled], {self.name: [expansion(enabled, 100, 1), pull(enabled, 101, 2)]})
        self.run_reader(first, initialize=True)

        disabled = InitializationReader([self.repo], {
            self.name: [expansion(self.repo, 100, 1), pull(self.repo, 101, 2), pull(self.repo, 102, 3)],
        })
        self.run_reader(disabled)
        self.assertEqual(disabled.listed, [self.name])
        self.assertEqual(self.pr_numbers(), [2, 3])
        self.assertEqual(json.loads(views.issue(db_path=self.path, repo=self.name)), [])

        incremental = InitializationReader([self.repo], {self.name: disabled.items[self.name]})
        changed = pull(self.repo, 101, 2, CATCHUP)
        changed["issue"]["title"] = "Updated PR"
        incremental.catchup_items = {self.name: [changed, pull(self.repo, 103, 4, CATCHUP)]}
        self.run_reader(incremental)
        self.assertEqual(incremental.listed, [])
        self.assertEqual(self.pr_numbers(), [2, 3, 4])
        self.assertEqual(json.loads(views.pr(db_path=self.path, repo=self.name, number=2))[0]["title"], "Updated PR")

        restored = InitializationReader([enabled], {self.name: [
            expansion(enabled, 100, 1), pull(enabled, 101, 2, CATCHUP),
            pull(enabled, 102, 3), pull(enabled, 103, 4, CATCHUP),
        ]})
        self.run_reader(restored)
        self.assertEqual(restored.listed, [self.name])
        self.assertEqual(self.pr_numbers(), [2, 3, 4])
        self.assertEqual([row["number"] for row in json.loads(views.issue(db_path=self.path, repo=self.name))], [1])

    def test_sync_and_reconcile_recover_previously_omitted_prs(self) -> None:
        for reconcile in [False, True]:
            with self.subTest(reconcile=reconcile), tempfile.TemporaryDirectory() as directory:
                self.path = Path(directory) / "github.sqlite"
                initialize_sync_state(self.path, START)
                with closing(connect(self.path)) as conn, conn:
                    upsert_repo(conn, self.repo)
                    conn.execute("DELETE FROM sync_state WHERE scope = 'repo:10'")
                reader = InitializationReader([self.repo], {self.name: [pull(self.repo, 101, 2)]})
                self.run_reader(reader, reconcile=reconcile)
                self.assertEqual(reader.listed, [self.name])
                self.assertEqual(self.pr_numbers(), [2])
                with closing(connect(self.path)) as conn:
                    self.assertEqual(get_state(conn, "repo:10", "full_build_complete"), "1")
                    self.assertIsNone(get_state(conn, "repo:10", "full_build_retry_required"))

    def test_failed_pr_expansion_does_not_publish_freshness_and_can_resume(self) -> None:
        items = {self.name: [pull(self.repo, 101, 2), pull(self.repo, 102, 3)]}
        first = InitializationReader([self.repo], items)
        first.fail_item = 102
        with self.assertRaisesRegex(RuntimeError, "rate limit during expansion"):
            self.run_reader(first, initialize=True)
        with closing(connect(self.path)) as conn:
            self.assertIsNone(get_state(conn, "org", "last_sync_at"))
        second = InitializationReader([self.repo], items)
        self.run_reader(second, initialize=True, resume=True)
        self.assertEqual(second.expanded, [102])
        self.assertEqual(self.pr_numbers(), [2, 3])
        with closing(connect(self.path)) as conn:
            self.assertEqual(json.loads(get_state(conn, "org", "initialization_v1"))["status"], "complete")

