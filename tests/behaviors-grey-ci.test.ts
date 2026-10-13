import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunFileOptions } from '../server/process'
import { CATALOG_STDOUT } from './model-catalog-fixture'

const mocks = vi.hoisted(() => ({ runFile: vi.fn(), spawnDetached: vi.fn() }))
vi.mock('../server/process', async (original) => ({
  ...await original<typeof import('../server/process')>(),
  runFile: mocks.runFile, spawnDetached: mocks.spawnDetached,
}))
const HEAD = 'a'.repeat(40)
const REPO = 'acme/app'
const GREY_RUN = { run_id: 100, run_attempt: 2, workflow_id: 70, event: 'pull_request_review', status: 'completed', conclusion: 'cancelled' }
let root = ''
let db: typeof import('../server/db')
let runtime: typeof import('../server/behaviors')
let greyRuns: Array<Record<string, unknown>> = []
let errorRunIds = new Set<number>()
let ghostNumbers = new Set<number>()
let outcome = 'rerun_requested'
let error: Error | null = null
let healthError: Error | null = null
let response: Record<string, unknown> = {}
let pulls: Array<Record<string, unknown>> = []
let greyNumbers: Set<number> | null = null
let unreadableNumbers = new Set<number>()
let batchGate: { reached: () => void, wait: Promise<void> } | null = null

function pull(repo = REPO, number = 7, fields: Record<string, unknown> = {}) {
  return { repo, number, url: `https://github.com/${repo}/pull/${number}`, status: 'open', draft: 0, author: 'octocat', ...fields }
}
function rerunCalls() {
  return mocks.runFile.mock.calls.filter(([command, args]) => command === 'github-interface' && args[0] === '--rerun-grey-ci-if-ready')
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
  if (command === 'github-interface' && args[0] === '--grey-ci-candidates') {
    if (batchGate) { batchGate.reached(); await batchGate.wait }
    const requests = JSON.parse(args[2]!) as Array<{ repository: string, number: number }>
    return json({ action: 'grey_ci_candidates', actor: args[args.indexOf('--token-user') + 1], graphql_cost: 1, records: requests.map((request) => ({
      ...request, head_sha: HEAD, author: ghostNumbers.has(request.number) ? null : 'octocat', runs: greyNumbers === null || greyNumbers.has(request.number) ? greyRuns : [],
      error: unreadableNumbers.has(request.number) ? 'GitHub could not read this target' : null,
    })) })
  }
  if (command === 'github-interface' && args[0] === '--rerun-grey-ci-if-ready') {
    if (error) throw error
    const runId = Number(args[args.indexOf('--run-id') + 1])
    if (errorRunIds.has(runId)) throw new Error('rerun receipt lost')
    return json({ action: 'rerun_grey_ci_if_ready', repository: repo, pull_number: number, head_sha: HEAD,
      outcome, run_id: runId, run_attempt: 2, ...response })
  }
  throw new Error(`unexpected CLI: ${command} ${args.join(' ')}`)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-merge-'))
  process.env.POISE_DB = join(root, 'cache.db')
  pulls = [pull()]
  outcome = 'rerun_requested'; error = null; healthError = null; response = {}; batchGate = null
  greyNumbers = null; unreadableNumbers = new Set(); greyRuns = [GREY_RUN]; errorRunIds = new Set(); ghostNumbers = new Set()
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
function enable() { db.setMeta('behavior_rerun_grey_ci_enabled', '1') }

async function heldBatch() {
  let reached!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => { reached = resolve })
  batchGate = { reached, wait: new Promise<void>((resolve) => { release = resolve }) }
  const tick = runtime.runEnabledBehaviorsOnce()
  await started
  return { tick, release }
}

