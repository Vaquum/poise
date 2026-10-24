# GitHub Datastore

Closed-world SQLite index of issues and pull requests in repositories owned by a GitHub account.

GitHub GraphQL is the only GitHub data interface. Everything stored locally is
projected from GraphQL nodes.

`init-org` accepts an organization or personal username; its name remains unchanged for compatibility.
Each database indexes only repositories owned by that account and visible to the authenticated user, including accessible private repositories. Collaborator repositories owned by other accounts are excluded.

Disabling a repository's Issues feature omits only Issue collection. Pull
requests remain indexed during initial loading, incremental sync and
reconciliation. An Issues-setting transition triggers full enumeration;
normal sync also recovers PRs omitted by earlier versions without resetting
downstream behavior state.

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
github-datastore view pr-reviews --repo OWNER/REPO --number 123 --page-size 200 --review-after 0 --comment-after 0
github-datastore view pr-dependents --repo OWNER/REPO --number 123
github-datastore view pr-closing --limit 50
```

`pr-reviews --page-size N` (1–200) bounds reviews and comment identities separately.
Pass back `page.next_review_after` and `page.next_comment_after`; a zero
cursor restarts that lane to revisit updates and reopened older threads. For each thread represented in that comment page, its summary contains only
its latest comment, with a content revision hash. Repeated thread summaries
across pages deduplicate at the consumer. Bounded `comments` summaries carry
raw-comment identity, thread resolution and body revision, so editing an older
root comment remains visible after a newer reply. `has_unresolved` includes
threads outside the page. `truncated` means more identities remain, not that
returned feedback should be discarded; absence from a page proves nothing
about an older identity. Without `--page-size`, the legacy capped read remains
available. All reads are local and preserve shared-account authors without
claiming to know which chat posted them. The paged read requires the indexes
created by the normal datastore initialization/sync migration; an unmigrated
database fails the read instead of scanning full histories without those indexes.

`pr-dependents` returns one pull request's closed issues and their open
dependents: `found`, the PR `title`, `closed` with each issue's state,
`closes_via` (`closing-references`, or `body-keywords` when the stored read
predates dependency tracking), and `dependents` with `via` naming
`blocked-by`, `depends-on`, or both. A dependent is an open issue in the same
repository that GitHub lists as blocked by a closed issue, or that lists it
under a `Depends on:` header in its body, inline or as list items. At most 100
closed issues and 50 dependents are returned; `truncated` means a cap or a
malformed stored connection hid entries. Blocked-by edges ride the existing issue query, so a
dependent last synced before they were tracked reads as unblocked until its
next sync; `Depends on:` works from long-synced bodies.

`pr-closing` lists open pull requests with the issues each closes: `prs`
with each PR's `repo`, `number`, `url`, `closing` refs, `closes_via`
(`closing-references`, or `body-keywords` when the stored read predates
dependency tracking) and `closing_truncated`, and `truncated` when a cap or
a malformed stored connection hid entries. A pull request with
`closing_truncated` carries an incomplete closing list; matching on it
would misbind, so consumers must skip it. At most 500 pull requests and 100
closing refs per pull request are returned; `--repo` scopes the list to one
repository and `--limit` lowers the pull request cap. `more` means further
pull requests follow: pass the last returned cursor back until it clears,
the number as `--after-number` with the same `--repo`, or the pair as
`--after-repo`/`--after-number` for an unscoped list. All reads are local
rows; the sync owns freshness.

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
Reconciliation resumes durable repository/item checkpoints after interruption.
`sync --reconcile --reconcile-max-seconds 20` yields after the work budget
(checked after item expansions and repositories) and emits
`{"reconcile_complete": false}` until the full cycle finishes. In-flight
GraphQL work can overrun the budget. A partial chunk leaves both sync and
reconciliation success watermarks unchanged; ordinary delta syncs can run
between chunks. The last complete snapshot remains available under the normal
freshness gate. Re-enumeration discovers additions/removals and re-expands changed
items; a new completed cycle discards its checkpoints. Legacy full-build retry
markers also resume item expansion after a timeout.
`--include-repos` and `--exclude-repos` are mutually exclusive.

`init-org --resume` retains valid completed item expansions from an interrupted
build. The account and repository filter must match. Each retry checks current
repository/item identities, updates changed items, removes deletions, and catches
up before marking the index complete. Incomplete builds have no freshness marker.
Without `--resume`, initialization still clears and rebuilds the index.

Incremental sync batches the first issue/PR probe for up to 20 repositories per
GraphQL request. Subsequent pages share requests across up to 20 independent
issue/PR connections, using each connection's own returned cursor. Every page
and complete association graph is still read. When upstream changes while a
connection is paged, the reader discards the partial pass and restarts that
enumeration from its first page with the original watermark, up to three
attempts; persistent drift still fails the sync without advancing freshness.
Identity, cursor, missing-item and backward-timestamp checks still reject on
the first attempt.
A primary quota failure raises `GitHubRateLimitError` with `reset_at` (Unix seconds)
and `GITHUB_RATE_LIMIT_RESET=<seconds>` in the CLI error. Callers must wait until
that deadline before retrying; the CLI does not sleep through a quota window.

The bounded live proof below, run from the repository root, compares two public
PR continuation pages fetched separately and together. It requires exact
page-payload equality and a reduction in GitHub's reported `rateLimit.cost`,
using four read-only calls:

```bash
caller/.venv/bin/python scripts/measure-github-pagination.py --token-user LOGIN
```

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
