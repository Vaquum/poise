import type { BehaviorLaunchClaim } from '../server/db'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiagnosticStore } from '../gateway/src/diagnostics/store'
import { normalize } from '../gateway/src/diagnostics/contract'
import { callerDiagnostic } from '../gateway/src/diagnostics/sources'
import { joinEvidence } from '../gateway/src/diagnostics/query-evidence'
import { diagnosticEvidence, evidenceReferences } from '../gateway/src/diagnostics/evidence-contract'
import { behaviorDiagnosticGroups, retainDiagnosticEvidence } from '../src/behavior-diagnostics'
import { notificationItems, NOTICE_LOOK } from '../src/notification-items'
import { NOTIFICATION_PLACEMENT } from '../src/notification-placement'
import { DIAGNOSTIC_PLACEMENT, diagnosticClassification, DIAGNOSTIC_SCOPES } from '../src/behavior-failure-cause'
import { NOTICE_KINDS, noticesFrom } from '../src/notices'
import type { BehaviorDiagnostics } from '../src/behaviors'

const access = { workspace: 'alice', operator: false }
const cause = 'error: exact preparation failure'
const correlationId = 'd'.repeat(32)
function caller(id: string, error = cause, owner = 'alice') {
  return normalize(callerDiagnostic({ id, repo: 'acme/repo', pr_id: '9', actor: 'review-bot', behavior: 'pr_review', source: 'poise:review-new-prs',
    correlation_id: correlationId, completed_at: new Date().toISOString(), error }, owner)!)!
}
const diagnostics = (): BehaviorDiagnostics => ({ status: 'ok', agentLogsError: null, datastore: { status: 'healthy', checkedAt: '', ageSeconds: 0, lastSuccessAt: null, error: null },
  identity: { status: 'valid', actor: 'review-bot', error: null }, failures: [], deadLetters: [], holds: [] })
let directory = ''
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if (directory) rmSync(directory, { recursive: true, force: true }) })

