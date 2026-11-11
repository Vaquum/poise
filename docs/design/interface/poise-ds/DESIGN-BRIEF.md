# Interface and experience design brief

30 October 2026 · from the Poise interface redesign

## How to use this brief

This brief carries the principles and the method behind Poise's interface redesign of October 2026, written so any product can follow them. Give it to whoever designs your product, a person or an agent, together with your owner's own goals.

- **What it is.** An acceptance standard of eight principles, rules for look and feel, one vocabulary, proven interaction patterns, a method from inventory to shipping, and checklists.
- **What it is not.** It is not Poise's look. Bring your product's own palette, type and places, and keep the principles and the method.
- **The outcome.** Clickable mocks of every place, reviewed with the owner. Also an element review that accounts for every live behaviour, a token file, a registry of every word, and a plan to ship without disturbing the live product.

*Must* means required. *Prefer* means the default unless the owner decides otherwise. The appendix shows Poise's own values as a worked example.

## The standard: eight principles

Every place in the product must meet all eight. The owner writes them down first, and they are the acceptance standard for every review.

| # | Principle | What it requires | How to check it |
| --- | --- | --- | --- |
| 1 | One vocabulary | One name and one meaning for each thing, everywhere: states, actions, places. | Every word on screen comes from the registry; no synonyms. |
| 2 | A universal reference | Every control and display explains itself: a tooltip after 0.5 s, and a full reference one step away. | Hover, focus and long-press any element, then open its full reference by keyboard and by touch. |
| 3 | A strategic overview | The first place answers "what wants me, and how is it going", and lets you act there without leaving. | Each item that wants you carries its answers in place. |
| 4 | Places by purpose | A few places, each named for what it is for, in a fixed order. No settings for arranging them. | The top bar is identical in every place. |
| 5 | Deliberate defaults and stability | Every default is chosen and stated. Ordering can be changed where it helps. Nothing moves under your pointer while data updates. | Defaults are named in the reference; no layout shift when data arrives. |
| 6 | Controls for what acts on its own | Anything automatic gets independent controls, plus one sentence saying what they add up to. Hard limits are enforced, not only asked for. | Each control's scope and effect is in its reference; enforcement has tests. |
| 7 | A review of every element | Every live behaviour gets an ID, its new place, and a decision with a reason. | The element review reaches 100% coverage; nothing disappears silently. |
| 8 | Clear feedback and continuity | Every action shows Accepted, Queued, Executing, then Completed or Not confirmed. Links open the exact item, with a route back. | Each action's lifecycle is visible where it was taken. |

The full reference answers the same questions for every element:

- what it is and what it does;
- what its current value means, and its other values;
- its scope, and when a change applies;
- what stays unchanged, and how the result shows;
- where its data comes from, and why it is unavailable when it is.

It dims the page, keeps the element lit, never covers or activates it, and returns focus when it closes.

## Look and feel

Mature the product; do not make it over. Keep what people already use all day, and give it cohesion. Poise's owner described the goal as "a child that grew up wild, now time to mature".

- **Never brighten a proven palette.** If a palette works for all-day use, keep its neutrals, accents and density. New directions are judged against it.
- **Colour only for meaning.** Colour marks state, nothing else. Structure, chrome and decoration stay neutral.
- **Weight follows role.** A divider, connector or rule whose role is quiet must look quiet: a hairline, unless it carries state.
- **The top bar never shifts.**
  - View controls live inside the view, never in the global bar.
  - The active place is marked without changing its width: an underline, not bold.
  - Every place scrolls inside itself, so no page scrollbar moves the bar. Measure its items against every other place; they match to the pixel.

### Tokens

Every value comes from one token file, so the look can be tuned everywhere at once and never drifts.

- **Three layers.** Controls (`--ctl-*`) are the dials a person can turn. Primitives (`--p-*`) are the raw scales. Semantic tokens say what a value is for, such as a state colour, a spacing step or a duration.
- **Raw values live only in the token file.** Components use semantic tokens only.
- **A lint script enforces it.** It fails on any raw value outside the token file, in style sheets and in styles built in code.
- **A Style panel gives each person control** over type, size, density, corners, line weight, motion and state colours. It saves in the browser and reads the token file live.

### Motion

Motion explains a change, or there is none.

- A place enters once, when it is first opened. Returning to it is instant.
- Reading places fade in; other places rise a short distance. The top bar stays outside every moving element.
- Feedback is short and settling is spring-eased. Both scale with the person's motion control.
- Reduced motion, or Motion off in the Style panel, makes everything instant.

## One vocabulary

