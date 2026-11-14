import Database from 'better-sqlite3'
import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseAgentLogList, type LogEntry } from '../server/agent-log-parse'
import { BehaviorChainJournal, chainBasis, type BehaviorChain, type ChainInvocation } from '../server/behavior-chain-store'
import { BehaviorChainRuntime, type ChainRuntimeOperations } from '../server/behavior-chain-runtime'
import type { Organization } from '../server/organizations'
import type { NativeChainHooks } from '../server/behavior-chain-native'
import type { ChainObservation } from '../server/behavior-chain-decision'
import { completedReviewCall } from './review-response-fixture'
import { behaviorChainAttention, behaviorChainWorkImpact } from '../server/behavior-chain-summary'

const mocks = vi.hoisted(() => ({ runFile: vi.fn(), health: vi.fn(async () => {}) }))
vi.mock('../server/process', () => ({ runFile: mocks.runFile, spawnDetached: vi.fn() }))
vi.mock('../server/datastore-health', () => ({ runDatastoreHealth: mocks.health }))
vi.mock('../server/models', () => ({ agentInterfaceCwd: () => '/interface' }))
vi.mock('../server/settings', () => ({ getSettings: () => ({ me: 'author', agentAccount: 'reviewer' }),
  getBehaviorChainSettings: () => ({ enabled: true, seedMode: 'all', label: 'poise' }),
  BEHAVIOR_CHAIN_INTEGRITY_HOLD_KEY: 'behavior_chain_integrity_hold' }))
vi.mock('../server/organizations', () => ({ organizationForRepository: (repo: string) => ({ login: repo.split('/')[0] }),
  organizationArgs: (_org: unknown, argv: string[]) => argv }))
const { nativeChainOperations } = await import('../server/behavior-chain-native')
const { decideBehaviorChain } = await import('../server/behavior-chain-decision')
const { CallerReceiptStoreError } = await import('../server/service/caller-calls')
const { spawnDetached } = await import('../server/process')

let directory = ''
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

const HEAD = 'a'.repeat(40)
const chain: BehaviorChain = { id: 'example/repo#7', repository: 'example/repo', issue: 7, branch: 'poise/issue-7',
  author: 'author', reviewer: 'reviewer', sequence: 1, held: null, waiting: null, resumedAfterSequence: 0,
  mergeSha: null, observation: null, invocations: [] }
const reviewer = { slot: 'primary', model: 'fixture', recovery: 'fixture' }

it('refuses managed admission and effects on unreadable receipts, including failure during preparation, and rechecks existing controls after recovery', async () => {
  directory = mkdtempSync(join(tmpdir(), 'poise-native-receipts-'))
  vi.stubEnv('AGENT_INTERFACE_DATA_DIR', directory)
  const path = join(directory, 'calls.sqlite3')
  const corrupt = () => writeFileSync(path, 'not a database')
  const restore = () => {
    rmSync(path)
    const db = new Database(path)
    db.exec('create table calls (status text, pid integer, runner text, source text, resources_settled_at real, resource_cleanup text)')
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
    db.close()
  }
  corrupt()
  const permitted = vi.fn(() => true)
  const prepare = vi.fn(async () => ({}))
  const operations = actionOperations({ permitted, prepare })
  const invocation = mergeInvocation()
  const decision = { kind: 'invoke', behavior: 'merge-pr', actor: 'reviewer', basis: 'merge', reviewer: null, reason: 'ready' } as const
  expect(() => operations.permitted(chain, decision)).toThrow(CallerReceiptStoreError)
  await expect(operations.launch(invocation, () => {}, () => true)).rejects.toMatchObject({ kind: 'integrity', code: 'SQLITE_NOTADB' })
  await expect(operations.perform(invocation, chain)).rejects.toBeInstanceOf(CallerReceiptStoreError)
  await expect(operations.resumePublication(invocation, HEAD, 'continuation')).rejects.toBeInstanceOf(CallerReceiptStoreError)
  expect(prepare).not.toHaveBeenCalled()
  expect(mocks.runFile).not.toHaveBeenCalled()
  expect(spawnDetached).not.toHaveBeenCalled()
  restore()
  expect(operations.permitted(chain, decision)).toBe(true)
  prepare.mockImplementation(async () => { corrupt(); return {} })
  await expect(operations.launch(invocation, () => {}, () => true)).rejects.toBeInstanceOf(CallerReceiptStoreError)
  expect(spawnDetached).not.toHaveBeenCalled()
  restore()
  permitted.mockReturnValue(false)
  expect(operations.permitted(chain, decision)).toBe(false)
  permitted.mockReturnValue(true)
  expect(operations.permitted(chain, decision)).toBe(true)
})

it.each([false, true])('verifies Caller Python request encoding and original response bytes (bounded=%s)', async bounded => {
  const invocation = mergeInvocation()
  invocation.request = { command: 'github-interface', cwd: '/fixture', nativeResources: 2, argv: invocation.request.argv,
    ...(bounded ? { resourceLimits: { version: 1 as const, memoryBytes: 2147483648, diskBytes: 536870912 } } : {}) }
  const requestSha = execFileSync('python3', ['-c', `
import hashlib, json, sys
request = json.load(sys.stdin)
print(hashlib.sha256(json.dumps(request, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest())
`], { input: JSON.stringify(invocation.request), encoding: 'utf8', timeout: 10_000 }).trim()
  const retained = '{"duration":1.0,"outcome":"enqueued"}'
  const call: LogEntry = { id: 'b'.repeat(32), pr_id: '21', repo: chain.repository, actor: invocation.actor,
    model: 'native-action', behavior: 'native_action', session_id: null, prompt: '', started_at: new Date().toISOString(),
    time_elapsed: '1s', status: 'completed', outcome: 'native_action', action: 'native_action', head_sha: HEAD,
    expected_head: HEAD, source: 'poise:behavior-chain', correlation_id: invocation.id, response: 'bbbbbbbb', error: '',
    artifact: { phase: 'received_native_action',
    request_sha: requestSha, response_sha: createHash('sha256').update(retained).digest('hex') } }
  mocks.runFile.mockResolvedValueOnce({ stdout: `${retained}\n` })
  await expect(actionOperations().readActionResult(invocation, call))
    .resolves.toEqual({ duration: 1, outcome: 'enqueued' })
  mocks.runFile.mockResolvedValueOnce({ stdout: `${JSON.stringify(JSON.parse(retained))}\n` })
  await expect(actionOperations().readActionResult(invocation, call))
    .rejects.toThrow('retained digest')
  const unavailable = Object.assign(new Error('required receipt is unavailable'), { code: 3,
    stdout: JSON.stringify({ id: call.id, disposition: 'unavailable', reason: 'The Call is unknown' }), stderr: '' })
  mocks.runFile.mockRejectedValueOnce(unavailable)
  await expect(actionOperations().readActionResult(invocation, call)).rejects.toBe(unavailable)
  expect(mocks.runFile).toHaveBeenLastCalledWith('agent-interface', ['--read-response', call.id],
    expect.objectContaining({ callId: call.id, readerPurpose: 'native-action-receipt' }))
  expect(mocks.runFile.mock.lastCall?.[2].expected).toBeUndefined()
})

function actionOperations(overrides: Partial<NativeChainHooks> = {}) {
  return nativeChainOperations({ login: 'example' } as Organization, {
    roster: async () => ({ issueReviewers: [], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer }),
    resolve: async () => reviewer, prepare: async () => ({}), borrow: () => () => {}, available: () => true,
    capacity: () => 3, permitted: () => true, note: () => '', severity: () => 'p2', received: () => {},
    reviews: async () => 'reviews', existing: async () => new Set(), wake: () => {}, ...overrides,
  })
}

function mergeInvocation(): ChainInvocation {
  return { id: 'original-merge', behavior: 'merge-pr', basis: 'merge', actor: 'reviewer', model: null, slot: null,
    reservation: null, admittedAt: Date.now() - 1000, admissionSequence: 2, state: 'started', callId: null, outcome: null, evidence: null,
    request: { command: 'github-interface', cwd: '/fixture', argv: ['--merge-if-ready', '21', '--expected-head', HEAD, '--token-user', 'reviewer'] } }
}

it('accepts only validated partial resolution progress without relaxing completed-batch receipts', () => {
  const id = 'b'.repeat(32)
  const stamp = Date.now()
  const progress = { confirmed: [{ id: 'A', isResolved: true }], pending: 'B' }
  const call = { id, pr_id: '21', repo: chain.repository, actor: 'reviewer', model: 'native-action', behavior: 'native_action',
    prompt: '', started_at: new Date(stamp - 1000).toISOString(), completed_at: new Date(stamp).toISOString(), time_elapsed: '1s',
    status: 'failed', outcome: null, action: null, error: 'deadline', source: 'poise:behavior-chain',
    correlation_id: 'original-resolution', expected_head: HEAD,
    resource_ownership: { version: 2, roots: [], errors: [], namespace: { state: 'settled', callId: id,
      correlation: 'original-resolution', settled_at: stamp / 1000, controller: { version: 1, instance: 'c'.repeat(32) },
      binding: { pid: 104, start: '12', namespace: 'pid:[91]', owner: { pid: 102, start: '10' }, holder: { pid: 103, start: '11' },
        epoch: { boot: 'fixture', init_start: '1', namespace_dev: '2', namespace_ino: '3' } } } },
    artifact: { phase: 'performing_native_action', request_sha: 'd'.repeat(64), resolution_progress: progress } }
  expect(parseAgentLogList([call]).quarantined).toEqual([])
  for (const invalid of [null, {}, { ...progress, extra: true }, { confirmed: [{ id: 'A', isResolved: false }], pending: 'B' },
    { confirmed: [...progress.confirmed, ...progress.confirmed], pending: 'B' }, { ...progress, pending: 'A' },
    { ...progress, pending: 12 }, { confirmed: [{ id: 'A', isResolved: true, extra: true }], pending: null }]) {
    expect(parseAgentLogList([{ ...call, artifact: { ...call.artifact, resolution_progress: invalid } }]).quarantined).toHaveLength(1)
  }
  for (const artifact of [
    { ...call.artifact, unexpected: true },
    { ...call.artifact, phase: 'preparing_native_action' },
    { ...call.artifact, phase: 'received_native_action', response_sha: 'e'.repeat(64) },
  ]) expect(parseAgentLogList([{ ...call, artifact }]).quarantined).toHaveLength(1)
  // A progress-only artifact has no accepted final response or readiness proof.
  expect(parseAgentLogList([{ ...call, status: 'completed', outcome: 'native_action', action: 'native_action', head_sha: HEAD }])
    .quarantined).toHaveLength(1)
})

