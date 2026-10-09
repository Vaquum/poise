import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OwnPullRequest } from '../server/gh'

// The notices the page shows at its top (server/alerts/notices.ts): which
// alerts show and in what order, a ready pull request's reminders, putting a
// notice away, the check of the person's own pull requests, and the setting.

let root = ''
let database: typeof import('../server/db')
let store: typeof import('../server/alerts/store')
let notices: typeof import('../server/alerts/notices')
let settings: typeof import('../server/settings')

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-notices-'))
  vi.stubEnv('POISE_DB', join(root, 'cache.db'))
  vi.resetModules()
  database = await import('../server/db')
  store = await import('../server/alerts/store')
  notices = await import('../server/alerts/notices')
  settings = await import('../server/settings')
})

beforeEach(() => {
  database.db.prepare('DELETE FROM alerts').run()
  database.db.prepare('DELETE FROM behavior_dead_letters').run()
  database.db.prepare("DELETE FROM meta WHERE key = 'notification_settings'").run()
})

afterAll(async () => {
  database.closeDatabase()
  vi.unstubAllEnvs()
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

const MINUTE = 60_000
const T0 = Date.parse('2026-10-09T10:00:00.000Z')
const at = (minutes: number) => T0 + minutes * MINUTE

type Input = import('../server/alerts/store').AlertInput
const ready = (number: number, overrides: Partial<Input> = {}): Input => ({
  kind: 'pr_ready',
  dedupeKey: `pr-ready:acme/api#${number}`,
  title: `acme/api#${number} is ready to merge`,
  body: 'Fix the flaky retry test',
  path: '/',
  target: { pullRequest: `https://github.com/acme/api/pull/${number}` },
  ...overrides,
})
const waiting: Input = { kind: 'chat_waiting', dedupeKey: 'chat-waiting:s1', title: 'Claude Code is waiting for you', body: 'Allow it?', path: '/', target: { chat: 's1' } }
const held: Input = { kind: 'behavior_held', dedupeKey: 'behavior-held:review-new-prs:acme/api#9', title: 'Review New Pull Requests failed on acme/api#9', body: 'Open Behaviors in Poise to see what happened.', path: '/', target: { view: 'behaviors' } }
const finished: Input = { kind: 'chat_turn_finished', dedupeKey: 'chat-turn-finished:t1', title: 'Claude Code finished', body: 'Done.', path: '/', target: { chat: 's1' } }

const shown = (now: number) => notices.noticesState(now).notices
const titles = (now: number) => shown(now).map((notice) => notice.title)

describe('the notices', () => {
  it('shows the unresolved alerts, the most pressing first, the newest first within a kind', () => {
    store.raiseAlert(finished, at(0))
    store.raiseAlert(ready(1), at(1))
    store.raiseAlert(held, at(2))
    store.raiseAlert(ready(2), at(3))
    store.raiseAlert(waiting, at(4))
    store.raiseAlert({ ...waiting, dedupeKey: 'chat-waiting:gone', title: 'Gone' }, at(4))
    store.resolveAlert('chat-waiting:gone', at(5))

    expect(titles(at(6))).toEqual([
      'Claude Code is waiting for you',
      'Review New Pull Requests failed on acme/api#9',
      'acme/api#2 is ready to merge',
      'acme/api#1 is ready to merge',
      'Claude Code finished',
    ])
    expect(shown(at(6))[0]).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{12}-\d+$/),
      kind: 'chat_waiting',
      title: 'Claude Code is waiting for you',
      body: 'Allow it?',
      since: new Date(at(4)).toISOString(),
      due: new Date(at(4)).toISOString(),
      silenceable: false,
      target: { chat: 's1' },
    })
  })

  it('reminds of a ready pull request every 15 minutes from when it became ready', () => {
    const alert = store.raiseAlert(ready(1), at(0))!
    expect(shown(at(14)).map((notice) => notice.due)).toEqual([new Date(at(0)).toISOString()])

    // Put away, it stays away until the next reminder…
    notices.dismissNotice(alert.id, at(14))
    expect(shown(at(14.9))).toEqual([])
    // …which comes at 15 minutes, then at 30, and so on.
    expect(shown(at(15)).map((notice) => notice.due)).toEqual([new Date(at(15)).toISOString()])
    notices.dismissNotice(alert.id, at(16))
    expect(shown(at(29))).toEqual([])
    expect(shown(at(31)).map((notice) => [notice.since, notice.due])).toEqual([[new Date(at(0)).toISOString(), new Date(at(30)).toISOString()]])
    expect(shown(at(31))[0].silenceable).toBe(true)
  })

  it('puts other notices away for good, until their condition clears and returns', () => {
    const first = store.raiseAlert(waiting, at(0))!
    notices.dismissNotice(first.id, at(1))
    expect(shown(at(2))).toEqual([])
    expect(shown(at(200))).toEqual([])

    store.resolveAlert(waiting.dedupeKey, at(3))
    store.raiseAlert(waiting, at(4))
    expect(titles(at(5))).toEqual(['Claude Code is waiting for you'])
  })

  it('silences a ready pull request, and nothing else', () => {
    const pr = store.raiseAlert(ready(1), at(0))!
    const chat = store.raiseAlert(waiting, at(0))!
    expect(() => notices.silenceNotice(chat.id, at(1))).toThrow(expect.objectContaining({ statusCode: 400 }))
    notices.silenceNotice(pr.id, at(1))
    expect(titles(at(15))).toEqual(['Claude Code is waiting for you'])
    expect(titles(at(600))).toEqual(['Claude Code is waiting for you'])
  })

  it('refuses to put away what it did not issue, or what has already cleared', () => {
    const alert = store.raiseAlert(waiting, at(0))!
    for (const id of ['', 'nope', '000000000000-1', alert.id.replace(/-\d+$/, '-999')]) {
      expect(() => notices.dismissNotice(id, at(1)), id).toThrow(expect.objectContaining({ statusCode: 404 }))
      expect(() => notices.silenceNotice(id, at(1)), id).toThrow(expect.objectContaining({ statusCode: 404 }))
    }
    store.resolveAlert(waiting.dedupeKey, at(1))
    expect(() => notices.dismissNotice(alert.id, at(2))).toThrow(expect.objectContaining({ statusCode: 404 }))
  })

  it('shows a finished Chat turn for an hour', () => {
    store.raiseAlert(finished, at(0))
    expect(titles(at(59))).toEqual(['Claude Code finished'])
    expect(titles(at(60))).toEqual([])
  })

  it('shows nothing while notifications are off', () => {
    store.raiseAlert(waiting, at(0))
    settings.setSettings({ notifications: { enabled: false } })
    expect(notices.noticesState(at(1))).toEqual({ enabled: false, notices: [] })
    settings.setSettings({ notifications: { enabled: true } })
    expect(titles(at(1))).toEqual(['Claude Code is waiting for you'])
  })
})

