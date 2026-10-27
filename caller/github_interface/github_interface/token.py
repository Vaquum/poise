import subprocess


def get_token(user: str) -> str:
    # gh's active account is never a fallback: a workspace has several
    # accounts signed in, and the wrong one would post as someone else.
    if not user:
        raise ValueError("a GitHub account is required")
    try:
        result = subprocess.run(["gh", "auth", "token", "--user", user], check=True, capture_output=True, text=True)
    except FileNotFoundError as error:
        raise RuntimeError("GitHub CLI is required: gh auth login") from error
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or "").strip()
        raise RuntimeError(f"gh has no token for {user}; sign in with gh auth login as {user}" + (f": {detail}" if detail else "")) from error

    token = result.stdout.strip()
    if not token:
        raise RuntimeError("GitHub CLI returned no token")
    return token
