// Automated workspace storage maintenance: retention and garbage collection
// for the scratch and cache data Poise accumulates (chat worker workspaces,
// review checkouts, incident snapshots, tool caches). Runs on a timer, on
// disk pressure, and on demand from Settings; see docs/Operating.md, "Disk".
//
// Safety (non-negotiable): a workspace with uncommitted changes or unpushed
// commits is kept; a workspace whose session has a turn running or queued is
// never touched; anything uncertain is kept and listed as held with the
// reason. Every run is idempotent — each item is independent, so a restart
// simply leaves the rest for the next run — and dry-run classifies exactly
// like a real run without deleting anything.

import { lstat, opendir, readdir, readFile, rm } from 'node:fs/promises'
import { existsSync, type Stats } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getMeta, setMeta } from './db'
import { diagnostic, diagnosticFailure } from './logging'
import { isAbortError, isExpectedFailure, runFile } from './process'
import { raiseAlert, resolveAlert } from './alerts/store'
import { canonicalCheckout, CheckoutLease } from './chat/checkout-lock'
import { inspectCheckout } from './chat/git'
import { LOCAL_CHAT_ROOT, workerWorkspaceRef, workspaceMarkerValid } from './chat/local-workspace'
import { getOpenTurn, sessionsForCheckout } from './chat/storage'
import { queueOwner, readQueue } from './chat/message-queue'
import { poiseStateRoot } from './review-checkout'
import { agentInterfaceCwd } from './models'
import { callerDatabase } from './caller-store'
import { behaviorChainJournal } from './behavior-chain-journal'
import { BehaviorResourceRecovery } from './behavior-chain-resource-recovery'
import { readNativeInvocations } from './behavior-chain-native'
import { db } from './db'
import { releaseBackgroundPaused, releaseSwitchPending, trackReleaseBackground } from './release-background'

/** Closed sessions keep their workspace this long before it may be removed. */
export const WORKSPACE_CLOSED_GRACE_MS = 24 * 60 * 60_000
/** Idle artifacts need generator provenance before they may be pruned. */
export const WORKSPACE_IDLE_PRUNE_MS = 3 * 24 * 60 * 60_000
/** Incident snapshots expire after this unless pinned with a KEEP file. */
export const INCIDENT_RECOVERY_RETENTION_MS = 30 * 24 * 60 * 60_000
/** Full maintenance runs on this timer, and at startup. */
export const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60_000
/** A start never begins a pass sooner: each deploy restarts the server just as
 *  the person's page reloads onto the new build, and a pass takes each closed
 *  workspace's checkout lease, a synced write on the server's main thread. */
export const MAINTENANCE_START_DELAY_MS = 10 * 60_000
/** Disk pressure is re-measured this often; a statfs, not a tree walk. */
export const PRESSURE_CHECK_MS = 60_000
/** At this used percentage maintenance runs at once, shedding caches first. */
export const PRESSURE_USED_PCT = 80
/** The pressure alert clears once usage drops below this. */
export const PRESSURE_CLEAR_PCT = 75
/** Pressure-triggered runs are this far apart at most; the timer is unaffected. */
export const PRESSURE_RUN_COOLDOWN_MS = 60 * 60_000
/** Files this fresh are never evicted: they may be in use right now. */
export const CACHE_FRESH_MS = 5 * 60_000
/** One Settings storage read walks at most this many entries across every category. */
export const STORAGE_SCAN_MAX_ENTRIES = 100_000
/** One Settings storage read spends at most this long walking trees. */
export const STORAGE_SCAN_TIMEOUT_MS = 5_000
/** One measured storage summary answers Settings opens for this long. */
export const STORAGE_STATUS_TTL_MS = 60_000

export const CACHE_CAP_BYTES = {
  pip: 1024 ** 3,
  uv: 2 * 1024 ** 3,
  npm: 1024 ** 3,
  mirrors: 2 * 1024 ** 3,
} as const

const LAST_RUN_KEY = 'storage_maintenance_last'
const PRESSURE_ALERT_KEY = 'workspace-storage-pressure'
const PRUNE_MARKER = '.poise-maintenance.json'
const HEX32 = /^[0-9a-f]{32}$/

export type StorageCategoryStatus = 'ok' | 'partial' | 'unavailable'

export interface StorageCategory {
  key: string
  label: string
  path: string
  /** Measured bytes, or null when nothing usable could be read. */
  bytes: number | null
  status: StorageCategoryStatus
  /** Why a partial or unavailable category stopped short, for the reader. */
  error?: string
}

export interface StorageBreakdown {
  at: string
  categories: StorageCategory[]
  disk: { path: string, totalBytes: number, freeBytes: number, usedPercent: number }
  /** False when any category stopped short of a full measurement. */
  complete: boolean
}

export interface HeldItem {
  path: string
  reason: string
}

export interface ReclaimedItem {
  path: string
  bytes: number
}

export interface MaintenanceReport {
  startedAt: string
  finishedAt: string
  dryRun: boolean
  pressureRun: boolean
  reclaimedBytes: number
  removed: ReclaimedItem[]
  pruned: ReclaimedItem[]
  caches: ReclaimedItem[]
  held: HeldItem[]
  errors: Array<{ path?: string, message: string }>
  /** Bytes fstrim returned to the host, or null when it did not run. */
  trimmedBytes: number | null
  /** Completed native cleanup receipts; bytes require the separate inventory. */
  nativeCleanupCompleted?: number
}

export interface WorkspaceClaim {
  sessionId: string
  status: string
  updatedAt: string
  openTurn: boolean
  queued: boolean
}

export interface MaintenanceOptions {
  dryRun?: boolean
  pressureRun?: boolean
  now?: number
  chatRoot?: string
  stateRoot?: string
  home?: string
  claims?: (checkout: string) => WorkspaceClaim[]
  trim?: (path: string) => Promise<number | null>
  caps?: Partial<typeof CACHE_CAP_BYTES>
}

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown })?.code
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Cache roots, honoring each tool's own override exactly as the tool does. */
export function cacheDirs(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): {
  pip: string, uv: string, npm: string, agentWork: string, mirrors: string,
} {
  const xdg = env.XDG_CACHE_HOME || join(home, '.cache')
  return {
    pip: env.PIP_CACHE_DIR || join(xdg, 'pip'),
    uv: env.UV_CACHE_DIR || join(xdg, 'uv'),
    npm: env.npm_config_cache || join(home, '.npm'),
    agentWork: env.AGENT_INTERFACE_WORK_DIR || join(home, '.cache', 'agent-interface', 'issue-review'),
    mirrors: env.GITHUB_INTERFACE_MIRROR_DIR || join(home, '.cache', 'github-interface', 'mirrors'),
  }
}

