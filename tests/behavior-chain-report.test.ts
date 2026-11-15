import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { decideBehaviorChain, type ChainObservation } from '../server/behavior-chain-decision'
import { BehaviorChainRuntime, ReviewScopeIndexingError, type ChainRuntimeOperations } from '../server/behavior-chain-runtime'
import { BehaviorChainJournal, chainBasis, type BehaviorChain, type ChainEvent } from '../server/behavior-chain-store'
import { MAX_REPAIR_REPORT_REPOSITORIES_BYTES, REMEDIATION_SCOPE, implementationReportAdmission, implementationReportBinding, reviewReportBinding, setImplementationReportDisposition, recoverReportedRepair, repairReportImplementationFence, repairReportRepositories, repairReportRepositoriesHealth, repairReportReviewScope, reportRepairExhaustion, reportLegacyReviewTimeout, setRepairReportRepositories, waitForImplementationRechecks } from '../server/behavior-chain-report'
import { behaviorBackgroundBusy, releaseBackgroundBusy } from '../server/release-background'
import { nativeChainOperations } from '../server/behavior-chain-native'
import { nativeRequestSha } from '../server/behavior-chain-action'
import { behaviorChainSummary, behaviorChainWorkImpact } from '../server/behavior-chain-summary'
import { loggingWorkFixture } from './fixtures/logging-work-impact'
import { parseAgentLogRow, parseFailedSource, type LogEntry } from '../server/agent-log-parse'
import type { Organization } from '../server/organizations'
import { completedReviewCall } from './review-response-fixture'

const mocks = vi.hoisted(() => ({ runFile: vi.fn(), settings: { enabled: true, seedMode: 'label', label: 'poise' },
  recheck: vi.fn(), diagnose: vi.fn(),
  accounts: { me: 'author', agentAccount: 'reviewer' }, database: null as Database.Database | null,
  journal: null as BehaviorChainJournal | null }))
vi.mock('../server/process', () => ({ runFile: mocks.runFile, spawnDetached: vi.fn(), MAX_PROCESS_ARG_BYTES: 64 * 1024,
  isExpectedFailure: (error: { expected?: boolean }) => error?.expected === true }))
vi.mock('../server/behavior-chain-test-recheck', async importOriginal => ({
  ...await importOriginal<typeof import('../server/behavior-chain-test-recheck')>(),
  recheckImplementationTest: mocks.recheck, diagnoseReportedAssertion: mocks.diagnose,
}))
vi.mock('../server/db', () => ({ getMeta: (key: string) => key === 'me' ? mocks.accounts.me : null,
  get db() { return mocks.database },
  writeObservation: (write: () => unknown) => write() }))
vi.mock('../server/behavior-chain-journal', () => ({ behaviorChainJournal: () => mocks.journal }))
vi.mock('../server/behaviors', () => ({ getBehaviorChainRuntimeHealth: () => [], getBehaviorChainCapacity: () => ({}) }))
vi.mock('../server/settings', () => ({ getSettings: () => mocks.accounts, getBehaviorChainSettings: () => mocks.settings,
  BEHAVIOR_CHAIN_INTEGRITY_HOLD_KEY: 'behavior_chain_integrity_hold' }))
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
const MIXED_REVIEW_FAILURES: Array<Pick<LogEntry, 'error' | 'error_code' | 'diagnostic'> & { callId: string }> = [
  { callId: '1a4caeb306d84c19a1ede5e42e955261', error_code: 'review_budget_exhausted', error: REVIEW_ERRORS[0] },
  { callId: 'a5b35aea49254e1ca1475c22885c164c', error_code: 'review_inspection_timeout',
    error: 'Local review repository inspection timed out after 30 seconds',
    diagnostic: { version: 1, source: 'caller', severity: 'error', operation: 'github-interface', phase: 'inspection',
      outcome: 'timed_out', stderr: 'private inspection output', stderr_truncated: false,
      context: { timeout_seconds: 30, cwd: '/private/work', message: '--requests-json private inspection arguments' },
      filesystem: { path: '/private/work' } } },
  { callId: '188bcb47407849c6b97bd45d1e261a97', error_code: 'review_budget_exhausted',
    error: 'Review file-group time limit reached; incomplete analysis; reduce the review scope',
    diagnostic: { version: 1, source: 'caller', severity: 'error', operation: 'provider.review', phase: 'file_group',
      outcome: 'timed_out', stderr: '', stderr_truncated: false,
      context: { submission: 'none', timeout_seconds: 60 }, filesystem: null } },
]
const reviewer = { slot: 'primary', model: 'fixture', recovery: 'fixture' }
const databases: Database.Database[] = []
const roots: string[] = []
interface Issue { number: number, title: string, body: string, state: string, html_url: string,
  user: { login: string }, labels: { name: string }[], created_at: string, updated_at: string }
let remote: Issue[]
let seedBody: string
let seedState: string
let seedLabels: { name: string }[]
let priorBody: string
let sourceComments: Array<{ author: string, body: string }>
let priorComments: Array<{ id?: number, author: string, body: string }>
let dropLabels: boolean
let denyLabels: boolean
let loseCreation: boolean
let searchVisible: boolean
let indexed: boolean
let stale: boolean
let prHead: string
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
function closedObservation(): ChainObservation {
  const result = observation()
  result.pull!.state = 'closed'; result.publication.state = 'closed'
  return result
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW)
  vi.stubEnv('POISE_REPAIR_EXHAUSTION_REPOSITORIES', 'acme/repo')
  mocks.settings = { enabled: true, seedMode: 'label', label: 'poise' }
  mocks.accounts = { me: 'author', agentAccount: 'reviewer' }
  remote = []; seedBody = 'Original work'; dropLabels = false; denyLabels = false
  seedState = 'open'; seedLabels = [{ name: 'poise' }]; priorBody = 'Closes #7'
  sourceComments = []; priorComments = []
  loseCreation = false; searchVisible = true; indexed = false; stale = false; prHead = HEAD; fresh = observation()
  mocks.diagnose.mockReset()
  mocks.runFile.mockReset()
  mocks.runFile.mockImplementation(async (command: string, argv: string[]) => {
    const response = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: '' })
    if (command === 'github-interface') {
      if (argv[0] === '--head-sha') {
        const pull = Number(String(argv[1]).replace(/^#/, ''))
        expect(argv.slice(2)).toEqual(['--token-user', 'author'])
        return response({ action: 'head_sha', repository: 'acme/repo', pull_number: pull, head_sha: prHead })
      }
      expect(argv.slice(2)).toEqual(['--repository', 'acme/repo', '--token-user', 'author'])
      const number = Number(argv[1])
      const result = { repository: 'acme/repo', issue_number: number }
      if (argv[0] === '--issue-comments') return response({ ...result, comments: number === 7 ? sourceComments : priorComments })
      if (argv[0] === '--read-issue') return response({ ...result, issue: number === 7
        ? { ...issue(7, seedBody), state: seedState, labels: seedLabels }
        : number === 21 ? { ...issue(21, priorBody), html_url: 'https://github.com/acme/repo/pull/21', state: 'closed', pull_request: {} }
        : remote.find(row => row.number === number) })
    }
    if (command === 'github-datastore') {
      if (argv[0] === 'health') {
        if (stale) throw new Error('github-datastore freshness gate failed: stale review datastore')
        return response({ action: 'health', status: 'healthy', healthy: true, database: '/fixture/github.sqlite',
          max_age_seconds: 120, age_seconds: 1, last_success_at: new Date().toISOString() })
      }
      if (argv[0] === 'view') return response(indexed ? remote.filter(row => row.state === 'open'
        && (mocks.settings.seedMode === 'all' || row.labels.some(label => label.name === mocks.settings.label)))
        .map(row => ({ repo: 'acme/repo', number: row.number, status: 'open' })) : [])
    }
    if (command !== 'gh') throw new Error(`Unexpected fixture command ${command}`)
    if (argv[0] === 'auth') return { stdout: 'fixture-token', stderr: '' }
    if (argv[1] === 'search/issues') return response({ incomplete_results: false, total_count: searchVisible ? remote.length : 0, items: searchVisible ? remote : [] })
    if (argv[1] === 'repos/acme/repo/issues' && argv.some(arg => arg.startsWith('title='))) {
      const row = issue(Math.max(98, ...remote.map(row => row.number)) + 1, argv.find(arg => arg.startsWith('body='))!.slice(5))
      row.title = argv.find(arg => arg.startsWith('title='))!.slice(6)
      if (!dropLabels) row.labels = [{ name: 'poise' }]
      remote.push(row)
      if (loseCreation) throw new Error('Lost creation acknowledgement')
      return response(row)
    }
    if (argv[1] === 'repos/acme/repo/issues/7') return response({ ...issue(7, seedBody), state: seedState, labels: seedLabels })
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
function openSeed(journal: BehaviorChainJournal) {
  return journal.append('acme/repo#7', 'seed:7', 0, { type: 'chain.admitted', repository: 'acme/repo', issue: 7,
    branch: 'poise/issue-7', author: 'author', reviewer: 'reviewer' }, NOW - 600_000)
}
function exhausted(journal: BehaviorChainJournal, errors = [LEGACY, LEGACY, LEGACY], seed = 7, pull = 21, errorCode = 'atomic_work_failed', conflict = false) {
  let chain = journal.read(`acme/repo#${seed}`) ?? journal.append(`acme/repo#${seed}`, `seed:${seed}`, 0, { type: 'chain.admitted', repository: 'acme/repo', issue: seed,
    branch: `poise/issue-${seed}`, author: 'author', reviewer: 'reviewer' }, NOW - 600_000)
  const obs = observation(pull)
  obs.pull!.conflict = conflict
  chain = record(journal, chain, { type: 'chain.observed', observation: { ...obs, checkedAt: NOW - 600_000 } })
  const decision = decideBehaviorChain(chain, obs, NOW)
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
function unpublished(): ChainObservation {
  return { ...observation(), pull: null,
    publication: { pull_number: null, head_sha: null, head_invocation: null, state: null, merged: false, merge_sha: null } }
}
function blockedImplementation(journal: BehaviorChainJournal, invocationId?: string) {
  fresh = unpublished()
  let chain = journal.read('acme/repo#7') ?? journal.append('acme/repo#7', 'seed:7', 0,
    { type: 'chain.admitted', repository: 'acme/repo', issue: 7, branch: 'poise/issue-7', author: 'author', reviewer: 'reviewer' }, NOW - 600_000)
  chain = record(journal, chain, { type: 'chain.observed', observation: { ...fresh, checkedAt: NOW - 600_000 } })
  const id = invocationId ?? `implementation-${chain.resumedAfterSequence}`
  chain = record(journal, chain, { type: 'invocation.admitted', invocation: { id, behavior: 'implement-issue',
    basis: chainBasis(['issue', fresh.issue.revision]), actor: chain.author, slot: reviewer.slot, model: reviewer.model,
    admittedAt: NOW - 300_000, request: { command: 'agent-interface', cwd: '/fixture',
      argv: ['--atomic-work', chain.id, '--expected-issue-revision', fresh.issue.revision] } } })
  chain = record(journal, chain, { type: 'invocation.started', invocationId: id })
  const call: LogEntry = { id: chainBasis(id).slice(0, 32), correlation_id: id, model: reviewer.model,
    behavior: 'implement_issue', source: 'poise:behavior-chain', actor: chain.author, repo: chain.repository, pr_id: '7',
    session_id: null, prompt: '', started_at: new Date(NOW - 300_000).toISOString(),
    completed_at: new Date(NOW - 120_000).toISOString(), time_elapsed: '3m', status: 'failed',
    action: 'not_started', outcome: 'preflight_failed', error_code: 'atomic_work_blocked',
    error: 'atomic behavior blocked: Caller health validation failed; test relay unavailable',
    head_sha: null, expected_head: null, response: null, receipts: null, review_id: null,
    artifact: { phase: 'executing', prepared: { checkout_head: HEAD }, resource_root: '/private/work' },
    resources_settled_at: new Date(NOW - 100_000).toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } }
  return { chain, call }
}
function budgetImplementation(journal: BehaviorChainJournal, count = 3) {
  fresh = unpublished()
  let chain = journal.read('acme/repo#7') ?? journal.append('acme/repo#7', 'seed:7', 0,
    { type: 'chain.admitted', repository: 'acme/repo', issue: 7, branch: 'poise/issue-7', author: 'author', reviewer: 'reviewer' }, NOW - 600_000)
  chain = record(journal, chain, { type: 'chain.observed', observation: { ...fresh, checkedAt: NOW - 600_000 } })
  const basis = chainBasis(['issue', fresh.issue.revision])
  for (let index = 0; index < count; index++) {
    const id = `implementation-7-${chain.resumedAfterSequence}-${index}`
    chain = record(journal, chain, { type: 'invocation.admitted', invocation: { id, behavior: 'implement-issue',
      basis, actor: chain.author, slot: reviewer.slot, model: reviewer.model,
      admittedAt: NOW - 500_000 + index * 100_000,
      request: { command: 'agent-interface', cwd: '/fixture',
        argv: ['--atomic-work', chain.id, '--expected-issue-revision', fresh.issue.revision] } } })
    chain = record(journal, chain, { type: 'invocation.settled', invocationId: id, callId: chainBasis(id).slice(0, 32),
      outcome: BUDGET_CODE,
      evidence: { status: 'failed', action: 'not_started', outcome: 'preflight_failed', error_code: BUDGET_CODE,
        error: BUDGET_ERRORS[index % BUDGET_ERRORS.length],
        completedAt: NOW - 400_000 + index * 100_000, head_sha: null,
        artifact: { phase: 'executing', prepared: { checkout_head: HEAD }, resource_root: '/private/work' },
        resources_settled_at: new Date(NOW - 100_000).toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } } })
  }
  if (count >= 3) {
    return record(journal, chain, { type: 'chain.held',
      reason: `implement-issue failed before publication three times: ${BUDGET_ERRORS[(count - 1) % BUDGET_ERRORS.length]}` })
  }
  return chain
}
function uncertainImplementation(journal: BehaviorChainJournal) {
  const fixture = blockedImplementation(journal, '104dbf93-4dfd-489e-90c4-a5f7447fa8bc')
  Object.assign(fixture.call, { id: 'a0dc866e144840b2a7ea923306913c49', action: null, outcome: null,
    error_code: 'atomic_work_failed', error: 'atomic behavior failed during publishing: private provider output /private/work',
    artifact: { phase: 'publishing', plan_sha: 'd459b301124eef5631cadd755b4483f7fbf41671c8a2a9be28ba5d382c9c68be',
      publication_head: '3c7c5e00c5fb75f53fac307e6a57f70bbc1015df' } })
  return fixture
}
function blockedRepair(journal: BehaviorChainJournal) {
  fresh = observation()
  let chain = openSeed(journal)
  chain = record(journal, chain, { type: 'chain.observed', observation: fresh })
  const decision = decideBehaviorChain(chain, fresh, NOW)
  if (decision.kind !== 'invoke' || decision.behavior !== 'repair-pr') throw new Error('Fixture must need repair')
  const id = 'original-blocked-repair'
  chain = record(journal, chain, { type: 'invocation.admitted', invocation: { id, behavior: decision.behavior,
    basis: decision.basis, actor: chain.author, slot: reviewer.slot, model: reviewer.model,
    admittedAt: NOW - 300_000, request: { command: 'agent-interface', cwd: '/fixture',
      argv: ['--atomic-work', chain.id, '--pull-number', '21', '--expected-head', HEAD,
        '--expected-issue-revision', fresh.issue.revision],
      context: { head: HEAD, reviewRevision: fresh.pull!.reviewRevision } } } })
  chain = record(journal, chain, { type: 'invocation.started', invocationId: id })
  const call: LogEntry = { id: '09bfede268214c4caa6e0237f99e5f17', correlation_id: id, model: reviewer.model,
    behavior: 'repair_pr', source: 'poise:behavior-chain', actor: chain.author, repo: chain.repository, pr_id: '21',
    session_id: null, prompt: '', started_at: new Date(NOW - 300_000).toISOString(),
    completed_at: new Date(NOW - 120_000).toISOString(), time_elapsed: '3m', status: 'failed',
    action: 'not_started', outcome: 'preflight_failed', error_code: 'atomic_work_blocked',
    error: 'atomic behavior blocked: Caller suite completed with failures; assertion details unavailable',
    head_sha: null, expected_head: HEAD, response: null, receipts: null, review_id: null,
    artifact: { phase: 'executing', prepared: { checkout_head: HEAD }, resource_root: '/private/work' },
    resources_settled_at: new Date(NOW - 100_000).toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } }
  return { chain, call }
}
async function exhaustedReviews(journal: BehaviorChainJournal,
  failures: Array<Pick<LogEntry, 'error' | 'error_code' | 'diagnostic'> & { callId?: string }> = REVIEW_ERRORS.map(error => ({ error, error_code: 'review_budget_exhausted' }))) {
  fresh = { ...observation(), prReviewers: [reviewer] }
  let chain = journal.read('acme/repo#7') ?? journal.append('acme/repo#7', 'seed:7', 0, { type: 'chain.admitted', repository: 'acme/repo', issue: 7,
    branch: 'poise/issue-7', author: 'author', reviewer: 'reviewer' }, NOW - 600_000)
  chain = record(journal, chain, { type: 'chain.observed', observation: { ...fresh, checkedAt: NOW - 600_000 } })
  const native = nativeChainOperations({ login: 'acme' } as Organization, {
    roster: async () => fresh, resolve: async () => reviewer, prepare: async () => ({}), borrow: () => null,
    available: () => true, capacity: () => 3, permitted: () => true, note: () => '', severity: () => 'p2',
    received: () => {}, reviews: async () => '', existing: async () => new Set(), wake: () => {},
  })
  for (const [index, failure] of failures.entries()) {
    const decision = decideBehaviorChain(chain, fresh, NOW)
    if (decision.kind !== 'invoke' || decision.behavior !== 'review-pr') throw new Error('Fixture must need PR review')
    const id = `review-7-${chain.resumedAfterSequence}-${index}`
    const request = await native.request(chain, fresh, decision, id)
    if (!request) throw new Error('Fixture must prepare a native PR review')
    chain = record(journal, chain, { type: 'invocation.admitted', invocation: { id, behavior: decision.behavior,
      basis: decision.basis, actor: decision.actor, slot: reviewer.slot, model: reviewer.model,
      admittedAt: NOW - 500_000 + index * 100_000, request } })
    chain = record(journal, chain, { type: 'invocation.settled', invocationId: id, callId: failure.callId ?? chainBasis(id).slice(0, 32),
      outcome: 'preflight_failed', evidence: { status: 'failed', error_code: failure.error_code, error: failure.error,
        ...(failure.diagnostic ? { diagnostic: failure.diagnostic } : {}),
        action: 'not_started', outcome: 'preflight_failed', completedAt: NOW - 400_000 + index * 100_000,
        head_sha: null, review_id: null, receipts: null, artifact: { phase: 'reviewing' },
        resources_settled_at: new Date(NOW - 100_000).toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } } })
  }
  const decision = decideBehaviorChain(chain, fresh, NOW)
  if (decision.kind !== 'hold') throw new Error('Fixture must exhaust its PR review attempts')
  return record(journal, chain, { type: 'chain.held', reason: decision.reason })
}
async function exhaustedApprovals(journal: BehaviorChainJournal,
  failures: Array<Pick<LogEntry, 'error' | 'error_code' | 'diagnostic'> & { callId?: string }> = REVIEW_ERRORS.map(error => ({ error, error_code: 'review_budget_exhausted' }))) {
  fresh = { ...observation(), prReviewers: [] }
  fresh.pull!.changesRequested = false
  fresh.pull!.unresolved = 0
  let chain = journal.read('acme/repo#7') ?? journal.append('acme/repo#7', 'seed:7', 0, { type: 'chain.admitted', repository: 'acme/repo', issue: 7,
    branch: 'poise/issue-7', author: 'author', reviewer: 'reviewer' }, NOW - 600_000)
  chain = record(journal, chain, { type: 'chain.observed', observation: { ...fresh, checkedAt: NOW - 600_000 } })
  const native = nativeChainOperations({ login: 'acme' } as Organization, {
    roster: async () => fresh, resolve: async () => reviewer, prepare: async () => ({}), borrow: () => null,
    available: () => true, capacity: () => 3, permitted: () => true, note: () => '', severity: () => 'p2',
    received: () => {}, reviews: async () => '', existing: async () => new Set(), wake: () => {},
  })
  for (const [index, failure] of failures.entries()) {
    const decision = decideBehaviorChain(chain, fresh, NOW)
    if (decision.kind !== 'invoke' || decision.behavior !== 'approve-pr') throw new Error('Fixture must need PR approval')
    const id = `approval-7-${chain.resumedAfterSequence}-${index}`
    const request = await native.request(chain, fresh, decision, id)
    if (!request) throw new Error('Fixture must prepare a native PR approval')
    chain = record(journal, chain, { type: 'invocation.admitted', invocation: { id, behavior: decision.behavior,
      basis: decision.basis, actor: decision.actor, slot: reviewer.slot, model: reviewer.model,
      admittedAt: NOW - 500_000 + index * 100_000, request } })
    chain = record(journal, chain, { type: 'invocation.settled', invocationId: id, callId: failure.callId ?? chainBasis(id).slice(0, 32),
      outcome: 'preflight_failed', evidence: { status: 'failed', error_code: failure.error_code, error: failure.error,
        ...(failure.diagnostic ? { diagnostic: failure.diagnostic } : {}),
        action: 'not_started', outcome: 'preflight_failed', completedAt: NOW - 400_000 + index * 100_000,
        head_sha: null, review_id: null, receipts: null, artifact: { phase: 'reviewing' },
        resources_settled_at: new Date(NOW - 100_000).toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } } })
  }
  const decision = decideBehaviorChain(chain, fresh, NOW)
  if (decision.kind !== 'hold') throw new Error('Fixture must exhaust its PR approval attempts')
  return record(journal, chain, { type: 'chain.held', reason: decision.reason })
}
function operations(db: Database.Database, journal: BehaviorChainJournal, overrides: Partial<ChainRuntimeOperations> = {}): ChainRuntimeOperations {
  const forbidden = async () => { throw new Error('Fixture must not start native work') }
  const intake = nativeChainOperations({ login: 'acme' } as Organization, {
    roster: forbidden, resolve: forbidden, prepare: forbidden, borrow: () => null, available: () => false, capacity: () => 3,
    permitted: () => false, note: () => '', severity: () => 'p2', received: () => {}, reviews: forbidden, existing: async () => new Set(), wake: () => {},
  })
  const ops: ChainRuntimeOperations = { enabled: () => true, accounts: () => ({ author: 'author', reviewer: 'reviewer' }), discover: intake.discover,
    ownsRepository: () => true, observe: async chain => chain.issue === 7 ? observation() : { ...observation(),
      pull: null, publication: { pull_number: null, head_sha: null, head_invocation: null, state: null, merged: false, merge_sha: null } },
    reportHold: chain => reportRepairExhaustion(db, journal, chain, async () => {
      await mocks.runFile('github-datastore', ['health', '--max-age-seconds', '120'])
      return { ...fresh, checkedAt: Date.now() }
    }, () => true), readInvocations: async () => ({ entries: [], quarantined: [] }), received: () => {}, available: () => false,
    capacity: () => 3, permitted: () => false, request: forbidden, launch: forbidden, perform: forbidden,
    readActionResult: forbidden, resumePublication: forbidden, fenceClosedTarget: forbidden, wake: () => {}, ...overrides }
  ops.implementationAdmission ??= (chain, observation) => implementationReportAdmission(db, journal, chain, observation, ops.observe)
  return ops
}
const posts = () => mocks.runFile.mock.calls.filter(call => call[0] === 'gh' && call[1][1] === 'repos/acme/repo/issues')
const labelPosts = () => mocks.runFile.mock.calls.filter(call => call[0] === 'gh' && call[1][1].endsWith('/labels') && call[1].includes('POST'))
const reports = (db: Database.Database) => db.prepare("SELECT value FROM meta WHERE key LIKE 'behavior_chain_repair_report:%'").all() as { value: string }[]

// #1782's blocker, including its location, missing original assertion and later
// truncated timeout. None of that historical output proves the shared cause.
const INCIDENT_1778 = 'atomic behavior blocked: npm run check first failed at tests/test-offload.test.ts > a suite on a test box > recovers mid-suite when only one suite may run (tests/test-offload.test.ts:1856): Error: STACK_TRACE_ERROR. Actionable assertion details are unavailable in the first-failure record. Captured candidate digest: 07735295ec5b89c66059e5fe41134cc2cf2bb31b31025dbe15e95e23c5dd2b2f; original producing relay run: ed71f964d37bccfa95a490ed4edb8cbe. Subsequently the command exited 124 with \'[poise] no '

it('reproduces both named fixture conditions without changing assertions or deadlines', async () => {
  const { recheckFixture } = await vi.importActual<typeof import('../server/behavior-chain-test-recheck')>('../server/behavior-chain-test-recheck')
  const test = 'a suite on a test box > recovers mid-suite when only one suite may run'
  const old = `  it('recovers mid-suite when only one suite may run', async () => {
    await startAll({ maxRuns: 1 })
    const run = suite(repository(), [process.execPath, '-e', 'console.log("started"); setTimeout(() => console.log("complete"), 300)'])
    await new Promise((done) => { run.child.stdout?.once('data', done) })
    relay.stop()
    await startAll2({ maxRuns: 1 })
    const { code, stdout, stderr } = await run.done
    expect(code).toBe(0)
    expect(stdout).toBe('started\\nstarted\\ncomplete\\n')
  })
  it('next', () => {})`
  const injected = recheckFixture(old, test)
  const removeObservation = (source: string) => source.replace("console.info('poise fixture recheck observation')\n      ", '')
  expect(removeObservation(injected.source).replace('await new Promise((done) => setTimeout(done, 750))\n      ', '')).toBe(old)
  const current = readFileSync(resolve('tests/test-offload.test.ts'), 'utf8')
  expect(removeObservation(recheckFixture(current, test).source)).toBe(current)
  const memory = 'a suite on a test box > keeps memory warnings correlatable without logging command bodies with base service null'
  const delayed = recheckFixture(current, memory)
  expect(delayed.names).toEqual([memory, ...['node', 'sh', 'npm run check'].map(command => `${memory} and command ${command}`)])
  expect(removeObservation(delayed.source).replace('await new Promise((done) => setTimeout(done, 6650))\n      ', '')).toBe(current)
  expect(recheckFixture(current, 'another reported test')).toEqual({ source: current, names: ['another reported test'], condition: 'unmodified reported test', observations: 0 })
})

it.each(['unrelated', 'skipped', 'inconclusive', 'unhandled', 'unaccounted', 'duplicate', 'pending duplicate', 'missing memory command', 'missing timing observation', 'no assertion'])(
  'rejects %s recheck results instead of admitting from a passing job', async mode => {
    const { recheckResults } = await vi.importActual<typeof import('../server/behavior-chain-test-recheck')>('../server/behavior-chain-test-recheck')
    const name = 'a suite on a test box > recovers mid-suite when only one suite may run'
    const assertion = { ancestorTitles: ['a suite on a test box'], title: name.split(' > ')[1], status: 'passed', failureMessages: [] as string[] }
    const result = { success: true, completion: { reason: 'passed', errors: 0, observations: 0 }, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0,
      numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0, testResults: [{ name: '/clean/tests/test-offload.test.ts', message: '', assertionResults: [assertion] }] }
    expect(recheckResults(JSON.stringify(result), '/clean', [name], false)).toEqual({ tests: [name], failure: '' })
    let names = [name]
    if (mode === 'unrelated') assertion.title = 'a different test'
    if (mode === 'skipped') { assertion.status = 'skipped'; result.numPassedTests = 0; result.numPendingTests = 1 }
    if (mode === 'inconclusive') result.completion.reason = 'interrupted'
    if (mode === 'unhandled') result.completion.errors = 1
    if (mode === 'unaccounted') result.numTotalTests = 2
    if (mode === 'duplicate') { result.testResults[0].assertionResults.push(assertion); result.numTotalTests++; result.numPassedTests++ }
    if (mode === 'pending duplicate') { result.testResults[0].assertionResults.push({ ...assertion, status: 'pending' }); result.numTotalTests++; result.numPendingTests++ }
    if (mode === 'missing memory command') names = ['old memory test', name, 'sh case', 'npm case']
    if (mode === 'no assertion') { assertion.status = 'failed'; result.success = false; result.numFailedTests = 1; result.numPassedTests = 0; result.completion.reason = 'failed' }
    expect(() => recheckResults(JSON.stringify(result), '/clean', names, mode === 'no assertion', undefined,
      mode === 'missing timing observation' ? 1 : 0)).toThrow()
  })

it.each([false, true])('runs independent pinned clean bases and rejects an unreproduced old failure (%s)', async oldPassed => {
  const { recheckImplementationTest } = await vi.importActual<typeof import('../server/behavior-chain-test-recheck')>('../server/behavior-chain-test-recheck')
  const old = 'a'.repeat(40), base = 'b'.repeat(40), merge = 'c'.repeat(40), file = 'tests/fixture.test.ts'
  const visits: string[] = []
  let cwd = '', pinned = ''
  mocks.runFile.mockImplementation(async (command: string, argv: string[], options: { cwd: string, timeoutMs: number }) => {
    expect(options.timeoutMs).toBeLessThanOrEqual(120_000)
    if (command === 'github-interface') {
      expect(argv.slice(0, 2)).toEqual(['--checkout-repo', 'acme/repo'])
      cwd = argv[3]; mkdirSync(join(cwd, 'tests'), { recursive: true })
      symlinkSync(resolve('node_modules'), join(cwd, 'node_modules'), 'dir')
    } else {
      expect(options.cwd).toBe(cwd)
      if (command === 'git' && argv[0] === 'checkout') {
        pinned = argv.at(-1)!; visits.push(pinned)
        writeFileSync(join(cwd, file), `// clean source ${pinned}\nimport { describe, it, expect } from 'vitest'\n`
          + `describe('fixture', () => { it('has a shared failure', () => { expect(${pinned === old && !oldPassed ? 1 : 2}).toBe(2) }) })`)
      }
      if (command === 'node') {
        expect(readFileSync(join(cwd, file), 'utf8')).toContain(`// clean source ${pinned}`)
        expect(readFileSync(argv.at(-1)!, 'utf8')).toContain('completion = { reason, errors: errors.length, observations: this.observations }')
        expect(argv).toContain('--maxWorkers=1')
        expect(argv).toContain('--retry=0')
        try {
          return { stdout: execFileSync(process.execPath, argv, { cwd, encoding: 'utf8', timeout: 5000 }), stderr: '' }
        } catch (error) {
          if ((error as { status?: number }).status === 1) Object.assign(error as object, { expected: true, code: 1 })
          throw error
        }
      }
    }
    return { stdout: command === 'git' && argv[0] === 'diff' ? 'fixture correction' : '', stderr: '' }
  })
  const run = recheckImplementationTest('acme/repo', 'author', old, base, merge, file, 'fixture > has a shared failure')
  if (oldPassed) await expect(run).rejects.toThrow('was not reproduced')
  else await expect(run).resolves.toMatchObject({ old: { base: old, failure: expect.stringContaining('expected 1 to be 2') },
    current: { base, tests: ['fixture > has a shared failure'] } })
  expect(visits).toEqual(oldPassed ? [old] : [old, base])
  expect(mocks.runFile.mock.calls.filter(([command, argv]) => command === 'git' && argv[0] === 'clean')).toHaveLength(visits.length)
  expect(existsSync(cwd)).toBe(false)
})

