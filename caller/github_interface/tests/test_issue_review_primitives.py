import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from github_interface import cli
from github_interface.atoms.local import checkout_repo
from github_interface.behaviors import issue_comments, sub_issues

PRD = """## Objective

Mentions #7 and Other/Repo#8, neither a slice.

## Work Slices

One slice: [S453 — feat(origo): expose totals](https://github.com/Vaquum/Origo/issues/453).
Also #454, Vaquum/Limen#12, the PR https://github.com/Vaquum/Origo/pull/451 and &#39;quoted&#39;.

### Notes inside the section

See #455.

## Risks

#456 is only a risk.
"""


class FakeClient:
    def __init__(self, issue: dict[str, Any], native: list[dict[str, Any]], comments: list[dict[str, Any]] | None = None):
        self.issue, self.native, self.comments = issue, native, comments or []

    async def get(self, path: str, **_: Any) -> Any:
        return self.issue

    async def paginate(self, path: str, params: dict[str, Any] | None = None) -> list[Any]:
        return self.native if path.endswith("/sub_issues") else self.comments


class TestSubIssues(IsolatedAsyncioTestCase):
    def test_only_links_under_work_slices_count(self) -> None:
        self.assertEqual(
            sub_issues.work_slices(PRD, "Vaquum/Origo"),
            [("Vaquum/Origo", 453), ("Vaquum/Origo", 454), ("Vaquum/Limen", 12), ("Vaquum/Origo", 455)],
        )
        self.assertEqual(sub_issues.work_slices("No sections at all, #1", "o/r"), [])

    def test_examples_and_other_owners_are_not_sub_issues(self) -> None:
        body = """\
```markdown
## Work Slices
Template example: #1
```

### 3. Work Slices:

- #20 and upstream/lib#9
<!-- was #21 -->
~~~sh
# not a heading, and #22 is only an example
~~~
- #23

## Risks
"""
        self.assertEqual(sub_issues.work_slices(body, "Vaquum/Origo"), [("Vaquum/Origo", 20), ("Vaquum/Origo", 23)])
        self.assertEqual(sub_issues.work_slices("## **Work Slices**\n- #5\n", "o/r"), [("o/r", 5)])

    async def test_native_and_work_slice_links_merge_without_the_issue_itself(self) -> None:
        client = FakeClient(
            # The same issues spelled differently, and the PRD itself.
            {"number": 452, "body": PRD.replace("See #455.", "See #455, vaquum/origo#453 and VAQUUM/ORIGO#452.")},
            [
                {"number": 453, "repository_url": "https://api.github.com/repos/Vaquum/Origo"},
                {"number": 9, "repository_url": "https://api.github.com/repos/Vaquum/Nexus"},
            ],
        )
        result = await sub_issues.run(client, {"issue": "#452", "repository": "Vaquum/Origo"})
        self.assertEqual(result["action"], "sub_issues")
        self.assertEqual(result["repository"], "Vaquum/Origo")
        self.assertEqual(result["issue_number"], 452)
        self.assertEqual(result["sub_issues"], [
            {"repository": "Vaquum/Limen", "issue_number": 12, "via": ["work_slices"]},
            {"repository": "Vaquum/Nexus", "issue_number": 9, "via": ["native"]},
            {"repository": "Vaquum/Origo", "issue_number": 453, "via": ["native", "work_slices"]},
            {"repository": "Vaquum/Origo", "issue_number": 454, "via": ["work_slices"]},
            {"repository": "Vaquum/Origo", "issue_number": 455, "via": ["work_slices"]},
        ])


class TestIssueComments(IsolatedAsyncioTestCase):
    async def test_comments_carry_author_body_and_url(self) -> None:
        client = FakeClient({}, [], [{
            "id": 5, "user": {"login": "zero-bang"}, "body": "Why?", "created_at": "2026-09-24T06:20:00Z",
            "updated_at": "2026-09-24T06:21:00Z", "html_url": "https://github.com/o/r/issues/1#issuecomment-5",
        }])
        result = await issue_comments.run(client, {"issue": "1", "repository": "o/r"})
        self.assertEqual(result, {
            "action": "issue_comments", "repository": "o/r", "issue_number": 1,
            "comments": [{"id": 5, "author": "zero-bang", "body": "Why?", "created_at": "2026-09-24T06:20:00Z",
                          "updated_at": "2026-09-24T06:21:00Z", "url": "https://github.com/o/r/issues/1#issuecomment-5"}],
        })


