// Observe → Tasks: the behavior chain's evidence as tasks (#556, #728, #955).
// Pure mappings over what GET /api/behavior-chains serves: each chain's
// phase, its state in the seven words with its reason, the attention
// projection's order, and the journal's events in words. Nothing here reads
// the network or the page, so the unit tests read it directly.
import type { BehaviorCutoverState } from '../../../behavior-cutover'

export type StateKey = 'running' | 'needs-you' | 'waiting' | 'blocked' | 'idle' | 'done' | 'failed'

export interface ChainInvocation {
  id: string
  behavior: string
  state: string
  callId: string | null
  model: string | null
  slot: string | null
  outcome: string | null
  admittedAt: number | null
}

export interface ChainSupersession {
  covering: Array<{ number: number, mergeSha: string }>
  failures: Array<{ id: number }>
  recovery: { id: number } | null
}

interface ReviewReceipt { id: number, head: string, submittedAt: number, url: string }
export interface MergedReviewWarning {
  head: string
  reviews: Array<ReviewReceipt & { verdict: string }>
  githubApproval: (ReviewReceipt & { client: 'unknown' }) | null
}

export interface ChainRow {
  id: string
  repository: string
  issue: number
  sequence: number
  held: string | null
  waiting: string | null
  mergeSha: string | null
  reviewPending: boolean | null
  reviewStatus: 'pending' | 'complete' | 'not-recorded'
  mergedReviewWarning: MergedReviewWarning | null
  supersession: ChainSupersession | null
  reconciliation: { nextObservationAt: number | null, waitingForOriginalResponse: boolean, waitingForResourceRelease: boolean } | null
  pullNumber: number | null
  invocationCount: number
  invocations: ChainInvocation[]
}

export interface AttentionRow {
  id: string
  repository: string
  issue: number
  pullNumber: number | null
  step: string
  progressAt: number
  ageMs: number
  blocker: string
  evidence: { state: string, checkedAt: number | null, gates: string[] }
  nextAction: string
  retryAt: number | null
  reconciliation: { nextObservationAt: number | null, waitingForResourceRelease: boolean }
  journal: string
}

export interface ChainCapacity {
  status: 'available' | 'unavailable'
  error: string | null
  modelInvocationLimit: number | null
  reservedModelInvocations: number | null
  retainedModelInvocations: number | null
  mode: string | null
  enabled: boolean | null
  intake: { seedMode: string, label: string | null } | null
}

export interface ChainsPage {
  chains: ChainRow[]
  next: string | null
  attention: AttentionRow[] | null
  cutover: (BehaviorCutoverState & { blockers?: string[] }) | null
  capacity: ChainCapacity | null
  runtime: Array<{ organization: string, error: string | null }>
}

export interface JournalEvent {
  sequence: number
  at: number
  type: string
  invocationId: string | null
  reason: string | null
  outcome: string | null
  callId: string | null
  reviewComplete?: boolean
  diagnostic: { operation?: string, phase?: string, stderr?: string | null, context?: Record<string, unknown> } | null
}

// ---------- Reading the wire, failing loudly on what it cannot read ----------
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
export class ChainReadError extends Error {}
const incomplete = (what: string): never => { throw new ChainReadError(`The behavior chain answer is incomplete: ${what}.`) }

function invocation(value: unknown): ChainInvocation {
  if (!object(value) || typeof value.id !== 'string' || typeof value.behavior !== 'string' || typeof value.state !== 'string') return incomplete('an invocation')
  return { id: value.id, behavior: value.behavior, state: value.state, callId: text(value.callId), model: text(value.model),
    slot: text(value.slot), outcome: text(value.outcome), admittedAt: count(value.admittedAt) }
}

function reviewReceipt(value: unknown): ReviewReceipt {
  if (!object(value) || !Number.isSafeInteger(value.id) || typeof value.head !== 'string'
    || typeof value.submittedAt !== 'number' || !Number.isFinite(value.submittedAt) || typeof value.url !== 'string') return incomplete('a review receipt')
  return { id: Number(value.id), head: value.head, submittedAt: value.submittedAt, url: value.url }
}

