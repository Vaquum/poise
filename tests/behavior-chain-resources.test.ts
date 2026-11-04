import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseAgentLogStdout } from '../server/agent-log-parse'
import { BehaviorChainJournal, chainBasis, chainIdentity, type BehaviorChain, type ChainAdmission, type ChainEvent } from '../server/behavior-chain-store'
import { BehaviorChainRuntime, type ChainRuntimeOperations } from '../server/behavior-chain-runtime'
import { BehaviorResourceRecovery } from '../server/behavior-chain-resource-recovery'
import type { ChainObservation } from '../server/behavior-chain-decision'
import type { Organization } from '../server/organizations'
import { completedReviewCall } from './review-response-fixture'

const mocks = vi.hoisted(() => ({ spawnDetached: vi.fn() }))
vi.mock('../server/process', () => ({ runFile: vi.fn(), spawnDetached: mocks.spawnDetached }))
vi.mock('../server/models', () => ({ agentInterfaceCwd: () => '/interface' }))
vi.mock('../server/settings', () => ({ getSettings: () => ({ me: 'author', agentAccount: 'reviewer' }),
  getBehaviorChainSettings: () => ({ enabled: true, seedMode: 'all', label: 'poise' }) }))
vi.mock('../server/organizations', () => ({ organizationForRepository: () => ({ login: 'example' }), organizationArgs: vi.fn() }))
const { nativeChainOperations } = await import('../server/behavior-chain-native')

const NOW = 1_800_000_000_000
const REVIEWER = { slot: 'primary', model: 'fixture-model', recovery: 'fixture-model' }
const BUDGET = { memoryBytes: 10, diskBytes: null as number | null }
const RESERVATION = { memoryBytes: 6, diskBytes: 0 }
const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.unstubAllEnvs(); mocks.spawnDetached.mockReset() })

function setup(): { db: Database.Database, journal: BehaviorChainJournal, chain: BehaviorChain } {
  const db = new Database(':memory:'); databases.push(db)
  const journal = new BehaviorChainJournal(db)
  const chain = seed(journal, 7)
  return { db, journal, chain }
}
function seed(journal: BehaviorChainJournal, issue: number): BehaviorChain {
  return journal.append(chainIdentity('Example/Repo', issue), `seed-${issue}`, 0, { type: 'chain.admitted',
    repository: 'Example/Repo', issue, branch: `poise/issue-${issue}`, author: 'author', reviewer: 'reviewer' }, NOW)
}
function record(journal: BehaviorChainJournal, chain: BehaviorChain, event: ChainEvent): BehaviorChain {
  return journal.append(chain.id, `event-${chain.sequence}-${Math.random()}`, chain.sequence, event, NOW)
}
function invocation(id: string, reservation?: ChainAdmission['reservation']): ChainAdmission {
  return { id, behavior: 'review-issue', basis: 'revision', actor: 'reviewer', model: 'fixture-model', slot: 'primary',
    ...(reservation === undefined ? {} : { reservation }), admittedAt: NOW,
    request: { command: 'agent-interface', argv: ['--fixture'], cwd: '/fixture' } }
}
function observation(): ChainObservation {
  return { checkedAt: Date.now(), existingPulls: [],
    issue: { open: true, eligible: true, revision: chainBasis(['title', 'body']), commentIds: [17] },
    issueReviewers: [REVIEWER], prReviewers: [REVIEWER], implementer: REVIEWER, repairer: REVIEWER, approver: REVIEWER,
    publication: { pull_number: null, head_sha: null, head_invocation: null, state: null, merged: false, merge_sha: null }, pull: null }
}
function operations(overrides: Partial<ChainRuntimeOperations> = {}): ChainRuntimeOperations {
  return { enabled: () => true, accounts: () => ({ author: 'author', reviewer: 'reviewer' }), discover: async () => [],
    ownsRepository: () => true, observe: async () => observation(), readInvocations: async () => ({ entries: [], quarantined: [] }),
    received: () => {}, available: () => true, capacity: () => 2, permitted: () => true,
    measureHeadroom: () => ({ freeMemoryBytes: 100, freeDiskBytes: 100, diskPath: '/fixture' }),
    request: async () => ({ command: 'agent-interface', argv: ['--model', 'fixture-model'], cwd: '/fixture' }),
    launch: async () => true, perform: async () => ({}), resumePublication: async () => { throw new Error('unexpected publication resume') },
    readActionResult: async () => { throw new Error('unexpected native response read') },
    fenceClosedTarget: async () => { throw new Error('unexpected closed-target fence') },
    wake: () => {}, ...overrides }
}
function bounded(memory = '10', reservation = '6'): void {
  vi.stubEnv('POISE_BEHAVIOR_MEMORY_BUDGET_BYTES', memory)
  vi.stubEnv('POISE_BEHAVIOR_MEMORY_RESERVATION_BYTES', reservation)
}

