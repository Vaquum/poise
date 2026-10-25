import { viewDiagnostic, viewFeedback } from '../view-feedback'
import { logTime } from '../clock'
import { effectiveTimezone } from '../config'
import { finishMotion, layout, retire, scrollToActor } from '../motion'
import { patchContent, patchNode } from '../dom-patch'
import { mountOrganizationFilter, organizationUrl, getSelectedOrganization, setSelectedOrganization } from '../organizations'
// Swarm — log of agent calls. Identical finished calls share a row: model, prompt
// (truncated), status, time elapsed, response (View → expand row to
// reveal the full response text underneath).
//
// Data source: /api/agent-logs (wraps `agent-interface --logs`).
// Response bodies: /api/agent-response/:id (reads the file the
// agent-interface project owns).
//
// Refresh: re-fetch the log list every 15s. The expanded-response state
// is keyed by id and survives the refresh — opens stay open through a
// stable in-place row updates.


import { PHASE_LABELS, type ModelProgress } from '../agent-progress'

interface LogEntry {
  id: string
  pr_id: string | null
  repo: string | null
  actor: string | null      // null on chat rows — nothing here may assume it is set
  model: string
  recovery_model?: string | null
  behavior: string | null   // agent-interface behavior name (pr-review, mergeable, etc.)
  // Chat runs are not tied to a repo or PR; this is what identifies them, and
  // it is the same id the chat pane opens a conversation by.
  session_id: string | null
  // Who started the run. `poise:chat` rows are Chat view turns; their session
  // id is a Chat session, not a chat-pane conversation.
  source?: string | null
  prompt: string
  started_at: string        // ISO-ish "YYYY-MM-DDTHH:MM:SS" — naive LOCAL time
                            // (agent-interface uses datetime.fromtimestamp().isoformat()
                            // which emits the system-local datetime without an offset).
  started_at_precise: string | null   // exact UTC instant; preferred when present
  completed_at: string | null
  time_elapsed: string
  status: string
  progress?: ModelProgress | null
  // The verdict of a finished review. 'completed' alone does not say whether
  // the agent approved or demanded changes.
  outcome: 'clean' | 'changes_requested' | 'approved' | 'superseded' | 'preflight_failed' | 'commented' | null
  response: string | null // upstream availability marker; fetch body by full id
  error: string
  error_code?: string | null   // 'stopped' when a person stopped the run
  head_sha?: string | null
  expected_head?: string | null
  action?: string | null
  review_policy?: string | null
  review_id?: number | null
  review_comments?: number | null
  receipts?: Array<{ issue: string, comment_id: number, url: string | null, author: string }> | null
  runner?: string | null
}

// These identities are independently readable fields from rejected records,
// not validated runs. Keep their diagnostics outside the actionable run table.
interface QuarantinedLog {
  index: number
  error: string
  id: string | null
  correlationId: string | null
  repo: string | null
  prId: string | null
  behavior: string | null
  sessionId: string | null
}

// When a run started, as an exact instant. `started_at_precise` carries a UTC
// offset; `started_at` is naive local, which is ambiguous for the hour that
// repeats when the clock goes back and wrong for the hour that does not exist
// when it goes forward. Prefer the exact one and keep the naive one as the
// fallback for rows that predate it.
function startedAtMs(e: { started_at: string, started_at_precise?: string | null }): number {
  const precise = e.started_at_precise ? new Date(e.started_at_precise).getTime() : NaN
  if (isFinite(precise)) return precise
  // agent-interface emits a naive ISO in LOCAL time (no Z, no offset)
  // because datetime.fromtimestamp(ts).isoformat() does — see
  // agent_interface/__init__.py. JavaScript's Date constructor parses
  // naive ISO as local, which matches. An earlier version of this
  // function appended "Z" and parsed as UTC, which on UTC+N pushed the
  // start time N hours into the future and Math.max clamped the diff
  // to 0 — every fresh row read "0s" until N hours had passed.
  return e.started_at ? new Date(e.started_at).getTime() : NaN
}

// Relative-time vocabulary (s / m / h / d / mo / y), the same one Current's
// live cards use, so the two views read alike.
function relFromMs(t: number): string {
  if (!isFinite(t)) return '—'
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`
  const days = Math.floor(secs / 86400)
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(months / 12)}y`
}

function startedRel(e: LogEntry): string {
  return relFromMs(startedAtMs(e))
}

