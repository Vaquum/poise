import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { DockerClient } from '../src/docker.js'
import { loadOrCreateKeys, type GatewayKeys } from '../src/keys.js'
import { createLogger } from '../src/log.js'
import { Orchestrator } from '../src/orchestrator.js'
import { Store } from '../src/store.js'

// The fake Docker Engine records what the gateway asks for; only a real Engine shows what it applies,
// and it silently ignores misspelled fields. CI runs this with POISE_GATEWAY_DOCKER_TESTS=1.
const enabled = process.env.POISE_GATEWAY_DOCKER_TESTS === '1'

const HEALTH_SERVER = `require('node:http').createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ ok: true, mode: 'service', version: 'ci', activeChatTurns: 0, runningCallerCalls: 0, backgroundWork: 0, idle: true, draining: false }))
}).listen(5555)`

// The gateway's own container, standing in: it relays every call to poise-ws-ci by name, which resolves
// only on a network the two containers share, so a call reaches the workspace exactly when the gateway could.
const GATEWAY_RELAY = `const http = require('node:http')
http.createServer((req, res) => {
  const upstream = http.request({ host: 'poise-ws-ci', port: 5555, method: req.method, path: req.url, headers: req.headers }, (answer) => {
    res.writeHead(answer.statusCode, answer.headers)
    answer.pipe(res)
  })
  upstream.on('error', () => res.destroy())
  req.pipe(upstream)
}).listen(8080)`

const SETTINGS = {
  POISE_DOMAIN: 'poise.test',
  POISE_GITHUB_CLIENT_ID: 'ci',
  POISE_GITHUB_CLIENT_SECRET: 'ci',
  POISE_ADMINS: 'root',
  POISE_RUNTIME_IMAGE: 'poise-runtime:ci',
  POISE_GATEWAY_CONTAINER: 'poise-gateway-ci',
  POISE_WORKSPACE_MEMORY: '512m',
  POISE_WORKSPACE_CPUS: '1',
  POISE_WORKSPACE_PIDS: '256',
  POISE_DRAIN_TIMEOUT: '30',
}

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim()
}

interface Inspected {
  Id: string
  Image: string
  State: { Running: boolean }
  Config: { User: string; Labels: Record<string, string>; Env: string[] }
  HostConfig: Record<string, unknown> & { PortBindings: Record<string, unknown> | null }
  Mounts: Array<Record<string, unknown>>
  NetworkSettings: { Networks: Record<string, { IPAddress: string }> }
}

function inspect(name: string): Inspected {
  return (JSON.parse(docker('inspect', name)) as Inspected[])[0]
}

/** A stand-in runtime image: it answers every request with an idle service health. */
function buildRuntimeStandIn(tag: string, variant: string): void {
  const dockerfile = [
    'FROM node:22-bookworm-slim',
    `RUN echo ${Buffer.from(HEALTH_SERVER).toString('base64')} | base64 -d > /health.js`,
    `LABEL poise.ci.variant=${variant}`,
    'CMD ["node", "/health.js"]',
  ].join('\n')
  execFileSync('docker', ['build', '--quiet', '--tag', tag, '-'], { input: dockerfile })
}

async function listening(host: string, port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port }, () => {
        socket.destroy()
        resolve(true)
      })
      socket.setTimeout(1000, () => {
        socket.destroy()
        resolve(false)
      })
      socket.on('error', () => resolve(false))
    })
    if (connected) return
    await delay(100)
  }
  throw new Error(`nothing listens at ${host}:${port}`)
}

async function ready(orchestrator: Orchestrator): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await orchestrator.readiness('ci', 'CI')).ready) return true
    await delay(200)
  }
  return false
}

