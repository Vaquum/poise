import argparse
import asyncio
import json
import sys
from importlib import import_module
from pathlib import Path
from typing import Any

from .interface import checkout_review, review_context, approve_pr, assign_issue, checkout_pr_head, checkout_repo, comment_issue, commit_work, create_issue, create_pr_linked_issue, current_pr, edit_issue_comment, head_sha, issue_comments, list_failing_ci, list_test_files, local_checkout_path, mergeable, post_pr_comment, pr_readiness, pr_review, read_failing_ci_log, read_file, read_issue, request_change, request_changes, requested_changes_addressed, requested_review_ready, reviewed_clean, review_activity_since, resolve_conversation, resolve_nonblocking_conversations_if_ready, resolve_pr_conversations, sub_issues, view_repos, write_file

TOP_HELP = """usage: github-interface BEHAVIOR ...

behaviors:
  --pr-review PR [--p p2] --expected-head SHA --token-user USER
  --approve-pr PR --expected-head SHA --token-user USER
  --head-sha PR --token-user USER
  --list-failing-ci PR
  --read-failing-ci-log LOG_ID
  --checkout-pr-head PR
  --commit-work PR --message MESSAGE
  --list-test-files
  --read-file PATH
  --write-file PATH --content CONTENT
  --request-change PR --file FILE --line LINE --body BODY --expected-head SHA --token-user USER
  --request-changes PR (--comments FILE | --comments-json JSON) --expected-head SHA --token-user USER
  --reviewed-clean PR --expected-head SHA --token-user USER
  --requested-changes-addressed PR --username USER --token-user USER
  --requested-review-ready PR --username USER --token-user USER
  --review-activity-since PR --username USER --since TIMESTAMP --token-user USER
  --resolve-conversation CONVERSATION_ID
  --resolve-pr-conversations PR
  --resolve-nonblocking-conversations-if-ready PR --username USER --expected-head SHA --token-user USER
  --create-issue --title TITLE --body BODY
  --create-pr-linked-issue PR --title TITLE --body BODY --token-user USER
  --post-pr-comment PR --body BODY
  --mergeable PR
  --current-pr [--token-user USER]
  --pr-readiness PR --username USER --expected-head SHA [--token-user USER]
  --local-checkout-path ORG REPO
  --view-repos ORG
  --read-issue ISSUE [--repository OWNER/REPO]
  --issue-comments ISSUE [--repository OWNER/REPO]
  --sub-issues ISSUE [--repository OWNER/REPO]
  --assign-issue ISSUE --user USER [--user USER ...]
  --comment-issue ISSUE --body BODY [--repository OWNER/REPO]
  --edit-issue-comment ISSUE --body BODY [--comment-id ID]
  --checkout-repo OWNER/REPO --path DIR
  --checkout-review PR --path DIR --base-sha SHA --merge-base-sha SHA --expected-head SHA --token-user USER [--repository OWNER/REPO]
  --review-context --requests-json JSON

accounts:
  Every behavior takes --token-user USER, the GitHub account it acts as.
  Without it, agent behaviors act as GITHUB_INTERFACE_AGENT_USER and reads
  done as you (--view-repos, --current-pr, --pr-readiness) as
  GITHUB_INTERFACE_USER. gh's active account is never used.

help:
  github-interface BEHAVIOR --help"""


