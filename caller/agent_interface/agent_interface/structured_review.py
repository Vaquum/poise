"""Structured verdicts, submitted only through the governed GitHub interface.

Claude reviews with governed tools (claude_acl). Every other provider —
Codex, Grok Build, Antigravity, Muse — gets the same immutable packet with
no tools, in an empty work directory, and answers with one JSON verdict that
Caller validates and submits. A run that used a tool, failed, or answered
anything but the verdict submits nothing.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path

from .atoms import AgentPreflightError, actor, expected_head, pr_ref
from .model_catalog import Model
from .review_watch import ReviewWatch
from . import progress, review_budget, review_receipt


def verdict_schema(behavior: str) -> dict:
    terminal = "reviewed_clean" if behavior == "pr_review" else "approve"
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["action", "comments"],
        "properties": {
            "action": {"type": "string", "enum": ["request_changes", terminal]},
            "comments": {
                "type": "array", "maxItems": 100,
                "items": {
                    "type": "object", "additionalProperties": False,
                    "required": ["path", "line", "side", "body"],
                    "properties": {
                        "path": {"type": "string", "minLength": 1},
                        "line": {"type": "integer", "minimum": 1},
                        "side": {"type": "string", "enum": ["LEFT", "RIGHT"]},
                        "body": {"type": "string", "minLength": 1},
                    },
                },
            },
        },
    }


def validate_verdict(raw: str, behavior: str) -> dict:
    verdict = json.loads(raw)
    terminal = "reviewed_clean" if behavior == "pr_review" else "approve"
    if not isinstance(verdict, dict) or set(verdict) != {"action", "comments"}:
        raise ValueError("review verdict must contain only action and comments")
    action, comments = verdict["action"], verdict["comments"]
    if action not in ("request_changes", terminal) or not isinstance(comments, list):
        raise ValueError("invalid review action or comments")
    if len(comments) > 100 or bool(comments) != (action == "request_changes"):
        raise ValueError("request_changes requires 1-100 findings; other verdicts require none")
    for comment in comments:
        if not isinstance(comment, dict) or set(comment) != {"path", "line", "side", "body"}:
            raise ValueError("invalid inline finding fields")
        if any(not isinstance(comment[k], str) or not comment[k].strip() for k in ("path", "body")):
            raise ValueError("finding path and body must be non-empty strings")
        if type(comment["line"]) is not int or comment["line"] < 1 or comment["side"] not in ("LEFT", "RIGHT"):
            raise ValueError("invalid inline finding location")
    return verdict


def unfenced(text: str) -> str:
    # A provider without schema enforcement may still wrap the object in a
    # code fence; anything else around it is not a verdict.
    lines = text.strip().splitlines()
    if len(lines) >= 2 and lines[0].startswith("```") and lines[-1].strip() == "```":
        return "\n".join(lines[1:-1]).strip()
    return text.strip()


def instructions(schema: dict) -> str:
    return ("\n\nAnswer with exactly one JSON object matching this schema, and nothing else — "
            f"no prose, no code fence:\n{json.dumps(schema)}")


def events(stdout: str) -> list[dict]:
    found = []
    for line in stdout.splitlines():
        if not line.strip():
            continue
        event = json.loads(line)
        if not isinstance(event, dict):
            raise ValueError("invalid provider event")
        found.append(event)
    return found


def run(pwd: str, system: str, text: str, model: Model, behavior: str,
        pr: str, actor_name: str, head: str, timeout_s: int) -> str:
    # Target and credentials are controller-owned, never model output.
    fixed = ["--expected-head", expected_head(head), "--token-user", actor(actor_name)]
    ref = pr_ref(pr)
    ask = ASK.get(model.provider)
    if ask is None:
        raise AgentPreflightError(f"{model.provider} cannot return a structured review verdict")
    try:
        with tempfile.TemporaryDirectory(prefix="agent-interface-review-") as work, \
                ReviewWatch(pwd, pr, actor_name, head) as watch:
            root = Path(work)
            schema = verdict_schema(behavior)
            (root / "verdict.schema.json").write_text(json.dumps(schema))
            timeout = review_budget.timeout(timeout_s, reserve=review_budget.FINAL_CHECK_SECONDS)
            raw = ask(root, model, system, text, schema, watch, timeout)
            progress.stage("validating", "Validating review result")
            verdict = validate_verdict(raw, behavior)
    except subprocess.TimeoutExpired as error:
        raise review_budget.ReviewLimitError("Review reached its total time limit; needs attention", "review_budget_exhausted") from error
    except (ValueError, OSError) as error:
        raise AgentPreflightError(f"{model.provider} review produced no submitted verdict: {error}") from error

    flag = {"request_changes": "--request-changes", "reviewed_clean": "--reviewed-clean",
            "approve": "--approve-pr"}[verdict["action"]]
    args = [os.getenv("GITHUB_INTERFACE_CLI", "github-interface"), flag, ref]
    if verdict["action"] == "request_changes":
        args.extend(["--comments-json", json.dumps(verdict["comments"])])
    limit = review_budget.timeout(600)
    progress.stage("submitting", "Submitting GitHub review", timeout=limit)
    done = subprocess.run([*args, *fixed], cwd=pwd, text=True, capture_output=True, timeout=limit)
    if done.returncode == 0:
        review_receipt.record(done.stdout)
    # The outer governed behavior reads authoritative review facts afterward,
    # including head supersession when GitHub correctly rejects a stale verdict.
    return raw.strip() + "\n" + (done.stdout or done.stderr).strip()


# ── Codex ─────────────────────────────────────────────────────────────
def ask_codex(root: Path, model: Model, system: str, text: str, schema: dict, watch: ReviewWatch, timeout: float) -> str:
    output = root / "verdict.json"
    args = [
        os.getenv("CODEX_CLI", "codex"), "exec",
        "--ignore-user-config", "--ignore-rules", "--ephemeral",
        "--skip-git-repo-check", "--sandbox", "read-only",
        "--model", model.selector,
        "-c", f'model_reasoning_effort="{model.effort}"',
        "-c", 'approval_policy="never"',
        "-c", 'forced_login_method="chatgpt"',
        "-c", 'web_search="disabled"',
        "-c", "project_doc_max_bytes=0",
        "-c", "skills.include_instructions=false",
        "--output-schema", str(root / "verdict.schema.json"), "--output-last-message", str(output),
        "--json",
    ]
    # No shell, connectors, extensions, or delegated agents. The empty
    # work directory also prevents loading PR checkout instructions.
    for feature in ("shell_tool", "unified_exec", "apps", "plugins", "hooks",
                    "multi_agent", "browser_use", "computer_use", "image_generation",
                    "code_mode", "code_mode_host", "skill_search"):
        args.extend(["--disable", feature])
    env = os.environ.copy()
    for key in ("OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"):
        env.pop(key, None)
    done = watch.run([*args, "-"], input=f"{system}\n\n{text}", cwd=str(root), timeout=timeout, env=env, provider="codex")
    if done.returncode:
        raise ValueError((done.stderr or done.stdout).strip() or f"codex exited {done.returncode}")
    # A tool-using response is outside this adapter's contract. Never
    # submit its verdict, even if the provider returned exit code zero.
    # Item-level errors can be startup notices about disabled tools;
    # turn failures and actual tool executions still reject the verdict.
    for event in events(done.stdout):
        if event.get("type") in {"error", "turn.failed"}:
            raise ValueError("Codex review did not complete successfully")
        item = event.get("item") or {}
        if not isinstance(item, dict):
            raise ValueError("invalid Codex review item")
        kind = item.get("type", "")
        if not isinstance(kind, str) or (kind and kind not in {"agent_message", "reasoning", "todo_list", "error"}):
            raise ValueError(f"unexpected Codex review item: {kind}")
    return output.read_text()


# ── Grok Build ────────────────────────────────────────────────────────
def ask_grok(root: Path, model: Model, system: str, text: str, schema: dict, watch: ReviewWatch, timeout: float) -> str:
    prompt = root / "prompt.txt"
    prompt.write_text(f"{system}\n\n{text}{instructions(schema)}")
    args = [
        os.getenv("GROK_CLI", "grok"),
        "--prompt-file", str(prompt),
        "-m", model.selector, "--effort", model.effort,
        "--json-schema", json.dumps(schema), "--output-format", "json",
        # One turn with no tools: a tool request would need a second turn,
        # which ends the run without a structured answer.
        "--permission-mode", "dontAsk", "--tools", "", "--disable-web-search",
        "--no-subagents", "--no-plan", "--max-turns", "1",
        "--cwd", str(root),
    ]
    done = watch.run(args, input="", cwd=str(root), timeout=timeout, env=os.environ.copy(), provider=None)
    if done.returncode:
        raise ValueError((done.stderr or done.stdout).strip() or f"agent exited {done.returncode}")
    reply = json.loads(done.stdout)
    if not isinstance(reply, dict) or reply.get("stopReason") != "end_turn" or reply.get("num_turns") != 1:
        raise ValueError("Grok review did not complete in one tool-free turn")
    if not isinstance(reply.get("structuredOutput"), dict):
        raise ValueError("Grok review returned no structured verdict")
    return json.dumps(reply["structuredOutput"])


# ── Antigravity (Gemini) ──────────────────────────────────────────────
def ask_antigravity(root: Path, model: Model, system: str, text: str, schema: dict, watch: ReviewWatch, timeout: float) -> str:
    # The prompt travels on stdin as one stream-json message; an argument
    # would not fit a full packet. Plan mode keeps the agent from acting.
    args = [
        os.getenv("ANTIGRAVITY_CLI", "agy"),
        "--print=", "--input-format", "stream-json", "--output-format", "stream-json",
        "--model", model.selector, "--effort", model.effort,
        "--mode", "plan",
        "--json-schema", str(root / "verdict.schema.json"),
        "--print-timeout", f"{max(1, int(timeout))}s",
    ]
    message = {"event": "user", "message": {"role": "user", "content": f"{system}\n\n{text}{instructions(schema)}"}}
    done = watch.run(args, input=json.dumps(message) + "\n", cwd=str(root), timeout=timeout, env=os.environ.copy(), provider="antigravity")
    if done.returncode:
        raise ValueError((done.stderr or done.stdout).strip() or f"agy exited {done.returncode}")
    # With a schema the CLI adds a turn of its own to shape the answer, so
    # turns prove nothing; the steps do. A tool step, even one headless mode
    # auto-denied, is outside this adapter's contract.
    result = None
    for event in events(done.stdout):
        kind = event.get("event")
        if kind == "step_update":
            step = (event.get("step_update") or {}).get("step_type")
            if step not in {"user_input", "agent_response", "finish"}:
                raise ValueError(f"Antigravity review used a tool: {step}")
        elif kind == "result":
            result = event.get("result")
    if not isinstance(result, dict):
        raise ValueError("Antigravity review returned no result")
    if result.get("status") != "SUCCESS":
        raise ValueError(result.get("error") or f"Antigravity review ended with status {result.get('status')!r}")
    if not isinstance(result.get("structured_output"), dict):
        raise ValueError("Antigravity review returned no structured verdict")
    return json.dumps(result["structured_output"])


# ── Muse ──────────────────────────────────────────────────────────────
def ask_muse(root: Path, model: Model, system: str, text: str, schema: dict, watch: ReviewWatch, timeout: float) -> str:
    prompt = root / "prompt.txt"
    prompt.write_text(f"{system}\n\n{text}{instructions(schema)}")
    args = [
        os.getenv("MUSE_CLI", "muse"), "exec",
        "--prompt-file", str(prompt),
        "--model", model.selector, "--reasoning-effort", model.effort,
        "--disable-shell", "--disable-write", "--disable-web-tools",
        "--approval-mode", "never", "--no-session-log",
        "--workspace", str(root), "--json",
    ]
    done = watch.run(args, input="", cwd=str(root), timeout=timeout, env=os.environ.copy(), provider="muse")
    if done.returncode:
        raise ValueError((done.stderr or done.stdout).strip() or f"muse exited {done.returncode}")
    answer = None
    for event in events(done.stdout):
        payload = event.get("payload") or {}
        kind = event.get("payload_type")
        if kind == "task.lifecycle.proposed":
            task = str((payload.get("event") or {}).get("task_kind", ""))
            if task.startswith("tool."):
                raise ValueError(f"Muse review used a tool: {task}")
        elif isinstance(kind, str) and kind.startswith("run.terminal"):
            if payload.get("terminal") != "completed":
                raise ValueError(payload.get("reason") or f"Muse review ended with {payload.get('terminal')}")
            answer = payload.get("text")
    if not isinstance(answer, str) or not answer.strip():
        raise ValueError("Muse review returned no answer")
    return unfenced(answer)


ASK = {"codex": ask_codex, "grok": ask_grok, "antigravity": ask_antigravity, "muse": ask_muse}