it.each(['recover', 'memory recovery', 'restart during recheck', 'failed recheck', 'interrupted recheck', 'operator hold', 'changed source',
  'ineligible', 'closed source', 'unsettled resources', 'possible publication', 'branch', 'PR', 'competing work',
  'changed during recheck', 'changed after recheck', 'restart before admission', 'changed during preparation', 'missing review',
  'base advances during recheck', 'base advances before admission', 'remedy is unverified on new base', 'recheck fails on new base'])(
  'revalidates the persisted #1778/#1782 incident once through normal admission: %s', async mode => {
    const { db, journal } = setup()
    mocks.accounts = { me: 'mikkokotila', agentAccount: 'bit-mis' }
    const memory = mode === 'memory recovery', number = memory ? 1754 : 1778, reportNumber = memory ? 99 : 1782, remedy = memory ? 1747 : 1765
    const repository = 'autonomio/poise', id = `${repository}#${number}`, call = memory ? 'f'.repeat(32) : '15b20584dcea402faeb94959a0e7f699'
    const old = 'd45773e5250787a9c6c6efea1fa320f986145237', base = 'e'.repeat(40), merge = 'c'.repeat(40)
    const nextBase = 'f'.repeat(40)
    const advancesDuringRecheck = ['base advances during recheck', 'remedy is unverified on new base', 'recheck fails on new base'].includes(mode)
    const restartsBeforeAdmission = ['restart before admission', 'base advances during recheck', 'base advances before admission'].includes(mode)
    const test = 'a suite on a test box > ' + (memory ? 'keeps memory warnings correlatable without logging command bodies with base service null'
      : 'recovers mid-suite when only one suite may run')
    const blocker = memory ? `atomic behavior blocked: npm run check first failed at tests/test-offload.test.ts > ${test} (tests/test-offload.test.ts:2055): Test timed out in 20000ms.` : INCIDENT_1778
    let chain = journal.append(id, `seed-${number}`, 0, { type: 'chain.admitted', repository, issue: number,
      branch: `poise/issue-${number}`, author: 'mikkokotila', reviewer: 'bit-mis' }, NOW - 600_000)
    const obs = { ...unpublished(), prerequisites: { wait: null, base, evidence: [] } }
    const basis = chainBasis(['issue', obs.issue.revision])
    chain = record(journal, chain, { type: 'invocation.admitted', invocation: { id: '851e78f6-847a-4f1e-82da-e2592def4f4f',
      behavior: 'implement-issue', basis, actor: chain.author, model: reviewer.model, slot: reviewer.slot, admittedAt: NOW - 300_000,
      request: { command: 'agent-interface', cwd: '/fixture', argv: ['--expected-issue-revision', obs.issue.revision] } } })
    chain = record(journal, chain, { type: 'chain.held', reason: blocker })
    const holdSequence = chain.sequence
    chain = record(journal, chain, { type: 'invocation.settled', invocationId: chain.invocations[0].id, callId: call,
      outcome: 'preflight_failed', evidence: { status: 'failed', action: 'not_started', outcome: 'preflight_failed',
        error_code: 'atomic_work_blocked', error: blocker, completedAt: NOW - 120_000,
        resources_settled_at: mode === 'unsettled resources' ? null : new Date(NOW - 100_000).toISOString(),
        resource_ownership: { version: 1, roots: [], errors: [], ...(mode === 'unsettled resources' ? { process_pending: true } : {}) },
        artifact: { phase: 'executing', ...(mode === 'possible publication' ? { plan_sha: 'f'.repeat(64) } : {}), prepared: { repository, issue_number: number, actor: chain.author, branch: chain.branch,
          checkout_head: old, head_sha: null, pull_number: null } } } })
    const original = structuredClone(chain.invocations[0])
    expect(chain.testHold).toBeUndefined()
    const key = chainBasis(['atomic_work_blocked', id]), storageKey = `behavior_chain_repair_report:${key}`
    if (!memory) expect(key).toBe('365a7d93e304f4fc15a0d1658cc60e718998ea59e25c42ad490fa896f3ef9e0b')
    const report = { key, source: id, pull: null, holdSequence, heldAt: NOW - 60_000, head: null, basis, slot: reviewer.slot,
      attempts: [{ invocation: original.id, call, completedAt: NOW - 120_000 }], issueNumber: reportNumber }
    db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run(storageKey, JSON.stringify(report))
    mocks.runFile.mockImplementation(async (_command: string, argv: string[]) => {
      const number = Number(argv[1]), delivery = argv.includes('--delivery-base')
      return { stderr: '', stdout: JSON.stringify({ repository, issue_number: number,
        ...(argv[0] === '--issue-comments' ? { comments: [{ author: 'bit-mis', body: `#${remedy} owns that test; use its existing repair.` }] }
          : delivery ? { verified: number === remedy && !(mode === 'remedy is unverified on new base' && obs.prerequisites.base === nextBase),
            base_sha: obs.prerequisites.base, merge_sha: merge }
            : { issue: { body: number === reportNumber
              ? `<!-- poise-repair-exhaustion:${key} -->\nSource: ${id}; hold event ${holdSequence}; basis ${basis}; slot primary.\n${blocker}\nCaller ${call}`
              : 'tests/test-offload.test.ts: ' + (memory ? 'keeps memory warnings correlatable without logging command bodies'
                : 'recovers mid-suite when only one suite may run'), user: { login: 'mikkokotila' } } }) }) }
    })
    let finishRecheck!: () => void
    const recheckGate = new Promise<void>(resolve => { finishRecheck = resolve })
    mocks.recheck.mockReset()
    mocks.recheck.mockImplementation(async (_repository, _actor, _old, checkedBase) => {
      await recheckGate
      if (advancesDuringRecheck && checkedBase === base) obs.prerequisites.base = nextBase
      if (mode === 'failed recheck' || mode === 'recheck fails on new base' && checkedBase === nextBase) throw new Error('old-base recheck passed; shared failure was not reproduced')
      if (mode === 'changed during recheck') record(journal, journal.read(id)!, { type: 'chain.held', reason: INCIDENT_1778 })
      return { old: { base: old, tests: [test], failure: 'AssertionError: expected stdout to contain two started lines' },
        current: { base: checkedBase, tests: memory ? ['node', 'sh', 'npm run check'].map(command => `${test} and command ${command}`) : [test] },
        condition: memory ? '6650 ms before each memory-warning command' : '750 ms after first output, before relay interruption' }
    })
    if (mode === 'interrupted recheck') db.prepare('UPDATE meta SET value=? WHERE key=?').run(JSON.stringify({ ...report,
      recheck: { remedy: 1765, base, merge, state: 'running' } }), storageKey)
    if (mode === 'operator hold') chain = record(journal, chain, { type: 'chain.held', reason: INCIDENT_1778 })
    if (mode === 'changed source') obs.issue.revision = 'new revision'
    if (mode === 'ineligible') obs.issue.eligible = false
    if (mode === 'closed source') obs.issue.open = false
    if (mode === 'branch') obs.publication.head_sha = 'b'.repeat(40)
    if (mode === 'PR') obs.publication.pull_number = 1871
    if (mode === 'competing work') obs.existingPulls = ['https://github.com/autonomio/poise/pull/1871']
    if (mode === 'missing review') obs.issueReviewers = [reviewer]
    let permitted = !restartsBeforeAdmission
    const launch = vi.fn(async (invocation: BehaviorChain['invocations'][number]) => {
      if (invocation.basis === basis && (advancesDuringRecheck || mode === 'base advances before admission')) {
        expect(journal.read(id)?.observation?.testDependency).toMatchObject({ recovery: { base: nextBase, merge } })
      }
      return true
    })
    const observe = vi.fn(async (current: BehaviorChain) => ({ ...structuredClone(current.id === id ? obs
      : { ...unpublished(), prerequisites: { wait: null, base, evidence: [] } }), checkedAt: Date.now() }))
    const ops = operations(db, journal, { accounts: () => ({ author: 'mikkokotila', reviewer: 'bit-mis' }), discover: async () => [],
      available: () => true, permitted: (_chain, decision) => permitted && decision.behavior === 'implement-issue', observe,
      launch, request: async () => {
        if (mode === 'changed during preparation') obs.existingPulls = ['https://github.com/autonomio/poise/pull/1871']
        return { command: 'agent-interface', cwd: '/fixture', argv: ['--model', reviewer.model] }
      } })
    ops.recoverReport = (current, observation) => recoverReportedRepair(db, journal, current, observation, ops.observe, () => true)
    let runtime = new BehaviorChainRuntime(journal, ops)
    let swept = false
    const sweep = runtime.run().then(() => { swept = true })
    try {
      await vi.waitFor(() => expect(swept).toBe(true))
      expect(launch).not.toHaveBeenCalled()
      if (!['unsettled resources', 'possible publication'].includes(mode)) expect(journal.read(id)?.invocations).toEqual([original])
      const rechecked = restartsBeforeAdmission || advancesDuringRecheck
        || ['recover', 'memory recovery', 'restart during recheck', 'failed recheck', 'changed during recheck',
        'changed after recheck', 'changed during preparation', 'missing review'].includes(mode)
      expect(mocks.recheck).toHaveBeenCalledTimes(rechecked ? 1 : 0)
      expect(releaseBackgroundBusy()).toBe(rechecked ? 1 : 0)
      expect(behaviorBackgroundBusy()).toBe(rechecked ? 1 : 0)
      const readRecheck = () => JSON.parse((db.prepare('SELECT value FROM meta WHERE key=?').get(storageKey) as { value: string }).value).recheck
      if (mode === 'restart during recheck') {
        const unrelated = `${repository}#2000`
        journal.append(unrelated, 'unrelated', 0, { type: 'chain.admitted', repository, issue: 2000,
          branch: 'poise/issue-2000', author: chain.author, reviewer: chain.reviewer })
        for (let tick = 0; tick < 2; tick++) {
          const waiting = journal.read(id)!
          expect(journal.reconciliationAt(waiting)).toBe(Number(waiting.observation!.checkedAt) + 120_000)
          vi.setSystemTime(journal.reconciliationAt(waiting)!)
          await runtime.run()
          expect(journal.read(unrelated)?.observation).not.toBeNull()
          expect(journal.read(unrelated)?.invocations).toMatchObject([{ behavior: 'implement-issue' }])
          expect(launch).toHaveBeenCalledOnce()
          expect(journal.read(id)?.invocations).toEqual([original])
          expect(journal.read(id)?.held).toBe(blocker)
          expect(journal.read(id)?.testRecovery).toBeUndefined()
          expect(readRecheck()).toMatchObject({ state: 'running' })
          expect(mocks.recheck).toHaveBeenCalledOnce()
          journal.rebuild()
          runtime = new BehaviorChainRuntime(new BehaviorChainJournal(db), ops)
        }
      }
      const sequence = journal.read(id)!.sequence, reads = observe.mock.calls.length
      let settled = false
      const settling = waitForImplementationRechecks().then(() => { settled = true })
      await Promise.resolve()
      if (rechecked) expect(settled).toBe(false)
      finishRecheck()
      await settling
      expect(releaseBackgroundBusy()).toBe(0)
      expect(behaviorBackgroundBusy()).toBe(0)
      expect(observe).toHaveBeenCalledTimes(reads)
      if (mode !== 'changed during recheck') expect(journal.read(id)?.sequence).toBe(sequence)
      if (rechecked) expect(readRecheck()).toMatchObject({ state: mode === 'failed recheck' ? 'failed' : 'passed' })
      expect(journal.read(id)?.testRecovery).toBeUndefined()
      if (mode === 'changed after recheck') obs.issue.revision = 'new revision'
      if (restartsBeforeAdmission && !advancesDuringRecheck) {
        vi.setSystemTime(Date.now() + 86_400_000)
        await runtime.run()
        expect(journal.read(id)).toMatchObject({ held: null, testRecovery: { base, recheck: key } })
        expect(launch).not.toHaveBeenCalled()
        if (mode === 'base advances before admission') obs.prerequisites.base = nextBase
      }
      permitted = true
      journal.rebuild()
      runtime = new BehaviorChainRuntime(new BehaviorChainJournal(db), ops)
      for (let tick = 0; tick < 3; tick++) {
        vi.setSystemTime(Date.now() + 86_400_000)
        await runtime.run()
        await waitForImplementationRechecks()
      }
      const recovered = restartsBeforeAdmission || ['recover', 'memory recovery', 'restart during recheck'].includes(mode)
      if (rechecked) expect(observe.mock.calls.length).toBeGreaterThan(reads)
      expect(journal.read(id)?.invocations).toHaveLength(recovered ? 2 : 1)
      expect(launch).toHaveBeenCalledTimes((recovered ? 1 : 0) + (mode === 'restart during recheck' ? 1 : 0))
      const checkedBases = ['base advances during recheck', 'base advances before admission', 'recheck fails on new base'].includes(mode)
        ? [base, nextBase] : rechecked ? [base] : []
      expect(mocks.recheck.mock.calls).toEqual(checkedBases.map(checkedBase =>
        [repository, 'mikkokotila', old, checkedBase, merge, 'tests/test-offload.test.ts', test, undefined]))
    } finally {
      finishRecheck()
      await sweep
      await waitForImplementationRechecks()
    }
    if (!['unsettled resources', 'possible publication'].includes(mode)) expect(journal.read(id)?.invocations[0]).toEqual(original)
    const retained = JSON.parse((db.prepare('SELECT value FROM meta WHERE key=?').get(storageKey) as { value: string }).value)
    const { recheck, ...unchanged } = retained
    expect(unchanged).toEqual(report)
    if (mode === 'failed recheck') {
      expect(recheck).toMatchObject({ state: 'failed', reason: expect.stringContaining('shared failure was not reproduced') })
      expect(journal.read(id)?.waiting).toContain('shared failure was not reproduced')
    }
  })

it('lets a later CI-only hold resume past a retained pre-PR report', async () => {
  const { db, journal } = setup()
  const id = 'acme/repo#7'
  let chain = journal.append(id, 'seed:7', 0, { type: 'chain.admitted', repository: 'acme/repo', issue: 7,
    branch: 'poise/issue-7', author: 'author', reviewer: 'reviewer' }, NOW - 600_000)
  const pre = unpublished()
  chain = record(journal, chain, { type: 'chain.observed', observation: { ...pre, checkedAt: NOW - 600_000 } })
  const basis = chainBasis(['issue', pre.issue.revision])
  chain = record(journal, chain, { type: 'invocation.admitted', invocation: { id: 'original-implement',
    behavior: 'implement-issue', basis, actor: chain.author, slot: reviewer.slot, model: reviewer.model,
    admittedAt: NOW - 300_000, request: { command: 'agent-interface', cwd: '/fixture',
      argv: ['--expected-issue-revision', pre.issue.revision] } } })
  chain = record(journal, chain, { type: 'chain.held', reason: INCIDENT_1778 })
  const holdSequence = chain.sequence
  const callId = '15b20584dcea402faeb94959a0e7f699'
  chain = record(journal, chain, { type: 'invocation.settled', invocationId: 'original-implement', callId,
    outcome: 'preflight_failed', evidence: { status: 'failed', action: 'not_started', outcome: 'preflight_failed',
      error_code: 'atomic_work_blocked', error: INCIDENT_1778, completedAt: NOW - 120_000,
      artifact: { phase: 'executing', prepared: { repository: 'acme/repo', issue_number: 7, actor: chain.author,
        branch: chain.branch, checkout_head: HEAD, head_sha: null, pull_number: null } },
      resources_settled_at: new Date(NOW - 100_000).toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } } })
  const key = chainBasis(['atomic_work_blocked', id])
  db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run(`behavior_chain_repair_report:${key}`, JSON.stringify({ key,
    source: id, pull: null, holdSequence, heldAt: NOW - 60_000, head: null, basis, slot: reviewer.slot,
    attempts: [{ invocation: 'original-implement', call: callId, completedAt: NOW - 120_000 }], issueNumber: 99 }))
  chain = record(journal, chain, { type: 'chain.resumed', recovery: { origin: 'operator' } })
  const obs = observation()
  chain = record(journal, chain, { type: 'chain.observed', observation: { ...obs, checkedAt: NOW - 60_000 } })
  const repairCall = '09bfede268214c4caa6e0237f99e5f17'
  const repairError = 'atomic behavior blocked: CI failed'
  chain = record(journal, chain, { type: 'invocation.admitted', invocation: { id: 'repair-1', behavior: 'repair-pr',
    basis: chainBasis(['repair', HEAD]), actor: chain.author, slot: reviewer.slot, model: reviewer.model,
    admittedAt: NOW - 30_000, request: { command: 'agent-interface', cwd: '/fixture',
      context: { head: HEAD, reviewRevision: obs.pull!.reviewRevision },
      argv: ['--pull-number', '21', '--expected-head', HEAD, '--expected-issue-revision', obs.issue.revision] } } })
  chain = record(journal, chain, { type: 'invocation.settled', invocationId: 'repair-1', callId: repairCall,
    outcome: 'preflight_failed', evidence: { status: 'failed', action: 'not_started', outcome: 'preflight_failed',
      error_code: 'atomic_work_blocked', error: repairError, completedAt: NOW - 20_000,
      artifact: { phase: 'executing', prepared: { checkout_head: HEAD } },
      resources_settled_at: new Date(NOW - 10_000).toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } } })
  chain = record(journal, chain, { type: 'chain.held', reason: repairError,
    ciHold: { invocationId: 'repair-1', callId: repairCall, head: HEAD } })
  const result = await recoverReportedRepair(db, journal, chain, { ...obs, checkedAt: Date.now() }, async () => obs, () => true)
  expect(result).toBeNull()
  expect(mocks.recheck).not.toHaveBeenCalled()
})

async function diagnosedRepair(path = ':memory:', diagnosticText?: string, reviewOnly = false) {
  const { db, journal } = setup(path)
  let source = exhausted(journal, BUDGET_ERRORS, 7, 21, BUDGET_CODE, true)
  fresh = observation()
  fresh.pull!.conflict = true
  source = record(journal, source, { type: 'chain.observed', observation: { ...fresh, checkedAt: NOW - 120_000 } })
  await operations(db, journal).reportHold!(source)
  let diagnostic = journal.append('acme/repo#99', 'diagnostic-seed', 0, { type: 'chain.admitted', repository: source.repository,
    issue: 99, branch: 'poise/issue-99', author: source.author, reviewer: source.reviewer }, NOW - 60_000)
  const reportObservation = unpublished()
  const text = diagnosticText ?? (`TS2352 at tests/behavior-chain-action-recovery.test.ts:397: context_sha is missing. PR #21 head ${HEAD}. `
    + 'Retain context_sha in the typed response when adding coverage; the faulty test exists only on the source PR branch.')
  const error = `atomic behavior blocked: ${text}`
  diagnostic = record(journal, diagnostic, { type: 'chain.observed', observation: { ...reportObservation, checkedAt: NOW - 600_000 } })
  if (reviewOnly) {
    priorComments = [{ id: 123, author: source.reviewer, body: `${text}\n<!-- agent-interface issue-review call=${'d'.repeat(32)} -->` }]
    reportObservation.issue.commentIds = [123]
    diagnostic = record(journal, diagnostic, { type: 'invocation.admitted', invocation: {
      id: 'diagnosis', behavior: 'review-issue', basis: chainBasis(['issue', reportObservation.issue.revision]),
      actor: source.reviewer, model: reviewer.model, slot: reviewer.slot, admittedAt: NOW - 60_000,
      request: { command: 'agent-interface', cwd: '/fixture', argv: ['--issue-review', diagnostic.id,
        '--expected-issue-revision', reportObservation.issue.revision] } } })
    diagnostic = record(journal, diagnostic, { type: 'invocation.settled', invocationId: 'diagnosis', callId: 'd'.repeat(32), outcome: 'commented',
      evidence: { status: 'completed', action: 'commented', issue_revision: reportObservation.issue.revision, completedAt: NOW - 30_000,
        receipts: [{ issue: diagnostic.id, comment_id: 123, author: source.reviewer }],
        resources_settled_at: new Date(NOW - 20_000).toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } } })
  } else {
    diagnostic = record(journal, diagnostic, { type: 'invocation.admitted', invocation: {
      id: 'diagnosis', behavior: 'implement-issue', basis: chainBasis(['issue', reportObservation.issue.revision]),
      actor: source.author, model: reviewer.model, slot: reviewer.slot, admittedAt: NOW - 60_000,
      request: { command: 'agent-interface', cwd: '/fixture', argv: ['--atomic-work', diagnostic.id,
        '--expected-issue-revision', reportObservation.issue.revision] } } })
    diagnostic = record(journal, diagnostic, { type: 'invocation.settled', invocationId: 'diagnosis', callId: 'd'.repeat(32),
      outcome: 'preflight_failed', evidence: { status: 'failed', action: 'not_started', outcome: 'preflight_failed',
        error_code: 'atomic_work_blocked', error, completedAt: NOW - 30_000,
        artifact: { phase: 'executing', prepared: { repository: source.repository, issue_number: 99, actor: source.author,
          branch: diagnostic.branch, pull_number: null, head_sha: null, checkout_head: 'b'.repeat(40) } },
        diagnostic: { version: 1, source: 'caller', severity: 'error', operation: 'provider.atomic_work', phase: 'validating',
          outcome: 'blocked', stderr: text, stderr_truncated: false, context: { submission: 'none' }, filesystem: null },
        resources_settled_at: new Date(NOW - 20_000).toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } } })
    diagnostic = record(journal, diagnostic, { type: 'chain.held', reason: error })
    priorComments = [{ id: 123, author: source.reviewer, body: 'Keep context_sha through the spread and preserve the incomplete-coverage assertion.' }]
  }
  const native = nativeChainOperations({ login: 'acme' } as Organization, {
    roster: async () => fresh, resolve: async () => reviewer, prepare: async () => ({}), borrow: () => null,
    available: () => true, capacity: () => 3, permitted: () => true, note: () => 'original seed instructions', severity: () => 'p2',
    received: () => {}, reviews: async () => '', existing: async () => new Set(), wake: () => {},
  })
  const observe = async (chain: BehaviorChain) => chain.issue === source.issue
    ? { ...fresh, checkedAt: Date.now() } : { ...reportObservation, checkedAt: Date.now() }
  const recoverReport = (chain: BehaviorChain, obs: ChainObservation) => recoverReportedRepair(db, journal, chain, obs, observe, () => true)
  const launch = vi.fn(async () => true)
  const ops = operations(db, journal, { discover: async () => [], observe, recoverReport, available: () => true,
    permitted: (chain, decision) => !repairReportImplementationFence(db, chain, decision.behavior), request: native.request, launch })
  return { db, journal, source, diagnostic, reportObservation, ops, launch }
}

it.each([true, false])('requires an actionable native review diagnosis for a report with no implementation: %s', async actionable => {
  const { journal, source, ops, launch } = await diagnosedRepair(':memory:', actionable ? undefined : 'Review completed; inspect the source.', true)
  await new BehaviorChainRuntime(journal, ops).run()
  expect(launch).toHaveBeenCalledTimes(actionable ? 1 : 0)
  expect(journal.read(source.id)!.invocations).toHaveLength(actionable ? 4 : 3)
  expect(journal.read('acme/repo#99')!.invocations).toHaveLength(1)
  expect(journal.read('acme/repo#99')!.waiting).toContain('ordinary report implementation is fenced')
})

it('recovers a failed report review after its verified diagnosis to admit the source repair', async () => {
  const { db, journal } = setup()
  let source = exhausted(journal, BUDGET_ERRORS, 7, 21, BUDGET_CODE, true)
  fresh = observation()
  fresh.pull!.conflict = true
  source = record(journal, source, { type: 'chain.observed', observation: { ...fresh, checkedAt: NOW - 120_000 } })
  await operations(db, journal).reportHold!(source)
  let diagnostic = journal.append('acme/repo#99', 'diagnostic-seed', 0, { type: 'chain.admitted', repository: source.repository,
    issue: 99, branch: 'poise/issue-99', author: source.author, reviewer: source.reviewer }, NOW - 60_000)
  const reportObservation = unpublished()
  const callId = 'd'.repeat(32)
  const text = (`TS2352 at tests/behavior-chain-action-recovery.test.ts:397: context_sha is missing. PR #21 head ${HEAD}. `
    + 'Retain context_sha in the typed response when adding coverage; the faulty test exists only on the source PR branch.')
  priorComments = [{ id: 123, author: source.reviewer, body: `${text}\n<!-- agent-interface issue-review call=${callId} -->` }]
  reportObservation.issue.commentIds = [123]
  reportObservation.reviewPublication = { callId, complete: true, issueRevision: reportObservation.issue.revision,
    receipts: [{ issue: diagnostic.id, comment_id: 123, author: source.reviewer, url: null }] }
  diagnostic = record(journal, diagnostic, { type: 'chain.observed', observation: { ...reportObservation, checkedAt: NOW - 600_000 } })
  diagnostic = record(journal, diagnostic, { type: 'invocation.admitted', invocation: {
    id: 'diagnosis', behavior: 'review-issue', basis: chainBasis(['issue', reportObservation.issue.revision]),
    actor: source.reviewer, model: reviewer.model, slot: reviewer.slot, admittedAt: NOW - 60_000,
    request: { command: 'agent-interface', cwd: '/fixture', argv: ['--issue-review', diagnostic.id,
      '--expected-issue-revision', reportObservation.issue.revision] } } })
  diagnostic = record(journal, diagnostic, { type: 'invocation.reconciled', invocationId: 'diagnosis', evidence: {
    status: 'failed', action: 'not_started', outcome: 'preflight_failed', error: 'native failure', callId,
    artifact: { phase: 'posting_issue_reviews', plan_sha: 'e'.repeat(64) },
    resources_settled_at: new Date(NOW - 20_000).toISOString(), resource_ownership: { version: 1, roots: [], errors: [] },
    completedAt: NOW - 30_000 } })
  diagnostic = record(journal, diagnostic, { type: 'invocation.uncertain', invocationId: 'diagnosis',
    reason: 'native publication may have happened; reconcile the original invocation against GitHub' })
  const native = nativeChainOperations({ login: 'acme' } as Organization, {
    roster: async () => fresh, resolve: async () => reviewer, prepare: async () => ({}), borrow: () => null,
    available: () => true, capacity: () => 3, permitted: () => true, note: () => 'original seed instructions', severity: () => 'p2',
    received: () => {}, reviews: async () => '', existing: async () => new Set(), wake: () => {},
  })
  const observe = async (chain: BehaviorChain) => chain.issue === source.issue
    ? { ...fresh, checkedAt: Date.now() } : { ...reportObservation, checkedAt: Date.now() }
  const recoverReport = (chain: BehaviorChain, obs: ChainObservation) => recoverReportedRepair(db, journal, chain, obs, observe, () => true)
  const launch = vi.fn(async () => true)
  const ops = operations(db, journal, { discover: async () => [], observe, recoverReport, available: () => true,
    permitted: (chain, decision) => !repairReportImplementationFence(db, chain, decision.behavior), request: native.request, launch })
  const runtime = new BehaviorChainRuntime(journal, ops)
  await runtime.run()
  expect(journal.read(diagnostic.id)!.invocations[0]).toMatchObject({ state: 'settled', callId,
    evidence: { status: 'completed', action: 'commented' } })
  await runtime.run()
  const current = journal.read(source.id)!
  expect(launch).toHaveBeenCalledTimes(1)
  expect(current.invocations).toHaveLength(4)
  expect(current.repairRecovery).toMatchObject({ report: 99, head: HEAD })
  expect(journal.read(diagnostic.id)!.waiting).toContain('ordinary report implementation is fenced')
})

it('hands the #1669 branch-only diagnosis to the original exact-head repair, then retains normal review and CI gates', async () => {
  const { db, journal, source, diagnostic, ops, launch } = await diagnosedRepair()
  const originals = source.invocations
  await new BehaviorChainRuntime(journal, ops).run()
  let current = journal.read(source.id)!
  const repair = current.invocations.at(-1)!
  expect(launch).toHaveBeenCalledTimes(1)
  expect(current).toMatchObject({ branch: source.branch, issue: source.issue, held: null, resumedAfterSequence: source.resumedAfterSequence,
    repairRecovery: { report: 99, head: HEAD, basis: originals[0].basis, admission: repair.id } })
  expect(current.invocations.slice(0, 3)).toEqual(originals)
  expect(repair).toMatchObject({ behavior: 'repair-pr', state: 'started', basis: originals[0].basis,
    request: { context: { head: HEAD, reviewRevision: fresh.pull!.reviewRevision } } })
  const argv = repair.request.argv
  expect(argv[argv.indexOf('--atomic-work') + 1]).toBe(source.id)
  expect(argv[argv.indexOf('--branch') + 1]).toBe(source.branch)
  expect(argv[argv.indexOf('--pull-number') + 1]).toBe('21')
  expect(argv[argv.indexOf('--expected-head') + 1]).toBe(HEAD)
  expect(argv).toContain('--merge-base')
  const note = argv[argv.indexOf('--note') + 1]
  for (const expected of ['original seed instructions', '/issues/99', 'd'.repeat(32), 'context_sha',
    'tests/behavior-chain-action-recovery.test.ts:397', 'only on the source PR branch', 'preserve the incomplete-coverage assertion']) expect(note).toContain(expected)
  expect(journal.read(diagnostic.id)!.invocations).toEqual(diagnostic.invocations)
  expect(journal.read(diagnostic.id)!.waiting).toContain('ordinary report implementation is fenced')
  const nextHead = 'c'.repeat(40)
  current = record(journal, current, { type: 'invocation.settled', invocationId: repair.id, callId: 'e'.repeat(32), outcome: 'published',
    evidence: { status: 'completed', action: 'published', head_sha: nextHead, completedAt: NOW,
      resources_settled_at: new Date(NOW).toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } } })
  const next = observation()
  Object.assign(next.pull!, { head: nextHead, changesRequested: false, unresolved: 0, pending: true })
  next.publication.head_sha = nextHead; next.publication.head_invocation = 'e'.repeat(32)
  next.prReviewers = [reviewer]
  expect(decideBehaviorChain(current, next, NOW)).toMatchObject({ kind: 'invoke', behavior: 'review-pr' })
  const call = completedReviewCall(source.repository, 21, nextHead, source.reviewer)
  const response = call.artifact!.review_response as { context_sha: string }
  next.pull!.reviewContext = response.context_sha
  const decision = decideBehaviorChain(current, next, NOW)
  if (decision.kind !== 'invoke') throw new Error('Repaired head must require its native review')
  current = record(journal, current, { type: 'invocation.admitted', invocation: { id: 'repaired-review', behavior: 'review-pr',
    actor: source.reviewer, basis: decision.basis, slot: reviewer.slot, model: reviewer.model, admittedAt: Date.parse(call.started_at),
    request: { command: 'agent-interface', cwd: '/fixture', argv: [] } } })
  current = record(journal, current, { type: 'invocation.settled', invocationId: 'repaired-review', callId: call.id, outcome: 'clean',
    evidence: { status: 'completed', action: call.action, head_sha: nextHead, review_id: call.review_id,
      completedAt: Date.parse(call.completed_at!), artifact: call.artifact,
      resources_settled_at: new Date(NOW).toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } } })
  next.pull!.reviewIds = [call.review_id!]
  next.pull!.reviewReceipts = [{ id: call.review_id!, head: nextHead, state: 'COMMENTED', invocation: call.id,
    response: call.artifact!.review_response, submittedAt: Date.parse(call.completed_at!) }]
  expect(decideBehaviorChain(current, next, NOW)).toMatchObject({ kind: 'wait', reason: 'exact-head CI is still running' })
  Object.assign(next.pull!, { pending: false, approved: true, ready: true })
  expect(decideBehaviorChain(current, next, NOW)).toMatchObject({ kind: 'invoke', behavior: 'merge-pr' })
  expect(posts()).toHaveLength(1)
  expect(reports(db)).toHaveLength(1)
})

it.each(['head', 'diagnosis', 'operator hold'] as const)('rechecks the %s after provider preparation before consuming a report recovery', async boundary => {
  const { journal, source, ops, launch } = await diagnosedRepair()
  const request = ops.request
  ops.request = async (...args) => {
    const result = await request(...args)
    if (boundary === 'head') { fresh.pull!.head = 'c'.repeat(40); fresh.publication.head_sha = fresh.pull!.head }
    else if (boundary === 'diagnosis') priorComments[0].body = 'A changed diagnosis requires another decision.'
    else record(journal, journal.read(source.id)!, { type: 'chain.held', reason: 'operator stop' })
    return result
  }
  await new BehaviorChainRuntime(journal, ops).run()
  const current = journal.read(source.id)!
  expect(current.repairRecovery).toBeDefined()
  expect(current.repairRecovery!.admission).toBeUndefined()
  expect(current.invocations).toHaveLength(3)
  expect(current.waiting).toContain('Repair report recovery pending')
  if (boundary === 'operator hold') expect(current.held).toBe('operator stop')
  expect(launch).not.toHaveBeenCalled()
})

it.each(['missing diagnosis', 'changed head', 'changed basis', 'operator hold', 'report publication', 'report resources'] as const)(
  'retains an actionable source hold for %s', async boundary => {
    const { db, journal, source, diagnostic, reportObservation, ops, launch } = await diagnosedRepair(':memory:',
      boundary === 'missing diagnosis' ? 'No actionable diagnosis is available' : undefined)
    if (boundary === 'missing diagnosis') {
      expect(repairReportImplementationFence(db, diagnostic, 'implement-issue')).toContain('ordinary report implementation is fenced')
    } else if (boundary === 'changed head') { fresh.pull!.head = 'c'.repeat(40); fresh.publication.head_sha = fresh.pull!.head }
    else if (boundary === 'changed basis') fresh.pull!.reviewRevision = chainBasis('changed findings')
    else if (boundary === 'operator hold') record(journal, source, { type: 'chain.held', reason: 'operator stop' })
    else if (boundary === 'report publication') reportObservation.publication.head_sha = 'b'.repeat(40)
    else {
      // The original physical proof cannot be inferred from GitHub absence.
      record(journal, diagnostic, { type: 'chain.resumed' })
      const id = 'pending-original'
      record(journal, journal.read(diagnostic.id)!, { type: 'invocation.admitted', invocation: { id, behavior: 'implement-issue',
        basis: 'diagnostic', actor: source.author, model: reviewer.model, slot: reviewer.slot, admittedAt: NOW,
        request: { command: 'agent-interface', cwd: '/fixture', argv: ['--atomic-work', diagnostic.id, '--model', reviewer.model] } } })
    }
    await new BehaviorChainRuntime(journal, ops).run()
    expect(journal.read(source.id)!.held).toBe(boundary === 'operator hold' ? 'operator stop' : source.held)
    expect(journal.read(source.id)!.waiting).toContain('Repair report recovery pending')
    expect(journal.read(source.id)!.repairRecovery).toBeUndefined()
    expect(launch).not.toHaveBeenCalled()
  })

it('does not replenish a failed report recovery after journal rebuild or repeated report observations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'report-recovery-')); roots.push(root)
  const { db, journal, source, ops, launch } = await diagnosedRepair(join(root, 'journal.sqlite'))
  await new BehaviorChainRuntime(journal, ops).run()
  let current = journal.read(source.id)!
  const recovery = current.invocations.at(-1)!
  current = record(journal, current, { type: 'invocation.settled', invocationId: recovery.id, callId: 'f'.repeat(32), outcome: 'preflight_failed',
    evidence: { status: 'failed', action: 'not_started', outcome: 'preflight_failed', error_code: BUDGET_CODE, error: BUDGET_ERRORS[0],
      completedAt: NOW, resources_settled_at: new Date(NOW).toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } } })
  db.prepare('DELETE FROM behavior_chain_current').run()
  const restarted = new BehaviorChainJournal(db); restarted.rebuild()
  const resumedOps = { ...ops, recoverReport: (chain: BehaviorChain, obs: ChainObservation) => recoverReportedRepair(db, restarted,
    chain, obs, ops.observe, () => true) }
  const runtime = new BehaviorChainRuntime(restarted, resumedOps)
  for (let pass = 0; pass < 3; pass++) { vi.setSystemTime(NOW + (pass + 1) * 600_000); await runtime.run() }
  expect(launch).toHaveBeenCalledTimes(1)
  expect(restarted.read(source.id)).toMatchObject({ invocations: current.invocations,
    repairRecovery: { admission: recovery.id }, held: expect.stringContaining('single repair after report diagnosis failed') })
  expect(posts()).toHaveLength(1)
})

it('requires an exact pull URL match for a repair diagnosis', async () => {
  const textFor = (pull: number) => (`TS2352 at tests/behavior-chain-action-recovery.test.ts:397: context_sha is missing. `
    + `See https://github.com/acme/repo/pull/${pull} head ${HEAD}. Retain context_sha; the faulty test exists only on the source PR branch.`)
  const exact = await diagnosedRepair(':memory:', textFor(21))
  await new BehaviorChainRuntime(exact.journal, exact.ops).run()
  expect(exact.launch).toHaveBeenCalledTimes(1)
  expect(exact.journal.read(exact.source.id)!.repairRecovery).toMatchObject({ report: 99, head: HEAD })
  const longer = await diagnosedRepair(':memory:', textFor(210))
  await new BehaviorChainRuntime(longer.journal, longer.ops).run()
  expect(longer.launch).not.toHaveBeenCalled()
  expect(longer.journal.read(longer.source.id)!.held).toBe(longer.source.held)
  expect(longer.journal.read(longer.source.id)!.repairRecovery).toBeUndefined()
  expect(longer.journal.read(longer.source.id)!.waiting).toContain('Repair report recovery pending')
})

it('lets a merged source reach merged reconciliation instead of recovery pending', async () => {
  const { journal, source, ops, launch } = await diagnosedRepair()
  const MERGE = 'b'.repeat(40)
  Object.assign(fresh.pull!, { state: 'closed', merged: true, mergeSha: MERGE, mergedAt: NOW })
  Object.assign(fresh.publication, { state: 'closed', merged: true, merge_sha: MERGE })
  await new BehaviorChainRuntime(journal, ops).run()
  const current = journal.read(source.id)!
  expect(current.mergeSha).toBe(MERGE)
  expect(current.reviewPending).toBe(true)
  expect(current.waiting).not.toContain('Repair report recovery pending')
  expect(current.repairRecovery).toBeUndefined()
  expect(launch).not.toHaveBeenCalled()
})

it('routes an open seed past its only closed unmerged PR through ordinary continuation intake', async () => {
  const { db, journal } = setup()
  const source = openSeed(journal)
  fresh = closedObservation()
  const runtime = new BehaviorChainRuntime(journal, operations(db, journal, {
    observe: async chain => chain.issue === 7 ? { ...fresh, checkedAt: Date.now() } : { ...observation(), pull: null },
  }))
  await runtime.run()
  expect(posts()).toHaveLength(1)
  expect(remote[0]).toMatchObject({ title: 'fix: continue #7 after closed unmerged PR #21', labels: [{ name: 'poise' }] })
  for (const text of ['https://github.com/acme/repo/issues/7', 'https://github.com/acme/repo/pull/21',
    'Cause: pull_closed_unmerged', 'Next action: implement the remaining source issue work', REMEDIATION_SCOPE]) {
    expect(remote[0].body).toContain(text)
  }
  expect(remote[0].body).toContain(`<!-- poise-repair-exhaustion:${chainBasis(['pull_closed_unmerged', source.id, 21])} -->`)
  expect(journal.read(source.id)).toMatchObject({ held: 'pull request closed without a confirmed merge',
    invocations: [], resumedAfterSequence: 0, waiting: expect.stringContaining('/issues/99') })
  indexed = true
  vi.setSystemTime(NOW + 86_400_000)
  await runtime.run()
  expect(journal.read('acme/repo#99')).not.toBeNull()
  expect(journal.read(source.id)?.waiting).toContain('admitted as acme/repo#99')
  journal.rebuild()
  await runtime.run()
  expect(posts()).toHaveLength(1)
  expect(reports(db)).toHaveLength(1)
})

it.each(['source body', 'source comment', 'PR body', 'PR comment'])('verifies an explicit successor in the %s before creating intent', async location => {
  const { db, journal } = setup()
  const source = openSeed(journal)
  fresh = closedObservation()
  const declaration = 'Work moved to #44'
  if (location === 'source body') seedBody = declaration
  if (location === 'source comment') sourceComments = [{ author: 'author',
    body: 'Continued in #44. The prior attempt was #21 and original receipt evidence remains in #1042.' }]
  if (location === 'PR body') priorBody += '\n' + declaration
  if (location === 'PR comment') priorComments = [{ author: 'reviewer', body: declaration }]
  remote = [{ ...issue(44, 'Continue #7 after https://github.com/acme/repo/pull/21'), labels: [{ name: 'poise' }] }]
  for (let pass = 0; pass < 2; pass++) {
    await new BehaviorChainRuntime(journal, operations(db, journal, { observe: async () => fresh })).run()
    journal.rebuild()
    vi.setSystemTime(Date.now() + 86_400_000); fresh.checkedAt = Date.now()
  }
  expect(journal.read(source.id)?.waiting).toContain('https://github.com/acme/repo/issues/44: already tracks')
  expect(posts()).toHaveLength(0)
  expect(reports(db)).toHaveLength(0)
})

