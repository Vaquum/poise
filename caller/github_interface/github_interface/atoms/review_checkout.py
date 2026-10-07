"""Pinned review source and bounded, read-only access to tracked files."""
import json
import re
import shutil
from pathlib import Path, PurePosixPath
from time import monotonic

from .review_diff import _env, _git

MAX_FILES = 20_000
MAX_CHECKOUT_BYTES = 256 * 1024 * 1024
MAX_GUIDANCE_BYTES = 256 * 1024
MAX_RESPONSE_BYTES = 64 * 1024
MAX_REQUESTS = 8
MANIFEST = "caller-review.json"


def bounded_tree(tree: dict) -> list[dict]:
    if tree.get("truncated") or not isinstance(tree.get("tree"), list):
        raise ValueError("review checkout requires a complete repository tree")
    files = tree["tree"]
    if len(files) > MAX_FILES or sum(item.get("size", 0) for item in files) > MAX_CHECKOUT_BYTES:
        raise ValueError("review checkout exceeds its file or byte limit")
    for item in files:
        path = PurePosixPath(item["path"])
        if path.is_absolute() or ".." in path.parts or any(part.lower() == ".git" for part in path.parts):
            raise ValueError("invalid review repository path")
    return files


def checkout(owner: str, repo: str, head: str, merge_base: str, token: str,
             path: Path, head_tree: dict, base_tree: dict, *, remote: str | None = None) -> dict:
    if not path.is_absolute() or path.exists():
        raise ValueError("review checkout path must be absolute and unused")
    for sha in (head, merge_base):
        if not re.fullmatch(r"[0-9a-f]{40}", sha):
            raise ValueError("review checkout requires pinned commit SHAs")
    files, base_files = bounded_tree(head_tree), bounded_tree(base_tree)
    guidance = [item for item in base_files if item.get("type") == "blob"
                and item.get("mode") in ("100644", "100755")
                and PurePosixPath(item["path"]).name.lower() in ("agents.md", "claude.md")]
    if sum(item["size"] for item in guidance) > MAX_GUIDANCE_BYTES:
        raise ValueError("repository guidance exceeds its byte limit")
    env = _env(token)
    deadline = monotonic() + 180
    path.mkdir(parents=True, mode=0o700)

    def git(*args, limit=MAX_RESPONSE_BYTES):
        remaining = deadline - monotonic()
        if remaining <= 0:
            raise RuntimeError("review checkout timed out")
        return _git(str(path), env, *args, limit=limit, timeout=min(60, remaining))

    try:
        git("init", "--quiet", "--template=")
        git("remote", "add", "origin", remote or f"https://github.com/{owner}/{repo}.git")
        git("config", "remote.origin.promisor", "true")
        git("config", "remote.origin.partialclonefilter", "blob:none")
        git("fetch", "--quiet", "--no-tags", "--depth=1", "--filter=blob:none", "origin", head, merge_base)
        git("-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", head)
        if git("rev-parse", "HEAD").decode().strip() != head:
            raise RuntimeError("review checkout does not match the expected head")
        instructions = []
        for item in sorted(guidance, key=lambda item: (len(PurePosixPath(item["path"]).parts), item["path"])):
            content = git("show", f"{merge_base}:{item['path']}", limit=MAX_GUIDANCE_BYTES).decode("utf-8")
            instructions.append({"path": item["path"], "revision": merge_base, "content": content})
        tracked = [item["path"] for item in files if item.get("type") == "blob"
                   and item.get("mode") in ("100644", "100755")]
        manifest = {"repository": f"{owner}/{repo}", "head_sha": head, "merge_base_sha": merge_base,
                    "files": tracked, "instructions": instructions}
        (path / ".git" / MANIFEST).write_text(json.dumps(manifest))
        return {"head_sha": head, "merge_base_sha": merge_base, "instructions": instructions,
                "files": len(tracked)}
    except BaseException:
        shutil.rmtree(path, ignore_errors=True)
        raise


