import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { db, closeDatabase } from '../server/db'
import { behaviorCutoverBlockers } from '../server/behavior-cutover'

const native = vi.hoisted(() => ({ count: 0, pendingResources: 0, known: true }))
vi.mock('../server/service/caller-calls', () => ({ runningCallerCalls: () => native }))
afterEach(() => {
  db.prepare("DELETE FROM behavior_seen WHERE target LIKE 'cutover-hold/%'").run()
  Object.assign(native, { count: 0, pendingResources: 0, known: true })
})
afterAll(() => closeDatabase())

function reserve(original: boolean, quarantine: string | null) {
  const claimId = 'retained-original'
  db.prepare(`INSERT INTO behavior_seen(key, target, seen_at, claim_id, lease_until)
    VALUES ('pr-operation', 'cutover-hold/repo#1', ?, ?, ?)`).run(new Date().toISOString(), claimId, Date.now() + 7_200_000)
  db.prepare(`INSERT INTO behavior_seen(key, target, seen_at, claim_id, lease_until, launch_call_id, launch_quarantine)
    VALUES ('review-new-prs', 'cutover-hold/repo#1', ?, ?, ?, ?, ?)`)
    .run(new Date().toISOString(), claimId, Date.now() + 7_200_000, original ? 'a'.repeat(32) : null, quarantine)
}

it.each(['invalid_result', 'unreadable'])('does not mistake a retained %s original for active work or clear its evidence', (quarantine) => {
  reserve(true, quarantine)
  const before = db.prepare("SELECT * FROM behavior_seen WHERE target = 'cutover-hold/repo#1' ORDER BY key").all()
  expect(behaviorCutoverBlockers()).toEqual([])
  expect(db.prepare("SELECT * FROM behavior_seen WHERE target = 'cutover-hold/repo#1' ORDER BY key").all()).toEqual(before)
})

it.each([[false, 'invalid_result'], [true, null]] as const)('retains the preparation/active lease barrier (original=%s, quarantine=%s)', (original, quarantine) => {
  reserve(original, quarantine)
  expect(behaviorCutoverBlockers()).toEqual(['1 reserved PR operation(s) still settling'])
})

it.each([
  [{ count: 1 }, '1 native Caller invocation(s) still running'],
  [{ pendingResources: 1 }, '1 native cleanup(s) still unsettled'],
  [{ known: false }, 'Caller activity is unreadable'],
] as const)('retains native barriers independently of a historical held original (%s)', (state, reason) => {
  reserve(true, 'invalid_result')
  Object.assign(native, state)
  expect(behaviorCutoverBlockers()).toEqual([reason])
})