describe('durable behavior resource reservations', () => {
  it.each(['merged', 'held', 'settled'])("recovers only physical resources for a %s chain without admission or external actions", async mode => {
    const { journal, chain } = setup()
    const admitted = { ...invocation('original', RESERVATION), request: { command: 'agent-interface' as const,
      argv: ['--fixture'], cwd: '/fixture', nativeResources: 2 as const } }
    let current = record(journal, chain, { type: 'invocation.admitted', invocation: admitted })
    current = record(journal, current, { type: 'invocation.uncertain', invocationId: admitted.id, reason: 'original effect remains uncertain' })
    current = record(journal, current, { type: 'invocation.reconciled', invocationId: admitted.id,
      evidence: { artifact: { phase: 'posting_issue_reviews', plan_sha: 'd'.repeat(64) } } })
    if (mode === 'settled') current = record(journal, current, { type: 'invocation.settled', invocationId: admitted.id,
      callId: 'c'.repeat(32), outcome: 'retained original outcome', evidence: { status: 'completed', artifact: current.invocations[0].evidence?.artifact } })
    if (mode === 'held') current = record(journal, current, { type: 'chain.held', reason: 'person paused admissions' })
    if (mode === 'merged') current = record(journal, current, { type: 'chain.merged', mergeSha: 'a'.repeat(40),
      evidence: { merged: true, merge_sha: 'a'.repeat(40), repository: chain.repository, pull_number: 9, review_complete: false } })
    const before = structuredClone(current)
    const namespace = { state: 'settled', callId: 'c'.repeat(32), correlation: admitted.id, settled_at: 15,
      controller: { version: 1, instance: 'b'.repeat(32) }, binding: { pid: 4, start: '4', namespace: 'pid:[9]',
        owner: { pid: 2, start: '2' }, holder: { pid: 3, start: '3' },
        epoch: { boot: 'fixture', init_start: '1', namespace_dev: '1', namespace_ino: '9' } } }
    const call = { ...completedReviewCall(chain.repository, chain.issue, 'a'.repeat(40), chain.reviewer), id: 'c'.repeat(32),
      behavior: 'issue_review', source: 'poise:behavior-chain', correlation_id: admitted.id, model: admitted.model,
      action: 'commented', outcome: 'commented', resources_settled_at: new Date(20_000).toISOString(),
      artifact: { phase: 'resources_unknown', resource_error: 'retained cleanup cause', resource_recovered_at: 18 },
      resource_ownership: { version: 2, roots: [], errors: [{ cause: 'resources_unknown', path: null, at: 12, recovered_at: 18 }], namespace } }
    const read = vi.fn(async () => parseAgentLogStdout(JSON.stringify([call]), 'physical-only recovery fixture'))
    const recovery = new BehaviorResourceRecovery(journal, read)
    expect(journal.liveModelInvocationCount()).toBe(1)
    await recovery.run()
    expect(journal.liveModelInvocationCount()).toBe(0)
    const recovered = journal.read(chain.id)!
    expect(recovered.invocations[0]).toMatchObject({ state: before.invocations[0].state, outcome: before.invocations[0].outcome,
      callId: before.invocations[0].callId })
    expect(recovered.held).toBe(before.held)
    expect(recovered.mergeSha).toBe(before.mergeSha)
    expect(recovered.invocations[0].evidence?.artifact).toMatchObject({ phase: 'posting_issue_reviews', plan_sha: 'd'.repeat(64), resource_recovered_at: 18 })
    const history = journal.history(chain.id)
    await recovery.run()
    expect(journal.history(chain.id)).toEqual(history)
    journal.rebuild()
    expect(journal.history(chain.id)).toEqual(history)
    expect(journal.read(chain.id)).toEqual(recovered)
  })

  it('admits within the budget and refuses over-budget without double-spend', () => {
    const { journal, chain } = setup()
    const other = seed(journal, 8)
    expect(journal.admitInvocation(chain, 'admit-one', invocation('one', RESERVATION), 2, BUDGET)).not.toBeNull()
    expect(journal.reservedResources()).toEqual({ memoryBytes: 6, diskBytes: 0, unaccounted: 0 })
    expect(journal.admitInvocation(other, 'admit-two', invocation('two', RESERVATION), 2, BUDGET)).toBeNull()
    expect(journal.reservedResources()).toEqual({ memoryBytes: 6, diskBytes: 0, unaccounted: 0 })
    const settled = record(journal, journal.read(chain.id)!, { type: 'invocation.settled', invocationId: 'one',
      callId: 'native', outcome: 'commented', evidence: { status: 'completed', resources_settled_at: new Date(NOW).toISOString() } })
    expect(settled.invocations[0].state).toBe('settled')
    expect(journal.admitInvocation(other, 'admit-two', invocation('two', RESERVATION), 2, BUDGET)).not.toBeNull()
    expect(journal.reservedResources()).toEqual({ memoryBytes: 6, diskBytes: 0, unaccounted: 0 })
  })

  it('bounds disk independently of memory', () => {
    const { journal, chain } = setup()
    const other = seed(journal, 8)
    const disk = { memoryBytes: null as number | null, diskBytes: 100 }
    const heavy = { memoryBytes: 0, diskBytes: 60 }
    expect(journal.admitInvocation(chain, 'admit-one', invocation('one', heavy), 2, disk)).not.toBeNull()
    expect(journal.admitInvocation(other, 'admit-two', invocation('two', heavy), 2, disk)).toBeNull()
  })

  it('retains the reservation through cleanup uncertainty and releases it exactly once on verified settlement', () => {
    const { journal, chain } = setup()
    record(journal, journal.read(chain.id)!, { type: 'invocation.admitted', invocation: invocation('one', RESERVATION) })
    let current = record(journal, journal.read(chain.id)!, { type: 'invocation.uncertain', invocationId: 'one', reason: 'worker ended without proof of release' })
    expect(journal.reservedResources().memoryBytes).toBe(6)
    current = record(journal, current, { type: 'invocation.reconciled', invocationId: 'one',
      evidence: { resources_settled_at: new Date(NOW).toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } } })
    expect(journal.reservedResources().memoryBytes).toBe(0)
    current = record(journal, current, { type: 'invocation.settled', invocationId: 'one', callId: 'native',
      outcome: 'commented', evidence: { status: 'completed', resources_settled_at: new Date(NOW).toISOString() } })
    expect(journal.reservedResources().memoryBytes).toBe(0)
    expect(() => record(journal, current, { type: 'invocation.settled', invocationId: 'one', callId: 'native',
      outcome: 'commented', evidence: { status: 'completed' } })).toThrow('settlement needs new native evidence')
  })

  it('makes unknown ownership block bounded admissions instead of reading as free', () => {
    const { journal, chain } = setup()
    const other = seed(journal, 8)
    expect(journal.admitInvocation(chain, 'admit-old', invocation('old'), 2)).not.toBeNull()
    expect(journal.reservedResources()).toEqual({ memoryBytes: 0, diskBytes: 0, unaccounted: 1 })
    expect(journal.admitInvocation(other, 'admit-new', invocation('new', RESERVATION), 2, BUDGET)).toBeNull()
    record(journal, journal.read(chain.id)!, { type: 'invocation.settled', invocationId: 'old', callId: 'native',
      outcome: 'commented', evidence: { status: 'completed', resources_settled_at: new Date(NOW).toISOString() } })
    expect(journal.admitInvocation(other, 'admit-new', invocation('new', RESERVATION), 2, BUDGET)).not.toBeNull()
  })

  it('rejects bounded admissions without a valid reservation explicitly', () => {
    const { journal, chain } = setup()
    expect(() => journal.admitInvocation(chain, 'admit-missing', invocation('missing'), 2, BUDGET)).toThrow('carries no valid reservation')
    expect(() => record(journal, chain, { type: 'invocation.admitted', invocation: invocation('bad', { memoryBytes: -1, diskBytes: 0 }) }))
      .toThrow('invalid resource reservation')
  })

  it('survives server replacement through the immutable event log', () => {
    const { db, journal, chain } = setup()
    const other = seed(journal, 8)
    expect(journal.admitInvocation(chain, 'admit-one', invocation('one', RESERVATION), 2, BUDGET)).not.toBeNull()
    const restarted = new BehaviorChainJournal(db)
    restarted.rebuild()
    expect(restarted.reservedResources()).toEqual({ memoryBytes: 6, diskBytes: 0, unaccounted: 0 })
    expect(restarted.admitInvocation(restarted.read(other.id)!, 'admit-two', invocation('two', RESERVATION), 2, BUDGET)).toBeNull()
  })
})

