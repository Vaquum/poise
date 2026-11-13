import { describe, expect, it, vi } from 'vitest'
import { arrangeCli, deferred, HEAD_SHA, loadModules, mocks, pr } from './behaviors-runtime-fixture'
import type { NativeChainHooks } from '../server/behavior-chain-native'
import type { ChainRuntimeOperations } from '../server/behavior-chain-runtime'
import type { ChainObservation } from '../server/behavior-chain-decision'
import type { ChainInvocation } from '../server/behavior-chain-store'
import type { LogEntry } from '../server/agent-log-parse'
import { parseProcessDiagnostic } from '../server/process-diagnostic'

vi.mock('../server/chat/control', () => ({ readOpenPrClosingRefs: vi.fn() }))

describe('cutover launch boundary', () => {
  it.each(['review_inspection_timeout', 'review_budget_exhausted'])(
    'retries local inspection after release while other reviews progress, but gates provider timeouts (%s)', async code => {
    arrangeCli()
    const { database: db, behaviors: runtime } = await loadModules()
    const native = await import('../server/behavior-chain-native')
    const { BehaviorChainRuntime } = await import('../server/behavior-chain-runtime')
    let captured: ChainRuntimeOperations | null = null
    const original = native.nativeChainOperations
    vi.spyOn(native, 'nativeChainOperations').mockImplementation((org, hooks) => {
      captured = original(org, hooks)
      return { ...captured, enabled: () => false }
    })
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_chain_settings', JSON.stringify({ enabled: true, seedMode: 'label', label: 'poise' }))
    db.setMeta('behavior_review_new_prs_reviewers', '1')
    const model = 'gpt-6-astra-ultra'
    db.setMeta('models', JSON.stringify({ slots: { primary: model, secondary: model, tertiary: model } }))
    await runtime.runEnabledBehaviorsOnce()
    db.setMeta('behavior_review_new_prs_enabled', '1')
    const operations = captured as ChainRuntimeOperations | null
    if (!operations) throw new Error('native operations were not installed')
    const journal = (await import('../server/behavior-chain-journal')).behaviorChainJournal()
    const seed = (number: number) => journal.append(`${pr.repo.toLowerCase()}#${number}`, `seed-${number}`, 0,
      { type: 'chain.admitted', repository: pr.repo, issue: number, branch: `poise/issue-${number}`, author: 'poise-user', reviewer: 'review-bot' })
    const first = seed(7)
    const reviewer = { slot: 'primary', model, recovery: model }
    const launches: ChainInvocation[] = []
    const calls: LogEntry[] = []
    const executor = new BehaviorChainRuntime(journal, { ...operations, enabled: () => true,
      discover: async () => [], available: () => true, capacity: () => 2, wake: () => {},
      observe: async chain => ({ checkedAt: Date.now(), existingPulls: [],
        issue: { open: true, eligible: true, revision: 'issue-revision', commentIds: [] },
        issueReviewers: [], prReviewers: [reviewer], implementer: reviewer, repairer: reviewer, approver: reviewer,
        publication: { pull_number: chain.issue + 10, head_sha: HEAD_SHA, head_invocation: null, state: 'open', merged: false, merge_sha: null },
        pull: { number: chain.issue + 10, head: HEAD_SHA, headSince: Date.now(), state: 'open', draft: false, merged: false,
          mergeSha: null, queueEntry: null, queueRemoval: null, changesRequested: false, unresolved: 0, approved: false, ready: false,
          reviewIds: [], reviewRevision: 'reviews', reviewContext: 'b'.repeat(64), reviewReceipts: [], greyRuns: [],
          pending: false, failing: [], conflict: false, behind: false } } satisfies ChainObservation),
      readInvocations: async () => ({ entries: calls, quarantined: [] }),
      launch: async invocation => {
        launches.push(invocation)
        calls.push({ id: String(launches.length).repeat(32), correlation_id: invocation.id, source: 'poise:behavior-chain',
          actor: invocation.actor, repo: pr.repo, behavior: 'pr_review', model, pr_id: invocation.request.argv[1].split('/').at(-1)!,
          session_id: null, prompt: '', started_at: new Date().toISOString(), time_elapsed: '1s', head_sha: null,
          expected_head: HEAD_SHA, response: null, error: '', status: 'running', action: null, outcome: null, resources_settled_at: null,
          resource_ownership: { version: 1, roots: [], errors: [] } })
        return true
      },
    })
    vi.useFakeTimers({ toFake: ['Date'] })
    await executor.run()
    const second = seed(8)
    await executor.run()
    expect(launches).toHaveLength(2)
    expect(journal.read(first.id)!.invocations[0].state).toBe('started')
    expect(journal.read(second.id)!.invocations[0].state).toBe('started')

    const diagnostic = parseProcessDiagnostic({ version: 1, source: 'caller', severity: 'error', operation: 'github-interface',
      phase: 'inspection', outcome: 'timed_out', stderr: '', stderr_truncated: false, timeout_seconds: 30,
      repository: pr.repo, pr: 17, expected_head: HEAD_SHA })!
    Object.assign(calls[0], { status: 'failed', action: 'not_started', outcome: 'preflight_failed',
      error_code: code, error: code === 'review_budget_exhausted'
        ? 'cannot inspect review repository: --requests-json [{"query":"rate limit; not signed in"}] timed out'
        : 'Local review repository inspection timed out after 30 seconds',
      diagnostic, completed_at: new Date().toISOString() })
    await executor.run()
    expect(journal.read(first.id)!.invocations[0].state).toBe('uncertain')
    expect(launches).toHaveLength(2)
    calls[0].resources_settled_at = new Date().toISOString()
    await executor.run()
    expect(journal.read(first.id)).toMatchObject({ waiting: 'review-pr is in native failure backoff',
      invocations: [{ state: 'settled', evidence: { diagnostic, error_code: code } }] })
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
    journal.rebuild()
    vi.setSystemTime(Date.now() + 60_001)
    await executor.run()
    expect(launches).toHaveLength(3)
    expect(launches[2]).toMatchObject({ behavior: 'review-pr', basis: launches[0].basis, slot: launches[0].slot, model })
    expect(launches[2].request.argv).toEqual(expect.arrayContaining([
      '--pr-review', `https://github.com/${pr.repo}/pull/17`, '--expected-head', HEAD_SHA,
    ]))
    expect(launches[2].id).not.toBe(launches[0].id)

    Object.assign(calls[1], { status: 'failed', action: 'not_started', outcome: 'preflight_failed',
      error_code: 'review_budget_exhausted', error: 'Review reached its total time limit; needs attention',
      diagnostic: parseProcessDiagnostic({ version: 1, source: 'caller', severity: 'error', operation: 'provider.review',
        phase: 'provider_execution', outcome: 'timed_out' }),
      completed_at: new Date().toISOString(), resources_settled_at: new Date().toISOString() })
    await executor.run()
    const third = seed(9)
    await executor.run()
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([
      expect.objectContaining({ target: `reviewer:${model}` }),
    ])
    expect(journal.read(third.id)!.waiting).toBe('review-pr is waiting for native provider backoff')
    expect(launches).toHaveLength(3)
  })

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
    expect(runtime.getBehaviorsRuntimeHealth().status).toBe('ok')
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
    expect(captured.note('repair-pr', chain, null)).toBe('Preserve all CI gates.')
    const { REMEDIATION_SCOPE } = await import('../server/behavior-chain-report')
    db.setMeta('behavior_chain_repair_report:fixture', JSON.stringify({ source: chain.id, issueNumber: 99 }))
    const remediation = { ...chain, issue: 99 }
    let closingIssue = 99
    const run = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation((command: string, args: string[], options?: { cwd?: string }) =>
      command === 'github-datastore' && args[1] === 'pr-closing'
        ? Promise.resolve({ stdout: JSON.stringify({ prs: [{ repo: chain.repository, number: 18, closes_via: 'closing-references', closing_truncated: false,
          closing: [{ repo: chain.repository, number: closingIssue }] }], truncated: false, more: false }), stderr: '' }) : run(command, args, options))
    await expect(captured.reviewScope!(chain, { number: 18 })).resolves.toBe('')
    await expect(captured.reviewScope!(remediation, { number: 18 })).resolves.toBe(REMEDIATION_SCOPE)
    closingIssue = 88
    await expect(captured.reviewScope!(remediation, { number: 18 })).resolves.toBe('')
  })

  it('uses the existing tick and paginated reader to complete cutover before native intake can run', async () => {
    arrangeCli()
    const { database: db, behaviors: runtime } = await loadModules()
    const native = await import('../server/behavior-chain-native')
    const discover = vi.fn(async () => [])
    const original = native.nativeChainOperations
    vi.spyOn(native, 'nativeChainOperations').mockImplementation((org, hooks) => ({ ...original(org, hooks), discover }))
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_chain_settings', JSON.stringify({ enabled: true, seedMode: 'label', label: 'poise' }))
    await runtime.runEnabledBehaviorsOnce()
    expect(discover).not.toHaveBeenCalled()
    const journal = (await import('../server/behavior-chain-journal')).behaviorChainJournal()
    journal.changeAdmission(0, 'draining')
    const reader = await import('../server/chat/control')
    const page = (number: number, more: boolean) => ({ prs: [{ repo: pr.repo, number, url: `https://github.com/${pr.repo}/pull/${number}`,
      closing: [], closesVia: 'closing-references' as const, closingTruncated: false, headRef: `work-${number}`, headRepo: pr.repo }], truncated: more, more })
    const read = vi.spyOn(reader, 'readOpenPrClosingRefs').mockResolvedValueOnce(page(17, true)).mockResolvedValueOnce(page(18, false))
    await runtime.runEnabledBehaviorsOnce()
    expect(read).toHaveBeenCalledTimes(2)
    expect(read.mock.calls[1][1]).toEqual({ repo: pr.repo, number: 17 })
    expect(journal.cutover()).toMatchObject({ mode: 'v2', legacyPulls: [`${pr.repo}#17`.toLowerCase(), `${pr.repo}#18`.toLowerCase()] })
    expect(JSON.parse(db.getMeta('behavior_chain_settings')!).enabled).toBe(true)
    expect(journal.page()).toEqual([])
    expect(discover).not.toHaveBeenCalled()
    await runtime.runEnabledBehaviorsOnce()
    expect(discover).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })
  it('completes cutover without re-enabling while a receipt integrity hold persists', async () => {
    arrangeCli()
    const { database: db, behaviors: runtime } = await loadModules()
    const { BEHAVIOR_CHAIN_INTEGRITY_HOLD_KEY } = await import('../server/settings')
    const native = await import('../server/behavior-chain-native')
    const discover = vi.fn(async () => [])
    const original = native.nativeChainOperations
    vi.spyOn(native, 'nativeChainOperations').mockImplementation((org, hooks) => ({ ...original(org, hooks), discover }))
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_chain_settings', JSON.stringify({ enabled: false, seedMode: 'label', label: 'poise' }))
    // A confirmed integrity failure during the pending cutover fences admissions.
    db.setMeta(BEHAVIOR_CHAIN_INTEGRITY_HOLD_KEY, '1')
    const journal = (await import('../server/behavior-chain-journal')).behaviorChainJournal()
    journal.changeAdmission(0, 'draining')
    const reader = await import('../server/chat/control')
    const page = (number: number, more: boolean) => ({ prs: [{ repo: pr.repo, number, url: `https://github.com/${pr.repo}/pull/${number}`,
      closing: [], closesVia: 'closing-references' as const, closingTruncated: false, headRef: `work-${number}`, headRepo: pr.repo }], truncated: more, more })
    vi.spyOn(reader, 'readOpenPrClosingRefs').mockResolvedValueOnce(page(17, true)).mockResolvedValueOnce(page(18, false))
    await runtime.runEnabledBehaviorsOnce()
    expect(journal.cutover()).toMatchObject({ mode: 'v2', legacyPulls: [`${pr.repo}#17`.toLowerCase(), `${pr.repo}#18`.toLowerCase()] })
    expect(JSON.parse(db.getMeta('behavior_chain_settings')!).enabled).toBe(false)
    expect(db.getMeta(BEHAVIOR_CHAIN_INTEGRITY_HOLD_KEY)).toBe('1')
    // An explicit Settings resume clears the hold and enables invocations.
    const settings = await import('../server/settings')
    settings.setSettings({ behaviorChain: { enabled: true, seedMode: 'label', label: 'poise' } })
    expect(db.getMeta(BEHAVIOR_CHAIN_INTEGRITY_HOLD_KEY)).toBe('')
    expect(JSON.parse(db.getMeta('behavior_chain_settings')!).enabled).toBe(true)
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

  it('preserves standalone PR handling after cutover and keeps new behavior controls independent', async () => {
    arrangeCli()
    const { database: db, behaviors: runtime } = await loadModules()
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_review_new_prs_keyver', '3')
    db.recordSeen('review-new-prs', '__snapshot_v3__')
    db.setMeta('behavior_review_new_prs_enabled', '1')
    const journal = (await import('../server/behavior-chain-journal')).behaviorChainJournal()
    journal.changeAdmission(0, 'draining')
    expect(runtime.isRunnable('review-new-prs')).toBe(false)
    journal.changeAdmission(journal.cutover().sequence, 'v2', [])
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.spawnDetached).toHaveBeenCalled()
    expect(mocks.spawnDetached.mock.calls[0][1]).toContain('--pr-review')
    const lease = db.claimPrOperationOwned(`${pr.repo}#${pr.number + 1}`, 60_000)
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