describe('Rerun Grey CI', () => {
  it('starts off and adds no external calls until enabled', async () => {
    expect(runtime.getEnabledMap()['rerun-grey-ci']).toBe(false)
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.runFile).not.toHaveBeenCalled()
    expect(runtime.getGreyCiLastFired()).toBeNull()
  })
  it('reruns the exact head and attempt without a model and persists the workflow link', async () => {
    await runtime.setEnabled('rerun-grey-ci', true)
    await runtime.runEnabledBehaviorsOnce()
    expect(rerunCalls()[0]![1]).toEqual(['--rerun-grey-ci-if-ready', '#7', '--run-id', '100', '--run-attempt', '2',
      '--expected-head', HEAD, '--author', 'octocat', '--token-user', 'review-bot'])
    expect(runtime.getGreyCiLastFired()).toEqual({ at: expect.any(String), target: `${REPO}#7`, url: `https://github.com/${REPO}/actions/runs/100` })
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
    db.closeDatabase(); vi.resetModules(); db = await import('../server/db'); runtime = await import('../server/behaviors')
    expect(runtime.getEnabledMap()['rerun-grey-ci']).toBe(true)
    await runtime.runEnabledBehaviorsOnce()
    expect(rerunCalls()).toHaveLength(1)
  })
  it('keeps an accepted workflow/head recovery deduplicated through disable and enable', async () => {
    enable(); await runtime.runEnabledBehaviorsOnce()
    await runtime.setEnabled('rerun-grey-ci', false); await runtime.setEnabled('rerun-grey-ci', true)
    await runtime.runEnabledBehaviorsOnce()
    expect(rerunCalls()).toHaveLength(1)
  })
  it.each(['not_ready', 'superseded'])('releases proven no-write %s so a later eligible attempt remains possible', async (value) => {
    enable(); outcome = value
    await runtime.runEnabledBehaviorsOnce()
    expect(runtime.getGreyCiLastFired()).toBeNull()
    outcome = 'rerun_requested'
    await runtime.runEnabledBehaviorsOnce()
    expect(rerunCalls()).toHaveLength(2)
  })
  it('shares enable and repository skip settings across managed ready accounts', async () => {
    for (const login of ['acme', 'beta']) db.db.prepare(`INSERT INTO organizations(login, datastore_path, managed, status, stage, indexed_user)
      VALUES (?, ?, 1, 'ready', 'ready', 'octocat')`).run(login, join(root, `${login}.sqlite`))
    await runtime.setEnabled('rerun-grey-ci', true)
    runtime.withBehaviorOrganization('acme', () => runtime.setRepositorySkips('rerun-grey-ci', [REPO]))
    expect(runtime.withBehaviorOrganization('beta', () => runtime.isEnabled('rerun-grey-ci'))).toBe(true)
    expect(runtime.withBehaviorOrganization('beta', () => runtime.getRepositorySkips('rerun-grey-ci'))).toEqual([REPO])
  })
  it('deduplicates the same workflow/head across PRs and mutable actor settings', async () => {
    enable(); pulls.push(pull(REPO, 8)); await runtime.runEnabledBehaviorsOnce()
    expect(rerunCalls()).toHaveLength(1)
    db.setMeta('agentAccount', 'new-review-bot'); await runtime.runEnabledBehaviorsOnce()
    expect(rerunCalls()).toHaveLength(1)
  })
  it('preserves an ambiguous workflow hold when another workflow gets a valid receipt', async () => {
    enable(); greyRuns.push({ ...GREY_RUN, run_id: 101, workflow_id: 71 }); errorRunIds.add(100)
    await runtime.runEnabledBehaviorsOnce()
    expect(runtime.getGreyCiLastFired()?.url).toContain('/101')
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([expect.objectContaining({ error: 'rerun receipt lost' })])
  })
  it('rehydrates a crash between intent and receipt even when CI is no longer grey', async () => {
    enable(); greyNumbers = new Set()
    const marker = `${REPO}:${HEAD}:70:pull_request_review`
    db.claimSeenOwnedAs('grey-ci-recovery', marker, 'crash-owner', 60_000)
    db.db.prepare(`UPDATE behavior_seen SET launch_requested_at = ?, launch_repo = ?, launch_pr = 7,
      launch_expected_head = ?, launch_source = ? WHERE key = 'grey-ci-recovery' AND target = ?`)
      .run(new Date().toISOString(), REPO, HEAD, `workflow:70:pull_request_review:${HEAD}`, marker)
    await runtime.runEnabledBehaviorsOnce()
    expect(rerunCalls()).toEqual([])
    expect(runtime.getBehaviorsRuntimeHealth().failures[0]?.error).toContain('no confirmed receipt')
  })
  it('skips a ghost author without abandoning another readable PR', async () => {
    enable(); pulls.push(pull(REPO, 8)); ghostNumbers.add(7)
    await runtime.runEnabledBehaviorsOnce()
    expect(rerunCalls()[0]![1][1]).toBe('#8')
  })
  it('retries a proven no-write read failure after backoff', async () => {
    enable(); outcome = 'read_failed'; response = { error: 'GitHub read unavailable' }
    await runtime.runEnabledBehaviorsOnce()
    expect(runtime.getBehaviorsRuntimeHealth().failures[0]?.error).toContain('read unavailable')
    vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(61_000)
    outcome = 'rerun_requested'; response = {}; await runtime.runEnabledBehaviorsOnce()
    expect(rerunCalls()).toHaveLength(2)
  })
  it('checks ten ordinary PRs with one batch call and no individual REST operations', async () => {
    enable(); pulls = Array.from({ length: 10 }, (_, i) => pull(REPO, i + 1)); greyNumbers = new Set()
    await runtime.runEnabledBehaviorsOnce()
    const calls = mocks.runFile.mock.calls.filter(([command]) => command === 'github-interface')
    expect(calls).toHaveLength(1)
    expect(calls[0]![1][0]).toBe('--grey-ci-candidates')
    expect(JSON.parse(calls[0]![1][2])).toHaveLength(10)
    expect(rerunCalls()).toEqual([])
  })
  it('filters drafts, foreign authors and skipped repositories before querying', async () => {
    enable(); pulls.push(pull(REPO, 8, { draft: 1 }), pull(REPO, 9, { author: 'other' }), pull('acme/skip', 10))
    runtime.setRepositorySkips('rerun-grey-ci', ['acme/skip'])
    await runtime.runEnabledBehaviorsOnce()
    const batch = mocks.runFile.mock.calls.find(([, args]) => args[0] === '--grey-ci-candidates')!
    expect(JSON.parse(batch[1][2])).toEqual([{ repository: REPO, number: 7 }])
  })
  it.each(['disable', 'skip'])('does not write after %s while discovery is pending', async (action) => {
    enable(); const held = await heldBatch()
    const disabled = action === 'disable' ? runtime.setEnabled('rerun-grey-ci', false) : Promise.resolve(runtime.setRepositorySkips('rerun-grey-ci', [REPO]))
    held.release(); await held.tick; await disabled
    expect(rerunCalls()).toEqual([])
  })
  it('shares the PR operation lock and does not consume recovery intent while busy', async () => {
    enable(); const lock = db.claimPrOperationOwned(`${REPO}#7`, 60_000)!
    await runtime.runEnabledBehaviorsOnce(); expect(rerunCalls()).toEqual([])
    db.releasePrOperationOwned(lock); await runtime.runEnabledBehaviorsOnce()
    expect(rerunCalls()).toHaveLength(1)
  })
  it('retains ambiguous errors across retry delay and restart without repeating the write', async () => {
    enable(); error = new Error('rerun receipt lost')
    await runtime.runEnabledBehaviorsOnce()
    expect(runtime.getBehaviorsRuntimeHealth().failures[0]?.error).toContain('receipt lost')
    db.closeDatabase(); vi.resetModules(); db = await import('../server/db'); runtime = await import('../server/behaviors')
    vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(120_000)
    error = null; await runtime.runEnabledBehaviorsOnce()
    expect(rerunCalls()).toHaveLength(1)
    expect(runtime.getGreyCiLastFired()).toBeNull()
  })
  it('keeps a target read error visible without holding another readable PR', async () => {
    enable(); pulls.push(pull(REPO, 8)); unreadableNumbers.add(8)
    await runtime.runEnabledBehaviorsOnce()
    expect(rerunCalls()).toHaveLength(1)
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([expect.objectContaining({ target: `${REPO}#8` })])
  })
  it.each([{ run_attempt: 3 }, { run_id: 999 }, { head_sha: 'b'.repeat(40) }, { outcome: 'passed' }])('holds malformed receipts %j without claiming a rerun', async (fields) => {
    enable(); response = fields; await runtime.runEnabledBehaviorsOnce()
    expect(runtime.getGreyCiLastFired()).toBeNull()
    expect(runtime.getBehaviorsRuntimeHealth().failures[0]?.error).toContain('malformed')
  })
  it('resumes beyond a timed-out batch and does not drop PRs after the first fifty', async () => {
    enable(); pulls = Array.from({ length: 51 }, (_, i) => pull(REPO, i + 1)); greyNumbers = new Set([51])
    vi.useFakeTimers(); const held = await heldBatch()
    await vi.advanceTimersByTimeAsync(runtime.BEHAVIOR_OPERATION_TIMEOUT_MS)
    held.release(); await held.tick; batchGate = null
    await runtime.runEnabledBehaviorsOnce()
    expect(rerunCalls()[0]![1][1]).toBe('#51')
    const batches = mocks.runFile.mock.calls.filter(([, args]) => args[0] === '--grey-ci-candidates')
    expect(JSON.parse(batches[1]![1][2])[0].number).toBe(51)
    expect(JSON.parse(batches[2]![1][2])).toHaveLength(1)
  })
})
