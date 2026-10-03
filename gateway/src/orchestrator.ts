import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { signAssertion } from './assertion.js'
import type { Config } from './config.js'
import type { ContainerSpec, DockerClient } from './docker.js'
import type { GatewayKeys } from './keys.js'
import { errorMessage, type LogFields, type Logger } from './log.js'
import type { Store } from './store.js'

export const WORKSPACE_PORT = 5555
export const UPGRADE_INTERVAL_MS = 5 * 60_000

const SERVICE_TIMEOUT_MS = 5_000
const DRAIN_POLL_MS = 5_000
// A workspace lets a drain lapse unless it is renewed within five minutes; renew well inside that.
const DRAIN_RENEW_MS = 60_000

export interface Upstream {
  host: string
  port: number
}

export type UpstreamResolver = (handle: string) => Upstream

export function workspaceNames(handle: string): { volume: string; network: string; container: string } {
  return { volume: `poise-home-${handle}`, network: `poise-net-${handle}`, container: `poise-ws-${handle}` }
}

/** Where the gateway reaches a workspace: its container name on the network it shares with the gateway. */
export function workspaceUpstream(handle: string): Upstream {
  return { host: workspaceNames(handle).container, port: WORKSPACE_PORT }
}

export interface ServiceHealth {
  ok: boolean
  activeChatTurns: number
  runningCallerCalls: number
  backgroundWork: number
  /** True only when activeChatTurns, runningCallerCalls and backgroundWork are all 0. */
  idle: boolean
  draining: boolean
}

/** The workspace answered, but not with a usable 200. Unlike a refused connection, this is not a slow start. */
export class WorkspaceAnswerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceAnswerError'
  }
}

export type Readiness = { ready: true } | { ready: false; problem: string | null }

export interface OrchestratorDeps {
  config: Config
  docker: DockerClient
  store: Store
  keys: GatewayKeys
  log: Logger
  now: () => number
  upstream: UpstreamResolver
  drainPollMs?: number
  drainRenewMs?: number
}

function parseHealth(text: string, what: string): ServiceHealth {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new WorkspaceAnswerError(`the workspace answered ${what} with a body that is not JSON`)
  }
  const value = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {}
  if (
    typeof value.ok !== 'boolean'
    || typeof value.activeChatTurns !== 'number'
    || typeof value.runningCallerCalls !== 'number'
    || typeof value.backgroundWork !== 'number'
    || typeof value.idle !== 'boolean'
    || typeof value.draining !== 'boolean'
  ) {
    throw new WorkspaceAnswerError(
      `the workspace answered ${what} without ok, activeChatTurns, runningCallerCalls, backgroundWork, idle and draining`,
    )
  }
  return {
    ok: value.ok,
    activeChatTurns: value.activeChatTurns,
    runningCallerCalls: value.runningCallerCalls,
    backgroundWork: value.backgroundWork,
    idle: value.idle,
    draining: value.draining,
  }
}

function request(target: Upstream, method: string, path: string, headers: http.OutgoingHttpHeaders): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: target.host, port: target.port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.setTimeout(SERVICE_TIMEOUT_MS, () => req.destroy(new Error(`no answer within ${SERVICE_TIMEOUT_MS} ms`)))
    req.on('error', reject)
    req.end()
  })
}

/** Creates, starts, stops and upgrades workspace containers, and knows which ones answer. */
export class Orchestrator {
  private readonly ready = new Set<string>()
  private readonly starts = new Map<string, Promise<void>>()
  private readonly locks = new Map<string, Promise<void>>()
  private readonly drainPollMs: number
  private readonly drainRenewMs: number
  private upgrading = false

  constructor(private readonly deps: OrchestratorDeps) {
    this.drainPollMs = deps.drainPollMs ?? DRAIN_POLL_MS
    this.drainRenewMs = deps.drainRenewMs ?? DRAIN_RENEW_MS
  }

