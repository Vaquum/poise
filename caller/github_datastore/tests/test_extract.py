import unittest

from github_datastore.extract import extract_associations


def expanded_fixture() -> dict:
    return {
        "repo": {"id": 10, "node_id": "R_10", "full_name": "Vaquum/Test"},
        "is_pr": True,
        "issue": {
            "id": 100,
            "node_id": "I_100",
            "number": 7,
            "state": "open",
            "title": "Test",
            "body": "Ping @mikkokotila and @Vaquum/platform",
            "user": {"login": "other"},
            "assignees": [{"login": "mikkokotila"}],
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-02T00:00:00Z",
        },
        "pull": {
            "id": 200,
            "node_id": "P_200",
            "requested_reviewers": [{"login": "mikkokotila"}],
            "requested_teams": [{"name": "platform", "slug": "platform"}],
            "assignees": [],
            "merged_by": None,
            "updated_at": "2026-01-02T00:00:00Z",
        },
        "comments": [
            {
                "id": 300,
                "node_id": "C_300",
                "user": {"login": "other"},
                "body": "Also @mikkokotila",
                "created_at": "2026-01-03T00:00:00Z",
                "updated_at": "2026-01-03T00:00:00Z",
            }
        ],
        "timeline": [
            {
                "id": 400,
                "node_id": "E_400",
                "event": "review_requested",
                "actor": {"login": "other"},
                "requested_reviewer": {"login": "mikkokotila"},
                "requested_team": {"slug": "platform"},
                "created_at": "2026-01-04T00:00:00Z",
            }
        ],
        "reviews": [
            {
                "id": 500,
                "node_id": "R_500",
                "user": {"login": "mikkokotila"},
                "state": "APPROVED",
                "body": "",
                "submitted_at": "2026-01-05T00:00:00Z",
            }
        ],
        "review_comments": [
            {
                "id": 600,
                "node_id": "RC_600",
                "user": {"login": "other"},
                "body": "@mikkokotila look here",
                "created_at": "2026-01-06T00:00:00Z",
                "updated_at": "2026-01-06T00:00:00Z",
            }
        ],
        "commits": [
            {
                "sha": "abc",
                "author": {"login": "mikkokotila"},
                "committer": {"login": "other"},
                "commit": {
                    "author": {"name": "Mikko", "date": "2026-01-07T00:00:00Z"},
                    "committer": {"name": "Other", "date": "2026-01-07T00:00:00Z"},
                },
            }
        ],
    }


class ExtractAssociationsTest(unittest.TestCase):
    def test_extracts_only_direct_user_evidence(self) -> None:
        rows = extract_associations(expanded_fixture(), "mikkokotila")
        types = {row["association_type"] for row in rows}

        self.assertIn("assignee", types)
        self.assertIn("review_requested", types)
        self.assertIn("event_requested_reviewer:review_requested", types)
        self.assertIn("reviewer", types)
        self.assertIn("commit_author", types)
        self.assertIn("mention", types)
        self.assertNotIn("event_actor:review_requested", types)

        for row in rows:
            evidence = " ".join(
                str(row[key] or "")
                for key in ("evidence_text", "evidence_field", "association_type")
            )
            self.assertNotIn("platform", evidence)

    def test_other_user_gets_no_rows_without_direct_evidence(self) -> None:
        rows = extract_associations(expanded_fixture(), "absent-user")
        self.assertEqual(rows, [])

    def test_title_mentions_count(self) -> None:
        expanded = expanded_fixture()
        expanded["issue"]["title"] = "Needs @mikkokotila"
        rows = extract_associations(expanded, "mikkokotila")
        self.assertIn(
            ("mention", "issue", "title"),
            {(row["association_type"], row["evidence_kind"], row["evidence_field"]) for row in rows},
        )

    def test_event_without_github_id_gets_content_addressed_evidence(self) -> None:
        expanded = expanded_fixture()
        expanded["timeline"] = [
            {
                "event": "cross-referenced",
                "actor": {"login": "mikkokotila"},
                "created_at": "2026-01-04T00:00:00Z",
                "source": {"issue": {"node_id": "PR_1"}},
            }
        ]
        rows = extract_associations(expanded, "mikkokotila")
        event_rows = [row for row in rows if row["evidence_kind"] == "event"]
        self.assertEqual(len(event_rows), 1)
        self.assertTrue(event_rows[0]["evidence_id"].startswith("event:hash:"))


if __name__ == "__main__":
    unittest.main()
