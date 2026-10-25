import contextlib
import io
import json
import sys
import tempfile
from importlib.resources import files
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch

from agent_interface.model_catalog import (
    CATALOG,
    CATALOG_PATH,
    ModelCatalogError,
    load_catalog,
)

import agent_interface
from agent_interface import catalog_refresh, chat
from agent_interface.model_catalog import Model


class TestModelCatalog(TestCase):
    def test_catalog_is_packaged_and_keyed_by_identity(self) -> None:
        packaged = files("agent_interface").joinpath("models.toml")
        self.assertTrue(packaged.is_file())
        self.assertEqual(CATALOG.resolve("opus-5-max").selector, "claude-opus-5")
        self.assertEqual(CATALOG.resolve("fable-5.1-xhigh").effort, "xhigh")
        self.assertEqual(CATALOG.resolve("gpt-6-astra-ultra").provider, "codex")
        self.assertEqual(CATALOG.resolve("gpt-5.6-sol-ultra").selector, "gpt-5.6-sol")
        self.assertEqual(CATALOG.resolve("grok-4.6-xhigh").provider, "grok")
        self.assertEqual(CATALOG.resolve("gemini-3.8-flash-high").selector, "gemini-3.8-flash")
        self.assertEqual(CATALOG.resolve("muse-spark-1.3-contributor-max").provider, "muse")
        self.assertEqual(CATALOG.behavior("pr_review").identity, "opus-5-high")
        self.assertEqual(CATALOG.resolve("fable-5.1-high").effort, "high")
        self.assertEqual(CATALOG.behavior("review_recovery").identity, "gpt-6-astra-ultra")
        self.assertEqual(CATALOG.behavior("author_content").identity, "opus-5-max")
        self.assertEqual(len(CATALOG.debate_participants), 5)
        for identity, model in CATALOG.models.items():
            self.assertEqual(identity, model.identity)
            self.assertTrue(identity.endswith(f"-{model.effort}"))

    def test_aliases_are_not_names(self) -> None:
        for value in ("opus", "astra", "gpt", "gemini", "grok", "maybe-latest"):
            with self.subTest(value=value), self.assertRaisesRegex(ModelCatalogError, "unknown model"):
                CATALOG.resolve(value)

    def test_unknown_model_fails_before_tracking_or_provider_launch(self) -> None:
        with (
            patch.object(agent_interface, "track") as track,
            patch.object(chat, "run") as provider,
            self.assertRaisesRegex(ModelCatalogError, "unknown model"),
        ):
            agent_interface.run_chat("opus", None, "prompt")
        track.assert_not_called()
        provider.assert_not_called()

    def test_every_provider_can_review(self) -> None:
        for model in CATALOG.models.values():
            with self.subTest(identity=model.identity):
                self.assertIs(CATALOG.review_model("pr_review", model.identity), model)
                self.assertIs(CATALOG.review_model("pr_approve", model.identity), model)
        self.assertEqual(CATALOG.export()["review_providers"], ["antigravity", "claude", "codex", "grok", "muse"])

    def test_each_family_keeps_its_top_efforts(self) -> None:
        lines = {}
        for model in CATALOG.models.values():
            lines.setdefault(model.selector, []).append(model.effort)
        self.assertEqual(lines, {
            "claude-opus-5": ["max", "xhigh", "high"],
            "claude-fable-5-1": ["max", "xhigh", "high"],
            "gpt-6-astra": ["ultra", "max"],
            "gpt-5.6-sol": ["ultra", "max"],
            "grok-4.6": ["xhigh", "high"],
            "gemini-3.8-flash": ["high", "medium"],
            "muse-spark-1.3-contributor": ["max", "xhigh"],
        })

    def test_muse_ordinary_selectors_cannot_enter_catalog_or_model(self) -> None:
        for selector in ("muse-spark-1.3", "muse-spark-1.3-contributor-paid", "contributor"):
            with self.subTest(selector=selector):
                self._reject(self._catalog().replace('selector = "muse-spark-1.3-contributor"', f'selector = "{selector}"'), "contributor")
                with self.assertRaisesRegex(ModelCatalogError, "contributor"):
                    Model("muse-test-max", "muse", selector, "max")

    def test_malformed_catalog_fails_loudly(self) -> None:
        self._reject("not = [valid", "cannot parse TOML")

    def test_missing_catalog_fails_loudly(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "missing.toml"
            with self.assertRaisesRegex(ModelCatalogError, "cannot read file"):
                load_catalog(path)

    def test_unknown_root_key_is_rejected(self) -> None:
        self._reject(self._catalog().replace("schema_version = 2\n", "schema_version = 2\nunexpected = true\n"), "root keys")

    def test_missing_behavior_assignment_is_rejected(self) -> None:
        self._reject(self._catalog().replace('pr_review = "opus-5-high"\n', ""), "behavior keys mismatch")

    def test_unknown_behavior_model_is_rejected(self) -> None:
        self._reject(self._catalog().replace('pr_review = "opus-5-high"', 'pr_review = "missing"'), "must name a configured model")

    def test_incompatible_behavior_provider_is_rejected(self) -> None:
        self._reject(self._catalog().replace('author_content = "opus-5-max"', 'author_content = "gpt-6-astra-ultra"'), "requires the Claude provider")
        self._reject(self._catalog().replace('debate_moderator = "opus-5-max"', 'debate_moderator = "grok-4.6-xhigh"'), "requires the Claude provider")

    def test_any_provider_may_review_and_recover(self) -> None:
        content = (self._catalog()
                   .replace('pr_review = "opus-5-high"', 'pr_review = "grok-4.6-xhigh"')
                   .replace('pr_approve = "opus-5-high"', 'pr_approve = "muse-spark-1.3-contributor-max"')
                   .replace('review_recovery = "gpt-6-astra-ultra"', 'review_recovery = "gemini-3.8-flash-high"'))
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "models.toml"
            path.write_text(content)
            catalog = load_catalog(path)
        self.assertEqual(catalog.behavior("pr_review").provider, "grok")
        self.assertEqual(catalog.behavior("pr_approve").provider, "muse")
        self.assertEqual(catalog.behavior("review_recovery").provider, "antigravity")

    def test_identity_must_carry_its_effort(self) -> None:
        self._reject(self._catalog().replace('[models."grok-4.6-high"]', '[models."grok-4.6-hi"]'), "must end with its effort")

    def test_provider_effort_vocabulary_is_enforced(self) -> None:
        self._reject(self._catalog().replace('[models."gemini-3.8-flash-high"]\nprovider = "antigravity"\nselector = "gemini-3.8-flash"\neffort = "high"',
                                              '[models."gemini-3.8-flash-ultra"]\nprovider = "antigravity"\nselector = "gemini-3.8-flash"\neffort = "ultra"'),
                     "invalid antigravity effort")

    def test_chat_provider_arguments_come_from_the_catalog(self) -> None:
        expected = {
            "opus-5-max": ("claude", ["--model", "claude-opus-5", "--effort", "max"]),
            "fable-5.1-xhigh": ("claude", ["--model", "claude-fable-5-1", "--effort", "xhigh"]),
            "gpt-6-astra-ultra": ("codex", ["--model", "gpt-6-astra", "-c", 'model_reasoning_effort="ultra"']),
            "gpt-5.6-sol-max": ("codex", ["--model", "gpt-5.6-sol", "-c", 'model_reasoning_effort="max"']),
            "grok-4.6-xhigh": ("grok", ["-m", "grok-4.6", "--effort", "xhigh"]),
            "gemini-3.8-flash-high": ("agy", ["--model", "gemini-3.8-flash", "--effort", "high"]),
            "muse-spark-1.3-contributor-max": ("muse", ["--model", "muse-spark-1.3-contributor", "--reasoning-effort", "max"]),
        }
        reply = json.dumps({"conversation_id": "c1", "status": "SUCCESS", "response": "ok\n"})
        for identity, (command, fragment) in expected.items():
            with self.subTest(identity=identity):
                stdout = reply if command == "agy" else "ok"
                completed = SimpleNamespace(returncode=0, stdout=stdout, stderr="")
                with patch.object(chat.subprocess, "run", return_value=completed) as run:
                    self.assertEqual(chat.run("/tmp", identity, None, "prompt"), "ok")
                argv = run.call_args.args[0]
                self.assertEqual(Path(argv[0]).name, command)
                rendered = " ".join(argv)
                self.assertIn(" ".join(fragment), rendered)
                self.assertNotIn("cursor", rendered)
                if command == "muse":
                    self.assertEqual(argv[argv.index("--contributor-mode") + 1], "on")
                else:
                    self.assertNotIn("--contributor-mode", argv)

    def test_antigravity_records_the_conversation_it_was_given_back(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            data = Path(root)
            with patch.object(chat, "DATA_DIR", data), patch.object(chat, "DB", data / "calls.sqlite3"):
                chat.set_session("s1", "gemini-3.8-flash-high", "old-conversation")
                reply = json.dumps({"conversation_id": "new-conversation", "status": "SUCCESS", "response": "hello"})
                completed = SimpleNamespace(returncode=0, stdout=reply, stderr='warning: conversation "old-conversation" not found\n')
                with patch.object(chat.subprocess, "run", return_value=completed) as run:
                    self.assertEqual(chat.run(root, "gemini-3.8-flash-high", "s1", "prompt"), "hello")
                argv = run.call_args.args[0]
                self.assertEqual(argv[argv.index("--conversation") + 1], "old-conversation")
                self.assertEqual(chat.get_session("s1", "gemini-3.8-flash-high"), "new-conversation")

    def test_antigravity_failure_status_is_an_error_even_at_exit_zero(self) -> None:
        reply = json.dumps({"conversation_id": "", "status": "ERROR", "response": "", "error": "invalid model selection"})
        completed = SimpleNamespace(returncode=0, stdout=reply, stderr="")
        with patch.object(chat.subprocess, "run", return_value=completed), self.assertRaisesRegex(RuntimeError, "invalid model selection"):
            chat.run("/tmp", "gemini-3.8-flash-high", None, "prompt")

    def test_grok_and_muse_reuse_one_stable_session_id(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            data = Path(root)
            with patch.object(chat, "DATA_DIR", data), patch.object(chat, "DB", data / "calls.sqlite3"):
                completed = SimpleNamespace(returncode=0, stdout="ok", stderr="")
                for identity, flag in (("grok-4.6-xhigh", "--session-id"), ("muse-spark-1.3-contributor-max", "--session-id")):
                    with self.subTest(identity=identity):
                        with patch.object(chat.subprocess, "run", return_value=completed) as run:
                            chat.run(root, identity, "s2", "first")
                            first = run.call_args.args[0]
                            chat.run(root, identity, "s2", "second")
                            second = run.call_args.args[0]
                        uuid = chat.stable_uuid("s2", identity)
                        self.assertEqual(first[first.index(flag) + 1], uuid)
                        resumed = "--resume" if identity.startswith("grok") else "--session-id"
                        self.assertEqual(second[second.index(resumed) + 1], uuid)

    @staticmethod
    def _catalog() -> str:
        return CATALOG_PATH.read_text()

    def _reject(self, content: str, message: str) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "models.toml"
            path.write_text(content)
            with self.assertRaisesRegex(ModelCatalogError, message):
                load_catalog(path)


class TestCatalogRefresh(TestCase):
    def setUp(self) -> None:
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.target = Path(self.work.name) / "models.toml"

    @staticmethod
    def probes(**overrides):
        current = {
            family: (lambda family=family: [m for m in CATALOG.models.values() if m.provider == family])
            for family in catalog_refresh.FAMILIES
        }
        current.update(overrides)
        return current

    def test_unchanged_sources_write_nothing(self) -> None:
        report = catalog_refresh.refresh(self.probes(), self.target)
        self.assertFalse(report["changed"])
        self.assertFalse(self.target.exists())
        self.assertEqual({f["status"] for f in report["families"].values()}, {"ok"})

    def test_new_version_moves_behaviors_to_the_same_tier(self) -> None:
        bumped = [
            Model("opus-5.1-max", "claude", "claude-opus-5-1", "max"),
            Model("opus-5.1-xhigh", "claude", "claude-opus-5-1", "xhigh"),
            Model("opus-5.1-high", "claude", "claude-opus-5-1", "high"),
            Model("fable-5.1-max", "claude", "claude-fable-5-1", "max"),
            Model("fable-5.1-xhigh", "claude", "claude-fable-5-1", "xhigh"),
            Model("fable-5.1-high", "claude", "claude-fable-5-1", "high"),
        ]
        report = catalog_refresh.refresh(self.probes(claude=lambda: bumped), self.target)
        self.assertTrue(report["changed"])
        self.assertEqual(report["added"], ["opus-5.1-high", "opus-5.1-max", "opus-5.1-xhigh"])
        self.assertEqual(report["removed"], ["opus-5-high", "opus-5-max", "opus-5-xhigh"])
        written = load_catalog(self.target)
        self.assertEqual(written.behaviors["pr_review"], "opus-5.1-high")
        self.assertEqual(written.behaviors["author_content"], "opus-5.1-max")
        self.assertEqual(written.debate_participants[0], "opus-5.1-max")
        self.assertEqual(written.behaviors["review_recovery"], "gpt-6-astra-ultra")

    def test_unavailable_family_keeps_its_rows(self) -> None:
        def broken():
            raise RuntimeError("agy: not signed in")
        report = catalog_refresh.refresh(self.probes(antigravity=broken), self.target)
        self.assertFalse(report["changed"])
        self.assertEqual(report["families"]["antigravity"]["status"], "unavailable")
        self.assertIn("not signed in", report["families"]["antigravity"]["error"])
        self.assertEqual(report["families"]["antigravity"]["models"], ["gemini-3.8-flash-high", "gemini-3.8-flash-medium"])

    def test_selected_families_skip_the_rest_without_moving_their_rows(self) -> None:
        report = catalog_refresh.refresh(self.probes(), self.target, families=["claude", "codex"])
        self.assertFalse(report["changed"])
        self.assertFalse(self.target.exists())
        self.assertEqual(report["families"]["claude"]["status"], "ok")
        self.assertEqual(report["families"]["codex"]["status"], "ok")
        for family in ("grok", "antigravity", "muse"):
            entry = report["families"][family]
            self.assertEqual(entry["status"], "skipped")
            self.assertEqual(entry["reason"], "never_configured")
            self.assertEqual(entry["models"], [m.identity for m in CATALOG.models.values() if m.provider == family])
        self.assertEqual(report["added"], [])
        self.assertEqual(report["removed"], [])

    def test_skipped_families_keep_pinned_debate_participants_on_a_selected_move(self) -> None:
        bumped = [
            Model("opus-5.1-max", "claude", "claude-opus-5-1", "max"),
            Model("opus-5.1-xhigh", "claude", "claude-opus-5-1", "xhigh"),
            Model("opus-5.1-high", "claude", "claude-opus-5-1", "high"),
            Model("fable-5.1-max", "claude", "claude-fable-5-1", "max"),
            Model("fable-5.1-xhigh", "claude", "claude-fable-5-1", "xhigh"),
            Model("fable-5.1-high", "claude", "claude-fable-5-1", "high"),
        ]
        report = catalog_refresh.refresh(self.probes(claude=lambda: bumped), self.target, families=["claude"])
        self.assertTrue(report["changed"])
        written = load_catalog(self.target)
        self.assertEqual(written.behaviors["pr_review"], "opus-5.1-high")
        self.assertIn("grok-4.6-xhigh", written.debate_participants)
        self.assertIn("gemini-3.8-flash-high", written.debate_participants)
        self.assertIn("muse-spark-1.3-contributor-max", written.debate_participants)
        self.assertNotIn("grok-4.6-xhigh", report["removed"])

    def test_explicit_empty_selection_probes_nothing(self) -> None:
        called: list[str] = []
        probes = {family: (lambda family=family: called.append(family)) for family in catalog_refresh.FAMILIES}
        report = catalog_refresh.refresh(probes, self.target, families=[])
        self.assertEqual(called, [])
        self.assertFalse(report["changed"])
        self.assertFalse(self.target.exists())
        self.assertEqual({entry["status"] for entry in report["families"].values()}, {"skipped"})

    def test_unknown_selected_family_fails(self) -> None:
        with self.assertRaisesRegex(ValueError, "unknown model family nope"):
            catalog_refresh.refresh(self.probes(), self.target, families=["claude", "nope"])

    def test_a_missing_codex_line_keeps_the_family_as_it_is(self) -> None:
        home = Path(self.work.name)
        (home / ".codex").mkdir()
        (home / ".codex" / "models_cache.json").write_text(json.dumps({"models": [
            {"slug": "gpt-6-astra", "priority": 1, "visibility": "list", "supported_reasoning_levels": ["max", "ultra"]},
        ]}))
        with patch.dict(catalog_refresh.os.environ, {"CODEX_HOME": str(home / ".codex")}):
            with self.assertRaisesRegex(RuntimeError, "no visible sol model"):
                catalog_refresh.codex()
            report = catalog_refresh.refresh(self.probes(codex=catalog_refresh.codex), self.target)
        self.assertFalse(report["changed"])
        self.assertEqual(report["families"]["codex"]["status"], "unavailable")
        self.assertEqual(report["families"]["codex"]["models"], ["gpt-6-astra-ultra", "gpt-6-astra-max", "gpt-5.6-sol-ultra", "gpt-5.6-sol-max"])

    def test_top_two_efforts_follow_each_provider_ladder(self) -> None:
        self.assertEqual(catalog_refresh.rank("codex", ["low", "medium", "high", "xhigh", "max", "ultra"]), ["ultra", "max"])
        self.assertEqual(catalog_refresh.rank("claude", ["low", "medium", "high", "xhigh", "max"]), ["max", "xhigh", "high"])
        self.assertEqual(catalog_refresh.rank("grok", ["xhigh", "high", "medium", "low"]), ["xhigh", "high"])
        self.assertEqual(catalog_refresh.rank("antigravity", ["medium", "high", "low"]), ["high", "medium"])
        self.assertEqual(catalog_refresh.rank("muse", ["max", "xhigh"]), ["max", "xhigh"])
        self.assertEqual(catalog_refresh.claude_identity_base("claude-fable-5-1"), "fable-5.1")
        self.assertEqual(catalog_refresh.claude_identity_base("claude-opus-5"), "opus-5")

    def test_claude_lines_come_from_the_local_model_cache(self) -> None:
        home = Path(self.work.name)
        cache = home / "config" / "cache" / "model-catalog"
        cache.mkdir(parents=True)
        options = [{"id": effort} for effort in ("low", "medium", "high", "xhigh", "max")]
        (cache / "org-cc.json").write_text(json.dumps({"catalog": {"config": {"models": [
            {"id": "claude-opus-5-5", "thinking": {"type": "effort", "effort_options": options}},
            {"id": "claude-opus-4-8", "thinking": {"type": "effort", "effort_options": options}},
            {"id": "claude-fable-5-1", "thinking": {"type": "effort", "effort_options": options}},
            {"id": "claude-haiku-4-5-20251001"},
        ]}}}))
        with patch.dict(catalog_refresh.os.environ, {"CLAUDE_CONFIG_DIR": str(home / "config")}):
            with patch.object(catalog_refresh, "run", side_effect=AssertionError("discovery must not run inference")):
                found = catalog_refresh.claude()
        self.assertEqual(
            [(m.identity, m.selector, m.effort) for m in found],
            [(f"opus-5.5-{effort}", "claude-opus-5-5", effort) for effort in ("max", "xhigh", "high")]
            + [(f"fable-5.1-{effort}", "claude-fable-5-1", effort) for effort in ("max", "xhigh", "high")],
        )

    def test_claude_without_a_cache_keeps_its_rows(self) -> None:
        home = Path(self.work.name)
        (home / "empty-config").mkdir()
        with patch.dict(catalog_refresh.os.environ, {"CLAUDE_CONFIG_DIR": str(home / "empty-config")}):
            report = catalog_refresh.refresh(self.probes(claude=catalog_refresh.claude), self.target)
        self.assertFalse(report["changed"])
        self.assertEqual(report["families"]["claude"]["status"], "unavailable")
        self.assertIn("model cache", report["families"]["claude"]["error"])
        self.assertEqual(
            report["families"]["claude"]["models"],
            ["opus-5-max", "opus-5-xhigh", "opus-5-high", "fable-5.1-max", "fable-5.1-xhigh", "fable-5.1-high"],
        )

    def test_sources_are_read_from_the_cli_caches(self) -> None:
        home = Path(self.work.name)
        (home / ".codex").mkdir()
        (home / ".codex" / "models_cache.json").write_text(json.dumps({"models": [
            {"slug": "gpt-6-astra", "priority": 1, "visibility": "list", "supported_reasoning_levels": [{"effort": e, "description": ""} for e in ("low", "medium", "high", "xhigh", "max", "ultra")]},
            {"slug": "gpt-reserve", "priority": 3, "visibility": "hide", "supported_reasoning_levels": ["low", "max"]},
            {"slug": "gpt-5.6-sol", "priority": 4, "visibility": "list", "supported_reasoning_levels": [{"effort": e, "description": ""} for e in ("low", "medium", "high", "xhigh", "max", "ultra")]},
            {"slug": "gpt-5.5-sol", "priority": 9, "visibility": "list", "supported_reasoning_levels": ["low", "high", "xhigh"]},
            {"slug": "gpt-5.6-terra", "priority": 7, "visibility": "list", "supported_reasoning_levels": ["low", "ultra"]},
        ]}))
        (home / ".grok").mkdir()
        (home / ".grok" / "models_cache.json").write_text(json.dumps({"models": {"grok-4.6": {"info": {"reasoning_efforts": [{"id": "xhigh"}, {"id": "high"}, {"id": "medium"}]}}}}))
        listing = SimpleNamespace(returncode=0, stdout="You are not authenticated.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n", stderr="")
        agy = SimpleNamespace(returncode=0, stdout="gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n", stderr="")
        with patch.dict(catalog_refresh.os.environ, {"CODEX_HOME": str(home / ".codex"), "GROK_HOME": str(home / ".grok")}):
            self.assertEqual([m.identity for m in catalog_refresh.codex()], ["gpt-6-astra-ultra", "gpt-6-astra-max", "gpt-5.6-sol-ultra", "gpt-5.6-sol-max"])
            with patch.object(catalog_refresh, "run", return_value=listing):
                self.assertEqual([m.identity for m in catalog_refresh.grok()], ["grok-4.6-xhigh", "grok-4.6-high"])
            with patch.object(catalog_refresh, "run", return_value=agy):
                found = catalog_refresh.antigravity()
        self.assertEqual([(m.identity, m.selector) for m in found], [("gemini-3.8-flash-high", "gemini-3.8-flash"), ("gemini-3.8-flash-medium", "gemini-3.8-flash")])


class TestMuseContributorDiscovery(TestCase):
    def setUp(self) -> None:
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.target = Path(self.work.name) / "models.toml"

    def test_discovery_host_explicitly_enables_contributor_mode(self) -> None:
        proc = MagicMock()
        listed = [{"modelId": "muse-spark-1.3-contributor"}]
        proc.stdout = [json.dumps({"id": 1, "result": {}}), json.dumps({"id": 2, "result": {"models": listed}})]
        with patch.object(catalog_refresh.subprocess, "Popen", return_value=proc) as spawn:
            self.assertEqual(catalog_refresh.muse_models(), listed)
        args = spawn.call_args.args[0]
        self.assertEqual(args[args.index("--contributor-mode") + 1], "on")
        proc.terminate.assert_called_once()

    def test_quality_levels_come_from_the_free_model_list(self) -> None:
        listed = [{"modelId": "muse-spark-1.3-contributor", "isDefault": True,
                   "variants": ["minimal", "low", "medium", "high", "xhigh", "max"]}]
        with patch.object(catalog_refresh, "muse_models", return_value=listed), \
             patch.object(catalog_refresh, "run", side_effect=AssertionError("discovery must not run inference")):
            found = catalog_refresh.muse()
        self.assertEqual(
            [(m.identity, m.selector, m.effort) for m in found],
            [("muse-spark-1.3-contributor-max", "muse-spark-1.3-contributor", "max"),
             ("muse-spark-1.3-contributor-xhigh", "muse-spark-1.3-contributor", "xhigh")],
        )

    def test_ordinary_default_yields_to_the_contributor_row(self) -> None:
        listed = [{"modelId": "muse-spark-1.3", "isDefault": True, "variants": ["max"]},
                  {"modelId": "muse-spark-1.3-contributor", "isDefault": False, "variants": ["high", "xhigh"]}]
        with patch.object(catalog_refresh, "muse_models", return_value=listed), \
             patch.object(catalog_refresh, "run", side_effect=AssertionError("discovery must not run inference")):
            found = catalog_refresh.muse()
        self.assertEqual({m.selector for m in found}, {"muse-spark-1.3-contributor"})
        self.assertEqual([m.effort for m in found], ["xhigh", "high"])

    def test_missing_contributor_fails_without_inference(self) -> None:
        for listed in ([], [{"modelId": "muse-spark-1.3", "isDefault": True, "variants": ["max"]}]):
            with self.subTest(listed=listed), \
                 patch.object(catalog_refresh, "muse_models", return_value=listed), \
                 patch.object(catalog_refresh, "run", side_effect=AssertionError("discovery must not run inference")):
                with self.assertRaisesRegex(RuntimeError, "no contributor"):
                    catalog_refresh.muse()

    def test_contributor_without_quality_levels_keeps_its_rows(self) -> None:
        listed = [{"modelId": "muse-spark-1.3-contributor", "isDefault": True}]
        with patch.object(catalog_refresh, "muse_models", return_value=listed):
            report = catalog_refresh.refresh(
                TestCatalogRefresh.probes(muse=catalog_refresh.muse),
                self.target,
            )
        self.assertFalse(report["changed"])
        self.assertEqual(report["families"]["muse"]["status"], "unavailable")
        self.assertIn("quality levels", report["families"]["muse"]["error"])


class TestRefreshModelsCommand(TestCase):
    def run_main(self, argv: list[str]):
        out = io.StringIO()
        with patch.object(sys, "argv", argv), \
                patch.object(catalog_refresh, "refresh", return_value={"families": {}}) as refresh, \
                contextlib.redirect_stdout(out):
            agent_interface.main()
        return refresh, json.loads(out.getvalue())

    def test_bare_refresh_probes_every_family(self) -> None:
        refresh, printed = self.run_main(["agent-interface", "--refresh-models"])
        refresh.assert_called_once_with()
        self.assertEqual(printed, {"families": {}})

    def test_families_selects_probed_families(self) -> None:
        refresh, _ = self.run_main(["agent-interface", "--refresh-models", "--families", "claude,codex"])
        refresh.assert_called_once_with(families=["claude", "codex"])

    def test_empty_families_probes_nothing(self) -> None:
        refresh, _ = self.run_main(["agent-interface", "--refresh-models", "--families", ""])
        refresh.assert_called_once_with(families=[])

    def test_unknown_family_and_stray_arguments_usage_error(self) -> None:
        for argv in (
            ["agent-interface", "--refresh-models", "--families", "claude,nope"],
            ["agent-interface", "--refresh-models", "--families"],
            ["agent-interface", "--refresh-models", "claude"],
        ):
            with self.subTest(argv=argv), \
                    patch.object(sys, "argv", argv), \
                    contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as stop:
                    agent_interface.main()
                self.assertEqual(stop.exception.code, 2)
