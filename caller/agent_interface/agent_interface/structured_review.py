"""Structured verdicts, submitted only through the governed GitHub interface.

Claude reviews with governed tools (claude_acl). Every other provider —
Codex, Grok Build, Antigravity, Muse — gets the same immutable packet with
no tools, in an empty work directory, and answers with one JSON verdict that
Caller validates and submits. A run that used a tool, failed, or answered
anything but the verdict submits nothing.
"""
from __future__ import annotations

import json
from hashlib import sha256
import os
import re
import shutil
import subprocess
import tempfile
from uuid import UUID
from pathlib import Path
from time import monotonic

from .atoms import AgentPreflightError, MAX_GOVERNED_PROMPT_BYTES, actor, bounded_cause, expected_head, pr_ref, provider_blocked
from .model_catalog import Model
from .process_diagnostic import diagnostic_envelope
from .review_watch import ReviewSuperseded, ReviewWatch
from . import progress, review_budget, review_receipt
from . import review_cap as followup


MAX_INSPECTION_ROUNDS = 12
CODEX_MAX_INPUT_CHARS = 1_048_576
GROK_DISABLED_TOOLS = (
    "run_terminal_cmd,run_terminal_command,read_file,write,search_replace,list_dir,grep,"
    "kill_command_or_subagent,todo_write,get_command_or_subagent_output,spawn_subagent,Agent,"
    "scheduler_create,scheduler_delete,scheduler_list,monitor,search_tool,use_tool,workflow,"
    "enter_plan_mode,exit_plan_mode,ask_user_question,send_feedback,image_gen,image_edit,"
    "image_to_video,reference_to_video,web_search,web_fetch"
)


class InvalidVerdict(ValueError):
    """A terminal contract failure, not a transient provider outage."""


def _diagnostic(provider: str, phase: str, *, exit_code=None, signal=None, cause: str = "") -> dict:
    return diagnostic_envelope(operation="provider.review", phase=phase,
                               outcome="signal" if signal is not None else "exit",
                               stderr=cause[:500], provider=provider, exit_code=exit_code,
                               signal=signal, submission="none", artifact="none")


def provider_failure(message: str, *, provider: str = "provider", phase: str = "provider_execution",
                     exit_code=None, signal=None) -> None:
    cause = message.strip()
    if provider_blocked(cause):
        bounded = bounded_cause(cause or f"{provider} refused the review")
        raise AgentPreflightError(bounded, "review_provider_blocked",
                                  _diagnostic(provider, phase, exit_code=exit_code, signal=signal, cause=bounded))
    bounded = bounded_cause(cause or f"{provider} exited {exit_code}")
    raise AgentPreflightError(f"{provider} review failed: {bounded}", "review_provider_exit",
                              _diagnostic(provider, phase, exit_code=exit_code, signal=signal, cause=bounded))


def provider_error(provider: str, message: str, *, phase: str = "provider_execution") -> None:
    bounded = bounded_cause(message)
    raise AgentPreflightError(f"{provider} review failed: {bounded}", "review_provider_error",
                              _diagnostic(provider, phase, cause=bounded))


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


def _loads_no_duplicates(raw: str):
    def hook(pairs):
        seen = set()
        for key, _ in pairs:
            if key in seen:
                raise InvalidVerdict(f"duplicate key in review output: {key!r}")
            seen.add(key)
        return dict(pairs)
    return json.loads(raw, object_pairs_hook=hook)


def validate_verdict(raw: str, behavior: str) -> dict:
    verdict = _loads_no_duplicates(raw)
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


