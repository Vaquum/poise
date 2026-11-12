import json
import os
import subprocess
import sys
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from unittest.mock import call, patch

import httpx

from github_datastore.github_api import (
    GitHubApiError,
    GitHubClient,
    GitHubRateLimitError,
    _github_proxy,
    datastore_github_client,
)


ENV = {"GH_HOST": "github.com", "GH_TOKEN": "fixture-token", "NO_PROXY": "*"}
QUERY = "query { viewer { login } }"
DATA = {"viewer": {"login": "fixture"}}
NO_CONFIG = subprocess.CompletedProcess(["gh"], 0, stdout="", stderr="")


class PooledGraphQLTest(unittest.TestCase):
    def test_proxy_selection_matches_gh_for_the_github_endpoint(self) -> None:
        self.assertIsNone(_github_proxy({"ALL_PROXY": "http://alternate:3128", "HTTP_PROXY": "http://other:3128"}))
        environment = {"HTTPS_PROXY": "fixture:3128", "https_proxy": "http://alternate:3128"}
        for bypass in ("*", ".github.com", "*.github.com", "GITHUB.COM", "api.github.com:443"):
            with self.subTest(bypass=bypass):
                self.assertIsNone(_github_proxy({**environment, "NO_PROXY": bypass}))
        for entry in ("other.com", ".api.github.com", "api.github.com:444", "bapi.github.com"):
            with self.subTest(entry=entry):
                self.assertEqual(_github_proxy({**environment, "NO_PROXY": entry}), "http://fixture:3128")

    def test_configured_datastore_reuses_a_socket_and_preserves_request_values(self) -> None:
        seen = []

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_):
                pass

            def do_POST(self):
                seen.append((self.client_address, self.path, self.headers.get("Authorization"),
                             self.headers.get("Cookie"), json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                body = json.dumps({"data": DATA}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Set-Cookie", "unwanted=value; Path=/")
                self.end_headers()
                self.wfile.write(body)

        with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            url = f"http://127.0.0.1:{server.server_port}/graphql"
            try:
                with patch.dict(os.environ, ENV, clear=True), \
                        patch("github_datastore.github_api._GITHUB_GRAPHQL_URL", url), \
                        patch("github_datastore.github_api.subprocess.run", return_value=NO_CONFIG) as gh, \
                        datastore_github_client() as client:
                    for name in ("001", "null", "@file"):
                        self.assertEqual(client.graphql(QUERY, {"name": name, "number": 17, "cursor": None}), DATA)
                        os.environ["GH_TOKEN"] = "different-token"
            finally:
                server.shutdown()
                thread.join()

        self.assertEqual([request.args[0][1:4] for request in gh.call_args_list],
                         [["config", "get", "http_unix_socket"], ["config", "get", "api_host"]])
        self.assertEqual(len({address for address, *_ in seen}), 1)
        self.assertEqual(
            [request[1:] for request in seen],
            [("/graphql", "token fixture-token", None, {"query": QUERY, "variables": {"name": name, "number": 17}})
             for name in ("001", "null", "@file")],
        )

    def test_explicit_gh_socket_configuration_keeps_the_cli_route(self) -> None:
        socket = subprocess.CompletedProcess(["gh"], 0, stdout="/tmp/fixture.sock\n", stderr="")
        page = subprocess.CompletedProcess(["gh"], 0, stdout=json.dumps({"data": DATA}), stderr="")
        with patch.dict(os.environ, ENV, clear=True), \
                patch("github_datastore.github_api.subprocess.run", side_effect=[socket, page]) as gh, \
                datastore_github_client() as client:
            self.assertEqual(client.graphql(QUERY), DATA)
        self.assertEqual([request.args[0][1] for request in gh.call_args_list], ["config", "api"])

    def test_missing_httpx_imports_and_keeps_the_cli_route(self) -> None:
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        script = (f"import sys; sys.modules['httpx'] = None; sys.path.insert(0, {root!r}); "
                  "import github_datastore.github_api as api; print(hasattr(api, 'GitHubClient'))")
        proc = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True)
        self.assertEqual(proc.stdout.strip(), "True", proc.stderr)
        with patch.dict(os.environ, ENV, clear=True), \
                patch.dict(sys.modules, {"httpx": None}), \
                patch("github_datastore.github_api.subprocess.run", return_value=NO_CONFIG), \
                datastore_github_client() as client:
            self.assertIsNone(client._http)

    def test_disconnect_and_503_retry_the_same_token_and_request(self) -> None:
        requests = []

        def reply(request):
            requests.append((request.content, request.headers["Authorization"]))
            if len(requests) == 1:
                os.environ["GH_TOKEN"] = "different-token"
                raise httpx.RemoteProtocolError("peer closed before the response", request=request)
            if len(requests) == 2:
                return httpx.Response(503, json={"message": "temporarily unavailable"})
            return httpx.Response(200, json={"data": DATA})

        with patch.dict(os.environ, ENV, clear=True), \
                httpx.Client(transport=httpx.MockTransport(reply)) as http, \
                patch("github_datastore.github_api.time.sleep") as sleep:
            self.assertEqual(GitHubClient(http=http).graphql(QUERY), DATA)
        self.assertEqual(requests, [requests[0]] * 3)
        self.assertEqual(requests[0][1], "token fixture-token")
        self.assertEqual(sleep.call_args_list, [call(1), call(1)])

    def test_incomplete_json_retries_then_recovers_or_reports_the_cutoff(self) -> None:
        for body in [b'{"data":', b'{"data":nul', b'{"data":"part', b'{"data":"\xc3']:
            with self.subTest(body=body), patch.dict(os.environ, ENV, clear=True):
                for succeeds in (True, False):
                    calls = []

                    def reply(request):
                        calls.append(request.content)
                        if succeeds and len(calls) == 2:
                            return httpx.Response(200, json={"data": DATA})
                        return httpx.Response(200, content=body)

                    with httpx.Client(transport=httpx.MockTransport(reply)) as http, \
                            patch("github_datastore.github_api.time.sleep") as sleep:
                        client = GitHubClient(http=http)
                        if succeeds:
                            self.assertEqual(client.graphql(QUERY), DATA)
                        else:
                            with self.assertRaisesRegex(GitHubApiError, "unexpected end of JSON input:"):
                                client.graphql(QUERY)
                    count = 2 if succeeds else 5
                    self.assertEqual(calls, [calls[0]] * count)
                    self.assertEqual(sleep.call_args_list, [call(1)] * (count - 1))

    def test_invalid_json_fails_without_retry(self) -> None:
        def reply(_request):
            return httpx.Response(200, content=b'{"data": invalid}')

        with patch.dict(os.environ, ENV, clear=True), \
                httpx.Client(transport=httpx.MockTransport(reply)) as http, \
                patch("github_datastore.github_api.time.sleep") as sleep:
            with self.assertRaises(json.JSONDecodeError):
                GitHubClient(http=http).graphql(QUERY)
        sleep.assert_not_called()

    def test_rate_limit_stops_requests_and_denials_do_not_retry(self) -> None:
        for status, payload, error in [
            (403, {"message": "API rate limit exceeded for user"}, GitHubRateLimitError),
            (200, {"errors": [{"type": "RATE_LIMITED"}]}, GitHubRateLimitError),
            (403, {"message": "Resource not accessible"}, GitHubApiError),
            (200, {"errors": [{"message": "Cannot query field 'bad'"}], "data": DATA}, GitHubApiError),
        ]:
            with self.subTest(status=status, payload=payload):
                calls = []

                def reply(request):
                    calls.append(request)
                    return httpx.Response(status, json=payload,
                                          headers={"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "2000000000"})

                with patch.dict(os.environ, ENV, clear=True), \
                        httpx.Client(transport=httpx.MockTransport(reply)) as http, \
                        patch("github_datastore.github_api.time.sleep") as sleep, \
                        patch("github_datastore.github_api.time.time", return_value=1999999999):
                    client = GitHubClient(http=http)
                    with self.assertRaises(error) as caught:
                        client.graphql(QUERY)
                    self.assertIs(type(caught.exception), error)
                    if error is GitHubRateLimitError:
                        self.assertIn("GITHUB_RATE_LIMIT_RESET=2000000000", str(caught.exception))
                        with self.assertRaises(GitHubRateLimitError):
                            client.graphql(QUERY)
                self.assertEqual(len(calls), 1)
                sleep.assert_not_called()
