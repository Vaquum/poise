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

STAGE_MAX_FILES = 8
STAGE_MAX_DIFF_BYTES = 200_000


class StageError(ValueError):
    """The packet cannot be staged without dropping reviewed code."""


def split(packet: str) -> list[str]:
    """One packet per file group, or the untouched packet when it fits."""
    try:
        node = json.loads(packet)
    except ValueError:
        return [packet]
    if not isinstance(node, dict) or not isinstance(node.get("diff"), str) \
            or not isinstance(node.get("files"), list) \
            or not all(isinstance(entry, dict) and isinstance(entry.get("filename"), str)
                       for entry in node["files"]):
        return [packet]
    retained = [entry["filename"] for entry in node["files"]]
    sections = [(section, _covers(section, retained)) for section in _sections(node["diff"])]
    covered = {path for _, paths in sections for path in paths}
    missing = [path for path in retained if path not in covered]
    if missing:
        raise StageError(f"retained file without a diff section: {missing[0]!r}")
    groups = _pack(sections)
    if len(groups) == 1:
        return [packet]
    assigned: set[int] = set()
    rendered = []
    for index, group in enumerate(groups):
        paths = {path for _, group_paths in group for path in group_paths}
        entries = []
        for number, entry in enumerate(node["files"]):
            if entry["filename"] in paths and number not in assigned:
                assigned.add(number)
                entries.append(entry)
        rendered.append(_render(node, len(groups), index,
                                ["\n".join(section) for section, _ in group], entries))
    return rendered


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
        if line.startswith("rename from ") and line.removeprefix("rename from ") in retained:
            paths.add(line.removeprefix("rename from "))
    return paths


def _primary(section: list[str], retained: list[str]) -> str:
    for line in section:
        if line.startswith("+++ "):
            path = line.removeprefix("+++ ")
            if path == "/dev/null":
                old = next((item for item in section if item.startswith("--- ")), "")
                path = old.removeprefix("--- a/") if old.startswith("--- a/") else old
            else:
                path = path.removeprefix("b/")
            if path not in retained:
                raise StageError(f"diff section for {path!r} names no retained file")
            return path
    # Binary, mode-only and pure-rename sections have no +++ line; the diff
    # header names both sides. Every b/ split is tried so a path containing
    # " b/" still matches its retained file.
    rest = section[0].removeprefix("diff --git ")
    found = None
    for cut in [match.start() for match in re.finditer(" b/", rest)]:
        if rest[cut + 3:] in retained:
            found = rest[cut + 3:]
    if found is None:
        raise StageError(f"diff section without a retained file: {section[0][:80]!r}")
    return found


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


def _render(node: dict, total: int, index: int, sections: list[str], entries: list[dict]) -> str:
    scope = (f"Staged review: file group {index + 1} of {total}. "
             "Review ONLY the retained diff below. Other file groups are reviewed in separate "
             "stages; do not infer their correctness from this packet.")
    if node.get("since_head_sha"):
        scope += (" This group covers only changes since the last reviewed head. "
                  "New findings must reference RIGHT-side (current-head) lines; "
                  "reaffirm existing unresolved findings with their original locations.")
    if node.get("excluded_files"):
        scope += " Excluded file contents were not reviewed either; do not infer their correctness from this packet."
    omitted = node.get("omitted_files") or []
    if omitted:
        scope += (f" Coverage is partial: {len(omitted)} retained files, listed in omitted_files, "
                  "are not reviewed in any stage; do not infer their correctness from this packet.")
    staged = {**node, "diff": "\n".join(sections), "files": entries, "review_scope": scope}
    return json.dumps(staged, separators=(",", ":"))
