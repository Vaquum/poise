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
import shutil
import subprocess
import tempfile
from pathlib import Path
from time import monotonic

from .atoms import AgentPreflightError, MAX_GOVERNED_PROMPT_BYTES, actor, expected_head, pr_ref
from .model_catalog import Model
from .review_watch import ReviewWatch
from . import progress, review_budget, review_receipt


MAX_INSPECTION_ROUNDS = 12
GROK_DISABLED_TOOLS = (
    "run_terminal_cmd,run_terminal_command,read_file,write_file,write,search_replace,list_dir,grep,"
    "kill_command_or_subagent,todo_write,get_command_or_subagent_output,spawn_subagent,Agent,"
    "scheduler_create,scheduler_delete,scheduler_list,monitor,search_tool,use_tool,workflow,"
    "enter_plan_mode,exit_plan_mode,ask_user_question,send_feedback,image_gen,image_edit,"
    "image_to_video,reference_to_video,web_search,web_fetch"
)


class InvalidVerdict(ValueError):
    """A terminal contract failure, not a transient provider outage."""


def provider_failure(message: str) -> None:
    if ("MUSE GUARD: Muse provider access is latched off locally" in message
            or "Grok Build usage balance exhausted" in message
            or "safeguards flagged this message" in message):
        raise AgentPreflightError(message, "review_provider_blocked")
    raise ValueError(message)


