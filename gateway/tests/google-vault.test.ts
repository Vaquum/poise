import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { GoogleVault } from '../src/google-vault.js'

it('survives restart, authenticates owner/record binding, and refuses a rotated identity key', () => {
  const root = mkdtempSync(join(tmpdir(), 'google-vault-')), path = join(root, 'vault.db'), { privateKey } = generateKeyPairSync('ed25519')
  let vault = new GoogleVault(path, privateKey)
  try {
    const grant = { refreshToken: 'private-offline-grant' }, encrypted = vault.seal(grant, 'account:1001:subject')
    vault.put('account', 1001, 'subject', { id: 'subject', grant: encrypted })
    vault.close(); vault = new GoogleVault(path, privateKey)
    const saved = vault.get<{ grant: string }>('account', 1001, 'subject')!
    expect(vault.unseal(saved.grant, 'account:1001:subject')).toEqual(grant)
    expect(vault.get('account', 1002, 'subject')).toBeNull()
    expect(() => vault.unseal(saved.grant, 'account:1002:subject')).toThrow('Reconnect')
    expect(() => vault.unseal(saved.grant, 'account:1001:other')).toThrow('Reconnect')
    expect(readFileSync(path).toString('latin1')).not.toContain(grant.refreshToken)
    expect(statSync(path).mode & 0o077).toBe(0)
    vault.close(); vault = new GoogleVault(path, generateKeyPairSync('ed25519').privateKey)
    expect(() => vault.unseal(saved.grant, 'account:1001:subject')).toThrow('Reconnect')
  } finally { vault.close(); rmSync(root, { recursive: true, force: true }) }
})