// How long a run has been going. agent-interface fills `time_elapsed` when the
// run ends, so a running row's value was whatever it happened to be at the last
// data poll — frozen for up to five minutes while the Started column beside it
// ticked every thirty seconds, which read as a stalled agent. Derive it live
// for a run that has not finished.
function elapsedText(e: LogEntry): string {
  const running = !e.completed_at && e.status !== 'completed' && e.status !== 'failed' && e.status !== 'error'
  if (!running) return e.time_elapsed || '—'
  const started = startedAtMs(e)
  if (!isFinite(started)) return e.time_elapsed || '—'
  const secs = Math.max(0, Math.floor((Date.now() - started) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ${secs % 60}s`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

let viewEl: HTMLElement
let bodyEl: HTMLElement
let searchEl: HTMLInputElement | null = null
let initialized = false
let importedSessionOpenRequestId = 0
let entries: LogEntry[] = []
let quarantined: QuarantinedLog[] = []
let searchQuery = ''
const PAGE_SIZE = 200
let pageIndex = 0
let searchDebounce: ReturnType<typeof setTimeout> | null = null
// Tick listener — installed on view init, removed on view leave.
// The shared refresh clock still refreshes history; active runs poll every 15s.
const onSwarmTick = () => pollOnce()
let swarmListening = false
let progressPoll: ReturnType<typeof setInterval> | null = null
const expanded = new Map<string, { body: string | null, loading: boolean }>()
const expandedGroups = new Set<string>()
let displayedGroups = new Map<string, RunGroup>()

interface RunGroup {
  key: string
  entries: LogEntry[]
}

interface RunRow {
  entry: LogEntry
  group?: RunGroup
  repeat?: boolean
}

// Run IDs, timestamps and durations identify attempts, not different work.
// Activity histories belong to each attempt and remain in its detail view.
// Compare the full input and result, including the whole error, rather than
// just the truncated status note. A response marker is not its body: keep
// those runs separate because their output has not been proven identical.
function groupRuns(list: LogEntry[]): RunGroup[] {
  const groups = new Map<string, RunGroup>()
  const terminal = new Set(['completed', 'failed', 'error', 'superseded', 'cancelled', 'canceled', 'stopped', 'timed_out', 'timeout'])
  for (const entry of list) {
    const p = entry.progress
    const key = entry.response || p?.reasoning_available || !terminal.has(entry.status.toLowerCase())
      ? JSON.stringify(['call', entry.id])
      : JSON.stringify([
        'result', entry.repo, entry.pr_id, entry.actor, entry.model, entry.recovery_model ?? null,
        entry.behavior, entry.session_id, entry.source ?? null, entry.prompt,
        entry.status, entry.outcome, entry.error, entry.error_code ?? null,
        entry.head_sha ?? null, entry.expected_head ?? null, entry.action ?? null,
        entry.review_policy ?? null, entry.review_id ?? null, entry.receipts ?? null, entry.runner ?? null,
      ])
    const group = groups.get(key)
    if (group) group.entries.push(entry)
    else groups.set(key, { key, entries: [entry] })
  }
  return [...groups.values()]
}

function groupRows(groups: RunGroup[]): RunRow[] {
  return groups.flatMap((group) => [
    { entry: group.entries[0], group },
    ...(expandedGroups.has(group.key) ? group.entries.slice(1).map((entry) => ({ entry, repeat: true })) : []),
  ])
}

function groupButton(group?: RunGroup): string {
  if (!group || group.entries.length < 2) return ''
  const open = expandedGroups.has(group.key)
  const count = group.entries.length
  const label = `${open ? 'Hide' : 'Show'} ${count - 1} identical earlier ${count === 2 ? 'run' : 'runs'} (${count} total)`
  return `<button class="agent-group-btn${open ? ' open' : ''}" data-group-id="${escapeHtml(group.entries[0].id)}"`
    + ` aria-expanded="${open}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">`
    + `<span aria-hidden="true">${open ? '−' : '+'}</span><span>${count}</span></button>`
}


// Attribute-safe HTML escape. textContent → innerHTML only escapes &,
// <, >; we also need to escape " and ' so attribute interpolations
// like `title="${escapeHtml(text)}"` don't break on quoted content.
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
                '&#39;'
  ))
}


function quarantineDescription(row: QuarantinedLog): string {
  const target = row.repo || row.prId
    ? `Reported target: ${row.repo || 'unknown repository'}${row.prId ? `#${row.prId}` : ''}`
    : row.sessionId ? `Reported session: ${row.sessionId}` : 'Target unknown'
  return [target, `Call: ${row.id || 'unknown'}`, row.correlationId ? `Correlation: ${row.correlationId}` : '',
    row.behavior ? `Behavior: ${row.behavior}` : '', row.sessionId ? `Session: ${row.sessionId}` : '',
    `Log index: ${row.index}`, row.error].filter(Boolean).join(' · ')
}

// Status is a coloured icon and the status in a word. The status and outcome
// used to be two uppercase pills ("FAILED PREFLIGHT", "COMPLETED CHANGES") that
// never fit the column and were cut to "FAILED PREFLI…" on every row. A plain
// success is the only state that goes without its word: a green tick needs no
// caption, and most rows are one.
//
// What a finished run actually decided. "completed" says the agent ran, not
// what it concluded — an approval and a demand for changes must not look alike.
const statusSvg = (body: string) => '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor"'
  + ` stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`
const ICON_RUNNING = statusSvg('<path d="M7 1.75A5.25 5.25 0 1 1 1.75 7"/>')
const ICON_DONE = statusSvg('<path d="M3 7.25l2.75 2.75L11 4.25"/>')
const ICON_APPROVED = statusSvg('<circle cx="7" cy="7" r="5.75" stroke-width="1.3"/><path d="M4.6 7.1l1.7 1.7 3.2-3.5"/>')
const ICON_CHANGES = statusSvg('<circle cx="7" cy="7" r="5.75" stroke-width="1.3"/><path d="M7 4.1v3.4M7 9.85h.01"/>')
const ICON_POSTED = statusSvg('<path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h7A1.5 1.5 0 0 1 12 3.5v5a1.5 1.5 0 0 1-1.5 1.5H6l-2.5 2V10A1.5 1.5 0 0 1 2 8.5z" stroke-width="1.3"/>')
const ICON_SUPERSEDED = statusSvg('<path d="M2.5 7h7M7 4l3 3-3 3M11.75 3.25v7.5"/>')
const ICON_BLOCKED = statusSvg('<circle cx="7" cy="7" r="5.75" stroke-width="1.3"/><path d="M2.95 2.95l8.1 8.1"/>')
const ICON_FAILED = statusSvg('<path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/>')
const ICON_STOPPED = statusSvg('<rect x="3" y="3" width="8" height="8" rx="1.5" stroke-width="1.3"/>')
const ICON_OTHER = statusSvg('<circle cx="7" cy="7" r="5" stroke-width="1.3" stroke-dasharray="2 2.25"/>')

type Tone = 'live' | 'ok' | 'warn' | 'bad' | 'flat'

// `word` is what the row says; `detail` adds the raw status for the tooltip.
// `quiet` marks the plain success that shows its icon alone.
interface StatusLook { icon: string, tone: Tone, word: string, detail: string, quiet?: boolean }

const OUTCOME_LOOK: Record<string, { icon: string, tone: Tone, word: string, quiet?: boolean }> = {
  clean: { icon: ICON_DONE, tone: 'ok', word: 'Clean', quiet: true },
  approved: { icon: ICON_APPROVED, tone: 'ok', word: 'Approved' },
  changes_requested: { icon: ICON_CHANGES, tone: 'warn', word: 'Changes requested' },
  superseded: { icon: ICON_SUPERSEDED, tone: 'flat', word: 'Superseded' },
  preflight_failed: { icon: ICON_BLOCKED, tone: 'bad', word: 'Preflight failed' },
  // An issue review ends with its comments posted.
  commented: { icon: ICON_POSTED, tone: 'ok', word: 'Commented' },
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function statusLook(e: LogEntry): StatusLook {
  const status = (e.status || '').toLowerCase()
  if (isRunning(e)) return { icon: ICON_RUNNING, tone: 'live', word: 'Running', detail: 'Running' }
  const verdict = e.outcome ? OUTCOME_LOOK[e.outcome] : null
  if (verdict) {
    return { ...verdict, detail: `${capitalise(status || 'finished')} · ${verdict.word.toLowerCase()}` }
  }
  if (e.error_code === 'stopped' || status === 'cancelled' || status === 'canceled') {
    return { icon: ICON_STOPPED, tone: 'flat', word: 'Stopped', detail: `${capitalise(status)} · stopped` }
  }
  if (status === 'completed') return { icon: ICON_DONE, tone: 'ok', word: 'Completed', detail: 'Completed', quiet: true }
  if (status === 'failed' || status === 'error') return { icon: ICON_FAILED, tone: 'bad', word: capitalise(status), detail: capitalise(status) }
  if (status === 'superseded') return { icon: ICON_SUPERSEDED, tone: 'flat', word: 'Superseded', detail: 'Superseded' }
  const word = capitalise(status || 'unknown')
  return { icon: ICON_OTHER, tone: 'flat', word, detail: word }
}

// What a finished review did, or why it was superseded: a clean review's
// green tick alone did not say it left no comments.
function reviewNote(e: LogEntry): string {
  if (e.outcome === 'superseded' || e.status === 'superseded') {
    if (e.head_sha && e.expected_head && e.head_sha !== e.expected_head) return 'New commits arrived while it ran'
    return 'The pull request was closed, merged or made a draft'
  }
  if (e.behavior !== 'pr_review' && e.behavior !== 'pr_approve') return ''
  if (e.outcome === 'clean') return 'No comments'
  if (e.outcome === 'changes_requested' && typeof e.review_comments === 'number') {
    return e.review_comments === 1 ? '1 comment' : `${e.review_comments} comments`
  }
  return ''
}

// The line after the word: what a running agent is doing now, or why a failed
// one failed. A stopped run's error only repeats "Stopped".
function statusNote(e: LogEntry): string {
  if (isRunning(e)) {
    const text = progressText(e)
    return `<span class="agent-status-note agent-progress-summary" title="${escapeHtml(text)}">${escapeHtml(text)}</span>`
  }
  if (e.error_code === 'stopped') return ''
  const failure = (e.error || '').trim().split('\n')[0] || reviewNote(e)
  if (!failure) return ''
  return `<span class="agent-status-note" title="${escapeHtml(failure)}">${escapeHtml(failure)}</span>`
}

function statusCell(e: LogEntry): string {
  const look = statusLook(e)
  return `<span class="agent-status ${look.tone}">`
    + `<span class="agent-status-icon" title="${escapeHtml(look.detail)}">${look.icon}</span>`
    + `<span class="agent-status-label${look.quiet ? ' quiet' : ''}">${escapeHtml(look.word)}</span>`
    + `${statusNote(e)}</span>`
}

function isRunning(e: LogEntry): boolean {
  return e.status === 'running' && !e.completed_at
}

function progressText(e: LogEntry): string {
  if (!isRunning(e)) return ''
  const p = e.progress
  if (!p) return 'Progress unavailable for this run'
  const heartbeatAge = Date.now() - Date.parse(p.heartbeat_at)
  const providerAge = p.last_provider_event_at ? Date.now() - Date.parse(p.last_provider_event_at) : null
  const label = PHASE_LABELS[p.phase] || 'Unknown activity'
  if (heartbeatAge > 30_000) return `Worker heartbeat missing for ${relFromMs(Date.parse(p.heartbeat_at))}; last: ${label.toLowerCase()}`
  if (p.warning) return `Progress incomplete; last: ${label.toLowerCase()}`
  if (providerAge !== null && providerAge > 60_000 && ['waiting_provider', 'reasoning', 'responding', 'retrying', 'preparing_tool', 'tool_requested'].includes(p.phase)) {
    return `No provider update for ${relFromMs(Date.parse(p.last_provider_event_at!))}; last: ${label.toLowerCase()}`
  }
  return `${label} · ${relFromMs(Date.parse(p.phase_started_at))} in stage`
}

function progressDetail(e: LogEntry, zone: string = effectiveTimezone(), now: number = Date.now()): string {
  const p = e.progress
  if (!p) return ''
  const live = isRunning(e)
  const heartbeat = live ? `Worker heartbeat ${relFromMs(Date.parse(p.heartbeat_at))} ago` : `Last worker heartbeat: ${logTime(p.heartbeat_at, zone, now)}`
  const provider = p.last_provider_event_at
    ? (live ? `Last provider event ${relFromMs(Date.parse(p.last_provider_event_at))} ago` : `Last provider event: ${logTime(p.last_provider_event_at, zone, now)}`)
    : 'No provider event received'
  let deadline = ''
  if (live && p.deadline_at) {
    const left = Date.parse(p.deadline_at) - Date.now()
    deadline = left > 0 ? `Stage deadline in ${Math.ceil(left / 60_000)}m` : 'Stage deadline passed; awaiting worker outcome'
  }
  const facts = [heartbeat, provider, deadline].filter(Boolean).map(escapeHtml).join(' · ')
  const warning = `<p class="agent-response-error"${p.warning ? '' : ' hidden'}>${escapeHtml(p.warning || '')}</p>`
  const events = p.events.map((event) => `<li><time datetime="${escapeHtml(event.at)}">${escapeHtml(logTime(event.at, zone, now))}</time> ${escapeHtml(event.message)}</li>`).join('')
  return `<section class="agent-progress-detail" aria-label="Run activity"><p>${facts}</p>${warning}<ol>${events}</ol>${reasoningDetail(e)}</section>`
}

const reasoning = new Map<string, { chars: number, body: string, loading: boolean }>()
const openReasoning = new Set<string>()

function reasoningDetail(e: LogEntry): string {
  if (e.progress?.reasoning_available === undefined) return ''
  const saved = reasoning.get(e.id)
  const body = saved?.body || ''
  return `<details class="agent-reasoning" data-reasoning-id="${escapeHtml(e.id)}"${openReasoning.has(e.id) ? ' open' : ''}><summary>Provider reasoning</summary><pre class="agent-reasoning-body">${escapeHtml(body)}</pre></details>`
}

async function loadReasoning(id: string): Promise<void> {
  const entry = entries.find((e) => e.id === id)
  const details = bodyEl.querySelector<HTMLDetailsElement>(`details[data-reasoning-id="${id}"]`)
  if (!details?.open || !entry?.progress?.reasoning_available) return
  const saved = reasoning.get(id)
  const chars = entry.progress.reasoning_chars || 0
  if (saved?.loading || saved?.chars === chars) return
  reasoning.set(id, { chars: saved?.chars ?? -1, body: saved?.body || '', loading: true })
  try {
    const response = await fetch(`/api/agent-reasoning/${encodeURIComponent(id)}`)
    if (!response.ok) throw new Error(`Could not load reasoning (${response.status})`)
    const data = await response.json()
    if (typeof data.body !== 'string') throw new Error('Invalid reasoning response')
    reasoning.set(id, { chars, body: data.body || '', loading: false })
    viewFeedback(`swarm-reasoning:${id}`, 'Swarm reasoning unavailable', '')
  } catch (error) {
    reasoning.set(id, { chars: -1, body: saved?.body || '', loading: false })
    viewFeedback(`swarm-reasoning:${id}`, 'Swarm reasoning unavailable', (error as Error).message, 'read_failed')
  }
  const row = bodyEl.querySelector<HTMLTableRowElement>(`.agent-expand-row[data-expand-for="${id}"]`)
  if (row) refreshRunDetail(row, entry)
}

function modelCell(s: string): string {
  return `<span class="agent-model" title="${escapeHtml(s || '')}">${escapeHtml(s || '—')}</span>`
}

function behaviorCell(s: string | null): string {
  if (!s) return '<span class="agent-dash">—</span>'
  return `<span class="agent-behavior" title="${escapeHtml(s)}">${escapeHtml(s)}</span>`
}

// The target is two columns, Org and Repo, each linking to its own GitHub page.
// As one "owner/name#123" string it was cut to "autonomio/chan…" on every row —
// the repository name and the pull request were exactly the part that went.
// The pull request number rides along in the Repo column and links to the
// pull request (or issue).
//
// A session id is the only thing identifying a run that is not tied to a pull
// request, and Swarm has no Prompt column — so a chat, debate or find_alpha row
// used to carry no identifying information at all. The id itself is too long to
// read: strip the `editor-` prefix and the trailing uniqueness digits that
// editorChatSessionId appends, and keep the full value in the tooltip.
const SESSION_LABEL_MAX = 26

function sessionLabel(sessionId: string): string {
  let label = sessionId
  const editor = /^editor-(.+)-\d+$/.exec(sessionId)
  if (editor) label = editor[1]
  if (label.length <= SESSION_LABEL_MAX) return label
  return `${label.slice(0, SESSION_LABEL_MAX - 1)}…`
}

// A turn the Chat view ran. Caller records it with `behavior: chat` and
// `source: poise:chat`; Stop on the row is routed back to the runtime.
function isChatTurn(e: LogEntry): boolean {
  return e.behavior === 'chat' && e.source === 'poise:chat' && !!e.session_id
}

// Open the Chat session that imported a legacy chat row's conversation. A
// row that was never opened in Chat says so in place; its replies stay in
// Swarm, readable by expanding the row.
async function openImportedSession(button: HTMLButtonElement, session: string): Promise<void> {
  const requestId = ++importedSessionOpenRequestId
  let neverImported = false
  let found: { id: string } | null = null
  try {
    const res = await fetch(`/api/chat/sessions?legacy=${encodeURIComponent(session)}`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`Chat session lookup returned HTTP ${res.status}`)
    const body: unknown = await res.json()
    if (!body || typeof body !== 'object' || !('session' in body)) throw new Error('Chat session lookup returned no readable session')
    const imported = body.session
    if (imported === null) neverImported = true
    else {
      if (!imported || typeof imported !== 'object' || !('id' in imported) || typeof imported.id !== 'string' || !imported.id.trim()) {
        throw new Error('Chat session lookup returned no readable session')
      }
      found = { id: imported.id }
    }
  } catch (error) {
    if (requestId === importedSessionOpenRequestId && viewEl && !viewEl.hidden) {
      viewFeedback(`swarm-chat:${session}`, 'Chat session lookup failed', (error as Error).message, 'read_failed')
    }
    return
  }
  if (requestId !== importedSessionOpenRequestId || !viewEl || viewEl.hidden) return
  viewFeedback(`swarm-chat:${session}`, 'Chat session lookup failed', '')
  if (found) {
    window.dispatchEvent(new CustomEvent('poise:open-chat-session', { detail: { id: found.id } }))
    return
  }
  if (!neverImported || !button.isConnected) return
  const message = document.createElement('span')
  message.className = 'agent-target agent-never-imported'
  message.textContent = 'This conversation was never opened in Chat — its replies stay in Swarm.'
  button.replaceWith(message)
}

// What the Target column reads as, so the filter can match the same text the
// person is looking at. Empty when the row has no target at all.
function targetText(e: LogEntry): string {
  const repo = e.repo || ''
  const pr = e.pr_id ? String(e.pr_id) : ''
  if (repo || pr) {
    const short = repo || ''
    return short && pr ? `${short}#${pr}` : (short || `#${pr}`)
  }
  return e.session_id ? sessionLabel(e.session_id) : ''
}

// `owner/name` split in two. A bare name has no owner — the agent log allows it.
function repoParts(e: LogEntry): { owner: string, name: string } {
  const repo = e.repo || ''
  const slash = repo.indexOf('/')
  return slash < 0 ? { owner: '', name: repo } : { owner: repo.slice(0, slash), name: repo.slice(slash + 1) }
}

function githubUrl(...parts: string[]): string {
  return `https://github.com/${parts.map(encodeURIComponent).join('/')}`
}

function githubLink(cls: string, href: string, text: string, title: string): string {
  return `<a class="${cls}" href="${href}" target="_blank" rel="noopener" title="${escapeHtml(title)}">${escapeHtml(text)}</a>`
}

function orgCell(e: LogEntry): string {
  const { owner } = repoParts(e)
  if (!owner) return '<span class="agent-dash">—</span>'
  return githubLink('agent-org', githubUrl(owner), owner, owner)
}

function repoCell(e: LogEntry): string {
  const { owner, name } = repoParts(e)
  const pr = e.pr_id ? String(e.pr_id) : ''
  if (name || pr) {
    // A link needs owner/name. A bare repo name produced a link into
    // github.com/<name>/…, which is someone else's namespace or a 404 — render
    // it as text rather than sending the person somewhere wrong.
    const repoHtml = !name ? ''
      : owner ? githubLink('agent-repo', githubUrl(owner, name), name, `${owner}/${name}`)
        : `<span class="agent-repo" title="${escapeHtml(name)}">${escapeHtml(name)}</span>`
    // An issue review's target is an issue; GitHub serves it under /issues.
    const kind = e.behavior === 'issue_review' ? 'issues' : 'pull'
    const prHtml = !pr ? ''
      : owner ? githubLink('agent-pr', githubUrl(owner, name, kind, pr), `#${pr}`, `${owner}/${name}#${pr}`)
        : `<span class="agent-pr">#${escapeHtml(pr)}</span>`
    return `<span class="agent-repo-cell">${repoHtml}${prHtml}</span>`
  }
  const label = targetText(e)
  // A legacy chat row opens the Chat session that imported it, if any —
  // resolved live when clicked, since the import happens on open. A row
  // whose conversation was never opened in Chat says so in place. A Chat
  // view turn opens the Chat view on that session directly.
  if (e.session_id) {
    const chat = isChatTurn(e)
    return `<button type="button" class="agent-target agent-session-link${chat ? ' agent-chat-session' : ''}" data-session="${escapeHtml(e.session_id)}"`
      + ` title="${chat ? 'Open this session in Chat' : 'Open this conversation'} — ${escapeHtml(e.session_id)}">${escapeHtml(label)}</button>`
  }
  return '<span class="agent-dash">—</span>'
}

// Chevron — same icon-button rhythm as Archive's .review-btn. Points
// right when collapsed, rotates 90° (down) when the row is expanded
// via .open class.
const CHEV_SVG = '<svg class="chev" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 2.5l4 3.5-4 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
// Replay — circular arrow with a notch, classic "re-run" icon. Clicking
// it spawns a fresh agent-interface call with the same args; the new
// run shows up as a new row on the next poll.
const REPLAY_SVG = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M9.5 3.5A4 4 0 1 0 10.4 7.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><polyline points="9.5 1 9.5 3.5 7 3.5" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/></svg>'

// Whether a row is replayable through agent-interface today —
// pr_review and pr_approve have standalone CLI invocations; chat is a
// continuous session (replay doesn't fit the semantic); other behaviors
// aren't first-class CLI entry points.
const STOP_SVG = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="2.5" y="2.5" width="7" height="7" rx="1.2" fill="currentColor"/></svg>'

// Stop is a two-step click: the first arms the button ("Sure?") for a few
// seconds, the second sends the stop. A review that has run for twenty
// minutes should not die to a stray click on a live table. Armed and
// in-flight state lives here, not on the button, for the same reason as
// replaysInFlight below — a render replaces the node under the cursor.
const STOP_ARM_MS = 4000
let armedStop: { id: string, until: number } | null = null
const stopsInFlight = new Set<string>()

function stopCell(e: LogEntry): string {
  if (!isRunning(e)) return '<span class="agent-dash">—</span>'
  const busy = stopsInFlight.has(e.id)
  const armed = !busy && armedStop?.id === e.id && armedStop.until > Date.now()
  const label = busy ? 'Stopping…' : armed ? 'Sure?' : 'Stop this run'
  return `<button class="stop-btn${busy ? ' spinning' : ''}${armed ? ' armed' : ''}"${busy ? ' disabled' : ''}`
    + ` title="${label}" aria-label="${armed ? 'Confirm stopping this run' : 'Stop this run'}">`
    + `${armed ? 'Sure?' : STOP_SVG}</button>`
}

function isReplayable(e: LogEntry): boolean {
  return (e.behavior === 'pr_review' || e.behavior === 'pr_approve' || e.behavior === 'issue_review')
      && !!e.repo && !!e.pr_id
}

// Replays in flight, by row id. This lived on the button element, which every
// render replaces — a filter keystroke destroyed it deterministically and the
// refresh tick did it by coincidence. The spinner vanished, the button came
// back idle and enabled while the spawn was still going, and a second click
// started another real agent against the same pull request. For a pr_approve
// row that is a second approval on a live pull request, so the guard has to
// outlive the DOM node.
const replaysInFlight = new Set<string>()

function showReplayRefusal(id: string, message: string): void {
  viewFeedback(`swarm-replay:${id}`, 'Swarm replay refused', message, 'action_needed')
}

function clearReplayRefusal(id: string): void {
  viewFeedback(`swarm-replay:${id}`, 'Swarm replay refused', '')
}

function replayCell(e: LogEntry): string {
  if (!isReplayable(e)) return '<span class="agent-dash">—</span>'
  const busy = replaysInFlight.has(e.id)
  return `<button class="replay-btn${busy ? ' spinning' : ''}"${busy ? ' disabled' : ''}`
    + ` title="${busy ? 'Replay in progress…' : 'Replay this run'}" aria-label="Replay this run">${REPLAY_SVG}</button>`
}

// The filter must match what the column shows. It matched `repo` and `pr_id`
// separately but never the rendered "name#123", so copying the Target cell and
// pasting it in — the first thing anyone tries — returned nothing. The error
// text and the outcome are searchable too: those are the rows a person is
// usually hunting for, and neither had any way to be found.
function matchesSearch(e: LogEntry): boolean {
  if (!searchQuery) return true
  const q = searchQuery.toLowerCase()
  return [
    e.id, e.model, e.recovery_model, e.behavior, e.prompt, e.status, e.actor, e.repo, e.pr_id,
    targetText(e), e.session_id, e.outcome, e.error,
  ].some((f) => (f || '').toLowerCase().includes(q))
}

function visible(): LogEntry[] {
  return entries.filter(matchesSearch)
}

function clearRows(): void {
  finishMotion(bodyEl, true)
  bodyEl.replaceChildren()
}

// Every column in the header row; the expanded detail row spans all of them.
const COLUMN_COUNT = 11

function renderShell() {
  viewEl.innerHTML = `
    <header class="view-header">
      <div class="filter-cluster" id="swarm-filters">
        <div class="search-cluster">
          <input class="search-input" id="swarm-search" type="search" placeholder="Filter…" autocomplete="off" spellcheck="false" />
          <span class="filter-count" id="swarm-count"></span>
        </div>
        <div class="logging-pagination" id="swarm-pagination" hidden>
          <div class="range-picker" role="group" aria-label="Swarm pages">
            <button type="button" data-page="previous">Previous</button>
            <button type="button" data-page="next">Next</button>
          </div>
          <span class="filter-count" id="swarm-page"></span>
        </div>
      </div>
    </header>
    <main>
      <table id="swarm-table">
        <thead>
          <tr>
            <th class="col-group" aria-label="Identical runs"></th>
            <th class="col-model">Model</th>
            <th class="col-behavior">Behavior</th>
            <th class="col-org">Org</th>
            <th class="col-repo">Repo</th>
            <th class="col-status">Status</th>
            <th class="col-started">Started</th>
            <th class="col-elapsed">Elapsed</th>
            <th class="col-replay">Replay</th>
            <th class="col-stop">Stop</th>
            <th class="col-action"></th>
          </tr>
        </thead>
        <tbody id="swarm-tbody"></tbody>
      </table>
      <div id="swarm-loader" class="loader" hidden><span></span><span></span><span></span></div>
    </main>
  `
  mountOrganizationFilter(viewEl.querySelector<HTMLElement>('#swarm-filters')!)
  bodyEl = viewEl.querySelector<HTMLElement>('#swarm-tbody')!
  searchEl = viewEl.querySelector<HTMLInputElement>('#swarm-search')!
  viewEl.querySelector('#swarm-pagination')!.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-page]')
    if (!button || button.disabled) return
    void (async () => {
      pageIndex += button.dataset.page === 'next' ? 1 : -1
      clearRows()
      render(false)
      const mine = pollSequence
      const org = getSelectedOrganization()
      const search = searchQuery
      const current = () => mine === pollSequence && org === getSelectedOrganization() && search === searchQuery
      await loadMoreForView(current)
      if (button.disabled) viewEl.querySelector<HTMLButtonElement>('#swarm-pagination button:not(:disabled)')?.focus()
    })()
  })
  searchEl.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce)
    searchDebounce = setTimeout(() => {
      const next = (searchEl!.value || '').trim()
      if (next === searchQuery) return
      searchQuery = next
      pageIndex = 0
      entries = []
      quarantined = []
      totalMatching = 0
      historyCursor = null
      incompleteTotal = null
      loadingHistory = false
      lastLoadedAt = 0
      clearRows()
      render(false)
      renderStaleBanner()
      void pollOnce()
    }, 90)
  })
}

