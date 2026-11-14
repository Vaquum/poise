import { chainBasis, type BehaviorChain, type ChainBehavior, type ChainInvocation } from './behavior-chain-store'
import { validReviewResponse, type ReviewResponse } from './review-response'
import { nativeResourcesPending, resourceReleaseProven } from './behavior-resource-receipt'
import { matchingNativeActionReceipt } from './behavior-chain-action'

export const CHAIN_OBSERVATION_MAX_AGE_MS = 120_000
// The readiness blockers an open conversation can explain. Any other also fails
// the native resolver's gate, and that deferral is re-admitted without backoff.
const CONVERSATION_BLOCKERS = new Set(['merge_state_not_clean', 'required_reviews_not_approved'])

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
  reviewPublication?: { callId: string, planSha?: string, complete: boolean, issueRevision: string,
    receipts: Array<{ issue: string, comment_id: number, author: string, url: string | null }> }
  existingPulls: string[]
  externalMerge?: { pull_number: number, merge_sha: string }
  workPublication?: { callId: string, repliesComplete: boolean, resumable?: boolean, planSha?: string }
  greyRecovery?: { invocationId: string, receipt: Record<string, unknown> }
  ciDependency?: { invocationId: string, base: string, recovered: boolean }
  ciRecovery?: { invocationId: string, removal: string, integration: string, recovered: boolean, reason: string }
  testDependency?: { invocationId: string, verified: boolean, recovered: boolean, reason?: string,
    recheck?: string,
    recovery?: { merge: string, base: string, run: Record<string, unknown> } }
  prerequisites?: { wait: string | null, base: string | null, evidence: Record<string, unknown>[] }
  ciBaseUpdate?: { from: string, head: string, base: string, tree: string }
  fullSuite?: Record<string, unknown>
  remediation?: Record<string, unknown>
  pull: null | {
    number: number, head: string, headSince: number, state: string, draft: boolean, merged: boolean, mergeSha: string | null,
    queueEntry: string | null, queueRemoval: null | { id: string, reason: string | null, at: number, actor: string | null },
    queueEntryDetails?: { id: string, state: string, base: string | null, head: string | null } | null,
    changesRequested: boolean, unresolved: number, unresolvedOutdated?: number, approved: boolean, ready: boolean,
    reviewIds: number[], reviewRevision: string,
    reviewContext?: string, mergedAt?: number | null,
    reviewReceipts: Array<{ id: number, head: string, state: string, invocation: string | null, response?: unknown, submittedAt?: number }>,
    greyRuns: Array<{ id: number, attempt: number }>,
    pending: boolean, failing: string[], conflict: boolean, behind: boolean,
    checksState?: string | null, readinessBlockers?: string[],
  }
}
export type ChainDecision =
  | { kind: 'wait', reason: string }
  | { kind: 'hold', reason: string }
  | { kind: 'complete', mergeSha: string }
  | { kind: 'supersede', evidence: Record<string, unknown> }
  | { kind: 'invoke', behavior: ChainBehavior, basis: string, actor: string, reviewer: ChainReviewer | null, reason: string }
export interface MergeReviewEvidence { before: ChainObservation | null, firstMerged: ChainObservation | null }

function settled(chain: BehaviorChain, behavior: ChainBehavior, basis: string, slot: string | null): ChainInvocation[] {
  return chain.invocations.filter((invocation) => invocation.behavior === behavior && invocation.basis === basis
    && invocation.slot === slot && invocation.state === 'settled')
}

function succeeded(invocation: ChainInvocation): boolean {
  return invocation.evidence?.status === 'completed'
}

