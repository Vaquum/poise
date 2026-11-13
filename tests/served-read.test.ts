import { describe, expect, it, vi } from 'vitest'
import { servedRead, type ServedRead } from '../server/served-read'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('servedRead', () => {
  it('shares one computation among readers asking at once, and waits for it the first time', async () => {
    const state: ServedRead<string> = { running: null, last: null }
    const first = deferred<string>()
    const compute = vi.fn(() => first.promise)
    const a = servedRead(state, compute, { waitMs: 20, servedMs: 60_000 })
    const b = servedRead(state, compute, { waitMs: 20, servedMs: 60_000 })
    first.resolve('fresh')
    expect(await a).toBe('fresh')
    expect(await b).toBe('fresh')
    expect(compute).toHaveBeenCalledTimes(1)
  })

  it('answers with the last result while a fresh one takes longer than the wait, and serves the fresh one next', async () => {
    const state: ServedRead<string> = { running: null, last: null }
    await servedRead(state, async () => 'one', { waitMs: 20, servedMs: 60_000 })
    const slow = deferred<string>()
    const started = Date.now()
    expect(await servedRead(state, () => slow.promise, { waitMs: 20, servedMs: 60_000 })).toBe('one')
    expect(Date.now() - started).toBeLessThan(1_000)
    slow.resolve('two')
    await slow.promise
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await servedRead(state, async () => 'three', { waitMs: 20, servedMs: 60_000 })).toBe('three')
  })

  it('takes a fresh result that arrives within the wait', async () => {
    const state: ServedRead<string> = { running: null, last: { value: 'old', at: Date.now() } }
    expect(await servedRead(state, async () => 'fresh', { waitMs: 200, servedMs: 60_000 })).toBe('fresh')
  })

  it('never serves a last result older than its limit, and lets a failure reach the reader who waits', async () => {
    let now = 1_000
    const state: ServedRead<string> = { running: null, last: { value: 'stale', at: 0 } }
    const slow = deferred<string>()
    const read = servedRead(state, () => slow.promise, { waitMs: 5, servedMs: 500, now: () => now })
    await new Promise((resolve) => setTimeout(resolve, 20))
    slow.resolve('fresh')
    expect(await read).toBe('fresh')
    now = 1_100
    await expect(servedRead({ running: null, last: null }, async () => { throw new Error('journal unreadable') }, { waitMs: 5, servedMs: 500 }))
      .rejects.toThrow('journal unreadable')
  })

  it('makes the next reader wait for the real outcome after a refresh fails, until one succeeds', async () => {
    const state: ServedRead<string> = { running: null, last: { value: 'old', at: Date.now() } }
    const failing = deferred<string>()
    expect(await servedRead(state, () => failing.promise, { waitMs: 5, servedMs: 60_000 })).toBe('old')
    failing.reject(new Error('journal unreadable'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The old figures are not served over a failure: the next reader gets the outcome.
    await expect(servedRead(state, async () => { throw new Error('still unreadable') }, { waitMs: 5, servedMs: 60_000 }))
      .rejects.toThrow('still unreadable')
    expect(await servedRead(state, async () => 'recovered', { waitMs: 5, servedMs: 60_000 })).toBe('recovered')
    const slow = deferred<string>()
    expect(await servedRead(state, () => slow.promise, { waitMs: 5, servedMs: 60_000 })).toBe('recovered')
    slow.resolve('later')
  })

  it('never serves a result that would pass its limit during the wait', async () => {
    let now = 119_900
    const state: ServedRead<string> = { running: null, last: { value: 'almost too old', at: 0 } }
    const slow = deferred<string>()
    const read = servedRead(state, () => slow.promise, { waitMs: 300, servedMs: 120_000, now: () => now })
    await new Promise((resolve) => setTimeout(resolve, 350))
    now = 120_300
    slow.resolve('fresh')
    expect(await read).toBe('fresh')
  })
})

describe('healthReadKey', () => {
  it('keys a projection by its scope and by every account it reads and how ready each is', async () => {
    const { healthReadKey } = await import('../server/analytics-health')
    const two = [{ login: 'Alpha', status: 'ready' }, { login: 'beta', status: 'ready' }] as const
    expect(healthReadKey('', two)).toBe(healthReadKey('', [...two].reverse()))
    expect(healthReadKey('', two)).not.toBe(healthReadKey('', [two[0]]))
    expect(healthReadKey('', two)).not.toBe(healthReadKey('', [two[0], { login: 'beta', status: 'initializing' }]))
    expect(healthReadKey('alpha', [two[0]])).not.toBe(healthReadKey('', [two[0]]))
  })
})
