// The vocabulary every place shares, from the mocks' refdefs.js: terms, the
// seven states, navigation, the page's states, Chat's words and Style's rows.
import type { Registry } from './types'

const pressed = (el: any) => (el.closest('[aria-pressed]') || el).getAttribute('aria-pressed') === 'true';
const STATE_WORDS: any = {
  running: 'Running', 'needs-you': 'Needs you', waiting: 'Waiting', blocked: 'Blocked', idle: 'Idle', done: 'Done', failed: 'Failed'
};

export const SHARED: Registry = {
  /* ---------- Concepts ---------- */
  'term.chat': { name: 'Chat', kind: 'Concept', what: 'A conversation with one agent, kept until you delete it: its transcript, its settings and its workspace.', does: 'Holds everything said and done in it. A chat you start is run by you; a chat the Manager starts is a worker.' },
  'term.worker': { name: 'Worker', kind: 'Concept', what: 'A chat the Manager started and runs to do one piece of work. A worker is a chat; “worker” is its role.', does: 'Holds a slot from the moment it takes a task until its chat is closed, between turns too.' },
  'term.manager': { name: 'Manager', kind: 'Concept', what: 'The agent that plans work across workers, starts them within your Rhythm, and brings decisions to you according to Autonomy.', does: 'Watches every chat, starts and resumes workers, records new issues, and answers routine questions for you.' },
  'term.turn': { name: 'Turn', kind: 'Concept', what: 'One round in a chat: an instruction and everything the agent does until it stops.' },
  'term.active-turn': { name: 'Active turn', kind: 'Concept', what: 'A turn that has started and not yet ended, including one paused for your answer.' },
  'term.queued': { name: 'Queued instruction', kind: 'Concept', what: 'An instruction waiting in a chat’s queue. It starts when the current turn ends and Running at once has room; a worker keeps its Manager slot meanwhile.' },
  'term.steer': { name: 'Steer', kind: 'Concept', what: 'An instruction sent during an active turn. The agent receives it at its next step, without starting a new turn.' },
  'term.slot': { name: 'Slot', kind: 'Concept', what: 'Room for one of the Manager’s workers, from the moment it takes a task until its chat is closed; only you close a chat. Rhythm sets how many slots exist, and the Manager fills a free one on its next turn.' },

  /* ---------- States: one meaning each, everywhere ---------- */
  'state.running': { name: STATE_WORDS.running, kind: 'State', what: 'Work is executing right now: an agent’s turn, a run or a review.' },
  'state.needs-you': { name: STATE_WORDS['needs-you'], kind: 'State', what: 'Waiting for a decision, permission, sign-in or formal GitHub review request addressed to you.' },
  'state.waiting': { name: STATE_WORDS.waiting, kind: 'State', what: 'Paused on something other than you: checks, a free slot, the queue, a provider, a quota, memory or another worker. It clears by itself, and says what it is waiting for.' },
  'state.blocked': { name: STATE_WORDS.blocked, kind: 'State', what: 'Cannot continue until a prerequisite is met, such as missing access, a merge conflict or work it depends on, or until an effect Poise cannot prove yet is reconciled: Not confirmed. It names what it needs.' },
  'state.idle': { name: STATE_WORDS.idle, kind: 'State', what: 'Nothing is in progress. Ready for the next instruction or step.' },
  'state.done': { name: STATE_WORDS.done, kind: 'State', what: 'Complete: merged, closed or answered.' },
  'state.failed': { name: STATE_WORDS.failed, kind: 'State', what: 'The last attempt ended in an error: a turn, a check or a run. The history is kept; you can retry or give a new instruction.' },
  state: {
    name: 'State', kind: 'Display',
    what: 'Where this stands, in Poise’s one set of state words: the same seven for chats, runs, issues and pull requests.',
    now: (el: any) => { const s = el.closest('[data-state]')?.dataset.state; return s ? `${STATE_WORDS[s]}: ${SHARED['state.' + s].what}` : ''; },
    values: [],
    source: 'The chat’s live event stream from its agent.'
  },

  /* ---------- Instruction progress ---------- */
  life: {
    name: 'Instruction progress', kind: 'Display',
    what: 'How far an instruction you sent has got: accepted, queued, executing, completed.',
    now: (el: any) => el.closest('[data-life]') ? `${el.closest('[data-life]').dataset.life}.` : '',
    values: [['Accepted', 'Poise has it and saved it.'], ['Queued', 'Waiting for the current turn to end, or for a slot.'], ['Executing', 'The agent is working on it.'], ['Completed', 'The turn ended; the result is above.']],
    source: 'Poise’s own record of the instruction, then the agent’s events.'
  },

  /* ---------- Navigation ---------- */
  'nav.overview': { name: 'Overview', kind: 'Place', what: 'The command center: what needs your answer, with the answer right there; what is moving, failing or waiting; and how the work is going, from Analytics and the behaviors.', does: 'Opens the Overview. Most days you can do everything from it.' },
  'nav.current': { name: 'Board', kind: 'Place', what: 'Ideas, plans, issues and pull requests on one line. Called Current until 23 October.' },
  'nav.editor': { name: 'Editor', kind: 'Place', what: 'Long-form writing, with comments, agents and publishing.' },
  'nav.chat': { name: 'Chat', kind: 'Place', what: 'Conversations with agents, including the Manager and its workers.' },
  'nav.observe': { name: 'Observe', kind: 'Place', what: 'Status, history and evidence in one place: Tasks, Behaviors, GitHub and Logging. Behaviors and GitHub were Swarm and Archive. Analytics is part of Overview.' },
  'nav.settings': { name: 'Settings', kind: 'Place', what: 'Every configuration in one home: General, Accounts, Models and the rest, with Style and the Manager’s controls a step away.', does: 'Opens a menu: Style and the Manager’s controls directly, or any section of Settings, with a route back to where you were. Controls you use while working also appear where you work, on the same setting.' },
  'gw.signin': { name: 'Sign in with GitHub', kind: 'Action', what: 'Signs you in to the gateway in front of your workspace with your GitHub account.', does: 'Brings you to your workspace, or back to the page you were on.' },
  'gw.open': { name: 'Open your workspace', kind: 'Action', what: 'Opens your Poise at its own address. If it is stopped, it starts first.' },
  'gw.signout': { name: 'Sign out', kind: 'Action', what: 'Asks once, then signs you out of the gateway and of your workspace in this browser.', unchanged: 'Running agents and reviews.' },
  'gw.confirm': { name: 'Sign out', kind: 'Action', what: 'Signs you out of the gateway and of your workspace in this browser.' },
  'gw.states': { name: 'The gateway’s pages', kind: 'Mock', what: 'Every page the gateway shows, side by side, for reviewing. Not part of the design.' },
  'st.updating': { name: 'Updating', kind: 'State', what: 'Poise is restarting on a new version. The page dims, then reloads into it by itself.', unchanged: 'Running agents and reviews, which carry on.' },
  'st.claude': { name: 'Claude subscription', kind: 'State', what: 'Claude-backed work is paused or being checked, on every view until it is resolved. Poise keeps checking by itself.', values: [['Sign-in required', 'Sign in with Claude, with the subscription connected to this computer.'], ['Signing in', 'Finish in your browser; Poise verifies it and resumes.'], ['Out of quota', 'Signed in, and nothing to do until more quota is available.'], ['Check unavailable', 'Poise cannot reach Claude Code on this computer.'], ['Could not check', 'Poise’s own server could not be reached, which says nothing about the subscription; there is nothing to press.'], ['Verification failed', 'Reconnect Claude, or let Poise keep retrying.']], source: 'Poise’s check of the Claude CLI on this computer, every two seconds while it is unwell. Where a browser sign-in is not available, it points to Settings → Accounts.', unchanged: 'Work that runs on other models.' },
  'st.build': { name: 'New build', kind: 'State', what: 'A new Poise build is live and this tab is on the old one. Refresh keeps your drafts.', values: [['Waiting for …', 'A reload would lose it: text being composed, an unanswered request, a dialog, a chat being created, an upload. It names which.'], ['Refresh is waiting for …', 'You pressed Refresh with unsaved text: save or clear it and the tab refreshes by itself.'], ['This tab did not pick it up', 'After a refresh the tab is still on the old build, and offers Refresh again.']], unchanged: 'Running agents and reviews. Updating, when the service itself restarts, dims the page instead.' },
  'st.signedout': { name: 'Sign-in ended', kind: 'State', what: 'Your sign-in in front of the workspace ended, so nothing on the page can be read or changed.', does: 'Sign in again goes through the sign-in and brings you back here.', unchanged: 'Running agents and reviews, which carry on.' },
  conn: {
    name: 'Connection', kind: 'Display', what: 'Whether this page is receiving live updates from your workspace.',
    now: (el: any) => el.textContent.trim(),
    values: [['Live', 'Updates arrive as they happen.'], ['Reconnecting…', 'The connection dropped; what you see may be out of date.'], ['Offline', 'No updates; actions are held until it reconnects.']],
    source: 'Poise’s connection to your workspace.'
  },
  bell: {
    name: 'Notifications', kind: 'Display', what: 'What needs you, counted as Overview’s Answer here counts it at its Show level. Opens Answer here, with a route back to where you were; on Overview it brings Answer here to its first entry.',
    does: 'Moves focus to Answer here’s first entry, or to its empty state when nothing is open at the level.',
    now: (el: any) => el.querySelector('[data-bell]')?.hidden ? 'Nothing open.' : `${el.querySelector('[data-bell]')?.textContent || 0} open.`,
    source: 'Every chat, behavior and pull request in your workspace. Ready-to-merge reminders repeat every 15 minutes until merged or silenced.'
  },

  /* ---------- The chat list ---------- */
  list: { name: 'Chats', kind: 'Display', what: 'Every chat in this workspace, including the Manager and its workers.', source: 'This workspace, live.' },
  'list.new': { name: 'New chat', kind: 'Action', what: 'Opens an empty console for a new chat.', does: 'Nothing starts until you send the first message; the chat is created then.', when: 'On your first send.', unchanged: 'Other chats.', shows: 'The new chat appears in the list once it starts.' },
  'list.hide': { name: 'Hide chat list', kind: 'Display control', what: 'Folds the list away to give the conversation more room.', does: 'Show it again from the button at the start of the conversation’s header.', now: (el: any) => (pressed(el) ? 'The list is showing.' : 'The list is hidden.'), scope: 'This browser.', when: 'Immediately.' },
  'list.show': { name: 'Show chat list', kind: 'Display control', what: 'Brings the folded chat list back.', scope: 'This browser.', when: 'Immediately.' },
  'list.order': {
    name: 'Order', kind: 'Control', what: 'How this list is ordered. Conversations always keep their own chronology.',
    now: (el: any) => { const v = el.querySelector('[data-order-label]')?.textContent || el.textContent.trim(); return `${v}.`; },
    values: [['Attention', 'Default. Needs you, then Blocked, Failed, Running and Waiting, then Idle and Done by most recent activity. The Manager stays first.'], ['Recent activity', 'Most recently active first.'], ['Project', 'Grouped by repository, then by attention.'], ['Manual', 'Your own order: drag rows to arrange them.']],
    scope: 'This list, for you. Kept between visits.', when: 'Immediately. Live changes never move a row while you are using the list.'
  },
  'list.held': { name: 'Updates held', kind: 'Display', what: 'Chats changed state while you were using the list.', does: 'Their new positions apply when your pointer or focus leaves the list, so nothing moves under you. Selection and drafts are kept.', now: (el: any) => el.textContent.trim() },
  'list.group': { name: 'Group', kind: 'Display', what: 'Chats that share a state, with how many there are.', now: (el: any) => el.textContent.trim() },
  row: {
    name: 'Chat', kind: 'List item', what: 'One chat: its title, agent and model, project and last activity. A worker shows its tag; a stalled worker is Blocked with what it left, and Poise wakes it once.', does: 'Click or Enter opens it. Double-click or F2 renames it. × then “Sure?” deletes it. Shift-click or Shift-Space selects a range, and ⌘- or Ctrl-click or -Space toggles one, to delete several at once.',
    tip: (el: any) => { const s = el.querySelector('[data-state]')?.dataset.state; return `${STATE_WORDS[s] || ''} · ${el.querySelector('.row-title')?.textContent || ''}. ${el.querySelector('.who')?.textContent || ''}. Enter opens; F2 renames.`; },
    now: (el: any) => { const s = el.querySelector('[data-state]')?.dataset.state; const n = el.querySelector('.note')?.textContent; return s ? `${STATE_WORDS[s]}${n ? ` (${n})` : ''}: ${SHARED['state.' + s].what}` : ''; },
    source: 'The chat’s live event stream.'
  },
  'pane.close': { name: 'Close', kind: 'Action', what: 'Closes this pane. What it holds keeps applying: Memories stay in every message, timers keep their schedules, and the Manager keeps its controls.' },
  'list.resize': { name: 'List width', kind: 'Display control', what: 'Drag to make the chat list wider or narrower, from 200 to 480 pixels.', does: 'Arrow keys change it in steps; double-click resets it to the Style default.', now: (el: any) => `${Math.round(el.closest('.list').getBoundingClientRect().width)} pixels.`, scope: 'This browser.', when: 'Immediately.' },
  'row.delete': { name: 'Delete chat', kind: 'Action', what: 'Removes this chat from Poise.', scope: 'This chat and its transcript.', when: 'At once, after you confirm with “Sure?” within three seconds, which says whether its workspace goes too: only a sole local chat, whose branch never moved and whose tree is clean, takes it along.', unchanged: 'Pull requests, issues and pushed commits on GitHub.', shows: 'The row leaves the list at once. If the cleanup fails, the row comes back, saying why. A chat deleted while it is still being created never appears; if removing it fails, it returns to the list with the reason.' },
  'list.bulk.delete': { name: 'Delete selected', kind: 'Action', what: 'Deletes every selected chat. One confirmation names the count.', shows: 'The rows go at once, with Deleting N chats…; any that fail come back with the reason.', unchanged: 'Pull requests, issues and pushed commits on GitHub.' },
  'list.bulk.clear': { name: 'Clear', kind: 'Action', what: 'Clears the selection. Nothing is deleted.' },
  'new.type': { name: 'Type', kind: 'Setting', what: 'What the new chat is: a Chat you run, a Worker, which carries the /worker charter on every turn, or the Manager, of which there is one.', values: [['Chat', 'An ordinary chat.'], ['Worker', 'Carries /worker on every turn: one task, a PR, done when CI is green and every finding is answered.'], ['Manager', 'Supervises your chats. Offered only when there is no Manager; a new one wakes every 60 minutes until you change it in its header.']], unchanged: 'Nothing is selected until you choose; without a choice it is a Chat.' },
  'new.fallback': { name: 'Model provider', kind: 'Setting', what: 'Shown when the default model cannot start, with why. Choose the default anyway, or the model that is available.', values: [['Use the default', 'The chat waits for what the default needs, such as a sign-in.'], ['Use the fallback', 'The chat starts now on the available model.']] },
  'cmd.content': { name: '/content', kind: 'Display', what: 'Authors an article from the topic, through Poise’s own content pipeline. It runs beside the chat, never as a message to the agent, even during a turn.', shows: 'Authoring…, then Open in Editor; or why it failed.' },
  'cmd.consensus': { name: '/consensus', kind: 'Display', what: 'Debates the topic across models. It runs beside the chat, never as a message to the agent, even during a turn.', shows: 'Debating…, then the synthesis; or why it failed.' },
  'new.jev': { name: 'JEV · Primitive builder', kind: 'Action', what: 'Opens a new builder instead of a chat. Build Choice, Score and Noul questions; get typed results, not chat replies. Offered where JEV is configured; the builder works without a key, and evaluating needs one.' },
  'jev.place': { name: 'JEV · primitives', kind: 'Place', what: 'Typed evaluations in Chat’s place: state in, typed answers out. It is not a conversation: it starts no CLI, checkout, permission flow or tool session, and sends no chat history.', source: 'JEV, through the server’s own key, which never reaches the browser.' },
  'jev.title': { name: 'Workspace title', kind: 'Control', what: 'The name of this builder in the chat list.', when: 'Saves itself as you type.' },
  'jev.back': { name: 'Back to chat', kind: 'Action', what: 'Returns to the chat you were in. The builder stays in the list, saved.' },
  'jev.delete': { name: 'Delete', kind: 'Action', what: 'Deletes this builder and its evaluation history.', when: 'After you confirm with “Sure?”.', unchanged: 'Snippets saved from it.' },
  'jev.views': { name: 'Build or Request JSON', kind: 'Display control', what: 'The same request as fields or as JSON. JSON exposes structured instructions and criteria; invalid JSON stays editable, and says why.', values: [['Build', 'State and Questions side by side, stacked on a narrow pane.'], ['Request JSON', 'The request as it would go, without Memories.']] },
  'jev.example': { name: 'Try an example', kind: 'Action', what: 'Loads a customer-triage example with all three primitives, in this builder if it is empty, otherwise in a new one. Nothing is sent until you Evaluate.' },
  'jev.snippet': { name: 'Load snippet', kind: 'Action', what: 'Lists snippets that hold valid JEV request JSON, and saves this request as one. Saving includes State and Questions, not results or Memories.', values: [['Load as new builder', 'Opens the snippet in a new builder.'], ['Save template', 'Saves under a ; name; manage it in Settings → Snippets.']], unchanged: 'Ordinary text skills, which are not primitive definitions.' },
  'jev.state': { name: 'State', kind: 'Control', what: 'The material to evaluate: plain text, a JSON object or array, or a text file. Each question evaluates the same state, independently.' },
  'jev.file': { name: 'Load text file', kind: 'Action', what: 'Puts a UTF-8 text file into State.', unavailable: () => 'A file over 1 MiB, or one that is not UTF-8 text, is refused with why.' },
  'jev.question': { name: 'Question', kind: 'List item', what: 'One focused question about the state, with the shape of the answer it returns.', does: 'Duplicate reuses a rubric; a finished one folds away.' },
  'jev.primitive': { name: 'Primitive', kind: 'Setting', what: 'The shape of the answer.', values: [['Yes / no · Noul', 'A probability of yes, not a forced boolean. You may define what yes and no mean.'], ['Choose one · Choice', 'A named option and the full distribution, from 2 to 255 options, with optional descriptions.'], ['Rate a scale · Score', 'A score from 2 to 10 ordered levels, which may fall between levels.']] },
  'jev.add': { name: 'Add a primitive', kind: 'Action', what: 'Adds a question of that kind. Types can be mixed in one request, up to 1,024 questions.' },
  'jev.model': { name: 'Model or alias', kind: 'Setting', what: 'jev-latest follows stable releases. Use jev-preview or a versioned ID to choose another release.', unchanged: 'No chat history, tools or agent permissions are sent.' },
  'jev.preview': { name: 'Preview exact request', kind: 'Action', what: 'Shows the request as it would go, with saved Memories appended last to each question. Nothing is sent.' },
  'jev.evaluate': { name: 'Evaluate', kind: 'Action', what: 'Sends this request, once. Shortcut ⌘ or Ctrl + Enter; Enter adds a line.', shows: 'Evaluating primitives…, then the results above the builder. Editing meanwhile affects the next request, not this one.', when: 'Opening the builder or loading the example sends nothing.', unavailable: (el: any) => el.dataset.why || 'Not until the request is complete.' },
  'jev.stop': { name: 'Stop', kind: 'Action', what: 'Stops waiting for this evaluation.', unchanged: 'JEV may already have processed or billed the request; it is not retried.' },
  'jev.save': { name: 'Save state', kind: 'Display', what: 'Whether this builder is saved. It saves itself.', now: (el: any) => `${el.textContent.trim()}.`, values: [['Builder saved', 'Saved in Poise; it survives reloads.'], ['Saving builder…', 'Being written.'], ['Draft saved in this tab', 'Poise could not take it yet. Retry save tries again.']] },
  'jev.recover': { name: 'A draft or run to settle', kind: 'Action', what: 'Nothing is overwritten, or sent again, by itself.', values: [['Reload saved, or Save my version', 'Another tab saved a newer draft; your local version is kept until you choose.'], ['Check pending run, or Retry submission', 'The evaluation was not confirmed. Retrying uses the same request ID, so it cannot run twice.']] },
  'jev.results': { name: 'Results', kind: 'Display', what: 'The chosen run’s typed answers, with its model, duration and tokens. History is a ledger: it is never sent as context.', values: [['Evaluation stopped', 'You stopped it. JEV may already have billed it.'], ['Evaluation interrupted', 'Poise stopped before the result was recorded. It is not replayed.'], ['Evaluation failed', 'Says why. A malformed or incomplete answer counts as a failure, not a result.']] },
  'jev.history': { name: 'Evaluation history', kind: 'Control', what: 'Every run of this builder, newest first, with when, how many questions and how it ended. Earlier runs loads more.' },
  'jev.answer': { name: 'Answer', kind: 'Display', what: 'One typed answer beside its question: the probability of yes, the selected option, or the score, with its distribution. Confidence is how certain the distribution is, not the selected option’s probability.' },
  'jev.copy': { name: 'Copy result JSON', kind: 'Action', what: 'Copies this run’s answers as JSON.', unavailable: () => 'This run has no result.' },
  'jev.edit': { name: 'Edit this run', kind: 'Action', what: 'Opens this run’s original input as a new builder, without Memories, so they are not doubled.' },
  'jev.asstate': { name: 'Use answers as state', kind: 'Action', what: 'Starts a new builder with this run’s answers as its State. No other history is sent.', unavailable: () => 'This run has no result.' },
  'jev.exact': { name: 'Exact request & response', kind: 'Display', what: 'What went to JEV and what came back, as JSON.' },
  'new.manager': { name: 'Open the Manager', kind: 'Action', what: 'Opens the Manager that exists, instead of making a second one.' },
  'sw.timers': { name: 'Timers', kind: 'This chat', what: 'Opens this chat’s timers in the side pane, with the Manager’s wake-up and Hold all.', now: (el: any) => `${el.querySelector('.n')?.textContent || 0} timers.` },
  timers: { name: 'Timers', kind: 'Display', what: 'This chat’s timers: each with its schedule, who set it, the message it sends, when it fires next and its state.', source: 'Poise’s timer store, which survives updates.' },
  timer: { name: 'Timer', kind: 'List item', what: 'One timer: what it does, how often, who set it, and when it fires next.', values: [['Waiting for a time', 'Armed; it fires at the time shown.'], ['Waiting, held', 'Held by you, or by Hold all timers; it keeps its schedule.'], ['Waiting for its chat', 'It says for what: the chat is running, queued, waiting for an answer or permission, resetting or compacting, reopening, or you were just here; or queued tasks; or a model for the Manager; or Poise is updating. It fires once that ends.'], ['Failed', 'It stopped itself after failing several times in a row, and says why. Re-arm starts it again.']] },
  'timer.hold': { name: 'Hold all timers', kind: 'Control', what: 'Holds every timer in the workspace, the Manager’s wake-up included, until you resume them.', unchanged: 'Timers keep their schedules; nothing is cancelled.' },
  'timer.holdchat': { name: 'Hold this chat', kind: 'Control', what: 'Holds this chat: its timers skip their firings, and turns other chats would start in it wait.', when: 'At once. It ends only on Resume.', unchanged: 'Your own messages, which this chat still takes; other chats’ timers.', shows: 'Each timer reads held; new timers start when you resume.' },
  'timer.add': { name: 'A new timer', kind: 'Action', what: 'Schedules a message to this chat: once in some minutes, or every so many minutes.', shows: 'The timer in the list, with when it fires next.', unavailable: () => 'Not until it has a label, a message and a whole number of minutes.' },
  'timer.down': { name: 'Timers are not running', kind: 'Display', what: 'The timer scheduler stopped. Nothing fires until it runs again; Poise restarts it.' },
  'timer.rearm': { name: 'Re-arm', kind: 'Action', what: 'Starts a timer that stopped itself after failing, from now.' },
  'timer.cancel': { name: 'Cancel', kind: 'Action', what: 'Removes this timer.', when: 'After you confirm with “Sure?”.', unavailable: () => 'The Manager’s wake-up has no Cancel: its interval is set in the Manager’s header, and a hold stops it.' },
  'row.from': { name: 'Created by', kind: 'Display', what: 'The chat that created this one, when another chat did: by its name while it exists, and marked deleted once it is gone. A worker’s label says the Manager made it.', source: 'Poise’s record of who created each chat.' },
  'row.worker': { name: 'Worker label', kind: 'Display', what: 'Marks a chat the Manager runs. W3 is the Manager’s third worker today.', does: 'A worker holds a slot from the moment it takes a task until its chat is closed, between turns too, and after its task ends. Only you close a chat.', now: (el: any) => el.textContent.trim() },
  'row.manager': { name: 'The Manager', kind: 'List item', what: 'The Manager’s own chat, pinned first in every order.', does: 'Opens the Manager place: its chat, the work table and the Switchboard. With no Manager yet, it still opens, with the Switchboard and a way to start one. Its chat never uses a slot.' },

  /* ---------- Chat header ---------- */
  'hdr.agent': { name: 'Agent', kind: 'Display', what: 'The agent CLI that runs this chat.', values: [['Claude Code', 'Anthropic’s agent, on your Claude Pro or Max plan.'], ['Codex', 'OpenAI’s coding agent.'], ['Grok Build', 'xAI’s coding agent.'], ['Muse', 'Muse’s coding agent.'], ['Antigravity', 'Listed; not available for chats yet.']], does: 'To continue with another agent, use Hand off.', now: (el: any) => `${el.textContent.trim()}.` },
  'hdr.model': { name: 'Model', kind: 'Control', what: 'The model this chat uses.', now: (el: any) => `${el.textContent.trim()}.`, when: 'From the next turn.', scope: 'This chat.', unavailable: 'Model and effort change between turns. This chat’s turn is active.' },
  'hdr.effort': { name: 'Effort', kind: 'Control', what: 'How much the model thinks before acting.', values: [['low', 'Fast and brief.'], ['medium', 'Balanced.'], ['high', 'The default for most work.'], ['max', 'Slowest and most thorough.']], now: (el: any) => `${el.textContent.trim()}.`, when: 'From the next turn.', scope: 'This chat.', unavailable: 'Model and effort change between turns. This chat’s turn is active.' },
  'hdr.workspace': { name: 'Workspace', kind: 'Display', what: 'Where this chat works: repository, branch and uncommitted changes.', now: (el: any) => el.textContent.replace(/\s+/g, ' ').trim(), values: [['clean', 'Nothing uncommitted.'], ['N files changed', 'Uncommitted changes in the checkout.'], ['off its branch', 'The checkout is on another branch.']], source: 'Git status of this chat’s checkout, refreshed after each step.' },
  'hdr.stop': { name: 'Stop', kind: 'Action', what: 'Ends this chat’s active turn.', scope: 'This chat’s active turn only.', when: 'Immediately, at the agent’s next safe point. Shortcut ⌘.', unchanged: 'Files already changed, queued instructions (they stay queued) and every other chat.', shows: 'The state becomes Idle and the turn’s footer says Stopped.' },
  'hdr.fork': { name: 'Fork', kind: 'Action', what: 'Starts a new chat with this conversation so far.', scope: 'Creates a new chat; this one is unchanged.', when: 'Immediately.', shows: 'The fork opens and appears in the list.', unavailable: 'Fork works between turns. This chat’s turn is active.' },
  'hdr.handoff': { name: 'Hand off…', kind: 'Action', what: 'Continues this work with another agent.', does: 'Starts a new chat for the agent and model you pick, beginning with a labelled summary of this one.', unchanged: 'This chat stays as it is.', shows: 'The new chat opens.' },
  'grp.chat': { name: 'This chat', kind: 'Group', what: 'Settings that belong to this chat and are saved with it.' },
  'grp.show': { name: 'Show', kind: 'Group', what: 'Display preferences: they change what you see, never what the agent does.' },
  'grp.shared': { name: 'Shared', kind: 'Group', what: 'Things every chat and agent shares.' },
  'sw.automerge': { name: 'Auto-merge', kind: 'Setting', what: 'Carries this chat’s pull requests through checks, fixes and a verified merge, saving non-blocking questions for the end.', now: (el: any) => (pressed(el) ? 'On: this chat merges its pull requests when they are green.' : 'Off: merging waits for you.'), values: [['Off', 'Default. You merge.'], ['On', 'The chat merges once checks pass and conversations are resolved.']], scope: 'Pull requests this chat opens, in any repository.', when: 'From its next decision.', unchanged: 'Repository protections, Safe mode and every other chat.' },
  'sw.safemode': { name: 'Safe mode', kind: 'Setting', what: 'The agent uses its own approvals before risky steps.', now: (el: any) => (pressed(el) ? 'On: the agent asks before risky steps.' : 'Off: native tools run with full access.'), values: [['Off', 'Default. Full access, no approval prompts.'], ['On', 'The agent’s risk-based approvals.']], scope: 'This chat, its forks and its handoffs.', when: 'Claude Code and Muse: now. Codex and Grok Build: from the next turn.', unchanged: 'There is no sandbox either way; merge authority is unchanged.' },
  'sw.activity': { name: 'Activity', kind: 'Display preference', what: 'Shows each turn’s tool steps, plans and resolved requests.', now: (el: any) => (pressed(el) ? 'Showing tool and plan detail.' : 'Hiding tool and plan detail.'), scope: 'Every chat, in this browser.', when: 'Immediately.', unchanged: 'History. Messages, errors and anything that needs you always show.' },
  'sw.tools': { name: 'Tools', kind: 'Display preference', what: 'Shows each tool call and command block in the conversation.', now: (el: any) => (pressed(el) ? 'Showing tool calls.' : 'Hiding tool calls.'), values: [['On', 'Default.'], ['Off', 'The conversation shows its messages only.']], scope: 'Every chat, in this browser.', when: 'Immediately.', unchanged: 'History. Messages, errors and anything that needs you always show.' },
  'sw.reasoning': { name: 'Reasoning', kind: 'Display preference', what: 'Shows the model’s own reasoning where the provider supplies it.', now: (el: any) => (pressed(el) ? 'Showing reasoning.' : 'Hiding reasoning.'), scope: 'Every chat, in this browser.', when: 'Immediately.', unchanged: 'Tools, effort and prompts.' },
  'sw.memories': { name: 'Memories', kind: 'Shared', what: 'Opens the shared text every agent reads, last in every message.', now: (el: any) => (pressed(el) ? 'The Memories pane is open.' : 'The Memories pane is closed; Memories still apply.'), scope: 'Every chat and every agent.', when: 'From the next message.' },

  /* ---------- Situation ---------- */
  sit: { name: 'Situation', kind: 'Display', what: 'What this chat is doing, intends, and is waiting for, with how fresh that is.', source: 'The agent’s event stream. Observed, intended and estimated are always marked apart.' },
  'sit.now': { name: 'Now · observed', kind: 'Display', what: 'What the agent last reported doing. Solid text means observed.', now: (el: any) => el.querySelector('.obs')?.textContent || '', source: 'The agent’s latest event.' },
  'sit.next': { name: 'Next · intended', kind: 'Display', what: 'What the agent says it will do next. A dashed underline means intended: it has not happened and may change.', now: (el: any) => el.querySelector('.int')?.textContent || '' },
  'sit.waiting': { name: 'Waiting for', kind: 'Display', what: 'What this chat is waiting on, if anything.', now: (el: any) => el.querySelector('b, .obs')?.textContent || el.textContent.trim() },
  'sit.decision': { name: 'Decision', kind: 'Display', what: 'Whether you are needed to continue.', now: (el: any) => el.textContent.replace(/\s+/g, ' ').trim() },
  'sit.fresh': { name: 'As of', kind: 'Display', what: 'How old the observed information is.', now: (el: any) => el.textContent.trim(), source: 'Time since the last event from the agent.' },
  'sit.est': { name: 'Estimate', kind: 'Display', what: '≈ marks an estimate from similar runs. It is not observed and not a promise.', now: (el: any) => el.textContent.trim(), unavailable: () => 'Poise estimates behavior runs only. A chat turn, and the Manager’s work, show no estimate until there is data for one.' },

  /* ---------- Transcript ---------- */
  'msg.you': { name: 'Your instruction', kind: 'Message', what: 'An instruction you sent, with how far it has got.', source: 'Saved by Poise when you send it.' },
  'msg.steer': { name: 'Steer', kind: 'Message', what: 'An instruction you sent during an active turn. The agent receives it at its next step.' },
  'msg.extension': { name: 'A server this chat did not get', kind: 'Message', what: 'Poise’s line when a server switched on for this workspace is not delivered to this chat, and why: it needs a sign-in, a secret is missing, the agent cannot take its transport, or the agent could not connect.', when: 'Once per change, before the turn it affects.', source: 'Poise, from Settings → Extensions; the server’s Activity records it too.' },
  'msg.src': { name: 'Source', kind: 'Display', what: 'Who sent this message or steer when it was not you: another chat, the Manager, or Poise itself, such as its work monitor. A chat’s name opens it; a deleted one is marked deleted. A turn another chat stopped says Stopped by, the same way.' },
  tool: { name: 'Tool step', kind: 'Activity', what: 'One thing the agent did: read files, ran a command, edited a file.', does: 'Opens to show its input and output.', source: 'The agent’s tool events.' },
  'tool.elapsed': { name: 'Elapsed', kind: 'Display', what: 'How long this step took, or has taken so far.', source: 'Measured by Poise from the step’s start and end events.' },
  diff: { name: 'Change', kind: 'Activity', what: 'A file the agent edited: removed lines in red, added lines in green.', source: 'The agent’s edit event and the file in this chat’s checkout.' },
  'diff.revert': { name: 'Revert', kind: 'Action', what: 'Restores this file to how it was before this change.', scope: 'This file’s change only.', when: 'Immediately.', unchanged: 'Other files and commits already pushed.', shows: 'The card says Reverted.' },
  plan: { name: 'Plan', kind: 'Activity', what: 'The agent’s plan for this turn, as it last reported it.', values: [['Filled', 'Done.'], ['Ringed', 'In progress.'], ['Hollow', 'Not started.']] },
  perm: { name: 'Permission', kind: 'Needs you', what: 'The agent asks before a step that needs your consent.', values: [['Allow once', 'This step only.'], ['Always allow in this session', 'Steps like this in this chat, until it ends.'], ['Deny', 'The agent continues without it.']], when: 'As soon as you choose. Keys 1–3 work too.' },
  question: { name: 'Question', kind: 'Request', what: 'The agent asks for an answer. The Manager can answer a worker with known task data or bring the question to you.', does: 'Pick an option or answer in your own words.' },
  'answered.who': { name: 'Who answered', kind: 'Action', what: 'Opens the chat that answered, with a route back. A chat since deleted is named, marked deleted, and opens nothing.' },
  answered: { name: 'Answered by the Manager', kind: 'Display', what: 'The Manager answered this under your Autonomy setting. The answer is recorded here.', source: 'The Manager’s record.' },
  'answered.why': { name: 'Why the Manager answered', kind: 'Display', what: 'The rule that let the Manager answer without you: your Autonomy setting and the standing instruction it applied.', now: (el: any) => el.textContent.trim(), does: 'To have questions like this come to you, lower Autonomy or change the standing instruction.' },
  thought: { name: 'Thinking', kind: 'Activity', what: 'Reasoning the provider shared. Shown only while Reasoning is on.' },
  foot: { name: 'Turn summary', kind: 'Display', what: 'When the turn finished, how long it took and the tokens it used.', source: 'Poise’s record of the turn.' },
  copy: { name: 'Copy', kind: 'Action', what: 'Copies this reply’s text.', shows: 'The label says Copied.' },
  file: { name: 'File link', kind: 'Action', what: 'Opens a read-only preview of this file at this line, from the current working copy.', values: [['First 5,000 lines', 'A longer file shows its start.'], ['Cannot preview this file', 'Says why, and the link stays.']], unchanged: 'The file.' },
  deploy: { name: 'Poise change', kind: 'Display', what: 'Poise implementing a change to itself, followed through to Live.', values: [['Implement', 'An agent writes it in its own checkout.'], ['Checks', 'The full local suite.'], ['CI', 'GitHub Actions on the exact head.'], ['Merge', 'By the release controller, not the agent.'], ['Verify', 'The release is activated and checked.'], ['Live', 'Your tab refreshes safely.']], source: 'The release controller.' },

  /* ---------- Dock ---------- */
  queue: { name: 'Queue', kind: 'Display', values: [['One at a time, after this turn', 'The chat is running, or ready to take the next.'], ['Waiting for the next completed task', 'Added with /queue while nothing runs; it waits for the next task to finish.'], ['Waiting for the Poise release', 'The chat is releasing a Poise change; the queue goes on after it.']], what: 'Instructions waiting to run in this chat, one at a time.', does: 'They start after the current turn. Waiting instructions never use a slot.', now: (el: any) => el.querySelector('.count')?.textContent ? `${el.querySelector('.count').textContent} waiting.` : '' },
  'queue.model': { name: 'Agent and model', kind: 'Control', what: 'Who runs this queued instruction when its turn comes.', when: 'When it starts.' },
  'queue.resume': { name: 'Resume queue', kind: 'Action', what: 'Starts the next queued instruction.', does: 'After you stop a turn, the queue waits for you instead of starting on its own.', when: 'Immediately.', shows: 'The first queued instruction moves into the conversation as Executing.' },
  'queue.remove': { name: 'Remove from queue', kind: 'Action', what: 'Takes this instruction out of the queue.', scope: 'This queued instruction only.', when: 'Immediately.', unchanged: 'The active turn and the rest of the queue.' },
  composer: { name: 'Message', kind: 'Control', what: 'Where you write to this chat.', does: 'Idle: Enter starts a turn. Running: Enter steers the active turn. / lists commands; Up recalls your last ten messages.', when: 'On Enter.', values: [['Being created', 'Typing carries over; a further Send waits until the chat exists.'], ['Closed', 'This chat is closed. It takes no more turns.'], ['Failed or Interrupted', 'Resume starts it again, or /reset starts it fresh; until then it takes only /reset and /create.'], ['The Switchboard’s chat', 'Poise runs this chat for the Switchboard pane. It takes no messages; answer here only what it asks you.'], ['Its model was retired', 'On the Manager: choose another model to continue.']] },
  'composer.resume': { name: 'Resume', kind: 'Action', what: 'Starts a failed or interrupted chat again from where it stopped.', shows: 'A new turn, with its progress.', unchanged: 'Its conversation and its queue.' },
  'composer.attach': { name: 'Attach file', kind: 'Action', what: 'Adds files to your next message.' },
  'composer.send': { name: 'Send', kind: 'Action', what: 'Sends your message. Shortcut Enter.', shows: 'Your message appears with its progress: accepted, queued, executing, completed.', unavailable: (el: any) => el.dataset.why || 'Nothing to send yet.' },
  'composer.model': { name: 'Model for this chat', kind: 'Control', what: 'The agent, model and effort the new chat starts with.', when: 'On your first send.' },
  'set.style': { name: 'Style panel', kind: 'Settings', what: 'Every visual choice in Poise: type, scale, shape, motion and the meaning colours.', does: 'Opens the Style panel. Changes apply at once, everywhere, and are kept in this browser.', source: 'Poise’s design tokens, with your choices kept in this browser.' },
  'set.manager': { name: 'Manager’s controls', kind: 'Settings', what: 'Rhythm, Stability ↔ Expansion, Autonomy, scope and standing instructions.', does: 'Opens Settings → Manager, where they live.' },
  /* Fields shared by every place that opens an issue */
  'composer.repo': { name: 'Repository', kind: 'Control', what: 'Links a card to a repository, or picks where a new issue opens.', values: [['No repository', 'Cards only: not linked.'], ['owner/name', 'Any repository in your organizations.']] },
  'composer.title': { name: 'Issue title', kind: 'Control', what: 'The new issue’s title. Required.' },
  'composer.body': { name: 'Issue body', kind: 'Control', what: 'What should happen, in plain words. Optional.' },
  mem: { name: 'Memories', kind: 'Shared', what: 'Text every agent reads, last in every message.', scope: 'Every chat and every agent.', when: 'From the next message.', unchanged: 'Chat histories.', source: 'Saved automatically.' },
  back: { name: 'Back', kind: 'Action', what: 'Returns to where you were, with its selection and scroll position.', now: (el: any) => el.textContent.trim() }
};

