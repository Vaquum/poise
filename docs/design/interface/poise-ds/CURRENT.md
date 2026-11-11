# Board, against the brief

Called Current until round 11. The page is now `board.html`; `current.html` forwards to it, and every link and route back says Board.

Sources: `src/views/current-view.ts` in ~/dev/poise (21 Oct) and the live board at
you.poise.example.com (22 Oct: Plan 15 cards, Issue 21+, PR 179+). Round 13 re-read `main` at `e7b8fea` (1 Nov) and the owner's PRD #683 with its draft #790, and #790's merged code was read on 4 Nov at `741d2c4`.

## What Current does today (C1–C25)

**Header**
- C1 Organization filter: All orgs, or one organization. Applies to every lane.
- C2 Status: Any or Open. Applies to the live lanes only; remembered.
- C3 Time: Any time, Today, Yesterday or This week, by last update. Applies to the live lanes only; remembered.
- C4 Filter text, across all lanes: card text, plus the title and repository of live items.
- C5 Rooms, the bell and the menu (global).

**Lanes**
- C6 Five lanes on one line. Idea, Concept and Plan hold your cards; Issue and PR are live from GitHub.
- C7 Lane counts. A live lane shows "N+" with an explanation once 200 issues and pull requests combined are loaded.
- C8 Add a card: text, an optional linked repository, Add or Cancel. ⌘Enter adds; Esc cancels. Tells you when the filter hides the new card.
- C9 Add an issue: title, optional body and repository. "Open issue" opens it on GitHub as you. It is guarded while the write is out, appears at once, and tells you when the filter hides it.

**Your cards**
- C10 Text, linked repository and last-updated time.
- C11 Click or Enter edits in place. ⌘Enter saves; Esc cancels. A draft survives refreshes.
- C12 Drag to reorder within a lane or move between your lanes, with an insertion line.
- C13 Drop on Issue converts the card. The issue composer opens prefilled, and the card is deleted only once the issue exists.
- C14 Copy.
- C15 Chat about this card.
- C16 Delete, after a confirmation. Focus moves to the next card.

**Live issues and pull requests**
- C17 The title links to GitHub. Shows repository, number, a badge only when merged or closed, and last update.
- C18 Edge stripes:
  - green: ready to merge;
  - yellow: the merge button is green but a check fails or runs, or a conversation is unresolved;
  - blue: a pull request opened in the last six hours;
  - breathing teal: an agent run is on it.
- C19 Copy title and link.
- C20 Chat about this item.
- C21 Open in Chat: a chat on the PR's head branch, or on a new issue branch. Agent, model and branch are confirmed first.
- C22 Run PR review. Spins, then reports done. Unavailable for merged or closed pull requests, with the reason.
- C23 Live refresh on the shared tick. Lanes re-sort by update time and cards glide to new places; read failures go to the notification rail.
- C24 A just-created issue is shown at once until GitHub's copy arrives.
- C25 Errors and confirmations go to the notification rail.

