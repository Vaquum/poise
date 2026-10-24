// A bound turn that ends with work left behind never settles silently:
// unpushed commits, uncommitted changes and still-running background jobs
// flag the chat as stalled, and the monitor cycle wakes it once per episode.

import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentId, ChatEnvelope, ChatEvent, PromptInput } from '../../server/chat/protocol'
import type { Adapter, AdapterHost, AdapterStartOptions, TurnResult } from '../../server/chat/adapters/types'
import type { CallerTurns } from '../../server/chat/caller-turns'
import { CATALOG } from '../model-catalog-fixture'

// Process starts stall past the global 10 s under suite load: the fixture
// hook gets 25 s, and each case sets its own 40 s.
vi.setConfig({ hookTimeout: 25_000 })
let root = ''
let repo = ''
let origin = ''
let runtimeModule: typeof import('../../server/chat/runtime')
let controlModule: typeof import('../../server/chat/control')
let storage: typeof import('../../server/chat/storage')
let store: typeof import('../../server/chat/control-store')
let worker: typeof import('../../server/chat/worker')

function git(args: string[], cwd = repo): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

interface FakeControls {
  hosts: AdapterHost[]
  adapters: FakeAdapter[]
  prompts: PromptInput[]
  /** When set, the first prompt commits this file and leaves `dirty` uncommitted. */
  commitFirst?: { file: string, content: string, dirty: string }
  /** When set, the agent runs this instead of finishing instantly. */
  startWorker?: { command: string, args: string[] }
  /** When set, the first prompt throws, ending the turn as an error. */
  failFirst?: string
  /** When set, prompts wait for finishTurn instead of resolving. */
  manual?: boolean
  finishTurn?: ((result: { stopReason: 'end_turn' | 'cancelled' }) => void) | null
}

class FakeAdapter implements Adapter {
  agent: AgentId = 'grok'
  nativeSessionId: string | undefined
  capabilities = { steer: true, fork: true, thought: true, plan: true, commands: true, modes: false, permissions: true, questions: true, resume: true, images: false }
  alive = false
  constructor(readonly host: AdapterHost, readonly controls: FakeControls) {}
  async start(options: AdapterStartOptions) {
    this.alive = true
    if (this.controls.startWorker) await this.host.spawn(this.controls.startWorker.command, this.controls.startWorker.args)
    this.nativeSessionId = options.resume || `native-${this.controls.adapters.length}`
    return { nativeSessionId: this.nativeSessionId, capabilities: this.capabilities, modelId: options.modelId, effort: options.effort, efforts: ['high', 'xhigh'] }
  }
  seen: PromptInput[] = []
  async prompt(turnId: string, input: PromptInput) {
    this.controls.prompts.push(input)
    this.seen.push(input)
    this.host.emit({ type: 'text.delta', turnId, messageId: `${turnId}:m1`, delta: `echo: ${input.text.slice(0, 40)}` })
    if (this.controls.commitFirst && this.controls.prompts.length === 1) {
      const { file, content, dirty } = this.controls.commitFirst
      await writeFile(join(this.host.checkout, file), content)
      await writeFile(join(this.host.checkout, dirty), 'uncommitted\n')
      git(['add', file], this.host.checkout)
      git(['commit', '-q', '-m', 'work the turn leaves unpushed'], this.host.checkout)
    }
    if (this.controls.failFirst && this.controls.prompts.length === 1) throw new Error(this.controls.failFirst)
    if (this.controls.manual) {
      return new Promise<TurnResult>((resolve) => {
        this.controls.finishTurn = (result) => resolve({ ...result, usage: { totalTokens: 3 } })
      })
    }
    return { stopReason: 'end_turn' as const, usage: { totalTokens: 3 } }
  }
  async steer() {}
  async cancel() {
    this.controls.finishTurn?.({ stopReason: 'cancelled' })
    this.controls.finishTurn = null
  }
  async setModel(modelId: string, effort: string) { return { modelId, effort } }
  async setMode() {}
  async fork() { return `${this.nativeSessionId}-fork` }
  async close() { this.alive = false }
  onExit() {}
}

const runtimes: Array<import('../../server/chat/runtime').ChatRuntime> = []
const controls: Array<import('../../server/chat/control').ChatControl> = []
const servers: Server[] = []

function makeRuntime(instance: string, owned: FakeControls) {
  const caller: CallerTurns = {
    async start() { return 'a'.repeat(32) },
    async finish(callId, status) { return { id: callId, status } },
  }
  const runtime = new runtimeModule.ChatRuntime({
    instance,
    instanceLabel: 'test',
    adapters: { grok: (host: AdapterHost) => { const a = new FakeAdapter(host, owned); owned.hosts.push(host); owned.adapters.push(a); return a } },
    callerTurns: caller,
    catalog: async () => CATALOG as any,
    resolveCheckout: async () => repo,
    localWorkspaceRoot: join(root, 'local-ws'),
    idleTimeoutMinutes: () => 0,
    requireClaudeReady: async () => {},
  })
  const events: ChatEnvelope[] = []
  runtime.on('event', (e: ChatEnvelope) => events.push(e))
  runtimes.push(runtime)
  return { runtime, events }
}