it.each(['Work continued today. No successor yet.', 'Work continued to fail. No successor yet.',
  'Work continued to fail on #7. No successor yet.', 'Work continued to fail after #21. No successor yet.'])(
  'ignores ordinary continuation-like words without a successor reference: %s', async body => {
    const { db, journal } = setup()
    openSeed(journal)
    fresh = closedObservation()
    seedBody = body
    await new BehaviorChainRuntime(journal, operations(db, journal, { observe: async () => fresh })).run()
    expect(posts()).toHaveLength(1)
    expect(remote[0]).toMatchObject({ title: 'fix: continue #7 after closed unmerged PR #21' })
    expect(reports(db)).toHaveLength(1)
  })

it('verifies a Markdown successor link without counting it twice', async () => {
  const { db, journal } = setup()
  const source = openSeed(journal)
  fresh = closedObservation()
  seedBody = 'Continuation: [#44](https://github.com/acme/repo/issues/44)'
  remote = [{ ...issue(44, 'Continue #7 after https://github.com/acme/repo/pull/21'), labels: [{ name: 'poise' }] }]
  await new BehaviorChainRuntime(journal, operations(db, journal, { observe: async () => fresh })).run()
  expect(journal.read(source.id)?.waiting).toContain('https://github.com/acme/repo/issues/44: already tracks')
  expect(posts()).toHaveLength(0)
  expect(reports(db)).toHaveLength(0)
})

it('verifies an explicit successor after ordinary prose on the same line', async () => {
  const { db, journal } = setup()
  const source = openSeed(journal)
  fresh = closedObservation()
  seedBody = 'Work continued to fail. Continuation: #44'
  remote = [{ ...issue(44, 'Continue #7 after https://github.com/acme/repo/pull/21'), labels: [{ name: 'poise' }] }]
  await new BehaviorChainRuntime(journal, operations(db, journal, { observe: async () => fresh })).run()
  expect(journal.read(source.id)?.waiting).toContain('https://github.com/acme/repo/issues/44: already tracks')
  expect(posts()).toHaveLength(0)
  expect(reports(db)).toHaveLength(0)
})

it('creates a closed-PR continuation past a historical receipt_unavailable settlement', async () => {
  const { db, journal } = setup()
  let source = openSeed(journal)
  source = record(journal, source, { type: 'invocation.admitted', invocation: { id: 'receipt-blocked', behavior: 'implement-issue',
    basis: 'original', actor: 'author', slot: 'primary', model: 'fixture', admittedAt: NOW - 500_000,
    request: { command: 'github-interface', cwd: '/fixture', argv: ['--read-issue', '7'] } } })
  source = record(journal, source, { type: 'invocation.settled', invocationId: 'receipt-blocked', callId: null,
    outcome: 'receipt_unavailable', evidence: { status: 'deferred', action: 'not_started', outcome: 'receipt_unavailable',
      error: 'CallerReceiptStoreError: could not reserve the command safely', completedAt: NOW - 400_000 } })
  source = record(journal, source, { type: 'invocation.admitted', invocation: { id: 'later', behavior: 'implement-issue',
    basis: 'original', actor: 'author', slot: 'primary', model: 'fixture', admittedAt: NOW - 300_000,
    request: { command: 'agent-interface', cwd: '/fixture', argv: ['--atomic-work', source.id] } } })
  record(journal, source, { type: 'invocation.settled', invocationId: 'later', callId: chainBasis('later').slice(0, 32),
    outcome: 'preflight_failed', evidence: { status: 'failed', action: 'not_started', outcome: 'preflight_failed',
      error: 'native failure', completedAt: NOW - 200_000, resources_settled_at: new Date(NOW - 100_000).toISOString(),
      resource_ownership: { version: 1, roots: [], errors: [] } } })
  fresh = closedObservation()
  await new BehaviorChainRuntime(journal, operations(db, journal, { observe: async () => fresh })).run()
  expect(posts()).toHaveLength(1)
  expect(remote[0]).toMatchObject({ title: 'fix: continue #7 after closed unmerged PR #21' })
  expect(reports(db)).toHaveLength(1)
})

it.each(['wrong coverage', 'ambiguous', 'unavailable', 'closed successor', 'missing label'])(
  'keeps an unverified successor pending: %s', async change => {
    const { db, journal } = setup()
    const source = openSeed(journal)
    fresh = closedObservation(); seedBody = 'Continuation: #44'
    remote = [{ ...issue(44, 'Continue #7 after #21'), labels: [{ name: 'poise' }] }]
    if (change === 'wrong coverage') remote[0].body = 'Original outcome evidence for #7; see #1042'
    if (change === 'ambiguous') seedBody += ' or #45'
    if (change === 'unavailable') remote = []
    if (change === 'closed successor') remote[0].state = 'closed'
    if (change === 'missing label') remote[0].labels = []
    await new BehaviorChainRuntime(journal, operations(db, journal, { observe: async () => fresh })).run()
    expect(journal.read(source.id)?.waiting).toMatch(/pending|no replacement will be created/)
    expect(posts()).toHaveLength(0)
    expect(reports(db)).toHaveLength(0)
  })

it.each(['merged', 'closed seed', 'replacement PR', 'unlabeled seed', 'stale observation', 'unavailable observation'])(
  'does not create a continuation after fresh verification finds %s', async change => {
    const { db, journal } = setup()
    openSeed(journal)
    fresh = closedObservation()
    if (change === 'merged') Object.assign(fresh.pull!, { merged: true, mergeSha: 'b'.repeat(40) })
    if (change === 'closed seed') seedState = 'closed'
    if (change === 'replacement PR') fresh.existingPulls = ['https://github.com/acme/repo/pull/22']
    if (change === 'unlabeled seed') seedLabels = []
    if (change === 'stale observation') fresh.checkedAt = NOW - 120_001
    const verify = async () => { if (change === 'unavailable observation') throw new Error('GitHub evidence unavailable'); return fresh }
    await new BehaviorChainRuntime(journal, operations(db, journal, { observe: async () => closedObservation(),
      reportHold: chain => reportRepairExhaustion(db, journal, chain, verify, () => true) })).run()
    expect(posts()).toHaveLength(0)
    expect(reports(db)).toHaveLength(0)
  })

it.each(['missing', 'unreadable'])('retains the original invocation, hold and reservation with %s receipts through runtime recovery', async mode => {
  const { db, journal } = setup()
  let source = openSeed(journal)
  source = record(journal, source, { type: 'chain.observed', observation: closedObservation() })
  source = record(journal, source, { type: 'invocation.admitted', invocation: { id: 'original', behavior: 'implement-issue',
    basis: 'original', actor: 'author', slot: 'primary', model: 'fixture', admittedAt: NOW - 60_000,
    reservation: { memoryBytes: 8, diskBytes: 16 }, request: { command: 'agent-interface', cwd: '/fixture', argv: ['--atomic-work', source.id] } } })
  source = record(journal, source, { type: 'invocation.started', invocationId: 'original' })
  source = record(journal, source, { type: 'chain.held', reason: 'original outcome is unknown; reconcile its receipt' })
  seedBody = 'Original uncertain receipt evidence remains in #1042.'
  const forbidden = vi.fn(async () => { throw new Error('must not replay, publish or release original resources') })
  const ops = operations(db, journal, { observe: async () => closedObservation(), request: forbidden, launch: forbidden,
    perform: forbidden, resumePublication: forbidden, fenceClosedTarget: forbidden })
  if (mode === 'unreadable') {
    ops.readInvocations = async () => { throw new Error('original receipt is unreadable') }
    await expect(new BehaviorChainRuntime(journal, ops).run()).rejects.toThrow('original receipt is unreadable')
    ops.readInvocations = async () => ({ entries: [], quarantined: [] })
  }
  for (let pass = 0; pass < 2; pass++) {
    journal.rebuild()
    await new BehaviorChainRuntime(journal, ops).run()
    expect(journal.read(source.id)).toMatchObject({ held: source.held, resumedAfterSequence: 0,
      invocations: [{ id: 'original', state: 'uncertain', callId: null, reservation: { memoryBytes: 8, diskBytes: 16 } }] })
    expect(journal.reservedResources()).toEqual({ memoryBytes: 8, diskBytes: 16, unaccounted: 0 })
  }
  expect(posts()).toHaveLength(0)
  expect(reports(db)).toHaveLength(0)
  expect(forbidden).not.toHaveBeenCalled()
})

it('keeps a verified report under another cause when its source PR closes unmerged', async () => {
  const { db, journal } = setup()
  const source = exhausted(journal)
  await new BehaviorChainRuntime(journal, operations(db, journal)).run()
  const original = reports(db)
  fresh = closedObservation()
  vi.setSystemTime(NOW + 86_400_000); fresh.checkedAt = Date.now()
  journal.rebuild()
  await new BehaviorChainRuntime(journal, operations(db, journal, { observe: async () => fresh })).run()
  expect(journal.read(source.id)?.waiting).toContain('https://github.com/acme/repo/issues/99')
  expect(reports(db)).toEqual(original)
  expect(posts()).toHaveLength(1)
})

it('keeps a legacy PR-scoped report when its source PR closes unmerged under a v2 chain', async () => {
  const { db, journal } = setup()
  const source = record(journal, await exhaustedReviews(journal), { type: 'chain.observed', observation: fresh })
  await operations(db, journal).reportHold!(source)
  expect(posts()).toHaveLength(1)
  // The stored report predates the v2 chain: PR-scoped legacy source.
  const stored = reports(db)[0]
  const report = JSON.parse(stored.value)
  db.prepare('DELETE FROM meta WHERE key = ?').run(`behavior_chain_repair_report:${report.key}`)
  report.source = 'acme/repo#21'
  report.key = chainBasis(['review_budget_exhausted', report.source, 21])
  remote[0].body = remote[0].body.replace(/<!-- poise-repair-exhaustion:[a-f0-9]{64} -->/,
    `<!-- poise-repair-exhaustion:${report.key} -->`)
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run(`behavior_chain_repair_report:${report.key}`, JSON.stringify(report))
  fresh = closedObservation()
  vi.setSystemTime(NOW + 86_400_000); fresh.checkedAt = Date.now()
  journal.rebuild()
  await new BehaviorChainRuntime(journal, operations(db, journal, { observe: async () => fresh })).run()
  expect(posts()).toHaveLength(1)
  expect(reports(db)).toHaveLength(1)
})

it.each(['available', 'unavailable', 'expired', 'missing'])('reports private failed source availability through the original remediation (%s)', async status => {
  const { db, journal } = setup()
  const { call } = blockedImplementation(journal)
  const receipt = status === 'unavailable'
    ? { status, candidate: 'c'.repeat(64), run: 'd'.repeat(32), reason: 'capture could not be bound or safely retained within the source limit' }
    : { status: 'available', candidate: 'c'.repeat(64), run: 'd'.repeat(32), base: HEAD, bytes: 512,
      sha256: 'e'.repeat(64), expires_at: Math.floor(NOW / 1000) + (status === 'expired' ? -1 : 3600) }
  if (status !== 'missing') call.artifact!.failed_source = receipt
  const runtime = new BehaviorChainRuntime(journal, operations(db, journal, {
    observe: async () => ({ ...fresh, checkedAt: Date.now() }), readInvocations: async () => ({ entries: [call], quarantined: [] }),
  }))
  await runtime.run()
  expect(posts()).toHaveLength(1)
  expect(remote[0].body).toContain('worker-reported explanation is not independently verified')
  if (status === 'available') {
    expect(remote[0].body).toContain(`agent-interface --read-failed-source ${call.id} ${receipt.candidate} ${receipt.run}`)
    expect(remote[0].body).toContain('earlier failed capture, not any later untested edit')
    expect(remote[0].body).toContain('no publication, retry or approval authority')
  } else expect(remote[0].body).toContain('source changes are unavailable; start with a fresh reproduction')
  expect(remote[0].body).not.toMatch(/\/private\/work|"content"|"changes"/)
})

it('validates failed source metadata at the Caller receipt boundary before reports consume it', () => {
  const valid = { status: 'available', candidate: 'c'.repeat(64), run: 'd'.repeat(32), base: HEAD,
    bytes: 512, sha256: 'e'.repeat(64), expires_at: Math.floor(NOW / 1000) + 3600 }
  expect(parseFailedSource(valid)).toEqual(valid)
  const { journal } = setup()
  const { call } = blockedImplementation(journal)
  call.artifact!.failed_source = valid
  expect(parseAgentLogRow(call, 0)).toHaveProperty('entry')
  for (const invalid of [null, [], { ...valid, candidate: HEAD }, { ...valid, bytes: 2 * 1024 * 1024 + 1 },
    { ...valid, changes: [{ content: 'private source' }] }, { ...valid, status: 'unavailable' }]) {
    expect(() => parseFailedSource(invalid)).toThrow(/failed source/)
    call.artifact!.failed_source = invalid
    expect(parseAgentLogRow(call, 0)).toHaveProperty('quarantined')
  }
})

it.each([false, true])('reports one verified implementation hold before a PR without relaunching it (diagnostic=%s)', async diagnostic => {
  const { db, journal } = setup()
  const { chain, call } = blockedImplementation(journal)
  vi.stubEnv('FIXTURE_ACCESS_TOKEN', 'fixture-private-credential')
  call.error += ' ghp_secretfixture fixture-private-credential ' + 'detail '.repeat(100)
  if (diagnostic) call.diagnostic = { version: 1, source: 'caller', severity: 'error', operation: 'provider.atomic_work',
    phase: 'validating', outcome: 'blocked', stderr: '/private/work raw provider output', stderr_truncated: false,
    context: { message: call.error, submission: 'none', exit_code: null, signal: null, errno: null }, filesystem: null }
  const launch = vi.fn(async () => { throw new Error('must not relaunch implementation') })
  const overrides = { launch, observe: async () => ({ ...fresh, checkedAt: Date.now() }),
    readInvocations: async () => ({ entries: [call], quarantined: [] }) }
  const runtime = new BehaviorChainRuntime(journal, operations(db, journal, overrides))
  await runtime.run()
  expect(posts()).toHaveLength(1)
  expect(remote[0]).toMatchObject({ title: 'fix: blocked implementation for #7', labels: [{ name: 'poise' }] })
  const marker = `<!-- poise-repair-exhaustion:${chainBasis(['atomic_work_blocked', chain.id])} -->`
  for (const fact of [marker, 'https://github.com/acme/repo/issues/7', 'Stage: implement-issue. Cause: atomic_work_blocked.',
    '(0 minutes at reporting)', `Source: ${chain.id}; hold event`, `basis ${chain.invocations[0].basis}; slot primary`,
    'status=failed; action=not_started; outcome=preflight_failed', `Caller ${call.id}`, `Invocation ${call.correlation_id}`,
    call.resources_settled_at!, 'Worker-reported blocker: atomic behavior blocked: Caller health validation failed; test relay unavailable',
    'worker-reported explanation is not independently verified', 'Next action:', 'explicitly Resume the source chain']) {
    expect(remote[0].body).toContain(fact)
  }
  expect(remote[0].body).toContain(diagnostic ? '"submission":"none"' : 'not recorded in this historical Call receipt')
  expect(remote[0].body).not.toMatch(/ghp_secretfixture|fixture-private-credential|\/private\/work|raw provider output/)
  expect(remote[0].body).toContain('[redacted]')
  expect(remote[0].body.split('\n').find(line => line.startsWith('Worker-reported blocker: '))!.length)
    .toBeLessThanOrEqual('Worker-reported blocker: '.length + 500)
  expect(remote[0].body.split(REMEDIATION_SCOPE)).toHaveLength(2)
  expect(remote[0].body.endsWith('Include this exact paragraph in the linked PR review.')).toBe(true)
  const current = journal.read(chain.id)!
  const work = behaviorChainWorkImpact(journal, call.id, call.correlation_id!)!
  expect(work.impact).toBe('blocked')
  for (const fact of [`Work impact snapshot as of ${new Date(NOW).toISOString()} (at filing; not live status).`,
    `Current impact: ${work.impact}. Work target: ${work.target}. Work stage: ${work.stage}.`,
    `Last verified progress: ${new Date(work.progressAt).toISOString()}.`, work.journal]) expect(remote[0].body).toContain(fact)
  const filedBody = remote[0].body
  expect(current).toMatchObject({ held: call.error, author: chain.author, reviewer: chain.reviewer, branch: chain.branch,
    resumedAfterSequence: 0, mergeSha: null, waiting: expect.stringContaining('admission pending normal datastore intake'),
    invocations: [{ id: call.correlation_id, state: 'settled', callId: call.id }] })
  expect(reports(db).map(row => JSON.parse(row.value))).toMatchObject([{ source: chain.id, pull: null, head: null,
    attempts: [{ invocation: call.correlation_id, call: call.id }], issueNumber: 99 }])
  journal.rebuild()
  vi.setSystemTime(Date.now() + 86_400_000)
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  await runtime.run()
  expect(posts()).toHaveLength(1)
  expect(journal.read(chain.id)).toMatchObject({ held: current.held, invocations: current.invocations })
  const intent = reports(db)[0]
  record(journal, journal.read(chain.id)!, { type: 'chain.resumed' })
  const next = blockedImplementation(journal)
  next.call.error = 'atomic behavior blocked: a different worker explanation on a later receipt'
  await new BehaviorChainRuntime(journal, operations(db, journal, { ...overrides,
    readInvocations: async () => ({ entries: [next.call], quarantined: [] }) })).run()
  expect(next.call.id).not.toBe(call.id)
  expect(journal.read(chain.id)?.held).toBe(next.call.error)
  expect(reports(db)).toEqual([intent])
  expect(posts()).toHaveLength(1)
  expect(launch).not.toHaveBeenCalled()
  // Later verified progress changes the live projection, never the filed snapshot.
  let recovered = record(journal, journal.read(chain.id)!, { type: 'chain.resumed' })
  fresh = observation()
  recovered = journal.append(recovered.id, 'verified-publication', recovered.sequence,
    { type: 'chain.observed', observation: fresh }, Date.now())
  expect(behaviorChainWorkImpact(journal, call.id, call.correlation_id!)?.impact).toBe('recovered')
  await reportRepairExhaustion(db, journal, recovered, async () => fresh, () => true)
  expect(remote[0].body).toBe(filedBody)
  expect(posts()).toHaveLength(1)
})

async function reviewedImplementationReport(db: Database.Database, journal: BehaviorChainJournal, prepare?: (call: LogEntry) => void) {
  const { call } = blockedImplementation(journal)
  prepare?.(call)
  let entries = [call]
  const observe = async (chain: BehaviorChain) => chain.issue === 7 ? { ...fresh, checkedAt: Date.now() } : {
    ...unpublished(), issue: { open: true, eligible: true, revision: chainBasis([remote[0].title, remote[0].body]), commentIds: [700] },
    issueReviewers: [reviewer], prerequisites: { wait: null, base: HEAD, evidence: [] } }
  const request = vi.fn(async (chain: BehaviorChain, observation: ChainObservation, decision: { behavior: string }) => ({
    command: 'agent-interface' as const, cwd: '/fixture', argv: [decision.behavior === 'review-issue' ? '--issue-review' : '--atomic-work',
      chain.id, '--model', 'fixture', '--expected-issue-revision', observation.issue.revision] }))
  const launch = vi.fn(async () => true)
  const overrides = { observe, request, launch, available: () => true, permitted: () => true,
    readInvocations: async () => ({ entries, quarantined: [] }) }
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  indexed = true
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  let report = journal.read('acme/repo#99')!
  const review = report.invocations.at(-1)!
  expect(review.behavior).toBe('review-issue')
  entries = [call, { ...call, id: 'b'.repeat(32), correlation_id: review.id, behavior: 'issue_review',
    pr_id: '99', actor: 'reviewer', status: 'completed', action: 'commented', outcome: 'commented', error: '', error_code: null,
    started_at: new Date(review.admittedAt).toISOString(), completed_at: new Date(NOW).toISOString(), resources_settled_at: new Date(NOW).toISOString(),
    issue_revision: (await observe(report)).issue.revision, artifact: null,
    receipts: [{ issue: report.id, comment_id: 700, author: 'reviewer', url: 'https://github.com/acme/repo/issues/99#issuecomment-700' }] }]
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  report = journal.read(report.id)!
  expect(report.invocations).toMatchObject([{ behavior: 'review-issue', state: 'settled', outcome: 'commented' }])
  request.mockClear(); launch.mockClear()
  return { call, overrides, request, launch, review: review.id }
}

async function reviewedReviewReport(db: Database.Database, journal: BehaviorChainJournal, legacy = false) {
  let source: BehaviorChain | null = null
  if (!legacy) {
    source = await exhaustedReviews(journal)
  } else {
    const key = chainBasis(['review_budget_exhausted', 'acme/repo#21', 21])
    const marker = `<!-- poise-repair-exhaustion:${key} -->`
    const title = 'fix: PR review exhausted its time limits for #21'
    const body = [marker, '', 'Poise is holding https://github.com/acme/repo/pull/21.', '',
      `Stage: review-new-prs. Cause: review_budget_exhausted. Held since ${new Date(NOW - 600_000).toISOString()}.`,
      `Retained legacy target: acme/repo#21; head ${HEAD}; slot primary.`,
      'Retry-stop model: fixture.', 'Retry-stop cause: two qualifying automatic same-head/model review timeouts; automatic retries stopped.',
      'Verified original Caller attempts failed before review submission. Fresh target and activity evidence still verify this hold.', '',
      `- Invocation 11111111-1111-4111-8111-111111111111; Caller ${'a'.repeat(32)}; completed ${new Date(NOW - 200_000).toISOString()}; error_code=review_budget_exhausted; operation=unknown; phase=unknown; timeout_seconds=unknown.`,
      `- Invocation 22222222-2222-4222-8222-222222222222; Caller ${'b'.repeat(32)}; completed ${new Date(NOW - 100_000).toISOString()}; error_code=review_budget_exhausted; operation=unknown; phase=unknown; timeout_seconds=unknown.`, '',
      'Next action: inspect the original Calls and timeout diagnostics, address the cause, then explicitly retry the held review when appropriate. This report preserves the source hold and PR; it does not relaunch review or relax publication, review, admission or merge gates.',
      '', REMEDIATION_SCOPE, '', 'Include this exact paragraph in the linked PR review.'].join('\n')
    remote.push({ ...issue(99, body), title, labels: [{ name: 'poise' }] })
    db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run(`behavior_chain_repair_report:${key}`, JSON.stringify({
      key, source: 'acme/repo#21', pull: 21, holdSequence: null, heldAt: NOW - 600_000, head: HEAD,
      basis: chainBasis(['review-new-prs', 'acme/repo#21', HEAD]), slot: 'primary',
      attempts: [{ invocation: '11111111-1111-4111-8111-111111111111', call: 'a'.repeat(32), completedAt: NOW - 200_000 },
        { invocation: '22222222-2222-4222-8222-222222222222', call: 'b'.repeat(32), completedAt: NOW - 100_000 }],
      issueNumber: 99 }))
    fresh = unpublished()
  }
  const observe = async (chain: BehaviorChain) => chain.issue === 7 ? { ...fresh, checkedAt: Date.now() } : {
    ...unpublished(), issue: { open: true, eligible: true, revision: chainBasis([remote[0].title, remote[0].body]), commentIds: [700] },
    issueReviewers: [reviewer], prerequisites: { wait: null, base: HEAD, evidence: [] } }
  const request = vi.fn(async (chain: BehaviorChain, observation: ChainObservation, decision: { behavior: string }) => ({
    command: 'agent-interface' as const, cwd: '/fixture', argv: [decision.behavior === 'review-issue' ? '--issue-review' : '--atomic-work',
      chain.id, '--model', 'fixture', '--expected-issue-revision', observation.issue.revision] }))
  const launch = vi.fn(async () => true)
  let entries: LogEntry[] = []
  const overrides = { observe, request, launch, available: () => true, permitted: () => true,
    readInvocations: async () => ({ entries, quarantined: [] }) }
  if (!legacy) await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  indexed = true
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  let report = journal.read('acme/repo#99')!
  const review = report.invocations.at(-1)!
  expect(review.behavior).toBe('review-issue')
  entries = [{ id: 'c'.repeat(32), correlation_id: review.id, model: reviewer.model,
    behavior: 'issue_review', source: 'poise:behavior-chain', actor: 'reviewer', repo: 'acme/repo', pr_id: '99',
    session_id: null, prompt: '', started_at: new Date(review.admittedAt).toISOString(),
    completed_at: new Date(NOW).toISOString(), time_elapsed: '1m', status: 'completed', action: 'commented',
    outcome: 'commented', error: '', error_code: null, head_sha: null, expected_head: null, response: null,
    issue_revision: (await observe(report)).issue.revision, artifact: null,
    receipts: [{ issue: report.id, comment_id: 700, author: 'reviewer', url: 'https://github.com/acme/repo/issues/99#issuecomment-700' }],
    resources_settled_at: new Date(NOW).toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } } as unknown as LogEntry]
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  report = journal.read(report.id)!
  expect(report.invocations).toMatchObject([{ behavior: 'review-issue', state: 'settled', outcome: 'commented' }])
  request.mockClear(); launch.mockClear()
  entries = []
  return { source, overrides, request, launch, review: review.id }
}

async function reviewedRepairHoldReport(db: Database.Database, journal: BehaviorChainJournal) {
  const { call } = blockedRepair(journal)
  let entries = [call]
  const observe = async (chain: BehaviorChain) => chain.issue === 7 ? { ...fresh, checkedAt: Date.now() } : {
    ...unpublished(), issue: { open: true, eligible: true, revision: chainBasis([remote[0].title, remote[0].body]), commentIds: [700] },
    issueReviewers: [reviewer], prerequisites: { wait: null, base: HEAD, evidence: [] } }
  const request = vi.fn(async (chain: BehaviorChain, observation: ChainObservation, decision: { behavior: string }) => ({
    command: 'agent-interface' as const, cwd: '/fixture', argv: [decision.behavior === 'review-issue' ? '--issue-review' : '--atomic-work',
      chain.id, '--model', 'fixture', '--expected-issue-revision', observation.issue.revision] }))
  const launch = vi.fn(async () => true)
  const overrides = { observe, request, launch, available: () => true, permitted: () => true,
    readInvocations: async () => ({ entries, quarantined: [] }) }
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  indexed = true
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  let report = journal.read('acme/repo#99')!
  const review = report.invocations.at(-1)!
  expect(review.behavior).toBe('review-issue')
  entries = [call, { ...call, id: 'b'.repeat(32), correlation_id: review.id, behavior: 'issue_review',
    pr_id: '99', actor: 'reviewer', status: 'completed', action: 'commented', outcome: 'commented', error: '', error_code: null,
    started_at: new Date(review.admittedAt).toISOString(), completed_at: new Date(NOW).toISOString(), resources_settled_at: new Date(NOW).toISOString(),
    issue_revision: (await observe(report)).issue.revision, artifact: null,
    receipts: [{ issue: report.id, comment_id: 700, author: 'reviewer', url: 'https://github.com/acme/repo/issues/99#issuecomment-700' }] }]
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  report = journal.read(report.id)!
  expect(report.invocations).toMatchObject([{ behavior: 'review-issue', state: 'settled', outcome: 'commented' }])
  request.mockClear(); launch.mockClear()
  return { call, overrides, request, launch, review: review.id }
}

async function reviewedBudgetReport(db: Database.Database, journal: BehaviorChainJournal) {
  const source = budgetImplementation(journal, 3)
  let entries: LogEntry[] = []
  const observe = async (chain: BehaviorChain) => chain.issue === 7 ? { ...fresh, checkedAt: Date.now() } : {
    ...unpublished(), issue: { open: true, eligible: true, revision: chainBasis([remote[0].title, remote[0].body]), commentIds: [700] },
    issueReviewers: [reviewer], prerequisites: { wait: null, base: HEAD, evidence: [] } }
  const request = vi.fn(async (chain: BehaviorChain, observation: ChainObservation, decision: { behavior: string }) => ({
    command: 'agent-interface' as const, cwd: '/fixture', argv: [decision.behavior === 'review-issue' ? '--issue-review' : '--atomic-work',
      chain.id, '--model', 'fixture', '--expected-issue-revision', observation.issue.revision] }))
  const launch = vi.fn(async () => true)
  const overrides = { observe, request, launch, available: () => true, permitted: () => true,
    readInvocations: async () => ({ entries, quarantined: [] }) }
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  expect(posts()).toHaveLength(1)
  indexed = true
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  let report = journal.read('acme/repo#99')!
  const review = report.invocations.at(-1)!
  expect(review.behavior).toBe('review-issue')
  entries = [{ id: 'b'.repeat(32), correlation_id: review.id, model: reviewer.model, behavior: 'issue_review',
    source: 'poise:behavior-chain', actor: 'reviewer', repo: 'acme/repo', pr_id: '99', session_id: null, prompt: '',
    started_at: new Date(review.admittedAt).toISOString(), completed_at: new Date(NOW).toISOString(), time_elapsed: '1m',
    status: 'completed', action: 'commented', outcome: 'commented', error: '', error_code: null,
    head_sha: null, expected_head: null, response: null,
    issue_revision: (await observe(report)).issue.revision, artifact: null,
    receipts: [{ issue: report.id, comment_id: 700, author: 'reviewer', url: 'https://github.com/acme/repo/issues/99#issuecomment-700' }],
    resources_settled_at: new Date(NOW).toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } }]
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  report = journal.read(report.id)!
  expect(report.invocations).toMatchObject([{ behavior: 'review-issue', state: 'settled', outcome: 'commented' }])
  request.mockClear(); launch.mockClear()
  return { source, overrides, request, launch, review: review.id }
}

const INCIDENT_1855 = "atomic behavior blocked: Observed regression failure: tests/behavior-chain-reconciliation.test.ts > refreshes one held red candidate and reconciles its original Call across restart and another base advance: accepted response — AssertionError: expected 'CI failed' to be null. Captured candidate "
  + 'd'.repeat(64) + '; producing run ' + 'c'.repeat(32) + '. The fixture resource receipt was corrected.'

it.each(['clean failure', 'candidate-only', 'missing', 'different failure'] as const)(
  'replays the exact named assertion against pinned code (%s)', async mode => {
    const { diagnoseReportedAssertion } = await vi.importActual<typeof import('../server/behavior-chain-test-recheck')>('../server/behavior-chain-test-recheck')
    const root = mkdtempSync(join(tmpdir(), 'triage-fixture-')); roots.push(root)
    const box = join(homedir(), '.poise', 'test-offload')
    if (mode === 'candidate-only') {
      mkdirSync(box, { recursive: true })
      roots.push(box)
      writeFileSync(join(box, 'run.mjs'), '')
      writeFileSync(join(box, 'relay'), '')
    }
    const file = 'tests/source.test.ts', name = 'reproduces the original assertion'
    const testSource = "import { it, expect } from 'vitest'\nimport { actual } from './subject'\n"
      + `it('${name}', () => expect(actual).toBe(2))\n`
    const subject = (value: number) => `export const actual = ${value}\n`
    const call = 'd'.repeat(32), candidate = 'e'.repeat(64), run = 'f'.repeat(32)
    const payload = JSON.stringify({ call, candidate, run, base: HEAD, changes: [
      { path: file, mode: '100644', content: Buffer.from(testSource).toString('base64') },
      { path: 'tests/subject.ts', mode: '100644', content: Buffer.from(subject(1)).toString('base64') },
    ] })
    const path = join(root, 'capture.json')
    writeFileSync(path, payload, { mode: 0o600 })
    const capture = { status: 'available' as const, base: HEAD, candidate, run, bytes: Buffer.byteLength(payload),
      sha256: createHash('sha256').update(payload).digest('hex'), expires_at: NOW / 1000 + 600 }
    const probes: string[] = []
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: { cwd: string }) => {
      if (command === 'github-interface') {
        mkdirSync(join(args[3], 'tests'), { recursive: true })
        symlinkSync(resolve('node_modules'), join(args[3], 'node_modules'), 'dir')
      }
      const cwd = options.cwd
      if (command === 'git' && args[0] === 'checkout') {
        expect(args.at(-1)).toBe(HEAD)
        rmSync(join(cwd, '.poise-report-triage.mjs'), { force: true })
        rmSync(join(cwd, file), { force: true })
        writeFileSync(join(cwd, 'tests/subject.ts'), subject(mode === 'clean failure' ? 1 : mode === 'different failure' ? 3 : 2))
        if (mode !== 'candidate-only') writeFileSync(join(cwd, file), mode === 'missing' ? testSource.replace(name, 'another test') : testSource)
      }
      if (command === 'node') {
        const offloaded = args[0] === join(box, 'run.mjs')
        if (mode === 'candidate-only') expect(offloaded).toBe(true)
        probes.push(readFileSync(join(cwd, 'tests/subject.ts'), 'utf8').trim())
        try {
          return { stdout: execFileSync(process.execPath, offloaded ? args.slice(6) : args,
            { cwd, encoding: 'utf8', timeout: 5000 }), stderr: '' }
        } catch (error) {
          if ((error as { status?: number }).status === 1) Object.assign(error as object, { expected: true })
          throw error
        }
      }
      return { stdout: '', stderr: '' }
    })
    const result = await diagnoseReportedAssertion('acme/repo', 'author', HEAD, HEAD, { file, test: name, message: 'expected 1 to be 2' },
      mode === 'candidate-only' ? { capture, call, path } : null)
    expect(result).toEqual(mode === 'candidate-only' ? { kind: 'source-only' }
      : mode === 'clean failure' ? { kind: 'distinct-fix' } : { kind: 'inconclusive', reason: expect.stringContaining(mode === 'missing'
        ? 'the named test is absent. Retained candidate source is unavailable' : 'a different assertion failed') })
    if (mode === 'candidate-only') expect(probes).toEqual([subject(1).trim(), subject(2).trim()])
  })

