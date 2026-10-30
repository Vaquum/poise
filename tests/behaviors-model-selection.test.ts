import { describe, expect, it } from 'vitest'
import { mocks, loadModules, arrangeCli } from './behaviors-runtime-fixture'

describe('scheduled review model selection', () => {
  it.each(['review-new-prs', 'approve-prs'] as const)('runs %s with Astra during a Claude outage', async (behavior) => {
    arrangeCli(behavior === 'approve-prs')
    mocks.spawnDetached.mockResolvedValue(undefined)
    mocks.authStatus = 'reauth_required'
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('reviewModel', 'astra')
    db.setMeta(`behavior_${behavior.replace(/-/g, '_')}_enabled`, '1')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalledTimes(1)
    expect(mocks.spawnDetached.mock.calls[0][1]).toEqual(expect.arrayContaining(['--model', 'gpt-6-astra-ultra', '--recovery-model', 'opus-5-xhigh']))
    expect(mocks.requireAuth).not.toHaveBeenCalled()
  })

  it('does not launch an outdated selection when it changes during preflight', async () => {
    arrangeCli(false)
    mocks.spawnDetached.mockResolvedValue(undefined)
    const { database: db, behaviors: runtime } = await loadModules()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    mocks.requireAuth.mockImplementation(() => { db.setMeta('models', JSON.stringify({ pr_review: { default: 'gpt-6-astra-ultra', fallback: 'opus-5-xhigh' } })) })
    runtime.startBehaviorsRuntime()
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toEqual(expect.arrayContaining(['--model', 'gpt-6-astra-ultra']))
  })
})
