// A subject's earlier legacy conversation is shown read-only, imported when
// the first message creates its session, and quoted to the first native
// turn only. Caller's log is faked at the process boundary; the runtime,
// git workspaces and scripted adapters are real.
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { CATALOG } from './model-catalog-fixture'
import type { Adapter, AdapterHost, TurnResult } from '../server/chat/adapters/types'
import type { Capabilities, ChatSubject, PromptInput, ServerFrame } from '../server/chat/protocol'
import type { ChatRuntime } from '../server/chat/runtime'
import type { ChatSocketServer } from '../server/chat/transport'

vi.mock('../server/claude-auth', () => ({ claudeAuth: { snapshot: () => ({ status: 'authenticated' }), requireReady: async () => {} } }))

const mocks = vi.hoisted(() => ({
  calls: [] as Array<{ file: string, args: string[] }>,
  logs: '[]',
  bodies: new Map<string, string>(),
  logsError: null as null | Error,
}))

// Only agent-interface is faked; git and every other subprocess run for real.
vi.mock('../server/process', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/process')>()
  return {
    ...original,
    runFile: vi.fn(async (file: string, args: readonly string[], options?: unknown) => {
      if (file !== 'agent-interface') return (original.runFile as any)(file, args, options)
      mocks.calls.push({ file, args: [...args] })
      if (args[0] === '--logs') {
        if (mocks.logsError) throw mocks.logsError
        return { stdout: mocks.logs, stderr: '' }
      }
      if (args[0] === '--read-response') {
        const body = mocks.bodies.get(args[1])
        if (body === undefined) throw new Error(`no mocked response for ${args[1]}`)
        return { stdout: body, stderr: '' }
      }
      throw new Error(`unexpected agent-interface argv ${args.join(' ')}`)
    }),
  }
})

const caps: Capabilities = { steer: true, fork: true, thought: false, plan: false, commands: false, modes: false, permissions: true, questions: true, resume: true, images: false }
const prompts = new Map<string, PromptInput[]>()
const finishes = new Map<string, (result: TurnResult) => void>()

function adapter(host: AdapterHost): Adapter {
  let alive = false
  const nativeSessionId = randomUUID()
  const finish = () => { finishes.get(host.sessionId)?.({ stopReason: 'cancelled' }); finishes.delete(host.sessionId) }
  return {
    agent: 'grok', nativeSessionId, capabilities: caps, get alive() { return alive },
    async start(options) { alive = true; return { nativeSessionId, capabilities: caps, modelId: options.modelId, effort: options.effort } },
    async prompt(_turn, input) {
      prompts.set(host.sessionId, [...(prompts.get(host.sessionId) ?? []), input])
      return new Promise<TurnResult>(done => finishes.set(host.sessionId, done))
    },
    async cancel() { finish() }, async close() { alive = false; finish() },
    async steer() {}, async setMode() {}, async setModel(modelId, effort) { return { modelId, effort } },
    async fork() { return randomUUID() }, onExit() {},
  }
}

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) { if (check()) return; await new Promise(done => setTimeout(done, 15)) }
  throw new Error(`deadline waiting for ${what}`)
}

let root: string
let instance: string
let workspaceRoot: string
let runtime: ChatRuntime
let storage: typeof import('../server/chat/storage')
let database: typeof import('../server/db')
let Runtime: typeof ChatRuntime
let SocketServer: typeof ChatSocketServer
let handleChatApi: typeof import('../server/chat/transport').handleChatApi
let server: Server
let sockets: ChatSocketServer
let origin: string
const clients: WebSocket[] = []

const card = (key = 'poise.card.7'): ChatSubject => ({ surface: 'current', key, label: 'A card' })
const createBody = (subject: ChatSubject, extra: Record<string, unknown> = {}) => ({ agent: 'grok', model: 'grok-4.6-xhigh', subject, ...extra })

function logRow(id: string, sessionId: string, prompt: string, startedAt: string, extra: Record<string, unknown> = {}) {
  return { id, model: 'grok-4.6-xhigh', behavior: 'chat', session_id: sessionId, prompt, started_at: startedAt, time_elapsed: '1s', status: 'completed', response: 'abcd1234', ...extra }
}

