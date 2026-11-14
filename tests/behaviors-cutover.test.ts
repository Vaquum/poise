import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import { arrangeCli, deferred, HEAD_SHA, loadModules, mocks, pr } from './behaviors-runtime-fixture'
import type { NativeChainHooks } from '../server/behavior-chain-native'
import type { ChainRuntimeOperations } from '../server/behavior-chain-runtime'
import { decideBehaviorChain, type ChainObservation } from '../server/behavior-chain-decision'
import { BehaviorChainJournal, chainBasis, type ChainInvocation } from '../server/behavior-chain-store'
import type { LogEntry } from '../server/agent-log-parse'
import { parseProcessDiagnostic } from '../server/process-diagnostic'

vi.mock('../server/chat/control', () => ({ readOpenPrClosingRefs: vi.fn() }))

describe('native repair execution budget fallback', () => {
  async function setup(selection: 'primary' | 'random' | 'none' = 'primary') {
    arrangeCli()
    const { database: db, behaviors: runtime } = await loadModules()
    const native = await import('../server/behavior-chain-native')
    const captured: { operations?: ChainRuntimeOperations, hooks?: NativeChainHooks } = {}
    const original = native.nativeChainOperations
    vi.spyOn(native, 'nativeChainOperations').mockImplementation((org, passed) => {
      captured.hooks = passed
      captured.operations = original(org, passed)
      return { ...captured.operations, enabled: () => false }
    })
    runtime.startBehaviorsRuntime()
    db.setMeta('me', 'poise-user')
    db.setMeta('behavior_chain_settings', JSON.stringify({ enabled: true, seedMode: 'label', label: 'poise' }))
    const models = { slots: { primary: 'muse-spark-1.3-contributor-max', secondary: 'gpt-6-astra-ultra', tertiary: 'muse-spark-1.3-contributor-max' },
      places: { pr_repair: { slot: selection === 'random' ? 'random' : 'primary' } } }
    if (selection === 'none') models.slots.secondary = models.slots.primary
    db.setMeta('models', JSON.stringify(models))
    await runtime.runEnabledBehaviorsOnce()
    const { operations, hooks } = captured
    if (!operations || !hooks) throw new Error('native repair hooks were not installed')
    const reviewer = (await hooks.roster(`${pr.repo}#7`)).repairer
    const observation: ChainObservation = { checkedAt: Date.now(), existingPulls: [],
      issue: { open: true, eligible: true, revision: chainBasis('seed'), commentIds: [] }, issueReviewers: [], prReviewers: [],
      implementer: reviewer, repairer: reviewer, approver: reviewer,
      publication: { pull_number: 17, head_sha: HEAD_SHA, head_invocation: null, state: 'open', merged: false, merge_sha: null },
      pull: { number: 17, head: HEAD_SHA, headSince: Date.now(), state: 'open', draft: false, merged: false, mergeSha: null,
        queueEntry: null, queueRemoval: null, changesRequested: true, unresolved: 1, approved: false, ready: false,
        reviewIds: [], reviewRevision: chainBasis('findings'), reviewReceipts: [], greyRuns: [], pending: false, failing: [], conflict: false, behind: false } }
    return { db, runtime, operations, hooks, models, reviewer, observation }
  }

  it.each(['primary', 'random', 'none', 'uncertain publication'] as const)('preserves the repair attempt window across journal reopening (%s)', async selection => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { db, runtime, operations, reviewer, observation } = await setup(selection === 'uncertain publication' ? 'primary' : selection)
    const { BehaviorChainRuntime } = await import('../server/behavior-chain-runtime')
    let connection = new Database(db.db.name)
    let journal = new BehaviorChainJournal(connection)
    const chain = journal.append(`${pr.repo.toLowerCase()}#7`, 'repair-seed', 0, { type: 'chain.admitted', repository: pr.repo,
      issue: 7, branch: 'poise/issue-7', author: 'poise-user', reviewer: 'review-bot' })
    const launches: ChainInvocation[] = [], calls: LogEntry[] = []
    const reportHold = vi.fn(async () => null)
    const executor = () => new BehaviorChainRuntime(journal, { ...operations, enabled: () => true,
      discover: async () => [], available: () => true, capacity: () => 1, wake: () => {}, reportHold,
      observe: async () => ({ ...observation, checkedAt: Date.now() }),
      readInvocations: async () => ({ entries: calls, quarantined: [] }),
      launch: async invocation => {
        launches.push(invocation)
        calls.push({ id: String(launches.length).repeat(32), correlation_id: invocation.id, source: 'poise:behavior-chain',
          actor: invocation.actor, repo: pr.repo, behavior: 'repair_pr', model: invocation.model!, pr_id: '17',
          session_id: null, prompt: '', started_at: new Date().toISOString(), time_elapsed: '1s', head_sha: null,
          expected_head: HEAD_SHA, response: null, error: '', status: 'running', action: null, outcome: null,
          resource_ownership: { version: 1, roots: [], errors: [] } })
        return true
      } })
    const reopen = () => {
      connection.close()
      connection = new Database(db.db.name)
      journal = new BehaviorChainJournal(connection)
      journal.verifyProjection()
    }
    try {
      for (let index = 0; index < 3; index++) {
        await executor().run()
        expect(launches).toHaveLength(index + 1)
        const model = index === 2 && selection !== 'none'
          ? reviewer.model === 'gpt-6-astra-ultra' ? 'muse-spark-1.3-contributor-max' : 'gpt-6-astra-ultra' : reviewer.model
        expect(launches[index]).toMatchObject({ behavior: 'repair-pr', basis: launches[0].basis, slot: reviewer.slot, model })
        expect(launches[index].request.argv).toEqual(expect.arrayContaining(['--model', model, '--expected-head', HEAD_SHA,
          '--expected-issue-revision', observation.issue.revision]))
        expect(launches[index].request.context).toEqual({ head: HEAD_SHA, reviewRevision: observation.pull!.reviewRevision })
        await executor().run()
        expect(launches).toHaveLength(index + 1)
        Object.assign(calls[index], { status: 'failed', action: 'not_started', outcome: 'preflight_failed',
          error_code: 'atomic_work_execution_budget_exhausted', error: 'Atomic behavior provider exhausted its execution budget; no publication attempted',
          artifact: { phase: 'executing' }, completed_at: new Date().toISOString() })
        if (selection === 'uncertain publication' && index === 1) Object.assign(calls[index], {
          action: null, outcome: 'partial', error_code: 'atomic_work_failed', artifact: { phase: 'publishing' } })
        await executor().run()
        expect(journal.read(chain.id)!.invocations[index].state).toBe('uncertain')
        expect(launches).toHaveLength(index + 1)
        calls[index].resources_settled_at = new Date().toISOString()
        await executor().run()
        if (selection === 'uncertain publication' && index === 1) {
          reopen()
          vi.setSystemTime(Date.now() + 120_001)
          await executor().run()
          expect(journal.read(chain.id)!.invocations[1].state).toBe('uncertain')
          expect(launches).toHaveLength(2)
          return
        }
        expect(journal.read(chain.id)!.invocations[index].state).toBe('settled')
        if (index < 2) expect(journal.read(chain.id)!.waiting).toContain('native failure backoff')
        if (index === 1 || index === 2) reopen()
        vi.setSystemTime(Date.now() + 120_001)
      }
      await executor().run()
      expect(journal.read(chain.id)).toMatchObject({ held: expect.stringContaining('failed before publication three times'),
        resumedAfterSequence: 0, invocations: Array.from({ length: 3 }, () => expect.objectContaining({ state: 'settled' })) })
      expect(reportHold).toHaveBeenCalledWith(expect.objectContaining({ id: chain.id,
        held: expect.stringContaining('failed before publication three times') }))
      expect(launches).toHaveLength(3)
      expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
    } finally { connection.close() }
  })

  it.each(['review basis', 'head', 'unrelated error', 'publication', 'resources', 'model', 'Resume', 'deferred', 'tripped alternate'])(
    'retains ordinary selection with %s instead of two qualifying timeouts', async change => {
    const { db, operations, hooks, models, reviewer, observation } = await setup()
    const journal = (await import('../server/behavior-chain-journal')).behaviorChainJournal()
    let chain = journal.append(`${pr.repo.toLowerCase()}#7`, 'repair-seed', 0, { type: 'chain.admitted', repository: pr.repo,
      issue: 7, branch: 'poise/issue-7', author: 'poise-user', reviewer: 'review-bot' })
    const first = decideBehaviorChain(chain, observation, Date.now())
    if (first.kind !== 'invoke') throw new Error('expected native repair')
    for (let index = 0; index < 2; index++) {
      const id = `timeout-${index}`
      const request = await operations.request(chain, observation, first, id)
      if (!request) throw new Error('expected native repair request')
      chain = journal.append(chain.id, `admit-${index}`, chain.sequence, { type: 'invocation.admitted', invocation: { id,
        behavior: 'repair-pr', basis: first.basis, actor: chain.author, model: reviewer.model, slot: reviewer.slot, admittedAt: Date.now(), request } })
      chain = journal.append(chain.id, `settle-${index}`, chain.sequence, { type: 'invocation.settled', invocationId: id,
        callId: String(index + 1).repeat(32), outcome: 'atomic_work_execution_budget_exhausted', evidence: { status: 'failed',
          action: 'not_started', outcome: 'preflight_failed', error_code: 'atomic_work_execution_budget_exhausted',
          artifact: { phase: 'executing' }, completedAt: Date.now() - 180_000, resources_settled_at: new Date().toISOString(),
          resource_ownership: { version: 1, roots: [], errors: [] } } })
    }
    const last = chain.invocations[1], evidence = last.evidence!
    if (change === 'review basis') observation.pull!.reviewRevision = chainBasis('changed findings')
    if (change === 'head') observation.pull!.head = 'b'.repeat(40)
    if (change === 'unrelated error') evidence.error_code = 'atomic_work_failed'
    if (change === 'publication') evidence.artifact = { phase: 'executing', plan_sha: 'c'.repeat(64) }
    if (change === 'resources') evidence.resources_settled_at = null
    if (change === 'model') last.model = models.slots.secondary
    if (change === 'Resume') chain.resumedAfterSequence = chain.invocations[0].admissionSequence
    if (change === 'deferred') evidence.status = 'deferred'
    if (change === 'tripped alternate') db.setMeta(`behavior_review_new_issues_failure:reviewer:${models.slots.secondary}`,
      JSON.stringify({ kind: 'operation', consecutiveFailures: 2, lastFailureAtMs: Date.now(), nextRetryAtMs: Date.now() + 3_600_000 }))
    const decision = decideBehaviorChain(chain, observation, Date.now())
    if (decision.kind !== 'invoke') throw new Error('expected ordinary retry selection')
    const request = await operations.request(chain, observation, decision, 'final-attempt')
    expect(request?.argv).toEqual(expect.arrayContaining(['--model', reviewer.model]))
    expect(await hooks.roster(`${pr.repo}#7`)).toMatchObject({ repairer: reviewer })
  })
})

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
      artifact: { phase: 'reviewing' }, error_code: code, error: code === 'review_budget_exhausted'
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
