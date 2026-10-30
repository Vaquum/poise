import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthenticatedClaudeAuth } from './claude-auth-fixture'

vi.setConfig({ testTimeout: 25_000, hookTimeout: 25_000 })

// A settings save that carries the values its tab read: when another save
// landed first, the API refuses with 409 and the current values, changing
// nothing.
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
let cache: typeof import('../server/cache-plugin') | undefined
const envKeys = ['POISE_DB', 'POISE_EDITOR_DIR', 'POISE_CHAT_ATTACHMENTS_DIR', 'POISE_LOCK_DIR', 'AGENT_INTERFACE_ROOT', 'POISE_ESPANSO_MATCH_DIR', 'POISE_DATASTORE_DB']
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]))

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number, body: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.json() }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-settings-conflict-api-'))
  process.env.POISE_DB = join(root, 'cache.db')
  process.env.POISE_EDITOR_DIR = join(root, 'editor')
  process.env.POISE_CHAT_ATTACHMENTS_DIR = join(root, 'chat')
  process.env.POISE_LOCK_DIR = join(root, 'locks')
  process.env.AGENT_INTERFACE_ROOT = join(root, 'agent-interface')
  process.env.POISE_ESPANSO_MATCH_DIR = join(root, 'espanso')
  delete process.env.POISE_DATASTORE_DB
  mocks.runFile.mockReset().mockImplementation(async (command: string, args: string[]) => {
    if (command === 'agent-interface' && args[0] === '--diagnostics') return { stdout: JSON.stringify({ version: 1, streamId: 'f'.repeat(32), events: [], cursor: Number(args[1]), hasMore: false, backfillPending: false }) }
    throw new Error(`Unexpected test command: ${command} ${args.join(' ')}`)
  })
  mocks.spawnDetached.mockReset().mockResolvedValue(undefined)
  vi.resetModules()
  const behaviors = await import('../server/behaviors')
  vi.spyOn(behaviors, 'startBehaviorsRuntime').mockImplementation(() => undefined)
  vi.spyOn(behaviors, 'stopBehaviorsRuntime').mockResolvedValue(undefined)
  cache = await import('../server/cache-plugin')
  const middleware = cache.createPoiseMiddleware({ claudeAuth: createAuthenticatedClaudeAuth(), selfUpdateBridge: null })
  server = createServer((req, res) => {
    void middleware(req, res, () => { res.statusCode = 404; res.end('{}') })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  base = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  await cache?.stopPoiseRuntime()
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve())
  server = undefined
  for (const key of envKeys) {
    const value = originalEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(root, { recursive: true, force: true })
})

describe('a settings save that overwrites another tab', () => {
  it('keeps chain intake disabled by default and requires an explicit conflict-checked scope', async () => {
    const initial = await call('GET', '/api/settings')
    const defaults = { enabled: false, seedMode: 'label', label: 'poise' }
    expect(initial.body.behaviorChain).toEqual(defaults)
    const labelMode = { enabled: false, seedMode: 'label', label: 'ready-for-poise' }
    expect((await call('POST', '/api/settings', { behaviorChain: labelMode, expect: { behaviorChain: defaults } })).status).toBe(200)
    expect((await call('POST', '/api/settings', { behaviorChain: { ...labelMode, seedMode: 'all' }, expect: { behaviorChain: defaults } })).status).toBe(409)
    expect((await call('GET', '/api/settings')).body.behaviorChain).toEqual(labelMode)
    expect((await call('POST', '/api/settings', { behaviorChain: { enabled: true, seedMode: 'all' } })).status).toBeGreaterThanOrEqual(400)
    expect((await call('GET', '/api/settings')).body.behaviorChain).toEqual(labelMode)
  })

  it('is refused with 409 and the current values, changing nothing', async () => {
    const first = await call('POST', '/api/settings', { timezone: 'Europe/Helsinki' })
    expect(first.status).toBe(200)
    const version = (await call('GET', '/api/settings')).body.manager.version
    const refused = await call('POST', '/api/settings', { timezone: 'UTC', expect: { timezone: 'what-tab-two-read' } })
    expect(refused.status).toBe(409)
    expect(refused.body.current).toEqual({ timezone: 'Europe/Helsinki' })
    const after = await call('GET', '/api/settings')
    expect(after.body.timezone).toBe('Europe/Helsinki')
    expect(after.body.manager.version).toBe(version)
  })

  it('saves when every expected value still holds', async () => {
    await call('POST', '/api/settings', { timezone: 'Europe/Helsinki' })
    const saved = await call('POST', '/api/settings', { timezone: 'UTC', expect: { timezone: 'Europe/Helsinki' } })
    expect(saved.status).toBe(200)
    expect(saved.body.timezone).toBe('UTC')
  })
})
