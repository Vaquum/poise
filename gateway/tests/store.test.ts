import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeUserCode, Store } from '../src/store.js'

describe('store', () => {
  let dir: string
  let now: number
  let store: Store
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gw-store-'))
    now = Date.UTC(2026, 9, 3)
    store = new Store(join(dir, 'gateway.db'), () => now)
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps the database file private to its owner', () => {
    expect(statSync(join(dir, 'gateway.db')).mode & 0o777).toBe(0o600)
  })

  it('makes the env part of the allow list follow POISE_ALLOWED_USERS and keeps admin additions', () => {
    store.syncEnvAllowList(['alice', 'bob'])
    store.addAllowed('carol', 'root')
    store.syncEnvAllowList(['bob', 'dave'])
    expect(store.listAllowed().map((entry) => [entry.handle, entry.source])).toEqual([
      ['bob', 'env'],
      ['carol', 'admin'],
      ['dave', 'env'],
    ])
    expect(store.removeAllowed('bob')).toBe('env')
    expect(store.removeAllowed('carol')).toBe('removed')
    expect(store.removeAllowed('carol')).toBe('missing')
  })

  it('purges what has expired and keeps expired device codes long enough to answer expired_token', () => {
    store.saveSignIn({ handle: 'alice', login: 'Alice', githubId: 1, accessOrg: null })
    const { session } = store.createApexSession('alice', 1000)
    const ticket = store.createTicket(session, 'alice', 500)
    const state = store.createOAuthState(null, 500)
    const { deviceCode } = store.createDeviceCode(null, 500, 5)

    now += 2000
    store.purgeExpired()
    expect(store.sessionByHash(session.idHash)).toBeNull()
    expect(store.consumeTicket(ticket)).toEqual({ ok: false, reason: 'unknown' })
    expect(store.consumeOAuthState(state)).toBeNull()
    expect(store.pollDeviceCode(deviceCode, 5)).toEqual({ issued: false, error: 'expired_token' })

    now += 60 * 60_000
    store.purgeExpired()
    expect(store.pollDeviceCode(deviceCode, 5)).toEqual({ issued: false, error: 'invalid_grant' })
  })

  it('normalises typed user codes and rejects anything outside the alphabet', () => {
    expect(normalizeUserCode('bcdf ghjk')).toBe('BCDF-GHJK')
    expect(normalizeUserCode('BCDF-GHJK')).toBe('BCDF-GHJK')
    expect(normalizeUserCode('BCDF-GHJA')).toBeNull()
    expect(normalizeUserCode('BCDF-GHJ')).toBeNull()
  })
})
