// The service endpoints the container health check and the gateway call
// (docs/Service-architecture.md, "Service endpoints"). A drain is the drain a
// release uses: the Chat runtime refuses new work and stops dispatching its
// queues, and process-owned background work (behavior ticks, the daily model
// check) stops being admitted. Nothing already running is cancelled. A drain
// lapses unless the gateway renews it, so a gateway that died mid-drain can
// never leave the workspace refusing work for good.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BUILD_SHA } from '../build-identity'
import type { ChatRuntime } from '../chat/runtime'
import { listOpenTurns } from '../chat/storage'
import { HttpError, readJson, type RequestAuthority } from '../http'
import { pauseReleaseBackground, releaseBackgroundBusy, resumeReleaseBackground } from '../release-background'
import { runningCallerCalls } from './caller-calls'
import { canRestartForUpdate, requestUpdateRestart } from './restart'

export interface ServiceHealth {
  ok: true
  mode: 'service'
  /** The source commit this bundle was built from; null for a development build. */
  version: string | null
  activeChatTurns: number
  runningCallerCalls: number
  backgroundWork: number
  /** True only when nothing a restart would cut is running. */
  idle: boolean
  draining: boolean
  /** The installed release the supervisor started this server on (POISE_RELEASE); null without one. */
  release: string | null
}

/** What POST /api/service/switch answers. */
export interface SwitchAnswer {
  release: string
  /** False when this server already runs that release. */
  switching: boolean
}

// A release is named by the commit it was built from, or a development build's id.
const RELEASE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const SWITCH_POLL_MS = 500

/** How every refusal of new work reads while a drain is on, as it already
 *  does for a release. */
export const DRAINING_ERROR = 'Poise is installing an update; try again after it restarts'

/** A drain lapses this long after the gateway's own drain timeout. */
export const DRAIN_GRACE_SECONDS = 300

// Browser routes that start a Caller call or the model check.
const LAUNCH_ROUTES = new Set(['/api/pr-review', '/api/agent-replay', '/api/chat-content', '/api/debate', '/api/chat', '/api/models/refresh'])

export interface DrainTimer {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(timer: unknown): void
}

const systemTimer: DrainTimer = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs).unref(),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

export interface ServiceControlOptions {
  /** The gateway's POISE_DRAIN_TIMEOUT, in seconds. */
  drainTimeoutSeconds: number
  timer?: DrainTimer
  log?: (line: string) => void
  /** Where the gateway installs releases; ~/.poise/releases by default. */
  releasesDir?: string
  /** The running release and its base, as the supervisor names them; the environment by default. */
  release?: { name: string | null, base: string | null }
  /** Restarts this server onto the release named in releasesDir/next; false when it cannot. */
  restart?: () => boolean
  canRestart?: () => boolean
}

export class ServiceControl {
  private drainOn = false
  private launches = 0
  private lapse: unknown = null
  private switchTo: string | null = null
  private switchPoll: unknown = null
  private readonly timer: DrainTimer
  private readonly log: (line: string) => void
  private readonly releasesDir: string
  private readonly release: { name: string | null, base: string | null }

  constructor(private readonly runtime: ChatRuntime, private readonly options: ServiceControlOptions) {
    this.timer = options.timer ?? systemTimer
    this.log = options.log ?? ((line) => console.log(line))
    this.releasesDir = options.releasesDir ?? join(homedir(), '.poise', 'releases')
    this.release = options.release ?? { name: process.env.POISE_RELEASE || null, base: process.env.POISE_BASE || null }
  }

  get draining(): boolean {
    return this.drainOn
  }

  /** `activeChatTurns` are the Chat turns recorded open: reserved before
   *  their first write, closed once their outcome is recorded.
   *  `backgroundWork` is everything else a restart would cut: the Chat
   *  runtime's startups, operations and agent processes, process-owned
   *  background work (behavior ticks, CLI updates, the model check), and
   *  browser launches admitted and still in their handler. */
  health(): ServiceHealth {
    const activeChatTurns = listOpenTurns(this.runtime.instance).length
    const calls = runningCallerCalls()
    const backgroundWork = this.runtime.busy() + releaseBackgroundBusy() + this.launches
    return {
      ok: true,
      mode: 'service',
      version: BUILD_SHA,
      activeChatTurns,
      runningCallerCalls: calls.count,
      backgroundWork,
      // Never idle while Caller's records cannot be read: calls an earlier server started may still run.
      idle: calls.known && activeChatTurns + calls.count + backgroundWork === 0,
      draining: this.drainOn,
      release: this.release.name,
    }
  }

