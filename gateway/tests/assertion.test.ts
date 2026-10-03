import { createPublicKey, verify } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { signAssertion } from '../src/assertion.js'
import { loadOrCreateKeys, PRIVATE_KEY_FILE } from '../src/keys.js'
import { createLogger } from '../src/log.js'

const log = createLogger(() => undefined)

function decode(part: string): unknown {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
}

describe('identity assertions', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gw-keys-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('is a compact EdDSA JWT with the contract claims that verifies against the exported public key', () => {
    const keys = loadOrCreateKeys(dir, log)
    const nowMs = Date.UTC(2026, 9, 3, 12, 0, 0, 500)
    const token = signAssertion(keys.privateKey, { handle: 'alice', login: 'Alice', scope: 'link' }, nowMs)

    const parts = token.split('.')
    expect(parts).toHaveLength(3)
    expect(decode(parts[0])).toEqual({ alg: 'EdDSA', typ: 'JWT' })
    const claims = decode(parts[1]) as Record<string, unknown>
    const iat = Math.floor(nowMs / 1000)
    expect(claims).toEqual({
      iss: 'poise-gateway',
      aud: 'workspace:alice',
      sub: 'Alice',
      scope: 'link',
      iat,
      exp: iat + 60,
      jti: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
    })

    // Workspaces get the key as POISE_GATEWAY_PUBLIC_KEY: single-line base64 of the SPKI PEM.
    expect(keys.publicKeyBase64).toMatch(/^[A-Za-z0-9+/]+=*$/)
    const pem = Buffer.from(keys.publicKeyBase64, 'base64').toString('utf8')
    expect(pem).toMatch(/^-----BEGIN PUBLIC KEY-----\n/)
    const publicKey = createPublicKey(pem)
    expect(publicKey.asymmetricKeyType).toBe('ed25519')
    expect(verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url'))).toBe(true)

    const tampered = Buffer.from(JSON.stringify({ ...claims, sub: 'Mallory' })).toString('base64url')
    expect(verify(null, Buffer.from(`${parts[0]}.${tampered}`), publicKey, Buffer.from(parts[2], 'base64url'))).toBe(false)
  })

  it('gives every assertion its own jti', () => {
    const keys = loadOrCreateKeys(dir, log)
    const jtis = new Set(Array.from({ length: 50 }, () => {
      const token = signAssertion(keys.privateKey, { handle: 'alice', login: 'alice', scope: 'browser' }, Date.now())
      return (decode(token.split('.')[1]) as { jti: string }).jti
    }))
    expect(jtis.size).toBe(50)
  })

  it('generates the key pair once, keeps the private key at mode 0600 and reuses it on the next start', () => {
    const first = loadOrCreateKeys(dir, log)
    const path = join(dir, PRIVATE_KEY_FILE)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const pem = readFileSync(path, 'utf8')
    const second = loadOrCreateKeys(dir, log)
    expect(readFileSync(path, 'utf8')).toBe(pem)
    expect(second.publicKeyBase64).toBe(first.publicKeyBase64)
  })

  it('refuses a private key file that others can read', () => {
    loadOrCreateKeys(dir, log)
    chmodSync(join(dir, PRIVATE_KEY_FILE), 0o644)
    expect(() => loadOrCreateKeys(dir, log)).toThrow(/must be readable by its owner only \(mode 0600\) but has mode 0644/)
  })
})
