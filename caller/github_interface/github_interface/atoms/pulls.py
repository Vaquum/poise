from typing import Any

from github_interface.client import GitHubClient
from github_interface.atoms.review_identity import invocation_body


async def get_pull(client: GitHubClient, owner: str, repo: str, pull_number: int) -> dict[str, Any]:
    return await client.get(f"/repos/{owner}/{repo}/pulls/{pull_number}")


async def list_open_pulls_for_branch(
    client: GitHubClient,
    owner: str,
    repo: str,
    branch: str,
) -> list[dict[str, Any]]:
    return await client.paginate(
        f"/repos/{owner}/{repo}/pulls",
        params={"state": "open", "head": f"{owner}:{branch}"},
    )


_READINESS_QUERY = """
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          id
          state
          isDraft
          mergeable
          mergeStateStatus
          headRefOid
          reviewDecision
          mergeQueue { id }
          mergeQueueEntry { id }
          reviews(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              author { login }
              state
              submittedAt
              commit { oid }
            }
          }
          reviewThreads(first: 100) {
            pageInfo { hasNextPage }
            nodes { isResolved isOutdated }
          }
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup { state }
              }
            }
          }
        }
      }
    }
    """

# Check names for the held reasons, read with the same query and the same
# head commit so they always describe the head the reasons describe. Both
# node kinds: CheckRun carries name/status/conclusion, the legacy commit
# StatusContext carries context/state.
_CHECK_CONTEXTS_SELECTION = """
              contexts(first: 100) {
                pageInfo { hasNextPage }
                nodes {
                  __typename
                  ... on CheckRun { name status conclusion }
                  ... on StatusContext { context state }
                }
              }"""


def readiness_query(include_contexts: bool = False) -> str:
    """The pull-request readiness query, with check names only for readers
    that report them: the contexts add GraphQL cost to every call."""
    if not include_contexts:
        return _READINESS_QUERY
    anchor = "statusCheckRollup { state }"
    if _READINESS_QUERY.count(anchor) != 1:
        raise RuntimeError("readiness query no longer carries the rollup anchor for check contexts")
    return _READINESS_QUERY.replace(anchor, "statusCheckRollup { state" + _CHECK_CONTEXTS_SELECTION + " }")


async def get_pr_readiness_state(
    client: GitHubClient,
    owner: str,
    repo: str,
    pull_number: int,
    include_contexts: bool = False,
) -> dict[str, Any]:
    data = await client.graphql(
        readiness_query(include_contexts),
        {"owner": owner, "repo": repo, "number": pull_number},
    )
    return _required_pull(data, pull_number)


async def enqueue_pull_request(client: GitHubClient, pull_id: str, head_sha: str) -> dict[str, Any]:
    data = await client.graphql("""
    mutation($pull: ID!, $head: GitObjectID!) {
      enqueuePullRequest(input: {pullRequestId: $pull, expectedHeadOid: $head}) {
        mergeQueueEntry { id pullRequest { headRefOid } }
      }
    }
    """, {"pull": pull_id, "head": head_sha})
    entry = (data.get("enqueuePullRequest") or {}).get("mergeQueueEntry")
    if not isinstance(entry, dict) or not entry.get("id") or (entry.get("pullRequest") or {}).get("headRefOid") != head_sha:
        raise RuntimeError("GitHub did not confirm a merge queue entry for the expected head")
    return entry


async def get_full_diff(client: GitHubClient, owner: str, repo: str, pull_number: int) -> str:
    return await client.get_text(
        f"/repos/{owner}/{repo}/pulls/{pull_number}",
        accept="application/vnd.github.v3.diff",
    )


async def list_changed_files(client: GitHubClient, owner: str, repo: str, pull_number: int) -> list[dict[str, Any]]:
    return await client.paginate(f"/repos/{owner}/{repo}/pulls/{pull_number}/files")


async def list_inline_comments(client: GitHubClient, owner: str, repo: str, pull_number: int) -> list[dict[str, Any]]:
    return await client.paginate(f"/repos/{owner}/{repo}/pulls/{pull_number}/comments")


async def list_reviews(client: GitHubClient, owner: str, repo: str, pull_number: int) -> list[dict[str, Any]]:
    return await client.paginate(f"/repos/{owner}/{repo}/pulls/{pull_number}/reviews")


