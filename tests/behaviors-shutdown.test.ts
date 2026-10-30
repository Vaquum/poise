import { describe, expect, it, vi } from 'vitest'
import { CATALOG_STDOUT } from './model-catalog-fixture'
import { mocks, pr, HEAD_SHA, externalCalls, loadModules, arrangeCli, datastoreHealthOutput, deferred, fixture } from './behaviors-runtime-fixture'

describe('disable and shutdown admission', () => {

  it('waits for an in-flight tick to stop before acknowledging disable', async () => {
    const scan = deferred<{ stdout: string, stderr: string }>()
    mocks.runFile.mockImplementation((command: string, args: string[]) => {
      if (command === 'github-datastore' && args[0] === 'health') {
        return Promise.resolve(datastoreHealthOutput())
      }
      if (command === 'github-datastore' && args[0] === 'view') return scan.promise
      if (command === 'agent-interface' && args[0] === '--models') return Promise.resolve({ stdout: CATALOG_STDOUT, stderr: '' })
      throw new Error(`unexpected CLI call: ${command} ${args.join(' ')}`)
    })
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    const tick = runtime.runEnabledBehaviorsOnce()
    await vi.waitFor(() => expect(externalCalls()).toHaveLength(2))
    const disable = runtime.setEnabled('review-new-prs', false)
    let disabled = false
    void disable.then(() => { disabled = true })
    await Promise.resolve()
    expect(disabled).toBe(false)

    scan.resolve({ stdout: JSON.stringify(fixture.listedPrs), stderr: '' })
    await Promise.all([tick, disable])

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(runtime.isEnabled('review-new-prs')).toBe(false)
    expect(db.hasSeen('review-new-prs', '__snapshot_v3__')).toBe(true)
  })

  it('resumes with PRs that appeared while review was disabled', async () => {
    fixture.listedPrs = []
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    await runtime.setEnabled('review-new-prs', false)
    fixture.listedPrs = [pr]
    await runtime.setEnabled('review-new-prs', true)
    await runtime.runEnabledBehaviorsOnce()

    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toContain(`#${pr.number}`)
  })

  it.each(['review-new-prs', 'approve-prs'] as const)('settles admitted %s work when operation ownership is lost before spawn', async (behavior) => {
    arrangeCli(behavior === 'approve-prs')
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta(`behavior_${behavior.replace(/-/g, '_')}_enabled`, '1')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    const base = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options?: { cwd?: string }) => {
      const result = await base(command, args, options)
      if (command === 'github-interface' && args[0] === '--head-sha') {
        db.db.prepare("DELETE FROM behavior_seen WHERE key = 'pr-operation'").run()
      }
      return result
    })
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(db.listBehaviorLaunchClaims(behavior)).toEqual([])
    expect(mocks.captureAdmission).toHaveBeenCalledOnce()
    expect(mocks.captureOutcome).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      nativeId: mocks.captureAdmission.mock.calls[0][0].nativeId,
      state: 'failed', activity: 'settled', stateSource: 'native', outcome: 'preflight_failed',
    }))
    expect(runtime.getBehaviorsRuntimeHealth().failures).toContainEqual(expect.objectContaining({
      error: expect.stringContaining('operation ownership was lost'),
    }))
  })

  // The enabled flag is re-read immediately before the head-SHA lookup, but
  // that lookup is a subprocess. Nothing checked again between it returning and
  // the agent being spawned, so a toggle-off during that window still posted a
  // review on the pull request the user was trying to stop.
  it('does not launch after disable during the head-SHA lookup', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const headSha = deferred<{ stdout: string, stderr: string }>()
    const base = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === 'github-interface' && args[0] === '--head-sha') return headSha.promise
      return base(command, args, options)
    })
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    const tick = runtime.runEnabledBehaviorsOnce()
    await vi.waitFor(() => expect(mocks.runFile.mock.calls.some(
      (c: unknown[]) => c[0] === 'github-interface' && (c[1] as string[])[0] === '--head-sha',
    )).toBe(true))
    const disable = runtime.setEnabled('review-new-prs', false)
    headSha.resolve({
      stdout: JSON.stringify({ action: 'head_sha', repository: pr.repo, pull_number: pr.number, head_sha: HEAD_SHA }),
      stderr: '',
    })
    await Promise.all([tick, disable])

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(runtime.isEnabled('review-new-prs')).toBe(false)
  })

  // The ceiling decides which pull requests get acted on. A tick fans out over
  // every open PR and each one waits on auth, a checkout resolve and the
  // head-SHA subprocess, so narrowing the ceiling took effect on screen
  // immediately while the run already under way kept spawning at the old one.
  it('uses the ceiling as it stands at spawn, not as it was when the tick began', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const headSha = deferred<{ stdout: string, stderr: string }>()
    const base = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command: string, args: string[], options?: { cwd?: string }) => {
      if (command === 'github-interface' && args[0] === '--head-sha') return headSha.promise
      return base(command, args, options)
    })
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    runtime.setSetting('review-new-prs', 'p4')

    const tick = runtime.runEnabledBehaviorsOnce()
    await vi.waitFor(() => expect(mocks.runFile.mock.calls.some(
      (c: unknown[]) => c[0] === 'github-interface' && (c[1] as string[])[0] === '--head-sha',
    )).toBe(true))
    // The person dials the ceiling back while the head-SHA lookup is out.
    runtime.setSetting('review-new-prs', 'p0')
    headSha.resolve({
      stdout: JSON.stringify({ action: 'head_sha', repository: pr.repo, pull_number: pr.number, head_sha: HEAD_SHA }),
      stderr: '',
    })
    await tick

    expect(mocks.spawnDetached).toHaveBeenCalled()
    const args = mocks.spawnDetached.mock.calls[0][1] as string[]
    expect(args[args.indexOf('--p') + 1]).toBe('p0')
  })

  it('does not launch after disable during the final auth gate', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const finalGate = deferred<void>()
    mocks.requireAuth
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(finalGate.promise)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    const tick = runtime.runEnabledBehaviorsOnce()
    await vi.waitFor(() => expect(mocks.requireAuth).toHaveBeenCalledTimes(2))
    const disable = runtime.setEnabled('review-new-prs', false)
    finalGate.resolve(undefined)
    await Promise.all([tick, disable])

    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(runtime.isEnabled('review-new-prs')).toBe(false)
  })
})
