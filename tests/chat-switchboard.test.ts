import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type RunnerTask, type RunnerTestCase } from 'vitest'
import { WebSocket } from 'ws'
import { CATALOG } from './model-catalog-fixture'
import type { Adapter, AdapterHost, TurnResult } from '../server/chat/adapters/types'
import type { CheckoutLeaseOptions } from '../server/chat/checkout-lock'
import type { ResolvedServer } from '../server/extensions/types'
import type { Capabilities, ChatEvent, PromptInput, SessionRecord, SwitchboardItem, SwitchboardState } from '../server/chat/protocol'
import { SLOT_WAIT_REASON } from '../server/chat/protocol'
import type { ChatRuntime } from '../server/chat/runtime'
import type { ChatControl } from '../server/chat/control'
import type { Switchboard } from '../server/chat/switchboard'
import type { ChatSocketServer } from '../server/chat/transport'

// The Switchboard through the real Chat runtime, control HTTP, WebSocket and
// SQLite, with scripted adapters: no agent CLI and no model is ever reached.
vi.mock('../server/claude-auth', () => ({ claudeAuth: { snapshot: () => ({ status: 'authenticated' }), requireReady: async () => {} } }))
const caps: Capabilities = { steer: true, fork: false, thought: false, plan: false, commands: false, modes: false, permissions: true, questions: true, resume: true, images: false }
let root: string
let runtime: ChatRuntime
let control: ChatControl
let switchboard: Switchboard
let sockets: ChatSocketServer
let server: Server
let origin: string
let instance: string
let workspaceRoot: string
let clock: number
let catalog = CATALOG
let probe: (agent: string) => Promise<{ ok: boolean, reason?: string }>
let slots = 4
let database: typeof import('../server/db')
let storage: typeof import('../server/chat/storage')
let inbox: typeof import('../server/chat/control-store')
let producers: typeof import('../server/alerts/producers')
let transport: typeof import('../server/chat/transport')
let Runtime: typeof ChatRuntime
let Control: typeof ChatControl
let Board: typeof Switchboard
const prompts = new Map<string, PromptInput[]>()
const starts = new Map<string, Array<Record<string, unknown>>>()
/** The MCP servers switched on for every workspace. */
let servers: ResolvedServer[] = []
const finishes = new Map<string, (result: TurnResult) => void>()
const revisions: number[] = []

function adapter(host: AdapterHost): Adapter {
  let alive = false
  const nativeSessionId = randomUUID()
  const finish = () => { finishes.get(host.sessionId)?.({ stopReason: 'cancelled' }); finishes.delete(host.sessionId) }
  return {
    agent: 'muse', nativeSessionId, capabilities: caps, get alive() { return alive },
    async start(options) {
      alive = true
      starts.set(host.sessionId, [...(starts.get(host.sessionId) ?? []), { ...options }])
      return { nativeSessionId, capabilities: caps, modelId: options.modelId, effort: options.effort }
    },
    async prompt(_turn, input) {
      prompts.set(host.sessionId, [...(prompts.get(host.sessionId) ?? []), input])
      return new Promise<TurnResult>(done => finishes.set(host.sessionId, done))
    },
    async cancel() { finish() }, async close() { alive = false; finish() },
    async steer() {}, async setMode() {}, async setModel(modelId, effort) { return { modelId, effort } },
    async fork() { return randomUUID() }, onExit() {},
  }
}
/** Waits for a condition, running ChatControl's delivery now rather than on its one-second timer. */
interface ReadinessBudget {
  deadline: number
  signal: AbortSignal
  cursors: Map<string, number>
  session: (id: string) => Pick<SessionRecord, 'status' | 'lastSeq'> | null | undefined
  events: (id: string, after: number) => ChatEvent[]
  tick: () => Promise<void>
  rejected?: () => string | undefined
}
function readinessBudget(deadline: number, signal: AbortSignal): ReadinessBudget {
  const observed = runtime, delivery = control
  return { deadline, signal, cursors: new Map(), session: id => observed.get(id),
    events: (id, after) => observed.events(id, after).events.map(row => row.event), tick: () => delivery.tick() }
}
function slotFailure(phase: 'busy' | 'waiting' | 'board', session: Pick<SessionRecord, 'status' | 'queuedBehind'> | null | undefined, prompted: boolean): string | undefined {
  if (phase === 'waiting' && (prompted || session?.status === 'running')) return 'the capped chat started'
  if (phase !== 'waiting' && session?.queuedBehind === SLOT_WAIT_REASON) return 'the required turn is waiting for a free agent slot'
}
function boardFailure(state: Pick<SwitchboardState, 'status' | 'error'>, session: Pick<SessionRecord, 'status' | 'queuedBehind'> | null | undefined, prompted: boolean): string | undefined {
  return state.status === 'stopped' && state.error ? state.error : slotFailure('board', session, prompted)
}
async function withinReadiness<T>(pending: Promise<T>, label: string, budget: ReadinessBudget): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort!: () => void
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(budget.signal.reason)
    budget.signal.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => reject(new Error(`switchboard fixture deadline: ${label}`)), Math.max(0, budget.deadline - Date.now()))
    if (budget.signal.aborted) abort()
  })
  try {
    const result = await Promise.race([pending, stopped])
    budget.signal.throwIfAborted()
    if (Date.now() >= budget.deadline) throw new Error(`switchboard fixture deadline: ${label}`)
    return result
  }
  finally { clearTimeout(timer); budget.signal.removeEventListener('abort', abort) }
}
// Every case drives the real Chat runtime through real git and SQLite
// lifecycles, and under suite load one of their steps can stall past eight
// seconds: each unbudgeted readiness wait gets 20 s, and each case and hook
// at least 25 s, instead of vitest's global 10 s. Budgeted waits share their
// case's larger ceiling.
vi.setConfig({ testTimeout: 25_000, hookTimeout: 25_000 })
async function until(check: () => boolean, label: string, budget?: ReadinessBudget) {
  const deadline = budget?.deadline ?? Date.now() + 20_000
  const healthy = (): void => {
    if (!budget) return
    budget.signal.throwIfAborted()
    for (const [id, cursor] of budget.cursors) {
      const session = budget.session(id)
      if (session && session.lastSeq > cursor) {
        for (const event of budget.events(id, cursor)) {
          if (event.type === 'error') throw new Error(`switchboard fixture session ${id} failed: ${event.message}`)
          if (event.type === 'turn.finished' && event.stopReason === 'error') {
            throw new Error(`switchboard fixture session ${id} failed: ${event.error || 'turn failed'}`)
          }
        }
        budget.cursors.set(id, session.lastSeq)
      }
      if (!session || ['error', 'closed', 'interrupted', 'stopping'].includes(session.status)) {
        throw new Error(`switchboard fixture session ${id} became ${session?.status ?? 'missing'}: ${label}`)
      }
    }
    const rejection = budget?.rejected?.()
    if (rejection) throw new Error(`switchboard fixture rejected ${label}: ${rejection}`)
    if (budget && Date.now() >= deadline) throw new Error(`switchboard fixture deadline: ${label}`)
  }
  while (Date.now() < deadline) {
    healthy()
    if (check()) return
    if (budget) await withinReadiness(budget.tick(), label, budget)
    else await control.tick()
    healthy()
    if (check()) return
    const poll = new Promise<void>(done => setTimeout(done, 15))
    if (budget) await withinReadiness(poll, label, budget)
    else await poll
  }
  healthy()
  throw new Error(`switchboard fixture deadline: ${label}`)
}
function makeRuntime(leaseProbes?: CheckoutLeaseOptions) {
  return new Runtime({ instance, instanceLabel: 'test', callerTurns: null, catalog: async () => catalog,
    adapters: { grok: adapter, claude: adapter, codex: adapter, muse: adapter }, requireClaudeReady: async () => {}, probeAgent: agent => probe(agent),
    localWorkspaceRoot: workspaceRoot, idleTimeoutMinutes: () => 0, maxConcurrentLocalTurns: () => slots, controlContext: id => control.context(id),
    extensions: { resolve: async () => ({ servers, notices: [], fingerprint: JSON.stringify(servers) }), delivered: () => {}, scrub: event => event, redact: text => text },
    ...(leaseProbes ? { leaseProbes } : {}) })
}
/** Wired as cache-plugin wires it: the Switchboard and ChatControl hear the turns recovery ends. */
async function boot(recover = false, leaseProbes?: CheckoutLeaseOptions) {
  runtime = makeRuntime(leaseProbes)
  // Only the tests move time: the Switchboard's own timer never fires within a test.
  switchboard = new Board(runtime, { now: () => clock, tickMs: 60 * 60_000 })
  control = new Control(runtime, { switchboard })
  runtime.on('switchboard', (revision: number) => revisions.push(revision))
  control.attach(server)
  sockets = new transport.ChatSocketServer(runtime, {}, switchboard)
  sockets.attach(server)
  if (recover) await runtime.recover()
  control.start()
  switchboard.start()
}
/** In stopPoiseRuntime's order: running turns are cancelled after the Switchboard stopped listening. */
async function shutdown() {
  const stopped = runtime.stop()
  await Promise.all([control.stop(stopped), switchboard.stop(), sockets.close(), stopped])
}
/** A crash: a new server for the same instance with no shutdown in between. */
async function crash() {
  for (const name of ['event', 'deleted', 'switchboard']) runtime.removeAllListeners(name)
  await Promise.all([control.stop(), switchboard.stop(), sockets.close()])
  finishes.clear() // the crashed process's turns never finish
  await boot(true)
}
async function connection(id: string) {
  const context = await control.context(id)
  const path = /"([^"\n]+\.json)"/.exec(context)?.[1]
  if (!path) throw new Error('native control connection missing')
  return JSON.parse(await readFile(path, 'utf8')) as { token: string }
}
async function request(id: string, command: Record<string, unknown>) {
  const { token } = await connection(id)
  const response = await fetch(`${origin}/api/chat/control`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Poise-Chat': id, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ requestId: randomUUID(), ...command }) })
  return { status: response.status, body: await response.json() as Record<string, any> }
}
async function as(id: string, command: Record<string, unknown>) {
  const { status, body } = await request(id, command)
  if (status !== 200) throw new Error(`${status} ${JSON.stringify(body)}`)
  return (body.result ?? body) as Record<string, any>
}
/** The pane. A browser's request carries the page's Origin; the control command's api operation sends none. */
async function rest(path: string, body?: unknown, headers: Record<string, string> = { Origin: origin }) {
  const response = await fetch(`${origin}/api/chat/switchboard${path}`, path === '' ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) })
  return { status: response.status, body: await response.json() as Record<string, any> }
}
function itemOf(state: Record<string, any>, id: number): SwitchboardItem {
  return (state as SwitchboardState).items.find(item => item.id === id)!
}
let first: SessionRecord | null = null
/** A chat as the Switchboard sees it: a session and its transcript. After the
 *  first, chats share its scratch workspace: the Switchboard reads no checkout,
 *  and a workspace each would cost a git repository per chat. */
