// StdioRpc replay: a reconnecting adapter replays the spooled turn with the
// previous Poise's numbering continued, answers deduplicated against what
// the agent already got, and new requests held until the link is live.

import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { RpcClosedError, StdioRpc, outboundHasMethod, outboundProgress } from '../../server/chat/rpc'
import type { AgentProcess } from '../../server/chat/adapters/types'

const fixtures: Array<{ rpc: StdioRpc, streams: PassThrough[] }> = []
function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  })
  const rpc = new StdioRpc(child as unknown as AgentProcess, { requestTimeoutMs: 200 })
  fixtures.push({ rpc, streams: [child.stdin, child.stdout, child.stderr] })
  const receive = (message: unknown) => child.stdout.emit('data', Buffer.from(JSON.stringify(message) + '\n'))
  const written: string[] = []
  child.stdin.on('data', (chunk: Buffer) => written.push(chunk.toString()))
  return { rpc, child, receive, written }
}
afterEach(() => {
  for (const { rpc, streams } of fixtures.splice(0)) {
    rpc.fail(new RpcClosedError('test cleanup'))
    for (const stream of streams) stream.destroy()
  }
})

const OUTBOUND = Buffer.from(
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n'
  + '{"jsonrpc":"2.0","id":2,"method":"turn/start","params":{}}\n'
  + '{"jsonrpc":"2.0","id":7,"result":{}}\n',
)

describe('StdioRpc replay', () => {
  it('reads request numbering and answered ids from the recorded outbound stream', () => {
    const progress = outboundProgress(OUTBOUND)
    expect(progress.maxRequestId).toBe(2)
    expect([...progress.responded]).toEqual(['number:7'])
    expect(outboundHasMethod(OUTBOUND, 'turn/start')).toBe(true)
    expect(outboundHasMethod(OUTBOUND, 'session/prompt')).toBe(false)
  })

  it('continues numbering past the previous Poise so fresh requests cannot collide', async () => {
    const { rpc, receive, written } = fixture()
    rpc.beginReplay(OUTBOUND)
    const result = rpc.request('turn/steer', {})
    rpc.endReplay()
    receive({ jsonrpc: '2.0', id: 3, result: 'ok' })
    await expect(result).resolves.toBe('ok')
    expect(written.join('')).toContain('"id":3')
  })

  it('holds new requests until live and runs their deadline from the send', async () => {
    const { rpc, receive, written } = fixture()
    rpc.beginReplay(OUTBOUND)
    const result = rpc.request('turn/steer', {}, { timeoutMs: 150 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(written.join('')).toBe('')
    rpc.endReplay()
    expect(written.join('')).toContain('turn/steer')
    receive({ jsonrpc: '2.0', id: 3, result: 'ok' })
    await expect(result).resolves.toBe('ok')
  })

  it('aborts a held request at once without sending it', async () => {
    const { rpc, written } = fixture()
    rpc.beginReplay(OUTBOUND)
    const controller = new AbortController()
    const result = rpc.request('turn/steer', {}, { signal: controller.signal }).then(
      () => 'sent', (error: Error) => error.name)
    controller.abort()
    await expect(result).resolves.toBe('AbortError')
    rpc.endReplay()
    expect(written.join('')).toBe('')
  })

  it('drops answers the agent already got and sends the ones it never got', async () => {
    const { rpc, written } = fixture()
    rpc.onRequest('ask', async () => 'fresh-answer')
    rpc.beginReplay(OUTBOUND)
    rpc.respond(7, { outcome: 'selected' })
    rpc.respond(9, { outcome: 'selected' })
    rpc.endReplay()
    await new Promise((resolve) => setImmediate(resolve))
    const out = written.join('')
    expect(out).not.toContain('"id":7')
    expect(out).toContain('"id":9')
  })

  it('drops notifications while replaying and sends them once live', async () => {
    const { rpc, written } = fixture()
    rpc.beginReplay(OUTBOUND)
    rpc.notify('session/cancel', {})
    expect(written.join('')).toBe('')
    rpc.endReplay()
    rpc.notify('session/cancel', {})
    await new Promise((resolve) => setImmediate(resolve))
    expect(written.join('')).toContain('session/cancel')
  })

  it('hands orphan responses to the adapter with their message', async () => {
    const { rpc, receive } = fixture()
    rpc.beginReplay(OUTBOUND)
    const orphan = new Promise<unknown[]>((resolve) => rpc.on('orphan-response', (...args: unknown[]) => resolve(args)))
    receive({ jsonrpc: '2.0', id: 2, result: { turnId: 'native-1' } })
    const [id, message] = await orphan
    expect(id).toBe(2)
    expect(message).toEqual({ jsonrpc: '2.0', id: 2, result: { turnId: 'native-1' } })
    rpc.endReplay()
  })

  it('fails loud on a second replay or an end without a beginning', () => {
    const { rpc } = fixture()
    expect(() => rpc.endReplay()).toThrow('not active')
    rpc.beginReplay(OUTBOUND)
    expect(() => rpc.beginReplay(OUTBOUND)).toThrow('already active')
    rpc.endReplay()
  })

  it('rejects held requests when the link fails mid-replay', async () => {
    const { rpc } = fixture()
    rpc.beginReplay(OUTBOUND)
    const result = rpc.request('turn/steer', {}).then(() => 'sent', (error: Error) => error.message)
    rpc.fail(new Error('relay lost'))
    await expect(result).resolves.toContain('relay lost')
  })
})
