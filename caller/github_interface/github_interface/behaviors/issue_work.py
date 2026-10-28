"""Fresh checkout, publication and reconciliation for an atomic behavior.

The branch is the durable artifact identity. Lost responses are inspected,
never retried by creating a second branch or pull request.
"""
import asyncio
import base64
import json
import re
from pathlib import Path

from github_interface.atoms.local import _run, checkout_repo
from github_interface.atoms.pulls import get_pull
from github_interface.atoms.review_identity import work_publication
from github_interface.client import GitHubClient
from github_interface.context import repository, token_user

REQUIRE_TOKEN_USER = True
BRANCH = re.compile(r"poise/[A-Za-z0-9][A-Za-z0-9._/-]{0,150}")
SHA = re.compile(r"[0-9a-f]{40}", re.IGNORECASE)
COMMIT = re.compile(r"(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([^\n)]+\))?!?: .+")


def publication_body(body: str, target: str, number: int) -> None:
    for match in re.finditer(r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:(https://github\.com/[^\s]+/issues/\d+)|([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)?#(\d+))", body, re.IGNORECASE):
        reference = match.group(1) or f"{match.group(2) or target}#{match.group(3)}"
        if reference.lower() not in {f"{target.lower()}#{number}", f"https://github.com/{target.lower()}/issues/{number}"}:
            raise ValueError("behavior chain publication may close only its seed issue")


def publication_metadata(payload: dict, target: str, number: int, *, creating: bool) -> tuple[str, str, str]:
    message, title, body = (str(payload.get(key) or "") for key in ("message", "title", "body"))
    if not COMMIT.fullmatch(message) or any(char in message for char in "\r\n") \
            or (creating and (not COMMIT.fullmatch(title) or any(char in title for char in "\r\n") or not body.strip())):
        raise ValueError("publication requires Conventional Commit metadata and a nonempty PR body")
    publication_body(body, target, number)
    return message, title, body


async def confirmed_pull(client: GitHubClient, owner: str, repo: str, pull: dict, head: str) -> dict:
    # GitHub's PR projection can trail the just-pushed branch. This bounded
    # publication confirmation is not another background reader.
    for delay in (0, .2, .4, .8, 1.6):
        if (pull.get("head") or {}).get("sha") == head:
            return pull
        await asyncio.sleep(delay)
        pull = await get_pull(client, owner, repo, int(pull["number"]))
    if (pull.get("head") or {}).get("sha") != head:
        raise RuntimeError("published branch and pull-request heads disagree; reconcile before retry")
    return pull


async def review_replies(client: GitHubClient, target: str, pull: int, actor: str, call_id: str, replies: list, *, publish: bool, head: str = "") -> list:
    if not replies:
        return []
    if len(replies) > 100 or not re.fullmatch(r"[0-9a-f]{32}", call_id):
        raise ValueError("review replies require a bounded original native publication plan")
    comments = await client.paginate(f"/repos/{target}/pulls/{pull}/comments")
    by_id = {comment["id"]: comment for comment in comments}
    receipts, used, reserved = [], set(), False
    for reply in replies:
        if not isinstance(reply, dict) or type(reply.get("commentId")) is not int or not isinstance(reply.get("body"), str) or not reply["body"].strip():
            raise ValueError("review reply requires an actual comment id and a model-written answer")
        parent = reply["commentId"]
        if parent not in by_id or parent in used or by_id[parent].get("in_reply_to_id"):
            raise ValueError("review reply target is not a unique original finding on this pull request")
        used.add(parent)
        body = f"{reply['body'].strip()}\n\n<!-- poise-reply {call_id} {parent} -->"
        matching = [comment for comment in comments if comment.get("in_reply_to_id") == parent and comment.get("body") == body
                    and (comment.get("user") or {}).get("login", "").lower() == actor.lower()]
        if len(matching) > 1:
            raise ValueError("review reply has duplicate native publication receipts")
        if matching:
            posted = matching[0]
        elif publish:
            if not reserved:
                work_publication(head, start_replies=True)
                reserved = True
            posted = await client.post(f"/repos/{target}/pulls/{pull}/comments/{parent}/replies", json={"body": body})
        else:
            continue
        receipts.append({"comment_id": posted["id"], "in_reply_to_id": parent, "url": posted.get("html_url")})
    return receipts


async def run(client: GitHubClient, payload: dict) -> dict:
    owner, repo = repository(payload)
    number = str(payload.get("issue", "")).lstrip("#")
    branch = str(payload.get("branch") or "")
    mode = str(payload.get("mode") or "")
    actor = token_user(payload)
    if not number.isdigit() or int(number) < 1 or not BRANCH.fullmatch(branch) or ".." in branch or "//" in branch:
        raise ValueError("issue-work requires a positive issue and a poise/ branch")
    issue_number = int(number)
    target = f"{owner}/{repo}"
    marker = f"<!-- poise-chain {target.lower()}#{issue_number} -->"
    metadata = await client.get(f"/repos/{target}")
    if str(metadata.get("full_name") or "").lower() != target.lower():
        raise ValueError("repository moved or redirected outside the recorded behavior chain target")
    default_branch = metadata["default_branch"]
    if branch == default_branch:
        raise ValueError("issue-work cannot write the default branch")
    pulls = await client.paginate(f"/repos/{target}/pulls", {"state": "all", "head": f"{owner}:{branch}"})
    matching = [pull for pull in pulls if (pull.get("head") or {}).get("ref") == branch]
    if len(matching) > 1:
        raise ValueError("multiple pull requests claim the behavior chain branch")
    pull = matching[0] if matching else None
    pull_number = payload.get("pull_number")
    if pull_number is not None:
        if not isinstance(pull_number, int) or pull_number < 1:
            raise ValueError("pull-number must be a positive integer")
        pull = await get_pull(client, owner, repo, pull_number)
        if (pull.get("head") or {}).get("ref") != branch:
            raise ValueError("pull request does not own the behavior chain branch")
    if pull is not None:
        if (pull.get("user") or {}).get("login", "").lower() != actor.lower() or marker not in (pull.get("body") or ""):
            raise ValueError("pull request lacks this behavior chain's author/publication receipt")
        if ((pull.get("head") or {}).get("repo") or {}).get("full_name", "").lower() != target.lower():
            raise ValueError("behavior chain cannot publish to another repository")
    cursor = None
    references = []
    while True:
        graph = await client.graphql("""query($owner:String!,$repo:String!,$ref:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){
          ref(qualifiedName:$ref){target{oid ... on Commit{message}}} defaultBranchRef{name target{oid}}
          issue(number:$number){closedByPullRequestsReferences(first:100,after:$cursor){pageInfo{hasNextPage endCursor}
            nodes{number url repository{nameWithOwner} headRefName}
          }}
        }}""", {"owner": owner, "repo": repo, "ref": f"refs/heads/{branch}", "number": issue_number, "cursor": cursor})
        source = graph["repository"]
        if source.get("issue") is None:
            raise ValueError("behavior chain seed does not identify an issue")
        connection = source["issue"]["closedByPullRequestsReferences"]
        references.extend(connection["nodes"])
        if not connection["pageInfo"]["hasNextPage"]:
            break
        following = connection["pageInfo"]["endCursor"]
        if not following or following == cursor:
            raise ValueError("issue-to-PR ownership pagination did not advance")
        cursor = following
    remote_head = ((source.get("ref") or {}).get("target") or {}).get("oid")
    head_message = ((source.get("ref") or {}).get("target") or {}).get("message") or ""
    invocation = re.search(r"^Poise-Invocation: ([0-9a-f]{32})$", head_message, re.MULTILINE)
    base_head = source["defaultBranchRef"]["target"]["oid"]
    result = {"action": "issue_work", "repository": target, "issue_number": issue_number,
              "actor": actor, "branch": branch, "head_sha": remote_head, "base_sha": base_head,
              "pull_number": pull.get("number") if pull else None, "url": pull.get("html_url") if pull else None,
              "state": pull.get("state") if pull else None, "merged": bool(pull and pull.get("merged_at")),
              "merge_sha": pull.get("merge_commit_sha") if pull else None}
    result["head_invocation"] = invocation.group(1) if invocation else None
    result["existing_pulls"] = [reference["url"] for reference in references
                                if reference["repository"]["nameWithOwner"].lower() != target.lower()
                                or reference["headRefName"] != branch]
    replies = json.loads(payload.get("replies_json") or "[]")
    if not isinstance(replies, list):
        raise ValueError("review replies must be an array")
    if mode == "inspect":
        if replies and pull is not None:
            result["reply_receipts"] = await review_replies(client, target, int(pull["number"]), actor, str(payload.get("invocation_id") or ""), replies, publish=False)
            result["replies_complete"] = len(result["reply_receipts"]) == len(replies)
        return result
    if result["existing_pulls"]:
        raise ValueError("seed issue already has another open pull request; its existing owner must continue")
    issue = await client.get(f"/repos/{target}/issues/{issue_number}")
    if issue.get("state") != "open" or "pull_request" in issue:
        raise ValueError("behavior chain seed is no longer an open issue")
    expected = str(payload.get("expected_head") or "")
    if expected and (not SHA.fullmatch(expected) or expected.lower() != str(remote_head).lower()):
        return {**result, "outcome": "superseded"}
    if pull is not None and (pull.get("state") != "open" or pull.get("merged_at")):
        raise ValueError("behavior chain pull request is no longer open")
    if mode == "complete":
        call_id = str(payload.get("invocation_id") or "")
        title, body = str(payload.get("title") or ""), str(payload.get("body") or "")
        if not expected or not invocation or invocation.group(1) != call_id:
            raise ValueError("publication recovery requires the original invocation and exact pushed head")
        publication_body(body, target, issue_number)
        if pull is not None:
            pull = await confirmed_pull(client, owner, repo, pull, expected)
            posted = await review_replies(client, target, int(pull["number"]), actor, call_id, replies, publish=True, head=expected)
            return {**result, "outcome": "published", "reply_receipts": posted}
        if not COMMIT.fullmatch(title) or any(char in title for char in "\r\n") or not body.strip():
            raise ValueError("PR creation recovery requires its original Conventional Commit title and body")
        pull = await client.post(f"/repos/{target}/pulls", json={"title": title, "body": f"{body}\n\nCloses #{issue_number}\n\n{marker}",
                                                                 "head": branch, "base": default_branch, "draft": False})
        return {**result, "outcome": "published", "pull_number": pull["number"], "url": pull["html_url"]}
    path = Path(str(payload.get("path") or ""))
    if not path.is_absolute():
        raise ValueError("issue-work path must be absolute")
    if mode == "prepare":
        checkout_repo(owner, repo, branch if remote_head else default_branch, client.token, path)
        if remote_head is None:
            _run(["git", "-C", str(path), "checkout", "-b", branch], client.token)
        _run(["git", "-C", str(path), "config", "user.name", actor], client.token)
        _run(["git", "-C", str(path), "config", "user.email", f"{actor}@users.noreply.github.com"], client.token)
        conflicts = []
        if payload.get("merge_base"):
            if pull is None:
                raise ValueError("base integration is only available for an existing chain pull request")
            try:
                _run(["git", "-C", str(path), "merge", "--no-commit", "--no-ff", base_head], client.token)
            except RuntimeError:
                conflicts = _run(["git", "-C", str(path), "diff", "--name-only", "--diff-filter=U"], client.token).splitlines()
                if not conflicts:
                    raise
        return {**result, "outcome": "prepared", "path": str(path),
                "base_merge_conflicts": conflicts,
                "checkout_head": _run(["git", "-C", str(path), "rev-parse", "HEAD"], client.token)}
    if mode not in {"publish", "validate"}:
        raise ValueError("issue-work mode must be prepare, validate, publish, complete or inspect")
    if _run(["git", "-C", str(path), "branch", "--show-current"], client.token) != branch \
            or _run(["git", "-C", str(path), "remote", "get-url", "origin"], client.token) != f"https://github.com/{target}.git":
        raise ValueError("publication checkout does not match the behavior chain")
    message, title, body = publication_metadata(payload, target, issue_number, creating=pull is None)
    starting_head = str(payload.get("starting_head") or "")
    if not SHA.fullmatch(starting_head) or (remote_head is not None and starting_head.lower() != str(remote_head).lower()):
        return {**result, "outcome": "superseded"}
    current_head = _run(["git", "-C", str(path), "rev-parse", "HEAD"], client.token)
    if current_head.lower() != starting_head.lower():
        raise ValueError("worker changed HEAD outside the publication primitive")
    dirty = _run(["git", "-C", str(path), "status", "--porcelain"], client.token)
    call_id = str(payload.get("invocation_id") or "")
    if not re.fullmatch(r"[0-9a-f]{32}", call_id):
        raise ValueError("publication requires the native invocation id")
    if mode == "validate":
        if replies and pull is not None:
            await review_replies(client, target, int(pull["number"]), actor, call_id, replies, publish=False)
        return {**result, "outcome": "validated"}
    if not dirty:
        if replies and pull is not None:
            work_publication(current_head)
            posted = await review_replies(client, target, int(pull["number"]), actor, call_id, replies, publish=True, head=current_head)
            return {**result, "outcome": "no_changes", "reply_receipts": posted}
        return {**result, "outcome": "no_changes"}
    _run(["git", "-C", str(path), "add", "-A"], client.token)
    _run(["git", "-C", str(path), "commit", "-m", f"{message}\n\nPoise-Invocation: {call_id}"], client.token)
    head = _run(["git", "-C", str(path), "rev-parse", "HEAD"], client.token)
    work_publication(head)
    basic = base64.b64encode(f"x-access-token:{client.token}".encode()).decode()
    _run(["git", "-C", str(path), "-c", f"http.extraHeader=Authorization: Basic {basic}",
          "push", "origin", f"HEAD:refs/heads/{branch}"], client.token, basic)
    if pull is None:
        pull = await client.post(f"/repos/{target}/pulls", json={"title": title, "body": f"{body}\n\nCloses #{issue_number}\n\n{marker}",
                                                                 "head": branch, "base": default_branch, "draft": False})
    pull = await confirmed_pull(client, owner, repo, pull, head)
    posted = await review_replies(client, target, int(pull["number"]), actor, call_id, replies, publish=True, head=head)
    return {**result, "outcome": "published", "head_sha": head, "head_invocation": call_id, "pull_number": pull["number"], "url": pull["html_url"], "reply_receipts": posted}
