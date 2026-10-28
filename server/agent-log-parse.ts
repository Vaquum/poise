// Pure Caller-log decoding: row validation, quarantine and snapshot shaping.
//
// No I/O, no process spawning, no ledger: the parse worker thread runs
// this module, and the main thread imports it for small reads. Both paths
// share one implementation, so off-thread decoding cannot drift.

import { parseProgress, type ModelProgress } from '../src/agent-progress'
import { parseProcessDiagnostic, type ProcessDiagnostic } from './process-diagnostic'

export interface LogEntry {
  id: string
  pr_id: string | null
  repo: string | null
  actor: string | null
  model: string
  behavior: string | null   // agent-interface behavior name (pr-review, mergeable, etc.)
  session_id: string | null
  prompt: string
  started_at: string
  started_at_precise?: string | null
  completed_at?: string | null
  time_elapsed: string
  status: string
  progress?: ModelProgress | null
  outcome: 'clean' | 'changes_requested' | 'approved' | 'superseded' | 'preflight_failed' | 'commented' | null
  head_sha: string | null
  expected_head: string | null
  source: string | null
  correlation_id: string | null
  action: 'reviewed_clean' | 'requested_changes' | 'approved' | 'not_started' | 'commented' | null
  response: string | null // upstream 8-char availability marker; read by full `id`
  error: string
  review_policy?: string | null
  recovery_model?: string | null
  diagnostic?: ProcessDiagnostic | null
  error_code?: string | null
  // The GitHub review this run submitted (Caller's receipt); tells a
  // reviewer's review apart from a sibling's on the same pull request.
  review_id?: number | null
  // The inline comments a change request posted; null when unknown or not one.
  review_comments?: number | null
  // Issue review only: null until the run starts posting; from then on the
  // comments it knows it posted. A failed run with receipts must never be
  // relaunched on its own — it may already have commented.
  receipts?: IssueCommentReceipt[] | null
  // `external` for a Chat turn Poise recorded through `--record-turn`: no
  // Caller process ran, so `--stop` refuses it and Poise routes it to its
  // own runtime.
  runner?: 'external' | null
}

export interface IssueCommentReceipt {
  issue: string
  comment_id: number
  url: string | null
  author: string
}

// An issue review runs against the issue, not a pull-request head, so its
// rows carry no expected or terminal head.
export const ISSUE_REVIEW_BEHAVIOR = 'issue_review'

function parseReceipts(value: unknown): IssueCommentReceipt[] | null {
  if (value === null || value === undefined) return null
  // Anything else that is present means posting began; keep what can be read.
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const receipt = item as Record<string, unknown> | null
    return receipt && typeof receipt.issue === 'string' && Number.isSafeInteger(receipt.comment_id)
      && (receipt.url === null || receipt.url === undefined || typeof receipt.url === 'string')
      && typeof receipt.author === 'string'
      ? [{ issue: receipt.issue, comment_id: Number(receipt.comment_id), url: (receipt.url as string | undefined) ?? null, author: receipt.author }]
      : []
  })
}

export interface QuarantinedAgentLog {
  // A readable lifecycle hint can retain running capacity; it never proves
  // the rejected result's action or outcome.
  status?: string | null
  source?: string | null
  startedAt?: string | null
  index: number
  error: string
  id: string | null
  correlationId: string | null
  repo: string | null
  prId: string | null
  behavior: string | null
  sessionId: string | null
}

export interface AgentLogSnapshot {
  entries: LogEntry[]
  quarantined: QuarantinedAgentLog[]
}

export type AgentLogIdentity = Partial<Pick<QuarantinedAgentLog,
  'id' | 'correlationId' | 'repo' | 'prId' | 'behavior' | 'sessionId'>>