function serveLog(rows: unknown[], bodies: Record<string, string>) {
  mocks.logs = JSON.stringify(rows)
  mocks.bodies = new Map(Object.entries(bodies))
  mocks.logsError = null
}

async function postSessions(body: unknown): Promise<{ status: number, json: any }> {
  const response = await fetch(`${origin}/api/chat/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, json: await response.json() }
}

async function connect(): Promise<WebSocket> {
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/ws/chat`, { origin })
  clients.push(socket)
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  return socket
}

function sendCommand(socket: WebSocket, id: string, command: Record<string, unknown>): Promise<Extract<ServerFrame, { kind: 'ack' }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', listener); reject(new Error('ack deadline')) }, 60_000)
    const listener = (raw: import('ws').RawData) => {
      const frame = JSON.parse(raw.toString()) as ServerFrame
      if (frame.kind === 'ack' && frame.id === id) { clearTimeout(timer); socket.off('message', listener); resolve(frame) }
    }
    socket.on('message', listener)
    socket.send(JSON.stringify({ id, command }))
  })
}

function importedEvents(sessionId: string) {
  return storage.listEvents(sessionId, 0).events.filter(({ event }) => event.type === 'history.imported')
}

function makeRuntime() {
  return new Runtime({ instance, instanceLabel: 'test', callerTurns: null, catalog: async () => CATALOG as any,
    adapters: { grok: adapter, claude: adapter, codex: adapter, muse: adapter }, requireClaudeReady: async () => {}, probeAgent: async () => ({ ok: true }),
    localWorkspaceRoot: workspaceRoot, idleTimeoutMinutes: () => 0 })
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-chat-legacy-import-test-'))
  vi.stubEnv('POISE_DB', join(root, 'chat.sqlite3'))
  vi.stubEnv('POISE_LOCK_DIR', join(root, 'locks'))
  ;({ ChatRuntime: Runtime } = await import('../server/chat/runtime'))
  ;({ ChatSocketServer: SocketServer, handleChatApi } = await import('../server/chat/transport'))
  storage = await import('../server/chat/storage')
  database = await import('../server/db')
})

