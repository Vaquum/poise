from typing import Any

from github_interface.atoms.files import write_test_file

NO_AUTH = True


async def run(client: None, payload: dict[str, Any]) -> dict[str, Any]:
    path = str(payload.get("path", "")).strip()
    if not path:
        raise ValueError("path is required")
    if "content" not in payload:
        raise ValueError("content is required")
    written = write_test_file(path, str(payload["content"]))
    return {"action": "write_file", "path": written}
