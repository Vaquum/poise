# Observe, against the brief

Observe is one place for what happened, and why. It holds three of today's views, renamed on 23 Oct: Swarm is now **Behaviors**, Archive is now **GitHub**, and Logging keeps its name. Analytics moved to Overview. Round 13 adds a first part, **Tasks**: every task the behavior chain carries, from its issue to its merge.

Sources, in ~/dev/poise as of 21 Oct, then re-read on `main` at `e7b8fea` (1 Nov) and `741d2c4` (4 Nov, v2 published):
- **Swarm:** `src/views/swarm-view.ts`, `src/agent-progress.ts`.
- **Archive:** `src/views/main-view.ts`, which the code calls the main view, and its filters in `index.html`.
- **Logging:** `src/views/logging-view.ts`, `src/logging.ts`, `docs/Logging.md` and `docs/Operating.md`.
- **Tasks:** `docs/Behavior-chain.md` and the chain's list in Settings → Behavior chain (#728, #737), with the proposal in [CHAINS.md](CHAINS.md).

The page is `observe.html`. Its data is in `observe-data.js`, the tasks in `tasks-data.js`, which Board, the Manager and Overview read too, and its vocabulary in `refdefs-observe.js`. `swarm.html` forwards to it, and round 4's Swarm is kept as `swarm-r4.html`.

## How the brief lands

| Brief | In Observe |
|---|---|
| 1 · One vocabulary | Runs speak the seven state words, then their outcome: Done · Approved, Done · Changes requested · 2 comments, Idle · Superseded, Failed · Preflight failed. CI does too. Issues and pull requests keep GitHub's Open, Merged and Closed. Behaviors are named as Settings and Overview name them. |
| 2 · Reference | Every control and column carries a key. A link from the review opens the element in its part, unfolded where it lives inside a detail. |
| 3 · Overview | Each part's tab carries one number: tasks in motion, runs going on, failing CI, and today's failing incidents. |
| 4 · By purpose | Three places that answer "what happened, and why" become one, with a Scope shared with Board. Their names say what each holds: Tasks, Behaviors, GitHub, Logging. |
| 5 · Stability | Runs that start while you are in the table wait, counted. New diagnostics wait behind a button. GitHub repaints rows in place, and times count up without moving anything. |
| 7 · Element review | W1–W18, R1–R12 and L1–L17 in the review, each with its decision, and rows of their own for Tasks, paging and the newer steps. |
| 8 · Feedback and continuity | Stop asks Sure?, then shows Stopping…, then Idle · Stopped by you. Replay shows Accepted, then the new run; a refusal says why on the row. Consensus review goes from Accepted to Executing to Review posted. Hold and Resume on a task say what happens next, and its journal records them. Links from Overview, Board, the Manager, Settings → Behaviors and Logging open the exact task, run or diagnostic, with a route back. |

## Tasks, new in round 13

**Today** on `main`, Settings → Behavior chain lists the chains: each issue and its pull request with its current step or *Merged*, and *Hold new invocations* or *Resume*. A chain's history is its journal.

**Redesigned**, as the first part of Observe (`observe.html?tab=tasks`):
- **The list.** One row per task: its issue and pull request, its title, its phase rail, and its state with the reason, such as *In the merge queue* or *For memory: 3.1 of 8 GB reserved; it starts when a run lets go*. Active, Merged or All, and a search. It reads 100 tasks a page from the journal.
- **The timeline.** Opening a task shows its rail, its state and reason, and its journal, newest first, 20 events at a time with More events. Each event is a Run, an Event, a Hold or *Not confirmed*. A run that Behaviors lists links to it; the timeline holds still while you read it.
- **Stop on a chain's run** holds that chain too, even after the run has settled, until you resume it.
- **Hold and Resume.** *Hold new invocations* stops the next step from starting; a run already going carries on. A task held for a decision offers Resume. A hold has one of these causes: a queue removal by hand or an unknown one, a blocker that implementation or repair reported, a run stopped over its memory or disk ceiling, your own Stop, or cleanup not proven. A check that fails in the merge queue is not a hold: it goes to a fresh repair (`docs/Behavior-chain.md`, 4 Nov).
- **Merged.** A merged task offers its history only. One merged outside the chain says *review evidence pending*, with the next evidence check.
- **See it on Board** opens its card, flashed, with a route back.
- **The chain off.** With v1 owning new work, the part says *The chain is off* and links to the behavior engine in Settings.

