"""Run the required quota-change checks with Poise's Node 22 and Caller PATH."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import sys


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("check", choices=["setup", "caller", "poise"])
    parser.add_argument("--node-bin", type=Path, help="Directory containing Node 22 and npm")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    environment = os.environ.copy()
    paths = [str(root / "caller" / ".venv" / "bin")]
    if args.node_bin:
        paths.append(str(args.node_bin))
    # macOS keeps lsof, required by Caller's process cleanup, in /usr/sbin.
    environment["PATH"] = os.pathsep.join([*paths, environment["PATH"], "/usr/sbin", "/sbin"])
    version = subprocess.run(["node", "--version"], env=environment, capture_output=True, text=True, check=True).stdout.strip()
    if not version.startswith("v22."):
        raise RuntimeError(f"Poise's required checks need Node 22; selected runtime is {version}")
    commands = {
        "setup": [["npm", "ci"], ["npm", "run", "caller:setup"]],
        "caller": [[str(root / "caller" / ".venv" / "bin" / "python"), "-m", "pytest",
                    "caller/agent_interface/tests", "caller/github_interface/tests", "caller/github_datastore/tests", "-q"]],
        "poise": [["npm", "run", "check"]],
    }
    for command in commands[args.check]:
        subprocess.run(command, cwd=root, env=environment, check=True)


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        sys.exit(error.returncode)