beforeEach(async () => {
  prompts.clear(); finishes.clear()
  mocks.calls.length = 0
  mocks.logs = '[]'
  mocks.bodies = new Map()
  mocks.logsError = null
  ;(await import('../server/agent')).resetAgentLogCache()
  instance = `legacy:${randomUUID()}`
  workspaceRoot = join(root, randomUUID())
  runtime = makeRuntime()
  server = createServer((req, res) => {
    if (req.url?.startsWith('/api/chat/')) { void handleChatApi(req, res, req.url, runtime); return }
    res.statusCode = 404; res.end()
  })
  sockets = new SocketServer(runtime)
  sockets.attach(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture needs TCP')
  origin = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate()
  await sockets?.close()
  await runtime?.stop()
  await new Promise<void>(done => server.close(() => done()))
})

afterAll(async () => { database.closeDatabase(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

describe('legacy conversation import', () => {
  it('imports a card\'s earlier conversation when the first message creates its session', async () => {
    serveLog([
      logRow('a'.repeat(32), 'poise.card.7', 'first question', '2026-10-20T10:00:00.000Z'),
      logRow('b'.repeat(32), 'poise.card.7', 'second question', '2026-10-20T10:05:00.000Z'),
      logRow('c'.repeat(32), 'poise.card.9', 'another card', '2026-10-20T10:06:00.000Z'),
      logRow('d'.repeat(32), 'poise.issue.acme/app.7', 'issue question', '2026-10-20T10:07:00.000Z'),
    ], {
      ['a'.repeat(32)]: 'first answer',
      ['b'.repeat(32)]: 'second answer',
      ['c'.repeat(32)]: 'other answer',
      ['d'.repeat(32)]: 'issue answer',
    })
    const rest = await postSessions(createBody(card()))
    expect(rest.status).toBe(201)
    const restId = rest.json.session.id as string
    expect(rest.json.session.importedFrom).toBe('poise.card.7')
    const restImports = importedEvents(restId)
    expect(restImports).toHaveLength(1)
    expect(restImports[0].event).toMatchObject({
      type: 'history.imported', legacyId: 'poise.card.7', omitted: 0,
      turns: [
        { prompt: 'first question', reply: 'first answer', at: '2026-10-20T10:00:00.000Z', status: 'completed' },
        { prompt: 'second question', reply: 'second answer', at: '2026-10-20T10:05:00.000Z', status: 'completed' },
      ],
    })
    const socket = await connect()
    const ack = await sendCommand(socket, randomUUID(), { type: 'session.new', ...createBody({ surface: 'current', key: 'poise.issue.acme/app.7', label: 'Broken logout' }) })
    expect(ack.ok).toBe(true)
    const wsId = (ack as any).result.session.id as string
    expect((ack as any).result.session.importedFrom).toBe('poise.issue.acme/app.7')
    expect(importedEvents(wsId)[0].event).toMatchObject({
      type: 'history.imported', legacyId: 'poise.issue.acme/app.7',
      turns: [{ prompt: 'issue question', reply: 'issue answer' }],
    })
    const again = await postSessions(createBody(card()))
    expect(again.json.existing).toBe(true)
    expect(importedEvents(restId)).toHaveLength(1)
  }, 120_000)

  it('quotes the imported conversation to the first native turn only, outside the recorded prompt', async () => {
    serveLog([
      logRow('a'.repeat(32), 'poise.card.7', 'first question', '2026-10-20T10:00:00.000Z'),
      logRow('b'.repeat(32), 'poise.card.7', 'second question', '2026-10-20T10:05:00.000Z'),
    ], { ['a'.repeat(32)]: 'first answer', ['b'.repeat(32)]: 'second answer' })
    const { session } = await runtime.createForSubject({ agent: 'grok', model: 'grok-4.6-xhigh', subject: card() })
    runtime.prompt(session.id, { text: 'hello agent', attachments: [], mentions: [] })
    await until(() => (prompts.get(session.id)?.length ?? 0) > 0, 'the first adapter prompt')
    const first = prompts.get(session.id)![0].text
    expect(first).toContain('Quoted history')
    expect(first).toContain('first question')
    expect(first).toContain('hello agent')
    const started = storage.findEvent(session.id, (event) => event.type === 'turn.started')
    expect(started?.event.type).toBe('turn.started')
    if (started?.event.type === 'turn.started') expect(started.event.prompt.text).toBe('hello agent')
    finishes.get(session.id)?.({ stopReason: 'end_turn' })
    await until(() => !storage.getOpenTurn(session.id), 'the first turn to settle')
    prompts.clear()
    runtime.prompt(session.id, { text: 'second message', attachments: [], mentions: [] })
    await until(() => (prompts.get(session.id)?.length ?? 0) > 0, 'the second adapter prompt')
    expect(prompts.get(session.id)![0].text).toBe('second message')
    finishes.get(session.id)?.({ stopReason: 'end_turn' })
    await until(() => !storage.getOpenTurn(session.id), 'the second turn to settle')
  }, 180_000)

  it('bounds the import newest first and records how many turns were left out', async () => {
    const rows: unknown[] = []
    const bodies: Record<string, string> = {}
    for (let index = 0; index < 60; index++) {
      const id = index.toString(16).padStart(32, '0')
      rows.push(logRow(id, 'poise.card.7', `q${index} ${'p'.repeat(3 * 1024)}`, `2026-10-20T10:${String(index).padStart(2, '0')}:00.000Z`))
      bodies[id] = `r${index} ${'b'.repeat(3 * 1024)}`
    }
    serveLog(rows, bodies)
    const { session } = await runtime.createForSubject({ agent: 'grok', model: 'grok-4.6-xhigh', subject: card() })
    const imports = importedEvents(session.id)
    expect(imports).toHaveLength(1)
    const event = imports[0].event
    expect(event.type).toBe('history.imported')
    if (event.type !== 'history.imported') throw new Error('expected history.imported')
    expect(event.turns.length).toBeLessThan(60)
    expect(event.omitted).toBe(60 - event.turns.length)
    expect(event.omitted).toBeGreaterThan(0)
    expect(event.turns[event.turns.length - 1].prompt).toContain('q59')
    expect(event.turns[0].prompt).toContain(`q${event.omitted}`)
    const reads = mocks.calls.filter(({ args }) => args[0] === '--read-response')
    expect(reads.length).toBeLessThanOrEqual(50)
  }, 120_000)

  it('skips calls that have no response instead of failing the import', async () => {
    serveLog([
      logRow('a'.repeat(32), 'poise.card.7', 'first question', '2026-10-20T10:00:00.000Z'),
      logRow('b'.repeat(32), 'poise.card.7', 'failed question', '2026-10-20T10:01:00.000Z', { status: 'failed', response: null, error: 'boom' }),
      logRow('c'.repeat(32), 'poise.card.7', 'running question', '2026-10-20T10:02:00.000Z', { status: 'running', response: null }),
      logRow('d'.repeat(32), 'poise.card.7', 'second question', '2026-10-20T10:03:00.000Z'),
    ], { ['a'.repeat(32)]: 'first answer', ['d'.repeat(32)]: 'second answer' })
    const created = await postSessions(createBody(card()))
    expect(created.status).toBe(201)
    expect(created.json.session.importedFrom).toBe('poise.card.7')
    const imports = importedEvents(created.json.session.id)
    expect(imports).toHaveLength(1)
    expect(imports[0].event).toMatchObject({
      type: 'history.imported', legacyId: 'poise.card.7', omitted: 0,
      turns: [
        { prompt: 'first question', reply: 'first answer' },
        { prompt: 'second question', reply: 'second answer' },
      ],
    })
    expect(mocks.calls.filter(({ args }) => args[0] === '--read-response').map(({ args }) => args[1]).sort())
      .toEqual(['a'.repeat(32), 'd'.repeat(32)])
  }, 120_000)

  it('records nothing for an empty earlier conversation', async () => {
    serveLog([], {})
    const created = await postSessions(createBody(card()))
    expect(created.status).toBe(201)
    expect(created.json.session.importedFrom).toBeUndefined()
    expect(importedEvents(created.json.session.id)).toHaveLength(0)
    const legacy = await fetch(`${origin}/api/chat/legacy?subject=${encodeURIComponent('current:poise.card.7')}`)
    expect(legacy.status).toBe(200)
    expect(await legacy.json()).toEqual({ conversation: { turns: [], omitted: 0 } })
  }, 60_000)

  it('stops creation when the earlier conversation cannot be read, unless told to skip it', async () => {
    mocks.logsError = new Error('boom')
    const failed = await postSessions(createBody(card()))
    expect(failed.status).toBe(502)
    expect(failed.json.code).toBe('legacy_unreadable')
    expect(failed.json.error).toContain('boom')
    const listed = await fetch(`${origin}/api/chat/sessions`)
    expect(((await listed.json()) as any).sessions).toHaveLength(0)
    mocks.calls.length = 0
    const skipped = await postSessions(createBody(card(), { skipLegacy: true }))
    expect(skipped.status).toBe(201)
    expect(skipped.json.session.importedFrom).toBeUndefined()
    expect(importedEvents(skipped.json.session.id)).toHaveLength(0)
    expect(mocks.calls.filter(({ file }) => file === 'agent-interface')).toHaveLength(0)
  }, 120_000)

  it('reads Caller\'s call log without writing to it', async () => {
    serveLog([
      logRow('a'.repeat(32), 'poise.card.7', 'first question', '2026-10-20T10:00:00.000Z'),
      logRow('b'.repeat(32), 'poise.card.7', 'second question', '2026-10-20T10:05:00.000Z'),
    ], { ['a'.repeat(32)]: 'first answer', ['b'.repeat(32)]: 'second answer' })
    const { readLegacyConversation } = await import('../server/chat/legacy-import')
    const conversation = await readLegacyConversation('poise.card.7')
    expect(conversation.turns.map((turn) => turn.prompt)).toEqual(['first question', 'second question'])
    expect(mocks.calls).toEqual([
      { file: 'agent-interface', args: ['--logs'] },
      { file: 'agent-interface', args: ['--read-response', 'b'.repeat(32)] },
      { file: 'agent-interface', args: ['--read-response', 'a'.repeat(32)] },
    ])
  }, 60_000)
})
