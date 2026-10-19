import { describe, expect, it } from 'vitest'
import { mocks, loadModules, arrangeCli } from './behaviors-runtime-fixture'

describe('the agent account the behaviors act as', () => {
  it('is read from Settings when it is needed, and reported with where to set it while missing', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('agentAccount', '')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    runtime.startBehaviorsRuntime()
    expect(runtime.getBehaviorsRuntimeHealth()).toMatchObject({
      status: 'degraded',
      identity: { status: 'invalid', actor: null, error: expect.stringContaining('No agent account is set. Set it in Settings → GitHub') },
    })
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()

    db.setMeta('agentAccount', 'other-bot')
    expect(runtime.getBehaviorsRuntimeHealth().identity).toEqual({ status: 'valid', actor: 'other-bot', error: null })
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    const args = mocks.spawnDetached.mock.calls[0][1] as string[]
    expect(args[args.indexOf('--actor') + 1]).toBe('other-bot')
    const headChecks = mocks.runFile.mock.calls.filter(([command, args]) => command === 'github-interface' && args[0] === '--head-sha')
    expect(headChecks.length).toBeGreaterThan(0)
    for (const [, args] of headChecks) expect(args.slice(-2)).toEqual(['--token-user', 'other-bot'])
  })
})
