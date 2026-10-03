from pathlib import Path
import re
from subprocess import run as shell
from typing import Any
from urllib.parse import urlparse


def repository(payload: dict[str, Any]) -> tuple[str, str]:
    value = payload.get("repository")
    if value is None and "/" in str(payload.get("repo", "")):
        value = payload["repo"]
    if value:
        parts = str(value).strip().strip("/").split("/")
        if len(parts) != 2 or not all(parts):
            raise ValueError("repository must look like org/repo")
        return parts[0], parts[1]

    if payload.get("owner") and payload.get("repo"):
        return str(payload["owner"]), str(payload["repo"])

    remote = _git_remote()
    if remote:
        return remote

    parts = Path.cwd().resolve().parts
    if len(parts) < 2:
        raise ValueError("cwd must be <org>/<repo>")
    return parts[-2], parts[-1]


def pull_number(payload: dict[str, Any]) -> int:
    value = payload.get("pr") or payload.get("id") or payload.get("pull_request") or payload.get("pull_number")
    if value is None:
        raise ValueError("payload must include pr")

    number = str(value).strip().lstrip("#")
    if not number.isdigit() or int(number) < 1:
        raise ValueError("pr must look like #334")
    return int(number)


def issue_number(payload: dict[str, Any]) -> int:
    value = payload.get("issue") or payload.get("id") or payload.get("issue_number")
    if value is None:
        raise ValueError("issue is required")

    number = str(value).strip().lstrip("#")
    if not number.isdigit() or int(number) < 1:
        raise ValueError("issue must look like #123")
    return int(number)


def expected_head(payload: dict[str, Any]) -> str:
    value = str(payload.get("expected_head") or "").strip().lower()
    if not re.fullmatch(r"[0-9a-f]{40}", value):
        raise ValueError("expected-head must be a 40-character commit SHA")
    return value


def token_user(payload: dict[str, Any]) -> str:
    value = str(payload.get("token_user") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?", value):
        raise ValueError("token-user must be a GitHub username")
    return value


def _git_remote() -> tuple[str, str] | None:
    result = shell(["git", "remote", "get-url", "origin"], capture_output=True, text=True)
    if result.returncode != 0:
        return None

    remote = result.stdout.strip().removesuffix(".git")
    path = remote.rsplit(":", 1)[1] if "@" in remote and ":" in remote else urlparse(remote).path.strip("/")
    parts = path.split("/")
    if len(parts) >= 2 and parts[-2] and parts[-1]:
        return parts[-2], parts[-1]
    return None
