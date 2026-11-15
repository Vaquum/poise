"""Substantive responses carried by the existing native review receipt."""
import hashlib
import json
import os
import re
import time
from datetime import datetime

import httpx

from github_interface.atoms.pulls import get_review_thread, list_reviews, resolve_conversation
from github_interface.atoms.review_identity import require_owned_reviews
from github_interface.client import GitHubClient


def assessment(value: object) -> dict:
    if not isinstance(value, dict) or set(value) != {"verdict", "reviewed_context", "limitations"}:
        raise ValueError("review assessment requires verdict, reviewed_context and limitations")
    for key, minimum in (("verdict", 20), ("reviewed_context", 20), ("limitations", 4)):
        text = value[key]
        if not isinstance(text, str) or not minimum <= len(text.strip()) <= 4000:
            raise ValueError(f"review assessment {key} must contain {minimum}-4000 characters")
    if value["verdict"].strip() == "Reviewed: no blocking findings.":
        raise ValueError("fixed clean acknowledgement is not a substantive assessment")
    return value


def context_sha(pull: dict) -> str:
    base = (pull.get("base") or {}).get("sha")
    if not isinstance(base, str) or not re.fullmatch(r"[0-9a-f]{40}", base):
        raise ValueError("review context requires the PR base SHA")
    if not isinstance(pull.get("title"), str) or pull.get("body") is not None and not isinstance(pull["body"], str):
        raise ValueError("review context requires the PR title and body")
    return hashlib.sha256(json.dumps([base, pull["title"], pull.get("body") or ""],
                                     ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def response_body(response: dict) -> str:
    value = assessment(response["assessment"])
    coverage = "Coverage: incomplete; required source remains unreviewed.\n\n" if response.get("coverage") == "incomplete" else ""
    return (f"{coverage}{value['verdict']}\n\nReviewed context: {value['reviewed_context']}\n\n"
            f"Limitations: {value['limitations']}\n\n<!-- poise-review-response "
            + json.dumps(response, ensure_ascii=False, separators=(",", ":")) + " -->")


def parse_body(body: str) -> dict | None:
    match = re.search(r"<!-- poise-review-response (\{[^\n]+\}) -->", body)
    if match is None:
        return None
    try:
        value = json.loads(match[1])
        assessment(value["assessment"])
    except (ValueError, KeyError, TypeError):
        return None
    return value


def submission_response(payload: dict, pull: dict, repo: str, number: int, head: str, actor: str,
                        *, require_complete: bool = False) -> dict:
    raw = payload.get("assessment")
    roots = raw.get("verified_fixes", []) if isinstance(raw, dict) else []
    value = assessment({key: item for key, item in raw.items() if key != "verified_fixes"} if isinstance(raw, dict) else raw)
    context = context_sha(pull)
    # The governed runner retained the provider's response before entering
    # this command. Standalone submissions cannot acquire native ownership.
    if os.environ.get("AGENT_INTERFACE_RECEIPT_CALL"):
        from agent_interface.review_receipt import retained_response
        response = retained_response()
        if response["assessment"] != value or response["repository"].lower() != repo.lower() \
                or response["pull_number"] != number or response["head_sha"] != head \
                or response["context_sha"] != context or response["reviewer"].lower() != actor.lower() \
                or not isinstance(roots, list) or any(type(root) is not int for root in roots) \
                or sorted(roots) != sorted(int(root) for root in response.get("verified_fixes", {})):
            raise RuntimeError("retained review response differs from the current PR context")
        if require_complete and response.get("coverage") != "complete":
            raise RuntimeError("review_incomplete: required source coverage is not complete; clearance refused")
        return response
    if roots != []:
        raise ValueError("verified fixes require a managed review")
    return {"assessment": value, "repository": repo, "pull_number": number, "head_sha": head,
            "context_sha": context, "reviewer": actor, "invocation_id": None, "model": None,
            "completed_at": int(time.time() * 1000)}


async def resolve_verified_fixes(client: GitHubClient, owner: str, repo: str, response: dict | None,
                                 review_id: int | None, blocked: set[int] | None = None) -> dict:
    fixes = response.get("verified_fixes") if response else None
    if not fixes:
        return {}
    from agent_interface.review_receipt import checkpoint_verified_resolution

    actor = response["reviewer"].lower()
    resolved, skipped = [], []
    result = {"resolved": resolved, "skipped": skipped}
    try:
        if "GITHUB_INTERFACE_AUTOMATED_REVIEWS" in os.environ:
            reviews = await list_reviews(client, owner, repo, response["pull_number"])
            require_owned_reviews([review for review in reviews if review["id"] != review_id], actor)
        for key, fix in fixes.items():
            root = int(key)
            if blocked and root in blocked:
                skipped.append(root)
                continue
            thread = await get_review_thread(client, fix["id"])
            pull = thread["pull"]
            author = str((pull.get("author") or {}).get("login") or "").lower()
            if pull["number"] != response["pull_number"] or pull["repository"]["nameWithOwner"].lower() != response["repository"].lower() \
                    or pull["state"] != "OPEN" or pull["isDraft"] or pull["headRefOid"] != response["head_sha"] \
                    or context_sha({"base": {"sha": pull["baseRefOid"]}, "title": pull["title"], "body": pull["body"]}) != response["context_sha"]:
                result["stale"] = True
                break
            answer = thread.get("repair_answer") or {}
            if thread["id"] != fix["id"] or thread["root_comment_id"] != root or not thread["can_resolve"] \
                    or thread["is_resolved"] or thread["author"].lower() != actor or not author or author == actor \
                    or answer.get("author", "").lower() != author or answer.get("revision") != fix["revision"]:
                skipped.append(root)
                continue
            checkpoint_verified_resolution(response, review_id, thread["id"])
            receipt = await resolve_conversation(client, thread["id"])
            if receipt.get("id") != thread["id"] or receipt.get("isResolved") is not True:
                raise RuntimeError("GitHub did not confirm the verified thread resolution")
            checkpoint_verified_resolution(response, review_id, thread["id"], resolved=True)
            resolved.append(root)
    except (RuntimeError, httpx.HTTPError) as error:
        # The accepted review is a separate effect. Keep its receipt and
        # surface the incomplete resolution without replaying the mutation.
        result["error"] = str(error)[:1000]
    return {"thread_resolution": result}


def qualifying_response(response: object, pull: dict, repo: str, number: int, head: str, actor: str) -> bool:
    if not isinstance(response, dict):
        return False
    try:
        assessment(response.get("assessment"))
        return (response.get("repository", "").lower() == repo.lower() and response.get("pull_number") == number
                and response.get("coverage") == "complete"
                and response.get("head_sha") == head and response.get("context_sha") == context_sha(pull)
                and response.get("reviewer", "").lower() == actor.lower()
                and isinstance(response.get("invocation_id"), str)
                and re.fullmatch(r"[0-9a-f]{32}", response["invocation_id"]) is not None
                and isinstance(response.get("model"), str) and bool(response["model"])
                and type(response.get("completed_at")) is int and 0 < response["completed_at"] <= time.time() * 1000)
    except (ValueError, TypeError, AttributeError):
        return False


def matches_review(response: dict, review: dict) -> bool:
    """An account alone never establishes the originating invocation."""
    body = review.get("body") or ""
    try:
        stamp = datetime.fromisoformat(review["submitted_at"].replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            return False
        submitted = stamp.timestamp() * 1000
    except (KeyError, ValueError, TypeError, AttributeError):
        return False
    return (review.get("id") == response.get("review_id") and review.get("state") in {"APPROVED", "COMMENTED"}
            and review.get("commit_id") == response.get("head_sha")
            and str((review.get("user") or {}).get("login") or "").lower() == response.get("reviewer", "").lower()
            and body.endswith(f"<!-- poise-invocation {response.get('invocation_id')} -->")
            and parse_body(body) == {key: value for key, value in response.items() if key != "review_id"}
            and response["completed_at"] <= submitted + 999 <= time.time() * 1000 + 999)
