# Chat orchestration

Ask a chat to create workers, give each its task, and supervise them at an
interval: “Create three chats for these tasks. Check every ten minutes and
give them the context they need.” Every provider receives the same Poise
control command in its native prompt and runs it through its native shell.
No model or provider credential is added. Safe mode still governs native tools.

The command discovers itself with `{"operation":"help"}`. Its connection file
identifies the calling chat; a request cannot impersonate another chat by
putting a different sender in its JSON. The private, process-scoped credential
is accepted only on loopback, without browser Origin/fetch headers. Deleting
the chat or restarting Poise invalidates it. The next native prompt receives
the current connection. This is the existing trusted workspace, not isolation
between agents running as the same operating-system user.

## Operations

| Operation | Input | Result |
| --- | --- | --- |
| `help` | — | Control operations and Poise API discovery |
| `list` | — | Chats, creating-chat relationships, work bindings, supervision |
| `read` | `sessionId`, optional `afterSeq` | Session and paged transcript; continue from the last sequence while `truncated` |
| `create` | `title`, `task`, optional `model`, `effort` | One independent worker with the creating chat's model by default |
| `send` | `sessionId`, `text` | Durable internal message; any chat may send to any other chat, the Manager included |
| `steer` | Your worker, or any chat if you are the workspace Manager: `sessionId`, `text` | Native context delivery during its active turn; the transcript names the acting chat |
| `answer` | Your worker, or any chat if you are the workspace Manager: `sessionId`, `questionId`, `answers` | Supply known task data; the transcript names the acting chat |
| `inbox` | Optional `afterSeq` | Up to 100 durable messages in sequence order, each with `sender_title` and `sender_role` |
| `supervise` | `sessionIds`, `intervalMinutes`, `instruction` | Persistent supervision ID |
| `unsupervise` | `watchId` | Disable the caller's supervision |
| `bind` | Exact GitHub issue/PR `target` URL | Exclusive work ownership for the caller |
| `unbind` | `target` | Release the caller's work |
| `stop` | Your worker, or any chat if you are the workspace Manager: `sessionId` | Cancel its turn and pause automatic message dispatch; the transcript names the acting chat. A closed chat refuses; stopping an idle chat reports `stopped: false` |
| `timer` | Manager only: `sessionId`, `label`, `message`, exactly one of `delayMinutes` (1–10080) or `everyMinutes` (5–1440) | Durable timer; at most 5 live timers per chat, 100 chat-set timers per instance |
| `timers` | Manager only: optional `sessionId` | Live timers and timers ended in the last 24 hours, every hold, the workspace hold |
| `cancelTimer` | Manager only: `timerId` | Cancel the timer; ended timers return unchanged. Never counts against the budget |
| `rearmTimer` | Manager only: `timerId` | Re-arm a tripped timer; failures clear and the next fire is now plus its interval |
| `api` (command only) | `path`, optional `method`, `body` | Normal local Poise API response |

Mutating control requests use a UUID `requestId`. The command prints that ID
to stderr before IO. Retain it when retrying: the same request returns the
recorded result, a changed payload conflicts, and an uncertain receipt never
executes again automatically. Ordinary `api` calls retain their endpoint's
existing semantics; the control receipt does not make arbitrary APIs idempotent.

Workers inherit the creating chat's saved Safe mode and Auto-merge choices. Every
Poise-local session, top-level or worker, gets its own Poise-owned local Git
workspace and checkout lease, so several chats can run while their creating
chat is working. Repository work must be set up within that session's workspace
using the context supplied in its task.
Creating a chat does not give it another chat's checkout or native history.
Workers appear in the sidebar immediately without selecting them or disturbing
the creating chat's draft. Their status updates without loading their transcripts.
Reconnecting refreshes the list for creations missed
while disconnected; discovery never starts a native turn.

Messages wait for an idle turn boundary. They do not steer a busy native turn,
answer a question, or approve permissions. A creating chat receives notifications of
its workers' completion, errors, questions, permission requests and closure, with the
transcript sequence needed to inspect the original event. Each notice also carries
`others`: steers, answers and stops by anyone but the creating chat — the person,
the Manager, Poise or another chat — since its previous notice for that worker, at
most 20, then `more`. Those ride along and start no turn of their own. An active creating
chat can read its inbox directly. Admission records the new turn ID; it is not proof
that the agent completed the task. Failed/stopped/interrupted work pauses
automatic dispatch until explicit chat activity. Existing queued tasks take
priority. Stop preserves pending messages and bindings.
Dispatch preserves each recipient's message order while rotating across
recipients, including those blocked behind a deferred queue.

