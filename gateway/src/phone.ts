import type { IncomingMessage, ServerResponse } from 'node:http'
import { APEX_COOKIE, APEX_SESSION_TTL_MS, TICKET_TTL_MS, type Context, type Principal } from './context.js'
import { cookieValues } from './cookies.js'
import { header, HttpError, redirect, safeEqual, sendHtml } from './http.js'
import { messagePage, phoneSignedInPage, phoneWaitingPage } from './pages.js'
import { hashSecret, newSecret, type Phone, type PhoneCode, type PhoneCodeState, type Session, type User } from './store.js'

// Signing in on a phone with a QR code that Settings shows (docs/Service-architecture.md, "Sign in on a
// phone"). The code is a one-time token. The first device to open it gets a secret of its own, which binds
// the code to that device; the owner then sees the device in Settings and approves or denies it there, and
// only the approved device gets a session, its own, never a copy of the owner's.

/** Where the QR code leads, on the apex. A login proxy in front must let it through without its own login. */
export const PHONE_PATH = '/auth/phone'
/** The bound device's secret. Its SHA-256 is the grant the owner's approval carries for a login proxy in front. */
export const PHONE_COOKIE = 'poise_phone'
export const PHONE_CODE_TTL_MS = 2 * 60_000
export const PHONE_DECISION_TTL_MS = 2 * 60_000
// No longer than a login proxy in front keeps the approval it recorded: Vaquum's Portal keeps it 2 minutes.
export const PHONE_FINISH_TTL_MS = 2 * 60_000
const PHONE_COOKIE_SECONDS = 10 * 60
const CODES_PER_WINDOW = 30
const CODE_WINDOW_MS = 15 * 60_000
const MISSES_PER_WINDOW = 20
const MISS_WINDOW_MS = 10 * 60_000
// Settings shows how the codes of the last quarter hour ended.
const RECENT_CODES_MS = 15 * 60_000
const TOKEN = /^[A-Za-z0-9_-]{22}$/
const BINDING = /^[A-Za-z0-9_-]{43}$/
const GRANT = /^[0-9a-f]{64}$/
const USER_AGENT_LIMIT = 512

/** What a person recognises their phone by: its kind and its browser, from the User-Agent. */
export function describeDevice(userAgent: string): string {
  const ua = userAgent.slice(0, USER_AGENT_LIMIT)
  const device = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
      : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet')
        : /CrOS/.test(ua) ? 'Chromebook'
          : /Windows/.test(ua) ? 'Windows'
            : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
              : /Linux/.test(ua) ? 'Linux'
                : 'Unknown device'
  const browser = /EdgiOS|EdgA\/|Edg\//.test(ua) ? 'Edge'
    : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
      : /OPiOS|OPR\//.test(ua) ? 'Opera'
        : /FxiOS|Firefox\//.test(ua) ? 'Firefox'
          : /CriOS|Chrome\//.test(ua) ? 'Chrome'
            : /Safari\//.test(ua) ? 'Safari'
              : 'unknown browser'
  return `${device} · ${browser}`
}

export interface PhoneCodeView {
  id: string
  state: PhoneCodeState | 'expired'
  device: string | null
  /** The bound device's grant: the approval sends it as `?grant=`, for a login proxy in front. */
  grant: string | null
  createdAt: number
  expiresAt: number
  scannedAt: number | null
  decidedAt: number | null
  finishedAt: number | null
}

export interface PhoneView {
  id: string
  device: string
  /** Signing the phone out sends it as `?grant=`, for a login proxy in front. */
  grant: string
  createdAt: number
}

function codeView(code: PhoneCode, now: number): PhoneCodeView {
  const open = code.state === 'waiting' || code.state === 'scanned' || code.state === 'approved'
  return {
    id: code.id,
    state: open && code.expiresAt <= now ? 'expired' : code.state,
    device: code.device,
    grant: code.bindHash,
    createdAt: code.createdAt,
    expiresAt: code.expiresAt,
    scannedAt: code.scannedAt,
    decidedAt: code.decidedAt,
    finishedAt: code.finishedAt,
  }
}

function phoneView({ id, device, grant, createdAt }: Phone): PhoneView {
  return { id, device, grant, createdAt }
}

