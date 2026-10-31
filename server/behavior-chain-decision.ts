import { chainBasis, type BehaviorChain, type ChainBehavior, type ChainInvocation } from './behavior-chain-store'
import { validReviewResponse, type ReviewResponse } from './review-response'

export interface ChainReviewer { slot: string, model: string, recovery: string }
export interface ChainObservation extends Record<string, unknown> {
  checkedAt: number
  issue: { open: boolean, revision: string, eligible: boolean, commentIds: number[] }
  issueReviewers: ChainReviewer[]
  prReviewers: ChainReviewer[]
  implementer: ChainReviewer
  repairer: ChainReviewer
  approver: ChainReviewer
  publication: { pull_number: number | null, head_sha: string | null, head_invocation: string | null, state: string | null, merged: boolean, merge_sha: string | null }
  reviewPublication?: { callId: string, complete: boolean, issueRevision: string,
    receipts: Array<{ issue: string, comment_id: number, author: string, url: string | null }> }
  existingPulls: string[]
  workPublication?: { callId: string, repliesComplete: boolean, resumable?: boolean, planSha?: string }
  greyRecovery?: { invocationId: string, receipt: Record<string, unknown> }
  pull: null | {
    number: number, head: string, headSince: number, state: string, draft: boolean, merged: boolean, mergeSha: string | null,
    queueEntry: string | null, queueRemoval: null | { id: string, reason: string | null, at: number, actor: string | null },
    changesRequested: boolean, unresolved: number, approved: boolean, ready: boolean,
    reviewIds: number[], reviewRevision: string,
    reviewContext?: string, mergedAt?: number | null,
    reviewReceipts: Array<{ id: number, head: string, state: string, invocation: string | null, response?: unknown, submittedAt?: number }>,
    greyRuns: Array<{ id: number, attempt: number }>,
    pending: boolean, failing: string[], conflict: boolean, behind: boolean,
  }
}
export type ChainDecision =
  | { kind: 'wait', reason: string }
  | { kind: 'hold', reason: string }
  | { kind: 'complete', mergeSha: string }
  | { kind: 'invoke', behavior: ChainBehavior, basis: string, actor: string, reviewer: ChainReviewer | null, reason: string }

function settled(chain: BehaviorChain, behavior: ChainBehavior, basis: string, slot: string | null): ChainInvocation[] {
  return chain.invocations.filter((invocation) => invocation.behavior === behavior && invocation.basis === basis
    && invocation.slot === slot && invocation.state === 'settled')
}

function succeeded(invocation: ChainInvocation): boolean {
  return invocation.evidence?.status === 'completed'
}

export function chainReviewResponse(chain: BehaviorChain, invocation: ChainInvocation, observation: ChainObservation,
  now: number): ReviewResponse | null {
  const pull = observation.pull
  const evidence = invocation.evidence
  const artifact = evidence?.artifact as Record<string, unknown> | null
  const response = artifact?.review_response
  const recoveryIndex = invocation.request.argv.indexOf('--recovery-model')
  const review = pull?.reviewReceipts.find((item) => item.id === evidence?.review_id && item.invocation === invocation.callId
    && item.head === pull.head && item.state === ({ reviewed_clean: 'COMMENTED', approved: 'APPROVED', requested_changes: 'CHANGES_REQUESTED' } as Record<string, string>)[String(evidence?.action)])
  if (!pull || !evidence || !review || !invocation.callId || !invocation.model || !pull.reviewContext
    || !validReviewResponse(response, { repository: chain.repository, number: pull.number, head: pull.head,
      actor: invocation.actor, callId: invocation.callId, model: invocation.model, context: pull.reviewContext,
      recoveryModel: recoveryIndex >= 0 ? invocation.request.argv[recoveryIndex + 1] : null,
      startedAt: invocation.admittedAt, completedAt: Number(evidence.completedAt) }, now)
    || chainBasis(response) !== chainBasis(review.response) || typeof review.submittedAt !== 'number' || !Number.isFinite(review.submittedAt)
    || response.completed_at > review.submittedAt + 999 || review.submittedAt > now) return null
  if (pull.merged && (typeof pull.mergedAt !== 'number' || !Number.isFinite(pull.mergedAt) || response.completed_at > pull.mergedAt || review.submittedAt > pull.mergedAt)) return null
  return response
}

