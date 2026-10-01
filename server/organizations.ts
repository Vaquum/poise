import Database from 'better-sqlite3'
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { db, getMeta } from './db'
import { ProcessLockError, withProcessLock } from './process-lock'
import { runFile } from './process'
import { releaseBackgroundPaused, trackReleaseBackground } from './release-background'

export interface Organization {
  login: string
  datastorePath?: string
  managed: boolean
  status: 'initializing' | 'ready' | 'error'
  stage: string
  error: string | null
  activatedAt: string | null
}

interface OrganizationRow {
  login: string
  datastore_path: string | null
  managed: number
  status: Organization['status']
  stage: string
  error: string | null
  activated_at: string | null
  last_sync_at: number
  last_reconcile_at: number
  indexed_user: string | null
  next_sync_at: number
  sync_failures: number
}

// The existing Caller database remains externally managed. Only databases
// created for newly added organizations are initialized and synced here.
db.exec(`
  CREATE TABLE IF NOT EXISTS organizations (
    login TEXT PRIMARY KEY COLLATE NOCASE,
    datastore_path TEXT,
    managed INTEGER NOT NULL,
    status TEXT NOT NULL,
    stage TEXT NOT NULL,
    error TEXT,
    activated_at TEXT,
    last_sync_at INTEGER NOT NULL DEFAULT 0,
    last_reconcile_at INTEGER NOT NULL DEFAULT 0,
    indexed_user TEXT,
    next_sync_at INTEGER NOT NULL DEFAULT 0,
    sync_failures INTEGER NOT NULL DEFAULT 0
  );
`)

// Keep this migration additive for registries created by an earlier build.
db.transaction(() => {
  const columns = db.prepare('PRAGMA table_info(organizations)').all() as Array<{ name: string }>
  for (const column of ['next_sync_at', 'sync_failures']) {
    if (!columns.some((entry) => entry.name === column)) {
      db.exec(`ALTER TABLE organizations ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`)
    }
  }
}).immediate()

const RUNTIME_TICK_MS = 5_000
const SYNC_INTERVAL_MS = 60_000
const RECONCILE_INTERVAL_MS = 60 * 60_000
const CLI_TIMEOUT_MS = 30 * 60_000
let timer: ReturnType<typeof setInterval> | undefined
let stopping = false
const jobs = new Map<string, { controller: AbortController, promise: Promise<void> }>()

export function normalizeOrganizationLogin(value: unknown): string {
  const login = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(login) || login.includes('--')) {
    throw new Error('Use a GitHub organization name or personal username (1–39 letters, numbers, or single hyphens).')
  }
  return login
}

function fromRow(row: OrganizationRow): Organization {
  const pendingUser = row.status === 'ready' && row.managed && row.indexed_user !== getMeta('me')?.trim()
  return {
    login: row.login,
    ...(row.datastore_path ? { datastorePath: row.datastore_path } : {}),
    managed: !!row.managed,
    status: pendingUser ? 'initializing' : row.status,
    stage: pendingUser ? 'building-user' : row.stage,
    error: row.error,
    activatedAt: row.activated_at,
  }
}

function legacyOrganization(): Organization | null {
  const login = getMeta('org')?.trim()
  if (!login) return null
  return {
    login,
    ...(process.env.POISE_DATASTORE_DB ? { datastorePath: process.env.POISE_DATASTORE_DB } : {}),
    managed: false,
    status: 'ready',
    stage: 'ready',
    error: null,
    activatedAt: null,
  }
}

function rowFor(login: string): OrganizationRow | undefined {
  return db.prepare('SELECT * FROM organizations WHERE login = ? COLLATE NOCASE').get(login) as OrganizationRow | undefined
}

export function getOrganizations(): Organization[] {
  const rows = db.prepare('SELECT * FROM organizations ORDER BY rowid').all() as OrganizationRow[]
  const result = rows.map(fromRow)
  const legacy = legacyOrganization()
  if (legacy && !result.some((org) => org.login.toLowerCase() === legacy.login.toLowerCase())) result.unshift(legacy)
  return result
}

export function readyOrganizations(): Organization[] {
  return getOrganizations().filter((org) => org.status === 'ready')
}

