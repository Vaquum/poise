import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { mocks, pr, loadModules, arrangeCli, datastoreHealthOutput, fixture } from './behaviors-runtime-fixture'

function openPrs(count: number, repo = pr.repo, start = 17): typeof fixture.listedPrs {
  return Array.from({ length: count }, (_, index) => ({
    ...pr, repo, number: start + index, url: `https://github.com/${repo}/pull/${start + index}`,
  }))
}

function batchRequests(args: string[]): Array<{ repository: string, number: number }> {
  return JSON.parse(args[args.indexOf('--requests-json') + 1])
}

async function arrangeOrganizations(rows: Map<string, typeof fixture.listedPrs>) {
  arrangeCli(true)
  mocks.spawnDetached.mockResolvedValue(undefined)
  const loaded = await loadModules()
  const { database: db } = loaded
  db.setMeta('me', 'poise-user')
  const betaPath = join(fixture.tempRoot, 'beta.sqlite')
  db.db.prepare(`
    INSERT INTO organizations(login, datastore_path, managed, status, stage, indexed_user)
    VALUES ('beta', ?, 1, 'ready', 'ready', 'poise-user')
  `).run(betaPath)
  const original = mocks.runFile.getMockImplementation()!
  mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
    if (command !== 'github-datastore') return original(command, args, options)
    const explicit = args[0] === '--db'
    const scoped = explicit ? args.slice(2) : args
    if (scoped[0] === 'health') {
      const response = datastoreHealthOutput()
      const health = JSON.parse(response.stdout)
      health.database = explicit ? args[1] : join(fixture.tempRoot, 'github.sqlite')
      return { ...response, stdout: JSON.stringify(health) }
    }
    return { stdout: JSON.stringify(rows.get(explicit ? 'beta' : 'Vaquum')), stderr: '' }
  })
  loaded.behaviors.startBehaviorsRuntime()
  return loaded
}

describe('behavior tick spawn budget', () => {
  it('shares one listing per organization and batches every per-PR read', async () => {
    const { database: db, behaviors: runtime } = await arrangeOrganizations(new Map([
      ['Vaquum', openPrs(6)],
      ['beta', openPrs(6, 'beta/poise-test')],
    ]))
    db.setMeta('behavior_approve_prs_enabled', '1')
    db.setMeta('behavior_resolve_unblocking_enabled', '1')

    await runtime.runEnabledBehaviorsOnce()

    const calls = mocks.runFile.mock.calls
    const datastore = calls.filter(([command]) => command === 'github-datastore')
    const subcommand = (args: string[]) => (args[0] === '--db' ? args[2] : args[0])
    expect(datastore.filter(([, args]) => subcommand(args) === 'health')).toHaveLength(2)
    expect(datastore.filter(([, args]) => subcommand(args) === 'view')).toHaveLength(2)
    const addressed = calls.filter(([, args]) => args[0] === '--requested-changes-addressed')
    expect(addressed).toHaveLength(2)
    expect(addressed.map(([, args]) => batchRequests(args).length).sort()).toEqual([6, 6])
    const activity = calls.filter(([, args]) => args[0] === '--review-activity-since')
    // Approve stage 2 plus the resolve-unblocking pre-check, one batch each per organization.
    expect(activity).toHaveLength(4)
    for (const [, args] of [...addressed, ...activity]) {
      expect(args).toContain('--requests-json')
      expect(batchRequests(args).length).toBeLessThanOrEqual(10)
    }
    // Each batch stays inside its own organization.
    for (const [, args] of addressed) {
      const repos = new Set(batchRequests(args).map((request) => request.repository.split('/')[0]))
      expect(repos.size).toBe(1)
    }
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(12)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  })
})

describe('approve-prs cursor rotation', () => {
  it('starts the batch after the cursor and advances past every record', async () => {
    fixture.listedPrs = openPrs(6)
    arrangeCli(true)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')
    db.setMeta('behavior_approve_prs_cursor', `${pr.repo}#19`)

    await runtime.runEnabledBehaviorsOnce()

    const addressed = mocks.runFile.mock.calls.filter(([, args]) => args[0] === '--requested-changes-addressed')
    expect(addressed).toHaveLength(1)
    expect(batchRequests(addressed[0][1]).map((request) => request.number)).toEqual([20, 21, 22, 17, 18, 19])
    expect(db.getMeta('behavior_approve_prs_cursor')).toBe(`${pr.repo}#19`)
    expect(mocks.spawnDetached.mock.calls.map(([, args]) => (args as string[])[1])).toEqual(
      ['#20', '#21', '#22', '#17', '#18', '#19'])
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  })
})