// State values are listed from the same words.
SHARED.state.values = Object.keys(STATE_WORDS).map((k): [string, string] => [STATE_WORDS[k], SHARED['state.' + k].what ?? '']);

// Style: the same choices in Settings → Style and in the Style panel over any
// view, so they live in the registry every page reads.
(() => {
  const nowStyle = (el: any) => el.closest('[data-setting]')?.dataset.now || el.closest('.field')?.querySelector('output')?.textContent || '';
  const itemNow = (el: any) => el.closest('[data-item]')?.dataset.now || '';
  const nowOf = nowStyle;
  const style = (name: any, what: any, extra: any = {}) => ({ name, kind: 'Setting', what, now: nowOf, scope: 'Every view, in this browser.', when: 'Applies now; dragging shows it before you let go.', source: 'Kept in this browser, with the Style panel’s choices.', ...extra });
  Object.assign(SHARED, {
    'set.style.preset': { name: 'Preset', kind: 'Action', what: 'A starting point for size and density.', values: [['Calm', 'Poise’s own.'], ['Compact', 'More rows on screen.'], ['Comfortable', 'More air.'], ['Large type', 'For long days.']], shows: 'Base size and Density change on their own rows, each with Undo; this row says which preset is in use.', unchanged: 'Typeface, colours and the writing rows.' },
    'set.style.type': style('Typeface', 'The faces for the interface, for headings and display, and for code, chosen to belong together.', { values: [['Engineer', 'Plex, with Zen Maru for display. Poise’s own.'], ['Minimalist', 'Manrope and Space Grotesk.'], ['Companion', 'Nunito and Rubik.'], ['Editor', 'Lato and Playfair Display.'], ['Writer', 'Lora throughout.'], ['Auteur', 'Work Sans and Syne.']] }),
    'set.style.size': style('Base size', 'The size every type and control size derives from, including rows and tables.', { values: [['13–18 px', 'Poise’s own is 15 px.']] }),
    'set.style.leading': style('Line height', 'The space between lines of reading and body text.', { unchanged: 'Interface labels, which keep their own.' }),
    'set.style.density': style('Density', 'Space inside and between things: rows, cards and controls.', { values: [['0.75–1.35×', 'Poise’s own is 1×.']] }),
    'set.style.corners': style('Corners', 'How round every card, field and panel is.', { values: [['Square', '0×.'], ['1×', 'Poise’s own.'], ['2×', 'Round.']] }),
    'set.style.lines': style('Route lines', 'The weight of routes and their stations.', { scope: 'Board, Chat and the Manager, in this browser.' }),
    'set.style.motion': style('Motion', 'The Tactile spring when things open, settle and reorder.', { values: [['On', 'Poise’s own.'], ['Off', 'Everything is still; nothing waits on an animation.']] }),
    'set.style.measure': style('Reading width', 'How wide a page of text runs.', { scope: 'Editor and Settings, in this browser. The other views fill the window.' }),
    'set.style.heading': style('Heading size', 'The size of a document’s headings, and the space around them.', { scope: 'Documents in Editor, in this browser.' }),
    'set.style.paragraph': style('Paragraph spacing', 'Extra space after each paragraph, in lines.', { scope: 'Documents in Editor, in this browser.', values: [['None', 'Poise’s own: the empty line you type is the gap.'], ['¼ to 1 line', 'More air between paragraphs.'], ['Tighter by ¼ line', 'Paragraphs closer than the empty line alone.']] }),
    'set.style.tints': style('Status tints', 'How strongly a state colours its chip and its background.', { values: [['10–35%', 'Poise’s own is 22%.']] }),
    'set.style.colours': style('Meaning colours', 'One colour per state word, then information and Poise acting on its own. Idle has no colour: it is hollow.', { shows: 'Chips, routes and tints follow at once, in every view.' }),
    'set.style.neutrals': style('Neutrals', 'The dark stack every surface and text is made from.', { unchanged: 'Contrast checks are yours to keep: these colours carry it.' }),
    'set.style.colour.row': { name: 'Colour', kind: 'Display', what: 'One colour, and whether it is Poise’s own.', now: itemNow },
    'set.style.colour': { name: 'Colour', kind: 'Control', what: 'Choose this colour.', when: 'The page shows it as you choose; letting go saves it, with Undo.' },
    'set.style.copy': { name: 'Copy as CSS', kind: 'Action', what: 'Copies your changes as CSS custom properties.', shows: 'The row says how many were copied.' },
    'set.style.reset': { name: 'Reset everything', kind: 'Action', what: 'Returns every Style row to Poise’s own, at once.', when: 'After you confirm with “Sure?”; Undo stays for eight seconds.', unchanged: 'Everything outside Style.' },
    'set.go': {
      name: 'Settings section', kind: 'Place', what: 'Opens this section of Settings.',
      now: (el: any) => { const n = Number(el.dataset.changed || 0); return `${el.querySelector('.t')?.textContent || ''}${n ? `: ${n} changed from the default` : ''}${el.getAttribute('aria-current') === 'page' ? '; open now' : ''}.`; },
      unchanged: 'Where you came from: the route back stays at the top of the section.'
    },
    'style.close': { name: 'Close', kind: 'Action', what: 'Closes the Style panel. Your choices stay as they are.' },
    'style.settings': { name: 'Settings → Style', kind: 'Action', what: 'Opens Settings → Style: the same choices, with the writing ones, and a route back here.' }
  });
})();