export function organizationArgs(org: Organization, args: readonly string[]): string[] {
  return org.datastorePath ? ['--db', org.datastorePath, ...args] : [...args]
}

export function organizationForRepository(repo: string): Organization | undefined {
  const owner = repo.split('/')[0]?.toLowerCase()
  return readyOrganizations().find((org) => org.login.toLowerCase() === owner)
}

function managedPath(login: string): string {
  const poiseDb = process.env.POISE_DB
  const root = poiseDb && poiseDb !== ':memory:' ? dirname(resolve(poiseDb)) : join(homedir(), '.poise')
  return join(root, 'datastores', login, 'github.sqlite')
}

export function addOrganization(value: unknown): Organization {
  const login = normalizeOrganizationLogin(value)
  const current = getOrganizations().find((org) => org.login.toLowerCase() === login)
  if (current) {
    if (current.status === 'initializing') launch(login)
    return current
  }
  const insert = db.transaction(() => {
    // Capture the existing configuration before any later settings change.
    const legacy = legacyOrganization()
    if (legacy) db.prepare(`
      INSERT OR IGNORE INTO organizations(login, datastore_path, managed, status, stage)
      VALUES (?, ?, 0, 'ready', 'ready')
    `).run(legacy.login, legacy.datastorePath ?? null)
    db.prepare(`
      INSERT OR IGNORE INTO organizations(login, datastore_path, managed, status, stage)
      VALUES (?, ?, 1, 'initializing', 'queued')
    `).run(login, managedPath(login))
  })
  insert.immediate()
  launch(login)
  return fromRow(rowFor(login)!)
}

export function retryOrganization(value: string): Organization {
  const login = normalizeOrganizationLogin(value)
  const row = rowFor(login)
  if (!row) throw new Error('GitHub account is not configured.')
  if (!row.managed) return fromRow(row)
  if (row.status === 'error') {
    db.prepare("UPDATE organizations SET status = 'initializing', stage = 'queued', error = NULL WHERE login = ?").run(login)
  } else if (row.status === 'ready') {
    db.prepare('UPDATE organizations SET last_sync_at = 0, next_sync_at = 0 WHERE login = ?').run(login)
  }
  launch(login)
  return fromRow(rowFor(login)!)
}

function stage(login: string, value: string): void {
  db.prepare('UPDATE organizations SET stage = ? WHERE login = ?').run(value, login)
}

async function githubEnvironment(me: string | undefined, signal: AbortSignal): Promise<NodeJS.ProcessEnv> {
  if (!me) throw new Error('Set your GitHub username in Settings before adding an account.')
  let token: string
  try {
    token = (await runFile('gh', ['auth', 'token', '--hostname', 'github.com', '--user', me], {
      env: {
        GH_HOST: undefined, GH_TOKEN: undefined, GITHUB_TOKEN: undefined,
        GH_ENTERPRISE_TOKEN: undefined, GITHUB_ENTERPRISE_TOKEN: undefined,
      },
      timeoutMs: 15_000,
      maxOutputBytes: 64 * 1024,
      signal,
    })).stdout.trim()
  } catch (error) {
    if (signal.aborted) throw error
    // Credential subprocess output must never enter the durable status row.
    throw new Error(`GitHub authentication is unavailable for ${me}. Run gh auth login for that account and retry.`)
  }
  if (!token) throw new Error(`GitHub authentication returned no credential for ${me}.`)
  return {
    GH_HOST: 'github.com', GH_TOKEN: token, GITHUB_TOKEN: undefined,
    GH_ENTERPRISE_TOKEN: undefined, GITHUB_ENTERPRISE_TOKEN: undefined,
    GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
    HTTPS_PROXY: process.env.HTTPS_PROXY, HTTP_PROXY: process.env.HTTP_PROXY,
    ALL_PROXY: process.env.ALL_PROXY, NO_PROXY: process.env.NO_PROXY,
  }
}

