// The work in the seven states (#556, Design → Vocabulary): every source maps
// onto Running, Needs you, Waiting, Blocked, Idle, Done and Failed, with the
// outcome word kept beside the state where the state alone would lose it.
// Pure, so the mapping is tested without a page.
import { queuedStatusText } from '../../../chat-text'

export type State = 'running' | 'needs-you' | 'waiting' | 'blocked' | 'idle' | 'done' | 'failed'

/** In motion's order: what wants you first, then what moves, then what rests. */
export const STATES: readonly State[] = ['needs-you', 'failed', 'blocked', 'running', 'waiting', 'idle', 'done']

export interface Placed { state: State, note: string }

// ---------- Chats and workers ----------
export interface ChatLike {
  status: 'starting' | 'idle' | 'queued' | 'running' | 'waiting' | 'stopping' | 'interrupted' | 'closed' | 'error'
  role?: 'manager' | 'worker'
  queuedBehind?: string
  ownerRequests?: string[]
  /** A bound session's last turn left work behind. */
  stall?: { repos?: unknown[], truncatedRepos?: number } | null
}

export function chatState(chat: ChatLike): Placed {
  // A stalled worker cannot go on until what its turn left is dealt with (#587, #619).
  if (chat.role === 'worker' && chat.stall && !chat.ownerRequests?.length && chat.status !== 'running' && chat.status !== 'starting' && chat.status !== 'stopping') {
    const repos = (chat.stall.repos?.length ?? 0) + (chat.stall.truncatedRepos ?? 0)
    return { state: 'blocked', note: repos ? `left work behind in ${repos} ${repos === 1 ? 'repository' : 'repositories'}` : 'left work behind' }
  }
  switch (chat.status) {
    case 'starting': return { state: 'running', note: 'Starting' }
    case 'running': return { state: 'running', note: '' }
    case 'stopping': return { state: 'running', note: 'Stopping…' }
    case 'waiting': {
      const asks = chat.ownerRequests?.length ?? 0
      return asks
        ? { state: 'needs-you', note: asks > 1 ? `${asks} requests wait for you` : 'a request waits for you' }
        : { state: 'waiting', note: 'Awaiting an answer' }
    }
    case 'queued': return { state: 'waiting', note: queuedStatusText(chat.queuedBehind) }
    case 'interrupted': return { state: 'blocked', note: 'Interrupted: Resume continues' }
    case 'closed': return { state: 'idle', note: 'Closed' }
    case 'error': return { state: 'failed', note: 'its last turn failed' }
    default: return { state: 'idle', note: '' }
  }
}

// ---------- Tasks: the behavior chain's journal ----------
export const PHASES = ['Intake', 'Issue review', 'Implementation', 'PR review', 'Repair', 'Approval', 'Merge'] as const
export type Phase = typeof PHASES[number] | 'Merged' | 'Superseded'

export interface ChainInvocationLike { behavior: string, state: 'admitted' | 'started' | 'uncertain' | 'settled', outcome: string | null }
export interface ChainLike {
  id: string
  repository: string
  issue: number
  pullNumber: number | null
  held: string | null
  waiting: string | null
  mergeSha: string | null
  supersession: unknown
  reviewPending: boolean | null
  invocations: ChainInvocationLike[]
}

const BEHAVIOR_PHASE: Record<string, typeof PHASES[number]> = {
  'review-issue': 'Issue review',
  'implement-issue': 'Implementation',
  'publish-issue': 'Implementation',
  'review-pr': 'PR review',
  'repair-pr': 'Repair',
  'rerun-grey-ci': 'Repair',
  'approve-pr': 'Approval',
  'resolve-threads': 'Approval',
  'merge-pr': 'Merge',
  'retire-pr': 'Merge',
}