it.each(['fenced', 'existing'] as const)('validates the original closed-target fence response without provider preparation: %s', async outcome => {
  const prepare = vi.fn(async () => ({}))
  const borrow = vi.fn(() => () => {})
  const invocation: ChainInvocation = { ...mergeInvocation(), behavior: 'repair-pr', model: 'fixture', actor: 'author',
    request: { command: 'agent-interface', cwd: '/fixture', argv: ['--atomic-work', 'example/repo#7', '--pull-number', '21', '--expected-head', HEAD] } }
  mocks.runFile.mockResolvedValueOnce({ stdout: JSON.stringify({ id: 'c'.repeat(32), outcome, model: 'fixture', actor: 'author',
    repo: chain.repository, pr_id: '21', behavior: 'repair_pr', source: 'poise:behavior-chain', correlation_id: invocation.id, expected_head: HEAD }) })
  expect(await actionOperations({ prepare, borrow }).fenceClosedTarget(chain, invocation)).toBe(outcome === 'fenced')
  expect(mocks.runFile.mock.calls.at(-1)?.slice(0, 2)).toEqual(['agent-interface', ['--fence-closed-behavior', '--model', 'fixture',
    '--actor', 'author', '--repo', chain.repository, '--number', '21', '--behavior', 'repair_pr', '--correlation-id', invocation.id, '--expected-head', HEAD]])
  expect(prepare).not.toHaveBeenCalled()
  expect(borrow).not.toHaveBeenCalled()
})

it('refuses a late native launch before reserving capacity or preparing a provider', async () => {
  const prepare = vi.fn(async () => ({}))
  const borrow = vi.fn(() => () => {})
  expect(await actionOperations({ prepare, borrow }).launch(mergeInvocation(), () => {}, () => false)).toBe(false)
  expect(prepare).not.toHaveBeenCalled()
  expect(borrow).not.toHaveBeenCalled()
})

it('releases borrowed capacity when closure arrives during provider preparation', async () => {
  const release = vi.fn()
  const borrow = vi.fn(() => release)
  const prepare = vi.fn(async () => ({}))
  const allowed = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false)
  expect(await actionOperations({ prepare, borrow }).launch(mergeInvocation(), () => {}, allowed)).toBe(false)
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(borrow).toHaveBeenCalledTimes(1)
  expect(release).toHaveBeenCalledTimes(1)
})

it('retains a returned native mutation response when its process subsequently fails', async () => {
  const response = { action: 'merge_if_ready', repository: chain.repository, pull_number: 21,
    head_sha: HEAD, outcome: 'enqueued', queue_entry_id: 'accepted-queue-entry' }
  mocks.runFile.mockRejectedValueOnce(Object.assign(new Error('process exited after response'), {
    code: 1, signal: null, stdout: JSON.stringify({ id: 'c'.repeat(32), result: response }),
  }))
  await expect(actionOperations().perform(mergeInvocation(), chain)).resolves.toEqual({ ...response,
    nativeCallId: 'c'.repeat(32), nativeOuterProcessFailure: { code: 1, signal: null } })
})

it.each(['', 'partial JSON {', '[]'])('preserves the original process failure when stdout is not a valid response: %s', async (stdout) => {
  const failure = Object.assign(new Error('native timeout after a possible write'), { code: 'ETIMEDOUT', signal: 'SIGTERM', stdout })
  mocks.runFile.mockRejectedValueOnce(failure)
  await expect(actionOperations().perform(mergeInvocation(), chain)).rejects.toBe(failure)
})

it('preserves actual review identities, responses and times after an external merge', async () => {
  const completedAt = Date.now() - 5000
  const response = { repository: 'example/repo', pull_number: 21, head_sha: HEAD, context_sha: 'b'.repeat(64),
    reviewer: 'reviewer', invocation_id: 'c'.repeat(32), model: 'fixture', completed_at: completedAt,
    assessment: { verdict: 'The changed validation has no remaining blocking defects.',
      reviewed_context: 'Inspected the immutable diff and affected callers.', limitations: 'No live provider calls.' } }
  mocks.runFile.mockImplementation(async (_command: string, argv: string[]) => {
    if (argv[0] === '--chain-seed') return { stdout: JSON.stringify({ repository: 'example/repo', issue_number: 7,
      actor: 'author', branch: chain.branch, issue: { title: 'Seed', body: '', state: 'closed', labels: [] }, comments: [],
      publication: { existing_pulls: [], pull_number: 21, head_sha: HEAD, head_invocation: null, state: 'closed', merged: true, merge_sha: 'd'.repeat(40) } }) }
    if (argv[0] === '--pull-action-state') return { stdout: JSON.stringify({ pull_number: 21, state: 'closed', head_sha: HEAD,
      review_context: response.context_sha, merged: true, merge_sha: 'd'.repeat(40), merged_at: new Date(completedAt + 2000).toISOString(),
      my_reviews: [{ id: 91, state: 'COMMENTED', commit_id: HEAD, invocation_id: response.invocation_id,
        review_response: response, submitted_at: new Date(completedAt + 1000).toISOString() }] }) }
    throw new Error(`unexpected native operation ${argv[0]}`)
  })
  const operations = nativeChainOperations({ login: 'example' } as Organization, {
    roster: async () => ({ issueReviewers: [], prReviewers: [reviewer], implementer: reviewer, repairer: reviewer, approver: reviewer }),
    resolve: async () => reviewer, prepare: async () => ({}), borrow: () => () => {}, available: () => true,
    capacity: () => 3, permitted: () => true, note: () => '', severity: () => 'p2', received: () => {},
    reviews: async () => 'reviews', existing: async () => new Set(), wake: () => {},
  })
  const observation = await operations.observe(chain)
  expect(observation.pull).toMatchObject({ merged: true, reviewIds: [91], mergedAt: completedAt + 2000,
    reviewReceipts: [{ id: 91, invocation: response.invocation_id, response, submittedAt: completedAt + 1000 }] })
  const invocation = { id: 'review', behavior: 'review-pr' as const, basis: chainBasis(['pr', HEAD, response.context_sha]),
    actor: 'reviewer', model: 'fixture', slot: 'primary', reservation: null, admittedAt: completedAt - 1000, admissionSequence: 1,
    request: { command: 'agent-interface' as const, argv: [], cwd: '/fixture' }, state: 'settled' as const,
    callId: response.invocation_id, outcome: 'clean', evidence: { status: 'completed', action: 'reviewed_clean',
      review_id: 91, head_sha: HEAD, completedAt: completedAt + 1000, artifact: { review_response: response } } }
  const preMerge = { ...observation, checkedAt: completedAt + 1000,
    pull: { ...observation.pull!, merged: false, state: 'open', mergeSha: null, mergedAt: null } }
  const reviewed = { ...chain, observation: preMerge, invocations: [invocation] }
  expect(decideBehaviorChain(reviewed, observation, Date.now())).toMatchObject({ kind: 'complete' })
  observation.pull!.mergedAt = completedAt - 1
  expect(decideBehaviorChain(reviewed, observation, Date.now())).toMatchObject({ kind: 'hold' })
})

it('discovers a verified external merge for a closed held seed without binding or publishing a PR', async () => {
  vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-11-11T00:00:00Z'))
  const db = new Database(':memory:')
  const journal = new BehaviorChainJournal(db)
  let current = journal.append(chain.id, 'seed', 0, { type: 'chain.admitted', repository: chain.repository,
    issue: chain.issue, branch: chain.branch, author: chain.author, reviewer: chain.reviewer })
  const closureHold = 'seed issue closed without a confirmed merged pull request'
  current = journal.append(current.id, 'held', current.sequence, { type: 'chain.held', reason: closureHold })
  let mode = 'unmatched'
  mocks.runFile.mockImplementation(async (command: string, argv: string[]) => {
    expect(command).toBe('github-interface')
    return { stdout: execFileSync('python3', ['tests/fixtures/closed-seed-merge.py'], {
      input: JSON.stringify({ argv, mode }), encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PYTHONPATH: [resolve('caller/github_interface'), process.env.PYTHONPATH].filter(Boolean).join(':') },
    }) }
  })
  const effect = vi.fn(async () => { throw new Error('closed seed must not start work or publication') })
  const native = actionOperations()
  const operations: ChainRuntimeOperations = { ...native, discover: async () => [],
    readInvocations: async () => ({ entries: [], quarantined: [] }), request: effect, launch: effect,
    perform: effect, resumePublication: effect, fenceClosedTarget: effect }
  const runtime = new BehaviorChainRuntime(journal, operations)
  const due = () => vi.setSystemTime(Math.max(Date.now(), journal.reconciliationAt(journal.read(chain.id)!)!))
  try {
    for (mode of ['unmatched', 'unmerged', 'wrong-repository', 'wrong-branch', 'ambiguous']) {
      due()
      await runtime.run()
      expect(journal.read(chain.id)).toMatchObject({ mergeSha: null, held: closureHold, invocations: [],
        observation: { issue: { open: false }, pull: null, publication: { pull_number: null, head_sha: null } } })
    }
    for (mode of ['incomplete', 'unavailable', 'missing-sha', 'contradictory']) {
      due()
      await expect(runtime.run()).rejects.toThrow('behavior observation failed for example/repo#7')
      expect(journal.read(chain.id)).toMatchObject({ mergeSha: null, held: closureHold, invocations: [] })
    }
    mode = 'verified'; due()
    await runtime.run()
    const reconciled = journal.read(chain.id)!
    expect(reconciled).toMatchObject({ mergeSha: 'd'.repeat(40), reviewPending: true, invocations: [],
      held: expect.stringContaining('original pre-merge review basis is missing'),
      observation: { publication: { pull_number: null, head_sha: null, head_invocation: null },
        pull: { number: 21, head: HEAD, merged: true, mergeSha: 'd'.repeat(40) } } })
    expect(journal.history(chain.id).map(row => JSON.parse(row.payload)).filter(event => event.type === 'chain.merged'))
      .toEqual([{ type: 'chain.merged', mergeSha: 'd'.repeat(40), evidence: { repository: chain.repository,
        pull_number: 21, merged: true, merge_sha: 'd'.repeat(40), review_complete: false } }])
    journal.rebuild()
    await new BehaviorChainRuntime(journal, operations).run()
    expect(journal.read(chain.id)).toEqual(reconciled)
    expect(effect).not.toHaveBeenCalled()
  } finally { db.close(); vi.useRealTimers() }
}, 30_000)

