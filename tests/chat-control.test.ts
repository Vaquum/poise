import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { CATALOG } from './model-catalog-fixture'
import type { Adapter, AdapterHost, TurnResult } from '../server/chat/adapters/types'
import type { Capabilities, PromptInput, ServerFrame, SessionRecord } from '../server/chat/protocol'
import type { ChatRuntime } from '../server/chat/runtime'
import type { ChatControl, CiObservation } from '../server/chat/control'

vi.mock('../server/claude-auth', () => ({ claudeAuth: { snapshot: () => ({ status: 'authenticated' }), requireReady: async () => {} } }))
const executeFile = promisify(execFile)
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
let storage: typeof import('../server/chat/storage')
let database: typeof import('../server/db')
let Runtime: typeof ChatRuntime
let Control: typeof ChatControl
const prompts = new Map<string, PromptInput[]>()
const finishes = new Map<string, (result: TurnResult) => void>()
const hosts = new Map<string, AdapterHost>()
const steers = new Map<string, string[]>()
const ci = vi.fn<() => Promise<CiObservation>>()

function adapter(host: AdapterHost): Adapter {
  hosts.set(host.sessionId, host)
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
    async steer(text) { steers.set(host.sessionId, [...(steers.get(host.sessionId) ?? []), text]) }, async setMode() {}, async setModel(modelId, effort) { return { modelId, effort } },
    async fork() { return randomUUID() }, onExit() {},
  }
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) { if (check()) return; await new Promise(done => setTimeout(done, 15)) }
  throw new Error('control fixture readiness deadline')
}
async function config(id: string) {
  const context = await control.context(id)
  const path = /"([^"\n]+\.json)"/.exec(context)?.[1]
  if (!path) throw new Error('native control connection missing')
  return { path, ...JSON.parse(await readFile(path, 'utf8')) as { token: string, sessionId: string, origin: string } }
}
async function request(id: string, command: Record<string, unknown>) {
  const connection = await config(id)
  return fetch(`${origin}/api/chat/control`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Poise-Chat': id, Authorization: `Bearer ${connection.token}` },
    body: JSON.stringify({ requestId: randomUUID(), ...command }) })
}
async function command(id: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await request(id, input)
  const body = await response.json() as Record<string, unknown>
  if (!response.ok) throw new Error(JSON.stringify(body))
  return (body.result ?? body) as Record<string, unknown>
}
async function manager(agent: 'grok' | 'claude' | 'codex' | 'muse' = 'grok') {
  const model = CATALOG.models.find(m => m.provider === agent)
  if (!model) throw new Error(`fixture lacks ${agent}`)
  return runtime.create({ agent, model: model.identity, title: 'Manager', deferStart: true })
}
function makeRuntime() {
  return new Runtime({ instance, instanceLabel: 'test', callerTurns: null, catalog: async () => CATALOG,
    adapters: { grok: adapter, claude: adapter, codex: adapter, muse: adapter }, requireClaudeReady: async () => {}, probeAgent: async () => ({ ok: true }),
    localWorkspaceRoot: workspaceRoot, idleTimeoutMinutes: () => 0, controlContext: id => control.context(id) })
}
async function restart() {
  const stopped = runtime.stop()
  await control.stop(stopped)
  runtime = makeRuntime()
  control = new Control(runtime, { ci, now: () => clock })
  control.attach(server)
  await runtime.recover()
  control.start()
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-control-test-'))
  vi.stubEnv('POISE_DB', join(root, 'chat.sqlite3'))
  vi.stubEnv('POISE_LOCK_DIR', join(root, 'locks'))
  ;({ ChatRuntime: Runtime } = await import('../server/chat/runtime'))
  ;({ ChatControl: Control } = await import('../server/chat/control'))
  store = await import('../server/chat/control-store')
  storage = await import('../server/chat/storage')
  database = await import('../server/db')
})
beforeEach(async () => {
  clock = Date.now()
  prompts.clear(); finishes.clear(); hosts.clear(); steers.clear()
  ci.mockReset().mockResolvedValue({ head: 'a'.repeat(40), failing: [] })
  instance = `control:${randomUUID()}`
  workspaceRoot = join(root, randomUUID())
  runtime = makeRuntime()
  control = new Control(runtime, { ci, now: () => clock })
  server = createServer((req, res) => {
    if (req.url === '/api/chat/control') { void control.handle(req, res); return }
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

describe('native Poise control through HTTP, SQLite and the real Chat runtime', () => {
  it('lets a running manager create three parallel workers and receive their outcomes without sharing its lease', async () => {
    const parent = await manager()
    runtime.prompt(parent.id, { text: 'Manage three tasks', attachments: [], mentions: [] })
    await until(() => prompts.has(parent.id))
    const workers: string[] = []
    for (let i = 0; i < 3; i++) {
      const result = await command(parent.id, { operation: 'create', title: `Worker ${i}`, task: `Task ${i}` })
      workers.push((result.session as { id: string }).id)
    }
    await control.tick()
    await until(() => workers.every(id => prompts.has(id)))
    expect(new Set([parent.id, ...workers].map(id => runtime.get(id)?.checkout)).size).toBe(4)
    expect(store.children(runtime.instance)).toHaveLength(3)
    expect(workers.map(id => runtime.get(id)?.title)).toEqual(['Worker 0', 'Worker 1', 'Worker 2'])
    expect(runtime.get(parent.id)?.status).toBe('running')
    finishes.get(workers[0])!({ stopReason: 'end_turn' })
    await until(() => runtime.get(workers[0])?.status === 'idle')
    expect(store.inbox(runtime.instance, parent.id).some(m => m.sender === workers[0] && m.body.includes('turn.finished'))).toBe(true)
    expect(prompts.get(parent.id)).toHaveLength(1)
    finishes.get(parent.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(parent.id)?.status === 'idle')
    await control.tick()
    await until(() => prompts.get(parent.id)?.length === 2)
    expect(prompts.get(parent.id)![1].text).toContain('worker_event')
  }, 30_000) // Four Git workspaces and several independently bounded readiness phases.

  it.each(['grok', 'claude', 'codex', 'muse'] as const)('injects discovery and live bindings through the shared %s prompt path', async agent => {
    const parent = await manager(agent)
    await command(parent.id, { operation: 'bind', target: 'https://github.com/Acme/app/issues/1' })
    runtime.prompt(parent.id, { text: 'Work on the assigned issue', attachments: [], mentions: [] })
    await until(() => prompts.has(parent.id))
    expect(prompts.get(parent.id)![0].text).toContain('[Poise native control]')
    expect(prompts.get(parent.id)![0].text).toContain('https://github.com/acme/app/issues/1')
    const history = runtime.events(parent.id, 0).events
    expect(JSON.stringify(history)).not.toContain('poise-chat-control-')
  })

  it('claims issue and PR separately, refuses competing owners, and releases only from the recorded chat', async () => {
    const first = await manager(), second = await manager()
    const issue = 'https://github.com/acme/app/issues/250', pr = 'https://github.com/acme/app/pull/251'
    await command(first.id, { operation: 'bind', target: issue })
    await command(first.id, { operation: 'bind', target: pr })
    expect(store.bindings(runtime.instance).filter(b => b.session === first.id)).toHaveLength(2)
    await expect(command(second.id, { operation: 'bind', target: issue })).rejects.toThrow('owned by chat')
    await expect(command(second.id, { operation: 'unbind', target: issue })).rejects.toThrow('only chat')
    await command(first.id, { operation: 'unbind', target: issue })
    await command(second.id, { operation: 'bind', target: issue })
    expect(store.bindings(runtime.instance).find(b => b.target === issue)?.session).toBe(second.id)
  })

  it('coalesces retried creates, refuses a changed request and never replays an uncertain command', async () => {
    const parent = await manager()
    const input = { operation: 'create', requestId: randomUUID(), title: 'One worker', task: 'One task' }
    const results = await Promise.all([command(parent.id, input), command(parent.id, input)])
    expect(results[0]).toEqual(results[1])
    expect(store.children(runtime.instance)).toHaveLength(1)
    await expect(command(parent.id, { ...input, task: 'Changed' })).rejects.toThrow('different command')
    database.db.prepare('UPDATE chat_command_receipts SET ack = NULL WHERE request_id = ?').run(input.requestId)
    await expect(command(parent.id, input)).rejects.toThrow('command_in_doubt')
    expect(store.children(runtime.instance)).toHaveLength(1)
  })

  it('persists supervision and inbox admission across runtime reconstruction without catch-up bursts or prompt replay', async () => {
    const parent = await manager(), child = await manager()
    const { watchId } = await command(parent.id, { operation: 'supervise', sessionIds: [child.id], intervalMinutes: 10, instruction: 'Inspect progress and provide needed context' })
    await restart()
    clock += 31 * 60_000
    await control.tick()
    await until(() => prompts.has(parent.id))
    const messages = store.inbox(runtime.instance, parent.id)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ state: 'admitted' })
    expect(messages[0].body).toContain('Inspect progress')
    await control.tick()
    expect(store.inbox(runtime.instance, parent.id)).toHaveLength(1)
    expect(store.watches(runtime.instance)[0].next_at).toBe(clock + 10 * 60_000)
    const count = prompts.get(parent.id)!.length
    store.message(runtime.instance, parent.id, 'fixture', 'Another task after the interrupted turn')
    await restart()
    await control.tick()
    expect(prompts.get(parent.id)).toHaveLength(count)
    expect(store.inbox(runtime.instance, parent.id).at(-1)?.state).toBe('pending')
    await command(parent.id, { operation: 'unsupervise', watchId })
    expect(store.watches(runtime.instance)[0].enabled).toBe(0)
  })

  it('notifies the manager of questions without answering them and honors Stop until explicit activity', async () => {
    const parent = await manager()
    const result = await command(parent.id, { operation: 'create', title: 'Worker', task: 'Wait for a decision' })
    const child = (result.session as { id: string }).id
    await control.tick()
    await until(() => prompts.has(child))
    const question = hosts.get(child)!.askQuestion({ questions: [{ id: 'q', question: 'Which target?', options: [], freeText: true, multiSelect: false }] })
    void question.catch(() => undefined)
    await until(() => runtime.get(child)?.status === 'waiting')
    expect(store.inbox(runtime.instance, parent.id).some(m => m.body.includes('question.asked'))).toBe(true)
    expect(runtime.get(child)?.pendingRequests).toHaveLength(1)
    await command(parent.id, { operation: 'stop', sessionId: child })
    await until(() => runtime.get(child)?.status === 'idle')
    await command(parent.id, { operation: 'send', sessionId: child, text: 'New information' })
    await control.tick()
    expect(prompts.get(child)).toHaveLength(1)
    runtime.prompt(child, { text: 'Resume the task', attachments: [], mentions: [] })
    await until(() => prompts.get(child)?.length === 2)
    expect(store.inbox(runtime.instance, child).find(m => m.body === 'New information')?.state).toBe('pending')
  })

  it('shares five-minute CI reads, records failures once, and delivers recovery and recurring failures', async () => {
    const parent = await manager()
    const target = 'https://github.com/acme/app/pull/9'
    await command(parent.id, { operation: 'bind', target })
    const failed = { head: 'a'.repeat(40), failing: [{ name: 'Verify', state: 'completed', conclusion: 'failure' }] }
    ci.mockResolvedValue(failed)
    await Promise.all([control.tick(), control.tick()])
    expect(ci).toHaveBeenCalledTimes(1)
    expect(store.inbox(runtime.instance, parent.id)).toHaveLength(1)
    clock += 5 * 60_000
    await control.tick()
    expect(ci).toHaveBeenCalledTimes(2)
    expect(store.inbox(runtime.instance, parent.id)).toHaveLength(1)
    ci.mockResolvedValue({ head: 'a'.repeat(40), failing: [], pending: true })
    clock += 5 * 60_000; await control.tick()
    expect(store.inbox(runtime.instance, parent.id)).toHaveLength(1)
    ci.mockResolvedValue({ head: 'a'.repeat(40), failing: [] })
    clock += 5 * 60_000; await control.tick()
    ci.mockResolvedValue(failed)
    clock += 5 * 60_000; await control.tick()
    expect(store.inbox(runtime.instance, parent.id)).toHaveLength(3)
  })

  it('retains settled CI evidence during a rerun when another check remains failed', async () => {
    const parent = await manager()
    const target = 'https://github.com/acme/app/pull/91'
    await command(parent.id, { operation: 'bind', target })
    const first = { name: 'First', state: 'completed', conclusion: 'failure' }
    const second = { name: 'Second', state: 'completed', conclusion: 'failure' }
    ci.mockResolvedValue({ head: 'a'.repeat(40), failing: [first, second] })
    await control.tick()
    const settled = store.observation(runtime.instance, `ci:${target}`)!.fingerprint
    ci.mockResolvedValue({ head: 'a'.repeat(40), failing: [second], pending: true })
    clock += 5 * 60_000; await control.tick()
    expect(store.inbox(runtime.instance, parent.id)).toHaveLength(1)
    expect(store.observation(runtime.instance, `ci:${target}`)!.fingerprint).toBe(settled)
    ci.mockResolvedValue({ head: 'a'.repeat(40), failing: [second] })
    clock += 5 * 60_000; await control.tick()
    expect(store.inbox(runtime.instance, parent.id)).toHaveLength(2)
    expect(JSON.parse(store.inbox(runtime.instance, parent.id)[1].body).failing).toEqual([second])
    clock += 5 * 60_000; await control.tick()
    expect(store.inbox(runtime.instance, parent.id)).toHaveLength(2)
  })

  it.each([false, true])('waits for the first settled CI result across restart (failed=%s)', async failed => {
    const parent = await manager()
    const target = 'https://github.com/acme/app/pull/92'
    await command(parent.id, { operation: 'bind', target })
    const failing = failed ? [{ name: 'First', state: 'completed', conclusion: 'failure' }] : []
    ci.mockResolvedValue({ head: 'a'.repeat(40), failing, pending: true })
    await control.tick()
    expect(store.inbox(runtime.instance, parent.id)).toHaveLength(0)
    await restart()
    clock += 5 * 60_000; await control.tick()
    expect(store.inbox(runtime.instance, parent.id)).toHaveLength(0)
    ci.mockResolvedValue({ head: 'a'.repeat(40), failing })
    clock += 5 * 60_000; await control.tick()
    expect(store.inbox(runtime.instance, parent.id)).toHaveLength(failed ? 1 : 0)
    clock += 5 * 60_000; await control.tick()
    expect(store.inbox(runtime.instance, parent.id)).toHaveLength(failed ? 1 : 0)
  })

  it('lets the recorded manager supply context and answer task questions with durable attribution', async () => {
    const parent = await manager(), outsider = await manager()
    const result = await command(parent.id, { operation: 'create', title: 'Worker', task: 'Use the known target' })
    const child = (result.session as { id: string }).id
    await control.tick(); await until(() => prompts.has(child))
    const input = { operation: 'steer', sessionId: child, text: 'The target is staging', requestId: randomUUID() }
    await command(parent.id, input); await command(parent.id, input)
    expect(steers.get(child)).toHaveLength(1)
    await expect(command(outsider.id, { ...input, requestId: randomUUID() })).rejects.toThrow('recorded manager')
    const waiting = hosts.get(child)!.askQuestion({ questions: [{ id: 'target', question: 'Which target?', options: [], freeText: true, multiSelect: false }] })
    await until(() => runtime.get(child)?.status === 'waiting')
    const questionId = runtime.get(child)!.pendingRequests[0]
    await expect(command(outsider.id, { operation: 'answer', sessionId: child, questionId, answers: { target: 'staging' } })).rejects.toThrow('recorded manager')
    await command(parent.id, { operation: 'answer', sessionId: child, questionId, answers: { target: 'staging' } })
    await expect(waiting).resolves.toEqual({ target: 'staging' })
    expect(runtime.events(child, 0).events.find(e => e.event.type === 'question.answered')?.event).toMatchObject({ by: 'chat', fromSession: parent.id })
    expect(runtime.get(child)?.status).toBe('running')
  })

  it('validates real Caller CI packets, filters running checks, and refuses mismatched targets', async () => {
    const processModule = await import('../server/process')
    const { readWorkCi } = await import('../server/chat/control')
    database.setMeta('agentAccount', 'fixture-agent')
    const run = vi.spyOn(processModule, 'runFile').mockResolvedValue({ stdout: JSON.stringify({ action: 'list_failing_ci', repository: 'acme/app', pull_number: 9, head_sha: 'b'.repeat(40), failing: [
      { name: 'Queued', state: 'queued', conclusion: null }, { name: 'Running', state: 'in_progress', conclusion: null },
      { name: 'Failure', state: 'completed', conclusion: 'failure', url: 'https://github.com/acme/app/actions/runs/1' },
      { name: 'Legacy', state: 'error' },
    ] }), stderr: '' })
    const target = store.workTarget('https://github.com/acme/app/pull/9')
    const observed = await readWorkCi(target)
    expect(observed.failing.map(c => c.name)).toEqual(['Failure', 'Legacy'])
    expect(observed.pending).toBe(true)
    expect(run.mock.calls[0][1]).toContain('--repository')
    run.mockResolvedValue({ stdout: JSON.stringify({ repository: 'acme/other', pull_number: 9, head_sha: 'b'.repeat(40), failing: [] }), stderr: '' })
    await expect(readWorkCi(target)).rejects.toThrow('invalid CI evidence')
    run.mockRestore()
  })

  it('delivers current failure evidence to a new owner and rejects credentials after control restart', async () => {
    const first = await manager(), second = await manager()
    const target = 'https://github.com/acme/app/pull/45'
    ci.mockResolvedValue({ head: 'a'.repeat(40), failing: [{ name: 'Verify', state: 'completed', conclusion: 'failure' }] })
    await command(first.id, { operation: 'bind', target }); await control.tick()
    await command(first.id, { operation: 'unbind', target })
    await command(second.id, { operation: 'bind', target }); await control.tick()
    expect(store.inbox(runtime.instance, second.id).some(m => m.body.includes('failure'))).toBe(true)
    const old = await config(second.id)
    await control.stop()
    control = new Control(runtime, { ci, now: () => clock }); control.attach(server); control.start()
    const response = await fetch(`${origin}/api/chat/control`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Poise-Chat': second.id, Authorization: `Bearer ${old.token}` }, body: '{"operation":"list"}' })
    expect(response.status).toBe(403)
  })

  it('routes local behavior changes to the matching work owner and fails visibly when CI cannot be read', async () => {
    const parent = await manager(), unrelated = await manager()
    await command(parent.id, { operation: 'bind', target: 'https://github.com/acme/app/pull/44' })
    ci.mockRejectedValue(new Error('GitHub access unavailable'))
    database.db.prepare(`INSERT INTO behavior_seen(key,target,seen_at,launch_repo,launch_pr,launch_behavior,launch_error)
      VALUES(?, ?, ?, ?, ?, ?, ?)`).run('review-new-prs', 'acme/app#44', new Date().toISOString(), 'acme/app', 44, 'pr_review', 'Review failed')
    database.db.prepare(`INSERT INTO behavior_seen(key,target,seen_at,launch_repo,launch_pr,launch_error)
      VALUES(?, ?, ?, ?, ?, ?)`).run('rerun-grey-ci', 'acme/app#44:workflow', new Date().toISOString(), 'acme/app', 44, 'Rerun failed')
    await control.tick()
    expect(store.inbox(runtime.instance, parent.id).map(m => m.body).join('\n')).toContain('Review failed')
    expect(store.inbox(runtime.instance, parent.id).map(m => m.body).join('\n')).toContain('Rerun failed')
    expect(store.inbox(runtime.instance, parent.id).map(m => m.body).join('\n')).toContain('ci_unavailable')
    expect(store.inbox(runtime.instance, unrelated.id)).toHaveLength(0)
  })

  it('keeps pending work while draining and releases ownership when its chat is deleted', async () => {
    const parent = await manager()
    await command(parent.id, { operation: 'bind', target: 'https://github.com/acme/app/issues/88' })
    store.message(runtime.instance, parent.id, 'fixture', 'Pending authorized task')
    runtime.startDrain('fixture-release')
    await control.tick()
    expect(prompts.has(parent.id)).toBe(false)
    expect(store.inbox(runtime.instance, parent.id)[0].state).toBe('pending')
    runtime.endDrain()
    await runtime.delete(parent.id)
    expect(store.bindings(runtime.instance)).toHaveLength(0)
  })

  it('advances past a full page of messages blocked by a deferred task queue', async () => {
    const blocked = await manager(), recipient = await manager()
    await runtime.enqueue(blocked.id, randomUUID(), { text: 'Deferred user task', attachments: [], mentions: [] })
    for (let i = 0; i < 100; i++) store.message(runtime.instance, blocked.id, 'fixture', `Pending context ${i}`)
    store.message(runtime.instance, recipient.id, 'fixture', 'Deliver this context')
    await control.tick()
    await control.tick()
    await until(() => prompts.has(recipient.id))
    expect(prompts.has(blocked.id)).toBe(false)
    expect(store.inbox(runtime.instance, recipient.id)[0].state).toBe('admitted')
    expect(store.inbox(runtime.instance, blocked.id).every(m => m.state === 'pending')).toBe(true)
  })

  it('starts no native work when the atomic inbox admission write fails', async () => {
    const parent = await manager()
    store.message(runtime.instance, parent.id, 'fixture', 'Run this task once')
    database.db.exec(`CREATE TEMP TRIGGER refuse_control_admission BEFORE UPDATE ON chat_control_inbox
      WHEN NEW.state = 'admitted' BEGIN SELECT RAISE(ABORT, 'fixture admission write failed'); END`)
    try {
      await control.tick()
      expect(runtime.working()).toBe(0)
      expect(storage.getOpenTurn(parent.id)).toBeNull()
      expect(prompts.has(parent.id)).toBe(false)
      expect(store.inbox(runtime.instance, parent.id)[0].state).toBe('pending')
    } finally { database.db.exec('DROP TRIGGER refuse_control_admission') }
    await control.tick()
    await until(() => prompts.has(parent.id))
    expect(prompts.get(parent.id)).toHaveLength(1)
    expect(store.inbox(runtime.instance, parent.id)[0].state).toBe('admitted')
  })

  it('bounds oversized supervision without blocking delivery to unrelated chats', async () => {
    const supervisor = await manager(), worker = await manager(), recipient = await manager()
    for (let number = 1; number <= 300; number++) store.bindWork(runtime.instance, worker.id, `https://github.com/large/app/issues/${number}`)
    await command(supervisor.id, { operation: 'supervise', sessionIds: [worker.id], intervalMinutes: 10, instruction: 'Inspect the complete assigned work' })
    store.message(runtime.instance, recipient.id, 'fixture', 'Unrelated authorized task')
    clock += 11 * 60_000
    await control.tick()
    const notice = store.inbox(runtime.instance, supervisor.id)[0]
    expect(Buffer.byteLength(notice.body)).toBeLessThanOrEqual(32 * 1024)
    expect(JSON.parse(notice.body)).toMatchObject({ kind: 'supervision', truncated: true })
    expect(store.watches(runtime.instance)[0].next_at).toBe(clock + 10 * 60_000)
    expect(store.inbox(runtime.instance, recipient.id)[0].state).toBe('admitted')
  }, 30_000)

  it('does not notify a stale owner or restore its observations after a CI read crosses a handoff', async () => {
    const first = await manager(), second = await manager()
    const target = 'https://github.com/acme/app/pull/46'
    await command(first.id, { operation: 'bind', target })
    let complete!: (value: CiObservation) => void
    ci.mockImplementationOnce(() => new Promise<CiObservation>(done => { complete = done }))
    const reading = control.tick()
    await until(() => ci.mock.calls.length === 1)
    await command(first.id, { operation: 'unbind', target })
    await command(second.id, { operation: 'bind', target })
    const failure = { head: 'a'.repeat(40), failing: [{ name: 'Verify', state: 'completed', conclusion: 'failure' }] }
    complete(failure)
    await reading
    expect(store.inbox(runtime.instance, first.id)).toHaveLength(0)
    expect(store.observation(runtime.instance, `ci:${target}`)).toBeUndefined()
    ci.mockResolvedValue(failure)
    await control.tick()
    expect(store.inbox(runtime.instance, second.id).some(m => m.body.includes('failure'))).toBe(true)
  })

  it('preserves each recipient message order across dispatch-page boundaries', async () => {
    const recipient = await manager()
    for (let i = 0; i < 101; i++) store.message(runtime.instance, recipient.id, 'fixture', `Ordered ${i}`)
    await control.tick()
    await until(() => prompts.has(recipient.id))
    expect(prompts.get(recipient.id)![0].text.endsWith('\nOrdered 0')).toBe(true)
    finishes.get(recipient.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(recipient.id)?.status === 'idle')
    await control.tick()
    await until(() => prompts.get(recipient.id)?.length === 2)
    expect(prompts.get(recipient.id)![1].text.endsWith('\nOrdered 1')).toBe(true)
    expect(store.inbox(runtime.instance, recipient.id)[1].state).toBe('admitted')
  })

  it('returns to an unblocked recipient while a later recipient keeps receiving new messages', async () => {
    const pair = [await manager(), await manager()].sort((a, b) => a.id < b.id ? -1 : 1)
    const [blocked, fast] = pair
    const taskId = randomUUID()
    await runtime.enqueue(blocked.id, taskId, { text: 'Deferred task', attachments: [], mentions: [] })
    store.message(runtime.instance, blocked.id, 'fixture', 'Older blocked context')
    store.message(runtime.instance, fast.id, 'fixture', 'Fast context 0')
    await control.tick()
    await until(() => prompts.has(fast.id))
    runtime.removeQueue(blocked.id, taskId)
    finishes.get(fast.id)!({ stopReason: 'end_turn' })
    await until(() => runtime.get(fast.id)?.status === 'idle')
    store.message(runtime.instance, fast.id, 'fixture', 'Fast context 1')
    await control.tick()
    expect(store.inbox(runtime.instance, blocked.id)[0].state, JSON.stringify({
      blockedStatus: runtime.get(blocked.id)?.status, blockedQueue: runtime.get(blocked.id)?.queue,
      fastStatus: runtime.get(fast.id)?.status, eligible: store.pending(runtime.instance).map(item => ({ recipient: item.recipient, seq: item.seq })),
    })).toBe('admitted')
  })

  it('rejects missing/forged credentials, browser origins, foreign sessions and malformed targets', async () => {
    const parent = await manager()
    const connection = await config(parent.id)
    const variants: Array<Record<string, string>> = [
      {}, { 'X-Poise-Chat': parent.id, Authorization: 'Bearer forged' },
      { 'X-Poise-Chat': parent.id, Authorization: `Bearer ${connection.token}`, Origin: origin },
      { 'X-Poise-Chat': 'foreign', Authorization: `Bearer ${connection.token}` },
    ]
    for (const headers of variants) {
      const result = await fetch(`${origin}/api/chat/control`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{"operation":"list"}' })
      expect(result.ok).toBe(false)
    }
    await expect(command(parent.id, { operation: 'bind', target: 'https://github.com/acme/app/pull/9/files' })).rejects.toThrow('exact GitHub')
    await expect(command(parent.id, { operation: 'bind', target: `https://github.com/${'a'.repeat(2000)}/app/issues/1` })).rejects.toThrow('1024')
    await expect(command(parent.id, { operation: 'supervise', sessionIds: [parent.id], intervalMinutes: 0, instruction: 'loop' })).rejects.toThrow()
  })

  it('executes the actual native command and exposes normal local Poise APIs without leaking its credential', async () => {
    const parent = await manager()
    const connection = await config(parent.id)
    const script = resolve('scripts/poise-chat-control.mjs')
    const help = await executeFile(process.execPath, [script, connection.path, '{"operation":"help"}'])
    expect(JSON.parse(help.stdout).operations).toHaveProperty('create')
    expect(help.stdout + help.stderr).not.toContain(connection.token)
    const result = await executeFile(process.execPath, [script, connection.path, '{"operation":"api","path":"/api/behaviors"}'])
    expect(JSON.parse(result.stdout)).toEqual({ nativeApi: true, path: '/api/behaviors' })
    await expect(executeFile(process.execPath, [script, connection.path, '{"operation":"api","path":"//evil.test/api/settings"}'])).rejects.toThrow('local /api/')
    for (const requestId of ['', 0, null]) {
      await expect(executeFile(process.execPath, [script, connection.path, JSON.stringify({ operation: 'create', requestId, title: 'Must not create', task: 'Must not run' })])).rejects.toThrow('requestId must be a UUID')
    }
    expect(storage.listSessions(runtime.instance)).toHaveLength(1)
  })

  it('announces native-created workers to connected browsers before any subscription exists', async () => {
    const { ChatSocketServer } = await import('../server/chat/transport')
    const transport = new ChatSocketServer(runtime)
    transport.attach(server)
    const parent = await manager()
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws/chat')
    try {
      await new Promise<void>((done, fail) => { socket.once('open', done); socket.once('error', fail) })
      const updates: SessionRecord[] = []
      const notice = new Promise<SessionRecord>((done, fail) => {
        const timer = setTimeout(() => fail(new Error('missing native session discovery')), 8000)
        socket.on('message', raw => {
          const frame = JSON.parse(raw.toString()) as ServerFrame
          if (frame.kind === 'session.created') { clearTimeout(timer); done(frame.session) }
          if (frame.kind === 'session.updated') updates.push(frame.session)
        })
      })
      const result = await command(parent.id, { operation: 'create', title: 'Visible worker', task: 'Run the delegated task' })
      const child = (result.session as { id: string }).id
      expect(await notice).toMatchObject({ id: child, title: 'Visible worker', lastSeq: 1 })
      await control.tick()
      await until(() => updates.some(s => s.id === child && s.status === 'running'))
    } finally { socket.terminate(); await transport.close() }
  })
})
