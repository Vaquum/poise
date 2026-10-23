// One session per subject: creation, races, validation, hand-off, fork,
// reset and delete. The earlier conversation is empty here; its import is
// covered in tests/chat-legacy-import.test.ts.
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { CATALOG } from './model-catalog-fixture'
import type { Adapter, AdapterHost, TurnResult } from '../server/chat/adapters/types'
import type { Capabilities, ChatSubject, PromptInput, ServerFrame } from '../server/chat/protocol'
import type { ChatRuntime, RuntimeOptions } from '../server/chat/runtime'
import type { ChatSocketServer } from '../server/chat/transport'

vi.mock('../server/claude-auth', () => ({ claudeAuth: { snapshot: () => ({ status: 'authenticated' }), requireReady: async () => {} } }))
vi.mock('../server/chat', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/chat')>()
  return { ...original, listChatHistory: vi.fn(async () => []) }
})
vi.mock('../server/agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('../server/agent')>()
  return { ...original, fetchAgentResponse: vi.fn(async (callId: string) => ({ id: callId, body: `reply ${callId.slice(0, 8)}` })) }
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
const issue = (): ChatSubject => ({ surface: 'current', key: 'poise.issue.acme/app.7', label: 'Broken logout', url: 'https://github.com/acme/app/issues/7' })
const createBody = (subject: ChatSubject) => ({ agent: 'grok', model: 'grok-4.6-xhigh', subject })

async function postSessions(body: unknown): Promise<{ status: number, json: any }> {
  const response = await fetch(`${origin}/api/chat/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, json: await response.json() }
}

async function sessionCount(): Promise<number> {
  const response = await fetch(`${origin}/api/chat/sessions`)
  const body = await response.json() as { sessions: unknown[] }
  return body.sessions.length
}

async function connect(): Promise<WebSocket> {
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/ws/chat`, { origin })
  clients.push(socket)
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  return socket
}

function sendCommand(socket: WebSocket, id: string, command: Record<string, unknown>): Promise<Extract<ServerFrame, { kind: 'ack' }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', listener); reject(new Error('ack deadline')) }, 8000)
    const listener = (raw: import('ws').RawData) => {
      const frame = JSON.parse(raw.toString()) as ServerFrame
      if (frame.kind === 'ack' && frame.id === id) { clearTimeout(timer); socket.off('message', listener); resolve(frame) }
    }
    socket.on('message', listener)
    socket.send(JSON.stringify({ id, command }))
  })
}

