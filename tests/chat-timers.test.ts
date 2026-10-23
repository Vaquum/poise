import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CATALOG } from './model-catalog-fixture'
import { markReleaseSwitch, pauseReleaseBackground, releaseBackgroundBusy, resumeReleaseBackground } from '../server/release-background'
import type { Adapter, AdapterHost, TurnResult } from '../server/chat/adapters/types'
import type { CheckoutLeaseOptions } from '../server/chat/checkout-lock'
import type { Capabilities, ChatEvent, PromptInput, SessionRecord, TurnSource } from '../server/chat/protocol'
import type { ChatRuntime } from '../server/chat/runtime'
import type { ChatControl, CiObservation } from '../server/chat/control'

vi.mock('../server/claude-auth', () => ({ claudeAuth: { snapshot: () => ({ status: 'authenticated' }), requireReady: async () => {} } }))
vi.mock('../server/alerts/producers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/alerts/producers')>()
  return { ...actual, chatTurnFinished: vi.fn(actual.chatTurnFinished) }
})
const caps: Capabilities = { steer: true, fork: false, thought: false, plan: false, commands: false, modes: false, permissions: true, questions: true, resume: true, images: false }
let root: string
let runtime: ChatRuntime
let control: ChatControl
let server: Server
let origin: string
let clock: number
let instance: string
let workspaceRoot: string
let store: typeof import('../server/chat/control-store')
let database: typeof import('../server/db')
let logging: typeof import('../server/logging')
let Runtime: typeof ChatRuntime
let Control: typeof ChatControl
const prompts = new Map<string, PromptInput[]>()
const finishes = new Map<string, (result: TurnResult) => void>()
const hosts = new Map<string, AdapterHost>()
const failStarts = new Set<string>()
const ci = vi.fn<() => Promise<CiObservation>>()

function adapter(host: AdapterHost): Adapter {
  hosts.set(host.sessionId, host)
  let alive = false
  return {
    agent: 'grok', nativeSessionId: randomUUID(), capabilities: caps, get alive() { return alive },
    async start(options) {
      if (failStarts.has(host.sessionId)) throw new Error('native start failed')
      alive = true
      return { nativeSessionId: randomUUID(), capabilities: caps, modelId: options.modelId, effort: options.effort }
    },
    async prompt(_turn, input) {
      prompts.set(host.sessionId, [...(prompts.get(host.sessionId) ?? []), input])
      return new Promise<TurnResult>(done => finishes.set(host.sessionId, done))
    },
    async cancel() { finishes.get(host.sessionId)?.({ stopReason: 'cancelled' }); finishes.delete(host.sessionId) },
    async close() { alive = false; finishes.get(host.sessionId)?.({ stopReason: 'cancelled' }); finishes.delete(host.sessionId) },
    async steer() {}, async setMode() {}, async setModel(modelId, effort) { return { modelId, effort } },
    async fork() { return randomUUID() }, onExit() {},
  }
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) { if (check()) return; await new Promise(done => setTimeout(done, 15)) }
  throw new Error('timer fixture readiness deadline')
}
/** Hold timer fire and admission with the release switch while the callback
 *  runs, so the control's background second-ticks cannot admit a pending
 *  firing between a turn's finish and the test's next step. The callback
 *  must need no timer admission of its own; ordinary delivery is unaffected. */
