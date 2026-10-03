"""Keep the model catalog current: the latest model per family, its top two efforts.

Claude and Codex each keep two lines (Opus and Fable; Astra and Sol), the
latest model of each line.

Each family has a source the routine can call rather than research: Claude
Code resolves an alias to a concrete model in its JSON print output, Codex and
Grok Build keep a models cache written from their backends, Antigravity lists
models on demand, and Muse serves its catalog over MSP. A family whose source is
unavailable keeps its current rows; nothing is ever dropped silently.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import threading
from datetime import datetime, timezone
from time import monotonic, sleep
from pathlib import Path

from .model_catalog import (
    CATALOG_PATH,
    PROVIDER_EFFORTS,
    RUNTIME_CATALOG_PATH,
    SCHEMA_VERSION,
    Model,
    ModelCatalog,
    catalog_path,
    load_catalog,
)

PROBE_PROMPT = "Reply with exactly OK."
FAMILIES = ("claude", "codex", "grok", "antigravity", "muse")
CLAUDE_LINES = ("opus", "fable")
CODEX_LINES = ("astra", "sol")
# Top efforts kept per model: governed PR work runs Claude at high, one below
# the two chat tiers, so Claude keeps three.
EFFORTS_PER_MODEL = {"claude": 3}
DEFAULT_EFFORTS_PER_MODEL = 2


def tiers(provider: str) -> int:
    return EFFORTS_PER_MODEL.get(provider, DEFAULT_EFFORTS_PER_MODEL)


def rank(provider: str, efforts: list[str]) -> list[str]:
    ladder = PROVIDER_EFFORTS[provider]
    return sorted({e for e in efforts if e in ladder}, key=ladder.index, reverse=True)[:tiers(provider)]


def rows(provider: str, base: str, selector: str, efforts: list[str]) -> list[Model]:
    ranked = rank(provider, efforts)
    if not ranked:
        raise RuntimeError(f"{provider} reports no usable effort for {selector}: {efforts}")
    return [Model(f"{base}-{effort}", provider, selector, effort) for effort in ranked]


def run(args: list[str], timeout_s: int = 300, **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(args, text=True, capture_output=True, timeout=timeout_s, **kwargs)


# ── Claude Code ───────────────────────────────────────────────────────
def claude_identity_base(selector: str) -> str:
    # claude-fable-5-1 → fable-5.1; claude-opus-5 → opus-5
    return re.sub(r"-(\d+)-(\d+)(?=$|-)", r"-\1.\2", re.sub(r"^claude-", "", selector))


def claude_turn(alias: str, effort: str) -> tuple[str, bool]:
    done = run(
        [os.getenv("CLAUDE_CLI", "claude"), "--print", "--model", alias, "--effort", effort, "--output-format", "json",
         "--no-session-persistence", "--permission-mode", "dontAsk", "--tools", ""],
        input=PROBE_PROMPT,
    )
    if done.returncode:
        raise RuntimeError((done.stderr or done.stdout).strip() or f"claude exited {done.returncode}")
    # Helper calls (a Haiku title pass, a hook) show up in modelUsage too; the
    # alias resolves to the one row of its own family.
    usage = json.loads(done.stdout).get("modelUsage") or {}
    family = [name for name in usage if name.startswith(f"claude-{alias}-")]
    if len(family) != 1:
        raise RuntimeError(f"claude did not report the model behind {alias}: {sorted(usage)}")
    return family[0], "Unknown --effort value" not in done.stderr


def claude() -> list[Model]:
    found: list[Model] = []
    for alias in CLAUDE_LINES:
        accepted: list[str] = []
        selector = None
        for effort in reversed(PROVIDER_EFFORTS["claude"]):
            selector, ok = claude_turn(alias, effort)
            if ok:
                accepted.append(effort)
            if len(accepted) == tiers("claude"):
                break
        found += rows("claude", claude_identity_base(selector), selector, accepted)
    return found


# ── Codex ─────────────────────────────────────────────────────────────
def codex() -> list[Model]:
    cache = Path(os.getenv("CODEX_HOME", Path.home() / ".codex")) / "models_cache.json"
    listed = [m for m in json.loads(cache.read_text())["models"] if m.get("visibility") == "list"]
    found: list[Model] = []
    for line in CODEX_LINES:
        # A line's models share its suffix (gpt-6-astra, gpt-5.6-sol); the
        # cache ranks them by priority, lowest first.
        candidates = [m for m in listed if str(m.get("slug", "")).endswith(f"-{line}")]
        if not candidates:
            raise RuntimeError(f"{cache} lists no visible {line} model")
        latest = min(candidates, key=lambda m: m.get("priority", 10**6))
        levels = [level["effort"] if isinstance(level, dict) else level for level in latest.get("supported_reasoning_levels") or []]
        found += rows("codex", latest["slug"], latest["slug"], levels)
    return found


# ── Grok Build ────────────────────────────────────────────────────────
def grok() -> list[Model]:
    done = run([os.getenv("GROK_CLI", "grok"), "models"])
    match = re.search(r"^Default model: (\S+)$", done.stdout, re.M)
    if done.returncode or not match:
        raise RuntimeError((done.stderr or done.stdout).strip() or "grok models printed no default model")
    selector = match.group(1)
    cache = Path(os.getenv("GROK_HOME", Path.home() / ".grok")) / "models_cache.json"
    info = json.loads(cache.read_text())["models"][selector]["info"]
    return rows("grok", selector, selector, [e["id"] for e in info["reasoning_efforts"]])


# ── Antigravity (Gemini) ──────────────────────────────────────────────
ANTIGRAVITY_ROW = re.compile(r"^(gemini-(\d+(?:\.\d+)?)-[a-z0-9-]+?)-(low|medium|high)\t")


def antigravity() -> list[Model]:
    done = run([os.getenv("ANTIGRAVITY_CLI", "agy"), "models"])
    if done.returncode:
        raise RuntimeError((done.stderr or done.stdout).strip() or f"agy models exited {done.returncode}")
    efforts: dict[str, list[str]] = {}
    versions: dict[str, float] = {}
    for line in done.stdout.splitlines():
        match = ANTIGRAVITY_ROW.match(line)
        if match:
            base, version, effort = match.groups()
            efforts.setdefault(base, []).append(effort)
            versions[base] = float(version)
    if not efforts:
        raise RuntimeError("agy models listed no gemini models")
    latest = max(efforts, key=lambda base: versions[base])
    return rows("antigravity", latest, latest, efforts[latest])


# ── Muse ──────────────────────────────────────────────────────────────
def muse_models() -> list[dict]:
    proc = subprocess.Popen(
        [os.getenv("MUSE_CLI", "muse"), "serve", "--no-session-log"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    )
    replies: dict[int, dict] = {}

    def send(message: dict) -> None:
        proc.stdin.write(json.dumps(message) + "\n")
        proc.stdin.flush()

    def pump() -> None:
        for line in proc.stdout:
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(message.get("id"), int):
                replies[message["id"]] = message

    reader = threading.Thread(target=pump, daemon=True)
    reader.start()
    try:
        send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"clientInfo": {"name": "agent_interface", "version": "0"}}})
        wait(replies, 1)
        send({"jsonrpc": "2.0", "method": "initialized"})
        send({"jsonrpc": "2.0", "id": 2, "method": "model/list", "params": {}})
        reply = wait(replies, 2)
    finally:
        proc.terminate()
    if "result" not in reply:
        raise RuntimeError(f"muse model/list failed: {reply.get('error')}")
    return reply["result"]["models"]


def wait(replies: dict[int, dict], request_id: int, timeout_s: int = 60) -> dict:
    deadline = monotonic() + timeout_s
    while request_id not in replies:
        if monotonic() > deadline:
            raise RuntimeError(f"muse did not answer request {request_id}")
        sleep(0.05)
    return replies[request_id]


def muse_effort_available(selector: str, effort: str) -> bool:
    done = run(
        [os.getenv("MUSE_CLI", "muse"), "exec", "--model", selector, "--reasoning-effort", effort,
         "--disable-shell", "--disable-write", PROBE_PROMPT],
        cwd=str(Path.home()),
    )
    if done.returncode:
        raise RuntimeError((done.stderr or done.stdout).strip() or f"muse exited {done.returncode}")
    return f"reasoning effort {effort} is not available" not in done.stderr


def muse() -> list[Model]:
    models = muse_models()
    if not models:
        raise RuntimeError("muse lists no models")
    latest = next((m for m in models if m.get("isDefault")), models[0])["modelId"]
    accepted: list[str] = []
    for effort in reversed(PROVIDER_EFFORTS["muse"]):
        if muse_effort_available(latest, effort):
            accepted.append(effort)
        if len(accepted) == tiers("muse"):
            break
    return rows("muse", latest, latest, accepted)


PROBES = {"claude": claude, "codex": codex, "grok": grok, "antigravity": antigravity, "muse": muse}


# ── Catalog assembly ──────────────────────────────────────────────────
def family_rows(catalog: ModelCatalog, provider: str) -> list[Model]:
    return [m for m in catalog.models.values() if m.provider == provider]


def successor(old: str, catalog: ModelCatalog, models: dict[str, Model]) -> str:
    # A vanished identity moves to the same effort tier of its family's new
    # model; a behavior never silently changes family or tier.
    if old in models:
        return old
    before = family_rows(catalog, catalog.models[old].provider)
    after = [m for m in models.values() if m.provider == catalog.models[old].provider]
    index = min([m.identity for m in before].index(old), len(after) - 1)
    return after[index].identity


def render(models: dict[str, Model], behaviors: dict[str, str], participants: list[str]) -> str:
    lines = [
        "# Written by `agent-interface --refresh-models`: the latest model per family",
        "# (Opus and Fable, Astra and Sol) and its top efforts, keyed by identity",
        "# <family>-<version>-<effort>.",
        f"schema_version = {SCHEMA_VERSION}",
    ]
    for model in models.values():
        lines += [
            "",
            f'[models."{model.identity}"]',
            f'provider = "{model.provider}"',
            f'selector = "{model.selector}"',
            f'effort = "{model.effort}"',
        ]
    lines += ["", "[behaviors]"]
    lines += [f'{behavior} = "{identity}"' for behavior, identity in behaviors.items()]
    lines.append("debate_participants = [" + ", ".join(f'"{p}"' for p in participants) + "]")
    return "\n".join(lines) + "\n"


def refresh(probes: dict | None = None, path: Path | None = None) -> dict:
    catalog = load_catalog(catalog_path())
    target = path or RUNTIME_CATALOG_PATH
    report: dict = {"checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "path": str(target), "families": {}}
    models: dict[str, Model] = {}
    for family in FAMILIES:
        try:
            found = (probes or PROBES)[family]()
            report["families"][family] = {"status": "ok", "models": [m.identity for m in found]}
        except Exception as error:
            found = family_rows(catalog, family)
            report["families"][family] = {"status": "unavailable", "error": str(error), "models": [m.identity for m in found]}
        models.update({m.identity: m for m in found})
    behaviors = {behavior: successor(identity, catalog, models) for behavior, identity in catalog.behaviors.items()}
    participants = list(dict.fromkeys(successor(p, catalog, models) for p in catalog.debate_participants))
    report["added"] = sorted(set(models) - set(catalog.models))
    report["removed"] = sorted(set(catalog.models) - set(models))
    report["changed"] = bool(report["added"] or report["removed"]) or behaviors != dict(catalog.behaviors) or participants != list(catalog.debate_participants)
    if report["changed"]:
        content = render(models, behaviors, participants)
        target.parent.mkdir(parents=True, exist_ok=True)
        staged = target.with_suffix(".toml.new")
        staged.write_text(content)
        load_catalog(staged)
        staged.replace(target)
    return report
