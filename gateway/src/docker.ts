import http from 'node:http'

export class DockerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'DockerError'
  }
}

export interface ContainerSummary {
  Id: string
  Names: string[]
  ImageID: string
  State: string
  Labels: Record<string, string>
}

export interface ContainerDetails {
  Id: string
  /** The image ID the container was created from. */
  Image: string
  /** Env is the image's environment with the container's own on top, as the container was created. */
  Config: { Env: string[] | null; Labels?: Record<string, string> | null }
  State: { Status: string; Running: boolean }
  NetworkSettings: { Networks: Record<string, unknown> }
  /** Volumes and bind mounts, each with its path on the Docker host (Source) and in the container. */
  Mounts?: Array<{ Type: string; Source: string; Destination: string }>
}

export type ContainerMount =
  | { Type: 'volume'; Source: string; Target: string }
  | { Type: 'bind'; Source: string; Target: string; ReadOnly: true }

export interface ContainerSpec {
  Image: string
  User: string
  Env: string[]
  Labels: Record<string, string>
  HostConfig: {
    Init: boolean
    SecurityOpt: string[]
    CapDrop: string[]
    Memory: number
    NanoCpus: number
    PidsLimit: number
    RestartPolicy: { Name: 'unless-stopped' }
    Runtime?: string
    Mounts: ContainerMount[]
    NetworkMode: string
  }
  NetworkingConfig: { EndpointsConfig: Record<string, Record<string, never>> }
}

/**
 * A short-lived container that runs one command and exits, such as installing a release into a workspace's
 * home volume (Orchestrator.installRelease). It carries no poise.managed label, so it is never taken for a
 * workspace.
 */
export interface TaskSpec {
  Image: string
  User: string
  Entrypoint: string[]
  Cmd: string[]
  Env: string[]
  Labels: Record<string, string>
  HostConfig: {
    SecurityOpt: string[]
    CapDrop: string[]
    Memory: number
    NanoCpus: number
    PidsLimit: number
    Runtime?: string
    Mounts: ContainerMount[]
    NetworkMode: 'none'
  }
}

const TIMEOUT_MS = 60_000
/** How long a task container may run before the gateway gives up waiting for it. */
const TASK_TIMEOUT_MS = 10 * 60_000
/** Sizing every volume reads every file in them. */
const DISK_USAGE_TIMEOUT_MS = 10 * 60_000

/**
 * The slice of the Docker Engine API the gateway needs, over the Engine's unix socket.
 * Paths are unversioned on purpose: Engine 24 tops out at API 1.43 while Engine 29
 * refuses anything below 1.44, and every field used here is the same in both.
 */
export class DockerClient {
  constructor(private readonly socketPath: string) {}

  async imageId(name: string): Promise<string | null> {
    const response = await this.call('GET', `/images/${encodeURI(name)}/json`, undefined, [404])
    return response.status === 404 ? null : (response.body as { Id: string }).Id
  }

  /** An image's labels, by name or ID; null when there is no such image. */
  async imageLabels(name: string): Promise<Record<string, string> | null> {
    const response = await this.call('GET', `/images/${encodeURI(name)}/json`, undefined, [404])
    if (response.status === 404) return null
    return (response.body as { Config?: { Labels?: Record<string, string> | null } | null }).Config?.Labels ?? {}
  }

  async inspectContainer(name: string): Promise<ContainerDetails | null> {
    const response = await this.call('GET', `/containers/${encodeURIComponent(name)}/json`, undefined, [404])
    return response.status === 404 ? null : response.body as ContainerDetails
  }

