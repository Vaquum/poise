import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEVICE_IDLE_LIMIT_MS, DEVICE_LIFETIME_MS, deviceState, normalizeUserCode, Store } from '../src/store.js'

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
    const ticket = store.createTicket(session, 'alice', 'binding', 500)
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

  it('disabling ends every session, revokes every device and denies approved codes', () => {
    store.saveSignIn({ handle: 'alice', login: 'Alice', githubId: 1, accessOrg: 'acme' })
    const { id: apexId, session } = store.createApexSession('alice', 60_000)
    const { id: workspaceId } = store.createWorkspaceSession(session, 'alice')
    const ticket = store.createTicket(session, 'alice', 'binding', 60_000)
    const pending = store.createDeviceCode(null, 60_000, 5)
    expect(store.decideDeviceCode(pending.userCode, 'alice', true)).toBe(true)
    const paired = store.createDeviceCode(null, 60_000, 5)
    store.decideDeviceCode(paired.userCode, 'alice', true)
    const issued = store.pollDeviceCode(paired.deviceCode, 5)
    expect(issued.issued).toBe(true)

    expect(store.disableUser('alice', 'root')).toBe(true)
    expect(store.disableUser('alice', 'root')).toBe(false)
    expect(store.getUser('alice')).toMatchObject({ disabledAt: now, disabledBy: 'root' })
    expect(store.findSession(apexId)).toBeNull()
    expect(store.findSession(workspaceId)).toBeNull()
    expect(store.consumeTicket(ticket)).toEqual({ ok: false, reason: 'unknown' })
    expect(store.listDevices('alice').every((device) => device.revokedAt === now)).toBe(true)
    expect(store.pollDeviceCode(pending.deviceCode, 5)).toEqual({ issued: false, error: 'access_denied' })

    expect(store.enableUser('alice')).toBe(true)
    expect(store.getUser('alice')).toMatchObject({ disabledAt: null, disabledBy: null })
    // Enabling restores nothing that disabling ended.
    expect(store.listDevices('alice').every((device) => device.revokedAt === now)).toBe(true)
  })

  it('expires device tokens after 30 days unused or 365 days in all', () => {
    const device = { id: 'd', handle: 'alice', label: null, createdAt: now, lastUsedAt: null, revokedAt: null }
    expect(deviceState(device, now + DEVICE_IDLE_LIMIT_MS - 1)).toBe('active')
    expect(deviceState(device, now + DEVICE_IDLE_LIMIT_MS)).toBe('expired')
    const busy = { ...device, lastUsedAt: now + DEVICE_LIFETIME_MS - 1000 }
    expect(deviceState(busy, now + DEVICE_LIFETIME_MS - 1)).toBe('active')
    expect(deviceState(busy, now + DEVICE_LIFETIME_MS)).toBe('expired')
    expect(deviceState({ ...device, revokedAt: now }, now)).toBe('revoked')
  })

  it('normalises typed user codes and rejects anything outside the alphabet', () => {
    expect(normalizeUserCode('bcdf ghjk')).toBe('BCDF-GHJK')
    expect(normalizeUserCode('BCDF-GHJK')).toBe('BCDF-GHJK')
    expect(normalizeUserCode('BCDF-GHJA')).toBeNull()
    expect(normalizeUserCode('BCDF-GHJ')).toBeNull()
  })
})