function propose(chain: BehaviorChain, behavior: ChainBehavior, basis: string, actor: string,
  reviewer: ChainReviewer | null, reason: string, now: number): ChainDecision {
  const history = settled(chain, behavior, basis, reviewer?.slot ?? null)
  const successful = [...history].reverse().find(succeeded)
  if (successful) return { kind: 'wait', reason: `${behavior} finished; waiting for its verified artifact or changed input` }
  const attempts = history.filter((invocation) => invocation.evidence?.status !== 'deferred' && invocation.admissionSequence > chain.resumedAfterSequence)
  if (attempts.length) {
    const last = attempts.at(-1)!
    if (last.evidence?.action !== 'not_started' && last.evidence?.outcome !== 'superseded') return { kind: 'hold', reason: `${behavior} has an uncertain effect; reconcile its native receipt before retrying` }
    if (attempts.length >= 3) return { kind: 'hold', reason: `${behavior} failed before publication three times: ${String(last.evidence?.error || 'native failure')}` }
    const completedAt = Number(last.evidence?.completedAt)
    if (!Number.isFinite(completedAt) || now < completedAt + 60_000 * 2 ** (attempts.length - 1)) return { kind: 'wait', reason: `${behavior} is in native failure backoff` }
  }
  return { kind: 'invoke', behavior, basis, actor, reviewer, reason }
}

function reviewComplete(chain: BehaviorChain, behavior: 'review-issue' | 'review-pr', basis: string, reviewer: ChainReviewer,
  observation: ChainObservation): 'complete' | 'missing-artifact' | 'needed' {
  const invocation = settled(chain, behavior, basis, reviewer.slot).reverse().find(succeeded)
  if (!invocation) return 'needed'
  const evidence = invocation.evidence!
  if (behavior === 'review-pr') return !!chainReviewResponse(chain, invocation, observation, observation.checkedAt)
    && typeof evidence.review_id === 'number' && Number(evidence.review_id) > 0
    && observation.pull?.reviewIds.includes(evidence.review_id) && evidence.head_sha === observation.pull?.head
    && ['reviewed_clean', 'requested_changes'].includes(String(evidence.action)) ? 'complete' : 'missing-artifact'
  if (evidence.action !== 'commented' || evidence.issue_revision !== observation.issue.revision || !Array.isArray(evidence.receipts)) return 'missing-artifact'
  return evidence.receipts.some((receipt: unknown) => {
    if (!receipt || typeof receipt !== 'object') return false
    const value = receipt as Record<string, unknown>
    return typeof value.issue === 'string' && value.issue.toLowerCase() === `${chain.repository}#${chain.issue}`.toLowerCase()
      && typeof value.author === 'string' && value.author.toLowerCase() === chain.reviewer.toLowerCase()
      && typeof value.comment_id === 'number' && observation.issue.commentIds.includes(value.comment_id)
  }) ? 'complete' : 'missing-artifact'
}

/** No timers, processes, GitHub writes or Chat sessions. The scheduler commits
 * this decision's admission before handing one invocation to native Caller. */