/** Where a task has got to, from intake to merge, with its round in review and repair. */
export function taskPhase(chain: ChainLike): { phase: Phase, round: number | null } {
  if (chain.supersession) return { phase: 'Superseded', round: null }
  if (chain.mergeSha) return { phase: 'Merged', round: null }
  const last = chain.invocations[chain.invocations.length - 1]
  const phase = last ? BEHAVIOR_PHASE[last.behavior] ?? 'Intake' : 'Intake'
  const round = phase === 'PR review' || phase === 'Repair'
    ? chain.invocations.filter((invocation) => BEHAVIOR_PHASE[invocation.behavior] === phase).length
    : null
  return { phase, round }
}

export function phaseWords(phase: Phase, round: number | null): string {
  return round ? `${phase} · round ${round}` : phase
}

export function taskState(chain: ChainLike): Placed {
  if (chain.supersession) return { state: 'done', note: 'Superseded' }
  if (chain.mergeSha) return chain.reviewPending ? { state: 'waiting', note: 'Merged; review evidence pending' } : { state: 'done', note: 'Merged' }
  if (chain.held) return { state: 'blocked', note: chain.held }
  const active = [...chain.invocations].reverse().find((invocation) => invocation.state !== 'settled')
  if (active?.state === 'uncertain') return { state: 'blocked', note: `Not confirmed: ${active.outcome || 'an effect Poise cannot prove yet'}` }
  const { phase, round } = taskPhase(chain)
  if (active) return { state: 'running', note: phaseWords(phase, round) }
  if (chain.waiting) return { state: 'waiting', note: chain.waiting }
  return { state: 'idle', note: phaseWords(phase, round) }
}

// ---------- Issues and pull requests, as Board shows them ----------
export type HeldReason = 'draft' | 'conflict' | 'checks_failing' | 'changes_requested' | 'review_required' | 'conversation_open' | 'checks_running' | 'behind' | 'blocked' | 'unknown'

const HELD: Record<Exclude<HeldReason, 'unknown'>, Placed> = {
  draft: { state: 'idle', note: 'Draft' },
  conflict: { state: 'blocked', note: 'a merge conflict' },
  checks_failing: { state: 'failed', note: 'checks failing' },
  changes_requested: { state: 'waiting', note: 'changes requested' },
  review_required: { state: 'waiting', note: 'a review is required' },
  conversation_open: { state: 'waiting', note: 'a conversation is open' },
  checks_running: { state: 'waiting', note: 'checks running' },
  behind: { state: 'blocked', note: 'behind its base' },
  blocked: { state: 'blocked', note: 'blocked' },
}

export interface PullLike {
  reviewRequested?: boolean | null
  /** green or yellow as the status check read it; undefined while not read. */
  status?: 'green' | 'yellow'
  /** Why it is held, in the service's display order. */
  reasons?: HeldReason[]
  /** The names of failing checks, when the service gave them. */
  failing?: string[]
  /** A behavior run or a worker is on it right now. */
  running?: boolean
}

/** A pull request's state, or null when it could not be read: that has no state word. */
export function pullState(pull: PullLike): Placed | null {
  if (pull.reviewRequested === true) return { state: 'needs-you', note: 'GitHub requested your review' }
  if (pull.running) return { state: 'running', note: 'a run is on it' }
  if (pull.status === undefined) return null
  if (pull.status === 'green') return { state: 'waiting', note: 'Ready to merge' }
  const reason = (pull.reasons ?? []).find((value): value is Exclude<HeldReason, 'unknown'> => value !== 'unknown')
  if (reason) {
    const placed = HELD[reason]
    return reason === 'checks_failing' && pull.failing?.length ? { ...placed, note: `failing: ${pull.failing.join(', ')}` } : placed
  }
  return { state: 'idle', note: '' }
}

export function issueState(issue: { running?: boolean }): Placed {
  return issue.running ? { state: 'running', note: 'a run is on it' } : { state: 'idle', note: '' }
}

/** How many of `items` are in each state, in In motion's order. */
export function countStates(items: readonly { state: State }[]): Record<State, number> {
  const counts = Object.fromEntries(STATES.map((state) => [state, 0])) as Record<State, number>
  for (const item of items) counts[item.state] += 1
  return counts
}