it.each(['distinct-fix', 'source-only', 'missing evidence', 'stale report', 'stale base', 'stale during source preparation',
  'stale during report preparation', 'publication', 'operator hold', 'interrupted'] as const)(
  'diagnoses the current reviewed pre-PR hold through ordinary admission (%s)', async mode => {
    const root = mkdtempSync(join(tmpdir(), 'implementation-triage-')); roots.push(root)
    const path = join(root, 'journal.sqlite')
    let { db, journal } = setup(path)
    const sourceOnly = mode === 'source-only' || mode === 'stale during source preparation'
    const capture = { status: 'available', base: HEAD, candidate: 'd'.repeat(64), run: 'c'.repeat(32), bytes: 1024,
      sha256: '6'.repeat(64), expires_at: NOW / 1000 + 86400 }
    const fixture = await reviewedImplementationReport(db, journal, call => {
      call.error = INCIDENT_1855
      call.artifact = { ...call.artifact!, prepared: { repository: 'acme/repo', issue_number: 7, branch: 'poise/issue-7',
        actor: 'author', checkout_head: HEAD, pull_number: null, head_sha: null },
      ...(sourceOnly ? { failed_source: capture } : {}) }
      fresh.prerequisites = { wait: null, base: HEAD, evidence: [] }
    })
    const invoke = mocks.runFile.getMockImplementation()!
    mocks.runFile.mockImplementation(async (command, args, options) => {
      if (command === 'agent-interface') {
        expect(sourceOnly).toBe(true)
        expect(args).toEqual(['--read-failed-source', fixture.call.id, capture.candidate, capture.run, '--diagnosis', expect.stringMatching(/^[a-f0-9]{64}$/)])
        return { stdout: JSON.stringify({ ...capture, path: '/private/fixture-capture' }), stderr: '' }
      }
      return invoke(command, args, options)
    })
    const source = journal.read('acme/repo#7')!
    const runTriage = async () => {
      const current = journal.read(source.id)!
      return recoverReportedRepair(db, journal, current, await fixture.overrides.observe(current), fixture.overrides.observe, () => true)
    }
    const missing = 'current main: the named test is absent. Retained candidate source is unavailable'
    let finish: (outcome: { kind: 'source-only' | 'distinct-fix' } | { kind: 'inconclusive', reason: string }) => void = () => {}
    mocks.diagnose.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    mocks.diagnose.mockResolvedValue({ kind: 'inconclusive', reason: missing })
    if (mode === 'publication') fresh.publication.head_sha = HEAD
    if (mode === 'operator hold') record(journal, source, { type: 'chain.held', reason: 'New invocations held by the person' })
    const blocked = mode === 'publication' || mode === 'operator hold'
    if (blocked) {
      await runTriage()
      expect(mocks.diagnose).not.toHaveBeenCalled()
    } else {
      expect(await runTriage()).toContain('bounded reproduction')
      expect(await runTriage()).toContain('bounded reproduction')
      expect(mocks.diagnose).toHaveBeenCalledOnce()
      expect(mocks.diagnose).toHaveBeenCalledWith('acme/repo', 'author', HEAD, HEAD,
        { file: 'tests/behavior-chain-reconciliation.test.ts',
          test: 'refreshes one held red candidate and reconciles its original Call across restart and another base advance: accepted response',
          message: "expected 'CI failed' to be null" },
        sourceOnly ? { path: '/private/fixture-capture', call: fixture.call.id, capture } : null, expect.any(AbortSignal))
      if (mode === 'stale report') remote[0].body += '\nRevised scope'
      if (mode === 'stale base') fresh.prerequisites!.base = 'e'.repeat(40)
      finish(mode === 'missing evidence' ? { kind: 'inconclusive', reason: missing }
        : { kind: sourceOnly ? 'source-only' : 'distinct-fix' })
      await waitForImplementationRechecks()
      if (mode === 'interrupted') db.prepare(`UPDATE meta SET value=json_set(value,'$.outcome',NULL)
        WHERE key GLOB 'behavior_chain_implementation_triage:*'`).run()
      if (mode === 'missing evidence') expect(await runTriage()).toContain(missing)
      if (mode === 'interrupted') expect(await runTriage()).toContain('saved diagnosis was interrupted')
    }
    expect(fixture.launch).not.toHaveBeenCalled()
    journal.rebuild()
    db.close(); databases.splice(databases.indexOf(db), 1)
    ;({ db, journal } = setup(path))
    // The process restarts between the saved reproduction and any implementation.
    if (!blocked) await runTriage()
    const runtime = (receipts: LogEntry[] = []) => new BehaviorChainRuntime(journal, operations(db, journal, {
      ...fixture.overrides, readInvocations: async () => ({ entries: receipts, quarantined: [] }),
      recoverReport: (target, observation) => recoverReportedRepair(db, journal, target, observation, fixture.overrides.observe, () => true),
    }))
    await waitForImplementationRechecks()
    if (mode === 'stale during source preparation' || mode === 'stale during report preparation') {
      const originalRequest = fixture.request.getMockImplementation()!
      fixture.request.mockImplementation(async (...args) => {
        const request = await originalRequest(...args)
        if (args[2].behavior === 'implement-issue') fresh.prerequisites!.base = 'e'.repeat(40)
        return request
      })
    }
    await runtime().run()
    const report = journal.read('acme/repo#99')!
    const current = journal.read(source.id)!
    const reportImplementations = report.invocations.filter(item => item.behavior === 'implement-issue')
    const sourceImplementations = current.invocations.filter(item => item.behavior === 'implement-issue')
    if (mode === 'source-only') {
      expect(reportImplementations).toHaveLength(0)
      expect(sourceImplementations).toHaveLength(2)
      const retry = sourceImplementations[1]
      expect(current.testRecovery).toMatchObject({ base: HEAD, admission: retry.id,
        hold: { invocationId: fixture.call.correlation_id, callId: fixture.call.id } })
      expect(retry.request.implementationSource?.id).toBe(report.id)
      expect(retry.request.argv.at(-1)).toContain(report.id.replace('acme/repo#', 'github.com/acme/repo/issues/'))
      expect(fixture.launch).toHaveBeenCalledOnce()
      vi.setSystemTime(NOW + 300_000)
      await runtime([{ ...fixture.call, id: '8'.repeat(32), correlation_id: retry.id,
        started_at: new Date(retry.admittedAt).toISOString(), completed_at: new Date(Date.now() - 1000).toISOString(),
        resources_settled_at: new Date(Date.now()).toISOString() }]).run()
      await runtime().run()
      expect(journal.read(source.id)?.held).toBe(fixture.call.error)
      expect(journal.read(source.id)?.invocations.filter(item => item.behavior === 'implement-issue')).toHaveLength(2)
      expect(fixture.launch).toHaveBeenCalledOnce()
      expect(mocks.diagnose).toHaveBeenCalledOnce()
    } else if (mode === 'distinct-fix') {
      expect(reportImplementations).toHaveLength(1)
      expect(reportImplementations[0].request.implementationSource?.id).toBe(source.id)
      expect(reportImplementations[0].request.argv.at(-1)).toContain('https://github.com/acme/repo/issues/7')
      expect(sourceImplementations).toHaveLength(1)
      expect(current.held).toBe(source.held)
      expect(fixture.launch).toHaveBeenCalledOnce()
    } else if (mode === 'stale during source preparation' || mode === 'stale during report preparation') {
      expect(fixture.request).toHaveBeenCalledOnce()
      expect(fixture.launch).not.toHaveBeenCalled()
      expect(reportImplementations).toHaveLength(0)
      expect(sourceImplementations).toHaveLength(1)
      expect(current.testRecovery?.admission).toBeUndefined()
    } else {
      expect(reportImplementations).toHaveLength(0)
      expect(sourceImplementations).toHaveLength(1)
      expect(current.held).toBeTruthy()
      expect(implementationReportBinding(db, report)?.disposition).toBeNull()
      expect(mocks.diagnose).toHaveBeenCalledTimes(blocked ? 0 : mode === 'stale base' ? 2 : 1)
    }
  })

it.each(['source-only', 'distinct-fix', 'missing', 'stale'] as const)(
  'gates normally admitted and reviewed implementation reports across restart (%s)', async kind => {
    const root = mkdtempSync(join(tmpdir(), 'source-disposition-')); roots.push(root)
    const path = join(root, 'journal.sqlite')
    let { db, journal } = setup(path)
    const fixture = await reviewedImplementationReport(db, journal)
    let report = journal.read('acme/repo#99')!
    if (kind !== 'missing') {
      await setImplementationReportDisposition(db, journal, report, report.sequence, implementationReportBinding(db, report), {
        kind: kind === 'distinct-fix' ? kind : 'source-only', review: fixture.review, commentId: 700,
        diagnosis: kind === 'distinct-fix' ? 'Verified shared defect in tracked main code; independently implementable.'
          : 'The failing test exists only in the unpublished source candidate.',
        nextAction: 'Inspect the original Call; recover the source evidence, then explicitly Resume when safe.' })
    }
    if (kind === 'stale') {
      remote[0].body += '\nChanged triage scope.'
      // A new revision is reviewed normally; its old disposition cannot cover it.
      report = journal.read(report.id)!
      const observation = await fixture.overrides.observe(report)
      report = record(journal, report, { type: 'invocation.admitted', invocation: { id: 'revised-review', behavior: 'review-issue',
        actor: 'reviewer', basis: chainBasis(['issue', observation.issue.revision]), model: 'fixture', slot: reviewer.slot,
        admittedAt: NOW, request: { command: 'agent-interface', cwd: '/fixture', argv: [] } } })
      record(journal, report, { type: 'invocation.settled', invocationId: 'revised-review', callId: 'c'.repeat(32), outcome: 'commented',
        evidence: { status: 'completed', action: 'commented', issue_revision: observation.issue.revision,
          receipts: [{ issue: report.id, comment_id: 700, author: 'reviewer' }],
          resources_settled_at: new Date(NOW).toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } } })
    }
    const original = journal.read('acme/repo#7')!
    const intent = reports(db)
    journal.rebuild()
    db.close(); databases.splice(databases.indexOf(db), 1)
    ;({ db, journal } = setup(path))
    // Revoking report creation must not disable an existing report's admission gate.
    vi.stubEnv('POISE_REPAIR_EXHAUSTION_REPOSITORIES', '')
    await new BehaviorChainRuntime(journal, operations(db, journal, fixture.overrides)).run()
    const current = journal.read('acme/repo#99')!
    if (kind === 'distinct-fix') {
      expect(fixture.request).toHaveBeenCalledOnce()
      expect(fixture.launch).toHaveBeenCalledOnce()
      expect(current.invocations.at(-1)?.behavior).toBe('implement-issue')
    } else {
      expect(fixture.request).not.toHaveBeenCalled()
      expect(fixture.launch).not.toHaveBeenCalled()
      expect(current.invocations.some(item => item.behavior === 'implement-issue')).toBe(false)
      expect(current.waiting).toContain(kind === 'source-only' ? 'source-only disposition' : 'awaits a current explicit')
    }
    expect(journal.read(original.id)).toMatchObject({ held: original.held, resumedAfterSequence: original.resumedAfterSequence,
      invocations: original.invocations })
    if (kind === 'source-only') {
      vi.setSystemTime(NOW + 86_400_000)
      await new BehaviorChainRuntime(journal, operations(db, journal, fixture.overrides)).run()
      expect(fixture.request).not.toHaveBeenCalled()
      expect(fixture.launch).not.toHaveBeenCalled()
      expect(journal.read(original.id)?.waiting).toContain('failing test exists only in the unpublished source candidate')
      expect(journal.read(original.id)?.waiting).toContain('Next action: Inspect the original Call')
      expect(journal.read(original.id)?.waiting).toContain('https://github.com/acme/repo/issues/99')
    }
    expect(reports(db)).toEqual(intent)
    expect(posts()).toHaveLength(1)
  })

it.each(['resume', 'same-text-hold', 'later-call', 'publication', 'source-revision', 'closed', 'competing-work', 'stale-observation', 'preparation', 'report-during-preparation', 'admission', 'launch'] as const)(
  'invalidates a distinct-fix disposition when its source changes (%s)', async change => {
    const { db, journal } = setup()
    const fixture = await reviewedImplementationReport(db, journal)
    const report = journal.read('acme/repo#99')!
    await setImplementationReportDisposition(db, journal, report, report.sequence, implementationReportBinding(db, report), {
      kind: 'distinct-fix', review: fixture.review, commentId: 700,
      diagnosis: 'A distinct verified defect in main requires a repository fix.', nextAction: 'Implement that distinct fix.' })
    const source = journal.read('acme/repo#7')!
    if (change === 'resume' || change === 'later-call') record(journal, source, { type: 'chain.resumed' })
    if (change === 'same-text-hold') record(journal, source, { type: 'chain.held', reason: source.held! })
    if (change === 'later-call') blockedImplementation(journal, 'later-implementation')
    if (change === 'publication') fresh = observation()
    if (change === 'source-revision') fresh.issue.revision = chainBasis('changed source')
    if (change === 'closed') fresh.issue.open = false
    if (change === 'competing-work') fresh.existingPulls = ['https://github.com/acme/repo/pull/22']
    const overrides = { ...fixture.overrides }
    if (change === 'stale-observation') overrides.observe = async chain => {
      const result = await fixture.overrides.observe(chain)
      if (chain.id === source.id) result.checkedAt = NOW - 500_000
      return result
    }
    if (change === 'preparation' || change === 'report-during-preparation') overrides.request = vi.fn(async (chain: BehaviorChain, observation: ChainObservation, decision: { behavior: string }) => {
      if (change === 'preparation') {
        const current = journal.read(source.id)!
        record(journal, current, { type: 'chain.held', reason: current.held! })
      } else remote[0].body += '\nChanged report after preparation.'
      return fixture.request(chain, observation, decision)
    })
    // Only reconcile the report here: the held source cannot independently retry.
    const ops = operations(db, journal, { ...overrides, ownsRepository: () => true, permitted: chain => chain.issue === 99,
      discover: async () => [], readInvocations: async () => ({ entries: [], quarantined: [] }) })
    if (change === 'admission') {
      const admission = ops.implementationAdmission!
      ops.implementationAdmission = async (...args) => {
        const result = await admission(...args)
        if (result.source && fixture.request.mock.calls.length) {
          const current = journal.read(source.id)!
          record(journal, current, { type: 'chain.held', reason: current.held! })
        }
        return result
      }
    }
    if (change === 'launch') ops.launch = async (_invocation, _onExit, allowed) => {
      const current = journal.read(source.id)!
      record(journal, current, { type: 'chain.held', reason: current.held! })
      expect(allowed()).toBe(false)
      return false
    }
    await new BehaviorChainRuntime(journal, ops).run()
    expect(fixture.launch).not.toHaveBeenCalled()
    if (change === 'launch') {
      expect(journal.read(report.id)?.invocations.at(-1)).toMatchObject({ outcome: 'launch_deferred' })
      return
    }
    expect(journal.read(report.id)?.invocations.some(item => item.behavior === 'implement-issue')).toBe(false)
    expect(journal.read(report.id)?.waiting).toContain('awaits a current explicit')
    expect(posts()).toHaveLength(1)
  })

it('refuses unauthenticated, stale and unreviewed disposition controls', async () => {
  const { db, journal } = setup()
  const fixture = await reviewedImplementationReport(db, journal)
  const report = journal.read('acme/repo#99')!
  const binding = implementationReportBinding(db, report)
  const disposition = { kind: 'source-only', review: fixture.review, commentId: 700,
    diagnosis: 'Source candidate only.', nextAction: 'Inspect the original Call before Resume.' }
  await expect(setImplementationReportDisposition(db, journal, report, report.sequence - 1, binding, disposition)).rejects.toThrow('changed')
  await expect(setImplementationReportDisposition(db, journal, report, report.sequence, { ...binding, call: 'forged' }, disposition)).rejects.toThrow('stale')
  await expect(setImplementationReportDisposition(db, journal, report, report.sequence, binding, { ...disposition, commentId: 701 })).rejects.toThrow('authenticated report review')
  remote[0].user.login = 'outsider'
  await expect(setImplementationReportDisposition(db, journal, report, report.sequence, binding, disposition)).rejects.toThrow('identity')
  expect(JSON.parse(reports(db)[0].value).disposition).toBeUndefined()
  expect(fixture.launch).not.toHaveBeenCalled()
})

it('records explicit triage through the existing HTTP chain control and rejects a stale control', async () => {
  const { db, journal } = setup()
  const fixture = await reviewedImplementationReport(db, journal)
  mocks.database = db; mocks.journal = journal
  const { handleBehaviorChains } = await import('../server/behavior-chain-api')
  const server = createServer((req, res) => { void handleBehaviorChains(req, res, req.url || '/') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  const url = `http://127.0.0.1:${address.port}/api/behavior-chains`
  try {
    const view = await (await fetch(`${url}?id=acme/repo%2399`)).json()
    expect(view.implementationReport).toMatchObject({ source: 'acme/repo#7', call: fixture.call.id, disposition: null })
    const body = { id: 'acme/repo#99', sequence: view.chain.sequence, operation: 'report-disposition', binding: view.implementationReport,
      disposition: { kind: 'source-only', review: fixture.review, commentId: 700,
        diagnosis: 'The failure belongs to the unpublished source candidate.', nextAction: 'Inspect the original Call before explicit Resume.' } }
    const post = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    expect((await post()).status).toBe(200)
    expect(journal.read('acme/repo#7')?.waiting).toContain(body.disposition.diagnosis)
    expect((await post()).status).toBe(409)
    expect(JSON.parse(reports(db)[0].value).disposition).toMatchObject(body.disposition)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

it('does not restart a pre-existing admitted report implementation without a disposition', async () => {
  const { db, journal } = setup()
  const fixture = await reviewedImplementationReport(db, journal)
  let report = journal.read('acme/repo#99')!
  const observation = await fixture.overrides.observe(report)
  record(journal, report, { type: 'invocation.admitted', invocation: { id: 'stale-implement', behavior: 'implement-issue',
    basis: chainBasis(['issue', observation.issue.revision]), actor: 'author', model: 'fixture', slot: reviewer.slot,
    admittedAt: NOW - 60_000, request: { command: 'agent-interface', cwd: '/fixture',
      argv: ['--atomic-work', report.id, '--model', 'fixture', '--expected-issue-revision', observation.issue.revision] } } })
  const ops = operations(db, journal, { ...fixture.overrides, readInvocations: async () => ({ entries: [], quarantined: [] }) })
  await new BehaviorChainRuntime(journal, ops).run()
  expect(fixture.launch).not.toHaveBeenCalled()
  const current = journal.read(report.id)!
  expect(current.invocations.find(item => item.id === 'stale-implement')).toMatchObject({ behavior: 'implement-issue', state: 'settled', outcome: 'launch_deferred' })
  expect(current.waiting).toContain('awaits a current explicit')
  expect(posts()).toHaveLength(1)
})

it.each(['source-only', 'distinct-fix'] as const)(
  'allows triage after retiring a pre-existing admitted report implementation without a disposition (%s)', async kind => {
    const { db, journal } = setup()
    const fixture = await reviewedImplementationReport(db, journal)
    let report = journal.read('acme/repo#99')!
    const observation = await fixture.overrides.observe(report)
    record(journal, report, { type: 'invocation.admitted', invocation: { id: 'stale-implement', behavior: 'implement-issue',
      basis: chainBasis(['issue', observation.issue.revision]), actor: 'author', model: 'fixture', slot: reviewer.slot,
      admittedAt: NOW - 60_000, request: { command: 'agent-interface', cwd: '/fixture',
        argv: ['--atomic-work', report.id, '--model', 'fixture', '--expected-issue-revision', observation.issue.revision] } } })
    const ops = operations(db, journal, { ...fixture.overrides, readInvocations: async () => ({ entries: [], quarantined: [] }) })
    await new BehaviorChainRuntime(journal, ops).run()
    expect(fixture.launch).not.toHaveBeenCalled()
    report = journal.read(report.id)!
    expect(report.invocations.find(item => item.id === 'stale-implement')).toMatchObject({ state: 'settled', outcome: 'launch_deferred' })
    await setImplementationReportDisposition(db, journal, report, report.sequence, implementationReportBinding(db, report), {
      kind, review: fixture.review, commentId: 700,
      diagnosis: kind === 'distinct-fix' ? 'A distinct verified defect in main requires a repository fix.'
        : 'The failing test exists only in the unpublished source candidate.',
      nextAction: kind === 'distinct-fix' ? 'Implement that distinct fix.' : 'Inspect the original Call before explicit Resume.' })
    fixture.request.mockClear(); fixture.launch.mockClear()
    await new BehaviorChainRuntime(journal, ops).run()
    const current = journal.read(report.id)!
    if (kind === 'distinct-fix') {
      expect(fixture.launch).toHaveBeenCalledOnce()
      expect(current.invocations.at(-1)).toMatchObject({ behavior: 'implement-issue', state: 'started' })
      expect(current.invocations.at(-1)?.request.implementationSource).toMatchObject({ id: 'acme/repo#7' })
    } else {
      expect(fixture.request).not.toHaveBeenCalled()
      expect(fixture.launch).not.toHaveBeenCalled()
      expect(current.waiting).toContain('source-only disposition')
      expect(journal.read('acme/repo#7')?.waiting).toContain('failing test exists only')
    }
    expect(posts()).toHaveLength(1)
  })

it('retires a pre-disposition admitted report implementation once a distinct-fix is verified', async () => {
  const { db, journal } = setup()
  const fixture = await reviewedImplementationReport(db, journal)
  let report = journal.read('acme/repo#99')!
  await setImplementationReportDisposition(db, journal, report, report.sequence, implementationReportBinding(db, report), {
    kind: 'distinct-fix', review: fixture.review, commentId: 700,
    diagnosis: 'A distinct verified defect in main requires a repository fix.', nextAction: 'Implement that distinct fix.' })
  report = journal.read(report.id)!
  const observation = await fixture.overrides.observe(report)
  record(journal, report, { type: 'invocation.admitted', invocation: { id: 'stale-implement', behavior: 'implement-issue',
    basis: chainBasis(['issue', observation.issue.revision]), actor: 'author', model: 'fixture', slot: reviewer.slot,
    admittedAt: NOW - 60_000, request: { command: 'agent-interface', cwd: '/fixture',
      argv: ['--atomic-work', report.id, '--model', 'fixture', '--expected-issue-revision', observation.issue.revision] } } })
  const ops = operations(db, journal, { ...fixture.overrides, readInvocations: async () => ({ entries: [], quarantined: [] }) })
  await new BehaviorChainRuntime(journal, ops).run()
  expect(fixture.launch).not.toHaveBeenCalled()
  expect(journal.read(report.id)?.invocations.find(item => item.id === 'stale-implement'))
    .toMatchObject({ state: 'settled', outcome: 'launch_deferred' })
  await new BehaviorChainRuntime(journal, ops).run()
  expect(fixture.launch).toHaveBeenCalledOnce()
  const current = journal.read(report.id)!
  expect(current.invocations.at(-1)).toMatchObject({ behavior: 'implement-issue', state: 'started' })
  expect(current.invocations.at(-1)?.request.implementationSource).toMatchObject({ id: 'acme/repo#7' })
  expect(posts()).toHaveLength(1)
})

it('retires a source-bound admitted report implementation when the report revision changes before recovery', async () => {
  const { db, journal } = setup()
  const fixture = await reviewedImplementationReport(db, journal)
  let report = journal.read('acme/repo#99')!
  await setImplementationReportDisposition(db, journal, report, report.sequence, implementationReportBinding(db, report), {
    kind: 'distinct-fix', review: fixture.review, commentId: 700,
    diagnosis: 'A distinct verified defect in main requires a repository fix.', nextAction: 'Implement that distinct fix.' })
  report = journal.read(report.id)!
  const source = journal.read('acme/repo#7')!
  const observation = await fixture.overrides.observe(report)
  record(journal, report, { type: 'invocation.admitted', invocation: { id: 'bound-implement', behavior: 'implement-issue',
    basis: chainBasis(['issue', observation.issue.revision]), actor: 'author', model: 'fixture', slot: reviewer.slot,
    admittedAt: NOW - 60_000, request: { command: 'agent-interface', cwd: '/fixture',
      argv: ['--atomic-work', report.id, '--model', 'fixture', '--expected-issue-revision', observation.issue.revision],
      implementationSource: { id: source.id, sequence: source.sequence } } } })
  // A crash leaves the source-bound admission pending; the report revision changes before recovery.
  remote[0].body += '\nChanged report before recovery.'
  const ops = operations(db, journal, { ...fixture.overrides, readInvocations: async () => ({ entries: [], quarantined: [] }) })
  await new BehaviorChainRuntime(journal, ops).run()
  expect(fixture.launch).not.toHaveBeenCalled()
  report = journal.read(report.id)!
  expect(report.invocations.find(item => item.id === 'bound-implement'))
    .toMatchObject({ state: 'settled', outcome: 'launch_deferred' })
  expect(report.waiting).toContain('awaits a current explicit')
  // The retired admission no longer blocks a new review and replacement disposition.
  const revised = await fixture.overrides.observe(report)
  report = record(journal, report, { type: 'invocation.admitted', invocation: { id: 'recovery-review', behavior: 'review-issue',
    actor: 'reviewer', basis: chainBasis(['issue', revised.issue.revision]), model: 'fixture', slot: reviewer.slot,
    admittedAt: NOW, request: { command: 'agent-interface', cwd: '/fixture', argv: [] } } })
  record(journal, report, { type: 'invocation.settled', invocationId: 'recovery-review', callId: 'c'.repeat(32), outcome: 'commented',
    evidence: { status: 'completed', action: 'commented', issue_revision: revised.issue.revision,
      receipts: [{ issue: report.id, comment_id: 700, author: 'reviewer' }],
      resources_settled_at: new Date(NOW).toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } } })
  report = journal.read(report.id)!
  await setImplementationReportDisposition(db, journal, report, report.sequence, implementationReportBinding(db, report), {
    kind: 'distinct-fix', review: 'recovery-review', commentId: 700,
    diagnosis: 'A distinct verified defect in main requires a repository fix.', nextAction: 'Implement that distinct fix.' })
  fixture.request.mockClear(); fixture.launch.mockClear()
  await new BehaviorChainRuntime(journal, ops).run()
  expect(fixture.launch).toHaveBeenCalledOnce()
  expect(journal.read(report.id)?.invocations.at(-1)).toMatchObject({ behavior: 'implement-issue', state: 'started' })
  expect(posts()).toHaveLength(1)
})

it('blocks implementation when the report acknowledgement was lost and publishing is disabled', async () => {
  const { db, journal } = setup()
  const fixture = await reviewedImplementationReport(db, journal)
  const stored = JSON.parse(reports(db)[0].value)
  stored.issueNumber = null
  db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify(stored), `behavior_chain_repair_report:${stored.key}`)
  expect(implementationReportBinding(db, journal.read('acme/repo#99')!)).toBeNull()
  vi.stubEnv('POISE_REPAIR_EXHAUSTION_REPOSITORIES', '')
  const ops = operations(db, journal, { ...fixture.overrides, readInvocations: async () => ({ entries: [], quarantined: [] }) })
  await new BehaviorChainRuntime(journal, ops).run()
  expect(fixture.request).not.toHaveBeenCalled()
  expect(fixture.launch).not.toHaveBeenCalled()
  const current = journal.read('acme/repo#99')!
  expect(current.invocations.some(item => item.behavior === 'implement-issue')).toBe(false)
  expect(current.waiting).toContain('awaits a current explicit')
  expect(JSON.parse(reports(db)[0].value).issueNumber).toBe(99)
  expect(posts()).toHaveLength(1)
})

it.each([false, true])('gates review deadline reports behind disposition across restart (legacy=%s)', async legacy => {
  const kinds = ['source-only', 'distinct-fix', 'missing'] as const
  for (const kind of kinds) {
    const freshRoot = mkdtempSync(join(tmpdir(), `review-${kind}-`)); roots.push(freshRoot)
    const freshPath = join(freshRoot, 'journal.sqlite')
    let { db, journal } = setup(freshPath)
    remote = []; indexed = false
    const fixture = await reviewedReviewReport(db, journal, legacy)
    let report = journal.read('acme/repo#99')!
    const binding = reviewReportBinding(db, report)!
    expect(binding).toMatchObject(legacy
      ? { source: 'acme/repo#21', pull: 21, head: HEAD, holdSequence: null }
      : { source: 'acme/repo#7', pull: 21, head: HEAD })
    expect(binding.attempts).toHaveLength(legacy ? 2 : 3)
    expect(binding.revision).toBe(chainBasis([remote[0].title, remote[0].body]))
    if (kind !== 'missing') {
      await setImplementationReportDisposition(db, journal, report, report.sequence, binding, {
        kind, review: fixture.review, commentId: 700,
        diagnosis: kind === 'distinct-fix' ? 'Verified independent defect in main; separately implementable.'
          : 'Review timeouts are source-only; no independent defect was identified.',
        nextAction: kind === 'distinct-fix' ? 'Implement that distinct fix through ordinary gates.'
          : 'Inspect the original Calls, then explicitly retry the held review when appropriate.' })
      const stored = JSON.parse(reports(db)[0].value)
      expect(stored.disposition).toMatchObject({ kind, review: fixture.review, commentId: 700 })
    }
    const intent = reports(db)
    journal.rebuild()
    db.close(); databases.splice(databases.indexOf(db), 1)
    ;({ db, journal } = setup(freshPath))
    vi.stubEnv('POISE_REPAIR_EXHAUSTION_REPOSITORIES', '')
    await new BehaviorChainRuntime(journal, operations(db, journal, fixture.overrides)).run()
    const current = journal.read('acme/repo#99')!
    if (kind === 'distinct-fix') {
      expect(fixture.request).toHaveBeenCalledOnce()
      expect(fixture.launch).toHaveBeenCalledOnce()
      expect(current.invocations.at(-1)?.behavior).toBe('implement-issue')
      if (!legacy) expect(current.invocations.at(-1)?.request.implementationSource).toMatchObject({ id: 'acme/repo#7' })
    } else {
      expect(fixture.request).not.toHaveBeenCalled()
      expect(fixture.launch).not.toHaveBeenCalled()
      expect(current.invocations.some(item => item.behavior === 'implement-issue')).toBe(false)
      expect(current.waiting).toContain(kind === 'source-only' ? 'source-only disposition' : 'awaits a current explicit')
      if (kind === 'source-only') {
        expect(current.waiting).toContain('PR review deadline report')
        expect(current.waiting).toContain('no-submission and resource release preserved')
        expect(current.waiting).toContain('No recovery is added')
      }
    }
    if (!legacy) {
      const source = journal.read('acme/repo#7')!
      expect(source.held).toContain('review-pr failed before publication three times')
      expect(source.invocations).toHaveLength(3)
    } else {
      expect(journal.read('acme/repo#7')).toBeNull()
    }
    expect(reports(db)).toEqual(intent)
    db.close(); databases.splice(databases.indexOf(db), 1)
    remote = []; indexed = false
    vi.stubEnv('POISE_REPAIR_EXHAUSTION_REPOSITORIES', 'acme/repo')
  }
})

it.each([false, true])('blocks review implementation when its acknowledgement was lost (legacy=%s)', async legacy => {
  const { db, journal } = setup()
  const fixture = await reviewedReviewReport(db, journal, legacy)
  const stored = JSON.parse(reports(db)[0].value)
  stored.issueNumber = null
  db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify(stored), `behavior_chain_repair_report:${stored.key}`)
  expect(reviewReportBinding(db, journal.read('acme/repo#99')!)).toBeNull()
  vi.stubEnv('POISE_REPAIR_EXHAUSTION_REPOSITORIES', '')
  const ops = operations(db, journal, { ...fixture.overrides, readInvocations: async () => ({ entries: [], quarantined: [] }) })
  await new BehaviorChainRuntime(journal, ops).run()
  expect(fixture.request).not.toHaveBeenCalled()
  expect(fixture.launch).not.toHaveBeenCalled()
  const current = journal.read('acme/repo#99')!
  expect(current.invocations.some(item => item.behavior === 'implement-issue')).toBe(false)
  expect(current.waiting).toContain('PR review deadline report awaits a current explicit')
  expect(JSON.parse(reports(db)[0].value).issueNumber).toBe(99)
})

it.each([false, true])('blocks review implementation when its acknowledgement was lost and the configured account changed (legacy=%s)', async legacy => {
  const { db, journal } = setup()
  const fixture = await reviewedReviewReport(db, journal, legacy)
  const stored = JSON.parse(reports(db)[0].value)
  stored.issueNumber = null
  db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify(stored), `behavior_chain_repair_report:${stored.key}`)
  // The configured `me` account changes before intake; the report issue stays authored by the original account.
  mocks.accounts = { me: 'other', agentAccount: 'reviewer' }
  vi.stubEnv('POISE_REPAIR_EXHAUSTION_REPOSITORIES', '')
  const ops = operations(db, journal, { ...fixture.overrides, readInvocations: async () => ({ entries: [], quarantined: [] }) })
  await new BehaviorChainRuntime(journal, ops).run()
  expect(fixture.request).not.toHaveBeenCalled()
  expect(fixture.launch).not.toHaveBeenCalled()
  const current = journal.read('acme/repo#99')!
  expect(current.invocations.some(item => item.behavior === 'implement-issue')).toBe(false)
  expect(current.waiting).toContain('PR review deadline report awaits a current explicit')
  expect(current.waiting).toContain('verification unavailable')
  expect(JSON.parse(reports(db)[0].value).issueNumber).toBeNull()
})

it('still admits an ordinary issue while an unrelated review report acknowledgement is lost', async () => {
  const { db, journal } = setup()
  await reviewedReviewReport(db, journal, true)
  const stored = JSON.parse(reports(db)[0].value)
  stored.issueNumber = null
  db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify(stored), `behavior_chain_repair_report:${stored.key}`)
  remote.push(issue(88, 'Ordinary work'))
  const ordinary = journal.append('acme/repo#88', 'seed:88', 0, { type: 'chain.admitted', repository: 'acme/repo',
    issue: 88, branch: 'poise/issue-88', author: 'author', reviewer: 'reviewer' }, NOW - 60_000)
  const ordinaryObservation = unpublished()
  ordinaryObservation.issueReviewers = []
  const gate = await implementationReportAdmission(db, journal, ordinary, ordinaryObservation, async () => ordinaryObservation)
  expect(gate).toEqual({ reason: null })
  expect(JSON.parse(reports(db)[0].value).issueNumber).toBeNull()
})

it.each(['implementation', 'review'] as const)('still admits a null-body ordinary issue while an unrelated %s report acknowledgement is lost', async kind => {
  const { db, journal } = setup()
  if (kind === 'implementation') await reviewedImplementationReport(db, journal)
  else await reviewedReviewReport(db, journal, true)
  const stored = JSON.parse(reports(db)[0].value)
  stored.issueNumber = null
  db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify(stored), `behavior_chain_repair_report:${stored.key}`)
  remote.push({ ...issue(88, ''), body: null as unknown as string })
  const ordinary = journal.append('acme/repo#88', 'seed:88', 0, { type: 'chain.admitted', repository: 'acme/repo',
    issue: 88, branch: 'poise/issue-88', author: 'author', reviewer: 'reviewer' }, NOW - 60_000)
  const ordinaryObservation = unpublished()
  ordinaryObservation.issueReviewers = []
  const gate = await implementationReportAdmission(db, journal, ordinary, ordinaryObservation, async () => ordinaryObservation)
  expect(gate).toEqual({ reason: null })
  expect(JSON.parse(reports(db)[0].value).issueNumber).toBeNull()
})

it('keeps a legacy source-only review report fenced across ownership changes while ordinary issues still start', async () => {
  const { db, journal } = setup()
  const fixture = await reviewedReviewReport(db, journal, true)
  let report = journal.read('acme/repo#99')!
  await setImplementationReportDisposition(db, journal, report, report.sequence, reviewReportBinding(db, report), {
    kind: 'source-only', review: fixture.review, commentId: 700,
    diagnosis: 'Review timeouts are source-only; no independent defect was identified.',
    nextAction: 'Inspect the original Calls, then explicitly retry the held review when appropriate.' })
  // A v2 chain takes ownership of the same PR; the legacy disposition dies with it.
  let owner = journal.append('acme/repo#7', 'seed:7', 0, { type: 'chain.admitted', repository: 'acme/repo',
    issue: 7, branch: 'poise/issue-7', author: 'author', reviewer: 'reviewer' }, NOW - 600_000)
  const owned = observation(21)
  record(journal, owner, { type: 'chain.observed', observation: { ...owned, checkedAt: NOW } })
  const observe = async (chain: BehaviorChain) => chain.issue === 7
    ? { ...owned, checkedAt: Date.now() } : fixture.overrides.observe(chain)
  const ops = operations(db, journal, { ...fixture.overrides, observe, permitted: (chain: BehaviorChain) => chain.issue === 99,
    readInvocations: async () => ({ entries: [], quarantined: [] }) })
  await new BehaviorChainRuntime(journal, ops).run()
  expect(fixture.request).not.toHaveBeenCalled()
  expect(fixture.launch).not.toHaveBeenCalled()
  report = journal.read('acme/repo#99')!
  expect(report.invocations.some(item => item.behavior === 'implement-issue')).toBe(false)
  expect(report.waiting).toContain('PR review deadline report awaits a current explicit')
  // An ordinary issue without a report still admits implementation.
  const ordinary = journal.append('acme/repo#88', 'seed:88', 0, { type: 'chain.admitted', repository: 'acme/repo',
    issue: 88, branch: 'poise/issue-88', author: 'author', reviewer: 'reviewer' }, NOW - 60_000)
  const ordinaryObservation = unpublished()
  ordinaryObservation.issueReviewers = []
  const gate = await implementationReportAdmission(db, journal, ordinary, ordinaryObservation, async () => ordinaryObservation)
  expect(gate).toEqual({ reason: null })
})

