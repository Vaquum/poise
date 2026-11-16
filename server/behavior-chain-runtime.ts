import { randomUUID } from 'node:crypto'
import { DATASTORE_MAX_AGE_SECONDS, staleDatastoreFailure } from './datastore-health'
import type { AgentLogSnapshot, LogEntry } from './agent-log-parse'
import { resourceReleaseContradicted, resourceReleaseProven } from './behavior-resource-receipt'
import type { DetachedProcessExit } from './process'
import { APPROVAL_CONVERSATION_REFUSAL, approvalConversationRefusal, automaticClosureHold, CHAIN_OBSERVATION_MAX_AGE_MS,
  chainReviewResponse, ciRefreshRequest, closedChainTarget, decideBehaviorChain, exhaustedApprovalConversationHold,
  heldCiRepair, implementationTestDependency, queueCiBlocker, repairQueueBlocker, type ChainDecision, type ChainObservation } from './behavior-chain-decision'
import { BehaviorChainJournal, BehaviorChainRevisionConflict, chainBasis, chainIdentity, type BehaviorChain, type ChainEvent, type ChainInvocation, type ChainRecoveryOrigin } from './behavior-chain-store'
import { budgetShortfall, executionLimits, headroomShortfall, measureBehaviorHeadroom, readBehaviorResourceAdmission,
  type BehaviorResourceAdmission, type BehaviorResourceHeadroom } from './behavior-resources'
import { attributedNativeAction, matchingNativeActionReceipt, nativeActionReceipt, nativeActionSettlement, nativeRequestSha } from './behavior-chain-action'
import { behaviorErrorMessage } from './behavior-diagnostics'
import { classifyBehaviorDiagnostic } from '../src/behavior-failure-cause'
import { CallerReceiptStoreError } from './service/caller-calls'
import { resumeLink } from './review-response'
import { diagnostic } from './logging'
import { resumeReviewArgument, yieldedFinalization, yieldedReview } from './review-continuation'

export interface ChainSeed { repository: string, number: number }
export interface ChainRuntimeOperations {
  enabled(): boolean
  accounts(): { author: string, reviewer: string }
  discover(): Promise<ChainSeed[]>
  closedSeedHints?(after: ChainSeed | null): Promise<Array<ChainSeed & { updatedAt: number }>>
  ownsRepository(repository: string): boolean
  observe(chain: BehaviorChain, verifyConflict?: boolean): Promise<ChainObservation>
  /** Also reports terminal uncertain publications and merges without a chain hold. */
  reportHold?(chain: BehaviorChain): Promise<string | null>
  implementationAdmission?(chain: BehaviorChain, observation: ChainObservation): Promise<{
    reason: string | null, source?: { id: string, sequence: number }, note?: string
  }>
  recoverReport?(chain: BehaviorChain, observation: ChainObservation): Promise<string | null>
  readInvocations(ids: string[]): Promise<AgentLogSnapshot>
  received(invocation: ChainInvocation, call: LogEntry): void
  authenticationRejected?(call: LogEntry): void
  authRecovered?(invocation: ChainInvocation): boolean | ChainRecoveryOrigin
  available(): boolean
  availableSlots?(): number
  capacity(): number
  /** Override for the synchronous admission-boundary probe; production and
   *  local validation measure the actual host. Tests stub this. */
  measureHeadroom?: () => BehaviorResourceHeadroom
  permitted(chain: BehaviorChain, decision: Extract<ChainDecision, { kind: 'invoke' }>): boolean
  request(chain: BehaviorChain, observation: ChainObservation, decision: Extract<ChainDecision, { kind: 'invoke' }>, id: string): Promise<ChainInvocation['request'] | null>
  launch(invocation: ChainInvocation, onExit: (result?: DetachedProcessExit) => void, allowed: () => boolean): Promise<boolean>
  perform(invocation: ChainInvocation, chain: BehaviorChain): Promise<Record<string, unknown>>
  readActionResult(invocation: ChainInvocation, call: LogEntry): Promise<Record<string, unknown>>
  resumePublication(invocation: ChainInvocation, head: string, correlation: string): Promise<Record<string, unknown>>
  /** True only when Caller won the original correlation without a worker. */
  fenceClosedTarget(chain: BehaviorChain, invocation: ChainInvocation): Promise<boolean>
  /** True when the original implementation is fenced for cooperative retirement. */
  retireClosedImplementation?(chain: BehaviorChain, invocation: ChainInvocation, call: LogEntry): Promise<boolean>
  wake(): void
}

export function nativeBehavior(behavior: ChainInvocation['behavior']): string | null {
  return ({ 'review-issue': 'issue_review', 'review-pr': 'pr_review', 'approve-pr': 'pr_approve',
    'implement-issue': 'implement_issue', 'repair-pr': 'repair_pr', 'merge-pr': 'native_action',
    'resolve-threads': 'native_action', 'rerun-grey-ci': 'native_action', 'publish-issue': 'native_action', 'retire-pr': 'native_action',
    'refresh-pr-ci': 'native_action' } as Partial<Record<ChainInvocation['behavior'], string>>)[behavior] ?? null
}

function receipt(call: LogEntry): Record<string, unknown> {
  return { status: call.status, action: call.action, outcome: call.outcome, head_sha: call.head_sha,
    review_id: call.review_id ?? null, receipts: call.receipts ?? null, artifact: call.artifact ?? null,
    issue_revision: call.issue_revision ?? null,
    resources_settled_at: call.resources_settled_at ?? null,
    resource_ownership: call.resource_ownership ?? null,
    ...(call.resource_guard ? { resource_guard: call.resource_guard } : {}),
    ...(call.diagnostic ? { diagnostic: call.diagnostic } : {}),
    error: call.error, error_code: call.error_code ?? null, completedAt: call.completed_at ? Date.parse(call.completed_at) : null }
}

function nativeResourcesReleased(call: LogEntry): boolean {
  const fence = call.outcome === 'target_closed' && call.artifact?.phase === 'admission_fenced'
  return resourceReleaseProven(receipt(call), !fence)
}