// Cell markup for one agent-call row. Split out from buildMainRow so
// the refresh path can update an *existing* row's cells in place — every
// value here (status, started, elapsed) is recomputed each call, so a
// reused row stops freezing at its first-render values.
// Prompt column dropped — agent-interface behaviors are mostly
// input-driven (pr_review takes a PR id, mergeable takes a PR), so
// the prompt field is empty for almost every row. The full prompt
// is still visible inside the expanded response view when relevant.
// A run that failed carries an `error` string — every one of them does — and
// the client already holds it. It was rendered nowhere: a red pill, no chevron,
// nothing to open, so diagnosing a failure meant leaving Poise for the CLI.
// A failed row is now expandable whether or not a response body exists; the
// error is what its expansion shows.
function hasDetail(e: LogEntry): boolean {
  return !!e.response || !!e.error || !!e.progress
}

interface MainRowState { open: boolean, group: string, status: string, started: string, elapsed: string, replay: string, stop: string }

function mainRowState(e: LogEntry, group?: RunGroup): MainRowState {
  return { open: expanded.has(e.id), group: groupButton(group), status: statusCell(e), started: startedRel(e), elapsed: elapsedText(e), replay: replayCell(e), stop: stopCell(e) }
}

function mainRowInnerHTML(e: LogEntry, state: MainRowState): string {
  const isOpen = state.open
  const btn = hasDetail(e)
    ? `<button class="expand-btn${isOpen ? ' open' : ''}" aria-expanded="${isOpen}"`
      + ` title="${isOpen ? 'Hide detail' : (e.progress ? 'View activity' : e.response ? 'View response' : 'View error')}"`
      + ` aria-label="Toggle detail">${CHEV_SVG}</button>`
    : ''
  return `
    <td class="group-cell">${state.group}</td>
    <td>${modelCell(e.recovery_model ? `${e.model} → ${e.recovery_model}` : e.model)}</td>
    <td>${behaviorCell(e.behavior)}</td>
    <td class="org-cell">${orgCell(e)}</td>
    <td class="repo-cell">${repoCell(e)}</td>
    <td class="agent-status-cell">${state.status}</td>
    <td class="started-cell"><span class="date">${escapeHtml(state.started)}</span></td>
    <td class="elapsed-cell"><span class="date">${escapeHtml(state.elapsed)}</span></td>
    <td class="replay-cell">${state.replay}</td>
    <td class="stop-cell">${state.stop}</td>
    <td class="action-cell">${btn}</td>
  `
}

