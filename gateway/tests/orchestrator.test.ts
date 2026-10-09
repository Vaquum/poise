import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import {
  CURRENT_IMAGE_ID, events, GATEWAY_DATA_SOURCE, OLD_IMAGE_ID, startHarness, verifyAssertion, workspaceHost,
  type Harness, type HarnessOptions,
} from './harness.js'
import { MAX_SERVICE_ANSWER_BYTES } from '../src/orchestrator.js'

const ALICE = workspaceHost('alice')
const NAVIGATE = { 'sec-fetch-mode': 'navigate', accept: 'text/html' }

function dockerCalls(h: Harness): string[] {
  return h.docker.calls.map((call) => `${call.method} ${call.path.split('?')[0]}`)
}

interface WorkspaceContainerOptions {
  /** Whether the gateway's container is on the workspace's network; a recreated one is on none. */
  gatewayJoined?: boolean
  /** The environment the container was created with; by default it holds the gateway's drain timeout. */
  env?: string[]
  /** The resolvers it was created with: its resolver file's path on the Docker host and its poise.dns label. */
  dns?: { file: string; label: string }
}

function addWorkspaceContainer(h: Harness, handle: string, imageId: string, running: boolean, options: WorkspaceContainerOptions = {}): void {
  const { gatewayJoined = true, env = [`POISE_DRAIN_TIMEOUT=${h.config.drainTimeoutSeconds}`], dns } = options
  h.docker.volumes.add(`poise-home-${handle}`)
  h.docker.networks.add(`poise-net-${handle}`)
  if (gatewayJoined) h.docker.containers.get('poise-gateway')?.networks.add(`poise-net-${handle}`)
  const mounts = [{ Type: 'volume', Source: `poise-home-${handle}`, Target: '/home/poise' }]
  if (dns) mounts.push({ Type: 'bind', Source: dns.file, Target: '/etc/resolv.conf' })
  h.docker.addContainer({
    name: `poise-ws-${handle}`,
    imageId,
    imageRef: 'poise-runtime:latest',
    running,
    labels: { 'poise.managed': 'true', 'poise.workspace': handle, ...(dns ? { 'poise.dns': dns.label } : {}) },
    networks: new Set([`poise-net-${handle}`]),
    spec: { Env: env, HostConfig: { Mounts: mounts } },
  })
}

const RESOLV_CONF = `${GATEWAY_DATA_SOURCE}/workspace-resolv.conf`

function containerEnv(h: Harness, handle: string): string[] {
  return (h.docker.containers.get(`poise-ws-${handle}`)?.spec as { Env: string[] }).Env
}

