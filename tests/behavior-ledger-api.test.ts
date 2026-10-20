import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { LedgerReply } from '../server/behavior-ledger-contract'
import type { LogEntry } from '../server/agent'
import { parseBehaviorLedgerArguments } from '../server/behavior-ledger-cli'
import { createAuthenticatedClaudeAuth } from './claude-auth-fixture'
import { PUBLIC_HOST, PUBLIC_ORIGIN, gatewayKeys, serviceEnvironment, signAssertion } from './service-fixture'

const mocks = vi.hoisted(() => ({ runFile: vi.fn(), spawnDetached: vi.fn() }))
vi.mock('../server/process', async (original) => ({
  ...(await original<typeof import('../server/process')>()), runFile: mocks.runFile, spawnDetached: mocks.spawnDetached,
}))
vi.mock('../server/content-jobs', async (original) => ({
  ...(await original<typeof import('../server/content-jobs')>()), startContentFinalizer: vi.fn(), stopContentFinalizer: vi.fn(async () => undefined),
}))
vi.mock('../server/chat/runtime', async (original) => {
  const { EventEmitter } = await import('node:events')
  return { ...(await original<typeof import('../server/chat/runtime')>()), ChatRuntime: class extends EventEmitter {
    draining = null
    async recover() {}
    async stop() {}
    endDrain() {}
  } }
})
vi.mock('../server/jev/api', () => ({ handleJevApi: vi.fn(async () => false), stopJev: vi.fn(async () => undefined) }))

const keys = gatewayKeys()
const PREFIX = '/api/behavior-ledger'
let root = ''
let bundles = ''
let base = ''
let server: Server
let ledger: typeof import('../server/behavior-ledger')
let cache: typeof import('../server/cache-plugin')
let database: typeof import('../server/db')

async function listen(http: Server): Promise<string> {
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind')
  return `http://127.0.0.1:${address.port}`
}

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(bundles, 'behavior-ledger.js'), ...args], { encoding: 'utf8', timeout: 8000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? typeof error.code === 'number' ? error.code : -1 : 0, stdout, stderr })
    })
  })
}

