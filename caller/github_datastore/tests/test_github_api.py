import copy
import unittest
from unittest.mock import Mock

from github_datastore.github_api import (
    ENUMERATION_DRIFT_MAX_ATTEMPTS,
    PR_BASE_QUERY,
    GitHubApiError,
    GitHubEnumerationDriftError,
    GitHubOrgReader,
)


WATERMARK = "2026-08-29T12:00:00Z"


class ScriptedClient:
    def __init__(self, responses: list[dict]) -> None:
        self.responses = list(responses)
        self.calls: list[tuple[str, dict | None]] = []

    def graphql(self, query: str, variables: dict | None = None) -> dict:
        self.calls.append((query, variables))
        if not self.responses:
            raise AssertionError("unexpected GraphQL call")
        return self.responses.pop(0)

    def assert_exhausted(self) -> None:
        if self.responses:
            raise AssertionError(f"{len(self.responses)} scripted GraphQL responses unused")


def repo_node() -> dict:
    return {
        "databaseId": 10,
        "id": "R_10",
        "name": "Test",
        "nameWithOwner": "Vaquum/Test",
        "isPrivate": False,
        "isArchived": False,
        "hasIssuesEnabled": True,
        "owner": {"login": "Vaquum"},
    }


def org_response() -> dict:
    return {
        "repositoryOwner": {
            "__typename": "Organization",
            "login": "Vaquum",
            "repositories": {
                "totalCount": 1,
                "pageInfo": {"hasNextPage": False, "endCursor": None},
                "nodes": [repo_node()],
            }
        }
    }


def pull_stub(number: int, updated_at: str) -> dict:
    return {
        "fullDatabaseId": str(100 + number),
        "id": f"PR_{number}",
        "number": number,
        "updatedAt": updated_at,
    }


def issue_stub(number: int, updated_at: str) -> dict:
    return {
        "databaseId": 200 + number,
        "fullDatabaseId": str(200 + number),
        "id": f"I_{number}",
        "number": number,
        "updatedAt": updated_at,
    }


def connection(nodes: list[dict], has_next_page: bool, end_cursor: str | None) -> dict:
    return {
        "pageInfo": {"hasNextPage": has_next_page, "endCursor": end_cursor},
        "nodes": nodes,
    }


def incremental_response(
    issues: list[dict],
    pulls: list[dict],
    issue_has_next: bool = False,
    issue_cursor: str | None = None,
    pull_has_next: bool = False,
    pull_cursor: str | None = None,
    issue_total_count: int | None = None,
    pull_total_count: int | None = None,
) -> dict:
    issue_connection = connection(issues, issue_has_next, issue_cursor)
    issue_connection["totalCount"] = (
        len(issues) if issue_total_count is None else issue_total_count
    )
    pull_connection = connection(pulls, pull_has_next, pull_cursor)
    pull_connection["totalCount"] = len(pulls) if pull_total_count is None else pull_total_count
    return {
        "repository": {
            "issues": issue_connection,
            "pullRequests": pull_connection,
        }
    }


def repository_page(
    key: str,
    nodes: list[dict],
    has_next_page: bool,
    end_cursor: str | None,
    total_count: int | None = None,
) -> dict:
    result = connection(nodes, has_next_page, end_cursor)
    if total_count is not None:
        result["totalCount"] = total_count
    return {"repository": {key: result}}


