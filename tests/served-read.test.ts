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
})