function mergedReviewWarning(value: unknown): MergedReviewWarning | null {
  if (value == null) return null
  if (!object(value) || typeof value.head !== 'string' || !Array.isArray(value.reviews) || !value.reviews.length) return incomplete('merged review clearance')
  return { head: value.head, reviews: value.reviews.map(review => {
    if (!object(review) || typeof review.verdict !== 'string') return incomplete('a retained review verdict')
    return { ...reviewReceipt(review), verdict: review.verdict }
  }), githubApproval: value.githubApproval == null ? null : { ...reviewReceipt(value.githubApproval), client: 'unknown' } }
}

export function readChain(value: unknown): ChainRow {
  if (!object(value) || typeof value.id !== 'string' || typeof value.repository !== 'string' || !Number.isSafeInteger(value.issue)
    || !Number.isSafeInteger(value.sequence) || !Array.isArray(value.invocations)) return incomplete('a chain')
  const s = value.supersession
  const supersession = object(s) ? {
    covering: Array.isArray(s.covering) ? s.covering.filter(object).map((c) => ({ number: Number(c.number), mergeSha: String(c.mergeSha ?? '') })) : [],
    failures: Array.isArray(s.failures) ? s.failures.filter(object).map((f) => ({ id: Number(f.id) })) : [],
    recovery: object(s.recovery) ? { id: Number(s.recovery.id) } : null,
  } : null
  const r = value.reconciliation
  return {
    id: value.id, repository: value.repository, issue: Number(value.issue), sequence: Number(value.sequence),
    held: text(value.held), waiting: text(value.waiting), mergeSha: text(value.mergeSha),
    reviewPending: typeof value.reviewPending === 'boolean' ? value.reviewPending : null,
    reviewStatus: value.reviewStatus === 'pending' || value.reviewStatus === 'complete' ? value.reviewStatus : 'not-recorded',
    mergedReviewWarning: mergedReviewWarning(value.mergedReviewWarning),
    supersession,
    reconciliation: object(r) ? { nextObservationAt: count(r.nextObservationAt), waitingForOriginalResponse: r.waitingForOriginalResponse === true, waitingForResourceRelease: r.waitingForResourceRelease === true } : null,
    pullNumber: Number.isSafeInteger(value.pullNumber) ? Number(value.pullNumber) : null,
    invocationCount: Number.isSafeInteger(value.invocationCount) ? Number(value.invocationCount) : value.invocations.length,
    invocations: value.invocations.map(invocation),
  }
}

function attentionRow(value: unknown): AttentionRow {
  if (!object(value) || typeof value.id !== 'string' || typeof value.repository !== 'string' || !Number.isSafeInteger(value.issue)
    || !Number.isFinite(value.progressAt) || !Number.isFinite(value.ageMs) || typeof value.journal !== 'string') return incomplete('an attention entry')
  const e = object(value.evidence) ? value.evidence : {}
  const r = object(value.reconciliation) ? value.reconciliation : {}
  return {
    id: value.id, repository: value.repository, issue: Number(value.issue),
    pullNumber: Number.isSafeInteger(value.pullNumber) ? Number(value.pullNumber) : null,
    step: String(value.step ?? ''), progressAt: Number(value.progressAt), ageMs: Number(value.ageMs), blocker: String(value.blocker ?? ''),
    evidence: { state: String(e.state ?? 'unavailable'), checkedAt: count(e.checkedAt), gates: Array.isArray(e.gates) ? e.gates.map(String) : [] },
    nextAction: String(value.nextAction ?? ''), retryAt: count(value.retryAt),
    reconciliation: { nextObservationAt: count(r.nextObservationAt), waitingForResourceRelease: r.waitingForResourceRelease === true },
    journal: value.journal,
  }
}

