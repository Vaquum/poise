import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthenticatedClaudeAuth } from './claude-auth-fixture'
import { CATALOG_STDOUT } from './model-catalog-fixture'

// GET /api/behavior-estimates through the real endpoint: running behavior
// runs with their remaining medians from the history lane.
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

vi.setConfig({ testTimeout: 25_000, hookTimeout: 25_000 })

let root = ''
let server: Server | undefined
let base = ''
let database: typeof import('../server/db') | undefined
let cache: typeof import('../server/cache-plugin') | undefined
let history: Array<Record<string, unknown>> = []
let running: Array<Record<string, unknown>> = []
const envKeys = ['POISE_DB', 'POISE_EDITOR_DIR', 'POISE_CHAT_ATTACHMENTS_DIR', 'POISE_LOCK_DIR', 'AGENT_INTERFACE_ROOT', 'POISE_ESPANSO_MATCH_DIR', 'POISE_DATASTORE_DB']
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]))

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pr_id: '12', repo: 'owner/repo', actor: 'review-bot', model: 'opus-5-xhigh', behavior: 'pr_review',
    session_id: null, prompt: '', time_elapsed: '1m', status: 'completed', outcome: 'clean',
    head_sha: 'a'.repeat(40), expected_head: 'a'.repeat(40), source: 'poise:review-new-prs',
    correlation_id: 'correlation-fixture', action: 'reviewed_clean', response: null, error: '',
    ...overrides,
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-behavior-estimates-api-'))
  process.env.POISE_DB = join(root, 'cache.db')
  process.env.POISE_EDITOR_DIR = join(root, 'editor')
  process.env.POISE_CHAT_ATTACHMENTS_DIR = join(root, 'chat')
  process.env.POISE_LOCK_DIR = join(root, 'locks')
  process.env.AGENT_INTERFACE_ROOT = join(root, 'agent-interface')
  process.env.POISE_ESPANSO_MATCH_DIR = join(root, 'espanso')
  delete process.env.POISE_DATASTORE_DB
  history = []
  running = []
  mocks.runFile.mockReset().mockImplementation(async (command: string, args: string[]) => {
    if (command === 'agent-interface' && args[0] === '--models') return { stdout: CATALOG_STDOUT, stderr: '' }
    if (command === 'agent-interface' && args[0] === '--logs') {
      return { stdout: JSON.stringify(args.includes('--status') ? running : history), stderr: '' }
    }
    throw new Error(`Unexpected test command: ${command} ${args.join(' ')}`)
  })
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

describe('behavior estimates API', () => {
  it('estimates a running review from its history lane cohort', async () => {
    const now = Date.now()
    const iso = (ms: number) => new Date(ms).toISOString()
    history = [1, 2, 3, 4, 5].map((n, index) => row({
      id: `${(index + 10).toString(16)}`.padStart(32, '0'),
      started_at: iso(now - 10 * 60_000 - n * 60_000),
      started_at_precise: iso(now - 10 * 60_000 - n * 60_000),
      completed_at: iso(now - 10 * 60_000),
    }))
    running = [row({ id: 'e'.repeat(32), status: 'running', started_at: iso(now - 60_000),
      started_at_precise: iso(now - 60_000), completed_at: null, outcome: null, action: null })]
    const response = await fetch(`${base}/api/behavior-estimates`)
    expect(response.status).toBe(200)
    const body = await response.json() as { estimates: Array<Record<string, unknown>> }
    expect(body.estimates).toHaveLength(1)
    expect(body.estimates[0]).toMatchObject({
      behavior: 'pr_review', model: 'opus-5-xhigh',
      estimate: { basis: { medianMs: 3 * 60_000, p90Ms: 5 * 60_000 }, samples: 5 },
    })
    const remaining = (body.estimates[0]!.estimate as { remainingMs: number }).remainingMs
    expect(remaining).toBeGreaterThan(60_000)
    expect(remaining).toBeLessThanOrEqual(2 * 60_000)
  })

  it('reports no estimate below five samples and answers 502 when the log cannot be read', async () => {
    history = []
    running = [row({ id: 'e'.repeat(32), status: 'running', started_at: new Date().toISOString(), completed_at: null, outcome: null, action: null })]
    const response = await fetch(`${base}/api/behavior-estimates`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      estimates: [{ id: 'e'.repeat(32), behavior: 'pr_review', model: 'opus-5-xhigh',
        startedAt: running[0]!.started_at, estimate: null }],
    })

    mocks.runFile.mockImplementation(async () => { throw new Error('log unavailable') })
    const { resetAgentLogCache } = await import('../server/agent')
    resetAgentLogCache()
    const failed = await fetch(`${base}/api/behavior-estimates`)
    expect(failed.status).toBe(502)
  })
})
