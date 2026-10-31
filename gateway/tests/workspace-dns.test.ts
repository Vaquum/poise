import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { DockerClient } from '../src/docker.js'
import { prepareWorkspaceDns, resolvConf } from '../src/workspace-dns.js'
import { startFakeDocker, type FakeDocker } from './fakes/docker.js'

describe('workspace resolvers', () => {
  let dir: string
  let dataDir: string
  let docker: FakeDocker

  const config = (dns?: string) => loadConfig({
    POISE_DOMAIN: 'poise.example.com',
    POISE_GITHUB_CLIENT_ID: 'id',
    POISE_GITHUB_CLIENT_SECRET: 'secret',
    POISE_ADMINS: 'root',
    POISE_RUNTIME_IMAGE: 'poise-runtime:latest',
    POISE_GATEWAY_CONTAINER: 'poise-gateway',
    POISE_GATEWAY_DATA: dataDir,
    POISE_DOCKER_SOCKET: docker.socketPath,
    POISE_WORKSPACE_DNS: dns,
  })
  const gatewayContainer = (mounts: Array<{ Type: string; Source: string; Target: string }>) => docker.addContainer({
    name: 'poise-gateway', imageId: 'sha256:gateway', imageRef: 'poise-gateway', running: true,
    labels: {}, networks: new Set(['bridge']), spec: { HostConfig: { Mounts: mounts } },
  })

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gw-dns-'))
    dataDir = join(dir, 'data')
    mkdirSync(dataDir)
    docker = await startFakeDocker(dir)
  })
  afterEach(async () => {
    await docker.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('names each resolver on its own nameserver line', () => {
    expect(resolvConf(['1.1.1.1', '2606:4700:4700::1111']).split('\n').filter((line) => !line.startsWith('#'))).toEqual([
      'nameserver 1.1.1.1',
      'nameserver 2606:4700:4700::1111',
      'options edns0',
      '',
    ])
  })

  it('writes nothing and mounts nothing unless POISE_WORKSPACE_DNS is set', async () => {
    expect(await prepareWorkspaceDns(config(), new DockerClient(docker.socketPath))).toBeNull()
    expect(docker.calls).toEqual([])
  })

  it('writes the file workspaces can read and finds it on the Docker host through the data directory mount', async () => {
    gatewayContainer([{ Type: 'volume', Source: '/var/lib/docker/volumes/poise-gateway-data/_data', Target: dataDir }])
    const path = await prepareWorkspaceDns(config('8.8.8.8 1.1.1.1'), new DockerClient(docker.socketPath))
    expect(path).toBe('/var/lib/docker/volumes/poise-gateway-data/_data/workspace-resolv.conf')
    const file = join(dataDir, 'workspace-resolv.conf')
    expect(readFileSync(file, 'utf8')).toBe(resolvConf(['8.8.8.8', '1.1.1.1']))
    expect(statSync(file).mode & 0o777).toBe(0o644)
  })

  it('uses the data directory itself when the gateway is no container Docker knows', async () => {
    expect(await prepareWorkspaceDns(config('1.1.1.1'), new DockerClient(docker.socketPath))).toBe(join(dataDir, 'workspace-resolv.conf'))
  })

  it('refuses a data directory the gateway container keeps only in its own layer', async () => {
    gatewayContainer([])
    await expect(prepareWorkspaceDns(config('1.1.1.1'), new DockerClient(docker.socketPath))).rejects.toThrow(
      /POISE_WORKSPACE_DNS needs .* \(POISE_GATEWAY_DATA\) to be a volume or bind mount of poise-gateway/,
    )
  })
})
