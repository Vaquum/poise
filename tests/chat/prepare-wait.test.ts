// Queued preparation waits (#632): every pre-prompt step names itself live
// and in the stored record, a blocked step fails named within its budget,
// and Stop reaches the awaited work without a late prompt starting.

import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CATALOG } from '../model-catalog-fixture'
import type { Adapter, TurnResult } from '../../server/chat/adapters/types'
import type { PromptInput } from '../../server/chat/protocol'
import type { ChatRuntime } from '../../server/chat/runtime'

const stubs = vi.hoisted(() => ({
  hangCommands: new Set<string>(),
  hangGitFirstArgs: new Set<string>(),
  githubCalls: 0,
  hangSnapshot: false,
  stuckCheckout: false,
  parked: [] as Array<() => void>,
}))

const abortLike = (reason?: unknown) =>
  Object.assign(new Error('The operation was aborted', { cause: reason }), { name: 'AbortError', code: 'ABORT_ERR' })

vi.mock('../../server/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/process')>()
  return {
    ...actual,
    runFile: (command: string, args: readonly string[], options?: import('../../server/process').RunFileOptions) => {
      if (command === 'github-interface') stubs.githubCalls += 1
      const parked = stubs.hangCommands.has(command) || (command === 'git' && stubs.hangGitFirstArgs.has(args[0] ?? ''))
      if (!parked) return actual.runFile(command, args, options)
      if (options?.signal?.aborted) return Promise.reject(abortLike(options.signal.reason))
      return new Promise<import('../../server/process').RunFileResult>((resolve, reject) => {
        let settled = false
        const gate = () => {
          if (settled) return
          settled = true
          actual.runFile(command, args, options).then(resolve, reject)
        }
        stubs.parked.push(gate)
        options?.signal?.addEventListener('abort', () => {
          if (settled) return
          settled = true
          const at = stubs.parked.indexOf(gate)
          if (at >= 0) stubs.parked.splice(at, 1)
          reject(abortLike(options.signal?.reason))
        }, { once: true })
      })
    },
  }
})

/** Let every parked subprocess call through to the real runner, and stop
 *  parking new ones. A turn parked mid-preparation advances; a turn whose
 *  cleanup parked finishes, so the runtime can stop. */
function unhang(): void {
  stubs.hangCommands.clear()
  stubs.hangGitFirstArgs.clear()
  for (const gate of stubs.parked.splice(0)) gate()
}

vi.mock('../../server/chat/change-mirror', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/chat/change-mirror')>()
  return {
    ...actual,
    captureCheckoutSnapshot: (
      checkout: string,
      extraPaths?: string[],
      overrides?: Partial<import('../../server/chat/change-mirror').MirrorLimits>,
      budget?: import('../../server/chat/change-mirror').SnapshotBudget,
    ) => {
      if (!stubs.hangSnapshot) return actual.captureCheckoutSnapshot(checkout, extraPaths, overrides, budget)
      if (budget?.signal.aborted || budget?.turnSignal.aborted) return Promise.reject(abortLike())
      return new Promise<import('../../server/chat/change-mirror').CheckoutSnapshot>((_resolve, reject) => {
        budget?.signal.addEventListener('abort', () => reject(abortLike()), { once: true })
        budget?.turnSignal.addEventListener('abort', () => reject(abortLike()), { once: true })
      })
    },
  }
})

vi.mock('../../server/chat/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/chat/git')>()
  return {
    ...actual,
    inspectCheckout: async (checkout: string, options?: { signal?: AbortSignal }) => {
      if (!stubs.stuckCheckout) return actual.inspectCheckout(checkout, options)
      throw new actual.GuardedWorkerStuckError('git')
    },
  }
})

const editorStubs = vi.hoisted(() => ({
  gate: null as null | { created: () => void, proceed: Promise<void> },
}))

vi.mock('../../server/chat/editor-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/chat/editor-context')>()
  return {
    ...actual,
    prepareEditorContext: async (...args: Parameters<typeof actual.prepareEditorContext>) => {
      const out = await actual.prepareEditorContext(...args)
      const gate = editorStubs.gate
      if (gate) {
        gate.created()
        await gate.proceed
      }
      return out
    },
  }
})

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

