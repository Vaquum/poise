import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BehaviorLedgerStore } from '../server/behavior-ledger-store'
import { LedgerError, type LedgerAdmission, type LedgerCaller, type LedgerOutcome, type LedgerPolicy, type LedgerRecord } from '../server/behavior-ledger-contract'

const roots: string[] = []
const stores: BehaviorLedgerStore[] = []
let clock = Date.parse('2026-10-19T10:00:00.000Z')
const head = 'a'.repeat(40)
const stamp = () => new Date(clock).toISOString()
function store(policy: Partial<LedgerPolicy> = {}, path?: string): BehaviorLedgerStore {
  if (!path) {
    const root = mkdtempSync(join(tmpdir(), 'poise-ledger-store-'))
    roots.push(root)
    path = join(root, 'behavior-ledger.db')
  }
  const value = new BehaviorLedgerStore(path, policy, () => clock)
  stores.push(value)
  return value
}
function admission(nativeId = 'claim-1', extra: Partial<LedgerAdmission> = {}): LedgerAdmission {
  return { type: 'admit', nativeId, admissionKey: 'native-panel:acme/project#7', behavior: 'review-new-prs', source: 'poise:review-new-prs',
    owner: 'acme', actor: 'review-bot', repository: 'acme/project', number: 7, head,
    slot: 'primary', plannedSlots: ['primary'], startedAt: stamp(), ...extra }
}
function caller(nativeId = 'claim-1', extra: Partial<LedgerCaller> = {}): LedgerCaller {
  return { type: 'caller', nativeId, callId: 'b'.repeat(32), repository: 'acme/project', number: 7,
    actor: 'review-bot', source: 'poise:review-new-prs', behavior: 'pr_review', expectedHead: head,
    head, status: 'completed', action: 'reviewed_clean', outcome: 'clean', startedAt: stamp(), completedAt: stamp(), ...extra }
}
function records(db: BehaviorLedgerStore): LedgerRecord[] {
  const page = db.read({ operation: 'list', limit: 100 })
  expect(page.status).toBe(200)
  return page.body.records!
}
function complete(db: BehaviorLedgerStore, nativeId: string, outcome: LedgerOutcome = 'clean'): void {
  db.capture({ type: 'result', nativeId, state: 'completed', activity: 'settled', outcome, completedAt: stamp() })
}
function direct(db: BehaviorLedgerStore, nativeId: string, outcome: LedgerOutcome = 'not_ready'): void {
  db.capture(admission(nativeId, { admissionKey: nativeId, behavior: 'merge-prs', source: 'poise:merge-prs', plannedSlots: [], slot: undefined }))
  complete(db, nativeId, outcome)
}

