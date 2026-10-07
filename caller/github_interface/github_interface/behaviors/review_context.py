import json
import os
from pathlib import Path

from github_interface.atoms.review_checkout import inspect

NO_AUTH = True


async def run(client, payload):
    root = os.environ.get("GITHUB_INTERFACE_REVIEW_ROOT")
    if not root:
        raise ValueError("repository inspection requires a Caller review checkout")
    return inspect(Path(root), json.loads(payload["requests_json"]))
