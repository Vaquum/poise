import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunFileOptions } from '../server/process'
import { createAuthenticatedClaudeAuth } from './claude-auth-fixture'
import { CATALOG_STDOUT } from './model-catalog-fixture'

// The Skip repositories lists and the replay check through the HTTP API the
// Behaviors and Swarm views use, with Caller faked at the process boundary.
const mocks = vi.hoisted(() => ({ runFile: vi.fn(), spawnDetached: vi.fn() }))
vi.mock('../server/process', async (original) => ({
  ...(await original<typeof import('../server/process')>()),
  runFile: mocks.runFile,
  spawnDetached: mocks.spawnDetached,
}))
// These assertions count request-side Caller reads. Background maintenance
// owns separate integration coverage and must not add fstrim/cache work here.
vi.mock('../server/storage-maintenance', async (original) => ({
  ...(await original<typeof import('../server/storage-maintenance')>()),
  startStorageMaintenanceRuntime: vi.fn(),
  stopStorageMaintenanceRuntime: vi.fn(async () => undefined),
}))
// Collaborator reconciliation is background maintenance too: its listing
// passes own their coverage in tests/agent-collaborator.test.ts and must not
// count as request-side reads here.
vi.mock('../server/agent-collaborator', () => ({
  startAgentCollaboratorRuntime: vi.fn(),
  stopAgentCollaboratorRuntime: vi.fn(async () => undefined),
}))
vi.mock('../server/content-jobs', async (original) => ({
  ...(await original<typeof import('../server/content-jobs')>()),
  startContentFinalizer: vi.fn(),
  stopContentFinalizer: vi.fn(async () => undefined),
}))
vi.mock('../server/chat/runtime', async (original) => {
  const { EventEmitter } = await import('node:events')
  const { CheckSemaphore, DEFAULT_CHECK_SLOT_CAP } = await import('../server/check-semaphore')
  return {
    ...(await original<typeof import('../server/chat/runtime')>()),
    ChatRuntime: class extends EventEmitter {
      draining = null
      checkSlots = new CheckSemaphore(() => DEFAULT_CHECK_SLOT_CAP)
      async recover() {}
      async stop() {}
      endDrain() {}
    },
  }
})
vi.mock('../server/jev/api', () => ({
  handleJevApi: vi.fn(async () => false),
  stopJev: vi.fn(async () => undefined),
}))

const REPO = 'Legacy/same-repo'
const HEAD = 'b'.repeat(40)
let root = ''
let server: Server | undefined
let base = ''
let database: typeof import('../server/db') | undefined
let cache: typeof import('../server/cache-plugin') | undefined
let pulls: Array<Record<string, unknown>> = []
let agentRows: Array<Record<string, unknown>> = []
let healthFailure: Error | null = null
const envKeys = ['POISE_DB', 'POISE_EDITOR_DIR', 'POISE_CHAT_ATTACHMENTS_DIR', 'POISE_LOCK_DIR', 'AGENT_INTERFACE_ROOT', 'POISE_ESPANSO_MATCH_DIR', 'POISE_DATASTORE_DB']
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]))

