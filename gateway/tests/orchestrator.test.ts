import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import {
  CURRENT_IMAGE_ID, events, OLD_IMAGE_ID, startHarness, verifyAssertion, workspaceHost,
  type Harness, type HarnessOptions,
} from './harness.js'

const ALICE = workspaceHost('alice')
const NAVIGATE = { 'sec-fetch-mode': 'navigate', accept: 'text/html' }

function dockerCalls(h: Harness): string[] {
  return h.docker.calls.map((call) => `${call.method} ${call.path.split('?')[0]}`)
}

interface WorkspaceContainerOptions {
  /** Whether the gateway's container is on the workspace's network; a recreated one is on none. */
  gatewayJoined?: boolean
}

function addWorkspaceContainer(h: Harness, handle: string, imageId: string, running: boolean, options: WorkspaceContainerOptions = {}): void {
  const { gatewayJoined = true } = options
  h.docker.volumes.add(`poise-home-${handle}`)
  h.docker.networks.add(`poise-net-${handle}`)
  if (gatewayJoined) h.docker.containers.get('poise-gateway')?.networks.add(`poise-net-${handle}`)
  h.docker.addContainer({
    name: `poise-ws-${handle}`,
    imageId,
    imageRef: 'poise-runtime:latest',
    running,
    labels: { 'poise.managed': 'true', 'poise.workspace': handle },
    networks: new Set([`poise-net-${handle}`]),
    spec: {},
  })
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
    const cookie = await start({ env: { POISE_WORKSPACE_MEMORY: '2g', POISE_WORKSPACE_CPUS: '1.5', POISE_WORKSPACE_PIDS: '512', POISE_WORKSPACE_RUNTIME: 'runsc' } })
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

  it('recreates a stopped container on an outdated image before starting it', async () => {
    const cookie = await start()
    addWorkspaceContainer(h, 'alice', OLD_IMAGE_ID, false)
    await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })
    await h.orchestrator.startInProgress('alice')
    expect(dockerCalls(h).slice(5)).toEqual([
      'GET /containers/poise-ws-alice/json',
      'GET /images/poise-runtime:latest/json',
      'DELETE /containers/poise-ws-alice',
      'POST /containers/create',
      'POST /containers/poise-ws-alice/start',
    ])
    expect(h.logs.find((entry) => entry.event === 'workspace.container.removed')).toMatchObject({ handle: 'alice', reason: 'outdated image' })
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: CURRENT_IMAGE_ID, running: true })
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
    expect(h.workspace.serviceRequests.slice(1).every((request) => request.url === '/api/service/health')).toBe(true)
    expect(h.workspace.serviceRequests.length).toBeGreaterThan(1)

    expect(dockerCalls(h)).toEqual([
      'GET /images/poise-runtime:latest/json',
      'GET /containers/json',
      'GET /containers/poise-ws-alice/json',
      // Before the first call to the workspace, the gateway makes sure it is on its network.
      'GET /networks/poise-net-alice',
      'GET /containers/poise-gateway/json',
      'GET /containers/poise-ws-alice/json',
      'POST /containers/poise-ws-alice/stop',
      'DELETE /containers/poise-ws-alice',
      'POST /containers/create',
      'POST /containers/poise-ws-alice/start',
    ])
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
