> **Copy of autonomio/poise#556 as it stands on 11 November 2026.** The issue is the authority. [CHANGES-2026-11-11.md](CHANGES-2026-11-11.md), [CHANGES-2026-11-04.md](CHANGES-2026-11-04.md), [CHANGES-2026-11-03.md](CHANGES-2026-11-03.md) and [CHANGES-2026-10-28.md](CHANGES-2026-10-28.md) say what changed in the mocks.

### Objective

Replace Poise's interface with the redesign the owner reviewed in clickable mocks, as a frontend change that leaves the running service untouched. In the owner's words on 23 October 2026: "without causing disruption to the actual service, so it's just a bounded frontend flip".

The interface on `main` grew one view at a time, and it shows:

- **Three vocabularies for one thing.** Current colours a pull request yellow for a failing check, a running check or an open conversation alike, and green for ready to merge, the colour Done uses elsewhere. Swarm says Completed or Superseded. Archive says Merged or Closed, and CI says Success or Failure.
- **Ten views, and where each sits is a preference.**
- **Notifications in a rail of their own.** Answering a permission or a question means opening its chat.
- **One piece of work, in three unconnected views.** A pull request is a card in Current, a row in Archive and a run in Swarm, and nothing links them. No list says what phase each issue is in, whether Poise has it, or whether anything is happening on it.
- **Settings as an overlay panel** that saves together, with Typography a second overlay.
- **A hard cut on every navigation.**

The owner's "Poise Interface and Interaction Brief" sets the standard: one vocabulary; a universal reference; a strategic overview; views by purpose; deliberate defaults and stability during live updates; Manager controls; a review of every element; clear feedback and continuity.

This text reads `main` at `bb30bb3` (11 November 2026). Each PR reads what `main` has changed in its places since then and carries it over.

### Summary

The new interface is a second page, `ui.html` with `src/ui/`, built beside today's on the same endpoints, WebSocket commands, notices feed and motion runtime. Classic is not refactored: the new page imports what fits as it stands and copies what does not. Until the flip it is reachable only at `/ui.html`, so the owner can try it on production while everyone else stays on classic. Four PRs build it; a fifth, the only `feat`, gives it `/` and leaves classic at `/classic.html`, and reverting that PR rolls everyone back. Nothing in `server/`, `gateway/`, `caller/`, `link/` or `deploy/` changes. Classic is removed later, on the owner's word.

### Is This Really Necessary?

Yes. The owner asked for it. The brief is the acceptance standard, and today's interface fails its vocabulary, its defaults and stability, and its continuity. The design is done and reviewed: 125 pages and states, 669 registry entries, and an element review of 494 rows accounting for all 318 live behaviours of `main`.

The work is the new page, its places and the flip, and nothing else. Every step asks whether this is the cleanest, simplest and least intrusive way to get it done, and is done that way only.

- **Reuse.** Every read, action and event the new interface needs already exists on `main`.
- **Leave classic alone.** Moving its logic first would edit what works, to serve what does not exist yet. A second page needs none of that.
- **One way back.** The flip is one PR to revert, and classic keeps its own address until it is removed.

A throwaway prototype on `741d2c4` proved this against the real production server. Before the flip, `/ui.html` is served under its CSP and renders, and classic at `/` keeps its stylesheet byte for byte. With the flip simulated, `/` and deep addresses open the new page, `/classic.html` opens classic, and 914 of classic's 915 browser tests pass, two of them on a re-run after timing out on a heavily loaded machine. The other one moves with the flip (Design). The 15 unit test files that read these paths pass.

### Named Concepts

| Term | Meaning |
| --- | --- |
| **New interface** | `src/ui/`, loaded by `ui.html` until the flip and by `index.html` after it. |
| **Classic interface** | Today's interface: `src/main.ts`, `src/style.css`, `src/views/**` and the view markup in `index.html`, which becomes `classic.html` at the flip. It stays until removal. |
| **The flip** | The one PR that gives the new interface `/`. |
| **Reuse rule** | Import a module if it fits as it stands. Otherwise copy it into `src/ui/`, naming its source at the top, and change the copy. Nothing moves. |
| **Design mocks** | The owner-reviewed static mocks, committed under `docs/design/interface/` in PR 1 as the pinned specification. They stay out of the build, `tsc` and ESLint. |
| **Element review** | The mocks' `review.html`, with `review.json`: each live behaviour with an ID (such as C5, W12, L14), what it was, what it is now, the purpose it serves (Work, Observe or Settings), and the decision with its reason. |
| **Registry** | One typed vocabulary of every element: name, kind, what it is, what it does, its values, scope, when a change applies, what stays unchanged, how the result shows, its source, and why it is unavailable. Tooltips, full references, help text and on-screen state words all read from it. |
| **Reference** | A tooltip after 0.5 s on pointer rest, keyboard focus or a touch long press, and a **full reference** that dims the page, keeps the element lit, never covers or activates it, and restores focus. |
| **Seven states** | Running, Needs you, Waiting, Blocked, Idle, Done and Failed, each with one colour, for chats, workers, runs, issues, pull requests and CI alike. Design maps every source onto them. |
| **Tokens** | Three layers of CSS custom properties: controls (`--ctl-*`), primitives (`--p-*`) and semantic tokens. Only `src/ui/tokens.css` holds raw values, and a test enforces it. |
| **Style panel** | A person's control over the tokens: type, size, density, corners, line weight, motion (on, reduced or off) and state colours. It saves in the browser. |
| **Overview** | The first place in the top bar, a cockpit. *Answer here* lists what wants you, with the answers on each entry. *In motion* shows the work in the seven states. Beside them are the day's numbers, the Manager, the behaviors and the API quota. |
| **Answer here** | Overview's list of what wants you, grouped by who acts: Needs you, Faults, Done and Automatic. A pull request ready to merge is in Needs you. |
| **Level** | How much of Answer here to show: Only you, + Faults, + Done (the default), or Everything. The bell on every view counts what the Level shows, in its colour, and opens Answer here with a route back. |
| **Held send** | An action that waits eight seconds in the tab before it is sent, which is its Undo. Leaving the page sends it at once. |
| **Observe** | One place for what happened and why, in four parts. **Tasks** is new: every task the behavior chain carries, from its issue to its merge, with the chain's state and evidence, which `main` shows at the foot of Logging. **Behaviors** was Swarm. **GitHub** was Archive. **Logging** is unchanged. |
| **Task** | One issue on its way to a merged pull request, driven by the behaviors as a chain or by a Manager's worker. It has a phase rail, Intake to Merge, and its journal is its timeline. Board, the work table, Observe → Tasks and Overview show the same task in the same words. |
| **Manager place** | Three panes, as PRD #563 sets them: the Manager chat, the **work table** with one row per task, and the **Switchboard**. The Manager's controls open from its header over the table. With no Manager yet, the place still opens. |
| **Board** | Current, renamed. |
| **List** | Board's second view: the same live issues and pull requests as its lanes, one to a row, each with its phase, state and reason, how long it has been like that, and who has it. |
| **Assign to Poise** | An action on an open issue nobody has. It adds the chain's label on GitHub, as you, and the chain takes the issue at its next check. `main` has it since #853. |
| **Held arrivals** | New rows or notices that wait, counted, while your pointer or focus is in a list, so nothing moves under you. |
| **Instruction lifecycle** | An instruction's progress, shown where it was given, in the words the service confirms. |
| **Route back** | A link back to the place that opened this one, carried in the address as `back=<place>`. It never uses `from` or `to`, which hold Logging's interval. |