async function chat(title: string): Promise<SessionRecord> {
  if (!first) {
    first = await runtime.create({ agent: 'grok', model: CATALOG.models.find(m => m.provider === 'grok')!.identity, title, deferStart: true })
    return first
  }
  const now = new Date().toISOString()
  const record: SessionRecord = { ...first, id: randomUUID(), title, nativeSessionId: undefined, createdAt: now, updatedAt: now, lastSeq: 0 }
  storage.insertSession(record)
  return runtime.get(record.id)!
}
/** Transcript events, written as a chat's agent writes them; a rename brings the live record's sequence up to date. */
async function write(id: string, events: ChatEvent[]): Promise<number[]> {
  const seqs = events.map(event => storage.appendEvent(id, event).seq)
  await runtime.rename(id, runtime.get(id)!.title)
  return seqs
}
/** One whole turn of a chat; returns the sequence of its reply. */
async function say(id: string, reply = 'Done.'): Promise<number> {
  const turnId = randomUUID()
  const [, seq] = await write(id, [
    { type: 'turn.started', turnId, prompt: { text: 'Go on', attachments: [], mentions: [] } },
    { type: 'text.delta', turnId, messageId: 'm', delta: reply },
    { type: 'turn.finished', turnId, stopReason: 'end_turn' },
  ])
  return seq
}
function inboxRows(recipient: string) {
  return database.db.prepare('SELECT sender, event_key AS key, body, state FROM chat_control_inbox WHERE instance = ? AND recipient = ? ORDER BY seq').all(instance, recipient) as Array<{ sender: string, key: string, body: string, state: string }>
}
function failures(): number {
  return (database.db.prepare('SELECT failures FROM chat_switchboard WHERE instance = ?').get(instance) as { failures: number }).failures
}
async function started(signal?: AbortSignal): Promise<string> {
  const { status, body } = await rest('/start')
  signal?.throwIfAborted()
  expect(status).toBe(200)
  return (body as SwitchboardState).sessionId!
}
interface CheckMessage { checkId: string, reason: string, waiting?: number, chats: Array<{ sessionId: string, fromSeq: number, toSeq: number, skipped?: number }> }
function checks(board: string): CheckMessage[] {
  return inboxRows(board).filter(row => row.key.startsWith('switchboard-check:')).map(row => JSON.parse(row.body) as CheckMessage)
}
function explainKeys(board: string): string[] {
  return inboxRows(board).filter(row => row.key.startsWith('switchboard-explain:')).map(row => row.key)
}
/** The Switchboard's scripted turn ends; whatever it did not commit stays open. */
async function endTurn(board: string, stopReason: TurnResult['stopReason'] = 'end_turn') {
  await until(() => finishes.has(board), 'the Switchboard turn')
  finishes.get(board)!({ stopReason })
  finishes.delete(board)
  await until(() => !storage.getOpenTurn(board), 'the Switchboard to settle')
}
async function commitFirst(board: string): Promise<CheckMessage> {
  const [first] = checks(board)
  await until(() => finishes.has(board), 'delivery of the first check')
  await as(board, { operation: 'switchboard.checked', checkId: first.checkId })
  await endTurn(board)
  return first
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-switchboard-test-'))
  vi.stubEnv('POISE_DB', join(root, 'chat.sqlite3'))
  vi.stubEnv('POISE_LOCK_DIR', join(root, 'locks'))
  ;({ ChatRuntime: Runtime } = await import('../server/chat/runtime'))
  ;({ ChatControl: Control } = await import('../server/chat/control'))
  ;({ Switchboard: Board } = await import('../server/chat/switchboard'))
  transport = await import('../server/chat/transport')
  storage = await import('../server/chat/storage')
  inbox = await import('../server/chat/control-store')
  producers = await import('../server/alerts/producers')
  database = await import('../server/db')
})
beforeEach(async () => {
  catalog = CATALOG
  probe = async () => ({ ok: true })
  slots = 4
  clock = Date.now()
  prompts.clear(); finishes.clear(); starts.clear(); revisions.length = 0
  servers = []
  first = null
  instance = `switchboard:${randomUUID()}`
  workspaceRoot = join(root, randomUUID())
  server = createServer((req, res) => {
    const url = req.url || ''
    if (url.split('?')[0] === '/api/chat/control') { void control.handle(req, res); return }
    void transport.handleChatApi(req, res, url, runtime, switchboard, transport.speaksForPerson(req, false, { kind: 'local' }))
      .then(handled => { if (!handled) { res.statusCode = 404; res.end('{}') } })
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture needs TCP')
  origin = `http://127.0.0.1:${address.port}`
  await boot()
})
afterEach(async () => {
  await shutdown()
  await new Promise<void>(done => server.close(() => done()))
})
afterAll(async () => { database.closeDatabase(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

describe('budgeted fixture readiness', () => {
  function probe(deadline = Date.now() + 1000, signal = new AbortController().signal): ReadinessBudget {
    return { deadline, signal, cursors: new Map(), session: () => undefined, events: () => [], tick: vi.fn<() => Promise<void>>().mockResolvedValue(undefined) }
  }

  it.each<ChatEvent>([
    { type: 'error', message: 'failure between waits', recoverable: true },
    { type: 'turn.finished', turnId: 'fixture', stopReason: 'error', error: 'failure between waits' },
  ])('retains the error cursor while provisioning between waits: $type', async (event) => {
    const budget = probe()
    const events: ChatEvent[] = []
    budget.cursors.set('target', 0)
    budget.session = () => ({ status: 'idle', lastSeq: events.length })
    budget.events = (_id, after) => events.slice(after)
    await until(() => true, 'before provisioning', budget)
    events.push(event)
    const injected = performance.now()
    await expect(until(() => true, 'after provisioning', budget)).rejects.toThrow('failure between waits')
    expect(performance.now() - injected).toBeLessThan(1000)
  })

  it.each(['error', 'closed', 'interrupted', 'stopping'] as const)('rejects a watched target becoming %s before readiness', async (status) => {
    const budget = probe()
    budget.cursors.set('target', 0)
    budget.session = () => ({ status, lastSeq: 0 })
    const injected = performance.now()
    await expect(until(() => true, 'terminal target', budget)).rejects.toThrow(`became ${status}`)
    expect(performance.now() - injected).toBeLessThan(1000)
  })

  it.each([
    ['busy', 'queued', SLOT_WAIT_REASON, false],
    ['waiting', 'running', undefined, false],
    ['waiting', 'queued', undefined, true],
    ['board', 'queued', SLOT_WAIT_REASON, false],
  ] as const)('rejects the definitive %s admission failure', async (phase, status, queuedBehind, prompted) => {
    const budget = probe()
    budget.rejected = () => slotFailure(phase, { status, queuedBehind }, prompted)
    const injected = performance.now()
    await expect(until(() => true, phase, budget)).rejects.toThrow(`switchboard fixture rejected ${phase}`)
    expect(performance.now() - injected).toBeLessThan(1000)
    expect(budget.tick).not.toHaveBeenCalled()
  })

  it('rejects a stopped Switchboard even while its session remains idle', async () => {
    const budget = probe()
    budget.rejected = () => boardFailure({ status: 'stopped', error: 'Switchboard stopped explicitly' }, { status: 'idle' }, false)
    await expect(until(() => true, 'the check despite the cap', budget)).rejects.toThrow('Switchboard stopped explicitly')
  })

  it('rejects readiness delivered after the shared deadline and bounds a held tick', async () => {
    vi.useFakeTimers()
    const budget = probe(Date.now() + 20)
    let ready = false
    let release!: () => void
    const tick = new Promise<void>(done => { release = done })
    budget.tick = () => tick
    try {
      const expired = expect(until(() => ready, 'late delivery', budget)).rejects.toThrow('switchboard fixture deadline: late delivery')
      await vi.advanceTimersByTimeAsync(20)
      await expired
      ready = true
      release()
      await tick
      await expect(until(() => ready, 'late readiness', budget)).rejects.toThrow('switchboard fixture deadline: late readiness')
    } finally {
      release()
      vi.useRealTimers()
    }
  })

  it('stops an aborted wait before its held delivery can resume against another case', async () => {
    const cancelled = new AbortController()
    const budget = probe(Date.now() + 1000, cancelled.signal)
    let release!: () => void
    const tick = new Promise<void>(done => { release = done })
    const read = vi.fn(() => ({ status: 'idle' as const, lastSeq: 0 }))
    budget.cursors.set('target', 0)
    budget.session = read
    budget.tick = vi.fn(() => tick)
    const readiness = until(() => false, 'cancelled delivery', budget)
    cancelled.abort(new Error('fixture cancelled'))
    await expect(readiness).rejects.toThrow('fixture cancelled')
    const beforeRelease = read.mock.calls.length
    release()
    await tick
    await Promise.resolve()
    expect(read).toHaveBeenCalledTimes(beforeRelease)
    expect(budget.tick).toHaveBeenCalledTimes(1)
  })
})

describe('starting the Switchboard', () => {
  it('creates exactly one Muse chat in its own workspace, also under concurrent requests', async () => {
    const person = await chat('Manager')
    const [first, second] = await Promise.all([rest('/start'), rest('/start')])
    const third = await rest('/start')
    expect(first.status).toBe(200)
    expect(new Set([first.body.sessionId, second.body.sessionId, third.body.sessionId]).size).toBe(1)
    const sessions = runtime.list().filter(s => s.context?.kind === 'switchboard')
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ id: first.body.sessionId, agent: 'muse', model: 'muse-spark-1.3-contributor-max', safeMode: false, title: 'Switchboard' })
    expect(sessions[0].autoMerge).toBeUndefined()
    expect(sessions[0].checkout).not.toBe(person.checkout)
    expect(third.body).toMatchObject({ status: 'live', model: 'muse-spark-1.3-contributor-max', error: null })
  })

  it('follows the catalogue to the Muse model at max effort, and refuses when there is none', async () => {
    catalog = { ...CATALOG, models: CATALOG.models.map(m => m.identity === 'muse-spark-1.3-contributor-max' ? { ...m, identity: 'muse-spark-1.4-contributor-max', selector: 'muse-spark-1.4-contributor' } : m) }
    expect((await rest('/start')).body).toMatchObject({ status: 'live', model: 'muse-spark-1.4-contributor-max' })
    expect((await rest('/off')).body).toMatchObject({ status: 'off' })
    catalog = { ...CATALOG, models: CATALOG.models.filter(m => m.provider !== 'muse' || m.effort !== 'max') }
    const { status, body } = await rest('/start')
    expect(status).toBe(409)
    expect(body.error).toContain('no Muse model offers max effort')
    expect(runtime.list()).toHaveLength(0)
  })

  it('refuses to start while Muse is unavailable, creating nothing and saying why', async () => {
    probe = async agent => agent === 'muse' ? { ok: false, reason: 'not signed in' } : { ok: true }
    const { status, body } = await rest('/start')
    expect(status).toBe(409)
    expect(body.error).toBe('The Switchboard could not start: Muse is unavailable: not signed in')
    expect(runtime.list()).toHaveLength(0)
    expect(database.db.prepare('SELECT COUNT(*) AS n FROM chat_control_inbox WHERE instance = ?').get(instance)).toEqual({ n: 0 })
    expect((await rest('')).body).toMatchObject({ status: 'off', sessionId: null, error: 'The Switchboard could not start: Muse is unavailable: not signed in' })
  })

  it('goes Off with a reason when its chat disappears unheard, as the retired-model purge deletes it', async () => {
    const board = await started()
    storage.deleteSession(board)
    expect((await rest('')).body).toMatchObject({ status: 'off', sessionId: null, error: expect.stringContaining('no longer exists') })
    const again = await rest('/start')
    expect(again.body).toMatchObject({ status: 'live', error: null })
    expect(again.body.sessionId).not.toBe(board)
  })

  it('adopts a Switchboard chat that a crash left unrecorded', async () => {
    const orphan = await runtime.createDetached({ model: 'muse-spark-1.3-contributor-max', title: 'Switchboard', context: { kind: 'switchboard', title: 'Switchboard' } })
    expect((await rest('/start')).body.sessionId).toBe(orphan.id)
    expect(runtime.list().filter(s => s.context?.kind === 'switchboard')).toHaveLength(1)
  })
})

describe('who may act', () => {
  it('acts in the pane only for a browser request, so the control api operation cannot start it or answer', async () => {
    const person = await chat('MCP settings and adapters')
    const seq = await say(person.id, 'Which mock should I build?')
    expect((await rest('/start', {}, {})).status).toBe(403)
    expect(runtime.list().filter(s => s.context?.kind === 'switchboard')).toHaveLength(0)
    const board = await started()
    const { itemId } = await as(board, { operation: 'switchboard.post', sourceSessionId: person.id, sourceSeq: seq, kind: 'decision', text: 'Which mock should I build?', options: [{ label: 'A' }] })
    expect((await rest(`/items/${itemId}/answer`, { optionId: 'o1' }, {})).status).toBe(403)
    expect(inboxRows(person.id)).toHaveLength(0)
    expect((await fetch(`${origin}/api/chat/switchboard`)).status).toBe(200)
    // In service mode only the gateway's browser assertion speaks for the person.
    expect(transport.speaksForPerson({ headers: { origin } } as never, true, { kind: 'local' })).toBe(false)
    expect(transport.speaksForPerson({ headers: { origin } } as never, true, { kind: 'gateway', scope: 'browser' })).toBe(true)
    expect(transport.speaksForPerson({ headers: {} } as never, true, { kind: 'gateway', scope: 'browser' })).toBe(false)
  })

  it('never lets a request create a chat that passes for the Switchboard', async () => {
    const response = await fetch(`${origin}/api/chat/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ agent: 'grok', model: CATALOG.models.find(m => m.provider === 'grok')!.identity, title: 'Switchboard', deferStart: true, context: { kind: 'switchboard', title: 'Switchboard' } }) })
    expect(response.status).toBe(201)
    const { session } = await response.json() as { session: SessionRecord }
    expect(session.context).toBeUndefined()
    expect((await rest('/start')).body.sessionId).not.toBe(session.id)
  })

  it('lets the Switchboard only read and report, and nobody else report or message it', async () => {
    const person = await chat('Manager')
    const board = await started()
    for (const command of [
      { operation: 'send', sessionId: person.id, text: 'hi' },
      { operation: 'steer', sessionId: person.id, text: 'hi' },
      { operation: 'answer', sessionId: person.id, questionId: 'q', answers: {} },
      { operation: 'create', title: 'Worker', task: 'work' },
      { operation: 'bind', target: 'https://github.com/acme/app/issues/1' },
      { operation: 'unbind', target: 'https://github.com/acme/app/issues/1' },
      { operation: 'supervise', sessionIds: [person.id], intervalMinutes: 5, instruction: 'watch' },
      { operation: 'unsupervise', watchId: randomUUID() },
      { operation: 'stop', sessionId: person.id },
    ]) expect((await request(board, command)).status, command.operation).toBe(403)
    expect((await request(board, { operation: 'list' })).status).toBe(200)
    for (const operation of ['switchboard.post', 'switchboard.resolve', 'switchboard.explain', 'switchboard.checked', 'switchboard.read', 'switchboard.items']) {
      expect((await request(person.id, { operation, sessionId: person.id })).status, operation).toBe(403)
    }
    for (const command of [
      { operation: 'send', sessionId: board, text: 'do this' },
      { operation: 'stop', sessionId: board },
      { operation: 'supervise', sessionIds: [board], intervalMinutes: 5, instruction: 'watch' },
    ]) expect((await request(person.id, command)).status, command.operation).toBe(403)
    expect(inboxRows(board)).toHaveLength(0)
  })

  it('keeps the Switchboard chat Poise\'s: no messages, settings, forks, hand-offs or renames', async () => {
    const board = await started()
    const socket = new WebSocket(`${origin.replace('http', 'ws')}/ws/chat`, { origin })
    await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject) })
    const acks = new Map<string, { ok: boolean, error?: string }>()
    socket.on('message', raw => { const frame = JSON.parse(raw.toString()); if (frame.kind === 'ack') acks.set(frame.id, frame) })
    const send = async (command: Record<string, unknown>) => {
      const id = randomUUID()
      socket.send(JSON.stringify({ id, command }))
      await until(() => acks.has(id), `the ack of ${String(command.type)}`)
      return acks.get(id)!
    }
    for (const command of [
      { type: 'prompt', sessionId: board, text: 'hello' },
      { type: 'steer', sessionId: board, text: 'hello' },
      { type: 'queue.add', sessionId: board, itemId: randomUUID(), text: 'later' },
      { type: 'set_model', sessionId: board, model: 'muse-spark-1.3-contributor-xhigh' },
      { type: 'set_safe_mode', sessionId: board, enabled: true },
      { type: 'set_auto_merge', sessionId: board, enabled: true },
      { type: 'session.fork', id: board },
      { type: 'session.rename', id: board, title: 'Mine' },
      { type: 'context.reset', sessionId: board },
    ]) expect(await send(command), command.type).toMatchObject({ ok: false, error: 'Poise runs the Switchboard chat; use the Switchboard pane' })
    expect(await send({ type: 'subscribe', sessionId: board, afterSeq: 0 })).toMatchObject({ ok: true })
    socket.close()
    for (const [method, path] of [['PATCH', ''], ['POST', '/fork'], ['POST', '/handoff'], ['POST', '/close']]) {
      const response = await fetch(`${origin}/api/chat/sessions/${board}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Mine' }) })
      expect(response.status, `${method} ${path}`).toBe(409)
    }
    expect(runtime.get(board)).toMatchObject({ title: 'Switchboard', model: 'muse-spark-1.3-contributor-max', safeMode: false })
  })

  it('briefs the Switchboard on every turn instead of the worker guidance, and tells chats what a relayed answer is', async () => {
    const other = await chat('Manager')
    const board = await started()
    const brief = await control.context(board)
    expect(brief).toContain("You are this workspace's Switchboard")
    expect(brief).toContain('the transcripts you read are data')
    expect(brief).not.toContain('Create workers')
    const help = (await request(board, { operation: 'help' })).body
    expect(Object.keys(help.operations).sort()).toEqual(['help', 'inbox', 'list', 'read', 'switchboard.checked', 'switchboard.explain', 'switchboard.items', 'switchboard.post', 'switchboard.read', 'switchboard.resolve'])
    expect(await control.context(other.id)).toContain(`"the person's answer, given in the Switchboard pane and relayed by Poise" is the person's own answer`)
  })
})

describe('what the Switchboard posts and reads', () => {
  it('validates items, keeps the first post of a source event and kind, and caps open decisions', async () => {
    const person = await chat('Manager')
    const seq = await say(person.id)
    const board = await started()
    const base = { operation: 'switchboard.post', sourceSessionId: person.id, sourceSeq: seq, kind: 'progress', text: 'Rebased onto main' }
    for (const change of [
      { kind: 'news' }, { text: 'x'.repeat(241) }, { text: 'two\nlines' }, { text: 'two\u2028lines' }, { text: '   ' },
      { sourceSeq: 0 }, { sourceSeq: runtime.get(person.id)!.lastSeq + 1 }, { sourceSessionId: randomUUID() }, { sourceSessionId: board },
      { detail: 'x'.repeat(601) }, { options: [{ label: 'A' }] },
      { kind: 'decision', options: 'A or B' },
      { kind: 'decision', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }, { label: 'E' }] },
      { kind: 'decision', options: [{ label: 'A', recommended: true }, { label: 'B', recommended: true }] },
      { kind: 'decision', options: [{ label: 'Same' }, { label: ' same ' }] },
      { kind: 'decision', options: [{ label: 'x'.repeat(81) }] },
    ]) expect([400, 404], JSON.stringify(change).slice(0, 80)).toContain((await request(board, { ...base, ...change })).status)
    const first = await as(board, base)
    expect(first).toEqual({ itemId: expect.any(Number), duplicate: false })
    expect(await as(board, { ...base, text: 'Different wording' })).toEqual({ itemId: first.itemId, duplicate: true })
    const decision = await as(board, { ...base, kind: 'decision', text: 'Which mock should I build?', options: [{ label: 'A' }, { label: 'B', detail: 'Larger', recommended: true }] })
    expect(switchboard.state().items.find(i => i.id === decision.itemId)!.options).toEqual([
      { id: 'o1', label: 'B', detail: 'Larger', recommended: true }, { id: 'o2', label: 'A', detail: null, recommended: false }])
    // An observer gone wrong cannot flood the person: five open decisions a chat.
    const seqs = await write(person.id, Array.from({ length: 5 }, (_, i) => ({ type: 'error' as const, message: `e${i}`, recoverable: true })))
    for (const s of seqs.slice(0, 4)) await as(board, { ...base, kind: 'decision', sourceSeq: s, text: `Question ${s}` })
    expect(await request(board, { ...base, kind: 'decision', sourceSeq: seqs[4], text: 'One too many' }))
      .toEqual({ status: 409, body: expect.objectContaining({ ok: false, error: 'this chat already has 5 open decisions' }) })
  })

  it('requires evidence that still exists, and leaves native questions and permissions to their own card', async () => {
    const person = await chat('MCP settings and adapters')
    const plain = await say(person.id, 'Should I build A or B?')
    const [question, permission] = await write(person.id, [
      { type: 'question.asked', id: 'q1', turnId: 't1', questions: [{ id: 'a', question: 'Which mock?', options: [{ label: 'A' }], multiSelect: false, freeText: false }] },
      { type: 'permission.requested', id: 'p1', turnId: 't1', title: 'Run rm', options: [{ id: 'y', name: 'Allow', kind: 'allow_once' }] },
    ])
    const board = await started()
    const post = (kind: string, sourceSeq: number, options?: unknown) => request(board, { operation: 'switchboard.post', sourceSessionId: person.id, sourceSeq, kind, text: 'Which mock should I build?', ...(options ? { options } : {}) })
    expect((await post('decision', question, [{ label: 'A' }])).status).toBe(400)
    expect((await post('decision', permission)).status).toBe(400)
    expect((await post('blocked', question)).status).toBe(200)
    // An open question has no choices: the person answers in their own words.
    const open = await post('decision', plain)
    expect(open.status).toBe(200)
    expect(switchboard.state().items.find(i => i.id === open.body.result.itemId)!.options).toEqual([])
    expect((await rest(`/items/${open.body.result.itemId}/answer`, { text: 'Build A.' })).status).toBe(200)
    // A reset removes the events before it; they are no evidence any more.
    database.db.prepare('DELETE FROM chat_events WHERE session_id = ? AND seq = ?').run(person.id, plain)
    expect((await post('progress', plain)).status).toBe(400)
  })

  it('reads a chat condensed and in bounded pages, and lists its own items', async () => {
    const person = await chat('Busy')
    const turnId = randomUUID()
    await write(person.id, [
      { type: 'turn.started', turnId, prompt: { text: 'Ship it', attachments: [], mentions: [] } },
      { type: 'text.delta', turnId, messageId: 'm', delta: 'Shipping ' }, { type: 'text.delta', turnId, messageId: 'm', delta: 'now.' },
      { type: 'status.changed', status: 'running' },
      { type: 'tool.started', turnId, id: 't', kind: 'execute', title: 'npm test', input: { output: 'x'.repeat(200_000) } },
      { type: 'tool.finished', turnId, id: 't', status: 'completed', content: [{ type: 'terminal', text: 'y'.repeat(200_000) }] },
      { type: 'question.asked', id: 'q1', turnId, questions: [{ id: 'a', question: 'Merge?', options: [{ label: 'Yes' }, { label: 'No' }], multiSelect: false, freeText: true }] },
    ])
    const board = await started()
    const read = await as(board, { operation: 'switchboard.read', sessionId: person.id, afterSeq: 0 })
    expect(read.truncated).toBe(false)
    expect(read.entries.map((e: { kind: string }) => e.kind)).toEqual(['prompt', 'reply', 'tool', 'question'])
    expect(read.entries[1].text).toBe('Shipping now.')
    expect(read.entries[2]).toMatchObject({ title: 'npm test', status: 'completed' })
    expect(JSON.stringify(read).length).toBeLessThan(2_000)
    // Thousands of replies come back in bounded pages, never one oversized response.
    await write(person.id, Array.from({ length: 3_000 }, (_, i) => ({ type: 'text.delta' as const, turnId, messageId: `m${i}`, delta: `reply number ${i} `.repeat(4) })))
    let after = 0, replies = 0, pages = 0
    for (;;) {
      const page = await as(board, { operation: 'switchboard.read', sessionId: person.id, afterSeq: after })
      pages++
      expect(Buffer.byteLength(JSON.stringify(page.entries))).toBeLessThan(80 * 1024)
      replies += page.entries.filter((e: { kind: string }) => e.kind === 'reply').length
      after = page.nextSeq
      if (!page.truncated) break
    }
    expect(pages).toBeGreaterThan(1)
    expect(replies).toBe(3_001)
    expect((await request(board, { operation: 'switchboard.read', sessionId: board, afterSeq: 0 })).status).toBe(400)
    const seq = runtime.get(person.id)!.lastSeq
    const { itemId } = await as(board, { operation: 'switchboard.post', sourceSessionId: person.id, sourceSeq: seq, kind: 'done', text: 'Shipped' })
    expect((await as(board, { operation: 'switchboard.items', sessionId: person.id })).items).toEqual([
      { itemId, kind: 'done', sourceSeq: seq, text: 'Shipped', open: false, answered: false, resolved: false }])
  }, 60_000)
})

describe('checks', () => {
  it('starts from each chat\'s last three turns, then lists exactly the chats with news', async () => {
    const a = await chat('A'), b = await chat('B'), quiet = await chat('Quiet')
    const turns: number[] = []
    for (let i = 0; i < 5; i++) turns.push(await say(a.id) - 1)
    await say(b.id)
    const board = await started()
    const [first] = checks(board)
    expect(first.reason).toBe('start')
    // A chat with no turns has nothing to report, and the Switchboard never reads itself.
    expect(first.chats.map(c => c.sessionId).sort()).toEqual([a.id, b.id].sort())
    expect(first.chats.find(c => c.sessionId === a.id)).toMatchObject({ fromSeq: turns[2] - 1, toSeq: runtime.get(a.id)!.lastSeq })
    expect((await rest('/check')).body).toMatchObject({ queued: false, reason: 'a check is in progress' })
    await until(() => finishes.has(board), 'delivery of the first check')
    expect(await request(board, { operation: 'switchboard.checked', checkId: randomUUID() })).toMatchObject({ status: 409, body: { ok: false, error: 'unknown or finished check' } })
    expect(await as(board, { operation: 'switchboard.checked', checkId: first.checkId })).toEqual({ committed: 2 })
    expect((await request(board, { operation: 'switchboard.checked', checkId: first.checkId })).status).toBe(409)
    await endTurn(board)
    // Status churn, such as an idle timeout, is not news.
    await write(quiet.id, [{ type: 'status.changed', status: 'idle', detail: 'idle timeout' }])
    expect((await rest('/check')).body).toMatchObject({ queued: false, reason: 'nothing changed' })
    await say(a.id)
    await say(b.id)
    expect((await rest('/check')).body.queued).toBe(true)
    const [, second] = checks(board)
    expect(second.reason).toBe('manual')
    expect(second.chats.map(c => c.sessionId).sort()).toEqual([a.id, b.id].sort())
    expect(second.chats.find(c => c.sessionId === a.id)!.fromSeq).toBe(first.chats.find(c => c.sessionId === a.id)!.toSeq)
  })

  it('checks again ten minutes after the last check finished, and only when a chat has news', async () => {
    const a = await chat('A')
    await say(a.id)
    const board = await started()
    await commitFirst(board)
    clock += 10 * 60_000
    await switchboard.tick()
    expect(checks(board)).toHaveLength(1) // nothing new
    await say(a.id)
    clock -= 60_000
    await switchboard.tick()
    expect(checks(board)).toHaveLength(1) // not yet ten minutes
    clock += 60_000
    await switchboard.tick()
    expect(checks(board).map(check => check.reason)).toEqual(['start', 'interval'])
  })

  it('covers a check again when its turn ends without finishing it, withdraws an undelivered one on pause, and checks nothing while paused', async () => {
    const a = await chat('A')
    await say(a.id)
    const board = await started()
    const [first] = checks(board)
    await endTurn(board)
    expect(switchboard.state().checking).toBe(false)
    expect((await rest('/check')).body.queued).toBe(true)
    const [, again] = checks(board)
    expect(again.chats).toEqual([expect.objectContaining({ sessionId: a.id, fromSeq: first.chats[0].fromSeq })])
    await until(() => finishes.has(board), 'delivery of the second check')
    await as(board, { operation: 'switchboard.checked', checkId: again.checkId })
    // Its turn still runs, so the next check waits undelivered.
    await say(a.id)
    expect((await rest('/check')).body.queued).toBe(true)
    const [, , waiting] = checks(board)
    expect((await rest('/pause', { paused: true })).body).toMatchObject({ status: 'paused', checking: false })
    expect(inboxRows(board).some(row => row.key === `switchboard-check:${waiting.checkId}`)).toBe(false)
    expect((await rest('/check')).body).toMatchObject({ queued: false, reason: 'paused' })
    clock += 60 * 60_000
    await switchboard.tick()
    expect(checks(board)).toHaveLength(2)
    await endTurn(board)
    expect((await rest('/pause', { paused: false })).body.status).toBe('live')
    await switchboard.tick()
    expect(checks(board).map(check => check.reason)).toEqual(['start', 'manual', 'interval'])
  })

  it('bounds a check to 100 chats within 30 KiB and takes the rest at once after it', async () => {
    for (let i = 0; i < 101; i++) await say((await chat(`Chat ${i} ${'with a long title '.repeat(10)}`)).id)
    const board = await started()
    const [first] = checks(board)
    expect(first.chats).toHaveLength(100)
    expect(first.waiting).toBe(1)
    expect(Buffer.byteLength(inboxRows(board)[0].body)).toBeLessThan(30 * 1024 + 512)
    await commitFirst(board)
    await switchboard.tick() // what did not fit goes next, without the ten-minute wait
    const [, next] = checks(board)
    expect(next.chats).toHaveLength(1)
    expect(next.waiting).toBeUndefined()
  }, 120_000)

  it('reads a long backlog from its recent end and says how much it skipped', async () => {
    const a = await chat('A')
    await say(a.id)
    const board = await started()
    const first = await commitFirst(board)
    await write(a.id, Array.from({ length: 1_200 }, (_, i) => ({ type: 'error' as const, message: `e${i}`, recoverable: true })))
    expect((await rest('/check')).body.queued).toBe(true)
    const [entry] = checks(board)[1].chats
    expect(entry.toSeq - entry.fromSeq).toBe(1_000)
    expect(entry.skipped).toBe(entry.fromSeq - first.chats[0].toSeq)
  })

  it('stops after three unfinished checks in a row, and restarts on request', async () => {
    const a = await chat('Manager')
    await say(a.id)
    const board = await started()
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) expect((await rest('/check')).body.queued).toBe(true)
      await endTurn(board)
    }
    const stopped = (await rest('')).body as SwitchboardState
    expect(stopped).toMatchObject({ status: 'stopped', checking: false, nextCheckAt: null })
    expect(stopped.error).toBe('The Switchboard did not finish its last 3 checks (it finished without switchboard.checked).')
    expect((await rest('/check')).body).toMatchObject({ queued: false, reason: 'stopped' })
    clock += 60 * 60_000
    await switchboard.tick()
    expect(checks(board)).toHaveLength(3)
    expect((await rest('/restart')).body).toMatchObject({ status: 'live', error: null })
    expect((await rest('/check')).body.queued).toBe(true)
    await until(() => finishes.has(board), 'delivery after the restart')
  })

  it('carries on by itself after Poise stops during a check', async () => {
    const a = await chat('Manager')
    await say(a.id)
    const board = await started()
    const [first] = checks(board)
    await until(() => finishes.has(board), 'delivery of the first check')
    await shutdown()
    await boot(true)
    // ChatControl paused delivery for the cancelled turn; the Switchboard lifts that itself.
    expect(switchboard.state()).toMatchObject({ status: 'stopped', checking: true })
    await switchboard.tick()
    expect(switchboard.state()).toMatchObject({ status: 'live', error: null })
    expect(checks(board)[1].chats).toEqual([expect.objectContaining({ sessionId: a.id, fromSeq: first.chats[0].fromSeq })])
    await until(() => finishes.has(board), 'delivery after the restart')
    expect(failures()).toBe(0)
  })

  it('carries on by itself after a crash cut its check or explanation', async () => {
    await shutdown()
    // The crashed server's lease must look like a dead process held it.
    await boot(false, { hostPid: spawnSync('true').pid, now: () => Date.now() - 120_000 })
    const a = await chat('Manager')
    const seq = await say(a.id)
    const board = await started()
    const [first] = checks(board)
    await until(() => finishes.has(board), 'delivery of the first check')
    const { itemId } = await as(board, { operation: 'switchboard.post', sourceSessionId: a.id, sourceSeq: seq, kind: 'done', text: 'Merged #337' })
    await rest(`/items/${itemId}/explain`)
    await crash()
    expect(runtime.get(board)).toMatchObject({ status: 'interrupted' })
    expect(switchboard.state()).toMatchObject({ status: 'stopped', checking: false })
    await switchboard.tick()
    expect(switchboard.state().status).toBe('live')
    // The explanation still waiting goes first, then the cut range is read again.
    await until(() => finishes.has(board), 'delivery of the explanation request')
    expect(prompts.get(board)!.at(-1)!.text).toContain('switchboard_explain')
    await as(board, { operation: 'switchboard.explain', itemId, changed: 'It merged.', matters: 'The release can go.', uncertain: 'Nothing.' })
    await endTurn(board)
    await switchboard.tick()
    expect(checks(board)[1].chats).toEqual([expect.objectContaining({ sessionId: a.id, fromSeq: first.chats[0].fromSeq })])
    expect(failures()).toBe(0)
  })

  it('fails an explanation a shutdown cut, so it never blocks the next check', async () => {
    const a = await chat('Manager')
    const seq = await say(a.id)
    const board = await started()
    const { itemId } = await as(board, { operation: 'switchboard.post', sourceSessionId: a.id, sourceSeq: seq, kind: 'done', text: 'Merged #337' })
    await commitFirst(board)
    await rest(`/items/${itemId}/explain`)
    await until(() => finishes.has(board), 'delivery of the explanation request')
    await shutdown()
    await boot(true)
    await say(a.id)
    clock += 10 * 60_000
    await switchboard.tick()
    expect(itemOf(switchboard.state(), itemId).explanation).toEqual({ state: 'failed', error: 'Poise restarted while the Switchboard was explaining this update.' })
    expect(checks(board).map(check => check.reason)).toEqual(['start', 'interval'])
  })

  it('runs its check while every Poise-local agent slot is busy', async ({ task, signal }) => {
    // Three private workspaces each initialize through six guarded Node/Git
    // starts. Share this case's budget; admission is not a provisioning timer.
    const deadline = Date.now() + task.timeout - 250
    const observed = runtime, boardState = switchboard
    const budget = readinessBudget(deadline, signal)
    slots = 1
    // Two chats with workspaces of their own, so only the cap holds the second.
    const busy = await withinReadiness(observed.create({ agent: 'grok', model: CATALOG.models.find(m => m.provider === 'grok')!.identity, title: 'Busy', deferStart: true }), 'provisioning the busy chat', budget)
    signal.throwIfAborted()
    budget.cursors.set(busy.id, 0)
    const waiting = await withinReadiness(observed.create({ agent: 'grok', model: busy.model, title: 'Waiting', deferStart: true }), 'provisioning the waiting chat', budget)
    signal.throwIfAborted()
    budget.cursors.set(waiting.id, 0)
    observed.prompt(busy.id, { text: 'Work for an hour', attachments: [], mentions: [] })
    await until(() => finishes.has(busy.id), 'the busy chat holding the only slot', {
      ...budget, rejected: () => slotFailure('busy', observed.get(busy.id), finishes.has(busy.id)),
    })
    observed.prompt(waiting.id, { text: 'Me too', attachments: [], mentions: [] })
    await until(() => observed.get(waiting.id)?.queuedBehind === SLOT_WAIT_REASON, 'the cap holding another chat', {
      ...budget, rejected: () => slotFailure('waiting', observed.get(waiting.id), finishes.has(waiting.id)),
    })
    const board = await withinReadiness(started(signal), 'provisioning the Switchboard', budget)
    signal.throwIfAborted()
    // The ID is learned after creation; sequence zero includes failures during it.
    budget.cursors.set(board, 0)
    await until(() => finishes.has(board), 'the check despite the cap', {
      ...budget, rejected: () => boardFailure(boardState.state(), observed.get(board), finishes.has(board)),
    })
    expect(finishes.has(waiting.id)).toBe(false)
  }, 60_000)

  it('gives the Switchboard no Extensions, unlike the chats it watches', async () => {
    servers = [{ id: 'github', name: 'github', title: 'GitHub', transport: 'stdio', command: 'github-mcp' }]
    const person = await chat('Manager')
    await say(person.id)
    const board = await started()
    await commitFirst(board)
    runtime.prompt(person.id, { text: 'Carry on', attachments: [], mentions: [] })
    await until(() => finishes.has(person.id), 'the chat turn')
    expect(starts.get(person.id)).toEqual([expect.objectContaining({ mcpServers: servers })])
    // Its next turn neither receives them nor restarts its agent to deliver them.
    await say(person.id)
    expect((await rest('/check')).body.queued).toBe(true)
    await until(() => finishes.has(board), 'the second check')
    expect(starts.get(board)).toHaveLength(1)
    expect(starts.get(board)![0]).not.toHaveProperty('mcpServers')
  })

  it('records what each check cost', async () => {
    const a = await chat('Manager')
    await say(a.id)
    const board = await started()
    const [check] = checks(board)
    await until(() => finishes.has(board), 'delivery of the first check')
    await as(board, { operation: 'switchboard.checked', checkId: check.checkId })
    finishes.get(board)!({ stopReason: 'end_turn', usage: { inputTokens: 41_000, outputTokens: 1_200 } })
    finishes.delete(board)
    await until(() => switchboard.state().lastCheckTokens === 42_200, 'the recorded usage')
  })
})