async function cli(command: string, args: string[], options: RunFileOptions) {
  const json = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: '' })
  if (command === 'agent-interface' && args[0] === '--models') return { stdout: CATALOG_STDOUT, stderr: '' }
  if (command === 'agent-interface' && args[0] === '--logs' && args.includes('--limit')) return json({ rows: [], nextCursor: null, total: 0 })
  if (command === 'agent-interface' && args[0] === '--logs') return json(agentRows)
  if (command === 'github-datastore' && args[0] === 'health') {
    if (healthFailure) throw healthFailure
    const now = new Date().toISOString()
    return json({ action: 'health', status: 'healthy', healthy: true, database: join(root, 'github.sqlite'),
      max_age_seconds: 120, age_seconds: 1, last_sync_at: now, last_success_at: now, checked_at: now })
  }
  if (command === 'github-datastore' && args[0] === 'view') {
    const repo = args[args.indexOf('--repo') + 1]
    const number = Number(args[args.indexOf('--number') + 1])
    return json(args[1] === 'pr' ? pulls.filter((row) => row.repo === repo && row.number === number) : [])
  }
  if (command === 'github-interface' && args[0] === '--local-checkout-path') {
    return json({ action: 'local_checkout_path', repository: `${args[1]}/${args[2]}`, path: root })
  }
  if (command === 'github-interface' && args[0] === '--head-sha') {
    const parts = String(options.cwd || '').split('/')
    return json({ action: 'head_sha', repository: `${parts.at(-2)}/${parts.at(-1)}`, pull_number: Number(args[1].slice(1)), head_sha: HEAD })
  }
  if (command === 'github-interface' && args[0] === '--review-activity-since') {
    const parts = String(options.cwd || '').split('/')
    return json({ action: 'review_activity_since', repository: `${parts.at(-2)}/${parts.at(-1)}`,
      pull_number: Number(args[1].slice(1)), username: args[args.indexOf('--username') + 1],
      state: 'OPEN', draft: false, head_sha: HEAD, reviewer_requested: false, active_change_request_authors: [],
      unresolved_conversation_count: 0, unresolved_live_conversation_count: 0,
      unresolved_conversation_authors: [], unresolved_live_conversation_authors: [],
      reviewer_latest_state: null, reviewer_latest_commit: null, reviewer_reviews_since: 0,
      reviewer_reviews_since_items: [], reviewer_pending_reviews: 0, latest_activity_at: null })
  }
  throw new Error(`Unexpected test command: ${command} ${args.join(' ')}`)
}