describe('resource-aware behavior admission', () => {
  it('settles a bounded pre-track failure without fabricating an enforced worker or aborting other reconciliation', async () => {
    const { journal, chain } = setup()
    const other = seed(journal, 8)
    const limits = { version: 1 as const, memoryBytes: 6, diskBytes: null }
    const original = invocation('pretrack-original', RESERVATION)
    const admitted = { ...original, request: { ...original.request, resourceLimits: limits,
      argv: [...original.request.argv, '--resource-limits-json', JSON.stringify(limits)] } }
    record(journal, chain, { type: 'invocation.admitted', invocation: admitted })
    const call = { ...completedReviewCall(chain.repository, chain.issue, 'a'.repeat(40), chain.reviewer),
      behavior: 'issue_review', source: 'poise:behavior-chain', correlation_id: admitted.id, model: admitted.model,
      status: 'failed', error_code: 'launch_preflight_failed', error: 'catalog preparation failed before track',
      action: 'not_started', outcome: 'preflight_failed', head_sha: null, expected_head: null,
      review_id: null, artifact: null, receipts: null, response: null,
      resource_ownership: { version: 1, roots: [], errors: [] }, resources_settled_at: new Date().toISOString() }
    const runtime = new BehaviorChainRuntime(journal, operations({ enabled: () => false,
      readInvocations: async () => parseAgentLogStdout(JSON.stringify([call]), 'pre-track native serializer contract') }))
    await runtime.run()
    expect(journal.read(chain.id)!.invocations[0]).toMatchObject({ state: 'settled', outcome: 'preflight_failed' })
    expect(journal.reservedResources().memoryBytes).toBe(0)
    expect(journal.read(chain.id)!.invocations[0].evidence).not.toHaveProperty('resource_guard')
    expect(journal.read(other.id)!.observation).not.toBeNull()
  })

  it('journals provider-visible execution ceilings before launch and preserves old replay hashes', async () => {
    bounded('100', '60')
    const { journal, chain } = setup()
    const launch = vi.fn(async () => true)
    await new BehaviorChainRuntime(journal, operations({ launch,
      request: async () => ({ command: 'agent-interface', argv: ['--model', 'fixture-model', '--note', 'Repository-specific instructions'], cwd: '/fixture' }),
    })).run()
    const admitted = journal.read(chain.id)!.invocations[0]
    expect(admitted.reservation).toEqual({ memoryBytes: 60, diskBytes: 0 })
    expect(admitted.request.resourceLimits).toEqual({ version: 1, memoryBytes: 60, diskBytes: null })
    expect(JSON.parse(admitted.request.argv.at(-1)!)).toEqual(admitted.request.resourceLimits)
    expect(admitted.request.argv.at(-2)).toBe('--resource-limits-json')
    const note = admitted.request.argv[admitted.request.argv.indexOf('--note') + 1]
    expect(note).toContain('Repository-specific instructions')
    expect(note).toContain(JSON.stringify(admitted.request.resourceLimits))
    expect(note).toContain('provider and all child processes')
    expect(note).toContain('one worker')
    expect(note).toContain('Preserve all required checks and assertions')
    const before = journal.read(chain.id)
    journal.rebuild()
    expect(journal.read(chain.id)).toEqual(before)
    expect(launch).toHaveBeenCalledOnce()
  })

  it.each(['resource_memory_exceeded', 'resource_disk_exceeded', 'resource_measurement_unavailable'])(
    'holds on %s through verified cleanup without mislabelling person Stop or admitting another behavior', async code => {
      const { journal, chain } = setup()
      const limits = { version: 1 as const, memoryBytes: code === 'resource_disk_exceeded' ? null : 6,
        diskBytes: code === 'resource_disk_exceeded' ? 1 : null }
      const original = invocation('breached-original', { memoryBytes: 6, diskBytes: 1 })
      const admitted = { ...original, admittedAt: Date.now() - 3000,
        request: { ...original.request, resourceLimits: limits,
          argv: [...original.request.argv, '--resource-limits-json', JSON.stringify(limits)] } }
      record(journal, chain, { type: 'invocation.admitted', invocation: admitted })
      const namespace = { state: 'active', callId: 'c'.repeat(32), correlation: admitted.id,
        controller: { version: 1, instance: 'b'.repeat(32) }, binding: { pid: 4, start: '4', namespace: 'pid:[9]',
          owner: { pid: 2, start: '2' }, holder: { pid: 3, start: '3' },
          epoch: { boot: 'fixture', init_start: '1', namespace_dev: '1', namespace_ino: '9' } } }
      const call = { ...completedReviewCall(chain.repository, chain.issue, 'a'.repeat(40), chain.reviewer), id: 'c'.repeat(32),
        behavior: 'issue_review', source: 'poise:behavior-chain', correlation_id: admitted.id, model: admitted.model,
        status: 'failed', error_code: code, error: 'Behavior fixture resource coverage failed', action: null, outcome: null,
        head_sha: null, expected_head: null, review_id: null, artifact: null, receipts: null,
        resource_guard: { version: 1, limits, state: 'stopped', memoryModel: 'rss', peakMemoryBytes: 7, peakDiskBytes: 2,
          samples: 1, partialSamples: 0, lastCompleteAt: 11, longestUnavailableSeconds: 1,
          failure: { code, dimension: code === 'resource_disk_exceeded' ? 'diskBytes' : code === 'resource_memory_exceeded' ? 'memoryBytes' : 'coverage',
            ceiling: code === 'resource_disk_exceeded' ? 1 : code === 'resource_memory_exceeded' ? 6 : null,
            observed: code === 'resource_disk_exceeded' ? 2 : code === 'resource_memory_exceeded' ? 7 : null,
            observedAt: 11, observedMonotonic: 11, message: 'Behavior fixture resource coverage failed', noWrite: true } },
        resource_ownership: { version: 2, roots: [], errors: [], namespace }, resources_settled_at: null as string | null }
      const runtime = new BehaviorChainRuntime(journal, operations({ readInvocations: async () => parseAgentLogStdout(JSON.stringify([call]), 'resource cause contract') }))
      await runtime.run()
      expect(journal.read(chain.id)!.held).toBe(call.error)
      expect(journal.reservedResources().memoryBytes).toBe(6)
      call.resources_settled_at = new Date().toISOString()
      Object.assign(namespace, { state: 'settled', settled_at: 12 })
      await runtime.run()
      expect(journal.read(chain.id)!.held).toBe(call.error)
      expect(journal.reservedResources().memoryBytes).toBe(0)
      expect(journal.read(chain.id)!.invocations).toHaveLength(1)
      expect(journal.read(chain.id)!.invocations[0].state).toBe('settled')
    })

  it('retains the person Stop intent while cleanup is uncertain and after its later verified release', async () => {
    const { journal, chain } = setup()
    const admitted = { ...invocation('stopped-original', RESERVATION), admittedAt: Date.now() - 3000 }
    record(journal, chain, { type: 'invocation.admitted', invocation: admitted })
    const call = { ...completedReviewCall(chain.repository, chain.issue, 'a'.repeat(40), chain.reviewer),
      behavior: 'issue_review', source: 'poise:behavior-chain', correlation_id: admitted.id, model: admitted.model,
      status: 'failed', error_code: 'stopped', error: 'Stopped by user', action: null, outcome: null,
      head_sha: null, expected_head: null, review_id: null, artifact: null, receipts: null,
      resource_ownership: { version: 1, roots: [], errors: [] }, resources_settled_at: null as string | null }
    const runtime = new BehaviorChainRuntime(journal, operations({ enabled: () => false,
      readInvocations: async () => parseAgentLogStdout(JSON.stringify([call]), 'original Stop resource receipt') }))
    await runtime.run()
    expect(journal.read(chain.id)!.held).toContain('stopped by the person')
    expect(journal.liveModelInvocationCount()).toBe(1)
    call.resources_settled_at = new Date().toISOString()
    await runtime.run()
    expect(journal.read(chain.id)!.held).toContain('stopped by the person')
    expect(journal.liveModelInvocationCount()).toBe(0)
    expect(journal.read(chain.id)!.invocations).toHaveLength(1)
  })

  it('retains a modern unsettled native invocation when its historical Call has no ownership record', async () => {
    const { journal, chain } = setup()
    const admitted = { ...invocation('ownership-missing', RESERVATION), admittedAt: Date.now() - 3000 }
    const current = record(journal, chain, { type: 'invocation.admitted', invocation: admitted })
    record(journal, current, { type: 'invocation.started', invocationId: admitted.id })
    const call = { ...completedReviewCall(chain.repository, chain.issue, 'a'.repeat(40), chain.reviewer),
      behavior: 'issue_review', source: 'poise:behavior-chain', correlation_id: admitted.id, model: admitted.model,
      head_sha: null, expected_head: null, action: 'commented', outcome: 'commented', review_id: null, artifact: null,
      resources_settled_at: new Date().toISOString(),
      receipts: [{ issue: `${chain.repository}#${chain.issue}`, comment_id: 17, author: chain.reviewer, url: null }] }
    await new BehaviorChainRuntime(journal, operations({ enabled: () => false,
      readInvocations: async () => parseAgentLogStdout(JSON.stringify([call]), 'historical ownership unavailable') })).run()
    expect(journal.read(chain.id)!.invocations[0].state).toBe('uncertain')
    expect(journal.liveModelInvocationCount()).toBe(1)
    expect(journal.reservedResources()).toEqual({ ...RESERVATION, unaccounted: 0 })
  })

  it.each([{ resource_error: 'cleanup_failed' }, { phase: 'resources_unknown' }])(
    're-holds contradictory releases already in immutable history: %j', artifact => {
      const { journal, chain } = setup()
      let current = record(journal, chain, { type: 'invocation.admitted', invocation: invocation('historical', RESERVATION) })
      current = record(journal, current, { type: 'invocation.settled', invocationId: 'historical', callId: 'old-call',
        outcome: 'commented', evidence: { status: 'completed', artifact, resources_settled_at: new Date(NOW).toISOString() } })
      record(journal, current, { type: 'chain.merged', mergeSha: 'a'.repeat(40), evidence: { review_complete: true,
        repository: chain.repository, pull_number: 17, merged: true, merge_sha: 'a'.repeat(40) } })
      const history = journal.history(chain.id)
      expect(journal.liveModelInvocationCount()).toBe(1)
      expect(journal.reservedResources()).toEqual({ ...RESERVATION, unaccounted: 0 })
      expect(journal.admitInvocation(journal.read(chain.id)!, 'blocked-next-phase', {
        ...invocation('next-phase'), model: null, slot: null, behavior: 'merge-pr',
        request: { command: 'github-interface', argv: [], cwd: '/fixture' },
      }, 10)).toBeNull()
      journal.rebuild()
      expect(journal.history(chain.id)).toEqual(history)
      expect(journal.liveModelInvocationCount()).toBe(1)
    })

  it('migrates the existing projection index and re-holds contradictions without changing historical evidence', () => {
    const { db, journal, chain } = setup()
    let current = record(journal, chain, { type: 'invocation.admitted', invocation: invocation('old-release', RESERVATION) })
    current = record(journal, current, { type: 'invocation.settled', invocationId: 'old-release', callId: 'old-call', outcome: 'commented',
      evidence: { resources_settled_at: new Date(NOW).toISOString(), artifact: { resource_error: 'cleanup_failed' } } })
    const history = journal.history(chain.id)
    db.exec(`DROP INDEX behavior_chain_reconciliation; DROP INDEX behavior_chain_resource_pending;
      ALTER TABLE behavior_chain_current DROP COLUMN resource_pending;
      CREATE INDEX behavior_chain_reconciliation ON behavior_chain_current(merged, chain_id);`)
    const reopened = new BehaviorChainJournal(db)
    expect(reopened.read(chain.id)).toEqual(current)
    expect(reopened.history(chain.id)).toEqual(history)
    expect(reopened.reservedResources()).toEqual({ ...RESERVATION, unaccounted: 0 })
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='behavior_chain_reconciliation'").get()).toMatchObject({
      sql: expect.stringContaining('resource_pending'),
    })
  })

  it('preserves a person hold when historical resource contradictions are discovered', async () => {
    const { journal, chain } = setup()
    let current = record(journal, chain, { type: 'invocation.admitted', invocation: invocation('old-release', RESERVATION) })
    current = record(journal, current, { type: 'invocation.settled', invocationId: 'old-release', callId: 'old-call', outcome: 'commented',
      evidence: { resources_settled_at: new Date(NOW).toISOString(), artifact: { resource_error: 'cleanup_failed' } } })
    record(journal, current, { type: 'chain.held', reason: 'New invocations held by the person' })
    const observe = vi.fn(async () => { throw new Error('contradiction cannot authorize another GitHub observation') })
    await new BehaviorChainRuntime(journal, operations({ enabled: () => false, observe })).run()
    expect(journal.read(chain.id)).toMatchObject({ held: 'New invocations held by the person',
      waiting: expect.stringContaining('contradictory resource-release evidence') })
    expect(observe).not.toHaveBeenCalled()
    expect(journal.liveModelInvocationCount()).toBe(1)
  })

  it.each([{ phase: 'posted', resource_error: 'cleanup_failed' }, { phase: 'resources_unknown' }])(
    'retains native reservations when release timestamps contradict $phase evidence', async artifact => {
      const { journal, chain } = setup()
      const admitted = { ...invocation('one', RESERVATION), admittedAt: Date.now() - 3000 }
      let current = record(journal, chain, { type: 'invocation.admitted', invocation: admitted })
      record(journal, current, { type: 'invocation.started', invocationId: admitted.id })
      const call = { ...completedReviewCall(chain.repository, chain.issue, 'a'.repeat(40), chain.reviewer),
        behavior: 'issue_review', source: 'poise:behavior-chain', correlation_id: admitted.id, model: admitted.model,
        head_sha: null, expected_head: null, action: 'commented', outcome: 'commented', review_id: null,
        artifact, resources_settled_at: new Date().toISOString(),
        receipts: [{ issue: `${chain.repository}#${chain.issue}`, comment_id: 17, author: chain.reviewer, url: null }] }
      const noAction = vi.fn(async () => { throw new Error('contradictory native resource evidence grants no execution authority') })
      const ops = operations({ enabled: () => false,
        readInvocations: async () => parseAgentLogStdout(JSON.stringify([call]), 'native resource receipt fixture'),
        request: noAction, launch: noAction, perform: noAction, resumePublication: noAction })
      await new BehaviorChainRuntime(journal, ops).run()
      current = journal.read(chain.id)!
      expect(current.invocations[0].state).toBe('uncertain')
      expect(journal.liveModelInvocationCount()).toBe(1)
      expect(journal.reservedResources()).toEqual({ ...RESERVATION, unaccounted: 0 })
      expect(noAction).not.toHaveBeenCalled()
      expect(parseAgentLogStdout(JSON.stringify([call]), 'same retained native receipt').quarantined).toHaveLength(1)
      const events = journal.history(chain.id)
      journal.rebuild()
      expect(journal.history(chain.id)).toEqual(events)
      expect(journal.read(chain.id)).toEqual(current)
    })

  it('waits with an explicit reason and no provider preparation while exhausted, then admits after release', async () => {
    bounded()
    const { journal, chain } = setup()
    let held = seed(journal, 8)
    held = journal.admitInvocation(held, 'admit-held', invocation('held', RESERVATION), 2, BUDGET)!
    held = record(journal, held, { type: 'invocation.uncertain', invocationId: 'held', reason: 'worker ended without proof of release' })
    record(journal, held, { type: 'chain.held', reason: 'held for the test' })
    let prepared = 0
    let launched = 0
    const runtime = new BehaviorChainRuntime(journal, operations({
      request: async () => { prepared++; return { command: 'agent-interface', argv: ['--model', 'fixture-model'], cwd: '/fixture' } },
      launch: async () => { launched++; return true },
    }))
    await runtime.run()
    expect(journal.read(chain.id)).toMatchObject({ waiting: 'shared native resource budget is exhausted: memory needs 12 of 10 bytes',
      invocations: [] })
    expect(prepared).toBe(0)
    expect(launched).toBe(0)
    record(journal, journal.read(held.id)!, { type: 'invocation.settled', invocationId: 'held', callId: 'native',
      outcome: 'commented', evidence: { status: 'completed', resources_settled_at: new Date(NOW).toISOString() } })
    await runtime.run()
    const admitted = journal.read(chain.id)!
    expect(admitted.waiting).toBeNull()
    expect(admitted.invocations).toHaveLength(1)
    expect(admitted.invocations[0]).toMatchObject({ behavior: 'review-issue', state: 'started', reservation: RESERVATION })
    expect(prepared).toBe(1)
    expect(launched).toBe(1)
  })

  it('blocks admission on insufficient or unavailable headroom without consuming attempts', async () => {
    bounded()
    const { journal, chain } = setup()
    const cramped = new BehaviorChainRuntime(journal, operations({
      measureHeadroom: () => ({ freeMemoryBytes: 1, freeDiskBytes: 100, diskPath: '/fixture' }),
      request: async () => { throw new Error('must not prepare a provider while headroom is short') },
    }))
    await cramped.run()
    expect(journal.read(chain.id)).toMatchObject({ waiting: 'insufficient behavior resource headroom: only 1 bytes of free memory for a 6 byte reservation',
      invocations: [] })
    const blind = new BehaviorChainRuntime(journal, operations({
      measureHeadroom: () => { throw new Error('behavior resource measurement unavailable: disk read of /fixture failed: gone') },
      request: async () => { throw new Error('must not prepare a provider without a measurement') },
    }))
    await blind.run()
    expect(journal.read(chain.id)).toMatchObject({
      waiting: 'behavior resource measurement unavailable: disk read of /fixture failed: gone', invocations: [] })
  })

  it('records no reservation and runs no probe when budgets are unset', async () => {
    const { journal, chain } = setup()
    await new BehaviorChainRuntime(journal, operations({
      measureHeadroom: () => { throw new Error('must not probe without a budget') },
    })).run()
    const admitted = journal.read(chain.id)!
    expect(admitted.invocations).toHaveLength(1)
    expect(admitted.invocations[0].reservation).toBeNull()
    expect(admitted.invocations[0].request.argv).toEqual(['--model', 'fixture-model'])
  })
})

