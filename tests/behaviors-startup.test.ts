import { describe, expect, it, vi } from 'vitest'
import { mocks, pr, HEAD_SHA, externalCalls, loadModules, restartModules, arrangeCli, agentLog, datastoreHealthOutput, deferred, fixture } from './behaviors-runtime-fixture'

describe('startup snapshots and recovery', () => {

  it('preserves the startup ledger and catches a PR opened during downtime', async () => {
    arrangeCli(false)
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    mocks.authStatus = 'reauth_required'

    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()
    expect(externalCalls()).toEqual([])

    mocks.authStatus = 'authenticated'
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(db.claimSeen('review-new-prs', `${pr.repo}#${pr.number}`)).toBe(false)
  })

  it('migrates v2 in place and reviews a PR first seen during downtime', async () => {
    const downtimePr = {
      repo: 'Vaquum/downtime-test',
      number: 18,
      url: 'https://github.com/Vaquum/downtime-test/pull/18',
      status: 'open',
      author: 'poise-user',
      draft: 0,
      updated_at: '2026-07-15T12:00:00Z',
    }
    fixture.listedPrs = [pr, downtimePr]
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '2')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', `${pr.repo}#${pr.number}@legacy-head`)
    db.recordSeen('review-new-prs', '__snapshot_v2__')

    await runtime.runEnabledBehaviorsOnce()

    expect(db.getMeta('behavior_review_new_prs_keyver')).toBe('3')
    expect(db.hasSeen('review-new-prs', '__snapshot_v3__')).toBe(true)
    expect(db.hasSeen('review-new-prs', `${pr.repo}#${pr.number}`)).toBe(true)
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toContain(`#${downtimePr.number}`)
  })

  it('re-arms a snapshot-only PR after a failed reviewer attempt', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.setMeta('behavior_review_new_prs_failed_snapshot_recovery_v1', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    db.recordSeen('review-new-prs', `${pr.repo}#${pr.number}`)
    fixture.agentLogs = [agentLog({
      actor: 'review-bot',
      source: null,
      correlation_id: null,
      status: 'failed',
      started_at: '2026-07-15T11:59:00.000Z',
      started_at_precise: '2026-07-15T11:59:00.001Z',
      error: 'authentication failed',
    })]

    await runtime.runEnabledBehaviorsOnce()

    expect(db.getMeta('behavior_review_new_prs_snapshot_recovery_v2')).toBe('1')
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toContain(`#${pr.number}`)
  })

  it('re-arms a snapshot-only PR missed by a mature runtime', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-30T06:21:21.370Z'))
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.setMeta('behavior_review_new_prs_failed_snapshot_recovery_v1', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    db.recordSeen('review-new-prs', `${pr.repo}#${pr.number}`)
    fixture.agentLogs = [agentLog({
      repo: 'Vaquum/previous',
      pr_id: '16',
      actor: 'review-bot',
      status: 'completed',
      action: 'reviewed_clean',
      outcome: 'clean',
      head_sha: HEAD_SHA,
      started_at: '2026-07-29T18:01:09.127Z',
      completed_at: '2026-07-29T18:07:51.000Z',
    })]

    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toContain(`#${pr.number}`)
  })

  it.each(['missing', 'duplicate'] as const)('holds ambiguous snapshot recovery (%s) while unrelated fresh PRs start', async (corruption) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-30T06:21:21.370Z'))
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.setMeta('behavior_review_new_prs_failed_snapshot_recovery_v1', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    db.recordSeen('review-new-prs', `${pr.repo}#${pr.number}`)
    const failed = agentLog({
      id: 'a'.repeat(32), status: 'failed', error: 'provider failed',
      started_at: '2026-07-29T18:01:09.127Z', started_at_precise: '2026-07-29T18:01:09.127Z',
    })
    fixture.agentLogs = corruption === 'duplicate'
      ? [failed, { id: failed.id, repo: 'other/unrelated', pr_id: '999' }]
      : [{ repo: pr.repo, pr_id: String(pr.number), behavior: 'pr_review', corrupt: true }]
    fixture.listedPrs.push({ ...pr, number: 18, url: `https://github.com/${pr.repo}/pull/18` })
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toContain('#18')
    expect(db.getMeta('behavior_review_new_prs_snapshot_recovery_v2')).not.toBe('1')
    expect(db.hasSeen('review-new-prs', `${pr.repo}#${pr.number}`)).toBe(true)

    // Rotation or a revised failure cannot erase the earlier uncertainty.
    fixture.agentLogs = [failed]
    await runtime.runEnabledBehaviorsOnce()
    fixture.agentLogs = []
    const loaded = await restartModules()
    loaded.behaviors.startBehaviorsRuntime()
    await loaded.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(loaded.database.listBehaviorIncidents()).toEqual([
      expect.objectContaining({ target: `${pr.repo}#17`, error: 'snapshot review evidence is unreadable' }),
    ])
    // A valid positive result resolves a snapshot's missing review evidence.
    fixture.agentLogs = [{ ...failed, status: 'completed', action: 'reviewed_clean', outcome: 'clean', head_sha: HEAD_SHA, completed_at: new Date().toISOString(), error: '' }]
    await loaded.behaviors.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(loaded.database.getMeta('behavior_review_new_prs_snapshot_recovery_v2')).toBe('1')
    expect(loaded.database.listBehaviorIncidents()).toEqual([])
  })

  it('takes the anti-flood snapshot only when the startup ledger is missing', async () => {
    arrangeCli(false)
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    fixture.agentLogs = [agentLog({
      repo: 'Vaquum/previous',
      pr_id: '16',
      actor: 'review-bot',
      status: 'completed',
      action: 'reviewed_clean',
      outcome: 'clean',
      head_sha: HEAD_SHA,
    })]
    mocks.authStatus = 'reauth_required'

    runtime.startBehaviorsRuntime()
    await vi.waitFor(() => expect(db.hasSeen('review-new-prs', '__snapshot_v3__')).toBe(true))
    mocks.authStatus = 'authenticated'
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(db.claimSeen('review-new-prs', `${pr.repo}#${pr.number}`)).toBe(false)
  })

  it('rearms the scheduler while a behavior scan is still busy', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:00.100Z'))
    const scan = deferred<{ stdout: string, stderr: string }>()
    mocks.runFile.mockImplementation((command: string, args: string[]) => {
      if (command === 'github-datastore' && args[0] === 'health') {
        return Promise.resolve(datastoreHealthOutput())
      }
      if (command === 'github-datastore' && args[0] === 'view') return scan.promise
      throw new Error(`unexpected CLI call: ${command} ${args.join(' ')}`)
    })
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_resolve_unblocking_enabled', '1')
    runtime.startBehaviorsRuntime()

    try {
      await vi.advanceTimersByTimeAsync(runtime.BEHAVIOR_TICK_MS)
      await vi.waitFor(() => expect(mocks.runFile).toHaveBeenCalledTimes(2))
      const firstTick = runtime.getBehaviorsRuntimeHealth().lastTickAt
      expect(runtime.getBehaviorsRuntimeHealth().busy).toEqual([
        expect.objectContaining({ behavior: 'resolve-unblocking' }),
      ])

      await vi.advanceTimersByTimeAsync(runtime.BEHAVIOR_TICK_MS)
      expect(runtime.getBehaviorsRuntimeHealth().lastTickAt).not.toBe(firstTick)
      expect(mocks.runFile).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(runtime.getBehaviorsRuntimeHealth().status).toBe('degraded')
    } finally {
      scan.resolve({ stdout: '[]', stderr: '' })
      await vi.advanceTimersByTimeAsync(0)
    }
  })
})