/** Logical bytes under a path, following no symlinks. Missing reads as zero. */
export async function dirSize(path: string): Promise<number> {
  let total = 0
  const stack: string[] = [path]
  while (stack.length) {
    const current = stack.pop()!
    let entries
    try {
      const info = await lstat(current)
      total += info.size
      if (!info.isDirectory() || info.isSymbolicLink()) continue
      entries = await readdir(current)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) stack.push(join(current, entry))
  }
  return total
}

async function diskUsage(path: string): Promise<{ totalBytes: number, freeBytes: number, usedPercent: number }> {
  const stats = await statfs(path)
  const totalBytes = stats.blocks * stats.bsize
  const freeBytes = stats.bavail * stats.bsize
  const usedPercent = totalBytes > 0 ? (100 * (totalBytes - freeBytes)) / totalBytes : 0
  return { totalBytes, freeBytes, usedPercent }
}

export interface MeasureOptions {
  /** Shared across one breakdown: every examined path counts as one entry. */
  budget?: { entries: number, maxEntries: number }
  /** Entry budget for a standalone measurement; a shared budget wins. */
  maxEntries?: number
  /** Walk budget in milliseconds for a standalone measurement. */
  timeoutMs?: number
  /** Epoch milliseconds the walk may run until; checked before each entry. */
  deadlineMs?: number
  now?: () => number
  /** Retained only by the shared Settings measurement. */
  measurement?: DirectoryMeasurement
}

export interface MeasuredDir {
  bytes: number | null
  status: StorageCategoryStatus
  entries: number
  error?: string
}

interface DirectoryMeasurement {
  bytes: number
  entries: number
  complete: boolean
  cancelled: boolean
  walk: AsyncGenerator<void> | null
  error?: string
}

interface StorageMeasurement {
  at: string
  directories: Map<string, DirectoryMeasurement>
  cancelled: boolean
}

function directoryMeasurement(): DirectoryMeasurement {
  return { bytes: 0, entries: 0, complete: false, cancelled: false, walk: null }
}

/** Retain the open directory cursor, including unread entries in a wide
 *  directory. Each yield bounds another path examination or directory read.
 *  A second, bounded stat pass checks every counted descendant; this is a
 *  live-tree measurement, not an atomic filesystem snapshot. */
async function* walkMeasuredDir(path: string, top: Stats, measurement: DirectoryMeasurement): AsyncGenerator<void> {
  const observed = new Map<string, Stats>()
  const pending: string[] = []
  const verify = async (current: string, before: Stats) => {
    const after = await lstat(current)
    if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error(`${current}: the storage tree changed during measurement`)
    }
  }
  const record = (current: string, info: Stats) => {
    observed.set(current, info)
    measurement.bytes += info.size
    measurement.entries += 1
    if (info.isDirectory() && !info.isSymbolicLink()) pending.push(current)
  }
  record(path, top)
  yield
  while (pending.length) {
    const current = pending.pop()!
    await verify(current, observed.get(current)!)
    const dir = await opendir(current)
    try {
      yield
      let entry = await dir.read()
      while (entry) {
        const child = join(current, entry.name)
        record(child, await lstat(child))
        yield
        entry = await dir.read()
      }
    } finally {
      await dir.close()
    }
    yield
  }
  for (const [current, before] of observed) {
    await verify(current, before)
    yield
  }
}

/** Logical bytes under a path, following no symlinks, within a shared entry
 *  budget and a time deadline. Missing reads as zero; anything else that
 *  stops the walk reports partial (a measured prefix) or unavailable
 *  (nothing usable), never a silent zero. A missing path costs no budget:
 *  it is one lstat with an honest answer. */
export async function measureDir(path: string, options: MeasureOptions = {}): Promise<MeasuredDir> {
  const clock = options.now ?? Date.now
  const deadlineMs = options.deadlineMs ?? clock() + (options.timeoutMs ?? STORAGE_SCAN_TIMEOUT_MS)
  const budget = options.budget ?? { entries: 0, maxEntries: options.maxEntries ?? STORAGE_SCAN_MAX_ENTRIES }
  const expired = (): string | null => {
    if (budget.entries >= budget.maxEntries) return `the storage scan stopped after ${budget.maxEntries} entries`
    if (clock() >= deadlineMs) return 'the storage scan timed out'
    return null
  }
  const measurement = options.measurement ?? directoryMeasurement()
  let failure: string | null = null
  try {
    if (!measurement.walk && !measurement.complete && !measurement.cancelled) {
      measurement.bytes = 0
      measurement.entries = 0
      let top
      try {
        top = await lstat(path)
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error
        measurement.complete = true
        measurement.error = undefined
      }
      if (top && !measurement.cancelled) measurement.walk = walkMeasuredDir(path, top, measurement)
    }
    while (measurement.walk && !measurement.cancelled) {
      failure = expired()
      if (failure) break
      // Reserve before awaiting so concurrent categories cannot overspend the
      // shared budget. Validation and directory reads use the same allowance.
      budget.entries += 1
      const next = await measurement.walk.next()
      if (next.done) {
        measurement.walk = null
        measurement.complete = true
        measurement.error = undefined
      }
    }
  } catch (error) {
    measurement.walk = null
    measurement.error = `${path}: ${messageOf(error)}`
  } finally {
    // A standalone read has no future owner to resume or close its cursor.
    if (!options.measurement && measurement.walk) await measurement.walk.return(undefined)
  }
  if (measurement.complete) return { bytes: measurement.bytes, status: 'ok', entries: measurement.entries }
  const error = measurement.error ?? failure ?? 'the storage measurement was invalidated by maintenance'
  // Only the category root itself was seen: its content is entirely unknown.
  return {
    bytes: measurement.entries > 1 ? measurement.bytes : null,
    status: measurement.entries > 1 ? 'partial' : 'unavailable', entries: measurement.entries, error,
  }
}

export interface StorageBreakdownOptions {
  maxEntries?: number
  timeoutMs?: number
  now?: () => number
  measurement?: StorageMeasurement
}

