import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { decideBehaviorChain, type ChainObservation } from '../server/behavior-chain-decision'
import { BehaviorChainRuntime, type ChainRuntimeOperations } from '../server/behavior-chain-runtime'
import { BehaviorChainJournal, chainBasis, type BehaviorChain, type ChainEvent } from '../server/behavior-chain-store'
import { MAX_REPAIR_REPORT_REPOSITORIES_BYTES, REMEDIATION_SCOPE, repairReportRepositories, repairReportRepositoriesHealth, repairReportReviewScope, reportRepairExhaustion, setRepairReportRepositories } from '../server/behavior-chain-report'
import { nativeChainOperations } from '../server/behavior-chain-native'
import { nativeRequestSha } from '../server/behavior-chain-action'
import type { LogEntry } from '../server/agent-log-parse'
import type { Organization } from '../server/organizations'

const mocks = vi.hoisted(() => ({ runFile: vi.fn(), settings: { enabled: true, seedMode: 'label', label: 'poise' },
  accounts: { me: 'author', agentAccount: 'reviewer' } }))
vi.mock('../server/process', () => ({ runFile: mocks.runFile, spawnDetached: vi.fn(), MAX_PROCESS_ARG_BYTES: 64 * 1024 }))
vi.mock('../server/db', () => ({ getMeta: (key: string) => key === 'me' ? mocks.accounts.me : null }))
vi.mock('../server/settings', () => ({ getSettings: () => mocks.accounts, getBehaviorChainSettings: () => mocks.settings }))
vi.mock('../server/models', () => ({ agentInterfaceCwd: () => '/fixture' }))
vi.mock('../server/organizations', () => ({ organizationForRepository: () => ({ login: 'acme' }),
  organizationArgs: (_org: unknown, argv: string[]) => argv, getOrganizations: () => [{ login: 'acme', status: 'ready' }],
  readyOrganizations: () => [{ login: 'acme', status: 'ready' }] }))

const NOW = 1_800_000_000_000
const HEAD = 'a'.repeat(40)
const LEGACY = 'repair did not answer every unresolved review finding'
const BUDGET_CODE = 'atomic_work_execution_budget_exhausted'
const BUDGET_ERRORS = Array<string>(3).fill('Atomic behavior provider exhausted its execution budget; no publication attempted')
const REVIEW_ERRORS = ['Review reached its total time limit; needs attention',
  'Review checkout reached its time limit; needs attention', 'Provider review exhausted its execution budget']
const reviewer = { slot: 'primary', model: 'fixture', recovery: 'fixture' }
const databases: Database.Database[] = []
const roots: string[] = []
interface Issue { number: number, title: string, body: string, state: string, html_url: string,
  user: { login: string }, labels: { name: string }[], created_at: string, updated_at: string }
let remote: Issue[]
let seedBody: string
let dropLabels: boolean
let denyLabels: boolean
let loseCreation: boolean
let searchVisible: boolean
let indexed: boolean
let stale: boolean
let fresh: ChainObservation

function observation(pull = 21): ChainObservation {
  return { checkedAt: Date.now(), issue: { open: true, revision: chainBasis('seed'), eligible: true, commentIds: [] },
    existingPulls: [], issueReviewers: [], prReviewers: [], implementer: reviewer, repairer: reviewer, approver: reviewer,
    publication: { pull_number: pull, head_sha: HEAD, head_invocation: null, state: 'open', merged: false, merge_sha: null },
    pull: { number: pull, head: HEAD, headSince: NOW - 1000, state: 'open', draft: false, merged: false, mergeSha: null,
      queueEntry: null, queueRemoval: null, changesRequested: true, unresolved: 2, approved: false, ready: false,
      reviewIds: [], reviewRevision: chainBasis('findings'), reviewContext: chainBasis('context'), reviewReceipts: [],
      greyRuns: [], pending: false, failing: [], conflict: false, behind: false } }
}
function issue(number: number, body: string): Issue {
  return { number, body, title: 'Fixture issue', state: 'open', html_url: `https://github.com/acme/repo/issues/${number}`,
    user: { login: 'author' }, labels: [], created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString() }
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW)
  vi.stubEnv('POISE_REPAIR_EXHAUSTION_REPOSITORIES', 'acme/repo')
  mocks.settings = { enabled: true, seedMode: 'label', label: 'poise' }
  mocks.accounts = { me: 'author', agentAccount: 'reviewer' }
  remote = []; seedBody = 'Original work'; dropLabels = false; denyLabels = false
  loseCreation = false; searchVisible = true; indexed = false; stale = false; fresh = observation()
  mocks.runFile.mockReset()
  mocks.runFile.mockImplementation(async (command: string, argv: string[]) => {
    const response = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: '' })
    if (command === 'github-datastore') {
      if (argv[0] === 'health') {
        if (stale) throw new Error('github-datastore freshness gate failed: stale review datastore')
        return response({ healthy: true })
      }
      if (argv[0] === 'view') return response(indexed ? remote.filter(row => row.state === 'open'
        && (mocks.settings.seedMode === 'all' || row.labels.some(label => label.name === mocks.settings.label)))
        .map(row => ({ repo: 'acme/repo', number: row.number, status: 'open' })) : [])
    }
    if (command !== 'gh') throw new Error(`Unexpected fixture command ${command}`)
    if (argv[0] === 'auth') return { stdout: 'fixture-token', stderr: '' }
    if (argv[1] === 'search/issues') return response({ incomplete_results: false, total_count: searchVisible ? remote.length : 0, items: searchVisible ? remote : [] })
    if (argv[1] === 'repos/acme/repo/issues' && argv.some(arg => arg.startsWith('title='))) {
      const row = issue(99, argv.find(arg => arg.startsWith('body='))!.slice(5))
      row.title = argv.find(arg => arg.startsWith('title='))!.slice(6)
      if (!dropLabels) row.labels = [{ name: 'poise' }]
      remote.push(row)
      if (loseCreation) throw new Error('Lost creation acknowledgement')
      return response(row)
    }
    if (argv[1] === 'repos/acme/repo/issues/7') return response(issue(7, seedBody))
    const row = remote.find(row => argv[1] === `repos/acme/repo/issues/${row.number}` || argv[1] === `repos/acme/repo/issues/${row.number}/labels`)
    if (row) {
      if (argv.includes('POST')) {
        if (denyLabels) throw new Error('Label permission denied')
        row.labels = [{ name: 'poise' }]
        return response(row.labels)
      }
      return response(row)
    }
    throw new Error(`Unexpected fixture GitHub operation ${argv.join(' ')}`)
  })
})
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.useRealTimers(); vi.unstubAllEnvs()
})