function safeError(error: unknown, env?: NodeJS.ProcessEnv): string {
  const message = error instanceof Error ? error.message : String(error)
  const stderr = (error as { stderr?: unknown })?.stderr
  const lastLine = typeof stderr === 'string' ? stderr.trim().split('\n').at(-1) : undefined
  const detail = lastLine ? `${message}: ${lastLine}` : message
  return (env?.GH_TOKEN ? detail.split(env.GH_TOKEN).join('[redacted]') : detail)
    .replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g, '[redacted]').slice(0, 1_000)
}

async function caller(path: string, args: readonly string[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
  const { stdout } = await runFile('github-datastore', ['--db', path, ...args], {
    env, signal, timeoutMs: CLI_TIMEOUT_MS, maxOutputBytes: 4 * 1024 * 1024,
  })
  return stdout
}

function databaseState(path: string): { login: string | null, complete: boolean } {
  const connection = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const rows = connection.prepare("SELECT key, value FROM sync_state WHERE scope = 'org'").all() as Array<{ key: string, value: string }>
    return {
      login: rows.find((row) => row.key === 'login')?.value ?? null,
      complete: !!rows.find((row) => row.key === 'last_full_build_at')?.value,
    }
  } finally { connection.close() }
}

function assertOrganization(path: string, login: string): void {
  const state = databaseState(path)
  if (state.login?.toLowerCase() !== login.toLowerCase() || !state.complete) {
    throw new Error('Datastore does not contain a completed index for this account.')
  }
}

async function checkHealth(path: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  const result = JSON.parse(await caller(path, ['health', '--max-age-seconds', '120'], env, signal)) as Record<string, unknown>
  if (result.healthy !== true || result.status !== 'healthy' || result.action !== 'health'
    || typeof result.database !== 'string' || resolve(result.database) !== resolve(path)) {
    throw new Error('Datastore health check did not confirm a fresh index.')
  }
}

function publishDatabase(tempPath: string, targetPath: string): void {
  // No readers can see the staging database. Flush WAL before publishing its
  // single main file, so an interrupted activation cannot expose partial data.
  const connection = new Database(tempPath, { fileMustExist: true })
  try { connection.pragma('wal_checkpoint(TRUNCATE)') } finally { connection.close() }
  chmodSync(tempPath, 0o600)
  renameSync(tempPath, targetPath)
}

