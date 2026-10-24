// A bound turn that ends with work left behind never settles silently:
// unpushed commits, uncommitted changes and still-running background jobs
// flag the chat as stalled, and the monitor cycle wakes it once per episode.

import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentId, ChatEnvelope, ChatEvent, PromptInput } from '../../server/chat/protocol'
import type { Adapter, AdapterHost, AdapterStartOptions } from '../../server/chat/adapters/types'
import type { CallerTurns } from '../../server/chat/caller-turns'
import { CATALOG } from '../model-catalog-fixture'

let root = ''
let repo = ''
let origin = ''
let runtimeModule: typeof import('../../server/chat/runtime')
let controlModule: typeof import('../../server/chat/control')
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
  async prompt(turnId: string, input: PromptInput) {
    this.controls.prompts.push(input)
    this.host.emit({ type: 'text.delta', turnId, messageId: `${turnId}:m1`, delta: `echo: ${input.text.slice(0, 40)}` })
    if (this.controls.commitFirst && this.controls.prompts.length === 1) {
      const { file, content, dirty } = this.controls.commitFirst
      await writeFile(join(this.host.checkout, file), content)
      await writeFile(join(this.host.checkout, dirty), 'uncommitted\n')
      git(['add', file], this.host.checkout)
      git(['commit', '-q', '-m', 'work the turn leaves unpushed'], this.host.checkout)
    }
    if (this.controls.failFirst && this.controls.prompts.length === 1) throw new Error(this.controls.failFirst)
    return { stopReason: 'end_turn' as const, usage: { totalTokens: 3 } }
  }
  async steer() {}
  async cancel() {}
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

async function waitFor(check: () => boolean, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
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

  it('tracks a background job past the turn end and wakes the chat when it finishes', async () => {
    const owned: FakeControls = { hosts: [], adapters: [], prompts: [],
      startWorker: { command: 'sh', args: ['-c', 'sleep 30 & wait'] } }
    const { runtime, events } = makeRuntime('poise-turn-stall-bg:db', owned)
    const session = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { new: 'chat/stall-bg' } })
    store.bindWork(runtime.instance, session.id, 'https://github.com/acme/repo/issues/577')
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    runtime.prompt(session.id, { text: 'run the suite', attachments: [], mentions: [] })
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === 1)
    await waitFor(() => lastStatus(events, session.id) === 'idle')

    // The agent idles, but its background sleep outlives the turn.
    const jobs = runtime.get(session.id)?.stall?.backgroundJobs ?? []
    expect(jobs).toHaveLength(1)
    expect(jobs[0].command).toContain('sleep 30')
    expect(worker.pidAlive(jobs[0].pid)).toBe(true)

    // The job finishes while no turn runs; the monitor cycle wakes the chat.
    process.kill(jobs[0].pid, 'SIGTERM')
    await waitFor(() => !worker.pidAlive(jobs[0].pid))
    const control = await makeControl(runtime)
    await control.tick()
    await waitFor(() => owned.prompts.length === 3)
    expect(owned.prompts[1].text).toContain('still running')
    expect(owned.prompts[2].text).toContain('finished')
    expect(owned.prompts[2].text).toContain('sleep 30')
    expect(runtime.get(session.id)?.stall).toBeUndefined()

    // Each notice fires once: no completion replay, no nag loop.
    await control.tick()
    await new Promise((r) => setTimeout(r, 1_500))
    await control.tick()
    expect(owned.prompts.length).toBe(3)
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
