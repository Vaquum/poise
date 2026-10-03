"""Read provider activity and explicitly exposed reasoning; omit prompts and arguments."""
from __future__ import annotations

import json
import os

from . import progress

READ_BYTES = 256 * 1024
MAX_LINE_BYTES = 1024 * 1024
# The field naming an event's kind, per provider stream.
KIND_KEY = {"antigravity": "event", "muse": "payload_type"}


class ProviderStream:
    def __init__(self, provider: str | None):
        self.provider = provider
        self.offset = 0
        self.buffer = b""
        self.skipping = False
        self.thinking_streamed = False

    def read(self, stream, *, final: bool = False) -> None:
        if not self.provider:
            return
        # pread does not move the writer's shared file offset. Keeping stdout
        # on disk also avoids a slow observer blocking provider output pipes.
        while True:
            try:
                chunk = os.pread(stream.fileno(), READ_BYTES, self.offset)
            except OSError:
                progress.warning()
                return
            self.offset += len(chunk)
            self.feed(chunk)
            if not final or not chunk:
                break
        if final and self.buffer and not self.skipping:
            self.line(self.buffer)
            self.buffer = b""

    def feed(self, chunk: bytes) -> None:
        for index, piece in enumerate(chunk.split(b"\n")):
            if index:
                if not self.skipping and self.buffer:
                    self.line(self.buffer)
                self.buffer = b""
                self.skipping = False
            if not self.skipping:
                self.buffer += piece
                if len(self.buffer) > MAX_LINE_BYTES:
                    self.buffer = b""
                    self.skipping = True
                    progress.warning()

    def line(self, line: bytes) -> None:
        try:
            event = json.loads(line)
            if not isinstance(event, dict) or not isinstance(event.get(KIND_KEY.get(self.provider, "type")), str):
                raise ValueError("not a provider event")
            phase, message = observation(self.provider, event)
            if self.provider == "claude" and (event.get("event") or {}).get("type") == "message_start":
                self.thinking_streamed = False
            text = reasoning_text(self.provider, event)
            if self.provider == "claude":
                if event["type"] == "assistant" and self.thinking_streamed:
                    text = None
                elif event["type"] == "stream_event" and text:
                    self.thinking_streamed = True
            progress.provider_event(phase, message, text)
        except (TypeError, ValueError, AttributeError):
            progress.warning()


def reasoning_text(provider: str, event: dict) -> str | None:
    # Only text the provider explicitly exposes; never arguments or prompts.
    if provider == "claude" and event.get("type") == "stream_event":
        delta = (event.get("event") or {}).get("delta") or {}
        if delta.get("type") == "thinking_delta" and isinstance(delta.get("thinking"), str):
            return delta["thinking"]
    if provider == "claude" and event.get("type") == "assistant":
        blocks = (event.get("message") or {}).get("content") or []
        return "\n".join(block["thinking"] for block in blocks
                         if isinstance(block, dict) and block.get("type") == "thinking"
                         and isinstance(block.get("thinking"), str)) or None
    if provider == "codex" and event.get("type") == "item.completed":
        item = event.get("item") or {}
        if item.get("type") == "reasoning" and isinstance(item.get("text"), str):
            return item["text"] + "\n"
    if provider == "grok" and event.get("type") == "thought" and isinstance(event.get("data"), str):
        return event["data"]
    return None


