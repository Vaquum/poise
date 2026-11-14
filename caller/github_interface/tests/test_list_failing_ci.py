import json
import os
import subprocess
import sys
import tempfile
from io import StringIO
from pathlib import Path
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import AsyncMock, patch

from github_interface import cli, interface
from github_interface.behaviors import list_failing_ci
from github_interface.identity import AGENT, PERSON

# The work monitor's CI read (server/chat/control.ts readWorkCi) shells out to
# the bundled CLI with this exact argv; the CLI must accept the explicit
# repository and return the bound PR's CI state for it.
HEAD = "b" * 40
SERVER_ARGV = ["github-interface", "--list-failing-ci", "9", "--repository", "acme/app",
               "--token-user", "fixture-agent"]
PULL = {"head": {"sha": HEAD}, "user": {"login": "fixture-agent"}, "draft": False,
        "mergeable": True, "mergeable_state": "behind", "base": {"ref": "main"},
        "state": "open", "merged": False}
CHECKS = [{"name": "Verify", "status": "completed", "conclusion": "failure", "id": 11,
           "details_url": "https://github.com/acme/app/actions/runs/1/job/22",
           "html_url": "https://github.com/acme/app/actions/runs/1",
           "output": {"summary": "failing"}}]
STATUSES = {"statuses": [{"context": "Legacy", "state": "error", "description": "boom",
                          "target_url": "https://example.invalid/legacy"}]}
NO_ACCOUNTS = {AGENT: "", PERSON: ""}


class FakeClient:
    def __init__(self, user: str) -> None:
        self.user = user


class TestListFailingCiCli(TestCase):
    def test_server_argv_returns_the_bound_prs_typed_ci_state(self) -> None:
        self.assertIn("--repository", cli._parser("--list-failing-ci").format_help())
        stdout, stderr = StringIO(), StringIO()
        with patch("sys.argv", SERVER_ARGV), patch.object(interface, "GitHubClient", FakeClient), \
                patch.object(list_failing_ci, "get_pull", AsyncMock(return_value=PULL)) as get_pull, \
                patch.object(list_failing_ci, "list_check_runs", AsyncMock(return_value=CHECKS)) as check_runs, \
                patch.object(list_failing_ci, "get_combined_status", AsyncMock(return_value=STATUSES)) as combined, \
                patch("sys.stdout", stdout), patch("sys.stderr", stderr):
            cli.main()
        self.assertEqual(stderr.getvalue(), "")
        state = json.loads(stdout.getvalue())
        self.assertEqual(state["action"], "list_failing_ci")
        self.assertEqual((state["repository"], state["pull_number"], state["head_sha"]),
                         ("acme/app", 9, HEAD))
        self.assertIsInstance(state["head_sha"], str)
        self.assertEqual([(check["name"], check["state"]) for check in state["failing"]],
                         [("Verify", "completed"), ("Legacy", "error")])
        # Merge state, author, draft and pull state ride the same get_pull
        # response; the monitor's conflict/behind/terminal read adds no
        # GitHub request.
        self.assertEqual(state["mergeable"], True)
        self.assertEqual(state["mergeable_state"], "behind")
        self.assertEqual(state["author"], "fixture-agent")
        self.assertEqual(state["draft"], False)
        self.assertEqual(state["base"], "main")
        self.assertEqual(state["state"], "open")
        self.assertEqual(state["merged"], False)
        get_pull.assert_awaited_once()
        self.assertEqual(get_pull.call_args.args[1:], ("acme", "app", 9))
        check_runs.assert_awaited_once()
        self.assertEqual(check_runs.call_args.args[1:], ("acme", "app", HEAD))
        combined.assert_awaited_once()
        self.assertEqual(combined.call_args.args[1:], ("acme", "app", HEAD))

    def test_wrong_repository_fails_clearly_without_touching_github(self) -> None:
        for repository in ("acme", "acme/app/extra"):
            with self.subTest(repository=repository):
                stdout, stderr = StringIO(), StringIO()
                argv = ["github-interface", "--list-failing-ci", "9", "--repository", repository,
                        "--token-user", "fixture-agent"]
                with patch("sys.argv", argv), patch.object(interface, "GitHubClient", FakeClient), \
                        patch.object(list_failing_ci, "get_pull", AsyncMock()) as get_pull, \
                        patch("sys.stdout", stdout), patch("sys.stderr", stderr):
                    with self.assertRaises(SystemExit) as exited:
                        cli.main()
                self.assertEqual(exited.exception.code, 1)
                self.assertEqual(stderr.getvalue().strip(), "error: repository must look like org/repo")
                self.assertEqual(stdout.getvalue(), "")
                get_pull.assert_not_awaited()

    def test_missing_account_identity_fails_naming_the_variable_to_set(self) -> None:
        stdout, stderr = StringIO(), StringIO()
        argv = ["github-interface", "--list-failing-ci", "9", "--repository", "acme/app"]
        with patch("sys.argv", argv), patch.dict(os.environ, NO_ACCOUNTS), \
                patch.object(list_failing_ci, "get_pull", AsyncMock()) as get_pull, \
                patch("sys.stdout", stdout), patch("sys.stderr", stderr):
            with self.assertRaises(SystemExit) as exited:
                cli.main()
        self.assertEqual(exited.exception.code, 1)
        self.assertEqual(stderr.getvalue().strip(),
                         f"error: no GitHub account to act as: pass --token-user or set {AGENT}")
        get_pull.assert_not_awaited()

    def test_bare_pr_keeps_resolving_the_repository_from_the_checkout(self) -> None:
        operation = AsyncMock(return_value={"ok": True})
        with patch("sys.argv", ["github-interface", "--list-failing-ci", "#9"]), \
                patch.object(cli, "list_failing_ci", operation), patch("sys.stdout", StringIO()):
            cli.main()
        self.assertEqual(operation.call_args.args[0], {"pr": "#9", "repository": None, "token_user": None})

    def test_base_update_proof_option_reaches_the_existing_ci_read(self):
        operation = AsyncMock(return_value={"ok": True})
        with patch("sys.argv", [*SERVER_ARGV, "--base-update-from", "d" * 40]), \
                patch.object(cli, "list_failing_ci", operation), patch("sys.stdout", StringIO()):
            cli.main()
        self.assertEqual(operation.call_args.args[0]["base_update_from"], "d" * 40)


