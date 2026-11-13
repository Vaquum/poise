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
import type { LoggingPage } from '../src/diagnostics/query-contract.js'

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
function cli(directory: string, command: string | string[], payload: string | ((hello: Record<string, unknown>) => string)) {
  return new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/diagnostics/cli.js', ...(typeof command === 'string' ? [command] : command)], { env: { ...process.env, POISE_GATEWAY_DATA: directory, POISE_DOMAIN: 'poise.test' }, stdio: ['pipe', 'pipe', 'pipe'] })
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

it('retains one replacement deadline Error per rollout and workspace through fresh verifier processes', async () => {
  const w = await writer(), requested = 'a'.repeat(40), serving = 'b'.repeat(40)
  const rollout = requested + '.FIRST1', later = requested + '.SECOND', at = Date.now() - 60_000
  const health = { ok: true, version: serving, release: serving, draining: true, desiredRelease: serving, pendingSince: null,
    activeChatTurns: 0, runningCallerCalls: 2, backgroundWork: 0, unsettledNativeCalls: null, switchWaitingOn: null,
    environment: { SECRET: 'excluded' } }
  const observe = (id: string, workspace: string, seconds: number, budget: number, elapsed: number, snapshot: unknown, complete = false) =>
    cli(w.directory, ['deployment', id, workspace, String(budget), String(elapsed), new Date(at + seconds * 1000).toISOString(), String(complete)], JSON.stringify(snapshot))
  const read = (workspace: string | null = null, operator = true) => {
    const reply = executeLoggingRead({ path: w.path, policy: w.runtime.health().policy, now: Date.now(), operation: 'list', access: { workspace, operator }, filter: {} })
    expect(reply.status).toBe(200)
    return JSON.parse(reply.body) as LoggingPage
  }
  expect((await observe(rollout, 'alice', 0, 600, 599, health))[0].events).toBe(0)
  expect((await observe(rollout, 'alice', 1, 0, 0, health))[0].events).toBe(0)
  expect((await observe(rollout, 'alice', 1, 600, 600, { ...health, release: requested, version: requested }))[0].events).toBe(0)
  expect(read().total).toBe(0)
  await observe(rollout, 'alice', 2, 600, 604, health)
  const first = read().events[0]
  expect(first).toMatchObject({ severity: 'error', operation: 'workspace.deployment.pause', phase: 'deadline', release: requested,
    target: rollout, workspace: 'alice', timeoutMs: 600_000, occurrences: 1,
    context: { rollout, requestedRevision: requested, servingRevision: serving, budget: 'deployment-verifier', budgetSeconds: 600,
      elapsedSeconds: 604, admissionState: 'drained', blocker: 'runningCallerCalls', nextRetry: null,
      health: { desiredRelease: serving, pendingSince: null, runningCallerCalls: 2, unsettledNativeCalls: null } } })
  expect(JSON.stringify(first)).not.toContain('SECRET')
  await observe(rollout, 'alice', 3, 600, 900, { ...health, runningCallerCalls: 1 })
  await observe(rollout, 'alice', 1, 600, 605, health)
  await observe(rollout, 'alice', 4, 0, 0, null)
  await observe(rollout, 'alice', 5, 0, 0, health) // A resume attempt is not proof.
  expect(read().events).toEqual([first])
  expect(read('alice', false).events).toEqual([first])
  expect(read('bob', false).total).toBe(0)
  // Another rollout of the same SHA and another workspace have independent identities.
  await observe(later, 'alice', 6, 600, 600, health)
  await observe(rollout, 'bob', 6, 600, 600, health)
  await observe(later, 'alice', 7, 0, 0, { ...health, draining: false, release: requested, version: requested }, true)
  expect(read().events.filter((event) => event.target === rollout && event.workspace === 'alice')).toEqual([first])
  await observe(rollout, 'alice', 8, 0, 0, { ...health, draining: false })
  const recovered = read().events.find((event) => event.target === rollout && event.workspace === 'alice' && event.phase === 'recovered')
  expect(recovered).toMatchObject({ severity: 'warning', incidentId: first.incidentId, context: { recovery: 'admissions_restored', admissionState: 'open' } })
  // Neither delayed evidence nor a later drained snapshot reopens this pause.
  await observe(rollout, 'alice', 7, 600, 1200, health)
  await observe(rollout, 'alice', 9, 600, 1200, health)
  expect(read().events.filter((event) => event.severity === 'error')).toHaveLength(3)
  expect(read().events.find((event) => event.id === first.id)).toEqual({ ...first, occurrences: 2 })
})

it('keeps completed pauses closed and rejects malformed deployment evidence at the private boundary', async () => {
  const w = await writer(), rollout = 'a'.repeat(40) + '.DONE01', at = Date.now() - 1000
  const args = ['deployment', rollout, 'alice', '0', '0', new Date(at).toISOString(), 'true']
  await cli(w.directory, args, 'null') // The verifier proved the stopped image.
  await cli(w.directory, ['deployment', rollout, 'alice', '600', '600', new Date(at - 1).toISOString(), 'false'], '{"ok":true,"draining":true}')
  await cli(w.directory, ['deployment', rollout, 'alice', '600', '600', new Date(at + 1).toISOString(), 'false'], '{"ok":true,"draining":true}')
  const db = new DiagnosticStore(w.path, undefined, Date.now, true)
  try { expect(db.query({ workspace: null, operator: true }).total).toBe(0) }
  finally { db.close() }
  for (const invalid of [['deployment', 'invalid', ...args.slice(2)], [...args.slice(0, 3), '-1', ...args.slice(4)]]) {
    await expect(cli(w.directory, invalid, 'null')).rejects.toThrow()
  }
  await expect(cli(w.directory, args, 'x'.repeat(64 * 1024))).rejects.toThrow()
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
