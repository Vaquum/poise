from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .db import login, stable_key


MENTION_RE = re.compile(r"(?<![A-Za-z0-9_-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)")


@dataclass(frozen=True)
class Association:
    association_type: str
    evidence_kind: str
    evidence_id: str
    evidence_field: str
    evidence_text: str | None = None
    created_at: str | None = None

    def as_row(self) -> dict[str, Any]:
        return {
            "association_type": self.association_type,
            "evidence_kind": self.evidence_kind,
            "evidence_id": self.evidence_id,
            "evidence_field": self.evidence_field,
            "evidence_text": self.evidence_text,
            "created_at": self.created_at,
        }


class AssociationExtractor:
    def __init__(self, username: str) -> None:
        if not username:
            raise ValueError("username is required")
        self.username = username
        self.username_lc = username.lower()
        self.rows: dict[tuple[str, str, str, str], Association] = {}

    def extract(self, expanded: dict[str, Any]) -> list[dict[str, Any]]:
        issue = expanded["issue"]
        self._login_field("author", "issue", issue, "user", "user.login", issue.get("created_at"))
        self._login_field("closed_by", "issue", issue, "closed_by", "closed_by.login", issue.get("closed_at"))
        self._login_list("assignee", "issue", issue, "assignees", "assignees.login", issue.get("updated_at"))
        self._mention_field("mention", "issue", issue, "title", issue.get("updated_at"))
        self._mention_field("mention", "issue", issue, "body", issue.get("updated_at"))

        pull = expanded.get("pull")
        if pull:
            self._login_field("merged_by", "pull", pull, "merged_by", "merged_by.login", pull.get("merged_at"))
            self._login_list(
                "review_requested",
                "pull",
                pull,
                "requested_reviewers",
                "requested_reviewers.login",
                pull.get("updated_at"),
            )
            self._login_list("assignee", "pull", pull, "assignees", "assignees.login", pull.get("updated_at"))

        for comment in expanded["comments"]:
            self._login_field(
                "commenter", "comment", comment, "user", "user.login", comment.get("created_at")
            )
            self._mention_field("mention", "comment", comment, "body", comment.get("created_at"))

        for event in expanded["timeline"]:
            event_name = str(event.get("event") or "unknown")
            self._login_field(
                f"event_actor:{event_name}",
                "event",
                event,
                "actor",
                "actor.login",
                event.get("created_at"),
            )
            self._login_field(
                f"event_assignee:{event_name}",
                "event",
                event,
                "assignee",
                "assignee.login",
                event.get("created_at"),
            )
            self._login_field(
                f"event_assigner:{event_name}",
                "event",
                event,
                "assigner",
                "assigner.login",
                event.get("created_at"),
            )
            self._login_field(
                f"event_requested_reviewer:{event_name}",
                "event",
                event,
                "requested_reviewer",
                "requested_reviewer.login",
                event.get("created_at"),
            )
            self._login_field(
                f"event_review_requester:{event_name}",
                "event",
                event,
                "review_requester",
                "review_requester.login",
                event.get("created_at"),
            )
            self._mention_field("mention", "event", event, "body", event.get("created_at"))

        for review in expanded["reviews"]:
            self._login_field(
                "reviewer", "review", review, "user", "user.login", review.get("submitted_at")
            )
            self._mention_field("mention", "review", review, "body", review.get("submitted_at"))

        for comment in expanded["review_comments"]:
            self._login_field(
                "review_commenter",
                "review_comment",
                comment,
                "user",
                "user.login",
                comment.get("created_at"),
            )
            self._mention_field(
                "mention", "review_comment", comment, "body", comment.get("created_at")
            )

        for commit in expanded["commits"]:
            self._login_field(
                "commit_author", "commit", commit, "author", "author.login", commit.get("commit", {}).get("author", {}).get("date")
            )
            self._login_field(
                "commit_committer",
                "commit",
                commit,
                "committer",
                "committer.login",
                commit.get("commit", {}).get("committer", {}).get("date"),
            )

        return [row.as_row() for row in self.rows.values()]

    def _add(
        self,
        association_type: str,
        evidence_kind: str,
        evidence_id: str,
        evidence_field: str,
        evidence_text: str | None,
        created_at: str | None,
    ) -> None:
        key = (association_type, evidence_kind, evidence_id, evidence_field)
        self.rows[key] = Association(
            association_type,
            evidence_kind,
            evidence_id,
            evidence_field,
            evidence_text,
            created_at,
        )

    def _login_field(
        self,
        association_type: str,
        evidence_kind: str,
        source: dict[str, Any],
        object_field: str,
        evidence_field: str,
        created_at: str | None,
    ) -> None:
        value = source.get(object_field)
        if not isinstance(value, dict):
            return
        candidate = login(value)
        if self._matches(candidate):
            self._add(
                association_type,
                evidence_kind,
                stable_key(evidence_kind, source),
                evidence_field,
                candidate,
                created_at,
            )

    def _login_list(
        self,
        association_type: str,
        evidence_kind: str,
        source: dict[str, Any],
        object_field: str,
        evidence_field: str,
        created_at: str | None,
    ) -> None:
        values = source.get(object_field) or []
        if not isinstance(values, list):
            raise ValueError(f"{evidence_kind}.{object_field} is not a list")
        for index, value in enumerate(values):
            if not isinstance(value, dict):
                raise ValueError(f"{evidence_kind}.{object_field}[{index}] is not an object")
            candidate = login(value)
            if self._matches(candidate):
                self._add(
                    association_type,
                    evidence_kind,
                    stable_key(evidence_kind, source),
                    f"{evidence_field}[{index}]",
                    candidate,
                    created_at,
                )

    def _mention_field(
        self,
        association_type: str,
        evidence_kind: str,
        source: dict[str, Any],
        field: str,
        created_at: str | None,
    ) -> None:
        text = source.get(field)
        if not text:
            return
        if not isinstance(text, str):
            raise ValueError(f"{evidence_kind}.{field} is not text")
        for match in MENTION_RE.finditer(text):
            if self._matches(match.group(1)):
                self._add(
                    association_type,
                    evidence_kind,
                    stable_key(evidence_kind, source),
                    field,
                    match.group(0),
                    created_at,
                )

    def _matches(self, candidate: str | None) -> bool:
        return candidate is not None and candidate.lower() == self.username_lc


def extract_associations(expanded: dict[str, Any], username: str) -> list[dict[str, Any]]:
    return AssociationExtractor(username).extract(expanded)
