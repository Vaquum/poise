import { randomUUID } from 'node:crypto'
import { closeSync, fsync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeFile } from 'node:fs'
import { chmod, lstat, mkdir } from 'node:fs/promises'
import { Session, type Profiler } from 'node:inspector'
import { join } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { BUILD_SHA } from './build-identity'
import { serviceStatePath } from './service/config'

const STARTUP_NODE_OPTIONS = process.env.NODE_OPTIONS ?? ''
const DURATION_MS = 15_000
const MAX_BYTES = 64 * 1024 * 1024
const OUTPUT = 'cpu-profile.json'
type Method = 'Profiler.enable' | 'Profiler.start' | 'Profiler.stop' | 'Profiler.disable' | 'Runtime.discardConsoleEntries'

interface CaptureSession {
  connect(): void
  disconnect(): void
  post(method: Method, callback: (error: Error | null, result?: { profile?: Profiler.Profile }) => void): void
}

/** Fixed diagnostic policy, not a Node-options parser. Optional capture refuses
 *  any signal-diagnostic options, including ambiguous/overridden spellings. */
export function cpuCaptureConflict(
  argv = process.execArgv,
  inherited = STARTUP_NODE_OPTIONS,
  reportOnSignal = process.report?.reportOnSignal === true,
): string | null {
  if (reportOnSignal) return 'native signal reports are enabled'
  if (/--(?:heapsnapshot[-_]signal|report[-_]on[-_]signal|report[-_]signal)(?:[=\s]|$)/.test([...argv, inherited].join(' '))) {
    return 'native signal diagnostic options are present'
  }
  return null
}

