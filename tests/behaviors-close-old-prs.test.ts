import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunFileOptions } from '../server/process'

const mocks = vi.hoisted(() => ({ runFile: vi.fn(), spawnDetached: vi.fn(), admission: vi.fn(), outcome: vi.fn(), beforeDispatch: vi.fn() }))
vi.mock('../server/process', async original => ({
  ...await original<typeof import('../server/process')>(), runFile: mocks.runFile, spawnDetached: mocks.spawnDetached,
}))
vi.mock('../server/behavior-ledger', () => ({
  captureBehaviorAdmission: mocks.admission, captureBehaviorOutcome: mocks.outcome, behaviorLedgerHeartbeat: vi.fn(),
}))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
    const result = await fs.mkdir(...args)
    if (String(args[0]).includes('poise-gh-interface')) mocks.beforeDispatch()
    return result
  } }
})

const NOW = Date.parse('2026-11-12T12:00:00Z')
const DAY = 86_400_000
const REPO = 'acme/app'
let root: string
let database: typeof import('../server/db')
let runtime: typeof import('../server/behaviors')
let pulls: Array<Record<string, unknown>>
let outcome: string
let receipt: Record<string, unknown>
let failure: Error | null

function pull(number = 7, fields: Record<string, unknown> = {}) {
  return { repo: REPO, number, url: `https://github.com/${REPO}/pull/${number}`, status: 'open', draft: 0,
    author: 'octocat', created_at: new Date(NOW - 30 * DAY).toISOString(), updated_at: new Date(NOW).toISOString(), ...fields }
}
function closes() { return mocks.runFile.mock.calls.filter(([command, args]) => command === 'github-interface' && args[0] === '--close-old-pr-if-ready') }
async function cli(command: string, args: string[], options: RunFileOptions) {
  const json = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: '' })
  if (command === 'github-datastore' && args.includes('health')) {
    const now = new Date().toISOString()
    return json({ action: 'health', status: 'healthy', healthy: true, database: join(root, 'github.sqlite'),
      max_age_seconds: 120, age_seconds: 1, last_sync_at: now, last_success_at: now, checked_at: now })
  }
  if (command === 'github-datastore' && args.includes('view')) return json(pulls)
  if (command === 'github-interface' && args[0] === '--close-old-pr-if-ready') {
    if (failure) throw failure
    const parts = options.cwd!.split('/')
    return json({ action: 'close_old_pr_if_ready', repository: `${parts.at(-2)}/${parts.at(-1)}`,
      pull_number: Number(args[1]!.slice(1)), cutoff_ms: Number(args[args.indexOf('--cutoff-ms') + 1]),
      outcome, state: 'closed', merged: false, ...receipt })
  }
  throw new Error(`Unexpected CLI: ${command} ${args.join(' ')}`)
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  root = await mkdtemp(join(tmpdir(), 'poise-close-old-'))
  process.env.POISE_DB = join(root, 'cache.db')
  vi.resetModules()
  database = await import('../server/db')
  database.setMeta('org', 'acme'); database.setMeta('me', 'octocat'); database.setMeta('agentAccount', 'review-bot')
  runtime = await import('../server/behaviors')
  pulls = [pull()]; outcome = 'closed'; receipt = {}; failure = null
  mocks.runFile.mockReset().mockImplementation(cli)
  mocks.spawnDetached.mockReset(); mocks.admission.mockClear(); mocks.outcome.mockClear(); mocks.beforeDispatch.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(async () => {
  await runtime.stopBehaviorsRuntime()
  database.closeDatabase()
  delete process.env.POISE_DB
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})
async function enable() {
  runtime.setCloseOldPrsDays(30)
  await runtime.setEnabled('close-old-prs', true)
}

