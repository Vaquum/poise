# Tasks with one spine: what the behavior chain gives the redesign

From #728, "chain atomic behaviors through durable issue-to-merge outcomes", merged on 28 October at 18:29 UTC and closing PRD #727, read against `main` at `77976fd`. Production execution is off by default.

## What #728 adds

- **One issue, one chain.** A chain is an issue on its way to a merged pull request. It is driven by fresh behavior invocations, not by a chat.
- **The steps.**
  1. Issue review, by the configured number of reviewers, who must actually post their comments.
  2. Implementation, then publishing: a branch and a pull request.
  3. PR review of each head.
  4. Repair, for findings, failing or stuck CI, conflicts and queue rejection. Each repair produces a new head, which needs a fresh review.
  5. Approval of the current head, and resolving the conversations left.
  6. Merge, directly or through the native queue.
  7. Done. Only an actual GitHub merge SHA counts; queue admission, approval or "closed" never do.
- **An immutable journal.**
  - Every change is an event with a sequence number and a time: admitted, observed, waiting with a reason, held with a reason, resumed, merged.
  - Every invocation moves through admitted, started, then settled, or uncertain when an outcome cannot be proven.
  - A current view is rebuilt from the events, and the PR's replay rebuilt all ten sandbox chains exactly.
- **Reasons in plain words, from the decision logic.**
  - Waits, which clear by themselves:
    - "exact-head CI is still running";
    - "native merge queue owns entry …";
    - "pull request is a draft";
    - "native repository readiness gates are not satisfied".
  - Holds, which need a decision:
    - "queue removal requires a decision: …";
    - "pull request closed without a confirmed merge";
    - "implementation returned no changes and produced no pull request";
    - "seed issue already belongs to existing work: …".
- **The API.** `GET /api/behavior-chains` lists chains, 100 at a time, filtered by active or merged.
  - Each chain carries its issue, branch, the two accounts, the current wait or hold, its PR and merge SHA.
  - It also carries its last 20 invocations, with step, state, model, slot, outcome, evidence, and the call id linking to its run.
  - `?id=` pages a chain's events, 20 at a time. `POST` holds or resumes a chain, and refuses a stale write.
- **In classic,** this appears as a panel in Settings → General: the switch, which issues enter (label `poise`, or every open issue), and a plain list of chains with Hold and Resume.

## Why this lifts the whole experience

Today, one piece of work is scattered across the interface: its issue and its pull request on Board, its runs in Observe, its notices in Overview, its worker in the Manager. You rebuild the story yourself.

A chain is that story, kept by Poise: where the work is, what it waits for, what it needs from you, and everything that happened, each with a time. The journal makes it honest by construction. Nothing is shown as Done without a merge SHA, and what is unknown stays visibly unknown.

So the proposal is to make the **task** the interface's unit of work, and to give every task the same spine.

## The proposal

### 1. A task, with two drivers