A creating chat can explicitly steer its own worker or answer its pending
question with known task data. Native answer validation still applies. The
transcript names the acting chat, as described under Attribution; it never
labels that answer as the person's decision. Questions needing a new human
decision and all permission requests remain with the person/native Safe mode.
Answering a question that someone else answered first names the first answerer
relative to the caller ("by you", "by the person", "by the workspace Manager",
or the answering chat); a cancelled question keeps "no longer pending".

### Timers

The workspace Manager and the person can set durable timers on any chat,
including the Manager itself, from the control operations or the browser's
Timers pane. The pane admits one create per chat until its pending request settles;
refetching or switching chats cannot resubmit it. Each firing starts one turn
whose text is the timer message
under a `[Poise timer …]` header; the transcript shows the message with its
timer, setter and collapsed firings, and timer changes land as notes. A
timer survives restarts: missed occurrences collapse into the next delivery
with their count, and the schedule keeps its phase. Delivery orders admissible
inbox candidates by sequence: a timer waiting for the person's grace period or
an update cannot block an ordinary message; an ordinary message blocked by a
failed or paused task queue cannot block an otherwise ready timer. A timer
still reopens a closed chat before admission; a completed reopen releases its
in-flight guard even when that firing was cancelled. Each scheduler page rotates
over 100 recipients and keeps both candidates for every selected recipient.

The person stays in charge. Timers wait 60 seconds after their latest turn
finishes; an intervening internal message turn does not end that reply window.
A backward clock jump does not extend grace until a future finish timestamp.
Their Stop holds the chat, skipping its timers'
firings until their next message or Resume; the Hold toggle and Hold-all hold
until Resume. Releasing a hold skips occurrences through that release instant,
including those since the last scheduler tick. A timer whose turns fail backs
off exponentially without blocking other timers or messages on that chat and trips
after three consecutive failures, with a note and a warning; re-arming starts
it over, and tripping drops any firing still queued. A stopped or cut turn
ends a one-shot and leaves an every-timer on its schedule; a turn that
finishes after its timer ended changes nothing. Timers never target the
Switchboard or a Poise change session, and only the person can change a
timer the person set. Ended timers retain their history for 30 days; live timers
retain admitted rows for seven days, preserving open-turn mappings until the
turn outcome is recorded.

## Authority

Who may act on a chat, through the control. Refusals are 403, before any receipt:

| Operation on chat T | The workspace Manager | T's creating chat | Any other chat |
| --- | --- | --- | --- |
| `steer` | allowed, except on itself | allowed | refused |
| `answer` | allowed, except on itself | allowed | refused |
| `stop` | allowed, except on itself | allowed | refused |
| `send`, `create`, `supervise`, `unsupervise`, `bind`, `unbind`, `read`, `list`, `inbox`, `help` | unchanged | unchanged | unchanged |

No chat acts on itself, and none acts on the Switchboard except through its own
operations. Any chat may `send` to the Manager, as to any chat; each message
reaches it as source data from that chat, never as the person's request. A chat
that keeps sending starts a Manager turn each time the Manager is idle, until the
person stops the sending chat. The Manager's reach ends at the Poise instance:
another instance's chat reads as unknown, without naming that instance.

When the Manager answers in a chat it did not create, the target agent gets a
provenance note naming the answered questions: the answer came from the Manager,
not from the person, and the agent should ask the person before acting on any new
decision. The note arrives as a Poise steer, or as an internal message when the
turn cannot take a steer; either way it follows the answer, so the agent may act
on the answer first. A creating chat answering its own worker sends no note.
Issue and PR claims are unchanged: the Manager binds only work it implements
itself and cannot take or release another chat's claim.

Stopping, closing, renaming, deleting, forking or handing off a chat through REST,
or stopping its turn through `POST /api/agent-stop`, answers only the person's
browser; the control's `api` operation sends no `Origin` and never speaks for
the person, so the narrowed `stop` holds on every documented path. Stopping,
closing, deleting, renaming, forking or handing off chats, Memories, Settings,
behaviors and draining or resuming Poise are the person's; every chat's guidance
says so.

## Attribution