describe('Close Old Pull Requests', () => {
  it('is off by default and does not scan', async () => {
    expect(runtime.getEnabledMap()['close-old-prs']).toBe(false)
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.runFile).not.toHaveBeenCalled()
  })
  it('leaves a PR below the elapsed cutoff open and closes one exactly at it on first enable', async () => {
    pulls = [pull(6, { created_at: new Date(NOW - 30 * DAY + 1).toISOString() }), pull()]
    await enable()
    await runtime.runEnabledBehaviorsOnce()
    expect(closes()).toHaveLength(1)
    expect(closes()[0]![1]).toEqual(['--close-old-pr-if-ready', '#7', '--cutoff-ms', String(NOW - 30 * DAY),
      '--author', 'octocat', '--token-user', 'review-bot'])
    expect(runtime.getCloseOldPrsLastFired()).toEqual({ at: new Date(NOW).toISOString(), target: `${REPO}#7`, url: `https://github.com/${REPO}/pull/7` })
    expect(database.db.prepare('SELECT behavior, status, outcome FROM behavior_runs').all()).toEqual([
      { behavior: 'close-old-prs', status: 'completed', outcome: 'closed' },
    ])
    expect(mocks.outcome).toHaveBeenCalledWith(expect.objectContaining({ state: 'completed', outcome: 'closed' }))
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })
  it('retains all PR scope guards and uses the opposite account for either author', async () => {
    pulls = [pull(), pull(8, { author: 'review-bot' }), pull(9, { author: 'stranger' }), pull(10, { draft: 1 }),
      pull(11, { repo: 'elsewhere/app', url: 'https://github.com/elsewhere/app/pull/11' })]
    await enable()
    runtime.setRepositorySkips('close-old-prs', [REPO])
    await runtime.runEnabledBehaviorsOnce()
    expect(closes()).toEqual([])
    runtime.setRepositorySkips('close-old-prs', [])
    await runtime.runEnabledBehaviorsOnce()
    expect(closes().map(([, args]) => [args[1], args[args.indexOf('--token-user') + 1]])).toEqual([
      ['#7', 'review-bot'], ['#8', 'octocat'],
    ])
  })
  it.each([null, '2026-11-13T12:00:00Z'])('leaves unknown or future creation time open without substituting updated_at: %s', async created_at => {
    pulls = [pull(7, { created_at, updated_at: '2020-01-01T00:00:00Z' })]
    await enable()
    await runtime.runEnabledBehaviorsOnce()
    expect(closes()).toEqual([])
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([expect.objectContaining({ behavior: 'close-old-prs', target: `${REPO}#7`, error: expect.stringContaining('created_at') })])
    expect(database.listBehaviorDeadLetters()).toHaveLength(1)
    expect(runtime.getCloseOldPrsLastFired()).toBeNull()
  })
  it('keeps an invalid creation time visible and does not close', async () => {
    pulls = [pull(7, { created_at: 'not-a-date' })]
    await enable()
    await runtime.runEnabledBehaviorsOnce()
    expect(closes()).toEqual([])
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([expect.objectContaining({ behavior: 'close-old-prs', kind: 'operation' })])
  })
  it.each(['already_closed', 'not_ready'])('records %s between discovery and dispatch as a no-op without last-fired', async result => {
    outcome = result
    await enable()
    await runtime.runEnabledBehaviorsOnce()
    expect(closes()).toHaveLength(1)
    expect(runtime.getCloseOldPrsLastFired()).toBeNull()
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([])
    expect(database.db.prepare('SELECT status, outcome FROM behavior_runs').get()).toEqual({ status: 'completed', outcome: result })
  })
  it.each(['disable', 'pause', 'skip', 'days'] as const)('rechecks %s after acquiring the shared operation lock', async action => {
    await enable()
    mocks.beforeDispatch.mockImplementationOnce(() => {
      if (action === 'disable') database.setMeta('behavior_close_old_prs_enabled', '0')
      if (action === 'pause') database.setMeta('behavior_close_old_prs_paused_until', new Date(NOW + DAY).toISOString())
      if (action === 'skip') runtime.setRepositorySkips('close-old-prs', [REPO])
      if (action === 'days') runtime.setCloseOldPrsDays(31)
    })
    await runtime.runEnabledBehaviorsOnce()
    expect(closes()).toEqual([])
    expect(database.db.prepare("SELECT * FROM behavior_seen WHERE key = 'pr-operation'").all()).toEqual([])
  })
  it('respects another PR operation owner', async () => {
    await enable()
    expect(database.claimPrOperationOwned(`${REPO}#7`, 65_000)).toBeTruthy()
    await runtime.runEnabledBehaviorsOnce()
    expect(closes()).toEqual([])
  })
  it('keeps invalid days changed during preparation as one operation failure', async () => {
    await enable()
    mocks.beforeDispatch.mockImplementationOnce(() => database.setMeta('behavior_close_old_prs_days', '0'))
    await runtime.runEnabledBehaviorsOnce()
    expect(closes()).toEqual([])
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([expect.objectContaining({ behavior: 'close-old-prs', kind: 'operation', error: expect.stringContaining('positive whole number') })])
    expect(database.listBehaviorDeadLetters()).toEqual([])
  })
  it.each([null, '0', '-1', '1.5', 'broken'])('refuses enabling without valid days and reports one operation failure for bad stored configuration: %s', async days => {
    if (days !== null) database.setMeta('behavior_close_old_prs_days', days)
    await expect(runtime.setEnabled('close-old-prs', true)).rejects.toThrow('positive whole number')
    database.setMeta('behavior_close_old_prs_enabled', '1')
    await runtime.runEnabledBehaviorsOnce()
    expect(mocks.runFile).not.toHaveBeenCalled()
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([expect.objectContaining({ behavior: 'close-old-prs', kind: 'operation', error: expect.stringContaining('positive whole number') })])
    expect(database.listBehaviorDeadLetters()).toEqual([])
  })
  it.each(['403', 'receipt'])('keeps a %s failure visible without recording a close or a repository hold', async cause => {
    if (cause === '403') failure = new Error('GitHub 403: Forbidden')
    else receipt = { state: 'open' }
    await enable()
    await runtime.runEnabledBehaviorsOnce()
    expect(runtime.getCloseOldPrsLastFired()).toBeNull()
    expect(runtime.getBehaviorsRuntimeHealth().holds).toEqual([])
    expect(runtime.getBehaviorsRuntimeHealth().failures).toEqual([expect.objectContaining({ target: `${REPO}#7` })])
    expect(database.listBehaviorDeadLetters()).toHaveLength(1)
    expect(database.db.prepare('SELECT status FROM behavior_runs').get()).toEqual({ status: 'failed' })
  })
})
