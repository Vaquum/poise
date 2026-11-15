"""The trusted Poise publisher. Never checks out or executes a PR candidate."""
import base64
import json
import os
import re
import subprocess
import time

from github_interface.atoms.pulls import list_check_runs, list_reviews
from github_interface.atoms.review_response import context_sha, parse_body
from github_interface.behaviors.list_failing_ci import REVIEW_CLEARANCE
from github_interface.client import GitHubClient

NO_AUTH = True
REPOSITORY = "autonomio/poise"
SHA = re.compile(r"[a-f0-9]{40}")


class _AppClient(GitHubClient):
    def __init__(self, token: str):
        self.token = token
        self.base_url = "https://api.github.com"


async def _client() -> tuple[GitHubClient, int]:
    names = ("POISE_REVIEW_APP_ID", "POISE_REVIEW_INSTALLATION_ID", "POISE_REVIEW_PRIVATE_KEY_FILE")
    values = [os.environ.get(name, "") for name in names]
    if not all(values) or not all(re.fullmatch(r"[1-9][0-9]*", value) for value in values[:2]):
        raise ValueError("review clearance requires " + ", ".join(names))
    app, installation, key = values

    def encoded(value: bytes) -> str:
        return base64.urlsafe_b64encode(value).decode().rstrip("=")

    now = int(time.time())
    unsigned = encoded(b'{"alg":"RS256","typ":"JWT"}') + "." + encoded(
        json.dumps({"iat": now - 60, "exp": now + 300, "iss": app}, separators=(",", ":")).encode())
    signed = subprocess.run(["openssl", "dgst", "-sha256", "-sign", key], input=unsigned.encode(),
                            capture_output=True, check=True, timeout=5)
    client = _AppClient(unsigned + "." + encoded(signed.stdout))
    identity = await client.get("/app")
    if identity.get("id") != int(app):
        raise RuntimeError("review clearance publisher App identity differs from configuration")
    grant = await client.post(f"/app/installations/{installation}/access_tokens", json={
        "repositories": ["poise"], "permissions": {"checks": "write", "contents": "read", "pull_requests": "read"}})
    if not isinstance(grant.get("token"), str) or not grant["token"]:
        raise RuntimeError("review clearance App token is unavailable")
    client.token = grant["token"]
    return client, int(app)


async def snapshot(client: GitHubClient) -> dict:
    pulls = await client.paginate(f"/repos/{REPOSITORY}/pulls", params={"state": "open", "base": "main"})
    records = []
    for pull in pulls:
        head = pull["head"]
        if not SHA.fullmatch(head["sha"]) or not head.get("repo") or not pull.get("user", {}).get("login"):
            raise RuntimeError("review clearance pull ownership/head evidence is unavailable")
        reviews = await list_reviews(client, "autonomio", "poise", pull["number"])
        receipts = []
        for review in reviews:
            if review["state"] == "PENDING":
                continue
            body = review.get("body") or ""
            marker = re.search(r"<!-- poise-invocation ([a-f0-9]{32}) -->\s*\Z", body)
            receipts.append({"id": review["id"], "head": review["commit_id"], "state": review["state"],
                             "actor": review["user"]["login"], "invocation": marker[1] if marker else None,
                             "response": parse_body(body), "submittedAt": review["submitted_at"]})
        records.append({"number": pull["number"], "head": head["sha"], "headRef": head["ref"],
                        "headRepo": head["repo"]["full_name"], "author": pull["user"]["login"],
                        "context": context_sha(pull), "draft": pull["draft"], "reviews": receipts})
    data = await client.graphql("""query { repository(owner:"autonomio",name:"poise") {
      mergeQueue(branch:"main") { entries(first:100) { pageInfo{hasNextPage} nodes {
        position baseCommit{oid} headCommit{oid} pullRequest{number headRefOid}
      } } }
    } }""", {})
    queue = data["repository"]["mergeQueue"]
    groups = []
    if queue:
        entries = queue["entries"]
        if entries["pageInfo"]["hasNextPage"]:
            raise RuntimeError("review clearance merge queue membership is incomplete")
        ordered = sorted(entries["nodes"], key=lambda entry: entry["position"])
        represented = []
        for entry in ordered:
            number, head = entry["pullRequest"]["number"], entry["pullRequest"]["headRefOid"]
            if not any(pull["number"] == number and pull["head"] == head for pull in records):
                raise RuntimeError("review clearance queue and open pull heads disagree")
            represented.append(number)
            if entry["headCommit"] is None:
                continue
            integration = entry["headCommit"]["oid"]
            if not SHA.fullmatch(integration) or not entry["baseCommit"] or not SHA.fullmatch(entry["baseCommit"]["oid"]):
                raise RuntimeError("review clearance integration identity is unavailable")
            # An integration includes the entries ahead of it. Confirm their
            # original heads, rather than asking for receipts on synthetic code.
            for member in (pull for pull in records if pull["number"] in represented):
                comparison = await client.get(f"/repos/{REPOSITORY}/compare/{member['head']}...{integration}")
                if comparison.get("status") not in {"ahead", "identical"}:
                    raise RuntimeError("review clearance integration does not contain its represented PR head")
            groups.append({"head": integration, "base": entry["baseCommit"]["oid"], "pulls": list(represented)})
    return {"pulls": records, "groups": groups}


