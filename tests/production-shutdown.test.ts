import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { Agent, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiagnosticStore } from '../gateway/src/diagnostics/store'
import { hasShutdownDiagnostic } from '../server/runtime-diagnostic'
import { HANDLE, gatewayKeys, serviceEnvironment } from './service-fixture'

const mocks = vi.hoisted(() => ({
  stopPoiseRuntime: vi.fn<() => Promise<void>>(),
  closeDatabase: vi.fn<() => void>(),
  createPoiseMiddleware: vi.fn(() => (
    _req: IncomingMessage,
    _res: ServerResponse,
    next: () => void,
  ) => next()),
  // The Chat WebSocket attaches to the production server's upgrade event;
  // shutdown ordering is what this file checks, so it is a no-op here.
  attachChatSockets: vi.fn<() => void>(),
  stopDailyModelRefresh: vi.fn<() => void>(),
  abandonCapture: vi.fn<() => void>(),
  installCapture: vi.fn<() => void>(),
}))

vi.mock('../server/production-cpu-profile', () => ({
  abandonProductionCpuCapture: mocks.abandonCapture,
  installProductionCpuCapture: mocks.installCapture,
}))

vi.mock('../server/cache-plugin', () => ({
  createPoiseMiddleware: mocks.createPoiseMiddleware,
  stopPoiseRuntime: mocks.stopPoiseRuntime,
  pendingRuntimeStops: () => [],
  attachChatSockets: mocks.attachChatSockets,
  stopDailyModelRefresh: mocks.stopDailyModelRefresh,
}))

vi.mock('../server/db', () => ({
  closeDatabase: mocks.closeDatabase,
}))

vi.mock('../server/process', async (importOriginal) => ({
  ...await importOriginal<typeof import('../server/process')>(),
  runFile: vi.fn(async () => ({ stdout: JSON.stringify({ version: 1, streamId: 'a'.repeat(32), events: [], cursor: 0, hasMore: false, backfillPending: false }), stderr: '' })),
}))

let directory = ''
function failures() {
  const store = new DiagnosticStore(join(directory, 'logging.db'), undefined, Date.now, true)
  try { return store.query({ workspace: HANDLE, operator: false }, { source: 'poise' }).events }
  finally { store.close() }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'poise-shutdown-'))
  for (const [key, value] of Object.entries(serviceEnvironment(gatewayKeys()))) vi.stubEnv(key, value)
  vi.stubEnv('POISE_DB', join(directory, 'cache.db'))
  vi.stubEnv('POISE_SHUTDOWN_DIAGNOSTIC_ID', 'a'.repeat(32))
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  vi.resetModules()
  mocks.stopPoiseRuntime.mockReset()
  mocks.closeDatabase.mockReset()
  mocks.createPoiseMiddleware.mockClear()
  mocks.abandonCapture.mockClear()
  mocks.installCapture.mockClear()
})

