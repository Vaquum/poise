import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { RelayConnection } from '../../server/chat/relay'

function frame(kind: number, value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(5)
  header.writeUInt8(kind, 0)
  header.writeUInt32BE(body.length, 1)
  return Buffer.concat([header, body])
}

it('keeps a later outbound read alive across a completed read deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-outbound-'))
  const socketPath = join(tmpdir(), `pl-${randomUUID().slice(0, 12)}.sock`)
  let remote: Socket | undefined
  let received!: () => void
  const server = createServer(socket => {
    remote = socket
    let buffer: Buffer = Buffer.alloc(0)
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32BE(1)) {
        const kind = buffer.readUInt8(0)
        buffer = buffer.subarray(5 + buffer.readUInt32BE(1))
        if (kind === 1) socket.write(frame(101, { version: 1, relayPid: 0, gatePid: 0, gatePgid: 0, spoolTurn: null }))
        if (kind === 6) received()
      }
    })
  })
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  const peer = new RelayConnection({ sessionId: 'outbound-test', ident: 'test', dir: root, socketPath })
  try {
    await peer.connect()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const firstReceived = new Promise<void>(resolve => { received = resolve })
    const first = peer.getOutbound()
    await firstReceived
    remote!.write(frame(107, { bytes: Buffer.from('first').toString('base64'), truncated: false }))
    expect((await first).bytes.toString()).toBe('first')

    await vi.advanceTimersByTimeAsync(5_000)
    const secondReceived = new Promise<void>(resolve => { received = resolve })
    const second = peer.getOutbound()
    let result: { truncated: boolean, bytes: Buffer } | undefined
    let readError: unknown
    const settled = second.then(value => { result = value }, error => { readError = error })
    await secondReceived
    // Cross the first read's deadline while the second still has time.
    await vi.advanceTimersByTimeAsync(5_001)
    expect(result).toBeUndefined()
    const answered = new Promise<void>(resolve => {
      peer.once('frame', kind => { expect(kind).toBe(107); resolve() })
    })
    remote!.write(frame(107, { bytes: Buffer.from('second').toString('base64'), truncated: false }))
    await answered
    await vi.advanceTimersByTimeAsync(0)
    expect(readError).toBeUndefined()
    expect(result).toEqual({ truncated: false, bytes: Buffer.from('second') })
    await settled
  } finally {
    peer.detach()
    vi.useRealTimers()
    remote?.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