let root = ''
let outer = ''
let Runtime: typeof ChatRuntime
let storage: typeof import('../../server/chat/storage')
let CheckoutLease: typeof import('../../server/chat/checkout-lock').CheckoutLease
const runtimes: ChatRuntime[] = []
const resolveCheckout = vi.fn(async () => { throw new Error('must not look up a repository') })

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: outer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } })
}

async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('prepare-wait deadline')
    await new Promise((r) => setTimeout(r, 25))
  }
}

interface Controls {
  adapter: Adapter
  prompts: Array<{ turnId: string, text: string }>
  safeModeCalls: boolean[]
  setPromptImpl: (fn: (turnId: string, input: PromptInput) => Promise<TurnResult>) => void
  setSafeModeImpl: (fn: (enabled: boolean) => Promise<'current_turn' | 'next_turn'>) => void
  pendingPrompts: Map<string, (result: TurnResult) => void>
}

function controllableAdapter(): Controls {
  const prompts: Controls['prompts'] = []
  const safeModeCalls: boolean[] = []
  const pendingPrompts = new Map<string, (result: TurnResult) => void>()
  let promptImpl: (turnId: string, input: PromptInput) => Promise<TurnResult> = async () => ({ stopReason: 'end_turn' })
  let safeModeImpl: (enabled: boolean) => Promise<'current_turn' | 'next_turn'> = async () => 'current_turn'
  let alive = false
  const capabilities = { steer: true, fork: true, thought: false, plan: false, commands: false, modes: false, permissions: true, questions: true, resume: true, images: false }
  const adapter: Adapter = {
    agent: 'grok',
    nativeSessionId: randomUUID(),
    capabilities,
    get alive() { return alive },
    async start(options) { alive = true; return { nativeSessionId: randomUUID(), capabilities, modelId: options.modelId, effort: options.effort } },
    async prompt(turnId, input) { prompts.push({ turnId, text: input.text }); return promptImpl(turnId, input) },
    async cancel() { for (const release of pendingPrompts.values()) release({ stopReason: 'cancelled' }); pendingPrompts.clear() },
    async close() { alive = false },
    async steer() {},
    async setMode() {},
    async setModel(modelId, effort) { return { modelId, effort } },
    async setSafeMode(enabled) { safeModeCalls.push(enabled); return safeModeImpl(enabled) },
    async fork() { return randomUUID() },
    onExit() {},
  }
  return { adapter, prompts, safeModeCalls, pendingPrompts,
    setPromptImpl: (fn) => { promptImpl = fn }, setSafeModeImpl: (fn) => { safeModeImpl = fn } }
}

function makeRuntime(controls: Controls, options: { budgets?: { totalMs?: number, snapshotMs?: number }, maxTurns?: number } = {}): ChatRuntime {
  const runtime = new Runtime({ instance: randomUUID(), instanceLabel: 'test', callerTurns: null,
    catalog: async () => CATALOG, resolveCheckout, localWorkspaceRoot: join(outer, '.poise-chat'),
    idleTimeoutMinutes: () => 0, adapters: { grok: () => controls.adapter }, probeAgent: async () => ({ ok: true }),
    ...(options.budgets ? { prepareBudgets: options.budgets } : {}),
    ...(options.maxTurns ? { maxConcurrentLocalTurns: () => options.maxTurns as number } : {}) })
  runtimes.push(runtime)
  return runtime
}

const promptInput = (text: string): PromptInput => ({ text, attachments: [], mentions: [] })
const eventsOf = (runtime: ChatRuntime, id: string) => runtime.events(id, 0).events.map((entry) => entry.event) as any[]
const reasons = (runtime: ChatRuntime, id: string): Array<string | undefined> =>
  eventsOf(runtime, id).filter((event) => event.type === 'status.changed').map((event) => event.queuedBehind)
