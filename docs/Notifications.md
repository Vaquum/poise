# Notifications

What needs you, and what Behaviors is doing, is in one place: the notification
rail. A bell at the end of the control bar, in every view, counts what is open
and opens the rail. When nothing needs you, the bell shows no count.

## The bell

The count is what needs you, Poise faults and what is ready for you. What Poise
handles on its own is not counted. The badge is:

- red while Poise has a fault;
- amber while something needs you;
- green when everything open is ready for you.

## The rail

The rail opens under the control bar, on the right, at full height.

- **Docked.** On a window at least 1400px wide the rail docks. The page ends
  where the rail begins, including full-width Archive, Swarm, Current and
  Chat, so the rail covers nothing. It can stay open while you work, across
  views and reloads. The dock button in its header turns docking off and on.
- **Floating.** On a narrower window, or with docking off, it floats over the
  page. It closes on a click outside it or on Escape.

Everything is listed by who acts:

- **Needs you:** what only you can do.
- **Poise faults:** Poise itself needs repair.
- **Ready:** done and waiting for you.
- **Handled automatically:** Poise is retrying, and there is nothing to do.
  This group is folded behind its count while anything else is listed.

The filter above the list shows one group at a time. Each entry expands in
place to its full words, what happened and what can be done. An expanded entry
stays expanded through refreshes. Each line of what happened carries its time
on Poise's clock: 24-hour in the time zone from Settings, whatever the browser's
language, with the date for another day and the year for another year.

## What shows