Every control action one chat takes on another names the acting chat in the
affected chat's transcript: which chat created it (in the sidebar), messaged,
steered, answered or stopped it. Answer cards read “Answered by Manager”,
“Answered by chat …” or “Answered by another chat”; steers, delivered messages
and stops carry matching labels. `list`'s `children` rows keep the JSON key
`manager` for compatibility.

Labels use the acting chat's title frozen when it acted, with the full title
and the short chat ID in the tooltip; a listed source is a button selecting
that chat, a deleted one reads “(deleted)”. The native agent sees the same
actor in a provenance header (`[Poise steer from …]`, `[Poise internal message
…]`). Chat- and Poise-sourced text is composed as source data within
the existing authorized task, never under `[User request]`; a chat's steer
arrives literally, with no command parsing or switch expansion. Messages and
steers from other chats and Poise are excluded from console history recall.

Each successful action also writes one `chat.control.action` diagnostic
carrying chat IDs, the role and the operation — never a title or message text.
Refused or failed actions write none. The Manager's reads are sampled: the first
`read` of each chat, and the first `list`, in each hour writes one
`chat.manager.read` record, so polling cannot flood the shared store; reads
through the `api` operation carry no chat identity and are not audited.
Diagnostics are best-effort and kept at most 30 days or 50,000 events; command
receipts stay an anti-replay store, not an audit trail.

Attribution lasts as long as the transcript: `/reset` deletes a chat's
transcript events, labels included. The record shows which chat says it acted;
it does not authenticate it. Every chat's connection file is readable by the
same OS user, and a forged `Origin` or an origin-less loopback `/ws/chat`
command is recorded as the person.

Supervision supports 1–20 other chats and intervals of 1–1440 minutes. It
persists in SQLite and supplies current status, unanswered request IDs and
work bindings at each requested interval, even when work is unchanged. After
downtime it emits one due check and schedules forward from the current time;
it does not burst through missed intervals. Disable supervision when finished.
Oversized snapshots produce an explicitly truncated notice with current chat
statuses and a reference to the saved supervision instruction and bindings.
They cannot stop delivery to other chats. Work notices are bounded likewise;
the owner must inspect complete evidence before acting on a truncated notice.

## Workspace Manager

The workspace Manager (the `role: 'manager'` chat) supervises the chats in its
Poise instance. It alone among chats can steer, answer and stop chats it did not
create, as if they were its own workers; each such action is attributed in the
target's transcript and audited. This is a different "manager" from a chat's
manager (the chat that created it), which the docs call the creating chat from
here on.

On its control path the Manager is limited to 120 mutating calls and 20 new
chats per hour, counted from its command receipts. Retrying with the same
`requestId` returns the stored result, and calls that only reduce activity
(`stop`, `unsupervise`, `unbind`) are never counted or refused, so an exhausted
Manager can still stop a runaway worker. Anything beyond the budget is refused
with 429 and a retry time. The bound is approximate under concurrency, failed
calls count, and deleting chats refunds nothing. Reads are neither counted nor
limited, transcripts are not redacted, and ordinary chats get no new limits.
The Manager's authority is cooperative, not a security boundary: it binds a
Manager that uses the control, while the paths listed in SECURITY.md stay open
to any same-user agent.

**Manager charter.** The workspace Manager above — the `role: 'manager'`
chat, not a creating chat — runs on standing instructions called its
charter: the built-in `/manager` snippet. The person edits it in Snippets
like any snippet, and nothing can delete it. While a Manager exists, Poise
creates it from the default text in `server/chat/manager-default.ts` when no
snippet is named `manager`; an existing snippet of that name is adopted as it
is, and an existing `/manager` is never replaced. It holds up to 64 KiB. In
any other chat, `/manager` is not supported.

Every Manager turn carries the current text at the end of its control
context, as the authorization for turns the person did not start. When the
person's direct request, the charter and Memories conflict, that is also
their precedence: the person's request first, then the charter, then
Memories. On a turn the person started, the native prompt runs Auto-merge
mode text when set, `[User request]` when set, the control context, the
charter block, `[Request]` with the request, then `[Memories]`; on a turn a
chat, Poise or a timer started, the same without `[User request]`. An edit
applies from the next turn; it does not clear the Manager's native history,
so the block states the current revision supersedes earlier ones, and
`/reset` gives a clean context.

