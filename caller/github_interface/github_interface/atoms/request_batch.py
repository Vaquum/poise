import asyncio
import re
from collections.abc import Awaitable, Callable
from typing import Any

from github_interface.client import GitHubClient

MAX_REQUESTS = 50
# One client's reads run together; a small bound keeps one slow pull request
# from stalling the batch while sharing the process and its connection setup.
BATCH_CONCURRENCY = 5
# Each record settles on its own budget: a hung read becomes that record's
# error instead of killing the batch envelope with every completed sibling.
# Ten requests over five workers settle in two waves, inside the enclosing
# 30 s CLI budget with interpreter startup to spare.
REQUEST_TIMEOUT = 10


def read_requests(payload: dict[str, Any], extra: tuple[str, ...] = ()) -> list[dict[str, Any]]:
    requests = payload.get("requests")
    if not isinstance(requests, list) or len(requests) > MAX_REQUESTS:
        raise ValueError("requests must be a list of at most 50 pull requests")
    keys = {"repository", "number", *extra}
    seen = set()
    for request in requests:
        if (not isinstance(request, dict) or set(request) != keys
                or not isinstance(request["repository"], str)
                or not re.fullmatch(r"[^/\s]+/[^/\s]+", request["repository"])
                or type(request["number"]) is not int or request["number"] < 1):
            raise ValueError("each request must name an owner/repo repository and positive integer number")
        target = (request["repository"].lower(), request["number"])
        if target in seen:
            raise ValueError("duplicate pull request in requests")
        seen.add(target)
    return requests


async def run_batch(
    client: GitHubClient,
    requests: list[dict[str, Any]],
    read: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]],
) -> list[dict[str, Any]]:
    """Run one read per request on the shared client, in request order.

    One pull request's failure is that record's error, never the batch's:
    the sweep holds only that target's check instead of losing every read.
    """
    semaphore = asyncio.Semaphore(BATCH_CONCURRENCY)

    async def guarded(request: dict[str, Any]) -> dict[str, Any]:
        async with semaphore:
            try:
                return {**await asyncio.wait_for(read(request), REQUEST_TIMEOUT), "error": None}
            except TimeoutError:
                return {
                    "repository": request["repository"],
                    "pull_number": request["number"],
                    "error": f"request timed out after {REQUEST_TIMEOUT} seconds",
                }
            except Exception as error:
                message = str(error).strip() or type(error).__name__
                return {"repository": request["repository"], "pull_number": request["number"], "error": message}

    return list(await asyncio.gather(*(guarded(request) for request in requests)))
