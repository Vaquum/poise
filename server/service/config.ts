// Service mode: Poise as the single-user application inside one workspace
// container behind the gateway (docs/Service-architecture.md, "Poise in
// service mode"). POISE_MODE unset is a personal computer and changes nothing.

import { createPublicKey, type KeyObject } from 'node:crypto'

export interface ServiceConfig {
  /** The owner's GitHub login in lower case; the workspace's DNS label. */
  handle: string
  /** The owner's GitHub login, in GitHub's case. */
  owner: string
  /** `https://<handle>.<domain>`, exactly as a browser sends it in Origin. */
  publicOrigin: string
  /** The Host every request from the gateway carries. */
  publicHost: string
  /** The gateway's Ed25519 key that signs identity assertions. */
  gatewayKey: KeyObject
}

// GitHub logins as settings.ts accepts them; a handle is one in lower case.
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const SPKI_PEM = /^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/

/** Whether this process runs in service mode. Any POISE_MODE other than
 *  `service` is a configuration error, never a silent personal computer. */
export function isServiceMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = env.POISE_MODE
  if (mode === undefined) return false
  if (mode === 'service') return true
  throw new Error(`POISE_MODE must be "service" or unset; it is "${mode}"`)
}

function gatewayKey(value: string | undefined, problems: string[]): KeyObject | null {
  if (!value) {
    problems.push('POISE_GATEWAY_PUBLIC_KEY is required')
    return null
  }
  const pem = BASE64.test(value) ? Buffer.from(value, 'base64').toString('utf8') : ''
  if (!SPKI_PEM.test(pem)) {
    problems.push('POISE_GATEWAY_PUBLIC_KEY must be the gateway\'s SPKI public key PEM, encoded as single-line base64')
    return null
  }
  let key: KeyObject
  try {
    key = createPublicKey({ key: pem, format: 'pem', type: 'spki' })
  } catch (error) {
    problems.push(`POISE_GATEWAY_PUBLIC_KEY is not a readable public key (${error instanceof Error ? error.message : String(error)})`)
    return null
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    problems.push(`POISE_GATEWAY_PUBLIC_KEY must be an Ed25519 key; it is ${key.asymmetricKeyType ?? 'unknown'}`)
    return null
  }
  return key
}

function publicOrigin(value: string | undefined, handle: string, problems: string[]): URL | null {
  if (!value) {
    problems.push('POISE_PUBLIC_ORIGIN is required')
    return null
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    problems.push(`POISE_PUBLIC_ORIGIN must be an https origin such as https://<handle>.<domain>; it is "${value}"`)
    return null
  }
  if (url.protocol !== 'https:' || url.origin !== value) {
    problems.push(`POISE_PUBLIC_ORIGIN must be an https origin such as https://<handle>.<domain>, with no path or trailing slash; it is "${value}"`)
    return null
  }
  const domain = url.hostname.startsWith(`${handle}.`) ? url.hostname.slice(handle.length + 1) : ''
  if (!handle || !DOMAIN.test(domain)) {
    problems.push(`POISE_PUBLIC_ORIGIN's host must be the workspace handle followed by a domain (${handle || '<handle>'}.<domain>); it is "${url.hostname}"`)
    return null
  }
  return url
}

/** The service-mode configuration, or null outside service mode. Throws one
 *  error naming every missing or invalid variable, so a misconfigured
 *  workspace stops at startup instead of serving with a guess. */
export function readServiceConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig | null {
  if (!isServiceMode(env)) return null
  const problems: string[] = []
  const handle = env.POISE_WORKSPACE_HANDLE ?? ''
  const owner = env.POISE_WORKSPACE_OWNER ?? ''
  if (!handle) problems.push('POISE_WORKSPACE_HANDLE is required')
  else if (!HANDLE.test(handle)) problems.push(`POISE_WORKSPACE_HANDLE must be a GitHub login in lower case; it is "${handle}"`)
  if (!owner) problems.push('POISE_WORKSPACE_OWNER is required')
  else if (!LOGIN.test(owner)) problems.push(`POISE_WORKSPACE_OWNER must be a GitHub login; it is "${owner}"`)
  else if (HANDLE.test(handle) && owner.toLowerCase() !== handle) {
    problems.push(`POISE_WORKSPACE_OWNER "${owner}" is not the login whose handle is "${handle}"`)
  }
  const origin = publicOrigin(env.POISE_PUBLIC_ORIGIN, HANDLE.test(handle) ? handle : '', problems)
  const key = gatewayKey(env.POISE_GATEWAY_PUBLIC_KEY, problems)
  if (problems.length || !origin || !key) {
    throw new Error(`Poise cannot start in service mode: ${problems.join('; ')}`)
  }
  return { handle, owner, publicOrigin: origin.origin, publicHost: origin.host, gatewayKey: key }
}