/** One page of GET /api/behavior-chains. The attention projection comes with the first page only. */
export function readChainsPage(value: unknown): ChainsPage {
  if (!object(value) || !Array.isArray(value.chains)) return incomplete('the chain list')
  if (value.next !== null && value.next !== undefined && typeof value.next !== 'string') return incomplete('its cursor')
  const capacity = object(value.capacity) ? {
    status: value.capacity.status === 'available' ? 'available' as const : 'unavailable' as const, error: text(value.capacity.error),
    modelInvocationLimit: count(value.capacity.modelInvocationLimit), reservedModelInvocations: count(value.capacity.reservedModelInvocations),
    retainedModelInvocations: count(value.capacity.retainedModelInvocations),
    mode: text(value.capacity.mode), enabled: typeof value.capacity.enabled === 'boolean' ? value.capacity.enabled : null,
    intake: object(value.capacity.intake) ? { seedMode: String(value.capacity.intake.seedMode), label: text(value.capacity.intake.label) } : null,
  } : null
  const cutover = object(value.cutover) && ['v1', 'draining', 'v2'].includes(String(value.cutover.mode)) && Array.isArray(value.cutover.legacyPulls)
    ? { ...value.cutover as unknown as BehaviorCutoverState, legacyPulls: value.cutover.legacyPulls.map(String),
      blockers: Array.isArray(value.cutover.blockers) ? value.cutover.blockers.map(String) : [] } : null
  return {
    chains: value.chains.map(readChain),
    next: typeof value.next === 'string' ? value.next : null,
    attention: Array.isArray(value.attention) ? value.attention.map(attentionRow) : null,
    cutover, capacity,
    runtime: Array.isArray(value.runtime) ? value.runtime.filter(object).map((r) => ({ organization: String(r.organization ?? ''), error: text(r.error) })) : [],
  }
}

export function readJournalPage(value: unknown): { chain: ChainRow | null, events: JournalEvent[], next: number | null } {
  if (!object(value) || !Array.isArray(value.events)) return incomplete('the journal')
  if (value.next !== null && !Number.isSafeInteger(value.next)) return incomplete('the journal cursor')
  const events = value.events.map((e): JournalEvent => {
    if (!object(e) || !Number.isSafeInteger(e.sequence) || !Number.isFinite(e.at) || typeof e.type !== 'string') return incomplete('a journal event')
    const evidence = object(e.evidence) && object(e.evidence.diagnostic) ? e.evidence.diagnostic as JournalEvent['diagnostic'] : null
    return { sequence: Number(e.sequence), at: Number(e.at), type: e.type, invocationId: text(e.invocationId), reason: text(e.reason),
      outcome: text(e.outcome), callId: text(e.callId), diagnostic: evidence,
      ...(object(e.evidence) && typeof e.evidence.review_complete === 'boolean' ? { reviewComplete: e.evidence.review_complete } : {}) }
  })
  return { chain: object(value.chain) ? readChain(value.chain) : null, events, next: value.next === null ? null : Number(value.next) }
}

// ---------- Words ----------
export const PHASES = ['Intake', 'Issue review', 'Implementation', 'PR review', 'Repair', 'Approval', 'Merge'] as const

const PHASE_OF: Record<string, number> = {
  'review-issue': 1, 'implement-issue': 2, 'publish-issue': 2, 'review-pr': 3,
  'repair-pr': 4, 'rerun-grey-ci': 4, 'retire-pr': 4, 'approve-pr': 5, 'resolve-threads': 5, 'merge-pr': 6,
}

/** A chain step in words, as Settings → Behaviors names the behavior. */
export const STEP_WORDS: Record<string, string> = {
  'review-issue': 'Issue review', 'implement-issue': 'Implementation', 'publish-issue': 'Publication', 'review-pr': 'PR review',
  'repair-pr': 'Repair', 'rerun-grey-ci': 'Rerun grey CI', 'retire-pr': 'Retiring the pull request', 'approve-pr': 'Approval',
  'resolve-threads': 'Resolving conversations', 'merge-pr': 'Merge if ready',
}
export const stepWord = (behavior: string): string => STEP_WORDS[behavior] ?? behavior

const capital = (value: string): string => (value ? value.charAt(0).toUpperCase() + value.slice(1) : value)
const sha = (value: string): string => value.slice(0, 7)

/** The invocation the chain stands on: the one going, else the last. */
export function currentInvocation(chain: ChainRow): ChainInvocation | null {
  return chain.invocations.find((i) => i.state !== 'settled') ?? chain.invocations[chain.invocations.length - 1] ?? null
}

/** Its phase on the rail, Intake to Merge; a merged or superseded task is past them all. Repair returns to
 *  PR review, so those two count rounds: one more for every repair settled before the current step. */
export function phaseOf(chain: ChainRow): { index: number, round: number, word: string } {
  if (chain.supersession) return { index: PHASES.length, round: 1, word: 'Superseded' }
  if (chain.mergeSha) return { index: PHASES.length, round: 1, word: 'Merged' }
  const current = currentInvocation(chain)
  const index = current ? PHASE_OF[current.behavior] ?? 0 : 0
  const at = current ? chain.invocations.indexOf(current) : -1
  const round = 1 + chain.invocations.slice(0, Math.max(0, at)).filter((i) => i.behavior === 'repair-pr' && i.state === 'settled').length
  const counted = index === 3 || index === 4
  return { index, round, word: counted ? `${PHASES[index]} · round ${round}` : PHASES[index] }
}

