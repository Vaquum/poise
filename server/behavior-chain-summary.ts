import { attributedNativeAction, matchingNativeActionReceipt, nativeActionSettlement, nativeRequestSha } from './behavior-chain-action'
import { parseResolutionProgress } from './agent-log-parse'
import { resourceReleaseContradicted } from './behavior-resource-receipt'
import { CHAIN_OBSERVATION_MAX_AGE_MS, chainReviewResponse, closedChainTarget, decideBehaviorChain, lastChainQueueInvocation, recoveredQueueRepair, type ChainObservation } from './behavior-chain-decision'
import { nativeBehavior } from './behavior-chain-runtime'
import { chainBasis, reduceChain, type BehaviorChain, type BehaviorChainJournal, type ChainEvent, type ChainInvocation } from './behavior-chain-store'
import type { LoggingWorkImpact } from '../src/logging'
import type { ProcessDiagnostic } from './process-diagnostic'

export const CHAIN_ATTENTION_DELAY_MS = 24 * 60 * 60_000

/** Effective blocking conversations, mirroring decideBehaviorChain: live
 * threads always block, outdated ones only while readiness stays red on
 * conversation blockers. */
function blockingThreads(pull: NonNullable<ChainObservation['pull']>): number {
  if (pull.unresolved) return pull.unresolved
  if (!pull.ready && Array.isArray(pull.readinessBlockers) && pull.readinessBlockers.length > 0
    && pull.readinessBlockers.every(blocker => blocker === 'merge_state_not_clean' || blocker === 'required_reviews_not_approved')) {
    return Number.isSafeInteger(pull.unresolvedOutdated) ? pull.unresolvedOutdated as number : 0
  }
  return 0
}

/** Missing required PR-review slot, mirroring decideBehaviorChain review-pr first:
 * any configured reviewer without a completed review-pr on the current head
 * and review context (base/title/body) needs review. */
function needsPrReview(chain: BehaviorChain, observation: ChainObservation | null, pull: NonNullable<ChainObservation['pull']>): boolean {
  if (!observation || !Array.isArray(observation.prReviewers) || observation.prReviewers.length === 0) return false
  const expected = chainBasis(['pr', pull.head, pull.reviewContext])
  return observation.prReviewers.some(reviewer => !chain.invocations.some(invocation =>
    invocation.behavior === 'review-pr' && invocation.evidence?.status === 'completed'
    && invocation.basis === expected
    && (invocation.evidence.head_sha === pull.head || invocation.request.context?.head === pull.head)
    && invocation.slot === reviewer.slot))
}

/** Completed issue review without its posted GitHub comment, mirroring
 * decideBehaviorChain reviewComplete in slot order: the hold fires only when
 * the earliest incomplete reviewer slot has a completed review whose original
 * evidence remains unverified; an earlier slot still needing its review
 * keeps the review-issue next action. */
function issueReviewMissingArtifact(chain: BehaviorChain, observation: ChainObservation | null): boolean {
  if (!observation || !Array.isArray(observation.issueReviewers) || observation.issueReviewers.length === 0) return false
  const basis = chainBasis(['issue', observation.issue.revision])
  for (const reviewer of observation.issueReviewers) {
    const invocation = [...chain.invocations].reverse().find(candidate =>
      candidate.behavior === 'review-issue' && candidate.basis === basis && candidate.slot === reviewer.slot
      && candidate.state === 'settled' && candidate.evidence?.status === 'completed')
    if (!invocation) return false
    const evidence = invocation.evidence as Record<string, unknown>
    const complete = evidence.action === 'commented' && evidence.issue_revision === observation.issue.revision && Array.isArray(evidence.receipts)
      && (evidence.receipts as Array<{ issue?: unknown, author?: unknown, comment_id?: unknown }>).some(receipt =>
        typeof receipt.issue === 'string' && receipt.issue.toLowerCase() === `${chain.repository}#${chain.issue}`.toLowerCase()
        && typeof receipt.author === 'string' && receipt.author.toLowerCase() === chain.reviewer.toLowerCase()
        && typeof receipt.comment_id === 'number' && observation.issue.commentIds.includes(receipt.comment_id))
    if (!complete) return true
  }
  return false
}

/** Completed PR review without its exact-head submission receipt, mirroring
 * decideBehaviorChain reviewComplete in slot order: the hold fires only when
 * the earliest incomplete reviewer slot has a completed review whose exact-head
 * receipt remains unverified; an earlier slot still needing its review keeps
 * the review-pr next action. */
function prReviewMissingArtifact(chain: BehaviorChain, observation: ChainObservation | null, pull: NonNullable<ChainObservation['pull']>): boolean {
  if (!observation || !Array.isArray(observation.prReviewers) || observation.prReviewers.length === 0) return false
  const expected = chainBasis(['pr', pull.head, pull.reviewContext])
  for (const reviewer of observation.prReviewers) {
    const invocation = [...chain.invocations].reverse().find(candidate =>
      candidate.behavior === 'review-pr' && candidate.basis === expected && candidate.slot === reviewer.slot
      && candidate.state === 'settled' && candidate.evidence?.status === 'completed')
    if (!invocation) return false
    const evidence = invocation.evidence!
    const complete = !!chainReviewResponse(chain, invocation, observation, observation.checkedAt)
      && typeof evidence.review_id === 'number' && evidence.review_id > 0
      && !!observation.pull?.reviewIds.includes(evidence.review_id)
      && evidence.head_sha === observation.pull?.head
      && ['reviewed_clean', 'requested_changes'].includes(String(evidence.action))
    if (!complete) return true
  }
  return false
}

/** Missing required issue review, mirroring decideBehaviorChain review-issue
 * first: any configured reviewer without a completed review-issue for the
 * current seed revision and its posted comment needs review. */
function needsIssueReview(chain: BehaviorChain, observation: ChainObservation | null): boolean {
  if (!observation || !Array.isArray(observation.issueReviewers) || observation.issueReviewers.length === 0) return false
  const basis = chainBasis(['issue', observation.issue.revision])
  return observation.issueReviewers.some(reviewer => {
    const invocation = [...chain.invocations].reverse().find(candidate =>
      candidate.behavior === 'review-issue' && candidate.basis === basis && candidate.slot === reviewer.slot
      && candidate.state === 'settled' && candidate.evidence?.status === 'completed')
    if (!invocation) return true
    const evidence = invocation.evidence as Record<string, unknown>
    if (evidence.action !== 'commented' || evidence.issue_revision !== observation.issue.revision || !Array.isArray(evidence.receipts)) return true
    return !(evidence.receipts as Array<{ issue?: unknown, author?: unknown, comment_id?: unknown }>).some(receipt =>
      typeof receipt.issue === 'string' && receipt.issue.toLowerCase() === `${chain.repository}#${chain.issue}`.toLowerCase()
      && typeof receipt.author === 'string' && receipt.author.toLowerCase() === chain.reviewer.toLowerCase()
      && typeof receipt.comment_id === 'number' && observation.issue.commentIds.includes(receipt.comment_id))
  })
}

