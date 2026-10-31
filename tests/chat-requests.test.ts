import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CATALOG } from './model-catalog-fixture'
import type { Adapter, AdapterHost, TurnResult } from '../server/chat/adapters/types'
import type { Capabilities } from '../server/chat/protocol'
import type { OpenChatRequest } from '../server/chat/storage'
import type { ChatRuntime } from '../server/chat/runtime'

// Open chat requests through the real Chat runtime, HTTP and SQLite, with a
// scripted adapter: one revisioned snapshot, joined by seq, and a frame on
// every change.
vi.mock('../server/claude-auth', () => ({ claudeAuth: { snapshot: () => ({ status: 'authenticated' }), requireReady: async () => {} } }))
vi.setConfig({ testTimeout: 90_000, hookTimeout: 25_000 })

const caps: Capabilities = { steer: true, fork: false, thought: false, plan: false, commands: false, modes: false, permissions: true, questions: true, resume: true, images: false }
const GROK_MODEL = 'grok-4.6-high'
let root = ''
let runtime: ChatRuntime
let server: Server
let origin = ''
let instance = ''
let database: typeof import('../server/db')
let storage: typeof import('../server/chat/storage')
let transport: typeof import('../server/chat/transport')
let http: typeof import('../server/http')
let Runtime: typeof ChatRuntime
const hosts = new Map<string, AdapterHost>()
const finishes = new Map<string, (result: TurnResult) => void>()
const prompted = new Set<string>()
const revisions: number[] = []

function adapter(host: AdapterHost): Adapter {
  hosts.set(host.sessionId, host)
  return {
    agent: 'grok', nativeSessionId: randomUUID(), capabilities: caps, alive: true,
    async start(options) { return { nativeSessionId: randomUUID(), capabilities: caps, modelId: options.modelId, effort: options.effort } },
    async prompt() {
      prompted.add(host.sessionId)
      return new Promise<TurnResult>((resolve) => { finishes.set(host.sessionId, resolve) })
    },
    async cancel() { finishes.get(host.sessionId)?.({ stopReason: 'cancelled' }); finishes.delete(host.sessionId) },
    async close() { finishes.get(host.sessionId)?.({ stopReason: 'cancelled' }); finishes.delete(host.sessionId) },
    async steer() {},
    async setMode() {},
    async setModel(modelId, effort) { return { modelId, effort } },
    async fork() { return randomUUID() },
    onExit() {},
  }
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) { if (check()) return; await new Promise((r) => setTimeout(r, 20)) }
  throw new Error('fixture state deadline')
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-chat-requests-'))
  vi.stubEnv('POISE_DB', join(root, 'chat.sqlite3'))
  vi.stubEnv('POISE_LOCK_DIR', join(root, 'locks'))
  ;({ ChatRuntime: Runtime } = await import('../server/chat/runtime'))
  storage = await import('../server/chat/storage')
  database = await import('../server/db')
  transport = await import('../server/chat/transport')
  http = await import('../server/http')
})

