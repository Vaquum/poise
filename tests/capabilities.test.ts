import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthenticatedClaudeAuth } from './claude-auth-fixture'

vi.setConfig({ testTimeout: 25_000, hookTimeout: 25_000 })

// GET /api/capabilities through the real endpoint: the names of the
// redesigned-interface capabilities this server has, which #556's
// interface reads once at mount.
vi.mock('../server/storage-maintenance', async (original) => ({
  ...(await original<typeof import('../server/storage-maintenance')>()),
  startStorageMaintenanceRuntime: vi.fn(),
  stopStorageMaintenanceRuntime: vi.fn(async () => undefined),
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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-capabilities-'))
  process.env.POISE_DB = join(root, 'cache.db')
  process.env.POISE_EDITOR_DIR = join(root, 'editor')
  process.env.POISE_CHAT_ATTACHMENTS_DIR = join(root, 'chat')
  process.env.POISE_LOCK_DIR = join(root, 'locks')
  process.env.AGENT_INTERFACE_ROOT = join(root, 'agent-interface')
  process.env.POISE_ESPANSO_MATCH_DIR = join(root, 'espanso')
  delete process.env.POISE_DATASTORE_DB
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

describe('GET /api/capabilities', () => {
  it('lists the delivered capabilities by name', async () => {
    const response = await fetch(`${base}/api/capabilities`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      capabilities: [
        'held-reasons',
        'review-requests',
        'approve-merge',
        'behavior-pause',
        'organization-unfollow',
        'behavior-estimates',
        'chat-requests',
        'handled-log',
        'publication-reviews',
        'settings-conflict',
      ],
    })
  })

  it('omits the Manager capabilities until their enforcement lands', async () => {
    const response = await fetch(`${base}/api/capabilities`)
    const body = await response.json() as { capabilities: string[] }
    expect(body.capabilities).not.toContain('manager-controls')
    expect(body.capabilities).not.toContain('manager-plan')
    expect(body.capabilities).not.toContain('manager-escalation')
  })
})
