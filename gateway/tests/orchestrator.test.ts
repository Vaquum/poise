import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { gatewayDiagnostic } from '../src/diagnostics/collectors.js'
import { normalize } from '../src/diagnostics/contract.js'
import { DiagnosticStore } from '../src/diagnostics/store.js'
import {
  CURRENT_IMAGE_ID, events, GATEWAY_DATA_SOURCE, OLD_IMAGE_ID, startHarness, verifyAssertion, workspaceHost,
  type Harness, type HarnessOptions,
} from './harness.js'
import { IDLE_TO_READY_MS, MAX_SERVICE_ANSWER_BYTES } from '../src/orchestrator.js'

const ALICE = workspaceHost('alice')
const NAVIGATE = { 'sec-fetch-mode': 'navigate', accept: 'text/html' }
const BEHAVIOR_LIMITS = {
  POISE_BEHAVIOR_MEMORY_BUDGET_BYTES: '6442450944',
  POISE_BEHAVIOR_MEMORY_RESERVATION_BYTES: '2147483648',
  POISE_BEHAVIOR_DISK_BUDGET_BYTES: '1610612736',
  POISE_BEHAVIOR_DISK_RESERVATION_BYTES: '536870912',
}

function dockerCalls(h: Harness): string[] {
  return h.docker.calls.map((call) => `${call.method} ${call.path.split('?')[0]}`)
}

