import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { TEST_RELAY_PATH, TestRelay, workspaceKey, workspaceRelayUrl } from '../src/test-relay.js'
import { APEX, startHarness, workspaceHost, type Harness } from './harness.js'

const PROXY = '192.168.150.10:8080'
const INSTANCE = `${TEST_RELAY_PATH}/instance`

describe('the relay agents\' test suites meet at', () => {
  let h: Harness
  const start = async (env: Record<string, string> = {}) => {
    h = await startHarness({
      env,
      testRelay: ({ privateKey, log, now, store }) => new TestRelay({
        config: { renderApiKey: 'render-key', baseService: 'crn-x', plan: 'plan-crn-003', largerPlan: 'plan-crn-005', limitSeconds: 60, maxRuns: 2 },
        privateKey,
        origin: (handle) => `https://${handle}.example`,
        log,
        now,
        isWorkspace: (handle) => store.getWorkspace(handle) !== null,
        renderApi: 'http://127.0.0.1:9/v1',
      }),
    })
    return h
  }
  afterEach(async () => { await h.close() })

  it('answers on a workspace host without a session: an instance has none', async () => {
    await start()
    const reply = await h.request({ host: workspaceHost('alice'), path: INSTANCE })
    expect(reply.status).toBe(200)
    expect(reply.body).toContain('docs/Operating.md')
    expect(reply.body).not.toContain('render-key')
  })

  it('answers at the address a proxy of the operator\'s own publishes, for workspaces that cannot reach their public address', async () => {
    await start({ POISE_PROXY_LISTEN: PROXY })
    expect((await h.request({ host: PROXY, path: INSTANCE })).status).toBe(200)
  })

  it('answers nowhere else', async () => {
    await start()
    expect((await h.request({ host: APEX, path: INSTANCE })).status).toBe(404)
    expect((await h.request({ host: 'elsewhere.example.com', path: INSTANCE })).status).toBe(404)
    expect((await h.request({ host: PROXY, path: INSTANCE })).status).toBe(404)
  })

  it('starts nothing for a key the gateway did not sign, or for a workspace that does not exist', async () => {
    await start()
    const post = (authorization?: string) => h.request({
      host: workspaceHost('alice'), path: `${TEST_RELAY_PATH}/runs`, method: 'POST', body: '{"argv":["x"],"cwd":"/","env":{}}', headers: authorization ? { authorization } : {},
    })
    const foreign = generateKeyPairSync('ed25519').privateKey
    for (const authorization of [undefined, 'Bearer ', 'Bearer alice', 'Bearer alice.', `Bearer ${workspaceKey(foreign, 'alice')}`, `Bearer ${workspaceKey(h.keys.privateKey, 'nobody')}`]) {
      expect((await post(authorization)).status).toBe(401)
    }
  })

  it('leaves other /api/link/ paths to their device tokens', async () => {
    await start()
    expect((await h.request({ host: workspaceHost('alice'), path: '/api/link/events' })).status).not.toBe(200)
  })

  it('is not there when unset, and a request gets what any path gets', async () => {
    h = await startHarness()
    const reply = await h.request({ host: workspaceHost('alice'), path: INSTANCE })
    expect(reply.status).not.toBe(200)
    expect(reply.body).not.toContain('docs/Operating.md')
  })
})

describe('where a workspace reaches the relay', () => {
  it('is the published address behind a proxy of the operator\'s own, or else its public host', () => {
    expect(workspaceRelayUrl({ insecureHttp: false, domain: 'poise.example.com', proxyListen: null }, 'alice')).toBe('https://alice.poise.example.com/api/link/test-relay')
    expect(workspaceRelayUrl({ insecureHttp: true, domain: 'poise.test', proxyListen: null }, 'alice')).toBe('http://alice.poise.test/api/link/test-relay')
    expect(workspaceRelayUrl({ insecureHttp: false, domain: 'poise.example.com', proxyListen: PROXY }, 'alice')).toBe(`http://${PROXY}/api/link/test-relay`)
  })
})

describe('the gateway image', () => {
  it('ships the instance script beside the relay that serves it', () => {
    const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: { build: string } }
    expect(scripts.build).toContain('cp src/test-instance.cjs dist/test-instance.cjs')
  })
})
