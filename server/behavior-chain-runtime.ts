import { randomUUID } from 'node:crypto'
import type { AgentLogSnapshot, LogEntry } from './agent-log-parse'
import type { DetachedProcessExit } from './process'
import { decideBehaviorChain, type ChainDecision, type ChainObservation } from './behavior-chain-decision'
import { BehaviorChainJournal, chainBasis, chainIdentity, type BehaviorChain, type ChainEvent, type ChainInvocation } from './behavior-chain-store'

export interface ChainSeed { repository: string, number: number }
export interface ChainRuntimeOperations {
  enabled(): boolean
  accounts(): { author: string, reviewer: string }
  discover(): Promise<ChainSeed[]>
  ownsRepository(repository: string): boolean
  observe(chain: BehaviorChain): Promise<ChainObservation>
  readInvocations(ids: string[]): Promise<AgentLogSnapshot>
  received(invocation: ChainInvocation, call: LogEntry): void
  available(): boolean
  capacity(): number
  permitted(chain: BehaviorChain, decision: Extract<ChainDecision, { kind: 'invoke' }>): boolean
  request(chain: BehaviorChain, observation: ChainObservation, decision: Extract<ChainDecision, { kind: 'invoke' }>, id: string): Promise<ChainInvocation['request'] | null>
  launch(invocation: ChainInvocation, onExit: (result?: DetachedProcessExit) => void, allowed: () => boolean): Promise<boolean>
  perform(invocation: ChainInvocation): Promise<Record<string, unknown>>
  resumePublication(invocation: ChainInvocation, head: string): Promise<Record<string, unknown>>
  wake(): void
}

function nativeBehavior(behavior: ChainInvocation['behavior']): string | null {
  return ({ 'review-issue': 'issue_review', 'review-pr': 'pr_review', 'approve-pr': 'pr_approve',
    'implement-issue': 'implement_issue', 'repair-pr': 'repair_pr' } as Partial<Record<ChainInvocation['behavior'], string>>)[behavior] ?? null
}

function receipt(call: LogEntry): Record<string, unknown> {
  return { status: call.status, action: call.action, outcome: call.outcome, head_sha: call.head_sha,
    review_id: call.review_id ?? null, receipts: call.receipts ?? null, artifact: call.artifact ?? null,
    issue_revision: call.issue_revision ?? null,
    resources_settled_at: call.resources_settled_at ?? null,
    error: call.error, error_code: call.error_code ?? null, completedAt: call.completed_at ? Date.parse(call.completed_at) : null }
}

/** A consumer of the existing behavior scheduler. It never owns a timer or
 * a model session. The journal owns every admission and recovery decision. */
export class BehaviorChainRuntime {
  private running = false
  private cursor = ''

  constructor(readonly journal: BehaviorChainJournal, private readonly operations: ChainRuntimeOperations) {}

  private append(chain: BehaviorChain, event: ChainEvent): BehaviorChain {
    return this.journal.append(chain.id, randomUUID(), chain.sequence, event)
  }

  private current(chain: BehaviorChain): BehaviorChain {
    const current = this.journal.read(chain.id)
    if (!current) throw new Error('behavior chain disappeared while its invocation was running')
    return current
  }

