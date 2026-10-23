import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunFileOptions } from '../server/process'
import { CATALOG_STDOUT } from './model-catalog-fixture'

const mocks = vi.hoisted(() => ({ runFile: vi.fn(), spawnDetached: vi.fn(),
  captureAdmission: vi.fn(), captureOutcome: vi.fn(), observeSnapshot: vi.fn() }))
vi.mock('../server/behavior-ledger', () => ({
  captureBehaviorAdmission: mocks.captureAdmission, captureBehaviorOutcome: mocks.captureOutcome,
  observeAgentSnapshot: mocks.observeSnapshot, behaviorLedgerHeartbeat: vi.fn(),
}))

vi.mock('../server/process', async (original) => ({
  ...await original<typeof import('../server/process')>(),
  runFile: mocks.runFile, spawnDetached: mocks.spawnDetached,
}))
const HEAD = 'a'.repeat(40)
const REPO = 'acme/app'
let root = ''
let db: typeof import('../server/db')
let runtime: typeof import('../server/behaviors')
let outcome = 'merged'
let updateOutcome = 'updated'
let error: Error | null = null
let healthError: Error | null = null
let response: Record<string, unknown> = {}
let pulls: Array<Record<string, unknown>> = []
let readyNumbers: Set<number> | null = null
let behindNumbers = new Set<number>()
let approvedAts: Record<number, string | null> = {}
let unreadableNumbers = new Set<number>()
let batchGate: { reached: () => void, wait: Promise<void> } | null = null

function pull(repo = REPO, number = 7, fields: Record<string, unknown> = {}) {
  return { repo, number, url: `https://github.com/${repo}/pull/${number}`, status: 'open', draft: 0, author: 'octocat', updated_at: '2026-07-15T12:00:00Z', ...fields }
}
function mergeCalls() {
  return mocks.runFile.mock.calls.filter(([command, args]) => command === 'github-interface' && args[0] === '--merge-if-ready')
}
function updateCalls() {
  return mocks.runFile.mock.calls.filter(([command, args]) => command === 'github-interface' && args[0] === '--update-branch-if-behind')
}
async function cli(command: string, args: string[], options: RunFileOptions) {
  const json = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: '' })
  if (command === 'agent-interface' && args[0] === '--models') return { stdout: CATALOG_STDOUT, stderr: '' }
  if (command === 'github-datastore' && args.includes('health')) {
    if (healthError) throw healthError
    const now = new Date().toISOString()
    return json({ action: 'health', status: 'healthy', healthy: true, age_seconds: 1,
      database: args.includes('--db') ? args[args.indexOf('--db') + 1] : join(root, 'github.sqlite'), max_age_seconds: 120,
      last_sync_at: now, last_success_at: now, checked_at: now })
  }
  if (command === 'github-datastore' && args.includes('view')) return json(pulls)
  const parts = options.cwd?.split('/') ?? []
  const repo = `${parts.at(-2)}/${parts.at(-1)}`
  const number = Number(args[1]?.slice(1))
  if (command === 'github-interface' && args[0] === '--merge-candidates') {
    if (batchGate) { batchGate.reached(); await batchGate.wait }
    const requests = JSON.parse(args[2]!) as Array<{ repository: string, number: number }>
    return json({ action: 'merge_candidates', actor: 'review-bot', graphql_cost: 1, records: requests.map((request) => ({
      ...request, head_sha: HEAD, author: 'octocat', ready: !unreadableNumbers.has(request.number) && (readyNumbers === null || readyNumbers.has(request.number)),
      behind: !unreadableNumbers.has(request.number) && behindNumbers.has(request.number),
      approved_at: request.number in approvedAts ? approvedAts[request.number]!
        : behindNumbers.has(request.number) ? '2026-10-22T00:00:00Z' : null,
      error: unreadableNumbers.has(request.number) ? 'GitHub could not read this target' : null,
    })) })
  }
  if (command === 'github-interface' && args[0] === '--merge-if-ready') {
    if (error) throw error
    return json({ action: 'merge_if_ready', repository: repo, pull_number: number, head_sha: HEAD,
      outcome, merge_sha: 'b'.repeat(40), ...response })
  }
  if (command === 'github-interface' && args[0] === '--update-branch-if-behind') {
    if (error) throw error
    return json({ action: 'update_branch_if_behind', repository: repo, pull_number: number, head_sha: HEAD,
      outcome: updateOutcome, ...response })
  }
  throw new Error(`unexpected CLI: ${command} ${args.join(' ')}`)
}

