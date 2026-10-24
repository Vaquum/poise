// Stop ends the turn and its whole process tree: cancelling a turn whose
// agent never acknowledges still terminates the worker group (SIGTERM, then
// SIGKILL), leaves no descendant alive, and lets the next prompt run at once.

import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentId, ChatEnvelope, ChatEvent, PromptInput } from '../../server/chat/protocol'
import type { Adapter, AdapterHost, AdapterStartOptions } from '../../server/chat/adapters/types'
import type { CallerTurns } from '../../server/chat/caller-turns'
import { CATALOG } from '../model-catalog-fixture'

let root = ''
let repo = ''
let runtimeModule: typeof import('../../server/chat/runtime')
let storage: typeof import('../../server/chat/storage')
let worker: typeof import('../../server/chat/worker')

function git(args: string[], cwd = repo): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

interface FakeControls {
  hosts: AdapterHost[]
  adapters: FakeAdapter[]
  auto: boolean
  /** When true, prompt() ignores abort and cancel() does nothing: the agent
   *  never acknowledges the stop, like the stuck Muse turn in #545. */
  ignoreCancel?: boolean
  startWorker?: { command: string, args: string[] }
}

class FakeAdapter implements Adapter {
  agent: AgentId = 'grok'
  nativeSessionId: string | undefined
  capabilities = { steer: true, fork: true, thought: true, plan: true, commands: true, modes: false, permissions: true, questions: true, resume: true, images: false }
  alive = false
  private finishTurn: ((stop?: 'end_turn' | 'cancelled') => void) | null = null
  private exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  constructor(readonly host: AdapterHost, readonly controls: FakeControls) {
    // Like a real adapter, a dead link settles a pending prompt.
    const spawn = host.spawn.bind(host)
    host.spawn = (async (command, args, options) => {
      const peer = await spawn(command, args, options)
      peer.once('exit', () => this.finishTurn?.('cancelled'))
      return peer
    })
  }
  async start(options: AdapterStartOptions) {
    this.alive = true
    if (this.controls.startWorker) await this.host.spawn(this.controls.startWorker.command, this.controls.startWorker.args)
    this.nativeSessionId = options.resume || `native-${this.controls.adapters.length}`
    return { nativeSessionId: this.nativeSessionId, capabilities: this.capabilities, modelId: options.modelId, effort: options.effort, efforts: ['high', 'xhigh'] }
  }
  async prompt(turnId: string, input: PromptInput, signal: AbortSignal) {
    this.host.emit({ type: 'text.delta', turnId, messageId: `${turnId}:m1`, delta: `echo: ${input.text}` })
    if (this.controls.auto) return { stopReason: 'end_turn' as const, usage: { totalTokens: 3 } }
    return new Promise<{ stopReason: 'end_turn' | 'cancelled' }>((resolve) => {
      this.finishTurn = (stop = 'end_turn') => {
        this.finishTurn = null
        resolve({ stopReason: stop })
      }
      if (!this.controls.ignoreCancel) signal.addEventListener('abort', () => this.finishTurn?.('cancelled'), { once: true })
    })
  }
  async steer() {}
  async cancel() {
    if (!this.controls.ignoreCancel) this.finishTurn?.('cancelled')
  }
  async setModel(modelId: string, effort: string) { return { modelId, effort } }
  async setMode() {}
  async fork() { return `${this.nativeSessionId}-fork` }
  async close() { this.alive = false; for (const l of this.exitListeners) l(0, null) }
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void) { this.exitListeners.push(listener) }
}

const runtimes: Array<import('../../server/chat/runtime').ChatRuntime> = []

