"""File-group stages for large structured reviews.

A review whose packet holds more files or diff bytes than one provider call
reliably finishes is split into file groups. Each stage reviews its own group
with the full review context, and the harness combines every stage's findings
into the single head-pinned verdict it submits. An input that fits in one
group runs exactly as before.
"""
from __future__ import annotations

import json
import re
from collections.abc import Iterator

STAGE_MAX_FILES = 8
STAGE_MAX_DIFF_BYTES = 200_000
_HUNK = re.compile(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@")


class StageError(ValueError):
    """The packet cannot be staged without dropping reviewed code."""


_SIMPLE_ESCAPES = {"a": "\a", "b": "\b", "f": "\f", "n": "\n", "r": "\r",
                   "t": "\t", "v": "\v", "\\": "\\", '"': '"'}


def _unquote(path: str) -> str:
    """Undo git's C-style path quoting (core.quotePath) for diff matching."""
    if len(path) < 2 or not path.startswith('"') or not path.endswith('"'):
        return path
    out = bytearray()
    body, i = path[1:-1], 0
    while i < len(body):
        char = body[i]
        if char != "\\" or i + 1 >= len(body):
            out += char.encode("utf-8", "surrogateescape")
            i += 1
        elif body[i + 1] in _SIMPLE_ESCAPES:
            out += _SIMPLE_ESCAPES[body[i + 1]].encode("utf-8")
            i += 2
        elif body[i + 1] in "01234567":
            out.append(int(body[i + 1:i + 4], 8))
            i += 4
        else:
            out += body[i + 1].encode("utf-8", "surrogateescape")
            i += 2
    return bytes(out).decode("utf-8", "surrogateescape")


def _plan(packet: str) -> tuple[dict, list[list[tuple[list[str], set[str]]]]] | None:
    """The parsed packet and its file groups, or None when the input runs
    unstaged: not a staged packet, or one group that reviews everything."""
    try:
        node = json.loads(packet)
    except ValueError:
        return None
    if not isinstance(node, dict) or not isinstance(node.get("diff"), str) \
            or not isinstance(node.get("files"), list) \
            or not all(isinstance(entry, dict) and isinstance(entry.get("filename"), str)
                       for entry in node["files"]):
        return None
    retained = [entry["filename"] for entry in node["files"]]
    sections = [(section, _covers(section, retained)) for section in _sections(node["diff"])]
    covered = {path for _, paths in sections for path in paths}
    missing = [path for path in retained if path not in covered]
    if missing:
        raise StageError(f"retained file without a diff section: {missing[0]!r}")
    groups = _pack(sections)
    if len(groups) == 1:
        return None
    return node, groups


def split(packet: str) -> list[str]:
    """One packet per file group, or the untouched packet when it fits."""
    return list(iter_stages(packet))


def iter_stages(packet: str) -> Iterator[str]:
    """Yield one rendered stage packet at a time: exactly what split()
    returns, but holding one stage in memory instead of every stage at
    once. Each stage still carries the full common review context."""
    planned = _plan(packet)
    if planned is None:
        yield packet
        return
    node, groups = planned
    assigned: set[int] = set()
    for index, group in enumerate(groups):
        paths = {path for _, group_paths in group for path in group_paths}
        entries = []
        for number, entry in enumerate(node["files"]):
            if entry["filename"] in paths and number not in assigned:
                assigned.add(number)
                entries.append(entry)
        yield _render(node, len(groups), index,
                      ["\n".join(section) for section, _ in group], entries)


def stage_count(packet: str) -> int:
    """The number of file groups, without rendering any stage."""
    planned = _plan(packet)
    return 1 if planned is None else len(planned[1])


def _sections(diff: str) -> list[list[str]]:
    sections, current = [], []
    for line in diff.splitlines():
        if line.startswith("diff --git ") and current:
            sections.append(current)
            current = []
        current.append(line)
    if current:
        sections.append(current)
    return sections


def _covers(section: list[str], retained: list[str]) -> set[str]:
    """Retained filenames this section reviews: its new path (or old path for
    a deletion), plus the old path of a rename whose new path it carries."""
    paths = {_primary(section, retained)}
    for line in section:
        # Git terminates a space-containing ---/+++ path with a tab; strip
        # that terminator (not path content) before matching retained files.
        if line.startswith("rename from "):
            old = line.removeprefix("rename from ").removesuffix("\t")
            if old not in retained:
                old = _unquote(old)
            if old in retained:
                paths.add(old)
    return paths


def _primary(section: list[str], retained: list[str]) -> str:
    for line in section:
        if line.startswith("+++ "):
            raw = line.removeprefix("+++ ").removesuffix("\t")
            if raw == "/dev/null":
                old = next((item for item in section if item.startswith("--- ")), "")
                old = old.removeprefix("--- ").removesuffix("\t")
                path = old.removeprefix("a/")
                if path not in retained:
                    path = _unquote(old).removeprefix("a/")
            else:
                path = raw.removeprefix("b/")
                if path not in retained:
                    path = _unquote(raw).removeprefix("b/")
            if path not in retained:
                raise StageError(f"diff section for {path!r} names no retained file")
            return path
    # Binary, mode-only and pure-rename sections have no +++ line. A rename
    # names its new path exactly, so it wins over header splits; any other
    # such header names the same path on both sides, so only the symmetric
    # split matches and a retained suffix never shadows the true path.
    for line in section:
        if line.startswith("rename to "):
            raw = line.removeprefix("rename to ").removesuffix("\t")
            path = _unquote(raw)
            if path not in retained:
                path = raw
            if path not in retained:
                raise StageError(f"diff section for {path!r} names no retained file")
            return path
    rest = section[0].removeprefix("diff --git ")
    for cut in [match.start() for match in re.finditer(" b/", rest)]:
        candidate = rest[cut + 3:]
        if candidate in retained and rest == f"a/{candidate} b/{candidate}":
            return candidate
    # C-quoted header ("a/old" "b/new"): the b/ split sits inside
    # quotes, so split on the quote-space-quote pair boundaries instead.
    start = 0
    while (boundary := rest.find('" "', start)) != -1:
        candidate = _unquote(rest[boundary + 2:]).removeprefix("b/")
        if candidate in retained:
            return candidate
        start = boundary + 1
    raise StageError(f"diff section without a retained file: {section[0][:80]!r}")


def _pack(sections: list[tuple[list[str], set[str]]]) -> list[list[tuple[list[str], set[str]]]]:
    groups: list[list[tuple[list[str], set[str]]]] = [[]]
    sizes = [0]
    for section in sections:
        size = len("\n".join(section[0]).encode())
        if groups[-1] and (len(groups[-1]) >= STAGE_MAX_FILES or sizes[-1] + size > STAGE_MAX_DIFF_BYTES):
            groups.append([])
            sizes.append(0)
        groups[-1].append(section)
        sizes[-1] += size
    return groups


def _hunk_lines(section: list[str]):
    """Yield (kind, old, new, content) for diff lines inside hunks."""
    old, new, in_hunk = 0, 0, False
    for line in section:
        if line.startswith("@@ "):
            match = _HUNK.match(line)
            if match is None:
                raise StageError(f"unparseable diff hunk header: {line[:60]!r}")
            old, new, in_hunk = int(match.group(1)), int(match.group(2)), True
        elif in_hunk and line.startswith(" "):
            yield "context", old, new, line[1:]
            old += 1
            new += 1
        elif in_hunk and line.startswith("-"):
            yield "removed", old, new, line[1:]
            old += 1
        elif in_hunk and line.startswith("+"):
            yield "added", old, new, line[1:]
            new += 1


def diff_line_sets(diff: str, retained: list[str]) -> dict[str, dict[str, set[int]]]:
    """Per-file hunk line numbers by side, for validating comment positions
    against the pull request diff GitHub will judge them on."""
    sets: dict[str, dict[str, set[int]]] = {}
    for section in _sections(diff):
        lines = sets.setdefault(_primary(section, retained), {"left": set(), "right": set()})
        for kind, old, new, _content in _hunk_lines(section):
            # Context lines accept comments on either side, as they do at GitHub.
            if kind in ("context", "removed"):
                lines["left"].add(old)
            if kind in ("context", "added"):
                lines["right"].add(new)
    return sets


def diff_left_anchors(diff: str, retained: list[str]) -> dict[str, dict[int, tuple[int, str]]]:
    """LEFT lines keyed to their current-head position and content.

    Both the since diff and the full PR diff end at the same current head,
    so that position distinguishes repeated text in different hunks.
    """
    contents: dict[str, dict[int, tuple[int, str]]] = {}
    for section in _sections(diff):
        lines = contents.setdefault(_primary(section, retained), {})
        for kind, old, new, content in _hunk_lines(section):
            if kind in ("context", "removed"):
                lines[old] = (new, content)
    return contents


def diff_left_spans(diff: str, retained: list[str]) -> dict[str, dict[int, tuple[int, int]]]:
    """The new-side span of the change block holding each LEFT line.

    Both the since diff and the full pull request diff end at the same
    current head, but they lay out change blocks differently: a
    follow-up removal next to an earlier pull request edit merges into
    one block in the full diff. The removed line's since position still
    falls inside that block's new-side span, while repeats in other
    blocks sit in disjoint spans. Context lines span only themselves.
    """
    spans: dict[str, dict[int, tuple[int, int]]] = {}
    for section in _sections(diff):
        lines = spans.setdefault(_primary(section, retained), {})
        pending: list[int] = []
        start = end = 0
        for kind, old, new, _content in _hunk_lines(section):
            if kind == "removed":
                if not pending:
                    start = end = new
                pending.append(old)
            elif kind == "added":
                if pending:
                    end = new + 1
            else:
                if pending:
                    for number in pending:
                        lines[number] = (start, new)
                    pending = []
                lines[old] = (new, new)
        for number in pending:
            lines[number] = (start, end)
    return spans


def _render(node: dict, total: int, index: int, sections: list[str], entries: list[dict]) -> str:
    scope = (f"Staged review: file group {index + 1} of {total}. "
             "Review ONLY the retained diff below. Other file groups are reviewed in separate "
             "stages; do not infer their correctness from this packet.")
    if node.get("since_head_sha"):
        scope += (" This group covers only changes since the last reviewed head. "
                  "New findings on current lines must reference RIGHT-side (current-head) lines; "
                  "when the removal itself is the defect, comment on the removed (LEFT-side) line. "
                  "Reaffirm existing unresolved findings with their original locations.")
    if node.get("excluded_files"):
        scope += " Excluded file contents were not reviewed either; do not infer their correctness from this packet."
    omitted = node.get("omitted_files") or []
    if omitted:
        scope += (f" Coverage is partial: {len(omitted)} retained files, listed in omitted_files, "
                  "are not reviewed in any stage; do not infer their correctness from this packet.")
    staged = {**node, "diff": "\n".join(sections), "files": entries, "review_scope": scope}
    return json.dumps(staged, separators=(",", ":"))
