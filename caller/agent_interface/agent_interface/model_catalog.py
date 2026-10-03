from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType

import tomllib

CATALOG_PATH = Path(__file__).with_name("models.toml")
DATA_DIR = Path(os.getenv("AGENT_INTERFACE_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
RUNTIME_CATALOG_PATH = DATA_DIR / "models.toml"
SCHEMA_VERSION = 2
MODEL_KEYS = frozenset({"provider", "selector", "effort"})
# Effort tiers each provider CLI accepts, lowest first. Confirmed against the
# CLIs on 2026-09-16: Claude and Grok print this list on an unknown value,
# Codex and Grok ship it in their model caches, Muse in its --help.
PROVIDER_EFFORTS: Mapping[str, tuple[str, ...]] = MappingProxyType({
    "claude": ("low", "medium", "high", "xhigh", "max"),
    "codex": ("low", "medium", "high", "xhigh", "max", "ultra"),
    "grok": ("low", "medium", "high", "xhigh"),
    "antigravity": ("low", "medium", "high"),
    "muse": ("none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"),
})
# Claude reviews with governed tools; every other provider returns one
# structured verdict that Caller validates and submits (structured_review).
REVIEW_PROVIDERS = frozenset(PROVIDER_EFFORTS)
REVIEW_BEHAVIORS = ("pr_review", "pr_approve", "review_recovery")
# Issue review runs each provider's own CLI with full access; the caller
# always names the model, so it has no catalog assignment.
ISSUE_REVIEW_PROVIDERS = frozenset(PROVIDER_EFFORTS)
# Behaviors that restrict the agent to allowed tools; only Claude enforces that.
TOOL_BEHAVIORS = ("fix_failing_ci", "issue_simplify", "author_content", "debate_moderator")
MODEL_BEHAVIORS = REVIEW_BEHAVIORS + TOOL_BEHAVIORS
BEHAVIOR_KEYS = frozenset((*MODEL_BEHAVIORS, "debate_participants"))
IDENTITY_RE = re.compile(r"[a-z0-9][a-z0-9.-]{0,127}")
VALUE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")


class ModelCatalogError(RuntimeError):
    pass


@dataclass(frozen=True)
class Model:
    identity: str
    provider: str
    selector: str
    effort: str

    @property
    def supports_allowed_tools(self) -> bool:
        return self.provider == "claude"


@dataclass(frozen=True)
class ModelCatalog:
    path: Path
    models: Mapping[str, Model]
    behaviors: Mapping[str, str]
    debate_participants: tuple[str, ...]

    def resolve(self, identity: str) -> Model:
        model = self.models.get(identity)
        if model is None:
            configured = ", ".join(self.models)
            raise ModelCatalogError(f"unknown model {identity!r}; configured models: {configured}")
        return model

    def behavior(self, behavior: str) -> Model:
        try:
            return self.models[self.behaviors[behavior]]
        except KeyError as error:
            raise ModelCatalogError(f"model catalog has no assignment for behavior {behavior!r}") from error

    def review_model(self, behavior: str, override: str | None = None) -> Model:
        if behavior not in {"pr_review", "pr_approve"}:
            raise ModelCatalogError(f"{behavior!r} does not support a review model override")
        model = self.resolve(override) if override is not None else self.behavior(behavior)
        if model.provider not in REVIEW_PROVIDERS:
            raise ModelCatalogError(f"PR reviews support only {', '.join(sorted(REVIEW_PROVIDERS))} models, not {model.identity}")
        return model

    def issue_review_model(self, identity: str) -> Model:
        model = self.resolve(identity)
        if model.provider not in ISSUE_REVIEW_PROVIDERS:
            raise ModelCatalogError(f"issue reviews support only {', '.join(sorted(ISSUE_REVIEW_PROVIDERS))} models, not {model.identity}")
        return model

    def export(self) -> dict:
        return {
            "schema_version": SCHEMA_VERSION,
            "path": str(self.path),
            "models": [
                {"identity": m.identity, "provider": m.provider, "selector": m.selector, "effort": m.effort}
                for m in self.models.values()
            ],
            "behaviors": dict(self.behaviors),
            "debate_participants": list(self.debate_participants),
            "review_providers": sorted(REVIEW_PROVIDERS),
            "issue_review_providers": sorted(ISSUE_REVIEW_PROVIDERS),
        }


def _error(path: Path, detail: str) -> ModelCatalogError:
    return ModelCatalogError(f"invalid model catalog {path}: {detail}")


def _model(path: Path, identity: object, body: object) -> Model:
    if not isinstance(identity, str) or not IDENTITY_RE.fullmatch(identity):
        raise _error(path, f"invalid model identity {identity!r}")
    if not isinstance(body, dict) or frozenset(body) != MODEL_KEYS:
        raise _error(path, f"models.{identity} must have exactly the keys {sorted(MODEL_KEYS)}")
    values = {}
    for key in sorted(MODEL_KEYS):
        value = body[key]
        if not isinstance(value, str) or not VALUE_RE.fullmatch(value):
            raise _error(path, f"models.{identity}.{key} must be a non-empty safe string")
        values[key] = value
    efforts = PROVIDER_EFFORTS.get(values["provider"])
    if efforts is None:
        raise _error(path, f"models.{identity} has unknown provider {values['provider']!r}")
    if values["effort"] not in efforts:
        raise _error(path, f"models.{identity} has invalid {values['provider']} effort {values['effort']!r}")
    if not identity.endswith(f"-{values['effort']}"):
        raise _error(path, f"models.{identity} must end with its effort {values['effort']!r}")
    return Model(identity, values["provider"], values["selector"], values["effort"])


def load_catalog(path: str | Path = CATALOG_PATH) -> ModelCatalog:
    source = Path(path)
    try:
        raw = source.read_bytes()
    except OSError as error:
        raise _error(source, f"cannot read file: {error}") from error
    try:
        document = tomllib.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
        raise _error(source, f"cannot parse TOML: {error}") from error
    if frozenset(document) != {"schema_version", "models", "behaviors"}:
        raise _error(source, "root keys must be schema_version, models, behaviors")
    if type(document["schema_version"]) is not int or document["schema_version"] != SCHEMA_VERSION:
        raise _error(source, f"schema_version must be integer {SCHEMA_VERSION}")
    raw_models = document["models"]
    if not isinstance(raw_models, dict) or not raw_models:
        raise _error(source, "models must be a non-empty table")
    models = {identity: _model(source, identity, body) for identity, body in raw_models.items()}

    raw_behaviors = document["behaviors"]
    if not isinstance(raw_behaviors, dict):
        raise _error(source, "behaviors must be a table")
    behavior_keys = frozenset(raw_behaviors)
    if behavior_keys != BEHAVIOR_KEYS:
        raise _error(
            source,
            "behavior keys mismatch"
            f"; missing={sorted(BEHAVIOR_KEYS - behavior_keys)}"
            f"; unknown={sorted(behavior_keys - BEHAVIOR_KEYS)}",
        )
    assignments: dict[str, str] = {}
    for behavior in MODEL_BEHAVIORS:
        identity = raw_behaviors[behavior]
        if not isinstance(identity, str) or identity not in models:
            raise _error(source, f"behaviors.{behavior} must name a configured model")
        provider = models[identity].provider
        if behavior in REVIEW_BEHAVIORS and provider not in REVIEW_PROVIDERS:
            raise _error(source, f"behaviors.{behavior} requires a {' or '.join(sorted(REVIEW_PROVIDERS))} model")
        if behavior in TOOL_BEHAVIORS and provider != "claude":
            raise _error(source, f"behaviors.{behavior} requires the Claude provider")
        assignments[behavior] = identity

    raw_participants = raw_behaviors["debate_participants"]
    if not isinstance(raw_participants, list) or not raw_participants:
        raise _error(source, "behaviors.debate_participants must be a non-empty array")
    if any(not isinstance(identity, str) or identity not in models for identity in raw_participants):
        raise _error(source, "every debate participant must name a configured model")
    if len(set(raw_participants)) != len(raw_participants):
        raise _error(source, "debate participants must be unique")

    return ModelCatalog(source, MappingProxyType(models), MappingProxyType(assignments), tuple(raw_participants))


def catalog_path() -> Path:
    return RUNTIME_CATALOG_PATH if RUNTIME_CATALOG_PATH.is_file() else CATALOG_PATH


CATALOG = load_catalog(catalog_path())
