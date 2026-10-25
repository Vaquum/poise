import type { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AnalyticsDatastoreQuery } from '../server/analytics-datastore'

const mocks = vi.hoisted(() => ({ workers: [] as Array<EventEmitter & {
  terminate: ReturnType<typeof vi.fn>, postMessage: ReturnType<typeof vi.fn>,
}> }))
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(), existsSync: () => true }))
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events')
  return { Worker: class extends EventEmitter {
    constructor() { super(); mocks.workers.push(this) }
    postMessage = vi.fn()
    terminate = vi.fn(async () => 0)
    unref() {}
  } }
})
const { readAnalyticsInWorker } = await import('../server/analytics-reader')
const input: AnalyticsDatastoreQuery = { organizations: [], me: '', window: { since: null, until: null }, scopes: { issue: [], pr: [] } }
const records = { issues: [], prs: [], errors: [] }
beforeEach(() => { mocks.workers = [] })
afterEach(() => { vi.useRealTimers() })

it('does not start work for an already abandoned request', async () => {
  await expect(readAnalyticsInWorker(input, AbortSignal.abort(new Error('gone')))).rejects.toThrow('gone')
  expect(mocks.workers).toHaveLength(0)
})

it('terminates a pending worker when its client disconnects', async () => {
  const controller = new AbortController()
  const pending = readAnalyticsInWorker(input, controller.signal)
  const rejected = expect(pending).rejects.toThrow('gone')
  await vi.waitFor(() => expect(mocks.workers).toHaveLength(1))
  expect(mocks.workers[0].postMessage).toHaveBeenCalledWith(input)
  controller.abort(new Error('gone'))
  await rejected
  expect(mocks.workers[0].terminate).toHaveBeenCalledOnce()
})

it('terminates a worker when its existing deadline expires', async () => {
  vi.useFakeTimers()
  const pending = readAnalyticsInWorker(input)
  const rejected = expect(pending).rejects.toThrow('Analytics datastore read timed out')
  await vi.waitFor(() => expect(mocks.workers).toHaveLength(1))
  await vi.advanceTimersByTimeAsync(15_000)
  await rejected
  expect(mocks.workers[0].terminate).toHaveBeenCalledOnce()
})

it.each(['result', 'error', 'exit'] as const)('reaps the worker after %s', async kind => {
  const pending = readAnalyticsInWorker(input)
  const settled = kind === 'result' ? expect(pending).resolves.toEqual(records) : expect(pending).rejects.toThrow()
  await vi.waitFor(() => expect(mocks.workers).toHaveLength(1))
  const worker = mocks.workers[0]
  if (kind === 'result') worker.emit('message', { ok: true, records })
  else if (kind === 'error') worker.emit('error', new Error('read failed'))
  else worker.emit('exit', 1)
  await settled
  expect(worker.terminate).toHaveBeenCalledOnce()
})
