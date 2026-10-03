import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { DockerClient } from '../src/docker.js'
import { loadOrCreateKeys } from '../src/keys.js'
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

describe.skipIf(!enabled)('workspaces on a real Docker Engine', () => {
  const removeAll = () => {
    spawnSync('docker', ['rm', '--force', 'poise-ws-ci', 'poise-gateway-ci'])
    spawnSync('docker', ['network', 'rm', 'poise-net-ci'])
    spawnSync('docker', ['volume', 'rm', 'poise-home-ci'])
  }
  let dir: string

  beforeAll(() => {
    removeAll()
    buildRuntimeStandIn('poise-runtime-ci:first', 'first')
    buildRuntimeStandIn('poise-runtime-ci:second', 'second')
    docker('tag', 'poise-runtime-ci:first', 'poise-runtime:ci')
    // Stands in for the gateway's own container, which joins every workspace network.
    docker('run', '--detach', '--name', 'poise-gateway-ci', 'poise-runtime-ci:first')
    dir = mkdtempSync(join(tmpdir(), 'gw-docker-'))
  }, 300_000)

  afterAll(() => {
    removeAll()
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates a workspace with the contract settings, reaches it, and recreates it on a new image', async () => {
    const config = loadConfig({
      POISE_DOMAIN: 'poise.test',
      POISE_GITHUB_CLIENT_ID: 'ci',
      POISE_GITHUB_CLIENT_SECRET: 'ci',
      POISE_ADMINS: 'root',
      POISE_RUNTIME_IMAGE: 'poise-runtime:ci',
      POISE_GATEWAY_CONTAINER: 'poise-gateway-ci',
      POISE_GATEWAY_DATA: dir,
      POISE_WORKSPACE_MEMORY: '512m',
      POISE_WORKSPACE_CPUS: '1',
      POISE_WORKSPACE_PIDS: '256',
    })
    const logs: Array<Record<string, unknown>> = []
    const log = createLogger((line) => logs.push(JSON.parse(line) as Record<string, unknown>))
    const store = new Store(join(dir, 'gateway.db'), Date.now)
    const keys = loadOrCreateKeys(dir, log)
    let address = ''
    const orchestrator = new Orchestrator({
      config, docker: new DockerClient(config.dockerSocket), store, keys, log, now: Date.now,
      upstream: () => ({ host: address, port: 5555 }), drainPollMs: 100,
    })

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
    ]))
    expect(workspace.HostConfig).toMatchObject({
      Init: true,
      SecurityOpt: ['no-new-privileges'],
      CapDrop: ['ALL'],
      Memory: 512 * 1024 ** 2,
      NanoCpus: 1_000_000_000,
      PidsLimit: 256,
      RestartPolicy: expect.objectContaining({ Name: 'unless-stopped' }),
      NetworkMode: 'poise-net-ci',
    })
    expect(workspace.HostConfig.PortBindings ?? {}).toEqual({})
    expect(workspace.Mounts).toEqual([expect.objectContaining({ Type: 'volume', Name: 'poise-home-ci', Destination: '/home/poise' })])
    expect(Object.keys(inspect('poise-gateway-ci').NetworkSettings.Networks)).toContain('poise-net-ci')

    address = workspace.NetworkSettings.Networks['poise-net-ci'].IPAddress
    let ready = false
    for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
      ready = (await orchestrator.readiness('ci', 'CI')).ready
      if (!ready) await delay(200)
    }
    expect(ready).toBe(true)

    docker('tag', 'poise-runtime-ci:second', 'poise-runtime:ci')
    await orchestrator.upgradePass()
    const upgraded = inspect('poise-ws-ci')
    expect(upgraded.Image).toBe(inspect('poise-runtime-ci:second').Id)
    expect(upgraded.State.Running).toBe(true)
    expect(upgraded.HostConfig.RestartPolicy).toMatchObject({ Name: 'unless-stopped' })
    expect(upgraded.Mounts).toEqual([expect.objectContaining({ Type: 'volume', Name: 'poise-home-ci', Destination: '/home/poise' })])
    expect(logs.map((entry) => entry.event)).toEqual(expect.arrayContaining([
      'workspace.drain.requested',
      'workspace.container.removed',
      'workspace.upgrade.finished',
    ]))
    expect(logs.filter((entry) => entry.level === 'error')).toEqual([])
    store.close()
  }, 120_000)
})
