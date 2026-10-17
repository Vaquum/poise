# Analytics

**Analytics** in the burger menu opens a panel of headline numbers on the
right, below the control bar, the way Settings and Typography open. × or
Escape closes it, and so does the burger.

## The range

The panel opens on Today. The arrows move one calendar day backward or
forward; Next day is disabled on Today. Yesterday is named, and older days
show a date including the year. Days start at midnight in the timezone from
Settings → General, including daylight-saving transitions. Analytics does
not change Current's filters. The selected calendar date stays fixed across
midnight; labels and forward navigation refresh when the local day changes.

While a day or account loads, previous values are removed immediately and
the standard three-dot loading indicator appears. The server reads the local
datastore views directly, without starting a CLI process for each scope.

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
| Median time | The median time from opening to merge; even samples use the mean of the middle pair. |

Behaviors are read from Poise's own record of the reviews and approvals it
launched (`behavior_seen` in cache.db). One counts once its agent reported
the result: a clean review, a review requesting changes, or an approval. A
launch that failed or never finished counts nothing. Resolving conversations
is not recorded per pull request, so it is not counted. Issue reviews
comment on issues, not pull requests, and are not counted either.

## Seven-day trends

Opened, Closed, Merged and Lines changed compare the day's totals with the
preceding seven complete calendar days' daily averages, including zero days.
An upward green arrow means increased activity; a downward red arrow means
less activity. Partial line-size coverage withholds its comparison arrow; incomplete baseline
coverage also shows an unknown daily line average.

Time to merge shows the selected day's mean alongside the preceding seven
complete calendar days' rolling mean and merged PR count. Both means are
weighted by pull request, not by day. The selected day is excluded from the
baseline. Today is partial; its values update when the panel reads again.

A green downward arrow means faster merges; a red upward arrow means slower
merges. The figure is the percentage change against the baseline, with plain
text stating faster or slower. An unchanged mean shows a neutral arrow and
0%. A zero baseline uses the duration increase instead of dividing by zero.
No merges in either period means no directional comparison; an empty
baseline is explicitly labelled. Account read errors remain visible, and
comparative arrows are withheld while either period has partial account data.

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
`server/analytics.ts`. The panel reads the selected day and preceding seven-day
window through this endpoint; `medianTimeToMergeMs` accompanies the mean.

The menu and panel share a surface attached to the burger. Dates use a
previous/next day navigator. Metric explanations appear after half a second on hover
or on keyboard focus; missing data and coverage notes remain visible. See
[Menu and Settings](Menu.md).
