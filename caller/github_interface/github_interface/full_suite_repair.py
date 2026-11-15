"""Conservative coverage proof for a reporter-owned, recovered full-suite seed.

Only covered test assertion repairs retire automatically. Production changes,
new assertions and incomplete evidence require a person's decision.
"""
import asyncio
import base64
import difflib
import io
import json
import re
import zipfile

from github_interface.atoms.pulls import get_pull
from github_interface.client import GitHubClient

TITLE = "fix: the full test suite fails on main"
BOT = "github-actions[bot]"


async def test_results(client: GitHubClient, target: str, run: dict, *, causes: bool = False) -> dict:
    inventory = await client.get(f"/repos/{target}/actions/runs/{run['id']}/artifacts", params={"per_page": 100})
    artifacts = inventory["artifacts"]
    if len(artifacts) != inventory["total_count"]:
        raise ValueError("full-suite artifact inventory is incomplete")
    reports = [item for item in artifacts if re.fullmatch(r"unit-timings-[12]", item.get("name", ""))]
    if sorted(item["name"] for item in reports) != ["unit-timings-1", "unit-timings-2"] or any(item.get("expired") for item in reports):
        raise ValueError("full-suite test artifacts are missing, expired or ambiguous")
    results = {}
    for artifact in reports:
        data = await client.download(f"/repos/{target}/actions/artifacts/{artifact['id']}/zip")
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            if archive.namelist() != ["vitest.json"] or archive.getinfo("vitest.json").file_size > 16 * 1024 * 1024:
                raise ValueError("full-suite test artifact is incomplete or oversized")
            report = json.loads(archive.read("vitest.json"))
        failed = 0
        for file in report["testResults"]:
            if causes and (file.get("status") not in {"passed", "failed"} or file.get("message")):
                raise ValueError("test artifact contains a suite failure without assertion evidence")
            path = file["name"].split(f"/{target.split('/')[-1]}/", 1)[-1]
            # Runner paths can contain the repository name twice.
            path = path[path.index("tests/"):] if "tests/" in path else path
            for test in file["assertionResults"]:
                key = (path, test["fullName"])
                status = test["status"]
                if causes:
                    messages = test.get("failureMessages")
                    if status not in {"passed", "failed", "pending", "todo", "skipped"} \
                            or not isinstance(messages, list) or any(not isinstance(message, str) for message in messages) \
                            or status == "failed" and not any(message.strip() for message in messages):
                        raise ValueError("test artifact lacks a concrete assertion result/cause")
                    failed += status == "failed"
                    results.setdefault(key, []).append({"status": status, "cause": "\n".join(messages)})
                else:
                    results.setdefault(key, []).append(status)
            if causes and file.get("status") == "failed" and not any(test["status"] == "failed" for test in file["assertionResults"]):
                raise ValueError("test suite failed without complete assertion evidence")
        if causes and (report.get("numFailedTests") != failed
                       or report.get("numTotalTests") != sum(len(file["assertionResults"]) for file in report["testResults"])
                       or run["unit_conclusions"][artifact["name"]] != ("failure" if failed else "success")):
            raise ValueError("test artifact contains unaccounted failures")
    return results


async def verified_run(client: GitHubClient, target: str, ident: str, sha: str, conclusion: str) -> dict:
    run = await client.get(f"/repos/{target}/actions/runs/{ident}")
    if (run.get("head_repository") or {}).get("full_name", "").lower() != target.lower() \
            or run.get("head_branch") != "main" or run.get("head_sha") != sha \
            or run.get("path") != ".github/workflows/ci.yml" or run.get("status") != "completed" \
            or run.get("conclusion") != conclusion or run.get("event") not in {"push", "workflow_dispatch"}:
        raise ValueError("report does not identify the actual completed main CI run")
    inventory = await client.get(f"/repos/{target}/actions/runs/{ident}/attempts/{run['run_attempt']}/jobs", params={"per_page": 100})
    jobs = inventory["jobs"]
    if len(jobs) != inventory["total_count"]:
        raise ValueError("full-suite job inventory is incomplete")
    if not any(job.get("name") == "Unit & integration (2)" and job.get("conclusion") != "skipped" for job in jobs):
        raise ValueError("reported CI run did not execute the full suite")
    return {"id": run["id"], "sha": sha, "attempt": run["run_attempt"], "url": run["html_url"]}


async def source(client: GitHubClient, target: str, path: str, ref: str) -> str:
    value = await client.get(f"/repos/{target}/contents/{path}", params={"ref": ref})
    if value.get("encoding") != "base64" or value.get("type") != "file":
        raise ValueError("test source is not available in full")
    return base64.b64decode(value["content"]).decode()


