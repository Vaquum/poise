import { randomUUID } from 'node:crypto'
import type { AgentLogSnapshot, LogEntry } from './agent-log-parse'
import { resourceReleaseContradicted, resourceReleaseProven } from './behavior-resource-receipt'
import type { DetachedProcessExit } from './process'
import { automaticClosureHold, CHAIN_OBSERVATION_MAX_AGE_MS, chainReviewResponse, closedChainTarget, decideBehaviorChain, type ChainDecision, type ChainObservation } from './behavior-chain-decision'
import { BehaviorChainJournal, BehaviorChainRevisionConflict, chainBasis, chainIdentity, type BehaviorChain, type ChainEvent, type ChainInvocation } from './behavior-chain-store'
import { budgetShortfall, executionLimits, headroomShortfall, measureBehaviorHeadroom, readBehaviorResourceAdmission,
  type BehaviorResourceAdmission, type BehaviorResourceHeadroom } from './behavior-resources'
import { attributedNativeAction, matchingNativeActionReceipt, nativeActionReceipt, nativeActionSettlement, nativeRequestSha } from './behavior-chain-action'
import { CallerReceiptStoreError } from './service/caller-calls'
import { diagnostic } from './logging'

export interface ChainSeed { repository: string, number: number }
export interface ChainRuntimeOperations {
  enabled(): boolean
  accounts(): { author: string, reviewer: string }
  discover(): Promise<ChainSeed[]>
  ownsRepository(repository: string): boolean
  observe(chain: BehaviorChain): Promise<ChainObservation>
  /** Also reports terminal uncertain merge submissions without a chain hold. */
  reportHold?(chain: BehaviorChain): Promise<string | null>
  readInvocations(ids: string[]): Promise<AgentLogSnapshot>
  received(invocation: ChainInvocation, call: LogEntry): void
  authenticationRejected?(call: LogEntry): void
  authRecovered?(invocation: ChainInvocation): boolean
  available(): boolean
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
  wake(): void
}

