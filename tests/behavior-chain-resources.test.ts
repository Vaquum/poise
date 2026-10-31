import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BehaviorChainJournal, chainBasis, chainIdentity, type BehaviorChain, type ChainAdmission, type ChainEvent } from '../server/behavior-chain-store'
import { BehaviorChainRuntime, type ChainRuntimeOperations } from '../server/behavior-chain-runtime'
import type { ChainObservation } from '../server/behavior-chain-decision'
import type { Organization } from '../server/organizations'

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
    wake: () => {}, ...overrides }
}
function bounded(memory = '10', reservation = '6'): void {
  vi.stubEnv('POISE_BEHAVIOR_MEMORY_BUDGET_BYTES', memory)
  vi.stubEnv('POISE_BEHAVIOR_MEMORY_RESERVATION_BYTES', reservation)
}

describe('durable behavior resource reservations', () => {
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
      evidence: { resources_settled_at: new Date(NOW).toISOString() } })
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
  })
})

describe('spawn-time resource gate', () => {
  const hooks = (overrides = {}) => ({ roster: async () => ({ issueReviewers: [], prReviewers: [], implementer: REVIEWER, repairer: REVIEWER, approver: REVIEWER }),
    resolve: async () => REVIEWER, prepare: async () => ({}), borrow: () => () => {}, available: () => true,
    capacity: () => 3, permitted: () => true, note: () => '', severity: () => 'p2', received: () => {},
    reviews: async () => 'reviews', existing: async () => new Set<string>(), wake: () => {}, ...overrides })
  const nativeInvocation = { id: 'native', request: { command: 'agent-interface', argv: [], cwd: '/w' } } as never

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