def replacements(before: str, after: str) -> list[tuple[int, str, str]]:
    old, new = before.splitlines(), after.splitlines()
    changes = []
    for kind, start, end, first, last in difflib.SequenceMatcher(None, old, new, autojunk=False).get_opcodes():
        if kind == "equal":
            continue
        if kind != "replace" or end - start != last - first:
            raise ValueError("duplicate contains independent additions or deletions")
        changes.extend((index, old[index], new[first + index - start]) for index in range(start, end))
    return changes


def fixture_clock(text: str) -> tuple[str, ...] | None:
    definition = re.search(r"^const at = \((\w+): number\) => (\w+) \+ \1 \* (\w+)$", text, re.MULTILINE)
    if not definition:
        return None
    base = re.search(r"^const " + re.escape(definition[2]) + r" = Date\.parse\('[^'\n]+'\)$", text, re.MULTILINE)
    unit = re.search(r"^const " + re.escape(definition[3]) + r" = ([0-9_]+)$", text, re.MULTILINE)
    if not base or not unit or int(unit[1].replace("_", "")) <= 0:
        return None
    return definition[0], base[0], unit[0]


def assertion_covered(old: str, duplicate: str, covering: str, clock_verified: bool) -> bool:
    if duplicate == covering:
        return True
    # A fixture-clock repair can choose another instant for the very same
    # assertion. Keep the entire assertion/call identical, including expected
    # values; do not equate arbitrary numeric expressions or whole patches.
    clock = r"(?<![\w.$])at\(([0-9]+)\)"
    left, right = re.findall(clock, duplicate), re.findall(clock, covering)
    return bool(clock_verified and old.lstrip().startswith("expect(") and not re.search(clock, old)
                and len(left) == len(right) == 1 and re.sub(clock, "at(FIXTURE)", duplicate) == re.sub(clock, "at(FIXTURE)", covering))


def test_block(text: str, title: str) -> list[str]:
    lines = text.splitlines()
    starts = [(index, match.group(1)) for index, line in enumerate(lines)
              if (match := re.fullmatch(r"(\s*)(?:it|test)\(['\"]" + re.escape(title) + r"['\"], \(\) => \{", line))]
    if len(starts) != 1:
        raise ValueError("reported test source is missing, ambiguous or requires semantic review")
    start, indent = starts[0]
    end = next((index for index in range(start + 1, len(lines)) if lines[index] == indent + "})"), None)
    if end is None:
        raise ValueError("reported test body is incomplete")
    return lines[start:end + 1]


