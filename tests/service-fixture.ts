// A gateway for service-mode tests: an Ed25519 key pair generated per test
// run, the workspace environment the gateway passes, and assertions signed
// the way docs/Service-architecture.md specifies.

import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'

export const HANDLE = 'octocat'
export const OWNER = 'OctoCat'
export const PUBLIC_HOST = 'octocat.poise.example.test'
export const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`

export interface GatewayKeys {
  privateKey: KeyObject
  /** The SPKI PEM as single-line base64, as POISE_GATEWAY_PUBLIC_KEY carries it. */
  publicKey: string
}

export function gatewayKeys(): GatewayKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { privateKey, publicKey: Buffer.from(publicKey.export({ type: 'spki', format: 'pem' }).toString()).toString('base64') }
}

export function serviceEnvironment(keys: GatewayKeys): Record<string, string> {
  return {
    POISE_MODE: 'service',
    POISE_WORKSPACE_HANDLE: HANDLE,
    POISE_WORKSPACE_OWNER: OWNER,
    POISE_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    POISE_GATEWAY_PUBLIC_KEY: keys.publicKey,
  }
}

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')

/** A compact EdDSA JWT; claims and header override the gateway's defaults. */
export function signAssertion(
  privateKey: KeyObject,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = { alg: 'EdDSA', typ: 'JWT' },
): string {
  const now = Math.floor(Date.now() / 1000)
  const body = { iss: 'poise-gateway', aud: `workspace:${HANDLE}`, sub: OWNER, scope: 'browser', iat: now, exp: now + 60, jti: randomUUID(), ...claims }
  const signingInput = `${encode(header)}.${encode(body)}`
  return `${signingInput}.${sign(null, Buffer.from(signingInput), privateKey).toString('base64url')}`
}
