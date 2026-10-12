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
let root = ''
let db: typeof import('../server/db')
let runtime: typeof import('../server/behaviors')
let outcome = 'merged'
let error: Error | null = null
let healthError: Error | null = null
let response: Record<string, unknown> = {}
let pulls: Array<Record<string, unknown>> = []
let headGate: { reached: () => void, wait: Promise<void> } | null = null

function pull(repo = REPO, number = 7, fields: Record<string, unknown> = {}) {
  return { repo, number, url: `https://github.com/${repo}/pull/${number}`, status: 'open', draft: 0, author: 'octocat', ...fields }
}
function mergeCalls() {
  return mocks.runFile.mock.calls.filter(([command, args]) => command === 'github-interface' && args[0] === '--merge-if-ready')
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
  if (command === 'github-interface' && args[0] === '--head-sha') {
    if (headGate) { headGate.reached(); await headGate.wait }
    return json({ action: 'head_sha', repository: repo, pull_number: number, head_sha: HEAD })
  }
  if (command === 'github-interface' && args[0] === '--merge-if-ready') {
    if (error) throw error
    return json({ action: 'merge_if_ready', repository: repo, pull_number: number, head_sha: HEAD,
      outcome, merge_sha: 'b'.repeat(40), ...response })
  }
  throw new Error(`unexpected CLI: ${command} ${args.join(' ')}`)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-merge-'))
  process.env.POISE_DB = join(root, 'cache.db')
  pulls = [pull()]
  outcome = 'merged'; error = null; healthError = null; response = {}; headGate = null
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

async function heldHead() {
  let reached!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => { reached = resolve })
  headGate = { reached, wait: new Promise<void>((resolve) => { release = resolve }) }
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
    const first = runtime.getMergePrsLastFired()
    db.closeDatabase(); vi.resetModules()
    db = await import('../server/db'); runtime = await import('../server/behaviors')
    expect(runtime.getEnabledMap()['merge-prs']).toBe(true)
    expect(runtime.getMergePrsLastFired()).toEqual(first)
  })
  it.each(['not_ready', 'superseded', 'already_merged'])('does not report a merge for %s', async (value) => {
    enable(); outcome = value
    await runtime.runEnabledBehaviorsOnce()
    expect(mergeCalls()).toHaveLength(1)
    expect(runtime.getMergePrsLastFired()).toBeNull()
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
  })
  it('filters drafts, foreign authors and skipped repositories before reading or locking them', async () => {
    enable()
    pulls = [pull(), pull(REPO, 8, { draft: 1 }), pull(REPO, 9, { author: 'other' }), pull('acme/skip', 10)]
    runtime.setRepositorySkips('merge-prs', ['acme/skip'])
    await runtime.runEnabledBehaviorsOnce()
    expect(mergeCalls()).toHaveLength(1)
    const reads = mocks.runFile.mock.calls.filter(([command]) => command === 'github-interface')
    expect(reads).toHaveLength(2)
    expect(reads.every(([, args]) => args[1] === '#7')).toBe(true)
  })
  it('stops a merge disabled while the head is being read', async () => {
    enable()
    const held = await heldHead()
    const disabled = runtime.setEnabled('merge-prs', false)
    held.release(); await held.tick; await disabled
    expect(mergeCalls()).toEqual([])
  })
  it('stops a merge skipped while the head is being read', async () => {
    enable()
    const held = await heldHead()
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
  it('resumes after a slow prefix when the scan deadline expires', async () => {
    enable(); pulls.push(pull(REPO, 8))
    vi.useFakeTimers()
    const held = await heldHead()
    await vi.advanceTimersByTimeAsync(runtime.BEHAVIOR_OPERATION_TIMEOUT_MS)
    held.release(); await held.tick
    expect(mergeCalls()).toEqual([])
    headGate = null
    await runtime.runEnabledBehaviorsOnce()
    expect(mergeCalls().map(([, args]) => args[1])).toEqual(['#8', '#7'])
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