Since then on `main` and in the owner's decisions:
- The server says why a pull request is held: a draft, a conflict, failing checks by name, checks running, changes requested, review required, an open conversation, behind, or blocked (#599). Each held pull request names its current blocker and since when (#747, #800).
- Creating an issue finishes as soon as GitHub confirms it (#606).
- PRD #683, with the draft #790: *+ Add* at the top of each lane; the repository's labels behind a subtle icon when opening an issue; editing an issue already created.
- The behavior chain carries an issue and its pull request as one task (#728, `CHAINS.md`).

## How the brief lands

| Brief | In Board |
|---|---|
| 1 · One vocabulary | Live items use the seven states, with the same words and colours as Chat. Each state's definition is now worded so it holds for chats, runs and pull requests alike. **Ready to merge becomes Needs you** (it waits for your merge): green means Done everywhere. The yellow stripe's meanings split, now that the server names the reason: checks running → Waiting, a check failed → Failed, an open conversation or a requested review → Needs you, a merge conflict → Blocked, a draft → Idle. The card says its blocker in the registry's words, such as *review running on 9c1e4a7 · round 1 of 5* or *conflicts with main*, and marks it once the same blocker has stood for 15 minutes. A stalled worker's pull request is Blocked, with what it left. Recently opened stays a blue "New" chip, because blue means information. Who is on an item shows as its chat or worker (W1, #475) or a run. |
| 2 · Reference | Every control, card part and display carries a key; `refdefs-current.js` holds Current's entries. |
| 3 · Overview | A count line above the board (Needs you, Blocked, Failed, Running, Waiting, Idle, Done) reads the whole board at a glance. Each count filters to that state. |
| 4 · By purpose | The same top bar as every view: Overview, Board, Chat, Editor, Observe, Settings. The board's own filters sit in the view, grouped as Scope (organization), Shows (status, time, what time means, text), Who and Order, with View beside the counts. |
| 5 · Defaults and ordering | Your lanes keep your order. Live lanes default to Attention (Needs you, Blocked, Failed, Running, Waiting, Idle, then Done folded at the end), with Recent activity and Repository as choices. The choice is remembered. Live updates never move a card under your pointer: they are held and counted, then applied when you leave. Each lane scrolls on its own under a fixed header. |
| 6 · Manager | Cards show the Manager's workers and their slots. "Hand to the Manager" (new) asks the Manager to take an open issue: it gives it to a worker, and the card says what happens, waiting for a slot, then running. |
| 7 · Review | Board joins the element review, with each of C1–C26 accounted for, and rows of their own for what round 13 added. |
| 8 · Feedback and continuity | Adding, editing, opening an issue, converting a card, a PR review and handing to the Manager all show accepted, queued, executing and completed on the card itself. Delete uses "× then Sure?" like Chat, and focus moves to the next card. Keyboard paths exist for what was drag-only: move between lanes, reorder, open as an issue. |

## Round 13: what the board adds

- **+ Add at the top of each lane** (#683, #790). The composer opens under the lane's header, and the new card or issue lands right there, in view. #790 still appends a manual card at the bottom; the mock puts it under the composer.
- **Labels when opening an issue** (#683, #790). A small tag button opens a filterable list of the repository's labels. It shows how many are chosen, clears the choice when the repository changes, and names any label GitHub did not apply. A failed read says so: `?labels=error`.
- **A read that fails.** The board says what it could not load and keeps the rest: *Board is not updating. Could not load GitHub issues and pull requests. Showing what is available.* `?board=partial`.
- **Edit an issue** (#683, #790). *Edit* on an issue card loads its title and body into the same composer. *Save issue* checks that nobody changed it meanwhile. If they did, GitHub's refusal reads *The issue changed on GitHub. Keep your draft and reopen the editor to load the latest version.*, the draft stays, and Save stays refused until you load the latest: `?conflict=1`. There is one issue writer at a time, so editing another issue first asks you to close this one.
- **Tasks** (#728). A chained issue and its pull request are one card, with its phase rail. Opening it shows its timeline beside the board, with Hold or Resume, and *Open in Observe*.
- **A card's chat beside the board.** *Chat about this card* opens in the side pane instead of leaving Board, with *Open in Chat*.
- **Routes in.** `?item=<repository>#<number>` opens Board on a card and flashes it; `?back=` names the route back: Overview, Chat, the Manager, Editor, Observe or Settings.
- **New numbers** continue from the workspace's newest: a new issue is #510. An issue handed to the Manager while all seven slots are held waits behind #483 and gets a worker on the Manager's first turn after a slot frees; a slot frees when you close a worker whose task has ended.

## 4 November: Board as a list

You said Current, Archive and Swarm each show part of the same work without connecting it, and asked for one list: what was opened today, narrowed by a word to a repository or organization, saying for each item its phase, whether it is Poise's, whether anything is happening now or it is stuck, with a way to assign it to Poise. Board already held most of that, on cards. So this is a second view of Board, and no new place.

- **View: Lanes | List.** The same live work and the same actions, one to a row: Issue, then PR. Your Idea, Concept and Plan cards stay in Lanes, and a link to one opens there. Lanes is the default, and Board waits as you left it, in this browser.
- **Updated | Opened**, beside When. On `main` Today means changed today (`updated_since`), so an old issue touched today counts. Opened lists what was opened today. `main` needs no new read for it: anything opened today has also changed today, and every record carries `created_at`.
- **Who: Anyone | Poise | Not Poise.** Poise means the chain carries it, read from `GET /api/behavior-chains`. A worker or a chat counts as Not Poise. The chip that read *Chain* now reads *Poise*.
- **The phase, on every row.** A chain's comes from its journal, with its round. Other work's comes from its current blocker, with no rounds: an open issue nobody has is Intake, one a worker or chat has is Implementation, a draft is Implementation, checks or a review waiting are PR review, a failing check, a conflict or a stall is Repair, approved and green is Merge.
- **How long.** *Running · for 8m* means something is working on it now. Any other state says how long it has waited, and after 15 minutes reads *the same for 36m*, the rule the blocker already had. Idle reads *no change for 2h*. It comes from a run's start, a chain's last step, `blocker.since` in `GET /api/behavior-ledger/pr-status`, or the last update. `main` keeps `blocker.since` in memory, so it restarts with the server (`sinceRestart`).
- **Assign to Poise**, on an open issue nobody has, as `main` has it since #853. It asks Sure?, because it starts real work, then adds the chain's label on GitHub as you, and the Poise chip shows at once. A refusal stays on the row with the reason: `?assign=refused`. While the chain is off it is still offered, adds the label, and the chain takes the issue once it is on: `?engine=v1`. While every open issue already enters, it is not offered: `?seed=all`. Every open issue shows the open pull request that closes it, or *no open PR*: the chain does not take an issue that has one. A failed intake read shows no label, Assign or pull request, and Board says so: `?intake=failed`. A pull request cannot be assigned, because `main` cannot enrol one (`docs/Behavior-chain.md`).
- **Beside the board.** Choosing any live row or card opens it in the side pane, where a chain's timeline already opened; the title still opens GitHub. The pane adds *The same work, elsewhere*: its task, its runs in Behaviors, its row in the GitHub history, and GitHub.
- **Links back.** A run's detail and a GitHub row now say *See it on Board*. A link clears a filter that hides what it names, for that visit only: what you left stays remembered.

**What it needs from the server.** Nothing: `main` serves `assign_issue` and `issue_intake` on `/api/gh` (#853). Everything else reads what `main` already serves.

**What it does not show yet.** Nothing that `main` knows: since #853 the intake read lists the labelled issues and the pull requests that close them.

**In #556.** You reopened it on 4 November so that everything stays in one ticket. List and Assign are in its PR 3, with Board. Since 11 November Assign is `main`'s, so #556 changes nothing on the server again.