/** This proof comes from Caller's bounded artifact verification, never prose. */
export function implementationTestDependency(invocation: ChainInvocation) {
  const evidence = invocation.evidence
  const artifact = evidence?.artifact as Record<string, unknown> | undefined
  const prepared = artifact?.prepared as Record<string, unknown> | undefined
  const proof = artifact?.test_dependency as { verified: boolean, base: string, run: number | string, runAttempt: number,
    baselineRun: number | string, baselineAttempt: number, remediation: string, source?: string,
    capture?: { call: string, nonce: string, repository: string, base: string }, candidate?: string, baselineCapture?: string,
    relay?: { original: { payload: string, signature: string }, baseline: { payload: string, signature: string } },
    failures: Array<{ file: string, test: string, cause: string }> } | undefined
  const relay = proof?.source === 'relay'
  const validRuns = relay ? [proof.run, proof.baselineRun].every(id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id))
    && proof.capture?.call === invocation.callId && chainBasis(proof.capture) === chainBasis(artifact?.test_capture)
    && proof.capture?.base === proof.base && /^[a-f0-9]{64}$/.test(proof.capture.nonce)
    && [proof.candidate, proof.baselineCapture].every(digest => typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest))
    && proof.candidate !== proof.baselineCapture
    && [proof.relay?.original, proof.relay?.baseline].every(receipt => typeof receipt?.payload === 'string' && typeof receipt.signature === 'string')
    : proof && [proof.run, proof.baselineRun].every(id => Number.isSafeInteger(id) && Number(id) > 0)
  if (invocation.behavior !== 'implement-issue' || evidence?.status !== 'failed' || evidence.action !== 'not_started'
    || evidence.outcome !== 'preflight_failed' || evidence.error_code !== 'atomic_work_blocked' || artifact?.phase !== 'executing'
    || [artifact.plan_sha, artifact.publication_head, artifact.replies_started, artifact.publication, artifact.result,
      artifact.receipts, evidence.receipts, evidence.review_id, evidence.head_sha, evidence.publicationPlan,
      evidence.publicationResume, evidence.publicationReceipt, evidence.nativeActionReceipt].some(value => value != null)
    || !proof || proof.verified !== true || !/^[a-f0-9]{40}$/.test(proof.base) || prepared?.checkout_head !== proof.base
    || !validRuns || ![proof.runAttempt, proof.baselineAttempt].every(id => Number.isSafeInteger(id) && id > 0)
    || proof.run === proof.baselineRun || typeof proof.remediation !== 'string'
    || !Array.isArray(proof.failures) || !proof.failures.length || proof.failures.some(failure =>
      !failure || typeof failure.file !== 'string' || !failure.file || typeof failure.test !== 'string' || !failure.test
      || typeof failure.cause !== 'string' || !failure.cause.trim())) return null
  return proof
}

/** Only Caller's original, compact no-write queue evidence can carry this hold. */
export function queueCiBlocker(invocation: ChainInvocation) {
  const evidence = invocation.evidence
  const artifact = evidence?.artifact as Record<string, unknown> | undefined
  const ci = artifact?.ci_blocker as Record<string, unknown> | undefined
  const queue = ci?.queue as NonNullable<BehaviorChain['ciHold']>['queue']
  if (invocation.behavior !== 'repair-pr' || evidence?.status !== 'failed' || evidence.action !== 'not_started'
    || evidence.error_code !== 'atomic_work_blocked' || artifact?.phase !== 'executing'
    || [artifact.plan_sha, artifact.publication_head, artifact.publication, artifact.result, artifact.replies_started,
      evidence.receipts, evidence.review_id, evidence.head_sha, evidence.publicationResume].some(value => value != null)
    || ci?.action !== 'list_failing_ci' || ci.head_sha !== invocation.request.context?.head
    || !Array.isArray(ci.failing) || ci.failing.length || !queue
    || queue.removal !== invocation.request.context?.queueRemoval || !queue.removal
    || ![ci.head_sha, queue.integration, queue.base].every(value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value))
    || !Array.isArray(queue.failures) || !queue.failures.length || queue.failures.some(failure => !failure
      || typeof failure.name !== 'string' || !failure.name || typeof failure.url !== 'string' || !failure.url
      || ![failure.check, failure.job, failure.run, failure.workflow, failure.attempt].every(id => Number.isSafeInteger(id) && id > 0))) return undefined
  return queue
}

export function recoveredQueueRepair(chain: BehaviorChain, observation: ChainObservation) {
  const pull = observation.pull, recovery = observation.ciRecovery
  return chain.invocations.find(invocation => {
    const queue = queueCiBlocker(invocation)
    return queue && invocation.state === 'settled' && resourceReleaseProven(invocation.evidence ?? {}, true)
      && recovery?.invocationId === invocation.id && recovery.recovered && recovery.removal === queue.removal
      && recovery.integration === queue.integration && pull?.queueRemoval?.id === queue.removal
      && pull.queueRemoval.reason === 'failed_checks' && invocation.request.context?.head === pull.head
  })
}

