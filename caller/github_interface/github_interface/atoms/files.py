from pathlib import Path


def list_test_files(root: Path | None = None) -> list[str]:
    tests = _tests_root(root)
    if not tests.exists():
        return []
    return [f"/tests/{path.relative_to(tests)}" for path in sorted(tests.rglob("*.py")) if path.is_file()]


def read_test_file(path: str, root: Path | None = None) -> str:
    target = _repo_path(path, root)
    if not target.is_file():
        raise ValueError(f"file not found: {path}")
    return target.read_text()


def write_test_file(path: str, content: str, root: Path | None = None) -> str:
    target = _repo_path(path, root)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content)
    return f"/{target.relative_to(_repo_root(root))}"


def _tests_root(root: Path | None = None) -> Path:
    return (_repo_root(root) / "tests").resolve()


def _repo_root(root: Path | None = None) -> Path:
    return (root or Path.cwd()).resolve()


def _repo_path(path: str, root: Path | None = None) -> Path:
    value = str(path).strip()
    if not value.startswith("/"):
        raise ValueError("path must start with /")
    raw = Path(value.lstrip("/"))
    if not raw.parts or ".." in raw.parts:
        raise ValueError("path must stay under repo root")

    repo = _repo_root(root)
    target = (repo / raw).resolve()
    if repo != target and repo not in target.parents:
        raise ValueError("path must stay under repo root")
    return target