// Tasks: an issue on its way to a merged pull request. Board, the Manager,
// Observe and Overview all show them, so their words live here.
Object.assign(SHARED, {
  'task.rail': { name: 'Phase rail', kind: 'Display', what: 'The task’s seven phases: Intake, Issue review, Implementation, PR review, Repair, Approval and Merge. Past phases are a quiet fill, the current one takes its state’s colour, and the ones ahead are hollow.', now: (el: any) => el.dataset.phase || '', does: 'Repair returns to PR review, so the rail counts rounds. A chain has no review cap: a blocker stays one until it is repaired, or held.', source: 'The chain’s journal. Work the chain does not carry takes its phase from its current blocker, with no rounds.' },
  'task.open': { name: 'Open in Observe', kind: 'Action', what: 'Opens the task in Observe → Tasks: its timeline, each run with its model, slot and evidence, with a route back here.' },
  'task.hold': { name: 'Hold new invocations', kind: 'Action', what: 'Stops the chain from starting its next step.', unchanged: 'A run already going, which carries on; stop it in Observe → Behaviors.', shows: 'Resume in its place, and a Hold in the timeline.', unavailable: () => 'A merged task has nothing to hold: only its history remains.' },
  'task.resume': { name: 'Resume', kind: 'Action', what: 'Ends the hold, so the chain takes its next step: after a queue removal by hand, it goes back into the merge queue. Clear a reported blocker or a breached ceiling first: Resume never raises a limit.', unchanged: 'Its journal, which records the resume with its time.', unavailable: () => 'A merged task has no Resume: only its history remains.' },
  'side.hold': { name: 'Why it is held', kind: 'Display', what: 'The hold’s reason, in the chain’s words, and what Resume does.', values: [['A queue removal by hand', 'Someone took it out of the merge queue, or Poise cannot tell why it left. A failed check or a conflict in the queue is not a hold: it goes to a fresh repair.'], ['A reported blocker', 'Implementation or repair said what stops it. Nothing restarts by itself.'], ['Over its memory or disk ceiling', 'The run was stopped as soon as it measured over, or after five seconds without a full measurement; other runs carry on.'], ['You stopped a run', 'It holds until you Resume, even if nothing was written.'], ['Cleanup not proven', 'Its memory and disk stay reserved: a restart cannot prove they were released.']] },
  'side.timeline': { name: 'Timeline', kind: 'Display', what: 'Every step of the task with its time, newest first: runs with their model and slot, events, holds, and what could not be confirmed.', does: 'Held still while you read it; new steps wait until you look away.', source: 'The chain’s journal, which never changes once written.' }
});

