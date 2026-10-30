import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto'
import { linkSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Logger } from './log.js'

export const PRIVATE_KEY_FILE = 'identity-ed25519.pem'

export interface GatewayKeys {
  privateKey: KeyObject
  /** The SPKI PEM as single-line base64: the value workspaces receive as POISE_GATEWAY_PUBLIC_KEY. */
  publicKeyBase64: string
}

/**
 * Publishes a new key at `path` unless one is there already. The key is written in full to a private
 * temporary file and hard-linked into place, so a concurrent start never reads a half-written key and
 * whichever start links first wins.
 */
function createKeyUnlessPresent(path: string, log: Logger): void {
  const { privateKey } = generateKeyPairSync('ed25519')
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  writeFileSync(temporary, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' })
  try {
    linkSync(temporary, path)
    log.info('identity.key.created', { path })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  } finally {
    unlinkSync(temporary)
  }
}

/** Loads the assertion signing key from the data directory, generating it on first start. */
export function loadOrCreateKeys(dataDir: string, log: Logger): GatewayKeys {
  const path = join(dataDir, PRIVATE_KEY_FILE)
  createKeyUnlessPresent(path, log)
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