### Outline

Five PRs, one theme each, each closing exactly one issue (law 1).

| PR | Type | Theme | What it delivers |
| --- | --- | --- | --- |
| 1 | `chore` | The frame | The mocks and the element review under `docs/design/interface/`, real host, site and organization names cleared, in a commit of their own. The page, `ui.html` and `src/ui/main.ts`, and its second build input. Tokens, components and the token test. Top bar, addresses, bell and toasts. Registry and reference. Style panel. The overlays and foot strips. The narrow-window rules. |
| 2 | `chore` | What's happening | Overview and Observe. |
| 3 | `chore` | The work | Board with its List and Assign to Poise, Chat with JEV, the Manager place and the Editor, one commit per place. |
| 4 | `chore` | Settings | Settings' ten sections and first-run setup. |
| 5 | `feat` | The flip | `/` opens the new interface and `/classic.html` opens classic. The docs. It opens the issue for removing classic. **Closes this PRD.** |

PRs 1 to 4 each close a one-line issue that points here, and change nothing anyone sees at `/`. Each is checked against its rows of the element review, and a row it cannot meet is reported in that PR, never dropped silently.

Later, a `refactor` PR closes the removal issue: once the owner has worked a week in the new interface without going back and says so, it removes `classic.html`, whatever only classic imports, and classic's specs.

What each place becomes:

| Today | After |
| --- | --- |
| Top bar with ten views; Settings → Navigation arranges them | Overview · Board · Chat · Editor · Observe · Settings, in a fixed order with no group labels. The Navigation section is removed. |
| Analytics | Overview's tiles: the day's eight numbers with their pace and year, and under each year the 30 days before in five bins (#995); five per merged pull request, work type and review. The tiles' order is remembered. #1101's System health strip sits under In motion once it lands. |
| Notifications rail | Overview → *Answer here*. The bell on every view opens it. |
| Current | Board, in the seven states, holding still while you are in a lane. A held pull request names its blocker and marks it after 15 minutes. *+ Add* sits at the top of each lane; an issue gets the repository's labels and can be edited. A chained issue and its pull request are one task card. A card's chat stays in the side pane, with Open in Chat. View switches to a List, which stays as you left it, and an open issue can be assigned to Poise. |
| Swarm, Archive, Logging | Observe → Behaviors, GitHub and Logging. Logging's links are unchanged, and it keeps its Work impact column. A run or a GitHub row links to its work on Board. |
| Behavior chain evidence at the foot of Logging, and its Needs you cards | Observe → Tasks: the chain's state line, Needs attention, each task's evidence and timeline, Hold and Resume. The cards stay in Answer here. |
| Behaviors | Switches, pauses, the engine and the chain in Settings → Behaviors; runs, minutes and success in Overview, each linking to its run in Observe. |
| Snippets, Extensions | Settings → Snippets and Settings → Extensions, unchanged in what they hold. |
| Models | Settings → Models: the three models, then each of the seven places' slot or Random. |
| Settings overlay | A place with an address per section and Find. Each setting saves itself on its row, sending only its own field, and says when it applies. |
| Light or dark | Dark. Classic keeps Light and Dark until it is removed. |
| Typography panel | Settings → Style, and the Style panel. |
| Chat | The redesigned Chat: a situation line, the instruction lifecycle and held list updates. The open chat's timers are in its side pane. New chat offers Chat, Worker or Manager. Every function stays. |
| Switchboard pane in Chat | The Manager place's third pane, with all of its controls, its states and its consent text, whether or not a Manager exists. |
| Workspace Manager | The Manager place: its chat, the work table, the Switchboard, its wake-up interval in its header, and its standing instructions one click away. |
| Editor | The redesigned Editor: a status line, and one side pane for Comments, Reviews, Publish and the document chat. Passage and review threads stay inline. Import sits beside New. |
| First-run setup | The same steps, redesigned, without the theme step. |
| Updating, sign-in ended, Claude's subscription, a new build | The same, redesigned, on the same watchers. |
| Moving between views | The same motion runtime. Entrances run once per mounted place, and the top bar never re-renders. |

### Out of Scope

- **The service.** Any change to `server/`, `gateway/`, `caller/`, `link/` or `deploy/`, to API routes, WebSocket commands, schemas or stored records.
- **Refactoring classic.** No bootstrap, no shared logic modules, no moved code. #787, #789 and the closed PR #792 belong to the plan this one replaces.
- **Capabilities that need the server**, each for a PRD of its own:
  - enforcing the Manager's Rhythm, Stability ↔ Expansion and Autonomy controls and its repository scope. `main` stores them and carries them to every Manager turn as its policy, and the new interface shows and saves them as they are. Rhythm is not *Running at once*, the cap chats and behavior runs share. The mocks' list of one-line standing instructions is deferred too; the `/manager` snippet stays where they are kept;
  - the Manager's plan, deferred issues and escalation reasons;
  - estimates for chat turns and the Manager's work: only behavior runs have them.
- **The work table's live data.** Its rows, `WorkObservation`, exist only in the offline rehearsal. Until the server serves them, the table builds its rows from chats, tasks and pull request status, and marks what it cannot observe as ?.
- **Server-written text.** Notices and errors that name old places keep their words until a change of their own. The new interface maps their targets (Design).
- **The gateway's own pages.** They are restyled in the mocks, but the gateway renders them.
- **Poise Link's desktop interface, and a light theme for the new interface.**

### User Experience

The mocks are the experience: every place, panel, setting and state. These are the rules a mock cannot show by itself.

1. **The flip.** On one release `/` opens the new interface, on Overview. There is nothing to choose and nothing to migrate: settings, chats and drafts are where they were.
2. **Overview.** It opens on what wants you.
   - *Answer here* runs the full height on the left, grouped by who acts. A chat's waiting notice and its requests are one entry per request. Each entry carries its answers:
     - for a permission, the request's own options, in its order;
     - for a question, Chat's question form: several questions, several choices or free text. The draft is the one Chat shows, so typing continues in either place;
     - for a decision the Switchboard reports, the chat's choices with its recommendation first, and *Something else…*;
     - for a pull request, Approve and Merge, as you;
     - otherwise Connect, Retry, Ask an agent to review, Dismiss or Silence reminders, where the notice offers them.
   - An answer shows what the service confirms: Sent, then what happened. If delivery is uncertain, it says so and offers Open. It never repeats a command by itself.
   - Answers to an agent are final, because the agent is waiting on them. Dismiss and Silence are held sends, with Undo for eight seconds.
   - When a request is answered elsewhere, cancelled or reset, or the connection drops, its answers turn unavailable at once, with the reason, even while arrivals are held.
   - A notice with no answer of its own opens where it is handled, with a route back.
   - Arrivals wait while you are in the list. *Handled today* lists what you and Poise settled today.
   - Chain work that is held, not confirmed or owes review evidence, and any other after a day without a verified advance, is a Needs you entry: how long since it advanced, what holds it and what is next. *Open its timeline* goes to the task at that step. An entry about managed work says its work impact.
   - When #1101 lands, its five System health cards sit under In motion, live over the last 24 hours, each opening its evidence. Behaviors' counts stay visible when some run records cannot be read, marked partial, once #1133 lands.
   - With Notifications off, the server's notices stop and the list says so. A chat's own requests, a document's threads and Behaviors' diagnostics stay.
3. **Board.**
   - Ready to merge is Needs you in amber, because green means Done.
   - A held pull request says why, in the registry's words for each of the fourteen blockers (`card.blocker`), and is marked once the same blocker has stood for 15 minutes.
   - *+ Add* opens at the top of each lane, and the new card or issue lands there, in view. Edit keeps your draft if someone changed the issue meanwhile.
   - The filters say what they apply to, and the live lanes hold still while you are in them.
   - **View** switches between Lanes and List. It opens on Lanes, then on whichever you left, in that browser. List shows the same live work and actions, issues then pull requests, one to a row. Your Idea, Concept and Plan cards stay in Lanes, and a link to one opens there.
   - Each row shows its title, repository and number, when it was opened and changed, its phase, its state and reason, how long it has been like that, and who has it: `Poise`, a worker, a chat, a run, or nobody.
   - *Running* says for how long, because something is working on it now. Any other state says how long it has waited, and after 15 minutes reads *the same for 36m*. Idle reads *no change for 2h*.
   - **Updated | Opened**, beside the time filter, says which time it means. On Updated, Today includes an old issue touched today. On Opened, it lists only what was opened today. **Who** shows Anyone, Poise or Not Poise, and a worker or a chat counts as Not Poise. The filter text also finds a number.
   - **Assign to Poise** sits on an open issue nobody has, as `main` has it since #853. It asks Sure?, because it starts real work, then shows the Poise chip at once. A refusal stays on the row with GitHub's reason, and can be tried again. While the chain is off it still adds the label, and the chain takes the issue once it is on. While every open issue already enters, it is not offered. Every open issue shows the open pull request that closes it, or *no open PR*: the chain does not take an issue that has one. A failed intake read shows no label, Assign or pull request, never "not assigned". A pull request cannot be assigned, because `main` cannot add one to a chain.
   - Choosing a live card or row opens it in the side pane, with its runs and links to its task, its runs in Behaviors, its row in GitHub, and GitHub itself. The title still opens GitHub.
4. **Chat and the Manager.**
   - Chat keeps every function it has. While a new chat is being created, typing stays live and carries over, and a further Send waits for the chat to exist. A chat that cannot take a turn says why in its composer: closed; failed or interrupted, with Resume or `/reset`; the Switchboard's own chat, which takes no messages; the Manager's retired model, with its choice.
   - JEV · Primitive builder opens in Chat's place, with its row in the chat list: State and Questions, then typed results above the builder. Its words and limits are `main`'s (`docs/Jev-primitives.md`), and nothing is sent twice by itself.
   - New chat offers Chat, Worker or Manager, none preselected. With a Manager present, it offers Open the Manager instead.
   - The work table has one row per task and four flags: conflicts, an open review, behind main, CI failing. Hold and Pause new work stay two things, as on `main`: Hold is the Manager chat's own `chat.hold`, so its timers skip and the turns it would start in other chats wait; Pause new work is the controls' paused flag, so new work waits until you resume. Opening the place never creates a chat or starts work.
   - The Switchboard keeps Start, Check now, Pause and Resume checks, Open its chat, Hide, Restart, Dismiss, Explain, and Turn off pressed twice. Explain asks once and keeps the answer. Stopped, it says why in the Failed colour, with Restart. Before Start it names the model it runs and says, word for word, that in contributor mode Muse may use the transcripts it reads for product improvement.
   - An answer to a decision the Switchboard reports names the chat it goes to and shows the relay: queued, held or delivered. The Switchboard only relays and never acts. The Manager is the one chat that acts on others.
5. **Editor.** A status line under the page says whether the document is saved, how long it is, what needs you, and where it is published. Import opens a Markdown or text file up to 5 MiB as a new document, and says why when it refuses one.
6. **Observe.**
   - **Tasks** holds the chain's evidence. A line says who owns new work, the chain's model runs of its ceiling and when it was read, with the pull requests v1 kept at cutover. Needs attention lists held, unconfirmed and review-pending tasks at once, and any other after a day without a verified advance, oldest first. Each task shows its rail, state and reason, its last verified advance, the gates on its head and what is next; a superseded one, the merge that covered it. Its timeline offers Hold and Resume, opens at a step when a notice or a diagnostic names one, and a merged task offers its history. A failed read keeps what was read and stops Hold and Resume until a read succeeds.
   - **Behaviors** lists every run with its state and outcome, 200 a page, Stop with Sure?, Replay, and the detail.
   - **GitHub** has its kinds, filters and consensus review.
   - **Logging** has column filters, evidence, related incidents, Data and collection, and each row's Work impact, whose detail opens the task at that step.
   - Links from Overview, Settings and Logging open the exact run or diagnostic, and the route back returns with your filters as they were.
   - Each run and each GitHub row says *See it on Board*. A link clears a filter that hides what it names, for that visit only, and what you left stays remembered.
7. **Settings.** Sections: General, Accounts, Models, Extensions, Publishing, Behaviors, Snippets, Admin, Style and Manager, each with its own address. Each row says what it does, whether it is the default, and what happened to the last change. Rows tied by a rule say which row to change first, and a change that touches both saves both together. `/` focuses Find.
8. **Everywhere.**
   - Every control explains itself after half a second. `?` opens the full reference for the focused or hovered element, outside text fields; the tooltip's own link opens it too, on any device. A long press shows the tooltip and never activates the control. Unavailable controls stay focusable, so their reason can be read.
   - Two notices sit at the foot of every view, in `main`'s words, and the page makes room, so nothing is covered: Claude's subscription while Claude-backed work is paused, and a new build, whose Refresh keeps drafts and waits for what a reload would lose.
   - On a narrow window nothing overflows the page. The top bar's places scroll. Chat's list floats, and a chosen row folds it away. The Manager's chat and the work table take turns, with the Switchboard floating from its tab. A side pane takes the place. Tables scroll inside themselves. The breakpoints are `main`'s: 1000 where panes float, 820 where headers wrap, 760 where columns stack.
   - Moving between places keeps the top bar still. A place enters with the spring when it is first mounted, and at once afterwards. Chat and Editor fade. Reduced motion, or Motion off in the Style panel, makes everything instant.

### New Data

None on the server. The new interface reads and writes only what `main` already serves (Design → Data). That includes `main`'s existing close of a chat (`chatClient.closeSession`), which classic's UI never calls and the work table offers on a worker whose task has ended.

Kept in the browser, each starting from its default:

| Key | Purpose |
| --- | --- |
| `poise-style` | The Style panel's token overrides. |
| `poise-overview-level`, `poise-overview-tiles` | The Level, and the tiles' order. |
| `poise-observe-tab`, `poise-observe-github`, `poise-logging-filters` | Observe's part and filters. Logging keeps its existing key. |
| `poise-board` | Board's view, what its time filter means, and Who. Its time and status keep classic's key, `poise-current-filters`. |

The draft keys are shared with classic: composer, question-form and update drafts. No secret is ever kept in the browser, including to offer Undo.

### Support

- **Failures the person sees.** Every failure shows where it happened, and none is silent. A read that fails shows on its element and as a local notice, and data that could not be read shows when it was last read, never a guessed state. An action that fails shows the server's reason where it was taken, and stays available if it is safe to repeat. A setting that cannot be saved keeps its row in the editing state, with the reason.
- **Diagnostics.** None new. Logging is unchanged.
- **Updates and sign-in.** The watchers start first on the page (Design). Each place registers its reload guards and draft providers: Settings rows saving, Overview answers in flight, Editor save queues and uploads, Chat composers and question forms.
- **Rollback.** One person: open `/classic.html`. Everyone: revert the flip PR. Nothing stored needs undoing in either direction.
- **Tests.**
  - Classic's specs keep running on classic until it is removed (Design → The flip).
  - New end-to-end specs, `tests/e2e/ui-*.spec.ts` on the existing fixtures, cover each place, in local and service mode where a place differs between them: Admin, Poise Link pairing and sign-in ended. They include:
    - every entry address under Design;
    - a round trip from Overview to an exact diagnostic and back, with its interval and filters intact;
    - a promotion with pending saves, uploads and answers;
    - Answer here: a request answered elsewhere while its entry is held or focused; several requests at once; a free-text-only question; an answer that fails while newer typing is kept; and the quality-control scenarios for inline questions and refresh recovery;
    - Chat: the scenarios of `chat.spec.ts`, `chat-queue.spec.ts`, `chat-manager.spec.ts`, `chat-switchboard.spec.ts` and `chat-timers.spec.ts`;
    - per-row saving: responses out of order, a refused conflict, and unrelated rows kept;
    - Board's List: the view stays as left across a reload, a link's view is not remembered, Today on Opened and on Updated, Who, Assign's Sure?, refusal and chain-off states, an issue's closing pull request and a failed intake read;
    - Observe → Tasks: Needs attention's order, a timeline opened at a step, and a failed read; Logging's Work impact;
    - the reference: a long press released or cancelled, keyboard focus on an unavailable control, text and IME fields, and reduced motion;
    - no page-level overflow in any place at 375, 768 and 1000 pixels, with Chat's composer never covered, and no layout shift between places or when an entry arrives while the pointer is in Answer here.
  - Unit tests cover the registry, the seven-state mapping, the notice target mapping and per-row saving. They are pure: no processes, servers or real waiting.
  - New browser specs cover what only a browser can prove, not every state of the mocks.
- **Docs**, in the flip, because that is when behaviour changes: `docs/Interface.md` is new, for the places, the vocabulary, the tokens, the reference and `/classic.html`. `docs/Menu.md`, `Notifications.md`, `Analytics.md`, `Logging.md`, `Extensions.md`, `Switchboard.md`, `Chat-orchestration.md`, `Chat-v1.md`, `Publishing.md`, `Local-Design-System.md`, `Natural-Flow.md`, `Service-architecture.md`, `Behavior-chain.md` and `README.md` change where they name views or describe the old interface.

### Market Desirability

People choose a self-hosted agent workspace for how much it does without being watched, and for whether they can see and steer it when they look. A cockpit where everything that wants you can be answered in place, a single vocabulary for every kind of work, and an interface that explains itself and never moves under you make Poise legible at a glance and calm to work in. Agent tools rarely are.

### Risks

| Risk | Mitigation |
| --- | --- |
| The work touches classic or the service by accident | Both are checked mechanically on every PR (Success Metrics), and classic's specs keep running. |
| A copied module misses a fix that lands on `main` | Copy only what does not fit. Each copy names its source, and each PR reads what `main` changed in its places. Copies end with classic. |
| Chat regresses: streaming, drafts, permissions, the queue, hand-offs | The new Chat imports the same composer, transcript and draft modules where they fit, and its specs port classic's scenarios. |
| A promoted build goes unseen, or reloads over unsaved work | The watchers start first on the page, and each place registers its guards and draft providers. |
| A broken new interface reaches everyone | The owner tries it at `/ui.html` on production before the flip. After it, `/classic.html` and the revert. |
| Answering in place acts on the wrong item | Answers carry the notice's, request's or item's id, never a list position. Held arrivals hold geometry, not stale actions. |
| Server text and notice targets name old places | Targets are mapped. The words change only with the server. |
| Renamed places confuse returning users | The full reference says "Called Swarm until 23 October". |
| Assign to Poise starts real work by a stray click | It asks Sure?, as Stop does, and appears only on an open issue nobody has. |

### Drawbacks

- Until classic is removed, two interfaces live in `src/`, and a fix in a copied module has to be made in both copies.
- PRs 1 to 4 add code nobody uses until the flip, and the flip carries all of the visible change at once.
- Some mock capabilities wait for their own PRDs, among them enforcing the Manager's three controls.
- Whoever arranged Analytics' tiles or set Typography starts from the defaults in the new interface.
- Server-written text keeps the old names until it changes.
- The renames (Board, Behaviors, GitHub) and the removal of Navigation change muscle memory.

### Alternatives

- **This issue's first plan.** A bootstrap in `src/main.ts`, five refactor PRs moving logic out of classic, one large `feat` PR, a per-browser switch, a recovery address, an override, a failed-load fallback, two end-to-end projects, a server bundle check, a committed interface test, capability detection with Open fallbacks, and an exit check. Each of these either edits what works or guards against the edits. A second page gets the same isolation and the same way back without them. Rejected on 4 November.
- **A PRD per place.** Brings back the per-slice paperwork the owner retired. Rejected.
- **Restyle classic in place, view by view.** Every step is live for everyone at once, and Overview, Settings as a place and Observe cannot be half-done. Rejected for risk.
- **Rewrite in a UI framework.** It would replace the code that carries Poise's race and lifecycle fixes. Rejected.
- **80/20: Overview and Observe only.** It would leave two vocabularies. Rejected.
- **Widen Observe → Tasks into the list.** It would add a third list of the same work, which is the problem, and Board already holds the phase, state and owner. Rejected.
- **List and Assign in an issue of their own.** The owner decided on 4 November that everything stays in this one.
- **The chain's evidence at the foot of Logging, as `main` has it.** It would split one piece of work across two parts of Observe again. Rejected: it moves into Tasks, and Logging keeps its diagnostics with their work impact.

### Unresolved Questions

None. The owner decided each of these, and the mocks show them:

1. **22 Oct:** the seven states, one colour each.
2. **23 Oct:** Current is called Board. The top bar reads Overview, Board, Chat, Editor, Observe, Settings, and Settings → Navigation is removed. Publishing keeps Google Docs. Overview is the Cockpit direction. Observe's parts are Behaviors, GitHub and Logging. Moving between views follows `docs/Natural-Flow.md`.
3. **24 Oct, PRD #563:** the Manager place is three panes: the Manager chat, the work table and the Switchboard.
4. **24–29 Oct:** chats come in three types, Chat, Worker and Manager; models are three slots that each place picks (#670), and any place can run Random (#751).
5. **31 Oct:** one action switches behaviors to v2 (#736, #737); the Manager wakes every 60, 30, 15, 10 or 5 minutes (#783); the seven fixes of PRD #683 stand.
6. **3 Nov:** the task is the unit of work; a stalled worker is Blocked, with what it left; manual cards land at the top, under the composer. The new interface is dark only. The bell opens Overview → Answer here, with a route back. Observe's part keeps the name Behaviors.
7. **3 Nov, on `main`'s evidence:** a Manager slot is held by each worker chat until it is closed (#675, #782). Only the person closes a chat, so the work table offers Close on a worker whose task has ended, and the Manager fills a free slot on its next turn. The Manager's controls show the words `server/chat/manager-policy.ts` carries. Its scope defaults to every followed repository. The built-in snippets are `main`'s text, word for word.
8. **4 Nov, on `main`'s evidence:** a narrow window has its own layouts, at `main`'s breakpoints. With Notifications off, Answer here keeps a chat's own requests, a document's threads and Behaviors' diagnostics, and says that notices are off. Claude's subscription and a new build sit at the foot of the page, which makes room for them, because `main`'s floating banner would cover Chat's composer.
9. **4 Nov:** this plan: a second page, five PRs, nothing moved.
10. **4 Nov:** Board gains List and Assign to Poise, in this issue. Poise's mark means the chain carries the work. The view stays as you left it.
11. **11 Nov, on `main`'s evidence:** Assign to Poise is `main`'s (#853), so this issue changes nothing on the server again; Poise's mark also covers an issue that carries the label. The chain's evidence moves from the foot of Logging into Observe → Tasks. Analytics' distributions follow #995, and #1101's System health strip and #1133's partial Behaviors counts are drawn as they are specified.

### Success Metrics

- **The service is untouched.** On every PR, `git diff --name-only origin/main...HEAD -- server gateway caller link deploy` prints nothing.
- **Classic is untouched.** On PRs 1 to 4, `git diff --name-only --diff-filter=MDR origin/main...HEAD` lists no existing file except `vite.config.ts`, `src/chat-client.ts`, `docs/design/interface/review.json` and the two specs under Design. A PR that needs any other existing file changed is doing it the wrong way.
- **Coverage.** Every behaviour in the element review is reachable in the new interface, or out of scope with its reason.
- **Tokens.** The token test finds 0 raw values in `src/ui/**` outside `tokens.css`, in CSS and in `style=` strings built in TypeScript.
- **Tests.** CI passes on every PR.
- **Test time.** The new unit tests together add less than ten seconds to `npm test`. Removing classic takes its specs with it, and the browser suite ends shorter than it is today.
- **Qualitative.** For a week after the flip, the owner works in the new interface without going back.

### Design

**The page.** `ui.html` sits beside `index.html`, with an empty mount and `src/ui/main.ts`, and `vite.config.ts` takes both as inputs. It keeps `<title>Poise</title>`, which the deploy smoke tests look for. The production server already serves any built file under its CSP (`server/production.ts`), and the gateway passes every path through (`gateway/src/proxy.ts`), so neither changes. `src/ui/main.ts`, in order:

1. starts `watchForUpdates()`, `watchForSignOut()` and `installSelfUpdateWatch()`, in that order, because the last polls at once and the first two must already be watching;
2. finishes a return from Extensions' sign-in at `/extensions/oauth`, then Google's, before anything else reads the query;
3. mounts the place the address names, or Overview.

`src/ui/` styles everything on its page with its own tokens, the updating and sign-in overlays and the new-build notice included. Until the flip, a return that lands on `/` is finished by classic, as it is today.

With two inputs, the build moves what both pages use into one shared chunk. The release SHA and the staleness probe go there, and its hash still changes with each release. Classic's stylesheet stays byte for byte, and its entry chunk shrinks. The shared chunk's name is the bundler's to pick, so the two specs that name the entry chunk change in PR 1 and name no chunk: `tests/e2e/self-update.spec.ts:530` looks for the SHA in every chunk, and `tests/e2e/stale-chunk.spec.ts:17` matches the staleness probe's fetch.

**The flip.** `index.html` becomes `classic.html`, `ui.html` becomes `index.html`, and `vite.config.ts` follows. `/` and every address with no file of its own now open the new interface, and `/classic.html` opens classic. A sign-in started in classic returns to the new interface. Classic's specs keep asking for `/`: one import line in each gives them a fixture that routes `/` to `/classic.html`. New specs use the same route towards `/ui.html` until the flip, and lose it there. One classic case, the Extensions sign-in in `extensions.spec.ts`, follows a redirect the test tool cannot route. That return now belongs to the new interface, so the case moves to its spec.

**Where it lives.** `src/ui/`:

- `main.ts`, `tokens.css` and `components.css`, from the mocks;
- `registry/` (typed entries per place, from the mocks' reference definitions) and `reference.ts`;
- `shell.ts` (top bar, Settings menu, bell, toasts, routes back, held arrivals);
- one module per place: `overview`, `board`, `chat`, `manager`, `editor`, `observe`, `settings`, `setup`;
- `states.ts` (updating, sign-in ended, the foot strips).

Polling starts and stops with the place that needs it.

**Reuse.** The reuse rule covers every existing module, `src/views/**` included. An imported view module brings its class names, and `src/ui/` styles them. A statically imported module that brings its own stylesheet does not fit, because it would split classic's. One shared client gains one thing, with no change for classic: `chatClient` passes on the `chatRequests.updated` frame, the way it already passes on `switchboard.updated`.

**Addresses.** A place is `?view=<place>`: `overview`, `board`, `chat`, `manager`, `editor`, `observe` and `settings`. Observe adds `part=tasks|behaviors|github|logging`, and Settings adds `settings=<section>`. Board and Observe's GitHub part add `item=<repository>#<number>`, which opens that card or row and clears a filter that hides it, for that visit only. Each move between places is a history entry, so Back and Forward work. `back=` accepts only one of these place names, so it can never lead off Poise.

These keep working, each with an end-to-end test:

| Input | Where it comes from | Opens |
| --- | --- | --- |
| `/?settings=accounts` | `server/accounts/types.ts:16` | Settings → Accounts |
| `/?settings=link`, `/?settings=admin` | `gateway/src/link.ts:16`, `src/service-settings.ts` | Settings → Accounts' pairing, or Admin when allowed, gated as `service-settings.ts` gates it today |
| `/?view=logging&chain=…&after=…` | Notifications' *Journal evidence* (`src/main.ts`) | Observe → Tasks, that task's timeline from that step |
| `/?view=logging&event=…` or `incident=…`, with `from` and `to` | Logging's durable links (`parseLoggingLink` in `src/logging.ts`) | Observe → Logging, the exact diagnostic and interval |
| `google_state`, or `state` with `code` or `error` | Google's return | Where the connection was started, finished as today |
| `/extensions/oauth` | `server/extensions/oauth.ts:14` | Settings → Extensions, finished first |
| Notice targets: `{ view: 'behaviors' }`, `{ swarm }`, `{ settings: 'general' \| 'accounts' }`, `{ chat }`, `{ pullRequest }` | `src/notices.ts` | Settings → Behaviors; that run in Observe → Behaviors; Settings → General or Accounts; that chat, in Chat or the Manager place; its card on Board, with GitHub a click away |

Classic only ever read `view=logging` from the address, so its other view names are not addresses, and its saved `poise-view` is not carried over: `/` opens Overview.

**Data.** Each place uses what classic uses, through the same client modules where they fit: `src/chat-client.ts`, the notices feed, the existing endpoints, and `self-update-watch`, `self-update-guards` and `self-update-reload`. On top of those, it uses what `main` already delivers for this interface and classic does not use, among them:

- `GET /api/chat/requests`, kept current by the `chatRequests.updated` frame;
- `GET /api/notices/handled?since=<ISO>`;
- `GET /api/editor/reviews`;
- `GET /api/behavior-estimates`;
- `POST /api/pull-requests/approve` and `/merge`;
- `POST /api/gh` with `assign_issue` and `issue_intake` (#853);
- `GET /api/behavior-chains` with its attention projection, and its batch read of work impacts by call or correlation (#955, #1106);
- Settings saves with `expect`.

The interface and the server ship in one build, so it uses these directly. It does not read `GET /api/capabilities`, and no fallback path is written for a capability `main` already has.

**Answer here.** Its entries come from four sources, each keyed by its own id:

- **The notices feed.**
- **Open chat requests.** `GET /api/chat/requests` gives every open permission and question with its stored content and a revision. It is read again on `chatRequests.updated` and on reconnect, and a response older than a frame already seen is discarded. A chat's `chat_waiting` notice folds into its request entries.
- **The Switchboard's open decisions**, from its state, answered through its answer endpoint.
- **Review threads.** `GET /api/editor/reviews` gives every GitHub publication's `openThreads`, `checkedAt`, `stale`, `problems` and `retryAt`, which the server's sweep keeps current. The threads' text comes from each document's cached reviews, read only where threads are open. Overview never asks GitHub to synchronise. Each entry keeps those fields, and the list says when it last checked, so partial coverage never reads as "nothing needs you".

*Handled today* reads `GET /api/notices/handled` from the start of the day.

**Actions.** Each answer shows only what the service confirms:

| Action | Sent | Done when | Failed or uncertain | Repeat |
| --- | --- | --- | --- | --- |
| `permission.respond`, `question.answer` | the command is acknowledged | the transcript shows `permission.resolved` or `question.answered` | an error shows its reason. `command_in_doubt` shows "Not confirmed: check the chat", with Open | only after a read shows the request still pending |
| Switchboard answer | the endpoint accepts it | the relay is delivered; queued and held are shown as such | the response's reason | while the decision is open |
| Approve, Merge | the endpoint is called with the head it read and an `actionId` | the outcome names what happened: approved, merged, enqueued, already done | `refused` in GitHub's own words, `superseded` with both heads, unknown with GitHub's state | with the same `actionId`, which reconciles and never acts twice |
| Dismiss, Silence | after the eight-second hold | the next read omits the notice | the notice stays, and says it could not be put away | yes |
| Retry, Connect, Ask an agent | the endpoint accepts it | the run, sign-in or session it starts | the response's reason | as today |
| A Settings row | the save responds with the saved value | that response | the reason, on the row | yes |
| Assign to Poise | after Sure?, `assign_issue` is called | its answer, which comes only when GitHub's has the label; the chip stays until `issue_intake` reports it | the reason, on the row | yes: adding a label it has changes nothing |

**Undo.** Two kinds only: re-saving the previous value of a plain setting, offered until the row changes again here or another tab saves a different value; and a held send, for Dismiss, Silence, Disconnect, Revoke, Remove and Delete. Secrets, sign-ins, OAuth grants, Extensions credentials and anything already sent offer no Undo, and the registry says why. Lowering a cap does not stop turns already admitted, and the row says so.

**Settings saving.** A row sends only its own field, with `expect` holding the value it read: a top-level key, one `chat` field, one model slot or one place's pick. Edits to one row are sent in order, and only the newest response updates it. A save refused as a conflict (409) keeps the row's draft and says what changed.

**Board's List.** The same items and card module as the lanes, one to a row, with no new read:

- **Phase.** A chain's comes from its journal, with its round. Other work's comes from what `main` already says about it, with no rounds: an open issue nobody has is Intake, and one a worker, chat or run has is Implementation; a draft pull request is Implementation; a failing check, a conflict or a stalled worker is Repair; approved and green is Merge; anything else open is PR review.
- **How long.** A run's start, a chain's latest invocation, `blocker.since` from `GET /api/behavior-ledger/pr-status`, or the last update. `main` keeps `blocker.since` in memory, so it restarts with the server (`sinceRestart`).
- **Opened.** Every record carries `created_at`, and anything opened since a moment has also changed since it, so `updated_since` reads from the window's start and the page filters on `created_at`.
- **Poise's mark.** The issue carries the chain's label, from `issue_intake`, or a chain carries it, from `GET /api/behavior-chains`.

**Assign to Poise.** `main`'s own, since #853: `POST /api/gh` with `assign_issue` takes the label from the chain's settings, never from the page, acts as you, refuses a pull request, a closed issue and every-issue intake, and answers only when GitHub's answer has the label. `issue_intake` lists the labelled open issues and the open pull requests that close each, and names any organization it could not read, so unread is never "not assigned". The chain's existing intake does the rest.

**Vocabulary.** The registry is the single source of names, state words and help text. Every source maps onto the seven states as below. A state describes the item itself; a review run that requested changes is Done, and its pull request is not. Where the state alone would lose information, the outcome word stays beside it. Data that could not be read has no state word: it shows when it was last read.

| Source | Value | State · outcome |
| --- | --- | --- |
| Chat session | `starting` | Running · Starting |
| | stalled worker: a turn that ended with unpushed commits, uncommitted changes or a job still running (#587, #619) | Blocked · what was left |
| | `running` | Running |
| | `stopping` | Running · Stopping… |
| | `waiting` | Needs you · its request |
| | `queued` | Waiting · its reason as written: *waiting for a free agent slot*, *waiting for the Poise update*, *queued behind …*, or the step it is on, such as *preparing the checkout* (#665) |
| | `interrupted` | Needs you · Interrupted, Resume continues |
| | `idle` | Idle |
| | `closed` | Idle · Closed |
| | `error` | Failed · the error |
| Agent run (Swarm) | running | Running · what it is doing |
| | completed | Done |
| | approved, clean, changes_requested | Done · Approved, No comments, or Changes requested with the count |
| | superseded | Idle · Superseded, and why |
| | stopped, cancelled | Idle · Stopped by you |
| | timeout | Failed · Timed out |
| | preflight_failed | Failed · Preflight failed |
| | error, failed | Failed · the error's first line |
| CI run | queued, waiting, pending, requested | Waiting |
| | in_progress | Running |
| | success | Done |
| | neutral | Done · Neutral |
| | failure | Failed |
| | timed_out | Failed · Timed out |
| | action_required | Needs you · Action required |
| | cancelled, skipped, stale | Idle · Cancelled, Skipped or Stale |
| Pull request on Board | green | Needs you · Ready to merge |
| | held: checks running | Waiting · checks running |
| | held: failing checks | Failed · the checks, by name |
| | held: changes requested, review required, an open conversation | Needs you · what it waits for |
| | held: a conflict, behind, blocked | Blocked · the reason |
| | held: a draft | Idle · Draft |
| | open, neither | Idle, or the state of the run or worker on it |
| | not read | no state; last read at … |
| | merged | Done · Merged |
| | closed | Idle · Closed |
| Issue on Board | open | Idle, or the state of the run or worker on it |
| | closed | Done · Closed |
| Notice | `chat_waiting`, `sign_in_needed`, `behavior_held`, `datastore_sync_failing`, `storage_low`, `github_quota_warning`, `action_needed`, `pr_ready` | Needs you |
| | `github_quota_exhausted`, `read_failed`, `action_failed` | Failed, in Faults |
| | `chat_turn_finished`, `action_finished` | Done |
| Behavior diagnostic | error, warning, info | Failed, Needs you, or Waiting · Retrying |
| Switchboard update | Needs you, Blocked, In progress, Done | Needs you, Blocked, Running, Done. A Blocked update that rests on a pending permission or question in its chat shows as that request: Needs you. |
| Switchboard | live or checking, paused, stopped, off | Running, Waiting, Failed with its reason, Idle |
| Task (chain journal) | an invocation running | Running · its phase and round |
| | queued for a slot, memory or the merge queue | Waiting · what for, in plain words |
| | a hold that needs a decision | Needs you · the decision |
| | an effect not proven, such as a reply that may have posted | Blocked · Not confirmed, until reconciled |
| | merged | Done · Merged, or Waiting · review evidence pending |
| | superseded | Done · Superseded, with the merge that covered it |
| Any failure (`docs/Error-State-Contract.md`, #758) | depends on its input | Needs you, with the action named |
| | depends on something else: a provider, a quota, capacity | Waiting on that thing |
| Observe → GitHub | issue or pull request | GitHub's own words: Open, Merged, Closed |

**The Manager place** renders with or without a Manager chat, and the same for the Switchboard. Rendering never creates a chat, starts work, or changes either chat's authority. Below 1,200 px the Switchboard floats over the work table, folded to its tab. The `/manager` snippet is edited where it is today, in Snippets, and opened from the Manager place.

**The reference.** The full reference holds focus until Escape or a click outside, then returns focus to the element, or to its place in the list if a live update removed it. A long press swallows the release, so it never activates Allow, Delete, Start or Stop. Unavailable controls use `aria-disabled`.

**Motion.** `src/motion.ts` (`reveal`, `layout`, `retire`, `spring`), under `docs/Natural-Flow.md`'s rules. `tokens.css` reads the spring constants from `MOTION_CSS` (`gateway/src/motion-model.ts`) instead of copying them. The top bar is outside every transformed owner.

**Tokens.** A unit test ports the mocks' checker and fails on any raw value in `src/ui/**` outside `tokens.css`. Fonts come from Google Fonts, which the CSP allows.

---

**Sealed on 4 November 2026. Reopened by the owner the same day to add Board's List and Assign to Poise, and on 11 November to follow `main`.** This is how the work will be done, and this text will not be changed anymore. Review may make the work smaller or cleaner; it may not add to it. Work starts only on the owner's explicit authorization naming this issue's full title and number.