function stamp() { return { utc: new Date().toISOString(), monotonicMs: performance.now() } }
function reason(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function readCounter(path: string): { value: string } | { unavailable: string } {
  try { return { value: readFileSync(path, 'utf8') } }
  catch (error) { return { unavailable: (error as NodeJS.ErrnoException).code ?? 'read_failed' } }
}
function counters() {
  return { source: 'workspace namespace', cpuStat: readCounter('/sys/fs/cgroup/cpu.stat'), cpuPressure: readCounter('/sys/fs/cgroup/cpu.pressure') }
}
function identity() {
  const release = process.env.POISE_RELEASE
  const stat = readCounter('/proc/self/stat')
  return {
    pid: process.pid, buildSha: BUILD_SHA, node: process.version,
    release: release && /^[A-Za-z0-9._-]{1,120}$/.test(release) ? release : null,
    startTicks: 'value' in stat ? stat.value.slice(stat.value.lastIndexOf(')') + 2).split(' ')[19] : null,
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  }
}
function outputExists(path: string): boolean {
  try { lstatSync(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

// These seams are for owned fixtures. Production supplies no external duration,
// path, command or Session factory, and never opens an inspector listener.
export function createCpuCapture(options: {
  directory?: string
  durationMs?: number
  maxBytes?: number
  sessionFactory?: () => CaptureSession
  conflict?: () => string | null
  log?: (message: string) => void
} = {}) {
  const directory = options.directory ?? serviceStatePath('diagnostics')
  const output = join(directory, OUTPUT)
  const log = options.log ?? ((message: string) => console.error(`[poise] CPU capture ${message}`))
  const conflict = options.conflict ?? cpuCaptureConflict
  const initialConflict = conflict()
  let consumed = false, shuttingDown = false, active = false, refused = false
  let session: CaptureSession | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let finishWait: (() => void) | undefined
  let staging: string | null = null
  let stagingOwned = false
  let completion: Promise<void> = Promise.resolve()
  const abort = new AbortController()

  function cleanStaging(): void {
    if (!staging || !stagingOwned) return
    try { unlinkSync(staging); stagingOwned = false }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') stagingOwned = false
      else log(`cleanup failed: ${reason(error)}`)
    }
  }
  function disconnect(): void {
    const owned = session
    session = null
    if (!owned) return
    // Dispatch cleanup and disconnect in the same JS turn: awaiting between
    // discard and disconnect could retain console objects logged in that gap.
    for (const method of ['Profiler.disable', 'Runtime.discardConsoleEntries'] as const) {
      try { owned.post(method, (error) => { if (error) log(`cleanup ${method} failed: ${reason(error)}`) }) }
      catch (error) { log(`cleanup ${method} failed: ${reason(error)}`) }
    }
    try { owned.disconnect() }
    catch (error) { log(`disconnect failed: ${reason(error)}`) }
  }
  function post(method: Method): Promise<{ profile?: Profiler.Profile }> {
    return new Promise((resolve, reject) => {
      if (!session || shuttingDown) { reject(new Error('capture abandoned: shutdown')); return }
      session.post(method, (error, result) => error ? reject(error) : resolve(result ?? {}))
    })
  }
  async function persist(text: string): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (!(await lstat(directory)).isDirectory()) throw new Error('diagnostic directory is not a real directory')
    await chmod(directory, 0o700)
    if (shuttingDown) return
    staging = join(directory, `.cpu-profile.${process.pid}.${randomUUID()}.tmp`)
    // Synchronous exclusive creation establishes ownership before a shutdown
    // can interleave. Payload I/O and file fsync remain asynchronous.
    const fd = openSync(staging, 'wx', 0o600)
    stagingOwned = true
    try {
      if (shuttingDown) return
      await new Promise<void>((resolve, reject) => writeFile(fd, text, { encoding: 'utf8', signal: abort.signal }, (error) => error ? reject(error) : resolve()))
      await new Promise<void>((resolve, reject) => fsync(fd, (error) => error ? reject(error) : resolve()))
      if (shuttingDown) return
      // This non-replacing link is the commit boundary. Cancellation cannot
      // interleave between its ownership check and publication.
      linkSync(staging, output)
      cleanStaging()
      const dirFd = openSync(directory, 'r')
      try { await new Promise<void>((resolve, reject) => fsync(dirFd, (error) => error ? reject(error) : resolve())) }
      finally { closeSync(dirFd) }
    } finally { closeSync(fd); cleanStaging() }
  }
  async function record(): Promise<void> {
    const blocked = initialConflict ?? conflict()
    if (blocked) throw new Error(`unavailable: ${blocked}`)
    if (outputExists(output)) throw new Error('output already exists; preserve it before another authorized capture')
    const processIdentity = identity()
    const setupRequested = stamp()
    let monitor: ReturnType<typeof monitorEventLoopDelay> | undefined
    try {
      session = (options.sessionFactory ?? (() => new Session()))()
      session.connect()
      await post('Profiler.enable')
      const startRequested = stamp()
      await post('Profiler.start')
      if (shuttingDown) return
      const startResolved = stamp()
      log(`started=${startResolved.utc} pid=${processIdentity.pid} build=${processIdentity.buildSha ?? 'unknown'}`)
      const cpuBefore = process.cpuUsage(), eluBefore = performance.eventLoopUtilization(), resourceBefore = process.resourceUsage()
      const cgroupBefore = counters()
      monitor = monitorEventLoopDelay({ resolution: 20 })
      monitor.enable()
      await new Promise<void>((resolve) => {
        finishWait = resolve
        timer = setTimeout(resolve, options.durationMs ?? DURATION_MS)
        timer.unref()
      })
      clearTimeout(timer); timer = undefined; finishWait = undefined
      if (shuttingDown) return
      const stopRequested = stamp()
      const { profile } = await post('Profiler.stop')
      const stopResolved = stamp()
      if (shuttingDown) return
      if (!profile) throw new Error('Profiler.stop returned no CPU profile')
      const cpu = process.cpuUsage(cpuBefore), elu = performance.eventLoopUtilization(eluBefore), resourceAfter = process.resourceUsage()
      const cgroupAfter = counters()
      monitor.disable()
      const eventLoop = { samples: Number(monitor.count), maxMs: monitor.max / 1e6, p99Ms: monitor.percentile(99) / 1e6 }
      const cleanupStart = performance.now()
      disconnect()
      const cleanupMs = performance.now() - cleanupStart
      const gaps: Array<{ offsetUs: number, durationUs: number }> = []
      let offset = 0
      for (const delta of profile.timeDeltas ?? []) {
        if (delta > 100_000) gaps.push({ offsetUs: offset, durationUs: delta })
        offset += delta
      }
      const serializationStart = performance.now()
      let encoded = JSON.stringify(profile)
      const profileSerializationMs = performance.now() - serializationStart
      const metadata = {
        version: 1, identity: processIdentity, outcome: 'recorded',
        setupRequested, startRequested, startResolved, stopRequested, stopResolved, persistenceStarted: stamp(),
        requestedDurationMs: options.durationMs ?? DURATION_MS,
        actualDurationMs: stopResolved.monotonicMs - startResolved.monotonicMs,
        startAwaitMs: startResolved.monotonicMs - startRequested.monotonicMs,
        stopAwaitMs: stopResolved.monotonicMs - stopRequested.monotonicMs,
        cleanupMs, profileSerializationMs, cpuScope: 'process, including workers', cpu, eluScope: 'main isolate', elu,
        resourceUsage: { before: resourceBefore, after: resourceAfter,
          voluntaryContextSwitches: resourceAfter.voluntaryContextSwitches - resourceBefore.voluntaryContextSwitches,
          involuntaryContextSwitches: resourceAfter.involuntaryContextSwitches - resourceBefore.involuntaryContextSwitches },
        eventLoop, coverage: eventLoop.samples === 0 ? 'insufficient-samples' : eventLoop.maxMs >= 1000 ? 'stall-observed' : 'no-stall-observed',
        profileTimeUnits: 'monotonic microseconds', sampleCount: profile.samples?.length ?? 0,
        meanSamplingIntervalUs: profile.samples?.length ? offset / profile.samples.length : null,
        unattributedGaps: gaps, cgroup: { before: cgroupBefore, after: cgroupAfter },
      }
      const envelope = () => `{"metadata":${JSON.stringify(metadata)},"profile":${encoded}}\n`
      let text = envelope()
      const maxBytes = options.maxBytes ?? MAX_BYTES
      if (Buffer.byteLength(text) > maxBytes) {
        metadata.outcome = 'oversize'; encoded = 'null'; text = envelope()
        if (Buffer.byteLength(text) > maxBytes) throw new Error('metadata exceeds output byte limit')
      }
      if (shuttingDown) return
      await persist(text)
      if (!shuttingDown) log(`${metadata.outcome}; published=${new Date().toISOString()} pid=${processIdentity.pid} build=${processIdentity.buildSha ?? 'unknown'}`)
    } finally {
      if (timer) clearTimeout(timer)
      timer = undefined; finishWait = undefined
      monitor?.disable()
      disconnect(); cleanStaging()
    }
  }
  function request(): void {
    if (consumed || shuttingDown) {
      if (!refused) { refused = true; log('request refused: attempt consumed or shutting down') }
      return
    }
    consumed = true; active = true
    // Own every rejection before any event-loop turn; failures never re-arm.
    completion = record().catch((error: unknown) => {
      if (!shuttingDown) log(`failed: ${reason(error)}`)
    }).finally(() => { active = false })
  }
  function abandon(): void {
    shuttingDown = true
    if (!active) return
    if (timer) clearTimeout(timer)
    timer = undefined
    abort.abort()
    disconnect(); cleanStaging(); finishWait?.(); finishWait = undefined
    log('abandoned: shutdown')
    active = false
  }
  return { request, abandon, settled: () => completion, initialConflict, identity }
}

let productionCapture: ReturnType<typeof createCpuCapture> | undefined
export function installProductionCpuCapture(): void {
  if (productionCapture) return
  productionCapture = createCpuCapture({ conflict: () => BUILD_SHA === null ? 'running bundle has no compiled build identity' : cpuCaptureConflict() })
  process.on('SIGUSR2', productionCapture.request)
  // The operator binds this bounded, process-specific availability record to
  // running health identity and checks native flags BEFORE delivering a signal.
  console.error(`[poise] CPU capture availability ${JSON.stringify({ ...productionCapture.identity(), available: productionCapture.initialConflict === null, reason: productionCapture.initialConflict })}`)
}
export function abandonProductionCpuCapture(): void { productionCapture?.abandon() }
