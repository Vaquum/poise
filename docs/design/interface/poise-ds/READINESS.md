# Production readiness

Read on 4 November 2026 against `main` at `741d2c4`, with v2 published. Every check below ran on the final files, after the last change. The change logs are [CHANGES-2026-11-04.md](CHANGES-2026-11-04.md) and [CHANGES-2026-11-03.md](CHANGES-2026-11-03.md); the build contract is [PRD-INTERFACE.md](PRD-INTERFACE.md).

Board's List came after this pass, at your request; section 7 says what was checked for it. Section 8 is the pass of 11 November, on `main` at `bb30bb3`. You accepted the designs as ready to build from on 4 November, against `main` with v2 published. #556 stays on hold until you authorize it.

## 1. The whole app

| Check | How | Result |
| --- | --- | --- |
| One world | Every worker, task, pull request, slot count and the next ticket, read from Chat, the Manager, Board, Overview and Observe → Tasks at once | All agree. Board draws an idle card with nothing to say without a state line, by design. |
| One timeline | Seven places loaded together, with the scripted evening sped up (`?t1=2500&t2=5000&t3=7500`), read before and after each event | The bell reads 18, 19, 19, 20 on all seven. W3 and its issue #478 turn Needs you, #471 merges and W2 finishes, and #487 turns ready, at the same moment on Overview, Board, Chat and the Manager; slots in use stay 7 on both counts, and #483 waits for the same reason. |
| Top bar | Its markup compared across the seven places | Identical. Overview's bell says it scrolls to Answer here, where the others say it opens it. |
| Shared data | Which pages load the workspace and task data | All that show the bell or the work. Four did not, so their bell read 19 with a false idle-slot notice; fixed, and the idle check now refuses to guess without a reading. |
| One source for the bell | Who changes the count | Only Overview's data. Chat and Board used to add one by hand while Overview's data raised the same question a second later, so a slow page could count it twice; the arrivals now share the scripted clock, update the work they come from, and the bell's markup starts at the world's 18. |

## 2. Each place, against PRD-INTERFACE.md

| PRD | Checked | Fixed in this pass |
| --- | --- | --- |
| Overview | Answer here grouped by who acts, with the PRD's mapping: a pull request ready to merge is Needs you, Ready is called Done; chat requests in their own words; answers Accepted, then what happened; Dismiss and Silence with Undo; Handled today; the right side's five parts | A request answered elsewhere, cancelled, or cut off now turns its answers unavailable with the reason (`?request=elsewhere`, `cancelled`, `offline`). The PRD's own example of a notice without an answer, Merge, was stale: merging as you is an answer since #599. |
| Board | Ready to merge as Needs you; blockers; + Add at the top; one card per task; held updates; a card's chat in the side pane | Each of `main`'s fourteen blockers has its words and state in the registry (`card.blocker`). The standing-still mark resets when a blocker changes. |
| Chat and the Manager | Three panes; the controls in the header; Hold apart from Pause new work; no Manager; the Switchboard's states and controls; opening the place starts nothing | The slot lifecycle follows `main` (§4). The Switchboard relays an answer in `main`'s words: Delivered, Queued or Held. |
| Editor | Status line, side pane, inline threads, Import | Typing `?` in the page no longer opens the reference: the shared key handler now skips editable pages, as the PRD's "outside text fields" says. |
| Observe | Tasks, Behaviors with estimates, GitHub, Logging, links in and routes back | Running agent runs carry `main`'s estimate. |
| Settings | Ten sections with their own addresses; rows that save themselves; Undo only where reversible; `/` for Find; v2's switch, seed scope and capacity against the merged code | Following shows northwind's failing sync as `main` does, with Retry, matching Overview's notice. Rhythm says it applies from the Manager's next turn. |
| v2, merged | Every chain rule a person can see: what holds a chain, a Stop that holds it, Resume that raises no limit, the merge queue's repair, budgets and ceilings, Storage's categories, the issue conflict and one writer at a time | The mock's held task was a case `main` repairs; it now shows a removal by hand. CHANGES-2026-11-04 lists the rest. |
| `main`'s text | Every string a person can read in `main`'s interface, compared with the mocks and the PRD's kept code | Nineteen real gaps fixed, the largest JEV's whole builder, narrow windows, the slash menu, Claude's subscription, the new-build notice and Notifications off. CHANGES-2026-11-04 lists them. |
| Everywhere | Tooltip after half a second, `?` and the tooltip's link for the reference, long press, unavailable controls focusable, a still top bar | When a live view re-renders the element a reference is about, the spotlight now follows it; it used to stay on the old one. |