// One workspace through three steps, each building on the one before.
describe.skipIf(!enabled)('workspaces on a real Docker Engine', () => {
  const removeAll = () => {
    spawnSync('docker', ['rm', '--force', 'poise-ws-ci', 'poise-gateway-ci'])
    spawnSync('docker', ['network', 'rm', 'poise-net-ci', 'poise-edge-ci'])
    spawnSync('docker', ['volume', 'rm', 'poise-home-ci'])
  }
  const logs: Array<Record<string, unknown>> = []
  const log = createLogger((line) => logs.push(JSON.parse(line) as Record<string, unknown>))
  let dir: string
  let store: Store
  let keys: GatewayKeys
  let gatewayAddress = ''

  /** Runs the gateway's container on a network of its own, as Compose runs the gateway, on no workspace network. */
  const startGateway = async (): Promise<void> => {
    docker('run', '--detach', '--name', 'poise-gateway-ci', '--network', 'poise-edge-ci', 'node:22-bookworm-slim', 'node', '--eval', GATEWAY_RELAY)
    gatewayAddress = inspect('poise-gateway-ci').NetworkSettings.Networks['poise-edge-ci'].IPAddress
    await listening(gatewayAddress, 8080)
  }
  const gatewayNetworks = () => Object.keys(inspect('poise-gateway-ci').NetworkSettings.Networks)
  /** A new gateway process, which knows nothing yet about the networks its container is on. */
  const gatewayProcess = (settings: Record<string, string> = {}): Orchestrator => {
    const config = loadConfig({ ...SETTINGS, POISE_GATEWAY_DATA: dir, ...settings })
    return new Orchestrator({
      config, docker: new DockerClient(config.dockerSocket), store, keys, log, now: Date.now,
      upstream: () => ({ host: gatewayAddress, port: 8080 }), drainPollMs: 100,
    })
  }
  const eventsSince = (from: number) => logs.slice(from).map((entry) => entry.event)

  beforeAll(async () => {
    removeAll()
    buildRuntimeStandIn('poise-runtime-ci:first', 'first')
    buildRuntimeStandIn('poise-runtime-ci:second', 'second')
    docker('tag', 'poise-runtime-ci:first', 'poise-runtime:ci')
    docker('network', 'create', 'poise-edge-ci')
    dir = mkdtempSync(join(tmpdir(), 'gw-docker-'))
    store = new Store(join(dir, 'gateway.db'), Date.now)
    keys = loadOrCreateKeys(dir, log)
    await startGateway()
  }, 300_000)

  afterAll(() => {
    removeAll()
    store?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates a workspace with the contract settings and reaches it over the network the gateway joined', async () => {
    const orchestrator = gatewayProcess()
    await orchestrator.ensureStarted('ci', 'CI')
    const workspace = inspect('poise-ws-ci')
    expect(workspace.State.Running).toBe(true)
    expect(workspace.Config.User).toBe('10001')
    expect(workspace.Config.Labels).toMatchObject({ 'poise.managed': 'true', 'poise.workspace': 'ci' })
    expect(workspace.Config.Env).toEqual(expect.arrayContaining([
      'POISE_MODE=service',
      'POISE_WORKSPACE_HANDLE=ci',
      'POISE_WORKSPACE_OWNER=CI',
      'POISE_PUBLIC_ORIGIN=https://ci.poise.test',
      `POISE_GATEWAY_PUBLIC_KEY=${keys.publicKeyBase64}`,
      'POISE_HOST=0.0.0.0',
      'POISE_PORT=5555',
      'HOME=/home/poise',
      'POISE_DRAIN_TIMEOUT=30',
    ]))
    expect(workspace.HostConfig).toMatchObject({
      Init: true,
      SecurityOpt: ['no-new-privileges'],
      CapDrop: ['ALL'],
      Memory: 512 * 1024 ** 2,
      NanoCpus: 1_000_000_000,
      PidsLimit: 256,
      RestartPolicy: expect.objectContaining({ Name: 'unless-stopped' }),
      LogConfig: { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '5' } },
      NetworkMode: 'poise-net-ci',
    })
    expect(workspace.HostConfig.PortBindings ?? {}).toEqual({})
    expect(workspace.Mounts).toEqual([expect.objectContaining({ Type: 'volume', Name: 'poise-home-ci', Destination: '/home/poise' })])
    expect(gatewayNetworks()).toEqual(expect.arrayContaining(['poise-edge-ci', 'poise-net-ci']))
    expect(await ready(orchestrator)).toBe(true)
    expect(logs.filter((entry) => entry.level === 'error')).toEqual([])
  }, 120_000)

  it('drains it through a recreated gateway container before recreating it on a new image', async () => {
    // Every upgrade of the gateway recreates its container, which is then on none of the workspace networks.
    docker('rm', '--force', 'poise-gateway-ci')
    await startGateway()
    expect(gatewayNetworks()).toEqual(['poise-edge-ci'])
    const before = inspect('poise-ws-ci').Id
    const from = logs.length
    const restarted = gatewayProcess()
    await restarted.joinWorkspaceNetworks()
    expect(gatewayNetworks()).toEqual(expect.arrayContaining(['poise-edge-ci', 'poise-net-ci']))

    docker('tag', 'poise-runtime-ci:second', 'poise-runtime:ci')
    await restarted.upgradePass()
    const upgraded = inspect('poise-ws-ci')
    expect(upgraded.Id).not.toBe(before)
    expect(upgraded.Image).toBe(inspect('poise-runtime-ci:second').Id)
    expect(upgraded.State.Running).toBe(true)
    expect(upgraded.HostConfig.RestartPolicy).toMatchObject({ Name: 'unless-stopped' })
    expect(upgraded.Mounts).toEqual([expect.objectContaining({ Type: 'volume', Name: 'poise-home-ci', Destination: '/home/poise' })])
    // The drain reached the workspace, through the relay on the joined network, before anything stopped it.
    expect(eventsSince(from)).toEqual([
      'workspace.network.connected',
      'workspace.upgrade.started',
      'workspace.drain.requested',
      'workspace.container.stopped',
      'workspace.container.removed',
      'workspace.container.created',
      'workspace.container.started',
      'workspace.upgrade.finished',
    ])
    expect(await ready(restarted)).toBe(true)
    expect(logs.filter((entry) => entry.level !== 'info')).toEqual([])
  }, 120_000)

  it('leaves the workspace alone while nothing changes, and drains and recreates it for a new drain timeout', async () => {
    const before = inspect('poise-ws-ci').Id
    let from = logs.length
    await gatewayProcess().upgradePass()
    expect(inspect('poise-ws-ci').Id).toBe(before)
    expect(eventsSince(from)).toEqual([])

    from = logs.length
    await gatewayProcess({ POISE_DRAIN_TIMEOUT: '45' }).upgradePass()
    const recreated = inspect('poise-ws-ci')
    expect(recreated.Id).not.toBe(before)
    expect(recreated.State.Running).toBe(true)
    expect(recreated.Config.Env).toContain('POISE_DRAIN_TIMEOUT=45')
    expect(recreated.Config.Env).not.toContain('POISE_DRAIN_TIMEOUT=30')
    expect(eventsSince(from)).toEqual([
      'workspace.upgrade.started',
      'workspace.drain.requested',
      'workspace.container.stopped',
      'workspace.container.removed',
      'workspace.container.created',
      'workspace.container.started',
      'workspace.upgrade.finished',
    ])
    expect(logs[from]).toMatchObject({ event: 'workspace.upgrade.started', reason: 'changed drain timeout' })
    expect(logs.filter((entry) => entry.level !== 'info')).toEqual([])
  }, 120_000)
})