def git(*args: str, cwd: Path | None = None) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


class TestCheckoutRepo(TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp())
        self.source = self.root / "source"
        self.source.mkdir()
        git("init", "--quiet", "--initial-branch", "main", cwd=self.source)
        (self.source / "README.md").write_text("one\n")
        git("add", "README.md", cwd=self.source)
        git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "one", cwd=self.source)

    def test_clones_through_a_reused_mirror_with_full_history(self) -> None:
        first = checkout_repo("o", "r", "main", "secret", self.root / "a", root=self.root / "mirrors", remote=str(self.source))
        (self.source / "README.md").write_text("two\n")
        git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-am", "two", cwd=self.source)
        second = checkout_repo("o", "r", "main", "secret", self.root / "b", root=self.root / "mirrors", remote=str(self.source))
        self.assertEqual(first["branch"], "main")
        self.assertNotEqual(first["head_sha"], second["head_sha"])
        self.assertEqual(second["head_sha"], git("rev-parse", "HEAD", cwd=self.source))
        self.assertEqual(git("rev-list", "--count", "HEAD", cwd=self.root / "b"), "2")
        self.assertEqual(git("remote", "get-url", "origin", cwd=self.root / "b"), str(self.source))
        self.assertTrue((self.root / "mirrors" / "o" / "r.git" / "HEAD").exists())
        for config in (self.root / "b" / ".git" / "config", self.root / "mirrors" / "o" / "r.git" / "config"):
            self.assertNotIn("Authorization", config.read_text())

    def test_starts_a_broken_mirror_over(self) -> None:
        mirror = self.root / "mirrors" / "o" / "r.git"
        mirror.mkdir(parents=True)
        (mirror / "HEAD").write_text("not a repository\n")
        result = checkout_repo("o", "r", "main", "secret", self.root / "c", root=self.root / "mirrors", remote=str(self.source))
        self.assertEqual(result["head_sha"], git("rev-parse", "HEAD", cwd=self.source))
        self.assertEqual(git("rev-parse", "--is-bare-repository", cwd=mirror), "true")

    def test_refuses_an_existing_or_relative_path(self) -> None:
        (self.root / "taken").mkdir()
        with self.assertRaises(ValueError):
            checkout_repo("o", "r", "main", "secret", self.root / "taken", root=self.root / "mirrors", remote=str(self.source))
        with self.assertRaises(ValueError):
            checkout_repo("o", "r", "main", "secret", Path("relative"), root=self.root / "mirrors", remote=str(self.source))


class TestCli(TestCase):
    def _payload(self, argv: list[str], name: str) -> dict[str, Any]:
        behavior = AsyncMock(return_value={"ok": True})
        with patch.object(sys, "argv", ["github-interface", *argv]), patch.object(cli, name, behavior), \
                patch("builtins.print"):
            cli.main()
        return behavior.call_args.args[0]

    def test_issue_commands_accept_an_explicit_repository(self) -> None:
        for flag, name in (("--sub-issues", "sub_issues"), ("--issue-comments", "issue_comments"), ("--read-issue", "read_issue")):
            with self.subTest(flag=flag):
                payload = self._payload([flag, "#452", "--repository", "Vaquum/Origo"], name)
                self.assertEqual((payload["issue"], payload["repository"]), ("#452", "Vaquum/Origo"))
        payload = self._payload(["--comment-issue", "3", "--body", "Review", "--repository", "o/r"], "comment_issue")
        self.assertEqual((payload["issue"], payload["body"], payload["repository"]), ("3", "Review", "o/r"))
        self.assertIsNone(self._payload(["--read-issue", "3"], "read_issue")["repository"])

    def test_checkout_repo_takes_the_repository_and_a_path(self) -> None:
        payload = self._payload(["--checkout-repo", "Vaquum/Origo", "--path", "/tmp/x"], "checkout_repo")
        self.assertEqual((payload["repository"], payload["path"]), ("Vaquum/Origo", "/tmp/x"))
