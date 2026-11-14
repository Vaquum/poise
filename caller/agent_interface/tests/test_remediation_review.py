"""Poise's trusted scope reaches both engines' real review submission path."""
import asyncio
import io
import json
import re
import shlex
import sqlite3
from contextlib import nullcontext, redirect_stdout
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

import agent_interface as api
from agent_interface import atoms, bash_guard, pr_approve, pr_review, review_receipt, review_repository, structured_review
from github_interface.atoms.review_response import parse_body
from github_interface.behaviors import approve_pr, request_changes, reviewed_clean


REPORT = Path(__file__).resolve().parents[3] / "server" / "behavior-chain-report.ts"
SCOPE = re.search(r"export const REMEDIATION_SCOPE = `([^`]+)`", REPORT.read_text())[1]
HEAD = "a" * 40
FINDING = {"path": "src/main.py", "line": 1, "side": "RIGHT", "body": "[p1] The new branch drops the requested update."}


@pytest.mark.parametrize("model", ["opus-5-high", "gpt-6-astra-ultra"])
@pytest.mark.parametrize("action", ["reviewed_clean", "request_changes", "approve"])
@pytest.mark.parametrize("scoped,echoes", [(True, 0), (True, 2), (False, 0)])
def test_remediation_review_submission(tmp_path, monkeypatch, model, action, scoped, echoes):
    monkeypatch.setattr(api, "DB", tmp_path / "calls.sqlite3")
    monkeypatch.setattr(api, "RESPONSES", tmp_path / "responses")
    api.init_db()
    call = "c" * 32
    behavior = "pr_approve" if action == "approve" else "pr_review"
    with sqlite3.connect(api.DB) as conn:
        conn.execute("insert into calls(id,started_at,status,actor,behavior,artifact) values (?,0,'running','reviewer',?,?)",
                     (call, behavior, json.dumps({"phase": "reviewing"})))
    review_receipt.bind(api.DB, call)
    for key, value in {"AGENT_INTERFACE_RECEIPT_DB": str(api.DB), "AGENT_INTERFACE_RECEIPT_CALL": call}.items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv("GITHUB_INTERFACE_AUTOMATED_REVIEWS", raising=False)
    lookalike = "A configurable lookalike must not replace the trusted scope." if scoped else SCOPE
    note = f"<!-- poise-remediation-scope -->\n{lookalike}\n<!-- /poise-remediation-scope -->"
    if scoped:
        note += f"\n\nApply this scope directive when reviewing the remediation.\n\n{SCOPE}"
    pull = {"state": "open", "draft": False, "user": {"login": "author"}, "head": {"sha": HEAD},
            "base": {"sha": "b" * 40}, "title": "Repair the report",
            "body": "Closes #99" if scoped else f"Closes #88\n<!-- poise-repair-exhaustion:{'d' * 64} -->\n{SCOPE}"}
    packet = json.dumps({"repository": "acme/repo", "pull_number": 22, "head_sha": HEAD, "pull": pull, "coverage": "complete",
                         "files": [{"filename": "src/main.py"}],
                         "diff": "diff --git a/src/main.py b/src/main.py\n--- a/src/main.py\n+++ b/src/main.py\n@@ -1 +1 @@\n-old\n+new\n"})
    assessment = {"verdict": "The changed state handling was inspected against its consumers." + ("\n\n" + SCOPE) * echoes,
                  "reviewed_context": "Inspected the supplied immutable diff and affected callers.",
                  "limitations": "Fixture providers and GitHub; no live provider or GitHub requests."}
    comments = [FINDING] if action == "request_changes" else []
    verdict = {"action": action, "comments": comments, "assessment": assessment}
    submitted, inputs, receipts = [], [], []

    class Client:
        async def get(self, path, **kwargs):
            assert path == "/repos/acme/repo/pulls/22"
            return pull

        async def post(self, path, *, json, **kwargs):
            assert path == "/repos/acme/repo/pulls/22/reviews"
            submitted.append(json)
            return {"id": 91, "state": {"COMMENT": "COMMENTED", "REQUEST_CHANGES": "CHANGES_REQUESTED", "APPROVE": "APPROVED"}[json["event"]],
                    "commit_id": HEAD, "user": {"login": "reviewer"}, "submitted_at": datetime.now(timezone.utc).isoformat()}

    flags = {"reviewed_clean": "--reviewed-clean", "request_changes": "--request-changes", "approve": "--approve-pr"}
    command = ["github-interface", flags[action], "#22"]
    if comments:
        command += ["--comments-json", json.dumps(comments)]
    command += ["--assessment-json", json.dumps(assessment), "--expected-head", HEAD, "--token-user", "reviewer"]

    def submit(argv, **kwargs):
        assert argv[0:3] == command[0:3]
        payload = {"repository": "acme/repo", "pr": "22", "expected_head": HEAD, "token_user": "reviewer",
                   "assessment": json.loads(argv[argv.index("--assessment-json") + 1]),
                   "comments": json.loads(argv[argv.index("--comments-json") + 1]) if "--comments-json" in argv else []}
        module = {"reviewed_clean": reviewed_clean, "request_changes": request_changes, "approve": approve_pr}[action]
        receipt = asyncio.run(module.run(Client(), payload))
        receipts.append(receipt)
        return SimpleNamespace(returncode=0, stdout=json.dumps(receipt), stderr="")

    class Watch:
        gate_path = None
        receipt_path = str(tmp_path / "review.json")

        def check_closed(self):
            return None

        def __enter__(self):
            return self

        def __exit__(self, *args):
            if Path(self.receipt_path).exists():
                review_receipt.record_file(self.receipt_path)

        def run(self, argv, **kwargs):
            inputs.append(kwargs["input"])
            with patch.dict("os.environ", {**kwargs["env"], "AGENT_INTERFACE_REVIEW_RECEIPT": self.receipt_path}), \
                    patch("sys.argv", ["bash_guard.py", shlex.join(command)]), redirect_stdout(io.StringIO()):
                with pytest.raises(SystemExit) as stopped:
                    bash_guard.main()
                assert stopped.value.code == 0
            return SimpleNamespace(returncode=0, stdout=json.dumps({"type": "result", "subtype": "success", "result": "Review submitted."}), stderr="")

    def ask(root, spec, system, text, schema, watch, timeout):
        inputs.append(text)
        return json.dumps({**verdict, **({"requests": []} if behavior == "pr_review" else {})})

    repository = SimpleNamespace(root=tmp_path, prompt=lambda: "Pinned repository fixture.")
    with patch.object(atoms, "packet", return_value=packet), patch.object(atoms, "last_reviewed_head", return_value=None), \
            patch.object(review_repository, "prepare", return_value=nullcontext(repository)), \
            patch("agent_interface.review_watch.ReviewWatch", lambda *args: Watch()), \
            patch.object(structured_review, "ReviewWatch", lambda *args: Watch()), \
            patch.dict(structured_review.ASK, {"codex": ask}), patch("subprocess.run", side_effect=submit), \
            patch.object(request_changes, "list_inline_comments", AsyncMock(return_value=[])), \
            patch.object(request_changes, "list_review_threads", AsyncMock(return_value=[])), \
            patch.object(approve_pr, "list_review_threads", AsyncMock(return_value=[])):
        module = pr_approve if behavior == "pr_approve" else pr_review
        spec = atoms.CATALOG.review_model(behavior, model)
        api._run_review_with_recovery(module, behavior, "https://github.com/acme/repo/pull/22", str(tmp_path),
                                      "reviewer", HEAD, note, 3600, None, spec, spec, {}, call,
                                      review_scope=SCOPE if scoped else "")

    assert len(inputs) == len(submitted) == len(receipts) == 1
    assert note in inputs[0]
    assert submitted[0]["body"].count(SCOPE) == int(scoped)
    assert "A configurable lookalike must not replace the trusted scope." not in submitted[0]["body"]
    assert submitted[0]["event"] == {"reviewed_clean": "COMMENT", "request_changes": "REQUEST_CHANGES", "approve": "APPROVE"}[action]
    assert submitted[0].get("comments", []) == comments
    response = parse_body(submitted[0]["body"])
    assert response == receipts[0]["review_response"]
    assert response["assessment"] == assessment
    assert response["invocation_id"] == call
    assert response["model"] == model
    assert submitted[0]["body"].endswith(f"<!-- poise-invocation {call} -->")
