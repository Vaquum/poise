# Chat v1

Chat is a Poise-native window onto the installed coding agents, not a new
agent harness and not an embedded terminal UI. Poise owns sessions, streaming
and interaction; Claude Code, Codex, Grok Build and Muse do the agent work
through their native session interfaces. The implementation follows issue #68,
with the new-session policy below superseding its repository-picker design.

Chats can create and supervise workers, exchange durable internal messages,
claim issue/PR work and inspect Poise through the native control command.
See [Chat orchestration](Chat-orchestration.md).

## Scope and migration

Chat is a full view alongside Current, Swarm and Editor. Its sidebar stores
named sessions, each with when it was created on Poise's clock: the time today
(`19:38`), the date alone on another day (`20 Oct`) and in another year
(`31 Dec 2025`). The transcript renders streamed prose, thinking when exposed,
tool activity, file diffs, questions and permission cards. The composer supports
attachments, checkout-file mentions, advertised commands, draft preservation,
steering during a turn and Stop. Capabilities belong to each native session:
unsupported optional controls are not simulated.

Current cards, Swarm rows and Editor documents can hand off into Chat. A pending
legacy-row lookup is cancelled by leaving Swarm or choosing another row. Failed
lookups and unreadable responses retain the session link for retry and show a
read failure. A successful lookup contains either a session with a nonempty ID
or explicit `session: null`; only that null marks a conversation never opened
in Chat. Changing the agent creates a new native session with a labelled context
handoff, not a pretence that one vendor's session migrated to another. Each
Current card has one Chat session of its own, opened from the side pane or from
Open in Chat in the Chat view; the pane shows the card's earlier conversation
until the first message creates the session. `/content` and `/consensus` run
as Chat composer commands with transcript cards. Every Editor chat — the
document's own chat, passage threads on annotations, review threads — runs as
a Chat session too: the document chat in the side pane, passage threads inline
at their annotation, each importing its subject's earlier conversation on
creation. Antigravity models remain visible
in the catalogue, but native Chat launches need a permission/question channel
its current CLI does not offer.
pi, image input, worktrees and parallel turns on the same checkout are outside v1.

Editor edit cards disable Accept and Decline while saving and recording a
decision. Failed saves allow another Accept; retrying a failed decision after
a successful save records it without applying the edit again, across pane
remounts and page reloads. Decision admission also reloads saved markers from
other tabs, including when this surface was mounted before their save.
Origin-local recovery markers contain only the workspace/session/card identity, operation generation and transcript cursor; a later
authoritative decision or acknowledgement removes them. Older decisions cannot
clear a later saved edit. Markers use separate card keys, so an unrelated
decision in another tab cannot erase them. A late applied receipt withdraws its
Retry control and makes even a queued click on that old control harmless. This retains a known successful save, not an atomic
transaction between the server save and the client recovery write. Closing or moving
a passage chat preserves its session and outstanding permission and question requests
even while its initial history is loading;
the Needs you marker remains until every request has been answered. Moving a
thread transfers the latest composer, including an explicit empty draft. Closing a
passage or review pane opened from Chat retains its draft for the inline thread. Back
loads the thread's own document before reopening its passage or review. Suggested
review replies stay with their document and review across document switches.
Reply-only review cards in Chat also offer Open in Editor, where Use as reply
fills the GitHub composer without posting. Selecting a new suggested reply while
an earlier reply posts preserves the new unsent draft. Leaving Editor, switching
documents, or opening another external target cancels a pending conversation handoff.

## Fresh console and split pane

The empty console is writable without selecting or creating a session first.
Its initial choice is the saved Chat default (Settings → Models → Chat),
resolved against the current catalogue, like New session. Clicking
the model label opens an anchored dropdown grouped by provider, with each
model's catalogue effort variants and a checkmark on the current choice.
Unavailable variants remain visible with their provider's reason and cannot
be selected. Arrow keys, Home/End, Enter and Escape operate the dropdown;
Tab or clicking outside dismisses it. A failed catalogue load can be retried.

Selecting a model changes the fresh draft only: it neither creates a session
nor sends the message. The first Send or Attach validates that exact choice
against a freshly loaded catalogue and creates one Poise-local session for it.
The text and uploaded files stay together. New session remains available for
explicit session creation; existing sessions keep their current model controls.

If the selected model is absent or unavailable, the draft and choice are retained
and the reason is shown. There is no silent fallback. Session-creation and first-send errors
preserve the message, and repeated submission while creating cannot launch
another session. The console also returns to this writable state after the
last session is deleted. A selected session still starting its native agent
accepts a prompt through the runtime's existing serialized turn queue.

