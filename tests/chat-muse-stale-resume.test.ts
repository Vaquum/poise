import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { CATALOG } from './model-catalog-fixture'
import type { Adapter, AdapterHost, AdapterStartOptions } from '../server/chat/adapters/types'
import type { ChatRuntime as RuntimeType } from '../server/chat/runtime'
import type { Capabilities, ChatEnvelope, PromptInput } from '../server/chat/protocol'

let root = ''
let checkout = ''
let Runtime: typeof RuntimeType
let runtime: RuntimeType

const capabilities: Capabilities = { steer: true, fork: true, thought: true, plan: false, commands: false, modes: false, permissions: true, questions: true, resume: true, images: false }
const MUSE_MODEL = 'muse-spark-1.3-contributor-max'
const STALE_ERROR = 'Muse: API error 400 [request_id=3b0c8d5a-ecdd-4528-9cf8-cd70d56f570d]: reasoning `encrypted_content` was not issued to this caller (invalid_request_error)'

interface Controls {
  adapters: FakeMuse[]
  hosts: AdapterHost[]
  starts: AdapterStartOptions[]
  failResumeWith?: string
  failPromptTimes: number
  failPromptError: string
  failPromptWithTool: boolean
}
let controls: Controls

class FakeMuse implements Adapter {
  agent = 'muse' as const
  nativeSessionId: string | undefined
  capabilities = capabilities
  alive = false
  inputs: PromptInput[] = []
  closed = 0
  constructor(readonly host: AdapterHost, readonly controls: Controls) {}
  async start(options: AdapterStartOptions) {
    this.controls.starts.push(options)
    if (options.resume && this.controls.failResumeWith) throw new Error(this.controls.failResumeWith)
    this.alive = true
    this.nativeSessionId = options.resume || `native-${randomUUID().slice(0, 8)}`
    return { nativeSessionId: this.nativeSessionId, capabilities, modelId: options.modelId, effort: options.effort }
  }
  async prompt(turnId: string, input: PromptInput) {
    this.inputs.push(input)
    if (this.controls.failPromptTimes > 0) {
      this.controls.failPromptTimes -= 1
      if (this.controls.failPromptWithTool) this.host.emit({ type: 'tool.started', turnId, id: `${turnId}:tool1`, kind: 'execute', title: 'rm -rf /tmp/probe' })
      return { stopReason: 'error' as const, error: this.controls.failPromptError }
    }
    this.host.emit({ type: 'text.delta', turnId, messageId: `${turnId}:m1`, delta: `echo: ${input.text.slice(0, 200)}` })
    return { stopReason: 'end_turn' as const }
  }
  async steer() {}
  async cancel() {}
  async setModel(modelId: string, effort: string) { return { modelId, effort } }
  async setMode() { throw new Error('unsupported') }
  async setSafeMode() { return 'current_turn' as const }
  async fork() { return `native-${randomUUID().slice(0, 8)}` }
  async close() { this.closed += 1; this.alive = false }
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void) { this.exitListeners.push(listener) }
  emitExit(code: number | null, signal: NodeJS.Signals | null) { for (const listener of this.exitListeners) listener(code, signal) }
  private exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
}