class TestIntegrationCi(IsolatedAsyncioTestCase):
    async def test_base_update_requires_the_clean_merge_tree_and_a_parent_from_the_pr_base(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def git(*args):
                return subprocess.check_output(["git", *args], cwd=root, env=list_failing_ci._env("fixture-token"),
                                               stderr=subprocess.STDOUT).decode().strip()

            def commit(message):
                git("add", ".")
                git("commit", "--quiet", "-m", message)
                return git("rev-parse", "HEAD")

            git("init", "--quiet", "--initial-branch=main")
            git("config", "user.name", "Fixture")
            git("config", "user.email", "fixture@example.invalid")
            path = root / "shared.txt"
            path.write_text("start\n" + "unchanged\n" * 10 + "end\n")
            original = commit("original base")
            git("checkout", "--quiet", "-b", "repair")
            path.write_text(path.read_text().replace("start", "repair"))
            failed = commit("failed repair head")
            git("checkout", "--quiet", "main")
            path.write_text(path.read_text().replace("end", "base fix"))
            base = commit("base fix")
            git("checkout", "--quiet", "repair")
            git("merge", "--quiet", "--no-ff", "main", "-m", "update branch")
            updated, tree = git("rev-parse", "HEAD"), git("rev-parse", "HEAD^{tree}")
            # Same parents and merge message, but with an extra branch edit.
            (root / "extra.txt").write_text("unreviewed edit\n")
            git("add", ".")
            edited = git("commit-tree", git("write-tree"), "-p", failed, "-p", base, "-m", "update branch")
            reversed_parents = git("commit-tree", tree, "-p", base, "-p", failed, "-m", "update branch")
            ordinary_edit = git("commit-tree", tree, "-p", updated, "-m", "branch edit")
            octopus = git("commit-tree", tree, "-p", failed, "-p", base, "-p", original, "-m", "update branch")
            git("reset", "--hard", "--quiet", original)
            path.write_text(path.read_text().replace("start", "conflicting base edit"))
            conflicting_base = commit("conflicting base")
            resolved = git("commit-tree", tree, "-p", failed, "-p", conflicting_base, "-m", "update branch")
            # The base may have advanced after the clean update.
            git("checkout", "--quiet", "main")
            (root / "later.txt").write_text("later base change\n")
            later_base = commit("later base")
            original_git = list_failing_ci._git

            def local_git(cwd, env, *args, **kwargs):
                if args[:2] == ("remote", "add"):
                    args = (*args[:-1], root.as_uri())
                return original_git(cwd, env, *args, **kwargs)

            for head, current_base, accepted in [(updated, base, True), (updated, later_base, True),
                                                  (edited, base, False), (reversed_parents, base, False),
                                                  (ordinary_edit, base, False), (octopus, base, False),
                                                  (resolved, conflicting_base, False), (resolved, base, False)]:
                with self.subTest(head=head, base=current_base):
                    client = AsyncMock(token="fixture-token")
                    client.get.return_value = {"sha": head, "parents": [{"sha": parent} for parent in git("show", "-s", "--format=%P", head).split()],
                                               "commit": {"tree": {"sha": git("rev-parse", f"{head}^{{tree}}")}}}
                    pull = {**PULL, "head": {"sha": head}, "base": {"ref": "main", "sha": current_base}}
                    with patch.object(list_failing_ci, "_git", side_effect=local_git), \
                            patch.object(list_failing_ci, "get_pull", AsyncMock(return_value=pull)) as pulls, \
                            patch.object(list_failing_ci, "list_check_runs", AsyncMock(return_value=[])), \
                            patch.object(list_failing_ci, "get_combined_status", AsyncMock(return_value={"statuses": []})):
                        result = await list_failing_ci.run(client, {"repository": "acme/app", "pr": 9, "base_update_from": failed})
                    self.assertEqual((result["head_sha"], result["ref"], result["base_sha"]), (head, head, current_base))
                    self.assertEqual(result["base_update"], {"from": failed, "base": base, "tree": tree} if accepted else None)
                    self.assertEqual(pulls.await_count, 2)

    async def test_base_update_rejects_a_head_or_base_change_during_proof_reads(self):
        base, failed = "c" * 40, "d" * 40
        pull = {**PULL, "base": {"sha": base}}
        for changed in ("head", "base"):
            with self.subTest(changed=changed):
                client = AsyncMock()
                client.get.return_value = {"sha": HEAD, "parents": [{"sha": failed}, {"sha": base}]}
                with patch.object(list_failing_ci, "get_pull", AsyncMock(side_effect=[pull, {**pull, changed: {"sha": "e" * 40}}])), \
                        patch.object(list_failing_ci, "list_check_runs", AsyncMock(return_value=[])), \
                        patch.object(list_failing_ci, "get_combined_status", AsyncMock(return_value={"statuses": []})), \
                        patch.object(list_failing_ci, "_base_update", AsyncMock(return_value={"from": failed, "base": base, "tree": "f" * 40})):
                    with self.assertRaisesRegex(RuntimeError, "head or base changed"):
                        await list_failing_ci.run(client, {"repository": "acme/app", "pr": 9, "base_update_from": failed})

    async def test_base_update_rejects_missing_or_mismatched_commit_identity(self):
        for identity in (None, "e" * 40):
            with self.subTest(identity=identity):
                client = AsyncMock()
                client.get.return_value = {"sha": identity, "parents": []}
                with patch.object(list_failing_ci, "get_pull", AsyncMock(return_value={**PULL, "base": {"sha": "c" * 40}})), \
                        patch.object(list_failing_ci, "list_check_runs", AsyncMock(return_value=[])), \
                        patch.object(list_failing_ci, "get_combined_status", AsyncMock(return_value={"statuses": []})):
                    with self.assertRaisesRegex(RuntimeError, "commit differs from the inspected head"):
                        await list_failing_ci.run(client, {"repository": "acme/app", "pr": 9, "base_update_from": "d" * 40})

    async def test_exact_ref_retains_candidate_base_parents_and_paginated_workflow_identity(self):
        integration, base = "c" * 40, "d" * 40
        check = {**CHECKS[0], "head_sha": integration}
        client = AsyncMock()
        client.get.side_effect = [{"parents": [{"sha": base}, {"sha": HEAD}]},
                                  {"workflow_runs": [{"id": n, "head_sha": integration, "event": "merge_group"} for n in range(100)]},
                                  {"workflow_runs": [{"id": 101, "head_sha": integration, "event": "merge_group",
                                                      "status": "completed", "conclusion": "success", "run_attempt": 2}]}]
        with patch.object(list_failing_ci, "get_pull", AsyncMock(return_value={**PULL, "base": {"ref": "main", "sha": base}})), \
                patch.object(list_failing_ci, "list_check_runs", AsyncMock(return_value=[check])) as checks, \
                patch.object(list_failing_ci, "get_combined_status", AsyncMock(return_value={"statuses": []})):
            result = await list_failing_ci.run(client, {"repository": "acme/app", "pr": 9, "ref": integration})
        self.assertEqual((result["head_sha"], result["ref"], result["base_sha"]), (HEAD, integration, base))
        self.assertEqual(result["parents"], [base, HEAD])
        self.assertEqual(len(result["runs"]), 101)
        self.assertEqual({key: result["runs"][-1][key] for key in ("status", "conclusion", "run_attempt")},
                         {"status": "completed", "conclusion": "success", "run_attempt": 2})
        self.assertEqual(result["failing"][0]["run_id"], 1)
        self.assertEqual(result["failing"][0]["log_id"], 22)
        self.assertEqual(checks.call_args.args[1:], ("acme", "app", integration))
        self.assertEqual(checks.call_args.kwargs, {"all_runs": True})
        self.assertEqual(client.get.call_args.kwargs["params"]["page"], 2)

    async def test_base_ref_observes_current_base_and_missing_base_never_falls_back_to_head(self):
        base = "c" * 40
        client = AsyncMock()
        client.get.side_effect = [{"parents": []}, {"workflow_runs": []}]
        with patch.object(list_failing_ci, "get_pull", AsyncMock(return_value={**PULL, "base": {"sha": base}})), \
                patch.object(list_failing_ci, "list_check_runs", AsyncMock(return_value=[])) as checks, \
                patch.object(list_failing_ci, "get_combined_status", AsyncMock(return_value={"statuses": []})):
            result = await list_failing_ci.run(client, {"repository": "acme/app", "pr": 9, "ref": "base"})
        self.assertEqual(result["ref"], base)
        self.assertEqual(checks.call_args.args[-1], base)
        with patch.object(list_failing_ci, "get_pull", AsyncMock(return_value=PULL)):
            with self.assertRaisesRegex(ValueError, "CI ref"):
                await list_failing_ci.run(client, {"repository": "acme/app", "pr": 9, "ref": "base"})
