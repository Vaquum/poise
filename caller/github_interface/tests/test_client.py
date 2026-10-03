from typing import Any, Self
from unittest import IsolatedAsyncioTestCase
from unittest.mock import patch

import httpx
from github_interface.client import GitHubClient

from github_interface import client as client_module


def _response(status_code: int, payload: dict[str, Any] | None = None, text: str | None = None) -> httpx.Response:
    request = httpx.Request("GET", "https://api.github.com/test")
    if text is not None:
        return httpx.Response(status_code, text=text, request=request)
    return httpx.Response(status_code, json=payload if payload is not None else {}, request=request)


class FakeAsyncClient:
    def __init__(self, script: list[Any], calls: list[Any], **kwargs: Any):
        self._script = script
        self._calls = calls

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *exc: object) -> bool:
        return False

    async def request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        self._calls.append((method, path, kwargs))
        step = self._script.pop(0)
        if isinstance(step, Exception):
            raise step
        return step


class TestClientRetrySemantics(IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.calls: list[Any] = []
        self.script: list[Any] = []
        self.enterContext(patch.object(client_module, "get_token", return_value="test-token"))
        self.enterContext(patch.object(client_module, "_RETRY_DELAY_SECONDS", 0))
        self.enterContext(
            patch.object(
                client_module.httpx,
                "AsyncClient",
                lambda **kwargs: FakeAsyncClient(self.script, self.calls, **kwargs),
            )
        )
        self.client = GitHubClient()

    async def test_get_retries_once_after_transport_error(self) -> None:
        self.script.extend([httpx.ConnectError("boom"), _response(200, {"ok": True})])

        self.assertEqual(await self.client.get("/repos/o/r/pulls/1"), {"ok": True})
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.calls[0][:2], self.calls[1][:2])

    async def test_get_retries_once_after_transient_status(self) -> None:
        self.script.extend([_response(502), _response(200, {"ok": True})])

        self.assertEqual(await self.client.get("/repos/o/r/pulls/1"), {"ok": True})
        self.assertEqual(len(self.calls), 2)

    async def test_get_transport_retry_is_bounded_to_two_attempts(self) -> None:
        self.script.extend([httpx.ConnectError("one"), httpx.ConnectError("two"), _response(200)])

        with self.assertRaises(httpx.TransportError):
            await self.client.get("/repos/o/r/pulls/1")
        self.assertEqual(len(self.calls), 2)

    async def test_get_transient_status_retry_is_bounded_to_two_attempts(self) -> None:
        self.script.extend([_response(503), _response(503), _response(200)])

        with self.assertRaises(RuntimeError) as raised:
            await self.client.get("/repos/o/r/pulls/1")
        self.assertIn("503", str(raised.exception))
        self.assertEqual(len(self.calls), 2)

    async def test_get_does_not_retry_non_transient_status(self) -> None:
        self.script.extend([_response(404), _response(200)])

        with self.assertRaises(RuntimeError):
            await self.client.get("/repos/o/r/pulls/1")
        self.assertEqual(len(self.calls), 1)

    async def test_get_text_retries_once_after_transient_status(self) -> None:
        self.script.extend([_response(504), _response(200, text="log line")])

        text = await self.client.get_text("/repos/o/r/actions/jobs/1/logs", "text/plain")
        self.assertEqual(text, "log line")
        self.assertEqual(len(self.calls), 2)

    async def test_post_is_single_attempt_on_transport_error(self) -> None:
        self.script.extend([httpx.ConnectError("boom"), _response(200)])

        with self.assertRaises(httpx.TransportError):
            await self.client.post("/repos/o/r/pulls/1/reviews", json={"event": "APPROVE"})
        self.assertEqual(len(self.calls), 1)

    async def test_post_is_single_attempt_on_transient_status(self) -> None:
        self.script.extend([_response(502), _response(200)])

        with self.assertRaises(RuntimeError):
            await self.client.post("/repos/o/r/pulls/1/reviews", json={"event": "APPROVE"})
        self.assertEqual(len(self.calls), 1)

    async def test_patch_is_single_attempt_on_transient_status(self) -> None:
        self.script.extend([_response(502), _response(200)])

        with self.assertRaises(RuntimeError):
            await self.client.patch("/repos/o/r/pulls/1", json={"state": "closed"})
        self.assertEqual(len(self.calls), 1)

    async def test_graphql_query_retries_with_identical_body(self) -> None:
        self.script.extend([httpx.ConnectError("boom"), _response(200, {"data": {"ok": 1}})])

        data = await self.client.graphql("query($n: Int!) { x }", {"n": 1})
        self.assertEqual(data, {"ok": 1})
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.calls[0][2]["json"], self.calls[1][2]["json"])

    async def test_graphql_mutation_is_single_attempt(self) -> None:
        self.script.extend([httpx.ConnectError("boom"), _response(200, {"data": {}})])

        with self.assertRaises(httpx.TransportError):
            await self.client.graphql("mutation($id: ID!) { x }", {"id": "1"})
        self.assertEqual(len(self.calls), 1)