async def publish(client: GitHubClient, app: int, mode: str, results: list) -> dict:
    if not isinstance(results, list) or len(results) > 1000:
        raise ValueError("review clearance requires a bounded result list")
    if mode == "complete" and any(result.get("conclusion") == "success" for result in results):
        rules = await client.get(f"/repos/{REPOSITORY}/rules/branches/main")
        if not any(rule["type"] == "required_status_checks" and any(
                check["context"] == REVIEW_CLEARANCE and check.get("integration_id") == app
                for check in rule["parameters"]["required_status_checks"]) for rule in rules):
            raise RuntimeError("main must require Poise review clearance from its configured GitHub App")
    published = []
    for result in results:
        head = result.get("head")
        if not isinstance(head, str) or not SHA.fullmatch(head):
            raise ValueError("review clearance result requires an exact commit SHA")
        output = {"title": REVIEW_CLEARANCE, "summary": str(result.get("summary") or "Refreshing native review evidence")[:60000]}
        if mode == "begin":
            check = await client.post(f"/repos/{REPOSITORY}/check-runs", json={
                "name": REVIEW_CLEARANCE, "head_sha": head, "status": "in_progress", "output": output})
            if check.get("app", {}).get("id") != app or check.get("head_sha") != head or type(check.get("id")) is not int:
                raise RuntimeError("GitHub did not confirm the trusted clearance check")
            published.append({"id": check["id"], "head": head})
        else:
            if type(result.get("id")) is not int or result.get("conclusion") not in {"success", "failure"}:
                raise ValueError("review clearance completion requires its original check and a blocking or successful verdict")
            checks = await list_check_runs(client, "autonomio", "poise", head)
            own = [check for check in checks if check.get("name") == REVIEW_CLEARANCE and check.get("app", {}).get("id") == app]
            if not own or max(check["id"] for check in own) != result["id"]:
                published.append({"id": result["id"], "head": head, "superseded": True})
                continue  # An older evaluation can never finish a newer check.
            await client.patch(f"/repos/{REPOSITORY}/check-runs/{result['id']}", json={
                "status": "completed", "conclusion": result["conclusion"], "output": output})
            published.append({"id": result["id"], "head": head})
    return {"checks": published}


async def run(_client_unused, payload: dict) -> dict:
    client, app = await _client()
    mode = payload.get("mode")
    if mode == "snapshot":
        return await snapshot(client)
    if mode not in {"begin", "complete"}:
        raise ValueError("review clearance mode must be snapshot, begin or complete")
    return await publish(client, app, mode, json.loads(payload.get("results_json") or "[]"))