async def request_changes(
    client: GitHubClient,
    owner: str,
    repo: str,
    pull_number: int,
    commit_id: str,
    comments: list[dict[str, Any]],
    body: str,
) -> dict[str, Any]:
    review: dict[str, Any] = {
        "event": "REQUEST_CHANGES",
        "body": invocation_body(body, commit_id),
        "commit_id": commit_id,
    }
    if comments:
        review["comments"] = comments
    return await client.post(
        f"/repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        json=review,
    )


async def comment_review(
    client: GitHubClient,
    owner: str,
    repo: str,
    pull_number: int,
    commit_id: str,
    body: str,
) -> dict[str, Any]:
    return await client.post(
        f"/repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        json={"event": "COMMENT", "body": invocation_body(body, commit_id), "commit_id": commit_id},
    )


async def list_commits(client: GitHubClient, owner: str, repo: str, pull_number: int) -> list[dict[str, Any]]:
    return await client.paginate(f"/repos/{owner}/{repo}/pulls/{pull_number}/commits")


async def get_combined_status(client: GitHubClient, owner: str, repo: str, ref: str) -> dict[str, Any]:
    return await client.get(f"/repos/{owner}/{repo}/commits/{ref}/status")


async def list_check_runs(client: GitHubClient, owner: str, repo: str, ref: str) -> list[dict[str, Any]]:
    runs = []
    page = 1
    while True:
        data = await client.get(
            f"/repos/{owner}/{repo}/commits/{ref}/check-runs",
            params={"per_page": 100, "page": page},
        )
        batch = data.get("check_runs", [])
        runs.extend(batch)
        if len(batch) < 100:
            return runs
        page += 1


async def read_job_log(client: GitHubClient, owner: str, repo: str, job_id: int) -> str:
    return await client.get_text(
        f"/repos/{owner}/{repo}/actions/jobs/{job_id}/logs",
        accept="application/vnd.github+json",
    )


REVIEW_THREAD_FIELDS = """
id
isOutdated
isResolved
path
line
originalLine
diffSide
comments(first: 100) {
  nodes {
    databaseId
    body
    author { login }
  }
}
"""
REVIEW_REQUEST_FIELDS = "requestedReviewer { ... on User { login } }"
REVIEW_ACTIVITY_FIELDS = "id databaseId author { login } state submittedAt updatedAt commit { oid }"


