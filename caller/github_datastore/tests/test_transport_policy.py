from pathlib import Path
import unittest


class TransportPolicyTest(unittest.TestCase):
    def test_github_transport_is_graphql_only(self) -> None:
        source = (
            Path(__file__).resolve().parents[1]
            / "github_datastore"
            / "github_api.py"
        ).read_text()
        endpoint = 'https://api.github.com/graphql'
        self.assertEqual(source.count(f'"{endpoint}"'), 1)
        source = source.replace(f'"{endpoint}"', "").replace('"api.github.com"', "")
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