function makeRuntime(instance: string, controls?: FakeControls) {
  const owned: FakeControls = controls ?? { hosts: [], adapters: [], auto: true }
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
    idleTimeoutMinutes: () => 0,
    requireClaudeReady: async () => {},
  })
  const events: ChatEnvelope[] = []
  runtime.on('event', (e: ChatEnvelope) => events.push(e))
  runtimes.push(runtime)
  return { runtime, controls: owned, events }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-chat-stop-tree-'))
  process.env.POISE_DB = join(root, 'cache.db')
  process.env.POISE_LOCK_DIR = join(root, 'locks')
  repo = join(root, 'repo')
  await mkdir(repo)
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 't@example.invalid'])
  git(['config', 'user.name', 't'])
  await writeFile(join(repo, 'README.md'), '# repo\n')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'init'])
  vi.resetModules()
  runtimeModule = await import('../../server/chat/runtime')
  storage = await import('../../server/chat/storage')
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
  for (const runtime of runtimes.splice(0)) await runtime.stop({ handover: false }).catch(() => undefined)
  spawnSync('git', ['checkout', '-q', '--', '.'], { cwd: repo })
  spawnSync('git', ['clean', '-fdq'], { cwd: repo })
  spawnSync('git', ['switch', '-q', 'main'], { cwd: repo })
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

describe('Stop ends the turn and its process tree', () => {
  it('kills an unacknowledged turn with a background child and runs the next prompt at once', async () => {
    const { runtime, controls, events } = makeRuntime('poise-stop-tree:db', {
      hosts: [], adapters: [], auto: false, ignoreCancel: true,
      // A backgrounded sleep stands in for the vitest/sleep children in #545.
      startWorker: { command: 'sh', args: ['-c', 'sleep 30 & wait'] },
    })
    const session = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'main' } })
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    runtime.prompt(session.id, { text: 'stuck turn', attachments: [], mentions: [] })
    await waitFor(() => runtime.get(session.id)?.status === 'running')
    const recorded = storage.getWorker(session.id)
    expect(recorded).not.toBeNull()
    expect(worker.pgidAlive(recorded!.gatePgid)).toBe(true)

    const stopped = await runtime.cancel(session.id)
    expect(stopped.settled).toBe(true)
    expect(ofType(events, session.id, 'turn.finished').at(-1)).toMatchObject({ stopReason: 'cancelled' })
    // No descendant survives: the group is verifiably dead.
    expect(worker.pgidAlive(recorded!.gatePgid)).toBe(false)
    await waitFor(() => lastStatus(events, session.id) === 'idle')

    // The next prompt starts right away on a fresh worker, never behind the stopped turn.
    controls.auto = true
    controls.ignoreCancel = false
    const before = ofType(events, session.id, 'turn.finished').length
    runtime.prompt(session.id, { text: 'next one', attachments: [], mentions: [] })
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === before + 1)
    expect(ofType(events, session.id, 'turn.finished').at(-1)).toMatchObject({ stopReason: 'end_turn' })
    await runtime.stop({ handover: false })
  }, 40_000)

  it('kills the worker group even when the agent acknowledges the stop', async () => {
    const { runtime, controls, events } = makeRuntime('poise-stop-tree-ack:db', {
      hosts: [], adapters: [], auto: false,
      startWorker: { command: 'sh', args: ['-c', 'sleep 30 & wait'] },
    })
    const session = await runtime.create({ agent: 'grok', model: 'grok-4.6-xhigh', repo: 'acme/repo', branch: { existing: 'main' } })
    await waitFor(() => lastStatus(events, session.id) === 'idle')
    runtime.prompt(session.id, { text: 'acknowledged turn', attachments: [], mentions: [] })
    await waitFor(() => runtime.get(session.id)?.status === 'running')
    const recorded = storage.getWorker(session.id)
    expect(recorded).not.toBeNull()
    expect(worker.pgidAlive(recorded!.gatePgid)).toBe(true)

    const stopped = await runtime.cancel(session.id)
    expect(stopped.settled).toBe(true)
    // The agent said cancelled, but its shells go with the turn all the same.
    expect(worker.pgidAlive(recorded!.gatePgid)).toBe(false)
    await waitFor(() => lastStatus(events, session.id) === 'idle')

    controls.auto = true
    const before = ofType(events, session.id, 'turn.finished').length
    runtime.prompt(session.id, { text: 'next one', attachments: [], mentions: [] })
    await waitFor(() => ofType(events, session.id, 'turn.finished').length === before + 1)
    expect(ofType(events, session.id, 'turn.finished').at(-1)).toMatchObject({ stopReason: 'end_turn' })
    await runtime.stop({ handover: false })
  }, 40_000)
})
