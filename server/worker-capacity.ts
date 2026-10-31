// Worker capacity and the idle-backlog alert (#675).
//
// The Manager dispatches enhancement tickets to worker chats, up to its
// Rhythm slots. When slots sit idle while no unassigned enhancement ticket
// is open, nobody notices until the owner looks. This module shows that
// capacity in Manager/behavior status and raises one owner notification.
//
// Capacity: worker chats occupying slots (role worker, not closed) versus
// the configured target (Manager Rhythm), plus the count of open
// unassigned tickets carrying the work label. Unassigned means no chat
// holds a Poise work binding for it; GitHub assignees are not consulted,
// since Poise workers bind rather than assign.
//
// Backlog comes from the local datastore (label filter, no GitHub API);
// candidates for the alert come from `gh search` only while the alert
// condition holds, so the steady state costs no API calls.
import { db, getMeta, setMeta } from './db'
import { organizationArgs, readyOrganizations } from './organizations'
import { runFile } from './process'
import { getManagerSettings } from './settings'
import { openAlerts, raiseAlert, resolveAlert, updateAlertDetails } from './alerts/store'

/** The GitHub label whose open unassigned tickets are the Manager's backlog. */
export const WORK_LABEL = 'enhancement'
/** Idle slots with an empty backlog alert after this long. */
export const IDLE_ALERT_MS = 15 * 60_000
/** While the condition lasts, the notice comes due again at most hourly. */
export const WORKER_IDLE_REPEAT_MS = 60 * 60_000
/** Candidates named in the alert. */
export const MAX_CANDIDATES = 5
const DEDUPE_KEY = 'worker-idle:empty-backlog'
const IDLE_SINCE_KEY = 'worker_idle_since'
const BACKLOG_LIMIT = 200

export interface WorkerCapacity {
  /** Worker chats occupying slots (role worker, not closed). */
  running: number
  /** Configured target (Manager Rhythm). */
  target: number
  /** Open unassigned tickets with the work label; null while unknown. */
  backlog: number | null
  label: string
}

export interface WorkerCandidate {
  repo: string
  number: number
  title: string
  url: string
}

/** What the chat runtime reports; set once at startup (see cache-plugin). */
export interface WorkerChatState {
  running: number
  hasManager: boolean
  /** Canonical bound targets (issue/PR URLs). */
  boundTargets: string[]
}

let chatReader: (() => WorkerChatState) | null = null
let cachedBacklog: number | null | undefined = undefined
let candidateCache: { at: number, candidates: WorkerCandidate[] } | null = null

export function setWorkerChatReader(reader: (() => WorkerChatState) | null): void {
  chatReader = reader
}

/** The chat state, or null when it cannot be read: status surfaces must
 *  never break their callers (API handlers, control context). */
function readChatState(): WorkerChatState | null {
  if (!chatReader) return null
  try {
    return chatReader()
  } catch {
    return null
  }
}

/** For tests: forget the cached backlog and candidates. */
export function resetWorkerCapacityCache(): void {
  cachedBacklog = undefined
  candidateCache = null
}

function idleSince(): number | null {
  const raw = getMeta(IDLE_SINCE_KEY)
  if (!raw) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function setIdleSince(value: number | null): void {
  if (value === null) db.prepare('DELETE FROM meta WHERE key = ?').run(IDLE_SINCE_KEY)
  else setMeta(IDLE_SINCE_KEY, String(value))
}

const ISSUE_TARGET = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)$/i

function boundIssueKeys(boundTargets: readonly string[]): Set<string> {
  const keys = new Set<string>()
  for (const target of boundTargets) {
    const match = ISSUE_TARGET.exec(target.trim())
    if (match) keys.add(`${match[1].toLowerCase()}#${Number(match[2])}`)
  }
  return keys
}

/** Synchronous capacity for status surfaces; backlog follows the last refresh. */
export function getWorkerCapacity(): WorkerCapacity {
  const target = getManagerSettings().rhythm
  const state = readChatState()
  return {
    running: state?.running ?? 0,
    target,
    backlog: cachedBacklog ?? null,
    label: WORK_LABEL,
  }
}

interface DatastoreIssue {
  repo: string
  number: number
}