describe('an alert target', () => {
  it('is kept with the alert and refused when it could open anything else', () => {
    store.raiseAlert(held, at(0))
    expect(shown(at(1))[0].target).toEqual({ view: 'behaviors' })
    for (const target of [
      { view: 'settings' },
      { settings: 'admin' },
      { chat: '' },
      { chat: 'a b' },
      { pullRequest: 'https://example.com/acme/api/pull/1' },
      { pullRequest: 'javascript:alert(1)' },
      { pullRequest: 'https://github.com/acme/api/issues/1' },
      { view: 'behaviors', chat: 's1' },
    ]) {
      expect(() => store.raiseAlert({ ...waiting, dedupeKey: `bad:${JSON.stringify(target)}`, target: target as never }), JSON.stringify(target)).toThrow(/cannot open/)
    }
  })

  it('is absent for alerts raised without one', () => {
    store.raiseAlert({ kind: 'datastore_sync_failing', dedupeKey: 'datastore-sync:acme', title: 'GitHub data for acme is not updating', body: '', path: '/' }, at(0))
    expect(shown(at(1))[0].target).toBeNull()
  })
})

describe('the check for pull requests ready to merge', () => {
  type Read = Awaited<ReturnType<typeof import('../server/gh').readOwnPullRequests>>
  const pr = (number: number, status: OwnPullRequest['status'], repo = 'acme/api'): OwnPullRequest => ({ repo, number, title: `Change ${number}`, status })
  const reading = (value: Read) => async () => value
  const check = (value: Read, now: number) => notices.checkReadyPullRequests(reading(value), () => now)
  const all = (pullRequests: OwnPullRequest[]): Read => ({ pullRequests, read: ['acme'], tracked: ['acme'] })
  const open = () => store.openAlerts({ kind: 'pr_ready' }).map((alert) => alert.dedupeKey).sort()

  it('raises an alert once for a pull request that has become ready, with its own words and link', async () => {
    await check(all([pr(1, 'green'), pr(2, 'yellow'), pr(3, null)]), at(0))
    await check(all([pr(1, 'green'), pr(2, 'yellow'), pr(3, null)]), at(2))
    expect(shown(at(3))).toEqual([expect.objectContaining({
      kind: 'pr_ready',
      title: 'acme/api#1 is ready to merge',
      body: 'Change 1',
      since: new Date(at(0)).toISOString(),
      target: { pullRequest: 'https://github.com/acme/api/pull/1' },
    })])
    expect(database.db.prepare("SELECT url FROM alerts WHERE kind = 'pr_ready'").all()).toEqual([{ url: '/' }])
  })

  it('resolves it when the pull request stops being ready, and notices it anew when it is ready again', async () => {
    await check(all([pr(1, 'green')]), at(0))
    await check(all([pr(1, 'yellow')]), at(2))
    expect(open()).toEqual([])
    await check(all([pr(1, 'green')]), at(4))
    expect(shown(at(5)).map((notice) => notice.since)).toEqual([new Date(at(4)).toISOString()])
  })

  it('keeps what it had for a pull request GitHub could not be asked about', async () => {
    await check(all([pr(1, 'green')]), at(0))
    await check(all([pr(1, undefined)]), at(2))
    expect(shown(at(3)).map((notice) => notice.since)).toEqual([new Date(at(0)).toISOString()])
  })

  it('resolves it once the pull request is no longer open: merged or closed', async () => {
    await check(all([pr(1, 'green'), pr(2, 'green')]), at(0))
    await check(all([pr(2, 'green')]), at(2))
    expect(open()).toEqual(['pr-ready:acme/api#2'])
  })

  it('keeps it while the account it belongs to could not be read, and resolves it once Poise no longer follows that account', async () => {
    await check({ pullRequests: [pr(1, 'green'), pr(5, 'green', 'other/web')], read: ['acme', 'other'], tracked: ['acme', 'other'] }, at(0))
    // other's datastore failed, or the account is starting: its list is incomplete.
    await check({ pullRequests: [], read: ['acme'], tracked: ['acme', 'other'] }, at(2))
    expect(open()).toEqual(['pr-ready:other/web#5'])
    // The account was removed.
    await check({ pullRequests: [], read: ['acme'], tracked: ['acme'] }, at(4))
    expect(open()).toEqual([])
  })

  it('resolves everything when no GitHub accounts are set to read as', async () => {
    await check(all([pr(1, 'green')]), at(0))
    await check({ pullRequests: [], read: [], tracked: [] }, at(2))
    expect(open()).toEqual([])
  })

  it('stays silent about a silenced pull request while it is open, however often it is ready again', async () => {
    await check(all([pr(1, 'green')]), at(0))
    notices.silenceNotice(shown(at(1))[0].id, at(1))
    await check(all([pr(1, 'yellow')]), at(2))
    await check(all([pr(1, 'green')]), at(4))
    expect(open()).toEqual([])
    expect(shown(at(20))).toEqual([])
  })
})