it('blocks a legacy distinct-fix review disposition after its source PR changes head', async () => {
  const { db, journal } = setup()
  const fixture = await reviewedReviewReport(db, journal, true)
  let report = journal.read('acme/repo#99')!
  await setImplementationReportDisposition(db, journal, report, report.sequence, reviewReportBinding(db, report), {
    kind: 'distinct-fix', review: fixture.review, commentId: 700,
    diagnosis: 'Verified independent defect in main; separately implementable.',
    nextAction: 'Implement that distinct fix through ordinary gates.' })
  // The source PR pushes a new head; the old disposition dies with it.
  prHead = 'b'.repeat(40)
  const ops = operations(db, journal, { ...fixture.overrides,
    readInvocations: async () => ({ entries: [], quarantined: [] }) })
  await new BehaviorChainRuntime(journal, ops).run()
  expect(fixture.request).not.toHaveBeenCalled()
  expect(fixture.launch).not.toHaveBeenCalled()
  report = journal.read('acme/repo#99')!
  expect(report.invocations.some(item => item.behavior === 'implement-issue')).toBe(false)
  expect(report.waiting).toContain('source or reviewed report evidence changed')
})

it.each([false, true])('retires an admitted review implementation without disposition and settles launched work (legacy=%s)', async legacy => {
  const { db, journal } = setup()
  const fixture = await reviewedReviewReport(db, journal, legacy)
  let report = journal.read('acme/repo#99')!
  const observation = await fixture.overrides.observe(report)
  record(journal, report, { type: 'invocation.admitted', invocation: { id: 'stale-implement', behavior: 'implement-issue',
    basis: chainBasis(['issue', observation.issue.revision]), actor: 'author', model: 'fixture', slot: reviewer.slot,
    admittedAt: NOW - 60_000, request: { command: 'agent-interface', cwd: '/fixture',
      argv: ['--atomic-work', report.id, '--model', 'fixture', '--expected-issue-revision', observation.issue.revision] } } })
  const ops = operations(db, journal, { ...fixture.overrides, readInvocations: async () => ({ entries: [], quarantined: [] }) })
  await new BehaviorChainRuntime(journal, ops).run()
  expect(fixture.launch).not.toHaveBeenCalled()
  report = journal.read(report.id)!
  expect(report.invocations.find(item => item.id === 'stale-implement')).toMatchObject({ behavior: 'implement-issue', state: 'settled', outcome: 'launch_deferred' })
  expect(report.waiting).toContain('PR review deadline report awaits a current explicit')
  // Launched work settles through its original receipts under the original fences.
  const started = record(journal, report, { type: 'invocation.admitted', invocation: { id: 'launched-implement', behavior: 'implement-issue',
    basis: chainBasis(['issue', observation.issue.revision]), actor: 'author', model: 'fixture', slot: reviewer.slot,
    admittedAt: NOW - 30_000, request: { command: 'agent-interface', cwd: '/fixture',
      argv: ['--atomic-work', report.id, '--model', 'fixture', '--expected-issue-revision', observation.issue.revision] } } })
  record(journal, started, { type: 'invocation.started', invocationId: 'launched-implement' })
  const call = { id: 'd'.repeat(32), correlation_id: 'launched-implement', model: reviewer.model,
    behavior: 'implement_issue', source: 'poise:behavior-chain', actor: 'author', repo: 'acme/repo', pr_id: '99',
    session_id: null, prompt: '', started_at: new Date(NOW - 30_000).toISOString(),
    completed_at: new Date(NOW).toISOString(), time_elapsed: '1m', status: 'failed',
    action: 'not_started', outcome: 'preflight_failed', error_code: 'atomic_work_blocked',
    error: 'atomic behavior blocked: source-only diagnostic; no independent work started',
    head_sha: null, expected_head: null, response: null, receipts: null, review_id: null,
    artifact: { phase: 'executing', prepared: { checkout_head: HEAD }, resource_root: '/private/work' },
    resources_settled_at: new Date(NOW).toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } }
  const settling = operations(db, journal, { ...fixture.overrides,
    readInvocations: async () => ({ entries: [call as unknown as LogEntry], quarantined: [] }) })
  await new BehaviorChainRuntime(journal, settling).run()
  const settled = journal.read(report.id)!
  expect(settled.invocations.find(item => item.id === 'launched-implement')).toMatchObject({ state: 'settled', callId: call.id })
  expect(settled.held).toContain('atomic behavior blocked')
})

const INGRESS_FILE = 'gateway/tests/diagnostic-ingress-ipc.test.ts'
const MEMORY_FILE = 'tests/test-offload.test.ts'
const prePrDiagnostic = () => ({ version: 1 as const, source: 'caller' as const, severity: 'error' as const,
  operation: 'provider.atomic_work', phase: 'validating', outcome: 'blocked', stderr: 'failure excerpt', stderr_truncated: false,
  context: { message: 'failure excerpt', submission: 'none', exit_code: null, signal: null, errno: null }, filesystem: null })
const ingressError = (candidate: string, run: string) =>
  `atomic behavior blocked: cd gateway && npm test failed: ${INGRESS_FILE} > exhausts only deployment contention retries: AssertionError: expected busy but got 'write EPIPE' (${INGRESS_FILE}:166:168). Captured candidate ${candidate}; producing relay run ${run}`
const memoryError = (candidate: string, run: string) =>
  `atomic behavior blocked: npm run check: ${MEMORY_FILE} > keeps memory warnings correlatable without logging command bodies: Error: STACK_TRACE_ERROR, at ${MEMORY_FILE}:2088:30; failed-test marker. Captured candidate ${candidate}; producing relay run ${run}`
const prePrPrerequisites = (numbers: number[]) => ({ wait: null, base: HEAD,
  evidence: [{ repo: 'acme/repo', number: 7, found: true, complete: true, prerequisites: numbers.map(number => ({ repo: 'acme/repo', number })) }] })

it('files one new report for a distinct pre-PR hold with no owner and reconciles its lost acknowledgement through the same marker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pre-pr-second-hold-')); roots.push(root)
  const path = join(root, 'journal.sqlite')
  let { db, journal } = setup(path)
  const { chain, call } = blockedImplementation(journal)
  call.error = ingressError('a'.repeat(64), 'b'.repeat(32)); call.diagnostic = prePrDiagnostic()
  const firstOverrides = { observe: async () => ({ ...fresh, checkedAt: Date.now() }),
    readInvocations: async () => ({ entries: [call], quarantined: [] }) }
  await new BehaviorChainRuntime(journal, operations(db, journal, firstOverrides)).run()
  expect(posts()).toHaveLength(1)
  const originalIntent = reports(db)[0]
  const originalKey = chainBasis(['atomic_work_blocked', chain.id])
  expect(JSON.parse(originalIntent.value)).toMatchObject({ key: originalKey, source: chain.id, pull: null,
    attempts: [{ invocation: call.correlation_id, call: call.id }], issueNumber: 99 })
  remote[0].state = 'closed'
  record(journal, journal.read(chain.id)!, { type: 'chain.resumed' })
  const next = blockedImplementation(journal)
  next.call.error = memoryError('c'.repeat(64), 'd'.repeat(32)); next.call.diagnostic = prePrDiagnostic()
  fresh.prerequisites = prePrPrerequisites([])
  loseCreation = true
  const secondOverrides = { observe: async () => ({ ...fresh, checkedAt: Date.now() }),
    readInvocations: async () => ({ entries: [next.call], quarantined: [] }) }
  await new BehaviorChainRuntime(journal, operations(db, journal, secondOverrides)).run()
  // The current hold selects its own scoped intent, never the closed original.
  const intents = reports(db).map(row => JSON.parse(row.value))
  expect(intents).toHaveLength(2)
  expect(intents.find(intent => intent.key === originalKey)).toEqual(JSON.parse(originalIntent.value))
  const scoped = intents.find(intent => intent.key !== originalKey)!
  expect(scoped).toMatchObject({ source: chain.id, pull: null, issueNumber: null,
    attempts: [{ invocation: next.call.correlation_id, call: next.call.id }] })
  expect(scoped.key).toBe(chainBasis(['atomic_work_blocked', chain.id, next.call.correlation_id, scoped.holdSequence]))
  expect(posts()).toHaveLength(2)
  expect(journal.read(chain.id)).toMatchObject({ held: next.call.error })
  expect(journal.read(chain.id)?.waiting).toContain('creation is unconfirmed')
  db.close(); databases.splice(databases.indexOf(db), 1)
  ;({ db, journal } = setup(path))
  journal.rebuild()
  searchVisible = false
  vi.setSystemTime(Date.now() + 86_400_000)
  await new BehaviorChainRuntime(journal, operations(db, journal, secondOverrides)).run()
  expect(posts()).toHaveLength(2)
  expect(JSON.parse(reports(db).find(row => JSON.parse(row.value).key === scoped.key)!.value).issueNumber).toBeNull()
  searchVisible = true
  vi.setSystemTime(Date.now() + 86_400_000)
  await new BehaviorChainRuntime(journal, operations(db, journal, secondOverrides)).run()
  const reconciled = reports(db).map(row => JSON.parse(row.value))
  expect(reconciled.find(intent => intent.key === originalKey)).toEqual(JSON.parse(originalIntent.value))
  expect(reconciled.find(intent => intent.key === scoped.key)).toMatchObject({ issueNumber: 100,
    attempts: [{ invocation: next.call.correlation_id, call: next.call.id }] })
  expect(posts()).toHaveLength(2)
  expect(journal.read(chain.id)).toMatchObject({ held: next.call.error })
  expect(journal.read(chain.id)?.waiting).toContain('https://github.com/acme/repo/issues/100')
  expect(journal.read(chain.id)?.waiting).not.toContain('https://github.com/acme/repo/issues/99')
  expect(remote[1].body).toContain(`<!-- poise-repair-exhaustion:${scoped.key} -->`)
})

it('adopts a markerless blocked-by remedy for a distinct pre-PR hold without creation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pre-pr-remedy-')); roots.push(root)
  const path = join(root, 'journal.sqlite')
  let { db, journal } = setup(path)
  const { chain, call } = blockedImplementation(journal)
  call.error = ingressError('a'.repeat(64), 'b'.repeat(32)); call.diagnostic = prePrDiagnostic()
  await new BehaviorChainRuntime(journal, operations(db, journal, { observe: async () => ({ ...fresh, checkedAt: Date.now() }),
    readInvocations: async () => ({ entries: [call], quarantined: [] }) })).run()
  expect(posts()).toHaveLength(1)
  const originalIntent = reports(db)[0]
  const originalKey = chainBasis(['atomic_work_blocked', chain.id])
  remote[0].state = 'closed'
  record(journal, journal.read(chain.id)!, { type: 'chain.resumed' })
  const next = blockedImplementation(journal)
  next.call.error = memoryError('c'.repeat(64), 'd'.repeat(32)); next.call.diagnostic = prePrDiagnostic()
  const remedy = issue(98, `Stabilize ${MEMORY_FILE} keeps memory warnings correlatable without logging command bodies under full validation.`)
  remedy.labels = [{ name: 'poise' }]; remote.push(remedy)
  fresh.prerequisites = prePrPrerequisites([98])
  const overrides = { observe: async () => ({ ...fresh, checkedAt: Date.now() }),
    readInvocations: async () => ({ entries: [next.call], quarantined: [] }) }
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  const intents = reports(db).map(row => JSON.parse(row.value))
  expect(intents).toHaveLength(2)
  expect(intents.find(intent => intent.key === originalKey)).toEqual(JSON.parse(originalIntent.value))
  const scoped = intents.find(intent => intent.key !== originalKey)!
  expect(scoped).toMatchObject({ source: chain.id, pull: null, issueNumber: 98,
    attempts: [{ invocation: next.call.correlation_id, call: next.call.id }] })
  expect(posts()).toHaveLength(1)
  expect(journal.read(chain.id)).toMatchObject({ held: next.call.error })
  expect(journal.read(chain.id)?.waiting).toContain('https://github.com/acme/repo/issues/98')
  db.close(); databases.splice(databases.indexOf(db), 1)
  ;({ db, journal } = setup(path))
  journal.rebuild()
  vi.setSystemTime(Date.now() + 86_400_000)
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  expect(reports(db).map(row => JSON.parse(row.value))).toEqual(intents)
  expect(posts()).toHaveLength(1)
  expect(journal.read(chain.id)).toMatchObject({ held: next.call.error })
})

it('deduplicates a same pre-PR failure after Resume without creation', async () => {
  const { db, journal } = setup()
  const { chain, call } = blockedImplementation(journal)
  call.error = ingressError('a'.repeat(64), 'b'.repeat(32)); call.diagnostic = prePrDiagnostic()
  const overrides = { observe: async () => ({ ...fresh, checkedAt: Date.now() }),
    readInvocations: async () => ({ entries: [call], quarantined: [] }) }
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  expect(posts()).toHaveLength(1)
  const intent = reports(db)[0]
  remote[0].state = 'closed'
  record(journal, journal.read(chain.id)!, { type: 'chain.resumed' })
  const next = blockedImplementation(journal)
  next.call.error = ingressError('c'.repeat(64), 'd'.repeat(32)); next.call.diagnostic = prePrDiagnostic()
  await new BehaviorChainRuntime(journal, operations(db, journal, { ...overrides,
    readInvocations: async () => ({ entries: [next.call], quarantined: [] }) })).run()
  expect(next.call.id).not.toBe(call.id)
  expect(reports(db)).toEqual([intent])
  expect(posts()).toHaveLength(1)
  expect(journal.read(chain.id)).toMatchObject({ held: next.call.error })
  expect(journal.read(chain.id)?.waiting).toContain('https://github.com/acme/repo/issues/99')
  expect(journal.read(chain.id)?.waiting).toContain('is closed; no replacement will be created')
  journal.rebuild()
  vi.setSystemTime(Date.now() + 86_400_000)
  await new BehaviorChainRuntime(journal, operations(db, journal, { ...overrides,
    readInvocations: async () => ({ entries: [next.call], quarantined: [] }) })).run()
  expect(reports(db)).toEqual([intent])
  expect(posts()).toHaveLength(1)
})

it.each(['missing file', 'same file different line', 'different diagnostic'])('retains an uncertain pre-PR failure without creation: %s', async mode => {
  const { db, journal } = setup()
  const { chain, call } = blockedImplementation(journal)
  call.error = ingressError('a'.repeat(64), 'b'.repeat(32)); call.diagnostic = prePrDiagnostic()
  const overrides = { observe: async () => ({ ...fresh, checkedAt: Date.now() }),
    readInvocations: async () => ({ entries: [call], quarantined: [] }) }
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  expect(posts()).toHaveLength(1)
  const intent = reports(db)[0]
  remote[0].state = 'closed'
  record(journal, journal.read(chain.id)!, { type: 'chain.resumed' })
  const next = blockedImplementation(journal)
  if (mode === 'missing file') {
    next.call.error = 'atomic behavior blocked: a different worker explanation on a later receipt'
    next.call.diagnostic = prePrDiagnostic()
  } else if (mode === 'same file different line') {
    next.call.error = ingressError('c'.repeat(64), 'd'.repeat(32)).replace(':166:', ':170:')
    next.call.diagnostic = prePrDiagnostic()
  } else {
    next.call.error = memoryError('c'.repeat(64), 'd'.repeat(32))
    next.call.diagnostic = { ...prePrDiagnostic(), phase: 'provider_execution' }
  }
  await new BehaviorChainRuntime(journal, operations(db, journal, { ...overrides,
    readInvocations: async () => ({ entries: [next.call], quarantined: [] }) })).run()
  expect(reports(db)).toEqual([intent])
  expect(posts()).toHaveLength(1)
  expect(journal.read(chain.id)).toMatchObject({ held: next.call.error })
  const waiting = journal.read(chain.id)?.waiting
  expect(waiting).toContain('uncertain failure relationship')
  expect(waiting).toContain(next.call.id)
  expect(waiting).not.toContain('https://github.com/acme/repo/issues/99')
  expect(waiting).not.toContain('is closed; no replacement will be created')
})

it.each(['unavailable', 'ambiguous'])('keeps a distinct pre-PR hold pending when its remedy read is %s', async mode => {
  const { db, journal } = setup()
  const { chain, call } = blockedImplementation(journal)
  call.error = ingressError('a'.repeat(64), 'b'.repeat(32)); call.diagnostic = prePrDiagnostic()
  await new BehaviorChainRuntime(journal, operations(db, journal, { observe: async () => ({ ...fresh, checkedAt: Date.now() }),
    readInvocations: async () => ({ entries: [call], quarantined: [] }) })).run()
  expect(posts()).toHaveLength(1)
  const intent = reports(db)[0]
  remote[0].state = 'closed'
  record(journal, journal.read(chain.id)!, { type: 'chain.resumed' })
  const next = blockedImplementation(journal)
  next.call.error = memoryError('c'.repeat(64), 'd'.repeat(32)); next.call.diagnostic = prePrDiagnostic()
  if (mode === 'ambiguous') {
    for (const number of [98, 100]) {
      const remedy = issue(number, `Stabilize ${MEMORY_FILE} keeps memory warnings correlatable without logging command bodies under full validation.`)
      remedy.labels = [{ name: 'poise' }]; remote.push(remedy)
    }
    fresh.prerequisites = prePrPrerequisites([98, 100])
  } else {
    fresh.prerequisites = prePrPrerequisites([98])
  }
  await new BehaviorChainRuntime(journal, operations(db, journal, { observe: async () => ({ ...fresh, checkedAt: Date.now() }),
    readInvocations: async () => ({ entries: [next.call], quarantined: [] }) })).run()
  expect(reports(db)).toEqual([intent])
  expect(posts()).toHaveLength(1)
  expect(journal.read(chain.id)).toMatchObject({ held: next.call.error })
  expect(journal.read(chain.id)?.waiting).toContain(mode === 'ambiguous' ? 'multiple existing remedies match' : 'existing remedy #98 read is unavailable')
  expect(journal.read(chain.id)?.waiting).not.toContain('https://github.com/acme/repo/issues/99')
})

it('files a distinct pre-PR hold when its only blocked-by prerequisite names the same file for a different test', async () => {
  const { db, journal } = setup()
  const { chain, call } = blockedImplementation(journal)
  call.error = ingressError('a'.repeat(64), 'b'.repeat(32)); call.diagnostic = prePrDiagnostic()
  await new BehaviorChainRuntime(journal, operations(db, journal, { observe: async () => ({ ...fresh, checkedAt: Date.now() }),
    readInvocations: async () => ({ entries: [call], quarantined: [] }) })).run()
  expect(posts()).toHaveLength(1)
  const originalIntent = reports(db)[0]
  const originalKey = chainBasis(['atomic_work_blocked', chain.id])
  remote[0].state = 'closed'
  record(journal, journal.read(chain.id)!, { type: 'chain.resumed' })
  const next = blockedImplementation(journal)
  next.call.error = memoryError('c'.repeat(64), 'd'.repeat(32)); next.call.diagnostic = prePrDiagnostic()
  const unrelated = issue(98, `Stabilize ${MEMORY_FILE} recovers mid-suite when only one suite may run under full validation.`)
  unrelated.labels = [{ name: 'poise' }]; remote.push(unrelated)
  fresh.prerequisites = prePrPrerequisites([98])
  await new BehaviorChainRuntime(journal, operations(db, journal, { observe: async () => ({ ...fresh, checkedAt: Date.now() }),
    readInvocations: async () => ({ entries: [next.call], quarantined: [] }) })).run()
  const intents = reports(db).map(row => JSON.parse(row.value))
  expect(intents).toHaveLength(2)
  expect(intents.find(intent => intent.key === originalKey)).toEqual(JSON.parse(originalIntent.value))
  const scoped = intents.find(intent => intent.key !== originalKey)!
  expect(scoped).toMatchObject({ source: chain.id, pull: null, issueNumber: 100,
    attempts: [{ invocation: next.call.correlation_id, call: next.call.id }] })
  expect(posts()).toHaveLength(2)
  expect(journal.read(chain.id)).toMatchObject({ held: next.call.error })
  expect(journal.read(chain.id)?.waiting).toContain('https://github.com/acme/repo/issues/100')
  expect(journal.read(chain.id)?.waiting).not.toContain('https://github.com/acme/repo/issues/98')
  expect(journal.read(chain.id)?.waiting).not.toContain('https://github.com/acme/repo/issues/99')
})

it('files a distinct pre-PR hold when the same file:line reports a changed failing assertion', async () => {
  const { db, journal } = setup()
  const { chain, call } = blockedImplementation(journal)
  call.error = ingressError('a'.repeat(64), 'b'.repeat(32)); call.diagnostic = prePrDiagnostic()
  await new BehaviorChainRuntime(journal, operations(db, journal, { observe: async () => ({ ...fresh, checkedAt: Date.now() }),
    readInvocations: async () => ({ entries: [call], quarantined: [] }) })).run()
  expect(posts()).toHaveLength(1)
  const originalIntent = reports(db)[0]
  const originalKey = chainBasis(['atomic_work_blocked', chain.id])
  remote[0].state = 'closed'
  record(journal, journal.read(chain.id)!, { type: 'chain.resumed' })
  const next = blockedImplementation(journal)
  next.call.error = ingressError('c'.repeat(64), 'd'.repeat(32)).replace("expected busy but got 'write EPIPE'", "expected busy but got 'timeout'")
  next.call.diagnostic = prePrDiagnostic()
  fresh.prerequisites = prePrPrerequisites([])
  await new BehaviorChainRuntime(journal, operations(db, journal, { observe: async () => ({ ...fresh, checkedAt: Date.now() }),
    readInvocations: async () => ({ entries: [next.call], quarantined: [] }) })).run()
  const intents = reports(db).map(row => JSON.parse(row.value))
  expect(intents).toHaveLength(2)
  expect(intents.find(intent => intent.key === originalKey)).toEqual(JSON.parse(originalIntent.value))
  const scoped = intents.find(intent => intent.key !== originalKey)!
  expect(scoped).toMatchObject({ source: chain.id, pull: null, issueNumber: 100,
    attempts: [{ invocation: next.call.correlation_id, call: next.call.id }] })
  expect(posts()).toHaveLength(2)
  expect(journal.read(chain.id)).toMatchObject({ held: next.call.error })
  expect(journal.read(chain.id)?.waiting).toContain('https://github.com/acme/repo/issues/100')
  expect(journal.read(chain.id)?.waiting).not.toContain('https://github.com/acme/repo/issues/99')
})

it.each(['existing-remedy', 'distinct-fix', 'missing', 'stale'] as const)(
  'gates normally admitted and reviewed repair hold reports across restart (%s)', async kind => {
    const root = mkdtempSync(join(tmpdir(), 'repair-disposition-')); roots.push(root)
    const path = join(root, 'journal.sqlite')
    let { db, journal } = setup(path)
    const fixture = await reviewedRepairHoldReport(db, journal)
    let report = journal.read('acme/repo#99')!
    const remedyRevision = chainBasis('remedy-seed')
    if (kind === 'existing-remedy') {
      let remedy = journal.append('acme/repo#101', 'remedy-seed', 0, { type: 'chain.admitted', repository: 'acme/repo',
        issue: 101, branch: 'poise/issue-101', author: 'author', reviewer: 'reviewer' }, NOW - 60_000)
      remedy = record(journal, remedy, { type: 'chain.observed', observation: { ...unpublished(),
        issue: { open: true, eligible: true, revision: remedyRevision, commentIds: [] },
        prerequisites: { wait: null, base: HEAD, evidence: [] }, checkedAt: NOW - 60_000 } })
      const baseObserve = fixture.overrides.observe
      fixture.overrides.observe = async (chain: BehaviorChain) => {
        if (chain.issue === 101) return { ...unpublished(),
          issue: { open: true, eligible: true, revision: remedyRevision, commentIds: [] },
          prerequisites: { wait: null, base: HEAD, evidence: [] }, checkedAt: Date.now() }
        return baseObserve(chain)
      }
    }
    if (kind !== 'missing') {
      await setImplementationReportDisposition(db, journal, report, report.sequence, implementationReportBinding(db, report), {
        kind: kind === 'distinct-fix' ? kind : 'existing-remedy',
        ...(kind === 'distinct-fix' ? {} : { remedy: 101 }),
        review: fixture.review, commentId: 700,
        diagnosis: kind === 'distinct-fix' ? 'Verified distinct defect in main; independently implementable.'
          : 'Shared failure already tracked in #101; the remedy owns the fix.',
        nextAction: kind === 'distinct-fix' ? 'Implement that distinct fix.'
          : 'Follow the remedy; keep the source held until its own recovery or Resume.' })
    }
    if (kind === 'stale') {
      remote[0].body += '\nChanged triage scope.'
      report = journal.read(report.id)!
      const observation = await fixture.overrides.observe(report)
      report = record(journal, report, { type: 'invocation.admitted', invocation: { id: 'revised-review', behavior: 'review-issue',
        actor: 'reviewer', basis: chainBasis(['issue', observation.issue.revision]), model: 'fixture', slot: reviewer.slot,
        admittedAt: NOW, request: { command: 'agent-interface', cwd: '/fixture', argv: [] } } })
      record(journal, report, { type: 'invocation.settled', invocationId: 'revised-review', callId: 'c'.repeat(32), outcome: 'commented',
        evidence: { status: 'completed', action: 'commented', issue_revision: observation.issue.revision,
          receipts: [{ issue: report.id, comment_id: 700, author: 'reviewer' }],
          resources_settled_at: new Date(NOW).toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } } })
    }
    const original = journal.read('acme/repo#7')!
    const intent = reports(db)
    journal.rebuild()
    db.close(); databases.splice(databases.indexOf(db), 1)
    ;({ db, journal } = setup(path))
    vi.stubEnv('POISE_REPAIR_EXHAUSTION_REPOSITORIES', '')
    await new BehaviorChainRuntime(journal, operations(db, journal, fixture.overrides)).run()
    const current = journal.read('acme/repo#99')!
    if (kind === 'distinct-fix') {
      expect(fixture.request).toHaveBeenCalledOnce()
      expect(fixture.launch).toHaveBeenCalledOnce()
      expect(current.invocations.at(-1)?.behavior).toBe('implement-issue')
      expect(current.invocations.at(-1)?.request.implementationSource).toMatchObject({ id: 'acme/repo#7' })
    } else if (kind === 'existing-remedy') {
      expect(fixture.request.mock.calls.filter(call => call[0].id === 'acme/repo#99')).toHaveLength(0)
      expect(fixture.request.mock.calls.filter(call => call[0].id === 'acme/repo#101')).toHaveLength(1)
      expect(fixture.launch).toHaveBeenCalledOnce()
      expect(current.invocations.some(item => item.behavior === 'implement-issue')).toBe(false)
      expect(current.waiting).toContain('existing-remedy disposition')
      expect(current.waiting).toContain('https://github.com/acme/repo/issues/101')
      expect(current.waiting).toContain('PR #21')
      expect(journal.read('acme/repo#101')?.invocations.at(-1)).toMatchObject({ behavior: 'implement-issue', state: 'started' })
    } else {
      expect(fixture.request).not.toHaveBeenCalled()
      expect(fixture.launch).not.toHaveBeenCalled()
      expect(current.invocations.some(item => item.behavior === 'implement-issue')).toBe(false)
      expect(current.waiting).toContain('awaits a current explicit')
    }
    expect(journal.read(original.id)).toMatchObject({ held: original.held, resumedAfterSequence: original.resumedAfterSequence,
      invocations: original.invocations })
    if (kind === 'existing-remedy') {
      vi.setSystemTime(NOW + 86_400_000)
      await new BehaviorChainRuntime(journal, operations(db, journal, fixture.overrides)).run()
      expect(fixture.launch).toHaveBeenCalledOnce()
      expect(journal.read('acme/repo#99')?.waiting).toContain('existing-remedy disposition')
      expect(journal.read(original.id)?.waiting).toContain('already tracked in #101')
      expect(journal.read(original.id)?.waiting).toContain('https://github.com/acme/repo/issues/101')
      expect(journal.read(original.id)?.waiting).toContain('PR #21')
    }
    expect(reports(db)).toEqual(intent)
    expect(posts()).toHaveLength(1)
  })

it.each(['resume', 'same-text-hold', 'changed-head', 'changed-basis', 'source-revision', 'publication', 'closed-issue',
  'closed-PR', 'competing-work', 'stale-observation', 'preparation', 'report-during-preparation', 'admission', 'launch'] as const)(
  'invalidates a distinct-fix repair disposition when its source changes (%s)', async change => {
    const { db, journal } = setup()
    const fixture = await reviewedRepairHoldReport(db, journal)
    const report = journal.read('acme/repo#99')!
    await setImplementationReportDisposition(db, journal, report, report.sequence, implementationReportBinding(db, report), {
      kind: 'distinct-fix', review: fixture.review, commentId: 700,
      diagnosis: 'A distinct verified defect in main requires a repository fix.', nextAction: 'Implement that distinct fix.' })
    const source = journal.read('acme/repo#7')!
    if (change === 'resume') record(journal, source, { type: 'chain.resumed' })
    if (change === 'same-text-hold') record(journal, source, { type: 'chain.held', reason: source.held! })
    if (change === 'changed-head') { fresh.pull!.head = 'c'.repeat(40); fresh.publication.head_sha = fresh.pull!.head }
    if (change === 'changed-basis') fresh.pull!.reviewRevision = chainBasis('changed findings')
    if (change === 'source-revision') fresh.issue.revision = chainBasis('changed source')
    if (change === 'publication') fresh.publication.head_sha = 'b'.repeat(40)
    if (change === 'closed-issue') fresh.issue.open = false
    if (change === 'closed-PR') fresh.pull!.state = 'closed'
    if (change === 'competing-work') fresh.existingPulls = ['https://github.com/acme/repo/pull/22']
    const overrides = { ...fixture.overrides }
    if (change === 'stale-observation') overrides.observe = async chain => {
      const result = await fixture.overrides.observe(chain)
      if (chain.id === source.id) result.checkedAt = NOW - 500_000
      return result
    }
    if (change === 'preparation' || change === 'report-during-preparation') overrides.request = vi.fn(async (chain: BehaviorChain, observation: ChainObservation, decision: { behavior: string }) => {
      if (change === 'preparation') {
        const current = journal.read(source.id)!
        record(journal, current, { type: 'chain.held', reason: current.held! })
      } else remote[0].body += '\nChanged report after preparation.'
      return fixture.request(chain, observation, decision)
    })
    const ops = operations(db, journal, { ...overrides, ownsRepository: () => true, permitted: chain => chain.issue === 99,
      discover: async () => [], readInvocations: async () => ({ entries: [], quarantined: [] }) })
    if (change === 'admission') {
      const admission = ops.implementationAdmission!
      ops.implementationAdmission = async (...args) => {
        const result = await admission(...args)
        if (result.source && fixture.request.mock.calls.length) {
          const current = journal.read(source.id)!
          record(journal, current, { type: 'chain.held', reason: current.held! })
        }
        return result
      }
    }
    if (change === 'launch') ops.launch = async (_invocation, _onExit, allowed) => {
      const current = journal.read(source.id)!
      record(journal, current, { type: 'chain.held', reason: current.held! })
      expect(allowed()).toBe(false)
      return false
    }
    await new BehaviorChainRuntime(journal, ops).run()
    expect(fixture.launch).not.toHaveBeenCalled()
    if (change === 'launch') {
      expect(journal.read(report.id)?.invocations.at(-1)).toMatchObject({ outcome: 'launch_deferred' })
      return
    }
    expect(journal.read(report.id)?.invocations.some(item => item.behavior === 'implement-issue')).toBe(false)
    expect(journal.read(report.id)?.waiting).toContain('awaits a current explicit')
    expect(posts()).toHaveLength(1)
  })

it('refuses unauthenticated, stale and unreviewed repair dispositions', async () => {
  const { db, journal } = setup()
  const fixture = await reviewedRepairHoldReport(db, journal)
  const report = journal.read('acme/repo#99')!
  const binding = implementationReportBinding(db, report)
  const disposition = { kind: 'existing-remedy', remedy: 101, review: fixture.review, commentId: 700,
    diagnosis: 'Shared failure already tracked in #101.', nextAction: 'Follow the remedy.' }
  await expect(setImplementationReportDisposition(db, journal, report, report.sequence - 1, binding, disposition)).rejects.toThrow('changed')
  await expect(setImplementationReportDisposition(db, journal, report, report.sequence, { ...binding, call: 'forged' }, disposition)).rejects.toThrow('stale')
  await expect(setImplementationReportDisposition(db, journal, report, report.sequence, binding, { ...disposition, commentId: 701 })).rejects.toThrow('authenticated report review')
  await expect(setImplementationReportDisposition(db, journal, report, report.sequence, binding, { ...disposition, kind: 'source-only' })).rejects.toThrow('Disposition requires')
  await expect(setImplementationReportDisposition(db, journal, report, report.sequence, binding, { ...disposition, remedy: undefined })).rejects.toThrow('Disposition requires')
  for (const remedy of [99, 7, 21]) {
    await expect(setImplementationReportDisposition(db, journal, report, report.sequence, binding, { ...disposition, remedy })).rejects.toThrow('Disposition requires')
  }
  await expect(setImplementationReportDisposition(db, journal, report, report.sequence, binding,
    { kind: 'distinct-fix', remedy: 101, review: fixture.review, commentId: 700, diagnosis: 'Distinct.', nextAction: 'Fix.' })).rejects.toThrow('Disposition requires')
  remote[0].user.login = 'outsider'
  await expect(setImplementationReportDisposition(db, journal, report, report.sequence, binding, disposition)).rejects.toThrow('identity')
  expect(JSON.parse(reports(db)[0].value).disposition).toBeUndefined()
  expect(fixture.launch).not.toHaveBeenCalled()
})

it('blocks repair implementation when the report acknowledgement was lost and publishing is disabled', async () => {
  const { db, journal } = setup()
  const fixture = await reviewedRepairHoldReport(db, journal)
  const stored = JSON.parse(reports(db)[0].value)
  stored.issueNumber = null
  db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify(stored), `behavior_chain_repair_report:${stored.key}`)
  expect(implementationReportBinding(db, journal.read('acme/repo#99')!)).toBeNull()
  vi.stubEnv('POISE_REPAIR_EXHAUSTION_REPOSITORIES', '')
  const ops = operations(db, journal, { ...fixture.overrides, readInvocations: async () => ({ entries: [], quarantined: [] }) })
  await new BehaviorChainRuntime(journal, ops).run()
  expect(fixture.request).not.toHaveBeenCalled()
  expect(fixture.launch).not.toHaveBeenCalled()
  const current = journal.read('acme/repo#99')!
  expect(current.invocations.some(item => item.behavior === 'implement-issue')).toBe(false)
  expect(current.waiting).toContain('awaits a current explicit')
  expect(JSON.parse(reports(db)[0].value).issueNumber).toBe(99)
  expect(posts()).toHaveLength(1)
})

it('does not restart a pre-existing admitted repair report implementation without a disposition', async () => {
  const { db, journal } = setup()
  const fixture = await reviewedRepairHoldReport(db, journal)
  let report = journal.read('acme/repo#99')!
  const observation = await fixture.overrides.observe(report)
  record(journal, report, { type: 'invocation.admitted', invocation: { id: 'stale-implement', behavior: 'implement-issue',
    basis: chainBasis(['issue', observation.issue.revision]), actor: 'author', model: 'fixture', slot: reviewer.slot,
    admittedAt: NOW - 60_000, request: { command: 'agent-interface', cwd: '/fixture',
      argv: ['--atomic-work', report.id, '--model', 'fixture', '--expected-issue-revision', observation.issue.revision] } } })
  const ops = operations(db, journal, { ...fixture.overrides, readInvocations: async () => ({ entries: [], quarantined: [] }) })
  await new BehaviorChainRuntime(journal, ops).run()
  expect(fixture.launch).not.toHaveBeenCalled()
  const current = journal.read(report.id)!
  expect(current.invocations.find(item => item.id === 'stale-implement')).toMatchObject({ behavior: 'implement-issue', state: 'settled', outcome: 'launch_deferred' })
  expect(current.waiting).toContain('awaits a current explicit')
  expect(posts()).toHaveLength(1)
})