function retainedUpgradeFailure(h: Harness) {
  const failure = h.logs.find(entry => entry.event === 'workspace.upgrade.failed')
  expect(failure).toMatchObject({ level: 'error', handle: 'alice' })
  const db = new DiagnosticStore(':memory:')
  try {
    db.append([normalize(gatewayDiagnostic('error', String(failure!.event), failure!))!])
    return db.query({ workspace: 'alice', operator: false }).events[0]!
  } finally { db.close() }
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
    labels: { ...h.docker.imageLabels.get(imageId), 'poise.managed': 'true', 'poise.workspace': handle, ...(dns ? { 'poise.dns': dns.label } : {}) },
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

  it('passes the configured native behavior budgets into the actual container specification', async () => {
    const cookie = await start({ env: BEHAVIOR_LIMITS })
    await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })
    await h.orchestrator.startInProgress('alice')
    expect(containerEnv(h, 'alice')).toEqual(expect.arrayContaining(
      Object.entries(BEHAVIOR_LIMITS).map(([key, value]) => `${key}=${value}`)))
  })

  it.each(['', 'acme/one,acme/two'])('passes only an explicit repair report allowlist to a new workspace (%s)', async repositories => {
    const cookie = await start({ env: { POISE_REPAIR_EXHAUSTION_REPOSITORIES: repositories } })
    await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })
    await h.orchestrator.startInProgress('alice')
    expect(containerEnv(h, 'alice').filter(value => value.startsWith('POISE_REPAIR_EXHAUSTION_REPOSITORIES=')))
      .toEqual(repositories ? [`POISE_REPAIR_EXHAUSTION_REPOSITORIES=${repositories}`] : [])
  })

  it.each(['added', 'changed', 'removed'])('recreates a stopped workspace when native behavior budgets are %s', async change => {
    const desired = change === 'removed' ? {} : BEHAVIOR_LIMITS
    const cookie = await start({ env: desired })
    const previous = change === 'added' ? [] : Object.entries(BEHAVIOR_LIMITS)
      .map(([key, value]) => `${key}=${change === 'changed' && key === 'POISE_BEHAVIOR_MEMORY_RESERVATION_BYTES' ? '1073741824' : value}`)
    addWorkspaceContainer(h, 'alice', CURRENT_IMAGE_ID, false, {
      env: [`POISE_DRAIN_TIMEOUT=${h.config.drainTimeoutSeconds}`, ...previous],
    })
    await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })
    await h.orchestrator.startInProgress('alice')
    expect(h.logs.find(entry => entry.event === 'workspace.container.removed'))
      .toMatchObject({ handle: 'alice', reason: 'changed native behavior resource budgets' })
    const actual = containerEnv(h, 'alice').filter(value => value.startsWith('POISE_BEHAVIOR_'))
    expect(actual.sort()).toEqual(Object.entries(desired).map(([key, value]) => `${key}=${value}`).sort())
  })

  it('installs the test offload ahead of a first workspace, which installs no release', async () => {
    const cookie = await start({ env: { POISE_TEST_RENDER_API_KEY: 'render-key', POISE_TEST_WORKSPACE: 'tea-x' } })
    await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })
    await h.orchestrator.startInProgress('alice')
    expect(h.docker.tasks.map((task) => task.name)).toEqual(['poise-test-offload-alice'])
    expect((h.docker.tasks[0].spec as { Env: string[] }).Env).toContainEqual(expect.stringMatching(/^POISE_TEST_RELAY_KEY=alice\./))
    expect(h.docker.containers.has('poise-ws-alice')).toBe(true)
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
        'POISE_WORKSPACE_OWNER_ID=1001',
        `POISE_PUBLIC_ORIGIN=https://${ALICE}`,
        `POISE_GATEWAY_PUBLIC_KEY=${h.keys.publicKeyBase64}`,
        'POISE_RELEASE_REPO=autonomio/poise',
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
        LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '5' } },
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
      'POISE_WORKSPACE_OWNER_ID=1001',
      `POISE_PUBLIC_ORIGIN=https://${ALICE}`,
      `POISE_GATEWAY_PUBLIC_KEY=${h.keys.publicKeyBase64}`,
      'POISE_RELEASE_REPO=autonomio/poise',
      'POISE_HOST=0.0.0.0',
      'POISE_PORT=5555',
      'HOME=/home/poise',
      'POISE_DRAIN_TIMEOUT=5400',
      'POISE_SKIP_CLI_BOOTSTRAP=1',
    ])
  })

  it('hands workspaces the fork POISE_RELEASE_REPO names', async () => {
    const cookie = await start({ env: { POISE_RELEASE_REPO: 'fork/poise' } })
    await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })
    await h.orchestrator.startInProgress('alice')
    const create = h.docker.calls.find((call) => call.path.startsWith('/containers/create'))
    expect((create?.body as { Env: string[] }).Env).toContain('POISE_RELEASE_REPO=fork/poise')
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
  const stop500 = { status: 500, body: { message: 'cannot stop container: container PID 123 is zombie and can not be killed' } }
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
    const upgrade = h.orchestrator.upgradePass()
    await waitFor(() => h.workspace.serviceRequests.filter(request => request.url === '/api/service/health').length >= 2,
      'a busy workspace health poll after the drain')
    expect(h.docker.containers.get('poise-ws-alice')?.id).toBe(aliceId)
    expect(h.docker.containers.get('poise-ws-alice')?.running).toBe(true)
    h.workspace.health.activeChatTurns = 0
    h.workspace.health.runningCallerCalls = 0
    await upgrade

    const drain = h.workspace.serviceRequests[1]
    expect(drain.method).toBe('POST')
    expect(drain.url).toBe('/api/service/drain')
    expect(drain.headers.host).toBe(ALICE)
    expect(verifyAssertion(String(drain.headers['x-poise-identity']), h.keys.publicKeyBase64))
      .toMatchObject({ aud: 'workspace:alice', sub: 'Alice', scope: 'admin' })
    // Health while it waits, then the drain again just before the container stops,
    // then one health check that the replacement answers before the upgrade finishes.
    expect(h.workspace.serviceRequests.slice(2, -2).every((request) => request.url === '/api/service/health')).toBe(true)
    expect(h.workspace.serviceRequests.at(-2)).toMatchObject({ method: 'POST', url: '/api/service/drain' })
    expect(h.workspace.serviceRequests.at(-1)).toMatchObject({ method: 'GET', url: '/api/service/health' })
    expect(h.workspace.serviceRequests.length).toBeGreaterThan(3)

    expect(dockerCalls(h)).toEqual([
      'GET /images/poise-runtime:latest/json',
      // The release it carries, if it names one; this image does not, so every update needs a new container.
      'GET /images/poise-runtime:latest/json',
      'GET /containers/json',
      `GET /containers/${aliceId}/json`,
      // Before the first call to the workspace, the gateway makes sure it is on its network.
      'GET /networks/poise-net-alice',
      'GET /containers/poise-gateway/json',
      'GET /containers/poise-ws-alice/json',
      'GET /containers/poise-ws-alice/json',
      `POST /containers/${aliceId}/stop`,
      `DELETE /containers/${aliceId}`,
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

  it('reconciles a stop 500 only after the exact owned container is positively stopped', async () => {
    await start()
    const old = h.docker.containers.get('poise-ws-alice')!
    h.docker.onCall = call => {
      if (call.method === 'POST' && call.path.endsWith('/stop')) {
        old.running = false
        return stop500
      }
      return undefined
    }
    await h.orchestrator.upgradePass()
    expect(dockerCalls(h).filter(call => call.endsWith('/stop'))).toEqual([`POST /containers/${old.id}/stop`])
    expect(dockerCalls(h)).toContain(`DELETE /containers/${old.id}`)
    expect(dockerCalls(h)).not.toContain('DELETE /containers/poise-ws-alice')
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: CURRENT_IMAGE_ID, running: true })
    expect(h.docker.containers.get('poise-ws-alice')?.id).not.toBe(old.id)
    expect(h.docker.volumes.has('poise-home-alice')).toBe(true)
    expect(h.docker.containers.get('poise-ws-alice')?.spec.HostConfig).toMatchObject({
      Mounts: [{ Type: 'volume', Source: 'poise-home-alice', Target: '/home/poise' }],
    })
    expect(events(h.logs, 'workspace.upgrade.stop.reconciled')).toHaveLength(1)
    expect(events(h.logs, 'workspace.upgrade.finished')).toHaveLength(1)
    expect(events(h.logs, 'workspace.upgrade.failed')).toHaveLength(0)
    expect(h.workspace.serviceRequests.some(request => request.url === '/api/service/resume')).toBe(false)
  })

  it.each([
    ['running', 'status=running, running=true'],
    ['absent', 'absent (Docker 404)'],
    ['old inspection failure', 'inspection failed: Docker Engine GET'],
    ['name inspection failure', 'inspection failed: Docker Engine GET'],
    ['malformed old state', 'status=unknown, running=false'],
    ['malformed name state', 'status=unknown, running=false'],
    ['ownership lost', 'owned=false'],
  ])('retains the stop 500 and safe inspection evidence for %s', async (state, evidence) => {
    await start()
    const old = h.docker.containers.get('poise-ws-alice')!
    old.spec.Env = [...(old.spec.Env as string[]), 'PRIVATE_INSPECTION=never-retain-this-value']
    let stopped = false
    h.docker.onCall = call => {
      if (call.method === 'POST' && call.path.endsWith('/stop')) {
        stopped = true
        old.running = state === 'running'
        if (state === 'absent') h.docker.containers.delete(old.name)
        if (state === 'ownership lost') old.labels['poise.workspace'] = 'bob'
        return stop500
      }
      if (stopped && call.method === 'GET') {
        const reference = state.includes('old') ? old.id : old.name
        if (call.path === `/containers/${reference}/json`) {
          if (state.includes('inspection failure')) return { status: 500, body: { message: 'inspection unavailable' } }
          if (state.startsWith('malformed')) return { status: 200,
            body: { Id: old.id, Config: { Labels: old.labels }, State: { Running: false } } }
        }
      }
      return undefined
    }
    await h.orchestrator.upgradePass()
    expect(dockerCalls(h).filter(call => call.endsWith('/stop'))).toEqual([`POST /containers/${old.id}/stop`])
    expect(dockerCalls(h).filter(call => call.startsWith('DELETE /containers/'))).toEqual([])
    expect(h.docker.containers.get(old.name)?.id).toBe(state === 'absent' ? undefined : old.id)
    expect(h.docker.volumes.has('poise-home-alice')).toBe(true)
    expect(events(h.logs, 'workspace.upgrade.finished')).toHaveLength(0)
    const retained = retainedUpgradeFailure(h)
    expect(retained).toMatchObject({ severity: 'error', operation: 'workspace.upgrade.failed', context: { container: old.id } })
    expect(retained.message).toContain(`POST /containers/${old.id}/stop failed with HTTP 500: ${stop500.body.message}`)
    expect(retained.message).toContain('poise-ws-alice:')
    expect(retained.message).toContain(evidence)
    expect(JSON.stringify(retained)).not.toContain('never-retain-this-value')
    if (state.includes('inspection failure')) expect(retained.message).toContain('inspection unavailable')
    const resume = !['absent', 'ownership lost', 'name inspection failure'].includes(state)
    expect(h.workspace.serviceRequests.some(request => request.url === '/api/service/resume')).toBe(resume)
    expect(h.workspace.health.draining).toBe(!resume)
  })

  it.each(['stopped', 'absent', 'running', 'unreadable old', 'malformed current', 'wrong image', 'wrong settings', 'wrong owner', 'wrong release', 'unhealthy'])
    ('observes a successor without mutating it or releasing its drain (old/target: %s)', async state => {
      await start()
      h.docker.imageLabels.set(CURRENT_IMAGE_ID, { 'poise.release': 'target-release', 'poise.base': 'new-base' })
      const old = h.docker.containers.get('poise-ws-alice')!
      let successorId = ''
      h.docker.onCall = call => {
        if (call.method === 'POST' && call.path.endsWith('/stop')) {
          h.docker.containers.delete(old.name)
          old.name = 'retired-alice'
          old.running = state === 'running'
          if (state !== 'absent') h.docker.containers.set(old.name, old)
          addWorkspaceContainer(h, 'alice', state === 'wrong image' ? OLD_IMAGE_ID : CURRENT_IMAGE_ID, true)
          const successor = h.docker.containers.get('poise-ws-alice')!
          successorId = successor.id
          if (state === 'wrong settings') successor.spec.Env = ['POISE_DRAIN_TIMEOUT=1']
          if (state === 'wrong owner') successor.labels['poise.workspace'] = 'bob'
          h.workspace.health.release = state === 'wrong release' ? 'old-release' : 'target-release'
          h.workspace.health.ok = state !== 'unhealthy'
          return stop500
        }
        if (successorId && call.method === 'GET') {
          if (state === 'unreadable old' && call.path === `/containers/${old.id}/json`) {
            return { status: 500, body: { message: 'old inspection unavailable' } }
          }
          if (state === 'malformed current' && call.path === '/containers/poise-ws-alice/json') {
            return { status: 200, body: { Id: successorId, State: { Running: true }, Config: { Labels: old.labels } } }
          }
        }
        return undefined
      }
      await h.orchestrator.upgradePass()
      expect(dockerCalls(h).filter(call => call.endsWith('/stop'))).toEqual([`POST /containers/${old.id}/stop`])
      for (const reference of [old.id, 'poise-ws-alice', successorId]) {
        expect(dockerCalls(h)).not.toContain(`DELETE /containers/${reference}`)
      }
      expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ id: successorId, running: true })
      expect(h.docker.volumes.has('poise-home-alice')).toBe(true)
      expect(h.workspace.serviceRequests.some(request => request.url === '/api/service/resume')).toBe(false)
      expect(h.workspace.health.draining).toBe(true)
      expect(events(h.logs, 'workspace.upgrade.finished')).toHaveLength(0)
      if (state === 'stopped' || state === 'absent') {
        expect(h.logs.find(entry => entry.event === 'workspace.upgrade.skipped')).toMatchObject({
          container: successorId, release: 'target-release', reason: 'a replacement is already serving the intended image and settings',
        })
        expect(events(h.logs, 'workspace.upgrade.failed')).toHaveLength(0)
      } else {
        const retained = retainedUpgradeFailure(h)
        expect(retained.message).toContain(stop500.body.message)
        expect(retained.message).toContain(old.id)
        expect(retained.message).toContain(successorId)
        if (state === 'unreadable old') expect(retained.message).toContain('old inspection unavailable')
        if (state === 'wrong release' || state === 'unhealthy') expect(retained.message).toContain('has not confirmed the intended release target-release')
      }
    })

  it('keeps stop and removal pinned when the workspace name is reused just before Docker stops it', async () => {
    await start()
    const old = h.docker.containers.get('poise-ws-alice')!
    let successorId = ''
    h.docker.onCall = call => {
      if (call.method === 'POST' && call.path.endsWith('/stop')) {
        h.docker.containers.delete(old.name)
        old.name = 'retired-alice'
        h.docker.containers.set(old.name, old)
        addWorkspaceContainer(h, 'alice', CURRENT_IMAGE_ID, true)
        successorId = h.docker.containers.get('poise-ws-alice')!.id
      }
      return undefined
    }
    await h.orchestrator.upgradePass()
    expect(dockerCalls(h).filter(call => call.endsWith('/stop'))).toEqual([`POST /containers/${old.id}/stop`])
    expect(dockerCalls(h).filter(call => call.startsWith('DELETE /containers/'))).toEqual([`DELETE /containers/${old.id}`])
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ id: successorId, running: true })
    expect(h.workspace.serviceRequests.some(request => request.url === '/api/service/resume')).toBe(false)
  })

  it('leaves a successor drain alone when replacement is skipped after the first drain', async () => {
    await start()
    const oldId = h.docker.containers.get('poise-ws-alice')!.id
    h.workspace.onServiceRequest = request => {
      if (request.url === '/api/service/drain') addWorkspaceContainer(h, 'alice', CURRENT_IMAGE_ID, true)
    }
    await h.orchestrator.upgradePass()
    expect(h.docker.containers.get('poise-ws-alice')?.id).not.toBe(oldId)
    expect(h.docker.containers.get('poise-ws-alice')?.running).toBe(true)
    expect(dockerCalls(h).filter(call => call.endsWith('/stop') || call.startsWith('DELETE /containers/'))).toEqual([])
    expect(h.workspace.serviceRequests.some(request => request.url === '/api/service/resume')).toBe(false)
    expect(h.workspace.health.draining).toBe(true)
    expect(h.logs.find(entry => entry.event === 'workspace.upgrade.skipped')).toMatchObject({ reason: 'the drained container was replaced' })
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
    expect(h.logs.find((entry) => entry.event === 'workspace.drain.waiting')).toMatchObject({
      handle: 'alice',
      activeChatTurns: 1,
      runningCallerCalls: 0,
      backgroundWork: 0,
    })
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

  it.each([
    { pending: 1, background: 1, calls: 0 }, { pending: null, background: 1, calls: 0 },
    { pending: undefined, background: 1, calls: 0 }, { pending: 0, background: 1, calls: 0 },
    { pending: 0, background: 0, calls: 1 },
  ])('preserves the original container while native work or cleanup is pending: %j', async ({ pending, background, calls }) => {
    await start({ env: { POISE_DRAIN_TIMEOUT: '1' } })
    const before = h.docker.containers.get('poise-ws-alice')?.id
    h.workspace.health.backgroundWork = background
    h.workspace.health.runningCallerCalls = calls
    h.workspace.health.unsettledNativeCalls = pending
    await h.orchestrator.upgradePass()
    expect(h.docker.containers.get('poise-ws-alice')?.id).toBe(before)
    expect(dockerCalls(h)).not.toContainEqual(expect.stringMatching(/^POST \/containers\/[^/]+\/stop$/))
    expect(dockerCalls(h)).not.toContainEqual(expect.stringMatching(/^DELETE \/containers\/(?:poise-ws-alice|[a-f0-9]+)$/))
    expect(events(h.logs, 'workspace.upgrade.native-pending')).toHaveLength(1)
    expect(h.workspace.health.draining).toBe(false)
    // The same upgrade proceeds once the original owner confirms release and retires its claim.
    h.workspace.health.unsettledNativeCalls = 0
    h.workspace.health.backgroundWork = 0
    h.workspace.health.runningCallerCalls = 0
    await h.orchestrator.upgradePass()
    expect(h.docker.containers.get('poise-ws-alice')?.id).not.toBe(before)
  })

  it('keeps original native cleanup intact while applying behavior budget changes', async () => {
    await start({ env: { ...BEHAVIOR_LIMITS, POISE_DRAIN_TIMEOUT: '1' } })
    h.docker.containers.get('poise-ws-alice')!.imageId = CURRENT_IMAGE_ID
    const before = h.docker.containers.get('poise-ws-alice')?.id
    h.workspace.health.unsettledNativeCalls = 1
    h.workspace.health.backgroundWork = 1
    await h.orchestrator.upgradePass()
    expect(h.docker.containers.get('poise-ws-alice')?.id).toBe(before)
    expect(dockerCalls(h)).not.toContainEqual(expect.stringMatching(/^POST \/containers\/[^/]+\/stop$/))
    expect(h.logs.find(entry => entry.event === 'workspace.upgrade.native-pending' && entry.handle === 'alice')).toBeDefined()
    expect(h.workspace.health.draining).toBe(false)
    h.workspace.health.unsettledNativeCalls = 0
    h.workspace.health.backgroundWork = 0
    await h.orchestrator.upgradePass()
    expect(h.docker.containers.get('poise-ws-alice')?.id).not.toBe(before)
    expect(containerEnv(h, 'alice')).toEqual(expect.arrayContaining(
      Object.entries(BEHAVIOR_LIMITS).map(([key, value]) => `${key}=${value}`)))
  })

  it('keeps cooperative idle upgrades compatible with older health answers', async () => {
    await start()
    delete h.workspace.health.unsettledNativeCalls
    await h.orchestrator.upgradePass()
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: CURRENT_IMAGE_ID, running: true })
  })

  it.each([1, null])('promptly releases repeated drains for held native cleanup (%s), keeping Chat available', async (pending) => {
    await start({ env: { POISE_DRAIN_TIMEOUT: '7200' } })
    const before = h.docker.containers.get('poise-ws-alice')?.id
    h.workspace.health.unsettledNativeCalls = pending
    h.workspace.health.backgroundWork = 1
    h.workspace.health.activeChatTurns = 1
    for (let pass = 0; pass < 3; pass += 1) {
      await h.orchestrator.upgradePass()
      expect(h.workspace.health.draining).toBe(false)
      expect(h.docker.containers.get('poise-ws-alice')?.id).toBe(before)
    }
    expect(h.docker.tasks).toHaveLength(0)
    expect(events(h.logs, 'workspace.drain.timeout')).toHaveLength(0)
    expect(h.workspace.serviceRequests.filter(request => request.url === '/api/service/drain')).toHaveLength(3)
    expect(h.workspace.serviceRequests.filter(request => request.url === '/api/service/resume')).toHaveLength(3)
  }, 5000)

  it.each([
    { draining: false, resumeStatus: 200, resumeRequests: 0 },
    { draining: true, resumeStatus: 200, resumeRequests: 1 },
    { draining: true, resumeStatus: 503, resumeRequests: 2 },
  ])('skips a new drain for a reported cleanup hold (draining $draining, resume $resumeStatus)', async ({ draining, resumeStatus, resumeRequests }) => {
    await start()
    const before = h.docker.containers.get('poise-ws-alice')?.id
    const hold = { callId: 'a'.repeat(32), reason: 'Original native resource handle is unavailable' }
    Object.assign(h.workspace.health, { unsettledNativeCalls: 1, backgroundWork: 1, nativeCleanupHold: hold, draining })
    h.workspace.resumeStatus = resumeStatus
    await h.orchestrator.upgradePass()
    expect(h.workspace.health.draining).toBe(resumeStatus === 503)
    expect(h.logs.filter(entry => entry.event === 'workspace.upgrade.native-pending')).toEqual([
      expect.objectContaining({ callId: hold.callId, cleanupReason: hold.reason, unsettledNativeCalls: 1 }),
    ])

    // A new Caller launch does not change the original failed cleanup.
    h.workspace.resumeStatus = 200
    Object.assign(h.workspace.health, { unsettledNativeCalls: 2, backgroundWork: 2, runningCallerCalls: 1 })
    await h.orchestrator.upgradePass()
    expect(h.workspace.health.draining).toBe(false)
    expect(h.docker.containers.get('poise-ws-alice')?.id).toBe(before)
    expect(h.workspace.serviceRequests.filter(request => request.url === '/api/service/drain')).toHaveLength(0)
    expect(h.workspace.serviceRequests.filter(request => request.url === '/api/service/resume')).toHaveLength(resumeRequests)

    delete h.workspace.health.nativeCleanupHold
    Object.assign(h.workspace.health, { unsettledNativeCalls: 0, backgroundWork: 0, runningCallerCalls: 0 })
    await h.orchestrator.upgradePass()
    expect(h.docker.containers.get('poise-ws-alice')?.id).not.toBe(before)
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: CURRENT_IMAGE_ID, running: true })
  })

  it('releases an admitted drain when Caller records a terminal cleanup failure', async () => {
    await start()
    const hold = { callId: 'a'.repeat(32), reason: 'Original native resource handle is unavailable' }
    h.workspace.onServiceRequest = ({ url }) => {
      if (url !== '/api/service/drain') return
      Object.assign(h.workspace.health, { unsettledNativeCalls: 2, backgroundWork: 2, runningCallerCalls: 1, nativeCleanupHold: hold })
    }
    await h.orchestrator.upgradePass()
    expect(h.workspace.health.draining).toBe(false)
    expect(events(h.logs, 'workspace.drain.released')).toHaveLength(1)
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: OLD_IMAGE_ID, running: true })
  })

  it.each([false, true])('replaces with retained cleanup only after live work ends (Chat reaches deadline: %s)', async (chatWaits) => {
    await start({ env: { POISE_DRAIN_TIMEOUT: '1' } })
    const before = h.docker.containers.get('poise-ws-alice')?.id
    const hold = { callId: 'a'.repeat(32), reason: 'Original native resource handle is unavailable', retainedCalls: 1 }
    Object.assign(h.workspace.health, { activeChatTurns: Number(chatWaits), unsettledNativeCalls: 2,
      backgroundWork: 2, runningCallerCalls: 1, nativeCleanupHold: hold })
    const upgrade = h.orchestrator.upgradePass()
    await waitFor(() => h.workspace.health.draining || events(h.logs, 'workspace.upgrade.native-pending').length > 0, 'a replacement decision')
    expect(h.workspace.health.draining).toBe(true)
    expect(h.docker.containers.get('poise-ws-alice')?.id).toBe(before)
    Object.assign(h.workspace.health, { unsettledNativeCalls: 1, backgroundWork: 1, runningCallerCalls: 0 })
    await upgrade

    if (chatWaits) {
      expect(h.docker.containers.get('poise-ws-alice')?.id).toBe(before)
      expect(h.workspace.health.draining).toBe(false)
      expect(events(h.logs, 'workspace.drain.timeout')).toHaveLength(1)
      expect(events(h.logs, 'workspace.upgrade.aborted')).toHaveLength(1)
      expect(events(h.logs, 'workspace.upgrade.cleanup-retained')).toHaveLength(0)
      h.workspace.health.activeChatTurns = 0
      await h.orchestrator.upgradePass()
    }
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: CURRENT_IMAGE_ID, running: true })
    expect(h.workspace.health.nativeCleanupHold).toEqual(hold)
    expect(h.logs.find(entry => entry.event === 'workspace.upgrade.cleanup-retained')).toMatchObject({
      callId: hold.callId, retainedCalls: 1,
    })
  })

  it('notices a drain lifted while it waits instead of silently draining again', async () => {
    await start({ drainRenewMs: 200 })
    h.workspace.health.runningCallerCalls = 1
    const upgrade = h.orchestrator.upgradePass()
    await waitFor(() => h.workspace.health.draining, 'the drain request')
    // The owner lifts the drain mid-wait while Caller work still runs.
    h.workspace.health.draining = false
    await waitFor(() => events(h.logs, 'workspace.drain.lifted').length > 0, 'the lifted drain to be noticed')
    h.workspace.health.runningCallerCalls = 0
    await upgrade
    expect(h.workspace.health.draining).toBe(true)
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: CURRENT_IMAGE_ID, running: true })
  })

  it('tries to release the drain when the network fails after a drain took effect', async () => {
    await start({ env: { POISE_DRAIN_TIMEOUT: '30' } })
    h.workspace.health.runningCallerCalls = 1
    const upgrade = h.orchestrator.upgradePass()
    await waitFor(() => h.workspace.health.draining, 'the drain request')
    expect(h.workspace.health.draining).toBe(true)
    // A poll reaches nothing, so the gateway looks at its network again; by then it cannot join it.
    h.workspace.reachable = false
    await waitFor(() => events(h.logs, 'workspace.drain.health.failed').length > 0, 'a failed poll')
    h.docker.containers.delete('poise-gateway')
    await upgrade
    expect(h.logs.find((entry) => entry.event === 'workspace.drain.release.failed')).toMatchObject({ handle: 'alice' })
    expect(h.logs.find((entry) => entry.event === 'workspace.upgrade.failed')).toMatchObject({ handle: 'alice' })
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: OLD_IMAGE_ID, running: true })
  })

  it('aborts a drain that only times out and releases it, instead of recreating the workspace', async () => {
    await start({ env: { POISE_DRAIN_TIMEOUT: '1' }, serviceTimeoutMs: 20 })
    const aliceId = h.docker.containers.get('poise-ws-alice')?.id
    // Every service answer arrives past the gateway timeout, as under load; the drain still takes effect.
    h.workspace.answerDelayMs = 200
    const began = Date.now()
    await h.orchestrator.upgradePass()
    expect(Date.now() - began).toBeLessThan(30_000)
    expect(h.workspace.serviceRequests.some((request) => request.url === '/api/service/drain')).toBe(true)
    expect(h.workspace.serviceRequests.some((request) => request.url === '/api/service/resume')).toBe(true)
    h.workspace.answerDelayMs = 0
    expect(h.workspace.health.draining).toBe(false)
    expect(h.docker.containers.get('poise-ws-alice')?.id).toBe(aliceId)
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: OLD_IMAGE_ID, running: true })
    expect(events(h.logs, 'workspace.upgrade.aborted')).toHaveLength(1)
  })

  it('leaves a workspace whose drain never admits alone, and upgrades it once it does', async () => {
    await start({ env: { POISE_DRAIN_TIMEOUT: '1' } })
    const aliceId = h.docker.containers.get('poise-ws-alice')?.id
    // The drain POST answers idle but never shows the drain on: admission refused, not confirmed.
    h.workspace.drainApplies = false
    await h.orchestrator.upgradePass()
    expect(h.docker.containers.get('poise-ws-alice')?.id).toBe(aliceId)
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: OLD_IMAGE_ID, running: true })
    expect(dockerCalls(h)).not.toContainEqual(expect.stringMatching(/^POST \/containers\/[^/]+\/stop$/))
    expect(events(h.logs, 'workspace.drain.unconfirmed').length).toBeGreaterThanOrEqual(1)
    expect(h.logs.find((entry) => entry.event === 'workspace.drain.unconfirmed')).toMatchObject({ handle: 'alice', draining: false })
    expect(events(h.logs, 'workspace.upgrade.aborted')).toHaveLength(1)
    expect(h.logs.find((entry) => entry.event === 'workspace.upgrade.aborted')).toMatchObject({ level: 'warn', handle: 'alice' })
    expect(h.workspace.serviceRequests.some((request) => request.url === '/api/service/resume')).toBe(true)
    // Every service call carried a fresh admin assertion, renewals and recovery included.
    for (const request of h.workspace.serviceRequests.filter((candidate) => candidate.headers.host === ALICE)) {
      expect(verifyAssertion(String(request.headers['x-poise-identity']), h.keys.publicKeyBase64))
        .toMatchObject({ aud: 'workspace:alice', sub: 'Alice', scope: 'admin' })
    }
    // The next pass admits the drain and upgrades.
    h.workspace.drainApplies = true
    await h.orchestrator.upgradePass()
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: CURRENT_IMAGE_ID, running: true })
  })

  it('aborts when the workspace refuses drain answers instead of recreating it unadmitted', async () => {
    await start({ env: { POISE_DRAIN_TIMEOUT: '1' } })
    const aliceId = h.docker.containers.get('poise-ws-alice')?.id
    h.workspace.healthStatus = 503
    await h.orchestrator.upgradePass()
    expect(h.docker.containers.get('poise-ws-alice')?.id).toBe(aliceId)
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: OLD_IMAGE_ID, running: true })
    expect(dockerCalls(h)).not.toContainEqual(expect.stringMatching(/^POST \/containers\/[^/]+\/stop$/))
    expect(events(h.logs, 'workspace.upgrade.aborted')).toHaveLength(1)
    h.workspace.healthStatus = 200
    await h.orchestrator.upgradePass()
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: CURRENT_IMAGE_ID, running: true })
  })

  it('aborts when refusals resume after a transient failure instead of cutting on stale down', async () => {
    await start({ env: { POISE_DRAIN_TIMEOUT: '1' } })
    const aliceId = h.docker.containers.get('poise-ws-alice')?.id
    h.workspace.reachable = false
    const upgrade = h.orchestrator.upgradePass()
    await waitFor(() => events(h.logs, 'workspace.drain.request.failed').length > 0, 'the failed drain request')
    // Reachable again, but every answer is refused: the earlier failure authorizes nothing.
    h.workspace.reachable = true
    h.workspace.healthStatus = 503
    await upgrade
    expect(h.docker.containers.get('poise-ws-alice')?.id).toBe(aliceId)
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: OLD_IMAGE_ID, running: true })
    expect(dockerCalls(h)).not.toContainEqual(expect.stringMatching(/^POST \/containers\/[^/]+\/stop$/))
    expect(events(h.logs, 'workspace.upgrade.aborted')).toHaveLength(1)
    h.workspace.healthStatus = 200
    await h.orchestrator.upgradePass()
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: CURRENT_IMAGE_ID, running: true })
  })

  it('aborts when answers deny health instead of cutting busy work on unconfirmed evidence', async () => {
    await start({ env: { POISE_DRAIN_TIMEOUT: '1' } })
    const aliceId = h.docker.containers.get('poise-ws-alice')?.id
    // Busy and draining, but never ok: no flag a forced stop could rest on may latch.
    h.workspace.health.ok = false
    h.workspace.health.activeChatTurns = 1
    await h.orchestrator.upgradePass()
    expect(h.docker.containers.get('poise-ws-alice')?.id).toBe(aliceId)
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: OLD_IMAGE_ID, running: true })
    expect(dockerCalls(h)).not.toContainEqual(expect.stringMatching(/^POST \/containers\/[^/]+\/stop$/))
    expect(events(h.logs, 'workspace.upgrade.aborted')).toHaveLength(1)
    expect(h.logs.find((entry) => entry.event === 'workspace.drain.timeout')).toMatchObject({
      activeChatTurns: null, runningCallerCalls: null, backgroundWork: null,
    })
    // Authoritative answers recover on the next pass.
    h.workspace.health.ok = true
    h.workspace.health.activeChatTurns = 0
    await h.orchestrator.upgradePass()
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: CURRENT_IMAGE_ID, running: true })
  })

  it('aborts when answers resume unadmitted after a transient failure instead of cutting on stale down', async () => {
    await start({ env: { POISE_DRAIN_TIMEOUT: '1' } })
    const aliceId = h.docker.containers.get('poise-ws-alice')?.id
    h.workspace.reachable = false
    const upgrade = h.orchestrator.upgradePass()
    await waitFor(() => events(h.logs, 'workspace.drain.request.failed').length > 0, 'the failed drain request')
    // Reachable again, but the drain never admits: the earlier failure authorizes nothing.
    h.workspace.reachable = true
    h.workspace.drainApplies = false
    await upgrade
    expect(h.docker.containers.get('poise-ws-alice')?.id).toBe(aliceId)
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: OLD_IMAGE_ID, running: true })
    expect(dockerCalls(h)).not.toContainEqual(expect.stringMatching(/^POST \/containers\/[^/]+\/stop$/))
    expect(events(h.logs, 'workspace.upgrade.aborted')).toHaveLength(1)
  })

  it('records the bound miss when the replacement answers late, and still reports when it answered', async () => {
    await start({ idleToReadyMs: 60 })
    h.docker.onStart = () => {
      h.workspace.answerDelayMs = 200
    }
    await h.orchestrator.upgradePass()
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: CURRENT_IMAGE_ID, running: true })
    const missed = h.logs.find((entry) => entry.event === 'workspace.upgrade.ready.missed')
    expect(missed).toMatchObject({ handle: 'alice', level: 'warn', boundMs: 60 })
    expect(typeof missed?.elapsedMs).toBe('number')
    const finished = h.logs.find((entry) => entry.event === 'workspace.upgrade.finished')
    expect(typeof finished?.readyAfterMs).toBe('number')
    expect(finished?.readyAfterMs as number).toBeGreaterThan(60)
  })

  it('holds a busy workspace through the drain, then recreates it ready within the idle-to-ready bound', async () => {
    await start()
    const aliceId = h.docker.containers.get('poise-ws-alice')?.id
    h.workspace.health.activeChatTurns = 1
    h.workspace.health.runningCallerCalls = 2
    const upgrade = h.orchestrator.upgradePass()
    await waitFor(() => h.workspace.serviceRequests.some((request) => request.url === '/api/service/health'), 'a busy workspace health poll')
    // Still the old container, still running, work untouched while the drain waits.
    expect(h.docker.containers.get('poise-ws-alice')?.id).toBe(aliceId)
    expect(h.docker.containers.get('poise-ws-alice')?.running).toBe(true)
    expect(dockerCalls(h)).not.toContainEqual(expect.stringMatching(/^POST \/containers\/[^/]+\/stop$/))
    h.workspace.health.activeChatTurns = 0
    h.workspace.health.runningCallerCalls = 0
    await upgrade
    const recreated = h.docker.containers.get('poise-ws-alice')
    expect(recreated?.id).not.toBe(aliceId)
    expect(recreated).toMatchObject({ imageId: CURRENT_IMAGE_ID, running: true })
    // The same home volume: continuity across the replacement.
    expect((recreated?.spec as { HostConfig: { Mounts: unknown } }).HostConfig.Mounts)
      .toEqual([{ Type: 'volume', Source: 'poise-home-alice', Target: '/home/poise' }])
    // Ready was observed, within the bound, before the upgrade finished.
    const finished = h.logs.find((entry) => entry.event === 'workspace.upgrade.finished')
    expect(finished).toMatchObject({ handle: 'alice' })
    expect(typeof finished?.readyAfterMs).toBe('number')
    expect(finished?.readyAfterMs as number).toBeLessThan(IDLE_TO_READY_MS)
    expect(events(h.logs, 'workspace.upgrade.ready.missed')).toHaveLength(0)
  })

  it('finishes past an unready replacement with a warning, and demand-driven readiness recovers', async () => {
    await start({ idleToReadyMs: 60 })
    h.docker.onStart = () => {
      h.workspace.healthStatus = 503
    }
    await h.orchestrator.upgradePass()
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: CURRENT_IMAGE_ID, running: true })
    const missed = h.logs.find((entry) => entry.event === 'workspace.upgrade.ready.missed')
    expect(missed).toMatchObject({ handle: 'alice', level: 'warn', boundMs: 60 })
    expect(typeof missed?.elapsedMs).toBe('number')
    expect(h.logs.find((entry) => entry.event === 'workspace.upgrade.finished')).not.toHaveProperty('readyAfterMs')
    // Once the workspace answers, the next visitor is proxied without another upgrade.
    h.workspace.healthStatus = 200
    expect(await h.orchestrator.readiness('alice', 'Alice')).toEqual({ ready: true })
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
        .toEqual(['/api/service/health', '/api/service/drain', '/api/service/drain', '/api/service/health'])
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
  const start = async (options: { oldBase?: string | null; running?: boolean; release?: string | null; repairRepositories?: string; drainRenewMs?: number } = {}) => {
    const { oldBase = BASE, running = true, release = 'old-release' } = options
    // A workspace that does not answer cannot prove native cleanup clear at this timeout.
    h = await startHarness({ drainRenewMs: options.drainRenewMs, env: { POISE_DRAIN_TIMEOUT: '1', POISE_REPAIR_EXHAUSTION_REPOSITORIES: options.repairRepositories } })
    await h.openWorkspace('Alice')
    h.store.noteWorkspace('alice', 'Alice')
    h.docker.imageLabels.set(CURRENT_IMAGE_ID, { 'poise.release': 'new-release', 'poise.base': BASE })
    if (oldBase !== null) h.docker.imageLabels.set(OLD_IMAGE_ID, { 'poise.release': 'old-release', 'poise.base': oldBase })
    addWorkspaceContainer(h, 'alice', OLD_IMAGE_ID, running)
    h.workspace.health.release = release
  }
  const containerId = () => h.docker.containers.get('poise-ws-alice')?.id
  const releaseTasks = () => h.docker.tasks.filter((task) => task.name === 'poise-release-alice')
  const offloadTasks = () => h.docker.tasks.filter((task) => task.name === 'poise-test-offload-alice')
  afterEach(async () => {
    await h.close()
  })

  it('keeps a healthy same-release container after a rebuild makes its original image unavailable', async () => {
    await start({ release: 'new-release' })
    const { workspaceCookie } = await h.openWorkspace('Alice')
    const before = containerId()
    h.docker.imageLabels.delete(OLD_IMAGE_ID)
    await h.orchestrator.upgradePass()
    expect(containerId()).toBe(before)
    expect(h.workspace.switches).toEqual([])
    expect(releaseTasks()).toEqual([])
    expect(h.workspace.serviceRequests.some(request => request.url === '/api/service/drain')).toBe(false)
    expect((await h.request({ host: ALICE, path: '/', headers: { cookie: workspaceCookie, ...NAVIGATE } })).status).toBe(200)
  })

  it('installs a new release of the same base into a running workspace and asks Poise to switch, keeping its container', async () => {
    await start()
    const before = containerId()
    await h.orchestrator.upgradePass()

    expect(releaseTasks()).toHaveLength(1)
    expect(releaseTasks()[0]).toMatchObject({
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
    expect(releaseTasks()).toHaveLength(1)
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

  it.each(['GET', 'HEAD', 'navigation', 'recovered'])(
    'returns the update response for a pre-response reset during a switch (%s), then freshly verifies recovery', async kind => {
      await start()
      const { workspaceCookie } = await h.openWorkspace('Alice')
      const headers = { cookie: workspaceCookie, ...(kind === 'navigation' ? NAVIGATE : {}) }
      const before = containerId()
      // Cache readiness before accepting the switch: only the reset may invalidate it.
      expect((await h.request({ host: ALICE, path: '/api/workspace', headers })).status).toBe(200)
      await h.orchestrator.upgradePass()
      expect(h.orchestrator.updatingTo('alice')).toBe('new-release')
      h.workspace.onRequest = request => {
        if (request.url !== '/reset') return
        if (kind === 'recovered') h.workspace.health.release = 'new-release'
        else h.workspace.reachable = false
      }

      const method = kind === 'HEAD' ? 'HEAD' : 'GET'
      const reset = await h.request({ host: ALICE, path: '/reset', method, headers })
      expect(reset.status).toBe(503)
      expect(reset.headers['x-poise-updating']).toBe('1')
      expect(reset.headers['retry-after']).toBe('2')
      if (kind === 'navigation') expect(reset.body).toContain('Updating to the latest version')
      else if (kind === 'HEAD') expect(reset.body).toBe('')
      else expect(reset.json()).toMatchObject({ error: 'workspace_updating' })
      const failures = h.logs.filter(entry => String(entry.event).startsWith('proxy.'))
      expect(failures).toEqual([expect.objectContaining({
        event: 'proxy.failed', level: 'warn', handle: 'alice', errno: 'ECONNRESET', release: 'new-release', method, route: '/',
        requestId: expect.any(String), upstream: `127.0.0.1:${h.workspace.port}`, durationMs: expect.any(Number),
        disconnect: 'responded 503 workspace_updating',
      })])
      expect(normalize(gatewayDiagnostic(String(failures[0].level), 'proxy.failed', failures[0]))).toMatchObject({
        severity: 'warning', requestId: failures[0].requestId, workspace: 'alice',
        context: { method, release: 'new-release', disconnect: 'responded 503 workspace_updating' },
      })
      expect(events(h.logs, 'workspace.update.finished')).toHaveLength(0)

      h.workspace.reachable = true
      h.workspace.health.release = 'new-release'
      h.workspace.health.switching = null
      const probes = h.workspace.serviceRequests.length
      expect((await h.request({ host: ALICE, path: '/api/workspace', headers })).status).toBe(200)
      expect(h.workspace.serviceRequests.slice(probes).map(request => request.url)).toEqual(['/api/service/health'])
      expect(h.orchestrator.updatingTo('alice')).toBeNull()
      expect(h.logs.find(entry => entry.event === 'workspace.update.finished')).toMatchObject({ release: 'new-release' })
      expect(h.workspace.requests.filter(request => request.url === '/reset')).toHaveLength(1)
      expect(h.workspace.switches).toEqual(['new-release'])
      expect(containerId()).toBe(before)
    })

  it.each(['no update', 'healthy old release', 'unhealthy', 'refused health'])(
    'keeps a reset actionable without proof of a restart (%s)', async kind => {
      await start()
      const { workspaceCookie } = await h.openWorkspace('Alice')
      const headers = { cookie: workspaceCookie }
      expect((await h.request({ host: ALICE, path: '/api/workspace', headers })).status).toBe(200)
      if (kind !== 'no update') await h.orchestrator.upgradePass()
      if (kind === 'unhealthy') h.workspace.health.ok = false
      if (kind === 'refused health') h.workspace.healthStatus = 503
      const probes = h.workspace.serviceRequests.length

      const reset = await h.request({ host: ALICE, path: '/reset', headers })
      expect(reset.status).toBe(502)
      expect(reset.json()).toMatchObject({ error: 'bad_gateway' })
      expect(reset.headers['x-poise-updating']).toBeUndefined()
      expect(h.workspace.serviceRequests.slice(probes).map(request => request.url))
        .toEqual(kind === 'no update' ? [] : ['/api/service/health'])
      const failures = h.logs.filter(entry => String(entry.event).startsWith('proxy.'))
      expect(failures).toEqual([expect.objectContaining({
        event: 'proxy.failed', level: 'error', errno: 'ECONNRESET', method: 'GET',
        release: kind === 'no update' ? null : 'new-release', disconnect: 'responded 502 bad_gateway',
      })])
      expect(normalize(gatewayDiagnostic(String(failures[0].level), 'proxy.failed', failures[0]))).toMatchObject({
        severity: 'error', requestId: failures[0].requestId, workspace: 'alice',
        context: { method: 'GET', release: kind === 'no update' ? null : 'new-release', disconnect: 'responded 502 bad_gateway' },
      })
      expect(events(h.logs, 'workspace.update.finished')).toHaveLength(0)
      expect(h.workspace.requests.filter(request => request.url === '/reset')).toHaveLength(1)
    })

  it.each(['POST', 'DELETE'])('keeps an interrupted %s actionable during a switch without replaying its effect', async method => {
    await start()
    const { workspaceCookie } = await h.openWorkspace('Alice')
    const headers = { cookie: workspaceCookie, 'content-type': 'application/json' }
    expect((await h.request({ host: ALICE, path: '/api/workspace', headers })).status).toBe(200)
    await h.orchestrator.upgradePass()
    h.workspace.onRequest = request => {
      if (request.url === '/reset') h.workspace.reachable = false
    }
    const body = method === 'POST' ? '{"effect":"applied before reset"}' : ''
    const reset = await h.request({ host: ALICE, path: '/reset', method, headers, body })
    expect(reset.status).toBe(502)
    expect(reset.headers['x-poise-updating']).toBeUndefined()
    // The fixture records the received mutation before dropping its answer; its outcome is ambiguous to the client.
    expect(h.workspace.requests.filter(request => request.url === '/reset')).toMatchObject([{ method, body }])
    expect(h.workspace.requestLines.filter(line => line === `${method} /reset`)).toHaveLength(1)
    const failures = h.logs.filter(entry => String(entry.event).startsWith('proxy.'))
    expect(failures).toEqual([expect.objectContaining({
      event: 'proxy.failed', level: 'error', method, errno: 'ECONNRESET', release: 'new-release',
      disconnect: 'responded 502 bad_gateway',
    })])
    expect(normalize(gatewayDiagnostic(String(failures[0].level), 'proxy.failed', failures[0]))).toMatchObject({
      severity: 'error', requestId: failures[0].requestId, workspace: 'alice',
      context: { method, release: 'new-release', disconnect: 'responded 502 bad_gateway' },
    })
  })

  it.each(['closed client', 'thrown answer', 'switch completed'])('keeps Error when a verified reset cannot produce the update response (%s)', async kind => {
    await start()
    const { workspaceCookie } = await h.openWorkspace('Alice')
    const headers = { cookie: workspaceCookie }
    expect((await h.request({ host: ALICE, path: '/api/workspace', headers })).status).toBe(200)
    await h.orchestrator.upgradePass()
    h.workspace.health.release = 'new-release'
    const probe = h.orchestrator.restartingForUpdate.bind(h.orchestrator)
    const restart = vi.spyOn(h.orchestrator, 'restartingForUpdate').mockImplementation(async (handle, login) => {
      const restarting = await probe(handle, login)
      expect(restarting).toBe(true)
      if (kind === 'closed client') {
        const session = h.store.findSession(workspaceCookie.slice('poise_ws='.length))!
        h.context.endSessionTraffic(session.parentHash ?? session.idHash)
      } else if (kind === 'switch completed') {
        // Another readiness check completes the switch before starting() re-reads it.
        expect(await h.orchestrator.readiness(handle, login)).toEqual({ ready: true })
      }
      return restarting
    })
    const answer = kind === 'thrown answer' ? vi.spyOn(h.orchestrator, 'startInBackground').mockImplementationOnce(() => {
      throw new Error('update answer failed')
    }) : null
    try {
      const request = h.request({ host: ALICE, path: '/reset', headers })
      if (kind === 'switch completed') {
        const response = await request
        expect(response.status).toBe(503)
        expect(response.json()).toMatchObject({ error: 'workspace_starting' })
        expect(response.headers['x-poise-updating']).toBeUndefined()
        expect(response.headers['retry-after']).toBe('2')
      } else {
        await expect(request).rejects.toThrow('socket hang up')
      }
      await waitFor(() => h.logs.some(entry => String(entry.event).startsWith('proxy.')), 'the reset diagnostic')
      const failures = h.logs.filter(entry => String(entry.event).startsWith('proxy.'))
      const disconnect = kind === 'switch completed' ? 'responded 503 workspace_starting'
        : kind === 'closed client' ? 'response unanswered (client closed)' : 'response unanswered'
      const event = kind === 'thrown answer' ? 'proxy.failure.unanswered' : 'proxy.failed'
      expect(failures).toEqual([expect.objectContaining({
        event, level: 'error', method: 'GET', errno: 'ECONNRESET', release: 'new-release', disconnect,
        ...(kind === 'thrown answer' ? { error: 'update answer failed' } : {}),
      })])
      expect(normalize(gatewayDiagnostic(String(failures[0].level), event, failures[0]))).toMatchObject({
        severity: 'error', requestId: failures[0].requestId, workspace: 'alice',
        context: { method: 'GET', release: 'new-release', disconnect },
      })
      expect(h.workspace.requests.filter(request => request.url === '/reset')).toHaveLength(1)
    } finally {
      answer?.mockRestore()
      restart.mockRestore()
    }
  })

  it('recreates the container when the new image has another base, its release made current first', async () => {
    await start({ oldBase: 'base-0', release: 'new-release' })
    const before = containerId()
    await h.orchestrator.upgradePass()
    expect(h.workspace.switches).toEqual([])
    expect(releaseTasks().map((task) => (task.spec as { Cmd: string[] }).Cmd)).toEqual([['--activate']])
    const calls = dockerCalls(h)
    expect(calls.indexOf('POST /containers/poise-release-alice/wait')).toBeLessThan(calls.indexOf(`POST /containers/${before}/stop`))
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
    expect(releaseTasks().map((task) => (task.spec as { Cmd: string[] }).Cmd)).toEqual([['--activate'], ['--activate']])
    const docker = dockerCalls(h)
    expect(docker.lastIndexOf('POST /containers/poise-release-alice/wait')).toBeLessThan(docker.findIndex(call => /^POST \/containers\/[^/]+\/stop$/.test(call)))
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: CURRENT_IMAGE_ID, running: true })
  })

  it('aborts when the final recheck answers idle without the drain on, instead of stopping blind', async () => {
    await start({ oldBase: 'base-0' })
    const before = containerId()
    h.docker.onTask = () => {
      // Activation restarts Poise, and the new Poise answers the recheck without holding a drain.
      h.workspace.drainApplies = false
      h.workspace.health.draining = false
      h.docker.onTask = undefined
    }
    await h.orchestrator.upgradePass()
    expect(events(h.logs, 'workspace.drain.unconfirmed').length).toBeGreaterThanOrEqual(1)
    expect(events(h.logs, 'workspace.upgrade.aborted')).toHaveLength(1)
    expect(containerId()).toBe(before)
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: OLD_IMAGE_ID, running: true })
    expect(dockerCalls(h)).not.toContainEqual(expect.stringMatching(/^POST \/containers\/[^/]+\/stop$/))
    // The next pass admits and upgrades.
    h.workspace.drainApplies = true
    await h.orchestrator.upgradePass()
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: CURRENT_IMAGE_ID, running: true })
  })

  it('rechecks native cleanup after activation instead of forcing on an earlier idle answer', async () => {
    await start({ oldBase: 'base-0' })
    const before = containerId()
    h.docker.onTask = () => {
      h.workspace.health.unsettledNativeCalls = 1
      h.workspace.health.backgroundWork = 1
      h.advance(2000)
      h.docker.onTask = undefined
    }
    await h.orchestrator.upgradePass()
    expect(containerId()).toBe(before)
    expect(dockerCalls(h)).not.toContainEqual(expect.stringMatching(/^POST \/containers\/[^/]+\/stop$/))
    expect(events(h.logs, 'workspace.upgrade.native-pending')).toHaveLength(1)
  })

  it('aborts when refused answers follow a recheck that lost admission, instead of cutting on stale state', async () => {
    await start({ oldBase: 'base-0' })
    const before = containerId()
    h.workspace.health.runningCallerCalls = 1
    setTimeout(() => {
      h.workspace.health.runningCallerCalls = 0
    }, 60)
    h.docker.onTask = () => {
      // Activation restarts Poise without holding a drain; the slow recheck leaves time to flip under it.
      h.workspace.drainApplies = false
      h.workspace.health.draining = false
      h.workspace.answerDelayMs = 200
      h.docker.onTask = undefined
    }
    const upgrade = h.orchestrator.upgradePass()
    // The second drain POST is the recheck: refuse everything received after it is sent, so the
    // recheck still answers from before the flip while the whole retry round is refused.
    await waitFor(() => h.workspace.serviceRequests.filter((request) => request.url === '/api/service/drain').length >= 2, 'the recheck request')
    h.workspace.healthStatus = 503
    await upgrade
    expect(events(h.logs, 'workspace.drain.unconfirmed').length).toBeGreaterThanOrEqual(1)
    expect(events(h.logs, 'workspace.upgrade.aborted')).toHaveLength(1)
    expect(containerId()).toBe(before)
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: OLD_IMAGE_ID, running: true })
    expect(dockerCalls(h)).not.toContainEqual(expect.stringMatching(/^POST \/containers\/[^/]+\/stop$/))
    // The next pass admits and upgrades once answers resume.
    h.workspace.answerDelayMs = 0
    h.workspace.healthStatus = 200
    h.workspace.drainApplies = true
    await h.orchestrator.upgradePass()
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: CURRENT_IMAGE_ID, running: true })
  })

  it('aborts when busy work arrives unadmitted after a lost admission, instead of cutting on stale state', async () => {
    await start({ oldBase: 'base-0' })
    const before = containerId()
    h.docker.onTask = () => {
      // Activation restarts Poise; the new Poise takes work without holding a drain.
      h.workspace.drainApplies = false
      h.workspace.health.draining = false
      h.workspace.health.runningCallerCalls = 1
      h.docker.onTask = undefined
    }
    await h.orchestrator.upgradePass()
    expect(events(h.logs, 'workspace.upgrade.aborted')).toHaveLength(1)
    expect(containerId()).toBe(before)
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: OLD_IMAGE_ID, running: true })
    expect(dockerCalls(h)).not.toContainEqual(expect.stringMatching(/^POST \/containers\/[^/]+\/stop$/))
    // The next pass admits and upgrades once the work settles.
    h.workspace.drainApplies = true
    h.workspace.health.runningCallerCalls = 0
    await h.orchestrator.upgradePass()
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

  it('installs agents\' test offload into the home volume with each release, turning it off when unset', async () => {
    await start()
    await h.orchestrator.upgradePass()
    expect(offloadTasks()).toHaveLength(1)
    expect(offloadTasks()[0]).toMatchObject({
      spec: {
        Image: 'poise-runtime:latest',
        User: '10001',
        Entrypoint: ['/opt/poise/scripts/test-offload/install.sh'],
        Cmd: [],
        Env: ['HOME=/home/poise'],
        Labels: { 'poise.task': 'install-test-offload', 'poise.workspace': 'alice' },
        HostConfig: { NetworkMode: 'none', CapDrop: ['ALL'], Mounts: [{ Type: 'volume', Source: 'poise-home-alice', Target: '/home/poise' }] },
      },
    })
    expect(h.docker.containers.has('poise-test-offload-alice')).toBe(false)
    // Installed before Poise is asked to switch, so the Poise it restarts onto finds it.
    expect(h.workspace.switches).toEqual(['new-release'])
    await h.close()

    h = await startHarness({ env: { POISE_DRAIN_TIMEOUT: '1', POISE_TEST_RENDER_API_KEY: 'render-key', POISE_TEST_WORKSPACE: 'tea-x', POISE_TEST_LIMIT_SECONDS: '900' } })
    await h.openWorkspace('Alice')
    h.store.noteWorkspace('alice', 'Alice')
    h.docker.imageLabels.set(CURRENT_IMAGE_ID, { 'poise.release': 'new-release', 'poise.base': BASE })
    h.docker.imageLabels.set(OLD_IMAGE_ID, { 'poise.release': 'old-release', 'poise.base': BASE })
    addWorkspaceContainer(h, 'alice', OLD_IMAGE_ID, true)
    h.workspace.health.release = 'old-release'
    await h.orchestrator.upgradePass()
    const env = (offloadTasks()[0].spec as { Env: string[] }).Env
    // The relay's address and this workspace's own key, and never the Render key.
    expect(env).toEqual(['HOME=/home/poise', expect.stringMatching(/^POISE_TEST_RELAY_URL=https?:\/\/alice\..+\/api\/link\/test-relay$/), expect.stringMatching(/^POISE_TEST_RELAY_KEY=alice\.[\w-]+$/), 'POISE_TEST_LIMIT_SECONDS=900'])
    expect(env.join('\n')).not.toContain('render-key')
  })

  it('takes a new release even when installing the test offload fails, and reports it', async () => {
    await start()
    h.docker.taskExitCodes.set('poise-test-offload-alice', 3)
    await h.orchestrator.upgradePass()
    expect(h.workspace.switches).toEqual(['new-release'])
    expect(h.logs.find((entry) => entry.event === 'workspace.test_offload.install.failed')).toMatchObject({ handle: 'alice', error: expect.stringContaining('exited with 3') })
    expect(h.store.getWorkspace('alice')?.lastError).toContain('test offload not installed')
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
    await start({ release: 'new-release' })
    const before = containerId()
    h.docker.containers.get('poise-ws-alice')!.spec = { ...h.docker.containers.get('poise-ws-alice')!.spec, Env: ['POISE_DRAIN_TIMEOUT=60'] }
    await h.orchestrator.upgradePass()
    expect(h.workspace.switches).toEqual([])
    expect(containerId()).not.toBe(before)
    expect(containerEnv(h, 'alice')).toContain(`POISE_DRAIN_TIMEOUT=${h.config.drainTimeoutSeconds}`)
  })

  it.each(['added', 'changed', 'removed', 'oversized legacy'].flatMap(change => [false, true].map(sameImage => ({ change, sameImage }))))(
    'applies the $change report allowlist in place while native cleanup remains held (same image=$sameImage)', async ({ change, sameImage }) => {
      const desired = change === 'oversized legacy' ? `${'a/b,'.repeat(2047)}a/bb` : change === 'removed' ? '' : 'acme/one,acme/two'
      await start({ repairRepositories: desired })
      const container = h.docker.containers.get('poise-ws-alice')!
      const previous = change === 'oversized legacy' ? `${desired},acme/revoked` : change === 'added' ? '' : 'acme/old'
      container.spec = { ...container.spec, Env: [`POISE_DRAIN_TIMEOUT=${h.config.drainTimeoutSeconds}`,
        ...(previous ? [`POISE_REPAIR_EXHAUSTION_REPOSITORIES=${previous}`] : [])] }
      h.workspace.health.repairExhaustionRepositories = change === 'oversized legacy' ? '[oversized]' : previous
      if (sameImage) {
        container.imageId = CURRENT_IMAGE_ID
        h.workspace.health.release = 'new-release'
      }
      const before = containerId()
      const originalEnvironment = containerEnv(h, 'alice').slice()
      h.workspace.health.unsettledNativeCalls = 1
      h.workspace.health.backgroundWork = 1
      await h.orchestrator.upgradePass()
      expect(containerId()).toBe(before)
      expect(h.workspace.switches).toEqual(sameImage ? [] : ['new-release'])
      expect(h.workspace.health.draining).toBe(false)
      expect(h.workspace.health.repairExhaustionRepositories).toBe(desired)
      const configuration = h.workspace.serviceRequests.filter(request => request.url === '/api/service/config')
      expect(configuration).toHaveLength(1)
      expect(JSON.parse(configuration[0].body)).toEqual({ repairExhaustionRepositories: desired })
      expect(configuration[0].headers.host).toBe(ALICE)
      expect(verifyAssertion(String(configuration[0].headers['x-poise-identity']), h.keys.publicKeyBase64))
        .toMatchObject({ aud: 'workspace:alice', sub: 'Alice', scope: 'admin' })
      h.workspace.health.release = 'new-release'
      await h.orchestrator.upgradePass()
      expect(containerId()).toBe(before)
      expect(containerEnv(h, 'alice')).toEqual(originalEnvironment)
      expect(h.workspace.health).toMatchObject({ unsettledNativeCalls: 1, backgroundWork: 1, draining: false })
      expect(h.workspace.serviceRequests.filter(request => request.url === '/api/service/config')).toHaveLength(1)
      expect(h.workspace.serviceRequests.some(request => request.url === '/api/service/drain')).toBe(false)

      // A runtime-base change still cannot replace the supervisor owning this cleanup hold.
      h.docker.imageLabels.set(CURRENT_IMAGE_ID, { 'poise.release': 'new-release', 'poise.base': 'different-base' })
      container.imageId = OLD_IMAGE_ID
      await h.orchestrator.upgradePass()
      expect(containerId()).toBe(before)
      expect(h.workspace.health).toMatchObject({ unsettledNativeCalls: 1, backgroundWork: 1, draining: false })
      expect(h.logs.some(entry => entry.event === 'workspace.upgrade.aborted')).toBe(true)
    })

  it('switches a workspace on the current image that still runs an older release', async () => {
    await start()
    const alice = h.docker.containers.get('poise-ws-alice')!
    alice.imageId = CURRENT_IMAGE_ID
    await h.orchestrator.upgradePass()
    expect(releaseTasks()).toHaveLength(1)
    expect(h.workspace.switches).toEqual(['new-release'])
    h.workspace.health.release = 'new-release'
    await h.orchestrator.upgradePass()
    expect(h.workspace.switches).toHaveLength(1)
  })

  it('calls off a pending switch to another release once the workspace runs the target release again', async () => {
    await start()
    const alice = h.docker.containers.get('poise-ws-alice')!
    alice.imageId = CURRENT_IMAGE_ID
    h.workspace.health.release = 'new-release'
    h.workspace.health.switching = 'withdrawn-release'
    await h.orchestrator.upgradePass()
    expect(h.workspace.switches).toEqual(['new-release'])
    expect(h.workspace.health.switching).toBeNull()
    expect(h.logs.find((entry) => entry.event === 'workspace.update.withdrawn')).toMatchObject({ handle: 'alice', release: 'withdrawn-release', running: 'new-release' })
    await h.orchestrator.upgradePass()
    expect(h.workspace.switches).toEqual(['new-release'])
  })

  it('reports busy waiting for a quiet moment instead of silently asking again', async () => {
    await start()
    const before = containerId()
    h.workspace.health.activeChatTurns = 1
    await h.orchestrator.upgradePass()
    expect(h.workspace.switches).toEqual(['new-release'])
    expect(containerId()).toBe(before)
    expect(h.logs.find((entry) => entry.event === 'workspace.update.waiting')).toMatchObject({
      handle: 'alice',
      release: 'new-release',
      running: 'old-release',
      activeChatTurns: 1,
      runningCallerCalls: 0,
      backgroundWork: 0,
    })
    expect(events(h.logs, 'workspace.update.stuck')).toHaveLength(0)
  })

  it('warns once when an idle workspace still runs the old release past the grace, and keeps asking', async () => {
    await start()
    const before = containerId()
    await h.orchestrator.upgradePass()
    expect(h.workspace.switches).toEqual(['new-release'])
    h.advance(11 * 60_000)
    await h.orchestrator.upgradePass()
    await h.orchestrator.upgradePass()
    // Still asked, never drained: recreating would cut work the gateway cannot see.
    expect(h.workspace.switches).toEqual(['new-release', 'new-release', 'new-release'])
    expect(containerId()).toBe(before)
    expect(h.workspace.serviceRequests.some((request) => request.url === '/api/service/drain')).toBe(false)
    const stuck = h.logs.filter((entry) => entry.event === 'workspace.update.stuck')
    expect(stuck).toHaveLength(1)
    expect(stuck[0]).toMatchObject({ handle: 'alice', level: 'warn', release: 'new-release', running: 'old-release' })
    expect(typeof stuck[0].elapsedMs).toBe('number')
  })

  it('defers replacement of an unreachable switching workspace without native cleanup proof', async () => {
    await start()
    const before = containerId()
    await h.orchestrator.upgradePass()
    h.workspace.reachable = false
    h.orchestrator.markNotReady('alice')
    await h.orchestrator.upgradePass()
    expect(containerId()).toBe(before)
    h.advance(11 * 60_000)
    await h.orchestrator.upgradePass()
    expect(containerId()).toBe(before)
    expect(dockerCalls(h)).not.toContainEqual(expect.stringMatching(/^POST \/containers\/[^/]+\/stop$/))
    expect(events(h.logs, 'workspace.upgrade.native-pending')).toHaveLength(1)
    expect(h.logs.find((entry) => entry.event === 'workspace.update.unreachable')).toMatchObject({ handle: 'alice' })
  })

  it.each(['initial idle reply', 'initial busy reply', 'health poll', 'drain renewal'])(
    'releases an unreachable fallback on recovery in the %s without stopping its container', async reply => {
      await start({ drainRenewMs: reply === 'drain renewal' ? 1 : undefined })
      const before = containerId()
      await h.orchestrator.upgradePass()
      h.workspace.healthStatus = 503
      await h.orchestrator.upgradePass()
      h.advance(11 * 60_000)
      // The failed probe's answer is captured before recovery; the first drain can answer healthy.
      h.workspace.answerDelayMs = 100
      const requestsBefore = h.workspace.serviceRequests.length
      const began = Date.now()
      const upgrade = h.orchestrator.upgradePass()
      await waitFor(() => h.workspace.serviceRequests.length > requestsBefore, 'the failed in-place probe')
      h.workspace.answerDelayMs = 0
      h.workspace.healthStatus = 200
      h.workspace.health.runningCallerCalls = reply === 'initial idle reply' ? 0 : 1
      h.workspace.health.switching = null
      if (reply.startsWith('initial')) h.workspace.health.release = 'new-release'
      else {
        await waitFor(() => events(h.logs, 'workspace.drain.requested').length > 0, 'an admitted busy drain')
        expect(h.workspace.health.draining).toBe(true)
        expect(h.workspace.health.runningCallerCalls).toBe(1)
        h.workspace.health.release = 'new-release'
      }
      await upgrade

      expect(Date.now() - began).toBeLessThan(h.config.drainTimeoutSeconds * 1000)
      expect(h.workspace.health).toMatchObject({ draining: false, runningCallerCalls: reply === 'initial idle reply' ? 0 : 1 })
      const requests = h.workspace.serviceRequests.slice(requestsBefore)
      expect(requests.at(-1)).toMatchObject({ method: 'POST', url: '/api/service/resume' })
      const drainRequests = requests.filter(request => request.url === '/api/service/drain')
      if (reply === 'drain renewal') expect(drainRequests.length).toBeGreaterThanOrEqual(2)
      else expect(drainRequests).toHaveLength(1)
      if (reply === 'health poll') expect(requests.slice(2, -1)).toContainEqual(expect.objectContaining({ method: 'GET', url: '/api/service/health' }))
      expect(containerId()).toBe(before)
      expect(h.docker.containers.get('poise-ws-alice')?.running).toBe(true)
      expect(dockerCalls(h)).not.toContainEqual(expect.stringMatching(/^POST \/containers\/[^/]+\/stop$/))
      expect(dockerCalls(h)).not.toContainEqual(expect.stringMatching(/^DELETE \/containers\/(?:poise-ws-alice|[a-f0-9]+)$/))
      expect(releaseTasks().map(task => (task.spec as { Cmd: string[] }).Cmd)).toEqual([[]])
      expect(h.orchestrator.updatingTo('alice')).toBeNull()
      expect(events(h.logs, 'workspace.drain.timeout')).toHaveLength(0)
      expect(h.logs.find(entry => entry.event === 'workspace.drain.released'))
        .toMatchObject({ handle: 'alice', reason: 'the workspace recovered on the target release' })
    },
  )

  it.each(['unhealthy', 'pending release', 'missing release', 'changed setting', 'changed base'])(
    'keeps the fallback safeguards when recovery is unproven: %s', async cause => {
      await start({ drainRenewMs: 1 })
      const before = containerId()
      h.workspace.reachable = false
      await h.orchestrator.upgradePass()
      h.advance(11 * 60_000)
      const upgrade = h.orchestrator.upgradePass()
      await waitFor(() => events(h.logs, 'workspace.drain.request.failed').length > 0, 'the failed fallback drain')
      h.workspace.reachable = true
      h.workspace.health.release = cause === 'pending release' ? 'old-release' : cause === 'missing release' ? null : 'new-release'
      h.workspace.health.switching = 'new-release'
      h.workspace.health.runningCallerCalls = 1
      h.workspace.health.ok = cause !== 'unhealthy'
      if (cause === 'changed setting') containerEnv(h, 'alice').push('POISE_BEHAVIOR_MEMORY_BUDGET_BYTES=6442450944')
      if (cause === 'changed base') h.docker.containers.get('poise-ws-alice')!.labels['poise.base'] = 'base-0'
      await upgrade

      expect(events(h.logs, 'workspace.drain.timeout')).toHaveLength(1)
      expect(events(h.logs, 'workspace.upgrade.aborted')).toHaveLength(1)
      expect(h.logs.some(entry => entry.event === 'workspace.drain.released' && entry.reason === 'the workspace recovered on the target release')).toBe(false)
      expect(containerId()).toBe(before)
      expect(dockerCalls(h)).not.toContainEqual(expect.stringMatching(/^POST \/containers\/[^/]+\/stop$/))
      expect(dockerCalls(h)).not.toContainEqual(expect.stringMatching(/^DELETE \/containers\/(?:poise-ws-alice|[a-f0-9]+)$/))
    },
  )

  it('rides out one missed probe long after the switch was asked for, and asks again on the next pass', async () => {
    await start()
    const before = containerId()
    await h.orchestrator.upgradePass()
    // The switch waits server-side for a quiet moment, long past the grace, while the workspace answers.
    h.advance(30 * 60_000)
    h.workspace.reachable = false
    await h.orchestrator.upgradePass()
    expect(containerId()).toBe(before)
    expect(h.workspace.serviceRequests.some((request) => request.url === '/api/service/drain')).toBe(false)
    expect(h.orchestrator.updatingTo('alice')).toBe('new-release')
    h.workspace.reachable = true
    await h.orchestrator.upgradePass()
    expect(h.workspace.switches).toEqual(['new-release', 'new-release'])
    expect(containerId()).toBe(before)
  })

  it('asks again on the next pass when a workspace not yet asked misses one probe', async () => {
    await start()
    const before = containerId()
    h.workspace.reachable = false
    await h.orchestrator.upgradePass()
    expect(containerId()).toBe(before)
    expect(h.workspace.serviceRequests.some((request) => request.url === '/api/service/drain')).toBe(false)
    h.workspace.reachable = true
    await h.orchestrator.upgradePass()
    expect(h.workspace.switches).toEqual(['new-release'])
    expect(containerId()).toBe(before)
  })

  it('defers replacement of an unreachable workspace never asked to switch', async () => {
    await start()
    const before = containerId()
    h.workspace.reachable = false
    await h.orchestrator.upgradePass()
    expect(containerId()).toBe(before)
    h.advance(11 * 60_000)
    await h.orchestrator.upgradePass()
    expect(containerId()).toBe(before)
    expect(dockerCalls(h)).not.toContainEqual(expect.stringMatching(/^POST \/containers\/[^/]+\/stop$/))
    expect(events(h.logs, 'workspace.upgrade.native-pending')).toHaveLength(1)
    expect(h.logs.find((entry) => entry.event === 'workspace.update.unreachable')).toMatchObject({ handle: 'alice' })
  })

  it('starts a fresh grace when the target release changes after missed probes', async () => {
    await start()
    const before = containerId()
    h.workspace.reachable = false
    await h.orchestrator.upgradePass()
    expect(containerId()).toBe(before)
    h.advance(11 * 60_000)
    // A newer image arrives while the workspace is still dark: its misses belong to the old release.
    h.docker.imageLabels.set(CURRENT_IMAGE_ID, { 'poise.release': 'third-release', 'poise.base': BASE })
    await h.orchestrator.upgradePass()
    expect(containerId()).toBe(before)
    expect(h.workspace.serviceRequests.some((request) => request.url === '/api/service/drain')).toBe(false)
    h.advance(11 * 60_000)
    await h.orchestrator.upgradePass()
    expect(containerId()).toBe(before)
    expect(dockerCalls(h)).not.toContainEqual(expect.stringMatching(/^POST \/containers\/[^/]+\/stop$/))
    expect(h.logs.find((entry) => entry.event === 'workspace.update.unreachable')).toMatchObject({ handle: 'alice' })
  })

  it('forgets missed probes once the workspace answers again', async () => {
    await start()
    const before = containerId()
    h.workspace.reachable = false
    await h.orchestrator.upgradePass()
    h.workspace.reachable = true
    h.workspace.health.release = 'new-release'
    await h.orchestrator.upgradePass()
    h.advance(11 * 60_000)
    h.workspace.reachable = false
    await h.orchestrator.upgradePass()
    expect(containerId()).toBe(before)
    expect(h.workspace.serviceRequests.some((request) => request.url === '/api/service/drain')).toBe(false)
  })

  it('recreates a stopped workspace on the new image, with the new release current', async () => {
    await start({ running: false })
    await h.orchestrator.upgradePass()
    expect(releaseTasks().map((task) => (task.spec as { Cmd: string[] }).Cmd)).toEqual([['--activate']])
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
    expect(h.workspace.serviceRequests[1]).toMatchObject({ method: 'POST', url: '/api/service/drain' })
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
    expect(h.workspace.serviceRequests.map((request) => `${request.method} ${request.url}`)).toEqual([
      'GET /api/service/health', 'POST /api/service/drain', 'POST /api/service/drain', 'GET /api/service/health',
    ])
    expect(events(h.logs, 'workspace.')).toEqual([
      'workspace.network.connected',
      'workspace.upgrade.started',
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
    await waitFor(() => h.workspace.health.draining, 'the drain request')
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
    h.workspace.onServiceRequest = ({ url }) => {
      if (url !== '/api/service/health') return
      h.docker.containers.get('poise-gateway')?.networks.delete('poise-net-alice')
      h.workspace.onServiceRequest = undefined
    }
    const pass = h.orchestrator.upgradePass()
    await waitFor(() => events(h.logs, 'workspace.drain.request.failed').length > 0, 'the drain to reach nothing')
    const page = await h.request({ host: ALICE, path: '/', headers: { ...NAVIGATE, cookie } })
    expect(page.status).toBe(200)
    expect(events(h.logs, 'workspace.network.connected')).toHaveLength(1)
    // The drain was never admitted — its only POST reached nothing — so the pass aborts instead of
    // cutting on the stale failure, and the next pass admits over the rejoined network and upgrades.
    await pass
    expect(events(h.logs, 'workspace.upgrade.aborted')).toHaveLength(1)
    expect(h.docker.containers.get('poise-ws-alice')).toMatchObject({ imageId: OLD_IMAGE_ID, running: true })
    await h.orchestrator.upgradePass()
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
