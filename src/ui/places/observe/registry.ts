// Observe's vocabulary, from the mocks' refdefs-observe.js: one entry per
// element, read by the tooltip, the full reference and the words on screen.
// A current value is always read from the live element, never canned.
import { register, type Registry } from '../../registry'

const tabCount = (el: HTMLElement): string => el.closest('[role="tab"]')?.querySelector('.n')?.textContent?.trim() ?? ''
const textOf = (el: HTMLElement): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim()

export const OBSERVE: Registry = {
  /* ---------- The place ---------- */
  'obs.tabs': { name: 'Observe', kind: 'Place', what: 'What happened, and why, in four parts: Tasks for the work the behavior chain carries, Behaviors for every agent run, GitHub for the history of pull requests, issues and CI, and Logging for Poise’s own evidence.', does: 'Choose a part; the choice is in the address, so a link can open any of them, and this browser remembers the last one.' },
  'obs.tasks': { name: 'Tasks', kind: 'Place', what: 'Every task the behavior chain carries, from its issue to its merge: its phase rail, its state and reason, its evidence and its timeline.', does: 'A task opens to its timeline beside the list. Its runs link to Behaviors.', now: (el) => (tabCount(el) ? `${tabCount(el)} in motion.` : ''), source: 'The chain’s journal on Poise’s server, which records every step with its time and never changes it.' },
  'obs.behaviors': { name: 'Behaviors', kind: 'Place', what: 'Every agent run, live: what the behaviors run, and chat turns, editor chats and fixes too. Called Swarm until 23 October.', now: (el) => tabCount(el) },
  'obs.github': { name: 'GitHub', kind: 'Place', what: 'Pull requests, issues and CI runs from GitHub, newest first, with their state. Called Archive until 23 October.', now: (el) => tabCount(el) },
  'obs.logging': { name: 'Logging', kind: 'Place', what: 'Poise’s retained diagnostics: what failed or warned, with its evidence and what it did to managed work.', now: (el) => tabCount(el) },
  'obs.org': { name: 'Scope', kind: 'Filter', what: 'All organizations, or one, for Tasks, Behaviors and GitHub. The same choice as Board’s.', now: (el) => textOf(el), unchanged: 'Logging, which filters by repository instead.', when: 'At once; remembered in this browser. A link that names something outside it widens it for that visit only.' },

  /* ---------- Tasks ---------- */
  'tk.search': { name: 'Filter', kind: 'Control', what: 'Narrows the tasks by repository, number or reason.' },
  'tk.which': { name: 'Which tasks', kind: 'Control', what: 'Active tasks, those that need attention, merged ones, or all.', now: (el) => el.querySelector('[aria-pressed="true"]')?.textContent?.trim() ?? '' },
  'tk.attention': { name: 'Needs attention', kind: 'Filter', what: 'Tasks that are held, not confirmed or owe review evidence, at once, and any other task after a day without a verified advance. Oldest progress first.', source: 'The chain’s attention projection. An advance is a new head, a posted review, a queue entry, a merge or a recovered gate; polls, failed attempts, holds and Resume are not.' },
  'tk.note': { name: 'Where this comes from', kind: 'Display', what: 'Tasks are read from the chain’s journal, 100 at a time, and read again at the refresh rate from General.' },
  'tk.status': { name: 'Chain state', kind: 'Display', what: 'Who owns new work, v2, v1, or draining between them; how many model runs the chain holds of its ceiling, shared with other heavy work; and when this was read.', now: (el) => textOf(el), unavailable: 'A failed read keeps what was read, says when, and stops Hold and Resume until a read succeeds.', source: 'GET /api/behavior-chains: cutover, capacity and runtime.' },
  'tk.legacy': { name: 'Kept by v1', kind: 'Display', what: 'Pull requests v1 still owned when v2 took over. v1 keeps them until they close; they are not tasks.' },
  'tk.row': { name: 'Task', kind: 'List item', what: 'One task: its issue and pull request, its phase rail, and its state with the reason.', does: 'Opens its timeline beside the list.', now: (el) => textOf(el).slice(0, 160) },
  'tk.age': { name: 'No verified advance', kind: 'Display', what: 'How long since the chain last verified progress on this task.', now: (el) => textOf(el) },
  'tk.evidence': { name: 'Evidence', kind: 'Display', what: 'What the chain knows beyond the task’s state: its last verified advance, the gates on its head, what happens next, when its evidence is read again, and what covered a superseded task.', does: 'A recheck reads the evidence again. It never retries held work.', unavailable: 'The chain gives a last advance, gates and a next step only for the work in Needs attention.' },
  'tk.history': { name: 'History only', kind: 'Display', what: 'A merged or superseded task keeps its timeline; there is nothing left to hold or resume.' },
  'tk.board': { name: 'See it on Board', kind: 'Action', what: 'Opens Board, where the task is one card in its lane, with a route back here.' },
  'tk.from': { name: 'From here', kind: 'Display', what: 'The step a notice or a diagnostic pointed to, marked in the timeline.' },
  'tk.run': { name: 'Run', kind: 'Action', what: 'Opens this run in Behaviors, with its model, events and evidence.' },
  'tk.engine': { name: 'Behavior engine, in Settings', kind: 'Link', what: 'Opens Settings → Behaviors, where v2 is switched on. Until it is, v1 owns new work and there are no tasks to carry.', does: 'Opens Settings, with a route back to Observe.' },
  'tk.more': { name: 'More tasks', kind: 'Action', what: 'Reads the next 100 tasks from the journal.' },
  'tk.later': { name: 'Later events', kind: 'Action', what: 'Reads the journal’s events after the newest one shown. The timeline holds still while you read it, so new steps wait here.' },
  'tk.earlier': { name: 'More events', kind: 'Action', what: 'Reads the journal’s events before the oldest one shown.' },
  'tk.observed': { name: 'Observations', kind: 'Display', what: 'The chain reads GitHub on every sweep and records each reading. Readings in a row are folded into one line that says how many.', now: (el) => textOf(el) },

  /* ---------- Behaviors (was Swarm) ---------- */
  'bh.search': { name: 'Filter', kind: 'Filter', what: 'Narrows the runs to those whose model, behavior, target, state, outcome or error contains the text.', does: 'Matches what the columns show, so a copied target or a line of an error finds its run. The server searches every run, not only this page.' },
  'bh.count': { name: 'Runs', kind: 'Display', what: 'How many runs are listed, and of how many when a filter is on.', now: (el) => textOf(el) },
  'bh.history': { name: 'History', kind: 'Display', what: 'Newest first, 200 a page, with the exact total. Running runs are read again every 15 seconds; the rest at the refresh rate from General.', now: (el) => textOf(el) },
  'bh.stale': { name: 'Not updating', kind: 'Display', what: 'The last read of the runs failed. What was read stays, with when it was read; Poise keeps trying.', now: (el) => textOf(el) },
  'bh.held': { name: 'New runs, waiting', kind: 'Display', what: 'Runs that started while your pointer or focus was in the table. They wait so nothing moves under you.', does: 'Show now brings them in; leaving the table does too.', now: (el) => textOf(el) },
  'bh.group': { name: 'Identical runs', kind: 'Control', what: 'Finished runs with the same input and the same result share one row. The number is how many.', does: 'Shows or hides the earlier ones.', unchanged: 'Runs with a response or still going, which are never grouped: their output is not proven identical.' },
  'bh.model': { name: 'Model', kind: 'Display', what: 'The agent and model that ran it. An arrow names the model it recovered on. A chain’s own GitHub action runs no model.', now: (el) => textOf(el) },
  'bh.behavior': { name: 'Behavior', kind: 'Display', what: 'What started it: a behavior, in the name Settings and Overview give it, a chat turn, an editor chat or a fix. A chain’s own GitHub action names what it did, such as Merge if ready.', now: (el) => textOf(el) },
  'bh.org': { name: 'Org', kind: 'Display', what: 'The organization of its repository. It opens on GitHub.' },
  'bh.repo': { name: 'Repo', kind: 'Display', what: 'The repository and the pull request or issue it ran on. Each opens on GitHub.' },
  'bh.session': { name: 'Conversation', kind: 'Action', what: 'A run with no pull request belongs to a conversation.', does: 'Opens it in Chat, with a route back here. A conversation never opened in Chat says so in place.' },
  'bh.status': {
    name: 'Status', kind: 'Display', what: 'Where the run stands, in the seven state words, then what it concluded or what it is doing.',
    now: (el) => textOf(el),
    values: [['Running', 'With what it is doing and for how long. A missing heartbeat, incomplete progress or a quiet provider shows in amber.'], ['Done', 'With the outcome: Approved, Changes requested and its comments, Commented, or No comments.'], ['Idle', 'Stopped by you, cancelled, or superseded, with why.'], ['Failed', 'With the first line of the error. The whole error is in the detail.']],
  },
  'bh.started': { name: 'Started', kind: 'Display', what: 'How long ago it started. It counts up every five seconds, in place.', now: (el) => textOf(el) },
  'bh.elapsed': { name: 'Elapsed', kind: 'Display', what: 'How long it ran, or has been running. A running run’s count is live; an unknown one shows —.', now: (el) => textOf(el) },
  'bh.est': { name: 'Estimate', kind: 'Display', what: 'How long a running agent run likely has left, marked ≈: from similar runs, the same behavior and model completed in the last 30 days. It is not observed and not a promise.', now: (el) => textOf(el), values: [['≈ 6 min left', 'The median of similar runs, less the time it has run.'], ['Longer than usual', 'It has run past the 90th percentile of similar runs; the median is named.'], ['Nothing', 'Fewer than five similar runs, a direct run, or a chat turn: no estimate yet.']], source: 'Behavior estimates, read with the running runs.' },
  'bh.replay': { name: 'Replay', kind: 'Action', what: 'Runs the same behavior again on the same pull request or issue.', shows: 'Accepted, then a new run at the top. A refusal says why on the row.', unavailable: 'Chat turns are conversations, not commands: retry them from the chat.' },
  'bh.stop': { name: 'Stop', kind: 'Action', what: 'Ends a running run. On a step of a chain it also holds that chain, until you resume it.', does: 'The first press asks Sure? for four seconds; the second stops it.', shows: 'Stopping…, then Idle · Stopped by you. A failure says why on the row.', unchanged: 'What it already posted.' },
  'bh.detail': { name: 'Detail', kind: 'Action', what: 'Opens the run under its row: its activity, the provider’s reasoning, and its response or its whole error.' },
  'bh.activity': { name: 'Activity', kind: 'Display', what: 'The worker’s heartbeat, the provider’s last event, the stage deadline, and each step with its time.', when: 'Live while it runs; it holds still while you select text in it.' },
  'bh.reasoning': { name: 'Provider reasoning', kind: 'Display', what: 'What the provider reported while it reasoned, read when you open it.' },
  'bh.quarantine': { name: 'Unreadable records', kind: 'Display', what: 'Records the run log could not read, kept apart with what could be read of them.', unchanged: 'Every other run, which keeps updating.' },
  'bh.board': { name: 'See it on Board', kind: 'Action', what: 'Opens this run’s issue or pull request on Board, with its phase, its state and who has it, and a route back here.', does: 'A filter that hides it is cleared for this visit; what you left is still remembered.' },
  'bh.pager': { name: 'Pages', kind: 'Control', what: 'Runs load 200 at a time, newest first. The total is exact, and search reads every run on the server, not only this page.' },

  /* ---------- GitHub (was Archive) ---------- */
  'gh.type': { name: 'Shows', kind: 'Filter', what: 'Which kinds of history: CI runs, issues, pull requests, or any mix.', when: 'At once; remembered in this browser.' },
  'gh.cistatus': { name: 'CI outcome', kind: 'Filter', what: 'Failed CI runs only, or every run.', unavailable: 'Shown when CI is among the kinds.' },
  'gh.status': { name: 'Status', kind: 'Filter', what: 'Any, or only open issues and pull requests.', unavailable: 'Shown when issues or pull requests are among the kinds.' },
  'gh.time': { name: 'Updated', kind: 'Filter', what: 'Any time, Today, Yesterday or This week, by last update, in the time zone from General.' },
  'gh.search': { name: 'Filter', kind: 'Filter', what: 'Searches titles, repositories, numbers and authors across the whole history, not only what is loaded.' },
  'gh.count': { name: 'Count', kind: 'Display', what: 'How many are loaded, of how many match.', now: (el) => textOf(el) },
  'gh.kind': { name: 'Kind', kind: 'Display', what: 'PR, Issue or CI.' },
  'gh.title': { name: 'Title', kind: 'Display', what: 'Its title. It opens on GitHub.' },
  'gh.author': { name: 'Author', kind: 'Display', what: 'Who opened it, or whose push ran the CI.' },
  'gh.owner': { name: 'Owner', kind: 'Display', what: 'Who it is assigned to; a dash means no one. For CI, the branch it ran on.' },
  'gh.state': {
    name: 'Status', kind: 'Display', what: 'Its state on GitHub. CI runs speak the state words; issues and pull requests keep GitHub’s Open, Merged and Closed.',
    now: (el) => textOf(el),
    values: [['Open, Merged, Closed', 'Issues and pull requests, as GitHub says.'], ['Failed', 'CI that failed or timed out.'], ['Done', 'CI that passed, or ended neutral.'], ['Running, Waiting', 'CI in progress, or queued.'], ['Blocked', 'CI that requires an action.'], ['Idle', 'CI that was cancelled, skipped or went stale.']],
  },
  'gh.updated': { name: 'Updated', kind: 'Display', what: 'How long ago it last changed. Rows repaint in place at the refresh rate from General; nothing moves while you read.', now: (el) => el.getAttribute('data-help') ?? textOf(el) },
  'gh.review': { name: 'Consensus review', kind: 'Action', what: 'Asks several models to review an open pull request together, and posts the result on it.', shows: 'Accepted, Executing, then Review posted, on the row. Afterwards it offers to run again.', unavailable: 'A merged or closed pull request has nothing to review.' },
  'gh.more': { name: 'More history', kind: 'Display', what: 'Older history loads as you scroll, a page at a time, so the top is ready at once.', now: (el) => textOf(el) },
  'gh.error': { name: 'Incomplete', kind: 'Display', what: 'Some of the history could not be read. What was read is shown, and the read is retried.', now: (el) => textOf(el) },
  'gh.board': { name: 'See it on Board', kind: 'Action', what: 'Opens this issue or pull request on Board, with its phase, its state and who has it, and a route back here.', does: 'A filter that hides it is cleared for this visit; what you left is still remembered.' },
  'gh.link': { name: 'On GitHub', kind: 'Action', what: 'Opens this organization, repository, issue, pull request or run on GitHub, in a new tab.', now: (el) => `${textOf(el).replace('↗', '').trim()}.` },

  /* ---------- Logging ---------- */
  'lg.search': { name: 'Search diagnostics', kind: 'Filter', what: 'Searches the messages and evidence of the retained diagnostics. Secrets were removed before they were kept.' },
  'lg.count': { name: 'Matching', kind: 'Display', what: 'How many retained diagnostics match the filters.', now: (el) => textOf(el) },
  'lg.refresh': { name: 'Refresh', kind: 'Action', what: 'Reads the diagnostics again with the same filters, and their work impact with them.' },
  'lg.export': { name: 'Export', kind: 'Action', what: 'Downloads every matching retained diagnostic as NDJSON, one event per line.', shows: 'The download, or why it could not be complete.' },
  'lg.columns': { name: 'Columns', kind: 'Control', what: 'Shows or hides Workspace, Account, Call ID, Correlation ID and Incident ID.', unchanged: 'A column with a filter on it stays until the filter is cleared.', when: 'At once; remembered in this browser.' },
  'lg.data': { name: 'Data and collection', kind: 'Display', what: 'Whether Poise is collecting diagnostics now, how far back they are kept, and each source’s state and gaps. The dot is amber while collection is degraded.', now: (el) => el.getAttribute('data-help') ?? '' },
  'lg.filter': { name: 'Column filter', kind: 'Filter', what: 'Filters by this column. A filtered column is marked.', does: 'Opens its filter: levels for Severity, ranges for Time, a list for Source, text for the rest, each with Clear filter.' },
  'lg.severity': { name: 'Severity', kind: 'Display', what: 'How serious it is.', now: (el) => textOf(el), values: [['Critical', 'Poise or the workspace stopped working.'], ['Error', 'Something failed.'], ['Warning', 'Something may fail, or recovered.']] },
  'lg.time': { name: 'Time', kind: 'Display', what: 'When it happened, in the time zone from General. Ingested means the source gave no time, so this is when Poise received it.', now: (el) => textOf(el) },
  'lg.source': { name: 'Source', kind: 'Display', what: 'Where it came from: Poise, Caller, the gateway, Docker, the kernel, ingress, or the collector itself.' },
  'lg.row': { name: 'Diagnostic', kind: 'Display', what: 'One retained incident: its time, work impact, severity, source, component, repository, target, message, and how many times it occurred.', now: (el) => (el.closest('[data-ev]') as HTMLElement | null)?.innerText.replace(/\s+/g, ' ').trim().slice(0, 160) ?? '' },
  'lg.detail': { name: 'Evidence', kind: 'Action', what: 'Opens the full evidence under the row.' },
  'lg.links': { name: 'Go to', kind: 'Action', what: 'Opens what the diagnostic is about: the run in Behaviors, the pull request, or the setting.' },
  'lg.facts': { name: 'Facts', kind: 'Display', what: 'Everything recorded about it. Not recorded means the source did not say; nothing is guessed.' },
  'lg.impact': { name: 'Work impact', kind: 'Display', what: 'What this diagnostic did to managed work, as the chain’s journal verifies it: retrying, blocked, recovered or unknown, then the work and its stage.', now: (el) => textOf(el), when: 'Read once for each snapshot. Refresh reads it again; the new-diagnostics poll does not.', source: 'The chain’s journal, matched by the exact call or correlation.' },
  'lg.workimpact': { name: 'Work impact', kind: 'Display', what: 'The verified impact: current impact, stage and target, last verified progress, the next retry or action, and the matched step. A recovered failure says so.', does: 'Open its task at this step goes to the task’s timeline in Observe → Tasks, at that step.', unavailable: 'Unknown when no managed chain step matches the evidence exactly.' },
  'lg.related': { name: 'Related diagnostics', kind: 'Action', what: 'Other events of the same incident, or with the same correlation ID, 20 at a time, within the severities and interval you chose.', does: 'Choose one to open it.' },
  'lg.new': { name: 'New diagnostics', kind: 'Action', what: 'Diagnostics that arrived since this page was read. They wait, so the table holds still.', does: 'Reads them in.', now: (el) => textOf(el) },
  'lg.pages': { name: 'Pages', kind: 'Control', what: '50 at a time, newest first. Previous returns to the snapshot you saw.' },
  'lg.linked': { name: 'Linked diagnostic', kind: 'Display', what: 'The diagnostic a link opened, with its interval applied and widened if it fell outside.', does: 'Restore saved filters returns to your own.', values: [['Has expired, or is unavailable', 'The evidence is no longer retained, or not yours to read. Browse retained diagnostics goes on from there.'], ['The link is invalid', 'Says so; nothing is applied.'], ['Sign in, access, busy', 'Sign in to read it, or diagnostic access is unavailable, or the query service is busy.']] },
  'lg.scope': { name: 'Access scope', kind: 'Setting', what: 'Your workspace, or every workspace on this instance.', unavailable: 'Only administrators can read the instance.' },
  'lg.status': { name: 'Snapshot', kind: 'Display', what: 'How many retained diagnostics match, and when this snapshot was read, in the time zone from General.', now: (el) => textOf(el) },
}

register(OBSERVE)