function retainedStateDirs(home: string): Array<{ key: string, label: string, path: string }> {
  return [
    { key: 'lease-metadata', label: 'Shared checkout coordination (retained)', path: process.env.POISE_LOCK_DIR || join(home, '.poise', 'locks') },
    { key: 'codex-state', label: 'Shared Codex state (retained)', path: process.env.CODEX_HOME || join(home, '.codex') },
    { key: 'claude-state', label: 'Shared Claude state (retained)', path: process.env.CLAUDE_CONFIG_DIR || join(home, '.claude') },
    { key: 'grok-state', label: 'Shared Grok state (retained)', path: process.env.GROK_HOME || join(home, '.grok') },
    { key: 'muse-data', label: 'Shared Muse history (retained)', path: join(process.env.XDG_DATA_HOME || join(home, '.local', 'share'), 'muse') },
    { key: 'muse-config', label: 'Shared Muse configuration (retained)', path: join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'muse') },
  ]
}

/** The workspace storage breakdown: the managed categories plus disk totals.
 *  The categories share one entry budget and one deadline, so one large tree
 *  cannot hold the read past its bound; categories past it report partial or
 *  unavailable instead of a silent zero. */
export async function storageBreakdown(
  home: string = homedir(), chatRoot: string = LOCAL_CHAT_ROOT, stateRoot?: string, options: StorageBreakdownOptions = {},
): Promise<StorageBreakdown> {
  const root = stateRoot ?? poiseStateRoot()
  const caches = cacheDirs(home)
  const clock = options.now ?? Date.now
  const budget = { entries: 0, maxEntries: options.maxEntries ?? STORAGE_SCAN_MAX_ENTRIES }
  const deadlineMs = clock() + (options.timeoutMs ?? STORAGE_SCAN_TIMEOUT_MS)
  const at = options.measurement?.at ?? new Date(clock()).toISOString()
  const measured = await Promise.all([
    { key: 'chat-workers', label: 'Chat worker workspaces', path: join(chatRoot, 'workers') },
    { key: 'review-checkouts', label: 'Review checkouts', path: join(root, 'review-checkouts') },
    { key: 'incident-recovery', label: 'Incident snapshots', path: join(root, 'incident-recovery') },
    { key: 'pip', label: 'pip cache', path: caches.pip },
    { key: 'uv', label: 'uv cache', path: caches.uv },
    { key: 'npm', label: 'npm cache', path: caches.npm },
    { key: 'agent-work', label: 'Issue-review work dirs', path: caches.agentWork },
    { key: 'native-resources', label: 'Native behavior resources', path: join(process.env.AGENT_INTERFACE_DATA_DIR || join(agentInterfaceCwd(), 'data'), 'native-resources') },
    { key: 'mirrors', label: 'GitHub mirrors', path: caches.mirrors },
    ...retainedStateDirs(home),
  ].map(async (category) => {
    let measurement = options.measurement?.directories.get(category.key)
    if (options.measurement && !measurement) {
      measurement = directoryMeasurement()
      measurement.cancelled = options.measurement.cancelled
      options.measurement.directories.set(category.key, measurement)
    }
    const dir = await measureDir(category.path, { budget, deadlineMs, now: clock, measurement })
    return { ...category, bytes: dir.bytes, status: dir.status, error: dir.error }
  }))
  return {
    at, categories: measured, disk: { path: home, ...(await diskUsage(home)) },
    complete: measured.every((category) => category.status === 'ok'),
  }
}

export function claimsForCheckout(checkout: string): WorkspaceClaim[] {
  return sessionsForCheckout(checkout).map((row) => ({
    sessionId: row.id,
    status: row.status,
    updatedAt: row.updatedAt,
    openTurn: getOpenTurn(row.id) !== null,
    queued: readQueue(queueOwner(row.id)).items.some((item) => item.state === 'waiting' || item.state === 'running'),
  }))
}

const ACTIVE_STATUSES = new Set(['running', 'queued', 'starting', 'stopping'])

function latestActivityMs(claims: WorkspaceClaim[], fallbackMs: number): number {
  let latest = fallbackMs
  for (const claim of claims) {
    const at = Date.parse(claim.updatedAt)
    if (Number.isFinite(at) && at > latest) latest = at
  }
  return latest
}

async function gitOut(checkout: string, args: string[]): Promise<string> {
  const result = await runFile('git', args, { cwd: checkout, timeoutMs: 60_000, maxOutputBytes: 1024 * 1024 })
  return result.stdout
}

/** Every local tip needs a remote-tracking ref containing it. A local
 *  default branch, missing upstream or remote-less repository is no copy. */
export async function unpushedBranches(checkout: string): Promise<string[]> {
  const refs = await gitOut(checkout, ['for-each-ref', '--format=%(refname:short)%00%(objectname)', 'refs/heads'])
  const branches = refs.split('\n').map((line) => line.trim()).filter(Boolean)
  const unpushed: string[] = []
  for (const line of branches) {
    const [name, sha] = line.split('\0')
    if (!(await commitPreserved(checkout, sha))) unpushed.push(name)
  }
  return unpushed
}

/** A local reference does not preserve a commit outside the checkout. */
async function commitPreserved(checkout: string, sha: string): Promise<boolean> {
  if (!sha) return false
  return (await gitOut(checkout, ['for-each-ref', '--format=%(refname)', '--contains', sha, 'refs/remotes'])).trim().length > 0
}

async function removePath(path: string, dryRun: boolean): Promise<number> {
  const bytes = await dirSize(path)
  if (!dryRun) await rm(path, { recursive: true, force: true })
  return bytes
}

async function listDirs(parent: string): Promise<string[]> {
  try {
    const entries = await readdir(parent, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => join(parent, entry.name))
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  }
}

async function gitTidy(checkout: string, errors: MaintenanceReport['errors']): Promise<void> {
  try {
    await runFile('git', ['gc', '--auto'], { cwd: checkout, timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 })
    await runFile('git', ['worktree', 'prune'], { cwd: checkout, timeoutMs: 60_000, maxOutputBytes: 1024 * 1024 })
  } catch (error) {
    errors.push({ path: checkout, message: `git tidy failed: ${error instanceof Error ? error.message : String(error)}` })
  }
}

/** Compact the workspaces maintenance keeps. Best-effort: failures are
 *  recorded, never thrown, and a busy lease skips the workspace. */