async function makeControl(runtime: import('../../server/chat/runtime').ChatRuntime) {
  const control = new controlModule.ChatControl(runtime, { targetStatus: async () => 'open' })
  const server = createServer((_req, res) => { res.statusCode = 404; res.end() })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  control.attach(server)
  control.start()
  controls.push(control)
  servers.push(server)
  return control
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-chat-turn-stall-'))
  process.env.POISE_DB = join(root, 'cache.db')
  process.env.POISE_LOCK_DIR = join(root, 'locks')
  origin = join(root, 'origin.git')
  spawnSync('git', ['init', '-q', '--bare', origin])
  repo = join(root, 'repo')
  await mkdir(repo)
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 't@example.invalid'])
  git(['config', 'user.name', 't'])
  await writeFile(join(repo, 'README.md'), '# repo\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'init'])
  git(['remote', 'add', 'origin', origin])
  git(['push', '-q', 'origin', 'main'])
  spawnSync('git', ['--git-dir', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
  vi.resetModules()
  runtimeModule = await import('../../server/chat/runtime')
  controlModule = await import('../../server/chat/control')
  storage = await import('../../server/chat/storage')
  store = await import('../../server/chat/control-store')
  worker = await import('../../server/chat/worker')
})

afterAll(async () => {
  const { closeDatabase } = await import('../../server/db')
  closeDatabase()
  delete process.env.POISE_DB
  delete process.env.POISE_LOCK_DIR
  vi.resetModules()
  await rm(root, { recursive: true, force: true })
})

afterEach(async () => {
  for (const control of controls.splice(0)) await control.stop().catch(() => undefined)
  for (const runtime of runtimes.splice(0)) await runtime.stop({ handover: false }).catch(() => undefined)
  for (const server of servers.splice(0)) await new Promise<void>((done) => server.close(() => done()))
  spawnSync('git', ['checkout', '-q', '--', '.'], { cwd: repo })
  spawnSync('git', ['clean', '-fdq'], { cwd: repo })
  spawnSync('git', ['switch', '-q', 'main'], { cwd: repo })
  for (const branch of git(['branch', '--format=%(refname:short)']).split('\n').map((b) => b.trim()).filter((b) => b && b !== 'main')) {
    spawnSync('git', ['branch', '-D', branch], { cwd: repo })
  }
})

async function waitFor(check: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

function finishManual(owned: FakeControls): void {
  const finish = owned.finishTurn
  if (!finish) throw new Error('no prompt waiting for finishTurn')
  owned.finishTurn = null
  finish({ stopReason: 'end_turn' })
}

const ofType = (events: ChatEnvelope[], id: string, type: ChatEvent['type']) => events.filter((e) => e.sessionId === id && e.event.type === type).map((e) => e.event as any)
const lastStatus = (events: ChatEnvelope[], id: string) => ofType(events, id, 'status.changed').at(-1)?.status

describe('turn stall detection and waking', () => {
  it('flags a bound turn that ends with unpushed work as stalled and wakes it once', async () => {
    const owned: FakeControls = { hosts: [], adapters: [], prompts: [],
      commitFirst: { file: 'work.txt', content: 'done\n', dirty: 'draft.txt' } }
    const { runtime, events } = makeRuntime('poise-turn-stall:db', owned)
    const session = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { new: 'chat/stall-a' } })
    store.bindWork(runtime.instance, session.id, 'https://github.com/acme/repo/issues/577')
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    runtime.prompt(session.id, { text: 'do the work', attachments: [], mentions: [] })
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 1)
    await waitFor(() => lastStatus(events, session.id) === 'idle')

    // Surfaced as stalled, with both git facets.
    const stalled = runtime.get(session.id)?.stall
    expect(stalled).toBeDefined()
    expect(stalled).toMatchObject({ repos: [{ path: '.', branch: 'chat/stall-a', dirtyFiles: 1, unpushedCommits: 1 }], backgroundJobs: [] })

    // Re-woken within one monitor cycle, with the leftover state.
    const control = await makeControl(runtime)
    await control.tick()
    await waitFor(() => owned.prompts.length === 2)
    expect(owned.prompts[1].text).toContain('unpushed')
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 2)
    await waitFor(() => lastStatus(events, session.id) === 'idle')

    // The same leftover never wakes again: no nag loop.
    await control.tick()
    await new Promise((r) => setTimeout(r, 1_500))
    await control.tick()
    expect(owned.prompts.length).toBe(2)
    await runtime.stop({ handover: false })
  }, 40_000)

  it('leaves an unbound session that ends with unpushed work alone', async () => {
    const owned: FakeControls = { hosts: [], adapters: [], prompts: [],
      commitFirst: { file: 'work.txt', content: 'done\n', dirty: 'draft.txt' } }
    const { runtime, events } = makeRuntime('poise-turn-stall-unbound:db', owned)
    const session = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { new: 'chat/stall-unbound' } })
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    runtime.prompt(session.id, { text: 'do the work', attachments: [], mentions: [] })
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 1)
    await waitFor(() => lastStatus(events, session.id) === 'idle')

    expect(runtime.get(session.id)?.stall).toBeUndefined()
    expect(store.inbox(runtime.instance, session.id)).toHaveLength(0)
    await runtime.stop({ handover: false })
  }, 40_000)

  it('tracks a background job the turn starts and wakes the chat when it finishes', async () => {
    // The trigger fifo lives outside every checkout, so it never dirties
    // one; it predates the agent, which blocks opening it at startup with
    // no children at all.
    const fifoPath = join(root, 'bg-trigger.fifo')
    const pidPath = join(root, 'bg-trigger.pid')
    spawnSync('rm', ['-f', fifoPath, pidPath])
    const fifo = spawnSync('mkfifo', [fifoPath])
    if (fifo.status !== 0) throw new Error(`mkfifo: ${fifo.stderr}`)
    const owned: FakeControls = { hosts: [], adapters: [], prompts: [], manual: true,
      startWorker: { command: 'sh', args: ['-c', `read line < ${fifoPath}; sleep 30 & echo $! > ${pidPath}; wait`] } }
    const { runtime, events } = makeRuntime('poise-turn-stall-bg:db', owned)
    const session = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { new: 'chat/stall-bg' } })
    store.bindWork(runtime.instance, session.id, 'https://github.com/acme/repo/issues/577')
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    runtime.prompt(session.id, { text: 'run the suite', attachments: [], mentions: [] })
    // The baseline is taken before the prompt reaches the adapter, so the
    // sleep the turn starts afterwards is new by construction — matched
    // exactly, never via the agent's own command line.
    await waitFor(() => owned.prompts.length === 1)
    await writeFile(fifoPath, 'run\n')
    const row = storage.getWorker(session.id)
    if (!row) throw new Error('no worker row for the session')
    await waitFor(async () => (await worker.groupMembers(row.gatePgid))?.some((m) => m.command === 'sleep 30') ?? false)
    spawnSync('rm', ['-f', fifoPath, pidPath])
    finishManual(owned)
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 1)
    await waitFor(() => lastStatus(events, session.id) === 'idle')

    // The agent idles, but its background sleep outlives the turn.
    const jobs = runtime.get(session.id)?.stall?.backgroundJobs ?? []
    expect(jobs).toHaveLength(1)
    expect(jobs[0].command).toBe('sleep 30')
    expect(worker.pidAlive(jobs[0].pid)).toBe(true)

    // The job finishes while no turn runs; the monitor cycle wakes the chat.
    process.kill(jobs[0].pid, 'SIGTERM')
    await waitFor(() => !worker.pidAlive(jobs[0].pid))
    const control = await makeControl(runtime)
    await control.tick()
    await waitFor(() => owned.prompts.length === 2)
    expect(owned.prompts[1].text).toContain('still running')
    finishManual(owned)
    await waitFor(() => owned.prompts.length === 3)
    expect(owned.prompts[2].text).toContain('finished')
    expect(owned.prompts[2].text).toContain('sleep 30')
    finishManual(owned)
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 3)
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    expect(runtime.get(session.id)?.stall).toBeUndefined()

    // Each notice fires once: no completion replay, no nag loop.
    await control.tick()
    await new Promise((r) => setTimeout(r, 1_500))
    await control.tick()
    expect(owned.prompts.length).toBe(3)
    await runtime.stop({ handover: false })
  }, 40_000)

  it('tracks every background job past twenty and wakes each completion', async () => {
    const fifoPath = join(root, 'bg-many-trigger.fifo')
    spawnSync('rm', ['-f', fifoPath])
    const fifo = spawnSync('mkfifo', [fifoPath])
    if (fifo.status !== 0) throw new Error(`mkfifo: ${fifo.stderr}`)
    const owned: FakeControls = { hosts: [], adapters: [], prompts: [], manual: true,
      startWorker: { command: 'sh', args: ['-c', `read line < ${fifoPath}; i=0; while [ $i -lt 21 ]; do sleep 30 & i=$((i + 1)); done; wait`] } }
    const { runtime, events } = makeRuntime('poise-turn-stall-many:db', owned)
    const session = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { new: 'chat/stall-many' } })
    store.bindWork(runtime.instance, session.id, 'https://github.com/acme/repo/issues/577')
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    runtime.prompt(session.id, { text: 'run the suite', attachments: [], mentions: [] })
    await waitFor(() => owned.prompts.length === 1)
    await writeFile(fifoPath, 'run\n')
    const row = storage.getWorker(session.id)
    if (!row) throw new Error('no worker row for the session')
    await waitFor(async () => ((await worker.groupMembers(row.gatePgid))?.filter((m) => m.command === 'sleep 30').length ?? 0) === 21)
    spawnSync('rm', ['-f', fifoPath])
    finishManual(owned)
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 1)
    await waitFor(() => lastStatus(events, session.id) === 'idle')

    // All 21 are tracked: only the notice rendering is capped, never the
    // tracking — a dropped pid would read as pre-existing ever after.
    const jobs = runtime.get(session.id)?.stall?.backgroundJobs ?? []
    expect(jobs).toHaveLength(21)
    const overflow = jobs[20]

    // The wake notice lists 20 and counts the rest.
    const control = await makeControl(runtime)
    await control.tick()
    await waitFor(() => owned.prompts.length === 2)
    expect(owned.prompts[1].text).toContain('1 more background job')
    finishManual(owned)
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 2)
    await waitFor(() => lastStatus(events, session.id) === 'idle')

    // The overflow job's completion wakes with its identity.
    process.kill(overflow.pid, 'SIGTERM')
    await waitFor(() => !worker.pidAlive(overflow.pid))
    await control.tick()
    await waitFor(() => owned.prompts.length === 3)
    expect(owned.prompts[2].text).toContain('finished')
    expect(owned.prompts[2].text).toContain(String(overflow.pid))
    finishManual(owned)
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 3)
    await waitFor(() => lastStatus(events, session.id) === 'idle')

    // The rest finish; the stall clears with nothing left.
    for (const job of jobs) {
      if (job.pid !== overflow.pid && worker.pidAlive(job.pid)) process.kill(job.pid, 'SIGTERM')
    }
    await waitFor(async () => (await worker.groupMembers(row.gatePgid))?.every((m) => m.command !== 'sleep 30') ?? false)
    await control.tick()
    await waitFor(() => runtime.get(session.id)?.stall === undefined)
    await runtime.stop({ handover: false })
  }, 60_000)

  it('tracks and wakes a job whose command exceeds the label length', async () => {
    const fifoPath = join(root, 'bg-long-trigger.fifo')
    spawnSync('rm', ['-f', fifoPath])
    const fifo = spawnSync('mkfifo', [fifoPath])
    if (fifo.status !== 0) throw new Error(`mkfifo: ${fifo.stderr}`)
    const pad = 'x'.repeat(250)
    const owned: FakeControls = { hosts: [], adapters: [], prompts: [], manual: true,
      startWorker: { command: 'sh', args: ['-c', `read line < ${fifoPath}; sh -c 'sleep 30' ${pad} & wait`] } }
    const { runtime, events } = makeRuntime('poise-turn-stall-long:db', owned)
    const session = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { new: 'chat/stall-long' } })
    store.bindWork(runtime.instance, session.id, 'https://github.com/acme/repo/issues/577')
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    runtime.prompt(session.id, { text: 'run the suite', attachments: [], mentions: [] })
    await waitFor(() => owned.prompts.length === 1)
    await writeFile(fifoPath, 'run\n')
    const row = storage.getWorker(session.id)
    if (!row) throw new Error('no worker row for the session')
    await waitFor(async () => (await worker.groupMembers(row.gatePgid))?.some((m) => m.command.startsWith('sh -c sleep 30')) ?? false)
    spawnSync('rm', ['-f', fifoPath])
    finishManual(owned)
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 1)
    await waitFor(() => lastStatus(events, session.id) === 'idle')

    // Clipped consistently on both sides of every comparison: the long
    // shell tracks under its clipped label next to its short sleep child.
    const jobs = runtime.get(session.id)?.stall?.backgroundJobs ?? []
    expect(jobs).toHaveLength(2)
    const long = jobs.find((job) => job.command.length > 200)
    const short = jobs.find((job) => job.command === 'sleep 30')
    if (!long || !short) throw new Error('expected the long shell and its sleep child')
    expect(long.command).toHaveLength(201)
    expect(long.command.endsWith('…')).toBe(true)

    process.kill(long.pid, 'SIGTERM')
    await waitFor(() => !worker.pidAlive(long.pid))
    const control = await makeControl(runtime)
    await control.tick()
    await waitFor(() => owned.prompts.length === 2)
    finishManual(owned)
    await waitFor(() => owned.prompts.length === 3)
    expect(owned.prompts[2].text).toContain('finished')
    expect(owned.prompts[2].text).toContain('…')
    finishManual(owned)
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 3)
    await waitFor(() => lastStatus(events, session.id) === 'idle')

    // The orphaned sleep outlives its parent under the same group; once it
    // goes too, the stall clears.
    if (worker.pidAlive(short.pid)) process.kill(short.pid, 'SIGTERM')
    await waitFor(() => !worker.pidAlive(short.pid))
    await control.tick()
    await waitFor(() => runtime.get(session.id)?.stall === undefined)
    await runtime.stop({ handover: false })
  }, 40_000)

  it('keeps tracking a job that execs into another program instead of announcing it', async () => {
    // Two trigger fifos outside every checkout. The agent spawns a subshell
    // that blocks opening the second fifo; writing it makes the same pid
    // exec into sleep, which must read as the job continuing, not finishing.
    const fifo1 = join(root, 'bg-exec-1.fifo')
    const fifo2 = join(root, 'bg-exec-2.fifo')
    spawnSync('rm', ['-f', fifo1, fifo2])
    for (const fifo of [fifo1, fifo2]) {
      const made = spawnSync('mkfifo', [fifo])
      if (made.status !== 0) throw new Error(`mkfifo: ${made.stderr}`)
    }
    const agentScript = `read line < ${fifo1}; (read line < ${fifo2}; exec sleep 60) & wait`
    const owned: FakeControls = { hosts: [], adapters: [], prompts: [], manual: true,
      startWorker: { command: 'sh', args: ['-c', agentScript] } }
    const { runtime, events } = makeRuntime('poise-turn-stall-exec:db', owned)
    const session = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { new: 'chat/stall-exec' } })
    store.bindWork(runtime.instance, session.id, 'https://github.com/acme/repo/issues/577')
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    runtime.prompt(session.id, { text: 'run the suite', attachments: [], mentions: [] })
    await waitFor(() => owned.prompts.length === 1)
    await writeFile(fifo1, 'run\n')
    const row = storage.getWorker(session.id)
    if (!row) throw new Error('no worker row for the session')
    const shCmd = `sh -c ${agentScript}`
    // The agent plus its blocked subshell share the forked command line.
    await waitFor(async () => (await worker.groupMembers(row.gatePgid))?.filter((m) => m.command === shCmd).length === 2)
    finishManual(owned)
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 1)
    await waitFor(() => lastStatus(events, session.id) === 'idle')

    const tracked = runtime.get(session.id)?.stall?.backgroundJobs ?? []
    expect(tracked).toHaveLength(1)
    const pid = tracked[0].pid
    expect(tracked[0].command).toBe(shCmd)

    // The same pid execs into sleep; the monitor cycle must keep it under
    // the new command and queue no completion.
    await writeFile(fifo2, 'run\n')
    await waitFor(async () => (await worker.groupMembers(row.gatePgid))?.some((m) => m.pid === pid && m.command === 'sleep 60') ?? false)
    const control = await makeControl(runtime)
    await control.tick()
    await waitFor(() => runtime.get(session.id)?.stall?.backgroundJobs[0]?.command === 'sleep 60')
    const kept = runtime.get(session.id)?.stall?.backgroundJobs ?? []
    expect(kept).toHaveLength(1)
    expect(kept[0].pid).toBe(pid)

    // The stall notice still wakes the chat, but no completion follows it.
    await waitFor(() => owned.prompts.length === 2)
    expect(owned.prompts[1].text).toContain('still running')
    finishManual(owned)
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 2)
    await control.tick()
    await new Promise((r) => setTimeout(r, 1_500))
    await control.tick()
    expect(owned.prompts.length).toBe(2)

    // When the exec'd program really exits, its completion wakes once.
    process.kill(pid, 'SIGTERM')
    await waitFor(() => !worker.pidAlive(pid))
    await control.tick()
    await waitFor(() => owned.prompts.length === 3)
    expect(owned.prompts[2].text).toContain('finished')
    expect(owned.prompts[2].text).toContain('sleep 60')
    finishManual(owned)
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 3)
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    expect(runtime.get(session.id)?.stall).toBeUndefined()
    spawnSync('rm', ['-f', fifo1, fifo2])
    await runtime.stop({ handover: false })
  }, 40_000)

  it('clears the stall once the leftover is pushed and committed', async () => {
    const owned: FakeControls = { hosts: [], adapters: [], prompts: [],
      commitFirst: { file: 'work.txt', content: 'done\n', dirty: 'draft.txt' } }
    const { runtime, events } = makeRuntime('poise-turn-stall-clear:db', owned)
    const session = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { new: 'chat/stall-clear' } })
    store.bindWork(runtime.instance, session.id, 'https://github.com/acme/repo/issues/577')
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    runtime.prompt(session.id, { text: 'do the work', attachments: [], mentions: [] })
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 1)
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    expect(runtime.get(session.id)?.stall).toBeDefined()

    // The work lands before the wake turn runs; that turn clears the marker.
    git(['push', '-q', 'origin', 'chat/stall-clear'])
    spawnSync('rm', ['draft.txt'], { cwd: repo })
    const control = await makeControl(runtime)
    await control.tick()
    await waitFor(() => owned.prompts.length === 2)
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 2)
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    expect(runtime.get(session.id)?.stall).toBeUndefined()
    await runtime.stop({ handover: false })
  }, 40_000)

  it('flags unpushed work in a local worker nested clone, not the workspace root', async () => {
    const owned: FakeControls = { hosts: [], adapters: [], prompts: [] }
    const { runtime, events } = makeRuntime('poise-turn-stall-nested:db', owned)
    const session = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh' })
    expect(session.workspaceKind).toBe('poise-local')
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    // The worker's task repo, like a real clone: one unpushed commit and one draft.
    const task = join(session.checkout, 'task')
    const cloned = spawnSync('git', ['clone', '-q', origin, task], { encoding: 'utf8' })
    if (cloned.status !== 0) throw new Error(`git clone: ${cloned.stderr}`)
    git(['checkout', '-qb', 'work'], task)
    await writeFile(join(task, 'fix.txt'), 'fix\n')
    git(['add', 'fix.txt'], task)
    git(['commit', '-qm', 'unpushed fix'], task)
    await writeFile(join(task, 'draft.txt'), 'uncommitted\n')
    store.bindWork(runtime.instance, session.id, 'https://github.com/acme/repo/issues/577')
    runtime.prompt(session.id, { text: 'do the work', attachments: [], mentions: [] })
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 1)
    await waitFor(() => lastStatus(events, session.id) === 'idle')

    // Only the nested clone flags: the workspace root's own bootstrap
    // commit is Poise's checkpoint store, never worker output.
    const stalled = runtime.get(session.id)?.stall
    expect(stalled).toBeDefined()
    expect(stalled).toMatchObject({ repos: [{ path: 'task', branch: 'work', dirtyFiles: 1, unpushedCommits: 1 }], backgroundJobs: [] })

    const control = await makeControl(runtime)
    await control.tick()
    await waitFor(() => owned.prompts.length === 2)
    expect(owned.prompts[1].text).toContain('task')
    expect(owned.prompts[1].text).toContain('unpushed')
    await runtime.stop({ handover: false })
  }, 40_000)

  it('drops the handoff source pending stall notices and re-detects on the target', async () => {
    const owned: FakeControls = { hosts: [], adapters: [], prompts: [],
      commitFirst: { file: 'work.txt', content: 'done\n', dirty: 'draft.txt' } }
    const { runtime, events } = makeRuntime('poise-turn-stall-handoff:db', owned)
    const source = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { new: 'chat/stall-handoff' } })
    store.bindWork(runtime.instance, source.id, 'https://github.com/acme/repo/issues/577')
    await waitFor(() => lastStatus(events, source.id) === 'idle')
    runtime.prompt(source.id, { text: 'do the work', attachments: [], mentions: [] })
    await waitFor(() => ofType(events, source.id, 'turn.finished').length === 1)
    await waitFor(() => lastStatus(events, source.id) === 'idle')
    expect(runtime.get(source.id)?.stall).toBeDefined()
    expect(store.inbox(runtime.instance, source.id)).toHaveLength(1)

    const target = await runtime.handoff(source.id, { agent: 'grok', model: 'grok-4.6-xhigh' })
    expect(store.bindings(runtime.instance).find((b) => b.target.endsWith('/issues/577'))?.session).toBe(target.id)
    expect(store.inbox(runtime.instance, source.id)).toHaveLength(0)

    // The leftover persists on the shared branch, so the target's first
    // turn end flags a fresh episode and wakes the target, never the source.
    await waitFor(() => ofType(events, target.id, 'turn.finished').length === 1)
    await waitFor(() => lastStatus(events, target.id) === 'idle')
    expect(runtime.get(target.id)?.stall?.repos).toHaveLength(1)
    expect(store.inbox(runtime.instance, target.id)).toHaveLength(1)
    const control = await makeControl(runtime)
    await control.tick()
    await waitFor(() => runtime.get(source.id)?.stall === undefined)
    const seenSource = owned.adapters[0].seen.length
    await control.tick()
    await new Promise((r) => setTimeout(r, 1_500))
    await control.tick()
    expect(owned.adapters[0].seen.length).toBe(seenSource)
    await runtime.stop({ handover: false })
  }, 40_000)

  it('forks without the source stall state', async () => {
    const owned: FakeControls = { hosts: [], adapters: [], prompts: [],
      commitFirst: { file: 'work.txt', content: 'done\n', dirty: 'draft.txt' } }
    const { runtime, events } = makeRuntime('poise-turn-stall-fork:db', owned)
    const session = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { new: 'chat/stall-fork' } })
    store.bindWork(runtime.instance, session.id, 'https://github.com/acme/repo/issues/577')
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    runtime.prompt(session.id, { text: 'do the work', attachments: [], mentions: [] })
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 1)
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    expect(runtime.get(session.id)?.stall).toBeDefined()

    const fork = await runtime.fork(session.id)
    expect(fork.id).not.toBe(session.id)
    expect(fork.stall).toBeUndefined()
    await waitFor(() => lastStatus(events, fork.id) === 'idle')
    expect(runtime.get(fork.id)?.stall).toBeUndefined()
    await runtime.stop({ handover: false })
  }, 40_000)

  it('keeps the previous repos when nested discovery fails transiently', async () => {
    if (process.getuid?.() === 0) return // unreadable-dir simulation needs permission checks
    const owned: FakeControls = { hosts: [], adapters: [], prompts: [] }
    const { runtime, events } = makeRuntime('poise-turn-stall-discovery:db', owned)
    const session = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh' })
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    const task = join(session.checkout, 'task')
    const cloned = spawnSync('git', ['clone', '-q', origin, task], { encoding: 'utf8' })
    if (cloned.status !== 0) throw new Error(`git clone: ${cloned.stderr}`)
    git(['checkout', '-qb', 'work'], task)
    await writeFile(join(task, 'fix.txt'), 'fix\n')
    git(['add', 'fix.txt'], task)
    git(['commit', '-qm', 'unpushed fix'], task)
    store.bindWork(runtime.instance, session.id, 'https://github.com/acme/repo/issues/577')
    runtime.prompt(session.id, { text: 'do the work', attachments: [], mentions: [] })
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 1)
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    const episode = runtime.get(session.id)?.stall?.episode
    expect(episode).toBeDefined()

    // The clone is briefly unreadable: the turn end keeps the previous
    // repos instead of reading the IO error as finished work.
    spawnSync('chmod', ['000', task])
    try {
      runtime.prompt(session.id, { text: 'again', attachments: [], mentions: [] })
      await waitFor(() => ofType(events, session.id, 'turn.finished').length === 2)
      await waitFor(() => lastStatus(events, session.id) === 'idle')
      expect(runtime.get(session.id)?.stall).toMatchObject({ episode, repos: [{ path: 'task' }] })
      expect(store.inbox(runtime.instance, session.id)).toHaveLength(1)
    } finally {
      spawnSync('chmod', ['755', task])
    }
    runtime.prompt(session.id, { text: 'once more', attachments: [], mentions: [] })
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 3)
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    expect(runtime.get(session.id)?.stall).toMatchObject({ episode, repos: [{ path: 'task', branch: 'work' }] })
    await runtime.stop({ handover: false })
  }, 40_000)

  it('caps the kept repos and still wakes', async () => {
    const owned: FakeControls = { hosts: [], adapters: [], prompts: [] }
    const { runtime, events } = makeRuntime('poise-turn-stall-cap:db', owned)
    const session = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh' })
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    for (let n = 0; n < 21; n++) {
      const dir = join(session.checkout, `repo${String(n).padStart(2, '0')}`)
      await mkdir(dir)
      const inited = spawnSync('git', ['init', '-q', '-b', 'main', dir], { encoding: 'utf8' })
      if (inited.status !== 0) throw new Error(`git init: ${inited.stderr}`)
      await writeFile(join(dir, 'draft.txt'), 'uncommitted\n')
    }
    store.bindWork(runtime.instance, session.id, 'https://github.com/acme/repo/issues/577')
    runtime.prompt(session.id, { text: 'do the work', attachments: [], mentions: [] })
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 1)
    await waitFor(() => lastStatus(events, session.id) === 'idle')

    const stalled = runtime.get(session.id)?.stall
    expect(stalled?.repos).toHaveLength(20)
    expect(stalled?.truncatedRepos).toBe(1)
    const control = await makeControl(runtime)
    await control.tick()
    await waitFor(() => owned.prompts.length === 2)
    expect(owned.prompts[1].text).toContain('more task repo')
    await runtime.stop({ handover: false })
  }, 40_000)

  it('keeps the stall when the last unfinished overflow repo cannot be read', async () => {
    const owned: FakeControls = { hosts: [], adapters: [], prompts: [] }
    const { runtime, events } = makeRuntime('poise-turn-stall-overflow-unreadable:db', owned)
    const session = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh' })
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    for (let n = 0; n < 21; n++) {
      const dir = join(session.checkout, `repo${String(n).padStart(2, '0')}`)
      await mkdir(dir)
      const inited = spawnSync('git', ['init', '-q', '-b', 'main', dir], { encoding: 'utf8' })
      if (inited.status !== 0) throw new Error(`git init: ${inited.stderr}`)
      await writeFile(join(dir, 'draft.txt'), 'uncommitted\n')
    }
    store.bindWork(runtime.instance, session.id, 'https://github.com/acme/repo/issues/577')
    runtime.prompt(session.id, { text: 'do the work', attachments: [], mentions: [] })
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 1)
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    expect(runtime.get(session.id)?.stall?.repos).toHaveLength(20)
    expect(runtime.get(session.id)?.stall?.truncatedRepos).toBe(1)

    // The 20 kept repos go clean while the overflow repo becomes unreadable:
    // with no saved entry for it, the stall must stay truncated, not clear.
    for (let n = 0; n < 20; n++) await rm(join(session.checkout, `repo${String(n).padStart(2, '0')}`, 'draft.txt'))
    const overflowHead = join(session.checkout, 'repo20', '.git', 'HEAD')
    const savedHead = await readFile(overflowHead, 'utf8')
    await writeFile(overflowHead, 'garbage: not a ref\n')
    try {
      runtime.prompt(session.id, { text: 'do more work', attachments: [], mentions: [] })
      await waitFor(() => ofType(events, session.id, 'turn.finished').length === 2)
      await waitFor(() => lastStatus(events, session.id) === 'idle')
      const kept = runtime.get(session.id)?.stall
      expect(kept?.repos).toHaveLength(0)
      expect(kept?.truncatedRepos).toBe(1)
    } finally {
      await writeFile(overflowHead, savedHead)
    }

    // Readable and clean, the overflow repo lets the stall clear.
    await rm(join(session.checkout, 'repo20', 'draft.txt'))
    runtime.prompt(session.id, { text: 'do final work', attachments: [], mentions: [] })
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 3)
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    expect(runtime.get(session.id)?.stall).toBeUndefined()
    await runtime.stop({ handover: false })
  }, 40_000)

  it('keeps truncated overflow across a restart that drops job tracking', async () => {
    const instance = 'poise-turn-stall-restart:db'
    const first = makeRuntime(instance, { hosts: [], adapters: [], prompts: [] })
    const session = await first.runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { new: 'chat/stall-restart' } })
    await waitFor(() => lastStatus(first.events, session.id) === 'idle')
    store.bindWork(first.runtime.instance, session.id, 'https://github.com/acme/repo/issues/577')
    // The shape a truncated stall has when the process dies: jobs that
    // cannot survive the restart, no kept repos, unfinished overflow.
    const record = first.runtime.get(session.id)
    if (!record) throw new Error('no session record')
    const now = new Date().toISOString()
    record.stall = { episode: 'e1', at: now, updatedAt: now, repos: [],
      backgroundJobs: [{ pid: 42424242, pgid: 42424242, command: 'sleep 30', startedAt: now }],
      truncatedRepos: 1 }
    storage.saveSession(record)
    await first.runtime.stop({ handover: false })

    const second = makeRuntime(instance, { hosts: [], adapters: [], prompts: [] })
    await second.runtime.recover()
    const kept = second.runtime.get(session.id)?.stall
    expect(kept?.backgroundJobs).toHaveLength(0)
    expect(kept?.repos).toHaveLength(0)
    expect(kept?.truncatedRepos).toBe(1)
    expect(store.inbox(instance, session.id)).toHaveLength(0)
    await second.runtime.stop({ handover: false })
  }, 40_000)

  it('keeps truncated overflow when nested discovery fails', async () => {
    if (process.getuid?.() === 0) return // unreadable-dir simulation needs permission checks
    const owned: FakeControls = { hosts: [], adapters: [], prompts: [] }
    const { runtime, events } = makeRuntime('poise-turn-stall-discovery-truncated:db', owned)
    const session = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh' })
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    store.bindWork(runtime.instance, session.id, 'https://github.com/acme/repo/issues/577')
    const seed = runtime.get(session.id)
    if (!seed) throw new Error('no session record')
    const now = new Date().toISOString()
    seed.stall = { episode: 'e1', at: now, updatedAt: now, repos: [], backgroundJobs: [], truncatedRepos: 1 }
    storage.saveSession(seed)

    // Discovery fails on the unreadable dir: the fallback keeps the
    // previous overflow count instead of resetting it to zero.
    const blocked = join(session.checkout, 'blocked')
    await mkdir(blocked)
    spawnSync('chmod', ['000', blocked])
    try {
      runtime.prompt(session.id, { text: 'do the work', attachments: [], mentions: [] })
      await waitFor(() => ofType(events, session.id, 'turn.finished').length === 1)
      await waitFor(() => lastStatus(events, session.id) === 'idle')
      const kept = runtime.get(session.id)?.stall
      expect(kept?.repos).toHaveLength(0)
      expect(kept?.truncatedRepos).toBe(1)
    } finally {
      spawnSync('chmod', ['755', blocked])
    }

    // With discovery healthy and nothing dirty, the stall clears.
    runtime.prompt(session.id, { text: 'do more work', attachments: [], mentions: [] })
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 2)
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    expect(runtime.get(session.id)?.stall).toBeUndefined()
    await runtime.stop({ handover: false })
  }, 40_000)

  it('leaves a failed turn with unpushed work to the error surface', async () => {
    const owned: FakeControls = { hosts: [], adapters: [], prompts: [],
      commitFirst: { file: 'work.txt', content: 'done\n', dirty: 'draft.txt' }, failFirst: 'boom' }
    const { runtime, events } = makeRuntime('poise-turn-stall-error:db', owned)
    const session = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { new: 'chat/stall-error' } })
    store.bindWork(runtime.instance, session.id, 'https://github.com/acme/repo/issues/577')
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    runtime.prompt(session.id, { text: 'do the work', attachments: [], mentions: [] })
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 1)
    expect(ofType(events, session.id, 'turn.finished').at(-1)).toMatchObject({ stopReason: 'error' })
    await waitFor(() => ['idle', 'interrupted', 'error'].includes(lastStatus(events, session.id)!))

    // Only a normally finished turn stalls: a failure is already visible.
    expect(runtime.get(session.id)?.stall).toBeUndefined()
    expect(store.inbox(runtime.instance, session.id)).toHaveLength(0)
    await runtime.stop({ handover: false })
  }, 40_000)
})