async function readLabelledBacklog(
  scope: readonly string[] | null,
  bound: ReadonlySet<string>,
): Promise<number | null> {
  if (scope !== null && scope.length === 0) return 0
  const orgs = readyOrganizations()
  if (orgs.length === 0) return null
  // A scoped backlog reads each scoped repo, not the org page filtered
  // locally: the org-wide limit applies before the scope filter, so a large
  // org would hide scoped repos past the limit. Any failed read makes the
  // total unknown rather than a partial count that could false-alert.
  const queries: Array<{ org: (typeof orgs)[number], repo: string | null }> = []
  if (scope === null) {
    for (const org of orgs) queries.push({ org, repo: null })
  } else {
    const byOwner = new Map<string, (typeof orgs)[number]>()
    for (const org of orgs) byOwner.set(org.login.toLowerCase(), org)
    for (const repo of scope) {
      const owner = repo.split('/')[0]?.toLowerCase()
      const org = owner ? byOwner.get(owner) : undefined
      if (!org) return null
      queries.push({ org, repo })
    }
  }
  let total = 0
  for (const { org, repo } of queries) {
    let rows: unknown
    try {
      const { stdout } = await runFile('github-datastore',
        organizationArgs(org, ['view', 'issue', '--status', 'open', '--label', WORK_LABEL,
          ...(repo ? ['--repo', repo] : []), '--limit', String(BACKLOG_LIMIT), '--format', 'json']),
        { timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024 })
      rows = JSON.parse(stdout)
    } catch {
      return null
    }
    if (!Array.isArray(rows)) return null
    for (const raw of rows) {
      const row = raw as Partial<DatastoreIssue>
      if (typeof row.repo !== 'string' || typeof row.number !== 'number' || !Number.isSafeInteger(row.number)) return null
      if (bound.has(`${row.repo.toLowerCase()}#${row.number}`)) continue
      total += 1
    }
  }
  return total
}

function candidateRank(title: string, body: string): number {
  const perf = /perf/i.test(title)
  const priority = /\bp[01]\b/i.test(`${title}\n${body}`)
  return (perf ? 2 : 0) + (priority ? 1 : 0)
}

/** Perf and P0/P1 first, then by repository and number for stability. */
export function rankCandidates<T extends { title: string, body?: string, repo: string, number: number }>(issues: readonly T[]): T[] {
  return [...issues].sort((a, b) =>
    candidateRank(b.title, b.body ?? '') - candidateRank(a.title, a.body ?? '')
    || a.repo.localeCompare(b.repo) || a.number - b.number)
}

interface SearchIssue {
  repository?: { nameWithOwner?: string }
  number: number
  title: string
  body?: string
  url: string
  labels?: Array<{ name?: string }>
}

