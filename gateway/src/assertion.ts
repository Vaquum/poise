import { randomBytes, sign, type KeyObject } from 'node:crypto'

export type Scope = 'browser' | 'link' | 'admin'

export const ASSERTION_ISSUER = 'poise-gateway'
export const ASSERTION_LIFETIME_SECONDS = 60

const HEADER = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url')

export interface AssertionClaims {
  iss: string
  aud: string
  sub: string
  scope: Scope
  iat: number
  exp: number
  jti: string
  sid?: string
  gport?: number
}

export interface AssertionSubject {
  handle: string
  /** The GitHub login in GitHub's case. */
  login: string
  scope: Scope
  sessionIdHash?: string
  gatewayPort?: number
}

/** Signs the identity assertion the gateway sends to a workspace in X-Poise-Identity. */
export function signAssertion(privateKey: KeyObject, subject: AssertionSubject, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000)
  const claims: AssertionClaims = {
    iss: ASSERTION_ISSUER,
    aud: `workspace:${subject.handle}`,
    sub: subject.login,
    scope: subject.scope,
    iat,
    exp: iat + ASSERTION_LIFETIME_SECONDS,
    jti: randomBytes(16).toString('base64url'),
    ...(subject.scope === 'browser' && subject.sessionIdHash ? { sid: subject.sessionIdHash } : {}),
    ...(subject.scope === 'browser' && subject.gatewayPort ? { gport: subject.gatewayPort } : {}),
  }
  const signingInput = `${HEADER}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`
  const signature = sign(null, Buffer.from(signingInput), privateKey).toString('base64url')
  return `${signingInput}.${signature}`
}
