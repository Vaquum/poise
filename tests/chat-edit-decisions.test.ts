// Edit decisions are recorded once per request, refused for unfinished turns
// and phantom cards, and replayed from the transcript after a reload. The
// server re-parses the stored message with the same parser the transcript
// renders with.
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { CATALOG } from './model-catalog-fixture'
import type { Adapter, AdapterHost, TurnResult } from '../server/chat/adapters/types'
import type { Capabilities, ChatEnvelope, ChatSubject, EditDecision, PromptInput, ServerFrame } from '../server/chat/protocol'
import type { ChatRuntime } from '../server/chat/runtime'
import type { ChatSocketServer } from '../server/chat/transport'

vi.mock('../server/claude-auth', () => ({ claudeAuth: { snapshot: () => ({ status: 'authenticated' }), requireReady: async () => {} } }))
vi.mock('../server/chat', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/chat')>()
  return { ...original, listChatHistory: vi.fn(async () => []) }
})

const caps: Capabilities = { steer: true, fork: true, thought: false, plan: false, commands: false, modes: false, permissions: true, questions: true, resume: true, images: false }
const prompts = new Map<string, PromptInput[]>()
const finishes = new Map<string, (result: TurnResult) => void>()
/** Reply text the adapter emits as one message before waiting, per turn. */
let replyText: string | null = null

