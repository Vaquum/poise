import { generateKeyPairSync } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyServiceEnvironment, isServiceMode, readServiceConfig } from '../server/service/config'
import { HANDLE, OWNER, PUBLIC_HOST, PUBLIC_ORIGIN, gatewayKeys, serviceEnvironment } from './service-fixture'

const keys = gatewayKeys()
const pemBase64 = (pem: string | Buffer) => Buffer.from(pem.toString()).toString('base64')

describe('service-mode configuration', () => {
  it('changes nothing when POISE_MODE is unset', () => {
    expect(isServiceMode({})).toBe(false)
    expect(readServiceConfig({ POISE_WORKSPACE_HANDLE: 'ignored' })).toBeNull()
  })

  it('refuses any POISE_MODE other than service', () => {
    for (const mode of ['', 'Service', 'local', 'servcie']) {
      expect(() => isServiceMode({ POISE_MODE: mode })).toThrow(`POISE_MODE must be "service" or unset; it is "${mode}"`)
      expect(() => readServiceConfig({ ...serviceEnvironment(keys), POISE_MODE: mode })).toThrow(/POISE_MODE/)
    }
  })

  it('reads the workspace the gateway configured', () => {
    const config = readServiceConfig(serviceEnvironment(keys))!
    expect(config).toMatchObject({ handle: HANDLE, owner: OWNER, publicOrigin: PUBLIC_ORIGIN, publicHost: PUBLIC_HOST })
    expect(config.gatewayKey.asymmetricKeyType).toBe('ed25519')
  })

  it('names every missing variable at once', () => {
    let message = ''
    try { readServiceConfig({ POISE_MODE: 'service' }) } catch (error) { message = (error as Error).message }
    for (const name of ['POISE_WORKSPACE_HANDLE', 'POISE_WORKSPACE_OWNER', 'POISE_PUBLIC_ORIGIN', 'POISE_GATEWAY_PUBLIC_KEY']) {
      expect(message).toContain(`${name} is required`)
    }
  })

  it('refuses a handle or owner that is not the same GitHub login', () => {
    const env = serviceEnvironment(keys)
    expect(() => readServiceConfig({ ...env, POISE_WORKSPACE_HANDLE: 'OctoCat' })).toThrow(/POISE_WORKSPACE_HANDLE must be a GitHub login in lower case/)
    expect(() => readServiceConfig({ ...env, POISE_WORKSPACE_OWNER: 'not a login' })).toThrow(/POISE_WORKSPACE_OWNER must be a GitHub login/)
    expect(() => readServiceConfig({ ...env, POISE_WORKSPACE_OWNER: 'hubot' })).toThrow(/POISE_WORKSPACE_OWNER "hubot" is not the login whose handle is "octocat"/)
  })

  it('accepts only an https origin whose host is the handle followed by a domain', () => {
    const env = serviceEnvironment(keys)
    for (const origin of [
      'ftp://octocat.poise.example.test',
      `${PUBLIC_ORIGIN}/`,
      `${PUBLIC_ORIGIN}/workspace`,
      'https://OctoCat.poise.example.test',
      'https://user:secret@octocat.poise.example.test',
      'https://hubot.poise.example.test',
      'https://octocat.',
      'https://poise.example.test',
      'not a url',
    ]) {
      expect(() => readServiceConfig({ ...env, POISE_PUBLIC_ORIGIN: origin }), origin).toThrow(/POISE_PUBLIC_ORIGIN/)
    }
    expect(readServiceConfig({ ...env, POISE_PUBLIC_ORIGIN: 'https://octocat.example.test:8443' })).toMatchObject({
      publicOrigin: 'https://octocat.example.test:8443',
      publicProtocol: 'https:',
      publicHost: 'octocat.example.test:8443',
    })
  })

  // The gateway's POISE_INSECURE_HTTP mode for local and CI end-to-end runs.
  it('accepts a plain http origin only on a localhost, *.localhost or *.test host', () => {
    const env = serviceEnvironment(keys)
    for (const origin of ['http://octocat.localhost', 'http://octocat.localhost:5555', 'http://octocat.poise.localhost', 'http://octocat.test', 'http://octocat.poise.example.test:8080']) {
      expect(readServiceConfig({ ...env, POISE_PUBLIC_ORIGIN: origin }), origin).toMatchObject({ publicOrigin: origin, publicProtocol: 'http:' })
    }
    for (const origin of ['http://octocat.example.com', 'http://octocat.localhost.example.com', 'http://octocat.test.example.com', 'http://octocat.testing', 'http://octocat.localhostx']) {
      expect(() => readServiceConfig({ ...env, POISE_PUBLIC_ORIGIN: origin }), origin)
        .toThrow(`POISE_PUBLIC_ORIGIN may use http only on a localhost, *.localhost or *.test host; it is "${origin}"`)
    }
    // Still the handle followed by a domain, and still exactly an origin.
    expect(() => readServiceConfig({ ...env, POISE_PUBLIC_ORIGIN: 'http://localhost' })).toThrow(/host must be the workspace handle followed by a domain/)
    expect(() => readServiceConfig({ ...env, POISE_PUBLIC_ORIGIN: 'http://octocat.localhost/' })).toThrow(/with no path or trailing slash/)
  })

  it('accepts only the base64 of an Ed25519 SPKI public key PEM', () => {
    const env = serviceEnvironment(keys)
    const ed25519 = generateKeyPairSync('ed25519')
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const p256 = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const refused: Array<[string, RegExp]> = [
      ['not base64!', /SPKI public key PEM, encoded as single-line base64/],
      [Buffer.from('-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n').toString('base64'), /not a readable public key/],
      // A private key would derive a public one; it is not what the gateway publishes.
      [pemBase64(ed25519.privateKey.export({ type: 'pkcs8', format: 'pem' })), /SPKI public key PEM/],
      [pemBase64(rsa.publicKey.export({ type: 'spki', format: 'pem' })), /must be an Ed25519 key; it is rsa/],
      [pemBase64(p256.publicKey.export({ type: 'spki', format: 'pem' })), /must be an Ed25519 key; it is ec/],
      [`${keys.publicKey.slice(0, 40)}\n${keys.publicKey.slice(40)}`, /single-line base64/],
    ]
    for (const [value, reason] of refused) {
      expect(() => readServiceConfig({ ...env, POISE_GATEWAY_PUBLIC_KEY: value })).toThrow(reason)
    }
  })

  it('reads how long the gateway waits for a drain, 1800 seconds when unset', () => {
    const env = serviceEnvironment(keys)
    expect(readServiceConfig(env)?.drainTimeoutSeconds).toBe(1800)
    expect(readServiceConfig({ ...env, POISE_DRAIN_TIMEOUT: '600' })?.drainTimeoutSeconds).toBe(600)
    for (const value of ['', '0', '-5', '1.5', '30m', '1e3', ' 600', '604801']) {
      expect(() => readServiceConfig({ ...env, POISE_DRAIN_TIMEOUT: value }), JSON.stringify(value))
        .toThrow(`POISE_DRAIN_TIMEOUT must be a whole number of seconds from 1 to 604800; it is "${value}"`)
    }
  })

  it('passes Caller a data directory in the home volume unless one is set', () => {
    const env: NodeJS.ProcessEnv = {}
    applyServiceEnvironment(env)
    expect(env.AGENT_INTERFACE_DATA_DIR).toBe(join(homedir(), '.poise', 'agent-interface'))
    const explicit: NodeJS.ProcessEnv = { AGENT_INTERFACE_DATA_DIR: '/data/caller' }
    applyServiceEnvironment(explicit)
    expect(explicit.AGENT_INTERFACE_DATA_DIR).toBe('/data/caller')
  })
})
