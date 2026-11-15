"""Fresh checkout, publication and reconciliation for an atomic behavior.

The branch is the durable artifact identity. Lost responses are inspected,
never retried by creating a second branch or pull request.
"""
import asyncio
import base64
import json
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path

import httpx

from github_interface.atoms.local import _run, checkout_repo
from github_interface.atoms.process_diagnostic import GitProcessError, STDERR_BYTES, redact
from github_interface.atoms.pulls import get_pull
from github_interface.atoms.review_diff import _env, _git
from github_interface.atoms.review_identity import work_publication
from github_interface.behaviors import read_issue
from github_interface.client import GitHubClient
from github_interface.context import repository, token_user

REQUIRE_TOKEN_USER = True
BRANCH = re.compile(r"poise/[A-Za-z0-9][A-Za-z0-9._/-]{0,150}")
SHA = re.compile(r"[0-9a-f]{40}", re.IGNORECASE)
COMMIT = re.compile(r"(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([^\n)]+\))?!?: .+")


def pre_pr_remediation(issue: dict, target: str) -> bool:
    body = issue.get("body") or ""
    source = re.search(rf"^Source: {re.escape(target)}#([1-9][0-9]*);", body, re.MULTILINE | re.IGNORECASE)
    return bool(re.search(r"^<!-- poise-repair-exhaustion:[a-f0-9]{64} -->$", body, re.MULTILINE)
                and "Stage: implement-issue. Cause: atomic_work_blocked." in body
                and source and int(source[1]) != issue.get("number"))


async def remediation_coverage(client: GitHubClient, target: str, issue: dict, pull: dict, base: str) -> dict:
    evidence = {"kind": "empty_integration", "verified": False,
                "duplicate": {"number": pull["number"], "head": pull["head"]["sha"]}, "base": base, "covering": []}
    if not pre_pr_remediation(issue, target) or pull.get("merged") or pull.get("merged_at") \
            or (issue.get("user") or {}).get("login", "").lower() != pull["user"]["login"].lower():
        return {**evidence, "reason": "not an unmerged Poise pre-PR failure remediation"}
    metadata = await client.get(f"/repos/{target}")
    if pull["base"]["ref"] != metadata["default_branch"] or pull["base"]["sha"] != base:
        return {**evidence, "reason": "candidate integration base changed"}
    head = pull["head"]["sha"]
    env = _env(client.token)
    with tempfile.TemporaryDirectory(prefix="caller-remediation-") as directory:
        async def git(*args):
            return (await asyncio.to_thread(_git, directory, env, *args, timeout=20)).decode().strip()

        async def integration(commit):
            try:
                return await git("merge-tree", "--write-tree", commit, head)
            except GitProcessError as error:
                if error.diagnostic["outcome"] == "exit" and error.diagnostic["exit_code"] == 1:
                    return None  # A conflicting integration cannot prove coverage.
                raise

        await git("init", "--bare", "--quiet", "--template=")
        await git("remote", "add", "origin", f"https://github.com/{target}.git")
        await git("config", "remote.origin.promisor", "true")
        await git("config", "remote.origin.partialclonefilter", "blob:none")
        await git("fetch", "--quiet", "--no-tags", "--filter=blob:none", "origin", head, base)
        tree = await git("rev-parse", f"{base}^{{tree}}")
        merged_tree = await integration(base)
        if merged_tree != tree:
            return {**evidence, "reason": "candidate has independent changes or integration conflicts"}
        evidence["integration"] = {"tree": merged_tree, "baseTree": tree, "mergeBase": await git("merge-base", base, head)}
        # Find the change that first made the whole candidate redundant, rather
        # than attributing coverage to a later unrelated merge with the same result.
        commits = await git("rev-list", "--first-parent", "--max-count=100", base)
        for commit in commits.splitlines():
            parents = (await git("show", "-s", "--format=%P", commit)).split()
            if not parents:
                break
            parent_tree = await git("rev-parse", f"{parents[0]}^{{tree}}")
            if await integration(parents[0]) == parent_tree:
                continue
            linked = await client.get(f"/repos/{target}/commits/{commit}/pulls")
            for candidate in linked:
                if candidate["number"] == pull["number"] or not candidate.get("merged_at") or candidate.get("merge_commit_sha") != commit:
                    continue
                covering = await get_pull(client, *target.split("/"), candidate["number"])
                if covering.get("merged") is not True or covering.get("merge_commit_sha") != commit \
                        or covering["base"]["ref"] != metadata["default_branch"] \
                        or covering["base"]["repo"]["full_name"].lower() != target.lower():
                    continue
                return {**evidence, "verified": True, "covering": [{"number": candidate["number"], "mergeSha": commit,
                        "url": covering["html_url"], "parent": parents[0], "tree": await git("rev-parse", f"{commit}^{{tree}}")}]}
            break
    return {**evidence, "reason": "no distinct covering merge verified in the bounded base history"}


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
    if creating:
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
        body = reply["body"]
        marker = re.search(r"\n\n<!-- poise-reply ([0-9a-f]{32}) ([1-9][0-9]*) -->\Z", body)
        if marker and (int(marker.group(2)) != parent or not body[:marker.start()].strip()):
            raise ValueError("reused review reply requires its original native marker and substantive answer")
        if not marker:
            body = f"{body.strip()}\n\n<!-- poise-reply {call_id} {parent} -->"
        matching = [comment for comment in comments if comment.get("in_reply_to_id") == parent and comment.get("body") == body
                    and (comment.get("user") or {}).get("login", "").lower() == actor.lower()]
        if len(matching) > 1:
            raise ValueError("review reply has duplicate native publication receipts")
        if matching:
            posted = matching[0]
            if marker and marker.group(1) != call_id:
                reviewer_input = [comment for comment in comments if (comment["id"] == parent or comment.get("in_reply_to_id") == parent)
                                  and (comment.get("user") or {}).get("login", "").lower() != actor.lower()]
                try:
                    answered_at = datetime.fromisoformat(posted["created_at"])
                    revisions = [datetime.fromisoformat(comment["updated_at"]) for comment in reviewer_input]
                    if answered_at.tzinfo is None or any(revision.tzinfo is None for revision in revisions):
                        raise ValueError("missing timezone")
                except (KeyError, TypeError, ValueError) as error:
                    raise ValueError("reused review reply lacks verified reviewer input timestamps") from error
                # GitHub timestamps truncate to the second: an edit within the reply's
                # creation second compares equal, so equality means changed input.
                if any(revision >= answered_at for revision in revisions) or any(comment["id"] > posted["id"] for comment in reviewer_input):
                    raise ValueError("reused review reply predates changed reviewer input; provide a fresh answer")
        elif marker:
            raise ValueError("reused review reply lacks its verified native publication receipt")
        elif publish:
            if not reserved:
                work_publication(head, start_replies=True)
                reserved = True
            posted = await client.post(f"/repos/{target}/pulls/{pull}/comments/{parent}/replies", json={"body": body})
        else:
            continue
        receipts.append({"comment_id": posted["id"], "in_reply_to_id": parent, "url": posted.get("html_url")})
    return receipts


