import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

let root = ''
let store: typeof import('../server/alerts/store')
let producers: typeof import('../server/alerts/producers')
let database: typeof import('../server/db')

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-alerts-'))
  vi.stubEnv('POISE_DB', join(root, 'cache.db'))
  vi.resetModules()
  database = await import('../server/db')
  store = await import('../server/alerts/store')
  producers = await import('../server/alerts/producers')
})

beforeEach(() => {
  database.db.prepare('DELETE FROM alerts').run()
  database.setMeta('account_logins', '{}')
})

afterAll(async () => {
  database.closeDatabase()
  vi.unstubAllEnvs()
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const input = (overrides: Partial<import('../server/alerts/store').AlertInput> = {}): import('../server/alerts/store').AlertInput =>
  ({ kind: 'chat_waiting', dedupeKey: 'chat-waiting:s1', title: 'Claude Code is waiting for you', body: 'Allow it?', path: '/', ...overrides })
const rows = () => database.db.prepare('SELECT kind, title, body, url, dedupe_key AS key, resolved_at AS resolved FROM alerts ORDER BY id').all() as Array<Record<string, unknown>>
const unresolved = () => rows().filter((row) => row.resolved === null)

describe('the alerts store', () => {
  it('keeps one alert per condition until it is resolved, then alerts again', () => {
    const first = store.raiseAlert(input())
    expect(first).toMatchObject({ id: expect.stringMatching(/^[0-9a-f]{12}-\d+$/), kind: 'chat_waiting', path: '/' })
    expect(store.raiseAlert(input({ title: 'again' }))).toBeNull()
    expect(rows()).toHaveLength(1)

    expect(store.resolveAlert('chat-waiting:s1')).toBe(true)
    expect(store.resolveAlert('chat-waiting:s1')).toBe(false)
    const second = store.raiseAlert(input())
    expect(second!.seq).toBeGreaterThan(first!.seq)
    expect(rows().map((row) => row.resolved === null)).toEqual([false, true])
    // Other conditions are independent.
    expect(store.raiseAlert(input({ dedupeKey: 'chat-waiting:s2' }))).not.toBeNull()
  })

  it('reads back only the ids it issued, and never issues one twice', () => {
    const alert = store.raiseAlert(input())!
    expect(store.alertSeq(alert.id)).toBe(alert.seq)
    const [prefix] = alert.id.split('-')
    const otherPrefix = prefix === 'aaaaaaaaaaaa' ? 'bbbbbbbbbbbb' : 'aaaaaaaaaaaa'
    for (const id of [`${otherPrefix}-${alert.seq}`, `${prefix}-0`, `${prefix}-x`, String(alert.seq), '', `${prefix}-${alert.seq}\n`]) {
      expect(store.alertSeq(id), JSON.stringify(id)).toBeNull()
    }
    // Pruned rows leave their ids behind: AUTOINCREMENT never reuses them.
    store.resolveAlert('chat-waiting:s1')
    expect(store.pruneAlerts(Date.now() + 31 * DAY)).toBe(1)
    expect(store.raiseAlert(input())!.seq).toBe(alert.seq + 1)
  })

  it('keeps resolved history and desktop replay for 30 days', () => {
    const now = Date.now()
    store.raiseAlert(input({ dedupeKey: 'old' }), now - 31 * DAY)
    store.resolveAlert('old', now - 31 * DAY + 1000)
    const recent = store.raiseAlert(input({ dedupeKey: 'recent' }), now - 29 * DAY)!
    // Reading never returns what retention has dropped, even before pruning.
    expect(store.alertsAfter(0, 10, { now }).map((alert) => alert.id)).toEqual([recent.id])
    // Raising prunes.
    const fresh = store.raiseAlert(input({ dedupeKey: 'fresh' }), now)!
    expect(rows().map((row) => row.key)).toEqual(['recent', 'fresh'])
    expect(store.alertsAfter(recent.seq, 10, { now }).map((alert) => alert.id)).toEqual([fresh.id])
  })

  it('retains unresolved conditions and dismissal identity until authoritative resolution', () => {
    const now = Date.now()
    const original = store.raiseAlert(input({ kind: 'storage_low', dedupeKey: 'pressure' }), now - 31 * DAY)!
    store.dismissAlert(original.seq, now - DAY)
    expect(store.pruneAlerts(now)).toBe(0)
    expect(store.openAlerts({ now })).toMatchObject([{ id: original.id, dismissedAt: new Date(now - DAY).toISOString() }])
    expect(store.raiseAlert(input({ kind: 'storage_low', dedupeKey: 'pressure' }), now)).toBeNull()
    expect(store.alertsAfter(0, 10, { now })).toEqual([])
    store.resolveAlert('pressure', now)
    expect(store.pruneAlerts(now)).toBe(1)
    expect(store.raiseAlert(input({ kind: 'storage_low', dedupeKey: 'pressure' }), now)!.seq).toBeGreaterThan(original.seq)
  })

  it('still expires finished-turn product history on its existing retention schedule', () => {
    const now = Date.now()
    store.raiseAlert(input({ kind: 'chat_turn_finished' }), now - 31 * DAY)
    expect(store.openAlerts({ now })).toEqual([])
    expect(store.pruneAlerts(now)).toBe(1)
  })

  it('reads alerts after a seq, oldest first, or the newest few', () => {
    const alerts = [1, 2, 3, 4, 5].map((n) => store.raiseAlert(input({ dedupeKey: `k${n}`, title: `t${n}` }))!)
    expect(store.alertsAfter(alerts[1].seq, 2).map((alert) => alert.title)).toEqual(['t3', 't4'])
    expect(store.alertsAfter(alerts[1].seq, 2, { newest: true }).map((alert) => alert.title)).toEqual(['t4', 't5'])
    expect(store.latestAlertSeq()).toBe(alerts[4].seq)
    expect(store.alertsAfter(0, 10)[0]).toEqual({ ...alerts[0] })
  })

  it('announces alerts once the work that raised them is done, and only what was kept', async () => {
    const announced = vi.fn()
    store.alertEvents.on('recorded', announced)
    try {
      const before = store.latestAlertSeq()
      const rollback = database.db.transaction(() => {
        store.raiseAlert(input())
        throw new Error('the surrounding work failed')
      })
      expect(() => rollback()).toThrow('the surrounding work failed')
      store.raiseAlert(input({ dedupeKey: 'a' }))
      store.raiseAlert(input({ dedupeKey: 'b' }))
      expect(announced).not.toHaveBeenCalled()
      await new Promise((resolve) => setImmediate(resolve))
      expect(announced).toHaveBeenCalledTimes(1)
      expect(store.alertsAfter(before, 10).map((alert) => alert.path)).toHaveLength(2)
      expect(rows().map((row) => row.key)).toEqual(['a', 'b'])

      store.raiseAlert(input({ dedupeKey: 'a' }))
      await new Promise((resolve) => setImmediate(resolve))
      expect(announced).toHaveBeenCalledTimes(1)
    } finally {
      store.alertEvents.off('recorded', announced)
    }
  })

  it('refuses alerts that are not well formed', () => {
    expect(() => store.raiseAlert(input({ kind: 'unknown' as never }))).toThrow(/unknown alert kind/)
    expect(() => store.raiseAlert(input({ path: 'https://elsewhere.example/' }))).toThrow(/path in this workspace/)
    expect(() => store.raiseAlert(input({ path: '//elsewhere.example/' }))).toThrow(/path in this workspace/)
    expect(() => store.raiseAlert(input({ title: ' ' }))).toThrow(/title/)
    expect(() => store.raiseAlert(input({ dedupeKey: '' }))).toThrow(/dedupe key/)
    expect(rows()).toEqual([])
  })
})

describe('the alert producers', () => {
  it('alerts when a configured Claude needs a new sign-in, until it is signed in again', () => {
    database.setMeta('account_logins', JSON.stringify({ claude: '2026-10-20T06:00:00.000Z' }))
    producers.claudeAuthStatusChanged('reauth_required')
    expect(rows()).toEqual([{
      kind: 'sign_in_needed', key: 'sign-in:claude', resolved: null, url: '/',
      title: 'Claude needs you to sign in again', body: 'Claude-backed work is paused until you sign in to Claude from Poise.',
    }])
    // Uncertain states neither alert nor clear it; a repeat is the same alert.
    for (const status of ['checking', 'degraded', 'unavailable', 'signing_in', 'reauth_required'] as const) producers.claudeAuthStatusChanged(status)
    expect(rows()).toHaveLength(1)
    expect(unresolved()).toHaveLength(1)
    producers.claudeAuthStatusChanged('authenticated')
    expect(unresolved()).toEqual([])
    vi.stubEnv('POISE_MODE', 'service')
    try {
      producers.claudeAuthStatusChanged('reauth_required')
    } finally {
      vi.stubEnv('POISE_MODE', undefined)
    }
    expect(unresolved()).toEqual([expect.objectContaining({ body: 'Claude-backed work is paused. Connect Claude in Settings → Accounts.' })])
  })

  it('raises no sign-in demand for a Claude that was never configured, and remembers a verified one', () => {
    producers.claudeAuthStatusChanged('reauth_required')
    expect(rows()).toEqual([])
    producers.claudeAuthStatusChanged('authenticated')
    expect(database.getMeta('account_logins')).toContain('"claude"')
    producers.claudeAuthStatusChanged('reauth_required')
    expect(unresolved()).toEqual([expect.objectContaining({ key: 'sign-in:claude' })])
  })

  it('alerts once per held behavior target until its incident has cleared', () => {
    producers.behaviorHeld('review-new-prs', 'acme/app#12', false)
    producers.behaviorHeld('review-new-prs', 'acme/app#12', true)
    expect(rows()).toEqual([{
      kind: 'behavior_held', key: 'behavior-held:review-new-prs:acme/app#12', resolved: null, url: '/',
      title: 'Review New Pull Requests failed on acme/app#12', body: 'Open Behaviors in Poise to see what happened.',
    }])
    // The Behaviors view showed no incident for it any more: a new one alerts.
    producers.behaviorHeld('review-new-prs', 'acme/app#12', false)
    expect(rows().map((row) => row.resolved === null)).toEqual([false, true])
    producers.behaviorHeld('review-new-issues', 'acme/app#3', false)
    expect(unresolved().map((row) => row.title)).toEqual(['Review New Pull Requests failed on acme/app#12', 'Review New Issues failed on acme/app#3'])
  })

  it('replaces a dismissed held alert when its cause changes and deduplicates continuing causes across restart', async () => {
    producers.behaviorHeld('approve-prs', 'acme/app#12', false, 'No space left on device')
    const first = store.openAlerts()[0]
    store.dismissAlert(first.seq)
    producers.behaviorHeld('approve-prs', 'acme/app#12', true, 'No space left on device')
    expect(rows()).toHaveLength(1)

    database.closeDatabase()
    vi.resetModules()
    database = await import('../server/db')
    store = await import('../server/alerts/store')
    producers = await import('../server/alerts/producers')
    producers.behaviorHeld('approve-prs', 'acme/app#12', true,
      'Input exceeds the maximum length of 1048576 characters: actual_chars=1171658')
    expect(rows().map((row) => row.resolved === null)).toEqual([false, true])
    const next = store.openAlerts()[0]
    expect(next.seq).toBeGreaterThan(first.seq)
    expect(next.dismissedAt).toBeNull()
    expect(next.body).toContain('Input exceeds the maximum length')
    expect(store.alertsAfter(first.seq, 50)).toHaveLength(1)

    store.dismissAlert(next.seq)
    producers.behaviorHeld('approve-prs', 'acme/app#12', true,
      'Input exceeds the maximum length of 1048576 characters: actual_chars=1200000')
    expect(rows()).toHaveLength(2)
    expect(store.openAlerts()[0].dismissedAt).not.toBeNull()
  })

  it('compares complete causes before display truncation without treating wider counts as a new cause', () => {
    const suffix = ' context from the provider'.repeat(20)
    producers.behaviorHeld('approve-prs', 'acme/app#12', false, `Provider refused: actual_chars=999999${suffix} cause A`)
    const first = store.openAlerts()[0]
    store.dismissAlert(first.seq)
    producers.behaviorHeld('approve-prs', 'acme/app#12', true, `Provider refused: actual_chars=1000000${suffix} cause A`)
    expect(rows()).toHaveLength(1)
    expect(store.openAlerts()[0].dismissedAt).not.toBeNull()
    expect(first.cause).toMatch(/^[0-9a-f]{64}$/)

    producers.behaviorHeld('approve-prs', 'acme/app#12', true, `Provider refused: actual_chars=1000000${suffix} cause B`)
    expect(rows().map((row) => row.resolved === null)).toEqual([false, true])
    expect(store.openAlerts()[0].cause).not.toBe(first.cause)
  })

  it('keeps different HTTP failure causes distinct while ignoring attempt IDs', () => {
    producers.behaviorHeld('approve-prs', 'acme/app#12', false, `GitHub 403 for attempt ${'a'.repeat(32)}`)
    producers.behaviorHeld('approve-prs', 'acme/app#12', true, `GitHub 403 for attempt ${'b'.repeat(32)}`)
    expect(rows()).toHaveLength(1)
    producers.behaviorHeld('approve-prs', 'acme/app#12', true, `GitHub 500 for attempt ${'c'.repeat(32)}`)
    expect(rows().map((row) => row.resolved === null)).toEqual([false, true])
  })

  it('alerts when a datastore sync has been failing for 15 minutes, until it succeeds', () => {
    const since = Date.parse('2026-10-03T10:00:00.000Z')
    producers.datastoreSyncFailed('Acme', since, since)
    producers.datastoreSyncFailed('Acme', since, since + 15 * 60_000 - 1)
    expect(rows()).toEqual([])
    producers.datastoreSyncFailed('Acme', since, since + 15 * 60_000)
    producers.datastoreSyncFailed('acme', since, since + 31 * 60_000)
    expect(rows()).toEqual([{
      kind: 'datastore_sync_failing', key: 'datastore-sync:acme', resolved: null, url: '/',
      title: 'GitHub data for Acme is not updating',
      body: 'Syncing it has failed for 15 minutes. Poise keeps retrying; Settings → General → GitHub accounts shows the error.',
    }])
    producers.datastoreSyncRecovered('ACME')
    expect(unresolved()).toEqual([])
    producers.datastoreSyncFailed('Acme', since + HOUR, since + HOUR + 20 * 60_000)
    expect(unresolved()).toHaveLength(1)
  })

  it('alerts once while a Chat agent waits, and again when it waits after an answer', () => {
    const session = { sessionId: 's1', agent: 'Claude Code', title: 'Fix the flaky test' }
    producers.chatWaiting(session, { kind: 'permission', title: 'Execute `rm -rf build`' })
    producers.chatWaiting(session, { kind: 'question', question: 'Which branch?' })
    expect(rows()).toEqual([{
      kind: 'chat_waiting', key: 'chat-waiting:s1', resolved: null, url: '/',
      title: 'Claude Code is waiting for you', body: 'In “Fix the flaky test”: allow or deny Execute `rm -rf build`.',
    }])
    producers.chatWaitingEnded('s1')
    producers.chatWaiting({ ...session, title: '' }, { kind: 'question', question: 'Which branch?\nmain or next?' })
    expect(unresolved()).toEqual([expect.objectContaining({ body: 'In a Chat session: Which branch? main or next?' })])
  })

  it('alerts when a Chat turn that ran longer than two minutes finishes, unless it was stopped', () => {
    const session = { sessionId: 's1', agent: 'Codex', title: 'Refactor the parser' }
    producers.chatTurnFinished(session, { id: 't1', stopReason: 'end_turn', durationMs: 2 * 60_000 })
    producers.chatTurnFinished(session, { id: 't2', stopReason: 'cancelled', durationMs: 10 * 60_000 })
    expect(rows()).toEqual([])
    producers.chatTurnFinished(session, { id: 't3', stopReason: 'end_turn', durationMs: 7 * 60_000 + 10_000 })
    producers.chatTurnFinished(session, { id: 't3', stopReason: 'end_turn', durationMs: 7 * 60_000 + 10_000 })
    producers.chatTurnFinished(session, { id: 't4', stopReason: 'max_tokens', durationMs: 3 * 60_000 })
    expect(rows()).toEqual([
      { kind: 'chat_turn_finished', key: 'chat-turn-finished:t3', resolved: null, url: '/', title: 'Codex finished', body: '“Refactor the parser” is done after 7 minutes.' },
      { kind: 'chat_turn_finished', key: 'chat-turn-finished:t4', resolved: null, url: '/', title: 'Codex stopped early', body: '“Refactor the parser” ended (max tokens) after 3 minutes.' },
    ])
  })

  it('skips the finished alert for a timer turn that ended normally, but not for one that errored', () => {
    const session = { sessionId: 's1', agent: 'Codex', title: 'Refactor the parser' }
    producers.chatTurnFinished(session, { id: 't5', stopReason: 'end_turn', durationMs: 7 * 60_000, timer: true })
    expect(rows()).toEqual([])
    producers.chatTurnFinished(session, { id: 't6', stopReason: 'error', durationMs: 7 * 60_000, timer: true })
    expect(rows()).toEqual([
      { kind: 'chat_turn_finished', key: 'chat-turn-finished:t6', resolved: null, url: '/', title: 'Codex stopped early', body: '“Refactor the parser” ended (error) after 7 minutes.' },
    ])
  })

  it('logs an alert it cannot record instead of failing the work that raised it', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    database.db.exec('ALTER TABLE alerts RENAME TO alerts_elsewhere')
    try {
      expect(() => producers.chatWaiting({ sessionId: 's1', agent: 'Muse', title: 't' }, { kind: 'question', question: 'q' })).not.toThrow()
      expect(() => producers.claudeAuthStatusChanged('authenticated')).not.toThrow()
    } finally {
      database.db.exec('ALTER TABLE alerts_elsewhere RENAME TO alerts')
    }
    expect(errors).toHaveBeenCalledWith('[alerts] could not record the waiting alert for Chat session s1:', expect.any(Error))
    expect(errors).toHaveBeenCalledWith('[alerts] could not record the end of the Claude sign-in alert:', expect.any(Error))
  })
})