async function tidyWorkspace(checkout: string, id: string, claims: (checkout: string) => WorkspaceClaim[], report: MaintenanceReport): Promise<void> {
  const lease = new CheckoutLease(canonicalCheckout(checkout), {
    ownerKind: 'poise:chat', ownerId: `maintenance:tidy:${id}`, ownerLabel: `Storage maintenance tidying ${id}`, instance: 'storage-maintenance',
  })
  if (!lease.tryAcquire().acquired) {
    report.held.push({ path: checkout, reason: 'the checkout lease is busy' })
    return
  }
  try {
    if (claims(checkout).some((claim) => claim.openTurn || claim.queued || ACTIVE_STATUSES.has(claim.status))) {
      report.held.push({ path: checkout, reason: 'a turn started or queued while maintenance ran' })
      return
    }
    await gitTidy(checkout, report.errors)
  } finally {
    if (lease.held) lease.release()
  }
}

async function maintainWorkspace(
  checkout: string, options: Required<Pick<MaintenanceOptions, 'now' | 'chatRoot'>> & MaintenanceOptions, report: MaintenanceReport,
): Promise<void> {
  const ref = workerWorkspaceRef(options.chatRoot!, checkout)
  if (!ref) {
    report.held.push({ path: checkout, reason: 'not a workers/<id>/workspace directory; remove it by hand' })
    return
  }
  let canonical: string
  try {
    canonical = canonicalCheckout(checkout)
  } catch (error) {
    report.held.push({ path: checkout, reason: `${error instanceof Error ? error.message : String(error)}; remove it by hand` })
    return
  }
  if (!(await workspaceMarkerValid(canonical))) {
    report.held.push({ path: canonical, reason: 'invalid or missing owner marker; remove it by hand' })
    return
  }
  const claims = (options.claims ?? claimsForCheckout)(canonical)
  if (claims.some((claim) => claim.openTurn || claim.queued || ACTIVE_STATUSES.has(claim.status))) {
    report.held.push({ path: canonical, reason: 'a turn is running or queued' })
    return
  }
  let dirMtime = 0
  try {
    dirMtime = (await lstat(canonical)).mtimeMs
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    throw error
  }
  const latest = latestActivityMs(claims, dirMtime)
  const closed = claims.every((claim) => claim.status === 'closed')
  if (!closed) {
    if (options.now! - latest >= WORKSPACE_IDLE_PRUNE_MS) {
      // Agents can keep source and unique ignored files under any of these
      // names. Neither a name nor Git's ignore rules prove regeneration.
      report.held.push({ path: canonical, reason: 'idle artifacts have no recorded generator provenance; kept to protect user work' })
    } else {
      report.held.push({ path: canonical, reason: 'session open and recently active' })
    }
    if (!(options.dryRun ?? false)) await tidyWorkspace(canonical, ref.id, options.claims ?? claimsForCheckout, report)
    return
  }
  if (options.now! - latest < WORKSPACE_CLOSED_GRACE_MS) {
    report.held.push({ path: canonical, reason: `grace period ends ${new Date(latest + WORKSPACE_CLOSED_GRACE_MS).toISOString()}` })
    if (!(options.dryRun ?? false)) await tidyWorkspace(canonical, ref.id, options.claims ?? claimsForCheckout, report)
    return
  }
  const lease = new CheckoutLease(canonical, {
    ownerKind: 'poise:chat', ownerId: `maintenance:${ref.id}`, ownerLabel: `Storage maintenance removing ${ref.id}`, instance: 'storage-maintenance',
  })
  if (!lease.tryAcquire().acquired) {
    report.held.push({ path: canonical, reason: 'the checkout lease is busy' })
    return
  }
  try {
    // Re-decided under the lease: a session may have resumed meanwhile.
    const fresh = (options.claims ?? claimsForCheckout)(canonical)
    if (fresh.some((claim) => claim.openTurn || claim.queued || ACTIVE_STATUSES.has(claim.status) || claim.status !== 'closed')) {
      report.held.push({ path: canonical, reason: 'the session resumed while maintenance ran' })
      return
    }
    const state = await inspectCheckout(canonical)
    if (state.dirty) {
      report.held.push({ path: canonical, reason: `uncommitted changes (${state.dirtyFiles} file${state.dirtyFiles === 1 ? '' : 's'})` })
      if (!(options.dryRun ?? false)) await gitTidy(canonical, report.errors)
      return
    }
    const unpushed = await unpushedBranches(canonical)
    if (unpushed.length) {
      report.held.push({ path: canonical, reason: `unpushed commits on ${unpushed.join(', ')}` })
      if (!(options.dryRun ?? false)) await gitTidy(canonical, report.errors)
      return
    }
    if (state.detached) {
      if (!(await commitPreserved(canonical, state.headSha))) {
        report.held.push({ path: canonical, reason: 'unpushed commits on a detached HEAD' })
        if (!(options.dryRun ?? false)) await gitTidy(canonical, report.errors)
        return
      }
    }
    const bytes = await removePath(ref.home, options.dryRun ?? false)
    report.removed.push({ path: canonical, bytes })
    report.reclaimedBytes += bytes
  } catch (error) {
    report.errors.push({ path: canonical, message: error instanceof Error ? error.message : String(error) })
  } finally {
    if (lease.held) lease.release()
  }
}

interface CacheFile {
  path: string
  bytes: number
  usedMs: number
  fresh: boolean
}

async function cacheFiles(root: string, now: number): Promise<{ files: CacheFile[], totalBytes: number }> {
  const files: CacheFile[] = []
  let totalBytes = 0
  const stack: string[] = [root]
  while (stack.length) {
    const current = stack.pop()!
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue
      throw error
    }
    if (info.isSymbolicLink()) continue
    if (!info.isDirectory()) {
      totalBytes += info.size
      files.push({ path: current, bytes: info.size, usedMs: info.atimeMs || info.mtimeMs, fresh: now - info.mtimeMs < CACHE_FRESH_MS })
      continue
    }
    let entries
    try {
      entries = await readdir(current)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) stack.push(join(current, entry))
  }
  return { files, totalBytes }
}

/** Enforce a size cap by deleting the least recently used files first. With
 *  relatime (the usual mount default) atime is day-granular; where atime is
 *  unavailable this degrades to oldest-first. Fresh files are never touched. */