function exactPull(observation: ChainObservation | null) {
  const pull = observation?.pull
  return pull && /^[a-f0-9]{40}$/i.test(pull.head) && observation!.publication?.pull_number === pull.number
    && observation!.publication.head_sha === pull.head && Array.isArray(pull.failing) && Array.isArray(pull.reviewReceipts)
    && ['pending', 'approved', 'changesRequested', 'conflict', 'behind'].every(key => typeof pull[key as keyof typeof pull] === 'boolean')
    && Number.isSafeInteger(pull.unresolved) ? pull : null
}

type ProgressRow = { sequence: number, at: number, event: ChainEvent }

/** Derive the clock from immutable history, never the latest poll or attempt.
 * Replaying here leaves reducer state and historical hashes unchanged. */
export function chainProgress(journal: BehaviorChainJournal, id: string, failedInvocation?: string, trackAdvances = false) {
  // A failed invocation's view is folded afresh; the clock every reader shares
  // continues from where it was folded, over the chain's new events only.
  if (failedInvocation !== undefined) return chainProgressOf(journalEvents(journal, id), id, failedInvocation, trackAdvances)
  let kept = progressFolds.get(journal)
  if (!kept) { kept = new Map(); progressFolds.set(journal, kept) }
  const key = `${id}\u0000${trackAdvances}`
  const fold = kept.get(key) ?? startFold()
  try {
    foldProgress(fold, journalEvents(journal, id, fold.last), id, undefined, trackAdvances)
  } catch (error) {
    kept.delete(key)
    throw error
  }
  kept.set(key, fold)
  return progressOf(fold, id)
}

/** A chain's clock folded so far. History is immutable and only grows, so a
 *  fold continues over later events exactly as a replay from the start would. */
interface ProgressFold {
  last: number
  chain: BehaviorChain | null
  at: number, sequence: number
  previous: ChainObservation['pull']
  verified: Set<string>
  failureSequence: number | null
  waitingSequence: number
  waitingHead: string | null
  advances: Array<{ at: number, sequence: number }>
}
const startFold = (): ProgressFold => ({ last: 0, chain: null, at: 0, sequence: 0, previous: null, verified: new Set(),
  failureSequence: null, waitingSequence: 0, waitingHead: null, advances: [] })
const progressFolds = new WeakMap<BehaviorChainJournal, Map<string, ProgressFold>>()

function progressOf(fold: ProgressFold, id: string) {
  if (!fold.chain) throw new Error(`behavior chain admission history is unavailable: ${id}`)
  const { at, sequence, failureSequence, waitingSequence, waitingHead } = fold
  return { at, sequence, failureSequence, waitingSequence, waitingHead, advances: fold.advances.map((point) => ({ ...point })) }
}

/** One chain's history after a sequence, a page at a time, each event parsed once. */
function* journalEvents(journal: BehaviorChainJournal, id: string, from = 0): Generator<ProgressRow> {
  let after = from
  for (;;) {
    const events = journal.history(id, after)
    for (const row of events) yield { sequence: row.sequence, at: row.at, event: JSON.parse(row.payload) as ChainEvent }
    if (events.length < 100) return
    after = events.at(-1)!.sequence
  }
}

/** The same clock from history already read and parsed, in sequence order. */
export function chainProgressOf(rows: Iterable<ProgressRow>, id: string, failedInvocation?: string, trackAdvances = false) {
  const fold = startFold()
  foldProgress(fold, rows, id, failedInvocation, trackAdvances)
  return progressOf(fold, id)
}

function foldProgress(fold: ProgressFold, rows: Iterable<ProgressRow>, id: string, failedInvocation: string | undefined, trackAdvances: boolean): void {
  let { last, chain, at, sequence, previous, failureSequence, waitingSequence, waitingHead } = fold
  const { verified, advances } = fold
  for (const row of rows) {
    const event = row.event
    last = row.sequence
    chain = reduceChain(chain, event, row.sequence, id)
    if (event.type === 'chain.waiting') {
      waitingSequence = row.sequence
      waitingHead = exactPull(chain.observation as ChainObservation | null)?.head ?? null
    }
    if ((event.type === 'invocation.settled' || event.type === 'invocation.reconciled')
      && event.invocationId === failedInvocation && event.evidence.status === 'failed' && failureSequence === null) failureSequence = row.sequence
    let advanced = event.type === 'chain.admitted'
    const record = (key: string) => { if (!verified.has(key)) { verified.add(key); advanced = true } }
    if (event.type === 'chain.merged') record(`merge:${chain.mergeSha}:${chain.reviewPending}`)
    if (event.type === 'invocation.settled' || event.type === 'invocation.reconciled') {
      const invocation = chain.invocations.find(invocation => invocation.id === event.invocationId)!
      const receipt = matchingNativeActionReceipt(chain, invocation)
      if (receipt?.result.outcome === 'enqueued') record(`queue:${receipt.result.head_sha}:${receipt.result.queue_entry_id}`)
    }
    if (['chain.observed', 'invocation.settled', 'invocation.reconciled'].includes(event.type)) {
      const observation = chain.observation as ChainObservation | null
      if (observation && Number.isFinite(observation.checkedAt) && observation.checkedAt <= row.at
        && row.at - observation.checkedAt <= CHAIN_OBSERVATION_MAX_AGE_MS) {
        const pull = exactPull(observation)
        if (pull) {
          record(`head:${pull.number}:${pull.head}`)
          if (pull.queueEntry) record(`queue:${pull.head}:${pull.queueEntry}`)
          if (event.type === 'chain.observed') {
            if (previous?.head === pull.head && (
              (pull.checksState === 'SUCCESS' && !pull.pending && !pull.failing.length
                && (previous.checksState !== 'SUCCESS' || previous.pending || previous.failing.length > 0))
              || (!previous.approved && pull.approved) || (previous.changesRequested && !pull.changesRequested)
              || (blockingThreads(pull) < blockingThreads(previous)
                && ((pull.unresolved ?? 0) < (previous.unresolved ?? 0)
                  || (pull.unresolvedOutdated ?? 0) < (previous.unresolvedOutdated ?? 0)))
              || (previous.conflict && !pull.conflict) || (previous.behind && !pull.behind))) advanced = true
            previous = pull
          }
        }
        for (const invocation of chain.invocations) {
          if (invocation.state !== 'settled' || invocation.evidence?.status !== 'completed') continue
          if (pull && ['review-pr', 'approve-pr'].includes(invocation.behavior)
            && chainReviewResponse(chain, invocation, observation, row.at)) record(`review:${invocation.evidence.review_id}`)
          if (invocation.behavior === 'review-issue' && invocation.evidence.action === 'commented'
            && invocation.evidence.issue_revision === observation.issue?.revision && Array.isArray(observation.issue?.commentIds)
            && Array.isArray(invocation.evidence.receipts)) {
            for (const receipt of invocation.evidence.receipts as Array<{ issue: string, author: string, comment_id: number }>) {
              if (receipt.issue?.toLowerCase() === id.toLowerCase() && receipt.author?.toLowerCase() === chain.reviewer.toLowerCase()
                && observation.issue.commentIds.includes(receipt.comment_id)) record(`comment:${receipt.comment_id}`)
            }
          }
        }
      }
    }
    if (advanced) {
      at = row.at; sequence = row.sequence
      if (trackAdvances && event.type !== 'chain.admitted') advances.push({ at, sequence })
    }
  }
  Object.assign(fold, { last, chain, at, sequence, previous, failureSequence, waitingSequence, waitingHead })
}