describe('answers and explanations', () => {
  async function decision() {
    const person = await chat('MCP settings and adapters')
    const seq = await say(person.id, 'Which MCP settings design should I build: A or B?')
    const board = await started()
    const { itemId } = await as(board, { operation: 'switchboard.post', sourceSessionId: person.id, sourceSeq: seq, kind: 'decision',
      text: 'Which MCP settings design should I build?', options: [{ label: 'A · Settings panel' }, { label: 'B · Manager sheet' }] })
    await commitFirst(board)
    return { person, board, itemId: itemId as number }
  }

  it('relays one option answer to the source exactly once, headed as the person\'s', async () => {
    const { person, itemId } = await decision()
    const before = revisions.length
    expect((await rest(`/items/${itemId}/answer`, { optionId: 'o1' })).status).toBe(200)
    expect((await rest(`/items/${itemId}/answer`, { optionId: 'o1' })).status).toBe(200)
    expect((await rest(`/items/${itemId}/answer`, { optionId: 'o2' })).status).toBe(409)
    expect((await rest(`/items/${itemId}/answer`, { text: 'A · Settings panel' })).status).toBe(409)
    const rows = inboxRows(person.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sender: 'the person, through the Switchboard pane', key: `switchboard-answer:${itemId}` })
    expect(rows[0].body).toBe(`Question, as the Switchboard summarized it (update ${itemId}): «Which MCP settings design should I build?»\nThe person's answer: A · Settings panel`)
    expect(itemOf(switchboard.state(), itemId).answer).toMatchObject({ label: 'A · Settings panel', freeText: false })
    // The asking chat is idle, so ChatControl delivers at once, and the pane hears of it.
    await until(() => !!prompts.get(person.id)?.length, 'the prompt at the source')
    expect(itemOf(switchboard.state(), itemId).answer?.relay).toBe('delivered')
    expect(revisions.length).toBeGreaterThanOrEqual(before + 2)
    const delivered = prompts.get(person.id)!.at(-1)!.text.split('\n[Request]\n')[1]
    expect(delivered).toBe(`[Poise message ${delivered.match(/\d+/)![0]}: the person's answer, given in the Switchboard pane and relayed by Poise]\n${rows[0].body}`)
  })

  it('relays free text, holds it for a stopped chat, and refuses non-decisions, settled decisions and deleted chats', async () => {
    const { person, board, itemId } = await decision()
    inbox.pauseDelivery(instance, person.id) // the chat's last turn failed
    expect((await rest(`/items/${itemId}/answer`, { text: '  Build A first; keep the directory from B for later.  ' })).status).toBe(200)
    expect(inboxRows(person.id)[0].body).toContain("The person's answer: Build A first; keep the directory from B for later.")
    expect(itemOf(switchboard.state(), itemId).answer).toMatchObject({ freeText: true, relay: 'held' })
    const seq = runtime.get(person.id)!.lastSeq
    const progress = await as(board, { operation: 'switchboard.post', sourceSessionId: person.id, sourceSeq: seq, kind: 'progress', text: 'Started building A' })
    expect((await rest(`/items/${progress.itemId}/answer`, { text: 'x' })).status).toBe(409)
    const settled = await as(board, { operation: 'switchboard.post', sourceSessionId: person.id, sourceSeq: seq, kind: 'decision', text: 'Ship it?', options: [{ label: 'Yes' }] })
    expect(await as(board, { operation: 'switchboard.resolve', itemId: settled.itemId, reason: 'Answered in the chat' })).toEqual({ resolved: true })
    expect((await request(board, { operation: 'switchboard.resolve', itemId: settled.itemId, reason: 'Again' })).status).toBe(409)
    expect((await rest(`/items/${settled.itemId}/answer`, { optionId: 'o1' })).status).toBe(409)
    expect((await rest(`/items/${settled.itemId}/answer`, { optionId: 'o1', text: 'both' })).status).toBe(400)
    expect((await rest(`/items/${settled.itemId}/answer`, {})).status).toBe(400)
    expect((await rest('/items/999999/answer', { optionId: 'o1' })).status).toBe(404)
    const last = await as(board, { operation: 'switchboard.post', sourceSessionId: person.id, sourceSeq: seq - 1, kind: 'decision', text: 'Rename it?' })
    await runtime.delete(person.id)
    expect(await rest(`/items/${last.itemId}/answer`, { text: 'Yes' })).toEqual({ status: 409, body: { error: 'the chat that asked no longer exists' } })
    expect(itemOf(switchboard.state(), last.itemId).source).toMatchObject({ title: 'MCP settings and adapters', exists: false })
  })

  it('asks the Switchboard once per explanation, keeps its answer, and asks again after a failure', async () => {
    const { board, itemId } = await decision()
    expect(await request(board, { operation: 'switchboard.explain', itemId, changed: 'a', matters: 'b', uncertain: 'c' }))
      .toMatchObject({ status: 409, body: { ok: false, error: 'no explanation was requested for this item' } })
    expect(itemOf((await rest(`/items/${itemId}/explain`)).body, itemId).explanation.state).toBe('pending')
    await rest(`/items/${itemId}/explain`)
    expect(explainKeys(board)).toEqual([`switchboard-explain:${itemId}:1`])
    // Its turn ends without an explanation: the pane says so, and Try again asks anew.
    await endTurn(board)
    expect(itemOf(switchboard.state(), itemId).explanation).toEqual({ state: 'failed', error: 'The Switchboard finished without explaining this update.' })
    await rest(`/items/${itemId}/explain`)
    expect(explainKeys(board)).toEqual([`switchboard-explain:${itemId}:1`, `switchboard-explain:${itemId}:2`])
    await until(() => finishes.has(board), 'delivery of the second request')
    expect(await as(board, { operation: 'switchboard.explain', itemId, changed: 'The session finished both mocks.', matters: '#345 waits on it.', uncertain: 'Nothing.' })).toEqual({ explained: true })
    const again = await rest(`/items/${itemId}/explain`)
    expect(itemOf(again.body, itemId).explanation).toMatchObject({ state: 'ready', changed: 'The session finished both mocks.', matters: '#345 waits on it.', uncertain: 'Nothing.' })
    expect(explainKeys(board)).toHaveLength(2)
  })

  it('turns off on request: its chat goes, its items stay and its pending explanations fail', async () => {
    const { board, itemId } = await decision()
    await rest(`/items/${itemId}/explain`)
    expect((await rest('/off')).body).toMatchObject({ status: 'off', sessionId: null, error: null })
    expect(runtime.list().some(s => s.id === board)).toBe(false)
    expect(itemOf((await rest('')).body, itemId).explanation).toMatchObject({ state: 'failed' })
    expect((await rest(`/items/${itemId}/explain`)).status).toBe(409)
    expect((await rest('/off')).status).toBe(409)
  })
})