function setup(path = ':memory:') {
  const db = new Database(path); databases.push(db)
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  return { db, journal: new BehaviorChainJournal(db) }
}
function record(journal: BehaviorChainJournal, chain: BehaviorChain, event: ChainEvent) {
  return journal.append(chain.id, `${chain.id}:${chain.sequence}`, chain.sequence, event, NOW - 60_000)
}
function exhausted(journal: BehaviorChainJournal, errors = [LEGACY, LEGACY, LEGACY], seed = 7, pull = 21, errorCode = 'atomic_work_failed') {
  let chain = journal.read(`acme/repo#${seed}`) ?? journal.append(`acme/repo#${seed}`, `seed:${seed}`, 0, { type: 'chain.admitted', repository: 'acme/repo', issue: seed,
    branch: `poise/issue-${seed}`, author: 'author', reviewer: 'reviewer' }, NOW - 600_000)
  chain = record(journal, chain, { type: 'chain.observed', observation: { ...observation(pull), checkedAt: NOW - 600_000 } })
  const decision = decideBehaviorChain(chain, observation(pull), NOW)
  if (decision.kind !== 'invoke' || decision.behavior !== 'repair-pr') throw new Error('Fixture must need repair')
  for (const [index, error] of errors.entries()) {
    const id = `repair-${seed}-${chain.resumedAfterSequence}-${index}`
    chain = record(journal, chain, { type: 'invocation.admitted', invocation: { id, behavior: 'repair-pr', basis: decision.basis,
      actor: 'author', slot: 'primary', model: 'fixture', admittedAt: NOW - 500_000 + index * 100_000,
      request: { command: 'agent-interface', cwd: '/fixture', context: { head: HEAD, reviewRevision: observation().pull!.reviewRevision },
        argv: ['--atomic-work', chain.id, '--expected-issue-revision', observation().issue.revision, '--pull-number', String(pull), '--expected-head', HEAD] } } })
    chain = record(journal, chain, { type: 'invocation.settled', invocationId: id, callId: chainBasis(id).slice(0, 32),
      outcome: errorCode === BUDGET_CODE ? BUDGET_CODE : 'preflight_failed',
      evidence: { status: 'failed', action: 'not_started', outcome: 'preflight_failed', error_code: errorCode, error,
        completedAt: NOW - 400_000 + index * 100_000, head_sha: null,
        artifact: { phase: 'executing', prepared: { checkout_head: HEAD }, resource_root: '/private/work' },
        resources_settled_at: new Date(NOW - 100_000).toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } } })
  }
  return record(journal, chain, { type: 'chain.held', reason: 'repair-pr failed before publication three times: ' + errors.at(-1) })
}
function uncertainMerge(journal: BehaviorChainJournal) {
  let chain = journal.append('acme/repo#7', 'seed:7', 0, { type: 'chain.admitted', repository: 'acme/repo', issue: 7,
    branch: 'poise/issue-7', author: 'author', reviewer: 'reviewer' }, NOW - 600_000)
  chain = record(journal, chain, { type: 'chain.observed', observation: observation() })
  chain = record(journal, chain, { type: 'invocation.admitted', invocation: { id: 'original-merge', behavior: 'merge-pr',
    basis: chainBasis(['merge', HEAD]), actor: 'reviewer', slot: null, model: null, admittedAt: NOW - 120_000,
    request: { command: 'github-interface', nativeResources: 2, cwd: '/fixture',
      argv: ['--merge-if-ready', '21', '--author', 'author', '--expected-head', HEAD, '--token-user', 'reviewer'] } } })
  chain = record(journal, chain, { type: 'invocation.started', invocationId: 'original-merge' })
  const invocation = chain.invocations[0], id = 'c'.repeat(32)
  const call: LogEntry = { id, correlation_id: invocation.id, model: 'native-action', behavior: 'native_action',
    source: 'poise:behavior-chain', actor: invocation.actor, repo: chain.repository, pr_id: '21', session_id: null, prompt: '',
    started_at: new Date(invocation.admittedAt).toISOString(), completed_at: new Date(NOW - 60_000).toISOString(), time_elapsed: '1m',
    status: 'failed', action: null, outcome: null, error: 'native command failed', error_code: 'native_action_failed',
    head_sha: null, expected_head: HEAD, response: null, resources_settled_at: new Date(NOW - 60_000).toISOString(),
    artifact: { phase: 'performing_native_action', request_sha: nativeRequestSha(invocation.request) },
    resource_ownership: { version: 2, roots: [], errors: [], namespace: { state: 'settled', callId: id,
      correlation: invocation.id, settled_at: (NOW - 60_000) / 1000, controller: { version: 1, instance: 'd'.repeat(32) },
      binding: { pid: 104, start: '12', namespace: 'pid:[91]', owner: { pid: 102, start: '10' },
        holder: { pid: 103, start: '11' }, epoch: { boot: 'fixture', init_start: '1', namespace_dev: '2', namespace_ino: '3' } } } } }
  return { chain, call }
}
async function exhaustedReviews(journal: BehaviorChainJournal) {
  fresh = { ...observation(), prReviewers: [reviewer] }
  let chain = journal.append('acme/repo#7', 'seed:7', 0, { type: 'chain.admitted', repository: 'acme/repo', issue: 7,
    branch: 'poise/issue-7', author: 'author', reviewer: 'reviewer' }, NOW - 600_000)
  chain = record(journal, chain, { type: 'chain.observed', observation: { ...fresh, checkedAt: NOW - 600_000 } })
  const native = nativeChainOperations({ login: 'acme' } as Organization, {
    roster: async () => fresh, resolve: async () => reviewer, prepare: async () => ({}), borrow: () => null,
    available: () => true, capacity: () => 3, permitted: () => true, note: () => '', severity: () => 'p2',
    received: () => {}, reviews: async () => '', existing: async () => new Set(), wake: () => {},
  })
  for (const [index, error] of REVIEW_ERRORS.entries()) {
    const decision = decideBehaviorChain(chain, fresh, NOW)
    if (decision.kind !== 'invoke' || decision.behavior !== 'review-pr') throw new Error('Fixture must need PR review')
    const id = `review-7-${index}`
    const request = await native.request(chain, fresh, decision, id)
    if (!request) throw new Error('Fixture must prepare a native PR review')
    chain = record(journal, chain, { type: 'invocation.admitted', invocation: { id, behavior: decision.behavior,
      basis: decision.basis, actor: decision.actor, slot: reviewer.slot, model: reviewer.model,
      admittedAt: NOW - 500_000 + index * 100_000, request } })
    chain = record(journal, chain, { type: 'invocation.settled', invocationId: id, callId: chainBasis(id).slice(0, 32),
      outcome: 'preflight_failed', evidence: { status: 'failed', error_code: 'review_budget_exhausted', error,
        action: 'not_started', outcome: 'preflight_failed', completedAt: NOW - 400_000 + index * 100_000,
        head_sha: null, review_id: null, receipts: null, artifact: { phase: 'reviewing' },
        resources_settled_at: new Date(NOW - 100_000).toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } } })
  }
  const decision = decideBehaviorChain(chain, fresh, NOW)
  if (decision.kind !== 'hold') throw new Error('Fixture must exhaust its PR review attempts')
  return record(journal, chain, { type: 'chain.held', reason: decision.reason })
}
function operations(db: Database.Database, journal: BehaviorChainJournal, overrides: Partial<ChainRuntimeOperations> = {}): ChainRuntimeOperations {
  const forbidden = async () => { throw new Error('Fixture must not start native work') }
  const intake = nativeChainOperations({ login: 'acme' } as Organization, {
    roster: forbidden, resolve: forbidden, prepare: forbidden, borrow: () => null, available: () => false, capacity: () => 3,
    permitted: () => false, note: () => '', severity: () => 'p2', received: () => {}, reviews: forbidden, existing: async () => new Set(), wake: () => {},
  })
  return { enabled: () => true, accounts: () => ({ author: 'author', reviewer: 'reviewer' }), discover: intake.discover,
    ownsRepository: () => true, observe: async chain => chain.issue === 7 ? observation() : { ...observation(),
      pull: null, publication: { pull_number: null, head_sha: null, head_invocation: null, state: null, merged: false, merge_sha: null } },
    reportHold: chain => reportRepairExhaustion(db, journal, chain, async () => {
      await mocks.runFile('github-datastore', ['health', '--max-age-seconds', '120'])
      return { ...fresh, checkedAt: Date.now() }
    }, () => true), readInvocations: async () => ({ entries: [], quarantined: [] }), received: () => {}, available: () => false,
    capacity: () => 3, permitted: () => false, request: forbidden, launch: forbidden, perform: forbidden,
    readActionResult: forbidden, resumePublication: forbidden, fenceClosedTarget: forbidden, wake: () => {}, ...overrides }
}
const posts = () => mocks.runFile.mock.calls.filter(call => call[0] === 'gh' && call[1][1] === 'repos/acme/repo/issues')
const reports = (db: Database.Database) => db.prepare("SELECT value FROM meta WHERE key LIKE 'behavior_chain_repair_report:%'").all() as { value: string }[]