beforeEach(async () => {
  mocks.captureAdmission.mockClear(); mocks.captureOutcome.mockClear(); mocks.observeSnapshot.mockClear()
  root = await mkdtemp(join(tmpdir(), 'poise-merge-'))
  process.env.POISE_DB = join(root, 'cache.db')
  pulls = [pull()]
  outcome = 'merged'; updateOutcome = 'updated'; error = null; healthError = null; response = {}; batchGate = null
  readyNumbers = null; behindNumbers = new Set(); approvedAts = {}; unreadableNumbers = new Set()
  mocks.runFile.mockReset().mockImplementation(cli)
  mocks.spawnDetached.mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.resetModules()
  db = await import('../server/db')
  db.setMeta('org', 'acme'); db.setMeta('me', 'octocat'); db.setMeta('agentAccount', 'review-bot')
  runtime = await import('../server/behaviors')
})
afterEach(async () => {
  await runtime.stopBehaviorsRuntime()
  vi.useRealTimers()
  db.closeDatabase()
  delete process.env.POISE_DB
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})
function enable() { db.setMeta('behavior_merge_prs_enabled', '1') }

async function heldBatch() {
  let reached!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => { reached = resolve })
  batchGate = { reached, wait: new Promise<void>((resolve) => { release = resolve }) }
  const tick = runtime.runEnabledBehaviorsOnce()
  await started
  return { tick, release }
}

