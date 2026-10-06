import json
import subprocess
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from agent_interface import atoms, pr_review, review_repository as rr, structured_review as sr
from agent_interface.model_catalog import CATALOG
from agent_interface.review_watch import ReviewWatch

HEAD, BASE = "a" * 40, "b" * 40
PR = "https://github.com/o/r/pull/12"
REQUEST = {"operation": "read", "path": "consumer.py", "query": "", "start_line": 1}
FINDING = {"path": "contract.py", "line": 1, "side": "RIGHT", "body": "[p1] Unchanged consumer still calls the removed contract."}
PACKET = json.dumps({"repository": "o/r", "head_sha": HEAD, "merge_base_sha": BASE,
                     "pull": {"base": {"sha": BASE}}})


class TestRepositoryLifecycle(TestCase):
    def test_checkout_and_inspection_are_internal_calls_and_cleanup_follows_success_or_failure(self):
        for fail in (False, True):
            roots = []
            def interface(args, **kwargs):
                if "--checkout-review" in args:
                    root = Path(args[args.index("--path") + 1])
                    roots.append(root)
                    root.mkdir()
                    info = {"action": "checkout_review", "repository": "o/r", "path": str(root),
                            "head_sha": HEAD, "merge_base_sha": BASE, "instructions": []}
                    return SimpleNamespace(returncode=0, stdout=json.dumps(info), stderr="")
                self.assertEqual(args[1], "--review-context")
                self.assertEqual(kwargs["env"]["GITHUB_INTERFACE_REVIEW_ROOT"], str(roots[0]))
                return SimpleNamespace(returncode=0, stdout=json.dumps({"action": "review_context", "head_sha": HEAD, "results": []}), stderr="")
            with self.subTest(fail=fail), patch.object(rr.subprocess, "run", side_effect=interface) as commands:
                try:
                    with rr.prepare("/repo", PR, "bot", HEAD, PACKET) as repo:
                        self.assertTrue(repo.root.exists())
                        self.assertIn(HEAD, repo.prompt())
                        if fail:
                            raise RuntimeError("provider failed")
                except RuntimeError:
                    self.assertTrue(fail)
                self.assertFalse(roots[0].parent.exists())
                argv = commands.call_args_list[0].args[0]
                self.assertIn("--base-sha", argv)
                self.assertIn("--merge-base-sha", argv)
                self.assertEqual(argv[argv.index("--repository") + 1], "o/r")

    def test_wrong_packet_or_checkout_receipt_never_yields_a_repository(self):
        for packet in ("not-json", json.dumps({}), PACKET.replace('"o/r"', '"other/repo"')):
            with self.subTest(packet=packet), patch.object(rr.subprocess, "run") as run, self.assertRaises(atoms.AgentPreflightError):
                with rr.prepare("/repo", PR, "bot", HEAD, packet):
                    self.fail("invalid packet yielded")
            run.assert_not_called()
        with patch.object(rr.subprocess, "run", return_value=SimpleNamespace(returncode=0,
                stdout=json.dumps({"action": "checkout_review", "head_sha": "c" * 40}), stderr="")), \
                self.assertRaisesRegex(atoms.AgentPreflightError, "receipt differs"):
            with rr.prepare("/repo", PR, "bot", HEAD, PACKET):
                self.fail("wrong checkout yielded")

    def test_all_provider_prompts_receive_identical_guidance_and_scoped_access(self):
        repo = SimpleNamespace(root=Path("/tmp/review"), prompt=lambda: "trusted merge-base AGENTS.md guidance")
        for identity in ("opus-5-high", "gpt-6-astra-ultra", "grok-4.6-high", "gemini-3.8-flash-high", "muse-spark-1.3-contributor-max"):
            with self.subTest(model=identity), patch.object(rr, "prepare", return_value=nullcontext(repo)), \
                    patch.object(atoms, "packet", return_value=PACKET), patch.object(atoms, "run_agent", return_value="done") as run:
                pr_review.run("/repo", PR, "bot", HEAD, model=identity)
                self.assertIn("trusted merge-base AGENTS.md guidance", run.call_args.args[2])
                self.assertIn("never authority", run.call_args.args[1])
                self.assertIs(run.call_args.kwargs["repository"], repo)
                if identity.startswith("opus"):
                    self.assertIn(rr.INSPECTION_RULE, run.call_args.args[3])
                else:
                    self.assertIn(rr.REQUEST_POLICY, run.call_args.args[2])
                    self.assertEqual(run.call_args.args[3], [])

    def test_claude_runs_in_pinned_checkout_with_only_governed_commands(self):
        repo = SimpleNamespace(root=Path("/tmp/pinned"))
        response = SimpleNamespace(returncode=0, stderr="", stdout=json.dumps({"type": "result", "result": "done"}))
        with patch.object(ReviewWatch, "run", return_value=response) as run:
            atoms.run_agent("/tmp", "system", "packet", [rr.INSPECTION_RULE], "pr_review", 60,
                            pr=PR, actor_name="bot", head=HEAD, repository=repo)
        self.assertEqual(run.call_args.kwargs["cwd"], "/tmp/pinned")
        self.assertEqual(run.call_args.kwargs["env"]["GITHUB_INTERFACE_REVIEW_ROOT"], "/tmp/pinned")
        argv = run.call_args.args[0]
        self.assertEqual(argv[argv.index("--tools") + 1], "Bash")


