import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { signAssertion } from './assertion.js'
import type { Config } from './config.js'
import type { ContainerDetails, ContainerMount, ContainerSpec, ContainerSummary, DockerClient, TaskSpec } from './docker.js'
import type { GatewayKeys } from './keys.js'
import { errorMessage, type LogFields, type Logger } from './log.js'
import type { Store } from './store.js'
import { WORKSPACE_RESOLV_CONF } from './workspace-dns.js'

export const WORKSPACE_PORT = 5555
export const UPGRADE_INTERVAL_MS = 5 * 60_000

const SERVICE_TIMEOUT_MS = 5_000
const DRAIN_POLL_MS = 5_000
/** Docker keeps a container's log without limit unless told; a workspace keeps five files of 20 MB, as the gateway does (deploy/compose.yaml). */
const WORKSPACE_LOG = { Type: 'json-file', Config: { 'max-size': '20m', 'max-file': '5' } } as const
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
  /** The release the workspace's supervisor runs; null for a workspace started without one. */
  release: string | null
  /** The release a pending switch restarts Poise onto; null when none is pending, or the workspace does not say. */
  switching: string | null
}

/** A runtime image's release and the base it runs on, from its labels (deploy/runtime/Dockerfile). */
export interface ImageRelease {
  release: string
  base: string
}

export function imageRelease(labels: Record<string, string> | null): ImageRelease | null {
  const release = labels?.['poise.release']
  const base = labels?.['poise.base']
  return release && base ? { release, base } : null
}

/** Where a release is installed from: the image's own copy, by deploy/runtime/install-release.sh. */
const INSTALL_RELEASE = '/opt/poise-runtime/install-release.sh'
/** How long a workspace asked to switch may stay unreachable before it counts as hung and gets a new container. */
const SWITCH_GRACE_MS = 10 * 60_000
/**
 * How long a replacement may take from stopping the old container until the new one answers health.
 * An initial operational bound: every finished replacement reports its measured `readyAfterMs`, which
 * tunes this. Past it the upgrade finishes anyway and demand-driven readiness recovers, so one slow
 * workspace never holds the serial pass longer than this.
 */
export const IDLE_TO_READY_MS = 120_000

/** The workspace answered, but not with a usable 200. Unlike a refused connection, this is not a slow start. */
export class WorkspaceAnswerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceAnswerError'
  }
}

/** The gateway could not join the workspace's network, so nothing it sends can reach the workspace. */
export class WorkspaceNetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceNetworkError'
  }
}

/** The workspace did not answer within the service timeout; alive but slow, not refused. */
export class ServiceTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ServiceTimeoutError'
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
  /** The resolver file's path on the Docker host, mounted over each workspace's /etc/resolv.conf; null for Docker's own. */
  workspaceResolvConf?: string | null
  drainPollMs?: number
  drainRenewMs?: number
  /** How long one service call waits for an answer; 5000 ms in production, shorter in tests. */
  serviceTimeoutMs?: number
  /** Stop-to-ready bound for a replacement; IDLE_TO_READY_MS in production, shorter in tests. */
  idleToReadyMs?: number
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
    release: typeof value.release === 'string' && value.release ? value.release : null,
    switching: typeof value.switching === 'string' && value.switching ? value.switching : null,
  }
}

/** A health or drain answer is a few hundred bytes; a workspace sending more is not read further. */
export const MAX_SERVICE_ANSWER_BYTES = 64 * 1024

function request(target: Upstream, method: string, path: string, headers: http.OutgoingHttpHeaders, timeoutMs: number, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: target.host, port: target.port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_SERVICE_ANSWER_BYTES) {
          req.destroy(new WorkspaceAnswerError(`the workspace answered ${method} ${path} with more than ${MAX_SERVICE_ANSWER_BYTES} bytes`))
          return
        }
        chunks.push(chunk)
      })
      res.on('error', (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      })
      res.on('end', () => {
        clearTimeout(timer)
        resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') })
      })
    })
    // An absolute deadline for the whole answer: a slow workspace that keeps sending bytes still times out.
    const timer = setTimeout(() => req.destroy(new ServiceTimeoutError(`no answer within ${timeoutMs} ms`)), timeoutMs)
    timer.unref?.()
    req.on('error', (error: unknown) => {
      clearTimeout(timer)
      reject(error)
    })
    req.end(body)
  })
}

/** Creates, starts, stops and upgrades workspace containers, and knows which ones answer. */
export class Orchestrator {
  private readonly ready = new Set<string>()
  /** Workspaces whose network this gateway process has seen itself on; see ensureOnNetwork. */
  private readonly joined = new Set<string>()
  private readonly starts = new Map<string, Promise<void>>()
  private readonly locks = new Map<string, Promise<void>>()
  private readonly drainPollMs: number
  private readonly drainRenewMs: number
  private readonly serviceTimeoutMs: number
  private readonly idleToReadyMs: number
  private upgrading = false
  /** The workspace and phase a running pass waits on, so a skipped pass can say so. */
  private upgradingHandle: string | null = null
  private upgradingPhase: string | null = null
  /** The release each workspace was asked to switch to, and when, until it runs it; see updateInPlace. */
  private readonly updating = new Map<string, { release: string; since: number }>()
  /** When each workspace's probes for its target release started missing in a row; see updateInPlace. */
  private readonly unreachableSince = new Map<string, { release: string; since: number }>()
  /** The release last installed into each workspace's home volume. */
  private readonly installed = new Map<string, string>()
  /** A release a workspace refused because it failed to start there, so it is not asked for again. */
  private readonly refused = new Map<string, string>()
  /** The release a stuck-switch warning was logged for, so it warns once per release, not per pass. */
  private readonly stuckWarned = new Map<string, string>()

