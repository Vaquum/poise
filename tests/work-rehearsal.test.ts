import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { advanceWork, V2_EXECUTION_ENABLED, WORK_OBSERVATION_MAX_AGE_MS } from '../server/work-rehearsal'
import { WorkRehearsal } from '../server/work-rehearsal-store'
import { HEAD, NEXT_HEAD, NOW, pull, receipt, plan, issue } from './fixtures/work-rehearsal'

let root: string | null = null
let db: Database.Database | null = null
afterEach(async () => { db?.close(); db = null; if (root) await rm(root, { recursive: true, force: true }); root = null })

const red = { head: HEAD, pending: false, failing: [{ name: 'unit', state: 'completed', conclusion: 'failure' }] }
const running = { head: HEAD, pending: true, failing: [] }

describe.each(['headless', 'interactive'] as const)('%s work decisions', mode => {
  it('advances Plan to published issue, reviewed revision, PR and confirmed merge', () => {
    const run = (work: ReturnType<typeof pull>) => advanceWork({ ...work, mode }, null, NOW)
    expect(run(plan())).toMatchObject({ kind: 'propose', action: 'create-issue' })
    const opened = issue()
    expect(run(opened)).toMatchObject({ kind: 'propose', action: 'review-issue' })
    if (opened.stage.kind !== 'issue') throw new Error('fixture issue expected')
    opened.stage.reviewedRevision = opened.stage.bodyRevision
    expect(run(opened)).toMatchObject({ kind: 'propose', action: 'implement' })
    opened.stage.bodyRevision = 'body-2'
    expect(run(opened)).toMatchObject({ kind: 'propose', action: 'review-issue' })
    expect(run(pull({ ci: running }))).toEqual({ kind: 'wait', reason: 'CI is running' })
    expect(run(pull({ review: 'needed', reviewedHead: null, approvedHead: null }))).toMatchObject({ kind: 'propose', action: 'review-pr', head: HEAD })
    expect(run(pull({ approvedHead: null }))).toMatchObject({ kind: 'propose', action: 'approve' })
    expect(run(pull())).toMatchObject({ kind: 'propose', action: 'merge', head: HEAD })
    expect(run(pull({ queueEntry: 'MQE_17' }))).toMatchObject({ kind: 'wait' })
    // Retained real artifact: #699's actual merge, not a worker's turn end.
    const retained = pull({ head: 'e360cfc0468a3bb7fc7f550e2a5fe73b91171a82', target: { repo: 'autonomio/poise', kind: 'pull', number: 699,
      url: 'https://github.com/autonomio/poise/pull/699' },
      ci: { head: 'e360cfc0468a3bb7fc7f550e2a5fe73b91171a82', pending: false, failing: [], state: 'closed', merged: true },
      mergeSha: '9feaf4b4bddad83fbd74cd7849b9ce589a355a86' })
    expect(run(retained)).toEqual({ kind: 'complete', reason: 'confirmed merge 9feaf4b4bddad83fbd74cd7849b9ce589a355a86' })
    expect(run({ ...retained, held: true, refusal: 'new admissions paused' }).kind).toBe('complete')
  })

  it.each([
    [pull({ ci: red }), 'repair-ci'],
    [pull({ ci: running, ciStuck: true }), 'repair-stuck-ci'],
    [pull({ ci: running, greyCiEligible: true }), 'rerun-grey-ci'],
    [pull({ ci: { ...running, mergeable: false } }), 'repair-conflicts'],
    [pull({ ci: { ...running, mergeableState: 'behind' } }), 'update-branch'],
    [pull({ review: 'changes' }), 'fix-review'],
    [pull({ unresolved: 2 }), 'resolve-threads'],
    [pull({ reviewedHead: NEXT_HEAD }), 'review-pr'],
  ])('proposes the one required repair without spawning: %s', (work, action) => {
    expect(advanceWork({ ...work, mode }, null, NOW)).toMatchObject({ kind: 'propose', action })
  })

  it('reviews a changed issue body after a finished review of its earlier revision', () => {
    const work = { ...issue(), revision: 2 }
    if (work.stage.kind !== 'issue') throw new Error('fixture issue expected')
    const finished = receipt({ action: 'review-issue', state: 'finished', head: null, issueBodyRevision: 'body-1' })
    expect(advanceWork({ ...work, mode }, finished, NOW).kind).toBe('inspect')
    work.stage.bodyRevision = 'body-2'
    expect(advanceWork({ ...work, mode }, { ...finished, issueBodyRevision: null }, NOW).kind).toBe('inspect')
    expect(advanceWork({ ...work, mode }, finished, NOW)).toMatchObject({ kind: 'propose', action: 'review-issue', issueBodyRevision: 'body-2' })
    work.stage.reviewedRevision = 'body-2'
    expect(advanceWork({ ...work, mode }, finished, NOW)).toMatchObject({ kind: 'propose', action: 'implement' })
  })

  it('retains native merge-queue policy instead of churning behind branches', () => {
    const work = pull({ ci: { head: HEAD, pending: false, failing: [], mergeableState: 'behind' }, mergeQueue: true })
    expect(advanceWork({ ...work, mode }, null, NOW)).toMatchObject({ kind: 'propose', action: 'merge' })
    if (work.stage.kind !== 'pull') throw new Error('fixture pull expected')
    work.stage.mergeQueue = null
    expect(advanceWork(work, null, NOW).kind).toBe('inspect')
    for (const queued of [pull({ ci: red }), pull({ ci: running, ciStuck: true, greyCiEligible: true }),
      pull({ ci: { ...running, mergeable: false } }), pull({ review: 'changes' }), pull({ approvedHead: null })]) {
      if (queued.stage.kind !== 'pull') throw new Error('fixture pull expected')
      queued.stage.queueEntry = 'MQE_17'
      expect(advanceWork({ ...queued, mode }, null, NOW)).toEqual({ kind: 'wait', reason: 'native merge queue MQE_17' })
    }
  })

  it('does not convert missing evidence, closed state, or a finished turn into completion', () => {
    for (const work of [pull({ ci: null }), pull({ ci: { ...running, head: NEXT_HEAD } }),
      pull({ ci: { ...running, state: 'closed', merged: false } }), pull({ unresolved: null }),
      pull({ ready: null }), pull({ mergeSha: 'b'.repeat(40) })]) {
      expect(advanceWork({ ...work, mode }, null, NOW).kind).toBe('inspect')
    }
    const closed = issue()
    if (closed.stage.kind !== 'issue') throw new Error('fixture issue expected')
    closed.stage.closed = true
    expect(advanceWork(closed, null, NOW).kind).toBe('inspect')
    expect(advanceWork(pull(), receipt({ state: 'finished' }), NOW).kind).toBe('inspect')
    expect(advanceWork({ ...pull(), revision: 2 }, receipt({ state: 'finished' }), NOW).kind).toBe('inspect')
    expect(advanceWork({ ...pull({ head: NEXT_HEAD, ci: { ...red, head: NEXT_HEAD } }), revision: 2 }, receipt({ action: 'repair-ci', state: 'finished' }), NOW))
      .toMatchObject({ kind: 'propose', action: 'repair-ci', head: NEXT_HEAD })
  })

  it('keeps v1 ownership, Stop, admission policy and uncertain effects local to their item', () => {
    for (const held of [{ ...pull(), owner: 'v1' as const }, { ...pull(), held: true }, { ...pull(), refusal: 'repository skipped' }]) {
      expect(advanceWork({ ...held, mode }, null, NOW).kind).toBe('wait')
    }
    expect(advanceWork(pull(), receipt(), NOW).kind).toBe('inspect')
    expect(advanceWork(pull(), receipt({ state: 'running' }), NOW).kind).toBe('wait')
    expect(advanceWork(pull(), receipt({ state: 'not-started', retryAt: NOW + 1 }), NOW).kind).toBe('wait')
    expect(advanceWork(pull(), receipt({ state: 'not-started', retryAt: NOW }), NOW).kind).toBe('propose')
    expect(advanceWork({ ...pull(), checkedAt: NOW - WORK_OBSERVATION_MAX_AGE_MS - 1 }, null, NOW).kind).toBe('inspect')
    expect(advanceWork({ ...pull(), id: 'unrelated' }, null, NOW).kind).toBe('propose')
  })
})

