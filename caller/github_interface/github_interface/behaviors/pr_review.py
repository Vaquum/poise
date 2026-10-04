from typing import Any

from github_interface.atoms.issues import linked_issues
from github_interface.atoms.pulls import (
    get_pull,
    list_inline_comments,
    list_review_threads,
)
from github_interface.atoms.review_diff import review_diff
from github_interface.client import GitHubClient
from github_interface.context import expected_head, repository
from github_interface.context import pull_number as parse_pull_number

REQUIRE_TOKEN_USER = True
DEFAULT_P = 2


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    pull_number = parse_pull_number(payload)
    required_head = expected_head(payload)
    p = _p(payload.get("p"))

    pull = await get_pull(client, owner, repo, pull_number)
    actual_head = str((pull.get("head") or {}).get("sha") or "").lower()
    if actual_head != required_head:
        raise RuntimeError(
            f"pull-request head changed: expected {required_head}, got {actual_head or 'missing'}"
        )
    rest_comments = await list_inline_comments(client, owner, repo, pull_number)
    threads = await list_review_threads(client, owner, repo, pull_number)
    issues = await linked_issues(client, owner, repo, pull_number)

    context = {
        "action": "read",
        "repository": f"{owner}/{repo}",
        "pull_number": pull_number,
        "head_sha": required_head,
        "p": f"p{p}",
        "instructions": _instructions(p),
        "pull": pull,
        "existing_inline_comments": _comment_summary(rest_comments),
        "review_threads": threads,
        "resolved_threads": [thread for thread in threads if thread["is_resolved"]],
        "linked_issues": issues,
    }
    packet_diff = await review_diff(client, owner, repo, pull, context)
    latest = await get_pull(client, owner, repo, pull_number)
    if latest["head"]["sha"] != required_head or latest["base"]["sha"] != pull["base"]["sha"]:
        raise RuntimeError("pull-request head or base changed while building review packet")
    return {**context, **packet_diff}


def _p(value: Any) -> int:
    if value in (None, ""):
        return DEFAULT_P
    text = str(value).strip().lower().removeprefix("p")
    if not text.isdigit() or int(text) < 0:
        raise ValueError("p must look like p2")
    return int(text)


def _instructions(p: int) -> list[str]:
    levels = "/".join(f"p{level}" for level in range(p + 1))
    return [
        "If only positive things remain, record one clean review.",
        "Never publish duplicate inline comments or re-litigate resolved findings. An outdated location does not prove a defect is fixed; reaffirm an unresolved outdated finding only after confirming it still blocks the supplied head, using its original body and path.",
        "For an existing current, unresolved finding that still blocks this head, include its original body and exact path, current line, and side in the request-changes comments array.",
        "github-interface deduplicates existing findings and can reaffirm them with one summary-only change-request review; do not send an empty comments array.",
        f"Make one inline comment per {levels} found issue.",
        f"For non-{levels} do nothing",
    ]


def _comment_summary(comments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "path": comment.get("path"),
            "line": comment.get("line") or comment.get("original_line"),
            "side": comment.get("side"),
            "body": comment.get("body"),
            "user": (comment.get("user") or {}).get("login"),
        }
        for comment in comments
    ]


def accepted_inline_comments(
    comments: list[dict[str, Any]],
    rest_comments: list[dict[str, Any]],
    threads: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    existing_keys = _existing_keys(rest_comments)
    resolved_keys = {
        _key(thread["path"], thread["line"], thread["side"])
        for thread in threads
        if thread["is_resolved"] and thread["line"]
    }
    existing_bodies = {_normalize(comment["body"]) for comment in _comment_summary(rest_comments) if comment.get("body")}
    for thread in threads:
        existing_bodies.update(_normalize(body) for body in thread["bodies"])

    accepted = []
    skipped = []
    seen_keys = set()
    seen_bodies = set()

    for comment in comments:
        inline = _inline_comment(comment)
        key = _key(inline["path"], inline["line"], inline["side"])
        body = _normalize(inline["body"])

        if key in existing_keys or key in resolved_keys:
            skipped.append({"reason": "already_commented_or_resolved", "comment": comment})
        elif body in existing_bodies or body in seen_bodies:
            skipped.append({"reason": "repeat", "comment": comment})
        elif key in seen_keys:
            skipped.append({"reason": "one_comment_per_issue", "comment": comment})
        else:
            accepted.append(inline)
            seen_keys.add(key)
            seen_bodies.add(body)

    return accepted, skipped


def _inline_comment(comment: dict[str, Any]) -> dict[str, Any]:
    for field in ("path", "line", "body"):
        if field not in comment:
            raise ValueError(f"inline comment missing {field}")

    side = str(comment.get("side", "RIGHT")).upper()
    if side not in {"LEFT", "RIGHT"}:
        raise ValueError("inline comment side must be LEFT or RIGHT")

    inline = {
        "path": str(comment["path"]),
        "line": int(comment["line"]),
        "side": side,
        "body": str(comment["body"]).strip(),
    }
    if not inline["body"]:
        raise ValueError("inline comment body cannot be empty")
    return inline


def _existing_keys(comments: list[dict[str, Any]]) -> set[tuple[str, int, str]]:
    keys = set()
    for comment in comments:
        line = comment.get("line") or comment.get("original_line")
        path = comment.get("path")
        side = comment.get("side") or "RIGHT"
        if path and line:
            keys.add(_key(path, line, side))
    return keys


def _key(path: str, line: int, side: str) -> tuple[str, int, str]:
    return str(path), int(line), str(side).upper()


def _normalize(body: str) -> str:
    return " ".join(str(body).lower().split())