it.each([false, true])('reports an unheld uncertain merge through recovery without another submission (diagnostic=%s)', async diagnostic => {
  const { db, journal } = setup()
  const { chain, call } = uncertainMerge(journal)
  if (diagnostic) call.diagnostic = { version: 1, source: 'caller', severity: 'error', operation: 'github-interface',
    phase: 'native_action', outcome: 'exit', stderr: '/private/work raw output', stderr_truncated: false,
    context: { exit_code: 1, refusal: 'merge request refused' }, filesystem: null }
  // Readiness/conflicts may need repair, but the original uncertain merge blocks it.
  fresh.pull!.conflict = true; fresh.pull!.failing = ['Verify:failure']; fresh.pull!.ready = false
  fresh.pull!.reviewRevision = chainBasis('changed findings on the same head')
  const perform = vi.fn(async () => { throw new Error('must not retry the merge') })
  const runtime = new BehaviorChainRuntime(journal, operations(db, journal, { perform,
    readInvocations: async () => ({ entries: [call], quarantined: [] }) }))
  await runtime.run()
  expect(posts()).toHaveLength(1)
  expect(remote[0]).toMatchObject({ title: 'fix: uncertain merge submission for #21', labels: [{ name: 'poise' }] })
  expect(remote[0].body).toContain(`<!-- poise-repair-exhaustion:${chainBasis(['merge_submission_uncertain', chain.id, 'original-merge'])} -->`)
  for (const fact of ['https://github.com/acme/repo/issues/7', 'https://github.com/acme/repo/pull/21', HEAD,
    'Invocation original-merge', 'Caller ' + call.id, 'native_action_failed', 'Next action:', 'external effect remains unconfirmed']) {
    expect(remote[0].body).toContain(fact)
  }
  expect(remote[0].body).toContain(diagnostic ? 'merge request refused' : 'Process diagnostic: not recorded in this historical Call receipt')
  expect(remote[0].body).not.toContain('/private/work')
  expect(remote[0].body.split(REMEDIATION_SCOPE)).toHaveLength(2)
  const current = journal.read(chain.id)!
  expect(current).toMatchObject({ held: null, author: chain.author, reviewer: chain.reviewer, branch: chain.branch,
    resumedAfterSequence: 0, mergeSha: null, waiting: expect.stringContaining('admission pending normal datastore intake') })
  expect(current.invocations).toMatchObject([{ id: 'original-merge', state: 'uncertain', callId: null,
    evidence: { nativeCallId: call.id, error_code: 'native_action_failed', resource_ownership: call.resource_ownership } }])
  expect(reports(db).map(row => JSON.parse(row.value))).toMatchObject([{ holdSequence: null, heldAt: null,
    attempts: [{ invocation: 'original-merge', call: call.id }], issueNumber: 99 }])
  journal.rebuild()
  await new BehaviorChainRuntime(journal, operations(db, journal, { perform,
    readInvocations: async () => ({ entries: [call], quarantined: [] }) })).run()
  expect(posts()).toHaveLength(1)
  expect(journal.read(chain.id)!.invocations).toEqual(current.invocations)
  expect(perform).not.toHaveBeenCalled()
})

it.each(['queued', 'merged', 'closed PR', 'closed seed', 'changed head', 'different PR', 'unknown queue', 'unavailable',
  'running Call', 'pending resources', 'missing Call', 'missing terminal time', 'disabled', 'changed account',
  'generated marker', 'generated issue link'])('defers uncertain merge reporting for %s', async change => {
  const { db, journal } = setup()
  const { chain, call } = uncertainMerge(journal)
  if (change === 'queued') fresh.pull!.queueEntry = 'queue-entry'
  if (change === 'merged') Object.assign(fresh.pull!, { state: 'closed', merged: true, mergeSha: 'b'.repeat(40) })
  if (change === 'closed PR') fresh.pull!.state = 'closed'
  if (change === 'closed seed') fresh.issue.open = false
  if (change === 'changed head') fresh.pull!.head = 'b'.repeat(40)
  if (change === 'different PR') fresh.pull!.number++
  if (change === 'unknown queue') Reflect.deleteProperty(fresh.pull!, 'queueEntry')
  if (change === 'unavailable') stale = true
  if (change === 'running Call') { call.status = 'running'; call.completed_at = null; call.resources_settled_at = null }
  if (change === 'pending resources') call.resources_settled_at = null
  if (change === 'missing terminal time') call.completed_at = null
  if (change === 'disabled') vi.stubEnv('POISE_REPAIR_EXHAUSTION_REPOSITORIES', '')
  if (change === 'changed account') mocks.accounts.me = 'other'
  if (change === 'generated marker') seedBody = `<!-- poise-repair-exhaustion:${chainBasis('another report')} -->`
  if (change === 'generated issue link') db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)')
    .run('behavior_chain_repair_report:original', JSON.stringify({ source: 'acme/repo#6', issueNumber: 7 }))
  const priorReports = reports(db)
  const runtime = new BehaviorChainRuntime(journal, operations(db, journal, { discover: async () => [],
    readInvocations: async () => ({ entries: change === 'missing Call' ? [] : [call], quarantined: [] }) }))
  await runtime.run()
  expect(posts()).toHaveLength(0)
  expect(reports(db)).toEqual(priorReports)
  expect(journal.read(chain.id)!.invocations).toHaveLength(1)
  expect(journal.read(chain.id)!.invocations[0].state).not.toBe('settled')
})

