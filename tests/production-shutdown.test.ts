import { Agent, request, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gatewayKeys, serviceEnvironment } from './service-fixture'

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
  attachChatSockets: mocks.attachChatSockets,
  stopDailyModelRefresh: mocks.stopDailyModelRefresh,
}))

vi.mock('../server/db', () => ({
  closeDatabase: mocks.closeDatabase,
}))

beforeEach(() => {
  vi.resetModules()
  mocks.stopPoiseRuntime.mockReset()
  mocks.closeDatabase.mockReset()
  mocks.createPoiseMiddleware.mockClear()
  mocks.abandonCapture.mockClear()
  mocks.installCapture.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
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
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const server = production.createProductionServer()
    const exits: number[] = []
    const shutdown = production.createProductionShutdown(server, (code) => { exits.push(code) })

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
    expect(errors).toHaveBeenCalledExactlyOnceWith('[poise] shutdown timed out after 10000ms; pending: runtime stop')

    releaseRuntime()
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.closeDatabase).toHaveBeenCalledTimes(1)
    expect(exits).toEqual([1])
  })

  it('exits 1 with the rejected cleanup phase and its cause', async () => {
    const cause = new Error('runtime cleanup could not flush its pending writes')
    mocks.stopPoiseRuntime.mockRejectedValue(cause)
    const production = await import('../server/production')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const server = production.createProductionServer()
    const exit = vi.fn<(code: number) => void>()

    production.createProductionShutdown(server, exit)(75)
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(1))
    expect(mocks.closeDatabase).toHaveBeenCalledTimes(1)
    expect(errors).toHaveBeenCalledExactlyOnceWith('[poise] shutdown failed:', expect.objectContaining({
      cause: expect.objectContaining({ message: 'runtime stop failed', cause }),
    }))
  })
})
