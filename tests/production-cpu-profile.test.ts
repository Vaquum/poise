import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Profiler } from 'node:inspector'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cpuCaptureConflict, createCpuCapture } from '../server/production-cpu-profile'

const io = vi.hoisted(() => ({ fault: '', holdWrite: false, release: undefined as (() => void) | undefined, syncs: 0 }))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs,
    writeFile(file: number, data: string, options: { encoding: 'utf8', signal: AbortSignal }, callback: (error: NodeJS.ErrnoException | null) => void) {
      if (io.holdWrite) { io.release = () => callback(null); return }
      if (io.fault === 'write') { callback(Object.assign(new Error('ENOSPC: test disk full'), { code: 'ENOSPC' })); return }
      fs.writeFile(file, data, options, callback)
    },
    fsync(fd: number, callback: (error: NodeJS.ErrnoException | null) => void) {
      io.syncs++
      if (io.fault === 'sync' || (io.fault === 'directory-sync' && io.syncs === 2)) { callback(new Error('test sync failure')); return }
      fs.fsync(fd, callback)
    },
    linkSync(source: string, target: string) {
      if (io.fault === 'publish') throw new Error('test publication failure')
      fs.linkSync(source, target)
    },
  }
})
vi.mock('node:crypto', async (original) => ({ ...await original<typeof import('node:crypto')>(), randomUUID: () => 'owned-stage-fixture' }))

const profile: Profiler.Profile = {
  nodes: [{ id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 } }],
  startTime: 1000, endTime: 203_000, samples: [1, 1], timeDeltas: [1000, 201_000],
}
type CaptureOptions = NonNullable<Parameters<typeof createCpuCapture>[0]>
type Method = Parameters<ReturnType<NonNullable<CaptureOptions['sessionFactory']>>['post']>[0]
type Callback = (error: Error | null, result?: { profile?: Profiler.Profile }) => void
class FakeSession {
  calls: string[] = []
  hold: Method | undefined
  fail: Method | undefined
  pending: Callback | undefined
  connect = vi.fn()
  disconnect = vi.fn()
  post(method: Method, callback: Callback) {
    this.calls.push(method)
    if (method === this.hold) this.pending = callback
    else if (method === this.fail) callback(new Error(`failed ${method}`))
    else callback(null, method === 'Profiler.stop' ? { profile } : {})
  }
}
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'poise-cpu-profile-'))
  Object.assign(io, { fault: '', holdWrite: false, release: undefined, syncs: 0 })
  vi.useFakeTimers()
})
afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }) })
function fixture(options: Parameters<typeof createCpuCapture>[0] = {}) {
  const session = new FakeSession()
  const log = vi.fn()
  const capture = createCpuCapture({ directory: root, sessionFactory: () => session, conflict: () => null, log, ...options })
  return { capture, session, log }
}
async function start(capture: ReturnType<typeof createCpuCapture>) {
  capture.request()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
}
async function finish(capture: ReturnType<typeof createCpuCapture>) {
  await vi.advanceTimersByTimeAsync(15_000)
  await capture.settled()
}