/** A wait or a hold in plain words: the reasons the chain's decision logic writes, worded once. */
export function reasonWords(reason: string): string {
  const r = reason.trim()
  if (/^exact-head CI is still running/i.test(r)) return 'CI is still running on its head'
  if (/native merge queue owns entry/i.test(r)) return 'In the merge queue'
  if (/^pull request is a draft/i.test(r)) return 'The pull request is a draft'
  if (/readiness gates are not satisfied/i.test(r)) return 'Waiting for the repository’s readiness gates'
  const backoff = /^([\w-]+) is in native failure backoff/.exec(r)
  if (backoff) return `${stepWord(backoff[1])} failed; it retries after a backoff`
  if (/^New invocations held by the person$/i.test(r)) return 'Held by you: no new invocations'
  return capital(r)
}

/** Where the task stands, in the seven state words, and why (#556, Design → Vocabulary). */
export function taskState(chain: ChainRow): { state: StateKey, reason: string } {
  if (chain.supersession) {
    const by = chain.supersession.covering[0]
    return { state: 'done', reason: by ? `Superseded: #${by.number} covered it, merged as ${sha(by.mergeSha)}` : 'Superseded: another merge covered it' }
  }
  if (chain.mergeSha) {
    if (chain.reviewPending) return { state: 'waiting', reason: `Merged as ${sha(chain.mergeSha)} · review evidence pending` }
    if (chain.mergedReviewWarning) return { state: 'done', reason: `Merged as ${sha(chain.mergeSha)} · native review clearance unmet` }
    if (chain.reviewStatus === 'not-recorded') return { state: 'done', reason: `Merged as ${sha(chain.mergeSha)} · pre-merge review completion not recorded` }
    return { state: 'done', reason: `Merged as ${sha(chain.mergeSha)}` }
  }
  if (chain.held) return { state: 'needs-you', reason: chain.held === 'New invocations held by the person' ? 'Held by you: no new invocations' : `Held: ${reasonWords(chain.held)}` }
  const active = chain.invocations.find((i) => i.state !== 'settled')
  if (active?.state === 'uncertain') return { state: 'blocked', reason: `Not confirmed: ${active.outcome || 'the original receipt is unverified'}; reconciling` }
  if (active?.state === 'started') {
    const phase = phaseOf(chain)
    return { state: 'running', reason: [PHASE_OF[active.behavior] === 3 || PHASE_OF[active.behavior] === 4 ? phase.word : stepWord(active.behavior), active.model].filter(Boolean).join(' · ') }
  }
  if (active) return { state: 'waiting', reason: chain.waiting ? reasonWords(chain.waiting) : `${stepWord(active.behavior)} admitted; waiting for a free behavior slot` }
  if (chain.waiting) return { state: 'waiting', reason: reasonWords(chain.waiting) }
  return { state: 'idle', reason: 'Awaiting the next observation' }
}

/** Still in motion: not superseded, and not merged unless its review evidence is still owed. */
export const isActive = (chain: ChainRow): boolean => !chain.supersession && (!chain.mergeSha || chain.reviewPending === true)