function rejectedMergedEnqueue(chain: BehaviorChain, invocation: ChainInvocation, call: LogEntry): boolean {
  const observation = chain.observation as ChainObservation | null
  const pull = observation?.pull, argv = invocation.request.argv, diagnostic = call.diagnostic
  const argument = (flag: string) => argv.filter(value => value === flag).length === 1 ? argv[argv.indexOf(flag) + 1] : undefined
  const startedAt = Date.parse(call.started_at_precise ?? call.started_at)
  const completedAt = Date.parse(call.completed_at ?? '')
  const releasedAt = Date.parse(call.resources_settled_at ?? '')
  if (!chain.mergeSha || !pull?.merged || pull.state !== 'closed' || pull.mergeSha !== chain.mergeSha
    || observation?.publication.merged !== true || observation.publication.merge_sha !== chain.mergeSha
    || observation.publication.pull_number !== pull.number || observation.publication.head_sha !== pull.head
    || invocation.behavior !== 'merge-pr' || invocation.model !== null || invocation.request.command !== 'github-interface'
    || chain.invocations.at(-1)?.id !== invocation.id || invocation.actor !== chain.reviewer
    || argv[0] !== '--merge-if-ready' || argv[1]?.replace(/^#/, '') !== String(pull.number)
    || argument('--expected-head') !== pull.head || !/^[a-f0-9]{40}$/i.test(pull.head)
    || argument('--token-user') !== invocation.actor || argument('--author') !== chain.author
    || call.status !== 'failed' || call.error_code !== 'native_action_failed' || call.action !== null || call.outcome !== null
    || call.head_sha !== null || call.response !== null || call.review_id != null || call.receipts != null
    || call.artifact?.phase !== 'performing_native_action' || call.artifact.request_sha !== nativeRequestSha(invocation.request)
    || call.artifact.response_sha != null || invocation.evidence?.nativeActionReceipt != null
    || invocation.evidence?.nativeActionResult != null || invocation.evidence?.nativeResponseSha != null
    || invocation.evidence?.callId != null && invocation.evidence.callId !== call.id
    || !nativeResourcesReleased(call) || ![startedAt, completedAt, releasedAt, pull.mergedAt, observation.checkedAt].every(Number.isFinite)
    || startedAt < invocation.admittedAt || completedAt < startedAt || releasedAt < completedAt
    || releasedAt > pull.mergedAt! || pull.mergedAt! > observation.checkedAt || observation.checkedAt > Date.now()
    || diagnostic?.version !== 1 || diagnostic.source !== 'caller' || diagnostic.severity !== 'error'
    || diagnostic.operation !== 'merge_if_ready' || diagnostic.phase !== 'native_action' || diagnostic.outcome !== 'unknown'
    || diagnostic.stderr_truncated !== false || diagnostic.context.submission !== 'uncertain'
    || diagnostic.context.refusal != null || diagnostic.context.call_id !== call.id
    || Object.entries({ correlation_id: invocation.id, repository: chain.repository, pr: call.pr_id,
      expected_head: pull.head, reviewer: invocation.actor, behavior: 'native_action' })
      .some(([key, value]) => diagnostic.context[key] != null && diagnostic.context[key] !== value)) return false
  // GitHubClient retained str(errors), a Python repr of this single refusal.
  // Match the complete response: a substring or another resolver error cannot
  // prove that the original, non-retried enqueue was rejected.
  return /^\[\{'type': 'UNPROCESSABLE', 'path': \['enqueuePullRequest'\], 'locations': \[\{'line': [1-9][0-9]*, 'column': [1-9][0-9]*\}\], 'message': 'Pull request is already in the queue'\}\]$/.test(diagnostic.stderr ?? '')
}

function beforeNativeScope(call: LogEntry): boolean {
  const ownership = call.resource_ownership
  return call.status === 'failed' && call.error_code === 'launch_preflight_failed'
    && call.action === 'not_started' && call.outcome === 'preflight_failed' && call.head_sha === null
    && !call.artifact && !call.receipts && !call.review_id && !call.response && !call.runner && !call.resource_guard
    && ownership?.version === 1 && ownership.roots.length === 0 && ownership.errors.length === 0 && !ownership.process_pending
}

function implementBeforePublication(call: LogEntry): boolean {
  const artifact = call.artifact as Record<string, unknown> | null
  return call.behavior === 'implement_issue' && call.head_sha === null && call.review_id == null && call.receipts == null
    && artifact !== null && typeof artifact === 'object'
    && ['preparing', 'prepared', 'executing'].includes(String(artifact.phase))
    && artifact.plan_sha == null && artifact.publication_head == null
    && artifact.publication == null && artifact.result == null
    && artifact.replies_started == null && artifact.resource_error == null
}

function retireEligible(call: LogEntry): boolean {
  const retirement = (call.artifact as Record<string, unknown> | null)?.retirement as Record<string, unknown> | undefined
  return call.status === 'running' && implementBeforePublication(call) && retirement?.cause !== 'target_closed'
}

function retiredImplementation(call: LogEntry): boolean {
  const artifact = call.artifact as Record<string, unknown> | null
  const retirement = artifact?.retirement as Record<string, unknown> | undefined
  return call.status === 'superseded' && call.outcome === 'target_closed' && call.action === 'not_started'
    && call.error_code === 'target_closed' && !call.error && call.head_sha === null && call.expected_head === null
    && call.review_id == null && call.receipts == null && implementBeforePublication(call)
    && retirement?.cause === 'target_closed'
}

function sameReceipt(prior: Record<string, unknown> | null, next: Record<string, unknown>): boolean {
  return Object.entries(next).every(([key, value]) => chainBasis(prior?.[key] ?? null) === chainBasis(value ?? null))
}

function ciOnlyHold(invocation: ChainInvocation, call: LogEntry): BehaviorChain['ciHold'] {
  const ci = call.artifact?.ci_blocker as Record<string, unknown> | undefined
  if (invocation.behavior !== 'repair-pr' || call.status !== 'failed' || call.action !== 'not_started'
    || call.receipts != null || call.review_id != null || call.head_sha != null
    || call.error_code !== 'atomic_work_blocked' || call.artifact?.phase !== 'executing' || call.artifact.plan_sha
    || !ci || ci.action !== 'list_failing_ci' || ci.repository !== call.repo || ci.pull_number !== Number(call.pr_id)
    || ci.head_sha !== call.expected_head || ci.head_sha !== invocation.request.context?.head
    || typeof ci.head_sha !== 'string' || !/^[0-9a-f]{40}$/i.test(ci.head_sha)
    || !Array.isArray(ci.failing)) return undefined
  if (ci.queue) {
    const queue = queueCiBlocker({ ...invocation, evidence: receipt(call) })
    return queue ? { invocationId: invocation.id, callId: call.id, head: ci.head_sha, queue } : undefined
  }
  // A job/check identity pins the failed attempt even after the workflow is
  // rerun. Pending checks or a worker's prose alone cannot establish a cause.
  if (!ci.failing.some((check: Record<string, unknown>) => check?.type === 'check_run' && check.state === 'completed'
    && ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'].includes(String(check.conclusion))
    && Number.isSafeInteger(check.check_run_id) && Number(check.check_run_id) > 0
    && Number.isSafeInteger(check.log_id) && Number(check.log_id) > 0
    && typeof check.url === 'string' && check.url.length > 0)) return undefined
  return { invocationId: invocation.id, callId: call.id, head: ci.head_sha }
}

function ciHoldCanResume(chain: BehaviorChain, observation: ChainObservation, now: number, operations: ChainRuntimeOperations): boolean {
  const held = heldCiRepair(chain), pull = observation.pull
  if (!(held && Number.isFinite(observation.checkedAt) && observation.checkedAt >= held.completedAt
    && observation.checkedAt >= Date.parse(String(held.evidence.resources_settled_at))
    && observation.checkedAt <= now && now - observation.checkedAt <= CHAIN_OBSERVATION_MAX_AGE_MS
    && !!pull && pull.state === 'open' && !pull.merged)) return false
  const { hold, original, refresh } = held
  if (refresh && refresh.evidence?.action !== 'not_started') {
    return refresh.state === 'settled' && ['updated', 'update_observed'].includes(refresh.outcome ?? '')
      && resourceReleaseProven(refresh.evidence ?? {}, true) && observation.ciRefreshPassed === pull.head
      && observedCiRefresh(refresh, observation)
  }
  if (pull.head === hold.head && pull.conflict) {
    // Release only for the ordinary scoped repair, including its retry bound.
    // The failed CI receipt remains evidence; admission does not resolve it.
    // Otherwise fall through to the green-CI recovery below.
    const resumed = { ...chain, held: null }
    const decision = decideBehaviorChain(resumed, observation, now)
    if (decision.kind === 'invoke' && decision.behavior === 'repair-pr'
      && !closedChainTarget(chain, observation, decision.behavior) && operations.enabled()) {
      const accounts = operations.accounts()
      if (accounts.author.toLowerCase() === chain.author.toLowerCase()
        && accounts.reviewer.toLowerCase() === chain.reviewer.toLowerCase() && operations.permitted(resumed, decision)) return true
    }
  }
  return (pull.head === hold.head || observation.ciBaseUpdate?.from === hold.head && observation.ciBaseUpdate.head === pull.head
      && observation.publication.pull_number === pull.number && observation.publication.head_sha === pull.head)
    && pull.checksState === 'SUCCESS' && !pull.pending && pull.failing.length === 0
    && (!hold.queue || observation.ciRecovery?.invocationId === original.id && observation.ciRecovery.recovered
      && observation.ciRecovery.removal === hold.queue.removal && observation.ciRecovery.integration === hold.queue.integration
      && pull.queueRemoval?.id === hold.queue.removal && pull.queueRemoval.reason === 'failed_checks'
      && chainBasis(queueCiBlocker(original)) === chainBasis(hold.queue))
}

function observedCiRefresh(refresh: ChainInvocation, observation: ChainObservation): boolean {
  const proof = ciRefreshRequest(refresh)
  const pull = observation.pull, update = observation.ciBaseUpdate, publication = observation.publication
  const completed = refresh.evidence?.completedAt
  return typeof completed === 'number' && observation.checkedAt >= completed
    && observation.checkedAt >= Date.parse(String(refresh.evidence?.resources_settled_at))
    && observation.checkedAt <= Date.now() && Date.now() - observation.checkedAt <= CHAIN_OBSERVATION_MAX_AGE_MS
    && !!pull && pull.number === Number(refresh.request.argv[1]) && pull.state === 'open' && !pull.draft && !pull.merged
    && pull.queueEntry === null && publication.pull_number === pull.number && publication.head_sha === pull.head
    && publication.state === 'open' && !observation.existingPulls.length
    && !!update && update.from === proof.head && update.base === proof.base && update.head === pull.head
    && pull.checksState === 'SUCCESS' && !pull.pending && !pull.failing.length
}

function missingReceiptHoldCanResume(chain: BehaviorChain, observation: ChainObservation, now: number): boolean {
  const held = chain.held, pull = observation.pull
  const slot = held && /^PR review (\S+) lacks its exact-head submission receipt$/.exec(held)?.[1]
  if (!slot || chain.mergeSha || chain.supersession || chain.ciHold || chain.testHold || chain.testRecovery || chain.repairRecovery
    || chain.invocations.some(invocation => invocation.state !== 'settled')
    || !pull || pull.state !== 'open' || pull.merged || !pull.reviewContext
    || !Number.isFinite(observation.checkedAt) || observation.checkedAt > now || now - observation.checkedAt > CHAIN_OBSERVATION_MAX_AGE_MS) return false
  const basis = chainBasis(['pr', pull.head, pull.reviewContext])
  const original = [...chain.invocations].reverse().find(invocation => invocation.behavior === 'review-pr' && invocation.slot === slot
    && invocation.basis === basis && invocation.state === 'settled' && invocation.evidence?.status === 'completed'
    && invocation.evidence.action === 'requested_changes' && invocation.evidence.outcome === 'changes_requested')
  const evidence = original?.evidence
  if (!original || !evidence || !resourceReleaseProven(evidence, true) || typeof evidence.completedAt !== 'number'
    || !Number.isFinite(evidence.completedAt) || observation.checkedAt < evidence.completedAt
    || observation.checkedAt < Date.parse(String(evidence.resources_settled_at))
    || !chainReviewResponse(chain, original, observation, now)) return false
  const decision = decideBehaviorChain({ ...chain, held: null }, observation, now)
  return decision.kind === 'invoke' && decision.behavior === 'repair-pr'
}

function recoveredImplementation(chain: BehaviorChain, observation: ChainObservation, now: number): BehaviorChain['testRecovery'] | null {
  const hold = chain.testHold ?? chain.testRecovery?.hold
  const original = chain.invocations.find(invocation => invocation.id === hold?.invocationId), evidence = original?.evidence
  const prepared = (evidence?.artifact as { prepared?: Record<string, unknown> } | undefined)?.prepared
  const proof = original && implementationTestDependency(original)
  const recovery = observation.testDependency
  const publication = observation.publication
  if (!hold || chain.mergeSha || chain.supersession || chain.testRecovery?.admission
    || chain.invocations.some(invocation => invocation.state !== 'settled')
    || !original || original.id !== hold.invocationId || original.callId !== hold.callId
    || !proof && (!chain.testRecovery?.recheck || recovery?.recheck !== chain.testRecovery.recheck)
    || prepared?.repository !== chain.repository || prepared.issue_number !== chain.issue || prepared.branch !== chain.branch
    || prepared.actor !== chain.author || prepared.pull_number !== null || prepared.head_sha !== null
    || chain.held !== null && (!chain.testHold || chain.held !== evidence?.error)
    || original.actor !== chain.author || original.slot !== observation.implementer.slot
    || original.basis !== chainBasis(['issue', observation.issue.revision])
    || !original.request.argv.includes('--expected-issue-revision')
    || original.request.argv[original.request.argv.indexOf('--expected-issue-revision') + 1] !== observation.issue.revision
    || !observation.issue.open || !observation.issue.eligible || observation.pull !== null || observation.existingPulls.length
    || publication.pull_number !== null || publication.head_sha !== null || publication.head_invocation !== null
    || publication.state !== null || publication.merged !== false || publication.merge_sha !== null
    || !evidence || !resourceReleaseProven(evidence, true) || typeof evidence.completedAt !== 'number'
    || !Number.isFinite(evidence.completedAt) || observation.checkedAt < evidence.completedAt
    || observation.checkedAt < Date.parse(String(evidence.resources_settled_at))
    || !Number.isFinite(observation.checkedAt) || observation.checkedAt > now || now - observation.checkedAt > CHAIN_OBSERVATION_MAX_AGE_MS
    || recovery?.invocationId !== original.id || recovery.verified !== true || recovery.recovered !== true
    || !recovery.recovery || !/^[a-f0-9]{40}$/.test(recovery.recovery.base)
    || observation.prerequisites?.base !== recovery.recovery.base) return null
  if (chain.testRecovery?.triage) {
    return recovery.recheck === chain.testRecovery.recheck && recovery.recovery.triage === chain.testRecovery.triage
      && recovery.recovery.base === chain.testRecovery.base ? chain.testRecovery : null
  }
  if (!recovery.recovery.merge || !/^[a-f0-9]{40}$/.test(recovery.recovery.merge)
    || chain.testRecovery && chain.testRecovery.merge !== recovery.recovery.merge) return null
  return { hold, merge: recovery.recovery.merge, base: recovery.recovery.base }
}

/** This proof comes from Caller's pre-publication guard, never worker prose. */
export function implementationPrerequisiteWait(chain: BehaviorChain, invocation: ChainInvocation, call: LogEntry): Record<string, unknown> | null {
  const artifact = call.artifact as Record<string, unknown> | undefined
  const prepared = artifact?.prepared as Record<string, unknown> | undefined
  const wait = artifact?.prerequisite_wait as Record<string, unknown> | undefined
  const deliveries = wait?.deliveries as unknown[] | undefined
  if (invocation.behavior !== 'implement-issue' || invocation.model === null
    || call.status !== 'completed' || call.action !== 'not_started' || call.outcome !== 'prerequisite_wait'
    || call.head_sha != null || call.receipts != null || call.review_id != null || call.error || call.error_code
    || artifact?.phase !== 'prerequisite_wait' || typeof artifact.plan_sha !== 'string' || !/^[0-9a-f]{64}$/.test(artifact.plan_sha)
    || artifact.publication_head != null || artifact.replies_started != null || artifact.result != null
    || invocation.evidence?.publicationResume != null || invocation.evidence?.publicationReceipt != null) return null
  if (!prepared || String(prepared.repository).toLowerCase() !== chain.repository.toLowerCase()
    || prepared.issue_number !== chain.issue || prepared.branch !== chain.branch
    || String(prepared.actor).toLowerCase() !== chain.author.toLowerCase()
    || prepared.pull_number !== null || prepared.head_sha !== null
    || typeof prepared.checkout_head !== 'string' || !/^[0-9a-f]{40}$/.test(prepared.checkout_head)) return null
  if (!wait || wait.base !== prepared.checkout_head || !Array.isArray(deliveries)
    || typeof wait.reason !== 'string' || !wait.reason
    || !(wait.reason.startsWith('Waiting for prerequisite ') || wait.reason.startsWith('GitHub blocked-by evidence is missing or incomplete for '))) return null
  const prerequisites = wait.prerequisites as Record<string, unknown> | null | undefined
  if (prerequisites !== null && prerequisites !== undefined) {
    if (!prerequisites || typeof prerequisites !== 'object' || Array.isArray(prerequisites)
      || String(prerequisites.repo).toLowerCase() !== chain.repository.toLowerCase()
      || prerequisites.number !== chain.issue || typeof prerequisites.found !== 'boolean'
      || typeof prerequisites.complete !== 'boolean' || !Array.isArray(prerequisites.prerequisites)) return null
  }
  for (const raw of deliveries) {
    const delivery = raw as Record<string, unknown> | null
    if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)
      || delivery.base_sha !== wait.base || typeof delivery.issue_number !== 'number') return null
  }
  return wait
}

class ClosedTargetFenceError extends Error {}

// A transient observation failure must not mask a later access or Poise
// fault in the same sweep: keep the first error that still needs a person,
// falling back to the transient cause when every chain failed transiently.
// Mirrors the sweep reporter in server/behaviors.ts and the downgrade in
// src/behavior-diagnostics.ts.
function isTransientObservationError(message: string): boolean {
  return message.startsWith('behavior observation failed for ')
    && ['upstream_unavailable', 'network_interruption'].includes(classifyBehaviorDiagnostic(message).code)
}

function preferObservationError(current: Error | null, candidate: Error): Error {
  if (!current) return candidate
  if (isTransientObservationError(current.message) && !isTransientObservationError(candidate.message)) return candidate
  return current
}

function capacityWait(reason: string): boolean {
  return reason === 'shared native invocation capacity is occupied' || reason === 'waiting for the shared native behavior capacity'
    || reason.startsWith('shared native resource budget is exhausted: ') || reason.startsWith('insufficient behavior resource headroom: ')
}

const REVIEW_CAPACITY_WAIT = 'waiting for the shared native behavior capacity'

function admissionDecision(chain: BehaviorChain, observation: ChainObservation, now: number): Extract<ChainDecision, { kind: 'invoke' }> | null {
  let decision: ChainDecision
  try {
    decision = decideBehaviorChain(chain, observation, now)
  } catch (error) {
    // Undecodable history (for example a deferred sweep's checkedAt-only
    // record) dates no episode.
    if (error instanceof TypeError) return null
    throw error
  }
  return decision.kind === 'invoke' ? decision : null
}