async function deadlineChain(behavior: 'review-pr' | 'approve-pr', mode = 'quiet') {
  const root = directory = mkdtempSync(join(tmpdir(), 'poise-review-deadline-'))
  vi.useFakeTimers({ toFake: ['Date'] })
  const path = join(directory, 'journal.sqlite')
  let db = new Database(path)
  let journal = new BehaviorChainJournal(db)
  journal.append(chain.id, 'seed', 0, { type: 'chain.admitted', repository: chain.repository, issue: chain.issue,
    branch: chain.branch, author: chain.author, reviewer: chain.reviewer })
  const selected = { slot: 'primary', model: 'gpt-6-astra-ultra', recovery: 'gpt-6-astra-ultra' }
  const observed: ChainObservation = { checkedAt: Date.now(), existingPulls: [],
    issue: { open: true, eligible: true, revision: 'seed', commentIds: [] }, issueReviewers: [],
    prReviewers: behavior === 'review-pr' ? [selected] : [], implementer: selected, repairer: selected, approver: selected,
    publication: { pull_number: 21, head_sha: HEAD, head_invocation: null, state: 'open', merged: false, merge_sha: null },
    pull: { number: 21, head: HEAD, headSince: Date.now() - 1000, state: 'open', draft: false, merged: false,
      mergeSha: null, queueEntry: null, queueRemoval: null, changesRequested: false, unresolved: 0, approved: false,
      ready: false, reviewIds: [], reviewRevision: 'reviews', reviewContext: chainBasis(['b'.repeat(40), 'Candidate', '']),
      reviewReceipts: [], greyRuns: [], pending: false, failing: [], conflict: false, behind: false } }
  const results: Array<{ pending: LogEntry, released: LogEntry, posts: Array<NonNullable<ChainObservation['pull']>['reviewReceipts'][number] & { body: string }> }> = []
  let released = false
  const launch = vi.fn<ChainRuntimeOperations['launch']>(async invocation => {
    expect(invocation.behavior).toBe(behavior)
    // The admitted native argv is decoded by Caller's CLI. Only provider,
    // GitHub transport and physical cleanup witnesses are stand-ins.
    results.push(JSON.parse(execFileSync('python3', ['tests/fixtures/review-deadline.py'], {
      input: JSON.stringify({ argv: invocation.request.argv, mode, now: Date.now() }), encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PYTHONPATH: [resolve('caller/agent_interface'), process.env.PYTHONPATH].filter(Boolean).join(':') },
    })))
    vi.setSystemTime(Date.now() + 3000)
    released = false
    return true
  })
  const native = actionOperations({ resolve: async () => selected })
  const operations: ChainRuntimeOperations = { ...native, discover: async () => [], permitted: () => true,
    observe: async () => ({ ...observed, checkedAt: Date.now() }), launch,
    readInvocations: async ids => parseAgentLogList(results.map(result => released ? result.released : result.pending)
      .filter(call => ids.includes(call.correlation_id!))) }
  return { results, launch, observed, operations,
    get journal() { return journal },
    run: () => new BehaviorChainRuntime(journal, operations).run(),
    release: () => { released = true },
    current: () => journal.read(chain.id)!,
    restart: () => { db.close(); db = new Database(path); journal = new BehaviorChainJournal(db); journal.rebuild() },
    close: () => { db.close(); rmSync(root, { recursive: true, force: true }) } }
}

it.each(['review-pr', 'approve-pr'] as const)('settles a proven %s deadline only after release, retries on backoff and holds the third failure across restart', async behavior => {
  const run = await deadlineChain(behavior)
  try {
    await run.run()
    expect(run.results[0].pending).toMatchObject({ status: 'failed', action: 'not_started', outcome: 'preflight_failed',
      error_code: 'review_budget_exhausted', head_sha: null, review_id: null, resources_settled_at: null })
    expect(parseAgentLogList([run.results[0].pending]).quarantined).toEqual([])
    await run.run()
    expect(run.current().invocations[0].state).toBe('uncertain')
    expect(run.journal.liveModelInvocationCount()).toBe(1)
    run.release()
    await run.run()
    expect(run.current().invocations[0]).toMatchObject({ state: 'settled', evidence: { status: 'failed', error_code: 'review_budget_exhausted' } })
    expect(run.journal.liveModelInvocationCount()).toBe(0)
    expect(run.current().waiting).toContain('backoff')
    for (const attempt of [1, 2]) {
      const next = Date.parse(run.results.at(-1)!.released.completed_at!) + 60_000 * 2 ** (attempt - 1)
      vi.setSystemTime(next - 1)
      await run.run()
      expect(run.launch).toHaveBeenCalledTimes(attempt)
      vi.setSystemTime(next)
      await run.run()
      expect(run.launch).toHaveBeenCalledTimes(attempt + 1)
      run.release()
      await run.run()
    }
    expect(run.current().held).toContain(`${behavior} failed before publication three times`)
    run.restart()
    vi.setSystemTime(Date.now() + 3600_000)
    await run.run()
    expect(run.current().held).toContain('three times')
    expect(run.launch).toHaveBeenCalledTimes(3)
    expect(run.results.flatMap(result => result.posts)).toEqual([])
  } finally { run.close() }
}, 30_000)

it.each(['review-pr', 'approve-pr'] as const)('reconciles an original %s POST with a lost acknowledgement without another POST', async behavior => {
  const run = await deadlineChain(behavior, 'lost_ack')
  try {
    await run.run()
    const result = run.results[0]
    expect(result.released).toMatchObject({ status: 'failed', action: null, error_code: 'review_submission_failed',
      artifact: { phase: 'submitting_review' } })
    expect(result.posts).toHaveLength(1)
    expect(result.posts[0].body).toContain(`<!-- poise-invocation ${result.released.id} -->`)
    run.release()
    await run.run()
    run.restart()
    await run.run()
    expect(run.current().invocations[0].state).toBe('uncertain')
    run.observed.pull!.reviewReceipts = result.posts
    run.observed.pull!.reviewIds = [91]
    // Keep subsequent work disabled while testing read-only recovery.
    run.operations.enabled = () => false
    await run.run()
    expect(run.current().invocations[0]).toMatchObject({ state: 'settled', callId: result.released.id,
      evidence: { status: 'completed', review_id: 91, reconciliation: 'native invocation marker verified on the actual GitHub review' } })
    await run.run()
    expect(run.launch).toHaveBeenCalledTimes(1)
    expect(run.results.flatMap(value => value.posts)).toHaveLength(1)
  } finally { run.close() }
})

it.each(['pending', 'missing_inventory', 'changed_inventory', 'contradictory_counters', 'failed_read', 'wrong_target',
  'missing_artifact', 'submitting'])('keeps %s deadline evidence fenced through Caller completion and native cleanup', async mode => {
  for (const behavior of ['review-pr', 'approve-pr'] as const) {
    const run = await deadlineChain(behavior, mode)
    try {
      await run.run()
      expect(run.results[0].released).toMatchObject({ status: 'failed', action: null, outcome: null,
        error_code: 'review_budget_exhausted' })
      run.release()
      await run.run()
      run.restart()
      vi.setSystemTime(Date.now() + 3600_000)
      await run.run()
      expect(run.current().invocations[0].state).toBe('uncertain')
      expect(run.launch).toHaveBeenCalledTimes(1)
    } finally { run.close() }
  }
})

it.each(['correlation', 'target', 'head', 'review receipt', 'posting receipt', 'executed head', 'submitting', 'missing phase'])
  ('rejects %s evidence alongside a real Caller not-started deadline result', async mismatch => {
    const run = await deadlineChain('review-pr')
    try {
      await run.run()
      const call = run.results[0].released
      if (mismatch === 'correlation') call.correlation_id = 'another-invocation'
      if (mismatch === 'target') call.pr_id = '22'
      if (mismatch === 'head') call.expected_head = 'b'.repeat(40)
      if (mismatch === 'review receipt') call.review_id = 91
      if (mismatch === 'posting receipt') call.receipts = []
      if (mismatch === 'executed head') call.head_sha = HEAD
      if (mismatch === 'submitting') call.artifact!.phase = 'submitting_review'
      if (mismatch === 'missing phase') call.artifact = null
      run.release()
      for (let pass = 0; pass < 2; pass++) {
        if (mismatch === 'target' || mismatch === 'head') await expect(run.run()).rejects.toThrow('native review target conflicts')
        else await run.run()
        expect(run.current().invocations[0].state).not.toBe('settled')
      }
      expect(run.launch).toHaveBeenCalledTimes(1)
    } finally { run.close() }
  })

it('retires an already-held closed binding after a different PR closes the seed, preserving its original receipts', async () => {
  const db = new Database(':memory:')
  const journal = new BehaviorChainJournal(db)
  const target = { ...chain, id: 'example/repo#1251', issue: 1251, branch: 'poise/issue-1251' }
  let current = journal.append(target.id, 'seed', 0, { type: 'chain.admitted', repository: target.repository,
    issue: target.issue, branch: target.branch, author: target.author, reviewer: target.reviewer })
  for (const [index, behavior] of (['review-issue', 'implement-issue'] as const).entries()) {
    current = journal.append(current.id, `admit-${index}`, current.sequence, { type: 'invocation.admitted', invocation: {
      id: `original-${index}`, behavior, basis: 'original', actor: index ? 'author' : 'reviewer', model: 'fixture', slot: 'primary',
      admittedAt: Date.now() - 1000, request: { command: 'agent-interface', argv: ['--fixture'], cwd: '/fixture', nativeResources: 2 } } })
    current = journal.append(current.id, `settle-${index}`, current.sequence, { type: 'invocation.settled', invocationId: `original-${index}`,
      callId: String(index + 1).repeat(32), outcome: 'completed', evidence: { status: 'completed', resources_settled_at: new Date().toISOString(),
        resource_ownership: { version: 1, roots: [], errors: [] } } })
  }
  const closing = 'https://github.com/example/repo/pull/1260'
  current = journal.append(current.id, 'competing', current.sequence, { type: 'chain.observed', observation: {
    checkedAt: 0, issue: { open: true }, existingPulls: [closing],
    publication: { pull_number: 1259, head_sha: HEAD, head_invocation: null, state: 'closed', merged: false,
      merge_sha: '307c8a031acceae31843add8e66d97ce93ef5e13' },
    pull: { number: 1259, head: HEAD, headSince: Date.now() - 1000, reviewRevision: 'original', state: 'closed', merged: false, mergeSha: null } } })
  current = journal.append(current.id, 'held', current.sequence, { type: 'chain.held', reason: `seed issue already belongs to existing work: ${closing}` })
  const original = current
  const history = journal.history(current.id)
  let mode = 'verified'
  mocks.runFile.mockImplementation(async (command: string, argv: string[]) => {
    expect(command).toBe('github-interface')
    if (argv[0] === '--pr-readiness') return { stdout: JSON.stringify({ head_sha: HEAD, draft: false,
      reviewer_approved_current_head: false, unresolved_live_conversation_count: 0, unresolved_outdated_conversation_count: 0,
      green: false, blockers: ['pull_not_open'] }) }
    if (argv[0] === '--list-failing-ci') return { stdout: JSON.stringify({ head_sha: HEAD, pull_number: 1259, failing: [] }) }
    return { stdout: execFileSync('python3', ['tests/fixtures/closed-seed-merge.py'], {
      input: JSON.stringify({ argv, mode, bound: true }), encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PYTHONPATH: [resolve('caller/github_interface'), process.env.PYTHONPATH].filter(Boolean).join(':') },
    }) }
  })
  const effect = vi.fn(async () => { throw new Error('closed binding must not start work or publication') })
  const operations: ChainRuntimeOperations = { ...actionOperations(), discover: async () => [],
    readInvocations: async () => ({ entries: [], quarantined: [] }), request: effect, launch: effect,
    perform: effect, resumePublication: effect, fenceClosedTarget: effect }
  try {
    mode = 'contradictory'
    await expect(new BehaviorChainRuntime(journal, operations).run()).rejects.toThrow('external merge differs from its closing PR evidence')
    expect(journal.read(current.id)).toEqual(original)
    expect(journal.page('', 100, false)).toEqual([original])
    mode = 'verified'
    await new BehaviorChainRuntime(journal, operations).run()
    current = journal.read(current.id)!
    expect(current).toMatchObject({ held: original.held, mergeSha: null, invocations: original.invocations,
      observation: { existingPulls: [closing], publication: { pull_number: 1259, state: 'closed', merged: false,
        merge_sha: '307c8a031acceae31843add8e66d97ce93ef5e13' },
      pull: { number: 1259, state: 'closed', merged: false, mergeSha: null },
      externalMerge: { pull_number: 1260, merge_sha: 'd'.repeat(40) } } })
    expect(current).not.toHaveProperty('reviewPending')
    expect(journal.page('', 100, false)).toEqual([])
    expect(journal.history(current.id)).toEqual([...history, expect.objectContaining({
      payload: JSON.stringify({ type: 'chain.observed', observation: current.observation }) }), expect.objectContaining({
      payload: JSON.stringify({ type: 'chain.waiting', reason: original.held }) })])
    journal.rebuild()
    expect(journal.read(current.id)).toEqual(current)
    expect(journal.forPull(target.repository, 1259)).toEqual(current)
    expect(journal.forPull(target.repository, 1260)).toBeNull()
    expect(journal.page('', 100, false)).toEqual([])
    expect(effect).not.toHaveBeenCalled()
  } finally { db.close() }
}, 30_000)

