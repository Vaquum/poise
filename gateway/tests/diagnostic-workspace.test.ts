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
