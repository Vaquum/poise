// Overview's vocabulary, from the mocks' refdefs-overview.js (the Cockpit's
// entries; the Briefing's stay in the mocks) and the Manager card's entries
// from refdefs-manager.js. Values a mock wrote by hand are read from the live
// element here.
import { entry, register, term, type Registry } from '../../registry'

const text = (el: Element | null | undefined): string => ((el instanceof HTMLElement ? el.innerText : el?.textContent) ?? '').replace(/\s+/g, ' ').trim()

export const OVERVIEW: Registry = {
  /* ---------- Answer here ---------- */
  'ov.answer': {
    name: 'Answer here', kind: 'Panel', what: 'Requests addressed to you, with answers on each entry. Show also opens faults and work status.',
    does: 'Answer in place. J and K move between entries; 1 to 9 answer; Enter opens the detail; O opens it where it lives.',
    source: 'Poise’s notices, open chat requests and Switchboard decisions, publication threads, the behavior chain and Behaviors’ diagnostics.',
  },
  'ov.count-open': {
    name: 'Open', kind: 'Display', what: 'How many entries are open at the level you chose. The bell shows the same number, in the same colour.',
    now: (el) => `${text(el)} open.`,
    values: [['Red', 'Something is stuck: a fault is open.'], ['Amber', 'Something waits on you.']],
  },
  'ov.level': {
    name: 'Show', kind: 'Control', what: 'How much of Answer here you see. Each level includes the ones before it.',
    now: (el) => { const b = el.querySelector<HTMLElement>('[aria-checked="true"]'); return b ? `${text(b)}: ${b.dataset.gloss ?? ''}.` : '' },
    values: [['Only you', 'Open decisions and permissions for you, sign-ins, and formal GitHub review requests addressed to your personal account.'], ['+ Faults', 'Also what is stuck: held or stalled chain work, behavior failures and other faults. This is the default.'], ['Everything', 'Also work status, retries and publication review threads.'], ['Done', 'What has finished is in Handled today.']],
    scope: 'This panel, and the bell in every place.', when: 'Applies now; remembered in this browser.', unchanged: 'The entries themselves: a hidden one is still there, and shows again when you show more.',
  },
  'ov.remembered': { name: 'Last read', kind: 'Display', what: 'Answer here paints what it read last at once, while it reads afresh. Those entries are quieter and nothing on them acts until their source has been read again; each source replaces its own as its read lands.', now: (el) => text(el) },
  'ov.held': { name: 'New, waiting', kind: 'Display', what: 'Entries that arrived while your pointer or focus was in the list. They wait so nothing moves under you.', does: 'Show now brings them in; leaving the list does too.', now: (el) => text(el) },
  'ov.notice': {
    name: 'Entry', kind: 'Notice', what: 'A request, fault or work update, with its source and available actions.',
    now: (el) => { const n = el.closest<HTMLElement>('[data-notice]'); return n ? `${text(n.querySelector('.card-meta .nc-kind'))}: ${text(n.querySelector('.card-title'))}.` : '' },
    does: 'Its answers are its buttons. Its other actions show under the pointer, at its lower right: open it, its timeline or diagnostic, more, silence, dismiss.',
  },
  'ov.option': {
    name: 'Answer', kind: 'Action', what: 'Answers this entry, here.', shows: 'Accepted while it is sent, Executing once the service has it, then Completed with what happened, or the service’s reason where it failed.',
    unchanged: 'Everything else. An answer to an agent is final: whoever asked is waiting on it.', unavailable: (el) => el.dataset.why || 'Not available right now.',
  },
  'ov.gone': { name: 'No longer answerable', kind: 'Display', what: 'Why its answers are unavailable: it was answered elsewhere, cancelled or reset by its chat, the chat that asked no longer exists, or the connection to Poise dropped.', when: 'At once, even while new arrivals are held.', unchanged: 'The request itself, which Open still shows in its chat.', now: (el) => text(el) },
  'ov.reply': { name: 'Your own answer', kind: 'Action', what: 'Answers in your own words: a reply on a review thread, as your GitHub account, or a free-text answer to a question or a decision.', shows: 'Sent, then what the service confirms.' },
  'ov.open': { name: 'Open', kind: 'Action', what: 'Opens the full context, the chat, the run, the card or the setting, with a route back here.' },
  'ov.github': { name: 'Open on GitHub', kind: 'Action', what: 'Opens the pull request on GitHub, in a new tab.' },
  'ov.more': { name: 'More', kind: 'Action', what: 'Shows the whole entry: its full title and what it reports. Enter does the same.' },
  'ov.diagnostic': { name: 'Open its diagnostic', kind: 'Action', what: 'Opens the exact diagnostic in Observe → Logging, with its interval, and a route back here.' },
  'ov.timeline': { name: 'Open its timeline', kind: 'Action', what: 'Opens the task in Observe → Tasks at the step this entry names, with a route back here.' },
  'ov.dismiss': {
    name: 'Dismiss', kind: 'Action', what: 'Puts this entry away. Every entry has it, except a Manager’s question or a decision that offers options: those always take Other, in your own words.',
    tip: (el) => el.dataset.words ? `Puts it away: ${el.dataset.words}. Never resumes, retries or tells a chat anything.` : undefined,
    does: 'Only hides the entry: it never resumes a chain, retries a run or tells a chat anything. Its tip says what happens to the rest.',
    when: 'After eight seconds in this tab, which is its Undo; leaving the page sends it at once. It comes back when what it reports changes: a notice when it happens again, a chain when it moves, a diagnostic when it recurs, a review thread when someone replies.',
    scope: 'Every device and the bell: the server keeps it.',
  },
  'ov.silence': { name: 'Silence reminders', kind: 'Action', what: 'Stops the reminders for this notice while it stays open.', when: 'After eight seconds in this tab, which is its Undo.', unchanged: 'The pull request or issue, and whether it can merge.' },
  'ov.undo': { name: 'Undo', kind: 'Action', what: 'Takes back a Dismiss or Silence in its first eight seconds. Until then it waits in this tab; leaving the page sends it at once.' },
  'ov.read': { name: 'Last read', kind: 'Display', what: 'Whether this part could be read, and when it last was. A failed read keeps what was read before, never a guessed state.', now: (el) => text(el) },

  /* ---------- In motion and the Manager ---------- */
  'ov.motion': { name: 'In motion', kind: 'Display', what: 'The work in the seven state words: chats and workers, then issues and pull requests, then the chain’s tasks by phase.', does: 'Choose a state or a phase to list it. Each item opens where it lives, with a route back.' },
  'ov.counts': { name: 'States', kind: 'Display', what: 'How many are in each of the seven states.' },
  'ov.count': {
    name: 'State count', kind: 'Filter', what: 'How many are in this state.',
    now: (el) => { const s = el.querySelector<HTMLElement>('.sc')?.dataset.state; const n = text(el.querySelector('b')); return s ? `${n} ${term(`state.${s}`)}${el.getAttribute('aria-pressed') === 'true' ? '; listed below' : ''}. ${entry(`state.${s}`)?.what ?? ''}` : '' },
    does: 'Lists them below.',
  },
  'ov.phases': { name: 'Tasks, by phase', kind: 'Display', what: 'How many of the chain’s tasks are at each phase: intake, issue review, implementation, PR review, repair, approval, merge, and merged.', does: 'A phase lists its tasks below, each opening its timeline in Observe.' },
  'ov.phase': { name: 'Phase', kind: 'Control', what: 'Lists the tasks at this phase.' },

  /* ---------- The day's numbers ---------- */
  'ov.tiles': { name: 'The day', kind: 'Display', what: 'The eight productivity numbers for the chosen day and organization.', source: 'Poise’s datastore: what Board shows, plus what the agent account opened. These reads make no GitHub requests.' },
  'ov.tile': {
    name: 'Number', kind: 'Display', what: 'One of the day’s numbers: its value, its pace against the 7 days before, and its year.',
    now: (el) => el.closest<HTMLElement>('[data-tile], [data-small]')?.getAttribute('aria-label') || text(el),
    does: 'Choose it to open its year, with the readout and the 30 days before. Drag a tile, or press Alt with an arrow key, to reorder; the order is remembered.',
  },
  'ov.pace': {
    name: 'Pace', kind: 'Display', what: 'Today against typical by now: the 7-day median, scaled to the time of day.',
    now: (el) => text(el),
    values: [['Ahead of pace', 'More than 10% above typical; green.'], ['On pace', 'Within 10%, either way.'], ['Behind pace', 'More than 10% below; amber, not red, because red means Failed.'], ['Closed without merging', 'Reads the other way: fewer is better.'], ['Durations', 'Faster or slower than the 7-day median.']],
    when: 'Completed days compare with the full 7-day median; no scaling.',
  },
  'ov.year': { name: 'The past year', kind: 'Chart', what: '52 weekly points ending the day before the chosen day. The latest is marked and the highest named.', does: 'The pointer, or the arrow keys with Home and End, read each week.' },
  'ov.dist': { name: 'The last 30 days', kind: 'Chart', what: 'The 30 completed days before the chosen day, one value a day, in five equal bins. Unknown days are left out; real zeros stay.' },
  'ov.closeyear': { name: 'Close the year', kind: 'Action', what: 'Closes this number’s year and returns focus to it.' },
  'ov.filters': { name: 'Filters for this side', kind: 'Filter', what: 'The one set of filters for everything on the right of Answer here: the day, the search and the organization.', scope: 'Every panel on this side.', unchanged: 'Answer here, which has its own Show.' },
  'ov.day': { name: 'Day', kind: 'Filter', what: 'The time filter for this side: which day the numbers and the behaviors’ runs, time and success are for.', does: 'Previous and next move a day. It opens on Today; days begin at midnight in your time zone (General).', unchanged: 'Answer here. In motion, System health and the API quota are live, and say so when another day is chosen.', now: (el) => text(el.querySelector('[data-day-label]')) },
  'ov.find': { name: 'Filter', kind: 'Filter', what: 'The search for this side: every panel shows only what matches the words, ignoring case.', does: 'In motion lists every matching chat, issue, pull request or task, whatever its state; the day’s numbers, the behaviors and the API accounts show the matching ones. A panel with no match says so. Escape clears it.', now: (el) => ((el as HTMLInputElement).value ? `Showing what matches “${(el as HTMLInputElement).value}”.` : 'Everything is shown.') },
  'ov.org': { name: 'Organization', kind: 'Filter', what: 'All orgs, or one. The same choice as Board and Observe.', unchanged: 'The API quota, which belongs to the accounts.' },
  'ov.worktype': { name: 'Work type', kind: 'Display', what: 'The day’s merged pull requests by Conventional Commit prefix. Unclassified titles count too.', unchanged: 'Neutral bars: a type says nothing about quality.' },
  'ov.friction': { name: 'Review', kind: 'Display', what: 'What it took to merge: review rounds, and the share of merged pull requests with a change request.', when: 'Against the 7 days before; fewer is better.' },

  /* ---------- Behaviors and the API ---------- */
  'ov.behaviors': { name: 'Behaviors', kind: 'Display', what: 'Each behavior with its switch, its last run, and its runs, minutes and success for the chosen range.', source: 'Poise’s own record of the runs it launched.' },
  'ov.behavior': { name: 'Behavior', kind: 'Behavior', what: 'One behavior, how it last ran, and how much it ran.', now: (el) => text(el.closest('[data-beh]')) },
  'ov.behavior.switch': { name: 'On', kind: 'Setting', what: 'Turns this behavior on or off: the same switch as Settings → Behaviors.', when: 'From its next run.', unchanged: 'What it already did on GitHub.', now: (el) => (el.getAttribute('aria-pressed') === 'true' ? 'On.' : 'Off.') },
  'ov.behaviors.day': { name: 'For the chosen day', kind: 'Display', what: 'The behaviors’ runs, time and success are for the day chosen at the top right, like the day’s numbers.', now: (el) => text(el) },
  'ov.partial': { name: 'Unreadable run records', kind: 'Display', what: 'A run record whose behavior, status or start cannot be read could belong to this behavior, so its numbers are unknown rather than wrong. A record whose other fields are damaged still counts when those read cleanly.', now: (el) => text(el) },
  'ov.untimed': { name: 'Untimed runs', kind: 'Display', what: 'Runs whose end is unknown, such as an attempt cut short when Poise restarted. They count as runs; their time is left out of the total rather than guessed.', now: (el) => text(el) },
  'ov.quota': { name: 'GitHub API', kind: 'Display', what: 'Your account and the automation account, for REST and GraphQL: used, left, the reset, the rate, the risk, and the last 24 hours.', source: 'GitHub’s rate-limit answer, every 15 seconds. Reading it costs no quota.', values: [['Needs configured accounts', 'No account is set: set your GitHub user and the automation account in Settings → General.'], ['Could not be read', 'Says so, with when it last read. Never a guessed number.']] },
  'ov.bucket': { name: 'Budget', kind: 'Display', what: 'One account’s REST or GraphQL budget until its reset.', now: (el) => text(el.closest('.qb')) },
  'ov.risk': {
    name: 'Risk', kind: 'Display', what: 'An estimate that this budget runs out before its reset, if the current rate continues.',
    values: [['0%', 'Nothing to watch.'], ['1–66%', 'Amber: watch it.'], ['Above 66%', 'Red: it will likely run out.']],
  },

  /* ---------- System health ---------- */
  'ov.health': { name: 'System health', kind: 'Display', what: 'Five live cards over the last 24 hours of v2 chain work: errors per completed item, work blocked, recovered by itself, time since the last work error, and evidence coverage. Each opens the evidence behind its value.', source: 'PRD autonomio/poise#1101: the chain journal, Caller receipts, GitHub and Logging’s coverage.' },
  'ov.h.errors': {
    name: 'Errors per completed work item', kind: 'Display', what: 'For work completed in the last 24 hours, its distinct work errors over its whole life, per item, with both counts.', does: 'Opens Logging.',
    values: [['at least', 'A counted item still has a run being reconciled, which may add an error.'], ['None completed', 'No v2 work merged in the last 24 hours, so there is no rate.'], ['Unknown', 'Which work completed is not known; the line under it says why.']],
    source: 'The chain journal, which keeps every settled run, and GitHub’s own merge time for each merged pull request.',
  },
  'ov.h.blocked': { name: 'Work blocked', kind: 'Display', what: 'Work held, not confirmed or overdue now, with the oldest time since verified progress and the stages it sits at.', does: 'Opens Observe → Tasks.' },
  'ov.h.recovery': { name: 'Recovered by itself', kind: 'Display', what: 'Work that recovered by itself after a failed run in the last 24 hours, with how many needed outside help.', does: 'Opens Observe → Tasks.' },
  'ov.h.lasterror': { name: 'Since the last work error', kind: 'Display', what: 'How long since the latest verified work error, and when.', does: 'Opens that diagnostic in Logging.' },
  'ov.h.coverage': { name: 'Evidence coverage', kind: 'Display', what: 'One row for each source these cards read: covered time, gaps, and unknown time.', does: 'Opens Logging.' },
  'ov.advance': { name: 'No verified advance', kind: 'Display', what: 'How long since the chain last verified progress on this work. Held work shows at once; other work after a day.', now: (el) => text(el) },
  'ov.impact': { name: 'Work impact', kind: 'Display', what: 'What this entry’s failure did to managed work, as the chain verifies it: its impact, target and stage, last verified progress and the next retry.', now: (el) => text(el) },
  'ov.fold': { name: 'Show or Fold', kind: 'Action', what: 'Shows or folds what Poise handled on its own. Folded, the group keeps its count.' },
  'ov.handled': { name: 'Handled today', kind: 'Action', what: 'Shows or folds what you and Poise settled today, newest first, with Undo while it lasts.' },

  /* ---------- The Manager, on the same settings as its controls ---------- */
  mgr: { name: 'The Manager', kind: 'Agent', what: 'The agent that plans work across workers, starts them within your Rhythm, and brings decisions to you according to Autonomy.', does: 'Its chat is where you instruct it. Its controls live in its place and in Settings → Manager, on the same settings as this card.' },
  'mgr.why': { name: 'Why this came to you', kind: 'Display', what: 'The reason this decision was brought to you.', now: (el) => text(el) },
}

register(OVERVIEW)
