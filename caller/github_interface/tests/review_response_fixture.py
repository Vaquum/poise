import time
from datetime import datetime, timezone

from github_interface.atoms.review_response import context_sha, response_body

ASSESSMENT = {"verdict": "The changed validation paths have no remaining blocking defects.",
              "reviewed_context": "Inspected the supplied immutable diff and its affected callers.",
              "limitations": "Provider fixture; no application test execution."}


def response(pull, repo="acme/app", number=7, actor="review-bot"):
    return {"repository": repo, "pull_number": number, "head_sha": pull["head"]["sha"],
            "context_sha": context_sha(pull), "reviewer": actor, "invocation_id": "c" * 32,
            "model": "fixture", "completed_at": int(time.time() * 1000) - 3000,
            "assessment": ASSESSMENT, "review_id": 91}


def published_review(value):
    return {"id": value["review_id"], "state": "APPROVED", "commit_id": value["head_sha"],
            "user": {"login": value["reviewer"]},
            "submitted_at": datetime.fromtimestamp((value["completed_at"] + 1000) / 1000, timezone.utc).isoformat(),
            "body": response_body({key: item for key, item in value.items() if key != "review_id"})
            + f"\n\n<!-- poise-invocation {value['invocation_id']} -->"}
