import { createPublicKey, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { scopeAllowsPath, verifyIdentityAssertion } from '../server/service/identity'
import { HANDLE, OWNER, gatewayKeys, signAssertion } from './service-fixture'

const gateway = gatewayKeys()
const impostor = gatewayKeys()
const expected = { key: createPublicKey(Buffer.from(gateway.publicKey, 'base64').toString()), handle: HANDLE, owner: OWNER }
const NOW = 1_800_000_000
const at = (claims: Record<string, unknown> = {}, header?: Record<string, unknown>) =>
  signAssertion(gateway.privateKey, { iat: NOW, exp: NOW + 60, ...claims }, header)
const verifyAt = (token: string, now = NOW) => verifyIdentityAssertion(token, expected, now)
const refused = (token: string, now = NOW) => {
  const result = verifyAt(token, now)
  return result.ok ? null : result.reason
}

describe('gateway identity assertions', () => {
  it('accepts the gateway\'s assertion for this workspace in each scope', () => {
    for (const scope of ['browser', 'link', 'admin']) {
      expect(verifyAt(at({ scope }))).toEqual({ ok: true, assertion: { subject: OWNER, scope } })
    }
  })

  it('matches the owner without regard to case', () => {
    expect(verifyAt(at({ sub: 'octocat' }))).toMatchObject({ ok: true })
    expect(verifyAt(at({ sub: 'OCTOCAT' }))).toMatchObject({ ok: true })
  })

  it('rejects a forged signature', () => {
    const token = at()
    const [header, , signature] = token.split('.')
    const claims = Buffer.from(JSON.stringify({ iss: 'poise-gateway', aud: `workspace:${HANDLE}`, sub: OWNER, scope: 'admin', iat: NOW, exp: NOW + 60 })).toString('base64url')
    expect(refused(`${header}.${claims}.${signature}`)).toBe('the identity assertion signature does not verify')
    const flipped = Buffer.from(signature, 'base64url')
    flipped[0] ^= 0xff
    expect(refused(`${token.split('.').slice(0, 2).join('.')}.${flipped.toString('base64url')}`)).toBe('the identity assertion signature does not verify')
  })

  it('rejects an assertion signed with another key', () => {
    expect(refused(signAssertion(impostor.privateKey, { iat: NOW, exp: NOW + 60 }))).toBe('the identity assertion signature does not verify')
  })

  it('rejects every algorithm but EdDSA, even with a valid Ed25519 signature', () => {
    for (const alg of ['none', 'HS256', 'RS256', 'ES256', 'Ed25519', undefined]) {
      expect(refused(at({}, { alg, typ: 'JWT' })), String(alg)).toBe('the identity assertion must be signed with EdDSA')
    }
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${at().split('.')[1]}.`
    expect(refused(unsigned)).toBe('the identity assertion is malformed')
  })

  it('rejects an expired assertion beyond five seconds of skew', () => {
    const token = at({ iat: NOW - 60, exp: NOW })
    expect(verifyAt(token, NOW + 4)).toMatchObject({ ok: true })
    expect(refused(token, NOW + 5)).toBe('the identity assertion has expired')
    expect(refused(token, NOW + 600)).toBe('the identity assertion has expired')
  })

  it('rejects an assertion issued more than five seconds in the future', () => {
    expect(verifyAt(at({ iat: NOW + 5, exp: NOW + 65 }))).toMatchObject({ ok: true })
    expect(refused(at({ iat: NOW + 6, exp: NOW + 66 }))).toBe('the identity assertion is issued in the future')
  })

  it('rejects an assertion that lives longer than 120 seconds', () => {
    expect(verifyAt(at({ iat: NOW, exp: NOW + 120 }))).toMatchObject({ ok: true })
    expect(refused(at({ iat: NOW, exp: NOW + 121 }))).toBe('the identity assertion lives longer than 120 seconds')
    expect(refused(at({ iat: NOW - 3600, exp: NOW + 3600 }))).toBe('the identity assertion lives longer than 120 seconds')
  })

  it('rejects a lifetime that is not a pair of increasing times', () => {
    for (const claims of [{ iat: NOW, exp: NOW }, { iat: NOW + 10, exp: NOW }, { iat: String(NOW), exp: NOW + 60 }, { iat: NOW, exp: null }, { iat: undefined }]) {
      expect(refused(at(claims)), JSON.stringify(claims)).toBe('the identity assertion has an invalid lifetime')
    }
  })

  it('rejects the wrong audience, issuer, owner or scope', () => {
    expect(refused(at({ aud: 'workspace:hubot' }))).toBe('the identity assertion is for another workspace')
    expect(refused(at({ aud: ['workspace:octocat'] }))).toBe('the identity assertion is for another workspace')
    expect(refused(at({ aud: 'octocat' }))).toBe('the identity assertion is for another workspace')
    expect(refused(at({ iss: 'someone-else' }))).toBe('the identity assertion has the wrong issuer')
    expect(refused(at({ sub: 'hubot' }))).toBe('the identity assertion is for another person')
    expect(refused(at({ sub: undefined }))).toBe('the identity assertion is for another person')
    expect(refused(at({ scope: 'root' }))).toBe('the identity assertion has an unknown scope')
    expect(refused(at({ scope: undefined }))).toBe('the identity assertion has an unknown scope')
  })

  it('rejects malformed tokens without believing any part of them', () => {
    const [header, claims, signature] = at().split('.')
    for (const token of [
      '',
      'not-a-token',
      `${header}.${claims}`,
      `${header}.${claims}.${signature}.extra`,
      `${header}..${signature}`,
      `${header}.${claims}.${signature}=`,
      `${header}.${claims}.${signature}, ${at()}`,
      `${Buffer.from('not json').toString('base64url')}.${claims}.${signature}`,
      `${Buffer.from('[]').toString('base64url')}.${claims}.${signature}`,
      `${Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWE' })).toString('base64url')}.${claims}.${signature}`,
      'a'.repeat(5000),
    ]) {
      expect(refused(token), token.slice(0, 40)).toBe('the identity assertion is malformed')
    }
    const claimsNotJson = Buffer.from('not json').toString('base64url')
    const input = `${header}.${claimsNotJson}`
    const signed = `${input}.${sign(null, Buffer.from(input), gateway.privateKey).toString('base64url')}`
    expect(refused(signed)).toBe('the identity assertion is malformed')
  })

  it('never repeats the token in a refusal', () => {
    const token = at({ sub: 'hubot' })
    expect(refused(token)).not.toContain(token.split('.')[1])
  })
})