const LOG_CALL_ID = /^[0-9a-f]{32}$/
const LOG_STATUS = /^(?:pending|queued|running|in_progress|completed|superseded|invalid|failed|error|cancelled|canceled|timed_out|timeout)$/
const LOG_PR_ID = /^[1-9][0-9]*$/
const LOG_REPO = /^[^/\s]+(?:\/[^/\s]+)?$/
const LOG_CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function quarantineLogEntry(value: unknown, index: number, error: unknown): QuarantinedAgentLog {
  const row = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const text = (key: string, pattern?: RegExp, lowercase = false): string | null => {
    const raw = row[key]
    if (typeof raw !== 'string' || !raw) return null
    const result = lowercase ? raw.toLowerCase() : raw
    return !pattern || pattern.test(result) ? result : null
  }
  const started = row.started_at_precise ?? row.started_at
  return {
    index,
    status: text('status', LOG_STATUS, true),
    source: text('source', /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/),
    startedAt: typeof started === 'string' && Number.isFinite(Date.parse(started)) ? started : null,
    error: error instanceof Error ? error.message : String(error),
    id: text('id', LOG_CALL_ID, true),
    correlationId: text('correlation_id', LOG_CORRELATION_ID),
    repo: text('repo', LOG_REPO),
    prId: text('pr_id', LOG_PR_ID),
    behavior: text('behavior'),
    sessionId: text('session_id'),
  }
}

function sameLogIdentity(row: QuarantinedAgentLog, identity: AgentLogIdentity): boolean {
  return !!((row.id && identity.id && row.id.toLowerCase() === identity.id.toLowerCase())
    || (row.correlationId && identity.correlationId && row.correlationId === identity.correlationId))
}

/** Unreadable identity is uncertainty, never proof that a call is absent. */
export function quarantinedLogMayMatch(row: QuarantinedAgentLog, identity: AgentLogIdentity): boolean {
  // A duplicate call/correlation identity must remain suspect even when the
  // malformed row contradicts other provenance on an otherwise valid call.
  if (sameLogIdentity(row, identity)) return true
  for (const key of ['id', 'correlationId', 'repo', 'prId', 'behavior', 'sessionId'] as const) {
    const actual = row[key]
    const expected = identity[key]
    if (!actual || !expected) continue
    if (key === 'repo') {
      // Historical rows can name only the repository; its owner is unknown.
      const qualified = actual.includes('/') && expected.includes('/')
      const actualRepo = qualified ? actual : actual.split('/').at(-1)!
      const expectedRepo = qualified ? expected : expected.split('/').at(-1)!
      if (actualRepo.toLowerCase() !== expectedRepo.toLowerCase()) return false
    } else if (key === 'id') {
      if (actual.toLowerCase() !== expected.toLowerCase()) return false
    } else if (actual !== expected) return false
  }
  return true
}