Everything that moves speaks the same seven states, each with one colour, whatever it is: a chat, a worker, a run, an issue, a pull request, a CI job.

| State | Colour | Means | It ends when |
| --- | --- | --- | --- |
| Running | Teal | Work is happening now. | The work finishes, fails or is stopped. |
| Needs you | Amber | Only you can move it on. | You answer or decide. |
| Waiting | Slate, dashed | It will continue by itself. | What it waits for arrives. |
| Blocked | Rose | It cannot go on without something outside it. | That thing is resolved. |
| Idle | Hollow | Nothing is happening, and nothing is expected. | Someone starts it again. |
| Done | Green | Finished, and confirmed. | It does not. |
| Failed | Red | It ended in error. | It is retried or set aside. |

- **Keep the outcome beside the state** wherever the state alone would lose information: *Done · Approved*, *Idle · Superseded*, *Failed · Preflight failed*.
- **Map every source once.** Every status your system has gets one row in a mapping table that the owner decides and tests cover. Unclear rows are product decisions, not code details.
- **Unknown is never a state.** Data that could not be read shows when it was last read. It never reads as Idle, zero or "clear".
- **Done means confirmed.** Show Done only on evidence of the outcome, such as a merge SHA, never on a request or an acknowledgement.

### The registry

One typed entry per element, read by everything that names or explains it: tooltips, full references, help text, and the state words on screen.

- Each entry holds the element's name, kind, what it is, what it does, its current value, its other values, scope, when a change applies, what stays unchanged, how the result shows, its source, and why it is unavailable.
- Nothing on screen is worded outside the registry, so a name changes in one place.
- The element review checks that every element's entry exists.

### Words

- Plain words, short sentences, one name per thing.
- Name the reason in the person's terms: *waiting for a free agent slot*, not *queued*.
- Never claim more than happened: *In the merge queue*, not *Merged*; *Not confirmed*, not *Failed*, when the outcome is unknown.

## Interaction patterns

These patterns carry the principles into everyday use. Each one solved a specific problem in Poise, and each applies to any product with live data.

- **Answer in place.**
  - The overview carries each item's answers, so you rarely leave it.
  - An answer names its item by id, never by its position in a list.
  - An item answered elsewhere, or no longer valid, turns its answers unavailable at once, with the reason.
- **Hold arrivals while you are in a list.** New rows wait, counted, while your pointer or focus is in a list, and *Show now* brings them in. Values repaint in place, and nothing reflows under you.
- **Show the lifecycle of every action.** Accepted, then Queued, then Executing, then Completed: shown where the action was taken. When the outcome cannot be proven, it says *Not confirmed* and offers to open the item. It never retries by itself.
- **Offer Undo only where a change can be reversed.**
  - A plain value can be saved again.
  - A *held send* waits eight seconds in the page before it is sent, and is sent at once if you leave.
  - Secrets, sign-ins, grants and anything already sent offer no Undo, and say why.
- **Make Settings a place, not a dialog.**
  - Each section has its own address, and `/` focuses Find.
  - Each row saves only its own field, says when the change applies, and shows *Default*, or *Changed* with Reset.
  - A save that would overwrite a newer value from elsewhere is refused and keeps your draft.
  - *This browser* marks settings that are only local.
- **Remove with a second press.** × then *Sure?* on each item. A removed item stays in place, crossed out, with Undo for eight seconds.
- **Link to the exact item, with a route back.**
  - A link opens the exact item, clearing a filter that would hide it.
  - The route back is a named place in the address (`back=overview`), never an arbitrary URL. It never reuses a parameter the destination needs.
- **Keep everything reachable.**
  - Every control works from the keyboard.
  - Unavailable controls stay focusable, so their reason can be read.
  - A long press shows the tooltip and never activates the control.

## Method

Work in rounds with the owner, one place at a time, on clickable mocks that follow the real product exactly.

1. **Read the live product from its current code.** List every view, panel, setting and state, with an ID for each behaviour. Never trust a local copy: in Poise, a checkout a week old missed five live features.
2. **Write the owner's brief down,** and map each principle to where the design meets it.
3. **Mock every place as clickable static pages.**
   - Use the token file and the registry from the first page.
   - Share one realistic dataset across places, so every view tells the same story.
   - Include the page states: loading, empty, failed, updating, signed out.
4. **Keep an element review page.**
   - Every live behaviour is one row: its ID, what it was, what it is now, the purpose it serves, the decision (keep, move, merge, remove or new) and the reason.
   - The page counts its coverage of the inventory, which must reach 100%. It also checks that every element's registry entry exists.