/** PR review/approval heads travel as `--expected-head` argv; other behaviors
 * carry them in request context. */
function invocationHead(invocation: ChainInvocation): string | null {
  const contextHead = invocation.request.context?.head
  if (typeof contextHead === 'string' && /^[a-f0-9]{40}$/i.test(contextHead)) return contextHead
  const at = invocation.request.argv.indexOf('--expected-head')
  const value = at >= 0 ? invocation.request.argv[at + 1] : null
  return typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value) ? value : null
}

/** Resume retains waiting in hashed reducer state. Only a newer wait event
 * makes it current again; an observation alone cannot renew it. */
export function currentChainWaiting(journal: BehaviorChainJournal, chain: BehaviorChain, waitingSequence?: number): string | null {
  if (!chain.waiting || !chain.resumedAfterSequence) return chain.waiting
  return (waitingSequence ?? chainProgress(journal, chain.id).waitingSequence) > chain.resumedAfterSequence ? chain.waiting : null
}

/** Read-only incident annotation, independent of attention's age/active filters. */
export function behaviorChainWorkImpact(journal: BehaviorChainJournal, callId: string | null, correlationId: string | null): LoggingWorkImpact | null {
  return invocationWorkImpact(journal, journal.forInvocation(callId, correlationId))
}

export function behaviorChainWorkImpacts(journal: BehaviorChainJournal, identities: Array<{ callId: string | null, correlationId: string | null }>): Array<LoggingWorkImpact | null> {
  return journal.forInvocations(identities).map(match => invocationWorkImpact(journal, match))
}

function invocationWorkImpact(journal: BehaviorChainJournal, match: ReturnType<BehaviorChainJournal['forInvocation']>): LoggingWorkImpact | null {
  if (!match) return null
  const { chain, invocation } = match
  const progress = chainProgress(journal, chain.id, invocation.id)
  let recovered = progress.failureSequence !== null && progress.sequence > progress.failureSequence
  const active = chain.invocations.find(item => item.state !== 'settled')
  const last = chain.invocations.at(-1)
  const currentWaiting = currentChainWaiting(journal, chain, progress.waitingSequence)
  const waiting = progress.waitingSequence > progress.sequence ? currentWaiting : null
  const contradicted = chain.invocations.some(item => !!item.evidence && resourceReleaseContradicted(item.evidence))
  const blocked = !!chain.held || chain.reviewPending === true || active?.state === 'uncertain' || contradicted
  const diagnostic = invocation.evidence?.diagnostic as ProcessDiagnostic | null | undefined
  const handoff = ['review-pr', 'approve-pr'].includes(invocation.behavior)
    && diagnostic?.operation === 'provider.review' && diagnostic.phase === 'analysis' && diagnostic.outcome === 'handoff'
  let successor: typeof invocation | undefined
  if (handoff) {
    const head = invocationHead(invocation)
    const completedAt = invocation.evidence?.completedAt
    // Progress on another head, green CI and independent reviewer slots do
    // not discharge this Call's review obligation.
    if (invocation.state === 'settled' && invocation.evidence?.status === 'failed'
      && invocation.evidence.error_code === 'review_budget_exhausted' && invocation.evidence.review_id == null
      && diagnostic?.context.submission === 'none' && diagnostic.context.call_id === invocation.callId
      && diagnostic.context.correlation_id === invocation.id && diagnostic.context.expected_head === head
      && typeof head === 'string' && /^[a-f0-9]{40}$/i.test(head)
      && typeof completedAt === 'number' && Number.isFinite(completedAt) && invocation.request.argv[1]) {
      successor = chain.invocations.filter(item => item.admissionSequence > (progress.failureSequence ?? chain.sequence)
        && item.admittedAt >= completedAt && item.behavior === invocation.behavior && item.basis === invocation.basis
        && item.slot === invocation.slot && item.actor === invocation.actor
        && invocationHead(item) === head && item.request.argv[1] === invocation.request.argv[1]).at(-1)
    }
    const observation = chain.observation as ChainObservation | null
    recovered = !!successor && successor.state === 'settled' && successor.evidence?.status === 'completed'
      && !!observation && !!chainReviewResponse(chain, successor, observation, observation.checkedAt)
  }
  let retryAt: number | null = null
  // A backoff outlives observation-only progress past its wait note (CI
  // turning green mid-backoff) but not a new head: match the preserved note
  // against the live last invocation on an unchanged head.
  const backoffHead = exactPull(chain.observation as ChainObservation | null)?.head ?? null
  if (!blocked && !active && last && currentWaiting === `${last.behavior} is in native failure backoff`
    && progress.waitingHead === backoffHead) {
    const attempts = chain.invocations.filter(item => item.behavior === last.behavior && item.basis === last.basis
      && item.slot === last.slot && item.state === 'settled' && item.evidence?.status !== 'deferred'
      && item.admissionSequence > chain.resumedAfterSequence)
    if (attempts.length > 0 && attempts.length < 3 && (last.evidence?.action === 'not_started' || last.evidence?.outcome === 'superseded')
      && Number.isFinite(last.evidence?.completedAt)) retryAt = Number(last.evidence!.completedAt) + 60_000 * 2 ** (attempts.length - 1)
  }
  const retrying = handoff ? successor?.state === 'admitted' || successor?.state === 'started'
    : active && active.admissionSequence > invocation.admissionSequence || retryAt !== null
  const impact: 'blocked' | 'recovered' | 'retrying' | 'unknown' = blocked ? 'blocked' : recovered ? 'recovered'
    : retrying ? 'retrying' : 'unknown'
  const publication = chain.observation?.publication as { pull_number?: number | null } | undefined
  return { impact, recovered, invocationId: invocation.id, repository: chain.repository, behavior: invocation.behavior,
    callerBehavior: nativeBehavior(invocation.behavior),
    stage: active ? `${active.behavior}: ${active.state}` : chain.mergeSha ? 'Merged' : last ? `${last.behavior}: ${last.outcome ?? last.state}` : 'Issue admission',
    target: `${chain.repository}#${publication?.pull_number ?? chain.issue}`,
    progressAt: progress.at, retryAt,
    nextAction: contradicted ? 'Reconcile contradictory original resource-release evidence'
      : chain.reviewPending ? 'Reconcile original pre-merge review evidence; no new invocation can start after merge'
        : chain.held ? chain.ciHold
            ? active?.state === 'uncertain' ? 'Reconcile the original invocation receipt before retrying'
              : chain.ciHold.queue ? String((chain.observation as ChainObservation | null)?.ciRecovery?.reason || chain.held)
                : 'Automatically recheck CI before resuming; fresh review and queue checks still apply'
            : `Resolve the hold and explicitly resume: ${chain.held}`
          : active?.state === 'uncertain' ? 'Reconcile the original invocation receipt before retrying'
            : active ? 'Await the original invocation outcome' : chain.mergeSha ? null
              : retryAt !== null ? 'Automatic retry eligible after backoff, subject to existing admission gates'
                : waiting || (chain.resumedAfterSequence > 0 ? 'Await the next observation or admission under existing gates' : null),
    journal: `/api/behavior-chains?${new URLSearchParams({ id: chain.id, after: String(Math.max(0, progress.sequence - 1)) })}` }
}