describe('retained exact-key association', () => {
  it('keeps repeated deliveries and distinct attempts separate without text/PR borrowing', () => {
    const db = new DiagnosticStore(':memory:')
    try {
      const first = caller('a'.repeat(32)), second = caller('b'.repeat(32))
      db.append([first, first, second, caller('c'.repeat(32), cause, 'bob')])
      const selector = { source: 'caller' as const, eventId: first.id, callId: first.callId!, correlationId, target: 'acme/repo#9', behavior: 'pr_review', cause }
      const [binding] = joinEvidence(db, access, [selector])
      expect(binding.evidence?.eventId).toBe(first.id)
      expect(db.query(access).total).toBe(2)
      for (const change of [{ eventId: 'evt_' + 'f'.repeat(16) + '_' + 'f'.repeat(64) }, { callId: second.callId! }, { correlationId: 'e'.repeat(32) },
        { behavior: 'pr_approve' }, { target: 'acme/repo#10' }, { cause: 'different material cause' }, { account: 'other' }, { repository: 'other/repo' }]) {
        expect(joinEvidence(db, access, [{ ...selector, ...change }])[0].evidence).toBeUndefined()
      }
      expect(joinEvidence(db, { workspace: 'bob', operator: false }, [selector])[0].evidence).toBeUndefined()
      expect(() => joinEvidence(db, access, [{ source: 'caller', target: 'acme/repo#9', cause }])).toThrow('exact retained identity')
      expect(db.query(access).total).toBe(2)
    } finally { db.close() }
  })
  it('joins a selected-cause summary to its multiline stderr while the legacy last-line form still joins', () => {
    const stderr = 'error: GitHub 403 rate-limit: {\'x-ratelimit-resource\': \'core\', \'x-ratelimit-remaining\': \'0\', '
      + '\'x-ratelimit-reset\': \'1800000000\'} body={\n\t"message": "API rate limit exceeded for user ID 42.",\n\t"status": "403"\n}'
    const summary = 'Command failed (1): github-interface: GitHub 403 rate-limit '
      + '{\'x-ratelimit-resource\': \'core\', \'x-ratelimit-remaining\': \'0\', \'x-ratelimit-reset\': \'1800000000\'}: '
      + 'API rate limit exceeded for user ID 42.'
    const db = new DiagnosticStore(':memory:')
    try {
      const event = normalize({ id: 'quota-check', workspace: 'alice', source: 'poise', level: 'error',
        operation: 'github-interface', message: 'Command failed (1): github-interface', stderr, correlationId })!
      db.append([event])
      const selector = { source: 'poise' as const, correlationId, cause: summary }
      expect(joinEvidence(db, access, [selector])[0].evidence?.eventId).toBe(event.id)
      expect(joinEvidence(db, access, [{ ...selector, cause: 'Command failed (1): github-interface: }' }])[0].evidence?.eventId).toBe(event.id)
      expect(joinEvidence(db, access, [{ ...selector, cause: 'Command failed (1): github-interface: something else' }])[0].evidence).toBeUndefined()
    } finally { db.close() }
  })
  it('joins a summary whose stored line skips a link-only tail', () => {
    const db = new DiagnosticStore(':memory:')
    try {
      const event = normalize({ id: 'link-tail-check', workspace: 'alice', source: 'poise', level: 'error',
        operation: 'github-interface', message: 'Command failed (1): github-interface',
        stderr: 'error: not logged in\nhttps://example.com/login', correlationId })!
      db.append([event])
      expect(joinEvidence(db, access, [{ source: 'poise', correlationId,
        cause: 'Command failed (1): github-interface: error: not logged in' }])[0].evidence?.eventId).toBe(event.id)
    } finally { db.close() }
  })
  it.each(['precise\nprovider cause', 'precise\tprovider cause'])('matches decoded control characters symmetrically: %j', (message) => {
    const db = new DiagnosticStore(':memory:')
    try {
      const provider = JSON.stringify({ type: 'turn.failed', error: { message } })
      const event = caller('a'.repeat(32), provider)
      db.append([event])
      expect(joinEvidence(db, access, [{ eventId: event.id, callId: event.callId!, source: 'caller', correlationId, cause: provider }])[0].evidence?.eventId).toBe(event.id)
      expect(joinEvidence(db, access, [{ eventId: event.id, source: 'caller', cause: 'a different provider cause' }])[0].evidence).toBeUndefined()
    } finally { db.close() }
  })

  it('bounds exact retained history and labels additional occurrences', () => {
    const db = new DiagnosticStore(':memory:')
    try {
      for (let index = 0; index < 25; index++) db.append([normalize({ id: String(index), workspace: 'alice', source: 'poise', level: 'warning', operation: 'storage.pressure',
        message: 'same condition', correlationId })!])
      const binding = joinEvidence(db, access, [{ source: 'poise', correlationId }])[0]
      expect(evidenceReferences(binding)).toHaveLength(20)
      expect(binding.evidenceMore).toBe(true)
      expect(() => joinEvidence(db, access, Array.from({ length: 21 }, () => ({ source: 'poise' as const, correlationId })))).toThrow('twenty')
      expect(db.query(access).total).toBe(25)
    } finally { db.close() }
  })
  it('preserves exact per-attempt references before deduplicating presentation', () => {
    const db = new DiagnosticStore(':memory:')
    try {
      const events = [caller('a'.repeat(32)), caller('b'.repeat(32))]
      db.append(events)
      const state = diagnostics()
      state.deadLetters = events.map((event, index) => ({ id: String(index), behavior: 'review-new-prs', target: 'acme/repo#9', error: cause,
        createdAt: '2026-10-19T00:00:00Z', callId: event.callId, correlationId,
        ...joinEvidence(db, access, [{ source: 'caller', eventId: event.id, cause }])[0] }))
      const group = behaviorDiagnosticGroups(state)[0]
      expect(group.details).toHaveLength(1)
      expect(group.entries).toHaveLength(2)
      const item = notificationItems([], state, Date.now())[0]
      expect(evidenceReferences(item).map((ref) => ref.eventId)).toEqual(events.map((event) => event.id))
      state.deadLetters.push(state.deadLetters[0])
      expect(behaviorDiagnosticGroups(state)[0].entries).toHaveLength(2)
    } finally { db.close() }
  })
})