const mainRowMarkup = new WeakMap<HTMLTableRowElement, string>()

function buildMainRow(e: LogEntry, markup: string): HTMLTableRowElement {
  const tr = document.createElement('tr')
  tr.className = 'agent-row'
  tr.dataset.id = e.id
  tr.dataset.callId = e.response ? e.id : ''
  tr.innerHTML = markup
  mainRowMarkup.set(tr, markup)
  return tr
}

function setExpandContent(tr: HTMLTableRowElement, id: string) {
  const state = expanded.get(id)
  if (!state) return
  const entry = entries.find((x) => x.id === id)
  const errorBlock = entry?.error
    ? `<pre class="agent-response-error">${escapeHtml(entry.error)}</pre>`
    : ''
  const activity = entry ? progressDetail(entry) : ''
  const inner = state.loading
    ? '<div class="loader" role="status" aria-label="Loading response"><span></span><span></span><span></span></div>'
    : (state.body
        ? `<pre class="agent-response-body">${escapeHtml(state.body)}</pre>`
        : (errorBlock || activity ? '' : ''))
  patchContent(tr, `<td colspan="${COLUMN_COUNT}">${activity}${errorBlock}${inner}</td>`)
}

function refreshRunDetail(row: HTMLTableRowElement, entry: LogEntry): void {
  const section = row.querySelector<HTMLElement>('.agent-progress-detail')
  const next = progressDetail(entry)
  if (section) {
    const selection = window.getSelection()
    const selected = selection && !selection.isCollapsed && selection.anchorNode && section.contains(selection.anchorNode)
    if (!selected && section.outerHTML !== next) {
      const template = document.createElement('template')
      template.innerHTML = next
      if (template.content.firstChild) patchNode(section, template.content.firstChild)
    }
  } else if (next) {
    row.querySelector('td')?.insertAdjacentHTML('afterbegin', next)
  }
  const error = row.querySelector<HTMLElement>('td > .agent-response-error')
  const nextError = entry.error ? `<pre class="agent-response-error">${escapeHtml(entry.error)}</pre>` : ''
  if (error) {
    if (error.outerHTML !== nextError) error.outerHTML = nextError
  } else if (nextError) {
    row.querySelector('td')?.insertAdjacentHTML('beforeend', nextError)
  }
}

