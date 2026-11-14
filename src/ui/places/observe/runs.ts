// Observe → Behaviors: every agent run, as GET /api/agent-logs serves it.
// Pure mappings copied from classic's Swarm (src/views/swarm-view.ts), whose
// module keeps them private: when a run started, how long it ran, which runs
// are identical, what the filter matches, and the unreadable records. What is
// new is the status in the seven state words, then the outcome (#556, Design →
// Vocabulary), and the behaviors' own names.
import { PHASE_LABELS, type ModelProgress } from '../../../agent-progress'
import { issueReviewSuperseded } from '../../../../gateway/src/diagnostics/caller-outcome'
import type { StateKey } from './chains'

export interface LogEntry {
  id: string
  pr_id: string | null
  repo: string | null
  actor: string | null
  model: string
  recovery_model?: string | null
  behavior: string | null
  session_id: string | null
  source?: string | null
  prompt: string
  started_at: string
  started_at_precise: string | null
  completed_at: string | null
  time_elapsed: string
  status: string
  progress?: ModelProgress | null
  outcome: 'clean' | 'changes_requested' | 'approved' | 'superseded' | 'preflight_failed' | 'commented' | null
  response: string | null
  error: string
  error_code?: string | null
  head_sha?: string | null
  expected_head?: string | null
  action?: string | null
  review_policy?: string | null
  review_id?: number | null
  review_comments?: number | null
  receipts?: Array<{ issue: string, comment_id: number, url: string | null, author: string }> | null
  runner?: string | null
}

export interface QuarantinedLog {
  index: number
  historyRowId?: string
  error: string
  id: string | null
  correlationId: string | null
  repo: string | null
  prId: string | null
  behavior: string | null
  sessionId: string | null
}

export interface LogFeed { logs?: LogEntry[], quarantined?: QuarantinedLog[], total?: number, nextCursor?: string | null }

/** When a run started, as an exact instant: the precise UTC time when there is one, else the naive local one. */
export function startedAtMs(e: Pick<LogEntry, 'started_at' | 'started_at_precise'>): number {
  const precise = e.started_at_precise ? new Date(e.started_at_precise).getTime() : NaN
  if (isFinite(precise)) return precise
  return e.started_at ? new Date(e.started_at).getTime() : NaN
}

/** s, m, h, d, mo, y: the vocabulary every live view counts in. */
export function relFromMs(t: number, now = Date.now()): string {
  if (!isFinite(t)) return '—'
  const secs = Math.max(0, Math.floor((now - t) / 1000))
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`
  const days = Math.floor(secs / 86400)
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(months / 12)}y`
}

export const isRunning = (e: LogEntry): boolean => e.status === 'running' && !e.completed_at

