# Overview, the command center

**Decision, 23 Oct: Cockpit.** It is `overview.html`. Briefing is kept for reference at `overview-b.html`, linked only from the hub.

Brief 3 asks for a strategic overview. You asked for more than that: the page you rarely need to leave. Everything that needs your answer can be answered on it, notifications live in it, a control sets how much of them you see, and Analytics and the behaviors' numbers move into it.

Sources, in ~/dev/poise as of 21 Oct:
- `docs/Analytics.md`, `src/views/analytics-view.ts` and `src/analytics-*.ts`.
- `docs/Notifications.md`, `src/views/notification-rail.ts` and `src/notification-items.ts`.
- `src/views/behaviors-view.ts` and `src/behavior-metrics.ts` (the metric columns).
- The mock's own data, so Overview agrees with Board, Chat, Editor, the Manager and Settings.
- Round 13: `main` at `e7b8fea` (1 Nov) for the new notices and faults (#750, #774, #782, the ledger), and PRD #819 for the outcomes card.
- 4 Nov: `main` at `741d2c4`, for Notifications off (`?notifications=off`) and the quota's other states (`?quota=unset`, `failed`).

## What moves in (O1–O20)

**Analytics**, a view of its own today:
- O1 Its own view, from the menu or the top bar.
- O2 One board of cards. Drag a card's header to reorder, by pointer or keyboard; the order is remembered.
- O3 The day: previous, the date, next. It opens on Today, and days follow the time zone in General.
- O4 Organization filter (All orgs, or one), shared with Board, Swarm and Archive.
- O5 Eight productivity numbers:
  - pull requests opened, merged, and closed without merging;
  - lines changed;
  - time to first review and time to merge;
  - issues opened and closed.
- O6 Five per merged pull request: comments, median lines, behaviors, median time, merged by agent.
- O7 Today against the seven-day median, as "Typical by now":
  - ahead of or behind pace outside ±10%, on pace inside it;
  - closed without merging reads the other way.
- O8 Durations against the seven-day median: faster or slower, with the sample count.
- O9 The past year: 52 weekly points, the latest in blue and the highest named, with a readout on hover or arrow keys and a ten-bin distribution.
- O10 Work type, from Conventional Commit prefixes.
- O11 Review rounds.
- O12 Change-request share.
- O13 GitHub API quota for your account and the automation account. For REST and GraphQL each:
  - used of total, and what remains;
  - the reset time and minutes left;
  - the rate per minute and the sustainable rate;
  - the risk of running out (yellow, orange, red);
  - 24 hourly columns.
- O14 A missing value shows —, and its explanation sits on the measurement. Read failures go to Notifications.
- O15 Quiet rereads on the shared refresh tick while visible. Values and charts hold their place.

**Behaviors' numbers**, from the Behaviors table:
- O16 Total runs, duration and success for Any time, Today, Yesterday or This week, per behavior, with the last run and its owner.
- O17 Status chips per behavior (Poise faults, needs you, automatic) that open the notifications on it.

**Notifications**, the bell's rail today:
- O18 The bell counts what needs you, Poise faults and what is ready. Its colour is red for a fault, amber when something needs you, and green when all that is open is ready.
- O19 The rail lists by who acts: Needs you, Poise faults, Ready, Handled automatically (folded). A filter shows one group at a time; entries expand in place. Open, Dismiss, and Silence reminders on a ready pull request. Arrivals show as cards for six seconds.
- O20 The kinds of notice, in order:
  - a chat waiting for permission or an answer;
  - a sign-in needed;
  - a behavior failed and held;
  - a datastore not synced for 15 minutes;
  - a pull request ready to merge, reminding every 15 minutes;
  - a long chat turn finished;
  - API quota at risk or exhausted;
  - the workspace disk below 5 GiB, added in round 12.

  Since then on `main`: a review requested of you and a merge conflict, both Needs you; two faults from the behavior ledger, *not writing* and *records lost*; a repository the automation account cannot read, which names its fix, *Invite the account, or resend its invitation* (#750); an approval that waits on other reviewers' conversations, which is Waiting, not a fault (#774); and idle worker slots with an empty enhancement backlog, with up to five issues to label (#782).

  Every kind is in this mock.

## What both directions share

- **Answer here.**
  - Every question, permission, review request and sign-in can be answered inside the Overview: the options are on the item itself.
  - An answer shows its progress (Accepted, Executing, Completed). It is final, because whoever asked is waiting on it. Dismiss and Silence wait eight seconds in the tab, with Undo, before they are sent.
  - Opening the full context (the chat, the card, the pull request) is a choice, never a requirement, and it keeps a route back.
- **The level control.**
  - One control decides how much of the notifications you see, in the live groups, and each level includes the ones before it:
    1. Only what needs you.
    2. Plus Poise faults.
    3. Plus what has finished, for you to see.
    4. Everything, with what Poise handles on its own.
  - The default is the third, which is what the bell counts. The choice is remembered, and the bell's number always matches it.
- **Nothing moves under you.**
  - Arrivals wait while your pointer or focus is in the list; a counter says how many.
  - An answered item stays where it is, settled, until you look away, then folds into Handled today.
- **One vocabulary.** States in the seven words; notices in the live groups. Behaviors, the Manager's Rhythm and quota risk keep their own settings. Their switches are the same settings as in Settings, where you also use them.
- **The data agrees with the other views.**
  - #475's permission, W4's and W3's questions, #484 ready to merge, and the reviews requested on #473 and Limen#1141.
  - Grok's sign-in, and Rerun Grey CI's failure, which retries after the REST reset. The research@ Google account needs its sign-in in Settings → Accounts and Publishing; `main` raises no notice for it, so Overview shows none.
  - Every notice Poise writes carries `main`'s own title and body, word for word, such as *autonomio/poise#484 is ready to merge* or *Workspace disk is 95% full*; the card adds its kind, who and where, and its answers.
  - A chat's waiting notice folds into its requests, as PRD-INTERFACE.md sets out: each permission or question is its own entry, in the request's words, with its options. Review comments come from the Editor's reviews of published documents.
  - Groups follow the PRD's mapping: quota, data sync and storage are Needs you, as `main` groups them; a pull request ready to merge is Needs you too, since green means Done; only the two ledger faults are Poise faults; and `main`'s Ready is called Done.
  - The automation account's REST quota is at risk, and that is why that failure is held.
  - The chain's hold on #502 is the same task as in Observe → Tasks and on Board, with the same Resume.
  - In motion's counts are Board's, Chat's and the Manager's, read from the same lists; tasks are counted by phase.
  - Idle worker slots appear only when the Manager's slots really sit idle with nothing waiting for one. Slots count the Manager's open worker chats, as `main` does: seven of seven are held. Raising Rhythm in the Manager card applies on the Manager's next turn, which gives #483 to a new worker; a slot still empty 15 minutes later, with nothing labelled, raises the notice.

## Direction A: Cockpit

Everything at once, arranged by function, on one screen at 1440 × 900 (`overview.html`).
- **Left: Answer here.**
  - It runs the full height and scrolls inside itself.
  - The level control sits on top, as four segments: Only you, + Faults, + Done, Everything.
  - Notices are grouped by who acts; each has its answers on it and expands in place.
- **Right, at the top: In motion.** The seven states, counted for chats and workers, and for issues and pull requests, and the chain's tasks by phase, from Intake to Merge. Choose a state or a phase to list its work underneath; it opens on Running.
- **The day.**
  - Each productivity number is a tile: the value, its pace in words, a bullet (today against typical by now) and its year as a sparkline. Choose a tile to open its year with the readout and the distribution.
  - Tiles can be reordered by drag or keyboard, and the order is remembered (O2).
  - Per merged pull request follows as five small numbers, then Work type, Review, and the Manager: its sentence, its Rhythm with − and +, and Pause new work, the same as in its place.
  - **Pull request outcomes**, marked *Planned · #819*: merged pull requests, full Poise failures, and errors that recovered, as three lines on one scale. Each point is the mean of 2-hour samples over 24 hours, for the past five days; missing coverage is a gap, never zero.
- **Behaviors.** A compact table with each behavior's switch, last run, and runs, minutes and success for the chosen range.
- **GitHub API.** One card per account, with REST and GraphQL: used, left, the reset, the rate, the risk and the last 24 hours.

It suits glancing: what needs you, the work in motion and the day's numbers are all on the first screen.

## Direction B: Briefing

One column, read from the top, in order of what matters (`overview-b.html`).
- **A few sentences first.** For example: "14 things need you; Poise has 2 faults and 2 have finished. 4 workers are running and 1 ticket waits for a slot; 2 failed and 4 are blocked. Issues opened are 46% ahead of pace; issues closed are 19% behind, and time to merge is 19% slower than usual. bit-mis may run out of REST requests before 19:58."
  - They are written from the same notices and numbers as below. The notices follow the level you chose; the quota appears only when the risk is real.
  - Each underlined part opens what it names: Answer now, a number with its year, the work in motion, or the quota.
  - Meaning rides on the state capsule and the pace arrow, as everywhere else; the text itself stays quiet.
  - They rewrite themselves as things change, but never while your pointer or focus is in Answer now.
- **A strip of sections** stays on top and marks the one you are reading. Answer now carries the bell's count.
- **Answer now.**
  - The level control is a row of four labelled stops beside the heading.
  - The most pressing notice is open, with its context and its answers. The rest are one line each: what it is, from whom, and its first answer, so most can be answered from the line.
  - Answering the open notice opens the next and moves the focus to it, so 1, then 1 again, works down the list.
  - A line stays one line while its answer runs, and after, so nothing below it moves. Answered notices fold into Handled today when you leave the list.
- **Today so far.**
  - One table against typical, in four groups: counts, durations, per merged pull request, and review. Each row has the value, typical, the difference in words and colour, and a bullet.
  - Choosing a row, or moving with ↑ and ↓, draws its year in the chart beside the table, which stays in view as you go down.
  - Work type follows as one neutral bar with its prefixes.
- **In motion.**
  - Failed and Blocked come first, each with its next step. Where there is a notice, the step is the same answer as in Answer now, and shows there too: Retry on Muse, Ask an agent to review Limen#1141, Ask an agent to resolve it. Otherwise it says where to look: Open the failed check.
  - The other states are counts that list their work on request.
  - The Manager's sentence, its Rhythm and Pause follow.
- **Behaviors.** A sentence on what needs a look, then the same table as Cockpit.
- **GitHub API.** One quiet line, each account's REST and GraphQL use. It turns amber when a budget may run out before its reset; the lever is then in Answer now. Details opens the full budgets.

It suits deciding: the page tells you what to do next and shows the rest on request.

## Shared by both

- `overview-data.js` holds the notices, the day's numbers, the behaviors, the quota and the work; `overview-ui.js` draws the notices, the level control, the charts and the tables; `ov-shared.css` styles them. Each direction only arranges them.
- An answer changes what it touches, in both directions. Pausing Review New Pull Requests from the quota fault pauses it in Behaviors until 19:58 and lowers the automation account's REST risk. Retrying #446 from In motion answers its notice.
- `?ref=<key>` opens an element with its full reference, as in the other views; the review links there.

## Open questions

1. The level default is "plus what is ready", which matches the bell. Should Overview open on "only what needs you" instead?
2. **The bell.** Decided on 3 November, on the recommended option: on every view it counts what Overview's level shows and opens Answer here, with a route back, so answering lives in one place. A panel beside the place you are in, as the rail docks today, was the other choice.
3. Card reordering (O2): Cockpit keeps it. Briefing replaces it with a fixed order of importance. Is that acceptable?
4. Briefing's next steps beside failed and blocked work, and its sentences, could move into Cockpit. Wanted?

## 11 November

- **System health (#1101, planned).** Five live cards under In motion, over the last 24 hours of v2 chain work: errors per completed work item, work blocked, recovered by itself, time since the last work error, and evidence coverage, a bar per source with gaps in amber and unknown time hollow. Each opens its evidence: Logging, Observe → Tasks or Data and collection. It is marked *Planned · #1101* until it lands.
- **The 30 days.** Each number's year keeps its weekly line; under it, the 30 completed days before the chosen day, one value a day, in five bins, as `main` draws them since #995.
- **Chain work that needs attention** is a Needs you notice (#955): how long it has gone without a verified advance, what holds it, what is next, and its work impact. *Open its timeline* goes to the task at that step.
- **Partial Behaviors (#1133).** When some run records cannot be read, the readable counts stay, marked partial: `?behaviors=partial`.
