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
| `list` | — | Chats, manager relationships, work bindings, supervision |
| `read` | `sessionId`, optional `afterSeq` | Session and paged transcript; continue from the last sequence while `truncated` |
| `create` | `title`, `task`, optional `model`, `effort` | One independent worker with the manager's model by default |
| `send` | `sessionId`, `text` | Durable internal message |
| `steer` | Managed worker `sessionId`, `text` | Native context delivery during its active turn |
| `answer` | Managed worker `sessionId`, `questionId`, `answers` | Supply known task data; transcript attributes the answer to the manager |
| `inbox` | Optional `afterSeq` | Up to 100 durable messages in sequence order |
| `supervise` | `sessionIds`, `intervalMinutes`, `instruction` | Persistent supervision ID |
| `unsupervise` | `watchId` | Disable the caller's supervision |
| `bind` | Exact GitHub issue/PR `target` URL | Exclusive work ownership for the caller |
| `unbind` | `target` | Release the caller's work |
| `stop` | `sessionId` | Cancel its turn and pause automatic message dispatch |
| `api` (command only) | `path`, optional `method`, `body` | Normal local Poise API response |

Mutating control requests use a UUID `requestId`. The command prints that ID
to stderr before IO. Retain it when retrying: the same request returns the
recorded result, a changed payload conflicts, and an uncertain receipt never
executes again automatically. Ordinary `api` calls retain their endpoint's
existing semantics; the control receipt does not make arbitrary APIs idempotent.

Workers inherit the manager's saved Safe mode and Auto-merge choices. Every
Poise-local session, top-level or worker, gets its own Poise-owned local Git
workspace and checkout lease, so several chats can run while their manager is
working. Repository work must be set up within that session's workspace
using the context supplied in its task.
Creating a chat does not give it another chat's checkout or native history.
Workers appear in the sidebar immediately without selecting them or disturbing
the manager's draft. Their status updates without loading their transcripts.
Reconnecting refreshes the list for creations missed
while disconnected; discovery never starts a native turn.

Messages wait for an idle turn boundary. They do not steer a busy native turn,
answer a question, or approve permissions. A manager receives notifications of
its workers' completion, errors, questions and permission requests, with the
transcript sequence needed to inspect the original event. An active manager
can read its inbox directly. Admission records the new turn ID; it is not proof
that the agent completed the task. Failed/stopped/interrupted work pauses
automatic dispatch until explicit chat activity. Existing queued tasks take
priority. Stop preserves pending messages and bindings.
Dispatch preserves each recipient's message order while rotating across
recipients, including those blocked behind a deferred queue.

A manager can explicitly steer its own worker or answer its pending question
with known task data. Native answer validation still applies. The transcript
records the manager's chat ID and shows “Answered by manager”; it never labels
that answer as the person's decision. Questions needing a new human decision
and all permission requests remain with the person/native Safe mode.

Supervision supports 1–20 other chats and intervals of 1–1440 minutes. It
persists in SQLite and supplies current status, unanswered request IDs and
work bindings at each requested interval, even when work is unchanged. After
downtime it emits one due check and schedules forward from the current time;
it does not burst through missed intervals. Disable supervision when finished.
Oversized snapshots produce an explicitly truncated notice with current chat
statuses and a reference to the saved supervision instruction and bindings.
They cannot stop delivery to other chats. Work notices are bounded likewise;
the owner must inspect complete evidence before acting on a truncated notice.

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
target or release its owner. For a handoff, have the old owner release it,
then claim it in the recipient. Release bindings after verified completion;
deleting a chat releases its bindings and disables its own supervision.

Bound chats receive local behavior ledger changes for their exact repository,
target number and issue/PR kind. PR owners also receive observed-head CI
failures and recovery. The monitor calls Caller's existing `--list-failing-ci`
primitive once per bound PR every five minutes, independent of browsers and
supervision intervals. On the usual unpaginated path that is three GitHub
reads per observation, at most 36 per hour per bound PR; pagination/retries
can add reads. Unbound work adds zero GitHub traffic. While any check is pending,
notifications wait and retain the last settled state, including when other
checks have failed. Unchanged settled failures deduplicate; unavailable reads are visible
as unknown evidence. These observations confer no merge authority.

Work changes also enter the existing structured diagnostic log with the target,
repository and responsible chat. The native `api` operation reaches Poise's
normal local API for Current, Swarm, Behaviors, Editor, snippets, settings,
models and analytics; existing route validation and drain policy still apply.
It never obtains a gateway/admin identity or access to another workspace.

`tests/chat-control.test.ts` covers the real command, HTTP control, runtime,
SQLite, concurrent isolated workers, replay, ownership conflicts, supervision,
Stop, targeted events, CI deduplication and credentials with scripted adapters.
It makes no live model or GitHub requests. Run `npm run check`.