it('validates optional evidence without breaking old primary notice actions', () => {
  const event = caller('a'.repeat(32))
  const evidence = { eventId: event.id, incidentId: event.incidentId, from: '2026-10-19T00:00:00Z', to: '2026-10-19T01:00:00Z' }
  const primary = { id: 'notice', kind: 'behavior_held', title: 'Held', body: 'cause', since: evidence.from, due: evidence.from, silenceable: false, target: { view: 'behaviors' } }
  expect(noticesFrom({ enabled: true, notices: [{ ...primary, evidence }] })?.notices[0].evidence).toEqual(evidence)
  for (const bad of [{ ...evidence, eventId: 'https://evil.test/' }, { ...evidence, from: '2026-10-19T00:00:00' }, { ...evidence, to: '2020-01-01Z' }, { ...evidence, incidentId: 'inc_' + 'f'.repeat(16) + '_' + 'f'.repeat(64) }]) {
    expect(diagnosticEvidence(bad)).toBeNull()
    expect(noticesFrom({ enabled: true, notices: [{ ...primary, evidence: bad }] })?.notices[0]).toEqual(primary)
  }
})

it('inventories every actual server/client kind and finite diagnostic placement', async () => {
  directory = mkdtempSync(join(tmpdir(), 'poise-notification-audit-'))
  vi.stubEnv('POISE_DB', join(directory, 'cache.db'))
  vi.resetModules()
  const store = await import('../server/alerts/store')
  const database = await import('../server/db')
  try {
    expect([...store.ALERT_KINDS].sort()).toEqual([...NOTICE_KINDS].sort())
    expect(Object.keys(NOTIFICATION_PLACEMENT).sort()).toEqual([...NOTICE_KINDS, 'read_failed', 'action_failed', 'action_needed', 'action_finished'].sort())
    expect(Object.keys(NOTICE_LOOK).sort()).toEqual(Object.keys(NOTIFICATION_PLACEMENT).sort())
    expect(Object.keys(DIAGNOSTIC_PLACEMENT)).toHaveLength(19)
    for (const [code, row] of Object.entries(DIAGNOSTIC_PLACEMENT)) expect(diagnosticClassification(code)).toEqual({ code, severity: row.rail })
    expect(diagnosticClassification('future-source-code')).toEqual({ code: 'future-source-code', severity: 'warning' })
    expect(DIAGNOSTIC_SCOPES).toContain('Behaviors API dynamic code')
    const quota = await import('../server/github-quota'), producer = await import('../server/alerts/producers'), notice = await import('../server/alerts/notices')
    const storage = await import('../server/temporary-storage')
    expect([quota.QUOTA_WARNING_RISK_PERCENT, quota.QUOTA_WARNING_SUSTAIN_MS, producer.DATASTORE_FAILING_ALERT_MS,
      producer.LONG_CHAT_TURN_MS, notice.EVENT_NOTICE_MS, notice.REMINDER_INTERVAL_MS, notice.READY_CHECK_INTERVAL_MS, storage.TEMPORARY_STORAGE_CHECK_MS])
      .toEqual([50, 30_000, 900_000, 120_000, 3_600_000, 900_000, 120_000, 60_000])
  } finally { database.closeDatabase() }
})

