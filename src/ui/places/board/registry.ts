// Board's words, from the mocks' refdefs-current.js: one entry per element,
// read by the tooltip, the full reference and the element review alike.
import { entry, term, type Registry } from '../../registry'

export const BOARD_REF: Registry = {
  /* ---------- The board ---------- */
  'cur.scope': {
    name: 'Organization', kind: 'Scope', what: 'Which organization’s repositories the board shows.',
    now: (el: any) => `${(el.closest('[data-ref="cur.scope"]') || el).textContent.replace(/\s+/g, ' ').trim()}.`,
    values: [['All orgs', 'Every organization your accounts can see.'], ['One organization', 'Only its repositories, in every lane.']],
    scope: 'Every lane. Cards without a linked repository always show; they are yours, not an organization’s.', when: 'Immediately; kept between visits.', source: 'Your connected GitHub accounts.'
  },
  'cur.status': {
    name: 'Status', kind: 'Filter', what: 'Whether the live lanes include merged and closed items.',
    now: (el: any) => `${el.querySelector('[aria-pressed="true"]')?.textContent || ''}.`,
    values: [['Any', 'Default. Open, merged and closed. Done items gather in a fold at the end of each live lane.'], ['Open', 'Only open issues and pull requests.']],
    scope: 'The Issue and PR lanes.', when: 'Immediately; kept between visits.', unchanged: 'Your own cards.'
  },
  'cur.time': {
    name: 'When', kind: 'Filter', what: 'How recently a live item must have changed, or been opened, to show. Time means says which.',
    now: (el: any) => `${el.querySelector('[aria-pressed="true"]')?.textContent || ''}.`,
    values: [['Any time', 'Default.'], ['Today', 'Since midnight.'], ['Yesterday', 'Yesterday.'], ['This week', 'In the last seven days.']],
    scope: 'Live issues and pull requests.', when: 'Immediately; kept between visits.', unchanged: 'Your own cards.'
  },
  'cur.by': {
    name: 'Time means', kind: 'Filter', what: 'Whether When looks at an item’s last change or at when it was opened.',
    now: (el: any) => `${el.querySelector('[aria-pressed="true"]')?.textContent || ''}.`,
    values: [['Updated', 'Default. Its last change: an old issue touched today counts as today.'], ['Opened', 'When it was opened: Today lists only what was opened today.']],
    scope: 'Live issues and pull requests.', when: 'Immediately; kept between visits.', unchanged: 'Your own cards.', source: 'GitHub’s created and updated times. Anything opened today has also changed today, so the same read serves both.'
  },
  'cur.who': {
    name: 'Who', kind: 'Filter', what: 'Whether the work is Poise’s own.',
    now: (el: any) => `${el.querySelector('[aria-pressed="true"]')?.textContent || ''}.`,
    values: [['Anyone', 'Default.'], ['Poise', 'The chain carries it, from its issue to its merge.'], ['Not Poise', 'Everything else: a worker’s, a chat’s, a person’s, or nobody’s.']],
    scope: 'Live issues and pull requests.', when: 'Immediately; kept between visits.', unchanged: 'Your own cards.', source: 'The chain’s list. An issue labelled poise on GitHub counts once the chain has taken it.'
  },
  'cur.view': {
    name: 'View', kind: 'Control', what: 'The same live work as lanes of cards, or as a list with one row each.',
    now: (el: any) => `${el.querySelector('[aria-pressed="true"]')?.textContent || ''}.`,
    values: [['Lanes', 'Default. Your cards and live work on one line.'], ['List', 'Issues, then pull requests, one to a row: where each has got to, what is happening, for how long, and who has it. Your Idea, Concept and Plan cards stay in Lanes.']],
    when: 'At once. It waits as you left it, in this browser: leave Board on List and it opens on List next time.', unchanged: 'The work, its filters, its order and its actions: both views show the same thing.', source: 'Kept in this browser.'
  },
  'cur.search': { name: 'Filter', kind: 'Filter', what: 'Shows only cards whose text, or an item’s title, repository or number, contains these words.', scope: 'Every lane.', when: 'As you type.', unchanged: 'Nothing is removed; clearing the filter brings every card back.' },
  'cur.order': {
    name: 'Order', kind: 'Control', what: 'How the live lanes are ordered. Your own lanes always keep the order you give them.',
    now: (el: any) => `${el.querySelector('[data-order-label]')?.textContent || el.textContent.trim()}.`,
    values: [['Attention', 'Default. Needs you, Blocked, Failed, Running, Waiting, Idle; Done folds at the end.'], ['Recent activity', 'Most recently updated first.'], ['Repository', 'By repository, then by attention.']],
    scope: 'The Issue and PR lanes, for you. Kept between visits.', when: 'Immediately. Live changes never move a card while you are on the board.'
  },
  'cur.held': { name: 'Updates held', kind: 'Display', what: 'Items changed while you were on the board.', does: 'Their state words change at once; their new places wait until your pointer and focus leave the board, so nothing moves under you.', now: (el: any) => el.textContent.trim() },
  'cur.summary': { name: 'In motion', kind: 'Display', what: 'Every live item on the board, counted in the seven state words.', does: 'Choose a state to show only those items; choose it again to show everything.', source: 'The Issue and PR lanes, under your filters.' },
  'cur.count': {
    name: 'State count', kind: 'Filter', what: 'How many live items are in this state.',
    now: (el: any) => { const s = el.dataset.state, n = el.querySelector('.n')?.textContent; return s ? `${n} ${term(`state.${s}`)}${el.getAttribute('aria-pressed') === 'true' ? '; showing only these' : ''}. ${entry(`state.${s}`)?.what ?? ''}` : ''; },
    does: 'Shows only these items; choose it again to show all.', when: 'Immediately.', unchanged: 'Your own cards, and the items themselves.'
  },
  'cur.clear': { name: 'Clear filters', kind: 'Action', what: 'Puts Status, Updated, the text filter and the state filter back to their defaults.', unchanged: 'Organization and order.' },

  /* ---------- Lanes ---------- */
  'lane.idea': { name: 'Idea', kind: 'Lane', what: 'A thought worth keeping. Your cards: only you add, move or remove them.' },
  'lane.concept': { name: 'Concept', kind: 'Lane', what: 'Shaped enough to talk about. Your cards.' },
  'lane.plan': { name: 'Plan', kind: 'Lane', what: 'Ready to be written down as an issue. Your cards; drop one on Issue to open it.' },
  'lane.issue': { name: 'Issue', kind: 'Lane', what: 'A task, live from GitHub: issues you opened, were assigned or took part in.', source: 'GitHub, through Poise’s cache, refreshed on the shared tick.' },
  'lane.pr': { name: 'PR', kind: 'Lane', what: 'A change, live from GitHub: pull requests you opened, review or took part in.', source: 'GitHub, through Poise’s cache, refreshed on the shared tick.' },
  'lane.count': {
    name: 'Count', kind: 'Display', what: 'How many cards this lane shows under your filters.',
    now: (el: any) => (/\+$/.test(el.textContent.trim()) ? `${el.textContent.trim()}: more exist than are loaded.` : `${el.textContent.trim()}.`),
    values: [['N', 'All of them.'], ['N+', 'Poise loads the 200 most recently updated issues and pull requests, combined; older ones are not loaded.']]
  },
  'lane.add': { name: 'Add a card', kind: 'Action', what: 'Writes a new card into this lane.', does: 'Optionally link a repository. ⌘Enter adds; Esc cancels.', shows: 'The card appears at the top of the lane, saved with the time. If your filter would hide it, Poise says so.', unchanged: 'Nothing on GitHub.' },
  'lane.add-issue': { name: 'Add an issue', kind: 'Action', what: 'Opens a new issue on GitHub, as you, in the repository you pick.', when: 'When you choose Open issue or press ⌘Enter. Nothing is written before that.', shows: 'The issue appears at the top of the lane at once: Accepted, Executing while GitHub opens it, then Completed with its number.' },
  'lane.drop': { name: 'Drop to open an issue', kind: 'Display', what: 'Dropping one of your cards here opens the issue composer with the card’s text and repository.', unchanged: 'The card stays until the issue exists, then it is removed: its text lives on in the issue.' },
  'cur.done': {
    name: 'Done', kind: 'Display', what: 'Merged and closed items, gathered at the end of a live lane.',
    does: 'Opens or folds them. Folded by default, so open work comes first; your choice is kept.',
    now: (el: any) => `${el.querySelector('.n')?.textContent || ''} done; ${el.getAttribute('aria-expanded') === 'true' ? 'showing' : 'folded'}.`
  },
  'cur.trunc': { name: 'Not everything is loaded', kind: 'Display', what: 'Poise loads the 200 most recently updated issues and pull requests, combined. Older ones are not on the board.', does: 'Narrow the board with Updated or the filter to find an older item.' },
  'cur.empty': { name: 'Empty lane', kind: 'Display', what: 'Nothing in this lane under your filters.' },

  /* ---------- Cards ---------- */
  'card.manual': { name: 'Card', kind: 'Card', what: 'A card of yours: text and an optional linked repository.', does: 'Click or Enter edits it. Drag it, or press Alt with an arrow key, to move it within or between your lanes.', source: 'Saved in Poise.' },
  'card.live': { name: 'Issue or pull request', kind: 'Card', what: 'An item live from GitHub, with its state in Poise’s words and who is on it.', does: 'The title opens it on GitHub. The rest of the card opens it beside the board.', source: 'GitHub, through Poise’s cache.' },
  'card.link': { name: 'Open on GitHub', kind: 'Action', what: 'Opens this issue or pull request on GitHub in a new tab.', unchanged: 'The board, with its filters and scroll.' },
  'card.state': {
    name: 'State', kind: 'Display', what: 'Where this item stands, in the seven state words, with the detail that matters.',
    now: (el: any) => { const c = el.closest('[data-state]'); const s = c?.dataset.state; const d = el.querySelector('.detail')?.textContent; return s ? `${term(`state.${s}`)}${d ? ` · ${d}` : ''}. ${entry(`state.${s}`)?.what ?? ''}` : ''; },
    shows: 'For a pull request, its one current blocker from Poise’s per-pull-request status (#747), in plain words: held by a behavior; a review running on a head; changes requested; awaiting review, with its round; in the merge queue; approved but not enqueued; CI failing or pending on a head; unresolved conversations; a merge conflict; behind its base; blocked by GitHub; or unknown, naming what is missing.',
    values: [['Needs you', 'GitHub formally requested your personal account to review this pull request.'], ['Blocked', 'A merge conflict or another prerequisite.'], ['Failed', 'A check failed.'], ['Running', 'A worker, a chat or a run is working on it.'], ['Waiting', 'Checks are running, or it is next for a worker and gets one when a slot frees.'], ['Idle', 'Open; nothing in progress.'], ['Done', 'Merged or closed.']],
    source: 'GitHub’s checks and reviews, and the chats and runs on it.'
  },
  'card.worker': {
    name: 'On it', kind: 'Display', what: 'Who is working on this item: a worker the Manager runs (W1), a chat you run, or a run such as a review.',
    now: (el: any) => el.textContent.trim(), does: 'Opens that worker or chat, with a route back to this card.', source: 'Chats, the Manager and runs in this workspace.'
  },
  'card.new': { name: 'New', kind: 'Display', what: 'Opened in the last six hours. Blue, because it is information, not a state.' },
  'card.copy': { name: 'Copy', kind: 'Action', what: 'Copies the card’s text, or an item’s title and link.', shows: 'The icon turns into a check for a moment.' },
  'card.chat': { name: 'Chat about this', kind: 'Action', what: 'Opens a chat about this card beside the board, starting from its title and link.', unchanged: 'The card, and where you are: Board stays open. Open it in Chat instead leaves for Chat.', shows: 'The chat in the pane beside the board, with Accepted, Executing and Completed under each message.' },
  'cur.partial': { name: 'Board is not updating', kind: 'Display', what: 'A read failed, so the board says what it could not load and shows the rest. It tries again by itself.', values: [['Could not load GitHub issues and pull requests', 'Your cards stay; live items wait for the next read.'], ['Could not load your cards', 'Live items stay; your cards wait for the next read.']] },
  'card.open-chat': { name: 'Open in Chat', kind: 'Action', what: 'Starts a chat that works on this item: on the pull request’s branch, or on a new branch for an issue.', does: 'You confirm agent, model and branch before anything runs. If a chat or worker is already on it, this opens that one instead.', shows: 'The card shows the chat as who is on it, and its state.' },
  'card.review': {
    name: 'Run PR review', kind: 'Action', what: 'Starts an agent review of this pull request.', when: 'Immediately; the review posts on GitHub when it finishes.',
    shows: 'Accepted, then Running with the review on it, then Completed when it is posted.',
    unavailable: (el: any) => `This pull request is ${el.closest('[data-state]')?.querySelector('.detail')?.textContent || 'finished'}: there is nothing to review.`
  },
  'card.manager': {
    name: 'Hand to the Manager', kind: 'Action', what: 'Asks the Manager to take this issue as a ticket: it gives it to a worker of its own, within your Rhythm.',
    when: 'At once when a slot is free; otherwise it waits behind the Manager’s next tickets and gets a worker when a slot frees.', shows: 'The card shows the worker and Running, or the Manager and Waiting, with the tickets ahead. The task appears in the Manager’s work table.', unchanged: 'The issue on GitHub until the worker acts, and your Manager settings.',
    unavailable: 'Someone is already on it.'
  },
  'card.to-issue': { name: 'Open as issue…', kind: 'Action', what: 'Turns this card into a GitHub issue: the issue composer opens with the card’s text and repository.', does: 'The same as dropping the card on the Issue lane, from the keyboard.', unchanged: 'The card stays until the issue exists, then it is removed: its text lives on in the issue.' },
  'card.delete': { name: 'Delete card', kind: 'Action', what: 'Removes this card from Board.', when: 'After you confirm with “Sure?” within three seconds.', unchanged: 'Issues and pull requests on GitHub.', shows: 'The card leaves and focus moves to the next card.' },
  'card.edit': { name: 'Edit card', kind: 'Control', what: 'Change the card’s text and linked repository.', when: 'On Save or ⌘Enter. Esc cancels.', unchanged: 'The card’s place.', shows: 'Completed · saved, with the time.' },
  // main's closed blocker vocabulary (server/behavior-pr-status.ts), first match wins, in the interface's words.
  'card.blocker': {
    name: 'Blocker', kind: 'Display', what: 'The one thing that holds this pull request now, from Poise’s per-pull-request status: the first that applies, in this order.',
    now: (el: any) => `${el.firstChild?.textContent || el.textContent}.`,
    values: [
      ['not handled by Poise: why', 'not_eligible. Idle.'], ['held by a behavior, with when it tries again', 'held. Blocked.'],
      ['review running on a head · round n of the cap', 'review_running. Running.'], ['changes requested on a head: the author’s turn', 'awaiting_author. Waiting.'],
      ['waiting for review of a head · round n of the cap', 'awaiting_review. Waiting; the cap reached says so.'], ['in the merge queue, since when', 'in_queue. Waiting.'],
      ['approved, not in the queue: why', 'approved_not_enqueued: removed from the queue, Merge Pull Requests off, paused, or a retry time. Waiting.'],
      ['CI failing: the checks, by name', 'ci_failing. Failed.'], ['CI running on a head', 'ci_pending. Waiting.'],
      ['n open conversations on a head', 'unresolved_threads. Waiting.'], ['conflicts with the base', 'conflicting. Blocked.'],
      ['behind the base', 'behind. Blocked.'], ['blocked by GitHub’s rules', 'blocked. Blocked.'], ['not known: what could not be read', 'unknown. No state word: when it was last read.']
    ],
    source: 'Poise’s per-pull-request status (#747), from the behavior ledger. It has no screen on main yet; these are the interface’s words for each of its fourteen blockers.'
  },
  'card.stuck': { name: 'Standing still', kind: 'Display', what: 'The same blocker has held this pull request for the time shown. Poise marks it after 15 minutes, and an open pull request after an hour.', source: 'Poise’s per-pull-request status, from the behavior ledger: age, review rounds, the latest verdict and its head, CI on the head, the merge queue, and one current blocker.' },
  'card.dwell': {
    name: 'How long', kind: 'Display', what: 'How long it has been like this: whether something is happening now, or it is sitting.',
    now: (el: any) => el.textContent.trim(),
    values: [['for 8m', 'Running: something is working on it now, for this long. Any other state: it has waited this long.'], ['the same for 36m', 'The same state and reason for 15 minutes or more, so it may be stuck.'], ['no change for 2h', 'Idle: nothing has happened on it.']],
    source: 'A run’s start, a chain’s last step, a pull request’s current blocker, or GitHub’s last update. A pull request’s blocker time restarts when Poise’s server restarts, and says so.'
  },
  'card.assign': {
    name: 'Assign to Poise', kind: 'Action', what: 'Gives this open issue to the chain: Poise carries it from review to merge.',
    does: 'Adds the chain’s label, poise, on GitHub, as you. The chain takes the issue at its next check.', when: 'After Sure?, because it starts real work.',
    shows: 'Accepted, then Queued, then the Poise chip with its phase and state. If GitHub refuses, the reason stays on the row and you can ask again.', unchanged: 'The issue’s text and its other labels.',
    unavailable: 'Not offered while a worker or chat is on the issue, while every open issue already enters, or on a pull request: the chain starts from an issue. While the chain is off it still adds the label, and the chain takes the issue once it is on.', source: 'Main’s assign_issue (#853), as your account. The chain does not take an issue that an open pull request closes, so the row shows that pull request.'
  },
  'card.intake': { name: 'Pull request that closes it', kind: 'Display', what: 'An open pull request that closes this issue, or no open PR. The chain does not take an issue that has one.', unavailable: 'When Poise could not read the intake, no label, Assign or pull request shows, and Board says so: unread is never “not assigned”.', source: 'Main’s issue_intake read (#853): the chain’s own label filter and the open pull requests’ closing references.' },
  'side.about': { name: 'Beside the board', kind: 'Panel', what: 'An issue or pull request the chain does not carry: where it has got to, what is happening, who has it, and its runs.', does: 'Opens when you choose its row or card. Close returns you there.' },
  'side.same': { name: 'The same work, elsewhere', kind: 'Display', what: 'This work’s other views: its task, its runs in Behaviors, its row in the GitHub history, and GitHub itself.', does: 'Each opens the exact row, with a route back to Board.' },
  'card.chain': { name: 'Poise', kind: 'Display', what: 'The issue carries the chain’s label, or the chain carries the work: issue review, implementation, PR review, repair and merge, each a fresh run.', does: 'Opens the task in Observe → Tasks.' },
  'card.timeline': { name: 'Open its timeline', kind: 'Action', what: 'Opens the task’s timeline beside the board: every step with its time, newest first.' },
  'card.edit-issue': { name: 'Edit issue', kind: 'Action', what: 'Loads the issue’s current title and body from GitHub into the issue writer.', does: 'Save issue checks that nobody changed it meanwhile, then saves it as you.', unchanged: 'Your draft, which stays if the check finds a change or GitHub does not confirm.' },
  'composer.labels': { name: 'Labels', kind: 'Control', what: 'The selected repository’s labels, to put on the new issue.', does: 'Filter by name; your ticks stay when the filter hides them. Changing the repository clears them, saying how many.', shows: 'A count on the tag. After opening, any label GitHub did not apply is named.', unchanged: 'With poise, the issue enters the chain once v2 owns new work.' },
  'composer.editing': { name: 'Editing', kind: 'Display', what: 'The issue this writer saves to. Its repository cannot change.' },
  'composer.conflict': { name: 'Changed on GitHub', kind: 'Display', what: 'The issue changed on GitHub since you opened it, so the save was refused and your draft is kept.', values: [['Load the latest', 'Replaces your draft with what GitHub has now; saving then works.'], ['Save again', 'Refused again until the latest is loaded: a change you have not seen is never overwritten.']], source: 'GitHub’s answer to the save, which checks the text you opened.' },
  'side.close': { name: 'Close', kind: 'Action', what: 'Closes the pane beside the board, and returns to the card.' },
  'side.send': { name: 'Send', kind: 'Action', what: 'Sends your message to the card’s chat, beside the board.', shows: 'Accepted, Executing, then Completed under your message.' },
  'side.open': { name: 'Open it in Chat instead', kind: 'Action', what: 'Opens the same conversation in Chat, with a route back to Board.' },
  'composer.cancel': { name: 'Cancel', kind: 'Action', what: 'Closes the writer without saving. Esc does the same.', unchanged: 'The card or issue as it was.' },
  'composer.open': { name: 'Open issue, or Save issue', kind: 'Action', what: 'Opens the issue on GitHub as you, or saves your edit to it.', shows: 'Accepted, then Executing while GitHub takes it, then Completed with its number, on the card.', unavailable: () => 'A title is required.' },
  'composer.text': { name: 'Card text', kind: 'Control', what: 'What the card says. ⌘Enter adds it; Esc cancels.' },
  'composer.add': { name: 'Add', kind: 'Action', what: 'Adds the card at the top of its lane, under the writer.', shows: 'Completed · saved, on the card.' },
  'side.input': { name: 'Message', kind: 'Control', what: 'Your message to the card’s chat. Enter sends.' },
  'confirm.agent': { name: 'Agent and model', kind: 'Control', what: 'The agent and model the new chat starts with.', unchanged: 'Settings → Models, which stays as it is.' },
  'confirm.start': { name: 'Start chat', kind: 'Action', what: 'Starts a chat that works on this issue or pull request, on the branch shown.', shows: 'The card shows Running with Chat on it; the chat is in Chat under Running.' }
};