async def list_review_threads(
    client: GitHubClient, owner: str, repo: str, pull_number: int,
    initial_page: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    nodes = await _pull_nodes(
        client, owner, repo, pull_number, "reviewThreads", REVIEW_THREAD_FIELDS, initial_page,
    )
    return [_thread_summary(thread) for thread in nodes]


async def get_requested_review_state(
    client: GitHubClient,
    owner: str,
    repo: str,
    pull_number: int,
) -> dict[str, Any]:
    query = """
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          state
          isDraft
          mergeable
          headRefOid
          reviewRequests(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              requestedReviewer {
                ... on User { login }
              }
            }
          }
          reviews(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              author { login }
              state
            }
          }
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup { state }
              }
            }
          }
        }
      }
    }
    """
    data = await client.graphql(
        query,
        {"owner": owner, "repo": repo, "number": pull_number},
    )
    pull = data["repository"]["pullRequest"]
    if not pull:
        raise ValueError(f"pull request not found: #{pull_number}")
    return pull


async def get_pull_check_rollup(
    client: GitHubClient,
    owner: str,
    repo: str,
    pull_number: int,
) -> dict[str, Any]:
    query = """
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          headRefOid
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup { state }
              }
            }
          }
        }
      }
    }
    """
    data = await client.graphql(
        query,
        {"owner": owner, "repo": repo, "number": pull_number},
    )
    return _required_pull(data, pull_number)


REVIEW_ACTIVITY_QUERY = f"""
query($owner: String!, $repo: String!, $number: Int!) {{
  repository(owner: $owner, name: $repo) {{
    pullRequest(number: $number) {{
      state
      isDraft
      headRefOid
      updatedAt
      reviewRequests(first: 100) {{
        pageInfo {{ hasNextPage endCursor }}
        nodes {{ {REVIEW_REQUEST_FIELDS} }}
      }}
      reviews(first: 100) {{
        pageInfo {{ hasNextPage endCursor }}
        nodes {{ {REVIEW_ACTIVITY_FIELDS} }}
      }}
      reviewThreads(first: 100) {{
        pageInfo {{ hasNextPage endCursor }}
        nodes {{ {REVIEW_THREAD_FIELDS} }}
      }}
    }}
  }}
}}
"""


async def get_review_activity(
    client: GitHubClient,
    owner: str,
    repo: str,
    pull_number: int,
) -> dict[str, Any]:
    data = await client.graphql(
        REVIEW_ACTIVITY_QUERY, {"owner": owner, "repo": repo, "number": pull_number},
    )
    first = _required_pull(data, pull_number)
    pull = {key: first[key] for key in ("state", "isDraft", "headRefOid", "updatedAt")}
    pull["reviewRequests"] = await _pull_nodes(
        client, owner, repo, pull_number, "reviewRequests", REVIEW_REQUEST_FIELDS, first["reviewRequests"],
    )
    pull["reviews"] = await _pull_nodes(
        client, owner, repo, pull_number, "reviews", REVIEW_ACTIVITY_FIELDS, first["reviews"],
    )
    pull["reviewThreads"] = await list_review_threads(
        client, owner, repo, pull_number, first["reviewThreads"],
    )
    return pull


async def _pull_nodes(
    client: GitHubClient,
    owner: str,
    repo: str,
    pull_number: int,
    connection: str,
    fields: str,
    initial_page: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    query = f"""
    query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {{
      repository(owner: $owner, name: $repo) {{
        pullRequest(number: $number) {{
          {connection}(first: 100, after: $cursor) {{
            pageInfo {{ hasNextPage endCursor }}
            nodes {{ {fields} }}
          }}
        }}
      }}
    }}
    """
    nodes: list[dict[str, Any]] = []
    cursor = None
    page = initial_page
    while True:
        if page is None:
            data = await client.graphql(
                query,
                {"owner": owner, "repo": repo, "number": pull_number, "cursor": cursor},
            )
            page = _required_pull(data, pull_number)[connection]
        nodes.extend(page["nodes"])
        if not page["pageInfo"]["hasNextPage"]:
            return nodes
        cursor = page["pageInfo"]["endCursor"]
        page = None


def _required_pull(data: dict[str, Any], pull_number: int) -> dict[str, Any]:
    repository = data.get("repository")
    pull = repository.get("pullRequest") if repository else None
    if not pull:
        raise ValueError(f"pull request not found: #{pull_number}")
    return pull


async def post_pr_comment(client: GitHubClient, owner: str, repo: str, pull_number: int, body: str) -> dict[str, Any]:
    issue = await get_pull(client, owner, repo, pull_number)
    return await client.post(f"/repos/{owner}/{repo}/issues/{issue['number']}/comments", json={"body": body})


async def approve_pr(
    client: GitHubClient,
    owner: str,
    repo: str,
    pull_number: int,
    commit_id: str,
    body: str,
) -> dict[str, Any]:
    body = invocation_body(body, commit_id)
    payload = {"event": "APPROVE", "commit_id": commit_id, "body": body}
    return await client.post(
        f"/repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        json=payload,
    )


async def resolve_conversation(client: GitHubClient, thread_id: str) -> dict[str, Any]:
    query = """
    mutation($threadId: ID!) {
      resolveReviewThread(input: {threadId: $threadId}) {
        thread {
          id
          isResolved
        }
      }
    }
    """
    data = await client.graphql(query, {"threadId": thread_id})
    return data["resolveReviewThread"]["thread"]


async def start_review_with_inline_comments(
    client: GitHubClient,
    owner: str,
    repo: str,
    pull_number: int,
    commit_id: str,
    comments: list[dict[str, Any]],
) -> dict[str, Any]:
    return await client.post(
        f"/repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        json={"commit_id": commit_id, "comments": comments},
    )


async def submit_change_request(
    client: GitHubClient,
    owner: str,
    repo: str,
    pull_number: int,
    review_id: int,
    body: str,
) -> dict[str, Any]:
    return await client.post(
        f"/repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/events",
        json={"event": "REQUEST_CHANGES", "body": body},
    )


def _thread_summary(thread: dict[str, Any]) -> dict[str, Any]:
    comments = thread["comments"]["nodes"]
    bodies = [comment["body"] for comment in comments]
    return {
        "id": thread["id"],
        "is_outdated": thread["isOutdated"],
        "is_resolved": thread["isResolved"],
        "root_comment_id": comments[0].get("databaseId") if comments else None,
        "author": str((comments[0].get("author") or {}).get("login") or "") if comments else "",
        "path": thread["path"],
        "line": thread["line"] or thread["originalLine"],
        "side": thread["diffSide"],
        "bodies": bodies,
    }