function validateLogEntry(value: unknown, index: number): LogEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`agent-interface log row ${index} is not an object`)
  }
  const row = value as Record<string, unknown>
  // An absent field and an explicit null both mean "this row does not have
  // one". Only `null` was accepted, so a row written before agent-interface
  // added a field — `expected_head`, `source`, `correlation_id`, `action` —
  // omits the key entirely, `row[field]` is undefined, and validation threw.
  // Previously one such row rejected the whole batch: with 1044 rows in the
  // log and the oldest dating to May, Swarm served a 502 and rendered nothing.
  // Absent is null; genuinely unreadable rows now retain a quarantine identity.
  const optionalString = (field: string): string | null => {
    const item = row[field]
    if (item === null || item === undefined) return null
    if (typeof item !== 'string') {
      throw new Error(`agent-interface log row ${index} has invalid ${field}`)
    }
    return item
  }
  const requiredString = (field: string): string => {
    const item = row[field]
    if (typeof item !== 'string') {
      throw new Error(`agent-interface log row ${index} has invalid ${field}`)
    }
    return item
  }
  const id = requiredString('id').toLowerCase()
  const prId = optionalString('pr_id')
  const repo = optionalString('repo')
  const actor = optionalString('actor')
  const behavior = optionalString('behavior')
  const sessionId = optionalString('session_id')
  const startedAt = requiredString('started_at')
  const startedAtPrecise = optionalString('started_at_precise')
  const completedAt = optionalString('completed_at')
  const status = requiredString('status')
  const outcome = optionalString('outcome')
  const headSha = optionalString('head_sha')
  const expectedHead = optionalString('expected_head')
  const source = optionalString('source')
  const correlationId = optionalString('correlation_id')
  const action = optionalString('action')
  const error = optionalString('error') || ''
  const preflightFailed = status === 'failed'
    && action === 'not_started'
    && outcome === 'preflight_failed'
    && headSha === null
  const issueReview = behavior === ISSUE_REVIEW_BEHAVIOR
  if (!LOG_CALL_ID.test(id)
    || (prId !== null && !LOG_PR_ID.test(prId))
    || (repo !== null && !LOG_REPO.test(repo))
    || (actor !== null
      && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/.test(actor))
    || !Number.isFinite(Date.parse(startedAt))
    || (startedAtPrecise !== null && !Number.isFinite(Date.parse(startedAtPrecise)))
    || (completedAt !== null && !Number.isFinite(Date.parse(completedAt)))
    || !['clean', 'changes_requested', 'approved', 'superseded', 'preflight_failed', 'commented', null].includes(outcome)
    || (headSha !== null && !/^[0-9a-f]{40}$/.test(headSha))
    || (expectedHead !== null && !/^[0-9a-f]{40}$/.test(expectedHead))
    || !['reviewed_clean', 'requested_changes', 'approved', 'not_started', 'commented', null].includes(action)
    || ((action === 'commented' || outcome === 'commented') && !issueReview)
    || ((action === 'not_started' || outcome === 'preflight_failed') && !preflightFailed)
    || (source !== null && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(source))
    || (correlationId !== null && !LOG_CORRELATION_ID.test(correlationId))) {
    throw new Error(`agent-interface log row ${index} violates the schema`)
  }
  const runner = optionalString('runner')
  if (runner !== null && runner !== 'external') {
    throw new Error(`agent-interface log row ${index} has invalid runner`)
  }
  // A Chat turn is a Caller row without a Caller process: it is exempt from
  // the review provenance rules only when it is exactly the well-formed
  // externally recorded shape (runner, behavior and source all agree).
  const externalChatTurn = runner === 'external' && behavior === 'chat' && source === 'poise:chat'
  if (externalChatTurn) {
    if (!sessionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sessionId)) {
      throw new Error(`agent-interface log row ${index} is a chat turn without a session`)
    }
    if (status === 'failed' && !error) {
      throw new Error(`agent-interface log row ${index} has no terminal error`)
    }
  } else if (runner === 'external') {
    throw new Error(`agent-interface log row ${index} is externally recorded but not a chat turn`)
  }
  if (source?.startsWith('poise:') && !externalChatTurn) {
    if (!actor || (!expectedHead && !issueReview) || !correlationId || !behavior
      || !repo || !/^[^/\s]+\/[^/\s]+$/.test(repo) || !prId) {
      throw new Error(`agent-interface log row ${index} has incomplete Poise provenance`)
    }
    if (status === 'completed' && (!completedAt || !action || !outcome || (!headSha && !issueReview))) {
      throw new Error(`agent-interface log row ${index} has incomplete terminal outcome`)
    }
    if (status === 'failed' && !error) {
      throw new Error(`agent-interface log row ${index} has no terminal error`)
    }
    if (status === 'superseded'
      && (!completedAt || outcome !== 'superseded' || !headSha || action !== null)) {
      throw new Error(`agent-interface log row ${index} has incomplete superseded outcome`)
    }
  }
  return {
    id,
    pr_id: prId,
    repo,
    actor,
    model: requiredString('model'),
    behavior,
    session_id: sessionId,
    prompt: requiredString('prompt'),
    started_at: startedAt,
    started_at_precise: startedAtPrecise,
    completed_at: completedAt,
    time_elapsed: requiredString('time_elapsed'),
    status,
    progress: parseProgress(row.progress),
    outcome: outcome as LogEntry['outcome'],
    head_sha: headSha,
    expected_head: expectedHead,
    source,
    correlation_id: correlationId,
    action: action as LogEntry['action'],
    response: optionalString('response'),
    error,
    error_code: optionalString('error_code'),
    diagnostic: parseProcessDiagnostic(row.diagnostic),
    review_policy: optionalString('review_policy'),
    recovery_model: optionalString('recovery_model'),
    review_id: Number.isSafeInteger(row.review_id) && Number(row.review_id) > 0 ? Number(row.review_id) : null,
    review_comments: Number.isSafeInteger(row.review_comments) && Number(row.review_comments) >= 0 ? Number(row.review_comments) : null,
    receipts: parseReceipts(row.receipts),
    runner: runner as LogEntry['runner'],
  }
}

