import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { CATALOG } from './model-catalog-fixture'
import type { Adapter, AdapterHost, TurnResult } from '../server/chat/adapters/types'
import type { Capabilities, ChatEnvelope, ChatEvent, PromptInput } from '../server/chat/protocol'
import type { ChatRuntime } from '../server/chat/runtime'
import type { ChatControl, CiObservation } from '../server/chat/control'
import type { ChatSocketServer } from '../server/chat/transport'
import type { ResolvedServer } from '../server/extensions/types'

vi.mock('../server/claude-auth', () => ({ claudeAuth: { snapshot: () => ({ status: 'authenticated' }), requireReady: async () => {} } }))

const executeFile = promisify(execFile)
const caps: Capabilities = { steer: true, fork: false, thought: false, plan: false, commands: false, modes: false, permissions: true, questions: true, resume: true, images: false }
const GROK_MODEL = (() => {
  const model = CATALOG.models.find(m => m.provider === 'grok')
  if (!model) throw new Error('fixture lacks grok')
  return model.identity
})()
const WAKE_MESSAGE = 'Scheduled wake-up. Review the workspace according to your charter: list the chats, read your inbox, look at chats that are waiting or failed, and check work you are bound to. If nothing needs action, end your turn in one line.'

let root: string
let matchFile: string
let runtime: ChatRuntime
let control: ChatControl
let sockets: ChatSocketServer
let server: Server
let origin: string
let port: number
let ws: WebSocket | null = null
let clock: number
let instance: string
let workspaceRoot: string
let store: typeof import('../server/chat/control-store')
let database: typeof import('../server/db')
let Runtime: typeof ChatRuntime
let Control: typeof ChatControl
let transportModule: typeof import('../server/chat/transport')
let logging: typeof import('../server/logging')
let servers: ResolvedServer[] = []
const prompts = new Map<string, PromptInput[]>()
const finishes = new Map<string, (result: TurnResult) => void>()
const seen = new Map<string, ChatEvent[]>()
const ci = vi.fn<() => Promise<CiObservation>>()