def _file_capped_followup(packet: str, pr: str, actor_name: str, head: str,
                          review_round: int, review_cap: int,
                          comments: list, pwd: str) -> str:
    try:
        node = json.loads(packet)
    except ValueError:
        node = None
    repo = node.get("repository") if isinstance(node, dict) else None
    number = node.get("pull_number") if isinstance(node, dict) else None
    pull = node.get("pull") if isinstance(node, dict) else None
    base = pull.get("base", {}).get("sha") if isinstance(pull, dict) and isinstance(pull.get("base"), dict) else None
    try:
        base_sha = expected_head(base) if isinstance(base, str) else None
    except ValueError:
        base_sha = None
    if not isinstance(repo, str) or "/" not in repo or not isinstance(number, int) or number < 1 \
            or base_sha is None:
        raise review_budget.ReviewLimitError(
            "a capped approval round needs a readable PR packet", "review_contract_violation")
    existing = followup.find_capped_issue(packet, str(number), head)
    if existing is not None:
        return followup.issue_reference(existing)
    issue = followup.file_followup_issue(
        pwd,
        pr_ref(pr),
        actor(actor_name),
        followup.render_title(repo, str(number), review_round),
        followup.render_body(repo, str(number), head, base_sha, review_round, review_cap, comments),
    )
    return followup.issue_reference(issue)


def _refused_head(output: str) -> str | None:
    """The observed head when the pre-POST head check refused the review."""
    match = re.search(r"pull-request head changed: expected [0-9a-f]{40}, got ([0-9a-f]{40})", output)
    return match[1] if match else None