function adapter(host: AdapterHost): Adapter {
  let alive = false
  const nativeSessionId = randomUUID()
  const finish = () => { finishes.get(host.sessionId)?.({ stopReason: 'cancelled' }); finishes.delete(host.sessionId) }
  return {
    agent: 'grok', nativeSessionId, capabilities: caps, get alive() { return alive },
    async start(options) { alive = true; return { nativeSessionId, capabilities: caps, modelId: options.modelId, effort: options.effort } },
    async prompt(turnId, input) {
      prompts.set(host.sessionId, [...(prompts.get(host.sessionId) ?? []), input])
      if (replyText !== null) host.emit({ type: 'text.delta', turnId, messageId: `${turnId}:m1`, delta: replyText })
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

const docSubject = (key = 'brief'): ChatSubject => ({ surface: 'editor-document', key, label: 'Brief' })

function makeRuntime() {
  return new Runtime({ instance, instanceLabel: 'test', callerTurns: null, catalog: async () => CATALOG as any,
    adapters: { grok: adapter, claude: adapter, codex: adapter, muse: adapter }, requireClaudeReady: async () => {}, probeAgent: async () => ({ ok: true }),
    localWorkspaceRoot: workspaceRoot, idleTimeoutMinutes: () => 0 })
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

async function decide(socket: WebSocket, sessionId: string, turnId: string, messageId: string, index: number, decision: EditDecision, id = randomUUID()) {
  return sendCommand(socket, id, { type: 'edit.decide', sessionId, turnId, messageId, index, decision })
}

async function runReplyTurn(sessionId: string, reply: string): Promise<{ turnId: string, messageId: string }> {
  replyText = reply
  const receipt = runtime.prompt(sessionId, { text: 'propose something', attachments: [], mentions: [] })
  if (!('turnId' in receipt)) throw new Error('edit fixture unexpectedly waited for an update')
  const { turnId } = receipt
  await until(() => finishes.has(sessionId), 'adapter prompt')
  const done = finishes.get(sessionId)
  finishes.delete(sessionId)
  done?.({ stopReason: 'end_turn' })
  await until(() => !storage.getOpenTurn(sessionId), 'turn to settle')
  return { turnId, messageId: `${turnId}:m1` }
}

function decidedEvents(sessionId: string): ChatEnvelope[] {
  return storage.listEvents(sessionId, 0).events.filter(({ event }) => event.type === 'edit.decided')
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-chat-edit-decisions-test-'))
  vi.stubEnv('POISE_DB', join(root, 'chat.sqlite3'))
  vi.stubEnv('POISE_LOCK_DIR', join(root, 'locks'))
  vi.stubEnv('POISE_EDITOR_DIR', join(root, 'editor'))
  ;({ ChatRuntime: Runtime } = await import('../server/chat/runtime'))
  ;({ ChatSocketServer: SocketServer, handleChatApi } = await import('../server/chat/transport'))
  storage = await import('../server/chat/storage')
  database = await import('../server/db')
})

beforeEach(async () => {
  prompts.clear(); finishes.clear()
  replyText = null
  instance = `decisions:${randomUUID()}`
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

const REPLY = JSON.stringify({
  chat: 'Here are two edits.',
  edits: [
    { description: 'fix a typo', old: 'teh', new: 'the' },
    { old: 'a', new: 'b' },
  ],
})

describe('edit decisions', () => {
  it('records an edit decision once and replays it after a reload', async () => {
    const { session } = await runtime.createForSubject({ agent: 'grok', model: 'grok-4.6-xhigh', subject: docSubject() })
    const { turnId, messageId } = await runReplyTurn(session.id, REPLY)
    const socket = await connect()
    const id = randomUUID()
    const first = await decide(socket, session.id, turnId, messageId, 0, 'applied', id)
    expect(first.ok).toBe(true)
    const replay = await decide(socket, session.id, turnId, messageId, 0, 'applied', id)
    expect(replay.ok).toBe(true)
    const events = decidedEvents(session.id)
    expect(events).toHaveLength(1)
    expect(events[0]?.event).toMatchObject({ type: 'edit.decided', turnId, messageId, index: 0, decision: 'applied' })
    const reread = await (await fetch(`${origin}/api/chat/sessions/${session.id}`)).json() as { events: ChatEnvelope[] }
    const replayed = reread.events.filter(({ event }) => event.type === 'edit.decided')
    expect(replayed).toHaveLength(1)
    expect(replayed[0]?.event).toMatchObject({ type: 'edit.decided', turnId, messageId, index: 0, decision: 'applied' })
  }, 180_000)

  it('refuses a decision for an unfinished turn or an edit card the parser does not produce', async () => {
    const { session } = await runtime.createForSubject({ agent: 'grok', model: 'grok-4.6-xhigh', subject: docSubject() })
    const socket = await connect()
    replyText = REPLY
    const pending = runtime.prompt(session.id, { text: 'propose something', attachments: [], mentions: [] })
    if (!('turnId' in pending)) throw new Error('edit fixture unexpectedly waited for an update')
    await until(() => finishes.has(session.id), 'adapter prompt')
    const refused = await decide(socket, session.id, pending.turnId, `${pending.turnId}:m1`, 0, 'applied')
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error).toBe('no such edit card')
    const done = finishes.get(session.id)
    finishes.delete(session.id)
    done?.({ stopReason: 'end_turn' })
    await until(() => !storage.getOpenTurn(session.id), 'turn to settle')
    const allowed = await decide(socket, session.id, pending.turnId, `${pending.turnId}:m1`, 0, 'applied')
    expect(allowed.ok).toBe(true)
    const unknown = await decide(socket, session.id, pending.turnId, 'no-such-message', 0, 'applied')
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error).toBe('no such edit card')
    // The middle entry has no `new`, so the parser drops it: only 0 and 1 exist.
    const gapped = JSON.stringify({ chat: 'Three entries, two cards.', edits: [{ old: 'a', new: 'b' }, { old: 'dropped' }, { old: 'c', new: 'd' }] })
    const { turnId, messageId } = await runReplyTurn(session.id, gapped)
    const forged = await decide(socket, session.id, turnId, messageId, 2, 'applied')
    expect(forged.ok).toBe(false)
    if (!forged.ok) expect(forged.error).toBe('no such edit card')
    const second = await decide(socket, session.id, turnId, messageId, 1, 'declined')
    expect(second.ok).toBe(true)
    expect(decidedEvents(session.id)).toHaveLength(2)
  }, 180_000)

  it('lets a later decision for a card replace an earlier conflict', async () => {
    const { session } = await runtime.createForSubject({ agent: 'grok', model: 'grok-4.6-xhigh', subject: docSubject() })
    const { turnId, messageId } = await runReplyTurn(session.id, REPLY)
    const socket = await connect()
    expect((await decide(socket, session.id, turnId, messageId, 1, 'conflict')).ok).toBe(true)
    expect((await decide(socket, session.id, turnId, messageId, 1, 'applied')).ok).toBe(true)
    const events = decidedEvents(session.id)
    expect(events).toHaveLength(2)
    expect(events[0]?.event).toMatchObject({ index: 1, decision: 'conflict' })
    expect(events[1]?.event).toMatchObject({ index: 1, decision: 'applied' })
  }, 180_000)
})
