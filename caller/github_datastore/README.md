# GitHub Datastore

Closed-world SQLite index of issues and pull requests in repositories owned by a GitHub account.

GitHub GraphQL is the only GitHub data interface. Everything stored locally is
projected from GraphQL nodes.

`init-org` accepts an organization or personal username; its name remains unchanged for compatibility.
Each database indexes only repositories owned by that account and visible to the authenticated user, including accessible private repositories. Collaborator repositories owned by other accounts are excluded.

## Commands

```bash
github-datastore init-org ORG
github-datastore init-org ORG --resume
github-datastore init-org ORG --include-repos repo-a,repo-b
github-datastore build-user LOGIN
github-datastore sync
github-datastore sync --reconcile --reconcile-sleep 17
github-datastore sync --loop --interval 60
github-datastore view pr --status open --format json
github-datastore view issue --author LOGIN --format csv
github-datastore view user --username LOGIN --item-type pr --limit 20
```

`github-datastore` and `python3 -m github_datastore` work from any directory on this host.
Every command takes `--db PATH`; without it the database is
`$XDG_DATA_HOME/github-datastore/github_datastore.sqlite`
(`~/.local/share/github-datastore/github_datastore.sqlite` when `XDG_DATA_HOME`
is unset). GitHub is read through `gh` only as the account whose token
`GH_TOKEN` holds (for example `GH_TOKEN=$(gh auth token --user LOGIN)`), never
gh's active account; without it, the commands that read GitHub fail.

## Trust Rule

An association exists only when the expanded issue/PR graph contains direct evidence for the username.

```text
stored(user,item) == direct evidence exists in expanded_issue_pr_graph(item)
```

REST and Search APIs are not used.

`sync` refreshes changed items. `sync --reconcile` performs full repo/item reconciliation.
`--include-repos` and `--exclude-repos` are mutually exclusive.

`init-org --resume` retains valid completed item expansions from an interrupted
build. The account and repository filter must match. Each retry checks current
repository/item identities, updates changed items, removes deletions, and catches
up before marking the index complete. Incomplete builds have no freshness marker.
Without `--resume`, initialization still clears and rebuilds the index.

Incremental sync batches the first issue/PR probe for up to 20 repositories per
GraphQL request. Subsequent pages share requests across up to 20 independent
issue/PR connections, using each connection's own returned cursor. Every page
and complete association graph is still read; total-count, identity and cursor
checks still reject incomplete enumeration.
A primary quota failure raises `GitHubRateLimitError` with `reset_at` (Unix seconds)
and `GITHUB_RATE_LIMIT_RESET=<seconds>` in the CLI error. Callers must wait until
that deadline before retrying; the CLI does not sleep through a quota window.

## Read Interface

Ad hoc SQL is not the consumer contract.

```python
from github_datastore import store

views = store.views

views.pr(status="open")
views.issue(author="LOGIN", created_since_datetime="2026-01-01T00:00:00Z")
views.user(username="LOGIN", item_type="pr", updated_since_datetime="2026-05-01T00:00:00Z")
```

Output is JSON by default. Use `output="csv"` for CSV.

```python
views.pr(status="open", output="csv")
```

`prs` exposes PR identity, status, author, owner, relative age in minutes, URL,
`diff_ref`, `payload_ref`, and comment/review/commit counts.

`issues` mirrors the PR shape where issue data exists.

`user_items` maps a user to issue/PR refs with footprint reasons and evidence count.