describe('review-new-prs prepare pool', () => {
  it('prepares candidates with a bounded pool instead of one process per candidate at once', async () => {
    fixture.listedPrs = openPrs(8)
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const original = mocks.runFile.getMockImplementation()!
    let active = 0
    let maxActive = 0
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command === 'github-interface' && (args[0] === '--head-sha' || args[0] === '--requested-changes-addressed')) {
        active += 1
        maxActive = Math.max(maxActive, active)
        try {
          await new Promise((resolve) => setTimeout(resolve, 5))
          return await original(command, args, options)
        } finally {
          active -= 1
        }
      }
      return original(command, args, options)
    })
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    await runtime.runEnabledBehaviorsOnce()

    expect(maxActive).toBeLessThanOrEqual(5)
    expect(maxActive).toBeGreaterThan(1)
    expect(mocks.spawnDetached.mock.calls.length).toBeGreaterThan(0)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  })
})

describe('review checkout in the launch phase', () => {
  async function startReviewing() {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const loaded = await loadModules()
    loaded.database.setMeta('me', 'poise-user')
    loaded.database.setMeta('behavior_review_new_prs_enabled', '1')
    loaded.database.setMeta('behavior_review_new_prs_keyver', '3')
    loaded.database.recordSeen('review-new-prs', '__snapshot_v3__')
    loaded.behaviors.startBehaviorsRuntime()
    return loaded
  }

  it('provisions the checkout after the claim, not while preparing', async () => {
    const { behaviors: runtime } = await startReviewing()

    await runtime.runEnabledBehaviorsOnce()

    const checkouts = mocks.runFile.mock.calls.filter(([, args]) => args[0] === '--local-checkout-path')
    expect(checkouts).toHaveLength(1)
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toEqual(expect.arrayContaining(['--pwd', fixture.tempRoot]))
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  })

  it('starts no checkout when preparation fails before the claim', async () => {
    const { behaviors: runtime } = await startReviewing()
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command === 'github-interface' && args[0] === '--requested-changes-addressed' && !args.includes('--requests-json')) {
        throw new Error('changes unavailable')
      }
      return original(command, args, options)
    })

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.runFile.mock.calls.some(([, args]) => args[0] === '--local-checkout-path')).toBe(false)
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([
      expect.objectContaining({ behavior: 'review-new-prs', target: `${pr.repo}#17:check` }),
    ])
  })

  it('releases the claim with a preflight outcome when the launch checkout fails', async () => {
    arrangeCli(false, true)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(db.listBehaviorLaunchClaims('review-new-prs')).toEqual([])
    expect(mocks.captureOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'preflight_failed' }))
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([
      expect.objectContaining({ behavior: 'review-new-prs', target: `${pr.repo}#17:check` }),
    ])
  })
})

describe('organization tick stagger', () => {
  it('starts each organization apart on scheduled ticks and together otherwise', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'))
    const { database: db, behaviors: runtime } = await arrangeOrganizations(new Map([
      ['Vaquum', openPrs(1)],
      ['beta', openPrs(1, 'beta/poise-test')],
    ]))
    db.setMeta('behavior_approve_prs_enabled', '1')
    const original = mocks.runFile.getMockImplementation()!
    const marks: Array<{ org: string, at: number }> = []
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command === 'github-datastore' && (args[0] === 'health' || (args[0] === '--db' && args[2] === 'health'))) {
        marks.push({ org: args[0] === '--db' ? 'beta' : 'Vaquum', at: Date.now() })
      }
      return original(command, args, options)
    })

    await runtime.runEnabledBehaviorsOnce()
    const together = new Map(marks.map(({ org, at }) => [org, at]))
    expect(Math.abs(together.get('beta')! - together.get('Vaquum')!)).toBe(0)

    marks.length = 0
    const t0 = Date.now()
    const run = runtime.runEnabledBehaviorsOnce({ stagger: true })
    // Real I/O drains while the fake clock stays put: the first
    // organization's tick starts, the second waits on its stagger sleep.
    const pump = () => new Promise<void>((resolve) => setImmediate(resolve))
    for (let i = 0; i < 1000 && marks.length === 0; i++) await pump()
    expect(marks.map(({ org }) => org)).toEqual(['Vaquum'])
    expect(marks[0].at).toBe(t0)
    await vi.advanceTimersByTimeAsync(4_999)
    for (let i = 0; i < 20; i++) await pump()
    expect(marks.map(({ org }) => org)).toEqual(['Vaquum'])
    await vi.advanceTimersByTimeAsync(1)
    for (let i = 0; i < 1000 && marks.length < 2; i++) await pump()
    await run
    expect(marks.map(({ org }) => org)).toEqual(['Vaquum', 'beta'])
    expect(marks[1].at).toBe(t0 + 5_000)
  })
})

describe('event-loop visibility', () => {
  it('exposes the current minute window of event-loop delay in behavior diagnostics', async () => {
    arrangeCli(false)
    const { behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()

    expect(runtime.getBehaviorsRuntimeHealth().eventLoop).toEqual({
      p50Ms: expect.any(Number),
      p99Ms: expect.any(Number),
      maxMs: expect.any(Number),
      meanMs: expect.any(Number),
      samples: expect.any(Number),
    })
  })
})
