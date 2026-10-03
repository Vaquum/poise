from typing import Any

from github_interface.client import GitHubClient


async def list_org_repos(client: GitHubClient, org: str) -> list[dict[str, Any]]:
    # Organization callers keep their full REST objects. Personal accounts
    # have no previous successful contract: GraphQL includes all accessible
    # owned repositories, including private ones owned by another user.
    query = """
    query($org: String!, $cursor: String) {
      repositoryOwner(login: $org) {
        __typename
        login
        ... on User {
          repositories(first: 100, after: $cursor, ownerAffiliations: [OWNER]) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes {
              databaseId id name nameWithOwner url description
              isPrivate isArchived isFork hasIssuesEnabled
              defaultBranchRef { name }
              owner { login __typename }
            }
          }
        }
      }
    }
    """
    repos: list[dict[str, Any]] = []
    cursor: str | None = None
    cursors: set[str] = set()
    expected_count: int | None = None
    while True:
        data = await client.graphql(query, {"org": org, "cursor": cursor})
        owner = data.get("repositoryOwner")
        if owner is None:
            raise RuntimeError(f"repository owner not found or inaccessible: {org}")
        owner_type = owner.get("__typename")
        if owner_type not in ("User", "Organization") or str(owner.get("login", "")).casefold() != org.casefold():
            raise RuntimeError(f"repository owner does not match requested account: {org}")
        if owner_type == "Organization":
            if cursor is not None:
                raise RuntimeError(f"repository owner type changed while listing {org}")
            repos = await client.paginate(f"/orgs/{org}/repos", params={"type": "all"})
            break
        connection = owner["repositories"]
        count = connection.get("totalCount")
        if type(count) is not int or count < 0:
            raise RuntimeError(f"invalid repository totalCount for {org}")
        if expected_count is not None and count != expected_count:
            raise RuntimeError(f"repository totalCount changed while listing {org}")
        expected_count = count
        for node in connection["nodes"]:
            repos.append({
                "id": node["databaseId"],
                "node_id": node["id"],
                "name": node["name"],
                "full_name": node["nameWithOwner"],
                "html_url": node["url"],
                "description": node["description"],
                "private": node["isPrivate"],
                "archived": node["isArchived"],
                "fork": node["isFork"],
                "has_issues": node["hasIssuesEnabled"],
                "default_branch": node["defaultBranchRef"]["name"] if node["defaultBranchRef"] else None,
                "owner": {"login": node["owner"]["login"], "type": node["owner"]["__typename"]},
            })
        page = connection["pageInfo"]
        if not page["hasNextPage"]:
            break
        next_cursor = page.get("endCursor")
        if not isinstance(next_cursor, str) or not next_cursor or next_cursor in cursors:
            raise RuntimeError(f"non-advancing repository page cursor for {org}")
        cursors.add(next_cursor)
        cursor = next_cursor
    if expected_count is not None and len(repos) != expected_count:
        raise RuntimeError(f"incomplete repository enumeration for {org}: expected {expected_count}, got {len(repos)}")
    seen_ids: set[int] = set()
    for repo in repos:
        full_name = str(repo.get("full_name", ""))
        if str(repo.get("owner", {}).get("login", "")).casefold() != org.casefold() or full_name.partition("/")[0].casefold() != org.casefold() or not full_name.partition("/")[2]:
            raise RuntimeError(f"repository outside requested owner {org}: {full_name}")
        repo_id = repo["id"]
        if repo_id in seen_ids:
            raise RuntimeError(f"duplicate repo ids returned for owner {org}")
        seen_ids.add(repo_id)
    return repos