class GitHubOrgReaderTest(unittest.TestCase):
    def test_org_query_remains_repository_inventory_only(self) -> None:
        client = ScriptedClient([org_response()])
        repos = GitHubOrgReader(client).list_org_repos("Vaquum")

        self.assertEqual(repos[0]["full_name"], "Vaquum/Test")
        self.assertEqual(len(client.calls), 1)
        query, variables = client.calls[0]
        self.assertNotIn("pullRequests", query)
        self.assertNotIn("body", query)
        self.assertEqual(variables, {"org": "Vaquum", "cursor": None})
        client.assert_exhausted()

    def test_personal_owner_inventory_is_paginated_and_owner_only(self) -> None:
        first = org_response()
        owner = first["repositoryOwner"]
        owner.update({"__typename": "User", "login": "Vaquum"})
        owner["repositories"]["totalCount"] = 2
        owner["repositories"]["pageInfo"] = {"hasNextPage": True, "endCursor": "next"}
        second = org_response()
        second["repositoryOwner"]["__typename"] = "User"
        second["repositoryOwner"]["repositories"]["totalCount"] = 2
        second_repo = second["repositoryOwner"]["repositories"]["nodes"][0]
        second_repo.update({"databaseId": 11, "id": "R_11", "name": "Other", "nameWithOwner": "Vaquum/Other"})
        client = ScriptedClient([first, second])
        rows = GitHubOrgReader(client).list_org_repos("vaquum")
        self.assertEqual([row["full_name"] for row in rows], ["Vaquum/Test", "Vaquum/Other"])
        self.assertIn("repositoryOwner(login: $org)", client.calls[0][0])
        self.assertIn("ownerAffiliations: [OWNER]", client.calls[0][0])
        self.assertEqual(client.calls[1][1], {"org": "vaquum", "cursor": "next"})
        client.assert_exhausted()

    def test_owner_inventory_rejects_collaborator_repositories_and_wrong_owners(self) -> None:
        for mismatch in ("node_owner", "full_name", "owner_login", "owner_type"):
            with self.subTest(mismatch=mismatch):
                response = org_response()
                owner = response["repositoryOwner"]
                repo = owner["repositories"]["nodes"][0]
                if mismatch == "node_owner":
                    repo["owner"]["login"] = "AnotherOrg"
                elif mismatch == "full_name":
                    repo["nameWithOwner"] = "AnotherOrg/Test"
                elif mismatch == "owner_login":
                    owner["login"] = "AnotherOrg"
                else:
                    owner["__typename"] = "Team"
                with self.assertRaises(GitHubApiError):
                    GitHubOrgReader(ScriptedClient([response])).list_org_repos("Vaquum")

    def test_owner_inventory_rejects_missing_partial_duplicate_and_stuck_pages(self) -> None:
        for failure in ("missing", "partial", "duplicate", "cursor", "count_changed"):
            with self.subTest(failure=failure):
                response = org_response()
                conn = response["repositoryOwner"]["repositories"]
                pages = [response]
                if failure == "missing":
                    response["repositoryOwner"] = None
                elif failure == "partial":
                    conn["totalCount"] = 2
                    for _ in range(ENUMERATION_DRIFT_MAX_ATTEMPTS - 1):
                        extra = org_response()
                        extra["repositoryOwner"]["repositories"]["totalCount"] = 2
                        pages.append(extra)
                elif failure == "duplicate":
                    conn["totalCount"] = 2
                    conn["nodes"].append(repo_node())
                elif failure == "cursor":
                    conn["pageInfo"] = {"hasNextPage": True, "endCursor": None}
                else:
                    conn["totalCount"] = 2
                    conn["pageInfo"] = {"hasNextPage": True, "endCursor": "next"}
                    pages.append(org_response())
                    for _ in range(ENUMERATION_DRIFT_MAX_ATTEMPTS - 1):
                        extra = org_response()
                        extra["repositoryOwner"]["repositories"]["totalCount"] = 2
                        extra["repositoryOwner"]["repositories"]["pageInfo"] = {"hasNextPage": True, "endCursor": "next"}
                        pages.extend([extra, org_response()])
                with self.assertRaises(GitHubApiError):
                    GitHubOrgReader(ScriptedClient(pages)).list_org_repos("Vaquum")

    def test_owner_inventory_restarts_after_mid_page_repo_creation(self) -> None:
        repos = [repo_node(), repo_node(), repo_node()]
        repos[1].update({"databaseId": 11, "id": "R_11", "name": "Other", "nameWithOwner": "Vaquum/Other"})
        repos[2].update({"databaseId": 12, "id": "R_12", "name": "Third", "nameWithOwner": "Vaquum/Third"})

        def inventory_page(nodes: list[dict], total: int, has_next: bool, cursor: str | None) -> dict:
            response = org_response()
            conn = response["repositoryOwner"]["repositories"]
            conn["nodes"] = nodes
            conn["totalCount"] = total
            conn["pageInfo"] = {"hasNextPage": has_next, "endCursor": cursor}
            return response

        client = ScriptedClient([
            inventory_page(repos[:1], 2, True, "next"),
            inventory_page(repos[1:2], 3, False, None),
            inventory_page(repos[:1], 3, True, "next"),
            inventory_page(repos[1:], 3, False, None),
        ])
        rows = GitHubOrgReader(client).list_org_repos("Vaquum")
        self.assertEqual([row["full_name"] for row in rows], ["Vaquum/Test", "Vaquum/Other", "Vaquum/Third"])
        self.assertEqual(len(client.calls), 4)
        self.assertEqual(client.calls[2][1], {"org": "Vaquum", "cursor": None})
        client.assert_exhausted()

    def test_incremental_query_combines_issue_delta_and_all_pr_stubs(self) -> None:
        issue = issue_stub(1, "2026-08-29T12:01:00Z")
        unchanged = pull_stub(1, "2026-08-29T11:00:00Z")
        changed = pull_stub(2, "2026-08-29T11:30:00Z")
        new = pull_stub(3, "2026-08-29T11:45:00Z")
        client = ScriptedClient([incremental_response([issue], [unchanged, changed, new])])

        items = GitHubOrgReader(client).list_repo_changed_items(
            "Vaquum/Test",
            WATERMARK,
            {
                101: "2026-08-29T11:00:00Z",
                102: "2026-08-29T11:20:00Z",
            },
        )

        self.assertEqual(
            [(item["item_kind"], item["number"]) for item in items],
            [("pr", 2), ("pr", 3), ("issue", 1)],
        )
        self.assertEqual(len(client.calls), 1)
        normalized_query = " ".join(client.calls[0][0].split())
        self.assertIn("filterBy: {since: $since}", normalized_query)
        self.assertIn("orderBy: {field: CREATED_AT, direction: ASC}", normalized_query)
        self.assertIn(
            "pullRequests(first: 100, states: [OPEN, CLOSED, MERGED], "
            "orderBy: {field: CREATED_AT, direction: ASC})",
            normalized_query,
        )
        self.assertNotIn("body", normalized_query)
        client.assert_exhausted()

    def test_pr_comparison_uses_instants_not_timestamp_strings(self) -> None:
        pull = pull_stub(1, "2026-08-29T12:00:00Z")
        reader = GitHubOrgReader(ScriptedClient([]))
        changed = reader._changed_pull_nodes(
            "Vaquum/Test", [pull], {101: "2026-08-29T14:00:00+02:00"}
        )
        self.assertEqual(changed, [])

    def test_pr_comparison_rejects_invalid_or_backward_timestamps(self) -> None:
        cases = [
            ([pull_stub(1, "0")], {101: WATERMARK}),
            ([pull_stub(1, "2026-08-29T12:00:00")], {101: WATERMARK}),
            ([pull_stub(1, "2026-08-29T11:59:59Z")], {101: WATERMARK}),
            ([pull_stub(1, WATERMARK)], {101: " "}),
        ]
        reader = GitHubOrgReader(ScriptedClient([]))
        for pulls, stored in cases:
            with self.subTest(pulls=pulls, stored=stored):
                with self.assertRaises(GitHubApiError):
                    reader._changed_pull_nodes("Vaquum/Test", pulls, stored)

    def test_pr_comparison_rejects_duplicate_or_missing_graphql_ids(self) -> None:
        duplicate = pull_stub(1, WATERMARK)
        reader = GitHubOrgReader(ScriptedClient([]))
        with self.assertRaisesRegex(GitHubApiError, "duplicate pull request id"):
            reader._changed_pull_nodes("Vaquum/Test", [duplicate, duplicate], {})
        with self.assertRaisesRegex(GitHubApiError, "missing from GraphQL"):
            reader._changed_pull_nodes(
                "Vaquum/Test", [duplicate], {101: WATERMARK, 999: WATERMARK}
            )

    def test_no_watermark_forces_full_enumeration(self) -> None:
        reader = GitHubOrgReader(ScriptedClient([]))
        reader.list_repo_issues = Mock(return_value=[])
        reader.list_repo_changed_items("Vaquum/Test", None, {})
        reader.list_repo_issues.assert_called_once_with("Vaquum/Test")

    def test_full_enumeration_uses_minimal_stubs_for_issues_and_prs(self) -> None:
        issue = issue_stub(1, "2026-08-29T11:00:00Z")
        pull = pull_stub(2, "2026-08-29T12:00:00Z")
        client = ScriptedClient(
            [
                repository_page("issues", [issue], False, None, 1),
                repository_page("pullRequests", [pull], False, None, 1),
            ]
        )

        items = GitHubOrgReader(client).list_repo_issues("Vaquum/Test")

        self.assertEqual(
            items,
            [
                {
                    "id": 201,
                    "number": 1,
                    "updated_at": "2026-08-29T11:00:00Z",
                    "item_kind": "issue",
                },
                {
                    "id": 102,
                    "number": 2,
                    "updated_at": "2026-08-29T12:00:00Z",
                    "item_kind": "pr",
                },
            ],
        )
        self.assertTrue(all("body" not in query for query, _ in client.calls))
        self.assertTrue(all("totalCount" in query for query, _ in client.calls))
        client.assert_exhausted()

    def test_full_enumeration_pages_and_validates_issue_and_pr_totals(self) -> None:
        issues = [issue_stub(number, WATERMARK) for number in range(1, 102)]
        pulls = [pull_stub(number, WATERMARK) for number in range(1001, 1102)]
        client = ScriptedClient(
            [
                repository_page("issues", issues[:100], True, "issue-cursor", 101),
                repository_page("issues", issues[100:], False, None, 101),
                repository_page("pullRequests", pulls[:100], True, "pull-cursor", 101),
                repository_page("pullRequests", pulls[100:], False, None, 101),
            ]
        )

        items = GitHubOrgReader(client).list_repo_issues("Vaquum/Test")

        self.assertEqual(len(items), 202)
        self.assertEqual(client.calls[1][1]["cursor"], "issue-cursor")
        self.assertEqual(client.calls[3][1]["cursor"], "pull-cursor")
        client.assert_exhausted()

    def test_full_enumeration_rejects_incomplete_issue_or_pr_results(self) -> None:
        cases = [
            [repository_page("issues", [issue_stub(1, WATERMARK)], False, None, 2)
             for _ in range(ENUMERATION_DRIFT_MAX_ATTEMPTS)],
            [
                repository_page("issues", [], False, None, 0),
                *[repository_page("pullRequests", [pull_stub(1, WATERMARK)], False, None, 2)
                  for _ in range(ENUMERATION_DRIFT_MAX_ATTEMPTS)],
            ],
        ]
        for responses in cases:
            with self.subTest(responses=responses):
                with self.assertRaisesRegex(GitHubApiError, "enumeration count mismatch"):
                    GitHubOrgReader(ScriptedClient(responses)).list_repo_issues("Vaquum/Test")

    def test_full_enumeration_restarts_pr_connection_after_mid_page_creation(self) -> None:
        pulls = [pull_stub(number, WATERMARK) for number in range(1, 4)]
        client = ScriptedClient([
            repository_page("issues", [], False, None, 0),
            repository_page("pullRequests", pulls[:1], True, "cursor-1", 2),
            repository_page("pullRequests", pulls[1:], False, None, 3),
            repository_page("pullRequests", pulls[:1], True, "cursor-1", 3),
            repository_page("pullRequests", pulls[1:], False, None, 3),
        ])
        rows = GitHubOrgReader(client).list_repo_issues("Vaquum/Test")
        self.assertEqual([(row["item_kind"], row["number"]) for row in rows], [("pr", 1), ("pr", 2), ("pr", 3)])
        self.assertEqual(len(client.calls), 5)
        self.assertEqual(client.calls[3][1]["cursor"], None)
        client.assert_exhausted()

    def test_full_enumeration_rejects_duplicate_item_ids(self) -> None:
        issue = issue_stub(1, WATERMARK)
        duplicate = issue_stub(2, WATERMARK)
        duplicate["databaseId"] = issue["databaseId"]
        duplicate["fullDatabaseId"] = issue["fullDatabaseId"]
        client = ScriptedClient(
            [
                repository_page("issues", [issue, duplicate], False, None, 2),
                repository_page("pullRequests", [], False, None, 0),
            ]
        )
        with self.assertRaisesRegex(GitHubApiError, "duplicate item ids"):
            GitHubOrgReader(client).list_repo_issues("Vaquum/Test")

    def test_incremental_query_pages_all_pr_stubs(self) -> None:
        pulls = [pull_stub(number, WATERMARK) for number in range(1, 102)]
        client = ScriptedClient(
            [
                incremental_response(
                    [],
                    pulls[:100],
                    pull_has_next=True,
                    pull_cursor="cursor-1",
                    pull_total_count=101,
                ),
                repository_page("pullRequests", pulls[100:], False, None, 101),
            ]
        )

        items = GitHubOrgReader(client).list_repo_changed_items(
            "Vaquum/Test", WATERMARK, {}
        )

        self.assertEqual(len(items), 101)
        self.assertEqual(client.calls[1][1]["cursor"], "cursor-1")
        client.assert_exhausted()

    def test_incremental_query_pages_all_issue_stubs(self) -> None:
        issues = [issue_stub(number, WATERMARK) for number in range(1, 102)]
        client = ScriptedClient(
            [
                incremental_response(
                    issues[:100],
                    [],
                    issue_has_next=True,
                    issue_cursor="cursor-1",
                    issue_total_count=101,
                ),
                repository_page("issues", issues[100:], False, None, 101),
            ]
        )

        items = GitHubOrgReader(client).list_repo_changed_items(
            "Vaquum/Test", WATERMARK, {}
        )

        self.assertEqual(len(items), 101)
        self.assertEqual(client.calls[1][1]["cursor"], "cursor-1")
        client.assert_exhausted()

    def test_incremental_query_rejects_incomplete_issue_enumeration(self) -> None:
        client = ScriptedClient(
            [incremental_response([issue_stub(1, WATERMARK)], [], issue_total_count=2)
             for _ in range(ENUMERATION_DRIFT_MAX_ATTEMPTS)]
        )
        with self.assertRaisesRegex(GitHubApiError, "issue enumeration count mismatch"):
            GitHubOrgReader(client).list_repo_changed_items("Vaquum/Test", WATERMARK, {})

    def test_incremental_continuation_rejects_changed_or_missing_total_count(self) -> None:
        cases = [
            (3, ENUMERATION_DRIFT_MAX_ATTEMPTS),
            (None, 1),
        ]
        for total, attempts in cases:
            with self.subTest(total=total):
                responses = []
                for _ in range(attempts):
                    responses.append(
                        incremental_response(
                            [issue_stub(1, WATERMARK)],
                            [],
                            issue_has_next=True,
                            issue_cursor="cursor-1",
                            issue_total_count=2,
                        )
                    )
                    responses.append(
                        repository_page("issues", [issue_stub(2, WATERMARK)], False, None, total)
                    )
                client = ScriptedClient(responses)
                with self.assertRaises(GitHubApiError):
                    GitHubOrgReader(client).list_repo_changed_items(
                        "Vaquum/Test", WATERMARK, {}
                    )

    def test_incremental_query_rejects_incomplete_pr_enumeration(self) -> None:
        client = ScriptedClient(
            [incremental_response([], [pull_stub(1, WATERMARK)], pull_total_count=2)
             for _ in range(ENUMERATION_DRIFT_MAX_ATTEMPTS)]
        )
        with self.assertRaisesRegex(GitHubApiError, "enumeration count mismatch"):
            GitHubOrgReader(client).list_repo_changed_items("Vaquum/Test", WATERMARK, {})

    def test_incremental_query_restarts_after_mid_page_pr_creation(self) -> None:
        pulls = [pull_stub(number, WATERMARK) for number in range(1, 4)]
        client = ScriptedClient([
            incremental_response([], pulls[:1], pull_has_next=True, pull_cursor="cursor-1", pull_total_count=2),
            repository_page("pullRequests", pulls[1:2], False, None, 3),
            incremental_response([], pulls[:1], pull_has_next=True, pull_cursor="cursor-1", pull_total_count=3),
            repository_page("pullRequests", pulls[1:], False, None, 3),
        ])
        items = GitHubOrgReader(client).list_repo_changed_items("Vaquum/Test", WATERMARK, {})
        self.assertEqual([(item["item_kind"], item["number"]) for item in items], [("pr", 1), ("pr", 2), ("pr", 3)])
        self.assertEqual(len(client.calls), 4)
        self.assertEqual(client.calls[2][1]["since"], WATERMARK)
        self.assertNotIn("cursor", client.calls[2][1])
        client.assert_exhausted()

    def test_repository_page_rejects_nonadvancing_cursor(self) -> None:
        pulls = [pull_stub(1, WATERMARK), pull_stub(2, WATERMARK)]
        client = ScriptedClient(
            [
                incremental_response(
                    [],
                    [pulls[0]],
                    pull_has_next=True,
                    pull_cursor="cursor-1",
                    pull_total_count=2,
                ),
                repository_page("pullRequests", [pulls[1]], True, "cursor-1", 2),
            ]
        )
        with self.assertRaisesRegex(GitHubApiError, "non-advancing page cursor"):
            GitHubOrgReader(client).list_repo_changed_items("Vaquum/Test", WATERMARK, {})

    def test_repository_page_rejects_cyclic_cursor(self) -> None:
        pulls = [pull_stub(1, WATERMARK), pull_stub(2, WATERMARK), pull_stub(3, WATERMARK)]
        client = ScriptedClient(
            [
                incremental_response(
                    [],
                    [pulls[0]],
                    pull_has_next=True,
                    pull_cursor="cursor-1",
                    pull_total_count=3,
                ),
                repository_page("pullRequests", [pulls[1]], True, "cursor-2", 3),
                repository_page("pullRequests", [pulls[2]], True, "cursor-1", 3),
            ]
        )
        with self.assertRaisesRegex(GitHubApiError, "cyclic page cursor"):
            GitHubOrgReader(client).list_repo_changed_items("Vaquum/Test", WATERMARK, {})