export function decideBehaviorChain(chain: BehaviorChain, observation: ChainObservation, now: number): ChainDecision {
  const pending = chain.invocations.find((invocation) => invocation.state !== 'settled')
  if (pending) return { kind: 'wait', reason: `${pending.behavior} is ${pending.state}; its native outcome must settle first` }
  const pull = observation.pull
  if (!Number.isFinite(observation.checkedAt) || now - observation.checkedAt > 120_000 || observation.checkedAt > now) return { kind: 'wait', reason: 'behavior observations need refreshing' }
  if (pull?.merged && pull.mergeSha && /^[0-9a-f]{40}$/i.test(pull.mergeSha)) {
    const basis = chainBasis(['pr', pull.head, pull.reviewContext])
    if (!observation.prReviewers.length || observation.prReviewers.some((reviewer) =>
      reviewComplete(chain, 'review-pr', basis, reviewer, observation) !== 'complete')) {
      return { kind: 'hold', reason: 'confirmed merge retains an open review obligation: qualifying pre-merge review response is missing' }
    }
    return { kind: 'complete', mergeSha: pull.mergeSha }
  }
  if (chain.held) return { kind: 'wait', reason: chain.held }
  if (!observation.issue.open && !pull) return { kind: 'hold', reason: 'seed issue closed without a confirmed merged pull request' }
  if (pull && pull.state !== 'open') return { kind: 'hold', reason: 'pull request closed without a confirmed merge' }
  if (pull?.draft) return { kind: 'wait', reason: 'pull request is a draft' }
  if (observation.existingPulls.length) return { kind: 'hold', reason: `seed issue already belongs to existing work: ${observation.existingPulls.join(', ')}` }
  if (!pull && !observation.issue.eligible) return { kind: 'wait', reason: 'seed issue no longer matches intake settings' }
  const issueBasis = chainBasis(['issue', observation.issue.revision])
  for (const reviewer of observation.issueReviewers) {
    const reviewed = reviewComplete(chain, 'review-issue', issueBasis, reviewer, observation)
    if (reviewed === 'missing-artifact') return { kind: 'hold', reason: `issue review ${reviewer.slot} lacks its posted GitHub comment` }
    if (reviewed === 'needed') return propose(chain, 'review-issue', issueBasis, chain.reviewer, reviewer, 'review the current seed issue', now)
  }
  if (!pull) {
    const partial = [...chain.invocations].reverse().find((invocation) => invocation.callId === observation.publication.head_invocation)
    if (partial && observation.publication.head_sha && partial.evidence?.artifact) return propose(chain, 'publish-issue',
      chainBasis(['publish', observation.publication.head_sha, partial.callId]), chain.author, null,
      'complete publication from the original durable receipt and confirmed pushed branch', now)
    if (observation.publication.head_sha) return { kind: 'hold', reason: 'seed branch exists without this chain’s native publication receipt' }
    const noChange = settled(chain, 'implement-issue', issueBasis, observation.implementer.slot).find((invocation) => invocation.evidence?.outcome === 'no_changes')
    if (noChange) return { kind: 'hold', reason: 'implementation returned no changes and produced no pull request' }
    return propose(chain, 'implement-issue', issueBasis, chain.author, observation.implementer,
      'all required issue review invocations posted their comments', now)
  }
  if (pull.queueEntry) return { kind: 'wait', reason: `native merge queue owns entry ${pull.queueEntry}` }
  const dismissed = pull.reviewReceipts.find((review) => review.head === pull.head && review.state === 'DISMISSED'
    && chain.invocations.some((invocation) => invocation.behavior === 'approve-pr' && invocation.callId === review.invocation))
  if (dismissed) return { kind: 'hold', reason: `approval ${dismissed.id} was dismissed on the current head; a decision is required` }
  const lastQueue = [...chain.invocations].reverse().find((invocation) => invocation.behavior === 'merge-pr'
    && invocation.evidence?.status === 'completed' && ['enqueued', 'in_queue'].includes(String(invocation.evidence.outcome)))
  let queueVerification: string | null = null
  if (lastQueue?.evidence?.head_sha === pull.head) {
    const removal = pull.queueRemoval
    if (!removal || removal.at < lastQueue.admittedAt) return { kind: 'wait', reason: 'queue entry disappeared; awaiting GitHub removal evidence' }
    if (!['failed_checks', 'merge_conflict'].includes(removal.reason || '')) return { kind: 'hold', reason: `queue removal requires a decision: ${removal.reason || 'unknown reason'} (${removal.id})` }
    const repair = [...chain.invocations].reverse().find((invocation) => invocation.behavior === 'repair-pr' && succeeded(invocation)
      && invocation.request.context?.head === pull.head && invocation.request.context.queueRemoval === removal.id)
    if (!repair || ((pull.changesRequested || pull.failing.length || pull.conflict || pull.behind)
      && repair.request.context?.reviewRevision !== pull.reviewRevision)) return propose(chain, 'repair-pr',
      chainBasis(['queue', pull.head, removal.id, pull.reviewRevision]), chain.author, observation.repairer,
      `diagnose and repair GitHub queue rejection ${removal.id}: ${removal.reason}; PR-head green checks do not prove integration success`, now)
    queueVerification = chainBasis(['queue-verification', pull.head, removal.id, repair.id])
  }
  const reviewedHeadBasis = chainBasis(['pr', pull.head, pull.reviewContext])
  for (const reviewer of observation.prReviewers) {
    const reviewed = reviewComplete(chain, 'review-pr', reviewedHeadBasis, reviewer, observation)
    if (reviewed === 'missing-artifact') return { kind: 'hold', reason: `PR review ${reviewer.slot} lacks its exact-head submission receipt` }
    if (reviewed === 'needed') return propose(chain, 'review-pr', reviewedHeadBasis, chain.reviewer, reviewer, 'review the actual current pull-request head', now)
  }
  const grey = pull.greyRuns[0]
  if (grey) return propose(chain, 'rerun-grey-ci', chainBasis(['grey', pull.head, grey.id, grey.attempt]), chain.reviewer, null,
    `recover completed grey workflow ${grey.id} attempt ${grey.attempt} through the existing native guard`, now)
  const repairBasis = chainBasis(['repair', pull.head, pull.failing, pull.conflict, pull.behind, pull.changesRequested, pull.unresolved, pull.reviewRevision, observation.issue.revision])
  const answered = chain.invocations.some((invocation) => invocation.behavior === 'repair-pr' && succeeded(invocation)
    && invocation.request.context?.head === pull.head && invocation.request.context.reviewRevision === pull.reviewRevision)
  if (pull.failing.length || pull.conflict || pull.behind || pull.changesRequested || (pull.unresolved && !pull.approved)) {
    if (answered && !pull.failing.length && !pull.conflict && !pull.behind) return propose(chain, 'approve-pr',
      queueVerification ?? chainBasis(['verify-repair', pull.head, pull.reviewRevision]), chain.reviewer, observation.approver,
      'verify the repair and its actual replies; unchanged code is not itself proof that the findings are addressed', now)
    return propose(chain, 'repair-pr', repairBasis, chain.author, observation.repairer, 'address actual reviews, failing CI and branch conflicts', now)
  }
  if (pull.pending) {
    if (now - pull.headSince >= 30 * 60_000) return propose(chain, 'repair-pr', chainBasis(['stuck-ci', pull.head]), chain.author,
      observation.repairer, 'diagnose the actual checks pending over 30 minutes; do not invent a failure or cancel legitimate work', now)
    return { kind: 'wait', reason: 'exact-head CI is still running' }
  }
  if (queueVerification) {
    const approval = settled(chain, 'approve-pr', queueVerification, observation.approver.slot).find((invocation) => succeeded(invocation)
      && invocation.evidence?.action === 'approved' && invocation.evidence.head_sha === pull.head
      && typeof invocation.evidence.review_id === 'number' && pull.reviewIds.includes(invocation.evidence.review_id)
      && chainReviewResponse(chain, invocation, observation, now))
    if (!approval) return propose(chain, 'approve-pr', queueVerification, chain.reviewer, observation.approver,
      'independently verify the queue-rejection diagnosis before a fresh native integration attempt', now)
  }
  if (!pull.approved) {
    const repair = [...chain.invocations].reverse().find((invocation) => invocation.behavior === 'repair-pr' && succeeded(invocation))
    return propose(chain, 'approve-pr', chainBasis(['approve', pull.head, pull.reviewRevision, repair?.id ?? null]), chain.reviewer, observation.approver,
      'review the current candidate and submit the native approval verdict', now)
  }
  if (pull.unresolved) return propose(chain, 'resolve-threads', chainBasis(['resolve', pull.head, pull.unresolved]), chain.reviewer, null,
    'resolve only conversations the native current-head approval gate permits', now)
  if (!pull.ready) return { kind: 'wait', reason: 'native repository readiness gates are not satisfied' }
  if (!chain.invocations.some((invocation) => succeeded(invocation) && ['reviewed_clean', 'approved'].includes(String(invocation.evidence?.action))
    && chainReviewResponse(chain, invocation, observation, now))) return { kind: 'hold', reason: 'merge requires a retained substantive final-context review response' }
  return propose(chain, 'merge-pr', chainBasis(['merge', pull.head, queueVerification]), chain.reviewer, null,
    'merge or enqueue through native head-pinned repository gates', now)
}