it('recovers proposals and action uncertainty from durable receipts after restart, with no execution authority from the observer ledger', async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-rehearsal-'))
  const path = join(root, 'proof.db')
  db = new Database(path)
  let rehearsal = new WorkRehearsal(db)
  const work = plan()
  rehearsal.observe('card:17@1', work)
  const first = rehearsal.propose(work.id, NOW)
  rehearsal.propose(work.id, NOW + 1)
  expect(db.prepare("SELECT COUNT(*) AS n FROM v2_rehearsal_events WHERE kind = 'proposal'").get()).toEqual({ n: 1 })
  rehearsal.importReceipt(work.id, 'receipt:17@1', receipt({ action: 'create-issue', head: null }))
  expect(() => rehearsal.importReceipt(work.id, 'wrong-native-identity', receipt({ action: 'repair-ci' }))).toThrow('identity or settlement conflicts')
  db.close(); db = new Database(path); rehearsal = new WorkRehearsal(db)
  expect(first).toMatchObject({ kind: 'propose', action: 'create-issue' })
  expect(rehearsal.read(work.id)?.observation.stage).toEqual(plan().stage)
  expect(rehearsal.propose(work.id, NOW)).toMatchObject({ kind: 'inspect', reason: expect.stringContaining('uncertain create-issue') })
  expect(() => rehearsal.importReceipt(work.id, 'different', receipt({ attempt: 'duplicate-attempt' }))).toThrow('unsettled attempt')
  // The lossy observer's absence is irrelevant; native receipt recovery still holds.
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'behavior_ledger%'").all()).toEqual([])
  rehearsal.importReceipt(work.id, 'receipt:17@2', receipt({ action: 'create-issue', head: null, state: 'finished' }))
  rehearsal.observe('issue:17@2', { ...issue(), revision: 2 })
  expect(rehearsal.propose(work.id, NOW)).toMatchObject({ kind: 'propose', action: 'review-issue' })
  expect(V2_EXECUTION_ENABLED).toBe(false)
})

