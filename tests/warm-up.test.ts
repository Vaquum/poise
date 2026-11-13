import { beforeEach, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({ meta: {} as Record<string, string>, writes: 0 }))
vi.mock('../server/db', () => ({
  getMeta: (key: string) => store.meta[key] ?? null,
  setMeta: (key: string, value: string) => { store.writes++; store.meta[key] = value },
}))

/** A fresh process: the module's memory is gone, meta is not. */
async function restart() {
  vi.resetModules()
  return await import('../server/warm-up')
}

beforeEach(() => { store.meta = {}; store.writes = 0 })

it('keeps the distinct reads pages made, newest first, writing only a new one', async () => {
  const warm = await restart()
  const board = { operation: 'list', record_type: 'all', record_state: 'open', limit: 201, offset: 0 }
  const overview = { operation: 'list', record_type: 'all', record_state: 'open', limit: 200, offset: 0 }
  warm.rememberRead(board)
  warm.rememberRead(overview)
  warm.rememberRead(board)
  warm.rememberRead(overview)
  expect(store.writes).toBe(2)
  for (let index = 0; index < 10; index++) warm.rememberRead({ operation: 'list', offset: index })
  expect(JSON.parse(store.meta.warm_up_reads)).toHaveLength(8)
  expect(JSON.parse(store.meta.warm_up_reads)[0]).toBe(JSON.stringify({ operation: 'list', offset: 9 }))
})

it('makes the kept reads again after a restart, one at a time, then system health, past any that fail', async () => {
  const before = await restart()
  before.rememberRead({ operation: 'issue_intake' })
  before.rememberRead({ operation: 'list', record_type: 'all' })
  const after = await restart()
  const order: string[] = []
  let running = 0
  const read = vi.fn(async (body: unknown) => {
    running++
    expect(running).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 1))
    running--
    order.push(JSON.stringify(body))
    if ((body as { operation: string }).operation === 'list') throw new Error('GitHub is down')
  })
  const health = vi.fn(async () => { order.push('health') })
  await after.warmUp({ read, health })
  expect(order).toEqual([JSON.stringify({ operation: 'list', record_type: 'all' }), JSON.stringify({ operation: 'issue_intake' }), 'health'])
  // Making them again keeps nothing new.
  const writes = store.writes
  after.rememberRead({ operation: 'issue_intake' })
  expect(store.writes).toBe(writes)
})

it('starts with nothing to make again when meta holds no reads, or holds something else', async () => {
  store.meta.warm_up_reads = '{"not":"a list"}'
  const health = vi.fn(async () => undefined)
  const read = vi.fn(async () => undefined)
  await (await restart()).warmUp({ read, health })
  expect(read).not.toHaveBeenCalled()
  expect(health).toHaveBeenCalledTimes(1)
})
