// Board's model, pure: where each live item stands in the seven states, its
// phase and how long it has been like that (#556; docs/design/interface/
// poise-ds/CURRENT.md). It reads what `main` serves: GitHub records from
// /api/gh, each pull request's blocker from /api/behavior-ledger/pr-status,
// the chain's intake and its chains, and the runs that are going.
import { PHASES, phaseOf as chainPhase, taskState, type ChainRow, type StateKey } from '../observe/chains'

export type { StateKey }
export type Lane = 'idea' | 'concept' | 'plan' | 'issue' | 'pr'
export type MineLane = 'idea' | 'concept' | 'plan'

export const STATES: StateKey[] = ['needs-you', 'blocked', 'failed', 'running', 'waiting', 'idle', 'done']
export const RANK: Record<StateKey, number> = { 'needs-you': 0, blocked: 1, failed: 2, running: 3, waiting: 4, idle: 5, done: 6 }

/** A GitHub record as /api/gh `list` serves it. */
export interface GhRecord {
  kind: 'pr' | 'issue'
  repo: string
  number: number
  state: 'open' | 'closed' | 'merged'
  title: string
  url: string
  created_at: string
  updated_at: string
  merged_at: string | null
  reviewRequested?: boolean | null
}

export type BlockerId = 'not_eligible' | 'held' | 'review_running' | 'awaiting_author' | 'awaiting_review' | 'ci_pending'
  | 'ci_failing' | 'unresolved_threads' | 'conflicting' | 'behind' | 'blocked' | 'approved_not_enqueued' | 'in_queue' | 'unknown'

/** One row of GET /api/behavior-ledger/pr-status, the parts Board reads. */
export interface PrStatus {
  repository: string
  number: number
  blocker: { id: BlockerId, line: string, since: string, sinceRestart: boolean, details: string[] }
  ownership?: { engine: 'v1' | 'v2', chainId?: string }
}

/** Who is on an item: the chain, a worker, a chat you run, or a run. */
export interface Who { tag: string, kind: 'poise' | 'worker' | 'chat' | 'run', href: string }

/** A live issue or pull request as Board draws it. */
export interface Item {
  id: string
  lane: 'issue' | 'pr'
  repo: string
  num: number
  title: string
  url: string
  record: GhRecord
  /** Null when its status could not be read: no state word, never a guessed one. */
  state: StateKey | null
  detail: string
  /** When the current state began, in ms, when known. */
  since: number | null
  /** The blocker's clock restarted with the server. */
  sinceRestart: boolean
  updatedAt: number
  openedAt: number
  who: Who | null
  chain: ChainRow | null
  /** The open pull requests that close this issue, from the chain's intake. */
  closing: { number: number, url: string }[] | null
  /** The chain's label is on it (intake), or a confirmed assignment is. */
  labelled: boolean
}

export const itemKey = (repo: string, number: number): string => `${repo}#${number}`.toLowerCase()

/** A pull request's one current blocker in the seven states (CURRENT.md, "How the brief lands"). */
export function blockerState(id: BlockerId): StateKey | null {
  switch (id) {
    case 'review_running': return 'running'
    case 'ci_pending': case 'in_queue': case 'awaiting_review': case 'awaiting_author':
    case 'unresolved_threads': case 'approved_not_enqueued': return 'waiting'
    case 'ci_failing': return 'failed'
    case 'conflicting': case 'behind': case 'blocked': case 'held': return 'blocked'
    case 'not_eligible': return 'idle'
    case 'unknown': return null
  }
}

export interface ItemInput {
  record: GhRecord
  /** Undefined when the status could not be read. */
  status: PrStatus | null | undefined
  chain: ChainRow | null
  /** A run going on it now: its behavior's name, and when it started. Undefined while the runs have never been read. */
  run: { name: string, since: number | null } | null | undefined
  labelled: boolean
  closing: { number: number, url: string }[] | null
}

const ms = (iso: string | null | undefined): number | null => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : null
}

