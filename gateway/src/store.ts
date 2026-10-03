import Database from 'better-sqlite3'
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto'
import { chmodSync } from 'node:fs'

// The gateway's state. Every bearer secret (session ids, tickets, OAuth states,
// device codes, device tokens) is stored as its SHA-256 hash only.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    handle TEXT PRIMARY KEY,
    login TEXT NOT NULL,
    github_id INTEGER NOT NULL,
    access_org TEXT,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER NOT NULL,
    disabled_at INTEGER,
    disabled_by TEXT
  );

  CREATE TABLE IF NOT EXISTS allowed_logins (
    handle TEXT PRIMARY KEY,
    source TEXT NOT NULL CHECK (source IN ('env', 'admin')),
    added_by TEXT,
    added_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_states (
    state_hash TEXT PRIMARY KEY,
    return_to TEXT,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id_hash TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('apex', 'workspace')),
    handle TEXT NOT NULL REFERENCES users(handle),
    host TEXT,
    parent_hash TEXT REFERENCES sessions(id_hash) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    CHECK ((kind = 'apex') = (host IS NULL AND parent_hash IS NULL))
  );
  CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent_hash);

  CREATE TABLE IF NOT EXISTS tickets (
    ticket_hash TEXT PRIMARY KEY,
    apex_session_hash TEXT NOT NULL REFERENCES sessions(id_hash) ON DELETE CASCADE,
    handle TEXT NOT NULL,
    host TEXT NOT NULL,
    bind_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS tickets_session ON tickets(apex_session_hash);

  CREATE TABLE IF NOT EXISTS device_codes (
    code_hash TEXT PRIMARY KEY,
    user_code TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
    handle TEXT REFERENCES users(handle),
    label TEXT,
    interval_seconds INTEGER NOT NULL,
    last_polled_at INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    handle TEXT NOT NULL REFERENCES users(handle),
    label TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS devices_handle ON devices(handle);

  CREATE TABLE IF NOT EXISTS workspaces (
    handle TEXT PRIMARY KEY,
    login TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_started_at INTEGER,
    last_error TEXT,
    last_error_at INTEGER
  );
`

export function newSecret(): string {
  return randomBytes(32).toString('base64url')
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

// RFC 8628 section 6.1: consonants only, so a code never spells a word and reads back easily.
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'

export function newUserCode(): string {
  let code = ''
  for (let index = 0; index < 8; index += 1) code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/** The canonical XXXX-XXXX form of what a person typed, or null when it cannot be a user code. */
export function normalizeUserCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '')
  if (code.length !== 8 || [...code].some((letter) => !USER_CODE_ALPHABET.includes(letter))) return null
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

export interface User {
  handle: string
  login: string
  githubId: number
  accessOrg: string | null
  createdAt: number
  lastLoginAt: number
  disabledAt: number | null
  disabledBy: string | null
}

export interface Session {
  idHash: string
  kind: 'apex' | 'workspace'
  handle: string
  host: string | null
  parentHash: string | null
  csrf: string
  createdAt: number
  expiresAt: number
}

export interface AllowedLogin {
  handle: string
  source: 'env' | 'admin'
  addedBy: string | null
  addedAt: number
}

export type TicketResult =
  | { ok: true; handle: string; host: string; apexSessionHash: string; bindHash: string }
  | { ok: false; reason: 'unknown' | 'used' | 'expired' }

export type DevicePoll =
  | { issued: false; error: 'invalid_grant' | 'expired_token' | 'access_denied' | 'authorization_pending' | 'slow_down' }
  | { issued: true; token: string; handle: string }

export interface Device {
  id: string
  handle: string
  label: string | null
  createdAt: number
  lastUsedAt: number | null
  revokedAt: number | null
}

export interface WorkspaceRecord {
  handle: string
  login: string
  createdAt: number
  lastStartedAt: number | null
  lastError: string | null
  lastErrorAt: number | null
}

interface UserRow {
  handle: string
  login: string
  github_id: number
  access_org: string | null
  created_at: number
  last_login_at: number
  disabled_at: number | null
  disabled_by: string | null
}

interface SessionRow {
  id_hash: string
  kind: 'apex' | 'workspace'
  handle: string
  host: string | null
  parent_hash: string | null
  csrf: string
  created_at: number
  expires_at: number
}

interface TicketRow {
  apex_session_hash: string
  handle: string
  host: string
  bind_hash: string
  expires_at: number
  used_at: number | null
}

interface DeviceCodeRow {
  code_hash: string
  status: 'pending' | 'approved' | 'denied' | 'consumed'
  handle: string | null
  label: string | null
  interval_seconds: number
  last_polled_at: number | null
  expires_at: number
}

interface DeviceRow {
  id: string
  handle: string
  label: string | null
  created_at: number
  last_used_at: number | null
  revoked_at: number | null
}

interface WorkspaceRow {
  handle: string
  login: string
  created_at: number
  last_started_at: number | null
  last_error: string | null
  last_error_at: number | null
}

function toUser(row: UserRow): User {
  return {
    handle: row.handle,
    login: row.login,
    githubId: row.github_id,
    accessOrg: row.access_org,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    disabledAt: row.disabled_at,
    disabledBy: row.disabled_by,
  }
}

function toSession(row: SessionRow): Session {
  return {
    idHash: row.id_hash,
    kind: row.kind,
    handle: row.handle,
    host: row.host,
    parentHash: row.parent_hash,
    csrf: row.csrf,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }
}

function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    handle: row.handle,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Database.SqliteError && error.code === 'SQLITE_CONSTRAINT_UNIQUE'
}

const DEVICE_TOUCH_INTERVAL_MS = 60_000
export const DEVICE_IDLE_LIMIT_MS = 30 * 24 * 60 * 60_000
export const DEVICE_LIFETIME_MS = 365 * 24 * 60 * 60_000

/** A device token works until it is revoked, goes unused for 30 days, or turns 365 days old. */
export function deviceState(device: Device, now: number): 'active' | 'revoked' | 'expired' {
  if (device.revokedAt !== null) return 'revoked'
  if (now - device.createdAt >= DEVICE_LIFETIME_MS) return 'expired'
  if (now - (device.lastUsedAt ?? device.createdAt) >= DEVICE_IDLE_LIMIT_MS) return 'expired'
  return 'active'
}
// Expired device codes linger so a late poll still hears expired_token rather than invalid_grant.
const EXPIRED_DEVICE_CODE_RETENTION_MS = 60 * 60_000

export class Store {
  private readonly db: Database.Database

  constructor(path: string, private readonly now: () => number) {
    this.db = new Database(path)
    chmodSync(path, 0o600)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  getUser(handle: string): User | null {
    const row = this.db.prepare<[string], UserRow>('SELECT * FROM users WHERE handle = ?').get(handle)
    return row ? toUser(row) : null
  }

  listUsers(): User[] {
    return this.db.prepare<[], UserRow>('SELECT * FROM users ORDER BY handle').all().map(toUser)
  }

  /** Records a successful sign-in. The handle's GitHub account binding is the caller's to check. */
  saveSignIn(input: { handle: string; login: string; githubId: number; accessOrg: string | null }): User {
    const now = this.now()
    this.db.prepare(`
      INSERT INTO users (handle, login, github_id, access_org, created_at, last_login_at)
      VALUES (@handle, @login, @githubId, @accessOrg, @now, @now)
      ON CONFLICT (handle) DO UPDATE SET
        login = excluded.login, access_org = excluded.access_org, last_login_at = excluded.last_login_at
    `).run({ ...input, now })
    const user = this.getUser(input.handle)
    if (!user) throw new Error(`user ${input.handle} vanished while signing in`)
    return user
  }

  /**
   * Disables a person: every session ends, every paired device is revoked and approved but unredeemed
   * device codes are denied, so re-enabling means signing in and pairing again.
   */
  disableUser(handle: string, by: string): boolean {
    const now = this.now()
    return this.db.transaction(() => {
      const changed = this.db.prepare('UPDATE users SET disabled_at = ?, disabled_by = ? WHERE handle = ? AND disabled_at IS NULL')
        .run(now, by, handle).changes === 1
      if (!changed) return false
      this.db.prepare('DELETE FROM sessions WHERE handle = ?').run(handle)
      this.db.prepare('UPDATE devices SET revoked_at = ? WHERE handle = ? AND revoked_at IS NULL').run(now, handle)
      this.db.prepare("UPDATE device_codes SET status = 'denied' WHERE handle = ? AND status = 'approved'").run(handle)
      return true
    })()
  }

  enableUser(handle: string): boolean {
    return this.db.prepare('UPDATE users SET disabled_at = NULL, disabled_by = NULL WHERE handle = ? AND disabled_at IS NOT NULL')
      .run(handle).changes === 1
  }

  /** Makes the env-sourced part of the allow list equal POISE_ALLOWED_USERS; admin additions stay. */
  syncEnvAllowList(handles: readonly string[]): void {
    const now = this.now()
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM allowed_logins WHERE source = 'env'").run()
      const insert = this.db.prepare(`
        INSERT INTO allowed_logins (handle, source, added_by, added_at) VALUES (?, 'env', NULL, ?)
        ON CONFLICT (handle) DO UPDATE SET source = 'env', added_by = NULL
      `)
      for (const handle of handles) insert.run(handle, now)
    })()
  }

  listAllowed(): AllowedLogin[] {
    return this.db.prepare<[], { handle: string; source: 'env' | 'admin'; added_by: string | null; added_at: number }>(
      'SELECT * FROM allowed_logins ORDER BY handle',
    ).all().map((row) => ({ handle: row.handle, source: row.source, addedBy: row.added_by, addedAt: row.added_at }))
  }

  isOnAllowList(handle: string): boolean {
    return this.db.prepare<[string], { found: number }>('SELECT 1 AS found FROM allowed_logins WHERE handle = ?').get(handle) !== undefined
  }

  addAllowed(handle: string, addedBy: string): boolean {
    return this.db.prepare(`
      INSERT INTO allowed_logins (handle, source, added_by, added_at) VALUES (?, 'admin', ?, ?)
      ON CONFLICT (handle) DO NOTHING
    `).run(handle, addedBy, this.now()).changes === 1
  }

  removeAllowed(handle: string): 'removed' | 'missing' | 'env' {
    const row = this.db.prepare<[string], { source: 'env' | 'admin' }>('SELECT source FROM allowed_logins WHERE handle = ?').get(handle)
    if (!row) return 'missing'
    if (row.source === 'env') return 'env'
    this.db.prepare('DELETE FROM allowed_logins WHERE handle = ?').run(handle)
    return 'removed'
  }

  createOAuthState(returnTo: string | null, ttlMs: number): string {
    const state = newSecret()
    this.db.prepare('INSERT INTO oauth_states (state_hash, return_to, expires_at) VALUES (?, ?, ?)')
      .run(hashSecret(state), returnTo, this.now() + ttlMs)
    return state
  }

  /** Single use: the state is deleted whether or not it is still valid. */
  consumeOAuthState(state: string): { returnTo: string | null } | null {
    const stateHash = hashSecret(state)
    return this.db.transaction(() => {
      const row = this.db.prepare<[string], { return_to: string | null; expires_at: number }>(
        'SELECT return_to, expires_at FROM oauth_states WHERE state_hash = ?',
      ).get(stateHash)
      this.db.prepare('DELETE FROM oauth_states WHERE state_hash = ?').run(stateHash)
      return row && row.expires_at > this.now() ? { returnTo: row.return_to } : null
    })()
  }

  createApexSession(handle: string, ttlMs: number): { id: string; session: Session } {
    const now = this.now()
    return this.insertSession({
      kind: 'apex', handle, host: null, parentHash: null, createdAt: now, expiresAt: now + ttlMs,
    })
  }

  /** A workspace session lives exactly as long as the apex session it was minted from. */
  createWorkspaceSession(parent: Session, host: string): { id: string; session: Session } {
    return this.insertSession({
      kind: 'workspace', handle: parent.handle, host, parentHash: parent.idHash, createdAt: this.now(), expiresAt: parent.expiresAt,
    })
  }

  private insertSession(fields: Omit<Session, 'idHash' | 'csrf'>): { id: string; session: Session } {
    const id = newSecret()
    const session: Session = { ...fields, idHash: hashSecret(id), csrf: newSecret() }
    this.db.prepare(`
      INSERT INTO sessions (id_hash, kind, handle, host, parent_hash, csrf, created_at, expires_at)
      VALUES (@idHash, @kind, @handle, @host, @parentHash, @csrf, @createdAt, @expiresAt)
    `).run(session)
    return { id, session }
  }

  findSession(id: string): Session | null {
    return this.sessionByHash(hashSecret(id))
  }

  sessionByHash(idHash: string): Session | null {
    const row = this.db.prepare<[string, number], SessionRow>('SELECT * FROM sessions WHERE id_hash = ? AND expires_at > ?')
      .get(idHash, this.now())
    return row ? toSession(row) : null
  }

  /** Deleting an apex session also ends every workspace session and ticket minted from it. */
  deleteSession(idHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash)
  }

  /** A ticket redeemable only by the browser holding `bindValue` in its poise_bind cookie. */
  createTicket(apexSession: Session, host: string, bindValue: string, ttlMs: number): string {
    const ticket = newSecret()
    this.db.prepare(`
      INSERT INTO tickets (ticket_hash, apex_session_hash, handle, host, bind_hash, expires_at, used_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(hashSecret(ticket), apexSession.idHash, apexSession.handle, host, hashSecret(bindValue), this.now() + ttlMs)
    return ticket
  }

  /** Burns the ticket on its first presentation, valid or not. */
  consumeTicket(ticket: string): TicketResult {
    const ticketHash = hashSecret(ticket)
    return this.db.transaction((): TicketResult => {
      const row = this.db.prepare<[string], TicketRow>('SELECT * FROM tickets WHERE ticket_hash = ?').get(ticketHash)
      if (!row) return { ok: false, reason: 'unknown' }
      if (row.used_at !== null) return { ok: false, reason: 'used' }
      const now = this.now()
      this.db.prepare('UPDATE tickets SET used_at = ? WHERE ticket_hash = ?').run(now, ticketHash)
      if (row.expires_at <= now) return { ok: false, reason: 'expired' }
      return { ok: true, handle: row.handle, host: row.host, apexSessionHash: row.apex_session_hash, bindHash: row.bind_hash }
    })()
  }

  createDeviceCode(label: string | null, ttlMs: number, intervalSeconds: number): { deviceCode: string; userCode: string } {
    const deviceCode = newSecret()
    const now = this.now()
    for (let attempt = 1; ; attempt += 1) {
      const userCode = newUserCode()
      try {
        this.db.prepare(`
          INSERT INTO device_codes (code_hash, user_code, status, handle, label, interval_seconds, last_polled_at, created_at, expires_at)
          VALUES (?, ?, 'pending', NULL, ?, ?, NULL, ?, ?)
        `).run(hashSecret(deviceCode), userCode, label, intervalSeconds, now, now + ttlMs)
        return { deviceCode, userCode }
      } catch (error) {
        if (attempt < 5 && isUniqueViolation(error)) continue
        throw error
      }
    }
  }

  /** Approves or denies a pending, unexpired code. False when there is no such code. */
  decideDeviceCode(userCode: string, handle: string, approve: boolean): boolean {
    return this.db.prepare(`
      UPDATE device_codes SET status = ?, handle = ?
      WHERE user_code = ? AND status = 'pending' AND expires_at > ?
    `).run(approve ? 'approved' : 'denied', handle, userCode, this.now()).changes === 1
  }

  /** One RFC 8628 token request: answers the poll and, once approved, issues the device token. */
  pollDeviceCode(deviceCode: string, intervalStepSeconds: number): DevicePoll {
    const codeHash = hashSecret(deviceCode)
    return this.db.transaction((): DevicePoll => {
      const row = this.db.prepare<[string], DeviceCodeRow>('SELECT * FROM device_codes WHERE code_hash = ?').get(codeHash)
      if (!row || row.status === 'consumed') return { issued: false, error: 'invalid_grant' }
      const now = this.now()
      if (row.expires_at <= now) return { issued: false, error: 'expired_token' }
      if (row.status === 'denied') return { issued: false, error: 'access_denied' }
      if (row.status === 'pending') {
        if (row.last_polled_at !== null && now - row.last_polled_at < row.interval_seconds * 1000) {
          this.db.prepare('UPDATE device_codes SET interval_seconds = ?, last_polled_at = ? WHERE code_hash = ?')
            .run(row.interval_seconds + intervalStepSeconds, now, codeHash)
          return { issued: false, error: 'slow_down' }
        }
        this.db.prepare('UPDATE device_codes SET last_polled_at = ? WHERE code_hash = ?').run(now, codeHash)
        return { issued: false, error: 'authorization_pending' }
      }
      if (!row.handle) throw new Error('an approved device code has no approving user')
      this.db.prepare("UPDATE device_codes SET status = 'consumed' WHERE code_hash = ?").run(codeHash)
      const token = newSecret()
      this.db.prepare(`
        INSERT INTO devices (id, token_hash, handle, label, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL, NULL)
      `).run(randomUUID(), hashSecret(token), row.handle, row.label, now)
      return { issued: true, token, handle: row.handle }
    })()
  }

  findDeviceByToken(token: string): Device | null {
    const row = this.db.prepare<[string], DeviceRow>('SELECT * FROM devices WHERE token_hash = ?').get(hashSecret(token))
    return row ? toDevice(row) : null
  }

  touchDevice(id: string): void {
    const now = this.now()
    this.db.prepare('UPDATE devices SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)')
      .run(now, id, now - DEVICE_TOUCH_INTERVAL_MS)
  }

  listDevices(handle: string): Device[] {
    return this.db.prepare<[string], DeviceRow>('SELECT * FROM devices WHERE handle = ? ORDER BY created_at DESC, id')
      .all(handle).map(toDevice)
  }

  revokeDevice(handle: string, id: string): boolean {
    return this.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND handle = ? AND revoked_at IS NULL')
      .run(this.now(), id, handle).changes === 1
  }

  getWorkspace(handle: string): WorkspaceRecord | null {
    const row = this.db.prepare<[string], WorkspaceRow>('SELECT * FROM workspaces WHERE handle = ?').get(handle)
    return row
      ? {
          handle: row.handle,
          login: row.login,
          createdAt: row.created_at,
          lastStartedAt: row.last_started_at,
          lastError: row.last_error,
          lastErrorAt: row.last_error_at,
        }
      : null
  }

  noteWorkspace(handle: string, login: string): void {
    this.db.prepare(`
      INSERT INTO workspaces (handle, login, created_at) VALUES (?, ?, ?)
      ON CONFLICT (handle) DO UPDATE SET login = excluded.login
    `).run(handle, login, this.now())
  }

  noteWorkspaceStarted(handle: string): void {
    this.db.prepare('UPDATE workspaces SET last_started_at = ?, last_error = NULL, last_error_at = NULL WHERE handle = ?')
      .run(this.now(), handle)
  }

  noteWorkspaceError(handle: string, message: string): void {
    this.db.prepare('UPDATE workspaces SET last_error = ?, last_error_at = ? WHERE handle = ?').run(message, this.now(), handle)
  }

  purgeExpired(): void {
    const now = this.now()
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM tickets WHERE expires_at <= ?').run(now)
      this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now)
      this.db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(now)
      this.db.prepare("DELETE FROM device_codes WHERE status = 'consumed' OR expires_at <= ?")
        .run(now - EXPIRED_DEVICE_CODE_RETENTION_MS)
    })()
  }
}