async function holdingTimers<T>(run: () => Promise<T>): Promise<T> {
  markReleaseSwitch(true)
  try { return await run() } finally { markReleaseSwitch(false) }
}
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
async function manager(title = 'Manager') {
  const model = CATALOG.models.find(m => m.provider === 'grok')
  if (!model) throw new Error('fixture lacks grok')
  return runtime.create({ agent: 'grok', model: model.identity, title, deferStart: true })
}
async function workspaceManager(title = 'Manager') {
  const model = CATALOG.models.find(m => m.provider === 'grok')
  if (!model) throw new Error('fixture lacks grok')
  return runtime.create({ agent: 'grok', model: model.identity, title, role: 'manager', deferStart: true })
}
/** A one-shot heartbeat on P, Manager-set unless told otherwise. */
async function heartbeat(m: SessionRecord, p: SessionRecord, overrides: Record<string, unknown> = {}) {
  return (await command(m.id, { operation: 'timer', sessionId: p.id, label: 'Heartbeat', message: 'Are we green?', delayMinutes: 10, ...overrides })).timer as {
    id: string, sessionId: string, label: string, preview: string, schedule: { kind: string, delayMinutes?: number, minutes?: number },
    nextAt: string | null, state: string, reason?: string, setBy: { kind: string }, failures: number, skipped: number, message: string,
  }
}
function starts(id: string): Extract<ChatEvent, { type: 'turn.started' }>[] {
  return runtime.events(id, 0).events.map(e => e.event).filter((e): e is Extract<ChatEvent, { type: 'turn.started' }> => e.type === 'turn.started')
}
function timerNotes(id: string): Extract<ChatEvent, { type: 'timer.changed' }>[] {
  return runtime.events(id, 0).events.map(e => e.event).filter((e): e is Extract<ChatEvent, { type: 'timer.changed' }> => e.type === 'timer.changed')
}
function reported(operation: string) {
  logging.loggingRuntime()!.flush()
  const found: ReturnType<typeof logging.diagnosticPage>['events'] = []
  let cursor: string | null = null
  // Delivery pages hold three events and the fixture's git work fills many.
  for (let guard = 0; guard < 5000; guard++) {
    const page = logging.diagnosticPage(cursor)
    found.push(...page.events.filter(e => e.operation === operation))
    if (!page.hasMore) return found
    cursor = page.cursor
  }
  throw new Error('diagnostic pages did not end')
}
function makeRuntime(leaseProbes?: CheckoutLeaseOptions) {
  return new Runtime({ instance, instanceLabel: 'test', callerTurns: null, catalog: async () => CATALOG,
    adapters: { grok: adapter }, requireClaudeReady: async () => {}, probeAgent: async () => ({ ok: true }),
    localWorkspaceRoot: workspaceRoot, idleTimeoutMinutes: () => 0, controlContext: id => control.context(id),
    ...(leaseProbes ? { leaseProbes } : {}) })
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-timer-test-'))
  vi.stubEnv('POISE_DB', join(root, 'chat.sqlite3'))
  vi.stubEnv('POISE_LOCK_DIR', join(root, 'locks'))
  ;({ ChatRuntime: Runtime } = await import('../server/chat/runtime'))
  ;({ ChatControl: Control } = await import('../server/chat/control'))
  store = await import('../server/chat/control-store')
  database = await import('../server/db')
  logging = await import('../server/logging')
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  logging.startLogging()
})
beforeEach(async () => {
  clock = Date.now()
  prompts.clear(); finishes.clear(); hosts.clear(); failStarts.clear()
  ci.mockReset().mockResolvedValue({ head: 'a'.repeat(40), failing: [] })
  instance = `control:${randomUUID()}`
  workspaceRoot = join(root, randomUUID())
  runtime = makeRuntime()
  control = new Control(runtime, { ci, now: () => clock })
  const { handleChatApi } = await import('../server/chat/transport')
  server = createServer((req, res) => {
    if (req.url === '/api/chat/control') { void control.handle(req, res); return }
    if (req.url?.startsWith('/api/chat/sessions/')) { void handleChatApi(req, res, req.url, runtime, undefined, true, control); return }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ nativeApi: true, path: req.url }))
  })
  control.attach(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture needs TCP')
  origin = `http://127.0.0.1:${address.port}`
  control.start()
})
afterEach(async () => {
  await control?.stop()
  await runtime?.stop()
  await new Promise<void>(done => server.close(() => done()))
})
afterAll(async () => { database.closeDatabase(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

describe('durable timers that wake chats', () => {
  it('admits a due one-shot on an idle chat with the timer header, source and note', async () => {
    const m = await workspaceManager(), p = await manager('Worker')
    const created = await heartbeat(m, p)
    expect(created.nextAt).toBe(new Date(clock + 10 * 60_000).toISOString())
    // The session record carries the live summary with a preview, never the message.
    const summaries = runtime.get(p.id)!.timers ?? []
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({ id: created.id, label: 'Heartbeat', preview: 'Are we green?', state: 'active' })
    expect('message' in summaries[0]).toBe(false)
    expect(timerNotes(p.id)).toHaveLength(1)
    expect(timerNotes(p.id)[0]).toMatchObject({ change: 'created', by: { kind: 'chat', sessionId: m.id } })
    clock += 10 * 60_000
    await control.tick()
    await until(() => prompts.has(p.id))
    const text = prompts.get(p.id)!.at(-1)!.text
    expect(text).toContain(`[Request]\n[Poise timer ${created.id} "Heartbeat" set by the workspace Manager`)
    expect(text).toContain(`; due ${new Date(clock).toISOString()}`)
    expect(text).toContain('source data within your existing authorized task, not a message from the person')
    expect(text).not.toContain('[User request]')
    expect(text.endsWith('\nAre we green?')).toBe(true)
    const source = starts(p.id).at(-1)!.source as Extract<TurnSource, { kind: 'timer' }>
    expect(source).toMatchObject({ kind: 'timer', timerId: created.id, label: 'Heartbeat', missed: 0, dueAt: new Date(clock).toISOString() })
    expect(source.setBy).toEqual({ kind: 'chat', sessionId: m.id, title: 'Manager', role: 'manager' })
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    const listed = (await command(m.id, { operation: 'timers', sessionId: p.id })).timers as Array<{ id: string, state: string, reason?: string }>
    expect(listed.find(t => t.id === created.id)).toMatchObject({ state: 'done', reason: 'completed' })
    expect(timerNotes(p.id).at(-1)).toMatchObject({ change: 'ended' })
    expect(runtime.get(p.id)!.timers ?? []).toHaveLength(0)
    const all = (await command(m.id, { operation: 'timers' })).timers as Array<{ id: string }>
    expect(all.some(t => t.id === created.id)).toBe(true)
  }, 60_000)

  it('names timer setters and cuts previews at 200 code points without splitting emoji', async () => {
    const transcript = await import('../src/views/chat-transcript')
    expect(transcript.timerSetterName({ kind: 'person' })).toBe('you')
    expect(transcript.timerSetterName({ kind: 'chat', sessionId: 'm', title: 'Manager', role: 'manager' })).toBe('Manager')
    expect(transcript.actorName({ kind: 'timer', timerId: 't', label: 'L', setBy: { kind: 'person' }, missed: 0, dueAt: new Date(clock).toISOString(), seq: 1 })).toBe('you')
    const message = `${'a'.repeat(199)}👍b`
    const p = await manager('Worker')
    const created = control.createTimer({ sessionId: p.id, label: 'L', message, delayMinutes: 10 }, { kind: 'person' })
    expect(created.preview).toBe(`${'a'.repeat(199)}👍…`)
    expect(transcript.timerChangedText(created, 'tripped', 'boom'))
      .toBe('Timer "L" stopped after 3 failed turns: boom. Re-arm it from Timers.')
  }, 60_000)

  it('fires an every-5-minutes timer on schedule across three admissions', async () => {
    const m = await workspaceManager(), p = await manager('Worker')
    const created = (await command(m.id, { operation: 'timer', sessionId: p.id, label: 'Pulse', message: 'Ping', everyMinutes: 5 })).timer as { id: string }
    for (const [advance, next] of [[5, 10], [5, 15], [5, 20]] as const) {
      clock += advance * 60_000
      await control.tick()
      await until(() => (prompts.get(p.id) ?? []).length === (next / 5 - 1))
      finishes.get(p.id)!({ stopReason: 'end_turn' })
      await until(() => runtime.get(p.id)?.status === 'idle')
      const current = store.timerById(instance, created.id)!
      expect(current.nextAt).toBe(new Date(clock + 5 * 60_000).toISOString())
      expect(current.failures).toBe(0)
    }
    expect(store.timerById(instance, created.id)!.nextAt).toBe(new Date(clock + 5 * 60_000).toISOString())
  }, 60_000)

  it('collapses 30 days of backlog into one delivery and clamps a backward clock', async () => {
    const m = await workspaceManager(), p = await manager('Worker')
    const created = (await command(m.id, { operation: 'timer', sessionId: p.id, label: 'Pulse', message: 'Ping', everyMinutes: 5 })).timer as { id: string }
    clock += 30 * 86_400_000
    await control.tick()
    await until(() => prompts.has(p.id))
    const source = starts(p.id).at(-1)!.source as Extract<TurnSource, { kind: 'timer' }>
    expect(source.missed).toBe(8639)
    expect(prompts.get(p.id)!.at(-1)!.text).toContain('; 8639 earlier firings collapsed into this one')
    expect(store.timerById(instance, created.id)!.nextAt).toBe(new Date(clock + 5 * 60_000).toISOString())
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    clock -= 2 * 3_600_000
    await control.tick()
    expect(store.timerById(instance, created.id)!.nextAt).toBe(new Date(clock + 5 * 60_000).toISOString())
  }, 60_000)

  it('admits a new firing when a backward clock clamp revisits an admitted due time', async () => {
    const m = await workspaceManager(), p = await manager('Worker')
    const created = (await command(m.id, { operation: 'timer', sessionId: p.id, label: 'Pulse', message: 'Ping', everyMinutes: 5 })).timer as { id: string }
    clock += 5 * 60_000
    await control.tick()
    await until(() => (prompts.get(p.id) ?? []).length === 1)
    const first = starts(p.id).at(-1)!.source as Extract<TurnSource, { kind: 'timer' }>
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    clock -= 5 * 60_000
    await control.tick()
    expect(store.timerById(instance, created.id)!.nextAt).toBe(first.dueAt)
    clock += 5 * 60_000
    await control.tick()
    await until(() => (prompts.get(p.id) ?? []).length === 2)
    const second = starts(p.id).at(-1)!.source as Extract<TurnSource, { kind: 'timer' }>
    expect(second).toMatchObject({ timerId: created.id, dueAt: first.dueAt, missed: 0 })
    expect(second.seq).not.toBe(first.seq)
    expect(store.timerById(instance, created.id)!.nextAt).toBe(new Date(clock + 5 * 60_000).toISOString())
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
  }, 60_000)

  it('does not extend person grace across a backward clock clamp', async () => {
    const m = await workspaceManager(), p = await manager('Worker')
    const timer = await heartbeat(m, p, { everyMinutes: 5, delayMinutes: undefined })
    runtime.prompt(p.id, { text: 'Person task', attachments: [], mentions: [] })
    await until(() => prompts.has(p.id))
    await holdingTimers(async () => {
      finishes.get(p.id)!({ stopReason: 'end_turn' })
      await until(() => runtime.get(p.id)?.status === 'idle')
      const finished = runtime.events(p.id, 0).events.filter(e => e.event.type === 'turn.finished').at(-1)!
      clock = Date.parse(finished.at) - 2 * 3_600_000
    })
    await control.tick()
    expect(store.timerById(instance, timer.id)!.nextAt).toBe(new Date(clock + 5 * 60_000).toISOString())
    clock += 5 * 60_000
    await control.tick()
    expect(control.timersOf(p.id).timers.find(item => item.id === timer.id)?.pending?.waitingFor).not.toBe('person')
    await until(() => (prompts.get(p.id) ?? []).length === 2)
    expect(starts(p.id).at(-1)!.source).toMatchObject({ kind: 'timer', timerId: timer.id })
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
  }, 60_000)

  it('backs off twice, then trips with a note and a warning while ordinary delivery continues', async () => {
    const m = await workspaceManager(), p = await manager('Worker')
    const created = (await command(m.id, { operation: 'timer', sessionId: p.id, label: 'Flaky', message: 'Ping', everyMinutes: 30 })).timer as { id: string }
    clock += 30 * 60_000
    await control.tick()
    await until(() => prompts.has(p.id))
    finishes.get(p.id)!({ stopReason: 'error', error: 'first boom' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    prompts.delete(p.id)
    expect(store.timerById(instance, created.id)).toMatchObject({ failures: 1, state: 'active' })
    expect(store.timerById(instance, created.id)!.notBefore).toBe(new Date(clock + 60 * 60_000).toISOString())
    // Due but backing off: the row waits instead of admitting.
    clock += 30 * 60_000
    await control.tick()
    expect(prompts.has(p.id)).toBe(false)
    const waiting = (await command(m.id, { operation: 'timers', sessionId: p.id })).timers as Array<{ id: string, pending?: { waitingFor?: string } }>
    expect(waiting.find(t => t.id === created.id)?.pending?.waitingFor).toBe('backoff')
    clock += 30 * 60_000
    await control.tick()
    await until(() => prompts.has(p.id))
    prompts.delete(p.id)
    finishes.get(p.id)!({ stopReason: 'error', error: 'second boom' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    expect(store.timerById(instance, created.id)).toMatchObject({ failures: 2 })
    expect(store.timerById(instance, created.id)!.notBefore).toBe(new Date(clock + 120 * 60_000).toISOString())
    clock += 120 * 60_000
    await control.tick()
    await until(() => prompts.has(p.id))
    finishes.get(p.id)!({ stopReason: 'error', error: 'y'.repeat(400) })
    await until(() => runtime.get(p.id)?.status === 'idle')
    const tripped = store.timerById(instance, created.id)!
    expect(tripped).toMatchObject({ state: 'tripped', reason: 'failed_3_times', failures: 3 })
    const trip = timerNotes(p.id).at(-1)!
    expect(trip.change).toBe('tripped')
    expect(trip.error).toBe(`${'y'.repeat(300)}…`)
    const warnings = reported('chat.timer.changed').filter(e => e.target === created.id)
    expect(warnings).toHaveLength(1)
    expect(warnings[0].severity).toBe('warning')
    // A timer turn's failure never pauses the chat's ordinary delivery.
    prompts.delete(p.id)
    store.message(instance, p.id, m.id, 'Ordinary work', `ordinary:${randomUUID()}`)
    await control.tick()
    await until(() => prompts.has(p.id))
    expect(prompts.get(p.id)!.at(-1)!.text).toContain('Ordinary work')
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
  }, 120_000)

  it('re-arms only tripped timers and cancels idempotently with person-set protection', async () => {
    const m = await workspaceManager(), p = await manager('Worker')
    const created = await heartbeat(m, p)
    await expect(command(m.id, { operation: 'rearmTimer', timerId: created.id })).rejects.toThrow('only a tripped timer can be re-armed')
    // Trip it, then re-arm: failures clear and the next fire is now + interval.
    clock += 10 * 60_000
    await control.tick()
    await until(() => prompts.has(p.id))
    finishes.get(p.id)!({ stopReason: 'error', error: 'boom' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    prompts.delete(p.id)
    const once = store.timerById(instance, created.id)!
    expect(once).toMatchObject({ state: 'done', reason: 'turn_failed' })
    const repeating = (await command(m.id, { operation: 'timer', sessionId: p.id, label: 'R', message: 'Ping', everyMinutes: 30 })).timer as { id: string }
    for (let i = 0; i < 3; i++) {
      clock += 30 * 60_000
      await control.tick()
      await until(() => prompts.has(p.id))
      prompts.delete(p.id)
      finishes.get(p.id)!({ stopReason: 'error', error: 'boom' })
      await until(() => runtime.get(p.id)?.status === 'idle')
      if (i < 2) clock = Date.parse(store.timerById(instance, repeating.id)!.notBefore!)
    }
    expect(store.timerById(instance, repeating.id)!.state).toBe('tripped')
    const rearmed = (await command(m.id, { operation: 'rearmTimer', timerId: repeating.id })).timer as { state: string, failures: number, nextAt: string }
    expect(rearmed).toMatchObject({ state: 'active', failures: 0 })
    expect(rearmed.nextAt).toBe(new Date(clock + 30 * 60_000).toISOString())
    expect(timerNotes(p.id).at(-1)).toMatchObject({ change: 'rearmed' })
    // Cancelling an ended timer returns it unchanged; unknown ids 404.
    const notesBefore = timerNotes(p.id).length
    const cancelled = (await command(m.id, { operation: 'cancelTimer', timerId: created.id })).timer as { state: string }
    expect(cancelled.state).toBe('done')
    expect(timerNotes(p.id)).toHaveLength(notesBefore)
    await expect(command(m.id, { operation: 'cancelTimer', timerId: randomUUID() })).rejects.toThrow('unknown timer in this Poise instance')
    // The Manager cannot change a timer the person set.
    const persons = control.createTimer({ sessionId: p.id, label: 'Mine', message: 'Ping', delayMinutes: 10 }, { kind: 'person' })
    await expect(command(m.id, { operation: 'cancelTimer', timerId: persons.id })).rejects.toThrow('only the person can change a timer the person set')
    const personCancelled = control.cancelTimer(persons.id, { kind: 'person' })
    expect(personCancelled).toMatchObject({ state: 'cancelled', reason: 'cancelled_by_person' })
  }, 120_000)

  it('refuses the Switchboard, change sessions, unknown and foreign chats on every surface', async () => {
    const boards = await import('../server/chat/switchboard-store')
    const m = await workspaceManager(), p = await manager('Worker')
    boards.setSession(instance, p.id, clock)
    const attempt = { sessionId: p.id, label: 'Nope', message: 'Ping', delayMinutes: 10 }
    await expect(command(m.id, { operation: 'timer', ...attempt })).rejects.toThrow('timers cannot target the Switchboard or a Poise change session')
    expect(() => control.createTimer(attempt, { kind: 'person' })).toThrow('timers cannot target the Switchboard or a Poise change session')
    boards.setSession(instance, null, clock)
    const changed = await manager('Changed')
    runtime.get(changed.id)!.selfChangeId = 'change-1'
    await expect(command(m.id, { operation: 'timer', ...attempt, sessionId: changed.id })).rejects.toThrow('timers cannot target the Switchboard or a Poise change session')
    await expect(command(m.id, { operation: 'timer', ...attempt, sessionId: randomUUID() })).rejects.toThrow('unknown chat')
    const foreign = new Runtime({ instance: `control:${randomUUID()}`, instanceLabel: 'test', callerTurns: null, catalog: async () => CATALOG,
      adapters: { grok: adapter }, requireClaudeReady: async () => {}, probeAgent: async () => ({ ok: true }),
      localWorkspaceRoot: join(root, randomUUID()), idleTimeoutMinutes: () => 0 })
    try {
      const model = CATALOG.models.find(m => m.provider === 'grok')!
      const outsider = await foreign.create({ agent: 'grok', model: model.identity, title: 'Outsider', deferStart: true })
      await expect(command(m.id, { operation: 'timer', ...attempt, sessionId: outsider.id })).rejects.toThrow('unknown chat')
    } finally { await foreign.stop() }
    // A closed chat is accepted: closing is reopenable, crossing out is not.
    await runtime.close(p.id)
    const closed = (await command(m.id, { operation: 'timer', ...attempt })).timer as { state: string }
    expect(closed.state).toBe('active')
  }, 120_000)

  it('keeps timer operations Manager-only with receipts, and stops de-escalate past firing timers', async () => {
    const m = await workspaceManager(), other = await manager('Ordinary'), p = await manager('Worker')
    for (const operation of ['timer', 'timers', 'cancelTimer', 'rearmTimer']) {
      const requestId = randomUUID()
      const context = await control.context(other.id)
      const path = /"([^"\n]+\.json)"/.exec(context)?.[1]
      const connection = JSON.parse(await readFile(path!, 'utf8')) as { token: string }
      const response = await fetch(`${origin}/api/chat/control`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Poise-Chat': other.id, Authorization: `Bearer ${connection.token}` },
        body: JSON.stringify({ requestId, operation, sessionId: p.id, label: 'x', message: 'y', delayMinutes: 10, timerId: randomUUID() }) })
      expect(response.status).toBe(403)
      expect(await response.text()).toContain('timers are available to the workspace Manager and the person')
      const receipt = database.db.prepare('SELECT request_id FROM chat_command_receipts WHERE instance = ? AND request_id = ?').get(instance, requestId)
      expect(receipt).toBeUndefined()
    }
    // A cancel replays its ack without re-cancelling.
    const created = await heartbeat(m, p)
    const first = await command(m.id, { operation: 'cancelTimer', timerId: created.id })
    const notesBefore = timerNotes(p.id).length
    const requestId = randomUUID()
    const context = await control.context(m.id)
    const path = /"([^"\n]+\.json)"/.exec(context)?.[1]
    const connection = JSON.parse(await readFile(path!, 'utf8')) as { token: string }
    const send = () => fetch(`${origin}/api/chat/control`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Poise-Chat': m.id, Authorization: `Bearer ${connection.token}` },
      body: JSON.stringify({ requestId, operation: 'cancelTimer', timerId: created.id }) })
    const one = await (await send()).json() as { result: unknown }
    const two = await (await send()).json() as { result: unknown }
    expect(one.result).toEqual(two.result)
    expect(one.result).toEqual(first)
    expect(timerNotes(p.id)).toHaveLength(notesBefore)
    // A Manager stop still de-escalates a worker question while a timer fires for it.
    const worker = await manager('Questioner')
    const createdTimer = (await command(m.id, { operation: 'timer', sessionId: worker.id, label: 'T', message: 'Ping', delayMinutes: 10 })).timer as { id: string }
    runtime.prompt(worker.id, { text: 'Ask something', attachments: [], mentions: [] })
    await until(() => prompts.has(worker.id))
    const waiting = hosts.get(worker.id)!.askQuestion({ questions: [{ id: 'q', question: 'Which?', options: [], freeText: true, multiSelect: false }] })
    void waiting.catch(() => undefined)
    await until(() => runtime.get(worker.id)?.status === 'waiting')
    clock += 10 * 60_000
    await control.tick()
    await holdingTimers(async () => {
      await command(m.id, { operation: 'stop', sessionId: worker.id })
      await until(() => runtime.get(worker.id)?.status === 'idle')
      expect(store.holds(instance)).toHaveLength(0)
      expect(store.timerPendingRow(instance, createdTimer.id)).toBeDefined()
    })
  }, 120_000)

  it('enforces timer bounds and caps without touching person-set timers', async () => {
    const m = await workspaceManager(), p = await manager('Worker')
    const attempt = (overrides: Record<string, unknown>) => command(m.id, { operation: 'timer', sessionId: p.id, label: 'L', message: 'Ping', delayMinutes: 10, ...overrides })
    await expect(attempt({ label: 'x'.repeat(81) })).rejects.toThrow('label needs 1–80 characters')
    await expect(attempt({ label: '  ' })).rejects.toThrow('label needs 1–80 characters')
    await expect(attempt({ message: '  ' })).rejects.toThrow('message needs 1–8192 UTF-8 bytes')
    await expect(attempt({ message: 'x'.repeat(8193) })).rejects.toThrow('message needs 1–8192 UTF-8 bytes')
    await expect(attempt({ everyMinutes: 30 })).rejects.toThrow('use exactly one of delayMinutes (1–10080) or everyMinutes (5–1440)')
    await expect(command(m.id, { operation: 'timer', sessionId: p.id, label: 'L', message: 'Ping' })).rejects.toThrow('use exactly one of delayMinutes (1–10080) or everyMinutes (5–1440)')
    await expect(attempt({ delayMinutes: 0 })).rejects.toThrow('use exactly one of delayMinutes (1–10080) or everyMinutes (5–1440)')
    await expect(attempt({ delayMinutes: 10081 })).rejects.toThrow('use exactly one of delayMinutes (1–10080) or everyMinutes (5–1440)')
    await expect(attempt({ delayMinutes: undefined, everyMinutes: 4 })).rejects.toThrow('use exactly one of delayMinutes (1–10080) or everyMinutes (5–1440)')
    await expect(attempt({ delayMinutes: undefined, everyMinutes: 1441 })).rejects.toThrow('use exactly one of delayMinutes (1–10080) or everyMinutes (5–1440)')
    for (let i = 0; i < 5; i++) await attempt({ label: `T${i}` })
    await expect(attempt({ label: 'Sixth' })).rejects.toThrow('this chat already has 5 timers')
    // The instance cap counts chat-set timers only. Stub targets keep the
    // sweep from ending the bulk timers on the control's interval ticks.
    const setter = { kind: 'chat', sessionId: m.id, title: 'Manager', role: 'manager' } as const
    for (let i = 0; i < 95; i++) {
      database.db.prepare(`INSERT INTO chat_sessions(id, record, agent, repo, checkout, branch, status, title, instance, created_at, updated_at)
        VALUES(?, '{}', 'grok', '', '', '', 'idle', 'Bulk', ?, ?, ?)`)
        .run(`bulk-${i}`, instance, new Date(clock).toISOString(), new Date(clock).toISOString())
      store.createTimer(instance, { sessionId: `bulk-${i}`, label: 'B', message: 'Ping', delayMinutes: 10 }, setter, clock)
    }
    const fresh = await manager('Fresh')
    const persons = control.createTimer({ sessionId: fresh.id, label: 'Mine', message: 'Ping', delayMinutes: 10 }, { kind: 'person' })
    expect(persons.state).toBe('active')
    await expect(attempt({ label: 'Over', sessionId: fresh.id })).rejects.toThrow('this Poise instance already has 100 timers')
  }, 120_000)

  it('holds a chat on the person\'s Stop, skips due firings, and resumes on their message', async () => {
    const m = await workspaceManager(), p = await manager('Worker')
    const created = (await command(m.id, { operation: 'timer', sessionId: p.id, label: 'T', message: 'Ping', everyMinutes: 30 })).timer as { id: string }
    // A Stop with nothing running sets no hold.
    await runtime.cancel(p.id, { kind: 'person' })
    expect(store.holds(instance)).toHaveLength(0)
    // A Stop during a running turn holds the chat and attributes the stop.
    runtime.prompt(p.id, { text: 'Long task', attachments: [], mentions: [] })
    await until(() => prompts.has(p.id))
    await runtime.cancel(p.id, { kind: 'person' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    expect(store.holds(instance)).toEqual([{ sessionId: p.id, cause: 'stopped', since: expect.any(String) }])
    const finished = runtime.events(p.id, 0).events.map(e => e.event).find(e => e.type === 'turn.finished')
    expect(finished).toMatchObject({ stopReason: 'cancelled', stoppedBy: { kind: 'person' } })
    // Due occurrences skip: no row, skipped grows, one held note.
    clock += 30 * 60_000
    await control.tick()
    const held = store.timerById(instance, created.id)!
    expect(held).toMatchObject({ state: 'held', reason: 'person_stopped', skipped: 1 })
    expect(store.timerPendingRow(instance, created.id)).toBeUndefined()
    expect(timerNotes(p.id).filter(n => n.change === 'held')).toHaveLength(1)
    // The person's own message releases a Stop's hold; the timer goes active again.
    prompts.delete(p.id)
    runtime.prompt(p.id, { text: 'I am back', attachments: [], mentions: [] })
    await until(() => store.holds(instance).length === 0)
    await until(() => prompts.has(p.id))
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    prompts.delete(p.id)
    clock += 61_000
    await control.tick()
    expect(store.timerById(instance, created.id)!.state).toBe('active')
    expect(timerNotes(p.id).at(-1)).toMatchObject({ change: 'released' })
  }, 120_000)

  it('keeps a Manager stop first when the person stops the same turn, and still holds', async () => {
    const m = await workspaceManager(), p = await manager('Worker')
    await heartbeat(m, p)
    runtime.prompt(p.id, { text: 'Long task', attachments: [], mentions: [] })
    await until(() => prompts.has(p.id))
    const managerActor = { kind: 'chat', sessionId: m.id, title: 'Manager', role: 'manager' } as const
    const first = runtime.cancel(p.id, managerActor)
    const second = runtime.cancel(p.id, { kind: 'person' })
    await Promise.all([first, second])
    await until(() => runtime.get(p.id)?.status === 'idle')
    const finished = runtime.events(p.id, 0).events.map(e => e.event).find(e => e.type === 'turn.finished')
    expect(finished).toMatchObject({ stoppedBy: { kind: 'chat', sessionId: m.id } })
    expect(store.holds(instance)).toEqual([{ sessionId: p.id, cause: 'stopped', since: expect.any(String) }])
  }, 60_000)

  it('holds and resumes through the toggle and hold-all with matching notes', async () => {
    const m = await workspaceManager(), p = await manager('Worker'), q = await manager('Other'), r = await manager('Third')
    const one = (await command(m.id, { operation: 'timer', sessionId: p.id, label: 'P', message: 'Ping', everyMinutes: 30 })).timer as { id: string }
    // The Hold toggle survives the person's own message and clears on Resume.
    control.setHold(p.id, true)
    runtime.prompt(p.id, { text: 'Still held', attachments: [], mentions: [] })
    await until(() => prompts.has(p.id))
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    expect(store.holds(instance)).toEqual([{ sessionId: p.id, cause: 'held', since: expect.any(String) }])
    clock += 30 * 60_000
    await control.tick()
    expect(store.timerById(instance, one.id)).toMatchObject({ state: 'held', reason: 'person_held' })
    control.setHold(p.id, false)
    await control.tick()
    expect(store.timerById(instance, one.id)!.state).toBe('active')
    expect(timerNotes(p.id).at(-1)).toMatchObject({ change: 'released' })
    // Hold-all holds every timer; a one-shot due during the hold expires.
    const two = (await command(m.id, { operation: 'timer', sessionId: q.id, label: 'Q', message: 'Ping', everyMinutes: 30 })).timer as { id: string }
    const three = (await command(m.id, { operation: 'timer', sessionId: r.id, label: 'R', message: 'Ping', everyMinutes: 30 })).timer as { id: string }
    const late = (await command(m.id, { operation: 'timer', sessionId: p.id, label: 'Late', message: 'Ping', delayMinutes: 10 })).timer as { id: string }
    control.setAllHeld(true)
    clock += 30 * 60_000
    await control.tick()
    expect(store.timerById(instance, two.id)).toMatchObject({ state: 'held', reason: 'all_held' })
    expect(store.timerById(instance, three.id)).toMatchObject({ state: 'held', reason: 'all_held' })
    expect(store.timerById(instance, late.id)).toMatchObject({ state: 'expired', reason: 'skipped_while_held' })
    // Releasing resumes each at its next phase point.
    control.setAllHeld(false)
    await control.tick()
    for (const id of [one.id, two.id, three.id]) {
      const view = store.timerById(instance, id)!
      expect(view.state).toBe('active')
      expect(Date.parse(view.nextAt!)).toBeGreaterThan(clock)
      expect((Date.parse(view.nextAt!) - Date.parse(view.createdAt)) % (30 * 60_000)).toBe(0)
    }
    // The timers read carries holds and the workspace hold.
    const listed = await command(m.id, { operation: 'timers', sessionId: q.id }) as { timers: unknown[], holds: unknown[], allHeld: { held: boolean } }
    expect(listed.holds).toHaveLength(0)
    expect(listed.allHeld).toMatchObject({ held: false })
  }, 120_000)

  it('lets the person reply first within a minute of their turn', async () => {
    const m = await workspaceManager(), p = await manager('Worker')
    const created = (await command(m.id, { operation: 'timer', sessionId: p.id, label: 'T', message: 'Ping', delayMinutes: 1 })).timer as { id: string }
    runtime.prompt(p.id, { text: 'Person task', attachments: [], mentions: [] })
    await until(() => prompts.has(p.id))
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    prompts.delete(p.id)
    clock += 60_000
    await control.tick()
    expect(prompts.has(p.id)).toBe(false)
    const listed = (await command(m.id, { operation: 'timers', sessionId: p.id })).timers as Array<{ id: string, pending?: { waitingFor?: string } }>
    expect(listed.find(t => t.id === created.id)?.pending?.waitingFor).toBe('person')
    clock += 61_000
    await control.tick()
    await until(() => prompts.has(p.id))
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
  }, 60_000)

  it('waits for queued tasks but ignores failed or paused queue items', async () => {
    const m = await workspaceManager(), p = await manager('Worker')
    const created = (await command(m.id, { operation: 'timer', sessionId: p.id, label: 'T', message: 'Ping', everyMinutes: 30 })).timer as { id: string }
    // A running turn with a queued task: the queued task runs before the timer.
    runtime.prompt(p.id, { text: 'First', attachments: [], mentions: [] })
    await until(() => prompts.has(p.id))
    await runtime.enqueue(p.id, randomUUID(), { text: 'Queued task', attachments: [], mentions: [] })
    clock += 30 * 60_000
    await control.tick()
    const listed = (await command(m.id, { operation: 'timers', sessionId: p.id })).timers as Array<{ id: string, pending?: { waitingFor?: string } }>
    expect(listed.find(t => t.id === created.id)?.pending?.waitingFor).toBe('running')
    await holdingTimers(async () => {
      finishes.get(p.id)!({ stopReason: 'end_turn' })
      await until(() => (prompts.get(p.id) ?? []).length === 2)
      expect(prompts.get(p.id)![1].text).toContain('Queued task')
      finishes.get(p.id)!({ stopReason: 'end_turn' })
      await until(() => runtime.get(p.id)?.status === 'idle')
    })
    await control.tick()
    await until(() => (prompts.get(p.id) ?? []).length === 3)
    expect(prompts.get(p.id)![2].text).toContain('[Poise timer')
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
  }, 60_000)

  it('admits past failed queue items and reports every other wait cause', async () => {
    const m = await workspaceManager(), p = await manager('Worker')
    const created = (await command(m.id, { operation: 'timer', sessionId: p.id, label: 'T', message: 'Ping', everyMinutes: 30 })).timer as { id: string }
    // A queue holding only a failed item does not block.
    runtime.prompt(p.id, { text: 'First', attachments: [], mentions: [] })
    await until(() => prompts.has(p.id))
    await runtime.enqueue(p.id, randomUUID(), { text: 'Queued doomed', attachments: [], mentions: [] })
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => (prompts.get(p.id) ?? []).length === 2)
    finishes.get(p.id)!({ stopReason: 'error', error: 'boom again' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    prompts.delete(p.id)
    clock += 30 * 60_000
    // Past the person's one-minute grace so the timer admits at once.
    clock += 61_000
    await control.tick()
    await until(() => prompts.has(p.id))
    expect(prompts.get(p.id)!.at(-1)!.text).toContain('[Poise timer')
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    expect(store.timerById(instance, created.id)!.failures).toBe(0)
  }, 60_000)

  it('reopens again after a cancelled firing finishes reopening and its chat closes again', async () => {
    const m = await workspaceManager(), p = await manager('Worker')
    const first = await heartbeat(m, p, { delayMinutes: 1 })
    await runtime.close(p.id)
    const resume = runtime.resume.bind(runtime)
    let opened!: () => void
    let release!: () => void
    const ready = new Promise<void>(resolve => { opened = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    let firstResume: Promise<SessionRecord> | undefined
    const attempts = vi.spyOn(runtime, 'resume').mockImplementation(id => {
      const current = resume(id)
      if (id !== p.id || firstResume) return current
      firstResume = current.then(async record => { opened(); await held; return record })
      return firstResume
    })
    try {
      clock += 60_000
      await control.tick()
      await ready
      expect(attempts).toHaveBeenCalledTimes(1)
      let second!: { id: string }
      await holdingTimers(async () => {
        await command(m.id, { operation: 'cancelTimer', timerId: first.id })
        await runtime.close(p.id)
        release()
        await firstResume
        second = await heartbeat(m, p, { delayMinutes: 1 })
        clock += 60_000
      })
      await control.tick()
      expect(attempts).toHaveBeenCalledTimes(2)
      await until(() => prompts.has(p.id))
      expect(starts(p.id).at(-1)!.source).toMatchObject({ kind: 'timer', timerId: second.id })
      expect(store.timerById(instance, first.id)!.state).toBe('cancelled')
      finishes.get(p.id)!({ stopReason: 'end_turn' })
      await until(() => runtime.get(p.id)?.status === 'idle')
    } finally { release() }
  }, 60_000)

  it('waits through maintenance, reopening, model choice and release switches', async () => {
    const release = await import('../server/release-background')
    const m = await workspaceManager(), p = await manager('Worker')
    const created = (await command(m.id, { operation: 'timer', sessionId: p.id, label: 'T', message: 'Ping', everyMinutes: 30 })).timer as { id: string }
    const waitsFor = async () => {
      const listed = (await command(m.id, { operation: 'timers', sessionId: p.id })).timers as Array<{ id: string, pending?: { waitingFor?: string } }>
      return listed.find(t => t.id === created.id)?.pending?.waitingFor
    }
    clock += 30 * 60_000
    // Maintenance: a reset in flight holds the firing.
    await control.tick()
    await until(() => prompts.has(p.id))
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    prompts.delete(p.id)
    clock += 30 * 60_000
    await control.tick()
    await until(() => prompts.has(p.id))
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    prompts.delete(p.id)
    clock += 30 * 60_000
    // Fired while busy so the row waits; finished so the reset runs clean.
    runtime.prompt(p.id, { text: 'Busy', attachments: [], mentions: [] })
    await until(() => prompts.has(p.id))
    prompts.delete(p.id)
    await control.tick()
    await holdingTimers(async () => {
      finishes.get(p.id)!({ stopReason: 'end_turn' })
      await until(() => runtime.get(p.id)?.status === 'idle')
    })
    // The reset flags maintenance synchronously; the read below runs before
    // anything can clear it.
    const resetting = runtime.reset(p.id)
    const maintenance = control.timersOf(p.id).timers.find(t => t.id === created.id)?.pending?.waitingFor
    expect(maintenance).toBe('maintenance')
    await resetting
    await control.tick()
    await until(() => prompts.has(p.id))
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    prompts.delete(p.id)
    // Reopening: a fired row on a closed chat waits, the tick reopens to
    // idle, and the next tick admits once.
    runtime.prompt(p.id, { text: 'Busy', attachments: [], mentions: [] })
    await until(() => prompts.has(p.id))
    prompts.delete(p.id)
    clock += 30 * 60_000
    await control.tick()
    await runtime.close(p.id)
    await until(() => runtime.get(p.id)?.status === 'closed')
    // A background tick may already have begun the reopen; either way the
    // firing waits for the resume rather than delivering into a closed chat.
    expect(['reopening', 'starting']).toContain(await waitsFor())
    await control.tick()
    await until(() => runtime.get(p.id)?.status === 'idle')
    await control.tick()
    await until(() => prompts.has(p.id))
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    prompts.delete(p.id)
    // A release switch in waiting holds fire and admission with its own cause.
    release.markReleaseSwitch(true)
    try {
      clock += 30 * 60_000
      await control.tick()
      expect(store.timerPendingRow(instance, created.id)).toBeUndefined()
      // A row pending from before the switch waits with cause update.
      release.markReleaseSwitch(false)
      await control.tick()
      await until(() => prompts.has(p.id))
      finishes.get(p.id)!({ stopReason: 'end_turn' })
      await until(() => runtime.get(p.id)?.status === 'idle')
      prompts.delete(p.id)
      runtime.prompt(p.id, { text: 'Busy', attachments: [], mentions: [] })
      await until(() => prompts.has(p.id))
      clock += 30 * 60_000
      await control.tick()
      release.markReleaseSwitch(true)
      await control.tick()
      expect(await waitsFor()).toBe('update')
      // The switch stays on through the idle wait so no background tick admits the row first.
      finishes.get(p.id)!({ stopReason: 'end_turn' })
      await until(() => runtime.get(p.id)?.status === 'idle')
      prompts.delete(p.id)
      clock += 61_000
      release.markReleaseSwitch(false)
      await control.tick()
      await until(() => prompts.has(p.id))
      finishes.get(p.id)!({ stopReason: 'end_turn' })
      await until(() => runtime.get(p.id)?.status === 'idle')
    } finally { release.markReleaseSwitch(false) }
    // A retired model's Manager waits for the person to choose a model.
    // Flag the live record before the timer exists, while get() returns it.
    runtime.get(m.id)!.retiredModel = 'retired-model'
    const onManager = (await command(m.id, { operation: 'timer', sessionId: m.id, label: 'Self', message: 'Ping', delayMinutes: 1 })).timer as { id: string }
    clock += 60_000
    await control.tick()
    const modelListed = (await command(m.id, { operation: 'timers', sessionId: m.id })).timers as Array<{ id: string, pending?: { waitingFor?: string } }>
    expect(modelListed.find(t => t.id === onManager.id)?.pending?.waitingFor).toBe('model')
  }, 180_000)

  it('ends timers of deleted chats and notes timers their deletion cancels', async () => {
    const m = await workspaceManager(), p = await manager('Worker'), q = await manager('Other')
    const onP = await heartbeat(m, p)
    control.setHold(p.id, true)
    const byQ = (await command(m.id, { operation: 'timer', sessionId: m.id, label: 'Q', message: 'Ping', delayMinutes: 10 })).timer as { id: string }
    // Retarget the setter to q through the store: q's deletion cancels it.
    database.db.prepare('UPDATE chat_control_timers SET set_by_session = ? WHERE id = ?').run(q.id, byQ.id)
    await runtime.delete(p.id)
    expect(store.timerById(instance, onP.id)).toMatchObject({ state: 'done', reason: 'target_deleted' })
    expect(store.holds(instance)).toHaveLength(0)
    await runtime.delete(q.id)
    const cancelled = store.timerById(instance, byQ.id)!
    expect(cancelled).toMatchObject({ state: 'cancelled', reason: 'creator_deleted' })
    expect(timerNotes(m.id).filter(n => n.timer.id === byQ.id).at(-1)).toMatchObject({ change: 'cancelled' })
    // The sweep ends timers on purged or foreign targets without a delete event.
    const ghost = store.createTimer(instance, { sessionId: 'purged-chat', label: 'G', message: 'Ping', delayMinutes: 10 },
      { kind: 'chat', sessionId: m.id, title: 'Manager', role: 'manager' }, clock)
    const orphan = store.createTimer(instance, { sessionId: m.id, label: 'O', message: 'Ping', delayMinutes: 10 },
      { kind: 'chat', sessionId: 'gone-setter', title: 'Gone' }, clock)
    await control.tick()
    expect(store.timerById(instance, ghost.id)).toMatchObject({ state: 'done', reason: 'target_deleted' })
    expect(store.timerById(instance, orphan.id)).toMatchObject({ state: 'cancelled', reason: 'creator_deleted' })
    expect(timerNotes(m.id).at(-1)).toMatchObject({ change: 'cancelled' })
  }, 120_000)

  it.each(['once', 'every'] as const)('retains an open %s timer turn beyond the admitted-row window', async (kind) => {
    const m = await workspaceManager(), p = await manager('Worker')
    const created = (await command(m.id, { operation: 'timer', sessionId: p.id, label: 'Long turn', message: 'Ping',
      ...(kind === 'once' ? { delayMinutes: 10 } : { everyMinutes: 10 }) })).timer as { id: string }
    clock += 10 * 60_000
    await control.tick()
    await until(() => prompts.has(p.id))
    const turnId = starts(p.id).at(-1)!.turnId
    // Own retention across the clock jump: while paused the background
    // second-ticks are no-ops, so none can consume the finished row
    // before this fixture's exact removal count.
    pauseReleaseBackground()
    try {
      await until(() => releaseBackgroundBusy() === 0)
      clock += 8 * 86_400_000
      expect(store.retainTimers(instance, clock).rows).toBe(0)
      expect(store.timerForTurn(instance, turnId)?.id).toBe(created.id)
      finishes.get(p.id)!({ stopReason: kind === 'once' ? 'end_turn' : 'error', ...(kind === 'every' ? { error: 'Long turn failed' } : {}) })
      await until(() => runtime.get(p.id)?.status === 'idle')
      expect(store.timerById(instance, created.id)).toMatchObject(kind === 'once' ? { state: 'done', reason: 'completed' } : { state: 'active', failures: 1 })
      if (kind === 'every') expect(store.retainTimers(instance, clock).rows).toBe(1)
    } finally { resumeReleaseBackground() }
  }, 60_000)

  it('delivers ordinary messages past an older timer while a release switch waits', async () => {
    const m = await workspaceManager(), p = await manager('Worker')
    const timer = await heartbeat(m, p)
    runtime.prompt(p.id, { text: 'Busy', attachments: [], mentions: [] })
    await until(() => (prompts.get(p.id) ?? []).length === 1)
    clock += 10 * 60_000
    await control.tick()
    expect(store.timerPendingRow(instance, timer.id)).toBeDefined()
    await holdingTimers(async () => {
      finishes.get(p.id)!({ stopReason: 'end_turn' })
      await until(() => runtime.get(p.id)?.status === 'idle')
      store.message(instance, p.id, m.id, 'Ordinary during release', `release:${randomUUID()}`)
      await control.tick()
      await until(() => (prompts.get(p.id) ?? []).length === 2)
      expect(prompts.get(p.id)![1].text).toContain('Ordinary during release')
      expect(store.timerPendingRow(instance, timer.id)).toBeDefined()
      finishes.get(p.id)!({ stopReason: 'end_turn' })
      await until(() => runtime.get(p.id)?.status === 'idle')
    })
    await control.tick()
    await until(() => (prompts.get(p.id) ?? []).length === 3)
    expect(starts(p.id).at(-1)!.source).toMatchObject({ kind: 'timer', timerId: timer.id })
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
  }, 60_000)

  it.each([99, 100])('keeps both delivery candidates at the page boundary with %i bulk chats during a release switch', async (bulkCount) => {
    const m = await workspaceManager(), p = await manager('Worker')
    const timer = await heartbeat(m, p)
    await holdingTimers(async () => {
      clock += 10 * 60_000
      // Store-only recipients need no native work: every timer is waiting
      // for the update, while the real last recipient has an ordinary row.
      for (let i = 0; i < bulkCount; i++) {
        const id = `!page-${instance}-${String(i).padStart(3, '0')}`
        const record = { ...p, id }
        database.db.prepare(`INSERT INTO chat_sessions(id, record, agent, repo, checkout, branch, status, title, instance, created_at, updated_at)
          VALUES(?, ?, 'grok', '', '', '', 'idle', 'Bulk', ?, ?, ?)`)
          .run(id, JSON.stringify(record), instance, new Date(clock).toISOString(), new Date(clock).toISOString())
        const bulk = store.createTimer(instance, { sessionId: id, label: 'Bulk', message: 'Wait', delayMinutes: 10 }, { kind: 'person' }, clock - 10 * 60_000)
        store.fireTimer(instance, bulk.id, clock)
      }
      store.fireTimer(instance, timer.id, clock)
      store.message(instance, p.id, m.id, 'Ordinary at page boundary', `page:${randomUUID()}`)
      const page = store.pending(instance, '', clock)
      expect(new Set(page.map(row => row.recipient)).size).toBe(100)
      if (bulkCount === 99) expect(page.filter(row => row.recipient === p.id)).toHaveLength(2)
      await control.tick()
      if (bulkCount === 100) await control.tick()
      await until(() => prompts.has(p.id))
      expect(prompts.get(p.id)![0].text).toContain('Ordinary at page boundary')
      expect(store.timerPendingRow(instance, timer.id)).toBeDefined()
      finishes.get(p.id)!({ stopReason: 'end_turn' })
      await until(() => runtime.get(p.id)?.status === 'idle')
    })
  }, 60_000)

  it('delivers ordinary messages past an older timer in the person grace period', async () => {
    const m = await workspaceManager(), p = await manager('Worker')
    const timer = await heartbeat(m, p)
    runtime.prompt(p.id, { text: 'Person task', attachments: [], mentions: [] })
    await until(() => (prompts.get(p.id) ?? []).length === 1)
    clock += 10 * 60_000
    await control.tick()
    expect(store.timerPendingRow(instance, timer.id)).toBeDefined()
    let personFinishedAt = 0
    await holdingTimers(async () => {
      finishes.get(p.id)!({ stopReason: 'end_turn' })
      await until(() => runtime.get(p.id)?.status === 'idle')
      const finished = runtime.events(p.id, 0).events.filter(e => e.event.type === 'turn.finished').at(-1)!
      personFinishedAt = Date.parse(finished.at)
      clock = personFinishedAt + 30_000
    })
    store.message(instance, p.id, m.id, 'Ordinary during grace', `grace:${randomUUID()}`)
    await control.tick()
    await until(() => (prompts.get(p.id) ?? []).length === 2)
    expect(prompts.get(p.id)![1].text).toContain('Ordinary during grace')
    expect(store.timerPendingRow(instance, timer.id)).toBeDefined()
    await holdingTimers(async () => {
      finishes.get(p.id)!({ stopReason: 'end_turn' })
      await until(() => runtime.get(p.id)?.status === 'idle')
      clock = personFinishedAt + 59_999
    })
    await control.tick()
    expect(prompts.get(p.id)).toHaveLength(2)
    expect(store.timerPendingRow(instance, timer.id)).toBeDefined()
    clock = personFinishedAt + 60_000
    await control.tick()
    await until(() => (prompts.get(p.id) ?? []).length === 3)
    expect(starts(p.id).at(-1)!.source).toMatchObject({ kind: 'timer', timerId: timer.id })
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
  }, 60_000)

  it.each(['failed', 'paused'] as const)('delivers a timer past an older ordinary row blocked by a %s queue', async (state) => {
    const m = await workspaceManager(), p = await manager('Worker')
    if (state === 'failed') {
      runtime.prompt(p.id, { text: 'First', attachments: [], mentions: [] })
      await until(() => (prompts.get(p.id) ?? []).length === 1)
      await runtime.enqueue(p.id, randomUUID(), { text: 'Queued doomed', attachments: [], mentions: [] })
      finishes.get(p.id)!({ stopReason: 'end_turn' })
      await until(() => (prompts.get(p.id) ?? []).length === 2)
      finishes.get(p.id)!({ stopReason: 'error', error: 'Queue failure' })
      await until(() => runtime.get(p.id)?.status === 'idle')
    } else await runtime.enqueue(p.id, randomUUID(), { text: 'Paused task', attachments: [], mentions: [] })
    const queue = runtime.get(p.id)!.queue!
    expect(queue.ready).toBe(false)
    expect(queue.items).toHaveLength(1)
    expect(queue.items[0].state).toBe(state === 'failed' ? 'failed' : 'waiting')
    store.message(instance, p.id, m.id, 'Ordinary behind queue', `queue:${randomUUID()}`)
    const ordinary = store.inbox(instance, p.id).find(row => row.body === 'Ordinary behind queue')!
    const timer = await heartbeat(m, p, { delayMinutes: 1 })
    const count = (prompts.get(p.id) ?? []).length
    clock += 2 * 60_000
    await control.tick()
    await until(() => (prompts.get(p.id) ?? []).length === count + 1)
    expect(starts(p.id).at(-1)!.source).toMatchObject({ kind: 'timer', timerId: timer.id })
    const firing = store.inbox(instance, p.id).find(row => row.timer_id === timer.id)!
    expect(ordinary.seq).toBeLessThan(firing.seq)
    expect(store.inbox(instance, p.id).find(row => row.seq === ordinary.seq)?.state).toBe('pending')
    expect(runtime.get(p.id)!.queue).toEqual(queue)
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => store.timerById(instance, timer.id)?.state === 'done')
    if (state === 'paused') {
      // Completing the admitted turn arms the waiting task queue normally.
      await until(() => (prompts.get(p.id) ?? []).length === count + 2)
      expect(prompts.get(p.id)!.at(-1)!.text).toContain('Paused task')
      finishes.get(p.id)!({ stopReason: 'end_turn' })
    }
  }, 60_000)

  it('lets ordinary messages and another timer pass an older firing in backoff', async () => {
    const m = await workspaceManager(), p = await manager('Worker')
    const count = () => (prompts.get(p.id) ?? []).length
    const backedOff = (await command(m.id, { operation: 'timer', sessionId: p.id, label: 'Backoff', message: 'Retry', everyMinutes: 30 })).timer as { id: string }
    clock += 30 * 60_000
    await control.tick()
    await until(() => count() === 1)
    await holdingTimers(async () => {
      finishes.get(p.id)!({ stopReason: 'error', error: 'boom' })
      await until(() => runtime.get(p.id)?.status === 'idle')
    })
    const notBefore = store.timerById(instance, backedOff.id)!.notBefore
    const other = await heartbeat(m, p, { label: 'Other', delayMinutes: 31 })
    clock += 30 * 60_000
    store.fireTimer(instance, backedOff.id, clock)
    expect(store.timerPendingRow(instance, backedOff.id)).toBeDefined()
    store.message(instance, p.id, m.id, 'Ordinary after backoff', `backoff:${randomUUID()}`)
    clock += 60_000
    await control.tick()
    await until(() => count() === 2)
    expect(prompts.get(p.id)![1].text).toContain('Ordinary after backoff')
    await holdingTimers(async () => {
      finishes.get(p.id)!({ stopReason: 'end_turn' })
      await until(() => runtime.get(p.id)?.status === 'idle')
    })
    await control.tick()
    await until(() => count() === 3)
    expect(starts(p.id).at(-1)!.source).toMatchObject({ kind: 'timer', timerId: other.id })
    expect(store.timerPendingRow(instance, backedOff.id)).toBeDefined()
    expect(store.timerById(instance, backedOff.id)!.notBefore).toBe(notBefore)
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
  }, 120_000)

  it.each(['chat', 'all', 'stop'] as const)('accounts missed held occurrences at the actual %s hold release', async (hold) => {
    const m = await workspaceManager(), p = await manager('Worker')
    const every = (await command(m.id, { operation: 'timer', sessionId: p.id, label: 'Every', message: 'Ping', everyMinutes: 30 })).timer as { id: string }
    const once = await heartbeat(m, p)
    if (hold === 'all') control.setAllHeld(true)
    else if (hold === 'chat') control.setHold(p.id, true)
    else {
      runtime.prompt(p.id, { text: 'Work', attachments: [], mentions: [] })
      await until(() => prompts.has(p.id))
      await runtime.cancel(p.id, { kind: 'person' })
      await until(() => runtime.get(p.id)?.status === 'idle')
      prompts.delete(p.id)
    }
    clock += 9 * 60_000
    await control.tick()
    clock += 22 * 60_000
    // No held tick observes either due occurrence before Resume.
    if (hold === 'all') control.setAllHeld(false)
    else if (hold === 'chat') control.setHold(p.id, false)
    else {
      runtime.prompt(p.id, { text: 'Resume my work', attachments: [], mentions: [] })
      await until(() => prompts.has(p.id))
      finishes.get(p.id)!({ stopReason: 'end_turn' })
      await until(() => runtime.get(p.id)?.status === 'idle')
      prompts.delete(p.id)
    }
    expect(store.timerById(instance, once.id)).toMatchObject({ state: 'expired', reason: 'skipped_while_held', skipped: 1 })
    expect(store.timerById(instance, every.id)).toMatchObject({ skipped: 1, nextAt: new Date(clock + 29 * 60_000).toISOString() })
    // A due occurrence after release remains deliverable even if no tick ran
    // between Resume and this next phase point.
    clock += 30 * 60_000
    await control.tick()
    await until(() => prompts.has(p.id))
    expect(starts(p.id).at(-1)!.source).toMatchObject({ kind: 'timer', timerId: every.id, missed: 0 })
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
  }, 120_000)

  it('retains ended timers for 30 days and admitted rows for 7, in bounded batches', async () => {
    const m = await workspaceManager(), p = await manager('Worker')
    const live = (await command(m.id, { operation: 'timer', sessionId: p.id, label: 'Live', message: 'Ping', everyMinutes: 30 })).timer as { id: string }
    clock += 30 * 60_000
    await control.tick()
    await until(() => prompts.has(p.id))
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    const setter = { kind: 'chat', sessionId: m.id, title: 'Manager', role: 'manager' } as const
    const ended: string[] = []
    for (let i = 0; i < 101; i++) {
      const timer = store.createTimer(instance, { sessionId: p.id, label: `E${i}`, message: 'Ping', delayMinutes: 10 }, setter, clock)
      store.cancelTimer(instance, timer.id, setter, clock)
      ended.push(timer.id)
    }
    database.db.prepare('DELETE FROM chat_control_inbox WHERE instance = ? AND timer_id = ?').run(instance, live.id)
    for (let i = 0; i < 501; i++) {
      database.db.prepare(`INSERT INTO chat_control_inbox(instance, recipient, sender, event_key, body, created_at, state, turn_id, admitted_at, timer_id, timer_missed)
        VALUES(?, ?, ?, ?, ?, ?, 'admitted', ?, ?, ?, 0)`)
        .run(instance, p.id, m.id, `retained:${i}:${randomUUID()}`, 'Ping', clock - 8 * 86_400_000, randomUUID(), clock - 8 * 86_400_000, live.id)
    }
    clock += 31 * 86_400_000
    await control.tick()
    const remaining = ended.filter(id => store.timerById(instance, id) !== null)
    expect(remaining).toHaveLength(1)
    const rows = database.db.prepare(`SELECT COUNT(*) AS n FROM chat_control_inbox WHERE instance = ? AND timer_id = ? AND event_key LIKE 'retained:%'`)
      .get(instance, live.id) as { n: number }
    expect(rows.n).toBe(1)
    expect(store.timerById(instance, live.id)!.state).toBe('active')
  }, 120_000)

  it('delivers ordinary rows in order and lets timers pass only where ordinary delivery does not run', async () => {
    const m = await workspaceManager(), p = await manager('Worker')
    // Older ordinary, newer timer: the ordinary row goes first, the timer next.
    store.message(instance, p.id, m.id, 'Ordinary first', `order:1:${randomUUID()}`)
    const first = store.inbox(instance, p.id).find(m => m.body === 'Ordinary first')!.seq
    const created = (await command(m.id, { operation: 'timer', sessionId: p.id, label: 'T', message: 'Ping', delayMinutes: 10 })).timer as { id: string }
    clock += 10 * 60_000
    await control.tick()
    await until(() => prompts.has(p.id))
    expect(prompts.get(p.id)).toHaveLength(1)
    expect(prompts.get(p.id)![0].text).toContain('Ordinary first')
    await holdingTimers(async () => {
      finishes.get(p.id)!({ stopReason: 'end_turn' })
      await until(() => runtime.get(p.id)?.status === 'idle')
    })
    prompts.delete(p.id)
    clock += 61_000
    await control.tick()
    await until(() => prompts.has(p.id))
    expect(prompts.get(p.id)![0].text).toContain('[Poise timer')
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    const timerRow = store.inbox(instance, p.id).find(m => m.timer_id === created.id)!
    expect(timerRow.state).toBe('admitted')
    expect(first).toBeLessThan(timerRow.seq)
  }, 60_000)

  it('passes a paused ordinary message and an interrupted chat, and retries a failed start', async () => {
    // The crashed server's lease must look like a dead process held it.
    await control.stop()
    await runtime.stop()
    runtime = makeRuntime({ hostPid: spawnSync('true').pid, now: () => Date.now() - 120_000 })
    control = new Control(runtime, { ci, now: () => clock })
    control.attach(server)
    control.start()
    const m = await workspaceManager(), p = await manager('Worker')
    // Paused ordinary: the timer passes it.
    store.message(instance, p.id, m.id, 'Paused ordinary', `paused:${randomUUID()}`)
    store.pauseDelivery(instance, p.id)
    await command(m.id, { operation: 'timer', sessionId: p.id, label: 'T', message: 'Ping', delayMinutes: 10 })
    clock += 10 * 60_000
    await control.tick()
    await until(() => prompts.has(p.id))
    expect(prompts.get(p.id)!.at(-1)!.text).toContain('[Poise timer')
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    // Interrupted: the old prompt is not resent; the timer turn starts clean.
    prompts.delete(p.id)
    runtime.prompt(p.id, { text: 'Cut short', attachments: [], mentions: [] })
    await until(() => prompts.has(p.id))
    store.message(instance, p.id, m.id, 'Ordinary during interruption', `interrupted:${randomUUID()}`)
    // Crash: a new runtime for the same instance with no shutdown in between.
    await control.stop()
    runtime.removeAllListeners('event')
    runtime = makeRuntime()
    control = new Control(runtime, { ci, now: () => clock })
    control.attach(server)
    await runtime.recover()
    control.start()
    expect(runtime.get(p.id)?.status).toBe('interrupted')
    prompts.delete(p.id)
    const revived = (await command(m.id, { operation: 'timer', sessionId: p.id, label: 'R', message: 'Ping', delayMinutes: 10 })).timer as { id: string }
    clock += 10 * 60_000
    await control.tick()
    await until(() => prompts.has(p.id))
    expect(prompts.get(p.id)!.at(-1)!.text).toContain('[Poise timer')
    expect(prompts.get(p.id)!.at(-1)!.text).not.toContain('Cut short')
    expect(starts(p.id).at(-1)!.source).toMatchObject({ kind: 'timer', timerId: revived.id })
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    const ordinary = store.inbox(instance, p.id).find(m => m.body === 'Ordinary during interruption')!
    expect(ordinary.state).toBe('pending')
    // A chat left error by a failed native start is admitted with its start retried.
    const failing = await manager('Failing')
    failStarts.add(failing.id)
    const onFailing = (await command(m.id, { operation: 'timer', sessionId: failing.id, label: 'F', message: 'Ping', delayMinutes: 10 })).timer as { id: string }
    runtime.prompt(failing.id, { text: 'Will fail to start', attachments: [], mentions: [] })
    await until(() => runtime.get(failing.id)?.status === 'error')
    clock += 10 * 60_000
    await control.tick()
    await until(() => starts(failing.id).some(s => s.source?.kind === 'timer'))
    await until(() => store.timerById(instance, onFailing.id)!.failures === 1)
    expect(runtime.get(failing.id)?.status).toBe('error')
    expect(store.holds(instance).filter(h => h.sessionId === failing.id)).toHaveLength(0)
  }, 180_000)

  it('refuses timer work while draining, shapes bad input, and budgets mutating operations', async () => {
    const m = await workspaceManager(), p = await manager('Worker')
    const created = await heartbeat(m, p)
    runtime.startDrain('test')
    try {
      await expect(command(m.id, { operation: 'timer', sessionId: p.id, label: 'L', message: 'Ping', delayMinutes: 10 })).rejects.toThrow('Poise is draining')
      await expect(command(m.id, { operation: 'rearmTimer', timerId: created.id })).rejects.toThrow('Poise is draining')
      await command(m.id, { operation: 'timers', sessionId: p.id })
      await command(m.id, { operation: 'cancelTimer', timerId: created.id })
    } finally { runtime.endDrain() }
    // Bad shapes fail as the standard refusals or the schedule error, never a crash.
    await expect(command(m.id, { operation: 'timer', sessionId: 7, label: 'L', message: 'Ping', delayMinutes: 10 })).rejects.toThrow('sessionId is required')
    await expect(command(m.id, { operation: 'timer', sessionId: randomUUID(), label: 'L', message: 'Ping', delayMinutes: 10 })).rejects.toThrow('unknown chat')
    await expect(command(m.id, { operation: 'timer', sessionId: p.id, label: 'L', message: 'Ping', delayMinutes: '5' })).rejects.toThrow('use exactly one of delayMinutes (1–10080) or everyMinutes (5–1440)')
    // The budget counts timer operations; reads and cancelTimer pass through.
    // Receipt scopes are per chat: control:<instance>:<chat>.
    for (let i = 0; i < 120; i++) {
      database.db.prepare('INSERT INTO chat_command_receipts(instance, request_id, fingerprint, ack, created_at, operation) VALUES(?, ?, ?, ?, ?, ?)')
        .run(`control:${instance}:${m.id}`, randomUUID(), `fp:${i}`, '{}', new Date(clock).toISOString(), 'timer')
    }
    await expect(command(m.id, { operation: 'timer', sessionId: p.id, label: 'L', message: 'Ping', delayMinutes: 10 })).rejects.toThrow('120 control actions')
    await command(m.id, { operation: 'timers', sessionId: p.id })
    const extra = store.createTimer(instance, { sessionId: p.id, label: 'E', message: 'Ping', delayMinutes: 10 },
      { kind: 'chat', sessionId: m.id, title: 'Manager', role: 'manager' }, clock)
    await command(m.id, { operation: 'cancelTimer', timerId: extra.id })
  }, 120_000)

  it('keeps one pending row per timer at the database level', async () => {
    const m = await workspaceManager(), p = await manager('Worker')
    const created = (await command(m.id, { operation: 'timer', sessionId: p.id, label: 'T', message: 'Ping', delayMinutes: 10 })).timer as { id: string }
    runtime.prompt(p.id, { text: 'Busy', attachments: [], mentions: [] })
    await until(() => prompts.has(p.id))
    clock += 10 * 60_000
    await control.tick()
    expect(store.timerPendingRow(instance, created.id)).toBeDefined()
    expect(() => database.db.prepare(`INSERT INTO chat_control_inbox(instance, recipient, sender, event_key, body, created_at, timer_id)
      VALUES(?, ?, ?, ?, ?, ?, ?)`).run(instance, p.id, 'Poise timer', `timer:${created.id}:2`, 'Ping', clock, created.id))
      .toThrow('UNIQUE constraint failed: chat_control_inbox.instance, chat_control_inbox.timer_id')
    await holdingTimers(async () => {
      finishes.get(p.id)!({ stopReason: 'end_turn' })
      await until(() => runtime.get(p.id)?.status === 'idle')
    })
  }, 60_000)

  it('marks timer turns for the finished-turn alert and leaves person turns unmarked', async () => {
    const producers = await import('../server/alerts/producers')
    const finished = vi.mocked(producers.chatTurnFinished)
    finished.mockClear()
    const m = await workspaceManager(), p = await manager('Worker')
    await heartbeat(m, p)
    clock += 10 * 60_000
    await control.tick()
    await until(() => prompts.has(p.id))
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    const timerCall = finished.mock.calls.find(call => call[1].timer === true)
    expect(timerCall).toBeDefined()
    prompts.delete(p.id)
    runtime.prompt(p.id, { text: 'Person turn', attachments: [], mentions: [] })
    await until(() => prompts.has(p.id))
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    const personCalls = finished.mock.calls.filter(call => call[1].timer === undefined)
    expect(personCalls.length).toBeGreaterThan(0)
    expect(finished.mock.calls.every(call => call[1].timer === true || call[1].timer === undefined)).toBe(true)
  }, 60_000)

  it('reports scheduler status, decouples CI reads, and isolates failing items', async () => {
    const m = await workspaceManager(), p = await manager('Worker')
    await control.tick()
    expect(control.status()).toMatchObject({ running: true })
    expect(typeof control.status().lastTickAt).toBe('string')
    control.failStart(new Error('startup reconciliation failed'))
    expect(control.status()).toMatchObject({ running: false, error: 'startup reconciliation failed' })
    // A never-started control reports itself down.
    const idleRuntime = makeRuntime()
    const idle = new Control(idleRuntime, { ci, now: () => clock })
    expect(idle.status()).toMatchObject({ running: false, lastTickAt: null })
    const { handleChatApi } = await import('../server/chat/transport')
    const idleServer = createServer((req, res) => { void handleChatApi(req, res, req.url!, runtime, undefined, true, idle) })
    await new Promise<void>(done => idleServer.listen(0, '127.0.0.1', done))
    const idleAddress = idleServer.address()
    if (!idleAddress || typeof idleAddress === 'string') throw new Error('fixture needs TCP')
    const idleOrigin = `http://127.0.0.1:${idleAddress.port}`
    try {
      const down = await (await fetch(`${idleOrigin}/api/chat/sessions/${p.id}/timers`)).json() as { scheduler: Record<string, unknown> }
      expect(down.scheduler).toMatchObject({ running: false, lastTickAt: null })
      const live = await (await fetch(`${origin}/api/chat/sessions/${p.id}/timers`)).json() as
        { timers: unknown[], holds: unknown[], allHeld: unknown, scheduler: Record<string, unknown> }
      expect(live.scheduler).toMatchObject({ running: false, error: 'startup reconciliation failed' })
      expect(Array.isArray(live.timers) && Array.isArray(live.holds)).toBe(true)
      expect(live.allHeld).toMatchObject({ held: false })
    } finally {
      await new Promise<void>(done => idleServer.close(() => done()))
      await idle.stop()
      await idleRuntime.stop()
    }
    // A stuck CI read never delays timers or delivery.
    await command(m.id, { operation: 'bind', target: 'https://github.com/acme/app/pull/9' })
    ci.mockImplementationOnce(() => new Promise<CiObservation>(() => {}))
    const created = await heartbeat(m, p)
    clock += 10 * 60_000
    await control.tick()
    await until(() => prompts.has(p.id))
    expect(prompts.get(p.id)!.at(-1)!.text).toContain('[Poise timer')
    expect(ci).toHaveBeenCalled()
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    expect(store.timerById(instance, created.id)!.state).toBe('done')
  }, 120_000)

  it('warns once per corrupt item and once per hour-long wait', async () => {
    const m = await workspaceManager(), p = await manager('Worker')
    const watchId = randomUUID()
    database.db.prepare(`INSERT INTO chat_control_watches(id, instance, owner, targets, instruction, interval_ms, next_at, enabled)
      VALUES(?, ?, ?, ?, ?, ?, ?, 1)`).run(watchId, instance, m.id, 'not json', 'Watch nothing', 60_000, clock)
    const created = (await command(m.id, { operation: 'timer', sessionId: p.id, label: 'T', message: 'Ping', delayMinutes: 10 })).timer as { id: string }
    store.message(instance, p.id, m.id, 'Ordinary alongside', `alongside:${randomUUID()}`)
    clock += 10 * 60_000
    await control.tick()
    await until(() => prompts.has(p.id))
    // The corrupt watch warns once while timers and delivery continue.
    const failed = () => reported('chat.control.item_failed').filter(e => e.target === watchId)
    expect(failed()).toHaveLength(1)
    await control.tick()
    expect(failed()).toHaveLength(1)
    await holdingTimers(async () => {
      finishes.get(p.id)!({ stopReason: 'end_turn' })
      await until(() => runtime.get(p.id)?.status === 'idle')
    })
    // An hour-long wait warns once with its cause.
    prompts.delete(p.id)
    runtime.prompt(p.id, { text: 'Busy for an hour', attachments: [], mentions: [] })
    await until(() => prompts.has(p.id))
    const waiting = (await command(m.id, { operation: 'timer', sessionId: p.id, label: 'W', message: 'Ping', everyMinutes: 30 })).timer as { id: string }
    clock += 30 * 60_000
    await control.tick()
    clock += 61 * 60_000
    await control.tick()
    const long = () => reported('chat.timer.changed').filter(e => e.target === waiting.id)
    expect(long()).toHaveLength(1)
    expect(long()[0].severity).toBe('warning')
    expect(long()[0].context).toMatchObject({ change: 'waiting_long', waitingFor: 'running' })
    await control.tick()
    expect(long()).toHaveLength(1)
    await holdingTimers(async () => {
      finishes.get(p.id)!({ stopReason: 'end_turn' })
      await until(() => runtime.get(p.id)?.status === 'idle')
    })
    expect(store.timerById(instance, created.id)!.state).toBe('active')
  }, 120_000)

  it('ends one-shots whose turn was stopped or cut, and keeps every-timers scheduled', async () => {
    const m = await workspaceManager(), p = await manager('Worker')
    const count = () => (prompts.get(p.id) ?? []).length
    // A Manager stop ends a one-shot: it fired its single occurrence.
    const once = await heartbeat(m, p)
    clock += 10 * 60_000
    await control.tick()
    await until(() => count() === 1)
    await command(m.id, { operation: 'stop', sessionId: p.id })
    await until(() => runtime.get(p.id)?.status === 'idle')
    expect(store.timerById(instance, once.id)).toMatchObject({ state: 'done', reason: 'turn_failed' })
    expect(timerNotes(p.id).at(-1)).toMatchObject({ change: 'ended' })
    expect(runtime.get(p.id)!.timers ?? []).toHaveLength(0)
    // The same stop leaves an every-timer on its schedule.
    const every = (await command(m.id, { operation: 'timer', sessionId: p.id, label: 'Every', message: 'Ping', everyMinutes: 30 })).timer as { id: string }
    clock += 30 * 60_000
    await control.tick()
    await until(() => count() === 2)
    const phase = store.timerById(instance, every.id)!.nextAt
    await command(m.id, { operation: 'stop', sessionId: p.id })
    await until(() => runtime.get(p.id)?.status === 'idle')
    expect(store.timerById(instance, every.id)).toMatchObject({ state: 'active', failures: 0, nextAt: phase })
    clock += 30 * 60_000
    await control.tick()
    await until(() => count() === 3)
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    expect(store.timerById(instance, every.id)!.failures).toBe(0)
    // A restart that cuts a one-shot's turn ends it with its diagnostic.
    const cut = await heartbeat(m, p)
    clock += 10 * 60_000
    await control.tick()
    await until(() => count() === 4)
    expect(prompts.get(p.id)!.at(-1)!.text).toContain(cut.id)
    await control.stop()
    runtime.removeAllListeners('event')
    runtime = makeRuntime()
    control = new Control(runtime, { ci, now: () => clock })
    control.attach(server)
    await runtime.recover()
    control.start()
    expect(runtime.get(p.id)?.status).toBe('interrupted')
    expect(store.timerById(instance, cut.id)).toMatchObject({ state: 'done', reason: 'turn_failed' })
    expect(timerNotes(p.id).at(-1)).toMatchObject({ change: 'ended' })
    const interruptions = reported('chat.timer.changed').filter(e => e.target === cut.id)
    expect(interruptions).toHaveLength(1)
    expect(interruptions[0].severity).toBe('warning')
  }, 120_000)

  it('expires one-shots that already fired when a hold lands', async () => {
    const m = await workspaceManager(), p = await manager('Worker'), q = await manager('Other')
    // A firing already waiting when the person stops the chat expires.
    const once = await heartbeat(m, p)
    runtime.prompt(p.id, { text: 'Busy', attachments: [], mentions: [] })
    await until(() => prompts.has(p.id))
    clock += 10 * 60_000
    await control.tick()
    expect(store.timerPendingRow(instance, once.id)).toBeDefined()
    await runtime.cancel(p.id, { kind: 'person' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    prompts.delete(p.id)
    await control.tick()
    expect(store.timerById(instance, once.id)).toMatchObject({ state: 'expired', reason: 'skipped_while_held', skipped: 1 })
    expect(store.timerPendingRow(instance, once.id)).toBeUndefined()
    expect(timerNotes(p.id).at(-1)).toMatchObject({ change: 'ended' })
    // Releasing the hold resurrects nothing: the timer stays expired.
    runtime.prompt(p.id, { text: 'Back', attachments: [], mentions: [] })
    await until(() => prompts.has(p.id))
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    await control.tick()
    expect(store.timerById(instance, once.id)!.state).toBe('expired')
    // A Hold toggle mid-turn expires the one-shot; its finish changes nothing.
    const mid = await heartbeat(m, q)
    clock += 10 * 60_000
    await control.tick()
    await until(() => prompts.has(q.id))
    control.setHold(q.id, true)
    await control.tick()
    expect(store.timerById(instance, mid.id)).toMatchObject({ state: 'expired', reason: 'skipped_while_held' })
    const notesBefore = timerNotes(q.id).length
    finishes.get(q.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(q.id)?.status === 'idle')
    expect(store.timerById(instance, mid.id)).toMatchObject({ state: 'expired', reason: 'skipped_while_held' })
    expect(timerNotes(q.id)).toHaveLength(notesBefore)
  }, 120_000)

  it('ignores turns that finish after their timer was cancelled', async () => {
    const m = await workspaceManager(), p = await manager('Worker')
    const rep = (await command(m.id, { operation: 'timer', sessionId: p.id, label: 'Rep', message: 'Ping', everyMinutes: 30 })).timer as { id: string }
    for (let i = 0; i < 2; i++) {
      clock += 30 * 60_000
      await control.tick()
      await until(() => prompts.has(p.id))
      prompts.delete(p.id)
      finishes.get(p.id)!({ stopReason: 'error', error: 'boom' })
      await until(() => runtime.get(p.id)?.status === 'idle')
      clock = Date.parse(store.timerById(instance, rep.id)!.notBefore!)
    }
    expect(store.timerById(instance, rep.id)).toMatchObject({ failures: 2 })
    await control.tick()
    await until(() => prompts.has(p.id))
    await command(m.id, { operation: 'cancelTimer', timerId: rep.id })
    const notesBefore = timerNotes(p.id).length
    finishes.get(p.id)!({ stopReason: 'error', error: 'third boom' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    // Still cancelled: no trip, no warning, no new note.
    expect(store.timerById(instance, rep.id)).toMatchObject({ state: 'cancelled', reason: 'cancelled_by_manager', failures: 2 })
    expect(timerNotes(p.id)).toHaveLength(notesBefore)
    expect(reported('chat.timer.changed').filter(e => e.target === rep.id)).toHaveLength(0)
    // A cancelled one-shot whose turn then succeeds stays cancelled.
    prompts.delete(p.id)
    const once = await heartbeat(m, p)
    clock += 10 * 60_000
    await control.tick()
    await until(() => prompts.has(p.id))
    await command(m.id, { operation: 'cancelTimer', timerId: once.id })
    const onceNotes = timerNotes(p.id).length
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    expect(store.timerById(instance, once.id)).toMatchObject({ state: 'cancelled', reason: 'cancelled_by_manager' })
    expect(timerNotes(p.id)).toHaveLength(onceNotes)
  }, 120_000)

  it('tripping drops the queued firing so other timers still deliver', async () => {
    const m = await workspaceManager(), p = await manager('Worker')
    const tripper = (await command(m.id, { operation: 'timer', sessionId: p.id, label: 'Tripper', message: 'Ping', everyMinutes: 30 })).timer as { id: string }
    for (let i = 0; i < 2; i++) {
      clock += 30 * 60_000
      await control.tick()
      await until(() => prompts.has(p.id))
      prompts.delete(p.id)
      finishes.get(p.id)!({ stopReason: 'error', error: 'boom' })
      await until(() => runtime.get(p.id)?.status === 'idle')
      clock = Date.parse(store.timerById(instance, tripper.id)!.notBefore!)
    }
    await control.tick()
    await until(() => prompts.has(p.id))
    prompts.delete(p.id)
    // A second firing queues while the third turn runs, older than any other row.
    clock += 30 * 60_000
    await control.tick()
    expect(store.timerPendingRow(instance, tripper.id)).toBeDefined()
    const other = (await command(m.id, { operation: 'timer', sessionId: p.id, label: 'Other', message: 'Ping', everyMinutes: 30 })).timer as { id: string }
    clock += 30 * 60_000
    await control.tick()
    expect(store.timerPendingRow(instance, other.id)).toBeDefined()
    finishes.get(p.id)!({ stopReason: 'error', error: 'third boom' })
    // Other's firing already waits: without the hold, a background tick
    // admits it before the first poll sees the trip's idle.
    await holdingTimers(async () => {
      await until(() => runtime.get(p.id)?.status === 'idle')
    })
    expect(store.timerById(instance, tripper.id)!.state).toBe('tripped')
    // The orphan is gone, so the other timer's older-second row still delivers.
    expect(store.timerPendingRow(instance, tripper.id)).toBeUndefined()
    await holdingTimers(async () => {
      await until(() => runtime.get(p.id)?.status === 'idle')
    })
    await control.tick()
    await until(() => prompts.has(p.id))
    expect(prompts.get(p.id)!.at(-1)!.text).toContain(`[Poise timer ${other.id} "Other"`)
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(p.id)?.status === 'idle')
    // Re-arming starts clean: no stale firing delivers.
    prompts.delete(p.id)
    await command(m.id, { operation: 'rearmTimer', timerId: tripper.id })
    await control.tick()
    expect(store.timerPendingRow(instance, tripper.id)).toBeUndefined()
    expect(prompts.has(p.id)).toBe(false)
    clock += 30 * 60_000
    await control.tick()
    await until(() => prompts.has(p.id))
    const source = starts(p.id).at(-1)!.source as Extract<TurnSource, { kind: 'timer' }>
    expect(source).toMatchObject({ kind: 'timer', timerId: tripper.id, missed: 0 })
    finishes.get(p.id)!({ stopReason: 'end_turn' })
    // Other fires on the same tick: hold its admission out of this idle.
    await holdingTimers(async () => {
      await until(() => runtime.get(p.id)?.status === 'idle')
    })
  }, 180_000)
})
