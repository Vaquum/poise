import { createServer } from 'node:http'
import { afterAll, expect, it, vi } from 'vitest'
import { closeDatabase } from '../server/db'
import { behaviorChainJournal } from '../server/behavior-chain-journal'

vi.mock('../server/native-cleanup-support', () => ({
  nativeCleanupSupport: () => ({ status: 'supported', error: null }),
  requireNativeCleanup: async () => {},
}))
vi.mock('../server/behaviors', () => ({ getBehaviorChainRuntimeHealth: () => [],
  getBehaviorChainCapacity: () => ({ status: 'available', reservedModelInvocations: 0, modelInvocationLimit: 3,
    enabled: false, intake: { seedMode: 'label', label: 'poise' } }) }))
const { handleBehaviorChains } = await import('../server/behavior-chain-api')
afterAll(() => closeDatabase())

it('shares a list read’s chains and attention between identical reads for a few seconds, and a change clears them', async () => {
  const journal = behaviorChainJournal()
  const pages = vi.spyOn(journal, 'page')
  const clock = vi.spyOn(Date, 'now')
  const server = createServer((req, res) => { void handleBehaviorChains(req, res, req.url || '/') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  const base = `http://127.0.0.1:${address.port}/api/behavior-chains`
  try {
    clock.mockReturnValue(1_000_000)
    const first = await (await fetch(`${base}?state=active`)).json()
    const computed = pages.mock.calls.length
    expect(computed).toBeGreaterThan(0)
    expect(first).toHaveProperty('attention')
    // Within the window: the same read, and a read of another state, compute no attention again.
    clock.mockReturnValue(1_009_000)
    expect(await (await fetch(`${base}?state=active`)).json()).toEqual(first)
    expect(pages.mock.calls.length).toBe(computed)
    await (await fetch(base)).json()
    expect(pages.mock.calls.length).toBe(computed + 1)
    // Past the window it is computed afresh.
    clock.mockReturnValue(1_010_000)
    await (await fetch(`${base}?state=active`)).json()
    expect(pages.mock.calls.length).toBeGreaterThan(computed + 1)
    // A change made through the API clears it at once, even within the window.
    const settled = pages.mock.calls.length
    const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'hold' }) })
    expect(response.status).toBe(400)
    await (await fetch(`${base}?state=active`)).json()
    expect(pages.mock.calls.length).toBeGreaterThan(settled)
  } finally {
    clock.mockRestore()
    pages.mockRestore()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
