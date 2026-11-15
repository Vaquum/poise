// Settings' vocabulary (#556), from the mocks' refdefs-settings.js: one entry
// per element, read by the tooltip, the full reference and the words on
// screen. A setting's row keeps its current value, in words, in data-now; a
// list item keeps its own. Mock-only wording that names what the live app
// does not do is left to the mocks.
import { register, type Registry } from '../../registry'

const nowOf = (el: HTMLElement): string => el.closest<HTMLElement>('[data-setting]')?.dataset.now || ''
const itemNow = (el: HTMLElement): string => el.closest<HTMLElement>('[data-item]')?.dataset.now || ''
const why = (fallback: string) => (el: HTMLElement): string => el.dataset.why || fallback

export const SETTINGS: Registry = {
  /* ---------- The new interface's own (#556) ---------- */
  'set.production': { name: 'Production updates', kind: 'Display', what: 'How this install takes new releases: from main by itself, and when it last updated or failed to.', now: (el: HTMLElement) => (el.textContent ?? '').trim(), source: 'The running install’s updater, through /api/health.' },
  'set.mgr.charter.edit': { name: 'Edit in Snippets', kind: 'Action', what: 'Opens Settings → Snippets, where /manager is edited like any snippet.' },
  'set.mine': { name: 'Save mine', kind: 'Action', what: 'Saves your value over the one another tab or Poise saved meanwhile.', unchanged: 'Every other setting, which keeps what was saved.' },
  'set.theirs': { name: 'Use theirs', kind: 'Action', what: 'Drops your change and shows what is saved now.' },
  'set.models.place': { name: 'Slot', kind: 'Setting', what: 'Which of the three models this place runs: Primary, Secondary or Tertiary, or Random, which draws one of the three on each run.', now: nowOf, values: [['Primary, Secondary, Tertiary', 'This place runs that slot’s model; a model that fails before its verdict hands the run to a slot not tried yet.'], ['Random', 'One of the three, drawn on each run.']], when: 'From this place’s next run.', source: 'Kept in Poise’s settings, one pick per place.' },
  'mgr.stability': { name: 'Stability ↔ Expansion', kind: 'Manager control', what: 'How the Manager handles a new Poise release: keep this Poise on its version, ask you, or install releases by itself.', now: nowOf, scope: 'This Poise’s own version, and what the Manager does when a release appears.', when: 'From the Manager’s next turn, which carries the words you chose, with the policy version.', unchanged: 'Rhythm and Autonomy, and Production updates in General, which are separate.' },
  'mgr.autonomy': { name: 'Autonomy', kind: 'Manager control', what: 'What the Manager decides on its own, and what it brings to you.', now: nowOf, scope: 'Decisions in work the Manager runs, and in its workers’ turns.', when: 'From the Manager’s next turn. Questions already brought to you stay open.', unchanged: 'Rhythm and Stability ↔ Expansion, which are separate.' },
  'mgr.wake': { name: 'Wake every', kind: 'Manager control', what: 'How often Poise wakes the Manager to review the workspace: every 60, 30, 15, 10 or 5 minutes.', now: nowOf, values: [['60 min', 'Default: up to 24 turns a day.'], ['30 min', 'Up to 48 turns a day.'], ['15 min', 'Up to 96.'], ['10 min', 'Up to 144.'], ['5 min', 'Up to 288.']], does: 'Each wake-up is one Manager turn with its controls and /manager text. A wake-up due while the Manager is busy waits, and says for what.', when: 'At once, keeping a wake-up already due.', unchanged: 'Your timers, and Rhythm.' },
  'mgr.scope': { name: 'Repositories', kind: 'Manager control', what: 'The repositories the Manager may bind work in: every followed repository, or the ones you choose. With none, it binds nothing.', now: nowOf, when: 'From the Manager’s next turn.', unchanged: 'Work already running elsewhere, which finishes.' },
  'set.beh.see': { name: 'See it in Observe', kind: 'Action', what: 'Opens the behavior’s last run in Observe: its run in Behaviors, or its diagnostic in Logging, with a route back here.' },
    /* ---------- The place ---------- */
    'set.find': {
      name: 'Find a setting', kind: 'Control', what: 'Searches every section by a setting’s name, its explanation or its value.',
      does: 'Enter opens the first match and lights its row; Esc clears. / brings you here from anywhere on the page.',
      unchanged: 'Your settings. Finding never changes one.'
    },
    'set.changed': {
      name: 'Changed', kind: 'Display', what: 'How many settings in this section differ from their defaults.',
      now: (el: HTMLElement) => `${parseInt(el.textContent ?? '', 10)} changed from the default.`, does: 'Each changed row says what its default is, with Reset.'
    },
    'set.head': {
      name: 'Section', kind: 'Display', what: 'What this section holds.',
      now: (el: HTMLElement) => el.querySelector('p')?.textContent || ''
    },

    /* ---------- The row pattern ---------- */
    'set.scope': {
      name: 'This browser', kind: 'Scope', what: 'This setting is kept in this browser only.',
      scope: 'Only this browser. Another browser or computer keeps its own choice.', unchanged: 'Settings without this mark, which Poise keeps for every browser.'
    },
    'set.status': {
      name: 'Saved state', kind: 'Display', what: 'Whether this setting is its default, and what happened to your last change.',
      now: (el: HTMLElement) => (el.textContent ?? '').replace(/\s+/g, ' ').trim() + '.',
      values: [
        ['Default', 'Poise’s default; you have not changed it.'],
        ['Changed · Reset', 'You changed it. Reset puts the default back and saves it.'],
        ['Saving…', 'Poise is saving your change.'],
        ['Saved · when', 'Saved, with when it takes effect. Undo puts back what it was, for eight seconds.'],
        ['Not saved', 'The value in the field is not valid, so the saved one still applies. Esc puts it back in the field.']
      ]
    },
    'set.reset': { name: 'Reset', kind: 'Action', what: 'Puts this setting back to its default, and saves it.', shows: 'Saving…, then Saved with when it applies, and Undo.', unavailable: 'Nothing to reset: the setting is at its default.' },
    'set.undo': { name: 'Undo', kind: 'Action', what: 'Puts back the value this setting had before your last change, and saves it.', when: 'For eight seconds after a save. After that, Reset puts back the default.' },

    /* ---------- General: GitHub ---------- */
    'set.me': {
      name: 'Your GitHub account', kind: 'Setting', what: 'Who you are on GitHub. Board and Observe show the issues and pull requests you are involved in.',
      now: nowOf, values: [['A GitHub login', 'Letters, digits and single hyphens, up to 39 characters. Not a URL or an email.']],
      scope: 'Everywhere: every view, in every browser.', when: 'From the next refresh of Board and Observe.',
      unchanged: 'Your sign-in. Connect the account under Accounts so Poise can act as you.', source: 'Kept in Poise’s settings.'
    },
    'set.agent': {
      name: 'Automation account', kind: 'Setting', what: 'The GitHub account that posts automated reviews and comments.',
      does: 'Poise invites it to every repository in your organizations once a minute, and accepts the invitation for it, so reviews never silently fail to start.',
      now: nowOf, values: [['A GitHub login', 'Connect it under Accounts so it can post.']],
      scope: 'Everywhere.', when: 'From the next automated review or comment.', unchanged: 'Reviews and comments already posted.'
    },
    'set.following': {
      name: 'Following', kind: 'Setting', what: 'Organizations and people whose repositories Poise indexes for Board, Observe and the Manager.',
      now: nowOf,
      values: [['Ready', 'Indexed, and kept in sync on the shared tick.'], ['Running', 'Activating: checking access, indexing repositories, preparing your issues and pull requests.'], ['Waiting', 'GitHub’s API limit was reached, or a sync failed on GitHub’s side: Poise retries on its own, and Retry tries now.'], ['Failed', 'Activation failed: the error says why, and Retry tries again.']],
      scope: 'Everywhere.', when: 'Following starts at once; the first index can take a few minutes.', unchanged: 'Anything on GitHub: following only reads.', source: 'GitHub, through Poise’s index.'
    },
    'set.follow.input': { name: 'Account to follow', kind: 'Control', what: 'An organization name or a personal GitHub username, not a URL.', does: 'Enter follows it.' },
    'set.follow.add': {
      name: 'Follow', kind: 'Action', what: 'Starts following this organization or person.',
      does: 'Poise checks access, indexes the repositories and prepares your issues and pull requests.',
      shows: 'A new row, Running with each stage, then Ready.', when: 'At once. The first index can take a few minutes.', unchanged: 'Nothing on GitHub.'
    },
    'set.follow.row': {
      name: 'Followed account', kind: 'Display', what: 'An organization or person Poise follows, and where its index stands.',
      now: (el: HTMLElement) => el.closest<HTMLElement>('[data-item]')?.dataset.now || ''
    },
    'set.follow.retry': { name: 'Retry', kind: 'Action', what: 'Syncs this account again now, as main’s Retry does after Sync failed or Activation failed.', shows: 'Running with the stage it retries, then Ready, or the new error.', unchanged: 'Poise’s own retries, which carry on either way.' },
    'set.follow.stop': {
      name: 'Stop following', kind: 'Action', what: 'Stops indexing this account. Its issues and pull requests leave Board and Observe.',
      when: 'After you confirm with “Sure?” within three seconds.', unchanged: 'Everything on GitHub, and your own cards in Board.',
      shows: 'The row leaves, with Undo for eight seconds.'
    },

    /* ---------- General: Time ---------- */
    'set.timezone': {
      name: 'Time zone', kind: 'Setting', what: 'Where days and weeks begin in Overview, Board and Observe.',
      now: nowOf, values: [['Any time zone', 'Default: this browser’s zone.']],
      scope: 'Everywhere.', when: 'Applies now: Today, Yesterday and This week move to the new boundaries.', unchanged: 'When anything happened; only how it is grouped.'
    },
    'set.refresh': {
      name: 'Refresh rate', kind: 'Setting', what: 'How often Overview, Board and Observe read fresh data.',
      now: nowOf, values: [['1 min', 'Default.'], ['5 min', 'Lighter on GitHub’s limits; live states change less often.']],
      scope: 'This browser.', when: 'Applies now.', unchanged: 'Other browsers and computers.'
    },

    /* ---------- General: Notifications ---------- */
    'set.notifications': {
      name: 'Notifications', kind: 'Setting', what: 'Alerts for sign-ins, failed behaviors, open requests and GitHub status.',
      does: 'A pull request ready to merge reminds you every 15 minutes until it is merged or silenced.',
      now: nowOf, values: [['On', 'Default.'], ['Off', 'Stops notices and the check of pull requests at once. Answer here keeps Behaviors’ activity and your chats’ requests, and says that this is off.']],
      scope: 'Everywhere: kept by the server, which runs the checks whether or not a page is open.', when: 'Applies now, in every browser.', unchanged: 'Behaviors’ diagnostics, and Poise Link’s other alerts.'
    },

    /* ---------- General: Chats ---------- */
    'set.branch': {
      name: 'Branch prefix', kind: 'Setting', what: 'Starts the name of the branch each new chat creates.',
      now: nowOf, values: [['A git ref fragment', 'Letters, digits, dot, underscore, slash and hyphen; no leading slash and no “..”. Default chat/.']],
      scope: 'Everywhere.', when: 'From the next chat.', unchanged: 'Branches that already exist keep their names.',
      shows: 'The row shows the next branch’s name as you type.'
    },
    'set.idle': {
      name: 'Idle timeout', kind: 'Setting', what: 'Closes an idle agent process after this many minutes. The chat resumes when you send another message.',
      now: nowOf, values: [['Whole minutes', 'Default 120.'], ['0', 'Never: the process stays open until the chat is deleted.']],
      scope: 'Everywhere.', when: 'Applies now, to every Idle chat.', unchanged: 'Chats with a turn running, and every conversation: nothing is lost when a process closes.'
    },
    'set.running': {
      name: 'Running at once', kind: 'Setting', what: 'How many agent turns may run at the same time, chats and behavior runs together.',
      does: 'From 2, one is always left for the turns you send. From 3, workers’ turns also leave one for behavior runs, so the reviews and approvals that finish a worker’s pull request can always start. Past the limit, a turn or run shows Waiting, saying for what, and starts when another finishes.',
      now: nowOf, values: [['1 to 64', 'Default 4. This workspace runs 10, so the workers’ turns, a turn of yours and the behaviors’ runs fit together.']],
      scope: 'Every local chat and behavior run.', when: 'Applies now. Turns already running finish; a lower limit holds only new ones.',
      unchanged: 'The Manager’s Rhythm, which sets how many workers it runs; the Manager’s own chat and the Switchboard, which never wait here; and the chain’s capacity, under Behaviors.'
    },
    'set.updatewait': {
      name: 'Update wait', kind: 'Setting', what: 'How long running turns may hold up a Poise update.',
      does: 'When an update is ready, new turns wait for it and running turns get this long to finish. Past it, they are interrupted and resume after the update.',
      now: nowOf, values: [['Whole minutes, 1 to 10080', 'Default 15. 10080 is a week.']],
      scope: 'Every local chat.', when: 'From the next update.', unchanged: 'A chat you stopped: it stays stopped.',
      shows: 'A chat held for an update shows Waiting, waiting for the Poise update.'
    },

    /* ---------- General: Appearance and setup ---------- */
    'set.storage': {
      name: 'Storage', kind: 'Display', what: 'This workspace’s disk: how much is free, what fills it, and the maintenance that clears what nothing owns.', now: nowOf,
      values: [['Measured', 'Every category was read, at the time shown.'], ['Some categories could not be measured', 'Those read unavailable, never zero; Retry reads again.'], ['Showing the last reading', 'A fresh reading failed; the last one shows with its age and the error, and Retry.'], ['Could not be read', 'Nothing could be measured; Retry.']],
      unchanged: 'Shared sign-ins, provider history, checkout gates and your files, which maintenance never removes.', source: 'A bounded scan of the workspace, at most once a minute.'
    },
    'set.storage.retry': { name: 'Retry', kind: 'Action', what: 'Reads storage again now.', shows: 'Running, then the new reading with its time.' },
    'set.storage.run': { name: 'Run maintenance now', kind: 'Action', what: 'Clears what nothing owns: finished checkouts, expired caches and old logs.', unchanged: 'Anything a running chat or behavior still owns, which is held and named.', shows: 'Running, then what it reclaimed and what it held.', unavailable: (el: HTMLElement) => el.dataset.why || 'Maintenance is running.' },
    'set.storage.dry': { name: 'Dry run', kind: 'Action', what: 'Says what maintenance would clear, and clears nothing.', unavailable: (el: HTMLElement) => el.dataset.why || 'Maintenance is running.' },
    'set.setup': {
      name: 'Run setup again', kind: 'Action', what: 'Walks through setup from its first step, with your current choices prefilled.',
      does: 'Opens setup over Poise. Finish later, or Open Poise at its end, brings you back here.'
    },
    /* ---------- Accounts ---------- */
    'set.agents': { name: 'Agent sign-ins', kind: 'Setting', what: 'Each agent CLI and whether it is signed in. Chats, reviews and behaviors run on these sign-ins.', now: nowOf, source: 'Each CLI’s own status command, checked when you open this section.' },
    'set.agent.row': {
      name: 'Agent', kind: 'Display', what: 'One agent CLI: the command it signs in with, its version, and what its status command says.', now: itemNow,
      values: [['Signed in as …', 'Ready to run.'], ['Signed in here', 'Signed in through Poise; the CLI cannot confirm it.'], ['Not signed in', 'Connect to run work on it.'], ['Not installed', 'Not on this workspace.'], ['Running', 'A sign-in terminal is waiting for you.']]
    },
    'set.agent.connect': {
      name: 'Connect', kind: 'Action', what: 'Opens a terminal under this agent that runs its sign-in command.', does: 'Finish in the browser it opens; the terminal says when you are signed in.',
      shows: 'Running while it waits for you, then Signed in as …', unchanged: 'Chats already running keep their sign-in until their next turn.', unavailable: why('A sign-in terminal is open; finish or close it first.')
    },
    'set.agent.cred': {
      name: 'Credential', kind: 'Display', what: 'Which credential Muse’s auth file holds: an API key, or the account login with its subscription quota.',
      values: [['API key', 'Turns are billed to the key.'], ['Account login (device code)', 'Turns use the account’s subscription quota. A turn that fails on that quota says so.']]
    },
    'set.agent.apikey': {
      name: 'Use an API key', kind: 'Action', what: 'Opens a terminal that runs muse auth set --api-key-stdin, where you paste the key.',
      does: 'The key goes to Muse on stdin. Poise never sees or stores it.', shows: 'API key stored, and the row says API key.',
      unchanged: 'Turns already running.', unavailable: why('A sign-in terminal is open; finish or close it first.')
    },
    'set.term.close': { name: 'Close', kind: 'Action', what: 'Closes this terminal.', does: 'A sign-in still waiting for you stops, and nothing changes.' },
    'set.gh': { name: 'GitHub CLI', kind: 'Setting', what: 'The GitHub accounts gh holds. Poise reads and writes GitHub as them.', now: nowOf, source: 'gh auth status.' },
    'set.gh.row': { name: 'GitHub account', kind: 'Display', what: 'An account gh holds, and whether it is active, your GitHub account or your automation account (both named in General).', now: itemNow },
    'set.google': { name: 'Google accounts', kind: 'Setting', what: 'The Google accounts Editor publishes to Google Docs as, and reads Google’s comments as. Up to ten.', now: nowOf },
    'set.google.row': { name: 'Google account', kind: 'Display', what: 'A connected Google account.', now: itemNow, values: [['Connected', 'Editor can publish as it.'], ['Needs sign-in', 'Its sign-in expired; Reconnect.']] },
    'set.google.reconnect': { name: 'Reconnect', kind: 'Action', what: 'Signs this Google account in again.', shows: 'Running while Google opens, then Connected.' },
    'set.google.disconnect': { name: 'Disconnect', kind: 'Action', what: 'Disconnects this Google account from Poise.', when: 'After you confirm with “Sure?”; Undo stays for eight seconds.', unchanged: 'Documents already published to Google Docs.' },
    'set.google.add': { name: 'Add Google account', kind: 'Action', what: 'Opens Google’s sign-in and comes back here. With none connected it reads Connect Google. If this Poise has no Google set up, it says: Google connections are unavailable. Ask the Poise operator to enable Google.', unavailable: 'Google’s sign-in is not part of this mock.' },
    'set.link-install': { name: 'Install Poise Link', kind: 'Setting', what: 'The command that installs Poise Link on your computer, for snippets and alerts there.' },
    'set.link.copy': { name: 'Copy', kind: 'Action', what: 'Copies the install command.', shows: 'The button says Copied for a moment.' },
    'set.link-pair': { name: 'Pair a computer', kind: 'Setting', what: 'Approves the code Poise Link shows, pairing that computer with this workspace.', does: 'Approve only a code your own Poise Link shows you.', shows: 'Running while it pairs, then the computer at the top of Paired computers.' },
    'set.link.code': { name: 'Code', kind: 'Control', what: 'The eight letters Poise Link shows, like ABCD-EFGH.', does: 'Enter approves.' },
    'set.link.approve': { name: 'Approve', kind: 'Action', what: 'Pairs the computer showing this code.', shows: 'Running, then Paired.' },
    'set.link.deny': { name: 'Deny', kind: 'Action', what: 'Refuses this code; it no longer works.', unchanged: 'Computers already paired.' },
    'set.devices': { name: 'Paired computers', kind: 'Setting', what: 'Computers whose Poise Link may reach this workspace.', now: nowOf, source: 'The gateway.' },
    'set.device.row': { name: 'Paired computer', kind: 'Display', what: 'A computer running Poise Link, when it was paired, and whether it is connected now.', now: itemNow },
    'set.device.revoke': { name: 'Revoke', kind: 'Action', what: 'Stops this computer from reaching the workspace.', when: 'After you confirm with “Sure?”; Undo stays for eight seconds.', unchanged: 'Snippets already on that computer.' },
    'set.phone': {
      name: 'Sign in on your phone', kind: 'Setting', what: 'Signs your phone in to this Poise as you, with no password: scan a code with the phone’s camera, then approve the phone here.',
      does: 'The phone gets a sign-in of its own; this browser’s stays as it is.', source: 'The gateway, which checks each code and signs the phone in.'
    },
    'set.phone.show': {
      name: 'Show the code', kind: 'Action', what: 'Shows a QR code for your phone’s camera.',
      when: 'Each code works once, for two minutes. While it is shown it is replaced before it expires, for about ten minutes; then it says it expired, with Show a new code.'
    },
    'set.phone.code': { name: 'Code', kind: 'Display', what: 'The QR code your phone’s camera opens. Opening it does not sign the phone in: it asks you to approve it here first.' },
    'set.phone.hide': { name: 'Hide the code', kind: 'Action', what: 'Takes the code off the screen.', unchanged: 'A phone that already opened it still waits for you here, and the code stops working when it expires.' },
    'set.phone.request': { name: 'Phone waiting', kind: 'Display', what: 'The device that opened the code, by its kind and browser, waiting for you to approve or deny it.' },
    'set.phone.approve': {
      name: 'Approve', kind: 'Action', what: 'Signs this phone in as you.', does: 'Approve only a phone you are holding: anyone who photographed the code could open it too.',
      shows: 'Signing in…, then signed in, and the phone at the top of Phones signed in with a code.'
    },
    'set.phone.deny': { name: 'Deny', kind: 'Action', what: 'Refuses this phone. It is not signed in, and the code no longer works.' },
    'set.phones': { name: 'Phones signed in with a code', kind: 'Setting', what: 'The phones signed in by scanning a code, each until it signs out, you sign it out here, or its sign-in ends after 14 days.', source: 'The gateway.' },
    'set.phone.row': { name: 'Signed-in phone', kind: 'Display', what: 'A phone signed in with a code: its kind and browser, and when.', now: itemNow },
    'set.phone.sign-out': {
      name: 'Sign out', kind: 'Action', what: 'Signs this phone out of Poise at once.', when: 'After you confirm with “Sure?”.',
      unchanged: 'Your other sign-ins, this browser’s included.'
    },
    'set.ssh': { name: 'SSH keys', kind: 'Setting', what: 'The keys in ~/.ssh on your workspace: each private key file by name, with its public key’s fingerprint.', now: nowOf, scope: 'This workspace. ssh uses them, and so do chats’ shell commands when you ask for work on your servers.', source: 'The public key files in ~/.ssh. Poise never opens a private key file, so a private key cannot leave the workspace through Poise.' },
    'set.ssh.row': { name: 'SSH key', kind: 'Display', what: 'A key file in ~/.ssh, with its public key’s SHA256 fingerprint.', now: itemNow, values: [['Ready', 'ssh can use it.'], ['No public key', 'Its .pub is missing, and the row says how to derive it; or the .pub holds no readable key.'], ['Public key only', 'A .pub with no private file beside it.'], ['ssh refuses it', 'Its permissions let others read it; the row gives the fix, chmod 600.']] },
    'set.ssh.add': { name: 'Add an SSH key', kind: 'Action', what: 'Opens a terminal that asks for a file name and the private key, which you paste. Nothing shows while you paste.', does: 'Saves it in ~/.ssh with 0600, keeps ~/.ssh at 0700, and derives its public key.', unchanged: 'Existing files, which are never overwritten. A key ssh-keygen refuses is not kept.', shows: 'The new key first in the list, with its fingerprint.', unavailable: why('A terminal is open; finish or close it first.') },
    'set.shell': { name: 'Terminal', kind: 'Action', what: 'Opens a shell in your workspace, for connections the buttons do not cover.', does: 'Two can run at once; an idle one closes after 15 minutes.', unavailable: why('The shell is open below.') },

    /* ---------- Models ---------- */
    'set.models.slots': {
      name: 'Models', kind: 'Setting', what: 'The three models Poise runs, chosen once as Primary, Secondary and Tertiary. Every place runs one of these slots, or draws one at Random.', now: nowOf,
      values: [['Primary', 'The slot most places run.'], ['Secondary', 'The next slot: it takes over when Primary fails before its verdict, and also reviews when Behaviors asks for two reviewers.'], ['Tertiary', 'The third slot, next in line after Secondary.']],
      scope: 'Every place below, at once.', when: 'From the next chat, review and run.', unchanged: 'Chats, reviews and runs already going.',
      shows: 'Each place says which model its slot runs now.', source: 'The Caller catalog. Its choices are the defaults.',
      unavailable: () => 'The three must be different models; a model already in another slot is refused, saying which.'
    },
    ...Object.fromEntries([
      ['chat', 'Chat', 'Which slot new chats run, and chats started from Board cards.', 'From the next chat.'],
      ['editor', 'Editor chat', 'Which slot Editor’s chats run: Chat beside a document, and asking an agent about a passage.', 'From the next Editor chat.'],
      ['pr_review', 'PR review', 'Which slot reviews pull requests, automatically and on request.', 'From the next review.'],
      ['pr_approve', 'PR approval', 'Which slot approves pull requests automatically.', 'From the next approval.'],
      ['issue_review', 'Issue review', 'Which slot reviews new issues.', 'From the next issue review.'],
      ['issue_implement', 'Issue implementation', 'Which slot Implement Issues runs: one fresh run per reviewed issue, which opens its pull request.', 'From the next implementation.'],
      ['pr_repair', 'PR repair', 'Which slot Repair Pull Requests runs: one fresh run per repair, for review findings, failing CI, conflicts or a queue rejection.', 'From the next repair.']
    ].map(([k, name, what, when]) => [`set.models.${k}`, {
      name, kind: 'Setting', what, now: nowOf,
      values: [['Primary, Secondary or Tertiary', 'Runs that slot’s model. If it fails before its verdict, the run moves to a slot it has not tried yet.'], ['Random', 'Draws one of the three on each run, so one provider’s limit never stops every run at once. A panel of reviewers draws different models.'], ...(k === 'pr_review' || k === 'issue_review' ? [['More than one reviewer', 'When Behaviors asks for two or three, the slots after this one review alongside it.']] : [])],
      scope: 'Everywhere this place runs.', when, unchanged: 'Chats, reviews and runs already going.', source: 'The three models above; the run records which one it used.'
    }])),
    'set.presets': { name: 'Configurations', kind: 'Setting', what: 'The three models and every place’s slot, saved under a name.', now: nowOf },
    'set.preset.row': { name: 'Configuration', kind: 'Display', what: 'A saved set of choices for every place.', now: itemNow },
    'set.preset.use': { name: 'Use', kind: 'Action', what: 'Sets the three models and every place to this configuration’s choices.', when: 'From the next chat, review and run.', shows: 'Each place saves on its own row; Undo on this row puts all of them back.' },
    'set.preset.delete': { name: 'Delete', kind: 'Action', what: 'Deletes this saved configuration.', unchanged: 'The places keep their choices.', when: 'After you confirm with “Sure?”; Undo stays for eight seconds.' },
    'set.preset.name': { name: 'Name', kind: 'Control', what: 'A name for the current choices, up to 40 characters.', does: 'Enter saves.' },
    'set.preset.save': { name: 'Save', kind: 'Action', what: 'Saves every place’s current choices under this name.' },
    'set.fixed': { name: 'Fixed models', kind: 'Display', what: 'Places whose model the Caller catalog sets.', now: nowOf, source: 'The Caller catalog.' },
    'set.fixed.row': { name: 'Fixed model', kind: 'Display', what: 'A place and the model Caller sets for it.', now: itemNow },
    'set.manager-place': { name: 'The Manager', kind: 'Place', what: 'The Manager’s chat beside the Switchboard.', does: 'Opens the Manager place. Its controls are in Settings → Manager.' },
    'set.catalog': { name: 'Model catalog', kind: 'Display', what: 'Where every model choice comes from, and when it was last checked.', when: 'Checked daily at 07:00 in your time zone.', source: 'Caller and the provider CLIs.', values: [['Not checked yet', 'The daily check runs at 07:00.'], ['No connected providers to check', 'Connect one in Settings → Accounts.'], ['Model check incomplete', 'Existing model choices remain available.'], ['Model check timed out', 'Latest versions could not be confirmed; your selections are kept. Check now tries again.'], ['Model catalog unavailable', 'Your model selections are kept.']] },
    'set.catalog.check': { name: 'Check now', kind: 'Action', what: 'Updates the provider CLIs, then checks which models exist.', shows: 'Running with the time elapsed, then Done with what changed.', unchanged: 'Your choices, and chats meanwhile.', unavailable: why('A check is running.') },

    /* ---------- Extensions ---------- */
    'set.ext.installed': { name: 'Servers by workspace', kind: 'Setting', what: 'Every MCP server you added, and the workspaces whose chats get it.', does: 'Each switch saves itself. A workspace is the repository a chat works in; chats without one share Poise · local.', when: 'From each chat’s next turn. A turn already running keeps the tools it started with.', source: 'Kept in Poise; secrets live only in the workspace database and are never sent back.' },
    'set.ext.row': { name: 'Server', kind: 'Display', what: 'A server, how it connects, whether its last check connected, and where it is on.', now: (el: HTMLElement) => el.closest<HTMLElement>('[data-x]')?.dataset.now || '', values: [['Connected', 'The last check connected; it says how many tools it offers.'], ['Needs sign-in', 'Sign in opens the provider.'], ['Failed', 'The last check did not connect, and says why.'], ['Running', 'A check, sign-in or removal is under way.']] },
    'set.ext.cell': { name: 'On in this workspace', kind: 'Setting', what: 'Whether chats in this workspace get this server.', values: [['On', 'Delivered before each turn.'], ['Off', 'Not delivered.']], when: 'From each chat’s next turn.', unchanged: 'Other workspaces. New workspaces covers only ones chats have not used yet.' },
    'set.ext.space': { name: 'Workspace', kind: 'Display', what: 'A repository chats work in. The columns are the most recently used, Poise · local, and any with a switch of its own.' },
    'set.ext.new': { name: 'New workspaces', kind: 'Setting', what: 'The switch for workspaces chats have not used yet.', unchanged: 'The workspaces already shown, which keep their own switches.' },
    'set.ext.check': { name: 'Check now', kind: 'Action', what: 'Connects the way an agent would and lists the tools. A local server runs once in a scratch folder with the same command and environment.', shows: 'Running, then Connected with its tools, or Failed with the reason.', unavailable: (el: HTMLElement) => el.dataset.why || '' },
    'set.ext.signin': { name: 'Sign in', kind: 'Action', what: 'Opens the provider’s sign-in. Poise finishes the exchange when the browser returns, within ten minutes.', unchanged: 'Chats keep the current sign-in until the new one completes.', unavailable: (el: HTMLElement) => el.dataset.why || '' },
    'set.ext.details': { name: 'Details', kind: 'Action', what: 'Opens the server’s details: Overview, its Tools from the last check, and its Activity.' },
    'set.ext.remove': { name: 'Remove', kind: 'Action', what: 'Removes this server, with its secrets and Activity.', when: 'After you confirm with “Sure?”. The row stays until the removal is confirmed; a failed removal says so and can be tried again.', unchanged: 'A turn already running, which keeps its tools until it ends.', unavailable: (el: HTMLElement) => el.dataset.why || '' },
    'set.ext.builtin': { name: 'Built in', kind: 'Display', what: 'A server Poise ships, listed first in the directory without waiting for the registry.' },
    'set.ext.directory': { name: 'The directory', kind: 'Display', what: 'Poise’s own copy of the official MCP Registry, plus the servers Poise builds in, which come first.', when: 'Refreshed in the background once a day, or now with Refresh. The last complete copy stays while a refresh runs.', source: 'registry.modelcontextprotocol.io.' },
    'set.ext.entry': { name: 'Directory entry', kind: 'Display', what: 'A server you can add, with how it runs: Remote, Local, or both.', now: (el: HTMLElement) => el.closest<HTMLElement>('[data-d]')?.dataset.now || '', unavailable: () => 'An option Poise cannot run says why: a launcher that is not installed, an OCI or NuGet package, or a secret passed on the command line.' },
    'set.ext.search': { name: 'Search', kind: 'Control', what: 'Searches the directory by title, registry name and description.' },
    'set.ext.kind': { name: 'Kind', kind: 'Control', what: 'Shows any server, only remote ones, or only local ones.' },
    'set.ext.refresh': { name: 'Refresh', kind: 'Action', what: 'Reads the registry now.', shows: 'Running, then how many servers it holds.' },
    'set.ext.add': { name: 'Add to Poise', kind: 'Action', what: 'Adds this server, asking only for what the entry declares: its variables, headers or token.', shows: 'The server in the grid above, on in Poise · local.', unavailable: (el: HTMLElement) => el.dataset.why || '' },
    'set.ext.custom': { name: 'Add a custom server', kind: 'Action', what: 'Adds a server of your own: a remote URL with its sign-in, a local command with its environment, or pasted mcpServers JSON.', shows: 'The server in the grid, checked.', unchanged: 'Secrets, which are stored write-only and shown as ‹secret›.' },
    'set.ext.form': { name: 'Kind of server', kind: 'Control', what: 'A Remote URL, a Local command, or Paste JSON.' },
    'set.ext.custom.add': { name: 'Add server', kind: 'Action', what: 'Adds the server, on in the workspaces you chose, and checks it. While editing, Save.', when: 'From each chat’s next turn.', unavailable: () => 'Not until what it needs is filled in: an http or https address, a command, or the token.' },
    'set.ext.receive': { name: 'What chats receive', kind: 'Display', what: 'Exactly what each agent gets for this server, as you fill it in: Claude Code, Codex, Muse or Grok Build. Secrets show as ‹secret›; a server an agent cannot take says so, and why.', source: 'The same shapes Poise sends each agent before a turn.' },
    'set.ext.tab': { name: 'Overview, Tools, Activity', kind: 'Control', what: 'What the details show: the server’s status, connection and reach; the tools its last check listed; or its last 100 events.' },
    'set.ext.facts': { name: 'Connection', kind: 'Display', what: 'How the server runs: its URL and transport, or its command, which runs in each chat’s checkout, and each value it is given. A secret says only Saved or Missing; no page ever shows one.' },
    'set.ext.reach': { name: 'Reaches', kind: 'Display', what: 'The agents whose chats get this server. Codex and Muse take Streamable HTTP, not SSE; a chat that does not get it says so in its conversation.' },
    'set.ext.tools': { name: 'Tools', kind: 'Display', what: 'The tools the last check listed, as agents name them: mcp__name__tool.', unavailable: () => 'Tools appear after a successful check.' },
    'set.ext.activity': { name: 'Activity', kind: 'Display', what: 'The server’s last 100 events: added, edited, checked, signed in, and delivered to which chat or not, and why.' },
    'set.ext.edit': { name: 'Edit', kind: 'Action', what: 'Opens the server in the form below. A secret is replaced only when you type a new one.', unchanged: 'Its name for agents, so the tools they know keep their names; for a directory server, how it runs.', when: 'From each chat’s next turn.' },
    'set.ext.signout': { name: 'Sign out', kind: 'Action', what: 'Forgets this server’s sign-in.', shows: 'Needs sign-in.', unchanged: 'The server and its switches; chats lose its tools from their next turn until you sign in again.' },
    'set.ext.rdc': { name: 'Pairing your computers', kind: 'Display', what: 'Remote Desktop Commander reaches the computers you pair with it. They are managed and revoked on its dashboard, not in Poise.' },
    'set.ext.setup': { name: 'Set up', kind: 'Display', what: 'Only what this entry declares: how to run it, when it offers more than one way, and the values it needs. Secret values are stored write-only.' },
    'set.ext.option': { name: 'How to run it', kind: 'Control', what: 'The entry’s remote endpoint or its package.', unavailable: (el: HTMLElement) => el.dataset.why || 'Poise cannot run this option.' },
    'set.ext.secret': { name: 'Secret value', kind: 'Control', what: 'A token or key, stored write-only: no page or response carries it back, and logs, transcripts and Activity are scrubbed of it.', unchanged: 'A secret already saved, until you type a new one.' },
    'set.ext.customonly': { name: 'Custom only', kind: 'Display', what: 'Poise cannot run any way this entry offers, such as an OCI image or a secret passed as an argument. Add it as a custom server instead.' },
    'set.ext.editing': { name: 'Editing', kind: 'Display', what: 'Which server the form is editing. Cancel leaves it as it was.' },
    'set.ext.name': { name: 'Name', kind: 'Setting', what: 'The server’s name in Poise. Agents name its tools after it; a name already taken gets -2, -3 and so on.', unchanged: 'While editing, its name for agents.' },
    'set.ext.transport': { name: 'Transport', kind: 'Control', what: 'Streamable HTTP, or the older SSE.', values: [['Streamable HTTP', 'Every agent takes it.'], ['SSE (legacy)', 'Claude Code and Grok Build only.']] },
    'set.ext.auth': { name: 'Authentication', kind: 'Control', what: 'How Poise signs in to the server.', values: [['None', 'Nothing is sent.'], ['OAuth sign-in', 'Sign in from its row once added; Poise renews it.'], ['Token', 'Sent as Authorization: Bearer …, stored write-only.'], ['Headers', 'Headers you name, each one secret or not.']] },
    'set.ext.env': { name: 'Environment', kind: 'Setting', what: 'Variables the server runs with, in each chat’s checkout. Marked secret, a value is stored write-only and kept out of logs and transcripts.' },
    'set.ext.lock': { name: 'Secret', kind: 'Control', what: 'Marks this value as a secret: stored write-only, shown as ‹secret› to you, and filled in only when Poise starts the agent.', unavailable: (el: HTMLElement) => el.dataset.why || '' },
    'set.ext.use': { name: 'Use it in', kind: 'Setting', what: 'The workspaces whose chats get the server once added. The grid above changes it later.' },
    'set.ext.read': { name: 'Read configuration', kind: 'Action', what: 'Reads the pasted mcpServers block and lists the servers it finds, with the values it will store as secrets. Nothing is added yet.' },
    'set.ext.import': { name: 'Import', kind: 'Action', what: 'Adds the servers read from the block, on in the workspaces you chose, and checks each.' },

    /* ---------- Publishing ---------- */
    'set.sites': { name: 'Sites', kind: 'Setting', what: 'The sites Editor publishes to, each a GitHub repository.', now: nowOf, source: 'Each repository’s publish.yaml, or a description kept here.' },
    'set.site.row': {
      name: 'Site', kind: 'Display', what: 'A site, its repository, and whether Editor can publish to it.', now: itemNow,
      values: [['Ready', 'Its repository’s publish.yaml reads.'], ['Ready · described here', 'Described in Poise, because the repository has no publish.yaml.'], ['Missing publish.yaml', 'Describe the site here.'], ['Running', 'Poise is reading the repository.']]
    },
    'set.site.describe': { name: 'Describe', kind: 'Action', what: 'Opens this site’s publish.yaml, kept in Poise, under the site.', does: 'It is saved only when it reads; an error names the key.' },
    'set.site.save': { name: 'Save', kind: 'Action', what: 'Saves the description if it reads.', shows: 'Ready · described here, or the error under the box.', unchanged: 'The repository.' },
    'set.site.remove': { name: 'Remove', kind: 'Action', what: 'Removes this site from Editor’s choices.', unchanged: 'Pieces already published there, and the repository.', when: 'After you confirm with “Sure?”; Undo stays for eight seconds.' },
    'set.site.input': { name: 'Repository', kind: 'Control', what: 'owner/repository, or the repository’s GitHub address.', does: 'Enter adds it.' },
    'set.site.add': { name: 'Add site', kind: 'Action', what: 'Adds this repository as a site.', shows: 'Running while Poise reads it, then Ready or a reason it could not read.' },

    /* ---------- Publishing: Google Docs ---------- */
    'set.gdocs': { name: 'Google accounts it publishes to', kind: 'Setting', what: 'The Google accounts Editor can publish a document to, each as a private Markdown file in that account’s My Drive.', now: nowOf, scope: 'Every document, from Editor’s Publish; one file per account per document.', source: 'The same accounts as Accounts → Google.' },
    'set.gdocs.edits': { name: 'Edits made in Google', kind: 'Action', what: 'Opens Editor’s Publish, where Google’s edits are reviewed: keep your draft, publish yours over them, or import Google’s version.', when: 'An open document is checked every minute; Refresh Google checks at once.', unchanged: 'Your draft: an edit in Google never overwrites it.' },
    'set.gdocs.comments': { name: 'Comments made in Google', kind: 'Action', what: 'Opens Editor’s Reviews, where Google’s comments show with their passage and replies.', does: 'You reply and resolve in Google Docs.' },
    'set.gdocs.limits': { name: 'What it publishes', kind: 'Display', what: 'Markdown only: up to 10 MB in Google, 5 MB in Editor. Poise never swaps in another account or makes a replacement file on its own.' },
    'set.release': { name: 'Poise version', kind: 'Display', what: 'The commit this Poise runs, from autonomio/poise, and when it was updated to it.', does: 'In Poise, the commit links to it on GitHub.', source: 'The running install.' },

    /* ---------- Behaviors ---------- */
    ...Object.fromEntries([
      ['review-new-prs', 'Review New Pull Requests', 'Reviews each new pull request of yours with the PR review models, and posts the review as the automation account.'],
      ['approve-prs', 'Approve Pull Requests', 'Approves your pull request when you have addressed the automation account’s change request, or when a clean one asks for its approval.'],
      ['resolve-unblocking', 'Resolve Unblocking Conversations', 'When a pull request of yours is approved and green, resolves the conversations that only block the merge.'],
      ['close-old-prs', 'Close Old Pull Requests', 'Closes your open pull requests once they reach the configured number of elapsed days. Existing old pull requests qualify on the first run.'],
      ['rerun-grey-ci', 'Rerun Grey CI', 'Reruns checks on your pull requests that finished without a result.'],
      ['merge-prs', 'Merge Pull Requests', 'Merges your pull requests once they are approved and every check passes.'],
      ['review-new-issues', 'Review New Issues', 'Reviews each new issue in the repositories you choose, from authors you trust.']
    ].map(([k, name, what]) => [`set.beh.${k}`, {
      name, kind: 'Behavior', what, now: nowOf,
      values: [['On', 'Acts on its next run.'], ['Off', 'Stops before its next run.']],
      scope: k === 'review-new-issues' ? 'New issues in the repositories you choose, from authors you trust.' : 'Your own open pull requests that are not drafts, outside skipped repositories.',
      when: 'From its next run.', unchanged: 'What it already did on GitHub.', source: 'Poise’s server, which runs behaviors even when no tab is open.'
    }])),
    ...Object.fromEntries([
      ['implement-issues', 'Implement Issues', 'Implements a reviewed issue in one fresh run, publishes its branch and opens its pull request, as the step after issue review in the chain.'],
      ['repair-prs', 'Repair Pull Requests', 'Answers review findings, failing or stuck CI, conflicts and a queue rejection, one fresh run each, as the chain’s repair step.']
    ].map(([k, name, what]) => [`set.beh.${k}`, {
      name, kind: 'Behavior', what, now: nowOf,
      values: [['On', 'Takes the chain’s next step of this kind.'], ['Off', 'Chains wait at this step, saying so.'], ['Paused until', 'Future runs wait until then; a run already going carries on.']],
      scope: 'Issues and pull requests in the chain only. Work v1 owns is left alone.', when: 'From its next run.', unchanged: 'A run already going, and what it already did on GitHub.',
      source: 'The chain’s journal on Poise’s server.', unavailable: () => 'Applies once v2 owns new work.'
    }])),
    'set.beh.engine': {
      name: 'Behavior engine', kind: 'Setting', what: 'Which engine owns new behavior work: v1, where each behavior runs on its own, or v2, where an issue moves to its merge as one chain.', now: nowOf,
      values: [['v1 owns new work', 'Each behavior acts on its own; there are no chains.'], ['Switching', 'The runs going now finish first; new runs wait. Cancel the switch keeps v1.'], ['v2 owns new work', 'New issues and their pull requests move as chains. Pull requests v1 owned at the switch keep v1.'], ['v2 is paused', 'v2 owns new work, but this setup can no longer prove its cleanup, so no new step starts until it can.']],
      scope: 'Every behavior, for every repository you follow.', when: 'Once the runs going now have finished.', unchanged: 'Chats, which carry on throughout, and work v1 already owns.',
      shows: 'Switching, with how many runs are still finishing, then the check of which pull requests v1 keeps, then v2 owns new work.', source: 'The behavior journal on Poise’s server, which records the switch and the pull requests v1 kept.',
      unavailable: () => 'Switching is off when this setup cannot prove that a run’s processes and disk are cleaned up, or when that check cannot be read.'
    },
    'set.beh.legacy': { name: 'Kept by v1', kind: 'Display', what: 'The pull requests v1 owned when v2 took over. They keep v1’s handling until they merge or close; nothing is moved into a chain it did not start.', source: 'The behavior journal, which recorded them at the switch.' },
    'set.beh.switch': { name: 'Switch to v2', kind: 'Action', what: 'Gives new behavior work to v2, once the runs going now have finished.', when: 'After the drain; new runs wait meanwhile.', unchanged: 'Chats; the pull requests v1 owns, which keep v1; and an old review held for a decision, which stays held and does not stop the switch.', unavailable: why('This setup cannot run v2.') },
    'set.beh.cancel': { name: 'Cancel the switch', kind: 'Action', what: 'Stops the switch before it completes. v1 keeps new work.', unchanged: 'Runs already finished during the drain.' },
    'set.beh.tasks': { name: 'See every chain', kind: 'Action', what: 'Opens Observe → Tasks: every chain with its phase, state and timeline, with a route back here.' },
    'set.beh.chain': { name: 'Run the chain', kind: 'Setting', what: 'Whether new issues may enter the chain.', now: nowOf, values: [['On', 'Issues that match enter, one chain each.'], ['Off', 'No new issue enters; chains already going keep what they own.']], unchanged: 'Chains already going, which a hold stops instead.', unavailable: () => 'Applies once v2 owns new work.' },
    'set.beh.chain.seed': { name: 'Which issues enter', kind: 'Setting', what: 'The issues that enter the chain: those with the label below, or every open issue in the organizations you follow.', now: nowOf, unchanged: 'Chains already going.', source: 'Your followed organizations, under General.' },
    'set.beh.chain.label': { name: 'Label', kind: 'Setting', what: 'The GitHub label that lets an issue into the chain. poise unless you change it.', now: nowOf, does: 'An issue enters once, when it has the label and the chain is on.' },
    'set.beh.chain.capacity': { name: 'Capacity', kind: 'Display', what: 'How many chain runs are reserved now, against a ceiling shared with other heavy work, with the memory and disk they hold.', does: 'A run that does not fit waits, naming what it waits for, and starts when another lets go. A run that goes over its share is stopped and its chain held; other runs carry on.', values: [['A budget set', 'Memory and disk show what is reserved of the budget. The budgets are set for the service, not here; a run keeps the ceilings it started with.'], ['No budget set', 'Reserved memory and disk are counted, with no ceiling.']], unchanged: 'The Manager’s worker chats, which are counted apart.', source: 'The chain’s journal and this workspace’s measured memory and disk. These are sampled ceilings, not hard limits.' },
    'set.beh.pause': { name: 'Pause 15 min', kind: 'Action', what: 'Holds this behavior’s future runs for fifteen minutes. Resume ends the pause at once.', unchanged: 'A run already going, which carries on; Stop it in Observe.', shows: 'Paused until a time, beside the switch.' },
    'set.beh.cap': { name: 'Review cap', kind: 'Setting', what: 'The approval round from which a pull request’s remaining findings become one follow-up issue, and the pull request is approved.', values: [['Off', 'No cap: reviews repeat until clean.'], ['2 to 10 rounds', 'From that round on, the findings go into one follow-up issue.']], scope: 'Legacy work only: what v1 owns. A chain has no cap: unresolved blockers stay blockers until repaired, or held.' },
    'set.link': { name: 'Go to section', kind: 'Action', what: 'Opens the Settings section it names, on this page.', now: (el: HTMLElement) => `Opens ${(el.textContent ?? '').trim()}.`, unchanged: 'The setting you came from, which keeps what you set.' },
    'set.cancel': { name: 'Cancel', kind: 'Action', what: 'Closes this without saving. What was saved before stays as it was.' },
    'set.snippet.import.run': { name: 'Import', kind: 'Action', what: 'Adds each trigger and replacement from the pasted Espanso matches as a snippet.', unchanged: 'Snippets whose trigger you already use, which are skipped and counted.' },
    'set.ext.custom.field': { name: 'The server', kind: 'Control', what: 'A remote server’s address, a local server’s command, or an mcpServers block, as the kind above says.', unavailable: () => 'While editing a server from the directory: the directory sets how it runs.' },
    'set.beh.skip': { name: 'Skips', kind: 'Setting', what: 'Repositories this behavior leaves alone.', shows: 'A checklist under the row; Done saves it.', when: 'From its next run; a repository skipped mid-run is left alone too.' },
    'set.beh.repos': { name: 'Acts in', kind: 'Setting', what: 'The repositories whose new issues it reviews, and the authors it trusts.', shows: 'A checklist under the row; Done saves it.' },
    'set.beh.memory': { name: 'Memory', kind: 'Setting', what: 'A note added to this behavior’s prompt on every run.', shows: 'A box under the row; Save keeps it.', when: 'From its next run.' },
    'set.beh.done': { name: 'Save', kind: 'Action', what: 'Saves what you chose or wrote, and closes the panel.' },

    /* ---------- Snippets ---------- */
    'set.snippets': { name: 'Your snippets', kind: 'Setting', what: 'Text you reuse. ;name expands it anywhere through Espanso; /name adds it in Chat.', now: nowOf, source: 'Kept in Poise and synced to your paired computers by Poise Link.' },
    'set.snippet.row': { name: 'Snippet', kind: 'Display', what: 'A snippet: its trigger, its text, and its Chat skill.', now: itemNow },
    'set.snippet.edit': { name: 'Edit', kind: 'Action', what: 'Opens this snippet’s trigger and text under it.' },
    'set.snippet.save': { name: 'Save', kind: 'Action', what: 'Saves the snippet if its trigger is new and its text is not empty. If the library changed elsewhere, your edit is kept and Save checks for conflicts first.', when: 'Expands on your paired computers at once; /name works in Chat at once.' },
    'set.snippet.delete': { name: 'Delete', kind: 'Action', what: 'Deletes this snippet and its Chat skill.', when: 'After you confirm with “Sure?”; Undo stays for eight seconds.' },
    'set.snippet.add': { name: 'Add snippet', kind: 'Action', what: 'Opens a new snippet at the top of the list.', does: 'Discard drops it before it is saved.' },
    'set.snippet.import': { name: 'Import from Espanso', kind: 'Action', what: 'Adds snippets from an Espanso match file you paste.', unchanged: 'Snippets whose trigger you already use.' },
    'set.snippet.fresh': { name: 'From Editor', kind: 'Display', what: 'Saved from a selection in Editor. Blue, because it is information, not a state.' },

    /* ---------- Admin ---------- */
    'set.people': { name: 'People', kind: 'Display', what: 'Everyone who has signed in to this gateway, and their workspace.', now: nowOf, source: 'The gateway.' },
    'set.person.row': {
      name: 'Person', kind: 'Display', what: 'A person, how they have access, their last sign-in, their disk use and their workspace.', now: itemNow,
      values: [['Running', 'The workspace is up.'], ['Waiting', 'It is starting, stopping or restarting.'], ['Idle', 'Stopped.'], ['Failed', 'It did not start; the error is under the name.']]
    },
    'set.person.start': { name: 'Start', kind: 'Action', what: 'Starts this workspace.', shows: 'Waiting, then Running.', unavailable: (el: HTMLElement) => el.dataset.why || '' },
    'set.person.stop': { name: 'Stop', kind: 'Action', what: 'Stops this workspace.', shows: 'Waiting, then Idle.', unchanged: 'Their files.', unavailable: (el: HTMLElement) => el.dataset.why || '' },
    'set.person.restart': { name: 'Restart', kind: 'Action', what: 'Restarts this workspace.', shows: 'Waiting, then Running.', unavailable: (el: HTMLElement) => el.dataset.why || '' },
    'set.person.disable': { name: 'Disable', kind: 'Action', what: 'Stops this person signing in, and stops their workspace.', when: 'After you confirm with “Sure?”.', unchanged: 'Their files.' },
    'set.person.enable': { name: 'Enable', kind: 'Action', what: 'Lets this person sign in again.' },
    'set.disk': { name: 'Server disk', kind: 'Display', what: 'Free space on the gateway’s disk, shared by every workspace.', values: [['A warning', 'Less than a tenth is free.']] },
    'set.allow': { name: 'Allowed logins', kind: 'Setting', what: 'GitHub logins that may sign in besides admins and members of the allowed organizations.', now: nowOf },
    'set.allow.row': { name: 'Allowed login', kind: 'Display', what: 'A login that may sign in, and who added it.', now: itemNow },
    'set.allow.remove': { name: 'Remove', kind: 'Action', what: 'Stops this login signing in.', unchanged: 'Logins from the server configuration, which are removed there.', when: 'After you confirm with “Sure?”; Undo stays for eight seconds.' },
    'set.allow.input': { name: 'GitHub login', kind: 'Control', what: 'The login to allow.', does: 'Enter allows it.' },
    'set.allow.add': { name: 'Allow', kind: 'Action', what: 'Lets this GitHub login sign in.', when: 'From their next sign-in.' },
    'set.gateway': { name: 'Gateway administration', kind: 'Action', what: 'The gateway’s own admin page, for when your workspace is unavailable.', unavailable: 'Not part of this mock.' },
    /* ---------- Manager ---------- */
    'set.mgr.scope.choose': { name: 'Choose', kind: 'Action', what: 'Opens a checklist of repositories under the row; Done saves it.', when: 'From the Manager’s next planning decision.', unchanged: 'Work already running elsewhere finishes.' },
    'set.mgr.charter': { name: 'Standing instructions', kind: 'Setting', what: 'The built-in /manager snippet: what the Manager always or never does, in your words.', does: 'Every Manager turn carries its current text, after your own request and before Memories.', scope: 'The workspace Manager. In any other chat, /manager is not supported.', when: 'From the Manager’s next turn.', source: 'Settings → Snippets, where it is edited like any snippet.' },
    'set.snippet.builtin': { name: 'Built-in', kind: 'Display', what: 'A charter Poise carries on every turn: /manager for the Manager, /worker for every worker chat.', does: 'Its text is edited like any snippet’s. Poise creates it with its default text only when it is missing; it never replaces your edits.', scope: 'Every Manager turn, or every worker turn. The Manager’s controls in Settings ride with it, and take precedence.', unavailable: 'Renaming or deleting it: each role always has one. It holds up to 64 KiB.' },
    'set.mgr.open': { name: 'Open the Manager', kind: 'Action', what: 'Opens the Manager: its chat, the work table and the Switchboard, with a route back here.' },
}

register(SETTINGS)
