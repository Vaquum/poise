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
import { statfs } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getMeta, setMeta } from './db'
import { diagnostic } from './logging'
import { runFile } from './process'
import { raiseAlert, resolveAlert } from './alerts/store'
import { canonicalCheckout, CheckoutLease } from './chat/checkout-lock'
import { inspectCheckout } from './chat/git'
import { LOCAL_CHAT_ROOT, workerWorkspaceRef, workspaceMarkerValid } from './chat/local-workspace'
import { getOpenTurn, sessionsForCheckout } from './chat/storage'
import { queueOwner, readQueue } from './chat/message-queue'
import { poiseStateRoot } from './review-checkout'

/** Closed sessions keep their workspace this long before it may be removed. */
export const WORKSPACE_CLOSED_GRACE_MS = 24 * 60 * 60_000
/** Idle artifacts need generator provenance before they may be pruned. */
export const WORKSPACE_IDLE_PRUNE_MS = 3 * 24 * 60 * 60_000
/** Incident snapshots expire after this unless pinned with a KEEP file. */
export const INCIDENT_RECOVERY_RETENTION_MS = 30 * 24 * 60 * 60_000
/** Crashed issue-review runs expire after this. Caller sweeps stale runs
 *  itself within hours; this is the backstop (reviews never run this long). */
export const ISSUE_REVIEW_RUN_RETENTION_MS = 7 * 24 * 60 * 60_000
/** Full maintenance runs on this timer, and at startup. */
export const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60_000
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
}

