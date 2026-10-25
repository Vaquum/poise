import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { withProcessLock } from '../server/process-lock'

const hooks = vi.hoisted(() => ({ pause: null as (() => Promise<void>) | null }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, chmod: async (...args: Parameters<typeof fs.chmod>) => {
    await fs.chmod(...args)
    await hooks.pause?.()
  } }
})

afterEach(() => { hooks.pause = null; vi.useRealTimers() })

it.each(['cancellation', 'deadline'] as const)('does not admit a callback when %s overtakes asynchronous acquisition', async (cause) => {
  if (cause === 'deadline') vi.useFakeTimers({ toFake: ['Date'] })
  const root = await mkdtemp(join(tmpdir(), 'poise-lock-cancel-'))
  const path = join(root, 'lock.sqlite3')
  const controller = new AbortController()
  let resume!: () => void
  const paused = new Promise<void>((resolve) => { resume = resolve })
  let entered!: () => void
  const acquiring = new Promise<void>((resolve) => { entered = resolve })
  hooks.pause = async () => { entered(); await paused }
  const operation = vi.fn(async () => 'must not mutate')
  const attempt = withProcessLock({ path, signal: controller.signal }, operation)
  const result = expect(attempt).rejects.toThrow(cause === 'cancellation' ? 'cancelled during acquisition' : 'timed out waiting for process lock')
  try {
    await acquiring
    if (cause === 'cancellation') controller.abort(new Error('cancelled during acquisition'))
    else vi.setSystemTime(Date.now() + 20_000)
    resume()
    await result
    expect(operation).not.toHaveBeenCalled()
    hooks.pause = null
    await expect(withProcessLock({ path }, async () => 'next owner')).resolves.toBe('next owner')
  } finally {
    resume()
    await attempt.catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects an expired waiter even when ownership transfers before its delayed timer runs', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const root = await mkdtemp(join(tmpdir(), 'poise-lock-deadline-'))
  const path = join(root, 'lock.sqlite3')
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let entered!: () => void
  const holding = new Promise<void>((resolve) => { entered = resolve })
  const owner = withProcessLock({ path }, async () => { entered(); await gate })
  let waiter: Promise<string> | undefined
  try {
    await holding
    const operation = vi.fn(async () => 'expired mutation')
    waiter = withProcessLock({ path, timeoutMs: 1_000 }, operation)
    const result = expect(waiter).rejects.toThrow('timed out waiting for process lock')
    // Move wall time without running timers, as an occupied event loop does.
    vi.setSystemTime(Date.now() + 2_000)
    release()
    await owner
    await result
    expect(operation).not.toHaveBeenCalled()
    await expect(withProcessLock({ path }, async () => 'next owner')).resolves.toBe('next owner')
  } finally {
    release()
    await owner
    await waiter?.catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
})