const attentionProgress = new WeakMap<BehaviorChainJournal, Map<string, { revision: number, progress: ReturnType<typeof chainProgress> }>>()

/** Read-only attention across every active page, including unpublished issues
 * and merged chains whose original review obligation remains open. */
export function behaviorChainAttention(journal: BehaviorChainJournal, now = Date.now()) {
  let cache = attentionProgress.get(journal)
  if (!cache) { cache = new Map(); attentionProgress.set(journal, cache) }
  const entries = []
  let after = ''
  for (;;) {
    const chains = journal.active(after)
    for (const chain of chains) {
      // active() validates the projection against immutable history before
      // its revision can reuse a clock; only new events require replay.
      const cached = cache.get(chain.id)
      const progress = cached?.revision === chain.sequence ? cached.progress : chainProgress(journal, chain.id)
      cache.set(chain.id, { revision: chain.sequence, progress })
      const waiting = currentChainWaiting(journal, chain, progress.waitingSequence)
      const active = chain.invocations.find(invocation => invocation.state !== 'settled')
      const ageMs = Math.max(0, now - progress.at)
      const observation = chain.observation as ChainObservation | null
      const pull = exactPull(observation)
      const state = !observation ? 'unavailable' : !Number.isFinite(observation.checkedAt) || observation.checkedAt > now
        || typeof observation.issue?.open !== 'boolean'
        ? 'incomplete' : now - observation.checkedAt > CHAIN_OBSERVATION_MAX_AGE_MS ? 'stale'
          : observation.pull && (!pull || !['SUCCESS', 'PENDING', 'EXPECTED', 'FAILURE', 'ERROR'].includes(pull.checksState ?? '')) ? 'incomplete' : 'fresh'
      const queueReviewConflict = state === 'fresh' && observation && pull?.state === 'open' && !pull.merged && !chain.mergeSha
        && pull.queueEntry && (pull.changesRequested || needsPrReview(chain, observation, pull) || prReviewMissingArtifact(chain, observation, pull)
          || !chain.invocations.some(invocation => invocation.state === 'settled' && invocation.evidence?.status === 'completed'
            && ['reviewed_clean', 'approved'].includes(String(invocation.evidence.action))
            && chainReviewResponse(chain, invocation, observation, now)))
      const queueUnmergeable = state === 'fresh' && !!pull?.queueEntry && pull.queueEntryDetails?.id === pull.queueEntry
        && pull.queueEntryDetails.state === 'UNMERGEABLE'
      if (!queueReviewConflict && !chain.held && !chain.reviewPending && active?.state !== 'uncertain' && ageMs < CHAIN_ATTENTION_DELAY_MS) continue
      const gates = pull ? [
        `Head ${pull.head.slice(0, 12)}`,
        pull.failing?.length ? `CI failing: ${pull.failing.join(', ')}` : pull.pending ? 'Required CI pending'
          : pull.checksState === 'SUCCESS' ? 'Required CI passed' : 'Required CI unverified',
        pull.changesRequested ? 'Review changes requested' : 'No change requests observed',
        pull.approved ? 'Current-head approval observed' : 'Current-head approval required',
        ...(pull.unresolved ? [`${pull.unresolved} unresolved review conversation(s)`] : []),
        ...(pull.conflict ? ['Branch conflict requires repair'] : []),
        ...(pull.behind ? ['Native policy requires a base update'] : []),
        ...(pull.readinessBlockers ?? []),
        ...(pull.queueEntry ? ['Native queue owns the candidate; merge completion unverified'] : []),
        ...(queueUnmergeable ? ['Queue UNMERGEABLE; cause unknown'] : []),
        ...(queueReviewConflict ? ['Queue admission conflicts with required retained Poise review evidence'] : []),
      ] : [observation?.pull ? 'Exact-head PR evidence incomplete; merge gates unverified'
        : 'No verified PR evidence; merge completion unverified']
      // Mirroring the runtime reconciliation fence and admitInvocation: a
      // settled invocation with contradictory resource-release evidence still
      // blocks every new invocation pending reconciliation of the original
      // resources, so attention must not recommend downstream work for it.
      const resourceContradicted = chain.invocations.find(invocation => !!invocation.evidence
        && resourceReleaseContradicted(invocation.evidence as Record<string, unknown>))
      const last = chain.invocations.at(-1)
      const lastQueue = pull ? lastChainQueueInvocation(chain) : undefined
      const queueRemoval = pull?.queueRemoval ?? null
      // Mirroring decideBehaviorChain: a dismissed chain approval on the
      // current head holds for an explicit decision before any review or repair.
      const dismissedApproval = pull
        ? (pull.reviewReceipts ?? []).find(review => review.head === pull.head && review.state === 'DISMISSED'
          && chain.invocations.some(invocation => invocation.behavior === 'approve-pr' && invocation.callId === review.invocation))
        : undefined
      // Mirroring decideBehaviorChain: a previously queued head without current
      // removal evidence waits for that evidence instead of review or repair.
      const queueAwaitingRemoval = !!pull && lastQueue?.evidence?.head_sha === pull.head
        && (!queueRemoval || typeof queueRemoval.at !== 'number' || queueRemoval.at < lastQueue.admittedAt)
      const queueMergedNeedsWait = !!pull && lastQueue?.evidence?.head_sha === pull.head
        && !!queueRemoval && typeof queueRemoval.at === 'number' && queueRemoval.at >= lastQueue.admittedAt
        && queueRemoval.reason === 'merged'
      // Mirroring decideBehaviorChain: a removal for any other reason than a
      // merge or an integration rejection needs an explicit queue decision.
      const queueRemovalNeedsDecision = !!pull && lastQueue?.evidence?.head_sha === pull.head
        && !!queueRemoval && typeof queueRemoval.at === 'number' && queueRemoval.at >= lastQueue.admittedAt
        && queueRemoval.reason !== 'merged' && queueRemoval.reason !== 'failed_checks' && queueRemoval.reason !== 'merge_conflict'
      let queueRejectionNeedsRepair = false
      const queueRecovery = observation && recoveredQueueRepair(chain, observation)
      if (pull && lastQueue?.evidence?.head_sha === pull.head && queueRemoval
        && typeof queueRemoval.at === 'number' && queueRemoval.at >= lastQueue.admittedAt
        && (queueRemoval.reason === 'failed_checks' || queueRemoval.reason === 'merge_conflict')) {
        const diagnosis = [...chain.invocations].reverse().find(invocation => invocation.behavior === 'repair-pr'
          && invocation.evidence?.status === 'completed' && invocation.request.context?.head === pull.head
          && invocation.request.context.queueRemoval === queueRemoval.id) ?? queueRecovery
        if (!diagnosis || ((pull.changesRequested || pull.failing.length || pull.conflict || pull.behind)
          && diagnosis.request.context?.reviewRevision !== pull.reviewRevision)) queueRejectionNeedsRepair = true
      }
      const answeredRepair = pull ? chain.invocations.some(invocation => invocation.behavior === 'repair-pr'
        && invocation.evidence?.status === 'completed' && invocation.request.context?.head === pull.head
        && invocation.request.context.reviewRevision === pull.reviewRevision) : false
      const publishedRepair = pull && observation ? chain.invocations.some(invocation => invocation.behavior === 'repair-pr'
        && invocation.evidence?.status === 'completed' && invocation.evidence?.action === 'published'
        && invocation.evidence?.head_sha === pull.head && invocation.callId === observation.publication.head_invocation
        && invocation.request.argv.includes('--expected-issue-revision')
        && invocation.request.argv[invocation.request.argv.indexOf('--expected-issue-revision') + 1] === observation.issue.revision) : false
      const repairVerified = pull ? (answeredRepair || (publishedRepair && !pull.changesRequested))
        && !pull.failing.length && !pull.conflict && !pull.behind : false
      const grey = pull?.greyRuns?.[0] ?? null
      // Mirroring decideBehaviorChain propose(): a completed same-head stuck-CI
      // diagnosis waits for its verified artifact or changed input.
      const stuckCiDiagnosed = !!pull && !!observation && pull.pending && Number.isFinite(pull.headSince) && now - pull.headSince >= 30 * 60_000
        && chain.invocations.some(invocation => invocation.behavior === 'repair-pr' && invocation.state === 'settled'
          && invocation.evidence?.status === 'completed' && invocation.basis === chainBasis(['stuck-ci', pull.head])
          && invocation.slot === observation.repairer.slot)
      // Mirroring decideBehaviorChain propose(): a successful current-basis
      // repair-pr waits for its verified artifact or changed input.
      const repairBasis = pull && observation
        ? chainBasis(['repair', pull.head, pull.failing, pull.conflict, pull.behind,
          pull.changesRequested, pull.unresolved, pull.reviewRevision, observation.issue.revision]) : null
      const repairCompleted = !!pull && !!observation && !!repairBasis
        && chain.invocations.some(invocation => invocation.behavior === 'repair-pr' && invocation.state === 'settled'
          && invocation.evidence?.status === 'completed' && invocation.basis === repairBasis
          && invocation.slot === observation.repairer.slot)
      const repairNeedsWait = !!pull && repairCompleted && !repairVerified
        && (!!pull.failing.length || pull.conflict || pull.behind || pull.changesRequested
          || ((pull.unresolved ?? 0) > 0 && !pull.approved))
      // Mirroring decideBehaviorChain propose(): a successful current-basis
      // rerun-grey-ci waits for its verified artifact or changed input.
      const greyBasis = pull && grey ? chainBasis(['grey', pull.head, grey.id, grey.attempt]) : null
      const greyCompleted = !!pull && !!observation && !!greyBasis
        && chain.invocations.some(invocation => invocation.behavior === 'rerun-grey-ci' && invocation.state === 'settled'
          && invocation.evidence?.status === 'completed' && invocation.basis === greyBasis && invocation.slot === null)
      // Mirroring decideBehaviorChain: an undiagnosed queue rejection holds
      // repair, while a diagnosed one needs independent approve-pr
      // verification on the queue-verification basis before re-enqueueing.
      let queueVerificationBasis = queueRecovery && pull
        ? chainBasis(['queue-recovery', pull.head, pull.queueRemoval?.id, queueRecovery.id, pull.reviewContext]) : null
      if (pull && observation && lastQueue?.evidence?.head_sha === pull.head && queueRemoval
        && typeof queueRemoval.at === 'number' && queueRemoval.at >= lastQueue.admittedAt
        && (queueRemoval.reason === 'failed_checks' || queueRemoval.reason === 'merge_conflict') && !queueRejectionNeedsRepair) {
        const diagnosis = [...chain.invocations].reverse().find(invocation => invocation.behavior === 'repair-pr'
          && invocation.evidence?.status === 'completed' && invocation.request.context?.head === pull.head
          && invocation.request.context.queueRemoval === queueRemoval.id)
        if (diagnosis) queueVerificationBasis ??= chainBasis(['queue-verification', pull.head, queueRemoval.id, diagnosis.id])
      }
      const queueVerificationApproved = !!pull && !!observation && !!queueVerificationBasis
        && chain.invocations.some(invocation => invocation.behavior === 'approve-pr' && invocation.state === 'settled'
          && invocation.evidence?.status === 'completed' && invocation.basis === queueVerificationBasis
          && invocation.slot === observation.approver.slot && invocation.evidence.action === 'approved'
          && invocation.evidence.head_sha === pull.head && typeof invocation.evidence.review_id === 'number'
          && pull.reviewIds.includes(invocation.evidence.review_id)
          && !!chainReviewResponse(chain, invocation, observation, now))
      const queueApproveCompleted = !!pull && !!observation && !!queueVerificationBasis
        && chain.invocations.some(invocation => invocation.behavior === 'approve-pr' && invocation.state === 'settled'
          && invocation.evidence?.status === 'completed' && invocation.basis === queueVerificationBasis
          && invocation.slot === observation.approver.slot)
      // Mirroring decideBehaviorChain propose(): a successful approve-pr on the
      // current verify-repair or approve basis waits for its verified artifact.
      const verifyApproveBasis = pull
        ? queueVerificationBasis ?? chainBasis(['verify-repair', pull.head, pull.reviewRevision]) : null
      const verifyApproveCompleted = !!pull && !!observation && !!verifyApproveBasis
        && chain.invocations.some(invocation => invocation.behavior === 'approve-pr' && invocation.state === 'settled'
          && invocation.evidence?.status === 'completed' && invocation.basis === verifyApproveBasis
          && invocation.slot === observation.approver.slot)
      const normalApproveRepairId = [...chain.invocations].reverse()
        .find(invocation => invocation.behavior === 'repair-pr' && invocation.evidence?.status === 'completed')?.id ?? null
      const normalApproveBasis = pull && observation
        ? chainBasis(['approve', pull.head, pull.reviewRevision, normalApproveRepairId]) : null
      const normalApproveCompleted = !!pull && !!observation && !!normalApproveBasis
        && chain.invocations.some(invocation => invocation.behavior === 'approve-pr' && invocation.state === 'settled'
          && invocation.evidence?.status === 'completed' && invocation.basis === normalApproveBasis
          && invocation.slot === observation.approver.slot)
      // Mirroring decideBehaviorChain: an unpublished chain whose branch exists
      // without the native publication receipt, or whose current-basis
      // implementation returned no_changes, holds instead of proposing work.
      const unpublishedIssueBasis = observation ? chainBasis(['issue', observation.issue.revision]) : null
      const unpublishedPublishPartial = observation && !observation.pull && observation.publication?.head_sha
        ? [...chain.invocations].reverse().find(invocation => invocation.callId === observation.publication.head_invocation
          && !!(invocation.evidence as Record<string, unknown> | null)?.artifact)
        : undefined
      const unpublishedMissingReceipt = !!observation && !observation.pull
        && typeof observation.publication?.head_sha === 'string' && observation.publication.head_sha.length > 0
        && !unpublishedPublishPartial
      const unpublishedNoChanges = !!observation && !observation.pull && !!unpublishedIssueBasis
        && chain.invocations.some(invocation => invocation.behavior === 'implement-issue' && invocation.state === 'settled'
          && invocation.basis === unpublishedIssueBasis && invocation.slot === observation.implementer.slot
          && (invocation.evidence as Record<string, unknown> | null)?.outcome === 'no_changes')
      // Mirroring decideBehaviorChain propose(): a successful current-basis
      // resolve-threads or merge-pr waits for its verified artifact or changed input.
      const resolveThreadsCount = pull ? blockingThreads(pull) : 0
      const resolveThreadsBasis = pull && resolveThreadsCount > 0 ? chainBasis(['resolve', pull.head, resolveThreadsCount]) : null
      const resolveThreadsCompleted = !!pull && !!resolveThreadsBasis
        && chain.invocations.some(invocation => invocation.behavior === 'resolve-threads' && invocation.state === 'settled'
          && invocation.evidence?.status === 'completed' && invocation.basis === resolveThreadsBasis && invocation.slot === null)
      const mergeBasis = pull && observation ? chainBasis(['merge', pull.head, queueVerificationBasis]) : null
      const mergeCompleted = !!pull && !!observation && !!mergeBasis
        && chain.invocations.some(invocation => invocation.behavior === 'merge-pr' && invocation.state === 'settled'
          && invocation.evidence?.status === 'completed' && invocation.basis === mergeBasis && invocation.slot === null)
      let next = queueReviewConflict && pull
        ? `PR ${chain.repository}#${pull.number} head ${pull.head}, queue entry ${pull.queueEntry}: remove it from the merge queue and disable auto-merge if enabled; reconcile the required retained Poise review evidence before resuming. Resuming alone cannot stop GitHub merging.`
        : chain.reviewPending ? 'Reconcile original pre-merge review evidence; no new invocation can start after merge'
        : active?.state === 'uncertain' ? 'Reconcile the original invocation receipt before any retry'
          : resourceContradicted ? `Hold: Invocation ${resourceContradicted.id} has contradictory resource-release evidence; ownership remains held`
          : chain.held ? chain.ciHold
            ? chain.ciHold.queue ? observation?.ciRecovery?.reason || chain.held
              : 'Automatically recheck CI before resuming; fresh review and queue checks still apply'
            : 'Resolve the durable hold, then explicitly resume the chain'
            : active ? 'Await the original invocation outcome'
              : state !== 'fresh' ? 'Await a fresh, complete chain observation'
                : pull && pull.state !== 'open' ? 'Hold: pull request closed without a confirmed merge; a decision is required'
                : pull?.draft ? 'Await the draft pull request becoming ready for review'
                  : observation && observation.existingPulls.length
                  ? `Hold: seed issue already belongs to existing work: ${observation.existingPulls.join(', ')}; resolve ownership before review`
                  : observation && !pull && !observation.issue.eligible ? 'Await the seed issue matching intake settings'
                    : observation && issueReviewMissingArtifact(chain, observation)
                    ? 'Hold for the missing original issue comment evidence; the posted GitHub comment remains unverified'
                    : observation && needsIssueReview(chain, observation) ? 'Review the current seed issue through review-issue'
                    : observation && unpublishedMissingReceipt ? 'Hold: seed branch exists without this chain’s native publication receipt; a decision is required'
                    : observation && unpublishedNoChanges ? 'Hold: implementation returned no changes and produced no pull request; a decision is required'
                    : pull?.queueEntry ? queueUnmergeable
                      ? 'Queue UNMERGEABLE needs attention; cause unknown. Await GitHub queue resolution or removal; GitHub retains ownership'
                      : 'Await verified GitHub merge completion; a queue receipt cannot establish a merge'
                      : dismissedApproval && pull
                      ? `Hold: approval ${dismissedApproval.id} was dismissed on the current head; a decision is required`
                      : queueAwaitingRemoval && pull
                        ? 'Await GitHub queue removal evidence; the queue outcome remains unverified'
                        : queueMergedNeedsWait && pull
                        ? 'Await confirmed GitHub merge evidence; GitHub queue reports a merge'
                        : queueRemovalNeedsDecision && pull
                        ? `Hold: queue removal requires a decision: ${queueRemoval!.reason || 'unknown reason'} (${queueRemoval!.id}); re-enqueueing needs an explicit decision`
                        : queueRejectionNeedsRepair && pull
                        ? `Diagnose and repair GitHub queue rejection ${queueRemoval!.id}: ${queueRemoval!.reason} through repair-pr; PR-head green checks do not prove integration success`
                        : pull && observation && prReviewMissingArtifact(chain, observation, pull)
                        ? 'Hold for the missing original PR submission receipt; the exact-head review evidence remains unverified'
                        : pull && needsPrReview(chain, observation, pull) ? 'Review the actual current pull-request head through review-pr'
                          : greyCompleted && pull
                          ? 'Await the grey recovery verified artifact or changed input; rerun-grey-ci already completed for this head'
                          : grey ? `Recover completed grey workflow ${grey.id} attempt ${grey.attempt} through rerun-grey-ci`
                            : repairNeedsWait && pull
                            ? 'Await the repair verified artifact or changed input; repair-pr already completed for this candidate'
                            : pull?.failing.length ? 'Repair the failing required checks'
                              : pull?.changesRequested && !repairVerified ? 'Address current-head review findings'
                                : pull?.conflict || pull?.behind ? 'Repair the branch conflict or required base update'
                                  : pull && (pull.unresolved ?? 0) > 0 && !pull.approved && !repairVerified ? 'Address current-head review conversations through repair-pr'
                                    : pull && verifyApproveCompleted && repairVerified
                                    && (pull.changesRequested || ((pull.unresolved ?? 0) > 0 && !pull.approved)) && !pull.approved
                                      ? 'Await the approval verified artifact or changed input; approve-pr already completed for this candidate'
                                    : pull && repairVerified && (pull.changesRequested || ((pull.unresolved ?? 0) > 0 && !pull.approved)) && !pull.approved
                                      ? 'Obtain qualifying current-head review and approval'
                                      : stuckCiDiagnosed && pull
                                        ? 'Await the stuck-CI diagnosis verified artifact or changed input; repair-pr already completed for this head'
                                        : pull?.pending && Number.isFinite(pull.headSince) && now - pull.headSince >= 30 * 60_000
                                        ? 'Diagnose the checks pending over 30 minutes through repair-pr'
                                        : pull?.pending ? 'Await exact-head CI completion'
                                          : queueVerificationBasis && pull && observation && !queueVerificationApproved
                                          ? queueApproveCompleted && pull
                                            ? 'Await the queue-verification approval verified artifact or changed input; approve-pr already completed for this head'
                                            : 'Verify the queue-rejection diagnosis through approve-pr approval on the queue-verification basis before re-enqueueing'
                                          : normalApproveCompleted && pull && !pull.approved
                                          ? 'Await the approval verified artifact or changed input; approve-pr already completed for this candidate'
                                          : pull && !pull.approved ? 'Obtain qualifying current-head review and approval'
                                            // Mirroring decideBehaviorChain: past approval, blocking
                                            // conversations resolve through resolve-threads, then readiness,
                                            // then the retained substantive review, then merge-pr.
                                            : pull && blockingThreads(pull) > 0
                                              ? resolveThreadsCompleted && pull
                                                ? 'Await the resolve-threads verified artifact or changed input; resolve-threads already completed for this head'
                                                : `Resolve ${blockingThreads(pull)} blocking review conversation(s) through resolve-threads; only the native approval gate permits resolution`
                                              : pull && !pull.ready ? 'Await native repository readiness gates; no new invocation can proceed until they pass'
                                                : pull && observation && !chain.invocations.some(invocation => invocation.evidence?.status === 'completed'
                                                  && ['reviewed_clean', 'approved'].includes(String(invocation.evidence.action))
                                                  && !!chainReviewResponse(chain, invocation, observation, now))
                                                ? 'Hold: merge requires a retained substantive final-context review response; a decision is required'
                                                : pull
                                                  ? mergeCompleted
                                                    ? 'Await the merge verified artifact or changed input; merge-pr already completed for this head'
                                                    : 'Merge or enqueue through merge-pr under native head-pinned repository gates'
                                                  : waiting || 'Await the next invocation under existing admission gates'
      let retryAt: number | null = null
      if (!chain.held && !chain.reviewPending && !active && last && waiting === `${last.behavior} is in native failure backoff`) {
        const attempts = chain.invocations.filter(invocation => invocation.behavior === last.behavior && invocation.basis === last.basis
          && invocation.slot === last.slot && invocation.state === 'settled' && invocation.evidence?.status !== 'deferred'
          && invocation.admissionSequence > chain.resumedAfterSequence)
        if (attempts.length > 0 && attempts.length < 3 && (last.evidence?.action === 'not_started' || last.evidence?.outcome === 'superseded')
          && Number.isFinite(last.evidence?.completedAt)) {
          retryAt = Number(last.evidence!.completedAt) + 60_000 * 2 ** (attempts.length - 1)
          next = 'Automatic retry eligible after backoff, subject to existing admission gates'
        }
      }
      const preview = (value: string) => value.length <= 1024 ? value : `${value.slice(0, 1023)}…`
      entries.push({ id: chain.id, repository: chain.repository, issue: chain.issue,
        held: chain.held, sequence: chain.sequence, mergeSha: chain.mergeSha,
        pullNumber: observation?.publication?.pull_number ?? null,
        step: active ? `${active.behavior}: ${active.state}` : chain.reviewPending ? 'Merged; review evidence pending'
          : !chain.held ? waiting || (pull ? 'PR merge gates' : 'Issue admission')
          : last ? `${last.behavior}: ${last.outcome ?? last.state}` : 'Issue admission',
        progressAt: progress.at, ageMs,
        blocker: preview([queueReviewConflict ? 'Queue admission conflicts with required retained Poise review evidence' : null,
          chain.held, active?.state === 'uncertain' ? active.outcome || 'Original receipt unverified' : null,
          chain.reviewPending ? 'Original pre-merge review evidence pending' : null, waiting].filter(Boolean).join('; ')
          || 'No verified progress for at least 24 hours'),
        evidence: { state, checkedAt: observation?.checkedAt ?? null, gates: gates.map(preview) },
        nextAction: preview(next), retryAt,
        reconciliation: { nextObservationAt: journal.reconciliationAt(chain), waitingForResourceRelease: chainWaitsForResourceRelease(chain) },
        journal: `/api/behavior-chains?${new URLSearchParams({ id: chain.id, after: String(Math.max(0, progress.sequence - 1)) })}` })
    }
    if (chains.length < 100) break
    after = chains.at(-1)!.id
  }
  return entries.sort((a, b) => a.progressAt - b.progressAt || a.id.localeCompare(b.id))
}