## 3. Fine detail

| Check | Result |
| --- | --- |
| Element review | 469 rows; all 318 live behaviours accounted for; every key resolves. All 422 *See it* links open their element, visibly, with no error. |
| Pages and states | 117 pages and states, every state the mocks have: no unknown reference key, no reference text that throws, no control without a name. |
| Console | The same pages opened in a fresh tab after the last change: no error. |
| Narrow windows | 17 pages at 375, 768 and 1000 pixels wide: none overflows, and each place was looked at on screen at phone width. |
| On screen | Every state added this round was looked at, not only tested in code. That caught a notice covering Chat's composer, a transcript from the wrong chat, and a wrapped header. |
| Registry | 638 entries, each used by a page or by an element that appears on use. Two dead entries removed. A row's current value that read nothing (Following) fixed. |
| Tokens and scripts | Lint: 0 violations. All 35 scripts parse. |
| Copy | Model names written one way; no past event dated after the mock's 19:41; the automation account is bit-mis everywhere. |

## 4. What `main`'s code settled in this pass

| Question | `main`'s answer | Source | The mocks now |
| --- | --- | --- | --- |
| Who closes a worker chat? | Only you. Closing is the person's action, and the Manager's control operations have none; `main`'s UI never calls it. | `server/chat/transport.ts`, `server/chat/runtime.ts` | After #471 merges, W2 keeps its slot and says so. Its work-table row offers *Close W2's chat*, and Idle · closed follows. |
| When does a free slot get a ticket? | On the Manager's next turn: Rhythm is policy each turn carries, and a turn comes from a wake-up, a message, or a wake from Poise such as a merge | `server/chat/manager-policy.ts`, `docs/Chat-orchestration.md` | Rhythm, Close and Pause new work say *on the Manager's next turn*; a message gives it one, and it starts W8 on #483. A worker that opens a pull request keeps its slot. |
| What holds a slot? | Each worker chat until it is closed | `server/worker-capacity.ts` | Unchanged; finished workers count as *done and still open*. |
| Notices | Titles and bodies verbatim | `server/alerts/notices.ts`, `producers.ts` | Verbatim; grouping follows the PRD's mapping, as the PRD decided. |
| Run estimates | Five similar runs at least; overrun past the 90th percentile | `server/behavior-estimates.ts` | Observe's running agent runs |
| Pull request blockers | Fourteen, first match wins | `server/behavior-pr-status.ts` | `card.blocker` |
| Switchboard answers | Delivered, Queued or Held | `src/views/chat-switchboard.ts` | `sb.relay` |
| Following | Sync failed and Activation failed, with Retry | `src/settings.ts` | northwind |
| SSH keys | Five states | `src/views/ssh-keys.ts` | All five |
| Review cap | *legacy only* | `src/views/behaviors-view.ts` | The same words |
| Switch to v2 | Its setup check, the drain, the legacy check, and v2 paused | `src/views/behavior-chain-settings.ts` | Every state, `?engine=paused` included |
| The chain's ceiling | Running at once less the one kept for your turns | `server/check-semaphore.ts` | 2 of 9 model runs |
| Import | 5 MiB, UTF-8, line endings only | `src/views/editor-view.ts` | The same limits and refusals |
| What holds a chain? | A queue removal by hand or unknown, a reported blocker, a breached ceiling, your Stop, cleanup not proven. A failed check in the queue goes to a fresh repair | `docs/Behavior-chain.md` | `side.hold`, #501, and Stop on a chain's run |
| Notifications off | Stops notices and the check of pull requests at once; Behaviors' diagnostics stay | `docs/Notifications.md` | `?notifications=off` |
| Claude's subscription | Six states, on every view | `src/claude-auth.ts` | `st.claude` |
| A new build | Refresh keeps drafts, and waits for what a reload would lose | `src/self-update-watch.ts` | `st.build` |
| The slash menu | Eleven commands | `src/views/chat-composer.ts` | The same eleven, in the same words |
| Explain | Asked once and kept; Hide explanation; Try again on failure | `src/views/chat-switchboard.ts` | `sb.explain` |
| JEV | State in, typed answers out; not a conversation; never sent twice by itself | `docs/Jev-primitives.md` | `jev.*` |
| Narrow windows | The nav scrolls, panes float, columns stack, at 1000, 820 and 760 | `src/style.css`, `chat-switchboard.css` | `narrow.css` |

