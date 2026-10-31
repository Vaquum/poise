// Extensions storage. Definitions, switches and the last check live in
// `extension_servers`; every secret value (environment variables, headers,
// OAuth tokens and client registrations) lives in `extension_secrets` and is
// never part of a view. The database is owner-only (server/db.ts) and runs
// with secure_delete, so a removed secret's bytes are overwritten.

import { randomUUID } from 'node:crypto'
import { db } from '../db'
import { redact } from '../../gateway/src/diagnostics/redaction.mjs'
import { secretSlots, type Enablement, type ServerEvent, type ServerSpec, type ServerStatus, type ServerView } from './types'

db.exec(`
  CREATE TABLE IF NOT EXISTS extension_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    spec TEXT NOT NULL,
    enabled TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS extension_secrets (
    server_id TEXT NOT NULL REFERENCES extension_servers(id) ON DELETE CASCADE,
    slot TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (server_id, slot)
  );
  CREATE TABLE IF NOT EXISTS extension_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id TEXT NOT NULL REFERENCES extension_servers(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    level TEXT NOT NULL,
    text TEXT NOT NULL
  );
`)

const EVENTS_KEPT = 100
// Shorter values are too likely to be ordinary words to scrub from text.
const MIN_REDACTED = 8

export class ExtensionError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'ExtensionError'
  }
}

interface Row { id: string, name: string, spec: string, enabled: string, status: string, created_at: string, updated_at: string }

export interface StoredServer { id: string, spec: ServerSpec, enabled: Enablement, status: ServerStatus, createdAt: string, updatedAt: string }

function parse(row: Row): StoredServer {
  return { id: row.id, spec: JSON.parse(row.spec), enabled: JSON.parse(row.enabled), status: JSON.parse(row.status), createdAt: row.created_at, updatedAt: row.updated_at }
}

function slotsOf(id: string): Set<string> {
  return new Set((db.prepare('SELECT slot FROM extension_secrets WHERE server_id = ?').all(id) as Array<{ slot: string }>).map((row) => row.slot))
}

function toView(server: StoredServer): ServerView {
  const slots = slotsOf(server.id)
  const mark = (prefix: string) => (field: { name: string, value?: string, secret: boolean }) => field.secret ? { name: field.name, secret: true, set: slots.has(`${prefix}:${field.name}`) } : field
  return {
    id: server.id, ...server.spec,
    ...(server.spec.env ? { env: server.spec.env.map(mark('env')) } : {}),
    ...(server.spec.headers ? { headers: server.spec.headers.map(mark('header')) } : {}),
    enabled: server.enabled, status: server.status, signedIn: slots.has('oauth:tokens'),
    createdAt: server.createdAt, updatedAt: server.updatedAt,
  }
}

export function storedServers(): StoredServer[] {
  return (db.prepare('SELECT * FROM extension_servers ORDER BY created_at').all() as Row[]).map(parse)
}

export function storedServer(id: string): StoredServer {
  const row = db.prepare('SELECT * FROM extension_servers WHERE id = ?').get(id) as Row | undefined
  if (!row) throw new ExtensionError(404, 'That extension no longer exists.')
  return parse(row)
}

export function listServers(): ServerView[] {
  return storedServers().map(toView)
}

export function serverView(id: string): ServerView {
  return toView(storedServer(id))
}

function assertNameFree(name: string, id?: string): void {
  const row = db.prepare('SELECT id FROM extension_servers WHERE name = ?').get(name) as { id: string } | undefined
  if (row && row.id !== id) throw new ExtensionError(409, `An extension named ${name} already exists. Choose another name.`)
}