export function chainCiDependency(chain: BehaviorChain, removal?: string | null) {
  const invocation = [...chain.invocations].reverse().find(item => item.behavior === 'repair-pr' && item.state === 'settled'
    && (succeeded(item) && (item.evidence?.artifact as Record<string, unknown> | null)?.ci_dependency
      || queueCiBlocker(item) && resourceReleaseProven(item.evidence ?? {}, true)
        && (item.evidence?.artifact as { ci_blocker?: Record<string, unknown> } | undefined)?.ci_blocker?.ci_dependency))
  if (!invocation) return null
  const artifact = invocation.evidence!.artifact as Record<string, unknown>
  const value = artifact.ci_dependency ?? (artifact.ci_blocker as Record<string, unknown> | undefined)?.ci_dependency
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('repair CI dependency is invalid')
  const dependency = value as { head: string, integration: string, base: string, removal: string, remediation: string,
    allShared: boolean, failures: Array<{ check: number, name: string, run: number, workflow: number }> }
  if (![dependency.head, dependency.integration, dependency.base].every(sha => typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha))
    || dependency.head !== invocation.request.context?.head || dependency.removal !== invocation.request.context.queueRemoval
    || typeof dependency.remediation !== 'string' || !Array.isArray(dependency.failures) || !dependency.failures.length
    || dependency.failures.some(item => !item || typeof item.name !== 'string'
      || ![item.check, item.run, item.workflow].every(id => Number.isSafeInteger(id) && id > 0))
    || dependency.allShared !== true && invocation.evidence?.action !== 'published') throw new Error('repair CI dependency lacks its verified integration evidence')
  if (removal && removal !== dependency.removal) return null
  const queue = queueCiBlocker(invocation)
  if (queue && (dependency.integration !== queue.integration || dependency.base !== queue.base || dependency.allShared !== true
    || dependency.failures.length !== queue.failures.length || queue.failures.some(failure => !dependency.failures.some(item =>
      item.check === failure.check && item.run === failure.run && item.workflow === failure.workflow && item.name === failure.name)))) return null
  return { invocation, dependency }
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
      incompleteFindings: evidence.action === 'requested_changes' && evidence.outcome === 'incomplete',
      legacyNegative: evidence.action === 'requested_changes' && evidence.outcome === 'changes_requested',
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
  if (behavior === 'repair-pr' && chain.repairRecovery) {
    const recovery = chain.repairRecovery
    const admitted = chain.invocations.find(invocation => invocation.id === recovery.admission)
    if (admitted && !succeeded(admitted)) return { kind: 'hold', reason: 'the single repair after report diagnosis failed; inspect its Call before explicitly resuming' }
    if (!recovery.admission) {
      if (basis !== recovery.basis || reviewer?.slot !== recovery.slot || actor !== chain.author) return { kind: 'hold',
        reason: 'repair report diagnosis no longer matches the pinned source repair' }
      return { kind: 'invoke', behavior, basis, actor, reviewer, reason: 'apply the retained report diagnosis through the original repair owner' }
    }
  }
  if (behavior === 'implement-issue' && chain.testRecovery) {
    const original = chain.invocations.find(item => item.id === chain.testRecovery!.hold.invocationId)
    if (chain.testRecovery.admission) return { kind: 'hold', reason: 'the single implementation after verified test recovery was admitted; another attempt requires Resume' }
    if (!original || original.basis !== basis || original.slot !== reviewer?.slot || original.actor !== actor) return { kind: 'hold', reason: 'verified test recovery no longer matches the original implementation source' }
    return { kind: 'invoke', behavior, basis, actor, reviewer, reason }
  }
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

/** Queue participation is separate from attribution of its enqueue mutation. */
export function lastChainQueueInvocation(chain: BehaviorChain): ChainInvocation | undefined {
  for (let index = chain.invocations.length - 1; index >= 0; index--) {
    const invocation = chain.invocations[index]
    if (invocation.behavior === 'merge-pr' && (invocation.evidence?.status === 'completed'
      || (invocation.evidence?.status === 'deferred' && invocation.evidence.outcome === 'in_queue'))
      && ['enqueued', 'in_queue'].includes(String(invocation.evidence?.outcome))) return invocation
  }
}

/** Closure fences effects, not adoption of original artifacts or receipts. */
export function closedChainTarget(chain: BehaviorChain, observation: ChainObservation | null, behavior: ChainBehavior): string | null {
  if (chain.supersession) return 'the repair is verified superseded'
  if (chain.mergeSha) return 'the pull request is confirmed merged'
  if (behavior === 'retire-pr') return null
  if (observation?.pull && (observation.pull.merged || observation.pull.state !== 'open')) return 'the pull request is closed'
  if (observation && !observation.issue.open && ['review-issue', 'implement-issue', 'repair-pr'].includes(behavior)) return 'the seed issue is closed'
  return null
}