class GitHubRepositoryBatchTest(unittest.TestCase):
    @staticmethod
    def batch_result(full_name: str, issues: list[dict], pulls: list[dict], **kwargs) -> dict:
        return {"nameWithOwner": full_name, **incremental_response(issues, pulls, **kwargs)["repository"]}

    @staticmethod
    def batch_page(full_name: str, key: str, nodes: list[dict], has_next: bool, cursor: str | None, total: int | None) -> dict:
        return {"nameWithOwner": full_name, **repository_page(key, nodes, has_next, cursor, total)["repository"]}

    def test_full_enumeration_with_issues_disabled_reads_every_pr_page(self) -> None:
        pulls = [pull_stub(1, WATERMARK), pull_stub(2, WATERMARK)]
        client = ScriptedClient([
            repository_page("pullRequests", pulls[:1], True, "next-pr", 2),
            repository_page("pullRequests", pulls[1:], False, None, 2),
        ])
        rows = GitHubOrgReader(client).list_repo_issues("owner/repo", include_issues=False)
        self.assertEqual([(row["item_kind"], row["number"]) for row in rows], [("pr", 1), ("pr", 2)])
        self.assertEqual(client.calls[1][1]["cursor"], "next-pr")
        self.assertTrue(all("issues(" not in query for query, _ in client.calls))
        client.assert_exhausted()

    def test_pr_only_batch_preserves_cursors_counts_and_local_delta_comparison(self) -> None:
        names = ["owner/first", "owner/second"]
        client = ScriptedClient([
            {"repo_0": self.batch_page(names[0], "pullRequests", [pull_stub(1, WATERMARK)], True, "first-next", 2),
             "repo_1": self.batch_page(names[1], "pullRequests", [pull_stub(3, WATERMARK)], True, "second-next", 2)},
            {"page_0": self.batch_page(names[0], "pullRequests", [pull_stub(2, WATERMARK)], False, None, 2),
             "page_1": self.batch_page(names[1], "pullRequests", [pull_stub(4, WATERMARK)], False, None, 2)},
        ])
        rows = GitHubOrgReader(client).list_repos_changed_items(
            names, WATERMARK, {names[0]: {101: WATERMARK}}, include_issues=False,
        )
        self.assertEqual({name: [row["number"] for row in items] for name, items in rows.items()},
                         {names[0]: [2], names[1]: [3, 4]})
        self.assertEqual(len(client.calls), 2)
        self.assertEqual(client.calls[1][1]["cursor0"], "first-next")
        self.assertEqual(client.calls[1][1]["cursor1"], "second-next")
        for query, variables in client.calls:
            self.assertNotIn("issues(", query)
            self.assertNotIn("$since", query)
            self.assertNotIn("since", variables)
        client.assert_exhausted()

    def test_pr_only_batch_still_rejects_missing_pages_and_cyclic_cursors(self) -> None:
        responses = [
            {"repo_0": self.batch_page("owner/repo", "pullRequests", [pull_stub(1, WATERMARK)], False, None, 2)}
            for _ in range(ENUMERATION_DRIFT_MAX_ATTEMPTS)
        ]
        with self.assertRaisesRegex(GitHubApiError, "enumeration count mismatch"):
            GitHubOrgReader(ScriptedClient(responses)).list_repos_changed_items(
                ["owner/repo"], WATERMARK, {}, include_issues=False,
            )
        first = self.batch_page("owner/repo", "pullRequests", [pull_stub(1, WATERMARK)], True, "first", 4)
        second = self.batch_page("owner/repo", "pullRequests", [pull_stub(2, WATERMARK)], True, "second", 4)
        third = self.batch_page("owner/repo", "pullRequests", [pull_stub(3, WATERMARK)], True, "first", 4)
        with self.assertRaisesRegex(GitHubApiError, "cyclic page cursor"):
            GitHubOrgReader(ScriptedClient([{"repo_0": first}, {"page_0": second}, {"page_0": third}])).list_repos_changed_items(
                ["owner/repo"], WATERMARK, {}, include_issues=False,
            )

    def test_changed_batch_restarts_after_mid_page_pr_creation(self) -> None:
        name = "Vaquum/design-system"
        before = [pull_stub(number, WATERMARK) for number in range(1, 110)]
        after = [pull_stub(number, WATERMARK) for number in range(1, 111)]
        client = ScriptedClient([
            {"repo_0": self.batch_page(name, "pullRequests", before[:100], True, "cursor-100", 109)},
            {"page_0": self.batch_page(name, "pullRequests", before[100:], False, None, 110)},
            {"repo_0": self.batch_page(name, "pullRequests", after[:100], True, "cursor-100", 110)},
            {"page_0": self.batch_page(name, "pullRequests", after[100:], False, None, 110)},
        ])
        result = GitHubOrgReader(client).list_repos_changed_items([name], WATERMARK, {}, include_issues=False)
        self.assertEqual([item["number"] for item in result[name]], list(range(1, 111)))
        self.assertEqual(len(client.calls), 4)
        self.assertIn("repo_0:", client.calls[2][0])
        self.assertNotIn("cursor0", client.calls[2][1])
        client.assert_exhausted()

    def test_changed_batch_fails_loudly_after_persistent_drift(self) -> None:
        self.assertTrue(issubclass(GitHubEnumerationDriftError, GitHubApiError))
        name = "owner/repo"
        responses = []
        for attempt in range(ENUMERATION_DRIFT_MAX_ATTEMPTS):
            total = 2 + attempt
            responses.append({"repo_0": self.batch_page(name, "pullRequests", [pull_stub(1, WATERMARK)], True, "cursor-1", total)})
            responses.append({"page_0": self.batch_page(name, "pullRequests", [pull_stub(2, WATERMARK)], False, None, total + 1)})
        client = ScriptedClient(responses)
        with self.assertRaisesRegex(GitHubEnumerationDriftError, "totalCount changed"):
            GitHubOrgReader(client).list_repos_changed_items([name], WATERMARK, {}, include_issues=False)
        self.assertEqual(len(client.calls), 2 * ENUMERATION_DRIFT_MAX_ATTEMPTS)
        client.assert_exhausted()

    def test_batch_matches_individual_complete_changed_items(self) -> None:
        first = incremental_response([issue_stub(1, WATERMARK)], [pull_stub(1, WATERMARK), pull_stub(2, WATERMARK)])
        second = incremental_response([], [pull_stub(3, WATERMARK)])
        names = ["Vaquum/33", "personal/null"]
        stored = {names[0]: {101: WATERMARK}, names[1]: {103: "2026-08-29T11:00:00Z"}}
        individual = GitHubOrgReader(ScriptedClient([first, second]))
        expected = {name: individual.list_repo_changed_items(name, WATERMARK, stored[name]) for name in names}
        client = ScriptedClient([{
            "repo_0": {"nameWithOwner": names[0], **first["repository"]},
            "repo_1": {"nameWithOwner": names[1], **second["repository"]},
        }])
        self.assertEqual(GitHubOrgReader(client).list_repos_changed_items(names, WATERMARK, stored), expected)
        self.assertEqual(len(client.calls), 1)
        query, variables = client.calls[0]
        self.assertEqual(variables, {"since": WATERMARK, "owner0": "Vaquum", "name0": "33", "owner1": "personal", "name1": "null"})
        self.assertIn("repo_0: repository(owner: $owner0, name: $name0)", query)
        self.assertIn("repo_1: repository(owner: $owner1, name: $name1)", query)
        self.assertNotIn("body", query)
        client.assert_exhausted()

    def test_batches_are_bounded_and_empty_input_does_no_work(self) -> None:
        names = [f"owner/repo{index}" for index in range(41)]
        pages = [{f"repo_{index}": self.batch_result(name, [], []) for index, name in enumerate(names[start:start + 20])} for start in range(0, 41, 20)]
        client = ScriptedClient(pages)
        reader = GitHubOrgReader(client)
        self.assertEqual(reader.list_repos_changed_items([], WATERMARK, {}), {})
        self.assertEqual(reader.list_repos_changed_items(names, WATERMARK, {}), {name: [] for name in names})
        self.assertEqual(len(client.calls), 3)
        self.assertEqual([len(variables) for _, variables in client.calls], [41, 41, 3])
        client.assert_exhausted()

    def test_repositories_continue_with_their_own_cursors(self) -> None:
        names = ["owner/first", "owner/second"]
        issues = [issue_stub(1, WATERMARK), issue_stub(2, WATERMARK)]
        pulls = [pull_stub(3, WATERMARK), pull_stub(4, WATERMARK)]
        client = ScriptedClient([
            {"repo_0": self.batch_result(names[0], issues[:1], [], issue_has_next=True, issue_cursor="issue-cursor", issue_total_count=2),
             "repo_1": self.batch_result(names[1], [], pulls[:1], pull_has_next=True, pull_cursor="pull-cursor", pull_total_count=2)},
            {"page_0": self.batch_page(names[0], "issues", issues[1:], False, None, 2),
             "page_1": self.batch_page(names[1], "pullRequests", pulls[1:], False, None, 2)},
        ])
        result = GitHubOrgReader(client).list_repos_changed_items(names, WATERMARK, {})
        self.assertEqual([item["number"] for item in result[names[0]]], [1, 2])
        self.assertEqual([item["number"] for item in result[names[1]]], [3, 4])
        self.assertEqual(len(client.calls), 2)
        self.assertEqual(client.calls[1][1], {"since": WATERMARK, "owner0": "owner", "name0": "first", "cursor0": "issue-cursor", "owner1": "owner", "name1": "second", "cursor1": "pull-cursor"})
        self.assertNotIn("body", client.calls[1][0])
        client.assert_exhausted()

    def test_continuations_match_individual_enumeration_with_uneven_pages(self) -> None:
        names = ["owner/first", "owner/second"]
        issues = [issue_stub(number, WATERMARK) for number in range(1, 202)]
        pulls = [pull_stub(number, "2026-08-29T11:00:00Z") for number in range(1001, 1102)]
        other_pulls = [pull_stub(number, WATERMARK) for number in range(2001, 2202)]
        first = incremental_response(issues[:100], pulls[:100], True, "issue-100", True, "pull-100", 201, 101)
        second = incremental_response([], other_pulls[:100], pull_has_next=True, pull_cursor="other-100", pull_total_count=201)
        stored = {names[0]: {int(pulls[0]["fullDatabaseId"]): pulls[0]["updatedAt"]}, names[1]: {}}
        individual_client = ScriptedClient([
            first,
            repository_page("issues", issues[100:200], True, "issue-200", 201),
            repository_page("issues", issues[200:], False, None, 201),
            repository_page("pullRequests", pulls[100:], False, None, 101),
            second,
            repository_page("pullRequests", other_pulls[100:200], True, "other-200", 201),
            repository_page("pullRequests", other_pulls[200:], False, None, 201),
        ])
        individual = GitHubOrgReader(individual_client)
        expected = {name: individual.list_repo_changed_items(name, WATERMARK, stored[name]) for name in names}
        client = ScriptedClient([
            {"repo_0": {"nameWithOwner": names[0], **first["repository"]},
             "repo_1": {"nameWithOwner": names[1], **second["repository"]}},
            {"page_0": self.batch_page(names[0], "issues", issues[100:200], True, "issue-200", 201),
             "page_1": self.batch_page(names[0], "pullRequests", pulls[100:], False, None, 101),
             "page_2": self.batch_page(names[1], "pullRequests", other_pulls[100:200], True, "other-200", 201)},
            {"page_0": self.batch_page(names[0], "issues", issues[200:], False, None, 201),
             "page_1": self.batch_page(names[1], "pullRequests", other_pulls[200:], False, None, 201)},
        ])
        actual = GitHubOrgReader(client).list_repos_changed_items(names, WATERMARK, stored)
        self.assertEqual(actual, expected)
        self.assertEqual(len(client.calls), 3)
        self.assertEqual(len(individual_client.calls), 7)
        self.assertEqual(client.calls[2][1]["cursor0"], "issue-200")
        self.assertEqual(client.calls[2][1]["cursor1"], "other-200")
        self.assertTrue(any(item["updated_at"] < WATERMARK for item in actual[names[0]]))
        client.assert_exhausted()
        individual_client.assert_exhausted()

    def test_continuation_batches_limit_independent_connections_to_twenty(self) -> None:
        names = [f"owner/repo{index}" for index in range(20)]
        first = {f"repo_{index}": self.batch_result(name, [issue_stub(1, WATERMARK)], [pull_stub(3, WATERMARK)],
                  issue_has_next=True, issue_cursor=f"issue-{index}", issue_total_count=2,
                  pull_has_next=True, pull_cursor=f"pull-{index}", pull_total_count=2)
                 for index, name in enumerate(names)}
        identities = [(name, key) for name in names for key in ("issues", "pullRequests")]
        continuations = [{f"page_{index}": self.batch_page(name, key, [issue_stub(2, WATERMARK) if key == "issues" else pull_stub(4, WATERMARK)], False, None, 2)
                          for index, (name, key) in enumerate(identities[start:start + 20])}
                         for start in range(0, len(identities), 20)]
        client = ScriptedClient([first, *continuations])
        result = GitHubOrgReader(client).list_repos_changed_items(names, WATERMARK, {})
        self.assertEqual(len(client.calls), 3)
        self.assertTrue(all(len(items) == 4 for items in result.values()))
        self.assertEqual([query.count("page_") for query, _ in client.calls[1:]], [20, 20])
        client.assert_exhausted()

    def test_missing_null_or_wrong_repository_alias_fails(self) -> None:
        cases = [{}, {"repo_0": None}, {"repo_0": self.batch_result("other/repo", [], [])}]
        for response in cases:
            with self.subTest(response=response), self.assertRaises(GitHubApiError):
                GitHubOrgReader(ScriptedClient([response])).list_repos_changed_items(["owner/repo"], WATERMARK, {})

    def test_case_insensitive_duplicate_input_fails_before_request(self) -> None:
        with self.assertRaisesRegex(ValueError, "duplicate repositories"):
            GitHubOrgReader(ScriptedClient([])).list_repos_changed_items(["Owner/repo", "owner/Repo"], WATERMARK, {})

    def test_missing_watermark_preserves_full_enumeration(self) -> None:
        reader = GitHubOrgReader(ScriptedClient([]))
        reader.list_repo_issues = Mock(side_effect=[[{"id": 1}], [{"id": 2}]])
        self.assertEqual(reader.list_repos_changed_items(["owner/a", "owner/b"], None, {}), {"owner/a": [{"id": 1}], "owner/b": [{"id": 2}]})
        self.assertEqual([call.args for call in reader.list_repo_issues.call_args_list], [("owner/a",), ("owner/b",)])

    def test_batch_rejects_missing_ids_counts_and_nonadvancing_cursors(self) -> None:
        drifting = ENUMERATION_DRIFT_MAX_ATTEMPTS
        cases = [
            (self.batch_result("owner/repo", [], [], issue_total_count=1), [], {}, drifting),
            (self.batch_result("owner/repo", [], [pull_stub(1, WATERMARK)], pull_total_count=2), [], {}, drifting),
            (self.batch_result("owner/repo", [], [pull_stub(1, WATERMARK)]), [], {999: WATERMARK}, 1),
            (self.batch_result("owner/repo", [], [pull_stub(1, WATERMARK)] * 2), [], {}, 1),
            (self.batch_result("owner/repo", [], [], pull_has_next=True, pull_cursor="cursor", pull_total_count=2),
             [{"page_0": self.batch_page("owner/repo", "pullRequests", [pull_stub(1, WATERMARK)], True, "cursor", 2)}], {}, 1),
            (self.batch_result("owner/repo", [], [], pull_has_next=True, pull_cursor="cursor", pull_total_count=2),
             [{"page_0": self.batch_page("owner/repo", "pullRequests", [pull_stub(1, WATERMARK)], False, None, 3)}], {}, drifting),
        ]
        for first, continuations, stored, attempts in cases:
            with self.subTest(first=first, continuations=continuations, stored=stored), self.assertRaises(GitHubApiError):
                responses = []
                for _ in range(attempts):
                    responses.append({"repo_0": copy.deepcopy(first)})
                    responses.extend(copy.deepcopy(continuations))
                GitHubOrgReader(ScriptedClient(responses)).list_repos_changed_items(["owner/repo"], WATERMARK, {"owner/repo": stored})

    def test_continuations_reject_incomplete_duplicate_and_inaccessible_data(self) -> None:
        first = self.batch_result("owner/repo", [], [pull_stub(1, WATERMARK)], pull_has_next=True, pull_cursor="first", pull_total_count=2)
        drifting = ENUMERATION_DRIFT_MAX_ATTEMPTS
        cases = [
            ({}, 1),
            ({"page_0": None}, 1),
            ({"page_0": self.batch_page("other/repo", "pullRequests", [pull_stub(2, WATERMARK)], False, None, 2)}, 1),
            ({"page_0": self.batch_page("owner/repo", "pullRequests", [pull_stub(2, WATERMARK)], False, None, None)}, 1),
            ({"page_0": self.batch_page("owner/repo", "pullRequests", [], False, None, 2)}, drifting),
            ({"page_0": self.batch_page("owner/repo", "pullRequests", [pull_stub(1, WATERMARK)], False, None, 2)}, 1),
            ({"page_0": self.batch_page("owner/repo", "pullRequests", [pull_stub(2, "invalid")], False, None, 2)}, 1),
            ({"page_0": self.batch_page("owner/repo", "pullRequests", [pull_stub(2, WATERMARK)], True, None, 2)}, 1),
        ]
        for continuation, attempts in cases:
            with self.subTest(continuation=continuation), self.assertRaises(GitHubApiError):
                responses = []
                for _ in range(attempts):
                    responses.append({"repo_0": copy.deepcopy(first)})
                    responses.append(copy.deepcopy(continuation))
                GitHubOrgReader(ScriptedClient(responses)).list_repos_changed_items(["owner/repo"], WATERMARK, {})

    def test_continuations_reject_cyclic_cursors(self) -> None:
        client = ScriptedClient([
            {"repo_0": self.batch_result("owner/repo", [], [pull_stub(1, WATERMARK)], pull_has_next=True, pull_cursor="first", pull_total_count=3)},
            {"page_0": self.batch_page("owner/repo", "pullRequests", [pull_stub(2, WATERMARK)], True, "second", 3)},
            {"page_0": self.batch_page("owner/repo", "pullRequests", [pull_stub(3, WATERMARK)], True, "first", 3)},
        ])
        with self.assertRaisesRegex(GitHubApiError, "cyclic page cursor"):
            GitHubOrgReader(client).list_repos_changed_items(["owner/repo"], WATERMARK, {})
        client.assert_exhausted()