function buildExpandRow(e: LogEntry): HTMLTableRowElement {
  const tr = document.createElement('tr')
  tr.className = 'agent-expand-row'
  tr.dataset.expandFor = e.id
  setExpandContent(tr, e.id)
  return tr
}

// Stable keyed rows: unchanged rows are never detached or animated on refresh.
function reconcileRows(nextRows: RunRow[], animate: boolean): void {
  const change = () => {
    const main = new Map<string, HTMLTableRowElement>()
    const detail = new Map<string, HTMLTableRowElement>()
    for (const row of [...bodyEl.children] as HTMLTableRowElement[]) {
      if (row.dataset.id) main.set(row.dataset.id, row)
      if (row.dataset.expandFor) detail.set(row.dataset.expandFor, row)
    }
    const ids = new Set(nextRows.map(({ entry }) => entry.id))
    const remove = (row: HTMLTableRowElement) => { if (animate) retire(row); else row.remove() }
    for (const [id, row] of main) if (!ids.has(id)) remove(row)
    for (const [id, row] of detail) if (!ids.has(id) || !expanded.has(id)) remove(row)
    let cursor: ChildNode | null = bodyEl.firstChild
    const place = (row: HTMLTableRowElement) => {
      if (cursor !== row) bodyEl.insertBefore(row, cursor)
      cursor = row.nextSibling
    }
    for (const { entry, group, repeat } of nextRows) {
      const state = mainRowState(entry, group)
      const markup = mainRowInnerHTML(entry, state)
      const row = main.get(entry.id) || buildMainRow(entry, markup)
      row.classList.toggle('agent-repeat-row', !!repeat)
      row.dataset.callId = entry.response ? entry.id : ''
      if (mainRowMarkup.get(row) !== markup) {
        patchContent(row, markup)
        mainRowMarkup.set(row, markup)
      }
      place(row)
      if (expanded.has(entry.id)) {
        const expandedRow = detail.get(entry.id) || buildExpandRow(entry)
        refreshRunDetail(expandedRow, entry)
        place(expandedRow)
      }
    }
  }
  if (animate) layout(bodyEl, change)
  else {
    const active = document.activeElement
    change()
    if (active instanceof HTMLElement && active.isConnected && bodyEl.contains(active)) active.focus({ preventScroll: true })
  }
}

function render(animate = true) {
  // Nothing to paint into while the view is hidden. Swarm kept rebuilding all
  // ~1000 rows on every tick for the rest of the session after one visit —
  // a fetch, a parse and a full table rebuild every minute, on the main thread,
  // while the person was typing in another view.
  if (!viewEl || viewEl.hidden) return
  const list = visible()
  const groups = groupRuns(list)
  const rows = groupRows(groups)
  const previousPage = pageIndex
  const focused = document.activeElement?.closest<HTMLElement>('#swarm-tbody > tr')
  const focusedId = focused?.dataset.id ?? focused?.dataset.expandFor
  const focusedIndex = focusedId ? rows.findIndex(row => row.entry.id === focusedId) : -1
  // Fixed pages retain complete coverage as new runs arrive. Follow a focused
  // run over a boundary, retaining its keyed control rather than dropping focus.
  if (animate && focusedIndex >= 0) pageIndex = Math.floor(focusedIndex / PAGE_SIZE)
  pageIndex = Math.min(pageIndex, Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1))
  const start = pageIndex * PAGE_SIZE
  const pager = viewEl.querySelector<HTMLElement>('#swarm-pagination')!
  const moreHistory = historyCursor !== null
  pager.hidden = rows.length <= PAGE_SIZE && !moreHistory
  pager.querySelector<HTMLButtonElement>('[data-page="previous"]')!.disabled = pageIndex === 0
  pager.querySelector<HTMLButtonElement>('[data-page="next"]')!.disabled = start + PAGE_SIZE >= rows.length && !moreHistory
  viewEl.querySelector<HTMLElement>('#swarm-page')!.textContent = rows.length
    ? `${start + 1}–${Math.min(start + PAGE_SIZE, rows.length)} / ${rows.length}${moreHistory ? '+' : ''}` : ''
  displayedGroups = new Map(groups.map((group) => [group.entries[0].id, group]))
  const table = viewEl.querySelector<HTMLElement>('#swarm-table')!
  const countEl = viewEl.querySelector<HTMLElement>('#swarm-count')!
  const runCount = list.length === entries.length ? `${entries.length}` : `${list.length} / ${entries.length}`
  countEl.textContent = entries.length ? runCount : ''
  table.hidden = list.length === 0
  if (!list.length) { clearRows(); return }
  reconcileRows(rows.slice(start, start + PAGE_SIZE), animate && previousPage === pageIndex)
}

