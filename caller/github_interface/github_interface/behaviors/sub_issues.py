import re
from typing import Any

from github_interface.atoms.issues import read_issue, sub_issues
from github_interface.client import GitHubClient
from github_interface.context import issue_number, repository
from github_interface.identity import AGENT

IDENTITY = AGENT

# An issue makes another its sub-issue in either of two ways: GitHub's native
# sub-issues, or a link under its own "Work Slices" heading — how an Origo PRD
# makes its Slices part of it. A mention anywhere else is not a sub-issue, nor
# is one inside a code block or an HTML comment, and a link only counts within
# the issue's own owner, as GitHub's own sub-issues do.
HEADING = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t#]*$", re.MULTILINE)
FENCE = re.compile(r"^[ \t]*(`{3,}|~{3,})[^\n]*\n.*?(?:^[ \t]*\1[ \t]*$|\Z)", re.MULTILINE | re.DOTALL)
HTML_COMMENT = re.compile(r"<!--.*?(?:-->|\Z)", re.DOTALL)
TITLE = re.compile(r"^(?:[0-9A-Za-z]{1,3}[.)][ \t]+)?(.*?)[ \t]*:?$")
REFERENCE = re.compile(
    r"https?://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/issues/(\d+)"
    r"|(?<![\w/.-])([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)#(\d+)\b"
    r"|(?<![\w/#&])#(\d+)\b"
)


async def run(client: GitHubClient, payload: dict[str, Any]) -> dict[str, Any]:
    owner, repo = repository(payload)
    number = issue_number(payload)
    target = f"{owner}/{repo}"
    issue = await read_issue(client, owner, repo, number)
    # GitHub names are case-insensitive: one issue is one entry however a
    # link spells it, under the first spelling seen (GitHub's own comes first).
    found: dict[tuple[str, int], tuple[str, set[str]]] = {}

    def add(name: str, value: int, via: str) -> None:
        found.setdefault((name.lower(), value), (name, set()))[1].add(via)

    for item in await sub_issues(client, owner, repo, number):
        add(_repository(item, target), int(item["number"]), "native")
    for name, value in work_slices(str(issue.get("body") or ""), target):
        add(name, value, "work_slices")
    found.pop((target.lower(), number), None)
    return {
        "action": "sub_issues",
        "repository": target,
        "issue_number": number,
        "sub_issues": [
            {"repository": name, "issue_number": value, "via": sorted(via)}
            for (_, value), (name, via) in sorted(found.items())
        ],
    }


def work_slices(body: str, target: str) -> list[tuple[str, int]]:
    owner = target.split("/", 1)[0].lower()
    refs: list[tuple[str, int]] = []
    for match in REFERENCE.finditer(section(visible(body), "work slices")):
        if match.group(3):
            key = (f"{match.group(1)}/{match.group(2)}", int(match.group(3)))
        elif match.group(6):
            key = (f"{match.group(4)}/{match.group(5)}", int(match.group(6)))
        else:
            key = (target, int(match.group(7)))
        if key[0].split("/", 1)[0].lower() == owner and key not in refs:
            refs.append(key)
    return refs


def visible(body: str) -> str:
    """The text a reader sees: without code blocks or HTML comments, whose
    headings and references are examples, not structure."""
    blank = lambda match: "\n" * match.group(0).count("\n")
    return HTML_COMMENT.sub(blank, FENCE.sub(blank, body))


def title(heading: str) -> str:
    # "Work Slices", "Work Slices:", "5. Work Slices", "**Work Slices**".
    text = re.sub(r"[*_`]", "", heading).strip()
    return TITLE.match(text).group(1).strip().lower()


def section(body: str, name: str) -> str:
    headings = list(HEADING.finditer(body))
    for index, heading in enumerate(headings):
        if title(heading.group(2)) != name:
            continue
        level = len(heading.group(1))
        end = next((later.start() for later in headings[index + 1:] if len(later.group(1)) <= level), len(body))
        return body[heading.end():end]
    return ""


def _repository(item: dict[str, Any], default: str) -> str:
    url = str(item.get("repository_url") or "")
    parts = url.rstrip("/").split("/")
    return f"{parts[-2]}/{parts[-1]}" if "/repos/" in url and len(parts) >= 2 else default