The charter rides on every Manager turn, up to 64 KiB of input each time,
and its `;manager` trigger also expands wherever Espanso runs, including
desktops Poise Link feeds — so it must hold no secrets. Any local caller can
read it. Only requests that speak for the person can change it or Memories:
a browser `Origin`, and in service mode the gateway's assertion. That closes
the documented agent paths, not every path — a same-user process can forge
an `Origin` header or edit `poise.yml` directly, the Manager's own agent
included. Every new revision still writes a `chat.manager.charter.changed`
diagnostic. Under a service drain, editing `/manager` still works; under a
local release drain it returns 503 like other snippet saves.

**Worker chats.** A worker is a `role: 'worker'` chat, chosen in the New
session dialog like the Manager; Worker and Manager are mutually exclusive
and neither is selected by default. A worker runs on its own standing
instructions, the built-in `/worker` snippet, which rides on every worker
turn the same way `/manager` rides on Manager turns — whoever sent the
message — and is absent from default chats. While a worker exists, Poise
creates it from the default text in `server/chat/worker-default.ts` when no
snippet is named `worker`; an existing snippet of that name is adopted as it
is, and an existing `/worker` is never replaced. It holds up to 64 KiB, is
edited in Snippets like any snippet, and cannot be deleted. In any non-worker
chat, `/worker` is not supported. Every new revision writes a
`chat.worker.charter.changed` diagnostic. A worker keeps its type through a
fork; a handoff starts an ordinary chat.

## The Switchboard

The [Switchboard](Switchboard.md) is a chat Poise runs as an observer for the
Switchboard pane. Every turn's control context carries its brief in place of
the worker guidance above. It may call only `help`, `list`, `read` and `inbox`,
plus six operations that return 403 for every other chat:

| Operation | Input | Result |
| --- | --- | --- |
| `switchboard.read` | `sessionId`, `afterSeq`, optional `throughSeq` | The chat condensed: prompts, merged replies, tool calls with their outcome, edits, questions, permissions, resolutions, turn ends and errors, within about 64 KiB; continue from `nextSeq` while `truncated` |
| `switchboard.items` | `sessionId` | Its ten newest updates about that chat, and whether each decision is open, answered or settled |
| `switchboard.post` | `sourceSessionId`, `sourceSeq`, `kind` (`progress`, `blocked`, `done` or `decision`), `text` (one line, 240 characters), optional `detail` (600); a decision adds 0–4 `options` with a unique `label` (80), optional `detail` (200) and at most one `recommended` | `itemId`; the same source event and kind again returns the first item with `duplicate: true` |
| `switchboard.resolve` | `itemId`, `reason` | Settles an open decision that was answered in its own chat |
| `switchboard.explain` | `itemId`, `changed`, `matters`, `uncertain` | Answers the person's Explain request for that item |
| `switchboard.checked` | `checkId` | Finishes a check and moves each listed chat's read position to the end of its range |

`switchboard.read` and `switchboard.items` change nothing and need no
`requestId`. A post's source event must still be in the chat's transcript, and
a question or permission the chat asked natively is posted as `blocked`, never
as a decision. Open decisions are capped at five a chat and fifty a workspace.

`create`, `send`, `steer`, `answer`, `bind`, `unbind`, `supervise`,
`unsupervise` and `stop` return 403 for it, before any receipt is recorded;
so do `send`, `steer`, `answer`, `stop` and `supervise` aimed at it by any
other chat. Like every chat, the Switchboard runs as the workspace's
operating-system user and can reach the loopback APIs, so this narrows the
control interface; it is not a sandbox. Its reports are accepted while Poise
drains, since they start no work.

The person's answers from the pane are not the Switchboard's messages. Poise
records each answer once and delivers it to the chat that asked, through the
same inbox and idle-boundary dispatch, headed "[Poise message N: the person's
answer, given in the Switchboard pane and relayed by Poise]" rather than as
source data; every chat's control context says that only Poise sends that
header. The pane's actions require a browser Origin, which the `api`
operation never sends, so no chat can answer through Poise's API.

## Issue and PR ownership

Bind only work the chat is actually carrying out. Reading a URL or transcript
does not claim it. An issue and its PR can both belong to the same chat, and
several requested work items can coexist. Another chat cannot take a claimed
target or release its owner. A handoff moves the old chat's bindings to the
new chat and drops the old chat's pending monitor notices for them, so the
next observation wakes the new chat. Closing a chat releases its bindings,
so a replacement chat can claim them; a closed chat never receives notices.
Release bindings after verified completion; deleting a chat releases its
bindings and disables its own supervision.

