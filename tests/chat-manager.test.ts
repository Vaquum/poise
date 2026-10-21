import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { CATALOG } from './model-catalog-fixture'
import type { Adapter, AdapterHost, TurnResult } from '../server/chat/adapters/types'
import type { Capabilities, PromptInput, ServerFrame } from '../server/chat/protocol'
import type { ChatRuntime } from '../server/chat/runtime'
import type { ChatControl } from '../server/chat/control'
import type { ResolvedServer } from '../server/extensions/types'

vi.mock('../server/claude-auth', () => ({ claudeAuth: { snapshot: () => ({ status: 'authenticated' }), requireReady: async () => {} } }))
const executeFile = promisify(execFile)
const caps: Capabilities = { steer: true, fork: false, thought: false, plan: false, commands: false, modes: false, permissions: true, questions: true, resume: true, images: false }
const forkCaps: Capabilities = { ...caps, fork: true }
let root: string
let runtime: ChatRuntime
let control: ChatControl
let server: Server
let origin: string
let instance: string
let workspaceRoot: string
let store: typeof import('../server/chat/control-store')
let storage: typeof import('../server/chat/storage')
let database: typeof import('../server/db')
let Runtime: typeof ChatRuntime
let Control: typeof ChatControl
let transportModule: typeof import('../server/chat/transport')
let socketServer: import('../server/chat/transport').ChatSocketServer | null = null
const prompts = new Map<string, PromptInput[]>()
const finishes = new Map<string, (result: TurnResult) => void>()
const hosts = new Map<string, AdapterHost>()
const starts = new Map<string, Array<Record<string, unknown>>>()
let forkCalls = 0
let catalog: typeof CATALOG = CATALOG
let servers: ResolvedServer[] = []
let slots = 4

function scripted(host: AdapterHost, capabilities: Capabilities): Adapter {
  hosts.set(host.sessionId, host)
  let alive = false
  const nativeSessionId = randomUUID()
  const finish = () => { finishes.get(host.sessionId)?.({ stopReason: 'cancelled' }); finishes.delete(host.sessionId) }
  return {
    agent: 'grok', nativeSessionId, capabilities, get alive() { return alive },
    async start(options) {
      alive = true
      starts.set(host.sessionId, [...(starts.get(host.sessionId) ?? []), options as unknown as Record<string, unknown>])
      return { nativeSessionId, capabilities, modelId: options.modelId, effort: options.effort }
    },
    async prompt(_turn, input) {
      prompts.set(host.sessionId, [...(prompts.get(host.sessionId) ?? []), input])
      return new Promise<TurnResult>(done => finishes.set(host.sessionId, done))
    },
    async cancel() { finish() }, async close() { alive = false; finish() },
    async steer() {}, async setMode() {}, async setModel(modelId, effort) { return { modelId, effort } },
    async fork() { forkCalls++; return randomUUID() }, onExit() {},
  }
}
const adapter = (host: AdapterHost) => scripted(host, caps)
const forkAdapter = (host: AdapterHost) => scripted(host, forkCaps)

