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
import { pauseReleaseBackground, resumeReleaseBackground } from '../release-background'
import { runningCallerCalls } from './caller-calls'

export interface ServiceHealth {
  ok: true
  mode: 'service'
  /** The source commit this bundle was built from; null for a development build. */
  version: string | null
  activeChatTurns: number
  runningCallerCalls: number
  draining: boolean
}

/** How every refusal of new work reads while a drain is on, as it already
 *  does for a release. */
export const DRAINING_ERROR = 'Poise is installing an update; try again after it restarts'

// Browser routes that start a Caller call.
const LAUNCH_ROUTES = new Set(['/api/pr-review', '/api/agent-replay', '/api/chat-content', '/api/debate', '/api/chat'])

export class ServiceControl {
  private drainOn = false

  constructor(private readonly runtime: ChatRuntime) {}

  get draining(): boolean {
    return this.drainOn
  }

  /** `activeChatTurns` are the Chat turns recorded open: reserved before
   *  their first write, closed once their outcome is recorded. */
  health(): ServiceHealth {
    return {
      ok: true,
      mode: 'service',
      version: BUILD_SHA,
      activeChatTurns: listOpenTurns(this.runtime.instance).length,
      runningCallerCalls: runningCallerCalls(),
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

  /** A launch from the browser that a drain refuses. */
  refusesLaunch(method: string | undefined, path: string): boolean {
    return this.drainOn && method === 'POST' && LAUNCH_ROUTES.has(path)
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
 *  the gateway's admin scope; a browser assertion does not reach them. */
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