def inspect(root: Path, requests: list[dict]) -> dict:
    """No Git, network, shell, writes, symlink following, or untracked files."""
    root = root.resolve()
    manifest = json.loads((root / ".git" / MANIFEST).read_text())
    if not isinstance(requests, list) or not 1 <= len(requests) <= MAX_REQUESTS:
        raise ValueError("inspection requires 1-8 requests")
    files = set(manifest["files"])
    results = []
    # Share the response budget across requests, including JSON escaping and
    # envelope metadata. A full batch returns shorter pages, never a lost batch.
    page_bytes = (MAX_RESPONSE_BYTES - len(json.dumps(requests, indent=2).encode()) - 2048) // len(requests)
    if page_bytes < 1:
        raise ValueError("inspection request metadata exceeds its byte limit")
    for request in requests:
        if not isinstance(request, dict) or set(request) != {"operation", "path", "query", "start_line"}:
            raise ValueError("invalid repository inspection request")
        operation, value, query, start = (request[key] for key in ("operation", "path", "query", "start_line"))
        if (operation not in ("read", "search", "list") or not isinstance(value, str)
                or not isinstance(query, str) or len(query) > 512 or type(start) is not int or start < 1):
            raise ValueError("invalid repository inspection operation")
        raw = PurePosixPath(value)
        if raw.is_absolute() or ".." in raw.parts or any(part.lower() == ".git" for part in raw.parts):
            raise ValueError("inspection path must stay inside the repository")
        relative = str(raw)
        selected = sorted(path for path in files if relative in ("", ".") or path == relative or path.startswith(relative + "/"))
        result = {"request": request}
        if operation == "list":
            paths, truncated = _page(iter(selected[start - 1:]), 200, page_bytes)
            result.update(paths=paths, truncated=truncated,
                          next_line=start + len(paths) if truncated else None)
        elif operation == "read":
            if relative not in files:
                result["error"] = "tracked regular file not found"
            else:
                try:
                    lines, truncated = _page(_lines(root, relative, start), 200, page_bytes)
                except UnicodeDecodeError:
                    result.update(error="File is not UTF-8 text; text inspection is unavailable.",
                                  lines=[], truncated=False, next_line=None)
                else:
                    result.update(lines=lines, truncated=truncated,
                                  next_line=start + len(lines) if truncated else None)
        else:
            if not query:
                raise ValueError("search requires a nonempty literal query")
            matches, truncated = _page(_matches(root, selected, query, start), 100, page_bytes)
            result.update(matches=matches, truncated=truncated, next_line=start + len(matches) if truncated else None,
                          scope="Tracked UTF-8 files up to 4 MiB; literal search.")
        if result.get("next_line") == start:
            result["error"] = "Entry exceeds this batch's page budget; request it separately."
        results.append(result)
    response = {"action": "review_context", "head_sha": manifest["head_sha"], "results": results}
    if len(json.dumps(response, indent=2).encode()) + 1 > MAX_RESPONSE_BYTES:
        raise ValueError("inspection response exceeds 64 KiB; request fewer files or lines")
    return response


def _target(root: Path, relative: str) -> Path:
    target = root / relative
    current = root
    for part in PurePosixPath(relative).parts:
        current /= part
        if current.is_symlink():
            raise ValueError("inspection cannot follow symlinks")
    if not target.is_file() or root not in target.resolve().parents:
        raise ValueError("inspection path must be a repository file")
    return target


def _page(items, count: int, byte_limit: int) -> tuple[list, bool]:
    page, size = [], 2
    for item in items:
        # Account for the CLI's pretty JSON and nested indentation too.
        cost = len(json.dumps(item, indent=2).encode()) + 64
        if len(page) == count or size + cost > byte_limit:
            return page, True
        page.append(item)
        size += cost
    return page, False


def _lines(root: Path, relative: str, start: int):
    with _target(root, relative).open(encoding="utf-8") as handle:
        for number, line in enumerate(handle, 1):
            if number >= start:
                yield {"line": number, "text": line.rstrip("\n")}


def _matches(root: Path, selected: list[str], query: str, start: int):
    seen, scanned = 0, 0
    for name in selected:
        target = _target(root, name)
        size = target.stat().st_size
        if scanned + size > MAX_CHECKOUT_BYTES:
            raise ValueError("search exceeds its byte limit")
        scanned += size
        if size > 4 * 1024 * 1024:
            continue
        try:
            with target.open(encoding="utf-8") as handle:
                for line_number, line in enumerate(handle, 1):
                    if query in line:
                        seen += 1
                        if seen >= start:
                            yield {"path": name, "line": line_number, "text": line.rstrip()[:1000]}
        except UnicodeDecodeError:
            continue