async function until(check: () => boolean) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) { if (check()) return; await new Promise(done => setTimeout(done, 15)) }
  throw new Error('manager fixture readiness deadline')
}
function makeRuntime() {
  return new Runtime({ instance, instanceLabel: 'test', callerTurns: null, catalog: async () => catalog,
    adapters: { grok: adapter, claude: adapter, codex: adapter, muse: forkAdapter },
    requireClaudeReady: async () => {}, probeAgent: async () => ({ ok: true }),
    localWorkspaceRoot: workspaceRoot, idleTimeoutMinutes: () => 0, maxConcurrentLocalTurns: () => slots,
    controlContext: id => control.context(id), leaseProbes: {},
    extensions: { resolve: async () => ({ servers, notices: [], fingerprint: JSON.stringify(servers) }), delivered: () => {}, scrub: event => event, redact: text => text } })
}
async function restart() {
  const stopped = runtime.stop()
  await control.stop(stopped)
  await socketServer?.close()
  runtime = makeRuntime()
  control = new Control(runtime, {})
  control.attach(server)
  socketServer = new transportModule.ChatSocketServer(runtime)
  socketServer.attach(server)
  await runtime.recover()
  control.start()
}
async function config(id: string) {
  const context = await control.context(id)
  const path = /"([^"\n]+\.json)"/.exec(context)?.[1]
  if (!path) throw new Error('native control connection missing')
  return { path, ...JSON.parse(await readFile(path, 'utf8')) as { token: string, sessionId: string, origin: string } }
}
async function controlRequest(id: string, command: Record<string, unknown>) {
  const connection = await config(id)
  return fetch(`${origin}/api/chat/control`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Poise-Chat': id, Authorization: `Bearer ${connection.token}` },
    body: JSON.stringify({ requestId: randomUUID(), ...command }) })
}
const GROK_MODEL = 'grok-4.6-xhigh'
const MUSE_MODEL = 'muse-spark-1.3-contributor-max'
const OPUS_MODEL = 'opus-5-max'

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-manager-test-'))
  vi.stubEnv('POISE_DB', join(root, 'chat.sqlite3'))
  vi.stubEnv('POISE_LOCK_DIR', join(root, 'locks'))
  ;({ ChatRuntime: Runtime } = await import('../server/chat/runtime'))
  ;({ ChatControl: Control } = await import('../server/chat/control'))
  store = await import('../server/chat/control-store')
  storage = await import('../server/chat/storage')
  database = await import('../server/db')
  transportModule = await import('../server/chat/transport')
})
beforeEach(async () => {
  prompts.clear(); finishes.clear(); hosts.clear(); starts.clear()
  forkCalls = 0
  catalog = CATALOG
  servers = []
  slots = 4
  instance = `manager:${randomUUID()}`
  workspaceRoot = join(root, randomUUID())
  runtime = makeRuntime()
  control = new Control(runtime, {})
  server = createServer((req, res) => {
    if (req.url === '/api/chat/control') { void control.handle(req, res); return }
    void transportModule.handleChatApi(req, res, req.url || '', runtime, undefined, transportModule.speaksForPerson(req, false, { kind: 'local' }))
  })
  control.attach(server)
  socketServer = new transportModule.ChatSocketServer(runtime)
  socketServer.attach(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture needs TCP')
  origin = `http://127.0.0.1:${address.port}`
  control.start()
})
afterEach(async () => {
  await socketServer?.close()
  socketServer = null
  await control?.stop()
  await runtime?.stop()
  await new Promise<void>(done => server.close(() => done()))
})
afterAll(async () => { database.closeDatabase(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

function postSessions(body: unknown, withOrigin: boolean) {
  return fetch(`${origin}/api/chat/sessions`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(withOrigin ? { Origin: origin } : {}) },
    body: JSON.stringify(body) })
}

describe('one Manager chat per workspace', () => {
  it('creates exactly one Manager when two browser requests race', async () => {
    const workspace = await import('../server/chat/local-workspace')
    let calls = 0
    let open!: () => void
    const barrier = new Promise<void>(resolve => { open = resolve })
    const original = workspace.ensureWorkerWorkspace.bind(workspace)
    vi.spyOn(workspace, 'ensureWorkerWorkspace').mockImplementation(async (...args: Parameters<typeof workspace.ensureWorkerWorkspace>) => {
      calls++
      if (calls >= 2) open()
      else await barrier
      return original(...args)
    })
    try {
      const body = { agent: 'grok', model: GROK_MODEL, role: 'manager' }
      const [first, second] = await Promise.all([postSessions(body, true), postSessions(body, true)])
      expect([first.status, second.status].sort()).toEqual([201, 409])
      const winner = first.status === 201 ? await first.json() : await second.json()
      const loser = first.status === 409 ? await first.json() : await second.json()
      expect(loser).toEqual({ error: 'A Manager already exists.', code: 'manager_exists', manager: { id: winner.session.id } })
      expect(runtime.list().filter(s => s.role === 'manager')).toHaveLength(1)
      expect(await readdir(join(workspaceRoot, 'workers'))).toHaveLength(1)
    } finally {
      vi.restoreAllMocks()
    }
  }, 30_000)

  it('rejects a second Manager row in SQLite even without the pre-check', async () => {
    const first = await runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'manager' })
    expect(first.role).toBe('manager')
    expect(() => storage.insertSession({ ...first, id: randomUUID() })).toThrow(
      expect.objectContaining({ code: 'SQLITE_CONSTRAINT_UNIQUE' }))
    const other = { ...first, id: randomUUID(), instance: `manager:${randomUUID()}` }
    expect(() => storage.insertSession(other)).not.toThrow()
    storage.deleteSession(other.id)
  }, 30_000)

  it('refuses Manager creation on the documented non-browser paths', async () => {
    const body = { agent: 'grok', model: GROK_MODEL, role: 'manager' }
    const plain = await postSessions(body, false)
    expect(plain.status).toBe(403)
    expect(await plain.json()).toEqual({ error: 'A Manager is created from the New session dialog in the browser.', code: 'invalid' })

    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws/chat')
    try {
      await new Promise<void>((done, fail) => { socket.once('open', done); socket.once('error', fail) })
      const acked = new Promise<{ ok: boolean, code?: string }>((done, fail) => {
        const timer = setTimeout(() => fail(new Error('ack deadline')), 5000)
        socket.on('message', (raw: import('ws').RawData) => {
          const frame = JSON.parse(raw.toString()) as ServerFrame
          if (frame.kind === 'ack' && frame.id === 'manager-ws') { clearTimeout(timer); done(frame as { ok: boolean, code?: string }) }
        })
      })
      socket.send(JSON.stringify({ id: 'manager-ws', command: { type: 'session.new', agent: 'grok', model: GROK_MODEL, role: 'manager' } }))
      const ack = await acked
      expect(ack.ok).toBe(false)
      expect(ack.code).toBe('invalid')
    } finally {
      socket.terminate()
    }

    const parent = await runtime.create({ agent: 'grok', model: GROK_MODEL, title: 'Parent', deferStart: true })
    const requestId = randomUUID()
    const refused = await controlRequest(parent.id, { operation: 'create', requestId, title: 'Sneaky', task: 'Take over', role: 'manager' })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: 'A Manager is created by the person in the New session dialog.' })
    expect(database.db.prepare('SELECT request_id FROM chat_command_receipts WHERE request_id = ?').get(requestId)).toBeUndefined()

    const connection = await config(parent.id)
    const script = resolve('scripts/poise-chat-control.mjs')
    const failure = await executeFile(process.execPath, [script, connection.path,
      JSON.stringify({ operation: 'api', path: '/api/chat/sessions', method: 'POST', body })]).then(() => null, error => error as { code?: number, stderr?: string })
    expect(failure?.code).toBe(1)
    expect(String(failure?.stderr)).toContain('403')
    expect(storage.managerSession(instance)).toBeNull()
    expect(runtime.list().filter(s => s.role === 'manager')).toHaveLength(0)
  }, 30_000)

  it('validates the role in the runtime itself', async () => {
    await expect(runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'boss' as 'manager' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'invalid', message: 'role must be "manager" or absent' })
    for (const extra of [{ repo: 'acme/app' }, { branch: { existing: 'main' } }, { checkout: '/tmp/x' }] as const) {
      await expect(runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'manager', ...extra }))
        .rejects.toMatchObject({ statusCode: 400, code: 'invalid',
          message: 'A Manager runs in its own local workspace; repo, branch and checkout are not accepted.' })
    }
    await expect(runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'manager', context: { kind: 'card', title: 'Card' } }))
      .rejects.toMatchObject({ statusCode: 400, code: 'invalid', message: 'A Manager starts without card or document context.' })
    const manager = await runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'manager' })
    await expect(runtime.create({ agent: 'grok', model: 'no-such-model', role: 'manager' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'manager_exists', message: 'A Manager already exists.' })
    await runtime.close(manager.id)
    const closed = runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'manager' }).then(() => null, error => error)
    await expect(closed).resolves.toMatchObject({ statusCode: 409, code: 'manager_exists' })
    expect((await closed as { detail?: { manager?: { id: string } } }).detail).toEqual({ manager: { id: manager.id } })
    const stored = storage.getSession(manager.id)!
    stored.retiredModel = stored.model
    storage.saveSession(stored)
    const retired = runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'manager' }).then(() => null, error => error)
    await expect(retired).resolves.toMatchObject({ statusCode: 409, code: 'manager_exists' })
    expect((await retired as { detail?: { manager?: { id: string } } }).detail).toEqual({ manager: { id: manager.id } })
  }, 30_000)

  it('takes the role only from the indexed column', async () => {
    const ordinary = await runtime.create({ agent: 'grok', model: GROK_MODEL, title: 'Ordinary', deferStart: true })
    const manager = await runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'manager', deferStart: true })
    database.db.prepare(`UPDATE chat_sessions SET record = json_set(record, '$.role', 'manager') WHERE id = ?`).run(ordinary.id)
    database.db.prepare(`UPDATE chat_sessions SET record = json_remove(record, '$.role') WHERE id = ?`).run(manager.id)
    await restart()
    expect(runtime.get(ordinary.id)?.role).toBeUndefined()
    expect(storage.managerSession(instance)?.id).toBe(manager.id)
    expect(runtime.get(manager.id)?.role).toBe('manager')
    await runtime.rename(manager.id, 'Renamed Manager')
    expect(database.db.prepare('SELECT role FROM chat_sessions WHERE id = ?').pluck().get(manager.id)).toBe('manager')
    expect(runtime.get(manager.id)?.role).toBe('manager')
  }, 30_000)

  it('removes a losing Manager workspace only under its lease and owner marker', async () => {
    const workspace = await import('../server/chat/local-workspace')
    const { CheckoutLease, canonicalCheckout, checkoutLockPath } = await import('../server/chat/checkout-lock')
    const { lstat } = await import('node:fs/promises')
    const seen: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { seen.push(args.join(' ')) })
    try {
      const first = randomUUID()
      const checkout = await workspace.ensureWorkerWorkspace(workspaceRoot, first, instance)
      const checkoutCanonical = canonicalCheckout(checkout)
      expect(await workspace.discardUnclaimedWorkspace(workspaceRoot, checkout, instance, {})).toBe('removed')
      await expect(readdir(checkout)).rejects.toThrow()
      await expect(lstat(checkoutLockPath(checkoutCanonical))).resolves.toBeTruthy()

      const second = randomUUID()
      const busy = await workspace.ensureWorkerWorkspace(workspaceRoot, second, instance)
      const busyCanonical = canonicalCheckout(busy)
      const holder = new CheckoutLease(busy, { ownerKind: 'poise:chat', ownerId: 'bootstrap', ownerLabel: 'test bootstrap', instance }, {})
      expect(holder.tryAcquire().acquired).toBe(true)
      try {
        const started = Date.now()
        expect(await workspace.discardUnclaimedWorkspace(workspaceRoot, busy, instance, {})).toBe('kept')
        expect(Date.now() - started).toBeLessThan(2000)
        expect(seen.some(line => line.includes('[chat] kept unclaimed workspace') && line.includes(busyCanonical))).toBe(true)
        await expect(readdir(busy)).resolves.toBeTruthy()
        await expect(lstat(checkoutLockPath(busyCanonical))).resolves.toBeTruthy()
      } finally {
        holder.release()
      }

      const third = randomUUID()
      const unmarked = await workspace.ensureWorkerWorkspace(workspaceRoot, third, instance)
      const unmarkedCanonical = canonicalCheckout(unmarked)
      await rm(join(unmarked, '.poise-workspace-owner'))
      expect(await workspace.discardUnclaimedWorkspace(workspaceRoot, unmarked, instance, {})).toBe('kept')
      await expect(readdir(unmarked)).resolves.toBeTruthy()
      await expect(lstat(checkoutLockPath(unmarkedCanonical))).resolves.toBeTruthy()

      expect(await workspace.discardUnclaimedWorkspace(workspaceRoot, workspaceRoot, instance, {})).toBe('kept')
      await expect(readdir(workspaceRoot)).resolves.toBeTruthy()
    } finally {
      log.mockRestore()
    }
  }, 30_000)

  it('runs the Manager outside the local agent-slot cap while its workers wait on questions', async () => {
    const manager = await runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'manager', deferStart: true })
    const workers: string[] = []
    for (let i = 0; i < 4; i++) {
      const child = await runtime.createChild(manager.id, { model: GROK_MODEL, title: `Worker ${i}` })
      workers.push(child.id)
      runtime.prompt(child.id, { text: `Task ${i}`, attachments: [], mentions: [] })
    }
    for (const id of workers) {
      await until(() => prompts.has(id))
      const asking = hosts.get(id)!.askQuestion({ questions: [{ id: 'q', question: 'Which target?', options: [], freeText: true, multiSelect: false }] })
      void asking.catch(() => undefined)
      await until(() => runtime.get(id)?.status === 'waiting')
    }
    runtime.prompt(manager.id, { text: 'Unblock the workers', attachments: [], mentions: [] })
    await until(() => (prompts.get(manager.id) ?? []).length === 1)
    await until(() => runtime.get(manager.id)?.status === 'running')
    expect(runtime.get(manager.id)?.queuedBehind).not.toBe('waiting for a free agent slot')
    const other = await runtime.create({ agent: 'grok', model: GROK_MODEL, title: 'Ordinary C', deferStart: true })
    runtime.prompt(other.id, { text: 'Ordinary work', attachments: [], mentions: [] })
    await until(() => runtime.get(other.id)?.status === 'queued')
    expect(runtime.get(other.id)?.queuedBehind).toBe('waiting for a free agent slot')
    finishes.get(manager.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(manager.id)?.status === 'idle')
    for (const id of workers) {
      await runtime.cancel(id)
      await until(() => runtime.get(id)?.status === 'idle')
    }
    await runtime.cancel(other.id)
    await until(() => runtime.get(other.id)?.status === 'idle')
    const source = await runtime.create({ agent: 'muse', model: MUSE_MODEL, title: 'Source A', deferStart: true })
    await runtime.resume(source.id)
    const forked = await runtime.fork(source.id)
    runtime.prompt(source.id, { text: 'Source work', attachments: [], mentions: [] })
    await until(() => prompts.has(source.id))
    runtime.prompt(forked.id, { text: 'Fork work', attachments: [], mentions: [] })
    await until(() => runtime.get(forked.id)?.status === 'queued')
    expect(runtime.get(forked.id)?.queuedBehind).not.toContain('Manager')
    expect(runtime.get(source.id)?.status).toBe('running')
  }, 60_000)

  it('keeps the Manager through reset, refuses fork and hand-off before any side effect, and frees the singleton on delete', async () => {
    servers = [{ id: 'github', name: 'github', title: 'GitHub', transport: 'stdio', command: 'github-mcp' }]
    const manager = await runtime.create({ agent: 'muse', model: MUSE_MODEL, role: 'manager' })
    const ordinary = await runtime.create({ agent: 'muse', model: MUSE_MODEL, title: 'Ordinary' })
    await until(() => starts.has(manager.id) && starts.has(ordinary.id))
    expect(starts.get(manager.id)![0]).toEqual(expect.objectContaining({ mcpServers: servers }))
    expect(starts.get(ordinary.id)![0]).toEqual(expect.objectContaining({ mcpServers: servers }))
    await runtime.reset(manager.id)
    expect(runtime.get(manager.id)?.role).toBe('manager')
    const before = runtime.list().length
    const forked = runtime.fork(manager.id).then(() => null, error => error)
    await expect(forked).resolves.toMatchObject({ statusCode: 409, code: 'unsupported', message: 'The Manager cannot be forked; start a new chat instead.' })
    const handed = runtime.handoff(manager.id, { agent: 'grok', model: GROK_MODEL }).then(() => null, error => error)
    await expect(handed).resolves.toMatchObject({ statusCode: 409, code: 'unsupported', message: 'The Manager cannot be handed off; change its model instead.' })
    expect(forkCalls).toBe(0)
    expect(runtime.list()).toHaveLength(before)
    const worker = await runtime.createChild(manager.id, { model: MUSE_MODEL, title: 'Kept worker' })
    await runtime.delete(manager.id)
    expect(storage.managerSession(instance)).toBeNull()
    const again = await postSessions({ agent: 'grok', model: GROK_MODEL, role: 'manager' }, true)
    expect(again.status).toBe(201)
    expect((await again.json()).session.role).toBe('manager')
    expect(runtime.get(worker.id)).not.toBeNull()
  }, 60_000)

  it('holds a Manager whose model retired until set_model clears it', async () => {
    const manager = await runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'manager', deferStart: true })
    const ordinary = await runtime.create({ agent: 'grok', model: GROK_MODEL, title: 'Ordinary', deferStart: true })
    await runtime.enqueue(manager.id, randomUUID(), { text: 'Queued task', attachments: [], mentions: [] }, OPUS_MODEL)
    database.db.prepare('UPDATE chat_message_queue_state SET ready = 1 WHERE session_id = ?').run(manager.id)
    store.message(instance, manager.id, ordinary.id, 'Hello Manager', `send:${ordinary.id}:held`)
    catalog = { ...CATALOG, models: CATALOG.models.filter(m => m.identity !== GROK_MODEL) }
    await runtime.recover()
    expect(runtime.get(manager.id)?.retiredModel).toBe(GROK_MODEL)
    expect(storage.getSession(manager.id)?.retiredModel).toBe(GROK_MODEL)
    const errors = () => runtime.events(manager.id, 0).events.filter(e => e.event.type === 'error')
    expect(errors()).toHaveLength(1)
    expect(errors()[0].event).toMatchObject({ recoverable: true,
      message: `The Manager's model ${GROK_MODEL} was retired. Choose another model to continue.` })
    await runtime.recover()
    expect(errors()).toHaveLength(1)
    for (let i = 0; i < 3; i++) {
      await control.tick()
      await new Promise(done => setTimeout(done, 10))
    }
    expect(prompts.has(manager.id)).toBe(false)
    expect(store.inbox(instance, manager.id).find(m => m.body === 'Hello Manager')?.state).toBe('pending')
    expect(() => runtime.prompt(manager.id, { text: 'task', attachments: [], mentions: [] }))
      .toThrow(expect.objectContaining({ statusCode: 409, code: 'invalid' }))
    expect(() => runtime.prompt(manager.id, { text: `/model ${OPUS_MODEL} task`, attachments: [], mentions: [] }))
      .toThrow(`The Manager's model ${GROK_MODEL} was retired. Choose another model to continue.`)
    await runtime.setModel(manager.id, OPUS_MODEL)
    expect(runtime.get(manager.id)?.retiredModel).toBeUndefined()
    await until(() => prompts.has(manager.id))
    finishes.get(manager.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(manager.id)?.status === 'idle')
    expect(() => runtime.prompt(manager.id, { text: 'next', attachments: [], mentions: [] })).not.toThrow()
    expect(runtime.get(ordinary.id)).toBeNull()
    expect(storage.getSession(ordinary.id)).toBeNull()
  }, 60_000)

  it('never auto-titles the Manager', async () => {
    const manager = await runtime.create({ agent: 'grok', model: GROK_MODEL, role: 'manager', deferStart: true })
    runtime.prompt(manager.id, { text: 'Please check every chat', attachments: [], mentions: [] })
    await until(() => prompts.has(manager.id))
    expect(runtime.get(manager.id)?.title).toBe('Manager')
  }, 30_000)
})
