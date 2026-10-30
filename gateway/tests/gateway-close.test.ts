import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startHarness, workspaceHost } from './harness.js'

const ALICE = workspaceHost('alice')

describe('gateway close', () => {
  it('resolves within the grace with an open upgraded socket, ending the client', async () => {
    const h = await startHarness({ shutdownGraceMs: 200 })
    try {
      const cookie = (await h.openWorkspace('alice')).workspaceCookie
      const socket = new WebSocket(`ws://127.0.0.1:${h.port}/ws/chat`, { headers: { host: ALICE, cookie } })
      await new Promise<void>((resolve, reject) => {
        socket.on('open', () => resolve())
        socket.on('error', reject)
      })
      const closed = new Promise<number>((resolve) => {
        socket.on('close', (code) => resolve(code))
        socket.on('error', () => undefined)
      })
      const started = Date.now()
      await h.close()
      // Boundedly, not when the client goes first: the old close() hung until the client closed.
      expect(Date.now() - started).toBeLessThan(5000)
      await expect(closed).resolves.toEqual(expect.any(Number))
    } catch (error) {
      // h.close() above already ran on success; only clean up when the test failed before it.
      await h.close().catch(() => undefined)
      throw error
    }
  })

  it('lets an in-flight proxied answer finish instead of resetting it', async () => {
    const h = await startHarness({ shutdownGraceMs: 2000 })
    const cookie = (await h.openWorkspace('alice')).workspaceCookie
    const req = http.request({
      host: '127.0.0.1',
      port: h.port,
      method: 'POST',
      path: '/stream',
      headers: { host: ALICE, cookie, 'content-type': 'text/plain' },
      agent: false,
    })
    const response = new Promise<http.IncomingMessage>((resolve, reject) => {
      req.on('response', resolve)
      req.on('error', reject)
    })
    req.write('one')
    const res = await response
    let body = ''
    const ended = new Promise<void>((resolve, reject) => {
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8')
      })
      res.on('end', () => resolve())
      res.on('error', reject)
    })
    // First echo arrives while the body is still open, so the answer is in flight.
    await new Promise<void>((resolve) => {
      const check = () => {
        if (body.includes('echo:one')) resolve()
        else setTimeout(check, 10)
      }
      check()
    })
    const closing = h.close()
    req.end('two')
    await ended
    expect(body).toBe('open\necho:one\necho:two\ndone\n')
    await closing
    await delay(50)
  })
})
