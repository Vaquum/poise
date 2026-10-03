import http, { type IncomingMessage } from 'node:http'
import { signAssertion, type Scope } from './assertion.js'
import type { Config } from './config.js'
import { cookieValues, serializeCookie } from './cookies.js'
import type { DockerClient } from './docker.js'
import type { GitHubClient } from './github.js'
import { header, HttpError, safeEqual } from './http.js'
import type { GatewayKeys } from './keys.js'
import type { Logger } from './log.js'
import type { Orchestrator, UpstreamResolver } from './orchestrator.js'
import type { Session, Store, User } from './store.js'

export const APEX_COOKIE = 'poise_gw'
export const WORKSPACE_COOKIE = 'poise_ws'
export const OAUTH_COOKIE = 'poise_oauth'
export const APEX_SESSION_TTL_MS = 14 * 24 * 60 * 60_000
export const TICKET_TTL_MS = 60_000
export const OAUTH_STATE_TTL_MS = 10 * 60_000

export interface GatewayDeps {
  config: Config
  store: Store
  keys: GatewayKeys
  github: GitHubClient
  docker: DockerClient
  orchestrator: Orchestrator
  log: Logger
  now: () => number
  upstream: UpstreamResolver
}

export interface Principal {
  session: Session
  user: User
  isAdmin: boolean
}

/** What every route needs: dependencies, the public origins and the session rules. */
export class Context {
  readonly scheme: 'http' | 'https'
  readonly apexOrigin: string
  readonly pageHeaders: Record<string, string>
  readonly agent = new http.Agent({ keepAlive: true })

  constructor(readonly deps: GatewayDeps) {
    this.scheme = deps.config.insecureHttp ? 'http' : 'https'
    this.apexOrigin = `${this.scheme}://${deps.config.domain}`
    this.pageHeaders = {
      // Workspace-host forms (sign-out) redirect to the apex, so the apex is an allowed form target everywhere.
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${this.apexOrigin}; frame-ancestors 'none'; base-uri 'none'`,
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    }
  }

  workspaceOrigin(handle: string): string {
    return `${this.scheme}://${handle}.${this.deps.config.domain}`
  }

  isAdmin(handle: string): boolean {
    return this.deps.config.admins.includes(handle)
  }

  /** Checked on every request, so a login removed from the allow list loses access at once. */
  isAllowed(user: User): boolean {
    const { config, store } = this.deps
    return config.admins.includes(user.handle)
      || store.isOnAllowList(user.handle)
      || (user.accessOrg !== null && config.allowedOrgs.includes(user.accessOrg))
  }

  apexPrincipal(req: IncomingMessage): Principal | null {
    for (const id of cookieValues(req.headers.cookie, APEX_COOKIE)) {
      const session = this.deps.store.findSession(id)
      if (session?.kind !== 'apex') continue
      const user = this.deps.store.getUser(session.handle)
      if (!user || !this.isAllowed(user)) continue
      return { session, user, isAdmin: this.isAdmin(user.handle) }
    }
    return null
  }

  /** Every live workspace session among the poise_ws cookies, whichever host it was minted for. */
  workspaceSessions(req: IncomingMessage): Session[] {
    return cookieValues(req.headers.cookie, WORKSPACE_COOKIE)
      .map((id) => this.deps.store.findSession(id))
      .filter((session): session is Session => session?.kind === 'workspace')
  }

  cookie(name: string, value: string, maxAgeSeconds: number, path = '/'): string {
    return serializeCookie(name, value, { maxAgeSeconds, secure: !this.deps.config.insecureHttp, path })
  }

  /** Every state-changing form carries the session's CSRF token and comes from the expected origin. */
  verifyForm(req: IncomingMessage, form: URLSearchParams, session: Session, origin: string): void {
    if (header(req, 'origin') !== origin) throw new HttpError(403, 'This form was not sent from this site.')
    if (!safeEqual(form.get('csrf') ?? '', session.csrf)) {
      throw new HttpError(403, 'This form has expired. Reload the page and try again.')
    }
  }

  assertion(user: User, scope: Scope): string {
    return signAssertion(this.deps.keys.privateKey, { handle: user.handle, login: user.login, scope }, this.deps.now())
  }
}
