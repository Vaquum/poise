import { createServer } from 'node:http'
import { afterAll, expect, it, vi } from 'vitest'
import { db, setMeta, closeDatabase } from '../server/db'
import { behaviorChainJournal } from '../server/behavior-chain-journal'

vi.mock('../server/behaviors', () => ({ getBehaviorChainRuntimeHealth: () => [] }))
const { handleBehaviorChains } = await import('../server/behavior-chain-api')
afterAll(() => closeDatabase())

it('reports durable cutover through the real HTTP handler and refuses stale or invalid controls', async () => {
  const server = createServer((req, res) => { void handleBehaviorChains(req, res, req.url || '/') })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  const base = `http://127.0.0.1:${address.port}/api/behavior-chains`
  const post = (body: unknown) => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  try {
    expect((await post({ operation: 'switch-to-v2', sequence: 0 })).status).toBe(409)
    setMeta('me', 'author'); setMeta('agentAccount', 'reviewer')
    expect((await post({ operation: 'switch-to-v2' })).status).toBe(400)
    const response = await post({ operation: 'switch-to-v2', sequence: 0 })
    expect(response.status).toBe(200)
    const drain = await response.json()
    expect(drain.cutover.mode).toBe('draining')
    expect((await post({ operation: 'cancel-cutover', sequence: 0 })).status).toBe(409)
    const read = await (await fetch(base)).json()
    expect(read.cutover.sequence).toBe(drain.cutover.sequence)
    expect((await post({ operation: 'cancel-cutover', sequence: drain.cutover.sequence })).status).toBe(200)
    expect(behaviorChainJournal().cutover().mode).toBe('v1')
    expect(db.prepare('SELECT count(*) AS n FROM behavior_chain_current').get()).toEqual({ n: 0 })
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
})
