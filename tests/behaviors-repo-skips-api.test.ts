import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunFileOptions } from '../server/process'
import { createAuthenticatedClaudeAuth } from './claude-auth-fixture'
import { CATALOG_STDOUT } from './model-catalog-fixture'

// The Skip repositories lists through the HTTP API the Behaviors view uses,
// with Caller faked at the process boundary.
const mocks = vi.hoisted(() => ({ runFile: vi.fn(), spawnDetached: vi.fn() }))
vi.mock('../server/process', async (original) => ({
  ...(await original<typeof import('../server/process')>()),
  runFile: mocks.runFile,
  spawnDetached: mocks.spawnDetached,
}))
vi.mock('../server/content-jobs', async (original) => ({
  ...(await original<typeof import('../server/content-jobs')>()),
  startContentFinalizer: vi.fn(),
  stopContentFinalizer: vi.fn(async () => undefined),
}))
vi.mock('../server/chat/runtime', async (original) => {
  const { EventEmitter } = await import('node:events')
  return {
    ...(await original<typeof import('../server/chat/runtime')>()),
    ChatRuntime: class extends EventEmitter {
      draining = null
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
let healthFailure: Error | null = null
const envKeys = ['POISE_DB', 'POISE_EDITOR_DIR', 'POISE_CHAT_ATTACHMENTS_DIR', 'POISE_LOCK_DIR', 'AGENT_INTERFACE_ROOT', 'POISE_ESPANSO_MATCH_DIR', 'POISE_DATASTORE_DB']
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]))

async function cli(command: string, args: string[], options: RunFileOptions) {
  const json = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: '' })
  if (command === 'agent-interface' && args[0] === '--models') return { stdout: CATALOG_STDOUT, stderr: '' }
  if (command === 'agent-interface' && args[0] === '--logs') return json([])
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
  pulls = [{ repo: REPO, number: 1, url: `https://github.com/${REPO}/pull/1`, status: 'open', author: 'octocat', draft: 0 }]
  healthFailure = null
  mocks.runFile.mockReset().mockImplementation(cli)
  mocks.spawnDetached.mockReset().mockResolvedValue(undefined)
  vi.resetModules()
  database = await import('../server/db')
  database.setMeta('org', 'Legacy')
  database.setMeta('me', 'octocat')
  database.setMeta('agentAccount', 'review-bot')
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
      status: 400, body: { error: 'only review-new-prs, approve-prs and resolve-unblocking skip repositories' },
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
