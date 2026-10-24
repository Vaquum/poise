# GitHub Datastore Consumer Contract

Use this datastore for an account's GitHub issues, pull requests, and user footprint data.

Do not call `POST http://127.0.0.1:8788/github`. That is the old service.

## Health

Run:

```bash
github-datastore health --max-age-seconds 120
```

The command emits JSON and exits nonzero when `org.last_sync_at` is stale.
Consumers must complete this gate before each candidate scan.

## CLI

```bash
github-datastore view pr --status open --limit 50 --format json
github-datastore view issue --status open --limit 50 --format json
github-datastore view user --username LOGIN --limit 50 --format json
```

CSV:

```bash
github-datastore view pr --status open --limit 50 --format csv
```

## Python

```python
from github_datastore import store

views = store.views

prs_json = views.pr(status="open", limit=50)
issues_json = views.issue(status="open", limit=50)
user_items_json = views.user(username="LOGIN", limit=50)
prs_csv = views.pr(status="open", limit=50, output="csv")
```

## Views

### `views.pr(...)`

Pull requests.

Columns:

```text
pr_ref
repo
number
status
author
owner_login
owner_avatar
updated_at
created_at
closed_at
updated_minutes_ago
opened_minutes_ago
title
url
diff_ref
payload_ref
comments_count
review_comments_count
commits_count
additions
deletions
requested_reviewers
```

`additions` and `deletions` are the pull request's line counts as GitHub
reports them. They are `null` for a pull request not read since they were
added; the next full reconcile reads every pull request again.

`requested_reviewers` is the pull request's current requested reviewers as of
the last sync, a JSON array of logins. It is `null` for a pull request not
read since reviewers were added, and `[]` when none is requested. It never
carries the timeline's historical request events: a removed request disappears
from it on the next sync.

### `views.issue(...)`

Issues.

Columns:

```text
issue_ref
repo
number
status
author
owner_login
owner_avatar
updated_at
created_at
closed_at
updated_minutes_ago
opened_minutes_ago
title
url
payload_ref
comments_count
```

### `views.user(...)`

User footprint rows.

Columns:

```text
username
item_type
item_ref
repo
number
status
author
owner_login
owner_avatar
updated_at
created_at
closed_at
title
url
reasons
evidence_count
updated_minutes_ago
requested_reviewers
```

`requested_reviewers` is as in `views.pr`: the current requested reviewers,
`null` for issues and for rows from before reviewers were read.

## Filters

Supported filters:

```text
repo
status
author
number
username
item_type
updated_since_datetime
created_since_datetime
created_at_datetime
limit
output
```

`username` and `item_type` apply to `views.user(...)`.

`item_type` values:

```text
issue
pr
```

`output` values:

```text
json
csv
```

Datetimes must include timezone:

```text
2026-05-03T09:00:00Z
```

Examples:

```python
views.pr(status="open", repo="ORG/REPO", limit=20)

views.issue(
    author="LOGIN",
    updated_since_datetime="2026-05-03T09:00:00Z",
)

views.user(
    username="LOGIN",
    item_type="pr",
    status="open",
    limit=50,
)
```

## Freshness

Sync contract:

```text
delta sync: every 60 seconds
stale threshold: 120 seconds
full reconcile: daily
source: GitHub GraphQL only
```

If health fails, consumers must treat datastore output as stale.

When upstream changes while a connection is paged (a `totalCount` change or a
received-count mismatch), the reader discards the partial pass and restarts
that enumeration from its first page with the original watermark, up to three
attempts per enumeration. Persistent drift fails the sync without advancing
either watermark, so health keeps reporting stale until a complete sync
commits. Malformed responses, cursor violations, duplicate identities, missing
stored items and backward timestamps still fail on the first attempt.

Poise runs daily reconciliation in resumable 20-second work chunks between
ordinary syncs. A chunk may finish its in-flight GraphQL work beyond the budget.
Partial reconciliation does not advance either success watermark or invalidate
the last complete snapshot. `sync --reconcile --reconcile-max-seconds 20` returns
JSON with a boolean `reconcile_complete`; only `true` completes the daily cycle.
Every scheduler admission still requires the normal fresh-data health gate.