The sessions pane resizes from its right edge, remembers its width, and eases
open/closed without detaching its contents. Arrow keys resize the focused
separator, Home/End choose the bounds, and double-click resets the width.
Collapsed contents are inert; reduced-motion preferences suppress movement.
The fresh console has a 640 px maximum width, a taller writing area and a
slightly elevated position. Its border uses a low-opacity neutral hairline,
with no resting or focus shadow, in both light and dark themes.

The pane reads as a live work log. Every chat carries a status dot with a
text label and tooltip, so the state never depends on colour alone: Working
(pulsing green), Completed (solid green), Error or interruption (red),
Waiting for you (amber), and Queued (grey). Chats order by their latest
change — started, hit an error or a question, or completed — newest on top,
with the Manager always first, and a reorder animates smoothly. Its position is fixed; dragging another chat pins it where it dropped,
with a pin mark, and automatic ordering skips it; dragging it back into the
list, or Unpin, returns it to automatic order. Alt+ArrowUp/Down moves the
focused chat for keyboard users. Pins survive reloads in this browser.

The Switchboard pane docks on the right, after Memories, and its button sits
beside the sessions toggle with the mirrored icon. It opens at one third of the
view, resizes from its left edge with snaps at one third and one half, and
remembers its width as a share of the view. See [Switchboard](Switchboard.md).

## Transcript presentation and file links

New session, Fork and Hand off use icon buttons with accessible labels and
hover titles. The activity icon beside Fork shows or hides thinking, tool
cards, plans, completed interaction cards and turn statistics. The preference
is remembered in this browser. Hiding detail does not stop work or discard
transcript data or expansion state; unanswered questions, permission requests
and errors remain visible. Muse reminder-child items are internal housekeeping,
not task output. The adapter omits them and old reminder cards are hidden on
history replay without changing the stored transcript or normal subagent work.

Each finished turn ends in one meta row: when the turn ended, how it stopped if
it did not simply finish, its duration and tokens while activity is shown, and
the copy icon of its last message, which appears while that message or the row
is hovered. Every other agent message has its own copy icon under it, shown on
hover. The time is the one the server recorded on the turn's `turn.finished`
event, never when the page drew it. It uses a 24-hour clock in the time zone
from Settings → General, adds the date for an earlier day and the year for an
earlier year, and follows midnight and time zone changes. Hovering or focusing
it shows the full timestamp with how the turn ended, such as "Finished
Wednesday 21 October 2026 at 19:38:12 EEST" or "Stopped …", which is also what
a screen reader reads. A turn that Poise ended while restarting shows when
Poise recorded that end, as "Recorded as interrupted …". Prompts, tool cards
and running turns carry no time, and neither does a turn interrupted without a
recorded end.

Local Markdown links open a read-only file preview inside Chat. The preview
shows the current working copy, not a historical snapshot; line references
such as `#L12-L18` are highlighted. Reading happens only on click and never
wakes an agent or changes a branch. It is limited to the session workspace
and tracked Poise source in the running installation or the configured,
identity-verified Poise development checkout. Private paths, unsafe schemes,
symlink escapes, binary files and files over 512 KiB are refused. Long text
previews stop at 5,000 lines. File text never executes as HTML.

While a chat's turn runs, the three-dot indicator shows at the bottom of the
transcript, including during long tool runs, and disappears when the turn
ends. The Tools toggle beside the other display controls hides the tool
calls and command blocks while keeping text messages, errors and outstanding
requests; see [Chat permissions and display controls](Chat-controls.md). The
top bar shows how long the current turn has run next to the status — "Running
· since 12m", or "since 1h 5m" past an hour — updating live from the turn's
start, and "Queued · since …" while the turn waits.

## Sessions and working context

New session offers **Model** and **Effort**, with model families grouped across
all five catalogue providers: Claude, Codex, Grok, Antigravity and Muse. Efforts
come from the selected model's catalogue rows, not a provider-wide union. The
submitted identity always matches that effort. An unavailable provider stays
visible with its reason; Poise does not invent interactive capabilities or
silently choose a different model.