export interface MeasuredDir {
  bytes: number | null
  status: StorageCategoryStatus
  entries: number
  error?: string
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
  let top
  try {
    top = await lstat(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { bytes: 0, status: 'ok', entries: 0 }
    return { bytes: null, status: 'unavailable', entries: 0, error: messageOf(error) }
  }
  const beforeStart = expired()
  if (beforeStart) return { bytes: null, status: 'unavailable', entries: 0, error: beforeStart }
  if (!top.isDirectory() || top.isSymbolicLink()) {
    budget.entries += 1
    return { bytes: top.size, status: 'ok', entries: 1 }
  }
  let total = 0
  let entries = 0
  let failure: string | null = null
  const stack: string[] = [path]
  while (stack.length) {
    const limit = expired()
    if (limit) {
      failure = limit
      break
    }
    const current = stack.pop()!
    let info
    try {
      info = current === path ? top : await lstat(current)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue
      failure ??= `${current}: ${messageOf(error)}`
      continue
    }
    entries += 1
    budget.entries += 1
    total += info.size
    if (!info.isDirectory() || info.isSymbolicLink()) continue
    try {
      // Read incrementally: one readdir call would load and queue every
      // child of a wide directory before either budget is checked again.
      // Queueing past what the entry budget can still visit is pointless,
      // so the budget gates pushes as well as pops. Manual reads, not
      // for-await: the iterator closes the handle by itself, which would
      // make the explicit close below throw.
      const dir = await opendir(current)
      try {
        let sinceCheck = 0
        let entry = await dir.read()
        while (entry) {
          stack.push(join(current, entry.name))
          sinceCheck += 1
          if (sinceCheck >= 64) {
            sinceCheck = 0
            const limit = expired()
              ?? (stack.length > budget.maxEntries - budget.entries + 64 ? `the storage scan stopped after ${budget.maxEntries} entries` : null)
            // Stops reading, not examining: what is already queued is still
            // measured below, up to the budget.
            if (limit) {
              failure = limit
              break
            }
          }
          entry = await dir.read()
        }
      } finally {
        await dir.close()
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue
      failure ??= `${current}: ${messageOf(error)}`
    }
  }
  if (!failure) return { bytes: total, status: 'ok', entries }
  // Only the category root itself was seen: its content is entirely unknown.
  if (entries <= 1) return { bytes: null, status: 'unavailable', entries, error: failure }
  return { bytes: total, status: 'partial', entries, error: failure }
}

export interface StorageBreakdownOptions {
  maxEntries?: number
  timeoutMs?: number
  now?: () => number
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
  const measured = await Promise.all([
    { key: 'chat-workers', label: 'Chat worker workspaces', path: join(chatRoot, 'workers') },
    { key: 'review-checkouts', label: 'Review checkouts', path: join(root, 'review-checkouts') },
    { key: 'incident-recovery', label: 'Incident snapshots', path: join(root, 'incident-recovery') },
    { key: 'pip', label: 'pip cache', path: caches.pip },
    { key: 'uv', label: 'uv cache', path: caches.uv },
    { key: 'npm', label: 'npm cache', path: caches.npm },
    { key: 'agent-work', label: 'Issue-review work dirs', path: caches.agentWork },
    { key: 'mirrors', label: 'GitHub mirrors', path: caches.mirrors },
  ].map(async (category) => {
    const dir = await measureDir(category.path, { budget, deadlineMs, now: clock })
    return { ...category, bytes: dir.bytes, status: dir.status, error: dir.error }
  }))
  return {
    at: new Date().toISOString(), categories: measured, disk: { path: home, ...(await diskUsage(home)) },
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
  options: { pinFile?: string, namePattern?: RegExp } = {},
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
    if (options.namePattern && !options.namePattern.test(entry.name)) continue
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

async function trimFilesystem(path: string): Promise<number | null> {
  try {
    const result = await runFile('fstrim', ['-v', path], { timeoutMs: 120_000, maxOutputBytes: 64 * 1024 })
    const trimmed = /([\d,]+) bytes were trimmed/.exec(result.stdout)?.[1]?.replace(/,/g, '')
    return trimmed !== undefined && /^\d+$/.test(trimmed) ? Number(trimmed) : 0
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    console.error(`[storage] fstrim failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function emptyReport(dryRun: boolean, pressureRun: boolean, startedAt: string): MaintenanceReport {
  return { startedAt, finishedAt: startedAt, dryRun, pressureRun, reclaimedBytes: 0, removed: [], pruned: [], caches: [], held: [], errors: [], trimmedBytes: null }
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
  const reviewRuns = () => expireEntries(caches.agentWork, ISSUE_REVIEW_RUN_RETENTION_MS, now, dryRun, report, { namePattern: HEX32 })
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
  /** True when this is the previous observation, served because a refresh failed. */
  stale: boolean
  /** Why a stale observation could not be refreshed. */
  error?: string
}

export interface StorageStatusOptions {
  /** Measure now even when a live cache entry exists (the Settings retry path). */
  fresh?: boolean
  now?: number
  /** Injectable scan; production measures the real trees. */
  breakdown?: () => Promise<StorageBreakdown>
}

/** The Settings and diagnostics payload: breakdown, disk, pressure, last run.
 *
 *  One scan answers concurrent readers, and its observation answers Settings
 *  opens until STORAGE_STATUS_TTL_MS passes. A refresh that fails serves the
 *  previous observation marked stale; only a failure with nothing cached
 *  throws. A maintenance run drops the in-flight scan, so reads issued after
 *  it re-measure; the dropped scan answers its own waiters without
 *  repopulating the cache. */
export async function storageStatus(options: StorageStatusOptions = {}): Promise<StorageStatus> {
  const now = options.now ?? Date.now()
  if (!options.fresh && storageCache && now - storageCache.at < STORAGE_STATUS_TTL_MS) return storageCache.status
  if (!storageInflight) {
    const epoch = storageEpoch
    const scan = (async (): Promise<StorageStatus> => {
      try {
        const breakdown = await (options.breakdown ?? storageBreakdown)()
        const status: StorageStatus = {
          ...breakdown, pressure: breakdown.disk.usedPercent >= PRESSURE_USED_PCT,
          lastRun: lastMaintenanceRun(), stale: false, error: undefined,
        }
        // A maintenance run that finished mid-scan invalidated the cache; its
        // sizes are stale, so this observation answers its own waiters only.
        if (epoch === storageEpoch) storageCache = { at: now, status }
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

/** One pass unless one is already running, in which case the running report. */
export function runStorageMaintenanceOnce(options: MaintenanceOptions = {}): Promise<MaintenanceReport> {
  running ??= runStorageMaintenance(options).finally(() => { running = null })
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

export function startStorageMaintenanceRuntime(): void {
  if (maintenanceTimer) return
  void runStorageMaintenanceOnce().catch((error: unknown) => console.error('[storage] maintenance failed:', error))
  maintenanceTimer = setInterval(() => {
    void runStorageMaintenanceOnce().catch((error: unknown) => console.error('[storage] maintenance failed:', error))
  }, MAINTENANCE_INTERVAL_MS)
  maintenanceTimer.unref?.()
  const pressure = () => {
    if (pressurePass) return
    pressurePass = checkWorkspacePressure().finally(() => { pressurePass = null })
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
 *  the turn's checkout lease. */
export async function restorePrunedArtifacts(
  checkout: string,
  chatRoot: string = LOCAL_CHAT_ROOT,
  run: (command: string, args: readonly string[], options?: { cwd?: string, timeoutMs?: number }) => Promise<{ stdout: string }> = (command, args, opts) =>
    runFile(command, args, { ...opts, timeoutMs: opts?.timeoutMs ?? 300_000, maxOutputBytes: 1024 * 1024 }),
): Promise<string[]> {
  const ref = workerWorkspaceRef(chatRoot, checkout)
  if (!ref) return []
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
      await run(command, [...args], { cwd: checkout, timeoutMs: 300_000 })
      restored.push('node_modules')
    }
    const venv = marker.pruned.find((name) => (name === '.venv' || name === 'venv'))
    if (venv && (await missing(venv)) && !(await missing('requirements.txt'))) {
      await run('python3', ['-m', 'venv', venv], { cwd: checkout, timeoutMs: 120_000 })
      const pip = process.platform === 'win32' ? join(venv, 'Scripts', 'pip') : join(venv, 'bin', 'pip')
      await run(pip, ['install', '-r', 'requirements.txt'], { cwd: checkout, timeoutMs: 300_000 })
      restored.push(venv)
    }
  } catch (error) {
    console.error(`[storage] reinstalling pruned artifacts in ${checkout} failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await rm(markerPath, { force: true })
  }
  return restored
}
