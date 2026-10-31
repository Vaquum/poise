"""Substantive responses carried by the existing native review receipt."""
import hashlib
import json
import os
import re
import time
from datetime import datetime


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
    return (f"{value['verdict']}\n\nReviewed context: {value['reviewed_context']}\n\n"
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


def submission_response(payload: dict, pull: dict, repo: str, number: int, head: str, actor: str) -> dict:
    value = assessment(payload.get("assessment"))
    context = context_sha(pull)
    # The governed runner retained the provider's response before entering
    # this command. Standalone submissions cannot acquire native ownership.
    if os.environ.get("AGENT_INTERFACE_RECEIPT_CALL"):
        from agent_interface.review_receipt import retained_response
        response = retained_response()
        if response["assessment"] != value or response["repository"].lower() != repo.lower() \
                or response["pull_number"] != number or response["head_sha"] != head \
                or response["context_sha"] != context or response["reviewer"].lower() != actor.lower():
            raise RuntimeError("retained review response differs from the current PR context")
        return response
    return {"assessment": value, "repository": repo, "pull_number": number, "head_sha": head,
            "context_sha": context, "reviewer": actor, "invocation_id": None, "model": None,
            "completed_at": int(time.time() * 1000)}


def qualifying_response(response: object, pull: dict, repo: str, number: int, head: str, actor: str) -> bool:
    if not isinstance(response, dict):
        return False
    try:
        assessment(response.get("assessment"))
        return (response.get("repository", "").lower() == repo.lower() and response.get("pull_number") == number
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