it('never repeats an uncertain merge report POST after a lost acknowledgement, restart, empty searches or closure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'merge-report-')); roots.push(root)
  const path = join(root, 'journal.sqlite')
  const initial = setup(path)
  const { chain, call } = uncertainMerge(initial.journal)
  const overrides = { readInvocations: async () => ({ entries: [call], quarantined: [] }) }
  loseCreation = true
  await new BehaviorChainRuntime(initial.journal, operations(initial.db, initial.journal, overrides)).run()
  expect(posts()).toHaveLength(1)
  expect(JSON.parse(reports(initial.db)[0].value).issueNumber).toBeNull()
  initial.db.close(); databases.splice(databases.indexOf(initial.db), 1)
  const { db, journal } = setup(path)
  journal.rebuild()
  searchVisible = false
  for (let pass = 0; pass < 3; pass++) {
    await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
    expect(journal.read(chain.id)?.waiting).toContain('creation is unconfirmed')
  }
  searchVisible = true; remote[0].state = 'closed'
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  expect(journal.read(chain.id)?.waiting).toContain('is closed; no replacement')
  expect(JSON.parse(reports(db)[0].value).issueNumber).toBe(99)
  expect(posts()).toHaveLength(1)
  expect(journal.read(chain.id)).toMatchObject({ held: null, invocations: [{ state: 'uncertain', callId: null }] })
})

it.each(['legacy', 'diagnostic omissions', 'execution budget'])('reports a pre-existing %s hold and verifies ordinary admission', async mode => {
  const { db, journal } = setup()
  const budget = mode === 'execution budget'
  const errors = budget ? BUDGET_ERRORS : mode === 'diagnostic omissions' ? [1, 2, 3].map(n => `${LEGACY}: missing_root_comment_ids=[${Array.from({ length: n }, (_, i) => n * 10 + i).join(', ')}]; missing_count=${n}; required_count=6`) : undefined
  const source = exhausted(journal, errors, 7, 21, budget ? BUDGET_CODE : 'atomic_work_failed')
  const runtime = new BehaviorChainRuntime(journal, operations(db, journal))
  await runtime.run()
  expect(posts()).toHaveLength(1)
  expect(remote[0].labels).toEqual([{ name: 'poise' }])
  const cause = budget ? 'repair_execution_budget_exhausted' : 'repair_incomplete_replies'
  // The issue requires these exact bytes, with one canonical copy of the text.
  expect(createHash('sha256').update(REMEDIATION_SCOPE).digest('hex')).toBe('4bf653b9c2d031998ceba8f9376bd0f06b24b2ceab4d3adcd8ef96bdb73375ad')
  expect(remote[0].body).toContain(`Stage: repair-pr. Cause: ${cause}.`)
  expect(remote[0].body.split(REMEDIATION_SCOPE)).toHaveLength(2)
  expect(remote[0].body.split('Include this exact paragraph in the linked PR review.')).toHaveLength(2)
  expect(remote[0].body.endsWith('Include this exact paragraph in the linked PR review.')).toBe(true)
  expect(remote[0].body).toContain(`<!-- poise-repair-exhaustion:${chainBasis([cause, source.id, 21])} -->`)
  if (budget) {
    expect(remote[0].title).toContain('execution budget')
    expect(remote[0].body).toContain(BUDGET_CODE)
    expect(remote[0].body).toContain('Next action: inspect the repair execution budget and source receipts')
  }
  expect(remote[0].body).toContain(`hold event ${source.sequence}`)
  expect(remote[0].body).toContain('Caller ' + source.invocations[1].callId)
  expect(remote[0].body).not.toMatch(/missing_root_comment_ids|\/private\/work/)
  expect(journal.read(source.id)).toMatchObject({ held: source.held, resumedAfterSequence: 0,
    waiting: expect.stringContaining('admission pending normal datastore intake') })
  expect(reports(db).map(row => JSON.parse(row.value))).toMatchObject([{ source: source.id, holdSequence: source.sequence, issueNumber: 99 }])
  indexed = true
  vi.setSystemTime(Date.now() + 86_400_000)
  await runtime.run()
  expect(journal.read('acme/repo#99')).not.toBeNull()
  expect(journal.read(source.id)?.waiting).toContain('admitted as acme/repo#99')
  const remediation = record(journal, journal.read('acme/repo#99')!, { type: 'chain.held', reason: 'remediation needs an operator' })
  vi.setSystemTime(Date.now() + 86_400_000)
  await runtime.run()
  await runtime.run()
  expect(journal.read(source.id)?.waiting).toContain(`remediation is held: ${remediation.held}`)
  expect(posts()).toHaveLength(1)
  expect(remote[0].body.split(REMEDIATION_SCOPE)).toHaveLength(2)
  expect(remote[0].body.split('Include this exact paragraph in the linked PR review.')).toHaveLength(2)
  expect(mocks.runFile.mock.calls.filter(call => call[0] === 'gh' && call[1][0] === 'auth')
    .every(call => call[1].includes('author'))).toBe(true)
})

it('reports three native PR review budget failures once and preserves the source hold', async () => {
  const { db, journal } = setup()
  const source = await exhaustedReviews(journal)
  for (const invocation of source.invocations) {
    expect(invocation.actor).toBe('reviewer')
    expect(invocation.request.context).toBeUndefined()
    expect(invocation.request.argv).not.toContain('--expected-issue-revision')
    expect(invocation.request.argv[invocation.request.argv.indexOf('--expected-head') + 1]).toBe(HEAD)
  }
  const runtime = new BehaviorChainRuntime(journal, operations(db, journal, {
    observe: async () => ({ ...fresh, checkedAt: Date.now() }),
  }))
  await runtime.run()
  expect(posts()).toHaveLength(1)
  expect(remote[0].labels).toEqual([{ name: 'poise' }])
  expect(remote[0].title).toContain('review')
  expect(remote[0].body).toContain('Stage: review-pr. Cause: review_budget_exhausted.')
  expect(remote[0].body).toContain('review_budget_exhausted, action=not_started, outcome=preflight_failed')
  expect(remote[0].body).toContain('Next action: inspect the PR review budget and source receipts')
  expect(remote[0].body).toContain(`hold event ${source.sequence}; head ${HEAD}; basis ${source.invocations[0].basis}; slot primary`)
  expect(remote[0].body).toContain('(1 minutes at reporting)')
  for (const invocation of source.invocations) expect(remote[0].body).toContain(`Invocation ${invocation.id}; Caller ${invocation.callId}; completed`)
  for (const error of REVIEW_ERRORS) expect(remote[0].body).not.toContain(error)
  expect(remote[0].body.split(REMEDIATION_SCOPE)).toHaveLength(2)
  expect(remote[0].body.endsWith('Include this exact paragraph in the linked PR review.')).toBe(true)
  expect(remote[0].body).toContain(`<!-- poise-repair-exhaustion:${chainBasis(['review_budget_exhausted', source.id, 21])} -->`)
  expect(reports(db).map(row => JSON.parse(row.value))).toMatchObject([{ source: source.id, holdSequence: source.sequence, issueNumber: 99 }])
  fresh.pull!.head = 'b'.repeat(40)
  fresh.pull!.reviewContext = chainBasis('later review context')
  vi.setSystemTime(Date.now() + 86_400_000)
  await runtime.run()
  journal.rebuild()
  await runtime.run()
  expect(posts()).toHaveLength(1)
  expect(journal.read(source.id)).toMatchObject({ held: source.held, resumedAfterSequence: 0, invocations: source.invocations })
})

