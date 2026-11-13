import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { TEST_RELAY_PATH, TestRelay, workspaceKey, workspaceRelayUrl } from '../src/test-relay.js'
import { APEX, startHarness, workspaceHost, type Harness } from './harness.js'

const PROXY = '192.168.150.10:8080'
const RUNS = `${TEST_RELAY_PATH}/runs`
const POST = { method: 'POST', body: '{}' }

describe('the relay agents\' test suites meet at', () => {
  let h: Harness
  const start = async (env: Record<string, string> = {}) => {
    h = await startHarness({
      env,
      testRelay: ({ privateKey, log, now, store }) => new TestRelay({
        config: { renderApiKey: 'render-key', workspace: 'tea-x', deployment: 'poise.example.com', plan: '1c-2g', baseService: null, jobPlan: 'plan-crn-005', limitSeconds: 60, maxRuns: 2 },
        privateKey,
        origin: (handle) => `https://${handle}.poise.example.com`,
        log,
        now,
        isWorkspace: (handle) => store.getWorkspace(handle) !== null && store.getUser(handle)?.disabledAt === null,
        renderApi: 'http://127.0.0.1:9/v1',
      }),
    })
    return h
  }
  afterEach(async () => { await h.close() })

  // A run without a key is refused by the relay itself, so its 401 tells it got there.
  it('answers on a workspace host without a session: the key is what counts', async () => {
    await start()
    const reply = await h.request({ host: workspaceHost('alice'), path: RUNS, ...POST })
    expect(reply.status).toBe(401)
    expect(reply.body).toContain('is not a workspace')
    expect(reply.body).not.toContain('render-key')
  })

  it('answers at the address a proxy of the operator\'s own publishes, for workspaces that cannot reach their public address', async () => {
    await start({ POISE_PROXY_LISTEN: PROXY })
    expect((await h.request({ host: PROXY, path: RUNS, ...POST })).body).toContain('is not a workspace')
  })

  it('answers nowhere else', async () => {
    await start()
    for (const host of [APEX, 'elsewhere.example.com', PROXY]) {
      expect((await h.request({ host, path: RUNS, ...POST })).body).not.toContain('is not a workspace')
    }
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

  it('accepts repeated retired-run cleanup only while the owner still has access', async () => {
    await start()
    await h.openWorkspace('Alice')
    h.store.noteWorkspace('alice', 'Alice')
    const headers = { authorization: `Bearer ${workspaceKey(h.keys.privateKey, 'alice')}` }
    const created = await h.request({ host: workspaceHost('alice'), path: RUNS, method: 'POST', headers, body: '{"argv":["x"],"cwd":"/","env":{}}' })
    expect(created.status).toBe(201)
    const path = `${RUNS}/${created.json<{ id: string }>().id}`
    for (let repeat = 0; repeat < 2; repeat += 1) {
      expect((await h.request({ host: workspaceHost('alice'), path, method: 'DELETE', headers })).status).toBe(204)
    }
    expect(h.logs.filter(({ event }) => event === 'test_relay.request.failed')).toEqual([])
    h.store.disableUser('alice', 'root')
    expect((await h.request({ host: workspaceHost('alice'), path, method: 'DELETE', headers })).status).toBe(401)
    expect(h.logs).toContainEqual(expect.objectContaining({ event: 'test_relay.request.failed', method: 'DELETE', path, status: 401 }))
  })

  it('is not there when unset, and a request gets what any path gets', async () => {
    h = await startHarness()
    const reply = await h.request({ host: workspaceHost('alice'), path: RUNS, ...POST })
    expect(reply.body).not.toContain('is not a workspace')
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
  it('ships every file the relay reads beside itself, what a box and a job run', () => {
    const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: { build: string } }
    const source = readFileSync(new URL('../src/test-relay.ts', import.meta.url), 'utf8')
    const read = [...source.matchAll(/new URL\('\.\/([^']+)', import\.meta\.url\)/g)].map((match) => match[1])
    expect(read).toEqual(expect.arrayContaining(['test-box.cjs', 'test-box-setup.sh', 'test-instance.cjs']))
    const copied = [...scripts.build.matchAll(/ src\/(\S+)/g)].map((match) => match[1])
    for (const file of read) expect(copied).toContain(file)
  })
})
