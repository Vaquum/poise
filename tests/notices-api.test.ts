import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuthenticatedClaudeAuth } from './claude-auth-fixture'

// The notices through the HTTP API the page's notification island uses, and
// the Notifications setting that turns them off.
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

let root = ''
let server: Server | undefined
let base = ''
let database: typeof import('../server/db') | undefined
let store: typeof import('../server/alerts/store') | undefined
let cache: typeof import('../server/cache-plugin') | undefined
const envKeys = ['POISE_DB', 'POISE_EDITOR_DIR', 'POISE_CHAT_ATTACHMENTS_DIR', 'POISE_LOCK_DIR', 'AGENT_INTERFACE_ROOT', 'POISE_ESPANSO_MATCH_DIR', 'POISE_DATASTORE_DB']
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]))

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number, body: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.json() }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-notices-api-'))
  process.env.POISE_DB = join(root, 'cache.db')
  process.env.POISE_EDITOR_DIR = join(root, 'editor')
  process.env.POISE_CHAT_ATTACHMENTS_DIR = join(root, 'chat')
  process.env.POISE_LOCK_DIR = join(root, 'locks')
  process.env.AGENT_INTERFACE_ROOT = join(root, 'agent-interface')
  process.env.POISE_ESPANSO_MATCH_DIR = join(root, 'espanso')
  delete process.env.POISE_DATASTORE_DB
  // Nothing here may reach a CLI: no GitHub account is set, so the check of
  // pull requests has nothing to read.
  mocks.runFile.mockReset().mockImplementation(async (command: string, args: string[]) => {
    throw new Error(`Unexpected test command: ${command} ${args.join(' ')}`)
  })
  mocks.spawnDetached.mockReset().mockResolvedValue(undefined)
  vi.resetModules()
  database = await import('../server/db')
  store = await import('../server/alerts/store')
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
  store = undefined
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

const waiting = { kind: 'chat_waiting', dedupeKey: 'chat-waiting:s1', title: 'Claude Code is waiting for you', body: 'Allow it?', path: '/', target: { chat: 's1' } } as const
const ready = { kind: 'pr_ready', dedupeKey: 'pr-ready:acme/api#1', title: 'acme/api#1 is ready to merge', body: 'Change 1', path: '/', target: { pullRequest: 'https://github.com/acme/api/pull/1' } } as const

describe('the notices API', () => {
  it('gives an existing failed-behavior notice its exact Swarm call', async () => {
    const failed = store!.raiseAlert({
      kind: 'behavior_held', dedupeKey: 'behavior-held:approve-prs:acme/api#9',
      title: 'Approve Pull Requests failed on acme/api#9',
      body: 'Open Behaviors in Poise to see what happened.', path: '/', target: { view: 'behaviors' },
    })!
    database!.db.prepare(`
      INSERT INTO behavior_dead_letters(id, behavior, target, repo, pr, call_id, error, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    `).run('failed', 'approve-prs', 'acme/api#9', 'acme/api', 9, 'failed-call', 'Approval failed', new Date().toISOString())
    const answer = await call('GET', '/api/notices')
    expect(answer.status).toBe(200)
    expect(answer.body.notices).toEqual([expect.objectContaining({
      id: failed.id, target: { swarm: 'failed-call' }, body: 'Open Swarm in Poise to see what happened.',
    })])
  })

  it('serves what the page shows, the most pressing first', async () => {
    store!.raiseAlert(ready)
    store!.raiseAlert(waiting)
    const answer = await call('GET', '/api/notices')
    expect(answer.status).toBe(200)
    expect(answer.body.enabled).toBe(true)
    expect(answer.body.notices.map((notice: any) => [notice.kind, notice.target, notice.silenceable])).toEqual([
      ['chat_waiting', { chat: 's1' }, false],
      ['pr_ready', { pullRequest: 'https://github.com/acme/api/pull/1' }, true],
    ])
  })

  it('puts a notice away and answers with what is left', async () => {
    const chat = store!.raiseAlert(waiting)!
    store!.raiseAlert(ready)
    const dismissed = await call('POST', `/api/notices/${encodeURIComponent(chat.id)}/dismiss`)
    expect(dismissed.status).toBe(200)
    expect(dismissed.body.notices.map((notice: any) => notice.kind)).toEqual(['pr_ready'])
    // Every page reads the same: it stays away.
    expect((await call('GET', '/api/notices')).body.notices.map((notice: any) => notice.kind)).toEqual(['pr_ready'])
  })

  it('silences a pull request ready to merge, and refuses to silence anything else', async () => {
    const chat = store!.raiseAlert(waiting)!
    const pr = store!.raiseAlert(ready)!
    const refused = await call('POST', `/api/notices/${encodeURIComponent(chat.id)}/silence`)
    expect(refused.status).toBe(400)
    expect(refused.body.error).toMatch(/Only a pull request ready to merge can be silenced/)
    const silenced = await call('POST', `/api/notices/${encodeURIComponent(pr.id)}/silence`)
    expect(silenced.status).toBe(200)
    expect(silenced.body.notices.map((notice: any) => notice.kind)).toEqual(['chat_waiting'])
  })

  it('answers 404 for a notice it did not issue or that has cleared, and 400 for an unreadable id', async () => {
    const chat = store!.raiseAlert(waiting)!
    store!.resolveAlert(waiting.dedupeKey)
    for (const id of [chat.id, '000000000000-1', 'nope']) {
      const answer = await call('POST', `/api/notices/${encodeURIComponent(id)}/dismiss`)
      expect(answer.status, id).toBe(404)
      expect(answer.body.error, id).toMatch(/notification/)
    }
    expect((await call('POST', '/api/notices/%E0%A4%A/dismiss')).status).toBe(400)
  })

  it('turns notifications off and on from Settings', async () => {
    store!.raiseAlert(waiting)
    expect((await call('GET', '/api/settings')).body.notifications).toEqual({ enabled: true })

    const off = await call('POST', '/api/settings', { notifications: { enabled: false } })
    expect(off.status).toBe(200)
    expect(off.body.notifications).toEqual({ enabled: false })
    expect((await call('GET', '/api/notices')).body).toEqual({ enabled: false, notices: [] })

    const refused = await call('POST', '/api/settings', { notifications: { enabled: 'yes' } })
    expect(refused.status).toBe(400)
    expect((await call('GET', '/api/settings')).body.notifications).toEqual({ enabled: false })

    expect((await call('POST', '/api/settings', { notifications: { enabled: true } })).status).toBe(200)
    expect((await call('GET', '/api/notices')).body.notices.map((notice: any) => notice.kind)).toEqual(['chat_waiting'])
    // Turned on, the check ran at once; with no GitHub account set it asked GitHub nothing.
    expect(mocks.runFile.mock.calls.filter(([command]) => command === 'github-datastore' || command === 'github-interface')).toEqual([])
  })
})