  constructor(private readonly deps: OrchestratorDeps) {
    this.drainPollMs = deps.drainPollMs ?? DRAIN_POLL_MS
    this.drainRenewMs = deps.drainRenewMs ?? DRAIN_RENEW_MS
    this.serviceTimeoutMs = deps.serviceTimeoutMs ?? SERVICE_TIMEOUT_MS
    this.idleToReadyMs = deps.idleToReadyMs ?? IDLE_TO_READY_MS
  }

  containerSpec(handle: string, login: string): ContainerSpec {
    const { config, keys, workspaceResolvConf } = this.deps
    const { volume, network } = workspaceNames(handle)
    const scheme = config.insecureHttp ? 'http' : 'https'
    const mounts: ContainerMount[] = [{ Type: 'volume', Source: volume, Target: '/home/poise' }]
    if (workspaceResolvConf) {
      mounts.push({ Type: 'bind', Source: workspaceResolvConf, Target: WORKSPACE_RESOLV_CONF, ReadOnly: true })
    }
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
        this.drainTimeoutEnv(),
        ...(config.workspaceSkipCliBootstrap ? ['POISE_SKIP_CLI_BOOTSTRAP=1'] : []),
      ],
      Labels: {
        'poise.managed': 'true',
        'poise.workspace': handle,
        ...(workspaceResolvConf ? { 'poise.dns': this.dnsLabel() } : {}),
      },
      HostConfig: {
        Init: true,
        SecurityOpt: ['no-new-privileges'],
        CapDrop: ['ALL'],
        Memory: config.workspaceMemoryBytes,
        NanoCpus: config.workspaceNanoCpus,
        PidsLimit: config.workspacePids,
        RestartPolicy: { Name: 'unless-stopped' },
        LogConfig: { Type: WORKSPACE_LOG.Type, Config: { ...WORKSPACE_LOG.Config } },
        ...(config.workspaceRuntime ? { Runtime: config.workspaceRuntime } : {}),
        Mounts: mounts,
        NetworkMode: network,
      },
      NetworkingConfig: { EndpointsConfig: { [network]: {} } },
    }
  }

  markNotReady(handle: string): void {
    this.ready.delete(handle)
  }

  /** The release a workspace is switching to, while it restarts onto it; null otherwise. */
  updatingTo(handle: string): string | null {
    return this.updating.get(handle)?.release ?? null
  }

  /** Whether the workspace answers its health check; a refused connection just means it is not up yet. */
  async readiness(handle: string, login: string): Promise<Readiness> {
    let health: ServiceHealth
    try {
      if (this.ready.has(handle)) {
        // Proxied requests ask this first, so a network the gateway lost is joined again before them too.
        await this.ensureOnNetwork(handle)
        return { ready: true }
      }
      health = await this.serviceCall(handle, login, 'GET', '/api/service/health')
    } catch (error) {
      if (error instanceof WorkspaceNetworkError) {
        this.deps.log.error('workspace.network.join.failed', { handle, error: error.message })
        return { ready: false, problem: error.message }
      }
      if (!(error instanceof WorkspaceAnswerError)) return { ready: false, problem: null }
      this.deps.log.warn('workspace.health.refused', { handle, error: error.message })
      return { ready: false, problem: error.message }
    }
    if (!health.ok) return { ready: false, problem: null }
    if (health.release !== null && this.updating.get(handle)?.release === health.release) {
      this.updating.delete(handle)
      this.lifecycle('workspace.update.finished', handle, { release: health.release })
    }
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
        // A throw here would be an unhandled rejection, which stops the gateway for everyone.
        try {
          this.deps.store.noteWorkspaceError(handle, errorMessage(error))
        } catch (failure) {
          this.deps.log.error('workspace.start.failure.unrecorded', { handle, error: errorMessage(failure) })
        }
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

  /**
   * Joins the network of every managed workspace, running or stopped. The gateway runs this before it
   * answers a request or runs an upgrade pass: a recreated gateway container, as every upgrade makes, is on
   * none of the networks the one it replaced had joined, and could not reach a running workspace to drain it.
   */
  async joinWorkspaceNetworks(): Promise<void> {
    const { docker, log } = this.deps
    let containers: ContainerSummary[]
    try {
      containers = await docker.listManagedContainers()
    } catch (error) {
      log.error('workspace.network.join.failed', { error: errorMessage(error) })
      return
    }
    for (const summary of containers) {
      const handle = summary.Labels['poise.workspace'] ?? ''
      try {
        if (!handle) throw new Error('it has no poise.workspace label')
        await this.ensureOnNetwork(handle)
      } catch (error) {
        log.error('workspace.network.join.failed', { container: summary.Names[0], error: errorMessage(error) })
      }
    }
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

  /**
   * Drains and recreates every managed container that differs from the one the gateway would create now: its
   * image is not POISE_RUNTIME_IMAGE's current ID, or it was created with another POISE_DRAIN_TIMEOUT.
   */
  async upgradePass(): Promise<void> {
    if (this.upgrading) {
      this.deps.log.info('workspace.upgrade.pass.skipped', {
        reason: 'the previous pass is still running',
        ...(this.upgradingHandle ? { handle: this.upgradingHandle, phase: this.upgradingPhase ?? 'upgrade' } : {}),
      })
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
      const target = imageRelease(await docker.imageLabels(config.runtimeImage))
      for (const summary of await docker.listManagedContainers()) {
        // The list shows a container's image but not its environment, which holds its drain timeout.
        const details = await docker.inspectContainer(summary.Id)
        const reason = details && this.outdated(details, imageId)
        if (!reason) {
          // A container of the current image whose volume still named an older release when it started runs
          // that one; it switches like any other.
          if (details?.State.Running && target) await this.correctRelease(summary, target)
          continue
        }
        const handle = summary.Labels['poise.workspace'] ?? ''
        const login = store.getWorkspace(handle)?.login
        if (!login) {
          log.error('workspace.upgrade.skipped', { container: summary.Names[0], reason: 'no workspace record names its owner' })
          continue
        }
        try {
          // A running workspace on the same base takes a new release in place: only Poise restarts, and the
          // agents it started keep running. Anything else needs a new container.
          if (reason === 'outdated image' && details.State.Running && target && this.changedSetting(details) === null
            && imageRelease(await docker.imageLabels(details.Image))?.base === target.base
            && await this.updateInPlace(handle, login, target)) continue
          await this.upgrade(handle, login, imageId, reason, target)
        } catch (error) {
          log.error('workspace.upgrade.failed', { handle, error: errorMessage(error) })
          store.noteWorkspaceError(handle, `upgrade failed: ${errorMessage(error)}`)
        }
      }
    } finally {
      this.upgrading = false
    }
  }

  /**
   * Installs the target release into the workspace's home volume and asks Poise to switch to it, which it
   * does once no Chat turn and no work of its own runs; detached agent calls carry on. Asked again on later
   * passes until the workspace runs it, since the request is idempotent. False when the workspace runs
   * without a release supervisor and needs a new container instead.
   */
  private async updateInPlace(handle: string, login: string, target: ImageRelease): Promise<boolean> {
    let health: ServiceHealth
    try {
      health = await this.serviceCall(handle, login, 'GET', '/api/service/health')
    } catch (error) {
      if (error instanceof WorkspaceNetworkError) throw error
      // A workspace that stays unreachable cannot take the switch and gets a new container, as before
      // releases switched in place. One missed probe is a transient stall, though, not a hung
      // workspace — even long after the switch was asked for, while Poise still waits for a quiet
      // moment — so until the grace passes a later pass asks again instead of starting a drain.
      if (this.withinUnreachableGrace(handle, target.release)) return true
      this.deps.log.warn('workspace.update.unreachable', { handle, error: errorMessage(error) })
      return false
    }
    this.unreachableSince.delete(handle)
    if (health.release === null) return false
    if (health.release === target.release) {
      await this.withdrawSwitch(handle, login, health, target)
      this.updating.delete(handle)
      this.stuckWarned.delete(handle)
      return true
    }
    if (this.refused.get(handle) === target.release) return true
    if (!health.idle) {
      // Legitimate waiting: the switch fires at a quiet moment, and busy work is not stuck.
      this.lifecycle('workspace.update.waiting', handle, {
        release: target.release,
        running: health.release,
        activeChatTurns: health.activeChatTurns,
        runningCallerCalls: health.runningCallerCalls,
        backgroundWork: health.backgroundWork,
      })
    } else {
      const pending = this.updating.get(handle)
      // A switch takes seconds once idle; one still pending past the grace is stuck, not waiting.
      // The gateway keeps asking — recreating would cut work it cannot see — but says so, once.
      if (pending?.release === target.release && this.deps.now() - pending.since >= SWITCH_GRACE_MS
        && this.stuckWarned.get(handle) !== target.release) {
        this.stuckWarned.set(handle, target.release)
        this.deps.log.warn('workspace.update.stuck', {
          handle,
          release: target.release,
          running: health.release,
          elapsedMs: this.deps.now() - pending.since,
        })
      }
    }
    if (this.installed.get(handle) !== target.release) {
      await this.installRelease(handle, false)
      this.installed.set(handle, target.release)
    }
    const answer = await this.requestSwitch(handle, login, target.release)
    if (answer === 'failed') {
      // The release failed to start there before; the workspace keeps the one it runs until a newer image.
      this.refused.set(handle, target.release)
      this.updating.delete(handle)
      this.deps.log.error('workspace.update.refused', { handle, release: target.release, running: health.release })
      this.deps.store.noteWorkspaceError(handle, `release ${target.release} failed to start; staying on ${health.release}`)
      return true
    }
    if (this.updating.get(handle)?.release !== target.release) {
      this.updating.set(handle, { release: target.release, since: this.deps.now() })
      this.lifecycle('workspace.update.requested', handle, { release: target.release, from: health.release })
    }
    return true
  }

  /**
   * Whether a workspace that did not answer a probe stays on the in-place path: the first miss in a
   * row for this release starts the switch grace, which answering again clears, and only a workspace
   * unreachable past the grace takes the drain path. A miss belongs to its release: a workspace that
   * left the in-place path before answering again starts a fresh grace for the next one.
   */
  private withinUnreachableGrace(handle: string, release: string): boolean {
    const missed = this.unreachableSince.get(handle)
    if (missed?.release !== release) {
      this.unreachableSince.set(handle, { release, since: this.deps.now() })
      return true
    }
    if (this.deps.now() - missed.since < SWITCH_GRACE_MS) return true
    this.unreachableSince.delete(handle)
    return false
  }

  /**
   * A workspace that runs the target release but still waits to switch to another, asked for before the
   * target changed back, is asked for the release it runs, which calls the pending switch off.
   */
  private async withdrawSwitch(handle: string, login: string, health: ServiceHealth, target: ImageRelease): Promise<void> {
    if (health.switching === null || health.switching === target.release) return
    await this.requestSwitch(handle, login, target.release)
    this.lifecycle('workspace.update.withdrawn', handle, { release: health.switching, running: target.release })
  }

  /** Switches a running workspace on the current image that runs another release than the image's. */
  private async correctRelease(summary: ContainerSummary, target: ImageRelease): Promise<void> {
    const handle = summary.Labels['poise.workspace'] ?? ''
    const login = this.deps.store.getWorkspace(handle)?.login
    if (!handle || !login) return
    try {
      const health = await this.serviceCall(handle, login, 'GET', '/api/service/health')
      if (health.release !== null && health.release !== target.release) await this.updateInPlace(handle, login, target)
      else if (health.release === target.release) {
        await this.withdrawSwitch(handle, login, health, target)
        this.updating.delete(handle)
      }
    } catch (error) {
      this.deps.log.warn('workspace.update.check.failed', { handle, error: errorMessage(error) })
    }
  }

  /**
   * Installs the runtime image's release into a workspace's home volume, in a short-lived container of that
   * image; with `activate`, also makes it the release the workspace's next start runs.
   */
  private async installRelease(handle: string, activate: boolean): Promise<void> {
    const { config, docker } = this.deps
    const { volume } = workspaceNames(handle)
    const spec: TaskSpec = {
      Image: config.runtimeImage,
      User: '10001',
      Entrypoint: [INSTALL_RELEASE],
      Cmd: activate ? ['--activate'] : [],
      Env: ['HOME=/home/poise'],
      Labels: { 'poise.task': 'install-release', 'poise.workspace': handle },
      HostConfig: {
        SecurityOpt: ['no-new-privileges'],
        CapDrop: ['ALL'],
        Memory: 1024 ** 3,
        NanoCpus: 2e9,
        PidsLimit: 256,
        ...(config.workspaceRuntime ? { Runtime: config.workspaceRuntime } : {}),
        Mounts: [{ Type: 'volume', Source: volume, Target: '/home/poise' }],
        NetworkMode: 'none',
      },
    }
    const code = await docker.runTask(`poise-release-${handle}`, spec)
    if (code !== 0) throw new Error(`installing the release of ${config.runtimeImage} into ${volume} exited with ${code}`)
    this.lifecycle('workspace.release.installed', handle, { image: config.runtimeImage, activate })
  }

  /** Before a workspace gets a new container: the new image's release becomes the one it starts. */
  private async activateRelease(handle: string, target: ImageRelease | null): Promise<void> {
    if (!target) return
    try {
      await this.installRelease(handle, true)
      this.installed.set(handle, target.release)
    } catch (error) {
      // The container then starts its image's own release, or an installed one the next pass corrects.
      this.deps.log.warn('workspace.release.activate.failed', { handle, error: errorMessage(error) })
    }
  }

  /**
   * One service request with retries for a slow workspace: a timeout is retried twice with backoff,
   * a refused connection or a usable answer is not. Retries are bounded and few, so one poll still
   * ends near the service timeout.
   */
  private async serviceRequest(target: Upstream, method: string, path: string, headers: http.OutgoingHttpHeaders, body?: string): Promise<{ status: number; text: string }> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await request(target, method, path, headers, this.serviceTimeoutMs, body)
      } catch (error) {
        if (!(error instanceof ServiceTimeoutError) || attempt >= 2) throw error
        await delay(50 * (attempt + 1))
      }
    }
  }

  /** 'failed' when the workspace refuses a release that failed to start there. */
  private async requestSwitch(handle: string, login: string, release: string): Promise<'switching' | 'failed'> {
    await this.ensureOnNetwork(handle)
    const { config, keys, now } = this.deps
    const publicHost = `${handle}.${config.domain}`
    const body = JSON.stringify({ release })
    const response = await this.serviceRequest(this.deps.upstream(handle), 'POST', '/api/service/switch', {
      host: publicHost,
      'x-forwarded-host': publicHost,
      'x-forwarded-proto': config.insecureHttp ? 'http' : 'https',
      'x-poise-identity': signAssertion(keys.privateKey, { handle, login, scope: 'admin' }, now()),
      accept: 'application/json',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    }, body)
    if (response.status === 409 && response.text.includes('failed to start')) return 'failed'
    if (response.status !== 202) {
      throw new WorkspaceAnswerError(`the workspace answered POST /api/service/switch with HTTP ${response.status}: ${response.text.slice(0, 300)}`)
    }
    return 'switching'
  }

  private async upgrade(handle: string, login: string, imageId: string, reason: string, target: ImageRelease | null): Promise<void> {
    this.lifecycle('workspace.upgrade.started', handle, { image: imageId, reason })
    // One budget for the whole workspace operation: every drain, recheck and re-drain shares it.
    const deadline = this.deps.now() + this.deps.config.drainTimeoutSeconds * 1000
    this.upgradingHandle = handle
    this.upgradingPhase = 'upgrade'
    // null until drained; then whether the drain left the workspace idle rather than timing out.
    let drainedIdle: boolean | null = null
    let drainAttempted = false
    let confirmedBusy = false
    let admitted = false
    let sawDown = false
    let lastCounts: { activeChatTurns: number; runningCallerCalls: number; backgroundWork: number } | null = null
    let recreated = false
    // Whether a drain POST left the gateway, visible even when drain() throws before returning.
    const dispatched = { value: false }
    const abortUnknown = async (): Promise<void> => {
      const reason = 'the drain timed out without confirmed admission and idleness'
      await this.releaseDrain(handle, login, reason)
      // A failed admission is a deferred update, not routine: it warns so the owner can see it.
      this.deps.log.warn('workspace.upgrade.aborted', { handle, reason,
        activeChatTurns: lastCounts?.activeChatTurns ?? null,
        runningCallerCalls: lastCounts?.runningCallerCalls ?? null,
        backgroundWork: lastCounts?.backgroundWork ?? null })
    }
    try {
      for (;;) {
        // Decided under the lock, so a lazy start or an admin action in between cannot be stopped undrained.
        const outcome = await this.withLock(handle, async (): Promise<'needs-drain' | 'done' | 'skipped' | 'abort-unknown'> => {
          const { docker, store } = this.deps
          const { container } = workspaceNames(handle)
          const details = await docker.inspectContainer(container)
          if (!details) {
            this.lifecycle('workspace.upgrade.skipped', handle, { reason: 'the container no longer exists' })
            return 'skipped'
          }
          if (!this.outdated(details, imageId)) {
            this.lifecycle('workspace.upgrade.skipped', handle, { reason: 'already up to date' })
            return 'skipped'
          }
          const running = details.State.Running
          if (running && drainedIdle === null) return 'needs-drain'
          await this.activateRelease(handle, target)
          // Activation can restart Poise: a switch queued before the drain fires once the drain leaves it
          // idle, and the Poise it starts holds no drain. So drain again, and stop only a workspace still
          // idle. A drain that timed out on confirmed busy work cuts it anyway; one that only timed out
          // or was never admitted aborts instead of recreating a slow workspace blind. A workspace that
          // reaches nothing is down and still gets a new container; one that answers unusably does not.
          if (running && drainedIdle) {
            this.upgradingPhase = 'recheck'
            const recheck = await this.idleUnderDrain(handle, login)
            this.upgradingPhase = 'upgrade'
            if (!recheck.idle) {
              if (recheck.unknown) {
                if (recheck.down) sawDown = true
                if (this.deps.now() >= deadline) {
                  if (!recheck.down) return 'abort-unknown'
                  drainedIdle = false
                } else return 'needs-drain'
              } else {
                confirmedBusy = true
                if (this.deps.now() >= deadline) drainedIdle = false
                else return 'needs-drain'
              }
            }
          }
          this.ready.delete(handle)
          let stoppedAt = 0
          if (running) {
            await docker.stopContainer(container)
            stoppedAt = this.deps.now()
            this.lifecycle('workspace.container.stopped', handle, { reason: 'upgrade' })
          }
          await docker.removeContainer(container)
          this.lifecycle('workspace.container.removed', handle, { reason: 'upgrade' })
          await docker.createContainer(container, this.containerSpec(handle, login))
          this.lifecycle('workspace.container.created', handle, { image: this.deps.config.runtimeImage })
          // Past this point the old container is gone: a later failure must not release a drain
          // that died with it, and the next pass sees the new container.
          recreated = true
          let readyAfterMs: number | null = null
          if (running) {
            await docker.startContainer(container)
            store.noteWorkspaceStarted(handle)
            this.lifecycle('workspace.container.started', handle)
            this.upgradingPhase = 'ready'
            readyAfterMs = await this.awaitReplacementReady(handle, login, stoppedAt)
            this.upgradingPhase = 'upgrade'
          }
          this.lifecycle('workspace.upgrade.finished', handle,
            readyAfterMs === null ? { image: imageId } : { image: imageId, readyAfterMs })
          return 'done'
        })
        if (outcome === 'done') return
        if (outcome === 'skipped') {
          if (drainAttempted && !recreated) await this.releaseDrain(handle, login, 'the upgrade was skipped after a drain')
          return
        }
        if (outcome === 'abort-unknown') {
          await abortUnknown()
          return
        }
        if (this.deps.now() >= deadline) {
          // Busy work is cut only behind an admitted drain; without admission nothing confirmed the
          // workspace even saw the drain, so the pass aborts and the next one tries again.
          if ((confirmedBusy && admitted) || sawDown) {
            drainedIdle = false
            continue
          }
          await abortUnknown()
          return
        }
        this.upgradingPhase = 'drain'
        const result = await this.drain(handle, login, deadline, dispatched)
        this.upgradingPhase = 'upgrade'
        drainAttempted = drainAttempted || result.attempted
        confirmedBusy = confirmedBusy || result.confirmedBusy
        admitted = admitted || result.admitted
        if (!result.idle) sawDown = sawDown || result.sawDown
        lastCounts = result.lastCounts ?? lastCounts
        if (result.idle) {
          admitted = true
          drainedIdle = true
        } else if ((confirmedBusy && admitted) || sawDown) {
          drainedIdle = false
        } else {
          await abortUnknown()
          return
        }
      }
    } catch (error) {
      drainAttempted = drainAttempted || dispatched.value
      if (drainAttempted && !recreated) await this.releaseDrain(handle, login, 'the upgrade failed')
      throw error
    } finally {
      this.upgradingHandle = null
      this.upgradingPhase = null
    }
  }

  /** Drains again and says whether the workspace is idle; unknown when it cannot tell. */
  private async idleUnderDrain(handle: string, login: string): Promise<{ idle: boolean; unknown: boolean; down: boolean }> {
    try {
      const health = await this.serviceCall(handle, login, 'POST', '/api/service/drain')
      // The recheck guards the stop: only an authoritative idle answer lets it proceed. Whether the
      // drain still shows is irrelevant to safety — stopping an idle workspace cuts nothing.
      return { idle: health.ok && health.idle, unknown: false, down: false }
    } catch (error) {
      if (error instanceof WorkspaceNetworkError) throw error
      this.deps.log.warn('workspace.drain.recheck.failed', { handle, error: errorMessage(error) })
      return { idle: false, unknown: true, down: !(error instanceof ServiceTimeoutError) && !(error instanceof WorkspaceAnswerError) }
    }
  }

  /**
   * Waits for a replaced workspace to answer health, so `workspace.upgrade.finished` means the new
   * container serves, not just that Docker started it. Returns stop-to-ready milliseconds, or null
   * past the idle-to-ready bound; a miss warns with the last answer and finishes anyway, since
   * demand-driven readiness still recovers. A refusal is the new container answering broken, not
   * starting, and fails the wait at once; silence is waited out.
   */
  private async awaitReplacementReady(handle: string, login: string, stoppedAt: number): Promise<number | null> {
    const miss = (error: string | null): null => {
      this.deps.log.warn('workspace.upgrade.ready.missed', { handle, boundMs: this.idleToReadyMs,
        elapsedMs: this.deps.now() - stoppedAt, ...(error === null ? {} : { error }) })
      return null
    }
    for (;;) {
      try {
        const health = await this.serviceCall(handle, login, 'GET', '/api/service/health')
        if (health.ok) return this.deps.now() - stoppedAt
        return miss('the replacement answered health with ok: false')
      } catch (error) {
        if (error instanceof WorkspaceNetworkError) throw error
        if (error instanceof WorkspaceAnswerError) return miss(errorMessage(error))
        if (this.deps.now() - stoppedAt >= this.idleToReadyMs) return miss(errorMessage(error))
        await delay(this.drainPollMs)
      }
    }
  }

  /** Lifts a drain the gateway attempted but did not recreate past; best effort, the lapse is the backstop. */
  private async releaseDrain(handle: string, login: string, reason: string): Promise<void> {
    try {
      await this.serviceCall(handle, login, 'POST', '/api/service/resume')
      this.lifecycle('workspace.drain.released', handle, { reason })
    } catch (error) {
      this.deps.log.warn('workspace.drain.release.failed', { handle, reason, error: errorMessage(error) })
    }
  }

  /**
   * Asks the workspace to stop admitting work, then waits until it reports idle or the shared deadline
   * passes. The workspace lets a drain lapse unless it is renewed, so it is re-requested while waiting.
   * A network the gateway cannot join fails the upgrade instead: waiting would drain nothing, and the
   * timeout would then recreate the workspace with its work cut off. A drain POST counts as dispatched
   * once the gateway is on the network to send it, recorded where the caller sees it even when a later
   * poll throws, since a failed answer may still have been applied. Only an admitted drain — one whose
   * answer showed it on — can finish idle: without admission new work stays unblocked, so an idle answer
   * alone never recreates the workspace.
   */
  private async drain(handle: string, login: string, deadline: number, dispatched: { value: boolean }): Promise<{
    idle: boolean; attempted: boolean; confirmedBusy: boolean; admitted: boolean; sawDown: boolean;
    lastCounts: { activeChatTurns: number; runningCallerCalls: number; backgroundWork: number } | null
  }> {
    const { config, log, now } = this.deps
    const start = now()
    let requestedAt = now()
    let confirmedBusy = false
    let admitted = false
    let sawDown = false
    let sawDraining = false
    const lastCounts: { counts: { activeChatTurns: number; runningCallerCalls: number; backgroundWork: number } | null } = { counts: null }
    const done = (idle: boolean) => ({ idle, attempted: dispatched.value, confirmedBusy, admitted, sawDown, lastCounts: lastCounts.counts })
    const waiting = (health: ServiceHealth): void => {
      log.info('workspace.drain.waiting', {
        handle,
        activeChatTurns: health.activeChatTurns,
        runningCallerCalls: health.runningCallerCalls,
        backgroundWork: health.backgroundWork,
        elapsedSeconds: Math.round((now() - start) / 1000),
        remainingSeconds: Math.max(0, Math.round((deadline - now()) / 1000)),
      })
    }
    const counts = (health: ServiceHealth) => ({
      activeChatTurns: health.activeChatTurns,
      runningCallerCalls: health.runningCallerCalls,
      backgroundWork: health.backgroundWork,
    })
    const note = (health: ServiceHealth): void => {
      // A drain the gateway saw on is gone while the workspace still isn't idle: the owner or admin
      // resumed, the drain lapsed, or Poise restarted. An answer that never showed a drain is not a lift.
      if (health.draining) {
        sawDraining = true
        admitted = true
      } else if (sawDraining && !health.idle) log.warn('workspace.drain.lifted', { handle })
      if (!health.idle) confirmedBusy = true
      lastCounts.counts = counts(health)
    }
    // A drain answer that does not show the drain on: the workspace never confirmed admission, so the
    // pass keeps waiting for one instead of treating the answer as a successful drain.
    const unconfirmed = (health: ServiceHealth): void => {
      note(health)
      log.warn('workspace.drain.unconfirmed', { handle, ok: health.ok, draining: health.draining, ...counts(health) })
    }
    const failed = (error: unknown): void => {
      // A timeout or an unusable answer leaves the workspace's state unknown; reaching nothing means
      // it is down. Only a down workspace is recreated without ever confirming busy work.
      if (!(error instanceof ServiceTimeoutError) && !(error instanceof WorkspaceAnswerError)) sawDown = true
    }
    // Fail before anything is sent when the gateway is off the network, so only a POST that left
    // the gateway counts towards releasing the drain on failure.
    const postDrain = async (): Promise<ServiceHealth> => {
      await this.ensureOnNetwork(handle)
      dispatched.value = true
      return this.serviceCall(handle, login, 'POST', '/api/service/drain')
    }
    try {
      const health = await postDrain()
      if (!health.ok || !health.draining) {
        unconfirmed(health)
      } else {
        this.lifecycle('workspace.drain.requested', handle, counts(health))
        note(health)
        if (health.idle) return done(true)
      }
    } catch (error) {
      if (error instanceof WorkspaceNetworkError) throw error
      failed(error)
      log.error('workspace.drain.request.failed', { handle, error: errorMessage(error) })
    }
    while (now() < deadline) {
      await delay(this.drainPollMs)
      const renew = now() - requestedAt >= this.drainRenewMs
      try {
        if (renew) {
          const health = await postDrain()
          requestedAt = now()
          // A renewal that finally shows the drain confirms the admission the first POST missed.
          if (!health.ok || !health.draining) unconfirmed(health)
          else {
            if (!admitted) this.lifecycle('workspace.drain.requested', handle, counts(health))
            note(health)
            if (health.idle) {
              this.lifecycle('workspace.drain.idle', handle)
              return done(true)
            }
            waiting(health)
          }
        } else {
          const health = await this.serviceCall(handle, login, 'GET', '/api/service/health')
          note(health)
          // Idle behind an admitted drain finishes; idle without one waits for the renewal to admit.
          // A drain admitted and then lifted while idle is still safe to finish: nothing runs to cut.
          if (health.ok && health.idle && (health.draining || admitted)) {
            this.lifecycle('workspace.drain.idle', handle)
            return done(true)
          }
        }
      } catch (error) {
        if (error instanceof WorkspaceNetworkError) throw error
        failed(error)
        log.warn(renew ? 'workspace.drain.renew.failed' : 'workspace.drain.health.failed', { handle, error: errorMessage(error) })
      }
    }
    log.warn('workspace.drain.timeout', { handle, timeoutSeconds: config.drainTimeoutSeconds,
      activeChatTurns: lastCounts.counts?.activeChatTurns ?? null,
      runningCallerCalls: lastCounts.counts?.runningCallerCalls ?? null,
      backgroundWork: lastCounts.counts?.backgroundWork ?? null })
    return done(false)
  }

  private async startLocked(handle: string, login: string): Promise<void> {
    const { config, docker, store } = this.deps
    const { container } = workspaceNames(handle)
    store.noteWorkspace(handle, login)
    await this.ensureVolumeAndNetwork(handle)
    let details = await docker.inspectContainer(container)
    if (details?.State.Running) return
    const outdated = details && this.outdated(details, await this.currentImageId())
    if (outdated) {
      // A stopped container that is out of date has nothing to drain: recreate it before it starts.
      await this.activateRelease(handle, imageRelease(await docker.imageLabels(config.runtimeImage)))
      await docker.removeContainer(container)
      this.lifecycle('workspace.container.removed', handle, { reason: outdated })
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
    const { docker } = this.deps
    const { volume, network } = workspaceNames(handle)
    if (!(await docker.volumeExists(volume))) {
      await docker.createVolume(volume)
      this.lifecycle('workspace.volume.created', handle, { volume })
    }
    if (!(await docker.networkExists(network))) {
      await docker.createNetwork(network)
      this.lifecycle('workspace.network.created', handle, { network })
    }
    await this.joinNetwork(handle)
  }

  /**
   * Makes sure the gateway is on the workspace's network before a call to the workspace. Docker is asked the
   * first time and then only after a call that reached nothing, so a proxied request costs no Docker call.
   * A workspace that was never started has no network yet: its start creates the network and joins it.
   */
  private async ensureOnNetwork(handle: string): Promise<void> {
    if (this.joined.has(handle)) return
    const { network } = workspaceNames(handle)
    try {
      if (await this.deps.docker.networkExists(network)) await this.joinNetwork(handle)
    } catch (error) {
      throw new WorkspaceNetworkError(`the gateway could not join ${network}: ${errorMessage(error)}`)
    }
  }

  /**
   * Connects the gateway container to the workspace's network unless it is on it already. A recreated
   * gateway container, as every upgrade makes, is on none of the networks the one it replaced had joined.
   */
  private async joinNetwork(handle: string): Promise<void> {
    const { config, docker } = this.deps
    const { network } = workspaceNames(handle)
    const onNetwork = async (): Promise<boolean> => {
      const gateway = await docker.inspectContainer(config.gatewayContainer)
      if (!gateway) {
        throw new Error(`the gateway container ${config.gatewayContainer} (POISE_GATEWAY_CONTAINER) does not exist`)
      }
      return network in gateway.NetworkSettings.Networks
    }
    if (!(await onNetwork())) {
      try {
        await docker.connectNetwork(network, config.gatewayContainer)
        this.lifecycle('workspace.network.connected', handle, { network, container: config.gatewayContainer })
      } catch (error) {
        // A start and a call can join at the same moment; only a gateway still off the network failed.
        if (!(await onNetwork())) throw error
      }
    }
    this.joined.add(handle)
  }

  /** The POISE_DRAIN_TIMEOUT a workspace gets: it lets an unrenewed drain lapse by the gateway's own value. */
  private drainTimeoutEnv(): string {
    return `POISE_DRAIN_TIMEOUT=${this.deps.config.drainTimeoutSeconds}`
  }

  /** The resolvers a workspace was created with, as its poise.dns label records them. */
  private dnsLabel(): string {
    return this.deps.workspaceResolvConf ? this.deps.config.workspaceDns.join(',') : ''
  }

  /** What makes a workspace container differ from the one the gateway would create now, or null. */
  private outdated(details: ContainerDetails, imageId: string): string | null {
    if (details.Image !== imageId) return 'outdated image'
    return this.changedSetting(details)
  }

  /** A container setting that differs from what the gateway would create now; only a new container applies it. */
  private changedSetting(details: ContainerDetails): string | null {
    if (!(details.Config.Env ?? []).includes(this.drainTimeoutEnv())) return 'changed drain timeout'
    const resolver = details.Mounts?.find((mount) => mount.Destination === WORKSPACE_RESOLV_CONF)?.Source ?? null
    if (resolver !== (this.deps.workspaceResolvConf ?? null) || (details.Config.Labels?.['poise.dns'] ?? '') !== this.dnsLabel()) {
      return 'changed workspace DNS'
    }
    return null
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
    await this.ensureOnNetwork(handle)
    const { config, keys, now } = this.deps
    const publicHost = `${handle}.${config.domain}`
    let response: { status: number; text: string }
    try {
      response = await this.serviceRequest(this.deps.upstream(handle), method, path, {
        host: publicHost,
        'x-forwarded-host': publicHost,
        'x-forwarded-proto': config.insecureHttp ? 'http' : 'https',
        'x-poise-identity': signAssertion(keys.privateKey, { handle, login, scope: 'admin' }, now()),
        accept: 'application/json',
        ...(method === 'POST' ? { 'content-length': 0 } : {}),
      })
    } catch (error) {
      // Reaching nothing is also what a lost network looks like: check it again before the next call.
      this.joined.delete(handle)
      throw error
    }
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