  containerSpec(handle: string, login: string): ContainerSpec {
    const { config, keys } = this.deps
    const { volume, network } = workspaceNames(handle)
    const scheme = config.insecureHttp ? 'http' : 'https'
    return {
      Image: config.runtimeImage,
      User: '10001',
      Env: [
        'POISE_MODE=service',
        `POISE_WORKSPACE_HANDLE=${handle}`,
        `POISE_WORKSPACE_OWNER=${login}`,
        `POISE_PUBLIC_ORIGIN=${scheme}://${handle}.${config.domain}`,
        `POISE_GATEWAY_PUBLIC_KEY=${keys.publicKeyBase64}`,
        'POISE_HOST=0.0.0.0',
        `POISE_PORT=${WORKSPACE_PORT}`,
        'HOME=/home/poise',
      ],
      Labels: { 'poise.managed': 'true', 'poise.workspace': handle },
      HostConfig: {
        Init: true,
        SecurityOpt: ['no-new-privileges'],
        CapDrop: ['ALL'],
        Memory: config.workspaceMemoryBytes,
        NanoCpus: config.workspaceNanoCpus,
        PidsLimit: config.workspacePids,
        RestartPolicy: { Name: 'unless-stopped' },
        ...(config.workspaceRuntime ? { Runtime: config.workspaceRuntime } : {}),
        Mounts: [{ Type: 'volume', Source: volume, Target: '/home/poise' }],
        NetworkMode: network,
      },
      NetworkingConfig: { EndpointsConfig: { [network]: {} } },
    }
  }

  markNotReady(handle: string): void {
    this.ready.delete(handle)
  }

  /** Whether the workspace answers its health check; a refused connection just means it is not up yet. */
  async readiness(handle: string, login: string): Promise<Readiness> {
    if (this.ready.has(handle)) return { ready: true }
    let health: ServiceHealth
    try {
      health = await this.serviceCall(handle, login, 'GET', '/api/service/health')
    } catch (error) {
      if (!(error instanceof WorkspaceAnswerError)) return { ready: false, problem: null }
      this.deps.log.warn('workspace.health.refused', { handle, error: error.message })
      return { ready: false, problem: error.message }
    }
    if (!health.ok) return { ready: false, problem: null }
    this.ready.add(handle)
    this.deps.log.info('workspace.ready', { handle })
    return { ready: true }
  }

  /** Starts the workspace unless a start is under way. A failure is logged and kept for the starting page. */
  startInBackground(handle: string, login: string): void {
    if (this.starts.has(handle)) return
    const start = this.ensureStarted(handle, login)
      .catch((error: unknown) => {
        this.deps.log.error('workspace.start.failed', { handle, error: errorMessage(error) })
        this.deps.store.noteWorkspaceError(handle, errorMessage(error))
      })
      .finally(() => this.starts.delete(handle))
    this.starts.set(handle, start)
  }

  /** The background start under way for this workspace, if any. */
  startInProgress(handle: string): Promise<void> | undefined {
    return this.starts.get(handle)
  }

  async ensureStarted(handle: string, login: string): Promise<void> {
    await this.withLock(handle, () => this.startLocked(handle, login))
  }

  async stop(handle: string): Promise<void> {
    await this.withLock(handle, async () => {
      const { container } = workspaceNames(handle)
      if (!(await this.deps.docker.inspectContainer(container))) throw new Error(`${container} does not exist`)
      this.ready.delete(handle)
      await this.deps.docker.stopContainer(container)
      this.lifecycle('workspace.container.stopped', handle, { reason: 'admin' })
    })
  }

  /** Stops the workspace of a disabled person, if it is running. */
  async stopForDisabled(handle: string): Promise<void> {
    await this.withLock(handle, async () => {
      const { container } = workspaceNames(handle)
      this.ready.delete(handle)
      if (!(await this.deps.docker.inspectContainer(container))?.State.Running) return
      await this.deps.docker.stopContainer(container)
      this.lifecycle('workspace.container.stopped', handle, { reason: 'disabled' })
    })
  }

  async restart(handle: string, login: string): Promise<void> {
    await this.withLock(handle, async () => {
      const { container } = workspaceNames(handle)
      const details = await this.deps.docker.inspectContainer(container)
      this.ready.delete(handle)
      if (!details?.State.Running) {
        await this.startLocked(handle, login)
        return
      }
      await this.deps.docker.restartContainer(container)
      this.lifecycle('workspace.container.restarted', handle, { reason: 'admin' })
    })
  }