it.each(['incomplete replies', 'execution budget', 'review budget'])('carries the recorded %s report policy only to its closing remediation PR', async mode => {
  const { db, journal } = setup()
  if (mode === 'review budget') await exhaustedReviews(journal)
  else exhausted(journal, mode === 'execution budget' ? BUDGET_ERRORS : undefined, 7, 21, mode === 'execution budget' ? BUDGET_CODE : 'atomic_work_failed')
  const runtime = new BehaviorChainRuntime(journal, operations(db, journal, mode === 'review budget'
    ? { observe: async () => ({ ...fresh, checkedAt: Date.now() }) } : {}))
  await runtime.run()
  indexed = true
  await runtime.run()
  const chain = journal.read('acme/repo#99')!
  expect(chain).not.toBeNull()
  const report = remote[0]
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('behavior_chain_repair_report:other',
    JSON.stringify({ source: 'acme/repo#8', issueNumber: 100 }))
  const prs = [
    { number: 21, body: 'The stalled source PR', closing: [{ repo: 'acme/repo', number: 7 }] },
    { number: 22, body: `Repair the generated report\n\nCloses #${report.number}`, closing: [{ repo: 'acme/repo', number: report.number }] },
    { number: 23, body: report.body, closing: [{ repo: 'acme/repo', number: 100 }] },
  ]
  const existingRun = mocks.runFile.getMockImplementation()!
  let closesVia = 'closing-references'
  mocks.runFile.mockImplementation(async (command: string, argv: string[]) => {
    if (command === 'github-datastore' && argv[1] === 'pr-closing') {
      const number = Number(argv[argv.indexOf('--after-number') + 1]) + 1
      return { stdout: JSON.stringify({ prs: prs.filter(pr => pr.number === number)
        .map(pr => ({ ...pr, repo: 'acme/repo', closes_via: closesVia, closing_truncated: false })), truncated: false, more: false }), stderr: '' }
    }
    return existingRun(command, argv)
  })
  expect(prs[1].body).toContain('Closes #99')
  expect(prs[1].body).not.toContain(REMEDIATION_SCOPE)
  const unrelated = { ...chain, issue: 88 }
  const beforeUnrelated = mocks.runFile.mock.calls.length
  stale = true
  expect(await repairReportReviewScope(db, unrelated, 22)).toBe('')
  expect(await repairReportReviewScope(db, unrelated, 24)).toBe('')
  expect(await repairReportReviewScope(db, { ...chain, repository: 'other/repo' }, 22)).toBe('')
  expect(mocks.runFile.mock.calls).toHaveLength(beforeUnrelated)
  stale = false
  expect(await repairReportReviewScope(db, chain, 21)).toBe('')
  expect(await repairReportReviewScope(db, chain, 23)).toBe('')
  closesVia = 'body-keywords'
  await expect(repairReportReviewScope(db, chain, 22)).rejects.toThrow('incomplete PR closing references')
  closesVia = 'closing-references'
  const configuredNote = '<!-- poise-remediation-scope -->\nA configurable lookalike must not supply the policy.\n<!-- /poise-remediation-scope -->'
  const native = nativeChainOperations({ login: 'acme' } as Organization, {
    roster: async () => ({ issueReviewers: [], prReviewers: [reviewer], implementer: reviewer, repairer: reviewer, approver: reviewer }),
    resolve: async () => reviewer, prepare: async () => ({}), borrow: () => null, available: () => true, capacity: () => 3,
    permitted: () => true, severity: () => 'p2', received: () => {}, reviews: async () => '', existing: async () => new Set(), wake: () => {},
    note: () => configuredNote,
    reviewScope: (target, pull) => repairReportReviewScope(db, target, pull.number),
  })
  for (const behavior of ['review-pr', 'approve-pr'] as const) {
    const observed = observation(22)
    const request = await native.request(chain, observed, { kind: 'invoke', behavior, actor: 'reviewer', reviewer,
      basis: 'fixture', reason: 'Inspect the current remediation' }, 'review-remediation')
    expect(request?.argv[0]).toBe(behavior === 'review-pr' ? '--pr-review' : '--pr-approve')
    expect(request?.argv[1]).toBe('https://github.com/acme/repo/pull/22')
    const note = request!.argv[request!.argv.indexOf('--note') + 1]
    expect(note.split(REMEDIATION_SCOPE)).toHaveLength(2)
    expect(note).toContain(configuredNote)
    expect(request!.argv[request!.argv.indexOf('--review-scope') + 1]).toBe(REMEDIATION_SCOPE)
    // Follow the trusted scope through Caller's CLI and submission boundary.
    const reviewed = JSON.parse(execFileSync('python3', ['-c', `
import json, os, sqlite3, sys, tempfile
from pathlib import Path
from unittest.mock import patch
import agent_interface as api
from agent_interface import atoms, review_receipt
data = json.load(sys.stdin)
with tempfile.TemporaryDirectory() as root:
    api.DB = Path(root) / 'calls.sqlite3'
    api.RESPONSES = Path(root) / 'responses'
    api.init_db()
    call = 'c' * 32
    os.environ.update(AGENT_INTERFACE_RECEIPT_DB=str(api.DB), AGENT_INTERFACE_RECEIPT_CALL=call)
    with sqlite3.connect(api.DB) as conn:
        conn.execute("insert into calls(id,started_at,status,actor,behavior,artifact) values (?,0,'running','reviewer','pr_review',?)", (call, json.dumps({'phase':'reviewing'})))
    review_receipt.bind(api.DB, call)
    packet = json.dumps({'repository':'acme/repo','pull_number':22,'head_sha':data['head'],
        'pull':{'base':{'sha':'b'*40},'title':'Repair report','body':'Closes #99'}})
    with patch.object(api, 'run_governed_behavior') as run:
        sys.argv = ['agent-interface', *data['argv']]
        api._main()
    review_receipt.prepare_response(packet, 'fixture', run.call_args.kwargs['review_scope'])
    assessment = {'verdict':'The repair was inspected against its affected callers.',
        'reviewed_context':'Inspected the immutable diff and affected callers.','limitations':'Isolated fixture only.'}
    review_receipt.complete_response(assessment, data['head'])
    print(json.dumps({'input':atoms.prompt('Review the repair.', (), (), packet, [], data['note']),
        'body':review_receipt.begin_submission(assessment['verdict'], data['head'])}))
`], { input: JSON.stringify({ note, head: HEAD, argv: request!.argv }), encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PYTHONPATH: resolve('caller/agent_interface') } })) as { input: string, body: string }
    expect(reviewed.input).toContain(REMEDIATION_SCOPE)
    expect(reviewed.body.split(REMEDIATION_SCOPE)).toHaveLength(2)
    expect(reviewed.body).not.toContain('A configurable lookalike must not supply the policy.')
    stale = true
    const beforeUnrelatedRequest = mocks.runFile.mock.calls.length
    const unrelatedRequest = await native.request(unrelated, observed, { kind: 'invoke', behavior, actor: 'reviewer', reviewer,
      basis: 'fixture', reason: 'Inspect unrelated work' }, 'review-unrelated')
    expect(unrelatedRequest!.argv).not.toContain('--review-scope')
    expect(unrelatedRequest!.argv[unrelatedRequest!.argv.indexOf('--note') + 1]).toContain(configuredNote)
    expect(mocks.runFile.mock.calls).toHaveLength(beforeUnrelatedRequest)
    stale = false
  }
  stale = true
  await expect(repairReportReviewScope(db, chain, 22)).rejects.toThrow('stale review datastore')
  stale = false
  await expect(repairReportReviewScope(db, chain, 24)).rejects.toThrow('awaits indexed PR closing references')
  await runtime.run()
  expect(posts()).toHaveLength(1)
})

