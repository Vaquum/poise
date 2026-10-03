// The service endpoints the container health check and the gateway call
// (docs/Service-architecture.md, "Service endpoints"). A drain is the drain a
// release uses: the Chat runtime refuses new work and stops dispatching its
// queues, and process-owned background work (behavior ticks, the daily model
// check) stops being admitted. Nothing already running is cancelled.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { BUILD_SHA } from '../build-identity'
import type { ChatRuntime } from '../chat/runtime'
import { listOpenTurns } from '../chat/storage'
import { HttpError, type RequestAuthority } from '../http'
import { pauseReleaseBackground, releaseBackgroundBusy, resumeReleaseBackground } from '../release-background'
import { runningCallerCalls } from './caller-calls'

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
}

/** How every refusal of new work reads while a drain is on, as it already
 *  does for a release. */
export const DRAINING_ERROR = 'Poise is installing an update; try again after it restarts'

// Browser routes that start a Caller call or the model check.
const LAUNCH_ROUTES = new Set(['/api/pr-review', '/api/agent-replay', '/api/chat-content', '/api/debate', '/api/chat', '/api/models/refresh'])

export class ServiceControl {
  private drainOn = false
  private launches = 0

  constructor(private readonly runtime: ChatRuntime) {}

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
      runningCallerCalls: calls,
      backgroundWork,
      idle: activeChatTurns + calls + backgroundWork === 0,
      draining: this.drainOn,
    }
  }

  drain(): ServiceHealth {
    pauseReleaseBackground()
    // The release drain's gate; its id only names who asked.
    this.runtime.startDrain('service')
    this.drainOn = true
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
    if (this.drainOn) this.lift()
  }

  private lift(): void {
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
 *  the gateway's admin scope; a browser or Poise Link assertion is refused. */
export function handleServiceApi(req: IncomingMessage, res: ServerResponse, path: string, authority: RequestAuthority, control: ServiceControl): void {
  if (authority.kind === 'gateway' && authority.scope !== 'admin') {
    throw new HttpError(403, 'service endpoints answer loopback and the gateway\'s admin scope only')
  }
  const routes: Record<string, { method: string, run: () => ServiceHealth }> = {
    '/api/service/health': { method: 'GET', run: () => control.health() },
    '/api/service/drain': { method: 'POST', run: () => control.drain() },
    '/api/service/resume': { method: 'POST', run: () => control.resume() },
  }
  const route = routes[path]
  if (!route) return json(res, 404, { error: 'service route not found' })
  if (req.method !== route.method) {
    res.setHeader('Allow', route.method)
    return json(res, 405, { error: `use ${route.method} for ${path}` })
  }
  json(res, 200, route.run())
}