function checkSecrets(spec: ServerSpec, secrets: Record<string, string | null | undefined>, existing: Set<string>): void {
  const slots = new Set(secretSlots(spec))
  for (const slot of Object.keys(secrets)) {
    if (!slots.has(slot)) throw new ExtensionError(400, `${slot.replace(/^\w+:/, '')} is not a secret of this server.`)
    const value = secrets[slot]
    if (typeof value === 'string' && (value.length > 8192 || /[\r\n\0]/.test(value))) throw new ExtensionError(400, `The value of ${slot.replace(/^\w+:/, '')} must be a single line of at most 8192 characters.`)
  }
  for (const slot of slots) {
    const value = secrets[slot]
    if (typeof value === 'string' && value) continue
    if (value === undefined && existing.has(slot)) continue
    throw new ExtensionError(400, `Enter a value for ${slot.replace(/^\w+:/, '')}.`)
  }
}

export function createServer(spec: ServerSpec, secrets: Record<string, string>, enabled: Enablement): ServerView {
  checkSecrets(spec, secrets, new Set())
  const id = randomUUID()
  const now = new Date().toISOString()
  db.transaction(() => {
    assertNameFree(spec.name)
    db.prepare('INSERT INTO extension_servers (id, name, spec, enabled, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, spec.name, JSON.stringify(spec), JSON.stringify(enabled), JSON.stringify({ state: 'unknown' } satisfies ServerStatus), now, now)
    for (const [slot, value] of Object.entries(secrets)) db.prepare('INSERT INTO extension_secrets (server_id, slot, value) VALUES (?, ?, ?)').run(id, slot, value)
  })()
  secretCache = null
  return serverView(id)
}

/** Replace a definition. A secret given as text replaces the stored one,
 *  omitted keeps it; secrets the new definition no longer names are erased.
 *  A remote server that moved forgets its OAuth sign-in. */
export function updateServer(id: string, spec: ServerSpec, secrets: Record<string, string | null | undefined>): ServerView {
  const current = storedServer(id)
  const existing = slotsOf(id)
  checkSecrets(spec, secrets, existing)
  const keep = new Set(secretSlots(spec))
  const moved = current.spec.url !== spec.url || current.spec.transport !== spec.transport || spec.auth !== 'oauth'
  db.transaction(() => {
    assertNameFree(spec.name, id)
    db.prepare('UPDATE extension_servers SET name = ?, spec = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(spec.name, JSON.stringify(spec), JSON.stringify({ state: 'unknown' } satisfies ServerStatus), new Date().toISOString(), id)
    for (const slot of existing) {
      if (slot.startsWith('oauth:') ? moved : !keep.has(slot)) db.prepare('DELETE FROM extension_secrets WHERE server_id = ? AND slot = ?').run(id, slot)
    }
    for (const [slot, value] of Object.entries(secrets)) {
      if (typeof value === 'string' && value) db.prepare('INSERT INTO extension_secrets (server_id, slot, value) VALUES (?, ?, ?) ON CONFLICT(server_id, slot) DO UPDATE SET value = excluded.value').run(id, slot, value)
    }
  })()
  secretCache = null
  return serverView(id)
}

/** One workspace's switch. */
export function setWorkspace(id: string, workspace: string, on: boolean): ServerView {
  const server = storedServer(id)
  server.enabled.workspaces[workspace] = on
  saveEnabled(id, server.enabled)
  return serverView(id)
}

/** The switch for workspaces without one of their own. Workspaces already
 *  shown keep what they had, so this changes only workspaces yet to come. */
export function setDefault(id: string, on: boolean, known: readonly string[]): ServerView {
  const server = storedServer(id)
  for (const workspace of known) server.enabled.workspaces[workspace] ??= server.enabled.default
  server.enabled.default = on
  saveEnabled(id, server.enabled)
  return serverView(id)
}

function saveEnabled(id: string, enabled: Enablement): void {
  db.prepare('UPDATE extension_servers SET enabled = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(enabled), new Date().toISOString(), id)
}

export function deleteServer(id: string): void {
  storedServer(id)
  db.prepare('DELETE FROM extension_servers WHERE id = ?').run(id)
  secretCache = null
}

export function setStatus(id: string, status: ServerStatus): void {
  db.prepare('UPDATE extension_servers SET status = ? WHERE id = ?').run(JSON.stringify(status), id)
}

/** Detected at a check: a remote server that answers with an OAuth challenge. */
export function markOAuth(id: string): void {
  const server = storedServer(id)
  if (server.spec.auth === 'oauth' || server.spec.transport === 'stdio') return
  db.prepare('UPDATE extension_servers SET spec = ? WHERE id = ?').run(JSON.stringify({ ...server.spec, auth: 'oauth' }), id)
}

export function readSecret(id: string, slot: string): string | null {
  const row = db.prepare('SELECT value FROM extension_secrets WHERE server_id = ? AND slot = ?').get(id, slot) as { value: string } | undefined
  return row?.value ?? null
}

export function writeSecret(id: string, slot: string, value: string): void {
  db.prepare('INSERT INTO extension_secrets (server_id, slot, value) VALUES (?, ?, ?) ON CONFLICT(server_id, slot) DO UPDATE SET value = excluded.value').run(id, slot, value)
  secretCache = null
}

export function eraseSecret(id: string, slot: string): void {
  db.prepare('DELETE FROM extension_secrets WHERE server_id = ? AND slot = ?').run(id, slot)
  secretCache = null
}

/** Every pending OAuth flow, for matching a returning `state`. */
export function oauthFlows(): Array<{ id: string, value: string }> {
  return db.prepare("SELECT server_id AS id, value FROM extension_secrets WHERE slot = 'oauth:flow'").all() as Array<{ id: string, value: string }>
}

let secretCache: string[] | null = null

/** Every stored secret value, for scrubbing logs, diagnostics and transcripts. */
export function secretValues(): string[] {
  if (secretCache) return secretCache
  const values = new Set<string>()
  const add = (value: unknown) => {
    if (typeof value !== 'string') return
    if (value.length >= MIN_REDACTED) values.add(value)
    const bearer = /^Bearer\s+(\S+)$/i.exec(value)
    if (bearer && bearer[1].length >= MIN_REDACTED) values.add(bearer[1])
  }
  for (const row of db.prepare('SELECT slot, value FROM extension_secrets').all() as Array<{ slot: string, value: string }>) {
    if (!row.slot.startsWith('oauth:')) { add(row.value); continue }
    try {
      // Tokens are kept as { tokens, obtainedAt, … }; registrations and flows flat.
      const parsed = JSON.parse(row.value) as Record<string, unknown>
      for (const record of [parsed, parsed.tokens as Record<string, unknown> | undefined]) {
        for (const key of ['access_token', 'refresh_token', 'id_token', 'client_secret', 'verifier']) add(record?.[key])
      }
    } catch { add(row.value) }
  }
  secretCache = [...values].sort((a, b) => b.length - a.length)
  return secretCache
}

/** Stored secret values replaced in text, also as they appear inside JSON. */
export function redactSecrets(text: string): string {
  let result = text
  for (const secret of secretValues()) {
    for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1)])) {
      if (result.includes(form)) result = result.split(form).join('[redacted]')
    }
  }
  return result
}

/** Activity is removed with its server, so a check, sign-in or refresh that
 *  outlives the removal has nothing left to record into. */
export function addEvent(id: string, level: ServerEvent['level'], text: string): void {
  const clean = redact(text, secretValues()).slice(0, 2000)
  db.transaction(() => {
    db.prepare('INSERT INTO extension_events (server_id, at, level, text) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM extension_servers WHERE id = ?)').run(id, new Date().toISOString(), level, clean, id)
    db.prepare('DELETE FROM extension_events WHERE server_id = ? AND id NOT IN (SELECT id FROM extension_events WHERE server_id = ? ORDER BY id DESC LIMIT ?)').run(id, id, EVENTS_KEPT)
  })()
}

export function listEvents(id: string): ServerEvent[] {
  storedServer(id)
  return db.prepare('SELECT at, level, text FROM extension_events WHERE server_id = ? ORDER BY id DESC').all(id) as ServerEvent[]
}