export function chainWaitsForResourceRelease(chain: BehaviorChain): boolean {
  return chain.invocations.some(invocation => invocation.state !== 'settled' && invocation.model !== null
    && !!closedChainTarget(chain, chain.observation as ChainObservation | null, invocation.behavior)
    && !(typeof invocation.evidence?.resources_settled_at === 'string' && Number.isFinite(Date.parse(invocation.evidence.resources_settled_at))))
}

/** Historical clearance is separate from completion of the original responses.
 * Use the canonical basis and full invocation list, even on completed chains. */
function mergedReviewWarning(chain: BehaviorChain, journal?: BehaviorChainJournal) {
  const observation = chain.observation as ChainObservation | null
  const pull = observation?.pull
  if (!journal || !observation || !chain.mergeSha || !pull?.merged || pull.mergeSha !== chain.mergeSha) return null
  const before = journal.preMergeObservation(chain.id, pull.mergedAt ?? Number.NaN) as ChainObservation | null
  const firstMerged = journal.firstMergedObservation(chain.id) as ChainObservation | null
  if (decideBehaviorChain(chain, observation, observation.checkedAt, { before, firstMerged }).kind !== 'complete') return null
  const original = { ...observation, prReviewers: before!.prReviewers, pull: { ...pull, reviewContext: before!.pull!.reviewContext } }
  if (chain.invocations.some(invocation => invocation.evidence?.status === 'completed'
    && ['reviewed_clean', 'approved'].includes(String(invocation.evidence.action))
    && chainReviewResponse(chain, invocation, original, original.checkedAt))) return null
  const basis = chainBasis(['pr', pull.head, original.pull.reviewContext])
  const url = (id: number) => `https://github.com/${chain.repository}/pull/${pull.number}#pullrequestreview-${id}`
  const reviews = original.prReviewers.map(reviewer => {
    const invocation = [...chain.invocations].reverse().find(item => item.behavior === 'review-pr' && item.basis === basis
      && item.slot === reviewer.slot && item.state === 'settled' && item.evidence?.status === 'completed')!
    const response = chainReviewResponse(chain, invocation, original, original.checkedAt)!
    const receipt = pull.reviewReceipts.find(item => item.id === invocation.evidence!.review_id)!
    return { id: receipt.id, head: receipt.head, submittedAt: receipt.submittedAt!, url: url(receipt.id), verdict: response.assessment.verdict }
  })
  const lastReviewAt = Math.max(...reviews.map(review => review.submittedAt))
  const approval = pull.reviewReceipts.filter(receipt => receipt.state === 'APPROVED' && receipt.head === pull.head
    && Number.isSafeInteger(receipt.id) && receipt.id > 0 && pull.reviewIds.includes(receipt.id)
    && typeof receipt.submittedAt === 'number' && Number.isFinite(receipt.submittedAt)
    && receipt.submittedAt > lastReviewAt && receipt.submittedAt <= pull.mergedAt!)
    .sort((a, b) => b.submittedAt! - a.submittedAt!)[0]
  return { head: pull.head, reviews, githubApproval: approval ? { id: approval.id, head: approval.head,
    submittedAt: approval.submittedAt!, url: url(approval.id), client: 'unknown' as const } : null }
}

