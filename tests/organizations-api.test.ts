import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Organization } from '../server/organizations'
import type { RunFileOptions } from '../server/process'
import { createAuthenticatedClaudeAuth } from './claude-auth-fixture'
import { CATALOG_STDOUT } from './model-catalog-fixture'

const mocks = vi.hoisted(() => ({ runFile: vi.fn() }))
vi.mock('../server/process', async (original) => ({
  ...(await original<typeof import('../server/process')>()),
  runFile: mocks.runFile,
  spawnDetached: vi.fn(async () => { throw new Error('unexpected agent launch') }),
}))
vi.mock('../server/behaviors', async (original) => ({
  ...(await original<typeof import('../server/behaviors')>()),
  startBehaviorsRuntime: vi.fn(),
  stopBehaviorsRuntime: vi.fn(async () => undefined),
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
let cache: typeof import('../server/cache-plugin') | undefined
let pendingIndex: Promise<void> | undefined
let releaseIndex: (() => void) | undefined
let failIndex = false
const envKeys = ['POISE_DB', 'POISE_EDITOR_DIR', 'POISE_CHAT_ATTACHMENTS_DIR', 'POISE_LOCK_DIR', 'AGENT_INTERFACE_ROOT', 'POISE_ESPANSO_MATCH_DIR', 'POISE_DATASTORE_DB']
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]))

function writeIndex(path: string, login: string) {
  const fixture = new Database(path)
  try {
    fixture.exec('CREATE TABLE sync_state(scope TEXT, key TEXT, value TEXT)')
    const insert = fixture.prepare('INSERT INTO sync_state VALUES (?, ?, ?)')
    insert.run('org', 'login', login)
    insert.run('org', 'last_full_build_at', new Date().toISOString())
  } finally { fixture.close() }
}

async function cli(command: string, args: string[], options: RunFileOptions) {
  if (command === 'agent-interface' && args[0] === '--models') return { stdout: CATALOG_STDOUT, stderr: '' }
  if (command === 'gh') return { stdout: 'test-secret-token', stderr: '' }
  if (command !== 'github-datastore') throw new Error(`Unexpected test command: ${command}`)
  if (args[2] === 'init-org') {
    if (pendingIndex) await Promise.race([
      pendingIndex,
      new Promise<void>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
    ])
    if (failIndex) throw new Error('organization access denied')
    writeIndex(args[1]!, args[3]!)
  }
  return {
    stdout: args[2] === 'health'
      ? JSON.stringify({ action: 'health', healthy: true, status: 'healthy', database: args[1] })
      : '',
    stderr: '',
  }
}

async function request(path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as { organizations: Organization[], error?: string, org?: string, me?: string } }
}

async function orgStatus(login: string, status: Organization['status']) {
  await vi.waitFor(async () => {
    const result = await request('/api/organizations')
    expect(result.body.organizations.find((org) => org.login.toLowerCase() === login.toLowerCase())?.status).toBe(status)
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-organizations-api-'))
  process.env.POISE_DB = join(root, 'cache.db')
  process.env.POISE_EDITOR_DIR = join(root, 'editor')
  process.env.POISE_CHAT_ATTACHMENTS_DIR = join(root, 'chat')
  process.env.POISE_LOCK_DIR = join(root, 'locks')
  process.env.AGENT_INTERFACE_ROOT = join(root, 'agent-interface')
  process.env.POISE_ESPANSO_MATCH_DIR = join(root, 'espanso')
  delete process.env.POISE_DATASTORE_DB
  pendingIndex = undefined
  releaseIndex = undefined
  failIndex = false
  mocks.runFile.mockReset().mockImplementation(cli)
  vi.resetModules()
  database = await import('../server/db')
  database.setMeta('org', 'Legacy')
  database.setMeta('me', 'octocat')
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

describe('organizations API', () => {
  it('returns the existing organization unchanged through registry and Settings', async () => {
    const registry = await request('/api/organizations')
    expect(registry.status).toBe(200)
    expect(registry.body.organizations).toEqual([{
      login: 'Legacy', managed: false, status: 'ready', stage: 'ready', error: null, activatedAt: null,
    }])
    const settings = await request('/api/settings')
    expect(settings.body).toMatchObject({ org: 'Legacy', me: 'octocat', organizations: registry.body.organizations })
    expect(mocks.runFile.mock.calls.filter(([command]) => command === 'github-datastore')).toEqual([])
  })

  it('returns accepted before indexing ends, then publishes ready status without touching legacy', async () => {
    pendingIndex = new Promise<void>((resolve) => { releaseIndex = resolve })
    database!.recordSeen('review-new-prs', 'Legacy/repo#1')
    const added = await request('/api/organizations', { org: ' Acme ', datastorePath: '/ignored.sqlite' })
    expect(added.status).toBe(202)
    expect(added.body.organizations).toMatchObject([
      { login: 'Legacy', status: 'ready', managed: false },
      { login: 'acme', status: 'initializing', managed: true, datastorePath: join(root, 'datastores/acme/github.sqlite') },
    ])
    const duplicate = await request('/api/organizations', { org: 'ACME' })
    expect(duplicate.status).toBe(202)
    expect(duplicate.body.organizations).toHaveLength(2)
    const progress = await request('/api/organizations')
    expect(progress.body.organizations[1]!.status).toBe('initializing')
    releaseIndex!()
    pendingIndex = undefined
    await orgStatus('acme', 'ready')
    expect(mocks.runFile.mock.calls.filter(([command, args]) => command === 'github-datastore' && args[2] === 'init-org')).toHaveLength(1)
    expect(database!.getMeta('org')).toBe('Legacy')
    expect(database!.hasSeen('review-new-prs', 'Legacy/repo#1')).toBe(true)
  })

  it.each([{}, null, [], { org: 12 }, { org: '../escape' }, { org: 'https://github.com/acme' }])('rejects malformed organization input %j without starting work', async (body) => {
    const result = await request('/api/organizations', body)
    expect(result.status).toBe(400)
    expect(result.body.error).toContain('GitHub organization name')
    expect((await request('/api/organizations')).body.organizations).toHaveLength(1)
    expect(mocks.runFile.mock.calls.filter(([command]) => command === 'github-datastore')).toEqual([])
  })

  it('persists an activation error and recovers through its explicit retry endpoint', async () => {
    failIndex = true
    expect((await request('/api/organizations', { org: 'acme' })).status).toBe(202)
    await orgStatus('acme', 'error')
    const failed = (await request('/api/organizations')).body.organizations[1]!
    expect(failed.error).toContain('organization access denied')
    failIndex = false
    expect((await request('/api/organizations/ACME/retry', {})).status).toBe(202)
    await orgStatus('acme', 'ready')
    expect((await request('/api/organizations')).body.organizations[1]!.error).toBeNull()
    expect((await request('/api/organizations/missing/retry', {})).status).toBe(400)
  })

  it('rejects a settings update that would bypass organization activation before saving any fields', async () => {
    const result = await request('/api/settings', { org: 'uninitialized', me: 'different-user' })
    expect(result.status).toBe(400)
    expect(result.body.error).toContain('account setup')
    expect(database!.getMeta('org')).toBe('Legacy')
    expect(database!.getMeta('me')).toBe('octocat')
    expect((await request('/api/organizations')).body.organizations).toHaveLength(1)
    const valid = await request('/api/settings', { org: 'Legacy', timezone: 'UTC' })
    expect(valid.status).toBe(200)
    expect(valid.body.organizations[0]!.login).toBe('Legacy')
  })
})
