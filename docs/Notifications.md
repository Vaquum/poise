# Notifications

What needs you, and what Behaviors is doing, is in one place: Overview's
Answer here. A bell at the end of the top bar, on every place, counts what is
open and opens Answer here, with a route back to where you were. On Overview
itself it brings Answer here to its top and moves focus to its first entry, or
to its empty state when nothing is open at the level; its label says which.
When the selected level has no requests or faults, the bell shows no count.

## The bell

The count is what Answer here shows at the level you chose: at its default,
what waits on you and what is stuck. What Poise handles on its own is never
counted, and what has finished is never listed. The badge is:

- red while something is stuck;
- amber while something waits on you.

## Answer here

Show sets how much Answer here lists. Each level includes the one before it.

- **Only you** shows GitHub review requests addressed to your personal account,
  open questions or decisions addressed to you, pending Safe mode permissions,
  and confirmed sign-in or reconnect requests. A worker question reaches this
  level when the [Manager escalates it](Chat-orchestration.md#authority).
- **+ Faults:** also what is stuck. Chain work that is held or has not moved
  for four hours, a behavior that gave up on a target, Poise's own failures
  (a review outcome to verify, an unusable result, a failed command), a stalled
  ledger, and anything automatic still open after four hours: a notice from
  when it was raised, chain work from its last verified advance, a retried
  Behaviors failure from when its run of failures began. The default, and what
  the bell counts.
- **Everything** also shows active changes and retries, pull request status
  (including readiness to merge), and publication review threads. This group
  folds to its count while anything else is listed.

What has finished, a chat's turn or an action, is not listed; Handled today
keeps what was settled here. A pull request's notice takes its group from the
pull request's current blocker, read from
`/api/behavior-ledger/pr-status`; the line under its title says that blocker.
When that status cannot be read, the last read stays, an organization whose
datastore could not be read keeps its earlier rows, and a pull request with no
status read says that behavior status is unavailable.
The heading counts what the level shows, and each group heading counts its own.

A load paints the last read at once: the entries Answer here last showed, under
the same GitHub user and organizations, quieter, with "Last read" and its time
on the heading's line. Nothing on them acts until their source has read
afresh, which replaces that source's entries; an entry its first read no longer
lists leaves at once, even under the pointer.

Each entry is a card as on Board: its title (a pull request's own title, a
chain's first reason), one line on what it waits on, and its kind, place and
age. Request cards let you answer or grant permission. Publication threads let
you reply and resolve. Other actions show under the pointer, or with focus, at its
lower right: open it where it lives, on GitHub, its timeline or diagnostic,
More, Resume a held chain, Silence reminders, and Dismiss, whose tip says what
putting it away does.

Within each group the newest entry is on top: a notice by when it began, a
request or decision by when it was asked, a review thread by its latest reply,
chain work by its last verified advance. Each entry expands in place to its full
words, what happened and what can be done. Each line of what happened carries its time on Poise's clock: 24-hour in
the time zone from Settings, whatever the browser's language, with the date for
another day and the year for another year.

## What shows

Server notices are unresolved alerts, the same alerts
[Poise Link](Poise-Link.md) shows on the desktop. A failed
read shows on the element it belongs to, and as a tab-local Poise fault in
Answer here. Failed writes and conflicts appear here as faults. Changed failures
receive a fresh notice; repeating the same failure keeps its dismissal. Unreadable
run records are tracked by stable record identity instead: reworded evidence for
known rows updates the notice in place, and only a never-before-seen row raises a
fresh alert.
Routine loading and saving diagnostics go to the browser console. Data labels,
controls and Chat-related guidance remain. Chat, JEV, Settings, Publishing and
reviews, Admin and pairing, Setup and terminal messages are unchanged. These failures are shared across
views, deduplicated across requests, dismissible without a request, and cleared
on recovery. They remain accessible when Notifications are off; the switch
suppresses their popups. See
[Analytics](Analytics.md#missing-data-and-failures). They come in this order:

1. A Chat agent is waiting for the owner's permission or answer.
2. A [connected account](Connected-accounts.md#alerts) requires sign-in or reconnection.
3. A behavior failed and is held. The notice leaves once Behaviors no longer
   has the incident. A materially different failure cause replaces the notice
   with a fresh, specific alert, including after dismissal. Repeated failures
   with the same cause retain their dismissal; changing counts and attempt IDs
   do not count as a new cause. This persists across restarts.
4. A GitHub account's datastore has not synced for 15 minutes.
5. A pull request asks for your review (below).
6. One of your pull requests has a merge conflict (below).
7. A pull request of yours is ready to merge (below).
8. A Chat turn that ran longer than two minutes has finished. This one shows
   for an hour. A [Switchboard](Switchboard.md) check that finishes is routine
   and raises none; one that ends early does. A timer turn that ends normally
   is routine and raises none; one that ends early does.

Within a kind, the one that most recently came due leads. A Chat session that
is on screen already says what its notice would, so its notice is not listed.

Behaviors' diagnostics are listed too, with the classification and details
described in [Behavior integration contract](Behavior-Contract.md#diagnostic-severity).

Delayed, held and uncertain native-chain work uses the existing `attention`
records to show progress age, gates on the current commit and the known next
action. Held or stalled work appears under Faults. Journal evidence opens
the recorded journal cursor in Observe → Tasks, where Hold/Resume and pagination
remain available. Failed reads retain entries with an explicit stale-evidence notice.
This follows the existing diagnostics refresh clock and remains accessible with
Notifications off; it adds no alert record or execution authority.

A failed behavior's notice and its diagnostic are one entry. The notice says
what can be done; the diagnostic says what happened and how it is classified,
which also decides its group. When the current incident records the legacy stop
after two review timeouts, the notice explains that automatic retries stopped
and asks you to change the head or model, or retry explicitly. It keeps the link
to that incident's Call; an unknown stop keeps the generic wording.

Existing managed-work entries also show [verified work impact](Logging.md#observe--logging)
from each entry's own retained evidence: current impact, work target and stage,
last verified progress, and the next known retry or action. An unmatched entry
stays unknown even when a grouped sibling matches. These optional reads preserve
the original notification time, actions and grouping. They create no notifications;
a native hold without an existing notification remains absent.

## GitHub API quota

A background monitor reads the configured user and automation accounts every
15 seconds, including when Analytics is closed and Notifications are off.
While notifications are enabled, a displayed [estimated exhaustion risk](Analytics.md#github-api-quota)
of at least 50% sustained across distinct observations at least 30 seconds apart
in the same reset window raises an amber `github_quota_warning`. Zero remaining raises a red
`github_quota_exhausted` error, including after a dismissed warning. The notice
names the account, API budget, usage and reset time. The reset time is on Poise's
clock with its zone, as in `Resets at 16:00 EEST.`, in the time zone from
Settings, or in UTC while none is set. Errors appear among Poise faults and turn
the bell red.

Each account/budget/reset condition alerts once. Continuing warnings update
their numbers without undoing a dismissal or issuing another arrival. A
warning clears when known risk falls below 50%, exhaustion replaces it, the window
resets, or the account is removed. Failed reads and insufficient observations
retain known alerts until reset; they do not claim recovery. Notifications off
suppresses new quota alerts while diagnostic observation and confirmed condition
resolution continue. Re-enabling preserves a continuing condition; recovery while
off rearms its next sustained condition. A read uses
one credential command and one rate-limit command per distinct configured account
per read. The background cadence alone is eight commands per account per minute.
Concurrent Analytics reads share the cache and pending request, but a budget
reset invalidates that cache early; foreground polling can add reads around
those resets. There is no fixed per-minute command ceiling.
An exhaustion error clears as soon as GitHub confirms positive remaining
capacity, even while a new consumption rate is being collected.

## Behavior ledger

A background check reads the ledger's drain state every minute. A queue whose
oldest capture outwaits the ten-second stall budget on two checks in a row
raises a red `ledger_queue_stalled` error, as does a dead worker at once; both
clear once the queue drains or the worker runs again. Any increase in lost
captures raises a red `ledger_capture_loss` error. Loss is baselined per store
generation, so history alone never re-alerts on a poll or a restart, and a new
store resolves the previous store's loss alert. A standing loss alert refreshes
its totals without issuing another arrival. Like quota alerts, these raise only
while notifications are enabled. Resolution continues while off, and unraised
loss accumulates instead of being consumed, so re-enabling surfaces what was
lost. They open Observe → Behaviors.

## Pull requests ready to merge

Every two minutes Poise checks your own open pull requests, the ones your
GitHub account or the agent account opened: the merge button is green, no check fails or is still running, and no
conversation is unresolved.

Simultaneous checks of the same pull request share one read
when they use the same agent GitHub account. Its answer is cached for 60 seconds
from the start of the check; a different agent account gets its own check.
Showing the checks in Overview answers with a check up to
five minutes past those 60 seconds and reads it again behind the answer, five
at a time; with none that recent, it waits. This check always waits for a
fresh one.

- A pull request that becomes ready is noticed at once, and Poise Link shows
  it once.
- Answer here shows readiness under Everything when the behavior status is
  healthy. Merge is handled by the configured behavior and GitHub's queue.
- Its notice comes back every 15 minutes, counted from when it became ready,
  and says how long it has waited.
- That goes on until it is merged or closed, stops being ready, or you silence
  it. Once ready again, it is noticed again, unless you silenced it.
- A pull request GitHub could not be asked about, or whose account could not
  be read just then, keeps what it had.

Unresolved current conditions retain their identity and dismissal until
authoritative resolution, including beyond thirty days. Resolved history and
native alert replay keep their thirty-day window. Finished-turn notices still
expire after one hour; ready-PR reminders follow their existing lifecycle.

## Requested reviews and conflicts

Every two minutes, on the same pass as the ready check, Poise looks at every
involved open pull request, whoever authored it, and at your own open pull
requests:

- A pull request that formally requests your personal GitHub account to review it is
  noticed once. The request is as fresh as the organization's datastore sync:
  it resolves when a sync shows the request gone — GitHub drops it when you
  submit a review — or when the pull request closes. A failed or incomplete
  read keeps the notice. A request made again after removal is noticed anew.
  Silencing it lasts until the request is removed.
- One of your own open pull requests whose held reasons include a conflict is
  noticed once. It resolves when the conflict is gone or the pull request
  closes. It cannot be silenced.

Neither repeats while it stands: each shows until you put it away or it
resolves.

## Idle worker slots

Every two minutes, on the same pass, Poise counts the Manager's worker chats
against its Rhythm slots and the open unassigned `enhancement` tickets. When
slots sit idle for more than 15 minutes while that backlog is empty, one
notice names up to five open candidates to label, perf and P0/P1 first, with
links. It comes due again at most hourly until a slot fills or a ticket is
labelled, and silencing it lasts until then.

Durably chain-owned issues are excluded from that Manager backlog and from
promotion suggestions; a cached suggestion is rechecked when ownership changes.
This notice describes Manager worker Chats, not the workspace's total v2 work
or free machine capacity. Unreadable Chat occupancy stays unknown and cannot
clear an existing idle incident. Backlog refresh still uses the existing notice
pass, so disabling notifications may leave it unknown or at its last reading.
Chain occupancy is a separate synchronous journal snapshot in behavior
diagnostics and General settings; it does not depend on notices or add a poller.

## Acting on a notice

- **Open** goes to what the notice is about and puts the notice away, with a
  route back: the run in Observe → Behaviors, Settings → Accounts or General,
  Extensions for an extension sign-in, the chat in Chat or the Manager place, or the pull request's card on Board,
  with GitHub a click away.
  - A failed behavior opens its exact run in Observe → Behaviors with its
    failure detail. A filter that hides the run is cleared for that visit only.
  - A failed behavior without a recorded agent call has nothing to open. Its
    diagnostic is in the entry itself.
- **Dismiss** puts it away: for good, or for a ready pull request until its
  next reminder. See the rules for prompts with options below.
- **Silence reminders**, on a ready pull request or a requested review,
  silences it: no more reminders while a ready pull request
  stays open, nothing more about a review request until the request is
  removed.

## Putting any entry away

No entry is ever stuck. Every entry can be dismissed, except a prompt that
offers options: a decision the Switchboard reports, or a question from the
Manager's chat. Those always offer **Other**, which opens a text field whose
words are sent as the answer, so they need no Dismiss. A Manager's question
whose agent takes only its options keeps Dismiss instead.

Dismiss only hides: it never resumes a chain, retries a run or tells a chat
anything, and each entry says beside it what happens to the rest. It waits
eight seconds in the tab, with Undo, like a notice's. The server keeps the
dismissal by the entry's key and what it reported, so every device and the bell
agree, and the entry comes back when that changes:

- chain work, when the chain advances or its blocker changes; a held chain
  stays held;
- a Behaviors condition, when it happens again;
- a chat's permission or question, never while it stays open: the chat still
  waits for the answer in Chat;
- a review thread, when someone replies; it stays open on GitHub;
- a decision without options goes from the Switchboard, which tells its chat
  nothing.

Dismissals are kept for thirty days, and each is recorded under Handled today.

## Arrivals

A notice that arrives while you are elsewhere raises the bell's count. One that
arrives while your pointer or focus is in Answer here waits, counted as new with
Show now, so nothing moves under you; leaving the list brings it in. A screen
reader reads each new notice once.

What one tab puts away, the others drop within ten seconds.

## Reading Behaviors' diagnostics

Reading Behaviors' diagnostics runs `agent-interface --logs` on the server, so
the page reads them only:

- once, 15 seconds after it loads, unless something below has read them first;
- when Answer here opens, and while it is open, on each refresh tick;
- whenever Behaviors refreshes on screen.

Until that first read, the bell counts only notices.

## Turning them off

Settings → General → Notifications. Off stops notices and the check of pull
requests at once. Behaviors' diagnostics stay in Answer here, and Poise Link's
other alerts go on as before.

## API

- `GET /api/notices` answers `{ enabled, notices }`, the most pressing first.
  - A notice is `{ id, kind, title, body, since, due, silenceable, target }`.
  - On a failed behavior it also carries `subject: { behavior, target }`: the
    behavior and target Behaviors' diagnostics know it by.
  - `due` is `since`, or the latest reminder of a ready pull request.
  - `target` is one of:
    - `{ swarm: <call id> }`;
    - `{ view: "behaviors" }` for an incident without a recorded call;
    - `{ settings: "general" | "accounts" }`;
    - `{ chat: <session id> }`;
    - `{ pullRequest: <GitHub URL> }`;
    - null when the notice only informs.
- `POST /api/notices/:id/dismiss` and `POST /api/notices/:id/silence` answer
  the same shape.
  - Either answers 404 for a notice that has cleared or was never issued.
  - Silencing answers 400 for anything but a ready pull request or a
    requested review.
- `POST /api/settings` with `{ "notifications": { "enabled": false } }` turns
  them off; `true` turns them on.
- `GET /api/answers/dismissals` answers `{ dismissals: [{ key, revision, at }] }`,
  newest first: Answer here's put-away entries that are not notices.
  `POST /api/answers/dismissals` with `{ key, revision, title }` puts one away;
  the key is the entry's id (`chain:`, `diagnostic:`, `request:` or `thread:`).
  It is the person's action, taken in the browser: anyone else gets 403.

The page reads `GET /api/notices` every ten seconds while it is in front, and
at once when it comes back to the front. The code is `server/alerts/notices.ts`
on the server. In the page, Answer here is `src/ui/places/overview/` and the
bell `src/ui/shell.ts`, with shared notice classification in
`src/notification-items.ts`.

## Retained evidence

Entries with exact retained evidence offer **Open its diagnostic**, opening
that record in Observe → Logging. A missing record never borrows another
review's failure. [Logging](Logging.md#notification-evidence) defines identity
and expiry behavior.

Logging table counts, retention bounds, snapshot times and closed coverage gaps are inspection metadata, not notification producers. They appear only in Logging’s structured Data and collection control. Current source faults retain qualifying diagnostic events; historical incompleteness alone must not create a persistent current-failure signal.
