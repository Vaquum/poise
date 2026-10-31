import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { LinkStreams } from '../src/link-streams.js'

let server: http.Server | null = null

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (!server) return resolve()
    server.close(() => resolve())
    server.closeAllConnections()
  })
  server = null
})

/** Serves one request with `handle`, from a client that hangs up after `hangUpMs`. */
async function oneRequest(handle: (res: http.ServerResponse) => void, hangUpMs: number): Promise<void> {
  server = http.createServer((_req, res) => handle(res))
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const req = http.get({ host: '127.0.0.1', port, path: '/api/link/events' }, (res) => {
    res.on('error', () => {})
    res.resume()
  })
  req.on('error', () => {})
  setTimeout(() => req.destroy(), hangUpMs)
}

describe('LinkStreams', () => {
  it('holds an answered stream while it is open and lets it go when the device hangs up', async () => {
    const streams = new LinkStreams()
    let closes = 0
    const closed = new Promise<void>((resolve) => {
      void oneRequest((res) => {
        streams.watch('laptop', res, () => {
          closes += 1
          resolve()
        })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.flushHeaders()
      }, 100)
    })
    await expect.poll(() => streams.connected('laptop')).toBe(true)
    expect(streams.size).toBe(1)
    expect(streams.connected('desktop')).toBe(false)
    await closed
    expect(streams.connected('laptop')).toBe(false)
    expect(streams.size).toBe(0)
    expect(closes).toBe(1)
  })

  it('holds nothing for a device that hung up before its stream was proxied', async () => {
    const streams = new LinkStreams()
    let closes = 0
    const registered = new Promise<void>((resolve) => {
      void oneRequest((res) => {
        // As when the device hangs up while the gateway waits for its workspace to be ready.
        res.once('close', () => {
          streams.watch('laptop', res, () => { closes += 1 })
          resolve()
        })
      }, 20)
    })
    await registered
    expect(streams.size).toBe(0)
    expect(streams.connected('laptop')).toBe(false)
    expect(closes).toBe(0)
  })
})
