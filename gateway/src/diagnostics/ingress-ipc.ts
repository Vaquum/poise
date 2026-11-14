import { chmodSync, lstatSync, unlinkSync } from 'node:fs'
import { createConnection, createServer, type Socket } from 'node:net'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { environmentSecrets, redact } from './contract.js'
import { receiveIngress, receiveManualIngress } from './ingress.js'
import { receiveDeployment } from './deployment.js'
import type { DiagnosticRuntime } from './runtime.js'

/** A forced-command process relays bytes; only the gateway owns a writable store. */
export async function relayIngress(path: string, command: 'ingress' | 'ingress-stream' | 'deployment', stdin: AsyncIterable<Buffer | string>, write: (line: string) => void): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('Ingress relay exceeded 30 seconds')), 30_000)
  try {
    let frame: Buffer | null = null
    if (command === 'deployment') {
      // The CLI supplies a one-shot generator, including the observation header.
      const chunks: Buffer[] = []; let size = 0
      const expired = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
      })
      await Promise.race([pipeline(Readable.from(stdin), async (source) => {
        for await (const chunk of source) {
          const bytes = Buffer.from(chunk)
          size += bytes.length
          if (size > 64 * 1024) throw new Error('Ingress input exceeds its bound')
          chunks.push(bytes)
        }
      }, { signal: controller.signal }), expired])
      frame = Buffer.concat([Buffer.from(command + '\n'), ...chunks])
    }
    for (let attempt = 0; ; attempt++) {
      const socket = createConnection({ path, signal: controller.signal })
      let reply = '', size = 0, lines = 0, busy = false
      let refusal: Error | null = null
      socket.on('data', (chunk: Buffer) => {
        try {
          reply += chunk.toString('utf8')
          if (reply.length > 8192) { socket.destroy(new Error('Ingress reply exceeds its bound')); return }
          let end: number
          while ((end = reply.indexOf('\n')) >= 0) {
            const line = reply.slice(0, end); reply = reply.slice(end + 1)
            const value: unknown = JSON.parse(line)
            if (refusal || !value || typeof value !== 'object') { socket.destroy(new Error('Invalid ingress acknowledgement')); return }
            if ('error' in value) {
              const cause = typeof value.error === 'string' ? redact(value.error, environmentSecrets()).slice(0, 512) : 'Invalid ingress refusal'
              const error = new Error('Gateway refused ingress delivery: ' + cause)
              if (command === 'deployment' && lines === 0 && Object.keys(value).length === 1 && value.error === 'Ingress writer is busy') {
                refusal = error; continue
              }
              socket.destroy(error); return
            }
            write(line); lines++
          }
        } catch { socket.destroy(new Error('Invalid ingress acknowledgement')) }
      })
      try {
        await once(socket, 'connect')
        const ended = once(socket, 'end')
        if (frame) {
          socket.end(frame)
          await ended
        } else {
          socket.write(command + '\n')
          await Promise.all([ended, pipeline(Readable.from(stdin), new Transform({ transform(chunk: Buffer, _encoding, done) {
            size += chunk.length
            done(size > (command === 'ingress-stream' ? 1024 * 1024 : 64 * 1024) ? new Error('Ingress input exceeds its bound') : null, chunk)
          } }), socket, { signal: controller.signal })])
        }
        if (refusal && !reply) { busy = true; throw refusal }
        if (reply || lines !== (command === 'ingress-stream' && size ? 2 : 1)) throw new Error('Ingress acknowledgement is incomplete')
        return
      } catch (error) {
        if (!busy || attempt >= 4 || controller.signal.aborted) throw error
      } finally { socket.destroy() }
      await delay(250 * 2 ** attempt, undefined, { signal: controller.signal })
    }
  } catch (error) { throw controller.signal.aborted ? controller.signal.reason : error }
  finally { clearTimeout(timer) }
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
  const refused = new Set<Socket>()
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on('error', () => socket.destroy())
    const deadline = setTimeout(() => socket.destroy(new Error('Ingress connection exceeded 30 seconds')), 30_000)
    socket.once('close', () => clearTimeout(deadline))
    if (active) {
      refused.add(socket); socket.once('close', () => refused.delete(socket))
      // Closing the read side here can turn the client's write into EPIPE and
      // discard our unread refusal. Drain until its EOF or the existing deadline.
      socket.resume(); socket.end('{"error":"Ingress writer is busy"}\n'); return
    }
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
      else if (command === 'deployment') await receiveDeployment(runtime.query((db) => db), input(), write)
      else throw new Error('Unknown ingress command')
      socket.end(() => socket.destroy())
    })().catch((error: unknown) => {
      const cause = redact(error instanceof Error ? error.message : 'Unknown ingress failure', environmentSecrets()).slice(0, 512)
      if (!socket.destroyed) socket.end(JSON.stringify({ error: 'Ingress delivery rejected: ' + cause }) + '\n', () => socket.destroy())
    }).finally(() => { active = null })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => {
    try { chmodSync(path, 0o600); runtime.ownCoverage('external-ingress', configured); resolve() }
    catch (error) { server.close(); reject(error) }
  }) })
  return { close: () => new Promise<void>((resolve, reject) => { active?.destroy(); for (const socket of refused) socket.destroy(); server.close((error) => error ? reject(error) : resolve()) }) }
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
