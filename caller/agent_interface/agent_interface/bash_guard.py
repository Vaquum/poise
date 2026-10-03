#!/usr/bin/env python3
from __future__ import annotations

import fnmatch
import json
import os
import shlex
import subprocess
import sys


if __package__:
    from .review_gate import submission_gate
else:
    from review_gate import submission_gate


BAD = {";", "|", "||", "&&", "&", "<", ">", ">>", "<<", "2>", "2>>", "2>&1"}


def allowed(command: str) -> bool:
    for pattern in json.loads(os.environ.get("AGENT_INTERFACE_BASH_ALLOW", "[]")):
        if fnmatch.fnmatchcase(command, pattern):
            return True
    return False


def user_command(raw: str) -> str:
    parts = shlex.split(raw)
    if "eval" in parts:
        i = parts.index("eval")
        if i + 1 < len(parts):
            chunk = []
            for token in parts[i + 1 :]:
                if token in BAD:
                    break
                chunk.append(token)
            return " ".join(chunk)
    return raw


def main():
    command = user_command(" ".join(sys.argv[1:]).strip())
    try:
        argv = shlex.split(command)
    except ValueError as e:
        raise SystemExit(str(e))
    if not argv or not allowed(command) or any(t in BAD for t in argv):
        raise SystemExit(f"blocked by agent-interface: {command}")
    receipt = os.environ.get("AGENT_INTERFACE_REVIEW_RECEIPT")
    with submission_gate(os.environ.get("AGENT_INTERFACE_REVIEW_GATE")):
        if not receipt:
            done = subprocess.run(argv, text=True)
            raise SystemExit(done.returncode)
        done = subprocess.run(argv, text=True, capture_output=True)
    # The reply reaches the model unchanged; a submitted review's id is also
    # left for the run, so it can tell its own review from a sibling's.
    sys.stdout.write(done.stdout)
    sys.stderr.write(done.stderr)
    if done.returncode == 0 and '"review_id"' in done.stdout:
        staged = receipt + ".tmp"
        with open(staged, "w") as handle:
            handle.write(done.stdout)
        os.replace(staged, receipt)
    raise SystemExit(done.returncode)


if __name__ == "__main__":
    main()
