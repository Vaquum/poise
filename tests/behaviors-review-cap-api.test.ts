import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthenticatedClaudeAuth } from './claude-auth-fixture'
import { CATALOG_STDOUT } from './model-catalog-fixture'

// The review-round cap through the HTTP API the Behaviors view uses: off by
// default, null or 2-10 on approve-prs, rejected everywhere else.
const mocks = vi.hoisted(() => ({ runFile: vi.fn(), spawnDetached: vi.fn() }))
vi.mock('../server/process', async (original) => ({
  ...(await original<typeof import('../server/process')>()),
  runFile: mocks.runFile,
  spawnDetached: mocks.spawnDetached,
}))
vi.mock('../server/storage-maintenance', async (original) => ({
  ...(await original<typeof import('../server/storage-maintenance')>()),
  startStorageMaintenanceRuntime: vi.fn(),
  stopStorageMaintenanceRuntime: vi.fn(async () => undefined),
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

let root = ''
let server: Server | undefined
let base = ''
let database: typeof import('../server/db') | undefined
let cache: typeof import('../server/cache-plugin') | undefined
const envKeys = ['POISE_DB', 'POISE_EDITOR_DIR', 'POISE_CHAT_ATTACHMENTS_DIR', 'POISE_LOCK_DIR', 'AGENT_INTERFACE_ROOT', 'POISE_ESPANSO_MATCH_DIR', 'POISE_DATASTORE_DB']
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]))

async function cli(command: string, args: string[]) {
  const json = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: '' })
  if (command === 'agent-interface' && args[0] === '--models') return { stdout: CATALOG_STDOUT, stderr: '' }
  if (command === 'agent-interface' && args[0] === '--logs') return json({ rows: [], nextCursor: null })
  if (command === 'github-datastore' && args[0] === 'health') {
    const now = new Date().toISOString()
    return json({ action: 'health', status: 'healthy', healthy: true, database: join(root, 'github.sqlite'),
      max_age_seconds: 120, age_seconds: 1, last_sync_at: now, last_success_at: now, checked_at: now })
  }
  if (command === 'github-datastore' && args[0] === 'view') return json([])
  throw new Error(`Unexpected test command: ${command} ${args.join(' ')}`)
}

async function post(path: string, body: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

async function behaviorState(): Promise<Record<string, Record<string, unknown>>> {
  const response = await fetch(`${base}/api/behaviors`)
  expect(response.status).toBe(200)
  return await response.json() as Record<string, Record<string, unknown>>
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-review-cap-api-'))
  process.env.POISE_DB = join(root, 'cache.db')
  process.env.POISE_EDITOR_DIR = join(root, 'editor')
  process.env.POISE_CHAT_ATTACHMENTS_DIR = join(root, 'chat')
  process.env.POISE_LOCK_DIR = join(root, 'locks')
  process.env.AGENT_INTERFACE_ROOT = join(root, 'agent-interface')
  process.env.POISE_ESPANSO_MATCH_DIR = join(root, 'espanso')
  delete process.env.POISE_DATASTORE_DB
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

describe('review cap API', () => {
  it('is off by default', async () => {
    const state = await behaviorState()
    expect(state['approve-prs']!.reviewCap).toBeNull()
  })

  it('sets and clears the cap on approve-prs', async () => {
    const set = await post('/api/behaviors/approve-prs', { reviewCap: 5 })
    expect(set.status).toBe(200)
    expect(set.body.reviewCap).toBe(5)
    expect((await behaviorState())['approve-prs']!.reviewCap).toBe(5)
    expect(database!.getMeta('behavior_approve_prs_review_cap')).toBe('5')

    const cleared = await post('/api/behaviors/approve-prs', { reviewCap: null })
    expect(cleared.status).toBe(200)
    expect(cleared.body.reviewCap).toBeNull()
    expect((await behaviorState())['approve-prs']!.reviewCap).toBeNull()
  })

  it('rejects out-of-range caps', async () => {
    for (const reviewCap of [0, 1, 11, 2.5, '5', true, {}, []]) {
      const response = await post('/api/behaviors/approve-prs', { reviewCap })
      expect(response.status).toBe(400)
      expect(response.body.error).toBe('reviewCap must be null or an integer from 2 to 10')
    }
    expect((await behaviorState())['approve-prs']!.reviewCap).toBeNull()
  })

  it('rejects the cap on other behaviors', async () => {
    const response = await post('/api/behaviors/review-new-prs', { reviewCap: 5 })
    expect(response.status).toBe(400)
    expect(response.body.error).toBe('only approve-prs takes a review cap')
  })
})
