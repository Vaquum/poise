from typing import Any

from github_interface.atoms.files import list_test_files

NO_AUTH = True


async def run(client: None, payload: dict[str, Any]) -> dict[str, Any]:
    return {"action": "list_test_files", "files": list_test_files()}
