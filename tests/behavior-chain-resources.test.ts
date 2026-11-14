import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseAgentLogStdout } from '../server/agent-log-parse'
import { BehaviorChainJournal, chainBasis, chainIdentity, type BehaviorChain, type ChainAdmission, type ChainEvent } from '../server/behavior-chain-store'
import { parseResourceOwnership } from '../server/behavior-resource-receipt'
import { BehaviorChainRuntime, type ChainRuntimeOperations } from '../server/behavior-chain-runtime'
import { behaviorChainSummary } from '../server/behavior-chain-summary'
import { BehaviorResourceRecovery } from '../server/behavior-chain-resource-recovery'
import { callerDiagnostic } from '../gateway/src/diagnostics/sources'
import type { ChainObservation } from '../server/behavior-chain-decision'
import type { Organization } from '../server/organizations'
import { completedReviewCall } from './review-response-fixture'

const mocks = vi.hoisted(() => ({ spawnDetached: vi.fn() }))
vi.mock('../server/process', () => ({ runFile: vi.fn(), spawnDetached: mocks.spawnDetached }))
vi.mock('../server/models', () => ({ agentInterfaceCwd: () => '/interface' }))
vi.mock('../server/settings', () => ({ getSettings: () => ({ me: 'author', agentAccount: 'reviewer' }),
  getBehaviorChainSettings: () => ({ enabled: true, seedMode: 'all', label: 'poise' }),
  BEHAVIOR_CHAIN_INTEGRITY_HOLD_KEY: 'behavior_chain_integrity_hold' }))
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
    prerequisites: { wait: null, base: 'a'.repeat(40), evidence: [] },
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
  it('keeps a stale issue review’s ownership until release, then reviews the replacement revision', async () => {
    const { journal, chain } = setup()
    const admitted = invocation('stale-review', RESERVATION)
    record(journal, chain, { type: 'invocation.admitted', invocation: admitted })
    const call = { ...completedReviewCall(chain.repository, chain.issue, 'a'.repeat(40), chain.reviewer),
      behavior: 'issue_review', source: 'poise:behavior-chain', correlation_id: admitted.id, model: admitted.model,
      status: 'failed', error_code: 'issue_revision_changed', error: 'seed issue changed during review; no comments posted',
      action: 'not_started', outcome: 'preflight_failed', head_sha: null, expected_head: null, review_id: null,
      artifact: { phase: 'reviewing', resource_root: '/owned/stale-review' }, receipts: null, issue_revision: 'a'.repeat(64),
      resource_ownership: { version: 1, roots: [], errors: [] }, resources_settled_at: null as string | null }
    const original = structuredClone(call), launch = vi.fn(async () => true)
    const next = observation()
    next.issue.revision = 'b'.repeat(64)
    const runtime = new BehaviorChainRuntime(journal, operations({ launch, observe: async () => next,
      readInvocations: async () => parseAgentLogStdout(JSON.stringify([call]), 'stale issue review') }))
    expect(callerDiagnostic(call, 'local')).toBeNull()
    expect(call).toEqual(original)
    await runtime.run()
    expect(journal.reservedResources()).toEqual({ ...RESERVATION, unaccounted: 0 })
    expect(journal.read(chain.id)!.invocations).toHaveLength(1)
    expect(launch).not.toHaveBeenCalled()
    call.resources_settled_at = new Date().toISOString()
    await runtime.run()
    const current = journal.read(chain.id)!
    expect(current.invocations).toHaveLength(2)
    expect(current.invocations[0]).toMatchObject({ state: 'settled', outcome: 'preflight_failed',
      evidence: { issue_revision: original.issue_revision, resource_ownership: original.resource_ownership,
        resources_settled_at: call.resources_settled_at, error_code: 'issue_revision_changed' } })
    expect(current.invocations[1]).toMatchObject({ behavior: 'review-issue', basis: chainBasis(['issue', next.issue.revision]), state: 'started' })
    expect(launch).toHaveBeenCalledOnce()
    const history = journal.history(chain.id)
    journal.rebuild()
    expect(journal.history(chain.id)).toEqual(history)
    expect(journal.read(chain.id)).toEqual(current)
  })

  it('keeps a stale issue review with ownership cleanup failure visible in Logging', () => {
    const { chain } = setup()
    const call = { ...completedReviewCall(chain.repository, chain.issue, 'a'.repeat(40), chain.reviewer),
      behavior: 'issue_review', source: 'poise:behavior-chain', correlation_id: 'stale-ownership', model: 'fixture-model',
      status: 'failed', error_code: 'issue_revision_changed', error: 'seed issue changed during review; no comments posted',
      action: 'not_started', outcome: 'preflight_failed', head_sha: null, expected_head: null, review_id: null,
      artifact: { phase: 'reviewing', resource_root: '/owned/stale-review' }, receipts: null, issue_revision: 'a'.repeat(64),
      resource_ownership: { version: 1, roots: [], errors: [{ cause: 'deletion denied', path: null, at: 1 }] },
      resources_settled_at: null as string | null }
    expect(callerDiagnostic(call, 'local')).toMatchObject({ level: 'error', message: call.error })
    const feed = { id: call.id, behavior: 'issue_review', status: 'failed', error_code: 'issue_revision_changed',
      action: 'not_started', outcome: 'preflight_failed', error: call.error, ownership_error: 'ownership_failed' }
    expect(callerDiagnostic(feed, 'local')).toMatchObject({ level: 'error', message: call.error })
  })

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
    const blocked = record(journal, seed(journal, 8), { type: 'invocation.admitted', invocation: { ...admitted, id: 'unreadable' } })
    const namespace = { state: 'settled', callId: 'c'.repeat(32), correlation: admitted.id, settled_at: 15,
      controller: { version: 1, instance: 'b'.repeat(32) }, binding: { pid: 4, start: '4', namespace: 'pid:[9]',
        owner: { pid: 2, start: '2' }, holder: { pid: 3, start: '3' },
        epoch: { boot: 'fixture', init_start: '1', namespace_dev: '1', namespace_ino: '9' } } }
    const call = { ...completedReviewCall(chain.repository, chain.issue, 'a'.repeat(40), chain.reviewer), id: 'c'.repeat(32),
      behavior: 'issue_review', source: 'poise:behavior-chain', correlation_id: admitted.id, model: admitted.model,
      action: 'commented', outcome: 'commented', resources_settled_at: new Date(20_000).toISOString(),
      artifact: { phase: 'resources_unknown', resource_error: 'retained cleanup cause', resource_recovered_at: 18 },
      resource_ownership: { version: 2, roots: [], errors: [{ cause: 'resources_unknown', path: null, at: 12, recovered_at: 18 }], namespace } }
    const read = vi.fn(async () => parseAgentLogStdout(JSON.stringify([
      call, { correlation_id: 'unreadable', history_read_error: 'SQLITE_CORRUPT' },
    ]), 'physical-only recovery fixture'))
    const recovery = new BehaviorResourceRecovery(journal, read)
    expect(journal.liveModelInvocationCount()).toBe(2)
    const quarantine = { message: 'native resource receipt unreadable is quarantined', cause: { message: expect.stringContaining('SQLITE_CORRUPT') } }
    await expect(recovery.run()).rejects.toMatchObject(quarantine)
    expect(journal.liveModelInvocationCount()).toBe(1)
    expect(journal.read(blocked.id)).toEqual(blocked)
    const recovered = journal.read(chain.id)!
    expect(recovered.invocations[0]).toMatchObject({ state: before.invocations[0].state, outcome: before.invocations[0].outcome,
      callId: before.invocations[0].callId })
    expect(recovered.held).toBe(before.held)
    expect(recovered.mergeSha).toBe(before.mergeSha)
    expect(recovered.invocations[0].evidence?.artifact).toMatchObject({ phase: 'posting_issue_reviews', plan_sha: 'd'.repeat(64), resource_recovered_at: 18 })
    const history = journal.history(chain.id)
    await expect(recovery.run()).rejects.toMatchObject(quarantine)
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

  it.each(['implement-issue', 'repair-pr'] as const)('holds an explicit %s blocker across cleanup and restart without another worker', async behavior => {
    const { db, journal, chain } = setup()
    const admitted = { ...invocation('blocked-original', RESERVATION), behavior, actor: chain.author, admittedAt: Date.now() - 3000 }
    record(journal, chain, { type: 'invocation.admitted', invocation: admitted })
    const call = { ...completedReviewCall(chain.repository, chain.issue, 'a'.repeat(40), chain.author),
      behavior: behavior.replaceAll('-', '_'), source: 'poise:behavior-chain', correlation_id: admitted.id, model: admitted.model,
      status: 'failed', error_code: 'atomic_work_blocked', error: 'Review requires a product decision',
      action: 'not_started', outcome: 'preflight_failed', head_sha: null,
      expected_head: behavior === 'repair-pr' ? 'a'.repeat(40) : null,
      review_id: null, artifact: { phase: 'executing' }, receipts: null, response: null,
      resource_ownership: { version: 1, roots: [], errors: [] }, resources_settled_at: null as string | null }
    const launch = vi.fn(async () => true)
    const native = operations({ launch,
      readInvocations: async () => parseAgentLogStdout(JSON.stringify([call]), 'explicit blocked work receipt') })
    await new BehaviorChainRuntime(journal, native).run()
    expect(journal.read(chain.id)!.held).toBe(call.error)
    expect(journal.reservedResources().memoryBytes).toBe(6)
    call.resources_settled_at = new Date().toISOString()
    await new BehaviorChainRuntime(journal, native).run()
    expect(journal.read(chain.id)!.held).toBe(call.error)
    expect(journal.reservedResources().memoryBytes).toBe(0)
    expect(journal.read(chain.id)!.invocations).toHaveLength(1)
    expect(journal.read(chain.id)!.invocations[0].state).toBe('settled')
    journal.rebuild()
    await new BehaviorChainRuntime(new BehaviorChainJournal(db), native).run()
    expect(journal.read(chain.id)!.held).toBe(call.error)
    expect(journal.read(chain.id)!.invocations).toHaveLength(1)
    expect(launch).not.toHaveBeenCalled()
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

  it.each(['budget', 'headroom', 'probe'] as const)('records a fresh %s wait after Resume while the resource blocker still holds', async (mode) => {
    bounded()
    const { journal, chain } = setup()
    if (mode === 'budget') {
      let held = seed(journal, 8)
      held = journal.admitInvocation(held, 'admit-held', invocation('held', RESERVATION), 2, BUDGET)!
      held = record(journal, held, { type: 'invocation.uncertain', invocationId: 'held', reason: 'worker ended without proof of release' })
      record(journal, held, { type: 'chain.held', reason: 'held for the test' })
    }
    const measureHeadroom = mode === 'headroom'
      ? () => ({ freeMemoryBytes: 1, freeDiskBytes: 100, diskPath: '/fixture' })
      : mode === 'probe'
        ? () => { throw new Error('behavior resource measurement unavailable: disk read of /fixture failed: gone') }
        : () => ({ freeMemoryBytes: 100, freeDiskBytes: 100, diskPath: '/fixture' })
    const runtime = new BehaviorChainRuntime(journal, operations({ measureHeadroom,
      request: async () => { throw new Error('must not prepare a provider while resources block') } }))
    await runtime.run()
    const reason = mode === 'budget'
      ? 'shared native resource budget is exhausted: memory needs 12 of 10 bytes'
      : mode === 'headroom'
        ? 'insufficient behavior resource headroom: only 1 bytes of free memory for a 6 byte reservation'
        : 'behavior resource measurement unavailable: disk read of /fixture failed: gone'
    expect(journal.read(chain.id)).toMatchObject({ waiting: reason, invocations: [] })
    expect(behaviorChainSummary(journal.read(chain.id)!, journal).waiting).toBe(reason)

    let current = record(journal, journal.read(chain.id)!, { type: 'chain.held', reason: 'person paused it' })
    current = record(journal, current, { type: 'chain.resumed' })
    const boundary = current.resumedAfterSequence
    expect(current.waiting).toBe(reason)
    expect(behaviorChainSummary(current, journal).waiting).toBeNull()
    // A deferred sweep observes without reaching the wait site; renewal must survive it.
    current = record(journal, current, { type: 'chain.observed', observation: { checkedAt: Date.now() } })
    expect(behaviorChainSummary(current, journal).waiting).toBeNull()

    await runtime.run()
    const next = journal.read(chain.id)!
    expect(next.waiting).toBe(reason)
    expect(next.sequence).toBeGreaterThan(boundary)
    const fresh = journal.history(chain.id, boundary).filter(row => {
      const event = JSON.parse(row.payload) as ChainEvent
      return event.type === 'chain.waiting' && event.reason === reason
    })
    expect(fresh).toHaveLength(1)
    expect(behaviorChainSummary(next, journal).waiting).toBe(reason)

    const history = journal.history(chain.id)
    journal.rebuild()
    expect(journal.read(chain.id)).toEqual(next)
    expect(journal.history(chain.id)).toEqual(history)
    expect(behaviorChainSummary(journal.read(chain.id)!, journal).waiting).toBe(reason)
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

  it('reconciles a mid-size ancestor receipt that the parser allows', () => {
    const { journal, chain } = setup()
    let current = record(journal, chain, { type: 'invocation.admitted', invocation: invocation('large-receipt', RESERVATION) })
    // Production ancestor coverage lands between the old 256 KiB journal bound
    // and the 512 KiB receipt bound: ~600 reclaimed roots with long paths.
    const roots = Array.from({ length: 600 }, (_, index) => ({ path: `/isolated/${index}/${'x'.repeat(400)}`,
      state: 'reclaimed' as const, device: '1', inode: `${index + 2}`, parent_device: '1', parent_inode: '3', reclaimed_at: 10 }))
    const receipt = { version: 1 as const, roots, errors: [] }
    const receiptBytes = Buffer.byteLength(JSON.stringify(receipt))
    expect(receiptBytes).toBeGreaterThan(256 * 1024)
    expect(receiptBytes).toBeLessThan(512 * 1024)
    expect(parseResourceOwnership(receipt).roots).toHaveLength(600)
    const settledAt = new Date(NOW).toISOString()
    current = record(journal, current, { type: 'invocation.resources_reconciled', invocationId: 'large-receipt',
      evidence: { resource_ownership: receipt, resources_settled_at: settledAt } })
    expect(current.invocations[0].evidence?.resource_ownership).toEqual(receipt)
    expect(journal.reservedResources()).toEqual({ memoryBytes: 0, diskBytes: 0, unaccounted: 0 })
  })

  it('reconciles a large receipt alongside its retained artifact', () => {
    const { journal, chain } = setup()
    let current = record(journal, chain, { type: 'invocation.admitted', invocation: invocation('large-receipt-artifact', RESERVATION) })
    const retained = { phase: 'posting_issue_reviews', plan_sha: 'd'.repeat(64), padding: 'x'.repeat(32 * 1024) }
    current = record(journal, current, { type: 'invocation.reconciled', invocationId: 'large-receipt-artifact',
      evidence: { artifact: retained } })
    // A valid ~500 KiB receipt plus a permitted 32 KiB artifact exceeds the
    // previous 516 KiB journal bound but must still reconcile.
    const roots = Array.from({ length: 980 }, (_, index) => ({ path: `/isolated/${index}/${'x'.repeat(400)}`,
      state: 'reclaimed' as const, device: '1', inode: `${index + 2}`, parent_device: '1', parent_inode: '3', reclaimed_at: 10 }))
    const receipt = { version: 1 as const, roots, errors: [] }
    const receiptBytes = Buffer.byteLength(JSON.stringify(receipt))
    expect(receiptBytes).toBeGreaterThan(500 * 1024)
    expect(receiptBytes).toBeLessThan(512 * 1024)
    expect(parseResourceOwnership(receipt).roots).toHaveLength(980)
    const settledAt = new Date(NOW).toISOString()
    current = record(journal, current, { type: 'invocation.resources_reconciled', invocationId: 'large-receipt-artifact',
      evidence: { resource_ownership: receipt, resources_settled_at: settledAt,
        artifact: { ...retained, resource_recovered_at: 18 } } })
    expect(current.invocations[0].evidence?.resource_ownership).toEqual(receipt)
    expect(current.invocations[0].evidence?.artifact).toMatchObject({ plan_sha: 'd'.repeat(64), resource_recovered_at: 18 })
    expect(journal.reservedResources()).toEqual({ memoryBytes: 0, diskBytes: 0, unaccounted: 0 })
  })

  it('reconciles a large receipt alongside its artifact and process diagnostics', () => {
    const { journal, chain } = setup()
    let current = record(journal, chain, { type: 'invocation.admitted', invocation: invocation('large-receipt-diagnostic', RESERVATION) })
    // A valid ~500 KiB receipt plus a permitted 120 KiB artifact and 32 KiB
    // stderr exceeds the previous 644 KiB journal bound but must still
    // reconcile and settle through the runtime receipt.
    const roots = Array.from({ length: 970 }, (_, index) => ({ path: `/isolated/${index}/${'x'.repeat(400)}`,
      state: 'reclaimed' as const, device: '1', inode: `${index + 2}`, parent_device: '1', parent_inode: '3', reclaimed_at: 10 }))
    const receipt = { version: 1 as const, roots, errors: [] }
    const receiptBytes = Buffer.byteLength(JSON.stringify(receipt))
    expect(receiptBytes).toBeGreaterThan(500 * 1024)
    expect(receiptBytes).toBeLessThan(512 * 1024)
    expect(parseResourceOwnership(receipt).roots).toHaveLength(970)
    const artifact = { phase: 'posting_issue_reviews', plan_sha: 'd'.repeat(64), padding: 'x'.repeat(120 * 1024) }
    const artifactBytes = Buffer.byteLength(JSON.stringify(artifact))
    expect(artifactBytes).toBeGreaterThan(120 * 1024)
    expect(artifactBytes).toBeLessThan(128 * 1024)
    const diagnostic = { version: 1, source: 'caller', severity: 'error', operation: 'github-interface',
      phase: 'submit', outcome: 'exit', stderr: 'e'.repeat(32 * 1024), stderr_truncated: false, context: {}, filesystem: null }
    const diagnosticBytes = Buffer.byteLength(JSON.stringify(diagnostic))
    expect(diagnosticBytes).toBeGreaterThan(32 * 1024)
    const settledAt = new Date(NOW).toISOString()
    const evidence = { status: 'completed', action: 'commented', outcome: 'commented', artifact, diagnostic,
      resource_ownership: receipt, resources_settled_at: settledAt }
    expect(Buffer.byteLength(JSON.stringify({ type: 'invocation.reconciled', invocationId: 'large-receipt-diagnostic', evidence })))
      .toBeGreaterThan(512 * 1024 + 128 * 1024 + 4 * 1024)
    current = record(journal, current, { type: 'invocation.reconciled', invocationId: 'large-receipt-diagnostic', evidence })
    expect(current.invocations[0].evidence?.resource_ownership).toEqual(receipt)
    expect(journal.reservedResources()).toEqual({ memoryBytes: 0, diskBytes: 0, unaccounted: 0 })
    current = record(journal, current, { type: 'invocation.settled', invocationId: 'large-receipt-diagnostic',
      callId: 'c'.repeat(32), outcome: 'commented', evidence })
    expect(current.invocations[0].state).toBe('settled')
    expect(journal.reservedResources()).toEqual({ memoryBytes: 0, diskBytes: 0, unaccounted: 0 })
  })

  it('reconciles a large receipt alongside escaped process diagnostics', () => {
    const { journal, chain } = setup()
    let current = record(journal, chain, { type: 'invocation.admitted', invocation: invocation('large-receipt-escaped', RESERVATION) })
    // 32 KiB of null bytes escapes to ~192 KiB of JSON, exceeding the previous
    // 692 KiB journal bound alongside a valid receipt and artifact.
    const roots = Array.from({ length: 970 }, (_, index) => ({ path: `/isolated/${index}/${'x'.repeat(400)}`,
      state: 'reclaimed' as const, device: '1', inode: `${index + 2}`, parent_device: '1', parent_inode: '3', reclaimed_at: 10 }))
    const receipt = { version: 1 as const, roots, errors: [] }
    const receiptBytes = Buffer.byteLength(JSON.stringify(receipt))
    expect(receiptBytes).toBeGreaterThan(500 * 1024)
    expect(receiptBytes).toBeLessThan(512 * 1024)
    expect(parseResourceOwnership(receipt).roots).toHaveLength(970)
    const artifact = { phase: 'posting_issue_reviews', plan_sha: 'd'.repeat(64), padding: 'x'.repeat(120 * 1024) }
    const artifactBytes = Buffer.byteLength(JSON.stringify(artifact))
    expect(artifactBytes).toBeGreaterThan(120 * 1024)
    expect(artifactBytes).toBeLessThan(128 * 1024)
    const diagnostic = { version: 1, source: 'caller', severity: 'error', operation: 'github-interface',
      phase: 'submit', outcome: 'exit', stderr: '\u0000'.repeat(32 * 1024), stderr_truncated: false, context: {}, filesystem: null }
    const diagnosticBytes = Buffer.byteLength(JSON.stringify(diagnostic))
    expect(diagnosticBytes).toBeGreaterThan(150 * 1024)
    const settledAt = new Date(NOW).toISOString()
    const evidence = { status: 'completed', action: 'commented', outcome: 'commented', artifact, diagnostic,
      resource_ownership: receipt, resources_settled_at: settledAt }
    expect(Buffer.byteLength(JSON.stringify({ type: 'invocation.reconciled', invocationId: 'large-receipt-escaped', evidence })))
      .toBeGreaterThan(512 * 1024 + 128 * 1024 + 32 * 1024 + 4 * 1024)
    current = record(journal, current, { type: 'invocation.reconciled', invocationId: 'large-receipt-escaped', evidence })
    expect(current.invocations[0].evidence?.resource_ownership).toEqual(receipt)
    expect(journal.reservedResources()).toEqual({ memoryBytes: 0, diskBytes: 0, unaccounted: 0 })
    current = record(journal, current, { type: 'invocation.settled', invocationId: 'large-receipt-escaped',
      callId: 'c'.repeat(32), outcome: 'commented', evidence })
    expect(current.invocations[0].state).toBe('settled')
    expect(journal.reservedResources()).toEqual({ memoryBytes: 0, diskBytes: 0, unaccounted: 0 })
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