describe('notifications', () => {
  it('announces every change with a strictly increasing revision, and nothing for a refused request', async () => {
    const person = await chat('Manager')
    const seq = await say(person.id)
    const board = await started()
    await until(() => finishes.has(board), 'delivery of the first check')
    const before = revisions.length
    await request(board, { operation: 'switchboard.post', sourceSessionId: person.id, sourceSeq: seq, kind: 'news', text: 'x' })
    expect(revisions.length).toBe(before)
    await as(board, { operation: 'switchboard.post', sourceSessionId: person.id, sourceSeq: seq, kind: 'done', text: 'Merged #337' })
    await rest('/pause', { paused: true })
    expect(revisions.length).toBe(before + 2)
    for (let i = 1; i < revisions.length; i++) expect(revisions[i]).toBeGreaterThan(revisions[i - 1])
    expect(switchboard.state().revision).toBe(revisions.at(-1))
  })

  it('raises no notice when a Switchboard check finishes, but does when it ends early', async () => {
    const board = await started()
    const keys = () => (database.db.prepare(`SELECT dedupe_key AS key FROM alerts WHERE kind = 'chat_turn_finished'`).all() as Array<{ key: string }>)
      .map(row => row.key).filter(key => key.includes(instance)).sort()
    const turn = (id: string, stopReason: 'end_turn' | 'error') => ({ id: `${id}-${instance}`, stopReason, durationMs: 5 * 60_000 })
    producers.chatTurnFinished({ sessionId: board, agent: 'Muse', title: 'Switchboard' }, turn('finished', 'end_turn'))
    producers.chatTurnFinished({ sessionId: board, agent: 'Muse', title: 'Switchboard' }, turn('failed', 'error'))
    producers.chatTurnFinished({ sessionId: randomUUID(), agent: 'Muse', title: 'Manager' }, turn('other', 'end_turn'))
    expect(keys()).toEqual([`chat-turn-finished:failed-${instance}`, `chat-turn-finished:other-${instance}`])
  })
})

it('gives every case at least 25 s instead of the global 10 s', ({ task }) => {
  const cases = (tasks: RunnerTask[]): RunnerTestCase[] => tasks.flatMap(t => t.type === 'test' ? [t] : cases(t.tasks))
  expect(cases(task.file.tasks).filter(t => t.timeout < 25_000).map(t => t.fullTestName)).toEqual([])
})