function git(...args: string[]) {
  return execFileSync('git', args, { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean) {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) { if (check()) return; await pause(20) }
  throw new Error('fixture state deadline')
}
const ofType = (events: ChatEnvelope[], id: string, type: string) => events.filter((e) => e.sessionId === id && e.event.type === type).map((e) => e.event as never as Record<string, never>)
const restartNotes = (events: ChatEnvelope[], id: string) => ofType(events, id, 'error').filter((event) => String(event.message).includes('restarted') && String(event.message).includes("credentials changed"))

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-muse-stale-'))
  vi.stubEnv('POISE_DB', join(root, 'chat.sqlite3'))
  vi.stubEnv('POISE_LOCK_DIR', join(root, 'locks'))
  ;({ ChatRuntime: Runtime } = await import('../server/chat/runtime'))
})
beforeEach(async () => {
  checkout = join(root, randomUUID())
  await mkdir(checkout)
  git('init', '--quiet', '-b', 'main')
  git('config', 'user.name', 'Poise test')
  git('config', 'user.email', 'poise-test@example.invalid')
  git('config', 'commit.gpgSign', 'false')
  git('config', 'core.hooksPath', '/dev/null')
  git('commit', '--quiet', '--allow-empty', '-m', 'fixture')
  git('branch', 'topic')
  controls = { adapters: [], hosts: [], starts: [], failPromptTimes: 0, failPromptError: '', failPromptWithTool: false }
  runtime = new Runtime({
    instance: `muse-stale:${randomUUID()}`,
    instanceLabel: 'test',
    adapters: { muse: (host: AdapterHost) => { const adapter = new FakeMuse(host, controls); controls.adapters.push(adapter); controls.hosts.push(host); return adapter } },
    callerTurns: null,
    catalog: async () => CATALOG,
    resolveCheckout: async () => checkout,
    idleTimeoutMinutes: () => 0,
  })
})
afterEach(async () => { await runtime?.stop(); await pause(30) })
afterAll(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

async function createMuse(branch: { existing: string } | { new: string } = { existing: 'topic' }) {
  const record = await runtime.create({ agent: 'muse', model: MUSE_MODEL, repo: 'fixture/repo', branch })
  await until(() => runtime.get(record.id)?.status === 'idle')
  return record.id
}

async function firstTurn(events: ChatEnvelope[], id: string, text = 'first task about alpha') {
  await runtime.prompt(id, { text, attachments: [], mentions: [] })
  await until(() => ofType(events, id, 'turn.finished').length === 1)
  await until(() => runtime.get(id)?.status === 'idle')
}

it('restarts a Muse chat on a fresh native session when resume fails with the stale-caller 400', async () => {
  const events: ChatEnvelope[] = []
  runtime.on('event', (event) => events.push(event))
  const id = await createMuse()
  const before = runtime.get(id)!
  const nativeBefore = before.nativeSessionId!
  const checkoutBefore = before.checkout
  const branchBefore = before.branch.name

  await firstTurn(events, id)

  controls.failResumeWith = STALE_ERROR
  controls.adapters[0].alive = false
  await runtime.prompt(id, { text: 'second task about beta', attachments: [], mentions: [] })
  await until(() => ofType(events, id, 'turn.finished').length === 2)
  await until(() => runtime.get(id)?.status === 'idle')

  const finished = ofType(events, id, 'turn.finished').at(-1) as unknown as { stopReason: string }
  expect(finished.stopReason).toBe('end_turn')

  // Resume was tried once, then a fresh session was started in the same workspace.
  expect(controls.starts).toHaveLength(3)
  expect(controls.starts[1]).toMatchObject({ resume: nativeBefore })
  expect(controls.starts[2]).not.toHaveProperty('resume')
  const after = runtime.get(id)!
  expect(after.id).toBe(id)
  expect(after.checkout).toBe(checkoutBefore)
  expect(after.branch.name).toBe(branchBefore)
  expect(after.nativeSessionId).toBeTruthy()
  expect(after.nativeSessionId).not.toBe(nativeBefore)
  expect(controls.hosts.map((host) => host.checkout)).toEqual([checkoutBefore, checkoutBefore, checkoutBefore])

  // The compacted summary seeds the new session's first input.
  const freshInput = controls.adapters[2].inputs[0].text
  expect(freshInput).toContain('[Restarted Muse session')
  expect(freshInput).toContain('first task about alpha')
  expect(freshInput).toContain('second task about beta')
  expect(freshInput).toContain('Continue from here.')

  // The transcript shows the restart line once, and keeps its history.
  const notes = restartNotes(events, id)
  expect(notes).toHaveLength(1)
  expect(String(notes[0].message)).toContain('Muse')
  expect(ofType(events, id, 'text.delta').length).toBeGreaterThanOrEqual(2)
}, 60_000)

it('recovers inside the turn when the resumed session fails with the stale-caller 400', async () => {
  const events: ChatEnvelope[] = []
  runtime.on('event', (event) => events.push(event))
  const id = await createMuse({ new: 'stale-work' })
  const before = runtime.get(id)!
  const nativeBefore = before.nativeSessionId!
  expect(before.branch).toMatchObject({ name: 'chat/stale-work', origin: 'new' })
  expect(before.branch.baseSha).toBeTruthy()

  await firstTurn(events, id)

  controls.failPromptTimes = 1
  controls.failPromptError = STALE_ERROR
  controls.adapters[0].alive = false
  await runtime.prompt(id, { text: 'second task about beta', attachments: [], mentions: [] })
  await until(() => ofType(events, id, 'turn.finished').length === 2)
  await until(() => runtime.get(id)?.status === 'idle')

  // One turn: the retry reuses the turn id, so no second turn.started.
  expect(ofType(events, id, 'turn.started')).toHaveLength(2)
  const finished = ofType(events, id, 'turn.finished').at(-1) as unknown as { stopReason: string }
  expect(finished.stopReason).toBe('end_turn')

  // Resume succeeded; the failure came from the turn, then a fresh session ran the retry.
  expect(controls.starts).toHaveLength(3)
  expect(controls.starts[1]).toMatchObject({ resume: nativeBefore })
  expect(controls.starts[2]).not.toHaveProperty('resume')
  const after = runtime.get(id)!
  expect(after.checkout).toBe(before.checkout)
  expect(after.branch).toMatchObject({ name: 'chat/stale-work', origin: 'new', baseSha: before.branch.baseSha })
  expect(after.nativeSessionId).toBeTruthy()
  expect(after.nativeSessionId).not.toBe(nativeBefore)
  expect(after.queuedHandoff).toBeUndefined()

  const freshInput = controls.adapters[2].inputs[0].text
  expect(freshInput).toContain('[Restarted Muse session')
  expect(freshInput).toContain('[Current task]')
  expect(freshInput).toContain('first task about alpha')
  expect(freshInput).toContain('second task about beta')
  expect(restartNotes(events, id)).toHaveLength(1)
}, 60_000)

it('recovers when a live Muse process hits the stale-caller 400 with no resume at all', async () => {
  const events: ChatEnvelope[] = []
  runtime.on('event', (event) => events.push(event))
  const id = await createMuse()
  const nativeBefore = runtime.get(id)!.nativeSessionId!

  await firstTurn(events, id)

  controls.failPromptTimes = 1
  controls.failPromptError = STALE_ERROR
  await runtime.prompt(id, { text: 'second task', attachments: [], mentions: [] })
  await until(() => ofType(events, id, 'turn.finished').length === 2)
  await until(() => runtime.get(id)?.status === 'idle')

  const finished = ofType(events, id, 'turn.finished').at(-1) as unknown as { stopReason: string }
  expect(finished.stopReason).toBe('end_turn')
  expect(controls.starts).toHaveLength(2)
  expect(controls.starts[1]).not.toHaveProperty('resume')
  expect(runtime.get(id)!.nativeSessionId).not.toBe(nativeBefore)
  expect(restartNotes(events, id)).toHaveLength(1)
}, 60_000)

it('does not re-run the prompt when the failed attempt had already run tools', async () => {
  const events: ChatEnvelope[] = []
  runtime.on('event', (event) => events.push(event))
  const id = await createMuse()
  await firstTurn(events, id)

  controls.failPromptTimes = 1
  controls.failPromptError = STALE_ERROR
  controls.failPromptWithTool = true
  controls.adapters[0].alive = false
  await runtime.prompt(id, { text: 'second task', attachments: [], mentions: [] })
  await until(() => ofType(events, id, 'turn.finished').length === 2)

  const finished = ofType(events, id, 'turn.finished').at(-1) as unknown as { stopReason: string, error?: string }
  expect(finished.stopReason).toBe('error')
  expect(finished.error).toContain('not re-run')
  // The session still restarted fresh for the next prompt, which keeps the summary.
  expect(controls.starts).toHaveLength(3)
  expect(controls.adapters[2].inputs).toHaveLength(0)
  expect(runtime.get(id)!.queuedHandoff).toContain('[Restarted Muse session')
  expect(restartNotes(events, id)).toHaveLength(1)
}, 60_000)

it('surfaces a second consecutive stale-caller failure instead of restarting again', async () => {
  const events: ChatEnvelope[] = []
  runtime.on('event', (event) => events.push(event))
  const id = await createMuse()
  await firstTurn(events, id)

  controls.failPromptTimes = 2
  controls.failPromptError = STALE_ERROR
  controls.adapters[0].alive = false
  await runtime.prompt(id, { text: 'second task', attachments: [], mentions: [] })
  await until(() => ofType(events, id, 'turn.finished').length === 2)

  const finished = ofType(events, id, 'turn.finished').at(-1) as unknown as { stopReason: string, error?: string }
  expect(finished.stopReason).toBe('error')
  expect(finished.error).toContain('encrypted_content')
  expect(controls.starts).toHaveLength(3)
  expect(restartNotes(events, id)).toHaveLength(1)
}, 60_000)

it('leaves any other Muse resume error to behave as before', async () => {
  const events: ChatEnvelope[] = []
  runtime.on('event', (event) => events.push(event))
  const id = await createMuse()
  await firstTurn(events, id, 'first task')

  controls.failResumeWith = 'Muse failed to start: session store unavailable'
  controls.adapters[0].alive = false
  await runtime.prompt(id, { text: 'second task', attachments: [], mentions: [] })
  await until(() => ofType(events, id, 'turn.finished').length === 2)

  const finished = ofType(events, id, 'turn.finished').at(-1) as unknown as { stopReason: string, error?: string }
  expect(finished.stopReason).toBe('error')
  expect(finished.error).toContain('session store unavailable')
  expect(controls.starts).toHaveLength(2)
  expect(restartNotes(events, id)).toHaveLength(0)
}, 60_000)

it('ignores a late exit from the stopped poisoned process after a resume recovery', async () => {
  const events: ChatEnvelope[] = []
  runtime.on('event', (event) => events.push(event))
  const id = await createMuse()
  await firstTurn(events, id, 'first task')

  controls.failResumeWith = STALE_ERROR
  controls.adapters[0].alive = false
  await runtime.prompt(id, { text: 'second task', attachments: [], mentions: [] })
  await until(() => ofType(events, id, 'turn.finished').length === 2)
  await until(() => runtime.get(id)?.status === 'idle')

  // The failed resume attempt's process exits late, after the fresh adapter
  // took over: it must not be reported as the fresh adapter's exit.
  controls.adapters[1].emitExit(1, null)
  await pause(50)
  expect(runtime.get(id)?.status).toBe('idle')
  expect(ofType(events, id, 'status.changed').at(-1)).toMatchObject({ status: 'idle' })
}, 60_000)

it('leaves any other Muse turn error to behave as before', async () => {
  const events: ChatEnvelope[] = []
  runtime.on('event', (event) => events.push(event))
  const id = await createMuse()
  const nativeBefore = runtime.get(id)!.nativeSessionId!
  await firstTurn(events, id, 'first task')

  controls.failPromptTimes = 1
  controls.failPromptError = 'Muse: provider returned 503'
  controls.adapters[0].alive = false
  await runtime.prompt(id, { text: 'second task', attachments: [], mentions: [] })
  await until(() => ofType(events, id, 'turn.finished').length === 2)

  const finished = ofType(events, id, 'turn.finished').at(-1) as unknown as { stopReason: string, error?: string }
  expect(finished.stopReason).toBe('error')
  expect(finished.error).toContain('503')
  expect(controls.starts).toHaveLength(2)
  expect(runtime.get(id)!.nativeSessionId).toBe(nativeBefore)
  expect(restartNotes(events, id)).toHaveLength(0)
}, 60_000)