def pull_with_threads(threads: list[dict]) -> dict:
    empty = {"pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": []}
    return {
        "fullDatabaseId": 200,
        "id": "P_200",
        "number": 7,
        "state": "OPEN",
        "title": "Test",
        "body": "",
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-02T00:00:00Z",
        "author": {"login": "other"},
        "assignees": {"pageInfo": {"hasNextPage": False}, "nodes": []},
        "comments": empty,
        "timelineItems": empty,
        "reviews": empty,
        "reviewRequests": empty,
        "commits": empty,
        "reviewThreads": {"pageInfo": {"hasNextPage": False, "endCursor": None}, "nodes": threads},
    }


def thread(thread_id: str, resolved: bool, outdated: bool, comments: list[dict],
           comments_next: bool = False) -> dict:
    return {
        "id": thread_id,
        "isResolved": resolved,
        "isOutdated": outdated,
        "comments": {
            "pageInfo": {"hasNextPage": comments_next, "endCursor": "cursor" if comments_next else None},
            "nodes": comments,
        },
    }


def thread_comment(comment_id: int, node_id: str, author: str) -> dict:
    return {
        "fullDatabaseId": comment_id,
        "id": node_id,
        "author": {"login": author},
        "body": "note",
        "path": "a.ts",
        "createdAt": "2026-01-02T00:00:00Z",
        "updatedAt": "2026-01-02T00:00:00Z",
    }