it.each(['mixed causes', 'generic failure', 'uncertain receipt', 'pending resources', 'publication', 'only two'])('does not report unverified execution exhaustion: %s', async change => {
  const { db, journal } = setup()
  const chain = structuredClone(exhausted(journal, BUDGET_ERRORS, 7, 21, BUDGET_CODE))
  chain.observation = observation()
  const attempt = chain.invocations[1]
  if (change === 'mixed causes') Object.assign(attempt.evidence!, { error_code: 'atomic_work_failed', error: LEGACY })
  if (change === 'generic failure') attempt.evidence!.error_code = 'atomic_work_failed'
  if (change === 'uncertain receipt') attempt.state = 'uncertain'
  if (change === 'pending resources') attempt.evidence!.resource_ownership = { version: 1, roots: [], errors: [], process_pending: true }
  if (change === 'publication') attempt.evidence!.action = 'completed'
  if (change === 'only two') chain.invocations.pop()
  await operations(db, journal).reportHold!(chain)
  expect(posts()).toHaveLength(0)
  expect(reports(db)).toHaveLength(0)
})

it.each(['provider failure', 'missing receipt', 'missing evidence', 'missing artifact', 'only two', 'resumed',
  'other slot', 'author actor', 'wrong expected head', 'pending resources', 'missing release', 'review receipt',
  'submitting_review without review_id', 'changed head', 'changed context on the same head'])('does not report unverified PR review exhaustion: %s', async change => {
  const { db, journal } = setup()
  const chain = structuredClone(await exhaustedReviews(journal))
  chain.observation = structuredClone(fresh)
  const attempt = chain.invocations[1]
  if (change === 'provider failure') attempt.evidence!.error_code = 'review_provider_blocked'
  if (change === 'missing receipt') attempt.callId = null
  if (change === 'missing evidence') attempt.evidence = null
  if (change === 'missing artifact') attempt.evidence!.artifact = null
  if (change === 'only two') chain.invocations.pop()
  if (change === 'resumed') chain.resumedAfterSequence = attempt.admissionSequence
  if (change === 'other slot') attempt.slot = 'secondary'
  if (change === 'author actor') attempt.actor = 'author'
  if (change === 'wrong expected head') attempt.request.argv[attempt.request.argv.indexOf('--expected-head') + 1] = 'b'.repeat(40)
  if (change === 'pending resources') attempt.evidence!.resource_ownership = { version: 1, roots: [], errors: [], process_pending: true }
  if (change === 'missing release') attempt.evidence!.resources_settled_at = null
  if (change === 'review receipt') attempt.evidence!.review_id = 123
  if (change === 'submitting_review without review_id') attempt.evidence!.artifact = { phase: 'submitting_review', expected_head: HEAD }
  if (change === 'changed head') fresh.pull!.head = 'b'.repeat(40)
  if (change === 'changed context on the same head') fresh.pull!.reviewContext = chainBasis('edited title, body or base')
  await operations(db, journal).reportHold!(chain)
  expect(posts()).toHaveLength(0)
  expect(reports(db)).toHaveLength(0)
  expect(journal.read(chain.id)?.held).toBe(chain.held)
})

it.each(['different cause', 'missing receipt', 'unreleased resources', 'possible publication', 'unsettled', 'other basis', 'other slot', 'resumed', 'changed head', 'changed finding', 'closed', 'no hold', 'unknown basis'])('does not report unverified exhaustion: %s', async change => {
  const { db, journal } = setup()
  let chain = exhausted(journal)
  // Each mutation models evidence that cannot prove the supported condition.
  chain = structuredClone(chain)
  chain.observation = observation()
  const attempt = chain.invocations[1]
  if (change === 'different cause') attempt.evidence!.error = 'provider exited before publication'
  if (change === 'missing receipt') attempt.callId = null
  if (change === 'unreleased resources') attempt.evidence!.resources_settled_at = null
  if (change === 'possible publication') attempt.evidence!.artifact = { phase: 'publishing', plan_sha: 'a'.repeat(64) }
  if (change === 'unsettled') attempt.state = 'uncertain'
  if (change === 'other basis') attempt.basis = 'different'
  if (change === 'other slot') attempt.slot = 'secondary'
  if (change === 'resumed') chain.resumedAfterSequence = attempt.admissionSequence
  if (change === 'changed head') (chain.observation as ChainObservation).pull!.head = 'b'.repeat(40)
  if (change === 'changed finding') (chain.observation as ChainObservation).pull!.reviewRevision = chainBasis('edited')
  if (change === 'closed') (chain.observation as ChainObservation).pull!.state = 'closed'
  if (change === 'no hold') chain.held = null
  if (change === 'unknown basis') (chain.observation as ChainObservation).pull!.reviewRevision = chainBasis(['datastore-not-yet-indexed', chain.repository, 21])
  await operations(db, journal).reportHold!(chain)
  expect(posts()).toHaveLength(0)
  expect(reports(db)).toHaveLength(0)
})

