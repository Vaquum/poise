import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, type KeyObject } from 'node:crypto'
import { chmodSync } from 'node:fs'
import Database from 'better-sqlite3'
import { HttpError } from './http.js'

type Kind = 'account' | 'flow' | 'operation' | 'admission'
interface Row { owner: number; id: string; value: string }
export class GoogleCipherError extends Error {
  constructor() { super('This Google connection cannot be decrypted. Reconnect the account.') }
}

/** Metadata is private; offline grants and pending PKCE/results additionally require the identity key. */
export class GoogleVault {
  private readonly db: Database.Database
  private readonly key: Buffer
  constructor(path: string, privateKey: KeyObject) {
    this.key = Buffer.from(hkdfSync('sha256', privateKey.export({ type: 'pkcs8', format: 'der' }), 'poise-google-v1', 'grant-encryption', 32))
    this.db = new Database(path)
    chmodSync(path, 0o600)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('secure_delete = ON')
    this.db.exec(`CREATE TABLE IF NOT EXISTS google_records (
      kind TEXT NOT NULL, owner INTEGER NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL,
      expires INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(kind, owner, id)
    ); CREATE INDEX IF NOT EXISTS google_record_lookup ON google_records(kind,id);
    CREATE TABLE IF NOT EXISTS google_epochs (owner INTEGER PRIMARY KEY, epoch INTEGER NOT NULL);`)
  }
  close(): void { this.db.close() }
  transaction<T>(operation: () => T): T { return this.db.transaction(operation).immediate() }
  epoch(owner: number): number { return this.db.prepare<[number], { epoch: number }>('SELECT epoch FROM google_epochs WHERE owner=?').get(owner)?.epoch ?? 0 }
  bump(owner: number): void { this.db.prepare('INSERT INTO google_epochs VALUES (?,1) ON CONFLICT(owner) DO UPDATE SET epoch=epoch+1').run(owner) }
  prune(now: number): void { this.db.prepare('DELETE FROM google_records WHERE expires > 0 AND expires <= ?').run(now) }
  count(kind: Kind, owner: number): number { return this.db.prepare<[string, number], { n: number }>('SELECT COUNT(*) AS n FROM google_records WHERE kind=? AND owner=?').get(kind, owner)!.n }
  private parse<T>(row: Row): T {
    try { return JSON.parse(row.value) as T } catch { throw new HttpError(500, 'Saved Google connection state is unreadable.') }
  }
  get<T>(kind: Kind, owner: number, id: string): T | null {
    const row = this.db.prepare<[string, number, string], Row>('SELECT owner,id,value FROM google_records WHERE kind=? AND owner=? AND id=?').get(kind, owner, id)
    return row ? this.parse<T>(row) : null
  }
  find<T>(kind: Kind, id: string): { owner: number; value: T } | null {
    const row = this.db.prepare<[string, string], Row>('SELECT owner,id,value FROM google_records WHERE kind=? AND id=?').get(kind, id)
    return row ? { owner: row.owner, value: this.parse<T>(row) } : null
  }
  list<T>(kind: Kind, owner: number): T[] {
    return this.db.prepare<[string, number], Row>('SELECT owner,id,value FROM google_records WHERE kind=? AND owner=? ORDER BY id').all(kind, owner).map(row => this.parse<T>(row))
  }
  put(kind: Kind, owner: number, id: string, value: unknown, expires = 0): void {
    this.db.prepare('INSERT INTO google_records VALUES (?,?,?,?,?) ON CONFLICT(kind,owner,id) DO UPDATE SET value=excluded.value,expires=excluded.expires').run(kind, owner, id, JSON.stringify(value), expires)
  }
  replace(kind: Kind, owner: number, id: string, previous: unknown, value: unknown): boolean {
    return this.db.prepare('UPDATE google_records SET value=? WHERE kind=? AND owner=? AND id=? AND value=?').run(JSON.stringify(value), kind, owner, id, JSON.stringify(previous)).changes === 1
  }
  remove(kind: Kind, owner: number, id: string): void { this.db.prepare('DELETE FROM google_records WHERE kind=? AND owner=? AND id=?').run(kind, owner, id) }
  seal(value: unknown, binding: string): string {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from(binding))
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')
  }
  unseal<T>(value: string, binding: string): T {
    try {
      const bytes = Buffer.from(value, 'base64url')
      const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12))
      decipher.setAuthTag(bytes.subarray(12, 28)); decipher.setAAD(Buffer.from(binding))
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')) as T
    } catch { throw new GoogleCipherError() }
  }
}