async function post(path: string, body: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

async function behaviorState(query = ''): Promise<Record<string, Record<string, unknown>>> {
  const response = await fetch(`${base}/api/behaviors${query}`)
  expect(response.status).toBe(200)
  return await response.json() as Record<string, Record<string, unknown>>
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-repo-skips-api-'))
  process.env.POISE_DB = join(root, 'cache.db')
  process.env.POISE_EDITOR_DIR = join(root, 'editor')
  process.env.POISE_CHAT_ATTACHMENTS_DIR = join(root, 'chat')
  process.env.POISE_LOCK_DIR = join(root, 'locks')
  process.env.AGENT_INTERFACE_ROOT = join(root, 'agent-interface')
  process.env.POISE_ESPANSO_MATCH_DIR = join(root, 'espanso')
  delete process.env.POISE_DATASTORE_DB
  pulls = [{ repo: REPO, number: 1, url: `https://github.com/${REPO}/pull/1`, status: 'open', author: 'octocat', draft: 0, updated_at: '2026-07-15T12:00:00Z' }]
  healthFailure = null
  agentRows = []
  mocks.runFile.mockReset().mockImplementation(cli)
  mocks.spawnDetached.mockReset().mockResolvedValue(undefined)
  vi.resetModules()
  database = await import('../server/db')
  database.setMeta('org', 'Legacy')
  database.setMeta('me', 'octocat')
  database.setMeta('agentAccount', 'review-bot')
  // A replay launched here runs on a Codex model: no Claude sign-in is involved.
  database.setMeta('models', JSON.stringify({ pr_review: { default: 'gpt-6-astra-ultra', fallback: 'opus-5-xhigh' } }))
  const behaviors = await import('../server/behaviors')
  vi.spyOn(behaviors, 'startBehaviorsRuntime').mockImplementation(() => undefined)
  vi.spyOn(behaviors, 'stopBehaviorsRuntime').mockResolvedValue(undefined)
  // A second ready account, synced a moment ago so its runtime has nothing to do.
  database.db.prepare(`
    INSERT INTO organizations(login, datastore_path, managed, status, stage, activated_at, last_sync_at, indexed_user, next_sync_at)
    VALUES ('beta', ?, 1, 'ready', 'ready', ?, ?, 'octocat', ?)
  `).run(join(root, 'datastores/beta/github.sqlite'), new Date().toISOString(), Date.now(), Date.now() + 60 * 60_000)
  cache = await import('../server/cache-plugin')
  const middleware = cache.createPoiseMiddleware({ claudeAuth: createAuthenticatedClaudeAuth(), selfUpdateBridge: null })
  server = createServer((req, res) => {
    void middleware(req, res, () => { res.statusCode = 404; res.end() })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  base = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await cache?.stopPoiseRuntime()
  await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve())
  if (database?.db.open) database.closeDatabase()
  database = undefined
  server = undefined
  cache = undefined
  for (const key of envKeys) {
    const value = originalEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

describe('Skip repositories API', () => {
  it.each(['poise:review-new-prs', 'poise:behavior-chain'])('shares a bounded latest-trigger selection for %s when one kind has never run', async (source) => {
    let release!: () => void
    let started!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const selected = new Promise<void>(resolve => { started = resolve })
    const rows = [{
      id: 'a'.repeat(32), model: 'gpt-6-astra-ultra', prompt: '',
      behavior: 'pr_review', source, repo: REPO, pr_id: '1',
      actor: 'review-bot', expected_head: HEAD, head_sha: HEAD, correlation_id: 'selection-fixture',
      started_at: '2026-10-23T12:00:00Z', started_at_precise: '2026-10-23T12:00:00.000Z',
      completed_at: '2026-10-23T12:01:00Z', action: 'reviewed_clean', outcome: 'clean',
      time_elapsed: '1s', status: 'completed', error: '',
    }]
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: RunFileOptions) => {
      if (command === 'agent-interface' && args[1] === '--select') {
        started()
        await held
        return { stdout: JSON.stringify(rows), stderr: '' }
      }
      return cli(command, args, options)
    })
    try {
      const first = behaviorState()
      const concurrent = behaviorState()
      await selected
      // Both requests must reach the held read to share it. A joined
      // request makes no mock call, so its arrival is only observable by
      // waiting: the second HTTP dispatch lands well inside this window.
      await new Promise((resolve) => setTimeout(resolve, 500))
      release()
      const [one, two] = await Promise.all([first, concurrent])
      expect(one['review-new-prs']!.lastTriggered).toEqual({ at: '2026-10-23T12:00:00.000Z', target: `${REPO}#1` })
      expect(one['review-new-issues']!.lastTriggered).toBeNull()
      expect(one.diagnostics!.agentLogsError).toBeNull()
      expect(two).toEqual(one)
      await behaviorState()
      const reads = mocks.runFile.mock.calls.filter(([command, args]) => command === 'agent-interface' && args[0] === '--logs')
      expect(reads).toHaveLength(1)
      expect(reads[0]![1].slice(0, 2)).toEqual(['--logs', '--select'])
      expect(JSON.parse(reads[0]![1][2]).latest).toContainEqual({ behavior: 'issue_review', source: 'poise:review-new-issues', owner: 'Legacy' })
      expect(JSON.parse(reads[0]![1][2]).latest).toContainEqual({ behavior: 'pr_review', source: 'poise:behavior-chain', owner: 'Legacy' })
    } finally { release() }
  })

  it('reports unavailable selection as unknown history for an older Caller', async () => {
    mocks.runFile.mockImplementation(async (command: string, args: string[], options: RunFileOptions) => {
      if (command === 'agent-interface' && args[1] === '--select') {
        throw Object.assign(new Error('unsupported Caller flags'), { stderr: 'usage: agent-interface BEHAVIOR ...' })
      }
      return cli(command, args, options)
    })
    const state = await behaviorState()
    expect(state['review-new-prs']!.lastTriggered).toBeNull()
    expect(state.diagnostics!.agentLogsError).toBe('Update Caller: selected log reads are unavailable')
  })

  it('serves time-filtered metrics and rejects invalid period boundaries', async () => {
    database!.db.prepare('INSERT INTO behavior_runs(id, behavior, started_at, completed_at, status) VALUES (?, ?, ?, ?, ?)')
      .run('merge-run', 'merge-prs', '2026-10-17T10:00:00Z', '2026-10-17T10:02:00Z', 'completed')
    const response = await fetch(`${base}/api/behavior-metrics?since=2026-10-17T00:00:00Z&until=2026-10-18T00:00:00Z`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ error: null, behaviors: {
      'merge-prs': { totalRuns: 1, durationMinutes: 2, successRate: 100 },
      'review-new-prs': { totalRuns: 0, durationMinutes: 0, successRate: null },
    } })
    const before = await fetch(`${base}/api/behavior-metrics?until=2026-10-17T00:00:00Z`)
    expect(await before.json()).toMatchObject({ behaviors: { 'merge-prs': { totalRuns: 0 } } })
    for (const query of ['since=invalid', 'since=2026-10-17T00:00:00', 'since=2026-10-18T00:00:00Z&until=2026-10-17T00:00:00Z']) {
      expect((await fetch(`${base}/api/behavior-metrics?${query}`)).status).toBe(400)
    }
  })

  it.each(['provider_execution', 'submitting'])('keeps failed historical %s diagnostics readable through the metrics API', async (phase) => {
    const pairs = [['review-new-prs', 'pr_review'], ['approve-prs', 'pr_approve'], ['review-new-issues', 'issue_review']] as const
    agentRows = pairs.map(([key, behavior], index) => ({
      id: String(index + 1).repeat(32), repo: REPO, pr_id: '1', actor: 'review-bot', model: 'model',
      behavior, source: `poise:${key}`, session_id: null, prompt: '',
      started_at: '2026-10-17T10:00:00Z', completed_at: '2026-10-17T10:01:00Z', time_elapsed: '1m',
      status: 'failed', outcome: null, action: null, head_sha: null, expected_head: HEAD,
      correlation_id: `original-${index}`, error: 'Review failed',
      diagnostic: { version: 1, source: 'caller', severity: 'error', operation: 'provider.review', phase,
        submission: phase === 'submitting' ? 'uncertain' : 'none',
        ...(phase === 'provider_execution' ? { stderr: 'codex exited 1' } : {}) },
    }))
    const response = await fetch(`${base}/api/behavior-metrics`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ error: null, behaviors: Object.fromEntries(pairs.map(([key]) => [key,
      { totalRuns: 1, durationMinutes: 1, successRate: 0 }])) })
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('contains unsupported diagnostics to their behavior and period through the metrics API', async () => {
    agentRows = [{ id: 'a'.repeat(32), repo: REPO, pr_id: '1', actor: 'review-bot', model: 'model',
      behavior: 'pr_review', source: 'poise:review-new-prs', prompt: '',
      started_at: '2026-10-17T10:00:00Z', completed_at: '2026-10-17T10:01:00Z', time_elapsed: '1m',
      status: 'failed', expected_head: HEAD, correlation_id: 'unreadable-call', error: 'Review failed', diagnostic: { version: 2 } }]
    const all = await fetch(`${base}/api/behavior-metrics`)
    expect(await all.json()).toMatchObject({ error: expect.stringContaining('unreadable'), behaviors: {
      'review-new-prs': null, 'approve-prs': { totalRuns: 0 }, 'review-new-issues': { totalRuns: 0 },
    } })
    const later = await fetch(`${base}/api/behavior-metrics?since=2026-10-18T00:00:00Z`)
    expect(await later.json()).toMatchObject({ error: null, behaviors: { 'review-new-prs': { totalRuns: 0 } } })
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it.each(['[broken', JSON.stringify({ at: 'invalid', target: 7 })])('keeps behavior controls readable when merge history is corrupt: %s', async (value) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    database!.setMeta('behavior_merge_prs_last_fired', value)
    const state = await behaviorState()
    expect(state['merge-prs']!.lastTriggered).toBeNull()
    expect(state['approve-prs']!.enabled).toBe(false)
    expect(logged).toHaveBeenCalledWith('[behaviors] merge-prs last triggered could not be read:', expect.any(Error))
  })

  it('starts grey CI recovery off and persists its global toggle and repository skips', async () => {
    expect((await behaviorState())['rerun-grey-ci']).toMatchObject({ enabled: false, skipRepos: [], lastTriggered: null, lastSucceeded: null })
    expect((await post('/api/behaviors/rerun-grey-ci?org=beta', { enabled: true, skipRepos: [REPO] })).status).toBe(200)
    expect((await behaviorState())['rerun-grey-ci']).toMatchObject({ enabled: true, skipRepos: [REPO] })
  })

  it('starts merging off and persists its global toggle and repository exclusions', async () => {
    expect((await behaviorState())['merge-prs']).toMatchObject({ enabled: false, scratchpad: null, lastTriggered: null, skipRepos: [] })
    expect((await post('/api/behaviors/merge-prs?org=beta', { enabled: true, skipRepos: [REPO] })).status).toBe(200)
    for (const query of ['', '?org=beta']) {
      expect((await behaviorState(query))['merge-prs']).toMatchObject({ enabled: true, skipRepos: [REPO] })
    }
    expect((await post('/api/behaviors/merge-prs', { enabled: false })).status).toBe(200)
    expect((await behaviorState())['merge-prs']!.enabled).toBe(false)
  })

  it('saves a list per PR behavior and serves the same lists to every account', async () => {
    const saved = await post('/api/behaviors/review-new-prs?org=beta', { skipRepos: ['beta/app', REPO, 'legacy/SAME-REPO'] })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(saved.body.skipRepos).toEqual(['beta/app', REPO])
    expect((await post('/api/behaviors/resolve-unblocking', { skipRepos: ['beta/app'] })).body.skipRepos).toEqual(['beta/app'])
    for (const query of ['', '?org=Legacy', '?org=beta']) {
      const state = await behaviorState(query)
      expect(state['review-new-prs']!.skipRepos).toEqual(['beta/app', REPO])
      expect(state['approve-prs']!.skipRepos).toEqual([])
      expect(state['resolve-unblocking']!.skipRepos).toEqual(['beta/app'])
      expect(state['review-new-issues']).not.toHaveProperty('skipRepos')
    }
    expect(database!.getMeta('org:beta:behavior_review_new_prs_skip_repos')).toBeNull()
    // Saving a list asks nothing of GitHub: an opt-out cannot wait on a listing.
    expect(mocks.runFile.mock.calls.filter(([command]) => command === 'github-interface')).toEqual([])
  })

  it.each([
    ['not a list', 'beta/app', 'skipRepos must be a list of up to 5000 owner/name repositories'],
    ['a malformed name', ['beta/app', 'not a repository'], 'skipRepos must be a list of up to 5000 owner/name repositories'],
    ['too many names', Array.from({ length: 5001 }, (_, index) => `beta/repo-${index}`), 'skipRepos must be a list of up to 5000 owner/name repositories'],
    ['a repository outside every ready account', ['beta/app', 'stranger/app'], 'not a repository of a ready GitHub account: stranger/app'],
  ])('refuses %s and saves nothing, enabling included', async (_case, skipRepos, error) => {
    const refused = await post('/api/behaviors/approve-prs', { enabled: true, skipRepos })
    expect(refused).toEqual({ status: 400, body: { error } })
    const state = await behaviorState()
    expect(state['approve-prs']).toMatchObject({ enabled: false, skipRepos: [] })
    expect(database!.getMeta('behavior_approve_prs_skip_repos')).toBeNull()
  })

  it('refuses a skip list for Review New Issues, which stays opt-in', async () => {
    expect(await post('/api/behaviors/review-new-issues', { skipRepos: [REPO] })).toEqual({
      status: 400, body: { error: 'only pull-request behaviors skip repositories' },
    })
  })

  it('keeps a skipped repository whose account is gone, so it can still be removed', async () => {
    database!.setMeta('behavior_approve_prs_skip_repos', JSON.stringify(['gone/app']))
    expect((await post('/api/behaviors/approve-prs', { skipRepos: ['gone/app', REPO] })).body.skipRepos).toEqual(['gone/app', REPO])
    expect((await post('/api/behaviors/approve-prs', { skipRepos: [REPO] })).body.skipRepos).toEqual([REPO])
    expect((await post('/api/behaviors/approve-prs', { skipRepos: ['gone/app'] })).status).toBe(400)
  })

  it('changes nothing the scheduler recorded', async () => {
    database!.setMeta('behavior_review_new_prs_enabled', '1')
    database!.recordSeen('review-new-prs', '__snapshot_v3__')
    database!.recordSeen('review-new-prs', `${REPO}#1`)
    const ledger = () => database!.db.prepare('SELECT key, target, seen_at, claim_id FROM behavior_seen ORDER BY key, target').all()
    const before = ledger()
    expect((await post('/api/behaviors/review-new-prs', { skipRepos: [REPO] })).status).toBe(200)
    expect((await post('/api/behaviors/review-new-prs', { skipRepos: [] })).status).toBe(200)
    expect(ledger()).toEqual(before)
    expect((await behaviorState())['review-new-prs']!.enabled).toBe(true)
  })
})

describe('Replay API', () => {
  const replay = (body: Record<string, unknown>) => post('/api/agent-replay', body)

  it('launches a replay the scheduler would have launched', async () => {
    const launched = await replay({ behavior: 'pr_review', repo: REPO, pr_id: '1' })
    expect(launched.status, JSON.stringify(launched.body)).toBe(200)
    expect(launched.body).toMatchObject({ ok: true, source: 'poise:replay' })
    expect(mocks.spawnDetached).toHaveBeenCalledOnce()
    expect(mocks.spawnDetached.mock.calls[0][1]).toEqual(expect.arrayContaining(['--pr-review', '#1', '--expected-head', HEAD, '--source', 'poise:replay']))
  })

  const cases: Array<[string, () => void, 'pr_review' | 'pr_approve' | 'issue_review', string]> = [
    ['a draft', () => { pulls[0]!.draft = 1 }, 'pr_review', `Replay refused: ${REPO}#1 is a draft.`],
    ['a merged pull request', () => { pulls[0]!.status = 'merged' }, 'pr_approve', `Replay refused: ${REPO}#1 is not an open pull request.`],
    ['someone else\'s pull request', () => { pulls[0]!.author = 'mallory' }, 'pr_review', `Replay refused: ${REPO}#1 is authored by mallory, outside your configured GitHub account pair.`],
    ['a skipped repository', () => database!.setMeta('behavior_approve_prs_skip_repos', JSON.stringify([REPO])), 'pr_approve', `Replay refused: ${REPO} is in the Skip repositories list of Approve Pull Requests.`],
    ['an issue in a repository that is not opted in', () => undefined, 'issue_review', `Replay refused: ${REPO} is not opted in to Review New Issues.`],
  ]
  it.each(cases)('refuses %s with 409, naming the check, and launches nothing', async (_case, arrange, behavior, error) => {
    arrange()
    expect(await replay({ behavior, repo: REPO, pr_id: '1' })).toEqual({ status: 409, body: { error } })
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('cannot be talked past the check by what the request claims', async () => {
    pulls[0]!.author = 'mallory'
    // The Swarm row says nothing the server trusts: a different spelling or
    // behavior name reads the same facts, and an unknown behavior is refused.
    for (const body of [
      { behavior: 'pr_review', repo: REPO, pr_id: 1, author: 'octocat' },
      { behavior: 'pr_approve', repo: REPO, pr_id: '1', draft: false, status: 'open' },
    ]) expect((await replay(body)).status).toBe(409)
    expect(await replay({ behavior: 'resolve_unblocking', repo: REPO, pr_id: '1' })).toEqual({
      status: 400, body: { error: 'agent-replay failed: behavior "resolve_unblocking" is not replayable' },
    })
    expect(await replay({ behavior: 'pr_review', repo: 'a/b/c', pr_id: '1' })).toEqual({
      status: 400, body: { error: 'agent-replay failed: repo must be owner/name' },
    })
    // Shaped like owner/name but no account's: refused before anything is read.
    const reads = mocks.runFile.mock.calls.length
    expect(await replay({ behavior: 'pr_review', repo: '../etc', pr_id: '1' })).toEqual({
      status: 409, body: { error: 'Replay refused: ../etc does not belong to a ready GitHub account.' },
    })
    expect(mocks.runFile.mock.calls).toHaveLength(reads)
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })

  it('launches nothing when the facts cannot be read', async () => {
    healthFailure = new Error('datastore unavailable')
    expect(await replay({ behavior: 'pr_review', repo: REPO, pr_id: '1' })).toEqual({
      status: 502,
      body: { error: `agent-replay failed: Replay could not check ${REPO}#1: github-datastore freshness gate failed: datastore unavailable` },
    })
    expect(mocks.spawnDetached).not.toHaveBeenCalled()
  })
})