async function capCacheDir(key: string, root: string, capBytes: number, now: number, dryRun: boolean, report: MaintenanceReport): Promise<void> {
  const { files, totalBytes } = await cacheFiles(root, now).catch((error) => {
    if (errorCode(error) === 'ENOENT') return { files: [], totalBytes: 0 }
    throw error
  })
  if (totalBytes <= capBytes) return
  const evictable = files.filter((file) => !file.fresh).sort((a, b) => a.usedMs - b.usedMs)
  let over = totalBytes - capBytes
  let evicted = 0
  for (const file of evictable) {
    if (over <= 0) break
    if (!dryRun) {
      try {
        await rm(file.path, { force: true })
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') {
          report.errors.push({ path: file.path, message: error instanceof Error ? error.message : String(error) })
          continue
        }
      }
    }
    over -= file.bytes
    evicted += file.bytes
  }
  if (evicted > 0) {
    report.caches.push({ path: root, bytes: evicted })
    report.reclaimedBytes += evicted
  }
  if (over > 0) {
    report.held.push({ path: root, reason: `${key} cache still ${(over / 1024 ** 2).toFixed(0)} MB over its cap; the rest is in use` })
  }
}

/** Caller owns the mirror layout and its fcntl lock. Eviction must use that
 *  same lock rather than removing owner directories from this process. */
async function capMirrors(root: string, capBytes: number, now: number, dryRun: boolean, report: MaintenanceReport): Promise<void> {
  if (!(await listDirs(root)).length) return
  try {
    const args = ['--prune-mirrors', root, '--cap-bytes', String(capBytes), '--now-ms', String(now), '--fresh-ms', String(CACHE_FRESH_MS)]
    if (dryRun) args.push('--dry-run')
    const { stdout } = await runFile('github-interface', args, { timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 })
    const result: unknown = JSON.parse(stdout)
    if (!result || typeof result !== 'object' || !('removed' in result) || !Array.isArray(result.removed)
      || !('held' in result) || !Array.isArray(result.held)) throw new Error('Caller mirror maintenance returned an invalid report')
    for (const item of result.removed) {
      if (!item || typeof item !== 'object' || !('path' in item) || typeof item.path !== 'string'
        || !('bytes' in item) || typeof item.bytes !== 'number' || !Number.isFinite(item.bytes) || item.bytes < 0) {
        throw new Error('Caller mirror maintenance returned an invalid removal')
      }
      report.caches.push({ path: item.path, bytes: item.bytes })
      report.reclaimedBytes += item.bytes
    }
    for (const item of result.held) {
      if (!item || typeof item !== 'object' || !('path' in item) || typeof item.path !== 'string'
        || !('reason' in item) || typeof item.reason !== 'string') throw new Error('Caller mirror maintenance returned an invalid hold')
      report.held.push({ path: item.path, reason: item.reason })
    }
  } catch (error) {
    report.errors.push({ path: root, message: `Caller mirror maintenance failed: ${error instanceof Error ? error.message : String(error)}` })
  }
}

async function expireEntries(
  root: string, retentionMs: number, now: number, dryRun: boolean, report: MaintenanceReport,
  options: { pinFile?: string } = {},
): Promise<void> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    // Lock files coordinate live processes; maintenance never touches them.
    if (entry.name.endsWith('.lock')) continue
    const path = join(root, entry.name)
    let mtimeMs = 0
    try {
      mtimeMs = (await lstat(path)).mtimeMs
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue
      throw error
    }
    if (now - mtimeMs < retentionMs) continue
    if (options.pinFile && entry.isDirectory()) {
      const pinned = await lstat(join(path, options.pinFile)).then((info) => info.isFile() && !info.isSymbolicLink(), () => false)
      if (pinned) {
        report.held.push({ path, reason: `pinned with a ${options.pinFile} file` })
        continue
      }
    }
    const bytes = await removePath(path, dryRun)
    report.removed.push({ path, bytes })
    report.reclaimedBytes += bytes
  }
}

const unsupportedTrimPaths = new Set<string>()

async function trimFilesystem(path: string): Promise<number | null> {
  if (unsupportedTrimPaths.has(path)) return null
  try {
    const result = await runFile('fstrim', ['-v', path], {
      timeoutMs: 120_000, maxOutputBytes: 64 * 1024,
      expected: { codes: [1], stderr: /^fstrim: .+: the discard operation is not supported\s*$/ },
    })
    const trimmed = /([\d,]+) bytes were trimmed/.exec(result.stdout)?.[1]?.replace(/,/g, '')
    return trimmed !== undefined && /^\d+$/.test(trimmed) ? Number(trimmed) : 0
  } catch (error) {
    if (isExpectedFailure(error)) {
      unsupportedTrimPaths.add(path)
      diagnosticFailure('storage.trim.unsupported', error, { target: path }, { level: 'warning' })
    }
    // runFile's observer retains unexpected failures with their original stderr.
    return null
  }
}

function emptyReport(dryRun: boolean, pressureRun: boolean, startedAt: string): MaintenanceReport {
  return { startedAt, finishedAt: startedAt, dryRun, pressureRun, reclaimedBytes: 0, removed: [], pruned: [], caches: [], held: [], errors: [], trimmedBytes: null }
}

interface NativeCleanupReport { examined: number, released: string[], held: { callId: string, reason: string }[] }
let nativeCleanupPending: Promise<NativeCleanupReport | null> | null = null
let resourceRecovery: BehaviorResourceRecovery | undefined

