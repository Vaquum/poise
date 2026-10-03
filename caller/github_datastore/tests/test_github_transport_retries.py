import json
import os
import subprocess
import unittest
from unittest.mock import call, patch

from github_datastore.github_api import GitHubApiError, GitHubClient


QUERY = "query($org: String!) { organization(login: $org) { login } }"
VARIABLES = {"org": "Autonomio", "count": 100, "cursor": None}
DATA = {"organization": {"login": "Autonomio"}}


def failed(message: str) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(["gh"], 1, stdout="", stderr=message)


def succeeded() -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(["gh"], 0, stdout=json.dumps({"data": DATA}), stderr="")


class GitHubTransportRetryTest(unittest.TestCase):
    def test_string_variables_are_not_coerced_by_gh(self) -> None:
        query = "query($name: String!, $number: Int!, $cursor: String) { viewer { login } }"
        for name in ("33", "001", "true", "false", "null", "@repo-name", "{repo}"):
            with self.subTest(name=name):
                with patch("github_datastore.github_api.subprocess.run", return_value=succeeded()) as run:
                    self.assertEqual(GitHubClient().graphql(query, {"name": name, "number": 17, "cursor": None}), DATA)
                run.assert_called_once()
                self.assertEqual(run.call_args.args[0], [
                    "gh", "api", "graphql", "--include", "-f", f"query={query}",
                    "-f", f"name={name}", "-F", "number=17",
                ])

    def test_transient_transport_failures_retry_the_same_request(self) -> None:
        errors = [
            "Post https://github.example/graphql: unexpected EOF",
            "read tcp 172.20.10.6:54013->140.82.121.6:443: read: can't assign requested address",
            "read tcp 172.20.10.6:54031->140.82.121.6:443: cannot assign requested address",
            "write tcp 172.20.10.6:54041->140.82.121.6:443: write: broken pipe",
            "dial tcp [fd00:403::1]:443: no route to host",
            "read tcp 172.20.10.6:51526->140.82.121.6:443: EOF",
        ]
        expected_args = [
            "gh", "api", "graphql", "--include", "-f", f"query={QUERY}",
            "-f", "org=Autonomio", "-F", "count=100",
        ]
        environment = {"GH_TOKEN": "selected-test-credential", "GH_HOST": "github.com"}
        for error in errors:
            with self.subTest(error=error), patch.dict(os.environ, environment, clear=True):
                with patch("github_datastore.github_api.subprocess.run", side_effect=[failed(error), succeeded()]) as run:
                    with patch("github_datastore.github_api.time.sleep") as sleep:
                        self.assertEqual(GitHubClient().graphql(QUERY, VARIABLES), DATA)
                self.assertEqual(run.call_count, 2)
                self.assertEqual(run.call_args_list, [
                    call(expected_args, capture_output=True, text=True, env=environment),
                    call(expected_args, capture_output=True, text=True, env=environment),
                ])
                sleep.assert_called_once_with(1)

    def test_environment_is_pinned_across_retries(self) -> None:
        def first_failure(*args, **kwargs):
            os.environ["GH_TOKEN"] = "another-test-credential"
            return failed("unexpected EOF")

        environment = {"GH_TOKEN": "selected-test-credential"}
        with patch.dict(os.environ, environment, clear=True):
            with patch("github_datastore.github_api.subprocess.run", side_effect=first_failure) as run:
                with patch("github_datastore.github_api.time.sleep"):
                    with self.assertRaisesRegex(GitHubApiError, "unexpected EOF"):
                        GitHubClient(attempts=2).graphql(QUERY, VARIABLES)
                self.assertEqual(run.call_count, 2)
                for request in run.call_args_list:
                    self.assertEqual(request.kwargs["env"], environment)

    def test_exhausted_retries_raise_the_original_transport_diagnostic(self) -> None:
        error = "Post https://github.example/graphql: unexpected EOF"
        with patch("github_datastore.github_api.subprocess.run", return_value=failed(error)) as run:
            with patch("github_datastore.github_api.time.sleep") as sleep:
                with self.assertRaises(GitHubApiError) as raised:
                    GitHubClient().graphql(QUERY, VARIABLES)
        self.assertEqual(str(raised.exception), f"GraphQL request failed: {error}")
        self.assertEqual(run.call_count, 5)
        self.assertEqual(sleep.call_args_list, [call(1)] * 4)

    def test_auth_access_and_validation_errors_fail_without_retries(self) -> None:
        errors = [
            "gh: Bad credentials (HTTP 401); connection closed",
            "gh: Resource not accessible (HTTP 403); unexpected EOF",
            "gh: Not Found (HTTP 404); read tcp 172.20.10.6:50000->140.82.121.6:443",
            "HTTP/2 403 Forbidden; network error",
            "Field 'network' does not exist",
            "Cannot query field 'connection' on type 'User'",
            "Variable $network has an invalid value",
        ]
        for error in errors:
            with self.subTest(error=error):
                with patch("github_datastore.github_api.subprocess.run", return_value=failed(error)) as run:
                    with patch("github_datastore.github_api.time.sleep") as sleep:
                        with self.assertRaises(GitHubApiError) as raised:
                            GitHubClient().graphql(QUERY, VARIABLES)
                self.assertEqual(str(raised.exception), f"GraphQL request failed: {error}")
                run.assert_called_once()
                sleep.assert_not_called()

    def test_graphql_error_payload_is_never_retried_or_returned_as_data(self) -> None:
        errors = [{"message": "Cannot query field 'network' on type 'User'"}]
        response = subprocess.CompletedProcess(
            ["gh"], 0, stdout=json.dumps({"data": None, "errors": errors}), stderr="",
        )
        with patch("github_datastore.github_api.subprocess.run", return_value=response) as run:
            with patch("github_datastore.github_api.time.sleep") as sleep:
                with self.assertRaisesRegex(GitHubApiError, "GraphQL errors:"):
                    GitHubClient().graphql(QUERY, VARIABLES)
        run.assert_called_once()
        sleep.assert_not_called()

    def test_existing_server_and_network_retries_remain_bounded(self) -> None:
        for error in ["HTTP 429", "HTTP 500", "HTTP 502", "HTTP 503", "HTTP 504", "connection reset", "network timeout"]:
            with self.subTest(error=error):
                with patch("github_datastore.github_api.subprocess.run", return_value=failed(error)) as run:
                    with patch("github_datastore.github_api.time.sleep") as sleep:
                        with self.assertRaisesRegex(GitHubApiError, error):
                            GitHubClient(attempts=2).graphql(QUERY, VARIABLES)
                self.assertEqual(run.call_count, 2)
                sleep.assert_called_once_with(1)


if __name__ == "__main__":
    unittest.main()