/** How long it ran, or has run so far: a running run counts up live; an unknown duration is —, never 0. */
export function elapsedText(e: LogEntry, now = Date.now()): string {
  const running = !e.completed_at && e.status !== 'completed' && e.status !== 'failed' && e.status !== 'error'
  if (!running) return e.time_elapsed || '—'
  const started = startedAtMs(e)
  if (!isFinite(started)) return e.time_elapsed || '—'
  const secs = Math.max(0, Math.floor((now - started) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ${secs % 60}s`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

// ---------- Identical runs share a row ----------
export interface RunGroup { key: string, entries: LogEntry[] }
const TERMINAL = new Set(['completed', 'failed', 'error', 'superseded', 'cancelled', 'canceled', 'stopped', 'timed_out', 'timeout'])

/** Finished runs with the same input and the same result share a row. A run with a response, or still
 *  going, is never grouped: its output is not proven identical. */
export function groupRuns(list: readonly LogEntry[]): RunGroup[] {
  const groups = new Map<string, RunGroup>()
  for (const entry of list) {
    const p = entry.progress
    const key = entry.response || p?.reasoning_available || !TERMINAL.has(entry.status.toLowerCase())
      ? JSON.stringify(['call', entry.id])
      : JSON.stringify([
        'result', entry.repo, entry.pr_id, entry.actor, entry.model, entry.recovery_model ?? null,
        entry.behavior, entry.session_id, entry.source ?? null, entry.prompt,
        entry.status, entry.outcome, entry.error, entry.error_code ?? null,
        entry.head_sha ?? null, entry.expected_head ?? null, entry.action ?? null,
        entry.review_policy ?? null, entry.review_id ?? null, entry.receipts ?? null, entry.runner ?? null,
        issueReviewSuperseded(entry),
      ])
    const group = groups.get(key)
    if (group) group.entries.push(entry)
    else groups.set(key, { key, entries: [entry] })
  }
  return [...groups.values()]
}

// ---------- Names ----------
/** The behaviors' own names, as Settings → Behaviors and Overview say them. */
const BEHAVIOR_NAMES: Record<string, string> = {
  pr_review: 'Review New Pull Requests', pr_approve: 'Approve Pull Requests', issue_review: 'Review New Issues',
  implement_issue: 'Implement Issues', repair_pr: 'Repair Pull Requests', resolve: 'Resolve Unblocking Conversations',
  resolve_unblocking: 'Resolve Unblocking Conversations', rerun_grey_ci: 'Rerun Grey CI', merge_prs: 'Merge Pull Requests',
  fix_issue: 'Fix issue', chat: 'Chat', editor_chat: 'Editor chat',
}

/** A chain's own GitHub action runs one fixed command and no model. It names what it did, such as
 *  Merge if ready (#857); the words come from the raw prompt, which the server's search reads. */
export function nativeAction(e: LogEntry): string | null {
  if (e.model !== 'native-action') return null
  return e.behavior === 'native_publication' ? 'publication' : e.prompt.replace(/^--/, '')
}

export function behaviorName(e: LogEntry): string {
  const action = nativeAction(e)
  if (action) return (action.charAt(0).toUpperCase() + action.slice(1)).replace(/-/g, ' ').replace(/\bci\b/gi, 'CI')
  return e.behavior ? BEHAVIOR_NAMES[e.behavior] ?? e.behavior : '—'
}

/** The model that ran it, with the one it recovered on; a native action ran none. */
export function modelName(e: LogEntry): string {
  if (nativeAction(e)) return ''
  return e.recovery_model ? `${e.model} → ${e.recovery_model}` : e.model
}

/** The raw behavior a search for its name means, so the server's search finds what the column shows. */
export function serverSearch(query: string): string {
  const q = query.trim().toLowerCase()
  if (!q) return ''
  const named = Object.entries(BEHAVIOR_NAMES).filter(([raw, name]) => name.toLowerCase().includes(q) && !raw.includes(q))
  const raws = new Set(named.map(([raw]) => raw))
  return raws.size === 1 && named.length ? named[0][0] : query.trim()
}

const SESSION_LABEL_MAX = 26
export function sessionLabel(sessionId: string): string {
  let label = sessionId
  const editor = /^editor-(.+)-\d+$/.exec(sessionId)
  if (editor) label = editor[1]
  if (label.length <= SESSION_LABEL_MAX) return label
  return `${label.slice(0, SESSION_LABEL_MAX - 1)}…`
}

/** A turn Chat ran: Caller records it with behavior chat and source poise:chat. */
export const isChatTurn = (e: LogEntry): boolean => e.behavior === 'chat' && e.source === 'poise:chat' && !!e.session_id

export function targetText(e: LogEntry): string {
  const repo = e.repo || ''
  const pr = e.pr_id ? String(e.pr_id) : ''
  if (repo || pr) return repo && pr ? `${repo}#${pr}` : (repo || `#${pr}`)
  return e.session_id ? sessionLabel(e.session_id) : ''
}

export function repoParts(e: LogEntry): { owner: string, name: string } {
  const repo = e.repo || ''
  const slash = repo.indexOf('/')
  return slash < 0 ? { owner: '', name: repo } : { owner: repo.slice(0, slash), name: repo.slice(slash + 1) }
}

/** Seed review and implementation target the issue; everything else the pull request. */
export const targetKind = (e: LogEntry): 'issues' | 'pull' => (e.behavior === 'issue_review' || e.behavior === 'implement_issue' ? 'issues' : 'pull')

/** What the filter matches: what the columns show, errors and outcomes included. */
export function matchesSearch(e: LogEntry, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  const status = statusOf(e)
  return [
    e.id, e.model, e.recovery_model, e.behavior, behaviorName(e), e.prompt, e.status, e.actor, e.repo, e.pr_id,
    targetText(e), e.session_id, e.outcome, status.word, status.note, e.error,
  ].some((f) => (f || '').toLowerCase().includes(q))
}

export const isReplayable = (e: LogEntry): boolean =>
  (e.behavior === 'pr_review' || e.behavior === 'pr_approve' || e.behavior === 'issue_review') && !!e.repo && !!e.pr_id

// ---------- Status: a state word, then the outcome ----------
/** What a running run is doing, and amber when its heartbeat or provider has gone quiet. */
export function progressText(e: LogEntry, now = Date.now()): { text: string, warn: boolean } {
  const p = e.progress
  if (!p) return { text: 'Progress unavailable for this run', warn: false }
  const heartbeatAge = now - Date.parse(p.heartbeat_at)
  const providerAge = p.last_provider_event_at ? now - Date.parse(p.last_provider_event_at) : null
  const label = PHASE_LABELS[p.phase] || 'Unknown activity'
  if (heartbeatAge > 30_000) return { text: `Worker heartbeat missing for ${relFromMs(Date.parse(p.heartbeat_at), now)}; last: ${label.toLowerCase()}`, warn: true }
  if (p.warning) return { text: `Progress incomplete; last: ${label.toLowerCase()}`, warn: true }
  if (providerAge !== null && providerAge > 60_000 && ['waiting_provider', 'reasoning', 'responding', 'retrying', 'preparing_tool', 'tool_requested'].includes(p.phase)) {
    return { text: `No provider update for ${relFromMs(Date.parse(p.last_provider_event_at!), now)}; last: ${label.toLowerCase()}`, warn: true }
  }
  return { text: `${label} · ${relFromMs(Date.parse(p.phase_started_at), now)} in stage`, warn: false }
}

/** What a finished review concluded, or why it was superseded. */
export function reviewNote(e: LogEntry): string {
  if (e.outcome === 'superseded' || e.status === 'superseded') {
    if (e.head_sha && e.expected_head && e.head_sha !== e.expected_head) return 'New commits arrived while it ran'
    return 'The pull request was closed, merged or made a draft'
  }
  if (e.behavior !== 'pr_review' && e.behavior !== 'pr_approve') return ''
  if (e.outcome === 'changes_requested' && typeof e.review_comments === 'number') return e.review_comments === 1 ? '1 comment' : `${e.review_comments} comments`
  return ''
}

const firstLine = (value: string | null | undefined): string => (value || '').trim().split('\n')[0]

/** The run in the seven state words, then what it concluded (#556, Design → Vocabulary). */
export function statusOf(e: LogEntry, now = Date.now()): { state: StateKey, word: string, note: string, warn: boolean } {
  const status = (e.status || '').toLowerCase()
  if (isRunning(e)) { const p = progressText(e, now); return { state: 'running', word: 'Running', note: p.text, warn: p.warn } }
  const failure = firstLine(e.error)
  if (issueReviewSuperseded(e)) return { state: 'idle', word: 'Superseded', note: 'Issue changed', warn: false }
  if (e.outcome === 'approved') return { state: 'done', word: 'Approved', note: reviewNote(e), warn: false }
  if (e.outcome === 'clean') return { state: 'done', word: 'No comments', note: '', warn: false }
  if (e.outcome === 'changes_requested') return { state: 'done', word: 'Changes requested', note: reviewNote(e), warn: false }
  if (e.outcome === 'commented') return { state: 'done', word: 'Commented', note: '', warn: false }
  if (e.outcome === 'superseded' || status === 'superseded') return { state: 'idle', word: 'Superseded', note: reviewNote(e), warn: false }
  if (e.outcome === 'preflight_failed') return { state: 'failed', word: 'Preflight failed', note: failure, warn: false }
  if (e.error_code === 'stopped') return { state: 'idle', word: 'Stopped by you', note: '', warn: false }
  if (status === 'cancelled' || status === 'canceled' || status === 'stopped') return { state: 'idle', word: 'Cancelled', note: failure, warn: false }
  if (status === 'timeout' || status === 'timed_out') return { state: 'failed', word: 'Timed out', note: failure, warn: false }
  if (status === 'failed' || status === 'error') return { state: 'failed', word: 'Failed', note: failure, warn: false }
  if (status === 'completed') return { state: 'done', word: 'Done', note: reviewNote(e), warn: false }
  if (['queued', 'pending', 'waiting'].includes(status)) return { state: 'waiting', word: 'Waiting', note: failure, warn: false }
  return { state: 'idle', word: status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Unknown', note: failure, warn: false }
}

// ---------- Estimates (main's server/behavior-estimates.ts) ----------
export type RunEstimate = { remainingMs: number, basis: { medianMs: number, p90Ms: number }, samples: number }
  | { overrun: true, basis: { medianMs: number, p90Ms: number } }

/** How long a running run likely has left, from similar runs; past their 90th percentile, Longer than usual. */
export function estimateText(e: LogEntry, estimate: RunEstimate | null | undefined, now = Date.now()): { text: string, warn: boolean } | null {
  if (!estimate || !isRunning(e)) return null
  const elapsed = now - startedAtMs(e)
  if (!Number.isFinite(elapsed)) return null
  const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000))
  if ('overrun' in estimate || elapsed >= estimate.basis.p90Ms) return { text: `Longer than usual · similar runs took ${minutes(estimate.basis.medianMs)} min`, warn: true }
  return { text: `≈ ${minutes(estimate.basis.medianMs - elapsed)} min left`, warn: false }
}

// ---------- Unreadable records, kept apart ----------
export function quarantineKey(row: QuarantinedLog): string {
  if (row.historyRowId) return `history:${row.historyRowId}`
  if (row.id) return `call:${row.id}`
  return `legacy:${row.index}:${row.error}`
}

export function mergeQuarantined(previous: readonly QuarantinedLog[], fresh: readonly QuarantinedLog[]): QuarantinedLog[] {
  const byKey = new Map(previous.map((row) => [quarantineKey(row), row]))
  for (const row of fresh) byKey.set(quarantineKey(row), row)
  return [...byKey.values()]
}

export function quarantineDescription(row: QuarantinedLog): string {
  const target = row.repo || row.prId
    ? `Reported target: ${row.repo || 'unknown repository'}${row.prId ? `#${row.prId}` : ''}`
    : row.sessionId ? `Reported session: ${row.sessionId}` : 'Target unknown'
  const position = row.historyRowId ? `History row: ${row.historyRowId}` : `Log index: ${row.index}`
  const error = row.historyRowId ? row.error.replace(/^(Caller History|agent-interface log) row [0-9]+\b/, '$1 record') : row.error
  return [target, `Call: ${row.id || 'unknown'}`, row.correlationId ? `Correlation: ${row.correlationId}` : '',
    row.behavior ? `Behavior: ${row.behavior}` : '', row.sessionId ? `Session: ${row.sessionId}` : '', position, error].filter(Boolean).join(' · ')
}