def main() -> None:
    argv = sys.argv[1:]
    if argv in (["-h"], ["--help"]):
        print(TOP_HELP)
        return
    if not argv or argv[0] not in {"--pr-review", "--approve-pr", "--head-sha", "--list-failing-ci", "--read-failing-ci-log", "--checkout-pr-head", "--commit-work", "--list-test-files", "--read-file", "--write-file", "--request-change", "--request-changes", "--reviewed-clean", "--requested-changes-addressed", "--requested-review-ready", "--review-activity-since", "--resolve-conversation", "--resolve-pr-conversations", "--resolve-nonblocking-conversations-if-ready", "--create-issue", "--create-pr-linked-issue", "--post-pr-comment", "--mergeable", "--current-pr", "--pr-readiness", "--local-checkout-path", "--view-repos", "--read-issue", "--assign-issue", "--comment-issue", "--edit-issue-comment", "--issue-comments", "--sub-issues", "--checkout-repo", "--checkout-review", "--review-context"}:
        print("error: first argument must be a behavior switch\n", file=sys.stderr)
        print(TOP_HELP, file=sys.stderr)
        raise SystemExit(2)
    if len(argv) > 1 and argv[1] in ("-h", "--help"):
        _parser(argv[0]).print_help()
        return
    if argv[0] not in {"--create-issue", "--current-pr", "--local-checkout-path", "--view-repos", "--list-test-files", "--review-context"} and len(argv) < 2:
        _parser(argv[0]).print_help()
        return

    if argv[0] in {"--create-issue", "--current-pr", "--local-checkout-path", "--view-repos", "--list-test-files", "--review-context"}:
        args = _parser(argv[0]).parse_args(argv[1:])
        payload: dict[str, Any] = vars(args)
    else:
        args = _parser(argv[0]).parse_args(argv[2:])
        key = "path" if argv[0] in {"--read-file", "--write-file"} else "issue" if argv[0] in {"--read-issue", "--assign-issue", "--comment-issue", "--edit-issue-comment", "--issue-comments", "--sub-issues"} else "repository" if argv[0] == "--checkout-repo" else "log_id" if argv[0] == "--read-failing-ci-log" else "conversation" if argv[0] == "--resolve-conversation" else "pr"
        payload = {key: argv[1], **vars(args)}

    if payload.get("comments_json"):
        try:
            payload["comments"] = json.loads(payload.pop("comments_json"))
        except json.JSONDecodeError as error:
            raise SystemExit(f"error: comments-json is invalid JSON: {error}") from error
    elif payload.get("comments"):
        payload["comments"] = _read_json(payload["comments"])

    behavior = {
        "--pr-review": pr_review,
        "--approve-pr": approve_pr,
        "--head-sha": head_sha,
        "--list-failing-ci": list_failing_ci,
        "--read-failing-ci-log": read_failing_ci_log,
        "--checkout-pr-head": checkout_pr_head,
        "--commit-work": commit_work,
        "--list-test-files": list_test_files,
        "--read-file": read_file,
        "--write-file": write_file,
        "--request-change": request_change,
        "--request-changes": request_changes,
        "--reviewed-clean": reviewed_clean,
        "--requested-changes-addressed": requested_changes_addressed,
        "--requested-review-ready": requested_review_ready,
        "--review-activity-since": review_activity_since,
        "--resolve-conversation": resolve_conversation,
        "--resolve-pr-conversations": resolve_pr_conversations,
        "--resolve-nonblocking-conversations-if-ready": resolve_nonblocking_conversations_if_ready,
        "--create-issue": create_issue,
        "--create-pr-linked-issue": create_pr_linked_issue,
        "--post-pr-comment": post_pr_comment,
        "--mergeable": mergeable,
        "--current-pr": current_pr,
        "--pr-readiness": pr_readiness,
        "--local-checkout-path": local_checkout_path,
        "--view-repos": view_repos,
        "--read-issue": read_issue,
        "--assign-issue": assign_issue,
        "--comment-issue": comment_issue,
        "--edit-issue-comment": edit_issue_comment,
        "--issue-comments": issue_comments,
        "--sub-issues": sub_issues,
        "--checkout-repo": checkout_repo,
        "--checkout-review": checkout_review,
        "--review-context": review_context,
    }[argv[0]]
    try:
        result = asyncio.run(behavior(payload))
    except (RuntimeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
    print(json.dumps(result, separators=(",", ":")) if argv[0] == "--pr-review" else json.dumps(result, indent=2))


def _parser(behavior: str) -> argparse.ArgumentParser:
    parser = _arguments(behavior)
    module = import_module(f"github_interface.behaviors.{behavior.removeprefix('--').replace('-', '_')}")
    required = getattr(module, "REQUIRE_TOKEN_USER", False)
    if required:
        account = "GitHub account to act as"
    elif getattr(module, "NO_AUTH", False):
        account = "not used: this behavior does not call GitHub"
    else:
        account = f"GitHub account to act as (default: ${module.IDENTITY})"
    parser.add_argument("--token-user", required=required, metavar="USER", help=account)
    return parser


def _arguments(behavior: str) -> argparse.ArgumentParser:
    if behavior == "--pr-review":
        parser = argparse.ArgumentParser(prog="github-interface --pr-review PR")
        parser.add_argument("--p", default="p2", metavar="p2")
        _add_expected_head(parser)
        return parser

    if behavior in {"--create-issue", "--create-pr-linked-issue"}:
        prog = "github-interface --create-issue" if behavior == "--create-issue" else "github-interface --create-pr-linked-issue PR"
        parser = argparse.ArgumentParser(prog=prog)
        parser.add_argument("--title", required=True)
        parser.add_argument("--body", required=True)
        return parser

    if behavior == "--request-changes":
        parser = argparse.ArgumentParser(prog="github-interface --request-changes PR")
        source = parser.add_mutually_exclusive_group(required=True)
        source.add_argument("--comments", help="file containing a JSON array of inline review comments")
        source.add_argument("--comments-json", help="inline JSON array of review comments")
        _add_expected_head(parser)
        return parser

    if behavior == "--request-change":
        parser = argparse.ArgumentParser(prog="github-interface --request-change PR")
        parser.add_argument("--file", required=True)
        parser.add_argument("--line", required=True, type=int)
        parser.add_argument("--side", choices=("LEFT", "RIGHT"), default="RIGHT")
        parser.add_argument("--body", required=True)
        _add_expected_head(parser)
        return parser

    if behavior == "--commit-work":
        parser = argparse.ArgumentParser(prog="github-interface --commit-work PR")
        parser.add_argument("--message", required=True)
        return parser

    if behavior == "--list-test-files":
        return argparse.ArgumentParser(prog="github-interface --list-test-files")

    if behavior == "--read-file":
        return argparse.ArgumentParser(prog="github-interface --read-file PATH")

    if behavior == "--write-file":
        parser = argparse.ArgumentParser(prog="github-interface --write-file PATH")
        parser.add_argument("--content", required=True)
        return parser

    if behavior in {"--requested-changes-addressed", "--requested-review-ready", "--review-activity-since"}:
        parser = argparse.ArgumentParser(prog=f"github-interface {behavior} PR")
        parser.add_argument("--username", required=True)
        if behavior == "--review-activity-since":
            parser.add_argument("--since", required=True)
        return parser

    if behavior in {"--approve-pr", "--reviewed-clean"}:
        parser = argparse.ArgumentParser(prog=f"github-interface {behavior} PR")
        _add_expected_head(parser)
        return parser

    if behavior == "--head-sha":
        parser = argparse.ArgumentParser(prog="github-interface --head-sha PR")
        return parser

    if behavior == "--current-pr":
        return argparse.ArgumentParser(prog="github-interface --current-pr")

    if behavior == "--pr-readiness":
        parser = argparse.ArgumentParser(prog="github-interface --pr-readiness PR")
        parser.add_argument("--username", required=True)
        _add_expected_head(parser)
        return parser

    if behavior == "--resolve-nonblocking-conversations-if-ready":
        parser = argparse.ArgumentParser(
            prog="github-interface --resolve-nonblocking-conversations-if-ready PR"
        )
        parser.add_argument("--username", required=True)
        _add_expected_head(parser)
        return parser

    if behavior == "--resolve-conversation":
        return argparse.ArgumentParser(prog="github-interface --resolve-conversation CONVERSATION_ID")

    if behavior == "--read-failing-ci-log":
        return argparse.ArgumentParser(prog="github-interface --read-failing-ci-log LOG_ID")

    if behavior == "--post-pr-comment":
        parser = argparse.ArgumentParser(prog="github-interface --post-pr-comment PR")
        parser.add_argument("--body", required=True)
        return parser

    if behavior == "--local-checkout-path":
        parser = argparse.ArgumentParser(prog="github-interface --local-checkout-path ORG REPO")
        parser.add_argument("org")
        parser.add_argument("repo")
        return parser

    if behavior == "--view-repos":
        parser = argparse.ArgumentParser(prog="github-interface --view-repos ORG")
        parser.add_argument("org")
        return parser

    if behavior in {"--read-issue", "--assign-issue", "--issue-comments", "--sub-issues"}:
        parser = argparse.ArgumentParser(prog=f"github-interface {behavior} ISSUE")
        if behavior == "--assign-issue":
            parser.add_argument("--user", dest="users", action="append", required=True)
        else:
            _add_repository(parser)
        return parser

    if behavior in {"--comment-issue", "--edit-issue-comment"}:
        parser = argparse.ArgumentParser(prog=f"github-interface {behavior} ISSUE")
        parser.add_argument("--body", required=True)
        if behavior == "--edit-issue-comment":
            parser.add_argument("--comment-id")
        else:
            _add_repository(parser)
        return parser

    if behavior == "--review-context":
        parser = argparse.ArgumentParser(prog="github-interface --review-context")
        parser.add_argument("--requests-json", required=True)
        return parser

    if behavior == "--checkout-review":
        parser = argparse.ArgumentParser(prog="github-interface --checkout-review PR")
        parser.add_argument("--path", required=True)
        parser.add_argument("--base-sha", required=True)
        parser.add_argument("--merge-base-sha", required=True)
        _add_expected_head(parser)
        _add_token_user(parser)
        _add_repository(parser)
        return parser

    if behavior == "--checkout-repo":
        parser = argparse.ArgumentParser(prog="github-interface --checkout-repo OWNER/REPO")
        parser.add_argument("--path", required=True)
        return parser

    name = behavior.removeprefix("--").replace("_", "-")
    parser = argparse.ArgumentParser(prog=f"github-interface --{name} PR")
    return parser


def _read_json(path: str) -> Any:
    with Path(path).expanduser().open() as file:
        return json.load(file)


def _add_expected_head(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--expected-head", required=True, metavar="SHA")


def _add_repository(parser: argparse.ArgumentParser) -> None:
    # Without it the repository comes from the working directory.
    parser.add_argument("--repository", metavar="OWNER/REPO")
