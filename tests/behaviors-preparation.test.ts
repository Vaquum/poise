import { describe, expect, it, vi } from 'vitest'
import { mocks, pr, externalCalls, loadModules, arrangeCli, deferred, fixture } from './behaviors-runtime-fixture'

describe('provider preparation and authentication', () => {

  it.each(['review-new-prs', 'approve-prs'] as const)('bounded provider preparation: %s launches after a 90-second CLI check', async (behavior) => {
    vi.useFakeTimers()
    // Node's native AbortSignal.timeout is not driven by Vitest's clock.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms)
      return controller.signal
    })
    arrangeCli(behavior === 'approve-prs')
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    db.setMeta(`behavior_${behavior.replaceAll('-', '_')}_enabled`, '1')
    const { prepareModelClis } = await import('../server/provider-clis')
    const entered = deferred<void>(), checked = deferred<NodeJS.ProcessEnv>()
    vi.mocked(prepareModelClis).mockImplementationOnce(() => {
      entered.resolve()
      return checked.promise
    })
    const cycle = runtime.runEnabledBehaviorsOnce()
    await entered.promise
    await vi.advanceTimersByTimeAsync(90_000)
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(runtime.getBehaviorsRuntimeHealth().failures.filter(row => row.kind === 'operation')).toEqual([])
    expect(runtime.getBehaviorsRuntimeHealth().busy).toEqual(expect.arrayContaining([
      expect.objectContaining({ behavior, phase: 'provider-preparation' }),
    ]))
    // A resolver, other runtime or operator cannot take the same PR while
    // preparation is still pending beyond the original 65-second lease.
    expect(db.claimPrOperationOwned(`${pr.repo}#${pr.number}`, 65_000)).toBeNull()
    checked.resolve({})
    await cycle
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(runtime.getBehaviorsRuntimeHealth().failures.filter(row => row.kind === 'operation')).toEqual([])
  })

  it.each(['review-new-prs', 'approve-prs'] as const)('parallel provider preparation: %s retains a peer reservation through ordinary launch work', async (behavior) => {
    vi.useFakeTimers()
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms)
      return controller.signal
    })
    arrangeCli(behavior === 'approve-prs')
    const ordinaryCli = mocks.runFile.getMockImplementation()!
    const authEntered = deferred<void>(), authReady = deferred<void>()
    const headEntered = deferred<void>(), headReady = deferred<void>()
    const checkoutEntered = deferred<void>(), checkoutReady = deferred<void>()
    let afterFastPreparation = false
    let fastPr: typeof pr | undefined
    mocks.runFile.mockImplementation(async (command, args, options) => {
      if (afterFastPreparation && command === 'github-interface' && args[0] === '--head-sha' && !fastPr) {
        fastPr = fixture.listedPrs.find(row => '#' + row.number === args[1])!
        headEntered.resolve()
        await headReady.promise
      }
      if (fastPr && command === 'github-interface' && args[0] === '--local-checkout-path'
        && `${args[1]}/${args[2]}` === fastPr.repo) {
        checkoutEntered.resolve()
        await checkoutReady.promise
      }
      return ordinaryCli(command, args, options)
    })
    fixture.listedPrs = [pr, { ...pr, repo: 'Vaquum/poise-peer', number: 18, url: 'https://github.com/Vaquum/poise-peer/pull/18' }]
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    // Drive just this manual cycle, without a wall-clock tick launching more
    // evaluations while the two controlled preparations are in flight.
    vi.clearAllTimers()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    db.setMeta(`behavior_${behavior.replaceAll('-', '_')}_enabled`, '1')
    const { prepareModelClis } = await import('../server/provider-clis')
    const entered = deferred<void>(), fast = deferred<NodeJS.ProcessEnv>(), slow = deferred<NodeJS.ProcessEnv>()
    let preparations = 0
    vi.mocked(prepareModelClis).mockImplementationOnce(() => {
      if (++preparations === 2) entered.resolve()
      return fast.promise
    }).mockImplementationOnce(() => {
      if (++preparations === 2) entered.resolve()
      return slow.promise
    })
    const cycle = runtime.runEnabledBehaviorsOnce()
    await entered.promise
    // Each ordinary call takes less than its own 30-second timeout. Their
    // combined work outlives 65 seconds while the peer keeps the clock paused.
    mocks.requireAuth.mockImplementationOnce(() => {
      authEntered.resolve()
      return authReady.promise
    })
    afterFastPreparation = true
    fast.resolve({})
    await authEntered.promise
    await vi.advanceTimersByTimeAsync(25_000)
    authReady.resolve()
    await headEntered.promise
    await vi.advanceTimersByTimeAsync(25_000)
    headReady.resolve()
    await checkoutEntered.promise
    await vi.advanceTimersByTimeAsync(16_000)
    const competing = db.claimPrOperationOwned(`${fastPr!.repo}#${fastPr!.number}`, 65_000)
    if (competing) db.releasePrOperationOwned(competing)
    await vi.advanceTimersByTimeAsync(9_000)
    checkoutReady.resolve()
    slow.resolve({})
    await cycle
    expect(competing).toBeNull()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(2)
    expect(runtime.getBehaviorsRuntimeHealth().failures.filter(row => row.kind === 'operation')).toEqual([])
  })

  it('pauses Claude-backed behaviors before external work and resumes once authenticated', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    mocks.authStatus = 'reauth_required'
    await runtime.runEnabledBehaviorsOnce()
    expect(externalCalls()).toEqual([])
    expect(mocks.spawnDetached).not.toHaveBeenCalled()

    mocks.authStatus = 'authenticated'
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  // A drain (the release controller's or the gateway's) pauses background
  // admission: a scheduled tick must not launch until it is lifted.
  it('launches nothing while background admission is paused and resumes after', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    const background = await import('../server/release-background')
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')

    background.pauseReleaseBackground()
    try {
      await runtime.runEnabledBehaviorsOnce()
      expect(externalCalls()).toEqual([])
      expect(mocks.spawnDetached).not.toHaveBeenCalled()
    } finally {
      background.resumeReleaseBackground()
    }
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })

  it('pauses approval work and resumes it once authenticated', async () => {
    arrangeCli(true)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_approve_prs_enabled', '1')

    mocks.authStatus = 'reauth_required'
    await runtime.runEnabledBehaviorsOnce()
    expect(externalCalls()).toEqual([])
    expect(mocks.spawnDetached).not.toHaveBeenCalled()

    mocks.authStatus = 'authenticated'
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
  })
})