describe('failed-behavior alerts', () => {
  function incident(behavior: string, repo: string, number: number): void {
    database.db.prepare(`
      INSERT INTO behavior_dead_letters(id, behavior, target, repo, pr, error, created_at)
      VALUES(?, ?, ?, ?, ?, 'agent-interface exited 1', ?)
    `).run(`${behavior}:${repo}#${number}`, behavior, `${repo}#${number}`, repo, number, new Date(at(0)).toISOString())
  }

  it('are resolved once Behaviors no longer shows their incident', () => {
    incident('review-new-prs', 'acme/api', 9)
    store.raiseAlert(held, at(0))
    store.raiseAlert({ ...held, dedupeKey: 'behavior-held:approve-prs:acme/api#9', title: 'Approve Pull Requests failed on acme/api#9' }, at(0))
    notices.retireClearedBehaviorAlerts(at(1))
    expect(store.openAlerts({ kind: 'behavior_held' }).map((alert) => alert.dedupeKey)).toEqual([held.dedupeKey])

    database.db.prepare('UPDATE behavior_dead_letters SET retired_at = ?').run(new Date(at(2)).toISOString())
    notices.retireClearedBehaviorAlerts(at(3))
    expect(store.openAlerts({ kind: 'behavior_held' })).toEqual([])
  })
})

describe('the notifications setting', () => {
  it('is on until it is turned off, and takes only on or off', () => {
    expect(settings.getSettings().notifications).toEqual({ enabled: true })
    expect(settings.setSettings({ notifications: { enabled: false } }).notifications).toEqual({ enabled: false })
    expect(settings.getNotificationSettings()).toEqual({ enabled: false })
    for (const value of [{}, { enabled: 'no' }, null, [true], 'off']) {
      expect(() => settings.setSettings({ notifications: value as never }), JSON.stringify(value)).toThrow(/notification/)
    }
    expect(settings.getNotificationSettings()).toEqual({ enabled: false })
  })

  it('keeps checking after a pass that failed before it read anything', async () => {
    const epoch = database.getMeta(database.ALERT_ID_EPOCH_KEY)!
    const read = vi.fn(async () => ({ pullRequests: [], read: ['acme'], tracked: ['acme'] }))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // Without the alert id prefix, reading alerts throws at once.
    database.db.prepare('DELETE FROM meta WHERE key = ?').run(database.ALERT_ID_EPOCH_KEY)
    try {
      await notices.checkNotices(read)
    } finally {
      database.setMeta(database.ALERT_ID_EPOCH_KEY, epoch)
    }
    expect(logged).toHaveBeenCalledWith('[notices] could not check what needs attention:', expect.any(Error))
    expect(read).not.toHaveBeenCalled()
    await notices.checkNotices(read)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('stops the check of pull requests while off', async () => {
    const read = vi.fn(async () => ({ pullRequests: [{ repo: 'acme/api', number: 1, title: 'Change 1', status: 'green' as const }], read: ['acme'], tracked: ['acme'] }))
    settings.setSettings({ notifications: { enabled: false } })
    await notices.checkNotices(read)
    expect(read).not.toHaveBeenCalled()
    expect(store.openAlerts()).toEqual([])

    settings.setSettings({ notifications: { enabled: true } })
    await notices.checkNotices(read)
    expect(read).toHaveBeenCalledTimes(1)
    expect(store.openAlerts().map((alert) => alert.title)).toEqual(['acme/api#1 is ready to merge'])
  })
})