it('preserves started repair report work with ambiguous publication instead of fencing it', async () => {
  const { db, journal } = setup()
  const fixture = await reviewedRepairHoldReport(db, journal)
  let report = journal.read('acme/repo#99')!
  const observation = await fixture.overrides.observe(report)
  record(journal, report, { type: 'invocation.admitted', invocation: { id: 'started-implement', behavior: 'implement-issue',
    basis: chainBasis(['issue', observation.issue.revision]), actor: 'author', model: 'fixture', slot: reviewer.slot,
    admittedAt: NOW - 60_000, request: { command: 'agent-interface', cwd: '/fixture',
      argv: ['--atomic-work', report.id, '--model', 'fixture', '--expected-issue-revision', observation.issue.revision] } } })
  record(journal, journal.read(report.id)!, { type: 'invocation.started', invocationId: 'started-implement' })
  const baseObserve = fixture.overrides.observe
  const ops = operations(db, journal, { ...fixture.overrides,
    observe: async chain => {
      const result = await baseObserve(chain)
      if (chain.issue === 99) result.publication.head_sha = 'b'.repeat(40)
      return result
    },
    readInvocations: async () => ({ entries: [], quarantined: [] }) })
  await new BehaviorChainRuntime(journal, ops).run()
  expect(fixture.launch).not.toHaveBeenCalled()
  const current = journal.read(report.id)!
  expect(current.invocations.find(item => item.id === 'started-implement')).toMatchObject({ behavior: 'implement-issue', state: 'uncertain' })
  expect(current.invocations.find(item => item.id === 'started-implement')?.outcome).toContain('without a durable Call receipt')
  expect(current.invocations.filter(item => item.behavior === 'implement-issue')).toHaveLength(1)
  expect(posts()).toHaveLength(1)
})

it.each([false, true])('reports the #1664 terminal repair sequence once without recovery (lost acknowledgement=%s)', async lost => {
  const { db, journal } = setup()
  const { chain, call } = blockedRepair(journal)
  vi.stubEnv('FIXTURE_ACCESS_TOKEN', 'fixture-private-credential')
  call.error += ' ghp_secretfixture fixture-private-credential ' + 'detail '.repeat(100)
  call.diagnostic = { version: 1, source: 'caller', severity: 'error', operation: 'provider.atomic_work',
    phase: 'validating', outcome: 'blocked', stderr: '/private/work raw provider output', stderr_truncated: false,
    context: { message: call.error, submission: 'none' }, filesystem: null }
  loseCreation = lost
  const forbidden = vi.fn(async () => { throw new Error('must not repair, review or enqueue before Resume') })
  const overrides = { discover: async () => [], available: () => true, permitted: () => true,
    request: forbidden, launch: forbidden, perform: forbidden,
    observe: async () => ({ ...fresh, checkedAt: Date.now() }),
    readInvocations: async () => ({ entries: [call], quarantined: [] }) }
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  expect(posts()).toHaveLength(1)
  expect(remote[0]).toMatchObject({ title: 'fix: blocked repair for #21', labels: [{ name: 'poise' }] })
  for (const fact of [`<!-- poise-repair-exhaustion:${chainBasis(['atomic_work_blocked', chain.id, 21])} -->`,
    'https://github.com/acme/repo/pull/21', 'https://github.com/acme/repo/issues/7',
    'Stage: repair-pr. Cause: atomic_work_blocked.', `head ${HEAD}; basis ${chain.invocations[0].basis}; slot primary`,
    'one settled original Caller repair', 'status=failed; action=not_started; outcome=preflight_failed',
    'the repair ended before publication', `Invocation ${call.correlation_id}`, `Caller ${call.id}`,
    call.resources_settled_at!, 'Worker-reported blocker: atomic behavior blocked: Caller suite completed with failures; assertion details unavailable',
    'worker-reported explanation is not independently verified', 'fresh repair', 'preserves its hold and ownership', REMEDIATION_SCOPE]) {
    expect(remote[0].body).toContain(fact)
  }
  expect(remote[0].body).not.toMatch(/ghp_secretfixture|fixture-private-credential|\/private\/work|raw provider output/)
  expect(remote[0].body).toContain('[redacted]')
  expect(remote[0].body.split('\n').find(line => line.startsWith('Worker-reported blocker: '))!.length)
    .toBeLessThanOrEqual('Worker-reported blocker: '.length + 500)
  const original = journal.read(chain.id)!
  for (let pass = 0; pass < 3; pass++) {
    journal.rebuild()
    vi.setSystemTime(Date.now() + 86_400_000)
    await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
    expect(journal.read(chain.id)).toMatchObject({ held: call.error, invocations: original.invocations,
      resumedAfterSequence: 0, author: chain.author, reviewer: chain.reviewer, branch: chain.branch, mergeSha: null })
    expect(journal.read('acme/repo#99')).toBeNull()
  }
  expect(reports(db).map(row => JSON.parse(row.value))).toMatchObject([{ source: chain.id, pull: 21, head: HEAD,
    attempts: [{ invocation: call.correlation_id, call: call.id }], issueNumber: 99 }])
  expect(posts()).toHaveLength(1)
  expect(forbidden).not.toHaveBeenCalled()
})

it.each(['operator hold', 'pre-Resume receipt', 'CI-only hold', 'pending resources', 'missing ownership', 'uncertain receipt',
  'publication plan', 'publication result', 'publication receipt', 'publication resume', 'changed head', 'changed repair basis',
  'closed PR', 'closed source', 'generated marker', 'generated issue link', 'disabled repository'])(
  'does not report a terminal repair with %s', async change => {
    const { db, journal } = setup()
    const { chain, call } = blockedRepair(journal)
    await new BehaviorChainRuntime(journal, operations(db, journal, { reportHold: undefined,
      observe: async () => fresh, readInvocations: async () => ({ entries: [call], quarantined: [] }) })).run()
    let source = journal.read(chain.id)!
    if (change === 'operator hold' || change === 'pre-Resume receipt') {
      if (change === 'pre-Resume receipt') source = record(journal, source, { type: 'chain.resumed' })
      source = record(journal, source, { type: 'chain.held', reason: change === 'operator hold' ? 'New invocations held by the person' : call.error })
    }
    source = structuredClone(source)
    const evidence = source.invocations[0].evidence!
    const artifact = evidence.artifact as Record<string, unknown>
    if (change === 'CI-only hold') source.ciHold = { invocationId: call.correlation_id!, callId: call.id, head: HEAD }
    if (change === 'pending resources') evidence.resource_ownership = { version: 1, roots: [], errors: [], process_pending: true }
    if (change === 'missing ownership') evidence.resource_ownership = null
    if (change === 'uncertain receipt') source.invocations[0].state = 'uncertain'
    if (change === 'publication plan') artifact.plan_sha = chainBasis('plan')
    if (change === 'publication result') artifact.result = { outcome: 'published' }
    if (change === 'publication receipt') evidence.receipts = []
    if (change === 'publication resume') evidence.publicationResume = { correlation: 'original-publication' }
    if (change === 'changed head') fresh.pull!.head = 'b'.repeat(40)
    if (change === 'changed repair basis') fresh.pull!.reviewRevision = chainBasis('new findings')
    if (change === 'closed PR') fresh.pull!.state = 'closed'
    if (change === 'closed source') fresh.issue.open = false
    if (change === 'generated marker') seedBody = `<!-- poise-repair-exhaustion:${chainBasis('original report')} -->`
    if (change === 'generated issue link') db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)')
      .run('behavior_chain_repair_report:original', JSON.stringify({ source: 'acme/repo#6', issueNumber: 7 }))
    if (change === 'disabled repository') vi.stubEnv('POISE_REPAIR_EXHAUSTION_REPOSITORIES', '')
    const intents = reports(db)
    await operations(db, journal).reportHold!(source)
    expect(posts()).toHaveLength(0)
    expect(reports(db)).toEqual(intents)
    expect(journal.read(chain.id)).toMatchObject({ held: source.held, invocations: [{ state: 'settled', callId: call.id }] })
  })

it('keeps the implementation blocker and dated report disposition between ordinary rechecks and after closure', async () => {
  const { db, journal } = setup()
  const { chain, call } = blockedImplementation(journal)
  const forbidden = vi.fn(async () => { throw new Error('must not start work before Resume') })
  const observe = vi.fn(async () => ({ ...fresh, checkedAt: Date.now() }))
  const runtime = new BehaviorChainRuntime(journal, operations(db, journal, {
    observe, available: () => true, permitted: source => source.id === chain.id, request: forbidden, launch: forbidden, perform: forbidden,
    readInvocations: async () => ({ entries: [call], quarantined: [] }),
  }))
  await runtime.run()
  const original = journal.read(chain.id)!
  const intent = reports(db)
  const report = structuredClone(remote[0])
  const prefix = `Stage: implement-issue. Worker-reported blocker: ${call.error}. Next action: inspect the implementation Call, address the blocker, then explicitly Resume. `
  const status = () => {
    const current = journal.read(chain.id)!
    expect(current).toMatchObject({ held: original.held, invocations: original.invocations,
      resumedAfterSequence: original.resumedAfterSequence, author: original.author, reviewer: original.reviewer, branch: original.branch })
    const summary = behaviorChainSummary(current, journal, { at: journal.reconciliationAt(current) })
    expect(summary.waiting?.startsWith(prefix)).toBe(true)
    expect(reports(db)).toEqual(intent)
    expect(posts()).toHaveLength(1)
    expect(forbidden).not.toHaveBeenCalled()
    return summary
  }
  status()
  indexed = true
  vi.setSystemTime(journal.reconciliationAt(journal.read(chain.id)!)!)
  await runtime.run()
  const remediation = journal.read('acme/repo#99')!
  record(journal, remediation, { type: 'chain.held', reason: 'remediation needs an operator' })
  status()

  vi.setSystemTime(journal.reconciliationAt(journal.read(chain.id)!)!)
  const read = mocks.runFile.getMockImplementation()!
  mocks.runFile.mockImplementation(async (command: string, argv: string[], ...rest: unknown[]) => {
    const result = await read(command, argv, ...rest)
    if (command === 'gh' && argv[1] === 'repos/acme/repo/issues/99') vi.setSystemTime(Date.now() + 1000)
    return result
  })
  await runtime.run()
  mocks.runFile.mockImplementation(read)
  const verifiedAt = Date.now()
  const admitted = status()
  expect(admitted.waiting).toContain(`last verified ${new Date(verifiedAt).toISOString()}; not live status`)
  expect(journal.read(chain.id)!.observation!.checkedAt).toBeLessThan(verifiedAt)
  expect(admitted.waiting).toContain('admitted as acme/repo#99; remediation is held: remediation needs an operator')
  remote[0].state = 'closed'
  const next = admitted.reconciliation!.nextObservationAt!
  const history = journal.history(chain.id)
  const reads = mocks.runFile.mock.calls.length
  for (const now of [verifiedAt + 1000, next - 1]) {
    vi.setSystemTime(now)
    journal.rebuild()
    expect(status()).toEqual(admitted)
    expect(journal.history(chain.id)).toEqual(history)
    expect(mocks.runFile.mock.calls).toHaveLength(reads)
  }
  const observations = observe.mock.calls.length
  await runtime.run()
  expect(observe.mock.calls).toHaveLength(observations)
  expect(status()).toEqual(admitted)
  vi.setSystemTime(next)
  await runtime.run()
  const closed = status()
  expect(closed.waiting).toContain(`Historical Implementation hold report ${report.html_url} (last verified ${new Date(next).toISOString()}; not live status) is closed; no replacement will be created`)
  expect(closed.waiting).not.toContain('admitted as')
  expect(closed.waiting).not.toContain('remediation is held')
  expect(remote).toEqual([{ ...report, state: 'closed' }])

  const beforeResume = journal.history(chain.id)
  let resumed = record(journal, journal.read(chain.id)!, { type: 'chain.resumed', recovery: { origin: 'operator' } })
  const boundary = resumed.resumedAfterSequence
  expect(behaviorChainSummary(resumed, journal)).toMatchObject({ held: null, waiting: null, invocations: closed.invocations })
  expect(resumed.waiting).toBe(closed.waiting)
  expect(behaviorChainWorkImpact(journal, call.id, call.correlation_id!)?.nextAction)
    .toBe('Await the next observation or admission under existing gates')
  resumed = record(journal, resumed, { type: 'chain.observed', observation: { ...fresh, checkedAt: Date.now() } })
  expect(behaviorChainSummary(resumed, journal).waiting).toBeNull()
  const retained = journal.history(chain.id)
  journal.rebuild()
  expect(journal.read(chain.id)).toEqual(resumed)
  expect(journal.history(chain.id)).toEqual(retained)
  expect(behaviorChainSummary(journal.read(chain.id)!, journal).waiting).toBeNull()
  expect(retained.slice(0, beforeResume.length)).toEqual(beforeResume)

  resumed = record(journal, resumed, { type: 'chain.waiting', reason: closed.waiting! })
  expect(behaviorChainSummary(resumed, journal).waiting).toBe(closed.waiting)
  expect(decideBehaviorChain(resumed, { ...fresh, checkedAt: Date.now() }, Date.now())).toEqual({
    kind: 'wait', reason: 'GitHub prerequisite evidence is missing' })
  fresh.prerequisites = { wait: null, base: HEAD, evidence: [] }
  const launch = vi.fn(async () => true)
  await new BehaviorChainRuntime(journal, operations(db, journal, {
    observe, available: () => true, permitted: source => source.id === chain.id,
    request: async () => ({ command: 'agent-interface', cwd: '/fixture', argv: ['--atomic-work', chain.id, '--model', reviewer.model] }), launch,
    readInvocations: async () => ({ entries: [call], quarantined: [] }),
  })).run()
  const nextAdmission = journal.read(chain.id)!
  expect(launch).toHaveBeenCalledTimes(1)
  expect(nextAdmission.invocations).toHaveLength(2)
  expect(nextAdmission.invocations[0]).toEqual(original.invocations[0])
  expect(nextAdmission.invocations[1].admissionSequence).toBeGreaterThan(boundary)
  expect(behaviorChainSummary(nextAdmission, journal).waiting).toBeNull()
  expect(reports(db)).toEqual(intent)
  expect(posts()).toHaveLength(1)
  expect(remote).toEqual([{ ...report, state: 'closed' }])
})

it('reports a terminal repair separately from a closed implementation report, including after restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'repair-hold-report-')); roots.push(root)
  const path = join(root, 'journal.sqlite')
  let { db, journal } = setup(path)
  const { chain, call } = blockedImplementation(journal)
  let entries = [call]
  const forbidden = vi.fn(async () => { throw new Error('must not repair, review or enqueue before Resume') })
  const overrides = { discover: async () => [], available: () => true, permitted: () => true,
    request: forbidden, launch: forbidden, perform: forbidden,
    observe: async () => ({ ...fresh, checkedAt: Date.now() }),
    readInvocations: async () => ({ entries, quarantined: [] }) }
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  const originalReport = structuredClone(remote[0])
  const originalIntent = reports(db)

  const reread = async (prefix: string) => {
    const before = journal.read(chain.id)!
    const expectedIntents = reports(db)
    const expectedPosts = posts().length
    for (let pass = 0; pass < 3; pass++) {
      if (pass === 1) journal.rebuild()
      if (pass === 2) {
        db.close(); databases.splice(databases.indexOf(db), 1)
        ;({ db, journal } = setup(path))
      }
      vi.setSystemTime(Date.now() + 86_400_000)
      await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
      expect(journal.read(chain.id)).toMatchObject({ held: before.held, invocations: before.invocations,
        resumedAfterSequence: before.resumedAfterSequence, author: before.author, reviewer: before.reviewer, branch: before.branch })
      expect(journal.read(chain.id)?.waiting?.startsWith(prefix)).toBe(true)
      expect(reports(db)).toEqual(expectedIntents)
      expect(posts()).toHaveLength(expectedPosts)
      expect(forbidden).not.toHaveBeenCalled()
    }
  }
  await reread(`Stage: implement-issue. Worker-reported blocker: ${call.error}. Next action: inspect the implementation Call, address the blocker, then explicitly Resume.`)

  let current = record(journal, journal.read(chain.id)!, { type: 'chain.resumed' })
  current = record(journal, current, { type: 'invocation.admitted', invocation: { id: 'published-implementation',
    behavior: 'implement-issue', basis: chain.invocations[0].basis, actor: chain.author, slot: reviewer.slot,
    model: reviewer.model, admittedAt: Date.now(), request: chain.invocations[0].request } })
  const publicationCall = chainBasis('published-implementation').slice(0, 32)
  current = record(journal, current, { type: 'invocation.settled', invocationId: 'published-implementation',
    callId: publicationCall, outcome: 'published', evidence: { status: 'completed', action: 'published', head_sha: HEAD,
      completedAt: Date.now(), resources_settled_at: new Date().toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } } })
  fresh = observation()
  fresh.publication.head_invocation = publicationCall
  fresh.prReviewers = [reviewer]
  Object.assign(fresh.pull!, { changesRequested: false, unresolved: 0, approved: true, ready: true, checksState: 'SUCCESS' })
  current = record(journal, current, { type: 'chain.observed', observation: fresh })
  remote[0].state = 'closed'
  current = record(journal, current, { type: 'invocation.admitted', invocation: { id: 'original-queue', behavior: 'merge-pr',
    basis: chainBasis(['merge', HEAD]), actor: chain.reviewer, slot: null, model: null, admittedAt: Date.now(),
    request: { command: 'github-interface', cwd: '/fixture', argv: ['--merge-if-ready', '21', '--expected-head', HEAD] } } })
  current = record(journal, current, { type: 'invocation.settled', invocationId: 'original-queue', callId: 'c'.repeat(32),
    outcome: 'enqueued', evidence: { status: 'completed', outcome: 'enqueued', head_sha: HEAD,
      resources_settled_at: new Date().toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } } })
  current = record(journal, current, { type: 'chain.observed', observation: { ...fresh, pull: { ...fresh.pull!, queueEntry: 'queue-entry' } } })
  fresh.pull!.queueRemoval = { id: 'queue-removal', reason: 'failed_checks', at: Date.now(), actor: null }
  const decision = decideBehaviorChain(current, fresh, Date.now())
  if (decision.kind !== 'invoke' || decision.behavior !== 'repair-pr') throw new Error('Fixture must need queue repair')
  current = record(journal, current, { type: 'chain.observed', observation: fresh })
  current = record(journal, current, { type: 'invocation.admitted', invocation: { id: 'blocked-repair', behavior: decision.behavior,
    basis: decision.basis, actor: chain.author, slot: reviewer.slot, model: reviewer.model, admittedAt: Date.now(),
    request: { command: 'agent-interface', cwd: '/fixture', argv: ['--atomic-work', chain.id, '--pull-number', '21', '--expected-head', HEAD,
      '--expected-issue-revision', fresh.issue.revision],
    context: { head: HEAD, reviewRevision: fresh.pull!.reviewRevision, queueRemoval: 'queue-removal' } } } })
  record(journal, current, { type: 'invocation.started', invocationId: 'blocked-repair' })
  const repairCall: LogEntry = { ...call, id: chainBasis('blocked-repair').slice(0, 32), correlation_id: 'blocked-repair',
    behavior: 'repair_pr', pr_id: '21', expected_head: HEAD,
    error: 'atomic behavior blocked: midnight Board fixture failure tracked in #1330',
    started_at: new Date().toISOString(), completed_at: new Date().toISOString(), resources_settled_at: new Date().toISOString() }
  entries = [call, repairCall]
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  const held = journal.read(chain.id)!
  expect(held.held).toBe(repairCall.error)
  expect(held.ciHold).toBeUndefined()
  expect(held.invocations.at(-1)).toMatchObject({ behavior: 'repair-pr', state: 'settled', callId: repairCall.id,
    evidence: { status: 'failed', error_code: 'atomic_work_blocked', action: 'not_started' } })
  await reread(`Stage: repair-pr. Worker-reported blocker: ${repairCall.error}. Next action: inspect the repair Call, address the blocker, then explicitly Resume.`)
  expect(journal.read(chain.id)?.waiting).toContain('Repair hold report https://github.com/acme/repo/issues/100 (last verified ')
  expect(reports(db)[0]).toEqual(originalIntent[0])
  expect(reports(db).map(row => JSON.parse(row.value))).toMatchObject([
    { source: chain.id, pull: null, issueNumber: 99 },
    { key: chainBasis(['atomic_work_blocked', chain.id, 21]), source: chain.id, pull: 21, head: HEAD,
      basis: decision.basis, attempts: [{ invocation: repairCall.correlation_id, call: repairCall.id }], issueNumber: 100 },
  ])
  expect(posts()).toHaveLength(2)
  expect(remote[0]).toEqual({ ...originalReport, state: 'closed' })
  expect(remote[1]).toMatchObject({ title: 'fix: blocked repair for #21', labels: [{ name: 'poise' }] })
  current = record(journal, journal.read(chain.id)!, { type: 'chain.resumed' })
  expect(decideBehaviorChain(current, { ...fresh, checkedAt: Date.now() }, Date.now())).toMatchObject({ kind: 'invoke', behavior: 'repair-pr' })
})

it('does not misreport a later review hold as an implementation hold when reusing its earlier implementation report', async () => {
  const { db, journal } = setup()
  const { chain, call } = blockedImplementation(journal)
  const overrides = { observe: async () => ({ ...fresh, checkedAt: Date.now() }),
    readInvocations: async () => ({ entries: [call], quarantined: [] }) }
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  expect(posts()).toHaveLength(1)
  const intent = reports(db)
  let current = record(journal, journal.read(chain.id)!, { type: 'chain.resumed' })
  fresh = observation()
  fresh.prReviewers = [reviewer]
  current = record(journal, current, { type: 'chain.observed', observation: { ...fresh, checkedAt: Date.now() } })
  const basis = chainBasis(['pr', HEAD, fresh.pull!.reviewContext])
  current = record(journal, current, { type: 'invocation.admitted', invocation: { id: 'review-missing-receipt',
    behavior: 'review-pr', basis, actor: current.reviewer, slot: reviewer.slot, model: reviewer.model,
    admittedAt: Date.now(), request: { command: 'agent-interface', cwd: '/fixture', argv: ['--pr-review', '#7'] } } })
  current = record(journal, current, { type: 'invocation.settled', invocationId: 'review-missing-receipt',
    callId: 'b'.repeat(32), outcome: 'reviewed_clean', evidence: { status: 'completed', action: 'reviewed_clean',
      head_sha: HEAD, review_id: 123, completedAt: Date.now(),
      resources_settled_at: new Date().toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } } })
  const holdReason = 'PR review primary lacks its exact-head submission receipt'
  expect(decideBehaviorChain(current, { ...fresh, checkedAt: Date.now() }, Date.now())).toMatchObject({ kind: 'hold', reason: holdReason })
  current = record(journal, current, { type: 'chain.held', reason: holdReason })
  const waiting = await operations(db, journal).reportHold!(journal.read(chain.id)!)
  expect(waiting).not.toContain('Stage: implement-issue')
  expect(waiting).not.toContain('inspect the implementation Call')
  expect(waiting).not.toContain('Stage: repair-pr')
  expect(waiting).toContain('Implementation hold report')
  expect(waiting).toContain('(last verified ')
  expect(journal.read(chain.id)).toMatchObject({ held: holdReason })
  expect(reports(db)).toEqual(intent)
  expect(posts()).toHaveLength(1)
})

it.each(['unmatched', 'unavailable'])('files an eligible report once with %s optional work evidence', async mode => {
  const { db, journal } = setup()
  const { call } = blockedImplementation(journal)
  const lookup = vi.spyOn(journal, 'forInvocation').mockImplementation(() => {
    expect(reports(db)).toHaveLength(0)
    if (mode === 'unavailable') throw new Error('optional journal annotation unavailable')
    return null
  })
  const overrides = { observe: async () => fresh, readInvocations: async () => ({ entries: [call], quarantined: [] }) }
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  expect(posts()).toHaveLength(1)
  expect(remote[0].body).toContain('Current impact: unknown.')
  expect(remote[0].body).toContain(mode === 'unavailable' ? 'Workspace chain evidence is unavailable.' : 'No exact managed-work association is available.')
  const filedBody = remote[0].body
  lookup.mockRestore()
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  expect(posts()).toHaveLength(1)
  expect(remote[0].body).toBe(filedBody)
})

it('keeps an ordinary verified retry out of remediation reporting', async () => {
  const { db, journal } = setup()
  const call = 'd'.repeat(32), correlation = 'e'.repeat(32)
  const fixture = loggingWorkFixture(journal, 'acme/repo', 7, correlation, call, NOW - 10_000)
  expect(behaviorChainWorkImpact(journal, call, correlation)?.impact).toBe('retrying')
  await reportRepairExhaustion(db, journal, fixture.chain, async () => fixture.observation, () => true)
  expect(posts()).toHaveLength(0)
  expect(reports(db)).toHaveLength(0)
})

it.each([
  { published: false, label: 'poise', eligibility: 'removed' },
  { published: true, label: 'poise', eligibility: 'removed' },
  { published: false, label: 'ready-for-work', eligibility: 'removed' },
  { published: true, label: 'ready-for-work', eligibility: 'removed' },
  { published: false, label: 'poise', eligibility: 'unknown' },
  { published: true, label: 'poise', eligibility: 'unknown' },
  { published: false, label: 'poise', eligibility: 'unavailable' },
  { published: true, label: 'poise', eligibility: 'unavailable' },
])('retains implementation holds without report writes when live eligibility is $eligibility (published=$published, label=$label)', async ({ published, label, eligibility }) => {
  const { db, journal } = setup()
  mocks.settings.label = label
  const { chain, call } = blockedImplementation(journal)
  seedLabels = [{ name: label }]
  const overrides = { discover: async () => [], observe: async () => unpublished(),
    readInvocations: async () => ({ entries: [call], quarantined: [] }) }
  await new BehaviorChainRuntime(journal, operations(db, journal, { ...overrides,
    ...(published ? {} : { reportHold: undefined }) })).run()
  const source = journal.read(chain.id)!
  expect(source.observation).toMatchObject({ issue: { eligible: true } })
  expect(source.held).toBe(call.error)
  if (published) remote[0].labels = []
  const priorReports = reports(db)
  const priorIssues = structuredClone(remote)
  seedLabels = label === 'poise' ? [] : [{ name: 'poise' }]
  if (eligibility === 'removed') fresh.issue.eligible = false
  if (eligibility === 'unknown') Reflect.deleteProperty(fresh.issue, 'eligible')
  if (eligibility === 'unavailable') stale = true
  mocks.runFile.mockClear()
  journal.rebuild()
  vi.setSystemTime(NOW + 86_400_000)
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  expect(posts()).toHaveLength(0)
  expect(labelPosts()).toHaveLength(0)
  expect(reports(db)).toEqual(priorReports)
  expect(remote).toEqual(priorIssues)
  expect(journal.read(chain.id)).toMatchObject({ held: source.held, invocations: source.invocations,
    resumedAfterSequence: source.resumedAfterSequence, branch: source.branch, author: source.author, reviewer: source.reviewer,
    waiting: expect.stringContaining(eligibility === 'unavailable' ? 'stale review datastore'
      : `the source is not verified eligible for intake label ${label}`) })
})

it.each(['custom label', 'all issues'])('preserves exactly-once implementation reporting with %s intake', async mode => {
  const { db, journal } = setup()
  mocks.settings.label = 'ready-for-work'
  if (mode === 'all issues') mocks.settings.seedMode = 'all'
  const { call } = blockedImplementation(journal)
  seedLabels = mode === 'all issues' ? [] : [{ name: 'READY-FOR-WORK' }]
  fresh.issue.eligible = mode !== 'all issues'
  const overrides = { discover: async () => [], observe: async () => unpublished(),
    readInvocations: async () => ({ entries: [call], quarantined: [] }) }
  const runtime = new BehaviorChainRuntime(journal, operations(db, journal, overrides))
  await runtime.run()
  expect(remote).toHaveLength(1)
  expect(remote[0].labels).toEqual([{ name: 'poise' }])
  const original = reports(db)
  remote[0].labels = []
  journal.rebuild()
  for (let pass = 0; pass < 2; pass++) {
    vi.setSystemTime(Date.now() + 86_400_000)
    await runtime.run()
  }
  expect(posts()).toHaveLength(1)
  expect(labelPosts()).toHaveLength(1)
  expect(reports(db)).toEqual(original)
  expect(remote[0].labels).toEqual([{ name: 'poise' }])
})

it.each(['stale datastore', 'lost acknowledgement'])('rechecks pending implementation reporting after restart: %s', async mode => {
  const root = mkdtempSync(join(tmpdir(), 'implementation-report-')); roots.push(root)
  const path = join(root, 'journal.sqlite')
  const initial = setup(path)
  const { chain, call } = blockedImplementation(initial.journal)
  vi.setSystemTime(NOW + 40 * 60_000)
  expect(Date.now() - chain.invocations[0].admittedAt).toBe(45 * 60_000)
  const observe = vi.fn(async () => ({ ...fresh, checkedAt: Date.now() }))
  const overrides = { discover: async () => [], observe,
    readInvocations: async () => ({ entries: [call], quarantined: [] }) }
  stale = mode === 'stale datastore'
  loseCreation = mode === 'lost acknowledgement'
  await new BehaviorChainRuntime(initial.journal, operations(initial.db, initial.journal, overrides)).run()
  const original = initial.journal.read(chain.id)!
  expect(original.ciHold).toBeUndefined(); expect(original.testHold).toBeUndefined()
  expect(original.waiting).toContain(stale ? 'stale review datastore' : 'creation is unconfirmed')
  expect(posts()).toHaveLength(stale ? 0 : 1)
  expect(reports(initial.db)).toHaveLength(stale ? 0 : 1)
  if (!stale) expect(JSON.parse(reports(initial.db)[0].value).issueNumber).toBeNull()
  initial.db.close(); databases.splice(databases.indexOf(initial.db), 1)
  const { db, journal } = setup(path)
  journal.rebuild()
  const runtime = new BehaviorChainRuntime(journal, operations(db, journal, overrides))
  const recheck = async () => {
    const current = journal.read(chain.id)!
    const checkedAt = Number(current.observation!.checkedAt)
    const intent = reports(db)
    const postCount = posts().length, observations = observe.mock.calls.length
    expect(journal.reconciliationAt(current)).toBe(checkedAt + 120_000)
    expect(journal.reconcilable('', checkedAt + 120_000, false)).toEqual([])
    vi.setSystemTime(checkedAt + 119_999)
    for (let pass = 0; pass < 2; pass++) await runtime.run()
    expect(journal.reconcilable('', Date.now(), true)).toEqual([])
    expect(journal.read(chain.id)).toEqual(current)
    expect(observe).toHaveBeenCalledTimes(observations)
    expect(reports(db)).toEqual(intent); expect(posts()).toHaveLength(postCount)
    vi.setSystemTime(checkedAt + 120_000)
    expect(journal.reconcilable('', Date.now(), true).map(row => row.id)).toEqual([chain.id])
    await runtime.run()
    expect(observe).toHaveBeenCalledTimes(observations + 1)
  }
  stale = false
  if (mode === 'lost acknowledgement') {
    searchVisible = false
    const intent = reports(db)
    for (let pass = 0; pass < 2; pass++) {
      await recheck()
      expect(journal.read(chain.id)?.waiting).toContain('creation is unconfirmed')
      expect(reports(db)).toEqual(intent)
      expect(posts()).toHaveLength(1)
      journal.rebuild()
    }
  }
  searchVisible = true
  await recheck()
  expect(JSON.parse(reports(db)[0].value).issueNumber).toBe(99)
  expect(journal.read(chain.id)).toMatchObject({ held: original.held, invocations: original.invocations,
    resumedAfterSequence: original.resumedAfterSequence, branch: original.branch, author: original.author, reviewer: original.reviewer })
  expect(journal.read(chain.id)?.waiting).toContain('admission pending normal datastore intake and ownership gates')
  for (const closed of [false, true]) {
    remote[0].state = closed ? 'closed' : 'open'
    journal.rebuild()
    const current = journal.read(chain.id)!
    const checkedAt = Number(current.observation!.checkedAt)
    const next = checkedAt + checkedAt - current.invocations[0].admittedAt
    expect(journal.reconciliationAt(current)).toBe(next)
    vi.setSystemTime(checkedAt + 120_000)
    expect(journal.reconcilable('', Date.now(), true)).toEqual([])
    await runtime.run()
    expect(journal.read(chain.id)).toEqual(current)
    vi.setSystemTime(next)
    await runtime.run()
    if (closed) expect(journal.read(chain.id)?.waiting).toContain('is closed; no replacement will be created')
  }
  const terminal = journal.read(chain.id)!
  expect(journal.reconciliationAt(terminal)).toBe(Number(terminal.observation!.checkedAt) * 2 - terminal.invocations[0].admittedAt)
  expect(posts()).toHaveLength(1)
})

it.each(['operator hold', 'pre-Resume receipt'])('does not accelerate retained pending reporting after %s', async change => {
  const { db, journal } = setup()
  const { chain, call } = blockedImplementation(journal)
  vi.setSystemTime(NOW + 40 * 60_000)
  stale = true
  const observe = vi.fn(async () => ({ ...fresh, checkedAt: Date.now() }))
  const runtime = new BehaviorChainRuntime(journal, operations(db, journal, { discover: async () => [], observe,
    readInvocations: async () => ({ entries: [call], quarantined: [] }) }))
  await runtime.run()
  let source = journal.read(chain.id)!
  expect(source.waiting).toContain('Work-failure reporting pending:')
  if (change === 'pre-Resume receipt') source = record(journal, source, { type: 'chain.resumed' })
  source = record(journal, source, { type: 'chain.held', reason: change === 'operator hold'
    ? 'New invocations held by the person' : call.error })
  journal.rebuild()
  expect(journal.read(chain.id)).toEqual(source)
  const checkedAt = Number(source.observation!.checkedAt)
  expect(journal.reconciliationAt(source)).toBe(checkedAt + checkedAt - source.invocations[0].admittedAt)
  stale = false
  vi.setSystemTime(checkedAt + 120_000)
  expect(journal.reconcilable('', Date.now(), true)).toEqual([])
  for (let pass = 0; pass < 2; pass++) await runtime.run()
  expect(observe).toHaveBeenCalledTimes(1)
  expect(journal.read(chain.id)).toEqual(source)
  expect(posts()).toHaveLength(0); expect(reports(db)).toHaveLength(0)
})

it.each(['operator hold', 'pre-Resume receipt', 'ordinary retry', 'stale observation', 'closed source', 'closed native source',
  'pending resources', 'missing ownership', 'missing receipt', 'unsettled', 'missing artifact', 'publication plan',
  'publication result', 'publication metadata', 'publication receipt', 'publication resume', 'pushed branch', 'bound PR',
  'competing linked work', 'generated marker', 'generated issue link'])('does not report an implementation hold with %s', async change => {
  const { db, journal } = setup()
  const { chain, call } = blockedImplementation(journal)
  await new BehaviorChainRuntime(journal, operations(db, journal, { reportHold: undefined,
    observe: async () => fresh, readInvocations: async () => ({ entries: [call], quarantined: [] }) })).run()
  let source = journal.read(chain.id)!
  if (change === 'operator hold' || change === 'pre-Resume receipt') {
    if (change === 'pre-Resume receipt') source = record(journal, source, { type: 'chain.resumed' })
    source = record(journal, source, { type: 'chain.held', reason: change === 'operator hold' ? 'New invocations held by the person' : call.error })
  }
  source = structuredClone(source)
  const evidence = source.invocations[0].evidence!
  const artifact = evidence.artifact as Record<string, unknown>
  if (change === 'ordinary retry') evidence.error_code = 'atomic_work_failed'
  if (change === 'stale observation') source.observation!.checkedAt = NOW - 120_001
  if (change === 'closed source') fresh.issue.open = false
  if (change === 'closed native source') seedState = 'closed'
  if (change === 'pending resources') evidence.resource_ownership = { version: 1, roots: [], errors: [], process_pending: true }
  if (change === 'missing ownership') evidence.resource_ownership = null
  if (change === 'missing receipt') source.invocations[0].callId = null
  if (change === 'unsettled') source.invocations[0].state = 'uncertain'
  if (change === 'missing artifact') evidence.artifact = null
  if (change === 'publication plan') artifact.plan_sha = chainBasis('plan')
  if (change === 'publication result') artifact.result = { outcome: 'published' }
  if (change === 'publication metadata') artifact.publication = { title: 'Ready to publish' }
  if (change === 'publication receipt') evidence.receipts = []
  if (change === 'publication resume') evidence.publicationResume = { correlation: 'original-publication' }
  if (change === 'pushed branch') fresh.publication.head_sha = HEAD
  if (change === 'bound PR') fresh.publication.pull_number = 21
  if (change === 'competing linked work') fresh.existingPulls = ['https://github.com/acme/repo/pull/22']
  if (change === 'generated marker') seedBody = `<!-- poise-repair-exhaustion:${chainBasis('original report')} -->`
  if (change === 'generated issue link') db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)')
    .run('behavior_chain_repair_report:original', JSON.stringify({ source: 'acme/repo#6', issueNumber: 7 }))
  const priorReports = reports(db)
  await operations(db, journal).reportHold!(source)
  expect(posts()).toHaveLength(0)
  expect(reports(db)).toEqual(priorReports)
  expect(journal.read(chain.id)).toMatchObject({ held: source.held, invocations: [{ state: 'settled', callId: call.id }] })
})

