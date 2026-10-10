"""Compare equivalent live continuation pages and GitHub's reported point costs."""

from __future__ import annotations

import argparse
import json
import os
import subprocess

from github_datastore.github_api import GitHubClient, PULL_STUB_FIELDS, split_full_name


def page_selection(index: int, *, continuation: bool) -> str:
    after = f", after: $cursor{index}" if continuation else ""
    return f"""
      page_{index}: repository(owner: $owner{index}, name: $name{index}) {{
        nameWithOwner
        pullRequests(first: 100{after}, states: [OPEN, CLOSED, MERGED],
                     orderBy: {{field: CREATED_AT, direction: ASC}}) {{
          totalCount
          pageInfo {{ hasNextPage endCursor }}
          nodes {{ {PULL_STUB_FIELDS} }}
        }}
      }}
    """


def read_pages(client: GitHubClient, repos: list[str], cursors: list[str] | None = None) -> dict:
    declarations = []
    variables = {}
    selections = []
    for index, full_name in enumerate(repos):
        owner, name = split_full_name(full_name)
        declarations.extend([f"$owner{index}: String!", f"$name{index}: String!"])
        variables.update({f"owner{index}": owner, f"name{index}": name})
        if cursors is not None:
            declarations.append(f"$cursor{index}: String!")
            variables[f"cursor{index}"] = cursors[index]
        selections.append(page_selection(index, continuation=cursors is not None))
    query = (
        "query(" + ", ".join(declarations) + ") {"
        + "".join(selections) + "rateLimit { cost } }"
    )
    return client.graphql(query, variables)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repos", nargs=2, default=["cli/cli", "microsoft/vscode"])
    parser.add_argument("--token-user", help="Explicit gh account when GH_TOKEN is unset")
    args = parser.parse_args()
    if not os.environ.get("GH_TOKEN", "").strip():
        if not args.token_user:
            parser.error("set GH_TOKEN or provide --token-user; an implicit active account is not used")
        credential = subprocess.run(
            ["gh", "auth", "token", "--hostname", "github.com", "--user", args.token_user],
            capture_output=True, text=True, check=False,
        )
        if credential.returncode or not credential.stdout.strip():
            raise RuntimeError("the explicitly selected gh account has no available credential")
        os.environ["GH_TOKEN"] = credential.stdout.strip()

    client = GitHubClient(attempts=1)
    first = read_pages(client, args.repos)
    cursors = []
    for index in range(2):
        info = first[f"page_{index}"]["pullRequests"]["pageInfo"]
        if not info["hasNextPage"] or not info["endCursor"]:
            raise RuntimeError("both repositories must have a real continuation page")
        cursors.append(info["endCursor"])

    individual = [read_pages(client, [repo], [cursor]) for repo, cursor in zip(args.repos, cursors)]
    batched = read_pages(client, args.repos, cursors)
    for index, previous in enumerate(individual):
        if previous["page_0"] != batched[f"page_{index}"]:
            raise RuntimeError("live page payloads differ; point-reduction proof is inconclusive")

    before = sum(result["rateLimit"]["cost"] for result in individual)
    after = batched["rateLimit"]["cost"]
    if after >= before:
        raise RuntimeError(f"GraphQL points did not decrease: {before} to {after}")
    print(json.dumps({
        "repositories": args.repos,
        "identical_page_payloads": True,
        "records_compared": sum(len(result["page_0"]["pullRequests"]["nodes"]) for result in individual),
        "individual_requests": len(individual),
        "batched_requests": 1,
        "individual_points": before,
        "batched_points": after,
        "total_measurement_points": first["rateLimit"]["cost"] + before + after,
    }, indent=2))


if __name__ == "__main__":
    main()