afterEach(async () => {
  vi.useRealTimers()
  await (await import('../server/logging')).stopLogging()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

describe('production shutdown', () => {
  it('is idempotent and closes the database only after runtime shutdown', async () => {
    let releaseRuntime!: () => void
    mocks.stopPoiseRuntime.mockReturnValue(new Promise<void>((resolve) => {
      releaseRuntime = resolve
    }))
    const production = await import('../server/production')
    expect(mocks.installCapture).not.toHaveBeenCalled()
    const server = production.createProductionServer()

    const first = production.shutdownProductionServer(server)
    const second = production.shutdownProductionServer(server)
    expect(second).toBe(first)
    expect(mocks.abandonCapture).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(mocks.stopPoiseRuntime).toHaveBeenCalledTimes(1))
    expect(mocks.closeDatabase).not.toHaveBeenCalled()
    expect(mocks.abandonCapture.mock.invocationCallOrder[0]).toBeLessThan(mocks.stopPoiseRuntime.mock.invocationCallOrder[0])

    releaseRuntime()
    await first
    expect(mocks.stopPoiseRuntime).toHaveBeenCalledTimes(1)
    expect(mocks.closeDatabase).toHaveBeenCalledTimes(1)
  })

  it('exits with the code a release switch asks for once it has shut down', async () => {
    mocks.stopPoiseRuntime.mockResolvedValue(undefined)
    const production = await import('../server/production')
    const server = production.createProductionServer()
    const exits: number[] = []
    const shutdown = production.createProductionShutdown(server, (code) => { exits.push(code) })
    shutdown(75)
    await vi.waitFor(() => expect(exits).toEqual([75]))
    expect(mocks.closeDatabase).toHaveBeenCalledTimes(1)
    expect(failures()).toEqual([])
  })

  it('finishes an in-flight response and retires its keep-alive socket before SQLite closes and exit 75', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    for (const [key, value] of Object.entries(serviceEnvironment(gatewayKeys()))) vi.stubEnv(key, value)
    mocks.stopPoiseRuntime.mockResolvedValue(undefined)
    let response!: ServerResponse
    let accepted!: () => void
    const incoming = new Promise<void>((resolve) => { accepted = resolve })
    mocks.createPoiseMiddleware.mockImplementationOnce(() => (_req, res) => {
      response = res
      accepted()
    })
    const production = await import('../server/production')
    const server = production.createProductionServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind')
    const agent = new Agent({ keepAlive: true })
    const closed = vi.fn()
    server.once('close', closed)
    const exit = vi.fn<(code: number) => void>()
    const body = new Promise<string>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: address.port, path: '/api/held', agent }, (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => { text += chunk })
        res.once('end', () => resolve(text))
        res.once('error', reject)
      })
      req.once('error', reject)
      req.end()
    })
    try {
      await incoming
      production.createProductionShutdown(server, exit)(75)
      // The response is still active halfway through the shutdown budget.
      await vi.advanceTimersByTimeAsync(5_000)
      expect(mocks.stopPoiseRuntime).toHaveBeenCalledTimes(1)
      expect(response.destroyed).toBe(false)
      expect(closed).not.toHaveBeenCalled()
      expect(mocks.closeDatabase).not.toHaveBeenCalled()
      expect(exit).not.toHaveBeenCalled()

      response.end('completed in flight')
      expect(await body).toBe('completed in flight')
      await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(75))
      expect(closed).toHaveBeenCalledTimes(1)
      expect(mocks.closeDatabase).toHaveBeenCalledTimes(1)
      expect(closed.mock.invocationCallOrder[0]).toBeLessThan(mocks.closeDatabase.mock.invocationCallOrder[0])
      expect(mocks.closeDatabase.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0])
    } finally {
      response?.end()
      agent.destroy()
      await production.shutdownProductionServer(server)
    }
  })

  it('forces shutdown once after the ten-second deadline', async () => {
    vi.useFakeTimers()
    let releaseRuntime!: () => void
    mocks.stopPoiseRuntime.mockReturnValue(new Promise<void>((resolve) => {
      releaseRuntime = resolve
    }))
    const production = await import('../server/production')
    const logging = await import('../server/logging')
    const server = production.createProductionServer()
    const exits: number[] = []
    const shutdown = production.createProductionShutdown(server, (code) => {
      logging.loggingRuntime()!.flush()
      expect(failures()).toEqual([expect.objectContaining({ severity: 'error', operation: 'process.shutdown',
        phase: 'shutdown_deadline', exitCode: 1, timeoutMs: 10_000, context: { requestedExitCode: 0, pendingPhases: ['runtime_stop'] } })])
      exits.push(code)
    })

    shutdown()
    shutdown()
    await Promise.resolve()
    expect(mocks.stopPoiseRuntime).toHaveBeenCalledTimes(1)
    expect(production.PRODUCTION_SHUTDOWN_TIMEOUT_MS).toBe(10_000)
    expect(mocks.closeDatabase).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(9_999)
    expect(exits).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.closeDatabase).toHaveBeenCalledTimes(1)
    expect(exits).toEqual([1])
    expect(failures()).toEqual([expect.objectContaining({ severity: 'error', operation: 'process.shutdown',
      phase: 'shutdown_deadline', exitCode: 1, timeoutMs: 10_000, context: { requestedExitCode: 0, pendingPhases: ['runtime_stop'] } })])

    releaseRuntime()
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.closeDatabase).toHaveBeenCalledTimes(1)
    expect(exits).toEqual([1])
    expect(failures()).toHaveLength(1)
  })

  it.each(['runtime_stop', 'http_close', 'both'] as const)('retains %s rejection causes, including when the other operation hangs', async (rejected) => {
    vi.useFakeTimers()
    const production = await import('../server/production')
    const server = production.createProductionServer()
    Object.defineProperty(server, 'listening', { value: true })
    vi.spyOn(server, 'close').mockImplementation((callback) => {
      if (rejected !== 'runtime_stop') {
        queueMicrotask(() => {
          server.emit('close')
          callback?.(new Error('HTTP close refused'))
        })
      }
      return server
    })
    mocks.stopPoiseRuntime.mockImplementation(() => rejected !== 'http_close'
      ? Promise.reject(new Error('runtime cleanup refused', { cause: new Error('original cleanup cause') }))
      : new Promise<void>(() => {}))
    const exits: number[] = []
    const shutdown = production.createProductionShutdown(server, (code) => {
      // Read a separate connection at the immediate-exit boundary, before any
      // event-loop flush can turn an accepted logger call into durable evidence.
      expect(failures()).toHaveLength(1)
      exits.push(code)
    })
    shutdown(75)
    await vi.advanceTimersByTimeAsync(0)
    if (rejected !== 'both') {
      expect(exits).toEqual([])
      await vi.advanceTimersByTimeAsync(10_000)
    }
    expect(exits).toEqual([1])
    const events = failures()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ operation: 'process.shutdown', severity: 'error', exitCode: 1,
      correlationId: 'a'.repeat(32),
      phase: rejected === 'both' ? 'shutdown_rejected' : 'shutdown_deadline',
      context: { requestedExitCode: 75, pendingPhases: rejected === 'both' ? [] : [rejected === 'runtime_stop' ? 'http_close' : 'runtime_stop'] } })
    expect(hasShutdownDiagnostic('a'.repeat(32), process.env.POISE_RELEASE ?? null)).toBe(true)
    if (rejected !== 'http_close') expect(events[0].cause).toEqual(expect.arrayContaining(['runtime_stop: runtime cleanup refused', 'runtime_stop: original cleanup cause']))
    if (rejected !== 'runtime_stop') expect(events[0].cause).toContain('http_close: HTTP close refused')
    expect(mocks.closeDatabase).toHaveBeenCalledTimes(1)
  })

  it('retains database-close rejection on the existing runtime base', async () => {
    vi.stubEnv('POISE_SHUTDOWN_DIAGNOSTIC_ID', undefined)
    mocks.stopPoiseRuntime.mockResolvedValue(undefined)
    mocks.closeDatabase.mockImplementation(() => { throw new Error('SQLite close refused') })
    const production = await import('../server/production')
    const exits: number[] = []
    production.createProductionShutdown(production.createProductionServer(), (code) => { exits.push(code) })(75)
    await vi.waitFor(() => expect(exits).toEqual([1]))
    expect(failures()).toEqual([expect.objectContaining({ phase: 'shutdown_rejected', correlationId: null, cause: ['database_close: SQLite close refused'] })])
  })

  it('persists an HTTP-close deadline after Logging stops and process.exit(1) runs', async () => {
    const cache = join(process.cwd(), 'node_modules', '.cache')
    mkdirSync(cache, { recursive: true })
    const compiled = mkdtempSync(join(cache, 'poise-shutdown-'))
    const helper = join(compiled, 'shutdown.mjs')
    const caller = join(directory, 'agent-interface')
    writeFileSync(caller, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify({ version: 1, streamId: 'b'.repeat(32), events: [], cursor: 0, hasMore: false, backfillPending: false }))})`, { mode: 0o755 })
    try {
      await build({ stdin: { contents: `
        import { createProductionServer, createProductionShutdown } from './server/production';
        const server = createProductionServer();
        Object.defineProperty(server, 'listening', {value: true});
        server.close = () => server;
        setInterval(() => {}, 1000);
        createProductionShutdown(server)(75);
      `, resolveDir: process.cwd(), sourcefile: 'shutdown-fixture.ts', loader: 'ts' }, outfile: helper,
      define: { 'import.meta.url': JSON.stringify(pathToFileURL(join(process.cwd(), 'server/production.ts')).href) },
      bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
      plugins: [{ name: 'shutdown-runtime', setup(builder) {
        builder.onResolve({ filter: /^\.\/(cache-plugin|db)$/ }, (args) => args.importer === join(process.cwd(), 'server/production.ts')
          ? { path: args.path, namespace: 'shutdown-runtime' } : undefined)
        builder.onLoad({ filter: /.*/, namespace: 'shutdown-runtime' }, (args) => ({ resolveDir: join(process.cwd(), 'server'),
          contents: args.path === './db' ? 'export function closeDatabase() {}' : `
            import { stopLogging } from './logging';
            export const createPoiseMiddleware = () => (_req, _res, next) => next();
            export const attachChatSockets = () => {};
            export const stopDailyModelRefresh = () => {};
            export const stopPoiseRuntime = () => stopLogging();
            export const pendingRuntimeStops = () => [];
          ` }))
      } }],
      })
      const result = spawnSync(process.execPath, [helper], { encoding: 'utf8', timeout: 20_000,
        env: { ...process.env, CALLER_BIN_ROOT: directory } })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr).toBe(1)
      expect(failures()).toEqual([expect.objectContaining({ operation: 'process.shutdown', phase: 'shutdown_deadline',
        severity: 'error', context: { requestedExitCode: 75, pendingPhases: ['http_close'] } })])
    } finally { rmSync(compiled, { recursive: true, force: true }) }
  }, 25_000)
})