A task is one issue on its way to a merged pull request. **Behaviors** drive it as a chain, or a **worker** chat drives it (PRD #563).

- Both show the same phase, state, reason and timeline.
- A chain's timeline is its journal.
- A worker task's timeline is the "Latest changes" the work table keeps. It is thinner, because chat work has no journal.

### 2. The phase rail

Seven short segments: Intake · Issue review · Implementation · PR review · Repair · Approval · Merge.

- Past phases are a quiet fill. The current phase takes its state's colour, and the phases ahead are hollow.
- Repair returns to PR review, so the rail counts rounds: *PR review · round 3*. A chain has no Review cap: it deliberately skips that escape, so unresolved blockers stay blockers (`docs/Behavior-chain.md`).
- It is one line high everywhere and updates in place, so nothing moves around it.

### 3. The seven states, derived from the journal

| Journal | State · words |
| --- | --- |
| An invocation has started | Running · the step, the reviewer or slot, the model, for how long |
| An invocation admitted but not yet started | Waiting · a free behavior slot |
| `chain.waiting` | Waiting · its reason, worded by the registry: *CI is still running on 3f9c2ab*, *In the merge queue* |
| `chain.held` | Needs you · its reason, with Resume |
| An invocation is uncertain | Blocked · *Not confirmed: a reply may have posted*, until it is reconciled |
| A failed invocation that will retry | Waiting · *Retrying PR review at 14:20* |
| `chain.merged` | Done · *Merged as 4d34831* |
| No longer matches intake | Idle · *Left the chain* |

Each reason has an entry in the registry, so its tooltip and full reference explain it.

### 4. The timeline

Every task opens to its timeline: each event with its time, newest first. Each invocation links to its run, the model and slot it used, and its evidence: the comment, the head, the review, the merge SHA.

The timeline is held still while you read it. It shows its freshness from the latest observation, and Hold or Resume act where you read them.

## Where it shows

| Place | What changes |
| --- | --- |
| **Board** | A chained issue and its pull request become one task card, moving Issue → PR → Done. It carries the phase rail and the reason. Opening it shows the timeline in the side pane, beside the card's chat. The manual lanes (Idea → Concept → Plan → Issue) now continue automatically to the merge. |
| **Overview** | *In motion* counts tasks by phase, for example *2 in PR review · 1 repairing · 1 in the merge queue*. *Answer here* lists each hold, with its reason, Resume and Open. The day's numbers gain chains merged today and the median issue-to-merge time. |
| **Observe** | A **Tasks** part, one row per task, with the rail, state, reason and PR, opening into its timeline. Its invocations link to their runs in the part beside it. That part, today's Behaviors, already lists every run, a task's invocations included, so naming it *Runs* removes the overlap with Settings → Behaviors. |
| **The Manager** | The work table's rows are tasks of either driver, with a *Driven by* column (Behaviors, or the worker's name). A chain's observation fills the Conflicts, Open review, Behind main and CI failing flags (☑, ☐, ?). *Now* is its current step or reason, and *Latest changes* is its last journal events. |
| **Settings → Behaviors** | An *Issue to merge* group with the switch, which issues enter, and the label. It names the author and review accounts, which must differ, and links each step's model slot to Models. |
| **Everywhere** | The instruction lifecycle uses the same words as an invocation: Accepted, Queued, Executing, then Completed, or Not confirmed. Chats, answers and behaviors then speak one lifecycle. |

## What the server already gives, and what it would need

- **Already there:**
  - the chain list with summaries;
  - each chain's event history;
  - Hold and Resume;
  - each invocation's run link;
  - each chain's PR number, so Board can join issue and PR;
  - the intake settings.
- **Small additions that would help:**
  - **A notice for a hold.** A `chain_held` notice would put holds in the notices feed and the handling log; until then Overview reads them from the chain list.
  - **An issue-to-merge time.** A per-chain aggregate would save Overview reading every event history.
  - **Entering the chain from Board.** An action that adds the intake label to an issue. Drawn on 4 November as Assign to Poise, in [CURRENT.md](CURRENT.md); until the server has it, the label is added on GitHub.
- **Not available:**
  - a journal for worker tasks;
  - live production chains, which stay off until the owner turns them on. Until then, the interface says *The chain is off*.

## Decisions

1. **The task.** Make it the interface's unit of work, with chains and workers as its two drivers? Recommended.
2. **Board.** One card per task, joining a chained issue and its PR? Recommended.
3. **Observe.** Add Tasks beside Runs, and rename Behaviors → Runs, which also settles that open question? Recommended.
4. **Holds in Answer here.** Read them from the chain list now, and ask for a `chain_held` notice? Recommended.

**Where they stand, 3 November.** Round 13 builds decisions 1, 2 and 4 on the recommended option, so they are easy to change: tasks are the unit of work on Board, in the Manager's work table, in Observe → Tasks and in Overview's *In motion* and *Answer here*, with holds read from the chain list. Decision 3 is half taken: Tasks is Observe's first part, and the part beside it keeps the name you gave it on 23 October, Behaviors. See [CHANGES-2026-11-03.md](CHANGES-2026-11-03.md).

**4 November.** v2 is published: #822 merged the chain's controls and durable execution into `main`, and production activation is verified apart from merge. [CHANGES-2026-11-04.md](CHANGES-2026-11-04.md) says how the mocks follow.