  /**
   * Restarts this server onto an installed release of the same base, at the
   * first moment no Chat turn and no work of this server's own runs. Agent
   * calls are not waited for: they run detached, survive the restart, and the
   * next server reconciles them as after any restart. Nothing is refused
   * while it waits, behavior ticks included: they end within a minute, and
   * the moment between two of them is quiet.
   */
  switchRelease(release: unknown): SwitchAnswer {
    if (typeof release !== 'string' || !RELEASE_NAME.test(release)) throw new HttpError(400, 'release must name an installed release')
    if (!(this.options.canRestart ?? canRestartForUpdate)() || !this.release.base) {
      throw new HttpError(409, 'this workspace was not started by the release supervisor; recreate its container to update it')
    }
    const dir = join(this.releasesDir, release)
    let base: string
    try {
      if (!existsSync(join(dir, 'installed'))) throw new Error('not installed')
      base = readFileSync(join(dir, 'base'), 'utf8').trim()
    } catch {
      throw new HttpError(409, `release ${release} is not installed`)
    }
    if (base !== this.release.base) throw new HttpError(409, `release ${release} was built for another base; recreate the container to update it`)
    // The supervisor marks a release that failed to start, and never runs it again.
    if (existsSync(join(dir, 'failed'))) throw new HttpError(409, `release ${release} failed to start in this workspace; it stays on release ${this.release.name}`)
    if (release === this.release.name) return { release, switching: false }
    const next = join(this.releasesDir, 'next')
    writeFileSync(`${next}.tmp`, `${release}\n`)
    renameSync(`${next}.tmp`, next)
    const first = this.switchTo === null
    this.switchTo = release
    if (first) {
      this.log(`[service] switching to release ${release} once no Chat turn and no work of this server runs`)
      this.pollSwitch()
    }
    return { release, switching: true }
  }

  private pollSwitch(): void {
    this.switchPoll = this.timer.setTimeout(() => {
      this.switchPoll = null
      const quiet = listOpenTurns(this.runtime.instance).length === 0 && this.runtime.working() === 0
        && releaseBackgroundBusy() === 0 && this.launches === 0
      if (!quiet) return this.pollSwitch()
      // Refused from here on; the gateway shows the person that Poise is updating.
      pauseReleaseBackground()
      this.runtime.startDrain('service')
      this.drainOn = true
      this.log(`[service] restarting on release ${this.switchTo}; running agent calls carry on`)
      if (!(this.options.restart ?? requestUpdateRestart)()) {
        this.log('[service] the restart was refused; staying on this release')
        this.lift()
        this.switchTo = null
      }
    }, SWITCH_POLL_MS)
  }

  /** Every call starts the lapse again: the gateway renews a drain by
   *  calling drain again while it waits. */
  drain(): ServiceHealth {
    pauseReleaseBackground()
    // The release drain's gate; its id only names who asked.
    this.runtime.startDrain('service')
    this.drainOn = true
    this.renewLapse()
    return this.health()
  }

  resume(): ServiceHealth {
    this.lift()
    return this.health()
  }

  /** The gate for a browser launch: null when the request is not one,
   *  'draining' when it is refused, otherwise the release to call once its
   *  handler has finished. Checking and counting happen in one step, so no
   *  drain can fall between them. */
  admitLaunch(method: string | undefined, path: string): (() => void) | 'draining' | null {
    if (method !== 'POST' || !LAUNCH_ROUTES.has(path)) return null
    if (this.drainOn) return 'draining'
    this.launches += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.launches -= 1
    }
  }

  /** On runtime stop: a paused background must not outlive this server. */
  reset(): void {
    if (this.switchPoll !== null) this.timer.clearTimeout(this.switchPoll)
    this.switchPoll = null
    if (this.drainOn || this.switchTo !== null) this.lift()
    this.switchTo = null
  }

  private renewLapse(): void {
    if (this.lapse !== null) this.timer.clearTimeout(this.lapse)
    const seconds = this.options.drainTimeoutSeconds + DRAIN_GRACE_SECONDS
    this.lapse = this.timer.setTimeout(() => {
      this.lapse = null
      this.log(`[service] the drain lapsed: no drain call renewed it within ${seconds} s, so new work is admitted again`)
      this.lift()
    }, seconds * 1000)
  }

  private lift(): void {
    if (this.lapse !== null) this.timer.clearTimeout(this.lapse)
    this.lapse = null
    this.runtime.endDrain()
    resumeReleaseBackground()
    this.drainOn = false
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

/** /api/service/*: from loopback (the container's own health check) or with
 *  the gateway's admin scope. The owner's browser may only resume, to lift a
 *  drain the gateway left behind. */
export function handleServiceApi(req: IncomingMessage, res: ServerResponse, path: string, authority: RequestAuthority, control: ServiceControl): void | Promise<void> {
  if (path === '/api/service/switch') {
    if (authority.kind === 'gateway' && authority.scope !== 'admin') {
      throw new HttpError(403, 'only the gateway switches releases')
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      return json(res, 405, { error: `use POST for ${path}` })
    }
    return readJson<{ release?: unknown }>(req).then((body) => json(res, 202, control.switchRelease(body.release)))
  }
  const routes: Record<string, { method: string, owner: boolean, run: () => ServiceHealth }> = {
    '/api/service/health': { method: 'GET', owner: false, run: () => control.health() },
    '/api/service/drain': { method: 'POST', owner: false, run: () => control.drain() },
    '/api/service/resume': { method: 'POST', owner: true, run: () => control.resume() },
  }
  const route = routes[path]
  if (authority.kind === 'gateway' && authority.scope !== 'admin' && !(authority.scope === 'browser' && route?.owner)) {
    throw new HttpError(403, 'service endpoints answer loopback and the gateway\'s admin scope; the owner\'s browser may only resume')
  }
  if (!route) return json(res, 404, { error: 'service route not found' })
  if (req.method !== route.method) {
    res.setHeader('Allow', route.method)
    return json(res, 405, { error: `use ${route.method} for ${path}` })
  }
  json(res, 200, route.run())
}
