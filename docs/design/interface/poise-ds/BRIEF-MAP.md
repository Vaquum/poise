# How the interaction brief lands in Chat (Platform)

Two mocks, one system: `chat.html` (a chat you run yourself) and `manager.html`
(the Manager place: its chat, the work table and the Switchboard, as PRD #563 sets
it). Both use `tokens.css`, pass the linter and answer to the Style panel. The
other places have notes of their own: `OVERVIEW.md`, `CURRENT.md`, `EDITOR.md`,
`OBSERVE.md`, `SETTINGS.md` and `SETUP.md`.

| Brief section | In the Chat mocks |
|---|---|
| 1 · One vocabulary | `refdefs.js` is the single source: chat, worker, Manager, turn, active turn, queued instruction, steer, slot, issue, PR, and seven states (Running, Needs you, Waiting, Blocked, Idle, Done, Failed). State words on screen are rendered from it, so labels, tooltips and references cannot disagree. Every action's reference answers what it affects, what it changes, when, what stays unchanged and how the result shows. |
| 2 · Universal reference | Every control and display carries `data-ref`. Tooltip after 0.5 s (pointer, keyboard focus, or a touch long-press) names it, explains it and links to the full reference; the tooltip stays while you move onto the link. Full reference dims the screen, keeps the element lit and connected to a central card answering up to ten questions (what it is, what it does, the current value, other values, scope, when a change applies, what stays unchanged, how the result shows, the source, why it is unavailable), never covers the element (it moves to the side where it fits, nearest the centre), never activates it, and restores focus and scroll on close. `?` opens it for the focused element. Tooltips appear for keyboard focus, not for focus a script moves. |
| 3 · Strategic overview | Overview is the first item of the navigation: the command center, where you answer what needs you and see how the work and the day are going. Cockpit, `overview.html`, was chosen on 23 Oct; Briefing, `overview-b.html`, is kept for reference. See `OVERVIEW.md`. In the Manager place, the Switchboard is the in-chat slice of it: what needs you, one decision at a time. |
| 4 · Organised by purpose | Navigation: Overview · Board · Chat · Editor · Observe · Settings, in a fixed order, with no group labels. Each view still serves one purpose (Work, Observe or Settings), which the review records. The Manager place is three panes, left to right: the Manager chat, the work table and the Switchboard (PRD #563); with no Manager yet it still opens, with the Switchboard. Style and Manager live in Settings; the Manager controls also open from its header, on the same state. |
| 5 · Defaults and ordering | The chat list opens in Attention order (Needs you, Blocked, Failed, Running, Waiting, then Idle and Done by recent activity), with Recent activity, Project and Manual as alternatives, the current order shown, and the choice remembered. Live changes never move a row while you are using the list: they are held, counted, and applied when you leave. Conversations keep their chronology. |
| 6 · Manager controls | Rhythm 1–10 slots with configured limit and current use; what holds a slot is defined as `main` counts it: each worker chat, from the moment it takes a task until you close it, between turns and after its task ends (#675, #782); the Manager's own chat never does, and it fills a free slot on its next turn. Lowering below use lets each worker finish its task and starts nothing new. Stability ↔ Expansion in five positions on how the Manager takes a Poise release, and Autonomy in five positions on what it decides and what it brings to you, each in the words every Manager turn carries on `main`. One sentence states the combined effect and its scope. Wake every 60, 30, 15, 10 or 5 minutes sits in the header, with the day's cost (#783). |
| 7 · Element review | `review.html`: 118 elements across these two views, of 494 in all — what each was, what it is now, its purpose (read from the registry), whether it serves Work, Observe or Settings, and the decision: 70 keep, 6 move, 4 merge, 1 remove, 37 new. All 50 live Chat features are accounted for, the Switchboard's as kept now that it is the place's third pane. Every key resolves, and each row opens the element in place with its reference. |
| 8 · Feedback and continuity | Every instruction shows accepted → queued → executing → completed. A situation line separates observed (solid) from intended (dashed), with freshness. Estimates exist for behavior runs only, so a chat's and the Manager's situation show none. Opening a worker from the Manager keeps a route back; reference and previews restore focus and position. |

## Files

| File | What it holds |
|---|---|
| `refdefs.js`, `refdefs-manager.js`, `refdefs-current.js`, `refdefs-editor.js`, `refdefs-settings.js`, `refdefs-overview.js`, `refdefs-observe.js`, `refdefs-setup.js` | The one vocabulary: 598 entries, the seven states, the Manager policies and charters. |
| `reference.js` | Tooltip and full reference, for any element with `data-ref`. |
| `chat.html`, `chat.css`, `chat.js` | A chat you run (#475), and the list, situation, queue, composer, timers and new-chat types both views share. |
| `jev.js`, `jev.css` | JEV · primitives, in Chat's place: State, Questions, typed results, history, templates and recovery. |
| `narrow.css` | Every place on a narrow window, at `main`'s breakpoints. |
| `workspace-data.js`, `tasks-data.js` | The workspace's chats, Board's issues and pull requests, and the chain's tasks: one list each, read by Chat, the Manager, Board, Observe and Overview, so they agree. |
| `manager.html`, `manager.css`, `manager.js` | The Manager place: its chat, the work table of every task in motion, the Switchboard, and the controls over the table. |
| `overview.html`, `overview-b.html`, `overview-a.*`, `overview-b.*`, `overview-data.js`, `overview-ui.js`, `ov-shared.css`, `refdefs-overview.js` | Overview in two directions on shared data and parts; see `OVERVIEW.md` for the 20 behaviours that move in and how each lands. |
| `board.html`, `current.css`, `current.js`, `refdefs-current.js` | Board, called Current until round 11; see `CURRENT.md` for today's 25 behaviours and how each lands. |
| `editor.html`, `editor.css`, `editor.js`, `refdefs-editor.js` | Editor against the brief; see `EDITOR.md` for today's 23 behaviours and how each lands. |
| `shell.js` | What every view shares: menus, feedback, the instruction lifecycle and the mock clock. |
| `settings.html`, `settings.css`, `settings.js`, `settings-sections.js`, `settings-extensions.js`, `refdefs-settings.js` | Settings in ten sections, Extensions among them; see `SETTINGS.md`. |
| `observe.html`, `observe.css`, `observe.js`, `observe-data.js`, `observe-tasks.js`, `refdefs-observe.js` | Observe: Tasks, then Behaviors, GitHub and Logging (were Swarm, Archive and Logging) in one place; see `OBSERVE.md`. `swarm.html` forwards there; round 4's Swarm is `swarm-r4.html`. |
| `setup.html`, `setup.css`, `setup.js`, `refdefs-setup.js`, `gateway.html`, `gateway.css`, `gateway.js` | First-run setup, the gateway's own pages, and the two states any page can be in; see `SETUP.md`. |
| `bell.js` | The bell on every view: it counts what Overview's level shows and opens Answer here, with a route back. Whether it should open a panel instead is still open. |
| `review.html`, `review.css`, `review.js` | The element review, for every view: Overview, Board, Chat, Editor, the Manager, Observe, Settings, setup and the page states. |

## Not done here

- Nothing. Every live view, panel and setting has its place, recorded in `review.html`. The only things this mock leaves out are what cannot be shown without a real workspace; each is marked "not in this mock" in the review.

## For captures

The mock world is one moment, Friday 23 October 2026 at 19:41, on every place: its clock, its dates and its numbers agree, though it now shows what `main` added up to 1 November.

`?still` turns motion off; `?chat=closed`, `failed` or `interrupted` and `?manager=retired` show a composer that cannot take a turn; `?sb=new`, `?explain=fail`, `?board=partial`, `?notifications=off`, `?quota=unset` or `failed`, `?save=conflict`, `?sites=none`, `?fallback=1`, `?ext=none`, `?google=new`, `none`, `off` or `gone`, `?event=expired` and `?jev=1`, `running`, `stopped`, `failed`, `interrupted`, `pending`, `conflict`, `unsaved` or `unset` show other states; `?ref=<key>` opens a reference, `?tip=<key>` a tooltip, `?peek=w4` opens a worker's row in the work table, `?answer=allow` answers #475, `?order=recent` picks an order, `?pane=memories`, `timers` or `controls` opens a pane. The Manager place also takes `?manager=none`, `?sb=stopped`, `off` or `waiting`, `?wake=failed`, `nocharter` or `due`, and `?table=stale`. `?back=<place>` adds a route back on every place. Headless Chrome needs `--run-all-compositor-stages-before-draw` to paint the reference dim.
