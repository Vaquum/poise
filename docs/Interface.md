# Interface

Poise's interface is one page: `index.html` with `src/ui/main.ts`. It is dark, and
it follows the owner's *Poise Interface and Interaction Brief*: one vocabulary, a
reference for every element, a strategic overview, places by purpose, stability
during live updates, the Manager's controls, and clear feedback. The design it
was built from, and the review of every element of the interface it replaced,
are in [`design/interface/`](design/interface/) (#556).

Until it is removed, the previous interface is at `/classic.html`.

## Places

The top bar is fixed: **Overview · Board · Chat · Editor · Observe · Settings**.
It is drawn once; moving between places mounts the place under it.

| Place | What it holds |
| --- | --- |
| **Overview** | *Answer here*: everything that wants you, with the answer on each entry, from notices, open chat requests, the Switchboard's decisions and review threads. *In motion*: the work in the seven states. The day's numbers with their pace and year, the 30 days before in five bins under each year, Behaviors' runs, minutes and success, and System health over the last 24 hours (#1101). The bell on every place counts what Overview's level shows and opens *Answer here*. |
| **Board** | Ideas, plans, issues and pull requests in the seven states. A chained issue and its pull request are one task card; a card's chat opens beside the board. **List** shows the same work as rows, with its phase, whether Poise owns it, what is happening and *Assign to Poise*. Board keeps the view you left. |
| **Chat** | Conversations with agents, the Manager and its workers, on classic's chat: the list in the seven states, the conversation and its composer, the open chat's timers, and the Switchboard pane. JEV is in Chat. |
| **Manager** | Reached from Chat and from Settings → *The Manager*: the Manager's chat beside the Switchboard, with its wake-up interval in its header. Its controls are in Settings → Manager. |
| **Editor** | Long-form writing on classic's Editor, with its own panels for Comments, Reviews and Publish and the document chat beside it. Passage and review threads stay inline. |
| **Observe** | **Tasks** (the chain's evidence: its state line, Needs attention, each task's timeline, Hold and Resume), **Behaviors** (every run), **GitHub** (issues and pull requests) and **Logging** (diagnostics, with Work impact). |
| **Settings** | General, Accounts, Models, Extensions, Publishing, Behaviors, Snippets, Admin, Style and Manager, each at its own address, with Find. Each setting saves itself on its row and says when it applies. |

First-run setup opens before any place while the workspace is not set up.

## Addresses

A place is `?view=<place>`: `overview`, `board`, `chat`, `manager`, `editor`,
`observe` or `settings`. Observe adds `part=tasks|behaviors|github|logging`;
Settings adds `settings=<section>`; Board and Observe's GitHub part add
`item=<owner/repo#number>`, which opens that card or row and clears a filter that
hides it, for that visit only. `back=<place>` shows a route back; it accepts only
a place. Every move between places is a history entry, so Back and Forward work.

The service's and notices' links keep working (`src/ui/address.ts`):

| Link | Opens |
| --- | --- |
| `/?settings=accounts`, `/?settings=link`, `/?settings=admin` | Settings → Accounts, Accounts' pairing, or Admin where allowed |
| `/?view=logging&chain=…&after=…` | Observe → Tasks, that task's timeline from that step |
| `/?view=logging&event=…` or `incident=…`, with `from` and `to` | Observe → Logging, that diagnostic and interval |
| Google's and Extensions' sign-in returns | Where the connection was started, finished first |
| Notice targets | Settings → Behaviors; a run in Observe → Behaviors; Settings → General or Accounts; a chat; a pull request's card on Board |

## Vocabulary and the seven states

The frame, Overview, Board, Observe and Settings' own rows take every word, tooltip
and full reference from one registry, `src/ui/registry/`, so they cannot drift
apart; Chat, the Manager place, the Editor and Settings' sections built on
classic's views keep classic's words for now. Chats, runs, issues and pull
requests share seven states, each with one meaning and one colour:

| State | Meaning |
| --- | --- |
| Running | Work is executing right now. |
| Needs you | Paused for your decision; nothing more happens until you act. |
| Waiting | Paused on something other than you; it clears by itself and says what it waits for. |
| Blocked | Cannot continue until a prerequisite is met, or an effect Poise cannot prove yet is reconciled. |
| Idle | Nothing in progress. |
| Done | Merged, closed or answered. |
| Failed | The last attempt ended in an error; the history is kept. |

## The reference

Any element marked with `data-ref` explains itself. Resting the pointer on it,
focusing it from the keyboard or a long press on touch shows a tooltip after
`--dur-tip`; `?` opens the full reference, which dims the page, keeps the element
lit and answers what it is, what it does, what its current value means, its other
values, what it affects, when a change applies, what stays unchanged, how the
result shows, where the information comes from and why it is unavailable. Opening
or closing it never activates the element, and `Esc` returns to it.

## Tokens and Style

`src/ui/tokens.css` is the only file of the interface that holds raw values:
primitives (`--p-*`), the person's controls (`--ctl-*`) and the semantic tokens
everything else uses. `tests/ui-tokens.test.ts` enforces it, for stylesheets and
for `style=` strings built in TypeScript. The spring and durations come from
`gateway/src/motion-model.ts`, as [Natural-Flow.md](Natural-Flow.md) describes.

The Style panel (Settings menu → *Style panel*) and Settings → Style change the
controls: preset, typeface, base size, density, corners, route lines, motion,
status tints and the meaning colours. Choices are kept in this browser
(`poise-style`).

## Stability and feedback

Live data never moves what you are using: new rows and notices wait, counted,
while your pointer or focus is in a list, and arrive when you leave it. Actions
show what the service confirms, where they were taken; a failure shows where it
happened, with the server's reason, and a failed read shows when it was last read
instead of a guessed state.

Updating, a sign-in that ended, Claude's subscription and a new build show on
every place, on the same watchers the previous interface used
(`src/updating.ts`, `src/signed-out.ts`, `src/claude-auth.ts`,
`src/self-update-watch.ts`). The last two sit at the foot of the page, which
makes room for them.

## Kept in this browser

`poise-style`, `poise-overview-level`, `poise-overview-tiles`,
`poise-observe-tab`, `poise-observe-github`, `poise-logging-filters`,
`poise-board`, and Board's time and status filters in `poise-current-filters`.

## Tests

`tests/e2e/ui-*.spec.ts` drive each place in a browser; `tests/ui-*.test.ts` cover
the registry, the addresses, the tokens and each place's pure mappings. The
previous interface's specs run against `/classic.html` through
`tests/e2e/fixtures/classic.ts` until it is removed.