/** The owner's codes of the last quarter hour and their signed-in phones. */
export function phoneOverview(ctx: Context, principal: Principal): { codes: PhoneCodeView[]; phones: PhoneView[] } {
  const now = ctx.deps.now()
  const { handle } = principal.user
  return {
    codes: ctx.deps.store.phoneCodes(handle, now - RECENT_CODES_MS).map((code) => codeView(code, now)),
    phones: ctx.deps.store.listPhones(handle).map(phoneView),
  }
}

export type StartOutcome =
  | { ok: true; code: PhoneCodeView; url: string }
  | { ok: false; message: string; retryAfterSeconds: number }

/** A new code for the owner's QR. A sign-in, across its hosts, may mint only so many in a window. */
export function startPhoneCode(ctx: Context, principal: Principal): StartOutcome {
  const { log, store } = ctx.deps
  const now = ctx.deps.now()
  const apexSessionHash = principal.session.parentHash ?? principal.session.idHash
  const recent = store.phoneCodeTimes(apexSessionHash, now - CODE_WINDOW_MS)
  if (recent.length >= CODES_PER_WINDOW) {
    const wait = Math.ceil((recent[0] + CODE_WINDOW_MS - now) / 1000)
    const minutes = Math.ceil(wait / 60)
    log.warn('phone.code.rate_limited', { login: principal.user.login })
    return { ok: false, message: `Too many codes were shown. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, retryAfterSeconds: wait }
  }
  const { token, code } = store.createPhoneCode(principal.user.handle, apexSessionHash, PHONE_CODE_TTL_MS)
  log.info('phone.code.created', { login: principal.user.login })
  return { ok: true, code: codeView(code, now), url: `${ctx.apexOrigin}${PHONE_PATH}?t=${token}` }
}

/** The single, well-formed `grant` of an approval or a sign-out, or null. */
export function grantOf(url: URL): string | null {
  const grants = url.searchParams.getAll('grant')
  return grants.length === 1 && GRANT.test(grants[0]) ? grants[0] : null
}

/** Approves or denies the device bound to one of the owner's codes. Approving needs that device's grant. */
export function decidePhone(ctx: Context, principal: Principal, id: string, decision: 'approve' | 'deny', grant: string | null): PhoneCodeView {
  const { log, store } = ctx.deps
  const { handle, login } = principal.user
  const code = store.phoneCode(handle, id)
  if (!code) throw new HttpError(404, 'There is no such sign-in.')
  if (decision === 'approve' && (grant === null || code.bindHash === null || !safeEqual(grant, code.bindHash))) {
    throw new HttpError(400, 'This approval does not name the phone that is waiting.')
  }
  const decided = store.decidePhoneCode(handle, id, decision === 'approve', PHONE_FINISH_TTL_MS)
  if (!decided) throw new HttpError(409, 'That phone is no longer waiting for approval. Show a new code to start again.')
  log.info(decision === 'approve' ? 'phone.approved' : 'phone.denied', { login, device: decided.device })
  return codeView(decided, ctx.deps.now())
}

/**
 * Signs one of the owner's phones out at once: its session ends, and with it its workspace sessions, and
 * whatever it still holds open through the gateway, such as Chat's WebSocket, is cut.
 */
export function signOutPhone(ctx: Context, principal: Principal, id: string, grant: string | null): PhoneView[] {
  const { log, store } = ctx.deps
  const { handle, login } = principal.user
  const phone = store.listPhones(handle).find((candidate) => candidate.id === id)
  if (!phone) throw new HttpError(404, 'There is no such phone.')
  if (grant === null || !safeEqual(grant, phone.grant)) throw new HttpError(400, 'This sign-out does not name that phone.')
  const ended = store.signOutPhone(handle, id)
  const cut = ended ? ctx.endSessionTraffic(ended.sessionHash) : 0
  log.info('phone.signed_out', { login, device: phone.device, cut })
  return store.listPhones(handle).map(phoneView)
}

/** The first X-Forwarded-For entry, which the deployment's proxy sets to the client; else the socket's peer. */
function clientKey(req: IncomingMessage): string {
  return header(req, 'x-forwarded-for').split(',')[0].trim() || req.socket.remoteAddress || 'unknown'
}

/** A client's recent opens of codes that do not exist, oldest first; older ones are forgotten. */
function recentMisses(ctx: Context, client: string): number[] {
  const now = ctx.deps.now()
  for (const [entry, times] of ctx.phoneMisses) {
    if (times.every((time) => now - time >= MISS_WINDOW_MS)) ctx.phoneMisses.delete(entry)
  }
  return (ctx.phoneMisses.get(client) ?? []).filter((time) => now - time < MISS_WINDOW_MS)
}

/** Seconds the client must wait before opening another code, after too many that did not exist. */
function missWait(ctx: Context, client: string): number {
  const recent = recentMisses(ctx, client)
  return recent.length >= MISSES_PER_WINDOW ? Math.ceil((recent[0] + MISS_WINDOW_MS - ctx.deps.now()) / 1000) : 0
}

function recordMiss(ctx: Context, client: string): void {
  ctx.phoneMisses.set(client, [...recentMisses(ctx, client), ctx.deps.now()])
}

function heldBinding(req: IncomingMessage): string | null {
  return cookieValues(req.headers.cookie, PHONE_COOKIE).find((value) => BINDING.test(value)) ?? null
}

function page(ctx: Context, res: ServerResponse, status: number, html: string, cookies: string[] = []): void {
  sendHtml(res, status, html, { ...ctx.pageHeaders, ...(cookies.length > 0 ? { 'set-cookie': cookies } : {}) })
}

/** A device already signed in to this Poise goes on to its own workspace. */
function toWorkspace(ctx: Context, res: ServerResponse, principal: Principal): void {
  redirect(res, `/auth/login?next=${encodeURIComponent(`${ctx.workspaceOrigin(principal.user.handle)}/`)}`)
}

const EXPIRED = (): string => messagePage(
  'This code has expired',
  'Show a new code in Poise on your computer, in Settings → Accounts → Sign in on your phone, and scan it again.',
)

/** GET /auth/phone: the page a phone opens from the QR code, and then keeps reloading until it is decided. */
export function phonePage(ctx: Context, req: IncomingMessage, res: ServerResponse, url: URL): void {
  const token = url.searchParams.get('t')
  if (token !== null) {
    scan(ctx, req, res, token)
    return
  }
  const binding = heldBinding(req)
  // Signed in already, yet the phone asks again: it dropped the request whose answer carried its sign-in
  // and retried. Within the window it gets the same sign-in again, even if its code is gone meanwhile,
  // as it is when the computer that showed it signs out.
  const held = binding ? ctx.phoneSignIns.get(hashSecret(binding)) : undefined
  if (binding && held && held.until > ctx.deps.now()) return finishAgain(ctx, res, binding, held)
  const code = binding ? ctx.deps.store.phoneCodeByBinding(binding) : null
  if (!binding || !code) {
    const principal = ctx.apexPrincipal(req)
    if (principal) return toWorkspace(ctx, res, principal)
    return page(ctx, res, 200, messagePage(
      'Sign in on your phone',
      'Open this page by scanning the code that Poise shows on a computer where you are signed in: Settings → Accounts → Sign in on your phone.',
    ))
  }
  const clear = ctx.cookie(PHONE_COOKIE, '', 0, PHONE_PATH)
  const owner = ctx.deps.store.getUser(code.handle)
  if (!owner || !ctx.isAllowed(owner)) {
    return page(ctx, res, 403, messagePage('Not allowed', 'This account may no longer sign in to this Poise.'), [clear])
  }
  const now = ctx.deps.now()
  if (code.state === 'approved' && code.expiresAt > now) return finish(ctx, res, owner, binding, code.expiresAt, clear)
  if (code.state === 'scanned' && code.expiresAt > now) {
    return page(ctx, res, 200, phoneWaitingPage({ device: code.device ?? 'This phone' }))
  }
  if (code.state === 'denied') {
    return page(ctx, res, 403, messagePage('Not approved', 'The sign-in was denied on your computer. Show a new code there to try again.'), [clear])
  }
  return page(ctx, res, 410, EXPIRED(), [clear])
}

function scan(ctx: Context, req: IncomingMessage, res: ServerResponse, token: string): void {
  const { log, store } = ctx.deps
  // A device already signed in here goes through the code all the same: a login proxy in front may have
  // ended its sign-in there, and a new code is how the phone gets both back.
  const client = clientKey(req)
  const tooMany = (wait: number) => {
    const minutes = Math.ceil(wait / 60)
    sendHtml(res, 429, messagePage('Too many codes', `Too many codes that lead nowhere were opened here. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`), {
      ...ctx.pageHeaders, 'retry-after': String(wait),
    })
  }
  const wait = missWait(ctx, client)
  if (wait > 0) return tooMany(wait)
  const existing = TOKEN.test(token) ? store.phoneCodeByToken(token) : null
  const held = heldBinding(req)
  // This device opened its own code again, from its history or a second scan.
  if (existing && held && existing.bindHash !== null && safeEqual(existing.bindHash, hashSecret(held))) {
    return redirect(res, PHONE_PATH, 303)
  }
  if (!existing) {
    log.warn('phone.code.refused', { reason: 'unknown' })
    recordMiss(ctx, client)
    return page(ctx, res, 410, EXPIRED())
  }
  const owner = store.getUser(existing.handle)
  if (!owner || !ctx.isAllowed(owner)) {
    log.warn('phone.code.refused', { reason: 'access removed' })
    return page(ctx, res, 403, messagePage('Not allowed', 'This account may no longer sign in to this Poise.'))
  }
  const binding = newSecret()
  const device = describeDevice(header(req, 'user-agent'))
  const result = store.scanPhoneCode(token, binding, device, PHONE_DECISION_TTL_MS)
  if (!result.ok) {
    log.warn('phone.code.refused', { reason: result.reason })
    if (result.reason === 'used') {
      return page(ctx, res, 409, messagePage(
        'This code was already used',
        'Another device opened it first. Show a new code on your computer and scan it again.',
      ))
    }
    return page(ctx, res, 410, EXPIRED())
  }
  log.info('phone.code.scanned', { login: owner.login, device })
  redirect(res, PHONE_PATH, 303, { 'set-cookie': ctx.cookie(PHONE_COOKIE, binding, PHONE_COOKIE_SECONDS, PHONE_PATH) })
}

/**
 * The approved device's own sign-in: a new apex session and binding, then its workspace session through
 * the usual single-use ticket, which only this browser can redeem.
 */
function finish(ctx: Context, res: ServerResponse, owner: User, binding: string, until: number, clear: string): void {
  const done = ctx.deps.store.finishPhoneCode(binding, APEX_SESSION_TTL_MS)
  if (!done) return page(ctx, res, 410, EXPIRED(), [clear])
  const now = ctx.deps.now()
  for (const [key, held] of ctx.phoneSignIns) if (held.until <= now) ctx.phoneSignIns.delete(key)
  ctx.phoneSignIns.set(hashSecret(binding), { id: done.id, idHash: done.session.idHash, handle: owner.handle, until })
  ctx.deps.log.info('phone.signed_in', { login: owner.login, device: done.phone.device })
  signedIn(ctx, res, owner, done.id, done.session, clear)
}

/** The same sign-in again for a phone that retried within its finish window, while that sign-in lives. */
function finishAgain(ctx: Context, res: ServerResponse, binding: string, held: { id: string; idHash: string; handle: string }): void {
  const clear = ctx.cookie(PHONE_COOKIE, '', 0, PHONE_PATH)
  const owner = ctx.deps.store.getUser(held.handle)
  const session = ctx.deps.store.sessionByHash(held.idHash)
  if (!owner || !ctx.isAllowed(owner) || !session) {
    ctx.phoneSignIns.delete(hashSecret(binding))
    return page(ctx, res, 410, EXPIRED(), [clear])
  }
  ctx.deps.log.info('phone.signed_in.again', { login: owner.login })
  signedIn(ctx, res, owner, held.id, session, clear)
}

/** The phone's sign-in page, setting its apex session and a fresh binding, on to its workspace by a ticket. */
function signedIn(ctx: Context, res: ServerResponse, owner: User, id: string, session: Session, clear: string): void {
  const bind = newSecret()
  const ticket = ctx.deps.store.createTicket(session, owner.handle, bind, TICKET_TTL_MS)
  const target = new URL('/_poise/session', ctx.workspaceOrigin(owner.handle))
  target.searchParams.set('ticket', ticket)
  target.searchParams.set('next', '/')
  page(ctx, res, 200, phoneSignedInPage({ login: owner.login, href: target.href }), [
    ctx.cookie(APEX_COOKIE, id, APEX_SESSION_TTL_MS / 1000),
    ctx.bindCookie(bind),
    clear,
  ])
}
