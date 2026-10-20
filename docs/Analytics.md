# Analytics

**Analytics** opens a view of its own, like Current or Behaviors. By default,
its shortcut is in the burger menu; choosing it closes the menu and returns
focus to the burger. Settings → Navigation can place it in the top bar too.
The shortcut on either surface marks Analytics as the current page. A reload
stays on Analytics, and choosing another view leaves it.

Analytics is one board of cards, with no section headings. The default order
is eight productivity cards (two rows of four in a wide window), Work type,
Review rounds and Change-request share, five per-PR cards, then live GitHub API
account cards. Productivity and API cards share the taller height; Work & review
and per-PR cards share the shorter height. Each family expands together when
text or typography needs more space. Narrow windows reduce columns.

Drag a card's top bar to move it anywhere on the board. The held card follows
the pointer directly; other cards make room with the shared Tactile spring.
The outlined slot shows the destination. Release to place; Escape, pointer
cancellation, leaving Analytics or resizing cancels the move. Dragging near the
viewport edge scrolls the page. Keyboard users focus a header, press Space or
Enter, move with arrow keys (Home/End reach the ends), then press Space or Enter
to place. Escape restores the previous order. Focus and document order follow
the placed cards. Reduced motion places cards immediately.

The browser remembers the order across day and organization changes, refreshes,
navigation and reloads. New cards append to the saved order; unavailable account
identities retain their saved position. A live read that completes during a move
is applied after the move, retaining the held card and its controls.

Every metric retains its value, comparison and weekly history. Productivity and
per-PR cards retain their histograms. Work & review and GitHub API distributions
are omitted; API cards retain their 24-hour usage chart. Borders, colors, spacing,
tooltips and motion follow the shared design system.

## Card layout

The board is one named Analytics panels region. Each card has a semantic name;
per-PR names retain “per merged pull request”, and quota headers retain “Live”.
Quota cards describe their independence from the day and organization filter.
There are sixteen metric cards and one card per reported account, holding that
account's REST and GraphQL budgets together. A shared user/automation login is
one account; an unavailable account keeps its identity and an unknown value.

Cards pack in document order over twenty width units, with a 12px gap and no
dense backfill. Mixed rows advance by their tallest card; shorter cards retain
their own height. The minimum heights are 22rem and 17rem. At every content,
font or width change each family grows to its largest member's measured content
height, with the taller family retaining at least 5rem clearance above the shorter
family. Work type uses two columns when each has at least 14rem of space,
reducing to one below a 640px board width or when larger type needs it;
all twelve types remain visible and focusable. There is no
internal card scrolling or content clipping.

| Board width | Productivity / review | Work type / API account | Per-PR |
| --- | --- | --- | --- |
| Below 450px | 20 units | 20 units | 20 units |
| 450–879px | 10 units | 20 units | 10 units |
| 880px or wider | 5 units | 10 units | 4 units |

The whole header is a Pointer Events handle, with a grip, a 40px minimum target
(44px for coarse pointers), `touch-action: none`, pointer capture and a 5px
movement threshold. Only the primary pointer and primary button initiate a move.
Plots and the page keep their ordinary interactions outside the header. Insertion
uses stable boundaries between the other cards, with a 24px switching margin to
avoid oscillation. Distinct orders remain reachable when a wide card wraps into
the same destination box. Drop outside the board places at the nearest valid slot. Edge
scrolling is bounded by the board; the held card cannot extend the page.
Escape, pointer cancellation/capture loss, window blur, hidden tab, departure,
font changes and viewport resize restore the committed order and release capture.
Only a successful drop saves. Reordering announces pickup, position and placement
or cancellation through one status region; ordinary data reads do not announce
the entire board. Chart arrow keys remain scoped to the plot; reorder keys are
scoped to the header. Guided scrolling keeps a keyboard-held or dropped header
visible below the fixed application bar. Tab or focus leaving a keyboard-held
header cancels the move; ordinary chart/value focus never leaves it held.
Focus stays on the semantic control after placement or Escape cancellation.