// The Manager's controls: Overview's Manager card and Settings → Manager draw them both.
Object.assign(SHARED, {
  'mgr.effective': { name: 'In effect', kind: 'Display', what: 'Your Manager controls read together, with what they govern.', now: (el: any) => (el.querySelector('.sentence') ?? el).textContent.replace(/\s+/g, ' ').trim(), scope: 'Work the Manager runs in this workspace.', source: 'The same settings, live.' },
  'mgr.rhythm': {
    name: 'Rhythm', kind: 'Manager control', what: 'How many workers the Manager keeps on tasks at once: 1 to 10 slots.',
    does: 'Each worker holds a slot from the moment it takes a task until its chat is closed. A free slot gets the Manager’s next ticket, as a new worker, on its next turn.',
    now: (el: any) => { const r = el.closest('.omgr')?.querySelector('[data-rhythm]'); if (!r) return ''; const { limit, used } = r.dataset; return used === undefined ? `${limit} slots.` : `${limit} slots; ${used} held by workers.` },
    values: [['1', 'One task at a time: slow and easy to follow.'], ['5', 'Default.'], ['10', 'The most parallel work Poise allows; more to watch.']],
    scope: 'Workers the Manager runs in this workspace.',
    when: 'From the Manager’s next turn, which carries it. Lowering it below current use lets each worker finish its task, and starts nothing new until use is below the limit.',
    unchanged: 'Running at once, chats you run yourself, Stability ↔ Expansion and Autonomy.',
    source: 'The same setting as Settings → Manager → Rhythm.',
  },
  'mgr.paused': {
    name: 'Pause new work', kind: 'Manager control', what: 'Tells the Manager that new work waits until you resume. It still wakes, watches and answers; it gives out no new ticket.',
    now: (el: any) => ((el.closest('[aria-pressed]') ?? el).getAttribute('aria-pressed') === 'true' ? 'Paused: new work waits until you resume.' : 'Not paused.'),
    when: 'From the Manager’s next turn.', unchanged: 'Workers already on tasks, which finish them; wake-ups; Hold, which is separate.',
    source: 'The paused flag in the Manager controls, the same setting as Settings → Manager.',
  }
});