Bound chats receive local behavior ledger changes for their exact repository,
target number and issue/PR kind. Local target reads use the repository/number
index. The observation pass yields to I/O between targets, including cached
and completed targets, so it does not hold request handling behind a whole
pass. Passes remain single-flight and coalesce intervening ticks.
PR owners also receive observed-head CI
failures and recovery, merge conflicts, behind-main branches that merge-prs
will not update itself, review feedback with unresolved threads, and
dismissed approvals that leave author-actionable threads. Resolving a
thread never wakes by itself; only new reviews, replies and reopened
threads do. Conflict, behind
and authorship ride the monitor's existing `--list-failing-ci` read; reviews
and threads come from the local datastore sync. No facet adds a GitHub
request: the monitor still calls the one existing primitive once per bound PR
every five minutes, independent of browsers and supervision intervals. On the
usual unpaginated path that is three GitHub reads per observation, at most 36
per hour per bound PR; pagination/retries can add reads. Unbound work adds
zero GitHub traffic. While any check is pending, notifications wait and retain
the last settled state, including when other checks have failed. Unchanged
settled states deduplicate. A failed CI read keeps the settled baseline and
queues at most one degraded notice per outage. Reviews use bounded local
pages of at most 200 reviews and 200 comment identities, summarized by each
represented thread's latest comment. Bounded raw-comment revisions also detect
edits to older/root comments after a reply. Review and comment revision evidence
travels in the notice fingerprint, so one-page body edits notify exactly once. Separate cursors
cycle through both lanes, so long histories and changes to older threads keep
progressing. Seen state is retained per identity: a missing identity in a
partial page is never a resolution. Unknown, missing, failing or legacy
truncated review evidence never establishes completion. Same-account feedback
is retained because a GitHub login does not identify its originating chat;
the datastore currently has no per-chat authorship receipt. A newly observed
reply can therefore notify once even if this chat posted it; unchanged replies,
resolution-only changes, outdated-only pushes and approvals stay silent. An
older Caller that lacks the page arguments yields unavailable evidence and
retains prior state; it cannot establish completion. Every PR-state
notice names its blockers and what done means: required CI and reviews pass,
no conflicts, every finding fixed or justified, replied to, and its thread
resolved. A native merge queue handles latest-base integration; update the
branch only for conflicts or a needed fix. These observations confer no merge
authority.

A target that reads closed or merged in the local GitHub datastore drops late
automation bookkeeping without waking its chat; only human activity still
wakes, and CI polling stops for a closed or merged PR. PR target state is
consulted on each local pass through a five-minute cache; issue state is
consulted when a behavior notice is actionable, through the same cache.
An unreadable or unsynced target wakes as
before: unknown is never treated as closed.

When a PR bound to a worker merges, the monitor wakes the creating chat once
with the merged PR, the issues it closed, and the open issues that depend on
them, so dependent work starts at once. A dependent is an open issue in the
same repository that GitHub lists as blocked by a closed issue, or that lists
it under `Depends on:` in its body. The closed issues come from GitHub's
closing references on the PR, or from its body's closing keywords when the
stored read predates dependency tracking. The wake reuses the merge the
target-state read already saw and adds no GitHub requests: the sync carries
the two dependency fields on its existing item queries. With no creating
chat, nothing changes. Unknown or missing evidence keeps the unsettled
baseline and retries; the wake fires exactly once per merged PR, marked
truncated when a cap or a malformed stored read hid entries.

Work changes also enter the existing structured diagnostic log with the target,
repository and responsible chat. The native `api` operation reaches Poise's
normal local API for Current, Swarm, Behaviors, Editor, snippets, settings,
models and analytics; existing route validation and drain policy still apply.
It never obtains a gateway/admin identity or access to another workspace.

`tests/chat-control.test.ts` covers the real command, HTTP control, runtime,
SQLite, concurrent isolated workers, replay, ownership conflicts, supervision,
Stop, targeted events, CI deduplication, binding transfer on handoff, release
on close, merge and review observations, degraded reads and credentials with
scripted adapters.
`tests/chat-manager-control.test.ts` covers the Manager's cross-chat authority,
provenance, worker notices, budgets, sampled reads and guidance the same way.
They make no live model or GitHub requests. Run `npm run check`.