async function nativeCleanup(dryRun = false): Promise<NativeCleanupReport | null> {
  const perform = async (): Promise<NativeCleanupReport | null> => {
    if (!process.env.POISE_NATIVE_CONTROL) return null
    if (!callerDatabase(process.env.AGENT_INTERFACE_DATA_DIR || join(agentInterfaceCwd(), 'data'), existsSync)) return null
    const { stdout } = await runFile('agent-interface', ['--reclaim-native-resources', ...(dryRun ? ['--dry-run'] : [])],
      { cwd: agentInterfaceCwd(), timeoutMs: 30_000, maxOutputBytes: 256 * 1024 })
    const value: unknown = JSON.parse(stdout)
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
      || !('examined' in value) || !Number.isInteger(value.examined) || Number(value.examined) < 0 || Number(value.examined) > 16
      || !('released' in value) || !Array.isArray(value.released) || !('held' in value) || !Array.isArray(value.held)) {
      throw new Error('Caller native cleanup returned an invalid report')
    }
    const released = value.released.map((id: unknown) => {
      if (typeof id !== 'string' || !HEX32.test(id)) throw new Error('Caller native cleanup returned an invalid Call')
      return id
    })
    const held = value.held.map((item: unknown) => {
      if (!item || typeof item !== 'object' || !('callId' in item) || typeof item.callId !== 'string' || !HEX32.test(item.callId)
        || !('reason' in item) || typeof item.reason !== 'string' || !item.reason || item.reason.length > 2000) {
        throw new Error('Caller native cleanup returned an invalid hold')
      }
      return { callId: item.callId, reason: item.reason }
    })
    const ids = [...released, ...held.map(item => item.callId)]
    if (ids.length !== value.examined || new Set(ids).size !== ids.length) throw new Error('Caller native cleanup returned contradictory counts')
    if (!dryRun && db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'behavior_chain_current'").get()) {
      resourceRecovery ??= new BehaviorResourceRecovery(behaviorChainJournal(), ids => readNativeInvocations(ids, 'resource-recovery'))
      await resourceRecovery.run()
    }
    return { examined: Number(value.examined), released, held }
  }
  if (dryRun) return perform()
  nativeCleanupPending ??= perform().finally(() => { nativeCleanupPending = null })
  return nativeCleanupPending
}

/** Run one maintenance pass. On pressure the caches go first so space comes
 *  back even if workspace work later stalls. */