beforeEach(async () => {
  hosts.clear(); finishes.clear(); prompted.clear(); revisions.length = 0
  instance = `requests:${randomUUID()}`
  runtime = new Runtime({ instance, instanceLabel: 'test', callerTurns: null, catalog: async () => CATALOG,
    adapters: { grok: adapter }, probeAgent: async () => ({ ok: true }),
    localWorkspaceRoot: join(root, randomUUID()), idleTimeoutMinutes: () => 0 })
  runtime.on('chatRequests', (revision: number) => revisions.push(revision))
  await runtime.recover()
  server = createServer((req, res) => {
    if (!req.url?.startsWith('/api/chat/')) { res.statusCode = 404; res.end('{}'); return }
    try {
      const authority = http.enforceApiRequest(req, {})
      void transport.handleChatApi(req, res, req.url, runtime, undefined, transport.speaksForPerson(req, false, authority))
    } catch (error) {
      res.statusCode = http.httpStatus(error, 403); res.end(JSON.stringify({ error: String(error) }))
    }
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture needs TCP')
  origin = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  for (const [, finish] of finishes) finish({ stopReason: 'cancelled' })
  finishes.clear()
  await runtime?.stop()
  await new Promise<void>((done) => server.close(() => done()))
})

afterAll(async () => { database.closeDatabase(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

async function session(title = 'Chat'): Promise<string> {
  // Safe mode: permission requests wait for an answer instead of passing
  // an allow_once option straight through.
  const record = await runtime.create({ agent: 'grok', model: GROK_MODEL, title, safeMode: true })
  await until(() => runtime.get(record.id)?.status === 'idle')
  return record.id
}

async function askPermission(id: string, title: string, deny = false): Promise<{ requestId: string, answer: Promise<unknown> }> {
  const host = hosts.get(id)!
  const known = new Set(runtime.get(id)?.pendingRequests ?? [])
  const options = deny
    ? [{ id: 'no', name: 'Deny', kind: 'reject_once' as const }]
    : [{ id: 'yes', name: 'Allow', kind: 'allow_once' as const }]
  const answer = host.requestPermission({ title, options })
  // The request outlives the await: returning both lets the test answer it.
  answer.catch(() => {})
  await until(() => (runtime.get(id)?.pendingRequests ?? []).some((request) => !known.has(request)))
  const requestId = runtime.get(id)!.pendingRequests.find((request) => !known.has(request))!
  return { requestId, answer }
}

async function askQuestion(id: string): Promise<{ requestId: string, answer: Promise<unknown> }> {
  const host = hosts.get(id)!
  const known = new Set(runtime.get(id)?.pendingRequests ?? [])
  const answer = host.askQuestion({ questions: [{ id: 'q', question: 'Which target?', options: [], freeText: true, multiSelect: false }] })
  answer.catch(() => {})
  await until(() => (runtime.get(id)?.pendingRequests ?? []).some((request) => !known.has(request)))
  const requestId = runtime.get(id)!.pendingRequests.find((request) => !known.has(request))!
  return { requestId, answer }
}

async function prompt(id: string, text = 'Do the thing') {
  prompted.delete(id)
  runtime.prompt(id, { text, attachments: [], mentions: [] })
  await until(() => prompted.has(id))
}

async function read(): Promise<{ revision: number, complete: boolean, requests: OpenChatRequest[] }> {
  const response = await fetch(`${origin}/api/chat/requests`)
  expect(response.status).toBe(200)
  return await response.json() as { revision: number, complete: boolean, requests: OpenChatRequest[] }
}

describe('open chat requests', () => {
  it('lists every open request with its content, newest first', async () => {
    const id = await session('First')
    await prompt(id)
    const permission = await askPermission(id, 'Run the tests')
    const question = await askQuestion(id)

    const state = await read()
    expect(state.complete).toBe(true)
    expect(state.revision).toBe(2)
    expect(state.requests.map((entry) => entry.id)).toEqual([question.requestId, permission.requestId])
    expect(state.requests[0]).toMatchObject({
      kind: 'question', sessionId: id, sessionTitle: 'Do the thing',
      content: { questions: [{ id: 'q', question: 'Which target?' }] }, escalation: null,
    })
    expect(state.requests[1]).toMatchObject({
      kind: 'permission', sessionId: id, sessionTitle: 'Do the thing', escalation: null,
      content: { title: 'Run the tests', options: [{ id: 'yes', name: 'Allow', kind: 'allow_once' }] },
    })
    expect(Date.parse(state.requests[0].createdAt)).toBeGreaterThanOrEqual(Date.parse(state.requests[1].createdAt))
  })

  it('frames each change with the revision the read carries, so an in-flight read is discarded', async () => {
    const id = await session()
    await prompt(id)
    const { requestId } = await askPermission(id, 'Run the tests')
    expect(revisions).toEqual([1])

    const before = await read()
    expect(before.revision).toBe(1)
    expect(before.requests.map((entry) => entry.id)).toEqual([requestId])

    // An answer arriving while a read is in flight: the frame carries the
    // new revision, and the older response is discarded for a fresh read.
    runtime.respondPermission(id, requestId, 'yes')
    expect(revisions).toEqual([1, 2])
    expect(before.revision).toBeLessThan(revisions.at(-1)!)
    const after = await read()
    expect(after.revision).toBe(2)
    expect(after.requests).toEqual([])
  })

  it('frames cancel, reset and delete', async () => {
    const id = await session()
    await prompt(id)
    await askPermission(id, 'Run the tests')
    expect(revisions).toEqual([1])

    await runtime.cancel(id)
    await until(() => revisions.length >= 2)
    expect(await read()).toMatchObject({ revision: 2, requests: [] })

    await prompt(id, 'More work')
    await askQuestion(id)
    expect(revisions.at(-1)).toBe(3)
    await runtime.reset(id)
    expect(revisions.at(-1)).toBe(4)
    expect(await read()).toMatchObject({ revision: 4, requests: [] })

    await prompt(id, 'Last work')
    await askQuestion(id)
    expect(revisions.at(-1)).toBe(5)
    await runtime.delete(id)
    expect(revisions.at(-1)).toBe(6)
    expect(await read()).toMatchObject({ revision: 6, requests: [] })
  })

  it('finds a request past 5,000 earlier events without scanning the transcript', async () => {
    const id = await session()
    for (let n = 0; n < 5_001; n++) {
      storage.appendEvent(id, { type: 'text.delta', turnId: 't', messageId: 'm', delta: 'filler' })
    }
    const before = revisions.length
    await prompt(id)
    const { requestId } = await askQuestion(id)
    const state = await read()
    expect(state.requests.map((entry) => entry.id)).toEqual([requestId])
    expect(state.requests[0].content).toMatchObject({ questions: [{ id: 'q' }] })
    expect(revisions.length).toBe(before + 1)
  })

  it("keeps another instance's rows out", async () => {
    const id = await session()
    await prompt(id)
    const { requestId } = await askPermission(id, 'Run the tests')
    const foreign = randomUUID()
    const at = new Date().toISOString()
    database.db.prepare(`
      INSERT INTO chat_sessions (id, record, agent, repo, checkout, branch, status, title, instance, created_at, updated_at, last_seq)
      VALUES (?, '{}', 'grok', '', '', '', 'idle', 'Foreign', 'elsewhere', ?, ?, 1)
    `).run(foreign, at, at)
    database.db.prepare('INSERT INTO chat_events (session_id, seq, at, event) VALUES (?, ?, ?, ?)').run(foreign, 1, at,
      JSON.stringify({ type: 'permission.requested', id: 'foreign-request', turnId: 't', title: 'Foreign', options: [] }))
    database.db.prepare('INSERT INTO chat_pending (request_id, session_id, kind, seq, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('foreign-request', foreign, 'permission', 1, at)

    const state = await read()
    expect(state.requests.map((entry) => entry.id)).toEqual([requestId])
  })

  it('recovers pending requests across a restart and keeps the revision growing', async () => {
    const id = await session()
    await prompt(id)
    const { requestId } = await askQuestion(id)
    const asked = await read()
    expect(asked.requests.map((entry) => entry.id)).toEqual([requestId])

    // A crash, not a graceful stop: the old runtime is abandoned with
    // its turn open, and the new one interrupts the dead turn's request,
    // framing the recovery.
    finishes.clear()
    const survivor = new Runtime({ instance, instanceLabel: 'test', callerTurns: null, catalog: async () => CATALOG,
      adapters: { grok: adapter }, probeAgent: async () => ({ ok: true }),
      localWorkspaceRoot: join(root, randomUUID()), idleTimeoutMinutes: () => 0 })
    const recovered: number[] = []
    survivor.on('chatRequests', (revision: number) => recovered.push(revision))
    await survivor.recover()
    runtime = survivor
    expect(recovered.length).toBeGreaterThanOrEqual(1)
    const state = await read()
    expect(state.revision).toBeGreaterThan(asked.revision)
    expect(state.requests).toEqual([])
  })

  it('records answers, denials and cancels in the handling log', async () => {
    const id = await session()
    await prompt(id)
    const first = await askQuestion(id)
    await askPermission(id, 'Run the tests')
    runtime.answerQuestion(id, first.requestId, { q: 'the api' })
    await runtime.cancel(id, { kind: 'person' })
    await prompt(id, 'More work')
    const third = await askPermission(id, 'Delete everything', true)
    runtime.respondPermission(id, third.requestId, 'no')

    const { listHandling } = await import('../server/alerts/handling')
    const rows = listHandling().filter((row) => row.source === `chat/${id}`)
    expect(rows.map((row) => row.outcome)).toEqual(['denied', 'cancelled', 'answered'])
    expect(rows[2]).toMatchObject({ kind: 'notice', title: 'Which target?', actor: 'person' })
    expect(rows[1]).toMatchObject({ title: 'Run the tests', actor: 'person' })
    expect(rows[0]).toMatchObject({ title: 'Delete everything', actor: 'person' })
    for (const row of rows) {
      expect(Date.parse(row.finishedAt)).toBeGreaterThanOrEqual(Date.parse(row.startedAt))
    }
  })

  it('caps the read at 200 entries, newest first', async () => {
    const id = await session('Capped')
    for (let n = 0; n < 210; n++) {
      storage.appendEvent(id, { type: 'question.asked', id: `q-${n}`, turnId: 't',
        questions: [{ id: 'q', question: 'Which?', options: [], freeText: true, multiSelect: false }] })
    }
    const state = await read()
    expect(state.complete).toBe(false)
    expect(state.requests).toHaveLength(200)
    const created = state.requests.map((entry) => Date.parse(entry.createdAt))
    expect([...created].sort((a, b) => b - a)).toEqual(created)
  })
})
