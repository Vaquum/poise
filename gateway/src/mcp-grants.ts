import { randomUUID } from 'node:crypto'
import { chmodSync } from 'node:fs'
import Database from 'better-sqlite3'
import { hashSecret, newSecret } from './store.js'
import type { McpGrantScope } from './mcp-contract.js'

const ACCESS_MS = 10 * 60_000
const GRANT_MS = 30 * 86_400_000
export interface McpGrant extends McpGrantScope { clientId: string; createdAt: number; expiresAt: number; revokedAt: number | null }
interface StoredGrant extends McpGrant { accessHash: string; accessExpires: number; refreshHash: string }

/** Only token hashes persist. The separate store adds no authority to browser or Link sessions. */
export class McpGrants {
  private readonly db: Database.Database
  constructor(path: string, private readonly now: () => number) {
    this.db = new Database(path)
    chmodSync(path, 0o600)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`CREATE TABLE IF NOT EXISTS mcp_clients (id TEXT PRIMARY KEY, redirects TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_grants (id TEXT PRIMARY KEY, owner INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS mcp_grants_owner ON mcp_grants(owner);
      CREATE UNIQUE INDEX IF NOT EXISTS mcp_grants_access ON mcp_grants(json_extract(state, '$.accessHash'));
      CREATE UNIQUE INDEX IF NOT EXISTS mcp_grants_refresh ON mcp_grants(json_extract(state, '$.refreshHash'));`)
  }
  close(): void { this.db.close() }
  register(redirects: string[]): string {
    this.db.prepare('DELETE FROM mcp_clients WHERE expires <= ?').run(this.now())
    // Anonymous metadata is reclaimable; only an owner's live grant retains a registration.
    this.db.prepare(`DELETE FROM mcp_clients WHERE id IN (
      SELECT id FROM mcp_clients AS client WHERE NOT EXISTS (
        SELECT 1 FROM mcp_grants WHERE json_extract(state, '$.clientId') = client.id
          AND json_extract(state, '$.revokedAt') IS NULL AND json_extract(state, '$.expiresAt') > ?
      ) ORDER BY expires DESC, rowid DESC LIMIT -1 OFFSET 255
    )`).run(this.now())
    const id = newSecret()
    this.db.prepare('INSERT INTO mcp_clients VALUES (?, ?, ?)').run(id, JSON.stringify(redirects), this.now() + GRANT_MS)
    return id
  }
  redirects(client: string): string[] {
    const row = this.db.prepare('SELECT redirects FROM mcp_clients WHERE id = ? AND expires > ?').get(client, this.now()) as { redirects: string } | undefined
    return row ? JSON.parse(row.redirects) as string[] : []
  }
  list(ownerId: number): McpGrant[] {
    return (this.db.prepare('SELECT state FROM mcp_grants WHERE owner = ? ORDER BY id LIMIT 100').all(ownerId) as { state: string }[])
      .map(row => JSON.parse(row.state) as StoredGrant).map(({ resource, ownerId, handle, grantId, clientId, createdAt, expiresAt, revokedAt }) =>
        ({ resource, ownerId, handle, grantId, clientId, createdAt, expiresAt, revokedAt }))
  }
  create(scope: Omit<McpGrantScope, 'grantId'>, clientId: string) {
    this.db.prepare("DELETE FROM mcp_grants WHERE json_extract(state, '$.expiresAt') <= ?").run(this.now())
    if (this.list(scope.ownerId).length >= 100) throw new Error('read grant capacity reached; wait for a retained grant to expire')
    const grant: StoredGrant = { ...scope, clientId, grantId: randomUUID(), createdAt: this.now(), expiresAt: this.now() + GRANT_MS,
      revokedAt: null, accessHash: '', refreshHash: '', accessExpires: 0 }
    return this.rotate(grant)
  }
  private rotate(grant: StoredGrant) {
    const access = newSecret(), refresh = newSecret()
    Object.assign(grant, { accessHash: hashSecret(access), refreshHash: hashSecret(refresh), accessExpires: this.now() + ACCESS_MS })
    this.db.prepare('INSERT INTO mcp_grants VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state')
      .run(grant.grantId, grant.ownerId, JSON.stringify(grant))
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: ACCESS_MS / 1000, scope: 'poise:read' }
  }
  find(token: string, kind: 'access' | 'refresh'): StoredGrant | null {
    const field = kind === 'access' ? 'accessHash' : 'refreshHash'
    const row = this.db.prepare(`SELECT state FROM mcp_grants WHERE json_extract(state, '$.${field}') = ? LIMIT 1`).get(hashSecret(token)) as { state: string } | undefined
    const grant = row ? JSON.parse(row.state) as StoredGrant : null
    return grant && grant.revokedAt === null && grant.expiresAt > this.now()
      && (kind === 'refresh' || grant.accessExpires > this.now()) ? grant : null
  }
  refresh(grant: StoredGrant) { return this.rotate(grant) }
  revoke(ownerId: number, id: string): void {
    this.db.prepare("UPDATE mcp_grants SET state = json_set(state, '$.revokedAt', ?) WHERE id = ? AND owner = ?")
      .run(this.now(), id, ownerId)
  }
}
