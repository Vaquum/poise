# Switchboard

The Switchboard pane shows, in one place, what every chat in the workspace is
doing: what is blocked, what has finished, and what needs your decision. It
sits on the right of Chat. There is no console in it: every action is a
button.

Behind it is one Muse chat per workspace, the Switchboard, which Poise runs as
an observer. It plays the Switchboard role from agent-tooling
(`switchboard/SWITCHBOARD.md` at `84db4d2`), adapted to Poise as described
below. It reads chats and reports; it never works on them, messages them,
answers for you or recovers them.

## Starting and stopping it

Open the pane with the Switchboard button beside the sessions toggle and press
**Start the Switchboard**. Poise creates the Switchboard chat with
`muse-spark-1.3-contributor-max`. If a catalogue refresh retired that model,
the catalogue's Muse model at max effort takes its place; if there is none, or
Muse is unavailable, the pane says why and nothing is created. Before you
start it, the pane says which model it runs and that in contributor mode Muse
may use the transcripts it reads for product improvement.

The Switchboard chat has a scratch workspace of its own, and its one turn at a
time runs outside the cap on concurrent Poise-local turns, so it neither waits
behind your chats nor holds one of their slots. It runs without Safe mode, so
no check stalls on an approval nobody is watching, and without Auto-merge.
Like every chat it is given the workspace's [Memories](Memories.md). It gets
no [Extensions](Extensions.md), whatever is switched on for Poise · local: it
reads chats only through Poise.

The Chat session list leaves it out. **Open the Switchboard's chat** in the
pane's header shows its transcript. Poise runs that chat: it takes no
messages, and its model, settings and title cannot be changed, nor can it be
reset, forked or handed off. There you can stop its turn and answer a question
or permission it asks; the pane's **Restart the Switchboard** resumes it.

- **Hide** closes the pane; the Switchboard keeps checking.
- **Pause checks** stops new checks; a check it has not started yet is
  withdrawn. Explain requests and your answers still go through.
- **Turn off**, pressed twice, deletes the Switchboard chat. Its updates stay
  in the pane; **Start the Switchboard** creates a new one.

## What it reports

Poise schedules the work. A check runs ten minutes after the last one
finished, or at once with **Check now**, when at least one other chat has
something new in its transcript: a prompt, a reply, a tool call, an edit, a
plan, a question, a permission request or its answer, steering, an error or a
close. Status changes, such as an idle timeout, are not news. A check never
runs while another check or an explanation is unfinished.

A check is a message to the Switchboard listing each chat with news, most
recently active first, with its title, agent, model, status, waiting requests
and the range of transcript events to read. It lists at most 100 chats within
30 KiB; the rest follow at once after it. A chat's range covers at most its
last 1,000 events; the check says how many older ones it skipped. The
Switchboard reads each range condensed: prompts, replies, tool calls with their
outcome, edits, questions, permissions, turn ends and errors, in pages of about
64 KiB. When it confirms the check, Poise moves each chat's read position to
the end of its range. If its turn ends without confirming, the next check
covers the same range again.

A newly started Switchboard reads each chat from its third most recent turn,
so its first report covers recent context rather than history.

Every update names the chat it is about and the transcript event it rests on,
which must still exist, and has one of four kinds:

- **Needs you:** a question the chat asked you in its own words and is waiting
  on. If the chat named its choices, the update carries them, up to four, in
  its words and order, its recommendation first; an open question carries
  none.
- **Blocked:** the chat cannot go on without something outside it. A question
  or permission shown as a card in the chat itself is reported as blocked,
  "waiting for your answer in the chat", and you answer it there.
- **In progress:** a finding or step worth knowing.
- **Done:** a completion, such as a merge.

One source event yields at most one update of each kind. Routine progress,
ordinary CI waits, unchanged state, answered questions and old completions are
not reported. A chat can have at most five open decisions, and the workspace
fifty.

## The pane

The pane opens at one third of the Chat view. Drag its left edge to resize it.
It snaps at one third and at one half, and a double-click goes back to one
third. With its edge focused, the arrow keys resize it (Shift for larger
steps) and Home and End go to the limits. The chat keeps at least 320 px, the
same floor the sessions pane leaves it. The width is remembered as a share of
the view, so Manager and Switchboard half and half, with the sessions list and
Memories hidden, stay half and half on any window. A window 1000 px wide or
less shows the pane floating over the chat, as Memories does; there, opening
one of the two closes the other, and Escape closes the one that is open.

- **Header:** whether the Switchboard is live, checking, paused or stopped;
  how many chats it watches; when its last check finished, what that check
  cost in tokens as its turn reported them, and when it checks next. **Check
  now**, **Pause checks** or **Resume checks**, **Open the Switchboard's
  chat**, **Turn off** and **Hide**.
- **Counts:** need you, blocked, in progress and done. Each count filters the
  chats below.
- **Needs you:** the longest-waiting decision, as a card. Its choices are
  buttons, the chat's recommendation first and marked. **Something else…**
  takes your own words; ⌘↩ or Ctrl+↩ sends. If the chat has started turns
  since it asked, the card says the question may be out of date. Other
  decisions wait below as one-line rows, and each answer you gave in the last
  ten minutes stays listed with where it is.
- **All chats:** one row per chat, with a lamp for its state, its latest
  update and how long ago that was. A chat whose last completion is more than
  45 minutes old is shown as quiet. A row opens to the chat's last five updates
  and **Open chat**.

While the pane is hidden, an amber count on its button shows how many decisions
are waiting, and a red **!** shows that the Switchboard stopped.