Each new Poise-local session gets its own scratch workspace,
`.poise-chat/workers/<id>/workspace/` inside the running Poise installation,
reusing the same primitive managed workers use. The root `/.poise-chat/`
ignore rule keeps workspace files out of Poise commits; every workspace under
the default root requires it. An independently initialized, remote-free Git
repository inside each workspace provides checkpoints and safe Revert without
switching or committing the outer Poise checkout. The session branch is an
internal implementation detail. The dialog contains no repository, branch, PR,
or location picker, and both REST and WebSocket creation routes discard such
fields, except `role`, which only REST accepts. Card/document handoffs supply
context, not permission to check out another repository.

At most one session per subject exists in a Poise instance, enforced by a
unique SQLite index over the stored subject. A Current card's subject is its
legacy chat id; opening the card resolves its session, and the first message
or attach creates it and imports the earlier conversation as the session's
first event. Creating for a subject that already has a session returns it.
Handing off moves the subject to the new session; forking, resetting and
deleting never duplicate it, and deleting frees it for the next chat.

One Manager session can exist per Poise instance (`ChatRuntime.instance`,
`poise-<label>:<POISE_DB>`), enforced by a unique SQLite index on
`chat_sessions(instance)` where the role column is `'manager'`. The person
creates it in the New session dialog, which offers a Type choice of Chat,
Worker or Manager; only REST `POST /api/chat/sessions` with a browser `Origin`
creates one (in service mode, through the gateway's assertion). WebSocket `session.new`
and control `create` refuse a role. The `Origin` rule is cooperative: it refuses
the documented non-browser paths, but a loopback process can still send
`curl -H 'Origin: http://127.0.0.1:<port>' …` and create a Manager. The Manager
runs in the default isolated workspace every new local chat gets, takes only
its own checkout lease, and runs outside the cap on concurrent local turns, so
it still runs while its workers hold every slot.

The Manager is never auto-titled, cannot be forked or handed off, and keeps its
role through rename, close, resume, reset and compact. Deleting it frees the
singleton at once. When its model leaves the catalogue, the next startup keeps
the Manager instead of deleting it, marks `retiredModel`, and refuses every
turn until the person picks another model with `set_model`; retirement is
detected at startup only. A closed Manager still holds the key.

A worker (`role: 'worker'`) is created the same way, with no singleton limit;
unlike the Manager it keeps the requested title and is auto-titled like any
chat. It keeps its role through a fork; a handoff starts an ordinary chat.

Other chats are named from the first message when the first turn starts. When
the message references a GitHub issue or PR, the chat takes that item's title
without its type prefix, plus the number — "#446 Let a pending Poise update
land within a bounded pause" — resolved from the local GitHub datastore when
it knows the item. Otherwise the first sentence names the chat with
boilerplate removed: "Task:", "Could you take this task?", "Implement" or
"continue", repository refs and URLs. A name the person set by hand is never
overwritten.

The person's REST actions on a chat answer only the person's browser: `cancel`,
`close`, `fork` and `handoff`, renaming through `PATCH` and deleting through
`DELETE /api/chat/sessions/<id>` refuse with 403 unless the request carries a
browser `Origin` (in service mode, through the gateway's assertion), as does
`POST /api/agent-stop` when its ID names a chat turn. The native control's `api`
operation sends no `Origin`, so no chat can take these actions through it;
chats steer, answer and stop through the control operations instead. Resume,
reads and creation through `POST /api/chat/sessions` are unchanged. Like the
Manager-creation rule above, this is cooperative: a loopback process can forge
the header.

Existing repository-bound sessions and their transcripts remain intact. They
still use their original checkout and branch; this change does not move files
or rewrite their history. Sessions already on the legacy shared workspace,
`.poise-chat/workspace/`, also stay where they are and keep queueing behind
each other; nothing is migrated. Transcript metadata continues in Poise's
existing SQLite store. Legacy session switching checkpoints owned dirty branches as
`wip(poise): checkpoint` and refuses unowned dirty work. A new local session
never stashes, commits, or switches the enclosing Poise source checkout.

A fork or handoff stays in its source session's workspace, sharing that
checkout and its lease with the source. A handoff waits for pending source
startup before creating its target; a closing source, running turn, or absent
source branch refuses the handoff without moving its subject or work bindings.
A deferred chat prepares its branch under the checkout lease without starting
its original provider. A provider error does not block handoff when the source
branch exists. Source admission is checked again after target model/auth
preparation, before any target is stored or ownership moves. Once created, the target queues behind any turn holding the shared checkout lease.
Deleting a session removes
its own scratch workspace only when no other session still uses it, its
branch tip never moved, and its tree is clean; otherwise the workspace is
kept, and the delete confirmation says which applies. Lock files are never
deleted, and no server sweeps workspaces by its own session table: development
and production share the chat root but keep separate session tables. A setting
caps concurrently running heavy work (default 4): Poise-local turns and the
agent runs background behaviors launch draw from the one pool, so builds and
test suites cannot pile past the cap no matter which surface started them. A
turn held by the cap shows `queued` with its own reason, "waiting for a free
agent slot"; a behavior launch past it defers without backoff instead, names
the busy budget in its failure, and retries when a slot frees. Raising the
cap starts waiting turns at once, in queue order, up to the new cap;
lowering it stops nothing, and new turns wait. While the cap holds at least
two, delegated, supervised and timer turns together with behavior runs leave
one slot free, so a turn you send starts without queueing behind background
work; while the background budget holds two, those turns leave one more
slot for behavior runs, so worker load cannot stall the reviews and
approvals that finish the workers' own work. The
Switchboard's chat runs one turn at a time outside that cap, so it keeps
reporting while every slot is busy, and the Manager's turns run outside it
too, so supervision still runs when every slot is busy. The health endpoint
reports the pool (running and queued work, oldest queue age) next to the
main-thread stall figures, so queueing and its cause stay visible together.

The checkout lease is shared by Poise development, Poise production and the
compatible Caller writing behavior. Turns in different checkouts can run
concurrently; another session on the same checkout is visibly queued.
Per-session workspaces make same-checkout contention rare; it remains for
forks and handoffs on one workspace, development versus production, and
orphan holds. The lease covers startup, execution, tool services and
process cleanup, not only the subprocess launch. Worker gates register a process group before allowing
it to run. An unverified surviving worker keeps the checkout blocked.
A holder counts as alive only while its host process is still the one that
acquired the lease — the pid plus its start time — so a pid the operating
system reused after a restart never pins a dead lease.
A Poise-side filesystem operation must finish before the lease is released;
killing an agent cannot cancel filesystem work already executing in Poise.

These are cooperative application locks. They do not prevent a person or an
unrelated program from modifying the checkout outside Poise. Native agents
also retain their own tool and sandbox policies; a working directory alone is
not an operating-system sandbox. Separate working trees are not
confidentiality: agents run as the same operating-system user and can still
read each other's files. See SECURITY.md for the trust boundary.

## Persistence and recovery

`server/chat/storage.ts` mirrors events with monotonically increasing sequence
numbers. Reading a transcript does not launch or wake an agent. Reconnecting
browsers replay the mirror from the last contiguous event received and then
rejoin live events. A future event cannot advance the watermark past a gap.

Mutating WebSocket commands have durable receipts, keyed by runtime instance
and request ID with a canonical command hash. Concurrent retries share one
execution; a changed payload under the same ID is rejected. Completed receipts
survive a server restart. A pending receipt whose outcome is no longer known
returns `command_in_doubt`: it is never permission to run the mutation again.
Inspect the session before deliberately submitting a new action. Receipts and
transcripts are local data and are retained rather than evicted in a way that
would make an old command executable again.

Server restart does not replay prompts, but a turn a live relay holds keeps
running through it. Each session's agent runs under a per-session relay that
owns its stdio and spools the turn's output; after a restart the new server
reconnects to live relays, rebuilds each adapter over the spooled bytes, and
continues the turn without repeating a persisted event or writing to the
agent. Adoption works across releases: relay identity does not name the
install directory, so a new release adopts relays still running from the
previous one. A handoff that never reaches LIVE within a minute fails
instead: the turn is interrupted and its processes terminated, never left
running unseen. The adopted relay retires when its turn settles; the next
prompt starts a fresh relay and resumes the same native session. Open turns
with no live relay become interrupted and pending
interactions are cancelled, while sessions owned by another live host are
left alone, as does a turn whose relay or replay fails — its transcript
says the handoff failed. Follow-ups that waited behind an interrupted turn
continue on their own; the interrupted turn itself is never retried, and a
Stop — asked before or across the restart — still ends its turn and holds
its chat until the person sends again. The terminal transcript event, immutable Caller
outcome and clearing of the open-turn marker commit in one SQLite
transaction. Caller finish failures remain in a durable outbox even if
later turns run or the session is deleted; recovery retries the actual
recorded outcome. A failed recording operation must not turn a completed
turn into an invented failure.

Stop cancels the turn, not the session. Native cancellation is acknowledged
only when the adapter can account for its work. Claude messages are UUID-tracked
across native results so queued steering remains part of the same Poise turn.
If accepted messages cannot be accounted for, the process is ended and the
turn fails visibly rather than being labelled successful. A stopped Claude
session resumes its native ID on the next explicit action.

Muse steering is either absorbed into the running turn or runs as a
subsequent native turn. Stop accounts for every accepted send: it reclaims
queued turns through the native queue interface or interrupts their exact
IDs if launch won the race. A steer the agent never ran does not fail the
turn: the turn completes normally, the process is kept, and the steer's
original text runs as the next prompt through the durable queue, headed by
a note that it arrived after the turn. A turn that fails or is stopped
drops its unrun steers and reports its real outcome instead. A forced
protocol close asks the runtime to verify worker termination before
releasing the checkout.

## Files, attachments and Editor

Poise's filesystem services validate checkout paths and perform bounded
reads and atomic writes. Uploads are session-owned, carry server-issued IDs
and are looked up again by the runtime. Browser-supplied inline file text is
not trusted as authoritative. Uploads and file operations participate in the
checkout lifecycle and cannot outlive release of their lease.

The existing Editor stores Markdown in its configured directory, normally
`~/.poise/editor`; it is not a repository browser. Chat therefore uses a
session-owned staged copy inside the checkout and version-checked writeback.
A concurrent Editor change preserves the conflict copy instead of overwriting
newer writing. Two sessions and their forks do not share mutable stage paths
or remove each other's preserved copies.

A diff is a record of an edit that already happened, not an approval request.
Revert checks that the current file still matches the recorded post-image
before restoring the pre-image. Unreadable or unverified pre-images must not
be treated as nonexistent files: doing so could delete existing work. Native
unified patches and complete file records are distinguished; the implementation
must not offer a destructive Revert for a patch it cannot safely reconstruct.
Provider-specific coverage limitations belong in the verification record,
not behind a simulated success state.

Poise also captures a bounded before/after checkout snapshot for each turn.
Its separate "Checkout changes during this turn" card records shell edits and
automatically approved writes that native tool events do not fully describe.
It is a whole-turn observation, not attribution to one native tool. The default
bounds are 20,000 file paths, 8 MiB per file and 64 MiB of captured content.
Ignored file contents are not copied unless explicitly needed for the session's
Editor stage. Their names are inventoried so a changed ignore rule cannot make
an old ignored file appear to be a newly created, safely deletable file.
Binary, oversized or unreadable changes produce explicit coverage warnings;
they are never offered as reversible from an invented pre-image.

Large recorded diffs use bounded previews over WebSocket and in history.
"Load complete diff" retrieves the immutable full record on demand; Revert
stays disabled until that record has loaded. The full record remains in SQLite
and the server checks it, not the browser preview, when reverting. This avoids
oversized events trapping a reconnect in the same failed replay repeatedly.

## Native interfaces and credentials

The adapters live under `server/chat/adapters/`:

| Agent | Interface | Version basis |
| --- | --- | --- |
| Grok Build | ACP over stdio JSON-RPC | installed Grok; captured protocol traces in tests/fixtures/chat |
| Claude Code | Claude Agent SDK through the subscription wrapper | SDK 0.3.274, written against Claude Code 2.1.274 |
| Codex | app-server over stdio JSON-RPC | generated types and version marker under generated/codex |
| Muse | MSP over stdio JSON-RPC | generated schema and version marker under generated/muse |

Adapters expose the native models, efforts and optional capabilities rather
than inventing substitutes. A protocol/version mismatch is a readable startup
error, not a silent downgrade. Settings supplies the default Chat model; a
fallback is an explicit user choice when the selected provider is unavailable.

Poise passes no provider key. Claude continues through the existing monitored
subscription wrapper and exact environment allowlist. The other agents use
their own installed login state. The wrapper does not change account-level
usage-credit settings, and live verification consumes the relevant account's
usage. Authentication/usage failures are not grounds to retry indefinitely or
silently switch to a billed API credential.

## Caller and release integration

Chat requires the companion Caller additions: `--record-turn start/finish`,
external `poise:chat` rows, and the shared checkout lease around writing work.
Caller records the ledger but launches no process for a Chat turn. Swarm's
Stop routes these rows back to ChatRuntime rather than to Caller's one-shot
process stopping path. Other behavior rows keep their existing semantics.

The companion implementation is developed separately from the user's live
Caller checkout. Before production promotion, publish a compatible Caller
revision through the normal managed release process and verify the tracked
release can record turns and cooperate on checkout locks. Do not point a
production service at an ad-hoc development clone to bypass release checks.
An older Caller produces an explicit compatibility error.

## Verification record — 2026-09-18

Run `npm run check` for lint, unit/integration tests, typechecks and production
build. Run `npm run test:e2e` for isolated Playwright fixtures, or `npm run verify`
for both. The browser suite covers the new view and the existing dashboard;
it is not evidence that a live provider honored an interaction.

Final validation on the implementation checkout:

| Check | Result |
| --- | --- |
| `npm run verify` | Passed: 617 unit/integration tests in 59 files, lint, all three typechecks, production client/server builds and 28 Playwright tests |
| Companion Caller Python suite | 299 installed-package tests passed across all three packages, with isolated data |
| Actual Poise TypeScript to companion Caller CLI | Recorded completed/cancelled turns; repeated start/finish deduplicated; no provider calls |
| `npm audit --omit=dev --audit-level=high` | Zero vulnerabilities reported |

The detailed local logs are retained under `/tmp/poise-chat-v1/`, notably
`pr-final-verify.log`, `caller-ci-local.log`, `caller-bridge-result.log` and
`production-dependency-audit.log`. Temporary evidence is not a substitute for
rerunning the checked-in regression suites after later source changes.

Independent regressions cover command replay, reconnect ordering, origin
checks, bounded socket shutdown, process descendants, shared leases, scoped
filesystem operations, atomic prompt reservation, permission scoping, Editor
conflicts, durable Caller finalization and rollback on an outbox write failure.
The companion Caller's Python suite and a real Poise-TypeScript-to-Caller-CLI
probe also verify recording without launching a provider.

Live checks use temporary repositories and databases, not production data.
The following is deliberately separate from fixture coverage:

| Agent | Live evidence recorded during implementation | Remaining qualification |
| --- | --- | --- |
| Grok | Native text, steering request, permission and question roundtrips, Stop, subsequent use and native-ID resume observed | A separate real-browser probe measured 72 ms from native stdout to paint; see the PR follow-up below |
| Claude | Native startup/text, steering with the revised reply, an actual question answered B, permissions during a file write, Stop/subsequent use, native-ID resume with remembered context, and file creation/Revert observed | Native user hooks remain active; a fixture repository can trigger hook warnings. Not every model/effort combination was exercised |
| Muse | Text, steering, actual permission/question roundtrips, Stop/subsequent use and native-ID resume observed. Separate checks verified auto-approved file creation/diff/Revert and Stop with a queued steer | The queued-steer Stop observation was 211 ms, followed by a successful prompt; this is a measured instance, not a worst-case guarantee |
| Codex | Native interface/schema inspection and scripted app-server tests | Live turns were blocked by the account's usage limit; no repeated attempts or credential fallback were used |

Passing fixtures do not remove these qualifications. Complete live validation
of Codex is still blocked by quota, and the latency observations below are
not universal worst-case guarantees. These validation runs did not change
production services or data.


## PR verification follow-up — 2026-09-18

`tests/e2e/chat-latency.spec.ts` now measures the complete rendering path:
separate ACP process -> real Grok adapter -> ChatRuntime/SQLite -> real
WebSocket -> the built Chat view in Chromium -> a rendering opportunity.
The default test uses a deterministic, timestamped ACP process and makes no
provider calls. Eight streamed samples measured 18–29 ms across the local runs on the development
machine; the test requires every sample to render within 1,000 ms. Reload
also verifies transcript restoration without launching another agent.

An explicit `POISE_CHAT_LATENCY_LIVE=grok` run substitutes the installed Grok
executable, using temporary checkout/database state and one harmless prompt.
That observed first native text frame reached browser paint in 72 ms. This
is an observed native-stdout-to-paint measurement, not an assertion about
provider generation time or every future load condition. The test attaches
its JSON timing record to the Playwright results.

The initial Poise PR passed Linux CI on Node 20, 22 and 24. Caller CI exposed
an installed-package versus source-test gate-path mismatch and bounded `ps`
output on Linux. The fix tests the gate shipped with the imported package
and requests an untruncated process command; the installed-package local
suite passed 299 tests, including the independent identity checks.

## Local-session catalogue follow-up

The simplified new-session dialog and fixed Poise-local workspace passed
`npm run verify`: 617 unit/integration tests, all static/build gates and 28
Playwright tests. Coverage includes every catalogue provider and model-specific
effort, preserving the outer checkout and dirty work, queueing local sessions,
rejecting symlinked storage, retaining an unsettled bootstrap lease, and stripping
repository/branch/path inputs at both public creation endpoints.
The local log is `/tmp/poise-local-catalogue-final-verify.log`.