## 5. Your answers, 4 November

- *Close W2's chat* on a finished worker's row: you chose it. It calls `main`'s existing close, your own action, which classic's UI never calls; PRD-INTERFACE.md says so.
- Board's blocker words: you left them to the design. They stay the registry's words, as PRD-INTERFACE.md already specifies.
- The review export: you asked me to do it. It is in the repository (§6).

The other choices where `main` has no answer, CHANGES §3's eight decisions and the words for a request that can no longer be answered, stay as built; each is easy to change.

## 6. In the repository

- Branch `docs/interface-review-refresh`, made from `main` at `741d2c4`, holds the refreshed `docs/design/interface/review.json` (470 rows, 369 with live IDs, 318 distinct, and the repository's 36 capability mappings kept as they are) and `docs/V2-rehearsal.md`'s new counts for it, as one commit, `bfc556b4`, in Conventional Commits and without assistant attribution, as the repository requires. Every path the review names exists, the documentation gate. You asked for it to be pushed: the branch is on GitHub, with no pull request, and `main` is untouched. Your branch `fix/bound-review-launch-contention` is untouched.
- The mocks themselves, with their screenshots and tools, are committed on the local branch `docs/interface-mocks`, on top of that branch, so they outlive this session. It is not pushed: the repository is public, and the mocks name a private host, which needs clearing before they go there. `~/dev/poise` is back on the branch it was found on.
- A lock file left by a git command that crashed on 22 October had blocked every index write in that checkout; it is removed.
- #556 was rewritten and sealed on 4 November: a second page beside classic, five PRs, nothing moved. You reopened it the same day to add Board's List and Assign to Poise, and it was sealed again. It stays on hold until you authorize it by its title and number.

## 7. Added after this pass: Board's List

It touches Board and Observe, so these were checked on the final files. The other pages were not swept again.

| Check | Result |
| --- | --- |
| Element review | 480 rows, 433 *See it* links. All 48 distinct links into Board open their element, visibly, with no error, both with no choice stored and with List left on. All 45 into Observe do too. |
| Registry | 649 entries. Every key on Board, in both views and both side panes, and in Observe's four parts resolves. |
| View | A first visit opens on Lanes. List survives a reload and going elsewhere. A link that asks for a view is not remembered; your own choice is. Choosing Lanes again is remembered too. |
| Assign | Sure?, then Accepted, Queued, the Poise chip, its phase and Running. A refusal stays on the row, and it can be asked again. Unavailable, with the reason, while the chain is off. Not offered while every open issue enters. An issue the chain did not take says so. |
| Links | Board to the task, runs and GitHub row, and back, each to the exact row with a route back; a filter that hid it is cleared for that visit only. |
| Narrow windows | Board in both views at 375, 768 and 1000 pixels wide: none overflows. |
| Tokens and scripts | Lint: 0 violations. The changed scripts parse. No console error on these pages. |

## 8. The pass of 11 November

[CHANGES-2026-11-11.md](CHANGES-2026-11-11.md) says what `main` changed and what the mocks now show. Board, Observe and Overview changed, so these were checked on the final files; the other pages were not swept again.

| Check | Result |
| --- | --- |
| Element review | 494 rows; all 318 live behaviours of the inventory still accounted for. All 133 distinct *See it* links into Board, Observe and Overview open their element, visibly, with no error. |
| Registry | 669 entries. Every key on Board in both views, Observe's four parts and their new states, Overview, partial Behaviors and the Manager resolves. |
| Narrow windows | Overview, Observe's four parts, Board in both views, the Manager and the new states at 375, 768, 1000 and 1440 pixels wide: none overflows. |
| Tokens and scripts | Lint: 0 violations. Every changed script parses. No console error on these pages. |