describe('assertion scope by route', () => {
  it('lets the browser reach every route', () => {
    for (const path of ['/', '/assets/app.js', '/api/settings', '/ws/chat', '/api/link/hello', '/api/service/health']) {
      expect(scopeAllowsPath('browser', path)).toBe(true)
    }
  })

  it('keeps a Poise Link device to the Link API', () => {
    expect(scopeAllowsPath('link', '/api/link/hello')).toBe(true)
    expect(scopeAllowsPath('link', '/api/link/snippets')).toBe(true)
    for (const path of ['/', '/index.html', '/api/settings', '/api/chat/sessions', '/ws/chat', '/api/service/health', '/api/link', '/api/linked/x',
      '/api/link/../service/drain', '/api/link/%2e%2e/service/drain', '/api/link/..\\..\\service/drain']) {
      expect(scopeAllowsPath('link', path), path).toBe(false)
    }
  })

  it('keeps the gateway\'s own assertion to the service endpoints', () => {
    expect(scopeAllowsPath('admin', '/api/service/health')).toBe(true)
    expect(scopeAllowsPath('admin', '/api/service/drain')).toBe(true)
    for (const path of ['/', '/api/settings', '/api/link/hello', '/ws/chat', '/api/service', '/api/service/../settings', '/api/service/%2E%2E/settings']) {
      expect(scopeAllowsPath('admin', path), path).toBe(false)
    }
  })
})