export async function runStorageMaintenance(options: MaintenanceOptions = {}): Promise<MaintenanceReport> {
  const startedAt = new Date().toISOString()
  const now = options.now ?? Date.now()
  const dryRun = options.dryRun ?? false
  const pressureRun = options.pressureRun ?? false
  const chatRoot = options.chatRoot ?? LOCAL_CHAT_ROOT
  const stateRoot = options.stateRoot ?? poiseStateRoot()
  const home = options.home ?? homedir()
  const report = emptyReport(dryRun, pressureRun, startedAt)
  const caches = cacheDirs(home)
  const caps = { ...CACHE_CAP_BYTES, ...options.caps }

  try {
    const native = await nativeCleanup(dryRun)
    if (native) {
      report.nativeCleanupCompleted = native.released.length
      for (const item of native.held) report.held.push({ path: process.env.AGENT_INTERFACE_DATA_DIR || agentInterfaceCwd(),
        reason: `Native Call ${item.callId}: ${item.reason}` })
    }
  } catch (error) {
    report.errors.push({ message: `Caller native cleanup failed: ${messageOf(error)}` })
  }
  // Inventory never grants deletion authority, including for legacy or
  // unregistered roots. Bound this classification independently of tree size.
  const nativeRoot = join(process.env.AGENT_INTERFACE_DATA_DIR || join(agentInterfaceCwd(), 'data'), 'native-resources')
  try {
    const node = await lstat(nativeRoot)
    if (!node.isDirectory() || node.isSymbolicLink()) report.held.push({ path: nativeRoot, reason: 'Native resource inventory is not an original directory; retained' })
    else {
      const directory = await opendir(nativeRoot)
      let count = 0
      for await (const entry of directory) {
        if (count++ === 16) { report.held.push({ path: nativeRoot, reason: 'More native resource inventory remains; classification bounded to 16 entries' }); break }
        report.held.push({ path: join(nativeRoot, entry.name), reason: 'Retained native resource: only its original current-version receipt can authorize reclamation; legacy and unknown ownership stay held' })
      }
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') report.errors.push({ message: `Native resource inventory unavailable: ${messageOf(error)}` })
  }

  const workspaces = async () => {
    for (const id of await listDirs(join(chatRoot, 'workers'))) {
      const checkout = join(id, 'workspace')
      try {
        await maintainWorkspace(checkout, { ...options, now, chatRoot }, report)
      } catch (error) {
        report.errors.push({ path: checkout, message: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  const snapshots = () => expireEntries(join(stateRoot, 'incident-recovery'), INCIDENT_RECOVERY_RETENTION_MS, now, dryRun, report, { pinFile: 'KEEP' })
  const reviewRuns = async () => {
    try {
      await lstat(caches.agentWork)
      report.held.push({ path: caches.agentWork,
        reason: 'Legacy review resources retained: original ownership and process termination are unverified; native resources require their original cleanup receipts' })
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') report.errors.push({ path: caches.agentWork,
        message: `Legacy review resource inventory unavailable: ${messageOf(error)}` })
    }
  }
  const capCaches = async () => {
    await capCacheDir('pip', caches.pip, caps.pip, now, dryRun, report)
    await capCacheDir('uv', caches.uv, caps.uv, now, dryRun, report)
    await capCacheDir('npm', caches.npm, caps.npm, now, dryRun, report)
    await capMirrors(caches.mirrors, caps.mirrors, now, dryRun, report)
  }

  if (pressureRun) {
    await capCaches()
    await reviewRuns()
    await snapshots()
    await workspaces()
  } else {
    await workspaces()
    await snapshots()
    await reviewRuns()
    await capCaches()
  }

  if (!dryRun) {
    report.trimmedBytes = await (options.trim ?? trimFilesystem)(home)
  }
  report.finishedAt = new Date().toISOString()
  // A real run changes what the summary measures; a dry run changes nothing.
  // The epoch keeps a scan that started before this run from repopulating
  // the cache with pre-maintenance sizes when it finishes, and dropping the
  // in-flight scan keeps reads issued after this run from joining it.
  if (!dryRun) {
    storageCache = null
    storageEpoch += 1
    storageInflight = null
    const abandoned = storageMeasurement
    storageMeasurement = null
    if (abandoned) {
      abandoned.cancelled = true
      for (const measurement of abandoned.directories.values()) measurement.cancelled = true
      await Promise.all([...abandoned.directories.values()].map((measurement) => measurement.walk?.return(undefined)))
    }
  }
  if (!dryRun) {
    try {
      setMeta(LAST_RUN_KEY, JSON.stringify(report))
    } catch (error) {
      console.error('[storage] could not record the maintenance run:', error)
    }
    try {
      diagnostic({
        time: report.finishedAt, level: 'info', operation: 'storage.maintenance',
        message: `Storage maintenance reclaimed ${(report.reclaimedBytes / 1024 ** 2).toFixed(1)} MB`
          + (report.held.length ? `, held ${report.held.length} item${report.held.length === 1 ? '' : 's'}` : '')
          + (report.errors.length ? `, ${report.errors.length} error${report.errors.length === 1 ? '' : 's'}` : ''),
        target: home,
        resources: {
          reclaimedBytes: report.reclaimedBytes, removed: report.removed.length, pruned: report.pruned.length,
          cacheBytes: report.caches.reduce((sum, item) => sum + item.bytes, 0), held: report.held, errors: report.errors,
          trimmedBytes: report.trimmedBytes, pressureRun,
        },
      })
    } catch (error) {
      console.error('[storage] could not log the maintenance run:', error)
    }
    console.log(`[storage] maintenance reclaimed ${(report.reclaimedBytes / 1024 ** 2).toFixed(1)} MB`
      + (report.held.length ? `, held ${report.held.length}` : '') + (report.errors.length ? `, ${report.errors.length} errors` : ''))
  }
  return report
}

export function lastMaintenanceRun(): MaintenanceReport | null {
  try {
    const raw = getMeta(LAST_RUN_KEY)
    return raw ? JSON.parse(raw) as MaintenanceReport : null
  } catch {
    return null
  }
}

export interface StorageStatus extends StorageBreakdown {
  pressure: boolean
  lastRun: MaintenanceReport | null
  /** True when refresh failed or maintenance overtook this observation. */
  stale: boolean
  /** Why a stale observation could not be refreshed. */
  error?: string
}

export interface StorageStatusOptions {
  /** Measure now even when a live cache entry exists (the Settings retry path). */
  fresh?: boolean
  now?: number
  /** Injectable scan; production measures the real trees. */
  breakdown?: (options: StorageBreakdownOptions) => Promise<StorageBreakdown>
}

/** The Settings and diagnostics payload: breakdown, disk, pressure, last run.
 *
 *  One scan answers concurrent readers, and its observation answers Settings
 *  opens until STORAGE_STATUS_TTL_MS passes. A refresh that fails serves the
 *  previous observation marked stale; only a failure with nothing cached
 *  throws. A maintenance run drops the in-flight scan, so reads issued after
 *  it re-measure; the dropped scan answers its own waiters as stale without
 *  repopulating the cache. Fresh reads and cache expiry resume an unfinished
 *  measurement, preserving the age of its earliest totals. */
export async function storageStatus(options: StorageStatusOptions = {}): Promise<StorageStatus> {
  const now = options.now ?? Date.now()
  if (!options.fresh && storageCache && now - storageCache.at < STORAGE_STATUS_TTL_MS) return storageCache.status
  if (!storageInflight) {
    const epoch = storageEpoch
    const measurement = storageMeasurement ??= { at: new Date(now).toISOString(), directories: new Map(), cancelled: false }
    const scan = (async (): Promise<StorageStatus> => {
      try {
        const breakdown = await (options.breakdown
          ? options.breakdown({ measurement })
          : storageBreakdown(undefined, undefined, undefined, { measurement }))
        const invalidated = epoch !== storageEpoch
        const status: StorageStatus = {
          ...breakdown, pressure: breakdown.disk.usedPercent >= PRESSURE_USED_PCT,
          lastRun: lastMaintenanceRun(), complete: breakdown.complete && !invalidated, stale: invalidated,
          error: invalidated ? 'the storage measurement was invalidated by maintenance' : undefined,
        }
        // A maintenance run that finished mid-scan invalidated the cache; its
        // sizes are stale, so this observation answers its own waiters only.
        if (!invalidated) {
          storageCache = { at: now, status }
          if (breakdown.complete) storageMeasurement = null
        }
        return status
      } catch (error) {
        if (storageCache) {
          return { ...storageCache.status, stale: true, error: messageOf(error) }
        }
        throw error
      }
    })()
    storageInflight = scan
    // An older scan must not clear a newer one a maintenance run started. A
    // two-handler then, not finally: the scan itself may reject, and that
    // rejection already has its waiter.
    const settled = () => { if (storageInflight === scan) storageInflight = null }
    void scan.then(settled, settled)
  }
  return storageInflight
}

let running: Promise<MaintenanceReport> | null = null
let lastPressureRun = 0
let storageCache: { at: number, status: StorageStatus } | null = null
let storageInflight: Promise<StorageStatus> | null = null
let storageEpoch = 0
let storageMeasurement: StorageMeasurement | null = null

/** One pass unless one is already running, in which case the running report. */
export function runStorageMaintenanceOnce(options: MaintenanceOptions = {}): Promise<MaintenanceReport> {
  if (running) return running
  const release = trackReleaseBackground()
  running = runStorageMaintenance(options).finally(() => {
    running = null
    release()
  })
  return running
}

export function maintenanceRunning(): boolean {
  return running !== null
}

/** Measure home-volume pressure: past the threshold, run maintenance at once
 *  and alert; below the clear line, resolve. Warn on crossings only. */
export async function checkWorkspacePressure(
  home: string = homedir(),
  read: () => Promise<{ bavail: number, bsize: number, blocks: number }> = () => statfs(home),
  run: (options: MaintenanceOptions) => Promise<MaintenanceReport> = (opts) => runStorageMaintenanceOnce(opts),
): Promise<{ usedPercent: number, ran: boolean }> {
  let stats
  try {
    stats = await read()
  } catch (error) {
    console.error('[storage] could not measure workspace disk pressure:', error)
    return { usedPercent: 0, ran: false }
  }
  const total = stats.blocks * stats.bsize
  const usedPercent = total > 0 ? (100 * (total - stats.bavail * stats.bsize)) / total : 0
  if (usedPercent < PRESSURE_CLEAR_PCT) {
    try {
      resolveAlert(PRESSURE_ALERT_KEY)
    } catch (error) {
      console.error('[storage] could not resolve the pressure alert:', error)
    }
    return { usedPercent, ran: false }
  }
  if (usedPercent < PRESSURE_USED_PCT) return { usedPercent, ran: false }
  const now = Date.now()
  if (now - lastPressureRun < PRESSURE_RUN_COOLDOWN_MS || maintenanceRunning()) return { usedPercent, ran: false }
  lastPressureRun = now
  let report: MaintenanceReport | null = null
  try {
    report = await run({ pressureRun: true })
  } catch (error) {
    console.error('[storage] pressure maintenance failed:', error)
  }
  try {
    const freeGb = ((stats.bavail * stats.bsize) / 1024 ** 3).toFixed(1)
    raiseAlert({
      kind: 'storage_low',
      dedupeKey: PRESSURE_ALERT_KEY,
      title: `Workspace disk is ${usedPercent.toFixed(0)}% full`,
      body: `${freeGb} GB free. Maintenance ran, shedding caches first`
        + (report ? ` and reclaiming ${(report.reclaimedBytes / 1024 ** 2).toFixed(1)} MB` : ' and failed') + '.',
      path: '/',
      target: { settings: 'general' },
    })
  } catch (error) {
    console.error('[storage] could not record the pressure alert:', error)
  }
  return { usedPercent, ran: true }
}

let maintenanceTimer: ReturnType<typeof setInterval> | null = null
let pressureTimer: ReturnType<typeof setInterval> | null = null
let pressurePass: Promise<unknown> | null = null

/** How long a start waits for its first pass: every 6 hours counted from the
 *  last finished run, which a restart keeps, never within MAINTENANCE_START_DELAY_MS
 *  of the start, and never more than one interval when the clock went back. */
export function firstMaintenanceDelay(now: number, last: Pick<MaintenanceReport, 'finishedAt'> | null): number {
  const finished = Date.parse(last?.finishedAt ?? '')
  const due = Number.isFinite(finished) ? finished + MAINTENANCE_INTERVAL_MS - now : 0
  return Math.min(MAINTENANCE_INTERVAL_MS, Math.max(MAINTENANCE_START_DELAY_MS, due))
}

export function startStorageMaintenanceRuntime(): void {
  if (maintenanceTimer) return
  const pass = () => {
    if (releaseBackgroundPaused() || releaseSwitchPending()) return
    void runStorageMaintenanceOnce().catch((error: unknown) => console.error('[storage] maintenance failed:', error))
  }
  maintenanceTimer = setTimeout(() => {
    pass()
    maintenanceTimer = setInterval(pass, MAINTENANCE_INTERVAL_MS)
    maintenanceTimer.unref?.()
  }, firstMaintenanceDelay(Date.now(), lastMaintenanceRun()))
  maintenanceTimer.unref?.()
  const pressure = () => {
    if (pressurePass) return
    const finished = trackReleaseBackground()
    pressurePass = (async () => {
      try { await nativeCleanup() }
      catch (error) { console.error('[storage] native cleanup failed:', error) }
      return checkWorkspacePressure()
    })().finally(() => { pressurePass = null; finished() })
  }
  pressureTimer = setInterval(pressure, PRESSURE_CHECK_MS)
  pressureTimer.unref?.()
  pressure()
}

export async function stopStorageMaintenanceRuntime(): Promise<void> {
  if (maintenanceTimer) clearInterval(maintenanceTimer)
  if (pressureTimer) clearInterval(pressureTimer)
  maintenanceTimer = null
  pressureTimer = null
  await pressurePass
  await running?.catch(() => undefined)
}

interface PruneMarker {
  prunedAt: string
  pruned: string[]
}

/** Reinstall what maintenance pruned, on the next turn. Best-effort and
 *  non-fatal: whatever still fails is the agent's to reinstall. Runs under
 *  the turn's checkout lease. An abort stops the installers and propagates,
 *  like any other awaited preparation work — best-effort never means
 *  unkillable. */
export async function restorePrunedArtifacts(
  checkout: string,
  chatRoot: string = LOCAL_CHAT_ROOT,
  run: (command: string, args: readonly string[], options?: { cwd?: string, timeoutMs?: number, signal?: AbortSignal }) => Promise<{ stdout: string }> = (command, args, opts) =>
    runFile(command, args, { ...opts, timeoutMs: opts?.timeoutMs ?? 300_000, maxOutputBytes: 1024 * 1024 }),
  options: { signal?: AbortSignal } = {},
): Promise<string[]> {
  const ref = workerWorkspaceRef(chatRoot, checkout)
  if (!ref) return []
  options.signal?.throwIfAborted()
  const markerPath = join(ref.home, PRUNE_MARKER)
  let marker: PruneMarker
  try {
    marker = JSON.parse(await readFile(markerPath, 'utf8')) as PruneMarker
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  }
  if (!Array.isArray(marker.pruned)) {
    await rm(markerPath, { force: true })
    return []
  }
  const restored: string[] = []
  const missing = async (name: string): Promise<boolean> => lstat(join(checkout, name)).then(() => false, () => true)
  try {
    if (marker.pruned.includes('node_modules') && (await missing('node_modules')) && !(await missing('package.json'))) {
      const lockfile = !(await missing('package-lock.json')) ? 'npm-ci'
        : !(await missing('yarn.lock')) ? 'yarn' : !(await missing('pnpm-lock.yaml')) ? 'pnpm' : 'npm-install'
      const [command, args] = lockfile === 'npm-ci' ? ['npm', ['ci', '--no-audit', '--no-fund'] as const]
        : lockfile === 'yarn' ? ['yarn', ['install', '--frozen-lockfile'] as const]
          : lockfile === 'pnpm' ? ['pnpm', ['install', '--frozen-lockfile'] as const]
            : ['npm', ['install', '--no-audit', '--no-fund'] as const]
      await run(command, [...args], { cwd: checkout, timeoutMs: 300_000, ...(options.signal ? { signal: options.signal } : {}) })
      restored.push('node_modules')
    }
    const venv = marker.pruned.find((name) => (name === '.venv' || name === 'venv'))
    if (venv && (await missing(venv)) && !(await missing('requirements.txt'))) {
      await run('python3', ['-m', 'venv', venv], { cwd: checkout, timeoutMs: 120_000, ...(options.signal ? { signal: options.signal } : {}) })
      const pip = process.platform === 'win32' ? join(venv, 'Scripts', 'pip') : join(venv, 'bin', 'pip')
      await run(pip, ['install', '-r', 'requirements.txt'], { cwd: checkout, timeoutMs: 300_000, ...(options.signal ? { signal: options.signal } : {}) })
      restored.push(venv)
    }
  } catch (error) {
    if (isAbortError(error)) throw error
    console.error(`[storage] reinstalling pruned artifacts in ${checkout} failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await rm(markerPath, { force: true })
  }
  return restored
}
