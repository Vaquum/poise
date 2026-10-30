import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createConnection, Socket } from 'node:net'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { maintainIngressSocket, startIngressSocket } from '../src/diagnostics/ingress-ipc.js'
import { DiagnosticRuntime } from '../src/diagnostics/runtime.js'
import { DiagnosticStore } from '../src/diagnostics/store.js'
import { executeLoggingRead } from '../src/diagnostics/query-worker.js'

const cleanups: Array<() => Promise<void>> = []
beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: resolve('.'), timeout: 15_000, stdio: 'pipe' })
  execFileSync(process.execPath, ['deploy/ingress/build.mjs'], { cwd: resolve('..'), timeout: 15_000, stdio: 'pipe' })
}, 30_000)
afterEach(async () => { for (const stop of cleanups.splice(0)) await stop() })
async function writer() {
  const directory = mkdtempSync(join(tmpdir(), 'poise-ingress-ipc-'))
  const path = join(directory, 'logging.db'), socket = join(directory, 'logging.ingress.sock')
  const runtime = new DiagnosticRuntime({ path, report: () => undefined })
  const server = await startIngressSocket(runtime, socket, 'poise.test', true)
  runtime.observe('gateway', 'gateway', null); runtime.start()
  cleanups.push(async () => { await server.close(); runtime.stop(); rmSync(directory, { recursive: true, force: true }) })
  return { directory, path, socket, runtime }
}
function cli(directory: string, command: string, payload: string | ((hello: Record<string, unknown>) => string)) {
  return new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/diagnostics/cli.js', command], { env: { ...process.env, POISE_GATEWAY_DATA: directory, POISE_DOMAIN: 'poise.test' }, stdio: ['pipe', 'pipe', 'pipe'] })
    const lines: Array<Record<string, unknown>> = []; let pending = '', error = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('Compiled ingress CLI stalled')) }, 10_000)
    child.stderr.on('data', (chunk: Buffer) => { error += chunk.toString() })
    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString()
      let end: number
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = JSON.parse(pending.slice(0, end)) as Record<string, unknown>; pending = pending.slice(end + 1); lines.push(line)
        if (lines.length === 1 && typeof payload === 'function') child.stdin.end(payload(line))
      }
    })
    child.on('error', reject)
    child.on('close', (code) => { clearTimeout(timer); if (code || pending) reject(new Error(error || 'Compiled CLI did not acknowledge')); else resolve(lines) })
    if (typeof payload === 'string') child.stdin.end(payload)
  })
}

it('runs the compiled operator command through one writer while gateway diagnostics continue', async () => {
  const w = await writer()
  expect(statSync(w.socket).mode & 0o777).toBe(0o600)
  let emitted = 0
  const concurrent = setInterval(() => { w.runtime.emit({ id: 'active-' + emitted++, source: 'gateway', operation: 'busy', level: 'error', message: 'concurrent retained cause' }); w.runtime.flush() }, 5)
  try {
    const lines = await cli(w.directory, 'ingress-stream', (hello) => JSON.stringify({ version: 1, challenge: hello.challenge, expected: hello.checkpoint,
      container: 'a'.repeat(64), from: new Date(Date.now() - 1000).toISOString(), until: new Date(Date.now() + 1000).toISOString(), state: 'complete', records: Array.from({ length: 100 }, (_, index) => ({ id: index.toString(16).padStart(64, '0'), time: new Date().toISOString(), log: { request: { host: 'alice.poise.test' }, level: 'error', msg: 'native batch cause' } })) }))
    expect(lines[1]).toMatchObject({ accepted: true, currentStatus: 'connected', events: 100 })
    expect(emitted).toBeGreaterThan(0)
    w.runtime.flush()
    expect(w.runtime.health()).toMatchObject({ error: null, dropped: 0, rejected: 0 })
    expect(w.runtime.health().sources.find((source) => source.id === 'external-ingress')).toMatchObject({ currentStatus: 'connected' })
    const journal = JSON.parse(readFileSync(w.path + '.coverage.json', 'utf8')) as { sources: Array<{ id: string }> }
    expect(journal.sources.some((source) => source.id === 'external-ingress')).toBe(false)
    const page = executeLoggingRead({ path: w.path, policy: w.runtime.health().policy, now: Date.now(), operation: 'health', access: { workspace: null, operator: true }, filter: {} })
    expect(JSON.parse(page.body).collection.sources.find((source: { id: string }) => source.id === 'external-ingress').currentStatus).toBe('connected')
  } finally { clearInterval(concurrent) }
})

it('preserves the legacy manual identity and refuses strict-host violations at the compiled boundary', async () => {
  const w = await writer()
  const text = JSON.stringify({ request: { host: 'alice.poise.test' }, ts: Date.now() / 1000, level: 'error', msg: 'native cause', request_id: 'same-request' })
  const first = await cli(w.directory, 'ingress', text), second = await cli(w.directory, 'ingress', text)
  expect(second[0].eventId).toBe(first[0].eventId)
  const db = new DiagnosticStore(w.path, undefined, Date.now, true)
  try { expect(db.query({ workspace: null, operator: true }).total).toBe(1); expect(db.query({ workspace: 'alice', operator: false }).total).toBe(0) }
  finally { db.close() }
  for (const host of ['admin.poise.test', 'nested.alice.poise.test', 'alice.poise.test:99999', 'poise.test.attacker.test']) {
    await expect(cli(w.directory, 'ingress', JSON.stringify({ request: { host }, level: 'error', msg: 'excluded' }))).rejects.toThrow()
  }
})


