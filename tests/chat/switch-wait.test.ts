import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentId, ChatEnvelope, PromptInput } from '../../server/chat/protocol'
import type { Adapter, AdapterHost, AdapterStartOptions, TurnResult } from '../../server/chat/adapters/types'
import { CATALOG } from '../model-catalog-fixture'

let root: string
let Runtime: typeof import('../../server/chat/runtime').ChatRuntime
let storage: typeof import('../../server/chat/storage')
let database: typeof import('../../server/db')
let Control: typeof import('../../server/chat/control').ChatControl
let inbox: typeof import('../../server/chat/control-store')
let Service: typeof import('../../server/service/control').ServiceControl
let background: typeof import('../../server/release-background')
const runtimes: InstanceType<typeof Runtime>[] = []
const controls: InstanceType<typeof Control>[] = []
const servers: Server[] = []
const pause = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))
vi.setConfig({ testTimeout: 25_000, hookTimeout: 25_000 })
async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) { if (Date.now() > end) throw new Error('Switch condition did not settle'); await pause() }
}
const input = (text: string): PromptInput => ({ text, attachments: [], mentions: [] })
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status) throw new Error(r.stderr)
  return r.stdout.trim()
}
interface Controls { auto: boolean, calls: { agent: AgentId, input: PromptInput, turnId: string }[], adapters: Fake[], compactGate?: Promise<void>, compactions: number }
class Fake implements Adapter {
  alive = false
  nativeSessionId: string | undefined
  capabilities = { steer: true, fork: true, thought: true, plan: false, commands: false, modes: false, permissions: true, questions: true, resume: true, images: false }
  options?: AdapterStartOptions
  finish?: (result: TurnResult) => void
  constructor(readonly agent: AgentId, readonly host: AdapterHost, readonly c: Controls) { c.adapters.push(this) }
  async start(options: AdapterStartOptions) {
    this.options = options; this.nativeSessionId = options.resume || randomUUID(); this.alive = true
    return { ...options, nativeSessionId: this.nativeSessionId, capabilities: this.capabilities }
  }
  async prompt(turnId: string, prompt: PromptInput, signal: AbortSignal): Promise<TurnResult> {
    this.c.calls.push({ agent: this.agent, input: prompt, turnId })
    this.host.emit({ type: 'text.delta', turnId, messageId: turnId, delta: `Completed by ${this.agent}` })
    if (this.c.auto) return { stopReason: 'end_turn' }
    return await new Promise<TurnResult>(resolve => {
      this.finish = result => { this.finish = undefined; resolve(result) }
      signal.addEventListener('abort', () => this.finish?.({ stopReason: 'cancelled' }), { once: true })
    })
  }
  async cancel() { this.finish?.({ stopReason: 'cancelled' }) }
  async compact(_turnId: string, _memories: string, signal: AbortSignal): Promise<TurnResult> {
    this.c.compactions += 1
    if (this.c.compactGate) await Promise.race([this.c.compactGate,
      new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))])
    return { stopReason: signal.aborted ? 'cancelled' : 'end_turn' }
  }
  async steer(_text: string) {}
  async close() { this.alive = false; this.finish?.({ stopReason: 'cancelled' }) }
  async setModel(modelId: string, effort: string) { return { modelId, effort } }
  async setMode() {}
  async fork() { return randomUUID() }
  onExit() {}
}
class FakeTimer {
  timers = new Map<number, { delayMs: number, callback: () => void }>()
  private ids = 0
  setTimeout(callback: () => void, delayMs: number): number {
    this.timers.set(++this.ids, { delayMs, callback })
    return this.ids
  }
  clearTimeout(timer: unknown): void { this.timers.delete(timer as number) }
  fire(): void {
    const [id, timer] = [...this.timers.entries()][0]
    this.timers.delete(id)
    timer.callback()
  }
}
async function world(options: { auto?: boolean, deferStart?: boolean } = {}) {
  const repo = join(root, randomUUID()); await mkdir(repo)
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 'Switch test'); git(repo, 'config', 'user.email', 'switch@example.invalid')
  git(repo, 'config', 'commit.gpgSign', 'false'); git(repo, 'config', 'core.hooksPath', '/dev/null')
  await writeFile(join(repo, 'README.md'), '# Switch fixture\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'fixture')
  const instance = `switch-test:${randomUUID()}`
  const c: Controls = { auto: options.auto ?? true, calls: [], adapters: [], compactions: 0 }
  function make() {
    const runtime = new Runtime({ instance, instanceLabel: 'switch-test', callerTurns: null, idleTimeoutMinutes: () => 0,
      catalog: async () => CATALOG, resolveCheckout: async () => repo, requireClaudeReady: async () => {},
      adapters: Object.fromEntries((['grok', 'claude', 'codex', 'muse'] as AgentId[]).map(agent => [agent, (host: AdapterHost) => new Fake(agent, host, c)])),
    })
    runtimes.push(runtime); return runtime
  }
  const runtime = make()
  const events: ChatEnvelope[] = []; runtime.on('event', event => events.push(event))
  const logs: string[] = []; runtime.on('log', line => logs.push(line))
  const modelFor = (agent: AgentId): string => {
    const found = CATALOG.models.find(m => m.provider === agent)
    if (!found) throw new Error(`fixture lacks ${agent}`)
    return found.identity
  }
  const session = (agent: AgentId = 'grok') => runtime.create({ agent, model: modelFor(agent), repo: 'test/switch', branch: { new: randomUUID() }, deferStart: options.deferStart })
  const s = await session()
  await until(() => runtime.get(s.id)?.status === 'idle')
  const finish = (stopReason: 'end_turn' | 'cancelled' | 'error' = 'end_turn') => [...c.adapters].reverse().find(adapter => adapter.finish)?.finish?.({ stopReason })
  const turns = (id: string) => runtime.events(id, 0).events.filter(e => e.event.type === 'turn.finished')
  return { runtime, c, s, session, make, finish, turns, repo, events, logs, instance }
}
async function releases(): Promise<string> {
  const dir = await mkdtemp(join(root, 'releases-'))
  await mkdir(join(dir, 'r2'))
  await writeFile(join(dir, 'r2', 'base'), 'b1\n')
  await writeFile(join(dir, 'r2', 'installed'), '')
  return dir
}
async function tickControl(runtime: InstanceType<typeof Runtime>) {
  const control = new Control(runtime, { ci: async () => ({ head: 'a'.repeat(40), failing: [] }) })
  const server = createServer(() => {})
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  control.attach(server)
  control.start()
  controls.push(control); servers.push(server)
  return control
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-switch-wait-'))
  vi.stubEnv('POISE_DB', join(root, 'db.sqlite3')); vi.stubEnv('POISE_LOCK_DIR', join(root, 'locks')); vi.stubEnv('POISE_EDITOR_DIR', join(root, 'editor'))
  ;({ ChatRuntime: Runtime } = await import('../../server/chat/runtime'))
  storage = await import('../../server/chat/storage')
  database = await import('../../server/db')
  ;({ ChatControl: Control } = await import('../../server/chat/control'))
  inbox = await import('../../server/chat/control-store')
  ;({ ServiceControl: Service } = await import('../../server/service/control'))
  background = await import('../../server/release-background')
})
afterEach(async () => {
  for (const control of controls.splice(0)) await control.stop().catch(() => undefined)
  for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve))
  for (const runtime of runtimes.splice(0)) await runtime.stop()
  background.resumeReleaseBackground()
  database.setMeta('chat_switch_waiting', '[]')
  database.setMeta('chat_switch_interrupted', '[]')
})
afterAll(async () => { database.closeDatabase(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

describe('waiting behind a pending switch', () => {
  it('waits a newly sent turn instead of starting it, then starts waited turns in order', async () => {
    const w = await world()
    w.runtime.setSwitchPending('r2')
    const first = w.runtime.prompt(w.s.id, input('Do this after the update'))
    const second = w.runtime.prompt(w.s.id, input('And then this'))
    expect(first).toHaveProperty('waitId')
    expect(first).not.toHaveProperty('turnId')
    expect(second).toHaveProperty('waitId')
    await pause(80)
    expect(w.c.calls).toHaveLength(0)
    expect(w.runtime.events(w.s.id, 0).events.some(e => e.event.type === 'turn.started')).toBe(false)
    expect(w.runtime.get(w.s.id)).toMatchObject({ status: 'queued', queuedBehind: 'waiting for the Poise update' })
    await w.runtime.releaseSwitchWait()
    await until(() => w.turns(w.s.id).length === 2)
    expect(w.c.calls.map(call => call.input.text)).toEqual(['Do this after the update', 'And then this'])
    await until(() => w.runtime.get(w.s.id)?.status === 'idle')
  })

  it('waits an armed queued message unclaimed while a switch is pending', async () => {
    const w = await world({ deferStart: true })
    await w.runtime.enqueue(w.s.id, randomUUID(), input('First queued'))
    await w.runtime.enqueue(w.s.id, randomUUID(), input('Second queued'))
    const preceding = randomUUID(); storage.reserveQueueTurn(w.s.id, preceding)
    storage.finalizeTurn(w.s.id, { type: 'turn.finished', turnId: preceding, stopReason: 'end_turn' })
    w.runtime.setSwitchPending('r2')
    await w.runtime.recover()
    await pause(80)
    expect(w.c.calls).toHaveLength(0)
    expect(w.runtime.get(w.s.id)?.queue?.items.map(item => item.state)).toEqual(['waiting', 'waiting'])
    await w.runtime.releaseSwitchWait()
    await until(() => w.c.calls.length === 2)
    expect(w.c.calls.map(call => call.input.text)).toEqual(['First queued', 'Second queued'])
  })

  it('waits a work-monitor wake instead of delivering it', async () => {
    const w = await world()
    const control = await tickControl(w.runtime)
    const body = JSON.stringify({ kind: 'ci', target: 'https://github.com/test/switch/pull/1', head: 'b'.repeat(40), failing: ['check'] })
    inbox.message(w.instance, w.s.id, 'Poise work monitor', body)
    w.runtime.setSwitchPending('r2')
    await control.tick()
    await pause(80)
    expect(w.c.calls).toHaveLength(0)
    expect(inbox.pending(w.instance, '')).toHaveLength(1)
    expect(w.logs.join('\n')).not.toContain('remains pending')
    await w.runtime.releaseSwitchWait()
    await control.tick()
    await until(() => w.c.calls.length === 1)
    expect(w.c.calls[0].input.text).toContain(body)
    expect(inbox.pending(w.instance, '')).toHaveLength(0)
  })

  it('admits turns exactly as before with no switch pending', async () => {
    const w = await world()
    const receipt = w.runtime.prompt(w.s.id, input('Run at once'))
    expect(receipt).toHaveProperty('turnId')
    expect(receipt).not.toHaveProperty('waitId')
    await until(() => w.turns(w.s.id).length === 1)
    expect(w.c.calls.map(call => call.input.text)).toEqual(['Run at once'])
  })

  it('leaves waited prompts durable when the server stops mid-drain, so the next server starts them', async () => {
    const w = await world()
    w.runtime.setSwitchPending('r2')
    expect(w.runtime.prompt(w.s.id, input('First'))).toHaveProperty('waitId')
    expect(w.runtime.prompt(w.s.id, input('Second'))).toHaveProperty('waitId')
    w.runtime.startDrain('service')
    await w.runtime.stop()
    w.runtime.endDrain()
    await pause(200)
    const waiting = JSON.parse(database.getMeta('chat_switch_waiting') ?? '[]') as Array<{ prompt: PromptInput }>
    expect(waiting.map(entry => entry.prompt.text)).toEqual(['First', 'Second'])
    const next = w.make()
    await next.recover()
    await until(() => w.c.calls.length === 2)
    expect(w.c.calls.map(call => call.input.text)).toEqual(['First', 'Second'])
  })
})

describe('the switch bound', () => {
  async function expired(w: Awaited<ReturnType<typeof world>>) {
    const timer = new FakeTimer()
    let now = 5_000_000
    const restart = vi.fn(() => true)
    const service = new Service(w.runtime, {
      drainTimeoutSeconds: 60, timer, log: () => {}, releasesDir: await releases(),
      release: { name: 'r1', base: 'b1' }, restart, canRestart: () => true, switchTurnBoundMinutes: () => 15, now: () => now,
    })
    service.switchRelease('r2')
    now += 15 * 60_000
    timer.fire()
    await until(() => storage.listOpenTurns(w.instance).length === 0 && w.runtime.working() === 0)
    if (!restart.mock.calls.length) {
      await until(() => timer.timers.size > 0)
      timer.fire()
    }
    return { service, restart, timer }
  }

  it.each(['person', 'poise'] as const)('replays the original %s request that never reached its checkout before the bound', async source => {
    const w = await world({ auto: false })
    const waiting = await w.session()
    await until(() => w.runtime.get(waiting.id)?.status === 'idle')
    w.runtime.prompt(w.s.id, input('Hold the shared checkout'))
    await until(() => w.c.calls.length === 1)
    const request = input('Implement the original waiting request')
    let metadata: { seq: number, source: { kind: 'poise', name: string }, shown: string } | undefined
    if (source === 'poise') {
      inbox.message(w.instance, waiting.id, 'Poise work monitor', request.text)
      metadata = { seq: inbox.inbox(w.instance, waiting.id)[0].seq, source: { kind: 'poise', name: 'Poise work monitor' }, shown: 'Visible monitor request' }
    }
    const admitted = w.runtime.prompt(waiting.id, request, metadata)
    await until(() => w.runtime.events(waiting.id, 0).events.some(({ event }) => event.type === 'turn.started'))
    expect(w.c.calls).toHaveLength(1)
    const { service, restart } = await expired(w)
    try {
      expect(restart).toHaveBeenCalledTimes(1)
      const retained = JSON.parse(database.getMeta('chat_switch_interrupted') ?? '[]') as Array<{ sessionId: string, prompt?: PromptInput }>
      expect(retained.find(row => row.sessionId === waiting.id)?.prompt).toEqual(request)
      w.c.auto = true
      const next = w.make()
      await next.recover()
      await until(() => w.c.calls.length === 3)
      expect(w.c.calls[1].input.text).toBe('Poise restarted for an update while your turn was running. Continue where you left off.')
      expect(w.c.calls[2].input.text).toContain(request.text)
      await until(() => next.get(waiting.id)?.status === 'idle')
      if (metadata) {
        const replayed = next.events(waiting.id, 0).events.find(({ event }) => event.type === 'turn.started' && event.turnId !== ('turnId' in admitted ? admitted.turnId : ''))
        expect(replayed?.event).toMatchObject({ source: metadata.source, prompt: input(metadata.shown) })
      }
    } finally { service.reset() }
  })

  it('replays the unsent request when the bound cancels native compaction first', async () => {
    const w = await world()
    w.runtime.prompt(w.s.id, input('Seed native context'))
    await until(() => w.turns(w.s.id).length === 1 && w.runtime.working() === 0)
    w.c.compactGate = new Promise<void>(() => {})
    w.runtime.prompt(w.s.id, input('/compact Implement the task after compaction'))
    await until(() => w.c.compactions === 1)
    expect(w.c.calls).toHaveLength(1)
    const { service, restart } = await expired(w)
    try {
      expect(restart).toHaveBeenCalledTimes(1)
      w.c.compactGate = undefined
      const next = w.make()
      await next.recover()
      await until(() => w.c.calls.length === 2)
      expect(w.c.calls[1].input.text).toBe('Implement the task after compaction')
      expect(w.c.compactions).toBe(2)
    } finally { service.reset() }
  })

  it('keeps interrupted work ahead of waited follow-ups when another switch is pending during recovery', async () => {
    const w = await world({ auto: false })
    w.runtime.prompt(w.s.id, input('Original task'))
    await until(() => w.c.calls.length === 1)
    w.runtime.setSwitchPending('r2')
    expect(w.runtime.prompt(w.s.id, input('Waited follow-up'))).toHaveProperty('waitId')
    const interrupted = w.runtime.runningTurnSessions()
    await w.runtime.cancel(w.s.id)
    w.runtime.recordSwitchInterrupted(interrupted)
    await w.runtime.stop()
    const waiting = database.getMeta('chat_switch_waiting')
    const retained = database.getMeta('chat_switch_interrupted')
    w.c.auto = true
    const next = w.make()
    next.setSwitchPending('r3')
    await next.recover()
    expect(database.getMeta('chat_switch_interrupted')).toBe(retained)
    expect(database.getMeta('chat_switch_waiting')).toBe(waiting)
    expect(w.c.calls).toHaveLength(1)
    await next.releaseSwitchWait()
    await until(() => w.c.calls.length === 3)
    expect(w.c.calls.map(call => call.input.text)).toEqual([
      'Original task', 'Poise stopped your turn for an update that did not restart. Continue where you left off.', 'Waited follow-up',
    ])
    expect(JSON.parse(database.getMeta('chat_switch_interrupted') ?? '[]')).toEqual([])
    expect(JSON.parse(database.getMeta('chat_switch_waiting') ?? '[]')).toEqual([])
  })

  it('retains shown input, switches and change completion when recovery queues behind a busy turn', async () => {
    const w = await world({ auto: false })
    const changeId = randomUUID()
    storage.saveSession({ ...storage.getSession(w.s.id)!, selfChangeId: changeId })
    const next = w.make()
    await next.createSwitch({ name: 'recovery-hint', content: 'Keep the original switch instructions', revision: 0 })
    next.prompt(w.s.id, input('Busy preceding task'))
    await until(() => w.c.calls.length === 1)
    next.recordSwitchInterrupted([{ sessionId: w.s.id, turnId: randomUUID(), prompt: input('Original implementation runbook'),
      shown: input('Visible original request'), implementsChange: true, switches: ['recovery-hint'] }])
    await next.releaseSwitchWait()
    expect(next.get(w.s.id)?.queue?.items).toEqual([expect.objectContaining({ recovery: {
      shown: input('Visible original request'), implementsChange: true, switches: ['recovery-hint'],
    } })])
    w.c.auto = true
    w.finish()
    const outbox = await import('../../server/self-update-outbox')
    await until(() => outbox.getFinish(changeId)?.outcome === 'completed')
    expect(w.c.calls).toHaveLength(2)
    expect(w.c.calls[1].input.text).toContain('Original implementation runbook')
    expect(w.c.calls[1].input.text).toContain('Keep the original switch instructions')
    const started = next.events(w.s.id, 0).events.filter(({ event }) => event.type === 'turn.started').at(-1)
    expect(started?.event).toMatchObject({ prompt: input('Visible original request') })
  })

  it('restarts at once when only waited prompts stand by: they hold no quiet check', async () => {
    const w = await world()
    const timer = new FakeTimer()
    const restart = vi.fn(() => true)
    const service = new Service(w.runtime, {
      drainTimeoutSeconds: 60, timer, log: () => {}, releasesDir: await releases(),
      release: { name: 'r1', base: 'b1' }, restart, canRestart: () => true, switchTurnBoundMinutes: () => 15, now: () => 5_000_000,
    })
    try {
      service.switchRelease('r2')
      expect(w.runtime.prompt(w.s.id, input('Wait behind the update'))).toHaveProperty('waitId')
      expect(w.runtime.working()).toBe(0)
      timer.fire()
      expect(restart).toHaveBeenCalledTimes(1)
    } finally {
      service.reset()
    }
  })

  it('keeps waited prompts in arrival order when the restart is refused', async () => {
    const w = await world()
    const timer = new FakeTimer()
    const restart = vi.fn(() => false)
    const service = new Service(w.runtime, {
      drainTimeoutSeconds: 60, timer, log: () => {}, releasesDir: await releases(),
      release: { name: 'r1', base: 'b1' }, restart, canRestart: () => true, switchTurnBoundMinutes: () => 15, now: () => 5_000_000,
    })
    try {
      service.switchRelease('r2')
      for (const text of ['First', 'Second', 'Third']) {
        expect(w.runtime.prompt(w.s.id, input(text))).toHaveProperty('waitId')
      }
      timer.fire()
      expect(restart).toHaveBeenCalledTimes(1)
      await until(() => w.turns(w.s.id).length === 3)
      expect(w.c.calls.map(call => call.input.text)).toEqual(['First', 'Second', 'Third'])
      expect(w.runtime.switchPending).toBeNull()
      expect(JSON.parse(database.getMeta('chat_switch_waiting') ?? '[]')).toEqual([])
    } finally {
      service.reset()
    }
  })

  it('continues a turn cancelled at the bound before waited messages when restart is refused', async () => {
    const w = await world({ auto: false })
    w.runtime.prompt(w.s.id, input('Original task'))
    await until(() => w.c.calls.length === 1)
    w.c.auto = true
    const timer = new FakeTimer()
    let now = 5_000_000
    const restart = vi.fn(() => false)
    const service = new Service(w.runtime, {
      drainTimeoutSeconds: 60, timer, log: () => {}, releasesDir: await releases(),
      release: { name: 'r1', base: 'b1' }, restart, canRestart: () => true, switchTurnBoundMinutes: () => 15, now: () => now,
    })
    try {
      service.switchRelease('r2')
      await w.runtime.enqueue(w.s.id, randomUUID(), input('Waited follow-up'))
      now += 15 * 60_000
      timer.fire()
      await until(() => storage.listOpenTurns(w.instance).length === 0 && w.runtime.working() === 0)
      if (!restart.mock.calls.length) {
        await until(() => timer.timers.size > 0)
        timer.fire()
      }
      await until(() => w.turns(w.s.id).length === 3)
      expect(restart).toHaveBeenCalledTimes(1)
      expect(w.c.calls.map(call => call.input.text)).toEqual([
        'Original task', 'Poise stopped your turn for an update that did not restart. Continue where you left off.', 'Waited follow-up',
      ])
      expect(JSON.parse(database.getMeta('chat_switch_interrupted') ?? '[]')).toEqual([])
    } finally { service.reset() }
  })

  it('keeps waited messages behind continuation when withdrawal overlaps bound cancellation', async () => {
    const w = await world({ auto: false })
    w.runtime.prompt(w.s.id, input('Original task'))
    await until(() => w.c.calls.length === 1)
    let release!: () => void
    let cancelled!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const settled = new Promise<void>(resolve => { cancelled = resolve })
    const cancel = w.runtime.cancel.bind(w.runtime)
    const delayed = vi.spyOn(w.runtime, 'cancel').mockImplementation(async id => {
      const result = await cancel(id)
      cancelled()
      await held
      return result
    })
    const timer = new FakeTimer()
    let now = 5_000_000
    const restart = vi.fn(() => true)
    const service = new Service(w.runtime, {
      drainTimeoutSeconds: 60, timer, log: () => {}, releasesDir: await releases(),
      release: { name: 'r1', base: 'b1' }, restart, canRestart: () => true, switchTurnBoundMinutes: () => 15, now: () => now,
    })
    try {
      service.switchRelease('r2')
      now += 15 * 60_000
      timer.fire()
      await settled
      service.switchRelease('r1')
      expect(w.runtime.prompt(w.s.id, input('Waited follow-up'))).toHaveProperty('waitId')
      expect(w.c.calls).toHaveLength(1)
      w.c.auto = true
      release()
      await until(() => w.turns(w.s.id).length === 3)
      expect(w.c.calls.map(call => call.input.text)).toEqual([
        'Original task', 'Poise stopped your turn for an update that did not restart. Continue where you left off.', 'Waited follow-up',
      ])
      expect(restart).not.toHaveBeenCalled()
    } finally {
      release()
      delayed.mockRestore()
      service.reset()
    }
  })

  it('keeps polling a retargeted switch after an earlier cancellation settles', async () => {
    const w = await world({ auto: false })
    w.runtime.prompt(w.s.id, input('Original task'))
    await until(() => w.c.calls.length === 1)
    let release!: () => void
    let cancelled!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const settled = new Promise<void>(resolve => { cancelled = resolve })
    const cancel = w.runtime.cancel.bind(w.runtime)
    const delayed = vi.spyOn(w.runtime, 'cancel').mockImplementation(async id => {
      const result = await cancel(id)
      cancelled()
      await held
      return result
    })
    const timer = new FakeTimer()
    let now = 5_000_000
    const logs: string[] = []
    const restart = vi.fn(() => true)
    const releasesDir = await releases()
    await mkdir(join(releasesDir, 'r3'))
    await writeFile(join(releasesDir, 'r3', 'base'), 'b1\n')
    await writeFile(join(releasesDir, 'r3', 'installed'), '')
    const service = new Service(w.runtime, {
      drainTimeoutSeconds: 60, timer, log: line => logs.push(line), releasesDir,
      release: { name: 'r1', base: 'b1' }, restart, canRestart: () => true, switchTurnBoundMinutes: () => 15, now: () => now,
    })
    try {
      service.switchRelease('r2')
      now += 15 * 60_000
      timer.fire()
      await settled
      expect(w.runtime.prompt(w.s.id, input('Wait behind the retargeted update'))).toHaveProperty('waitId')
      service.switchRelease('r3')
      expect(timer.timers.size).toBe(1)
      release()
      await until(() => logs.some(line => line.includes('superseded while cancellation settled')))
      // Cancellation can settle before the turn's workspace refresh and
      // operation chain. Fire the new poll only once its quiet gate holds.
      await until(() => storage.listOpenTurns(w.instance).length === 0 && w.runtime.working() === 0)
      timer.fire()
      expect(restart).toHaveBeenCalledTimes(1)
      expect(w.runtime.switchPending?.release).toBe('r3')
    } finally {
      release()
      delayed.mockRestore()
      service.reset()
    }
  })

  it('does not restart a fresh switch when an earlier cancellation settles', async () => {
    const w = await world({ auto: false })
    w.runtime.prompt(w.s.id, input('Original task'))
    await until(() => w.c.calls.length === 1)
    let release!: () => void
    let cancelled!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const settled = new Promise<void>(resolve => { cancelled = resolve })
    const cancel = w.runtime.cancel.bind(w.runtime)
    const delayed = vi.spyOn(w.runtime, 'cancel').mockImplementation(async id => {
      const result = await cancel(id)
      cancelled()
      await held
      return result
    })
    const timer = new FakeTimer()
    let now = 5_000_000
    const logs: string[] = []
    const restart = vi.fn(() => true)
    const service = new Service(w.runtime, {
      drainTimeoutSeconds: 60, timer, log: line => logs.push(line), releasesDir: await releases(),
      release: { name: 'r1', base: 'b1' }, restart, canRestart: () => true, switchTurnBoundMinutes: () => 15, now: () => now,
    })
    try {
      service.switchRelease('r2')
      now += 15 * 60_000
      timer.fire()
      await settled
      service.switchRelease('r1')
      const newTurn = w.runtime.prompt(w.s.id, input('Admitted during withdrawal'))
      expect(newTurn).toHaveProperty('waitId')
      expect(w.c.calls).toHaveLength(1)
      service.switchRelease('r2')
      release()
      await until(() => logs.some(line => line.includes('superseded while cancellation settled')))
      expect(restart).not.toHaveBeenCalled()
      expect(storage.getOpenTurn(w.s.id)).toBeNull()
      expect(w.runtime.switchPending?.release).toBe('r2')
      await until(() => w.runtime.working() === 0)
      await new Promise<void>(resolve => setImmediate(resolve))
      timer.fire()
      expect(restart).toHaveBeenCalledTimes(1)
    } finally {
      release()
      delayed.mockRestore()
      service.reset()
    }
  })

  it('cancels a turn still running past the bound and restarts; after the restart its session gets exactly one continue prompt on its resumed native session', async () => {
    const w = await world({ auto: false })
    w.runtime.prompt(w.s.id, input('Keep working'))
    await until(() => w.c.calls.length === 1)
    const { restart, service } = await expired(w)
    try {
      expect(w.runtime.switchPending?.release).toBe('r2')
      await until(() => w.turns(w.s.id).length === 1)
      expect(w.turns(w.s.id)[0].event).toMatchObject({ stopReason: 'cancelled' })
      await until(() => restart.mock.calls.length === 1)
      const nativeSessionId = w.runtime.get(w.s.id)?.nativeSessionId
      expect(nativeSessionId).toBeTruthy()
      const next = w.make()
      await next.recover()
      await until(() => w.c.calls.length === 2)
      expect(w.c.calls[1].input.text).toBe('Poise restarted for an update while your turn was running. Continue where you left off.')
      const resumed = w.c.adapters.filter(adapter => adapter.agent === 'grok')
      expect(resumed).toHaveLength(2)
      expect(resumed[1].options?.resume).toBe(nativeSessionId)
      const third = w.make()
      await third.recover()
      await pause(80)
      expect(w.c.calls).toHaveLength(2)
    } finally {
      service.reset()
    }
  })

  it('runs the continue before the waited prompt of the same session, losing nothing', async () => {
    const w = await world({ auto: false })
    w.runtime.prompt(w.s.id, input('Original task'))
    await until(() => w.c.calls.length === 1)
    // Interrupted the way a switch bound interrupts, then waited behind the same update.
    const turnId = storage.getOpenTurn(w.s.id)!.turnId
    await w.runtime.cancel(w.s.id)
    await until(() => w.turns(w.s.id).length === 1)
    w.runtime.recordSwitchInterrupted([{ sessionId: w.s.id, turnId }])
    w.runtime.setSwitchPending('r2')
    expect(w.runtime.prompt(w.s.id, input('Sent while waiting'))).toHaveProperty('waitId')
    const next = w.make()
    await next.recover()
    await until(() => w.c.calls.length === 2)
    expect(w.c.calls.map(call => call.input.text)).toEqual(['Original task', 'Poise restarted for an update while your turn was running. Continue where you left off.'])
    expect(next.get(w.s.id)?.queue?.items.map(item => item.prompt.text)).toEqual(['Sent while waiting'])
    w.finish()
    await until(() => w.c.calls.length === 3)
    expect(w.c.calls.map(call => call.input.text)).toEqual(['Original task', 'Poise restarted for an update while your turn was running. Continue where you left off.', 'Sent while waiting'])
  })

  it('starts waited prompts in order after the restart, refusing and losing none', async () => {
    const w = await world()
    w.runtime.setSwitchPending('r2')
    for (const text of ['First', 'Second', 'Third']) {
      expect(w.runtime.prompt(w.s.id, input(text))).toHaveProperty('waitId')
    }
    expect(w.c.calls).toHaveLength(0)
    const next = w.make()
    await next.recover()
    await until(() => w.turns(w.s.id).length === 3, 50_000)
    expect(w.c.calls.map(call => call.input.text)).toEqual(['First', 'Second', 'Third'])
    await until(() => next.get(w.s.id)?.status === 'idle')
  }, 90_000)

  it('resumes the native session of an interrupted turn on every adapter', async () => {
    const w = await world()
    const agents: AgentId[] = ['claude', 'codex', 'grok', 'muse']
    const ids = new Map<AgentId, string>([['grok', w.s.id]])
    for (const agent of agents) {
      const id = agent === 'grok' ? w.s.id : (await w.session(agent)).id
      ids.set(agent, id)
      await until(() => w.runtime.get(id)?.status === 'idle')
      w.runtime.prompt(id, input(`Task for ${agent}`))
      await until(() => w.turns(id).length === 1)
    }
    const nativeBefore = new Map<AgentId, string>()
    for (const agent of agents) nativeBefore.set(agent, w.runtime.get(ids.get(agent)!)?.nativeSessionId ?? '')
    expect([...nativeBefore.values()].every(id => id.length > 0)).toBe(true)
    w.c.auto = false
    for (const agent of agents) w.runtime.prompt(ids.get(agent)!, input(`Interrupted ${agent} work`))
    expect(agents.map(agent => storage.getOpenTurn(ids.get(agent)!)).every(open => open !== null)).toBe(true)
    // Exercise cancellation after native work has started, not only while
    // every interrupted turn is still waiting for the shared checkout.
    await until(() => w.c.calls.length > agents.length)
    const nativeAtBound = new Set(w.c.calls.slice(agents.length).map(call => call.agent))
    const { service, restart } = await expired(w)
    try {
      for (const agent of agents) await until(() => w.turns(ids.get(agent)!).length === 2)
      for (const agent of agents) {
        expect(w.turns(ids.get(agent)!).map(t => (t.event as { stopReason: string }).stopReason)).toEqual(['end_turn', 'cancelled'])
      }
      await until(() => restart.mock.calls.length === 1)
      const callsBeforeResume = w.c.calls.length
      w.c.auto = true
      const next = w.make()
      await next.recover()
      await until(() => w.c.calls.length === callsBeforeResume + agents.length, 100_000)
      for (const agent of agents) {
        expect(w.c.calls.slice(callsBeforeResume).find(call => call.agent === agent)?.input.text).toBe(nativeAtBound.has(agent)
          ? 'Poise restarted for an update while your turn was running. Continue where you left off.'
          : `Interrupted ${agent} work`)
      }
      for (const agent of agents) {
        const fakes = w.c.adapters.filter(adapter => adapter.agent === agent)
        expect(fakes).toHaveLength(2)
        expect(fakes[1].options?.resume).toBe(nativeBefore.get(agent))
      }
    } finally {
      service.reset()
    }
  }, 180_000)
})
