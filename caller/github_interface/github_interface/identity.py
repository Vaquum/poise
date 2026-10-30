"""Which GitHub account a behavior acts as.

Several accounts are signed in to gh in one workspace, so a behavior never
takes gh's active account: it acts as the account --token-user names or,
without one, as the account configured for its identity class.
"""
import os
import re
from typing import Any

# The agent account: everything an agent does or reads for its own work —
# reviews, comments, checkouts, CI fixes.
AGENT = "GITHUB_INTERFACE_AGENT_USER"
# The person's own account: reads done as them, such as their repositories.
PERSON = "GITHUB_INTERFACE_USER"

_LOGIN = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?")


def account(identity: str, payload: dict[str, Any]) -> str:
    explicit = str(payload.get("token_user") or "").strip()
    if explicit:
        return _login(explicit, "token-user")
    configured = os.environ.get(identity, "").strip()
    if configured:
        return _login(configured, identity)
    raise ValueError(f"no GitHub account to act as: pass --token-user or set {identity}")


def _login(value: str, source: str) -> str:
    if not _LOGIN.fullmatch(value):
        raise ValueError(f"{source} must be a GitHub username")
    return value