describe('Merge Pull Requests', () => {
  it('starts off and does no external work until enabled', async () => {
    expect(runtime.getEnabledMap()['merge-prs']).toBe(false)
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.runFile).not.toHaveBeenCalled()
    expect(runtime.getMergePrsLastFired()).toBeNull()
  })
  it('merges the eligible head as the configured account and persists the receipt', async () => {
    await runtime.setEnabled('merge-prs', true)
    await runtime.runEnabledBehaviorsOnce()
    expect(mergeCalls()[0]![1]).toEqual(['--merge-if-ready', '#7', '--expected-head', HEAD,
      '--author', 'octocat', '--token-user', 'review-bot'])
    expect(runtime.getMergePrsLastFired()).toEqual({ at: expect.any(String), target: `${REPO}#7` })
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    expect(db.db.prepare('SELECT behavior, status FROM behavior_runs').all()).toEqual([{ behavior: 'merge-prs', status: 'completed' }])
    expect(mocks.captureAdmission).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      behavior: 'merge-prs', repository: REPO, number: 7, head: HEAD,
    }))
    expect(mocks.captureOutcome).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      nativeId: mocks.captureAdmission.mock.calls[0][0].nativeId, state: 'completed', outcome: 'merged',
    }))
    const first = runtime.getMergePrsLastFired()
    db.closeDatabase(); vi.resetModules()
    db = await import('../server/db'); runtime = await import('../server/behaviors')
    expect(runtime.getEnabledMap()['merge-prs']).toBe(true)
    expect(runtime.getMergePrsLastFired()).toEqual(first)
    expect(db.db.prepare('SELECT status FROM behavior_runs').all()).toEqual([{ status: 'completed' }])
  })
  it.each(['not_ready', 'superseded', 'already_merged'])('does not report a merge for %s', async (value) => {
    enable(); outcome = value
    await runtime.runEnabledBehaviorsOnce()
    expect(mergeCalls()).toHaveLength(1)
    expect(runtime.getMergePrsLastFired()).toBeNull()
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
    expect(mocks.captureOutcome).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      state: value === 'superseded' ? 'superseded' : 'completed', outcome: value,
    }))
  })
  it('filters drafts, foreign authors and skipped repositories before reading or locking them', async () => {
    enable()
    pulls = [pull(), pull(REPO, 8, { draft: 1 }), pull(REPO, 9, { author: 'other' }), pull('acme/skip', 10)]
    runtime.setRepositorySkips('merge-prs', ['acme/skip'])
    await runtime.runEnabledBehaviorsOnce()
    expect(mergeCalls()).toHaveLength(1)
    const reads = mocks.runFile.mock.calls.filter(([command]) => command === 'github-interface')
    expect(reads).toHaveLength(2)
    expect(reads[0]![1][0]).toBe('--merge-candidates')
    expect(JSON.parse(reads[0]![1][2])).toEqual([{ repository: REPO, number: 7 }])
    expect(reads[1]![1][1]).toBe('#7')
  })
  it('stops a merge disabled while the batch is being read', async () => {
    enable()
    const held = await heldBatch()
    const disabled = runtime.setEnabled('merge-prs', false)
    held.release(); await held.tick; await disabled
    expect(mergeCalls()).toEqual([])
  })
  it('stops a merge skipped while the batch is being read', async () => {
    enable()
    const held = await heldBatch()
    runtime.setRepositorySkips('merge-prs', [REPO])
    held.release(); await held.tick
    expect(mergeCalls()).toEqual([])
  })
  it('does not overlap another operation on the same pull request', async () => {
    enable()
    const lock = db.claimPrOperationOwned(`${REPO}#7`, 60_000)!
    await runtime.runEnabledBehaviorsOnce()
    expect(mergeCalls()).toEqual([])
    db.releasePrOperationOwned(lock)
    await runtime.runEnabledBehaviorsOnce()
    expect(mergeCalls()).toHaveLength(1)
  })
  it('resumes after a timed-out batch without starving the next batch', async () => {
    enable(); pulls = Array.from({ length: 51 }, (_, index) => pull(REPO, index + 1))
    readyNumbers = new Set([51])
    vi.useFakeTimers()
    const held = await heldBatch()
    await vi.advanceTimersByTimeAsync(runtime.BEHAVIOR_OPERATION_TIMEOUT_MS)
    held.release(); await held.tick
    expect(mergeCalls()).toEqual([])
    batchGate = null
    await runtime.runEnabledBehaviorsOnce()
    expect(mergeCalls().map(([, args]) => args[1])).toEqual(['#51'])
    const requests = mocks.runFile.mock.calls.filter(([, args]) => args[0] === '--merge-candidates').map(([, args]) => JSON.parse(args[2]))
    expect(requests[1][0]).toEqual({ repository: REPO, number: 51 })
    expect(requests[1]).toHaveLength(50)
    expect(requests[2]).toHaveLength(1)
  })
  it('checks ten blocked PRs with one batch call and no individual GitHub calls', async () => {
    enable(); pulls = Array.from({ length: 10 }, (_, index) => pull(REPO, index + 1)); readyNumbers = new Set()
    await runtime.runEnabledBehaviorsOnce()
    const calls = mocks.runFile.mock.calls.filter(([command]) => command === 'github-interface')
    expect(calls).toHaveLength(1)
    expect(calls[0]![1][0]).toBe('--merge-candidates')
    expect(JSON.parse(calls[0]![1][2])).toHaveLength(10)
    expect(mergeCalls()).toEqual([])
  })
  it('keeps evaluating unchanged heads until checks finish and then merges them', async () => {
    enable(); readyNumbers = new Set()
    await runtime.runEnabledBehaviorsOnce()
    expect(mergeCalls()).toEqual([])
    readyNumbers.add(7)
    await runtime.runEnabledBehaviorsOnce()
    expect(mergeCalls()).toHaveLength(1)
    expect(mergeCalls()[0]![1]).toContain(HEAD)
  })
  it('updates an approved behind branch exactly once without reporting a merge', async () => {
    enable(); readyNumbers = new Set(); behindNumbers = new Set([7])
    await runtime.runEnabledBehaviorsOnce()
    expect(updateCalls()).toHaveLength(1)
    expect(updateCalls()[0]![1]).toEqual(['--update-branch-if-behind', '#7', '--expected-head', HEAD,
      '--author', 'octocat', '--token-user', 'review-bot'])
    expect(mergeCalls()).toEqual([])
    expect(runtime.getMergePrsLastFired()).toBeNull()
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
    expect(mocks.captureOutcome).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      state: 'completed', outcome: 'updated',
    }))
  })
  it('leaves PRs that are neither ready nor behind alone', async () => {
    // Caller clears the behind flag for conflicts and change requests; the
    // scheduler acts only on the flag. See caller's merge-candidates suite.
    enable(); pulls = [pull(), pull(REPO, 8)]; readyNumbers = new Set()
    await runtime.runEnabledBehaviorsOnce()
    expect(updateCalls()).toEqual([])
    expect(mergeCalls()).toEqual([])
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  })
  it('updates two behind branches one at a time, oldest approval first', async () => {
    enable(); pulls = [pull(), pull(REPO, 8)]; readyNumbers = new Set(); behindNumbers = new Set([7, 8])
    approvedAts = { 7: '2026-10-22T02:00:00Z', 8: '2026-10-22T01:00:00Z' }
    await runtime.runEnabledBehaviorsOnce()
    expect(updateCalls().map(([, args]) => args[1])).toEqual(['#8'])
    behindNumbers = new Set([7])
    await runtime.runEnabledBehaviorsOnce()
    expect(updateCalls().map(([, args]) => args[1])).toEqual(['#8', '#7'])
    expect(mergeCalls()).toEqual([])
  })
  it('backs off a persistently failing branch update instead of retrying every scan', async () => {
    enable(); readyNumbers = new Set(); behindNumbers = new Set([7]); error = new Error('GitHub unavailable')
    vi.useFakeTimers()
    await runtime.runEnabledBehaviorsOnce()
    expect(updateCalls()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(runtime.BEHAVIOR_RETRY_BASE_MS)
    await runtime.runEnabledBehaviorsOnce()
    expect(updateCalls()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(runtime.BEHAVIOR_RETRY_BASE_MS)
    await runtime.runEnabledBehaviorsOnce()
    expect(updateCalls()).toHaveLength(2)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([expect.objectContaining({ target: `${REPO}#7` })])
  })
  it('refuses a malformed update receipt', async () => {
    enable(); readyNumbers = new Set(); behindNumbers = new Set([7]); response = { outcome: 'unknown' }
    await runtime.runEnabledBehaviorsOnce()
    expect(updateCalls()).toHaveLength(1)
    expect(runtime.getMergePrsLastFired()).toBeNull()
    expect(runtime.getBehaviorsRuntimeHealth().failures[0]?.error).toContain('malformed state')
  })
  it('merges a readable ready PR while recording a different target\'s partial read error', async () => {
    enable(); pulls.push(pull(REPO, 8)); unreadableNumbers.add(8)
    await runtime.runEnabledBehaviorsOnce()
    expect(mergeCalls()).toHaveLength(1)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([expect.objectContaining({ target: `${REPO}#8`, error: 'GitHub could not read this target' })])
  })
  it('holds on unreadable datastore state', async () => {
    enable(); healthError = new Error('datastore is stale')
    await runtime.runEnabledBehaviorsOnce()
    expect(mergeCalls()).toEqual([])
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([expect.objectContaining({ behavior: 'merge-prs', error: expect.stringContaining('stale') })])
  })
  it('records per-target errors and applies retry backoff', async () => {
    enable(); error = new Error('GitHub unavailable')
    await runtime.runEnabledBehaviorsOnce()
    expect(db.db.prepare('SELECT status FROM behavior_runs').all()).toEqual([{ status: 'failed' }])
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([expect.objectContaining({ behavior: 'merge-prs', target: `${REPO}#7`, error: 'GitHub unavailable' })])
    await runtime.runEnabledBehaviorsOnce()
    expect(mergeCalls()).toHaveLength(1)
    expect(runtime.getMergePrsLastFired()).toBeNull()
  })
  it.each([{ repository: 'other/app' }, { head_sha: 'c'.repeat(40) }, { merge_sha: '' }, { outcome: 'unknown' }])('refuses malformed merge evidence %j', async (fields) => {
    enable(); response = fields
    await runtime.runEnabledBehaviorsOnce()
    expect(runtime.getMergePrsLastFired()).toBeNull()
    expect(runtime.getBehaviorsRuntimeHealth().failures[0]?.error).toContain('malformed state')
  })
  it('shares enable and skip preferences across ready accounts while keeping receipts scoped', async () => {
    db.db.prepare(`INSERT INTO organizations(login, datastore_path, managed, status, stage, indexed_user)
      VALUES ('beta', ?, 1, 'ready', 'ready', 'octocat')`).run(join(root, 'beta.sqlite'))
    pulls.push(pull('beta/app', 8))
    await runtime.setEnabled('merge-prs', true)
    runtime.setRepositorySkips('merge-prs', [REPO])
    await runtime.runEnabledBehaviorsOnce()
    expect(mergeCalls()).toHaveLength(1)
    expect(runtime.withBehaviorOrganization('beta', () => runtime.isEnabled('merge-prs'))).toBe(true)
    expect(runtime.withBehaviorOrganization('beta', runtime.getMergePrsLastFired)?.target).toBe('beta/app#8')
    expect(runtime.withBehaviorOrganization('acme', runtime.getMergePrsLastFired)).toBeNull()
  })
})