interface Caller { identity?: string; peer?: boolean; host?: string; origin?: string; site?: string }
function call(path: string, method = 'GET', caller: Caller = {}): Promise<{ status: number; body: LedgerReply; allow?: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(base + path, { method, agent: false, headers: {
      host: caller.host ?? (caller.peer ? PUBLIC_HOST : new URL(base).host),
      ...(caller.peer ? { 'x-test-peer': '172.18.0.2' } : {}),
      ...(caller.identity ? { 'x-poise-identity': caller.identity } : {}),
      ...(caller.origin ? { origin: caller.origin } : {}),
      ...(caller.site ? { 'sec-fetch-site': caller.site } : {}),
    } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as LedgerReply, allow: res.headers.allow }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function flushCaptures(): Promise<void> {
  await vi.waitFor(async () => {
    expect((await ledger.readBehaviorLedger({ operation: 'health' })).body.health.pending).toBe(0)
  })
}

async function firing(): Promise<void> {
  const nativeId = randomUUID()
  ledger.captureBehaviorAdmission({ admissionKey: nativeId, nativeId, behavior: 'merge-prs', source: 'poise:merge-prs',
    owner: 'octocat', actor: 'octobot', repository: 'example/project', number: 7, head: 'a'.repeat(40) })
  ledger.captureBehaviorOutcome({ nativeId, state: 'completed', activity: 'settled', stateSource: 'native', outcome: 'not_ready', completedAt: new Date().toISOString() })
  await flushCaptures()
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-ledger-api-'))
  bundles = await mkdtemp(join(process.cwd(), 'node_modules', '.poise-ledger-api-'))
  await Promise.all([
    build({ entryPoints: ['server/behavior-ledger-cli.ts'], outfile: join(bundles, 'behavior-ledger.js'), bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' }),
    build({ entryPoints: ['server/behavior-ledger-worker.ts'], outfile: join(bundles, 'behavior-ledger-worker.js'), bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' }),
  ])
  for (const name of ['POISE_DB', 'POISE_EDITOR_DIR', 'POISE_CHAT_ATTACHMENTS_DIR', 'POISE_LOCK_DIR', 'AGENT_INTERFACE_ROOT', 'POISE_ESPANSO_MATCH_DIR']) {
    vi.stubEnv(name, join(root, name))
  }
  mocks.runFile.mockImplementation(async (command: string, args: string[]) => {
    if (command === 'agent-interface' && args[0] === '--diagnostics') return { stdout: JSON.stringify({ version: 1, streamId: 'f'.repeat(32), events: [], cursor: Number(args[1]), hasMore: false, backfillPending: false }) }
    throw new Error(`Unexpected test command: ${command} ${args.join(' ')}`)
  })
  mocks.spawnDetached.mockResolvedValue(undefined)
  vi.resetModules()
  ledger = await import('../server/behavior-ledger')
  await ledger.startBehaviorLedger({ path: join(root, 'behavior-ledger.db'), workerPath: join(bundles, 'behavior-ledger-worker.js') })
  database = await import('../server/db')
  const behaviors = await import('../server/behaviors')
  vi.spyOn(behaviors, 'startBehaviorsRuntime').mockImplementation(() => undefined)
  vi.spyOn(behaviors, 'stopBehaviorsRuntime').mockResolvedValue(undefined)
  const { readServiceConfig } = await import('../server/service/config')
  cache = await import('../server/cache-plugin')
  const middleware = cache.createPoiseMiddleware({ claudeAuth: createAuthenticatedClaudeAuth(), selfUpdateBridge: null,
    service: readServiceConfig(serviceEnvironment(keys)) })
  server = createServer((req, res) => { void middleware(req, res, () => { res.statusCode = 404; res.end('{}') }) })
  server.prependListener('request', (req: IncomingMessage) => {
    if (req.headers['x-test-peer']) Object.defineProperty(req.socket, 'remoteAddress', { value: req.headers['x-test-peer'], configurable: true })
  })
  base = await listen(server)
  await firing()
})

afterAll(async () => {
  await cache?.stopPoiseRuntime()
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  if (database?.db.open) database.closeDatabase()
  vi.unstubAllEnvs()
  vi.resetModules()
  await Promise.all([root, bundles].filter(Boolean).map((path) => rm(path, { recursive: true, force: true })))
})

it('reads real worker records through guarded HTTP, child pagination and the built CLI', async () => {
  const first = await call(`${PREFIX}?limit=1`)
  expect(first.status).toBe(200)
  expect(first.body.records).toHaveLength(1)
  const record = first.body.records![0]
  expect(record).toMatchObject({ kind: 'firing', behavior: 'merge-prs', state: 'completed', outcome: 'not_ready' })
  expect(first.body.nextCursor).toEqual(expect.any(String))
  const children = await call(`${PREFIX}?parent=${record.id}`)
  expect(children.body.records).toHaveLength(1)
  expect(children.body.records![0]).toMatchObject({ kind: 'attempt', parentId: record.id })
  const one = await cli(['get', record.id, '--base-url', base])
  expect(one.code, one.stderr).toBe(0)
  expect(JSON.parse(one.stdout)).toMatchObject({ version: 1, record: { id: record.id } })
  const listing = await cli(['list', '--limit', '1', '--base-url', base])
  expect(listing.code, listing.stderr).toBe(0)
  expect(JSON.parse(listing.stdout)).toMatchObject({ version: 1, watermark: expect.any(String), records: [{ id: record.id }] })
  expect((await cli(['health', '--base-url', base])).code).toBe(0)
})

it('freezes listing boundaries and resumes changes across interleaved creation', async () => {
  const first = (await call(`${PREFIX}?limit=1`)).body
  await firing()
  const continuation = await call(`${PREFIX}?cursor=${encodeURIComponent(first.nextCursor!)}&limit=100`)
  expect(continuation.body.watermark).toBe(first.watermark)
  expect(continuation.body.records).toHaveLength(1)
  const changes = await cli(['changes', first.watermark!, '--base-url', base])
  expect(changes.code, changes.stderr).toBe(0)
  const body = JSON.parse(changes.stdout) as LedgerReply
  expect(body.changes?.some((change) => change.op === 'upsert' && change.record.kind === 'firing')).toBe(true)
  expect(body.nextCursor).toEqual(expect.any(String))
  expect((await call(`${PREFIX}/changes?cursor=${encodeURIComponent(body.nextCursor!)}`)).body.changes).toEqual([])
  expect(mocks.spawnDetached).not.toHaveBeenCalled()
  expect(mocks.runFile.mock.calls.some(([, args]) => Array.isArray(args) && args[0] === '--logs')).toBe(false)
})

it('rejects mutation methods and ambiguous or unsupported selectors', async () => {
  const denied = await call(PREFIX, 'POST')
  expect(denied.status).toBe(405)
  expect(denied.allow).toBe('GET')
  for (const path of ['?limit=0', '?limit=101', '?limit=1.5', '?limit=1&limit=2', '?org=other', '?parent=wrong', '/changes', '/changes?cursor=', '/health?limit=1', '/wrong', '?cursor=bad']) {
    expect((await call(PREFIX + path)).status, path).toBe(400)
  }
  expect((await call(`${PREFIX}/${'f'.repeat(64)}`)).status).toBe(404)
})

it('keeps the existing owner, assertion, Host, Origin and cross-site boundary', async () => {
  const identity = signAssertion(keys.privateKey)
  expect((await call(PREFIX, 'GET', { peer: true, identity, origin: PUBLIC_ORIGIN })).status).toBe(200)
  const now = Math.floor(Date.now() / 1000)
  const refused: Caller[] = [
    { peer: true },
    { peer: true, identity: signAssertion(gatewayKeys().privateKey) },
    { peer: true, identity: signAssertion(keys.privateKey, { iat: now - 120, exp: now - 60 }) },
    { peer: true, identity: signAssertion(keys.privateKey, { aud: 'workspace:other' }) },
    { peer: true, identity: signAssertion(keys.privateKey, { sub: 'other' }) },
    { peer: true, identity, host: 'other.poise.example.test' },
    { peer: true, identity, origin: 'https://other.example' },
    { peer: true, identity, site: 'cross-site' },
  ]
  for (const caller of refused) expect([401, 403]).toContain((await call(PREFIX, 'GET', caller)).status)
  for (const scope of ['link', 'admin']) {
    for (const suffix of ['', '/changes?cursor=x', '/health', '/' + 'f'.repeat(64)]) {
      expect((await call(PREFIX + suffix, 'GET', { peer: true, identity: signAssertion(keys.privateKey, { scope }) })).status).toBe(403)
    }
  }
})

it('confines CLI arguments to fixed loopback reads', () => {
  for (const value of ['https://127.0.0.1', 'http://localhost', 'http://example.com', 'file:///tmp/private', 'http://user:secret@127.0.0.1', 'http://127.0.0.1/private', 'http://127.0.0.1?private', 'http://127.0.0.1#private', 'http://127.0.0.1?']) {
    expect(() => parseBehaviorLedgerArguments(['health', '--base-url', value]), value).toThrow()
  }
  for (const args of [['stop'], ['get', '../private'], ['list', 'extra'], ['health', '--limit', '1'], ['list', '--limit', '101'], ['list', '--limit', '1', '--limit', '2'], ['changes'], ['list', '--url', base]]) {
    expect(() => parseBehaviorLedgerArguments(args)).toThrow()
  }
  expect(parseBehaviorLedgerArguments(['health', '--base-url', 'http://[::1]:5555']).href).toBe('http://[::1]:5555/api/behavior-ledger/health')
})

it('returns usage failure without making a request', async () => {
  expect((await cli(['list', '--base-url', 'https://example.com'])).code).toBe(2)
})

it('preserves incomplete JSON with nonzero status, bounds replies and refuses redirects', async () => {
  const health = (await call(`${PREFIX}/health`)).body.health
  let mode: 'incomplete' | 'oversized' | 'redirect' = 'incomplete'
  let redirected = false
  const stub = createServer((req, res) => {
    if (req.url !== `${PREFIX}/health`) redirected = true
    res.setHeader('Content-Type', 'application/json')
    if (mode === 'oversized') res.end('x'.repeat(512 * 1024 + 1))
    else if (mode === 'redirect') { res.statusCode = 302; res.setHeader('Location', '/private'); res.end() }
    else res.end(JSON.stringify({ version: 1, health: { ...health, status: 'stale' } }))
  })
  const stubBase = await listen(stub)
  try {
    const stale = await cli(['health', '--base-url', stubBase])
    expect(stale.code).toBe(1)
    expect(JSON.parse(stale.stdout)).toMatchObject({ health: { status: 'stale' } })
    mode = 'oversized'
    const oversized = await cli(['health', '--base-url', stubBase])
    expect(oversized.code).toBe(1)
    expect(oversized.stderr).toContain('512 KiB')
    mode = 'redirect'
    expect((await cli(['health', '--base-url', stubBase])).code).toBe(1)
    expect(redirected).toBe(false)
  } finally { await new Promise<void>((resolve) => stub.close(() => resolve())) }
})

it('requires the original correlation even after a Caller call ID is known', async () => {
  const nativeId = randomUUID()
  const callId = 'c'.repeat(32)
  const head = 'b'.repeat(40)
  const startedAt = new Date().toISOString()
  ledger.captureBehaviorAdmission({ admissionKey: nativeId, nativeId, behavior: 'review-new-prs', source: 'poise:review-new-prs',
    owner: 'octocat', actor: 'octobot', repository: 'example/project', number: 9, head, slot: 'primary', plannedSlots: ['primary'], startedAt })
  ledger.captureBehaviorOutcome({ nativeId, state: 'unknown', activity: 'unknown', callId, stateSource: 'native' })
  await flushCaptures()
  const listing = await ledger.readBehaviorLedger({ operation: 'list', limit: 100 })
  const record = listing.body.records!.find((row) => row.kind === 'firing' && row.behavior === 'review-new-prs' && row.target.number === 9)!
  const entry: LogEntry = { id: callId, pr_id: '9', repo: 'example/project', actor: 'octobot', model: 'fixture', behavior: 'pr_review',
    session_id: null, prompt: '', started_at: startedAt, started_at_precise: startedAt, completed_at: new Date().toISOString(),
    time_elapsed: '0', status: 'completed', outcome: 'clean', head_sha: head, expected_head: head, source: 'poise:review-new-prs',
    correlation_id: nativeId, action: 'reviewed_clean', response: null, error: '' }
  for (const correlation of ['foreign-correlation', null]) {
    ledger.observeAgentSnapshot({ entries: [{ ...entry, correlation_id: correlation }], quarantined: [] })
    await flushCaptures()
    expect((await call(`${PREFIX}/${record.id}`)).body.record).toMatchObject({ state: 'unknown', activity: 'unknown' })
  }
  ledger.observeAgentSnapshot({ entries: [entry], quarantined: [] })
  await flushCaptures()
  expect((await call(`${PREFIX}/${record.id}`)).body.record).toMatchObject({ state: 'completed', activity: 'settled', outcome: 'clean' })
})

it('keeps direct work out of Caller snapshots before the admission is acknowledged', async () => {
  const nativeId = randomUUID()
  ledger.captureBehaviorAdmission({ admissionKey: nativeId, nativeId, behavior: 'merge-prs', source: 'poise:merge-prs',
    owner: 'octocat', actor: 'octobot', repository: 'example/project', number: 11, head: 'd'.repeat(40), startedAt: new Date().toISOString() })
  ledger.observeAgentSnapshot({ entries: [], quarantined: [] })
  await flushCaptures()
  const records = (await call(`${PREFIX}?limit=100`)).body.records!
  const record = records.find((row) => row.kind === 'firing' && row.behavior === 'merge-prs' && row.target.number === 11)!
  expect(record).toMatchObject({ state: 'running', activity: 'running' })
  ledger.captureBehaviorOutcome({ nativeId, state: 'completed', activity: 'settled', stateSource: 'native', outcome: 'not_ready', completedAt: new Date().toISOString() })
  await flushCaptures()
  expect((await call(`${PREFIX}/${record.id}`)).body.record).toMatchObject({ state: 'completed', activity: 'settled' })
})
