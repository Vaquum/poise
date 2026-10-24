"""Keep the PR author and manual review activity outside automated approval."""
import json
import os


def require_other_author(pull: dict, actor: str) -> None:
    author = str((pull.get("user") or {}).get("login") or "")
    if not author:
        raise RuntimeError("GitHub returned no PR author")
    if author.lower() == actor.lower():
        raise RuntimeError("Cannot review your own pull request")


def require_owned_reviews(reviews: list[dict], actor: str) -> None:
    raw = os.getenv("GITHUB_INTERFACE_AUTOMATED_REVIEWS")
    if raw is None:
        return
    owned = json.loads(raw)
    if not isinstance(owned, list) or any(type(value) is not int or value <= 0 for value in owned):
        raise RuntimeError("Invalid automated review receipts")
    for review in reviews:
        if str((review.get("user") or {}).get("login") or "").lower() == actor.lower():
            if review.get("id") not in owned:
                raise RuntimeError(f"Manual or unclaimed review by {actor}; automatic approval and resolution are held")