afterEach(() => {
  for (const db of stores.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  clock = Date.parse('2026-10-19T10:00:00.000Z')
})

describe('behavior firing ledger store', () => {
  it('answers reads without scanning retained history or adding timing to the body', () => {
    const db = store()
    db.capture(admission())
    complete(db, 'claim-1')
    const before = db.budgetScanMs
    for (const request of [{ operation: 'health' }, { operation: 'list', limit: 50 }] as const) {
      const reply = db.read(request)
      expect(reply.status).toBe(200)
      expect(reply.body).not.toHaveProperty('timing')
    }
    db.pending()
    expect(db.budgetScanMs).toBe(before)
  })

  it('keeps usage and pending exact while trimming at the caps', () => {
    const db = store({ maxInstances: 6, maxChanges: 20, maxBytes: 16384 })
    for (let i = 0; i < 8; i++) { db.capture(admission('cap-' + i, { admissionKey: 'cap-' + i })); complete(db, 'cap-' + i) }
    db.capture(admission('open-1', { admissionKey: 'open-1' }))
    const check = new Database(db.path, { readonly: true })
    try {
      const instances = check.prepare('SELECT count(*) AS n FROM ledger_instances').get() as { n: number }
      const changes = check.prepare('SELECT count(*) AS n FROM ledger_changes').get() as { n: number }
      expect(db.health()).toMatchObject({ instances: instances.n, changes: changes.n })
      const rows = check.prepare('SELECT native_id AS nativeId, payload FROM ledger_instances WHERE native_id IS NOT NULL').all() as { nativeId: string; payload: string }[]
      const expected = rows.flatMap(({ nativeId, payload }) => {
        const record = JSON.parse(payload) as LedgerRecord
        return ['resolve-unblocking', 'merge-prs', 'rerun-grey-ci'].includes(record.behavior)
          || (record.activity === 'settled' && ['completed', 'failed', 'superseded'].includes(record.state)) ? [] : [nativeId]
      })
      expect(db.pending().map((row) => row.nativeId).sort()).toEqual(expected.sort())
    } finally { check.close() }
    expect(db.health()).toMatchObject({ status: 'ok', dropped: 0, gaps: [] })
  })

  it('groups delayed siblings and retry attempts through the explicit admission, preserving the original plan', () => {
    const db = store()
    db.capture(admission('primary-1', { plannedSlots: ['primary', 'secondary'] }))
    complete(db, 'primary-1')
    const root = records(db).find((record) => record.kind === 'firing')!
    expect(root).toMatchObject({ state: 'pending', activity: 'unknown', head: null, plannedSlots: ['primary', 'secondary'] })
    db.capture(admission('secondary-1', { slot: 'secondary', plannedSlots: ['primary', 'secondary', 'tertiary'] }))
    db.capture(caller('secondary-1', { callId: 'c'.repeat(32), status: 'running', action: null, outcome: null, completedAt: null }))
    expect(records(db)[0]).toMatchObject({ id: root.id, state: 'running', activity: 'running', plannedSlots: ['primary', 'secondary'] })
    db.capture({ type: 'result', nativeId: 'secondary-1', state: 'failed', activity: 'settled' })
    expect(records(db)[0].state).toBe('failed')
    db.capture(admission('secondary-2', { slot: 'secondary', actor: 'replacement-bot', plannedSlots: ['primary', 'secondary'] }))
    complete(db, 'secondary-2')
    expect(records(db)[0]).toMatchObject({ id: root.id, state: 'completed' })
    expect(db.read({ operation: 'list', parent: root.id }).body.records).toHaveLength(3)
    expect(records(db).at(-1)?.actor).toBe('replacement-bot')
  })

  it('keeps native settlement authoritative over passive Caller projection and excludes historical rows', () => {
    const db = store()
    db.capture(caller('unknown-history'))
    expect(records(db)).toEqual([])
    db.capture(admission())
    db.capture({ type: 'result', nativeId: 'claim-1', state: 'unknown', activity: 'unknown', stateSource: 'native' })
    db.capture(caller())
    expect(records(db)[0]).toMatchObject({ state: 'completed', stateSource: 'caller_observed', activity: 'settled' })
    db.capture({ type: 'result', nativeId: 'claim-1', state: 'held', activity: 'unknown', stateSource: 'native' })
    db.capture(caller())
    expect(records(db)[0]).toMatchObject({ state: 'held', stateSource: 'native', activity: 'unknown' })
  })

  it('preserves native terminal state, activity and outcome when a delayed Caller row arrives', () => {
    const db = store()
    db.capture(admission())
    complete(db, 'claim-1')
    const settled = records(db)
    db.capture(caller('claim-1', { status: 'running', action: null, outcome: null, completedAt: null }))
    expect(records(db)).toEqual(settled)
    db.capture(caller('claim-1', { uncertain: true, status: 'running', action: null, outcome: null, completedAt: null, mayRun: true }))
    expect(records(db)).toEqual(settled)
    expect(records(db)[0]).toMatchObject({ state: 'completed', activity: 'settled', outcome: 'clean', stateSource: 'native' })
  })

  it('starts a new-head retry without inheriting the previous verdict or passive state source', () => {
    const db = store()
    db.capture(admission())
    db.capture(caller())
    const prior = records(db)[0]
    expect(prior).toMatchObject({ state: 'completed', outcome: 'clean', stateSource: 'caller_observed' })
    const nextHead = 'c'.repeat(40)
    db.capture(admission('claim-2', { head: nextHead }))
    const current = records(db)
    expect(current[0]).toMatchObject({ id: prior.id, state: 'pending', outcome: null, stateSource: 'native', head: nextHead, completedAt: null })
    expect(current.at(-1)).toMatchObject({ kind: 'attempt', state: 'pending', outcome: null, stateSource: 'native', head: nextHead, completedAt: null,
      refs: [{ kind: 'correlation', identity: 'claim-2', availability: 'available' }] })
  })

  it('uses the latest actual selected-slot completion rather than the latest admission timestamp', () => {
    const db = store()
    db.capture(admission('primary-1', { plannedSlots: ['primary', 'secondary'] }))
    clock += 1000
    db.capture(admission('secondary-1', { slot: 'secondary', plannedSlots: ['primary', 'secondary'] }))
    clock += 1000
    complete(db, 'secondary-1')
    const secondaryCompleted = stamp()
    clock += 1000
    complete(db, 'primary-1')
    const root = records(db)[0]
    expect(root).toMatchObject({ state: 'completed', activity: 'settled', completedAt: stamp() })
    expect(root.completedAt).not.toBe(secondaryCompleted)
  })

  it('does not project unrelated Caller evidence onto a direct invocation', () => {
    const db = store()
    db.capture(admission('direct-1', { admissionKey: 'direct-1', behavior: 'merge-prs', source: 'poise:merge-prs', plannedSlots: [], slot: undefined }))
    const active = records(db)
    db.capture(caller('direct-1', { source: 'poise:merge-prs', status: 'running', action: null, outcome: null, completedAt: null }))
    expect(records(db)).toEqual(active)
    expect(records(db)[0]).toMatchObject({ state: 'running', activity: 'running', stateSource: 'native' })
  })

  it('does not mistake target similarity or conflicting provenance for authoritative completion', () => {
    const db = store()
    db.capture(admission())
    db.capture(caller('claim-1', { source: 'poise:replay' }))
    expect(records(db)[0]).toMatchObject({ state: 'unknown', activity: 'unknown' })
    db.capture(caller('claim-1', { uncertain: true, status: 'running', action: null, outcome: null, completedAt: null, mayRun: true }))
    expect(records(db)[0]).toMatchObject({ state: 'unknown', activity: 'running' })
    db.capture(caller('claim-1', { interrupted: true }))
    expect(records(db)[0]).toMatchObject({ state: 'unknown', activity: 'unknown' })
  })

  it('retains no-write direct invocations and gives repeated manual/replays independent identities', () => {
    const db = store()
    direct(db, 'direct-1')
    direct(db, 'direct-2')
    db.capture(admission('manual-1', { admissionKey: 'manual-1', source: 'poise:manual-review' }))
    db.capture(admission('replay-1', { admissionKey: 'replay-1', source: 'poise:replay' }))
    const firings = records(db).filter((record) => record.kind === 'firing')
    expect(new Set(firings.map((record) => record.id)).size).toBe(4)
    expect(firings.slice(0, 2).map((record) => record.outcome)).toEqual(['not_ready', 'not_ready'])
    expect(firings.every((record) => /^[a-f0-9]{64}$/.test(record.id) && record.replayOf === null)).toBe(true)
  })

  it('keeps exact review requests completed and PR-lifetime supersession pending for a later launch', () => {
    const db = store()
    db.capture(admission())
    db.capture(caller('claim-1', { action: 'requested_changes', outcome: 'changes_requested' }))
    expect(records(db)[0]).toMatchObject({ state: 'completed', outcome: 'changes_requested' })
    db.capture(admission('claim-2'))
    db.capture({ type: 'result', nativeId: 'claim-2', state: 'superseded', activity: 'settled', outcome: 'superseded' })
    expect(records(db)[0].state).toBe('pending')
  })

  it('selects retained roots and attempts by GitHub target without scanning unrelated work', () => {
    const db = store()
    db.capture(admission('target-1', { admissionKey: 'target-1', repository: 'acme/project', number: 7 }))
    db.capture(admission('other-number', { admissionKey: 'other-number', repository: 'acme/project', number: 8 }))
    db.capture(admission('other-repo', { admissionKey: 'other-repo', repository: 'other/project', number: 7 }))
    db.capture(admission('mixed-case', { admissionKey: 'mixed-case', repository: 'Acme/Project', number: 7 }))
    complete(db, 'target-1')
    const page = db.read({ operation: 'list', repository: 'acme/project', number: 7, limit: 100 })
    expect(page.status).toBe(200)
    expect(page.body.records).toHaveLength(4)
    expect(page.body.records!.every((record) => record.target.repository.toLowerCase() === 'acme/project' && record.target.number === 7)).toBe(true)
    expect(new Set(page.body.records!.map((record) => record.target.repository))).toEqual(new Set(['acme/project', 'Acme/Project']))
    expect(new Set(page.body.records!.map((record) => record.kind))).toEqual(new Set(['firing', 'attempt']))
    expect(page.body.health).toMatchObject({ status: 'ok' })
    const missing = db.read({ operation: 'list', repository: 'acme/project', number: 999, limit: 100 })
    expect(missing.status).toBe(200)
    expect(missing.body.records).toEqual([])
    expect(missing.body.health).toMatchObject({ status: 'ok' })
    const first = db.read({ operation: 'list', repository: 'acme/project', number: 7, limit: 1 }).body
    expect(first.records).toHaveLength(1)
    expect(first.nextCursor).toEqual(expect.any(String))
    const rest = db.read({ operation: 'list', repository: 'acme/project', number: 7, cursor: first.nextCursor!, limit: 100 })
    expect(rest.status).toBe(200)
    expect(rest.body.records).toHaveLength(3)
    expect(db.read({ operation: 'list', repository: 'acme/project', number: 8, cursor: first.nextCursor!, limit: 100 }).status).toBe(400)
    expect(db.read({ operation: 'list', cursor: first.nextCursor!, limit: 100 }).status).toBe(400)
    const root = page.body.records!.find((record) => record.kind === 'firing')!
    expect(db.read({ operation: 'list', parent: root.id, repository: 'acme/project', number: 7 }).body.records).toHaveLength(1)
    expect(db.read({ operation: 'list', parent: root.id, repository: 'acme/project', number: 8 }).body.records).toEqual([])
    expect(db.read({ operation: 'list', repository: 'acme/project' }).status).toBe(400)
    expect(db.read({ operation: 'list', number: 7 }).status).toBe(400)
    expect(db.read({ operation: 'list', repository: 'not a repo', number: 7 }).status).toBe(400)
    expect(db.read({ operation: 'list', repository: 'acme/project', number: 0 }).status).toBe(400)
  })

  it('freezes listing boundaries and uses record revisions to reconcile interleaved updates', () => {
    const db = store()
    db.capture(admission())
    const first = db.read({ operation: 'list', limit: 1 }).body
    db.capture(admission('second-firing', { admissionKey: 'second-panel', number: 8 }))
    complete(db, 'claim-1')
    const rest = db.read({ operation: 'list', cursor: first.nextCursor!, limit: 100 }).body
    expect(rest.records).toHaveLength(1)
    expect(rest.watermark).toBe(first.watermark)
    const updates = db.read({ operation: 'changes', cursor: first.watermark! }).body
    expect(updates.changes?.some((change) => change.op === 'upsert' && change.record.state === 'completed')).toBe(true)
    expect(updates.changes?.every((change) => change.sequence > first.health.lastSequence!)).toBe(true)
    expect(db.read({ operation: 'changes', cursor: updates.nextCursor! }).body.changes).toEqual([])
  })

  it('validates cursor kind, parent binding, signature, generation and retained lower bounds', () => {
    const db = store({ maxChanges: 5 })
    const beginning = db.read({ operation: 'list' }).body.watermark!
    db.capture(admission())
    const first = db.read({ operation: 'list', limit: 1 }).body
    expect(db.read({ operation: 'changes', cursor: first.nextCursor! }).status).toBe(400)
    expect(db.read({ operation: 'list', cursor: first.nextCursor!, parent: first.records![0].id }).status).toBe(400)
    const [payload, signature] = first.watermark!.split('.')
    expect(db.read({ operation: 'changes', cursor: payload + '.' + (signature.startsWith('a') ? 'b' : 'a') + signature.slice(1) }).status).toBe(400)
    const foreign = store().read({ operation: 'list' }).body.watermark!
    expect(db.read({ operation: 'changes', cursor: foreign }).status).toBe(410)
    direct(db, 'direct-1'); direct(db, 'direct-2')
    expect(db.read({ operation: 'changes', cursor: beginning })).toMatchObject({ status: 410, body: { error: 'resync_required' } })
  })

  it('emits bounded removals and expires lookup only while a removal remains retained', () => {
    const db = store({ maxInstances: 2 })
    direct(db, 'first')
    const first = db.read({ operation: 'list' }).body
    direct(db, 'second')
    const removed = db.read({ operation: 'changes', cursor: first.watermark! })
    expect(removed.body.changes?.filter((change) => change.op === 'remove')).toHaveLength(2)
    expect(db.read({ operation: 'get', id: first.records![0].id }).status).toBe(410)
    expect(db.health().instances).toBe(2)
    expect(db.read({ operation: 'get', id: 'f'.repeat(64) }).status).toBe(404)
  })

  it('prunes repetitive direct no-ops before active panel work', () => {
    const db = store({ maxInstances: 4 })
    db.capture(admission())
    const panel = records(db)[0].id
    direct(db, 'poll-1')
    direct(db, 'poll-2')
    expect(db.read({ operation: 'get', id: panel }).status).toBe(200)
    expect(db.health().instances).toBeLessThanOrEqual(4)
    expect(records(db).filter((record) => record.behavior === 'merge-prs' && record.kind === 'firing')).toHaveLength(1)
  })

  it('retains a confirmed enqueue write ahead of waiting observations under pressure', () => {
    const db = store({ maxInstances: 4 })
    direct(db, 'enqueue-1', 'enqueued')
    direct(db, 'observe-1', 'waiting')
    direct(db, 'observe-2', 'waiting')
    const firings = records(db).filter((record) => record.behavior === 'merge-prs' && record.kind === 'firing')
    expect(firings.map((record) => record.outcome).sort()).toEqual(['enqueued', 'waiting'])
    expect(db.health().instances).toBeLessThanOrEqual(4)
  })

  it('accepts a queue entry reference on an enqueue result', () => {
    const db = store()
    db.capture(admission('enqueue-1', { admissionKey: 'enqueue-1', behavior: 'merge-prs', source: 'poise:merge-prs', plannedSlots: [], slot: undefined }))
    db.capture({ type: 'result', nativeId: 'enqueue-1', state: 'completed', activity: 'settled', outcome: 'enqueued',
      refs: [{ kind: 'queue', identity: 'MQE_1', availability: 'available' }], completedAt: stamp() })
    const root = records(db).find((record) => record.kind === 'firing')!
    const attempts = db.read({ operation: 'list', parent: root.id }).body.records!
    expect(attempts.at(-1)?.refs).toContainEqual({ kind: 'queue', identity: 'MQE_1', availability: 'available' })
  })

  it('caps old attempts without coalescing identities or deleting the latest slot attempt', () => {
    const db = store({ maxAttempts: 3 })
    for (let i = 0; i < 6; i++) { db.capture(admission('attempt-' + i)); complete(db, 'attempt-' + i) }
    const all = records(db)
    expect(all).toHaveLength(4)
    expect(all[0]).toMatchObject({ omittedAttempts: 3, state: 'completed' })
    expect(new Set(all.map((record) => record.id)).size).toBe(4)
  })

  it('does not extend retention through heartbeats and keeps settled terminal evidence settled', () => {
    const db = store({ retentionMs: 1000 })
    db.capture(admission()); complete(db, 'claim-1')
    clock += 900
    db.capture({ type: 'heartbeat' })
    expect(records(db)[0].activity).toBe('settled')
    clock += 200
    db.capture({ type: 'heartbeat' })
    expect(records(db)).toEqual([])
    expect(db.health().gaps).toEqual([])
  })

  it('separates capture freshness from old source evidence without polling Caller', () => {
    const db = store()
    db.capture(admission())
    db.capture(caller('claim-1', { status: 'running', completedAt: null, action: null, outcome: null }))
    clock += 125_001
    expect(db.health().status).toBe('stale')
    db.capture({ type: 'heartbeat' })
    expect(db.health().status).toBe('ok')
    expect(db.health().callerObservedAt).not.toBe(db.health().observedAt)
    expect(records(db)[0]).toMatchObject({ state: 'running', activity: 'unknown' })
  })

  it('rejects oversized identities and excludes arbitrary extra content from retained payloads', () => {
    const db = store()
    const input = { ...admission(), prompt: 'must never enter storage', stderr: 'also forbidden' }
    db.capture(input)
    expect(JSON.stringify(records(db))).not.toContain('must never')
    const invalid = () => db.capture(admission('bad', { admissionKey: 'x'.repeat(1025) }))
    expect(invalid).toThrow(LedgerError)
    try { invalid(); expect.unreachable() } catch (error) { expect((error as LedgerError).status).toBe(400) }
    expect(db.health()).toMatchObject({ status: 'ok', dropped: 0 })
    expect(records(db)).toHaveLength(2)
  })

  it('fails contested writes immediately as retryable and keeps committed evidence', () => {
    const db = store()
    db.capture(admission())
    const blocking = new Database(db.path)
    blocking.pragma('busy_timeout = 0')
    blocking.exec('BEGIN EXCLUSIVE')
    try {
      const before = Date.now()
      const contended = () => db.capture(admission('blocked', { admissionKey: 'blocked' }))
      expect(contended).toThrow()
      try { contended(); expect.unreachable() } catch (error) { expect(error).not.toBeInstanceOf(LedgerError) }
      expect(Date.now() - before).toBeLessThan(200)
      expect(db.read({ operation: 'health' }).status).toBe(200)
    } finally { blocking.exec('ROLLBACK'); blocking.close() }
    expect(db.health().dropped).toBe(0)
    expect(records(db)).toHaveLength(2)
    const check = new Database(db.path, { readonly: true })
    try {
      expect(db.health()).toMatchObject({
        instances: (check.prepare('SELECT count(*) AS n FROM ledger_instances').get() as { n: number }).n,
        changes: (check.prepare('SELECT count(*) AS n FROM ledger_changes').get() as { n: number }).n,
      })
    } finally { check.close() }
  })

  it('retains generation and identifiers on clean restart and exposes an unclean epoch', () => {
    const db = store()
    direct(db, 'done')
    const before = records(db)
    const generation = db.health().generation
    db.close()
    const reopened = store({}, db.path)
    expect(records(reopened).map((record) => record.id)).toEqual(before.map((record) => record.id))
    expect(reopened.health()).toMatchObject({ status: 'ok', generation })
    reopened.close()
    const journal = JSON.parse(readFileSync(db.path + '.coverage.json', 'utf8')) as { closed: boolean }
    journal.closed = false
    writeFileSync(db.path + '.coverage.json', JSON.stringify(journal))
    const unclean = store({}, db.path)
    expect(unclean.health()).toMatchObject({ status: 'incomplete', gaps: [expect.objectContaining({ reason: 'unclean_restart' })] })
  })

  it('exposes replacement of a previously covered store and starts a new coverage boundary', () => {
    const db = store()
    direct(db, 'before-replacement')
    const generation = db.health().generation
    const coverageStart = db.health().coverageStart
    db.close()
    rmSync(db.path)
    clock += 1000
    const replacement = store({}, db.path)
    expect(replacement.health().generation).not.toBe(generation)
    expect(replacement.health().coverageStart).not.toBe(coverageStart)
    expect(replacement.health()).toMatchObject({ status: 'incomplete', gaps: [expect.objectContaining({ reason: 'unavailable' })] })
  })

  it('rejects unsupported schema versions before adding or changing tables', () => {
    const db = store()
    db.close()
    const unsupported = new Database(db.path)
    unsupported.exec("DROP TABLE ledger_instances; DROP TABLE ledger_changes; UPDATE ledger_meta SET value='999' WHERE key='version'")
    unsupported.close()
    const rejected = store({}, db.path)
    expect(rejected.health().status).toBe('unavailable')
    const retained = new Database(db.path, { readonly: true })
    try {
      expect(retained.prepare("SELECT value FROM ledger_meta WHERE key='version'").get()).toEqual({ value: '999' })
      expect(retained.prepare("SELECT 1 FROM sqlite_master WHERE name='ledger_instances'").get()).toBeUndefined()
    } finally { retained.close() }
  })

  it('reopens the store after an outage and recovers to ok', () => {
    const root = mkdtempSync(join(tmpdir(), 'poise-ledger-reopen-'))
    roots.push(root)
    const path = join(root, 'behavior-ledger.db')
    mkdirSync(path)
    const db = store({}, path)
    expect(db.health()).toMatchObject({ status: 'unavailable', unavailableReason: 'store_unavailable' })
    expect(db.read({ operation: 'list' })).toMatchObject({ status: 503 })
    rmdirSync(path)
    clock += 1001
    expect(db.health()).toMatchObject({ status: 'ok', unavailableReason: null })
    expect(db.read({ operation: 'list', limit: 50 })).toMatchObject({ status: 200 })
  })

  it('keeps unavailable health readable when initialization cannot allocate its bounded store', () => {
    const db = store({ maxPagesBytes: 4096 })
    expect(db.read({ operation: 'health' })).toMatchObject({ status: 200,
      body: { health: { status: 'unavailable', unavailableReason: 'store_unavailable' } } })
    expect(db.read({ operation: 'list' })).toMatchObject({ status: 503, body: { error: 'ledger_unavailable' } })
  })

  it('applies private file permissions and bounds the independent coverage journal', () => {
    const db = store()
    db.capture(admission())
    for (let i = 0; i < 30; i++) db.loss()
    expect(statSync(db.path).mode & 0o777).toBe(0o600)
    expect(statSync(db.path + '.coverage.json').mode & 0o777).toBe(0o600)
    expect(statSync(db.path + '.coverage.json').size).toBeLessThanOrEqual(8192)
    expect(db.health().gaps.length).toBeLessThanOrEqual(16)
    expect(db.health().dropped).toBe(30)
  })
})
