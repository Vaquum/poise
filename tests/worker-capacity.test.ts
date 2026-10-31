import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Worker capacity and the idle-backlog alert (server/worker-capacity.ts):
// capacity display, the 15-minute idle alert with candidates, hourly repeat,
// and clearing when a slot fills or a ticket is labelled.

let root = ''
let database: typeof import('../server/db')
let store: typeof import('../server/alerts/store')
let notices: typeof import('../server/alerts/notices')
let capacity: typeof import('../server/worker-capacity')

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-worker-capacity-'))
  vi.stubEnv('POISE_DB', join(root, 'cache.db'))
  vi.resetModules()
  database = await import('../server/db')
  store = await import('../server/alerts/store')
  notices = await import('../server/alerts/notices')
  capacity = await import('../server/worker-capacity')
})

beforeEach(() => {
  database.db.prepare('DELETE FROM alerts').run()
  database.db.prepare('DELETE FROM alert_silences').run()
  database.db.prepare("DELETE FROM meta WHERE key IN ('manager_settings', 'worker_idle_since', 'notification_settings')").run()
  capacity.resetWorkerCapacityCache()
  capacity.setWorkerChatReader(null)
})

afterAll(async () => {
  database.closeDatabase()
  vi.unstubAllEnvs()
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

const MINUTE = 60_000
const T0 = Date.parse('2026-10-25T13:00:00.000Z')
const at = (minutes: number) => T0 + minutes * MINUTE

function managerSettings(overrides: Record<string, unknown> = {}) {
  database.setMeta('manager_settings', JSON.stringify({
    rhythm: 7, stability: 'Balanced', autonomy: 'Balanced', scope: null, paused: false, version: 1,
    ...overrides,
  }))
}

function reader(running: number, overrides: Partial<{ hasManager: boolean, boundTargets: string[] }> = {}) {
  capacity.setWorkerChatReader(() => ({
    running,
    hasManager: overrides.hasManager ?? true,
    boundTargets: overrides.boundTargets ?? [],
  }))
}

const candidate = (number: number, title: string, body = '') => ({
  repo: 'acme/api', number, title, body, url: `https://github.com/acme/api/issues/${number}`,
})

describe('worker capacity', () => {
  it('shows worker chats running versus target and the labelled backlog', async () => {
    managerSettings({ rhythm: 7 })
    reader(2)
    await capacity.refreshWorkerCapacity({ now: at(0), readBacklog: async () => 0, listCandidates: async () => [] })
    expect(capacity.getWorkerCapacity()).toEqual({ running: 2, target: 7, backlog: 0, label: 'enhancement' })
  })

  it('reports an unknown backlog until the first successful refresh', () => {
    managerSettings({ rhythm: 7 })
    reader(2)
    expect(capacity.getWorkerCapacity()).toEqual({ running: 2, target: 7, backlog: null, label: 'enhancement' })
  })
})

describe('candidate ranking', () => {
  it('lists perf and P0/P1 first', () => {
    const ranked = capacity.rankCandidates([
      candidate(3, 'feat: add import'),
      candidate(1, 'perf: keep the service responsive'),
      candidate(2, 'fix: reclaim resources', 'Priority: P1 (idle capacity goes unnoticed).'),
      candidate(4, 'perf: trim the slow check', 'Priority: P0, blocks the release.'),
    ])
    expect(ranked.map((issue) => issue.number)).toEqual([4, 1, 2, 3])
  })
})

describe('the idle-backlog alert', () => {
  it('raises one owner notification after 15 idle minutes, naming up to five candidates with links', async () => {
    managerSettings({ rhythm: 7 })
    reader(2)
    const candidates = [
      candidate(669, 'perf: keep the workspace responsive'),
      candidate(661, 'Review follow-up'),
      candidate(666, 'test: wait on events'),
      candidate(667, 'fix: count reviews'),
      candidate(668, 'test: isolate fixtures'),
      candidate(670, 'feat: one too many'),
    ]
    const listCandidates = vi.fn(async () => candidates.slice(0, 5))
    // Before 15 minutes: no alert.
    await capacity.refreshWorkerCapacity({ now: at(0), readBacklog: async () => 0, listCandidates })
    await capacity.refreshWorkerCapacity({ now: at(14), readBacklog: async () => 0, listCandidates })
    expect(store.openAlerts({ now: at(14) })).toEqual([])
    expect(listCandidates).not.toHaveBeenCalled()
    // After 15 minutes: one alert with five candidates and links.
    await capacity.refreshWorkerCapacity({ now: at(16), readBacklog: async () => 0, listCandidates })
    const open = store.openAlerts({ now: at(16) })
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({
      kind: 'worker_idle',
      dedupeKey: 'worker-idle:empty-backlog',
      title: '5 of 7 worker slots idle — enhancement backlog empty',
      target: { view: 'behaviors' },
    })
    expect(open[0].body).toContain('2 of 7 worker chats running; no open unassigned enhancement issues.')
    for (const issue of candidates.slice(0, 5)) {
      expect(open[0].body).toContain(`acme/api#${issue.number}`)
      expect(open[0].body).toContain(`https://github.com/acme/api/issues/${issue.number}`)
    }
    expect(open[0].body).not.toContain('#670')
    expect(listCandidates).toHaveBeenCalledTimes(1)
  })

  it('repeats at most hourly while the condition lasts', async () => {
    managerSettings({ rhythm: 7 })
    reader(2)
    const listCandidates = vi.fn(async () => [candidate(669, 'perf: keep the workspace responsive')])
    await capacity.refreshWorkerCapacity({ now: at(0), readBacklog: async () => 0, listCandidates })
    await capacity.refreshWorkerCapacity({ now: at(16), readBacklog: async () => 0, listCandidates })
    expect(listCandidates).toHaveBeenCalledTimes(1)
    // Within the hour: the alert stands but candidates are not re-read.
    await capacity.refreshWorkerCapacity({ now: at(30), readBacklog: async () => 0, listCandidates })
    expect(listCandidates).toHaveBeenCalledTimes(1)
    expect(store.openAlerts({ now: at(30) })).toHaveLength(1)
    // After the hour: candidates refresh once.
    await capacity.refreshWorkerCapacity({ now: at(80), readBacklog: async () => 0, listCandidates })
    expect(listCandidates).toHaveBeenCalledTimes(2)
    expect(store.openAlerts({ now: at(80) })).toHaveLength(1)
  })

  it('comes due hourly in the notice list, like a ready pull request', () => {
    const alert = store.raiseAlert({
      kind: 'worker_idle', dedupeKey: 'worker-idle:empty-backlog',
      title: '5 of 7 worker slots idle — enhancement backlog empty',
      body: 'Candidates to label.',
      path: '/', target: { view: 'behaviors' },
    }, at(0))!
    const due = (now: number) => notices.noticesState(now).notices.find((notice) => notice.id === alert.id)?.due
    expect(due(at(0))).toBe(new Date(at(0)).toISOString())
    expect(due(at(59))).toBe(new Date(at(0)).toISOString())
    expect(due(at(60))).toBe(new Date(at(60)).toISOString())
    notices.dismissNotice(alert.id, at(61))
    expect(due(at(62))).toBeUndefined()
    expect(due(at(120))).toBe(new Date(at(120)).toISOString())
  })

  it('clears as soon as a slot fills', async () => {
    managerSettings({ rhythm: 7 })
    reader(2)
    await capacity.refreshWorkerCapacity({ now: at(0), readBacklog: async () => 0, listCandidates: async () => [] })
    await capacity.refreshWorkerCapacity({ now: at(16), readBacklog: async () => 0, listCandidates: async () => [] })
    expect(store.openAlerts({ now: at(16) })).toHaveLength(1)
    reader(7)
    await capacity.refreshWorkerCapacity({ now: at(17), readBacklog: async () => 0, listCandidates: async () => [] })
    expect(store.openAlerts({ now: at(17) })).toEqual([])
  })

  it('clears as soon as a ticket is labelled', async () => {
    managerSettings({ rhythm: 7 })
    reader(2)
    await capacity.refreshWorkerCapacity({ now: at(0), readBacklog: async () => 0, listCandidates: async () => [] })
    await capacity.refreshWorkerCapacity({ now: at(16), readBacklog: async () => 0, listCandidates: async () => [] })
    expect(store.openAlerts({ now: at(16) })).toHaveLength(1)
    await capacity.refreshWorkerCapacity({ now: at(17), readBacklog: async () => 1, listCandidates: async () => [] })
    expect(store.openAlerts({ now: at(17) })).toEqual([])
  })

  it('stays silent without a Manager, while paused, with an empty scope, or when the backlog is unknown', async () => {
    // No Manager.
    managerSettings({ rhythm: 7 })
    reader(2, { hasManager: false })
    await capacity.refreshWorkerCapacity({ now: at(30), readBacklog: async () => 0, listCandidates: async () => [] })
    expect(store.openAlerts({ now: at(30) })).toEqual([])
    // Paused.
    managerSettings({ rhythm: 7, paused: true })
    reader(2)
    await capacity.refreshWorkerCapacity({ now: at(30), readBacklog: async () => 0, listCandidates: async () => [] })
    expect(store.openAlerts({ now: at(30) })).toEqual([])
    // Empty scope.
    managerSettings({ rhythm: 7, paused: false, scope: [] })
    await capacity.refreshWorkerCapacity({ now: at(30), readBacklog: async () => 0, listCandidates: async () => [] })
    expect(store.openAlerts({ now: at(30) })).toEqual([])
    // Unknown backlog.
    managerSettings({ rhythm: 7, scope: null })
    await capacity.refreshWorkerCapacity({ now: at(30), readBacklog: async () => null, listCandidates: async () => [] })
    expect(store.openAlerts({ now: at(30) })).toEqual([])
  })
})