### Explain

Every update has **Explain**. The Switchboard is asked once what changed, why
it matters and what is still uncertain, and the answer is kept. The request
waits while the Switchboard finishes other work, and the next check waits for
it. If the Switchboard's turn ends without an answer, the pane says so and
offers **Try again**, which asks anew.

### Your answers

Only your browser acts in the pane: every action is a request that carries the
page's Origin (in service mode, with the gateway's assertion). A chat calling
Poise's APIs through its control command sends none and is refused, so no chat
can answer, start or stop anything here. A local process could forge the
header; this keeps cooperating agents out, it is not a security boundary.

Poise, not the Switchboard, delivers your answer: once, to the chat that
asked, at its next idle moment, headed "the person's answer, given in the
Switchboard pane and relayed by Poise". The message quotes the question as the
Switchboard summarized it, then your answer. Every chat's control context says
that such a message is your own answer and that no chat can send one. The
pane shows whether the answer is queued, delivered, or held because the chat
is stopped (resume it to deliver) or was deleted. A decision can be answered
once; sending the same answer again changes nothing. If the chat was answered
in its own conversation first, the Switchboard settles the decision and the
pane stops offering it.

## If it stops

Poise stopping or restarting during the Switchboard's turn is not its failure:
it carries on by itself, reads the cut check's range again, and offers **Try
again** for an explanation the restart cut.

A check whose turn ends without confirming counts as unfinished; three in a row
stop the Switchboard, so a failing observer stops costing. A turn that fails,
or that you stop, stops it at once, as Poise holds messages for any chat whose
turn failed. The pane says why, and **Restart the Switchboard** resumes it.

If its chat disappears, as when Poise deletes a chat whose model the catalogue
retired, the pane shows it off with that reason; **Start the Switchboard**
creates a new one.

## Trust and limits

- **What it may do.** Through the control command the Switchboard may call
  only `help`, `list`, `read`, `inbox` and its own `switchboard.*`
  operations; everything else is refused with 403 before any receipt. No other
  chat may post its updates, message it, steer it, stop it or supervise it.
  Poise's messages are its instructions; the transcripts it reads are data.
- **What it could still do.** Like every chat it runs as the workspace's
  operating-system user, and without Safe mode its agent's own tools need no
  approval. A Switchboard that ignored its brief could use those tools, call
  Poise's loopback APIs with a forged Origin, or read another chat's control
  connection file and act as that chat. The brief forbids all of it and Poise
  refuses it on every path Poise controls; nothing else enforces it. Muse
  approval modes apply rules from Muse's own host configuration, which Poise
  can select but not write, so Poise cannot allow the control command alone.
  The pane shows what it does in its chat, and **Turn off** ends it.
- **Untrusted text.** A chat's transcript can try to steer the Switchboard into
  a misleading update. Every update names its source event, a decision offers
  only that chat's choices plus your own words, and the relayed message marks
  the question as the Switchboard's summary. You decide; it does not.
- **Cost.** A check runs at most every ten minutes and only when a chat has
  news, covers at most 100 chats and 1,000 events per chat, and three
  unfinished checks stop it. Its turns appear in Swarm like any chat's.

## From the agent-tooling role

Kept: observing and relaying only, with no source work, recovery, workers or
unsolicited messages; transcripts as untrusted evidence; per-chat read
positions that advance only once a range was covered; the chat's own choices,
recommendation first, never invented; relaying the actual answer once, only to
the chat that asked; settling a question answered at its source without a
second relay; reporting material changes only, with the same suppressions;
exact chat titles; Explain as what changed, why it matters and what remains
uncertain; check cost from the turn's own reported usage, never estimated.

Replaced by Poise: appointment by the Start button instead of "you are
switchboard"; the ten-minute schedule, discovery and read ranges; delivery of
answers through Poise's inbox, shown as delivered only once the chat took the
message; structured updates in the pane instead of a three-heading text report
with links; state in the workspace database instead of private session files;
revisions announced on `/ws/chat` instead of a heartbeat envelope; the
workspace's time zone instead of a fixed one.

Dropped: sessions outside Poise, such as Claude Desktop, Claude Code, the Codex
app and Muse outside Poise, and GPT browser chats, which the Switchboard
cannot reach; the pane says they are not observed. Browser windows and
analytical source trackers have no counterpart.

## Interfaces

- **Browser:** `GET /api/chat/switchboard` returns the pane's state. `POST`
  `/start`, `/off`, `/check` (`{ queued, reason?, state }`), `/pause`
  (`{ "paused": true | false }`), `/restart`, `/items/<id>/explain` and
  `/items/<id>/answer` (`{ "optionId": "o1" }` or `{ "text": "…" }`) act;
  without an Origin they are refused with 403. While Poise drains for an
  update, Start is refused with 503 like any new chat. Every change is announced on
  `/ws/chat` as `{ "kind": "switchboard.updated", "revision": n }`.
- **The Switchboard chat:** the native control command's `switchboard.read`,
  `switchboard.items`, `switchboard.post`, `switchboard.resolve`,
  `switchboard.explain` and `switchboard.checked`. See
  [Chat orchestration](Chat-orchestration.md#the-switchboard).
- **Storage:** `chat_switchboard`, `chat_switchboard_cursors`,
  `chat_switchboard_checks` and `chat_switchboard_items` in the workspace
  database. Open decisions are always kept; other updates are pruned to the
  newest 2,000, and finished checks to the newest 50.

A Switchboard check that finishes raises no "finished after N minutes"
[notification](Notifications.md); one that ends early does, as for any chat.