async function searchCandidates(
  owners: readonly string[],
  scope: readonly string[] | null,
  bound: ReadonlySet<string>,
): Promise<WorkerCandidate[] | null> {
  if (owners.length === 0) return []
  const allowed = scope === null ? null : new Set(scope.map((repo) => repo.toLowerCase()))
  const args = ['search', 'issues', '--state', 'open', '--no-assignee',
    ...owners.flatMap((owner) => ['--owner', owner]),
    '--limit', '30', '--json', 'number,title,body,url,repository,labels',
    '--', `-label:${WORK_LABEL}`]
  let rows: unknown
  try {
    const { stdout } = await runFile('gh', args, { timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024 })
    rows = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(rows)) return null
  const issues: Array<{ repo: string, number: number, title: string, body: string, url: string }> = []
  for (const raw of rows) {
    const row = raw as SearchIssue
    const repo = row.repository?.nameWithOwner
    if (typeof repo !== 'string' || typeof row.number !== 'number' || !Number.isSafeInteger(row.number)
      || typeof row.title !== 'string' || typeof row.url !== 'string') continue
    if (!/^https:\/\/github\.com\//.test(row.url)) continue
    if (allowed && !allowed.has(repo.toLowerCase())) continue
    if (bound.has(`${repo.toLowerCase()}#${row.number}`)) continue
    if ((row.labels ?? []).some((label) => typeof label?.name === 'string' && label.name.toLowerCase() === WORK_LABEL)) continue
    issues.push({ repo, number: row.number, title: row.title, body: typeof row.body === 'string' ? row.body : '', url: row.url })
  }
  return rankCandidates(issues).slice(0, MAX_CANDIDATES)
    .map(({ repo, number, title, url }) => ({ repo, number, title, url }))
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`
}

function alertTitle(running: number, target: number): string {
  const idle = Math.max(0, target - running)
  return `${idle} of ${target} worker slot${target === 1 ? '' : 's'} idle — ${WORK_LABEL} backlog empty`
}

function alertBody(running: number, target: number, candidates: WorkerCandidate[] | null): string {
  const head = `${running} of ${target} worker chats running; no open unassigned ${WORK_LABEL} issues.`
  if (candidates === null) return `${head} The candidate list could not be read just now.`
  if (candidates.length === 0) return `${head} No open unlabelled candidates to promote — file a ticket to refill the backlog.`
  const lines = candidates.map((issue) => `- ${issue.repo}#${issue.number} ${clip(issue.title, 80)} ${issue.url}`)
  return `${head} Candidates to label:\n${lines.join('\n')}`
}

export interface RefreshWorkerCapacityOptions {
  now?: number
  readBacklog?: (scope: readonly string[] | null, bound: ReadonlySet<string>) => Promise<number | null>
  listCandidates?: (owners: readonly string[], scope: readonly string[] | null, bound: ReadonlySet<string>) => Promise<WorkerCandidate[] | null>
}

function scopeOwners(scope: readonly string[] | null, followed: readonly string[]): string[] {
  if (scope === null) return [...followed]
  const owners = new Set<string>()
  for (const repo of scope) {
    const owner = repo.split('/')[0]
    if (owner) owners.add(owner)
  }
  return [...owners]
}

/** One refresh: update the cached backlog, raise or clear the idle alert. */
export async function refreshWorkerCapacity(options: RefreshWorkerCapacityOptions = {}): Promise<WorkerCapacity> {
  const now = options.now ?? Date.now()
  const settings = getManagerSettings()
  const state = readChatState()
  const running = state?.running ?? 0
  const bound = boundIssueKeys(state?.boundTargets ?? [])
  const eligible = state !== null && state.hasManager && !settings.paused
    && !(settings.scope !== null && settings.scope.length === 0)
  const idle = eligible && running < settings.rhythm

  let backlog: number | null
  if (!eligible) {
    backlog = settings.scope !== null && settings.scope.length === 0 ? 0 : cachedBacklog ?? null
  } else {
    try {
      backlog = options.readBacklog
        ? await options.readBacklog(settings.scope, bound)
        : await readLabelledBacklog(settings.scope, bound)
    } catch {
      backlog = null
    }
    if (backlog !== null) cachedBacklog = backlog
  }

  const empty = idle && backlog === 0
  if (!empty) {
    // Unknown keeps what stood: a failed read neither starts the clock nor clears it.
    if (eligible && backlog === null) return { running, target: settings.rhythm, backlog: cachedBacklog ?? null, label: WORK_LABEL }
    setIdleSince(null)
    candidateCache = null
    resolveAlert(DEDUPE_KEY, now)
    return { running, target: settings.rhythm, backlog: backlog ?? cachedBacklog ?? null, label: WORK_LABEL }
  }

  const since = idleSince() ?? now
  if (idleSince() === null) setIdleSince(since)
  if (now - since < IDLE_ALERT_MS) {
    return { running, target: settings.rhythm, backlog, label: WORK_LABEL }
  }

  const open = openAlerts({ kind: 'worker_idle', now }).some((alert) => alert.dedupeKey === DEDUPE_KEY)
  const stale = !candidateCache || now - candidateCache.at >= WORKER_IDLE_REPEAT_MS
  if (!open || stale) {
    let candidates: WorkerCandidate[] | null
    try {
      candidates = options.listCandidates
        ? await options.listCandidates(
            scopeOwners(settings.scope, readyOrganizations().map((org) => org.login)),
            settings.scope, bound)
        : await searchCandidates(
            scopeOwners(settings.scope, readyOrganizations().map((org) => org.login)),
            settings.scope, bound)
    } catch {
      candidates = null
    }
    if (candidates !== null || !open) {
      if (candidates !== null) candidateCache = { at: now, candidates }
      const body = alertBody(running, settings.rhythm, candidates ?? candidateCache?.candidates ?? null)
      const title = alertTitle(running, settings.rhythm)
      if (open) updateAlertDetails(DEDUPE_KEY, title, body)
      else {
        raiseAlert({ kind: 'worker_idle', dedupeKey: DEDUPE_KEY, title, body, path: '/', target: { view: 'behaviors' } }, now)
      }
    }
  }
  return { running, target: settings.rhythm, backlog, label: WORK_LABEL }
}