// Real producer -> independent retained store -> bounded read worker -> optional notice.
describe('read-time producer binding', () => {
  let database: typeof import('../server/db'), logging: typeof import('../server/logging'), api: typeof import('../server/logging-api')
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'poise-notice-source-'))
    vi.stubEnv('POISE_DB', join(directory, 'cache.db')); vi.stubEnv('HOME', directory); vi.stubEnv('POISE_WORKSPACE_HANDLE', 'alice')
    vi.resetModules()
    database = await import('../server/db'); logging = await import('../server/logging'); api = await import('../server/logging-api')
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    logging.startLogging()
  })
  afterEach(async () => { await api.stopLoggingApi(); await logging.stopLogging(); database.closeDatabase() })
  it('retains exact storage crossings across dismissal and recovery without read-created occurrences', async () => {
    const storage = await import('../server/temporary-storage'), notices = await import('../server/alerts/notices'), bindings = await import('../server/notification-evidence')
    storage.temporaryStorageMeasured(4.9 * storage.TEMPORARY_STORAGE_GB)
    logging.loggingRuntime()!.flush()
    const first = await bindings.noticeEvidence(notices.noticesState())
    const evidence = first.notices[0].evidence!
    expect(evidence?.eventId).toMatch(/^evt_/)
    const total = logging.loggingRuntime()!.query((db) => db.query(access)).total
    expect((await bindings.noticeEvidence(notices.noticesState())).notices[0].evidence).toEqual(evidence)
    expect(logging.loggingRuntime()!.query((db) => db.query(access)).total).toBe(total)
    notices.dismissNotice(first.notices[0].id)
    expect(notices.noticesState().notices).toEqual([])
    storage.temporaryStorageMeasured(6 * storage.TEMPORARY_STORAGE_GB)
    await new Promise((resolve) => setTimeout(resolve, 5))
    storage.temporaryStorageMeasured(4.9 * storage.TEMPORARY_STORAGE_GB)
    logging.loggingRuntime()!.flush()
    expect((await bindings.noticeEvidence(notices.noticesState())).notices[0].evidence?.eventId).not.toBe(evidence.eventId)
    expect(logging.loggingRuntime()!.query((db) => db.lookup(access, evidence.eventId)).status).toBe('found')
  })
  it('binds a material cause change to its new attempt while count/attempt churn keeps dismissal', async () => {
    const producer = await import('../server/alerts/producers'), notices = await import('../server/alerts/notices'), bindings = await import('../server/notification-evidence')
    const claim = (callId: string): BehaviorLaunchClaim => ({ key: 'review-new-prs', target: 'acme/repo#9', seenAt: new Date().toISOString(), claimId: correlationId, leaseUntil: null,
      launchBehavior: 'pr_review', launchRepo: 'acme/repo', launchPr: 9, launchRequestedAt: new Date().toISOString(), launchExpectedHead: 'e'.repeat(40),
      launchActor: 'review-bot', launchSource: 'poise:review-new-prs', launchCorrelationId: correlationId, launchCallId: callId,
      launchError: null, launchQuarantine: null, launchQuarantineMayRun: false, launchCovers: [] })
    const first = caller('a'.repeat(32))
    logging.loggingRuntime()!.ingest(first); logging.loggingRuntime()!.ingest(first)
    database.recordBehaviorDeadLetter(claim(first.callId!), cause)
    producer.behaviorHeld('review-new-prs', 'acme/repo#9', false, cause)
    logging.loggingRuntime()!.flush()
    const old = (await bindings.noticeEvidence(notices.noticesState())).notices[0]
    expect(old.evidence?.eventId).toBe(first.id)
    notices.dismissNotice(old.id)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = caller('b'.repeat(32))
    logging.loggingRuntime()!.ingest(second)
    database.recordBehaviorDeadLetter(claim(second.callId!), cause)
    producer.behaviorHeld('review-new-prs', 'acme/repo#9', true, cause)
    expect(notices.noticesState().notices).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 5))
    const changedCause = 'error: a different material preparation failure'
    const third = caller('c'.repeat(32), changedCause)
    logging.loggingRuntime()!.ingest(third)
    database.recordBehaviorDeadLetter(claim(third.callId!), changedCause)
    producer.behaviorHeld('review-new-prs', 'acme/repo#9', true, changedCause)
    logging.loggingRuntime()!.flush()
    const current = (await bindings.noticeEvidence(notices.noticesState())).notices[0]
    expect(current.id).not.toBe(old.id)
    expect(current.evidence?.eventId).toBe(third.id)
    expect(logging.loggingRuntime()!.query((db) => db.query(access, { source: 'caller' })).total).toBe(3)
    database.retireBehaviorDeadLettersForTarget('review-new-prs', 'acme/repo#9')
    notices.retireClearedBehaviorAlerts()
    expect(notices.noticesState().notices).toEqual([])
    expect(logging.loggingRuntime()!.query((db) => db.query(access, { source: 'caller' })).total).toBe(3)
  })

  it.each([false, true])('binds a quota condition captured while off before its later notice (exhausted=%s)', async (exhausted) => {
    const quota = await import('../server/github-quota'), notices = await import('../server/alerts/notices'), bindings = await import('../server/notification-evidence')
    const now = Date.now(), resetAt = new Date(now + 3_600_000).toISOString()
    database.setMeta('me', 'octocat')
    database.setMeta('notification_settings', JSON.stringify({ enabled: false }))
    const account = { login: 'octocat', roles: ['user' as const], checkedAt: new Date(now).toISOString(), error: null,
      buckets: [{ resource: 'core', label: 'REST API', used: exhausted ? 5000 : 4000, remaining: exhausted ? 0 : 1000, limit: 5000, riskPercent: 90, perMinute: 100, resetAt }] }
    if (exhausted) logging.diagnostic({ level: 'error', operation: 'github_quota.exhausted', account: 'octocat', target: 'core', condition: resetAt, message: 'GitHub API budget is exhausted' })
    quota.syncQuotaAlerts([account], now)
    quota.syncQuotaAlerts([{ ...account, checkedAt: new Date(now + 30_000).toISOString() }], now + 30_000)
    logging.loggingRuntime()!.flush()
    expect(notices.noticesState(now + 30_000).notices).toEqual([])
    database.setMeta('notification_settings', JSON.stringify({ enabled: true }))
    quota.syncQuotaAlerts([{ ...account, checkedAt: new Date(now + 60_000).toISOString() }], now + 60_000)
    const notice = (await bindings.noticeEvidence(notices.noticesState(now + 60_000))).notices[0]
    expect(notice.evidence?.eventId).toMatch(/^evt_/)
    const stored = logging.loggingRuntime()!.query((db) => db.lookup(access, notice.evidence!.eventId))
    expect(stored.status).toBe('found')
    if (stored.status === 'found') expect(stored.event.operation).toBe(exhausted ? 'github_quota.exhausted' : 'github_quota.warning')
  })

  it('starts new exhaustion evidence after confirmed capacity with an unknown risk forecast', async () => {
    const quota = await import('../server/github-quota'), notices = await import('../server/alerts/notices'), bindings = await import('../server/notification-evidence')
    const now = Date.now(), resetAt = new Date(now + 3_600_000).toISOString()
    database.setMeta('me', 'octocat')
    const bucket = { resource: 'core', label: 'REST API', used: 5000, remaining: 0, limit: 5000, riskPercent: 100, perMinute: 100, resetAt }
    const sample = (at: number, remaining: number, riskPercent: number | null) => quota.syncQuotaAlerts([{ login: 'octocat', roles: ['user'], checkedAt: new Date(at).toISOString(), error: null,
      buckets: [{ ...bucket, remaining, riskPercent }] }], at)
    logging.diagnostic({ id: 'first-exhaustion', time: new Date(now).toISOString(), level: 'error', operation: 'github_quota.exhausted', account: 'octocat', target: 'core', condition: resetAt, message: 'Exhausted' })
    sample(now, 0, 100); logging.loggingRuntime()!.flush()
    const first = (await bindings.noticeEvidence(notices.noticesState(now))).notices[0]
    expect(first.evidence?.eventId).toMatch(/^evt_/)
    sample(now + 15_000, 100, null)
    expect(notices.noticesState(now + 15_000).notices).toEqual([])
    sample(now + 30_000, 0, 100)
    const beforeCollection = (await bindings.noticeEvidence(notices.noticesState(now + 30_000))).notices[0]
    expect(beforeCollection.evidence).toBeUndefined()
    logging.diagnostic({ id: 'second-exhaustion', time: new Date(now + 30_000).toISOString(), level: 'error', operation: 'github_quota.exhausted', account: 'octocat', target: 'core', condition: resetAt, message: 'Exhausted again' })
    logging.loggingRuntime()!.flush()
    const second = (await bindings.noticeEvidence(notices.noticesState(now + 30_000))).notices[0]
    expect(second.evidence?.eventId).toMatch(/^evt_/)
    expect(second.evidence?.eventId).not.toBe(first.evidence!.eventId)
  })

  it('keeps unqueried attempts pending without claiming additional retained history', async () => {
    const bindings = await import('../server/notification-evidence')
    const state = diagnostics()
    state.deadLetters = Array.from({ length: 21 }, (_, index) => ({ id: String(index), behavior: 'review-new-prs', target: 'acme/repo#9',
      callId: index.toString(16).padStart(32, '0'), correlationId, error: cause, createdAt: '' }))
    const current = await bindings.behaviorEvidence(state)
    expect(current.deadLetters).toHaveLength(21)
    expect(current.deadLetters.every((row) => row.evidenceStatus === 'pending' && row.evidenceMore !== true && row.evidence === undefined)).toBe(true)
  })

  it('joins a pre-launch exception by its exact context; later failures cannot borrow its record', async () => {
    const context = await import('../server/logging-context'), bindings = await import('../server/notification-evidence')
    const identity = { correlationId, behavior: 'review-new-prs', target: 'acme/repo#9', repository: 'acme/repo', account: 'review-bot' }
    const error = new Error(cause)
    await expect(context.withNoticeDiagnosticIdentity(identity, async () => { throw error })).rejects.toThrow(cause)
    // The existing console exception capture receives the original error outside the async context.
    logging.diagnosticFailure('application.exception', error)
    logging.loggingRuntime()!.flush()
    const state = diagnostics()
    state.failures = [{ behavior: 'review-new-prs', target: 'acme/repo#9:check', kind: 'operation', consecutiveFailures: 1, lastFailureAt: new Date().toISOString(), nextRetryAt: '', error: cause, correlationId }]
    const first = await bindings.behaviorEvidence(state)
    expect(first.failures[0].evidence?.eventId).toMatch(/^evt_/)
    state.failures[0].correlationId = 'f'.repeat(32)
    expect((await bindings.behaviorEvidence(state)).failures[0].evidence).toBeUndefined()
    state.failures = []
    expect((await bindings.behaviorEvidence(state)).failures).toEqual([])
  })
})

it('keeps known links through expiry/outage only for the same immutable attempt and material cause', () => {
  const previous = diagnostics(), event = caller('a'.repeat(32))
  const ref = { eventId: event.id, incidentId: event.incidentId, from: '2026-10-19T00:00:00Z', to: '2026-10-19T01:00:00Z' }
  previous.deadLetters = [{ id: 'incident', behavior: 'review-new-prs', target: 'acme/repo#9', callId: event.callId, correlationId, error: cause,
    createdAt: '', evidence: ref }]
  const next = diagnostics()
  next.deadLetters = previous.deadLetters.map((row) => ({ ...row, evidence: undefined, evidenceStatus: 'unavailable' }))
  expect(retainDiagnosticEvidence(next, previous).deadLetters[0]).toMatchObject({ evidence: ref, evidenceStatus: 'unavailable' })
  next.deadLetters[0].error = 'a new material cause'
  expect(retainDiagnosticEvidence(next, previous).deadLetters[0].evidence).toBeUndefined()
  next.deadLetters[0].error = cause; next.deadLetters[0].callId = 'b'.repeat(32)
  expect(retainDiagnosticEvidence(next, previous).deadLetters[0].evidence).toBeUndefined()
})
