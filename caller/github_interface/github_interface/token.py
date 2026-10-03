import os
import subprocess


def get_token(user: str | None = None) -> str:
    user = user or os.environ.get("GITHUB_INTERFACE_USER")
    command = ["gh", "auth", "token"]
    if user:
        command.extend(["--user", user])

    try:
        result = subprocess.run(command, check=True, capture_output=True, text=True)
    except FileNotFoundError as error:
        raise RuntimeError("GitHub CLI is required: gh auth login") from error

    token = result.stdout.strip()
    if not token:
        raise RuntimeError("GitHub CLI returned no token")
    return token