describe('spawn-time resource gate', () => {
  const hooks = (overrides = {}) => ({ roster: async () => ({ issueReviewers: [], prReviewers: [], implementer: REVIEWER, repairer: REVIEWER, approver: REVIEWER }),
    resolve: async () => REVIEWER, prepare: async () => ({}), borrow: () => () => {}, available: () => true,
    capacity: () => 3, permitted: () => true, note: () => '', severity: () => 'p2', received: () => {},
    reviews: async () => 'reviews', existing: async () => new Set<string>(), wake: () => {}, ...overrides })
  const nativeInvocation = { id: 'native', request: { command: 'agent-interface', argv: [], cwd: '/w' } } as never

  it('checks the original booking after configuration changes instead of silently increasing the allowance', async () => {
    bounded('100', '60')
    const admission = { ...invocation('original-booking', { memoryBytes: 8, diskBytes: 0 }),
      admissionSequence: 1, state: 'admitted' as const, callId: null, outcome: null, evidence: null }
    const fitting = nativeChainOperations({ login: 'example' } as Organization,
      hooks({ measureHeadroom: () => ({ freeMemoryBytes: 10, freeDiskBytes: 100, diskPath: '/fixture' }) }))
    expect(await fitting.launch(admission, () => {}, () => true)).toBe(true)
  })

  it('defers the spawn without borrowing a slot when headroom is short or unavailable', async () => {
    bounded('100', '60')
    for (const measureHeadroom of [() => ({ freeMemoryBytes: 1, freeDiskBytes: 100, diskPath: '/fixture' }),
      () => { throw new Error('behavior resource measurement unavailable: gone') }]) {
      const borrow = vi.fn(() => () => {})
      const operations = nativeChainOperations({ login: 'example' } as Organization, hooks({ borrow, measureHeadroom }))
      expect(await operations.launch(nativeInvocation, () => {}, () => true)).toBe(false)
      expect(borrow).not.toHaveBeenCalled()
      expect(mocks.spawnDetached).not.toHaveBeenCalled()
    }
  })

  it('spawns normally when headroom fits, and skips every probe when unbounded', async () => {
    bounded('100', '60')
    mocks.spawnDetached.mockResolvedValue(undefined)
    const borrow = vi.fn(() => () => {})
    const fitting = nativeChainOperations({ login: 'example' } as Organization,
      hooks({ borrow, measureHeadroom: () => ({ freeMemoryBytes: 100, freeDiskBytes: 100, diskPath: '/fixture' }) }))
    expect(await fitting.launch(nativeInvocation, () => {}, () => true)).toBe(true)
    expect(borrow).toHaveBeenCalledTimes(1)
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(1)
    vi.unstubAllEnvs()
    const unbounded = nativeChainOperations({ login: 'example' } as Organization,
      hooks({ measureHeadroom: () => { throw new Error('must not probe without a budget') } }))
    expect(await unbounded.launch(nativeInvocation, () => {}, () => true)).toBe(true)
  })
})
