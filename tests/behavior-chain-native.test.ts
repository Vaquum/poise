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
import { completedReviewCall } from './review-response-fixture'

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

it.each([
  { blockers: [], mergeable: true, expected: 'approve-pr' },
  { blockers: ['merge_state_not_clean'], mergeable: true, expected: 'repair-pr' },
  { blockers: ['not_mergeable'], mergeable: false, expected: 'repair-pr' },
])('uses native readiness policy for behind branches and still repairs actual conflicts: $expected', async ({ blockers, mergeable, expected }) => {
  mocks.runFile.mockImplementation(async (_command: string, argv: string[]) => {
    const evidence: Record<string, unknown> = {
      '--chain-seed': { repository: 'example/repo', issue_number: 7, actor: 'author', branch: 'poise/issue-7',
        issue: { title: 'Seed', body: '', state: 'open', labels: [] }, comments: [],
        publication: { existing_pulls: [], pull_number: 21, head_sha: HEAD, head_invocation: null, state: 'open', merged: false, merge_sha: null } },
      '--pull-action-state': { pull_number: 21, state: 'open', head_sha: HEAD, review_context: 'b'.repeat(64), merged: false, queue_entry_id: null, queue_removals: [], my_reviews: [] },
      '--pr-readiness': { head_sha: HEAD, draft: false, reviewer_approved_current_head: false,
        unresolved_live_conversation_count: 0, unresolved_outdated_conversation_count: 0, green: false, blockers: [...blockers, 'reviewer_not_approved_current_head'] },
      '--list-failing-ci': { head_sha: HEAD, pull_number: 21, failing: [], mergeable, mergeable_state: mergeable ? 'behind' : 'dirty' },
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
  const observation = await operations.observe(chain)
  expect(decideBehaviorChain(chain, observation, Date.now())).toMatchObject({ kind: 'invoke', behavior: expected })
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
  expect(resolve).toHaveBeenCalledWith(decision, 'example/repo#7')
})

it('reads the seed issue, comments and publication inspection in one native process', async () => {
  mocks.runFile.mockClear()
  mocks.runFile.mockImplementation(async () => ({ stdout: JSON.stringify({ repository: 'example/repo', issue_number: 7,
    actor: 'author', branch: 'poise/issue-7', issue: { title: 'Seed', body: '', state: 'open', labels: [] }, comments: [],
    publication: { existing_pulls: [], pull_number: null, head_sha: null, head_invocation: null, state: null, merged: false, merge_sha: null } }) }))
  const operations = nativeChainOperations({ login: 'example' } as Organization, {
    roster: async () => ({ issueReviewers: [], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer }),
    resolve: async () => reviewer, prepare: async () => ({}), borrow: () => () => {}, available: () => true,
    capacity: () => 3, permitted: () => true, note: () => '', severity: () => 'p2', received: () => {},
    reviews: async () => 'reviews', existing: async () => new Set(), wake: () => {},
  })
  const observation = await operations.observe(chain)
  expect(observation.issue.commentIds).toEqual([])
  const native = mocks.runFile.mock.calls.filter(([command]) => command === 'github-interface')
  expect(native).toHaveLength(1)
  expect(native[0][1]).toEqual(['--chain-seed', '#7', '--branch', 'poise/issue-7', '--token-user', 'author'])
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

it('waits for captured #1100 prerequisites through Caller and native runtime, then launches each unheld dependent once', async () => {
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
  let mode = 'open'
  const running: LogEntry[] = []
  const launch = vi.fn<ChainRuntimeOperations['launch']>(async invocation => {
    running.push({ ...completedReviewCall(target, Number(invocation.request.argv[1].split('#')[1]), HEAD, 'author'),
      id: chainBasis(invocation.id).slice(0, 32), correlation_id: invocation.id, source: 'poise:behavior-chain', behavior: 'implement_issue',
      model: 'fixture', status: 'running', action: null, outcome: null, head_sha: null, expected_head: null,
      artifact: null, resources_settled_at: null, review_id: null })
    return true
  })
  const reportHold = vi.fn(async () => null)
  mocks.runFile.mockImplementation(async (command: string, argv: string[]) => {
    if (command === 'github-interface' && argv[0] === '--chain-seed') {
      const issue = Number(argv[1].slice(1))
      return { stdout: JSON.stringify({ repository: target, issue_number: issue, actor: 'author', branch: `poise/issue-${issue}`,
        issue: { title: 'Seed', body: '', state: 'open', labels: [] }, comments: [{ id: 3 }],
        publication: { existing_pulls: [], pull_number: null, head_sha: null, base_sha: HEAD,
          head_invocation: null, state: null, merged: false, merge_sha: null } }) }
    }
    if (command === 'github-datastore' || command === 'github-interface' && argv[0] === '--read-issue') {
      return { stdout: execFileSync('python3', ['tests/fixtures/issue-prerequisites.py'], {
        input: JSON.stringify({ command, argv, mode, db: join(directory, 'capture.sqlite') }), encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, PYTHONPATH: [resolve('caller/github_datastore'), resolve('caller/github_interface'), process.env.PYTHONPATH].filter(Boolean).join(':') },
      }) }
    }
    throw new Error(`Unexpected fixture command ${command} ${argv[0]}`)
  })
  const native = nativeChainOperations({ login: 'autonomio' } as Organization, {
    roster: async () => ({ issueReviewers: [reviewer], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer }),
    resolve: async () => reviewer, prepare: async () => ({}), borrow: () => () => {}, available: () => true,
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