def failure_diagnostic(error: Exception, mode: str, token: str | None = None) -> dict:
    env = dict(os.environ)
    if isinstance(token, str):
        env["GITHUB_INTERFACE_TOKEN"] = token
    request_error = error if isinstance(error, httpx.HTTPError) else error.__cause__
    try:
        request = request_error.request if isinstance(request_error, (httpx.RequestError, httpx.HTTPStatusError)) else None
    except RuntimeError:
        # Standalone transport errors can lack an attached request.
        request = None
    check = f"{request.method} {request.url.path}: " if request else ""
    cause = redact(check + (str(error) or type(error).__name__), env).encode("utf-8")
    return {
        "version": 1, "source": "caller", "severity": "error", "operation": f"issue_work.{mode}",
        "phase": "issue_work", "outcome": "refused" if isinstance(error, ValueError) else "exception",
        "stderr": cause[:STDERR_BYTES].decode("utf-8", errors="replace"), "stderr_truncated": len(cause) > STDERR_BYTES,
    }


async def run(client: GitHubClient, payload: dict) -> dict:
    try:
        return await _issue_work(client, payload)
    except (RuntimeError, ValueError, httpx.HTTPError, KeyError, TypeError) as error:
        if getattr(error, "diagnostic", None):
            raise
        diagnostic = failure_diagnostic(error, str(payload.get("mode") or ""), client.token)
        failure = (ValueError if isinstance(error, ValueError) else RuntimeError)(diagnostic["stderr"])
        failure.diagnostic = diagnostic
        raise failure from error