it.each([{ basisRevision: 1, at: NOW + 20 }, { basisRevision: 2, at: NOW + 20 }])('retains a late older native receipt without replacing a newer retry deadline after restart: %s', async older => {
  root = await mkdtemp(join(tmpdir(), 'poise-rehearsal-order-'))
  const path = join(root, 'proof.db')
  db = new Database(path)
  let rehearsal = new WorkRehearsal(db)
  const work = { ...pull({ ci: red }), revision: 2 }
  rehearsal.observe('red-head@2', work)
  const newer = receipt({ attempt: 'new-repair', action: 'repair-ci', basisRevision: 2,
    state: 'not-started', requestedAt: NOW + 10, at: NOW + 10, retryAt: NOW + 1000, reference: 'Caller:new-repair' })
  rehearsal.importReceipt(work.id, 'new-repair@1', newer)
  rehearsal.importReceipt(work.id, 'old-review@2', receipt({ attempt: 'old-review', action: 'review-pr',
    state: 'finished', ...older, requestedAt: NOW, reference: 'Caller:old-review' }))
  expect(rehearsal.history(work.id).filter(event => event.kind === 'receipt')).toHaveLength(2)
  db.close(); db = new Database(path); rehearsal = new WorkRehearsal(db)
  expect(rehearsal.read(work.id)?.receipt).toEqual(newer)
  expect(rehearsal.propose(work.id, NOW + 20)).toEqual({ kind: 'wait', reason: `safe no-write retry at ${NOW + 1000}` })
  expect(rehearsal.propose(work.id, NOW + 1000)).toMatchObject({ kind: 'propose', action: 'repair-ci' })
})

it('rejects conflicting replay identities and never changes an imported record', () => {
  db = new Database(':memory:')
  const rehearsal = new WorkRehearsal(db)
  expect(() => rehearsal.observe('x'.repeat(513), pull())).toThrow('oversized')
  rehearsal.observe('recorded:1', pull())
  rehearsal.observe('recorded:1', pull())
  expect(() => rehearsal.observe('recorded:1', { ...pull(), held: true })).toThrow('identity conflicts')
  expect(() => rehearsal.observe('old-revision', pull())).toThrow('revision must advance')
  expect(() => db!.prepare("UPDATE v2_rehearsal_events SET kind = 'changed'").run()).toThrow('immutable')
  expect(() => db!.prepare('DELETE FROM v2_rehearsal_events').run()).toThrow('immutable')
  const raw = db.prepare('SELECT payload FROM v2_rehearsal_events').all()
  expect(raw).toEqual([{ payload: JSON.stringify(pull()) }])
})

it('uses indexed current state with representative retained history and yields without an executor', async () => {
  db = new Database(':memory:')
  const rehearsal = new WorkRehearsal(db)
  db.transaction(() => {
    for (let i = 1; i <= 10_000; i++) rehearsal.observe(`observation:${i}`, { ...pull(), revision: i })
  })()
  const before = db.prepare('SELECT COUNT(*) AS n FROM v2_rehearsal_events').get()
  const timer = vi.fn()
  setTimeout(timer, 0)
  const started = performance.now()
  for (let i = 0; i < 100; i++) {
    rehearsal.propose('work-17', NOW)
    if (i % 10 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  expect(timer).toHaveBeenCalledOnce()
  const elapsedMs = performance.now() - started
  console.info('work rehearsal load', JSON.stringify({ events: 10_000, decisions: 100, elapsedMs }))
  expect(elapsedMs).toBeLessThan(1000)
  expect(before).toEqual({ n: 10_000 })
  expect(db.prepare('SELECT COUNT(*) AS n FROM v2_rehearsal_events').get()).toEqual({ n: 10_001 })
  expect(db.prepare('EXPLAIN QUERY PLAN SELECT observation, receipt FROM v2_rehearsal_current WHERE work_id = ?').all('work-17'))
    .toEqual([expect.objectContaining({ detail: expect.stringContaining('USING INDEX') })])
})