  /** Runs an upgrade pass now and every five minutes. Returns a function that stops the loop. */
  startUpgradeLoop(intervalMs = UPGRADE_INTERVAL_MS): () => void {
    const run = () => {
      this.upgradePass().catch((error: unknown) => {
        this.deps.log.error('workspace.upgrade.pass.failed', { error: errorMessage(error) })
      })
    }
    run()
    const timer = setInterval(run, intervalMs)
    return () => clearInterval(timer)
  }

  /** Drains and recreates every managed container whose image differs from POISE_RUNTIME_IMAGE's current ID. */
  async upgradePass(): Promise<void> {
    if (this.upgrading) {
      this.deps.log.info('workspace.upgrade.pass.skipped', { reason: 'the previous pass is still running' })
      return
    }
    this.upgrading = true
    try {
      const { config, docker, log, store } = this.deps
      const imageId = await docker.imageId(config.runtimeImage)
      if (!imageId) {
        log.error('workspace.upgrade.image.missing', { image: config.runtimeImage })
        return
      }
      for (const summary of await docker.listManagedContainers()) {
        if (summary.ImageID === imageId) continue
        const handle = summary.Labels['poise.workspace'] ?? ''
        const login = store.getWorkspace(handle)?.login
        if (!login) {
          log.error('workspace.upgrade.skipped', { container: summary.Names[0], reason: 'no workspace record names its owner' })
          continue
        }
        try {
          await this.upgrade(handle, login, imageId)
        } catch (error) {
          log.error('workspace.upgrade.failed', { handle, error: errorMessage(error) })
          store.noteWorkspaceError(handle, `upgrade failed: ${errorMessage(error)}`)
        }
      }
    } finally {
      this.upgrading = false
    }
  }

  private async upgrade(handle: string, login: string, imageId: string): Promise<void> {
    this.lifecycle('workspace.upgrade.started', handle, { image: imageId })
    let drained = false
    for (;;) {
      // Decided under the lock, so a lazy start or an admin action in between cannot be stopped undrained.
      const outcome = await this.withLock(handle, async (): Promise<'needs-drain' | 'done' | 'skipped'> => {
        const { docker, store } = this.deps
        const { container } = workspaceNames(handle)
        const details = await docker.inspectContainer(container)
        if (!details) {
          this.lifecycle('workspace.upgrade.skipped', handle, { reason: 'the container no longer exists' })
          return 'skipped'
        }
        if (details.Image === imageId) {
          this.lifecycle('workspace.upgrade.skipped', handle, { reason: 'already on the current image' })
          return 'skipped'
        }
        const running = details.State.Running
        if (running && !drained) return 'needs-drain'
        this.ready.delete(handle)
        if (running) {
          await docker.stopContainer(container)
          this.lifecycle('workspace.container.stopped', handle, { reason: 'upgrade' })
        }
        await docker.removeContainer(container)
        this.lifecycle('workspace.container.removed', handle, { reason: 'upgrade' })
        await docker.createContainer(container, this.containerSpec(handle, login))
        this.lifecycle('workspace.container.created', handle, { image: this.deps.config.runtimeImage })
        if (running) {
          await docker.startContainer(container)
          store.noteWorkspaceStarted(handle)
          this.lifecycle('workspace.container.started', handle)
        }
        this.lifecycle('workspace.upgrade.finished', handle, { image: imageId })
        return 'done'
      })
      if (outcome !== 'needs-drain') return
      await this.drain(handle, login)
      drained = true
    }
  }

  /**
   * Asks the workspace to stop admitting work, then waits until it reports idle or POISE_DRAIN_TIMEOUT
   * passes. The workspace lets a drain lapse unless it is renewed, so it is re-requested while waiting.
   */
  private async drain(handle: string, login: string): Promise<void> {
    const { config, log, now } = this.deps
    const deadline = now() + config.drainTimeoutSeconds * 1000
    let requestedAt = now()
    try {
      const health = await this.serviceCall(handle, login, 'POST', '/api/service/drain')
      this.lifecycle('workspace.drain.requested', handle, {
        activeChatTurns: health.activeChatTurns,
        runningCallerCalls: health.runningCallerCalls,
        backgroundWork: health.backgroundWork,
      })
      if (health.idle) return
    } catch (error) {
      log.error('workspace.drain.request.failed', { handle, error: errorMessage(error) })
    }
    while (now() < deadline) {
      await delay(this.drainPollMs)
      const renew = now() - requestedAt >= this.drainRenewMs
      try {
        const health = renew
          ? await this.serviceCall(handle, login, 'POST', '/api/service/drain')
          : await this.serviceCall(handle, login, 'GET', '/api/service/health')
        if (renew) requestedAt = now()
        if (health.idle) {
          this.lifecycle('workspace.drain.idle', handle)
          return
        }
      } catch (error) {
        log.warn(renew ? 'workspace.drain.renew.failed' : 'workspace.drain.health.failed', { handle, error: errorMessage(error) })
      }
    }
    log.warn('workspace.drain.timeout', { handle, timeoutSeconds: config.drainTimeoutSeconds })
  }