function admissionDecisionBasis(chain: BehaviorChain, observation: ChainObservation, now: number): string | null {
  const decision = admissionDecision(chain, observation, now)
  return decision ? chainBasis([decision.behavior, decision.basis, decision.actor, decision.reviewer]) : null
}

function admissionNeedsModel(chain: BehaviorChain, observation: ChainObservation, now: number): boolean {
  return admissionDecision(chain, observation, now)?.reviewer != null
}

export class MissingPublicationPlanError extends Error {
  constructor(readonly callId: string, readonly planSha: string) {
    super(`Original Call ${callId} has no durable publication plan`)
  }
}

export class ReviewScopeIndexingError extends Error {
  constructor(repository: string, pull: number) {
    super(`Repair report review awaits indexed PR closing references for ${repository}#${pull}`)
  }
}

/** A consumer of the existing behavior scheduler. It never owns a timer or
 * a model session. The journal owns every admission and recovery decision. */
export class BehaviorChainRuntime {
  private running = false
  private cursor = ''
  private reconciliationCursor = ''
  private reconciliationFirst = false
  private authenticationCursor = ''
  private closedSeedCursor: ChainSeed | null = null

  constructor(readonly journal: BehaviorChainJournal, private readonly operations: ChainRuntimeOperations) {}

  private append(chain: BehaviorChain, event: ChainEvent): BehaviorChain {
    return this.journal.append(chain.id, randomUUID(), chain.sequence, event)
  }

  private current(chain: BehaviorChain): BehaviorChain {
    const current = this.journal.read(chain.id)
    if (!current) throw new Error('behavior chain disappeared while its invocation was running')
    return current
  }

  private recordMerge(chain: BehaviorChain, observation: ChainObservation, reviewComplete: boolean): BehaviorChain {
    const pull = observation.pull
    if (!pull?.merged || !pull.mergeSha) return chain
    return this.append(chain, { type: 'chain.merged', mergeSha: pull.mergeSha, evidence: { repository: chain.repository,
      pull_number: pull.number, merged: true, merge_sha: pull.mergeSha, review_complete: reviewComplete } })
  }

  private decision(chain: BehaviorChain, observation: ChainObservation): ChainDecision {
    const mergeEvidence = observation.pull?.merged ? {
      before: this.journal.preMergeObservation(chain.id, observation.pull.mergedAt ?? Number.NaN) as ChainObservation | null,
      firstMerged: this.journal.firstMergedObservation(chain.id) as ChainObservation | null,
    } : undefined
    return decideBehaviorChain(chain, observation, Date.now(), mergeEvidence)
  }

  private async recheckClosedSeed(began: number): Promise<void> {
    if (!this.operations.closedSeedHints) return
    const hints = await this.operations.closedSeedHints(this.closedSeedCursor)
    if (!hints.length) this.closedSeedCursor = null
    for (const hint of hints) {
      const now = Date.now()
      if (now - began > 45_000) break
      this.closedSeedCursor = hint
      if (!this.operations.ownsRepository(hint.repository) || hint.updatedAt > now) continue
      let chain = this.journal.deferredSeedClosure(chainIdentity(hint.repository, hint.number), hint.updatedAt, now)
      if (!chain) continue
      // Use the usual observation, with no admission, reporting or recovery.
      // An authoritative reopen also consumes the hint.
      const observation = await this.operations.observe(chain)
      try {
        chain = this.append(chain, { type: 'chain.observed', observation })
        if (observation.pull?.merged && observation.pull.mergeSha) {
          chain = this.recordMerge(chain, observation, false)
          if (this.decision(chain, observation).kind === 'complete') this.recordMerge(chain, observation, true)
        }
      }
      catch (error) { if (!(error instanceof BehaviorChainRevisionConflict)) throw error }
      break
    }
  }

  /** The first capacity refusal for this uninterrupted behavior/basis/slot.
   * Observations retain waiting, so the reason alone cannot date the episode. */
  private capacityWaitSequence(chain: BehaviorChain): number | null {
    const observation = chain.observation as ChainObservation | null
    const basis = observation && admissionDecisionBasis(chain, observation, observation.checkedAt)
    if (!basis) return null
    let first: number | null = null, matching = false, after = 0
    let lastObservation: ChainObservation | null = null
    while (true) {
      const events = this.journal.history(chain.id, after)
      for (const row of events) {
        const event = JSON.parse(row.payload) as ChainEvent
        if (event.type === 'chain.observed') {
          lastObservation = event.observation as ChainObservation
          matching = admissionDecisionBasis(chain, lastObservation, row.at) === basis
          if (!matching) first = null
        } else if (event.type === 'invocation.settled' && event.outcome === 'review_continuation_required') {
          matching = !!lastObservation && admissionDecisionBasis(chain, lastObservation, row.at) === basis
          first = matching ? row.sequence : null
        } else if (event.type === 'chain.waiting' && capacityWait(event.reason) && matching) {
          first ??= row.sequence
        } else {
          first = null
          matching = false
        }
      }
      if (events.length < 100) return first
      after = events.at(-1)!.sequence
    }
  }

  private waitForCapacity(chain: BehaviorChain, reason: string): void {
    if (chain.waiting !== reason || this.capacityWaitSequence(chain) === null) {
      this.append(chain, { type: 'chain.waiting', reason })
    }
  }

  /** An organization's runtime cannot prepare another organization's review.
   * Honor its durable turn and let the existing workspace wake offer it. */
  private earlierReviewWaitsElsewhere(chain: BehaviorChain, decision: Extract<ChainDecision, { kind: 'invoke' }>,
    resources: BehaviorResourceAdmission | null, headroom: BehaviorResourceHeadroom | undefined): boolean {
    if (!decision.reviewer) return false
    const turn = (chain.waiting && capacityWait(chain.waiting) ? this.capacityWaitSequence(chain) : null) ?? Infinity
    const now = Date.now()
    const earlierCount = this.journal.capacityWaiters().filter(waiter => {
      const observation = waiter.observation as ChainObservation | null
      if (this.operations.ownsRepository(waiter.repository) || !observation || now - observation.checkedAt > CHAIN_OBSERVATION_MAX_AGE_MS) return false
      const earlier = admissionDecision(waiter, observation, now)
      if (!earlier?.reviewer || !decision.checkpoint && !earlier.checkpoint) return false
      return (this.capacityWaitSequence(waiter) ?? Infinity) < turn
    }).length
    if (!earlierCount) return false
    const free = Math.min(this.operations.availableSlots?.() ?? 1, this.operations.capacity() - this.journal.liveModelInvocationCount())
    if (earlierCount >= free) return true
    if (!resources) return false
    const needed = { memoryBytes: resources.reservation.memoryBytes * (earlierCount + 1),
      diskBytes: resources.reservation.diskBytes * (earlierCount + 1) }
    return !!budgetShortfall(resources.budget, this.journal.reservedResources(), needed)
      || !!headroom && !!headroomShortfall(headroom, needed)
  }

  /** Resume retains waiting in hashed reducer state; a still-blocking reason
   * starts a new wait episode on the first sweep that reaches it after Resume,
   * even when an observation-only sweep (such as a capacity-fairness deferral)
   * intervened. Later sweeps deduplicate against the fresh event. */
  private renewsWait(chain: BehaviorChain, reason: string): boolean {
    if (chain.waiting !== reason) return true
    if (chain.resumedAfterSequence <= 0) return false
    let after = chain.resumedAfterSequence
    while (true) {
      const events = this.journal.history(chain.id, after)
      for (const row of events) {
        const event = JSON.parse(row.payload) as ChainEvent
        if (event.type === 'chain.waiting' && event.reason === reason) return false
      }
      if (events.length < 100) return true
      after = events.at(-1)!.sequence
    }
  }

  /** Durable-budget wait reason for one more reservation, or null when the
   *  budget holds it. Unknown ownership never reads as free. */
  private resourceWaitReason(resources: BehaviorResourceAdmission): string | null {
    const reserved = this.journal.reservedResources()
    if (reserved.unaccounted > 0) return `behavior resource accounting is incomplete: ${reserved.unaccounted} live invocation(s) predate reservations`
    return budgetShortfall(resources.budget, reserved, resources.reservation)
  }

  private allowed(chain: BehaviorChain, invocation: ChainInvocation, source = invocation.request.implementationSource): boolean {
    const current = this.current(chain)
    const accounts = this.operations.accounts()
    return current.invocations.some(candidate => candidate.id === invocation.id && candidate.state !== 'settled')
      && (!source || this.journal.read(source.id)?.sequence === source.sequence)
      && !closedChainTarget(current, current.observation as ChainObservation | null, invocation.behavior)
      && !current.held && this.operations.enabled() && accounts.author.toLowerCase() === current.author.toLowerCase() && accounts.reviewer.toLowerCase() === current.reviewer.toLowerCase()
      && this.operations.permitted(current, { kind: 'invoke', behavior: invocation.behavior, actor: invocation.actor,
        basis: invocation.basis, reviewer: null, reason: 'start the previously admitted native invocation' })
  }

  private nativeInvocation(chain: BehaviorChain, invocation: ChainInvocation): ChainInvocation {
    const argv = invocation.request.argv
    if (!['--pr-review', '--pr-approve'].includes(argv[0])) return invocation
    const relative = /^#?([1-9][0-9]*)$/.exec(argv[1])
    const absolute = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/.exec(argv[1])
    if ((!relative && !absolute) || (absolute && absolute[1].toLowerCase() !== chain.repository.toLowerCase())) throw new Error('native PR invocation target differs from its behavior chain')
    // Older admissions used a relative PR reference, but the interface's
    // directory is deliberately not a git checkout. Resolve that reference
    // against its immutable chain identity, retaining the same correlation.
    return { ...invocation, request: { ...invocation.request, argv: [argv[0],
      `https://github.com/${chain.repository}/pull/${relative?.[1] ?? absolute![2]}`, ...argv.slice(2)] } }
  }

  private exited(chain: BehaviorChain, invocation: ChainInvocation, result?: DetachedProcessExit): void {
    const current = this.current(chain)
    if (result && current.invocations.some((candidate) => candidate.id === invocation.id && candidate.state !== 'settled')) {
      this.append(current, { type: 'invocation.reconciled', invocationId: invocation.id,
        evidence: { nativeExit: { code: result.code, signal: result.signal, error: result.error?.message ?? null } } })
    }
    this.operations.wake()
  }

  private async readInvocations(chains: BehaviorChain[]): Promise<AgentLogSnapshot> {
    const pending = chains.flatMap(chain => chain.invocations.filter(invocation => invocation.state !== 'settled'))
    const correlations = pending.flatMap(invocation => {
      const resume = invocation.evidence?.publicationResume as { correlation?: unknown } | undefined
      return [invocation.id, ...(typeof resume?.correlation === 'string' ? [resume.correlation] : [])]
    })
    try { return pending.length ? await this.operations.readInvocations(correlations) : { entries: [], quarantined: [] } }
    catch (error) {
      try {
        for (const prior of chains) {
          // Exit callbacks can advance the page while the receipt read awaits.
          let chain = this.current(prior)
          for (const invocation of chain.invocations.filter(invocation => invocation.state === 'started')) {
            chain = this.append(chain, { type: 'invocation.uncertain', invocationId: invocation.id,
              reason: 'native receipt store is unreadable; original action and resource evidence must be reconciled' })
          }
        }
      } catch (journalError) {
        // A failed uncertainty write cannot turn an unreadable store into a
        // recoverable revision race or hide either underlying failure.
        throw new AggregateError([error, journalError], `native receipt read failed: ${String(error)}; uncertainty could not be journaled: ${String(journalError)}`, { cause: error })
      }
      throw error
    }
  }

