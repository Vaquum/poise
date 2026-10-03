from importlib import import_module
from typing import Any

from .client import GitHubClient
from .context import token_user
from .identity import account


class UnknownBehavior(ValueError):
    pass


async def run_behavior(name: str, payload: dict[str, Any]) -> Any:
    if not name.isidentifier() or name.startswith("_"):
        raise UnknownBehavior(name)

    module_name = f"github_interface.behaviors.{name}"
    try:
        module = import_module(module_name)
    except ModuleNotFoundError as error:
        if error.name == module_name:
            raise UnknownBehavior(name) from error
        raise

    if not hasattr(module, "run"):
        raise UnknownBehavior(name)

    if getattr(module, "NO_AUTH", False):
        client = None
    elif getattr(module, "REQUIRE_TOKEN_USER", False):
        # The account is part of what these check — the reviewer's own
        # reviews and threads — so every call names it.
        if not payload.get("token_user"):
            raise ValueError("token-user is required")
        client = GitHubClient(user=token_user(payload))
    else:
        client = GitHubClient(user=account(module.IDENTITY, payload))
    return await module.run(client, payload)


async def pr_review(payload: dict[str, Any]) -> Any:
    return await run_behavior("pr_review", payload)


async def approve_pr(payload: dict[str, Any]) -> Any:
    return await run_behavior("approve_pr", payload)


async def head_sha(payload: dict[str, Any]) -> Any:
    return await run_behavior("head_sha", payload)


async def list_failing_ci(payload: dict[str, Any]) -> Any:
    return await run_behavior("list_failing_ci", payload)


async def read_failing_ci_log(payload: dict[str, Any]) -> Any:
    return await run_behavior("read_failing_ci_log", payload)


async def checkout_pr_head(payload: dict[str, Any]) -> Any:
    return await run_behavior("checkout_pr_head", payload)


async def commit_work(payload: dict[str, Any]) -> Any:
    return await run_behavior("commit_work", payload)


async def list_test_files(payload: dict[str, Any]) -> Any:
    return await run_behavior("list_test_files", payload)


async def read_file(payload: dict[str, Any]) -> Any:
    return await run_behavior("read_file", payload)


async def write_file(payload: dict[str, Any]) -> Any:
    return await run_behavior("write_file", payload)


async def create_issue(payload: dict[str, Any]) -> Any:
    return await run_behavior("create_issue", payload)


async def create_pr_linked_issue(payload: dict[str, Any]) -> Any:
    return await run_behavior("create_pr_linked_issue", payload)


async def request_changes(payload: dict[str, Any]) -> Any:
    return await run_behavior("request_changes", payload)


async def reviewed_clean(payload: dict[str, Any]) -> Any:
    return await run_behavior("reviewed_clean", payload)


async def request_change(payload: dict[str, Any]) -> Any:
    return await run_behavior("request_change", payload)


async def requested_changes_addressed(payload: dict[str, Any]) -> Any:
    return await run_behavior("requested_changes_addressed", payload)


async def requested_review_ready(payload: dict[str, Any]) -> Any:
    return await run_behavior("requested_review_ready", payload)


async def review_activity_since(payload: dict[str, Any]) -> Any:
    return await run_behavior("review_activity_since", payload)


async def resolve_conversation(payload: dict[str, Any]) -> Any:
    return await run_behavior("resolve_conversation", payload)


async def resolve_pr_conversations(payload: dict[str, Any]) -> Any:
    return await run_behavior("resolve_pr_conversations", payload)


async def resolve_nonblocking_conversations_if_ready(payload: dict[str, Any]) -> Any:
    return await run_behavior("resolve_nonblocking_conversations_if_ready", payload)


async def mergeable(payload: dict[str, Any]) -> Any:
    return await run_behavior("mergeable", payload)


async def current_pr(payload: dict[str, Any]) -> Any:
    return await run_behavior("current_pr", payload)


async def pr_readiness(payload: dict[str, Any]) -> Any:
    return await run_behavior("pr_readiness", payload)


async def post_pr_comment(payload: dict[str, Any]) -> Any:
    return await run_behavior("post_pr_comment", payload)


async def local_checkout_path(payload: dict[str, Any]) -> Any:
    return await run_behavior("local_checkout_path", payload)


async def view_repos(payload: dict[str, Any]) -> Any:
    return await run_behavior("view_repos", payload)


async def read_issue(payload: dict[str, Any]) -> Any:
    return await run_behavior("read_issue", payload)


async def assign_issue(payload: dict[str, Any]) -> Any:
    return await run_behavior("assign_issue", payload)


async def comment_issue(payload: dict[str, Any]) -> Any:
    return await run_behavior("comment_issue", payload)


async def edit_issue_comment(payload: dict[str, Any]) -> Any:
    return await run_behavior("edit_issue_comment", payload)


async def sub_issues(payload: dict[str, Any]) -> Any:
    return await run_behavior("sub_issues", payload)


async def issue_comments(payload: dict[str, Any]) -> Any:
    return await run_behavior("issue_comments", payload)


async def checkout_repo(payload: dict[str, Any]) -> Any:
    return await run_behavior("checkout_repo", payload)
