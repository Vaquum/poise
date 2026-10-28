import type { CiObservation, WorkTarget } from './chat/work-observations'

// Deliberately has no executor, timer, runtime registration or configuration switch.
export const V2_EXECUTION_ENABLED = false
export const WORK_OBSERVATION_MAX_AGE_MS = 5 * 60_000

export type WorkAction = 'create-issue' | 'review-issue' | 'implement' | 'repair-ci' | 'repair-stuck-ci'
  | 'rerun-grey-ci' | 'review-pr' | 'fix-review' | 'resolve-threads' | 'update-branch' | 'repair-conflicts' | 'approve' | 'merge'
export type WorkStage =
  | { kind: 'plan', card: string, markdown: string, context: string[], assigned: boolean }
  | { kind: 'issue', target: WorkTarget, bodyRevision: string, reviewedRevision: string | null, closed: boolean }
  | { kind: 'pull', target: WorkTarget, head: string, ci: CiObservation | null, ciStuck: boolean, greyCiEligible: boolean,
      review: 'unread' | 'needed' | 'changes' | 'clean', reviewedHead: string | null,
      unresolved: number | null, approvedHead: string | null, ready: boolean | null,
      mergeQueue: boolean | null, queueEntry: string | null, mergeSha: string | null }

export interface WorkObservation {
  id: string
  revision: number
  checkedAt: number
  /** Existing bindings fence active v1 work; rehearsal never adopts it. */
  owner: 'v1' | 'rehearsal'
  mode: 'headless' | 'interactive'
  held: boolean
  /** Result of the existing behavior admission policy, including switches/skips/backoff. */
  refusal: string | null
  stage: WorkStage
}
export interface WorkActionReceipt {
  attempt: string
  action: WorkAction
  basisRevision: number
  head: string | null
  issueBodyRevision: string | null
  /** Finished means the worker ended, never that its promised artifact exists. */
  state: 'running' | 'uncertain' | 'not-started' | 'finished'
  retryAt: number | null
  reference: string
  /** Native intent admission time, stable across settlements of this attempt. */
  requestedAt: number
  at: number
}
export type WorkDecision =
  | { kind: 'propose', action: WorkAction, basisRevision: number, head: string | null, issueBodyRevision: string | null }
  | { kind: 'wait' | 'inspect' | 'complete', reason: string }

/** One advancing function, over already collected evidence. It cannot perform I/O. */
export function advanceWork(work: WorkObservation, receipt: WorkActionReceipt | null, now: number): WorkDecision {
  if (work.owner === 'v1') return { kind: 'wait', reason: 'existing v1 owner' }
  if (work.checkedAt > now || now - work.checkedAt > WORK_OBSERVATION_MAX_AGE_MS) {
    return { kind: 'inspect', reason: 'refresh through the existing observation reader' }
  }
  const stage = work.stage
  if (stage.kind === 'pull' && stage.mergeSha !== null) {
    if (!/^[a-f0-9]{40}$/.test(stage.mergeSha) || stage.ci?.merged !== true) {
      return { kind: 'inspect', reason: 'contradictory merge evidence' }
    }
    return { kind: 'complete', reason: `confirmed merge ${stage.mergeSha}` }
  }
  if (stage.kind === 'pull' && stage.queueEntry !== null) return { kind: 'wait', reason: `native merge queue ${stage.queueEntry}` }
  if (work.refusal) return { kind: 'wait', reason: work.refusal }
  if (work.held) return { kind: 'wait', reason: 'person stopped or held this work' }
  if (receipt) {
    if (receipt.basisRevision > work.revision) return { kind: 'inspect', reason: 'receipt is newer than observations' }
    if (receipt.state === 'running') return { kind: 'wait', reason: `attempt ${receipt.attempt} is still owned` }
    if (receipt.state === 'uncertain') return { kind: 'inspect', reason: `reconcile uncertain ${receipt.action} from ${receipt.reference}` }
    if (receipt.state === 'not-started' && receipt.retryAt !== null && now < receipt.retryAt) {
      return { kind: 'wait', reason: `safe no-write retry at ${receipt.retryAt}` }
    }
    if (receipt.state === 'finished' && receipt.basisRevision === work.revision) {
      return { kind: 'inspect', reason: 'worker finished; artifact outcome has not been observed' }
    }
  }
  const propose = (action: WorkAction): WorkDecision => {
    if (receipt?.state === 'finished' && receipt.action === action) {
      const changedArtifact = stage.kind === 'pull' ? stage.head !== receipt.head
        : stage.kind === 'issue' && action === 'review-issue' && receipt.issueBodyRevision != null
          && stage.bodyRevision !== receipt.issueBodyRevision
      if (!changedArtifact) return { kind: 'inspect', reason: `worker finished without a verified ${action} outcome` }
    }
    return { kind: 'propose', action, basisRevision: work.revision, head: stage.kind === 'pull' ? stage.head : null, issueBodyRevision: stage.kind === 'issue' ? stage.bodyRevision : null }
  }
  if (stage.kind === 'plan') {
    return stage.assigned ? propose('create-issue') : { kind: 'wait', reason: 'plan has not been assigned' }
  }
  if (stage.kind === 'issue') {
    if (stage.closed) return { kind: 'inspect', reason: 'closed issue does not prove implementation merged' }
    return stage.reviewedRevision === stage.bodyRevision ? propose('implement') : propose('review-issue')
  }
  const ci = stage.ci
  if (!ci || ci.head !== stage.head) return { kind: 'inspect', reason: 'CI evidence for the current head is missing' }
  if (ci.state === 'closed') return { kind: 'inspect', reason: 'closed PR is not a confirmed merge' }
  if (ci.draft) return { kind: 'wait', reason: 'pull request is a draft' }
  if (ci.mergeable === false) return propose('repair-conflicts')
  if (ci.mergeableState === 'behind') {
    if (stage.mergeQueue === null) return { kind: 'inspect', reason: 'branch update policy is unknown' }
    if (!stage.mergeQueue) return propose('update-branch')
  }
  if (stage.greyCiEligible) return propose('rerun-grey-ci')
  if (ci.failing.length > 0) return propose('repair-ci')
  if (ci.pending) return stage.ciStuck ? propose('repair-stuck-ci') : { kind: 'wait', reason: 'CI is running' }
  if (ci.pending !== false) return { kind: 'inspect', reason: 'CI completion is unknown' }
  if (stage.review === 'unread' || stage.unresolved === null) return { kind: 'inspect', reason: 'review coverage is incomplete' }
  if (stage.review === 'changes') return propose('fix-review')
  if (stage.review === 'needed' || stage.reviewedHead !== stage.head) return propose('review-pr')
  if (stage.approvedHead !== stage.head) return propose('approve')
  if (stage.unresolved > 0) return propose('resolve-threads')
  if (stage.ready !== true) return { kind: 'inspect', reason: 'native merge readiness is not confirmed' }
  return propose('merge')
}
