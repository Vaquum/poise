from __future__ import annotations

import json
import logging
import os
import re
import ssl
import subprocess
import time
from collections import Counter
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any, Callable, TypeVar

if TYPE_CHECKING:
    import httpx

logger = logging.getLogger(__name__)


class GitHubApiError(RuntimeError):
    pass


class GitHubRequestError(GitHubApiError):
    pass


class GitHubGraphQLError(GitHubRequestError):
    def __init__(self, message: str, data: Any, errors: Any) -> None:
        super().__init__(message)
        self.data, self.errors = data, errors


class ItemGraphError(GitHubApiError):
    """A failed graph for one identified issue or pull request."""


class GitHubRateLimitError(GitHubApiError):
    def __init__(self, message: str, reset_at: int | None) -> None:
        self.reset_at = reset_at
        super().__init__(message if reset_at is None else f"{message} GITHUB_RATE_LIMIT_RESET={reset_at}")


ENUMERATION_DRIFT_MAX_ATTEMPTS = 3


class GitHubEnumerationDriftError(GitHubApiError):
    """Upstream changed while a connection was being paged.

    The partial pass is discarded and the enumeration restarts from its
    first page with the original watermark. Drift past the attempt budget
    still fails loudly.
    """


class GitHubStoredPullsMissingError(GitHubApiError):
    def __init__(self, full_name: str, ids: set[int]) -> None:
        self.ids = ids
        super().__init__(f"stored pull requests missing from GraphQL for {full_name}: {sorted(ids)}")


@dataclass(frozen=True)
class PullReconciliation:
    items: list[dict[str, object]]
    missing_ids: set[int]


@dataclass(frozen=True)
class PartialItemInventory:
    items: list[dict[str, Any]]
    problems: list[str]
    unreadable: dict[int, str]


@dataclass(frozen=True)
class PartialRepositoryInventory:
    repos: list[dict[str, Any]]
    problems: list[str]


_T = TypeVar("_T")


def _retry_enumeration_on_drift(operation: Callable[[], _T]) -> _T:
    """Restart a connection enumeration while upstream drifts mid-page."""
    attempts = 0
    while True:
        try:
            return operation()
        except GitHubEnumerationDriftError:
            attempts += 1
            if attempts >= ENUMERATION_DRIFT_MAX_ATTEMPTS:
                raise


def split_http_response(stdout: str) -> tuple[dict[str, str], str]:
    # gh --include prefixes the JSON with the response headers. A redirect or
    # interim response can contribute another header block; only the last
    # response's quota applies to this GraphQL request.
    headers: dict[str, str] = {}
    body = stdout.replace("\r\n", "\n")
    while body.startswith("HTTP/"):
        block, separator, body = body.partition("\n\n")
        if not separator:
            raise GitHubApiError("GraphQL response has incomplete HTTP headers")
        headers = {}
        for line in block.splitlines()[1:]:
            key, separator, value = line.partition(":")
            if not separator:
                raise GitHubApiError("GraphQL response has malformed HTTP headers")
            headers[key.strip().lower()] = value.strip()
    return headers, body


def raise_rate_limit(headers: Mapping[str, str], diagnostic: str) -> None:
    if headers.get("x-ratelimit-remaining") != "0":
        return
    # A successful request may spend the final point, and an unrelated error
    # must retain its diagnostic rather than being mistaken for exhaustion.
    if not re.search(r"\brate limit (?:already )?(?:exceeded|reached)\b|\bRATE_LIMIT(?:ED)?\b|\bexceeded (?:a |the |your )?(?:secondary |primary )?rate limit\b", diagnostic, re.IGNORECASE):
        return
    reset = headers.get("x-ratelimit-reset", "")
    if not reset.isdecimal() or int(reset) <= 0:
        raise GitHubRateLimitError(f"{diagnostic}; GraphQL rate limit response has no valid reset time", None)
    raise GitHubRateLimitError(diagnostic, int(reset))


ASSIGNEE_FRAGMENT = """
__typename
... on User { login avatarUrl }
... on Bot { login avatarUrl }
... on Mannequin { login avatarUrl }
... on Organization { login avatarUrl }
"""


REQUESTED_REVIEWER_FRAGMENT = """
__typename
... on User { login }
... on Bot { login }
... on Mannequin { login }
... on Team { slug name }
"""


ISSUE_TIMELINE_TYPES = """
ASSIGNED_EVENT
UNASSIGNED_EVENT
CLOSED_EVENT
REOPENED_EVENT
MENTIONED_EVENT
CROSS_REFERENCED_EVENT
"""


PR_TIMELINE_TYPES = """
ASSIGNED_EVENT
UNASSIGNED_EVENT
REVIEW_REQUESTED_EVENT
REVIEW_REQUEST_REMOVED_EVENT
MERGED_EVENT
CLOSED_EVENT
REOPENED_EVENT
MENTIONED_EVENT
CROSS_REFERENCED_EVENT
"""


ISSUE_TIMELINE_FRAGMENT = f"""
__typename
... on AssignedEvent {{
  id
  createdAt
  actor {{ login }}
  assignee {{ {ASSIGNEE_FRAGMENT} }}
}}
... on UnassignedEvent {{
  id
  createdAt
  actor {{ login }}
  assignee {{ {ASSIGNEE_FRAGMENT} }}
}}
... on ClosedEvent {{
  id
  createdAt
  actor {{ login }}
}}
... on ReopenedEvent {{
  id
  createdAt
  actor {{ login }}
}}
... on MentionedEvent {{
  id
  databaseId
  createdAt
  actor {{ login }}
}}
... on CrossReferencedEvent {{
  id
  createdAt
  actor {{ login }}
}}
"""


PR_TIMELINE_FRAGMENT = f"""
{ISSUE_TIMELINE_FRAGMENT}
... on ReviewRequestedEvent {{
  id
  createdAt
  actor {{ login }}
  requestedReviewer {{ {REQUESTED_REVIEWER_FRAGMENT} }}
}}
... on ReviewRequestRemovedEvent {{
  id
  createdAt
  actor {{ login }}
  requestedReviewer {{ {REQUESTED_REVIEWER_FRAGMENT} }}
}}
... on MergedEvent {{
  id
  createdAt
  actor {{ login }}
}}
"""


REPO_FIELDS = """
databaseId
id
name
nameWithOwner
isPrivate
isArchived
hasIssuesEnabled
owner { login }
"""


ISSUE_ITEM_FIELDS = """
databaseId
fullDatabaseId
id
number
state
title
body
createdAt
updatedAt
closedAt
author { login }
assignees(first: 100) { pageInfo { hasNextPage } nodes { login avatarUrl } }
"""

ISSUE_STUB_FIELDS = """
databaseId
fullDatabaseId
id
number
updatedAt
"""

PULL_ITEM_FIELDS = """
fullDatabaseId
id
number
state
title
body
createdAt
updatedAt
closedAt
author { login }
assignees(first: 100) { pageInfo { hasNextPage } nodes { login avatarUrl } }
"""

PULL_STUB_FIELDS = """
fullDatabaseId
id
number
updatedAt
"""


ITEM_GRAPH_BATCH_SIZE = 20


ISSUE_GRAPH_FIELDS = f"""
      {ISSUE_ITEM_FIELDS}
      labels(first: 100) {{ totalCount pageInfo {{ hasNextPage endCursor }} nodes {{ id name }} }}
      blockedBy(first: 100) {{
        pageInfo {{ hasNextPage }}
        nodes {{
          number
          repository {{ nameWithOwner }}
        }}
      }}
      comments(first: 100) {{
        pageInfo {{ hasNextPage endCursor }}
        nodes {{
          databaseId
          fullDatabaseId
          id
          author {{ login }}
          body
          createdAt
          updatedAt
        }}
      }}
      timelineItems(first: 100, itemTypes: [{ISSUE_TIMELINE_TYPES}]) {{
        pageInfo {{ hasNextPage endCursor }}
        nodes {{ {ISSUE_TIMELINE_FRAGMENT} }}
      }}

"""