async def _issue_work(client: GitHubClient, payload: dict) -> dict:
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
          issue(number:$number){blockedBy(first:100){totalCount pageInfo{hasNextPage}
            nodes{number repository{nameWithOwner}}
          } closedByPullRequestsReferences(first:100,after:$cursor){pageInfo{hasNextPage endCursor}
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
    connection = source["issue"].get("blockedBy")
    nodes = connection.get("nodes") if isinstance(connection, dict) else None
    page = connection.get("pageInfo") if isinstance(connection, dict) else None
    complete = isinstance(nodes, list) and len(nodes) <= 100 \
        and type(connection.get("totalCount")) is int and connection["totalCount"] == len(nodes) \
        and isinstance(page, dict) and page.get("hasNextPage") is False
    prerequisites = []
    for node in nodes if isinstance(nodes, list) else []:
        dependency_repo = node.get("repository") if isinstance(node, dict) else None
        name = dependency_repo.get("nameWithOwner") if isinstance(dependency_repo, dict) else None
        if not isinstance(node, dict) or type(node.get("number")) is not int or node["number"] < 1 \
                or not isinstance(name, str) or not name:
            complete = False
        elif name.lower() == target.lower():
            prerequisites.append({"repo": name.lower(), "number": node["number"]})
    result["prerequisites"] = {"repo": target, "number": issue_number, "found": True,
                               "complete": complete, "prerequisites": prerequisites}
    # GitHub can omit stacked PRs from both closing-reference connections.
    closing = re.compile(
        r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:"
        rf"(?:{re.escape(target)})?#|https?://github\.com/{re.escape(target)}/issues/)"
        rf"{issue_number}\b", re.IGNORECASE)
    for candidate in await client.paginate(f"/repos/{target}/pulls", {"state": "open"}):
        if candidate["state"] != "open":
            continue
        if candidate["head"]["ref"] == branch and (candidate["head"].get("repo") or {}).get("full_name", "").lower() == target.lower():
            continue
        if candidate["base"]["repo"]["full_name"].lower() != target.lower():
            continue
        if closing.search(candidate["body"] or "") and candidate["html_url"] not in result["existing_pulls"]:
            result["existing_pulls"].append(candidate["html_url"])
    replies = json.loads(payload.get("replies_json") or "[]")
    if not isinstance(replies, list):
        raise ValueError("review replies must be an array")
    if mode == "inspect":
        if replies and pull is not None:
            result["reply_receipts"] = await review_replies(client, target, int(pull["number"]), actor, str(payload.get("invocation_id") or ""), replies, publish=False)
            result["replies_complete"] = len(result["reply_receipts"]) == len(replies)
        return result
    if mode == "retire":
        from github_interface import full_suite_repair
        from github_interface.behaviors import issue_comments

        expected = str(payload.get("expected_head") or "")
        proof = json.loads(payload.get("coverage_json") or "null")
        if not pull or not SHA.fullmatch(expected) or not isinstance(proof, dict) or proof.get("verified") is not True \
                or proof.get("duplicate") != {"number": pull["number"], "head": expected}:
            raise ValueError("retirement requires the original verified coverage and duplicate head")
        if pull.get("merged_at") or pull.get("merged"):
            raise ValueError("a merged pull request cannot be retired as redundant")
        result.update(merged=False, merge_sha=None, head_sha=expected)
        if result["existing_pulls"]:
            return {**result, "outcome": "not_ready", "reason": "linked work needs a decision"}
        if pull["head"]["sha"] != expected or remote_head != expected:
            return {**result, "outcome": "superseded", "reason": "duplicate head changed; a decision is required"}
        issue = await client.get(f"/repos/{target}/issues/{issue_number}")
        if proof.get("kind") == "empty_integration":
            verified = await remediation_coverage(client, target, issue, pull, base_head)
        else:
            comments = await issue_comments.run(client, payload)
            verified = await full_suite_repair.inspect(client, target, issue, comments["comments"], pull)
        if verified != proof:
            return {**result, "outcome": "not_ready", "reason": "retirement coverage changed; a decision is required"}
        current = await get_pull(client, owner, repo, pull["number"])
        if any(current.get(key) != pull.get(key) for key in ("head", "base", "body", "user", "updated_at")) \
                or current["head"]["sha"] != expected or remote_head != expected or current.get("merged"):
            return {**result, "outcome": "superseded", "reason": "duplicate head or publication context changed; a decision is required"}
        if proof.get("kind") == "empty_integration":
            current_base = await client.get(f"/repos/{target}/git/ref/heads/{default_branch}")
            if current_base["object"]["sha"] != base_head:
                return {**result, "outcome": "superseded", "reason": "integration base changed; fresh coverage is required"}
        if current["state"] == "closed":
            return {**result, "outcome": "already_closed", "coverage": verified}
        closed = await client.patch(f"/repos/{target}/pulls/{pull['number']}", json={"state": "closed"})
        if closed.get("state") != "closed" or closed.get("merged") or closed.get("merged_at") or closed["head"]["sha"] != expected:
            raise RuntimeError("GitHub did not confirm closing the original redundant head")
        return {**result, "outcome": "closed", "state": "closed", "coverage": verified}
    if result["existing_pulls"]:
        raise ValueError("seed issue already has another open pull request; its existing owner must continue")
    expected = str(payload.get("expected_head") or "").lower()
    if mode in {"validate", "publish"} and pull is not None and (pull.get("merged") or pull.get("merged_at")):
        merged_head = (pull.get("head") or {}).get("sha")
        if pull_number is None or pull.get("number") != pull_number or pull.get("state") != "closed" \
                or pull.get("merged") is not True or not isinstance(pull.get("merged_at"), str) or not pull["merged_at"] \
                or not SHA.fullmatch(str(pull.get("merge_commit_sha") or "")) \
                or not SHA.fullmatch(expected) or merged_head != expected \
                or str(payload.get("starting_head") or "").lower() != expected or remote_head not in (None, merged_head):
            raise ValueError("same-head merge check lacks consistent evidence for the original repair")
        # The branch may already be deleted. The owned PR retains its verified
        # head, which Caller needs to decode and settle this no-write receipt.
        return {**result, "outcome": "superseded", "head_sha": merged_head, "merged": True}
    issue = await client.get(f"/repos/{target}/issues/{issue_number}")
    if issue.get("state") != "open" or "pull_request" in issue:
        raise ValueError("behavior chain seed is no longer an open issue")
    if pull is not None and (pull.get("state") != "open" or pull.get("merged_at") or pull.get("merged")):
        raise ValueError("behavior chain pull request is no longer open")
    if expected and (not SHA.fullmatch(expected) or expected.lower() != str(remote_head).lower()):
        return {**result, "outcome": "superseded"}
    if mode == "complete":
        call_id = str(payload.get("invocation_id") or "")
        title, body = str(payload.get("title") or ""), str(payload.get("body") or "")
        if not expected or not invocation or invocation.group(1) != call_id:
            raise ValueError("publication recovery requires the original invocation and exact pushed head")
        if pull is not None:
            pull = await confirmed_pull(client, owner, repo, pull, expected)
            posted = await review_replies(client, target, int(pull["number"]), actor, call_id, replies, publish=True, head=expected)
            return {**result, "outcome": "published", "reply_receipts": posted}
        publication_body(body, target, issue_number)
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
        return {**result, "outcome": "validated", "has_changes": bool(dirty)}
    if pull is None:
        # First PR: the admission decision can go stale while the worker runs.
        # Re-verify live same-repository prerequisites on the candidate base
        # before any write. Delivery uses starting_head, not current main.
        base = starting_head.lower()
        prereq = result.get("prerequisites") if isinstance(result.get("prerequisites"), dict) else None
        deps = prereq.get("prerequisites") if isinstance(prereq, dict) and isinstance(prereq.get("prerequisites"), list) else None
        if prereq is None or str(prereq.get("repo") or "").lower() != target.lower() \
                or prereq.get("number") != issue_number or prereq.get("found") is not True \
                or prereq.get("complete") is not True or deps is None:
            reason = f"GitHub blocked-by evidence is missing or incomplete for {target}#{issue_number}"
            return {**result, "outcome": "prerequisite_wait", "prerequisite_wait": {
                "base": base, "prerequisites": prereq if isinstance(prereq, dict) else None,
                "deliveries": [], "reason": reason}}
        deliveries: list = []
        for dep in deps:
            if not isinstance(dep, dict) or str(dep.get("repo") or "").lower() != target.lower() \
                    or type(dep.get("number")) is not int or dep["number"] < 1:
                reason = f"GitHub blocked-by evidence is missing or incomplete for {target}#{issue_number}"
                return {**result, "outcome": "prerequisite_wait", "prerequisite_wait": {
                    "base": base, "prerequisites": prereq, "deliveries": deliveries, "reason": reason}}
            delivery = await read_issue.run(client, {"repository": target, "issue": f"#{dep['number']}", "delivery_base": base})
            deliveries.append(delivery)
            if str(delivery.get("repository") or "").lower() != target.lower() \
                    or delivery.get("issue_number") != dep["number"] or delivery.get("base_sha") != base \
                    or delivery.get("state") != "closed" or delivery.get("verified") is not True \
                    or not isinstance(delivery.get("merge_sha"), str) or not re.fullmatch(r"[0-9a-f]{40}", delivery["merge_sha"]) \
                    or type(delivery.get("pull_number")) is not int or delivery["pull_number"] < 1:
                reason = f"Waiting for prerequisite {target}#{dep['number']}: {delivery.get('reason') or 'delivery is not verified on the implementation base'}"
                return {**result, "outcome": "prerequisite_wait", "prerequisite_wait": {
                    "base": base, "prerequisites": prereq, "deliveries": deliveries, "reason": reason}}
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
