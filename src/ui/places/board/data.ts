// What Board reads and writes, through the endpoints classic's Current uses
// (src/views/current-view.ts), plus the PR status ledger, the chains and the
// chats on each item. Every failure carries the service's reason.
import { organizationErrors } from '../../../organizations'
import { readChainsPage, type ChainRow, type ChainCapacity } from '../observe/chains'
import { startedAtMs } from '../observe/runs'
import { itemKey, type GhRecord, type MineLane, type PrStatus } from './model'

/** A card of yours, as /api/current keeps it. */
export interface Card {
  id: number
  text: string
  lane: MineLane
  position: number
  repo: string | null
  created_at: string
  updated_at: string
}

export interface RepoLabel { name: string, color: string, description: string | null }

/** The chain's intake (#853). Null is unread, never "not assigned". */
export interface Intake {
  label: string | null
  labelled: Set<string>
  prs: Record<string, { number: number, url: string }[] | undefined>
}

/** A chat or worker on an item. */
export interface ChatOn { id: string, title: string, role: 'worker' | 'manager' | null, running: boolean }

const reason = async (response: Response, what: string): Promise<string> => {
  const text = await response.text().catch(() => '')
  try {
    const body = JSON.parse(text) as { error?: unknown, message?: unknown }
    if (typeof body.message === 'string' && body.message) return body.message
    if (typeof body.error === 'string' && body.error) return body.error
  } catch { /* not JSON */ }
  return text && !/^\s*</.test(text) ? `${what} answered ${response.status}: ${text.slice(0, 200)}` : `${what} answered ${response.status}`
}

async function json<T>(url: string, init: RequestInit = {}, what = 'Poise'): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', ...init,
    headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } })
  if (!response.ok) throw new Error(await reason(response, what))
  return await response.json() as T
}

const scoped = (path: string, org: string): string => (org ? `${path}${path.includes('?') ? '&' : '?'}org=${encodeURIComponent(org)}` : path)
const gh = <T>(body: Record<string, unknown>, org: string): Promise<T> =>
  json<T>('/api/gh', { method: 'POST', body: JSON.stringify({ ...body, ...(org ? { org } : {}) }) }, 'GitHub')

// ---------- Your cards ----------
export async function readCards(org: string): Promise<Card[]> {
  const data = await json<{ cards?: Card[] }>(scoped('/api/current', org))
  return (data.cards ?? []).filter((c) => c.lane === 'idea' || c.lane === 'concept' || c.lane === 'plan')
}
export const createCard = (card: { text: string, lane: MineLane, repo: string | null }): Promise<Card> =>
  json<Card>('/api/current', { method: 'POST', body: JSON.stringify(card) })
/** An edit sends its fields; a move sends its lane and position within the scope it was made in. */
export const updateCard = (id: number, patch: Partial<Pick<Card, 'text' | 'repo' | 'lane' | 'position'>>, org = ''): Promise<Card> =>
  json<Card>(`/api/current/${id}`, { method: 'PATCH', body: JSON.stringify({ ...patch, ...(org ? { org } : {}) }) })
export const deleteCard = (id: number): Promise<unknown> => json(`/api/current/${id}`, { method: 'DELETE' })

export async function readRepos(org: string): Promise<{ repos: string[], warning: string }> {
  const data = await json<{ repos?: string[], errors?: Array<{ org: string, error: string }> }>(scoped('/api/repos', org))
  return { repos: Array.isArray(data.repos) ? data.repos : [], warning: organizationErrors(data) }
}

// ---------- Live work ----------
export const LIVE_LIMIT = 200
export async function readLive(filter: { open: boolean, since?: string, until?: string }, org: string): Promise<{ records: GhRecord[], truncated: boolean, warning: string }> {
  const data = await gh<{ records?: GhRecord[], errors?: Array<{ org: string, error: string }> }>({
    operation: 'list', record_type: 'all', record_state: filter.open ? 'open' : 'all', limit: LIVE_LIMIT + 1, offset: 0,
    ...(filter.since ? { updated_since: filter.since } : {}), ...(filter.until ? { updated_until: filter.until } : {}),
  }, org)
  const records = data.records ?? []
  return { records: records.slice(0, LIVE_LIMIT), truncated: records.length > LIVE_LIMIT, warning: organizationErrors(data) }
}

/** Each open pull request's blocker, from the PR status ledger. */
export async function readPrStatus(): Promise<Map<string, PrStatus>> {
  const data = await json<{ rows?: PrStatus[] }>('/api/behavior-ledger/pr-status?limit=100')
  return new Map((data.rows ?? []).map((row) => [itemKey(row.repository, row.number), row]))
}

export async function readIntake(org: string): Promise<{ intake: Intake, warning: string }> {
  const data = await gh<{ label?: string | null, labelled?: string[], prs?: Intake['prs'], errors?: Array<{ org: string, error: string }> }>({ operation: 'issue_intake' }, org)
  return { intake: { label: data.label || null, labelled: new Set((data.labelled ?? []).map((k) => k.toLowerCase())), prs: data.prs ?? {} }, warning: organizationErrors(data) }
}

