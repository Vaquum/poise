# Analytics

Analytics is Overview's tiles: the day's eight numbers
with their pace and year, under each year the 30 days before it in five bins,
then the five per merged pull request, work type and review. Drag a tile to
reorder them; the order is kept in this browser. Each tile reads the same
metrics this page defines.

## System health

The five cards use verified v2 chain ownership, retaining the original seed
identity after PR publication. They refresh with the existing Analytics tick
and organization selection, independently of the selected calendar day. The
read-only `/api/analytics/system-health` projection uses the existing journal,
original Caller receipts, GitHub observations and coverage history; it starts
no polling or work. Each card opens Logging, and counted items link to their
existing chain journal evidence.

- **Errors per completed work item** divides distinct work-error incidents over
  each completed item's lifetime by distinct seeds merged in the trailing 24
  hours. The cohort uses GitHub's own `mergedAt` for the chain's merge commit,
  from any observation of the merged pull request: the chain's own publication,
  or the existing pull request that closed the seed. Poise's copy of its
  publication may lag a read behind; observation and later review-reconciliation
  times are never used. Error-free completions count too.
  Execution failures include authentication and transport warnings; successful
  preparation warnings, ordinary review/CI feedback, stopped, superseded and
  closed-target no-effect outcomes do not count. Repeated incident observations
  count once per item. Errors come from the chain journal, which keeps every
  settled run, so gaps in the observational ledger's coverage do not withhold
  the rate. While a counted item still has a run admitted before its merge that
  has not settled, the rate is shown as a lower bound (**at least**) with how
  many items are still being reconciled. Both counts always show; the rate
  itself says **None completed** when nothing merged in the window, and
  **Unknown**, with the reason in words, when an account's GitHub evidence is
  not ok or a merged chain's GitHub merge time is unknown.
- **Work blocked** counts held, uncertain or overdue seeds, including those
  without a PR, with oldest verified progress age and the largest stage.
  Known healthy waits, including draft and queue waits older than 24 hours,
  take precedence over age unless independently held, uncertain or verified
  overdue. Re-reading unchanged evidence does not advance progress.
- **Auto recovery** counts each seed once per outcome in the last 24 hours.
  A recorded automatic retry needs a successful original receipt and verified
  forward progress. Outside intervention uses its action time and retains
  failure-linked reconnect/provider verification or a recorded operator Resume
  followed by verified retry progress. Resume, retry launch or merge alone
  proves no recovery. A later merge preserves resolving outside help; old
  ambiguous origins remain unknown. Evidence names the failed Call, action,
  origin and resumed progress time.
- **Time since last work error** uses the same failure rule, including active
  work. It includes the occurrence timestamp and says **Last observed error**
  when subsequent coverage is incomplete. Without errors it shows the covered
  interval with no observed error, or unavailable when coverage is unknown.
- **Evidence coverage** separates current source status from retained history.
  Caller coverage bars distinguish covered time, gaps and unknown intervals;
  journal and account sources without measured interval coverage show status
  without a numeric bar. Rows name scope/interval and last successful read.
  Instance-wide dependencies, excluded legacy work and unavailable or
  initializing accounts remain explicit limits. A failed refresh visibly marks
  retained values stale with their original read time and scope. A successful
  refresh does not clear historical coverage gaps.

Five cards share one row where space permits and wrap on narrower screens.

## The day

Overview's right-hand side has one set of filters, at its top right: the day
(previous day, the date, next day), a search, and the organization. They apply
to every panel on that side. The day is its only time filter: the day's
numbers and the behaviors' runs, time and success follow it, and In motion,
System health and the GitHub API quota, which are live, say *not for* the
chosen day when it is not Today. The search shows in each panel only what
matches its words, ignoring case: In motion lists every matching chat, issue,
pull request or task whatever its state, with counts to match; the day's
numbers, System health's cards, the behaviors and the API accounts show the
matching ones. A panel with no match says so, and Escape clears the search.

The day opens on Today whenever Overview is entered; saving
settings while it shows keeps the chosen day. The arrows move one calendar
day backward or forward; Next day is disabled on Today. Yesterday is named,
and older days show a date including the year. Days start at midnight in the
timezone from Settings → General, including daylight-saving transitions.
Analytics does not change Board's filters. The selected calendar date stays
fixed across midnight; labels and forward navigation refresh when the local
day changes.