/** Needs attention, oldest progress first, as the attention projection orders it. */
export function attentionOrder(rows: readonly AttentionRow[]): AttentionRow[] {
  return [...rows].sort((a, b) => a.progressAt - b.progressAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** How long, in the words a person reads at a glance: 36m, 3h 4m, 1d 2h. */
export function age(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return `${minutes}m`
}

/** A journal link's chain and step: `/api/behavior-chains?id=…&after=…`. */
export function journalStep(journal: string): { id: string, after: number } | null {
  let params: URLSearchParams
  try { params = new URL(journal, 'http://poise.invalid').searchParams } catch { return null }
  const id = params.get('id')
  const after = Number(params.get('after') ?? 0)
  return id && Number.isSafeInteger(after) && after >= 0 ? { id, after } : null
}

export const LEGACY_PULL = /^([-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+)#([1-9][0-9]*)$/
export const REPOSITORY = /^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/

// ---------- The journal in words ----------
export type EventKind = 'run' | 'event' | 'hold' | 'uncertain'
export const KIND_WORDS: Record<EventKind, string> = { run: 'Run', event: 'Event', hold: 'Hold', uncertain: 'Not confirmed' }

/** One journal event as the timeline says it: its kind, its words, and the run it names. */
export function eventWords(event: JournalEvent, invocations: ReadonlyMap<string, ChainInvocation>): { kind: EventKind, text: string, call: string | null } {
  const inv = event.invocationId ? invocations.get(event.invocationId) : undefined
  const step = inv ? stepWord(inv.behavior) : 'A step'
  const by = inv ? [inv.slot, inv.model].filter(Boolean).join(' · ') : ''
  const call = event.callId
  switch (event.type) {
    case 'chain.admitted': return { kind: 'event', text: 'Entered the chain', call: null }
    case 'chain.observed': return { kind: 'event', text: 'Observed on GitHub', call: null }
    case 'chain.held': return { kind: 'hold', text: event.reason === 'New invocations held by the person' ? 'Held by you: no new invocations' : `Held: ${reasonWords(event.reason ?? 'no reason recorded')}`, call: null }
    case 'chain.waiting': return { kind: 'event', text: `Waiting: ${reasonWords(event.reason ?? 'no reason recorded')}`, call: null }
    case 'chain.resumed': return { kind: 'event', text: 'Resumed', call: null }
    case 'chain.merged': return { kind: 'event', text: event.reviewComplete === true ? 'Original review evidence complete' : 'Merged', call }
    case 'chain.superseded': return { kind: 'event', text: 'Superseded by a merge that covered it', call }
    case 'invocation.admitted': return { kind: 'run', text: 'A step was admitted', call: null }
    case 'invocation.started': return { kind: 'run', text: `${step} started${by ? ` · ${by}` : ''}`, call }
    case 'invocation.settled': return { kind: 'run', text: `${step} settled${event.outcome ? `: ${event.outcome}` : ''}${by ? ` · ${by}` : ''}`, call }
    case 'invocation.uncertain': return { kind: 'uncertain', text: `${step}: ${event.reason ?? 'its outcome could not be proven'}`, call }
    case 'invocation.reconciled': return { kind: 'run', text: `${step} reconciled with its original evidence`, call }
    case 'invocation.resources_reconciled': return { kind: 'run', text: `${step}: its resources were reconciled`, call }
    default: return { kind: 'event', text: capital(event.type.replace(/[._]/g, ' ')), call }
  }
}

/** A native action's failure, as classic's chain list words it: what was sent, the cause, and what is next. */
export function failureWords(event: JournalEvent): string {
  const d = event.diagnostic
  if (!d || (d.operation !== 'merge_if_ready' && d.phase !== 'native_action')) return ''
  const submission = d.context?.submission
  const known = submission === 'none' || submission === 'rejected'
  const cause = d.stderr || (typeof d.context?.message === 'string' ? d.context.message : '') || 'cause unknown'
  return `${submission === 'none' ? 'Request not sent' : submission === 'rejected' ? 'Request rejected' : 'Action outcome unknown'} · Cause: ${cause} · Next: ${known
    ? 'address the cause; normal admission checks and retry backoff still apply.'
    : 'reconcile the original Call response; do not enqueue again.'}`
}

/** The timeline as a person reads it: newest first, with each run of observations folded into one line
 *  that says how many. The step a link names always keeps its own line. */
export type TimelineLine = { event: JournalEvent, folded: number, oldest: number | null }
export function timelineLines(events: readonly JournalEvent[], step: number | null): TimelineLine[] {
  const lines: TimelineLine[] = []
  for (const event of [...events].sort((a, b) => b.sequence - a.sequence)) {
    const last = lines[lines.length - 1]
    if (event.type === 'chain.observed' && event.sequence !== step && last && last.event.type === 'chain.observed' && last.event.sequence !== step) {
      last.folded += 1
      last.oldest = event.at
      continue
    }
    lines.push({ event, folded: 1, oldest: null })
  }
  return lines
}

/** The first event at or after a link's step: its `after` is the sequence just before it. */
export function stepEvent(events: readonly JournalEvent[], after: number | null): number | null {
  if (after === null) return null
  const first = events.filter((e) => e.sequence > after).sort((a, b) => a.sequence - b.sequence)[0]
  return first ? first.sequence : null
}
