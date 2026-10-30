import http from 'node:http'
import { createServer } from 'node:net'
import { expect, it, vi } from 'vitest'
import { startHarness, workspaceHost, type Harness } from './harness.js'

it('reserves the unavailable upstream until harness cleanup instead of releasing a reusable port', async () => {
  const created = vi.spyOn(http, 'createServer')
  let h: Harness | null = null
  const probe = createServer()
  try {
    h = await startHarness()
    const alice = await h.openWorkspace('Alice')
    const request = () => h!.request({ host: workspaceHost('alice'), path: '/', headers: { cookie: alice.workspaceCookie } })
    expect((await request()).status).toBe(200)
    h.workspace.reachable = false
    const upstream = h.context.deps.upstream!('alice')
    expect(upstream.host).toBe('unavailable.poise.invalid')
    const result = await new Promise<string>((resolve) => {
      probe.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message))
      probe.listen(upstream.port, '127.0.0.1', () => resolve('listening'))
    })
    expect(result).toBe('EADDRINUSE')
    expect((await request()).status).toBe(503)
    const owner = created.mock.results.flatMap((result) => result.type === 'return' ? [result.value] : []).find((server) => {
      const address = server.address()
      return address !== null && typeof address !== 'string' && address.port === upstream.port
    })
    if (!owner) throw new Error('The fixture must own its workspace HTTP listener')
    await h.close(); h = null
    expect(owner.listening).toBe(false)
    expect(owner.address()).toBeNull()
  } finally {
    if (probe.listening) await new Promise<void>((resolve) => probe.close(() => resolve()))
    if (h) await h.close()
    created.mockRestore()
  }
})
