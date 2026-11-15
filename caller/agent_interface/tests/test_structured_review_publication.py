import json
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import pytest

from agent_interface import review_budget, structured_review
from agent_interface.model_catalog import CATALOG


@pytest.mark.parametrize("status", [200, 422])
def test_large_structured_review_reaches_one_head_pinned_post(tmp_path, monkeypatch, status):
    head = "a" * 40
    route = "/repos/o/r/pulls/12"
    posted = []

    class ReviewEndpoint(BaseHTTPRequestHandler):
        def reply(self, status_code, value):
            body = json.dumps(value).encode()
            self.send_response(status_code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == route:
                self.reply(200, {"state": "open", "draft": False, "user": {"login": "author"},
                                 "head": {"sha": head}, "base": {"sha": "b" * 40}, "title": "Fixture", "body": ""})
            elif self.path.split("?", 1)[0] == f"{route}/comments":
                self.reply(200, [])
            else:
                self.reply(404, {"message": "unexpected read"})

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            if self.path == "/graphql" and "reviewThreads" in payload["query"]:
                self.reply(200, {"data": {"repository": {"pullRequest": {
                    "reviewThreads": {"nodes": [], "pageInfo": {"hasNextPage": False, "endCursor": None}},
                }}}})
            elif self.path == f"{route}/reviews":
                posted.append(payload)
                self.reply(status, {"id": 91, "commit_id": head, "state": "CHANGES_REQUESTED",
                                    "user": {"login": "reviewer"}} if status == 200 else {"message": "review rejected"})
            else:
                self.reply(404, {"message": "unexpected write"})

    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    subprocess.run(["git", "remote", "add", "origin", "https://github.com/o/r.git"], cwd=tmp_path, check=True)
    findings = [{"path": "src/main.py", "line": line, "side": "RIGHT", "body": f"[p1] Finding {line} " + "x" * 2800}
                for line in range(1, 81)]
    assert len(json.dumps(findings).encode()) > 128 * 1024
    verdict = {"action": "request_changes", "comments": findings, "assessment": {
        "verdict": "The changed path needs the listed fixes.", "reviewed_context": "Reviewed the changed file.",
        "limitations": "The fixture covers review publication.",
    }}
    diff = ("diff --git a/src/main.py b/src/main.py\n--- /dev/null\n+++ b/src/main.py\n@@ -0,0 +1,80 @@\n"
            + "".join(f"+fixture line {line}\n" for line in range(1, 81)))
    packet = json.dumps({"coverage": "complete", "files": [{"filename": "src/main.py"}], "diff": diff})
    monkeypatch.setitem(structured_review.ASK, "codex", lambda *_: json.dumps(verdict))
    monkeypatch.setattr(structured_review.ReviewWatch, "check_closed", lambda _: None)
    monkeypatch.delenv("AGENT_INTERFACE_RECEIPT_CALL", raising=False)
    monkeypatch.setenv("NO_PROXY", "127.0.0.1")
    with ThreadingHTTPServer(("127.0.0.1", 0), ReviewEndpoint) as server:
        executable = tmp_path / "github-interface"
        path_log = tmp_path / "comments-path"
        executable.write_text(f"#!{sys.executable}\n" + f"""
from functools import partial
from pathlib import Path
import sys
from github_interface import cli, client, interface
client.get_token = lambda _: 'fixture-token'
interface.GitHubClient = partial(client.GitHubClient, base_url='http://127.0.0.1:{server.server_port}')
path = Path(sys.argv[sys.argv.index('--comments') + 1])
assert path.is_file()
Path({str(path_log)!r}).write_text(str(path))
cli.main()
""")
        executable.chmod(0o700)
        monkeypatch.setenv("GITHUB_INTERFACE_CLI", str(executable))
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            args = (str(tmp_path), "system", "packet", CATALOG.resolve("gpt-6-astra-ultra"), "pr_review",
                    "https://github.com/o/r/pull/12", "reviewer", head, 60)
            if status == 200:
                assert '"review_id": 91' in structured_review.run(*args, packet=packet)
            else:
                with pytest.raises(review_budget.ReviewLimitError, match="review submission rejected"):
                    structured_review.run(*args, packet=packet)
        finally:
            server.shutdown()
            worker.join(timeout=5)
    assert [(request["event"], request["commit_id"], request["comments"]) for request in posted] == [
        ("REQUEST_CHANGES", head, findings),
    ]
    assert not Path(path_log.read_text()).exists()