5. **Review with the owner in rounds.**
   - Give direct links to every page that changed, every time.
   - Log each decision with its date and the owner's own words.
   - Keep directions the owner did not choose as records, not deletions.
6. **Verify every round.** Token lint at zero, no console errors, keyboard and reduced motion, place-to-place transitions, and screenshots of each place.
7. **Re-audit as the product changes.**
   - Read what has merged since the last check, and extend the inventory, the review and the mocks.
   - Never claim completeness against an old baseline.
   - Owner decisions made elsewhere, such as in a ticket, bind the design too.

## Shipping it

Ship the new interface beside the old one, prove it on the element review, then make it the default. The interface change itself never touches the running service; anything the server must add ships as its own ticket.

1. **Write a PRD in the repository's own template.**
   - It states the boundary: what the interface does with the data it already gets.
   - Anything that needs the server goes in a ticket of its own, so the design never invents data.
2. **Build on what the server has.** The interface and the server ship in one build, so the new interface uses what is delivered, with no second code path.
3. **Leave the old interface alone.** The new interface is a second page beside it. It imports what fits as it stands and copies what does not; nothing moves.
4. **Flip in one revertible change.** The new page takes the root address and the old one keeps its own. One person goes back at that address; everyone, by reverting the flip.
5. **Check parity before the flip.** Every behaviour in the element review is reachable, or out of scope with its reason.
6. **Remove the old interface on the owner's word,** after a week's own use without going back.
7. **Answer every review finding.** Each one gets a fix or a reasoned non-fix, posted publicly, before the work is called done.

## Checklists

A project is done with this brief when every deliverable exists and every acceptance check is a yes.

### Deliverables

- [ ] The owner's brief, written down, with a map from each principle to the design
- [ ] An inventory of every live view, panel, setting and state, read from current code
- [ ] Clickable mocks of every place and every page state
- [ ] The token file, in three layers, and its lint script
- [ ] The registry, with the tooltip and full reference wired to it
- [ ] The seven-state mapping for every source of status
- [ ] The element review, at 100% coverage
- [ ] A decision log, with dates and the owner's words
- [ ] A shipping plan (PRD), with the boundary between interface and server stated

### Acceptance

- [ ] Every word on screen comes from the registry, with no synonyms
- [ ] Every control explains itself after 0.5 s, and its full reference opens by keyboard and by touch
- [ ] Colour appears only for state, and nothing is brighter than the product's proven palette
- [ ] The token lint reports no raw values outside the token file
- [ ] The top bar matches to the pixel in every place, and nothing shifts when data arrives
- [ ] Every action shows its lifecycle, and nothing claims more than the system confirmed
- [ ] Nothing unknown reads as a state, a zero or "clear"
- [ ] Every live behaviour has a decision, and nothing disappears silently
- [ ] Reduced motion and Motion off make everything instant
- [ ] Every link opens its exact item, with a route back

## Appendix: Poise as a worked example

These are Poise's own choices. Another product takes the principles, not these values.

| Element | Poise's choice |
| --- | --- |
| Places | Overview · Board · Chat · Editor · Observe · Settings |
| Proven palette | Dark, used all day: canvas `#161A20`, surface `#1C2129`, muted accents |
| Type | IBM Plex Sans and Mono; Zen Maru Gothic for display only |
| Tooltip delay | 0.5 s; `?` opens the full reference |
| Motion | Feedback 100 ms and settling 664 ms, each times the person's motion control, spring-eased |
| Undo and held sends | 8 s |
| Automatic controls | Rhythm (worker slots, each held by a worker until you close its chat; the Manager fills a free one on its next turn), Stability ↔ Expansion (how the Manager takes a Poise release), Autonomy (what it decides and what it brings), with one combined sentence; the Manager wakes every 60, 30, 15, 10 or 5 minutes |

One registry entry, for the Stop action in Observe:

```
'bh.stop': {
  name: 'Stop', kind: 'Action',
  what: 'Ends a running run.',
  does: 'The first press asks Sure? for four seconds; the second stops it.',
  shows: 'Stopping…, then Idle · Stopped by you.',
  unchanged: 'What it already posted.'
}
```

Where Poise applies all of this:

- [The interface PRD, autonomio/poise#556](https://github.com/autonomio/poise/issues/556), the frontend-only shipping plan.
- [The server PRD, autonomio/poise#562](https://github.com/autonomio/poise/issues/562), what the interface needed from the server.
- [The element review](https://github.com/autonomio/poise/blob/main/docs/design/interface/review.json), 390 rows with every decision and reason. The mocks' own review, `review.html`, has grown to 454 rows since, covering 302 live behaviours.
