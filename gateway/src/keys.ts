import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Logger } from './log.js'

export const PRIVATE_KEY_FILE = 'identity-ed25519.pem'

export interface GatewayKeys {
  privateKey: KeyObject
  /** The SPKI PEM as single-line base64: the value workspaces receive as POISE_GATEWAY_PUBLIC_KEY. */
  publicKeyBase64: string
}

/** Loads the assertion signing key from the data directory, generating it on first start. */
export function loadOrCreateKeys(dataDir: string, log: Logger): GatewayKeys {
  const path = join(dataDir, PRIVATE_KEY_FILE)
  if (!existsSync(path)) {
    const { privateKey } = generateKeyPairSync('ed25519')
    // 'wx' refuses to overwrite a key another process wrote meanwhile.
    writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' })
    log.info('identity.key.created', { path })
  }
  const mode = statSync(path).mode & 0o777
  if ((mode & 0o077) !== 0) {
    throw new Error(`${path} must be readable by its owner only (mode 0600) but has mode 0${mode.toString(8)}`)
  }
  const privateKey = createPrivateKey(readFileSync(path))
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`${path} does not hold an Ed25519 private key`)
  }
  const spkiPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })
  return { privateKey, publicKeyBase64: Buffer.from(spkiPem).toString('base64') }
}