  private async startLocked(handle: string, login: string): Promise<void> {
    const { config, docker, store } = this.deps
    const { container } = workspaceNames(handle)
    store.noteWorkspace(handle, login)
    await this.ensureVolumeAndNetwork(handle)
    let details = await docker.inspectContainer(container)
    if (details?.State.Running) return
    if (details && details.Image !== await this.currentImageId()) {
      // A stopped container on an old image has nothing to drain: recreate it before it starts.
      await docker.removeContainer(container)
      this.lifecycle('workspace.container.removed', handle, { reason: 'outdated image' })
      details = null
    }
    if (!details) {
      await docker.createContainer(container, this.containerSpec(handle, login))
      this.lifecycle('workspace.container.created', handle, { image: config.runtimeImage })
    }
    await docker.startContainer(container)
    store.noteWorkspaceStarted(handle)
    this.lifecycle('workspace.container.started', handle)
  }

  private async ensureVolumeAndNetwork(handle: string): Promise<void> {
    const { config, docker } = this.deps
    const { volume, network } = workspaceNames(handle)
    if (!(await docker.volumeExists(volume))) {
      await docker.createVolume(volume)
      this.lifecycle('workspace.volume.created', handle, { volume })
    }
    if (!(await docker.networkExists(network))) {
      await docker.createNetwork(network)
      this.lifecycle('workspace.network.created', handle, { network })
    }
    const gateway = await docker.inspectContainer(config.gatewayContainer)
    if (!gateway) {
      throw new Error(`the gateway container ${config.gatewayContainer} (POISE_GATEWAY_CONTAINER) does not exist`)
    }
    if (!(network in gateway.NetworkSettings.Networks)) {
      await docker.connectNetwork(network, config.gatewayContainer)
      this.lifecycle('workspace.network.connected', handle, { network, container: config.gatewayContainer })
    }
  }

  private async currentImageId(): Promise<string> {
    const id = await this.deps.docker.imageId(this.deps.config.runtimeImage)
    if (!id) {
      throw new Error(`the runtime image ${this.deps.config.runtimeImage} (POISE_RUNTIME_IMAGE) is not on this Docker host; build it first`)
    }
    return id
  }

  /** A call to the workspace's /api/service/* endpoints, carrying an admin-scope assertion. */
  private async serviceCall(handle: string, login: string, method: 'GET' | 'POST', path: string): Promise<ServiceHealth> {
    const { config, keys, now } = this.deps
    const publicHost = `${handle}.${config.domain}`
    const response = await request(this.deps.upstream(handle), method, path, {
      host: publicHost,
      'x-forwarded-host': publicHost,
      'x-forwarded-proto': config.insecureHttp ? 'http' : 'https',
      'x-poise-identity': signAssertion(keys.privateKey, { handle, login, scope: 'admin' }, now()),
      accept: 'application/json',
      ...(method === 'POST' ? { 'content-length': 0 } : {}),
    })
    if (response.status !== 200) {
      throw new WorkspaceAnswerError(`the workspace answered ${method} ${path} with HTTP ${response.status}`)
    }
    return parseHealth(response.text, `${method} ${path}`)
  }

  private async withLock<T>(handle: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(handle) ?? Promise.resolve()
    const result = previous.then(task)
    const tail = result.then(() => undefined, () => undefined)
    this.locks.set(handle, tail)
    try {
      return await result
    } finally {
      if (this.locks.get(handle) === tail) this.locks.delete(handle)
    }
  }

  private lifecycle(event: string, handle: string, fields: LogFields = {}): void {
    this.deps.log.info(event, { handle, ...fields })
  }
}