it.each([
  { name: 'clean', blockers: [], mergeable: true, mergeState: 'clean', expected: 'review-pr' },
  { name: 'behind with queue integration', blockers: [], mergeable: true, mergeState: 'behind', expected: 'review-pr' },
  { name: 'behind requiring a base update', blockers: ['merge_state_not_clean'], mergeable: true, mergeState: 'behind', expected: 'review-pr' },
  { name: 'conflicting', blockers: ['not_mergeable'], mergeable: false, mergeState: 'dirty', expected: 'repair-pr' },
])('selects $expected for an unreviewed $name PR using exact-head native evidence', async ({ blockers, mergeable, mergeState, expected }) => {
  let ciHead = HEAD
  mocks.runFile.mockImplementation(async (_command: string, argv: string[]) => {
    const evidence: Record<string, unknown> = {
      '--chain-seed': { repository: 'example/repo', issue_number: 7, actor: 'author', branch: 'poise/issue-7',
        issue: { title: 'Seed', body: '', state: 'open', labels: [] }, comments: [],
        publication: { existing_pulls: [], pull_number: 21, head_sha: HEAD, head_invocation: null, state: 'open', merged: false, merge_sha: null } },
      '--pull-action-state': { pull_number: 21, state: 'open', head_sha: HEAD, review_context: 'b'.repeat(64), merged: false, queue_entry_id: null, queue_removals: [], my_reviews: [] },
      '--pr-readiness': { head_sha: HEAD, draft: false, reviewer_approved_current_head: false,
        unresolved_live_conversation_count: 0, unresolved_outdated_conversation_count: 0, green: false, blockers: [...blockers, 'reviewer_not_approved_current_head'] },
      '--list-failing-ci': { head_sha: ciHead, pull_number: 21, failing: [], mergeable, mergeable_state: mergeState },
    }
    if (!(argv[0] in evidence)) throw new Error(`unexpected native operation ${argv[0]}`)
    return { stdout: JSON.stringify(evidence[argv[0]]) }
  })
  const operations = nativeChainOperations({ login: 'example' } as Organization, {
    roster: async () => ({ issueReviewers: [], prReviewers: [reviewer], implementer: reviewer, repairer: reviewer, approver: reviewer }),
    resolve: async () => reviewer, prepare: async () => ({}), borrow: () => () => {}, available: () => true,
    capacity: () => 3, permitted: () => true, note: () => '', severity: () => 'p2', received: () => {},
    reviews: async () => 'reviews', existing: async () => new Set(), wake: () => {},
  })
  const observation = await operations.observe(chain)
  expect(observation.pull).toMatchObject({ reviewIds: [], reviewReceipts: [], failing: [], pending: false,
    conflict: !mergeable, behind: mergeState === 'behind' && blockers.includes('merge_state_not_clean') })
  const decision = decideBehaviorChain(chain, observation, Date.now())
  expect(decision).toMatchObject({ kind: 'invoke', behavior: expected })
  if (expected === 'repair-pr') {
    if (decision.kind !== 'invoke') throw new Error('expected conflict repair')
    const request = await operations.request(chain, observation, decision, 'conflict-repair')
    expect(request).toMatchObject({ command: 'agent-interface', context: { head: HEAD, reviewRevision: 'reviews' } })
    expect(request?.argv).toEqual(expect.arrayContaining(['--atomic-work', 'example/repo#7', '--actor', 'author',
      '--pull-number', '21', '--expected-head', HEAD, '--merge-base']))
    ciHead = 'c'.repeat(40)
    await expect(operations.observe(chain)).rejects.toThrow('native PR observations changed head or are incomplete')
  }
})

it('observes the #1517 queue blocker independently of PR mergeability and replaces integration evidence on the same head', async () => {
  const head = 'ee7c6737a58dbdbbebbc59eb9222891e7af72f22'
  const predecessor = '7ad75ba8c4fa9ab4df456e13824a311715082e64'
  const entry = { id: 'MQE_lQDOU59AVM8AAAABO91Wr84ABOPkzgP6O_8', state: 'UNMERGEABLE', base: predecessor, head: null as string | null }
  const state = { pull_number: 1517, state: 'open', head_sha: head, review_context: 'b'.repeat(64), merged: false,
    queue_entry_id: entry.id as string | null, queue_entry: entry as typeof entry | null,
    queue_removals: [] as Array<{ id: string, reason: string, createdAt: string, actor: null }>, my_reviews: [] }
  const ci = { head_sha: head, pull_number: 1517, failing: [], mergeable: null, mergeable_state: 'unknown', base_sha: 'c'.repeat(40) }
  mocks.runFile.mockImplementation(async (_command: string, argv: string[]) => {
    const evidence: Record<string, unknown> = {
      '--chain-seed': { repository: chain.repository, issue_number: 7, actor: 'author', branch: chain.branch,
        issue: { title: 'Seed', body: '', state: 'open', labels: [] }, comments: [],
        publication: { existing_pulls: [], pull_number: 1517, head_sha: head, head_invocation: null, state: 'open', merged: false, merge_sha: null } },
      '--pull-action-state': state,
      '--pr-readiness': { head_sha: head, draft: false, reviewer_approved_current_head: true, checks_state: 'SUCCESS',
        unresolved_live_conversation_count: 0, unresolved_outdated_conversation_count: 0, green: false, blockers: ['not_mergeable'] },
      '--list-failing-ci': ci,
    }
    if (!(argv[0] in evidence)) throw new Error(`unexpected native operation ${argv[0]}`)
    return { stdout: JSON.stringify(evidence[argv[0]]) }
  })
  const operations = actionOperations()
  const first = await operations.observe(chain)
  expect(first.pull).toMatchObject({ head, queueEntry: entry.id, queueEntryDetails: entry, conflict: false, behind: false })
  expect(decideBehaviorChain(chain, first, Date.now())).toEqual({ kind: 'wait',
    reason: `native merge queue owns entry ${entry.id}; queue UNMERGEABLE; cause unknown` })
  // An integration is replaceable without changing the PR head or queue entry.
  Object.assign(entry, { state: 'AWAITING_CHECKS', base: 'd'.repeat(40), head: 'e'.repeat(40) })
  const replaced = await operations.observe({ ...chain, observation: first })
  expect(replaced.pull).toMatchObject({ head, headSince: first.pull!.headSince, queueEntryDetails: entry, conflict: false })
  expect(decideBehaviorChain(chain, replaced, Date.now())).toMatchObject({ kind: 'wait', reason: expect.stringContaining('AWAITING_CHECKS') })
  state.queue_entry_id = 'replacement-entry'
  await expect(operations.observe(chain)).rejects.toThrow('disposition is incomplete or mismatched')
  entry.id = state.queue_entry_id
  expect((await operations.observe(chain)).pull?.queueEntryDetails).toEqual(entry)
  // GitHub removed the entry at 22:18:15 Helsinki; #1525 became main one second later.
  state.queue_entry_id = null; state.queue_entry = null
  state.queue_removals = [{ id: 'recorded-removal', reason: 'merge_conflict', createdAt: '2026-11-13T20:18:15Z', actor: null }]
  ci.base_sha = predecessor; state.review_context = 'f'.repeat(64)
  const removed = await operations.observe({ ...chain, observation: first })
  expect(removed.pull).toMatchObject({ head, queueEntry: null, queueEntryDetails: null,
    queueRemoval: { id: 'recorded-removal', reason: 'merge_conflict' }, reviewContext: state.review_context, conflict: false })
  const repair = await operations.request(chain, removed,
    { kind: 'invoke', behavior: 'repair-pr', basis: 'queue-repair', actor: 'author', reviewer, reason: 'verified removal' }, 'repair')
  expect(repair?.context).toMatchObject({ head, queueRemoval: 'recorded-removal' })
  expect(repair?.argv).toContain('--merge-base')
})

