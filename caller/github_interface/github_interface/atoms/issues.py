from typing import Any

from github_interface.client import GitHubClient


async def create_issue(client: GitHubClient, owner: str, repo: str, title: str, body: str) -> dict[str, Any]:
    return await client.post(f"/repos/{owner}/{repo}/issues", json={"title": title, "body": body})


async def read_issue(client: GitHubClient, owner: str, repo: str, issue_number: int) -> dict[str, Any]:
    return await client.get(f"/repos/{owner}/{repo}/issues/{issue_number}")


async def assign_issue(
    client: GitHubClient,
    owner: str,
    repo: str,
    issue_number: int,
    assignees: list[str],
) -> dict[str, Any]:
    return await client.post(
        f"/repos/{owner}/{repo}/issues/{issue_number}/assignees",
        json={"assignees": assignees},
    )


async def comment_issue(client: GitHubClient, owner: str, repo: str, issue_number: int, body: str) -> dict[str, Any]:
    return await client.post(f"/repos/{owner}/{repo}/issues/{issue_number}/comments", json={"body": body})


async def issue_comments(client: GitHubClient, owner: str, repo: str, issue_number: int) -> list[dict[str, Any]]:
    return await client.paginate(f"/repos/{owner}/{repo}/issues/{issue_number}/comments")


async def sub_issues(client: GitHubClient, owner: str, repo: str, issue_number: int) -> list[dict[str, Any]]:
    return await client.paginate(f"/repos/{owner}/{repo}/issues/{issue_number}/sub_issues")


async def edit_issue_body(client: GitHubClient, owner: str, repo: str, issue_number: int, body: str) -> dict[str, Any]:
    return await client.patch(f"/repos/{owner}/{repo}/issues/{issue_number}", json={"body": body})


async def edit_issue_comment(client: GitHubClient, owner: str, repo: str, comment_id: int, body: str) -> dict[str, Any]:
    return await client.patch(f"/repos/{owner}/{repo}/issues/comments/{comment_id}", json={"body": body})


async def linked_issues(client: GitHubClient, owner: str, repo: str, pull_number: int) -> list[dict[str, Any]]:
    url = f"https://github.com/{owner}/{repo}/pull/{pull_number}"
    data = await client.get("/search/issues", params={"q": f'repo:{owner}/{repo} type:issue in:body "{url}"'})
    return data["items"]
