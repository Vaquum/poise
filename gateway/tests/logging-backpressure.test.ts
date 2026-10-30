import { createServer, get, type IncomingMessage, type ServerResponse } from 'node:http'
import { expect, it } from 'vitest'
import { serveLogging } from '../src/diagnostics/query-http.js'
import { LoggingQueryPool } from '../src/diagnostics/query-pool.js'
import { DEFAULT_LOG_POLICY } from '../src/diagnostics/store.js'

it('holds admission through real HTTP backpressure and releases abandoned exports', async () => {
  const pool = new LoggingQueryPool({ workerUrl: new URL('./fixtures/logging-worker.mjs', import.meta.url) })
  const replies: ServerResponse[] = []
  const responses: IncomingMessage[] = []
  const server = createServer((req, res) => {
    replies.push(res)
    void serveLogging(req, res, new URL(req.url!, 'http://local'), '/export', {
      pool, path: ':memory:', policy: DEFAULT_LOG_POLICY, workspace: 'alice', isAdmin: false, now: Date.now(), audit: () => { throw new Error('unexpected instance request') },
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  const slow = () => new Promise<IncomingMessage>((resolve, reject) => {
    const req = get(`http://127.0.0.1:${port}/?search=large`, (res) => { res.pause(); responses.push(res); resolve(res) })
    req.on('error', reject)
  })
  try {
    const first = await slow(); const second = await slow()
    expect(first.statusCode).toBe(200); expect(second.statusCode).toBe(200)
    expect(replies[0].writableFinished).toBe(false); expect(replies[1].writableFinished).toBe(false)
    const third = await fetch(`http://127.0.0.1:${port}/`)
    expect(third.status).toBe(429); expect(third.headers.get('retry-after')).toBe('1'); await third.text()
    first.destroy(); second.destroy()
    await new Promise<void>((resolve) => replies[0].closed && replies[1].closed ? resolve() : setImmediate(resolve))
    const next = await fetch(`http://127.0.0.1:${port}/`)
    expect(next.status).toBe(200); await next.text()
  } finally {
    for (const response of responses) response.destroy()
    await pool.close(); server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