it.each(['operator hold', 'Resume'])('rechecks the implementation hold before reserving a report after %s', async change => {
  const { db, journal } = setup()
  const { chain, call } = blockedImplementation(journal)
  await new BehaviorChainRuntime(journal, operations(db, journal, { reportHold: undefined,
    observe: async () => fresh, readInvocations: async () => ({ entries: [call], quarantined: [] }) })).run()
  const source = journal.read(chain.id)!
  await reportRepairExhaustion(db, journal, source, async () => {
    record(journal, source, change === 'Resume' ? { type: 'chain.resumed' }
      : { type: 'chain.held', reason: 'New invocations held by the person' })
    return fresh
  }, () => true)
  expect(posts()).toHaveLength(0)
  expect(reports(db)).toHaveLength(0)
})

it('reports three terminal implementation timeouts once and reuses across restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'implementation-budget-report-')); roots.push(root)
  const path = join(root, 'journal.sqlite')
  const initial = setup(path)
  const source = budgetImplementation(initial.journal, 3)
  const overrides = { observe: async () => ({ ...fresh, checkedAt: Date.now() }) }
  await new BehaviorChainRuntime(initial.journal, operations(initial.db, initial.journal, overrides)).run()
  expect(posts()).toHaveLength(1)
  expect(remote[0]).toMatchObject({ title: 'fix: implementation exhausted execution budget for #7', labels: [{ name: 'poise' }] })
  const key = chainBasis(['implementation_execution_budget_exhausted', source.id])
  for (const fact of [`<!-- poise-repair-exhaustion:${key} -->`,
    'https://github.com/acme/repo/issues/7',
    'Stage: implement-issue. Cause: implementation_execution_budget_exhausted.',
    `Source: ${source.id}; hold event ${source.sequence}; basis ${source.invocations[0].basis}; slot primary`,
    'three settled original Caller implementations',
    'atomic_work_execution_budget_exhausted, action=not_started, outcome=preflight_failed',
    'No publication plan, result or receipts, pushed branch, bound PR or competing linked work was observed.',
    `Invocation ${source.invocations[0].id}`, `Caller ${source.invocations[0].callId}`,
    `Invocation ${source.invocations[2].id}`, `Caller ${source.invocations[2].callId}`,
    'Next action: inspect the implementation execution budget',
    'explicitly Resume', 'never relaunches implementation',
    REMEDIATION_SCOPE]) {
    expect(remote[0].body).toContain(fact)
  }
  expect(remote[0].body.split(REMEDIATION_SCOPE)).toHaveLength(2)
  expect(remote[0].body.endsWith('Include this exact paragraph in the linked PR review.')).toBe(true)
  expect(reports(initial.db).map(row => JSON.parse(row.value))).toMatchObject([{ source: source.id, pull: null, head: null,
    basis: source.invocations[0].basis, slot: 'primary',
    attempts: source.invocations.map(invocation => ({ invocation: invocation.id, call: invocation.callId })), issueNumber: 99 }])
  initial.db.close(); databases.splice(databases.indexOf(initial.db), 1)
  const { db, journal } = setup(path)
  journal.rebuild()
  for (let pass = 0; pass < 2; pass++) {
    vi.setSystemTime(Date.now() + 86_400_000)
    await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
    expect(journal.read(source.id)).toMatchObject({ held: source.held, invocations: source.invocations })
    expect(reports(db)).toHaveLength(1)
    expect(posts()).toHaveLength(1)
  }
})

it('does not report a single implementation timeout while retry remains', async () => {
  const { db, journal } = setup()
  const chain = budgetImplementation(journal, 1)
  chain.observation = { ...fresh, checkedAt: Date.now() }
  await operations(db, journal).reportHold!(chain)
  expect(posts()).toHaveLength(0)
  expect(reports(db)).toHaveLength(0)
  expect(journal.read(chain.id)).toMatchObject({ held: null, invocations: [{ state: 'settled' }] })
})

it('does not report three implementation timeouts with write evidence', async () => {
  const { db, journal } = setup()
  const chain = structuredClone(budgetImplementation(journal, 3))
  chain.observation = { ...fresh, checkedAt: Date.now() }
  const artifact = chain.invocations[1].evidence!.artifact as Record<string, unknown>
  artifact.result = { outcome: 'published' }
  await operations(db, journal).reportHold!(chain)
  expect(posts()).toHaveLength(0)
  expect(reports(db)).toHaveLength(0)
})

it.each(['source-only', 'distinct-fix', 'missing'] as const)(
  'gates a reviewed implementation budget report behind explicit triage (%s)', async kind => {
    const root = mkdtempSync(join(tmpdir(), 'budget-disposition-')); roots.push(root)
    const path = join(root, 'journal.sqlite')
    let { db, journal } = setup(path)
    const fixture = await reviewedBudgetReport(db, journal)
    let report = journal.read('acme/repo#99')!
    const source = journal.read('acme/repo#7')!
    const binding = implementationReportBinding(db, report)
    expect(binding).toMatchObject({ source: source.id,
      attempts: source.invocations.map(invocation => ({ invocation: invocation.id, call: invocation.callId })) })
    expect(binding?.attempts).toHaveLength(3)
    if (kind === 'missing') {
      const observation = await fixture.overrides.observe(report)
      const admission = await implementationReportAdmission(db, journal, report, observation, fixture.overrides.observe)
      expect(admission.reason).toContain('awaits a current explicit')
    } else {
      await setImplementationReportDisposition(db, journal, report, report.sequence, binding, {
        kind, review: fixture.review, commentId: 700,
        diagnosis: kind === 'distinct-fix' ? 'Verified shared defect in tracked main code; independently implementable.'
          : 'The three timeouts exist only in the unpublished source candidate.',
        nextAction: 'Inspect the original Calls; recover the source evidence, then explicitly Resume when safe.' })
    }
    const original = journal.read(source.id)!
    const intent = reports(db)
    journal.rebuild()
    db.close(); databases.splice(databases.indexOf(db), 1)
    ;({ db, journal } = setup(path))
    vi.stubEnv('POISE_REPAIR_EXHAUSTION_REPOSITORIES', '')
    await new BehaviorChainRuntime(journal, operations(db, journal, fixture.overrides)).run()
    const current = journal.read('acme/repo#99')!
    if (kind === 'distinct-fix') {
      expect(fixture.request).toHaveBeenCalledOnce()
      expect(fixture.launch).toHaveBeenCalledOnce()
      expect(current.invocations.at(-1)?.behavior).toBe('implement-issue')
    } else {
      expect(fixture.request).not.toHaveBeenCalled()
      expect(fixture.launch).not.toHaveBeenCalled()
      expect(current.invocations.some(item => item.behavior === 'implement-issue')).toBe(false)
      expect(current.waiting).toContain(kind === 'source-only' ? 'source-only disposition' : 'awaits a current explicit')
      if (kind === 'source-only') {
        for (const invocation of source.invocations) expect(current.waiting).toContain(invocation.callId!)
      }
    }
    expect(journal.read(original.id)).toMatchObject({ held: original.held, resumedAfterSequence: original.resumedAfterSequence,
      invocations: original.invocations })
    expect(reports(db)).toEqual(intent)
    expect(posts()).toHaveLength(1)
  })

it('blocks budget report implementation when the acknowledgement was lost', async () => {
  const { db, journal } = setup()
  const fixture = await reviewedBudgetReport(db, journal)
  const stored = JSON.parse(reports(db)[0].value)
  stored.issueNumber = null
  db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify(stored), `behavior_chain_repair_report:${stored.key}`)
  expect(implementationReportBinding(db, journal.read('acme/repo#99')!)).toBeNull()
  vi.stubEnv('POISE_REPAIR_EXHAUSTION_REPOSITORIES', '')
  const ops = operations(db, journal, { ...fixture.overrides, readInvocations: async () => ({ entries: [], quarantined: [] }) })
  await new BehaviorChainRuntime(journal, ops).run()
  expect(fixture.request).not.toHaveBeenCalled()
  expect(fixture.launch).not.toHaveBeenCalled()
  const current = journal.read('acme/repo#99')!
  expect(current.invocations.some(item => item.behavior === 'implement-issue')).toBe(false)
  expect(current.waiting).toContain('awaits a current explicit')
  expect(JSON.parse(reports(db)[0].value).issueNumber).toBe(99)
  expect(posts()).toHaveLength(1)
})

it.each(['new report', 'lost acknowledgement', 'closed markerless link'])('reports an unheld uncertain implementation once across restart: %s', async mode => {
  const root = mkdtempSync(join(tmpdir(), 'uncertain-implementation-report-')); roots.push(root)
  const path = join(root, 'journal.sqlite')
  const initial = setup(path)
  const { chain, call } = uncertainImplementation(initial.journal)
  expect(chain).toMatchObject({ held: null, invocations: [{ state: 'started', callId: null }] })
  if (mode === 'closed markerless link') {
    const existing = issue(98, `The #7 implementation remains uncertain after the original Call \`${call.id}\` (correlation \`${call.correlation_id}\`) failed during publication. The retained artifact names phase \`publishing\`. The Call has positive resource release, no action result and no publication receipt. Reconcile that original push outcome.`)
    existing.state = 'closed'; existing.user.login = 'reviewer'; remote.push(existing)
    sourceComments = [{ author: 'author', body: 'The original publication is fenced; see https://github.com/acme/repo/issues/98.' }]
    searchVisible = false
  }
  loseCreation = mode === 'lost acknowledgement'
  const launch = vi.fn(async () => { throw new Error('must not replace the original implementation') })
  const resumePublication = vi.fn(async () => { throw new Error('must not repeat the original push') })
  const overrides = { launch, resumePublication, observe: async () => ({ ...fresh, checkedAt: Date.now() }),
    readInvocations: async () => ({ entries: [call], quarantined: [] }) }
  await new BehaviorChainRuntime(initial.journal, operations(initial.db, initial.journal, overrides)).run()
  expect(posts()).toHaveLength(mode === 'closed markerless link' ? 0 : 1)
  if (mode !== 'closed markerless link') {
    expect(remote[0].title).toBe('fix: uncertain implementation publication for #7')
    for (const fact of ['https://github.com/acme/repo/issues/7', `Invocation ${call.correlation_id}`, `Caller ${call.id}`,
      'implementation_publication_uncertain', 'atomic_work_failed', 'Missing original evidence:',
      'pre-push no-write checkpoint or conclusive push result', 'GitHub absence alone cannot settle',
      'authorizes neither replacement implementation nor a second push', REMEDIATION_SCOPE]) expect(remote[0].body).toContain(fact)
    expect(remote[0].body).not.toMatch(/Resume|fresh implementation|private provider output|\/private\/work/)
  }
  const original = initial.journal.read(chain.id)!.invocations
  expect(original).toMatchObject([{ id: call.correlation_id, state: 'uncertain', callId: null,
    evidence: { callId: call.id, artifact: call.artifact, resource_ownership: call.resource_ownership } }])
  initial.db.close(); databases.splice(databases.indexOf(initial.db), 1)
  const { db, journal } = setup(path)
  journal.rebuild()
  searchVisible = false; sourceComments = []
  for (let pass = 0; pass < 2; pass++) {
    await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
    expect(journal.read(chain.id)!.waiting).toContain('pre-push no-write checkpoint or conclusive push result')
    if (mode === 'lost acknowledgement') expect(journal.read(chain.id)!.waiting).toContain('creation is unconfirmed')
  }
  if (mode === 'lost acknowledgement') {
    searchVisible = true; remote[0].state = 'closed'
    await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  }
  expect(posts()).toHaveLength(mode === 'closed markerless link' ? 0 : 1)
  expect(reports(db).map(row => JSON.parse(row.value))).toMatchObject([{
    key: chainBasis(['implementation_publication_uncertain', chain.id, call.correlation_id]),
    source: chain.id, pull: null, head: null, holdSequence: null, heldAt: null,
    attempts: [{ invocation: call.correlation_id, call: call.id }], issueNumber: mode === 'closed markerless link' ? 98 : 99,
  }])
  expect(journal.read(chain.id)).toMatchObject({ held: null, mergeSha: null, resumedAfterSequence: 0, invocations: original })
  if (mode !== 'new report') expect(journal.read(chain.id)!.waiting).toContain('is closed; no replacement')
  expect(launch).not.toHaveBeenCalled(); expect(resumePublication).not.toHaveBeenCalled()
})

it.each(['mere reference', 'different source', 'different invocation', 'different Call', 'different failure', 'untrusted author', 'PR', 'empty body'])('does not adopt an unrelated uncertain implementation report: %s', async change => {
  const { db, journal } = setup()
  const { call } = uncertainImplementation(journal)
  let body = `The #7 implementation remains uncertain after Call ${call.id}, invocation ${call.correlation_id}; no conclusive push result or publication receipt is available.`
  if (change === 'mere reference') body = `Reference #7, Call ${call.id}, invocation ${call.correlation_id}.`
  if (change === 'different source') body = body.replace('#7', '#8')
  if (change === 'different invocation') body = body.replace(call.correlation_id!, call.correlation_id! + '-other')
  if (change === 'different Call') body = body.replace(call.id, 'f'.repeat(32))
  if (change === 'different failure') body = `The #7 implementation remains uncertain after Call ${call.id}, invocation ${call.correlation_id}; test resources have not settled.`
  const linked = issue(98, body)
  linked.state = 'closed'
  if (change === 'untrusted author') linked.user.login = 'stranger'
  if (change === 'PR') Object.assign(linked, { pull_request: {}, html_url: 'https://github.com/acme/repo/pull/98' })
  if (change === 'empty body') Object.assign(linked, { body: null })
  remote.push(linked); searchVisible = false
  sourceComments = [{ author: 'reviewer', body: 'See https://github.com/acme/repo/issues/98.' }]
  await new BehaviorChainRuntime(journal, operations(db, journal, { observe: async () => fresh,
    readInvocations: async () => ({ entries: [call], quarantined: [] }) })).run()
  expect(posts()).toHaveLength(1)
  expect(reports(db).map(row => JSON.parse(row.value).issueNumber)).toEqual([99])
})

it.each(['running Call', 'pending resources', 'missing ownership', 'missing Call', 'missing terminal time',
  'closed source', 'closed native source', 'ineligible source', 'unknown eligibility', 'published original', 'published different Call',
  'pre-push no-write result', 'conclusive receipt', 'not publishing', 'unavailable verification', 'disabled'])('defers uncertain implementation reporting for %s', async change => {
  const { db, journal } = setup()
  const { chain, call } = uncertainImplementation(journal)
  if (change === 'running Call') { call.status = 'running'; call.completed_at = null; call.resources_settled_at = null }
  if (change === 'pending resources') call.resources_settled_at = null
  if (change === 'missing ownership') call.resource_ownership = null
  if (change === 'missing terminal time') call.completed_at = null
  if (change === 'closed source') fresh.issue.open = false
  if (change === 'closed native source') seedState = 'closed'
  if (change === 'ineligible source') fresh.issue.eligible = false
  if (change === 'unknown eligibility') Reflect.deleteProperty(fresh.issue, 'eligible')
  if (change === 'published original' || change === 'published different Call') {
    fresh.publication = { ...observation().publication, head_invocation: change === 'published original' ? call.id : 'e'.repeat(32) }
    fresh.pull = observation().pull
  }
  if (change === 'pre-push no-write result') { call.action = 'not_started'; call.outcome = 'preflight_failed' }
  if (change === 'conclusive receipt') { call.action = 'published'; call.outcome = 'published'; call.head_sha = HEAD }
  if (change === 'not publishing') call.artifact = { phase: 'executing' }
  if (change === 'unavailable verification') stale = true
  if (change === 'disabled') vi.stubEnv('POISE_REPAIR_EXHAUSTION_REPOSITORIES', '')
  await new BehaviorChainRuntime(journal, operations(db, journal, { discover: async () => [], observe: async () => fresh,
    readInvocations: async () => ({ entries: change === 'missing Call' ? [] : [call], quarantined: [] }) })).run()
  expect(posts()).toHaveLength(0); expect(reports(db)).toHaveLength(0)
  expect(journal.read(chain.id)!.invocations).toHaveLength(1)
})

it('rechecks the original uncertain implementation before reserving report intent', async () => {
  const { db, journal } = setup()
  const { chain, call } = uncertainImplementation(journal)
  await new BehaviorChainRuntime(journal, operations(db, journal, { reportHold: undefined, observe: async () => fresh,
    readInvocations: async () => ({ entries: [call], quarantined: [] }) })).run()
  const source = journal.read(chain.id)!
  await reportRepairExhaustion(db, journal, source, async () => {
    record(journal, source, { type: 'invocation.reconciled', invocationId: call.correlation_id!, evidence: { head_sha: HEAD } })
    return fresh
  }, () => true)
  expect(posts()).toHaveLength(0); expect(reports(db)).toHaveLength(0)
})

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

it.each(['legacy', 'diagnostic omissions', 'wrapped diagnostic', 'execution budget'])('reports a pre-existing %s hold and verifies ordinary admission', async mode => {
  const { db, journal } = setup()
  const budget = mode === 'execution budget'
  const omissions = [1, 2, 3].map(n => `${LEGACY}: missing_root_comment_ids=[${Array.from({ length: n }, (_, i) => n * 10 + i).join(', ')}]; missing_count=${n}; required_count=6`)
  const errors = budget ? BUDGET_ERRORS : mode === 'diagnostic omissions' ? omissions
    : mode === 'wrapped diagnostic' ? omissions.map(reason => `atomic behavior failed during validating_publication: ${reason} (agent_interface.atomic_work.run)`) : undefined
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
  expect(remote[0].body).toContain('Next action: inspect the PR review timeouts and source receipts')
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

it('shares an existing review report between legacy and v2 owners', async () => {
  const { db, journal } = setup()
  const source = record(journal, await exhaustedReviews(journal), { type: 'chain.observed', observation: fresh })
  await operations(db, journal).reportHold!(source)
  expect(posts()).toHaveLength(1)
  const hold = journal.read(source.id)
  const legacy = { repository: source.repository, pull: 21, author: source.author, reviewer: source.reviewer,
    behavior: 'review-new-prs' as const, target: 'acme/repo#21', head: HEAD, slot: 'primary', heldAt: NOW, attempts: [] }
  expect(await reportLegacyReviewTimeout(db, journal, legacy, async () => false, () => true))
    .toContain('https://github.com/acme/repo/issues/99')
  // A report created by legacy has the PR identity rather than the chain seed.
  const stored = reports(db)[0]
  const report = JSON.parse(stored.value)
  db.prepare('DELETE FROM meta WHERE key = ?').run(`behavior_chain_repair_report:${report.key}`)
  report.source = 'acme/repo#21'
  report.key = chainBasis(['review_budget_exhausted', report.source, 21])
  remote[0].body = remote[0].body.replace(/<!-- poise-repair-exhaustion:[a-f0-9]{64} -->/,
    `<!-- poise-repair-exhaustion:${report.key} -->`)
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run(`behavior_chain_repair_report:${report.key}`, JSON.stringify(report))
  await operations(db, journal).reportHold!(source)
  journal.rebuild()
  await operations(db, journal).reportHold!(journal.read(source.id)!)
  expect(posts()).toHaveLength(1)
  expect(reports(db)).toHaveLength(1)
  expect(journal.read(source.id)).toEqual(hold)
})

it('reports mixed native PR review timeouts after Resume once across observations and restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-report-')); roots.push(root)
  const path = join(root, 'journal.sqlite')
  const initial = setup(path)
  const earlier = await exhaustedReviews(initial.journal)
  const resumed = record(initial.journal, earlier, { type: 'chain.resumed' })
  const source = await exhaustedReviews(initial.journal, MIXED_REVIEW_FAILURES)
  expect(source.resumedAfterSequence).toBe(resumed.sequence)
  expect(source.invocations).toHaveLength(6)

  const incomplete = structuredClone(source)
  incomplete.observation = structuredClone(fresh)
  incomplete.invocations.pop()
  await operations(initial.db, initial.journal).reportHold!(incomplete)
  expect(posts()).toHaveLength(0)
  expect(reports(initial.db)).toHaveLength(0)

  const overrides = { observe: async () => ({ ...fresh, checkedAt: Date.now() }) }
  const runtime = new BehaviorChainRuntime(initial.journal, operations(initial.db, initial.journal, overrides))
  await runtime.run()
  expect(posts()).toHaveLength(1)
  expect(remote[0].body).toContain(`hold event ${source.sequence}; head ${HEAD}; basis ${source.invocations.at(-1)!.basis}; slot primary`)
  expect(remote[0].body).toContain('Cause: review_budget_exhausted or review_inspection_timeout.')
  for (const [index, invocation] of source.invocations.slice(3).entries()) {
    const line = remote[0].body.split('\n').find(line => line.startsWith(`- Invocation ${invocation.id};`))!
    expect(line).toContain(`Caller ${MIXED_REVIEW_FAILURES[index].callId}`)
    expect(line).toContain(`error_code=${MIXED_REVIEW_FAILURES[index].error_code}`)
    expect(line).toContain(index === 1 ? 'operation=github-interface; phase=inspection; timeout_seconds=30'
      : index === 2 ? 'operation=provider.review; phase=file_group; timeout_seconds=60'
        : 'operation=unknown; phase=unknown; timeout_seconds=unknown')
  }
  for (const invocation of earlier.invocations) expect(remote[0].body).not.toContain(invocation.id)
  for (const failure of MIXED_REVIEW_FAILURES) expect(remote[0].body).not.toContain(failure.error)
  expect(remote[0].body).not.toMatch(/private inspection|\/private\/work|--requests-json/)
  expect(remote[0].body).toContain(`<!-- poise-repair-exhaustion:${chainBasis(['review_budget_exhausted', source.id, 21])} -->`)
  expect(remote[0].body).toContain('does not recover review or relax any review, admission or merge gate')
  expect(initial.journal.read(source.id)).toMatchObject({ held: source.held, resumedAfterSequence: resumed.sequence, invocations: source.invocations })
  vi.setSystemTime(Date.now() + 86_400_000)
  await runtime.run()
  initial.db.close(); databases.splice(databases.indexOf(initial.db), 1)
  const { db, journal } = setup(path)
  journal.rebuild()
  vi.setSystemTime(Date.now() + 86_400_000)
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  expect(posts()).toHaveLength(1)
  expect(reports(db)).toHaveLength(1)
  expect(journal.read(source.id)).toMatchObject({ held: source.held, resumedAfterSequence: resumed.sequence, invocations: source.invocations })
})

it.each([
  { code: 'review_provider_exit', position: 0 },
  { code: 'review_provider_exit', position: 2 },
  { code: 'authentication_failed', position: 0 },
  { code: 'authentication_failed', position: 2 },
])('reports mixed PR review timeouts with $code at position $position once across restart', async ({ code, position }) => {
  const root = mkdtempSync(join(tmpdir(), 'mixed-review-report-')); roots.push(root)
  const path = join(root, 'journal.sqlite')
  const initial = setup(path)
  type ReviewFailure = Pick<LogEntry, 'error' | 'error_code' | 'diagnostic'> & { callId: string }
  const fileGroup: ReviewFailure = { callId: '4672ce8cf3384703881e05bf08d9d5ed', error_code: 'review_budget_exhausted',
    error: 'Review file-group time limit reached; incomplete analysis; reduce the review scope',
    diagnostic: { version: 1, source: 'caller', severity: 'error', operation: 'provider.review', phase: 'file_group',
      outcome: 'timed_out', stderr: '', stderr_truncated: false,
      context: { submission: 'none', timeout_seconds: 60 }, filesystem: null } }
  const overall: ReviewFailure = { callId: '5bfab39a3e9e46978b36f0a728385a33', error_code: 'review_budget_exhausted',
    error: 'Review reached its total time limit; needs attention',
    diagnostic: { version: 1, source: 'caller', severity: 'error', operation: 'provider.review', phase: 'overall',
      outcome: 'timed_out', stderr: '', stderr_truncated: false,
      context: { submission: 'none', timeout_seconds: 1413 }, filesystem: null } }
  const provider: ReviewFailure = { callId: 'd16f8f29e3a44fac8b72674e8e3ec23e', error_code: code,
    error: code === 'review_provider_exit' ? 'codex review failed: refresh rejected' : 'Codex refresh token was already used',
    diagnostic: { version: 1, source: 'caller', severity: 'error', operation: 'provider.review', phase: 'provider_execution',
      outcome: 'exit', stderr: code === 'review_provider_exit' ? 'codex review failed: refresh rejected' : 'Codex refresh token was already used',
      stderr_truncated: false, context: { submission: 'none', exit_code: 1 }, filesystem: null } }
  const timeouts = [fileGroup, overall]
  const failures = position === 0 ? [provider, ...timeouts] : [...timeouts, provider]
  const source = await exhaustedReviews(initial.journal, failures)
  expect(source.invocations).toHaveLength(3)
  const overrides = { observe: async () => ({ ...fresh, checkedAt: Date.now() }) }
  const runtime = new BehaviorChainRuntime(initial.journal, operations(initial.db, initial.journal, overrides))
  await runtime.run()
  expect(posts()).toHaveLength(1)
  expect(remote[0].title).toBe('fix: PR review exhausted its time limits for #21')
  expect(remote[0].body).toContain(`hold event ${source.sequence}; head ${HEAD}; basis ${source.invocations[0].basis}; slot primary`)
  const expectedCauses = position === 0 ? `${code} or review_budget_exhausted` : `review_budget_exhausted or ${code}`
  expect(remote[0].body).toContain(`Cause: ${expectedCauses}.`)
  expect(remote[0].body).toContain('Last timeout phase: overall; terminal attempt: '
    + (position === 0 ? 'review_budget_exhausted' : code) + '.')
  for (const [index, invocation] of source.invocations.entries()) {
    const line = remote[0].body.split('\n').find(line => line.startsWith(`- Invocation ${invocation.id};`))!
    expect(line).toContain(`Caller ${failures[index].callId}`)
    expect(line).toContain(`error_code=${failures[index].error_code}`)
    const expected = failures[index] === provider
      ? 'operation=provider.review; phase=provider_execution; timeout_seconds=unknown'
      : failures[index] === fileGroup
        ? 'operation=provider.review; phase=file_group; timeout_seconds=60'
        : 'operation=provider.review; phase=overall; timeout_seconds=1413'
    expect(line).toContain(expected)
  }
  for (const failure of failures) expect(remote[0].body).not.toContain(failure.error)
  expect(remote[0].body).not.toMatch(/\/private\/work|refresh token was already used: .*token/i)
  expect(remote[0].body).toContain(`<!-- poise-repair-exhaustion:${chainBasis(['review_budget_exhausted', source.id, 21])} -->`)
  expect(remote[0].body).toContain('does not recover review or relax any review, admission or merge gate')
  expect(initial.journal.read(source.id)).toMatchObject({ held: source.held, invocations: source.invocations })
  vi.setSystemTime(Date.now() + 86_400_000)
  await runtime.run()
  initial.db.close(); databases.splice(databases.indexOf(initial.db), 1)
  const { db, journal } = setup(path)
  journal.rebuild()
  vi.setSystemTime(Date.now() + 86_400_000)
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  expect(posts()).toHaveLength(1)
  expect(reports(db)).toHaveLength(1)
  expect(journal.read(source.id)).toMatchObject({ held: source.held, invocations: source.invocations })
})

it.each(['operator hold', 'changed basis', 'provider-only', 'submitting_review provider', 'provider receipt',
  'other provider code', 'missing provider diagnostic', 'missing submission'])(
  'does not report mixed PR review exhaustion with %s', async change => {
    const { db, journal } = setup()
    type ReviewFailure = Pick<LogEntry, 'error' | 'error_code' | 'diagnostic'> & { callId: string }
    const timeout = (callId: string, phase: string, timeout_seconds: number): ReviewFailure => ({ callId,
      error_code: 'review_budget_exhausted', error: phase === 'file_group'
        ? 'Review file-group time limit reached; incomplete analysis; reduce the review scope'
        : 'Review reached its total time limit; needs attention',
      diagnostic: { version: 1, source: 'caller', severity: 'error', operation: 'provider.review', phase,
        outcome: 'timed_out', stderr: '', stderr_truncated: false,
        context: { submission: 'none', timeout_seconds }, filesystem: null } })
    const providerFailure = (error_code: string, callId = 'd16f8f29e3a44fac8b72674e8e3ec23e'): ReviewFailure => ({ callId, error_code,
      error: error_code === 'review_provider_exit' ? 'codex review failed: refresh rejected' : 'Codex refresh token was already used',
      diagnostic: { version: 1, source: 'caller', severity: 'error', operation: 'provider.review', phase: 'provider_execution',
        outcome: 'exit', stderr: 'provider rejected the review', stderr_truncated: false,
        context: { submission: 'none', exit_code: 1 }, filesystem: null } })
    const failures = change === 'provider-only'
      ? [providerFailure('review_provider_exit', 'd16f8f29e3a44fac8b72674e8e3ec23e'),
        providerFailure('authentication_failed', '4672ce8cf3384703881e05bf08d9d5ed'),
        providerFailure('review_provider_exit', '5bfab39a3e9e46978b36f0a728385a33')]
      : [providerFailure('review_provider_exit'), timeout('4672ce8cf3384703881e05bf08d9d5ed', 'file_group', 60),
        timeout('5bfab39a3e9e46978b36f0a728385a33', 'overall', 1413)]
    let held = await exhaustedReviews(journal, failures)
    if (change === 'operator hold') held = record(journal, held, { type: 'chain.held', reason: 'New invocations held by the person' })
    const chain = structuredClone(held)
    chain.observation = structuredClone(fresh)
    const provider = chain.invocations[change === 'provider-only' ? 1 : 0]
    if (change === 'changed basis') fresh.pull!.reviewContext = chainBasis('edited title, body or base')
    if (change === 'submitting_review provider') provider.evidence!.artifact = { phase: 'submitting_review', expected_head: HEAD }
    if (change === 'provider receipt') provider.evidence!.review_id = 123
    if (change === 'other provider code') provider.evidence!.error_code = 'review_provider_error'
    if (change === 'missing provider diagnostic') provider.evidence!.diagnostic = null
    if (change === 'missing submission') (provider.evidence!.diagnostic as { context: { submission: string } }).context.submission = 'uncertain'
    await operations(db, journal).reportHold!(chain)
    expect(posts()).toHaveLength(0)
    expect(reports(db)).toHaveLength(0)
    expect(journal.read(chain.id)?.held).toBe(chain.held)
  })