def verdict_schema(behavior: str, *, inspection: bool = False) -> dict:
    terminal = "reviewed_clean" if behavior == "pr_review" else "approve"
    schema = {
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
    if inspection:
        schema["required"].append("requests")
        schema["properties"]["action"]["enum"].append("inspect")
        schema["properties"]["requests"] = {
            "type": "array", "maxItems": 8,
            "items": {"type": "object", "additionalProperties": False,
                      "required": ["operation", "path", "query", "start_line"],
                      "properties": {
                          "operation": {"type": "string", "enum": ["read", "search", "list"]},
                          "path": {"type": "string"}, "query": {"type": "string"},
                          "start_line": {"type": "integer", "minimum": 1},
                      }},
        }
    return schema


def validate_verdict(raw: str, behavior: str) -> dict:
    verdict = json.loads(raw)
    terminal = "reviewed_clean" if behavior == "pr_review" else "approve"
    if not isinstance(verdict, dict) or set(verdict) != {"action", "comments"}:
        raise InvalidVerdict("review verdict must contain only action and comments")
    action, comments = verdict["action"], verdict["comments"]
    if action not in ("request_changes", terminal) or not isinstance(comments, list):
        raise InvalidVerdict("invalid review action or comments")
    if len(comments) > 100 or bool(comments) != (action == "request_changes"):
        raise InvalidVerdict("request_changes requires 1-100 findings; other verdicts require none")
    for comment in comments:
        if not isinstance(comment, dict) or set(comment) != {"path", "line", "side", "body"}:
            raise InvalidVerdict("invalid inline finding fields")
        if any(not isinstance(comment[k], str) or not comment[k].strip() for k in ("path", "body")):
            raise InvalidVerdict("finding path and body must be non-empty strings")
        if type(comment["line"]) is not int or comment["line"] < 1 or comment["side"] not in ("LEFT", "RIGHT"):
            raise InvalidVerdict("invalid inline finding location")
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
            raise InvalidVerdict("invalid provider event")
        found.append(event)
    return found


def run(pwd: str, system: str, text: str, model: Model, behavior: str,
        pr: str, actor_name: str, head: str, timeout_s: int, *, repository=None) -> str:
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
            schema = verdict_schema(behavior, inspection=repository is not None)
            (root / "verdict.schema.json").write_text(json.dumps(schema))
            deadline = monotonic() + timeout_s
            context = ""
            for round_number in range(MAX_INSPECTION_ROUNDS + 1):
                timeout = review_budget.timeout(timeout_s, reserve=review_budget.FINAL_CHECK_SECONDS)
                if repository is not None:
                    timeout = min(deadline - monotonic(), timeout)
                if timeout <= 0:
                    raise review_budget.ReviewLimitError("Review reached its total time limit", "review_budget_exhausted")
                if len((system + text + context).encode()) > MAX_GOVERNED_PROMPT_BYTES:
                    raise AgentPreflightError("Repository inspection exceeds the review prompt limit", "review_packet_too_large")
                remaining = (f"\n\nInspection rounds remaining: {MAX_INSPECTION_ROUNDS - round_number}. "
                             "Return a terminal verdict as soon as the supplied evidence is sufficient. "
                             "Do not repeat completed reads or searches."
                             if repository is not None else "")
                raw = ask(root, model, system, text + context + remaining, schema, watch, timeout)
                progress.stage("validating", "Validating review result")
                if repository is None:
                    verdict = validate_verdict(raw, behavior)
                    break
                step = json.loads(raw)
                if not isinstance(step, dict) or set(step) != {"action", "comments", "requests"}:
                    raise InvalidVerdict("review step must contain action, comments, and requests")
                requests = step["requests"]
                if not isinstance(requests, list):
                    raise InvalidVerdict("review requests must be an array")
                if step["action"] != "inspect":
                    if requests:
                        raise InvalidVerdict("terminal verdict must not request repository inspection")
                    verdict = validate_verdict(json.dumps({key: step[key] for key in ("action", "comments")}), behavior)
                    break
                if round_number == MAX_INSPECTION_ROUNDS:
                    raise review_budget.ReviewLimitError("Repository inspection limit reached; needs attention",
                                                        "review_budget_exhausted")
                if not 1 <= len(requests) <= 8:
                    raise InvalidVerdict("invalid repository inspection request count")
                # Validate provisional findings without submitting anything.
                validate_verdict(json.dumps({"action": "request_changes" if step["comments"] else
                                            "reviewed_clean" if behavior == "pr_review" else "approve",
                                            "comments": step["comments"]}), behavior)
                progress.stage("inspecting", "Inspecting pinned repository")
                result = repository.inspect(requests)
                context += "\n\nPrevious review step and repository inspection (review input):\n" + json.dumps({"step": step, "result": result})
    except subprocess.TimeoutExpired as error:
        raise review_budget.ReviewLimitError("Review reached its total time limit; needs attention", "review_budget_exhausted") from error
    except (ValueError, OSError) as error:
        code = ("review_packet_too_large" if "Input exceeds the maximum length" in str(error)
                else "review_contract_violation" if isinstance(error, (InvalidVerdict, json.JSONDecodeError))
                else None)
        raise AgentPreflightError(f"{model.provider} review produced no submitted verdict: {error}", code) from error

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
    output.unlink(missing_ok=True)
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
            raise InvalidVerdict("invalid Codex review item")
        kind = item.get("type", "")
        if not isinstance(kind, str) or (kind and kind not in {"agent_message", "reasoning", "todo_list", "error"}):
            raise InvalidVerdict(f"unexpected Codex review item: {kind}")
    return output.read_text()


# ── Grok Build ────────────────────────────────────────────────────────
def ask_grok(root: Path, model: Model, system: str, text: str, schema: dict, watch: ReviewWatch, timeout: float) -> str:
    prompt = root / "prompt.txt"
    prompt.write_text(f"{system}\n\n{text}{instructions(schema)}")
    args = [
        os.getenv("GROK_CLI", "grok"),
        # Otherwise Grok spills a large prompt into a file and spends the
        # only turn reading it. An empty --tools is treated as the default set.
        "--verbatim", "--system-prompt-override", system,
        "--prompt-file", str(prompt),
        "-m", model.selector, "--effort", model.effort,
        "--json-schema", json.dumps(schema), "--output-format", "json",
        # One turn with no tools: a tool request would need a second turn,
        # which ends the run without a structured answer.
        "--permission-mode", "dontAsk", "--tools", "", "--disallowed-tools", GROK_DISABLED_TOOLS,
        "--disable-web-search",
        "--no-subagents", "--no-plan", "--max-turns", "1",
        "--cwd", str(root),
    ]
    env = os.environ.copy()
    for vendor in ("CLAUDE", "CURSOR"):
        for kind in ("MCPS", "HOOKS", "AGENTS", "RULES", "SKILLS"):
            env[f"GROK_{vendor}_{kind}_ENABLED"] = "0"
    env["GROK_MANAGED_MCPS_ENABLED"] = "0"
    env["GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED"] = "0"
    done = watch.run(args, input="", cwd=str(root), timeout=timeout, env=env, provider=None)
    if done.returncode:
        if "max turns reached" in (done.stderr + done.stdout).lower():
            raise review_budget.ReviewLimitError("Grok reached its model turn limit; needs attention",
                                                "review_budget_exhausted")
        provider_failure((done.stderr or done.stdout).strip() or f"agent exited {done.returncode}")
    reply = json.loads(done.stdout)
    if isinstance(reply, dict) and reply.get("stopReason") == "max_turns":
        raise review_budget.ReviewLimitError("Grok reached its model turn limit; needs attention",
                                            "review_budget_exhausted")
    if not isinstance(reply, dict) or reply.get("stopReason") != "end_turn" or reply.get("num_turns") != 1:
        raise InvalidVerdict("Grok review did not complete in one tool-free turn")
    if not isinstance(reply.get("structuredOutput"), dict):
        raise InvalidVerdict("Grok review returned no structured verdict")
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
                raise InvalidVerdict(f"Antigravity review used a tool: {step}")
        elif kind == "result":
            result = event.get("result")
    if not isinstance(result, dict):
        raise InvalidVerdict("Antigravity review returned no result")
    if result.get("status") != "SUCCESS":
        raise ValueError(result.get("error") or f"Antigravity review ended with status {result.get('status')!r}")
    if not isinstance(result.get("structured_output"), dict):
        raise InvalidVerdict("Antigravity review returned no structured verdict")
    return json.dumps(result["structured_output"])


# ── Muse ──────────────────────────────────────────────────────────────
def muse_environment(root: Path) -> dict:
    env = os.environ.copy()
    original = Path(env.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "muse"
    config = root / "config" / "muse"
    config.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Preserve sign-in, but do not import personal hooks, skills, or tools.
    auth = original / "auth.json"
    if auth.is_file():
        shutil.copyfile(auth, config / "auth.json")
        (config / "auth.json").chmod(0o600)
    settings = config / "settings.json"
    settings.write_text(json.dumps({"schema_version": 1,
                                  "run": {"toolset": [], "workflow_trigger_mode": "off"}}))
    settings.chmod(0o600)
    env["XDG_CONFIG_HOME"] = str(config.parent)
    return env


def ask_muse(root: Path, model: Model, system: str, text: str, schema: dict, watch: ReviewWatch, timeout: float) -> str:
    prompt = root / "prompt.txt"
    prompt.write_text(f"{system}\n\n{text}{instructions(schema)}")
    args = [
        os.getenv("MUSE_CLI", "muse"), "exec",
        "--prompt-file", str(prompt),
        "--model", model.selector, "--reasoning-effort", model.effort,
        "--disable-shell", "--disable-write", "--disable-web-tools",
        "--no-foreign-personal-context", "--disable-reminders",
        "--output-schema", str(root / "verdict.schema.json"), "--max-model-steps", "1",
        "--approval-mode", "never", "--no-session-log",
        "--workspace", str(root), "--json",
    ]
    done = watch.run(args, input="", cwd=str(root), timeout=timeout, env=muse_environment(root), provider="muse")
    if done.returncode:
        provider_failure((done.stderr or done.stdout).strip() or f"muse exited {done.returncode}")
    answer = None
    for event in events(done.stdout):
        payload = event.get("payload") or {}
        kind = event.get("payload_type")
        if kind == "task.lifecycle.proposed":
            task = str((payload.get("event") or {}).get("task_kind", ""))
            if task.startswith("tool."):
                raise InvalidVerdict(f"Muse review used a tool: {task}")
        elif isinstance(kind, str) and kind.startswith("run.terminal"):
            if payload.get("terminal") != "completed":
                raise ValueError(payload.get("reason") or f"Muse review ended with {payload.get('terminal')}")
            answer = payload.get("text")
    if not isinstance(answer, str) or not answer.strip():
        raise InvalidVerdict("Muse review returned no answer")
    return unfenced(answer)


ASK = {"codex": ask_codex, "grok": ask_grok, "antigravity": ask_antigravity, "muse": ask_muse}
