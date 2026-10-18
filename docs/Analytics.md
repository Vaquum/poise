# Analytics

**Analytics** in the burger menu opens a view of its own, like Current or
Behaviors, but reached from the menu rather than the top nav. The menu
closes and focus returns to the burger. No top-nav item is highlighted on
Analytics; the menu marks Analytics as the current page instead. A reload
stays on Analytics, and choosing a view in the top nav leaves it.

The page reads top to bottom:

1. **Productivity**: eight cards for issues opened and closed, pull requests
   merged, lines changed, time to merge, pull requests opened and closed
   without merging, and time to first review. Four columns by two rows.
2. **Per merged pull request**: five compact cards for comments, median lines,
   behaviors, median time and the share merged by the agent account.
3. **GitHub API · Live**: avatar-led user and automation account panels side
   by side, each holding REST and GraphQL budgets.

Every metric card has its value, seven-day comparison, weekly history line
and a ten-bin histogram. Productivity uses larger cards and taller plots than
per-PR metrics. Borders, colors, spacing and tooltip motion follow the shared
design system. Narrow layouts reduce columns without horizontal overflow.

## The day

The control bar holds the day: previous day, the date, next day. Analytics
opens on Today whenever it is chosen from the menu or the page loads; saving
settings while it shows keeps the chosen day. The arrows move one calendar
day backward or forward; Next day is disabled on Today. Yesterday is named,
and older days show a date including the year. Days start at midnight in the
timezone from Settings → General, including daylight-saving transitions.
Analytics does not change Current's filters. The selected calendar date stays
fixed across midnight; labels and forward navigation refresh when the local
day changes.

While a day or account loads, previous values are removed immediately and
the standard three-dot loading indicator appears. The server reads the local
datastore views directly, without starting a CLI process for each scope.
Leaving Analytics stops its reads: a late answer is discarded, and quota is
not refreshed until it is chosen again.

## What it counts

It counts what Current shows: the issues and pull requests your GitHub account
is involved in, plus what the agent account opened. Without a GitHub account
in Settings it counts everything in the datastore. The organization filter in the
control bar, shown with two or more organizations, narrows it to one. Its
shared default label is “All orgs”; every selected label is vertically centered. It is
the same choice Current, Swarm and Archive use, and Analytics reads again when
it changes.

Productivity:

| Number | What it is |
| --- | --- |
| Issues opened | Issues created in the range. |
| Issues closed | Issues closed in the range. |
| Pull requests merged | Pull requests merged in the range. |
| Lines changed | Additions plus deletions of the pull requests merged in the range. |
| Time to merge | The average time from a pull request's opening to its merge, over the pull requests merged in the range. |

Pull request flow:

| Number | What it is |
| --- | --- |
| Pull requests opened | Pull requests created in the range. |
| Closed without merging | Pull requests closed unmerged in the range. |
| Time to first review | The median time from a pull request's opening to its first review, over the first reviews submitted in the range. Shown down to the second: "45s", "3m 12s", then hours and days. |

A first review is the earliest review on GitHub (approved, changes requested,
commented or dismissed) submitted by anyone other than the pull request's
author, read from the datastore's `reviews` table. Reviews still pending are
not submitted and do not count; neither does the author's own review, which is
a reply. Poise's agent account counts like any other reviewer. Conversation
comments are not reviews.

Per merged pull request, over the pull requests merged in the range:

| Number | What it is |
| --- | --- |
| Comments | Conversation comments and review comments, on average. |
| Median lines | The median of additions plus deletions. |
| Behaviors | The reviews and approvals behaviors completed on them, on average, and how many of each. |
| Median time | The median time from opening to merge; even samples use the mean of the middle pair. |
| Merged by agent | The share of them the agent account from Settings merged, and how many of how many. With no agent account set it shows — and says so. |

Who merged comes from each merged pull request's stored GitHub record. Merges
measure the agent's share because the pull requests themselves are usually
opened under your own account.

Behaviors are read from Poise's own record of the reviews and approvals it
launched (`behavior_seen` in cache.db). One counts once its agent reported
the result: a clean review, a review requesting changes, or an approval. A
launch that failed or never finished counts nothing. Resolving conversations
is not recorded per pull request, so it is not counted. Issue reviews
comment on issues, not pull requests, and are not counted either.

## Seven-day trends

Issues opened, Issues closed, Pull requests merged, Lines changed, Pull
requests opened and Closed without merging compare the day's totals with the
preceding seven complete calendar days' daily averages, including zero days.
An upward green arrow means increased activity; a downward red arrow means
less activity. Partial line-size coverage withholds its comparison arrow; incomplete baseline
coverage also shows an unknown daily line average.

Time to merge shows the selected day's mean alongside the preceding seven
complete calendar days' rolling mean and merged PR count. Both means are
weighted by pull request, not by day. The selected day is excluded from the
baseline. Today is partial; its values update when Analytics reads again.

A green downward arrow means faster merges; a red upward arrow means slower
merges. The figure is the percentage change against the baseline, with plain
text stating faster or slower. An unchanged mean shows a neutral arrow and
0%. A zero baseline uses the duration increase instead of dividing by zero.
No merges in either period means no directional comparison; an empty
baseline is explicitly labelled. Account read errors remain visible, and
comparative arrows are withheld while either period has partial account data.

Time to first review compares the day's median with the median of the
preceding seven days' first reviews, and names how many there were. The
arrows read as they do for time to merge: green and downward is faster. A
zero baseline shows the increase in seconds.

Per-PR comparisons use the preceding seven days' merged population: averages
for comments and behaviors, medians for lines and time, and the agent's merge
share. Missing values or partial account/size coverage withhold trend claims.

## The past year