  async run(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      let intakeError: Error | null = null
      try {
        if (this.operations.enabled()) {
          const accounts = this.operations.accounts()
          for (const seed of await this.operations.discover()) {
            const id = chainIdentity(seed.repository, seed.number)
            if (this.journal.read(id)) continue
            this.journal.append(id, `admit:${id}`, 0, { type: 'chain.admitted', repository: seed.repository, issue: seed.number,
              branch: `poise/issue-${seed.number}-${chainBasis(id).slice(0, 12)}`, ...accounts })
          }
        }
      } catch (error) {
        intakeError = error instanceof Error ? error : new Error(String(error))
        if (!staleDatastoreFailure(intakeError)) console.error('[behavior-chain] intake failed; admitted chains continue', intakeError)
      }
      const began = Date.now()
      // Auth-only automatic holds need no new GitHub read to retire their
      // retry boundary. Do this before the ordinary held-chain cadence.
      let authHolds = this.journal.authenticationHolds(this.authenticationCursor)
      if (!authHolds.length && this.authenticationCursor) {
        this.authenticationCursor = ''
        authHolds = this.journal.authenticationHolds('')
      }
      for (const held of authHolds) {
        this.authenticationCursor = held.id
        if (this.operations.ownsRepository(held.repository)) this.recoverAuthentication(held)
      }
      let observationError: Error | null = null
      const conflicted = new Set<string>()
      const waiters = this.journal.capacityWaiters().flatMap(chain => {
        const sequence = this.capacityWaitSequence(chain)
        if (sequence === null) return []
        const observation = chain.observation as ChainObservation | null
        const model = !!observation && admissionNeedsModel(chain, observation, observation.checkedAt)
        return [{ chain, sequence, model }]
      }).sort((a, b) => a.sequence - b.sequence)
      const offered = new Set<string>()
      const visited = new Set<string>()
      const first = this.reconciliationFirst
      this.reconciliationFirst = !first
      for (const deferred of [first, !first]) {
        if (Date.now() - began > 45_000) break
        if (deferred && this.operations.closedSeedHints) {
          try { await this.recheckClosedSeed(began) }
          catch (error) {
            if (!staleDatastoreFailure(error)) observationError = preferObservationError(observationError,
              new Error(`closed seed recheck failed: ${behaviorErrorMessage(error)}`, { cause: error }))
          }
          if (Date.now() - began > 45_000) break
        }
        const cursorKey = deferred ? 'reconciliationCursor' : 'cursor'
        let page = this.journal.reconcilable(this[cursorKey], Date.now(), deferred)
        if (!page.length && this[cursorKey]) {
          this[cursorKey] = ''
          page = this.journal.reconcilable('', Date.now(), deferred)
        }
        if (!page.length) { this[cursorKey] = ''; continue }
        const snapshot = await this.readInvocations(page.filter(chain => !conflicted.has(chain.id) && !visited.has(chain.id)))
        const work: Array<{ chain: BehaviorChain, priority: number | null, cursor: boolean, model?: boolean }> = page.map(chain => ({ chain, priority: null, cursor: true }))
        for (let index = 0; index < work.length; index++) {
          let { chain } = work[index]
          if (Date.now() - began > 45_000) break
          if (work[index].cursor) this[cursorKey] = chain.id
          if (conflicted.has(chain.id)) continue
          // A due recovery can enter the later active page before Caller has
          // registered its launch. Explicit capacity retries remain eligible.
          if (work[index].cursor) {
            if (visited.has(chain.id)) continue
            visited.add(chain.id)
          }
          if (work[index].priority === null && offered.has(chain.id)) continue
          if (work[index].priority !== null) {
            // Capacity can fill after older waiters are queued. Queued model
            // waiters yield without observation once it does, so runnable
            // direct work behind them is still reached.
            if (work[index].model && !(this.operations.available() && this.journal.modelCapacityAvailable(this.operations.capacity()))) {
              offered.add(chain.id)
              continue
            }
            chain = this.current(chain)
            offered.add(chain.id)
          }
          let chainSnapshot = work[index].priority !== null ? await this.readInvocations([chain]) : snapshot
          let phase = 'reconciliation'
          let conflictPhase: string | null = null
          let conflictDeferred = false
          let retry = false
          let attempts = 0
          // Existing early exits finish the chain unless the sequence guard
          // explicitly requests its one fresh attempt.
          do {
            retry = false
            attempts++
            try {
              if (conflictPhase) {
                phase = 'receipt-read'
                chain = this.current(chain)
                chainSnapshot = await this.readInvocations([chain])
                if (Date.now() - began > 45_000) { conflictDeferred = true; continue }
              }
              phase = 'reconciliation'
              if (!this.operations.ownsRepository(chain.repository)) continue
              const contradicted = chain.invocations.find(invocation => invocation.evidence
                && resourceReleaseContradicted(invocation.evidence))
              if (contradicted) {
                const cause = `Invocation ${contradicted.id} has contradictory resource-release evidence; ownership remains held`
                if (!chain.held) this.append(chain, { type: 'chain.held', reason: cause })
                else if (chain.held !== cause && chain.waiting !== cause) this.append(chain, { type: 'chain.waiting', reason: cause })
                continue
              }
              chain = await this.reconcile(chain, chainSnapshot)
              chain = this.recoverAuthentication(chain)
              const direct = chain.invocations.find((invocation) => invocation.state !== 'settled' && attributedNativeAction(invocation))
              if (chain.mergeSha && direct && this.recoverNativeAction(chain, direct)) continue
              const owned = chain.invocations.find((invocation) => invocation.state !== 'settled'
                && (invocation.model !== null || invocation.request.nativeResources === 2 || invocation.evidence?.nativeCallId))
              const call = owned ? chainSnapshot.entries.find((entry) => entry.correlation_id === owned.id) : null
              const released = owned ? resourceReleaseProven(owned.evidence ?? {}, true) : false
              if (owned?.evidence?.publicationResume && typeof (owned.evidence.publicationResume as { correlation?: unknown }).correlation === 'string'
                && !resourceReleaseProven(owned.evidence.publicationReceipt as Record<string, unknown> ?? {}, true)) continue
              if (owned && !call && closedChainTarget(chain, chain.observation as ChainObservation | null, owned.behavior)
                && !released) {
                try { await this.closeRecovery(chain, owned, chain.observation as ChainObservation | null, chainSnapshot) }
                catch (error) { if (!(error instanceof ClosedTargetFenceError)) throw error; observationError = preferObservationError(observationError, error) }
                continue
              }
              if (chain.mergeSha && owned && !released) continue
              if (owned && call && (call.status === 'running' || !nativeResourcesReleased(call))) {
                // Running PR reviews and repairs need bounded head/queue visibility,
                // and a first implementation needs bounded seed-closure
                // visibility. Neither observation can settle or replace its
                // native invocation.
                const prior = chain.observation as ChainObservation | null
                const fresh = Number.isFinite(prior?.checkedAt) && (prior as ChainObservation).checkedAt <= Date.now()
                  && Date.now() - (prior as ChainObservation).checkedAt < CHAIN_OBSERVATION_MAX_AGE_MS
                if (owned.behavior === 'review-pr') {
                  if (call.status !== 'running' || prior?.pull?.state !== 'open' || prior.pull.merged || fresh) continue
                } else if (owned.behavior === 'repair-pr') {
                  if (call.status !== 'running' || fresh) continue
                } else if (owned.behavior === 'implement-issue') {
                  if (!retireEligible(call) || prior?.publication.pull_number !== null || fresh
                    || !this.operations.retireClosedImplementation) continue
                } else continue
              }
              phase = 'observation'
              let observation: ChainObservation
              try { observation = await this.operations.observe(chain) }
              catch (error) {
                if (error instanceof MissingPublicationPlanError) {
                  const invocation = chain.invocations.find(invocation => invocation.state !== 'settled'
                    && invocation.evidence?.callId === error.callId
                    && (invocation.evidence.artifact as { plan_sha?: unknown } | undefined)?.plan_sha === error.planSha)
                  if (invocation) {
                    const prior = invocation.evidence?.publicationPlan
                    if (!prior || prior.recoveredAt !== null || prior.callId !== error.callId || prior.planSha !== error.planSha) {
                      this.append(chain, { type: 'invocation.reconciled', invocationId: invocation.id, evidence: {
                        publicationPlan: { code: 'original_publication_plan_missing', callId: error.callId,
                          planSha: error.planSha, missingAt: Date.now(), recoveredAt: null } } })
                    }
                    continue
                  }
                }
                observationError = preferObservationError(observationError, new Error(`behavior observation failed for ${chain.id}: ${behaviorErrorMessage(error)}`, { cause: error }))
                continue
              }
              for (const invocation of chain.invocations) {
                const condition = invocation.evidence?.publicationPlan
                const plan = invocation.behavior === 'review-issue' ? observation.reviewPublication : observation.workPublication
                if (invocation.state !== 'settled' && condition?.recoveredAt === null
                  && plan?.callId === condition.callId && plan.planSha === condition.planSha) {
                  chain = this.append(chain, { type: 'invocation.reconciled', invocationId: invocation.id,
                    evidence: { publicationPlan: { ...condition, recoveredAt: Date.now() } } })
                }
              }
              chain = this.append(chain, { type: 'chain.observed', observation })
              if (!chain.mergeSha) chain = this.recordMerge(chain, observation, false)
              if (owned?.behavior === 'implement-issue' && call?.status === 'running' && retireEligible(call)
                && !observation.issue.open && observation.publication.pull_number === null
                && observation.publication.head_sha === null && observation.publication.head_invocation === null
                && this.operations.retireClosedImplementation) {
                try {
                  const current = this.current(chain)
                  const original = current.invocations.find(candidate => candidate.id === owned.id)
                  if (original) await this.operations.retireClosedImplementation(current, original, call)
                } catch (error) {
                  observationError = preferObservationError(observationError,
                    new Error(`behavior retirement failed for ${chain.id}: ${behaviorErrorMessage(error)}`, { cause: error }))
                }
              }
              if (owned && call?.status === 'running') {
                if (owned.behavior === 'repair-pr' && observation.pull?.head !== call.expected_head
                  && observation.pull?.number === Number(call.pr_id) && /^[0-9a-f]{40}$/.test(observation.pull.head)
                  && observation.publication.head_sha === observation.pull.head
                  && observation.publication.pull_number === observation.pull.number
                  && observation.checkedAt <= Date.now() && Date.now() - observation.checkedAt <= CHAIN_OBSERVATION_MAX_AGE_MS) {
                  const reason = `original repair Call ${call.id} is still running for ${call.expected_head}`
                  if (chain.waiting !== reason) this.append(chain, { type: 'chain.waiting', reason })
                }
                continue
              }
              if (this.operations.recoverReport) {
                const reason = await this.operations.recoverReport(chain, observation)
                chain = this.current(chain)
                observation = chain.observation as ChainObservation
                if (reason) {
                  if (chain.repairRecovery && !chain.repairRecovery.admission && !chain.held) chain = this.append(chain, { type: 'chain.held', reason })
                  if (chain.waiting !== reason) this.append(chain, { type: 'chain.waiting', reason })
                  continue
                }
              }
              const pendingInvocation = chain.invocations.find((invocation) => invocation.state !== 'settled')
              if (pendingInvocation) {
                phase = 'invocation-recovery'
                try { await this.recover(chain, pendingInvocation, observation, chainSnapshot) }
                catch (error) { if (!(error instanceof ClosedTargetFenceError)) throw error; observationError = preferObservationError(observationError, error) }
                const recovered = this.current(chain)
                if (recovered.invocations.some(invocation => invocation.id === pendingInvocation.id && invocation.state === 'uncertain'
                  && ['implement-issue', 'merge-pr'].includes(invocation.behavior)) && this.operations.reportHold) await this.reportHold(recovered)
                continue
              }
              phase = 'decision'
              if (ciHoldCanResume(chain, observation, Date.now(), this.operations)) {
                chain = this.append(chain, { type: 'chain.resumed', ciRecovery: chain.ciHold })
              }
              const testRecovery = recoveredImplementation(chain, observation, Date.now())
              if (chain.testHold && !chain.testRecovery && testRecovery) {
                chain = this.append(chain, { type: 'chain.resumed', testRecovery })
              }
              if (chain.testRecovery && !chain.testRecovery.admission && !testRecovery) {
                const reason = `Original implementation test recovery awaits current source/publication evidence: ${observation.testDependency?.reason || 'recovery is not verified'}`
                if (chain.waiting !== reason) this.append(chain, { type: 'chain.waiting', reason })
                continue
              }
              if (chain.held && missingReceiptHoldCanResume(chain, observation, Date.now())) {
                chain = this.append(chain, { type: 'chain.resumed' })
              }
              const approvalRecovery = exhaustedApprovalConversationHold(chain, observation, Date.now())
              if (approvalRecovery) chain = this.append(chain, { type: 'chain.resumed', approvalRecovery, recovery: { origin: 'automatic' } })
              const decision = this.decision(chain, observation)
              if (decision.kind === 'invoke' && decision.behavior === 'implement-issue' && this.operations.implementationAdmission) {
                const gate = await this.operations.implementationAdmission(chain, observation)
                if (gate.reason) {
                  if (chain.waiting !== gate.reason) this.append(chain, { type: 'chain.waiting', reason: gate.reason })
                  continue
                }
              }
              if (chain.held && decision.kind === 'wait' && this.operations.reportHold && await this.reportHold(chain)) continue
              if ((decision.kind === 'supersede' || decision.kind === 'invoke' && decision.behavior === 'retire-pr') && automaticClosureHold(chain.held)) {
                chain = this.append(chain, { type: 'chain.resumed' })
              }
              if (decision.kind === 'complete') {
                this.recordMerge(chain, observation, true)
              } else if (decision.kind === 'supersede') {
                this.append(chain, { type: 'chain.superseded', evidence: decision.evidence })
              } else if (decision.kind === 'hold') {
                if (!chain.held || automaticClosureHold(chain.held)) chain = this.append(chain, { type: 'chain.held', reason: decision.reason })
                if (this.operations.reportHold) await this.reportHold(chain)
              } else if (decision.kind === 'invoke' && this.operations.enabled() && this.operations.permitted(chain, decision)) {
                const closed = closedChainTarget(chain, observation, decision.behavior)
                if (closed) {
                  if (!chain.held) this.append(chain, { type: 'chain.held', reason: `No new ${decision.behavior}: ${closed}` })
                  continue
                }
                if (work[index].priority !== null && this.capacityWaitSequence(chain) !== work[index].priority) continue
                // Model work and direct actions share resource reservations.
                // Offer older waiters before either prepares new work. Older
                // model waiters yield without observation while model capacity
                // is unavailable, so runnable direct work is still reached.
                const modelAvailable = this.operations.available() && this.journal.modelCapacityAvailable(this.operations.capacity())
                const older = waiters.filter(waiter => !offered.has(waiter.chain.id)
                  && waiter.sequence < (work[index].priority ?? Infinity)
                  && (modelAvailable || !waiter.model))
                if (older.length) {
                  work.splice(index + 1, 0, ...older.map(waiter => ({ chain: waiter.chain, priority: waiter.sequence, cursor: false, model: waiter.model })),
                    { chain, priority: work[index].priority, cursor: false, model: work[index].model })
                  continue
                }
                if (decision.reviewer && !this.operations.available()) {
                  this.waitForCapacity(chain, 'waiting for the shared native behavior capacity')
                  continue
                }
                if (decision.reviewer && !this.journal.modelCapacityAvailable(this.operations.capacity())) {
                  const reason = 'shared native invocation capacity is occupied'
                  this.waitForCapacity(chain, reason)
                  continue
                }
                // Resource-aware admission precedes provider preparation like the
                // count check, so blocked work holds no native agent session and
                // consumes no provider probe. Unset budgets skip every probe.
                const resources = readBehaviorResourceAdmission()
                let headroom: BehaviorResourceHeadroom | undefined
                if (resources) {
                  const exhausted = this.resourceWaitReason(resources)
                  if (exhausted) {
                    if (capacityWait(exhausted)) this.waitForCapacity(chain, exhausted)
                    else if (this.renewsWait(chain, exhausted)) this.append(chain, { type: 'chain.waiting', reason: exhausted })
                    continue
                  }
                  try {
                    headroom = (this.operations.measureHeadroom ?? measureBehaviorHeadroom)()
                    const cramped = headroomShortfall(headroom, resources.reservation)
                    if (cramped) {
                      this.waitForCapacity(chain, cramped)
                      continue
                    }
                  } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error)
                    if (this.renewsWait(chain, reason)) this.append(chain, { type: 'chain.waiting', reason })
                    continue
                  }
                }
                if (this.earlierReviewWaitsElsewhere(chain, decision, resources, headroom)) {
                  this.waitForCapacity(chain, REVIEW_CAPACITY_WAIT)
                  continue
                }
                const accounts = this.operations.accounts()
                if (accounts.author.toLowerCase() !== chain.author.toLowerCase() || accounts.reviewer.toLowerCase() !== chain.reviewer.toLowerCase()) {
                  this.append(chain, { type: 'chain.held', reason: 'configured accounts changed; existing chain ownership needs a decision' })
                  continue
                }
                const id = randomUUID()
                phase = 'request-preparation'
                let request: ChainInvocation['request'] | null
                try { request = await this.operations.request(chain, observation, decision, id) }
                catch (error) {
                  if (!(error instanceof ReviewScopeIndexingError)) throw error
                  // The first wait for this PR survives rechecks, reason changes
                  // and restarts, independently of successful organization syncs.
                  let after = 0, firstWait: number | undefined
                  while (firstWait === undefined) {
                    const events = this.journal.history(chain.id, after)
                    firstWait = events.find(row => {
                      const event = JSON.parse(row.payload) as ChainEvent
                      return event.type === 'chain.waiting' && event.reason === error.message
                    })?.at
                    if (events.length < 100) break
                    after = events.at(-1)!.sequence
                  }
                  if (firstWait !== undefined && Date.now() - firstWait > DATASTORE_MAX_AGE_SECONDS * 1000) {
                    throw new Error(`${error.message}; indexing delay exceeds ${DATASTORE_MAX_AGE_SECONDS} seconds`)
                  }
                  if (this.renewsWait(chain, error.message)) this.append(chain, { type: 'chain.waiting', reason: error.message })
                  continue
                }
                if (!request) {
                  const reason = decision.checkpoint
                    ? `Review Call ${decision.checkpoint.root_call} needs its original reviewer ${decision.reviewer?.model} and a Caller with review continuation support`
                    : `${decision.behavior} is waiting for native provider backoff`
                  if (this.renewsWait(chain, reason)) {
                    this.append(chain, { type: 'chain.waiting', reason })
                  }
                  continue
                }
                if (resources) {
                  const resourceLimits = executionLimits(resources)
                  const argv = [...request.argv]
                  if (request.command === 'agent-interface' && decision.reviewer) {
                    const guidance = `Enforced resource ceilings for this entire behavior invocation: ${JSON.stringify(resourceLimits)}. `
                      + 'These cover the provider and all child processes, including tests and builds. '
                      + 'Use explicit bounded test/build parallelism; start with one worker when the runner otherwise follows host CPU count. '
                      + 'Preserve all required checks and assertions. Do not increase limits, disable enforcement or change repository test configuration to fit; report a concrete blocker if the work cannot fit.'
                    const note = argv.indexOf('--note')
                    if (note < 0) argv.push('--note', guidance)
                    else argv[note + 1] = `${argv[note + 1]}\n\n${guidance}`
                  }
                  request = { ...request, resourceLimits, ...(request.command === 'agent-interface'
                    ? { argv: [...argv, '--resource-limits-json', JSON.stringify(resourceLimits)] } : {}) }
                }
                // Preparation can await provider/auth/configuration. Recheck admission
                // at the last boundary, before committing authority for an effect.
                if (!this.operations.enabled() || !this.operations.permitted(chain, decision)) continue
                if (this.operations.recoverReport && (chain.repairRecovery && !chain.repairRecovery.admission
                  || decision.behavior === 'implement-issue' || decision.behavior === 'publish-issue')) {
                  const reason = await this.operations.recoverReport(this.current(chain), observation)
                  chain = this.current(chain)
                  if (reason) {
                    if (chain.repairRecovery && !chain.repairRecovery.admission && !chain.held) chain = this.append(chain, { type: 'chain.held', reason })
                    if (chain.waiting !== reason) this.append(chain, { type: 'chain.waiting', reason })
                    continue
                  }
                  observation = chain.observation as ChainObservation
                  const fresh = decideBehaviorChain(chain, observation, Date.now())
                  if (fresh.kind !== 'invoke' || fresh.behavior !== decision.behavior || fresh.basis !== decision.basis
                    || fresh.actor !== decision.actor || fresh.reviewer?.slot !== decision.reviewer?.slot) continue
                  if (!this.operations.enabled() || !this.operations.permitted(chain, decision)) continue
                }
                if (decision.behavior === 'implement-issue') {
                  const fresh = await this.operations.observe(chain)
                  chain = this.append(chain, { type: 'chain.observed', observation: fresh })
                  if (chain.testRecovery?.recheck && !chain.testRecovery.admission) {
                    const reason = await this.operations.recoverReport?.(chain, fresh)
                    chain = this.current(chain)
                    if (reason) {
                      if (chain.waiting !== reason) this.append(chain, { type: 'chain.waiting', reason })
                      continue
                    }
                  }
                  const verified = chain.observation as ChainObservation
                  observation = verified
                  if (chain.testRecovery && !chain.testRecovery.admission && !recoveredImplementation(chain, verified, Date.now())) continue
                  // Dependencies can change without an issue revision, including
                  // while request preparation awaited. Retain their ordinary wait.
                  const redecided = decideBehaviorChain(chain, verified, Date.now())
                  if (redecided.kind !== 'invoke' || redecided.behavior !== decision.behavior || redecided.basis !== decision.basis) {
                    if (redecided.kind === 'wait' && chain.waiting !== redecided.reason) this.append(chain, { type: 'chain.waiting', reason: redecided.reason })
                    // A report revision changed during preparation also invalidates its disposition; surface that explicitly.
                    const gate = await this.operations.implementationAdmission?.(chain, fresh)
                    if (gate?.reason && chain.waiting !== gate.reason) this.append(chain, { type: 'chain.waiting', reason: gate.reason })
                    continue
                  }
                  if (!this.operations.enabled() || !this.operations.permitted(chain, decision)) continue
                }
                phase = 'invocation-admission'
                const gate = decision.behavior === 'implement-issue'
                  ? await this.operations.implementationAdmission?.(chain, observation) : undefined
                if (gate?.reason) {
                  if (chain.waiting !== gate.reason) this.append(chain, { type: 'chain.waiting', reason: gate.reason })
                  continue
                }
                if (gate?.source) request = { ...request, implementationSource: gate.source }
                if (gate?.note) {
                  const argv = [...request.argv]
                  const note = argv.indexOf('--note')
                  if (note < 0) argv.push('--note', gate.note)
                  else argv[note + 1] = [argv[note + 1], gate.note].filter(Boolean).join('\n\n')
                  request = { ...request, argv }
                }
                if (!this.operations.enabled() || !this.operations.permitted(chain, decision)) continue
                if (this.earlierReviewWaitsElsewhere(chain, decision, resources, headroom)) {
                  this.waitForCapacity(chain, REVIEW_CAPACITY_WAIT)
                  continue
                }
                const admitted = this.journal.admitInvocation(chain, randomUUID(), { id, behavior: decision.behavior, basis: decision.basis,
                  actor: decision.actor, model: request.command === 'agent-interface' ? request.argv[request.argv.indexOf('--model') + 1] : null, slot: decision.reviewer?.slot ?? null,
                  ...(resources ? { reservation: resources.reservation } : {}),
                  admittedAt: Date.now(), request }, this.operations.capacity(), resources?.budget ?? null)
                if (!admitted) {
                  const reason = decision.reviewer && !this.journal.modelCapacityAvailable(this.operations.capacity()) ? 'shared native invocation capacity is occupied'
                    : resources ? this.resourceWaitReason(resources) ?? 'shared native invocation capacity is occupied'
                    : 'shared native invocation capacity is occupied'
                  if (capacityWait(reason)) this.waitForCapacity(chain, reason)
                  else this.append(chain, { type: 'chain.waiting', reason })
                  continue
                }
                chain = admitted
                phase = 'invocation-start'
                await this.start(chain, chain.invocations.at(-1)!)
              } else {
                const reason = decision.kind === 'wait' ? decision.reason : !this.operations.enabled() ? 'behavior chain admissions are paused'
                  : `${decision.behavior} is disabled or held by its behavior controls`
                if (this.renewsWait(chain, reason)) this.append(chain, { type: 'chain.waiting', reason })
              }
            } catch (error) {
              if (!(error instanceof BehaviorChainRevisionConflict)) throw error
              retry = conflictPhase === null && Date.now() - began <= 45_000
              conflictPhase = phase
              conflictDeferred = !retry
              conflicted.add(chain.id)
            }
          } while (retry)
          if (conflictPhase) diagnostic({ level: 'warning', operation: 'behavior-chain.revision-conflict', target: chain.id,
            repository: chain.repository, phase: conflictPhase, message: conflictDeferred
              ? 'Behavior chain revision conflict deferred to a later sweep' : 'Behavior chain revision conflict recovered with a fresh attempt',
            context: { outcome: conflictDeferred ? 'deferred' : 'recovered', attempts } })
        }
      }
      if (observationError) {
        if (intakeError) throw new AggregateError([intakeError, observationError], `${intakeError.message}; ${observationError.message}`)
        throw observationError
      }
      if (intakeError) throw intakeError
    } finally {
      this.running = false
    }
  }

  private async reportHold(chain: BehaviorChain): Promise<boolean> {
    let reason: string | null
    try { reason = await this.operations.reportHold!(chain) }
    catch (error) { reason = `Work-failure reporting pending: ${error instanceof Error ? error.message : String(error)}` }
    const current = this.current(chain)
    if (reason && (current.held || current.invocations.some(invocation => ['implement-issue', 'merge-pr'].includes(invocation.behavior) && invocation.state === 'uncertain'))
      && current.resumedAfterSequence === chain.resumedAfterSequence && current.waiting !== reason) {
      this.append(current, { type: 'chain.waiting', reason })
    }
    return reason !== null
  }

  private async reconcile(chain: BehaviorChain, snapshot: AgentLogSnapshot): Promise<BehaviorChain> {
    const invocation = chain.invocations.find((candidate) => candidate.state !== 'settled')
    if (!invocation) return chain
    let publicationPending = false
    const resume = invocation.evidence?.publicationResume as { correlation?: unknown, callId?: unknown, head?: unknown, plan?: unknown } | undefined
    if (typeof resume?.correlation === 'string') {
      const matches = snapshot.entries.filter(call => call.correlation_id === resume.correlation)
      if (matches.length > 1 || snapshot.quarantined.some(row => !row.correlationId || row.correlationId === resume.correlation)) {
        throw new Error('native publication completion evidence is ambiguous or quarantined')
      }
      const continuation = matches[0]
      if (!continuation) publicationPending = true
      else {
        if (invocation.request.resourceLimits
          && chainBasis(continuation.resource_guard?.limits ?? null) !== chainBasis(invocation.request.resourceLimits)) {
          throw new Error('native publication resource ceilings differ from their original admission')
        }
        if (continuation.source !== 'poise:behavior-chain' || continuation.behavior !== 'native_publication'
        || continuation.repo !== chain.repository || continuation.actor !== invocation.actor || continuation.expected_head !== resume.head
        || continuation.artifact?.request_sha && continuation.artifact.request_sha !== nativeRequestSha({ kind: 'native_publication',
          call_id: resume.callId, digest: resume.plan, head: resume.head,
          ...(invocation.request.resourceLimits ? { resourceLimits: invocation.request.resourceLimits } : {}) })) throw new Error('native publication differs from its original completion request')
        const publicationReceipt = { ...receipt(continuation), callId: continuation.id }
        if (chainBasis(invocation.evidence?.publicationReceipt ?? null) !== chainBasis(publicationReceipt)) {
          chain = this.append(chain, { type: 'invocation.reconciled', invocationId: invocation.id, evidence: { publicationReceipt } })
        }
        if (['stopped', 'stopping'].includes(continuation.error_code || '') && !chain.held) {
          chain = this.append(chain, { type: 'chain.held', reason: 'native publication completion was stopped by the person' })
        }
        if (continuation.resource_guard?.failure && !chain.held) chain = this.append(chain, { type: 'chain.held', reason: continuation.error })
        publicationPending = !nativeResourcesReleased(continuation)
      }
    }
    if (snapshot.quarantined.some((row) => row.correlationId === invocation.id || !row.correlationId)) {
      return invocation.state === 'uncertain' ? chain : this.append(chain, { type: 'invocation.uncertain', invocationId: invocation.id,
        reason: 'native call evidence is quarantined; absence cannot authorize another effect' })
    }
    const calls = snapshot.entries.filter((call) => call.correlation_id === invocation.id)
    if (!calls.length) {
      // A partial restore can lose the UNIQUE correlation row. Absence after
      // launch cannot authorize either a retry or a synthetic no-effect fence.
      return invocation.state !== 'started' ? chain : this.append(chain, { type: 'invocation.uncertain', invocationId: invocation.id,
        reason: 'native invocation is without a durable Call receipt; original action and resource evidence must be reconciled' })
    }
    if (calls.length !== 1) return invocation.state === 'uncertain' ? chain : this.append(chain, { type: 'invocation.uncertain', invocationId: invocation.id,
      reason: 'multiple native calls claim one admitted invocation' })
    const call = calls[0]
    const admissionFenced = call.outcome === 'target_closed' && call.artifact?.phase === 'admission_fenced'
    if (invocation.request.resourceLimits && !admissionFenced && !beforeNativeScope(call)
      && chainBasis(call.resource_guard?.limits ?? null) !== chainBasis(invocation.request.resourceLimits)) {
      throw new Error('native resource ceilings differ from their immutable admission')
    }
    if (call.source !== 'poise:behavior-chain' || call.actor !== invocation.actor || call.repo !== chain.repository
      || call.behavior !== nativeBehavior(invocation.behavior)) throw new Error(`native receipt conflicts with behavior admission ${invocation.id}`)
    if (invocation.model === null && (call.model !== 'native-action'
      || invocation.evidence?.nativeCallId && invocation.evidence.nativeCallId !== call.id
      || call.pr_id !== invocation.request.argv[1]?.replace(/^#/, '')
      || call.expected_head !== invocation.request.argv[invocation.request.argv.indexOf('--expected-head') + 1])) {
      throw new Error(`native action target conflicts with behavior admission ${invocation.id}`)
    }
    const prReview = invocation.behavior === 'review-pr' || invocation.behavior === 'approve-pr'
    if (prReview && call.status === 'failed' && call.action === 'not_started'
      && (invocation.request.argv[1] !== `https://github.com/${chain.repository}/pull/${call.pr_id}`
        || !invocation.request.argv.includes('--expected-head')
        || call.expected_head !== invocation.request.argv[invocation.request.argv.indexOf('--expected-head') + 1])) {
      throw new Error(`native review target conflicts with behavior admission ${invocation.id}`)
    }
    if (call.status === 'running') return chain
    // Authentication is actionable even while native cleanup still owns the
    // reservation. Reconciliation below continues to require release proof.
    if (invocation.evidence?.callId !== call.id) this.operations.authenticationRejected?.(call)
    const stopped = ['stopped', 'stopping'].includes(call.error_code || '')
    const resourceStopped = ['resource_memory_exceeded', 'resource_disk_exceeded', 'resource_measurement_unavailable', 'resource_receipt_unavailable'].includes(call.error_code || '')
    const workBlocked = call.error_code === 'atomic_work_blocked'
    const ciHold = workBlocked ? ciOnlyHold(invocation, call) : undefined
    const testHold = !chain.testRecovery && workBlocked && implementationTestDependency({ ...invocation, callId: call.id, evidence: receipt(call) })
      ? { invocationId: invocation.id, callId: call.id } : undefined
    if ((resourceStopped || workBlocked) && !chain.held) chain = this.append(chain, { type: 'chain.held',
      reason: ciHold?.queue ? `${call.error}; merge-group ${ciHold.queue.integration}: ${ciHold.queue.failures.map(failure => `${failure.name} (${failure.url})`).join(', ')}; awaiting later matching integration success or verified shared-baseline recovery` : call.error,
      ...(ciHold ? { ciHold } : {}), ...(testHold ? { testHold } : {}) })
    if (stopped && !chain.held) chain = this.append(chain, { type: 'chain.held', reason: `behavior invocation ${invocation.id} was stopped by the person` })
    if (!nativeResourcesReleased(call)) {
      const evidence = { ...receipt(call), callId: call.id, ...(invocation.model === null ? { nativeCallId: call.id } : {}) }
      if (!sameReceipt(invocation.evidence, evidence)) {
        chain = this.append(chain, { type: 'invocation.reconciled', invocationId: invocation.id, evidence })
      }
      const failure = call.resource_ownership?.errors.at(-1)
      const root = call.resource_ownership?.roots.find(root => !['reclaimed', 'covered'].includes(root.state))
      const cause = failure ? `; ${failure.cause}${failure.path ? ` at ${failure.path}` : ''}`
        : !call.resource_ownership ? '; durable resource ownership is unavailable'
          : root ? `; ${root.state} directory at ${root.path} lacks a reclamation receipt` : ''
      const replacement = invocation.behavior === 'repair-pr' && call.status === 'superseded' && call.head_sha !== call.expected_head
        ? `PR head ${call.head_sha} is waiting on original repair Call ${call.id} for ${call.expected_head}; ` : ''
      const reason = `${replacement}native invocation ended without proof that its worker resources were released${cause}`
      return invocation.state === 'uncertain' && invocation.outcome === reason ? chain
        : this.append(chain, { type: 'invocation.uncertain', invocationId: invocation.id, reason })
    }
    if (publicationPending) {
      const evidence = { ...receipt(call), callId: call.id }
      return sameReceipt(invocation.evidence, evidence) ? chain
        : this.append(chain, { type: 'invocation.reconciled', invocationId: invocation.id, evidence })
    }
    if (resourceStopped && call.resource_guard?.failure?.noWrite === true) {
      this.operations.received(invocation, call)
      return this.append(chain, { type: 'invocation.settled', invocationId: invocation.id, callId: call.id,
        outcome: call.error_code!, evidence: receipt(call) })
    }
    if (invocation.model === null) {
      this.operations.received(invocation, call)
      const physical: Record<string, unknown> = { ...receipt(call), nativeCallId: call.id }
      if (call.artifact?.request_sha && call.artifact.request_sha !== nativeRequestSha(invocation.request)) {
        throw new Error('native action Call conflicts with its immutable journal request')
      }
      const responded = call.artifact?.phase === 'received_native_action' && typeof call.artifact.response_sha === 'string' && !!call.response
      const rejected = rejectedMergedEnqueue(chain, invocation, call)
      if (call.status === 'failed' && (call.action === 'not_started' || rejected) && !responded) {
        this.append(chain, { type: 'invocation.settled', invocationId: invocation.id, callId: call.id,
          outcome: call.outcome || 'preflight_failed', evidence: { ...physical,
            ...(rejected ? { action: 'not_started', outcome: 'preflight_failed' } : {}) } })
        this.operations.wake()
        return this.current(chain)
      }
      if (call.status !== 'completed' && !responded) {
        if (!sameReceipt(invocation.evidence, physical)) chain = this.append(chain, { type: 'invocation.reconciled', invocationId: invocation.id, evidence: physical })
        return invocation.state === 'uncertain' ? chain : this.append(chain, { type: 'invocation.uncertain', invocationId: invocation.id,
          reason: 'native action ended without its accepted response; the original effect remains uncertain' })
      }
      const savedSha = invocation.evidence?.nativeResponseSha
      if (typeof savedSha === 'string' && savedSha !== call.artifact?.response_sha) {
        throw new Error('native action response conflicts with its first verified digest')
      }
      const saved = invocation.evidence?.nativeActionResult
      const result = typeof savedSha === 'string' && saved && typeof saved === 'object' && !Array.isArray(saved)
        ? saved as Record<string, unknown> : await this.operations.readActionResult(invocation, call)
      let evidence = { ...result }
      if (attributedNativeAction(invocation)) {
        const original = matchingNativeActionReceipt(chain, invocation)
        const proof = nativeActionReceipt(chain, invocation, result, original?.observedAt ?? Date.now())
        if (original && chainBasis(proof) !== chainBasis(original)) throw new Error('native action response conflicts with its first accepted receipt')
        evidence = nativeActionSettlement(proof)
      } else if (result.nativeProcessFailure) {
        const retained = { ...physical, nativeActionResult: result, nativeResponseSha: call.artifact?.response_sha }
        if (!sameReceipt(invocation.evidence, retained)) {
          chain = this.append(chain, { type: 'invocation.reconciled', invocationId: invocation.id, evidence: retained })
        }
        const reason = 'native action returned a response with process failure; its original effect remains uncertain'
        return invocation.state === 'uncertain' && invocation.outcome === reason ? chain
          : this.append(chain, { type: 'invocation.uncertain', invocationId: invocation.id, reason })
      } else if (result.outcome === 'read_failed') {
        evidence = { ...result, status: 'failed', action: 'not_started', completedAt: Date.now() }
      } else if (['not_ready', 'superseded'].includes(String(result.outcome))
        || invocation.behavior === 'resolve-threads' && result.ready_except_conversations !== true) {
        evidence = { ...result, status: 'deferred', action: 'not_started', completedAt: Date.now() }
      }
      this.append(chain, { type: 'invocation.settled', invocationId: invocation.id, callId: call.id,
        outcome: String(evidence.outcome || evidence.action), evidence: { ...physical, nativeCallStatus: call.status, status: 'completed', ...evidence,
          completedAt: typeof physical.completedAt === 'number' && Number.isFinite(physical.completedAt)
            ? physical.completedAt : (evidence as Record<string, unknown>).completedAt } })
      this.operations.wake()
      return this.current(chain)
    }
    // A verified pre-publication prerequisite wait never wrote. It settles as
    // deferred, so the ordinary dependency wait re-admits without Resume or
    // failure-budget consumption. Worker prose alone cannot establish it.
    if (implementationPrerequisiteWait(chain, invocation, call)) {
      this.operations.received(invocation, call)
      return this.append(chain, { type: 'invocation.settled', invocationId: invocation.id, callId: call.id,
        outcome: 'prerequisite_wait', evidence: { ...receipt(call), status: 'deferred', action: 'not_started', outcome: 'prerequisite_wait' } })
    }
    if (call.outcome === 'repair_queue_blocked') {
      const evidence = { ...invocation.evidence, ...receipt(call), callId: call.id }
      const prior = invocation.evidence?.artifact as Record<string, unknown> | undefined
      const reason = 'repair queue blocker conflicts with the original publication admission or receipt'
      if (call.model !== invocation.model || String(call.pr_id) !== invocation.request.argv[invocation.request.argv.indexOf('--pull-number') + 1]
        || call.expected_head !== invocation.request.context?.head || invocation.evidence?.queueBlockerConflict === true
        || prior?.replies_started === true || prior?.result != null
        || (prior?.publication_head != null && prior.publication_head !== call.artifact?.publication_head)
        || !repairQueueBlocker(chain, { ...invocation, callId: call.id, evidence })) {
        const conflicted = { ...evidence, queueBlockerConflict: true }
        if (!sameReceipt(invocation.evidence, conflicted)) chain = this.append(chain, {
          type: 'invocation.reconciled', invocationId: invocation.id, evidence: conflicted })
        return invocation.state === 'uncertain' && invocation.outcome === reason ? chain
          : this.append(chain, { type: 'invocation.uncertain', invocationId: invocation.id, reason })
      }
      this.operations.received(invocation, call)
      chain = this.append(chain, { type: 'invocation.settled', invocationId: invocation.id, callId: call.id,
        outcome: 'repair_queue_blocked', evidence: { ...evidence, nativeCallStatus: call.status, status: 'deferred' } })
      this.operations.wake()
      return chain
    }
    if (prReview && invocation.request.argv.includes('--review-slot')) {
      const checkpoint = yieldedReview(call) ?? yieldedFinalization(call)
      if (checkpoint) {
        const resume = invocation.request.argv.indexOf('--resume-review')
        const input = resume < 0 ? null : invocation.request.argv[resume + 1]
        const link = call.artifact?.review_resume as { slot?: string } | undefined
        const slot = invocation.request.argv[invocation.request.argv.indexOf('--review-slot') + 1]
        if (call.model !== invocation.model || link?.slot !== slot || (input === null ? checkpoint.root_call !== call.id
          : !input?.startsWith(`${checkpoint.root_call}:`) || Number(input.split(':')[1]) >= checkpoint.generation)) {
          throw new Error(`native review checkpoint conflicts with admission ${invocation.id}: ${resumeReviewArgument(checkpoint)}`)
        }
        chain = this.append(chain, { type: 'invocation.settled', invocationId: invocation.id, callId: call.id,
          outcome: 'review_continuation_required', evidence: { ...receipt(call), status: 'deferred' } })
        chain = this.append(chain, { type: 'chain.waiting', reason: REVIEW_CAPACITY_WAIT })
        this.operations.wake()
        return chain
      }
    }
    const possibleWrite = call.action !== 'not_started' || (invocation.behavior === 'review-issue' || prReview)
      && (call.receipts != null || call.review_id != null || call.head_sha != null)
      || prReview && (call.artifact?.phase === 'submitting_review' || call.artifact?.phase === 'review_submitted'
        || call.error_code === 'review_budget_exhausted' && call.artifact?.phase !== 'reviewing')
      || invocation.behavior === 'approve-pr' && call.error_code === APPROVAL_CONVERSATION_REFUSAL && !approvalConversationRefusal(chain,
        { ...invocation, state: 'settled', callId: call.id, evidence: receipt(call) })
    if (call.status === 'failed' && possibleWrite && ['implement-issue', 'repair-pr', 'review-issue', 'review-pr', 'approve-pr'].includes(invocation.behavior)) {
      if (invocation.state === 'uncertain' && invocation.evidence?.callId === call.id) {
        const evidence = { ...receipt(call), callId: call.id }
        if (!resourceReleaseProven(invocation.evidence, true)) this.operations.received(invocation, call)
        return sameReceipt(invocation.evidence, evidence) ? chain
          : this.append(chain, { type: 'invocation.reconciled', invocationId: invocation.id, evidence })
      }
      this.operations.received(invocation, call)
      chain = this.append(chain, { type: 'invocation.reconciled', invocationId: invocation.id, evidence: { ...receipt(call), callId: call.id } })
      return this.append(chain, { type: 'invocation.uncertain', invocationId: invocation.id,
        reason: 'native publication may have happened; reconcile the original invocation against GitHub' })
    }
    if (invocation.behavior === 'implement-issue' && retiredImplementation(call)) {
      // Verified no-write closure settles as deferred, consuming no failure
      // attempt and producing no Error while keeping Caller history. Release
      // was proven above; anything unreleased already went uncertain.
      this.operations.received(invocation, call)
      return this.append(chain, { type: 'invocation.settled', invocationId: invocation.id, callId: call.id,
        outcome: 'target_closed', evidence: { ...receipt(call), status: 'deferred', callId: call.id } })
    }
    this.operations.received(invocation, call)
    chain = this.append(chain, { type: 'invocation.settled', invocationId: invocation.id, callId: call.id,
      outcome: call.error_code === 'atomic_work_execution_budget_exhausted' ? call.error_code : call.outcome || call.error_code || call.status,
      evidence: receipt(call) })
    if (stopped) return chain
    if (call.status === 'failed' && call.action !== 'not_started') return this.append(chain, { type: 'chain.held',
      reason: `behavior invocation ${invocation.id} failed after a possible write; its artifact needs reconciliation` })
    return chain
  }

  private recoverAuthentication(chain: BehaviorChain): BehaviorChain {
    if (chain.mergeSha || chain.invocations.some(invocation => invocation.state !== 'settled')) return chain
    const attempts = chain.invocations.filter(invocation => invocation.admissionSequence > chain.resumedAfterSequence
      && invocation.evidence?.status !== 'completed' && invocation.evidence?.status !== 'deferred')
    if (!attempts.length) return chain
    const last = attempts.at(-1)!
    // Only the trailing episode on this slot can own the automatic hold: an
    // earlier slot's failed invocation (even after its own success, which the
    // filter above already drops) must not block a later slot's recovery.
    let start = attempts.length - 1
    while (start > 0 && attempts[start - 1].basis === last.basis && attempts[start - 1].slot === last.slot) start--
    const episode = attempts.slice(start)
    if (!episode.length || episode.some(invocation => invocation.behavior !== 'review-issue'
      || invocation.evidence?.status !== 'failed' || invocation.evidence.action !== 'not_started'
      || invocation.evidence.outcome !== 'preflight_failed' || invocation.evidence.receipts !== null
      || invocation.evidence.review_id != null || invocation.evidence.head_sha != null
      || !resourceReleaseProven(invocation.evidence, true))) return chain
    const origins = episode.map(invocation => this.operations.authRecovered?.(invocation))
    if (origins.some(origin => !origin)) return chain
    const automaticHold = `review-issue failed before publication three times: ${String(last.evidence?.error || 'native failure')}`
    if (chain.held && (episode.length !== 3 || chain.held !== automaticHold)) return chain
    // The existing journal resume moves the retry boundary. Old failures,
    // publication evidence and resource receipts remain immutable.
    const recovery = origins.find(origin => typeof origin === 'object' && origin.origin === 'operator')
      || origins.find(origin => typeof origin === 'object' && origin.origin === 'unknown')
      || (origins.every(origin => typeof origin === 'object' && origin.origin === 'automatic') ? { origin: 'automatic' as const } : { origin: 'unknown' as const })
    return this.append(chain, { type: 'chain.resumed', recovery: typeof recovery === 'object' ? recovery : { origin: 'unknown' } })
  }

  private async start(chain: BehaviorChain, invocation: ChainInvocation, source = invocation.request.implementationSource): Promise<void> {
    chain = this.append(chain, { type: 'invocation.started', invocationId: invocation.id })
    if (invocation.request.command === 'agent-interface') {
      try {
        const started = await this.operations.launch(this.nativeInvocation(chain, invocation), (result) => this.exited(chain, invocation, result), () => this.allowed(chain, invocation, source))
        if (!started) this.append(this.current(chain), { type: 'invocation.settled', invocationId: invocation.id, callId: null, outcome: 'launch_deferred',
          evidence: { status: 'deferred', action: 'not_started', outcome: 'launch_deferred', completedAt: Date.now() } })
      } catch (error) {
        // spawnDetached rejects only before the OS accepts a launch.
        this.append(this.current(chain), { type: 'invocation.settled', invocationId: invocation.id, callId: null, outcome: 'spawn_failed',
          evidence: { status: 'failed', action: 'not_started', outcome: 'preflight_failed', error: String(error), completedAt: Date.now() } })
      }
    } else {
      try {
        let evidence = await this.operations.perform(invocation, chain)
        if (invocation.request.nativeResources === 2 && !evidence.nativeCallId) throw new Error('native action lacks its physical Call ownership')
        if (evidence.nativeCallId) {
          const physical = { nativeCallId: evidence.nativeCallId,
            ...(evidence.nativeOuterProcessFailure ? { nativeOuterProcessFailure: evidence.nativeOuterProcessFailure } : {}) }
          const retained = attributedNativeAction(invocation)
            ? { nativeActionReceipt: nativeActionReceipt(chain, invocation, evidence) }
            : { nativeActionResult: evidence }
          this.append(this.current(chain), { type: 'invocation.reconciled', invocationId: invocation.id, evidence: { ...physical, ...retained } })
          this.operations.wake()
          return
        }
        if (attributedNativeAction(invocation)) {
          const proof = nativeActionReceipt(chain, invocation, evidence)
          this.append(this.current(chain), { type: 'invocation.reconciled', invocationId: invocation.id, evidence: { nativeActionReceipt: proof } })
          evidence = nativeActionSettlement(proof)
        }
        this.append(this.current(chain), { type: 'invocation.settled', invocationId: invocation.id, callId: null,
          outcome: String(evidence.outcome || evidence.action), evidence: { status: 'completed', ...evidence } })
        this.operations.wake()
      } catch (error) {
        if (error instanceof CallerReceiptStoreError) {
          // requireCallerReceipts throws before any CLI: no Call and no side
          // effect. Settle as deferred so a fresh attempt can be admitted after
          // recovery, then abort this run while receipts stay unreadable.
          this.append(this.current(chain), { type: 'invocation.settled', invocationId: invocation.id, callId: null,
            outcome: 'receipt_unavailable', evidence: { status: 'deferred', action: 'not_started',
              outcome: 'receipt_unavailable', error: String(error), completedAt: Date.now() } })
          throw error
        }
        this.append(this.current(chain), { type: 'invocation.uncertain', invocationId: invocation.id, reason: String(error) })
      }
    }
  }

  private recoverNativeAction(chain: BehaviorChain, invocation: ChainInvocation): boolean {
    if (!attributedNativeAction(invocation)) return false
    const proof = matchingNativeActionReceipt(chain, invocation)
    if (proof) {
      if ((invocation.request.nativeResources === 2 || invocation.evidence?.nativeCallId)
        && !resourceReleaseProven(invocation.evidence ?? {}, true)) return true
      const evidence = nativeActionSettlement(proof)
      this.append(chain, { type: 'invocation.settled', invocationId: invocation.id,
        callId: typeof invocation.evidence?.nativeCallId === 'string' ? invocation.evidence.nativeCallId : null,
        outcome: String(evidence.outcome), evidence: { ...invocation.evidence, ...evidence } })
      this.operations.wake()
    }
    return true
  }

  private async closeRecovery(chain: BehaviorChain, invocation: ChainInvocation, observation: ChainObservation | null, snapshot: AgentLogSnapshot): Promise<boolean> {
    const reason = closedChainTarget(chain, observation, invocation.behavior)
    if (!reason || invocation.model === null) return false
    const calls = snapshot.entries.filter(call => call.correlation_id === invocation.id)
    const quarantined = snapshot.quarantined.some(row => !row.correlationId || row.correlationId === invocation.id)
    if (invocation.state === 'started' && invocation.evidence?.nativeExit) {
      chain = this.append(chain, { type: 'invocation.uncertain', invocationId: invocation.id,
        reason: 'native process exited without a durable Call receipt; its original outcome remains uncertain' })
    }
    if (!calls.length && !quarantined && invocation.state === 'admitted') {
      this.append(chain, { type: 'invocation.settled', invocationId: invocation.id, callId: null, outcome: 'target_closed',
        evidence: { status: 'deferred', action: 'not_started', outcome: 'target_closed', completedAt: Date.now(),
          closure: { reason, mergeSha: chain.mergeSha, checkedAt: observation?.checkedAt ?? null } } })
      this.operations.wake()
      return true
    }
    if (!calls.length && !quarantined && invocation.state === 'started' && !invocation.evidence?.nativeExit) {
      const attemptedAt = invocation.evidence?.closedFenceAttemptedAt
      if (typeof attemptedAt === 'number' && Date.now() - attemptedAt < 120_000) {
        if (typeof invocation.evidence?.closedFenceError === 'string') throw new ClosedTargetFenceError(invocation.evidence.closedFenceError)
        return true
      }
      chain = this.append(chain, { type: 'invocation.reconciled', invocationId: invocation.id,
        evidence: { closedFenceAttemptedAt: Date.now(), closedFenceError: null } })
      let won: boolean
      try {
        won = await this.operations.fenceClosedTarget(chain, invocation)
      } catch (error) {
        const message = `Closed-target correlation fence failed for ${chain.id}: ${String(error).slice(0, 1024)}`
        const current = this.append(this.current(chain), { type: 'invocation.reconciled', invocationId: invocation.id, evidence: { closedFenceError: message } })
        if (!current.held) this.append(current, { type: 'chain.held', reason: message })
        throw new ClosedTargetFenceError(message, { cause: error })
      }
      if (won) {
        const snapshot = await this.operations.readInvocations([invocation.id])
        chain = await this.reconcile(this.current(chain), snapshot)
        if (!chain.invocations.some(candidate => candidate.id === invocation.id && candidate.state !== 'settled')) return true
      }
    }
    chain = this.current(chain)
    if (!chain.held) this.append(chain, { type: 'chain.held', reason: `Original outcome requires read-only reconciliation because ${reason}` })
    return true
  }

  private async recover(chain: BehaviorChain, invocation: ChainInvocation, observation: ChainObservation, snapshot: AgentLogSnapshot): Promise<void> {
    const nativeId = invocation.evidence?.callId
    const publishedReview = observation.reviewPublication
    const resume = invocation.evidence?.publicationResume as { correlation?: unknown } | undefined
    const publicationReleased = typeof resume?.correlation !== 'string'
      || resourceReleaseProven(invocation.evidence?.publicationReceipt as Record<string, unknown> ?? {}, true)
    const resourcesSettled = resourceReleaseProven(invocation.evidence ?? {}, true) && publicationReleased
    if (resourcesSettled && invocation.state === 'uncertain' && publishedReview && publishedReview.callId === nativeId && publishedReview.complete) {
      this.append(chain, { type: 'invocation.settled', invocationId: invocation.id, callId: publishedReview.callId, outcome: 'commented',
        evidence: { ...invocation.evidence, status: 'completed', action: 'commented', outcome: 'commented',
          issue_revision: publishedReview.issueRevision, receipts: publishedReview.receipts, reconciliation: 'every planned review comment verified on GitHub' } })
      this.operations.wake()
      return
    }
    if (resourcesSettled && invocation.state === 'uncertain' && typeof nativeId === 'string' && observation.pull) {
      const expected = invocation.request.argv[invocation.request.argv.indexOf('--expected-head') + 1]
      const artifact = invocation.evidence?.artifact as Record<string, unknown> | null
      // A resumed finalizer publishes under its original marker; the
      // response check below revalidates the resumed binding either way.
      const resumedFrom = resumeLink(artifact)
      const review = observation.pull.reviewReceipts.find((receipt) => (receipt.invocation === nativeId
        || receipt.invocation === resumedFrom?.callId) && receipt.head === expected)
      const action = review?.state === 'APPROVED' ? 'approved' : review?.state === 'CHANGES_REQUESTED' ? 'requested_changes' : review?.state === 'COMMENTED' ? 'reviewed_clean' : null
      const coverage = (artifact?.review_response as { coverage?: unknown } | null)?.coverage
      // A published partial keeps its incomplete disposition; the failed call outcome cannot speak for it.
      const partial = action === 'requested_changes' && coverage === 'incomplete'
      if (review && action && chainReviewResponse(chain, { ...invocation, callId: nativeId,
        evidence: { ...invocation.evidence, action, review_id: review.id, ...(partial ? { outcome: 'incomplete' } : {}) } }, observation, Date.now())) {
        const outcome = action === 'approved' ? 'approved' : action === 'requested_changes' ? (partial ? 'incomplete' : 'changes_requested') : 'clean'
        this.append(chain, { type: 'invocation.settled', invocationId: invocation.id, callId: nativeId, outcome,
          evidence: { ...invocation.evidence, status: 'completed', action, outcome, review_id: review.id, head_sha: review.head,
            reconciliation: 'native invocation marker verified on the actual GitHub review' } })
        this.operations.wake()
        return
      }
    }
    if (resourcesSettled && invocation.state === 'uncertain' && typeof nativeId === 'string'
      && (invocation.behavior !== 'repair-pr' || (observation.workPublication?.callId === nativeId && observation.workPublication.repliesComplete))
      && nativeId === observation.publication.head_invocation && observation.publication.head_sha) {
      const outcome = observation.publication.pull_number ? 'published' : 'publication_incomplete'
      this.append(chain, { type: 'invocation.settled', invocationId: invocation.id, callId: nativeId, outcome,
        evidence: { ...invocation.evidence, status: 'completed', action: 'published', outcome,
          head_sha: observation.publication.head_sha, reconciliation: observation.publication } })
      this.operations.wake()
      return
    }
    if (resourcesSettled && invocation.state === 'uncertain' && typeof nativeId === 'string'
      && ['implement-issue', 'repair-pr'].includes(invocation.behavior)
      && (invocation.evidence?.artifact as Record<string, unknown> | null)?.phase === 'publishing'
      && (observation.publication.head_invocation !== nativeId || !observation.publication.head_sha)) {
      const reason = `${invocation.behavior} is uncertain; original Call ${nativeId} lacks a pre-push no-write checkpoint or a conclusive push result; reconcile that original push evidence before retrying`
      if (chain.waiting !== reason) chain = this.append(chain, { type: 'chain.waiting', reason })
    }
    if (await this.closeRecovery(chain, invocation, observation, snapshot)) return
    if (resourcesSettled && invocation.state === 'uncertain' && typeof nativeId === 'string'
      && invocation.behavior === 'repair-pr' && observation.workPublication?.callId === nativeId
      && !observation.workPublication.repliesComplete && observation.workPublication.resumable
      && (typeof resume?.correlation !== 'string'
        || (invocation.evidence?.publicationReceipt as Record<string, unknown> | undefined)?.action === 'not_started')
      && nativeId === observation.publication.head_invocation && observation.publication.head_sha
      && this.allowed(chain, invocation)) {
      const correlation = randomUUID()
      const current = this.append(chain, { type: 'invocation.reconciled', invocationId: invocation.id,
        evidence: { publicationResume: { callId: nativeId, head: observation.publication.head_sha,
          plan: observation.workPublication.planSha, correlation }, publicationReceipt: null } })
      try {
        await this.operations.resumePublication(current.invocations.find((item) => item.id === invocation.id)!, observation.publication.head_sha, correlation)
        this.operations.wake()
      } catch (error) {
        if (error instanceof CallerReceiptStoreError) {
          // No continuation Call was created. Clear the dangling correlation
          // so recovery retries with a fresh one after readability returns.
          this.append(this.current(chain), { type: 'invocation.reconciled', invocationId: invocation.id,
            evidence: { publicationResume: null, publicationResumeError: String(error) } })
          throw error
        }
        this.append(this.current(chain), { type: 'invocation.reconciled', invocationId: invocation.id,
          evidence: { publicationResumeError: String(error) } })
      }
      // A subsequent read verifies every actual reply, including when this
      // completion response was lost. It never admits a replacement worker.
      return
    }
    if (invocation.request.command === 'github-interface') {
      if (invocation.behavior === 'refresh-pr-ci') {
        const refreshCall = invocation.evidence?.nativeCallId
        const artifact = invocation.evidence?.artifact as Record<string, unknown> | undefined
        if (invocation.state === 'admitted') {
          if (snapshot.entries.some(call => call.correlation_id === invocation.id) || snapshot.quarantined.length) return
          const held = heldCiRepair(chain)
          // The original request re-verifies its pinned base inside Caller.
          // A crash before start can only resume that admission or settle it without a write.
          const current = decideBehaviorChain({ ...chain, invocations: chain.invocations.slice(0, -1) },
            { ...observation, ciRefresh: ciRefreshRequest(invocation) }, Date.now())
          if (held?.refresh?.id !== invocation.id || current.kind !== 'invoke' || current.behavior !== invocation.behavior
              || current.basis !== invocation.basis) {
            this.append(chain, { type: 'invocation.settled', invocationId: invocation.id, callId: null, outcome: 'launch_deferred',
              evidence: { status: 'deferred', action: 'not_started', outcome: 'launch_deferred', completedAt: Date.now() } })
            this.operations.wake()
            return
          }
          const accounts = this.operations.accounts()
          if (accounts.author.toLowerCase() === chain.author.toLowerCase() && accounts.reviewer.toLowerCase() === chain.reviewer.toLowerCase()
            && this.operations.enabled() && this.operations.permitted(chain, current)) await this.start(chain, invocation)
        } else if (invocation.state === 'uncertain' && resourcesSettled && typeof refreshCall === 'string'
          && invocation.evidence?.action === null && invocation.evidence?.status === 'failed'
          && artifact?.phase === 'performing_native_action' && artifact.request_sha === nativeRequestSha(invocation.request)
          && observedCiRefresh(invocation, observation)) {
          // Keep the original possible-write Call and its error. The clean
          // head proves the observed effect, without inventing a PUT response.
          this.append(chain, { type: 'invocation.settled', invocationId: invocation.id, callId: refreshCall, outcome: 'update_observed',
            evidence: { ...invocation.evidence, ciBaseUpdate: observation.ciBaseUpdate } })
          this.operations.wake()
        }
        return
      }
      if (this.recoverNativeAction(chain, invocation)) return
      let evidence: Record<string, unknown> | null = null
      if (invocation.behavior === 'rerun-grey-ci' && observation.greyRecovery?.invocationId === invocation.id
        && ['rerun_observed', 'superseded'].includes(String(observation.greyRecovery.receipt.outcome))) {
        evidence = { ...observation.greyRecovery.receipt,
          status: observation.greyRecovery.receipt.outcome === 'superseded' ? 'deferred' : 'completed' }
      }
      if (invocation.behavior === 'publish-issue' && observation.publication.pull_number
        && invocation.request.argv.includes('--invocation-id') && invocation.request.argv.includes('--expected-head')
        && observation.publication.head_invocation === invocation.request.argv[invocation.request.argv.indexOf('--invocation-id') + 1]
        && observation.publication.head_sha === invocation.request.argv[invocation.request.argv.indexOf('--expected-head') + 1]) {
        evidence = { outcome: 'published', ...observation.publication }
      }
      if (evidence) this.append(chain, { type: 'invocation.settled', invocationId: invocation.id,
        callId: typeof invocation.evidence?.nativeCallId === 'string' ? invocation.evidence.nativeCallId : null,
        outcome: String(evidence.outcome), evidence: { ...invocation.evidence,
          ...(invocation.evidence?.nativeCallId ? { nativeCallStatus: invocation.evidence.nativeCallStatus ?? invocation.evidence.status } : {}),
          status: 'completed', ...evidence } })
      return
    }
    if (!this.operations.enabled() || !this.operations.available() || chain.held || invocation.state === 'uncertain') return
    const accounts = this.operations.accounts()
    if (accounts.author.toLowerCase() !== chain.author.toLowerCase() || accounts.reviewer.toLowerCase() !== chain.reviewer.toLowerCase()
      || !this.operations.permitted(chain, { kind: 'invoke', actor: invocation.actor, behavior: invocation.behavior, basis: invocation.basis,
        reviewer: null, reason: 'recover the original admitted invocation' })) return
    if (snapshot.entries.some((call) => call.correlation_id === invocation.id)
      || snapshot.quarantined.length || Date.now() - invocation.admittedAt < 10_000) return
    if (invocation.evidence?.nativeExit) {
      this.append(chain, { type: 'invocation.uncertain', invocationId: invocation.id,
        reason: 'native process exited without a durable Call receipt; its exit evidence must be reconciled before another effect' })
      return
    }
    let source = invocation.request.implementationSource
    if (invocation.state === 'admitted' && invocation.behavior === 'implement-issue' && this.operations.implementationAdmission) {
      const gate = await this.operations.implementationAdmission(chain, observation)
      if (gate.reason) {
        // A blocked admission cannot launch, and its unsettled state would
        // block the new review and replacement disposition required to
        // progress; retire it, keeping the visible wait.
        const settled = this.append(chain, { type: 'invocation.settled', invocationId: invocation.id, callId: null, outcome: 'launch_deferred',
          evidence: { status: 'deferred', action: 'not_started', outcome: 'launch_deferred', completedAt: Date.now() } })
        if (settled.waiting !== gate.reason) this.append(settled, { type: 'chain.waiting', reason: gate.reason })
        this.operations.wake()
        return
      }
      // An admission that predates source binding cannot carry its launch
      // precondition; retire it so a fresh admission binds the current source.
      if (gate.source && gate.source.id !== source?.id) {
        this.append(chain, { type: 'invocation.settled', invocationId: invocation.id, callId: null, outcome: 'launch_deferred',
          evidence: { status: 'deferred', action: 'not_started', outcome: 'launch_deferred', completedAt: Date.now() } })
        this.operations.wake()
        return
      }
      if (chain.testRecovery?.triage) source = gate.source
    }
    if (invocation.state === 'admitted') await this.start(chain, invocation, source)
  }
}