def run(pwd: str, system: str, text: str, model: Model, behavior: str,
        pr: str, actor_name: str, head: str, timeout_s: int, *, repository=None,
        packet: str = "", capped: bool = False,
        review_round: int | None = None, review_cap: int | None = None) -> str:
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
                    # Loop-driven growth, not #186's initial-packet overflow: keep
                    # it out of the packet block so the head is not pinned.
                    raise review_budget.ReviewLimitError(
                        "Repository inspection exceeds the review prompt limit; needs attention",
                        "review_budget_exhausted",
                        diagnostic_envelope(operation="provider.review", phase="inspection_context",
                                            outcome="resource_failure", provider=model.provider))
                # Last round decides on evidence already held: offer only the
                # terminal verdict, never another inspection step.
                if repository is not None and round_number == MAX_INSPECTION_ROUNDS:
                    schema = verdict_schema(behavior, inspection=False)
                    (root / "verdict.schema.json").write_text(json.dumps(schema))
                remaining = (f"\n\nInspection rounds remaining: {MAX_INSPECTION_ROUNDS - round_number}. "
                             f"Analysis time remaining: {int(timeout)} seconds. "
                             "Batch independent inspection requests in one step. "
                             "Return a terminal verdict as soon as the supplied evidence is sufficient. "
                             "Do not repeat completed reads or searches."
                             if repository is not None else "")
                raw = ask(root, model, system, text + context + remaining, schema, watch, timeout)
                progress.stage("validating", "Validating review result")
                if repository is None:
                    verdict = validate_verdict(raw, behavior)
                    break
                step = _loads_no_duplicates(raw)
                if round_number == MAX_INSPECTION_ROUNDS and isinstance(step, dict) \
                        and set(step) == {"action", "comments"}:
                    # The final round offers the terminal-only verdict schema,
                    # which has no requests property at all.
                    verdict = validate_verdict(raw, behavior)
                    break
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
                    raise review_budget.ReviewLimitError(
                        "Repository inspection limit reached; needs attention",
                        "review_budget_exhausted",
                        diagnostic_envelope(operation="provider.review", phase="inspection_rounds",
                                            outcome="resource_failure", provider=model.provider,
                                            context={"rounds": MAX_INSPECTION_ROUNDS}))
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
                else "review_provider_error")
        cause = bounded_cause(str(error) or "invalid provider output")
        diagnostic = diagnostic_envelope(operation="provider.review", phase="validating",
                                               outcome="invalid_output", stderr=cause,
                                               provider=model.provider, submission="none")
        raise AgentPreflightError(f"{model.provider} review produced no submitted verdict: {cause}", code,
                                  diagnostic) from error

    capped_note = ""
    if capped and behavior == "pr_approve" and verdict["action"] == "request_changes":
        # The model reviewed as usual; the harness converts the change request
        # deterministically: file the findings as one follow-up issue first,
        # then approve. A clean verdict approves as usual, with no issue.
        if review_round is None or review_cap is None:
            raise review_budget.ReviewLimitError(
                "a capped approval round needs its round and cap numbers", "review_contract_violation")
        reference = _file_capped_followup(packet, pr, actor_name, head, review_round, review_cap,
                                          verdict["comments"], pwd)
        verdict = {"action": "approve", "comments": []}
        capped_note = (f"\nReview cap reached (round {review_round} of {review_cap}); "
                       f"findings filed as {reference}.")

    flag = {"request_changes": "--request-changes", "reviewed_clean": "--reviewed-clean",
            "approve": "--approve-pr"}[verdict["action"]]
    args = [os.getenv("GITHUB_INTERFACE_CLI", "github-interface"), flag, ref]
    if verdict["action"] == "request_changes":
        args.extend(["--comments-json", json.dumps(verdict["comments"])])
    limit = review_budget.timeout(600)
    progress.stage("submitting", "Submitting GitHub review", timeout=limit)
    try:
        done = subprocess.run([*args, *fixed], cwd=pwd, text=True, capture_output=True, timeout=limit)
    except subprocess.TimeoutExpired as error:
        # The POST may have gone out before the timeout killed the child.
        raise review_receipt.SubmissionError(
            "review submission timed out; publication uncertain, reconcile before retry") from error
    if done.returncode:
        transient = review_receipt.record_failure(done.stderr or done.stdout)
        if transient is not None:
            raise review_receipt.SubmissionError(transient)
        superseded = _refused_head((done.stderr or done.stdout).strip())
        if superseded is not None:
            # The pre-POST head check refused: proved no review, so the run
            # is superseded, not a contract violation.
            raise ReviewSuperseded(superseded)
        cause = bounded_cause((done.stderr or done.stdout).strip() or f"github-interface exited {done.returncode}")
        raise review_budget.ReviewLimitError(
            f"review submission rejected: {cause}", "review_contract_violation",
            diagnostic_envelope(operation="provider.review", phase="submitting", outcome="exit",
                                stderr=cause, provider=model.provider, submission="rejected"))
    receipt = review_receipt.record(done.stdout)
    if receipt is None:
        try:
            reply = json.loads(done.stdout)
        except ValueError:
            reply = None
        if isinstance(reply, dict) and reply.get("action") == "no_review":
            cause = bounded_cause(json.dumps(reply.get("skipped", [])) or "no review submitted")
            raise review_budget.ReviewLimitError(
                f"review submission was a no-op: {cause}", "review_contract_violation",
                diagnostic_envelope(operation="provider.review", phase="submitting", outcome="exit",
                                    stderr=cause, provider=model.provider, submission="noop"))
        raise review_receipt.SubmissionError(
            "review submission returned no receipt; publication uncertain, reconcile before retry")
    # The outer governed behavior reads authoritative review facts afterward:
    # a receipted review reconciles as completed even when the head moved
    # after the POST, because GitHub pins the stale verdict instead of
    # rejecting it.
    return raw.strip() + "\n" + (done.stdout or done.stderr).strip() + capped_note