async function loadResponse(id: string, refresh = false) {
  const e = entries.find((x) => x.id === id)
  // A failed run often has no response body at all — its detail is the error,
  // which is already in hand. Show it without a round trip that would 404.
  const bodyAvailable = !!e?.response
  expanded.set(id, { body: null, loading: bodyAvailable })

  // Optimistically insert the expand row right after its main row so
  // the user sees the loading state immediately. The next poll's FLIP
  // will preserve the row by id.
  const mainRow = bodyEl.querySelector<HTMLTableRowElement>(`.agent-row[data-id="${id}"]`)
  if (mainRow && e && !refresh) mainRow.insertAdjacentElement('afterend', buildExpandRow(e))
  if (refresh) {
    const row = bodyEl.querySelector<HTMLTableRowElement>(`.agent-expand-row[data-expand-for="${id}"]`)
    if (row) setExpandContent(row, id)
  }
  if (!bodyAvailable) return

  let next: { body: string | null, loading: boolean }
  try {
    const res = await fetch(`/api/agent-response/${encodeURIComponent(id)}`)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(text ? `/api/agent-response ${res.status}: ${text.slice(0, 200)}` : `/api/agent-response ${res.status}`)
    }
    const data = await res.json()
    next = { body: data.body || '', loading: false }
    viewFeedback(`swarm-response:${id}`, 'Swarm response unavailable', '')
  } catch (err) {
    next = { body: null, loading: false }
    viewFeedback(`swarm-response:${id}`, 'Swarm response unavailable', (err as Error).message, 'read_failed')
  }

  // The person may have collapsed the row while this was out. Writing the
  // result back unconditionally re-created the map entry with no row behind
  // it, which killed the next click on that chevron and made the row re-open
  // on its own at the next render.
  if (!expanded.has(id)) return
  expanded.set(id, next)
  const stillThere = bodyEl.querySelector<HTMLTableRowElement>(`.agent-expand-row[data-expand-for="${id}"]`)
  if (stillThere) setExpandContent(stillThere, id)
}

