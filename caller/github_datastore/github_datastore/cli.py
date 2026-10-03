from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import views
from .db import DEFAULT_DB
from .health import health
from .store import build_user, init_org, sync_loop, sync_once


HELP = """\
Vaquum GitHub Datastore.

Consumer contract:
  github-datastore view pr
  github-datastore view issue
  github-datastore view user --username mikkokotila
  github-datastore health --max-age-seconds 120

Python:
  from github_datastore import store
  views = store.views
  views.pr(status="open")
  views.issue(author="mikkokotila", output="csv")
  views.user(username="mikkokotila", item_type="pr")

Views:
  pr     PR rows: repo, number, status, author, times, title, url, refs, counts.
  issue  Issue rows: repo, number, status, author, times, title, url, refs, counts.
  user   User footprint rows: username, item_type, repo, number, status, reasons.

Filters:
  --repo --status --author --number --username --item-type
  --updated-since-datetime 2026-05-01T18:00:00Z
  --created-since-datetime 2026-05-01T00:00:00Z
  --limit 20 --format json|csv

Default DB:
  {default_db}
"""


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="github-datastore",
        description="Vaquum GitHub Datastore.",
        epilog=HELP.format(default_db=DEFAULT_DB),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--db", default=DEFAULT_DB, help="SQLite database path")
    sub = parser.add_subparsers(dest="command", required=True)

    init_parser = sub.add_parser("init-org")
    init_parser.add_argument("org", help="GitHub organization or personal account login")
    init_parser.add_argument("--workers", type=int, default=8)
    init_parser.add_argument("--resume", action="store_true", help="Resume matching initialization without discarding completed expansions")
    init_parser.add_argument("--include-repos")
    init_parser.add_argument("--exclude-repos")

    user_parser = sub.add_parser("build-user")
    user_parser.add_argument("username")

    sync_parser = sub.add_parser("sync")
    sync_parser.add_argument("--loop", action="store_true")
    sync_parser.add_argument("--interval", type=int, default=60)
    sync_parser.add_argument("--workers", type=int, default=8)
    sync_parser.add_argument("--include-repos")
    sync_parser.add_argument("--exclude-repos")
    sync_parser.add_argument("--reconcile", action="store_true")
    sync_parser.add_argument("--reconcile-sleep", type=float, default=0.0)

    health_parser = sub.add_parser("health")
    health_parser.add_argument("--max-age-seconds", type=int, default=120)

    view_parser = sub.add_parser(
        "view",
        description="Read consumer views. No ad hoc SQL.",
        epilog=HELP.format(default_db=DEFAULT_DB),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    view_parser.add_argument("name", choices=("pr", "issue", "user"))
    view_parser.add_argument("--format", choices=("json", "csv"), default="json")
    view_parser.add_argument("--username")
    view_parser.add_argument("--item-type", choices=("issue", "pr"))
    view_parser.add_argument("--repo")
    view_parser.add_argument("--status")
    view_parser.add_argument("--author")
    view_parser.add_argument("--number", type=int)
    view_parser.add_argument("--updated-since-datetime")
    view_parser.add_argument("--created-since-datetime")
    view_parser.add_argument("--created-at-datetime")
    view_parser.add_argument("--limit", type=int)

    args = parser.parse_args(argv)
    db_path = Path(args.db)

    if args.command == "init-org":
        init_org(
            args.org,
            db_path,
            workers=args.workers,
            include_repos=parse_repo_list(args.include_repos),
            exclude_repos=parse_repo_list(args.exclude_repos),
            resume=args.resume,
        )
        print(f"initialized org {args.org} into {db_path}")
    elif args.command == "build-user":
        build_user(args.username, db_path)
        print(f"built user {args.username} into {db_path}")
    elif args.command == "sync":
        if args.loop:
            sync_loop(
                db_path,
                args.interval,
                workers=args.workers,
                include_repos=parse_repo_list(args.include_repos),
                exclude_repos=parse_repo_list(args.exclude_repos),
                reconcile=args.reconcile,
                reconcile_sleep=args.reconcile_sleep,
            )
        else:
            sync_once(
                db_path,
                workers=args.workers,
                include_repos=parse_repo_list(args.include_repos),
                exclude_repos=parse_repo_list(args.exclude_repos),
                reconcile=args.reconcile,
                reconcile_sleep=args.reconcile_sleep,
            )
            print(f"synced {db_path}")
    elif args.command == "view":
        rendered = run_view(db_path, args)
        sys.stdout.write(rendered)
        if not rendered.endswith("\n"):
            sys.stdout.write("\n")
    elif args.command == "health":
        result = health(db_path, args.max_age_seconds)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        if not result["healthy"]:
            raise SystemExit(1)
    else:
        raise AssertionError(args.command)


def run_view(db_path: Path, args: argparse.Namespace) -> str:
    common = {
        "db_path": db_path,
        "output": args.format,
        "repo": args.repo,
        "status": args.status,
        "author": args.author,
        "number": args.number,
        "updated_since_datetime": args.updated_since_datetime,
        "created_since_datetime": args.created_since_datetime,
        "created_at_datetime": args.created_at_datetime,
        "limit": args.limit,
    }
    if args.name == "pr":
        return views.pr(**common)
    if args.name == "issue":
        return views.issue(**common)
    if args.name == "user":
        return views.user(username=args.username, item_type=args.item_type, **common)
    raise AssertionError(args.name)


def parse_repo_list(value: str | None) -> list[str] | None:
    if value is None:
        return None
    repos = [part.strip() for part in value.split(",") if part.strip()]
    if not repos:
        raise ValueError("repo list is empty")
    return repos


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
