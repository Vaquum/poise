import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { livePromise, RelayConnection } from '../../server/chat/relay'
import { RpcClosedError, StdioRpc } from '../../server/chat/rpc'

function frame(kind: number, value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value))
  const header = Buffer.alloc(5)
  header.writeUInt8(kind, 0)
  header.writeUInt32BE(body.length, 1)
  return Buffer.concat([header, body])
}

it('keeps buffered filesystem requests in replay after an awaited outbound read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-buffered-'))
  const socketPath = join(tmpdir(), `pl-${randomUUID().slice(0, 12)}.sock`)
  const path = join(root, 'draft.txt')
  await writeFile(path, 'newer agent edit')
  const request = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'fs/write_text_file', params: { content: 'old text' } }) + '\n')
  const stdout = Buffer.alloc(5)
  stdout.writeUInt8(103, 0)
  stdout.writeUInt32BE(request.length, 1)
  const outbound = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 7, result: {} }) + '\n')
  let remote: Socket | undefined
  const server = createServer(socket => {
    remote = socket
    let buffer: Buffer = Buffer.alloc(0)
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32BE(1)) {
        const kind = buffer.readUInt8(0)
        buffer = buffer.subarray(5 + buffer.readUInt32BE(1))
        if (kind === 1) socket.write(Buffer.concat([
          frame(101, { version: 1, relayPid: 0, gatePid: 0, gatePgid: 0, spoolTurn: 'turn-test' }),
          stdout, request, frame(106, {}),
        ]))
        if (kind === 6) socket.write(frame(107, { bytes: outbound.toString('base64'), truncated: false }))
      }
    })
  })
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  const peer = new RelayConnection({ sessionId: 'session-test', ident: 'test', dir: root, socketPath })
  let rpc: StdioRpc | undefined
  try {
    await peer.connect()
    // The server sends the entire spool and LIVE before answering this
    // read; the adapter has not attached to stdout yet.
    const recorded = await peer.getOutbound()
    expect(peer.stdout.readableLength).toBe(request.length)
    let becameLive = false
    const live = peer.whenLive().then(() => { becameLive = true })
    await Promise.resolve()
    expect(becameLive).toBe(false)
    rpc = new StdioRpc(peer)
    let written!: () => void
    const saved = new Promise<void>(resolve => { written = resolve })
    rpc.onRequest('fs/write_text_file', async (params: unknown) => {
      const content = (params as { content: string }).content
      await writeFile(path, content)
      written()
      return {}
    })
    rpc.beginReplay(recorded.bytes)
    await live
    rpc.endReplay()
    expect(await readFile(path, 'utf8')).toBe('newer agent edit')
    const fresh = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'fs/write_text_file', params: { content: 'fresh live edit' } }) + '\n')
    const freshHeader = Buffer.alloc(5)
    freshHeader.writeUInt8(103, 0)
    freshHeader.writeUInt32BE(fresh.length, 1)
    remote!.write(Buffer.concat([freshHeader, fresh]))
    await saved
    expect(await readFile(path, 'utf8')).toBe('fresh live edit')
  } finally {
    rpc?.fail(new RpcClosedError('test complete'))
    peer.detach()
    remote?.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  { includeLive: true, late: false },
  { includeLive: false, late: false },
  { includeLive: true, late: true },
  { includeLive: false, late: true },
])('settles a coalesced final response and exit with LIVE=$includeLive, late=$late', async ({ includeLive, late }) => {
  const root = await mkdtemp(join(tmpdir(), 'relay-live-exit-'))
  const socketPath = join(tmpdir(), `pl-${randomUUID().slice(0, 12)}.sock`)
  let remote: Socket | undefined
  const server = createServer(socket => {
    remote = socket
    let buffer: Buffer = Buffer.alloc(0)
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32BE(1)) {
        const kind = buffer.readUInt8(0)
        const size = buffer.readUInt32BE(1)
        const payload = buffer.subarray(5, 5 + size)
        buffer = buffer.subarray(5 + size)
        if (kind === 1) socket.write(frame(101, { version: 1, relayPid: 0, gatePid: 0, gatePgid: 0, spoolTurn: 'turn-final' }))
        if (kind === 2) {
          const request = JSON.parse(payload.toString('utf8')) as { id: number }
          const response = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } }) + '\n')
          const header = Buffer.alloc(5)
          header.writeUInt8(103, 0); header.writeUInt32BE(response.length, 1)
          socket.write(Buffer.concat([header, response, ...(includeLive ? [frame(106, {})] : []), frame(105, { code: 0 })]))
        }
      }
    })
  })
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  const peer = new RelayConnection({ sessionId: 'final-session', ident: 'test', dir: root, socketPath })
  let rpc: StdioRpc | undefined
  let liveInCallback = false
  let coalesced = false
  peer.on('frame', (kind: number) => {
    if (kind === 106) { liveInCallback = true; queueMicrotask(() => { liveInCallback = false }) }
    if (kind === 105) coalesced = liveInCallback
  })
  try {
    await peer.connect()
    rpc = new StdioRpc(peer)
    const observeBoundary = () => livePromise(peer).then(() => ({ live: true }), error => ({ error: String(error) }))
    let boundary = late ? undefined : observeBoundary()
    await expect(rpc.request('test/final', {})).resolves.toEqual({ stopReason: 'end_turn' })
    expect(peer.exitCode).toBe(0)
    boundary ??= observeBoundary()
    if (includeLive) {
      expect(coalesced).toBe(true)
      expect(await boundary).toEqual({ live: true })
    } else {
      expect(await boundary).toEqual({ error: expect.stringContaining('went away during replay') })
    }
    expect(peer.exitCode).toBe(0)
  } finally {
    rpc?.fail(new RpcClosedError('test complete'))
    peer.detach(); remote?.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps a decoded LIVE pending until buffered stdout is consumed after exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-live-buffer-'))
  const socketPath = join(tmpdir(), `pl-${randomUUID().slice(0, 12)}.sock`)
  let remote: Socket | undefined
  const stdout = Buffer.from('buffered final output\n')
  const header = Buffer.alloc(5)
  header.writeUInt8(103, 0); header.writeUInt32BE(stdout.length, 1)
  const server = createServer(socket => {
    remote = socket
    let buffer: Buffer = Buffer.alloc(0)
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32BE(1)) {
        const kind = buffer.readUInt8(0)
        buffer = buffer.subarray(5 + buffer.readUInt32BE(1))
        if (kind === 1) socket.write(frame(101, { version: 1, relayPid: 0, gatePid: 0, gatePgid: 0, spoolTurn: 'buffered' }))
        if (kind === 6) socket.write(Buffer.concat([
          header, stdout, frame(106, {}), frame(107, { bytes: '', truncated: false }), frame(105, { code: 0 }),
        ]))
      }
    })
  })
  await new Promise<void>(resolve => server.listen(socketPath, resolve))
  const peer = new RelayConnection({ sessionId: 'buffered-final', ident: 'test', dir: root, socketPath })
  try {
    await peer.connect()
    await peer.getOutbound()
    expect(peer.exited).toBe(true)
    let settled = false
    const boundary = livePromise(peer).then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    const consumed = new Promise<Buffer>(resolve => peer.stdout.once('data', resolve))
    peer.stdout.resume()
    expect(await consumed).toEqual(stdout)
    await boundary
    expect(settled).toBe(true)
  } finally {
    peer.detach(); remote?.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})
