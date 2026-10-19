import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { mocks, pr, HEAD_SHA, loadModules, restartModules, arrangeCli, datastoreHealthOutput, deferred, fixture } from './behaviors-runtime-fixture'

describe('multiple organization behavior isolation', () => {
  async function arrangeOrganizations() {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const loaded = await loadModules()
    const { database: db, behaviors: runtime } = loaded
    db.setMeta('me', 'poise-user')
    const betaPath = join(fixture.tempRoot, 'beta.sqlite')
    db.db.prepare(`
      INSERT INTO organizations(login, datastore_path, managed, status, stage, indexed_user)
      VALUES ('beta', ?, 1, 'ready', 'ready', 'poise-user')
    `).run(betaPath)
    const original = mocks.runFile.getMockImplementation()!
    const rows = new Map<string, typeof fixture.listedPrs>([['Vaquum', []], ['beta', []]])
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
    runtime.startBehaviorsRuntime()
    return { ...loaded, betaPath, rows }
  }

  function pull(owner: string, number: number): typeof pr {
    const repo = `${owner}/poise-test`
    return { ...pr, repo, number, url: `https://github.com/${repo}/pull/${number}` }
  }

  it('shares authoritative legacy preferences across every account and ignores old scoped overrides', async () => {
    const { database: db, behaviors: runtime } = await arrangeOrganizations()
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.setMeta('behavior_review_new_prs_setting', 'p0')
    db.setMeta('behavior_review_new_prs_reviewers', '3')
    db.setMeta('behavior_review_new_prs_scratchpad', '')
    db.setMeta('org:beta:behavior_review_new_prs_enabled', '0')
    db.setMeta('org:beta:behavior_review_new_prs_setting', 'p4')
    db.setMeta('org:beta:behavior_review_new_prs_scratchpad', 'old beta note')
    db.setMeta('org:beta:behavior_approve_prs_scratchpad', 'old scoped note')
    runtime.withBehaviorOrganization('beta', () => {
      expect(runtime.getEnabledMap()['review-new-prs']).toBe(true)
      expect(runtime.getSetting('review-new-prs')).toBe('p0')
      expect(runtime.getReviewers()).toBe(3)
      expect(runtime.getScratchpad('review-new-prs')).toBe('')
      expect(runtime.getScratchpad('approve-prs')).toBe('')
      runtime.setSetting('review-new-prs', 'p1')
      runtime.setReviewers(2)
      runtime.setScratchpad('review-new-prs', 'shared note')
      runtime.setIssueRepositories(['Vaquum/poise-test', 'beta/poise-test'])
      runtime.setIssueAuthors(['trusted-author'])
    })
    runtime.withBehaviorOrganization('Vaquum', () => {
      expect(runtime.getSetting('review-new-prs')).toBe('p1')
      expect(runtime.getReviewers()).toBe(2)
      expect(runtime.getScratchpad('review-new-prs')).toBe('shared note')
      expect(runtime.getIssueRepositories().map((entry) => entry.repo).sort()).toEqual(['Vaquum/poise-test', 'beta/poise-test'])
      expect(runtime.getIssueAuthors()).toEqual(['trusted-author'])
    })
    expect(db.getMeta('org:beta:behavior_review_new_prs_setting')).toBe('p4')
    expect(db.getMeta('behavior_review_new_prs_setting')).toBe('p1')
  })

  it('migrates managed-only preferences in registration order and keeps issue selection dates', async () => {
    const { database: db, behaviors: runtime } = await arrangeOrganizations()
    db.setMeta('org', '')
    db.db.prepare(`
      INSERT INTO organizations(login, datastore_path, managed, status, stage, indexed_user)
      VALUES ('alpha', ?, 1, 'ready', 'ready', 'poise-user')
    `).run(join(fixture.tempRoot, 'alpha.sqlite'))
    db.setMeta('org:beta:behavior_review_new_prs_enabled', '1')
    db.setMeta('org:beta:behavior_review_new_prs_setting', 'p1')
    db.setMeta('org:alpha:behavior_review_new_prs_setting', 'p4')
    db.setMeta('org:beta:behavior_review_new_prs_reviewers', '3')
    db.setMeta('behavior_review_new_prs_reviewers', '1')
    const betaSelection = { repo: 'beta/repo', since: '2026-09-01T00:00:00.000Z' }
    const alphaSelection = { repo: 'alpha/repo', since: '2026-09-02T00:00:00.000Z' }
    db.setMeta('org:beta:behavior_review_new_issues_repos', JSON.stringify([betaSelection]))
    db.setMeta('org:alpha:behavior_review_new_issues_repos', JSON.stringify([alphaSelection]))
    runtime.withBehaviorOrganization('alpha', () => {
      expect(runtime.getEnabledMap()['review-new-prs']).toBe(true)
      expect(runtime.getSetting('review-new-prs')).toBe('p1')
      expect(runtime.getReviewers()).toBe(1)
      expect(runtime.getIssueRepositories()).toEqual([alphaSelection, betaSelection])
    })
    db.setMeta('org:beta:behavior_review_new_prs_setting', 'p3')
    expect(runtime.getSetting('review-new-prs')).toBe('p1')
    expect(db.getMeta('behavior_review_new_prs_enabled')).toBe('1')
    expect(db.getMeta('behavior_review_new_prs_setting')).toBe('p1')
  })

  it('allows global configuration while accounts initialize and reports the persisted switch', async () => {
    const { database: db, behaviors: runtime, rows } = await arrangeOrganizations()
    db.setMeta('org', '')
    db.db.prepare("UPDATE organizations SET status = 'initializing' WHERE login = 'beta'").run()
    await runtime.setEnabled('review-new-prs', true)
    expect(runtime.getEnabledMap()['review-new-prs']).toBe(true)
    expect(runtime.withBehaviorOrganization('beta', () => runtime.isEnabled('review-new-prs'))).toBe(false)
    expect(db.getMeta('org:beta:behavior_review_new_prs_enabled')).toBeNull()
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    db.db.prepare("UPDATE organizations SET status = 'ready' WHERE login = 'beta'").run()
    rows.set('beta', [pull('beta', 17)])
    await runtime.runEnabledBehaviorsOnce()
    expect(db.hasSeen('review-new-prs', 'beta/poise-test#17')).toBe(true)
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('baselines each organization, filters foreign rows, and deduplicates equal repository names independently', async () => {
    const { database: db, behaviors: runtime, betaPath, rows } = await arrangeOrganizations()
    rows.set('Vaquum', [pull('Vaquum', 17)])
    rows.set('beta', [pull('beta', 17)])
    await runtime.setEnabled('review-new-prs', true)
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(db.hasSeen('review-new-prs', '__snapshot_v3__')).toBe(true)
    expect(db.hasSeen('review-new-prs', '__snapshot_v3__:org:beta')).toBe(true)
    rows.set('Vaquum', [pull('Vaquum', 17), pull('Vaquum', 18), pull('beta', 19)])
    rows.set('beta', [pull('beta', 17), pull('beta', 18), pull('Vaquum', 19)])
    await runtime.runEnabledBehaviorsOnce()
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(db.hasSeen('review-new-prs', 'Vaquum/poise-test#18')).toBe(true)
    expect(db.hasSeen('review-new-prs', 'beta/poise-test#18')).toBe(true)
    expect(db.hasSeen('review-new-prs', 'Vaquum/poise-test#19')).toBe(false)
    expect(db.hasSeen('review-new-prs', 'beta/poise-test#19')).toBe(false)
    const betaReads = mocks.runFile.mock.calls.filter(([command, args]) => command === 'github-datastore' && args[0] === '--db')
    expect(betaReads.length).toBeGreaterThan(0)
    expect(betaReads.every(([, args]) => args[1] === betaPath)).toBe(true)
    expect(betaReads.some(([, args]) => args[2] === 'health')).toBe(true)
    expect(betaReads.some(([, args]) => args[2] === 'view')).toBe(true)
  })

  it('preserves a managed baseline and its settings over restart while catching work opened during downtime', async () => {
    const { behaviors: runtime, rows } = await arrangeOrganizations()
    rows.set('beta', [pull('beta', 17)])
    await runtime.withBehaviorOrganization('beta', () => runtime.setEnabled('review-new-prs', true))
    runtime.withBehaviorOrganization('beta', () => {
      runtime.setSetting('review-new-prs', 'p1')
      runtime.setScratchpad('review-new-prs', 'persistent beta note')
    })
    const restarted = await restartModules()
    rows.set('beta', [pull('beta', 17), pull('beta', 18)])
    restarted.behaviors.startBehaviorsRuntime()
    await restarted.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(1)
    const args = mocks.spawnDetached.mock.calls[0][1] as string[]
    expect(args[args.indexOf('--pr-review') + 1]).toBe('#18')
    expect(args[args.indexOf('--p') + 1]).toBe('p1')
    expect(args[args.indexOf('--note') + 1]).toBe('persistent beta note')
    expect(restarted.database.hasSeen('review-new-prs', '__snapshot_v3__:org:beta')).toBe(true)
  })

  it('continues a healthy organization while another is blocked, and attributes its eventual failure correctly', async () => {
    const { behaviors: runtime, rows } = await arrangeOrganizations()
    await runtime.setEnabled('review-new-prs', true)
    rows.set('Vaquum', [pull('Vaquum', 18)])
    rows.set('beta', [pull('beta', 18)])
    const original = mocks.runFile.getMockImplementation()!
    const held = deferred<{ stdout: string, stderr: string }>()
    mocks.runFile.mockImplementation((command: string, args: string[], options: unknown) => {
      if (command === 'github-datastore' && args[0] === 'health') return held.promise
      return original(command, args, options)
    })
    const scan = runtime.runEnabledBehaviorsOnce()
    await vi.waitFor(() => expect(mocks.spawnDetached).toHaveBeenCalledTimes(1))
    held.resolve({ stdout: JSON.stringify({ healthy: false }), stderr: '' })
    await scan
    expect(runtime.withBehaviorOrganization('beta', () => runtime.getBehaviorsRuntimeHealth())).toMatchObject({
      status: 'ok', failures: [], datastore: { status: 'healthy' },
    })
    expect(runtime.withBehaviorOrganization('Vaquum', () => runtime.getBehaviorsRuntimeHealth())).toMatchObject({
      status: 'degraded', failures: [{ behavior: 'review-new-prs', consecutiveFailures: 1 }],
      datastore: { status: 'unavailable' },
    })
    expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({
      status: 'degraded', failures: [{ org: 'Vaquum', behavior: 'review-new-prs' }],
    })
  })

  it('rejects freshness reported for a different database without affecting legacy health', async () => {
    const { behaviors: runtime, rows } = await arrangeOrganizations()
    await runtime.setEnabled('review-new-prs', true)
    rows.set('beta', [pull('beta', 18)])
    const original = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation((command: string, args: string[], options: unknown) => {
      if (command === 'github-datastore' && args[0] === '--db' && args[2] === 'health') return datastoreHealthOutput()
      return original(command, args, options)
    })
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(runtime.withBehaviorOrganization('beta', () => runtime.getBehaviorsRuntimeHealth()).datastore.error).toContain('different account database')
    expect(runtime.withBehaviorOrganization('Vaquum', () => runtime.getBehaviorsRuntimeHealth()).datastore.status).toBe('healthy')
  })

  it('stops a removed organization during an in-flight scan and never falls back to the default database', async () => {
    const { database: db, behaviors: runtime, rows } = await arrangeOrganizations()
    await runtime.withBehaviorOrganization('beta', () => runtime.setEnabled('review-new-prs', true))
    rows.set('beta', [pull('beta', 18)])
    const original = mocks.runFile.getMockImplementation()!
    const entered = deferred<void>()
    const held = deferred<void>()
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command === 'github-datastore' && args[0] === '--db' && args[2] === 'health') {
        entered.resolve()
        await held.promise
      }
      return original(command, args, options)
    })
    const scan = runtime.runEnabledBehaviorsOnce()
    await entered.promise
    db.db.prepare("DELETE FROM organizations WHERE login = 'beta'").run()
    held.resolve()
    await scan
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(db.hasSeen('review-new-prs', 'beta/poise-test#18')).toBe(false)
    db.setMeta('org', '')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    mocks.runFile.mockClear()
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.runFile).not.toHaveBeenCalled()
  })

  it('inherits global preferences when an added account becomes ready without absorbing its open PRs', async () => {
    const { database: db, behaviors: runtime, rows } = await arrangeOrganizations()
    db.db.prepare("UPDATE organizations SET status = 'initializing' WHERE login = 'beta'").run()
    rows.set('Vaquum', [pull('Vaquum', 17)])
    rows.set('beta', [pull('beta', 17)])
    runtime.setSetting('review-new-prs', 'p1')
    runtime.setScratchpad('review-new-prs', 'shared instructions')
    await runtime.setEnabled('review-new-prs', true)
    expect(db.hasSeen('review-new-prs', 'Vaquum/poise-test#17')).toBe(true)
    db.db.prepare("UPDATE organizations SET status = 'ready' WHERE login = 'beta'").run()
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toEqual(expect.arrayContaining(['--p', 'p1', '--note', 'shared instructions']))
    expect(db.listBehaviorLaunchClaims('review-new-prs').map((claim) => claim.launchRepo)).toEqual(['beta/poise-test'])
    expect(db.getMeta('org:beta:behavior_review_new_prs_enabled')).toBeNull()
    expect(db.hasSeen('review-new-prs', '__snapshot_v3__:org:beta')).toBe(true)
  })

  it('adopts already-added accounts on restart when the global legacy behavior was active', async () => {
    const { database: db, behaviors: runtime, rows } = await arrangeOrganizations()
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    rows.set('beta', [pull('beta', 17)])
    await runtime.stopBehaviorsRuntime()
    const restarted = await restartModules()
    restarted.behaviors.startBehaviorsRuntime()
    await restarted.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(restarted.database.listBehaviorLaunchClaims('review-new-prs').map((claim) => claim.launchRepo)).toEqual(['beta/poise-test'])
    expect(restarted.database.hasSeen('review-new-prs', '__snapshot_v3__')).toBe(true)
  })

  it('retries a failed initial account baseline after restart without treating it as expanded coverage', async () => {
    const { database: db, behaviors: runtime, rows } = await arrangeOrganizations()
    rows.set('Vaquum', [pull('Vaquum', 17)])
    rows.set('beta', [pull('beta', 17)])
    const original = mocks.runFile.getMockImplementation()!
    let failBeta = true
    mocks.runFile.mockImplementation((command: string, args: string[], options: unknown) => {
      if (failBeta && command === 'github-datastore' && args[0] === '--db' && args[2] === 'health') {
        throw new Error('beta database unavailable')
      }
      return original(command, args, options)
    })
    await runtime.setEnabled('review-new-prs', true)
    expect(db.hasSeen('review-new-prs', '__snapshot_v3__')).toBe(true)
    expect(db.hasSeen('review-new-prs', '__snapshot_v3__:org:beta')).toBe(false)
    expect(db.getMeta('org:beta:behavior_review_new_prs_initial_baseline')).toBe('1')
    expect(runtime.getBehaviorsRuntimeHealth().failures).toMatchObject([{ org: 'beta', behavior: 'review-new-prs' }])
    failBeta = false
    const restarted = await restartModules()
    rows.set('beta', [pull('beta', 17), pull('beta', 18)])
    restarted.behaviors.startBehaviorsRuntime()
    await restarted.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(restarted.database.hasSeen('review-new-prs', 'beta/poise-test#18')).toBe(true)
    rows.set('beta', [pull('beta', 17), pull('beta', 18), pull('beta', 19)])
    await restarted.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(restarted.database.listBehaviorLaunchClaims('review-new-prs')[0].launchPr).toBe(19)
  })

  it('waits for scans in every account, including a removed account, before acknowledging global disable', async () => {
    const { database: db, behaviors: runtime, rows } = await arrangeOrganizations()
    await runtime.setEnabled('review-new-prs', true)
    rows.set('Vaquum', [pull('Vaquum', 18)])
    rows.set('beta', [pull('beta', 18)])
    const original = mocks.runFile.getMockImplementation()!
    const legacyHeld = deferred<void>()
    const betaHeld = deferred<void>()
    const entered = new Set<string>()
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command === 'github-datastore' && args.includes('view')) {
        const beta = args[0] === '--db'
        entered.add(beta ? 'beta' : 'Vaquum')
        await (beta ? betaHeld.promise : legacyHeld.promise)
      }
      return original(command, args, options)
    })
    const scan = runtime.runEnabledBehaviorsOnce()
    await vi.waitFor(() => expect(entered.size).toBe(2))
    db.db.prepare("DELETE FROM organizations WHERE login = 'beta'").run()
    const disable = runtime.setEnabled('review-new-prs', false)
    let settled = false
    void disable.then(() => { settled = true })
    expect(runtime.getEnabledMap()['review-new-prs']).toBe(false)
    legacyHeld.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)
    betaHeld.resolve()
    await Promise.all([scan, disable])
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(db.listBehaviorLaunchClaims('review-new-prs')).toEqual([])
  })

  it('never republishes a queued global enable after a later disable', async () => {
    const { behaviors: runtime, rows } = await arrangeOrganizations()
    await runtime.setEnabled('review-new-prs', true)
    rows.set('Vaquum', [pull('Vaquum', 18)])
    rows.set('beta', [pull('beta', 18)])
    const original = mocks.runFile.getMockImplementation()!
    const held = deferred<void>()
    let entered = 0
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: unknown) => {
      if (command === 'github-datastore' && args.includes('view')) {
        entered += 1
        await held.promise
      }
      return original(command, args, options)
    })
    const scan = runtime.runEnabledBehaviorsOnce()
    await vi.waitFor(() => expect(entered).toBe(2))
    const enable = runtime.setEnabled('review-new-prs', true)
    const disable = runtime.setEnabled('review-new-prs', false)
    held.resolve()
    await Promise.all([scan, enable, disable])
    expect(runtime.getEnabledMap()['review-new-prs']).toBe(false)
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('reports the latest resolve event across ready accounts while retaining scoped diagnostics', async () => {
    const { database: db, behaviors: runtime } = await arrangeOrganizations()
    const legacy = { at: '2026-09-30T10:00:00.000Z', target: 'Vaquum/poise-test#17' }
    const beta = { at: '2026-10-01T10:00:00.000Z', target: 'beta/poise-test#17' }
    db.setMeta('behavior_resolve_unblocking_last_fired', JSON.stringify(legacy))
    db.setMeta('org:beta:behavior_resolve_unblocking_last_fired', JSON.stringify(beta))
    expect(runtime.getResolveUnblockingLastFired()).toEqual(beta)
    expect(runtime.withBehaviorOrganization('Vaquum', runtime.getResolveUnblockingLastFired)).toEqual(legacy)
    db.db.prepare("UPDATE organizations SET status = 'error' WHERE login = 'beta'").run()
    expect(runtime.getResolveUnblockingLastFired()).toEqual(legacy)
  })

  it('disables every account but keeps per-account reconciliation and incident ownership', async () => {
    const { database: db, behaviors: runtime } = await arrangeOrganizations()
    for (const owner of ['Vaquum', 'beta']) {
      const target = `${owner}/poise-test#17`
      db.recordSeen('approve-prs', target)
      const claimId = db.claimSeenOwned('review-new-prs', target)!
      db.markBehaviorLaunchIntentOwned({
        key: 'review-new-prs', target, claimId, launchBehavior: 'pr_review', repo: `${owner}/poise-test`,
        pr: 17, requestedAt: new Date(Date.now() - runtime.BEHAVIOR_REGISTRATION_GRACE_MS - 1).toISOString(),
        expectedHead: HEAD_SHA, actor: 'review-bot', source: 'poise:review-new-prs', correlationId: claimId,
      })
      db.recordBehaviorDeadLetter(db.listBehaviorLaunchClaims('review-new-prs').find((claim) => claim.target === target)!, 'old error')
    }
    await runtime.withBehaviorOrganization('beta', () => runtime.setEnabled('approve-prs', false))
    expect(db.hasSeen('approve-prs', 'Vaquum/poise-test#17')).toBe(false)
    expect(db.hasSeen('approve-prs', 'beta/poise-test#17')).toBe(false)
    const legacyBefore = db.listBehaviorLaunchClaims('review-new-prs').find((claim) => claim.launchRepo === 'Vaquum/poise-test')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    await runtime.withBehaviorOrganization('beta', () => runtime.runEnabledBehaviorsOnce())
    expect(db.listBehaviorLaunchClaims('review-new-prs').find((claim) => claim.launchRepo === 'Vaquum/poise-test')).toEqual(legacyBefore)
    expect(db.listBehaviorDeadLetters().map((letter) => letter.repo)).toContain('Vaquum/poise-test')
    expect(runtime.withBehaviorOrganization('beta', () => runtime.getBehaviorsRuntimeHealth()).deadLetters.every((letter) => letter.repo?.startsWith('beta/'))).toBe(true)
    expect(db.listBehaviorDeadLetters(1, 'Vaquum')[0]?.repo).toBe('Vaquum/poise-test')
  })
})