Under every metric a chart shows the year before the selected
day, one point per 7-day period: 52 periods, the last of them the seven days
before the selected day, which is the figure's own 7-day baseline. Issues
opened and closed, pull requests merged and lines changed are daily averages
over each period; time to merge is the mean of the pull requests merged in
it. Flow counts use daily averages; first review and per-PR values use the
same aggregation as their cards. Periods are calendar weeks in the timezone from Settings, so a week that
crosses a daylight-saving change is 167 or 169 hours long.

The line is grey with a light wash and the latest period is marked in blue.
Each chart's highest value is named above it. Hovering for half a second, or
focusing it and using the arrow keys, Home and End, shows a period's value,
what it is made of (such as "8 merged" or "Mean of 8 PRs") and its dates.
The readout explains the chart and its period boundaries. Below each line,
ten equal-width bins show the distribution of known weekly values. Empty
periods stay unknown for metrics that require observations; zero event
counts remain zero. Hover or focus explains the distribution. There is no
history table.

A period without merges has no time to merge, and one whose merged pull
requests are not all sized has no lines total; the line breaks there instead
of falling to zero, and a known value with unknown neighbours shows as a dot.
The year is read once per day and account, separately from the day's numbers,
and each chart keeps its place until it arrives. If it cannot be read, the
charts say "Past year unavailable" and the day's numbers stay.

## When a number is missing

- No pull request merged in the range: the per-PR numbers show — and the
  page says nothing was merged.
- github-datastore keeps a pull request's size since it started asking GitHub
  for it. A pull request stored before then has no size until the datastore's
  next full reconcile, which Poise runs daily. Until then the page says how
  many merged pull requests the line counts come from, such as "From 40 of 52
  pull requests".
- An account whose datastore could not be read is named above the numbers,
  which come from the other accounts. If none could be read, the page shows
  the error and no numbers.

## GitHub API quota

The last section is live, independent of the selected day and organization.
It shows the configured user and automation GitHub accounts separately,
side by side with avatars; a shared login appears once with both roles.
Only REST and GraphQL budgets appear. Each shows used
versus total, remaining capacity, next reset in Settings' timezone, minutes
left, observed use per minute and the remaining sustainable rate.

Reads use each account's stored `gh` credential explicitly. No credential or
HTTP stderr reaches the browser. An unavailable account shows an error while
the other account remains visible. A zero limit means that API is unavailable.
The reset comes from GitHub, including minute-long search windows; no hourly
start is inferred. Secondary abuse limits are not exposed by this endpoint.

Risk is an estimate, not a GitHub prediction: a Poisson request-count model
assumes the observed rate continues until reset. GraphQL uses quota points.
The rate uses counter differences within the same reset window over up to five
minutes; at least 15 seconds of evidence is required. Samples persist across
restarts. A reset, decreased counter, or five-minute observation gap starts
collection again. No history displays “collecting samples,” never a false 0%.
Probabilities round to whole percentages (below 0.5% displays 0%). Positive
risk through one third is yellow, through two thirds orange, and above that
red. Exhaustion is 100%; expired observations await the next refresh.

Analytics refreshes quota every 15 seconds while it is the view on screen
and the browser tab is visible. The server shares concurrent reads and a
15-second cache per login with the background monitor.
`GET /rate_limit` does not consume GitHub's primary API quota; it can count
toward secondary limits. See [GitHub's rate-limit documentation](https://docs.github.com/en/rest/rate-limit/rate-limit).

Each budget shows 24 stacked hourly columns (including this hour) for used
and remaining quota, normalized to its limit. The latest observation in each
hour is retained for seven days across restarts. A ten-bin histogram compares
the distributions of used and remaining percentages across those observations;
it names the observed hours out of 168. Missing hours are empty, never carried
forward or invented. History starts collecting when this version first runs.
Both charts use the existing quota response and unchanged 15-second polling;
no extra GitHub requests are made. Avatars use the same cached GitHub image
URLs as other views, without a profile API request.

`GET /api/github-quota` returns `{ accounts }`. Each account contains `login`,
`roles` (`user`, `automation`), `checkedAt`, `error`, and `buckets`. A bucket
contains `resource`, `label`, `limit`, `used`, `remaining`, `resetAt`,
`perMinute`, and `riskPercent`, plus `history` on REST and GraphQL buckets (hourly
`at`, `used`, `remaining`, `limit` observations); rate and risk are null without usable evidence.

## Daily analytics API

`GET /api/analytics?since=…&until=…&org=…` answers the view. `since`
(inclusive) and `until` (exclusive) are times with a timezone, and either may
be left out; `org` narrows to one account. Implemented in
`server/analytics.ts`. The view reads the selected day and preceding seven-day
window through this endpoint; `medianTimeToMergeMs` accompanies the mean. The
report also names `agentAccount` (null when none is set) and gives, under
`pullRequests`, `opened`, `closedUnmerged`, `mergedByAgent` (null without an
agent account) and `firstReview` with its `count` and `medianMs`.

`GET /api/analytics/history?bounds=…&org=…` answers the past year. `bounds`
lists the period edges, comma-separated times with a timezone, increasing,
2 to 80 of them; each period runs from one edge (inclusive) to the next
(exclusive). The answer is `{ periods, errors }`: each period has `since`,
`until`, `issues` (`opened`, `closed`) and `pullRequests` (`merged`, `lines`
with `total`, `median` and `counted`, and every flow and per-PR field from
the daily report), counted exactly as the day is. The server reads local
datastores once across all periods and uses the existing behavior ledger;
this adds no upstream requests.

Measurement explanations appear after half a second on hover or keyboard
focus. Headings stay plain and have no tooltips or dotted underlines. Risk
assumptions and sample requirements live on the risk measurement itself;
missing data and coverage notes remain visible. See
[Menu and Settings](Menu.md).