function makeRuntime(options: Partial<RuntimeOptions> = {}) {
  return new Runtime({ instance, instanceLabel: 'test', callerTurns: null, catalog: async () => CATALOG as any,
    adapters: { grok: adapter, claude: adapter, codex: adapter, muse: adapter }, requireClaudeReady: async () => {}, probeAgent: async () => ({ ok: true }),
    localWorkspaceRoot: workspaceRoot, idleTimeoutMinutes: () => 0, ...options })
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-chat-subjects-test-'))
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
  instance = `subjects:${randomUUID()}`
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

describe('one session per subject', () => {
  it('returns the subject\'s session instead of creating a second one', async () => {
    const first = await postSessions(createBody(card()))
    expect(first.status).toBe(201)
    expect(first.json.existing).toBe(false)
    expect(first.json.session.subject).toMatchObject({ surface: 'current', key: 'poise.card.7' })
    const count = await sessionCount()
    const second = await postSessions(createBody(card()))
    expect(second.status).toBe(200)
    expect(second.json.existing).toBe(true)
    expect(second.json.session.id).toBe(first.json.session.id)
    expect(await sessionCount()).toBe(count)
    const lookup = await fetch(`${origin}/api/chat/sessions?subject=${encodeURIComponent('current:poise.card.7')}`)
    expect(lookup.status).toBe(200)
    expect(((await lookup.json()) as any).session.id).toBe(first.json.session.id)
    const missing = await fetch(`${origin}/api/chat/sessions?subject=${encodeURIComponent('current:poise.card.8')}`)
    expect((((await missing.json()) as any).session)).toBeNull()
  }, 60_000)

  it('accepts the Editor surfaces and finds their legacy ids on the server', async () => {
    const chat = await import('../server/chat')
    const history = vi.mocked(chat.listChatHistory)
    const editorDir = join(root, 'editor')
    await mkdir(editorDir, { recursive: true })
    const docId = 'editor-brief-1769500000000'
    const forgedDocId = 'editor-other-1769500000000'
    await writeFile(join(editorDir, 'brief.chat.json'), JSON.stringify({ session_id: docId, created_at: '2026-10-20T10:00:00.000Z' }))
    await writeFile(join(editorDir, 'other.chat.json'), JSON.stringify({ session_id: forgedDocId, created_at: '2026-10-20T10:00:00.000Z' }))
    const passageNew = 'editor-brief-1769500000000042'
    const passageOld = 'ann-qncjuig3'
    const annotation = (id: string, sessionId: string) => ({
      id, session_id: sessionId,
      range: { start_line: 0, start_offset: 0, end_line: 0, end_offset: 5 },
      snippet: 'hello', comment: '', created_at: '2026-10-20T10:00:00.000Z', updated_at: '2026-10-20T10:00:00.000Z',
    })
    await writeFile(join(editorDir, 'brief.annotations.json'), JSON.stringify({
      annotations: [annotation('ann-fresh', passageNew), annotation('ann-stale', passageOld)],
    }))
    const rows = (sessionId: string) => [{
      id: 'a'.repeat(32), session_id: sessionId, prompt: `question for ${sessionId}`,
      started_at: '2026-10-20T10:00:00.000Z', status: 'completed', response: 'abcd1234', behavior: 'chat' as const, error: '',
    }]
    history.mockImplementation(async (id: string) => [docId, forgedDocId, passageNew, passageOld].includes(id) ? rows(id) : [])
    try {
      const doc = await postSessions(createBody({ surface: 'editor-document', key: 'brief', label: 'Brief' }))
      expect(doc.status).toBe(201)
      expect(doc.json.session.importedFrom).toBe(docId)
      const fresh = await postSessions(createBody({ surface: 'editor-passage', key: 'brief:ann-fresh', label: 'A passage' }))
      expect(fresh.status).toBe(201)
      expect(fresh.json.session.importedFrom).toBe(passageNew)
      const stale = await postSessions(createBody({ surface: 'editor-passage', key: 'brief:ann-stale', label: 'A passage' }))
      expect(stale.status).toBe(201)
      expect(stale.json.session.importedFrom).toBe(passageOld)
      expect(history).toHaveBeenCalledWith(docId)
      expect(history).toHaveBeenCalledWith(passageNew)
      expect(history).toHaveBeenCalledWith(passageOld)
      // A review has no legacy id; an id sent by the client is ignored.
      const review = await postSessions({ ...createBody({ surface: 'editor-review', key: 'brief:IC_review1', label: 'A review' }), legacyId: passageOld })
      expect(review.status).toBe(201)
      expect(review.json.session.importedFrom).toBeUndefined()
      const forged = await postSessions({ ...createBody({ surface: 'editor-document', key: 'other', label: 'Other' }), legacyId: 'forged-id' })
      expect(forged.status).toBe(201)
      expect(forged.json.session.importedFrom).toBe(forgedDocId)
      expect(history).not.toHaveBeenCalledWith('forged-id')
    } finally {
      history.mockReset()
      history.mockResolvedValue([])
    }
  }, 120_000)

  it('creates exactly one session when two requests send the same subject at once', async () => {
    const socket = await connect()
    const rest = postSessions(createBody(issue()))
    const ws = sendCommand(socket, randomUUID(), { type: 'session.new', ...createBody(issue()) })
    const [rested, acked] = await Promise.all([rest, ws])
    expect(acked.ok).toBe(true)
    const restId = (rested.json as any).session.id as string
    const wsId = ((acked as any).result.session.id) as string
    expect(wsId).toBe(restId)
    expect([(rested.json as any).existing, (acked as any).result.existing].sort()).toEqual([false, true])
    expect(await sessionCount()).toBe(1)
    expect(await readdir(join(workspaceRoot, 'workers'))).toEqual([restId])
  }, 60_000)

  it('refuses to store a second session for the same subject', async () => {
    const { session } = await runtime.createForSubject({ agent: 'grok', model: 'grok-4.6-xhigh', subject: card() })
    let code: string | undefined
    try {
      storage.insertSession({ ...session, id: randomUUID() })
    } catch (error: any) {
      code = error?.code
    }
    expect(code).toBe('SQLITE_CONSTRAINT_UNIQUE')
  }, 60_000)

  it('rejects an unknown surface, a malformed key and a non-GitHub url', async () => {
    const bad = [
      { surface: 'archive', key: 'poise.card.1', label: 'x' },
      { surface: 'current', key: 'poise.card.abc', label: 'x' },
      { surface: 'current', key: 'poise.Card.1', label: 'x' },
      { surface: 'current', key: 'poise.issue.acme/app', label: 'x' },
      { surface: 'current', key: 'poise.card.1', label: 'x', url: 'https://example.com/x' },
      { surface: 'current', key: 'poise.card.1', label: '' },
      { surface: 'editor-document', key: '../escape', label: 'x' },
      { surface: 'editor-document', key: '', label: 'x' },
      { surface: 'editor-passage', key: 'brief', label: 'x' },
      { surface: 'editor-passage', key: 'brief:', label: 'x' },
      { surface: 'editor-passage', key: 'brief:ann with space', label: 'x' },
      { surface: 'editor-passage', key: 'brief:ann:extra', label: 'x' },
      { surface: 'editor-review', key: 'brief', label: 'x' },
      { surface: 'editor-review', key: 'brief:IC_some review', label: 'x' },
    ]
    for (const subject of bad) {
      const response = await postSessions({ agent: 'grok', model: 'grok-4.6-xhigh', subject })
      expect(response.status).toBe(400)
      expect((response.json as any).code).toBe('invalid')
    }
    const socket = await connect()
    const ack = await sendCommand(socket, randomUUID(), { type: 'session.new', agent: 'grok', model: 'grok-4.6-xhigh', subject: bad[0] })
    expect(ack.ok).toBe(false)
    if (!ack.ok) expect(ack.code).toBe('invalid')
    expect(await sessionCount()).toBe(0)
  })

  // Real git workspaces and settled summary turns: slow on a loaded machine.
  it('moves the subject to the new session on hand-off and clears it on fork', async () => {
    const { session: source } = await runtime.createForSubject({ agent: 'grok', model: 'grok-4.6-xhigh', subject: card() })
    const target = await runtime.handoff(source.id, { agent: 'codex', model: 'gpt-6-astra-ultra' })
    expect(storage.getSession(source.id)?.subject).toBeUndefined()
    expect(storage.getSession(target.id)?.subject).toMatchObject({ surface: 'current', key: 'poise.card.7' })
    expect(storage.sessionForSubject(instance, 'current', 'poise.card.7')).toBe(target.id)
    await until(() => finishes.has(target.id), 'the handoff summary turn')
    finishes.get(target.id)?.({ stopReason: 'end_turn' })
    await until(() => !storage.getOpenTurn(target.id), 'the handoff summary to settle')
    await runtime.rename(source.id, 'renamed after handoff')
    expect(storage.getSession(source.id)?.subject).toBeUndefined()
    expect(storage.sessionForSubject(instance, 'current', 'poise.card.7')).toBe(target.id)
    const fork = await runtime.fork(target.id)
    expect(fork.subject).toBeUndefined()
    expect(fork.importedFrom).toBeUndefined()
    expect(storage.getSession(fork.id)?.subject).toBeUndefined()
    const plain = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh' })
    await until(() => runtime.get(plain.id)?.status === 'idle', 'the plain source to start')
    const plainTarget = await runtime.handoff(plain.id, { agent: 'codex', model: 'gpt-6-astra-ultra' })
    expect(plainTarget.subject).toBeUndefined()
    await until(() => finishes.has(plainTarget.id), 'the plain handoff summary turn')
    finishes.get(plainTarget.id)?.({ stopReason: 'end_turn' })
    await until(() => !storage.getOpenTurn(plainTarget.id), 'the plain handoff summary to settle')
  }, 180_000)

  it('waits for source startup before handing off its subject and work bindings', async () => {
    let release!: () => void
    let entered = false
    let sourceId: string | undefined
    const held = new Promise<void>(resolve => { release = resolve })
    const owned = 'https://github.com/acme/app/pull/537'
    const store = await import('../server/chat/control-store')
    const handoffRuntime = makeRuntime({
      catalog: async () => {
        // Target model resolution must happen after the source initializes.
        if (sourceId) expect(handoffRuntime.get(sourceId)?.status).toBe('idle')
        return CATALOG
      },
      prepareCli: async provider => {
        if (provider === 'grok') { entered = true; await held }
        return { provider, status: 'current', checkedAt: new Date().toISOString(), after: 'fixture' }
      },
    })
    try {
      const { session: source } = await handoffRuntime.createForSubject({ agent: 'grok', model: 'grok-4.6-xhigh', subject: card() })
      sourceId = source.id
      await until(() => entered, 'the held source CLI check')
      store.bindWork(instance, source.id, owned)
      const handing = handoffRuntime.handoff(source.id, { agent: 'codex', model: 'gpt-6-astra-ultra' })
      release()
      const target = await handing
      await until(() => finishes.has(target.id), 'the startup-ordered handoff summary')
      expect(storage.sessionForSubject(instance, 'current', card().key)).toBe(target.id)
      expect(store.bindings(instance).find(binding => binding.target === owned)?.session).toBe(target.id)
      expect(prompts.get(target.id)).toHaveLength(1)
      finishes.get(target.id)?.({ stopReason: 'end_turn' })
      await until(() => !storage.getOpenTurn(target.id), 'the startup-ordered summary to settle')
    } finally { release(); await handoffRuntime.stop() }
  }, 180_000)

  it('keeps source ownership when failed startup never created its branch', async () => {
    const store = await import('../server/chat/control-store')
    const owned = 'https://github.com/acme/app/pull/538'
    const handoffRuntime = makeRuntime({ prepareCli: async () => { throw new Error('source CLI unavailable') } })
    try {
      const { session: source } = await handoffRuntime.createForSubject({ agent: 'grok', model: 'grok-4.6-xhigh', subject: card() })
      await until(() => handoffRuntime.get(source.id)?.status === 'error', 'the failed source startup')
      store.bindWork(instance, source.id, owned)
      await expect(handoffRuntime.handoff(source.id, { agent: 'codex', model: 'gpt-6-astra-ultra' }))
        .rejects.toMatchObject({ statusCode: 409, code: 'agent_error', message: expect.stringContaining('source branch') })
      expect(storage.listSessions(instance).map(session => session.id)).toEqual([source.id])
      expect(storage.sessionForSubject(instance, 'current', card().key)).toBe(source.id)
      expect(store.bindings(instance).find(binding => binding.target === owned)?.session).toBe(source.id)
      expect(prompts.size).toBe(0)
    } finally { await handoffRuntime.stop() }
  }, 180_000)

  it('hands off a provider-error source when its branch was created', async () => {
    const store = await import('../server/chat/control-store')
    const owned = 'https://github.com/acme/app/pull/539'
    const handoffRuntime = makeRuntime({ adapters: {
      grok: host => ({ ...adapter(host), async start() { throw new Error('native provider unavailable') } }),
      codex: adapter,
    } })
    try {
      const { session: source } = await handoffRuntime.createForSubject({ agent: 'grok', model: 'grok-4.6-xhigh', subject: card() })
      await until(() => handoffRuntime.get(source.id)?.status === 'error', 'the failed native provider')
      expect(storage.getSession(source.id)?.branch.baseSha).toBeTruthy()
      store.bindWork(instance, source.id, owned)
      const target = await handoffRuntime.handoff(source.id, { agent: 'codex', model: 'gpt-6-astra-ultra' })
      await until(() => finishes.has(target.id), 'the provider-error handoff summary')
      expect(storage.sessionForSubject(instance, 'current', card().key)).toBe(target.id)
      expect(store.bindings(instance).find(binding => binding.target === owned)?.session).toBe(target.id)
      finishes.get(target.id)?.({ stopReason: 'end_turn' })
      await until(() => !storage.getOpenTurn(target.id), 'the provider-error summary to settle')
    } finally { await handoffRuntime.stop() }
  }, 180_000)

  it('rechecks an incoming source turn after waiting for startup', async () => {
    let release!: () => void
    let entered = false
    const held = new Promise<void>(resolve => { release = resolve })
    const handoffRuntime = makeRuntime({ prepareCli: async provider => {
      if (provider === 'grok') { entered = true; await held }
      return { provider, status: 'current', checkedAt: new Date().toISOString(), after: 'fixture' }
    } })
    try {
      const { session: source } = await handoffRuntime.createForSubject({ agent: 'grok', model: 'grok-4.6-xhigh', subject: card() })
      await until(() => entered, 'the held source before a new turn')
      const refused = expect(handoffRuntime.handoff(source.id, { agent: 'codex', model: 'gpt-6-astra-ultra' }))
        .rejects.toMatchObject({ statusCode: 409, code: 'turn_in_progress' })
      handoffRuntime.prompt(source.id, { text: 'arrived during startup', attachments: [], mentions: [] })
      release()
      await refused
      expect(storage.listSessions(instance).map(session => session.id)).toEqual([source.id])
      expect(storage.sessionForSubject(instance, 'current', card().key)).toBe(source.id)
      await until(() => finishes.has(source.id), 'the source turn to enter its adapter')
      finishes.get(source.id)?.({ stopReason: 'end_turn' })
      await until(() => !storage.getOpenTurn(source.id), 'the source turn to settle')
    } finally { release(); await handoffRuntime.stop() }
  }, 180_000)

  it('does not create a handoff target when the source closes during startup', async () => {
    let release!: () => void
    let entered = false
    const held = new Promise<void>(resolve => { release = resolve })
    const handoffRuntime = makeRuntime({ prepareCli: async provider => {
      if (provider === 'grok') { entered = true; await held }
      return { provider, status: 'current', checkedAt: new Date().toISOString(), after: 'fixture' }
    } })
    try {
      const { session: source } = await handoffRuntime.createForSubject({ agent: 'grok', model: 'grok-4.6-xhigh', subject: card() })
      await until(() => entered, 'the held source before closing')
      const refused = expect(handoffRuntime.handoff(source.id, { agent: 'codex', model: 'gpt-6-astra-ultra' }))
        .rejects.toMatchObject({ statusCode: 409, code: 'agent_error', message: expect.stringContaining('closing or closed') })
      const closing = handoffRuntime.close(source.id)
      release()
      await Promise.all([refused, closing])
      expect(storage.listSessions(instance).map(session => session.id)).toEqual([source.id])
      expect(handoffRuntime.get(source.id)?.status).toBe('closed')
      expect(storage.sessionForSubject(instance, 'current', card().key)).toBe(source.id)
      expect(prompts.size).toBe(0)
    } finally { release(); await handoffRuntime.stop() }
  }, 180_000)

  it('frees the subject when its session is deleted', async () => {
    const first = await runtime.createForSubject({ agent: 'grok', model: 'grok-4.6-xhigh', subject: card() })
    expect(first.existing).toBe(false)
    await runtime.delete(first.session.id)
    const second = await runtime.createForSubject({ agent: 'grok', model: 'grok-4.6-xhigh', subject: card() })
    expect(second.existing).toBe(false)
    expect(second.session.id).not.toBe(first.session.id)
  }, 120_000)

  it('keeps the subject and clears the transcript on /reset', async () => {
    const chat = await import('../server/chat')
    vi.mocked(chat.listChatHistory).mockResolvedValueOnce([
      { id: 'a'.repeat(32), session_id: 'poise.card.7', prompt: 'first question', started_at: '2026-10-20T10:00:00.000Z', status: 'completed', response: 'abcd1234', behavior: 'chat', error: '' },
      { id: 'b'.repeat(32), session_id: 'poise.card.7', prompt: 'second question', started_at: '2026-10-20T10:05:00.000Z', status: 'completed', response: 'abcd1234', behavior: 'chat', error: '' },
    ])
    const { session } = await runtime.createForSubject({ agent: 'grok', model: 'grok-4.6-xhigh', subject: card() })
    expect(session.importedFrom).toBe('poise.card.7')
    runtime.prompt(session.id, { text: 'hello agent', attachments: [], mentions: [] })
    await until(() => (prompts.get(session.id)?.length ?? 0) > 0, 'the first adapter prompt')
    expect(prompts.get(session.id)![0].text).toContain('Quoted history')
    expect(prompts.get(session.id)![0].text).toContain('hello agent')
    const started = storage.findEvent(session.id, (event) => event.type === 'turn.started')
    expect(started?.event.type).toBe('turn.started')
    if (started?.event.type === 'turn.started') expect(started.event.prompt.text).toBe('hello agent')
    finishes.get(session.id)?.({ stopReason: 'end_turn' })
    await until(() => !storage.getOpenTurn(session.id), 'the first turn to settle')
    await runtime.reset(session.id)
    const after = storage.getSession(session.id)!
    expect(after.subject).toMatchObject({ surface: 'current', key: 'poise.card.7' })
    expect(after.importedFrom).toBe('poise.card.7')
    const resetTypes = storage.listEvents(session.id, 0).events.map(({ event }) => event.type)
    expect(resetTypes[0]).toBe('session.reset')
    expect(resetTypes).not.toContain('history.imported')
    expect(resetTypes).not.toContain('turn.started')
    prompts.clear()
    runtime.prompt(session.id, { text: 'after reset', attachments: [], mentions: [] })
    await until(() => (prompts.get(session.id)?.length ?? 0) > 0, 'the post-reset adapter prompt')
    expect(prompts.get(session.id)![0].text).toBe('after reset')
    finishes.get(session.id)?.({ stopReason: 'end_turn' })
    await until(() => !storage.getOpenTurn(session.id), 'the post-reset turn to settle')
  }, 180_000)

  it('returns a session with a subject in any state', async () => {
    const { session } = await runtime.createForSubject({ agent: 'grok', model: 'grok-4.6-xhigh', subject: card() })
    await runtime.close(session.id)
    const again = await runtime.createForSubject({ agent: 'grok', model: 'grok-4.6-xhigh', subject: card() })
    expect(again.existing).toBe(true)
    expect(again.session.id).toBe(session.id)
    expect(again.session.status).toBe('closed')
    let code: string | undefined
    let status: number | undefined
    try {
      runtime.prompt(session.id, { text: 'hello again', attachments: [], mentions: [] })
    } catch (error: any) {
      code = error?.code
      status = error?.statusCode
    }
    expect(status).toBe(409)
    expect(code).toBe('no_turn')
  }, 120_000)
})
