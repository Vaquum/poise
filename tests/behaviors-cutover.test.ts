import { describe, expect, it, vi } from 'vitest'
import { arrangeCli, deferred, loadModules, mocks, pr } from './behaviors-runtime-fixture'
import type { NativeChainHooks } from '../server/behavior-chain-native'

describe('cutover launch boundary', () => {
  it('routes implementation/repair switches and notes into the actual native admission hooks', async () => {
    arrangeCli()
    const { database: db, behaviors: runtime } = await loadModules()
    const native = await import('../server/behavior-chain-native')
    let hooks: NativeChainHooks | null = null
    const original = native.nativeChainOperations
    vi.spyOn(native, 'nativeChainOperations').mockImplementation((org, passed) => {
      hooks = passed
      return { ...original(org, passed), enabled: () => false }
    })
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_chain_settings', JSON.stringify({ enabled: true, seedMode: 'label', label: 'poise' }))
    await runtime.runEnabledBehaviorsOnce()
    const captured = hooks as NativeChainHooks | null
    if (!captured) throw new Error('native hooks were not installed')
    const journal = (await import('../server/behavior-chain-journal')).behaviorChainJournal()
    const chain = journal.append('vaquum/poise-test#7', 'control-seed', 0, { type: 'chain.admitted', repository: 'Vaquum/poise-test', issue: 7,
      branch: 'poise/issue-7', author: 'poise-user', reviewer: 'review-bot' })
    const decision = (behavior: 'implement-issue' | 'repair-pr') => ({ kind: 'invoke' as const, behavior, actor: 'poise-user', reviewer: null, basis: 'head', reason: 'required work' })
    expect(captured.permitted(chain, decision('implement-issue'))).toBe(true)
    await runtime.setEnabled('implement-issues', false)
    expect(captured.permitted(chain, decision('implement-issue'))).toBe(false)
    expect(captured.permitted(chain, decision('repair-pr'))).toBe(true)
    await runtime.setPaused('repair-prs', new Date(Date.now() + 60_000).toISOString(), 'person')
    expect(captured.permitted(chain, decision('repair-pr'))).toBe(false)
    runtime.setScratchpad('repair-prs', 'Preserve all CI gates.')
    expect(captured.note('repair-pr')).toBe('Preserve all CI gates.')
  })
  it('fences an already preparing legacy review without cancelling it or starting its worker', async () => {
    arrangeCli()
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    const { prepareModelClis } = await import('../server/provider-clis')
    const entered = deferred<void>(), ready = deferred<NodeJS.ProcessEnv>()
    vi.mocked(prepareModelClis).mockImplementationOnce(() => { entered.resolve(); return ready.promise })
    const cycle = runtime.runEnabledBehaviorsOnce()
    await entered.promise
    const journal = (await import('../server/behavior-chain-journal')).behaviorChainJournal()
    journal.changeAdmission(0, 'draining')
    const { behaviorCutoverBlockers } = await import('../server/behavior-cutover')
    expect(behaviorCutoverBlockers().join(';')).toContain('behavior operation')
    ready.resolve({})
    await cycle
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(runtime.isRunnable('review-new-prs')).toBe(false)
    journal.changeAdmission(journal.cutover().sequence, 'v1')
    expect(runtime.isRunnable('review-new-prs')).toBe(true)
  })

  it('preserves only the recorded legacy PR boundary and keeps new behavior controls independent', async () => {
    const { database: db, behaviors: runtime } = await loadModules()
    const journal = (await import('../server/behavior-chain-journal')).behaviorChainJournal()
    const { legacyBehaviorOwns } = await import('../server/behavior-cutover')
    expect(legacyBehaviorOwns(pr.repo, pr.number)).toBe(true)
    journal.changeAdmission(0, 'draining')
    expect(legacyBehaviorOwns(pr.repo, pr.number)).toBe(false)
    journal.changeAdmission(journal.cutover().sequence, 'v2', [`${pr.repo}#${pr.number}`])
    expect(legacyBehaviorOwns(pr.repo.toUpperCase(), pr.number)).toBe(true)
    expect(legacyBehaviorOwns(pr.repo, pr.number + 1)).toBe(false)
    const lease = db.claimPrOperationOwned(`${pr.repo}#${pr.number}`, 60_000)
    expect(lease).toBeTruthy()
    const { behaviorCutoverBlockers } = await import('../server/behavior-cutover')
    expect(behaviorCutoverBlockers().join(';')).toContain('reserved PR operation')
    db.releasePrOperationOwned(lease!)
    expect(runtime.isRunnable('implement-issues')).toBe(true)
    expect(runtime.isRunnable('repair-prs')).toBe(true)
    await runtime.setEnabled('repair-prs', false)
    expect(runtime.isRunnable('repair-prs')).toBe(false)
    expect(runtime.isRunnable('implement-issues')).toBe(true)
    db.setMeta('behavior_implement_issues_paused_until', new Date(Date.now() + 60_000).toISOString())
    expect(runtime.isRunnable('implement-issues')).toBe(false)
    runtime.setScratchpad('repair-prs', 'Keep existing assertions.')
    expect(runtime.getScratchpad('repair-prs')).toBe('Keep existing assertions.')
  })
})