it('records a pull closed without merging, which carries no queue removal evidence, and holds', async () => {
  const pullState: Record<string, unknown> = { pull_number: 21, state: 'closed', head_sha: HEAD, review_context: 'b'.repeat(64), merged: false, queue_entry_id: null, my_reviews: [] }
  mocks.runFile.mockImplementation(async (_command: string, argv: string[]) => {
    const evidence: Record<string, unknown> = {
      '--chain-seed': { repository: 'example/repo', issue_number: 7, actor: 'author', branch: 'poise/issue-7',
        issue: { title: 'Seed', body: '', state: 'closed', labels: [] }, comments: [],
        publication: { existing_pulls: [], pull_number: 21, head_sha: HEAD, head_invocation: null, state: 'closed', merged: false, merge_sha: null } },
      '--pull-action-state': pullState,
      '--pr-readiness': { head_sha: HEAD, draft: false, reviewer_approved_current_head: false,
        unresolved_live_conversation_count: 0, unresolved_outdated_conversation_count: 0, green: false, blockers: ['pull_not_open'] },
      '--list-failing-ci': { head_sha: HEAD, pull_number: 21, failing: [], mergeable: true, mergeable_state: 'behind' },
    }
    if (!(argv[0] in evidence)) throw new Error(`unexpected native operation ${argv[0]}`)
    return { stdout: JSON.stringify(evidence[argv[0]]) }
  })
  const observation = await actionOperations().observe(chain)
  expect(observation.pull).toMatchObject({ number: 21, state: 'closed', merged: false, queueRemoval: null })
  expect(decideBehaviorChain(chain, observation, Date.now())).toEqual({ kind: 'hold', reason: 'pull request closed without a confirmed merge' })
  pullState.state = 'open'
  await expect(actionOperations().observe(chain)).rejects.toThrow('native PR observations changed head or are incomplete')
})

it.each(['failure', 'pending', 'missing', 'success', 'queue-success', 'reused-queue', 'stale-success', 'shadowed-success', 'shadowed-failure', 'wrong-head', 'wrong-base', 'unknown-run'])(
  'rechecks the exact current base for a retained CI dependency: %s', async state => {
    const base = 'd'.repeat(40)
    const dependency = { head: HEAD, integration: 'c'.repeat(40), base: 'b'.repeat(40), removal: 'failed-integration',
      remediation: 'https://github.com/example/repo/pull/99', allShared: true,
      failures: [{ name: 'unit', check: 11, run: 10, workflow: 1 }] }
    const repair: ChainInvocation = { ...mergeInvocation(), id: 'diagnosis', behavior: 'repair-pr', actor: 'author', model: 'fixture',
      state: 'settled', callId: 'b'.repeat(32), outcome: 'no_changes',
      request: { command: 'agent-interface', cwd: '/fixture', argv: [],
        context: { head: HEAD, reviewRevision: 'reviews', queueRemoval: 'failed-integration' } },
      evidence: { status: 'completed', action: 'no_changes', head_sha: HEAD, artifact: { ci_dependency: dependency } } }
    const baseline = { head_sha: state === 'wrong-head' ? 'e'.repeat(40) : HEAD,
      ref: state === 'wrong-base' ? 'e'.repeat(40) : base,
      checks: state === 'missing' ? [] : [
        { name: 'unit', check_run_id: 21, head_sha: base, run_id: 20,
          state: state === 'pending' ? 'in_progress' : 'completed', conclusion: ['success', 'queue-success', 'reused-queue', 'stale-success', 'shadowed-success'].includes(state) ? 'success' : 'failure' },
        ...(state === 'stale-success' ? [{ name: 'unit', check_run_id: 22, head_sha: base, run_id: 20, state: 'completed', conclusion: 'failure' }] : []),
        ...(state === 'reused-queue' ? [{ name: 'unit', check_run_id: 22, head_sha: base, run_id: 20, state: 'completed', conclusion: 'skipped' }] : []),
        ...(['shadowed-success', 'shadowed-failure'].includes(state) ? [{ name: 'unit', check_run_id: 22, head_sha: base, run_id: 30, state: 'completed', conclusion: 'success' }] : []),
      ], runs: state === 'unknown-run' ? [] : [{ id: 20, head_sha: base, workflow_id: 1,
        event: ['queue-success', 'reused-queue'].includes(state) ? 'merge_group' : 'push' },
        ...(['shadowed-success', 'shadowed-failure'].includes(state) ? [{ id: 30, head_sha: base, workflow_id: 2, event: 'push' }] : [])] }
    const reads: string[][] = []
    mocks.runFile.mockImplementation(async (_command: string, argv: string[]) => {
      reads.push(argv)
      const evidence: Record<string, unknown> = {
        '--chain-seed': { repository: chain.repository, issue_number: 7, actor: 'author', branch: chain.branch,
          issue: { title: 'Seed', body: '', state: 'open', labels: [] }, comments: [],
          publication: { existing_pulls: [], pull_number: 21, head_sha: HEAD, head_invocation: null, state: 'open', merged: false, merge_sha: null } },
        '--pull-action-state': { pull_number: 21, state: 'open', head_sha: HEAD, review_context: 'b'.repeat(64), merged: false,
          queue_entry_id: null, queue_removals: [{ id: 'failed-integration', reason: 'failed_checks', createdAt: new Date(Date.now() - 500).toISOString(), actor: null }], my_reviews: [] },
        '--pr-readiness': { head_sha: HEAD, draft: false, reviewer_approved_current_head: true,
          unresolved_live_conversation_count: 0, unresolved_outdated_conversation_count: 0, green: true, blockers: [] },
        '--list-failing-ci': argv.includes('--ref') ? baseline : { head_sha: HEAD, base_sha: base, pull_number: 21,
          failing: [], mergeable: true, mergeable_state: 'clean' },
      }
      if (!(argv[0] in evidence)) throw new Error(`unexpected native operation ${argv[0]}`)
      return { stdout: JSON.stringify(evidence[argv[0]]) }
    })
    const operations = actionOperations()
    const current = { ...chain, invocations: [repair] }
    if (['wrong-head', 'wrong-base'].includes(state)) {
      await expect(operations.observe(current)).rejects.toThrow('changed candidate/base')
      return
    }
    const observation = await operations.observe(current)
    const recovered = ['success', 'queue-success', 'reused-queue', 'shadowed-success'].includes(state)
    expect(observation.ciDependency).toEqual({ invocationId: repair.id, base, recovered })
    expect(decideBehaviorChain(current, observation, Date.now())).toMatchObject(recovered
      ? { kind: 'invoke', behavior: 'approve-pr' } : { kind: 'wait', reason: expect.stringContaining('shared baseline CI dependency') })
    expect(reads.filter(argv => argv.includes('--ref'))).toEqual([
      ['--list-failing-ci', '21', '--ref', 'base', '--token-user', 'reviewer'],
    ])
    const request = await operations.request(current, observation,
      { kind: 'invoke', behavior: 'repair-pr', basis: 'repair', actor: 'author', reviewer, reason: '' }, 'repair-id')
    expect(request?.argv).not.toContain('--merge-base')
    observation.pull!.queueRemoval!.reason = 'merge_conflict'
    const conflict = await operations.request(current, observation,
      { kind: 'invoke', behavior: 'repair-pr', basis: 'repair', actor: 'author', reviewer, reason: '' }, 'repair-id')
    expect(conflict?.argv).toContain('--merge-base')
  })

it.each(['verified', 'edited merge', 'missing proof', 'wrong ref', 'wrong head', 'wrong PR', 'wrong repository',
  'wrong readiness PR', 'wrong readiness repository', 'wrong source', 'wrong parents', 'missing base', 'changed publication'])(
  'binds CI hold base-update proof to the same repository, PR and head: %s', async mode => {
    const failed = 'd'.repeat(40), base = 'c'.repeat(40), tree = 'f'.repeat(40)
    const held = { ...chain, held: 'CI failed', ciHold: { invocationId: 'repair', callId: 'b'.repeat(32), head: failed } }
    const update = { from: failed, base, tree }
    const ci: Record<string, unknown> = { repository: chain.repository, head_sha: HEAD, ref: HEAD, base_sha: base,
      pull_number: 21, parents: [failed, base], base_update: update, failing: [], mergeable: true, mergeable_state: 'clean' }
    const readiness = { repository: chain.repository, pull_number: 21, head_sha: HEAD, draft: false,
      checks_state: 'SUCCESS', reviewer_approved_current_head: false, unresolved_live_conversation_count: 0,
      unresolved_outdated_conversation_count: 0, green: false, blockers: ['reviewer_not_approved_current_head'] }
    if (mode === 'edited merge') ci.base_update = null
    if (mode === 'missing proof') delete ci.base_update
    if (mode === 'wrong ref') ci.ref = base
    if (mode === 'wrong head') ci.head_sha = base
    if (mode === 'wrong PR') ci.pull_number = 22
    if (mode === 'wrong repository') ci.repository = 'other/repo'
    if (mode === 'wrong readiness PR') readiness.pull_number = 22
    if (mode === 'wrong readiness repository') readiness.repository = 'other/repo'
    if (mode === 'wrong source') update.from = base
    if (mode === 'wrong parents') ci.parents = [base, failed]
    if (mode === 'missing base') delete ci.base_sha
    const reads: string[][] = []
    mocks.runFile.mockImplementation(async (_command: string, argv: string[]) => {
      reads.push(argv)
      const evidence: Record<string, unknown> = {
        '--chain-seed': { repository: chain.repository, issue_number: 7, actor: 'author', branch: chain.branch,
          issue: { title: 'Seed', body: '', state: 'open', labels: [] }, comments: [],
          publication: { existing_pulls: [], pull_number: 21, head_sha: mode === 'changed publication' ? failed : HEAD,
            head_invocation: null, state: 'open', merged: false, merge_sha: null } },
        '--pull-action-state': { pull_number: 21, state: 'open', head_sha: HEAD, review_context: 'b'.repeat(64),
          merged: false, queue_entry_id: null, queue_removals: [], my_reviews: [] },
        '--pr-readiness': readiness,
        '--list-failing-ci': ci,
      }
      if (!(argv[0] in evidence)) throw new Error(`unexpected native operation ${argv[0]}`)
      return { stdout: JSON.stringify(evidence[argv[0]]) }
    })
    const result = actionOperations().observe(held)
    if (!['verified', 'edited merge'].includes(mode)) {
      await expect(result).rejects.toThrow()
      return
    }
    const observation = await result
    expect(observation.pull).toMatchObject({ head: HEAD, checksState: 'SUCCESS', approved: false, ready: false })
    expect(observation.ciBaseUpdate).toEqual(mode === 'verified' ? { ...update, head: HEAD } : undefined)
    expect(held.ciHold.head).toBe(failed)
    expect(reads.filter(argv => argv[0] === '--list-failing-ci')).toEqual([
      ['--list-failing-ci', '21', '--base-update-from', failed, '--token-user', 'reviewer'],
    ])
  })