class PullReviewThreadTest(unittest.TestCase):
    def test_pr_query_carries_thread_resolution_without_new_requests(self) -> None:
        # The fields ride the existing pull request query; the sync issues
        # the same GraphQL calls with or without them.
        self.assertIn("isResolved", PR_BASE_QUERY)
        self.assertIn("isOutdated", PR_BASE_QUERY)

    def test_first_page_comments_carry_their_thread_without_paging(self) -> None:
        pull = pull_with_threads([
            thread("T_open", False, False, [thread_comment(1, "C_1", "reviewer")]),
            thread("T_done", True, False, [thread_comment(2, "C_2", "reviewer")]),
        ])
        client = ScriptedClient([])
        expanded = GitHubOrgReader(client)._expand_pull_graph({}, "Vaquum", "Test", 7, pull)
        client.assert_exhausted()
        self.assertEqual(
            [(row["node_id"], row["thread_node_id"], row["thread_resolved"], row["thread_outdated"])
             for row in expanded["review_comments"]],
            [("C_1", "T_open", False, False), ("C_2", "T_done", True, False)],
        )

    def test_paged_thread_comments_carry_their_thread(self) -> None:
        pull = pull_with_threads([
            thread("T_open", False, True, [thread_comment(1, "C_1", "reviewer")], comments_next=True),
        ])
        client = ScriptedClient([
            {"node": {"comments": {
                "pageInfo": {"hasNextPage": False, "endCursor": None},
                "nodes": [thread_comment(3, "C_3", "fixture-agent")],
            }}},
        ])
        expanded = GitHubOrgReader(client)._expand_pull_graph({}, "Vaquum", "Test", 7, pull)
        client.assert_exhausted()
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(
            [(row["node_id"], row["thread_node_id"], row["thread_resolved"], row["thread_outdated"])
             for row in expanded["review_comments"]],
            [("C_1", "T_open", False, True), ("C_3", "T_open", False, True)],
        )


if __name__ == "__main__":
    unittest.main()
