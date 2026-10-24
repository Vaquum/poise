import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthenticatedClaudeAuth } from './claude-auth-fixture'

vi.setConfig({ testTimeout: 25_000, hookTimeout: 25_000 })

// The Manager controls and the local turn limit are person-only: saves
// containing them are refused without the person's authority, before
// anything is stored, while saves of other fields keep working.
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

const runScript = promisify(execFile)

let root = ''
let server: Server | undefined
let base = ''
let database: typeof import('../server/db') | undefined
let cache: typeof import('../server/cache-plugin') | undefined
let settings: typeof import('../server/settings') | undefined
const envKeys = ['POISE_DB', 'POISE_EDITOR_DIR', 'POISE_CHAT_ATTACHMENTS_DIR', 'POISE_LOCK_DIR', 'AGENT_INTERFACE_ROOT', 'POISE_ESPANSO_MATCH_DIR', 'POISE_DATASTORE_DB']
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]))

async function save(body: unknown, person: boolean): Promise<{ status: number, body: any }> {
  const response = await fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(person ? { Origin: base } : {}) },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-manager-controls-'))
  process.env.POISE_DB = join(root, 'cache.db')
  process.env.POISE_EDITOR_DIR = join(root, 'editor')
  process.env.POISE_CHAT_ATTACHMENTS_DIR = join(root, 'chat')
  process.env.POISE_LOCK_DIR = join(root, 'locks')
  process.env.AGENT_INTERFACE_ROOT = join(root, 'agent-interface')
  process.env.POISE_ESPANSO_MATCH_DIR = join(root, 'espanso')
  delete process.env.POISE_DATASTORE_DB
  mocks.runFile.mockReset().mockImplementation(async () => { throw new Error('Unexpected test command') })
  mocks.spawnDetached.mockReset().mockResolvedValue(undefined)
  vi.resetModules()
  database = await import('../server/db')
  settings = await import('../server/settings')
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
  await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve())
  if (database?.db.open) database.closeDatabase()
  database = undefined
  server = undefined
  cache = undefined
  settings = undefined
  for (const key of envKeys) {
    const value = originalEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

describe('who may save the Manager controls', () => {
  it('lets the browser save the controls and bumps the policy version', async () => {
    const first = await save({ manager: { rhythm: 2 } }, true)
    expect(first.status).toBe(200)
    expect(first.body.manager).toMatchObject({ rhythm: 2, version: 1 })
    const second = await save({ manager: { paused: true }, timezone: 'UTC' }, true)
    expect(second.status).toBe(200)
    expect(second.body.manager).toMatchObject({ rhythm: 2, paused: true, version: 2 })
    expect(second.body.timezone).toBe('UTC')
  })

  it('refuses a save with the controls or the turn limit that does not speak for the person, storing nothing', async () => {
    for (const body of [{ manager: { rhythm: 2 } }, { chat: { maxConcurrentLocalTurns: 8 } }, { manager: { paused: true }, timezone: 'UTC' }]) {
      const refused = await save(body, false)
      expect(refused.status, JSON.stringify(body)).toBe(403)
      expect(refused.body.error).toMatch(/the person's/)
    }
    expect(settings!.getSettings().manager).toMatchObject({ rhythm: 5, paused: false, version: 0 })
    expect(settings!.getSettings().chat.maxConcurrentLocalTurns).toBe(4)
    expect(settings!.getSettings().timezone).toBe('')
  })

  it('keeps saving other fields for every caller', async () => {
    const result = await save({ timezone: 'UTC', notifications: { enabled: false } }, false)
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ timezone: 'UTC', notifications: { enabled: false } })
  })

  it('refuses the native control CLI, which sends no origin', async () => {
    const config = join(root, 'control.json')
    await writeFile(config, JSON.stringify({ origin: base, sessionId: 's', token: 't' }))
    const script = join(process.cwd(), 'scripts', 'poise-chat-control.mjs')
    const run = (payload: unknown) => runScript(process.execPath, [script, config, JSON.stringify({ operation: 'api', path: '/api/settings', method: 'POST', body: payload })])
      .then(() => null, (error: any) => String(error?.stderr ?? error))
    expect(await run({ manager: { rhythm: 2 } })).toMatch(/"status":\s*403/)
    expect(await run({ chat: { maxConcurrentLocalTurns: 8 } })).toMatch(/"status":\s*403/)
    expect(settings!.getSettings().manager).toMatchObject({ rhythm: 5, version: 0 })
  })
})