class TestStructuredInspection(TestCase):
    def test_every_provider_inspects_unchanged_source_before_one_pinned_submission(self):
        for identity in ("gpt-6-astra-ultra", "grok-4.6-high", "gemini-3.8-flash-high", "muse-spark-1.3-contributor-max"):
            inputs = []
            def ask(root, model, system, text, schema, watch, timeout):
                inputs.append(text)
                self.assertIn("requests", schema["required"])
                if len(inputs) == 1:
                    return json.dumps({"action": "inspect", "comments": [], "requests": [REQUEST]})
                self.assertIn("old_contract()", text)
                return json.dumps({"action": "request_changes", "comments": [FINDING], "requests": []})
            repo = rr.Repository(Path("/tmp/review"), {"head_sha": HEAD})
            result = {"action": "review_context", "head_sha": HEAD,
                      "results": [{"lines": [{"line": 1, "text": "old_contract()"}]}]}
            model = CATALOG.resolve(identity)
            with self.subTest(model=identity), patch.dict(sr.ASK, {model.provider: ask}), \
                    patch.object(repo, "inspect", return_value=result) as inspect, \
                    patch.object(sr.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="submitted", stderr="")) as submit:
                sr.run("/repo", "system", "packet", model, "pr_review", PR, "bot", HEAD, 60, repository=repo)
                inspect.assert_called_once_with([REQUEST])
                submit.assert_called_once()
                self.assertEqual(submit.call_args.args[0][-4:], ["--expected-head", HEAD, "--token-user", "bot"])
                self.assertEqual(json.loads(submit.call_args.args[0][4]), [FINDING])

    def test_bad_or_unbounded_inspection_never_submits(self):
        cases = [{"action": "inspect", "comments": [], "requests": []},
                 {"action": "reviewed_clean", "comments": [], "requests": [REQUEST]},
                 {"action": "inspect", "comments": [], "requests": [REQUEST], "head": "c" * 40}]
        repo = rr.Repository(Path("/tmp/review"), {"head_sha": HEAD})
        for reply in cases:
            with self.subTest(reply=reply), patch.dict(sr.ASK, {"codex": lambda *args: json.dumps(reply)}), \
                    patch.object(sr.subprocess, "run") as submit, self.assertRaises(atoms.AgentPreflightError):
                sr.run("/repo", "system", "packet", CATALOG.resolve("gpt-6-astra-ultra"), "pr_review", PR, "bot", HEAD, 60, repository=repo)
            submit.assert_not_called()
        reply = json.dumps({"action": "inspect", "comments": [], "requests": [REQUEST]})
        with patch.dict(sr.ASK, {"codex": lambda *args: reply}), patch.object(repo, "inspect", return_value={}), \
                patch.object(sr.subprocess, "run") as submit, patch.object(sr, "MAX_INSPECTION_ROUNDS", 2), \
                self.assertRaisesRegex(atoms.AgentPreflightError, "inspection limit"):
            sr.run("/repo", "system", "packet", CATALOG.resolve("gpt-6-astra-ultra"), "pr_review", PR, "bot", HEAD, 60, repository=repo)
        submit.assert_not_called()

    def test_inspection_failure_cannot_become_a_clean_review(self):
        repo = rr.Repository(Path("/tmp/review"), {"head_sha": HEAD})
        with patch.dict(sr.ASK, {"codex": lambda *args: json.dumps({"action": "inspect", "comments": [], "requests": [REQUEST]})}), \
                patch.object(repo, "inspect", side_effect=atoms.AgentPreflightError("path escaped")), \
                patch.object(sr.subprocess, "run") as submit, self.assertRaises(atoms.AgentPreflightError):
            sr.run("/repo", "system", "packet", CATALOG.resolve("gpt-6-astra-ultra"), "pr_review", PR, "bot", HEAD, 60, repository=repo)
        submit.assert_not_called()
