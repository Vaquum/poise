import asyncio
from typing import Any, NoReturn

import httpx

from .token import get_token


# Headers GitHub returns on 403/429 that tell you *why* the request was
# rejected. Without them in the surfaced error the failure looks like
# generic "API rate limit exceeded" prose and you can't tell:
#   - primary quota hit (X-RateLimit-Remaining: 0, X-RateLimit-Used near limit)
#   - secondary / burst-detection throttle (Retry-After present)
#   - which bucket fired (X-RateLimit-Resource = core | graphql | search | …)
# Surfacing them lets the caller diagnose the cause from the error
# message alone — no inference, no log-tailing.
_RATE_LIMIT_HEADERS = (
    "x-ratelimit-resource",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-used",
    "x-ratelimit-reset",
    "retry-after",
)
_TRANSIENT_STATUS_CODES = {502, 503, 504}
_READ_ATTEMPTS = 2
_RETRY_DELAY_SECONDS = 0.25
_TIMEOUT_SECONDS = 10.0


def _raise_for_response(response: httpx.Response, error: httpx.HTTPStatusError) -> NoReturn:
    """Re-raise as RuntimeError, attaching rate-limit headers on 403/429.

    Non-rate-limit errors fall through to the existing minimal format so
    the change is invisible to callers that already match on body text.
    """
    if response.status_code in (403, 429):
        rl = {h: response.headers.get(h) for h in _RATE_LIMIT_HEADERS if response.headers.get(h) is not None}
        if rl:
            raise RuntimeError(
                f"GitHub {response.status_code} rate-limit: {rl} body={response.text}"
            ) from error
    raise RuntimeError(f"GitHub {response.status_code}: {response.text}") from error


class GitHubClient:
    def __init__(self, user: str | None = None, base_url: str = "https://api.github.com") -> None:
        self.token = get_token(user)
        self.base_url = base_url.rstrip("/")

    async def _request(
        self,
        method: str,
        path: str,
        headers: dict[str, str],
        retry_transient: bool,
        follow_redirects: bool,
        **kwargs: Any,
    ) -> httpx.Response:
        attempts = _READ_ATTEMPTS if retry_transient else 1
        async with httpx.AsyncClient(
            base_url=self.base_url,
            headers=headers,
            follow_redirects=follow_redirects,
            timeout=_TIMEOUT_SECONDS,
        ) as client:
            for attempt in range(attempts):
                try:
                    response = await client.request(method, path, **kwargs)
                    if response.status_code not in _TRANSIENT_STATUS_CODES:
                        return response
                except httpx.TransportError:
                    if attempt + 1 == attempts:
                        raise
                if attempt + 1 < attempts:
                    await asyncio.sleep(_RETRY_DELAY_SECONDS)
            return response

    async def request(
        self,
        method: str,
        path: str,
        *,
        retry_transient: bool = False,
        **kwargs: Any,
    ) -> Any:
        headers = kwargs.pop("headers", {})
        headers["Authorization"] = f"Bearer {self.token}"
        headers["Accept"] = "application/vnd.github+json"
        headers["X-GitHub-Api-Version"] = "2022-11-28"

        response = await self._request(
            method,
            path,
            headers,
            retry_transient,
            True,
            **kwargs,
        )
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as error:
            _raise_for_response(response, error)
        if response.content:
            return response.json()
        return None

    async def request_text(self, method: str, path: str, accept: str, **kwargs: Any) -> str:
        headers = kwargs.pop("headers", {})
        headers["Authorization"] = f"Bearer {self.token}"
        headers["Accept"] = accept
        headers["X-GitHub-Api-Version"] = "2022-11-28"

        response = await self._request(
            method,
            path,
            headers,
            method.upper() == "GET",
            False,
            **kwargs,
        )
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as error:
            _raise_for_response(response, error)
        return response.text

    async def get(self, path: str, **kwargs: Any) -> Any:
        return await self.request("GET", path, retry_transient=True, **kwargs)

    async def get_text(self, path: str, accept: str, **kwargs: Any) -> str:
        return await self.request_text("GET", path, accept, **kwargs)

    async def post(self, path: str, **kwargs: Any) -> Any:
        return await self.request("POST", path, **kwargs)

    async def patch(self, path: str, **kwargs: Any) -> Any:
        return await self.request("PATCH", path, **kwargs)

    async def graphql(self, query: str, variables: dict[str, Any]) -> Any:
        response = await self.request(
            "POST",
            "/graphql",
            retry_transient=query.lstrip().startswith("query"),
            json={"query": query, "variables": variables},
        )
        if response.get("errors"):
            raise RuntimeError(response["errors"])
        return response["data"]

    async def paginate(self, path: str, params: dict[str, Any] | None = None) -> list[Any]:
        items = []
        page = 1
        params = dict(params or {})

        while True:
            page_params = {**params, "per_page": 100, "page": page}
            batch = await self.get(path, params=page_params)
            if not batch:
                return items
            items.extend(batch)
            if len(batch) < 100:
                return items
            page += 1