Overview keeps today's last numbers across visits and refreshes them in place
on return. With no retained result, it shows that the day's numbers are being
read. Day and baseline reads share an in-flight request for the same scope;
year history and quota load independently. A failed refresh keeps the last
known totals and shows the failure beside them and in Answer here. Initial
failures leave values unknown, never replaced with zero counts.

The server reads the local datastore views directly, without starting a CLI
process for each scope.
Each datastore read runs in a one-shot worker thread using the captured account
configuration and involvement scopes. SQLite work therefore completes without
repeatedly yielding into the server's command-launch and background-work queue.
The worker is terminated after its result, error, client disconnect or
15-second read deadline. Account read errors retain partial reports; exceeding
the whole-request deadline fails the request rather than inventing partial totals.
Its production asset is required rather than falling back to the server thread.
Analytics' short-lived read-only connections allow up to 1 GiB of mapped
database address space per account, avoiding repeated page copies through the
service sandbox. This is not a heap allocation or a stored database change;
each connection retains its transaction snapshot, including with WAL writers
and checkpoints. Pages beyond the cap use ordinary SQLite I/O. Mapped pages
contribute file-backed RSS separately from JavaScript heap use.
[SQLite's mapped-I/O tradeoff](https://www.sqlite.org/mmap.html) applies:
a mapped-page I/O fault can terminate the process. Never overwrite an active
datastore in place; the supported deployment restore creates fresh volumes
([Operating](Operating.md)).
Each account read keeps one database snapshot and yields between accounts
inside its worker after 64 scanned candidates or once eight milliseconds of processing have elapsed. Discussion
counts and stored JSON for sizes and merger identity are read only for pull
requests merged inside the requested window. Openings, closings and first
reviews do not parse unrelated discussion payloads. Separate workers keep
year-history SQLite reads off the server thread that serves day and quota reads.
Involvement membership comes directly from the indexed associations, without
aggregating the evidence descriptions that the full user view supplies.
The date filter seeks each repository's existing update-time index before
reading item payloads and checking indexed membership. This changes only the
Analytics query and needs no datastore migration. Range candidates stream to the
yield loop even when their item type or involvement does not match; only matching
records enter the report. A dense dated window therefore collects no complete ID
list before its first possible yield. Merged
PR sizes and merger identity come from one parse of each stored payload.
The selected day and its baseline load first. The year and 30-day history
requests start after the cards render, so their scans cannot delay the initial appearance.
Leaving Analytics stops its foreground reads: a late answer is discarded, and
history and quota are not refreshed until it is chosen again. Day preparation
continues on shared ticks only while the browser tab is visible.

While Analytics and its browser tab are visible, the shared refresh clock
quietly rereads the selected day's numbers and seven-day baseline from local
SQLite. It uses the refresh interval from Settings: one minute by default, or
five minutes. Returning to the visible tab refreshes once; overlapping refreshes
share the pending read. The selected calendar date stays chosen, and the year
history is not reread. Quota keeps its separate refresh schedule.

The current values, charts and chart cursor stay in place during refreshes.
A successful read replaces totals and their pace timestamp together. A failed
request, or an account becoming unreadable in either report, preserves the
previous snapshot and reports the failure in Notifications. A snapshot that
already lacks an account can still refresh its other accounts while the same
account remains unreadable. Readable stale caches update with the existing
sync warning and comparisons over the stored totals.
These local reads make no GitHub requests and consume no GitHub API quota.
They show the datastore's latest stored records; freshness still depends on
the existing GitHub sync, whose schedule and requests are unchanged.

## What it counts

It counts what Current shows: the issues and pull requests your GitHub account
is involved in, plus what the agent account opened. Without a GitHub account
in Settings it counts everything in the datastore. The organization filter in the
control bar, shown with two or more organizations, narrows it to one. Its
shared default label is “All orgs”; every selected label is vertically centered. It is
the same choice Board and Observe use, and Analytics reads again when
it changes.

Productivity:

| Number | What it is |
| --- | --- |
| Pull requests opened | Pull requests created in the range. |
| Pull requests merged | Pull requests merged in the range. |
| Closed without merging | Pull requests closed unmerged in the range. |
| Lines changed | Additions plus deletions of the pull requests merged in the range. |
| Time to first review | The median time from a pull request's opening to its first review, over the first reviews submitted in the range. Shown down to the second: "45s", "3m 12s", then hours and days. |
| Time to merge | The median time from a pull request's opening to its merge, over the pull requests merged in the range. |
| Issues opened | Issues created in the range. |
| Issues closed | Issues closed in the range. |

A first review is the earliest review on GitHub (approved, changes requested,
commented or dismissed) submitted by anyone other than the pull request's
author, read from the datastore's `reviews` table. Reviews still pending are
not submitted and do not count; neither does the author's own review, which is
a reply. Poise's agent account counts like any other reviewer. Conversation
comments are not reviews.

Per merged pull request, over the pull requests merged in the range:

| Number | What it is |
| --- | --- |
| Comments | Median conversation comments plus review comments per merged pull request. |
| Median lines | The median of additions plus deletions. |
| Behaviors | Median completed review and approval behaviors per merged pull request, with totals by kind in the measurement tooltip. |
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

Pull requests opened, Pull requests merged, Closed without merging, Lines
changed, Issues opened and Issues closed use the median of the preceding seven
complete calendar days' totals, including zero days. For Today, the comparison
is `typical = median × clamp((readTime − since) / (until − since), 0, 1)`.
`readTime` is captured when the totals read starts; `since` and `until` are
that read's calendar edges in Settings' timezone. Elapsed time and day length
use actual milliseconds, including 23- and 25-hour daylight-saving days.
For example, 10 elapsed hours of a 25-hour day with a 27/day median gives 10.8.

Today's cards retain the actual total and full-day seven-day median and show
“Typical by now.” For counts other than Closed without merging, above 110% of
that typical value, the total and upward arrow are green and the percentage
says “ahead of pace.” Below 90%, they are red with a downward arrow and “behind
pace.” From 90% through 110%, inclusive, the total and neutral arrow are white
and say “On pace.” Classification and percentages
use the unrounded typical value; Typical displays one decimal, and percentages
at most one. An outside-band percentage that would round to 10% displays
“>10%.” Every positive typical value qualifies, without a minimum count,
elapsed-time floor or percentage cap. For example, 15 merges against a 27/day
median after 10 hours of a 24-hour day uses 11.25 to show “Typical by now: 11.3”
and “33.3% ahead of pace.”

Closed without merging treats fewer as better on Today and completed days.
Today keeps the same inclusive ±10% neutral band; below it, a green downward
arrow says “below typical,” and above it, a red upward arrow says “above
typical.” Zero closures against a positive typical is green. When typical is
zero, zero closures is neutral “On pace”; a positive count is red with an
upward arrow and absolute increase, without dividing by zero.

Except for that zero-typical closure comparison, a zero typical value withholds
the arrow, percentage and directional color. Missing daily data or partial
line-size coverage in either report also withholds these for the affected tile.
An unreadable account in either report withholds these for every Today
cumulative tile. Readable caches with sync warnings retain their colors, arrows
and comparisons over the stored totals; the warning remains in Notifications.
Known totals, Typical and median remain visible: zero Typical shows 0.0, an unknown baseline shows —,
and partial current lines retain their count and coverage note beside the known
baseline context.

Pacing uses the existing baseline response's seven daily totals. Its comparison
stays with the totals snapshot between successful local reads, including when
history arrives or quota refreshes. Each paced value's keyboard-accessible
tooltip gives the snapshot date, time and Settings timezone; the visible label
stays “Typical by now.” Opening Analytics, choosing a day or organization,
saving Settings and the visible refresh clock renew the snapshot. At midnight
or on returning to the tab, calendar labels, forward navigation and the
completed-day comparison update even if the local read fails; the retained
totals keep their selected date. History is not reloaded. Pacing reuses these
local reads and makes no GitHub requests.

Completed days retain the full-day comparison: activity increases are green
and decreases red, with Closed without merging using the inverse colors.
An unchanged value has a neutral arrow and 0%. A zero
baseline uses an absolute change rather than division by zero. The weekly
history lines and histograms remain unchanged.

Time to merge and Time to first review compare the selected day's median
with the median of the preceding seven days' observations and name the sample
count. The selected day is excluded. Today is partial. A green downward arrow
means faster; a red upward arrow means slower. The colored arrow sits beside
the value, with the matching percentage delta and baseline underneath. An
unchanged value shows a neutral arrow and 0%; a zero baseline uses an absolute
change rather than division by zero. Without observations, no directional
claim is made. Durations and per-PR metrics compare full-day observations
without elapsed-day adjustment or the pacing tolerance.

Per-PR comments and behaviors show selected-day medians and compare with
the median across the preceding seven days' merged pull requests. Lines and
time compare population medians. For Median lines, a smaller value is green
with a downward arrow and a larger value is red with an upward arrow; an
unchanged value is neutral. Agent merges compare shares, explicitly
labelled “7-day share” because a binary merger's median would lose the share.
An unreadable account withholds comparisons. A readable cache with a sync
warning retains the existing completed-day, duration and per-PR comparisons
over its stored records, including Today's cumulative pace. The warning is
notified.

## The past year

Under every metric a chart shows the year before the selected
day, one point per 7-day period: 52 periods, the last of them the seven days
before the selected day, which covers the same dates as its 7-day baseline. Issues
opened and closed, pull requests merged and lines changed are daily averages
over each period; time to merge is the median of the pull requests merged in
it. Flow counts use daily averages; first review and per-PR values use the
same aggregation as their selected-day cards. Count history uses weekly daily averages even though the comparison uses daily medians. Periods are calendar weeks in the timezone from Settings, so a week that
crosses a daylight-saving change is 167 or 169 hours long.

The line is grey with a light wash and the latest period is marked in blue.
Each chart's highest value is named above it; the redundant “52 weeks” and
“Distribution” labels are omitted. Hovering for half a second, or
focusing it and using the arrow keys, Home and End, shows a period's value,
what it is made of (such as "8 merged" or "Mean of 8 PRs") and its dates.
The readout explains the chart and its period boundaries. Below Productivity and
Per merged pull request lines, five equal-width bins span the chart and show
the 30 completed calendar days preceding the selected day. Each day contributes
one observation in the selected organization scope and Settings timezone,
including 23/25-hour days across daylight-saving changes; the selected day is
excluded. Event counts and changed lines use daily totals; durations and per-PR
metrics use one daily median or share. Unknown daily values are excluded,
including line totals and median sizes with partial coverage; real zero counts
remain zero. Edge labels show the full bin range, and hover or focus explains
the daily population and bin counts. Constant values occupy the first bin;
no known observations leave five empty bins and a — marker. There is no history table.

A period without merges has no time to merge, and one whose merged pull
requests are not all sized has no lines total; the line breaks there instead
of falling to zero, and a known value with unknown neighbours shows as a dot.
The year and daily distributions are read separately from the day's numbers,
with one bounded 30-day history read shared by all affected cards. Each chart
keeps its place until its read arrives. Read failures leave the corresponding
chart space empty and appear in Notifications; a failed distribution read
retains the weekly lines and the day's numbers. Day, organization and timezone
changes cancel prior history reads and discard their late responses.

## Work and review

All three cards use the pull requests merged on the selected day and the existing
account/involvement scope. Work type groups case-insensitive Conventional Commit
title prefixes: feat, fix, perf, refactor, docs, test, build, ci, chore, style
and revert. Other titles remain unclassified, included in the denominator. The
headline is the largest category's share; ties use the listed prefix order,
with unclassified last. Auto-generated `Revert "…"` titles are unclassified;
`revert: …` is recognized. Work type has no baseline or year history. Neutral
bars show every represented type; counts and classification details live in
tooltips. No title-based category implies quality.

Review rounds is the median number of distinct commit revisions with a
submitted non-author review at or before merge, inclusive of the merge instant.
APPROVED, CHANGES_REQUESTED, COMMENTED and DISMISSED states count. Bots and the
configured agent count. A deleted reviewer or author account counts unless
its login is known to be the author's. Comment-only reviews, including thread
replies attached to a new revision, count intentionally: these are observed
submitted reviews, not proof of a full review or rework. Multiple reviews of
one commit count once; PRs without eligible reviews count zero. Pending,
author and post-merge reviews are excluded. The initial reviewed revision counts.

If any eligible review lacks a commit identity, the median is withheld.
Coverage appears separately for the day and baseline in its tooltip, and for
each historical period in its readout. Empty cohorts say no merges; older
payloads without aggregates say unavailable. The line shows weekly medians
across the preceding year; the compact card has no histogram.

Change-request share counts each merged PR once if it has at least one observed
submitted non-author CHANGES_REQUESTED review at or before merge. Its denominator
includes every merged PR, including those without reviews. The local datastore
does not collect dismissal events or their previous states, although GitHub
exposes them. Dismissed change requests can therefore be undercounted; the
tooltip reports the dismissed-review count. Its line uses weekly shares.

Both friction cards show the pooled preceding seven-day cohort's median or share
and PR count beneath the delta. Changes use relative percentages, not percentage
points; a positive value against a zero baseline has no relative delta for either
card. Both compare Today's partial cohort directly, without elapsed-day pacing
or averaging daily medians/shares. Decreases are green, increases red and
unchanged values neutral. Definitions and coverage remain in tooltips.

This preserves observed-friction polarity, including when fewer reviewed PRs
drive a decrease: an unreviewed cohort can be green. Both tooltips therefore
report how many merged PRs had an eligible review; colors are not a review-quality
score. Stored-summary availability covers the local aggregate, not complete
historical review-state knowledge. No merges produce unknown medians and shares.
Existing local SQLite reads supply these metrics; collection, dependencies,
GitHub requests and refresh schedules are unchanged.

## Missing data and failures

A missing metric shows —; its measurement tooltip explains its meaning and
any partial size coverage. No merges produce zero changed lines and unknown
per-PR metrics. An unconfigured agent is explained with its missing value.
Each failed read shows where it belongs, alongside any retained values.

Account, day, baseline, history and quota read failures go to the shared
Answer here. Repeated account failures across Analytics reads
appear once. They remain accessible after navigating away, can be dismissed,
and clear once all reporting reads recover. A recurrence after recovery is a
new notification. These browser read failures are local to the tab and remain accessible in Answer here when Notifications are off
(the switch suppresses their popups); recording, dismissing and clearing them makes
no API request. A generic fetch failure does not establish a server fault or
connection-reset cause. Existing server sync alerts continue independently.

## GitHub API quota

The GitHub API cards are live, independent of the selected day and organization.
It shows the configured user and automation GitHub accounts separately,
side by side with avatars; a shared login appears once with both roles.
Only REST and GraphQL budgets appear. Each shows used
versus total, remaining capacity, next reset in Settings' timezone, minutes
left, observed use per minute and the remaining sustainable rate.

Reads use each account's stored `gh` credential explicitly. No credential or
HTTP stderr reaches the browser. An unavailable account retains its identity and an unknown quota marker while
the other account remains visible; its error appears only in Notifications. A zero limit means that API is unavailable.
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
hour is retained for seven days across restarts. Missing hours are empty, never
carried forward or invented. The utilization distribution is not displayed.
The hourly charts use the existing quota response and unchanged 15-second polling;
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
window through this endpoint; `medianTimeToMergeMs` accompanies the mean.
The baseline request adds `dailyBounds` (eight increasing zoned edges covering
its window); the response includes seven `daily` reports from the same local
read. Comments and behaviors include `medianCommentsPerPr` and `medianPerPr`
alongside their means. Errors from readable but stale caches carry `stale: true`. The
report also names `agentAccount` (null when none is set) and gives, under
`pullRequests`, `opened`, `closedUnmerged`, `mergedByAgent` (null without an
agent account) and `firstReview` with its `count` and `medianMs`.

`pullRequests.workReview` adds `reviewed` (PRs with an eligible review; null
when summaries are unavailable), `types` (type/count), `rounds` (median, counted,
missingReviews and rounds/PR-count distribution), and `changesRequested`
(affected PRs, review count, dismissed count and available-summary count). Unavailable
review aggregates remain null; older client payloads show unknown metrics.

`GET /api/analytics/history?bounds=…&org=…` answers the past year's weekly lines
and, in a separate shared request with 31 daily edges, the 30-day histograms. `bounds`
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
coverage notes live on the measurement tooltip; read failures live in Notifications. See
[Menu and Settings](Menu.md).