PR_GRAPH_FIELDS = f"""
      {PULL_ITEM_FIELDS}
      mergedAt
      mergedBy {{ login }}
      isDraft
      additions
      deletions
      headRefName
      headRepository {{ nameWithOwner }}
      closingIssuesReferences(first: 100) {{
        pageInfo {{ hasNextPage }}
        nodes {{
          number
          title
          repository {{ nameWithOwner }}
        }}
      }}
      comments(first: 100) {{
        pageInfo {{ hasNextPage endCursor }}
        nodes {{
          databaseId
          fullDatabaseId
          id
          author {{ login }}
          body
          createdAt
          updatedAt
        }}
      }}
      timelineItems(first: 100, itemTypes: [{PR_TIMELINE_TYPES}]) {{
        pageInfo {{ hasNextPage endCursor }}
        nodes {{ {PR_TIMELINE_FRAGMENT} }}
      }}
      reviewRequests(first: 100) {{
        pageInfo {{ hasNextPage endCursor }}
        nodes {{
          id
          requestedReviewer {{ {REQUESTED_REVIEWER_FRAGMENT} }}
        }}
      }}
      reviews(first: 100) {{
        pageInfo {{ hasNextPage endCursor }}
        nodes {{
          fullDatabaseId
          id
          author {{ login }}
          state
          body
          submittedAt
          commit {{ oid }}
        }}
      }}
      reviewThreads(first: 100) {{
        pageInfo {{ hasNextPage endCursor }}
        nodes {{
          id
          isResolved
          isOutdated
          comments(first: 100) {{
            pageInfo {{ hasNextPage endCursor }}
            nodes {{
              fullDatabaseId
              id
              author {{ login }}
              body
              path
              createdAt
              updatedAt
            }}
          }}
        }}
      }}
      commits(first: 100) {{
        pageInfo {{ hasNextPage endCursor }}
        nodes {{
          id
          commit {{
            oid
            author {{ name date user {{ login }} }}
            committer {{ name date user {{ login }} }}
          }}
        }}
      }}

"""


ISSUE_BASE_QUERY = f"""
query($owner: String!, $name: String!, $number: Int!) {{
  repository(owner: $owner, name: $name) {{
    issue(number: $number) {{
      {ISSUE_GRAPH_FIELDS}
    }}
  }}
}}
"""


PR_BASE_QUERY = f"""
query($owner: String!, $name: String!, $number: Int!) {{
  repository(owner: $owner, name: $name) {{
    pullRequest(number: $number) {{
      {PR_GRAPH_FIELDS}
    }}
  }}
}}
"""


_GITHUB_GRAPHQL_URL = "https://api.github.com/graphql"
_GITHUB_GRAPHQL_HOST = "api.github.com"


def _github_proxy(environment: dict[str, str]) -> str | None:
    # Match gh's Go proxy selection for this fixed HTTPS host.
    proxy = environment.get("HTTPS_PROXY") or environment.get("https_proxy")
    if not proxy:
        return None
    exclusions = environment.get("NO_PROXY") or environment.get("no_proxy", "")
    for entry in exclusions.lower().split(","):
        entry = entry.strip()
        if entry == "*":
            return None
        host, _, port = entry.partition(":")
        if port and port != "443":
            continue
        if host.startswith("*."):
            host = host[1:]
        domain_suffix = host if host.startswith(".") else "." + host
        if host == _GITHUB_GRAPHQL_HOST or _GITHUB_GRAPHQL_HOST.endswith(domain_suffix):
            return None
    return proxy if "://" in proxy else f"http://{proxy}"


def _uses_cli_transport(environment: dict[str, str]) -> bool:
    if environment.get("GH_HOST") != "github.com" or environment.get("GH_DEBUG"):
        return True
    # Keep gh's own endpoint and socket configuration on its CLI path. These
    # settings are inspected once per run, before any GraphQL requests.
    for key in ("http_unix_socket", "api_host"):
        config = subprocess.run(
            ["gh", "config", "get", key, "--host", "github.com"],
            capture_output=True, text=True, env=environment,
        )
        if config.returncode == 0:
            if config.stdout.strip():
                return True
        elif config.returncode != 1 or f'could not find key "{key}"' not in config.stderr:
            raise GitHubApiError(f"could not read gh transport configuration: {config.stderr.strip()}")
    return False


def _json_ended_early(error: json.JSONDecodeError) -> bool:
    tail = error.doc[error.pos:]
    if not tail or error.msg == "Unterminated string starting at":
        return True
    if error.msg == "Expecting value":
        return tail in {"-", "n", "nu", "nul", "t", "tr", "tru", "f", "fa", "fal", "fals"}
    if error.msg == "Invalid \\uXXXX escape":
        return bool(re.fullmatch(r"u[0-9a-fA-F]{0,3}", tail))
    return (error.msg in {"Expecting ',' delimiter", "Extra data"}
            and error.pos > 0 and error.doc[error.pos - 1].isdigit()
            and bool(re.fullmatch(r"\.|[eE][+-]?", tail)))


@contextmanager
def datastore_github_client() -> Iterator[GitHubClient]:
    environment = os.environ.copy()
    token = environment.get("GH_TOKEN", "").strip()
    proxy = _github_proxy(environment)
    if not token or (proxy and not proxy.startswith(("http://", "https://"))) or _uses_cli_transport(environment):
        yield GitHubClient()
        return
    try:
        import httpx
    except ImportError:  # Test harnesses run the datastore on a bare system python.
        yield GitHubClient()
        return

    with httpx.Client(proxy=proxy, trust_env=False, verify=ssl.create_default_context(),
                      timeout=httpx.Timeout(None, connect=30.0)) as http:
        yield GitHubClient(http=http, token=token)


