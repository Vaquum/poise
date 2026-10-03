// The gateway's identity assertion (docs/Service-architecture.md, "Gateway →
// workspace identity"): a compact JWT signed with Ed25519 in X-Poise-Identity,
// verified with node:crypto alone.

import { verify, type KeyObject } from 'node:crypto'

export const IDENTITY_HEADER = 'x-poise-identity'
export const ASSERTION_ISSUER = 'poise-gateway'
export const ASSERTION_SKEW_SECONDS = 5
export const ASSERTION_MAX_LIFETIME_SECONDS = 120
const MAX_ASSERTION_BYTES = 4096
const ED25519_SIGNATURE_BYTES = 64
const SEGMENT = /^[A-Za-z0-9_-]+$/

export const ASSERTION_SCOPES = ['browser', 'link', 'admin'] as const
export type AssertionScope = typeof ASSERTION_SCOPES[number]

export interface IdentityAssertion {
  subject: string
  scope: AssertionScope
}

export interface AssertionExpectation {
  key: KeyObject
  handle: string
  owner: string
}

export type AssertionResult =
  | { ok: true, assertion: IdentityAssertion }
  | { ok: false, reason: string }

function segmentJson(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

const refuse = (reason: string): AssertionResult => ({ ok: false, reason })

/** Check one assertion against this workspace at `nowSeconds`. The signature
 *  is verified before any claim is believed. Reasons never repeat the token. */
export function verifyIdentityAssertion(token: string, expected: AssertionExpectation, nowSeconds: number): AssertionResult {
  if (token.length > MAX_ASSERTION_BYTES) return refuse('the identity assertion is malformed')
  const parts = token.split('.')
  if (parts.length !== 3 || !parts.every((part) => SEGMENT.test(part))) return refuse('the identity assertion is malformed')
  const [encodedHeader, encodedClaims, encodedSignature] = parts
  const header = segmentJson(encodedHeader)
  if (!header) return refuse('the identity assertion is malformed')
  if (header.alg !== 'EdDSA') return refuse('the identity assertion must be signed with EdDSA')
  if (header.typ !== undefined && header.typ !== 'JWT') return refuse('the identity assertion is malformed')
  const signature = Buffer.from(encodedSignature, 'base64url')
  if (signature.byteLength !== ED25519_SIGNATURE_BYTES
    || !verify(null, Buffer.from(`${encodedHeader}.${encodedClaims}`, 'ascii'), expected.key, signature)) {
    return refuse('the identity assertion signature does not verify')
  }
  const claims = segmentJson(encodedClaims)
  if (!claims) return refuse('the identity assertion is malformed')
  if (claims.iss !== ASSERTION_ISSUER) return refuse('the identity assertion has the wrong issuer')
  if (claims.aud !== `workspace:${expected.handle}`) return refuse('the identity assertion is for another workspace')
  if (typeof claims.sub !== 'string' || claims.sub.toLowerCase() !== expected.owner.toLowerCase()) {
    return refuse('the identity assertion is for another person')
  }
  if (!ASSERTION_SCOPES.includes(claims.scope as AssertionScope)) return refuse('the identity assertion has an unknown scope')
  const { iat, exp } = claims
  if (typeof iat !== 'number' || typeof exp !== 'number' || !Number.isFinite(iat) || !Number.isFinite(exp) || exp <= iat) {
    return refuse('the identity assertion has an invalid lifetime')
  }
  if (exp - iat > ASSERTION_MAX_LIFETIME_SECONDS) return refuse('the identity assertion lives longer than 120 seconds')
  if (iat > nowSeconds + ASSERTION_SKEW_SECONDS) return refuse('the identity assertion is issued in the future')
  if (nowSeconds >= exp + ASSERTION_SKEW_SECONDS) return refuse('the identity assertion has expired')
  return { ok: true, assertion: { subject: claims.sub, scope: claims.scope as AssertionScope } }
}

/** Scopes by route: the browser reaches everything, a paired Poise Link only
 *  the Link API, the gateway itself only the service endpoints. */
export function scopeAllowsPath(scope: AssertionScope, path: string): boolean {
  if (scope === 'browser') return true
  const prefix = scope === 'link' ? '/api/link/' : '/api/service/'
  // The raw path is what routes match; the resolved one is what dot segments
  // could turn it into. A scoped assertion must stay inside its prefix in both.
  let resolved: string
  try {
    resolved = new URL(path, 'http://workspace.invalid').pathname
  } catch {
    return false
  }
  return path.startsWith(prefix) && resolved.startsWith(prefix)
}
