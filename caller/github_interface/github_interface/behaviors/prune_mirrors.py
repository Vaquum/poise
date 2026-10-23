from pathlib import Path

from github_interface.atoms.mirror_cache import prune_mirrors

NO_AUTH = True


async def run(_, payload: dict[str, object]) -> dict[str, object]:
    root = payload.get("root")
    cap, now, fresh = payload.get("cap_bytes"), payload.get("now_ms"), payload.get("fresh_ms", 300_000)
    dry_run = payload.get("dry_run", False)
    if not isinstance(root, str) or not root or any(type(value) is not int for value in (cap, now, fresh)) or type(dry_run) is not bool:
        raise ValueError("root, integer cap/time/freshness and boolean dry-run are required")
    return prune_mirrors(Path(root), cap, now, fresh, dry_run)