const finished = (runtime: ChatRuntime, id: string) => eventsOf(runtime, id).filter((event) => event.type === 'turn.finished')
const errorTexts = (runtime: ChatRuntime, id: string): string[] =>
  eventsOf(runtime, id).filter((event) => event.type === 'error').map((event) => event.message)

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'poise-prepare-wait-'))
  vi.stubEnv('POISE_DB', join(root, 'chat.db'))
  vi.stubEnv('POISE_EDITOR_DIR', join(root, 'editor'))
  vi.stubEnv('POISE_LOCK_DIR', join(root, 'locks'))
  ;({ ChatRuntime: Runtime } = await import('../../server/chat/runtime'))
  storage = await import('../../server/chat/storage')
  ;({ CheckoutLease } = await import('../../server/chat/checkout-lock'))
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

beforeEach(async () => {
  stubs.hangCommands.clear()
  stubs.hangGitFirstArgs.clear()
  stubs.githubCalls = 0
  stubs.hangSnapshot = false
  stubs.stuckCheckout = false
  outer = join(root, randomUUID())
  await mkdir(outer)
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.hooksPath', '/dev/null')
  await writeFile(join(outer, 'source.ts'), 'original\n')
  git('add', 'source.ts')
  git('commit', '-qm', 'fixture')
  resolveCheckout.mockClear()
})

afterEach(async () => {
  unhang()
  stubs.hangSnapshot = false
  stubs.stuckCheckout = false
  for (const runtime of runtimes.splice(0)) await runtime.stop().catch(() => undefined)
})

async function idleSession(runtime: ChatRuntime, title: string) {
  const record = await runtime.create({ agent: 'grok', model: 'grok-4.6-high', title })
  await until(() => runtime.get(record.id)?.status === 'idle')
  return record
}