/** Apply one consumer's scope to a shared snapshot without rereading the CLI. */
export function scopedAgentLogs(snapshot: AgentLogSnapshot, identity?: AgentLogIdentity): LogEntry[] {
  const exact = identity?.id
    ? snapshot.entries.find((row) => row.id === identity.id!.toLowerCase())
    : undefined
  const scoped = identity ? snapshot.entries.filter((entry) => {
    const values: AgentLogIdentity = {
      id: entry.id, correlationId: entry.correlation_id, repo: entry.repo,
      prId: entry.pr_id, behavior: entry.behavior, sessionId: entry.session_id,
    }
    return Object.entries(identity).every(([field, expected]) => {
      if (!expected) return true
      const actual = values[field as keyof AgentLogIdentity]
      if (!actual) return false
      return field === 'id' || field === 'repo'
        ? actual.toLowerCase() === expected.toLowerCase()
        : actual === expected
    })
  }) : []
  const rejected = snapshot.quarantined.find((row) => {
    if (!identity) return true
    if (exact) {
      // A verified exact-ID result does not infer absence from the rest of
      // the feed. Conflicting duplicates still invalidate that result.
      return sameLogIdentity(row, identity)
        || sameLogIdentity(row, { id: exact.id, correlationId: exact.correlation_id })
    }
    if (scoped.some((entry) => sameLogIdentity(row, { id: entry.id, correlationId: entry.correlation_id }))) return true
    return quarantinedLogMayMatch(row, identity)
  })
  if (rejected) throw new Error(rejected.error)
  return snapshot.entries
}

// Decode one whole-log read. Caller prints oldest-first; the snapshot is
// newest-first so callers never carry the convention. Unfrozen: freezing
// happens on the main thread, since a worker's freeze does not survive the
// trip back.
export function parseAgentLogStdout(stdout: string, source: string): AgentLogSnapshot {
  const trimmed = stdout.trim()
  if (!trimmed) throw new Error(`${source} returned empty output`)
  let list: unknown
  try { list = JSON.parse(trimmed) }
  catch (error) {
    throw new Error(`${source} returned invalid JSON`, { cause: error })
  }
  if (!Array.isArray(list)) throw new Error(`${source} returned non-array JSON`)
  return parseAgentLogList(list)
}

export function parseAgentLogList(list: unknown[]): AgentLogSnapshot {
  const entries: LogEntry[] = []
  const quarantined: QuarantinedAgentLog[] = []
  list.forEach((value, index) => {
    try { entries.push(validateLogEntry(value, index)) }
    catch (error) { quarantined.push(quarantineLogEntry(value, index, error)) }
  })
  return { entries: entries.reverse(), quarantined }
}

// Decode one bounded history page. Strict envelope: a bare row array is a
// whole-log read, never a page, so it fails loud instead of silently ending
// the walk early. Total counts all matching rows without loading them.
export function parseAgentLogPage(stdout: string, source: string): AgentLogSnapshot & { nextCursor: string | null, total: number } {
  const trimmed = stdout.trim()
  if (!trimmed) throw new Error(`${source} returned empty output`)
  let page: unknown
  try { page = JSON.parse(trimmed) }
  catch (error) {
    throw new Error(`${source} returned invalid JSON`, { cause: error })
  }
  const envelope = page !== null && typeof page === 'object' && !Array.isArray(page)
    ? page as Record<string, unknown>
    : null
  const rows = envelope?.rows
  const nextCursor = envelope?.nextCursor ?? null
  const total = envelope?.total
  if (!envelope || !Array.isArray(rows) || !(nextCursor === null || typeof nextCursor === 'string')
    || typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) {
    throw new Error(`${source} returned an invalid page`)
  }
  return { ...parseAgentLogList(rows), nextCursor, total }
}

// Co-waiters alias one snapshot; freezing makes misuse fail loud.
export function freezeAgentLogSnapshot(snapshot: AgentLogSnapshot): AgentLogSnapshot {
  for (const row of snapshot.entries) Object.freeze(row)
  for (const row of snapshot.quarantined) Object.freeze(row)
  Object.freeze(snapshot.entries)
  Object.freeze(snapshot.quarantined)
  return Object.freeze(snapshot)
}