## Behaviors, formerly Swarm (W1–W18)

**Today:**
- W1 A table of agent runs, newest first. Running runs are read again every 15 seconds.
- W2 Identical finished runs share a row; a count shows the earlier ones.
- W3 Model, with the model it recovered on.
- W4 Behavior.
- W5 Org and repository, each opening on GitHub; the number opens the pull request or issue.
- W6 A run with no pull request names its conversation, and opens it.
- W7 Status: an icon and a word. Reviews say what they concluded, and superseded runs say why.
- W8 A running run says what it is doing and for how long. A missing heartbeat or a quiet provider is said.
- W9 Started and Elapsed, counting up live.
- W10 Replay a review, approval or issue review. A refusal is reported.
- W11 Stop, with Sure? for four seconds.
- W12 Detail: the activity, the provider's reasoning, and the response or the whole error. A failed run always opens.
- W13 Filter text that matches what the columns show, errors and outcomes included.
- W14 Organization filter.
- W15 The newest 50 first, then the whole history, with a note while it loads.
- W16 "Swarm is not updating" when a read fails, with the last good read.
- W17 Unreadable log records isolated, with what could be read.
- W18 Links from Behaviors and notifications open the exact run, clearing a filter that hides it.

Since 28 October on `main`:
- The history is read 200 runs a page, with exact totals and search across every run (#575, #630, #663). W15's "newest 50, then the whole history" is gone.
- Two new steps from the chain, Implement issue and Repair PR (#728, #737).
- Durations read 6s, 8m 30s or 4h, and an unknown one shows —, never 0 (#726).
- A running agent run carries `main`'s estimate (`server/behavior-estimates.ts`): *≈ 6 min left*, from similar runs, the same behavior and model completed in the last 30 days, five at least; past their 90th percentile, *Longer than usual*, with their median. Direct runs and chat turns show none.
- A repository the automation account cannot read is held once and rechecked hourly; Replay there is refused with the reason (#566). Held reviews retry by themselves once the provider recovers (#678).
- Replaying an issue review reviews exactly the revision the issue holds (#745, #749).

**Redesigned:**
- **Status.** The status is the state's capsule and word, then the outcome. Amber marks a heartbeat or provider that has gone quiet, because it needs watching.
- **Replay and Stop.** Their results stay on the row. The new run that Replay starts waits at the top while you are in the table. On an issue review, Replay reads *Review this revision again*; asking twice for the same revision starts nothing, and says so.
- **Pages.** Newest first, 200 a page, with Newer and Older, the exact total, and a search that reads every run.
- **Unreadable repositories.** Blocked · *Held*, saying that the automation account cannot read it and that it is rechecked hourly.
- **Scope.** One Scope for Tasks, Behaviors and GitHub, the same choice as Board's.
- **See it on Board.** A run's detail links to its work on Board, with a route back.

## GitHub, formerly Archive (R1–R12)

**Today:**
- R1 GitHub history: pull requests, issues and CI runs, newest first.
- R2 Kinds: CI, issues, pull requests, in any mix; CI first.
- R3 CI outcome: Failed or Any.
- R4 Issue and pull request status: Any or Open.
- R5 Updated: Any time, Today, Yesterday, This week.
- R6 Search across the whole history, with a count.
- R7 Organization filter.
- R8 Kind, title, author, org, repo, owner or branch, status, updated.
- R9 Consensus review on an open pull request. A settled one refuses, saying why.
- R10 More history loads as you scroll.
- R11 A source that fails says so and retries; the rest is shown.
- R12 Rows repaint in place at the refresh rate, and filters are remembered.

**Redesigned:**
- **Status.** CI speaks the state words.
- **Consensus review.** It shows its progress on the row.
- **Read failures.** A failed read is one amber line above the table: northwind's 502 in this mock.
- **Name.** GitHub, because that is what it shows: the history of pull requests, issues and CI there.
- **See it on Board.** Each issue and pull request links to its work on Board. A link from Board opens its row, clearing a filter that hides it (`?item=`). Every issue and pull request on Board has its row here, under the same title.

## Logging (L1–L17)

**Today:**
- L1 Retained diagnostics, 50 a page, newest first.
- L2 Time, severity, source, component, repository, target, message, count.
- L3 Optional columns: workspace, account, call, correlation and incident IDs.
- L4 Each column filters from its header: severity, time with a custom interval, source, exact values.
- L5 Search the diagnostics.
- L6 Refresh.
- L7 Export the matching diagnostics as NDJSON.
- L8 Data and collection: the state of collection and of the query service, retention, and each source's coverage and gaps.
- L9 Evidence: facts, message, cause chain, stderr, stack, context and resources.
- L10 Go to the run in Swarm, the pull request, or the setting.
- L11 Related diagnostics, from the same incident or the same correlation, 20 at a time.
- L12 New diagnostics wait behind a button on the first page.
- L13 Pages, with Previous returning to the snapshot you saw.
- L14 A link opens one diagnostic with its interval, with Restore saved filters.
- L15 Access scope for administrators: your workspace, or the instance.
- L16 Times in your time zone, marked Ingested when the source gave none.
- L17 Filters and columns are kept in this browser. An unreadable saved set falls back to the defaults, saying so.

**Redesigned:**
- **Data and collection.** Its button carries a dot: amber while collection is degraded (the kernel source, in this mock).
- **Severity.** Critical and Error are red; Warning is amber.
- **Links into Logging.** The Overview notice for Rerun Grey CI's held run links to its diagnostic.

## The data agrees with the other views

- **Tasks.**
  - #488's pull request #492 is in PR review, and #498's #499 is in repair, round 2: both runs are in Behaviors.
  - Limen#1150 is in the merge queue; #501 is held after someone removed it from the queue by hand; #495 is *Not confirmed*; #494 waits for memory.
  - #476 merged and deployed; #504 merged outside the chain, its review evidence pending.
  - The same tasks, in the same words, on Board, in the Manager's work table and in Overview's *In motion*.
- **Behaviors.**
  - #487's review is running.
  - #486 was reviewed with two comments.
  - #484 was approved after a 502.
  - #471's review was superseded.
  - #446's chat failed on Grok Build's 503.
  - W2's turn is running.
  - #485's fix is waiting for its provider.
- **GitHub.**
  - The pull requests and issues of Board and Overview.
  - Failing CI on #480 and #479.
  - The cancelled shard that Rerun Grey CI holds.
- **Logging.**
  - The quota forecast, the held behavior, northwind's sync failures and the approve retry.
  - Grok Build's and Google's sign-ins.
  - The low disk, and an out-of-memory restart yesterday.

## Open questions

1. **Names.** Settled on 23 Oct: Behaviors, GitHub and Logging. Observe → Behaviors lists chat turns, editor chats and fixes as well as the behaviors' own runs, as Swarm did. CHAINS.md proposed renaming it Runs, beside Tasks; it keeps the name you gave it.
2. **Scope.** Should Logging's Repository filter follow the shared Scope when one organization is chosen?

## 11 November: the chain's evidence, and work impact

`main` moved the chain's evidence from Settings → General to the foot of Logging (#1095), listed work needing attention (#955), and gave each diagnostic its work impact (#1106, #1120). In the mocks the evidence goes to Tasks, where the chain's work already lives, and Logging keeps the diagnostics.

- **Tasks' state line.** Who owns new work, the chain's model runs of its ceiling, shared with other heavy work, and when it was read, with the pull requests v1 kept at cutover folded beside it. A failed read keeps what was read and stops Hold and Resume until a read succeeds: `?chains=failed`. The drain between v1 and v2: `?engine=draining`.
- **Needs attention.** Held, unconfirmed and review-pending tasks at once, any other after a day without a verified advance, oldest progress first, each saying how long: `?which=attention`.
- **A task's evidence.** Its last verified advance, the gates on its head, what is next and when its evidence is read again. A recheck never retries held work. A superseded task names the merge that covered it and its failing and recovery runs (`t490`).
- **From a step.** A notice or a diagnostic opens the timeline at the step it names: `?task=t493&after=2`. It stands for `main`'s `/?view=logging&chain=…&after=…`.
- **Logging's Work impact.** A column after Time: retrying, blocked, recovered or unknown, with the work and its stage. The detail adds the last verified progress, the next retry or action and the matched step, and *Open its task at this step*. It is read once for each snapshot.
- **Behaviors.** A chain's own GitHub action names what it did, *Merge if ready*, and shows no model (#857). Chain runs use `main`'s new phase words, such as *Reading repair evidence*.