/** The runs going now, by item: the behavior's name, and when it started. */
export async function readRunning(org: string): Promise<Map<string, { name: string, since: number | null }>> {
  const data = await json<{ logs?: Array<{ status?: string, repo?: string, pr_id?: number, behavior?: string, label?: string, started_at?: string, started_at_precise?: string | null }> }>(scoped('/api/agent-logs?status=running', org))
  const running = new Map<string, { name: string, since: number | null }>()
  for (const log of data.logs ?? []) {
    if (log.status !== 'running' || !log.repo || !log.pr_id) continue
    const since = startedAtMs({ started_at: log.started_at ?? '', started_at_precise: log.started_at_precise ?? null })
    running.set(itemKey(log.repo, log.pr_id), { name: runName(log.behavior || log.label || 'Run'), since: Number.isFinite(since) ? since : null })
  }
  return running
}
const runName = (behavior: string): string => ({ 'review-prs': 'Review', 'approve-prs': 'Approval', 'repair-pr': 'Repair', 'implement-issue': 'Implementation' } as Record<string, string>)[behavior]
  ?? behavior.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

/** The chains, by their issue and their pull request, with the chain's capacity. */
export async function readChains(): Promise<{ byItem: Map<string, ChainRow>, capacity: ChainCapacity | null }> {
  const page = readChainsPage(await json<unknown>('/api/behavior-chains'))
  const byItem = new Map<string, ChainRow>()
  for (const chain of page.chains) {
    if (chain.supersession) continue
    byItem.set(itemKey(chain.repository, chain.issue), chain)
    if (chain.pullNumber) byItem.set(itemKey(chain.repository, chain.pullNumber), chain)
  }
  return { byItem, capacity: page.capacity }
}

/** Chats and workers bound to a pull request. */
export async function readChats(): Promise<Map<string, ChatOn>> {
  const data = await json<{ sessions?: Array<{ id: string, repo: string, title: string, role?: 'manager' | 'worker', status: string, branch?: { origin?: string, pr?: number } }> }>('/api/chat/sessions')
  const on = new Map<string, ChatOn>()
  for (const s of data.sessions ?? []) {
    if (!s.repo || s.branch?.origin !== 'pr' || !s.branch.pr) continue
    on.set(itemKey(s.repo, s.branch.pr), { id: s.id, title: s.title, role: s.role ?? null, running: s.status === 'running' || s.status === 'starting' })
  }
  return on
}

// ---------- Issues ----------
const LABEL_TTL_MS = 5 * 60_000
const labelCache = new Map<string, { labels: RepoLabel[], at: number }>()
export async function readLabels(repo: string): Promise<RepoLabel[]> {
  const cached = labelCache.get(repo)
  if (cached && Date.now() - cached.at < LABEL_TTL_MS) return cached.labels
  const data = await gh<{ labels?: RepoLabel[] }>({ operation: 'list_repo_labels', repository_full_name: repo }, '')
  if (!Array.isArray(data.labels)) throw new Error('GitHub sent no label list')
  const labels = data.labels.filter((label) => typeof label?.name === 'string')
  labelCache.set(repo, { labels, at: Date.now() })
  return labels
}

export async function readIssue(repo: string, number: number): Promise<{ title: string, body: string }> {
  const data = await gh<{ issue?: { number?: number, title?: string, body?: string } }>({ operation: 'read_issue', repository_full_name: repo, issue_number: number }, '')
  const issue = data.issue
  if (!issue || issue.number !== number || typeof issue.title !== 'string' || typeof issue.body !== 'string') throw new Error('GitHub did not return the issue’s title and body')
  return { title: issue.title, body: issue.body }
}

export async function openIssue(issue: { repo: string, title: string, body: string, labels: string[] }): Promise<{ record: GhRecord | null, dropped: string[] }> {
  const data = await gh<{ record?: GhRecord, labels_dropped?: unknown[] }>({ operation: 'open_issue', repository_full_name: issue.repo, title: issue.title, body: issue.body, ...(issue.labels.length ? { labels: issue.labels } : {}) }, '')
  return { record: data.record ?? null, dropped: (data.labels_dropped ?? []).filter((name): name is string => typeof name === 'string') }
}

/** Saves an edit only if nobody changed the issue since it was loaded: GitHub refuses otherwise. */
export async function editIssue(edit: { repo: string, number: number, title: string, body: string, expected: { title: string, body: string } }): Promise<GhRecord> {
  const data = await gh<{ record?: GhRecord }>({ operation: 'edit_issue', repository_full_name: edit.repo, issue_number: edit.number, title: edit.title, body: edit.body,
    expected_title: edit.expected.title, expected_body: edit.expected.body }, '')
  const r = data.record
  if (!r || r.kind !== 'issue' || r.repo !== edit.repo || r.number !== edit.number || r.title !== edit.title) throw new Error('GitHub did not confirm the edited issue; your draft is kept')
  return r
}

export const assignIssue = (repo: string, number: number): Promise<unknown> =>
  gh({ operation: 'assign_issue', repository_full_name: repo, issue_number: number }, '')

/** Starts a PR review; its run then shows as running on the card. */
export async function runReview(url: string): Promise<void> {
  const response = await fetch('/api/pr-review', { method: 'POST', cache: 'no-store', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) })
  if (!response.ok) throw new Error(await reason(response, 'PR review'))
}