  async listManagedContainers(): Promise<ContainerSummary[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: ['poise.managed=true'] }))
    return (await this.call('GET', `/containers/json?all=true&filters=${filters}`)).body as ContainerSummary[]
  }

  /** Each volume's size in bytes, as Docker measures it; -1 for one it did not. Docker walks every volume. */
  async volumeSizes(): Promise<Map<string, number>> {
    const body = (await this.call('GET', '/system/df?type=volume', undefined, [], DISK_USAGE_TIMEOUT_MS)).body as {
      Volumes?: Array<{ Name: string; UsageData?: { Size?: number } | null }> | null
    }
    return new Map((body.Volumes ?? []).map((volume) => [volume.Name, volume.UsageData?.Size ?? -1]))
  }

  async volumeExists(name: string): Promise<boolean> {
    return (await this.call('GET', `/volumes/${encodeURIComponent(name)}`, undefined, [404])).status !== 404
  }

  async createVolume(name: string): Promise<void> {
    await this.call('POST', '/volumes/create', { Name: name })
  }

  async networkExists(name: string): Promise<boolean> {
    return (await this.call('GET', `/networks/${encodeURIComponent(name)}`, undefined, [404])).status !== 404
  }

  async createNetwork(name: string): Promise<void> {
    await this.call('POST', '/networks/create', { Name: name, Driver: 'bridge' })
  }

  async connectNetwork(network: string, container: string): Promise<void> {
    await this.call('POST', `/networks/${encodeURIComponent(network)}/connect`, { Container: container })
  }

  async createContainer(name: string, spec: ContainerSpec): Promise<void> {
    await this.call('POST', `/containers/create?name=${encodeURIComponent(name)}`, spec)
  }

  /** 304 means it was already running, which is what was asked for. */
  async startContainer(name: string): Promise<void> {
    await this.call('POST', `/containers/${encodeURIComponent(name)}/start`, undefined, [304])
  }

  /** 304 means it was already stopped, which is what was asked for. */
  async stopContainer(name: string): Promise<void> {
    await this.call('POST', `/containers/${encodeURIComponent(name)}/stop`, undefined, [304])
  }

  async restartContainer(name: string): Promise<void> {
    await this.call('POST', `/containers/${encodeURIComponent(name)}/restart`)
  }

  async removeContainer(name: string): Promise<void> {
    await this.call('DELETE', `/containers/${encodeURIComponent(name)}`)
  }

  /** Runs a task container to its end and removes it; resolves with its exit code. */
  async runTask(name: string, spec: TaskSpec): Promise<number> {
    await this.call('DELETE', `/containers/${encodeURIComponent(name)}?force=true`, undefined, [404])
    await this.call('POST', `/containers/create?name=${encodeURIComponent(name)}`, spec)
    try {
      await this.call('POST', `/containers/${encodeURIComponent(name)}/start`)
      const result = await this.call('POST', `/containers/${encodeURIComponent(name)}/wait`, undefined, [], TASK_TIMEOUT_MS)
      return Number((result.body as { StatusCode?: unknown }).StatusCode ?? -1)
    } finally {
      await this.call('DELETE', `/containers/${encodeURIComponent(name)}?force=true`, undefined, [404])
    }
  }

  private call(method: string, path: string, body?: unknown, accepted: number[] = [], timeoutMs = TIMEOUT_MS): Promise<{ status: number; body: unknown }> {
    const operation = `${method} ${path.split('?')[0]}`
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
      const req = http.request({
        socketPath: this.socketPath,
        method,
        path,
        headers: {
          host: 'docker',
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        },
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('error', reject)
        res.on('end', () => {
          const status = res.statusCode ?? 0
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed: unknown = text
          if (text && (res.headers['content-type'] ?? '').includes('json')) {
            try {
              parsed = JSON.parse(text)
            } catch {
              reject(new Error(`Docker Engine ${operation} answered HTTP ${status} with malformed JSON`))
              return
            }
          }
          if ((status >= 200 && status < 300) || accepted.includes(status)) {
            resolve({ status, body: parsed })
            return
          }
          const message = parsed !== null && typeof parsed === 'object' && 'message' in parsed
            ? String(parsed.message)
            : text.trim() || 'no details'
          reject(new DockerError(status, `Docker Engine ${operation} failed with HTTP ${status}: ${message}`))
        })
      })
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs / 1000} seconds`)))
      req.on('error', (error) => reject(new Error(`Docker Engine ${operation} at ${this.socketPath} failed: ${error.message}`)))
      req.end(payload)
    })
  }
}