function scripted(host: AdapterHost): Adapter {
  let alive = false
  const nativeSessionId = randomUUID()
  const finish = () => { finishes.get(host.sessionId)?.({ stopReason: 'cancelled' }); finishes.delete(host.sessionId) }
  return {
    agent: 'grok', nativeSessionId, capabilities: caps, get alive() { return alive },
    async start(options) {
      alive = true
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
const adapter = (host: AdapterHost) => scripted(host)

async function until(check: () => boolean) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) { if (check()) return; await new Promise(done => setTimeout(done, 15)) }
  throw new Error('wake fixture readiness deadline')
}
function watch(target: ChatRuntime) {
  target.on('event', (envelope: ChatEnvelope) => {
    seen.set(envelope.sessionId, [...(seen.get(envelope.sessionId) ?? []), envelope.event])
  })
}
function makeRuntime() {
  const created = new Runtime({ instance, instanceLabel: 'test', callerTurns: null, catalog: async () => CATALOG,
    adapters: { grok: adapter, claude: adapter, codex: adapter, muse: adapter },
    requireClaudeReady: async () => {}, probeAgent: async () => ({ ok: true }),
    localWorkspaceRoot: workspaceRoot, idleTimeoutMinutes: () => 0, maxConcurrentLocalTurns: () => 4,
    controlContext: id => control.context(id), leaseProbes: {},
    extensions: { resolve: async () => ({ servers, notices: [], fingerprint: JSON.stringify(servers) }), delivered: () => {}, scrub: event => event, redact: text => text } })
  watch(created)
  return created
}
async function config(id: string) {
  const context = await control.context(id)
  const path = /"([^"\n]+\.json)"/.exec(context)?.[1]
  if (!path) throw new Error('native control connection missing')
  return { path, ...JSON.parse(await readFile(path, 'utf8')) as { token: string, sessionId: string, origin: string } }
}
/** The real native command against this test's server. Resolves stdout on exit 0; rejects with code/stderr otherwise. */
function api(connectionPath: string, input: Record<string, unknown>): Promise<{ stdout: string, stderr: string }> {
  return executeFile(process.execPath, [resolve('scripts/poise-chat-control.mjs'), connectionPath, JSON.stringify(input)])
}
/** The real control endpoint over HTTP: the Manager's path to cancelTimer and rearmTimer. */
async function command(id: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const context = await control.context(id)
  const path = /"([^"\n]+\.json)"/.exec(context)?.[1]
  if (!path) throw new Error('native control connection missing')
  const connection = JSON.parse(await readFile(path, 'utf8')) as { token: string }
  const response = await fetch(`${origin}/api/chat/control`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Poise-Chat': id, Authorization: `Bearer ${connection.token}` },
    body: JSON.stringify({ requestId: randomUUID(), ...input }) })
  const body = await response.json() as Record<string, unknown>
  if (!response.ok) throw new Error(JSON.stringify(body))
  return (body.result ?? body) as Record<string, unknown>
}
/** One real WebSocket command frame: the browser's path to chat.hold and the timer commands. */
async function wsCommand(commandInput: Record<string, unknown>): Promise<{ ok: boolean, result?: any, error?: string, code?: string }> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws/chat`)
    await new Promise<void>((resolve, reject) => {
      const fail = (error: unknown) => reject(error instanceof Error ? error : new Error(String(error)))
      ws!.once('error', fail)
      ws!.once('message', (data: Buffer) => {
        const frame = JSON.parse(String(data)) as { kind: string }
        if (frame.kind === 'hello') { ws!.off('error', fail); resolve() }
        else reject(new Error('expected hello'))
      })
    })
  }
  const id = randomUUID()
  return new Promise((resolve) => {
    const onMessage = (data: Buffer) => {
      const frame = JSON.parse(String(data)) as { kind: string, id?: string, ok?: boolean, result?: unknown, error?: string, code?: string }
      if (frame.kind === 'ack' && frame.id === id) { ws!.off('message', onMessage); resolve(frame as { ok: boolean, result?: any, error?: string, code?: string }) }
    }
    ws!.on('message', onMessage)
    ws!.send(JSON.stringify({ id, command: commandInput }))
  })
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-manager-wake-'))
  vi.stubEnv('POISE_DB', join(root, 'chat.sqlite3'))
  vi.stubEnv('POISE_LOCK_DIR', join(root, 'locks'))
  vi.stubEnv('POISE_ESPANSO_MATCH_DIR', join(root, 'match'))
  matchFile = join(root, 'match', 'poise.yml')
  ;({ ChatRuntime: Runtime } = await import('../server/chat/runtime'))
  ;({ ChatControl: Control } = await import('../server/chat/control'))
  store = await import('../server/chat/control-store')
  database = await import('../server/db')
  transportModule = await import('../server/chat/transport')
  logging = await import('../server/logging')
}, 60_000)
beforeEach(async () => {
  clock = Date.now()
  prompts.clear(); finishes.clear(); seen.clear()
  servers = []
  ci.mockReset().mockResolvedValue({ head: 'a'.repeat(40), failing: [] })
  database.db.prepare("DELETE FROM meta WHERE key IN ('chat_manager_wake', 'chat_manager_wake_failure')").run()
  database.setMeta('chat_custom_switches', '')
  database.db.prepare("DELETE FROM meta WHERE key LIKE 'chat_snippet_%'").run()
  await rm(join(root, 'match'), { recursive: true, force: true })
  await logging.stopLogging()
  await rm(join(root, 'logging.db'), { force: true })
  logging.startLogging()
  instance = `wake:${randomUUID()}`
  workspaceRoot = join(root, randomUUID())
  runtime = makeRuntime()
  control = new Control(runtime, { ci, now: () => clock })
  server = createServer((req, res) => {
    const url = req.url || ''
    if (url === '/api/chat/control') { void control.handle(req, res); return }
    const person = transportModule.speaksForPerson(req, false, { kind: 'local' })
    void transportModule.handleChatApi(req, res, url, runtime, undefined, person, control)
  })
  sockets = new transportModule.ChatSocketServer(runtime, {}, undefined, control)
  sockets.attach(server)
  control.attach(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture needs TCP')
  port = address.port
  origin = `http://127.0.0.1:${port}`
  control.start()
})
afterEach(async () => {
  ws?.terminate()
  ws = null
  await sockets?.close()
  await control?.stop()
  await runtime?.stop()
  await new Promise<void>(done => server.close(() => done()))
  await logging.stopLogging()
})
afterAll(async () => { database.closeDatabase(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

function postSessions(body: unknown, withOrigin: boolean) {
  return fetch(`${origin}/api/chat/sessions`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(withOrigin ? { Origin: origin } : {}) },
    body: JSON.stringify(body) })
}
async function createManagerViaBrowser(): Promise<{ id: string }> {
  const created = await postSessions({ agent: 'grok', model: GROK_MODEL, role: 'manager', deferStart: true }, true)
  expect(created.status).toBe(201)
  return (await created.json() as { session: { id: string } }).session
}
function getWake(withOrigin = true) {
  return fetch(`${origin}/api/chat/manager/wake`, { headers: withOrigin ? { Origin: origin } : {} })
}
function putWake(body: unknown, withOrigin = true, contentType = 'application/json') {
  return fetch(`${origin}/api/chat/manager/wake`, { method: 'PUT',
    headers: { 'Content-Type': contentType, ...(withOrigin ? { Origin: origin } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body) })
}
async function finishTurn(id: string, result: TurnResult = { stopReason: 'end_turn' }) {
  const finishedBefore = seen.get(id)?.filter(event => event.type === 'turn.finished').length ?? 0
  await until(() => finishes.has(id))
  finishes.get(id)!(result)
  finishes.delete(id)
  await until(() => (seen.get(id)?.filter(event => event.type === 'turn.finished').length ?? 0) > finishedBefore)
}
function timerNotes(id: string): Extract<ChatEvent, { type: 'timer.changed' }>[] {
  return runtime.events(id, 0).events.map(e => e.event).filter((e): e is Extract<ChatEvent, { type: 'timer.changed' }> => e.type === 'timer.changed')
}
function turnStarts(id: string): Extract<ChatEvent, { type: 'turn.started' }>[] {
  return runtime.events(id, 0).events.map(e => e.event).filter((e): e is Extract<ChatEvent, { type: 'turn.started' }> => e.type === 'turn.started')
}
function reported(operation: string) {
  logging.loggingRuntime()!.flush()
  const found: ReturnType<typeof logging.diagnosticPage>['events'] = []
  let cursor: string | null = null
  for (let guard = 0; guard < 5000; guard++) {
    const page = logging.diagnosticPage(cursor)
    found.push(...page.events.filter(e => e.operation === operation))
    if (!page.hasMore) return found
    cursor = page.cursor
  }
  throw new Error('diagnostic pages did not end')
}
function liveWakeRows() {
  return database.db.prepare("SELECT id, target, interval_ms, next_at, state, reason FROM chat_control_timers WHERE instance = ? AND system_key = 'manager-wake' AND state IN ('active','held','tripped')").all(instance) as
    Array<{ id: string, target: string, interval_ms: number, next_at: number | null, state: string, reason: string | null }>
}
async function wakeView() {
  const res = await getWake()
  expect(res.status).toBe(200)
  return await res.json() as { everyMinutes: number, revision: number,
    timer: { id: string, state: string, reason?: string, nextAt: string, waitingFor?: string } | null,
    pendingOn: string | null, lastFailure: { at: string, error: string } | null, wakesLast24h: number }
}

it('wakes a lone Manager on schedule with its charter and no GitHub reads', async () => {
  const manager = await createManagerViaBrowser()
  const t0 = clock

  const rows = liveWakeRows()
  expect(rows).toHaveLength(1)
  expect(rows[0].next_at).toBe(t0 + 60 * 60_000)
  expect(rows[0].target).toBe(manager.id)

  const before = await wakeView()
  expect(before.everyMinutes).toBe(60)
  expect(before.timer?.state).toBe('active')
  expect(before.timer?.nextAt).toBe(new Date(t0 + 60 * 60_000).toISOString())
  expect(before.wakesLast24h).toBe(0)

  clock += 60 * 60_000
  await control.tick()
  await until(() => (prompts.get(manager.id) ?? []).length === 1)
  const wakeStarts = turnStarts(manager.id).filter(start => start.source?.kind === 'timer')
  expect(wakeStarts).toHaveLength(1)
  expect(wakeStarts[0].source).toMatchObject({ kind: 'timer', label: 'Scheduled wake-up' })
  const text = prompts.get(manager.id)!.at(-1)!.text
  expect(text).toContain(WAKE_MESSAGE)
  expect(text).toContain('[Manager charter — the /manager snippet, revision 1')
  await finishTurn(manager.id)

  expect(liveWakeRows()[0].next_at).toBe(t0 + 120 * 60_000)
  expect((await wakeView()).wakesLast24h).toBe(1)
  expect(ci).not.toHaveBeenCalled()
  expect(runtime.list()).toHaveLength(1)

  const deleted = await fetch(`${origin}/api/chat/sessions/${manager.id}`, { method: 'DELETE', headers: { Origin: origin } })
  expect(deleted.status).toBe(200)
  expect((await wakeView()).timer).toBeNull()
}, 60_000)

it('keeps exactly one wake timer as the interval and the Manager change, and resolves a lost race to the winner', async () => {
  // No Manager: saving 15 creates no timer, and creating a Manager then
  // creates one with a 15-minute interval.
  const saved = await putWake({ everyMinutes: 15, revision: 0 })
  expect(saved.status).toBe(200)
  expect(liveWakeRows()).toHaveLength(0)
  const manager = await createManagerViaBrowser()
  const created = liveWakeRows()
  expect(created).toHaveLength(1)
  expect(created[0].interval_ms).toBe(15 * 60_000)
  expect(created[0].next_at).toBe(clock + 15 * 60_000)
  const firstId = created[0].id

  // Whitespace /manager: the next tick cancels the wake timer, and GET
  // reports no timer for the missing charter; restoring its text recreates
  // the timer on the next tick, one interval later.
  await writeFile(matchFile, 'matches:\n  - trigger: ;manager\n    replace: "   "\n')
  await control.tick()
  await until(() => liveWakeRows().length === 0)
  expect(liveWakeRows()).toHaveLength(0)
  const cancelled = database.db.prepare("SELECT state, reason FROM chat_control_timers WHERE id = ?").get(firstId) as { state: string, reason: string }
  expect(cancelled).toMatchObject({ state: 'cancelled', reason: 'no_charter' })
  const charterless = await wakeView()
  expect(charterless.timer).toBeNull()
  expect(charterless.pendingOn).toBe('charter')
  await writeFile(matchFile, 'matches:\n  - trigger: ;manager\n    replace: Restored charter\n')
  await control.tick()
  await until(() => liveWakeRows().length === 1)
  const restored = liveWakeRows()
  expect(restored).toHaveLength(1)
  expect(restored[0].next_at).toBe(clock + 15 * 60_000)

  // A /manager removed outside Poise is back within a tick, and the wake
  // timer keeps its ID and next_at.
  const keptId = restored[0].id
  const keptNext = restored[0].next_at
  await writeFile(matchFile, 'matches: []\n')
  await control.tick()
  await until(() => readFileSync(matchFile, 'utf8').includes(';manager'))
  const kept = liveWakeRows()
  expect(kept).toHaveLength(1)
  expect(kept[0].id).toBe(keptId)
  expect(kept[0].next_at).toBe(keptNext)
  expect(await readFile(matchFile, 'utf8')).toContain(';manager')

  // Saving 5 keeps the timer, retimes it in place, and notes one update.
  const view = await wakeView()
  const updatesBefore = timerNotes(manager.id).filter(note => note.change === 'updated').length
  const retimed = await putWake({ everyMinutes: 5, revision: view.revision })
  expect(retimed.status).toBe(200)
  const after = liveWakeRows()
  expect(after).toHaveLength(1)
  expect(after[0].id).toBe(keptId)
  expect(after[0].interval_ms).toBe(5 * 60_000)
  expect(timerNotes(manager.id).filter(note => note.change === 'updated')).toHaveLength(updatesBefore + 1)

  // Deleting the Manager ends its timer, and a new Manager gets a new one.
  const deleted = await fetch(`${origin}/api/chat/sessions/${manager.id}`, { method: 'DELETE', headers: { Origin: origin } })
  expect(deleted.status).toBe(200)
  const ended = database.db.prepare("SELECT state, reason FROM chat_control_timers WHERE id = ?").get(keptId) as { state: string, reason: string }
  expect(ended).toMatchObject({ state: 'done', reason: 'target_deleted' })
  const replacement = await createManagerViaBrowser()
  const renewed = liveWakeRows()
  expect(renewed).toHaveLength(1)
  expect(renewed[0].target).toBe(replacement.id)
  expect(renewed[0].id).not.toBe(keptId)

  // A live wake row pointed at a non-Manager chat is cancelled and recreated.
  const ordinary = await runtime.create({ agent: 'grok', model: GROK_MODEL, deferStart: true })
  database.db.prepare('UPDATE chat_control_timers SET target = ? WHERE id = ?').run(ordinary.id, renewed[0].id)
  await control.tick()
  await until(() => liveWakeRows().length === 1 && liveWakeRows()[0].target === replacement.id)
  const replaced = database.db.prepare("SELECT state, reason FROM chat_control_timers WHERE id = ?").get(renewed[0].id) as { state: string, reason: string }
  expect(replaced).toMatchObject({ state: 'cancelled', reason: 'manager_replaced' })
  const current = liveWakeRows()
  expect(current).toHaveLength(1)
  expect(current[0].target).toBe(replacement.id)

  // Two more syncs change nothing.
  const syncBefore = { ...current[0] }
  await control.syncManagerWake()
  await control.syncManagerWake()
  expect(liveWakeRows()).toEqual([syncBefore])

  // A lost unique race returns the winner: the trigger's competing row
  // survives, the save returns 200, and exactly one live row remains.
  database.db.prepare('DELETE FROM chat_control_timers WHERE id = ?').run(current[0].id)
  database.db.exec(`CREATE TEMP TRIGGER wake_race BEFORE INSERT ON chat_control_timers FOR EACH ROW
    WHEN NEW.system_key = 'manager-wake' BEGIN
      INSERT INTO chat_control_timers(id, instance, target, set_by_kind, label, message, kind, interval_ms, next_at, state, failures, skipped, created_at, updated_at, system_key)
      VALUES('competitor-row', NEW.instance, NEW.target, 'person', 'Scheduled wake-up', 'racing wake', 'every',
        NEW.interval_ms, NEW.next_at, 'active', 0, 0, NEW.created_at, NEW.updated_at, 'manager-wake');
    END`)
  try {
    const raced = await putWake({ everyMinutes: 10, revision: (await wakeView()).revision })
    expect(raced.status).toBe(200)
    expect(((await raced.json()) as { timer: { id: string } }).timer.id).toBe('competitor-row')
    expect(liveWakeRows()).toHaveLength(1)
    expect(liveWakeRows()[0].id).toBe('competitor-row')
  } finally {
    database.db.exec('DROP TRIGGER wake_race')
  }
}, 60_000)

it('applies a new interval at once, keeps a pending wake, and keeps waking through failures with a visible mark for each', async () => {
  const manager = await createManagerViaBrowser()
  const t0 = clock

  // A person turn runs while the wake comes due: the firing stays pending.
  runtime.prompt(manager.id, { text: 'Person question', attachments: [], mentions: [] })
  await until(() => finishes.has(manager.id))
  clock = t0 + 60 * 60_000
  await control.tick()
  const timerId = liveWakeRows()[0].id
  await until(() => !!store.timerPendingRow(instance, timerId))
  expect(prompts.get(manager.id)).toHaveLength(1)

  // Saving 5 at T0+61m retimes at once; the pending wake stays pending.
  clock = t0 + 61 * 60_000
  const pendingBefore = store.timerPendingRow(instance, timerId)!.seq
  const retimed = await putWake({ everyMinutes: 5, revision: (await wakeView()).revision })
  expect(retimed.status).toBe(200)
  expect(((await retimed.json()) as { timer: { nextAt: string } }).timer.nextAt).toBe(new Date(t0 + 66 * 60_000).toISOString())
  expect(store.timerPendingRow(instance, timerId)?.seq).toBe(pendingBefore)
  await finishTurn(manager.id)
  // The pending wake is admitted once the person turn ends.
  await control.tick()
  await until(() => (prompts.get(manager.id) ?? []).length === 2)
  await finishTurn(manager.id)

  // Five failing wake turns: no backoff, no trip, each due 5 minutes after
  // the last, each with its transcript note, warning and lastFailure.
  for (let n = 1; n <= 5; n++) {
    clock = t0 + (61 + n * 5) * 60_000
    const failuresBefore = timerNotes(manager.id).filter(note => note.change === 'failed').length
    const warningsBefore = reported('chat.timer.changed').filter(record => (record.context as { change?: string }).change === 'failed').length
    await control.tick()
    await until(() => (prompts.get(manager.id) ?? []).length === 2 + n)
    await finishTurn(manager.id, { stopReason: 'error', error: `wake boom ${n}` })
    const row = store.timerRow(instance, timerId)!
    expect(row.not_before).toBeNull()
    expect(row.state).toBe('active')
    expect(row.next_at).toBe(t0 + (66 + n * 5) * 60_000)
    const failed = timerNotes(manager.id).filter(note => note.change === 'failed')
    expect(failed).toHaveLength(failuresBefore + 1)
    expect(failed.at(-1)!.error).toContain(`wake boom ${n}`)
    const warnings = reported('chat.timer.changed').filter(record => (record.context as { change?: string }).change === 'failed')
    expect(warnings).toHaveLength(warningsBefore + 1)
    expect(warnings.at(-1)!.context).toMatchObject({ error: expect.stringContaining(`wake boom ${n}`) })
    expect((await wakeView()).lastFailure).toMatchObject({ error: expect.stringContaining(`wake boom ${n}`) })
  }

  // The successful wake at T0+91m clears the failure.
  clock = t0 + 91 * 60_000
  await control.tick()
  await until(() => (prompts.get(manager.id) ?? []).length === 8)
  await finishTurn(manager.id)
  expect((await wakeView()).lastFailure).toBeNull()

  // Saving 10 at T0+95m moves the next wake to T0+105m.
  clock = t0 + 95 * 60_000
  const moved = await putWake({ everyMinutes: 10, revision: (await wakeView()).revision })
  expect(moved.status).toBe(200)
  expect(((await moved.json()) as { timer: { nextAt: string } }).timer.nextAt).toBe(new Date(t0 + 105 * 60_000).toISOString())

  // A change during a hold is saved, and the wake stays held through the
  // person's next prompt; releasing ten minutes later keeps the new phase.
  expect((await wsCommand({ type: 'chat.hold', sessionId: manager.id, held: true })).ok).toBe(true)
  await control.tick()
  await until(() => store.timerById(instance, timerId)!.state === 'held')
  expect(store.timerById(instance, timerId)!.state).toBe('held')
  const heldChange = clock
  const heldSave = await putWake({ everyMinutes: 30, revision: (await wakeView()).revision })
  expect(heldSave.status).toBe(200)
  runtime.prompt(manager.id, { text: 'Person again', attachments: [], mentions: [] })
  await finishTurn(manager.id)
  await control.tick()
  expect(store.timerById(instance, timerId)!.state).toBe('held')
  clock = heldChange + 10 * 60_000
  expect((await wsCommand({ type: 'chat.hold', sessionId: manager.id, held: false })).ok).toBe(true)
  await control.tick()
  await until(() => store.timerById(instance, timerId)!.state === 'active')
  const released = await wakeView()
  expect(released.timer?.state).toBe('active')
  expect(released.timer?.nextAt).toBe(new Date(heldChange + 30 * 60_000).toISOString())
}, 120_000)

it('does not let the Manager or the timers panel cancel, re-arm or retime the scheduled wake-up', async () => {
  const manager = await createManagerViaBrowser()
  const timerId = liveWakeRows()[0].id

  // The Manager's own cancel and re-arm are refused: the person set the timer.
  const cancel = await command(manager.id, { operation: 'cancelTimer', timerId }).then(() => null, error => error as Error)
  expect(String(cancel)).toContain('only the person can change a timer the person set')
  const rearm = await command(manager.id, { operation: 'rearmTimer', timerId }).then(() => null, error => error as Error)
  expect(String(rearm)).toContain('only the person can change a timer the person set')
  expect(liveWakeRows()).toHaveLength(1)

  // The timers panel cannot cancel it either; the refusal names the off switch.
  const socketCancel = await wsCommand({ type: 'timer.cancel', timerId })
  expect(socketCancel.ok).toBe(false)
  expect(socketCancel.error).toBe('The scheduled wake-up cannot be cancelled. Hold the Manager to stop it.')
  expect(liveWakeRows()).toHaveLength(1)

  // A failed wake turn still leaves nothing to re-arm: the wake-up never trips.
  clock += 60 * 60_000
  await control.tick()
  await until(() => (prompts.get(manager.id) ?? []).length === 1)
  await finishTurn(manager.id, { stopReason: 'error', error: 'wake boom' })
  expect(store.timerById(instance, timerId)!.state).toBe('active')
  const socketRearm = await wsCommand({ type: 'timer.rearm', timerId })
  expect(socketRearm.ok).toBe(false)
  expect(socketRearm.error).toBe('only a tripped timer can be re-armed')

  // Nor can the Manager retime it through the control's api operation.
  const connection = await config(manager.id)
  const retime = await api(connection.path, { operation: 'api', path: '/api/chat/manager/wake', method: 'PUT',
    body: { everyMinutes: 5, revision: 0 } }).then(() => null, error => error as { code?: number, stderr?: string })
  expect(retime?.code).toBe(1)
  expect(String(retime?.stderr)).toContain('"status":403')
  expect(String(retime?.stderr)).toContain("The Manager's wake interval is changed in the browser.")
  expect((await wakeView()).everyMinutes).toBe(60)
}, 60_000)

it('refuses invalid or headerless wake interval writes and recovers an unreadable setting', async () => {
  // Without the browser's Origin, the interval cannot be changed.
  const headerless = await putWake({ everyMinutes: 30, revision: 0 }, false)
  expect(headerless.status).toBe(403)
  expect(await headerless.json()).toEqual({ error: "The Manager's wake interval is changed in the browser." })

  // Only the five intervals, and a matching revision, are accepted.
  for (const everyMinutes of [0, 20, 90, 1440, '60']) {
    const refused = await putWake({ everyMinutes, revision: 0 })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toEqual({ error: 'everyMinutes must be 5, 10, 15, 30 or 60' })
  }
  const missingRevision = await putWake({ everyMinutes: 30 })
  expect(missingRevision.status).toBe(400)
  expect(await missingRevision.json()).toEqual({ error: 'revision must be a non-negative integer' })
  const empty = await putWake('', true, 'application/json')
  expect(empty.status).toBe(400)

  const first = await putWake({ everyMinutes: 30, revision: 0 })
  expect(first.status).toBe(200)
  const stale = await putWake({ everyMinutes: 15, revision: 0 })
  expect(stale.status).toBe(409)
  expect(await stale.json()).toEqual({ error: 'The wake interval changed in another tab. Your choice has not replaced it.' })

  // A non-JSON body is refused before anything is read, and only GET and
  // PUT reach the route.
  const text = await putWake('everyMinutes=15', true, 'text/plain')
  expect(text.status).toBe(415)
  const posted = await fetch(`${origin}/api/chat/manager/wake`, { method: 'POST', headers: { Origin: origin } })
  expect(posted.status).toBe(405)
  expect(await posted.json()).toEqual({ error: 'Use GET or PUT for the Manager wake interval.' })

  // An identical save keeps its revision.
  const current = await wakeView()
  const same = await putWake({ everyMinutes: current.everyMinutes, revision: current.revision })
  expect(same.status).toBe(200)
  expect(((await same.json()) as { revision: number }).revision).toBe(current.revision)

  // The control's api operation sends no Origin, so it is refused as well.
  const chat = await runtime.create({ agent: 'grok', model: GROK_MODEL, deferStart: true })
  const connection = await config(chat.id)
  const steal = await api(connection.path, { operation: 'api', path: '/api/chat/manager/wake', method: 'PUT',
    body: { everyMinutes: 5, revision: current.revision } }).then(() => null, error => error as { code?: number, stderr?: string })
  expect(steal?.code).toBe(1)
  expect(String(steal?.stderr)).toContain('"status":403')
  expect(String(steal?.stderr)).toContain("The Manager's wake interval is changed in the browser.")

  // An unreadable setting reads 500, refuses any other revision, and is
  // replaced from revision 0 with revision 1.
  database.setMeta('chat_manager_wake', 'not json')
  const broken = await getWake()
  expect(broken.status).toBe(500)
  expect(await broken.json()).toEqual({ error: 'The Manager wake interval could not be read. Choose an interval to replace it.' })
  const wrongRepair = await putWake({ everyMinutes: 30, revision: 2 })
  expect(wrongRepair.status).toBe(500)
  const repaired = await putWake({ everyMinutes: 30, revision: 0 })
  expect(repaired.status).toBe(200)
  expect(((await repaired.json()) as { everyMinutes: number, revision: number }).revision).toBe(1)
  expect((await wakeView()).everyMinutes).toBe(30)
}, 60_000)

it('keeps the tick delivering when the wake setting is unreadable', async () => {
  const lines: string[] = []
  runtime.on('log', (line: string) => { lines.push(line) })
  database.setMeta('chat_manager_wake', 'not json')
  const chat = await runtime.create({ agent: 'grok', model: GROK_MODEL, deferStart: true })
  store.message(instance, chat.id, 'another-chat', 'Ordinary work')

  await control.tick()
  await control.tick()
  await control.tick()

  await until(() => (prompts.get(chat.id) ?? []).length === 1)
  expect(prompts.get(chat.id)!.at(-1)!.text).toContain('Ordinary work')
  expect(lines.filter(line => line.startsWith('[chat control] wake schedule sync failed:'))).toHaveLength(1)
  expect(reported('chat.manager.wake.sync_failed')).toHaveLength(1)
}, 60_000)

it('counts the wake timer apart from the timer slots', async () => {
  const manager = await createManagerViaBrowser()

  // Beside the wake timer, the Manager still sets five timers on itself;
  // the sixth is refused, so the caps still apply to ordinary timers.
  for (let n = 1; n <= 5; n++) {
    const created = await command(manager.id, { operation: 'timer', sessionId: manager.id,
      label: `Self ${n}`, message: 'Self check', delayMinutes: 10080 }) as { timer: { id: string } }
    expect(created.timer.id).toBeTruthy()
  }
  const sixth = await command(manager.id, { operation: 'timer', sessionId: manager.id,
    label: 'Self 6', message: 'Self check', delayMinutes: 10080 }).then(() => null, error => error as Error)
  expect(String(sixth)).toContain('this chat already has 5 timers')
  expect(liveWakeRows()).toHaveLength(1)

  // Two self-timer turns, then three wakes: only the wakes count.
  const selfTimers = store.timers(instance, manager.id, clock).filter(timer => !timer.system && timer.state === 'active')
  await command(manager.id, { operation: 'cancelTimer', timerId: selfTimers[0].id })
  const pulse = (await command(manager.id, { operation: 'timer', sessionId: manager.id,
    label: 'Pulse', message: 'Ping', everyMinutes: 5 }) as { timer: { id: string } }).timer
  for (let n = 1; n <= 2; n++) {
    clock += 5 * 60_000
    await control.tick()
    await until(() => turnStarts(manager.id).filter(start => start.source?.kind === 'timer'
      && (start.source as { timerId?: string }).timerId === pulse.id).length === n)
    await finishTurn(manager.id)
  }
  // The pulse's two admissions stay counted out; cancelling it leaves the
  // wake phase to the wake-up alone.
  await command(manager.id, { operation: 'cancelTimer', timerId: pulse.id })
  expect((await wakeView()).wakesLast24h).toBe(0)
  const revision = (await wakeView()).revision
  expect((await putWake({ everyMinutes: 5, revision })).status).toBe(200)
  const wakeId = liveWakeRows()[0].id
  const wakeStarts = () => turnStarts(manager.id).filter(start => start.source?.kind === 'timer'
    && (start.source as { timerId?: string }).timerId === wakeId).length
  for (let n = 1; n <= 3; n++) {
    clock += 5 * 60_000
    await control.tick()
    await until(() => wakeStarts() === n)
    await finishTurn(manager.id)
  }
  expect((await wakeView()).wakesLast24h).toBe(3)

  // With 100 live timers seeded in the instance, a new Manager still gets
  // its wake timer, while an ordinary chat-set timer is refused the slot.
  const deleted = await fetch(`${origin}/api/chat/sessions/${manager.id}`, { method: 'DELETE', headers: { Origin: origin } })
  expect(deleted.status).toBe(200)
  const seedTarget = await runtime.create({ agent: 'grok', model: GROK_MODEL, deferStart: true })
  const seed = database.db.prepare(`INSERT INTO chat_control_timers(id, instance, target, set_by_kind, set_by_session,
      label, message, kind, interval_ms, next_at, state, failures, skipped, created_at, updated_at)
    VALUES(?, ?, ?, 'chat', ?, 'Seed', 'Seeded', 'once', ?, ?, 'active', 0, 0, ?, ?)`)
  database.db.transaction(() => {
    for (let n = 0; n < 100; n++) {
      seed.run(randomUUID(), instance, seedTarget.id, seedTarget.id, 10080 * 60_000, clock + 10080 * 60_000, clock, clock)
    }
  })()
  const fresh = await createManagerViaBrowser()
  const renewed = liveWakeRows()
  expect(renewed).toHaveLength(1)
  expect(renewed[0].target).toBe(fresh.id)
  const capped = await command(fresh.id, { operation: 'timer', sessionId: fresh.id,
    label: 'Capped', message: 'No slot', delayMinutes: 60 }).then(() => null, error => error as Error)
  expect(String(capped)).toContain('this Poise instance already has 100 timers')
}, 120_000)

it('records a diagnostic only when the wake interval changes', async () => {
  const revision = (await wakeView()).revision
  const saved = await putWake({ everyMinutes: 15, revision })
  expect(saved.status).toBe(200)
  const records = reported('chat.manager.wake.saved')
  expect(records).toHaveLength(1)
  expect(records[0].context).toMatchObject({ everyMinutes: 15, revision: revision + 1 })

  const identical = await putWake({ everyMinutes: 15, revision: revision + 1 })
  expect(identical.status).toBe(200)
  const invalid = await putWake({ everyMinutes: 20, revision: revision + 1 })
  expect(invalid.status).toBe(400)
  const conflict = await putWake({ everyMinutes: 30, revision })
  expect(conflict.status).toBe(409)
  expect(reported('chat.manager.wake.saved')).toHaveLength(1)
}, 60_000)
