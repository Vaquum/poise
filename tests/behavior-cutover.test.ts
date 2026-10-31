import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BehaviorChainJournal } from '../server/behavior-chain-store'
import { advanceBehaviorCutover } from '../server/behavior-cutover'
import { behaviorBackgroundBusy, releaseBackgroundBusy, trackReleaseBackground } from '../server/release-background'

const databases: Database.Database[] = []
afterEach(() => { for (const db of databases.splice(0)) db.close() })
function setup() {
  const db = new Database(':memory:'); databases.push(db)
  return { db, journal: new BehaviorChainJournal(db) }
}

describe('durable behavior cutover', () => {
  it('reuses the release settlement counter without counting unrelated background work as behavior work', () => {
    const release = trackReleaseBackground()
    const behavior = trackReleaseBackground('behavior')
    try {
      expect(releaseBackgroundBusy()).toBe(2)
      expect(behaviorBackgroundBusy()).toBe(1)
      behavior(); behavior()
      expect(behaviorBackgroundBusy()).toBe(0)
      expect(releaseBackgroundBusy()).toBe(1)
    } finally { behavior(); release() }
  })

  it('retains the ownership boundary across journal replacement and projection rebuild without inventing a chain', async () => {
    const { db, journal } = setup()
    const drain = journal.changeAdmission(0, 'draining', [], 100)
    expect(new BehaviorChainJournal(db).cutover()).toEqual(drain)
    await advanceBehaviorCutover(journal, async () => ['Example/Repo#9', 'example/repo#9', 'other/repo#10'], () => [])
    const committed = journal.cutover()
    expect(committed).toMatchObject({ mode: 'v2', requestedAt: 100, legacyPulls: ['example/repo#9', 'other/repo#10'] })
    journal.rebuild(); journal.verifyProjection()
    expect(new BehaviorChainJournal(db).cutover()).toEqual(committed)
    expect(journal.page()).toEqual([])
    expect(() => journal.changeAdmission(drain.sequence, 'v1')).toThrow('changed')
    expect(() => journal.changeAdmission(committed.sequence, 'v1')).toThrow('transition')
    expect(() => db.prepare('DELETE FROM behavior_chain_events').run()).toThrow('immutable')
  })

  it.each(['native worker still running', 'Caller activity is unreadable', 'behavior preparation still settling'])('refuses completion with %s', async (reason) => {
    const { journal } = setup()
    journal.changeAdmission(0, 'draining')
    const discover = vi.fn(async () => ['example/repo#9'])
    await advanceBehaviorCutover(journal, discover, () => [reason])
    expect(discover).not.toHaveBeenCalled()
    expect(journal.cutover().mode).toBe('draining')
  })

  it('rechecks the barrier after asynchronous discovery and never commits after cancellation', async () => {
    const { journal } = setup()
    journal.changeAdmission(0, 'draining')
    let busy = false
    await advanceBehaviorCutover(journal, async () => { busy = true; return ['example/repo#9'] }, () => busy ? ['newly observed native work'] : [])
    expect(journal.cutover().mode).toBe('draining')
    await advanceBehaviorCutover(journal, async () => {
      journal.changeAdmission(journal.cutover().sequence, 'v1')
      return ['example/repo#9']
    }, () => [])
    expect(journal.cutover().mode).toBe('v1')
  })

  it('retains the drain on incomplete discovery or failed settings commit', async () => {
    const { journal } = setup()
    const before = journal.changeAdmission(0, 'draining')
    await expect(advanceBehaviorCutover(journal, async () => { throw new Error('incomplete PR page') }, () => [])).rejects.toThrow('incomplete')
    await expect(advanceBehaviorCutover(journal, async () => [], () => [], () => { throw new Error('write failed') })).rejects.toThrow('write failed')
    expect(journal.cutover()).toEqual(before)
  })

  it('fences a late seed admission and a prepared invocation transactionally', () => {
    const { journal } = setup()
    const seed = { type: 'chain.admitted' as const, repository: 'example/repo', issue: 7, branch: 'poise/issue-7', author: 'author', reviewer: 'reviewer' }
    const chain = journal.append('example/repo#7', 'seed', 0, seed)
    journal.changeAdmission(0, 'draining')
    expect(() => journal.append('example/repo#8', 'late', 0, { ...seed, issue: 8 })).toThrow('draining')
    expect(journal.admitInvocation(chain, 'prepared', { id: 'prepared', behavior: 'implement-issue', basis: 'basis', actor: 'author', model: 'fixture', slot: 'primary',
      admittedAt: 100, request: { command: 'agent-interface', argv: [], cwd: '/fixture' } }, 3)).toBeNull()
    expect(journal.read(chain.id)?.invocations).toEqual([])
  })
})