it.each(['rerun', 'conflict'])('retains a Caller-produced CI-only hold through settlement and restart, then recovers a %s', async mode => {
  const failedHead = 'fcea77111bf5842239e81afb5e069b1fafa78fd6'
  const failedCheck = { type: 'check_run', name: 'Unit & integration (1)', state: 'completed', conclusion: 'failure',
    check_run_id: 132038286724, log_id: 132038286724,
    url: 'https://github.com/example/repo/actions/runs/43469739427/job/132038286724' }
  const ci = { action: 'list_failing_ci', repository: chain.repository, pull_number: 21, head_sha: failedHead,
    checks: [failedCheck], failing: [failedCheck], mergeable: true, mergeable_state: 'clean' }
  let green = false, conflict = false, pending = false, ready = false, head = failedHead, publication: string | null = null
  let wire = '[]', released = '', reviewers: typeof reviewer[] = []
  const reviews: LogEntry[] = []
  mocks.runFile.mockImplementation(async (command: string, argv: string[]) => {
    if (command === 'agent-interface') {
      expect(argv[0]).toBe('--logs')
      return { stdout: wire }
    }
    const evidence: Record<string, unknown> = {
      '--chain-seed': { repository: chain.repository, issue_number: 7, actor: 'author', branch: chain.branch,
        issue: { title: 'Seed', body: '', state: 'open', labels: [] }, comments: [],
        publication: { existing_pulls: [], pull_number: 21, head_sha: head, head_invocation: publication, state: 'open', merged: false, merge_sha: null } },
      '--pull-action-state': { pull_number: 21, state: 'open', head_sha: head, review_context: 'b'.repeat(64),
        merged: false, queue_entry_id: null, queue_removals: [], my_reviews: reviews.map(review => ({ id: review.review_id,
          commit_id: head, state: review.action === 'approved' ? 'APPROVED' : 'COMMENTED', invocation_id: review.id,
          review_response: review.artifact!.review_response, submitted_at: review.completed_at })) },
      '--pr-readiness': { head_sha: head, draft: false, checks_state: pending ? 'PENDING' : green ? 'SUCCESS' : 'FAILURE',
        reviewer_approved_current_head: reviews.some(review => review.action === 'approved'), unresolved_live_conversation_count: 0,
        unresolved_outdated_conversation_count: 0, green: ready, blockers: ['reviewer_not_approved_current_head', ...(green ? [] : ['checks_failed'])] },
      '--list-failing-ci': pending ? { ...ci, head_sha: head, mergeable: true,
        failing: [{ ...failedCheck, state: 'in_progress', conclusion: null }] }
        : green ? { ...ci, head_sha: head, failing: [], checks: [{ ...failedCheck, conclusion: 'success',
        check_run_id: 132038286725, log_id: 132038286725,
        url: 'https://github.com/example/repo/actions/runs/43469739427/job/132038286725' }] }
          : { ...ci, mergeable: conflict ? false : true, mergeable_state: conflict ? 'dirty' : 'clean' },
    }
    if (!(argv[0] in evidence)) throw new Error(`unexpected native operation ${argv[0]}`)
    return { stdout: JSON.stringify(evidence[argv[0]]) }
  })
  const native = actionOperations({ roster: async () => ({ issueReviewers: [], prReviewers: reviewers,
    implementer: reviewer, repairer: reviewer, approver: reviewer }) })
  const launch = vi.fn<ChainRuntimeOperations['launch']>(async invocation => {
    if (invocation.behavior === 'repair-pr' && wire === '[]') {
      const receipts = JSON.parse(execFileSync('python3', ['tests/fixtures/ci-only-repair.py'], {
        input: JSON.stringify({ argv: invocation.request.argv, ci }), encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, PYTHONPATH: resolve('caller/agent_interface') },
      })) as { pending: unknown[], released: unknown[] }
      wire = JSON.stringify(receipts.pending)
      released = JSON.stringify(receipts.released)
    }
    return true
  })
  const operations = { ...native, discover: async () => [], launch }
  const db = new Database(':memory:')
  try {
    let journal = new BehaviorChainJournal(db)
    journal.append(chain.id, 'seed', 0, { type: 'chain.admitted', repository: chain.repository, issue: chain.issue,
      branch: chain.branch, author: chain.author, reviewer: chain.reviewer })
    let runtime = new BehaviorChainRuntime(journal, operations)
    await runtime.run()
    expect(launch).toHaveBeenCalledTimes(1)
    const snapshot = parseAgentLogList(JSON.parse(released))
    expect(snapshot.quarantined).toEqual([])
    const call = snapshot.entries[0]
    expect(call).toMatchObject({ status: 'failed', behavior: 'repair_pr', action: 'not_started', head_sha: null,
      error_code: 'atomic_work_blocked', review_id: null, receipts: null,
      artifact: { phase: 'executing', ci_blocker: { action: ci.action, repository: ci.repository,
        pull_number: ci.pull_number, head_sha: failedHead, failing: [failedCheck] } } })
    expect(call.artifact).not.toHaveProperty('plan_sha')
    const hold = { invocationId: call.correlation_id, callId: call.id, head: failedHead }
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse(call.completed_at!) + 1000)
    await runtime.run()
    expect(journal.read(chain.id)).toMatchObject({ held: call.error, ciHold: hold, invocations: [{ state: 'uncertain' }] })
    expect(behaviorChainWorkImpact(journal, call.id, null)?.nextAction).toContain('original invocation receipt')
    wire = released
    await runtime.run()
    const settled = journal.read(chain.id)!
    expect(settled).toMatchObject({ held: call.error, ciHold: hold, invocations: [{ state: 'settled' }] })
    const next = 'Automatically recheck CI before resuming; fresh review and queue checks still apply'
    expect(behaviorChainWorkImpact(journal, call.id, null)).toMatchObject({ impact: 'blocked', retryAt: null, nextAction: next })
    expect(behaviorChainAttention(journal)).toMatchObject([{ nextAction: next,
      reconciliation: { nextObservationAt: journal.reconciliationAt(settled), waitingForResourceRelease: false } }])
    const history = journal.history(chain.id)
    journal.rebuild()
    journal = new BehaviorChainJournal(db)
    runtime = new BehaviorChainRuntime(journal, operations)
    expect(journal.read(chain.id)).toEqual(settled)
    await runtime.run()
    expect(journal.history(chain.id)).toEqual(history)
    green = mode === 'rerun'
    conflict = mode === 'conflict'
    reviewers = [reviewer]
    vi.setSystemTime(journal.reconciliationAt(settled)!)
    await runtime.run()
    const recovered = journal.read(chain.id)!
    expect(recovered.held).toBeNull()
    expect(recovered.ciHold).toBeUndefined()
    expect(recovered.invocations[0]).toEqual(settled.invocations[0])
    expect(recovered.invocations.at(-1)).toMatchObject({ behavior: conflict ? 'repair-pr' : 'review-pr', state: 'started' })
    expect(launch).toHaveBeenCalledTimes(2)
    expect(journal.history(chain.id).map(row => JSON.parse(row.payload))).toContainEqual({ type: 'chain.resumed', ciRecovery: hold })
    expect(recovered.resumedAfterSequence).toBe(settled.resumedAfterSequence)
    if (mode === 'rerun') return
    const repair = recovered.invocations.at(-1)!
    expect(repair.request.argv).toEqual(expect.arrayContaining(['--pull-number', '21', '--expected-head', failedHead, '--merge-base']))
    expect(recovered.observation).toMatchObject({ pull: { head: failedHead, conflict: true, failing: [expect.stringContaining('failure')] } })
    head = 'e'.repeat(40); publication = 'e'.repeat(32); conflict = false; pending = true
    vi.setSystemTime(Date.now() + 2000)
    const published: LogEntry = { ...call, id: publication, correlation_id: repair.id, status: 'completed', action: 'published',
      outcome: 'published', head_sha: head, error: '', error_code: null, artifact: { phase: 'published' },
      completed_at: new Date().toISOString(), resources_settled_at: new Date().toISOString() }
    const calls: LogEntry[] = [call, published]
    wire = JSON.stringify(calls)
    await runtime.run()
    let current = journal.read(chain.id)!
    expect(current.invocations.at(-1)).toMatchObject({ behavior: 'review-pr', state: 'started' })
    expect(current.invocations.at(-1)!.request.argv).toEqual(expect.arrayContaining(['--expected-head', head]))
    expect(launch).toHaveBeenCalledTimes(3)
    vi.setSystemTime(Date.now() + 2000)
    const review = { ...completedReviewCall(chain.repository, 21, head, chain.reviewer), source: 'poise:behavior-chain',
      correlation_id: current.invocations.at(-1)!.id, resources_settled_at: new Date().toISOString(),
      resource_ownership: { version: 1 as const, roots: [], errors: [] } }
    reviews.push(review); calls.push(review); wire = JSON.stringify(calls)
    await runtime.run()
    expect(journal.read(chain.id)!.waiting).toBe('exact-head CI is still running')
    expect(launch).toHaveBeenCalledTimes(3)
    pending = false; green = true
    await runtime.run()
    current = journal.read(chain.id)!
    expect(current.invocations.at(-1)).toMatchObject({ behavior: 'approve-pr', state: 'started' })
    expect(launch).toHaveBeenCalledTimes(4)
    vi.setSystemTime(Date.now() + 2000)
    const approval: LogEntry = { ...completedReviewCall(chain.repository, 21, head, chain.reviewer), id: 'f'.repeat(32),
      source: 'poise:behavior-chain', behavior: 'pr_approve', action: 'approved', outcome: 'approved', review_id: 92,
      correlation_id: current.invocations.at(-1)!.id, resources_settled_at: new Date().toISOString(),
      resource_ownership: { version: 1, roots: [], errors: [] } }
    approval.artifact!.review_response = { ...(approval.artifact!.review_response as Record<string, unknown>), invocation_id: approval.id }
    reviews.push(approval); calls.push(approval); wire = JSON.stringify(calls)
    await runtime.run()
    current = journal.read(chain.id)!
    expect(current.waiting).toBe('native repository readiness gates are not satisfied')
    expect(current.invocations[0]).toEqual(settled.invocations[0])
    expect(launch).toHaveBeenCalledTimes(4)
    ready = true
    const fresh = await operations.observe(current)
    expect(decideBehaviorChain(current, fresh, Date.now())).toMatchObject({ kind: 'invoke', behavior: 'merge-pr' })
    fresh.pull!.queueEntry = 'new-head-queue'
    expect(decideBehaviorChain(current, fresh, Date.now())).toEqual({ kind: 'wait', reason: 'native merge queue owns entry new-head-queue' })
  } finally { db.close() }
})