export function automaticClosureHold(reason: string | null): boolean {
  return reason !== null && (reason === 'seed issue closed without a confirmed merged pull request'
    || reason === 'pull request closed without a confirmed merge'
    || /^No new (?:review-issue|implement-issue|repair-pr): the seed issue is closed$/.test(reason)
    || reason === 'Original outcome requires read-only reconciliation because the seed issue is closed')
}

/** No timers, processes, GitHub writes or Chat sessions. The scheduler commits
 * this decision's admission before handing one invocation to native Caller. */
export function decideBehaviorChain(chain: BehaviorChain, observation: ChainObservation, now: number,
  mergeEvidence?: MergeReviewEvidence): ChainDecision {
  const pending = chain.invocations.find((invocation) => invocation.state !== 'settled')
  if (pending) return { kind: 'wait', reason: `${pending.behavior} is ${pending.state}; its native outcome must settle first` }
  if (chain.supersession) return { kind: 'wait', reason: 'repair is verified superseded' }
  const pull = observation.pull
  if (!Number.isFinite(observation.checkedAt) || now - observation.checkedAt > CHAIN_OBSERVATION_MAX_AGE_MS || observation.checkedAt > now) return { kind: 'wait', reason: 'behavior observations need refreshing' }
  if (pull?.merged && pull.mergeSha && /^[0-9a-f]{40}$/i.test(pull.mergeSha)) {
    const mergeBasis = mergeEvidence ? mergeEvidence.before : !chain.mergeSha ? chain.observation as ChainObservation | null : null
    const first = mergeEvidence ? mergeEvidence.firstMerged : !chain.mergeSha ? observation : null
    if (!mergeBasis?.pull || mergeBasis.pull.merged !== false || !Number.isFinite(mergeBasis.checkedAt)
      || typeof pull.mergedAt !== 'number' || !Number.isFinite(pull.mergedAt) || mergeBasis.checkedAt > pull.mergedAt
      || mergeBasis.pull.number !== pull.number || mergeBasis.pull.head !== pull.head || !mergeBasis.pull.reviewContext
      || !first?.pull?.merged || first.pull.number !== pull.number || first.pull.head !== pull.head
      || first.pull.mergeSha !== pull.mergeSha || first.pull.mergedAt !== pull.mergedAt
      || first.pull.reviewContext !== mergeBasis.pull.reviewContext || pull.reviewContext !== first.pull.reviewContext
      || !Array.isArray(mergeBasis.prReviewers) || !mergeBasis.prReviewers.length) {
      return { kind: 'hold', reason: 'confirmed merge retains an open review obligation: original pre-merge review basis is missing or contradictory' }
    }
    const original = { ...observation, prReviewers: mergeBasis.prReviewers, pull: { ...pull, reviewContext: mergeBasis.pull.reviewContext } }
    const basis = chainBasis(['pr', pull.head, original.pull.reviewContext])
    if (original.prReviewers.some((reviewer) => reviewComplete(chain, 'review-pr', basis, reviewer, original) !== 'complete')) {
      return { kind: 'hold', reason: 'confirmed merge retains an open review obligation: qualifying pre-merge review response is missing' }
    }
    return { kind: 'complete', mergeSha: pull.mergeSha }
  }
  const retired = chain.invocations.at(-1)
  const retiredProof = retired?.behavior === 'retire-pr' ? matchingNativeActionReceipt(chain, retired) : null
  if (retired?.behavior === 'retire-pr' && retiredProof && ['closed', 'already_closed'].includes(String(retiredProof.result.outcome))) {
    if (chain.invocations.some(invocation => nativeResourcesPending({ ...invocation })
      || invocation.model !== null && invocation.callId !== null && !resourceReleaseProven(invocation.evidence ?? {}, true))) return { kind: 'wait', reason: 'original native resource release must settle before supersession' }
    if (chain.held && !automaticClosureHold(chain.held)) return { kind: 'wait', reason: chain.held }
    return { kind: 'supersede', evidence: retiredProof.result.coverage as Record<string, unknown> }
  }
  // An unconfirmed retirement falls through to fresh evidence below: the
  // duplicate head may have moved since the attempt. Re-invocation is
  // basis-guarded there so identical evidence holds instead of looping.
  const remediation = observation.remediation
  const remediationDuplicate = remediation?.duplicate as { number?: unknown, head?: unknown } | undefined
  const coverage = !observation.issue.open && observation.fullSuite ? observation.fullSuite
    : remediation?.verified === true && pull && !pull.merged && !observation.existingPulls.length
      && remediationDuplicate?.number === pull.number && remediationDuplicate.head === pull.head
      && observation.publication.head_sha === pull.head && observation.publication.pull_number === pull.number ? remediation : null
  if (coverage) {
    if (chain.held && !automaticClosureHold(chain.held)) return { kind: 'wait', reason: chain.held }
    if (observation.existingPulls.length) return { kind: 'hold', reason: `full-suite recovery needs a decision for linked work: ${observation.existingPulls.join(', ')}` }
    const duplicate = coverage.duplicate as { number?: unknown, head?: unknown } | null
    if (coverage.verified !== true || !pull || pull.merged || duplicate?.number !== pull.number || duplicate.head !== pull.head
      || observation.publication.head_sha !== pull.head || observation.publication.pull_number !== pull.number) {
      return { kind: 'hold', reason: `full-suite recovery needs a decision: ${String(coverage.reason || 'latest duplicate head is not fully covered')}` }
    }
    if (chain.invocations.some(invocation => nativeResourcesPending({ ...invocation })
      || invocation.model !== null && invocation.callId !== null && !resourceReleaseProven(invocation.evidence ?? {}, true))) return { kind: 'wait', reason: 'original native resource release must settle before retirement' }
    if (retired?.behavior === 'retire-pr' && retired.basis === chainBasis(['retire', coverage])) {
      return { kind: 'hold', reason: `redundant PR retirement needs a decision: ${String(retiredProof?.result.reason || 'the original close response did not confirm retirement')}` }
    }
    return { kind: 'invoke', behavior: 'retire-pr', basis: chainBasis(['retire', coverage]), actor: chain.author,
      reviewer: null, reason: 'close the verified redundant repair after original invocation settlement' }
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
    if (observation.prerequisites?.wait !== null) return { kind: 'wait',
      reason: observation.prerequisites?.wait || 'GitHub prerequisite evidence is missing' }
    return propose(chain, 'implement-issue', issueBasis, chain.author, observation.implementer,
      'all required issue review invocations posted their comments', now)
  }
  if (pull.queueEntry) {
    const entry = pull.queueEntryDetails?.id === pull.queueEntry ? pull.queueEntryDetails : null
    if (!entry) return { kind: 'wait', reason: `native merge queue owns entry ${pull.queueEntry}` }
    return { kind: 'wait', reason: `native merge queue owns entry ${pull.queueEntry}; queue ${entry.state}${entry.state === 'UNMERGEABLE' ? '; cause unknown' : ''}` }
  }
  const dismissed = pull.reviewReceipts.find((review) => review.head === pull.head && review.state === 'DISMISSED'
    && chain.invocations.some((invocation) => invocation.behavior === 'approve-pr' && invocation.callId === review.invocation))
  if (dismissed) return { kind: 'hold', reason: `approval ${dismissed.id} was dismissed on the current head; a decision is required` }
  const lastQueue = lastChainQueueInvocation(chain)
  const dependency = chainCiDependency(chain, pull.queueRemoval?.id)
  const queueRecovery = recoveredQueueRepair(chain, observation)
  let queueVerification = queueRecovery
    ? chainBasis(['queue-recovery', pull.head, pull.queueRemoval?.id, queueRecovery.id, pull.reviewContext]) : null
  if (dependency && !queueRecovery && !pull.failing.length && !pull.conflict && !pull.behind && !pull.changesRequested
    && !(pull.unresolved && !pull.approved)) {
    const recovery = observation.ciDependency
    if (recovery?.invocationId !== dependency.invocation.id || !recovery.recovered) return { kind: 'wait',
      reason: `shared baseline CI dependency: ${dependency.dependency.remediation}; candidate ${dependency.dependency.head}; integration ${dependency.dependency.integration}; base ${dependency.dependency.base}; ${dependency.dependency.failures.map(item => `${item.name} (run ${item.run}, check ${item.check})`).join(', ')}; awaiting verified base recovery` }
    queueVerification = chainBasis(['baseline-recovery', pull.head, dependency.invocation.id, recovery.base, pull.reviewContext])
  }
  if (lastQueue?.evidence?.head_sha === pull.head) {
    const removal = pull.queueRemoval
    if (!removal || removal.at < lastQueue.admittedAt) return { kind: 'wait', reason: 'queue entry disappeared; awaiting GitHub removal evidence' }
    if (removal.reason === 'merged') return { kind: 'wait', reason: 'GitHub queue reports a merge; awaiting confirmed merge evidence' }
    if (!['failed_checks', 'merge_conflict'].includes(removal.reason || '')) return { kind: 'hold', reason: `queue removal requires a decision: ${removal.reason || 'unknown reason'} (${removal.id})` }
    const repair = [...chain.invocations].reverse().find((invocation) => invocation.behavior === 'repair-pr' && succeeded(invocation)
      && invocation.request.context?.head === pull.head && invocation.request.context.queueRemoval === removal.id) ?? queueRecovery
    if (!repair || ((pull.changesRequested || pull.failing.length || pull.conflict || pull.behind)
      && repair.request.context?.reviewRevision !== pull.reviewRevision)) return propose(chain, 'repair-pr',
      chainBasis(['queue', pull.head, removal.id, pull.reviewRevision]), chain.author, observation.repairer,
      `diagnose and repair GitHub queue rejection ${removal.id}: ${removal.reason}; PR-head green checks do not prove integration success`, now)
    queueVerification ??= chainBasis(['queue-verification', pull.head, removal.id, repair.id])
  }
  const repairBasis = chainBasis(['repair', pull.head, pull.failing, pull.conflict, pull.behind, pull.changesRequested, pull.unresolved, pull.reviewRevision, observation.issue.revision])
  if (pull.conflict) return propose(chain, 'repair-pr', repairBasis, chain.author, observation.repairer,
    'repair the confirmed branch conflict before reviewing the current head', now)
  const reviewedHeadBasis = chainBasis(['pr', pull.head, pull.reviewContext])
  for (const reviewer of observation.prReviewers) {
    const reviewed = reviewComplete(chain, 'review-pr', reviewedHeadBasis, reviewer, observation)
    if (reviewed === 'missing-artifact') return { kind: 'hold', reason: `PR review ${reviewer.slot} lacks its exact-head submission receipt` }
    if (reviewed === 'needed') return propose(chain, 'review-pr', reviewedHeadBasis, chain.reviewer, reviewer, 'review the actual current pull-request head', now)
  }
  const grey = pull.greyRuns[0]
  if (grey) return propose(chain, 'rerun-grey-ci', chainBasis(['grey', pull.head, grey.id, grey.attempt]), chain.reviewer, null,
    `recover completed grey workflow ${grey.id} attempt ${grey.attempt} through the existing native guard`, now)
  const answered = chain.invocations.some((invocation) => invocation.behavior === 'repair-pr' && succeeded(invocation)
    && invocation.request.context?.head === pull.head && invocation.request.context.reviewRevision === pull.reviewRevision)
  const publishedRepair = chain.invocations.some((invocation) => invocation.behavior === 'repair-pr' && succeeded(invocation)
    && invocation.evidence?.action === 'published' && invocation.evidence.head_sha === pull.head
    && invocation.callId === observation.publication.head_invocation
    && invocation.request.argv.includes('--expected-issue-revision')
    && invocation.request.argv[invocation.request.argv.indexOf('--expected-issue-revision') + 1] === observation.issue.revision)
  if (pull.failing.length || pull.conflict || pull.behind || pull.changesRequested || (pull.unresolved && !pull.approved)) {
    if ((answered || publishedRepair && !pull.changesRequested) && !pull.failing.length && !pull.conflict && !pull.behind) return propose(chain, 'approve-pr',
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
  // GitHub's merge rule also counts outdated conversations, which readiness does not
  // block on, so they are resolved only when one could be what keeps readiness red.
  const threads = pull.unresolved || (!pull.ready && pull.readinessBlockers?.every((blocker) => CONVERSATION_BLOCKERS.has(blocker)) ? pull.unresolvedOutdated ?? 0 : 0)
  if (threads) return propose(chain, 'resolve-threads', chainBasis(['resolve', pull.head, threads]), chain.reviewer, null,
    'resolve only conversations the native current-head approval gate permits', now)
  if (!pull.ready) return { kind: 'wait', reason: 'native repository readiness gates are not satisfied' }
  if (!chain.invocations.some((invocation) => succeeded(invocation) && ['reviewed_clean', 'approved'].includes(String(invocation.evidence?.action))
    && chainReviewResponse(chain, invocation, observation, now))) return { kind: 'hold', reason: 'merge requires a retained substantive final-context review response' }
  return propose(chain, 'merge-pr', chainBasis(['merge', pull.head, queueVerification]), chain.reviewer, null,
    'merge or enqueue through native head-pinned repository gates', now)
}
