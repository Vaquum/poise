# Notifications

Poise shows what needs you in a pill at the top centre of every view: one
notice at a time, the most pressing first. When nothing needs you, nothing
shows. It sits in the band above each view's controls, so it never covers a
control or what a view shows.

## What shows

Each notice is an unresolved alert, the same alerts
[Poise Link](Poise-Link.md) shows on the desktop. They come in this order:

1. A Chat agent is waiting for a permission or an answer.
2. A sign-in is needed: Claude, another agent CLI, or a GitHub account gh does
   not hold signed in.
3. A behavior failed and is held. The notice leaves once Behaviors no longer
   shows the incident.
4. A GitHub account's datastore has not synced for 15 minutes.
5. A pull request of yours is ready to merge (below).
6. A Chat turn that ran longer than two minutes has finished. This one shows
   for an hour.

Within a kind, the one that most recently came due leads. A more pressing
notice that arrives takes the place of the one shown.

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

## Acting on a notice

- **Click it** to open what it is about and put it away: Behaviors, Settings
  (Accounts or General), the Chat session, or the pull request on GitHub in a
  new tab.
- **×** puts it away: for good, or for a ready pull request until its next
  reminder.
- **The crossed-out bell**, on a ready pull request only, silences it: no more
  reminders while it stays open.
- **+N** shows the next notice.

What one tab puts away, the others drop within ten seconds. The pill takes no
focus and makes no sound; a screen reader reads each new notice. It is hidden
in the Editor's writer mode.

## Turning them off

Settings → General → Notifications. Off hides the pill and stops the check of
pull requests at once. Poise Link's other alerts go on as before.

## API

- `GET /api/notices` answers `{ enabled, notices }`, the most pressing first.
  - A notice is `{ id, kind, title, body, since, due, silenceable, target }`.
  - `due` is `since`, or the latest reminder of a ready pull request.
  - `target` is `{ view: "behaviors" }`, `{ settings: "general" | "accounts" }`,
    `{ chat: <session id> }`, `{ pullRequest: <GitHub URL> }`, or null when
    the notice only informs.
- `POST /api/notices/:id/dismiss` and `POST /api/notices/:id/silence` answer
  the same shape.
  - Either answers 404 for a notice that has cleared or was never issued.
  - Silencing answers 400 for anything but a ready pull request.
- `POST /api/settings` with `{ "notifications": { "enabled": false } }` turns
  them off; `true` turns them on.

The page reads `GET /api/notices` every ten seconds while it is in front, and
at once when it comes back to the front. The code is `server/alerts/notices.ts`
on the server and `src/views/notice-island.ts` in the page.