it('keeps diagnostics startup independent and reconnects after corrupt storage is repaired', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'poise-relay-retry-')), path = join(directory, 'logging.db')
  writeFileSync(path, 'broken SQLite storage')
  const runtime = new DiagnosticRuntime({ path, report: () => undefined }), errors: unknown[] = []
  const service = maintainIngressSocket(runtime, join(directory, 'logging.ingress.sock'), 'poise.test', false, (error) => errors.push(error))
  cleanups.push(async () => { await service.close(); runtime.stop(); rmSync(directory, { recursive: true, force: true }) })
  await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0))
  expect(runtime.health().sources.find((source) => source.id === 'ingress-relay')?.currentStatus).toBe('unavailable')
  rmSync(path)
  await vi.waitFor(() => expect(runtime.health().sources.find((source) => source.id === 'ingress-relay')?.currentStatus).toBe('connected'), { timeout: 7000 })
  expect((await cli(directory, 'ingress', JSON.stringify({ request: { host: 'poise.test' }, level: 'error', msg: 'repaired source' })))[0].accepted).toBe(true)
})

it('handles a write error on a refused second client while the first transaction remains usable', async () => {
  const w = await writer(), first = createConnection(w.socket)
  first.on('error', () => first.destroy())
  await once(first, 'connect'); first.write('ingress-stream\n')
  const hello = JSON.parse(String((await once(first, 'data'))[0])) as Record<string, unknown>
  const end = Socket.prototype.end
  let injected = false
  const fault = vi.spyOn(Socket.prototype, 'end').mockImplementation(function(this: Socket, ...args: unknown[]) {
    const result: Socket = Reflect.apply(end, this, args)
    if (args[0] === '{"error":"Ingress writer is busy"}\n') {
      injected = true
      queueMicrotask(() => this.emit('error', Object.assign(new Error('Disconnected refused client'), { code: 'EPIPE' })))
    }
    return result
  })
  const second = createConnection(w.socket); second.on('error', () => second.destroy())
  try {
    await vi.waitFor(() => expect(injected).toBe(true))
    fault.mockRestore()
    const ack = once(first, 'data')
    first.end(JSON.stringify({ version: 1, challenge: hello.challenge, expected: hello.checkpoint, container: 'b'.repeat(64), from: new Date(Date.now() - 1000).toISOString(), until: new Date().toISOString(), state: 'complete', records: [] }))
    expect(JSON.parse(String((await ack)[0])).accepted).toBe(true)
  } finally { fault.mockRestore(); first.destroy(); second.destroy() }
})

it('closes refused half-open clients without waiting for their input EOF', async () => {
  const w = await writer(), first = createConnection(w.socket)
  first.on('error', () => first.destroy())
  await once(first, 'connect'); first.write('ingress-stream\n')
  await once(first, 'data')
  const end = Socket.prototype.end
  const refused: Socket[] = []
  const observed = vi.spyOn(Socket.prototype, 'end').mockImplementation(function(this: Socket, ...args: unknown[]) {
    if (args[0] === '{"error":"Ingress writer is busy"}\n') refused.push(this)
    return Reflect.apply(end, this, args)
  })
  const clients = Array.from({ length: 8 }, () => {
    const client = createConnection({ path: w.socket, allowHalfOpen: true })
    client.on('error', () => client.destroy()); client.resume()
    return client
  })
  try {
    await vi.waitFor(() => {
      expect(refused).toHaveLength(clients.length)
      expect(refused.every((socket) => socket.destroyed)).toBe(true)
    })
    expect(first.destroyed).toBe(false)
  } finally { observed.mockRestore(); first.destroy(); for (const client of clients) client.destroy() }
})

it('preserves an edge message until canonical normalization can mark its truncation', async () => {
  const w = await writer()
  const records = JSON.parse(execFileSync(process.execPath, [resolve('../test-results/ingress/projection.cjs'), 'poise.test'], {
    input: JSON.stringify([{ id: 'c'.repeat(64), time: new Date().toISOString(), log: { request: { host: 'poise.test' }, level: 'error', msg: 'x'.repeat(3000) } }]), encoding: 'utf8', timeout: 3000,
  })) as unknown[]
  await cli(w.directory, 'ingress-stream', (hello) => JSON.stringify({ version: 1, challenge: hello.challenge, expected: hello.checkpoint, container: 'c'.repeat(64), from: new Date(Date.now() - 5000).toISOString(), until: new Date().toISOString(), state: 'complete', records }))
  const db = new DiagnosticStore(w.path, undefined, Date.now, true)
  try { expect(db.query({ workspace: null, operator: true }).events[0]).toMatchObject({ truncated: true }) }
  finally { db.close() }
})
