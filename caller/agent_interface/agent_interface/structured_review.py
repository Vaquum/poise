"""Structured verdicts, submitted only through the governed GitHub interface.

Claude reviews with governed tools (claude_acl). Every other provider —
Codex, Grok Build, Antigravity, Muse — gets the same immutable packet with
no tools, in an empty work directory, and answers with one JSON verdict that
Caller validates and submits. Invalid responses get one correction attempt;
a run that used a tool, failed, or still has no valid verdict submits nothing.
A packet larger than one provider call reliably finishes is reviewed in
file-group stages; every stage's findings combine into the single submitted verdict.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from hashlib import sha256
import os
import re
import shutil
import subprocess
from uuid import UUID
from pathlib import Path
from time import monotonic

from .atoms import AgentPreflightError, MAX_GOVERNED_PROMPT_BYTES, ReviewVerdictError, actor, bounded_cause, credential_rejected, expected_head, pr_ref, provider_blocked
from .atoms import packet as fetch_packet
from .model_catalog import Model
from .process_diagnostic import diagnostic_envelope
from .review_watch import ReviewSuperseded, ReviewWatch
from . import progress, review_budget, review_receipt, review_stages, resource_ownership
from . import review_cap as followup


MAX_INSPECTION_ROUNDS = 12
SUBMISSION_RESERVE_SECONDS = 60
VERIFICATION_RESERVE_SECONDS = 60
CODEX_MAX_INPUT_CHARS = 1_048_576
# A review with no verdict by this point stops, so its PR moves to the next slot
# instead of waiting out the shared budget. Six of Grok's 15 completed PR reviews
# on record at 2026-11-04 took longer; 900 s cuts the same six and holds PRs longer.
PROVIDER_ANALYSIS_SECONDS = {"grok": 800}
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
    # Classify the provider's own cause before credential redaction can
    # hide natural-language words such as "token was".
    code = "authentication_failed" if provider == "codex" and credential_rejected(cause) else "review_provider_exit"
    bounded = bounded_cause(cause or f"{provider} exited {exit_code}")
    raise AgentPreflightError(f"{provider} review failed: {bounded}", code,
                              _diagnostic(provider, phase, exit_code=exit_code, signal=signal, cause=bounded))


def provider_error(provider: str, message: str, *, phase: str = "provider_execution") -> None:
    code = "authentication_failed" if provider == "codex" and credential_rejected(message) else "review_provider_error"
    bounded = bounded_cause(message)
    raise AgentPreflightError(f"{provider} review failed: {bounded}", code,
                              _diagnostic(provider, phase, cause=bounded))


def verdict_schema(behavior: str, *, inspection: bool = False, verify_fixes: bool = False) -> dict:
    terminal = "reviewed_clean" if behavior == "pr_review" else "approve"
    schema = {
        "type": "object",
        "additionalProperties": False,
        "required": ["action", "comments", "assessment"],
        "properties": {
            "assessment": {
                "type": "object", "additionalProperties": False,
                "required": ["verdict", "reviewed_context", "limitations"],
                "properties": {key: {"type": "string", "minLength": minimum, "maxLength": 4000}
                               for key, minimum in (("verdict", 20), ("reviewed_context", 20), ("limitations", 4))},
            },
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
    if verify_fixes:
        assessment = schema["properties"]["assessment"]
        assessment["required"].append("verified_fixes")
        assessment["properties"]["verified_fixes"] = {
            "type": "array", "maxItems": 100, "items": {"type": "integer", "minimum": 1},
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
    if not isinstance(verdict, dict) or set(verdict) != {"action", "comments", "assessment"}:
        raise InvalidVerdict("review verdict must contain action, comments and assessment")
    assessment = verdict["assessment"]
    if not isinstance(assessment, dict) or set(assessment) - {"verified_fixes"} != {"verdict", "reviewed_context", "limitations"}:
        raise InvalidVerdict("review assessment requires verdict, reviewed_context and limitations")
    try:
        review_receipt.verified_fix_ids(assessment)
    except ValueError as error:
        raise InvalidVerdict(str(error)) from error
    for key, minimum in (("verdict", 20), ("reviewed_context", 20), ("limitations", 4)):
        if not isinstance(assessment[key], str) or not minimum <= len(assessment[key].strip()) <= 4000:
            raise InvalidVerdict(f"invalid review assessment {key}")
    if assessment["verdict"].strip() == "Reviewed: no blocking findings.":
        raise InvalidVerdict("fixed acknowledgement is not a substantive assessment")
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
        reserve=SUBMISSION_RESERVE_SECONDS + VERIFICATION_RESERVE_SECONDS,
    )
    return followup.issue_reference(issue)


def _admit(text: str) -> None:
    prompt_bytes = len(text.encode("utf-8"))
    if prompt_bytes > MAX_GOVERNED_PROMPT_BYTES:
        raise AgentPreflightError(
            "PR packet is too large for a reliable atomic review: "
            f"{prompt_bytes} bytes exceeds {MAX_GOVERNED_PROMPT_BYTES} after data exclusions; "
            "reduce the remaining review input",
            "review_packet_too_large",
            diagnostic_envelope(operation="provider.input_admission", phase="before_provider_launch",
                                outcome="resource_failure",
                                context={"actual_input_bytes": prompt_bytes,
                                         "input_limit_bytes": MAX_GOVERNED_PROMPT_BYTES, "provider_started": False}),
        )


def _stage_texts(text: str, packet: str) -> Iterator[str]:
    """Yield one review prompt per file group, holding one at a time."""
    if not packet or review_stages.stage_count(packet) == 1:
        yield text
        return
    if packet not in text:
        raise review_stages.StageError("staged review packet differs from the review prompt")
    for stage in review_stages.iter_stages(packet):
        yield text.replace(packet, stage, 1)


def _reaffirming_thread(comment: dict, threads: list[dict], *, in_since_diff: bool) -> dict | None:
    """The unresolved thread this comment reaffirms, if any.

    A location match with the same body reaffirms a current thread, and
    a body match alone reaffirms an outdated one, whose location is
    stale. A bare location match reaffirms only outside the since diff:
    inside it, the line may be a new finding's previous-head line that
    collides with an unrelated thread's base line, and remapping must
    win so the finding is not discarded as a duplicate.
    """
    body = " ".join(comment["body"].lower().split())
    for thread in threads:
        if thread.get("is_resolved") or thread.get("path") != comment["path"]:
            continue
        if thread.get("is_outdated"):
            if any(body == " ".join(text.lower().split()) for text in thread.get("bodies", [])):
                return thread
        elif thread.get("line") == comment["line"] and thread.get("side") == comment["side"]:
            if not in_since_diff or \
                    any(body == " ".join(text.lower().split()) for text in thread.get("bodies", [])):
                return thread
    return None


def _validate_since_positions(pwd: str, pr: str, actor_name: str, head: str, packet: str,
                              verdict: dict) -> None:
    """Validate full-diff findings and remap since-scoped findings.

    The model reviewed the diff since the last head: RIGHT numbers already
    name current-head lines, but LEFT numbers name previous-head lines, so
    each new LEFT comment is remapped to base coordinates by matching its
    content within the full-diff change block holding its current-head
    position. Known unresolved findings retain their original thread
    coordinates, including outdated findings. A
    missing anchor never proves the defect is gone: if any finding cannot be
    anchored, the review fails closed before submitting an incomplete change
    request or filing incomplete findings for a capped approval."""
    if not packet or not verdict["comments"]:
        return
    try:
        node = json.loads(packet)
    except ValueError:
        return
    if not isinstance(node, dict):
        return
    if not node.get("since_head_sha"):
        try:
            sets = review_stages.diff_line_sets(node["diff"], [entry["filename"] for entry in node["files"]])
        except (ValueError, KeyError, TypeError) as error:
            raise InvalidVerdict(f"cannot validate full-diff positions: {error}") from error
        for index, comment in enumerate(verdict["comments"]):
            thread = _reaffirming_thread(comment, node.get("review_threads", []), in_since_diff=False)
            if thread is not None:
                line, side = thread.get("line"), thread.get("side")
                if type(line) is int and line >= 1 and side in ("LEFT", "RIGHT"):
                    verdict["comments"][index] = {**comment, "line": line, "side": side}
                    continue
            if comment["line"] not in sets.get(comment["path"], {}).get(comment["side"].lower(), set()):
                raise InvalidVerdict("finding cannot be anchored to the full PR diff; no review submitted")
        return
    level = node.get("p")
    if level is None or (isinstance(level, str) and not level.strip()):
        raise InvalidVerdict(
            "cannot validate since-diff positions: review packet is missing its priority")
    # The packet carries the wire value (e.g. "p2"); pass it through unchanged
    # so the full-diff re-fetch uses the same priority scope. atoms._priority
    # validates the format strictly; non-string values fail there.
    priority = level if isinstance(level, str) else str(level)
    try:
        full = json.loads(fetch_packet(pwd, pr, actor_name, head, priority, since_head=None,
                                       reserve=SUBMISSION_RESERVE_SECONDS + VERIFICATION_RESERVE_SECONDS))
        retained = [entry["filename"] for entry in full["files"]]
        sets = review_stages.diff_line_sets(full["diff"], retained)
        since_files = [entry["filename"] for entry in node.get("files", [])]
        since_diff = node.get("diff")
        since_left = review_stages.diff_left_anchors(
            since_diff if isinstance(since_diff, str) else "", since_files)
        full_left = review_stages.diff_left_anchors(full["diff"], retained)
        full_spans = review_stages.diff_left_spans(full["diff"], retained)
    except (ValueError, KeyError, TypeError) as error:
        raise InvalidVerdict(f"cannot validate since-diff positions: {error}") from error
    by_content: dict[tuple[str, str], list[tuple[int, tuple[int, int]]]] = {}
    for path, lines in full_left.items():
        for number, (_position, content) in lines.items():
            by_content.setdefault((path, content), []).append((number, full_spans[path][number]))
    kept, dropped = [], []
    for comment in verdict["comments"]:
        anchor = since_left.get(comment["path"], {}).get(comment["line"]) \
            if comment["side"] == "LEFT" else None
        thread = _reaffirming_thread(comment, node.get("review_threads", []),
                                     in_since_diff=anchor is not None)
        if thread is not None:
            if thread.get("is_outdated"):
                # The model's coordinates for a stale thread are unchecked;
                # submit the thread's own coordinates instead.
                line, side = thread.get("line"), thread.get("side")
                if type(line) is int and line >= 1 and side in ("LEFT", "RIGHT"):
                    comment = {**comment, "line": line, "side": side}
            kept.append(comment)
            continue
        if comment["side"] == "RIGHT":
            if comment["line"] in sets.get(comment["path"], {}).get("right", set()):
                kept.append(comment)
            else:
                dropped.append({key: comment[key] for key in ("path", "line", "side")})
            continue
        if anchor is None:
            raise InvalidVerdict(
                f"comment on {comment['path']}:{comment['line']} (LEFT) is outside the reviewed since diff")
        position, content = anchor
        hits = [number for number, (start, end) in by_content.get((comment["path"], content), [])
                if start <= position <= end]
        if not hits:
            dropped.append({key: comment[key] for key in ("path", "line", "side")})
        elif len(hits) == 1:
            kept.append({**comment, "line": hits[0]})
        else:
            raise InvalidVerdict(
                "removed line matches several pull request lines; refusing an unverified anchor")
    if dropped:
        raise InvalidVerdict(
            "follow-up findings cannot be anchored to the full PR diff; no review submitted")
    verdict["comments"][:] = kept


def _time_limit_message(provider: str, phase: str) -> str:
    # Poise moves the PR on for review_budget_exhausted unless this text matches
    # its inspection-limit wording, and it reads any "rate limit" as a throttle.
    if phase == "file_group":
        return "Review file-group time limit reached; incomplete analysis; reduce the review scope"
    if phase == "inspection":
        return "Local review repository inspection timed out; incomplete analysis; needs attention"
    if phase == "provider_analysis":
        return f"{provider} review reached its analysis time limit; handing off so the next model can run instead"
    return "Review reached its total time limit; needs attention"


def _review_once(root: Path, ask, model: Model, system: str, text: str, watch: ReviewWatch,
                 timeout_s: int, deadline: float, repository, behavior: str, verify_fixes: bool = False,
                 groups_remaining: int | None = None, initializing: bool = False,
                 total_groups: int = 1, expected_group_seconds: float | None = None) -> tuple[str, dict, float]:
    schema = verdict_schema(behavior, inspection=repository is not None, verify_fixes=verify_fixes)
    (root / "verdict.schema.json").write_text(json.dumps(schema))
    context = ""
    round_number = 0
    correction_attempted = False
    group_deadline = None
    inspection_cutoff = None
    group_started = monotonic()
    group_number = total_groups - (groups_remaining or 1) + 1

    def timed_out(phase, timeout, diagnostic=None):
        try:
            remaining = review_budget.timeout(timeout_s, reserve=SUBMISSION_RESERVE_SECONDS + VERIFICATION_RESERVE_SECONDS)
        except review_budget.ReviewLimitError:
            remaining = 0
        remaining = max(0, min(remaining, deadline - monotonic()))
        # A provider-ceiling expiry hands the review to the next model: type it
        # as an analysis handoff, not a terminal timeout.
        handoff = phase == "provider_analysis"
        emitted_phase = "analysis" if handoff else phase
        outcome = "handoff" if handoff else "timed_out"
        message = (f"Incomplete analysis in file group {group_number} of {total_groups}: {emitted_phase} deadline; "
                   f"elapsed {monotonic() - group_started:.1f}s; remaining analysis {remaining:.1f}s. "
                   "No review submitted; reduce the review scope if required coverage cannot fit.")
        diagnostic = {**(diagnostic or diagnostic_envelope(operation="provider.review", phase=emitted_phase,
                                                         outcome=outcome, provider=model.provider)),
                      "phase": emitted_phase, "outcome": outcome, "message": message[:500],
                      "elapsed_ms": round((monotonic() - group_started) * 1000),
                      "timeout_seconds": max(0, timeout), "submission": "none"}
        if handoff:
            # An inspect timeout carries operation github-interface; handoffs are typed provider.review.
            diagnostic["operation"] = "provider.review"
        return review_budget.ReviewLimitError(_time_limit_message(model.provider, phase),
                                             "review_inspection_timeout" if phase == "inspection" else "review_budget_exhausted",
                                             diagnostic)

    def wait_allowance(cap=None):
        try:
            overall = review_budget.timeout(timeout_s, reserve=SUBMISSION_RESERVE_SECONDS + VERIFICATION_RESERVE_SECONDS)
        except review_budget.ReviewLimitError as error:
            raise timed_out("overall", 0) from error
        limits = [(overall, "overall")]
        if repository is not None or model.provider in PROVIDER_ANALYSIS_SECONDS or correction_attempted:
            # The shared analysis deadline only hands off when the provider
            # ceiling binds; a shorter grant is an overall timeout.
            ceiling = PROVIDER_ANALYSIS_SECONDS.get(model.provider, timeout_s) < timeout_s
            limits.append((deadline - monotonic(), "provider_analysis" if ceiling else "overall"))
        if group_deadline is not None:
            limits.append((group_deadline - monotonic(), "file_group"))
        if cap is not None:
            limits.append((cap, "inspection"))
        timeout, phase = min(limits, key=lambda limit: limit[0])
        if timeout <= 0:
            raise timed_out(phase, timeout)
        return timeout, phase

    while round_number <= MAX_INSPECTION_ROUNDS:
        timeout, phase = wait_allowance()
        if groups_remaining is not None and repository is not None and not initializing and group_deadline is None:
            share = timeout / groups_remaining
            # Cap each later group's estimated reserve at half the equal share,
            # leaving borrowing room even after an expensive early prefix.
            allowance = timeout
            if expected_group_seconds is not None:
                allowance = max(share, timeout - min(expected_group_seconds, share / 2) * (groups_remaining - 1))
            group_deadline = monotonic() + allowance
            inspection_cutoff = monotonic() + share / 2
            timeout, phase = wait_allowance()
        if len((system + text + context).encode()) > MAX_GOVERNED_PROMPT_BYTES:
            # Loop-driven growth, not #186's initial-packet overflow: keep
            # it out of the packet block so the head is not pinned.
            raise review_budget.ReviewLimitError(
                "Repository inspection exceeds the review prompt limit; needs attention",
                "review_budget_exhausted",
                diagnostic_envelope(operation="provider.review", phase="inspection_context",
                                    outcome="resource_failure", provider=model.provider))
        finish_soon = inspection_cutoff is not None and monotonic() >= inspection_cutoff
        remaining = (f"\n\nInspection rounds remaining: {MAX_INSPECTION_ROUNDS - round_number}. "
                     f"Analysis time remaining: {int(timeout)} seconds. "
                     "Batch independent inspection requests in one step. "
                     "Return a terminal verdict as soon as the supplied evidence is sufficient. "
                     "Do not repeat completed reads or searches."
                     + (" The equal-share inspection allowance is spent; omit optional inspection. "
                        "If further inspection is required for a complete assessment, request it; "
                        "never return a verdict on incomplete analysis." if finish_soon else "")
                     if repository is not None else "")
        try:
            raw = ask(root, model, system, text + context + remaining, schema, watch, timeout)
        except subprocess.TimeoutExpired as error:
            raise timed_out(phase, timeout) from error
        if initializing:
            group_started = monotonic()
        initializing = False
        progress.stage("validating", "Validating review result")
        try:
            if repository is None:
                return raw, validate_verdict(raw, behavior), monotonic() - group_started
            step = _loads_no_duplicates(raw)
            if not isinstance(step, dict) or set(step) != {"action", "comments", "assessment", "requests"}:
                raise InvalidVerdict("review step must contain action, comments, assessment and requests")
            requests = step["requests"]
            if not isinstance(requests, list):
                raise InvalidVerdict("review requests must be an array")
            if step["action"] != "inspect":
                if requests:
                    raise InvalidVerdict("terminal verdict must not request repository inspection")
                return raw, validate_verdict(json.dumps({key: step[key] for key in ("action", "comments", "assessment")}), behavior), monotonic() - group_started
            if round_number == MAX_INSPECTION_ROUNDS:
                raise review_budget.ReviewLimitError(
                    "Repository inspection limit reached; incomplete analysis; needs attention",
                    "review_budget_exhausted",
                    diagnostic_envelope(operation="provider.review", phase="inspection_rounds",
                                        outcome="resource_failure", provider=model.provider,
                                        message=f"Incomplete analysis in file group {group_number} of {total_groups}; "
                                                f"{MAX_INSPECTION_ROUNDS} inspection rounds used; remaining allowance {timeout:.1f}s",
                                        elapsed_ms=round((monotonic() - group_started) * 1000),
                                        timeout_seconds=timeout, submission="none"))
            if not 1 <= len(requests) <= 8:
                raise InvalidVerdict("invalid repository inspection request count")
            # Validate provisional findings without submitting anything.
            validate_verdict(json.dumps({"action": "request_changes" if step["comments"] else
                                        "reviewed_clean" if behavior == "pr_review" else "approve",
                                        "comments": step["comments"], "assessment": step["assessment"]}), behavior)
        except (InvalidVerdict, json.JSONDecodeError) as error:
            if correction_attempted:
                cause = bounded_cause(str(error) or "invalid review verdict")
                raise ReviewVerdictError(
                    f"{model.provider} review produced no submitted verdict: {cause}",
                    "review_contract_violation",
                    diagnostic_envelope(operation="provider.review", phase="validating", outcome="invalid_output",
                                        stderr=cause, provider=model.provider, submission="none")) from error
            correction_attempted = True
            context += (f"\n\nYour previous review response was rejected:\n{raw}"
                        f"\nValidation error: {error}\nReturn a corrected JSON response matching the review contract, "
                        "preserving your substantive assessment and findings.")
            continue
        progress.stage("inspecting", "Inspecting pinned repository")
        inspection_timeout, phase = wait_allowance(30)
        try:
            result = repository.inspect(requests, timeout_s=inspection_timeout)
        except AgentPreflightError as error:
            if error.code != "review_inspection_timeout":
                raise
            actual_timeout = (error.diagnostic or {}).get("timeout_seconds")
            failure = timed_out(phase, actual_timeout if isinstance(actual_timeout, (int, float)) else inspection_timeout,
                                error.diagnostic)
            if phase == "inspection":
                error.diagnostic = failure.diagnostic
                raise
            raise failure from error
        except subprocess.TimeoutExpired as error:
            raise timed_out(phase, inspection_timeout) from error
        context += "\n\nPrevious review step and repository inspection (review input):\n" + json.dumps({"step": step, "result": result})
        round_number += 1
    raise AssertionError("review rounds did not return a verdict")


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
    capped_note = ""
    try:
        total = review_stages.stage_count(packet) if packet else 1
        staged = total > 1
        candidates = set(json.loads(packet).get("verification_candidates", [])) if packet and not capped else set()
        verified: set[int] = set()
        with resource_ownership.temporary_directory(prefix="agent-interface-review-") as work, \
                ReviewWatch(pwd, pr, actor_name, head) as watch:
            root = Path(work)
            deadline = monotonic() + min(timeout_s, PROVIDER_ANALYSIS_SECONDS.get(model.provider, timeout_s))
            prior: list[dict] = []
            assessment: dict | None = None
            expected_group_seconds = None
            for index, stage_text in enumerate(_stage_texts(text, packet)):
                _admit(stage_text)
                if staged:
                    progress.stage("reviewing", f"Reviewing file group {index + 1} of {total}")
                    if prior:
                        stage_text += ("\n\nFindings already recorded in earlier file groups "
                                       "(do not repeat them):\n" + json.dumps(prior))
                    if assessment is not None:
                        stage_text += ("\n\nCumulative assessment from the earlier file groups:\n" + json.dumps(assessment)
                                       + "\nUpdate this assessment with the current group's evidence. Your terminal assessment "
                                       "must cover every group reviewed so far and remain within the schema bounds.")
                # Charge common-context initialization once before sharing the
                # remaining analysis time across file groups.
                raw, verdict, group_seconds = _review_once(root, ask, model, system, stage_text, watch,
                                             timeout_s, deadline, repository, behavior, bool(candidates),
                                             groups_remaining=total - index if staged else None,
                                             initializing=staged and index == 0, total_groups=total,
                                             expected_group_seconds=expected_group_seconds)
                expected_group_seconds = ((expected_group_seconds or 0) * index + group_seconds) / (index + 1)
                prior.extend(verdict["comments"])
                assessment = verdict["assessment"]
                verified.update(review_receipt.verified_fix_ids(assessment))
                if verified - candidates:
                    raise InvalidVerdict("verified fix must name an answered thread in the original review packet")
            if staged:
                terminal = "reviewed_clean" if behavior == "pr_review" else "approve"
                if verified:
                    verdict["assessment"]["verified_fixes"] = sorted(verified)
                # Each group was validated against the bounded provider schema.
                # The aggregate's capacity is a publication constraint.
                verdict = {**verdict, "action": "request_changes" if prior else terminal, "comments": prior}
            watch.check_closed()
            try:
                review_receipt.retain_verdict(verdict, head)
            except OSError as error:
                cause = bounded_cause(str(error))
                raise review_budget.ReviewLimitError(
                    f"Completed review could not retain its findings: {cause}; no review submitted",
                    "review_contract_violation",
                    diagnostic_envelope(operation="provider.review", phase="finalizing", outcome="resource_failure",
                                        stderr=cause, provider=model.provider, submission="none")) from error
            if len(verdict["comments"]) > 100:
                raise review_budget.ReviewLimitError(
                    f"Completed review has {len(verdict['comments'])} findings; the single-review inline limit is 100; "
                    "complete findings retained on the original Call; no review submitted",
                    "review_contract_violation",
                    diagnostic_envelope(operation="provider.review", phase="finalizing", outcome="resource_failure",
                                        provider=model.provider, submission="none"))
            try:
                _validate_since_positions(pwd, pr, actor_name, head, packet, verdict)
                review_receipt.retain_verdict(verdict, head)
                raw = json.dumps(verdict, ensure_ascii=False)
                coverage = review_receipt.coverage_disposition(json.loads(packet)) if packet else "incomplete"
                if coverage != "complete" and verdict["action"] != "request_changes":
                    review_receipt.complete_response(verdict["assessment"], head)
                    raise review_budget.ReviewLimitError(
                        "Review incomplete: required source coverage is not complete; no clearance submitted",
                        "review_incomplete", diagnostic_envelope(operation="provider.review", phase="validating",
                                                                outcome="incomplete", submission="none"))
                if coverage == "complete" and capped and behavior == "pr_approve" and verdict["action"] == "request_changes" \
                        and all(re.match(r"\s*\[p[12]\]", comment["body"], re.IGNORECASE) for comment in verdict["comments"]):
                    # Only explicitly nonbreaking findings may be deferred.
                    if review_round is None or review_cap is None:
                        raise review_budget.ReviewLimitError(
                            "a capped approval round needs its round and cap numbers", "review_contract_violation")
                    reference = _file_capped_followup(packet, pr, actor_name, head, review_round, review_cap,
                                                      verdict["comments"], pwd)
                    verdict = {**verdict, "action": "approve", "comments": []}
                    capped_note = (f"\nReview cap reached (round {review_round} of {review_cap}); "
                                   f"findings filed as {reference}.")
            except (review_budget.ReviewLimitError, AgentPreflightError, OSError) as error:
                if isinstance(error, review_budget.ReviewLimitError) and error.code != "review_budget_exhausted":
                    raise
                cause = bounded_cause(str(error))
                raise review_budget.ReviewLimitError(
                    f"Completed review could not finalize: {cause}; complete findings retained on the original Call; "
                    "no review submitted", "review_contract_violation",
                    diagnostic_envelope(operation="provider.review", phase="finalizing", outcome="resource_failure",
                                        stderr=cause, provider=model.provider, submission="none")) from error
    except review_stages.StageError as error:
        cause = bounded_cause(str(error) or "invalid review packet stages")
        diagnostic = diagnostic_envelope(operation="provider.review", phase="staging",
                                         outcome="invalid_output", stderr=cause,
                                         provider=model.provider, submission="none")
        raise AgentPreflightError(f"{model.provider} review produced no submitted verdict: {cause}",
                                  "review_contract_violation", diagnostic) from error
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

    flag = {"request_changes": "--request-changes", "reviewed_clean": "--reviewed-clean",
            "approve": "--approve-pr"}[verdict["action"]]
    args = [os.getenv("GITHUB_INTERFACE_CLI", "github-interface"), flag, ref]
    if verdict["action"] == "request_changes":
        args.extend(["--comments-json", json.dumps(verdict["comments"])])
    review_receipt.complete_response(verdict["assessment"], head)
    args.extend(["--assessment-json", json.dumps(verdict["assessment"], ensure_ascii=False)])
    try:
        limit = review_budget.timeout(600, reserve=VERIFICATION_RESERVE_SECONDS)
        progress.stage("submitting", "Submitting GitHub review", timeout=limit)
        done = subprocess.run([*args, *fixed], cwd=pwd, text=True, capture_output=True, timeout=limit)
    except subprocess.TimeoutExpired as error:
        # The POST may have gone out before the timeout killed the child.
        raise review_receipt.SubmissionError(
            "review submission timed out; publication uncertain, reconcile before retry") from error
    except (review_budget.ReviewLimitError, OSError) as error:
        cause = bounded_cause(str(error))
        raise review_budget.ReviewLimitError(
            f"Completed review could not start submission: {cause}; complete findings retained on the original Call; "
            "no review submitted", "review_contract_violation",
            diagnostic_envelope(operation="provider.review", phase="submitting", outcome="resource_failure",
                                stderr=cause, provider=model.provider, submission="none")) from error
    if done.returncode:
        transient = review_receipt.record_failure(done.stderr or done.stdout)
        if transient is not None:
            raise review_receipt.SubmissionError(transient)
        output = (done.stderr or done.stdout).strip()
        superseded = _refused_head(output)
        if superseded is not None:
            # The pre-POST head check refused: proved no review, so the run
            # is superseded, not a contract violation.
            raise ReviewSuperseded(superseded)
        cause = bounded_cause(output or f"github-interface exited {done.returncode}")
        if review_receipt.blocked_refusal(output) is not None:
            # The pre-POST guard refused: other reviewers' conversations are
            # still open, so the approval waits on them. The guard stays
            # strict — nothing is approved — but a blocked approval is not a
            # failed verdict publication.
            raise review_budget.ReviewLimitError(
                f"approval blocked by unresolved review conversations: {cause}",
                "approval_blocked_unresolved_conversations",
                diagnostic_envelope(operation="provider.review", phase="submitting", outcome="exit",
                                    stderr=cause, provider=model.provider, submission="blocked"))
        raise review_budget.ReviewLimitError(
            f"review submission rejected: {cause}", "review_contract_violation",
            diagnostic_envelope(operation="provider.review", phase="submitting", outcome="exit",
                                stderr=cause, provider=model.provider, submission="rejected"))
    receipt = review_receipt.record(done.stdout)
    if receipt is None:
        # A repeat-only refusal restated already-published bodies in every
        # finding and delivered nothing. Typed so recovery can tell it
        # from other duplicate refusals without reading prose.
        details = review_receipt.parse_no_review(done.stdout)
        if details is not None:
            cause = bounded_cause(json.dumps(details["skipped"]) or "no review submitted")
            raise review_budget.ReviewLimitError(
                f"review submission was a no-op: {cause}", "review_contract_violation",
                diagnostic_envelope(operation="provider.review", phase="submitting", outcome="exit",
                                    stderr=cause, provider=model.provider, submission="noop",
                                    refusal="repeat_only" if details["repeat_only"] else "duplicate"))
        raise review_receipt.SubmissionError(
            "review submission returned no receipt; publication uncertain, reconcile before retry")
    # The outer governed behavior reads authoritative review facts afterward:
    # a receipted review reconciles as completed even when the head moved
    # after the POST, because GitHub pins the stale verdict instead of
    # rejecting it.
    return raw.strip() + "\n" + (done.stdout or done.stderr).strip() + capped_note


# ── Codex ─────────────────────────────────────────────────────────────
# Verified against Codex CLI 0.169.0 (deploy/runtime installs
# @openai/codex@latest unpinned): ChatGPT sign-in lives in
# $CODEX_HOME/auth.json; a refresh rewrites that same file (atomic
# temp-file + rename under $CODEX_HOME/auth.json.lock); `codex exec
# --ephemeral` still resolves and persists auth there; auth and history
# share CODEX_HOME, so no supported shared-auth mode preserves isolation.
# Caller copies the sign-in in once per run and never writes back: the
# isolated file is worker-writable (issue/atomic run danger-full-access),
# and same-account forged JSON is indistinguishable from a genuine
# rotation, so any copy-back could replace the sign-in. Cross-Call
# persistence stays explicitly unresolved under #1797.
def codex_environment(root: Path) -> dict:
    env = os.environ.copy()
    for key in ("OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"):
        env.pop(key, None)
    # Each review owns one fresh native conversation history: resume across
    # input fragments and inspection rounds reads this directory, and deleting
    # the review directory reclaims it. --ephemeral cannot do this — without
    # persisted history there is nothing to resume.
    home = root / "codex-home"
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Preserve sign-in, but do not import personal sessions or configuration.
    original = Path(env.get("CODEX_HOME") or Path.home() / ".codex")
    auth = original / "auth.json"
    if original.resolve() != home.resolve() and auth.is_file():
        target = home / "auth.json"
        if not target.exists():
            # Copy once: a later fragment, inspection round or file group
            # keeps this run's rotated credential instead of re-copying the
            # older original over it.
            shutil.copyfile(auth, target)
            target.chmod(0o600)
    env["CODEX_HOME"] = str(home)
    return env


def codex_command(model: Model) -> list[str]:
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
    ]
    # No shell, connectors, extensions, or delegated agents. The empty
    # work directory also prevents loading PR checkout instructions.
    for feature in ("shell_tool", "unified_exec", "apps", "plugins", "hooks",
                    "multi_agent", "browser_use", "computer_use", "image_generation",
                    "code_mode", "code_mode_host", "skill_search"):
        args.extend(["--disable", feature])
    return args


def verify_codex_login(root: Path, model: Model) -> int:
    if model.provider != "codex":
        raise ValueError("Codex sign-in verification requires a Codex model")
    original = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex") / "auth.json"
    env = codex_environment(root)
    done = subprocess.run([*codex_command(model), "--ephemeral", "--json", "Reply with exactly OK. Do not use tools."],
                          cwd=root, env=env, timeout=30)
    if done.returncode:
        return done.returncode
    # A refresh left only in this disposable home cannot seed the next Call.
    # Persistence belongs to #1822; never copy worker-writable credentials back.
    isolated = Path(env["CODEX_HOME"]) / "auth.json"
    if not original.is_file() or not isolated.is_file() or original.read_bytes() != isolated.read_bytes():
        raise RuntimeError("Codex verification credentials are unavailable to the next Caller worker. Connect again in Settings → Accounts.")
    return 0


def ask_codex(root: Path, model: Model, system: str, text: str, schema: dict, watch: ReviewWatch, timeout: float) -> str:
    output = root / "verdict.json"
    output.unlink(missing_ok=True)
    prompt = f"{system}\n\n{text}"
    state_path = root / "codex-session.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else None
    same_prefix = (state is not None and state["prefix_digest"] == sha256(prompt[:state["prefix_length"]].encode()).hexdigest())
    args = [*codex_command(model), "--output-schema", str(root / "verdict.schema.json"),
            "--output-last-message", str(output), "--json"]
    env = codex_environment(root)
    # Each review owns one fresh native conversation. Resume that exact ID
    # with only newly supplied inspection evidence, retaining the provider's
    # prior analysis instead of recomputing the whole packet each round.
    message = prompt[state["prefix_length"]:] if same_prefix else prompt
    fragments = [message]
    if len(message) > CODEX_MAX_INPUT_CHARS:
        # Keep the input intact in one native conversation. Intermediate
        # turns only acknowledge receipt; only the last can return a verdict.
        width = CODEX_MAX_INPUT_CHARS - 1024
        fragments = [message[start:start + width] for start in range(0, len(message), width)]
    # A new file group needs its full prompt, but keeps the earlier groups'
    # analysis and inspection in this review's native conversation.
    thread_id = state["thread_id"] if state is not None else None
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
            raise subprocess.TimeoutExpired("codex review input", timeout)
        done = watch.run(command, input=part, cwd=str(root), timeout=remaining, env=env, provider="codex")
        if done.returncode:
            code, sig = (None, -done.returncode) if done.returncode < 0 else (done.returncode, None)
            cause = ""
            # A failed process may leave truncated events. Keep its exit/signal
            # classification; successful output still uses strict parsing below.
            for line in reversed(done.stdout.splitlines()):
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(event, dict) or event.get("type") not in ("error", "turn.failed"):
                    continue
                error = event.get("error")
                messages = (error.get("message") if isinstance(error, dict) else error, event.get("message"))
                cause = next((message.strip() for message in messages if isinstance(message, str) and message.strip()), "")
                if cause:
                    break
            if not cause:
                # A blocked account still types as blocked when codex says so
                # without an error prefix, as its full stderr once did.
                cause = next((line.strip() for line in reversed(done.stderr.splitlines())
                              if re.match(r"(?:error\b|fatal\b|thread .+ panicked at\b)", line.strip(), re.IGNORECASE)
                              or provider_blocked(line)), "")
            status = f"signal {sig}" if sig is not None else f"exit {code}"
            provider_failure(cause or f"cause unavailable (codex {status})",
                             provider="codex", exit_code=code, signal=sig)
        # Startup item errors can be notices about disabled tools. Failed
        # turns and actual native tool executions still reject the verdict.
        observed_thread = None
        completed_turns = 0
        for event in events(done.stdout):
            if event.get("type") in {"error", "turn.failed"}:
                error = event.get("error")
                messages = (error.get("message") if isinstance(error, dict) else error, event.get("message"))
                cause = next((message.strip() for message in messages
                              if isinstance(message, str) and message.strip()),
                             "Codex review did not complete successfully")
                provider_error("codex", cause)
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
