from pathlib import Path
import unittest


class TransportPolicyTest(unittest.TestCase):
    def test_github_transport_is_graphql_only(self) -> None:
        source = (
            Path(__file__).resolve().parents[1]
            / "github_datastore"
            / "github_api.py"
        ).read_text()
        forbidden = [
            "api.github.com",
            '"/repos/',
            "'/repos/",
            '"/orgs/',
            "'/orgs/",
            "urllib",
            "Search API",
        ]
        for marker in forbidden:
            self.assertNotIn(marker, source)


if __name__ == "__main__":
    unittest.main()
