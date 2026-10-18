import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DockerClient, type TaskSpec } from '../src/docker.js'
import { observeReleaseTask } from '../src/diagnostics/collectors.js'
import { DiagnosticRuntime } from '../src/diagnostics/runtime.js'
import { DiagnosticStore } from '../src/diagnostics/store.js'

const directories: string[] = []
const servers: http.Server[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})
const spec: TaskSpec = { Image: 'fixture', User: '10001', Entrypoint: ['installer'], Cmd: [], Env: [],
  Labels: { 'poise.task': 'install-release', 'poise.workspace': 'logproof' },
  HostConfig: { SecurityOpt: ['no-new-privileges'], CapDrop: ['ALL'], Memory: 64 * 1024 * 1024, NanoCpus: 1_000_000_000, PidsLimit: 64, Mounts: [], NetworkMode: 'none' } }

async function engine(mode: 'timeout' | 'http' | 'malformed' | 'logs' | 'start' | 'tail', lineCount = 2) {
  const directory = mkdtempSync(join(tmpdir(), 'poise-task-')); directories.push(directory)
  const socket = join(directory, 'docker.sock'); const events: string[] = []; let created = false; let removed = false
  const server = http.createServer((req, res) => {
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (req.method === 'DELETE') { if (created) { removed = true; events.push('remove') }; return json(204, {}) }
    if (req.url?.startsWith('/containers/create')) { created = true; removed = false; events.push('create'); return json(201, { Id: 'native-task-id' }) }
    if (req.url?.endsWith('/start')) { events.push('start'); return mode === 'start' ? json(503, { message: 'fixture start failed' }) : json(204, {}) }
    if (req.url?.endsWith('/wait')) {
      events.push('wait')
      if (mode === 'timeout') return
      return mode === 'tail' ? json(200, { StatusCode: 17 }) : mode === 'malformed' ? json(200, {}) : json(503, { message: 'fixture wait failed' })
    }
    if (req.url?.startsWith('/containers/native-task-id/logs?')) {
      events.push('logs'); expect(removed).toBe(false)
      const params = new URL(req.url, 'http://docker').searchParams
      expect(params.get('stdout')).toBe('0'); expect(params.get('stderr')).toBe('1')
      expect(params.get('tail')).toBe('all')
      if (mode === 'logs' || mode === 'start') return json(503, { message: 'fixture logs unavailable' })
      const body = Buffer.from(mode === 'tail' ? Array.from({ length: lineCount }, (_, index) => '2026-10-18T00:00:00.000Z ' + (index ? 'x' : 'initial failure cause')).join('\n') + '\n'
        : '2026-10-18T00:00:00.000Z fatal: exact installer cause\n2026-10-18T00:00:00.000Z {"access_token":"opaque-task-credential"}\n')
      const frame = Buffer.alloc(8); frame[0] = 2; frame.writeUInt32BE(body.length, 4)
      res.end(Buffer.concat([frame, body])); return
    }
    json(404, { message: 'unexpected fixture route' })
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve) })
  return { directory, socket, events, removed: () => removed }
}

