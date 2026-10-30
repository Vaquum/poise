"""Compare identical first-page activity payloads and actual GitHub point costs."""

import argparse
import asyncio
import json

from github_interface.atoms.pulls import (
    REVIEW_ACTIVITY_FIELDS,
    REVIEW_ACTIVITY_QUERY,
    REVIEW_REQUEST_FIELDS,
    REVIEW_THREAD_FIELDS,
)
from github_interface.client import GitHubClient


async def measure(args):
    owner, repo = args.repository.split("/")
    client = GitHubClient(args.token_user)
    variables = {"owner": owner, "repo": repo, "number": args.pr}

    async def read(query):
        query = query.rstrip()
        data = await client.graphql(query[:-1] + " rateLimit { cost } }", variables)
        cost = data["rateLimit"]["cost"]
        if type(cost) is not int or cost < 1:
            raise RuntimeError("GitHub returned no valid point cost")
        return data["repository"]["pullRequest"], cost

    combined, after = await read(REVIEW_ACTIVITY_QUERY)
    before = 0
    for connection, fields in (
        ("reviewRequests", REVIEW_REQUEST_FIELDS),
        ("reviews", REVIEW_ACTIVITY_FIELDS),
        ("reviewThreads", REVIEW_THREAD_FIELDS),
    ):
        query = f"""query($owner: String!, $repo: String!, $number: Int!) {{
          repository(owner: $owner, name: $repo) {{ pullRequest(number: $number) {{
            state isDraft headRefOid updatedAt
            {connection}(first: 100) {{
              pageInfo {{ hasNextPage endCursor }} nodes {{ {fields} }}
            }}
          }} }}
        }}"""
        separate, cost = await read(query)
        before += cost
        if any(separate[key] != combined[key] for key in ("state", "isDraft", "headRefOid", "updatedAt", connection)):
            raise RuntimeError(f"Live {connection} payloads differ; point-reduction proof is inconclusive")
        if combined[connection]["pageInfo"]["hasNextPage"]:
            raise RuntimeError("Choose a PR with single-page activity for this bounded four-call proof")
    if after >= before:
        raise RuntimeError(f"GraphQL point cost did not decrease: {before} to {after}")
    print(json.dumps({"repository": args.repository, "pull_number": args.pr,
                      "identical_page_payloads": True, "individual_requests": 3, "combined_requests": 1,
                      "individual_points": before, "combined_points": after,
                      "total_measurement_points": before + after}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--token-user", required=True, help="Explicit signed-in gh account")
    parser.add_argument("--repository", default="autonomio/poise")
    parser.add_argument("--pr", type=int, required=True)
    args = parser.parse_args()
    if len(args.repository.split("/")) != 2 or not all(args.repository.split("/")) or args.pr < 1:
        parser.error("provide owner/repo and a positive PR number")
    asyncio.run(measure(args))


if __name__ == "__main__":
    main()
