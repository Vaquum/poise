import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ runFile: vi.fn() }))
vi.mock('../server/process', () => ({ runFile: mocks.runFile }))
vi.mock('../server/models', () => ({ agentInterfaceCwd: () => '/interface' }))

beforeEach(() => {
  vi.resetModules()
  mocks.runFile.mockReset()
  vi.stubEnv('POISE_NATIVE_CONTROL', 'isolated-controller')
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('refuses bounded execution on an older otherwise namespace-capable runtime image', async () => {
  mocks.runFile.mockResolvedValue({ stdout: JSON.stringify({ version: 1, supported: true }) })
  const support = await import('../server/native-cleanup-support')
  await support.requireNativeCleanup()
  vi.stubEnv('POISE_BEHAVIOR_MEMORY_BUDGET_BYTES', '100')
  vi.stubEnv('POISE_BEHAVIOR_MEMORY_RESERVATION_BYTES', '60')
  expect(support.nativeCleanupSupport()).toMatchObject({ status: 'unsupported', error: expect.stringContaining('resource-guard support') })
  await expect(support.requireNativeCleanup()).rejects.toThrow('resource-guard support')
})

it('accepts explicitly supported bounded execution using the same capability check', async () => {
  vi.stubEnv('POISE_BEHAVIOR_MEMORY_BUDGET_BYTES', '100')
  vi.stubEnv('POISE_BEHAVIOR_MEMORY_RESERVATION_BYTES', '60')
  mocks.runFile.mockResolvedValue({ stdout: JSON.stringify({ version: 1, supported: true, resourceGuard: 1 }) })
  const support = await import('../server/native-cleanup-support')
  await support.requireNativeCleanup()
  expect(support.nativeCleanupSupport().status).toBe('supported')
  expect(mocks.runFile).toHaveBeenCalledTimes(1)
})

it('keeps unsupported setups on v1 without starting a capability process', async () => {
  vi.stubEnv('POISE_NATIVE_CONTROL', '')
  const support = await import('../server/native-cleanup-support')
  expect(support.nativeCleanupSupport()).toMatchObject({ status: 'unsupported', error: expect.stringContaining('v1 remains available') })
  await expect(support.requireNativeCleanup()).rejects.toThrow('v1 remains available')
  expect(mocks.runFile).not.toHaveBeenCalled()
})

it('returns checking immediately, coalesces readers and joins the existing release barrier', async () => {
  let complete: (result: { stdout: string }) => void = () => { throw new Error('setup check has not started') }
  mocks.runFile.mockImplementation(() => new Promise(resolve => { complete = resolve }))
  const support = await import('../server/native-cleanup-support')
  const barrier = await import('../server/release-background')
  expect(support.nativeCleanupSupport()).toEqual({ status: 'checking', error: null })
  expect(support.nativeCleanupSupport()).toEqual({ status: 'checking', error: null })
  expect(barrier.behaviorBackgroundBusy()).toBe(1)
  await vi.waitFor(() => expect(mocks.runFile).toHaveBeenCalledTimes(1))
  complete({ stdout: JSON.stringify({ version: 1, supported: true }) })
  await support.requireNativeCleanup()
  expect(support.nativeCleanupSupport()).toEqual({ status: 'supported', error: null })
  expect(barrier.behaviorBackgroundBusy()).toBe(0)
  expect(mocks.runFile).toHaveBeenCalledExactlyOnceWith('agent-interface', ['--native-capability'],
    { cwd: '/interface', timeoutMs: 15_000, maxOutputBytes: 16 * 1024 })
})

it('retains the actual unsupported result rather than enabling cutover', async () => {
  mocks.runFile.mockResolvedValue({ stdout: JSON.stringify({ version: 1, supported: false, error: 'Kernel refused worker cleanup setup' }) })
  const support = await import('../server/native-cleanup-support')
  await expect(support.requireNativeCleanup()).rejects.toThrow('Kernel refused worker cleanup setup')
  expect(support.nativeCleanupSupport()).toEqual({ status: 'unsupported', error: 'Kernel refused worker cleanup setup' })
  expect(mocks.runFile).toHaveBeenCalledTimes(1)
})

it('keeps transient probe failures unavailable and invalidates a previously supported setup after a native failure', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
  mocks.runFile.mockResolvedValue({ stdout: JSON.stringify({ version: 1, supported: false, unavailable: true, error: 'original setup probe still unsettled' }) })
  const support = await import('../server/native-cleanup-support')
  await expect(support.requireNativeCleanup()).rejects.toThrow('still unsettled')
  expect(support.nativeCleanupSupport().status).toBe('unavailable')
  now.mockReturnValue(31_001)
  mocks.runFile.mockResolvedValue({ stdout: JSON.stringify({ version: 1, supported: true }) })
  await support.requireNativeCleanup()
  support.invalidateNativeCleanup('original controller failed during a native Call')
  expect(support.nativeCleanupSupport()).toEqual({ status: 'unavailable', error: 'original controller failed during a native Call' })
  expect(mocks.runFile).toHaveBeenCalledTimes(2)
})

it.each([
  {}, [], { version: 2, supported: true }, { version: 1, supported: true, error: null },
  { version: 1, supported: false }, { version: 1, supported: false, error: '' },
])('refuses incomplete or contradictory evidence: %j', async value => {
  mocks.runFile.mockResolvedValue({ stdout: JSON.stringify(value) })
  const support = await import('../server/native-cleanup-support')
  await expect(support.requireNativeCleanup()).rejects.toThrow('invalid evidence')
  expect(support.nativeCleanupSupport().status).toBe('unavailable')
})

it('retains synchronous setup errors and retries only on a later existing observation', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
  mocks.runFile.mockImplementationOnce(() => { throw new Error('Caller setup is unreadable') })
  const support = await import('../server/native-cleanup-support')
  await expect(support.requireNativeCleanup()).rejects.toThrow('Caller setup is unreadable')
  expect(support.nativeCleanupSupport().status).toBe('unavailable')
  expect(mocks.runFile).toHaveBeenCalledTimes(1)
  now.mockReturnValue(31_001)
  mocks.runFile.mockResolvedValue({ stdout: JSON.stringify({ version: 1, supported: true }) })
  await support.requireNativeCleanup()
  expect(mocks.runFile).toHaveBeenCalledTimes(2)
})