it.each(['missing', 'source-only', 'distinct-fix', 'approval-basis', 'hold', 'attempt-list', 'preparation', 'admission', 'launch', 'unlaunched', 'account-switch'] as const)(
  'gates the actual approval deadline report through lost acknowledgement, review and restart (%s)', async kind => {
  const root = mkdtempSync(join(tmpdir(), 'approval-report-')); roots.push(root)
  const path = join(root, 'journal.sqlite')
  const initial = setup(path)
  const reviewExhausted = await exhaustedReviews(initial.journal)
  const reviewOverrides = { observe: async () => ({ ...fresh, checkedAt: Date.now() }) }
  await new BehaviorChainRuntime(initial.journal, operations(initial.db, initial.journal, reviewOverrides)).run()
  expect(posts()).toHaveLength(1)
  expect(remote[0].title).toContain('review')
  const reviewKey = chainBasis(['review_budget_exhausted', reviewExhausted.id, 21])
  expect(remote[0].body).toContain(`<!-- poise-repair-exhaustion:${reviewKey} -->`)
  const resumed = record(initial.journal, initial.journal.read(reviewExhausted.id)!, { type: 'chain.resumed' })
  const source = await exhaustedApprovals(initial.journal)
  expect(source.resumedAfterSequence).toBe(resumed.sequence)
  expect(source.invocations).toHaveLength(6)
  const approvals = source.invocations.slice(3)
  for (const invocation of approvals) {
    expect(invocation).toMatchObject({ behavior: 'approve-pr', actor: 'reviewer', slot: 'primary' })
    expect(invocation.request.context).toBeUndefined()
    expect(invocation.request.argv[0]).toBe('--pr-approve')
    expect(invocation.request.argv).not.toContain('--expected-issue-revision')
    expect(invocation.request.argv[invocation.request.argv.indexOf('--expected-head') + 1]).toBe(HEAD)
  }
  expect(source.held).toContain('approve-pr failed before publication three times')
  loseCreation = true
  const observe = async (chain: BehaviorChain) => chain.issue === 7 ? { ...fresh, checkedAt: Date.now() } : {
    ...unpublished(), issue: { open: true, eligible: true, revision: chainBasis([remote.find(row => row.number === chain.issue)!.title,
      remote.find(row => row.number === chain.issue)!.body]), commentIds: [700] },
    issueReviewers: chain.issue === 100 ? [reviewer] : [], prerequisites: { wait: null, base: HEAD, evidence: [] } }
  const overrides = { observe }
  const runtime = new BehaviorChainRuntime(initial.journal, operations(initial.db, initial.journal, overrides))
  await runtime.run()
  expect(posts()).toHaveLength(2)
  const stored = reports(initial.db).map(row => JSON.parse(row.value))
  expect(stored).toHaveLength(2)
  const approvalKey = chainBasis(['approval_budget_exhausted', source.id, 21])
  expect(approvalKey).not.toBe(reviewKey)
  const approvalIntent = stored.find(report => report.key === approvalKey)!
  expect(approvalIntent).toMatchObject({ source: source.id, pull: 21, holdSequence: source.sequence, head: HEAD,
    basis: approvals[0].basis, slot: 'primary', issueNumber: null })
  expect(remote[1].labels).toEqual([{ name: 'poise' }])
  expect(remote[1].title).toContain('approval')
  expect(remote[1].body).toContain('Stage: approve-pr. Cause: review_budget_exhausted.')
  expect(remote[1].body).toContain('PR approvals on this basis')
  expect(remote[1].body).toContain('approval submission with review_budget_exhausted, action=not_started, outcome=preflight_failed')
  expect(remote[1].body).toContain('Next action: inspect the PR approval timeouts and source receipts')
  expect(remote[1].body).toContain('does not recover approval or relax any review, admission or merge gate')
  expect(remote[1].body).toContain(`hold event ${source.sequence}; head ${HEAD}; basis ${approvals[0].basis}; slot primary`)
  for (const invocation of approvals) expect(remote[1].body).toContain(`Invocation ${invocation.id}; Caller ${invocation.callId}; completed`)
  for (const invocation of reviewExhausted.invocations) expect(remote[1].body).not.toContain(invocation.id)
  for (const error of REVIEW_ERRORS) expect(remote[1].body).not.toContain(error)
  expect(remote[1].body.split(REMEDIATION_SCOPE)).toHaveLength(2)
  expect(remote[1].body.endsWith('Include this exact paragraph in the linked PR review.')).toBe(true)
  expect(remote[1].body).toContain(`<!-- poise-repair-exhaustion:${approvalKey} -->`)
  expect(initial.journal.read(source.id)).toMatchObject({ held: source.held, resumedAfterSequence: resumed.sequence, invocations: source.invocations })

  // Intake sees the published issue before the source publisher reconciles its lost acknowledgement.
  indexed = true
  const request = vi.fn(async (chain: BehaviorChain, observation: ChainObservation, decision: { behavior: string }) => ({
    command: 'agent-interface' as const, cwd: '/fixture', argv: [decision.behavior === 'review-issue' ? '--issue-review' : '--atomic-work',
      chain.id, '--model', 'fixture', '--expected-issue-revision', observation.issue.revision] }))
  const launch = vi.fn(async () => true)
  let entries: LogEntry[] = []
  const intakeOverrides = { observe, request, launch, available: () => true,
    // Use the production exhaustion fence; the earlier review report is outside this issue's scope.
    permitted: (chain: BehaviorChain, decision: { behavior: Parameters<typeof repairReportImplementationFence>[2] }) =>
      chain.issue !== 99 && !repairReportImplementationFence(initial.db, chain, decision.behavior),
    reportHold: async () => null, readInvocations: async () => ({ entries, quarantined: [] }) } as
    Parameters<typeof operations>[2] & { accounts?: () => { author: string, reviewer: string } }
  if (kind === 'account-switch') {
    // The configured author changes after GitHub accepts the report POST but before intake.
    mocks.accounts = { me: 'new-author', agentAccount: 'reviewer' }
    intakeOverrides.accounts = () => ({ author: 'new-author', reviewer: 'reviewer' })
  }
  await new BehaviorChainRuntime(initial.journal, operations(initial.db, initial.journal, intakeOverrides)).run()
  let report = initial.journal.read('acme/repo#100')!
  const review = report.invocations.at(-1)!
  expect(review).toMatchObject({ behavior: 'review-issue', state: 'started' })
  expect(JSON.parse(reports(initial.db).find(row => JSON.parse(row.value).key === approvalKey)!.value).issueNumber).toBeNull()
  entries = [{ id: 'b'.repeat(32), correlation_id: review.id, source: 'poise:behavior-chain', repo: 'acme/repo', pr_id: '100',
    actor: 'reviewer', model: 'fixture', behavior: 'issue_review', session_id: null, prompt: '', response: null,
    started_at: new Date(review.admittedAt).toISOString(), completed_at: new Date(NOW).toISOString(), time_elapsed: '1s',
    status: 'completed', action: 'commented', outcome: 'commented', error: '', error_code: null, head_sha: null, expected_head: null,
    resources_settled_at: new Date(NOW).toISOString(), resource_ownership: { version: 1, roots: [], errors: [] },
    issue_revision: (await observe(report)).issue.revision,
    receipts: [{ issue: report.id, comment_id: 700, author: 'reviewer', url: 'https://github.com/acme/repo/issues/100#issuecomment-700' }] }]
  request.mockClear(); launch.mockClear()
  await new BehaviorChainRuntime(initial.journal, operations(initial.db, initial.journal, intakeOverrides)).run()
  report = initial.journal.read(report.id)!
  expect(report.invocations).toMatchObject([{ behavior: 'review-issue', state: 'settled', outcome: 'commented' }])
  expect(request).not.toHaveBeenCalled()
  expect(launch).not.toHaveBeenCalled()
  expect(report.waiting).toContain('Approval deadline report awaits a current explicit')
  if (kind === 'account-switch') {
    expect(report.author).toBe('new-author')
    expect(report.waiting).toContain('verification unavailable')
    expect(implementationReportBinding(initial.db, report)).toBeNull()
    expect(JSON.parse(reports(initial.db).find(row => JSON.parse(row.value).key === approvalKey)!.value).issueNumber).toBeNull()
  } else {
    expect(implementationReportBinding(initial.db, report)).toMatchObject({ key: approvalKey, source: source.id, disposition: null })
    expect(JSON.parse(reports(initial.db).find(row => JSON.parse(row.value).key === approvalKey)!.value).issueNumber).toBe(100)
  }

  const disposition = { kind: kind === 'source-only' ? 'source-only' : 'distinct-fix', review: review.id, commentId: 700,
    diagnosis: 'Inspect the original approval Calls; separately verified defect requires a distinct fix.',
    nextAction: 'Keep source approval held until an explicit Resume; retain approval and merge gates.' }
  if (kind !== 'missing' && kind !== 'unlaunched' && kind !== 'account-switch') {
    await setImplementationReportDisposition(initial.db, initial.journal, report, report.sequence,
      implementationReportBinding(initial.db, report), disposition)
  }
  if (kind === 'approval-basis') {
    fresh.pull!.reviewRevision = chainBasis('changed approval basis on the same head')
    record(initial.journal, initial.journal.read(source.id)!, { type: 'chain.observed', observation: fresh })
  }
  if (kind === 'hold') record(initial.journal, initial.journal.read(source.id)!, { type: 'chain.held', reason: source.held! })
  if (kind === 'attempt-list') {
    const row = reports(initial.db).find(row => JSON.parse(row.value).key === approvalKey)!
    const intent = JSON.parse(row.value)
    intent.attempts.pop()
    initial.db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify(intent), `behavior_chain_repair_report:${approvalKey}`)
  }
  if (['approval-basis', 'hold', 'attempt-list'].includes(kind)) {
    report = initial.journal.read(report.id)!
    await expect(setImplementationReportDisposition(initial.db, initial.journal, report, report.sequence,
      implementationReportBinding(initial.db, report), disposition)).rejects.toThrow('Original blocked hold or Call changed')
  }
  if (kind === 'unlaunched') {
    report = initial.journal.read(report.id)!
    record(initial.journal, report, { type: 'invocation.admitted', invocation: { id: 'old-report-implementation', behavior: 'implement-issue',
      actor: 'author', basis: chainBasis(['issue', (await observe(report)).issue.revision]), model: 'fixture', slot: reviewer.slot,
      admittedAt: NOW - 20_000, request: { command: 'agent-interface', cwd: '/fixture', argv: [] } } })
  }
  await runtime.run()
  expect(posts()).toHaveLength(2)
  initial.db.close(); databases.splice(databases.indexOf(initial.db), 1)
  const { db, journal } = setup(path)
  journal.rebuild()
  vi.setSystemTime(Date.now() + 86_400_000)
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
  expect(posts()).toHaveLength(2)
  const reconciled = reports(db).map(row => JSON.parse(row.value))
  expect(reconciled.find(report => report.key === reviewKey)).toMatchObject({ issueNumber: 99 })
  expect(reconciled.find(report => report.key === approvalKey)).toMatchObject(
    kind === 'account-switch' ? { issueNumber: null } : { issueNumber: 100 })
  expect(journal.read(source.id)).toMatchObject({ held: source.held, resumedAfterSequence: resumed.sequence, invocations: source.invocations })
  expect(decideBehaviorChain(journal.read(source.id)!, { ...fresh, checkedAt: Date.now() }, Date.now())).toMatchObject({ kind: 'wait', reason: source.held })

  vi.stubEnv('POISE_REPAIR_EXHAUSTION_REPOSITORIES', '')
  const replaceHold = () => {
    const current = journal.read(source.id)!
    record(journal, current, { type: 'chain.held', reason: current.held! })
  }
  const ops = operations(db, journal, { ...intakeOverrides,
    permitted: (chain, decision) => chain.issue !== 99 && !repairReportImplementationFence(db, chain, decision.behavior) })
  if (kind === 'preparation') ops.request = async (chain, observation, decision) => { replaceHold(); return request(chain, observation, decision) }
  if (kind === 'admission') {
    const admission = ops.implementationAdmission!
    ops.implementationAdmission = async (...args) => {
      const result = await admission(...args)
      if (result.source && request.mock.calls.length) replaceHold()
      return result
    }
  }
  if (kind === 'launch') ops.launch = async (_invocation, _onExit, allowed) => {
    replaceHold(); expect(allowed()).toBe(false); return false
  }
  if (kind === 'distinct-fix' || kind === 'account-switch') remote.push({ ...issue(101, 'Plain issue'), labels: [{ name: 'poise' }] })
  if (kind === 'account-switch') {
    const empty = issue(102, '')
    Object.assign(empty, { body: null })
    empty.labels = [{ name: 'poise' }]
    remote.push(empty)
  }
  await new BehaviorChainRuntime(journal, ops).run()
  const current = journal.read(report.id)!
  if (kind === 'distinct-fix') {
    expect(request.mock.calls.map(call => call[0].issue).sort()).toEqual([100, 101])
    expect(launch).toHaveBeenCalledTimes(2)
    expect(current.invocations.at(-1)).toMatchObject({ behavior: 'implement-issue', state: 'started',
      request: { implementationSource: { id: source.id } } })
    expect(journal.read('acme/repo#101')?.invocations.at(-1)).toMatchObject({ behavior: 'implement-issue', state: 'started' })
  } else if (kind === 'account-switch') {
    expect(request.mock.calls.map(call => call[0].issue).sort()).toEqual([101, 102])
    expect(launch).toHaveBeenCalledTimes(2)
    expect(current.invocations.some(item => item.behavior === 'implement-issue')).toBe(false)
    expect(current.waiting).toContain('Approval deadline report awaits a current explicit')
    expect(current.waiting).toContain('verification unavailable')
    expect(JSON.parse(reports(db).find(row => JSON.parse(row.value).key === approvalKey)!.value).issueNumber).toBeNull()
    expect(journal.read('acme/repo#101')?.invocations.at(-1)).toMatchObject({ behavior: 'implement-issue', state: 'started' })
    expect(journal.read('acme/repo#102')?.invocations.at(-1)).toMatchObject({ behavior: 'implement-issue', state: 'started' })
  } else {
    expect(launch).not.toHaveBeenCalled()
    expect(current.invocations.some(item => item.behavior === 'implement-issue' && item.state !== 'settled')).toBe(false)
    if (kind === 'launch' || kind === 'unlaunched') expect(current.invocations.at(-1)?.outcome).toBe('launch_deferred')
    else expect(current.waiting).toContain(kind === 'source-only' ? 'source-only disposition' : 'awaits a current explicit')
  }
  expect(journal.read(source.id)).toMatchObject({ held: source.held, resumedAfterSequence: resumed.sequence, invocations: source.invocations })
  expect(posts()).toHaveLength(2)
  const retried = record(journal, journal.read(source.id)!, { type: 'chain.resumed' })
  expect(decideBehaviorChain(retried, { ...fresh, checkedAt: Date.now() }, Date.now())).toMatchObject({ kind: 'invoke', behavior: 'approve-pr' })
})

it.each(['changed head', 'changed approval basis', 'operator hold', 'missing release', 'possible submission'])('does not report unverified PR approval exhaustion: %s', async change => {
  const { db, journal } = setup()
  const reviewExhausted = await exhaustedReviews(journal)
  await operations(db, journal).reportHold!(record(journal, reviewExhausted, { type: 'chain.observed', observation: { ...fresh, checkedAt: Date.now() } }))
  expect(posts()).toHaveLength(1)
  record(journal, journal.read(reviewExhausted.id)!, { type: 'chain.resumed' })
  const chain = structuredClone(await exhaustedApprovals(journal))
  chain.observation = structuredClone(fresh)
  const attempt = chain.invocations[4]
  if (change === 'changed head') fresh.pull!.head = 'b'.repeat(40)
  if (change === 'changed approval basis') fresh.pull!.reviewRevision = chainBasis('edited findings')
  if (change === 'operator hold') chain.held = 'operator stop'
  if (change === 'missing release') attempt.evidence!.resources_settled_at = null
  if (change === 'possible submission') attempt.evidence!.review_id = 123
  const waiting = await operations(db, journal).reportHold!(chain)
  expect(posts()).toHaveLength(1)
  expect(reports(db)).toHaveLength(1)
  expect(JSON.parse(reports(db)[0].value).key).toBe(chainBasis(['review_budget_exhausted', reviewExhausted.id, 21]))
  if (change === 'operator hold') {
    expect(journal.read(chain.id)?.held).toContain('approve-pr failed before publication three times')
    expect(waiting).toContain('https://github.com/acme/repo/issues/99')
  } else {
    expect(journal.read(chain.id)?.held).toBe(chain.held)
    if (change === 'changed head' || change === 'changed approval basis') {
      expect(waiting).toContain('review basis no longer verifies')
      expect(waiting).not.toContain('https://github.com/acme/repo/issues/99')
    } else {
      expect(waiting).toContain('no verified approval exhaustion')
      expect(waiting).not.toContain('https://github.com/acme/repo/issues/99')
    }
  }
})

it.each(['incomplete replies', 'execution budget', 'review budget', 'implementation hold'])('carries the recorded %s report policy only to its closing remediation PR', async mode => {
  const { db, journal } = setup()
  if (mode === 'implementation hold') {
    const { call } = blockedImplementation(journal)
    await new BehaviorChainRuntime(journal, operations(db, journal, { observe: async () => fresh,
      readInvocations: async () => ({ entries: [call], quarantined: [] }) })).run()
  } else if (mode === 'review budget') await exhaustedReviews(journal)
  else exhausted(journal, mode === 'execution budget' ? BUDGET_ERRORS : undefined, 7, 21, mode === 'execution budget' ? BUDGET_CODE : 'atomic_work_failed')
  const runtime = new BehaviorChainRuntime(journal, operations(db, journal, mode === 'review budget' || mode === 'implementation hold'
    ? { observe: async chain => chain.issue === 7 ? { ...fresh, checkedAt: Date.now() } : unpublished() } : {}))
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
    if (command === 'github-interface' && argv[0] === '--read-issue') {
      const repo = argv[argv.indexOf('--repository') + 1]
      const number = Number(argv[1])
      return { stdout: JSON.stringify({ repository: repo, issue_number: number,
        issue: { number, html_url: `https://github.com/${repo}/issues/${number}`, body: 'An ordinary unmarked seed',
          state: 'open', labels: [{ name: 'poise' }] } }), stderr: '' }
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
  expect(mocks.runFile.mock.calls).toHaveLength(beforeUnrelated + 3)
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
    expect(mocks.runFile.mock.calls).toHaveLength(beforeUnrelatedRequest + 1)
    stale = false
  }
  stale = true
  await expect(repairReportReviewScope(db, chain, 22)).rejects.toThrow('stale review datastore')
  stale = false
  await expect(repairReportReviewScope(db, chain, 24)).rejects.toThrow('awaits indexed PR closing references')
  await runtime.run()
  expect(posts()).toHaveLength(1)
})

it.each(['review-pr', 'approve-pr'] as const)('waits per PR for indexed scope before %s, retaining the first wait across restart', async behavior => {
  const { db, journal } = setup()
  let chain = openSeed(journal)
  // A chain can already have several history pages before its PR is published.
  for (let index = 0; index < 100; index++) chain = record(journal, chain, { type: 'chain.observed', observation: observation(22) })
  const other = journal.append('acme/repo#8', 'seed:8', 0, { type: 'chain.admitted', repository: 'acme/repo', issue: 8,
    branch: 'poise/issue-8', author: 'author', reviewer: 'reviewer' })
  seedBody = `${REMEDIATION_SCOPE}\n\nInclude this exact paragraph in the linked PR review.`
  let indexedPull: number | null = null
  const existingRun = mocks.runFile.getMockImplementation()!
  mocks.runFile.mockImplementation(async (command: string, argv: string[]) => {
    if (command === 'github-interface' && argv[0] === '--read-issue' && argv[1] === '8') {
      return { stdout: JSON.stringify({ repository: 'acme/repo', issue_number: 8, issue: issue(8, 'Ordinary work') }), stderr: '' }
    }
    if (command === 'github-datastore' && argv[1] === 'pr-closing') {
      expect(argv).toEqual(['view', 'pr-closing', '--repo', 'acme/repo', '--format', 'json', '--limit', '1', '--after-number', '21'])
      return { stdout: JSON.stringify({ prs: indexedPull === null ? [] : [{ repo: 'acme/repo', number: indexedPull,
        closes_via: 'closing-references', closing_truncated: false, closing: [{ repo: 'acme/repo', number: 7 }] }],
      more: indexedPull === 24, truncated: indexedPull === 24 }), stderr: '' }
    }
    return existingRun(command, argv)
  })
  const native = nativeChainOperations({ login: 'acme' } as Organization, {
    roster: async () => fresh, resolve: async () => reviewer, prepare: async () => ({}), borrow: () => null,
    available: () => true, capacity: () => 3, permitted: () => true, note: () => '', severity: () => 'p2',
    received: () => {}, reviews: async () => '', existing: async () => new Set(), wake: () => {},
    reviewScope: (target, pull) => repairReportReviewScope(db, target, pull.number),
  })
  const calls: LogEntry[] = []
  const launch = vi.fn(async (invocation: BehaviorChain['invocations'][number]) => {
    calls.push({ id: chainBasis(invocation.id).slice(0, 32), correlation_id: invocation.id, source: 'poise:behavior-chain',
      actor: invocation.actor, repo: chain.repository, behavior: behavior === 'review-pr' ? 'pr_review' : 'pr_approve',
      model: reviewer.model, pr_id: invocation.request.argv[1].split('/').at(-1)!, session_id: null, prompt: '',
      started_at: new Date().toISOString(), time_elapsed: '1s', head_sha: null, expected_head: HEAD, response: null,
      error: '', status: 'running', action: null, outcome: null, resources_settled_at: null,
      resource_ownership: { version: 1, roots: [], errors: [] } })
    return true
  })
  const ops = operations(db, journal, { discover: async () => [], available: () => true, permitted: () => true,
    observe: async target => {
      const observed = observation(target.issue === 7 ? 22 : 23)
      observed.prReviewers = behavior === 'review-pr' ? [reviewer] : []
      Object.assign(observed.pull!, { changesRequested: false, unresolved: 0 })
      return observed
    }, request: native.request, launch, readInvocations: async () => ({ entries: calls, quarantined: [] }) })
  let runtime = new BehaviorChainRuntime(journal, ops)
  await expect(runtime.run()).resolves.toBeUndefined()
  const reason = 'Repair report review awaits indexed PR closing references for acme/repo#22'
  expect(journal.read(chain.id)).toMatchObject({ waiting: reason, invocations: [], held: null })
  expect(journal.read(other.id)!.invocations).toMatchObject([{ behavior, state: 'started' }])
  expect(launch).toHaveBeenCalledTimes(1)

  vi.setSystemTime(NOW + 30_000)
  await runtime.run()
  indexedPull = 24
  vi.setSystemTime(NOW + 60_000)
  journal.rebuild()
  runtime = new BehaviorChainRuntime(new BehaviorChainJournal(db), ops)
  await expect(runtime.run()).resolves.toBeUndefined()
  const waits = db.prepare("SELECT at FROM behavior_chain_events WHERE chain_id = ? AND json_extract(payload, '$.type') = 'chain.waiting'").all(chain.id)
  expect(waits).toEqual([{ at: NOW }])
  expect(journal.read(chain.id)!.invocations).toEqual([])

  // Each health read reports a new successful sync; it cannot renew this PR's budget.
  vi.setSystemTime(NOW + 120_001)
  await expect(runtime.run()).rejects.toThrow(`${reason}; indexing delay exceeds 120 seconds`)
  expect(journal.read(chain.id)!.invocations).toEqual([])
  expect(launch).toHaveBeenCalledTimes(1)
  indexedPull = 22
  await runtime.run()
  await expect(runtime.run()).resolves.toBeUndefined()
  const admitted = journal.read(chain.id)!.invocations
  expect(admitted).toMatchObject([{ behavior, state: 'started' }])
  expect(admitted[0].request.argv[admitted[0].request.argv.indexOf('--review-scope') + 1]).toBe(REMEDIATION_SCOPE)
  expect(journal.read(chain.id)!.waiting).toBeNull()
  expect(launch).toHaveBeenCalledTimes(2)
})

it.each(['read failure', 'invalid health', 'malformed JSON', 'missing page', 'truncated page', 'invalid cursor',
  'wrong repository', 'incomplete later row', 'malformed closing reference'])('keeps %s actionable instead of waiting for scope indexing', async kind => {
  const { db, journal } = setup()
  const chain = openSeed(journal)
  seedBody = `${REMEDIATION_SCOPE}\n\nInclude this exact paragraph in the linked PR review.`
  const row = { repo: 'acme/repo', number: 24, closes_via: 'closing-references', closing_truncated: false,
    closing: [{ repo: 'acme/repo', number: 7 }] }
  if (kind === 'invalid cursor') row.number = 21
  if (kind === 'wrong repository') row.repo = 'other/repo'
  if (kind === 'incomplete later row') row.closing_truncated = true
  if (kind === 'malformed closing reference') row.closing[0].number = 0
  const page = kind === 'missing page' ? {} : { prs: kind === 'truncated page' ? [] : [row],
    more: false, truncated: kind === 'truncated page' || row.closing_truncated }
  const existingRun = mocks.runFile.getMockImplementation()!
  mocks.runFile.mockImplementation(async (command: string, argv: string[]) => {
    if (command === 'github-datastore') {
      if (argv[0] === 'health' && kind === 'invalid health') return { stdout: '{"healthy":true}', stderr: '' }
      if (argv[1] === 'pr-closing') {
        if (kind === 'read failure') throw new Error('closing-reference store unavailable')
        return { stdout: kind === 'malformed JSON' ? '{' : JSON.stringify(page), stderr: '' }
      }
    }
    return existingRun(command, argv)
  })
  const failure = await repairReportReviewScope(db, chain, 22).then(() => null, (error: unknown) => error)
  expect(failure).toBeInstanceOf(Error)
  expect(failure).not.toBeInstanceOf(ReviewScopeIndexingError)
  if (kind === 'malformed JSON') expect(failure).toBeInstanceOf(SyntaxError)
  else expect(failure).toMatchObject({ message: kind === 'read failure' ? 'closing-reference store unavailable'
    : kind === 'invalid health' ? 'Repair report review lacks valid datastore freshness evidence'
    : ['missing page', 'truncated page'].includes(kind) ? 'Repair report review lacks PR closing references'
    : 'Repair report review has incomplete PR closing references' })
  expect(journal.read(chain.id)).toMatchObject({ waiting: null, invocations: [] })
})

it('carries an explicitly marked seed scope to its closing PR without repair-report metadata', async () => {
  const { db, journal } = setup()
  const chain = exhausted(journal)
  expect(reports(db)).toHaveLength(0)
  const invocations = chain.invocations.length
  const existingRun = mocks.runFile.getMockImplementation()!
  let closesVia = 'closing-references'
  let closingIssue = 7
  mocks.runFile.mockImplementation(async (command: string, argv: string[]) => {
    if (command === 'github-datastore' && argv[1] === 'pr-closing') {
      const number = Number(argv[argv.indexOf('--after-number') + 1]) + 1
      const prs = number === 22
        ? [{ repo: 'acme/repo', number: 22, author: 'maintainer', branch: 'hotfix', closes_via: closesVia,
          closing_truncated: false, closing: [{ repo: 'acme/repo', number: closingIssue }] }]
        : []
      return { stdout: JSON.stringify({ prs, truncated: false, more: false }), stderr: '' }
    }
    return existingRun(command, argv)
  })
  seedBody = `Do the work\n\n${REMEDIATION_SCOPE}\n\nInclude this exact paragraph in the linked PR review.`
  expect(await repairReportReviewScope(db, chain, 22)).toBe(REMEDIATION_SCOPE)
  seedBody = 'Original work'
  expect(await repairReportReviewScope(db, chain, 22)).toBe('')
  seedBody = `Do the work\n\n${REMEDIATION_SCOPE}\n\nInclude this exact paragraph in the linked PR review.`
  closingIssue = 100
  expect(await repairReportReviewScope(db, chain, 22)).toBe('')
  closingIssue = 7
  closesVia = 'body-keywords'
  await expect(repairReportReviewScope(db, chain, 22)).rejects.toThrow('incomplete PR closing references')
  closesVia = 'closing-references'
  const prClosingRun = mocks.runFile.getMockImplementation()!
  mocks.runFile.mockImplementation(async (command: string, argv: string[]) => {
    if (command === 'github-interface' && argv[0] === '--read-issue') throw new Error('issue store offline')
    return prClosingRun(command, argv)
  })
  await expect(repairReportReviewScope(db, chain, 22)).rejects.toThrow('Review scope seed read failed')
  mocks.runFile.mockImplementation(prClosingRun)
  const native = nativeChainOperations({ login: 'acme' } as Organization, {
    roster: async () => ({ issueReviewers: [], prReviewers: [reviewer], implementer: reviewer, repairer: reviewer, approver: reviewer }),
    resolve: async () => reviewer, prepare: async () => ({}), borrow: () => null, available: () => true, capacity: () => 3,
    permitted: () => true, severity: () => 'p2', received: () => {}, reviews: async () => '', existing: async () => new Set(), wake: () => {},
    note: () => '', reviewScope: (target, pull) => repairReportReviewScope(db, target, pull.number),
  })
  for (const behavior of ['review-pr', 'approve-pr'] as const) {
    const observed = observation(22)
    const request = await native.request(chain, observed, { kind: 'invoke', behavior, actor: 'reviewer', reviewer,
      basis: 'fixture', reason: 'Inspect the marked seed remediation' }, 'review-marked')
    expect(request?.argv[request?.argv.indexOf('--review-scope') + 1]).toBe(REMEDIATION_SCOPE)
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
        'pull':{'base':{'sha':'b'*40},'title':'Marked seed','body':'Closes #7'}})
    with patch.object(api, 'run_governed_behavior') as run:
        sys.argv = ['agent-interface', *data['argv']]
        api._main()
    review_receipt.prepare_response(packet, 'fixture', run.call_args.kwargs['review_scope'])
    assessment = {'verdict':'The marked remediation was inspected.',
        'reviewed_context':'Inspected the immutable diff and affected callers.','limitations':'Isolated fixture only.'}
    review_receipt.complete_response(assessment, data['head'])
    print(json.dumps({'body':review_receipt.begin_submission(assessment['verdict'], data['head'])}))
`], { input: JSON.stringify({ head: HEAD, argv: request!.argv }), encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PYTHONPATH: resolve('caller/agent_interface') } })) as { body: string }
    expect(reviewed.body.split(REMEDIATION_SCOPE)).toHaveLength(2)
  }
  expect(journal.read(chain.id)!.invocations).toHaveLength(invocations)
  expect(posts()).toHaveLength(0)
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
  'submitting_review without review_id', 'changed head', 'changed context on the same head', 'closed', 'merged'])('does not report unverified PR review exhaustion: %s', async change => {
  const { db, journal } = setup()
  const chain = structuredClone(await exhaustedReviews(journal, MIXED_REVIEW_FAILURES))
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
  if (change === 'closed') fresh.pull!.state = 'closed'
  if (change === 'merged') Object.assign(fresh.pull!, { state: 'closed', merged: true, mergeSha: 'b'.repeat(40) })
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

it('rejects a reporting allowlist beyond the health echo budget without changing the applied setting', () => {
  vi.stubEnv('POISE_MODE', 'service')
  const { db } = setup()
  const desired = `${'a/b,'.repeat(2047)}a/bb`
  expect(Buffer.byteLength(desired)).toBe(MAX_REPAIR_REPORT_REPOSITORIES_BYTES)
  setRepairReportRepositories(db, desired)
  const oversized = `${desired},acme/revoked`
  expect(Buffer.byteLength(oversized)).toBeGreaterThan(MAX_REPAIR_REPORT_REPOSITORIES_BYTES)
  expect(() => setRepairReportRepositories(db, oversized)).toThrow('exceeds 8192 bytes')
  expect(repairReportRepositories(db)).toBe(desired)
  expect(repairReportRepositoriesHealth(db)).toBe(desired)
  setRepairReportRepositories(db, '')
  expect(repairReportRepositoriesHealth(db)).toBe('')
})

it.each(['stored', 'environment'])('distinguishes an oversized %s allowlist from an accepted prefix until corrected', source => {
  vi.stubEnv('POISE_MODE', 'service')
  const { db } = setup()
  const desired = `${'a/b,'.repeat(2047)}a/bb`
  const oversized = `${desired},acme/revoked`
  if (source === 'stored') db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('service_repair_exhaustion_repositories', oversized)
  else vi.stubEnv('POISE_REPAIR_EXHAUSTION_REPOSITORIES', oversized)
  expect(repairReportRepositoriesHealth(db)).toBe('[oversized]')
  expect(Buffer.byteLength(repairReportRepositoriesHealth(db))).toBeLessThanOrEqual(MAX_REPAIR_REPORT_REPOSITORIES_BYTES)
  expect(repairReportRepositories(db)).toBe(oversized)
  setRepairReportRepositories(db, desired)
  expect(repairReportRepositories(db)).toBe(desired)
  expect(repairReportRepositoriesHealth(db)).toBe(desired)
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

it.each(['repair exhaustion', 'closed PR'])('never repeats an ambiguous %s POST across empty searches, restart or a closed matching issue', async mode => {
  const root = mkdtempSync(join(tmpdir(), 'repair-report-')); roots.push(root)
  const path = join(root, 'journal.sqlite')
  const initial = setup(path)
  const chain = mode === 'closed PR' ? openSeed(initial.journal) : exhausted(initial.journal)
  if (mode === 'closed PR') fresh = closedObservation()
  const overrides = mode === 'closed PR' ? { observe: async () => ({ ...fresh, checkedAt: Date.now() }) } : {}
  loseCreation = true
  await new BehaviorChainRuntime(initial.journal, operations(initial.db, initial.journal, overrides)).run()
  expect(posts()).toHaveLength(1)
  expect(JSON.parse(reports(initial.db)[0].value).issueNumber).toBeNull()
  initial.db.close(); databases.splice(databases.indexOf(initial.db), 1)
  const { db, journal } = setup(path)
  journal.rebuild()
  searchVisible = false
  for (let pass = 1; pass <= 3; pass++) {
    vi.setSystemTime(Date.now() + 86_400_000)
    await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
    expect(journal.read(chain.id)?.waiting).toContain('creation is unconfirmed')
  }
  searchVisible = true; remote[0].state = 'closed'
  vi.setSystemTime(Date.now() + 86_400_000)
  await new BehaviorChainRuntime(journal, operations(db, journal, overrides)).run()
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

function blockedSecondaryRepairWithReview(journal: BehaviorChainJournal) {
  const secondary = { slot: 'secondary', model: 'fixture', recovery: 'fixture' }
  const primary = { slot: 'primary', model: 'fixture', recovery: 'fixture' }
  fresh = observation()
  fresh.prReviewers = [primary]
  fresh.repairer = secondary
  const reviewCall = completedReviewCall('acme/repo', 21, HEAD, 'reviewer')
  reviewCall.action = 'requested_changes'
  reviewCall.outcome = 'changes_requested'
  const response = reviewCall.artifact!.review_response as Record<string, unknown>
  fresh.pull!.reviewContext = response.context_sha as string
  fresh.pull!.reviewIds = [reviewCall.review_id!]
  fresh.pull!.reviewReceipts = [{ id: reviewCall.review_id!, head: HEAD, state: 'CHANGES_REQUESTED',
    invocation: reviewCall.id, response, submittedAt: Date.parse(reviewCall.completed_at!) }]
  let chain = openSeed(journal)
  chain = record(journal, chain, { type: 'chain.observed', observation: { ...fresh, checkedAt: NOW - 600_000 } })
  const reviewBasis = chainBasis(['pr', HEAD, response.context_sha])
  chain = record(journal, chain, { type: 'invocation.admitted', invocation: { id: 'original-review',
    behavior: 'review-pr', basis: reviewBasis, actor: 'reviewer', slot: 'primary', model: 'fixture',
    admittedAt: Date.parse(reviewCall.started_at),
    request: { command: 'agent-interface', cwd: '/fixture',
      argv: ['--pr-review', 'https://github.com/acme/repo/pull/21', '--expected-head', HEAD] } } })
  chain = record(journal, chain, { type: 'invocation.settled', invocationId: 'original-review',
    callId: reviewCall.id, outcome: 'changes_requested',
    evidence: { status: 'completed', action: 'requested_changes', outcome: 'changes_requested',
      review_id: reviewCall.review_id, head_sha: HEAD, completedAt: Date.parse(reviewCall.completed_at!),
      artifact: reviewCall.artifact,
      resources_settled_at: new Date(NOW - 100_000).toISOString(),
      resource_ownership: { version: 1, roots: [], errors: [] } } })
  const decision = decideBehaviorChain(chain, fresh, NOW)
  if (decision.kind !== 'invoke' || decision.behavior !== 'repair-pr') throw new Error('Fixture must need secondary repair')
  if (decision.reviewer?.slot !== 'secondary') throw new Error('Fixture must use the secondary repair slot')
  const id = 'original-blocked-repair'
  chain = record(journal, chain, { type: 'invocation.admitted', invocation: { id, behavior: 'repair-pr',
    basis: decision.basis, actor: 'author', slot: 'secondary', model: 'fixture', admittedAt: NOW - 300_000,
    request: { command: 'agent-interface', cwd: '/fixture',
      argv: ['--atomic-work', chain.id, '--pull-number', '21', '--expected-head', HEAD,
        '--expected-issue-revision', fresh.issue.revision],
      context: { head: HEAD, reviewRevision: fresh.pull!.reviewRevision } } } })
  chain = record(journal, chain, { type: 'invocation.started', invocationId: id })
  const call: LogEntry = { id: '09bfede268214c4caa6e0237f99e5f17', correlation_id: id, model: 'fixture',
    behavior: 'repair_pr', source: 'poise:behavior-chain', actor: 'author', repo: 'acme/repo', pr_id: '21',
    session_id: null, prompt: '', started_at: new Date(NOW - 300_000).toISOString(),
    completed_at: new Date(NOW - 120_000).toISOString(), time_elapsed: '3m', status: 'failed',
    action: 'not_started', outcome: 'preflight_failed', error_code: 'atomic_work_blocked',
    error: 'atomic behavior blocked: Caller suite completed with failures; assertion details unavailable',
    head_sha: null, expected_head: HEAD, response: null, receipts: null, review_id: null,
    artifact: { phase: 'executing', prepared: { checkout_head: HEAD }, resource_root: '/private/work' },
    resources_settled_at: new Date(NOW - 100_000).toISOString(), resource_ownership: { version: 1, roots: [], errors: [] } }
  return { chain, call }
}

it('reports a settled secondary repair hold with its retained review panel', async () => {
  const { db, journal } = setup()
  const { chain, call } = blockedSecondaryRepairWithReview(journal)
  const forbidden = vi.fn(async () => { throw new Error('must not start work before report') })
  await new BehaviorChainRuntime(journal, operations(db, journal, { discover: async () => [],
    available: () => true, permitted: () => true, request: forbidden, launch: forbidden, perform: forbidden,
    observe: async () => ({ ...fresh, checkedAt: Date.now() }),
    readInvocations: async () => ({ entries: [call], quarantined: [] }) })).run()
  expect(posts()).toHaveLength(1)
  expect(remote[0]).toMatchObject({ title: 'fix: blocked repair for #21', labels: [{ name: 'poise' }] })
  expect(remote[0].body).toContain('slot secondary')
  expect(remote[0].body).toContain(`Caller ${call.id}`)
  expect(remote[0].body).toContain(`head ${HEAD}; basis ${chain.invocations.find(invocation => invocation.id === call.correlation_id)?.basis}`)
  expect(reports(db)).toHaveLength(1)
  expect(forbidden).not.toHaveBeenCalled()
})

it('refuses a same-head repair basis change without consuming report intent', async () => {
  const { db, journal } = setup()
  const { call } = blockedSecondaryRepairWithReview(journal)
  fresh.pull!.reviewRevision = chainBasis('changed findings on the same head')
  const forbidden = vi.fn(async () => { throw new Error('must not start work before report') })
  await new BehaviorChainRuntime(journal, operations(db, journal, { discover: async () => [],
    available: () => true, permitted: () => true, request: forbidden, launch: forbidden, perform: forbidden,
    observe: async () => ({ ...fresh, checkedAt: Date.now() }),
    readInvocations: async () => ({ entries: [call], quarantined: [] }) })).run()
  expect(posts()).toHaveLength(0)
  expect(reports(db)).toHaveLength(0)
  const waiting = journal.read('acme/repo#7')?.waiting ?? ''
  expect(waiting).toContain(call.id)
  expect(waiting).toContain('review basis')
  expect(forbidden).not.toHaveBeenCalled()
})