/** Builds a live item: its state, detail, since and who. */
export function toItem(input: ItemInput): Item {
  const { record, status, chain, run, labelled, closing } = input
  const base = {
    id: `${record.repo}#${record.number}`, lane: record.kind, repo: record.repo, num: record.number, title: record.title,
    url: record.url, record, updatedAt: ms(record.updated_at) ?? 0, openedAt: ms(record.created_at) ?? 0, chain, closing, labelled,
  } as const
  const poise: Who | null = chain || labelled ? { tag: 'Poise', kind: 'poise', href: '' } : null
  if (record.state !== 'open') {
    return { ...base, state: record.kind === 'pr' && record.state === 'closed' ? 'idle' : 'done', detail: record.state === 'merged' ? 'merged' : 'closed', since: ms(record.merged_at) ?? base.updatedAt, sinceRestart: false, who: poise }
  }
  if (record.kind === 'pr' && record.reviewRequested === true) {
    return { ...base, state: 'needs-you', detail: 'GitHub requested your review', since: null, sinceRestart: false, who: poise }
  }
  if (chain) {
    const { state, reason } = taskState(chain)
    return { ...base, state, detail: reason, since: chain.invocations[chain.invocations.length - 1]?.admittedAt ?? null, sinceRestart: false, who: poise }
  }
  if (run) return { ...base, state: 'running', detail: `${run.name} running`, since: run.since, sinceRestart: false, who: { tag: run.name, kind: 'run', href: '' } }
  if (record.kind === 'pr' && status) {
    return { ...base, state: blockerState(status.blocker.id), detail: status.blocker.line, since: ms(status.blocker.since), sinceRestart: status.blocker.sinceRestart, who: poise }
  }
  if (record.kind === 'pr' && status === undefined) return { ...base, state: null, detail: '', since: null, sinceRestart: false, who: poise }
  // Idle only for want of a run, while the runs have never been read: no state word either.
  if (run === undefined) return { ...base, state: null, detail: '', since: null, sinceRestart: false, who: poise }
  return { ...base, state: 'idle', detail: '', since: null, sinceRestart: false, who: poise }
}

/** Merged or closed: folded at the end of its lane, with nothing left to do. */
export const isSettled = (item: Item): boolean => item.record.state !== 'open'

/** The phase on the rail: a chain's from its journal, other work's from its blocker (CURRENT.md, "Board as a list"). */
export function phaseOf(item: Item): { index: number | null, word: string } {
  if (item.chain) {
    const p = chainPhase(item.chain)
    return { index: p.index, word: p.word }
  }
  if (isSettled(item)) return item.lane === 'pr' && item.record.state === 'merged' ? { index: PHASES.length, word: 'Merged' } : { index: null, word: 'Closed' }
  const at = (index: number) => ({ index, word: PHASES[index] })
  if (item.lane === 'issue') return at(item.who && item.who.kind !== 'poise' ? 2 : 0)
  const id = item.detail
  if (/draft/i.test(id)) return at(2)
  if (item.state === 'failed' || item.state === 'blocked') return at(4)
  if (/approved|merge/i.test(id)) return at(6)
  return at(3)
}

/** How long, in Board's words (CURRENT.md): running says for how long; anything
 *  else how long it has waited, marked once it is the same for 15 minutes. */
export function dwell(item: Item, now: number): { text: string, stuck: boolean } {
  if (isSettled(item) || !item.state) return { text: '', stuck: false }
  const from = item.since ?? item.updatedAt
  const minutes = Math.max(0, (now - from) / 60_000)
  if (minutes < 1) return { text: item.state === 'running' ? 'just started' : 'just now', stuck: false }
  if (item.state === 'running') return { text: `for ${ago(minutes)}`, stuck: false }
  if (item.state === 'idle') return { text: `no change for ${ago(minutes)}`, stuck: false }
  return minutes >= 15 ? { text: `the same for ${ago(minutes)}${item.sinceRestart ? ' since Poise restarted' : ''}`, stuck: true } : { text: `for ${ago(minutes)}`, stuck: false }
}

const D = 1440, MO = 43_200
/** Minutes as Board says them: now, 8m, 3h, 2d, 4mo. */
export function ago(minutes: number): string {
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${Math.round(minutes)}m`
  if (minutes < D) return `${Math.floor(minutes / 60)}h`
  if (minutes < MO) return `${Math.floor(minutes / D)}d`
  return `${Math.floor(minutes / MO)}mo`
}

/** A pull request opened in the last six hours, still open: a blue New chip. */
export const isNew = (item: Item, now: number): boolean => item.lane === 'pr' && !isSettled(item) && now - item.openedAt < 6 * 3_600_000

export type Order = 'attention' | 'recent' | 'repo'
export const recent = (a: Item, b: Item): number => b.updatedAt - a.updatedAt
const rank = (item: Item): number => item.state ? RANK[item.state] : STATES.length
export const attention = (a: Item, b: Item): number => rank(a) - rank(b) || recent(a, b)
export function sortItems(items: Item[], order: Order): Item[] {
  const by = order === 'recent' ? recent : attention
  const sorted = [...items].sort(by)
  return order === 'repo' ? sorted.sort((a, b) => a.repo.localeCompare(b.repo) || attention(a, b)) : sorted
}

/** Can this item be assigned to Poise: an open issue nobody has, the intake read, and not every issue entering already. */
export function canAssign(item: Item, intakeRead: boolean, everyIssueEnters: boolean): boolean {
  return intakeRead && !everyIssueEnters && item.lane === 'issue' && !isSettled(item) && !item.who && !item.chain && !item.labelled
}