`poise-analytics-card-order` stores a JSON array of unique card IDs in localStorage.
This first format is browser/origin-local, shared by logins using that browser,
and contains layout metadata only. Metric IDs are `metric:<group>:<label>`;
account IDs are `quota:<lowercase login>`. Renamed metrics and new accounts append
as new identities; duplicate/obsolete IDs are ignored, and currently missing IDs
remain remembered when saving another move. No existing format needs migration.
Malformed data and denied/exhausted storage show an accessible visible error;
Analytics remains usable in memory. A successful later move writes a valid array.

Foreground reads replace metric bodies with keyed empty slots while retaining
their measured family heights, including quota cards interleaved among them.
The loader overlays the board without shifting it. Errors remove
those placeholders. Background reads retain the semantic card/control nodes;
the latest combined metric/quota patch waits during a move and applies on drop
or cancellation, including after a failed preference save. The order survives
history arrivals, account/day/settings changes, navigation and reload; returning
to Analytics still resets its day to Today. Existing endpoints, polling and
chart reads remain unchanged. `src/analytics-layout.ts` is the new controller
for geometry, DOM reconciliation, persistence and gesture handling. It reuses
the existing `data-id` reconciliation keys and shared 180/20/1 spring, without
changing `dom-patch.ts`, `motion.ts` or the gateway motion model.
Active history readouts raise their card above neighbors and replay their cursor
after every combined patch, including quota polls and patches deferred by a move.
Returning to Analytics reserves known account slots but clears previous usage,
reset, risk and checked-time readings until the fresh quota response arrives.

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

The browser prepares today's day and baseline while another view is visible,
at startup and on the shared refresh tick. Opening Analytics uses that prepared
snapshot immediately when its date, organization, identities and timezone match
and it is within the configured refresh interval. Its original read time is
retained for pace calculations. An in-flight preparation is shared with opening
the view; the click does not start duplicate reads. History and quota are not
prefetched. Settings/account changes cannot reuse another scope's snapshot.

Without a matching fresh preparation, previous values are removed immediately
and the standard three-dot loading indicator appears. The server reads the local datastore views directly,
without starting a CLI process for each scope.
Each account read keeps one database snapshot and yields to other server
work after 64 records or once eight milliseconds of processing have elapsed. Discussion
counts and stored JSON for sizes and merger identity are read only for pull
requests merged inside the requested window. Openings, closings and first
reviews do not parse unrelated discussion payloads; year history therefore
does not hold up day or quota reads while processing its records.
Involvement membership comes directly from the indexed associations, without
aggregating the evidence descriptions that the full user view supplies.
The date filter narrows items before each indexed membership lookup; merged
PR sizes and merger identity come from one parse of each stored payload.
The selected day and its baseline load first. The year request starts after
the cards render, so its larger scan cannot delay their initial appearance.
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
warning and pace suppression.
These local reads make no GitHub requests and consume no GitHub API quota.
They show the datastore's latest stored records; freshness still depends on
the existing GitHub sync, whose schedule and requests are unchanged.

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
Any read error in either report, including a stale-cache
warning, withholds these for every Today cumulative tile. Known totals, Typical
and median remain visible: zero Typical shows 0.0, an unknown baseline shows —,
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
over its stored records; Today's cumulative pace is withheld. The warning is
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
The readout explains the chart and its period boundaries. Below productivity and per-PR lines,
ten equal-width bins show the distribution of known weekly values. Empty
periods stay unknown for metrics that require observations; zero event
counts remain zero. Hover or focus explains the distribution. There is no
history table.

A period without merges has no time to merge, and one whose merged pull
requests are not all sized has no lines total; the line breaks there instead
of falling to zero, and a known value with unknown neighbours shows as a dot.
The year is read once per day and account, separately from the day's numbers,
and each chart keeps its place until it arrives. If it cannot be read, the
charts keep an empty reserved space, the day's numbers stay, and the failure
appears in Notifications.

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
No status paragraphs or account errors are rendered inside Analytics.

Account, day, baseline, history and quota read failures go to the shared
notification rail. Repeated account failures across the three Analytics reads
appear once. They remain accessible after navigating away, can be dismissed,
and clear once all reporting reads recover. A recurrence after recovery is a
new notification. These browser read failures are local to the tab and remain accessible in the rail when Notifications are off
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
coverage notes live on the measurement tooltip; read failures live in Notifications. See
[Menu and Settings](Menu.md).