it.each(['timeout', 'http', 'malformed', 'logs', 'start'] as const)('retains release evidence before cleanup after a %s control failure', async (mode) => {
  const fixture = await engine(mode)
  const path = join(fixture.directory, 'logging.db')
  const runtime = new DiagnosticRuntime({ path, secrets: [], report: () => undefined })
  const client = new DockerClient(fixture.socket, (evidence) => {
    fixture.events.push('capture'); expect(fixture.removed()).toBe(false)
    observeReleaseTask(runtime, evidence)
  }, mode === 'timeout' ? 80 : 1000)
  try {
    await expect(client.runTask('release-proof', spec)).rejects.toThrow(mode === 'timeout' ? 'timed out' : mode === 'malformed' ? 'no valid exit status' : mode === 'start' ? 'fixture start failed' : 'fixture wait failed')
    expect(fixture.removed()).toBe(true)
    expect(fixture.events.indexOf('logs')).toBeLessThan(fixture.events.indexOf('capture'))
    expect(fixture.events.indexOf('capture')).toBeLessThan(fixture.events.indexOf('remove'))
  } finally { await runtime.stop() }
  const reader = new DiagnosticStore(path)
  try {
    const event = reader.query({ workspace: 'logproof', operator: false }).events[0]
    expect(event).toMatchObject({ severity: 'error', source: 'docker', phase: mode === 'start' ? 'installer_start' : 'installer_wait', exitCode: null,
      context: { completionKnown: false, controlError: expect.any(String) } })
    if (mode === 'logs' || mode === 'start') expect(event).toMatchObject({ stderr: null, context: { stderrEvidenceUnavailable: expect.stringContaining('HTTP 503') } })
    else expect(event.stderr).toContain('fatal: exact installer cause')
    expect(JSON.stringify(event)).not.toContain('opaque-task-credential')
    expect(reader.query({ workspace: 'other', operator: false }).total).toBe(0)
  } finally { reader.close() }
})

it.each([999, 1000, 1001])('persists honest release stderr completeness for %i short lines', async (lineCount) => {
  const fixture = await engine('tail', lineCount), path = join(fixture.directory, 'logging.db')
  const runtime = new DiagnosticRuntime({ path, report: () => undefined })
  const client = new DockerClient(fixture.socket, (evidence) => {
    expect(fixture.removed()).toBe(false); observeReleaseTask(runtime, evidence)
  })
  try { await expect(client.runTask('release-proof', spec)).resolves.toBe(17) }
  finally { await runtime.stop() }
  expect(fixture.removed()).toBe(true)
  const reader = new DiagnosticStore(path)
  try {
    const event = reader.query({ workspace: 'logproof', operator: false }).events[0]
    expect(event).toMatchObject({ exitCode: 17, truncated: lineCount > 1000,
      context: { completionKnown: true, stderrLineLimit: 1000, stderrLineBoundReached: lineCount > 1000,
        stderrEvidenceTruncated: lineCount > 1000 ? expect.stringContaining('later cause lines may be missing') : null } })
    expect(Buffer.byteLength(event.stderr!)).toBeLessThan(16_384)
    expect(event.stderr).toContain('initial failure cause')
    expect(event.stderr!.split('\n')).toHaveLength(Math.min(lineCount, 1000))
  } finally { reader.close() }
})

it('preserves the task failure when both the observer and stderr reporter fail', async () => {
  const fixture = await engine('http')
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => { throw new Error('fixture stderr failed') })
  const client = new DockerClient(fixture.socket, () => { throw new Error('fixture observer failed') })
  await expect(client.runTask('release-proof', spec)).rejects.toThrow('fixture wait failed')
  expect(fixture.removed()).toBe(true)
  expect(client.taskCaptureError).toContain('fixture observer failed')
  expect(stderr).not.toHaveBeenCalled()
})

it('retains a reporting gap when the channel recovers before the next collection poll', async () => {
  const fixture = await engine('http')
  const runtime = new DiagnosticRuntime({ path: join(fixture.directory, 'logging.db'), report: () => undefined })
  vi.spyOn(runtime, 'emit').mockImplementationOnce(() => { throw new Error('fixture capture failed') })
  const client = new DockerClient(fixture.socket, (evidence) => observeReleaseTask(runtime, evidence))
  try {
    await expect(client.runTask('release-proof', spec)).rejects.toThrow('fixture wait failed')
    expect(runtime.health().sources.find((source) => source.id === 'docker-task-reporting')).toMatchObject({ status: 'unavailable' })
    await expect(client.runTask('release-proof', spec)).rejects.toThrow('fixture wait failed')
    expect(client.taskCaptureError).toBeNull()
    const source = runtime.health().sources.find((source) => source.id === 'docker-task-reporting')!
    expect(source.status).toBe('partial'); expect(source.gaps).toHaveLength(1); expect(source.gaps[0].to).not.toBeNull()
  } finally { await runtime.stop() }
})
