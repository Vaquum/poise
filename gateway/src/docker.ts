import { randomUUID } from 'node:crypto'
import { environmentSecrets, redact } from './diagnostics/redaction.mjs'
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

export const TASK_STDERR_LINE_LIMIT = 1000

export interface TaskFailureEvidence {
  id: string
  name: string
  container: string | null
  labels: Record<string, string>
  exitCode: number | null
  phase: 'installer_start' | 'installer_wait' | 'installer_exit'
  error: string | null
  stderr: Buffer | null
  stderrError: string | null
  limits: { memoryBytes: number; nanoCpus: number; pids: number }
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
    LogConfig: { Type: 'json-file'; Config: Record<string, string> }
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
  private reportingError: string | null = null
  get taskCaptureError(): string | null { return this.reportingError }
  constructor(private readonly socketPath: string, private readonly taskFailure?: (evidence: TaskFailureEvidence) => void, private readonly taskTimeoutMs = TASK_TIMEOUT_MS) {}

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

  /** Bounded diagnostics only; payload parsing is owned by the collector. */
  async diagnosticRead(path: string, maxBytes = 2 * 1024 * 1024, timeoutMs = 5000): Promise<Buffer> {
    if (!path.startsWith('/containers/') && !path.startsWith('/events?')) throw new Error('Unsupported Docker diagnostic operation')
    return new Promise((resolve, reject) => {
      const req = http.get({ socketPath: this.socketPath, path, headers: { host: 'docker' } }, (res) => {
        let size = 0
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > maxBytes) { req.destroy(new Error(`Docker diagnostic response exceeds ${maxBytes} bytes; collection gap`)); return }
          chunks.push(chunk)
        })
        res.on('error', reject)
        res.on('end', () => res.statusCode === 200 ? resolve(Buffer.concat(chunks))
          : reject(new Error(`Docker diagnostic source answered HTTP ${res.statusCode}`)))
      })
      const deadline = setTimeout(() => req.destroy(new Error(`Docker diagnostic read exceeded its absolute deadline after ${timeoutMs} ms`)), timeoutMs)
      req.once('close', () => clearTimeout(deadline))
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`Docker diagnostic read timed out after ${timeoutMs} ms`)))
      req.on('error', reject)
    })
  }

  async diagnosticContainers(): Promise<ContainerSummary[]> {
    const result = new Map<string, ContainerSummary>()
    for (const label of ['poise.managed=true', 'com.docker.compose.project=poise', 'poise.task=install-release']) {
      const filters = encodeURIComponent(JSON.stringify({ label: [label] }))
      const body = await this.diagnosticRead(`/containers/json?all=true&filters=${filters}`, 512 * 1024)
      for (const value of JSON.parse(body.toString()) as ContainerSummary[]) result.set(value.Id, value)
    }
    return [...result.values()]
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
    const created = await this.call('POST', `/containers/create?name=${encodeURIComponent(name)}`, spec)
    const native = created.body && typeof created.body === 'object' ? created.body as { Id?: unknown } : null
    const container = typeof native?.Id === 'string' ? native.Id : null
    let phase: TaskFailureEvidence['phase'] = 'installer_start'
    try {
      await this.call('POST', `/containers/${encodeURIComponent(name)}/start`)
      phase = 'installer_wait'
      const result = await this.call('POST', `/containers/${encodeURIComponent(name)}/wait`, undefined, [], this.taskTimeoutMs)
      const code = result.body && typeof result.body === 'object' ? (result.body as { StatusCode?: unknown }).StatusCode : null
      if (typeof code !== 'number' || !Number.isSafeInteger(code) || code < 0) throw new Error('Docker task wait returned no valid exit status')
      phase = 'installer_exit'
      if (code !== 0) await this.captureTaskFailure(name, spec, container, code, phase, null)
      return code
    } catch (error) {
      await this.captureTaskFailure(name, spec, container, null, phase, error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      await this.call('DELETE', `/containers/${encodeURIComponent(name)}?force=true`, undefined, [404])
    }
  }

  private async captureTaskFailure(name: string, spec: TaskSpec, container: string | null, exitCode: number | null, phase: TaskFailureEvidence['phase'], error: string | null): Promise<void> {
    if (!this.taskFailure) return
    let stderr: Buffer | null = null; let stderrError: string | null = null
    try { stderr = await this.diagnosticRead(`/containers/${encodeURIComponent(container ?? name)}/logs?stdout=0&stderr=1&timestamps=1&tail=all`, 64 * 1024, 250) }
    catch (failure) { stderrError = failure instanceof Error ? failure.message : String(failure) }
    try {
      this.taskFailure({ id: container ?? randomUUID(), name, container, labels: spec.Labels, exitCode, phase, error, stderr, stderrError,
        limits: { memoryBytes: spec.HostConfig.Memory, nanoCpus: spec.HostConfig.NanoCpus, pids: spec.HostConfig.PidsLimit } })
      this.reportingError = null
    } catch (failure) {
      // The collector exposes this through its independent health journal.
      this.reportingError = redact(failure instanceof Error ? failure.message : String(failure), environmentSecrets()).slice(0, 2048)
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