async function activate(row: OrganizationRow, me: string, signal: AbortSignal, env: NodeJS.ProcessEnv): Promise<void> {
  const path = row.datastore_path!
  const tempPath = `${path}.initializing`
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  let sourcePath = existsSync(path) ? path : tempPath
  let reused = sourcePath === path
  if (sourcePath === path) {
    // A crash after publication can leave status at initializing. Adopt only
    // the exact organization's completed database; never reinitialize it.
    assertOrganization(path, row.login)
  } else {
    let resumable = false
    if (existsSync(tempPath)) {
      try {
        const state = databaseState(tempPath)
        resumable = state.login?.toLowerCase() === row.login.toLowerCase() && state.complete
      } catch { resumable = false }
    }
    reused = resumable
    if (!resumable) {
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${tempPath}${suffix}`, { force: true })
      stage(row.login, 'indexing')
      await caller(tempPath, ['init-org', row.login], env, signal)
      assertOrganization(tempPath, row.login)
    }
  }
  // Completed staging may have been empty when build-user first failed.
  // Refresh retained data before rebuilding the user so Retry can discover
  // issues created remotely since that attempt, without reinitializing it.
  if (reused) {
    stage(row.login, 'syncing')
    await caller(sourcePath, ['sync'], env, signal)
  }
  stage(row.login, 'building-user')
  await caller(sourcePath, ['build-user', me], env, signal)
  stage(row.login, 'syncing')
  await caller(sourcePath, ['sync'], env, signal)
  stage(row.login, 'checking')
  await checkHealth(sourcePath, env, signal)
  signal.throwIfAborted()
  if (sourcePath === tempPath) publishDatabase(tempPath, path)
  db.prepare(`
    UPDATE organizations SET status = 'ready', stage = 'ready', error = NULL,
      activated_at = COALESCE(activated_at, ?), last_sync_at = ?, last_reconcile_at = ?, indexed_user = ?
    WHERE login = ?
  `).run(new Date().toISOString(), Date.now(), Date.now(), me, row.login)
}

async function synchronize(row: OrganizationRow, me: string, signal: AbortSignal, env: NodeJS.ProcessEnv): Promise<void> {
  const path = row.datastore_path!
  assertOrganization(path, row.login)
  if (row.indexed_user !== me) {
    stage(row.login, 'building-user')
    await caller(path, ['build-user', me], env, signal)
  }
  stage(row.login, 'syncing')
  await caller(path, ['sync'], env, signal)
  const reconcile = Date.now() - row.last_reconcile_at >= RECONCILE_INTERVAL_MS
  if (reconcile) {
    stage(row.login, 'reconciling')
    await caller(path, ['sync', '--reconcile'], env, signal)
    // Reconciliation does not advance Caller's last_sync_at freshness marker.
    await caller(path, ['sync'], env, signal)
  }
  await checkHealth(path, env, signal)
  db.prepare(`
    UPDATE organizations SET stage = 'ready', error = NULL, last_sync_at = ?,
      last_reconcile_at = ?, indexed_user = ?, next_sync_at = 0, sync_failures = 0 WHERE login = ?
  `).run(Date.now(), reconcile ? Date.now() : row.last_reconcile_at, me, row.login)
}

function launch(login: string): void {
  const key = login.toLowerCase()
  if (stopping || jobs.has(key) || releaseBackgroundPaused()) return
  const releaseOperation = trackReleaseBackground()
  const controller = new AbortController()
  const promise = Promise.resolve().then(async () => {
    const initial = rowFor(login)
    if (!initial?.managed || !initial.datastore_path) return
    let env: NodeJS.ProcessEnv | undefined
    try {
      const directory = dirname(initial.datastore_path)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      chmodSync(directory, 0o700)
      await withProcessLock({ path: `${initial.datastore_path}.lock`, timeoutMs: 50 }, async () => {
        const row = rowFor(login)!
        controller.signal.throwIfAborted()
        // Recheck under the process lock: another Poise instance may have
        // completed this work while we waited for ownership.
        if (row.status === 'error') return
        const me = getMeta('me')?.trim()
        if (row.status === 'ready' && row.next_sync_at > Date.now()) return
        if (row.status === 'ready' && row.indexed_user === me && Date.now() - row.last_sync_at < SYNC_INTERVAL_MS) return
        if (row.status === 'initializing') stage(login, 'authenticating')
        env = await githubEnvironment(me, controller.signal)
        if (row.status === 'ready') await synchronize(row, me!, controller.signal, env)
        else await activate(row, me!, controller.signal, env)
      })
    } catch (error) {
      if (controller.signal.aborted || error instanceof ProcessLockError) return
      const failed = rowFor(login)!
      const failures = failed.activated_at ? failed.sync_failures + 1 : 0
      const retryAt = failures ? Date.now() + Math.min(SYNC_INTERVAL_MS * 2 ** Math.min(failures - 1, 6), RECONCILE_INTERVAL_MS) : 0
      db.prepare(`
        UPDATE organizations SET status = CASE WHEN activated_at IS NULL THEN 'error' ELSE 'ready' END,
          stage = CASE WHEN activated_at IS NULL THEN stage ELSE 'sync-error' END, error = ?,
          next_sync_at = ?, sync_failures = ? WHERE login = ?
      `).run(safeError(error, env), retryAt, failures, login)
    }
  }).finally(() => { jobs.delete(key); releaseOperation() })
  jobs.set(key, { controller, promise })
}

export function startOrganizationsRuntime(): void {
  if (timer) return
  stopping = false
  const tick = () => {
    for (const organization of getOrganizations()) {
      if (organization.managed && organization.status !== 'error') launch(organization.login)
    }
  }
  tick()
  timer = setInterval(tick, RUNTIME_TICK_MS)
  timer.unref()
}

export async function stopOrganizationsRuntime(): Promise<void> {
  stopping = true
  if (timer) clearInterval(timer)
  timer = undefined
  const current = [...jobs.values()]
  current.forEach((job) => job.controller.abort())
  await Promise.allSettled(current.map((job) => job.promise))
}