export function nativeBehavior(behavior: ChainInvocation['behavior']): string | null {
  return ({ 'review-issue': 'issue_review', 'review-pr': 'pr_review', 'approve-pr': 'pr_approve',
    'implement-issue': 'implement_issue', 'repair-pr': 'repair_pr', 'merge-pr': 'native_action',
    'resolve-threads': 'native_action', 'rerun-grey-ci': 'native_action', 'publish-issue': 'native_action', 'retire-pr': 'native_action' } as Partial<Record<ChainInvocation['behavior'], string>>)[behavior] ?? null
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

function beforeNativeScope(call: LogEntry): boolean {
  const ownership = call.resource_ownership
  return call.status === 'failed' && call.error_code === 'launch_preflight_failed'
    && call.action === 'not_started' && call.outcome === 'preflight_failed' && call.head_sha === null
    && !call.artifact && !call.receipts && !call.review_id && !call.response && !call.runner && !call.resource_guard
    && ownership?.version === 1 && ownership.roots.length === 0 && ownership.errors.length === 0 && !ownership.process_pending
}

function sameReceipt(prior: Record<string, unknown> | null, next: Record<string, unknown>): boolean {
  return Object.entries(next).every(([key, value]) => chainBasis(prior?.[key] ?? null) === chainBasis(value ?? null))
}

function ciOnlyHold(invocation: ChainInvocation, call: LogEntry): BehaviorChain['ciHold'] {
  const ci = call.artifact?.ci_blocker as Record<string, unknown> | undefined
  if (invocation.behavior !== 'repair-pr' || call.status !== 'failed' || call.action !== 'not_started'
    || call.error_code !== 'atomic_work_blocked' || call.artifact?.phase !== 'executing' || call.artifact.plan_sha
    || !ci || ci.action !== 'list_failing_ci' || ci.repository !== call.repo || ci.pull_number !== Number(call.pr_id)
    || ci.head_sha !== call.expected_head || ci.head_sha !== invocation.request.context?.head
    || typeof ci.head_sha !== 'string' || !/^[0-9a-f]{40}$/i.test(ci.head_sha)
    || !Array.isArray(ci.failing) || !ci.failing.length) return undefined
  // A job/check identity pins the failed attempt even after the workflow is
  // rerun. Pending checks or a worker's prose alone cannot establish a cause.
  if (!ci.failing.some((check: Record<string, unknown>) => check?.type === 'check_run' && check.state === 'completed'
    && ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'].includes(String(check.conclusion))
    && Number.isSafeInteger(check.check_run_id) && Number(check.check_run_id) > 0
    && Number.isSafeInteger(check.log_id) && Number(check.log_id) > 0
    && typeof check.url === 'string' && check.url.length > 0)) return undefined
  return { invocationId: invocation.id, callId: call.id, head: ci.head_sha }
}

function ciRecovered(chain: BehaviorChain, observation: ChainObservation, now: number): boolean {
  const hold = chain.ciHold, pull = observation.pull, original = chain.invocations.at(-1)
  const evidence = original?.evidence, artifact = evidence?.artifact as Record<string, unknown> | undefined
  return !!chain.held && !!hold && !chain.mergeSha && original?.id === hold.invocationId && original.state === 'settled'
    && original.callId === hold.callId && evidence?.status === 'failed' && evidence.error_code === 'atomic_work_blocked'
    && evidence.action === 'not_started' && artifact?.phase === 'executing' && !artifact.plan_sha && !evidence.publicationResume
    && resourceReleaseProven(evidence, true) && typeof evidence.completedAt === 'number'
    && Number.isFinite(observation.checkedAt) && observation.checkedAt >= evidence.completedAt
    && observation.checkedAt >= Date.parse(String(evidence.resources_settled_at))
    && observation.checkedAt <= now && now - observation.checkedAt <= CHAIN_OBSERVATION_MAX_AGE_MS
    && !!pull && pull.state === 'open' && !pull.merged && pull.head === hold.head
    && pull.checksState === 'SUCCESS' && !pull.pending && pull.failing.length === 0
}

class ClosedTargetFenceError extends Error {}

export class MissingPublicationPlanError extends Error {
  constructor(readonly callId: string, readonly planSha: string) {
    super(`Original Call ${callId} has no durable publication plan`)
  }
}

/** A consumer of the existing behavior scheduler. It never owns a timer or
 * a model session. The journal owns every admission and recovery decision. */
export class BehaviorChainRuntime {
  private running = false
  private cursor = ''
  private reconciliationCursor = ''
  private authenticationCursor = ''

  constructor(readonly journal: BehaviorChainJournal, private readonly operations: ChainRuntimeOperations) {}

  private append(chain: BehaviorChain, event: ChainEvent): BehaviorChain {
    return this.journal.append(chain.id, randomUUID(), chain.sequence, event)
  }

  private current(chain: BehaviorChain): BehaviorChain {
    const current = this.journal.read(chain.id)
    if (!current) throw new Error('behavior chain disappeared while its invocation was running')
    return current
  }

  /** Durable-budget wait reason for one more reservation, or null when the
   *  budget holds it. Unknown ownership never reads as free. */
  private resourceWaitReason(resources: BehaviorResourceAdmission): string | null {
    const reserved = this.journal.reservedResources()
    if (reserved.unaccounted > 0) return `behavior resource accounting is incomplete: ${reserved.unaccounted} live invocation(s) predate reservations`
    return budgetShortfall(resources.budget, reserved, resources.reservation)
  }

  private allowed(chain: BehaviorChain, invocation: ChainInvocation): boolean {
    const current = this.current(chain)
    const accounts = this.operations.accounts()
    return current.invocations.some(candidate => candidate.id === invocation.id && candidate.state !== 'settled')
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
        console.error('[behavior-chain] intake failed; admitted chains continue', intakeError)
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
      for (const deferred of [false, true]) {
        if (Date.now() - began > 45_000) break
        const cursorKey = deferred ? 'reconciliationCursor' : 'cursor'
        let page = this.journal.reconcilable(this[cursorKey], Date.now(), deferred)
        if (!page.length && this[cursorKey]) {
          this[cursorKey] = ''
          page = this.journal.reconcilable('', Date.now(), deferred)
        }
        if (!page.length) { this[cursorKey] = ''; continue }
        const snapshot = await this.readInvocations(page.filter(chain => !conflicted.has(chain.id)))
        for (let chain of page) {
          if (Date.now() - began > 45_000) break
          this[cursorKey] = chain.id
          if (conflicted.has(chain.id)) continue
          let chainSnapshot = snapshot
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
                catch (error) { if (!(error instanceof ClosedTargetFenceError)) throw error; observationError ??= error }
                continue
              }
              if (chain.mergeSha && owned && !released) continue
              if (owned && call && (call.status === 'running' || !nativeResourcesReleased(call))) {
                // The authoritative admission already owns this invocation. Only
                // its native settlement can advance it; rereading GitHub while it
                // runs adds no decision evidence and burns shared API quota.
                continue
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
                observationError ??= new Error(`behavior observation failed for ${chain.id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
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
              if (observation.pull?.merged && observation.pull.mergeSha && !chain.mergeSha) {
                chain = this.append(chain, { type: 'chain.merged', mergeSha: observation.pull.mergeSha, evidence: { repository: chain.repository,
                  pull_number: observation.pull.number, merged: true, merge_sha: observation.pull.mergeSha, review_complete: false } })
              }
              const pendingInvocation = chain.invocations.find((invocation) => invocation.state !== 'settled')
              if (pendingInvocation) {
                phase = 'invocation-recovery'
                try { await this.recover(chain, pendingInvocation, observation, chainSnapshot) }
                catch (error) { if (!(error instanceof ClosedTargetFenceError)) throw error; observationError ??= error }
                if (pendingInvocation.behavior === 'merge-pr' && this.operations.reportHold) await this.reportHold(this.current(chain))
                continue
              }
              phase = 'decision'
              if (ciRecovered(chain, observation, Date.now())) {
                chain = this.append(chain, { type: 'chain.resumed', ciRecovery: chain.ciHold })
              }
              const mergeEvidence = observation.pull?.merged ? {
                before: this.journal.preMergeObservation(chain.id, observation.pull.mergedAt ?? Number.NaN) as ChainObservation | null,
                firstMerged: this.journal.firstMergedObservation(chain.id) as ChainObservation | null,
              } : undefined
              const decision = decideBehaviorChain(chain, observation, Date.now(), mergeEvidence)
              if (chain.held && decision.kind === 'wait' && this.operations.reportHold && await this.reportHold(chain)) continue
              if ((decision.kind === 'supersede' || decision.kind === 'invoke' && decision.behavior === 'retire-pr') && automaticClosureHold(chain.held)) {
                chain = this.append(chain, { type: 'chain.resumed' })
              }
              if (decision.kind === 'complete') {
                this.append(chain, { type: 'chain.merged', mergeSha: decision.mergeSha, evidence: { repository: chain.repository,
                  pull_number: observation.pull!.number, merged: true, merge_sha: decision.mergeSha, review_complete: true } })
              } else if (decision.kind === 'supersede') {
                this.append(chain, { type: 'chain.superseded', evidence: decision.evidence })
              } else if (decision.kind === 'hold') {
                if (!chain.held || automaticClosureHold(chain.held)) chain = this.append(chain, { type: 'chain.held', reason: decision.reason })
                if (this.operations.reportHold) await this.reportHold(chain)
              } else if (decision.kind === 'invoke' && this.operations.enabled() && (!decision.reviewer || this.operations.available()) && this.operations.permitted(chain, decision)) {
                const closed = closedChainTarget(chain, observation, decision.behavior)
                if (closed) {
                  if (!chain.held) this.append(chain, { type: 'chain.held', reason: `No new ${decision.behavior}: ${closed}` })
                  continue
                }
                if (decision.reviewer && !this.journal.modelCapacityAvailable(this.operations.capacity())) {
                  const reason = 'shared native invocation capacity is occupied'
                  if (chain.waiting !== reason) this.append(chain, { type: 'chain.waiting', reason })
                  continue
                }
                // Resource-aware admission precedes provider preparation like the
                // count check, so blocked work holds no native agent session and
                // consumes no provider probe. Unset budgets skip every probe.
                const resources = readBehaviorResourceAdmission()
                if (resources) {
                  const exhausted = this.resourceWaitReason(resources)
                  if (exhausted) {
                    if (chain.waiting !== exhausted) this.append(chain, { type: 'chain.waiting', reason: exhausted })
                    continue
                  }
                  try {
                    const cramped = headroomShortfall((this.operations.measureHeadroom ?? measureBehaviorHeadroom)(), resources.reservation)
                    if (cramped) {
                      if (chain.waiting !== cramped) this.append(chain, { type: 'chain.waiting', reason: cramped })
                      continue
                    }
                  } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error)
                    if (chain.waiting !== reason) this.append(chain, { type: 'chain.waiting', reason })
                    continue
                  }
                }
                const accounts = this.operations.accounts()
                if (accounts.author.toLowerCase() !== chain.author.toLowerCase() || accounts.reviewer.toLowerCase() !== chain.reviewer.toLowerCase()) {
                  this.append(chain, { type: 'chain.held', reason: 'configured accounts changed; existing chain ownership needs a decision' })
                  continue
                }
                const id = randomUUID()
                phase = 'request-preparation'
                let request = await this.operations.request(chain, observation, decision, id)
                if (!request) {
                  const reason = `${decision.behavior} is waiting for native provider backoff`
                  // Resume retains waiting; its first observed sweep starts a new episode.
                  if (chain.waiting !== reason || (chain.resumedAfterSequence > 0
                    && this.journal.history(chain.id, chain.resumedAfterSequence, 1)[0]?.sequence === chain.sequence)) {
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
                phase = 'invocation-admission'
                const admitted = this.journal.admitInvocation(chain, randomUUID(), { id, behavior: decision.behavior, basis: decision.basis,
                  actor: decision.actor, model: request.command === 'agent-interface' ? request.argv[request.argv.indexOf('--model') + 1] : null, slot: decision.reviewer?.slot ?? null,
                  ...(resources ? { reservation: resources.reservation } : {}),
                  admittedAt: Date.now(), request }, this.operations.capacity(), resources?.budget ?? null)
                if (!admitted) {
                  const reason = !this.journal.modelCapacityAvailable(this.operations.capacity()) ? 'shared native invocation capacity is occupied'
                    : resources ? this.resourceWaitReason(resources) ?? 'shared native invocation capacity is occupied'
                    : 'shared native invocation capacity is occupied'
                  this.append(chain, { type: 'chain.waiting', reason })
                  continue
                }
                chain = admitted
                phase = 'invocation-start'
                await this.start(chain, chain.invocations.at(-1)!)
              } else {
                const reason = decision.kind === 'wait' ? decision.reason : !this.operations.enabled() ? 'behavior chain admissions are paused'
                  : !this.operations.available() ? 'waiting for the shared native behavior capacity' : `${decision.behavior} is disabled or held by its behavior controls`
                if (reason !== chain.waiting) this.append(chain, { type: 'chain.waiting', reason })
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
    if (reason && (current.held || current.invocations.some(invocation => invocation.behavior === 'merge-pr' && invocation.state === 'uncertain'))
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
    if (invocation.request.resourceLimits && call.outcome !== 'target_closed' && !beforeNativeScope(call)
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
    if (call.status === 'running') return chain
    // Authentication is actionable even while native cleanup still owns the
    // reservation. Reconciliation below continues to require release proof.
    if (invocation.evidence?.callId !== call.id) this.operations.authenticationRejected?.(call)
    const stopped = ['stopped', 'stopping'].includes(call.error_code || '')
    const resourceStopped = ['resource_memory_exceeded', 'resource_disk_exceeded', 'resource_measurement_unavailable', 'resource_receipt_unavailable'].includes(call.error_code || '')
    const workBlocked = call.error_code === 'atomic_work_blocked'
    const ciHold = workBlocked ? ciOnlyHold(invocation, call) : undefined
    if ((resourceStopped || workBlocked) && !chain.held) chain = this.append(chain, { type: 'chain.held', reason: call.error,
      ...(ciHold ? { ciHold } : {}) })
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
      const reason = `native invocation ended without proof that its worker resources were released${cause}`
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
      const physical = { ...receipt(call), nativeCallId: call.id }
      if (call.artifact?.request_sha && call.artifact.request_sha !== nativeRequestSha(invocation.request)) {
        throw new Error('native action Call conflicts with its immutable journal request')
      }
      const responded = call.artifact?.phase === 'received_native_action' && typeof call.artifact.response_sha === 'string' && !!call.response
      if (call.status === 'failed' && call.action === 'not_started' && !responded) {
        this.append(chain, { type: 'invocation.settled', invocationId: invocation.id, callId: call.id,
          outcome: call.outcome || 'preflight_failed', evidence: physical })
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
        outcome: String(evidence.outcome || evidence.action), evidence: { ...physical, nativeCallStatus: call.status, status: 'completed', ...evidence } })
      this.operations.wake()
      return this.current(chain)
    }
    const possibleWrite = call.action !== 'not_started' || invocation.behavior === 'review-issue'
      && (call.receipts != null || call.review_id != null || call.head_sha != null)
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
      || !resourceReleaseProven(invocation.evidence, true) || !this.operations.authRecovered?.(invocation))) return chain
    const automaticHold = `review-issue failed before publication three times: ${String(last.evidence?.error || 'native failure')}`
    if (chain.held && (episode.length !== 3 || chain.held !== automaticHold)) return chain
    // The existing journal resume moves the retry boundary. Old failures,
    // publication evidence and resource receipts remain immutable.
    return this.append(chain, { type: 'chain.resumed' })
  }

  private async start(chain: BehaviorChain, invocation: ChainInvocation): Promise<void> {
    chain = this.append(chain, { type: 'invocation.started', invocationId: invocation.id })
    if (invocation.request.command === 'agent-interface') {
      try {
        const started = await this.operations.launch(this.nativeInvocation(chain, invocation), (result) => this.exited(chain, invocation, result), () => this.allowed(chain, invocation))
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
      const review = observation.pull.reviewReceipts.find((receipt) => receipt.invocation === nativeId && receipt.head === expected)
      const action = review?.state === 'APPROVED' ? 'approved' : review?.state === 'CHANGES_REQUESTED' ? 'requested_changes' : review?.state === 'COMMENTED' ? 'reviewed_clean' : null
      if (review && action && chainReviewResponse(chain, { ...invocation, callId: nativeId,
        evidence: { ...invocation.evidence, action, review_id: review.id } }, observation, Date.now())) {
        const outcome = action === 'approved' ? 'approved' : action === 'requested_changes' ? 'changes_requested' : 'clean'
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
    if (invocation.state === 'admitted') await this.start(chain, invocation)
  }
}