const invoke = (behavior: string) => ({ kind: 'invoke', behavior })
const gatesUnsatisfied = { kind: 'wait', reason: 'native repository readiness gates are not satisfied' }
it.each([
  { approved: true, blockers: ['required_reviews_not_approved'], expected: invoke('resolve-threads') },
  { approved: true, blockers: ['merge_state_not_clean'], expected: invoke('resolve-threads') },
  { approved: false, blockers: ['required_reviews_not_approved', 'reviewer_not_approved_current_head'], expected: invoke('approve-pr') },
  // The native resolver's gate refuses these, so admitting it would only defer and re-admit.
  { approved: true, blockers: ['changes_requested'], expected: gatesUnsatisfied },
  { approved: true, blockers: ['checks_missing'], expected: gatesUnsatisfied },
  { approved: true, blockers: ['required_reviews_not_approved', 'changes_requested'], expected: gatesUnsatisfied },
])('resolves outdated threads only when approved and a conversation can explain every blocker: $blockers', async ({ approved, blockers, expected }) => {
  mocks.runFile.mockImplementation(async (_command: string, argv: string[]) => {
    const evidence: Record<string, unknown> = {
      '--chain-seed': { repository: 'example/repo', issue_number: 7, actor: 'author', branch: 'poise/issue-7',
        issue: { title: 'Seed', body: '', state: 'open', labels: [] }, comments: [],
        publication: { existing_pulls: [], pull_number: 21, head_sha: HEAD, head_invocation: null, state: 'open', merged: false, merge_sha: null } },
      '--pull-action-state': { pull_number: 21, state: 'open', head_sha: HEAD, review_context: 'b'.repeat(64), merged: false, queue_entry_id: null, queue_removals: [], my_reviews: [] },
      '--pr-readiness': { head_sha: HEAD, draft: false, reviewer_approved_current_head: approved,
        unresolved_live_conversation_count: 0, unresolved_outdated_conversation_count: 1, green: false, blockers },
      '--list-failing-ci': { head_sha: HEAD, pull_number: 21, failing: [], mergeable: true, mergeable_state: 'blocked' },
    }
    if (!(argv[0] in evidence)) throw new Error(`unexpected native operation ${argv[0]}`)
    return { stdout: JSON.stringify(evidence[argv[0]]) }
  })
  const observation = await actionOperations().observe(chain)
  expect(decideBehaviorChain(chain, observation, Date.now())).toMatchObject(expected)
})

it('reconciles planned review comments with and without the revision marker', async () => {
  const callId = 'c'.repeat(32)
  // A review interrupted after posting: one comment carries the revision
  // marker, one was posted by an older Caller without it. Both are this
  // run's receipts, so the chain completes instead of blocking.
  const plan = { kind: 'issue_review', posts: [
    { issue: 'example/repo#7', body: 'Marked.' },
    { issue: 'example/repo#7', body: 'Legacy.' },
  ], model: 'fixture', issue_revision: 'd'.repeat(64) }
  const digest = chainBasis(plan)
  const marked = `Marked.\n\n---\n<sub>Issue review · \`fixture\` · rev \`dddddddd\`</sub>\n<!-- agent-interface issue-review call=${callId} -->`
  const legacy = `Legacy.\n\n---\n<sub>Issue review · \`fixture\`</sub>\n<!-- agent-interface issue-review call=${callId} -->`
  mocks.runFile.mockImplementation(async (_command: string, argv: string[]) => {
    const evidence: Record<string, unknown> = {
      '--chain-seed': { repository: 'example/repo', issue_number: 7, actor: 'author', branch: 'poise/issue-7',
        issue: { title: 'Seed', body: '', state: 'open', labels: [] },
        comments: [
          { id: 7, author: 'reviewer', body: marked, url: 'https://example.test/marked' },
          { id: 8, author: 'reviewer', body: legacy, url: null },
        ],
        publication: { existing_pulls: [], pull_number: null, head_sha: null, head_invocation: null, state: null, merged: false, merge_sha: null } },
      '--read-action-plan': { id: callId, sha: digest, plan },
      view: { repo: chain.repository, number: 7, found: true, complete: true, prerequisites: [] },
    }
    if (!(argv[0] in evidence)) throw new Error(`unexpected native operation ${argv[0]}`)
    return { stdout: JSON.stringify(evidence[argv[0]]) }
  })
  const operations = nativeChainOperations({ login: 'example' } as Organization, {
    roster: async () => ({ issueReviewers: [], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer }),
    resolve: async () => reviewer, prepare: async () => ({}), borrow: () => () => {}, available: () => true,
    capacity: () => 3, permitted: () => true, note: () => '', severity: () => 'p2', received: () => {},
    reviews: async () => 'reviews', existing: async () => new Set(), wake: () => {},
  })
  const uncertain: BehaviorChain = { ...chain, invocations: [{ id: 'inv-1', behavior: 'review-issue', basis: 'basis',
    actor: 'reviewer', model: 'fixture', slot: 'primary', reservation: null, admittedAt: Date.now(), admissionSequence: 1,
    request: { command: 'agent-interface', argv: [], cwd: '/interface' }, state: 'uncertain', callId,
    outcome: null, evidence: { callId, artifact: { plan_sha: digest } } }] }
  const observation = await operations.observe(uncertain)
  expect(observation.reviewPublication).toEqual({ callId, planSha: digest, complete: true, issueRevision: 'd'.repeat(64), receipts: [
    { issue: 'example/repo#7', comment_id: 7, author: 'reviewer', url: 'https://example.test/marked' },
    { issue: 'example/repo#7', comment_id: 8, author: 'reviewer', url: null },
  ] })
})

it('seeds roster draws and resolutions by the chain seed issue', async () => {
  mocks.runFile.mockImplementation(async (_command: string, argv: string[]) => {
    const evidence: Record<string, unknown> = {
      '--chain-seed': { repository: 'example/repo', issue_number: 7, actor: 'author', branch: 'poise/issue-7',
        issue: { title: 'Seed', body: '', state: 'open', labels: [] }, comments: [],
        publication: { existing_pulls: [], pull_number: null, head_sha: null, head_invocation: null, state: 'open', merged: false, merge_sha: null } },
      view: { repo: chain.repository, number: 7, found: true, complete: true, prerequisites: [] },
    }
    if (!(argv[0] in evidence)) throw new Error(`unexpected native operation ${argv[0]}`)
    return { stdout: JSON.stringify(evidence[argv[0]]) }
  })
  const roster = vi.fn(async () => ({ issueReviewers: [reviewer], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer }))
  const resolve = vi.fn(async () => reviewer)
  const operations = nativeChainOperations({ login: 'example' } as Organization, {
    roster, resolve, prepare: async () => ({}), borrow: () => () => {}, available: () => true,
    capacity: () => 3, permitted: () => true, note: () => '', severity: () => 'p2', received: () => {},
    reviews: async () => 'reviews', existing: async () => new Set(), wake: () => {},
  })
  const observation = await operations.observe(chain)
  expect(roster).toHaveBeenCalledWith('example/repo#7')
  const decision = { kind: 'invoke', behavior: 'review-issue', basis: '', actor: 'reviewer', reviewer, reason: '' } as const
  await operations.request(chain, observation, decision, 'test-id')
  expect(resolve).toHaveBeenCalledWith(decision, 'example/repo#7', chain, observation)
})

it('reads the seed issue, comments and publication inspection in one native process', async () => {
  const remediation = { kind: 'empty_integration', verified: true, base: 'b'.repeat(40), duplicate: { number: 21, head: HEAD } }
  mocks.runFile.mockClear()
  mocks.runFile.mockImplementation(async () => ({ stdout: JSON.stringify({ repository: 'example/repo', issue_number: 7,
    actor: 'author', branch: 'poise/issue-7', issue: { title: 'Seed', body: '', state: 'open', labels: [] }, comments: [],
    publication: { existing_pulls: [], pull_number: null, head_sha: null, head_invocation: null, state: null, merged: false, merge_sha: null }, remediation }) }))
  const operations = nativeChainOperations({ login: 'example' } as Organization, {
    roster: async () => ({ issueReviewers: [], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer }),
    resolve: async () => reviewer, prepare: async () => ({}), borrow: () => () => {}, available: () => true,
    capacity: () => 3, permitted: () => true, note: () => '', severity: () => 'p2', received: () => {},
    reviews: async () => 'reviews', existing: async () => new Set(), wake: () => {},
  })
  const observation = await operations.observe(chain)
  expect(observation.issue.commentIds).toEqual([])
  expect(observation.remediation).toEqual(remediation)
  const native = mocks.runFile.mock.calls.filter(([command]) => command === 'github-interface')
  expect(native).toHaveLength(1)
  expect(native[0][1]).toEqual(['--chain-seed', '#7', '--branch', 'poise/issue-7', '--token-user', 'author'])
  const request = await operations.request(chain, { ...observation, pull: { number: 21, head: HEAD, headSince: Date.now(),
    state: 'open', draft: false, merged: false, mergeSha: null, queueEntry: 'queued', queueRemoval: null, changesRequested: false,
    unresolved: 0, approved: true, ready: true, reviewIds: [], reviewRevision: '', reviewReceipts: [], greyRuns: [],
    pending: false, failing: [], conflict: false, behind: false } },
  { kind: 'invoke', behavior: 'retire-pr', basis: chainBasis(['retire', remediation]), actor: 'author', reviewer: null, reason: 'covered' }, 'retirement')
  if (!request) throw new Error('retirement must prepare a native close request')
  expect(request.argv).toEqual(['--issue-work', '7', '--mode', 'retire', '--branch', chain.branch, '--pull-number', '21',
    '--coverage-json', JSON.stringify(remediation), '--expected-head', HEAD, '--token-user', 'author'])
})

it('revalidates the retained original test evidence in the bounded seed observation, independently of reporting', async () => {
  const proof = { verified: true, base: HEAD, run: 1, runAttempt: 1, baselineRun: 2, baselineAttempt: 1,
    remediation: 'https://github.com/example/repo/issues/1530', failures: [{ file: 'tests/test-relay.test.ts', test: 'warning array', cause: 'expected []' }] }
  const held: BehaviorChain = { ...chain, held: 'original test failed', testHold: { invocationId: 'original', callId: 'a'.repeat(32), sequence: 4 },
    invocations: [{ id: 'original', behavior: 'implement-issue', basis: 'seed', actor: chain.author, model: reviewer.model,
      slot: reviewer.slot, admittedAt: Date.now() - 10_000, admissionSequence: 2, state: 'settled', callId: 'a'.repeat(32), outcome: 'preflight_failed',
      request: { command: 'agent-interface', argv: [], cwd: '/fixture' }, evidence: { status: 'failed', action: 'not_started', outcome: 'preflight_failed',
        error_code: 'atomic_work_blocked', artifact: { phase: 'executing', prepared: { checkout_head: HEAD }, test_dependency: proof } } }] }
  const recovery = { merge: 'b'.repeat(40), base: 'c'.repeat(40), run: { id: 3 } }
  let returned = { ...proof, recovered: true, recovery }
  mocks.runFile.mockImplementation(async (command: string, argv: string[]) => {
    if (command === 'github-datastore') return { stdout: JSON.stringify({ repo: chain.repository, number: 7, found: true, complete: true, prerequisites: [] }) }
    expect(argv[0]).toBe('--chain-seed')
    expect(JSON.parse(argv[argv.indexOf('--test-dependency-json') + 1])).toEqual(proof)
    return { stdout: JSON.stringify({ repository: chain.repository, issue_number: 7, actor: chain.author, branch: chain.branch,
      issue: { title: 'Seed', body: '', state: 'open', labels: [] }, comments: [],
      publication: { existing_pulls: [], pull_number: null, head_sha: null, head_invocation: null, state: null,
        merged: false, merge_sha: null, base_sha: recovery.base,
        prerequisites: { repo: chain.repository, number: 7, found: true, complete: true, prerequisites: [] } }, test_dependency: returned }) }
  })
  const native = actionOperations()
  expect(await native.observe(held)).toMatchObject({ testDependency: { invocationId: 'original', verified: true, recovered: true, recovery },
    prerequisites: { wait: null, base: recovery.base } })
  returned = { ...returned, runAttempt: 2 }
  await expect(native.observe(held)).rejects.toThrow('original implementation test evidence changed')
})

