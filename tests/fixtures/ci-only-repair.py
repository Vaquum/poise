"""Produce Caller CLI repair receipts without live GitHub, providers or namespaces."""
import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import agent_interface as api
from agent_interface import issue_review

request = json.load(sys.stdin)
argv, ci = request["argv"], request["ci"]
commands = []
pending = []
original_main, original_track = api._main, api.track


def track(*args, **kwargs):
    # Use the existing v1 resource boundary in place of a kernel namespace;
    # the CLI's native diagnostic and resource finalizers still run normally.
    with patch.object(api, "_native_cli", False):
        return original_track(*args, **kwargs)


def execute():
    try:
        original_main()
    finally:
        pending.extend(api.logs())


def interface(*args, **_kwargs):
    commands.append(args[0])
    if args[0] == "--issue-work":
        assert args[args.index("--mode") + 1] == "prepare"
        return {"outcome": "prepared", "checkout_head": ci["head_sha"]}
    if args[0] == "--list-failing-ci" and "--ref" in args:
        return request["integration"] if args[-1] == request["integration"]["ref"] else request["baseline"]
    if args[0] == "--read-failing-ci-log":
        return {"repository": ci["repository"], "log": request["dependency"]["failures"][0]["evidence"]}
    if args[0] == "--read-issue":
        return {"issue": {"number": 99}}
    return {"--list-failing-ci": ci, "--pr-review": {"review_threads": []}, "--pull-action-state": request.get("queue", {})}[args[0]]


def worker(_lease, _args, **kwargs):
    (Path(kwargs["cwd"]).parent / "publication.json").write_text(json.dumps({
        "blocked": {"cause": "ci_only", "reason": "The supplied unit job failed"},
        **({"ciDependency": request["dependency"]} if request.get("dependency") else {})}))
    return SimpleNamespace(returncode=0, stdout="", stderr="")


# Native cleanup requires consistent directory device IDs, as on test boxes.
with TemporaryDirectory(dir="/dev/shm" if sys.platform == "linux" else None) as root:
    api.DB = Path(root) / "calls.sqlite3"
    api.RESPONSES = Path(root) / "responses"
    api.init_db()
    with patch.object(api, "CATALOG", SimpleNamespace(issue_review_model=lambda _identity: SimpleNamespace(identity="fixture", provider="codex"))), \
            patch.object(issue_review, "packet", return_value={"issue": {"title": "Seed", "body": "", "state": "open"}}), \
            patch.object(issue_review, "sweep"), \
            patch.object(issue_review, "interface", side_effect=interface), \
            patch.object(issue_review, "command", return_value=(["fixture"], "", {})), \
            patch.object(issue_review, "_terminal_failure", return_value=None), \
            patch.object(issue_review, "stop_leftovers"), patch.object(issue_review, "_cwd_pids", return_value=[]), \
            patch.object(api.atomic_work.checkout_lock, "Lease", return_value=MagicMock()), \
            patch.object(api.atomic_work.checkout_lock, "run_gated", side_effect=worker), \
            patch.object(api, "track", side_effect=track), patch.object(api, "_main", side_effect=execute):
        sys.argv = ["agent-interface", *argv]
        try:
            api.main()
        except api.atomic_work.AtomicWorkBlocked:
            pass
        else:
            raise AssertionError("expected a native CI-only repair failure")
    assert commands[:4] == ["--issue-work", "--list-failing-ci", "--pr-review", "--pull-action-state"]
    assert commands.count("--issue-work") == 1  # Preparation only; no publication or validation.
    print(json.dumps({"pending": pending, "released": api.logs()}))
