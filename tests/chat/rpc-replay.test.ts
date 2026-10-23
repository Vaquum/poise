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
    expect([...progress.responded]).toEqual([['number:7', 1]])
    expect(outboundHasMethod(OUTBOUND, 'turn/start')).toBe(true)
    expect(outboundHasMethod(OUTBOUND, 'session/prompt')).toBe(false)
  })

  it('counts sequential response occurrences without conflating numeric and string ids', () => {
    const progress = outboundProgress(Buffer.concat([OUTBOUND, Buffer.from(
      '{"jsonrpc":"2.0","id":7,"error":{"code":-32000,"message":"recorded failure"}}\n'
      + '{"jsonrpc":"2.0","id":"7","result":{}}\n',
    )]))
    expect([...progress.responded]).toEqual([['number:7', 2], ['string:7', 1]])
  })

  it('consumes only the recorded response occurrences before answering a reused id during replay', () => {
    const { rpc, written } = fixture()
    rpc.beginReplay(Buffer.concat([OUTBOUND, Buffer.from('{"jsonrpc":"2.0","id":7,"result":{}}\n')]))
    rpc.respond(7, 'first historical answer')
    rpc.respondError(7, { code: -32000, message: 'second historical answer' })
    rpc.respond(7, 'new answer')
    rpc.respond('7', 'different typed id')
    expect(written.map(line => JSON.parse(line))).toEqual([
      { jsonrpc: '2.0', id: 7, result: 'new answer' },
      { jsonrpc: '2.0', id: '7', result: 'different typed id' },
    ])
    expect(rpc.isReplaying).toBe(true)
    rpc.endReplay()
  })

  it('skips two completed writes but executes a later unanswered write reusing their id in the same spool', async () => {
    const { rpc, receive, written } = fixture()
    const writes: unknown[] = []
    rpc.onRequest('fs/write_text_file', params => { writes.push(params); return {} })
    rpc.beginReplay(Buffer.concat([OUTBOUND, Buffer.from('{"jsonrpc":"2.0","id":7,"result":{}}\n')]))
    for (const content of ['first historical write', 'second historical write', 'new pending write']) {
      receive({ jsonrpc: '2.0', id: 7, method: 'fs/write_text_file', params: { content } })
    }
    await new Promise(resolve => setImmediate(resolve))
    expect(writes).toEqual([{ content: 'new pending write' }])
    expect(written.map(line => JSON.parse(line))).toEqual([{ jsonrpc: '2.0', id: 7, result: {} }])
    expect(rpc.isReplaying).toBe(true)
    rpc.endReplay()
  })

  it.each([
    ['resolve', false], ['reject', false], ['resolve', true], ['reject', true],
  ] as const)('keeps a newer request slot when a historical callback completes by %s (after LIVE=%s)', async (outcome, afterLive) => {
    const { rpc, receive, written } = fixture()
    let releaseOld!: () => void
    let releaseNew!: () => void
    const oldHeld = new Promise<void>(resolve => { releaseOld = resolve })
    const newHeld = new Promise<void>(resolve => { releaseNew = resolve })
    const calls: unknown[] = []
    const duplicates: unknown[] = []
    rpc.on('duplicate-request', id => { duplicates.push(id) })
    rpc.onRequest('ask', async params => {
      calls.push(params)
      if (params === 'historical') {
        await oldHeld
        if (outcome === 'reject') throw new Error('historical decision failed')
        return 'old answer'
      }
      await newHeld
      return 'new answer'
    }, { replayCompleted: true })
    rpc.beginReplay(OUTBOUND)
    receive({ jsonrpc: '2.0', id: 7, method: 'ask', params: 'historical' })
    receive({ jsonrpc: '2.0', id: 7, method: 'ask', params: 'new pending' })
    try {
      await new Promise(resolve => setImmediate(resolve))
      expect(calls).toEqual(['historical', 'new pending'])
      expect(duplicates).toEqual([])
      if (afterLive) rpc.endReplay()
      releaseOld()
      await new Promise(resolve => setImmediate(resolve))
      expect(written).toEqual([])
      receive({ jsonrpc: '2.0', id: 7, method: 'ask', params: 'actual duplicate' })
      await new Promise(resolve => setImmediate(resolve))
      expect(duplicates).toEqual([7])
      expect(calls).toEqual(['historical', 'new pending'])
      releaseNew()
      await new Promise(resolve => setImmediate(resolve))
      const frames = written.map(line => JSON.parse(line))
      expect(frames).toHaveLength(2)
      expect(frames[0]).toMatchObject({ id: 7, error: { code: -32600 } })
      expect(frames[1]).toEqual({ jsonrpc: '2.0', id: 7, result: 'new answer' })
      if (!afterLive) rpc.endReplay()
    } finally {
      releaseOld(); releaseNew()
    }
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

  it('holds notifications while replaying and sends them once live', async () => {
    const { rpc, written } = fixture()
    rpc.beginReplay(OUTBOUND)
    rpc.notify('session/cancel', { held: true })
    expect(written.join('')).toBe('')
    rpc.endReplay()
    rpc.notify('session/cancel', { held: false })
    await new Promise((resolve) => setImmediate(resolve))
    const out = written.join('')
    // The cancel issued mid-replay reaches the agent; it is not lost.
    expect(out).toContain('"held":true')
    expect(out).toContain('"held":false')
  })

  it('does not repeat a completed filesystem write or send its delayed response after LIVE', async () => {
    const { rpc, receive, written } = fixture()
    let content = 'newer agent edit'
    let writes = 0
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    rpc.onRequest('fs/write_text_file', async () => {
      writes++
      await held
      content = 'old recorded content'
      return {}
    })
    rpc.beginReplay(OUTBOUND)
    receive({ jsonrpc: '2.0', id: 7, method: 'fs/write_text_file', params: { content: 'old recorded content' } })
    await new Promise(resolve => setImmediate(resolve))
    rpc.endReplay()
    release()
    await new Promise(resolve => setImmediate(resolve))
    expect(writes).toBe(0)
    expect(content).toBe('newer agent edit')
    expect(written.join('')).toBe('')
  })

  it('finishes an unacknowledged replayed handler after LIVE and accepts a fresh live reuse of a completed id', async () => {
    const { rpc, receive, written } = fixture()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    rpc.onRequest('ask', async () => { calls++; await held; return 'answer' })
    rpc.beginReplay(OUTBOUND)
    receive({ jsonrpc: '2.0', id: 9, method: 'ask' })
    await new Promise(resolve => setImmediate(resolve))
    rpc.endReplay()
    receive({ jsonrpc: '2.0', id: 7, method: 'ask' })
    release()
    await new Promise(resolve => setImmediate(resolve))
    expect(calls).toBe(2)
    expect(written.join('').split('\n').filter(Boolean).map(line => JSON.parse(line).id).sort()).toEqual([7, 9])
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