it.each(['disabled', 'other repository', 'paused'])('keeps reporting opt-in: %s', async mode => {
  const { db, journal } = setup()
  const chain = exhausted(journal)
  vi.stubEnv('POISE_REPAIR_EXHAUSTION_REPOSITORIES', mode === 'disabled' ? '' : mode === 'other repository' ? 'acme/other' : 'acme/repo')
  await reportRepairExhaustion(db, journal, chain, async () => fresh, () => mode !== 'paused')
  expect(mocks.runFile).not.toHaveBeenCalled()
})

it('keeps an applied empty service allowlist disabled over the legacy environment after restart', async () => {
  vi.stubEnv('POISE_MODE', 'service')
  const root = mkdtempSync(join(tmpdir(), 'report-scope-')); roots.push(root)
  const path = join(root, 'cache.db')
  const initial = setup(path)
  const chain = record(initial.journal, exhausted(initial.journal), { type: 'chain.observed', observation: observation() })
  setRepairReportRepositories(initial.db, 'acme/other')
  await operations(initial.db, initial.journal).reportHold!(chain)
  expect(mocks.runFile).not.toHaveBeenCalled()
  setRepairReportRepositories(initial.db, '')
  initial.db.close(); databases.splice(databases.indexOf(initial.db), 1)

  const { db, journal } = setup(path)
  expect(repairReportRepositories(db)).toBe('')
  await operations(db, journal).reportHold!(journal.read(chain.id)!)
  expect(mocks.runFile).not.toHaveBeenCalled()
  expect(reports(db)).toHaveLength(0)
  setRepairReportRepositories(db, 'Acme/repo, acme/second')
  await operations(db, journal).reportHold!(journal.read(chain.id)!)
  expect(posts()).toHaveLength(1)
  expect(journal.read(chain.id)).toEqual(chain)
})

it('rejects a reporting allowlist beyond the health echo budget', () => {
  const { db } = setup()
  const oversized = `${'a/b,'.repeat(2100)}a/b`
  expect(Buffer.byteLength(oversized)).toBeGreaterThan(MAX_REPAIR_REPORT_REPOSITORIES_BYTES)
  expect(() => setRepairReportRepositories(db, oversized)).toThrow('exceeds 8192 bytes')
})

it('truncates a legacy over-cap allowlist in the health echo while matching on the full value', () => {
  vi.stubEnv('POISE_MODE', 'service')
  const { db } = setup()
  const oversized = `${'a/b,'.repeat(20000)}a/b`
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('service_repair_exhaustion_repositories', oversized)
  expect(Buffer.byteLength(repairReportRepositoriesHealth(db))).toBeLessThanOrEqual(MAX_REPAIR_REPORT_REPOSITORIES_BYTES)
  expect(repairReportRepositories(db)).toBe(oversized)
})

it('preserves local environment reporting independently of applied service configuration', async () => {
  vi.stubEnv('POISE_MODE', undefined)
  const { db, journal } = setup()
  const chain = record(journal, exhausted(journal), { type: 'chain.observed', observation: observation() })
  setRepairReportRepositories(db, '')
  await operations(db, journal).reportHold!(chain)
  expect(posts()).toHaveLength(1)
})

it.each(['verification', 'source issue', 'marker search'])('revokes reporting during %s without consuming creation intent', async boundary => {
  vi.stubEnv('POISE_MODE', 'service')
  const { db, journal } = setup()
  const chain = record(journal, exhausted(journal), { type: 'chain.observed', observation: observation() })
  setRepairReportRepositories(db, 'acme/repo')
  const run = mocks.runFile.getMockImplementation()!
  mocks.runFile.mockImplementation(async (command: string, argv: string[]) => {
    const result = await run(command, argv)
    if (command === 'gh' && (boundary === 'source issue' && argv[1] === 'repos/acme/repo/issues/7'
      || boundary === 'marker search' && argv[1] === 'search/issues')) setRepairReportRepositories(db, '')
    return result
  })
  await reportRepairExhaustion(db, journal, chain, async () => {
    if (boundary === 'verification') setRepairReportRepositories(db, '')
    return observation()
  }, () => true)
  expect(posts()).toHaveLength(0)
  expect(reports(db)).toHaveLength(0)
  expect(journal.read(chain.id)).toEqual(chain)

  mocks.runFile.mockImplementation(run)
  setRepairReportRepositories(db, 'acme/repo')
  await operations(db, journal).reportHold!(chain)
  await operations(db, journal).reportHold!(chain)
  expect(posts()).toHaveLength(1)
  expect(reports(db)).toHaveLength(1)
})

it('requires datastore freshness even on the same head and leaves an edited finding pending', async () => {
  const { db, journal } = setup()
  const chain = exhausted(journal)
  stale = true
  fresh.pull!.reviewRevision = chainBasis('edited finding on the same head')
  await new BehaviorChainRuntime(journal, operations(db, journal, { discover: async () => [] })).run()
  expect(journal.read(chain.id)?.waiting).toContain('stale review datastore')
  expect(posts()).toHaveLength(0)
  expect(reports(db)).toHaveLength(0)
  stale = false
  vi.setSystemTime(Date.now() + 86_400_000)
  await new BehaviorChainRuntime(journal, operations(db, journal)).run()
  expect(journal.read(chain.id)?.waiting).toContain('review basis no longer verifies')
  expect(posts()).toHaveLength(0)
})

it('retains a partially labeled issue and exposes incompatible intake without assigning another label', async () => {
  const { db, journal } = setup()
  const chain = exhausted(journal)
  dropLabels = true; denyLabels = true
  const runtime = new BehaviorChainRuntime(journal, operations(db, journal))
  await runtime.run()
  expect(posts()).toHaveLength(1)
  expect(JSON.parse(reports(db)[0].value).issueNumber).toBe(99)
  expect(journal.read(chain.id)?.waiting).toContain('Label permission denied')
  expect(journal.read(chain.id)?.waiting).toContain('https://github.com/acme/repo/issues/99')
  denyLabels = false
  mocks.settings.label = 'ready-for-work'
  vi.setSystemTime(Date.now() + 86_400_000)
  await runtime.run()
  expect(remote[0].labels).toEqual([{ name: 'poise' }])
  expect(journal.read(chain.id)?.waiting).toContain('blocked by saved intake label ready-for-work')
  indexed = true
  vi.setSystemTime(Date.now() + 86_400_000)
  await runtime.run()
  expect(journal.read('acme/repo#99')).toBeNull()
  expect(posts()).toHaveLength(1)
})

