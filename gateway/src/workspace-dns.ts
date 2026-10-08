import { chmod, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from './config.js'
import type { DockerClient } from './docker.js'

/** Where a workspace's C library looks for its resolvers. */
export const WORKSPACE_RESOLV_CONF = '/etc/resolv.conf'

const FILE_NAME = 'workspace-resolv.conf'

/** The resolver file for POISE_WORKSPACE_DNS. */
export function resolvConf(servers: readonly string[]): string {
  return [
    '# Written by the Poise gateway from POISE_WORKSPACE_DNS: Docker\'s embedded DNS at 127.0.0.11',
    '# is out of reach under gVisor, so workspaces ask these resolvers instead.',
    ...servers.map((server) => `nameserver ${server}`),
    'options edns0',
    '',
  ].join('\n')
}

/**
 * Writes the resolver file into the data directory and returns its path on the Docker host, which is the
 * path a workspace's bind mount names; null when POISE_WORKSPACE_DNS is unset.
 *
 * The Docker host knows the data directory by the source of the gateway container's mount there. When
 * Docker knows no container by the gateway's name, the gateway runs on the Docker host itself, and the
 * data directory already is that path.
 */
export async function prepareWorkspaceDns(config: Config, docker: DockerClient): Promise<string | null> {
  if (config.workspaceDns.length === 0) return null
  const path = join(config.dataDir, FILE_NAME)
  // Whole or not at all: a workspace started meanwhile must never mount half a file.
  await writeFile(`${path}.new`, resolvConf(config.workspaceDns))
  // Readable by the workspace user, whatever the gateway's umask.
  await chmod(`${path}.new`, 0o644)
  await rename(`${path}.new`, path)
  const self = await docker.inspectContainer(config.gatewayContainer)
  if (!self) return path
  const mount = self.Mounts?.find((candidate) => candidate.Destination === config.dataDir)
  if (!mount) {
    throw new Error(`POISE_WORKSPACE_DNS needs ${config.dataDir} (POISE_GATEWAY_DATA) to be a volume or bind mount of ${config.gatewayContainer}, so workspaces can mount the resolver file from it`)
  }
  return join(mount.Source, FILE_NAME)
}