function gatewayNetworks(h: Harness): string[] {
  return [...(h.docker.containers.get('poise-gateway')?.networks ?? [])]
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return
    await delay(10)
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe('lazy start', () => {
  let h: Harness
  const start = async (options?: HarnessOptions) => {
    h = await startHarness(options)
    h.workspace.reachable = false
    h.docker.onStart = () => {
      h.workspace.reachable = true
    }
    return (await h.openWorkspace('Alice')).workspaceCookie
  }
  afterEach(async () => {
    await h.close()
  })

  it('creates the workspace on first request behind a starting page, then proxies to it', async () => {
    const cookie = await start()
    const first = await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })
    expect(first.status).toBe(503)
    expect(first.body).toContain('Starting your workspace')
    expect(first.body).toContain('<meta http-equiv="refresh" content="2">')
    expect(first.headers['retry-after']).toBe('2')

    await h.orchestrator.startInProgress('alice')
    expect(dockerCalls(h)).toEqual([
      // The health check first looks for a network to join; a workspace never started has none.
      'GET /networks/poise-net-alice',
      'GET /volumes/poise-home-alice',
      'POST /volumes/create',
      'GET /networks/poise-net-alice',
      'POST /networks/create',
      'GET /containers/poise-gateway/json',
      'POST /networks/poise-net-alice/connect',
      'GET /containers/poise-ws-alice/json',
      'POST /containers/create',
      'POST /containers/poise-ws-alice/start',
    ])
    expect(h.docker.calls[2].body).toEqual({ Name: 'poise-home-alice' })
    expect(h.docker.calls[4].body).toEqual({ Name: 'poise-net-alice', Driver: 'bridge' })
    expect(h.docker.calls[6].body).toEqual({ Container: 'poise-gateway' })
    expect(h.docker.calls[8].path).toBe('/containers/create?name=poise-ws-alice')

    const ready = await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })
    expect(ready.status).toBe(200)
    expect(h.workspace.requests.map((request) => request.url)).toEqual(['/'])

    // Readiness is checked through /api/service/health with an admin assertion for the owner.
    const health = h.workspace.serviceRequests.at(-1)
    expect(health?.url).toBe('/api/service/health')
    expect(health?.headers.host).toBe(ALICE)
    expect(health?.headers['x-forwarded-proto']).toBe('https')
    expect(verifyAssertion(String(health?.headers['x-poise-identity']), h.keys.publicKeyBase64))
      .toMatchObject({ aud: 'workspace:alice', sub: 'Alice', scope: 'admin' })
    expect(events(h.logs, 'workspace.')).toEqual([
      'workspace.volume.created',
      'workspace.network.created',
      'workspace.network.connected',
      'workspace.container.created',
      'workspace.container.started',
      'workspace.ready',
    ])
  })

  it('creates the container with exactly the contract settings and environment', async () => {
    const cookie = await start({ env: {
      POISE_WORKSPACE_MEMORY: '2g', POISE_WORKSPACE_CPUS: '1.5', POISE_WORKSPACE_PIDS: '512', POISE_WORKSPACE_RUNTIME: 'runsc', POISE_DRAIN_TIMEOUT: '600',
    } })
    await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })
    await h.orchestrator.startInProgress('alice')
    const create = h.docker.calls.find((call) => call.path.startsWith('/containers/create'))
    expect(create?.body).toEqual({
      Image: 'poise-runtime:latest',
      User: '10001',
      Env: [
        'POISE_MODE=service',
        'POISE_WORKSPACE_HANDLE=alice',
        'POISE_WORKSPACE_OWNER=Alice',
        `POISE_PUBLIC_ORIGIN=https://${ALICE}`,
        `POISE_GATEWAY_PUBLIC_KEY=${h.keys.publicKeyBase64}`,
        'POISE_HOST=0.0.0.0',
        'POISE_PORT=5555',
        'HOME=/home/poise',
        'POISE_DRAIN_TIMEOUT=600',
      ],
      Labels: { 'poise.managed': 'true', 'poise.workspace': 'alice' },
      HostConfig: {
        Init: true,
        SecurityOpt: ['no-new-privileges'],
        CapDrop: ['ALL'],
        Memory: 2 * 1024 ** 3,
        NanoCpus: 1_500_000_000,
        PidsLimit: 512,
        RestartPolicy: { Name: 'unless-stopped' },
        Runtime: 'runsc',
        Mounts: [{ Type: 'volume', Source: 'poise-home-alice', Target: '/home/poise' }],
        NetworkMode: 'poise-net-alice',
      },
      NetworkingConfig: { EndpointsConfig: { 'poise-net-alice': {} } },
    })
  })

  it('tells workspaces to skip the CLI bootstrap only when POISE_WORKSPACE_SKIP_CLI_BOOTSTRAP=1', async () => {
    const cookie = await start({ env: { POISE_WORKSPACE_SKIP_CLI_BOOTSTRAP: '1' } })
    await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })
    await h.orchestrator.startInProgress('alice')
    const create = h.docker.calls.find((call) => call.path.startsWith('/containers/create'))
    expect((create?.body as { Env: string[] }).Env).toEqual([
      'POISE_MODE=service',
      'POISE_WORKSPACE_HANDLE=alice',
      'POISE_WORKSPACE_OWNER=Alice',
      `POISE_PUBLIC_ORIGIN=https://${ALICE}`,
      `POISE_GATEWAY_PUBLIC_KEY=${h.keys.publicKeyBase64}`,
      'POISE_HOST=0.0.0.0',
      'POISE_PORT=5555',
      'HOME=/home/poise',
      'POISE_DRAIN_TIMEOUT=5400',
      'POISE_SKIP_CLI_BOOTSTRAP=1',
    ])
  })

  it('leaves out the OCI runtime unless one is configured', async () => {
    const cookie = await start()
    await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })
    await h.orchestrator.startInProgress('alice')
    const create = h.docker.calls.find((call) => call.path.startsWith('/containers/create'))
    expect((create?.body as { HostConfig: Record<string, unknown> }).HostConfig).not.toHaveProperty('Runtime')
  })

  it('mounts the POISE_WORKSPACE_DNS resolvers over /etc/resolv.conf, read-only, and records them', async () => {
    const cookie = await start({ env: { POISE_WORKSPACE_DNS: '1.1.1.1, 2606:4700:4700::1111' } })
    await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })
    await h.orchestrator.startInProgress('alice')
    const create = h.docker.calls.find((call) => call.path.startsWith('/containers/create'))
    const body = create?.body as { Labels: Record<string, string>; HostConfig: { Mounts: unknown[] } }
    expect(body.HostConfig.Mounts).toEqual([
      { Type: 'volume', Source: 'poise-home-alice', Target: '/home/poise' },
      { Type: 'bind', Source: RESOLV_CONF, Target: '/etc/resolv.conf', ReadOnly: true },
    ])
    expect(body.Labels).toEqual({ 'poise.managed': 'true', 'poise.workspace': 'alice', 'poise.dns': '1.1.1.1,2606:4700:4700::1111' })
  })

  it('leaves /etc/resolv.conf to Docker unless POISE_WORKSPACE_DNS is set', async () => {
    const cookie = await start()
    await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })
    await h.orchestrator.startInProgress('alice')
    const create = h.docker.calls.find((call) => call.path.startsWith('/containers/create'))
    const body = create?.body as { Labels: Record<string, string>; HostConfig: { Mounts: unknown[] } }
    expect(body.HostConfig.Mounts).toEqual([{ Type: 'volume', Source: 'poise-home-alice', Target: '/home/poise' }])
    expect(body.Labels).not.toHaveProperty('poise.dns')
  })

  it('reuses an existing volume and network and does not reconnect the gateway', async () => {
    const cookie = await start()
    h.docker.volumes.add('poise-home-alice')
    h.docker.networks.add('poise-net-alice')
    h.docker.containers.get('poise-gateway')?.networks.add('poise-net-alice')
    await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })
    await h.orchestrator.startInProgress('alice')
    expect(dockerCalls(h)).toEqual([
      'GET /networks/poise-net-alice',
      'GET /containers/poise-gateway/json',
      'GET /volumes/poise-home-alice',
      'GET /networks/poise-net-alice',
      'GET /containers/poise-gateway/json',
      'GET /containers/poise-ws-alice/json',
      'POST /containers/create',
      'POST /containers/poise-ws-alice/start',
    ])
  })

  it('answers API calls and WebSocket upgrades with 503 while the workspace starts', async () => {
    const cookie = await start()
    h.docker.onStart = () => undefined
    const api = await h.request({ host: ALICE, path: '/api/state', headers: { cookie } })
    expect(api.status).toBe(503)
    expect(api.json()).toMatchObject({ error: 'workspace_starting' })
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${h.port}/ws/chat`, { headers: { host: ALICE, cookie } })
      socket.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      socket.on('error', reject)
    })
    expect(status).toBe(503)
    await h.orchestrator.startInProgress('alice')
  })

  it('shows why a start failed on the starting page and logs it', async () => {
    const cookie = await start()
    h.docker.images.clear()
    await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })
    await h.orchestrator.startInProgress('alice')
    const page = await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })
    expect(page.status).toBe(503)
    expect(page.body).toContain('The last start failed: Docker Engine POST /containers/create failed with HTTP 404: No such image: poise-runtime:latest')
    expect(h.logs.find((entry) => entry.event === 'workspace.start.failed')).toMatchObject({ handle: 'alice' })
    await h.orchestrator.startInProgress('alice')
  })

  it('logs a start failure it cannot record instead of crashing on the rejection', async () => {
    const cookie = await start()
    h.docker.images.clear()
    const record = vi.spyOn(h.store, 'noteWorkspaceError').mockImplementation(() => {
      throw new Error('database is locked')
    })
    await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })
    await h.orchestrator.startInProgress('alice')
    expect(record).toHaveBeenCalled()
    expect(h.logs.find((entry) => entry.event === 'workspace.start.failure.unrecorded')).toMatchObject({ handle: 'alice', error: 'database is locked' })
    record.mockRestore()
  })

  it('shows a workspace that refuses the health check instead of waiting forever', async () => {
    const cookie = await start()
    h.workspace.reachable = true
    h.workspace.healthStatus = 401
    const page = await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })
    expect(page.status).toBe(503)
    expect(page.body).toContain('the workspace answered GET /api/service/health with HTTP 401')
    expect(events(h.logs, 'workspace.health.refused')).toHaveLength(1)
    await h.orchestrator.startInProgress('alice')
  })

  it('stops reading a health answer longer than any health answer can be', async () => {
    const cookie = await start()
    h.workspace.reachable = true
    h.workspace.healthPadding = MAX_SERVICE_ANSWER_BYTES
    const page = await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })
    expect(page.status).toBe(503)
    expect(page.body).toContain(`the workspace answered GET /api/service/health with more than ${MAX_SERVICE_ANSWER_BYTES} bytes`)
    await h.orchestrator.startInProgress('alice')
  })

  it('recreates a stopped container on an outdated image before starting it', async () => {
    const cookie = await start()
    addWorkspaceContainer(h, 'alice', OLD_IMAGE_ID, false)
    await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })
    await h.orchestrator.startInProgress('alice')
    expect(dockerCalls(h).slice(5)).toEqual([
      'GET /containers/poise-ws-alice/json',
      'GET /images/poise-runtime:latest/json',
      // Its release, made current before the new container starts; this image names none.
      'GET /images/poise-runtime:latest/json',
      'DELETE /containers/poise-ws-alice',
      'POST /containers/create',
      'POST /containers/poise-ws-alice/start',
    ])
    expect(h.logs.find((entry) => entry.event === 'workspace.container.removed')).toMatchObject({ handle: 'alice', reason: 'outdated image' })
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: CURRENT_IMAGE_ID, running: true })
  })

  it('recreates a stopped container with another drain timeout before starting it', async () => {
    const cookie = await start({ env: { POISE_DRAIN_TIMEOUT: '600' } })
    addWorkspaceContainer(h, 'alice', CURRENT_IMAGE_ID, false, { env: ['POISE_DRAIN_TIMEOUT=1800'] })
    await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })
    await h.orchestrator.startInProgress('alice')
    expect(dockerCalls(h).slice(5)).toEqual([
      'GET /containers/poise-ws-alice/json',
      'GET /images/poise-runtime:latest/json',
      // Its release, made current before the new container starts; this image names none.
      'GET /images/poise-runtime:latest/json',
      'DELETE /containers/poise-ws-alice',
      'POST /containers/create',
      'POST /containers/poise-ws-alice/start',
    ])
    expect(h.logs.find((entry) => entry.event === 'workspace.container.removed')).toMatchObject({ handle: 'alice', reason: 'changed drain timeout' })
    expect(containerEnv(h, 'alice')).toContain('POISE_DRAIN_TIMEOUT=600')
    expect(h.docker.containers.get('poise-ws-alice')?.running).toBe(true)
  })

  it.each([
    ['without resolvers, now that POISE_WORKSPACE_DNS is set', '1.1.1.1', undefined],
    ['with other resolvers', '1.1.1.1', { file: RESOLV_CONF, label: '8.8.8.8' }],
    ['with resolvers, now that POISE_WORKSPACE_DNS is unset', undefined, { file: RESOLV_CONF, label: '1.1.1.1' }],
  ])('recreates a stopped container created %s before starting it', async (_case, setting, dns) => {
    const cookie = await start({ env: { POISE_WORKSPACE_DNS: setting } })
    addWorkspaceContainer(h, 'alice', CURRENT_IMAGE_ID, false, { dns })
    await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })
    await h.orchestrator.startInProgress('alice')
    expect(dockerCalls(h)).toContain('DELETE /containers/poise-ws-alice')
    expect(h.logs.find((entry) => entry.event === 'workspace.container.removed')).toMatchObject({ handle: 'alice', reason: 'changed workspace DNS' })
    expect(h.docker.containers.get('poise-ws-alice')?.labels['poise.dns']).toBe(setting)
  })

  it('starts a stopped container created with the configured resolvers as it is', async () => {
    const cookie = await start({ env: { POISE_WORKSPACE_DNS: '1.1.1.1' } })
    addWorkspaceContainer(h, 'alice', CURRENT_IMAGE_ID, false, { dns: { file: RESOLV_CONF, label: '1.1.1.1' } })
    await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })
    await h.orchestrator.startInProgress('alice')
    expect(dockerCalls(h)).not.toContain('DELETE /containers/poise-ws-alice')
    expect(h.docker.containers.get('poise-ws-alice')?.running).toBe(true)
  })
})

describe('image upgrades', () => {
  let h: Harness
  const start = async (options?: HarnessOptions) => {
    h = await startHarness(options)
    await h.openWorkspace('Alice')
    await h.openWorkspace('bob')
    h.store.noteWorkspace('alice', 'Alice')
    h.store.noteWorkspace('bob', 'bob')
    addWorkspaceContainer(h, 'alice', OLD_IMAGE_ID, true)
    addWorkspaceContainer(h, 'bob', CURRENT_IMAGE_ID, true)
  }
  afterEach(async () => {
    await h.close()
  })

  it('drains an outdated running workspace until it is idle, then recreates it on the same volume', async () => {
    await start()
    const aliceId = h.docker.containers.get('poise-ws-alice')?.id
    const bobId = h.docker.containers.get('poise-ws-bob')?.id
    h.workspace.health.activeChatTurns = 1
    h.workspace.health.runningCallerCalls = 2
    setTimeout(() => {
      h.workspace.health.activeChatTurns = 0
      h.workspace.health.runningCallerCalls = 0
    }, 60)
    await h.orchestrator.upgradePass()

    const drain = h.workspace.serviceRequests[0]
    expect(drain.method).toBe('POST')
    expect(drain.url).toBe('/api/service/drain')
    expect(drain.headers.host).toBe(ALICE)
    expect(verifyAssertion(String(drain.headers['x-poise-identity']), h.keys.publicKeyBase64))
      .toMatchObject({ aud: 'workspace:alice', sub: 'Alice', scope: 'admin' })
    // Health while it waits, then the drain again just before the container stops.
    expect(h.workspace.serviceRequests.slice(1, -1).every((request) => request.url === '/api/service/health')).toBe(true)
    expect(h.workspace.serviceRequests.at(-1)).toMatchObject({ method: 'POST', url: '/api/service/drain' })
    expect(h.workspace.serviceRequests.length).toBeGreaterThan(2)

    expect(dockerCalls(h)).toEqual([
      'GET /images/poise-runtime:latest/json',
      // The release it carries, if it names one; this image does not, so every update needs a new container.
      'GET /images/poise-runtime:latest/json',
      'GET /containers/json',
      `GET /containers/${aliceId}/json`,
      'GET /containers/poise-ws-alice/json',
      // Before the first call to the workspace, the gateway makes sure it is on its network.
      'GET /networks/poise-net-alice',
      'GET /containers/poise-gateway/json',
      'GET /containers/poise-ws-alice/json',
      'POST /containers/poise-ws-alice/stop',
      'DELETE /containers/poise-ws-alice',
      'POST /containers/create',
      'POST /containers/poise-ws-alice/start',
      `GET /containers/${bobId}/json`,
    ])
    expect(h.logs.find((entry) => entry.event === 'workspace.upgrade.started')).toMatchObject({ handle: 'alice', reason: 'outdated image' })
    const recreated = h.docker.containers.get('poise-ws-alice')
    expect(recreated).toMatchObject({ imageId: CURRENT_IMAGE_ID, running: true })
    expect((recreated?.spec as { HostConfig: { Mounts: unknown } }).HostConfig.Mounts)
      .toEqual([{ Type: 'volume', Source: 'poise-home-alice', Target: '/home/poise' }])
    expect(h.docker.containers.get('poise-ws-bob')?.imageId).toBe(CURRENT_IMAGE_ID)
    expect(events(h.logs, 'workspace.')).toEqual([
      'workspace.upgrade.started',
      'workspace.drain.requested',
      'workspace.drain.idle',
      'workspace.container.stopped',
      'workspace.container.removed',
      'workspace.container.created',
      'workspace.container.started',
      'workspace.upgrade.finished',
    ])
  })

  it('keeps waiting while background work runs, even with no Chat turns or Caller calls', async () => {
    await start()
    h.workspace.health.backgroundWork = 1
    let finishedAt = 0
    setTimeout(() => {
      h.workspace.health.backgroundWork = 0
      finishedAt = Date.now()
    }, 80)
    await h.orchestrator.upgradePass()
    expect(finishedAt).toBeGreaterThan(0)
    expect(events(h.logs, 'workspace.drain')).toEqual(['workspace.drain.requested', 'workspace.drain.idle'])
    expect(h.logs.find((entry) => entry.event === 'workspace.drain.requested')).toMatchObject({ backgroundWork: 1 })
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: CURRENT_IMAGE_ID, running: true })
  })

  it('renews the drain while it waits, because the workspace lets an unrenewed drain lapse', async () => {
    await start({ drainRenewMs: 40 })
    h.workspace.health.activeChatTurns = 1
    setTimeout(() => {
      h.workspace.health.activeChatTurns = 0
    }, 200)
    await h.orchestrator.upgradePass()
    const calls = h.workspace.serviceRequests.map((request) => `${request.method} ${request.url}`)
    expect(calls.filter((call) => call === 'POST /api/service/drain').length).toBeGreaterThanOrEqual(3)
    expect(calls.filter((call) => call === 'GET /api/service/health').length).toBeGreaterThanOrEqual(3)
    expect(h.docker.containers.get('poise-ws-alice')?.imageId).toBe(CURRENT_IMAGE_ID)
  })

  it('recreates a busy workspace once POISE_DRAIN_TIMEOUT has passed', async () => {
    await start({ env: { POISE_DRAIN_TIMEOUT: '1' } })
    h.workspace.health.activeChatTurns = 1
    const began = Date.now()
    await h.orchestrator.upgradePass()
    expect(Date.now() - began).toBeGreaterThanOrEqual(1000)
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: CURRENT_IMAGE_ID, running: true })
    expect(h.logs.find((entry) => entry.event === 'workspace.drain.timeout')).toMatchObject({ handle: 'alice', timeoutSeconds: 1 })
  })

  it('drains and recreates a running workspace created with another drain timeout, as for a new image', async () => {
    await start({ env: { POISE_DRAIN_TIMEOUT: '600' } })
    const bobId = h.docker.containers.get('poise-ws-bob')?.id
    // carol's workspace was created with another timeout, dave's before the gateway passed one at all.
    for (const [handle, env] of [['carol', ['POISE_DRAIN_TIMEOUT=1800']], ['dave', []]] as const) {
      h.store.noteWorkspace(handle, handle)
      addWorkspaceContainer(h, handle, CURRENT_IMAGE_ID, true, { env: [...env] })
    }
    await h.orchestrator.upgradePass()
    for (const handle of ['carol', 'dave']) {
      expect(h.logs.filter((entry) => entry.handle === handle).map((entry) => entry.event)).toEqual([
        'workspace.upgrade.started',
        'workspace.drain.requested',
        'workspace.container.stopped',
        'workspace.container.removed',
        'workspace.container.created',
        'workspace.container.started',
        'workspace.upgrade.finished',
      ])
      expect(h.logs.find((entry) => entry.event === 'workspace.upgrade.started' && entry.handle === handle))
        .toMatchObject({ reason: 'changed drain timeout' })
      expect(h.workspace.serviceRequests.filter((request) => request.headers.host === workspaceHost(handle)).map((request) => request.url))
        .toEqual(['/api/service/drain'])
      expect(containerEnv(h, handle)).toContain('POISE_DRAIN_TIMEOUT=600')
      expect(h.docker.containers.get(`poise-ws-${handle}`)).toMatchObject({ imageId: CURRENT_IMAGE_ID, running: true })
    }
    // bob's workspace already has the gateway's timeout and keeps running as it is.
    expect(h.docker.containers.get('poise-ws-bob')?.id).toBe(bobId)
  })

  it('recreates a stopped outdated workspace without draining or starting it', async () => {
    await start()
    const alice = h.docker.containers.get('poise-ws-alice')
    if (alice) alice.running = false
    await h.orchestrator.upgradePass()
    expect(h.workspace.serviceRequests).toHaveLength(0)
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: CURRENT_IMAGE_ID, running: false })
    expect(dockerCalls(h)).not.toContain('POST /containers/poise-ws-alice/start')
  })

  it('logs and skips the pass when the runtime image is missing', async () => {
    await start()
    h.docker.images.clear()
    await h.orchestrator.upgradePass()
    expect(h.logs.find((entry) => entry.event === 'workspace.upgrade.image.missing')).toMatchObject({ image: 'poise-runtime:latest' })
    expect(h.docker.containers.get('poise-ws-alice')?.imageId).toBe(OLD_IMAGE_ID)
  })

  it('skips a managed container no workspace record names', async () => {
    await start()
    addWorkspaceContainer(h, 'stranger', OLD_IMAGE_ID, true)
    await h.orchestrator.upgradePass()
    expect(h.logs.find((entry) => entry.event === 'workspace.upgrade.skipped')).toMatchObject({ container: '/poise-ws-stranger' })
    expect(h.docker.containers.get('poise-ws-stranger')?.imageId).toBe(OLD_IMAGE_ID)
    expect(h.docker.containers.get('poise-ws-alice')?.imageId).toBe(CURRENT_IMAGE_ID)
  })

  it('runs one pass at a time', async () => {
    await start({ env: { POISE_DRAIN_TIMEOUT: '1' } })
    h.workspace.health.activeChatTurns = 1
    const first = h.orchestrator.upgradePass()
    await h.orchestrator.upgradePass()
    expect(events(h.logs, 'workspace.upgrade.pass.skipped')).toHaveLength(1)
    await first
  })

  it('checks at start and then on every interval', async () => {
    await start()
    const stop = h.orchestrator.startUpgradeLoop(50)
    try {
      await waitFor(() => h.docker.containers.get('poise-ws-alice')?.imageId === CURRENT_IMAGE_ID, 'the first pass')
      addWorkspaceContainer(h, 'carol', OLD_IMAGE_ID, false)
      h.store.noteWorkspace('carol', 'carol')
      await waitFor(() => h.docker.containers.get('poise-ws-carol')?.imageId === CURRENT_IMAGE_ID, 'a later pass')
    } finally {
      stop()
    }
  })
})

describe('updates in place', () => {
  let h: Harness
  const BASE = 'base-1'
  const start = async (options: { oldBase?: string | null; running?: boolean; release?: string | null } = {}) => {
    const { oldBase = BASE, running = true, release = 'old-release' } = options
    // A workspace that does not answer is drained until this timeout, then recreated.
    h = await startHarness({ env: { POISE_DRAIN_TIMEOUT: '1' } })
    await h.openWorkspace('Alice')
    h.store.noteWorkspace('alice', 'Alice')
    h.docker.imageLabels.set(CURRENT_IMAGE_ID, { 'poise.release': 'new-release', 'poise.base': BASE })
    if (oldBase !== null) h.docker.imageLabels.set(OLD_IMAGE_ID, { 'poise.release': 'old-release', 'poise.base': oldBase })
    addWorkspaceContainer(h, 'alice', OLD_IMAGE_ID, running)
    h.workspace.health.release = release
  }
  const containerId = () => h.docker.containers.get('poise-ws-alice')?.id
  afterEach(async () => {
    await h.close()
  })

  it('installs a new release of the same base into a running workspace and asks Poise to switch, keeping its container', async () => {
    await start()
    const before = containerId()
    await h.orchestrator.upgradePass()

    expect(h.docker.tasks).toHaveLength(1)
    expect(h.docker.tasks[0]).toMatchObject({
      name: 'poise-release-alice',
      spec: {
        Image: 'poise-runtime:latest',
        User: '10001',
        Entrypoint: ['/opt/poise-runtime/install-release.sh'],
        Cmd: [],
        Labels: { 'poise.task': 'install-release', 'poise.workspace': 'alice' },
        HostConfig: { NetworkMode: 'none', CapDrop: ['ALL'], Mounts: [{ Type: 'volume', Source: 'poise-home-alice', Target: '/home/poise' }] },
      },
    })
    expect(h.docker.containers.has('poise-release-alice')).toBe(false)
    expect(h.workspace.switches).toEqual(['new-release'])
    expect(containerId()).toBe(before)
    expect(h.workspace.serviceRequests.some((request) => request.url === '/api/service/drain')).toBe(false)
    expect(h.orchestrator.updatingTo('alice')).toBe('new-release')
    expect(h.logs.find((entry) => entry.event === 'workspace.update.requested')).toMatchObject({ handle: 'alice', release: 'new-release', from: 'old-release' })

    // Asked again until it runs the release, but installed only once.
    await h.orchestrator.upgradePass()
    expect(h.docker.tasks).toHaveLength(1)
    expect(h.workspace.switches).toEqual(['new-release', 'new-release'])

    // Poise restarted on the new release.
    h.workspace.health.release = 'new-release'
    h.orchestrator.markNotReady('alice')
    expect(await h.orchestrator.readiness('alice', 'Alice')).toEqual({ ready: true })
    expect(h.orchestrator.updatingTo('alice')).toBeNull()
    expect(events(h.logs, 'workspace.update')).toEqual(['workspace.update.requested', 'workspace.update.finished'])
    await h.orchestrator.upgradePass()
    expect(h.workspace.switches).toHaveLength(2)
    expect(containerId()).toBe(before)
  })

  it('says Poise is updating while the workspace restarts onto the new release', async () => {
    await start()
    const { workspaceCookie } = await h.openWorkspace('Alice')
    await h.orchestrator.upgradePass()
    h.workspace.reachable = false
    h.orchestrator.markNotReady('alice')

    const page = await h.request({ host: ALICE, path: '/', headers: { cookie: workspaceCookie, ...NAVIGATE } })
    expect(page.status).toBe(503)
    expect(page.headers['x-poise-updating']).toBe('1')
    expect(page.body).toContain('Updating to the latest version')
    const call = await h.request({ host: ALICE, path: '/api/workspace', headers: { cookie: workspaceCookie } })
    expect(call.status).toBe(503)
    expect(call.headers['x-poise-updating']).toBe('1')
    expect(call.json()).toMatchObject({ error: 'workspace_updating' })
  })

  it('recreates the container when the new image has another base, its release made current first', async () => {
    await start({ oldBase: 'base-0' })
    const before = containerId()
    await h.orchestrator.upgradePass()
    expect(h.workspace.switches).toEqual([])
    expect(h.docker.tasks.map((task) => (task.spec as { Cmd: string[] }).Cmd)).toEqual([['--activate']])
    const calls = dockerCalls(h)
    expect(calls.indexOf('POST /containers/poise-release-alice/wait')).toBeLessThan(calls.indexOf('POST /containers/poise-ws-alice/stop'))
    expect(containerId()).not.toBe(before)
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: CURRENT_IMAGE_ID, running: true })
  })

  it('drains again when activation restarts Poise, and stops the container only once it is idle again', async () => {
    await start({ oldBase: 'base-0' })
    h.docker.onTask = () => {
      // A switch queued before the drain restarts Poise while the release activates; the new Poise takes a call.
      h.workspace.health.runningCallerCalls = 1
      setTimeout(() => { h.workspace.health.runningCallerCalls = 0 }, 60)
      h.docker.onTask = undefined
    }
    await h.orchestrator.upgradePass()
    const calls = h.workspace.serviceRequests.map((request) => `${request.method} ${request.url}`)
    expect(calls.filter((call) => call === 'POST /api/service/drain').length).toBeGreaterThanOrEqual(3)
    expect(events(h.logs, 'workspace.drain')).toEqual(['workspace.drain.requested', 'workspace.drain.requested', 'workspace.drain.idle'])
    // Activated again once idle, and only then stopped.
    expect(h.docker.tasks.map((task) => (task.spec as { Cmd: string[] }).Cmd)).toEqual([['--activate'], ['--activate']])
    const docker = dockerCalls(h)
    expect(docker.lastIndexOf('POST /containers/poise-release-alice/wait')).toBeLessThan(docker.indexOf('POST /containers/poise-ws-alice/stop'))
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: CURRENT_IMAGE_ID, running: true })
  })

  it('recreates a workspace whose image names no release, or that runs without the supervisor', async () => {
    await start({ oldBase: null })
    await h.orchestrator.upgradePass()
    expect(h.workspace.switches).toEqual([])
    expect(h.docker.containers.get('poise-ws-alice')?.imageId).toBe(CURRENT_IMAGE_ID)
    await h.close()

    await start({ release: null })
    await h.orchestrator.upgradePass()
    expect(h.workspace.switches).toEqual([])
    expect(h.docker.containers.get('poise-ws-alice')?.imageId).toBe(CURRENT_IMAGE_ID)
  })

  it('leaves the workspace on its release when installing the new one fails, and tries again', async () => {
    await start()
    h.docker.taskExitCode = 1
    await h.orchestrator.upgradePass()
    expect(h.workspace.switches).toEqual([])
    expect(h.logs.find((entry) => entry.event === 'workspace.upgrade.failed')).toMatchObject({ handle: 'alice', error: expect.stringContaining('exited with 1') })
    expect(h.docker.containers.has('poise-release-alice')).toBe(false)
    h.docker.taskExitCode = 0
    await h.orchestrator.upgradePass()
    expect(h.workspace.switches).toEqual(['new-release'])
  })

  it('stops asking for a release that failed to start in the workspace, which stays on its own', async () => {
    await start()
    h.workspace.failedReleases.push('new-release')
    await h.orchestrator.upgradePass()
    await h.orchestrator.upgradePass()
    expect(h.workspace.switches).toEqual(['new-release'])
    expect(h.orchestrator.updatingTo('alice')).toBeNull()
    expect(h.logs.find((entry) => entry.event === 'workspace.update.refused')).toMatchObject({ handle: 'alice', release: 'new-release', running: 'old-release' })
    expect(h.store.getWorkspace('alice')?.lastError).toContain('failed to start')
  })

  it('recreates a workspace of the same base whose container settings changed', async () => {
    await start()
    const before = containerId()
    h.docker.containers.get('poise-ws-alice')!.spec = { ...h.docker.containers.get('poise-ws-alice')!.spec, Env: ['POISE_DRAIN_TIMEOUT=60'] }
    await h.orchestrator.upgradePass()
    expect(h.workspace.switches).toEqual([])
    expect(containerId()).not.toBe(before)
    expect(containerEnv(h, 'alice')).toContain(`POISE_DRAIN_TIMEOUT=${h.config.drainTimeoutSeconds}`)
  })

  it('switches a workspace on the current image that still runs an older release', async () => {
    await start()
    const alice = h.docker.containers.get('poise-ws-alice')!
    alice.imageId = CURRENT_IMAGE_ID
    await h.orchestrator.upgradePass()
    expect(h.docker.tasks).toHaveLength(1)
    expect(h.workspace.switches).toEqual(['new-release'])
    h.workspace.health.release = 'new-release'
    await h.orchestrator.upgradePass()
    expect(h.workspace.switches).toHaveLength(1)
  })

  it('waits for a workspace restarting onto the release it was asked for, and recreates one that stays unreachable', async () => {
    await start()
    const before = containerId()
    await h.orchestrator.upgradePass()
    h.workspace.reachable = false
    h.orchestrator.markNotReady('alice')
    await h.orchestrator.upgradePass()
    expect(containerId()).toBe(before)
    h.advance(11 * 60_000)
    await h.orchestrator.upgradePass()
    expect(containerId()).not.toBe(before)
    expect(h.logs.find((entry) => entry.event === 'workspace.update.unreachable')).toMatchObject({ handle: 'alice' })
  })

  it('recreates a stopped workspace on the new image, with the new release current', async () => {
    await start({ running: false })
    await h.orchestrator.upgradePass()
    expect(h.docker.tasks.map((task) => (task.spec as { Cmd: string[] }).Cmd)).toEqual([['--activate']])
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: CURRENT_IMAGE_ID, running: false })
  })
})

describe('a recreated gateway container', () => {
  let h: Harness
  // The workspace answers only over a network the gateway's container is on, as on a Docker host, and
  // a recreated gateway container is on none of the networks of the workspaces that kept running.
  const start = async (env: Record<string, string> = {}, drainPollMs?: number): Promise<string> => {
    h = await startHarness({ env, requireNetwork: true, drainPollMs })
    const { workspaceCookie } = await h.openWorkspace('Alice')
    h.store.noteWorkspace('alice', 'Alice')
    return workspaceCookie
  }
  const cannotJoin = 'the gateway could not join poise-net-alice: the gateway container poise-gateway (POISE_GATEWAY_CONTAINER) does not exist'
  afterEach(async () => {
    await h.close()
  })

  it('joins the network of every workspace when it starts, running or stopped', async () => {
    await start()
    addWorkspaceContainer(h, 'alice', CURRENT_IMAGE_ID, true, { gatewayJoined: false })
    addWorkspaceContainer(h, 'bob', CURRENT_IMAGE_ID, false, { gatewayJoined: false })
    addWorkspaceContainer(h, 'carol', CURRENT_IMAGE_ID, true)
    await h.orchestrator.joinWorkspaceNetworks()
    expect(gatewayNetworks(h)).toEqual(['bridge', 'poise-net-carol', 'poise-net-alice', 'poise-net-bob'])
    expect(dockerCalls(h)).toEqual([
      'GET /containers/json',
      'GET /networks/poise-net-alice',
      'GET /containers/poise-gateway/json',
      'POST /networks/poise-net-alice/connect',
      'GET /networks/poise-net-bob',
      'GET /containers/poise-gateway/json',
      'POST /networks/poise-net-bob/connect',
      'GET /networks/poise-net-carol',
      'GET /containers/poise-gateway/json',
    ])
    expect(h.logs.filter((entry) => entry.event === 'workspace.network.connected')).toEqual([
      expect.objectContaining({ handle: 'alice', network: 'poise-net-alice', container: 'poise-gateway' }),
      expect.objectContaining({ handle: 'bob', network: 'poise-net-bob', container: 'poise-gateway' }),
    ])
  })

  it('logs a workspace it cannot join when it starts, and joins the others', async () => {
    await start()
    h.docker.addContainer({
      name: 'stray', imageId: CURRENT_IMAGE_ID, imageRef: 'poise-runtime:latest', running: true,
      labels: { 'poise.managed': 'true' }, networks: new Set(), spec: {},
    })
    addWorkspaceContainer(h, 'alice', CURRENT_IMAGE_ID, true, { gatewayJoined: false })
    await h.orchestrator.joinWorkspaceNetworks()
    expect(h.logs.filter((entry) => entry.event === 'workspace.network.join.failed')).toEqual([
      expect.objectContaining({ level: 'error', container: '/stray', error: 'it has no poise.workspace label' }),
    ])
    expect(gatewayNetworks(h)).toContain('poise-net-alice')
  })

  it('logs it when it cannot list the workspaces as it starts, and starts all the same', async () => {
    await start()
    await h.docker.close()
    await h.orchestrator.joinWorkspaceNetworks()
    expect(h.logs.find((entry) => entry.event === 'workspace.network.join.failed'))
      .toMatchObject({ level: 'error', error: expect.stringContaining('Docker Engine GET /containers/json') })
  })

  it('drains a running workspace over the network it joined at start, then recreates it on the new image', async () => {
    await start({ POISE_DRAIN_TIMEOUT: '2' })
    addWorkspaceContainer(h, 'alice', OLD_IMAGE_ID, true, { gatewayJoined: false })
    h.workspace.health.activeChatTurns = 1
    setTimeout(() => {
      h.workspace.health.activeChatTurns = 0
    }, 60)
    await h.orchestrator.joinWorkspaceNetworks()
    await h.orchestrator.upgradePass()
    expect(h.workspace.serviceRequests[0]).toMatchObject({ method: 'POST', url: '/api/service/drain' })
    expect(events(h.logs, 'workspace.')).toEqual([
      'workspace.network.connected',
      'workspace.upgrade.started',
      'workspace.drain.requested',
      'workspace.drain.idle',
      'workspace.container.stopped',
      'workspace.container.removed',
      'workspace.container.created',
      'workspace.container.started',
      'workspace.upgrade.finished',
    ])
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: CURRENT_IMAGE_ID, running: true })
  })

  it('joins the network before a drain when it is not on it yet', async () => {
    await start({ POISE_DRAIN_TIMEOUT: '2' })
    addWorkspaceContainer(h, 'alice', OLD_IMAGE_ID, true, { gatewayJoined: false })
    await h.orchestrator.upgradePass()
    expect(h.workspace.serviceRequests.map((request) => `${request.method} ${request.url}`)).toEqual(['POST /api/service/drain'])
    expect(events(h.logs, 'workspace.')).toEqual([
      'workspace.upgrade.started',
      'workspace.network.connected',
      'workspace.drain.requested',
      'workspace.container.stopped',
      'workspace.container.removed',
      'workspace.container.created',
      'workspace.container.started',
      'workspace.upgrade.finished',
    ])
  })

  it('joins the network before a proxied request, so a running workspace answers at once', async () => {
    const cookie = await start()
    addWorkspaceContainer(h, 'alice', CURRENT_IMAGE_ID, true, { gatewayJoined: false })
    const page = await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })
    expect(page.status).toBe(200)
    expect(h.workspace.requests.map((request) => request.url)).toEqual(['/'])
    expect(dockerCalls(h)).toEqual([
      'GET /networks/poise-net-alice',
      'GET /containers/poise-gateway/json',
      'POST /networks/poise-net-alice/connect',
    ])
  })

  it('joins the network once when requests arrive together', async () => {
    const cookie = await start()
    addWorkspaceContainer(h, 'alice', CURRENT_IMAGE_ID, true, { gatewayJoined: false })
    const pages = await Promise.all([1, 2, 3, 4].map(() => h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })))
    expect(pages.map((page) => page.status)).toEqual([200, 200, 200, 200])
    expect(events(h.logs, 'workspace.network.connected')).toHaveLength(1)
    expect(events(h.logs, 'workspace.network.join.failed')).toEqual([])
  })

  it('joins the network again when a drain finds it gone', async () => {
    await start({ POISE_DRAIN_TIMEOUT: '5' })
    addWorkspaceContainer(h, 'alice', OLD_IMAGE_ID, true)
    h.workspace.health.activeChatTurns = 1
    const pass = h.orchestrator.upgradePass()
    await waitFor(() => h.workspace.serviceRequests.length > 0, 'the drain request')
    h.docker.containers.get('poise-gateway')?.networks.delete('poise-net-alice')
    await waitFor(() => events(h.logs, 'workspace.network.connected').length > 0, 'the gateway to join again')
    h.workspace.health.activeChatTurns = 0
    await pass
    expect(events(h.logs, 'workspace.')).toEqual([
      'workspace.upgrade.started',
      'workspace.drain.requested',
      'workspace.drain.health.failed',
      'workspace.network.connected',
      'workspace.drain.idle',
      'workspace.container.stopped',
      'workspace.container.removed',
      'workspace.container.created',
      'workspace.container.started',
      'workspace.upgrade.finished',
    ])
  })

  it('joins a network a drain found gone before the next proxied request, too', async () => {
    // The drain looks again only after a second, so the proxied request comes first.
    const cookie = await start({ POISE_DRAIN_TIMEOUT: '5' }, 1000)
    addWorkspaceContainer(h, 'alice', OLD_IMAGE_ID, true)
    expect((await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })).status).toBe(200)
    h.docker.containers.get('poise-gateway')?.networks.delete('poise-net-alice')
    const pass = h.orchestrator.upgradePass()
    await waitFor(() => events(h.logs, 'workspace.drain.request.failed').length > 0, 'the drain to reach nothing')
    const page = await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })
    expect(page.status).toBe(200)
    expect(events(h.logs, 'workspace.network.connected')).toHaveLength(1)
    await pass
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: CURRENT_IMAGE_ID, running: true })
  })

  it('fails the upgrade with the reason, and keeps the workspace running, when it cannot join the network', async () => {
    // Far longer than the test may run: waiting out the drain would fail it.
    await start({ POISE_DRAIN_TIMEOUT: '600' })
    addWorkspaceContainer(h, 'alice', OLD_IMAGE_ID, true, { gatewayJoined: false })
    h.docker.containers.delete('poise-gateway')
    await h.orchestrator.upgradePass()
    expect(h.logs.find((entry) => entry.event === 'workspace.upgrade.failed')).toMatchObject({ level: 'error', handle: 'alice', error: cannotJoin })
    expect(h.store.getWorkspace('alice')?.lastError).toBe(`upgrade failed: ${cannotJoin}`)
    expect(events(h.logs, 'workspace.drain')).toEqual([])
    expect(h.workspace.serviceRequests).toHaveLength(0)
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: OLD_IMAGE_ID, running: true })
  })

  it('shows on the starting page why it cannot reach the workspace', async () => {
    const cookie = await start()
    addWorkspaceContainer(h, 'alice', CURRENT_IMAGE_ID, true, { gatewayJoined: false })
    h.docker.containers.delete('poise-gateway')
    const page = await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })
    expect(page.status).toBe(503)
    expect(page.body).toContain(cannotJoin)
    expect(h.logs.find((entry) => entry.event === 'workspace.network.join.failed')).toMatchObject({ level: 'error', handle: 'alice', error: cannotJoin })
    await h.orchestrator.startInProgress('alice')
  })
})