it('never repeats an ambiguous POST across empty searches, restart or a closed matching issue', async () => {
  const root = mkdtempSync(join(tmpdir(), 'repair-report-')); roots.push(root)
  const path = join(root, 'journal.sqlite')
  const initial = setup(path)
  const chain = exhausted(initial.journal)
  loseCreation = true
  await new BehaviorChainRuntime(initial.journal, operations(initial.db, initial.journal)).run()
  expect(posts()).toHaveLength(1)
  expect(JSON.parse(reports(initial.db)[0].value).issueNumber).toBeNull()
  initial.db.close(); databases.splice(databases.indexOf(initial.db), 1)
  const { db, journal } = setup(path)
  journal.rebuild()
  searchVisible = false
  for (let pass = 1; pass <= 3; pass++) {
    vi.setSystemTime(Date.now() + 86_400_000)
    await new BehaviorChainRuntime(journal, operations(db, journal)).run()
    expect(journal.read(chain.id)?.waiting).toContain('creation is unconfirmed')
  }
  searchVisible = true; remote[0].state = 'closed'
  vi.setSystemTime(Date.now() + 86_400_000)
  await new BehaviorChainRuntime(journal, operations(db, journal)).run()
  expect(journal.read(chain.id)?.waiting).toContain('is closed; no replacement')
  expect(JSON.parse(reports(db)[0].value).issueNumber).toBe(99)
  expect(posts()).toHaveLength(1)
  expect(mocks.runFile.mock.calls.filter(call => call[1][1] === 'search/issues')
    .every(call => call[1].some((arg: string) => arg.includes('is:issue')) && !call[1].join(' ').includes('is:open'))).toBe(true)
})

it.each([false, true])('suppresses a generated remediation marker with the opposite repair cause (budget=%s)', async budget => {
  const { db, journal } = setup()
  const chain = exhausted(journal, budget ? BUDGET_ERRORS : undefined, 7, 21, budget ? BUDGET_CODE : 'atomic_work_failed')
  const sourceCause = budget ? 'repair_incomplete_replies' : 'repair_execution_budget_exhausted'
  seedBody = `Remediation\n<!-- poise-repair-exhaustion:${chainBasis([sourceCause, 'acme/repo#6', 20])} -->`
  await new BehaviorChainRuntime(journal, operations(db, journal)).run()
  expect(journal.read(chain.id)).toMatchObject({ held: chain.held, waiting: expect.stringContaining('suppressed for a generated remediation issue') })
  expect(posts()).toHaveLength(0)
  expect(reports(db)).toHaveLength(0)
})

it.each([false, true])('retains cross-cause recursion suppression when a generated issue body is edited (budget=%s)', async budget => {
  const { db, journal } = setup()
  exhausted(journal, budget ? undefined : BUDGET_ERRORS, 7, 21, budget ? 'atomic_work_failed' : BUDGET_CODE)
  await new BehaviorChainRuntime(journal, operations(db, journal)).run()
  expect(posts()).toHaveLength(1)
  const remediation = exhausted(journal, budget ? BUDGET_ERRORS : undefined, 99, 22, budget ? BUDGET_CODE : 'atomic_work_failed')
  remote[0].body = 'An edited remediation description without the original marker'
  await new BehaviorChainRuntime(journal, operations(db, journal, { observe: async chain => observation(chain.issue === 99 ? 22 : 21) })).run()
  expect(journal.read(remediation.id)).toMatchObject({ held: remediation.held,
    waiting: expect.stringContaining('suppressed for a generated remediation issue') })
  expect(posts()).toHaveLength(1)
})

it('retains an old incomplete-reply intent and uses a distinct budget intent for the same target after Resume', async () => {
  const { db, journal } = setup()
  const chain = exhausted(journal)
  const key = chainBasis(['repair_incomplete_replies', chain.id, 21])
  const storageKey = 'behavior_chain_repair_report:' + key
  const legacyIntent = JSON.stringify({ key, source: chain.id, pull: 21, holdSequence: chain.sequence, heldAt: NOW - 60_000,
    head: HEAD, basis: chain.invocations[0].basis, slot: 'primary',
    attempts: chain.invocations.map(invocation => ({ invocation: invocation.id, call: invocation.callId, completedAt: invocation.evidence!.completedAt })),
    issueNumber: 44 })
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run(storageKey, legacyIntent)
  remote = [issue(44, `<!-- poise-repair-exhaustion:${key} -->`)]
  remote[0].labels = [{ name: 'poise' }]
  journal.rebuild()
  const runtime = new BehaviorChainRuntime(journal, operations(db, journal))
  await runtime.run()
  expect(posts()).toHaveLength(0)
  expect(journal.read(chain.id)?.waiting).toContain('/issues/44')
  record(journal, journal.read(chain.id)!, { type: 'chain.resumed' })
  const budget = exhausted(journal, BUDGET_ERRORS, 7, 21, BUDGET_CODE)
  await runtime.run()
  expect(posts()).toHaveLength(1)
  expect(remote[1].body).toContain(`<!-- poise-repair-exhaustion:${chainBasis(['repair_execution_budget_exhausted', chain.id, 21])} -->`)
  expect(reports(db)).toHaveLength(2)
  expect(db.prepare('SELECT value FROM meta WHERE key = ?').get(storageKey)).toEqual({ value: legacyIntent })
  expect(journal.read(chain.id)?.held).toBe(budget.held)
  vi.setSystemTime(Date.now() + 86_400_000)
  await runtime.run()
  expect(posts()).toHaveLength(1)
})

it('does not report a hold that was resumed during verification', async () => {
  const { db, journal } = setup()
  const chain = record(journal, exhausted(journal), { type: 'chain.observed', observation: observation() })
  await reportRepairExhaustion(db, journal, chain, async () => {
    record(journal, chain, { type: 'chain.resumed' })
    return observation()
  }, () => true)
  expect(journal.read(chain.id)?.held).toBeNull()
  expect(posts()).toHaveLength(0)
  expect(reports(db)).toHaveLength(0)
})

it('does not publish when the configured account changes during verification', async () => {
  const { db, journal } = setup()
  const chain = record(journal, exhausted(journal), { type: 'chain.observed', observation: observation() })
  const reason = await reportRepairExhaustion(db, journal, chain, async () => {
    mocks.accounts = { me: 'other', agentAccount: 'reviewer' }
    return { ...fresh, checkedAt: Date.now() }
  }, () => true)
  expect(reason).toContain('configured accounts differ from the source chain')
  expect(posts()).toHaveLength(0)
  expect(reports(db)).toHaveLength(0)
})

it('does not adopt or label a marker issue authored by another account', async () => {
  const { db, journal } = setup()
  const chain = exhausted(journal)
  const key = chainBasis(['repair_incomplete_replies', chain.id, 21])
  remote = [issue(44, `<!-- poise-repair-exhaustion:${key} -->`)]
  remote[0].user.login = 'another-author'
  await new BehaviorChainRuntime(journal, operations(db, journal)).run()
  expect(journal.read(chain.id)?.waiting).toContain('identity differs')
  expect(remote[0].labels).toEqual([])
  expect(posts()).toHaveLength(0)
  expect(reports(db)).toHaveLength(0)
})