it('rejects an old positive result after controller replacement', async () => {
  let complete: (result: { stdout: string }) => void = () => { throw new Error('setup check has not started') }
  mocks.runFile.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  const support = await import('../server/native-cleanup-support')
  const waiting = support.requireNativeCleanup()
  await vi.waitFor(() => expect(mocks.runFile).toHaveBeenCalledTimes(1))
  vi.stubEnv('POISE_NATIVE_CONTROL', 'replacement-controller')
  complete({ stdout: JSON.stringify({ version: 1, supported: true }) })
  await expect(waiting).rejects.toThrow('controller changed')
  mocks.runFile.mockResolvedValue({ stdout: JSON.stringify({ version: 1, supported: false, error: 'Replacement lacks support' }) })
  await expect(support.requireNativeCleanup()).rejects.toThrow('Replacement lacks support')
})

it('starts no helper while the existing release barrier is paused', async () => {
  const barrier = await import('../server/release-background')
  barrier.pauseReleaseBackground()
  const support = await import('../server/native-cleanup-support')
  await expect(support.requireNativeCleanup()).rejects.toThrow('has not been verified')
  expect(mocks.runFile).not.toHaveBeenCalled()
  barrier.resumeReleaseBackground()
  mocks.runFile.mockResolvedValue({ stdout: JSON.stringify({ version: 1, supported: true }) })
  await support.requireNativeCleanup()
})