function attachClicks() {
  bodyEl.addEventListener('toggle', (event) => {
    const details = event.target
    if (details instanceof HTMLDetailsElement && details.dataset.reasoningId && bodyEl.contains(details)) {
      if (details.open) { openReasoning.add(details.dataset.reasoningId); void loadReasoning(details.dataset.reasoningId) }
      else openReasoning.delete(details.dataset.reasoningId)
    }
  }, true)
  bodyEl.addEventListener('click', async (ev) => {
    const target = ev.target as HTMLElement

    const groupBtn = target.closest<HTMLButtonElement>('.agent-group-btn')
    if (groupBtn) {
      const group = displayedGroups.get(groupBtn.dataset.groupId || '')
      if (!group) return
      if (expandedGroups.has(group.key)) expandedGroups.delete(group.key)
      else expandedGroups.add(group.key)
      // Disclosure can replace the whole page; use the pager's direct commit.
      render(false)
      return
    }

    // Stop — first click arms, second click within STOP_ARM_MS stops.
    // Caller kills the call's process group and closes the row; the next
    // poll paints the settled row.
    const stopBtn = target.closest<HTMLButtonElement>('.stop-btn')
    if (stopBtn) {
      const tr = stopBtn.closest<HTMLTableRowElement>('tr')!
      const id = tr.dataset.id || ''
      const entry = entries.find((e) => e.id === id)
      if (!entry || stopsInFlight.has(id)) return
      const armed = armedStop?.id === id && armedStop.until > Date.now()
      if (!armed) {
        armedStop = { id, until: Date.now() + STOP_ARM_MS }
        tr.querySelector('.stop-cell')!.innerHTML = stopCell(entry)
        window.setTimeout(() => {
          if (armedStop?.id !== id || armedStop.until > Date.now()) return
          armedStop = null
          const cell = bodyEl.querySelector<HTMLElement>(`tr.agent-row[data-id="${id}"] .stop-cell`)
          if (cell) cell.innerHTML = stopCell(entry)
        }, STOP_ARM_MS + 50)
        return
      }
      armedStop = null
      stopsInFlight.add(id)
      tr.querySelector('.stop-cell')!.innerHTML = stopCell(entry)
      try {
        const res = await fetch('/api/agent-stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(String(data.error || `HTTP ${res.status}`))
        viewFeedback(`swarm-stop:${id}`, 'Swarm stop failed', '')
        // Pull the log right away so the row settles without waiting for
        // the 15s poll.
        window.setTimeout(() => { void pollOnce() }, 300)
      } catch (err) {
        console.error('[swarm] stop failed:', err)
        viewFeedback(`swarm-stop:${id}`, 'Swarm stop failed', (err as Error).message)
      } finally {
        stopsInFlight.delete(id)
        const cell = bodyEl.querySelector<HTMLElement>(`tr.agent-row[data-id="${id}"] .stop-cell`)
        const current = entries.find((e) => e.id === id)
        if (cell && current) cell.innerHTML = stopCell(current)
      }
      return
    }

    // Replay — re-spawns the same agent-interface CLI invocation with
    // the row's behavior/repo/pr_id. The new run lands as a fresh row;
    // the original row stays unchanged. Quick poll right after so the
    // user sees the new row land without waiting for the next 15s tick.
    const replayBtn = target.closest<HTMLButtonElement>('.replay-btn')
    if (replayBtn) {
      const tr = replayBtn.closest<HTMLTableRowElement>('tr')!
      const id = tr.dataset.id || ''
      const entry = entries.find((e) => e.id === id)
      if (!entry) return
      if (replaysInFlight.has(id)) return
      replaysInFlight.add(id)
      replayBtn.classList.add('spinning')
      replayBtn.disabled = true
      try {
        const res = await fetch('/api/agent-replay', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            behavior: entry.behavior,
            repo: entry.repo,
            pr_id: entry.pr_id,
          }),
        })
        if (res.status === 409) {
          const data = await res.json().catch(() => ({}))
          showReplayRefusal(id, typeof data?.error === 'string' && data.error ? data.error : 'Replay refused.')
          return
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`)
        }
        clearReplayRefusal(id)
        // Pull the log right away so the new running row shows up
        // without the user waiting for the 15s poll.
        window.setTimeout(() => { void pollOnce() }, 800)
      } catch (err) {
        console.error('[swarm] replay failed:', err)
        viewFeedback(`swarm-replay:${id}`, 'Swarm replay failed', (err as Error).message)
      } finally {
        replaysInFlight.delete(id)
        // The button that was clicked may have been replaced by a render while
        // the request was out; repaint whichever one is attached now.
        const current = bodyEl.querySelector<HTMLButtonElement>(
          `tr.agent-row[data-id="${id}"] .replay-btn`,
        )
        if (current) {
          current.classList.remove('spinning')
          current.disabled = false
          current.title = 'Replay this run'
        }
      }
      return
    }

    // Target on a run with no pull request → open that conversation.
    const sessionBtn = target.closest<HTMLButtonElement>('.agent-session-link')
    if (sessionBtn) {
      const session = sessionBtn.dataset.session || ''
      if (!session) return
      if (sessionBtn.classList.contains('agent-chat-session')) {
        window.dispatchEvent(new CustomEvent('poise:open-chat-session', { detail: { id: session } }))
        return
      }
      void openImportedSession(sessionBtn, session)
      return
    }

    // Expand chevron — toggles the response body row.
    const expandBtn = target.closest<HTMLButtonElement>('.expand-btn')
    if (!expandBtn) return
    const tr = expandBtn.closest<HTMLTableRowElement>('tr')!
    const id = tr.dataset.id || ''
    if (!id) return
    // The map used to be the only source of truth for open/closed, and it
    // could disagree with the DOM — a double-click, or collapsing a row whose
    // response was still loading, left an entry with no row behind it. The
    // next click then took the collapse branch again and did nothing visible,
    // and the row re-opened by itself on the following render. Trust the DOM
    // for what is on screen and keep the map in step with it.
    const openRow = bodyEl.querySelector<HTMLTableRowElement>(`.agent-expand-row[data-expand-for="${id}"]`)
    if (openRow) {
      openRow.remove()
      expanded.delete(id)
      expandBtn.classList.remove('open')
      expandBtn.setAttribute('aria-expanded', 'false')
      return
    }
    expanded.delete(id)
    expandBtn.classList.add('open')
    expandBtn.setAttribute('aria-expanded', 'true')
    void loadResponse(id)
  })
}

// Find and focus the most-recent log entry for repo+pr_id. Caller is
// responsible for switching to this view first; we await a poll so the data is
// fresh, then scroll the matching row into view and (if completed) expand it
// inline.
export async function focusRow(repo: string, pr_id: string): Promise<void> {
  if (!viewEl || !bodyEl) return
  // An active filter can hide the very row we were asked to focus. Clearing it
  // is what the person meant by following the link — silently doing nothing
  // was not. Server search would exclude it before it loads.
  if (searchQuery) {
    if (searchDebounce) {
      clearTimeout(searchDebounce)
      searchDebounce = null
    }
    searchQuery = ''
    if (searchEl) searchEl.value = ''
    entries = []
    quarantined = []
    totalMatching = 0
    historyCursor = null
    incompleteTotal = null
    loadingHistory = false
    lastLoadedAt = 0
    pageIndex = 0
  }
  // Pull fresh logs so behaviors that just fired show up immediately.
  await pollOnce()
  if (viewEl.hidden) return
  // entries are newest-first per the proxy, so the first match is the most
  // recent run against this pull request. This used to require
  // `behavior === 'pr_review'`, so the "Last triggered" links for approve-prs
  // and resolve-unblocking — which produce pr_approve and other behaviours —
  // matched nothing and the click did nothing.
  const match = await ensureTarget((e) => e.repo === repo && String(e.pr_id) === String(pr_id))
  if (!match) {
    notFocusable(`No run found for ${repo}#${pr_id}.`)
    return
  }
  showRun(match)
  const row = bodyEl.querySelector<HTMLTableRowElement>(`tr.agent-row[data-id="${match.id}"]`)
  if (!row) {
    notFocusable(`The run for ${repo}#${pr_id} is not in the current list.`)
    return
  }
  highlightRow(row)
  // If the run is finished and has a response body, expand it inline.
  // Otherwise (running / failed-without-body) just show the row.
  if (match.status === 'completed' && match.response && !expanded.has(match.id)) {
    const btn = row.querySelector<HTMLButtonElement>('.expand-btn')
    if (btn) { btn.classList.add('open'); btn.setAttribute('aria-expanded', 'true') }
    loadResponse(match.id)
  }
}

const highlightTimers = new WeakMap<HTMLTableRowElement, number>()

function highlightRow(row: HTMLTableRowElement): void {
  viewFeedback('swarm-navigation', 'Swarm run unavailable', '')
  scrollToActor(row, 'center')
  const previous = highlightTimers.get(row)
  if (previous !== undefined) window.clearTimeout(previous)
  // A second navigation to the same row starts its pulse again.
  row.classList.remove('agent-row-focus')
  void row.offsetWidth
  row.classList.add('agent-row-focus')
  highlightTimers.set(row, window.setTimeout(() => {
    row.classList.remove('agent-row-focus')
    highlightTimers.delete(row)
  }, 1500))
}

let callFocusSequence = 0

function showRun(match: LogEntry): void {
  const groups = groupRuns(visible())
  const group = groups.find(candidate => candidate.entries.some(entry => entry.id === match.id))
  if (group && group.entries[0].id !== match.id) expandedGroups.add(group.key)
  const index = groupRows(groups).findIndex(row => row.entry.id === match.id)
  const nextPage = Math.max(0, Math.floor(index / PAGE_SIZE))
  if (nextPage !== pageIndex) clearRows()
  pageIndex = nextPage
  render(false)
}

/** Open the exact run a notification names, including an earlier grouped
 *  failure. The caller makes Swarm visible before asking for it. */
export async function focusCall(callId: string): Promise<void> {
  const mine = ++callFocusSequence
  if (!viewEl || !bodyEl) return
  if (searchQuery) {
    if (searchDebounce) {
      clearTimeout(searchDebounce)
      searchDebounce = null
    }
    searchQuery = ''
    if (searchEl) searchEl.value = ''
    entries = []
    quarantined = []
    totalMatching = 0
    historyCursor = null
    incompleteTotal = null
    loadingHistory = false
    lastLoadedAt = 0
    pageIndex = 0
  }
  await pollOnce()
  if (mine !== callFocusSequence || viewEl.hidden) return
  let match = await ensureTarget((entry) => entry.id === callId)
  if (!match && getSelectedOrganization()) {
    setSelectedOrganization('')
    await pollOnce()
    if (mine !== callFocusSequence || viewEl.hidden) return
    match = await ensureTarget((entry) => entry.id === callId)
  }
  if (!match) {
    notFocusable(`No run found for call ${callId}.`)
    return
  }
  showRun(match)
  const row = bodyEl.querySelector<HTMLTableRowElement>(`tr.agent-row[data-id="${CSS.escape(callId)}"]`)
  if (!row) {
    notFocusable(`The run for call ${callId} is not in the current list.`)
    return
  }
  const detail = row.querySelector<HTMLButtonElement>('.expand-btn')
  if (hasDetail(match) && !expanded.has(callId)) {
    detail?.classList.add('open')
    detail?.setAttribute('aria-expanded', 'true')
    void loadResponse(callId)
  }
  row.tabIndex = -1
  ;(detail ?? row).focus({ preventScroll: true })
  highlightRow(row)
}

// Following a link and landing on nothing, with no explanation, is worse than
// being told the run is not here.
function notFocusable(message: string): void {
  viewFeedback('swarm-navigation', 'Swarm run unavailable', message, 'action_needed')
}

// The in-flight request itself, not just a flag. `focusRow` awaits pollOnce to
// get fresh data before looking for its row; with a bare flag the await
// resolved instantly against an empty list, so the first Behaviors → Swarm
// deep-link of a session silently did nothing and only worked on the second
// click. Callers now join the request that is already running.
let pollInFlight: Promise<void> | null = null
let pollOrganization = ''
let pollSearch = ''
let pollSequence = 0

interface LogFeed { logs?: LogEntry[], quarantined?: QuarantinedLog[], total?: number, nextCursor?: string | null }
let incompleteTotal: number | null = null
let loadingHistory = false
let totalMatching = 0
let historyCursor: string | null = null

const HISTORY_PAGE_LIMIT = 200

async function readLogFeed(url: string): Promise<LogFeed> {
  const res = await fetch(url)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let detail = ''
    try { detail = JSON.parse(text)?.error || '' } catch { detail = text.slice(0, 200) }
    throw new Error(detail ? `${res.status}: ${detail}` : `/api/agent-logs ${res.status}`)
  }
  return res.json()
}

function historyUrl(org: string, cursor: string | null, search: string): string {
  let path = `/api/agent-logs?limit=${HISTORY_PAGE_LIMIT}`
  if (cursor !== null) path += `&cursor=${encodeURIComponent(cursor)}`
  if (search) path += `&search=${encodeURIComponent(search)}`
  return organizationUrl(path, org)
}

async function applyFirstPage(data: LogFeed, total: number, cursor: string | null, current: () => boolean): Promise<void> {
  if (!current()) return
  entries = data.logs || []
  quarantined = Array.isArray(data.quarantined) ? data.quarantined : []
  totalMatching = total
  historyCursor = cursor
  incompleteTotal = historyCursor !== null ? totalMatching : null
  loadingHistory = historyCursor !== null
  lastLoadError = null
  lastLoadedAt = Date.now()
  render()
  renderStaleBanner()
  refreshExpandedDetails()
}

function appendPage(data: LogFeed, cursor: string | null, current: () => boolean): boolean {
  if (!current()) return false
  const seen = new Set(entries.map((entry) => entry.id))
  for (const entry of data.logs || []) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id)
      entries.push(entry)
    }
  }
  const seenQuarantined = new Set(quarantined.map((row) => `${row.id || ''}:${row.index}`))
  for (const row of Array.isArray(data.quarantined) ? data.quarantined : []) {
    const key = `${row.id || ''}:${row.index}`
    if (!seenQuarantined.has(key)) {
      seenQuarantined.add(key)
      quarantined.push(row)
    }
  }
  if (typeof data.total === 'number') totalMatching = data.total
  historyCursor = cursor
  incompleteTotal = historyCursor !== null ? totalMatching : null
  loadingHistory = historyCursor !== null
  lastLoadedAt = Date.now()
  render()
  renderStaleBanner()
  refreshExpandedDetails()
  return true
}

function refreshExpandedDetails(): void {
  for (const entry of entries) {
    const state = expanded.get(entry.id)
    if (state) void loadReasoning(entry.id)
    if (state && !state.loading && state.body === null && entry.response) void loadResponse(entry.id, true)
  }
}

