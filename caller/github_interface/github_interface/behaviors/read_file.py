from typing import Any

from github_interface.atoms.files import read_test_file

NO_AUTH = True


async def run(client: None, payload: dict[str, Any]) -> dict[str, Any]:
    path = str(payload.get("path", "")).strip()
    if not path:
        raise ValueError("path is required")
    return {"action": "read_file", "path": path, "content": read_test_file(path)}
