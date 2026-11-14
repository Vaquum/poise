// Observe → GitHub: the history of pull requests, issues and CI that classic's
// Archive reads through POST /api/gh (src/views/main-view.ts). Pure mappings:
// a record as a row, its identity, and its status, where CI speaks the seven
// state words and issues and pull requests keep GitHub's own (#556, Design →
// Vocabulary).
import type { StateKey } from './chains'

export type Kind = 'pr' | 'issue' | 'action'
export interface HistoryRow {
  kind: Kind
  repo: string
  number: number
  title: string
  url: string
  author: string
  state: string
  owner: string | null
  updatedAt: string
  mergedAt: string | null
  branch: string | null
  event: string | null
}

export function readRecord(value: unknown): HistoryRow | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  const kind = r.kind === 'pr' || r.kind === 'issue' || r.kind === 'action' ? r.kind : null
  if (!kind || typeof r.repo !== 'string' || !Number.isSafeInteger(r.number) || typeof r.title !== 'string' || typeof r.url !== 'string') return null
  return {
    kind, repo: r.repo, number: Number(r.number), title: r.title, url: r.url, author: typeof r.author === 'string' ? r.author : '',
    // Merged collapses to closed; merged_at tells them apart.
    state: r.state === 'merged' ? 'closed' : String(r.state ?? ''),
    owner: typeof r.owner_login === 'string' && r.owner_login ? r.owner_login : null,
    updatedAt: typeof r.updated_at === 'string' ? r.updated_at : '', mergedAt: typeof r.merged_at === 'string' ? r.merged_at : null,
    branch: typeof r.branch === 'string' ? r.branch : null, event: typeof r.event === 'string' ? r.event : null,
  }
}

/** One identity per row across refreshes: an issue and a pull request share a number space, a CI run has its own. */
export const rowKey = (row: Pick<HistoryRow, 'kind' | 'repo' | 'number'>): string => (row.kind === 'action' ? `${row.repo}:action:${row.number}` : `${row.repo}#${row.number}`)

const capital = (value: string): string => (value ? value.charAt(0).toUpperCase() + value.slice(1) : value)

/** Its status: CI in the seven state words with the outcome beside them; issues and pull requests in GitHub's words. */
export function historyState(row: Pick<HistoryRow, 'kind' | 'state' | 'mergedAt'>): { state: StateKey | null, word: string, settled: boolean } {
  if (row.kind === 'action') {
    switch (row.state) {
      case 'queued': case 'waiting': case 'pending': case 'requested': return { state: 'waiting', word: 'Waiting', settled: false }
      case 'in_progress': return { state: 'running', word: 'Running', settled: false }
      case 'success': return { state: 'done', word: 'Done', settled: true }
      case 'neutral': return { state: 'done', word: 'Done · Neutral', settled: true }
      case 'failure': return { state: 'failed', word: 'Failed', settled: true }
      case 'timed_out': return { state: 'failed', word: 'Failed · Timed out', settled: true }
      case 'action_required': return { state: 'blocked', word: 'Blocked · Action required', settled: false }
      case 'cancelled': case 'skipped': case 'stale': return { state: 'idle', word: `Idle · ${capital(row.state)}`, settled: true }
      default: return { state: 'idle', word: capital(row.state.replace(/_/g, ' ')) || 'Unknown', settled: true }
    }
  }
  if (row.kind === 'pr' && row.mergedAt) return { state: 'done', word: 'Merged', settled: true }
  return row.state === 'open' ? { state: null, word: 'Open', settled: false } : { state: 'idle', word: 'Closed', settled: true }
}

export const failedCi = (row: Pick<HistoryRow, 'kind' | 'state'>): boolean => row.kind === 'action' && (row.state === 'failure' || row.state === 'timed_out')
