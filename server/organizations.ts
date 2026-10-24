import { diagnosticFailure } from './logging'
import Database from 'better-sqlite3'
import { chmodSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { db, getMeta, setMeta } from './db'
import { forgetSilence, openAlerts, resolveAlert, silencedKeys } from './alerts/store'
import { ProcessLockError, withProcessLock } from './process-lock'
import { runFile } from './process'
import { releaseBackgroundPaused, trackReleaseBackground } from './release-background'
import { conditionCorrelation } from './logging-context'
import { datastoreSyncFailed, datastoreSyncRecovered } from './alerts/producers'

export interface Organization {
  login: string
  datastorePath?: string
  managed: boolean
  status: 'initializing' | 'ready' | 'error'
  stage: string
  error: string | null
  activatedAt: string | null
  retryAt: string | null
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
  /** When the current run of failed syncs began (ms); 0 while syncs succeed. */
  sync_failing_since: number
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
    sync_failures INTEGER NOT NULL DEFAULT 0,
    sync_failing_since INTEGER NOT NULL DEFAULT 0
  );
`)

// Keep this migration additive for registries created by an earlier build.
db.transaction(() => {
  const columns = db.prepare('PRAGMA table_info(organizations)').all() as Array<{ name: string }>
  for (const column of ['next_sync_at', 'sync_failures', 'sync_failing_since']) {
    if (!columns.some((entry) => entry.name === column)) {
      db.exec(`ALTER TABLE organizations ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`)
    }
  }
}).immediate()

const RUNTIME_TICK_MS = 5_000
const SYNC_INTERVAL_MS = 60_000
// Match Caller's daily full reconciliation; incremental freshness stays per minute.
const RECONCILE_INTERVAL_MS = 24 * 60 * 60_000
const RECONCILE_BUDGET_SECONDS = 20
const MAX_SYNC_RETRY_MS = 60 * 60_000
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

function cooldownKey(me: string): string {
  return `github_rate_limit:${me.toLowerCase()}:reset_at`
}

function cooldownUntil(me: string | undefined): number {
  if (!me) return 0
  const value = Number(getMeta(cooldownKey(me)))
  return Number.isSafeInteger(value) && value > Date.now() && value <= 8.64e15 ? value : 0
}

function rateLimitMessage(me: string, resetAt: number): string {
  return `GitHub API rate limit reached for ${me}. Account indexing resumes automatically at ${new Date(resetAt).toISOString()}.`
}

class GitHubRateLimitError extends Error {
  constructor(readonly me: string, readonly resetAt: number) {
    super(rateLimitMessage(me, resetAt))
  }
}

function requireQuota(me: string): void {
  const resetAt = cooldownUntil(me)
  if (resetAt) throw new GitHubRateLimitError(me, resetAt)
}

function observeRateLimit(error: unknown, me: string): GitHubRateLimitError | null {
  const details = [error instanceof Error ? error.message : String(error), (error as { stderr?: unknown })?.stderr]
    .filter((value): value is string => typeof value === 'string').join('\n')
  const resets = [...details.matchAll(/\bGITHUB_RATE_LIMIT_RESET=(\d+)\b/g)]
    .map((match) => Number(match[1]) * 1000)
    .filter((reset) => Number.isSafeInteger(reset) && reset > 0 && reset <= 8.64e15)
  if (resets.length === 0) return null
  const resetAt = Math.max(...resets)
  // The quota belongs to the authenticated identity. Concurrent account jobs
  // and server processes can only extend its cooldown, never shorten it.
  db.prepare(`
    INSERT INTO meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE CAST(meta.value AS INTEGER) < CAST(excluded.value AS INTEGER)
  `).run(cooldownKey(me), String(resetAt))
  return new GitHubRateLimitError(me, cooldownUntil(me) || resetAt)
}

function fromRow(row: OrganizationRow): Organization {
  const me = getMeta('me')?.trim()
  const pendingUser = row.status === 'ready' && row.managed && row.indexed_user !== me
  const resetAt = row.managed && row.status !== 'error' ? cooldownUntil(me) : 0
  return {
    login: row.login,
    ...(row.datastore_path ? { datastorePath: row.datastore_path } : {}),
    managed: !!row.managed,
    status: pendingUser ? 'initializing' : row.status,
    stage: resetAt ? 'rate-limited' : pendingUser ? 'building-user' : row.stage,
    error: resetAt ? rateLimitMessage(me!, resetAt) : row.error,
    activatedAt: row.activated_at,
    retryAt: resetAt ? new Date(resetAt).toISOString() : null,
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
    retryAt: null,
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

// The account's notices resolve with it: its datastore alert, its
// pull-request notices, and behavior incidents on its repositories.
// Silences go too, so a re-added account starts clean. Quota, chat,
// sign-in, storage and ledger alerts belong to identities or the
// workspace, not to the account, and stay.
function resolveOrganizationAlerts(login: string): void {
  const lower = login.toLowerCase()
  const owned = (key: string): boolean => {
    if (key === `datastore-sync:${lower}`) return true
    for (const prefix of ['pr-ready:', 'review-requested:', 'pr-conflict:', 'behavior-held:']) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      const owner = (prefix === 'behavior-held:' ? rest.split(':').slice(1).join(':') : rest).split('/')[0].toLowerCase()
      if (owner === lower) return true
    }
    return false
  }
  for (const alert of openAlerts()) {
    if (owned(alert.dedupeKey)) resolveAlert(alert.dedupeKey, Date.now(), 'person')
  }
  for (const prefix of ['pr-ready:', 'review-requested:', 'pr-conflict:', 'behavior-held:', 'datastore-sync:']) {
    for (const key of silencedKeys(prefix)) {
      if (owned(key)) forgetSilence(key)
    }
  }
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

// Stop following a managed organization. Nothing changes on GitHub. The
// registration row goes; its datastore file stays — whether Poise-owned
// data is kept awaits the owner's decision — and an externally managed
// datastore is never touched. Work bindings stay as history.
export async function removeOrganization(value: unknown): Promise<void> {
  const login = normalizeOrganizationLogin(value)
  const row = rowFor(login)
  if (!row && login !== getMeta('org')?.trim().toLowerCase()) throw new Error('GitHub account is not configured.')
  if (!row?.managed) {
    throw new Error(`Cannot stop following ${row?.login ?? login}: the workspace needs this account.`)
  }
  if (getOrganizations().length <= 1) {
    throw new Error(`Cannot stop following ${row.login}: it is the last GitHub account.`)
  }
  // Abort the in-flight activation or sync and wait for it to settle,
  // then move the generation so a straggler can never publish into a
  // new registration of this login after a quick re-add.
  const job = jobs.get(login.toLowerCase())
  if (job) {
    job.controller.abort()
    await Promise.allSettled([job.promise])
  }
  setMeta(generationKey(login), String(organizationGeneration(login) + 1))
  db.prepare('DELETE FROM organizations WHERE login = ?').run(login)
  resolveOrganizationAlerts(login)
  // Its repositories leave the issue review selection and the Manager's
  // scope. Skips stay: they are designed to outlive listing changes.
  // Dynamic imports: behaviors and settings both depend on this module.
  const lower = login.toLowerCase()
  const { getIssueRepositories, setIssueRepositories } = await import('./behaviors')
  const selected = getIssueRepositories().map((entry) => entry.repo)
  const kept = selected.filter((repo) => repo.split('/')[0].toLowerCase() !== lower)
  if (kept.length !== selected.length) setIssueRepositories(kept)
  const { getSettings, setSettings } = await import('./settings')
  const manager = getSettings().manager
  if (Array.isArray(manager.scope)) {
    const scope = manager.scope.filter((repo) => repo.split('/')[0].toLowerCase() !== lower)
    if (scope.length !== manager.scope.length) setSettings({ manager: { ...manager, scope } })
  }
}

function stage(login: string, value: string, generation?: number): void {
  if (generation !== undefined && !publishAdmitted(login, generation)) return
  db.prepare('UPDATE organizations SET stage = ? WHERE login = ?').run(value, login)
}

// The activation generation fences a login's job against a quick remove
// and re-add: the job captures the generation when it starts, and every
// publish point below checks it, so an older job can never publish into
// a new registration of the same login. It lives in meta, not in the
// registration row, so it survives the row's deletion.
function generationKey(login: string): string {
  return `organization_generation:${login.toLowerCase()}`
}

function organizationGeneration(login: string): number {
  const value = Number(getMeta(generationKey(login)))
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function publishAdmitted(login: string, generation: number): boolean {
  return !!rowFor(login) && organizationGeneration(login) === generation
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
    diagnosticFailure('datastore.authentication', error, { account: me, phase: 'credential_lookup' }, { stderr: false, level: 'warning' })
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

async function caller(path: string, args: readonly string[], me: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
  requireQuota(me)
  try {
    const { stdout } = await runFile('github-datastore', ['--db', path, ...args], {
      env, signal, timeoutMs: CLI_TIMEOUT_MS, maxOutputBytes: 4 * 1024 * 1024,
    })
    return stdout
  } catch (error) {
    throw observeRateLimit(error, me) ?? error
  }
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

function assertOrganization(path: string, login: string): boolean {
  const state = databaseState(path)
  if (state.login?.toLowerCase() !== login.toLowerCase() || !state.complete) {
    throw new Error('Datastore does not contain a completed index for this account.')
  }
  const connection = new Database(path, { readonly: true, fileMustExist: true })
  try {
    return !!connection.prepare("SELECT 1 FROM sync_state WHERE key = 'full_build_retry_required' AND value = '1' LIMIT 1").get()
  } finally { connection.close() }
}

async function checkHealth(path: string, me: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  const result = JSON.parse(await caller(path, ['health', '--max-age-seconds', '120'], me, env, signal)) as Record<string, unknown>
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

async function activate(row: OrganizationRow, me: string, signal: AbortSignal, env: NodeJS.ProcessEnv, generation: number): Promise<void> {
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
    if (existsSync(tempPath)) {
      let state: ReturnType<typeof databaseState>
      try { state = databaseState(tempPath) } catch {
        throw new Error('Cannot read the staging datastore. Its contents were preserved; repair the database before retrying.')
      }
      // Initial repository discovery can fail before Caller records the owner.
      // Its --resume validator accepts only a truly empty unidentified index.
      if ((state.login !== null && state.login.toLowerCase() !== row.login.toLowerCase())
        || (state.login === null && state.complete)) {
        throw new Error('Staging datastore does not identify this account. Its contents were preserved; verify the database before retrying.')
      }
      reused = state.complete
    }
    if (!reused) {
      stage(row.login, 'indexing', generation)
      await caller(tempPath, ['init-org', row.login, '--resume'], me, env, signal)
      assertOrganization(tempPath, row.login)
    }
  }
  // Completed staging may have been empty when build-user first failed.
  // Refresh retained data before rebuilding the user so Retry can discover
  // issues created remotely since that attempt, without reinitializing it.
  if (reused) {
    stage(row.login, 'syncing', generation)
    await caller(sourcePath, ['sync'], me, env, signal)
  }
  stage(row.login, 'building-user', generation)
  await caller(sourcePath, ['build-user', me], me, env, signal)
  stage(row.login, 'syncing', generation)
  await caller(sourcePath, ['sync'], me, env, signal)
  stage(row.login, 'checking', generation)
  await checkHealth(sourcePath, me, env, signal)
  signal.throwIfAborted()
  if (sourcePath === tempPath) publishDatabase(tempPath, path)
  if (!publishAdmitted(row.login, generation)) return
  db.prepare(`
    UPDATE organizations SET status = 'ready', stage = 'ready', error = NULL,
      activated_at = COALESCE(activated_at, ?), last_sync_at = ?, last_reconcile_at = ?, indexed_user = ?, next_sync_at = 0, sync_failures = 0,
      sync_failing_since = 0
    WHERE login = ?
  `).run(new Date().toISOString(), Date.now(), Date.now(), me, row.login)
  datastoreSyncRecovered(row.login)
}

async function reconcileChunk(path: string, me: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<boolean> {
  const result: unknown = JSON.parse(await caller(path, ['sync', '--reconcile', '--reconcile-max-seconds', String(RECONCILE_BUDGET_SECONDS)], me, env, signal))
  if (!result || typeof result !== 'object' || !('reconcile_complete' in result) || typeof result.reconcile_complete !== 'boolean') {
    throw new Error('Datastore reconciliation did not report completion status.')
  }
  return result.reconcile_complete
}

async function synchronize(row: OrganizationRow, me: string, signal: AbortSignal, env: NodeJS.ProcessEnv, generation: number): Promise<void> {
  const path = row.datastore_path!
  const recoveringFullBuild = assertOrganization(path, row.login)
  if (row.indexed_user !== me) {
    stage(row.login, 'building-user', generation)
    await caller(path, ['build-user', me], me, env, signal)
  }
  let reconcileComplete = false
  // Older releases invalidated every repository before a full reconciliation.
  // Repair those markers in resumable chunks before requesting a delta sync.
  if (recoveringFullBuild) {
    stage(row.login, 'reconciling', generation)
    reconcileComplete = await reconcileChunk(path, me, env, signal)
    if (!reconcileComplete) {
      if (publishAdmitted(row.login, generation)) {
        db.prepare('UPDATE organizations SET next_sync_at = 0 WHERE login = ?').run(row.login)
      }
      return
    }
  }
  stage(row.login, 'syncing', generation)
  await caller(path, ['sync'], me, env, signal)
  const reconcile = Date.now() - row.last_reconcile_at >= RECONCILE_INTERVAL_MS
  if (reconcile && !reconcileComplete) {
    stage(row.login, 'reconciling', generation)
    reconcileComplete = await reconcileChunk(path, me, env, signal)
    // Reconciliation does not advance Caller's last_sync_at freshness marker.
    await caller(path, ['sync'], me, env, signal)
  }
  await checkHealth(path, me, env, signal)
  if (!publishAdmitted(row.login, generation)) return
  db.prepare(`
    UPDATE organizations SET stage = 'ready', error = NULL, last_sync_at = ?,
      last_reconcile_at = ?, indexed_user = ?, next_sync_at = 0, sync_failures = 0, sync_failing_since = 0 WHERE login = ?
  `).run(Date.now(), reconcileComplete ? Date.now() : row.last_reconcile_at, me, row.login)
  datastoreSyncRecovered(row.login)
}

function launch(login: string): void {
  const key = login.toLowerCase()
  if (stopping || jobs.has(key) || releaseBackgroundPaused() || cooldownUntil(getMeta('me')?.trim())) return
  const releaseOperation = trackReleaseBackground()
  const controller = new AbortController()
  const generation = organizationGeneration(login)
  const promise = Promise.resolve().then(async () => {
    const initial = rowFor(login)
    if (!initial?.managed || !initial.datastore_path) return
    let env: NodeJS.ProcessEnv | undefined
    try {
      const directory = dirname(initial.datastore_path)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      chmodSync(directory, 0o700)
      await withProcessLock({ path: `${initial.datastore_path}.lock`, timeoutMs: 50 }, async () => {
        const row = rowFor(login)
        controller.signal.throwIfAborted()
        // Recheck under the process lock: another Poise instance may have
        // completed this work while we waited for ownership, or the
        // account may have been removed and re-added since this job
        // started — a straggler publishes nothing into the new row.
        if (!row || !publishAdmitted(login, generation)) return
        if (row.status === 'error') return
        const me = getMeta('me')?.trim()
        if (me) requireQuota(me)
        if (row.status === 'ready' && row.next_sync_at > Date.now()) return
        if (row.status === 'ready' && row.indexed_user === me && Date.now() - row.last_sync_at < SYNC_INTERVAL_MS) return
        if (row.status === 'initializing') stage(login, 'authenticating', generation)
        env = await githubEnvironment(me, controller.signal)
        if (row.status === 'ready') await synchronize(row, me!, controller.signal, env, generation)
        else await activate(row, me!, controller.signal, env, generation)
      })
    } catch (error) {
      if (controller.signal.aborted || error instanceof ProcessLockError) return
      const failed = rowFor(login)
      if (!failed || !publishAdmitted(login, generation)) return
      const failures = error instanceof GitHubRateLimitError ? failed.sync_failures : failed.activated_at ? failed.sync_failures + 1 : 0
      const retryAt = error instanceof GitHubRateLimitError ? error.resetAt : failures ? Date.now() + Math.min(SYNC_INTERVAL_MS * 2 ** Math.min(failures - 1, 6), MAX_SYNC_RETRY_MS) : 0
      const failingSince = failures ? failed.sync_failing_since || Date.now() : 0
      diagnosticFailure(failed.activated_at ? 'datastore.sync' : 'datastore.activate', error, {
        correlationId: conditionCorrelation('datastore-sync', login.toLowerCase(), String(failingSince)),
        account: login, databasePath: failed.datastore_path, phase: failed.stage,
        lastSuccessfulSyncAt: failed.last_sync_at ? new Date(failed.last_sync_at).toISOString() : null,
        ageMs: failed.last_sync_at ? Date.now() - failed.last_sync_at : null, freshnessLimitMs: SYNC_INTERVAL_MS,
        retryCount: failures, nextRetryAt: retryAt || null,
      }, { secrets: env?.GH_TOKEN ? [env.GH_TOKEN] : [], level: error instanceof GitHubRateLimitError ? 'warning' : 'error' })
      if (error instanceof GitHubRateLimitError) {
        db.prepare(`
          UPDATE organizations SET status = CASE WHEN activated_at IS NULL THEN 'initializing' ELSE 'ready' END,
            stage = 'rate-limited', error = ?, next_sync_at = 0 WHERE login = ?
        `).run(error.message, login)
        return
      }
      db.prepare(`
        UPDATE organizations SET status = CASE WHEN activated_at IS NULL THEN 'error' ELSE 'ready' END,
          stage = CASE WHEN activated_at IS NULL THEN stage ELSE 'sync-error' END, error = ?,
          next_sync_at = ?, sync_failures = ?, sync_failing_since = ? WHERE login = ?
      `).run(safeError(error, env), retryAt, failures, failingSince, login)
      if (failures) datastoreSyncFailed(login, failingSince)
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