Server notices are unresolved alerts, the same alerts
[Poise Link](Poise-Link.md) shows on the desktop. Swarm, Current, Archive, Behaviors, Snippets, Editor and Analytics report browser
read failures here as tab-local Poise faults. Failed writes and conflicts also
appear here, classified as faults or actions needing the person. Changed failures
receive a fresh notice; repeating the same failure keeps its dismissal. These
views show no local loading, empty-state, save-status or explanatory messages.
Routine loading and saving diagnostics go to the browser console. Data labels,
controls and Chat-related guidance remain. Chat, JEV, Settings, Publishing and
reviews, Admin and pairing, Setup and terminal messages are unchanged. These failures are shared across
views, deduplicated across requests, dismissible without a request, and cleared
on recovery. They remain accessible when Notifications are off; the switch
suppresses their popups. See
[Analytics](Analytics.md#missing-data-and-failures). They come in this order:

1. A Chat agent is waiting for a permission or an answer.
2. A sign-in is needed: Claude, another agent CLI, or a GitHub account gh does
   not hold signed in.
3. A behavior failed and is held. The notice leaves once Behaviors no longer
   has the incident. A materially different failure cause replaces the notice
   with a fresh, specific alert, including after dismissal. Repeated failures
   with the same cause retain their dismissal; changing counts and attempt IDs
   do not count as a new cause. This persists across restarts.
4. A GitHub account's datastore has not synced for 15 minutes.
5. A pull request of yours is ready to merge (below).
6. A Chat turn that ran longer than two minutes has finished. This one shows
   for an hour. A [Switchboard](Switchboard.md) check that finishes is routine
   and raises none; one that ends early does.

Within a kind, the one that most recently came due leads. A Chat session that
is on screen already says what its notice would, so its notice is not listed.

Behaviors' diagnostics are listed too, with the classification and details
described in [Behavior integration contract](Behavior-Contract.md#diagnostic-severity).

A failed behavior's notice and its diagnostic are one entry. The notice says
what can be done; the diagnostic says what happened and how it is classified,
which also decides its group. Each Behaviors row shows that behavior's counts:
Poise faults, needs you and automatic. A count opens the rail on that behavior
with its first entry in that group expanded.

## GitHub API quota

A background monitor reads the configured user and automation accounts every
15 seconds, including when Analytics is closed and Notifications are off.
While notifications are enabled, a displayed [estimated exhaustion risk](Analytics.md#github-api-quota)
of at least 50% sustained across distinct observations at least 30 seconds apart
in the same reset window raises an amber `github_quota_warning`. Zero remaining raises a red
`github_quota_exhausted` error, including after a dismissed warning. The notice
names the account, API budget, usage and reset time. The reset time is on Poise's
clock with its zone, as in `Resets at 16:00 EEST.`, in the time zone from
Settings, or in UTC while none is set. Errors appear in the rail's faults group
and turn the bell red.

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

## Pull requests ready to merge

Every two minutes Poise checks your own open pull requests, the ones your
GitHub account or the agent account opened, with the rule Current uses for
green: the merge button is green, no check fails or is still running, and no
conversation is unresolved.

Current and notifications share a simultaneous check of the same pull request
when both use the same agent GitHub account. Its answer is cached for 60 seconds
from the start of the check; a different agent account gets its own check.

- A pull request that becomes ready is noticed at once, and Poise Link shows
  it once.
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

## Acting on a notice

- **Open** goes to what the notice is about and puts the notice away. That is
  Swarm, Settings (Accounts or General), the Chat session, or the pull request
  on GitHub in a new tab.
  - A failed behavior scrolls to its exact run in Swarm, briefly highlights it,
    and opens the failure detail, including when Swarm is already on screen.
    Search and account filters that hide the run are cleared, and a collapsed
    group opens to reveal it.
  - A failed behavior without a recorded agent call has nothing to open. Its
    diagnostic is in the entry itself.
  - A floating rail closes when it opens something; a docked rail stays open.
- **Dismiss** puts it away: for good, or for a ready pull request until its
  next reminder.
- **Silence reminders**, on a ready pull request only, silences it: no more
  reminders while it stays open.

Behaviors' conditions cannot be put away. They leave the rail when the
condition clears.

## Arrivals

A notice that arrives while the rail is closed shows for six seconds as a card
under the control bar. The card has Open (when the notice has somewhere to go),
Show, which opens the rail on it, and dismiss. Pointing at the card or focusing
it keeps it on screen. Then it tucks into the bell. A ready pull request's
reminder arrives the same way. While the rail is open, a new entry is
highlighted in place instead.

What stood before the page loaded, or before notifications were turned on, is
counted by the bell, not shown as a card. Cards take no focus and make no
sound; a screen reader reads each new notice once.

What one tab puts away, the others drop within ten seconds. The bell, the rail
and arrival cards are hidden in the Editor's writer mode.

## Reading Behaviors' diagnostics

Reading Behaviors' diagnostics runs `agent-interface --logs` on the server, so
the page reads them only:

- once, 15 seconds after it loads, unless something below has read them first;
- when the rail opens, and while it is open, on each refresh tick;
- whenever Behaviors refreshes on screen.

Until that first read, the bell counts only notices.

## Turning them off

Settings → General → Notifications. Off stops notices and the check of pull
requests at once. Behaviors' diagnostics stay in the rail, and Poise Link's
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
  - Silencing answers 400 for anything but a ready pull request.
- `POST /api/settings` with `{ "notifications": { "enabled": false } }` turns
  them off; `true` turns them on.

The page reads `GET /api/notices` every ten seconds while it is in front, and
at once when it comes back to the front. The code is `server/alerts/notices.ts`
on the server; in the page it is `src/views/notification-rail.ts`, with what it
lists in `src/notification-items.ts`.

## Retained evidence

Expanded rail entries, including diagnostic-only conditions, show **View in
Logging** when exact retained evidence is available. Distinct attempts keep their
own references; additional retained history is labelled. Pending collection and
unavailable diagnostics remain explicit. A missing record never borrows another
review's failure. [Logging](Logging.md#notification-evidence) defines identity and
expiry behavior. This secondary action never dismisses or silences; the primary
Open action keeps its existing dismissal behavior. Arrival cards are unchanged.

Logging table counts, retention bounds, snapshot times and closed coverage gaps are inspection metadata, not notification producers. They appear only in Logging’s structured Data and collection control. Current source faults retain qualifying diagnostic events; historical incompleteness alone must not create a persistent current-failure signal.