function mergeRefresh(history: LogFeed, running: LogFeed): void {
  const fresh = new Map<string, LogEntry>()
  for (const entry of running.logs || []) fresh.set(entry.id, entry)
  for (const entry of history.logs || []) {
    if (!fresh.has(entry.id)) fresh.set(entry.id, entry)
  }
  const known = new Map(entries.map((entry) => [entry.id, entry]))
  for (const [id, entry] of fresh) known.set(id, entry)
  entries = [...known.values()].sort((a, b) => startedAtMs(b) - startedAtMs(a) || (a.id < b.id ? -1 : 1))
  const seenQuarantined = new Set<string>()
  const mergedQuarantined: QuarantinedLog[] = []
  for (const row of [...(history.quarantined || []), ...(running.quarantined || []), ...quarantined]) {
    const key = `${row.id || ''}:${row.index}:${row.error}`
    if (!seenQuarantined.has(key)) {
      seenQuarantined.add(key)
      mergedQuarantined.push(row)
    }
  }
  quarantined = mergedQuarantined
  if (typeof history.total === 'number') totalMatching = history.total
  // Previously loaded older pages stay valid: new arrivals prepend larger
  // rowids and never shift the cursor into unloaded history.
  incompleteTotal = historyCursor !== null ? totalMatching : null
  loadingHistory = historyCursor !== null
  lastLoadError = null
  lastLoadedAt = Date.now()
  render()
  renderStaleBanner()
  refreshExpandedDetails()
}

async function loadMoreForView(current: () => boolean): Promise<void> {
  while (current() && historyCursor !== null) {
    const org = getSelectedOrganization()
    const search = searchQuery
    const needed = (pageIndex + 1) * PAGE_SIZE
    if (groupRows(groupRuns(visible())).length >= needed) return
    const data = await readLogFeed(historyUrl(org, historyCursor, search))
    if (!current() || org !== getSelectedOrganization() || search !== searchQuery) return
    if (!appendPage(data, data.nextCursor ?? null, current)) return
    if ((data.logs || []).length === 0 && (data.quarantined || []).length === 0 && data.nextCursor) continue
  }
}

function pollOnce(): Promise<void> {
  const org = getSelectedOrganization()
  const search = searchQuery
  if (pollInFlight && pollOrganization === org && pollSearch === search) return pollInFlight
  pollOrganization = org
  pollSearch = search
  const mine = ++pollSequence
  const current = () => mine === pollSequence && org === getSelectedOrganization() && search === searchQuery
  const run = (async () => {
    try {
      const [history, running] = await Promise.all([
        readLogFeed(historyUrl(org, null, search)),
        readLogFeed(organizationUrl('/api/agent-logs?status=running', org)),
      ])
      if (!current()) return
      if (!lastLoadedAt || entries.length === 0) {
        await applyFirstPage(history, history.total ?? (history.logs || []).length, history.nextCursor ?? null, current)
        if (!current()) return
        if ((running.logs || []).length) {
          const known = new Set(entries.map((entry) => entry.id))
          const extra = (running.logs || []).filter((entry) => !known.has(entry.id) && matchesSearch(entry))
          if (extra.length) {
            entries = [...extra, ...entries].sort((a, b) => startedAtMs(b) - startedAtMs(a) || (a.id < b.id ? -1 : 1))
            render()
          }
        }
      } else {
        if (!current()) return
        mergeRefresh(history, running)
      }
      if (!current()) return
      await loadMoreForView(current)
    } catch (err) {
      if (!current()) return
      loadingHistory = historyCursor !== null
      lastLoadError = (err as Error).message
      if (entries.length > 0) render()
      renderStaleBanner()
    } finally {
      if (mine === pollSequence) pollInFlight = null
    }
  })()
  pollInFlight = run
  return run
}

async function ensureTarget(predicate: (entry: LogEntry) => boolean): Promise<LogEntry | undefined> {
  const mine = pollSequence
  const org = getSelectedOrganization()
  const search = searchQuery
  const current = () => mine === pollSequence && org === getSelectedOrganization() && search === searchQuery && viewEl && !viewEl.hidden
  let match = entries.find(predicate)
  while (!match && historyCursor !== null && current()) {
    const data = await readLogFeed(historyUrl(org, historyCursor, search))
    if (!current()) return undefined
    if (!appendPage(data, data.nextCursor ?? null, current)) return undefined
    match = entries.find(predicate)
  }
  return match
}

// Once Swarm had rows, a failing refresh was invisible: the table froze on the
// last good snapshot while the Started column kept ticking every thirty
// seconds, so a dead runtime read as a live one — statuses stuck on 'running',
// no new runs, and nothing to suggest looking elsewhere. Unreadable rows are
// now isolated, with a warning alongside the remaining live results.
let lastLoadError: string | null = null
let lastLoadedAt = 0

function renderStaleBanner(): void {
  const partial = incompleteTotal === null ? '' : `Only ${entries.length} of ${incompleteTotal} runs loaded.`
  viewDiagnostic('swarm-history', loadingHistory ? `Loading older runs. ${partial}` : '')
  const age = lastLoadedAt ? new Date(lastLoadedAt).toISOString() : 'none'
  viewFeedback('swarm-read', 'Swarm is not updating', lastLoadError
    ? `${lastLoadError}. Last successful read: ${age}. ${partial}` : '', 'read_failed')
  viewFeedback('swarm-records', 'Unreadable Swarm records', quarantined.length
    ? `${quarantined.length} unreadable worker log row(s) isolated. Other runs continue updating.\n`
      + quarantined.map(quarantineDescription).join('\n')
    : '', 'read_failed')
}

// The Started column shows a relative time ("3m") computed at render.
// Polling only re-renders every 1–5 min, so between polls every
// Started cell is stale. This ticker re-derives just the Started text
// from data already in hand — no fetch — every 5s, so the column
// stays live. Created once; cheap enough (a handful of text comparisons) to
// leave running for the app's lifetime.
const STARTED_TICK_MS = 5_000
let startedTickTimer: ReturnType<typeof setInterval> | null = null

function refreshStartedCells(): void {
  if (!bodyEl || !viewEl || viewEl.hidden) return
  const byId = new Map(entries.map((e) => [e.id, e]))
  for (const row of bodyEl.querySelectorAll<HTMLElement>('.agent-row')) {
    const id = row.dataset.id
    if (!id) continue
    const e = byId.get(id)
    if (!e) continue
    const cell = row.querySelector<HTMLElement>('.started-cell .date')
    if (cell) {
      const next = startedRel(e)
      if (cell.textContent !== next) {
        cell.textContent = next
      }
    }
    // Elapsed ticks alongside Started for a run still going. It used to hold
    // whatever the last data poll said, so a running agent's elapsed sat still
    // for up to five minutes while Started counted up next to it.
    const elapsedEl = row.querySelector<HTMLElement>('.elapsed-cell .date')
    if (elapsedEl) {
      const nextElapsed = elapsedText(e)
      if (elapsedEl.textContent !== nextElapsed) elapsedEl.textContent = nextElapsed
    }
  }
  for (const row of bodyEl.querySelectorAll<HTMLElement>('.agent-row')) {
    const e = byId.get(row.dataset.id || '')
    const summary = row.querySelector<HTMLElement>('.agent-progress-summary')
    if (e && summary) {
      const text = progressText(e)
      if (summary.textContent !== text) {
        summary.textContent = text
        summary.title = text
      }
    }
  }
  for (const row of bodyEl.querySelectorAll<HTMLTableRowElement>('.agent-expand-row')) {
    const e = byId.get(row.dataset.expandFor || '')
    if (e) refreshRunDetail(row, e)
  }
  renderStaleBanner()
}

export async function initSwarmView() {
  viewEl = document.getElementById('view-swarm')!
  if (!initialized) {
    initialized = true
    renderShell()
    attachClicks()
    window.addEventListener('poise:organization-filter-changed', () => {
      entries = []
      quarantined = []
      lastLoadError = null
      lastLoadedAt = 0
      incompleteTotal = null
      loadingHistory = false
      totalMatching = 0
      historyCursor = null
      pageIndex = 0
      clearRows()
      viewEl.querySelector<HTMLElement>('#swarm-table')!.hidden = true
      viewEl.querySelector<HTMLElement>('#swarm-count')!.textContent = ''
      expanded.clear()
      expandedGroups.clear()
      openReasoning.clear()
      displayedGroups.clear()
      render()
      renderStaleBanner()
      if (!viewEl.hidden) void pollOnce()
    })
  }
  if (lastLoadedAt) queueMicrotask(() => { render(false); renderStaleBanner() })
  startSwarmPolling()
  if (!startedTickTimer) startedTickTimer = setInterval(refreshStartedCells, STARTED_TICK_MS)
  await pollOnce()
}

export function stopSwarmRefresh() {
  importedSessionOpenRequestId++
  if (initialized) clearRows()
  if (progressPoll) clearInterval(progressPoll)
  progressPoll = null
  if (swarmListening) {
    window.removeEventListener('poise:refresh-tick', onSwarmTick)
    swarmListening = false
  }
}

function startSwarmPolling() {
  if (swarmListening) return
  window.addEventListener('poise:refresh-tick', onSwarmTick)
  progressPoll = setInterval(() => {
    if (!viewEl.hidden && entries.some(isRunning)) void pollOnce()
  }, 15_000)
  swarmListening = true
}
