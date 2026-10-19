import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Context } from '../src/context.js'
import { DockerClient } from '../src/docker.js'
import { EnvironmentCollectors } from '../src/diagnostics/collectors.js'
import { normalize } from '../src/diagnostics/contract.js'
import { DiagnosticCursorError, DiagnosticStore } from '../src/diagnostics/store.js'
import { DiagnosticRuntime } from '../src/diagnostics/runtime.js'
import { startHarness, verifyAssertion } from './harness.js'
import { diagnosticDeliveryPage } from '../src/diagnostics/workspace-delivery.js'

it('resumes authenticated bounded backfill after source recreation without resetting on authentication failure', async () => {
  const h = await startHarness(); await h.openWorkspace('alice')
  const directory = mkdtempSync(join(tmpdir(), 'poise-workspace-recovery-'))
  const sourcePath = join(directory, 'source.db')
  let source = new DiagnosticStore(sourcePath)
  const event = (id: string) => normalize({ id, source: 'poise', level: 'error', workspace: 'alice', operation: 'fixture.failure', message: id })!
  const first = event('before-recreation'); source.append([first])
  let unauthorized = false
  const assertions: string[] = []
  const server = http.createServer((req, res) => {
    assertions.push(String(req.headers['x-poise-identity']))
    if (unauthorized) { res.writeHead(401); res.end('{}'); return }
    try {
      const page = source.delivery({ workspace: 'alice', operator: false }, new URL(req.url!, 'http://workspace').searchParams.get('cursor'))
      res.end(JSON.stringify({ ...page, coverage: { status: 'connected' } }))
    } catch (error) {
      res.writeHead(error instanceof DiagnosticCursorError ? 409 : 503)
      res.end(JSON.stringify({ error: error instanceof DiagnosticCursorError ? 'diagnostic_cursor_invalid' : 'unavailable' }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const docker = new DockerClient('/unused-fixture-socket')
  vi.spyOn(docker, 'diagnosticContainers').mockResolvedValue([])
  vi.spyOn(docker, 'diagnosticRead').mockResolvedValue(Buffer.alloc(0))
  const ctx = new Context({ ...h.context.deps, docker, upstream: () => ({ host: '127.0.0.1', port: (server.address() as AddressInfo).port }) })
  const runtime = new DiagnosticRuntime({ path: join(directory, 'central.db'), report: () => undefined })
  const collector = new EnvironmentCollectors(runtime, docker, ctx)
  const cursor = () => runtime.query((db) => db.checkpoint('workspace:alice'))
  try {
    collector.start()
    await vi.waitFor(() => expect(cursor()).not.toBeNull())
    await collector.stop()
    expect(runtime.health().sources.find((row) => row.id === 'workspace:alice')?.ingestedAt).toEqual(expect.any(String))
    expect(runtime.query((db) => db.readCoverage({ workspace: 'alice', operator: false })).find((row) => row.id === 'workspace:alice')?.ingestedAt).toEqual(expect.any(String))
    const original = cursor()
    source.close(); rmSync(sourcePath); source = new DiagnosticStore(sourcePath)
    const second = event('after-recreation'); source.append([second])
    unauthorized = true; collector.start()
    await vi.waitFor(() => expect(runtime.health().sources.some((row) => row.error?.includes('HTTP 401'))).toBe(true))
    await collector.stop(); expect(cursor()).toBe(original)
    unauthorized = false; collector.start()
    await vi.waitFor(() => expect(cursor()).toBeNull())
    await collector.stop(); collector.start()
    await vi.waitFor(() => expect(runtime.query((db) => db.lookup({ workspace: 'alice', operator: false }, second.id)).status).toBe('found'))
    await collector.stop()
    expect(runtime.query((db) => db.lookup({ workspace: 'alice', operator: false }, first.id)).status).toBe('found')
    expect(runtime.health().sources.find((row) => row.id === 'workspace:alice')?.gaps.length).toBeGreaterThan(0)
    for (const token of assertions) expect(verifyAssertion(token, h.keys.publicKeyBase64)).toMatchObject({ scope: 'admin', sub: 'Alice', aud: 'workspace:alice' })
  } finally {
    await collector.stop(); runtime.stop(); source.close(); ctx.agent.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await h.close(); rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks()
  }
})

it('lets later workspaces and subsequent Docker passes progress when a source trickles bytes', async () => {
  const h = await startHarness(); await h.openWorkspace('alice'); await h.openWorkspace('bob')
  const directory = mkdtempSync(join(tmpdir(), 'poise-workspace-deadline-'))
  const event = normalize({ id: 'later-workspace', source: 'poise', level: 'error', workspace: 'bob', operation: 'fixture.failure', message: 'later workspace cause' })!
  const heldResponses = new Set<http.ServerResponse>()
  const server = http.createServer((req, res) => {
    if (req.headers.host?.startsWith('alice.')) {
      heldResponses.add(res)
      res.writeHead(200); res.write(' ')
      const trickle = setInterval(() => res.write(' '), 10)
      // Only the collector deadline can release this source during the proof.
      res.once('close', () => { clearInterval(trickle); heldResponses.delete(res) })
    } else res.end(JSON.stringify({ version: 1, events: [event], cursor: 'fixture-bob-cursor', coverage: { status: 'connected' } }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const docker = new DockerClient('/unused-fixture-socket')
  const discovery = vi.spyOn(docker, 'diagnosticContainers').mockResolvedValue([])
  vi.spyOn(docker, 'diagnosticRead').mockResolvedValue(Buffer.alloc(0))
  const ctx = new Context({ ...h.context.deps, docker, upstream: () => ({ host: '127.0.0.1', port: (server.address() as AddressInfo).port }) })
  const runtime = new DiagnosticRuntime({ path: join(directory, 'central.db'), report: () => undefined })
  const collector = new EnvironmentCollectors(runtime, docker, ctx, 120)
  try {
    collector.start()
    await vi.waitFor(() => expect(runtime.query((db) => db.lookup({ workspace: 'bob', operator: false }, event.id)).status).toBe('found'), { timeout: 2500 })
    expect(runtime.health().sources.find((row) => row.id === 'workspace:alice')?.error).toContain('absolute deadline')
    await vi.waitFor(() => expect(heldResponses.size).toBe(0))
    await collector.stop(); collector.start()
    await vi.waitFor(() => expect(discovery.mock.calls.length).toBeGreaterThanOrEqual(2))
  } finally {
    for (const response of heldResponses) response.destroy()
    await collector.stop(); runtime.stop(); ctx.agent.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await h.close(); rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks()
  }
})

it('applies an absolute Docker read deadline despite continued response activity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'poise-docker-deadline-')); const socket = join(directory, 'engine.sock')
  const server = http.createServer((_req, res) => {
    res.writeHead(200); res.write(' ')
    const trickle = setInterval(() => res.write(' '), 10)
    const finish = setTimeout(() => res.end('done'), 1000)
    res.once('close', () => { clearInterval(trickle); clearTimeout(finish) })
  })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  try {
    const client = new DockerClient(socket)
    await expect(client.diagnosticRead('/events?until=1', 1000, 80)).rejects.toThrow('absolute deadline')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  }
})

it('excludes ordinary workspace output without false outages while retaining malformed diagnostic failures', async () => {
  const h = await startHarness()
  const directory = mkdtempSync(join(tmpdir(), 'poise-ordinary-output-'))
  const docker = new DockerClient('/unused-fixture-socket')
  vi.spyOn(docker, 'diagnosticContainers').mockResolvedValue([{ Id: 'ordinary-output', ImageID: 'sha256:fixture', Names: [], State: 'running', Labels: { 'poise.managed': 'true', 'poise.workspace': 'alice' } }])
  const event = normalize({ id: 'actual-warning', source: 'poise', level: 'warning', workspace: 'alice', operation: 'fixture.warning', message: 'Actual diagnostic' })!
  const frame = (line: string) => {
    const body = Buffer.from(new Date().toISOString() + ' ' + line + '\n')
    const header = Buffer.alloc(8); header[0] = 2; header.writeUInt32BE(body.length, 4)
    return Buffer.concat([header, body])
  }
  let malformed = false
  vi.spyOn(docker, 'diagnosticRead').mockImplementation(async (path) => path.startsWith('/events') ? Buffer.alloc(0)
    : malformed ? frame('{"poiseDiagnostic":null}')
      : Buffer.concat([frame('Listening on port 5555'), frame('{"result":"private user output"}'), frame(JSON.stringify({ poiseDiagnostic: event }))]))
  const runtime = new DiagnosticRuntime({ path: join(directory, 'central.db'), report: () => undefined })
  const collector = new EnvironmentCollectors(runtime, docker, h.context)
  try {
    collector.start()
    await vi.waitFor(() => expect(runtime.health().sources.find((source) => source.id === 'workspace-stream:alice')).toMatchObject({ status: 'connected', currentStatus: 'connected', gaps: [] }))
    await collector.stop()
    const records = () => runtime.query((db) => db.query({ workspace: 'alice', operator: false })).events
    expect(records()).toHaveLength(1)
    expect(records()[0].id).toBe(event.id)
    expect(JSON.stringify(records())).not.toContain('private user output')
    malformed = true; collector.start()
    await vi.waitFor(() => expect(runtime.health().sources.find((source) => source.id === 'workspace-stream:alice')?.currentStatus).toBe('unavailable'))
    await collector.stop()
    expect(records().some((event) => event.operation === 'workspace.envelope_rejected')).toBe(true)
    malformed = false; collector.start()
    await vi.waitFor(() => expect(runtime.health().sources.find((source) => source.id === 'workspace-stream:alice')?.currentStatus).toBe('connected'))
    await collector.stop()
    const source = runtime.health().sources.find((source) => source.id === 'workspace-stream:alice')!
    expect(source.status).toBe('partial')
    expect(source.gaps).toHaveLength(1)
    expect(source.gaps[0].to).not.toBeNull()
  } finally { await collector.stop(); runtime.stop(); await h.close(); rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks() }
})

it('aggregates real container failures independently of order and keeps ordinary stdout outside the diagnostic window', async () => {
  const h = await startHarness(), directory = mkdtempSync(join(tmpdir(), 'poise-stream-order-'))
  const docker = new DockerClient('/unused-fixture-socket')
  const container = (Id: string, task = false) => {
    const Labels: Record<string, string> = { 'poise.managed': 'true', 'poise.workspace': 'alice' }
    if (task) Labels['poise.task'] = 'install-release'
    return { Id, ImageID: 'sha256:fixture', Names: [], State: 'running', Labels }
  }
  const failed = container('failed-workspace'), quiet = container('quiet-replacement'), task = container('quiet-install-task', true)
  const discovery = vi.spyOn(docker, 'diagnosticContainers').mockResolvedValue([failed, quiet, task])
  const evidence = normalize({ id: 'stderr-evidence', source: 'poise', workspace: 'alice', level: 'error', operation: 'fixture', message: 'actual retained stderr cause' })!
  const frame = (text: string, stream = 2) => { const body = Buffer.from(new Date().toISOString() + ' ' + text + '\n'), header = Buffer.alloc(8); header[0] = stream; header.writeUInt32BE(body.length, 4); return Buffer.concat([header, body]) }
  let unavailable = true
  const reads: string[] = []
  vi.spyOn(docker, 'diagnosticRead').mockImplementation(async (path) => {
    if (path.startsWith('/events')) return Buffer.alloc(0)
    reads.push(path)
    if (path.includes('/failed-workspace/') && unavailable) throw new Error('actual workspace log transport failure')
    if (new URL(path, 'http://engine').searchParams.get('stdout') === '1') return Buffer.concat(Array.from({ length: 2000 }, () => frame('ordinary stdout', 1)))
    return path.includes('/failed-workspace/') ? frame(JSON.stringify({ poiseDiagnostic: evidence })) : Buffer.alloc(0)
  })
  const runtime = new DiagnosticRuntime({ path: join(directory, 'central.db'), report: () => undefined })
  const observed = vi.spyOn(runtime, 'observe')
  const collector = new EnvironmentCollectors(runtime, docker, h.context)
  const passes = () => observed.mock.calls.filter(([id]) => id === 'workspace-stream:alice').length
  try {
    for (const [index, order] of [[failed, quiet, task], [task, quiet, failed]].entries()) {
      discovery.mockResolvedValue(order); collector.start()
      await vi.waitFor(() => expect(passes()).toBe(index + 1)); await collector.stop()
      expect(runtime.health().sources.find((source) => source.id === 'workspace-stream:alice')).toMatchObject({ currentStatus: 'unavailable', error: expect.stringContaining('actual workspace log transport failure') })
    }
    unavailable = false; collector.start()
    await vi.waitFor(() => expect(passes()).toBe(3)); await collector.stop()
    expect(runtime.health().sources.find((source) => source.id === 'workspace-stream:alice')).toMatchObject({ currentStatus: 'connected', status: 'partial', gaps: [expect.objectContaining({ to: expect.any(String) })] })
    expect(runtime.query((db) => db.lookup({ workspace: 'alice', operator: false }, evidence.id)).status).toBe('found')
    expect(reads.every((path) => path.includes('stdout=0') && !path.includes('tail=') && !path.includes('quiet-install-task'))).toBe(true)
  } finally { await collector.stop(); runtime.stop(); await h.close(); rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks() }
})

it('preserves recovered upstream history through the production maintenance projection and actual authenticated collector', async () => {
  const h = await startHarness(); await h.openWorkspace('alice')
  const directory = mkdtempSync(join(tmpdir(), 'poise-upstream-history-'))
  const source = new DiagnosticRuntime({ path: join(directory, 'workspace.db'), workspace: 'alice', report: () => undefined })
  source.observe('application', 'poise', 'alice', 'actual local application capture failure')
  source.observe('application', 'poise', 'alice'); source.flush()
  const server = http.createServer((req, res) => {
    const cursor = new URL(req.url!, 'http://workspace').searchParams.get('cursor')
    res.end(JSON.stringify(diagnosticDeliveryPage(source, 'alice', cursor)))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const docker = new DockerClient('/unused-fixture-socket')
  vi.spyOn(docker, 'diagnosticContainers').mockResolvedValue([])
  vi.spyOn(docker, 'diagnosticRead').mockResolvedValue(Buffer.alloc(0))
  const context = new Context({ ...h.context.deps, docker, upstream: () => ({ host: '127.0.0.1', port: (server.address() as AddressInfo).port }) })
  const path = join(directory, 'central.db'), central = new DiagnosticRuntime({ path, report: () => undefined })
  const collector = new EnvironmentCollectors(central, docker, context)
  try {
    expect(diagnosticDeliveryPage(source, 'alice', null).coverage).toMatchObject({ status: 'partial', currentStatus: 'connected', historyIncomplete: true })
    collector.start()
    await vi.waitFor(() => expect(central.health().sources.find((row) => row.id === 'workspace:alice')).toMatchObject({ status: 'partial', currentStatus: 'connected', historyIncomplete: true }))
    await collector.stop(); central.flush()
    const coverage = central.query((db) => db.readCoverage({ workspace: 'alice', operator: false })).find((row) => row.id === 'workspace:alice')!
    expect(coverage.gaps).toEqual([expect.objectContaining({ to: expect.any(String), reason: 'poise: actual local application capture failure' })])
    expect(central.query((db) => db.query({ workspace: 'alice', operator: false })).events.some((event) => event.message === 'actual local application capture failure')).toBe(true)
    source.stop()
    const reader = new DiagnosticStore(path, undefined, Date.now, true)
    try { expect(reader.readCoverage({ workspace: 'alice', operator: false }).find((row) => row.id === coverage.id)).toEqual(coverage) }
    finally { reader.close() }
  } finally {
    await collector.stop(); source.stop(); central.stop(); context.agent.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve())); await h.close()
    rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks()
  }
})

it('carries live upstream loss through authenticated delivery, recovery and legacy observations', async () => {
  const h = await startHarness(); await h.openWorkspace('alice')
  const directory = mkdtempSync(join(tmpdir(), 'poise-upstream-loss-')), path = join(directory, 'central.db')
  const source = new DiagnosticStore(join(directory, 'source.db'))
  const coverage: { status: string; currentStatus: string; dropped: number; rejected: number; lossActive?: boolean } = {
    status: 'partial', currentStatus: 'partial', dropped: 3, rejected: 0, lossActive: true,
  }
  const server = http.createServer((req, res) => {
    const cursor = new URL(req.url!, 'http://workspace').searchParams.get('cursor')
    res.end(JSON.stringify({ ...source.delivery({ workspace: 'alice', operator: false }, cursor), coverage }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const docker = new DockerClient('/unused-fixture-socket')
  vi.spyOn(docker, 'diagnosticContainers').mockResolvedValue([]); vi.spyOn(docker, 'diagnosticRead').mockResolvedValue(Buffer.alloc(0))
  const context = new Context({ ...h.context.deps, docker, upstream: () => ({ host: '127.0.0.1', port: (server.address() as AddressInfo).port }) })
  const runtime = new DiagnosticRuntime({ path, report: () => undefined }), collector = new EnvironmentCollectors(runtime, docker, context)
  const observed = () => runtime.health().sources.find((row) => row.id === 'workspace:alice')
  const read = async () => {
    const { executeLoggingRead } = await import('../src/diagnostics/query-worker.js')
    return JSON.parse(executeLoggingRead({ path, policy: runtime.health().policy, now: Date.now(), access: { workspace: 'alice', operator: false }, operation: 'health', filter: {} }).body)
  }
  try {
    collector.start(); await vi.waitFor(() => expect(observed()).toMatchObject({ lossActive: true, dropped: 3 })); await collector.stop(); runtime.flush()
    expect(runtime.health()).toMatchObject({ lossActive: true, dropped: 0, rejected: 0 })
    expect((await read()).collection.lossActive).toBe(true)
    coverage.lossActive = false; coverage.currentStatus = 'connected'
    collector.start(); await vi.waitFor(() => expect(observed()).toMatchObject({ lossActive: false, currentStatus: 'connected', dropped: 3 })); await collector.stop(); runtime.flush()
    expect((await read()).collection).toMatchObject({ lossActive: false, lossObserved: true })
    delete coverage.lossActive
    collector.start(); await vi.waitFor(() => expect(observed()?.currentStatus).toBe('initializing')); await collector.stop(); runtime.flush()
    expect((await read()).collection.lossActive).toBeUndefined()
  } finally {
    await collector.stop(); runtime.stop(); source.close(); context.agent.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve())); await h.close(); rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks()
  }
})