class GitHubClient:
    def __init__(
        self, attempts: int = 5, retry_sleep_seconds: int = 1, *,
        http: httpx.Client | None = None, token: str | None = None,
    ) -> None:
        if attempts <= 0:
            raise ValueError("attempts must be positive")
        self.attempts = attempts
        self.retry_sleep_seconds = retry_sleep_seconds
        self._http = http
        self._token = token
        self._rate_limit_error: GitHubRateLimitError | None = None

    def graphql(self, query: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        last_error = ""
        environment = os.environ.copy()
        # Several accounts can be signed in to gh; the datastore reads GitHub
        # only as the account whose token it is given, never gh's active one.
        token = self._token if self._token is not None else environment.get("GH_TOKEN", "").strip()
        if not token:
            raise GitHubRequestError("GH_TOKEN is not set: github-datastore reads GitHub only as the account whose token it is given")
        fields = {key: value for key, value in (variables or {}).items() if value is not None}
        for attempt in range(1, self.attempts + 1):
            if self._rate_limit_error is not None and (self._rate_limit_error.reset_at is None
                                                       or time.time() < self._rate_limit_error.reset_at):
                raise self._rate_limit_error
            if self._http is None:
                headers, body, failure, retryable = self._cli_request(query, fields, environment)
            else:
                headers, body, failure, retryable = self._http_request(self._http, query, fields, token)
            if failure is None:
                try:
                    payload = json.loads(body)
                except json.JSONDecodeError as error:
                    if self._http is None or not _json_ended_early(error):
                        raise
                    failure = f"unexpected end of JSON input: {error}"
                    retryable = True
                else:
                    if payload.get("errors"):
                        diagnostic = f"GraphQL errors: {json.dumps(payload['errors'])}"
                        self._raise_rate_limit(headers, diagnostic)
                        raise GitHubGraphQLError(diagnostic, payload.get("data"), payload["errors"])
                    return payload["data"]
            last_error = failure
            self._raise_rate_limit(headers, f"GraphQL request failed: {last_error}")
            if not retryable or attempt == self.attempts:
                raise GitHubRequestError(f"GraphQL request failed: {last_error}")
            time.sleep(self.retry_sleep_seconds)

        raise GitHubRequestError(f"GraphQL request failed: {last_error}")

    def _cli_request(
        self, query: str, fields: dict[str, Any], environment: dict[str, str],
    ) -> tuple[Mapping[str, str], str, str | None, bool]:
        args = ["gh", "api", "graphql", "--include", "-f", f"query={query}"]
        for key, value in fields.items():
            # Raw fields preserve numeric names and literals such as "null" as strings.
            args.extend(["-f" if isinstance(value, str) else "-F", f"{key}={value}"])
        proc = subprocess.run(args, capture_output=True, text=True, env=environment)
        headers, body = split_http_response(proc.stdout)
        if proc.returncode == 0:
            return headers, body, None, False
        failure = "\n".join(part.strip() for part in (proc.stderr, body) if part.strip())
        return headers, body, failure, self._retryable(failure)

    @staticmethod
    def _http_request(
        http: httpx.Client, query: str, fields: dict[str, Any], token: str,
    ) -> tuple[Mapping[str, str], str, str | None, bool]:
        import httpx

        # An explicit request avoids carrying cookies from one GraphQL read to
        # the next. The token is sent only to the configured GitHub endpoint.
        request = httpx.Request(
            "POST", _GITHUB_GRAPHQL_URL, json={"query": query, "variables": fields},
            headers={"Authorization": f"token {token}", "Accept": "application/json",
                     "Accept-Encoding": "gzip", "User-Agent": "github-datastore"},
        )
        try:
            response = http.send(request, follow_redirects=False)
        except httpx.RequestError as error:
            detail = str(error).replace(token, "[redacted]")
            retryable = isinstance(error, (httpx.NetworkError, httpx.RemoteProtocolError, httpx.TimeoutException))
            return {}, "", detail, retryable and "CERTIFICATE_VERIFY_FAILED" not in detail
        if response.is_success:
            try:
                return response.headers, response.content.decode("utf-8"), None, False
            except UnicodeDecodeError as error:
                if error.reason != "unexpected end of data":
                    raise
                return response.headers, "", f"unexpected end of JSON input: {error}", True
        detail = f"HTTP {response.status_code} {response.reason_phrase}\n{response.text}".strip()
        return response.headers, "", detail, response.status_code in (429, 500, 502, 503, 504)

    def _raise_rate_limit(self, headers: Mapping[str, str], diagnostic: str) -> None:
        try:
            raise_rate_limit(headers, diagnostic)
        except GitHubRateLimitError as error:
            # The reader is shared by the expansion workers. Once one request
            # exhausts the quota, later worker requests fail locally until reset.
            self._rate_limit_error = error
            raise

    def _retryable(self, text: str) -> bool:
        retry_markers = (
            " 429 ",
            " 500 ",
            " 502 ",
            " 503 ",
            " 504 ",
            "HTTP 429",
            "HTTP 500",
            "HTTP 502",
            "HTTP 503",
            "HTTP 504",
            "timeout",
            "timed out",
            "unexpected EOF",
            "unexpected end of JSON input",
            "Something went wrong while executing your query",
            "can't assign requested address",
            "cannot assign requested address",
            "read tcp ",
            "write tcp ",
            "dial tcp ",
            "connection",
            "Connection",
            "network",
            "Network",
            "DNS",
            "nodename nor servname",
            "could not resolve",
            "We couldn't respond to your request in time",
        )
        # Match HTTP statuses, not incidental digits in a socket address or
        # ephemeral port (for example :54013 in an otherwise retryable error).
        if re.search(r"\bHTTP(?:/\d+(?:\.\d+)?)?\s+(?:401|403|404)\b", text, re.IGNORECASE):
            return False
        non_retryable = ("Field ", "Cannot query field", "Variable ")
        if any(marker in text for marker in non_retryable):
            return False
        return any(marker in text for marker in retry_markers)


def split_full_name(full_name: str) -> tuple[str, str]:
    owner, name = full_name.split("/", 1)
    return owner, name


class GitHubOrgReader:
    def __init__(self, client: GitHubClient) -> None:
        self.client = client

    def list_org_repos(self, org: str) -> list[dict[str, Any]] | PartialRepositoryInventory:
        return _retry_enumeration_on_drift(lambda: self._list_org_repos_once(org))

    def _list_org_repos_once(self, org: str) -> list[dict[str, Any]] | PartialRepositoryInventory:
        # Keep the historical method/CLI name while accepting either owner
        # kind. OWNER excludes organizations and repositories a user merely
        # collaborates on; those belong to their own datastore scope.
        query = f"""
        query($org: String!, $cursor: String) {{
          repositoryOwner(login: $org) {{
            __typename
            login
            repositories(first: 100, after: $cursor, ownerAffiliations: [OWNER]) {{
              totalCount
              pageInfo {{ hasNextPage endCursor }}
              nodes {{ {REPO_FIELDS} }}
            }}
          }}
        }}
        """
        repos: list[dict[str, Any]] = []
        problems: list[str] = []
        received = 0
        cursor: str | None = None
        cursors: set[str] = set()
        expected_count: int | None = None
        while True:
            data = self.client.graphql(query, {"org": org, "cursor": cursor})
            owner = data.get("repositoryOwner")
            if owner is None:
                raise GitHubApiError(f"repository owner not found or inaccessible: {org}")
            if owner.get("__typename") not in ("User", "Organization") or str(owner.get("login", "")).casefold() != org.casefold():
                raise GitHubApiError(f"repository owner does not match requested account: {org}")
            conn = owner["repositories"]
            count = conn.get("totalCount")
            if type(count) is not int or count < 0:
                raise GitHubApiError(f"invalid repository totalCount for {org}")
            if expected_count is not None and count != expected_count:
                raise GitHubEnumerationDriftError(f"repository totalCount changed while listing {org}")
            expected_count = count
            for node in conn["nodes"]:
                received += 1
                try:
                    if not isinstance(node, dict):
                        raise GitHubApiError("GitHub returned a missing or malformed repository entry")
                    repo = graphql_repo_to_row(node)
                    if (str(repo["owner"]["login"]).casefold() != org.casefold()
                        or repo["full_name"].casefold() != f"{org}/{repo['name']}".casefold()):
                        raise GitHubApiError("repository identity is outside its requested owner or name")
                except (GitHubApiError, KeyError, ValueError, TypeError, AttributeError) as error:
                    name = node.get("nameWithOwner") if isinstance(node, dict) else None
                    problems.append(f"{org} repository {name or f'row {received}'}: {error}")
                    continue
                repos.append(repo)
            if not conn["pageInfo"]["hasNextPage"]:
                break
            cursor = required_next_cursor(conn["pageInfo"], cursor, org, "repositories", "repositories")
            if cursor in cursors:
                raise GitHubApiError(f"cyclic repository page cursor for {org}")
            cursors.add(cursor)

        if received != expected_count:
            raise GitHubEnumerationDriftError(f"incomplete repository enumeration for {org}: expected {expected_count}, got {received}")
        by_id = Counter(repo["id"] for repo in repos)
        by_name = Counter(repo["full_name"].casefold() for repo in repos)
        unique = []
        for repo in repos:
            if by_id[repo["id"]] != 1 or by_name[repo["full_name"].casefold()] != 1:
                problems.append(f"{repo['full_name']}: duplicate repository identity")
            else:
                unique.append(repo)
        if problems and not unique:
            raise GitHubApiError(f"no readable repositories for {org}: {problems[0]}")
        return PartialRepositoryInventory(unique, problems) if problems else unique

    def list_repo_issues(
        self, full_name: str, since: str | None = None, *, include_issues: bool = True,
    ) -> list[dict[str, Any]] | PartialItemInventory:
        owner, name = split_full_name(full_name)
        issues = _retry_enumeration_on_drift(
            lambda: self._list_issue_nodes(owner, name, since, changed_only=False)
        ) if include_issues else []
        pulls = _retry_enumeration_on_drift(lambda: self._list_pull_nodes(owner, name))
        return self._merge_item_nodes(full_name, issues, pulls)

    def list_repo_changed_items(
        self,
        full_name: str,
        since: str | None,
        stored_pr_updated_at: dict[int, str],
    ) -> list[dict[str, Any]] | PartialItemInventory:
        if since is None:
            return self.list_repo_issues(full_name)
        owner, name = split_full_name(full_name)
        issues, pulls = _retry_enumeration_on_drift(
            lambda: self._list_changed_issue_and_pull_nodes(owner, name, since)
        )
        inventory = self._merge_item_nodes(full_name, issues, pulls)
        if isinstance(inventory, PartialItemInventory):
            return inventory
        pulls = self._changed_pull_nodes(full_name, pulls, stored_pr_updated_at)
        return self._merge_item_nodes(full_name, issues, pulls)

    def list_repos_changed_items(
        self,
        full_names: list[str],
        since: str | None,
        stored_pr_updated_at: dict[str, dict[int, str]],
        *,
        include_issues: bool = True,
    ) -> dict[str, list[dict[str, Any]] | PullReconciliation | PartialItemInventory]:
        if len({name.casefold() for name in full_names}) != len(full_names):
            raise ValueError("duplicate repositories in changed-item batch")
        if since is None:
            return {name: self.list_repo_issues(name) if include_issues else
                    self.list_repo_issues(name, include_issues=False) for name in full_names}
        parse_graphql_datetime(since, "repository batch watermark")
        result: dict[str, list[dict[str, Any]] | PullReconciliation | PartialItemInventory] = {}
        # Only minimal stubs are batched. Their complete expanded graphs still
        # supply all direct-association evidence through the existing reader.
        for start in range(0, len(full_names), 20):
            names = full_names[start:start + 20]
            completed = _retry_enumeration_on_drift(
                lambda: self._list_changed_item_chunk(names, since, include_issues=include_issues)
            )
            for full_name, source in completed.items():
                if isinstance(source, PartialItemInventory):
                    result[full_name] = source
                    continue
                issues, pulls = source
                inventory = self._merge_item_nodes(full_name, issues, pulls)
                if isinstance(inventory, PartialItemInventory):
                    result[full_name] = inventory
                    continue
                stored = stored_pr_updated_at.get(full_name, {})
                missing_ids: set[int] = set()
                try:
                    pulls = self._changed_pull_nodes(full_name, pulls, stored)
                except GitHubStoredPullsMissingError as error:
                    # Confirm absence with a fresh, complete repository enumeration.
                    repeated = _retry_enumeration_on_drift(
                        lambda: self._list_changed_item_chunk([full_name], since, include_issues=include_issues)
                    )
                    source = repeated[full_name]
                    if isinstance(source, PartialItemInventory):
                        result[full_name] = source
                        continue
                    issues, pulls = source
                    inventory = self._merge_item_nodes(full_name, issues, pulls)
                    if isinstance(inventory, PartialItemInventory):
                        result[full_name] = inventory
                        continue
                    missing_ids = error.ids - {int(required_id(node, "pr")) for node in pulls}
                    pulls = self._changed_pull_nodes(
                        full_name, pulls, {pull_id: updated for pull_id, updated in stored.items() if pull_id not in missing_ids}
                    )
                items = self._merge_item_nodes(full_name, issues, pulls)
                result[full_name] = PullReconciliation(items, missing_ids) if missing_ids else items
        return result

    def _list_changed_item_chunk(
        self,
        names: list[str],
        since: str,
        *,
        include_issues: bool,
    ) -> dict[str, tuple[list[dict[str, Any]], list[dict[str, Any]]] | PartialItemInventory]:
        declarations = ["$since: DateTime!"] if include_issues else []
        fields: list[str] = []
        variables: dict[str, Any] = {"since": since} if include_issues else {}
        issue_selection = f"""
                issues(first: 100, states: [OPEN, CLOSED], filterBy: {{since: $since}}, orderBy: {{field: CREATED_AT, direction: ASC}}) {{
                  totalCount
                  pageInfo {{ hasNextPage endCursor }}
                  nodes {{ {ISSUE_STUB_FIELDS} }}
                }}
        """ if include_issues else ""
        for index, full_name in enumerate(names):
            owner, name = split_full_name(full_name)
            declarations.extend([f"$owner{index}: String!", f"$name{index}: String!"])
            variables.update({f"owner{index}": owner, f"name{index}": name})
            fields.append(f"""
              repo_{index}: repository(owner: $owner{index}, name: $name{index}) {{
                nameWithOwner
                {issue_selection}
                pullRequests(first: 100, states: [OPEN, CLOSED, MERGED], orderBy: {{field: CREATED_AT, direction: ASC}}) {{
                  totalCount
                  pageInfo {{ hasNextPage endCursor }}
                  nodes {{ {PULL_STUB_FIELDS} }}
                }}
              }}
            """)
        query = "query(" + ", ".join(declarations) + ") {" + "".join(fields) + "}"
        data = self.client.graphql(query, variables)
        repositories, unreadable = {}, {}
        for index, full_name in enumerate(names):
            repo = data.get(f"repo_{index}")
            if not isinstance(repo, dict):
                unreadable[full_name] = PartialItemInventory([], [f"missing repository batch result: {full_name}"], {})
            elif str(repo.get("nameWithOwner", "")).casefold() != full_name.casefold():
                unreadable[full_name] = PartialItemInventory([], [f"repository batch result does not match: {full_name}"], {})
            else:
                repositories[full_name] = repo
        if not repositories:
            raise GitHubApiError(next(iter(unreadable.values())).problems[0])
        complete = self._complete_changed_repository_batch(list(repositories), since, repositories, include_issues=include_issues)
        return {**complete, **unreadable}

    def _complete_changed_repository_batch(
        self,
        full_names: list[str],
        since: str,
        repositories: dict[str, dict[str, Any]],
        *,
        include_issues: bool = True,
    ) -> dict[str, tuple[list[dict[str, Any]], list[dict[str, Any]]]]:
        nodes = {}
        totals = {}
        cursors = {}
        seen_cursors = {}
        since_at = parse_graphql_datetime(since, "repository batch watermark")
        connections = ("issues", "pullRequests") if include_issues else ("pullRequests",)
        for full_name in full_names:
            owner, name = split_full_name(full_name)
            for key in connections:
                identity = (full_name, key)
                conn = repositories[full_name][key]
                nodes[identity] = list(conn["nodes"])
                totals[identity] = required_total_count(conn, owner, name, key)
                seen_cursors[identity] = set()
                if conn["pageInfo"]["hasNextPage"]:
                    cursor = required_next_cursor(conn["pageInfo"], None, owner, name, key)
                    cursors[identity] = cursor
                    seen_cursors[identity].add(cursor)

        # Each selection follows a cursor GitHub already returned. Independent
        # connections share a request, while each connection's page order stays intact.
        while cursors:
            pending = list(cursors)
            for start in range(0, len(pending), 20):
                batch = pending[start:start + 20]
                declarations = ["$since: DateTime!"] if any(key == "issues" for _, key in batch) else []
                variables = {"since": since} if declarations else {}
                selections = []
                for index, (full_name, key) in enumerate(batch):
                    owner, name = split_full_name(full_name)
                    declarations.extend([f"$owner{index}: String!", f"$name{index}: String!", f"$cursor{index}: String!"])
                    variables.update({f"owner{index}": owner, f"name{index}": name, f"cursor{index}": cursors[(full_name, key)]})
                    states = "OPEN, CLOSED" if key == "issues" else "OPEN, CLOSED, MERGED"
                    filter_by = ", filterBy: {since: $since}" if key == "issues" else ""
                    fields = ISSUE_STUB_FIELDS if key == "issues" else PULL_STUB_FIELDS
                    selections.append(f"""
                      page_{index}: repository(owner: $owner{index}, name: $name{index}) {{
                        nameWithOwner
                        {key}(first: 100, after: $cursor{index}, states: [{states}]{filter_by}, orderBy: {{field: CREATED_AT, direction: ASC}}) {{
                          totalCount
                          pageInfo {{ hasNextPage endCursor }}
                          nodes {{ {fields} }}
                        }}
                      }}
                    """)
                query = "query(" + ", ".join(declarations) + ") {" + "".join(selections) + "}"
                data = self.client.graphql(query, variables)
                for index, (full_name, key) in enumerate(batch):
                    identity = (full_name, key)
                    owner, name = split_full_name(full_name)
                    repo = data.get(f"page_{index}")
                    if not isinstance(repo, dict):
                        raise GitHubApiError(f"missing repository batch result: {full_name}")
                    if str(repo.get("nameWithOwner", "")).casefold() != full_name.casefold():
                        raise GitHubApiError(f"repository batch result does not match: {full_name}")
                    conn = repo[key]
                    total_count = required_total_count(conn, owner, name, key)
                    if total_count != totals[identity]:
                        raise GitHubEnumerationDriftError(f"{key} totalCount changed while enumerating {full_name}: {totals[identity]} to {total_count}")
                    for node in conn["nodes"]:
                        if key == "pullRequests" or _changed_issue_node(node, since_at):
                            nodes[identity].append(node)
                    if conn["pageInfo"]["hasNextPage"]:
                        cursor = required_next_cursor(conn["pageInfo"], cursors[identity], owner, name, key)
                        if cursor in seen_cursors[identity]:
                            raise GitHubApiError(f"{full_name} {key} returned a cyclic page cursor")
                        seen_cursors[identity].add(cursor)
                        cursors[identity] = cursor
                    else:
                        del cursors[identity]

        completed = {}
        for full_name in full_names:
            for key in connections:
                label = "issue" if key == "issues" else "pull request"
                identity = (full_name, key)
                if len(nodes[identity]) != totals[identity]:
                    raise GitHubEnumerationDriftError(f"{label} enumeration count mismatch for {full_name}: expected {totals[identity]}, received {len(nodes[identity])}")
            completed[full_name] = (nodes[(full_name, "issues")] if include_issues else [], nodes[(full_name, "pullRequests")])
        return completed

    def _list_changed_issue_and_pull_nodes(
        self,
        owner: str,
        name: str,
        since: str,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        query = f"""
        query($owner: String!, $name: String!, $since: DateTime!) {{
          repository(owner: $owner, name: $name) {{
            issues(first: 100, states: [OPEN, CLOSED], filterBy: {{since: $since}}, orderBy: {{field: CREATED_AT, direction: ASC}}) {{
              totalCount
              pageInfo {{ hasNextPage endCursor }}
              nodes {{ {ISSUE_STUB_FIELDS} }}
            }}
            pullRequests(first: 100, states: [OPEN, CLOSED, MERGED], orderBy: {{field: CREATED_AT, direction: ASC}}) {{
              totalCount
              pageInfo {{ hasNextPage endCursor }}
              nodes {{ {PULL_STUB_FIELDS} }}
            }}
          }}
        }}
        """
        data = self.client.graphql(query, {"owner": owner, "name": name, "since": since})
        repo = data.get("repository")
        if repo is None:
            raise GitHubApiError(f"repo not found or inaccessible: {owner}/{name}")
        return self._complete_changed_issue_and_pull_nodes(owner, name, since, repo)

    def _complete_changed_issue_and_pull_nodes(
        self,
        owner: str,
        name: str,
        since: str,
        repo: dict[str, Any],
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        issue_conn = repo["issues"]
        pull_conn = repo["pullRequests"]
        total_issue_count = required_total_count(issue_conn, owner, name, "issues")
        total_pull_count = required_total_count(pull_conn, owner, name, "pullRequests")
        issues = list(issue_conn["nodes"])
        pulls = list(pull_conn["nodes"])
        if issue_conn["pageInfo"]["hasNextPage"]:
            issues.extend(
                self._list_issue_nodes(
                    owner,
                    name,
                    since,
                    changed_only=True,
                    initial_cursor=required_next_cursor(
                        issue_conn["pageInfo"], None, owner, name, "issues"
                    ),
                    expected_total=total_issue_count,
                )
            )
        if pull_conn["pageInfo"]["hasNextPage"]:
            pulls.extend(
                self._list_pull_nodes(
                    owner,
                    name,
                    initial_cursor=required_next_cursor(
                        pull_conn["pageInfo"], None, owner, name, "pullRequests"
                    ),
                    expected_total=total_pull_count,
                )
            )
        if len(issues) != total_issue_count:
            raise GitHubEnumerationDriftError(
                f"issue enumeration count mismatch for {owner}/{name}: "
                f"expected {total_issue_count}, received {len(issues)}"
            )
        if len(pulls) != total_pull_count:
            raise GitHubEnumerationDriftError(
                f"pull request enumeration count mismatch for {owner}/{name}: "
                f"expected {total_pull_count}, received {len(pulls)}"
            )
        return issues, pulls

    def _changed_pull_nodes(
        self,
        full_name: str,
        pulls: list[dict[str, Any]],
        stored_pr_updated_at: dict[int, str],
    ) -> list[dict[str, Any]]:
        current: dict[int, dict[str, Any]] = {}
        changed: list[dict[str, Any]] = []
        for node in pulls:
            pull_id = int(required_id(node, "pr"))
            if pull_id in current:
                raise GitHubApiError(f"duplicate pull request id returned for {full_name}: {pull_id}")
            current[pull_id] = node
            updated_at = parse_graphql_datetime(
                node.get("updatedAt"), f"pull request {pull_id} for {full_name}"
            )
            stored = stored_pr_updated_at.get(pull_id)
            if stored is None:
                changed.append(node)
                continue
            try:
                stored_at = parse_graphql_datetime(stored, f"stored pull request {pull_id} for {full_name}")
            except GitHubApiError as error:
                logger.warning("Refreshing unreadable saved pull %s#%s: %s", full_name, node.get("number"), error)
                changed.append(node)
                continue
            # GitHub can correct timestamps backward; either change needs a fresh graph.
            if updated_at != stored_at:
                changed.append(node)

        missing_ids = set(stored_pr_updated_at) - current.keys()
        if missing_ids:
            raise GitHubStoredPullsMissingError(full_name, missing_ids)
        return changed

    def _merge_item_nodes(
        self, full_name: str, issues: list[dict[str, Any]], pulls: list[dict[str, Any]]
    ) -> list[dict[str, Any]] | PartialItemInventory:
        items, problems, unreadable = [], [], {}
        for kind, nodes in (("issue", issues), ("pr", pulls)):
            for index, node in enumerate(nodes):
                try:
                    if not isinstance(node, dict):
                        raise GitHubApiError(f"GitHub returned a missing or malformed {kind} entry")
                    items.append(graphql_item_stub_to_row(node, kind))
                except (GitHubApiError, KeyError, ValueError, TypeError, AttributeError) as error:
                    number = node.get("number") if isinstance(node, dict) else None
                    target = f"#{number}" if type(number) is int else f"row {index + 1}"
                    reason = f"{full_name} {kind} {target}: {error}"
                    problems.append(reason)
                    if type(number) is int and number > 0:
                        unreadable[number] = reason
        by_id = Counter(item["id"] for item in items)
        by_number = Counter(item["number"] for item in items)
        unique = []
        for item in items:
            number = item["number"]
            if by_id[item["id"]] > 1 or by_number[number] > 1:
                reason = f"{full_name}#{number}: duplicate item identity"
                problems.append(reason)
                unreadable[number] = reason
            elif number not in unreadable:
                unique.append(item)
        items = unique
        items.sort(key=lambda item: (item["updated_at"], item["number"]))
        return PartialItemInventory(items, problems, unreadable) if problems else items

    def expand_issue_or_pr(self, repo: dict[str, Any], issue_stub: dict[str, Any]) -> dict[str, Any]:
        owner, name = split_full_name(str(repo["full_name"]))
        number = int(issue_stub["number"])
        if issue_stub["item_kind"] == "pr":
            return self._expand_pull(repo, owner, name, number)
        return self._expand_issue(repo, owner, name, number)

    def fetch_initial_item_graphs(
        self, repo: dict[str, Any], items: list[dict[str, Any]]
    ) -> dict[int, dict[str, Any] | ItemGraphError]:
        if not 1 <= len(items) <= ITEM_GRAPH_BATCH_SIZE:
            raise ValueError(f"item graph batch must contain 1..{ITEM_GRAPH_BATCH_SIZE} items")
        numbers = [int(item["number"]) for item in items]
        if len(set(numbers)) != len(numbers):
            raise ValueError("item graph batch has duplicate numbers")
        owner, name = split_full_name(str(repo["full_name"]))
        variables: dict[str, Any] = {"owner": owner, "name": name}
        declarations = ["$owner: String!", "$name: String!"]
        selections = []
        for index, item in enumerate(items):
            kind = item["item_kind"]
            if kind not in ("issue", "pr"):
                raise ValueError(f"invalid item graph kind: {kind!r}")
            field = "pullRequest" if kind == "pr" else "issue"
            fields = PR_GRAPH_FIELDS if kind == "pr" else ISSUE_GRAPH_FIELDS
            # Narrow only the first thread page; the existing paginator still
            # reads every remaining thread and every thread's comment pages.
            fields = fields.replace("reviewThreads(first: 100)", "reviewThreads(first: 20)")
            declarations.append(f"$number_{index}: Int!")
            variables[f"number_{index}"] = numbers[index]
            selections.append(
                f"item_{index}: {field}(number: $number_{index}) {{ __typename {fields} }}"
            )
        query = (
            "query(" + ", ".join(declarations) + ") {"
            " repository(owner: $owner, name: $name) { " + " ".join(selections) + " } }"
        )
        expected_aliases = {f"item_{index}" for index in range(len(items))}
        failures: dict[str, str] = {}
        try:
            data = self.client.graphql(query, variables)
        except GitHubGraphQLError as error:
            if not isinstance(error.data, dict) or not isinstance(error.errors, list):
                raise
            for entry in error.errors:
                path = entry.get("path") if isinstance(entry, dict) else None
                if (not isinstance(path, list) or len(path) < 2 or path[0] != "repository"
                        or not isinstance(path[1], str) or path[1] not in expected_aliases):
                    raise
                failures.setdefault(path[1], str(entry.get("message") or "GitHub returned a graph error"))
            data = error.data
        nodes = data.get("repository")
        if not isinstance(nodes, dict):
            raise GitHubApiError(f"incomplete item graph batch for {owner}/{name}")
        result: dict[int, dict[str, Any] | ItemGraphError] = {}
        for index, item in enumerate(items):
            alias = f"item_{index}"
            node = nodes.get(alias)
            number = numbers[index]
            if alias in failures:
                result[number] = ItemGraphError(f"{owner}/{name}#{number}: {failures[alias]}")
                continue
            expected_type = "PullRequest" if item["item_kind"] == "pr" else "Issue"
            try:
                if (not isinstance(node, dict) or node.get("__typename") != expected_type
                        or type(node.get("number")) is not int or node["number"] != number
                        or int(required_id(node, item["item_kind"])) != int(item["id"])):
                    raise ItemGraphError("missing graph or identity mismatch")
            except (GitHubApiError, ValueError, TypeError) as error:
                result[number] = ItemGraphError(f"{owner}/{name}#{number}: {error}")
                continue
            result[number] = {key: value for key, value in node.items() if key != "__typename"}
        return result

    def expand_item_graph(
        self, repo: dict[str, Any], item: dict[str, Any], node: dict[str, Any]
    ) -> dict[str, Any]:
        owner, name = split_full_name(str(repo["full_name"]))
        number = int(item["number"])
        try:
            if item["item_kind"] == "pr":
                return self._expand_pull_graph(repo, owner, name, number, node)
            return self._expand_issue_graph(repo, owner, name, number, node)
        except GitHubRateLimitError:
            raise
        except (GitHubApiError, KeyError, TypeError, ValueError, AttributeError) as error:
            raise ItemGraphError(f"{owner}/{name}#{number}: {type(error).__name__}: {error}") from error

    def _list_issue_nodes(
        self,
        owner: str,
        name: str,
        since: str | None,
        changed_only: bool,
        initial_cursor: str | None = None,
        expected_total: int | None = None,
    ) -> list[dict[str, Any]]:
        if changed_only:
            query = f"""
        query($owner: String!, $name: String!, $cursor: String, $since: DateTime!) {{
          repository(owner: $owner, name: $name) {{
            issues(first: 100, after: $cursor, states: [OPEN, CLOSED], filterBy: {{since: $since}}, orderBy: {{field: CREATED_AT, direction: ASC}}) {{
              totalCount
              pageInfo {{ hasNextPage endCursor }}
              nodes {{ {ISSUE_STUB_FIELDS} }}
            }}
          }}
        }}
        """
            return self._page_repository_nodes(
                query,
                owner,
                name,
                "issues",
                since,
                initial_cursor,
                expected_total=expected_total,
            )
        query = f"""
        query($owner: String!, $name: String!, $cursor: String) {{
          repository(owner: $owner, name: $name) {{
            issues(first: 100, after: $cursor, states: [OPEN, CLOSED], orderBy: {{field: CREATED_AT, direction: ASC}}) {{
              totalCount
              pageInfo {{ hasNextPage endCursor }}
              nodes {{ {ISSUE_STUB_FIELDS} }}
            }}
          }}
        }}
        """
        return self._page_repository_nodes(
            query,
            owner,
            name,
            "issues",
            since,
            initial_cursor,
            validate_total=initial_cursor is None,
        )

    def _list_pull_nodes(
        self,
        owner: str,
        name: str,
        initial_cursor: str | None = None,
        expected_total: int | None = None,
    ) -> list[dict[str, Any]]:
        query = f"""
        query($owner: String!, $name: String!, $cursor: String) {{
          repository(owner: $owner, name: $name) {{
            pullRequests(first: 100, after: $cursor, states: [OPEN, CLOSED, MERGED], orderBy: {{field: CREATED_AT, direction: ASC}}) {{
              totalCount
              pageInfo {{ hasNextPage endCursor }}
              nodes {{ {PULL_STUB_FIELDS} }}
            }}
          }}
        }}
        """
        return self._page_repository_nodes(
            query,
            owner,
            name,
            "pullRequests",
            None,
            initial_cursor,
            validate_total=initial_cursor is None,
            expected_total=expected_total,
        )

    def _page_repository_nodes(
        self,
        query: str,
        owner: str,
        name: str,
        key: str,
        since: str | None,
        initial_cursor: str | None = None,
        validate_total: bool = False,
        expected_total: int | None = None,
    ) -> list[dict[str, Any]]:
        if validate_total and initial_cursor is not None:
            raise ValueError("cannot validate total count from a partial enumeration")
        if expected_total is not None and (type(expected_total) is not int or expected_total < 0):
            raise ValueError("expected total must be a non-negative integer")
        nodes: list[dict[str, Any]] = []
        received_count = 0
        cursor = initial_cursor
        seen_cursors = set() if cursor is None else {cursor}
        since_at = (
            None if since is None else parse_graphql_datetime(since, "repository page watermark")
        )
        while True:
            data = self.client.graphql(
                query, {"owner": owner, "name": name, "cursor": cursor, "since": since}
            )
            repo = data.get("repository")
            if repo is None:
                raise GitHubApiError(f"repo not found or inaccessible: {owner}/{name}")
            conn = repo[key]
            if validate_total or expected_total is not None:
                total_count = required_total_count(conn, owner, name, key)
                if expected_total is None:
                    expected_total = total_count
                elif total_count != expected_total:
                    raise GitHubEnumerationDriftError(
                        f"{key} totalCount changed while enumerating {owner}/{name}: "
                        f"{expected_total} to {total_count}"
                    )
            received_count += len(conn["nodes"])
            for node in conn["nodes"]:
                if since_at is None or _changed_issue_node(node, since_at):
                    nodes.append(node)
            if not conn["pageInfo"]["hasNextPage"]:
                break
            next_cursor = required_next_cursor(conn["pageInfo"], cursor, owner, name, key)
            if next_cursor in seen_cursors:
                raise GitHubApiError(f"{owner}/{name} {key} returned a cyclic page cursor")
            seen_cursors.add(next_cursor)
            cursor = next_cursor
        if validate_total and expected_total is not None and received_count != expected_total:
            raise GitHubEnumerationDriftError(
                f"{key} enumeration count mismatch for {owner}/{name}: "
                f"expected {expected_total}, received {received_count}"
            )
        return nodes

    def _expand_issue(
        self, repo: dict[str, Any], owner: str, name: str, number: int
    ) -> dict[str, Any]:
        data = self.client.graphql(
            ISSUE_BASE_QUERY,
            {"owner": owner, "name": name, "number": number},
        )
        return self._expand_issue_graph(repo, owner, name, number, data["repository"]["issue"])

    def _expand_issue_graph(
        self, repo: dict[str, Any], owner: str, name: str, number: int, issue: dict[str, Any]
    ) -> dict[str, Any]:
        comments = [graphql_comment_to_row(node) for node in issue["comments"]["nodes"]]
        timeline = [graphql_timeline_to_row(node, index) for index, node in enumerate(issue["timelineItems"]["nodes"])]
        comments.extend(self._page_issue_comments(owner, name, number, issue["comments"]["pageInfo"]))
        timeline.extend(
            self._page_timeline(owner, name, number, False, issue["timelineItems"]["pageInfo"], len(timeline))
        )
        issue = dict(issue)
        labels = issue.get("labels")
        if not isinstance(labels, dict):
            raise GitHubApiError(f"issue label evidence is missing: {owner}/{name}#{number}")
        total = required_total_count(labels, owner, name, "issue labels")
        nodes = list(labels["nodes"])
        cursor = None
        while labels["pageInfo"]["hasNextPage"]:
            cursor = required_next_cursor(labels["pageInfo"], cursor, owner, name, "issue labels")
            data = self.client.graphql("""query($owner:String!,$name:String!,$number:Int!,$cursor:String){
              repository(owner:$owner,name:$name){issue(number:$number){labels(first:100,after:$cursor){
                totalCount pageInfo{hasNextPage endCursor} nodes{id name}
              }}}}
            """, {"owner": owner, "name": name, "number": number, "cursor": cursor})
            labels = data["repository"]["issue"]["labels"]
            if required_total_count(labels, owner, name, "issue labels") != total:
                raise GitHubEnumerationDriftError("issue label count changed during pagination")
            nodes.extend(labels["nodes"])
        if len(nodes) != total or any(not isinstance(label, dict) or not isinstance(label.get("id"), str)
                                     or not isinstance(label.get("name"), str) for label in nodes) or len({label["id"] for label in nodes}) != total:
            raise GitHubApiError(f"incomplete or duplicate issue labels: {owner}/{name}#{number}")
        issue["labels"] = {"totalCount": total, "pageInfo": labels["pageInfo"], "nodes": nodes}
        row = graphql_issue_to_row(issue)
        row["labels"] = [{"node_id": label["id"], "name": label["name"]} for label in nodes]
        return {
            "repo": repo,
            "issue": row,
            "is_pr": False,
            "pull": None,
            "comments": comments,
            "timeline": timeline,
            "reviews": [],
            "review_comments": [],
            "commits": [],
        }

    def _expand_pull(
        self, repo: dict[str, Any], owner: str, name: str, number: int
    ) -> dict[str, Any]:
        data = self.client.graphql(
            PR_BASE_QUERY,
            {"owner": owner, "name": name, "number": number},
        )
        return self._expand_pull_graph(repo, owner, name, number, data["repository"]["pullRequest"])

    def _expand_pull_graph(
        self, repo: dict[str, Any], owner: str, name: str, number: int, pull: dict[str, Any]
    ) -> dict[str, Any]:
        comments = [graphql_comment_to_row(node) for node in pull["comments"]["nodes"]]
        timeline = [graphql_timeline_to_row(node, index) for index, node in enumerate(pull["timelineItems"]["nodes"])]
        reviews = [graphql_review_to_row(node) for node in pull["reviews"]["nodes"]]
        review_requests = list(pull["reviewRequests"]["nodes"])
        review_comments = [
            graphql_review_comment_to_row(comment, thread)
            for thread in pull["reviewThreads"]["nodes"]
            for comment in thread["comments"]["nodes"]
        ]
        commits = [graphql_commit_to_row(node) for node in pull["commits"]["nodes"]]
        comments.extend(self._page_pull_comments(owner, name, number, pull["comments"]["pageInfo"]))
        timeline.extend(
            self._page_timeline(owner, name, number, True, pull["timelineItems"]["pageInfo"], len(timeline))
        )
        review_requests.extend(
            self._page_review_requests(owner, name, number, pull["reviewRequests"]["pageInfo"])
        )
        reviews.extend(self._page_reviews(owner, name, number, pull["reviews"]["pageInfo"]))
        review_comments.extend(
            self._page_review_threads(
                owner, name, number, pull["reviewThreads"]["pageInfo"], pull["reviewThreads"]["nodes"]
            )
        )
        commits.extend(self._page_commits(owner, name, number, pull["commits"]["pageInfo"]))
        pull_with_all_requests = dict(pull)
        pull_with_all_requests["reviewRequests"] = {"nodes": review_requests}
        return {
            "repo": repo,
            "issue": graphql_pull_to_issue_row(pull),
            "is_pr": True,
            "pull": graphql_pull_to_pull_row(pull_with_all_requests),
            "comments": comments,
            "timeline": timeline,
            "reviews": reviews,
            "review_comments": dedupe_by_id(review_comments),
            "commits": commits,
        }

    def _page_issue_comments(
        self, owner: str, name: str, number: int, page_info: dict[str, Any]
    ) -> list[dict[str, Any]]:
        query = """
        query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $name) {
            issue(number: $number) {
              comments(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes { databaseId fullDatabaseId id author { login } body createdAt updatedAt }
              }
            }
          }
        }
        """
        return self._page_item_connection(query, owner, name, number, page_info, ("issue", "comments"), graphql_comment_to_row)

    def _page_pull_comments(
        self, owner: str, name: str, number: int, page_info: dict[str, Any]
    ) -> list[dict[str, Any]]:
        query = """
        query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              comments(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes { databaseId fullDatabaseId id author { login } body createdAt updatedAt }
              }
            }
          }
        }
        """
        return self._page_item_connection(query, owner, name, number, page_info, ("pullRequest", "comments"), graphql_comment_to_row)

    def _page_review_requests(
        self, owner: str, name: str, number: int, page_info: dict[str, Any]
    ) -> list[dict[str, Any]]:
        query = f"""
        query($owner: String!, $name: String!, $number: Int!, $cursor: String) {{
          repository(owner: $owner, name: $name) {{
            pullRequest(number: $number) {{
              reviewRequests(first: 100, after: $cursor) {{
                pageInfo {{ hasNextPage endCursor }}
                nodes {{
                  id
                  requestedReviewer {{ {REQUESTED_REVIEWER_FRAGMENT} }}
                }}
              }}
            }}
          }}
        }}
        """
        return self._page_item_connection(
            query, owner, name, number, page_info, ("pullRequest", "reviewRequests"), lambda node: node
        )

    def _page_timeline(
        self,
        owner: str,
        name: str,
        number: int,
        is_pr: bool,
        page_info: dict[str, Any],
        offset: int,
    ) -> list[dict[str, Any]]:
        item = "pullRequest" if is_pr else "issue"
        timeline_types = PR_TIMELINE_TYPES if is_pr else ISSUE_TIMELINE_TYPES
        timeline_fragment = PR_TIMELINE_FRAGMENT if is_pr else ISSUE_TIMELINE_FRAGMENT
        query = f"""
        query($owner: String!, $name: String!, $number: Int!, $cursor: String) {{
          repository(owner: $owner, name: $name) {{
            {item}(number: $number) {{
              timelineItems(first: 100, after: $cursor, itemTypes: [{timeline_types}]) {{
                pageInfo {{ hasNextPage endCursor }}
                nodes {{ {timeline_fragment} }}
              }}
            }}
          }}
        }}
        """
        rows: list[dict[str, Any]] = []
        cursor = page_info["endCursor"]
        index = offset
        while page_info["hasNextPage"]:
            data = self.client.graphql(query, {"owner": owner, "name": name, "number": number, "cursor": cursor})
            conn = data["repository"][item]["timelineItems"]
            for node in conn["nodes"]:
                rows.append(graphql_timeline_to_row(node, index))
                index += 1
            page_info = conn["pageInfo"]
            cursor = page_info["endCursor"]
        return rows

    def _page_reviews(
        self, owner: str, name: str, number: int, page_info: dict[str, Any]
    ) -> list[dict[str, Any]]:
        query = """
        query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              reviews(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  fullDatabaseId id author { login } state body submittedAt commit { oid }
                }
              }
            }
          }
        }
        """
        return self._page_item_connection(query, owner, name, number, page_info, ("pullRequest", "reviews"), graphql_review_to_row)

    def _page_review_threads(
        self,
        owner: str,
        name: str,
        number: int,
        page_info: dict[str, Any],
        first_page_nodes: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        rows = self._review_thread_comments(first_page_nodes, only_extra_pages=True)
        query = """
        query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  isResolved
                  isOutdated
                  comments(first: 100) {
                    pageInfo { hasNextPage endCursor }
                    nodes { fullDatabaseId id author { login } body path createdAt updatedAt }
                  }
                }
              }
            }
          }
        }
        """
        cursor = page_info["endCursor"]
        while page_info["hasNextPage"]:
            data = self.client.graphql(query, {"owner": owner, "name": name, "number": number, "cursor": cursor})
            conn = data["repository"]["pullRequest"]["reviewThreads"]
            rows.extend(self._review_thread_comments(conn["nodes"]))
            page_info = conn["pageInfo"]
            cursor = page_info["endCursor"]
        return rows

    def _review_thread_comments(
        self, threads: list[dict[str, Any]], only_extra_pages: bool = False
    ) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for thread in threads:
            if not only_extra_pages:
                rows.extend(graphql_review_comment_to_row(node, thread) for node in thread["comments"]["nodes"])
            if thread["comments"]["pageInfo"]["hasNextPage"]:
                rows.extend(self._page_review_thread_comments(thread, thread["comments"]["pageInfo"]))
        return rows

    def _page_review_thread_comments(
        self, thread: dict[str, Any], page_info: dict[str, Any]
    ) -> list[dict[str, Any]]:
        query = """
        query($id: ID!, $cursor: String) {
          node(id: $id) {
            ... on PullRequestReviewThread {
              comments(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes { fullDatabaseId id author { login } body path createdAt updatedAt }
              }
            }
          }
        }
        """
        thread_id = thread["id"]
        rows: list[dict[str, Any]] = []
        cursor = page_info["endCursor"]
        while page_info["hasNextPage"]:
            data = self.client.graphql(query, {"id": thread_id, "cursor": cursor})
            node = data["node"]
            if node is None:
                raise GitHubApiError(f"review thread not found: {thread_id}")
            conn = node["comments"]
            rows.extend(graphql_review_comment_to_row(comment, thread) for comment in conn["nodes"])
            page_info = conn["pageInfo"]
            cursor = page_info["endCursor"]
        return rows

    def _page_commits(
        self, owner: str, name: str, number: int, page_info: dict[str, Any]
    ) -> list[dict[str, Any]]:
        query = """
        query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              commits(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  commit {
                    oid
                    author { name date user { login } }
                    committer { name date user { login } }
                  }
                }
              }
            }
          }
        }
        """
        return self._page_item_connection(query, owner, name, number, page_info, ("pullRequest", "commits"), graphql_commit_to_row)

    def _page_item_connection(
        self,
        query: str,
        owner: str,
        name: str,
        number: int,
        page_info: dict[str, Any],
        path: tuple[str, str],
        mapper: Any,
    ) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        cursor = page_info["endCursor"]
        while page_info["hasNextPage"]:
            data = self.client.graphql(query, {"owner": owner, "name": name, "number": number, "cursor": cursor})
            conn = data["repository"][path[0]][path[1]]
            rows.extend(mapper(node) for node in conn["nodes"])
            page_info = conn["pageInfo"]
            cursor = page_info["endCursor"]
        return rows


def graphql_repo_to_row(node: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": int(required_id(node, "repository")),
        "node_id": node["id"],
        "owner": {"login": node["owner"]["login"]},
        "name": node["name"],
        "full_name": node["nameWithOwner"],
        "private": bool(node["isPrivate"]),
        "archived": bool(node["isArchived"]),
        "has_issues": bool(node["hasIssuesEnabled"]),
        "graphql": node,
    }


def required_next_cursor(
    page_info: dict[str, Any],
    current_cursor: str | None,
    owner: str,
    name: str,
    key: str,
) -> str:
    next_cursor = page_info.get("endCursor")
    if not isinstance(next_cursor, str) or not next_cursor or next_cursor == current_cursor:
        raise GitHubApiError(f"{owner}/{name} {key} returned a non-advancing page cursor")
    return next_cursor


def required_total_count(
    connection: dict[str, Any], owner: str, name: str, key: str
) -> int:
    total_count = connection.get("totalCount")
    if type(total_count) is not int or total_count < 0:
        raise GitHubApiError(
            f"invalid {key} totalCount for {owner}/{name}: {total_count!r}"
        )
    return total_count


def graphql_item_stub_to_row(node: dict[str, Any], item_kind: str) -> dict[str, Any]:
    updated_at = node.get("updatedAt")
    parse_graphql_datetime(updated_at, f"{item_kind} stub")
    number = node.get("number")
    if type(number) is not int or number <= 0:
        raise GitHubApiError(f"{item_kind} stub lacks a valid number")
    return {
        "id": int(required_id(node, item_kind)),
        "number": number,
        "updated_at": updated_at,
        "item_kind": item_kind,
    }


def _changed_issue_node(node: Any, since: datetime) -> bool:
    try:
        return parse_graphql_datetime(node.get("updatedAt"), "issue stub") >= since
    except (AttributeError, GitHubApiError):
        # Keep its place until item validation, which records the reason and
        # makes repository completeness unavailable for removal decisions.
        return True


def parse_graphql_datetime(value: Any, label: str) -> datetime:
    if not isinstance(value, str) or not value:
        raise GitHubApiError(f"{label} lacks a timestamp")
    normalized = f"{value[:-1]}+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise GitHubApiError(f"{label} has an invalid timestamp: {value}") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise GitHubApiError(f"{label} timestamp lacks a timezone: {value}")
    return parsed


def graphql_issue_to_row(node: dict[str, Any]) -> dict[str, Any]:
    assignees = complete_assignees(node)
    return {
        "id": int(required_id(node, "issue")),
        "node_id": node["id"],
        "number": int(node["number"]),
        "state": str(node["state"]).lower(),
        "title": node["title"],
        "body": node.get("body"),
        "user": login_object(node.get("author")),
        "assignees": [login_object(user) for user in assignees],
        "created_at": node["createdAt"],
        "updated_at": node["updatedAt"],
        "closed_at": node.get("closedAt"),
        "item_kind": "issue",
        "graphql": node,
    }


def graphql_pull_to_issue_row(node: dict[str, Any]) -> dict[str, Any]:
    row = graphql_issue_to_row(node)
    row["item_kind"] = "pr"
    row["pull_request"] = {"node_id": node["id"]}
    return row


def graphql_pull_to_pull_row(node: dict[str, Any]) -> dict[str, Any]:
    assignees = complete_assignees(node)
    return {
        "id": int(required_id(node, "pullRequest")),
        "node_id": node["id"],
        "requested_reviewers": [
            login_object(req["requestedReviewer"])
            for req in node.get("reviewRequests", {}).get("nodes", [])
            if explicit_login(req.get("requestedReviewer"))
        ],
        "assignees": [login_object(user) for user in assignees],
        "merged_by": login_object(node.get("mergedBy")),
        "merged_at": node.get("mergedAt"),
        "updated_at": node["updatedAt"],
        "graphql": node,
    }


def graphql_comment_to_row(node: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": int(required_id(node, "comment")),
        "node_id": node["id"],
        "user": login_object(node.get("author")),
        "body": node.get("body"),
        "created_at": node["createdAt"],
        "updated_at": node["updatedAt"],
        "graphql": node,
    }


def graphql_review_to_row(node: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": int(required_id(node, "review")),
        "node_id": node["id"],
        "user": login_object(node.get("author")),
        "state": node["state"],
        "body": node.get("body"),
        "commit_id": None if node.get("commit") is None else node["commit"]["oid"],
        "submitted_at": node.get("submittedAt"),
        "graphql": node,
    }


def graphql_review_comment_to_row(
    node: dict[str, Any], thread: dict[str, Any] | None = None
) -> dict[str, Any]:
    thread = thread or {}
    return {
        "id": int(required_id(node, "reviewComment")),
        "node_id": node["id"],
        "user": login_object(node.get("author")),
        "body": node.get("body"),
        "path": node.get("path"),
        "position": None,
        "created_at": node["createdAt"],
        "updated_at": node["updatedAt"],
        "thread_node_id": thread.get("id"),
        "thread_resolved": thread.get("isResolved"),
        "thread_outdated": thread.get("isOutdated"),
        "graphql": node,
    }


def graphql_commit_to_row(node: dict[str, Any]) -> dict[str, Any]:
    commit = node["commit"]
    author = commit.get("author") or {}
    committer = commit.get("committer") or {}
    return {
        "sha": commit["oid"],
        "node_id": node["id"],
        "author": login_object((author.get("user") or {})),
        "committer": login_object((committer.get("user") or {})),
        "commit": {
            "author": {"name": author.get("name"), "date": author.get("date")},
            "committer": {"name": committer.get("name"), "date": committer.get("date")},
        },
        "graphql": node,
    }


def graphql_timeline_to_row(node: dict[str, Any], index: int) -> dict[str, Any]:
    event_type = graphql_event_name(str(node["__typename"]))
    row = {
        "id": None,
        "node_id": node.get("id"),
        "event": event_type,
        "actor": login_object(node.get("actor")),
        "created_at": node.get("createdAt"),
        "_datastore_timeline_index": index,
        "graphql": node,
    }
    if node.get("assignee"):
        row["assignee"] = login_object(node["assignee"])
    if node.get("requestedReviewer"):
        reviewer = node["requestedReviewer"]
        if explicit_login(reviewer):
            row["requested_reviewer"] = login_object(reviewer)
        else:
            row["requested_team"] = {"slug": reviewer.get("slug"), "name": reviewer.get("name")}
    return row


def graphql_event_name(type_name: str) -> str:
    chars: list[str] = []
    for index, char in enumerate(type_name):
        if char.isupper() and index > 0:
            chars.append("_")
        chars.append(char.lower())
    event = "".join(chars)
    return event.removesuffix("_event")


def required_id(node: dict[str, Any], label: str) -> int | str:
    raw = node.get("databaseId") or node.get("fullDatabaseId")
    if raw is None:
        raise GitHubApiError(f"{label} lacks GraphQL database id: {node.get('id')}")
    return raw


def complete_assignees(node: dict[str, Any]) -> list[dict[str, Any]]:
    assignees = node["assignees"]
    if assignees["pageInfo"]["hasNextPage"]:
        raise GitHubApiError(f"item has >100 assignees and cannot be represented exactly: {node['id']}")
    return assignees["nodes"]


def explicit_login(node: dict[str, Any] | None) -> str | None:
    if not isinstance(node, dict):
        return None
    login = node.get("login")
    return str(login) if login else None


def login_object(node: dict[str, Any] | None) -> dict[str, Any] | None:
    login = explicit_login(node)
    if login is None:
        return None
    value = {"login": login}
    if node and node.get("avatarUrl"):
        value["avatar_url"] = str(node["avatarUrl"])
    return value


def dedupe_by_id(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[tuple[str, int]] = set()
    deduped: list[dict[str, Any]] = []
    for row in rows:
        key = (row["node_id"], row["id"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(row)
    return deduped