describe('queued preparation waits', () => {
  it('names each preparation step of a turn in order', async () => {
    const controls = controllableAdapter()
    const runtime = makeRuntime(controls)
    const record = await idleSession(runtime, 'steps')
    runtime.prompt(record.id, promptInput('hello there'))
    await until(() => finished(runtime, record.id).length === 1)
    await until(() => runtime.get(record.id)?.status === 'idle')
    expect(reasons(runtime, record.id).filter(Boolean)).toEqual([
      'preparing the checkout',
      'preparing the turn input',
      'capturing the checkout snapshot',
      'applying pending settings',
      'taking the job baseline',
    ])
    expect(runtime.get(record.id)?.queuedBehind).toBeUndefined()
  })

  it('shows a blocked checkout step live and in the stored record, then fails it named within budget', async () => {
    const controls = controllableAdapter()
    const runtime = makeRuntime(controls, { budgets: { totalMs: 500 } })
    const record = await idleSession(runtime, 'blocked checkout')
    stubs.hangCommands.add('git')
    runtime.prompt(record.id, promptInput('work please'))
    await until(() => runtime.get(record.id)?.queuedBehind === 'preparing the checkout')
    // A reconnect reads the stored record, not the live one.
    expect(storage.getSession(record.id)?.queuedBehind).toBe('preparing the checkout')
    expect(reasons(runtime, record.id)).toContain('preparing the checkout')
    await until(() => finished(runtime, record.id).length === 1)
    expect(finished(runtime, record.id)[0]).toMatchObject({ stopReason: 'error' })
    expect(finished(runtime, record.id)[0].error).toContain("preparation timed out during 'preparing the checkout'")
    expect(controls.prompts).toHaveLength(0)
    unhang()
    await until(() => runtime.get(record.id)?.status === 'idle')
    expect(runtime.checkSlots.stats()).toMatchObject({ running: 0 })
    expect(new CheckoutLease(record.checkout, { ownerKind: 'test', ownerId: 't', ownerLabel: 't', instance: 'test' }).read()).toBeNull()
  })

  it('cancels a blocked checkout step and never starts the prompt late', async () => {
    const controls = controllableAdapter()
    const runtime = makeRuntime(controls)
    const record = await idleSession(runtime, 'stopped checkout')
    stubs.hangCommands.add('git')
    runtime.prompt(record.id, promptInput('work please'))
    await until(() => runtime.get(record.id)?.queuedBehind === 'preparing the checkout')
    const { settled } = await runtime.cancel(record.id)
    expect(settled).toBe(true)
    await until(() => finished(runtime, record.id).length === 1)
    expect(finished(runtime, record.id)[0]).toMatchObject({ stopReason: 'cancelled' })
    expect(controls.prompts).toHaveLength(0)
    unhang()
    await until(() => runtime.get(record.id)?.status === 'idle')
    await new Promise((r) => setTimeout(r, 200))
    expect(controls.prompts).toHaveLength(0)
    expect(finished(runtime, record.id)).toHaveLength(1)
    expect(runtime.checkSlots.stats()).toMatchObject({ running: 0 })
  })

  it('fails a blocked restore naming the checkout step', async () => {
    const controls = controllableAdapter()
    const runtime = makeRuntime(controls, { budgets: { totalMs: 500 } })
    const record = await idleSession(runtime, 'blocked restore')
    await writeFile(join(record.checkout, 'package.json'), '{"name":"x"}\n')
    await writeFile(join(outer, '.poise-chat', 'workers', record.id, '.poise-maintenance.json'),
      JSON.stringify({ prunedAt: new Date().toISOString(), pruned: ['node_modules'] }))
    stubs.hangCommands.add('npm')
    runtime.prompt(record.id, promptInput('work please'))
    await until(() => runtime.get(record.id)?.queuedBehind === 'preparing the checkout')
    await until(() => finished(runtime, record.id).length === 1)
    expect(finished(runtime, record.id)[0]).toMatchObject({ stopReason: 'error' })
    expect(finished(runtime, record.id)[0].error).toContain("preparation timed out during 'preparing the checkout'")
    expect(controls.prompts).toHaveLength(0)
  })

  it('fails a blocked snapshot naming the snapshot step', async () => {
    const controls = controllableAdapter()
    const runtime = makeRuntime(controls, { budgets: { totalMs: 500 } })
    const record = await idleSession(runtime, 'blocked snapshot')
    stubs.hangSnapshot = true
    runtime.prompt(record.id, promptInput('work please'))
    await until(() => runtime.get(record.id)?.queuedBehind === 'capturing the checkout snapshot')
    expect(storage.getSession(record.id)?.queuedBehind).toBe('capturing the checkout snapshot')
    await until(() => finished(runtime, record.id).length === 1)
    expect(finished(runtime, record.id)[0]).toMatchObject({ stopReason: 'error' })
    expect(finished(runtime, record.id)[0].error).toContain("preparation timed out during 'capturing the checkout snapshot'")
    expect(controls.prompts).toHaveLength(0)
  })

  it('continues with a degraded snapshot past its own deadline', async () => {
    const controls = controllableAdapter()
    const runtime = makeRuntime(controls, { budgets: { snapshotMs: 0 } })
    const record = await idleSession(runtime, 'degraded snapshot')
    await writeFile(join(record.checkout, 'note.txt'), 'uncaptured work\n')
    runtime.prompt(record.id, promptInput('work please'))
    await until(() => finished(runtime, record.id).length === 1)
    expect(finished(runtime, record.id)[0]).toMatchObject({ stopReason: 'end_turn' })
    expect(controls.prompts).toHaveLength(1)
    expect(reasons(runtime, record.id)).toContain('capturing the checkout snapshot')
    expect(errorTexts(runtime, record.id).join('\n')).toContain('checkout snapshot time budget exceeded')
  })

  it('waits for pending settings by name, then proceeds when they land', async () => {
    const controls = controllableAdapter()
    const runtime = makeRuntime(controls)
    const record = await idleSession(runtime, 'slow settings')
    let releaseSafeMode!: (value: 'current_turn') => void
    controls.setSafeModeImpl(() => new Promise((resolve) => { releaseSafeMode = resolve }))
    // Park the turn in its queued window first: a chain hung before the
    // turn starts holds it before turn.started, outside the named window.
    stubs.hangCommands.add('git')
    runtime.prompt(record.id, promptInput('work please'))
    await until(() => runtime.get(record.id)?.queuedBehind === 'preparing the checkout')
    const ack = runtime.setSafeMode(record.id, true)
    await until(() => controls.safeModeCalls.length === 1)
    unhang()
    await until(() => runtime.get(record.id)?.queuedBehind === 'applying pending settings')
    expect(storage.getSession(record.id)?.queuedBehind).toBe('applying pending settings')
    expect(controls.prompts).toHaveLength(0)
    releaseSafeMode('current_turn')
    await ack
    await until(() => runtime.get(record.id)?.status === 'idle')
    expect(controls.prompts).toHaveLength(1)
    expect(finished(runtime, record.id)[0]).toMatchObject({ stopReason: 'end_turn' })
  })

  it('fails a never-settling settings wait within budget and ignores its late settlement', async () => {
    const controls = controllableAdapter()
    const runtime = makeRuntime(controls, { budgets: { totalMs: 3_000 } })
    const record = await idleSession(runtime, 'stuck settings')
    let releaseSafeMode!: (value: 'current_turn') => void
    controls.setSafeModeImpl(() => new Promise((resolve) => { releaseSafeMode = resolve }))
    stubs.hangCommands.add('git')
    runtime.prompt(record.id, promptInput('work please'))
    await until(() => runtime.get(record.id)?.queuedBehind === 'preparing the checkout')
    const ack = runtime.setSafeMode(record.id, true)
    await until(() => controls.safeModeCalls.length === 1)
    unhang()
    await until(() => runtime.get(record.id)?.queuedBehind === 'applying pending settings')
    await until(() => finished(runtime, record.id).length === 1)
    expect(finished(runtime, record.id)[0]).toMatchObject({ stopReason: 'error' })
    expect(finished(runtime, record.id)[0].error).toContain("preparation timed out during 'applying pending settings'")
    expect(controls.prompts).toHaveLength(0)
    releaseSafeMode('current_turn')
    await ack
    await until(() => runtime.get(record.id)?.status === 'idle')
    await new Promise((r) => setTimeout(r, 200))
    expect(controls.prompts).toHaveLength(0)
    expect(finished(runtime, record.id)).toHaveLength(1)
    // The next turn is not wedged behind the abandoned wait.
    runtime.prompt(record.id, promptInput('second try'))
    await until(() => finished(runtime, record.id).length === 2)
    expect(finished(runtime, record.id)[1]).toMatchObject({ stopReason: 'end_turn' })
  })

  it('aborts a settings restart inside its startup checkout work', async () => {
    const controls = controllableAdapter()
    const runtime = makeRuntime(controls, { budgets: { totalMs: 3_000 } })
    const record = await idleSession(runtime, 'restart settings')
    controls.setSafeModeImpl(async () => 'next_turn')
    // Park the turn in its queued window, then defer safe mode mid-turn so
    // the settings step restarts the native process for it. (Deferred
    // before the prompt, the pre-turn startup would absorb the restart.)
    stubs.hangGitFirstArgs.add('status')
    runtime.prompt(record.id, promptInput('work please'))
    await until(() => runtime.get(record.id)?.queuedBehind === 'preparing the checkout')
    await runtime.setSafeMode(record.id, true)
    expect(runtime.get(record.id)?.safeModePending).toBe(true)
    // The parked checkout read goes through for real; the synchronous
    // re-arm parks the restart's startup read while ls-files passes.
    unhang()
    stubs.hangGitFirstArgs.add('status')
    // The settings step restarts the native process; its startup parks on
    // the re-armed read. (The settings label itself shows only until the
    // restart flips to starting, so the event sequence pins it below.)
    await until(() => runtime.get(record.id)?.status === 'starting')
    await until(() => finished(runtime, record.id).length === 1)
    expect(finished(runtime, record.id)[0]).toMatchObject({ stopReason: 'error' })
    expect(finished(runtime, record.id)[0].error).toContain("preparation timed out during 'applying pending settings'")
    expect(reasons(runtime, record.id)).toContain('applying pending settings')
    expect(controls.prompts).toHaveLength(0)
    unhang()
    expect(runtime.checkSlots.stats()).toMatchObject({ running: 0 })
    expect(new CheckoutLease(record.checkout, { ownerKind: 'test', ownerId: 't', ownerLabel: 't', instance: 'test' }).read()).toBeNull()
  })

  it('replaces the slot wait label once admitted', async () => {
    const controls = controllableAdapter()
    controls.setPromptImpl((turnId) => new Promise<TurnResult>((resolve) => { controls.pendingPrompts.set(turnId, resolve) }))
    const runtime = makeRuntime(controls, { maxTurns: 1 })
    const a = await idleSession(runtime, 'holder')
    runtime.prompt(a.id, promptInput('hold this turn'))
    await until(() => runtime.get(a.id)?.status === 'running')
    const b = await idleSession(runtime, 'waiter')
    runtime.prompt(b.id, promptInput('work too'))
    await until(() => runtime.get(b.id)?.queuedBehind === 'waiting for a free agent slot')
    await runtime.cancel(a.id)
    await until(() => runtime.get(b.id)?.status === 'running')
    const seen = reasons(runtime, b.id)
    expect(seen.indexOf('waiting for a free agent slot')).toBeGreaterThanOrEqual(0)
    expect(seen.indexOf('preparing the checkout')).toBeGreaterThan(seen.indexOf('waiting for a free agent slot'))
    expect(seen.slice(seen.indexOf('preparing the checkout'))).not.toContain('waiting for a free agent slot')
    await runtime.cancel(b.id)
    await until(() => runtime.get(b.id)?.status === 'idle')
  })

  it('replaces the lease-holder label once acquired', async () => {
    const controls = controllableAdapter()
    const runtime = makeRuntime(controls)
    const record = await idleSession(runtime, 'lease waiter')
    const held = new CheckoutLease(record.checkout, { ownerKind: 'poise:chat', ownerId: 'maintenance', ownerLabel: 'Maintenance test', instance: 'test' })
    expect(held.tryAcquire().acquired).toBe(true)
    try {
      runtime.prompt(record.id, promptInput('work please'))
      await until(() => (runtime.get(record.id)?.queuedBehind ?? '').includes('Maintenance test'))
      held.release()
      await until(() => runtime.get(record.id)?.status === 'idle')
    } finally {
      held.release()
    }
    const seen = reasons(runtime, record.id).filter(Boolean) as string[]
    const holderAt = seen.findIndex((reason) => reason.includes('Maintenance test'))
    expect(holderAt).toBeGreaterThanOrEqual(0)
    expect(seen.indexOf('preparing the checkout')).toBeGreaterThan(holderAt)
    expect(finished(runtime, record.id)[0]).toMatchObject({ stopReason: 'end_turn' })
  })

  it('replaces the update wait label once the switch lands', async () => {
    const controls = controllableAdapter()
    const runtime = makeRuntime(controls)
    const record = await idleSession(runtime, 'switch waiter')
    runtime.setSwitchPending('r2')
    const receipt = await runtime.prompt(record.id, promptInput('after the update'))
    expect(receipt).toHaveProperty('waitId')
    expect(runtime.get(record.id)).toMatchObject({ status: 'queued', queuedBehind: 'waiting for the Poise update' })
    await runtime.releaseSwitchWait()
    await until(() => runtime.get(record.id)?.status === 'idle')
    const seen = reasons(runtime, record.id)
    expect(seen.indexOf('waiting for the Poise update')).toBeGreaterThanOrEqual(0)
    expect(seen.indexOf('preparing the checkout')).toBeGreaterThan(seen.indexOf('waiting for the Poise update'))
  })

  it('never lets a slow GitHub call reach a woken turn', async () => {
    const controls = controllableAdapter()
    const runtime = makeRuntime(controls)
    const record = await idleSession(runtime, 'no github')
    stubs.hangCommands.add('github-interface')
    // Event-driven, not wall-clock: the turn ends whenever the loaded
    // runner gets there. A turn that truly hangs still fails at testTimeout.
    const turnDone = new Promise<void>((resolve) => {
      const onEvent = (): void => {
        if (finished(runtime, record.id).length > 0) {
          runtime.off('event', onEvent)
          resolve()
        }
      }
      runtime.on('event', onEvent)
    })
    runtime.prompt(record.id, promptInput('work please'))
    await turnDone
    expect(stubs.githubCalls).toBe(0)
    expect(finished(runtime, record.id)).toHaveLength(1)
    expect(finished(runtime, record.id)[0]).toMatchObject({ stopReason: 'end_turn' })
  })

  it('lets a started native turn outlive the preparation budget', async () => {
    const controls = controllableAdapter()
    controls.setPromptImpl((turnId) => new Promise<TurnResult>((resolve) => { controls.pendingPrompts.set(turnId, resolve) }))
    const runtime = makeRuntime(controls, { budgets: { totalMs: 300 } })
    const record = await idleSession(runtime, 'slow native')
    runtime.prompt(record.id, promptInput('take your time'))
    await until(() => runtime.get(record.id)?.status === 'running')
    expect(runtime.get(record.id)?.queuedBehind).toBeUndefined()
    await new Promise((r) => setTimeout(r, 600))
    expect(runtime.get(record.id)?.status).toBe('running')
    for (const release of controls.pendingPrompts.values()) release({ stopReason: 'end_turn' })
    controls.pendingPrompts.clear()
    await until(() => runtime.get(record.id)?.status === 'idle')
    expect(finished(runtime, record.id)[0]).toMatchObject({ stopReason: 'end_turn' })
  })

  it('retains the checkout when a preparation worker cannot be verified dead', async () => {
    const controls = controllableAdapter()
    const runtime = makeRuntime(controls)
    const record = await idleSession(runtime, 'stuck worker')
    stubs.stuckCheckout = true
    runtime.prompt(record.id, promptInput('work please'))
    await until(() => finished(runtime, record.id).length === 1)
    expect(finished(runtime, record.id)[0]).toMatchObject({ stopReason: 'error' })
    expect(finished(runtime, record.id)[0].error).toContain("preparation step 'preparing the checkout' could not settle")
    expect(controls.prompts).toHaveLength(0)
    await until(() => runtime.get(record.id)?.status === 'error')
    expect(new CheckoutLease(record.checkout, { ownerKind: 'test', ownerId: 't', ownerLabel: 't', instance: 'test' }).read()).not.toBeNull()
  })

  it('removes the editor context file when the turn aborts after it lands', async () => {
    const controls = controllableAdapter()
    const runtime = makeRuntime(controls)
    const record = await runtime.create({ agent: 'grok', model: 'grok-4.6-high', title: 'editor abort',
      subject: { surface: 'editor-document', key: 'draft', label: 'draft' } })
    await until(() => runtime.get(record.id)?.status === 'idle')
    const contextDir = join(record.checkout, '.poise-chat', 'context', record.id)
    const listed = (): Promise<string[]> => readdir(contextDir).catch(() => [])
    expect(await listed()).toHaveLength(0)
    let created!: () => void
    const wasCreated = new Promise<void>((resolve) => { created = resolve })
    let release: () => void = () => undefined
    const proceed = new Promise<void>((resolve) => { release = resolve })
    editorStubs.gate = { created, proceed }
    try {
      runtime.prompt(record.id, promptInput('edit please'))
      await wasCreated
      // preparing() awaits the input callback, so the gate must release for
      // the abort below to settle the turn; cancel() delivers the abort
      // synchronously and then waits for the end.
      const cancelling = runtime.cancel(record.id)
      release()
      const { settled } = await cancelling
      expect(settled).toBe(true)
      await until(() => finished(runtime, record.id).length === 1)
      expect(finished(runtime, record.id)[0]).toMatchObject({ stopReason: 'cancelled' })
      expect(await listed()).toHaveLength(0)
    } finally {
      release()
      editorStubs.gate = null
    }
  })
})