it.each([
  { issue_number: 8 },
  { branch: 'poise/issue-8' },
  { actor: 'reviewer' },
])('rejects seed evidence for another chain or actor: %o', async (override) => {
  mocks.runFile.mockImplementation(async () => ({ stdout: JSON.stringify({ repository: 'example/repo', issue_number: 7,
    actor: 'author', branch: 'poise/issue-7', ...override,
    issue: { title: 'Seed', body: '', state: 'open', labels: [] }, comments: [],
    publication: { existing_pulls: [], pull_number: null, head_sha: null, head_invocation: null, state: null, merged: false, merge_sha: null } }) }))
  const operations = nativeChainOperations({ login: 'example' } as Organization, {
    roster: async () => ({ issueReviewers: [], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer }),
    resolve: async () => reviewer, prepare: async () => ({}), borrow: () => () => {}, available: () => true,
    capacity: () => 3, permitted: () => true, note: () => '', severity: () => 'p2', received: () => {},
    reviews: async () => 'reviews', existing: async () => new Set(), wake: () => {},
  })
  await expect(operations.observe(chain)).rejects.toThrow('belongs to another chain or actor')
})

it('rechecks live prerequisites after awaited preparation despite an unchanged issue and empty mirror, then admits each delivered dependent once', async () => {
  directory = mkdtempSync(join(tmpdir(), 'poise-prerequisites-'))
  const db = new Database(':memory:')
  const journal = new BehaviorChainJournal(db)
  const target = 'autonomio/poise'
  const ids = [1104, 1105].map(issue => `${target}#${issue}`)
  const revision = chainBasis(['Seed', ''])
  for (const issue of [1104, 1105]) {
    let current = journal.append(`${target}#${issue}`, `seed-${issue}`, 0, { type: 'chain.admitted', repository: target, issue,
      branch: `poise/issue-${issue}`, author: 'author', reviewer: 'reviewer' })
    current = journal.append(current.id, `review-${issue}`, current.sequence, { type: 'invocation.admitted', invocation: {
      id: `review-${issue}`, behavior: 'review-issue', actor: 'reviewer', model: 'fixture', slot: 'primary', admittedAt: Date.now(),
      basis: chainBasis(['issue', revision]), request: { command: 'agent-interface', cwd: directory, argv: ['--model', 'fixture'] } } })
    journal.append(current.id, `reviewed-${issue}`, current.sequence, { type: 'invocation.settled', invocationId: `review-${issue}`,
      callId: `review-call-${issue}`, outcome: 'commented', evidence: { status: 'completed', action: 'commented', issue_revision: revision,
        receipts: [{ issue: current.id, comment_id: 3, author: 'reviewer' }] } })
  }
  let mode = 'empty'
  const mirror = { repo: target, found: true, complete: true, prerequisites: [] }
  const issue = { title: 'Seed', body: '', state: 'open', labels: [], updated_at: '2026-11-10T00:00:00Z' }
  const running: LogEntry[] = []
  const launch = vi.fn<ChainRuntimeOperations['launch']>(async invocation => {
    running.push({ ...completedReviewCall(target, Number(invocation.request.argv[1].split('#')[1]), HEAD, 'author'),
      id: chainBasis(invocation.id).slice(0, 32), correlation_id: invocation.id, source: 'poise:behavior-chain', behavior: 'implement_issue',
      model: 'fixture', status: 'running', action: null, outcome: null, head_sha: null, expected_head: null,
      artifact: null, resources_settled_at: null, review_id: null })
    return true
  })
  const reportHold = vi.fn(async () => null)
  const prepare = vi.fn(async () => ({}))
  const resolveModel = vi.fn(async () => {
    // Add the edge while native request() is suspended, without a source edit.
    await Promise.resolve()
    if (mode === 'empty') mode = 'open'
    return reviewer
  })
  mocks.runFile.mockClear()
  mocks.runFile.mockImplementation(async (command: string, argv: string[]) => {
    if (command === 'github-interface' && argv[0] === '--chain-seed') {
      const number = Number(argv[1].slice(1))
      const incomplete = ['absent', 'truncated', 'missing-page', 'malformed', 'missing-item'].includes(mode)
      return { stdout: JSON.stringify({ repository: target, issue_number: number, actor: 'author', branch: `poise/issue-${number}`,
        issue, comments: [{ id: 3 }],
        publication: { existing_pulls: [], pull_number: null, head_sha: null, base_sha: HEAD,
          head_invocation: null, state: null, merged: false, merge_sha: null,
          ...(mode === 'absent' ? {} : { prerequisites: { repo: target, number, found: mode !== 'missing-item', complete: !incomplete,
            prerequisites: ['empty', 'cross-repo'].includes(mode) ? [] : [{ repo: target, number: 1100 }] } }) } }) }
    }
    if (command === 'github-datastore') return { stdout: JSON.stringify({ ...mirror, number: Number(argv[argv.indexOf('--number') + 1]) }) }
    if (command === 'github-interface' && argv[0] === '--read-issue') {
      return { stdout: execFileSync('python3', ['tests/fixtures/issue-prerequisites.py'], {
        input: JSON.stringify({ command, argv, mode, db: join(directory, 'capture.sqlite') }), encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, PYTHONPATH: [resolve('caller/github_datastore'), resolve('caller/github_interface'), process.env.PYTHONPATH].filter(Boolean).join(':') },
      }) }
    }
    throw new Error(`Unexpected fixture command ${command} ${argv[0]}`)
  })
  const native = nativeChainOperations({ login: 'autonomio' } as Organization, {
    roster: async () => ({ issueReviewers: [reviewer], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer }),
    resolve: resolveModel, prepare, borrow: () => () => {}, available: () => true,
    capacity: () => 3, permitted: () => true, note: () => '', severity: () => 'p2', received: () => {},
    reviews: async () => 'reviews', existing: async () => new Set(), wake: () => {},
  })
  const operations: ChainRuntimeOperations = { ...native, discover: async () => [],
    readInvocations: async () => ({ entries: running, quarantined: [] }), launch, reportHold }
  const runtime = new BehaviorChainRuntime(journal, operations)
  try {
    await runtime.run()
    await runtime.run()
    for (const id of ids) {
      expect(journal.read(id)).toMatchObject({ held: null, waiting: expect.stringContaining(`${target}#1100: prerequisite is open`) })
      expect(journal.history(id).filter(row => JSON.parse(row.payload).type === 'chain.waiting')).toHaveLength(1)
      expect(journal.read(id)?.invocations).toHaveLength(1)
    }
    expect(launch).not.toHaveBeenCalled()
    expect(reportHold).not.toHaveBeenCalled()
    expect(resolveModel).toHaveBeenCalledTimes(1)
    expect(prepare).not.toHaveBeenCalled()
    expect(journal.read(ids[0])?.observation?.issue).toMatchObject({ revision })
    expect(issue.updated_at).toBe('2026-11-10T00:00:00Z')
    expect(mirror).toEqual({ repo: target, found: true, complete: true, prerequisites: [] })
    expect(mocks.runFile.mock.calls.some(([command]) => command === 'github-datastore')).toBe(false)
    for (const incomplete of ['absent', 'truncated', 'missing-page', 'malformed', 'missing-item']) {
      mode = incomplete
      await expect(runtime.run()).resolves.toBeUndefined()
      for (const id of ids) expect(journal.read(id)?.waiting).toContain('blocked-by evidence is missing or incomplete')
    }
    for (const undelivered of ['closed', 'queued', 'other-branch', 'off-base', 'truncated-delivery', 'missing-prerequisite']) {
      mode = undelivered
      await expect(runtime.run()).resolves.toBeUndefined()
      for (const id of ids) expect(journal.read(id)?.waiting).toContain(`Waiting for prerequisite ${target}#1100`)
    }
    expect(launch).not.toHaveBeenCalled()
    expect(reportHold).not.toHaveBeenCalled()
    expect(ids.every(id => journal.read(id)?.held === null && journal.read(id)?.invocations.length === 1)).toBe(true)
    for (const eligible of ['empty', 'cross-repo', 'integrated-branch']) {
      mode = eligible
      const observation = await native.observe(journal.read(ids[0])!)
      expect(decideBehaviorChain(journal.read(ids[0])!, observation, Date.now())).toMatchObject({ kind: 'invoke', behavior: 'implement-issue' })
      expect(observation.prerequisites).toMatchObject({ wait: null, base: HEAD })
      delete observation.prerequisites
      expect(decideBehaviorChain(journal.read(ids[0])!, observation, Date.now())).toEqual({ kind: 'wait', reason: 'GitHub prerequisite evidence is missing' })
    }
    mode = 'delivered'
    const current = journal.read(ids[0])!
    const observation = await native.observe(current)
    expect(observation.prerequisites).toMatchObject({ wait: null, base: HEAD,
      evidence: [expect.any(Object), { verified: true, state: 'closed', pull_number: 1101, merge_sha: 'b'.repeat(40) }] })
    expect(decideBehaviorChain({ ...current, held: 'atomic implementation hold' }, observation, Date.now()))
      .toEqual({ kind: 'wait', reason: 'atomic implementation hold' })
    mocks.health.mockRejectedValueOnce(new Error('stale mirror'))
    const reads = mocks.runFile.mock.calls.length
    await expect(native.observe(current)).rejects.toThrow('stale mirror')
    expect(mocks.runFile.mock.calls.slice(reads).some(([command]) => command === 'github-datastore')).toBe(false)
    await runtime.run()
    await runtime.run()
    expect(launch).toHaveBeenCalledTimes(2)
    expect(launch.mock.calls.map(([invocation]) => invocation.request.argv[1]).sort()).toEqual(ids)
    expect(ids.every(id => journal.read(id)?.invocations.filter(item => item.behavior === 'implement-issue').length === 1)).toBe(true)
    expect(reportHold).not.toHaveBeenCalled()
    expect(mocks.health).toHaveBeenCalledWith(expect.objectContaining({ login: 'autonomio' }), { timeoutMs: 30_000 }, ['implement-issue'])
  } finally { db.close() }
}, 30_000)