  private allowed(chain: BehaviorChain, invocation: ChainInvocation): boolean {
    const current = this.current(chain)
    const accounts = this.operations.accounts()
    return !current.held && this.operations.enabled() && accounts.author.toLowerCase() === current.author.toLowerCase() && accounts.reviewer.toLowerCase() === current.reviewer.toLowerCase()
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
      let page = this.journal.active(this.cursor)
      if (!page.length && this.cursor) { this.cursor = ''; page = this.journal.active() }
      if (!page.length) { this.cursor = ''; if (intakeError) throw intakeError; return }
      const pending = page.flatMap((chain) => chain.invocations.filter((invocation) => invocation.state !== 'settled' && invocation.model !== null))
      const snapshot = pending.length ? await this.operations.readInvocations(pending.map((invocation) => invocation.id)) : { entries: [], quarantined: [] }
      for (let chain of page) {
        if (Date.now() - began > 45_000) break
        this.cursor = chain.id
        if (!this.operations.ownsRepository(chain.repository)) continue
        chain = await this.reconcile(chain, snapshot)
        const owned = chain.invocations.find((invocation) => invocation.state !== 'settled' && invocation.model !== null)
        const call = owned ? snapshot.entries.find((entry) => entry.correlation_id === owned.id) : null
        if (owned && call && (call.status === 'running' || !call.resources_settled_at || !Number.isFinite(Date.parse(call.resources_settled_at)))) {
          // The authoritative admission already owns this invocation. Only
          // its native settlement can advance it; rereading GitHub while it
          // runs adds no decision evidence and burns shared API quota.
          continue
        }
        const observation = await this.operations.observe(chain)
        chain = this.append(chain, { type: 'chain.observed', observation })
        const pendingInvocation = chain.invocations.find((invocation) => invocation.state !== 'settled')
        if (pendingInvocation) {
          await this.recover(chain, pendingInvocation, observation, snapshot)
          continue
        }
        const decision = decideBehaviorChain(chain, observation, Date.now())
        if (decision.kind === 'complete') {
          this.append(chain, { type: 'chain.merged', mergeSha: decision.mergeSha, evidence: { repository: chain.repository,
            pull_number: observation.pull!.number, merged: true, merge_sha: decision.mergeSha } })
        } else if (decision.kind === 'hold') this.append(chain, { type: 'chain.held', reason: decision.reason })
        else if (decision.kind === 'invoke' && this.operations.enabled() && (!decision.reviewer || this.operations.available()) && this.operations.permitted(chain, decision)) {
          if (decision.reviewer && !this.journal.modelCapacityAvailable(this.operations.capacity())) {
            const reason = 'shared native invocation capacity is occupied'
            if (chain.waiting !== reason) this.append(chain, { type: 'chain.waiting', reason })
            continue
          }
          const accounts = this.operations.accounts()
          if (accounts.author.toLowerCase() !== chain.author.toLowerCase() || accounts.reviewer.toLowerCase() !== chain.reviewer.toLowerCase()) {
            this.append(chain, { type: 'chain.held', reason: 'configured accounts changed; existing chain ownership needs a decision' })
            continue
          }
          const id = randomUUID()
          const request = await this.operations.request(chain, observation, decision, id)
          if (!request) {
            this.append(chain, { type: 'chain.waiting', reason: `${decision.behavior} is waiting for native provider backoff` })
            continue
          }
          // Preparation can await provider/auth/configuration. Recheck admission
          // at the last boundary, before committing authority for an effect.
          if (!this.operations.enabled() || !this.operations.permitted(chain, decision)) continue
          const admitted = this.journal.admitInvocation(chain, randomUUID(), { id, behavior: decision.behavior, basis: decision.basis,
            actor: decision.actor, model: request.command === 'agent-interface' ? request.argv[request.argv.indexOf('--model') + 1] : null, slot: decision.reviewer?.slot ?? null,
            admittedAt: Date.now(), request }, this.operations.capacity())
          if (!admitted) { this.append(chain, { type: 'chain.waiting', reason: 'shared native invocation capacity is occupied' }); continue }
          chain = admitted
          await this.start(chain, chain.invocations.at(-1)!)
        } else {
          const reason = decision.kind === 'wait' ? decision.reason : !this.operations.enabled() ? 'behavior chain admissions are paused'
            : !this.operations.available() ? 'waiting for the shared native behavior capacity' : `${decision.behavior} is disabled or held by its behavior controls`
          if (reason !== chain.waiting) this.append(chain, { type: 'chain.waiting', reason })
        }
      }
      if (intakeError) throw intakeError
    } finally {
      this.running = false
    }
  }

  private async reconcile(chain: BehaviorChain, snapshot: AgentLogSnapshot): Promise<BehaviorChain> {
    const invocation = chain.invocations.find((candidate) => candidate.state !== 'settled')
    if (!invocation || invocation.model === null) return chain
    if (snapshot.quarantined.some((row) => row.correlationId === invocation.id || !row.correlationId)) {
      return invocation.state === 'uncertain' ? chain : this.append(chain, { type: 'invocation.uncertain', invocationId: invocation.id,
        reason: 'native call evidence is quarantined; absence cannot authorize another effect' })
    }
    const calls = snapshot.entries.filter((call) => call.correlation_id === invocation.id)
    if (!calls.length) return chain
    if (calls.length !== 1) return invocation.state === 'uncertain' ? chain : this.append(chain, { type: 'invocation.uncertain', invocationId: invocation.id,
      reason: 'multiple native calls claim one admitted invocation' })
    const call = calls[0]
    if (call.source !== 'poise:behavior-chain' || call.actor !== invocation.actor || call.repo !== chain.repository
      || call.behavior !== nativeBehavior(invocation.behavior)) throw new Error(`native receipt conflicts with behavior admission ${invocation.id}`)
    if (call.status === 'running') return chain
    if (!call.resources_settled_at || !Number.isFinite(Date.parse(call.resources_settled_at))) {
      return invocation.state === 'uncertain' ? chain : this.append(chain, { type: 'invocation.uncertain', invocationId: invocation.id,
        reason: 'native invocation ended without proof that its worker resources were released' })
    }
    if (call.status === 'failed' && call.action !== 'not_started' && ['implement-issue', 'repair-pr', 'review-issue', 'review-pr', 'approve-pr'].includes(invocation.behavior)) {
      if (invocation.state === 'uncertain' && invocation.evidence?.callId === call.id) {
        return chainBasis(invocation.evidence.artifact ?? null) === chainBasis(call.artifact ?? null) ? chain
          : this.append(chain, { type: 'invocation.reconciled', invocationId: invocation.id, evidence: { artifact: call.artifact ?? null } })
      }
      this.operations.received(invocation, call)
      if (['stopped', 'stopping'].includes(call.error_code || '') && !chain.held) chain = this.append(chain, { type: 'chain.held', reason: `behavior invocation ${invocation.id} was stopped by the person` })
      chain = this.append(chain, { type: 'invocation.reconciled', invocationId: invocation.id, evidence: { ...receipt(call), callId: call.id } })
      return this.append(chain, { type: 'invocation.uncertain', invocationId: invocation.id,
        reason: 'native publication may have happened; reconcile the original invocation against GitHub' })
    }
    this.operations.received(invocation, call)
    chain = this.append(chain, { type: 'invocation.settled', invocationId: invocation.id, callId: call.id,
      outcome: call.outcome || call.error_code || call.status, evidence: receipt(call) })
    if (['stopped', 'stopping'].includes(call.error_code || '')) return this.append(chain, { type: 'chain.held', reason: `behavior invocation ${invocation.id} was stopped by the person` })
    if (call.status === 'failed' && call.action !== 'not_started') return this.append(chain, { type: 'chain.held',
      reason: `behavior invocation ${invocation.id} failed after a possible write; its artifact needs reconciliation` })
    return chain
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
        const evidence = await this.operations.perform(invocation)
        this.append(this.current(chain), { type: 'invocation.settled', invocationId: invocation.id, callId: null,
          outcome: String(evidence.outcome || evidence.action), evidence: { status: 'completed', ...evidence } })
        this.operations.wake()
      } catch (error) {
        this.append(this.current(chain), { type: 'invocation.uncertain', invocationId: invocation.id, reason: String(error) })
      }
    }
  }

  private async recover(chain: BehaviorChain, invocation: ChainInvocation, observation: ChainObservation, snapshot: AgentLogSnapshot): Promise<void> {
    const nativeId = invocation.evidence?.callId
    const publishedReview = observation.reviewPublication
    const resourcesSettled = typeof invocation.evidence?.resources_settled_at === 'string'
      && Number.isFinite(Date.parse(invocation.evidence.resources_settled_at))
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
      if (review && action) {
        const outcome = action === 'approved' ? 'approved' : action === 'requested_changes' ? 'changes_requested' : 'clean'
        this.append(chain, { type: 'invocation.settled', invocationId: invocation.id, callId: nativeId, outcome,
          evidence: { ...invocation.evidence, status: 'completed', action, outcome, review_id: review.id, head_sha: review.head,
            reconciliation: 'native invocation marker verified on the actual GitHub review' } })
        this.operations.wake()
        return
      }
    }
    if (resourcesSettled && invocation.state === 'uncertain' && typeof nativeId === 'string'
      && invocation.behavior === 'repair-pr' && observation.workPublication?.callId === nativeId
      && !observation.workPublication.repliesComplete && observation.workPublication.resumable
      && nativeId === observation.publication.head_invocation && observation.publication.head_sha
      && this.allowed(chain, invocation)) {
      const current = this.append(chain, { type: 'invocation.reconciled', invocationId: invocation.id,
        evidence: { publicationResume: { callId: nativeId, head: observation.publication.head_sha, plan: observation.workPublication.planSha } } })
      try {
        await this.operations.resumePublication(current.invocations.find((item) => item.id === invocation.id)!, observation.publication.head_sha)
        this.operations.wake()
      } catch (error) {
        this.append(this.current(chain), { type: 'invocation.reconciled', invocationId: invocation.id,
          evidence: { publicationResumeError: String(error) } })
      }
      // A subsequent read verifies every actual reply, including when this
      // completion response was lost. It never admits a replacement worker.
      return
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
    if (invocation.request.command === 'github-interface') {
      const pull = observation.pull
      let evidence: Record<string, unknown> | null = null
      if (invocation.behavior === 'rerun-grey-ci' && observation.greyRecovery?.invocationId === invocation.id
        && ['rerun_observed', 'superseded'].includes(String(observation.greyRecovery.receipt.outcome))) {
        evidence = { ...observation.greyRecovery.receipt,
          status: observation.greyRecovery.receipt.outcome === 'superseded' ? 'deferred' : 'completed' }
      }
      if (invocation.behavior === 'publish-issue' && observation.publication.pull_number) evidence = { outcome: 'published', ...observation.publication }
      if (invocation.behavior === 'merge-pr' && pull?.merged && pull.mergeSha) evidence = { outcome: 'merged', merged: true, merge_sha: pull.mergeSha, head_sha: pull.head }
      if (invocation.behavior === 'merge-pr' && pull?.queueEntry) evidence = { outcome: 'in_queue', queue_entry_id: pull.queueEntry, head_sha: pull.head }
      if (invocation.behavior === 'resolve-threads' && pull?.unresolved === 0) evidence = { outcome: 'resolved', head_sha: pull.head }
      if (evidence) this.append(chain, { type: 'invocation.settled', invocationId: invocation.id, callId: null,
        outcome: String(evidence.outcome), evidence: { status: 'completed', ...evidence } })
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
    // Caller has a UNIQUE correlation index, reserved by track() before any
    // checkout/provider/write. Resuming this SAME native identity cannot start
    // a second behavior even if the first CLI is still preparing to track it.
    if (invocation.state === 'admitted') await this.start(chain, invocation)
    else {
      this.append(chain, { type: 'invocation.reconciled', invocationId: invocation.id, evidence: { nativeCallAbsent: true, retryUsesSameCorrelation: true } })
      const started = await this.operations.launch(this.nativeInvocation(chain, invocation), (result) => this.exited(chain, invocation, result), () => this.allowed(chain, invocation))
      if (!started) this.append(this.current(chain), { type: 'invocation.reconciled', invocationId: invocation.id,
        evidence: { repeatLaunchDeferred: true } })
    }
  }
}