async def inspect(client: GitHubClient, target: str, issue: dict, comments: list, pull: dict | None) -> dict | None:
    if issue.get("title") != TITLE or (issue.get("user") or {}).get("login") != BOT or issue.get("state") != "closed":
        return None
    evidence = {"verified": False, "failures": [], "recovery": None, "covering": [],
                "duplicate": {"number": pull["number"], "head": pull["head"]["sha"]} if pull else None}
    try:
        reports = [issue.get("body") or ""] + [item["body"] for item in comments if item.get("author") == BOT]
        failures, recovery, tests = [], None, set()
        for report in reports:
            failed = re.match(rf"The full test suite failed on `main` at ([a-f0-9]{{40}}): https://github.com/{re.escape(target)}/actions/runs/([0-9]+)", report)
            passed = re.fullmatch(rf"The full suite passed at ([a-f0-9]{{40}}): https://github.com/{re.escape(target)}/actions/runs/([0-9]+)\n\nClosing\.", report)
            if failed:
                failures.append(failed.groups())
                tests.update(tuple(line.split(" > ", 1)) for line in re.findall(r"^- (tests/[^\n]+ > [^\n]+)$", report, re.MULTILINE))
                recovery = None
            elif passed:
                recovery = passed.groups()
        if not failures or not recovery or not tests or len(failures) > 10:
            raise ValueError("reporter recovery or concrete reported test failures are missing")
        evidence["failures"] = await asyncio.gather(*(verified_run(client, target, ident, sha, "failure") for sha, ident in failures))
        evidence["recovery"] = await verified_run(client, target, recovery[1], recovery[0], "success")
        failed_tests, passed_tests = await asyncio.gather(test_results(client, target, evidence["failures"][-1]), test_results(client, target, evidence["recovery"]))
        if any("failed" not in failed_tests.get(test, []) or not passed_tests.get(test)
               or any(status != "passed" for status in passed_tests[test]) for test in tests):
            raise ValueError("full-run artifacts do not prove recovery of every reported failure")
        compared = await client.get(f"/repos/{target}/compare/{failures[-1][0]}...{recovery[0]}")
        if compared.get("status") != "ahead" or len(compared.get("commits", [])) != compared.get("total_commits"):
            raise ValueError("recovery ancestry is incomplete or precedes the failure")
        if not pull or pull.get("merged_at") or pull.get("base", {}).get("ref") != "main":
            raise ValueError("a complete unmerged duplicate pull request is required")
        files = await client.paginate(f"/repos/{target}/pulls/{pull['number']}/files")
        if not files or len(files) != pull.get("changed_files") or sum(file["additions"] for file in files) != pull.get("additions") \
                or sum(file["deletions"] for file in files) != pull.get("deletions"):
            raise ValueError("the entire latest duplicate diff is unavailable")
        base = await client.get(f"/repos/{target}/compare/{pull['base']['sha']}...{pull['head']['sha']}")
        changes, clocks = [], {}
        for file in files:
            path = file["filename"]
            if file["status"] != "modified" or not any(test[0] == path for test in tests):
                raise ValueError("duplicate has independent work outside the reported tests")
            before, after = await asyncio.gather(source(client, target, path, base["merge_base_commit"]["sha"]), source(client, target, path, pull["head"]["sha"]))
            edits = replacements(before, after)
            if not edits or len(edits) != file["additions"] or len(edits) != file["deletions"]:
                raise ValueError("duplicate contains changes outside its complete text repair")
            recovered = await source(client, target, path, recovery[0])
            clocks[path] = fixture_clock(after) is not None and fixture_clock(after) == fixture_clock(recovered)
            for line, old, new in edits:
                titles = re.findall(r"^\s*(?:it|test)\(['\"]([^'\"]+)['\"]", "\n".join(before.splitlines()[:line + 1]), re.MULTILINE)
                if not titles or not any(test[0] == path and test[1].endswith(titles[-1]) for test in tests):
                    raise ValueError("duplicate changes a test outside the reported failures")
                original = test_block(before, titles[-1])
                if old not in original:
                    raise ValueError("duplicate changes code outside the reported test body")
                duplicate_test, recovered_test = test_block(after, titles[-1]), test_block(recovered, titles[-1])
                if any(re.search(r"\b(?:const|let|var|function)\s+at\b", line) for line in duplicate_test):
                    clocks[path] = False
                if len(duplicate_test) != len(recovered_test) or any(
                    left != right and not any(left == replacement and assertion_covered(prior, left, right, clocks[path])
                                              for _, prior, replacement in edits)
                    for left, right in zip(duplicate_test, recovered_test)
                ):
                    raise ValueError("recovery does not retain the entire duplicate regression assertion and fixtures")
                changes.append((path, old, new))
        if not changes:
            raise ValueError("duplicate diff contains no covered repair")
        covered = set()
        for commit in compared["commits"]:
            linked = await client.get(f"/repos/{target}/commits/{commit['sha']}/pulls")
            for candidate in linked:
                if not candidate.get("merged_at") or candidate.get("merge_commit_sha") != commit["sha"] or candidate["number"] == pull["number"]:
                    continue
                covering = await get_pull(client, *target.split("/"), candidate["number"])
                if covering.get("merged") is not True or covering.get("merge_commit_sha") != commit["sha"] or covering.get("base", {}).get("ref") != "main":
                    continue
                prior_coverage = len(covered)
                patches = await client.paginate(f"/repos/{target}/pulls/{candidate['number']}/files")
                for file in patches:
                    if file["status"] != "modified" or file["filename"] not in {edit[0] for edit in changes} or not file.get("patch"):
                        continue
                    removed, added = [], []
                    for line in file["patch"].splitlines():
                        if line.startswith("-"):
                            removed.append(line[1:])
                        elif line.startswith("+"):
                            added.append(line[1:])
                    if len(removed) != len(added):
                        continue
                    for index, (path, old, new) in enumerate(changes):
                        if path == file["filename"] and any(old == prior and assertion_covered(old, new, fixed, clocks[path]) for prior, fixed in zip(removed, added)):
                            covered.add(index)
                if len(covered) > prior_coverage:
                    evidence["covering"].append({"number": candidate["number"], "mergeSha": commit["sha"], "url": candidate["html_url"]})
        if len(covered) != len(changes) or not evidence["covering"]:
            raise ValueError("covering merges do not cover the entire latest duplicate repair")
        evidence.update(verified=True, tests=sorted([list(test) for test in tests]))
    except ValueError as error:
        evidence["reason"] = str(error)
    return evidence
