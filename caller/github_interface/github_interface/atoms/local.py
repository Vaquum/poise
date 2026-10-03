import base64
import fcntl
import os
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlparse

# One bare mirror per repository, outside ~/dev, so a fresh checkout is a
# local clone instead of a full download.
MIRROR_ROOT = Path(os.getenv("GITHUB_INTERFACE_MIRROR_DIR") or Path.home() / ".cache" / "github-interface" / "mirrors")


def checkout_path(org: str, repo: str, root: Path | None = None) -> str:
    target = f"{org}/{repo}".lower()
    root = root or Path.home() / "dev"

    for current, dirs, _ in os.walk(root):
        if ".git" in dirs:
            remote = _remote(current)
            if remote and remote.lower() == target:
                return str(Path(current).resolve())
            dirs[:] = []
        else:
            dirs[:] = [d for d in dirs if d not in {"node_modules", ".venv", "__pycache__"}]

    raise ValueError(f"checkout not found under {root}: {org}/{repo}")


def current_branch(path: Path | None = None) -> str:
    result = subprocess.run(
        ["git", "-C", str(path or Path.cwd()), "branch", "--show-current"],
        capture_output=True,
        text=True,
    )
    branch = result.stdout.strip()
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout).strip())
    if not branch:
        raise ValueError("checkout has no current branch")
    return branch


def checkout_pr_head(owner: str, repo: str, pull_number: int, token: str, path: Path | None = None) -> dict[str, str]:
    path = path or Path.cwd()
    branch = f"github-interface-pr-{pull_number}"
    remote = f"https://github.com/{owner}/{repo}.git"
    header = f"http.extraHeader=Authorization: Bearer {token}"
    ref = f"refs/pull/{pull_number}/head"

    fetch = _run(["git", "-C", str(path), "-c", header, "fetch", "--force", remote, ref], token)
    checkout = _run(["git", "-C", str(path), "checkout", "-B", branch, "FETCH_HEAD"], token)
    return {"branch": branch, "fetch": fetch, "checkout": checkout}


def checkout_repo(
    owner: str,
    repo: str,
    branch: str,
    token: str,
    path: Path,
    root: Path | None = None,
    remote: str | None = None,
) -> dict[str, str]:
    """A fresh, independent clone of the default branch with full history.
    The token is passed per command and never stored in either repository."""
    if not path.is_absolute():
        raise ValueError("path must be absolute")
    if path.exists():
        raise ValueError(f"path already exists: {path}")
    remote = remote or f"https://github.com/{owner}/{repo}.git"
    mirror = (root or MIRROR_ROOT) / owner / f"{repo}.git"
    mirror.parent.mkdir(parents=True, exist_ok=True)
    # Git over HTTPS takes the token as Basic credentials; GitHub rejects a
    # Bearer header there for OAuth tokens.
    basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
    header = f"http.extraHeader=Authorization: Basic {basic}"
    def refresh() -> None:
        if not (mirror / "HEAD").exists():
            _run(["git", "-c", header, "clone", "--bare", "--quiet", remote, str(mirror)], token, basic)
        _run(["git", "-C", str(mirror), "-c", header, "fetch", "--quiet", "--prune", remote,
              "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"], token, basic)
        _run(["git", "clone", "--quiet", "--branch", branch, str(mirror), str(path)], token)

    with open(mirror.parent / f"{repo}.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            refresh()
        except RuntimeError:
            # A git killed mid-fetch can leave the mirror locked or partial.
            # Nobody else uses it while we hold the lock: start it over once.
            shutil.rmtree(mirror, ignore_errors=True)
            shutil.rmtree(path, ignore_errors=True)
            refresh()
    _run(["git", "-C", str(path), "remote", "set-url", "origin", remote], token)
    return {"branch": branch, "head_sha": _run(["git", "-C", str(path), "rev-parse", "HEAD"], token)}


def commit_work(head_repo: str, head_ref: str, message: str, token: str, path: Path | None = None) -> dict[str, str]:
    path = path or Path.cwd()
    branch = _run(["git", "-C", str(path), "rev-parse", "--abbrev-ref", "HEAD"], token)
    if branch == "main":
        raise RuntimeError("refusing to commit from main")

    remote = f"https://github.com/{head_repo}.git"
    header = f"http.extraHeader=Authorization: Bearer {token}"
    add = _run(["git", "-C", str(path), "add", "-A"], token)
    commit = _run(["git", "-C", str(path), "commit", "-m", message], token)
    push = _run(["git", "-C", str(path), "-c", header, "push", remote, f"HEAD:refs/heads/{head_ref}"], token)
    return {"branch": branch, "add": add, "commit": commit, "push": push}


def _run(command: list[str], token: str, *secrets: str) -> str:
    result = subprocess.run(command, capture_output=True, text=True)
    output = (result.stderr or result.stdout) if result.returncode != 0 else (result.stdout or result.stderr)
    for secret in (token, *secrets):
        output = output.replace(secret, "***")
    if result.returncode != 0:
        raise RuntimeError(output.strip())
    return output.strip()


def _remote(path: str) -> str | None:
    result = subprocess.run(["git", "-C", path, "remote", "get-url", "origin"], capture_output=True, text=True)
    if result.returncode != 0:
        return None

    remote = result.stdout.strip().removesuffix(".git")
    raw_path = remote.rsplit(":", 1)[1] if "@" in remote and ":" in remote else urlparse(remote).path.strip("/")
    parts = raw_path.split("/")
    if len(parts) >= 2:
        return f"{parts[-2]}/{parts[-1]}"
    return None
