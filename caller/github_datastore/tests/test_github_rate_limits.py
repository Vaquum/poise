import json
import subprocess
import unittest
from unittest.mock import patch

from github_datastore.github_api import GitHubApiError, GitHubClient, GitHubRateLimitError


RESET = 2_000_000_000
RATE_ERRORS = [{"type": "RATE_LIMITED", "message": "API rate limit exceeded for user"}]


def response(payload: dict, *, returncode: int = 0, stderr: str = "", remaining: str = "0", reset: str = str(RESET), status: str = "200 OK") -> subprocess.CompletedProcess:
    headers = f"HTTP/2.0 {status}\r\nContent-Type: application/json\r\nX-RateLimit-Remaining: {remaining}\r\nX-RateLimit-Reset: {reset}\r\nX-RateLimit-Resource: graphql\r\n\r\n"
    return subprocess.CompletedProcess(["gh"], returncode, stdout=headers + json.dumps(payload), stderr=stderr)


class GitHubRateLimitTest(unittest.TestCase):
    def test_successful_last_point_is_returned_with_headers_stripped(self) -> None:
        data = {"viewer": {"login": "account"}}
        with patch("github_datastore.github_api.subprocess.run", return_value=response({"data": data})) as run:
            self.assertEqual(GitHubClient().graphql("query { viewer { login } }"), data)
        self.assertIn("--include", run.call_args.args[0])

    def test_final_response_headers_override_interim_headers(self) -> None:
        proc = response({"data": None, "errors": RATE_ERRORS})
        proc.stdout = "HTTP/1.1 100 Continue\r\nX-RateLimit-Remaining: 12\r\n\r\n" + proc.stdout
        with patch("github_datastore.github_api.subprocess.run", return_value=proc):
            with self.assertRaises(GitHubRateLimitError) as caught:
                GitHubClient().graphql("query { viewer { login } }")
        self.assertEqual(caught.exception.reset_at, RESET)

    def test_primary_limit_preserves_reset_and_diagnostic_without_retrying(self) -> None:
        for returncode, status, stderr in [(0, "200 OK", ""), (1, "200 OK", "gh: GraphQL error"), (1, "403 Forbidden", "gh: Forbidden")]:
            with self.subTest(returncode=returncode, status=status):
                proc = response({"data": None, "errors": RATE_ERRORS}, returncode=returncode, status=status, stderr=stderr)
                with patch("github_datastore.github_api.subprocess.run", return_value=proc) as run, patch("github_datastore.github_api.time.sleep") as sleep:
                    with self.assertRaises(GitHubRateLimitError) as caught:
                        GitHubClient().graphql("query { viewer { login } }")
                self.assertEqual(caught.exception.reset_at, RESET)
                self.assertIn(f"GITHUB_RATE_LIMIT_RESET={RESET}", str(caught.exception))
                self.assertIn("API rate limit exceeded for user", str(caught.exception))
                run.assert_called_once()
                sleep.assert_not_called()

    def test_observed_already_exceeded_payload_and_gh_exit_one_preserve_reset(self) -> None:
        errors = [{"type": "RATE_LIMIT", "message": "API rate limit already exceeded for user ID 7943188.", "extensions": {"code": "graphql_rate_limit"}}]
        for returncode, stderr in [(0, ""), (1, "gh: API rate limit already exceeded for user ID 7943188.")]:
            with self.subTest(returncode=returncode):
                proc = response({"data": None, "errors": errors}, returncode=returncode, stderr=stderr)
                with patch("github_datastore.github_api.subprocess.run", return_value=proc) as run, patch("github_datastore.github_api.time.sleep") as sleep:
                    with self.assertRaises(GitHubRateLimitError) as caught:
                        GitHubClient().graphql("query { viewer { login } }")
                self.assertEqual(caught.exception.reset_at, RESET)
                self.assertIn(f"GITHUB_RATE_LIMIT_RESET={RESET}", str(caught.exception))
                self.assertIn(errors[0]["message"], str(caught.exception))
                run.assert_called_once()
                sleep.assert_not_called()

    def test_shared_client_stops_worker_requests_until_reset(self) -> None:
        limited = response({"errors": RATE_ERRORS})
        healthy = response({"data": {"viewer": {"login": "account"}}}, remaining="4999")
        client = GitHubClient()
        with patch("github_datastore.github_api.subprocess.run", side_effect=[limited, healthy]) as run, patch("github_datastore.github_api.time.time", return_value=RESET - 1):
            with self.assertRaises(GitHubRateLimitError) as first:
                client.graphql("query { viewer { login } }")
            for _ in range(3):
                with self.assertRaises(GitHubRateLimitError) as subsequent:
                    client.graphql("query { viewer { login } }")
                self.assertIs(first.exception, subsequent.exception)
            self.assertEqual(run.call_count, 1)
            with patch("github_datastore.github_api.time.time", return_value=RESET):
                self.assertEqual(client.graphql("query { viewer { login } }"), {"viewer": {"login": "account"}})
            self.assertEqual(run.call_count, 2)

    def test_invalid_reset_fails_without_a_fabricated_deadline(self) -> None:
        for reset in ("", "unknown", "0", "-1"):
            with self.subTest(reset=reset), patch("github_datastore.github_api.subprocess.run", return_value=response({"errors": RATE_ERRORS}, reset=reset)) as run:
                with self.assertRaises(GitHubApiError) as caught:
                    GitHubClient().graphql("query { viewer { login } }")
                self.assertNotIsInstance(caught.exception, GitHubRateLimitError)
                self.assertIn("no valid reset time", str(caught.exception))
                self.assertNotIn("GITHUB_RATE_LIMIT_RESET=", str(caught.exception))
                run.assert_called_once()

    def test_auth_and_validation_errors_are_not_reclassified_as_quota(self) -> None:
        cases = [
            response({"message": "Bad credentials"}, returncode=1, status="401 Unauthorized", stderr="gh: Bad credentials (HTTP 401)"),
            response({"message": "Forbidden"}, returncode=1, status="403 Forbidden", stderr="gh: Forbidden (HTTP 403)"),
            response({"message": "Not Found"}, returncode=1, status="404 Not Found", stderr="gh: Not Found (HTTP 404)"),
            response({"errors": [{"message": "Cannot query field 'rateLimit' on type 'User'"}]}),
        ]
        for proc in cases:
            with self.subTest(proc=proc), patch("github_datastore.github_api.subprocess.run", return_value=proc) as run, patch("github_datastore.github_api.time.sleep") as sleep:
                with self.assertRaises(GitHubApiError) as caught:
                    GitHubClient().graphql("query { viewer { login } }")
                self.assertNotIsInstance(caught.exception, GitHubRateLimitError)
                self.assertNotIn("GITHUB_RATE_LIMIT_RESET=", str(caught.exception))
                run.assert_called_once()
                sleep.assert_not_called()

    def test_malformed_header_block_fails_loudly(self) -> None:
        proc = subprocess.CompletedProcess(["gh"], 0, stdout="HTTP/2.0 200 OK\nContent-Type: application/json", stderr="")
        with patch("github_datastore.github_api.subprocess.run", return_value=proc):
            with self.assertRaisesRegex(GitHubApiError, "incomplete HTTP headers"):
                GitHubClient().graphql("query { viewer { login } }")


if __name__ == "__main__":
    unittest.main()
