# Analytics

**Analytics** in the burger menu opens a panel of headline numbers on the
right, below the control bar, the way Settings and Typography open. × or
Escape closes it, and so does the burger.

## The range

The panel offers Current's ranges: Any time, Today, Yesterday and This week.
Days start at midnight and weeks on Monday, in the timezone from
Settings → General. The panel opens on the range Current shows. Picking
another range in the panel leaves Current as it is.

## What it counts

It counts what Current shows: the issues and pull requests your GitHub account
is involved in, plus what the agent account opened. Without a GitHub account
in Settings it counts everything in the datastore. The account filter narrows
it to one account, and the panel reads again when that changes.

| Number | What it is |
| --- | --- |
| Issues opened | Issues created in the range. |
| Issues closed | Issues closed in the range. |
| Pull requests merged | Pull requests merged in the range. |
| Lines changed | Additions plus deletions of the pull requests merged in the range. |
| Time to merge | The average time from a pull request's opening to its merge, over the pull requests merged in the range. |

Per merged pull request, over the pull requests merged in the range:

| Number | What it is |
| --- | --- |
| Comments | Conversation comments and review comments, on average. |
| Median lines | The median of additions plus deletions. |
| Behaviors | The reviews and approvals behaviors completed on them, on average, and how many of each. |

Behaviors are read from Poise's own record of the reviews and approvals it
launched (`behavior_seen` in cache.db). One counts once its agent reported
the result: a clean review, a review requesting changes, or an approval. A
launch that failed or never finished counts nothing. Resolving conversations
is not recorded per pull request, so it is not counted. Issue reviews
comment on issues, not pull requests, and are not counted either.

## When a number is missing

- No pull request merged in the range: the per-PR numbers show — and the
  panel says nothing was merged.
- github-datastore keeps a pull request's size since it started asking GitHub
  for it. A pull request stored before then has no size until the datastore's
  next full reconcile, which Poise runs daily. Until then the panel says how
  many merged pull requests the line counts come from, such as "From 40 of 52
  pull requests".
- An account whose datastore could not be read is named above the numbers,
  which come from the other accounts. If none could be read, the panel shows
  the error and no numbers.

## API

`GET /api/analytics?since=…&until=…&org=…` answers the panel. `since`
(inclusive) and `until` (exclusive) are times with a timezone, and either may
be left out; `org` narrows to one account. Implemented in
`server/analytics.ts`.