it('records a bounded envelope, private modes, and unattributed gaps without a listener command', async () => {
  chmodSync(root, 0o755)
  const { capture, session, log } = fixture()
  await start(capture)
  capture.request(); capture.request()
  await finish(capture)
  capture.request()
  const artifact = JSON.parse(readFileSync(join(root, 'cpu-profile.json'), 'utf8'))
  expect(artifact.profile).toEqual(profile)
  expect(artifact.metadata).toMatchObject({ version: 1, outcome: 'recorded', requestedDurationMs: 15_000,
    cpuScope: 'process, including workers', sampleCount: 2, meanSamplingIntervalUs: 101_000,
    unattributedGaps: [{ offsetUs: 1000, durationUs: 201_000 }], cgroup: { before: { source: 'workspace namespace' } } })
  for (const field of ['setupRequested', 'startRequested', 'startResolved', 'stopRequested', 'stopResolved']) {
    expect(artifact.metadata[field]).toEqual({ utc: expect.any(String), monotonicMs: expect.any(Number) })
  }
  expect(statSync(root).mode & 0o777).toBe(0o700)
  expect(statSync(join(root, 'cpu-profile.json')).mode & 0o777).toBe(0o600)
  expect(readdirSync(root)).toEqual(['cpu-profile.json'])
  expect(session.calls).toEqual(['Profiler.enable', 'Profiler.start', 'Profiler.stop', 'Profiler.disable', 'Runtime.discardConsoleEntries'])
  expect(session.disconnect).toHaveBeenCalledTimes(1)
  expect(log.mock.calls.filter(([line]) => line.startsWith('request refused'))).toHaveLength(1)
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['Profiler.enable', 'Profiler.start', 'Profiler.stop'] as const)('owns %s rejection and never re-arms', async (method) => {
  const { capture, session, log } = fixture()
  session.fail = method
  await start(capture)
  await finish(capture)
  capture.request()
  expect(log).toHaveBeenCalledWith(`failed: failed ${method}`)
  expect(session.connect).toHaveBeenCalledTimes(1)
  expect(session.calls).toContain('Runtime.discardConsoleEntries')
  expect(session.disconnect).toHaveBeenCalledTimes(1)
  expect(readdirSync(root)).toEqual([])
})

it.each(['Profiler.enable', 'Profiler.start', 'Profiler.stop'] as const)('abandons pending %s and owns a late rejection', async (method) => {
  const { capture, session, log } = fixture()
  session.hold = method
  await start(capture)
  if (method === 'Profiler.stop') await vi.advanceTimersByTimeAsync(15_000)
  expect(session.pending).toBeTypeOf('function')
  capture.abandon(); capture.request(); capture.request()
  expect(session.disconnect).toHaveBeenCalledTimes(1)
  expect(session.calls).toContain('Runtime.discardConsoleEntries')
  expect(vi.getTimerCount()).toBe(0)
  session.pending?.(new Error('late disconnect error'))
  await capture.settled()
  expect(log).toHaveBeenCalledWith('abandoned: shutdown')
  expect(log.mock.calls.filter(([line]) => line.startsWith('request refused'))).toHaveLength(1)
  expect(readdirSync(root)).toEqual([])
})

it('abandons the capture timer without waiting for its remaining duration', async () => {
  const { capture, session } = fixture()
  await start(capture)
  expect(vi.getTimerCount()).toBe(1)
  capture.abandon()
  await capture.settled()
  expect(session.calls).not.toContain('Profiler.stop')
  expect(vi.getTimerCount()).toBe(0)
  expect(readdirSync(root)).toEqual([])
})

it('refuses and preserves an existing output before connecting', async () => {
  const target = join(root, 'cpu-profile.json')
  writeFileSync(target, 'previous', { mode: 0o644 })
  const { capture, session, log } = fixture()
  await start(capture); await capture.settled()
  expect(session.connect).not.toHaveBeenCalled()
  expect(readFileSync(target, 'utf8')).toBe('previous')
  expect(statSync(target).mode & 0o777).toBe(0o644)
  expect(log).toHaveBeenCalledWith(expect.stringContaining('output already exists'))
})

it('never replaces a target created after capture starts', async () => {
  const { capture, log } = fixture()
  await start(capture)
  writeFileSync(join(root, 'cpu-profile.json'), 'other writer')
  await finish(capture)
  expect(readFileSync(join(root, 'cpu-profile.json'), 'utf8')).toBe('other writer')
  expect(readdirSync(root)).toEqual(['cpu-profile.json'])
  expect(log).toHaveBeenCalledWith(expect.stringContaining('EEXIST'))
})

it('refuses symlink directories and leaves their targets untouched', async () => {
  const directory = join(root, 'link'), target = join(root, 'target')
  mkdirSync(target); symlinkSync(target, directory)
  const { capture, log } = fixture({ directory })
  await start(capture); await finish(capture)
  expect(readdirSync(target)).toEqual([])
  expect(log).toHaveBeenCalledWith('failed: diagnostic directory is not a real directory')
})

it('publishes valid metadata only for an oversized serialized profile', async () => {
  const { capture, session } = fixture({ maxBytes: 16_384 })
  const original = session.post.bind(session)
  session.post = (method, callback) => method === 'Profiler.stop'
    ? callback(null, { profile: { ...profile, samples: Array<number>(20_000).fill(1) } })
    : original(method, callback)
  await start(capture); await finish(capture)
  const data = readFileSync(join(root, 'cpu-profile.json'), 'utf8')
  expect(Buffer.byteLength(data)).toBeLessThanOrEqual(16_384)
  expect(JSON.parse(data)).toMatchObject({ profile: null, metadata: { outcome: 'oversize', sampleCount: 20_000 } })
})

it('does not publish truncated JSON when even metadata cannot fit', async () => {
  const { capture, log } = fixture({ maxBytes: 1 })
  await start(capture); await finish(capture)
  expect(existsSync(join(root, 'cpu-profile.json'))).toBe(false)
  expect(log).toHaveBeenCalledWith('failed: metadata exceeds output byte limit')
})

it.each([
  [['--report-on-signal'], '', false], [[], '--heapsnapshot-signal=SIGUSR2', false],
  [['--report_signal', 'SIGUSR2'], '', false], [[], '', true],
] as const)('refuses native signal diagnostics before Session setup (%j)', async (argv, inherited, report) => {
  const conflict = () => cpuCaptureConflict([...argv], inherited, report)
  const { capture, session, log } = fixture({ conflict })
  await start(capture); await capture.settled()
  expect(capture.initialConflict).not.toBeNull()
  expect(session.connect).not.toHaveBeenCalled()
  expect(log).toHaveBeenCalledWith(expect.stringContaining('unavailable:'))
})

it('rechecks programmatic report configuration before starting', async () => {
  let enabled = false
  const { capture, session } = fixture({ conflict: () => cpuCaptureConflict([], '', enabled) })
  expect(capture.initialConflict).toBeNull()
  enabled = true
  await start(capture); await capture.settled()
  expect(session.connect).not.toHaveBeenCalled()
  expect(cpuCaptureConflict([], '', false)).toBeNull()
})

it.each(['write', 'sync', 'publish'])('cleans its staging file on %s failure without partial publication', async (fault) => {
  io.fault = fault
  const { capture, log } = fixture()
  await start(capture); await finish(capture)
  expect(log).toHaveBeenCalledWith(expect.stringContaining(fault === 'write' ? 'ENOSPC' : 'failure'))
  expect(readdirSync(root)).toEqual([])
})

it('keeps an already committed complete artifact if directory durability fails', async () => {
  io.fault = 'directory-sync'
  const { capture, log } = fixture()
  await start(capture); await finish(capture)
  expect(JSON.parse(readFileSync(join(root, 'cpu-profile.json'), 'utf8')).profile).toEqual(profile)
  expect(readdirSync(root)).toEqual(['cpu-profile.json'])
  expect(log).toHaveBeenCalledWith('failed: test sync failure')
})

it('unlinks an owned staging file on shutdown and prevents late write publication', async () => {
  io.holdWrite = true
  const { capture } = fixture()
  await start(capture)
  await vi.advanceTimersByTimeAsync(15_000)
  await vi.waitFor(() => expect(io.release).toBeTypeOf('function'))
  expect(readdirSync(root)).toHaveLength(1)
  capture.abandon()
  expect(readdirSync(root)).toEqual([])
  io.release?.()
  await capture.settled()
  expect(readdirSync(root)).toEqual([])
})

it('does not follow or remove a foreign staging symlink', async () => {
  const target = join(root, 'foreign')
  writeFileSync(target, 'preserved')
  const staging = join(root, `.cpu-profile.${process.pid}.owned-stage-fixture.tmp`)
  symlinkSync(target, staging)
  const { capture, log } = fixture()
  await start(capture); await finish(capture)
  expect(readFileSync(target, 'utf8')).toBe('preserved')
  expect(existsSync(staging)).toBe(true)
  expect(existsSync(join(root, 'cpu-profile.json'))).toBe(false)
  expect(log).toHaveBeenCalledWith(expect.stringContaining('EEXIST'))
})
