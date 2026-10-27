import { chmodSync, lstatSync, unlinkSync } from 'node:fs'
import { createConnection, createServer, type Socket } from 'node:net'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { once } from 'node:events'
import { receiveIngress, receiveManualIngress } from './ingress.js'
import type { DiagnosticRuntime } from './runtime.js'

/** A forced-command process relays bytes; only the gateway owns a writable store. */
export async function relayIngress(path: string, command: 'ingress' | 'ingress-stream', stdin: AsyncIterable<Buffer | string>, write: (line: string) => void): Promise<void> {
  const socket = createConnection({ path })
  const timer = setTimeout(() => socket.destroy(new Error('Ingress relay exceeded 30 seconds')), 30_000)
  let reply = '', size = 0, lines = 0
  socket.on('data', (chunk: Buffer) => {
    try {
    reply += chunk.toString('utf8')
    if (reply.length > 8192) { socket.destroy(new Error('Ingress reply exceeds its bound')); return }
    let end: number
    while ((end = reply.indexOf('\n')) >= 0) {
      const line = reply.slice(0, end); reply = reply.slice(end + 1)
      const value: unknown = JSON.parse(line)
      if (!value || typeof value !== 'object' || 'error' in value) { socket.destroy(new Error('Gateway refused ingress delivery')); return }
      write(line); lines++
    }
    } catch { socket.destroy(new Error('Invalid ingress acknowledgement')) }
  })
  try {
    await once(socket, 'connect')
    const ended = once(socket, 'end')
    socket.write(command + '\n')
    await Promise.all([ended, pipeline(Readable.from(stdin), new Transform({ transform(chunk: Buffer, _encoding, done) {
      size += chunk.length
      done(size > (command === 'ingress' ? 64 * 1024 : 1024 * 1024) ? new Error('Ingress input exceeds its bound') : null, chunk)
    } }), socket)])
    if (reply || lines !== (command === 'ingress' ? 1 : size ? 2 : 1)) throw new Error('Ingress acknowledgement is incomplete')
  } finally { clearTimeout(timer); socket.destroy() }
}

export async function startIngressSocket(runtime: DiagnosticRuntime, path: string, domain: string, configured: boolean): Promise<{ close(): Promise<void> }> {
  try {
    if (!lstatSync(path).isSocket()) throw new Error('Ingress socket path contains a non-socket file')
    // The gateway is the only process with this private data directory. A live
    // listener is never silently replaced by a second gateway process.
    const probe = createConnection(path)
    const live = await new Promise<boolean>((resolve, reject) => {
      probe.once('connect', () => { probe.destroy(); resolve(true) })
      probe.once('error', (error: NodeJS.ErrnoException) => error.code === 'ECONNREFUSED' || error.code === 'ENOENT' ? resolve(false) : reject(error))
    })
    if (live) throw new Error('Ingress writer is already listening')
    try { unlinkSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  let active: Socket | null = null
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on('error', () => socket.destroy())
    const deadline = setTimeout(() => socket.destroy(new Error('Ingress connection exceeded 30 seconds')), 30_000)
    socket.once('close', () => clearTimeout(deadline))
    if (active) { socket.end('{"error":"Ingress writer is busy"}\n', () => socket.destroy()); return }
    active = socket
    void (async () => {
      // The default readable iterator destroys the duplex socket at input EOF,
      // before the committed transaction can send its acknowledgement.
      const iterator = socket.iterator({ destroyOnReturn: false })
      let bytes = Buffer.alloc(0), split = -1
      while (split < 0) {
        const initial = await iterator.next()
        if (initial.done || bytes.length + initial.value.length > 1024 * 1024 + 32) throw new Error('Invalid ingress command frame')
        bytes = Buffer.concat([bytes, initial.value])
        split = bytes.indexOf(10)
        if (split > 16 || split < 0 && bytes.length > 16) throw new Error('Invalid ingress command frame')
      }
      const command = bytes.subarray(0, split).toString('utf8')
      async function* input() {
        if (bytes.length > split + 1) yield bytes.subarray(split + 1)
        while (true) { const item = await iterator.next(); if (item.done) break; yield item.value as Buffer }
      }
      const write = (line: string) => { if (!socket.write(line + '\n')) throw new Error('Ingress client cannot consume its bounded reply') }
      if (command === 'ingress-stream') await receiveIngress(runtime.query((db) => db), domain, input(), write)
      else if (command === 'ingress') await receiveManualIngress(runtime.query((db) => db), domain, input(), write)
      else throw new Error('Unknown ingress command')
      socket.end(() => socket.destroy())
    })().catch(() => { if (!socket.destroyed) socket.end('{"error":"Ingress delivery rejected"}\n', () => socket.destroy()) }).finally(() => { active = null })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => {
    try { chmodSync(path, 0o600); runtime.ownCoverage('external-ingress', configured); resolve() }
    catch (error) { server.close(); reject(error) }
  }) })
  return { close: () => new Promise<void>((resolve, reject) => { active?.destroy(); server.close((error) => error ? reject(error) : resolve()) }) }
}

/** Diagnostics storage can fail without withholding login and workspace routing. */
export function maintainIngressSocket(runtime: DiagnosticRuntime, path: string, domain: string, configured: boolean, report: (error: unknown) => void): { close(): Promise<void> } {
  let listener: Awaited<ReturnType<typeof startIngressSocket>> | null = null
  let pending: Promise<void> | null = null, stopped = false, failed = false
  const attempt = () => {
    if (stopped || listener || pending) return
    pending = startIngressSocket(runtime, path, domain, configured).then(async (ready) => {
      if (stopped) { await ready.close(); return }
      listener = ready
      if (failed) runtime.observe('ingress-relay', 'collection', null)
    }).catch((error: unknown) => {
      failed = true
      runtime.observe('ingress-relay', 'collection', null, 'Private ingress relay is unavailable; operator diagnostics contain the cause')
      report(error)
    }).finally(() => { pending = null })
  }
  const timer = setInterval(attempt, 5000); timer.unref(); attempt()
  return { async close() { stopped = true; clearInterval(timer); await pending; await listener?.close() } }
}
