import { expect, it, vi } from 'vitest'
import { LoggingQueryPool } from '../src/diagnostics/query-pool.js'
import { DEFAULT_LOG_POLICY } from '../src/diagnostics/store.js'
import type { LoggingRead } from '../src/diagnostics/query-types.js'

const request: LoggingRead = { path: ':memory:', policy: DEFAULT_LOG_POLICY, now: Date.now(), access: { workspace: 'alice', operator: false }, operation: 'list', filter: {} }
const create = () => new LoggingQueryPool({ workerUrl: new URL('./fixtures/logging-worker.mjs', import.meta.url) })

it('holds two principal slots through response completion and releases admission explicitly', async () => {
  const pool = create(); const signal = new AbortController().signal
  try {
    const first = await pool.read(request, 'alice', signal, vi.fn())
    const second = await pool.read(request, 'alice', signal, vi.fn())
    await expect(pool.read(request, 'alice', signal, vi.fn())).rejects.toMatchObject({ status: 429 })
    first.release()
    const third = await pool.read(request, 'alice', signal, vi.fn())
    second.release(); third.release()
  } finally { await pool.close() }
})

it('abandons queued reads and terminates an abandoned active worker before later work progresses', async () => {
  const pool = create(); const active = new AbortController(); const queued = new AbortController()
  try {
    const first = pool.read({ ...request, filter: { search: 'hold' } }, 'alice', active.signal, vi.fn()).catch((error: unknown) => error)
    const second = pool.read({ ...request, filter: { search: 'hold' } }, 'alice', queued.signal, vi.fn()).catch((error: unknown) => error)
    await expect(pool.read(request, 'alice', new AbortController().signal, vi.fn())).rejects.toMatchObject({ status: 429 })
    queued.abort()
    expect(await second).toMatchObject({ code: 'logging_abandoned' })
    const next = pool.read(request, 'alice', new AbortController().signal, vi.fn())
    active.abort()
    expect(await first).toMatchObject({ code: 'logging_abandoned' })
    const lease = await next
    expect(lease.reply.status).toBe(200); lease.release()
  } finally { await pool.close() }
})

it('enforces the actual default two-second query budget and frees the principal after timeout', async () => {
  const pool = create(); const timedOut = vi.fn()
  try {
    await expect(pool.read({ ...request, filter: { search: 'hold' } }, 'alice', new AbortController().signal, timedOut)).rejects.toMatchObject({ status: 503, code: 'logging_query_timeout' })
    expect(timedOut).toHaveBeenCalledOnce()
    const lease = await pool.read(request, 'alice', new AbortController().signal, vi.fn())
    expect(lease.reply.status).toBe(200); lease.release()
  } finally { await pool.close() }
})


it('caps global admission at one active and sixteen queued reads across principals', async () => {
  const pool = create(); const requests = Array.from({ length: 17 }, () => new AbortController())
  const pending = requests.map((abort, i) => pool.read({ ...request, filter: { search: 'hold' } }, 'owner-' + i, abort.signal, vi.fn()).catch((error: unknown) => error))
  try {
    await expect(pool.read(request, 'another-owner', new AbortController().signal, vi.fn())).rejects.toMatchObject({ status: 429 })
    requests[16].abort()
    expect(await pending[16]).toMatchObject({ code: 'logging_abandoned' })
    const next = pool.read(request, 'another-owner', new AbortController().signal, vi.fn())
    for (const abort of requests) abort.abort()
    const lease = await next; expect(lease.reply.status).toBe(200); lease.release()
    expect((await Promise.all(pending)).every((error) => error instanceof Error)).toBe(true)
  } finally { for (const abort of requests) abort.abort(); await pool.close() }
})