def observation(provider: str, event: dict) -> tuple[str | None, str | None]:
    kind = event[KIND_KEY.get(provider, "type")]
    if provider == "claude":
        if kind == "system":
            if event.get("subtype") == "api_retry":
                message = "Provider retry"
                if event.get("error") in {"rate_limit", "overloaded", "authentication_failed", "server_error", "max_output_tokens", "model_not_found"}:
                    message += ": " + event["error"].replace("_", " ")
                attempt = event.get("attempt")
                delay = event.get("retry_delay_ms")
                if type(attempt) is int and 0 <= attempt <= 10000:
                    message += f"; attempt {attempt}"
                if type(delay) is int and 0 <= delay <= 3600000:
                    message += f"; waiting {delay / 1000:g}s"
                return "retrying", message
            if event.get("subtype") == "init":
                return "waiting_provider", "Provider initialized"
        if kind == "stream_event":
            raw = event.get("event") or {}
            block = raw.get("content_block") or raw.get("delta") or {}
            subtype = block.get("type", "")
            if subtype in {"thinking", "thinking_delta", "signature_delta"}:
                return "reasoning", "Provider reported reasoning activity"
            if subtype in {"text", "text_delta"}:
                return "responding", "Receiving response"
            if subtype in {"tool_use", "input_json_delta"}:
                return "preparing_tool", "Provider preparing a tool request"
        if kind == "assistant":
            blocks = (event.get("message") or {}).get("content") or []
            if any(isinstance(block, dict) and block.get("type") == "tool_use" for block in blocks):
                return "tool_requested", "Provider requested a tool"
        if kind == "tool_progress":
            return "tool_running", "Provider reported tool execution"
        if kind == "user":
            return "waiting_provider", "Tool result returned to provider"
        if kind == "result":
            failed = event.get("is_error") or event.get("subtype") != "success"
            return ("provider_error", "Provider reported an error") if failed else ("provider_finished", "Provider returned a result")
    elif provider == "codex":
        if kind in {"thread.started", "turn.started"}:
            return "waiting_provider", "Provider started"
        if kind in {"turn.failed", "error"}:
            return "provider_error", "Provider reported an error"
        if kind == "turn.completed":
            return "provider_finished", "Provider completed its turn"
        item = event.get("item") or {}
        if item.get("type") == "reasoning":
            return "reasoning", "Provider reported reasoning activity"
        if item.get("type") == "agent_message":
            return "responding", "Receiving response"
        if item.get("type") in {"command_execution", "mcp_tool_call"}:
            return "tool_running", "Provider reported tool execution"
    elif provider == "grok":
        # Grok Build's streaming-json output (issue reviews; PR reviews read one final JSON).
        if kind == "thought":
            return "reasoning", "Provider reported reasoning activity"
        if kind == "text":
            return "responding", "Receiving response"
        if kind in {"tool_call", "tool_call_update"}:
            return "tool_running", "Provider reported tool execution"
        if kind == "end":
            failed = event.get("stopReason") != "end_turn"
            return ("provider_error", "Provider reported an error") if failed else ("provider_finished", "Provider returned a result")
    elif provider == "antigravity":
        if kind == "init":
            return "waiting_provider", "Provider initialized"
        if kind == "step_update":
            step = (event.get("step_update") or {}).get("step_type")
            if step == "agent_response":
                return "responding", "Receiving response"
            if step == "tool":
                return "tool_running", "Provider reported tool execution"
        if kind == "result":
            failed = (event.get("result") or {}).get("status") != "SUCCESS"
            return ("provider_error", "Provider reported an error") if failed else ("provider_finished", "Provider returned a result")
    elif provider == "muse":
        payload = event.get("payload") or {}
        if kind == "run.lifecycle.started":
            return "waiting_provider", "Provider started"
        if kind == "task.lifecycle.proposed":
            task = str((payload.get("event") or {}).get("task_kind", ""))
            if task.startswith("tool."):
                return "tool_running", "Provider reported tool execution"
        if kind == "run.output.delta":
            return "responding", "Receiving response"
        if kind == "run.terminal.completed":
            failed = payload.get("terminal") != "completed"
            return ("provider_error", "Provider reported an error") if failed else ("provider_finished", "Provider returned a result")
        if kind.startswith("run.terminal"):
            return "provider_error", "Provider reported an error"
    return None, None


def claude_result(output: str) -> str:
    # Progress parsing is observational. GitHub facts still decide the review
    # outcome even if the provider's final message is missing or malformed.
    result = ""
    for line in output.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and event.get("type") == "result":
            text = event.get("result")
            errors = event.get("errors")
            if isinstance(text, str):
                result = text
            elif isinstance(errors, list):
                result = "\n".join(item for item in errors if isinstance(item, str))
    return result.strip()


def claude_error(output: str) -> str:
    result = claude_result(output)
    if result:
        return result
    diagnostics = []
    for line in output.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            if line.strip():
                diagnostics.append(line.strip()[:500])
            continue
        if isinstance(event, dict) and isinstance(event.get("error"), str):
            diagnostics.append(event["error"][:500])
    return "\n".join(diagnostics[-4:])