/** Wire projection, shared by the HTTP handler and isolated browser fixtures.
 * Without a journal the wait cannot be dated against Resume, so journal-less
 * callers keep the pre-boundary projection. */
export function behaviorChainSummary(chain: BehaviorChain, journal?: BehaviorChainJournal, reconciliation?: { at: number | null }) {
  const publication = chain.observation?.publication as { pull_number?: number | null } | undefined
  const waiting = journal ? currentChainWaiting(journal, chain) : chain.waiting
  return { id: chain.id, repository: chain.repository, issue: chain.issue, branch: chain.branch, author: chain.author, reviewer: chain.reviewer,
    sequence: chain.sequence, held: chain.held,
    waiting: chain.mergeSha && waiting?.startsWith('native merge queue owns entry ') ? null : waiting,
    mergeSha: chain.mergeSha,
    supersession: chain.supersession ?? null,
    reviewPending: chain.reviewPending ?? null,
    reviewStatus: chain.reviewPending === true ? 'pending' : chain.reviewPending === false ? 'complete' : 'not-recorded',
    mergedReviewWarning: mergedReviewWarning(chain, journal),
    reconciliation: reconciliation ? { nextObservationAt: reconciliation.at,
      ...(chainWaitsForResourceRelease(chain) ? { waitingForResourceRelease: true } : {}),
      waitingForOriginalResponse: reconciliation.at === null && chain.reviewPending === true
        && chain.invocations.some((invocation) => invocation.state !== 'settled' && attributedNativeAction(invocation)) } : null,
    pullNumber: publication?.pull_number ?? null,
    invocationCount: chain.invocations.length, invocations: chain.invocations.slice(-20).map((invocation) => {
      const proof = attributedNativeAction(invocation) ? matchingNativeActionReceipt(chain, invocation) : null
      const settlement = proof ? nativeActionSettlement(proof) : null
      const artifact = invocation.evidence?.artifact as Record<string, unknown> | undefined
      const progress = artifact?.resolution_progress === undefined ? null : parseResolutionProgress(artifact.resolution_progress)
      if (progress && (invocation.behavior !== 'resolve-threads' || artifact?.request_sha !== nativeRequestSha(invocation.request))) {
        throw new Error('native resolution progress conflicts with its original request')
      }
      return { id: invocation.id, behavior: invocation.behavior, state: invocation.state,
        callId: invocation.callId ?? (typeof invocation.evidence?.nativeCallId === 'string' ? invocation.evidence.nativeCallId : null), model: invocation.model,
        slot: invocation.slot, outcome: invocation.outcome, admittedAt: invocation.admittedAt,
        nativeAction: !attributedNativeAction(invocation) ? null : {
          attribution: proof ? settlement!.status === 'completed' ? 'accepted-response' : 'observed-no-action'
            : invocation.state === 'uncertain' ? 'uncertain' : 'not-recorded',
          outcome: settlement?.outcome ?? null, queueEntryId: settlement?.queue_entry_id ?? null,
          receivedAt: proof?.observedAt ?? null, processFailure: proof?.processFailure ?? null,
          ...(progress ? { resolutionProgress: progress } : {}),
        },
        evidence: invocation.evidence ? { action: invocation.evidence.action, outcome: invocation.evidence.outcome,
          ...(invocation.evidence.publicationPlan ? { publicationPlan: invocation.evidence.publicationPlan } : {}),
          review_id: invocation.evidence.review_id, head_sha: invocation.evidence.head_sha,
          resources_settled_at: invocation.evidence.resources_settled_at, error: invocation.evidence.error,
          diagnostic: invocation.evidence.diagnostic } : null,
      }
    }) }
}