# ── Codex ─────────────────────────────────────────────────────────────
def ask_codex(root: Path, model: Model, system: str, text: str, schema: dict, watch: ReviewWatch, timeout: float) -> str:
    output = root / "verdict.json"
    output.unlink(missing_ok=True)
    prompt = f"{system}\n\n{text}"
    state_path = root / "codex-session.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else None
    resume = (state is not None and state["prefix_digest"] == sha256(prompt[:state["prefix_length"]].encode()).hexdigest())
    args = [
        os.getenv("CODEX_CLI", "codex"), "exec",
        "--ignore-user-config", "--ignore-rules",
        "--skip-git-repo-check", "--sandbox", "read-only",
        "--model", model.selector,
        "-c", f'model_reasoning_effort="{model.effort}"',
        "-c", 'model_reasoning_summary="auto"',
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
    # Each review owns one fresh native conversation. Resume that exact ID
    # with only newly supplied inspection evidence, retaining the provider's
    # prior analysis instead of recomputing the whole packet each round.
    message = prompt[state["prefix_length"]:] if resume else prompt
    fragments = [message]
    if len(message) > CODEX_MAX_INPUT_CHARS:
        # Keep the input intact in one native conversation. Intermediate
        # turns only acknowledge receipt; only the last can return a verdict.
        width = CODEX_MAX_INPUT_CHARS - 1024
        fragments = [message[start:start + width] for start in range(0, len(message), width)]
    thread_id = state["thread_id"] if resume else None
    deadline = monotonic() + timeout
    for index, fragment in enumerate(fragments, 1):
        final = index == len(fragments)
        schema_path = root / "verdict.schema.json"
        part = fragment
        if len(fragments) > 1:
            part = (f"Caller review input fragment {index}/{len(fragments)}. These are consecutive "
                    "fragments of one immutable review prompt. Retain every fragment verbatim as review input. "
                    + ("All fragments are now supplied. Review them together and return the requested verdict or inspection step."
                       if final else f'Do not review or return a verdict yet. Reply only with {{"received":{index}}}.')
                    + "\nBEGIN REVIEW INPUT FRAGMENT\n" + fragment + "\nEND REVIEW INPUT FRAGMENT")
            if not final:
                schema_path = root / "receipt.schema.json"
                schema_path.write_text(json.dumps({"type": "object", "additionalProperties": False,
                    "required": ["received"], "properties": {"received": {"type": "integer", "enum": [index]}}}))
        if len(part) > CODEX_MAX_INPUT_CHARS:
            raise InvalidVerdict("Codex review fragment exceeds its input limit")
        command_args = args.copy()
        command_args[command_args.index("--output-schema") + 1] = str(schema_path)
        command = [*command_args, "resume", thread_id, "-"] if thread_id else [*command_args, "-"]
        output.unlink(missing_ok=True)
        remaining = timeout if len(fragments) == 1 else deadline - monotonic()
        if remaining <= 0:
            raise review_budget.ReviewLimitError("Review reached its total time limit", "review_budget_exhausted")
        done = watch.run(command, input=part, cwd=str(root), timeout=remaining, env=env, provider="codex")
        if done.returncode:
            code, sig = (None, -done.returncode) if done.returncode < 0 else (done.returncode, None)
            provider_failure(done.stderr.strip() or f"codex exited {done.returncode}",
                             provider="codex", exit_code=code, signal=sig)
        # Startup item errors can be notices about disabled tools. Failed
        # turns and actual native tool executions still reject the verdict.
        observed_thread = None
        completed_turns = 0
        for event in events(done.stdout):
            if event.get("type") in {"error", "turn.failed"}:
                provider_error("codex", event.get("message") or "Codex review did not complete successfully")
            if event.get("type") == "turn.completed":
                completed_turns += 1
                if completed_turns > 1:
                    raise InvalidVerdict("Codex review returned duplicate completed turns")
            item = event.get("item") or {}
            if not isinstance(item, dict):
                raise InvalidVerdict("invalid Codex review item")
            kind = item.get("type", "")
            if not isinstance(kind, str) or (kind and kind not in {"agent_message", "reasoning", "todo_list", "error"}):
                raise InvalidVerdict(f"unexpected Codex review item: {kind}")
            if event.get("type") == "thread.started":
                try:
                    observed = str(UUID(event["thread_id"]))
                except (KeyError, ValueError, TypeError, AttributeError) as error:
                    raise InvalidVerdict("invalid Codex review conversation ID") from error
                if (observed_thread and observed != observed_thread) or (thread_id and observed != thread_id):
                    raise InvalidVerdict("Codex resumed a different review conversation")
                observed_thread = observed
        thread_id = observed_thread or thread_id
        if len(fragments) > 1 and not thread_id:
            raise InvalidVerdict("Codex staged review has no conversation ID")
        result = output.read_text()
        if not final:
            receipt = json.loads(result)
            if (not isinstance(receipt, dict) or set(receipt) != {"received"}
                    or type(receipt["received"]) is not int or receipt["received"] != index):
                raise InvalidVerdict("Codex did not acknowledge the review input fragment")
    if thread_id:
        prefix = prompt.rsplit("\n\nInspection rounds remaining:", 1)[0]
        state_path.write_text(json.dumps({"thread_id": thread_id, "prefix_length": len(prefix),
                                         "prefix_digest": sha256(prefix.encode()).hexdigest()}))
    return result


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
        code, sig = (None, -done.returncode) if done.returncode < 0 else (done.returncode, None)
        provider_failure(done.stderr.strip() or f"grok exited {done.returncode}",
                         provider="grok", exit_code=code, signal=sig)
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
        code, sig = (None, -done.returncode) if done.returncode < 0 else (done.returncode, None)
        provider_failure(done.stderr.strip() or f"agy exited {done.returncode}",
                         provider="antigravity", exit_code=code, signal=sig)
    # With a schema the CLI adds a turn of its own to shape the answer, so
    # turns prove nothing; the steps do. A tool step, even one headless mode
    # auto-denied, is outside this adapter's contract.
    result = None
    results = 0
    for event in events(done.stdout):
        kind = event.get("event")
        if kind == "step_update":
            step = (event.get("step_update") or {}).get("step_type")
            if step not in {"user_input", "agent_response", "finish"}:
                raise InvalidVerdict(f"Antigravity review used a tool: {step}")
        elif kind == "result":
            results += 1
            if results > 1:
                raise InvalidVerdict("Antigravity review returned duplicate results")
            result = event.get("result")
    if not isinstance(result, dict):
        raise InvalidVerdict("Antigravity review returned no result")
    if result.get("status") != "SUCCESS":
        provider_error("antigravity", result.get("error") or f"Antigravity review ended with status {result.get('status')!r}")
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
    # This Muse CLI needs session logging for its local session messaging,
    # so the run keeps its session store inside the run.
    data = root / "data"
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    env["XDG_DATA_HOME"] = str(data)
    return env


def ask_muse(root: Path, model: Model, system: str, text: str, schema: dict, watch: ReviewWatch, timeout: float) -> str:
    prompt = root / "prompt.txt"
    prompt.write_text(f"{system}\n\n{text}{instructions(schema)}")
    args = [
        os.getenv("MUSE_CLI", "muse"), "exec", "--contributor-mode", "on",
        "--prompt-file", str(prompt),
        "--model", model.selector, "--reasoning-effort", model.effort,
        "--disable-shell", "--disable-write", "--disable-web-tools",
        "--no-foreign-personal-context", "--disable-reminders",
        "--output-schema", str(root / "verdict.schema.json"), "--max-model-steps", "1",
        "--approval-mode", "never",
        "--workspace", str(root), "--json",
    ]
    done = watch.run(args, input="", cwd=str(root), timeout=timeout, env=muse_environment(root), provider="muse")
    if done.returncode:
        code, sig = (None, -done.returncode) if done.returncode < 0 else (done.returncode, None)
        provider_failure(done.stderr.strip() or f"muse exited {done.returncode}",
                         provider="muse", exit_code=code, signal=sig)
    answer = None
    terminals = 0
    for event in events(done.stdout):
        payload = event.get("payload") or {}
        kind = event.get("payload_type")
        if kind == "task.lifecycle.proposed":
            task = str((payload.get("event") or {}).get("task_kind", ""))
            if task.startswith("tool."):
                raise InvalidVerdict(f"Muse review used a tool: {task}")
        elif isinstance(kind, str) and kind.startswith("run.terminal"):
            terminals += 1
            if terminals > 1:
                raise InvalidVerdict("Muse review returned duplicate terminal events")
            if payload.get("terminal") != "completed":
                provider_error("muse", payload.get("reason") or f"Muse review ended with {payload.get('terminal')}")
            answer = payload.get("text")
    if not isinstance(answer, str) or not answer.strip():
        raise InvalidVerdict("Muse review returned no answer")
    return unfenced(answer)


ASK = {"codex": ask_codex, "grok": ask_grok, "antigravity": ask_antigravity, "muse": ask_muse}
